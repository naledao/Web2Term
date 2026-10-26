// User-run only. Fake UIA/input acknowledgements; no helper, SendInput or desktop access.
using System.Runtime.InteropServices;
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class TypeTextTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ObservationProvenance Owner = new("os_" + new string('a', 32), "11111111-1111-4111-8111-111111111111", new string('a', 64));
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Fixture
    {
        internal readonly FakeControlBackend Controls; internal readonly FakeObservationState States;
        internal readonly FakeTextInputBackend Input; internal readonly TypeTextService Texts;
        internal readonly ObservationRegistry Registry; private readonly ControlTreeService trees;
        private readonly FakeObservationBackend images; private readonly ObservationRequest request;
        internal Fixture() {
            DiscoveredWindow w = new("0x1234", 42, At.ToString("O"), 43, "Window", "Test", new(null, null, null), true, false, true, true, false, null, "life");
            WindowCatalog windows = new(new FakeWindowDiscovery([w]), () => At);
            using var p = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
            string id = ((WindowPage)windows.List(p.RootElement, CancellationToken.None).Data!).windows.Single().window_id!;
            CaptureRect bounds = new(10, 10, 100, 80); CaptureMonitor monitor = new("mon_" + new string('a', 32), new(0, 0, 1920, 1080), true, 96, 96, 100);
            CaptureSource source = new(bounds, windows.Resolve(Scope, id, CancellationToken.None), null, [monitor], 96);
            images = new(source, new(100, 80, new byte[100 * 80 * 4], At)); States = new(new(source, "focus", "popups", "revision", true));
            RawControl root = new("root", 50032, "Window", false, true, false, false, null, new(10, 10, 100, 80), ["window"], true);
            Controls = new(new SyntheticControl(root, new SyntheticControl(root with { Key = "edit", Type = 50004, Name = "Editor", Focused = true, Bounds = new(30, 30, 20, 10), Patterns = ["text", "value"] })));
            Controls.WindowBounds = bounds; trees = new(windows, Controls, () => At); Registry = new(States, images, trees, () => At);
            Input = new(Controls); Texts = new(Registry, trees, Input, () => At); request = new(Scope, "window", id, null, null, 1600, "synthetic");
        }
        internal ObservationResult Publish() {
            Registry.Invalidate(Owner.Scope);
            var image = (ObservationResult)new ObservationService(images, (_, _) => { }, () => At).Observe(request, CancellationToken.None).Data!;
            image = image with { controls = (ControlTreeResult)trees.Read(Scope, request.WindowId!, new(Timeout: 3000), CancellationToken.None).Data! };
            Registry.Publish(Owner, request, States.Current, image); return image;
        }
        internal ActionResult Type(ObservationResult image, string text = "你好😀", string mode = "insert", string? requestId = null, CancellationToken token = default) =>
            Texts.Type(Owner, new(image.observation_id, image.controls!.elements[1].element_id, Purpose: "keyboard"), text, mode, requestId ?? Guid.NewGuid().ToString("D"), token);
        internal void Closed() => Check(Controls.LiveNodes == 0 && Controls.Opened == Controls.Closed, "text input retained a UIA node/session");
    }
    private static TypeTextReceipt Receipt(ActionResult result) => (TypeTextReceipt)result.Data!;
    internal static void RunAll() {
        foreach (var item in new (string, Action)[] {
            ("literal Unicode insertion preserves selection surroundings and verifies exact text", Insertion),
            ("explicit replace uses one Value call and never falls back or clears on unsupported patterns", Replacement),
            ("stale targets stop input while own content revisions permit subsequent batches", State),
            ("partial Unicode acknowledgement releases only a pending packet without replay", Partial),
            ("cancellation and duplicate requests do not retype accepted text", Cancellation),
            ("unavailable or mismatching readback never certifies contents and passwords are never read", Verification),
            ("text protocol bounds scalars and control characters and preserves keyboard ABI", Protocol)
        }) { item.Item2(); Console.WriteLine("PASS " + item.Item1); }
    }
    private static void Insertion() {
        foreach (string text in new[] { "你好😀", "{ENTER}^+%中文\r\n第二行\t末尾", new string('x', 31) + "😀" + new string('文', 65) }) {
            var f = new Fixture(); var image = f.Publish(); var result = f.Type(image, text); var r = Receipt(result);
            Check(result.Ok && r.input_completed && r.method == "unicode" && r.content_verified && r.verification == "matched", "Unicode insertion not verified");
            Check(TextInputProtocol.Canonical(f.Controls.TextValue) == "a" + TextInputProtocol.Canonical(text) + "c", "selection semantics or literal characters changed");
            Check(string.Concat(f.Input.Sent) == TextInputProtocol.UnicodeText(text) && f.Input.Sent.All(s => s.Length <= 32 && !char.IsHighSurrogate(s[^1])), "surrogate split or text retyped");
            Check(f.Controls.TextSets == 0 && !r.goal_verified && !r.input_ready && r.text_sha256 == TextInputProtocol.Hash(text), "insert silently replaced value"); f.Closed();
        }
    }
    private static void Replacement() {
        foreach (string text in new[] { "新值😀\n第二行", "" }) {
            var f = new Fixture(); f.Controls.OnTextSet = () => f.States.Current = f.States.Current with { Revision = "own-value-event" };
            var result = f.Type(f.Publish(), text, "replace");
            Check(result.Ok && Receipt(result).content_verified && f.Controls.TextValue == text && f.Controls.TextSets == 1 && f.Input.Sent.Count == 0, "replace was not a single explicit Value call"); f.Closed();
        }
        foreach (string scenario in new[] { "unsupported", "readonly", "failure", "throw" }) {
            var f = new Fixture(); var image = f.Publish();
            if (scenario == "unsupported") f.Controls.ValueAvailable = false;
            if (scenario == "readonly") f.Controls.ValueWritable = false;
            if (scenario == "failure") f.Controls.TextSetResult = unchecked((int)0x80004005);
            if (scenario == "throw") f.Controls.ThrowTextSet = true;
            var result = f.Type(image, "replace", "replace");
            Check(!result.Ok && f.Input.Sent.Count == 0 && f.Controls.TextSets == (scenario is "failure" or "throw" ? 1 : 0), "replace fell back or retried");
            Check(result.Execution == (scenario is "failure" or "throw" ? "unknown" : "not_executed"), "replace input fact lost"); f.Closed();
        }
    }
    private static void State() {
        var own = new Fixture(); own.Input.AfterSend = () => own.States.Current = own.States.Current with { Revision = Guid.NewGuid().ToString() };
        Check(own.Type(own.Publish(), new string('字', 90)).Ok && own.Input.Sent.Count == 3, "own content revision stopped typing"); own.Closed();
        foreach (string scenario in new[] { "focus", "popup", "dpi", "geometry", "target" }) {
            var f = new Fixture(); var image = f.Publish(); f.Input.AfterSend = () => {
                if (scenario == "focus") f.States.Current = f.States.Current with { Focus = "foreign" };
                if (scenario == "popup") f.States.Current = f.States.Current with { Popups = "new-popup" };
                if (scenario == "dpi") f.States.Current = f.States.Current with { Source = f.States.Current.Source with { WindowDpi = 192 } };
                if (scenario == "geometry") f.Controls.RootNode.Children[0].Raw = f.Controls.RootNode.Children[0].Raw with { Bounds = new(40, 30, 20, 10) };
                if (scenario == "target") f.Controls.TextCurrent = false;
            };
            var result = f.Type(image, new string('x', 90));
            Check(!result.Ok && result.Execution == "executed" && f.Input.Sent.Count == 1 && !Receipt(result).input_completed, "target change did not stop next chunk: " + scenario); f.Closed();
        }
        var before = new Fixture(); var stale = before.Publish(); before.States.Current = before.States.Current with { InputTargetReady = false };
        Check(before.Type(stale).Execution == "not_executed" && before.Input.Sent.Count == 0, "keyboard not ready still received text");
    }
    private static void Partial() {
        foreach (int count in new[] { 0, 1, 2, 3 }) {
            var f = new Fixture(); f.Input.Accepted = count; var result = f.Type(f.Publish(), "abcd"); var r = Receipt(result);
            Check(!result.Ok && result.Execution == (count == 0 ? "not_executed" : "unknown") && r.batches.Single().accepted == count && f.Input.Sent.Count == 1, "partial batch retried");
            Check(f.Input.Releases == (count % 2) && r.batches[0].release_attempted == (count % 2 == 1), "wrong pending release"); f.Closed();
        }
        var failure = new Fixture(); failure.Input.Throw = true; var unknown = failure.Type(failure.Publish());
        Check(unknown.Execution == "unknown" && failure.Input.Releases == 1 && Receipt(unknown).batches[0].accepted == null, "unknown packet result lost");
    }
    private static void Cancellation() {
        var f = new Fixture(); var image = f.Publish(); using var before = new CancellationTokenSource(); before.Cancel();
        Check(f.Type(image, token: before.Token).Execution == "not_executed" && f.Input.Sent.Count == 0, "pre-cancel submitted text");
        var g = new Fixture(); using var after = new CancellationTokenSource(); g.Input.AfterSend = after.Cancel;
        var stopped = g.Type(g.Publish(), new string('x', 90), token: after.Token);
        Check(stopped.Code == "cancelled" && stopped.Execution == "executed" && g.Input.Sent.Count == 1 && g.Input.Releases == 0, "cancel retyped/released balanced packets");
        var d = new Fixture(); string request = Guid.NewGuid().ToString("D"); Check(d.Type(d.Publish(), requestId: request).Ok, "first text failed");
        var duplicate = d.Type(d.Publish(), requestId: request);
        Check(!duplicate.Ok && duplicate.Execution == "not_executed" && d.Input.Sent.Count == 1, "new observation authorized old request replay");
    }
    private static void Verification() {
        foreach (string scenario in new[] { "mismatch", "unavailable", "password" }) {
            var f = new Fixture();
            if (scenario == "password") f.Controls.RootNode.Children[0].Raw = f.Controls.RootNode.Children[0].Raw with { Password = true };
            if (scenario == "unavailable") f.Controls.TextAvailable = false;
            if (scenario == "mismatch") f.Input.AfterSend = () => f.Controls.TextValue = "application changed the text";
            var result = f.Type(f.Publish()); var r = Receipt(result);
            Check(result.Ok && r.input_completed && !r.content_verified && r.verification == (scenario == "mismatch" ? "mismatched" : "unavailable"), "unverified contents claimed correct");
            if (scenario == "password") Check(f.Controls.TextReads == 0, "password readback attempted"); f.Closed();
        }
    }
    private static void Protocol() {
        foreach (string text in new[] { "\0", "\u001b", "\b", "\u007f", "\ud800", "\udc00", new string('a', 8193), "" }) Check(!TextInputProtocol.Valid(text, "insert"), "invalid text accepted");
        Check(TextInputProtocol.Valid("\r\n\t😀中文", "insert") && TextInputProtocol.Valid("", "replace"), "valid Unicode rejected");
        Check(Marshal.SizeOf<ClickInterop.KeyboardInput>() == 24 && Marshal.SizeOf<ClickInterop.Input>() == 40, "keyboard INPUT ABI wrong");
        var input = ClickInterop.Unicode('中', false); Check(input.Type == 1 && input.Value.Keyboard.VirtualKey == 0 && input.Value.Keyboard.Scan == '中' && input.Value.Keyboard.Flags == 4, "not literal Unicode packets");
        var f = new Fixture(); var image = f.Publish(); var action = new TypeTextAction(f.Texts);
        var fields = new Dictionary<string, object?> { ["binding_scope"] = Owner.Scope, ["source_step_id"] = Owner.Step, ["source_token_digest"] = Owner.TokenDigest,
            ["request_id"] = Guid.NewGuid().ToString("D"), ["request_token_digest"] = new string('b', 64), ["observation_id"] = image.observation_id,
            ["element_id"] = image.controls!.elements[1].element_id, ["text"] = "中文😀", ["mode"] = "insert" };
        foreach (string extra in new[] { "x", "hwnd", "script", "keys", "window_id" }) {
            fields[extra] = "forged"; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(fields));
            Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "native text override accepted"); fields.Remove(extra);
        }
        using var good = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(good.RootElement, CancellationToken.None).Ok, "valid text protocol rejected");
    }
}

internal sealed class FakeTextInputBackend(FakeControlBackend controls) : ITextInputBackend
{
    internal readonly List<string> Sent = [];
    internal int? Accepted = null;
    internal int Releases = 0;
    internal bool Throw = false;
    internal Action? AfterSend = null;
    public bool Guard(WindowSelection window, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return true; }
    public int Send(WindowSelection window, string text, CancellationToken cancellation) {
        Sent.Add(text); if (Throw) throw new Exception("uncertain text packet");
        int accepted = Accepted ?? text.Length * 2;
        if (accepted == text.Length * 2) {
            controls.TextValue = controls.TextValue[..controls.SelectionStart] + text + controls.TextValue[controls.SelectionEnd..];
            controls.SelectionStart += text.Length; controls.SelectionEnd = controls.SelectionStart;
        }
        AfterSend?.Invoke(); return accepted;
    }
    public int Release(char unit) { Releases++; return 1; }
    public void Settle(CancellationToken cancellation) => cancellation.ThrowIfCancellationRequested();
}
