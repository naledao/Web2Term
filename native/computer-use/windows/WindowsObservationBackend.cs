using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

namespace Web2Term.WindowsHelper;

/** WGC only: no screen-sized GDI fallback, activation, picker, input, or foreground-policy changes. */
internal sealed class WindowsObservationBackend(WindowCatalog windows) : IObservationBackend
{
    public CaptureSource Source(ObservationRequest request, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        WindowsDpiContext.RequirePhysicalCoordinates();
        CaptureMonitor[] monitors = Monitors(cancellation).Select(value => value.Monitor).ToArray();
        WindowsDpiContext.CheckDesktop(monitors);
        if (request.WindowId != null)
        {
            WindowSelection selection = windows.Resolve(request.Scope, request.WindowId, cancellation) ?? throw new ObservationException("stale_window");
            DiscoveredWindow window = selection.Window;
            if (!window.Visible || window.Minimized) throw new ObservationException("restore_required");
            if (window.Cloaked != false) throw new ObservationException("capture_blocked");
            IntPtr handle = Parse(window.Handle);
            if (request.Target != "controls" && GetWindowDisplayAffinity(handle, out uint affinity) && affinity != 0) throw new ObservationException("capture_blocked");
            if (DwmGetWindowAttribute(handle, 9, out Rect rect, (uint)Marshal.SizeOf<Rect>()) < 0) throw new ObservationException("capture_failed");
            return new(Bounds(rect), selection, null, monitors, WindowsDpiContext.WindowDpi(handle));
        }
        CaptureMonitor? selected = request.MonitorId == null ? monitors.FirstOrDefault(value => value.primary) : monitors.FirstOrDefault(value => value.monitor_id == request.MonitorId);
        return selected != null ? new(selected.bounds, null, selected, monitors) : throw new ObservationException("stale_observation");
    }
    public CapturedPixels Capture(CaptureSource source, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        WindowsDpiContext.RequirePhysicalCoordinates();
        if (!GraphicsCaptureSession.IsSupported()) throw new ObservationException("unavailable");
        if ((long)source.Bounds.width * source.Bounds.height > 32_000_000) throw new ObservationException("capture_failed");
        // Revalidate immediately before creating the capture item; the service validates again after capture.
        GraphicsCaptureItem item;
        if (source.Window is { } selected)
        {
            WindowSelection fresh = windows.Resolve(selected.ScopeId, selected.WindowId, cancellation) ?? throw new ObservationException("stale_window");
            if (!fresh.Window.SameIdentity(selected.Window)) throw new ObservationException("stale_window");
            if (!fresh.Window.Visible || fresh.Window.Minimized || fresh.Window.Cloaked != false) throw new ObservationException("restore_required");
            item = Item(Parse(fresh.Window.Handle), false);
        }
        else
        {
            var selectedMonitor = Monitors(cancellation).FirstOrDefault(value => value.Monitor == source.Monitor);
            if (selectedMonitor.Handle == IntPtr.Zero) throw new ObservationException("stale_observation");
            item = Item(selectedMonitor.Handle, true);
        }
        if (item.Size.Width != source.Bounds.width || item.Size.Height != source.Bounds.height) throw new ObservationException("stale_observation");
        using IDirect3DDevice device = Device();
        using Direct3D11CaptureFramePool pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size);
        using GraphicsCaptureSession session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        cancellation.ThrowIfCancellationRequested();
        session.StartCapture(); // System capture border remains enabled; do not bypass capture restrictions.
        Stopwatch elapsed = Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < 5000)
        {
            cancellation.ThrowIfCancellationRequested();
            using Direct3D11CaptureFrame? frame = pool.TryGetNextFrame();
            if (frame == null) { if (cancellation.WaitHandle.WaitOne(20)) cancellation.ThrowIfCancellationRequested(); continue; }
            DateTime capturedAt = DateTime.UtcNow;
            if (frame.ContentSize.Width != source.Bounds.width || frame.ContentSize.Height != source.Bounds.height) throw new ObservationException("stale_observation");
            using SoftwareBitmap bitmap = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Ignore).AsTask(cancellation).GetAwaiter().GetResult();
            if (bitmap.PixelWidth != source.Bounds.width || bitmap.PixelHeight != source.Bounds.height || bitmap.BitmapPixelFormat != BitmapPixelFormat.Bgra8)
                throw new ObservationException("stale_observation");
            uint length = checked((uint)(bitmap.PixelWidth * bitmap.PixelHeight * 4));
            Windows.Storage.Streams.Buffer buffer = new(length) { Length = length };
            bitmap.CopyToBuffer(buffer);
            if (buffer.Length != length) throw new ObservationException("capture_failed");
            byte[] pixels = new byte[length];
            using DataReader reader = DataReader.FromBuffer(buffer); reader.ReadBytes(pixels);
            return new(bitmap.PixelWidth, bitmap.PixelHeight, pixels, capturedAt);
        }
        throw new ObservationException("capture_failed");
    }
    internal static void Write(string output, byte[] bytes)
    {
        using FileStream file = new(output, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        file.Write(bytes); file.Flush(true);
    }
    private static GraphicsCaptureItem Item(IntPtr handle, bool monitor)
    {
        var factory = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
        Guid iid = new("79c3f95b-31f7-4ec2-a464-632ef5d30760");
        IntPtr pointer = IntPtr.Zero;
        try
        {
            int hr = monitor ? factory.CreateForMonitor(handle, ref iid, out pointer) : factory.CreateForWindow(handle, ref iid, out pointer);
            Marshal.ThrowExceptionForHR(hr);
            return GraphicsCaptureItem.FromAbi(pointer);
        }
        finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); }
    }
    private static IDirect3DDevice Device()
    {
        IntPtr native = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, inspectable = IntPtr.Zero;
        try
        {
            Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out native, out _, out context));
            Guid iid = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native, ref iid, out dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
            return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        }
        finally
        {
            foreach (IntPtr pointer in new[] { inspectable, dxgi, context, native }) if (pointer != IntPtr.Zero) Marshal.Release(pointer);
        }
    }
    private static List<(IntPtr Handle, CaptureMonitor Monitor)> Monitors(CancellationToken cancellation)
    {
        List<(IntPtr, CaptureMonitor)> result = [];
        bool overflow = false;
        MonitorCallback callback = (IntPtr handle, IntPtr _, ref Rect __, IntPtr ___) =>
        {
            if (cancellation.IsCancellationRequested || result.Count >= 16) { overflow = true; return false; }
            MonitorInfo info = new() { Size = (uint)Marshal.SizeOf<MonitorInfo>(), Device = "" };
            if (!GetMonitorInfo(handle, ref info)) { overflow = true; return false; }
            CaptureRect bounds = Bounds(info.Monitor);
            if (!bounds.Valid) { overflow = true; return false; }
            // GetDpiForMonitor is not supported on a per-monitor-aware calling thread. Record the actual scale separately;
            // do not invent measured monitor DPI from a discrete percentage or consume the API's failure fallback.
            uint? scale = GetScaleFactorForMonitor(handle, out int percent) == 0 && percent is >= 50 and <= 1000 ? (uint)percent : null;
            string identity = string.Join('|', info.Device, bounds.x, bounds.y, bounds.width, bounds.height, info.Flags, scale);
            string id = "mon_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..32].ToLowerInvariant();
            result.Add((handle, new(id, bounds, (info.Flags & 1) == 1, null, null, scale))); return true;
        };
        bool ok = EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        cancellation.ThrowIfCancellationRequested();
        if (!ok || overflow || result.Count == 0) throw new ObservationException("unavailable");
        return result.OrderBy(value => value.Item2.monitor_id, StringComparer.Ordinal).ToList();
    }
    private static CaptureRect Bounds(Rect r) => new(r.Left, r.Top, checked(r.Right - r.Left), checked(r.Bottom - r.Top));
    private static IntPtr Parse(string handle) => (IntPtr)long.Parse(handle.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MonitorInfo
    {
        internal uint Size; internal Rect Monitor, Work; internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string Device;
    }
    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("shcore.dll")] private static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect bounds, uint size);
    [DllImport("d3d11.dll")] private static extern int D3D11CreateDevice(IntPtr adapter, uint driver, IntPtr software, uint flags, IntPtr levels, uint count, uint sdk, out IntPtr device, out uint level, out IntPtr context);
    [DllImport("d3d11.dll")] private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr device, out IntPtr graphicsDevice);
    [ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
        [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
    }
}
