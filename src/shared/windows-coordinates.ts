import type { ObservationMonitor, ObservationRect, WindowsObservation } from './windows-observation'

export interface DesktopCoordinateContext {
  dpi_awareness: 'per_monitor_v2'
  virtual_bounds: ObservationRect
  /** GetDpiForWindow evidence, never a multiplier for physical screenshot pixels. */
  window_dpi: number | null
}
export interface ImagePointResolution {
  image: { x: number; y: number }
  desktop: { x: number; y: number }
  monitor_id: string
  virtual_bounds: ObservationRect
  absolute: { x: number; y: number; coordinate_space: 'win32_absolute_virtual_desktop'; require_virtual_desktop: true }
  coordinate_space: 'desktop_physical_pixels'
  pixel_mapping: 'nearest_floor'
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi
const rect = (v: unknown, maximum = 32768): v is ObservationRect => object(v) && fields(v, ['x', 'y', 'width', 'height']) &&
  integer(v.x, -1_000_000, 1_000_000) && integer(v.y, -1_000_000, 1_000_000) && integer(v.width, 1, maximum) && integer(v.height, 1, maximum)
const sameRect = (a: ObservationRect, b: ObservationRect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
const inside = (r: ObservationRect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height

export function virtualDesktopBounds(monitors: readonly ObservationMonitor[]): ObservationRect | null {
  if (!monitors.length || monitors.length > 16 || monitors.some(m => !rect(m.bounds))) return null
  const x = Math.min(...monitors.map(m => m.bounds.x)), y = Math.min(...monitors.map(m => m.bounds.y))
  return { x, y, width: Math.max(...monitors.map(m => m.bounds.x + m.bounds.width)) - x,
    height: Math.max(...monitors.map(m => m.bounds.y + m.bounds.height)) - y }
}
export function validCoordinateContext(value: unknown, monitors: readonly ObservationMonitor[], window: boolean): value is DesktopCoordinateContext {
  const bounds = virtualDesktopBounds(monitors)
  return !!bounds && object(value) && fields(value, ['dpi_awareness', 'virtual_bounds', 'window_dpi']) && value.dpi_awareness === 'per_monitor_v2' &&
    rect(value.virtual_bounds, 2_032_768) && sameRect(value.virtual_bounds, bounds) &&
    (window ? integer(value.window_dpi, 48, 960) : value.window_dpi === null)
}
/** Pick the center of a pixel's 16-bit interval; reject unrepresentable positions, never clamp to another pixel. */
function absolutePixel(offset: number, size: number): number | null {
  const value = Math.floor((2 * offset + 1) * 65536 / (2 * size))
  return integer(value, 0, 65535) && Math.floor(value * size / 65536) === offset ? value : null
}

/** Uses the encoder's nearest/floor sampling, including fractional resize ratios and a verified content rectangle. */
export function resolveImagePoint(observation: WindowsObservation, x: number, y: number): ImagePointResolution | null {
  try {
    const o = observation, t = o.transform, c = o.crop, content = t.content_bounds
    if (!integer(x, 0, 2559) || !integer(y, 0, 2559) || !integer(o.image.width, 1, 2560) || !integer(o.image.height, 1, 2560) ||
        x >= o.image.width || y >= o.image.height || !rect(o.source_bounds) || !rect(c) || c.x < 0 || c.y < 0 ||
        c.x + c.width > o.source_bounds.width || c.y + c.height > o.source_bounds.height ||
        o.source_size.width !== o.source_bounds.width || o.source_size.height !== o.source_bounds.height ||
        !rect(content) || content.x < 0 || content.y < 0 || content.x + content.width > o.image.width || content.y + content.height > o.image.height ||
        !inside(content, x, y) || t.coordinate_space !== 'desktop_physical_pixels' || t.pixel_mapping !== 'nearest_floor' ||
        t.origin_x !== o.source_bounds.x + c.x || t.origin_y !== o.source_bounds.y + c.y || t.scale_x !== c.width / content.width || t.scale_y !== c.height / content.height ||
        !validCoordinateContext(o.coordinate_context, o.monitors, o.window_id !== null)) return null
    const desktop = { x: t.origin_x + Math.floor((x - content.x) * c.width / content.width),
      y: t.origin_y + Math.floor((y - content.y) * c.height / content.height) }
    const matches = o.monitors.filter(m => inside(m.bounds, desktop.x, desktop.y))
    if (matches.length !== 1) return null // Gaps, offscreen pixels and ambiguous overlapping monitors are not snapped to a display.
    const bounds = o.coordinate_context.virtual_bounds
    const ax = absolutePixel(desktop.x - bounds.x, bounds.width), ay = absolutePixel(desktop.y - bounds.y, bounds.height)
    if (ax === null || ay === null) return null
    return { image: { x, y }, desktop, monitor_id: matches[0].monitor_id, virtual_bounds: { ...bounds },
      absolute: { x: ax, y: ay, coordinate_space: 'win32_absolute_virtual_desktop', require_virtual_desktop: true },
      coordinate_space: 'desktop_physical_pixels', pixel_mapping: 'nearest_floor' }
  } catch { return null }
}

/** Independent main-process comparison: a helper cannot substitute its own desktop point, display or normalization. */
export function matchesImagePointResolution(value: unknown, expected: ImagePointResolution): value is ImagePointResolution {
  const point = (v: unknown, p: { x: number; y: number }): boolean => object(v) && fields(v, ['x', 'y']) && v.x === p.x && v.y === p.y
  return object(value) && fields(value, ['image', 'desktop', 'monitor_id', 'virtual_bounds', 'absolute', 'coordinate_space', 'pixel_mapping']) &&
    point(value.image, expected.image) && point(value.desktop, expected.desktop) && value.monitor_id === expected.monitor_id &&
    rect(value.virtual_bounds, 2_032_768) && sameRect(value.virtual_bounds, expected.virtual_bounds) &&
    object(value.absolute) && fields(value.absolute, ['x', 'y', 'coordinate_space', 'require_virtual_desktop']) &&
    value.absolute.x === expected.absolute.x && value.absolute.y === expected.absolute.y &&
    value.absolute.coordinate_space === 'win32_absolute_virtual_desktop' && value.absolute.require_virtual_desktop === true &&
    value.coordinate_space === 'desktop_physical_pixels' && value.pixel_mapping === 'nearest_floor'
}
