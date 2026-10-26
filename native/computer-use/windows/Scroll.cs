using System.Text.Json;
using System.Text.Json.Serialization;

namespace Web2Term.WindowsHelper;

internal sealed record ScrollOptions(string Direction, int Amount = 3)
{
    internal bool Valid => Direction is "up" or "down" or "left" or "right" && Amount is >= 1 and <= 10;
    internal string Axis => Direction is "left" or "right" ? "horizontal" : "vertical";
    internal int Delta => (Direction is "up" or "right" ? 1 : -1) * Amount * 120;
}
internal static class ScrollRoutingPolicy
{
    internal static string? Select(string axis, uint? mode, bool focusedHit) => axis == "vertical" && mode == 2 ? "mouse_position" : focusedHit ? "focused_hit" : null;
}
internal interface IControlPointerSession { bool PointerTargetCurrent(IControlNode node, ControlRow row, string[] ancestors, CoordinatePoint point); }
internal interface IScrollBackend
{
    bool Guard(WindowSelection window, CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation);
    MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation);
    string? Routing(WindowSelection window, CoordinatePoint point, string axis, CancellationToken cancellation);
    int Wheel(WindowSelection window, DesktopPointResolution point, ScrollOptions options, string routing, CancellationToken cancellation);
}
internal sealed record ScrollReceipt(string request_id, string observation_id, string source_step_id, string? window_id, string? element_id,
    string direction, int amount, string axis, int wheel_delta, bool move_attempted, int? move_accepted, bool scroll_attempted, bool scroll_completed,
    int wheel_events_requested, int? wheel_events_accepted, string? routing, CoordinatePoint? point, string before_at, string completed_at,
    bool scroll_verified = false, bool goal_verified = false, bool input_ready = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ObservationValidation? validation = null);

/** A located, bounded wheel event; cursor movement and wheel delivery are independent facts. Never retries wheel input. */
internal sealed class ScrollService(ObservationRegistry observations, ControlTreeService controls, IScrollBackend backend, Func<DateTime>? clock = null)
{
    private readonly HashSet<string> consumed = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Scroll(ObservationProvenance owner, ObservationLocator locator, ScrollOptions options, string requestId, CancellationToken cancellation)
    {
        DateTime before = Now; RegisteredClickTarget? target = observations.ClickTarget(owner, locator.ObservationId);
        bool moved = false, attempted = false, completed = false; int? moveAccepted = null, accepted = null;
        CoordinatePoint? point = null; string? routing = null; ObservationValidation? validation = null;
        string Execution() => completed ? "executed" : attempted && accepted == null ? "unknown"
            : moved ? moveAccepted == 1 ? "executed" : moveAccepted == 0 ? "not_executed" : "unknown" : "not_executed";
        ActionResult Fail(string code, string message) => new(false, Execution(), code, message);
        ActionResult Wheel(WindowSelection window, Func<bool> current)
        {
            DesktopPointResolution? mapped = point == null || target == null ? null : CoordinateMapper.ResolvePhysical(target.Source, point);
            if (mapped == null || !current() || !backend.Guard(window, mapped.Desktop, false, cancellation)) return Fail("scroll_blocked", "滚动落点不可见、被遮挡或不属于当前可用窗口，未输入。");
            routing = backend.Routing(window, mapped.Desktop, options.Axis, cancellation);
            if (routing == null) return Fail("scroll_blocked", "不能确认滚轮将发往指定区域；请由 AI 定位／聚焦区域后重新观察，不更改系统滚轮设置。");
            string claim = owner.Scope + ":" + requestId;
            if (!consumed.Add(claim)) return Fail("scroll_blocked", "本步骤已派发，拒绝重复移动或滚动。");
            order.Enqueue(claim); if (order.Count > 512) consumed.Remove(order.Dequeue());
            cancellation.ThrowIfCancellationRequested(); moved = true;
            MouseMoveResult move = backend.Move(mapped, cancellation); moveAccepted = move.Accepted;
            if (moveAccepted != 1 || !move.Arrived) return Fail("scroll_failed", "鼠标移动未确认到达，没有派发滚轮，不自动重试。");
            cancellation.ThrowIfCancellationRequested();
            validation = locator.ElementId == null ? observations.Validate(owner, locator with { Purpose = "pointer" }, cancellation)
                : observations.ValidateState(owner, locator with { Purpose = "pointer" }, cancellation);
            if (!validation.valid) return Fail("stale_observation", "移动后画面、控件或窗口状态变化，原定位未滚动，需根据新观察重新判断。");
            if (!current() || !backend.Guard(window, mapped.Desktop, true, cancellation)) return Fail("scroll_blocked", "移动后控件、焦点或命中不匹配，未派发滚轮。");
            routing = backend.Routing(window, mapped.Desktop, options.Axis, cancellation);
            if (routing == null) return Fail("scroll_blocked", "移动后滚轮路由无法确认，未派发滚轮；可由 AI 定位区域并重新观察。");
            cancellation.ThrowIfCancellationRequested(); attempted = true;
            accepted = backend.Wheel(window, mapped, options, routing, cancellation);
            completed = accepted == 1;
            return completed ? new(true, "executed", "ok", "已插入一个有界滚轮事件；实际位移、边界或应用冒泡行为须核对新观察。")
                : Fail(cancellation.IsCancellationRequested ? "cancelled" : "scroll_failed", "滚轮事件未确认接收；鼠标移动与滚轮事实分开记录，不补滚、不改路径。");
        }
        ActionResult Dispatch(ImagePointResolution? image)
        {
            if (target?.Source.Window is not WindowSelection window) return Fail("scroll_blocked", "滚动需要已发现并观察的业务窗口，显示器概览不能授权输入。");
            if (locator.ElementId == null) { point = image?.desktop; return Wheel(window, () => true); }
            if (target.Tree == null) return Fail("stale_observation", "本次观察没有可重新解析的区域控件。");
            return controls.WithCurrentControl(window.ScopeId, window.WindowId, target.Tree, locator.ElementId, (session, node, row, ancestors) => {
                if (session is not IControlPointerSession pointer) return Fail("scroll_blocked", "控件不能进行实时指针命中核对，未滚动。");
                point = row.bounds == null ? null : ClickService.ControlPoint(row.bounds, target.Source);
                return Wheel(window, () => point != null && pointer.PointerTargetCurrent(node, row, ancestors, point));
            }, cancellation);
        }
        ActionResult output;
        try { output = options.Valid ? observations.WithCurrentObservation(owner, locator with { Purpose = "pointer" }, Dispatch, cancellation)
                : Fail("invalid_parameters", "滚动方向或刻度不符合约定。");
            if (output.Data is ObservationValidation check) validation = check;
        }
        catch (OperationCanceledException) { output = Fail("cancelled", "滚动流程已取消，已派发的移动／滚轮不会回滚或重放。"); }
        catch { output = Fail(moved || attempted ? "scroll_failed" : "stale_observation", "滚动执行或目标核对异常，未自动重放。"); }
        if (attempted && !completed && output.Code == "stale_observation") output = Fail("scroll_failed", "滚轮可能已派发，必须先核对后状态，不补滚。");
        if (completed && !output.Ok) output = new(true, "executed", "ok", "滚轮事件已接收，后续核对异常；实际结果需看新观察。");
        ScrollReceipt receipt = new(requestId, locator.ObservationId, owner.Step, target?.Source.Window?.WindowId, locator.ElementId, options.Direction, options.Amount, options.Axis, options.Delta,
            moved, moveAccepted, attempted, completed, attempted ? 1 : 0, accepted, routing, point, before.ToString("O"), Now.ToString("O"), validation: validation?.valid == false ? validation : null);
        return output with { Execution = Execution(), Data = receipt };
    }
}
internal sealed class ScrollAction(ScrollService scrolls) : IWindowsAction
{
    public string Name => "scroll";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        ObservationProvenance owner; string request, observation; string? element; int? x, y; ScrollOptions options;
        try {
            string[] fields = [.. ObservationBindingProtocol.Fields, "request_id", "request_token_digest", "observation_id", "element_id", "x", "y", "direction", "amount"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != fields.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != fields.Length || p.EnumerateObject().Any(v => !fields.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            owner = ObservationBindingProtocol.Provenance(p); request = p.GetProperty("request_id").GetString()!; string digest = p.GetProperty("request_token_digest").GetString()!;
            observation = p.GetProperty("observation_id").GetString()!; element = p.GetProperty("element_id").GetString();
            x = p.GetProperty("x").ValueKind == JsonValueKind.Null ? null : p.GetProperty("x").GetInt32(); y = p.GetProperty("y").ValueKind == JsonValueKind.Null ? null : p.GetProperty("y").GetInt32();
            options = new(p.GetProperty("direction").GetString()!, p.GetProperty("amount").GetInt32());
            if (!Guid.TryParseExact(request, "D", out _) || digest.Length != 64 || digest.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')) ||
                !ObservationBindingProtocol.Id(observation, "obs_") || element != null && !ObservationBindingProtocol.Id(element, "el_") ||
                element == null && (x == null || y == null) || element != null && (x != null || y != null) || x is < 0 or > 2559 || y is < 0 or > 2559 || !options.Valid) return ObservationBindingProtocol.Invalid();
        } catch { return ObservationBindingProtocol.Invalid(); }
        return scrolls.Scroll(owner, new(observation, element, x, y, "pointer"), options, request, cancellation);
    }
}
