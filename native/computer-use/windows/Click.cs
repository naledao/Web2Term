using System.Text.Json;
using System.Text.Json.Serialization;

namespace Web2Term.WindowsHelper;

internal sealed record ClickOptions(string Button = "left", int Count = 1, string Method = "auto");
internal interface IPreparedControlClick : IDisposable { int Invoke(); }
internal interface IControlClickSession
{
    IPreparedControlClick? PrepareClick(IControlNode node, string pattern);
    bool AncestorsMatch(IControlNode node, string[] expectedKeys);
    bool AtPoint(IControlNode node, CoordinatePoint point);
}
internal sealed record MouseMoveResult(int Accepted, bool Arrived);
internal interface IClickBackend
{
    bool Guard(WindowSelection window, CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation);
    MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation);
    int Buttons(WindowSelection window, DesktopPointResolution point, string button, int count, CancellationToken cancellation);
    int Release(string button);
}
internal sealed record ClickReceipt(string request_id, string observation_id, string source_step_id, string? window_id,
    string button, int click_count, string requested_method, string method, bool move_attempted, int? move_accepted,
    bool click_attempted, bool click_completed, int button_events_requested, int? button_events_accepted,
    bool release_required, bool release_attempted, int? release_accepted, CoordinatePoint? point, string before_at, string completed_at,
    bool goal_verified = false, bool input_ready = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ObservationValidation? validation = null);

/** All decisions are based on the current observation; no input retry or fallback after a mutating call starts. */
internal sealed class ClickService(ObservationRegistry observations, ControlTreeService controls, IClickBackend backend, Func<DateTime>? clock = null)
{
    private readonly HashSet<string> consumed = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    private bool Claim(ObservationProvenance owner, string request)
    {
        string key = owner.Scope + ":" + request;
        if (!consumed.Add(key)) return false;
        order.Enqueue(key); if (order.Count > 512) consumed.Remove(order.Dequeue());
        return true;
    }
    internal static string? Pattern(ControlRow row) => row.role == "check_box" && row.patterns.Contains("toggle") ? "toggle"
        : row.role is "radio_button" or "list_item" or "tab_item" or "tree_item" or "data_item" && row.patterns.Contains("selection_item") ? "select"
        : row.role is "button" or "hyperlink" or "menu_item" or "split_button" && row.patterns.Contains("invoke") ? "invoke" : null;
    internal static CoordinatePoint? ControlPoint(ControlBox box, CaptureSource source)
    {
        if (!box.Valid) return null;
        var candidates = source.Monitors.Select(m => {
            double left = Math.Max(box.x, Math.Max(source.Bounds.x, m.bounds.x)), top = Math.Max(box.y, Math.Max(source.Bounds.y, m.bounds.y));
            double right = Math.Min(box.x + box.width, Math.Min((long)source.Bounds.x + source.Bounds.width, (long)m.bounds.x + m.bounds.width));
            double bottom = Math.Min(box.y + box.height, Math.Min((long)source.Bounds.y + source.Bounds.height, (long)m.bounds.y + m.bounds.height));
            int x0 = (int)Math.Ceiling(left), y0 = (int)Math.Ceiling(top), x1 = (int)Math.Ceiling(right) - 1, y1 = (int)Math.Ceiling(bottom) - 1;
            return (Area: x1 >= x0 && y1 >= y0 ? ((long)x1 - x0 + 1) * ((long)y1 - y0 + 1) : 0, X: x0 + (x1 - x0) / 2, Y: y0 + (y1 - y0) / 2, Id: m.monitor_id);
        }).Where(p => p.Area > 0).OrderByDescending(p => p.Area).ThenBy(p => p.Id, StringComparer.Ordinal).ToArray();
        return candidates.Length > 0 ? new(candidates[0].X, candidates[0].Y) : null;
    }
    internal ActionResult Click(ObservationProvenance owner, ObservationLocator locator, ClickOptions options, string requestId, CancellationToken cancellation)
    {
        DateTime before = Now;
        RegisteredClickTarget? target = observations.ClickTarget(owner, locator.ObservationId);
        string execution = "not_executed", method = "none";
        bool moveAttempted = false, clickAttempted = false, completed = false, releaseRequired = false, releaseAttempted = false;
        int? moveAccepted = null, accepted = null, released = null; int requested = 0;
        CoordinatePoint? point = null; ObservationValidation? validation = null;
        ActionResult Fail(string code, string message) => new(false, execution, code, message);
        ActionResult? StateGate() {
            validation = observations.ValidateState(owner, locator, cancellation);
            return validation.valid ? null : Fail("stale_observation", "窗口、布局、焦点或观察已变化，未继续点击。");
        }
        void Cleanup() {
            if (!releaseRequired || releaseAttempted) return;
            releaseAttempted = true;
            try { released = backend.Release(options.Button); } catch { released = null; }
        }
        ActionResult Mouse(WindowSelection window, Func<bool> controlCurrent)
        {
            method = "mouse";
            DesktopPointResolution? mapped = point == null || target == null ? null : CoordinateMapper.ResolvePhysical(target.Source, point);
            if (mapped == null || !backend.Guard(window, mapped.Desktop, false, cancellation) || !controlCurrent()) return Fail("click_blocked", "落点不可见、被遮挡、输入状态占用或不属于目标，未点击。");
            if (!Claim(owner, requestId)) return Fail("click_blocked", "本步骤已经派发过输入，拒绝重复点击。");
            cancellation.ThrowIfCancellationRequested();
            moveAttempted = true; execution = "unknown";
            MouseMoveResult moved = backend.Move(mapped, cancellation); moveAccepted = moved.Accepted;
            execution = moved.Accepted == 0 ? "not_executed" : moved.Accepted == 1 ? "executed" : "unknown";
            if (moved.Accepted != 1 || !moved.Arrived) return Fail("click_failed", "鼠标移动未确认到达；没有派发按钮事件，不自动重试。");
            cancellation.ThrowIfCancellationRequested();
            ActionResult? changed;
            if (locator.ElementId == null) { validation = observations.Validate(owner, locator, cancellation); changed = validation.valid ? null : Fail("stale_observation", "鼠标移动后观察变化，原点击未派发。"); }
            else changed = StateGate();
            if (changed != null) return changed;
            if (!controlCurrent() || !backend.Guard(window, mapped.Desktop, true, cancellation)) return Fail("click_blocked", "移动后焦点、控件或实际落点不匹配，未派发按钮事件。");
            cancellation.ThrowIfCancellationRequested();
            requested = options.Count * 2; clickAttempted = true; execution = "unknown";
            try { accepted = backend.Buttons(window, mapped, options.Button, options.Count, cancellation); }
            finally {
                // The balanced sequence is inserted serially. An accepted prefix ending in our down needs one up, never another down.
                releaseRequired = accepted == null || accepted > 0 && accepted < requested && accepted % 2 == 1;
                Cleanup();
            }
            completed = accepted == requested && !releaseRequired;
            execution = completed || accepted == 0 ? "executed" : "unknown"; // Movement already occurred even when no button event was accepted.
            return completed ? new(true, execution, "ok", "按钮事件已完整插入输入流；应用是否响应及业务目标须核对新观察。")
                : Fail("click_failed", "按钮事件未完整确认；已记录接收数量及必要释放，不补点、不切换输入路径。");
        }
        ActionResult Dispatch(ImagePointResolution? imagePoint)
        {
            if (target?.Source.Window is not WindowSelection window) return Fail("click_blocked", "点击需要已发现并观察的业务窗口。");
            if (locator.ElementId == null) { point = imagePoint?.desktop; return Mouse(window, () => true); }
            if (target.Tree == null) return Fail("stale_observation", "本次观察没有可重新解析的控件。");
            return controls.WithCurrentControl(window.ScopeId, window.WindowId, target.Tree, locator.ElementId, (session, node, row, ancestors) => {
                var clickable = (IControlClickSession)session;
                point = row.bounds == null ? null : ControlPoint(row.bounds, target.Source);
                bool Current() => point != null && (window.Menu != null ? session is IControlPointerSession pointer && pointer.PointerTargetCurrent(node, row, ancestors, point)
                    : ControlTreeService.MatchesRaw(row, session.Read(node)) && clickable.AncestorsMatch(node, ancestors) && clickable.AtPoint(node, point));
                if (point == null || !Current() || !backend.Guard(window, point, false, cancellation)) return Fail("click_blocked", "控件不具备可见且归属一致的实际落点，未点击。");
                bool menuBackground = window.Menu != null && window.Menu.Popup.Handle == window.Menu.Anchor.Window.Handle && row.role != "menu_item";
                string? pattern = !menuBackground && options.Button == "left" && options.Count == 1 && options.Method == "auto" ? Pattern(row) : null;
                using IPreparedControlClick? prepared = pattern == null ? null : clickable.PrepareClick(node, pattern);
                if (prepared == null) return Mouse(window, Current); // Read-only preparation found no applicable pattern; no mutation has started.
                ActionResult? changed = StateGate(); if (changed != null) return changed;
                if (!Current() || !backend.Guard(window, point, false, cancellation)) return Fail("click_blocked", "语义调用前目标发生变化，未点击。");
                if (!Claim(owner, requestId)) return Fail("click_blocked", "本步骤已经派发过输入，拒绝重复调用。");
                cancellation.ThrowIfCancellationRequested(); method = "uia_" + pattern; clickAttempted = true; execution = "unknown";
                int result = prepared.Invoke(); completed = result >= 0;
                if (completed) execution = "executed";
                return completed ? new(true, execution, "ok", "已调用一次控件语义操作；业务结果须核对新观察。") : Fail("click_failed", "控件调用失败或结果不确定，未回退鼠标或再次调用。");
            }, cancellation);
        }
        ActionResult output;
        try {
            if (options.Button is not ("left" or "right" or "middle") || options.Count is < 1 or > 2 || options.Method is not ("auto" or "mouse")) output = Fail("invalid_parameters", "点击参数不符合约定。");
            else output = observations.WithCurrentObservation(owner, locator with { Purpose = "pointer" }, Dispatch, cancellation);
            if (output.Data is ObservationValidation check) validation = check;
        }
        catch (OperationCanceledException) { output = Fail("cancelled", "点击流程已取消；已派发输入不会回滚或重试。"); }
        catch { output = Fail(moveAttempted || clickAttempted ? "click_failed" : "stale_observation", "点击执行或目标核对异常，未自动重放。"); }
        finally { Cleanup(); }
        if (clickAttempted && !completed && output.Code == "stale_observation") output = Fail("click_failed", "调用已开始但结果不确定，必须先核对后状态，不补点。");
        ClickReceipt receipt = new(requestId, locator.ObservationId, owner.Step, target?.Source.Window?.WindowId, options.Button, options.Count, options.Method, method,
            moveAttempted, moveAccepted, clickAttempted, completed, requested, accepted, releaseRequired, releaseAttempted, released, point, before.ToString("O"), Now.ToString("O"), validation: validation?.valid == false ? validation : null);
        return output with { Execution = execution, Data = receipt };
    }
}

internal sealed class ClickAction(ClickService clicks) : IWindowsAction
{
    public string Name => "click";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        try {
            string[] fields = [.. ObservationBindingProtocol.Fields, "request_id", "request_token_digest", "observation_id", "element_id", "x", "y", "button", "click_count", "method"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != fields.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != fields.Length || p.EnumerateObject().Any(v => !fields.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            ObservationProvenance owner = ObservationBindingProtocol.Provenance(p);
            string request = p.GetProperty("request_id").GetString()!, digest = p.GetProperty("request_token_digest").GetString()!;
            if (!Guid.TryParseExact(request, "D", out _) || digest.Length != 64 || digest.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9'))) return ObservationBindingProtocol.Invalid();
            string observation = p.GetProperty("observation_id").GetString()!, button = p.GetProperty("button").GetString()!, method = p.GetProperty("method").GetString()!;
            string? element = p.GetProperty("element_id").GetString();
            int? x = p.GetProperty("x").ValueKind == JsonValueKind.Null ? null : p.GetProperty("x").GetInt32(), y = p.GetProperty("y").ValueKind == JsonValueKind.Null ? null : p.GetProperty("y").GetInt32();
            int count = p.GetProperty("click_count").GetInt32();
            if (!ObservationBindingProtocol.Id(observation, "obs_") || element != null && !ObservationBindingProtocol.Id(element, "el_") ||
                element == null && (x == null || y == null) || element != null && (x != null || y != null) || x is < 0 or > 2559 || y is < 0 or > 2559 ||
                button is not ("left" or "right" or "middle") || count is < 1 or > 2 || method is not ("auto" or "mouse")) return ObservationBindingProtocol.Invalid();
            return clicks.Click(owner, new(observation, element, x, y, "pointer"), new(button, count, method), request, cancellation);
        }
        catch { return ObservationBindingProtocol.Invalid(); }
    }
}
