// User-run only. Synthetic windows, pixels, UIA patterns and input acknowledgements. Never calls SendInput or starts helper.
using System.Runtime.InteropServices;
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class ClickTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ObservationProvenance Owner = new("os_" + new string('a', 32), "11111111-1111-4111-8111-111111111111", new string('a', 64));
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Fixture
    {
        internal readonly ObservationRegistry Registry; internal readonly ClickService Clicks;
        internal readonly FakeControlBackend Controls; internal readonly FakeClickBackend Input = new();
        internal readonly FakeObservationBackend Images; internal readonly FakeObservationState States;
        internal readonly ControlTreeService Trees; internal readonly ObservationRequest Request;
        internal Fixture()
        {
            DiscoveredWindow w = new("0x1234", 42, At.ToString("O"), 43, "Window", "Test", new(null, null, null), true, false, true, true, false, null, "life");
            WindowCatalog windows = new(new FakeWindowDiscovery([w]), () => At);
            using var p = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
            string id = ((WindowPage)windows.List(p.RootElement, CancellationToken.None).Data!).windows.Single().window_id!;
            CaptureRect bounds = new(10, 10, 100, 80); CaptureMonitor monitor = new("mon_" + new string('a', 32), new(0, 0, 1920, 1080), true, 96, 96, 100);
            CaptureSource source = new(bounds, windows.Resolve(Scope, id, CancellationToken.None), null, [monitor], 96);
            Images = new(source, new(100, 80, new byte[100 * 80 * 4], At));
            States = new(new(source, "focus", "popups", "revision", true));
            RawControl root = new("root", 50032, "Window", false, true, false, false, null, new(10, 10, 100, 80), ["window"], true);
            Controls = new(new SyntheticControl(root, new SyntheticControl(root with { Key = "edit", Type = 50000, Name = "Save", Focused = true, Bounds = new(30, 30, 20, 10), Patterns = ["invoke"] })));
            Controls.WindowBounds = bounds;
            Trees = new(windows, Controls, () => At);
            Registry = new(States, Images, Trees, () => At); Clicks = new(Registry, Trees, Input, () => At);
            Request = new(Scope, "window", id, null, null, 1600, "synthetic");
        }
        internal ObservationResult Publish(bool controls = false)
        {
            Registry.Invalidate(Owner.Scope);
            var image = (ObservationResult)new ObservationService(Images, (_, _) => { }, () => At).Observe(Request, CancellationToken.None).Data!;
            if (controls) image = image with { controls = (ControlTreeResult)Trees.Read(Scope, Request.WindowId!, new(Timeout: 3000), CancellationToken.None).Data! };
            Registry.Publish(Owner, Request, States.Current, image); return image;
        }
        internal ActionResult Click(ObservationResult image, ClickOptions? options = null, bool element = false, string? request = null, CancellationToken token = default) =>
            Clicks.Click(Owner, element ? new(image.controls!.observation_id, image.controls.elements[1].element_id, Purpose: "pointer") : new(image.observation_id, X: 5, Y: 5, Purpose: "pointer"),
                options ?? new(), request ?? Guid.NewGuid().ToString("D"), token);
        internal void Closed() => Check(Controls.LiveNodes == 0 && Controls.Opened == Controls.Closed && Controls.PatternObjects == 0, "native-like resources retained");
    }
    internal static void RunAll()
    {
        var cases = new (string Name, Action Run)[] {
            ("coordinate left right middle single and double clicks balance exactly one sequence", Mouse),
            ("left single chooses role-compatible UIA operations and unsupported patterns fall back only before mutation", Semantics),
            ("semantic failures never fall back to mouse and disposed resources are released", SemanticFailure),
            ("stale control ancestry hit target focus image and window stop input", Stale),
            ("move must arrive and hover changes block button dispatch", Movement),
            ("partial button receipts preserve unknown execution and release only a pending attempted button", Partial),
            ("cancellation before input and after movement never dispatches another click", Cancellation),
            ("a foreground pointer target may establish keyboard focus without authorizing keyboard input", PointerFocus),
            ("new observations do not authorize replay of an already consumed request", Duplicate),
            ("native click protocol rejects raw locators and INPUT layout matches Windows x64 ABI", Protocol),
            ("menu-owner background controls use real mouse routing instead of bypassing the menu with UIA", MenuOwner)
        };
        foreach (var item in cases) { item.Run(); Console.WriteLine("PASS " + item.Name); }
    }
    private static ClickReceipt Receipt(ActionResult result) => (ClickReceipt)result.Data!;
    private static void Mouse()
    {
        foreach (string button in new[] { "left", "right", "middle" }) foreach (int count in new[] { 1, 2 }) {
            var f = new Fixture(); var image = f.Publish(); var result = f.Click(image, new(button, count)); var r = Receipt(result);
            Check(result.Ok && result.Execution == "executed" && r.method == "mouse" && r.click_completed, "mouse receipt failed");
            Check(f.Input.Moves == 1 && f.Input.Clicks == 1 && f.Input.LastButton == button && f.Input.LastCount == count && r.button_events_accepted == count * 2, "events replayed or unbalanced");
            Check(r.point == new CoordinatePoint(15, 15) && !r.goal_verified && !r.input_ready && !r.release_required, "wrong physical point or completion claim");
            Check(!f.Registry.Validate(Owner, new(image.observation_id), CancellationToken.None).valid, "mutated observation remained live"); f.Closed();
        }
    }
    private static void MenuOwner()
    {
        var f = new Fixture(); var original = f.States.Current.Source;
        var menu = new MenuWindowBinding(original.Window!, original.Window!.Window.Handle, original.Window.Window);
        var source = original with { Window = original.Window with { Menu = menu } };
        f.Images.Current = source; f.States.Current = f.States.Current with { Source = source };
        f.Controls.FocusState = new("unavailable");
        var result = f.Click(f.Publish(controls: true), element: true);
        Check(result.Ok && Receipt(result).method == "mouse" && f.Controls.Invoked == 0 && f.Input.Clicks == 1, "menu owner background invoked directly"); f.Closed();
    }
    private static void Semantics()
    {
        foreach (var item in new[] { (Type: 50000, Pattern: "invoke", Method: "uia_invoke"), (Type: 50002, Pattern: "toggle", Method: "uia_toggle"), (Type: 50019, Pattern: "selection_item", Method: "uia_select") }) {
            var f = new Fixture(); var node = f.Controls.RootNode.Children[0]; node.Raw = node.Raw with { Type = item.Type, Patterns = [item.Pattern] };
            f.Controls.OnInvoke = () => f.States.Current = f.States.Current with { Focus = "changed-by-our-operation" };
            var result = f.Click(f.Publish(controls: true), element: true);
            Check(result.Ok && Receipt(result).method == item.Method && f.Controls.Invoked == 1 && f.Input.Moves == 0 && f.Input.Clicks == 0, "semantic operation not preferred"); f.Closed();
        }
        var missing = new Fixture(); missing.Controls.PatternAvailable = false; var fallback = missing.Click(missing.Publish(controls: true), element: true);
        Check(fallback.Ok && Receipt(fallback).method == "mouse" && missing.Controls.Invoked == 0 && missing.Input.Clicks == 1, "read-only unsupported pattern did not fall back"); missing.Closed();
        foreach (var options in new[] { new ClickOptions("right"), new ClickOptions("middle"), new ClickOptions(Count: 2), new ClickOptions(Method: "mouse") }) {
            var f = new Fixture(); var result = f.Click(f.Publish(controls: true), options, true);
            Check(result.Ok && f.Controls.PreparedPatterns.Count == 0 && f.Controls.Invoked == 0 && f.Input.Clicks == 1, "non-left/single/mouse used a semantic action"); f.Closed();
        }
    }
    private static void SemanticFailure()
    {
        foreach (bool throws in new[] { false, true }) {
            var f = new Fixture(); f.Controls.PatternResult = unchecked((int)0x80004005); f.Controls.ThrowInvoke = throws;
            var result = f.Click(f.Publish(controls: true), element: true);
            Check(!result.Ok && result.Execution == "unknown" && Receipt(result).click_attempted && f.Controls.Invoked == 1 && f.Input.Moves == 0 && f.Input.Clicks == 0, "uncertain semantic operation retried"); f.Closed();
        }
    }
    private static void Stale()
    {
        foreach (string scenario in new[] { "ancestry", "hit", "control", "focus", "image", "window", "blocked" }) {
            var f = new Fixture(); var image = f.Publish(controls: scenario is "ancestry" or "hit" or "control");
            if (scenario == "ancestry") f.Controls.AncestorsValid = false;
            if (scenario == "hit") f.Controls.HitMatches = false;
            if (scenario == "control") f.Controls.RootNode.Children[0].Raw = f.Controls.RootNode.Children[0].Raw with { Key = "replacement" };
            if (scenario == "focus") f.States.Current = f.States.Current with { Focus = "changed" };
            if (scenario == "image") f.Images.Pixels.Bgra[0] = 255;
            if (scenario == "window") f.States.Current = f.States.Current with { Source = f.States.Current.Source with { WindowDpi = 192 } };
            if (scenario == "blocked") f.Input.Allowed = false;
            var result = f.Click(image, element: image.controls != null);
            Check(!result.Ok && result.Execution == "not_executed" && f.Input.Moves == 0 && f.Input.Clicks == 0 && f.Controls.Invoked == 0, "stale target accepted: " + scenario); f.Closed();
        }
    }
    private static void Movement()
    {
        foreach (string scenario in new[] { "blocked", "not_arrived", "hover", "focus", "hit" }) {
            var f = new Fixture(); var image = f.Publish();
            if (scenario == "blocked") f.Input.MoveAccepted = 0;
            if (scenario == "not_arrived") f.Input.Arrived = false;
            if (scenario == "hover") f.Input.OnMove = () => f.Images.Pixels.Bgra[0] = 255;
            if (scenario == "focus") f.Input.OnMove = () => f.States.Current = f.States.Current with { Focus = "changed-on-hover" };
            if (scenario == "hit") f.Input.OnMove = () => f.Input.Allowed = false;
            var result = f.Click(image);
            Check(!result.Ok && f.Input.Moves == 1 && f.Input.Clicks == 0 && f.Input.Releases == 0 && !Receipt(result).click_attempted, "movement failure clicked: " + scenario);
            Check(result.Execution == (scenario == "blocked" ? "not_executed" : "executed"), "movement fact lost"); f.Closed();
        }
    }
    private static void Partial()
    {
        foreach (int count in new[] { 0, 1, 2, 3 }) {
            var f = new Fixture(); f.Input.Accepted = count; var result = f.Click(f.Publish(), new(Count: 2)); var r = Receipt(result);
            Check(!result.Ok && !r.click_completed && r.click_attempted && f.Input.Clicks == 1 && r.button_events_accepted == count, "partial click replayed");
            Check(result.Execution == (count == 0 ? "executed" : "unknown") && f.Input.Releases == (count % 2 == 1 ? 1 : 0), "partial pending button not released exactly once"); f.Closed();
        }
        var failure = new Fixture(); failure.Input.ThrowButtons = true; var unknown = failure.Click(failure.Publish());
        Check(unknown.Execution == "unknown" && Receipt(unknown).button_events_accepted == null && failure.Input.Releases == 1, "exception lost input uncertainty"); failure.Closed();
        var release = new Fixture(); release.Input.Accepted = 1; release.Input.ReleaseAccepted = 0; var failedRelease = release.Click(release.Publish());
        Check(Receipt(failedRelease).release_required && Receipt(failedRelease).release_accepted == 0 && !failedRelease.Ok, "failed release claimed success");
    }
    private static void Cancellation()
    {
        var f = new Fixture(); var image = f.Publish(); using CancellationTokenSource before = new(); before.Cancel();
        var stopped = f.Click(image, token: before.Token); Check(stopped.Execution == "not_executed" && f.Input.Moves == 0, "cancelled task moved cursor");
        var g = new Fixture(); using CancellationTokenSource after = new(); g.Input.OnMove = () => after.Cancel();
        var moved = g.Click(g.Publish(), token: after.Token); Check(moved.Execution == "executed" && g.Input.Clicks == 0 && g.Input.Releases == 0, "cancel after move clicked or released user input");
    }
    private static void Duplicate()
    {
        var f = new Fixture(); string request = Guid.NewGuid().ToString("D");
        Check(f.Click(f.Publish(), request: request).Ok, "first click failed");
        var duplicate = f.Click(f.Publish(), request: request);
        Check(!duplicate.Ok && duplicate.Execution == "not_executed" && f.Input.Moves == 1 && f.Input.Clicks == 1, "request replayed after re-observation");
    }
    private static void PointerFocus()
    {
        var f = new Fixture(); f.States.Current = f.States.Current with { InputTargetReady = false, PointerTargetReady = true };
        var image = f.Publish(controls: true);
        Check(!f.Registry.Validate(Owner, new(image.controls!.observation_id, image.controls.elements[1].element_id, Purpose: "keyboard"), CancellationToken.None).valid, "pointer readiness authorized keyboard input");
        var fresh = f.Publish(); Check(f.Click(fresh).Ok && f.Input.Clicks == 1, "foreground canvas without keyboard focus cannot be clicked");
    }
    private static void Protocol()
    {
        Check(Marshal.SizeOf<ClickInterop.MouseInput>() == 32 && Marshal.SizeOf<ClickInterop.Input>() == 40 && Marshal.OffsetOf<ClickInterop.Input>("Value").ToInt32() == 8, "Windows x64 INPUT ABI mismatch");
        var f = new Fixture(); var image = f.Publish(); var action = new ClickAction(f.Clicks);
        var fields = new Dictionary<string, object?> { ["binding_scope"] = Owner.Scope, ["source_step_id"] = Owner.Step, ["source_token_digest"] = Owner.TokenDigest,
            ["request_id"] = Guid.NewGuid().ToString("D"), ["request_token_digest"] = new string('b', 64), ["observation_id"] = image.observation_id,
            ["element_id"] = null, ["x"] = 5, ["y"] = 5, ["button"] = "left", ["click_count"] = 1, ["method"] = "auto" };
        foreach (string extra in new[] { "hwnd", "desktop_x", "script", "window_id", "permissions" }) {
            fields[extra] = "forged"; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(fields));
            Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "raw override accepted"); fields.Remove(extra);
        }
        Check(f.Input.Moves == 0 && f.Input.Clicks == 0, "invalid native request caused input");
        using var valid = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(valid.RootElement, CancellationToken.None).Ok, "strict native request rejected");
    }
}

internal sealed class FakeClickBackend : IClickBackend
{
    internal bool Allowed = true, Arrived = true, ThrowButtons;
    internal int Moves, Clicks, Releases, MoveAccepted = 1, ReleaseAccepted = 1, LastCount;
    internal int? Accepted;
    internal string? LastButton;
    internal Action? OnMove;
    public bool Guard(WindowSelection window, CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return Allowed; }
    public MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); Moves++; OnMove?.Invoke(); return new(MoveAccepted, Arrived); }
    public int Buttons(WindowSelection window, DesktopPointResolution point, string button, int count, CancellationToken cancellation) { Clicks++; LastButton = button; LastCount = count; if (ThrowButtons) throw new Exception("uncertain input"); return Accepted ?? count * 2; }
    public int Release(string button) { Releases++; return ReleaseAccepted; }
}
