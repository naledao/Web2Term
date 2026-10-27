// User-run only. Synthetic windows/UIA/events; never uses COM, desktop capture, input or real sleeps.
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class WaitForTests
{
    private static readonly DateTime At = new(2026, 10, 26, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", WaitId = "11111111-1111-4111-8111-111111111111";
    private static void Check(bool value, string reason) { if (!value) throw new Exception(reason); }
    private static DiscoveredWindow Window(string handle = "0x1234", string title = "Report") =>
        new(handle, 42, At.ToString("O"), 43, "SyntheticWindow", title, new("Editor", @"C:\Apps\Editor.exe", null), true, false, false, true, false, null, "life-A");
    private static RawControl Raw(string key, string name) => new(key, key == "root" ? 50032 : 50000, name, false, true, key == "edit", false, null,
        new(10, 20, 80, 30), key == "root" ? ["window"] : ["invoke"], true);
    private sealed record Fixture(FakeWindowDiscovery Discovery, WindowCatalog Windows, FakeControlBackend Backend, WaitProbeService Service);
    private static Fixture Create(Func<DateTime>? clock = null, Func<WindowSelection?, CancellationToken, string?>? revision = null)
    {
        clock ??= () => At;
        var discovery = new FakeWindowDiscovery([Window()]); var windows = new WindowCatalog(discovery, clock);
        var backend = new FakeControlBackend(new SyntheticControl(Raw("root", "Host"), new SyntheticControl(Raw("edit", "Done"))));
        var controls = new ControlTreeService(windows, backend, clock, () => backend.Elapsed);
        return new(discovery, windows, backend, new(windows, discovery, controls, 9000, revision, clock));
    }
    private static WaitOptions Find(string query = "report") => new("window_present", null, query, null, null, null);
    private static WaitOptions Text(string id, string text = "Done") => new("text_present", id, null, null, text, null);
    private static WaitOptions Control(string id) => new("control_available", id, null, null, null, new("Done", "button"));
    private static WaitProbe Probe(Fixture f, WaitOptions options)
    {
        ActionResult result = f.Service.Probe(Scope, WaitId, options, 500, CancellationToken.None);
        Check(result.Ok && result.Execution == "executed", result.Message); return (WaitProbe)result.Data!;
    }
    internal static void RunAll()
    {
        Discover(); Ambiguous(); Controls(); Changed(); Expired(); Parameters();
        Console.WriteLine("PASS bounded wait discovery, predicates, event changes, scope lifetime and strict private parameters");
    }
    private static void Discover()
    {
        var f = Create(); WaitProbe found = Probe(f, Find()); string id = found.window!.window_id!;
        Check(found.status == "met" && found.matches == 1 && found.controls == null && found.complete, "unique visible discovery failed");
        Check(!found.input_ready && !found.goal_verified && f.Backend.Opened == 0, "discovery read UIA or claimed input/business success");
        Check(f.Windows.Resolve(Scope, id, CancellationToken.None)?.Window.Handle == "0x1234", "wait reference not usable");
        Check(Probe(f, Find()).window!.window_id == id, "same identity repeatedly minted references");
        using var p = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
        var page = (WindowPage)f.Windows.List(p.RootElement, CancellationToken.None).Data!; string listed = page.windows[0].window_id!;
        Check(f.Windows.Resolve(Scope, id, CancellationToken.None) == null, "fresh list retained old wait reference");
        Probe(f, Find()); Check(f.Windows.Resolve(Scope, listed, CancellationToken.None) != null, "wait revoked original list reference");
        f.Discovery.Windows[0] = f.Discovery.Windows[0] with { Lifetime = "life-B" };
        Check(f.Windows.Resolve(Scope, listed, CancellationToken.None) == null, "same HWND with changed lifecycle was reused");
        var transient = Create(); string old = Probe(transient, Find()).window!.window_id!;
        transient.Discovery.Windows = []; Check(transient.Windows.Resolve(Scope, old, CancellationToken.None) == null, "unreadable reference was not revoked");
        transient.Discovery.Windows = [Window()]; string renewed = Probe(transient, Find()).window!.window_id!;
        Check(renewed != old && transient.Windows.Resolve(Scope, renewed, CancellationToken.None) != null && transient.Windows.Resolve(Scope, old, CancellationToken.None) == null, "rediscovery revived a revoked ID or returned an unusable alias");
    }
    private static void Ambiguous()
    {
        var f = Create(); f.Discovery.Windows = [Window(), Window("0x2234")];
        WaitProbe result = Probe(f, Find()); Check(result.status == "ambiguous" && result.matches == 2 && result.window == null, "ambiguous window picked first match");
        foreach (var w in new[] { Window() with { Visible = false }, Window() with { Minimized = true }, Window() with { Cloaked = true }, Window() with { ClassName = "#32768" }, Window() with { Pid = 9000 } }) {
            f.Discovery.Windows = [w]; Check(Probe(f, Find()).status == "not_met", "hidden, minimized, menu or controller accepted as ordinary target");
        }
        var partial = Create(); partial.Discovery.Complete = false;
        result = Probe(partial, Find()); Check(result.status == "unavailable" && !result.complete && result.window == null, "partial enumeration established uniqueness");
    }
    private static void Controls()
    {
        var f = Create(); string id = Probe(f, Find()).window!.window_id!;
        Check(Probe(f, Text(id)).status == "met" && Probe(f, Text(id, "done")).status == "not_met", "text matching lost case sensitivity");
        Check(Probe(f, Control(id)).status == "met", "unique enabled visible control not found");
        var child = f.Backend.RootNode.Children[0]; child.Raw = child.Raw with { Enabled = false };
        Check(Probe(f, Control(id)).status == "not_met" && Probe(f, Text(id)).status == "met", "disabled state used for text existence or ignored for controls");
        child.Raw = child.Raw with { Enabled = true, Password = true };
        Check(Probe(f, Text(id)).matches == 0, "password name exposed"); child.Raw = child.Raw with { Password = false };
        f.Backend.RootNode.Children.Add(new(Raw("other", "Done")));
        Check(Probe(f, Control(id)).status == "ambiguous", "same-name controls picked first");
        f.Backend.FailReadKey = "other";
        Check(Probe(f, Text(id)).status == "met", "partial tree discarded observed text existence");
        Check(Probe(f, Control(id)).status == "unavailable", "partial tree established unique control");
        Check(Probe(f, Control(id) with { Condition = "control_present" }).status == "met", "partial tree discarded a real available match");
        Check(f.Backend.LiveNodes == 0 && f.Backend.Opened == f.Backend.Closed && f.Backend.Invoked == 0 && f.Backend.TextSets == 0, "wait retained nodes or performed input");
    }
    private static void Changed()
    {
        int events = 0; var f = Create(revision: (_, _) => (++events).ToString());
        WaitProbe result = Probe(f, Find()); Check(result.status == "unavailable" && result.window == null && result.limitations.Contains("state_changed"), "changed discovery reported a stable match");
        var controls = Create(); string id = Probe(controls, Find()).window!.window_id!;
        controls.Backend.AfterRead = _ => controls.Discovery.Windows[0] = controls.Discovery.Windows[0] with { Lifetime = "new-life" };
        ActionResult changed = controls.Service.Probe(Scope, WaitId, Text(id), 500, CancellationToken.None);
        Check(!changed.Ok && changed.Code == "stale_window", "reused identity was accepted after UIA read");
        using var cancel = new CancellationTokenSource(); cancel.Cancel(); bool stopped = false;
        try { controls.Service.Probe(Scope, WaitId, Find(), 500, cancel.Token); } catch (OperationCanceledException) { stopped = true; }
        Check(stopped, "cancelled probe continued");
    }
    private static void Expired()
    {
        DateTime time = At; var f = Create(() => time); Probe(f, Find());
        for (int n = 1; n <= 20; n++) { time = At.AddMinutes(n); Check(Probe(f, Find()).status == "met", "active wait lease expired during a bounded long wait"); }
        time = time.AddMinutes(16);
        Check(f.Service.Probe(Scope, WaitId, Find(), 500, CancellationToken.None).Code == "stale_window", "wait revived expired scope");
        var capped = Create();
        for (int n = 0; n < 32; n++) { capped.Discovery.Windows = [Window("0x" + (1000 + n).ToString("x"))]; Check(Probe(capped, Find()).status == "met", "wait reference budget exhausted early"); }
        capped.Discovery.Windows = [Window("0x9999")]; Check(Probe(capped, Find()).status == "unavailable", "unbounded wait references");
    }
    private static void Parameters()
    {
        var f = Create(); var action = new WaitForAction(f.Service);
        var request = new Dictionary<string, object?> { ["scope_id"] = Scope, ["wait_id"] = WaitId, ["condition"] = "window_present", ["window_id"] = null,
            ["query"] = "Report", ["pid"] = null, ["text"] = null, ["selector"] = null, ["budget_ms"] = 500 };
        foreach (var pair in new (string Key, object? Value)[] { ("command", "anything"), ("budget_ms", 501), ("query", " "), ("wait_id", "guess"), ("pid", 0), ("selector", new { name = "Done", role = "button" }) }) {
            var bad = new Dictionary<string, object?>(request) { [pair.Key] = pair.Value };
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(bad)); Check(action.Execute(json.RootElement, CancellationToken.None).Code == "invalid_parameters", "private override accepted");
        }
        Check(f.Discovery.Captures == 0, "invalid request discovered windows");
        using var valid = JsonDocument.Parse(JsonSerializer.Serialize(request)); Check(action.Execute(valid.RootElement, CancellationToken.None).Ok, "valid private request rejected");
        string duplicate = JsonSerializer.Serialize(request).Replace("\"budget_ms\":500", "\"budget_ms\":500,\"budget_ms\":500");
        using var duplicated = JsonDocument.Parse(duplicate); Check(action.Execute(duplicated.RootElement, CancellationToken.None).Code == "invalid_parameters", "duplicate private keys accepted");
    }
}
