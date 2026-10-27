// User-run only. Synthetic desktop pixels and a fake window-under-point; never calls SendInput or starts helper.
using Web2Term.WindowsHelper;

internal static class DesktopClickTests
{
    private static readonly DateTime At = new(2026, 10, 26, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly ObservationProvenance Owner = new("os_" + new string('b', 32), "22222222-2222-4222-8222-222222222222", new string('b', 64));
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }

    private sealed class FakeDesktop : IDesktopClickBackend
    {
        internal string? Target = "0x99:4242:Shell_TrayWnd";
        internal string? AfterMove;
        internal int Buttons, Lookups;
        internal string? LastButton;
        internal int LastCount;
        public string? DesktopTarget(CoordinatePoint point, bool cursorAtPoint, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested(); Lookups++;
            return cursorAtPoint && AfterMove != null ? AfterMove : Target;
        }
        public int DesktopButtons(DesktopPointResolution point, string target, string button, int count, CancellationToken cancellation)
        { Buttons++; LastButton = button; LastCount = count; return count * 2; }
    }

    private static CapturedPixels Pattern(int width, int height)
    {
        byte[] bgra = new byte[width * height * 4];
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            int o = (y * width + x) * 4; bgra[o] = (byte)(x * 7); bgra[o + 1] = (byte)(y * 11); bgra[o + 2] = (byte)((x + y) * 3); bgra[o + 3] = 255;
        }
        return new(width, height, bgra, At);
    }
    private static CapturedPixels Paint(CapturedPixels pixels, int left, int top, int width, int height)
    {
        byte[] bgra = (byte[])pixels.Bgra.Clone();
        for (int y = top; y < top + height; y++) for (int x = left; x < left + width; x++) {
            int o = (y * pixels.Width + x) * 4; bgra[o] = 255; bgra[o + 1] = 0; bgra[o + 2] = 255;
        }
        return pixels with { Bgra = bgra };
    }

    private sealed class Fixture
    {
        internal readonly FakeObservationBackend Images;
        internal readonly ObservationRegistry Registry;
        internal readonly FakeClickBackend Input = new();
        internal readonly FakeDesktop Desktop = new();
        internal readonly ClickService Clicks;
        internal readonly ObservationRequest Request = new(Scope, "desktop", null, null, null, 1600, "synthetic");
        private readonly FakeObservationState states;
        internal Fixture(bool desktopBackend = true)
        {
            CaptureMonitor monitor = new("mon_" + new string('b', 32), new(0, 0, 200, 100), true, 96, 96, 100);
            CaptureSource source = new(new(0, 0, 200, 100), null, monitor, [monitor]);
            Images = new(source, Pattern(200, 100));
            states = new(new(source, "focus", "popups", "revision", false));
            ControlTreeService trees = new(new WindowCatalog(new FakeWindowDiscovery([]), () => At), new FakeControlBackend(null!), () => At);
            Registry = new(states, Images, trees, () => At);
            Clicks = new(Registry, trees, Input, () => At, desktopBackend ? Desktop : null);
        }
        internal ObservationResult Publish()
        {
            Registry.Invalidate(Owner.Scope);
            var image = (ObservationResult)new ObservationService(Images, (_, _) => { }, () => At).Observe(Request, CancellationToken.None).Data!;
            Registry.Publish(Owner, Request, states.Current, image); return image;
        }
        internal ActionResult Click(ObservationResult image, int x = 150, int y = 90, ClickOptions? options = null, string? element = null) =>
            Clicks.Click(Owner, new(image.observation_id, element, element == null ? x : null, element == null ? y : null, "pointer"), options ?? new(), Guid.NewGuid().ToString("D"), CancellationToken.None);
    }

    internal static void RunAll()
    {
        var cases = new (string Name, Action Run)[] {
            ("own PNG output decodes back to the exact sampled pixels", Decode),
            ("only changes near the point block a desktop click", Patch),
            ("a desktop observation is clicked at its mapped physical point with balanced buttons", Clicked),
            ("changed pixels near the point stop the click before any movement", Changed),
            ("a blocked point or a changed window after the move dispatches no button", Blocked),
            ("element locators and a missing desktop backend keep the business-window rule", Unsupported)
        };
        foreach (var item in cases) { item.Run(); Console.WriteLine("PASS " + item.Name); }
    }
    private static void Decode()
    {
        CapturedPixels pixels = Pattern(64, 40);
        var encoded = ObservationPng.Encode(pixels, new(4, 2, 50, 30), 256, CancellationToken.None);
        var decoded = ObservationPng.DecodeOwn(encoded.Bytes);
        Check(decoded is { Width: 50, Height: 30 }, "decoded size");
        Check(ObservationPng.PatchMatches(decoded!.Value, pixels, new(4, 2, 50, 30), 25, 15, radius: 100, tolerance: 0), "every sampled pixel round-trips");
        byte[] broken = (byte[])encoded.Bytes.Clone(); broken[0] = 0;
        Check(ObservationPng.DecodeOwn(broken) == null, "foreign data is never decoded");
    }
    private static void Patch()
    {
        CapturedPixels pixels = Pattern(200, 100);
        var seen = ObservationPng.DecodeOwn(ObservationPng.Encode(pixels, new(0, 0, 200, 100), 1600, CancellationToken.None).Bytes)!.Value;
        CaptureRect all = new(0, 0, 200, 100);
        Check(ObservationPng.PatchMatches(seen, pixels, all, 150, 90), "unchanged screen matches");
        Check(ObservationPng.PatchMatches(seen, Paint(pixels, 0, 0, 60, 40), all, 150, 90), "a distant change (the clock, another window) is ignored");
        Check(ObservationPng.PatchMatches(seen, Paint(pixels, 150, 90, 3, 3), all, 150, 90), "a blinking caret-sized change is tolerated");
        Check(!ObservationPng.PatchMatches(seen, Paint(pixels, 130, 70, 40, 30), all, 150, 90), "a popup covering the point blocks");
    }
    private static void Clicked()
    {
        foreach (string button in new[] { "left", "right" }) foreach (int count in new[] { 1, 2 }) {
            var f = new Fixture(); var image = f.Publish();
            Check(image.source_png != null, "desktop observations keep their PNG privately");
            var result = f.Click(image, options: new(button, count)); var receipt = (ClickReceipt)result.Data!;
            Check(result.Ok && result.Execution == "executed" && receipt.method == "mouse" && receipt.click_completed, "desktop click failed: " + result.Code);
            Check(receipt.window_id == null && receipt.point == new CoordinatePoint(150, 90), "receipt names the desktop point, not a window");
            Check(f.Input.Moves == 1 && f.Desktop.Buttons == 1 && f.Desktop.LastButton == button && f.Desktop.LastCount == count && receipt.button_events_accepted == count * 2, "unbalanced or replayed");
            Check(f.Click(image).Code == "stale_observation" && f.Desktop.Buttons == 1, "a consumed observation cannot click again");
        }
    }
    private static void Changed()
    {
        var f = new Fixture(); var image = f.Publish();
        f.Images.Pixels = Paint(f.Images.Pixels, 130, 70, 40, 30);
        var result = f.Click(image);
        Check(result.Code == "stale_observation" && result.Execution == "not_executed" && f.Input.Moves == 0 && f.Desktop.Buttons == 0, "changed point still clicked");
        Check(result.Data is ClickReceipt { validation.reason: "image_changed" }, "reason names the local image change");
        var g = new Fixture(); var other = g.Publish();
        g.Images.Pixels = Paint(g.Images.Pixels, 0, 0, 60, 40);
        Check(g.Click(other).Ok, "a distant change does not block the click");
    }
    private static void Blocked()
    {
        var f = new Fixture(); var image = f.Publish(); f.Desktop.Target = null;
        var result = f.Click(image);
        Check(result.Code == "click_blocked" && result.Execution == "not_executed" && f.Input.Moves == 0, "a control-plane or secure point was clicked");
        var g = new Fixture(); var other = g.Publish(); g.Desktop.AfterMove = "0x77:1717:Other";
        var moved = g.Click(other);
        Check(moved.Code == "click_blocked" && g.Input.Moves == 1 && g.Desktop.Buttons == 0 && moved.Execution == "executed", "a changed window under the pointer still received buttons");
    }
    private static void Unsupported()
    {
        var f = new Fixture(); var image = f.Publish();
        Check(f.Click(image, element: "el_" + new string('c', 32)).Code == "stale_observation" && f.Input.Moves == 0, "element locator accepted on a desktop image");
        var g = new Fixture(desktopBackend: false); var other = g.Publish();
        var result = g.Click(other);
        Check(result.Code == "stale_observation" && result.Data is ClickReceipt { validation.reason: "input_target_unavailable" } && g.Input.Moves == 0, "desktop click ran without its backend");
    }
}
