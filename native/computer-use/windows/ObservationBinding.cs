using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Web2Term.WindowsHelper;

internal sealed record ObservationState(CaptureSource Source, string Focus, string Popups, string Revision, bool InputTargetReady, bool? PointerTargetReady = null);
internal interface IObservationStateBackend { ObservationState Read(ObservationRequest request, CancellationToken cancellation); }
internal sealed record ObservationProvenance(string Scope, string Step, string TokenDigest);
internal sealed record ObservationLocator(string ObservationId, string? ElementId = null, int? X = null, int? Y = null, string Purpose = "inspect");
internal sealed record RegisteredClickTarget(CaptureSource Source, PrivateControlSnapshot? Tree);
internal sealed record RegisteredDragTarget(CaptureSource Source, ObservationResult Image);
internal sealed record ObservationValidation(string observation_id, string source_step_id, string checked_at, bool valid, string? reason,
    bool action_not_executed = true, bool input_ready = false, bool snapshot_atomic = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ImagePointResolution? coordinate = null);

/** Sole-MTA registry. A successful read-only check is evidence, never a reusable input authorization. */
internal sealed class ObservationRegistry(IObservationStateBackend states, IObservationBackend images, ControlTreeService controls, Func<DateTime>? clock = null)
{
    private sealed record Entry(ObservationProvenance Owner, ObservationRequest Request, ObservationState State, object Result,
        PrivateControlSnapshot? Tree, DateTime Expires, long Mutation);
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private long mutation;
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal void Invalidate(string scope) => entries.Remove(scope);
    internal void InvalidateMutations() { mutation++; }
    internal ObservationState ReadState(ObservationRequest request, CancellationToken cancellation) => states.Read(request, cancellation);
    internal RegisteredClickTarget? ClickTarget(ObservationProvenance owner, string id) => entries.TryGetValue(owner.Scope, out Entry? e) && e.Owner == owner && Matches(e, id) ? new(e.State.Source, e.Tree) : null;
    internal RegisteredDragTarget? DragTarget(ObservationProvenance owner, string id) => entries.TryGetValue(owner.Scope, out Entry? e) && e.Owner == owner && Matches(e, id) && e.Result is ObservationResult image ? new(e.State.Source, image) : null;
    // Only inside one already-validated keyboard dispatch. Its own text/caret events may change revisions;
    // source identity, geometry, DPI, focus, popup state and lifetime must still match before every batch.
    internal ObservationValidation ValidateKeyboardContinuation(ObservationProvenance owner, ObservationLocator locator, CancellationToken cancellation, bool first = false)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!entries.TryGetValue(owner.Scope, out Entry? e) || e.Owner != owner || !Matches(e, locator.ObservationId)) return Result(owner, locator, "unknown_observation");
        string? reason = e.Expires <= Now ? "expired" : e.Mutation != mutation ? "layout_changed" : null;
        if (reason == null) {
            ObservationState current = states.Read(e.Request, cancellation);
            reason = Difference(first ? e.State : e.State with { Revision = current.Revision }, current);
            if (reason == null && !current.InputTargetReady) reason = "input_target_unavailable";
        }
        if (reason != null) entries.Remove(owner.Scope);
        return Result(owner, locator, reason);
    }
    // Last check while a freshly resolved COM control is still held. The caller also rechecks its live properties and ancestry.
    internal ObservationValidation ValidateState(ObservationProvenance owner, ObservationLocator locator, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!entries.TryGetValue(owner.Scope, out Entry? e) || e.Owner != owner || !Matches(e, locator.ObservationId)) return Result(owner, locator, "unknown_observation");
        string? reason = e.Expires <= Now ? "expired" : e.Mutation != mutation ? "layout_changed" : null;
        if (reason == null) {
            ObservationState current = states.Read(e.Request, cancellation);
            reason = Difference(e.State, current);
            if (reason == null && !(locator.Purpose == "pointer" ? current.PointerTargetReady ?? current.InputTargetReady : current.InputTargetReady)) reason = "input_target_unavailable";
        }
        if (reason != null) entries.Remove(owner.Scope);
        return Result(owner, locator, reason);
    }
    internal string? Difference(ObservationState before, ObservationState after)
    {
        if (before.Source.Window?.Menu?.ContextId != after.Source.Window?.Menu?.ContextId) return "layout_changed";
        DiscoveredWindow? a = before.Source.Window?.Window, b = after.Source.Window?.Window;
        if ((a == null) != (b == null) || a != null && (b == null || !a.SameIdentity(b))) return "window_changed";
        if (a != null && b != null && (a.Visible != b.Visible || a.Minimized != b.Minimized || a.Enabled != b.Enabled || a.Cloaked != b.Cloaked || a.OwnerHandle != b.OwnerHandle)) return "window_state_changed";
        if (before.Source.Bounds != after.Source.Bounds) return "layout_changed";
        if (!before.Source.Monitors.SequenceEqual(after.Source.Monitors) || before.Source.Monitor != after.Source.Monitor || before.Source.WindowDpi != after.Source.WindowDpi) return "desktop_changed";
        if (before.Focus != after.Focus) return "focus_changed";
        if (before.Popups != after.Popups) return "popup_changed";
        if (before.Revision != after.Revision) return "layout_changed";
        return null;
    }
    internal void Publish(ObservationProvenance owner, ObservationRequest request, ObservationState state, object result)
    {
        foreach (string key in entries.Where(pair => pair.Value.Expires <= Now).Select(pair => pair.Key).ToArray()) entries.Remove(key);
        if (entries.Count >= 16 && !entries.ContainsKey(owner.Scope)) entries.Remove(entries.MinBy(pair => pair.Value.Expires).Key);
        ControlTreeResult? tree = result is ControlsOnlyResult only ? only.controls : (result as ObservationResult)?.controls;
        PrivateControlSnapshot? snapshot = tree == null ? null : controls.TakeSnapshot(tree.observation_id);
        entries[owner.Scope] = new(owner, request, state, result, snapshot, Now.AddMinutes(2), mutation);
    }
    private static bool Matches(Entry entry, string id) => entry.Result is ObservationResult image &&
        (image.observation_id == id || image.controls?.observation_id == id) || entry.Result is ControlsOnlyResult only && only.observation_id == id;
    private ObservationValidation Result(ObservationProvenance owner, ObservationLocator locator, string? reason) =>
        new(locator.ObservationId, owner.Step, Now.ToString("O"), reason == null, reason);
    internal ObservationValidation Validate(ObservationProvenance owner, ObservationLocator locator, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if ((locator.X == null) != (locator.Y == null) || locator.X is < 0 or > 2559 || locator.Y is < 0 or > 2559 ||
            locator.ElementId != null && locator.X != null || locator.Purpose is not ("inspect" or "pointer" or "keyboard") ||
            locator.Purpose == "pointer" && locator.ElementId == null && locator.X == null || locator.Purpose == "keyboard" && locator.ElementId == null)
            return Result(owner, locator, "locator_unavailable");
        if (!entries.TryGetValue(owner.Scope, out Entry? entry) || !Matches(entry, locator.ObservationId)) return Result(owner, locator, "unknown_observation");
        string? reason = null;
        ImagePointResolution? coordinate = null;
        if (entry.Owner != owner) reason = "source_step_mismatch";
        else if (entry.Expires <= Now) reason = "expired";
        else if (entry.Mutation != mutation) reason = "layout_changed";
        try
        {
            if (reason == null)
            {
                ObservationState before = states.Read(entry.Request, cancellation);
                reason = Difference(entry.State, before);
                if (reason == null && locator.Purpose != "inspect" && (entry.State.Source.Window == null ||
                    !(locator.Purpose == "pointer" ? before.PointerTargetReady ?? before.InputTargetReady : before.InputTargetReady))) reason = "input_target_unavailable";
                if (reason == null && locator.ElementId != null) reason = CheckElement(entry, locator, cancellation);
                else if (reason == null && entry.Result is ObservationResult image)
                {
                    if (locator.X != null && (locator.X < 0 || locator.Y < 0 || locator.X >= image.image.width || locator.Y >= image.image.height)) reason = "locator_unavailable";
                    else
                    {
                        CapturedPixels pixels = images.Capture(before.Source, cancellation);
                        var png = ObservationPng.Encode(pixels, image.crop, entry.Request.Maximum, cancellation);
                        if (pixels.Width != before.Source.Bounds.width || pixels.Height != before.Source.Bounds.height ||
                            Convert.ToHexString(SHA256.HashData(png.Bytes)).ToLowerInvariant() != image.image.sha256) reason = "image_changed";
                    }
                }
                else if (reason == null && locator.X != null) reason = "locator_unavailable";
                else if (reason == null) reason = CheckTree(entry, cancellation);
                // Re-read after UIA/WGC and directly before returning to the native caller.
                if (reason == null) reason = Difference(entry.State, states.Read(entry.Request, cancellation));
                if (reason == null && locator.X != null)
                {
                    coordinate = entry.Result is ObservationResult picture ? CoordinateMapper.Resolve(picture, locator.X.Value, locator.Y!.Value) : null;
                    if (coordinate == null) reason = "locator_unavailable";
                }
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (ObservationException error) { reason = error.Code == "stale_window" ? "window_changed" : "state_unavailable"; }
        catch { reason = "state_unavailable"; }
        if (reason != null) entries.Remove(owner.Scope); // A failed reference never becomes live again after a window moves back.
        return Result(owner, locator, reason) with { coordinate = reason == null ? coordinate : null };
    }
    private PrivateControlSnapshot? Fresh(Entry entry, CancellationToken cancellation)
    {
        if (entry.Tree == null || entry.Request.WindowId == null) return null;
        ActionResult read = controls.Read(entry.Request.Scope, entry.Request.WindowId, entry.Tree.Options with { IncludeSelection = false }, cancellation);
        return read.Ok && read.Data is ControlTreeResult result ? controls.TakeSnapshot(result.observation_id) : null;
    }
    private static string? Key(PrivateControlSnapshot tree, string? id) => id != null && tree.Keys.TryGetValue(id, out string? key) ? key : null;
    private static string Fingerprint(PrivateControlSnapshot tree, ControlRow row) => JsonSerializer.Serialize(new {
        key = Key(tree, row.element_id), parent = Key(tree, row.parent_id), row.depth, row.control_type, row.name, row.name_truncated,
        row.password, row.enabled, row.focused, row.offscreen, row.selected, row.bounds, row.patterns, row.properties_complete
    });
    private static bool SameAncestors(PrivateControlSnapshot oldTree, ControlRow old, PrivateControlSnapshot fresh, ControlRow current)
    {
        for (int depth = 0; depth <= 8; depth++)
        {
            if (Fingerprint(oldTree, old) != Fingerprint(fresh, current)) return false;
            if (old.parent_id == null || current.parent_id == null) return old.parent_id == current.parent_id;
            ControlRow? a = oldTree.Result.elements.FirstOrDefault(row => row.element_id == old.parent_id), b = fresh.Result.elements.FirstOrDefault(row => row.element_id == current.parent_id);
            if (a == null || b == null) return false;
            old = a; current = b;
        }
        return false;
    }
    private string? CheckElement(Entry entry, ObservationLocator locator, CancellationToken cancellation)
    {
        PrivateControlSnapshot? tree = entry.Tree;
        if (tree == null || !tree.Keys.TryGetValue(locator.ElementId!, out string? key)) return "element_unavailable";
        ControlRow? row = tree.Result.elements.SingleOrDefault(value => value.element_id == locator.ElementId);
        PrivateControlSnapshot? fresh = Fresh(entry, cancellation);
        ControlRow? current = fresh?.Result.elements.SingleOrDefault(value => Key(fresh, value.element_id) == key);
        if (row == null || current == null || fresh == null) return "element_unavailable";
        if (!row.properties_complete || !current.properties_complete || !SameAncestors(tree, row, fresh, current)) return "element_changed";
        bool nativeMenu = entry.State.Source.Window?.Menu != null && locator.Purpose != "keyboard";
        if (tree.Result.focus.status == "changed" || tree.Result.focus.status == "unavailable" && !nativeMenu || tree.Result.focus.status != fresh.Result.focus.status || Key(tree, tree.Result.focus.element_id) != Key(fresh, fresh.Result.focus.element_id)) return "focus_changed";
        if (locator.Purpose != "inspect" && (current.enabled != true || current.offscreen != false)) return "input_target_unavailable";
        if (locator.Purpose == "keyboard" && (current.focused != true || fresh.Result.focus.status != "inside_target" || fresh.Result.focus.element_id != current.element_id)) return "focus_changed";
        return null;
    }
    private string? CheckTree(Entry entry, CancellationToken cancellation)
    {
        PrivateControlSnapshot? fresh = Fresh(entry, cancellation), tree = entry.Tree;
        if (fresh == null || tree == null || tree.Keys.Count != tree.Result.elements.Length || fresh.Keys.Count != fresh.Result.elements.Length) return "element_unavailable";
        if (tree.Result.focus.status == "changed" || tree.Result.focus.status == "unavailable" && entry.State.Source.Window?.Menu == null || fresh.Result.focus.status != tree.Result.focus.status || Key(tree, tree.Result.focus.element_id) != Key(fresh, fresh.Result.focus.element_id)) return "focus_changed";
        return tree.Result.elements.Select(row => Fingerprint(tree, row)).SequenceEqual(fresh.Result.elements.Select(row => Fingerprint(fresh, row))) &&
            tree.Result.complete == fresh.Result.complete && tree.Result.limitations.SequenceEqual(fresh.Result.limitations) ? null : "element_changed";
    }
    // Future input handlers MUST call this on the same MTA immediately before their bounded native dispatch.
    // Window shortcuts may be used without an exposed UIA control. They still verify the observed content and Win32 keyboard route.
    internal ActionResult WithCurrentWindowKey(ObservationProvenance owner, ObservationLocator locator, Func<ImagePointResolution?, ActionResult> dispatch, CancellationToken cancellation)
    {
        if (locator.ElementId != null || locator.X != null || locator.Y != null) return new(false, "not_executed", "invalid_parameters", "窗口按键入口不能覆盖控件或坐标。");
        ObservationValidation check = Validate(owner, locator with { Purpose = "inspect" }, cancellation);
        cancellation.ThrowIfCancellationRequested();
        if (check.valid) check = ValidateState(owner, locator with { Purpose = "keyboard" }, cancellation);
        if (!check.valid) return new(false, "not_executed", "stale_observation", "窗口观察或实际键盘路由已失效，未按键。", check);
        try { return dispatch(null); } finally { InvalidateMutations(); }
    }
    // The callback is not stored or replayed; read-only validate_observation does not call it.
    internal ActionResult WithCurrentObservation(ObservationProvenance owner, ObservationLocator locator, Func<ImagePointResolution?, ActionResult> dispatch, CancellationToken cancellation)
    {
        ObservationValidation check = Validate(owner, locator, cancellation);
        cancellation.ThrowIfCancellationRequested();
        if (!check.valid) return new(false, "not_executed", "stale_observation", "观察已失效，原定位未执行。", check);
        if (locator.Purpose == "inspect") return new(false, "not_executed", "invalid_parameters", "输入入口需要具体定位及输入用途。");
        // The native handler receives only this freshly resolved point, never caller-supplied physical coordinates.
        try { return dispatch(check.coordinate); } finally { InvalidateMutations(); }
    }
}

internal static class ObservationBindingProtocol
{
    internal static bool Id(string value, string prefix) => Regex.IsMatch(value, "^" + prefix + "[a-f0-9]{32}$", RegexOptions.CultureInvariant);
    internal static ObservationProvenance Provenance(JsonElement p) {
        string scope = p.GetProperty("binding_scope").GetString()!, step = p.GetProperty("source_step_id").GetString()!, digest = p.GetProperty("source_token_digest").GetString()!;
        if (!Id(scope, "os_") || !Guid.TryParseExact(step, "D", out _) || !Regex.IsMatch(digest, "^[a-f0-9]{64}$")) throw new InvalidDataException();
        return new(scope, step, digest);
    }
    internal static readonly string[] Fields = ["binding_scope", "source_step_id", "source_token_digest"];
    internal static ActionResult Invalid() => new(false, "not_executed", "invalid_parameters", "观察绑定参数不符合内部协议。");
}

internal sealed class BoundObserveAction(IWindowsAction inner, ObservationRegistry registry) : IWindowsAction
{
    public string Name => "observe";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        string execution = "not_executed";
        try
        {
            ObservationProvenance owner = ObservationBindingProtocol.Provenance(p);
            if (p.EnumerateObject().Select(value => value.Name).Distinct().Count() != p.EnumerateObject().Count()) return ObservationBindingProtocol.Invalid();
            var unbound = p.EnumerateObject().Where(value => !ObservationBindingProtocol.Fields.Contains(value.Name)).ToDictionary(value => value.Name, value => value.Value);
            JsonElement request = JsonSerializer.SerializeToElement(unbound);
            var r = new ObservationRequest(request.GetProperty("scope_id").GetString()!, request.GetProperty("target").GetString()!, request.GetProperty("window_id").GetString(),
                request.GetProperty("monitor_id").GetString(), null, request.GetProperty("max_dimension").GetInt32(), request.GetProperty("output_path").GetString() ?? "");
            // Inner action still owns exact schema, crop/output validation and bounded capture.
            registry.Invalidate(owner.Scope);
            ObservationState before = registry.ReadState(r, cancellation);
            ActionResult result = inner.Execute(request, cancellation);
            execution = result.Execution;
            if (!result.Ok || result.Data == null) return result;
            ObservationState after = registry.ReadState(r, cancellation);
            if (registry.Difference(before, after) is string reason)
                return new(false, "executed", "stale_observation", "观察采集期间窗口、布局、焦点或弹窗变化，请重新观察。", new ObservationValidation("", owner.Step, DateTime.UtcNow.ToString("O"), false, reason));
            if (result.Data is ObservationResult image && (image.source_bounds != after.Source.Bounds || image.window_id != after.Source.Window?.WindowId ||
                !image.monitors.SequenceEqual(after.Source.Monitors) || image.coordinate_context != CoordinateMapper.Context(after.Source)))
                return new(false, "executed", "stale_observation", "截图几何、窗口 DPI 或显示器状态与当前来源不一致，请重新观察。");
            registry.Publish(owner, r, after, result.Data);
            return result;
        }
        catch (OperationCanceledException) { return new(false, execution, "cancelled", "观察绑定已取消。"); }
        catch (ObservationException error) { return new(false, execution, error.Code, "观察来源已变化或状态不可读取，请重新发现／观察。"); }
        catch { return execution == "not_executed" ? ObservationBindingProtocol.Invalid() : new(false, execution, "unavailable", "采集后状态不可核对，未发布观察。"); }
    }
}

internal sealed class ValidateObservationAction(ObservationRegistry registry) : IWindowsAction
{
    public string Name => "validate_observation";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        string execution = "not_executed";
        try
        {
            string[] fields = [.. ObservationBindingProtocol.Fields, "observation_id", "element_id", "x", "y", "purpose"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != fields.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != fields.Length || p.EnumerateObject().Any(v => !fields.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            ObservationProvenance owner = ObservationBindingProtocol.Provenance(p);
            string observation = p.GetProperty("observation_id").GetString()!, purpose = p.GetProperty("purpose").GetString()!;
            string? element = p.GetProperty("element_id").GetString();
            int? x = p.GetProperty("x").ValueKind == JsonValueKind.Null ? null : p.GetProperty("x").GetInt32(), y = p.GetProperty("y").ValueKind == JsonValueKind.Null ? null : p.GetProperty("y").GetInt32();
            if (!ObservationBindingProtocol.Id(observation, "obs_") || element != null && !ObservationBindingProtocol.Id(element, "el_") ||
                (x == null) != (y == null) || x is < 0 or > 2559 || y is < 0 or > 2559 || element != null && x != null ||
                purpose is not ("inspect" or "pointer" or "keyboard") || purpose == "pointer" && element == null && x == null || purpose == "keyboard" && element == null) return ObservationBindingProtocol.Invalid();
            cancellation.ThrowIfCancellationRequested(); execution = "executed";
            ObservationValidation result = registry.Validate(owner, new(observation, element, x, y, purpose), cancellation);
            return new(result.valid, "executed", result.valid ? "ok" : "stale_observation", result.valid ? "只读复核完成，未执行输入；后续输入必须再次在原生入口复核。" : "观察已失效，原定位未执行，请使用新观察重新判断。", result);
        }
        catch (OperationCanceledException) { return new(false, execution, "cancelled", "观察复核已取消。"); }
        catch { return ObservationBindingProtocol.Invalid(); }
    }
}

internal sealed class ObservationInvalidatingAction(IWindowsAction inner, ObservationRegistry registry) : IWindowsAction
{
    public string Name => inner.Name;
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        try { ActionResult result = inner.Execute(p, cancellation); if (result.Execution != "not_executed") registry.InvalidateMutations(); return result; }
        catch { registry.InvalidateMutations(); throw; }
    }
}
