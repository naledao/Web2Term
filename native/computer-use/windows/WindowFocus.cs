using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Web2Term.WindowsHelper;

internal sealed record FocusCall(bool Attempted, bool? Accepted, string? FailureCode = null);
internal sealed record UiaFocusState(string status, string? root_hwnd = null, bool? has_keyboard_focus = null);
internal sealed record FocusObservation(string? foreground_hwnd, string? active_hwnd, string? focus_hwnd, string? focus_root_hwnd,
    string win32_focus, UiaFocusState uia_focus)
{
    internal static FocusObservation Empty => new(null, null, null, null, "unavailable", new("not_checked"));
}
internal sealed record FocusSample(FocusObservation Observation, string? BlockingWindow = null);
internal sealed record FocusTarget(string hwnd, uint pid, string? process_started_at, uint thread_id, string class_name, string title,
    bool visible, bool minimized, bool foreground, bool enabled, bool? cloaked, string? owner_hwnd)
{
    internal static FocusTarget From(DiscoveredWindow window) => new(window.Handle, window.Pid, window.ProcessStartedAt, window.ThreadId, window.ClassName, window.Title,
        window.Visible, window.Minimized, window.Foreground, window.Enabled, window.Cloaked, window.OwnerHandle);
}
internal sealed record WindowFocusResult(string snapshot_id, string window_id, string status, string before_at, string observed_at,
    FocusCallSummary restore, bool?[] activation_attempts, FocusTarget? target, bool identity_verified, FocusObservation observation,
    string? blocking_window_hwnd, bool focus_confirmed, bool input_ready = false, bool goal_verified = false);
internal sealed record FocusCallSummary(bool attempted, bool? accepted);
internal interface IWindowFocusBackend
{
    FocusCall Restore(WindowSelection target, CancellationToken cancellation);
    FocusCall Activate(WindowSelection target, CancellationToken cancellation);
    FocusSample Observe(WindowSelection target, bool checkUia, CancellationToken cancellation);
}

/** Bounded restoration/activation plus independent evidence. Never issues keyboard/mouse input or an input permission. */
internal sealed class WindowFocusService(WindowCatalog catalog, IWindowFocusBackend backend, Action<int, CancellationToken>? wait = null, Func<DateTime>? clock = null)
{
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Focus(string scope, string id, bool allowRestore, int milliseconds, CancellationToken cancellation)
    {
        if (cancellation.IsCancellationRequested) return new(false, "not_executed", "cancelled", "窗口激活已取消，本次未派发。");
        WindowSelection? initial;
        try { initial = catalog.Resolve(scope, id, cancellation); }
        catch (OperationCanceledException) { return new(false, "not_executed", "cancelled", "窗口激活已取消，本次未派发。"); }
        if (initial == null) return new(false, "not_executed", "stale_window", "窗口引用已失效或身份无法核实，请重新 list_windows，本次未派发。");
        if (initial.Menu != null) return new(false, "not_executed", "window_blocked", "活动菜单不单独激活；请直接 observe 菜单引用后使用 click 或 press_key，以免激活关闭菜单。");
        DateTime before = Now;
        WindowSelection? current = initial;
        FocusCallSummary restored = new(false, null);
        List<bool?> activations = [];
        FocusSample sample = new(FocusObservation.Empty);
        int remaining = milliseconds, uiaChecks = 0;
        FocusObservation? lastUiaFailure = null;
        Stopwatch elapsed = new();
        string? pendingCall = null;

        WindowSelection? Resolve() => current = catalog.Resolve(scope, id, cancellation);
        string Execution() => restored.attempted || activations.Count > 0 ? restored.attempted && restored.accepted == null || activations.Any(value => value == null) ? "unknown" : "executed" : "not_executed";
        ActionResult Finish(string status, string code, string message)
        {
            bool identity = current != null && status is not ("stale" or "unknown" or "cancelled");
            bool focused = status == "focused";
            WindowFocusResult result = new(initial.SnapshotId, id, status, before.ToString("O"), Now.ToString("O"), restored, activations.ToArray(),
                identity ? FocusTarget.From(current!.Window) : null, identity, sample.Observation, sample.BlockingWindow, focused);
            return new(focused, focused ? "executed" : Execution(), code, message, result);
        }
        ActionResult Stale() { current = null; return Finish("stale", "stale_window", "窗口在操作或观察期间失效，未继续激活其他窗口；请重新 list_windows，不要直接输入。"); }
        FocusCall Call(bool restore)
        {
            pendingCall = restore ? "restore" : "activate";
            FocusCall call = restore ? backend.Restore(current!, cancellation) : backend.Activate(current!, cancellation);
            if (restore) restored = new(call.Attempted, call.Attempted ? call.Accepted : null);
            else if (call.Attempted) activations.Add(call.Accepted);
            pendingCall = null;
            return call;
        }
        void MarkUnknownCall()
        {
            if (pendingCall == "restore") restored = new(true, null);
            if (pendingCall == "activate") activations.Add(null);
            pendingCall = null;
        }
        ActionResult? Failure(FocusCall call)
        {
            if (call.FailureCode == "stale_window") return Stale();
            if (call.FailureCode == "cancelled") throw new OperationCanceledException(cancellation);
            if (call.FailureCode is "window_blocked" or "restore_required")
            {
                if (Resolve() == null) return Stale();
                return Finish(call.FailureCode == "window_blocked" ? "blocked" : "restore_required", call.FailureCode,
                    "派发前重新核对发现窗口被阻挡、最小化或隐藏，本次未继续激活；请根据实际状态重新观察。");
            }
            return call.Attempted && call.Accepted == null || call.FailureCode != null
                ? Finish("unknown", call.Attempted ? "executor_error" : "unavailable", "窗口接口的结果未能确认，请先观察实际状态；不会自动重放或向任何窗口输入。") : null;
        }
        bool Focused() => current is { Window: { Visible: true, Minimized: false, Foreground: true, Enabled: true, Cloaked: false } } &&
            sample.Observation.foreground_hwnd == current.Window.Handle && sample.Observation.active_hwnd == current.Window.Handle && sample.Observation.focus_hwnd != null &&
            sample.Observation.focus_root_hwnd == current.Window.Handle && sample.Observation.win32_focus == "confirmed" && sample.Observation.uia_focus.status == "confirmed" &&
            sample.Observation.uia_focus.root_hwnd == current.Window.Handle; // has_keyboard_focus is informational: Win32 focus is already confirmed.
        bool Observe()
        {
            if (Resolve() == null) return false;
            sample = backend.Observe(current!, uiaChecks < 2, cancellation);
            if (sample.Observation.uia_focus.status != "not_checked") uiaChecks++;
            if (sample.Observation.uia_focus.status is "unavailable" or "outside_target") lastUiaFailure = sample.Observation;
            else if (sample.Observation.uia_focus.status == "not_checked" && lastUiaFailure != null && lastUiaFailure.foreground_hwnd == sample.Observation.foreground_hwnd &&
                lastUiaFailure.active_hwnd == sample.Observation.active_hwnd && lastUiaFailure.focus_hwnd == sample.Observation.focus_hwnd && lastUiaFailure.focus_root_hwnd == sample.Observation.focus_root_hwnd)
                sample = sample with { Observation = sample.Observation with { uia_focus = lastUiaFailure.uia_focus } };
            return Resolve() != null;
        }
        void Delay(int maximum)
        {
            remaining = Math.Min(remaining, Math.Max(0, milliseconds - (int)Math.Min(int.MaxValue, elapsed.ElapsedMilliseconds)));
            int delay = Math.Min(remaining, maximum);
            if (delay <= 0) return;
            if (wait != null) wait(delay, cancellation); else if (cancellation.WaitHandle.WaitOne(delay)) cancellation.ThrowIfCancellationRequested();
            remaining -= delay;
        }
        try
        {
            if (!Observe()) return Stale();
            if (Focused()) return Finish("focused", "ok", "目标窗口已处于前台，Win32 与 UIA 焦点已核对；本次无需恢复或再次激活。后续输入仍须重新检查，任务目标尚未验证。");
            if (!current!.Window.Enabled || current.Window.Cloaked == true)
                return Finish("blocked", "window_blocked", "目标窗口被禁用、弹窗阻挡或处于不可见桌面状态；请观察实际窗口及阻挡信息，不会自动改选或输入。");
            if (current.Window.Minimized || !current.Window.Visible)
            {
                if (!allowRestore) return Finish("restore_required", "restore_required", "目标窗口最小化或隐藏，restore=false，本次未恢复或激活。");
                if (Resolve() == null) return Stale();
                ActionResult? failure = Failure(Call(true));
                if (failure != null) return failure;
            }
            elapsed.Start();
            // ShowWindowAsync queues a state change; observe the actual result before activation.
            for (int index = 0; index < 6; index++)
            {
                if (Resolve() == null) return Stale();
                if (current!.Window.Visible && !current.Window.Minimized) break;
                if (remaining <= 0 || elapsed.ElapsedMilliseconds >= Math.Min(milliseconds, 500)) break;
                Delay(100);
            }
            if (Resolve() == null) return Stale();
            if (current!.Window.Visible && !current.Window.Minimized && current.Window.Enabled && current.Window.Cloaked != true)
            {
                ActionResult? failure = Failure(Call(false));
                if (failure != null) return failure;
            }
            for (int index = 0; index < 32; index++)
            {
                if (!Observe()) return Stale();
                if (Focused()) return Finish("focused", "ok", "目标窗口前台、Win32 键盘焦点及 UIA 焦点已核对。此结果仅反映采集时状态，不是后续输入许可，也不表示业务内容或任务完成。");
                if (!current!.Window.Enabled || current.Window.Cloaked == true)
                    return Finish("blocked", "window_blocked", "窗口恢复或激活后出现禁用／遮蔽状态，请继续观察阻挡窗口；本次不改选目标或输入。");
                remaining = Math.Min(remaining, Math.Max(0, milliseconds - (int)Math.Min(int.MaxValue, elapsed.ElapsedMilliseconds)));
                if (remaining <= 0) break;
                if (activations.Count == 1 && sample.Observation.foreground_hwnd != current.Window.Handle && current.Window.Visible && !current.Window.Minimized &&
                    (elapsed.ElapsedMilliseconds >= Math.Min(400, milliseconds / 2) || remaining <= milliseconds / 2))
                {
                    if (Resolve() == null) return Stale();
                    ActionResult? failure = Failure(Call(false));
                    if (failure != null) return failure;
                }
                Delay(100);
            }
            bool foreground = current?.Window.Foreground == true && sample.Observation.foreground_hwnd == current.Window.Handle;
            return Finish(foreground ? "foreground_only" : "denied", foreground ? "focus_unconfirmed" : "focus_denied",
                foreground ? "窗口处于前台，但键盘焦点或 UIA 焦点未完整核实；请继续观察，不能直接输入。" : "有界恢复／激活已结束，目标窗口未确认为前台；Windows 可能拒绝激活，请根据真实状态选择下一步，不向其他窗口输入。");
        }
        catch (OperationCanceledException) { MarkUnknownCall(); return Finish("cancelled", "cancelled", "窗口恢复／激活已取消；已经派发的窗口变化不会撤销，请重新观察后再决定下一步。"); }
        catch { MarkUnknownCall(); return Finish("unknown", "executor_error", "窗口恢复／激活执行器异常，实际效果尚未核实；请先观察，不要直接输入或重放。"); }
    }
}

internal sealed partial class FocusWindowAction(WindowFocusService focus) : IWindowsAction
{
    public string Name => "focus_window";
    [GeneratedRegex(@"^ws_[a-f0-9]{32}$")] private static partial Regex Scope();
    [GeneratedRegex(@"^win_[a-f0-9]{32}$")] private static partial Regex Window();
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        string[] fields = ["scope_id", "window_id", "restore", "wait_ms"];
        if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != fields.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != fields.Length ||
            p.EnumerateObject().Any(v => !fields.Contains(v.Name)) || p.GetProperty("scope_id").ValueKind != JsonValueKind.String || !Scope().IsMatch(p.GetProperty("scope_id").GetString()!) ||
            p.GetProperty("window_id").ValueKind != JsonValueKind.String || !Window().IsMatch(p.GetProperty("window_id").GetString()!) ||
            p.GetProperty("restore").ValueKind is not (JsonValueKind.True or JsonValueKind.False) || p.GetProperty("wait_ms").ValueKind != JsonValueKind.Number ||
            !p.GetProperty("wait_ms").TryGetInt32(out int wait) || wait is < 0 or > 3000)
            return new(false, "not_executed", "invalid_parameters", "窗口激活内部参数不符合约定，本次未派发。");
        return focus.Focus(p.GetProperty("scope_id").GetString()!, p.GetProperty("window_id").GetString()!, p.GetProperty("restore").GetBoolean(), wait, cancellation);
    }
}
