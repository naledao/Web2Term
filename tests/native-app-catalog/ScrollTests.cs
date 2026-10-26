// User-run only: synthetic observation/controls/pixels and input counts. Never injects input or starts helper.
using System.Runtime.InteropServices;
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class ScrollTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ObservationProvenance Owner = new("os_" + new string('a', 32), "11111111-1111-4111-8111-111111111111", new string('a', 64));
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Fixture
    {
        internal readonly FakeControlBackend Controls; internal readonly FakeObservationState States; internal readonly FakeObservationBackend Images;
        internal readonly FakeScrollBackend Input = new(); internal readonly ScrollService Scrolls; internal readonly ObservationRegistry Registry;
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
            Controls = new(new SyntheticControl(root, new SyntheticControl(root with { Key = "edit", Type = 50033, Name = "List area", Focused = true, Bounds = new(30, 30, 20, 10), Patterns = ["scroll"] })));
            Controls.WindowBounds = bounds; trees = new(windows, Controls, () => At); Registry = new(States, Images, trees, () => At);
            Scrolls = new(Registry, trees, Input, () => At); request = new(Scope, "window", id, null, null, 1600, "synthetic");
        }
        internal ObservationResult Publish(bool controls = false) {
            Registry.Invalidate(Owner.Scope);
            var image = (ObservationResult)new ObservationService(Images, (_, _) => { }, () => At).Observe(request, CancellationToken.None).Data!;
            if (controls) image = image with { controls = (ControlTreeResult)trees.Read(Scope, request.WindowId!, new(Timeout: 3000), CancellationToken.None).Data! };
            Registry.Publish(Owner, request, States.Current, image); return image;
        }
        internal ActionResult Scroll(ObservationResult image, ScrollOptions? options = null, bool element = false, string? requestId = null, CancellationToken token = default) =>
            Scrolls.Scroll(Owner, element ? new(image.observation_id, image.controls!.elements[1].element_id, Purpose: "pointer") : new(image.observation_id, X: 5, Y: 5, Purpose: "pointer"),
                options ?? new("down"), requestId ?? Guid.NewGuid().ToString("D"), token);
        internal void Closed() => Check(Controls.LiveNodes == 0 && Controls.Opened == Controls.Closed, "scroll retained a UIA node/session");
    }
    private static ScrollReceipt Receipt(ActionResult r) => (ScrollReceipt)r.Data!;
    internal static void RunAll() {
        foreach (var item in new (string, Action)[] {
            ("four bounded directions emit the correct wheel flags and signed delta", Directions),
            ("scroll routing requires mouse-position routing or the exact focused hit and never guesses horizontal routing", Routing),
            ("control scrolling checks live identity without requiring a focused editable target", Controls),
            ("stale image focus DPI control and blocked routing stop before input", Stale),
            ("cursor movement and post-hover changes are not mistaken for a wheel event", Hover),
            ("zero/unknown wheel receipts and cancellation never cause a second wheel", Uncertain),
            ("new observations cannot replay a consumed scroll request and private parameters are strict", Protocol)
        }) { item.Item2(); Console.WriteLine("PASS " + item.Item1); }
    }
    private static void Directions() {
        foreach (var pair in new[] { ("up", 120, 0x800u), ("down", -120, 0x800u), ("left", -120, 0x1000u), ("right", 120, 0x1000u) }) foreach (int amount in new[] { 1, 3, 10 }) {
            var f = new Fixture(); var options = new ScrollOptions(pair.Item1, amount); var image = f.Publish(); var result = f.Scroll(image, options); var r = Receipt(result);
            var input = ScrollInterop.Wheel(options);
            Check(result.Ok && result.Execution == "executed" && r.scroll_completed && f.Input.Pointer.Moves == 1 && f.Input.Wheels == 1, "scroll not submitted exactly once");
            Check(r.wheel_delta == pair.Item2 * amount && input.Value.Mouse.Flags == pair.Item3 && unchecked((int)input.Value.Mouse.Data) == r.wheel_delta, "wheel sign/flag/amount wrong");
            Check(input.Type == 0 && input.Value.Mouse.X == 0 && input.Value.Mouse.Y == 0 && input.Value.Mouse.Extra == ClickInterop.Marker, "wheel implicitly moved the cursor or omitted marker");
            Check(r.point == new CoordinatePoint(15, 15) && !r.scroll_verified && !r.goal_verified && !r.input_ready && r.wheel_events_accepted == 1 && !f.Registry.Validate(Owner, new(image.observation_id), CancellationToken.None).valid, "scroll claimed a verified displacement or retained old observation"); f.Closed();
        }
        Check(Marshal.SizeOf<ClickInterop.Input>() == 40 && Marshal.SizeOf<ClickInterop.MouseInput>() == 32, "wheel INPUT ABI incorrect");
    }
    private static void Routing() {
        foreach (uint? mode in new uint?[] { 0, 1, 2, null }) foreach (bool focused in new[] { false, true }) {
            Check(ScrollRoutingPolicy.Select("vertical", mode, focused) == (mode == 2 ? "mouse_position" : focused ? "focused_hit" : null), "vertical routing guessed another pane");
            Check(ScrollRoutingPolicy.Select("horizontal", mode, focused) == (focused ? "focused_hit" : null), "horizontal wheel assumed vertical routing");
        }
        var f = new Fixture(); f.States.Current = f.States.Current with { InputTargetReady = false, PointerTargetReady = true }; f.Input.Route = "mouse_position";
        Check(f.Scroll(f.Publish()).Ok, "verified pointer-routed wheel incorrectly required keyboard focus");
    }
    private static void Controls() {
        var f = new Fixture(); f.Controls.RootNode.Children[0].Raw = f.Controls.RootNode.Children[0].Raw with { Focused = false };
        f.Controls.FocusState = new("outside_target", "other"); f.Controls.ValueWritable = false;
        var result = f.Scroll(f.Publish(controls: true), new("right", 2), element: true);
        Check(result.Ok && Receipt(result).element_id != null && f.Input.Pointer.Moves == 1 && f.Input.Wheels == 1 && f.Controls.Invoked == 0 && f.Controls.TextReads == 0, "scroll required editing/focus or invoked a different pattern"); f.Closed();
    }
    private static void Stale() {
        foreach (string scenario in new[] { "image", "focus", "dpi", "route", "blocked", "control", "ancestor", "hit" }) {
            var f = new Fixture(); var image = f.Publish(controls: scenario is "control" or "ancestor" or "hit");
            if (scenario == "image") f.Images.Pixels.Bgra[0] = 255;
            if (scenario == "focus") f.States.Current = f.States.Current with { Focus = "foreign" };
            if (scenario == "dpi") f.States.Current = f.States.Current with { Source = f.States.Current.Source with { WindowDpi = 192 } };
            if (scenario == "route") f.Input.Route = null;
            if (scenario == "blocked") f.Input.Pointer.Allowed = false;
            if (scenario == "control") f.Controls.RootNode.Children[0].Raw = f.Controls.RootNode.Children[0].Raw with { Key = "replacement" };
            if (scenario == "ancestor") f.Controls.AncestorsValid = false;
            if (scenario == "hit") f.Controls.HitMatches = false;
            var result = f.Scroll(image, element: image.controls != null);
            Check(!result.Ok && result.Execution == "not_executed" && f.Input.Pointer.Moves == 0 && f.Input.Wheels == 0 && !Receipt(result).scroll_attempted, "stale/blocked area scrolled: " + scenario); f.Closed();
        }
    }
    private static void Hover() {
        foreach (string scenario in new[] { "move_zero", "not_arrived", "hover", "focus", "route", "live_control" }) {
            var f = new Fixture(); var image = f.Publish(controls: scenario == "live_control");
            if (scenario == "move_zero") f.Input.Pointer.MoveAccepted = 0;
            if (scenario == "not_arrived") f.Input.Pointer.Arrived = false;
            if (scenario == "hover") f.Input.Pointer.OnMove = () => f.Images.Pixels.Bgra[0] = 255;
            if (scenario == "focus") f.Input.Pointer.OnMove = () => f.States.Current = f.States.Current with { Focus = "hover-focus" };
            if (scenario == "route") f.Input.Pointer.OnMove = () => f.Input.Route = null;
            if (scenario == "live_control") f.Input.Pointer.OnMove = () => f.Controls.RootNode.Children[0].Raw = f.Controls.RootNode.Children[0].Raw with { Name = "changed on hover" };
            var result = f.Scroll(image, element: image.controls != null); var r = Receipt(result);
            Check(!result.Ok && f.Input.Pointer.Moves == 1 && f.Input.Wheels == 0 && !r.scroll_attempted && r.move_attempted && result.Execution == (scenario == "move_zero" ? "not_executed" : "executed"), "hover failure dispatched a wheel or lost movement fact: " + scenario); f.Closed();
        }
    }
    private static void Uncertain() {
        var zero = new Fixture(); zero.Input.Accepted = 0; var failed = zero.Scroll(zero.Publish());
        Check(!failed.Ok && failed.Execution == "executed" && Receipt(failed).wheel_events_accepted == 0 && zero.Input.Wheels == 1, "zero wheel receipt lost cursor movement");
        var unknown = new Fixture(); unknown.Input.Throw = true; var error = unknown.Scroll(unknown.Publish());
        Check(error.Execution == "unknown" && Receipt(error).scroll_attempted && Receipt(error).wheel_events_accepted == null && unknown.Input.Wheels == 1, "unknown wheel replayed or downgraded");
        var before = new Fixture(); using var stopped = new CancellationTokenSource(); stopped.Cancel();
        Check(before.Scroll(before.Publish(), token: stopped.Token).Code == "cancelled" && before.Input.Pointer.Moves == 0, "pre-cancel moved cursor");
        var after = new Fixture(); using var cancel = new CancellationTokenSource(); after.Input.Pointer.OnMove = cancel.Cancel;
        var moved = after.Scroll(after.Publish(), token: cancel.Token);
        Check(moved.Code == "cancelled" && moved.Execution == "executed" && after.Input.Wheels == 0 && after.Input.Pointer.Releases == 0, "cancel after move sent wheel/released user buttons");
        var effect = new Fixture(); effect.Input.OnWheel = () => effect.States.Current = effect.States.Current with { Revision = "scrolled-content", Focus = "normal-after-effect" };
        Check(effect.Scroll(effect.Publish()).Ok && effect.Input.Wheels == 1, "own scroll effect invalidated/replayed acknowledged wheel");
    }
    private static void Protocol() {
        var d = new Fixture(); string request = Guid.NewGuid().ToString("D"); Check(d.Scroll(d.Publish(), requestId: request).Ok, "first scroll failed");
        var duplicate = d.Scroll(d.Publish(), requestId: request);
        Check(!duplicate.Ok && duplicate.Execution == "not_executed" && d.Input.Wheels == 1 && d.Input.Pointer.Moves == 1, "new observation replayed old scroll request");
        var f = new Fixture(); var image = f.Publish(); var action = new ScrollAction(f.Scrolls);
        var fields = new Dictionary<string, object?> { ["binding_scope"] = Owner.Scope, ["source_step_id"] = Owner.Step, ["source_token_digest"] = Owner.TokenDigest,
            ["request_id"] = Guid.NewGuid().ToString("D"), ["request_token_digest"] = new string('b', 64), ["observation_id"] = image.observation_id,
            ["element_id"] = null, ["x"] = 5, ["y"] = 5, ["direction"] = "down", ["amount"] = 3 };
        foreach (string extra in new[] { "hwnd", "desktop_x", "script", "repeat", "delta", "pixels", "modifiers" }) {
            fields[extra] = 1; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "raw scroll override accepted"); fields.Remove(extra);
        }
        foreach (int amount in new[] { 0, -1, 11 }) { fields["amount"] = amount; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "unbounded wheel accepted"); }
        fields["amount"] = 3; Check(f.Input.Pointer.Moves == 0 && f.Input.Wheels == 0, "bad scroll parameters caused input");
        using var good = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(good.RootElement, CancellationToken.None).Ok, "valid private scroll protocol rejected");
    }
}
internal sealed class FakeScrollBackend : IScrollBackend
{
    internal readonly FakeClickBackend Pointer = new();
    internal string? Route = "focused_hit";
    internal int Wheels = 0, Accepted = 1;
    internal bool Throw = false;
    internal Action? OnWheel = null;
    public bool Guard(WindowSelection window, CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation) => Pointer.Guard(window, point, cursorAtPoint, cancellation);
    public MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation) => Pointer.Move(point, cancellation);
    public string? Routing(WindowSelection window, CoordinatePoint point, string axis, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return Route; }
    public int Wheel(WindowSelection window, DesktopPointResolution point, ScrollOptions options, string routing, CancellationToken cancellation) { Wheels++; if (Throw) throw new Exception("unknown wheel"); OnWheel?.Invoke(); return Accepted; }
}
