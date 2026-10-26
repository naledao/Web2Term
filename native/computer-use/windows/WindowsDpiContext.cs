using System.Runtime.InteropServices;

namespace Web2Term.WindowsHelper;

internal static class WindowsDpiContext
{
    internal static void RequirePhysicalCoordinates()
    {
        // Manifest sets PMv2. Verify this thread too; never silently mix virtualized Win32 and physical WGC/UIA coordinates.
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) throw new ObservationException("unavailable");
    }
    internal static void CheckDesktop(CaptureMonitor[] monitors)
    {
        CheckVirtualBounds(CoordinateMapper.VirtualBounds(monitors));
    }
    internal static void CheckVirtualBounds(CaptureRect bounds)
    {
        RequirePhysicalCoordinates();
        if (GetSystemMetrics(76) != bounds.x || GetSystemMetrics(77) != bounds.y || GetSystemMetrics(78) != bounds.width || GetSystemMetrics(79) != bounds.height)
            throw new ObservationException("stale_observation");
    }
    internal static uint WindowDpi(IntPtr window)
    {
        RequirePhysicalCoordinates();
        uint dpi = GetDpiForWindow(window);
        return dpi is >= 48 and <= 960 ? dpi : throw new ObservationException("unavailable");
    }
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int metric);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
}
