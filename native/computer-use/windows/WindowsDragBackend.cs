using System.Diagnostics;
using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ClickInterop;
using static Web2Term.WindowsHelper.ScrollInterop;

namespace Web2Term.WindowsHelper;

/** No UIA or capture while a button is held. Each wait is cancellable and guarded in <=25ms slices. */
internal sealed class WindowsDragBackend(WindowCatalog windows, int parentPid, IObservationBackend images) : IDragBackend
{
    private readonly WindowsClickBackend input = new(windows, parentPid);
    public bool Guard(CaptureSource source, CoordinatePoint point, CoordinatePoint? cursor, string button, bool holding, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (source.Window is not WindowSelection window) return false;
        CaptureSource current = images.Source(new(window.ScopeId, "window", window.WindowId, null, null, 1600, ""), cancellation);
        if (current.Bounds != source.Bounds || current.WindowDpi != source.WindowDpi || !current.Monitors.SequenceEqual(source.Monitors) ||
            current.Window == null || !window.Window.SameIdentity(current.Window.Window) || !input.DragGuard(window, point, cursor, button, holding, cancellation)) return false;
        // Do not start/move on title bars, window borders, other apps or owned popup windows.
        ClickInterop.Point location = new() { X = point.x, Y = point.y };
        IntPtr hit = WindowFromPoint(location);
        if (hit == IntPtr.Zero || !ScreenToClient(hit, ref location) || !GetClientRect(hit, out Rect bounds) ||
            location.X < bounds.Left || location.Y < bounds.Top || location.X >= bounds.Right || location.Y >= bounds.Bottom) return false;
        return true;
    }
    public MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation) => input.Move(point, cancellation);
    public int Down(CaptureSource source, DesktopPointResolution point, string button, CancellationToken cancellation)
    {
        // All failures caught here precede SendInput; never release a button for a proven zero insertion.
        try { if (!Guard(source, point.Desktop, point.Desktop, button, false, cancellation)) return 0; }
        catch { return 0; }
        if (cancellation.IsCancellationRequested) return 0;
        return HelperInputState.Send([Mouse(0, 0, ButtonFlags(button).Down)], cancellation);
    }
    public bool ConfirmDown(string button, CancellationToken cancellation)
    {
        Stopwatch timer = Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 200) {
            cancellation.ThrowIfCancellationRequested();
            if ((GetAsyncKeyState(WindowsClickBackend.ButtonKey(button)) & 0x8000) != 0) return true;
            if (cancellation.WaitHandle.WaitOne(5)) cancellation.ThrowIfCancellationRequested();
        }
        return false;
    }
    public bool Pause(CaptureSource source, CoordinatePoint point, string button, int milliseconds, CancellationToken cancellation)
    {
        Stopwatch timer = Stopwatch.StartNew();
        do {
            cancellation.ThrowIfCancellationRequested();
            if (!Guard(source, point, point, button, true, cancellation)) return false;
            int remaining = milliseconds - (int)timer.ElapsedMilliseconds;
            if (remaining <= 0) return true;
            if (cancellation.WaitHandle.WaitOne(Math.Min(25, remaining))) cancellation.ThrowIfCancellationRequested();
        } while (true);
    }
    public int Up(string button) => input.Release(button); // Necessary up is attempted even after cancellation/focus loss.
}
