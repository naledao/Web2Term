using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using static Web2Term.WindowsHelper.WindowInterop;
using static Web2Term.WindowsHelper.WindowFocusInterop;
using static Web2Term.WindowsHelper.ApplicationInterop;

namespace Web2Term.WindowsHelper;

/** Read-only Win32 state, event revisions and topology. Never switches to a popup or reads another window's text. */
internal sealed class WindowsObservationStateBackend(IObservationBackend images, WindowLifetimeMonitor events, IControlTreeBackend controls, WindowCatalog windows) : IObservationStateBackend
{
    public ObservationState Read(ObservationRequest request, CancellationToken cancellation)
    {
        CaptureSource source = images.Source(request, cancellation);
        DiscoveredWindow? selected = source.Window?.Window;
        IntPtr target = selected == null ? IntPtr.Zero : Parse(selected.Handle);
        string revision = events.ObservationRevision(target, cancellation) ?? throw new ObservationException("unavailable");
        GuiThreadInfo gui = new() { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        IntPtr foreground = GetForegroundWindow();
        if (!GetGUIThreadInfo(0, ref gui)) throw new ObservationException("unavailable");
        string focus = string.Join('|', foreground.ToInt64(), gui.Active.ToInt64(), gui.Focus.ToInt64(), gui.Capture.ToInt64(), gui.MenuOwner.ToInt64(), gui.MoveSize.ToInt64(), gui.Flags,
            selected == null ? "no-target" : UiaFocus(source.Window!, cancellation));
        WindowsDpiContext.RequirePhysicalCoordinates();
        List<string> popups = [];
        bool overflow = false; int visited = 0;
        if (target != IntPtr.Zero)
        {
            EnumWindowCallback callback = (window, ignored) =>
            {
                if (++visited > 4096 || cancellation.IsCancellationRequested) { overflow = true; return false; }
                if (window == target || !IsWindowVisible(window)) return true;
                IntPtr owner = GetWindow(window, 4); // GW_OWNER; never target by title/name.
                for (int depth = 0; owner != IntPtr.Zero && depth < 8; depth++)
                {
                    if (owner == target)
                    {
                        if (popups.Count >= 64) { overflow = true; return false; }
                        _ = GetWindowThreadProcessId(window, out uint pid);
                        StringBuilder name = new(257); _ = GetClassName(window, name, name.Capacity);
                        if (!GetWindowRect(window, out Box box)) { overflow = true; return false; }
                        popups.Add(string.Join('|', window.ToInt64(), pid, name, box.Left, box.Top, box.Right, box.Bottom, events.Lifetime(window)));
                        break;
                    }
                    owner = GetWindow(owner, 4);
                }
                return true;
            };
            if (!EnumWindows(callback, IntPtr.Zero) || overflow) { cancellation.ThrowIfCancellationRequested(); throw new ObservationException("unavailable"); }
        }
        popups.Sort(StringComparer.Ordinal);
        IntPtr popup = target == IntPtr.Zero ? IntPtr.Zero : GetLastActivePopup(target);
        string popupHash = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { popups, last = popup.ToInt64() })));
        bool ready = target != IntPtr.Zero && foreground == target && gui.Active == target && gui.Focus != IntPtr.Zero &&
            GetAncestor(gui.Focus, 2) == target && gui.MenuOwner == IntPtr.Zero && gui.MoveSize == IntPtr.Zero && gui.Capture == IntPtr.Zero &&
            selected!.Visible && !selected.Minimized && selected.Enabled && selected.Cloaked == false;
        bool pointerReady = target != IntPtr.Zero && foreground == target && gui.Active == target &&
            (gui.Focus == IntPtr.Zero || GetAncestor(gui.Focus, 2) == target) && gui.MenuOwner == IntPtr.Zero && gui.MoveSize == IntPtr.Zero && gui.Capture == IntPtr.Zero &&
            selected!.Visible && !selected.Minimized && selected.Enabled && selected.Cloaked == false;
        // Detached native menus route through their verified foreground owner. The private relation is rechecked now;
        // ordinary windows still cannot consume menu/capture state as permission to input.
        if (source.Window?.Menu != null) ready = pointerReady = windows.MenuCurrent(source.Window, cancellation);
        // A desktop/region image has no business-window focus or UIA target to stabilize.
        // WinEvent focus/object revisions may legitimately move while Windows Graphics
        // Capture is taking the frame (tray refresh, compositor activity, caret repaint).
        // The image path independently rechecks monitor topology, bounds and frame size;
        // reserve the revision race for a concrete window observation, where it protects
        // the later input binding.
        // Events may change while reading even a valid screenshot. Keep the latest revision;
        // source geometry and each later input target are independently checked by their callers.
        revision = events.ObservationRevision(target, cancellation) ?? throw new ObservationException("unavailable");
        return new(source, focus, popupHash, revision, ready, pointerReady);
    }
    private string UiaFocus(WindowSelection target, CancellationToken cancellation)
    {
        System.Diagnostics.Stopwatch elapsed = System.Diagnostics.Stopwatch.StartNew();
        void Check() { cancellation.ThrowIfCancellationRequested(); if (elapsed.ElapsedMilliseconds >= 500) throw new ControlBudgetExceeded(); }
        try {
            using IControlTreeSession session = controls.Open(target, Check, cancellation);
            ControlFocus focus = session.Focus();
            return focus.Status + ":" + focus.Key;
        }
        catch (OperationCanceledException) { throw; }
        catch { return "unavailable"; } // WGC remains available; no focused UIA control is fabricated.
    }
    private static IntPtr Parse(string value) => (IntPtr)long.Parse(value.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    [StructLayout(LayoutKind.Sequential)] private struct Box { internal int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowRect(IntPtr window, out Box bounds);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
}
