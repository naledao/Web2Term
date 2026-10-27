// User-run only: pure event classification and fake input submission; no Windows hooks or desktop input.
using Web2Term.WindowsHelper;
using static Web2Term.WindowsHelper.ClickInterop;

static class DesktopActivityTests
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    internal static void RunAll()
    {
        // A mouse LL hook delivers only the low 32 bits of dwExtraInfo; the real marker must survive that unchanged.
        Check(Marker.ToUInt64() <= 0x7FFFFFFF, "helper marker must fit in 31 bits to survive the mouse hook");
        ulong marker = Marker.ToUInt64();
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

        Check(DesktopActivityPolicy.PhysicalEscape(true, 0, 27), "physical Escape is eligible for the exit gesture");
        Check(!DesktopActivityPolicy.PhysicalEscape(true, 0x10, 27) && !DesktopActivityPolicy.PhysicalEscape(true, 0x2, 27), "injected Escape never contributes to double-press");
        Check(!DesktopActivityPolicy.PhysicalEscape(false, 0, 27) && !DesktopActivityPolicy.PhysicalEscape(true, 0, 65), "other input cannot become Escape");
        foreach (uint down in new uint[] { 0x100, 0x104 }) {
            DesktopEscapeGesture gesture = new();
            Check(gesture.Observe(down, 1000) == "escape-pressed", "single Escape does not stop the task");
            Check(gesture.Observe(down, 1100) == null && gesture.Observe(down, 1200) == null, "holding Escape is not a double-press");
            Check(gesture.Observe(down == 0x100 ? 0x101u : 0x105u, 1300) == null, "release arms the next real press");
            Check(gesture.Observe(down, 1500) == "human-stop", "two physical presses within 500ms stop the task");
        }
        DesktopEscapeGesture slow = new();
        _ = slow.Observe(0x100, 1000); _ = slow.Observe(0x101, 1100);
        Check(slow.Observe(0x100, 1501) == "escape-pressed", "two isolated Escapes do not exit");
        _ = slow.Observe(0x101, 1550);
        Check(slow.Observe(0x100, 1700) == "human-stop", "a slow second press can begin a new pair");
        DesktopEscapeGesture reset = new();
        _ = reset.Observe(0x100, 1000); _ = reset.Observe(0x101, 1010); reset.Reset();
        Check(reset.Observe(0x100, 1100) == "escape-pressed", "intervening deliberate input resets the sequence");
        Check(new DesktopEscapeGesture().Observe(0x100, 1101) == "escape-pressed", "another watch never inherits a half gesture");
        DesktopEscapeGesture clock = new();
        _ = clock.Observe(0x100, 1000); _ = clock.Observe(0x101, 1010);
        Check(clock.Observe(0x100, 900) == "escape-pressed", "a backwards clock cannot complete the gesture");

        DesktopEscapeGesture mixed = new();
        _ = mixed.Observe(0x100, 1000); _ = mixed.Observe(0x101, 1010);
        foreach (uint message in new uint[] { 0x100, 0x101, 0x100, 0x101 }) {
            Check(!DesktopActivityPolicy.PhysicalEscape(true, 0x10, 27), "helper Escape does not enter the physical gesture detector");
            Check(DesktopActivityPolicy.Classify(true, message, 0x10, marker, marker) == null, "helper single/double Escape remains ordinary injected input");
        }
        Check(mixed.Observe(0x100, 1200) == "human-stop", "only real physical presses complete the gesture");

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
        Console.WriteLine("PASS desktop source attribution, physical double-Escape, deliberate takeover and nonblocking input latch");
    }
}
