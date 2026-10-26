// User-run only: synthetic windows and lifetimes, no real desktop, hooks, UIA or application input.
using System.Text.Json;
using Web2Term.WindowsHelper;

static class WindowCatalogTests
{
    static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    static readonly string Scope = "ws_" + new string('a', 32), OtherScope = "ws_" + new string('b', 32);
    static DiscoveredWindow Window(string handle = "0x1234", string title = "Report", uint pid = 42, string lifetime = "1:0") =>
        new(handle, pid, At.ToString("O"), 100, "ExampleWindow", title, new("Editor", @"C:\Apps\Editor.exe", null), true, false, false, true, false, null, lifetime);
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static ActionResult List(WindowCatalog catalog, string? cursor = null, string scope = "", string query = "", uint? pid = null, bool hidden = false, int limit = 25)
    {
        var p = new Dictionary<string, object?> { ["scope_id"] = scope.Length == 0 ? Scope : scope, ["query"] = query, ["pid"] = pid, ["include_hidden"] = hidden, ["limit"] = limit };
        if (cursor != null) p["cursor"] = cursor;
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(p));
        return catalog.List(json.RootElement, CancellationToken.None);
    }
    static WindowPage Data(ActionResult result) { Check(result.Ok, result.Message); return (WindowPage)result.Data!; }
    public static void RunAll()
    {
        var tests = new (string Name, Action Run)[] {
            ("same app and identical titles retain distinct window identities", Multiple),
            ("owner references name only verified owners in the current page", Owners),
            ("filtering uses actual titles and application metadata with PID and hidden options", Filtering),
            ("pagination preserves its snapshot and requires the original filters and scope", Pagination),
            ("new captures revoke the task's old references without revoking another task", Refresh),
            ("expiration makes references and cursors unusable", Expiration),
            ("process access or lifetime failures publish metadata without references", Unavailable),
            ("PID reuse cannot resolve an old reference", PidReuse),
            ("HWND reuse within one process is revoked by the lifetime epoch", HandleReuse),
            ("destroyed or changed thread and class identities cannot resolve", Changed),
            ("title and foreground changes return fresh metadata for the same identity", Fresh),
            ("unpublished or guessed references cannot resolve", Unpublished),
            ("cancelled fresh capture revokes old references and publishes nothing", Cancellation),
            ("malformed and override parameters never collect windows", Parameters),
            ("collection, page and task-scope storage have bounded limits", Limits)
        };
        foreach (var test in tests) { test.Run(); Console.WriteLine("PASS " + test.Name); }
    }
    static void Multiple()
    {
        var source = new FakeWindowDiscovery([Window(), Window("0x2234")]); var catalog = new WindowCatalog(source, () => At);
        var page = Data(List(catalog));
        Check(page.windows.Length == 2 && page.windows.Select(w => w.window_id).Distinct().Count() == 2 && page.windows.All(w => w.identity_verified), "same titles collapsed");
        foreach (var row in page.windows) Check(catalog.Resolve(Scope, row.window_id!, CancellationToken.None)?.Window.Handle == row.hwnd, "reference not resolvable");
    }
    static void Owners()
    {
        var source = new FakeWindowDiscovery([Window("0x10", "A owner"), Window("0x20", "B dialog") with { OwnerHandle = "0x10", Enabled = false }]);
        var catalog = new WindowCatalog(source, () => At); var page = Data(List(catalog));
        var child = page.windows.Single(w => w.hwnd == "0x20");
        Check(child.owner_hwnd == "0x10" && child.owner_window_id == page.windows.Single(w => w.hwnd == "0x10").window_id && !child.enabled, "owner relation lost");
        var first = Data(List(catalog, limit: 1)); var second = Data(List(catalog, first.next_cursor, limit: 1));
        Check(second.windows[0].owner_hwnd == "0x10" && second.windows[0].owner_window_id == null, "unpublished owner reference leaked");
    }
    static void Filtering()
    {
        var source = new FakeWindowDiscovery([Window("0x10", "本月报表") with { Foreground = true }, Window("0x20", "Other", 77) with { Visible = false }, Window("0x30", "Minimized") with { Visible = false, Minimized = true }]);
        var catalog = new WindowCatalog(source, () => At);
        Check(Data(List(catalog)).windows.Length == 2, "hidden default");
        Check(Data(List(catalog, hidden: true)).windows.Length == 3, "include hidden");
        Check(Data(List(catalog, query: "editor.EXE", pid: 42)).windows.Length == 2, "application path/PID filtering");
        Check(Data(List(catalog, query: "报表")).windows.Single().foreground, "title/foreground metadata");
        Check(Data(List(catalog, query: "unmatched")).total_matches == 0, "zero match fabricated");
    }
    static void Pagination()
    {
        var catalog = new WindowCatalog(new FakeWindowDiscovery([Window("0x10"), Window("0x20")]), () => At);
        var first = Data(List(catalog, limit: 1)); var second = Data(List(catalog, first.next_cursor, limit: 1));
        Check(first.snapshot_id == second.snapshot_id && first.windows[0].window_id != second.windows[0].window_id && !second.has_more, "pagination identity");
        Check(List(catalog, first.next_cursor, query: "changed").Code == "stale_window", "filter override accepted");
        Check(List(catalog, first.next_cursor, scope: OtherScope).Code == "stale_window", "cross-task cursor accepted");
    }
    static void Refresh()
    {
        var catalog = new WindowCatalog(new FakeWindowDiscovery([Window()]), () => At);
        var a = Data(List(catalog)); var b = Data(List(catalog, scope: OtherScope)); var next = Data(List(catalog));
        Check(a.snapshot_id != next.snapshot_id && a.windows[0].window_id != next.windows[0].window_id, "refresh reused references");
        Check(catalog.Resolve(Scope, a.windows[0].window_id!, CancellationToken.None) == null, "old task reference survived");
        Check(catalog.Resolve(OtherScope, b.windows[0].window_id!, CancellationToken.None) != null, "other task revoked");
        Check(catalog.Resolve(OtherScope, next.windows[0].window_id!, CancellationToken.None) == null, "cross-task reference resolved");
    }
    static void Expiration()
    {
        DateTime now = At; var catalog = new WindowCatalog(new FakeWindowDiscovery([Window("0x10"), Window("0x20")]), () => now);
        var page = Data(List(catalog, limit: 1)); now = now.AddMinutes(2);
        Check(catalog.Resolve(Scope, page.windows[0].window_id!, CancellationToken.None) == null && List(catalog, page.next_cursor).Code == "stale_window", "expired reference/cursor survived");
    }
    static void Unavailable()
    {
        var source = new FakeWindowDiscovery([Window("0x10") with { ProcessStartedAt = null }, Window("0x20") with { Lifetime = null }]);
        var page = Data(List(new(source, () => At)));
        Check(!page.complete && page.windows.All(w => w.window_id == null && !w.identity_verified) && page.limitations.Contains("metadata_unavailable"), "unverified window received ID");
    }
    static void PidReuse()
    {
        var source = new FakeWindowDiscovery([Window()]); var catalog = new WindowCatalog(source, () => At); var page = Data(List(catalog));
        source.Windows = [Window() with { ProcessStartedAt = At.AddSeconds(1).ToString("O") }];
        Check(catalog.Resolve(Scope, page.windows[0].window_id!, CancellationToken.None) == null, "reused PID accepted");
    }
    static void HandleReuse()
    {
        var source = new FakeWindowDiscovery([Window()]); var catalog = new WindowCatalog(source, () => At); var page = Data(List(catalog));
        source.Windows = [Window(lifetime: "1:2")];
        Check(catalog.Resolve(Scope, page.windows[0].window_id!, CancellationToken.None) == null, "same-process HWND reuse accepted");
        source.Windows = [Window()]; Check(catalog.Resolve(Scope, page.windows[0].window_id!, CancellationToken.None) == null, "revoked reference resurrected");
    }
    static void Changed()
    {
        foreach (var replacement in new DiscoveredWindow?[] { null, Window() with { ThreadId = 101 }, Window() with { ClassName = "OtherClass" }, Window() with { Stable = false }, Window() with { Lifetime = null } })
        {
            var source = new FakeWindowDiscovery([Window()]); var catalog = new WindowCatalog(source, () => At); var page = Data(List(catalog));
            source.Windows = replacement == null ? [] : [replacement];
            Check(catalog.Resolve(Scope, page.windows[0].window_id!, CancellationToken.None) == null, "changed/unavailable identity accepted");
        }
    }
    static void Fresh()
    {
        var source = new FakeWindowDiscovery([Window()]); var catalog = new WindowCatalog(source, () => At); var page = Data(List(catalog));
        source.Windows = [Window(title: "Changed content") with { Foreground = true, Minimized = true, OwnerHandle = "0x55" }];
        var resolved = catalog.Resolve(Scope, page.windows[0].window_id!, CancellationToken.None)!;
        Check(resolved.Window.Title == "Changed content" && resolved.Window.Foreground && resolved.Window.OwnerHandle == "0x55", "cached state used as current");
    }
    static void Unpublished()
    {
        var catalog = new WindowCatalog(new FakeWindowDiscovery([Window()]), () => At); var page = Data(List(catalog));
        Check(catalog.Resolve(Scope, "win_" + new string('0', 32), CancellationToken.None) == null, "guessed reference accepted");
        Check(catalog.Resolve(OtherScope, page.windows[0].window_id!, CancellationToken.None) == null, "cross-scope reference accepted");
    }
    static void Cancellation()
    {
        var source = new FakeWindowDiscovery([Window()]); var catalog = new WindowCatalog(source, () => At); var old = Data(List(catalog));
        source.Cancel = true;
        Check(List(catalog).Code == "cancelled" && catalog.Resolve(Scope, old.windows[0].window_id!, CancellationToken.None) == null, "cancelled collection left old references");
    }
    static void Parameters()
    {
        var source = new FakeWindowDiscovery([Window()]); var action = new ListWindowsAction(new(source, () => At));
        foreach (object request in new object[] { new { hwnd = "0x1234" }, new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 51 },
            new { scope_id = Scope, query = "", pid = "42", include_hidden = false, limit = 25 },
            new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25, command = "text" } })
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(request));
            Check(action.Execute(json.RootElement, CancellationToken.None).Code == "invalid_parameters", "bad parameters accepted");
        }
        Check(source.Captures == 0, "invalid parameters collected windows");
    }
    static void Limits()
    {
        var source = new FakeWindowDiscovery(Enumerable.Range(1, 600).Select(index => Window("0x" + index.ToString("x"))).ToArray());
        var catalog = new WindowCatalog(source, () => At); var page = Data(List(catalog, limit: 50));
        Check(page.windows.Length <= 50 && page.total_matches == 512 && !page.complete && page.limitations.Contains("enumeration_limited"), "bounds not enforced");
        for (int index = 0; index < 16; index++) _ = Data(List(catalog, scope: "ws_" + index.ToString("x32")));
        Check(catalog.Resolve(Scope, page.windows[0].window_id!, CancellationToken.None) == null, "scope cap not enforced");
    }
}

sealed class FakeWindowDiscovery(DiscoveredWindow[] windows) : IWindowDiscovery
{
    public DiscoveredWindow[] Windows = windows;
    public int Captures;
    public bool Cancel;
    public bool Complete = true;
    public DiscoveredWindowSnapshot Capture(bool hidden, CancellationToken cancellation)
    {
        Captures++; cancellation.ThrowIfCancellationRequested(); if (Cancel) throw new OperationCanceledException();
        return new(Windows, Complete, Complete ? [] : ["enumeration_limited"]);
    }
    public DiscoveredWindow? Read(string handle, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return Windows.FirstOrDefault(window => window.Handle == handle); }
}
