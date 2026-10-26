using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ClickInterop;

namespace Web2Term.WindowsHelper;

/** The pipe/control thread never waits for UIA. Only short SendInput submissions share this gate. */
internal sealed class OwnedInputTracker(Func<Input[], int> submit)
{
    private readonly object gate = new();
    private readonly Dictionary<string, Input> held = new();
    private int stopped;
    internal void RequestStop() => Interlocked.Exchange(ref stopped, 1);
    internal void Check(CancellationToken token) { token.ThrowIfCancellationRequested(); if (Volatile.Read(ref stopped) != 0) throw new OperationCanceledException(); }
    internal int Send(Input[] events, CancellationToken token)
    {
        lock (gate) {
            if (Volatile.Read(ref stopped) != 0 || token.IsCancellationRequested) return 0;
            int accepted = submit(events);
            for (int index = 0; index < Math.Min(accepted, events.Length); index++) Track(events[index]);
            return accepted;
        }
    }
    private (string Key, Input Up, bool IsUp)? Key(Input e)
    {
        if (e.Type == 1) {
            KeyboardInput k = e.Value.Keyboard;
            string key = $"k:{k.VirtualKey}:{k.Scan}:{k.Flags & 5u}";
            Input up = e; up.Value.Keyboard.Flags |= 2u;
            return (key, up, (k.Flags & 2u) != 0);
        }
        if (e.Type == 0) foreach (var (down, up) in new[] { (2u, 4u), (8u, 16u), (32u, 64u) }) {
            if ((e.Value.Mouse.Flags & (down | up)) != 0) return ($"m:{down}", Mouse(0, 0, up), (e.Value.Mouse.Flags & up) != 0);
        }
        return null;
    }
    private void Track(Input e)
    {
        var key = Key(e);
        if (key == null) return;
        if (key.Value.IsUp) held.Remove(key.Value.Key); else held[key.Value.Key] = key.Value.Up;
    }
    internal int Release(Input[] requested)
    {
        lock (gate) {
            // Emergency release and normal finally may race. Never emit a second up for a key no longer owned here.
            Input[] releases = requested.Where(e => Key(e) is { } key && key.IsUp && held.ContainsKey(key.Key)).ToArray();
            if (releases.Length == 0) return requested.Length;
            int accepted = submit(releases);
            for (int index = 0; index < Math.Min(accepted, releases.Length); index++) Track(releases[index]);
            return accepted == releases.Length ? requested.Length : accepted;
        }
    }
    internal (int Attempted, int Released, int Remaining) StopAndRelease()
    {
        Interlocked.Exchange(ref stopped, 1);
        lock (gate) {
            Input[] releases = held.Values.ToArray();
            int accepted = 0;
            try { if (releases.Length > 0) accepted = submit(releases); }
            catch { /* Report remaining owned inputs; never claim cleanup succeeded. */ }
            for (int index = 0; index < Math.Min(accepted, releases.Length); index++) Track(releases[index]);
            return (releases.Length, accepted, held.Count);
        }
    }
}


internal static class HelperInputState
{
    private static readonly OwnedInputTracker state = new(events => (int)SendInput((uint)events.Length, events, Marshal.SizeOf<Input>()));
    internal static void RequestStop() => state.RequestStop();
    internal static void Check(CancellationToken token) => state.Check(token);
    internal static int Send(Input[] events, CancellationToken token) => state.Send(events, token);
    internal static int Release(Input[] events) => state.Release(events);
    internal static (int Attempted, int Released, int Remaining) StopAndRelease() => state.StopAndRelease();
}
