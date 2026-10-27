using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal sealed record TextInputBatch(int offset, int length, int? accepted, bool release_attempted = false, int? release_accepted = null);
internal sealed record TypeTextReceipt(string request_id, string observation_id, string source_step_id, string? window_id, string? element_id,
    string mode, string method, int text_utf16_length, string text_sha256, bool input_attempted, bool input_completed, TextInputBatch[] batches,
    string verification, bool content_verified, string before_at, string completed_at, bool goal_verified = false, bool input_ready = false);
internal sealed record TextSnapshot(string Full, string Prefix, string Suffix);
internal interface IPreparedTextValue : IDisposable { bool Writable { get; } int Set(string text); }
internal interface IControlTextSession
{
    bool TextTargetCurrent(IControlNode node, ControlRow row, string[] ancestors);
    IPreparedTextValue? PrepareTextValue(IControlNode node);
    TextSnapshot? ReadTextSnapshot(IControlNode node, bool selection);
}
internal interface ITextInputBackend
{
    bool Guard(WindowSelection window, CancellationToken cancellation);
    int Send(WindowSelection window, string text, CancellationToken cancellation);
    int Release(char unit);
    void Settle(CancellationToken cancellation);
}

internal static class TextInputProtocol
{
    internal static string Canonical(string text) => text.Replace("\r\n", "\n").Replace('\r', '\n');
    internal static string UnicodeText(string text) => Canonical(text).Replace('\n', '\r');
    internal static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    internal static bool Valid(string text, string mode) {
        if (mode is not ("insert" or "replace") || text.Length > 8192 || text.Length == 0 && mode != "replace") return false;
        for (int i = 0; i < text.Length; i++) {
            char c = text[i];
            if (c < 32 && c is not ('\t' or '\n' or '\r') || c is >= '\x7f' and <= '\x9f') return false;
            if (char.IsHighSurrogate(c)) { if (++i >= text.Length || !char.IsLowSurrogate(text[i])) return false; }
            else if (char.IsLowSurrogate(c)) return false;
        }
        return true;
    }
    internal static IEnumerable<(int Offset, string Text)> Chunks(string text) {
        string input = UnicodeText(text);
        for (int offset = 0; offset < input.Length;) {
            int end = Math.Min(input.Length, offset + 32);
            if (end < input.Length && char.IsHighSurrogate(input[end - 1])) end--;
            yield return (offset, input[offset..end]); offset = end;
        }
    }
}

/** A single consumed request: no text retry, no clipboard, no shortcuts and no focus changes. */
internal sealed class TypeTextService(ObservationRegistry observations, ControlTreeService controls, ITextInputBackend backend, Func<DateTime>? clock = null)
{
    private readonly HashSet<string> consumed = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Type(ObservationProvenance owner, ObservationLocator locator, string text, string mode, string requestId, CancellationToken cancellation)
    {
        DateTime before = Now;
        RegisteredClickTarget? target = observations.ClickTarget(owner, locator.ObservationId);
        string method = "none", verification = "unavailable"; bool attempted = false, completed = false;
        List<TextInputBatch> batches = [];
        string Execution() => completed ? "executed" : method == "uia_value" && attempted ? "unknown"
            : batches.Any(b => b.accepted == null || b.accepted > 0 && b.accepted < b.length * 2) ? "unknown"
            : batches.Any(b => b.accepted > 0) ? "executed" : "not_executed";
        ActionResult Fail(string code, string message) => new(false, Execution(), code, message);
        bool Claim() {
            string key = owner.Scope + ":" + requestId;
            if (!consumed.Add(key)) return false;
            order.Enqueue(key); if (order.Count > 512) consumed.Remove(order.Dequeue()); return true;
        }
        ActionResult? SendChunks(WindowSelection window, Func<bool, bool> current) {
            method = "unicode";
            foreach (var chunk in TextInputProtocol.Chunks(text)) {
                cancellation.ThrowIfCancellationRequested();
                if (!current(batches.Count == 0)) return Fail("type_text_blocked", "分段输入期间真实焦点或窗口变化，已停止后续文字；已输入部分不重放。");
                attempted = true; int index = batches.Count; batches.Add(new(chunk.Offset, chunk.Text.Length, null));
                int? accepted = null, released = null; bool release = false;
                try { accepted = backend.Send(window, chunk.Text, cancellation); }
                finally {
                    release = accepted == null || accepted > 0 && accepted < chunk.Text.Length * 2 && accepted % 2 == 1;
                    if (release) try { released = backend.Release(accepted is > 0 ? chunk.Text[(accepted.Value - 1) / 2] : chunk.Text[^1]); } catch { }
                    batches[index] = new(chunk.Offset, chunk.Text.Length, accepted, release, released);
                }
                if (accepted != chunk.Text.Length * 2) return Fail("type_text_failed", "文字事件未完整接收，保留实际数量和释放尝试，不继续或补输。");
                backend.Settle(cancellation);
            }
            completed = true;
            return null;
        }
        ActionResult WindowInsert(ImagePointResolution? unused) {
            if (mode != "insert" || target?.Source.Window is not WindowSelection window) return Fail("type_text_blocked", "窗口级输入只允许 insert，且必须绑定已观察的业务窗口。");
            bool Current(bool first) => observations.ValidateKeyboardContinuation(owner, locator, cancellation, first).valid && backend.Guard(window, cancellation);
            if (!Current(true)) return Fail("type_text_blocked", "窗口级文字输入的键盘路由与观察不匹配，未输入。");
            if (!Claim()) return Fail("type_text_blocked", "本步骤已派发，拒绝重复输入文字。");
            return SendChunks(window, Current) ?? new(true, "executed", "ok", "已向核对过的窗口键盘路由输入；UIA内容不可验证，请结合新观察核对，不自动重输。");
        }
        ActionResult Dispatch(ImagePointResolution? unused)
        {
            if (target?.Source.Window is not WindowSelection window || target.Tree == null || locator.ElementId == null)
                return Fail("type_text_blocked", "文字输入需要本组已观察并获得焦点的业务控件。");
            return controls.WithCurrentControl(window.ScopeId, window.WindowId, target.Tree, locator.ElementId, (session, node, row, ancestors) => {
                if (session is not IControlTextSession editable || row.focused != true || row.password == null ||
                    row.role is not ("edit" or "document") && !row.patterns.Contains("value")) return Fail("type_text_blocked", "当前目标不是已确认焦点的文字控件。");
                bool Current(bool first = false) => observations.ValidateKeyboardContinuation(owner, locator, cancellation, first).valid &&
                    editable.TextTargetCurrent(node, row, ancestors) && backend.Guard(window, cancellation);
                if (!Current(true)) return Fail("stale_observation", "输入前焦点、窗口、控件或观察变化，未输入。");
                // Password/unknown text is never read back. SetValue is explicit full replacement, never an insertion fallback.
                using IPreparedTextValue? value = mode == "replace" && row.password == false ? editable.PrepareTextValue(node) : null;
                if (mode == "replace" && (value == null || !value.Writable)) return Fail("type_text_blocked", "此控件不支持可写 UIA Value，本次未清空或输入。可先根据新观察确认编辑范围，用 press_key(Control+A) 明确选择该范围，再 type_text(mode=insert) 替换选区；不能在已调用写入但结果未知后重做此流程。");
                TextSnapshot? snapshot = row.password == false && row.patterns.Contains("text") ? editable.ReadTextSnapshot(node, mode == "insert") : null;
                string? expected = mode == "replace" ? TextInputProtocol.Canonical(text) : snapshot == null ? null :
                    TextInputProtocol.Canonical(snapshot.Prefix + text + snapshot.Suffix);
                if (!Current(true)) return Fail("stale_observation", "只读准备期间目标变化，未输入。");
                if (!Claim()) return Fail("type_text_blocked", "本步骤已派发，拒绝重复输入文字。");
                if (mode == "replace") {
                    cancellation.ThrowIfCancellationRequested(); method = "uia_value"; attempted = true;
                    completed = value!.Set(text) >= 0;
                    if (!completed) return Fail("type_text_failed", "控件写入失败或结果不确定，不回退其他路径或重输。");
                } else {
                    ActionResult? failure = SendChunks(window, Current);
                    if (failure != null) return failure;
                }
                // Exact, bounded document comparison. Acceptance by SendInput/SetValue alone never verifies text content.
                if (row.password == false && row.patterns.Contains("text") && expected != null) {
                    try {
                        for (int attempt = 0; attempt < 4; attempt++) {
                            backend.Settle(cancellation);
                            if (!Current()) break;
                            TextSnapshot? actual = editable.ReadTextSnapshot(node, false);
                            if (actual == null) break;
                            verification = TextInputProtocol.Canonical(actual.Full) == expected ? "matched" : "mismatched";
                            if (verification == "matched") break;
                        }
                    } catch { verification = "unavailable"; }
                }
                return new(true, "executed", "ok", verification == "matched" ? "文字派发完成且有界全文回读一致；业务目标仍须核对后观察。" : "文字派发完成；内容尚未确认正确，请核对回读状态和新观察，不自动重输。");
            }, cancellation, dispatchTimeout: 60000);
        }
        ActionResult output;
        try {
            if (!TextInputProtocol.Valid(text, mode)) output = Fail("invalid_parameters", "文字或输入模式不符合约定。");
            else output = locator.ElementId == null ? observations.WithCurrentWindowKey(owner, locator, WindowInsert, cancellation)
                : observations.WithCurrentObservation(owner, locator with { Purpose = "keyboard" }, Dispatch, cancellation);
        }
        catch (OperationCanceledException) { output = Fail("cancelled", "文字输入已取消，已派发部分不会回滚或重输。"); }
        catch { output = Fail(attempted ? "type_text_failed" : "stale_observation", "文字输入或目标核对异常，未自动重放。"); }
        if (attempted && output.Code == "stale_observation") output = Fail("type_text_failed", "文字可能已部分输入，需先核对当前内容，不自动重输。");
        // A provider failure during cleanup cannot turn an acknowledged completed input into a not-executed claim.
        if (completed && !output.Ok) output = new(true, "executed", "ok", "输入已完整派发，但后续核对未完成；需检查新观察。");
        TypeTextReceipt receipt = new(requestId, locator.ObservationId, owner.Step, target?.Source.Window?.WindowId, locator.ElementId, mode, method,
            text.Length, TextInputProtocol.Hash(text), attempted, completed, batches.ToArray(), verification, verification == "matched", before.ToString("O"), Now.ToString("O"));
        return output with { Execution = Execution(), Data = receipt };
    }
}

internal sealed class TypeTextAction(TypeTextService texts) : IWindowsAction
{
    public string Name => "type_text";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        ObservationProvenance owner; string request, observation, text, mode; string? element;
        try {
            string[] fields = [.. ObservationBindingProtocol.Fields, "request_id", "request_token_digest", "observation_id", "element_id", "text", "mode"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != fields.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != fields.Length || p.EnumerateObject().Any(v => !fields.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            owner = ObservationBindingProtocol.Provenance(p); request = p.GetProperty("request_id").GetString()!;
            string digest = p.GetProperty("request_token_digest").GetString()!;
            observation = p.GetProperty("observation_id").GetString()!; element = p.GetProperty("element_id").GetString();
            text = p.GetProperty("text").GetString()!; mode = p.GetProperty("mode").GetString()!;
            if (!Guid.TryParseExact(request, "D", out _) || digest.Length != 64 || digest.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')) ||
                !ObservationBindingProtocol.Id(observation, "obs_") || element != null && !ObservationBindingProtocol.Id(element, "el_") || element == null && mode != "insert" || !TextInputProtocol.Valid(text, mode)) return ObservationBindingProtocol.Invalid();
        } catch { return ObservationBindingProtocol.Invalid(); }
        return texts.Type(owner, new(observation, element, Purpose: "keyboard"), text, mode, request, cancellation);
    }
}
