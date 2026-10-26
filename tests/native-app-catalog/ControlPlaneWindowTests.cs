// User-run only. Synthetic window metadata/owners; no Windows APIs, processes, filesystem or input.
using System.Text.Json;
using Web2Term.WindowsHelper;

static class ControlPlaneWindowTests
{
    static readonly DateTime At = new(2026, 10, 26, 0, 0, 0, DateTimeKind.Utc);
    static readonly string Scope = "ws_" + new string('a', 32);
    static DiscoveredWindow Window(string handle = "0x100", uint pid = 300, string? path = @"C:\Apps\Editor.exe", string? owner = null) =>
        new(handle, pid, At.ToString("O"), 10, "Example", "Web2Term", new("Example", path, null), true, false, false, true, false, owner, "lifetime");
    static ControlPlaneWindowPolicy Policy() => new(100, 200, @"C:\Apps\Web2Term.exe", @"C:\Apps\helper.exe");
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static WindowPage List(WindowCatalog catalog)
    {
        using JsonDocument json = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = true, limit = 25 }));
        ActionResult result = catalog.List(json.RootElement, CancellationToken.None);
        Check(result.Ok, result.Message); return (WindowPage)result.Data!;
    }
    public static void RunAll()
    {
        var cases = new (string Name, Action Run)[] {
            ("control and helper PIDs are blocked independently of claimed application names", Pids),
            ("renderer processes and other instances with the control image are protected", Images),
            ("a business title matching Web2Term is not treated as identity", Titles),
            ("cross-process owned dialogs and menus inherit control protection", Owners),
            ("missing image, missing owner, owner cycle and excessive ancestry remain unavailable", Unknown),
            ("discovery publishes business windows only and marks unknown exclusions partial", Discovery),
            ("a formerly published business reference is revoked if its owner becomes protected", FreshOwner),
            ("cancellation never yields a fresh business-window authorization", Cancellation)
        };
        foreach (var c in cases) { c.Run(); Console.WriteLine("PASS " + c.Name); }
    }
    static void Pids()
    {
        foreach (uint pid in new uint[] { 100, 200 }) Check(Policy().Evaluate(Window(pid: pid), _ => null) == ControlWindowDisposition.Protected, "known process");
    }
    static void Images()
    {
        foreach (string path in new[] { @"c:\apps\WEB2TERM.exe", @"C:\Apps\sub\..\Web2Term.exe", @"\\?\C:\Apps\Web2Term.exe", @"C:\Apps\helper.exe" })
            Check(Policy().Evaluate(Window(pid: 999, path: path), _ => null) == ControlWindowDisposition.Protected, "image alias");
    }
    static void Titles() => Check(Policy().Evaluate(Window(), _ => null) == ControlWindowDisposition.Business, "titles must not authorize or deny");
    static void Owners()
    {
        var rows = new[] { Window("0x1", 100), Window("0x2", owner: "0x1"), Window("0x3", owner: "0x2") }.ToDictionary(w => w.Handle);
        Check(Policy().Evaluate(rows["0x3"], h => rows.GetValueOrDefault(h)) == ControlWindowDisposition.Protected, "owner chain");
    }
    static void Unknown()
    {
        Check(Policy().Evaluate(Window(path: null), _ => null) == ControlWindowDisposition.Unknown, "missing executable");
        Check(Policy().Evaluate(Window(owner: "0x2"), _ => null) == ControlWindowDisposition.Unknown, "missing owner");
        DiscoveredWindow loop = Window(owner: "0x100");
        Check(Policy().Evaluate(loop, _ => loop) == ControlWindowDisposition.Unknown, "cycle");
        var rows = Enumerable.Range(1, 18).Select(i => Window("0x" + i, owner: i == 18 ? null : "0x" + (i + 1))).ToDictionary(w => w.Handle);
        Check(Policy().Evaluate(rows["0x1"], h => rows.GetValueOrDefault(h)) == ControlWindowDisposition.Unknown, "bounded ancestry");
    }
    static void Discovery()
    {
        var source = new Source(Window(), Window("0x2", 100), Window("0x3", path: null), Window("0x4", owner: "0x2"));
        var filtered = new ControlPlaneWindowDiscovery(source, Policy());
        DiscoveredWindowSnapshot snapshot = filtered.Capture(true, CancellationToken.None);
        Check(snapshot.Windows.Length == 1 && snapshot.Windows[0].Handle == "0x100", "business subset");
        Check(!snapshot.Complete && snapshot.Limitations.Contains("metadata_unavailable"), "unknown must remain partial");
        WindowPage page = List(new WindowCatalog(filtered, () => At));
        Check(page.windows.Length == 1 && page.windows[0].window_id != null, "only business references");
        Check(filtered.Read("0x2", CancellationToken.None) == null && filtered.Read("0x4", CancellationToken.None) == null, "protected lookup");
    }
    static void FreshOwner()
    {
        var source = new Source(Window(), Window("0x2", 100));
        var catalog = new WindowCatalog(new ControlPlaneWindowDiscovery(source, Policy()), () => At);
        string id = List(catalog).windows.Single().window_id!;
        Check(catalog.Resolve(Scope, id, CancellationToken.None) != null, "initial business reference");
        source.Rows["0x100"] = Window(owner: "0x2");
        Check(catalog.Resolve(Scope, id, CancellationToken.None) == null, "fresh control owner rejects old reference");
        source.Rows["0x100"] = Window();
        Check(catalog.Resolve(Scope, id, CancellationToken.None) == null, "revoked reference stays revoked");
    }
    static void Cancellation()
    {
        using CancellationTokenSource stop = new(); stop.Cancel();
        var filtered = new ControlPlaneWindowDiscovery(new Source(Window()), Policy());
        try { _ = filtered.Capture(true, stop.Token); throw new Exception("capture ignored cancellation"); } catch (OperationCanceledException) { }
        try { _ = filtered.Read("0x100", stop.Token); throw new Exception("read ignored cancellation"); } catch (OperationCanceledException) { }
    }
    sealed class Source(params DiscoveredWindow[] rows) : IWindowDiscovery
    {
        internal Dictionary<string, DiscoveredWindow> Rows { get; } = rows.ToDictionary(w => w.Handle);
        public DiscoveredWindowSnapshot Capture(bool includeHidden, CancellationToken cancellation) => new(Rows.Values.ToArray(), true, []);
        public DiscoveredWindow? Read(string handle, CancellationToken cancellation) => Rows.GetValueOrDefault(handle);
    }
}
