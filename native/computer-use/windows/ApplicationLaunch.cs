using System.Text.Json;
using System.Diagnostics;

namespace Web2Term.WindowsHelper;

internal sealed record ReturnedProcess(uint pid, string? started_at);
internal sealed record DispatchAttempt(bool Accepted, bool Attempted, string Method, ReturnedProcess? Process = null,
    int? Error = null, string FailureCode = "launch_failed", OpenApplication? Application = null);
internal sealed record OpenApplication(string? executable_path, string? app_user_model_id, string basis);
internal sealed record ObservedAppWindow(string Handle, string Title, bool Visible, bool Minimized, uint Pid, string StartedAt,
    bool Foreground, string? ExecutablePath, string? AppUserModelId)
{
    internal string Identity => Handle + ":" + Pid + ":" + StartedAt;
}
internal sealed record WindowSnapshot(DateTime At, ObservedAppWindow[] Windows, bool Complete);
internal sealed record LaunchCandidate(string hwnd, string title, bool visible, bool minimized, uint pid, string process_started_at,
    bool foreground, string match_basis, string change);
internal sealed record AppLaunchResult(string catalog_id, string app_id, string launch_reference_id, string dispatch_status, string method,
    int? native_error, ReturnedProcess? returned_process, string before_at, string observed_at, bool observation_complete,
    LaunchCandidate[] candidate_windows, bool target_window_confirmed = false, bool goal_verified = false);

internal interface IAppLaunchDispatcher { DispatchAttempt Dispatch(LaunchSelection selection, CancellationToken cancellation); }
internal interface IAppWindowProbe { WindowSnapshot Capture(CancellationToken cancellation); }

/** One explicit launch attempt followed by bounded observation. No fallback, replay, or inferred completion. */
internal sealed class ApplicationLaunchService(IAppLaunchDispatcher dispatcher, IAppWindowProbe probe,
    Action<int, CancellationToken>? wait = null)
{
    private WindowSnapshot Capture(CancellationToken cancellation)
    {
        try { return probe.Capture(cancellation); }
        catch (OperationCanceledException) { throw; }
        catch { return new(DateTime.UtcNow, [], false); }
    }
    internal ActionResult Launch(LaunchSelection selection, int waitMilliseconds, CancellationToken cancellation)
    {
        if (cancellation.IsCancellationRequested) return CancelledBefore();
        WindowSnapshot before;
        try { before = Capture(cancellation); }
        catch (OperationCanceledException) { return CancelledBefore(); }
        if (cancellation.IsCancellationRequested) return CancelledBefore();
        DispatchAttempt attempt;
        try { attempt = dispatcher.Dispatch(selection, cancellation); }
        catch { return new(false, "unknown", "launch_failed", "启动执行器异常，是否生效尚未确认；请先检查实际状态，不要重复启动。"); }
        if (!attempt.Accepted && !attempt.Attempted)
            return new(false, "not_executed", attempt.FailureCode, attempt.FailureCode == "cancelled" ? "启动已取消，本次未派发。"
                : attempt.FailureCode == "stale_catalog" ? "启动引用或实际目标已变化，本次未派发，请重新 list_apps。" : "启动组件不可用，本次未派发。");
        WindowSnapshot after = before;
        bool cancelled = false;
        try
        {
            int remaining = waitMilliseconds;
            Stopwatch elapsed = Stopwatch.StartNew();
            while (true)
            {
                after = Capture(cancellation);
                LaunchCandidate[] candidates = Candidates(selection, attempt, before, after);
                remaining = Math.Min(remaining, Math.Max(0, waitMilliseconds - (int)Math.Min(int.MaxValue, elapsed.ElapsedMilliseconds)));
                if (remaining <= 0 || candidates.Any(candidate => candidate.match_basis != "window_change" && candidate.change is "new" or "changed")) break;
                int delay = Math.Min(remaining, 200);
                if (wait != null) wait(delay, cancellation);
                else if (cancellation.WaitHandle.WaitOne(delay)) cancellation.ThrowIfCancellationRequested();
                remaining -= delay;
            }
        }
        catch (OperationCanceledException) { cancelled = true; }
        LaunchCandidate[] all = Candidates(selection, attempt, before, after);
        AppLaunchResult result = new(selection.CatalogId, selection.AppId, selection.ReferenceId, attempt.Accepted ? "dispatched" : "unknown",
            attempt.Method, attempt.Accepted ? null : attempt.Error, attempt.Process, before.At.ToString("O"), after.At.ToString("O"),
            before.Complete && after.Complete && all.Length <= 12 && !cancelled, all.Take(12).ToArray());
        string execution = attempt.Accepted ? "executed" : "unknown";
        if (!attempt.Accepted) return new(false, execution, "launch_failed", "系统启动接口未确认成功，可能已发生部分效果；已采集候选状态，勿自动换路径或重复启动。", result);
        if (cancelled) return new(false, execution, "cancelled", "启动已派发，后续观察已取消；已发生的启动不会因此撤销。", result);
        return new(true, execution, "ok", "应用启动请求已派发。返回 PID 可能属于代理或复用实例，候选窗口尚未确认为业务目标；请继续核对真实窗口／观察，不能据此认定任务完成。", result);
    }
    private static ActionResult CancelledBefore() => new(false, "not_executed", "cancelled", "启动已取消，本次未派发。");

    internal static LaunchCandidate[] Candidates(LaunchSelection selection, DispatchAttempt attempt, WindowSnapshot before, WindowSnapshot after)
    {
        Dictionary<string, ObservedAppWindow> prior = before.Windows.ToDictionary(window => window.Identity, StringComparer.Ordinal);
        List<LaunchCandidate> result = [];
        string? aumid = selection.Launch.AppUserModelId ?? (selection.Identity.StartsWith("aumid:", StringComparison.Ordinal) ? selection.Identity[6..] : null);
        foreach (ObservedAppWindow window in after.Windows)
        {
            string change = !prior.TryGetValue(window.Identity, out var old) ? before.Complete ? "new" : "unconfirmed"
                : old.Title != window.Title || old.Visible != window.Visible || old.Minimized != window.Minimized || old.Foreground != window.Foreground ? "changed" : "existing";
            string? basis = aumid != null && aumid == window.AppUserModelId ? "app_user_model_id"
                : selection.Launch.Executable != null && string.Equals(selection.Launch.Executable.Path, window.ExecutablePath, StringComparison.OrdinalIgnoreCase) ? "executable_path"
                : attempt.Process?.started_at != null && attempt.Process.pid == window.Pid && attempt.Process.started_at == window.StartedAt ? "returned_pid"
                : before.Complete && change is "new" or "changed" ? "window_change" : null;
            if (basis != null) result.Add(new(window.Handle, window.Title, window.Visible, window.Minimized, window.Pid, window.StartedAt, window.Foreground, basis, change));
        }
        return result.OrderBy(candidate => candidate.match_basis == "window_change" ? 2 : candidate.match_basis == "returned_pid" ? 1 : 0)
            .ThenByDescending(candidate => candidate.change is "new" or "changed").ThenBy(candidate => candidate.hwnd, StringComparer.Ordinal).ToArray();
    }
}

internal sealed class LaunchAppAction(ApplicationCatalog catalog, ApplicationLaunchService launcher) : IWindowsAction
{
    public string Name => "launch_app";
    public ActionResult Execute(JsonElement parameters, CancellationToken cancellation)
    {
        string[] fields = ["catalog_id", "app_id", "launch_reference_id", "wait_ms"];
        if (parameters.ValueKind != JsonValueKind.Object || parameters.EnumerateObject().Count() != fields.Length ||
            parameters.EnumerateObject().Any(property => !fields.Contains(property.Name))) return Invalid();
        foreach (string field in fields.Take(3)) if (parameters.GetProperty(field).ValueKind != JsonValueKind.String) return Invalid();
        JsonElement wait = parameters.GetProperty("wait_ms");
        if (wait.ValueKind != JsonValueKind.Number || !wait.TryGetInt32(out int milliseconds) || milliseconds is < 0 or > 5000) return Invalid();
        if (cancellation.IsCancellationRequested) return new(false, "not_executed", "cancelled", "启动已取消，本次未派发。");
        LaunchSelection? selection = catalog.ResolveLaunch(parameters.GetProperty("catalog_id").GetString()!, parameters.GetProperty("app_id").GetString()!,
            parameters.GetProperty("launch_reference_id").GetString()!);
        return selection == null ? new(false, "not_executed", "stale_catalog", "目录或启动引用已失效，请先重新 list_apps，本次未派发。")
            : launcher.Launch(selection, milliseconds, cancellation);
    }
    private static ActionResult Invalid() => new(false, "not_executed", "invalid_parameters", "launch_app 内部参数无效，本次未派发。");
}
