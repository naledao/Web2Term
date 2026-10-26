using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Web2Term.WindowsHelper;

internal sealed record CaptureRect(int x, int y, int width, int height)
{
    internal bool Valid => width > 0 && height > 0 && width <= 32768 && height <= 32768 && Math.Abs((long)x) <= 1_000_000 && Math.Abs((long)y) <= 1_000_000;
}
internal sealed record CaptureSize(int width, int height);
internal sealed record CaptureMonitor(string monitor_id, CaptureRect bounds, bool primary, uint? dpi_x, uint? dpi_y, uint? scale_percent = null);
internal sealed record CaptureIdentity(string hwnd, uint pid, string process_started_at, uint thread_id, string class_name);
internal sealed record CaptureSource(CaptureRect Bounds, WindowSelection? Window, CaptureMonitor? Monitor, CaptureMonitor[] Monitors, uint? WindowDpi = null);
internal sealed record CapturedPixels(int Width, int Height, byte[] Bgra, DateTime CapturedAt);
internal sealed record CaptureImage(int width, int height, string mime_type, int size_bytes, string sha256);
internal sealed record CaptureTransform(int origin_x, int origin_y, double scale_x, double scale_y, CaptureRect content_bounds,
    string coordinate_space = "desktop_physical_pixels", string pixel_mapping = "nearest_floor");
internal sealed record ObservationResult(string observation_id, string target, string? window_id, string? monitor_id, CaptureIdentity? window_identity,
    string before_at, string captured_at, string observed_at, CaptureRect source_bounds, CaptureSize source_size, CaptureRect crop,
    CaptureImage image, CaptureTransform transform, CaptureMonitor[] monitors, DesktopCoordinateContext coordinate_context, bool geometry_consistent = true, bool content_verified = false, bool input_ready = false, bool goal_verified = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ControlTreeResult? controls = null);
internal sealed record ControlsOnlyResult(string observation_id, string target, string window_id, ControlTreeResult controls,
    bool content_verified = false, bool input_ready = false, bool goal_verified = false);
internal sealed record ObservationRequest(string Scope, string Target, string? WindowId, string? MonitorId, CaptureRect? Crop, int Maximum, string Output);
internal sealed class ObservationException(string code) : Exception(code) { internal string Code => Message; }
internal interface IObservationBackend
{
    CaptureSource Source(ObservationRequest request, CancellationToken cancellation);
    CapturedPixels Capture(CaptureSource source, CancellationToken cancellation);
}

/** Pure bounded crop/resize/PNG path. No desktop APIs; the user-run tests use synthetic pixels. */
internal static class ObservationPng
{
    internal const int MaximumBytes = 8 * 1024 * 1024;
    internal static (byte[] Bytes, int Width, int Height) Encode(CapturedPixels pixels, CaptureRect crop, int maximum, CancellationToken cancellation)
    {
        if (pixels.Width <= 0 || pixels.Height <= 0 || pixels.Width > 32768 || pixels.Height > 32768 || (long)pixels.Width * pixels.Height > 32_000_000 ||
            pixels.Bgra.LongLength != (long)pixels.Width * pixels.Height * 4 || !crop.Valid || crop.x < 0 || crop.y < 0 ||
            (long)crop.x + crop.width > pixels.Width || (long)crop.y + crop.height > pixels.Height || maximum is < 256 or > 2560)
            throw new ObservationException("invalid_parameters");
        double scale = Math.Min(1d, (double)maximum / Math.Max(crop.width, crop.height));
        int width = Math.Max(1, (int)Math.Floor(crop.width * scale)), height = Math.Max(1, (int)Math.Floor(crop.height * scale));
        using MemoryStream compressed = new();
        using (ZLibStream zlib = new(compressed, CompressionLevel.Fastest, true))
        {
            byte[] row = new byte[1 + width * 3]; // PNG RGB; do not expose uninitialized alpha/padding.
            for (int y = 0; y < height; y++)
            {
                cancellation.ThrowIfCancellationRequested();
                int sourceY = crop.y + (int)((long)y * crop.height / height);
                for (int x = 0; x < width; x++)
                {
                    int sourceX = crop.x + (int)((long)x * crop.width / width), offset = (sourceY * pixels.Width + sourceX) * 4;
                    row[1 + x * 3] = pixels.Bgra[offset + 2]; row[2 + x * 3] = pixels.Bgra[offset + 1]; row[3 + x * 3] = pixels.Bgra[offset];
                }
                zlib.Write(row);
                if (compressed.Length > MaximumBytes - 128) throw new ObservationException("capture_failed");
            }
        }
        using MemoryStream png = new();
        png.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        byte[] header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header, width); BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height); header[8] = 8; header[9] = 2;
        Chunk(png, "IHDR", header); Chunk(png, "IDAT", compressed.ToArray()); Chunk(png, "IEND", []);
        if (png.Length > MaximumBytes) throw new ObservationException("capture_failed");
        return (png.ToArray(), width, height);
    }
    private static void Chunk(Stream output, string type, byte[] data)
    {
        Span<byte> size = stackalloc byte[4]; BinaryPrimitives.WriteInt32BigEndian(size, data.Length); output.Write(size);
        byte[] name = Encoding.ASCII.GetBytes(type); output.Write(name); output.Write(data);
        uint crc = uint.MaxValue;
        foreach (byte value in name.Concat(data)) { crc ^= value; for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) == 1 ? 0xedb88320u : 0); }
        BinaryPrimitives.WriteUInt32BigEndian(size, ~crc); output.Write(size);
    }
}

internal sealed class ObservationService(IObservationBackend backend, Action<string, byte[]> write, Func<DateTime>? clock = null)
{
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Observe(ObservationRequest request, CancellationToken cancellation)
    {
        bool captured = false;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            DateTime before = Now;
            CaptureSource source = backend.Source(request, cancellation);
            if (!source.Bounds.Valid) throw new ObservationException("capture_failed");
            CaptureRect crop = request.Crop ?? new(0, 0, source.Bounds.width, source.Bounds.height);
            if (!crop.Valid || crop.x < 0 || crop.y < 0 || (long)crop.x + crop.width > source.Bounds.width || (long)crop.y + crop.height > source.Bounds.height)
                throw new ObservationException("invalid_parameters");
            CapturedPixels pixels = backend.Capture(source, cancellation); captured = true;
            CaptureSource after = backend.Source(request, cancellation);
            if (source.Bounds != after.Bounds || source.Monitor != after.Monitor ||
                (source.Window != null && (after.Window == null || !source.Window.Window.SameIdentity(after.Window.Window))) ||
                !source.Monitors.SequenceEqual(after.Monitors) || source.WindowDpi != after.WindowDpi || pixels.Width != source.Bounds.width || pixels.Height != source.Bounds.height)
                throw new ObservationException("stale_observation");
            var image = ObservationPng.Encode(pixels, crop, request.Maximum, cancellation);
            cancellation.ThrowIfCancellationRequested();
            write(request.Output, image.Bytes);
            cancellation.ThrowIfCancellationRequested();
            DiscoveredWindow? window = after.Window?.Window;
            ObservationResult result = new("obs_" + Guid.NewGuid().ToString("N"), request.Target, request.WindowId, source.Monitor?.monitor_id,
                window == null ? null : new(window.Handle, window.Pid, window.ProcessStartedAt!, window.ThreadId, window.ClassName),
                before.ToString("O"), pixels.CapturedAt.ToUniversalTime().ToString("O"), Now.ToString("O"), source.Bounds, new(pixels.Width, pixels.Height), crop,
                new(image.Width, image.Height, "image/png", image.Bytes.Length, Convert.ToHexString(SHA256.HashData(image.Bytes)).ToLowerInvariant()),
                new(source.Bounds.x + crop.x, source.Bounds.y + crop.y, (double)crop.width / image.Width, (double)crop.height / image.Height, new(0, 0, image.Width, image.Height)),
                after.Monitors, CoordinateMapper.Context(after));
            return new(true, "executed", "ok", "已获取本次截图和几何信息；附件须与本结果一同送达。画面可能包含受保护的空白内容，未验证业务目标，不授予后续输入许可。", result);
        }
        catch (OperationCanceledException) { return new(false, captured ? "executed" : "not_executed", "cancelled", "观察已取消，未发布截图；不会自动重新捕获。"); }
        catch (ObservationException error) { return new(false, captured ? "executed" : "not_executed", error.Code, "截图来源不可用、区域越界、受保护或采集期间发生变化；未发布可用观察，请根据错误码重新发现／观察。"); }
        catch { return new(false, captured ? "executed" : "unknown", "capture_failed", "截图捕获或编码失败，未发布可用观察；不会切换窗口或回退捕获所有屏幕。"); }
    }
}

internal sealed partial class ObserveAction(ObservationService service, ControlTreeService? controls = null) : IWindowsAction
{
    public string Name => "observe";
    [GeneratedRegex(@"^ws_[a-f0-9]{32}$")] private static partial Regex Scope();
    [GeneratedRegex(@"^(win_|mon_)[a-f0-9]{32}$")] private static partial Regex Reference();
    [GeneratedRegex(@"^web2term-observe-[A-Za-z0-9]{6}$")] private static partial Regex DirectoryName();
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        try
        {
            string[] fields = ["scope_id", "target", "window_id", "monitor_id", "crop", "max_dimension", "output_path"];
            if (p.ValueKind != JsonValueKind.Object) return Invalid();
            string[] names = p.EnumerateObject().Select(v => v.Name).ToArray();
            if (names.Distinct().Count() != names.Length || fields.Any(name => !names.Contains(name)) || names.Any(name => !fields.Contains(name) && name != "controls_options")) return Invalid();
            string scope = p.GetProperty("scope_id").GetString()!, target = p.GetProperty("target").GetString()!;
            string? output = p.GetProperty("output_path").GetString();
            string? window = p.GetProperty("window_id").GetString(), monitor = p.GetProperty("monitor_id").GetString();
            int maximum = p.GetProperty("max_dimension").GetInt32();
            if (!Scope().IsMatch(scope) || target is not ("desktop" or "window" or "region" or "controls") || maximum is < 256 or > 2560 ||
                (window != null && (!Reference().IsMatch(window) || !window.StartsWith("win_"))) || (monitor != null && (!Reference().IsMatch(monitor) || !monitor.StartsWith("mon_"))) ||
                (window != null && monitor != null) || (target is "window" or "controls" && window == null) || (target == "desktop" && window != null)) return Invalid();
            ControlReadOptions? options = null;
            if (p.TryGetProperty("controls_options", out JsonElement option) && option.ValueKind != JsonValueKind.Null)
            {
                string[] optionNames = ["max_depth", "max_elements", "timeout_ms", "include_selection"];
                if (window == null || controls == null || option.ValueKind != JsonValueKind.Object || option.EnumerateObject().Count() != 4 ||
                    option.EnumerateObject().Select(v => v.Name).Distinct().Count() != 4 || option.EnumerateObject().Any(v => !optionNames.Contains(v.Name)) ||
                    !option.GetProperty("max_depth").TryGetInt32(out int depth) || depth is < 1 or > 8 || !option.GetProperty("max_elements").TryGetInt32(out int count) || count is < 1 or > 200 ||
                    !option.GetProperty("timeout_ms").TryGetInt32(out int timeout) || timeout is < 100 or > 3000 || option.GetProperty("include_selection").ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Invalid();
                options = new(depth, count, timeout, option.GetProperty("include_selection").GetBoolean());
            }
            if (target == "controls")
            {
                if (options == null || output != null || p.GetProperty("crop").ValueKind != JsonValueKind.Null || maximum != 1600) return Invalid();
                ActionResult result = controls!.Read(scope, window!, options, cancellation);
                return result.Ok && result.Data is ControlTreeResult tree ? result with { Data = new ControlsOnlyResult(tree.observation_id, "controls", window!, tree) } : result;
            }
            string? directory = Path.GetDirectoryName(output);
            if (output == null || directory == null || Path.GetFileName(output) != "capture.png" || !DirectoryName().IsMatch(Path.GetFileName(directory)) ||
                !string.Equals(Path.TrimEndingDirectorySeparator(Path.GetDirectoryName(directory)!), Path.TrimEndingDirectorySeparator(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) ||
                Path.GetFullPath(output) != output || !Directory.Exists(directory) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) return Invalid();
            CaptureRect? crop = null;
            JsonElement c = p.GetProperty("crop");
            if (c.ValueKind != JsonValueKind.Null)
            {
                if (target != "region" || c.ValueKind != JsonValueKind.Object || c.EnumerateObject().Count() != 4 || c.EnumerateObject().Select(v => v.Name).Distinct().Count() != 4 ||
                    c.EnumerateObject().Any(v => v.Name is not ("x" or "y" or "width" or "height"))) return Invalid();
                crop = new(c.GetProperty("x").GetInt32(), c.GetProperty("y").GetInt32(), c.GetProperty("width").GetInt32(), c.GetProperty("height").GetInt32());
                if (!crop.Valid || crop.x < 0 || crop.y < 0 || crop.x > 32768 || crop.y > 32768) return Invalid();
            }
            if (target == "region" && crop == null) return Invalid();
            ActionResult captured = service.Observe(new(scope, target, window, monitor, crop, maximum, output!), cancellation);
            if (!captured.Ok || options == null) return captured;
            ActionResult observed = controls!.Read(scope, window!, options, cancellation);
            if (!observed.Ok) return observed with { Execution = "executed" };
            if (captured.Data is not ObservationResult image || observed.Data is not ControlTreeResult data || image.source_bounds != data.window_bounds || image.window_identity != data.window_identity)
                return new(false, "executed", "stale_observation", "截图与控件读取期间窗口身份或边界发生变化，未发布组合观察。");
            return captured with { Data = image with { controls = data }, Message = "已获取截图及有界控件／焦点信息，将与文字同消息回传；两者不是原子快照，limitations 表示 UIA 的部分结果。" };
        }
        catch { return Invalid(); }
    }
    private static ActionResult Invalid() => new(false, "not_executed", "invalid_parameters", "observe 内部来源、区域或临时输出参数不符合约定，本次未捕获。");
}
