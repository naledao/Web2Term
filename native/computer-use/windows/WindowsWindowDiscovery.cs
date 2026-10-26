using System.Diagnostics;
using System.Globalization;
using System.Text;
using static Web2Term.WindowsHelper.ApplicationInterop;
using static Web2Term.WindowsHelper.ApplicationLaunchInterop;
using static Web2Term.WindowsHelper.WindowInterop;

namespace Web2Term.WindowsHelper;

/** Fresh top-level Win32 metadata on the helper MTA; UIA control trees remain a later action. */
internal sealed class WindowsWindowDiscovery(WindowLifetimeMonitor lifetimes) : IWindowDiscovery
{
    public DiscoveredWindowSnapshot Capture(bool includeHidden, CancellationToken cancellation)
    {
        bool lifetimeReady = lifetimes.Synchronize(cancellation);
        HashSet<string> limitations = [];
        if (!lifetimeReady) limitations.Add("lifetime_unavailable");
        List<DiscoveredWindow> rows = [];
        int visited = 0;
        Stopwatch elapsed = Stopwatch.StartNew();
        bool enumerated = EnumWindows((window, state) => {
            if (cancellation.IsCancellationRequested) return false;
            if (++visited > 1024 || rows.Count >= 512 || elapsed.Elapsed > TimeSpan.FromSeconds(2)) { limitations.Add("enumeration_limited"); return false; }
            if (!includeHidden && !IsWindowVisible(window) && !IsIconic(window)) return true;
            DiscoveredWindow? row;
            try { row = ReadCore(window, cancellation); }
            catch (OperationCanceledException) { return false; }
            if (row == null) { limitations.Add("window_changed"); return true; }
            if (!lifetimeReady) row = row with { Lifetime = null };
            if (!row.Verified) limitations.Add(row.IdentityStatus == "changed" ? "window_changed" : row.Lifetime == null ? "lifetime_unavailable" : "metadata_unavailable");
            rows.Add(row);
            return true;
        }, IntPtr.Zero);
        cancellation.ThrowIfCancellationRequested();
        bool synchronized = lifetimes.Synchronize(cancellation);
        for (int index = 0; index < rows.Count; index++)
        {
            DiscoveredWindow row = rows[index];
            if (!synchronized) { rows[index] = row with { Lifetime = null }; limitations.Add("lifetime_unavailable"); }
            else if (row.Lifetime != null && row.Lifetime != lifetimes.Lifetime(Parse(row.Handle))) { rows[index] = row with { Stable = false }; limitations.Add("window_changed"); }
        }
        if (!enumerated && limitations.Count == 0) limitations.Add("metadata_unavailable");
        return new(rows.ToArray(), enumerated && limitations.Count == 0, limitations.ToArray());
    }
    public DiscoveredWindow? Read(string handle, CancellationToken cancellation)
    {
        if (!lifetimes.Synchronize(cancellation)) return null;
        IntPtr window = Parse(handle);
        DiscoveredWindow? row = ReadCore(window, cancellation);
        if (row == null || !lifetimes.Synchronize(cancellation) || row.Lifetime != lifetimes.Lifetime(window)) return null;
        return row;
    }
    private DiscoveredWindow? ReadCore(IntPtr window, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        try
        {
            if (!IsWindow(window) || GetAncestor(window, 2) != window) return null; // GA_ROOT; owner popups remain independent top-level windows.
            string? lifetime = lifetimes.Lifetime(window);
            uint thread = GetWindowThreadProcessId(window, out uint pid);
            if (thread == 0 || pid == 0) return null;
            string? started = null, path = null, name = null, aumid = null;
            using var process = OpenProcess(0x1000 | 0x100000, false, pid); // QUERY_LIMITED_INFORMATION + SYNCHRONIZE.
            if (!process.IsInvalid)
            {
                if (GetProcessTimes(process, out long created, out _, out _, out _) && created > 0) started = DateTime.FromFileTimeUtc(created).ToString("O");
                StringBuilder image = new(2048); uint length = (uint)image.Capacity;
                if (QueryFullProcessImageName(process, 0, image, ref length))
                {
                    string actual = image.ToString();
                    if (actual.StartsWith("\\\\?\\", StringComparison.Ordinal)) actual = actual[4..];
                    if (ExecutableVerifier.LocalPath(actual)) path = actual;
                    name = Clean(Path.GetFileNameWithoutExtension(actual), 200);
                }
                uint count = 0;
                if (GetApplicationUserModelId(process, ref count, null) == 122 && count is > 1 and <= 512)
                {
                    StringBuilder appId = new((int)count);
                    if (GetApplicationUserModelId(process, ref count, appId) == 0) aumid = Clean(appId.ToString(), 512);
                }
            }
            IPropertyStore? properties = null;
            try { SHGetPropertyStoreForWindow(window, typeof(IPropertyStore).GUID, out properties); aumid = Clean(StringProperty(properties, AppUserModelId), 512) ?? aumid; }
            catch { /* No explicit window AUMID is common for traditional desktop applications. */ }
            finally { Release(properties); }
            StringBuilder caption = new(257), className = new(257);
            _ = GetWindowText(window, caption, caption.Capacity); _ = GetClassName(window, className, className.Capacity);
            bool? cloaked = DwmGetWindowAttribute(window, 14, out uint cloakFlags, 4) == 0 ? cloakFlags != 0 : null;
            IntPtr owner = GetWindow(window, 4); // GW_OWNER, not a GetWindow enumeration loop.
            bool visible = IsWindowVisible(window), minimized = IsIconic(window), enabled = IsWindowEnabled(window);
            uint afterThread = GetWindowThreadProcessId(window, out uint afterPid);
            StringBuilder afterClass = new(257); _ = GetClassName(window, afterClass, afterClass.Capacity);
            bool stable = thread == afterThread && pid == afterPid && className.ToString() == afterClass.ToString() && IsWindow(window) &&
                lifetime == lifetimes.Lifetime(window) && (process.IsInvalid || WaitForSingleObject(process, 0) == 258);
            return new(Handle(window), pid, started, thread, ApplicationCatalog.Clip(className.ToString(), 256), ApplicationCatalog.Clip(caption.ToString(), 256),
                new(name, path, aumid), visible, minimized, GetForegroundWindow() == window, enabled, cloaked, owner != IntPtr.Zero && owner != window ? Handle(owner) : null, lifetime, stable);
        }
        catch (OperationCanceledException) { throw; }
        catch { return null; }
    }
    private static string? Clean(string? value, int maximum) => !string.IsNullOrWhiteSpace(value) && value.Length <= maximum ? value.Replace('\0', ' ').Trim() : null;
    private static string Handle(IntPtr window) => "0x" + window.ToInt64().ToString("x");
    private static IntPtr Parse(string handle) => (IntPtr)long.Parse(handle.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
}
