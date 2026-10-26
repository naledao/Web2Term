// User-run only: pure event classification and fake input submission; no Windows hooks or desktop input.
using Web2Term.WindowsHelper;
using static Web2Term.WindowsHelper.ClickInterop;

static class DesktopActivityTests
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    internal static void RunAll()
    {
        const ulong marker = 0x123457325443;
        foreach (uint message in new uint[] { 0x100, 0x104 }) {
            Check(DesktopActivityPolicy.Classify(true, message, 0x10, marker, marker) == null, "helper key is excluded");
            Check(DesktopActivityPolicy.Classify(true, message, 0, 0, marker) == "human-input", "physical key-down pauses");
            Check(DesktopActivityPolicy.Classify(true, message, 0x10, marker + 1, marker) == "external-input", "foreign injection is interference");
        }
        foreach (uint message in new uint[] { 0x201, 0x204, 0x207, 0x20B, 0x20A, 0x20E }) {
            Check(DesktopActivityPolicy.Classify(false, message, 1, marker, marker) == null, "helper pointer input is excluded");
            Check(DesktopActivityPolicy.Classify(false, message, 0, 0, marker) == "human-input", "physical click/wheel pauses");
            Check(DesktopActivityPolicy.Classify(false, message, 2, 0, marker) == "external-input", "lower integrity injection is not human");
        }
        foreach (uint message in new uint[] { 0x200, 0x202, 0x205, 0x208, 0x20C })
            Check(DesktopActivityPolicy.Classify(false, message, 0, 0, marker) == null, "motion/up alone is not takeover");
        Check(DesktopActivityPolicy.Classify(true, 0x101, 0, 0, marker) == null, "key-up alone is not takeover");
        Check(DesktopActivityPolicy.Classify(true, 0x100, 0, marker, marker) == "human-input", "extra-info alone cannot impersonate an injected helper event");
        Check(DesktopActivityPolicy.OnControlPlane(4242, 4242), "input on Web2Term's own window is not takeover");
        Check(!DesktopActivityPolicy.OnControlPlane(1717, 4242), "input on another application still pauses");
        Check(!DesktopActivityPolicy.OnControlPlane(0, 4242), "an unresolved target window is never treated as Web2Term");
        Check(DesktopActivityPolicy.InputCategory(true, 0x100) == "keyboard", "key-down is logged as keyboard");
        Check(DesktopActivityPolicy.InputCategory(false, 0x201) == "click" && DesktopActivityPolicy.InputCategory(false, 0x204) == "click", "button-down is logged as click");
        Check(DesktopActivityPolicy.InputCategory(false, 0x20A) == "wheel" && DesktopActivityPolicy.InputCategory(false, 0x20E) == "wheel", "wheel is logged as wheel");

        using ManualResetEventSlim entered = new(), leave = new();
        int calls = 0;
        OwnedInputTracker tracker = new(events => { if (Interlocked.Increment(ref calls) == 1) { entered.Set(); leave.Wait(); } return events.Length; });
        Task send = Task.Run(() => tracker.Send([VirtualKey(0x11, false, false)], CancellationToken.None));
        try {
            Check(entered.Wait(1000), "fake SendInput entered");
            Task latch = Task.Run(tracker.RequestStop);
            Check(latch.Wait(1000), "hook latch must not wait for SendInput's ownership mutex");
        }
        finally { leave.Set(); }
        Check(send.Wait(1000), "fake SendInput finishes after hook returns");
        Check(tracker.Send([VirtualKey(0x41, false, false)], CancellationToken.None) == 0, "next input is blocked");
        Check(tracker.StopAndRelease() == (1, 1, 0), "only accepted helper inputs are released after the hook returns");
        Console.WriteLine("PASS desktop source attribution, deliberate takeover and nonblocking input latch");
    }
}
