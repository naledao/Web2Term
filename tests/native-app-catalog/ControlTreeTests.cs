// User-run only. Synthetic UIA nodes, focus, clocks and window identities. No COM, desktop capture or files.
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class ControlTreeTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static void Check(bool value, string reason) { if (!value) throw new Exception(reason); }
    private static RawControl Raw(string key, bool focused = false) => new(key, key == "root" ? 50032 : 50004, key, false, true, focused, false, null,
        new(10, 20, 80, 30), ["text", "value"], true);
    private sealed record Fixture(FakeWindowDiscovery Discovery, WindowCatalog Windows, FakeControlBackend Backend, ControlTreeService Service, string WindowId);
    private static Fixture Create()
    {
        DiscoveredWindow window = new("0x1234", 42, At.ToString("O"), 43, "SyntheticWindow", "Test", new(null, null, null), true, false, true, true, false, null, "life-A");
        var discovery = new FakeWindowDiscovery([window]); var windows = new WindowCatalog(discovery, () => At);
        using var p = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
        WindowPage page = (WindowPage)windows.List(p.RootElement, CancellationToken.None).Data!;
        var backend = new FakeControlBackend(new SyntheticControl(Raw("root"), new SyntheticControl(Raw("edit", true))));
        return new(discovery, windows, backend, new(windows, backend, () => At, () => backend.Elapsed), page.windows.Single().window_id!);
    }
    private static ActionResult Read(Fixture f, ControlReadOptions? options = null, CancellationToken token = default) => f.Service.Read(Scope, f.WindowId, options ?? new(), token);
    private static ControlTreeResult Data(ActionResult result) { Check(result.Ok, result.Message); return (ControlTreeResult)result.Data!; }
    private static void Closed(Fixture f) => Check(f.Backend.LiveNodes == 0 && f.Backend.Opened == f.Backend.Closed, "UIA resources retained outside the read");
    internal static void RunAll()
    {
        var cases = new (string Name, Action Run)[] {
            ("visible control tree preserves hierarchy roles bounds patterns and current focus", Tree),
            ("element IDs belong to one observation and never grant input or completion", References),
            ("offscreen foreign and out-of-window branches are excluded", Visibility),
            ("password and unknown-password controls redact names and are not descended into", Passwords),
            ("node depth time and serialized result budgets remain explicit partial observations", Limits),
            ("provider failures and repeated UIA runtime identities stop bounded branches", ProviderErrors),
            ("selected text is opt-in bounded and limited to the focused returned element", Selection),
            ("focus changes discard selected text and mark inconsistent focus", FocusChanged),
            ("window lifecycle and layout changes revoke the entire new observation", Stale),
            ("cancelled reads return no references and release all synthetic node resources", Cancellation),
            ("controls-only action bypasses screenshot and rejects malformed internal options", Parameters)
        };
        foreach (var item in cases) { item.Run(); Console.WriteLine("PASS " + item.Name); }
    }
    private static void Tree()
    {
        var f = Create(); var result = Data(Read(f));
        Check(result.elements.Length == 2 && result.elements[0].role == "window" && result.elements[1].role == "edit", "missing control fields");
        Check(result.elements[1].parent_id == result.root_element_id && result.elements[1].depth == 1 && result.elements[1].bounds?.x == 10, "hierarchy or physical geometry lost");
        Check(result.complete && result.limitations.Length == 0 && result.focus.status == "inside_target" && result.focus.element_id == result.elements[1].element_id, "focus not associated");
        Check(result.elements[1].patterns.Contains("text") && result.elements[1].enabled == true && result.elements[1].focused == true, "state or patterns missing"); Closed(f);
    }
    private static void References()
    {
        var f = Create(); var first = Data(Read(f)); var second = Data(Read(f));
        Check(first.observation_id != second.observation_id && !first.elements.Select(row => row.element_id).Intersect(second.elements.Select(row => row.element_id)).Any(), "old observation IDs reused");
        Check(!first.snapshot_atomic && !first.input_ready && !first.content_verified && !first.goal_verified, "observation claimed stronger guarantees"); Closed(f);
    }
    private static void Visibility()
    {
        foreach (var raw in new[] { Raw("hidden") with { Offscreen = true }, Raw("foreign") with { InWindow = false }, Raw("outside") with { Bounds = new(9000, 9000, 20, 20) } })
        {
            var f = Create(); f.Backend.RootNode.Children.Clear(); f.Backend.RootNode.Children.Add(new(raw, new SyntheticControl(Raw("hidden-secret")))); f.Backend.Link();
            var result = Data(Read(f)); Check(result.elements.Length == 1 && !f.Backend.ReadKeys.Contains("hidden-secret"), "hidden branch exposed"); Closed(f);
        }
    }
    private static void Passwords()
    {
        foreach (bool? password in new bool?[] { true, null })
        {
            var f = Create(); var edit = f.Backend.RootNode.Children[0]; edit.Raw = edit.Raw with { Password = password, Name = "must never be returned" }; edit.Children.Add(new(Raw("secret-child"))); f.Backend.Link();
            var result = Data(Read(f, new(IncludeSelection: true)));
            Check(result.elements[1].name == null && !result.elements[1].name_truncated && !f.Backend.ReadKeys.Contains("secret-child"), "protected name or child leaked");
            Check(result.selection.status == "protected" && result.selection.text == null && f.Backend.SelectionReads == 0, "password selection read"); Closed(f);
        }
    }
    private static void Limits()
    {
        var nodes = Create(); var limited = Data(Read(nodes, new(MaxElements: 1)));
        Check(limited.elements.Length == 1 && !limited.complete && limited.limitations.Contains("node_limit"), "node cap absent"); Closed(nodes);
        var depth = Create(); depth.Backend.RootNode.Children[0].Children.Add(new(Raw("deep"))); depth.Backend.Link();
        var shallow = Data(Read(depth, new(MaxDepth: 1))); Check(shallow.elements.Length == 2 && shallow.limitations.Contains("depth_limit"), "depth cap absent"); Closed(depth);
        var timed = Create(); timed.Backend.AfterRead = _ => timed.Backend.Elapsed = 1200;
        Check(Data(Read(timed)).limitations.Contains("time_limit"), "time cap absent"); Closed(timed);
        var bytes = Create(); bytes.Backend.RootNode.Children.Clear();
        for (int i = 0; i < 199; i++) bytes.Backend.RootNode.Children.Add(new(Raw("node-" + i) with { Name = new string('文', 256) })); bytes.Backend.Link();
        var bounded = Data(Read(bytes, new(MaxElements: 200)));
        Check(bounded.limitations.Contains("result_budget") && JsonSerializer.SerializeToUtf8Bytes(bounded).Length < 140 * 1024, "wire frame budget exceeded"); Closed(bytes);
        var names = Create(); names.Backend.RootNode.Children[0].Raw = Raw("edit", true) with { Name = new string('x', 600) };
        var clipped = Data(Read(names)); Check(clipped.elements[1].name?.Length == 256 && clipped.elements[1].name_truncated && clipped.limitations.Contains("name_truncated"), "unbounded name"); Closed(names);
    }
    private static void ProviderErrors()
    {
        var error = Create(); error.Backend.FailReadKey = "edit";
        var partial = Data(Read(error)); Check(!partial.complete && partial.limitations.Contains("provider_error") && partial.elements.Length == 1, "provider failure became complete"); Closed(error);
        var cycle = Create(); cycle.Backend.RootNode.Children[0].Raw = Raw("root");
        var stopped = Data(Read(cycle)); Check(stopped.limitations.Contains("cycle_detected") && stopped.visited_count <= 2, "cycle walked indefinitely"); Closed(cycle);
    }
    private static void Selection()
    {
        var normal = Create(); Check(Data(Read(normal)).selection.status == "not_requested" && normal.Backend.SelectionReads == 0, "selection read by default"); Closed(normal);
        var selected = Create(); selected.Backend.Selected = new("text", new string('s', 5000));
        var result = Data(Read(selected, new(IncludeSelection: true)));
        Check(result.selection.text?.Length == 2048 && result.selection.truncated && result.limitations.Contains("selection_truncated") && result.selection.element_id == result.focus.element_id, "selection cap or association missing"); Closed(selected);
        var unsupported = Create(); unsupported.Backend.RootNode.Children[0].Raw = Raw("edit", true) with { Patterns = ["value"] };
        Check(Data(Read(unsupported, new(IncludeSelection: true))).selection.status == "unsupported" && unsupported.Backend.SelectionReads == 0, "read unsupported text"); Closed(unsupported);
        var outside = Create(); outside.Backend.FocusState = new("outside_target", "other");
        Check(Data(Read(outside, new(IncludeSelection: true))).selection.status == "focus_outside" && outside.Backend.SelectionReads == 0, "external focused selection read"); Closed(outside);
    }
    private static void FocusChanged()
    {
        var f = Create(); f.Backend.AfterSelection = () => f.Backend.FocusState = new("outside_target", "other");
        var result = Data(Read(f, new(IncludeSelection: true)));
        Check(result.focus.status == "changed" && result.selection.status == "changed" && result.selection.text == null && result.limitations.Contains("focus_changed"), "old selection survived focus change"); Closed(f);
    }
    private static void Stale()
    {
        var identity = Create(); identity.Backend.AfterRead = _ => identity.Discovery.Windows = [identity.Discovery.Windows[0] with { Lifetime = "life-B" }];
        var reused = Read(identity); Check(!reused.Ok && reused.Code == "stale_window" && reused.Data == null, "reused window published IDs"); Closed(identity);
        var moved = Create(); moved.Backend.AfterRead = _ => moved.Backend.WindowBounds = new(20, 20, 100, 100);
        Check(Read(moved).Code == "stale_observation", "moved layout retained references"); Closed(moved);
    }
    private static void Cancellation()
    {
        using var before = new CancellationTokenSource(); before.Cancel(); var f = Create();
        Check(Read(f, token: before.Token).Execution == "not_executed" && f.Backend.Opened == 0, "cancelled preflight opened UIA");
        using var during = new CancellationTokenSource(); var g = Create(); g.Backend.AfterRead = _ => during.Cancel();
        var result = Read(g, token: during.Token); Check(result.Code == "cancelled" && result.Execution == "executed" && result.Data == null, "cancelled read published IDs"); Closed(g);
    }
    private static void Parameters()
    {
        var f = Create(); int imageWrites = 0;
        var pixels = new FakeObservationBackend(new(new(0, 0, 1, 1), null, null, []), new(1, 1, new byte[4], At));
        var action = new ObserveAction(new(pixels, (_, _) => imageWrites++), f.Service);
        object Options(int max = 100) => new { max_depth = 4, max_elements = max, timeout_ms = 1200, include_selection = false };
        object Request(object options) => new { scope_id = Scope, target = "controls", window_id = f.WindowId, monitor_id = (string?)null, crop = (object?)null, max_dimension = 1600, output_path = (string?)null, controls_options = options };
        using var good = JsonDocument.Parse(JsonSerializer.Serialize(Request(Options())));
        Check(action.Execute(good.RootElement, CancellationToken.None).Data is ControlsOnlyResult && pixels.Captures == 0 && imageWrites == 0, "controls-only captured image");
        foreach (object option in new object[] { Options(201), new { max_depth = 99, max_elements = 100, timeout_ms = 1200, include_selection = false },
            new { max_depth = 4, max_elements = 100, timeout_ms = 1200, include_selection = false, script = "arbitrary" } })
        { using var bad = JsonDocument.Parse(JsonSerializer.Serialize(Request(option))); Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "bad controls options accepted"); }
        Check(Read(f, new(MaxElements: 201)).Code == "invalid_parameters", "service accepted unbounded options"); Closed(f);
    }
}

internal sealed class SyntheticControl(RawControl raw, params SyntheticControl[] children)
{
    internal RawControl Raw = raw;
    internal readonly List<SyntheticControl> Children = children.ToList();
    internal SyntheticControl? Next;
}
internal sealed class FakeControlBackend(SyntheticControl root) : IControlTreeBackend
{
    internal readonly SyntheticControl RootNode = root;
    internal CaptureRect WindowBounds = new(0, 0, 100, 100);
    internal ControlFocus FocusState = new("inside_target", "edit");
    internal RawSelection Selected = new("text", "selected");
    internal readonly List<string> ReadKeys = [];
    internal int LiveNodes, Opened, Closed, SelectionReads;
    internal long Elapsed;
    internal Action<string>? AfterRead;
    internal Action? AfterSelection;
    internal string? FailReadKey;
    internal bool HitMatches = true, AncestorsValid = true, PatternAvailable = true, ThrowInvoke;
    internal int Invoked, PatternObjects, PatternResult;
    internal Action? OnInvoke;
    internal readonly List<string> PreparedPatterns = [];
    internal bool TextCurrent = true, ValueAvailable = true, ValueWritable = true, TextAvailable = true, ThrowTextSet = false;
    internal int TextSets = 0, TextReads = 0, TextSetResult = 0, SelectionStart = 1, SelectionEnd = 2;
    internal string TextValue = "abc";
    internal Action? OnTextSet = null;
    internal void Link()
    {
        void Walk(SyntheticControl node) { for (int index = 0; index < node.Children.Count; index++) { node.Children[index].Next = index + 1 < node.Children.Count ? node.Children[index + 1] : null; Walk(node.Children[index]); } }
        Walk(RootNode);
    }
    public CaptureRect Bounds(WindowSelection window, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return WindowBounds; }
    public IControlTreeSession Open(WindowSelection window, Action checkpoint, CancellationToken cancellation) { Link(); Opened++; return new Session(this, checkpoint); }
    private sealed class Handle : IControlNode
    {
        internal readonly SyntheticControl Node;
        private readonly FakeControlBackend owner;
        private bool disposed;
        internal Handle(FakeControlBackend owner, SyntheticControl node) { this.owner = owner; Node = node; owner.LiveNodes++; }
        public void Dispose() { if (disposed) return; disposed = true; owner.LiveNodes--; }
    }
    private sealed class Session(FakeControlBackend owner, Action checkpoint) : IControlTreeSession, IControlClickSession, IControlTextSession, IControlKeySession, IControlPointerSession
    {
        private bool disposed;
        public IControlNode Root() { checkpoint(); return new Handle(owner, owner.RootNode); }
        public IControlNode? FirstChild(IControlNode node) { checkpoint(); return ((Handle)node).Node.Children.FirstOrDefault() is { } child ? new Handle(owner, child) : null; }
        public IControlNode? NextSibling(IControlNode node) { checkpoint(); return ((Handle)node).Node.Next is { } next ? new Handle(owner, next) : null; }
        public RawControl Read(IControlNode node)
        {
            checkpoint(); var raw = ((Handle)node).Node.Raw; owner.ReadKeys.Add(raw.Key!);
            if (owner.FailReadKey == raw.Key) throw new Exception("synthetic provider error"); owner.AfterRead?.Invoke(raw.Key!); return raw;
        }
        public ControlFocus Focus() { checkpoint(); return owner.FocusState; }
        public RawSelection Selection(IControlNode node, int maximum) { checkpoint(); owner.SelectionReads++; owner.AfterSelection?.Invoke(); return owner.Selected; }
        public bool AncestorsMatch(IControlNode node, string[] expected) { checkpoint(); return owner.AncestorsValid; }
        public bool AtPoint(IControlNode node, CoordinatePoint point) { checkpoint(); return owner.HitMatches; }
        public bool PointerTargetCurrent(IControlNode node, ControlRow row, string[] ancestors, CoordinatePoint point) =>
            ControlTreeService.MatchesRaw(row, Read(node)) && AncestorsMatch(node, ancestors) && AtPoint(node, point);
        public bool TextTargetCurrent(IControlNode node, ControlRow row, string[] ancestors) {
            return owner.ValueWritable && KeyTargetCurrent(node, row, ancestors);
        }
        public bool KeyTargetCurrent(IControlNode node, ControlRow row, string[] ancestors) {
            checkpoint(); RawControl raw = ((Handle)node).Node.Raw;
            return owner.TextCurrent && owner.AncestorsValid && owner.FocusState.Status == "inside_target" && owner.FocusState.Key == raw.Key &&
                raw.Focused == true && raw.Enabled == true && raw.Offscreen == false && raw.Bounds == row.bounds && raw.Password == row.password;
        }
        public TextSnapshot? ReadTextSnapshot(IControlNode node, bool selection) {
            checkpoint(); owner.TextReads++;
            if (!owner.TextAvailable) return null;
            return new(owner.TextValue, selection ? owner.TextValue[..owner.SelectionStart] : "", selection ? owner.TextValue[owner.SelectionEnd..] : "");
        }
        public IPreparedTextValue? PrepareTextValue(IControlNode node) { checkpoint(); return owner.ValueAvailable ? new TextValue(owner) : null; }
        private sealed class TextValue(FakeControlBackend owner) : IPreparedTextValue {
            public bool Writable => owner.ValueWritable;
            public int Set(string text) {
                owner.TextSets++; owner.OnTextSet?.Invoke();
                if (owner.ThrowTextSet) throw new Exception("uncertain text set");
                if (owner.TextSetResult >= 0) owner.TextValue = text;
                return owner.TextSetResult;
            }
            public void Dispose() { }
        }
        public IPreparedControlClick? PrepareClick(IControlNode node, string pattern) {
            checkpoint(); owner.PreparedPatterns.Add(pattern);
            return owner.PatternAvailable ? new Prepared(owner) : null;
        }
        private sealed class Prepared : IPreparedControlClick {
            private readonly FakeControlBackend owner; private bool disposed;
            internal Prepared(FakeControlBackend owner) { this.owner = owner; owner.PatternObjects++; }
            public int Invoke() { owner.Invoked++; owner.OnInvoke?.Invoke(); if (owner.ThrowInvoke) throw new Exception("uncertain synthetic invoke"); return owner.PatternResult; }
            public void Dispose() { if (!disposed) { disposed = true; owner.PatternObjects--; } }
        }
        public void Dispose() { if (disposed) return; disposed = true; owner.Closed++; }
    }
}
