using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal sealed record WaitSelector(string Name, string? Role);
internal sealed record WaitOptions(string Condition, string? WindowId, string? Query, uint? Pid, string? Text, WaitSelector? Selector);
internal sealed record WaitEvaluation(string Status, int Matches);
internal sealed record WaitProbe(string wait_id, string condition, string snapshot_id, string scope_collected_at, string scope_expires_at, string before_at, string checked_at,
    CatalogWindow? window, ControlTreeResult? controls, string status, int matches, bool complete, string[] limitations, string? revision, bool input_ready = false, bool goal_verified = false);
internal static class WaitPredicate
{
    internal static WaitEvaluation Controls(WaitOptions p, DiscoveredWindow window, ControlTreeResult? tree)
    {
        if (tree == null || !window.Visible || window.Minimized || window.Cloaked != false) return new("unavailable", 0);
        var visible = tree.elements.Where(r => r.password == false && r.offscreen == false && r.bounds != null && r.name != null);
        if (p.Condition == "text_present") {
            int matches = visible.Count(r => r.name!.Contains(p.Text!, StringComparison.Ordinal));
            return new(matches > 0 ? "met" : tree.complete ? "not_met" : "unavailable", matches);
        }
        int count = visible.Count(r => !r.name_truncated && r.name == p.Selector!.Name && (p.Selector.Role == null || r.role == p.Selector.Role) && r.enabled == true && window.Enabled);
        if (p.Condition == "control_present") return new(count > 0 ? "met" : tree.complete ? "not_met" : "unavailable", count);
        return new(count > 1 ? "ambiguous" : !tree.complete ? "unavailable" : count == 1 ? "met" : "not_met", count);
    }
    internal static bool Window(DiscoveredWindow w, WaitOptions p, int controlPid) => w.Verified && w.Visible && !w.Minimized && w.Cloaked == false && w.ClassName != "#32768" &&
        w.Pid != controlPid && w.Pid != Environment.ProcessId && (p.Pid == null || w.Pid == p.Pid) &&
        new[] { w.Title, w.Application.name, w.Application.executable_path, w.Application.app_user_model_id }.Any(s => s?.Contains(p.Query!, StringComparison.OrdinalIgnoreCase) == true);
}
internal sealed partial class WindowCatalog
{
    internal (string Id, DateTime At, DateTime Expires)? WaitScope(string scope)
    {
        if (!scopes.TryGetValue(scope, out Snapshot? s)) {
            if (scopes.Count >= 16) scopes.Remove(scopes.MinBy(p => p.Value.At).Key);
            s = new("", null, false, Now, [], true, []); scopes[scope] = s;
        }
        if (Now - s.RetainedAt >= ReferenceLifetime) return null;
        // Renew only through live, bounded wait samples; expired references never revive.
        s.RetainedAt = Now;
        foreach (var pair in s.Related.ToArray())
            if (pair.Value.Menu == null && pair.Value.Expires > Now) s.Related[pair.Key] = pair.Value with { Expires = Now.Add(ReferenceLifetime) };
        return (s.Id, Now, Now.Add(ReferenceLifetime));
    }
    internal WindowSelection? PublishWaitWindow(string scope, DiscoveredWindow expected, CancellationToken cancellation)
    {
        if (WaitScope(scope) == null) return null;
        DiscoveredWindow? fresh = discovery.Read(expected.Handle, cancellation);
        if (fresh == null || !expected.SameIdentity(fresh) || expected.Visible != fresh.Visible || expected.Minimized != fresh.Minimized || expected.Cloaked != fresh.Cloaked) return null;
        Snapshot s = scopes[scope]; string? id = s.WaitReferences.Values.FirstOrDefault(e => e.Id != null && !s.Revoked.Contains(e.Id) && e.Window.SameIdentity(fresh))?.Id;
        if (id == null) { if (s.WaitReferences.Count >= 32) return null; id = "win_" + Guid.NewGuid().ToString("N"); }
        s.WaitReferences[id] = new(id, fresh); s.Published.Add(id);
        return new(scope, s.Id, id, fresh);
    }
    internal static CatalogWindow WaitRow(WindowSelection s) => Row(s.Window, s.WindowId, []);
}
/** Single read-only sample. Main owns asynchronous deadlines/backoff; this action never sleeps or captures images. */
internal sealed class WaitProbeService(WindowCatalog windows, IWindowDiscovery discovery, ControlTreeService controls, int controlPid,
    Func<WindowSelection?, CancellationToken, string?>? revision = null, Func<DateTime>? clock = null)
{
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Probe(string scope, string waitId, WaitOptions p, int budget, CancellationToken cancellation)
    {
        DateTime before = Now; var snapshot = windows.WaitScope(scope);
        if (snapshot == null) return new(false, "not_executed", "stale_window", "等待的窗口批次已过期，请重新发现。");
        WindowSelection? target = null; ControlTreeResult? tree = null; HashSet<string> limitations = [];
        WaitEvaluation result; string? beforeRevision;
        if (p.Condition == "window_present") {
            beforeRevision = revision?.Invoke(null, cancellation);
            var capture = discovery.Capture(false, cancellation);
            DiscoveredWindow[] matches = capture.Windows.Where(w => WaitPredicate.Window(w, p, controlPid)).GroupBy(w => w.Handle).Select(g => g.First()).ToArray();
            if (!capture.Complete) limitations.Add("enumeration_incomplete");
            result = new(matches.Length > 1 ? "ambiguous" : !capture.Complete ? "unavailable" : matches.Length == 1 ? "met" : "not_met", matches.Length);
            if (result.Status == "met") {
                target = windows.PublishWaitWindow(scope, matches[0], cancellation);
                if (target == null) { result = result with { Status = "unavailable" }; limitations.Add("target_unavailable"); }
                else if (!WaitPredicate.Window(target.Window, p, controlPid)) { target = null; result = result with { Status = "unavailable" }; limitations.Add("state_changed"); }
            }
        } else {
            target = windows.Resolve(scope, p.WindowId!, cancellation);
            if (target == null) return new(false, "not_executed", "stale_window", "等待目标已关闭、引用过期或身份变化，不选择其他窗口。");
            if (target.Window.Pid == controlPid || target.Window.Pid == Environment.ProcessId) return new(false, "not_executed", "window_blocked", "不等待本软件控制窗口内容。");
            beforeRevision = revision?.Invoke(target, cancellation);
            ActionResult read = controls.Read(scope, p.WindowId!, new(Timeout: budget), cancellation);
            cancellation.ThrowIfCancellationRequested();
            if (read.Ok && read.Data is ControlTreeResult found) { tree = found; if (!found.complete) limitations.Add("controls_incomplete"); }
            else limitations.Add("controls_unavailable");
            WindowSelection? fresh = windows.Resolve(scope, p.WindowId!, cancellation);
            if (fresh == null || !fresh.Window.SameIdentity(target.Window)) return new(false, "executed", "stale_window", "检查期间目标身份变化，未报告条件满足。");
            target = fresh; result = WaitPredicate.Controls(p, target.Window, tree);
            if (!target.Window.Visible || target.Window.Minimized || target.Window.Cloaked != false) limitations.Add("target_unavailable");
        }
        string? afterRevision = revision?.Invoke(p.Condition == "window_present" ? null : target, cancellation);
        if (beforeRevision != afterRevision) { limitations.Add("state_changed"); result = result with { Status = "unavailable" }; if (p.Condition == "window_present") target = null; }
        cancellation.ThrowIfCancellationRequested();
        WaitProbe data = new(waitId, p.Condition, snapshot.Value.Id, snapshot.Value.At.ToString("O"), snapshot.Value.Expires.ToString("O"), before.ToString("O"), Now.ToString("O"),
            target == null ? null : WindowCatalog.WaitRow(target), tree, result.Status, result.Matches, limitations.Count == 0, limitations.ToArray(), afterRevision);
        return new(true, "executed", "ok", "已只读检查一次固定条件；事件或稳定状态不代表完成，等待调度由主进程控制。", data);
    }
}
internal sealed class WaitForAction(WaitProbeService waits) : IWindowsAction
{
    public string Name => "wait_for";
    private static bool Text(string? s, int max) => !string.IsNullOrWhiteSpace(s) && s.Length <= max && !s.Any(c => c < 32 || c == 127);
    public ActionResult Execute(JsonElement p, CancellationToken cancellation)
    {
        string scope, waitId; WaitOptions options; int budget;
        try {
            string[] keys = ["scope_id", "wait_id", "condition", "window_id", "query", "pid", "text", "selector", "budget_ms"];
            if (p.ValueKind != JsonValueKind.Object || p.EnumerateObject().Count() != keys.Length || p.EnumerateObject().Select(v => v.Name).Distinct().Count() != keys.Length || p.EnumerateObject().Any(v => !keys.Contains(v.Name))) return ObservationBindingProtocol.Invalid();
            scope = p.GetProperty("scope_id").GetString()!; waitId = p.GetProperty("wait_id").GetString()!; budget = p.GetProperty("budget_ms").GetInt32();
            string condition = p.GetProperty("condition").GetString()!, windowId = p.GetProperty("window_id").GetString()!, query = p.GetProperty("query").GetString()!, text = p.GetProperty("text").GetString()!;
            uint? pid = p.GetProperty("pid").ValueKind == JsonValueKind.Null ? null : p.GetProperty("pid").GetUInt32();
            WaitSelector? selector = null; JsonElement s = p.GetProperty("selector");
            if (s.ValueKind != JsonValueKind.Null) {
                if (s.ValueKind != JsonValueKind.Object || s.EnumerateObject().Count() != 2 || s.EnumerateObject().Select(v => v.Name).Distinct().Count() != 2 || s.EnumerateObject().Any(v => v.Name is not ("name" or "role"))) return ObservationBindingProtocol.Invalid();
                selector = new(s.GetProperty("name").GetString()!, s.GetProperty("role").GetString());
                if (!Text(selector.Name, 256) || selector.Role != null && !ControlTreeService.Roles.Contains(selector.Role)) return ObservationBindingProtocol.Invalid();
            }
            if (!ObservationBindingProtocol.Id(scope, "ws_") || !Guid.TryParseExact(waitId, "D", out _) || budget is < 100 or > 500 ||
                (condition == "window_present" ? !Text(query, 200) || pid == 0 || windowId != null || text != null || selector != null
                : !ObservationBindingProtocol.Id(windowId ?? "", "win_") || query != null || pid != null ||
                    (condition == "text_present" ? !Text(text, 200) || selector != null : condition is not ("control_available" or "control_present") || selector == null || text != null))) return ObservationBindingProtocol.Invalid();
            options = new(condition, windowId, query?.Trim(), pid, text, selector);
        } catch { return ObservationBindingProtocol.Invalid(); }
        return waits.Probe(scope, waitId, options, budget, cancellation);
    }
}
