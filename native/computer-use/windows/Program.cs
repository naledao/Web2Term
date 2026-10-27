using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess || args.Length != 2 || args[0] != "--parent-pid" ||
            !int.TryParse(args[1], out int parentPid) || parentPid <= 0 || parentPid == Environment.ProcessId) return 2;
        AppDomain.CurrentDomain.ProcessExit += (_, _) => HelperInputState.StopAndRelease();
        try
        {
            using Process parent = Process.GetProcessById(parentPid);
            // Acquiring the process handle before waiting avoids following a reused PID later.
            _ = parent.Handle;
            _ = ExitWithParent(parent);
            using CancellationTokenSource startup = new(TimeSpan.FromSeconds(5));
            using HelperHost host = new(parentPid);
            await host.RunAsync(startup.Token);
            return 0;
        }
        catch
        {
            // Metadata only: no exception text, parameters, paths, titles, or input contents.
            await Console.Error.WriteLineAsync("windows_helper_transport_failed");
            return 3;
        }
    }

    private static async Task ExitWithParent(Process parent)
    {
        try { await parent.WaitForExitAsync(); }
        finally { HelperInputState.StopAndRelease(); Environment.Exit(0); }
    }
}

internal sealed class HelperHost : IDisposable
{
    private readonly int parentPid;
    private readonly ProtocolWriter writer = new(Console.OpenStandardOutput());
    private readonly MtaWorker worker;
    private readonly object actionGate = new();
    private MtaWorker.Job? active;
    private Timer? deadline;
    private readonly WindowLifetimeMonitor windowLifetimes;
    private readonly DesktopActivityMonitor desktopActivity;

    internal HelperHost(int parentPid)
    {
        this.parentPid = parentPid;
        ApplicationCatalog applications = new(new WindowsApplicationDiscovery(), ExecutableVerifier.Verify);
        using Process parent = Process.GetProcessById(parentPid);
        WindowsAppLaunchDispatcher dispatcher = new(parent.MainModule?.FileName);
        WindowsAppWindowProbe probe = new();
        ApplicationLaunchService launcher = new(dispatcher, probe);
        ResourceOpenService opener = new(dispatcher, probe);
        windowLifetimes = new();
        ControlPlaneWindowPolicy controlWindows = new((uint)parentPid, (uint)Environment.ProcessId,
            parent.MainModule?.FileName ?? throw new InvalidDataException(), Environment.ProcessPath ?? throw new InvalidDataException());
        ControlPlaneWindowDiscovery windowDiscovery = new(new WindowsWindowDiscovery(windowLifetimes), controlWindows);
        WindowCatalog windows = new(windowDiscovery, interactions: new WindowsInteractionBackend(windowDiscovery));
        WindowFocusService focus = new(windows, new WindowsWindowFocusBackend(windows));
        WindowsObservationBackend imageBackend = new(windows);
        ObservationService observer = new(imageBackend, WindowsObservationBackend.Write);
        WindowsControlTreeBackend controlBackend = new();
        ControlTreeService controls = new(windows, controlBackend);
        ObservationRegistry observations = new(new WindowsObservationStateBackend(imageBackend, windowLifetimes, controlBackend, windows), imageBackend, controls);
        WindowsClickBackend clickBackend = new(windows, parentPid);
        ClickService clicks = new(observations, controls, clickBackend, desktop: clickBackend);
        TypeTextService texts = new(observations, controls, new WindowsTextInputBackend(windows, parentPid));
        PressKeyService keys = new(observations, controls, new WindowsPressKeyBackend(windows, parentPid));
        ScrollService scrolls = new(observations, controls, new WindowsScrollBackend(windows, parentPid));
        DragService drags = new(observations, new WindowsDragBackend(windows, parentPid, imageBackend));
        WaitProbeService waits = new(windows, windowDiscovery, controls, parentPid, (selected, token) => windowLifetimes.ObservationRevision(selected == null ? IntPtr.Zero :
            (IntPtr)long.Parse(selected.Window.Handle.AsSpan(2), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture), token));
        worker = new MtaWorker([new ListAppsAction(applications), new ObservationInvalidatingAction(new LaunchAppAction(applications, launcher), observations),
            new ObservationInvalidatingAction(new OpenResourceAction(applications, opener, WindowsResourceVerifier.Verify), observations), new ListWindowsAction(windows), new InspectInteractionsAction(windows, parentPid),
            new ObservationInvalidatingAction(new FocusWindowAction(focus), observations), new BoundObserveAction(new ObserveAction(observer, controls), observations),
            new ValidateObservationAction(observations), new ClickAction(clicks), new TypeTextAction(texts), new PressKeyAction(keys), new ScrollAction(scrolls), new DragAction(drags), new WaitForAction(waits)], Complete);
        desktopActivity = new(DesktopActivity, (uint)parentPid);
    }

    internal async Task RunAsync(CancellationToken startup)
    {
        using Stream input = new BufferedStream(Console.OpenStandardInput(), 8192);
        using JsonDocument? hello = await Protocol.ReadAsync(input, startup);
        if (hello == null) return;
        JsonElement first = hello.RootElement;
        Protocol.Fields(first, "type", "version", "id", "nonce", "parent_pid");
        if (first.GetProperty("type").GetString() != "hello" || first.GetProperty("parent_pid").GetInt32() != parentPid) throw new InvalidDataException();
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        bool elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        await writer.SendAsync(new { type = "ready", version = Protocol.Version, id = Protocol.Id(first), nonce = Protocol.Id(first, "nonce"),
            pid = Environment.ProcessId, arch = "x64", apartment = "MTA", elevated,
            actions = worker.Actions.Where(action => !DesktopWrite(action) || desktopActivity.Available).ToArray() });
        while (true)
        {
            using JsonDocument? frame = await Protocol.ReadAsync(input, CancellationToken.None);
            if (frame == null) { CancelAll(); return; } // EOF never waits behind UIA.
            JsonElement value = frame.RootElement;
            string type = value.GetProperty("type").GetString() ?? "";
            string id = Protocol.Id(value);
            switch (type)
            {
                case "ping":
                    Protocol.Fields(value, "type", "version", "id");
                    await writer.SendAsync(new { type = "pong", version = Protocol.Version, id });
                    break;
                case "shutdown":
                    Protocol.Fields(value, "type", "version", "id");
                    CancelAll();
                    return;
                case "emergency_stop":
                    Protocol.Fields(value, "type", "version", "id", "epoch");
                    long stopEpoch = Epoch(value);
                    var release = HelperInputState.StopAndRelease();
                    CancelAll();
                    await writer.SendAsync(new { type = "emergency_stopped", version = Protocol.Version, id, epoch = stopEpoch,
                        attempted = release.Attempted, released = release.Released, remaining = release.Remaining });
                    return;
                case "cancel":
                    Protocol.Fields(value, "type", "version", "id", "epoch");
                    long cancelEpoch = Epoch(value);
                    lock (actionGate)
                    {
                        if (active?.Id == id && active.Epoch == cancelEpoch) { HelperInputState.StopAndRelease(); _ = active.Cancellation.CancelAsync(); }
                    }
                    await writer.SendAsync(new { type = "cancelled", version = Protocol.Version, id, epoch = cancelEpoch });
                    break;
                case "watch_desktop":
                    Protocol.Fields(value, "type", "version", "id", "epoch", "watch_id");
                    desktopActivity.SetWatch(value.GetProperty("watch_id").ValueKind == JsonValueKind.Null ? null : Protocol.Id(value, "watch_id"), Epoch(value));
                    break;
                case "request":
                    Protocol.Fields(value, "type", "version", "id", "epoch", "action", "parameters", "timeout_ms", "watch_id");
                    await RequestAsync(value, id);
                    break;
                default: throw new InvalidDataException();
            }
        }
    }

    private static long Epoch(JsonElement value)
    {
        long epoch = value.GetProperty("epoch").GetInt64();
        if (epoch < 1 || epoch > 9_007_199_254_740_991) throw new InvalidDataException();
        return epoch;
    }

    private async Task RequestAsync(JsonElement value, string id)
    {
        long epoch = Epoch(value);
        string action = value.GetProperty("action").GetString() ?? "";
        string? watchId = value.GetProperty("watch_id").ValueKind == JsonValueKind.Null ? null : Protocol.Id(value, "watch_id");
        JsonElement parameters = value.GetProperty("parameters");
        int timeout = value.GetProperty("timeout_ms").GetInt32();
        if (parameters.ValueKind != JsonValueKind.Object || timeout < 100 || timeout > 120_000 ||
            action.Length is < 1 or > 64 || action.Any(character => !(character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_')))
            throw new InvalidDataException();
        if (!worker.TryAction(action, out IWindowsAction? handler) || handler == null)
        {
            await ResultAsync(id, epoch, new(false, "not_executed", "unknown_action", "此 helper 未注册该动作。"));
            return;
        }
        if (DesktopWrite(action) && !desktopActivity.CanDispatch(watchId, epoch))
        {
            await ResultAsync(id, epoch, new(false, "not_executed", "input_monitor_unavailable", "桌面接管监测未就绪或已中断，请重新核对桌面状态后再操作。"));
            return;
        }
        MtaWorker.Job job = new(id, epoch, handler, parameters.Clone(), new CancellationTokenSource(), watchId);
        bool accepted;
        lock (actionGate)
        {
            accepted = active == null;
            if (accepted)
            {
                active = job;
                // Last-resort watchdog is independent of the MTA and pipe reader.
                deadline = new Timer(_ => { HelperInputState.StopAndRelease(); Environment.Exit(7); }, null, timeout + 1500, Timeout.Infinite);
                accepted = worker.Enqueue(job);
                if (!accepted) { active = null; deadline.Dispose(); deadline = null; }
            }
        }
        if (!accepted)
        {
            job.Cancellation.Dispose();
            await ResultAsync(id, epoch, new(false, "not_executed", "busy", "helper 正在处理其他请求。"));
        }
    }

    private void Complete(MtaWorker.Job job, ActionResult result)
    {
        string? interruption = desktopActivity.InterruptionFor(job.DesktopWatch, job.Epoch);
        if (interruption != null) result = result with { Ok = false, Code = interruption is "human-input" or "human-stop" ? "human_takeover" : interruption == "monitor-unavailable" ? "input_monitor_unavailable" : "external_input",
            Message = interruption is "human-input" or "human-stop" ? "检测到真实人工输入，已暂停自动控制；保留实际执行事实，等待用户明确继续。" : interruption == "monitor-unavailable" ? "桌面接管监测已不可用，已停止本轮控制；需重新核对状态。" : "检测到其他来源的注入输入，已停止本轮控制；请重新观察实际界面后自主决定下一步。" };
        lock (actionGate)
        {
            if (active != job) return;
            active = null;
            deadline?.Dispose(); deadline = null;
            job.Cancellation.Dispose();
        }
        // A subsequent job may queue now, but the sole MTA cannot execute it before this write.
        ResultAsync(job.Id, job.Epoch, result).GetAwaiter().GetResult();
    }

    private Task ResultAsync(string id, long epoch, ActionResult result) => writer.SendAsync(new {
        type = "result", version = Protocol.Version, id, epoch, ok = result.Ok, execution = result.Execution,
        code = result.Code, message = result.Message, data = result.Data
    });

    private static bool DesktopWrite(string action) => action is "click" or "type_text" or "press_key" or "scroll" or "drag" or "focus_window" or "launch_app" or "open";

    private void DesktopActivity(string kind, string? input, string watchId, long epoch)
    {
        if (kind is not ("focus-changed" or "escape-pressed"))
        {
            HelperInputState.StopAndRelease();
            lock (actionGate) { if (active != null) _ = active.Cancellation.CancelAsync(); }
        }
        writer.SendAsync(new { type = "desktop_activity", version = Protocol.Version, epoch, watch_id = watchId, kind, input }).GetAwaiter().GetResult();
    }

    private void CancelAll()
    {
        HelperInputState.StopAndRelease();
        lock (actionGate) { if (active != null) _ = active.Cancellation.CancelAsync(); }
    }

    public void Dispose() { CancelAll(); desktopActivity.Dispose(); windowLifetimes.Dispose(); deadline?.Dispose(); }
}
