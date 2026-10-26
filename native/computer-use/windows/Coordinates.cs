namespace Web2Term.WindowsHelper;

internal sealed record DesktopCoordinateContext(string dpi_awareness, CaptureRect virtual_bounds, uint? window_dpi);
internal sealed record CoordinatePoint(int x, int y);
internal sealed record AbsoluteDesktopPoint(int x, int y, string coordinate_space = "win32_absolute_virtual_desktop", bool require_virtual_desktop = true);
internal sealed record ImagePointResolution(CoordinatePoint image, CoordinatePoint desktop, string monitor_id, CaptureRect virtual_bounds,
    AbsoluteDesktopPoint absolute, string coordinate_space = "desktop_physical_pixels", string pixel_mapping = "nearest_floor");
internal sealed record DesktopPointResolution(CoordinatePoint Desktop, AbsoluteDesktopPoint Absolute, CaptureRect VirtualBounds);

/** Pure checked integer geometry; no DPI multiplication, HWND, cursor movement or SendInput. */
internal static class CoordinateMapper
{
    internal static CaptureRect VirtualBounds(CaptureMonitor[] monitors)
    {
        if (monitors.Length is < 1 or > 16 || monitors.Any(m => !m.bounds.Valid)) throw new ObservationException("unavailable");
        int left = monitors.Min(m => m.bounds.x), top = monitors.Min(m => m.bounds.y);
        return new(left, top, checked(monitors.Max(m => m.bounds.x + m.bounds.width) - left), checked(monitors.Max(m => m.bounds.y + m.bounds.height) - top));
    }
    internal static DesktopCoordinateContext Context(CaptureSource source) => new("per_monitor_v2", VirtualBounds(source.Monitors), source.WindowDpi);
    private static bool Inside(CaptureRect r, int x, int y) => x >= r.x && y >= r.y && (long)x < (long)r.x + r.width && (long)y < (long)r.y + r.height;
    private static int? Absolute(int offset, int size)
    {
        if (size <= 0 || offset < 0 || offset >= size) return null;
        long value = ((long)offset * 2 + 1) * 65536 / ((long)size * 2);
        return value is >= 0 and <= 65535 && value * size / 65536 == offset ? (int)value : null;
    }
    // Only native trusted control geometry uses this overload; the model never supplies a physical point.
    internal static DesktopPointResolution? ResolvePhysical(CaptureSource source, CoordinatePoint point)
    {
        if (!Inside(source.Bounds, point.x, point.y) || source.Monitors.Count(m => Inside(m.bounds, point.x, point.y)) != 1) return null;
        CaptureRect bounds = VirtualBounds(source.Monitors);
        int? x = Absolute(checked(point.x - bounds.x), bounds.width), y = Absolute(checked(point.y - bounds.y), bounds.height);
        return x != null && y != null ? new(point, new(x.Value, y.Value), bounds) : null;
    }
    internal static ImagePointResolution? Resolve(ObservationResult o, int x, int y)
    {
        try
        {
            CaptureRect c = o.crop, content = o.transform.content_bounds;
            CaptureTransform t = o.transform;
            if (x < 0 || y < 0 || x >= o.image.width || y >= o.image.height || o.image.width is < 1 or > 2560 || o.image.height is < 1 or > 2560 ||
                !o.source_bounds.Valid || !c.Valid || c.x < 0 || c.y < 0 || (long)c.x + c.width > o.source_bounds.width || (long)c.y + c.height > o.source_bounds.height ||
                o.source_size.width != o.source_bounds.width || o.source_size.height != o.source_bounds.height ||
                !content.Valid || content.x < 0 || content.y < 0 || (long)content.x + content.width > o.image.width || (long)content.y + content.height > o.image.height || !Inside(content, x, y) ||
                t.coordinate_space != "desktop_physical_pixels" || t.pixel_mapping != "nearest_floor" ||
                t.origin_x != o.source_bounds.x + c.x || t.origin_y != o.source_bounds.y + c.y || t.scale_x != (double)c.width / content.width || t.scale_y != (double)c.height / content.height ||
                o.coordinate_context.dpi_awareness != "per_monitor_v2" || o.coordinate_context.virtual_bounds != VirtualBounds(o.monitors) ||
                (o.window_id != null ? o.coordinate_context.window_dpi is null or < 48 or > 960 : o.coordinate_context.window_dpi != null)) return null;
            int dx = checked(t.origin_x + (int)((long)(x - content.x) * c.width / content.width));
            int dy = checked(t.origin_y + (int)((long)(y - content.y) * c.height / content.height));
            CaptureMonitor[] matching = o.monitors.Where(m => Inside(m.bounds, dx, dy)).ToArray();
            if (matching.Length != 1) return null;
            CaptureRect bounds = o.coordinate_context.virtual_bounds;
            int? ax = Absolute(checked(dx - bounds.x), bounds.width), ay = Absolute(checked(dy - bounds.y), bounds.height);
            return ax != null && ay != null ? new(new(x, y), new(dx, dy), matching[0].monitor_id, bounds, new(ax.Value, ay.Value)) : null;
        }
        catch (Exception error) when (error is OverflowException or ObservationException or NullReferenceException) { return null; }
    }
}
