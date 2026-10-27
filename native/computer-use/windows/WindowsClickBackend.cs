using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using static Web2Term.WindowsHelper.ClickInterop;
using static Web2Term.WindowsHelper.WindowInterop;
using static Web2Term.WindowsHelper.WindowFocusInterop;

namespace Web2Term.WindowsHelper;

/** Narrow compiled input path; no activation, focus manipulation, scripts, privilege changes or user-key release. */
internal sealed class WindowsClickBackend(WindowCatalog windows, int parentPid) : IClickBackend, IDesktopClickBackend
{
    private static readonly int[] BusyKeys = [1, 2, 4, 5, 6, 0x10, 0x11, 0x12, 0x5B, 0x5C];
    private static string? DesktopName(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return null;
        StringBuilder value = new(256);
        return GetUserObjectInformation(handle, 2, value, (uint)value.Capacity * 2, out uint needed) && needed <= value.Capacity * 2 ? value.ToString() : null;
    }
    private static bool InputDesktop()
    {
        IntPtr active = OpenInputDesktop(0, false, 1); // DESKTOP_READOBJECTS only, never switches desktops.
        try { string? name = DesktopName(active); return name != null && name == DesktopName(GetThreadDesktop(GetCurrentThreadId())); }
        finally { if (active != IntPtr.Zero) _ = CloseDesktop(active); }
    }
    private static bool Cursor(CoordinatePoint expected) => GetCursorPos(out ClickInterop.Point actual) && actual.X == expected.x && actual.Y == expected.y;
    public bool Guard(WindowSelection expected, CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation)
        => GuardCore(expected, point, cursorAtPoint, false, cancellation);
    internal bool KeyboardGuard(WindowSelection expected, CancellationToken cancellation) => GuardCore(expected, null, false, true, cancellation);
    internal bool DragGuard(WindowSelection expected, CoordinatePoint point, CoordinatePoint? cursor, string button, bool holding, CancellationToken cancellation)
    {
        if (expected.Menu != null) return false;
        if (!GuardCore(expected, point, false, false, cancellation, holding ? ButtonKey(button) : null) || cursor != null && !Cursor(cursor)) return false;
        GuiThreadInfo gui = new() { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (!GetGUIThreadInfo(0, ref gui) || (gui.Flags & 0x1e) != 0) return false;
        // A visible owned modeless palette does not block the enabled foreground target.
        // GuardCore checks actual hit/capture/foreground and disabled modal owners.
        return true;
    }
    internal static int ButtonKey(string button) => button switch { "left" => 1, "right" => 2, "middle" => 4, _ => throw new InvalidDataException() };
    private bool GuardCore(WindowSelection expected, CoordinatePoint? point, bool cursorAtPoint, bool keyboard, CancellationToken cancellation, int? heldButton = null)
    {
        HelperInputState.Check(cancellation); WindowsDpiContext.RequirePhysicalCoordinates();
        WindowSelection? current = windows.Resolve(expected.ScopeId, expected.WindowId, cancellation);
        if (current == null || !expected.Window.SameIdentity(current.Window) || expected.Menu?.ContextId != current.Menu?.ContextId || current.Window.Pid == parentPid || current.Window.Pid == Environment.ProcessId ||
            !current.Window.Visible || current.Window.Minimized || !current.Window.Enabled || current.Window.Cloaked != false || !InputDesktop()) return false;
        IntPtr target = (IntPtr)long.Parse(current.Window.Handle.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        if (current.Menu != null) {
            if (heldButton != null || !windows.MenuCurrent(current, cancellation) || BusyKeys.Any(key => (GetAsyncKeyState(key) & 0x8000) != 0)) return false;
            if (point != null) {
                IntPtr hit = WindowFromPoint(new ClickInterop.Point { X = point.x, Y = point.y });
                if (hit == IntPtr.Zero || GetAncestor(hit, 2) != target || cursorAtPoint && !Cursor(point)) return false;
            }
            return windows.MenuCurrent(current, cancellation);
        }
        GuiThreadInfo gui = new() { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (GetForegroundWindow() != target || !GetGUIThreadInfo(0, ref gui) || gui.Active != target || keyboard && gui.Focus == IntPtr.Zero || gui.Focus != IntPtr.Zero && GetAncestor(gui.Focus, 2) != target ||
            (heldButton == null ? gui.Capture != IntPtr.Zero : gui.Capture != IntPtr.Zero && GetAncestor(gui.Capture, 2) != target) ||
            gui.MenuOwner != IntPtr.Zero || gui.MoveSize != IntPtr.Zero ||
            heldButton != null && (GetAsyncKeyState(heldButton.Value) & 0x8000) == 0 || BusyKeys.Any(key => key != heldButton && (GetAsyncKeyState(key) & 0x8000) != 0)) return false;
        if (point != null) {
            IntPtr hit = WindowFromPoint(new ClickInterop.Point { X = point.x, Y = point.y });
            if (hit == IntPtr.Zero || GetAncestor(hit, 2) != target || cursorAtPoint && !Cursor(point)) return false;
        }
        WindowSelection? after = windows.Resolve(expected.ScopeId, expected.WindowId, cancellation);
        return after != null && expected.Window.SameIdentity(after.Window) && GetForegroundWindow() == target;
    }
    public MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested(); WindowsDpiContext.CheckVirtualBounds(point.VirtualBounds);
        Input[] inputs = [Mouse(point.Absolute.x, point.Absolute.y, 0x0001 | 0x8000 | 0x4000 | 0x2000)]; // MOVE/ABSOLUTE/VIRTUALDESK/NOCOALESCE.
        int accepted = HelperInputState.Send(inputs, cancellation);
        if (accepted != 1) return new(accepted, false);
        Stopwatch elapsed = Stopwatch.StartNew();
        while (!cancellation.IsCancellationRequested && elapsed.ElapsedMilliseconds < 200) {
            if (Cursor(point.Desktop)) return new(accepted, true);
            if (cancellation.WaitHandle.WaitOne(10)) break;
        }
        return new(accepted, false);
    }
    public int Buttons(WindowSelection window, DesktopPointResolution point, string button, int count, CancellationToken cancellation)
    {
        // All failure here is still before SendInput. Return zero so cleanup never releases a button we did not submit.
        try {
            if (cancellation.IsCancellationRequested) return 0;
            WindowsDpiContext.CheckVirtualBounds(point.VirtualBounds);
            if (!Guard(window, point.Desktop, true, cancellation)) return 0;
        } catch { return 0; }
        var flags = ButtonFlags(button);
        Input[] inputs = Enumerable.Range(0, count).SelectMany(_ => new[] { Mouse(0, 0, flags.Down), Mouse(0, 0, flags.Up) }).ToArray();
        if (cancellation.IsCancellationRequested) return 0;
        return HelperInputState.Send(inputs, cancellation);
    }
    public string? DesktopTarget(CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation)
    {
        HelperInputState.Check(cancellation); WindowsDpiContext.RequirePhysicalCoordinates();
        if (!InputDesktop() || BusyKeys.Any(key => (GetAsyncKeyState(key) & 0x8000) != 0) || cursorAtPoint && !Cursor(point)) return null;
        IntPtr hit = WindowFromPoint(new ClickInterop.Point { X = point.x, Y = point.y });
        IntPtr root = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, 2); // GA_ROOT
        if (root == IntPtr.Zero) return null;
        _ = ApplicationInterop.GetWindowThreadProcessId(root, out uint pid);
        if (pid == 0 || pid == (uint)parentPid || pid == (uint)Environment.ProcessId) return null;
        StringBuilder name = new(257); _ = GetClassName(root, name, name.Capacity);
        bool menu = name.ToString() == "#32768";
        GuiThreadInfo gui = new() { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (!GetGUIThreadInfo(0, ref gui) || gui.MoveSize != IntPtr.Zero ||
            (gui.MenuOwner != IntPtr.Zero || (gui.Flags & 0x4) != 0) && !menu || // GUI_INMENUMODE: only the open menu itself.
            gui.Capture != IntPtr.Zero && !menu && GetAncestor(gui.Capture, 2) != root) return null;
        return string.Join(':', root.ToInt64(), pid, name.ToString());
    }
    public int DesktopButtons(DesktopPointResolution point, string target, string button, int count, CancellationToken cancellation)
    {
        // As in Buttons: every failure here is before SendInput, so cleanup never releases a button we did not submit.
        try {
            if (cancellation.IsCancellationRequested) return 0;
            WindowsDpiContext.CheckVirtualBounds(point.VirtualBounds);
            if (DesktopTarget(point.Desktop, true, cancellation) != target) return 0;
        } catch { return 0; }
        var flags = ButtonFlags(button);
        Input[] inputs = Enumerable.Range(0, count).SelectMany(_ => new[] { Mouse(0, 0, flags.Down), Mouse(0, 0, flags.Up) }).ToArray();
        if (cancellation.IsCancellationRequested) return 0;
        return HelperInputState.Send(inputs, cancellation);
    }
    public int Release(string button)
    {
        Input[] inputs = [Mouse(0, 0, ButtonFlags(button).Up)];
        return HelperInputState.Release(inputs); // Cleanup releases only this helper's attempted button, even after cancellation/focus change.
    }
}
