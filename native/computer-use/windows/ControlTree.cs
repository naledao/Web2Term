using System.Diagnostics;
using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal sealed record ControlReadOptions(int MaxDepth = 4, int MaxElements = 100, int Timeout = 1200, bool IncludeSelection = false);
internal sealed record ControlBox(double x, double y, double width, double height)
{
    internal bool Valid => double.IsFinite(x) && double.IsFinite(y) && double.IsFinite(width) && double.IsFinite(height) &&
        Math.Abs(x) <= 1_000_000 && Math.Abs(y) <= 1_000_000 && width > 0 && height > 0 && width <= 32768 && height <= 32768;
    internal bool Intersects(CaptureRect r) => Valid && x < (long)r.x + r.width && y < (long)r.y + r.height && x + width > r.x && y + height > r.y;
}
internal sealed record RawControl(string? Key, int? Type, string? Name, bool? Password, bool? Enabled, bool? Focused, bool? Offscreen,
    bool? Selected, ControlBox? Bounds, string[] Patterns, bool Complete, bool InWindow = true);
internal sealed record ControlFocus(string Status, string? Key = null);
internal sealed record RawSelection(string Status, string? Text = null, bool Truncated = false);
internal interface IControlNode : IDisposable { }
internal interface IControlTreeSession : IDisposable
{
    IControlNode? Root();
    IControlNode? FirstChild(IControlNode node);
    IControlNode? NextSibling(IControlNode node);
    RawControl Read(IControlNode node);
    ControlFocus Focus();
    RawSelection Selection(IControlNode node, int maximum);
}
internal interface IControlTreeBackend
{
    CaptureRect Bounds(WindowSelection window, CancellationToken cancellation);
    IControlTreeSession Open(WindowSelection window, Action checkpoint, CancellationToken cancellation);
}
internal sealed class ControlBudgetExceeded : Exception { }
internal sealed record ControlRow(string element_id, string? parent_id, int depth, int? control_type, string role, string? name, bool name_truncated,
    bool? password, bool? enabled, bool? focused, bool? offscreen, bool? selected, ControlBox? bounds, string[] patterns, bool properties_complete);
internal sealed record ControlFocusResult(string status, string? element_id);
internal sealed record ControlSelectionResult(bool requested, string status, string? element_id = null, string? text = null, bool truncated = false);
internal sealed record ControlTreeResult(string observation_id, string window_id, CaptureIdentity window_identity, string before_at, string observed_at,
    CaptureRect window_bounds, string? root_element_id, ControlRow[] elements, ControlFocusResult focus, ControlSelectionResult selection,
    bool complete, string[] limitations, int visited_count, bool geometry_consistent = true, bool snapshot_atomic = false,
    bool content_verified = false, bool input_ready = false, bool goal_verified = false);
// Runtime IDs never cross the helper boundary or keep COM objects alive. One read is taken by the binding registry.
internal sealed record PrivateControlSnapshot(ControlTreeResult Result, IReadOnlyDictionary<string, string> Keys, ControlReadOptions Options);

/** Bounded read-only traversal. All UIA objects are disposed on the same MTA; public IDs refer only to this observation. */
internal sealed class ControlTreeService(WindowCatalog windows, IControlTreeBackend backend, Func<DateTime>? clock = null, Func<long>? elapsed = null)
{
    internal static bool InputAvailable(ControlRow row) => row.control_type != null && row.enabled == true && row.offscreen == false && row.bounds?.Valid == true;
    internal static bool MatchesRaw(ControlRow row, RawControl raw, bool input = true) => raw.InWindow && raw.Key != null &&
        raw.Type == row.control_type && (row.name == null || raw.Name == null || Clip(raw.Password == false ? raw.Name : null, 256) == row.name) &&
        raw.Password == row.password && raw.Bounds == row.bounds && (input ? InputAvailable(row) && raw.Enabled == true && raw.Offscreen == false : raw.Enabled == row.enabled && raw.Offscreen == row.offscreen);
    internal ActionResult WithCurrentControl(string scope, string windowId, PrivateControlSnapshot snapshot, string elementId,
        Func<IControlTreeSession, IControlNode, ControlRow, string[], ActionResult> dispatch, CancellationToken cancellation, int? dispatchTimeout = null)
    {
        ControlRow? row = snapshot.Result.elements.SingleOrDefault(item => item.element_id == elementId);
        if (row == null || !InputAvailable(row) || !snapshot.Keys.TryGetValue(elementId, out string? key)) return Stale();
        List<string> expected = [];
        for (ControlRow? parent = row; parent != null; parent = parent.parent_id == null ? null : snapshot.Result.elements.SingleOrDefault(item => item.element_id == parent.parent_id)) {
            if (expected.Count > 8 || !snapshot.Keys.TryGetValue(parent.element_id, out string? parentKey)) return Stale();
            expected.Add(parentKey);
        }
        Stack<(IControlNode Node, int Depth)> pending = new();
        Stopwatch timer = Stopwatch.StartNew(); int visited = 0, budget = snapshot.Options.Timeout;
        void Check() { cancellation.ThrowIfCancellationRequested(); if (timer.ElapsedMilliseconds >= budget) throw new ControlBudgetExceeded(); }
        try {
            WindowSelection selected = windows.Resolve(scope, windowId, cancellation) ?? throw new ObservationException("stale_window");
            using IControlTreeSession session = backend.Open(selected, Check, cancellation);
            IControlNode? root = session.Root(); if (root != null) pending.Push((root, 0));
            while (pending.TryPop(out var item)) {
                using IControlNode node = item.Node; Check();
                if (++visited > snapshot.Options.MaxElements * 4) return Stale();
                RawControl raw = session.Read(node);
                if (raw.Key == key) {
                    if (!MatchesRaw(row, raw) || raw.Enabled != true || raw.Offscreen != false || session is not IControlClickSession clickable || !clickable.AncestorsMatch(node, expected.ToArray())) return Stale();
                    // Traversal has a separate soft budget; the bounded callback includes its own guards and the helper hard deadline.
                    timer.Restart(); budget = dispatchTimeout ?? snapshot.Options.Timeout;
                    return dispatch(session, node, row, expected.ToArray());
                }
                if (item.Depth > 0) { IControlNode? sibling = session.NextSibling(node); if (sibling != null) pending.Push((sibling, item.Depth)); }
                if (item.Depth < snapshot.Options.MaxDepth && raw.InWindow && raw.Password == false && raw.Offscreen == false) {
                    IControlNode? child = session.FirstChild(node); if (child != null) pending.Push((child, item.Depth + 1));
                }
            }
            return Stale();
        }
        catch (OperationCanceledException) { throw; }
        catch { return Stale(); }
        finally { while (pending.TryPop(out var item)) item.Node.Dispose(); }
        static ActionResult Stale() => new(false, "not_executed", "stale_observation", "控件无法按本次身份、属性和祖先重新解析，未继续派发输入。");
    }
    private PrivateControlSnapshot? latest;
    internal PrivateControlSnapshot? TakeSnapshot(string observationId)
    {
        PrivateControlSnapshot? value = latest; latest = null;
        return value?.Result.observation_id == observationId ? value : null;
    }
    internal static readonly string[] Roles = ["button", "calendar", "check_box", "combo_box", "edit", "hyperlink", "image", "list_item", "list", "menu", "menu_bar", "menu_item", "progress_bar", "radio_button", "scroll_bar", "slider", "spinner", "status_bar", "tab", "tab_item", "text", "tool_bar", "tool_tip", "tree", "tree_item", "custom", "group", "thumb", "data_grid", "data_item", "document", "split_button", "window", "pane", "header", "header_item", "table", "title_bar", "separator", "semantic_zoom", "app_bar"];
    internal static readonly string[] Patterns = ["invoke", "selection", "value", "range_value", "scroll", "expand_collapse", "grid", "grid_item", "multiple_view", "selection_item", "table", "table_item", "text", "toggle", "transform", "window", "scroll_item", "legacy_accessible"];
    private DateTime Now => (clock?.Invoke() ?? DateTime.UtcNow).ToUniversalTime();
    internal ActionResult Read(string scope, string windowId, ControlReadOptions options, CancellationToken cancellation)
    {
        latest = null;
        if (options.MaxDepth is < 1 or > 8 || options.MaxElements is < 1 or > 200 || options.Timeout is < 100 or > 3000)
            return new(false, "not_executed", "invalid_parameters", "控件读取预算不符合约定。");
        bool started = false;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            WindowSelection initial = windows.Resolve(scope, windowId, cancellation) ?? throw new ObservationException("stale_window");
            if (!initial.Window.Visible || initial.Window.Minimized) throw new ObservationException("restore_required");
            if (initial.Window.Cloaked == true) throw new ObservationException("window_blocked");
            DateTime before = Now;
            CaptureRect bounds = backend.Bounds(initial, cancellation);
            if (!bounds.Valid) throw new ObservationException("unavailable");
            HashSet<string> limitations = new(StringComparer.Ordinal), keys = new(StringComparer.Ordinal);
            List<ControlRow> rows = [];
            Stack<(IControlNode Node, int Depth, string? Parent)> pending = new();
            Dictionary<string, string> published = new(StringComparer.Ordinal);
            ControlFocus first = new("unavailable"), last = new("unavailable");
            ControlSelectionResult selection = new(options.IncludeSelection, options.IncludeSelection ? "unavailable" : "not_requested");
            int visited = 0, bytes = 4096;
            Stopwatch timer = Stopwatch.StartNew();
            void Check() { cancellation.ThrowIfCancellationRequested(); if ((elapsed?.Invoke() ?? timer.ElapsedMilliseconds) >= options.Timeout) throw new ControlBudgetExceeded(); }
            started = true;
            try
            {
                Check();
                using IControlTreeSession session = backend.Open(initial, Check, cancellation);
                Check(); first = session.Focus();
                if (options.IncludeSelection) selection = new(true, first.Status == "outside_target" ? "focus_outside" : first.Status == "inside_target" ? "not_in_tree" : "unavailable");
                Check(); IControlNode? root = session.Root();
                if (root != null) pending.Push((root, 0, null)); else limitations.Add("provider_error");
                while (pending.Count > 0)
                {
                    Check();
                    if (visited >= options.MaxElements * 4 || rows.Count >= options.MaxElements) { limitations.Add("node_limit"); break; }
                    var entry = pending.Pop();
                    using IControlNode node = entry.Node;
                    visited++;
                    try
                    {
                        Check(); RawControl raw = session.Read(node);
                        if (raw.Key != null && !keys.Add(raw.Key)) { limitations.Add("cycle_detected"); continue; }
                        // Siblings remain within the original control-view parent. Never walk above the selected root.
                        if (entry.Depth > 0) { Check(); IControlNode? sibling = session.NextSibling(node); if (sibling != null) pending.Push((sibling, entry.Depth, entry.Parent)); }
                        if (!raw.InWindow) { limitations.Add("provider_error"); continue; }
                        if (entry.Depth > 0 && (raw.Offscreen != false || raw.Bounds?.Intersects(bounds) != true))
                        { if (raw.Offscreen == null || raw.Bounds?.Valid != true) limitations.Add("properties_unavailable"); continue; }
                        string? name = raw.Password == false ? raw.Name : null;
                        bool truncated = name?.Length > 256;
                        name = Clip(name, 256);
                        int? type = raw.Type is >= 50000 and <= 50040 ? raw.Type : null;
                        bool complete = raw.Complete && raw.Key != null && type != null && raw.Password != null && raw.Enabled != null && raw.Focused != null && raw.Offscreen != null && raw.Bounds?.Valid == true && (raw.Password != false || name != null);
                        if (!complete) limitations.Add("properties_unavailable");
                        if (truncated) limitations.Add("name_truncated");
                        string elementId = "el_" + Guid.NewGuid().ToString("N");
                        ControlRow row = new(elementId, entry.Parent, entry.Depth, type, type != null ? Roles[type.Value - 50000] : "unknown", name, truncated,
                            raw.Password, raw.Enabled, raw.Focused, raw.Offscreen, raw.Selected, raw.Bounds?.Valid == true ? raw.Bounds : null,
                            raw.Patterns.Where(Patterns.Contains).Distinct().ToArray(), complete);
                        bytes += JsonSerializer.SerializeToUtf8Bytes(row).Length;
                        if (bytes > 100 * 1024) { limitations.Add("result_budget"); break; }
                        rows.Add(row);
                        if (raw.Key != null) published[raw.Key] = elementId;
                        if (options.IncludeSelection && first.Status == "inside_target" && first.Key != null && first.Key == raw.Key && raw.Focused == true)
                        {
                            if (raw.Password != false) selection = new(true, "protected", elementId);
                            else if (!raw.Patterns.Contains("text")) selection = new(true, "unsupported", elementId);
                            else
                            {
                                Check(); RawSelection selected = session.Selection(node, 2048);
                                string status = selected.Status is "text" or "empty" or "unsupported" or "protected" or "unavailable" or "changed" ? selected.Status : "unavailable";
                                bool cut = selected.Truncated || selected.Text?.Length > 2048;
                                string? text = status == "text" ? Clip(selected.Text, 2048) : null;
                                if (status == "text" && string.IsNullOrEmpty(text)) status = "empty";
                                if (cut) { limitations.Add("selection_truncated"); if (status == "empty") status = "unavailable"; }
                                selection = new(true, status, elementId, status == "text" ? text : null, status == "text" && cut);
                            }
                        }
                        // Password/unknown-password branches are never descended into or read as text.
                        if (raw.Password != false) continue;
                        Check(); IControlNode? child = session.FirstChild(node);
                        if (child != null)
                        {
                            if (entry.Depth >= options.MaxDepth) { child.Dispose(); limitations.Add("depth_limit"); }
                            else pending.Push((child, entry.Depth + 1, elementId));
                        }
                    }
                    catch (ControlBudgetExceeded) { throw; }
                    catch (OperationCanceledException) { throw; }
                    catch { limitations.Add("provider_error"); }
                }
                Check(); last = session.Focus();
            }
            catch (ControlBudgetExceeded) { limitations.Add("time_limit"); }
            catch (OperationCanceledException) { throw; }
            catch { limitations.Add("provider_error"); }
            finally { while (pending.TryPop(out var entry)) entry.Node.Dispose(); }
            cancellation.ThrowIfCancellationRequested();
            WindowSelection after = windows.Resolve(scope, windowId, cancellation) ?? throw new ObservationException("stale_window");
            if (!initial.Window.SameIdentity(after.Window) || bounds != backend.Bounds(after, cancellation) || !after.Window.Visible || after.Window.Minimized || after.Window.Cloaked == true)
                throw new ObservationException("stale_observation");
            bool focusChanged = first.Status != last.Status || first.Key != last.Key;
            if (first.Status == "unavailable" || last.Status == "unavailable") limitations.Add("properties_unavailable");
            if (selection.status == "unavailable") limitations.Add("properties_unavailable");
            string focusStatus = focusChanged ? "changed" : last.Status;
            string? focusId = !focusChanged && last.Status == "inside_target" && last.Key != null && published.TryGetValue(last.Key, out string? found) ? found : null;
            if (focusId != null && rows.Single(row => row.element_id == focusId).focused != true) { focusChanged = true; focusStatus = "changed"; focusId = null; }
            if (focusChanged)
            {
                limitations.Add("focus_changed");
                if (options.IncludeSelection) selection = new(true, "changed");
            }
            if (selection.status == "changed") { limitations.Add("focus_changed"); focusStatus = "changed"; focusId = null; selection = new(true, "changed"); }
            DiscoveredWindow w = after.Window;
            ControlTreeResult result = new("obs_" + Guid.NewGuid().ToString("N"), windowId, new(w.Handle, w.Pid, w.ProcessStartedAt!, w.ThreadId, w.ClassName),
                before.ToString("O"), Now.ToString("O"), bounds, rows.FirstOrDefault()?.element_id, rows.ToArray(), new(focusStatus, focusId), selection,
                limitations.Count == 0, limitations.Order(StringComparer.Ordinal).ToArray(), visited);
            latest = new(result, published.ToDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal), options);
            return new(true, "executed", "ok", "已读取本次窗口控件与 UIA 焦点；complete/limitations 表示截断或部分失败。控件编号仅供本次观察，截图与 UIA 不是原子快照，后续输入仍须实时复核。", result);
        }
        catch (OperationCanceledException) { return new(false, started ? "executed" : "not_executed", "cancelled", "控件观察已取消，未发布控件引用。"); }
        catch (ObservationException error) { return new(false, started ? "executed" : "not_executed", error.Code, "控件观察的窗口已失效、布局变化或当前不可见，请重新发现／观察。"); }
        catch { return new(false, started ? "executed" : "not_executed", "unavailable", "控件读取不可用，可使用截图或其他当前可用工具继续。"); }
    }
    internal static string? Clip(string? value, int maximum)
    {
        if (value == null) return null;
        if (maximum <= 0) return "";
        int length = Math.Min(value.Length, maximum);
        if (length < value.Length && length > 0 && char.IsHighSurrogate(value[length - 1])) length--;
        return value[..length].Replace('\0', '\uFFFD');
    }
}
