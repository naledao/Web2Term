// User-run only: pure geometry and shared golden vectors; no processes, desktop, Electron or input.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const exports = {}
const compiled = ts.transpileModule(readFileSync(new URL('../src/shared/windows-coordinates.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
new Script(compiled).runInNewContext({ exports })
const { virtualDesktopBounds, resolveImagePoint, validCoordinateContext, matchesImagePointResolution } = exports
const vectors = JSON.parse(readFileSync(new URL('./fixtures/windows-coordinate-cases.json', import.meta.url), 'utf8'))
const rect = ([x, y, width, height]) => ({ x, y, width, height })
const plain = value => JSON.parse(JSON.stringify(value))
function frame(v) {
  const source = rect(v.source), crop = rect(v.crop ?? [0, 0, source.width, source.height])
  const content = rect(v.content ?? [0, 0, ...v.image])
  const monitors = v.monitors.map(([monitor_id, x, y, width, height, dpi, primary]) => ({ monitor_id, bounds: { x, y, width, height }, dpi_x: dpi, dpi_y: dpi, primary }))
  return { observation_id: 'obs_' + 'a'.repeat(32), target: 'window', window_id: 'win_' + 'a'.repeat(32), source_bounds: source,
    source_size: { width: source.width, height: source.height }, crop, image: { width: v.image[0], height: v.image[1] }, monitors,
    transform: { origin_x: source.x + crop.x, origin_y: source.y + crop.y, scale_x: crop.width / content.width, scale_y: crop.height / content.height,
      content_bounds: content, coordinate_space: 'desktop_physical_pixels', pixel_mapping: 'nearest_floor' },
    coordinate_context: { dpi_awareness: 'per_monitor_v2', virtual_bounds: virtualDesktopBounds(monitors), window_dpi: v.window_dpi } }
}

for (const vector of vectors) test(vector.name, () => {
  const o = frame(vector)
  for (const [x, y, dx, dy, monitor] of vector.points) {
    const actual = resolveImagePoint(o, x, y)
    if (dx === null) { assert.equal(actual, null, `${x},${y}`); continue }
    assert.ok(actual); assert.deepEqual(plain(actual.desktop), { x: dx, y: dy }); assert.equal(actual.monitor_id, monitor)
    assert.equal(actual.coordinate_space, 'desktop_physical_pixels'); assert.equal(actual.absolute.require_virtual_desktop, true)
    const v = actual.virtual_bounds
    assert.equal(v.x + Math.floor(actual.absolute.x * v.width / 65536), dx)
    assert.equal(v.y + Math.floor(actual.absolute.y * v.height / 65536), dy)
    assert.equal(matchesImagePointResolution(actual, actual), true)
    if (v.width === 1) assert.equal(actual.absolute.x, 32768)
  }
})

test('nonfinite fractional forged or inconsistent coordinate frames never produce an input point', () => {
  for (const mutate of [o => { o.transform.scale_x = 1.25 }, o => { o.transform.origin_x++ }, o => { o.transform.coordinate_space = 'logical_pixels' },
    o => { o.transform.pixel_mapping = 'linear' }, o => { o.transform.content_bounds.width++ }, o => { o.coordinate_context.virtual_bounds.x++ },
    o => { o.coordinate_context.dpi_awareness = 'system_aware' }, o => { o.coordinate_context.window_dpi = 0 }, o => { o.crop.width = Infinity },
    o => { o.crop.x = -1 }, o => { o.source_size.width++ }]) {
    const o = frame(vectors[0]); mutate(o); assert.equal(resolveImagePoint(o, 10, 10), null)
  }
  const o = frame(vectors[0])
  for (const [x, y] of [[-1, 0], [0.5, 1], [NaN, 0], [0, Infinity], [2560, 0]]) assert.equal(resolveImagePoint(o, x, y), null)
  assert.equal(validCoordinateContext({ ...o.coordinate_context, injected: true }, o.monitors, true), false)
})

test('returned physical point display normalization and exact fields are independently compared', () => {
  const expected = resolveImagePoint(frame(vectors[0]), 10, 10)
  assert.ok(expected)
  for (const mutate of [p => { p.desktop.x++ }, p => { p.image.y++ }, p => { p.monitor_id = 'wrong' }, p => { p.virtual_bounds.width++ },
    p => { p.absolute.x++ }, p => { p.absolute.require_virtual_desktop = false }, p => { p.absolute.coordinate_space = 'primary_monitor' },
    p => { p.absolute.script = 'override' }, p => { p.coordinate_space = 'logical_pixels' }]) {
    const changed = structuredClone(expected); mutate(changed); assert.equal(matchesImagePointResolution(changed, expected), false)
  }
})
