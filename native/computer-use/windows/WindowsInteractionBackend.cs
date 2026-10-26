using System.Globalization;
using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ClickInterop;
using static Web2Term.WindowsHelper.WindowFocusInterop;
using static Web2Term.WindowsHelper.WindowInterop;

namespace Web2Term.WindowsHelper;

/** Read-only owner/menu evidence. No activation, command IDs, dialog acceptance, SendMessage or UIA Invoke. */
internal sealed class WindowsInteractionBackend(IWindowDiscovery discovery) : IWindowInteractionBackend
{
    private static IntPtr Parse(string value) => (IntPtr)long.Parse(value.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    private static string? Handle(IntPtr value) => value == IntPtr.Zero ? null : "0x" + value.ToInt64().ToString("x");
    private static GuiThreadInfo Gui() {
        GuiThreadInfo gui = new() { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (!GetGUIThreadInfo(0, ref gui)) throw new ObservationException("unavailable");
        return gui;
    }
    public InteractionCapture Capture(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested(); GuiThreadInfo gui = Gui();
        InteractionGui state = new(Handle(GetForegroundWindow()), Handle(gui.MenuOwner), Handle(gui.MenuOwner == IntPtr.Zero ? IntPtr.Zero : GetAncestor(gui.MenuOwner, 2)), Handle(gui.Capture), gui.Flags);
        return new(discovery.Capture(false, cancellation), state);
    }
    public bool MenuCurrent(MenuWindowBinding menu, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        DiscoveredWindow? anchor = discovery.Read(menu.Anchor.Window.Handle, cancellation), popup = discovery.Read(menu.Popup.Handle, cancellation);
        if (anchor == null || !anchor.SameIdentity(menu.Anchor.Window) || !anchor.Visible || anchor.Minimized || !anchor.Enabled || anchor.Cloaked != false ||
            popup == null || !popup.SameIdentity(menu.Popup) || popup.Handle != anchor.Handle && popup.ClassName != "#32768" || !popup.Visible || !popup.Enabled || popup.Cloaked != false ||
            popup.Pid != anchor.Pid || popup.ThreadId != anchor.ThreadId) return false;
        GuiThreadInfo gui = Gui(); IntPtr root = Parse(anchor.Handle);
        if ((gui.Flags & 0x1c) == 0 || (gui.Flags & 0x2) != 0 || gui.MoveSize != IntPtr.Zero || GetForegroundWindow() != root || gui.Active != root ||
            Handle(gui.MenuOwner) != menu.MenuOwner || gui.MenuOwner == IntPtr.Zero || GetAncestor(gui.MenuOwner, 2) != root) return false;
        bool Belongs(IntPtr handle) {
            if (handle == IntPtr.Zero) return true;
            IntPtr top = GetAncestor(handle, 2); if (top == root) return true;
            string? value = Handle(top); DiscoveredWindow? row = value == null ? null : discovery.Read(value, cancellation);
            return row is { Verified: true, Visible: true, ClassName: "#32768" } && row.Pid == anchor.Pid && row.ThreadId == anchor.ThreadId;
        }
        return Belongs(gui.Capture) && Belongs(gui.Focus);
    }
    public bool? Modal(DiscoveredWindow window, CancellationToken cancellation)
    {
        object? automationObject = null; IUIAutomationElement? element = null; object? available = null, value = null;
        try {
            cancellation.ThrowIfCancellationRequested();
            automationObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"), true)!);
            IUIAutomation automation = (IUIAutomation)automationObject!;
            Marshal.ThrowExceptionForHR(automation.ElementFromHandle(Parse(window.Handle), out element));
            // Ignore provider defaults: unavailable/unsupported is unknown, not a fabricated modeless window.
            Marshal.ThrowExceptionForHR(element.GetCurrentPropertyValueEx(30044, true, out available));
            if (available is not true) return null;
            Marshal.ThrowExceptionForHR(element.GetCurrentPropertyValueEx(30077, true, out value));
            cancellation.ThrowIfCancellationRequested(); return value is bool modal ? modal : null;
        }
        catch (OperationCanceledException) { throw; }
        catch { return null; }
        finally { Release(value); Release(available); Release(element); Release(automationObject); }
    }
    private static void Release(object? value) { if (value != null && Marshal.IsComObject(value)) _ = Marshal.ReleaseComObject(value); }
}
