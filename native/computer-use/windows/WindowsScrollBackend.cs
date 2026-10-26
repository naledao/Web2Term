using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ClickInterop;
using static Web2Term.WindowsHelper.ScrollInterop;
using static Web2Term.WindowsHelper.WindowFocusInterop;

namespace Web2Term.WindowsHelper;

internal sealed class WindowsScrollBackend(WindowCatalog windows, int parentPid) : IScrollBackend
{
    private readonly WindowsClickBackend input = new(windows, parentPid);
    public bool Guard(WindowSelection window, CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation) => window.Menu == null && input.Guard(window, point, cursorAtPoint, cancellation);
    public MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation) => input.Move(point, cancellation);
    public string? Routing(WindowSelection window, CoordinatePoint point, string axis, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!Guard(window, point, false, cancellation)) return null;
        ClickInterop.Point location = new() { X = point.x, Y = point.y };
        IntPtr hit = WindowFromPoint(location);
        if (hit == IntPtr.Zero || !ScreenToClient(hit, ref location) || !GetClientRect(hit, out Rect bounds) ||
            location.X < bounds.Left || location.Y < bounds.Top || location.X >= bounds.Right || location.Y >= bounds.Bottom) return null;
        // Vertical mouse-position routing is explicit. Legacy/hybrid and horizontal messages may use focus;
        // require the exact hit HWND to equal focus rather than guessing another child pane or changing settings.
        uint? mode = WheelRouting(0x201c, 0, out uint value, 0) ? value : null;
        if (axis == "vertical" && mode == 2) return ScrollRoutingPolicy.Select(axis, mode, false);
        GuiThreadInfo gui = new() { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        return GetGUIThreadInfo(0, ref gui) ? ScrollRoutingPolicy.Select(axis, mode, gui.Focus == hit) : null;
    }
    public int Wheel(WindowSelection window, DesktopPointResolution point, ScrollOptions options, string routing, CancellationToken cancellation)
    {
        try {
            if (cancellation.IsCancellationRequested) return 0;
            WindowsDpiContext.CheckVirtualBounds(point.VirtualBounds);
            if (!Guard(window, point.Desktop, true, cancellation) || Routing(window, point.Desktop, options.Axis, cancellation) != routing) return 0;
        } catch { return 0; } // Read-only failure before SendInput, never interpreted as a wheel event.
        if (cancellation.IsCancellationRequested) return 0;
        return HelperInputState.Send([ScrollInterop.Wheel(options)], cancellation);
    }
}
