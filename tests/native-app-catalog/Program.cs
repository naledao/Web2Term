// User-run only. Pure native catalog with synthetic source/verification, no Windows APIs or filesystem IO.
using System.Text.Json;
using Web2Term.WindowsHelper;

static class CatalogTests
{
    static readonly VerifiedExecutable Exe = new(@"C:\Apps\Example.exe", 512, 100);
    static AppCandidate Candidate(string name = "Example", string source = "app_paths", string? identity = null) =>
        new(identity ?? "exe:" + Exe.Path.ToUpperInvariant(), name, source, Exe, new("executable", Exe.Path, Exe));
    static ActionResult List(ApplicationCatalog catalog, object? request = null)
    {
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(request ?? new { }));
        return catalog.List(document.RootElement, CancellationToken.None);
    }
    static CatalogPage Data(ActionResult result) { Check(result.Ok, result.Message); return (CatalogPage)result.Data!; }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }

    static void Main()
    {
        var cases = new (string Name, Action Run)[] {
            ("exact executable identities merge aliases, sources and verified references", Merge),
            ("same display names and distinct launch purposes never collapse", Distinct),
            ("case-insensitive keyword search uses names, aliases and real paths", Query),
            ("pagination is bound to query and snapshot and refresh expires it", Pagination),
            ("partial sources and zero matches do not claim absence", Partial),
            ("portable registration is verified and removed when the file becomes unavailable", Registration),
            ("malformed or conflicting arguments remain not executed", Parameters),
            ("app and metadata limits preserve a partial result", Limits),
            ("cancelled snapshot collection does not leave reusable old cursors", Cancellation),
            ("verified running process windows rank above background-only candidates", Ranking)
        };
        foreach (var item in cases) { item.Run(); Console.WriteLine("PASS " + item.Name); }
        InputSafetyTests.RunAll();
        DesktopActivityTests.RunAll();
        ApplicationLaunchTests.RunAll();
        ResourceOpenTests.RunAll();
        WindowCatalogTests.RunAll();
        ControlPlaneWindowTests.RunAll();
        WindowInteractionTests.RunAll();
        WindowFocusTests.RunAll();
        ObservationTests.RunAll();
        ControlTreeTests.RunAll();
        ObservationBindingTests.RunAll();
        CoordinateTests.RunAll();
        ClickTests.RunAll();
        DesktopClickTests.RunAll();
        TypeTextTests.RunAll();
        PressKeyTests.RunAll();
        ScrollTests.RunAll();
        DragTests.RunAll();
        WaitForTests.RunAll();
    }
    static void Merge()
    {
        var source = new FakeDiscovery([Candidate("Example", "app_paths"), Candidate("实例程序", "start_menu")]);
        var first = Data(List(new(source, _ => Exe)));
        Check(first.apps.Length == 1 && first.apps[0].sources.Length == 2 && first.apps[0].aliases.Contains("实例程序"), "merge failed");
        Check(first.apps[0].launch_references.Length == 1 && first.apps[0].launch_references[0].verified, "reference duplicated");
        var second = Data(List(new ApplicationCatalog(source, _ => Exe)));
        Check(first.apps[0].app_id == second.apps[0].app_id && first.apps[0].launch_references[0] == second.apps[0].launch_references[0], "unstable ids");
    }
    static void Distinct()
    {
        var catalog = new ApplicationCatalog(new FakeDiscovery([Candidate("Example", identity: "aumid:app1"), Candidate("Example", identity: "aumid:app2"),
            Candidate("Example", identity: "shortcut:profile-A"), Candidate("Example", identity: "shortcut:profile-B")]), _ => Exe);
        Check(Data(List(catalog)).apps.Length == 4, "name-based false merge");
    }
    static void Query()
    {
        var catalog = new ApplicationCatalog(new FakeDiscovery([Candidate("Example"), Candidate("实例程序", "start_menu")]), _ => Exe);
        foreach (string keyword in new[] { "example", "实例", "C:\\APPS\\" }) Check(Data(List(catalog, new { query = keyword })).apps.Length == 1, "query failed");
        Check(Data(List(catalog, new { query = "missing" })).apps.Length == 0, "unexpected result");
    }
    static void Pagination()
    {
        var catalog = new ApplicationCatalog(new FakeDiscovery(Enumerable.Range(0, 30).Select(index => Candidate("App " + index, identity: "synthetic:" + index))), _ => Exe);
        var first = Data(List(catalog, new { query = "App", limit = 12 }));
        Check(first.has_more && first.apps.Length == 12 && first.total_matches == 30, "first page");
        var second = Data(List(catalog, new { query = "App", cursor = first.next_cursor, limit = 25 }));
        Check(!second.has_more && second.apps.Length == 18 && second.apps.All(app => first.apps.All(old => old.app_id != app.app_id)), "pagination duplicate");
        Check(List(catalog, new { query = "different", cursor = first.next_cursor }).Code == "stale_catalog", "query binding");
        _ = Data(List(catalog, new { refresh = true }));
        Check(List(catalog, new { query = "App", cursor = first.next_cursor }).Code == "stale_catalog", "refresh binding");
    }
    static void Partial()
    {
        var source = new FakeDiscovery([]) { PartialSource = true };
        var result = List(new(source, _ => Exe), new { query = "not found" });
        Check(!Data(result).complete && result.Message.Contains("不代表未安装"), "false absence/completeness");
    }
    static void Registration()
    {
        bool exists = true; var catalog = new ApplicationCatalog(new FakeDiscovery([]), _ => exists ? Exe : null);
        var registered = Data(List(catalog, new { register_path = Exe.Path }));
        Check(registered.registered_app_id == registered.apps.Single().app_id && registered.apps[0].sources.Contains("registered_path"), "registration");
        exists = false;
        Check(Data(List(catalog, new { refresh = true })).apps.Length == 0, "vanished path retained");
        Check(!List(catalog, new { register_path = Exe.Path }).Ok, "invalid registration accepted");
    }
    static void Parameters()
    {
        var catalog = new ApplicationCatalog(new FakeDiscovery([]), _ => Exe);
        object[] invalid = [new { limit = 0 }, new { limit = "12" }, new { limit = 26 }, new { query = true }, new { refresh = "true" },
            new { command = "text" }, new { register_path = "guess.exe" }, new { register_path = @"\\server\share\app.exe" },
            new { cursor = "cursor", refresh = true }, new { cursor = "cursor", register_path = Exe.Path }];
        foreach (object request in invalid) { var result = List(catalog, request); Check(!result.Ok && result.Execution == "not_executed", "invalid request executed"); }
    }
    static void Limits()
    {
        var catalog = new ApplicationCatalog(new FakeDiscovery(Enumerable.Range(0, 4100).Select(index => Candidate("App " + index, identity: "synthetic:" + index))), _ => Exe);
        var result = Data(List(catalog, new { limit = 25 }));
        Check(result.total_matches == 4096 && !result.complete && result.apps.Length == 25, "unbounded catalog");
    }
    static void Cancellation()
    {
        var source = new FakeDiscovery(Enumerable.Range(0, 15).Select(index => Candidate("App " + index, identity: "synthetic:" + index)));
        var catalog = new ApplicationCatalog(source, _ => Exe);
        var first = Data(List(catalog, new { limit = 1 }));
        source.Cancel = true;
        try { List(catalog, new { refresh = true }); throw new Exception("expected cancellation"); } catch (OperationCanceledException) { }
        Check(List(catalog, new { cursor = first.next_cursor }).Code == "stale_catalog", "old cursor reused after cancellation");
    }
    static void Ranking()
    {
        var process = new ProcessSummary(42, DateTime.UtcNow.ToString("O"), true, [new("0x1234", "Actual title", true, false)]);
        var catalog = new ApplicationCatalog(new FakeDiscovery([Candidate("A background", identity: "a"), Candidate("Z foreground app", "running_process", "z") with { Process = process }]), _ => Exe);
        Check(Data(List(catalog)).apps[0].processes[0].windows[0].title == "Actual title", "GUI candidate ranking");
    }
}

sealed class FakeDiscovery(IEnumerable<AppCandidate> candidates) : IApplicationDiscovery
{
    public bool PartialSource;
    public bool Cancel;
    public void Collect(DiscoveryContext context, IReadOnlyDictionary<string, SourceState> states, Action<AppCandidate> add)
    {
        if (Cancel) throw new OperationCanceledException();
        if (PartialSource) states["applications_folder"].Partial();
        foreach (AppCandidate candidate in candidates) { states[candidate.Source].Checked++; add(candidate); }
    }
}
