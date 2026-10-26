// User-run only. This project links the pure focus state machine, never the Windows focus/UIA backend.
using System.Text.Json;
using Web2Term.WindowsHelper;

static class WindowFocusTests
{
    static readonly DateTime At = new(2026, 10, 25, 0, 0, 0, DateTimeKind.Utc);
    static readonly string Scope = "ws_" + new string('a', 32);
    static DiscoveredWindow Window() => new("0x1234", 42, At.AddSeconds(-10).ToString("O"), 100, "ExampleWindow", "Report",
        new("Editor", @"C:\Apps\Editor.exe", null), true, false, false, true, false, null, "1:0");
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static WindowFocusResult Data(ActionResult result) => result.Data as WindowFocusResult ?? throw new Exception(result.Message);
    static (WindowCatalog Catalog, FakeWindowDiscovery Source, FakeFocusBackend Backend, string Id) Fixture(DiscoveredWindow? window = null, Func<DateTime>? clock = null)
    {
        var source = new FakeWindowDiscovery([window ?? Window()]);
        var catalog = new WindowCatalog(source, clock ?? (() => At));
        using var parameters = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = true, limit = 25 }));
        var page = (WindowPage)catalog.List(parameters.RootElement, CancellationToken.None).Data!;
        return (catalog, source, new FakeFocusBackend(source), page.windows.Single().window_id!);
    }
    static ActionResult Focus((WindowCatalog Catalog, FakeWindowDiscovery Source, FakeFocusBackend Backend, string Id) f, bool restore = true, int wait = 0, CancellationToken cancellation = default) =>
        new WindowFocusService(f.Catalog, f.Backend, (_, token) => token.ThrowIfCancellationRequested(), () => At).Focus(Scope, f.Id, restore, wait, cancellation);
    public static void RunAll()
    {
        var tests = new (string Name, Action Run)[] {
            ("already focused target needs independent evidence and no activation", AlreadyFocused),
            ("normal activation validates actual foreground and keyboard focus", Activate),
            ("minimized and hidden targets restore once before activation", Restore),
            ("restore false leaves hidden targets untouched", NoRestore),
            ("disabled or cloaked targets return blocked evidence without switching to a popup", Blocked),
            ("unknown expired and reused references cannot focus", Stale),
            ("target replacement after restoration prevents activation", Replaced),
            ("Windows denial has at most two activation attempts and bounded polling", Denied),
            ("successful API receipt alone cannot confirm foreground", ReceiptOnly),
            ("missing or contrary UIA focus remains unconfirmed", UiaUnavailable),
            ("focus labels cannot override contradictory native or UIA roots", Contradictory),
            ("foreground loss during observation cannot become focus success", LostFocus),
            ("pre-dispatch cancellation performs no window change", CancelBefore),
            ("post-dispatch cancellation preserves the executed change", CancelAfter),
            ("backend exceptions preserve unknown effects and are not replayed", Unknown),
            ("native preflight failure is not mislabeled as a performed activation", Preflight),
            ("native action rejects raw handles overrides and malformed waits", Parameters)
        };
        foreach (var item in tests) { item.Run(); Console.WriteLine("PASS " + item.Name); }
    }
    static void AlreadyFocused()
    {
        var f = Fixture(Window() with { Foreground = true }); var result = Focus(f);
        Check(result.Ok && result.Execution == "executed" && f.Backend.Activations == 0 && f.Backend.Restorations == 0, "already focused target changed");
        Check(Data(result).focus_confirmed && !Data(result).input_ready && !Data(result).goal_verified, "focus granted input or business completion");
    }
    static void Activate()
    {
        var f = Fixture(); var result = Focus(f);
        Check(result.Ok && f.Backend.Activations == 1 && Data(result).activation_attempts.SequenceEqual(new bool?[] { true }), "activation not observed");
        Check(Data(result).target?.foreground == true && Data(result).observation.win32_focus == "confirmed" && Data(result).observation.uia_focus.status == "confirmed", "missing evidence");
    }
    static void Restore()
    {
        foreach (bool minimized in new[] { false, true })
        {
            var f = Fixture(Window() with { Visible = false, Minimized = minimized }); var result = Focus(f);
            Check(result.Ok && f.Backend.Restorations == 1 && f.Backend.Activations == 1 && Data(result).restore.attempted && Data(result).restore.accepted == true, "restore sequencing");
            Check(Data(result).target?.minimized == false && Data(result).target?.visible == true, "queued restore treated as completed");
        }
    }
    static void NoRestore()
    {
        var f = Fixture(Window() with { Minimized = true, Visible = false }); var result = Focus(f, restore: false);
        Check(result.Code == "restore_required" && result.Execution == "not_executed" && f.Backend.Restorations == 0 && f.Backend.Activations == 0, "restore=false changed window");
    }
    static void Blocked()
    {
        foreach (bool cloaked in new[] { false, true })
        {
            var f = Fixture(Window() with { Enabled = cloaked, Cloaked = cloaked }); f.Backend.BlockingWindow = "0x9999";
            var result = Focus(f);
            Check(result.Code == "window_blocked" && result.Execution == "not_executed" && f.Backend.Activations == 0 && f.Backend.Restorations == 0, "blocked target changed");
            Check(Data(result).blocking_window_hwnd == "0x9999" && !Data(result).input_ready, "blocking evidence lost");
        }
    }
    static void Stale()
    {
        var f = Fixture(); f.Source.Windows = [Window() with { Lifetime = "1:2" }];
        Check(Focus(f).Code == "stale_window" && f.Backend.Activations == 0, "reused identity focused");
        DateTime now = At; var expired = Fixture(clock: () => now); now = now.AddMinutes(2);
        Check(Focus(expired).Code == "stale_window" && expired.Backend.Activations == 0, "expired identity focused");
    }
    static void Replaced()
    {
        var f = Fixture(Window() with { Minimized = true });
        f.Backend.OnRestore = () => { f.Source.Windows = [Window() with { Lifetime = "changed" }]; return new(true, true); };
        var result = Focus(f);
        Check(result.Code == "stale_window" && result.Execution == "executed" && f.Backend.Activations == 0 && Data(result).target == null, "post-restore replacement activated");
    }
    static void Denied()
    {
        var f = Fixture(); f.Backend.OnActivate = () => new(true, false);
        var result = Focus(f, wait: 3000);
        Check(result.Code == "focus_denied" && result.Execution == "executed" && f.Backend.Activations == 2 && f.Backend.Observations <= 34, "unbounded recovery or false denial semantics");
        Check(!Data(result).focus_confirmed && !Data(result).input_ready, "denial authorized input");
    }
    static void ReceiptOnly()
    {
        var f = Fixture(); f.Backend.OnActivate = () => new(true, true);
        var result = Focus(f);
        Check(result.Code == "focus_denied" && !Data(result).focus_confirmed && Data(result).activation_attempts.Single() == true, "BOOL receipt became proof");
    }
    static void UiaUnavailable()
    {
        foreach (string status in new[] { "unavailable", "outside_target" })
        {
            var f = Fixture(); f.Backend.UiaStatus = status;
            var result = Focus(f, wait: 3000);
            Check(result.Code == "focus_unconfirmed" && Data(result).status == "foreground_only" && !Data(result).focus_confirmed && f.Backend.UiaChecks <= 2, "UIA mismatch ignored or unbounded");
        }
    }
    static void LostFocus()
    {
        var f = Fixture();
        f.Backend.AfterObserve = () => { if (f.Backend.Activations > 0) f.Source.Windows = [f.Source.Windows[0] with { Foreground = false }]; };
        var result = Focus(f);
        Check(!result.Ok && !Data(result).focus_confirmed && !Data(result).input_ready, "late foreground loss confirmed");
    }
    static void Contradictory()
    {
        foreach (bool uia in new[] { false, true })
        {
            var f = Fixture();
            f.Backend.PatchObservation = observation => uia ? observation with { uia_focus = new("confirmed", "0x9999", true) }
                : observation with { focus_root_hwnd = "0x9999" };
            var result = Focus(f);
            Check(!result.Ok && !Data(result).focus_confirmed && !Data(result).input_ready, "contradictory roots confirmed focus");
        }
    }
    static void CancelBefore()
    {
        var f = Fixture(); using var abort = new CancellationTokenSource(); abort.Cancel();
        var result = Focus(f, cancellation: abort.Token);
        Check(result.Code == "cancelled" && result.Execution == "not_executed" && f.Backend.Observations == 0 && f.Backend.Activations == 0, "cancelled action ran");
    }
    static void CancelAfter()
    {
        var f = Fixture(); using var abort = new CancellationTokenSource(); f.Backend.OnActivate = () => { abort.Cancel(); return new(true, true); };
        var result = Focus(f, cancellation: abort.Token);
        Check(result.Code == "cancelled" && result.Execution == "executed" && Data(result).activation_attempts.Single() == true && !Data(result).focus_confirmed, "executed activation erased");
    }
    static void Unknown()
    {
        var f = Fixture(); f.Backend.OnActivate = () => throw new IOException(); var result = Focus(f, wait: 3000);
        Check(result.Execution == "unknown" && result.Code == "executor_error" && Data(result).activation_attempts.Single() == null && f.Backend.Activations == 1, "unknown activation replayed or denied");
    }
    static void Preflight()
    {
        var f = Fixture(); f.Backend.OnActivate = () => new(false, null, "stale_window"); var result = Focus(f);
        Check(result.Code == "stale_window" && result.Execution == "not_executed" && Data(result).activation_attempts.Length == 0, "preflight failure became executed");
        var blocked = Fixture(); blocked.Backend.OnActivate = () => { blocked.Source.Windows = [Window() with { Enabled = false }]; return new(false, null, "window_blocked"); };
        Check(Focus(blocked).Code == "window_blocked", "late blocking state hidden");
    }
    static void Parameters()
    {
        var f = Fixture(); var action = new FocusWindowAction(new(f.Catalog, f.Backend));
        foreach (object input in new object[] { new { hwnd = "0x1234" }, new { scope_id = Scope, window_id = f.Id, restore = true, wait_ms = "0" },
            new { scope_id = Scope, window_id = f.Id, restore = true, wait_ms = 3001 }, new { scope_id = Scope, window_id = "0x1234", restore = true, wait_ms = 0 },
            new { scope_id = Scope, window_id = f.Id, restore = true, wait_ms = 0, command = "activate" } })
        {
            using var p = JsonDocument.Parse(JsonSerializer.Serialize(input));
            Check(action.Execute(p.RootElement, CancellationToken.None).Code == "invalid_parameters", "malformed request dispatched");
        }
        Check(f.Backend.Activations == 0 && f.Backend.Restorations == 0 && f.Backend.Observations == 0, "invalid input reached focus backend");
    }
}

sealed class FakeFocusBackend(FakeWindowDiscovery source) : IWindowFocusBackend
{
    public int Activations, Restorations, Observations, UiaChecks;
    public string UiaStatus = "confirmed";
    public string? BlockingWindow;
    public Func<FocusCall>? OnActivate, OnRestore;
    public Action? AfterObserve;
    public Func<FocusObservation, FocusObservation>? PatchObservation;
    public FocusCall Restore(WindowSelection target, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested(); Restorations++;
        if (OnRestore != null) return OnRestore();
        source.Windows = source.Windows.Select(window => window with { Visible = true, Minimized = false }).ToArray();
        return new(true, true);
    }
    public FocusCall Activate(WindowSelection target, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested(); Activations++;
        if (OnActivate != null) return OnActivate();
        source.Windows = source.Windows.Select(window => window with { Foreground = true }).ToArray();
        return new(true, true);
    }
    public FocusSample Observe(WindowSelection target, bool checkUia, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested(); Observations++;
        bool foreground = target.Window.Foreground;
        string actual = foreground ? target.Window.Handle : "0x9999";
        UiaFocusState uia = new("not_checked");
        if (checkUia && foreground)
        {
            UiaChecks++;
            uia = UiaStatus == "unavailable" ? new("unavailable") : new(UiaStatus, UiaStatus == "confirmed" ? actual : "0x9999", UiaStatus == "confirmed");
        }
        FocusObservation observation = new(actual, actual, "0x5678", actual, foreground ? "confirmed" : "outside_target", uia);
        var sample = new FocusSample(PatchObservation?.Invoke(observation) ?? observation, BlockingWindow);
        AfterObserve?.Invoke();
        return sample;
    }
}
