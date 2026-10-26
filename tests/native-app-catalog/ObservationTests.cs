// User-run only. Synthetic pixels and sources; never capture a desktop or write screenshot files.
using System.Buffers.Binary;
using System.IO.Compression;
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class ObservationTests
{
    private static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    private static readonly CaptureMonitor Monitor = new("mon_" + new string('a', 32), new(-1920, -100, 4, 2), true, 144, 144);
    private static ObservationRequest Request(string target = "desktop", CaptureRect? crop = null, int maximum = 1600) => new("ws_" + new string('b', 32), target, null, null, crop, maximum, "unused-test-output");
    private static void Check(bool value, string reason) { if (!value) throw new Exception(reason); }
    private static ObservationResult Data(ActionResult result) { Check(result.Ok, result.Message); return (ObservationResult)result.Data!; }
    internal static void RunAll()
    {
        var cases = new (string Name, Action Run)[] {
            ("desktop screenshot preserves negative desktop origin, DPI, source and actual image dimensions", Desktop),
            ("region crop uses source pixels and rejects out of bounds before capture", Crop),
            ("resize keeps aspect ratio without upscale and has exact inverse transform", Resize),
            ("PNG contains the selected RGB pixels with no row padding or alpha", Png),
            ("window replacement and changed geometry invalidate the capture", Changed),
            ("monitor topology or frame size change cannot publish a usable observation", MonitorChanged),
            ("cancel before capture or after capture never publishes an attachment", Cancelled),
            ("protected unavailable or minimized sources preserve their typed preflight result", Blocked),
            ("pixel and image resource budgets reject malformed buffers", Limits),
            ("native parameters cannot provide arbitrary output paths handles or duplicate locators", Parameters)
        };
        foreach (var item in cases) { item.Run(); Console.WriteLine("PASS " + item.Name); }
    }
    private static (FakeObservationBackend Backend, ObservationService Service, List<byte[]> Files) Fixture()
    {
        FakeObservationBackend backend = new(new(Monitor.bounds, null, Monitor, [Monitor]), new(4, 2, Enumerable.Range(0, 32).Select(value => (byte)value).ToArray(), At));
        List<byte[]> files = [];
        return (backend, new(backend, (_, bytes) => files.Add(bytes), () => At), files);
    }
    private static void Desktop()
    {
        var f = Fixture(); var data = Data(f.Service.Observe(Request(), CancellationToken.None));
        Check(data.source_bounds == Monitor.bounds && data.monitors.Single().dpi_x == 144 && data.transform.origin_x == -1920 && data.transform.origin_y == -100, "lost physical origin");
        Check(data.image.width == 4 && data.image.height == 2 && f.Files.Count == 1 && data.observation_id.StartsWith("obs_"), "missing screenshot");
        Check(data.geometry_consistent && !data.content_verified && !data.input_ready && !data.goal_verified && data.image.size_bytes == f.Files[0].Length, "image claimed content or input grant");
    }
    private static void Crop()
    {
        var f = Fixture(); var data = Data(f.Service.Observe(Request("region", new(1, 0, 2, 2)), CancellationToken.None));
        Check(data.image.width == 2 && data.image.height == 2 && data.transform.origin_x == -1919 && data.crop.x == 1, "wrong crop mapping");
        var bad = Fixture(); var result = bad.Service.Observe(Request("region", new(3, 0, 2, 2)), CancellationToken.None);
        Check(result.Code == "invalid_parameters" && result.Execution == "not_executed" && bad.Backend.Captures == 0 && bad.Files.Count == 0, "cropped outside source");
    }
    private static void Resize()
    {
        var f = Fixture(); var monitor = Monitor with { bounds = new(-100, 50, 1000, 501) };
        f.Backend.Current = new(monitor.bounds, null, monitor, [monitor]); f.Backend.Pixels = new(1000, 501, new byte[1000 * 501 * 4], At);
        var data = Data(f.Service.Observe(Request(maximum: 256), CancellationToken.None));
        Check(data.image.width == 256 && data.image.height == 128 && data.transform.scale_x == 1000d / 256 && data.transform.scale_y == 501d / 128, "approximate scaling used");
    }
    private static void Png()
    {
        var f = Fixture(); var data = Data(f.Service.Observe(Request("region", new(1, 0, 1, 1)), CancellationToken.None)); byte[] png = f.Files.Single();
        Check(BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16)) == 1 && png[25] == 2, "invalid PNG header");
        int length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(33));
        using MemoryStream compressed = new(png, 41, length); using ZLibStream zlib = new(compressed, CompressionMode.Decompress); using MemoryStream row = new(); zlib.CopyTo(row);
        Check(row.ToArray().SequenceEqual(new byte[] { 0, 6, 5, 4 }), "wrong BGRA to RGB conversion or selected pixel");
        Check(data.image.sha256.Length == 64, "missing digest");
    }
    private static void Changed()
    {
        var f = Fixture(); f.Backend.AfterCapture = () => f.Backend.Current = f.Backend.Current with { Bounds = new(10, 20, 4, 2) };
        var result = f.Service.Observe(Request(), CancellationToken.None); Check(result.Code == "stale_observation" && result.Execution == "executed" && f.Files.Count == 0, "moved source published");
        var w = new DiscoveredWindow("0x12", 42, At.ToString("O"), 43, "Test", "Synthetic", new(null, null, null), true, false, false, true, false, null, "lifetime-A");
        var replacement = Fixture(); replacement.Backend.Current = new(Monitor.bounds, new("scope", "snapshot", "window", w), null, [Monitor]);
        replacement.Backend.AfterCapture = () => replacement.Backend.Current = replacement.Backend.Current with { Window = replacement.Backend.Current.Window! with { Window = w with { Lifetime = "lifetime-B" } } };
        Check(replacement.Service.Observe(Request(), CancellationToken.None).Code == "stale_observation" && replacement.Files.Count == 0, "reused window published");
    }
    private static void MonitorChanged()
    {
        var f = Fixture(); f.Backend.AfterCapture = () => f.Backend.Current = f.Backend.Current with { Monitors = [Monitor with { dpi_x = 192 }] };
        Check(f.Service.Observe(Request(), CancellationToken.None).Code == "stale_observation" && f.Files.Count == 0, "topology change ignored");
        var size = Fixture(); size.Backend.Pixels = new(2, 2, new byte[16], At);
        Check(size.Service.Observe(Request(), CancellationToken.None).Code == "stale_observation" && size.Files.Count == 0, "undefined frame padding published");
    }
    private static void Cancelled()
    {
        using CancellationTokenSource before = new(); before.Cancel(); var f = Fixture();
        Check(f.Service.Observe(Request(), before.Token).Execution == "not_executed" && f.Backend.Captures == 0, "cancelled request captured");
        using CancellationTokenSource after = new(); var g = Fixture(); g.Backend.AfterCapture = () => after.Cancel();
        var result = g.Service.Observe(Request(), after.Token); Check(result.Code == "cancelled" && result.Execution == "executed" && g.Files.Count == 0, "cancelled capture published");
    }
    private static void Blocked()
    {
        foreach (string code in new[] { "capture_blocked", "restore_required", "stale_window", "unavailable" })
        {
            var f = Fixture(); f.Backend.Failure = code;
            var result = f.Service.Observe(Request(), CancellationToken.None); Check(result.Code == code && result.Execution == "not_executed" && f.Backend.Captures == 0 && f.Files.Count == 0, "typed preflight lost");
        }
    }
    private static void Limits()
    {
        foreach (var pixels in new[] { new CapturedPixels(4, 2, new byte[1], At), new CapturedPixels(32768, 32768, [], At) })
        {
            try { ObservationPng.Encode(pixels, new(0, 0, 4, 2), 1600, CancellationToken.None); throw new Exception("invalid pixel buffer accepted"); }
            catch (ObservationException error) { Check(error.Code == "invalid_parameters", "unexpected failure"); }
        }
    }
    private static void Parameters()
    {
        var f = Fixture(); var action = new ObserveAction(f.Service);
        foreach (object p in new object[] { new { }, new { hwnd = "0x12" }, new { scope_id = "forged", output_path = @"C:\arbitrary.png" },
            new { scope_id = "ws_" + new string('b', 32), target = "desktop", window_id = (string?)null, monitor_id = (string?)null, crop = (object?)null, max_dimension = 1600, output_path = @"C:\arbitrary.png" } })
        {
            using var doc = JsonDocument.Parse(JsonSerializer.Serialize(p)); Check(action.Execute(doc.RootElement, CancellationToken.None).Code == "invalid_parameters", "raw output accepted");
        }
        Check(f.Backend.Captures == 0 && f.Files.Count == 0, "invalid params captured");
    }
}

internal sealed class FakeObservationBackend(CaptureSource source, CapturedPixels pixels) : IObservationBackend
{
    internal CaptureSource Current = source;
    internal CapturedPixels Pixels = pixels;
    internal Action? AfterCapture;
    internal string? Failure;
    internal int Captures;
    public CaptureSource Source(ObservationRequest request, CancellationToken cancellation)
    { cancellation.ThrowIfCancellationRequested(); if (Failure != null) throw new ObservationException(Failure); return Current; }
    public CapturedPixels Capture(CaptureSource source, CancellationToken cancellation)
    { cancellation.ThrowIfCancellationRequested(); Captures++; AfterCapture?.Invoke(); return Pixels; }
}
