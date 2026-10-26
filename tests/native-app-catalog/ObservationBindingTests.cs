// User-run only. Synthetic windows, controls, pixels and events; never starts helper, COM or desktop IO.
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class ObservationBindingTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ObservationProvenance Owner = new("os_" + new string('a', 32), "11111111-1111-4111-8111-111111111111", new string('a', 64));
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Fixture
    {
        internal DateTime Now = At;
        internal readonly FakeControlBackend Controls;
        internal readonly ControlTreeService Trees;
        internal readonly FakeObservationBackend Images;
        internal readonly FakeObservationState States;
        internal readonly ObservationRegistry Registry;
        internal readonly ObservationRequest Request;
        internal Fixture()
        {
            DiscoveredWindow w = new("0x1234", 42, At.ToString("O"), 43, "Window", "Test", new(null, null, null), true, false, true, true, false, null, "life-A");
            var windows = new WindowCatalog(new FakeWindowDiscovery([w]), () => At);
            using var p = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
            string id = ((WindowPage)windows.List(p.RootElement, CancellationToken.None).Data!).windows.Single().window_id!;
            WindowSelection selection = windows.Resolve(Scope, id, CancellationToken.None)!;
            CaptureRect bounds = new(0, 0, 4, 2);
            CaptureMonitor monitor = new("mon_" + new string('a', 32), new(-100, 0, 1920, 1080), true, 144, 144);
            CaptureSource source = new(bounds, selection, null, [monitor], 144);
            Images = new(source, new(4, 2, new byte[32], At));
            States = new(new(source, "focus-A", "no-popup", "revision-A", true));
            RawControl raw = new("root", 50032, "Window", false, true, false, false, null, new(0, 0, 4, 2), ["window"], true);
            Controls = new(new SyntheticControl(raw, new SyntheticControl(raw with { Key = "edit", Type = 50004, Name = "Search", Focused = true, Patterns = ["text", "value"] })));
            Controls.WindowBounds = bounds;
            Trees = new(windows, Controls, () => Now);
            Registry = new(States, Images, Trees, () => Now);
            Request = new(Scope, "window", id, null, null, 1600, "synthetic");
        }
        internal object Publish(bool tree = false, bool only = false)
        {
            Registry.Invalidate(Owner.Scope);
            ObservationResult image = (ObservationResult)new ObservationService(Images, (_, _) => { }, () => Now).Observe(Request, CancellationToken.None).Data!;
            ControlTreeResult? controls = tree || only ? (ControlTreeResult)Trees.Read(Scope, Request.WindowId!, new(), CancellationToken.None).Data! : null;
            object result = only ? new ControlsOnlyResult(controls!.observation_id, "controls", Request.WindowId!, controls) : image with { controls = controls };
            Registry.Publish(Owner, Request, States.Current, result); return result;
        }
        internal ObservationValidation Validate(string id, string? element = null, string purpose = "inspect", int? x = null, int? y = null) =>
            Registry.Validate(Owner, new(id, element, x, y, purpose), CancellationToken.None);
    }
    internal static void RunAll()
    {
        var cases = new (string Name, Action Run)[] {
            ("observation aliases and private runtime IDs are scoped to the latest read", Binding),
            ("source step token task scope expiry and helper lifetime do not cross observations", Ownership),
            ("window movement topology focus popup lifecycle and event revisions revoke old observations", States),
            ("coordinate checks recapture the original crop and reject pixel and in-check state changes", Pixels),
            ("control runtime identity bounds ancestry focus and availability are freshly read", Elements),
            ("input callback requires a fresh target and is never called for stale or cancelled observations", Dispatch),
            ("native protocol rejects caller overrides and mutation failures conservatively invalidate", Protocol),
            ("bound observe registers only stable results after original action schema validation", BoundObserve),
            ("verified menus tolerate unavailable UIA focus only for pointer/window-key routing and revoke changed contexts", MenuSources)
        };
        foreach (var item in cases) { item.Run(); Console.WriteLine("PASS " + item.Name); }
    }
    private static void Binding()
    {
        var f = new Fixture(); var first = (ObservationResult)f.Publish(tree: true);
        Check(f.Validate(first.observation_id).valid, "image binding missing");
        string element = first.controls!.elements[1].element_id;
        Check(f.Validate(first.observation_id, element).valid && f.Validate(first.controls.observation_id, element, "keyboard").valid, "combined aliases not bound");
        Check(!JsonSerializer.Serialize(first).Contains("\"Key\""), "private identity leaked");
        var second = (ControlsOnlyResult)f.Publish(only: true);
        Check(!f.Validate(first.observation_id).valid && f.Validate(second.observation_id).valid, "superseded observation remained current");
        Check(f.Controls.LiveNodes == 0 && f.Controls.Opened == f.Controls.Closed, "COM-like objects retained");
    }
    private static void MenuSources()
    {
        var ordinary = new Fixture(); ordinary.Controls.FocusState = new("unavailable");
        var ordinaryTree = (ControlsOnlyResult)ordinary.Publish(only: true);
        Check(!ordinary.Validate(ordinaryTree.observation_id, ordinaryTree.controls.elements[1].element_id, "pointer").valid, "ordinary window bypassed unknown focus");
        var f = new Fixture(); CaptureSource original = f.States.Current.Source;
        MenuWindowBinding menu = new(original.Window!, original.Window!.Window.Handle, original.Window.Window);
        CaptureSource source = original with { Window = original.Window with { Menu = menu } };
        f.Images.Current = source; f.States.Current = f.States.Current with { Source = source }; f.Controls.FocusState = new("unavailable");
        var tree = (ControlsOnlyResult)f.Publish(only: true); string element = tree.controls.elements[1].element_id;
        Check(f.Validate(tree.observation_id, element, "pointer").valid, "native menu pointer incorrectly required UIA keyboard focus");
        Check(!f.Validate(tree.observation_id, element, "keyboard").valid, "native menu fabricated focused element");
        tree = (ControlsOnlyResult)f.Publish(only: true); int dispatched = 0;
        var result = f.Registry.WithCurrentWindowKey(Owner, new(tree.observation_id), _ => { dispatched++; return new(true, "executed", "ok", "Synthetic key"); }, CancellationToken.None);
        Check(result.Ok && dispatched == 1, "controls-only menu cannot use verified native window-key route");
        tree = (ControlsOnlyResult)f.Publish(only: true);
        f.States.Current = f.States.Current with { Source = source with { Window = source.Window! with { Menu = new(original.Window, original.Window.Window.Handle, original.Window.Window) } } };
        Check(f.Validate(tree.observation_id).reason == "layout_changed", "new menu inspection context retained old input observation");
    }
    private static void Ownership()
    {
        foreach (string scenario in new[] { "scope", "step", "token", "expiry", "restart" })
        {
            var f = new Fixture(); var image = (ObservationResult)f.Publish();
            var owner = scenario switch { "scope" => Owner with { Scope = "os_" + new string('b', 32) }, "step" => Owner with { Step = Guid.NewGuid().ToString() }, "token" => Owner with { TokenDigest = new string('b', 64) }, _ => Owner };
            if (scenario == "expiry") f.Now = At.AddMinutes(2);
            if (scenario == "restart") f.Registry.Invalidate(Owner.Scope);
            var result = f.Registry.Validate(owner, new(image.observation_id), CancellationToken.None);
            Check(!result.valid && result.action_not_executed && !result.input_ready, "foreign/expired observation passed: " + scenario);
        }
    }
    private static void States()
    {
        foreach (string scenario in new[] { "bounds", "identity", "enabled", "owner", "topology", "dpi", "scale", "focus", "popup", "revision", "mutation" })
        {
            var f = new Fixture(); var image = (ObservationResult)f.Publish(); var original = f.States.Current;
            var source = original.Source; var selected = source.Window!;
            f.States.Current = scenario switch {
                "bounds" => original with { Source = source with { Bounds = new(10, 0, 4, 2) } },
                "identity" => original with { Source = source with { Window = selected with { Window = selected.Window with { Lifetime = "life-B" } } } },
                "enabled" => original with { Source = source with { Window = selected with { Window = selected.Window with { Enabled = false } } } },
                "owner" => original with { Source = source with { Window = selected with { Window = selected.Window with { OwnerHandle = "0x4567" } } } },
                "topology" => original with { Source = source with { Monitors = [source.Monitors[0] with { dpi_x = 192, dpi_y = 192 }] } },
                "dpi" => original with { Source = source with { WindowDpi = 192 } },
                "scale" => original with { Source = source with { Monitors = [source.Monitors[0] with { scale_percent = 200 }] } },
                "focus" => original with { Focus = "focus-B" }, "popup" => original with { Popups = "new-dialog" },
                "revision" => original with { Revision = "moved-and-returned" }, _ => original
            };
            if (scenario == "mutation") f.Registry.InvalidateMutations();
            var result = f.Validate(image.observation_id);
            Check(!result.valid, "changed state passed: " + scenario);
            f.States.Current = original; Check(!f.Validate(image.observation_id).valid, "failed reference revived after state returned");
        }
    }
    private static void Pixels()
    {
        var f = new Fixture(); var image = (ObservationResult)f.Publish(); f.Images.Pixels.Bgra[0] = 255;
        Check(f.Validate(image.observation_id, x: 0, y: 0).reason == "image_changed", "canvas change missed");
        var invalid = new Fixture(); var picture = (ObservationResult)invalid.Publish();
        Check(invalid.Validate(picture.observation_id, x: 4, y: 0).reason == "locator_unavailable", "image overflow accepted");
        var race = new Fixture(); var shot = (ObservationResult)race.Publish(); race.Images.AfterCapture = () => race.States.Current = race.States.Current with { Focus = "changed-during-capture" };
        Check(race.Validate(shot.observation_id).reason == "focus_changed", "state after capture not checked");
        var desktop = new Fixture(); desktop.States.Current = desktop.States.Current with { Source = desktop.States.Current.Source with { Window = null }, InputTargetReady = true };
        var overview = (ObservationResult)desktop.Publish();
        Check(desktop.Validate(overview.observation_id, purpose: "pointer", x: 0, y: 0).reason == "input_target_unavailable", "overview authorized window input");
    }
    private static void Elements()
    {
        foreach (string scenario in new[] { "key", "bounds", "parent", "disabled", "focus", "missing", "incomplete" })
        {
            var f = new Fixture(); var image = (ObservationResult)f.Publish(tree: true); string id = image.controls!.elements[1].element_id;
            SyntheticControl edit = f.Controls.RootNode.Children[0];
            if (scenario == "key") edit.Raw = edit.Raw with { Key = "new-identity-same-name" };
            if (scenario == "bounds") edit.Raw = edit.Raw with { Bounds = new(1, 0, 3, 2) };
            if (scenario == "parent") f.Controls.RootNode.Raw = f.Controls.RootNode.Raw with { Key = "replaced-parent" };
            if (scenario == "disabled") edit.Raw = edit.Raw with { Enabled = false };
            if (scenario == "focus") f.Controls.FocusState = new("outside_target");
            if (scenario == "missing") f.Controls.RootNode.Children.Clear();
            if (scenario == "incomplete") edit.Raw = edit.Raw with { Complete = false };
            f.Controls.Link();
            Check(!f.Validate(image.observation_id, id, "keyboard").valid, "stale element passed: " + scenario);
            Check(f.Controls.LiveNodes == 0, "fresh element lookup leaked a node");
        }
        var stable = new Fixture(); var shot = (ObservationResult)stable.Publish(tree: true); stable.Images.Pixels.Bgra[0] = 255;
        Check(stable.Validate(shot.observation_id, shot.controls!.elements[1].element_id).valid, "unrelated image animation blocked stable UIA target");
    }
    private static void Dispatch()
    {
        var f = new Fixture(); var image = (ObservationResult)f.Publish(); int calls = 0;
        ActionResult Send(ImagePointResolution? point) { Check(point?.desktop == new CoordinatePoint(0, 0), "fresh mapped point not passed to dispatch"); calls++; return new(true, "executed", "ok", "synthetic"); }
        ObservationLocator target = new(image.observation_id, X: 0, Y: 0, Purpose: "pointer");
        Check(f.Registry.WithCurrentObservation(Owner, target, Send, CancellationToken.None).Ok && calls == 1, "fresh dispatch blocked");
        Check(!f.Registry.WithCurrentObservation(Owner, target, Send, CancellationToken.None).Ok && calls == 1, "mutating callback replayed");
        var g = new Fixture(); var next = (ObservationResult)g.Publish(); g.States.Current = g.States.Current with { InputTargetReady = false };
        Check(!g.Registry.WithCurrentObservation(Owner, target with { ObservationId = next.observation_id }, Send, CancellationToken.None).Ok && calls == 1, "wrong input target dispatched");
        using CancellationTokenSource stop = new(); stop.Cancel();
        try { g.Registry.WithCurrentObservation(Owner, target, Send, stop.Token); throw new Exception("cancellation ignored"); } catch (OperationCanceledException) { }
        Check(calls == 1, "cancelled callback ran");
    }
    private static void Protocol()
    {
        var f = new Fixture(); var image = (ObservationResult)f.Publish(); var action = new ValidateObservationAction(f.Registry);
        var fields = new Dictionary<string, object?> { ["binding_scope"] = Owner.Scope, ["source_step_id"] = Owner.Step, ["source_token_digest"] = Owner.TokenDigest,
            ["observation_id"] = image.observation_id, ["element_id"] = null, ["x"] = null, ["y"] = null, ["purpose"] = "inspect" };
        using var valid = JsonDocument.Parse(JsonSerializer.Serialize(fields)); Check(action.Execute(valid.RootElement, CancellationToken.None).Ok, "valid check rejected");
        fields["hwnd"] = "0x1234"; using var invalid = JsonDocument.Parse(JsonSerializer.Serialize(fields));
        Check(action.Execute(invalid.RootElement, CancellationToken.None).Code == "invalid_parameters", "native handle override accepted");
        var mutation = new ObservationInvalidatingAction(new SyntheticMutation("unknown"), f.Registry);
        mutation.Execute(valid.RootElement, CancellationToken.None); Check(!f.Validate(image.observation_id).valid, "uncertain mutation did not invalidate");
    }
    private static void BoundObserve()
    {
        var f = new Fixture();
        var action = new BoundObserveAction(new ObserveAction(new(f.Images, (_, _) => throw new Exception("controls must not write images")), f.Trees), f.Registry);
        Dictionary<string, object?> Request() => new() { ["binding_scope"] = Owner.Scope, ["source_step_id"] = Owner.Step, ["source_token_digest"] = Owner.TokenDigest,
            ["scope_id"] = Scope, ["target"] = "controls", ["window_id"] = f.Request.WindowId, ["monitor_id"] = null, ["crop"] = null, ["max_dimension"] = 1600, ["output_path"] = null,
            ["controls_options"] = new { max_depth = 4, max_elements = 100, timeout_ms = 1200, include_selection = false } };
        var parameters = Request(); using var good = JsonDocument.Parse(JsonSerializer.Serialize(parameters));
        ActionResult result = action.Execute(good.RootElement, CancellationToken.None);
        Check(result.Ok && result.Data is ControlsOnlyResult && f.Images.Captures == 0, "bound controls action lost original behavior");
        string id = ((ControlsOnlyResult)result.Data!).observation_id; Check(f.Validate(id).valid, "successful bound result not registered");
        parameters["script"] = "injected"; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(parameters));
        Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters" && !f.Validate(id).valid, "unknown fields or failed capture retained binding");
        f.Controls.AfterRead = _ => f.States.Current = f.States.Current with { Revision = "changed-during-uia" };
        var changed = action.Execute(good.RootElement, CancellationToken.None);
        Check(changed.Code == "stale_observation" && changed.Execution == "executed", "inconsistent read published reusable IDs");
        Check(f.Controls.LiveNodes == 0 && f.Controls.Opened == f.Controls.Closed, "bound action retained native nodes");
    }
}

internal sealed class FakeObservationState(ObservationState state) : IObservationStateBackend
{
    internal ObservationState Current = state;
    public ObservationState Read(ObservationRequest request, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return Current; }
}
internal sealed class SyntheticMutation(string execution) : IWindowsAction
{
    public string Name => "synthetic_mutation";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation) => new(false, execution, "unavailable", "Synthetic mutation");
}
