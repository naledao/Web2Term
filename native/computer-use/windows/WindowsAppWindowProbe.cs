using System.Diagnostics;
using System.Text;
using static Web2Term.WindowsHelper.ApplicationInterop;
using static Web2Term.WindowsHelper.ApplicationLaunchInterop;

namespace Web2Term.WindowsHelper;

/** Fresh bounded metadata, never actionable window references or proof of business completion. */
internal sealed class WindowsAppWindowProbe : IAppWindowProbe
{
    public WindowSnapshot Capture(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        List<ObservedAppWindow> windows = [];
        HashSet<string> seen = new(StringComparer.Ordinal);
        bool complete = true;
        int checkedWindows = 0;
        Stopwatch elapsed = Stopwatch.StartNew();
        bool finished = EnumWindows((window, state) =>
        {
            if (cancellation.IsCancellationRequested) return false;
            if (++checkedWindows > 512 || elapsed.Elapsed > TimeSpan.FromSeconds(2)) { complete = false; return false; }
            try
            {
                bool visible = IsWindowVisible(window), minimized = IsIconic(window);
                if (!visible && !minimized) return true;
                if (windows.Count >= 256) { complete = false; return false; }
                GetWindowThreadProcessId(window, out uint pid);
                if (pid == 0) return true;
                using var handle = OpenProcess(0x1000, false, pid);
                if (handle.IsInvalid || !GetProcessTimes(handle, out long created, out _, out _, out _) || created <= 0) { complete = false; return true; }
                StringBuilder image = new(2048); uint length = (uint)image.Capacity;
                string? path = QueryFullProcessImageName(handle, 0, image, ref length) ? image.ToString() : null;
                string? aumid = null;
                IPropertyStore? properties = null;
                try { SHGetPropertyStoreForWindow(window, typeof(IPropertyStore).GUID, out properties); aumid = StringProperty(properties, AppUserModelId); }
                catch { /* Many desktop windows have no explicit AppUserModelID. */ }
                finally { Release(properties); }
                if (string.IsNullOrWhiteSpace(aumid))
                {
                    uint count = 0;
                    if (GetApplicationUserModelId(handle, ref count, null) == 122 && count is > 1 and <= 512)
                    {
                        StringBuilder appId = new((int)count);
                        if (GetApplicationUserModelId(handle, ref count, appId) == 0) aumid = appId.ToString();
                    }
                }
                StringBuilder title = new(257); GetWindowText(window, title, title.Capacity);
                GetWindowThreadProcessId(window, out uint afterPid);
                if (afterPid != pid) { complete = false; return true; }
                ObservedAppWindow observed = new("0x" + window.ToInt64().ToString("x"), ApplicationCatalog.Clip(title.ToString(), 256), visible, minimized, pid,
                    DateTime.FromFileTimeUtc(created).ToString("O"), GetForegroundWindow() == window, path, aumid);
                if (seen.Add(observed.Identity)) windows.Add(observed);
            }
            catch { complete = false; }
            return true;
        }, IntPtr.Zero);
        cancellation.ThrowIfCancellationRequested();
        return new(DateTime.UtcNow, windows.ToArray(), complete && finished);
    }
}
