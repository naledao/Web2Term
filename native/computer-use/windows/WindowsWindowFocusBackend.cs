using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ApplicationInterop;
using static Web2Term.WindowsHelper.ApplicationLaunchInterop;
using static Web2Term.WindowsHelper.WindowInterop;
using static Web2Term.WindowsHelper.WindowFocusInterop;

namespace Web2Term.WindowsHelper;

/** Executes on the existing MTA. Never joins input queues, synthesizes input, changes foreground policy or makes windows topmost. */
internal sealed class WindowsWindowFocusBackend(WindowCatalog catalog) : IWindowFocusBackend
{
    public FocusCall Restore(WindowSelection target, CancellationToken cancellation) => Change(target, true, cancellation);
    public FocusCall Activate(WindowSelection target, CancellationToken cancellation) => Change(target, false, cancellation);
    private FocusCall Change(WindowSelection expected, bool restore, CancellationToken cancellation)
    {
        bool attempted = false;
        try
        {
            HelperInputState.Check(cancellation);
            WindowSelection? current = catalog.Resolve(expected.ScopeId, expected.WindowId, cancellation);
            if (current == null || !expected.Window.SameIdentity(current.Window)) return new(false, null, "stale_window");
            if (!current.Window.Enabled || current.Window.Cloaked == true) return new(false, null, "window_blocked");
            bool hidden = !current.Window.Visible || current.Window.Minimized;
            if (restore && !hidden) return new(false, null);
            if (!restore && hidden) return new(false, null, "restore_required");
            IntPtr window = Parse(current.Window.Handle);
            HelperInputState.Check(cancellation);
            attempted = true;
            bool accepted = restore ? ShowWindowAsync(window, current.Window.Minimized ? 9 : 5) : SetForegroundWindow(window);
            return new(true, accepted); // ShowWindowAsync means queued; SetForegroundWindow BOOL is not independent focus evidence.
        }
        catch (OperationCanceledException) { return new(attempted, null, "cancelled"); }
        catch { return new(attempted, null, attempted ? "executor_error" : "unavailable"); }
    }
    public FocusSample Observe(WindowSelection expected, bool checkUia, CancellationToken cancellation)
    {
        HelperInputState.Check(cancellation);
        WindowSelection? current = catalog.Resolve(expected.ScopeId, expected.WindowId, cancellation);
        if (current == null || !expected.Window.SameIdentity(current.Window)) return new(FocusObservation.Empty);
        IntPtr target = Parse(current.Window.Handle);
        FocusObservation before = GuiFocus(target);
        UiaFocusState uia = checkUia && before.win32_focus == "confirmed" ? UiaFocus(target, cancellation) : new("not_checked");
        FocusObservation after = GuiFocus(target); // UIA may cross processes; re-read actual routing after it returns.
        if (before.foreground_hwnd != after.foreground_hwnd || before.focus_hwnd != after.focus_hwnd || before.active_hwnd != after.active_hwnd)
            uia = new("unavailable");
        IntPtr popup = GetLastActivePopup(target);
        string? blocking = popup != IntPtr.Zero && popup != target && IsWindow(popup) && IsWindowVisible(popup) ? Handle(popup) : null;
        return new(after with { uia_focus = uia }, blocking);
    }
    private static FocusObservation GuiFocus(IntPtr target)
    {
        IntPtr foreground = GetForegroundWindow();
        GuiThreadInfo gui = new() { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (!GetGUIThreadInfo(0, ref gui)) return new(Handle(foreground), null, null, null, "unavailable", new("not_checked"));
        IntPtr root = gui.Focus != IntPtr.Zero && IsWindow(gui.Focus) ? GetAncestor(gui.Focus, 2) : IntPtr.Zero;
        bool stable = GetForegroundWindow() == foreground;
        string state = !stable || foreground == IntPtr.Zero || gui.Active == IntPtr.Zero || gui.Focus == IntPtr.Zero || root == IntPtr.Zero ? "unavailable"
            : foreground == target && gui.Active == target && root == target ? "confirmed" : "outside_target";
        return new(Handle(foreground), Handle(gui.Active), Handle(gui.Focus), Handle(root), state, new("not_checked"));
    }
    private static UiaFocusState UiaFocus(IntPtr target, CancellationToken cancellation)
    {
        object? automationObject = null;
        IUIAutomationElement? focused = null, cursor = null, latest = null;
        IUIAutomationTreeWalker? walker = null;
        try
        {
            HelperInputState.Check(cancellation);
            automationObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"), true)!)!;
            var automation = (IUIAutomation)automationObject;
            Marshal.ThrowExceptionForHR(automation.GetFocusedElement(out focused));
            if (focused == null) return new("unavailable");
            bool? hasFocus = BooleanProperty(focused, 30008); // UIA_HasKeyboardFocusPropertyId.
            if (hasFocus == null) return new("unavailable");
            Marshal.ThrowExceptionForHR(automation.GetRawViewWalker(out walker));
            cursor = focused;
            IntPtr root = IntPtr.Zero;
            Stopwatch elapsed = Stopwatch.StartNew();
            for (int depth = 0; depth < 32 && cursor != null && elapsed.ElapsedMilliseconds < 500; depth++)
            {
                HelperInputState.Check(cancellation);
                IntPtr handle = WindowProperty(cursor);
                if (handle != IntPtr.Zero && IsWindow(handle)) { root = GetAncestor(handle, 2); if (root != IntPtr.Zero) break; }
                Marshal.ThrowExceptionForHR(walker.GetParentElement(cursor, out IUIAutomationElement? parent));
                if (!ReferenceEquals(cursor, focused)) Release(cursor);
                cursor = parent;
            }
            if (root == IntPtr.Zero) return new("unavailable");
            Marshal.ThrowExceptionForHR(automation.GetFocusedElement(out latest));
            if (latest == null) return new("unavailable");
            Marshal.ThrowExceptionForHR(automation.CompareElements(focused, latest, out bool same));
            if (!same || BooleanProperty(latest, 30008) != true) return new("outside_target", Handle(root), false);
            return new(root == target && hasFocus == true ? "confirmed" : "outside_target", Handle(root), hasFocus);
        }
        catch (OperationCanceledException) { throw; }
        catch { return new("unavailable"); }
        finally
        {
            if (!ReferenceEquals(cursor, focused) && !ReferenceEquals(cursor, latest)) Release(cursor);
            if (!ReferenceEquals(latest, focused)) Release(latest);
            Release(focused); Release(walker); Release(automationObject);
        }
    }
    private static bool? BooleanProperty(IUIAutomationElement element, int property)
    {
        Marshal.ThrowExceptionForHR(element.GetCurrentPropertyValue(property, out object value));
        try { return value is bool actual ? actual : null; }
        finally { Release(value); }
    }
    private static IntPtr WindowProperty(IUIAutomationElement element)
    {
        Marshal.ThrowExceptionForHR(element.GetCurrentPropertyValue(30020, out object value)); // UIA_NativeWindowHandlePropertyId.
        try { return value is int handle ? new IntPtr(handle) : IntPtr.Zero; }
        finally { Release(value); }
    }
    private static string? Handle(IntPtr window) => window != IntPtr.Zero ? "0x" + window.ToInt64().ToString("x") : null;
    private static IntPtr Parse(string handle) => (IntPtr)long.Parse(handle.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
}
