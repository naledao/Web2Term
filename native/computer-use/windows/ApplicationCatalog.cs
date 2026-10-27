using System.Diagnostics;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using static Web2Term.WindowsHelper.ApplicationInterop;

namespace Web2Term.WindowsHelper;

internal sealed record LaunchReference(string reference_id, string kind, bool verified = true);
internal sealed record WindowSummary(string hwnd, string title, bool visible, bool minimized);
internal sealed record ProcessSummary(uint pid, string? started_at, bool identity_verified, List<WindowSummary> windows);
internal sealed record CatalogApp(string app_id, string name, string[] aliases, string[] sources, string? executable_path,
    LaunchReference[] launch_references, ProcessSummary[] processes);
internal sealed record SourceSummary(string source, string status, int @checked, int errors);
internal sealed record CatalogPage(string catalog_id, string collected_at, string query, CatalogApp[] apps, int total_matches,
    bool has_more, string? next_cursor, bool complete, SourceSummary[] sources, string? registered_app_id);
internal sealed record VerifiedExecutable(string Path, long Length, long ModifiedTicks)
{
    internal string Fingerprint => Path.ToUpperInvariant() + "\0" + Length + "\0" + ModifiedTicks;
}
internal sealed record NativeLaunch(string Kind, string Target, VerifiedExecutable? Executable, string Arguments = "",
    string? SourceFingerprint = null, string? AppUserModelId = null);
internal sealed record LaunchSelection(string CatalogId, string AppId, string ReferenceId, string Identity, NativeLaunch Launch);
internal sealed record AppCandidate(string Identity, string Name, string Source, VerifiedExecutable? Executable = null,
    NativeLaunch? Launch = null, ProcessSummary? Process = null);

internal sealed class SourceState(string source)
{
    internal readonly string Source = source;
    internal int Checked;
    internal int Errors;
    internal string Status = "complete";
    internal void Error() { Errors++; Status = Checked == 0 ? "unavailable" : "partial"; }
    internal void Partial() { if (Status == "complete") Status = "partial"; }
    internal SourceSummary Summary() => new(Source, Status, Checked, Errors);
}

internal sealed class DiscoveryContext(CancellationToken cancellation)
{
    private readonly Stopwatch elapsed = Stopwatch.StartNew();
    internal readonly CancellationToken Cancellation = cancellation;
    internal bool Visit(SourceState source)
    {
        Cancellation.ThrowIfCancellationRequested();
        if (source.Checked >= 4096 || elapsed.Elapsed > TimeSpan.FromSeconds(10)) { source.Partial(); return false; }
        source.Checked++;
        if (source.Status == "unavailable") source.Status = "partial";
        return true;
    }
}

/** No process, shortcut, script, URI or application is executed by verification. */
internal static class ExecutableVerifier
{
    internal static bool LocalPath(string path) => path.Length is >= 7 and <= 1024 && char.IsAsciiLetter(path[0]) && path[1] == ':' &&
        path[2] == '\\' && path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && !path.AsSpan(2).Contains(':') &&
        !path.Any(character => character < 32 || "<>\"|?*".Contains(character));

    internal static VerifiedExecutable? Verify(string path)
    {
        try
        {
            path = path.Replace('/', '\\'); // Already discovered/registered paths are literal, never variable expressions.
            if (!LocalPath(path)) return null;
            using FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            StringBuilder resolved = new(2048);
            uint length = GetFinalPathNameByHandle(file.SafeFileHandle, resolved, (uint)resolved.Capacity, 0);
            if (length == 0 || length >= resolved.Capacity) return null;
            string canonical = resolved.ToString();
            if (canonical.StartsWith("\\\\?\\", StringComparison.Ordinal)) canonical = canonical[4..];
            if (!LocalPath(canonical)) return null; // no UNC/device paths, including reparse targets.
            using PEReader pe = new(file, PEStreamOptions.LeaveOpen);
            PEHeaders headers = pe.PEHeaders;
            if (headers.PEHeader == null || !headers.IsExe || headers.IsDll ||
                headers.CoffHeader.Machine is not (Machine.I386 or Machine.Amd64) ||
                headers.PEHeader.Subsystem is not (Subsystem.WindowsGui or Subsystem.WindowsCui)) return null;
            FileInfo info = new(canonical);
            if (!info.Exists || info.Length != file.Length) return null;
            return new(canonical, file.Length, info.LastWriteTimeUtc.Ticks);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or BadImageFormatException or NotSupportedException) { return null; }
    }
}

internal interface IApplicationDiscovery
{
    void Collect(DiscoveryContext context, IReadOnlyDictionary<string, SourceState> sources, Action<AppCandidate> add);
}

/** MTA-owned snapshot and launch reference registry. IDs are data, never permission to execute. */
internal sealed class ApplicationCatalog(IApplicationDiscovery discovery, Func<string, VerifiedExecutable?> verify, Func<DateTime>? clock = null)
{
    private sealed class Entry(string identity, string name)
    {
        internal readonly string Identity = identity;
        internal readonly string Id = Hash("app_", identity);
        internal readonly string Name = Clip(name.Trim(), 200);
        internal readonly HashSet<string> Aliases = new(StringComparer.OrdinalIgnoreCase);
        internal readonly HashSet<string> Sources = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, NativeLaunch> Launches = new(StringComparer.Ordinal);
        internal readonly List<ProcessSummary> Processes = [];
        internal string? Executable;
        internal CatalogApp Export() => new(Id, Name, Aliases.Order(StringComparer.OrdinalIgnoreCase).ToArray(), Sources.Order(StringComparer.Ordinal).ToArray(), Executable,
            Launches.Select(launch => new LaunchReference(launch.Key, launch.Value.Kind)).ToArray(), Processes.ToArray());
    }
    private readonly Dictionary<string, VerifiedExecutable> registered = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (string Catalog, string Query, int Offset)> cursors = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private Dictionary<string, SourceState> states = NewSources();
    private string catalogId = "";
    private DateTime collected;
    private bool limited;
    private DateTime UtcNow => clock?.Invoke() ?? DateTime.UtcNow;
    private static Dictionary<string, SourceState> NewSources() => new[] { "applications_folder", "start_menu", "app_paths", "running_process", "registered_path" }
        .ToDictionary(source => source, source => new SourceState(source), StringComparer.Ordinal);
    internal static string Clip(string value, int limit) => new(value.Where(character => character != '\0').Take(limit).ToArray());
    internal static string Hash(string prefix, string value) => prefix + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()[..32];

    internal LaunchSelection? ResolveLaunch(string snapshot, string appId, string referenceId)
    {
        if (snapshot != catalogId || catalogId.Length == 0 || UtcNow - collected >= WindowCatalog.ReferenceLifetime) return null;
        Entry? entry = entries.Values.FirstOrDefault(candidate => candidate.Id == appId);
        return entry != null && entry.Launches.TryGetValue(referenceId, out NativeLaunch? launch)
            ? new(catalogId, entry.Id, referenceId, entry.Identity, launch) : null;
    }

    internal ActionResult List(JsonElement parameters, CancellationToken cancellation)
    {
        // The native boundary repeats action-specific validation independently of the main process.
        HashSet<string> allowed = new(["query", "limit", "cursor", "refresh", "register_path"], StringComparer.Ordinal);
        if (parameters.EnumerateObject().Any(property => !allowed.Contains(property.Name))) return Invalid();
        string query = parameters.TryGetProperty("query", out JsonElement q) && q.ValueKind == JsonValueKind.String ? q.GetString()! : "";
        if ((parameters.TryGetProperty("query", out q) && q.ValueKind != JsonValueKind.String) || query.Length > 200 || query.Contains('\0')) return Invalid();
        int limit = 12;
        if (parameters.TryGetProperty("limit", out JsonElement l) && (l.ValueKind != JsonValueKind.Number || !l.TryGetInt32(out limit) || limit is < 1 or > 25)) return Invalid();
        string? cursor = null;
        if (parameters.TryGetProperty("cursor", out JsonElement c)) { if (c.ValueKind != JsonValueKind.String) return Invalid(); cursor = c.GetString(); }
        bool refresh = false;
        if (parameters.TryGetProperty("refresh", out JsonElement r)) { if (r.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Invalid(); refresh = r.GetBoolean(); }
        string? registration = null;
        if (parameters.TryGetProperty("register_path", out JsonElement p)) { if (p.ValueKind != JsonValueKind.String) return Invalid(); registration = p.GetString(); }
        if (cursor != null && (refresh || registration != null)) return Invalid();
        cancellation.ThrowIfCancellationRequested();
        string? registeredId = null;
        if (registration != null)
        {
            if (!ExecutableVerifier.LocalPath(registration)) return Invalid();
            VerifiedExecutable? executable = verify(registration);
            if (executable == null) return new(false, "not_executed", "invalid_parameters", "该 exe 文件未通过 helper 复核，请先找到真实可读取的本机应用路径。");
            if (registered.Count >= 128 && !registered.ContainsKey(executable.Path)) return new(false, "not_executed", "invalid_parameters", "临时应用登记已达上限，请使用目录查询结果。");
            registered[executable.Path] = executable;
            registeredId = Hash("app_", "exe:" + executable.Path.ToUpperInvariant());
            refresh = true;
        }
        int offset = 0;
        if (cursor != null)
        {
            if (!cursors.TryGetValue(cursor, out var saved) || saved.Catalog != catalogId || saved.Query != query || UtcNow - collected >= WindowCatalog.ReferenceLifetime)
                return new(false, "not_executed", "stale_catalog", "应用目录分页已过期或 query 已变化，请不带 cursor 重新查询。");
            offset = saved.Offset;
        }
        else if (refresh || catalogId.Length == 0 || UtcNow - collected > TimeSpan.FromSeconds(30)) Collect(cancellation);
        cancellation.ThrowIfCancellationRequested();
        CatalogApp[] matches = entries.Values.Where(entry => Matches(entry, query)).OrderByDescending(entry => entry.Processes.Any(process => process.windows.Count > 0))
            .ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase).ThenBy(entry => entry.Id, StringComparer.Ordinal).Select(entry => entry.Export()).ToArray();
        List<CatalogApp> page = [];
        int bytes = 0;
        foreach (CatalogApp app in matches.Skip(offset).Take(limit))
        {
            int size = JsonSerializer.SerializeToUtf8Bytes(app).Length;
            if (bytes + size > 180_000) break;
            bytes += size; page.Add(app);
        }
        bool more = offset + page.Count < matches.Length;
        string? next = null;
        if (more && page.Count > 0)
        {
            next = "apc_" + Guid.NewGuid().ToString("N");
            if (cursors.Count >= 128) cursors.Remove(cursors.Keys.First());
            cursors[next] = (catalogId, query, offset + page.Count);
        }
        bool complete = !limited && states.Values.All(source => source.Status == "complete");
        CatalogPage result = new(catalogId, collected.ToString("O"), query, page.ToArray(), matches.Length, more, next, complete,
            states.Values.Select(source => source.Summary()).ToArray(), registeredId);
        string message = $"应用查询返回 {page.Count} 项，匹配 {matches.Length} 项。" + (complete ? "" : "部分来源受限或达到扫描上限，目录不完整。") +
            (matches.Length == 0 ? "未匹配不代表未安装；可换关键词，或通过文件／终端工具找到真实 exe 后登记。" : "启动引用仅表示已发现并核实来源；应用启动和窗口操作需使用后续已提供的相应动作。");
        return new(true, "executed", "ok", message, result);
    }

    private static bool Matches(Entry entry, string query) => query.Length == 0 || entry.Name.Contains(query, StringComparison.OrdinalIgnoreCase) ||
        entry.Aliases.Any(alias => alias.Contains(query, StringComparison.OrdinalIgnoreCase)) || (entry.Executable?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false);

    private void Collect(CancellationToken cancellation)
    {
        entries.Clear(); cursors.Clear(); states = NewSources(); limited = false;
        // Invalidate the old snapshot before any potentially blocking or cancelled discovery.
        catalogId = "";
        discovery.Collect(new DiscoveryContext(cancellation), states, Add);
        foreach (VerifiedExecutable prior in registered.Values.ToArray())
        {
            cancellation.ThrowIfCancellationRequested();
            states["registered_path"].Checked++;
            VerifiedExecutable? current = verify(prior.Path);
            if (current == null) { registered.Remove(prior.Path); states["registered_path"].Error(); continue; }
            registered[current.Path] = current;
            Add(new("exe:" + current.Path.ToUpperInvariant(), Path.GetFileNameWithoutExtension(current.Path), "registered_path", current, new("executable", current.Path, current)));
        }
        collected = UtcNow; catalogId = "cat_" + Guid.NewGuid().ToString("N");
    }

    private void Add(AppCandidate candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate.Name) || candidate.Identity.Length > 4096 || !states.ContainsKey(candidate.Source)) return;
        string alias = Clip(candidate.Name.Replace("\0", "").Trim(), 200);
        if (string.IsNullOrWhiteSpace(alias)) return;
        if (!entries.TryGetValue(candidate.Identity, out Entry? entry))
        {
            if (entries.Count >= 4096) { limited = true; states[candidate.Source].Partial(); return; }
            entries[candidate.Identity] = entry = new(candidate.Identity, alias);
        }
        entry.Sources.Add(candidate.Source);
        if (entry.Aliases.Count < 8) entry.Aliases.Add(alias);
        else if (!entry.Aliases.Contains(alias)) { limited = true; states[candidate.Source].Partial(); }
        entry.Executable ??= candidate.Executable?.Path;
        if (candidate.Launch != null)
        {
            string reference = Hash("launch_", candidate.Launch.Kind + "\0" + candidate.Launch.Target + "\0" + candidate.Launch.Arguments + "\0" +
                candidate.Launch.Executable?.Fingerprint + "\0" + candidate.Launch.SourceFingerprint + "\0" + candidate.Launch.AppUserModelId);
            if (entry.Launches.Count < 4) entry.Launches[reference] = candidate.Launch;
            else if (!entry.Launches.ContainsKey(reference)) { limited = true; states[candidate.Source].Partial(); }
        }
        if (candidate.Process != null)
        {
            if (entry.Processes.Count < 8) entry.Processes.Add(candidate.Process);
            else { limited = true; states[candidate.Source].Partial(); }
        }
    }
    private static ActionResult Invalid() => new(false, "not_executed", "invalid_parameters", "list_apps 参数无效；分页、查询与登记必须使用各自的合法字段。");
}

internal sealed class ListAppsAction(ApplicationCatalog catalog) : IWindowsAction
{
    public string Name => "list_apps";
    public ActionResult Execute(JsonElement parameters, CancellationToken cancellation) => catalog.List(parameters, cancellation);
}
