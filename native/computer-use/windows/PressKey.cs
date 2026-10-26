using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal sealed record PressKeySpec(string Name, ushort Vk, bool Extended = false);
internal sealed record PressKeyChord(string Key, PressKeySpec[] Down);
internal sealed record PressKeyEvent(PressKeySpec Key, bool Up);
internal static class PressKeyProtocol
{
    private static readonly PressKeySpec[] Modifiers = [new("Control", 0xa2), new("Alt", 0xa4), new("Shift", 0xa0), new("Win", 0x5b, true)];
    private static readonly PressKeySpec[] Named = [new("Backspace", 8), new("Tab", 9), new("Enter", 13), new("Escape", 27), new("Space", 32), new("CapsLock", 20),
        .. new[] { "PageUp", "PageDown", "End", "Home", "Left", "Up", "Right", "Down" }.Select((name, i) => new PressKeySpec(name, (ushort)(33 + i), true)),
        new("Insert", 45, true), new("Delete", 46, true), new("Menu", 93, true), new("NumpadEnter", 13, true),
        new("Multiply", 106), new("Add", 107), new("Subtract", 109), new("Decimal", 110), new("Divide", 111, true),
        .. Enumerable.Range(0, 10).Select(i => new PressKeySpec("Numpad" + i, (ushort)(96 + i))),
        .. Enumerable.Range(0, 26).Select(i => new PressKeySpec(((char)(65 + i)).ToString(), (ushort)(65 + i))),
        .. Enumerable.Range(0, 10).Select(i => new PressKeySpec(i.ToString(), (ushort)(48 + i))),
        .. Enumerable.Range(0, 24).Select(i => new PressKeySpec("F" + (i + 1), (ushort)(112 + i)))];
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.Ordinal) { ["ctrl"] = "control", ["ctl"] = "control", ["option"] = "alt", ["windows"] = "win", ["meta"] = "win",
        ["esc"] = "escape", ["return"] = "enter", ["spacebar"] = "space", ["pgup"] = "pageup", ["pgdn"] = "pagedown", ["del"] = "delete", ["ins"] = "insert",
        ["arrowleft"] = "left", ["arrowright"] = "right", ["arrowup"] = "up", ["arrowdown"] = "down", ["apps"] = "menu" };
    internal static PressKeyChord? Parse(string value) {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 80 || value.Any(c => !(c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '+' or ' '))) return null;
        string[] tokens = value.Split('+').Select(s => s.Trim().ToLowerInvariant()).Select(s => Aliases.GetValueOrDefault(s, s)).ToArray();
        if (tokens.Length > 5 || tokens.Any(string.IsNullOrEmpty) || tokens.Distinct(StringComparer.Ordinal).Count() != tokens.Length) return null;
        PressKeySpec? primary = Named.Concat(Modifiers).FirstOrDefault(s => s.Name.ToLowerInvariant() == tokens[^1]);
        if (primary == null || tokens.Length > 1 && Modifiers.Any(s => s.Name == primary.Name) || tokens[..^1].Any(s => !Modifiers.Any(m => m.Name.ToLowerInvariant() == s))) return null;
        PressKeySpec[] down = [.. Modifiers.Where(s => tokens[..^1].Contains(s.Name.ToLowerInvariant())), primary];
        if (primary.Name == "Delete" && down.Any(s => s.Name == "Control") && down.Any(s => s.Name == "Alt")) return null;
        return new(string.Join('+', down.Select(s => s.Name)), down);
    }
    internal static PressKeyEvent[] Sequence(PressKeyChord chord) => [.. chord.Down.Select(k => new PressKeyEvent(k, false)), .. chord.Down.Reverse().Select(k => new PressKeyEvent(k, true))];
    internal static PressKeySpec[] Pending(PressKeyChord chord, int? accepted) {
        if (accepted == null) return chord.Down.Reverse().ToArray();
        List<PressKeySpec> held = [];
        foreach (PressKeyEvent item in Sequence(chord).Take(accepted.Value)) { if (item.Up) held.Remove(item.Key); else held.Add(item.Key); }
        held.Reverse(); return held.ToArray();
    }
}
internal interface IControlKeySession { bool KeyTargetCurrent(IControlNode node, ControlRow row, string[] ancestors); }
internal interface IPressKeyBackend
{
    bool Guard(WindowSelection window, PressKeyChord chord, CancellationToken cancellation);
    int Send(WindowSelection window, PressKeyChord chord, CancellationToken cancellation);
    int Release(PressKeySpec[] keys);
}
internal sealed record PressKeyReceipt(string request_id, string observation_id, string source_step_id, string? window_id, string? element_id,
    string key, bool input_attempted, bool input_completed, int events_requested, int? events_accepted, string[] release_keys, int? release_accepted,
    string before_at, string completed_at, bool goal_verified = false, bool input_ready = false);

/** One balanced chord, at most one cleanup batch. Never replays a primary key or borrows a user-held modifier. */
internal sealed class PressKeyService(ObservationRegistry observations, ControlTreeService controls, IPressKeyBackend backend, Func<DateTime>? clock = null)
{
    private readonly HashSet<string> consumed = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Press(ObservationProvenance owner, ObservationLocator locator, PressKeyChord chord, string requestId, CancellationToken cancellation)
    {
        DateTime before = Now; RegisteredClickTarget? target = observations.ClickTarget(owner, locator.ObservationId);
        bool attempted = false, completed = false; int requested = 0; int? accepted = null, released = null;
        PressKeySpec[] pending = [];
        string Execution() => completed ? "executed" : !attempted || accepted == 0 ? "not_executed" : "unknown";
        ActionResult Fail(string code, string message) => new(false, Execution(), code, message);
        ActionResult Send(WindowSelection window, Func<bool> current) {
            if (!observations.ValidateState(owner, locator with { Purpose = "keyboard" }, cancellation).valid || !current() || !backend.Guard(window, chord, cancellation))
                return Fail("press_key_blocked", "窗口、焦点或控件状态不匹配，或目标键／修饰键已按下，未派发按键。");
            string claim = owner.Scope + ":" + requestId;
            if (!consumed.Add(claim)) return Fail("press_key_blocked", "本步骤已派发，拒绝重复按键。");
            order.Enqueue(claim); if (order.Count > 512) consumed.Remove(order.Dequeue());
            cancellation.ThrowIfCancellationRequested(); requested = chord.Down.Length * 2; attempted = true;
            try { accepted = backend.Send(window, chord, cancellation); }
            finally {
                pending = PressKeyProtocol.Pending(chord, accepted);
                if (pending.Length > 0) try { released = backend.Release(pending); } catch { released = null; }
            }
            completed = accepted == requested;
            return completed ? new(true, "executed", "ok", "一个完整按键组合已插入输入流；实际响应与业务结果须核对新观察。")
                : Fail(cancellation.IsCancellationRequested ? "cancelled" : "press_key_failed", "按键事件未完整确认，已记录接收数和必要释放尝试；不补按、不重放。");
        }
        ActionResult Dispatch(ImagePointResolution? unused) {
            if (target?.Source.Window is not WindowSelection window) return Fail("press_key_blocked", "按键需要最近观察的业务窗口，显示器概览不能授权输入。");
            if (window.Menu != null && locator.ElementId != null) return Fail("press_key_blocked", "活动菜单只接受窗口级按键，不把菜单 owner 的后台焦点控件当作输入目标。");
            if (locator.ElementId == null) return Send(window, () => true);
            if (target.Tree == null) return Fail("stale_observation", "本组没有可复核的焦点控件。");
            return controls.WithCurrentControl(window.ScopeId, window.WindowId, target.Tree, locator.ElementId, (session, node, row, ancestors) =>
                session is IControlKeySession keyboard && row.focused == true ? Send(window, () => keyboard.KeyTargetCurrent(node, row, ancestors))
                    : Fail("press_key_blocked", "指定控件未获得实际焦点，未派发按键。"), cancellation);
        }
        ActionResult output;
        try { output = locator.ElementId == null ? observations.WithCurrentWindowKey(owner, locator, Dispatch, cancellation)
                : observations.WithCurrentObservation(owner, locator with { Purpose = "keyboard" }, Dispatch, cancellation); }
        catch (OperationCanceledException) { output = Fail("cancelled", "按键流程已取消；已提交事件不会回滚或重放。"); }
        catch { output = Fail(attempted ? "press_key_failed" : "stale_observation", "按键派发或目标复核异常，未自动重放。"); }
        if (attempted && !completed && output.Code == "stale_observation") output = Fail("press_key_failed", "按键可能已部分生效，必须先核对后状态，不补按。");
        if (completed && !output.Ok) output = new(true, "executed", "ok", "按键事件已完整提交，后续核对异常；请检查新观察。");
        PressKeyReceipt receipt = new(requestId, locator.ObservationId, owner.Step, target?.Source.Window?.WindowId, locator.ElementId, chord.Key, attempted, completed,
            requested, accepted, pending.Select(k => k.Name).ToArray(), released, before.ToString("O"), Now.ToString("O"));
        return output with { Execution = Execution(), Data = receipt };
    }
}
internal sealed class PressKeyAction(PressKeyService keys) : IWindowsAction
{
    public string Name => "press_key";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation) {
        ObservationProvenance owner; string request, observation; string? element; PressKeyChord? chord;
        try {
            string[] fields = [.. ObservationBindingProtocol.Fields, "request_id", "request_token_digest", "observation_id", "element_id", "key"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != fields.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != fields.Length || p.EnumerateObject().Any(v => !fields.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            owner = ObservationBindingProtocol.Provenance(p); request = p.GetProperty("request_id").GetString()!; string digest = p.GetProperty("request_token_digest").GetString()!;
            observation = p.GetProperty("observation_id").GetString()!; element = p.GetProperty("element_id").GetString(); chord = PressKeyProtocol.Parse(p.GetProperty("key").GetString()!);
            if (!Guid.TryParseExact(request, "D", out _) || digest.Length != 64 || digest.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')) ||
                !ObservationBindingProtocol.Id(observation, "obs_") || element != null && !ObservationBindingProtocol.Id(element, "el_") || chord == null) return ObservationBindingProtocol.Invalid();
        } catch { return ObservationBindingProtocol.Invalid(); }
        return keys.Press(owner, new(observation, element, Purpose: "keyboard"), chord, request, cancellation);
    }
}
