// User-run only: synthetic image, native guards and input acknowledgements. No real input/helper/Electron.
using System.Reflection;
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class DragTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ObservationProvenance Owner = new("os_" + new string('a', 32), "11111111-1111-4111-8111-111111111111", new string('a', 64));
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static readonly CoordinatePoint[] Path = [new(5, 5), new(70, 50), new(5, 60)];
    private sealed class Fixture
    {
        internal readonly FakeObservationBackend Images; internal readonly FakeObservationState States;
        internal readonly FakeDragBackend Input; internal readonly ObservationRegistry Registry; internal readonly DragService Drags;
        internal readonly ObservationRequest Request;
        internal Fixture() {
            DiscoveredWindow w = new("0x1234", 42, At.ToString("O"), 43, "Window", "Test", new(null, null, null), true, false, true, true, false, null, "life");
            WindowCatalog windows = new(new FakeWindowDiscovery([w]), () => At);
            using var p = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
            string id = ((WindowPage)windows.List(p.RootElement, CancellationToken.None).Data!).windows.Single().window_id!;
            CaptureRect bounds = new(10, 10, 100, 80); CaptureMonitor monitor = new("mon_" + new string('a', 32), new(0, 0, 1920, 1080), true, 96, 96, 100);
            CaptureSource source = new(bounds, windows.Resolve(Scope, id, CancellationToken.None), null, [monitor], 96);
            Images = new(source, new(100, 80, new byte[100 * 80 * 4], At)); States = new(new(source, "focus", "popups", "revision", true));
            RawControl root = new("root", 50032, "Window", false, true, false, false, null, new(10, 10, 100, 80), ["window"], true);
            ControlTreeService trees = new(windows, new FakeControlBackend(new SyntheticControl(root)), () => At);
            Registry = new(States, Images, trees, () => At); Input = new(Images); Drags = new(Registry, Input, () => At);
            Request = new(Scope, "window", id, null, null, 1600, "synthetic");
        }
        internal ObservationResult Publish() {
            Registry.Invalidate(Owner.Scope);
            var image = (ObservationResult)new ObservationService(Images, (_, _) => { }, () => At).Observe(Request, CancellationToken.None).Data!;
            Registry.Publish(Owner, Request, States.Current, image); return image;
        }
        internal ActionResult Drag(ObservationResult image, DragOptions? options = null, string? request = null, CancellationToken token = default) =>
            Drags.Drag(Owner, image.observation_id, options ?? new(Path), request ?? Guid.NewGuid().ToString("D"), token);
    }
    private static DragReceipt Receipt(ActionResult r) => (DragReceipt)r.Data!;
    internal static void RunAll() {
        Geometry(); Complete(); Stale(); HoverRepaint(); Interrupted(); Receipts(); Cancellation(); Protocol();
        Console.WriteLine("PASS drag bounded paths, guards, accepted prefixes, cancellation and cleanup (synthetic)");
    }
    private static void Geometry() {
        using Stream data = Assembly.GetExecutingAssembly().GetManifestResourceStream("windows-drag-cases.json")!;
        using var document = JsonDocument.Parse(data);
        foreach (JsonElement row in document.RootElement.EnumerateArray()) {
            CoordinatePoint[] Read(string key) => row.GetProperty(key).EnumerateArray().Select(p => new CoordinatePoint(p.GetProperty("x").GetInt32(), p.GetProperty("y").GetInt32())).ToArray();
            Check(DragPath.Interpolate(Read("anchors"))!.SequenceEqual(Read("points")), "shared interpolation mismatch: " + row.GetProperty("name").GetString());
        }
        Check(DragPath.Interpolate([new(0, 0), new(4096, 0)])!.Length == 257 && DragPath.Interpolate([new(0, 0), new(4097, 0)]) == null, "segment cap wrong");
        Check(DragPath.Interpolate([new(1, 1), new(1, 1)]) == null, "collapsed segment accepted");
        var f = new Fixture(); var image = f.Publish();
        Check(DragPath.Resolve(image, f.Images.Current, [new(5, 5), new(100, 5)]) == null, "outside image endpoint accepted");
        CaptureMonitor[] gap = [new("left", new(0, 0, 45, 1080), true, 96, 96, 100), new("right", new(46, 0, 1874, 1080), false, 96, 96, 100)];
        var gapped = f.Images.Current with { Monitors = gap };
        var gapImage = image with { monitors = gap, coordinate_context = new("per_monitor_v2", CoordinateMapper.VirtualBounds(gap), 96) };
        Check(DragPath.Resolve(gapImage, gapped, [new(5, 5), new(70, 5)]) == null, "raster path skipped a one-pixel display gap");
    }
    private static void Complete() {
        foreach (string button in new[] { "left", "right", "middle" }) {
            var f = new Fixture(); var image = f.Publish();
            f.Input.AfterDown = () => { f.States.Current = f.States.Current with { Focus = "own-focus/capture", Revision = "own-canvas-change", InputTargetReady = false }; f.Images.Pixels.Bgra[0] = 255; };
            var result = f.Drag(image, new(Path, button, 3000)); var r = Receipt(result);
            Check(result.Ok && result.Execution == "executed" && r.drag_completed && !r.drag_verified && !r.goal_verified && !r.input_ready, "complete drag result wrong");
            Check(f.Input.DownCalls == 1 && f.Input.UpCalls == 1 && f.Input.Moves == r.segments_planned + 1 && r.segments.Length == r.segments_planned && f.Input.Waited == 3000, "unbalanced/replayed gesture or duration");
            Check(r.start == new CoordinatePoint(15, 15) && r.end == new CoordinatePoint(15, 70) && !r.release_required && !r.release_attempted, "physical endpoint or cleanup wrong");
            Check(!f.Registry.Validate(Owner, new(image.observation_id), CancellationToken.None).valid, "drag left old observation live");
            Check(f.Input.LastButton == button, "button replaced");
        }
    }
    private static void Stale() {
        foreach (string scenario in new[] { "image", "focus", "dpi", "route", "hover_route" }) {
            var f = new Fixture(); var image = f.Publish();
            if (scenario == "image") Array.Fill(f.Images.Pixels.Bgra, (byte)255);
            if (scenario == "focus") f.Input.Allowed = false;
            if (scenario == "dpi") f.States.Current = f.States.Current with { Source = f.States.Current.Source with { WindowDpi = 192 } };
            if (scenario == "route") f.Input.Allowed = false;
            if (scenario == "hover") f.Input.AfterMove = n => { if (n == 1) f.Images.Pixels.Bgra[0] = 255; };
            if (scenario == "hover_route") f.Input.AfterMove = n => { if (n == 1) f.Input.Allowed = false; };
            var result = f.Drag(image);
            Check(!result.Ok && f.Input.DownCalls == 0 && f.Input.UpCalls == 0 && f.Input.Moves == (scenario.StartsWith("hover") ? 1 : 0), "stale image/route started drag: " + scenario);
        }
    }
    private static void HoverRepaint() {
        var f = new Fixture(); var image = f.Publish();
        f.Input.AfterMove = n => { if (n == 1) { Array.Fill(f.Images.Pixels.Bgra, (byte)255); f.States.Current = f.States.Current with { Revision = "hover-handles", Focus = "internal-focus" }; } };
        Check(f.Drag(image).Ok && f.Input.DownCalls == 1 && f.Input.UpCalls == 1, "ordinary hover paint blocked drag or unbalanced the button");
    }
    private static void Interrupted() {
        foreach (string scenario in new[] { "window", "dpi", "monitor", "cursor", "capture", "foreground", "user_button", "not_arrived" }) {
            var f = new Fixture(); var image = f.Publish();
            f.Input.AfterMove = n => { if (n != 2) return;
                if (scenario == "window") f.Images.Current = f.Images.Current with { Bounds = new(11, 10, 100, 80) };
                else if (scenario == "dpi") f.Images.Current = f.Images.Current with { WindowDpi = 192 };
                else if (scenario == "monitor") f.Images.Current = f.Images.Current with { Monitors = [] };
                else if (scenario == "cursor") f.Input.Cursor = new(999, 999);
                else if (scenario == "not_arrived") f.Input.Arrived = false;
                else f.Input.Allowed = false;
            };
            var result = f.Drag(image); var r = Receipt(result);
            Check(!result.Ok && result.Execution == "unknown" && !r.drag_completed && r.release_required && r.release_attempted && r.release_accepted == 1, "interrupted drag lost uncertainty/cleanup: " + scenario);
            Check(f.Input.DownCalls == 1 && f.Input.UpCalls == 1 && f.Input.Moves <= 3, "interruption continued or replayed path");
        }
    }
    private static void Receipts() {
        foreach (string scenario in new[] { "move_zero", "move_unknown", "move_arrival", "down_zero", "down_unknown", "confirm", "segment_zero", "segment_unknown", "up_zero", "up_unknown", "cleanup_zero", "cleanup_unknown" }) {
            var f = new Fixture(); var image = f.Publish();
            if (scenario == "move_zero") f.Input.MoveAccepted = 0;
            if (scenario == "move_unknown") f.Input.ThrowMove = 1;
            if (scenario == "move_arrival") f.Input.Arrived = false;
            if (scenario == "down_zero") f.Input.DownAccepted = 0;
            if (scenario == "down_unknown") f.Input.ThrowDown = true;
            if (scenario == "confirm") f.Input.Confirmed = false;
            if (scenario == "segment_zero") f.Input.AfterDown = () => f.Input.MoveAccepted = 0;
            if (scenario == "segment_unknown") f.Input.ThrowMove = 2;
            if (scenario == "up_zero") f.Input.UpAccepted = 0;
            if (scenario == "up_unknown") f.Input.ThrowUp = true;
            if (scenario.StartsWith("cleanup")) { f.Input.Confirmed = false; f.Input.UpAccepted = 0; f.Input.ThrowUp = scenario.EndsWith("unknown"); }
            var result = f.Drag(image); var r = Receipt(result);
            Check(!result.Ok && !r.drag_completed && f.Input.DownCalls <= 1, "failed gesture replayed or succeeded: " + scenario);
            if (scenario.StartsWith("move") || scenario == "down_zero") Check(!r.release_required && f.Input.UpCalls == 0, "released a button never submitted");
            else Check(r.release_attempted && f.Input.UpCalls == (scenario.StartsWith("up_") ? 2 : 1) && result.Execution == "unknown", "partial gesture cleanup wrong: " + scenario);
        }
    }
    private static void Cancellation() {
        foreach (string stage in new[] { "before", "move", "down", "segment", "pause" }) {
            var f = new Fixture(); var image = f.Publish(); using var cancel = new CancellationTokenSource();
            if (stage == "before") cancel.Cancel();
            if (stage == "move") f.Input.AfterMove = n => { if (n == 1) cancel.Cancel(); };
            if (stage == "down") f.Input.AfterDown = cancel.Cancel;
            if (stage == "segment") f.Input.AfterMove = n => { if (n == 2) cancel.Cancel(); };
            if (stage == "pause") f.Input.AfterPause = cancel.Cancel;
            var result = f.Drag(image, token: cancel.Token);
            Check(result.Code == "cancelled" && !Receipt(result).drag_completed && f.Input.DownCalls <= 1, "cancel continued gesture: " + stage);
            Check(f.Input.UpCalls == (stage is "down" or "segment" or "pause" ? 1 : 0), "cancel released wrong button or missed cleanup");
        }
    }
    private static void Protocol() {
        var d = new Fixture(); string request = Guid.NewGuid().ToString("D"); Check(d.Drag(d.Publish(), request: request).Ok, "initial gesture failed");
        int moves = d.Input.Moves; var duplicate = d.Drag(d.Publish(), request: request);
        Check(!duplicate.Ok && duplicate.Execution == "not_executed" && d.Input.Moves == moves && d.Input.DownCalls == 1, "new observation replayed consumed gesture");
        var f = new Fixture(); var image = f.Publish(); DragAction action = new(f.Drags);
        Dictionary<string, object?> p = new() { ["binding_scope"] = Owner.Scope, ["source_step_id"] = Owner.Step, ["source_token_digest"] = Owner.TokenDigest,
            ["request_id"] = Guid.NewGuid().ToString("D"), ["request_token_digest"] = new string('b', 64), ["observation_id"] = image.observation_id, ["path"] = Path, ["button"] = "left", ["duration_ms"] = 600 };
        foreach (string extra in new[] { "hwnd", "script", "element_id", "repeat", "modifiers", "pressure" }) {
            p[extra] = 1; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(p)); Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "raw override accepted"); p.Remove(extra);
        }
        foreach (object invalid in new object[] { Array.Empty<CoordinatePoint>(), new[] { new CoordinatePoint(5, 5) }, new[] { new CoordinatePoint(5, 5), new CoordinatePoint(5, 5) }, new[] { new { x = 5, y = 5, z = 1 }, new { x = 10, y = 10, z = 1 } } }) {
            p["path"] = invalid; using var bad = JsonDocument.Parse(JsonSerializer.Serialize(p)); Check(action.Execute(bad.RootElement, CancellationToken.None).Code == "invalid_parameters", "bad path accepted");
        }
        p["path"] = Path; Check(f.Input.Moves == 0, "invalid protocol caused movement");
        using var valid = JsonDocument.Parse(JsonSerializer.Serialize(p)); Check(action.Execute(valid.RootElement, CancellationToken.None).Ok, "valid drag protocol rejected");
    }
}
internal sealed class FakeDragBackend(FakeObservationBackend images) : IDragBackend
{
    internal bool Allowed = true, Arrived = true, Confirmed = true, ThrowDown, ThrowUp;
    internal int Moves, DownCalls, UpCalls, Waited, MoveAccepted = 1, DownAccepted = 1, UpAccepted = 1, ThrowMove;
    internal CoordinatePoint? Cursor; internal string? LastButton;
    internal Action<int>? AfterMove; internal Action? AfterDown, AfterPause;
    public bool Guard(CaptureSource source, CoordinatePoint point, CoordinatePoint? cursor, string button, bool holding, CancellationToken cancellation) {
        cancellation.ThrowIfCancellationRequested();
        return Allowed && source.Bounds == images.Current.Bounds && source.WindowDpi == images.Current.WindowDpi && source.Monitors.SequenceEqual(images.Current.Monitors) && (cursor == null || cursor == Cursor);
    }
    public MouseMoveResult Move(DesktopPointResolution point, CancellationToken cancellation) {
        cancellation.ThrowIfCancellationRequested(); Moves++; if (ThrowMove == Moves) throw new Exception("uncertain move");
        if (MoveAccepted == 1) Cursor = point.Desktop;
        AfterMove?.Invoke(Moves); return new(MoveAccepted, MoveAccepted == 1 && Arrived);
    }
    public int Down(CaptureSource source, DesktopPointResolution point, string button, CancellationToken cancellation) { DownCalls++; LastButton = button; if (ThrowDown) throw new Exception("uncertain down"); AfterDown?.Invoke(); return DownAccepted; }
    public bool ConfirmDown(string button, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return Confirmed; }
    public bool Pause(CaptureSource source, CoordinatePoint point, string button, int milliseconds, CancellationToken cancellation) { Waited += milliseconds; AfterPause?.Invoke(); return Guard(source, point, point, button, true, cancellation); }
    public int Up(string button) { UpCalls++; if (ThrowUp) throw new Exception("uncertain up"); return UpAccepted; }
}
