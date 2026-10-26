// User-run only. Same golden vectors as TypeScript. No Win32, UIA, helper startup, capture or input.
using System.Reflection;
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class CoordinateTests
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static CaptureRect Rect(JsonElement row) => new(row[0].GetInt32(), row[1].GetInt32(), row[2].GetInt32(), row[3].GetInt32());
    internal static void RunAll()
    {
        using Stream data = Assembly.GetExecutingAssembly().GetManifestResourceStream("windows-coordinate-cases.json")!;
        using JsonDocument document = JsonDocument.Parse(data);
        foreach (JsonElement v in document.RootElement.EnumerateArray())
        {
            CaptureRect source = Rect(v.GetProperty("source"));
            CaptureRect crop = v.TryGetProperty("crop", out JsonElement c) ? Rect(c) : new(0, 0, source.width, source.height);
            int width = v.GetProperty("image")[0].GetInt32(), height = v.GetProperty("image")[1].GetInt32();
            CaptureRect content = v.TryGetProperty("content", out JsonElement b) ? Rect(b) : new(0, 0, width, height);
            CaptureMonitor[] monitors = v.GetProperty("monitors").EnumerateArray().Select(m => new CaptureMonitor(m[0].GetString()!,
                new(m[1].GetInt32(), m[2].GetInt32(), m[3].GetInt32(), m[4].GetInt32()), m[6].GetBoolean(), m[5].GetUInt32(), m[5].GetUInt32())).ToArray();
            ObservationResult image = new("obs_test", "window", "win_test", null, null, "", "", "", source, new(source.width, source.height), crop,
                new(width, height, "image/png", 0, ""), new(source.x + crop.x, source.y + crop.y, (double)crop.width / content.width, (double)crop.height / content.height, content),
                monitors, new("per_monitor_v2", CoordinateMapper.VirtualBounds(monitors), v.GetProperty("window_dpi").GetUInt32()));
            foreach (JsonElement p in v.GetProperty("points").EnumerateArray())
            {
                ImagePointResolution? actual = CoordinateMapper.Resolve(image, p[0].GetInt32(), p[1].GetInt32());
                string name = v.GetProperty("name").GetString()!;
                if (p[2].ValueKind == JsonValueKind.Null) { Check(actual == null, "invalid point accepted: " + name); continue; }
                Check(actual != null && actual.desktop == new CoordinatePoint(p[2].GetInt32(), p[3].GetInt32()) && actual.monitor_id == p[4].GetString(), "mapped point differs: " + name);
                CaptureRect bounds = actual!.virtual_bounds;
                Check(bounds.x + (long)actual.absolute.x * bounds.width / 65536 == actual.desktop.x && bounds.y + (long)actual.absolute.y * bounds.height / 65536 == actual.desktop.y,
                    "normalization did not round-trip: " + name);
                if (bounds.width == 1) Check(actual.absolute.x == 32768, "one pixel desktop divided by zero");
            }
            Check(CoordinateMapper.Resolve(image with { transform = image.transform with { scale_x = double.NaN } }, 0, 0) == null, "invalid transform accepted");
            Check(CoordinateMapper.Resolve(image with { coordinate_context = image.coordinate_context with { dpi_awareness = "system_aware" } }, 0, 0) == null, "virtualized frame accepted");
            Console.WriteLine("PASS coordinates " + v.GetProperty("name").GetString());
        }
    }
}
