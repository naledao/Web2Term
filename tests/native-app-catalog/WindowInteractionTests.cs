// User-run only. Synthetic owner graphs, menu state, property failures and clocks; no native UI or helper startup.
using System.Text.Json;
using Web2Term.WindowsHelper;

internal static class WindowInteractionTests
{
    private static readonly DateTime At = new(2026, 10, 26, 0, 0, 0, DateTimeKind.Utc);
    private const string Scope = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    internal static DiscoveredWindow Window(string handle, string? owner = null, string name = "#32770", uint pid = 42, bool foreground = false) =>
        new(handle, pid, At.ToString("O"), 44, name, "Same title", new(null, null, null), true, false, foreground, true, false, owner, "life-" + handle);
    private sealed class Fixture
    {
        internal DateTime Now = At;
        internal readonly FakeWindowDiscovery Discovery;
        internal readonly FakeInteractionBackend Backend;
        internal readonly WindowCatalog Catalog;
        internal readonly string Parent;
        internal readonly DiscoveredWindow Root = Window("0x1000", name: "Editor", foreground: true);
        internal Fixture() {
            Discovery = new([Root]); Backend = new(Discovery); Catalog = new(Discovery, () => Now, Backend);
            using var request = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, query = "", pid = (uint?)null, include_hidden = false, limit = 25 }));
            Parent = ((WindowPage)Catalog.List(request.RootElement, CancellationToken.None).Data!).windows.Single().window_id!;
        }
        internal ActionResult Inspect(int limit = 8) => Catalog.InspectInteractions(Scope, Parent, limit, 9999, CancellationToken.None);
        internal void Menu(bool popup = true) { Backend.Gui = new(Root.Handle, Root.Handle, Root.Handle, Root.Handle, 0x14);
            Discovery.Windows = popup ? [Root, Window("0x2000", name: "#32768")] : [Root]; }
    }
    private static WindowInteractionsResult Data(ActionResult r) { Check(r.Ok && r.Execution == "executed", "read-only inspection failed: " + r.Message); return (WindowInteractionsResult)r.Data!; }
    internal static void RunAll() { Owners(); Menus(); Expiry(); Uncertain(); Protocol(); Console.WriteLine("PASS interaction owner chains, native menu contexts, expiry and read-only lifecycle (synthetic)"); }
    private static void Owners() {
        var f = new Fixture();
        f.Discovery.Windows = [f.Root with { Enabled = false, Foreground = false }, Window("0x2000", f.Root.Handle), Window("0x3000", "0x2000", pid: 43, foreground: true),
            Window("0x4000"), Window("0x5000", "0x6000"), Window("0x6000", "0x5000")];
        var result = Data(f.Inspect());
        Check(result.windows.Length == 2 && result.windows[1].owner_chain.SequenceEqual(new[] { "0x2000", f.Root.Handle }), "nested owner chain lost or same-title/PID window admitted");
        Check(result.parent.enabled == false && result.windows.All(r => r.is_modal == true) && result.windows[1].window.owner_window_id == result.windows[0].window.window_id, "modal/owner evidence wrong");
        Check(f.Catalog.Resolve(Scope, f.Parent, CancellationToken.None) != null && f.Catalog.Resolve(Scope, result.windows[1].window.window_id!, CancellationToken.None) != null, "inspection revoked source or did not publish child");
        string old = result.windows[0].window.window_id!; var next = Data(f.Inspect(1));
        Check(!next.complete && next.limitations.Contains("limit_reached") && next.windows.Length == 1 && f.Catalog.Resolve(Scope, old, CancellationToken.None) == null, "bounded refresh retained stale dialog alias");
        Check(f.Catalog.Resolve(Scope, f.Parent, CancellationToken.None) != null, "refresh invalidated parent");
    }
    private static void Menus() {
        var f = new Fixture(); f.Menu(); var result = Data(f.Inspect());
        Check(result.menu.mode == "popup" && result.menu.owner_window_id == f.Parent && result.windows.Single().kind == "menu", "detached menu not associated");
        string menuId = result.menu.keyboard_window_id!; var selected = f.Catalog.Resolve(Scope, menuId, CancellationToken.None)!;
        Check(selected.Menu?.Anchor.WindowId == f.Parent && f.Backend.MenuChecks > 1, "menu provenance not rechecked on resolve");
        int checkedBefore = f.Backend.MenuChecks; Check(f.Catalog.MenuCurrent(selected, CancellationToken.None) && f.Backend.MenuChecks > checkedBefore, "cached menu proof reused without guard");
        f.Backend.Gui = new(null, null, null, null, 0);
        Check(f.Catalog.Resolve(Scope, menuId, CancellationToken.None) == null && f.Catalog.Resolve(Scope, f.Parent, CancellationToken.None) != null, "closed menu stayed actionable or revoked parent");
        var owner = new Fixture(); owner.Menu(false); var embedded = Data(owner.Inspect());
        Check(embedded.menu.mode == "owner" && embedded.menu.keyboard_window_id == owner.Parent && embedded.windows.Length == 0, "owner-routed menu missing");
        var previous = owner.Catalog.Resolve(Scope, owner.Parent, CancellationToken.None)!.Menu!;
        Data(owner.Inspect()); Check(owner.Catalog.Resolve(Scope, owner.Parent, CancellationToken.None)!.Menu!.ContextId != previous.ContextId, "fresh inspection reused old menu context");
        owner.Backend.Gui = new(null, null, null, null, 0);
        Check(owner.Catalog.Resolve(Scope, owner.Parent, CancellationToken.None) is { Menu: null }, "closing embedded menu destroyed ordinary source");
        var foreign = new Fixture(); foreign.Menu(); foreign.Backend.Gui = new("0x9999", "0x9999", "0x9999", null, 0x14);
        var unavailable = Data(foreign.Inspect()); Check(unavailable.menu.mode == "unavailable" && unavailable.windows.Length == 0 && !unavailable.complete, "foreign menu associated by PID/title");
    }
    private static void Expiry() {
        var f = new Fixture(); f.Discovery.Windows = [f.Root, Window("0x2000", f.Root.Handle)];
        string id = Data(f.Inspect()).windows[0].window.window_id!; f.Now = At.AddSeconds(31);
        Check(f.Catalog.Resolve(Scope, id, CancellationToken.None) != null && f.Catalog.Resolve(Scope, f.Parent, CancellationToken.None) != null, "persistent dialog expired like a transient menu");
        var menu = new Fixture(); menu.Menu(); string menuId = Data(menu.Inspect()).menu.keyboard_window_id!; menu.Now = At.AddSeconds(31);
        Check(menu.Catalog.Resolve(Scope, menuId, CancellationToken.None) == null, "transient menu outlived its short context");
        for (int i = 0; i < 70; i++) Data(f.Inspect());
        f.Menu(); id = Data(f.Inspect()).menu.keyboard_window_id!;
        f.Discovery.Windows = [f.Root, f.Discovery.Windows[1] with { Lifetime = "reused" }];
        Check(f.Catalog.Resolve(Scope, id, CancellationToken.None) == null, "reused menu handle retained identity");
    }
    private static void Uncertain() {
        var f = new Fixture(); f.Discovery.Windows = [f.Root, Window("0x2000", f.Root.Handle)]; f.Backend.Modality = null;
        var unknown = Data(f.Inspect()); Check(!unknown.complete && unknown.windows[0].is_modal == null && unknown.limitations.Contains("modality_unavailable"), "unknown modality fabricated false");
        var changed = new Fixture(); changed.Discovery.Windows = [changed.Root, Window("0x2000", changed.Root.Handle)];
        changed.Backend.AfterModal = () => changed.Discovery.Windows = [changed.Root, Window("0x2000", null)];
        Check(changed.Inspect().Code == "stale_window", "changing owner graph published references");
        var newer = new Fixture(); newer.Discovery.Windows = [newer.Root, Window("0x2000", newer.Root.Handle)];
        newer.Backend.AfterModal = () => newer.Discovery.Windows = [..newer.Discovery.Windows, Window("0x3000", newer.Root.Handle)];
        Check(newer.Inspect().Code == "stale_window", "new popup during property read silently omitted");
        using var cancel = new CancellationTokenSource(); cancel.Cancel(); bool stopped = false;
        try { f.Catalog.InspectInteractions(Scope, f.Parent, 8, 9999, cancel.Token); } catch (OperationCanceledException) { stopped = true; }
        Check(stopped, "cancelled inspection published");
    }
    private static void Protocol() {
        var f = new Fixture(); InspectInteractionsAction action = new(f.Catalog, 9999);
        foreach (string raw in new[] { "{}", "{\"scope_id\":\"raw\",\"window_id\":\"raw\",\"limit\":8}",
            JsonSerializer.Serialize(new { scope_id = Scope, window_id = f.Parent, limit = 0 }), JsonSerializer.Serialize(new { scope_id = Scope, window_id = f.Parent, limit = 17 }),
            JsonSerializer.Serialize(new { scope_id = Scope, window_id = f.Parent, limit = 8, confirm = true }) }) {
            using var document = JsonDocument.Parse(raw); Check(action.Execute(document.RootElement, CancellationToken.None).Code == "invalid_parameters", "unsafe inspect parameters accepted");
        }
        using var good = JsonDocument.Parse(JsonSerializer.Serialize(new { scope_id = Scope, window_id = f.Parent, limit = 8 }));
        Check(action.Execute(good.RootElement, CancellationToken.None).Ok, "strict native action rejected");
        Check(new InspectInteractionsAction(f.Catalog, 42).Execute(good.RootElement, CancellationToken.None).Code == "window_blocked", "control process admitted");
    }
}
internal sealed class FakeInteractionBackend(FakeWindowDiscovery discovery) : IWindowInteractionBackend
{
    internal InteractionGui Gui = new(null, null, null, null, 0);
    internal bool? Modality = true; internal Action? AfterModal; internal int MenuChecks;
    public InteractionCapture Capture(CancellationToken cancellation) => new(discovery.Capture(false, cancellation), Gui);
    public bool MenuCurrent(MenuWindowBinding menu, CancellationToken cancellation) {
        cancellation.ThrowIfCancellationRequested(); MenuChecks++;
        var anchor = discovery.Read(menu.Anchor.Window.Handle, cancellation); var popup = discovery.Read(menu.Popup.Handle, cancellation);
        return (Gui.flags & 0x1c) != 0 && Gui.menu_root_hwnd == menu.Anchor.Window.Handle && Gui.menu_owner_hwnd == menu.MenuOwner &&
            anchor != null && anchor.SameIdentity(menu.Anchor.Window) && popup != null && popup.SameIdentity(menu.Popup);
    }
    public bool? Modal(DiscoveredWindow window, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); AfterModal?.Invoke(); return Modality; }
}
