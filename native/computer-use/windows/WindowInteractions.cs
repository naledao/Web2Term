using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal sealed record MenuWindowBinding(WindowSelection Anchor, string MenuOwner, DiscoveredWindow Popup)
{ internal string ContextId { get; } = Guid.NewGuid().ToString("N"); }
internal sealed record InteractionGui(string? foreground_hwnd, string? menu_owner_hwnd, string? menu_root_hwnd, string? capture_hwnd, uint flags);
internal sealed record InteractionCapture(DiscoveredWindowSnapshot Snapshot, InteractionGui Gui);
internal interface IWindowInteractionBackend
{
    InteractionCapture Capture(CancellationToken cancellation);
    bool MenuCurrent(MenuWindowBinding menu, CancellationToken cancellation);
    bool? Modal(DiscoveredWindow window, CancellationToken cancellation);
}
internal sealed record InteractionCandidate(DiscoveredWindow Window, string Kind, bool? Modal, string[] Chain, string? MenuAnchor = null);
internal sealed record RelatedWindow(string kind, bool? is_modal, string[] owner_chain, CatalogWindow window);
internal sealed record InteractionMenu(bool active, string mode, uint flags, string? owner_hwnd, string? root_hwnd, string? owner_window_id, string? keyboard_window_id);
internal sealed record WindowInteractionsResult(string snapshot_id, string parent_window_id, string before_at, string observed_at, string expires_at,
    CatalogWindow parent, RelatedWindow[] windows, InteractionMenu menu, bool complete, string[] limitations, bool snapshot_atomic = false, bool input_ready = false, bool goal_verified = false);

internal sealed partial class WindowCatalog
{
    internal bool MenuCurrent(WindowSelection selection, CancellationToken cancellation) => selection.Menu != null &&
        (selection.Menu.Anchor.WindowId == selection.WindowId || Resolve(selection.ScopeId, selection.Menu.Anchor.WindowId, cancellation) != null) && interactions?.MenuCurrent(selection.Menu, cancellation) == true;
    internal void RevokeInteractions(string scope, string parent)
    {
        if (!scopes.TryGetValue(scope, out Snapshot? s)) return;
        foreach (string id in s.Related.Where(p => p.Value.Parent == parent || p.Value.Expires <= Now).Select(p => p.Key).ToArray()) { s.Published.Remove(id); s.Related.Remove(id); s.MenuOwners.Remove(id); }
        foreach (string id in s.MenuOwners.Where(p => p.Value.Parent == parent || p.Value.Expires <= Now).Select(p => p.Key).ToArray()) s.MenuOwners.Remove(id);
        s.MenuOwners.Remove(parent);
    }
    private sealed record RelatedEntry(string Parent, Entry Entry, DateTime Expires, MenuWindowBinding? Menu);
    private sealed record MenuOwnerEntry(string Parent, DateTime Expires, MenuWindowBinding Menu);
    private static CatalogWindow Row(DiscoveredWindow w, string id, Dictionary<string, string> ids) => new(id, w.Handle, w.Pid, w.ProcessStartedAt, w.ThreadId, w.ClassName, w.Title,
        w.Application, w.Visible, w.Minimized, w.Foreground, w.Enabled, w.Cloaked, w.OwnerHandle,
        w.OwnerHandle != null && ids.TryGetValue(w.OwnerHandle, out string? owner) ? owner : null, true, "verified");
    // Only verified owner chains, never title/PID similarity. Every intermediate owner must also be published.
    internal static string[]? OwnerChain(DiscoveredWindow candidate, DiscoveredWindow parent, IReadOnlyDictionary<string, DiscoveredWindow> all)
    {
        List<string> chain = []; HashSet<string> seen = [candidate.Handle]; string? owner = candidate.OwnerHandle;
        while (owner != null && chain.Count < 8 && seen.Add(owner)) {
            chain.Add(owner); if (owner == parent.Handle) return chain.ToArray();
            if (!all.TryGetValue(owner, out DiscoveredWindow? row) || !row.Verified) return null;
            owner = row.OwnerHandle;
        }
        return null;
    }
    internal ActionResult InspectInteractions(string scope, string parentId, int limit, int controlPid, CancellationToken cancellation)
    {
        RevokeInteractions(scope, parentId);
        WindowSelection? parent = Resolve(scope, parentId, cancellation);
        if (parent == null) return Stale();
        if (parent.Menu != null || parent.Window.Pid == controlPid || parent.Window.Pid == Environment.ProcessId || interactions == null)
            return new(false, "not_executed", "window_blocked", "需要普通业务窗口作为交互发现来源，不检查本软件控制窗口或菜单自身。");
        DateTime before = Now; InteractionCapture capture = interactions.Capture(cancellation);
        Dictionary<string, DiscoveredWindow> all = capture.Snapshot.Windows.Where(w => w.Verified).GroupBy(w => w.Handle).ToDictionary(g => g.Key, g => g.First());
        DiscoveredWindow? original = all.GetValueOrDefault(parent.Window.Handle);
        if (original == null || !original.SameIdentity(parent.Window)) return Stale();
        all[original.Handle] = original;
        List<InteractionCandidate> candidates = [];
        HashSet<string> reasons = [];
        if (!capture.Snapshot.Complete) reasons.Add("enumeration_incomplete");
        foreach (DiscoveredWindow w in all.Values.Where(w => w.Handle != original.Handle && w.Visible && w.ClassName != "#32768" && w.Cloaked == false && w.Pid != controlPid && w.Pid != Environment.ProcessId)) {
            string[]? chain = OwnerChain(w, original, all); if (chain != null) candidates.Add(new(w, w.ClassName == "#32770" ? "dialog" : "owned_window", null, chain));
        }
        candidates = candidates.OrderBy(c => c.Chain.Length).ThenByDescending(c => c.Window.Foreground).ThenBy(c => c.Window.Handle, StringComparer.Ordinal).ToList();
        if (candidates.Count > limit) reasons.Add("limit_reached");
        HashSet<string> included = [original.Handle]; List<InteractionCandidate> selected = [];
        foreach (InteractionCandidate c in candidates) {
            if (selected.Count >= limit || c.Chain.Any(h => !included.Contains(h))) { reasons.Add("limit_reached"); continue; }
            bool? modal = interactions.Modal(c.Window, cancellation); if (modal == null) reasons.Add("modality_unavailable");
            selected.Add(c with { Modal = modal }); included.Add(c.Window.Handle);
        }
        InteractionGui gui = capture.Gui; bool activeMenu = (gui.flags & 0x1c) != 0 && gui.menu_owner_hwnd != null;
        DiscoveredWindow? anchor = gui.menu_root_hwnd == null ? null : all.GetValueOrDefault(gui.menu_root_hwnd);
        if (activeMenu && anchor != null && included.Contains(anchor.Handle) && gui.foreground_hwnd == anchor.Handle) {
            foreach (DiscoveredWindow menu in all.Values.Where(w => w.ClassName == "#32768" && w.Visible && w.Enabled && w.Cloaked == false && w.Pid == anchor.Pid && w.ThreadId == anchor.ThreadId)) {
                MenuWindowBinding proof = new(new(scope, parent.SnapshotId, parent.WindowId, anchor), gui.menu_owner_hwnd!, menu);
                if (!interactions.MenuCurrent(proof, cancellation)) continue;
                if (selected.Count >= limit) { reasons.Add("limit_reached"); break; }
                selected.Add(new(menu, "menu", null, [], anchor.Handle));
            }
        } else if (activeMenu) reasons.Add("menu_unavailable");
        // Re-sample native GUI/window graph after property calls. No association is published from a changing graph.
        InteractionCapture after = interactions.Capture(cancellation);
        Dictionary<string, DiscoveredWindow> fresh = after.Snapshot.Windows.GroupBy(w => w.Handle).ToDictionary(g => g.Key, g => g.First());
        bool Same(DiscoveredWindow w) => fresh.TryGetValue(w.Handle, out DiscoveredWindow? f) && w.SameIdentity(f) && w.OwnerHandle == f.OwnerHandle &&
            w.Visible == f.Visible && w.Enabled == f.Enabled && w.Minimized == f.Minimized && w.Cloaked == f.Cloaked && w.Foreground == f.Foreground;
        string[] Graph(Dictionary<string, DiscoveredWindow> graph) => graph.Values.Where(w => w.Handle == original.Handle || OwnerChain(w, original, graph) != null ||
            activeMenu && anchor != null && w.ClassName == "#32768" && w.Pid == anchor.Pid && w.ThreadId == anchor.ThreadId)
            .Select(w => $"{w.Handle}|{w.Lifetime}|{w.ProcessStartedAt}|{w.ThreadId}|{w.OwnerHandle}|{w.Visible}|{w.Enabled}|{w.Cloaked}|{w.Foreground}").Order(StringComparer.Ordinal).ToArray();
        if (after.Gui != gui || !Graph(all).SequenceEqual(Graph(fresh)) || !Same(original) || selected.Any(c => !Same(c.Window)) || Resolve(scope, parentId, cancellation) is not { } current || !current.Window.SameIdentity(original))
            return new(false, "not_executed", "stale_window", "交互发现期间窗口、owner 或菜单状态变化，未发布引用，请重新检查。");
        if (!after.Snapshot.Complete) reasons.Add("enumeration_incomplete");
        Snapshot s = scopes[scope]; DateTime expiry = new[] { before.AddSeconds(30), s.At.AddMinutes(2) }.Min();
        if (expiry <= Now) return Stale();
        if (s.Related.Count + selected.Count > 64) return new(false, "not_executed", "unavailable", "交互引用预算已满，请重新发现业务窗口。");
        Dictionary<string, string> ids = new(StringComparer.Ordinal) { [original.Handle] = parentId };
        foreach (InteractionCandidate c in selected) ids[c.Window.Handle] = "win_" + Guid.NewGuid().ToString("N");
        foreach (InteractionCandidate c in selected) {
            string id = ids[c.Window.Handle]; MenuWindowBinding? proof = c.MenuAnchor == null ? null : new(new(scope, s.Id, ids[c.MenuAnchor], fresh[c.MenuAnchor]), gui.menu_owner_hwnd!, c.Window);
            s.Related[id] = new(parentId, new(id, c.Window), expiry, proof); s.Published.Add(id);
        }
        RelatedWindow[] rows = selected.Select(c => new RelatedWindow(c.Kind, c.Modal, c.Chain, Row(c.Window, ids[c.Window.Handle], ids))).ToArray();
        string? menuOwnerId = anchor is { Foreground: true } && gui.foreground_hwnd == anchor.Handle && ids.TryGetValue(anchor.Handle, out string? a) ? a : null;
        string? keyboard = rows.FirstOrDefault(r => r.kind == "menu")?.window.window_id;
        string mode = !activeMenu ? "none" : keyboard != null ? "popup" : "unavailable";
        if (activeMenu && keyboard == null && anchor != null && menuOwnerId != null) {
            MenuWindowBinding proof = new(new(scope, s.Id, menuOwnerId, anchor), gui.menu_owner_hwnd!, anchor);
            if (interactions.MenuCurrent(proof, cancellation)) { s.MenuOwners[menuOwnerId] = new(parentId, expiry, proof); keyboard = menuOwnerId; mode = "owner"; }
        }
        if (activeMenu && keyboard == null) reasons.Add("menu_unavailable");
        WindowInteractionsResult result = new(s.Id, parentId, before.ToString("O"), Now.ToString("O"), expiry.ToString("O"), Row(original, parentId, ids), rows,
            new(activeMenu, mode, gui.flags, gui.menu_owner_hwnd, gui.menu_root_hwnd, activeMenu ? menuOwnerId : null, keyboard), reasons.Count == 0, reasons.Order(StringComparer.Ordinal).ToArray());
        return new(true, "executed", "ok", "已发现当前业务窗口关联的弹窗及菜单；请 observe 返回的 window_id 读取提示与控件，再按任务选择输入，不统一确认。活动菜单无需 focus_window；截图不可用可 observe controls 后用菜单按键。", result);
    }
}
internal sealed class InspectInteractionsAction(WindowCatalog windows, int controlPid) : IWindowsAction
{
    public string Name => "inspect_interactions";
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        string scope, parent; int limit;
        try {
            string[] keys = ["scope_id", "window_id", "limit"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != 3 || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != 3 || p.EnumerateObject().Any(v => !keys.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            scope = p.GetProperty("scope_id").GetString()!; parent = p.GetProperty("window_id").GetString()!; limit = p.GetProperty("limit").GetInt32();
            if (!ObservationBindingProtocol.Id(scope, "ws_") || !ObservationBindingProtocol.Id(parent, "win_") || limit is < 1 or > 16) return ObservationBindingProtocol.Invalid();
        } catch { return ObservationBindingProtocol.Invalid(); }
        return windows.InspectInteractions(scope, parent, limit, controlPid, cancellation);
    }
}
