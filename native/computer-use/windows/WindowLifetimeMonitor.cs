using System.Collections.Concurrent;
using static Web2Term.WindowsHelper.WindowInterop;

namespace Web2Term.WindowsHelper;

/** Out-of-context OS notifications only: no injection, SetProp, subclassing, or changes to another application's windows. */
internal sealed class WindowLifetimeMonitor : IDisposable
{
    private const uint BarrierMessage = 0x8000 + 37;
    private readonly object gate = new();
    private readonly Dictionary<IntPtr, long> changes = [];
    private readonly Dictionary<IntPtr, long> observationChanges = [];
    private readonly ConcurrentDictionary<long, TaskCompletionSource<bool>> barriers = new();
    private readonly ManualResetEventSlim ready = new();
    private readonly WinEventCallback callback;
    private readonly Thread thread;
    private uint threadId;
    private long sequence, epoch = 1, barrierId, observationSequence, observationEpoch = 1, focusRevision;
    private bool observationsAvailable;
    private bool available, disposed;
    internal WindowLifetimeMonitor()
    {
        callback = Changed;
        thread = new(Run) { IsBackground = true, Name = "Web2Term window lifetime events" };
        thread.Start();
        _ = ready.Wait(TimeSpan.FromSeconds(1));
    }
    private void Changed(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint sourceThread, uint time)
    {
        // Lifetime and observation revisions are deliberately independent: a move never impersonates HWND reuse.
        bool lifetime = eventType is 0x8000 or 0x8001 && window != IntPtr.Zero && objectId == 0 && childId == 0;
        bool system = eventType is >= 0x0003 and <= 0x0017;
        bool layout = eventType is 0x8000 or 0x8001 or 0x8002 or 0x8003 or 0x8004 or 0x8005 or 0x800A or 0x800B;
        if (!lifetime && !system && !layout) return;
        IntPtr root = window == IntPtr.Zero ? IntPtr.Zero : GetAncestor(window, 2);
        if (root == IntPtr.Zero) root = window;
        lock (gate)
        {
            if (lifetime) {
                if (changes.Count >= 8192) { changes.Clear(); epoch++; }
                changes[window] = ++sequence;
            }
            // A hidden/background composer may change its document focus during result delivery. Only foreground
            // object focus affects every observation; background changes still update that window's own revision.
            if (system || eventType == 0x8005 && root != IntPtr.Zero && root == ApplicationLaunchInterop.GetForegroundWindow()) focusRevision++;
            if (observationChanges.Count >= 8192) { observationChanges.Clear(); observationEpoch++; }
            observationChanges[root] = ++observationSequence;
        }
    }
    internal string? ObservationRevision(IntPtr window, CancellationToken cancellation)
    {
        if (!Synchronize(cancellation)) return null;
        lock (gate) return observationsAvailable && !disposed ? observationEpoch + ":" + focusRevision + ":" +
            (window == IntPtr.Zero ? observationSequence : observationChanges.GetValueOrDefault(window)) : null;
    }
    internal string? Lifetime(IntPtr window)
    {
        lock (gate) return available && !disposed ? epoch + ":" + (changes.TryGetValue(window, out long version) ? version : 0) : null;
    }
    internal bool Synchronize(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate) if (!available || disposed) return false;
        long id = Interlocked.Increment(ref barrierId);
        TaskCompletionSource<bool> done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        barriers[id] = done;
        try
        {
            if (!PostThreadMessage(threadId, BarrierMessage, (UIntPtr)(ulong)id, IntPtr.Zero)) return false;
            return done.Task.Wait(300, cancellation) && done.Task.GetAwaiter().GetResult();
        }
        finally { barriers.TryRemove(id, out _); }
    }
    private void Run()
    {
        IntPtr hook = IntPtr.Zero, systemHook = IntPtr.Zero;
        try
        {
            threadId = GetCurrentThreadId();
            _ = PeekMessage(out _, IntPtr.Zero, 0, 0, 0); // Establish the thread queue before publishing readiness.
            hook = SetWinEventHook(0x8000, 0x800B, IntPtr.Zero, callback, 0, 0, 0); // Bounded object event range, OUTOFCONTEXT.
            systemHook = SetWinEventHook(0x0003, 0x0017, IntPtr.Zero, callback, 0, 0, 0);
            bool stopping;
            lock (gate) { stopping = disposed; available = hook != IntPtr.Zero && !stopping; observationsAvailable = available && systemHook != IntPtr.Zero; }
            ready.Set();
            if (hook == IntPtr.Zero || stopping) return;
            while (GetMessage(out Message message, IntPtr.Zero, 0, 0) > 0)
            {
                if (message.Id == BarrierMessage)
                {
                    if (barriers.TryGetValue((long)message.WParam.ToUInt64(), out var done)) done.TrySetResult(true);
                    continue;
                }
                _ = TranslateMessage(message); _ = DispatchMessage(message);
            }
        }
        catch { /* Unavailable monitoring yields metadata-only windows, never fabricated lifetimes. */ }
        finally
        {
            lock (gate) { available = false; observationsAvailable = false; epoch++; changes.Clear(); observationEpoch++; observationChanges.Clear(); }
            if (hook != IntPtr.Zero) _ = UnhookWinEvent(hook);
            if (systemHook != IntPtr.Zero) _ = UnhookWinEvent(systemHook);
            ready.Set();
            foreach (var barrier in barriers.Values) barrier.TrySetResult(false);
        }
    }
    public void Dispose()
    {
        lock (gate) { disposed = true; available = false; epoch++; changes.Clear(); }
        _ = PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero); // WM_QUIT; hook is unregistered on its own thread.
        foreach (var barrier in barriers.Values) barrier.TrySetResult(false);
        _ = thread.Join(500);
    }
}
