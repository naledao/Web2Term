namespace Web2Term.WindowsHelper;

internal enum ControlWindowDisposition { Business, Protected, Unknown }

/** Native identity policy, never a title/class-name allowlist supplied by the model. */
internal sealed class ControlPlaneWindowPolicy
{
    private readonly HashSet<uint> pids;
    private readonly HashSet<string> images;
    internal ControlPlaneWindowPolicy(uint parentPid, uint helperPid, string parentImage, string helperImage)
    {
        string parent = Image(parentImage) ?? throw new ArgumentException("control_image_unavailable");
        string helper = Image(helperImage) ?? throw new ArgumentException("helper_image_unavailable");
        pids = [parentPid, helperPid];
        images = new(StringComparer.OrdinalIgnoreCase) { parent, helper };
    }
    private static string? Image(string? value)
    {
        try {
            if (string.IsNullOrWhiteSpace(value)) return null;
            if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value[4..];
            return Path.IsPathFullyQualified(value) ? Path.GetFullPath(value) : null;
        } catch { return null; }
    }
    internal ControlWindowDisposition Evaluate(DiscoveredWindow window, Func<string, DiscoveredWindow?> read)
    {
        HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);
        DiscoveredWindow? current = window;
        for (int depth = 0; depth < 16 && current != null; depth++) {
            if (!seen.Add(current.Handle)) return ControlWindowDisposition.Unknown;
            if (pids.Contains(current.Pid)) return ControlWindowDisposition.Protected;
            string? image = Image(current.Application.executable_path);
            if (image == null) return ControlWindowDisposition.Unknown;
            if (images.Contains(image)) return ControlWindowDisposition.Protected;
            if (current.OwnerHandle == null) return ControlWindowDisposition.Business;
            current = read(current.OwnerHandle);
        }
        // A missing/looping/unbounded owner chain cannot establish that this is a business window.
        return ControlWindowDisposition.Unknown;
    }
}

/** Every native consumer shares this filtered discovery, including fresh Resolve before input. */
internal sealed class ControlPlaneWindowDiscovery(IWindowDiscovery source, ControlPlaneWindowPolicy policy) : IWindowDiscovery
{
    public DiscoveredWindowSnapshot Capture(bool includeHidden, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        DiscoveredWindowSnapshot snapshot = source.Capture(includeHidden, cancellation);
        Dictionary<string, DiscoveredWindow> all = snapshot.Windows.GroupBy(w => w.Handle).ToDictionary(g => g.Key, g => g.First());
        DiscoveredWindow? ReadOwner(string handle) { cancellation.ThrowIfCancellationRequested(); return all.GetValueOrDefault(handle) ?? source.Read(handle, cancellation); }
        List<DiscoveredWindow> business = []; bool unknown = false;
        foreach (DiscoveredWindow window in snapshot.Windows) {
            cancellation.ThrowIfCancellationRequested();
            ControlWindowDisposition disposition = policy.Evaluate(window, ReadOwner);
            if (disposition == ControlWindowDisposition.Business) business.Add(window);
            if (disposition == ControlWindowDisposition.Unknown) unknown = true;
        }
        string[] limitations = snapshot.Limitations.Concat(unknown ? ["metadata_unavailable"] : Array.Empty<string>()).Distinct().ToArray();
        return new(business.ToArray(), snapshot.Complete && !unknown, limitations);
    }
    public DiscoveredWindow? Read(string handle, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        DiscoveredWindow? current = source.Read(handle, cancellation);
        return current != null && policy.Evaluate(current, owner => { cancellation.ThrowIfCancellationRequested(); return source.Read(owner, cancellation); }) == ControlWindowDisposition.Business ? current : null;
    }
}
