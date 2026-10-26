using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ClickInterop;

namespace Web2Term.WindowsHelper;

internal sealed class WindowsTextInputBackend(WindowCatalog windows, int parentPid) : ITextInputBackend
{
    private readonly WindowsClickBackend input = new(windows, parentPid);
    public bool Guard(WindowSelection window, CancellationToken cancellation) => window.Menu == null && input.KeyboardGuard(window, cancellation);
    public int Send(WindowSelection window, string text, CancellationToken cancellation)
    {
        try { if (cancellation.IsCancellationRequested || !Guard(window, cancellation)) return 0; }
        catch { return 0; } // Still before submission: never release a key for a failed read-only guard.
        Input[] batch = text.SelectMany(unit => new[] { Unicode(unit, false), Unicode(unit, true) }).ToArray();
        if (cancellation.IsCancellationRequested) return 0;
        return HelperInputState.Send(batch, cancellation);
    }
    public int Release(char unit) => HelperInputState.Release([Unicode(unit, true)]);
    public void Settle(CancellationToken cancellation) { if (cancellation.WaitHandle.WaitOne(20)) cancellation.ThrowIfCancellationRequested(); }
}
