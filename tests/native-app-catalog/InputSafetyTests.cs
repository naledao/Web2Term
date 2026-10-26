// User-run only. Fake SendInput delegate; no keyboard, mouse, UIA or native process is used.
using Web2Term.WindowsHelper;
using static Web2Term.WindowsHelper.ClickInterop;

static class InputSafetyTests
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    internal static void RunAll()
    {
        List<Input[]> sent = new();
        OwnedInputTracker input = new(events => { sent.Add(events); return events.Length; });
        input.Release([VirtualKey(0x11, false, true)]);
        Check(sent.Count == 0, "never releases a user key that the helper did not submit");
        input.Send([VirtualKey(0x11, false, false), Mouse(0, 0, 2)], CancellationToken.None);
        var stop = input.StopAndRelease();
        Check(stop == (2, 2, 0), "emergency releases this helper's Ctrl and left button");
        Check(sent[1].All(e => e.Type == 1 ? (e.Value.Keyboard.Flags & 2) != 0 : e.Value.Mouse.Flags == 4), "cleanup contains only up events");
        input.Release([VirtualKey(0x11, false, true), Mouse(0, 0, 4)]);
        Check(sent.Count == 2, "normal finally does not repeat already released ups");
        Check(input.Send([Mouse(0, 0, 2)], CancellationToken.None) == 0, "latched native process rejects new down events");
        Check(sent.Count == 2, "no native dispatch after emergency latch");

        int calls = 0;
        OwnedInputTracker partial = new(events => ++calls == 1 ? 1 : events.Length);
        partial.Send([Unicode('a', false), Unicode('a', true), Unicode('b', false), Unicode('b', true)], CancellationToken.None);
        Check(partial.StopAndRelease() == (1, 1, 0), "tracks only accepted prefix of a partial Unicode submission");

        int phase = 0;
        OwnedInputTracker failure = new(events => phase++ == 0 ? events.Length : 0);
        failure.Send([Mouse(0, 0, 8)], CancellationToken.None);
        Check(failure.StopAndRelease() == (1, 0, 1), "failed cleanup remains unconfirmed");
        Check(failure.Send([Mouse(0, 0, 2)], CancellationToken.None) == 0, "failed cleanup never reopens the gate");

        int balancedCalls = 0;
        OwnedInputTracker balanced = new(events => { balancedCalls++; return events.Length; });
        balanced.Send([VirtualKey(0x41, false, false), VirtualKey(0x41, false, true)], CancellationToken.None);
        Check(balanced.StopAndRelease() == (0, 0, 0) && balancedCalls == 1, "balanced key sequence needs no artificial release");
        Console.WriteLine("PASS owned input tracking, partial submission, independent emergency release and latch");
    }
}
