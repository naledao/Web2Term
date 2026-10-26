using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal sealed class MtaWorker
{
    internal sealed record Job(string Id, long Epoch, IWindowsAction Action, JsonElement Parameters, CancellationTokenSource Cancellation, string? DesktopWatch = null);
    private readonly BlockingCollection<Job> queue = new(1);
    private readonly IReadOnlyDictionary<string, IWindowsAction> actions;
    private readonly Action<Job, ActionResult> completed;
    private readonly ManualResetEventSlim initialized = new();
    private Exception? initializationError;

    internal MtaWorker(IEnumerable<IWindowsAction> registered, Action<Job, ActionResult> completed)
    {
        actions = registered.ToDictionary(action => action.Name, StringComparer.Ordinal);
        this.completed = completed;
        Thread thread = new(Run) { IsBackground = true, Name = "Web2Term UIA MTA" };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        if (!initialized.Wait(TimeSpan.FromSeconds(2)) || initializationError != null) throw new InvalidOperationException("mta_initialization_failed");
    }

    internal string[] Actions => actions.Keys.ToArray();
    internal bool TryAction(string name, out IWindowsAction? action) => actions.TryGetValue(name, out action);
    internal bool Enqueue(Job job) => queue.TryAdd(job);

    private void Run()
    {
        int result = CoInitializeEx(IntPtr.Zero, 0); // COINIT_MULTITHREADED; all UIA objects stay on this thread.
        if (result < 0) initializationError = new COMException("mta_initialization_failed", result);
        initialized.Set();
        if (initializationError != null) return;
        try
        {
            foreach (Job job in queue.GetConsumingEnumerable())
            {
                ActionResult output;
                bool started = false;
                try
                {
                    job.Cancellation.Token.ThrowIfCancellationRequested();
                    started = true;
                    output = job.Action.Execute(job.Parameters, job.Cancellation.Token);
                }
                catch (OperationCanceledException)
                {
                    output = new(false, started ? "unknown" : "not_executed", "cancelled", "请求已取消；已派发操作需核对实际状态。");
                }
                catch
                {
                    output = new(false, started ? "unknown" : "not_executed", "executor_error", "执行器异常，需重新观察实际状态。");
                }
                try { completed(job, output); }
                catch { Environment.Exit(8); } // A broken result pipe must never leave a native worker running.
            }
        }
        finally { CoUninitialize(); }
    }

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint coInit);
    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();
}
