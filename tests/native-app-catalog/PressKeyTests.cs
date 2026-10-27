// User-run only. Synthetic frames, windows, UIA and input counts. Never starts helper or injects real input.
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class PressKeyTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ObservationProvenance Owner = new("os_" + new string('a', 32), "11111111-1111-4111-8111-111111111111", new string('a', 64));
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Fixture
    {
        internal readonly FakeControlBackend Controls; internal readonly FakeObservationState States; internal readonly FakeObservationBackend Images;
        internal readonly FakePressKeyBackend Input = new(); internal readonly PressKeyService Keys; internal readonly ObservationRegistry Registry;
        private readonly ControlTreeService trees; private readonly ObservationRequest request;
        internal Fixture() {
            DiscoveredWindow w = new("0x1234", 42, At.ToString("O"), 43, "Window", "Test", new(null, null, null), true, false, true, true, false, null, "life");
            WindowCatalog windows = new(new FakeWindowDiscovery([w]), () => At);
            using var p = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
            string id = ((WindowPage)windows.List(p.RootElement, CancellationToken.None).Data!).windows.Single().window_id!;
            CaptureRect bounds = new(10, 10, 100, 80); CaptureMonitor monitor = new("mon_" + new string('a', 32), new(0, 0, 1920, 1080), true, 96, 96, 100);
            CaptureSource source = new(bounds, windows.Resolve(Scope, id, CancellationToken.None), null, [monitor], 96);
            Images = new(source, new(100, 80, new byte[100 * 80 * 4], At)); States = new(new(source, "focus", "popups", "revision", true));
            RawControl root = new("root", 50032, "Window", false, true, false, false, null, new(10, 10, 100, 80), ["window"], true);
            Controls = new(new SyntheticControl(root, new SyntheticControl(root with { Key = "edit", Type = 50000, Name = "Focused button", Focused = true, Bounds = new(30, 30, 20, 10), Patterns = ["invoke"] })));
            Controls.WindowBounds = bounds; trees = new(windows, Controls, () => At); Registry = new(States, Images, trees, () => At);
            Keys = new(Registry, trees, Input, () => At); request = new(Scope, "window", id, null, null, 1600, "synthetic");
        }
        internal ObservationResult Publish(bool controls = false) {
            Registry.Invalidate(Owner.Scope);
            var image = (ObservationResult)new ObservationService(Images, (_, _) => { }, () => At).Observe(request, CancellationToken.None).Data!;
            if (controls) image = image with { controls = (ControlTreeResult)trees.Read(Scope, request.WindowId!, new(Timeout: 3000), CancellationToken.None).Data! };
            Registry.Publish(Owner, request, States.Current, image); return image;
        }
        internal ActionResult Press(ObservationResult image, string key = "Control+S", bool element = false, string? requestId = null, CancellationToken token = default) =>
            Keys.Press(Owner, new(image.observation_id, element ? image.controls!.elements[1].element_id : null, Purpose: "keyboard"), PressKeyProtocol.Parse(key)!, requestId ?? Guid.NewGuid().ToString("D"), token);
        internal void Closed() => Check(Controls.LiveNodes == 0 && Controls.Opened == Controls.Closed, "keyboard retained UIA nodes/session");
    }
    private static PressKeyReceipt Receipt(ActionResult r) => (PressKeyReceipt)r.Data!;
    internal static void RunAll() {
        foreach (var item in new (string, Action)[] {
            ("shared keyboard fixtures match native virtual keys aliases and extended-key flags", Golden),
            ("single chords are balanced in one batch and do not require editable UIA controls", Complete),
            ("stale focus images controls and blocked input stop before key down", Stale),
            ("every partial chord prefix releases only its own pending keys in reverse order", Partial),
            ("unknown acknowledgements and release failures never replay primary keys", Unknown),
            ("cancellation and new observations never authorize an old chord again", Cancellation),
            ("private key action rejects raw input overrides and keyboard ABI remains correct", Protocol)
        }) { item.Item2(); Console.WriteLine("PASS " + item.Item1); }
    }
    private static void Golden() {
        using Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("windows-key-cases.json")!;
        using JsonDocument doc = JsonDocument.Parse(stream);
        foreach (var row in doc.RootElement.GetProperty("valid").EnumerateArray()) {
            PressKeyChord chord = PressKeyProtocol.Parse(row.GetProperty("input").GetString()!)!;
            Check(chord != null && chord.Key == row.GetProperty("key").GetString(), "canonical key mismatch");
            var expected = row.GetProperty("down").EnumerateArray().ToArray(); Check(chord!.Down.Length == expected.Length, "modifier count mismatch");
            for (int i = 0; i < expected.Length; i++) Check(chord.Down[i].Name == expected[i][0].GetString() && chord.Down[i].Vk == expected[i][1].GetUInt16() && chord.Down[i].Extended == expected[i][2].GetBoolean(), "VK/extended flag mismatch");
        }
        foreach (var raw in doc.RootElement.GetProperty("invalid").EnumerateArray()) Check(PressKeyProtocol.Parse(raw.GetString()!) == null, "ambiguous/native/secure key accepted");
    }
    private static void Complete() {
        foreach (string key in new[] { "Tab", "Escape", "Control+Shift+S", "Alt+F4", "Win+R", "Alt", "NumpadEnter" }) {
            var f = new Fixture(); var image = f.Publish(); f.Controls.FailReadKey = "root"; // Window route must not depend on an exposed UIA control.
            var result = f.Press(image, key); var r = Receipt(result);
            Check(result.Ok && result.Execution == "executed" && r.input_completed && f.Input.Calls == 1 && f.Input.ReleaseCalls == 0 && r.element_id == null, "window chord failed/replayed");
            var events = f.Input.Events.Single(); int half = events.Length / 2;
            Check(events[..half].All(e => !e.Up) && events[half..].All(e => e.Up) && events[..half].Select(e => e.Key).SequenceEqual(events[half..].Reverse().Select(e => e.Key)), "chord unbalanced or modifiers released early");
            Check(!r.goal_verified && !r.input_ready && !f.Registry.Validate(Owner, new(image.observation_id), CancellationToken.None).valid, "key receipt authorized old observation"); f.Closed();
        }
        var control = new Fixture(); control.Controls.ValueWritable = false; var typed = control.Press(control.Publish(controls: true), "Space", element: true);
        Check(typed.Ok && Receipt(typed).element_id != null && control.Controls.TextReads == 0 && control.Controls.TextSets == 0, "navigation unnecessarily required a writable editor"); control.Closed();
        var effect = new Fixture(); effect.Input.AfterSend = () => effect.States.Current = effect.States.Current with { Focus = "new-window-from-shortcut" };
        Check(effect.Press(effect.Publish(), "Alt+F4").Ok && effect.Input.Calls == 1, "normal shortcut effect invalidated or repeated the submitted chord");
    }
    private static void Stale() {
        var dynamic = new Fixture(); var changing = dynamic.Publish();
        Array.Fill(dynamic.Images.Pixels.Bgra, (byte)255);
        Check(dynamic.Press(changing, "Tab").Ok && dynamic.Input.Calls == 1, "dynamic pixels blocked a valid native window key route");
        foreach (string scenario in new[] { "focus", "dpi", "not_ready", "held", "control", "ancestor" }) {
            var f = new Fixture(); var image = f.Publish(controls: scenario is "control" or "ancestor");
            if (scenario == "focus") f.Input.Allowed = false;
            if (scenario == "image") f.Images.Pixels.Bgra[0] = 255;
            if (scenario == "dpi") f.States.Current = f.States.Current with { Source = f.States.Current.Source with { WindowDpi = 192 } };
            if (scenario == "not_ready") f.Input.Allowed = false;
            if (scenario == "held") f.Input.Allowed = false;
            if (scenario == "control") f.Controls.RootNode.Children[0].Raw = f.Controls.RootNode.Children[0].Raw with { Key = "replacement" };
            if (scenario == "ancestor") f.Controls.AncestorsValid = false;
            var result = f.Press(image, element: image.controls != null);
            Check(!result.Ok && result.Execution == "not_executed" && !Receipt(result).input_attempted && f.Input.Calls == 0 && f.Input.ReleaseCalls == 0, "stale/held target received key: " + scenario); f.Closed();
        }
    }
    private static void Partial() {
        string[][] pending = [[], ["Control"], ["Alt", "Control"], ["Shift", "Alt", "Control"], ["S", "Shift", "Alt", "Control"], ["Shift", "Alt", "Control"], ["Alt", "Control"], ["Control"], []];
        for (int count = 0; count <= 8; count++) {
            var f = new Fixture(); f.Input.Accepted = count; var result = f.Press(f.Publish(), "Control+Alt+Shift+S"); var r = Receipt(result);
            Check(r.events_requested == 8 && r.events_accepted == count && result.Ok == (count == 8) && result.Execution == (count == 0 ? "not_executed" : count == 8 ? "executed" : "unknown"), "partial receipt lost input fact");
            Check(r.release_keys.SequenceEqual(pending[count]) && f.Input.Released.SequenceEqual(pending[count]) && f.Input.Calls == 1 && f.Input.ReleaseCalls == (pending[count].Length == 0 ? 0 : 1), "wrong release prefix or replay"); f.Closed();
        }
    }
    private static void Unknown() {
        var f = new Fixture(); f.Input.Throw = true; var result = f.Press(f.Publish(), "Control+Shift+S"); var r = Receipt(result);
        Check(result.Execution == "unknown" && r.events_accepted == null && r.release_keys.SequenceEqual(new[] { "S", "Shift", "Control" }) && r.release_accepted == 3 && f.Input.Calls == 1, "unknown chord was replayed or not released");
        var failed = new Fixture(); failed.Input.Accepted = 2; failed.Input.ReleaseAccepted = 0; var release = failed.Press(failed.Publish());
        Check(release.Execution == "unknown" && Receipt(release).release_accepted == 0 && !release.Ok, "failed release claimed rollback/success");
        var throwing = new Fixture(); throwing.Input.Accepted = 1; throwing.Input.ThrowRelease = true; var unknown = throwing.Press(throwing.Publish());
        Check(unknown.Execution == "unknown" && Receipt(unknown).release_accepted == null && throwing.Input.ReleaseCalls == 1, "cleanup exception lost facts or repeated releases");
    }
    private static void Cancellation() {
        var f = new Fixture(); var image = f.Publish(); using var before = new CancellationTokenSource(); before.Cancel();
        Check(f.Press(image, token: before.Token).Code == "cancelled" && f.Input.Calls == 0 && f.Input.ReleaseCalls == 0, "pre-cancel pressed/released keys");
        var submitted = new Fixture(); using var after = new CancellationTokenSource(); submitted.Input.AfterSend = after.Cancel;
        var completed = submitted.Press(submitted.Publish(), token: after.Token);
        Check(completed.Ok && completed.Execution == "executed" && submitted.Input.Calls == 1 && submitted.Input.ReleaseCalls == 0, "balanced batch lost facts after cancellation");
        var d = new Fixture(); string request = Guid.NewGuid().ToString("D"); Check(d.Press(d.Publish(), requestId: request).Ok, "first request failed");
        var duplicate = d.Press(d.Publish(), requestId: request);
        Check(!duplicate.Ok && duplicate.Execution == "not_executed" && d.Input.Calls == 1, "re-observation authorized old chord again");
    }
    private static void Protocol() {
        Check(Marshal.SizeOf<ClickInterop.Input>() == 40 && Marshal.SizeOf<ClickInterop.KeyboardInput>() == 24, "keyboard ABI mismatch");
        var arrow = ClickInterop.VirtualKey(37, true, true);
        Check(arrow.Type == 1 && arrow.Value.Keyboard.VirtualKey == 37 && arrow.Value.Keyboard.Scan == 0 && arrow.Value.Keyboard.Flags == 3 && arrow.Value.Keyboard.Extra == ClickInterop.Marker, "extended/up event flags wrong");
        var f = new Fixture(); var image = f.Publish(); var action = new PressKeyAction(f.Keys);
        var fields = new Dictionary<string, object?> { ["binding_scope"] = Owner.Scope, ["source_step_id"] = Owner.Step, ["source_token_digest"] = Owner.TokenDigest,
            ["request_id"] = Guid.NewGuid().ToString("D"), ["request_token_digest"] = new string('b', 64), ["observation_id"] = image.observation_id, ["element_id"] = null, ["key"] = "Ctrl+S" };
        foreach (string extra in new[] { "vk", "scan_code", "script", "repeat", "hold_ms", "x", "permissions" }) {
            fields[extra] = 1; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "raw key override accepted"); fields.Remove(extra);
        }
        Check(f.Input.Calls == 0, "invalid key protocol injected input");
        using var good = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(good.RootElement, CancellationToken.None).Ok && f.Input.Calls == 1, "valid private key protocol rejected");
    }
}
internal sealed class FakePressKeyBackend : IPressKeyBackend
{
    internal bool Allowed = true, Throw = false, ThrowRelease = false;
    internal int Calls = 0, ReleaseCalls = 0;
    internal int? Accepted = null, ReleaseAccepted = null;
    internal Action? AfterSend = null;
    internal readonly List<PressKeyEvent[]> Events = [];
    internal string[] Released = [];
    public bool Guard(WindowSelection window, PressKeyChord chord, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return Allowed; }
    public int Send(WindowSelection window, PressKeyChord chord, CancellationToken cancellation) {
        Calls++; Events.Add(PressKeyProtocol.Sequence(chord)); if (Throw) throw new Exception("unknown key submission"); AfterSend?.Invoke(); return Accepted ?? chord.Down.Length * 2;
    }
    public int Release(PressKeySpec[] keys) { ReleaseCalls++; Released = keys.Select(k => k.Name).ToArray(); if (ThrowRelease) throw new Exception("unknown release"); return ReleaseAccepted ?? keys.Length; }
}
