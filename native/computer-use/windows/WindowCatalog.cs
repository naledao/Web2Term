using System.Text.Json;
using System.Text.RegularExpressions;

namespace Web2Term.WindowsHelper;

internal sealed record WindowApplication(string? name, string? executable_path, string? app_user_model_id);
internal sealed record DiscoveredWindow(string Handle, uint Pid, string? ProcessStartedAt, uint ThreadId, string ClassName, string Title,
    WindowApplication Application, bool Visible, bool Minimized, bool Foreground, bool Enabled, bool? Cloaked, string? OwnerHandle,
    string? Lifetime, bool Stable = true)
{
    internal bool Verified => ProcessStartedAt != null && ThreadId > 0 && ClassName.Length > 0 && Lifetime != null && Stable;
    internal string IdentityStatus => !Stable ? "changed" : ProcessStartedAt == null ? "process_unavailable" : Lifetime == null || ClassName.Length == 0 ? "lifetime_unavailable" : "verified";
    internal bool SameIdentity(DiscoveredWindow other) => Verified && other.Verified && Handle == other.Handle && Pid == other.Pid &&
        ProcessStartedAt == other.ProcessStartedAt && ThreadId == other.ThreadId && ClassName == other.ClassName && Lifetime == other.Lifetime;
}
internal sealed record DiscoveredWindowSnapshot(DiscoveredWindow[] Windows, bool Complete, string[] Limitations);
internal interface IWindowDiscovery
{
    DiscoveredWindowSnapshot Capture(bool includeHidden, CancellationToken cancellation);
    DiscoveredWindow? Read(string handle, CancellationToken cancellation);
}
internal sealed record CatalogWindow(string? window_id, string hwnd, uint pid, string? process_started_at, uint thread_id, string class_name, string title,
    WindowApplication application, bool visible, bool minimized, bool foreground, bool enabled, bool? cloaked, string? owner_hwnd,
    string? owner_window_id, bool identity_verified, string identity_status);
internal sealed record WindowPage(string snapshot_id, string collected_at, string expires_at, string query, uint? pid, bool include_hidden,
    CatalogWindow[] windows, int total_matches, bool has_more, string? next_cursor, bool complete, string[] limitations);
internal sealed record WindowSelection(string ScopeId, string SnapshotId, string WindowId, DiscoveredWindow Window, MenuWindowBinding? Menu = null);

/** MTA-owned task scopes. Enumeration is a snapshot, never a lock on a foreign window. */
internal sealed partial class WindowCatalog(IWindowDiscovery discovery, Func<DateTime>? clock = null, IWindowInteractionBackend? interactions = null)
{
    private sealed record Entry(string? Id, DiscoveredWindow Window);
    private sealed class Snapshot(string query, uint? pid, bool hidden, DateTime at, Entry[] entries, bool complete, string[] limitations)
    {
        internal readonly string Id = "wset_" + Guid.NewGuid().ToString("N");
        internal readonly string Query = query;
        internal readonly uint? Pid = pid;
        internal readonly bool Hidden = hidden;
        internal readonly DateTime At = at;
        internal readonly Entry[] Entries = entries;
        internal readonly bool Complete = complete;
        internal readonly string[] Limitations = limitations;
        internal readonly Dictionary<string, int> Cursors = new(StringComparer.Ordinal);
        internal readonly HashSet<string> Published = new(StringComparer.Ordinal);
        internal readonly HashSet<string> Revoked = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, RelatedEntry> Related = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, MenuOwnerEntry> MenuOwners = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, Entry> WaitReferences = new(StringComparer.Ordinal);
    }
    private readonly Dictionary<string, Snapshot> scopes = new(StringComparer.Ordinal);
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    [GeneratedRegex(@"^ws_[a-f0-9]{32}$")] private static partial Regex ScopeId();
    [GeneratedRegex(@"^wcur_[a-f0-9]{32}$")] private static partial Regex CursorId();

    internal ActionResult List(JsonElement p, CancellationToken cancellation)
    {
        if (p.ValueKind != JsonValueKind.Object) return Invalid();
        string[] required = ["scope_id", "query", "pid", "include_hidden", "limit"];
        string[] names = p.EnumerateObject().Select(v => v.Name).ToArray();
        if (names.Distinct().Count() != names.Length || names.Any(name => !required.Contains(name) && name != "cursor") || required.Any(name => !names.Contains(name))) return Invalid();
        if (p.GetProperty("scope_id").ValueKind != JsonValueKind.String || !ScopeId().IsMatch(p.GetProperty("scope_id").GetString()!) ||
            p.GetProperty("query").ValueKind != JsonValueKind.String || p.GetProperty("query").GetString()!.Length > 200 || p.GetProperty("query").GetString()!.Contains('\0') ||
            p.GetProperty("include_hidden").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            p.GetProperty("limit").ValueKind != JsonValueKind.Number || !p.GetProperty("limit").TryGetInt32(out int limit) || limit is < 1 or > 50) return Invalid();
        uint? pid = null;
        if (p.GetProperty("pid").ValueKind != JsonValueKind.Null)
        {
            if (p.GetProperty("pid").ValueKind != JsonValueKind.Number || !p.GetProperty("pid").TryGetUInt32(out uint value) || value == 0) return Invalid();
            pid = value;
        }
        string scope = p.GetProperty("scope_id").GetString()!, query = p.GetProperty("query").GetString()!.Trim();
        bool hidden = p.GetProperty("include_hidden").GetBoolean();
        foreach (string expired in scopes.Where(pair => Now - pair.Value.At >= TimeSpan.FromMinutes(2)).Select(pair => pair.Key).ToArray()) scopes.Remove(expired);
        if (cancellation.IsCancellationRequested) { scopes.Remove(scope); return Cancelled(); }
        Snapshot snapshot;
        int offset = 0;
        if (p.TryGetProperty("cursor", out JsonElement cursor))
        {
            if (cursor.ValueKind != JsonValueKind.String || !CursorId().IsMatch(cursor.GetString()!)) return Invalid();
            if (!scopes.TryGetValue(scope, out snapshot!) || snapshot.Query != query || snapshot.Pid != pid || snapshot.Hidden != hidden ||
                !snapshot.Cursors.TryGetValue(cursor.GetString()!, out offset)) return Stale();
        }
        else
        {
            scopes.Remove(scope); // A fresh observation revokes this task's previous references even if collection fails.
            DiscoveredWindowSnapshot collected;
            try { collected = discovery.Capture(hidden, cancellation); }
            catch (OperationCanceledException) { return Cancelled(); }
            catch { return new(false, "not_executed", "unavailable", "窗口采集不可用，旧窗口引用已失效。"); }
            if (cancellation.IsCancellationRequested) return Cancelled();
            DiscoveredWindow[] unique = collected.Windows.GroupBy(window => window.Handle, StringComparer.Ordinal).Select(group => group.First()).Take(512).ToArray();
            string[] limitations = collected.Limitations.Concat(collected.Windows.Length > 512 ? ["enumeration_limited"] : Array.Empty<string>())
                .Concat(unique.Any(window => !window.Verified) ? ["metadata_unavailable"] : Array.Empty<string>()).Distinct().ToArray();
            Entry[] entries = unique.Where(window => (hidden || window.Visible || window.Minimized) && (pid == null || pid == window.Pid) &&
                (query.Length == 0 || new[] { window.Title, window.Application.name, window.Application.executable_path, window.Application.app_user_model_id }
                    .Any(value => value?.Contains(query, StringComparison.OrdinalIgnoreCase) == true)))
                .OrderByDescending(window => window.Foreground).ThenByDescending(window => window.Visible).ThenBy(window => window.Title, StringComparer.OrdinalIgnoreCase)
                .ThenBy(window => window.Handle, StringComparer.Ordinal).Select(window => new Entry(window.Verified ? "win_" + Guid.NewGuid().ToString("N") : null, window)).ToArray();
            snapshot = new(query, pid, hidden, Now, entries, collected.Complete && limitations.Length == 0, limitations);
            if (scopes.Count >= 16) scopes.Remove(scopes.MinBy(pair => pair.Value.At).Key);
            scopes[scope] = snapshot;
        }
        Entry[] selected = snapshot.Entries.Skip(offset).Take(limit).ToArray();
        string next = "wcur_" + Guid.NewGuid().ToString("N");
        WindowPage page;
        while (true)
        {
            var ownerIds = selected.Where(entry => entry.Id != null && !snapshot.Revoked.Contains(entry.Id)).ToDictionary(entry => entry.Window.Handle, entry => entry.Id!, StringComparer.Ordinal);
            CatalogWindow[] rows = selected.Select(entry => {
                DiscoveredWindow w = entry.Window;
                string? windowId = entry.Id != null && !snapshot.Revoked.Contains(entry.Id) ? entry.Id : null;
                string? owner = w.OwnerHandle != w.Handle ? w.OwnerHandle : null;
                return new CatalogWindow(windowId, w.Handle, w.Pid, w.ProcessStartedAt, w.ThreadId, w.ClassName, w.Title, w.Application,
                    w.Visible, w.Minimized, w.Foreground, w.Enabled, w.Cloaked, owner, owner != null && ownerIds.TryGetValue(owner, out string? ownerId) ? ownerId : null,
                    windowId != null, windowId != null ? "verified" : entry.Id != null ? "changed" : w.IdentityStatus);
            }).ToArray();
            bool more = offset + selected.Length < snapshot.Entries.Length;
            string[] reasons = snapshot.Limitations.Concat(rows.Any(row => row.identity_status == "changed") ? ["window_changed"] : Array.Empty<string>()).Distinct().ToArray();
            page = new(snapshot.Id, snapshot.At.ToString("O"), snapshot.At.AddMinutes(2).ToString("O"), query, pid, hidden, rows, snapshot.Entries.Length,
                more, more ? next : null, snapshot.Complete && reasons.Length == 0, reasons);
            if (JsonSerializer.SerializeToUtf8Bytes(page).Length <= 180 * 1024 || selected.Length <= 1) break;
            selected = selected[..^1];
        }
        if (cancellation.IsCancellationRequested) { scopes.Remove(scope); return Cancelled(); }
        foreach (CatalogWindow row in page.windows) if (row.window_id != null) snapshot.Published.Add(row.window_id);
        if (page.has_more)
        {
            if (snapshot.Cursors.Count >= 512) snapshot.Cursors.Remove(snapshot.Cursors.Keys.First());
            snapshot.Cursors[next] = offset + selected.Length;
        }
        return new(true, "executed", "ok", "已采集窗口快照；window_id 仅绑定当前任务和窗口身份，使用前仍需原生复核。标题、PID、owner 或前台状态不能证明已找到业务内容或完成任务。", page);
    }

    /** Mandatory native gate for later focus/observe/input actions; returns fresh metadata, never a guessed handle. */
    internal WindowSelection? Resolve(string scope, string windowId, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!scopes.TryGetValue(scope, out Snapshot? snapshot) || Now - snapshot.At >= TimeSpan.FromMinutes(2) || !snapshot.Published.Contains(windowId) || snapshot.Revoked.Contains(windowId)) return null;
        RelatedEntry? related = snapshot.Related.GetValueOrDefault(windowId);
        if (related != null && related.Expires <= Now) { snapshot.Related.Remove(windowId); snapshot.Published.Remove(windowId); return null; }
        Entry? entry = snapshot.Entries.FirstOrDefault(value => value.Id == windowId) ?? related?.Entry ?? snapshot.WaitReferences.GetValueOrDefault(windowId);
        DiscoveredWindow? current;
        try { current = entry != null ? discovery.Read(entry.Window.Handle, cancellation) : null; }
        catch (OperationCanceledException) { throw; }
        catch { current = null; }
        if (entry == null || current == null || !entry.Window.SameIdentity(current)) { snapshot.Revoked.Add(windowId); return null; }
        MenuOwnerEntry? ownerMenu = snapshot.MenuOwners.GetValueOrDefault(windowId);
        if (ownerMenu != null && ownerMenu.Expires <= Now) { snapshot.MenuOwners.Remove(windowId); ownerMenu = null; }
        WindowSelection selection = new(scope, snapshot.Id, windowId, current, related?.Menu ?? ownerMenu?.Menu);
        if (ownerMenu != null && selection.Menu != null && !MenuCurrent(selection, cancellation)) { snapshot.MenuOwners.Remove(windowId); return selection with { Menu = null }; }
        if (selection.Menu != null && !MenuCurrent(selection, cancellation)) { snapshot.Revoked.Add(windowId); return null; }
        return selection;
    }
    private static ActionResult Invalid() => new(false, "not_executed", "invalid_parameters", "窗口查询内部参数不符合约定，本次未采集。");
    private static ActionResult Stale() => new(false, "not_executed", "stale_window", "窗口快照或分页已失效，请重新 list_windows。");
    private static ActionResult Cancelled() => new(false, "not_executed", "cancelled", "窗口采集已取消，本次未发布窗口引用。");
}

internal sealed class ListWindowsAction(WindowCatalog catalog) : IWindowsAction
{
    public string Name => "list_windows";
    public ActionResult Execute(JsonElement parameters, CancellationToken cancellation) => catalog.List(parameters, cancellation);
}
