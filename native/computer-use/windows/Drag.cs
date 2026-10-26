using System.Text.Json;
using System.Text.Json.Serialization;

namespace Web2Term.WindowsHelper;

internal sealed record DragOptions(CoordinatePoint[] Path, string Button = "left", int Duration = 600)
{
    internal bool Valid => Path.Length is >= 2 and <= 33 && Path.All(p => p.x is >= 0 and <= 2559 && p.y is >= 0 and <= 2559) &&
        Path.Skip(1).Where((p, i) => p == Path[i]).Count() == 0 && Button is "left" or "right" or "middle" && Duration is >= 100 and <= 3000;
}
internal static class DragPath
{
    internal static CoordinatePoint[]? Interpolate(CoordinatePoint[] anchors, int stride = 16)
    {
        if (anchors.Length is < 2 or > 33 || stride is not (1 or 16)) return null;
        List<CoordinatePoint> points = [anchors[0]]; int maximum = stride == 16 ? 256 : 4096;
        for (int i = 1; i < anchors.Length; i++) {
            CoordinatePoint a = anchors[i - 1], b = anchors[i]; int dx = b.x - a.x, dy = b.y - a.y;
            int count = (int)Math.Ceiling((double)Math.Max(Math.Abs(dx), Math.Abs(dy)) / stride);
            if (count < 1 || points.Count - 1 + count > maximum) return null;
            for (int j = 1; j <= count; j++) points.Add(new(a.x + (int)Math.Floor((double)dx * j / count + 0.5), a.y + (int)Math.Floor((double)dy * j / count + 0.5)));
        }
        return points.ToArray();
    }
    internal static DesktopPointResolution[]? Resolve(ObservationResult image, CaptureSource source, CoordinatePoint[] path)
    {
        ImagePointResolution?[] anchors = path.Select(p => CoordinateMapper.Resolve(image, p.x, p.y)).ToArray();
        if (anchors.Any(p => p == null)) return null;
        CoordinatePoint[] physical = anchors.Select(p => p!.desktop).ToArray();
        CoordinatePoint[]? points = Interpolate(physical), pixels = points == null ? null : Interpolate(physical, 1);
        if (pixels == null || pixels.Any(p => CoordinateMapper.ResolvePhysical(source, p) == null)) return null;
        DesktopPointResolution?[] mapped = points!.Select(p => CoordinateMapper.ResolvePhysical(source, p)).ToArray();
        return mapped.Any(p => p == null) ? null : mapped.Select(p => p!).ToArray();
    }
}
internal interface IDragBackend
{
    bool Guard(CaptureSource source, CoordinatePoint point, CoordinatePoint? cursor, string button, bool holding, CancellationToken cancellation);
    MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation);
    int Down(CaptureSource source, DesktopPointResolution point, string button, CancellationToken cancellation);
    bool ConfirmDown(string button, CancellationToken cancellation);
    bool Pause(CaptureSource source, CoordinatePoint point, string button, int milliseconds, CancellationToken cancellation);
    int Up(string button);
}
internal sealed record DragSegment(int index, int? accepted, bool arrived);
internal sealed record DragReceipt(string request_id, string observation_id, string source_step_id, string? window_id, string button, int duration_ms,
    CoordinatePoint? start, CoordinatePoint? end, int segments_planned, bool move_attempted, int? move_accepted, bool move_arrived,
    bool down_attempted, int? down_accepted, bool down_confirmed, DragSegment[] segments, bool up_attempted, int? up_accepted,
    bool release_required, bool release_attempted, int? release_accepted, bool drag_completed, string before_at, string completed_at,
    bool drag_verified = false, bool goal_verified = false, bool input_ready = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ObservationValidation? validation = null);

/** One bounded mouse gesture. Holding uses only native guards, never blocking UIA/WGC or a replayable continuation. */
internal sealed class DragService(ObservationRegistry observations, IDragBackend backend, Func<DateTime>? clock = null)
{
    private readonly HashSet<string> consumed = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Drag(ObservationProvenance owner, string observationId, DragOptions options, string requestId, CancellationToken cancellation)
    {
        DateTime before = Now; RegisteredDragTarget? target = observations.DragTarget(owner, observationId);
        bool moved = false, arrived = false, down = false, confirmed = false, up = false, completed = false, cleanup = false;
        int? moveAccepted = null, downAccepted = null, upAccepted = null, released = null;
        DesktopPointResolution[]? plan = null; List<DragSegment> segments = []; ObservationValidation? validation = null;
        bool ReleaseRequired() => down && downAccepted != 0 && upAccepted != 1;
        string Execution() => completed ? "executed" : down && downAccepted != 0 ? "unknown"
            : moved ? moveAccepted == 1 ? "executed" : moveAccepted == 0 ? "not_executed" : "unknown" : "not_executed";
        ActionResult Fail(string code, string message) => new(false, Execution(), code, message);
        void Cleanup() {
            if (!ReleaseRequired() || cleanup) return;
            cleanup = true; try { released = backend.Up(options.Button); } catch { released = null; }
        }
        ObservationLocator Locator() => new(observationId, X: options.Path[0].x, Y: options.Path[0].y, Purpose: "pointer");
        ActionResult Dispatch(ImagePointResolution? first)
        {
            if (target?.Source.Window == null || first == null) return Fail("drag_blocked", "拖拽需要业务窗口的图像观察，不使用桌面概览或纯控件观察。");
            CaptureSource source = target.Source; plan = DragPath.Resolve(target.Image, source, options.Path);
            if (plan == null) return Fail("drag_blocked", "轨迹超出有界段数、图像／窗口／显示器或精确坐标范围，请由 AI 根据新观察重新规划。");
            foreach (DesktopPointResolution point in plan) {
                cancellation.ThrowIfCancellationRequested();
                if (!backend.Guard(source, point.Desktop, null, options.Button, false, cancellation)) return Fail("drag_blocked", "轨迹含被遮挡或不可操作的客户端落点，未派发输入。");
            }
            string claim = owner.Scope + ":" + requestId;
            if (!consumed.Add(claim)) return Fail("drag_blocked", "本步骤已派发，拒绝重新拖拽。");
            order.Enqueue(claim); if (order.Count > 512) consumed.Remove(order.Dequeue());
            // Preflight is read-only but may take time. Revalidate the original image at its end, before the first move.
            validation = observations.Validate(owner, Locator(), cancellation);
            if (!validation.valid) return Fail("stale_observation", "轨迹检查期间原观察失效，未开始移动。");
            if (!backend.Guard(source, plan[0].Desktop, null, options.Button, false, cancellation)) return Fail("drag_blocked", "起点状态变化，未开始输入。");
            cancellation.ThrowIfCancellationRequested(); moved = true;
            MouseMoveResult move = backend.Move(plan[0], cancellation); moveAccepted = move.Accepted; arrived = move.Arrived;
            if (moveAccepted != 1 || !arrived) return Fail("drag_failed", "鼠标未确认到达起点，未按下按钮，不自动重试。");
            validation = observations.Validate(owner, Locator(), cancellation);
            if (!validation.valid) return Fail("stale_observation", "移动后图像、焦点或几何变化，未开始拖拽。");
            // Recheck all planned hits after hover; do not silently choose a different route.
            foreach (DesktopPointResolution point in plan)
                if (!backend.Guard(source, point.Desktop, plan[0].Desktop, options.Button, false, cancellation)) return Fail("drag_blocked", "悬停后轨迹归属变化，未按下按钮。");
            cancellation.ThrowIfCancellationRequested(); down = true;
            downAccepted = backend.Down(source, plan[0], options.Button, cancellation);
            if (downAccepted != 1) return Fail(cancellation.IsCancellationRequested ? "cancelled" : "drag_failed", "按下未确认接收，未继续移动；仅尝试必要释放。");
            confirmed = backend.ConfirmDown(options.Button, cancellation);
            if (!confirmed) return Fail("drag_failed", "按钮按住状态未确认，停止轨迹并尝试释放。");
            for (int i = 1; i < plan.Length; i++) {
                cancellation.ThrowIfCancellationRequested();
                int wait = options.Duration * i / (plan.Length - 1) - options.Duration * (i - 1) / (plan.Length - 1);
                if (!backend.Pause(source, plan[i - 1].Desktop, options.Button, wait, cancellation) ||
                    !backend.Guard(source, plan[i].Desktop, plan[i - 1].Desktop, options.Button, true, cancellation)) return Fail("drag_failed", "拖拽中窗口、捕获、鼠标、DPI 或输入状态变化，停止后续轨迹并释放。");
                segments.Add(new(i, null, false));
                MouseMoveResult next = backend.Move(plan[i], cancellation); segments[^1] = new(i, next.Accepted, next.Arrived);
                if (next.Accepted != 1 || !next.Arrived) return Fail("drag_failed", "轨迹分段未确认到达，停止后续移动，不补拖。");
            }
            cancellation.ThrowIfCancellationRequested();
            if (!backend.Guard(source, plan[^1].Desktop, plan[^1].Desktop, options.Button, true, cancellation)) return Fail("drag_failed", "终点状态变化，停止并尝试释放本次按钮。");
            up = true; upAccepted = backend.Up(options.Button); completed = upAccepted == 1;
            return completed ? new(true, "executed", "ok", "拖拽输入已完整插入，实际拖放、选区或画布结果需核对新观察。")
                : Fail("drag_failed", "终点释放未确认，仅尝试必要 up 清理，不重复按下或拖动。");
        }
        ActionResult output;
        try { output = options.Valid ? observations.WithCurrentObservation(owner, Locator(), Dispatch, cancellation) : Fail("invalid_parameters", "拖拽参数不符合有界轨迹协议。");
            if (output.Data is ObservationValidation check) validation = check;
        }
        catch (OperationCanceledException) { output = Fail("cancelled", "拖拽已取消，停止后续移动并尝试释放；已发生部分不可回滚。"); }
        catch { output = Fail(moved || down ? "drag_failed" : "stale_observation", "拖拽或目标核对异常，不重放输入。"); }
        finally { Cleanup(); }
        if (completed && !output.Ok) output = new(true, "executed", "ok", "拖拽输入已接收，实际结果需依据新观察。");
        DragReceipt receipt = new(requestId, observationId, owner.Step, target?.Source.Window?.WindowId, options.Button, options.Duration,
            plan?[0].Desktop, plan?[^1].Desktop, plan == null ? 0 : plan.Length - 1, moved, moveAccepted, arrived, down, downAccepted, confirmed, segments.ToArray(), up, upAccepted,
            ReleaseRequired(), cleanup, released, completed, before.ToString("O"), Now.ToString("O"), validation: validation?.valid == false && !down ? validation : null);
        return output with { Execution = Execution(), Data = receipt };
    }
}
internal sealed class DragAction(DragService drags) : IWindowsAction
{
    public string Name => "drag";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        ObservationProvenance owner; string observation, request; DragOptions options;
        try {
            string[] fields = [.. ObservationBindingProtocol.Fields, "request_id", "request_token_digest", "observation_id", "path", "button", "duration_ms"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != fields.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != fields.Length || p.EnumerateObject().Any(v => !fields.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            owner = ObservationBindingProtocol.Provenance(p); observation = p.GetProperty("observation_id").GetString()!;
            request = p.GetProperty("request_id").GetString()!; string digest = p.GetProperty("request_token_digest").GetString()!;
            JsonElement raw = p.GetProperty("path");
            if (!ObservationBindingProtocol.Id(observation, "obs_") || !Guid.TryParseExact(request, "D", out _) || digest.Length != 64 || digest.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')) ||
                raw.ValueKind != JsonValueKind.Array || raw.GetArrayLength() is < 2 or > 33) return ObservationBindingProtocol.Invalid();
            List<CoordinatePoint> points = [];
            foreach (JsonElement point in raw.EnumerateArray()) {
                if (point.ValueKind != JsonValueKind.Object || point.EnumerateObject().Count() != 2 || point.EnumerateObject().Select(v => v.Name).Distinct().Count() != 2 || point.EnumerateObject().Any(v => v.Name is not ("x" or "y"))) return ObservationBindingProtocol.Invalid();
                points.Add(new(point.GetProperty("x").GetInt32(), point.GetProperty("y").GetInt32()));
            }
            options = new(points.ToArray(), p.GetProperty("button").GetString()!, p.GetProperty("duration_ms").GetInt32());
            if (!options.Valid) return ObservationBindingProtocol.Invalid();
        } catch { return ObservationBindingProtocol.Invalid(); }
        return drags.Drag(owner, observation, options, request, cancellation);
    }
}
