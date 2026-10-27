// User-run only. No Windows dispatcher/probe is linked into this test project.
using System.Text.Json;
using Web2Term.WindowsHelper;

static class ApplicationLaunchTests
{
    static readonly VerifiedExecutable Exe = new(@"C:\Apps\Example.exe", 512, 100);
    static readonly DateTime Timestamp = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    static ObservedAppWindow Window(string hwnd = "0x1234", uint pid = 42, string? path = null, string title = "Example", string? aumid = null,
        bool foreground = false, string? started = null) => new(hwnd, title, true, false, pid, started ?? Timestamp.ToString("O"), foreground, path ?? Exe.Path, aumid);
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static AppLaunchResult Data(ActionResult result) => result.Data as AppLaunchResult ?? throw new Exception(result.Message);

    static (ApplicationCatalog Catalog, LaunchSelection Selection) Catalog(Func<DateTime>? clock = null)
    {
        var candidate = new AppCandidate("exe:" + Exe.Path.ToUpperInvariant(), "Example", "app_paths", Exe, new("executable", Exe.Path, Exe));
        var catalog = new ApplicationCatalog(new FakeDiscovery([candidate]), _ => Exe, clock);
        using JsonDocument parameters = JsonDocument.Parse("{}");
        var page = (CatalogPage)catalog.List(parameters.RootElement, CancellationToken.None).Data!;
        var app = page.apps.Single();
        var selection = catalog.ResolveLaunch(page.catalog_id, app.app_id, app.launch_references[0].reference_id)!;
        return (catalog, selection);
    }
    static ActionResult Invoke(LaunchAppAction action, LaunchSelection selection, int wait = 0, object? request = null, CancellationToken cancellation = default)
    {
        using var parameters = JsonDocument.Parse(JsonSerializer.Serialize(request ?? new { catalog_id = selection.CatalogId, app_id = selection.AppId,
            launch_reference_id = selection.ReferenceId, wait_ms = wait }));
        return action.Execute(parameters.RootElement, cancellation);
    }
    public static void RunAll()
    {
        var tests = new (string Name, Action Run)[] {
            ("launch accepts only a current native catalog reference", References),
            ("expired snapshots cannot launch an app", Expiration),
            ("malformed launch input never dispatches", Parameters),
            ("single-instance reuse succeeds without a returned process", SingleInstance),
            ("proxy process does not determine the target window", Proxy),
            ("packaged identity can match an existing host window", Packaged),
            ("PID reuse is not treated as a matching returned process", PidReuse),
            ("unassociated new windows remain tentative", Unassociated),
            ("partial baseline cannot label unrelated windows as new", Partial),
            ("pre-dispatch cancellation performs no launch", CancelBefore),
            ("cancellation after dispatch preserves the executed launch", CancelAfter),
            ("failed activation is unknown and never retried", Failure),
            ("stale validation failure is not executed", Stale),
            ("candidate observation is bounded and never completes the goal", Bounds),
            ("refresh and changed source fingerprints revoke old references", Refresh)
        };
        foreach (var item in tests) { item.Run(); Console.WriteLine("PASS " + item.Name); }
    }
    static void References()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher(); var probe = new FakeWindowProbe();
        var action = new LaunchAppAction(f.Catalog, new(dispatcher, probe, (_, _) => {}));
        var unknown = f.Selection with { ReferenceId = "launch_" + new string('0', 32) };
        Check(Invoke(action, unknown).Code == "stale_catalog" && dispatcher.Calls == 0 && probe.Calls == 0, "unknown reference dispatched");
        Check(Invoke(action, f.Selection).Ok && dispatcher.Calls == 1, "valid reference did not dispatch");
    }
    static void Expiration()
    {
        DateTime now = Timestamp; var f = Catalog(() => now); now = now.AddMinutes(3);
        Check(f.Catalog.ResolveLaunch(f.Selection.CatalogId, f.Selection.AppId, f.Selection.ReferenceId) != null, "normal delivery delay expired a known app reference");
        now = Timestamp.AddMinutes(16);
        var dispatcher = new FakeDispatcher(); var action = new LaunchAppAction(f.Catalog, new(dispatcher, new FakeWindowProbe()));
        Check(Invoke(action, f.Selection).Code == "stale_catalog" && dispatcher.Calls == 0, "expired catalog dispatched");
    }
    static void Parameters()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher(); var action = new LaunchAppAction(f.Catalog, new(dispatcher, new FakeWindowProbe()));
        object[] invalid = [new { app_id = f.Selection.AppId, path = Exe.Path },
            new { catalog_id = f.Selection.CatalogId, app_id = f.Selection.AppId, launch_reference_id = f.Selection.ReferenceId, wait_ms = -1 },
            new { catalog_id = f.Selection.CatalogId, app_id = f.Selection.AppId, launch_reference_id = f.Selection.ReferenceId, wait_ms = "0" },
            new { catalog_id = f.Selection.CatalogId, app_id = f.Selection.AppId, launch_reference_id = f.Selection.ReferenceId, wait_ms = 0, command = "text" }];
        foreach (object input in invalid) Check(Invoke(action, f.Selection, request: input).Execution == "not_executed", "invalid execution state");
        Check(dispatcher.Calls == 0, "invalid parameters dispatched");
    }
    static void SingleInstance()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher();
        var probe = new FakeWindowProbe { Snapshot = call => new(Timestamp.AddMilliseconds(call), [Window(foreground: call > 1)], true) };
        var result = new ApplicationLaunchService(dispatcher, probe).Launch(f.Selection, 0, CancellationToken.None);
        Check(result.Ok && result.Execution == "executed" && Data(result).returned_process == null, "null process falsely failed");
        Check(Data(result).candidate_windows.Single().change == "changed" && !Data(result).target_window_confirmed && !Data(result).goal_verified, "inferred completion");
    }
    static void Proxy()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher { Attempt = new(true, true, "shell_execute", new(99, Timestamp.ToString("O"))) };
        var probe = new FakeWindowProbe { Snapshot = call => new(Timestamp.AddMilliseconds(call), call == 1 ? [] : [Window(pid: 777)], true) };
        var data = Data(new ApplicationLaunchService(dispatcher, probe).Launch(f.Selection, 0, CancellationToken.None));
        Check(data.candidate_windows.Single().pid == 777 && data.candidate_windows[0].match_basis == "executable_path", "only proxy PID used");
    }
    static void Packaged()
    {
        var f = Catalog(); var selected = f.Selection with { Identity = "aumid:Package!App", Launch = new("shell_item", "known-shell-item", null, AppUserModelId: "Package!App") };
        var dispatcher = new FakeDispatcher { Attempt = new(true, true, "application_activation", new(99, null)) };
        var probe = new FakeWindowProbe { Snapshot = call => new(Timestamp.AddMilliseconds(call), [Window(path: @"C:\Windows\Host.exe", aumid: "Package!App")], true) };
        var data = Data(new ApplicationLaunchService(dispatcher, probe).Launch(selected, 0, CancellationToken.None));
        Check(data.method == "application_activation" && data.candidate_windows.Single().match_basis == "app_user_model_id" && !data.target_window_confirmed, "packaged host association");
    }
    static void PidReuse()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher { Attempt = new(true, true, "shell_execute", new(42, Timestamp.ToString("O"))) };
        var probe = new FakeWindowProbe { Snapshot = call => new(Timestamp.AddMilliseconds(call), call == 1 ? [] : [Window(path: @"C:\Other.exe", started: Timestamp.AddSeconds(10).ToString("O"))], true) };
        var candidate = Data(new ApplicationLaunchService(dispatcher, probe).Launch(f.Selection, 0, CancellationToken.None)).candidate_windows.Single();
        Check(candidate.match_basis == "window_change", "reused PID identified as returned process");
    }
    static void Unassociated()
    {
        var f = Catalog(); var probe = new FakeWindowProbe { Snapshot = call => new(Timestamp.AddMilliseconds(call), call == 1 ? [] : [Window(path: @"C:\Other.exe")], true) };
        var data = Data(new ApplicationLaunchService(new FakeDispatcher(), probe).Launch(f.Selection, 0, CancellationToken.None));
        Check(data.candidate_windows.Single().match_basis == "window_change" && !data.target_window_confirmed, "new unrelated window confirmed");
    }
    static void Partial()
    {
        var f = Catalog(); var probe = new FakeWindowProbe { Snapshot = call => new(Timestamp.AddMilliseconds(call), call == 1 ? [] : [Window(path: @"C:\Other.exe")], false) };
        var data = Data(new ApplicationLaunchService(new FakeDispatcher(), probe).Launch(f.Selection, 0, CancellationToken.None));
        Check(data.candidate_windows.Length == 0 && !data.observation_complete, "partial baseline invented a new candidate");
    }
    static void CancelBefore()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher(); using var abort = new CancellationTokenSource(); abort.Cancel();
        var result = new ApplicationLaunchService(dispatcher, new FakeWindowProbe()).Launch(f.Selection, 0, abort.Token);
        Check(result.Execution == "not_executed" && dispatcher.Calls == 0, "cancelled launch dispatched");
    }
    static void CancelAfter()
    {
        var f = Catalog(); using var abort = new CancellationTokenSource(); var dispatcher = new FakeDispatcher { OnDispatch = () => abort.Cancel() };
        var result = new ApplicationLaunchService(dispatcher, new FakeWindowProbe()).Launch(f.Selection, 0, abort.Token);
        Check(result.Code == "cancelled" && result.Execution == "executed" && Data(result).dispatch_status == "dispatched", "dispatch erased by cancellation");
    }
    static void Failure()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher { Attempt = new(false, true, "application_activation", Error: -1) };
        var result = new ApplicationLaunchService(dispatcher, new FakeWindowProbe(), (_, _) => {}).Launch(f.Selection, 0, CancellationToken.None);
        Check(result.Code == "launch_failed" && result.Execution == "unknown" && dispatcher.Calls == 1 && Data(result).dispatch_status == "unknown", "activation replayed or falsely not executed");
    }
    static void Stale()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher { Attempt = new(false, false, "shell_execute", FailureCode: "stale_catalog") };
        var result = new ApplicationLaunchService(dispatcher, new FakeWindowProbe()).Launch(f.Selection, 0, CancellationToken.None);
        Check(result.Code == "stale_catalog" && result.Execution == "not_executed" && result.Data == null, "stale reference executed");
    }
    static void Bounds()
    {
        var f = Catalog(); var dispatcher = new FakeDispatcher(); int waits = 0;
        var probe = new FakeWindowProbe { Snapshot = call => new(Timestamp.AddMilliseconds(call), call == 1 ? [] : Enumerable.Range(1, 20).Select(index => Window("0x" + index.ToString("x"), (uint)index)).ToArray(), true) };
        var result = new ApplicationLaunchService(dispatcher, probe, (_, _) => waits++).Launch(f.Selection, 5000, CancellationToken.None);
        Check(Data(result).candidate_windows.Length == 12 && !Data(result).observation_complete && !Data(result).goal_verified, "candidate limit/completion");
        var empty = new FakeWindowProbe(); waits = 0;
        _ = new ApplicationLaunchService(new FakeDispatcher(), empty, (_, _) => waits++).Launch(f.Selection, 5000, CancellationToken.None);
        Check(waits <= 25 && empty.Calls <= 27, "unbounded observation loop");
    }
    static void Refresh()
    {
        var f = Catalog(); using var parameters = JsonDocument.Parse("{\"refresh\":true}");
        _ = f.Catalog.List(parameters.RootElement, CancellationToken.None);
        Check(f.Catalog.ResolveLaunch(f.Selection.CatalogId, f.Selection.AppId, f.Selection.ReferenceId) == null, "old snapshot survived refresh");
        var candidate = new AppCandidate("shortcut:known", "App", "start_menu", Exe, new("shortcut", @"C:\Menu\App.lnk", Exe, SourceFingerprint: "first"));
        List<AppCandidate> entries = [candidate]; var catalog = new ApplicationCatalog(new FakeDiscovery(entries), _ => Exe);
        using var firstQuery = JsonDocument.Parse("{}"); var first = (CatalogPage)catalog.List(firstQuery.RootElement, CancellationToken.None).Data!;
        entries[0] = candidate with { Launch = candidate.Launch! with { SourceFingerprint = "changed" } };
        var second = (CatalogPage)catalog.List(parameters.RootElement, CancellationToken.None).Data!;
        Check(first.apps[0].launch_references[0].reference_id != second.apps[0].launch_references[0].reference_id, "changed shortcut retained its launch reference");
    }
}

sealed class FakeDispatcher : IAppLaunchDispatcher
{
    public int Calls;
    public DispatchAttempt Attempt = new(true, true, "shell_execute");
    public Action? OnDispatch;
    public DispatchAttempt Dispatch(LaunchSelection selection, CancellationToken cancellation) { Calls++; OnDispatch?.Invoke(); return Attempt; }
}
sealed class FakeWindowProbe : IAppWindowProbe
{
    public int Calls;
    public Func<int, WindowSnapshot> Snapshot = count => new(new DateTime(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(count), [], true);
    public WindowSnapshot Capture(CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); return Snapshot(++Calls); }
}
