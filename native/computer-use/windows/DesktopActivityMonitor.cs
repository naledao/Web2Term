using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.WindowInterop;

namespace Web2Term.WindowsHelper;

/** Hooks run on their own message thread. Never wait for UIA, the pipe, or SendInput inside a hook. */
internal sealed class DesktopActivityMonitor : IDisposable
{
    private sealed class Watch(string id, long epoch) { internal readonly string Id = id; internal readonly long Epoch = epoch; internal string? Interruption; }
    /** kind, input category (null for focus/monitor events), watch id, epoch. */
    private readonly Action<string, string?, string, long> changed;
    /** Web2Term's main process: it owns every top-level window of the control plane. */
    private readonly uint controlPid;
    private readonly ManualResetEventSlim ready = new();
    private readonly HookCallback keyboard, mouse;
    private readonly WinEventCallback foreground;
    private readonly Thread thread;
    private Watch? watch;
    private Watch? interrupted;
    private uint threadId;
    private int available, disposed, focusPending;
    internal bool Available => Volatile.Read(ref available) != 0 && Volatile.Read(ref disposed) == 0;
    internal DesktopActivityMonitor(Action<string, string?, string, long> changed, uint controlPid)
    {
        this.changed = changed;
        this.controlPid = controlPid;
        keyboard = (code, message, data) => Input(code, message, data, true);
        mouse = (code, message, data) => Input(code, message, data, false);
        foreground = (_, _, _, _, _, _, _) => FocusChanged();
        thread = new(Run) { IsBackground = true, Name = "Web2Term desktop input attribution" };
        thread.Start(); _ = ready.Wait(TimeSpan.FromSeconds(1));
    }
    internal void SetWatch(string? id, long epoch) => Volatile.Write(ref watch, id == null ? null : new Watch(id, epoch));
    internal bool CanDispatch(string? id, long epoch) => Available && Volatile.Read(ref watch) is { } current &&
        current.Id == id && current.Epoch == epoch && Volatile.Read(ref current.Interruption) == null;
    internal string? InterruptionFor(string? id, long epoch) => Volatile.Read(ref interrupted) is { } current && current.Id == id && current.Epoch == epoch ? current.Interruption : null;
    private IntPtr Input(int code, UIntPtr message, IntPtr data, bool isKeyboard)
    {
        if (code >= 0 && Volatile.Read(ref watch) is { } current)
        {
            uint flags; ulong extra; ClickInterop.Point point = default;
            if (isKeyboard) { KeyboardEvent e = Marshal.PtrToStructure<KeyboardEvent>(data); flags = e.Flags; extra = e.Extra.ToUInt64(); }
            else { MouseEvent e = Marshal.PtrToStructure<MouseEvent>(data); flags = e.Flags; extra = e.Extra.ToUInt64(); point = e.Point; }
            uint kindMessage = (uint)message.ToUInt64();
            string? kind = DesktopActivityPolicy.Classify(isKeyboard, kindMessage, flags, extra, ClickInterop.Marker.ToUInt64());
            if (kind != null && DesktopActivityPolicy.OnControlPlane(TargetPid(isKeyboard, point), controlPid)) kind = null;
            if (kind != null && Interlocked.CompareExchange(ref current.Interruption, kind, null) == null)
            {
                // Only a lock-free latch here: SendInput may itself be waiting for this hook to return.
                HelperInputState.RequestStop();
                Volatile.Write(ref interrupted, current);
                string input = DesktopActivityPolicy.InputCategory(isKeyboard, kindMessage);
                ThreadPool.QueueUserWorkItem(_ => Publish(kind, input, current));
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, message, data); // Never swallow the user's input.
    }
    private void FocusChanged()
    {
        Watch? current = Volatile.Read(ref watch);
        if (current == null || Interlocked.Exchange(ref focusPending, 1) != 0) return;
        ThreadPool.QueueUserWorkItem(_ => { Interlocked.Exchange(ref focusPending, 0); Publish("focus-changed", null, current); });
    }
    /*
     * Keys go to the foreground window; a click or wheel goes to the window under the pointer.
     * None of these calls waits on another thread: WindowFromPoint sends WM_NCHITTEST only to the
     * calling thread's own windows, and this hook thread owns none. The hook thread is per-monitor
     * DPI aware like the process, so the hook's physical point needs no conversion.
     */
    private static uint TargetPid(bool isKeyboard, ClickInterop.Point point)
    {
        IntPtr window = isKeyboard ? ClickInterop.GetForegroundWindow() : ClickInterop.WindowFromPoint(point);
        if (window == IntPtr.Zero) return 0;
        IntPtr root = GetAncestor(window, 2); // GA_ROOT: an Electron child surface may belong to the GPU process.
        _ = ApplicationInterop.GetWindowThreadProcessId(root == IntPtr.Zero ? window : root, out uint pid);
        return pid;
    }
    private void Publish(string kind, string? input, Watch current)
    {
        if (Volatile.Read(ref disposed) != 0) return;
        try { changed(kind, input, current.Id, current.Epoch); }
        catch { HelperInputState.RequestStop(); Environment.Exit(8); }
    }
    private void Run()
    {
        IntPtr keys = IntPtr.Zero, pointer = IntPtr.Zero, focus = IntPtr.Zero;
        try
        {
            threadId = GetCurrentThreadId(); _ = PeekMessage(out _, IntPtr.Zero, 0, 0, 0);
            IntPtr module = GetModuleHandle(null);
            keys = SetWindowsHookEx(13, keyboard, module, 0); pointer = SetWindowsHookEx(14, mouse, module, 0);
            focus = SetWinEventHook(3, 3, IntPtr.Zero, foreground, 0, 0, 0);
            Volatile.Write(ref available, keys != IntPtr.Zero && pointer != IntPtr.Zero && focus != IntPtr.Zero ? 1 : 0);
            ready.Set();
            if (!Available) return;
            while (GetMessage(out Message message, IntPtr.Zero, 0, 0) > 0) { _ = TranslateMessage(message); _ = DispatchMessage(message); }
        }
        catch { /* Report unavailable monitoring; discovery remains usable, never unmonitored input. */ }
        finally
        {
            Volatile.Write(ref available, 0); ready.Set();
            Watch? current = Volatile.Read(ref watch);
            if (Volatile.Read(ref disposed) == 0 && current != null && Interlocked.CompareExchange(ref current.Interruption, "monitor-unavailable", null) == null)
            {
                HelperInputState.RequestStop(); Volatile.Write(ref interrupted, current);
                ThreadPool.QueueUserWorkItem(_ => Publish("monitor-unavailable", null, current));
            }
            if (keys != IntPtr.Zero) _ = UnhookWindowsHookEx(keys);
            if (pointer != IntPtr.Zero) _ = UnhookWindowsHookEx(pointer);
            if (focus != IntPtr.Zero) _ = UnhookWinEvent(focus);
        }
    }
    public void Dispose() { Interlocked.Exchange(ref disposed, 1); SetWatch(null, 0); _ = PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero); _ = thread.Join(500); }
    private delegate IntPtr HookCallback(int code, UIntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardEvent { internal uint Key, Scan, Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseEvent { internal ClickInterop.Point Point; internal uint Data, Flags, Time; internal UIntPtr Extra; }
    [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int kind, HookCallback callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, UIntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? module);
}
