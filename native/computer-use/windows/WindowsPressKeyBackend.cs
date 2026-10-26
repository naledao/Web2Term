using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ClickInterop;

namespace Web2Term.WindowsHelper;

internal sealed class WindowsPressKeyBackend(WindowCatalog windows, int parentPid) : IPressKeyBackend
{
    private readonly WindowsClickBackend input = new(windows, parentPid);
    public bool Guard(WindowSelection window, PressKeyChord chord, CancellationToken cancellation) => input.KeyboardGuard(window, cancellation) &&
        chord.Down.All(key => (GetAsyncKeyState(key.Vk) & 0x8000) == 0);
    public int Send(WindowSelection window, PressKeyChord chord, CancellationToken cancellation)
    {
        try { if (cancellation.IsCancellationRequested || !Guard(window, chord, cancellation)) return 0; }
        catch { return 0; } // No submission occurred; do not release a user's existing keys for a failed guard.
        Input[] events = PressKeyProtocol.Sequence(chord).Select(e => VirtualKey(e.Key.Vk, e.Key.Extended, e.Up)).ToArray();
        if (cancellation.IsCancellationRequested) return 0;
        return HelperInputState.Send(events, cancellation);
    }
    public int Release(PressKeySpec[] keys)
    {
        Input[] events = keys.Select(key => VirtualKey(key.Vk, key.Extended, true)).ToArray();
        return HelperInputState.Release(events); // Cleanup has no target/cancellation guard: only up events, even after a shortcut changes focus.
    }
}
