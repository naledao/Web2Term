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
            Check(DesktopActivityPolicy.Classify(true, message, 0x10, marker, marker, 0x41, 0x1E) == null, "helper key is excluded");
            Check(DesktopActivityPolicy.Classify(true, message, 0, 0, marker, 0x41, 0x1E) == "human-input", "physical key-down pauses");
            Check(DesktopActivityPolicy.Classify(true, message, 0x10, marker + 1, marker, 0x41, 0x1E) == "external-input", "foreign injection is interference");
            // 2026-10-27: ZeroExLight injected keybd_event(0, 0, …) twice at the start of every drag.
            foreach (uint flags in new uint[] { 0x10, 0x12, 0x02 })
                Check(DesktopActivityPolicy.Classify(true, message, flags, 0, marker, 0, 0) == null, "an injected null key (vk 0, scan 0) is not interference");
            Check(DesktopActivityPolicy.Classify(true, message, 0x10, 0, marker, 0, 0x1E) == "external-input", "a scan-code key with vk 0 still interferes");
            Check(DesktopActivityPolicy.Classify(true, message, 0x10, 0, marker, 0xE7, 0x41) == "external-input", "VK_PACKET text input still interferes");
            Check(DesktopActivityPolicy.Classify(true, message, 0, 0, marker, 0, 0) == "human-input", "a physical event is never filtered by its codes");
        }
        Check(DesktopActivityPolicy.NullKey(0, 0) && !DesktopActivityPolicy.NullKey(0, 1) && !DesktopActivityPolicy.NullKey(1, 0), "null key is vk 0 and scan 0 only");
        foreach (uint message in new uint[] { 0x201, 0x204, 0x207, 0x20B, 0x20A, 0x20E }) {
            Check(DesktopActivityPolicy.Classify(false, message, 1, marker, marker, 0, 0) == null, "helper pointer input is excluded");
            Check(DesktopActivityPolicy.Classify(false, message, 0, 0, marker, 0, 0) == "human-input", "physical click/wheel pauses");
            Check(DesktopActivityPolicy.Classify(false, message, 2, 0, marker, 0, 0) == "external-input", "lower integrity injection is not human");
        }
        foreach (uint message in new uint[] { 0x200, 0x202, 0x205, 0x208, 0x20C })
            Check(DesktopActivityPolicy.Classify(false, message, 0, 0, marker, 0, 0) == null, "motion/up alone is not deliberate input");
        Check(DesktopActivityPolicy.Classify(true, 0x101, 0, 0, marker, 0x41, 0x1E) == null, "key-up alone is not deliberate input");
        Check(DesktopActivityPolicy.Classify(true, 0x100, 0, marker, marker, 0x41, 0x1E) == "human-input", "extra-info alone cannot impersonate an injected helper event");
        Check(DesktopActivityPolicy.OnControlPlane(4242, 4242), "input on Web2Term's own window does not pause computer use");
        Check(!DesktopActivityPolicy.OnControlPlane(1717, 4242), "input on another application still pauses");
        Check(!DesktopActivityPolicy.OnControlPlane(0, 4242), "an unresolved target window is never treated as Web2Term");
        Check(DesktopActivityPolicy.InputCategory(true, 0x100) == "keyboard", "key-down is logged as keyboard");
        Check(DesktopActivityPolicy.InputCategory(false, 0x201) == "click" && DesktopActivityPolicy.InputCategory(false, 0x204) == "click", "button-down is logged as click");
        Check(DesktopActivityPolicy.InputCategory(false, 0x20A) == "wheel" && DesktopActivityPolicy.InputCategory(false, 0x20E) == "wheel", "wheel is logged as wheel");

        Check(DesktopActivityPolicy.PhysicalPointerMove(false, 0x200, 0), "real mouse movement enters the gesture detector");
        foreach (uint flags in new uint[] { 1, 2, 3 })
            Check(!DesktopActivityPolicy.PhysicalPointerMove(false, 0x200, flags), "helper and foreign injected movement cannot count as shaking");
        Check(!DesktopActivityPolicy.PhysicalPointerMove(true, 0x200, 0) && !DesktopActivityPolicy.PhysicalPointerMove(false, 0x201, 0), "keys and clicks cannot be movement");
        // Esc now follows the same ordinary physical/injected key policy as every other key.
        Check(DesktopActivityPolicy.Classify(true, 0x100, 0, 0, marker, 0x1B, 0x01) == "human-input", "Esc has no dedicated stop gesture");

        foreach (bool vertical in new[] { false, true }) {
            DesktopMouseShakeGesture gesture = new();
            int[] positions = [0, 40, 0, 40, 0, 40];
            for (int i = 0; i < positions.Length; i++)
                Check(gesture.Observe(vertical ? -500 : positions[i], vertical ? positions[i] : -500, 1000 + i * 100) == (i == positions.Length - 1),
                    "only four full reversals complete a horizontal or vertical shake, including exact stroke boundary");
            Check(!gesture.Observe(0, 0, 1600), "completed sequence cannot retrigger without a new gesture");
        }
        DesktopMouseShakeGesture diagonal = new();
        for (int i = 0; i < 6; i++)
            Check(diagonal.Observe(i % 2 * 60 - 300, i % 2 * 60 - 600, 1000 + i * 240) == (i == 5), "diagonal shake at the 1200ms boundary works on negative desktop coordinates");

        foreach (int interval in new[] { 100, 250, 351 }) {
            DesktopMouseShakeGesture jitter = new(), straight = new(), slow = new();
            for (int i = 0; i < 30; i++) {
                Check(!jitter.Observe(i % 2 * 15, 0, 1000 + i * interval), "small jitter cannot become a shake");
                Check(!straight.Observe(i * 80, 0, 1000 + i * interval), "long one-way travel cannot become a shake");
                if (interval > 240) Check(!slow.Observe(i % 2 * 80, 0, 1000 + i * interval), "slow reversals cannot accumulate beyond the total or idle window");
            }
        }
        DesktopMouseShakeGesture partial = new();
        for (int i = 0; i < 5; i++) Check(!partial.Observe(i % 2 * 80, 0, 1000 + i * 100), "partial gesture stays armed");
        partial.Reset();
        Check(!partial.Observe(80, 0, 1500), "clicks, keys or injected movement reset a partial gesture");
        Check(!new DesktopMouseShakeGesture().Observe(80, 0, 1500), "a new watch cannot inherit a partial gesture");
        DesktopMouseShakeGesture clock = new();
        for (int i = 0; i < 5; i++) _ = clock.Observe(i % 2 * 80, 0, 1000 + i * 100);
        Check(!clock.Observe(80, 0, 900), "a backwards clock resets the sequence");
        DesktopMouseShakeGesture gap = new();
        for (int i = 0; i < 5; i++) _ = gap.Observe(i % 2 * 80, 0, 1000 + i * 100);
        Check(!gap.Observe(80, 0, 1751), "an idle gap resets three previous reversals");
        DesktopMouseShakeGesture extremes = new();
        _ = extremes.Observe(int.MinValue, int.MinValue, 1000);
        Check(!extremes.Observe(int.MaxValue, int.MaxValue, 1100), "coordinate differences cannot overflow into a false shake");

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
        Console.WriteLine("PASS desktop source attribution, physical mouse-shake gesture, deliberate input pause and nonblocking input latch");
    }
}
