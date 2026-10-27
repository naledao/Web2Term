namespace Web2Term.WindowsHelper;

/** No key values, text, coordinates or window titles are retained. */
internal static class DesktopActivityPolicy
{
    /** key/scan are the keyboard hook's vkCode and scanCode; pointer events pass 0. */
    internal static string? Classify(bool keyboard, uint message, uint flags, ulong extra, ulong ownMarker, uint key, uint scan)
    {
        bool injected = (flags & (keyboard ? 0x12u : 0x3u)) != 0;
        if (injected && extra == ownMarker) return null;
        if (keyboard && injected && NullKey(key, scan)) return null;
        // Key-up, pointer motion and button-up alone do not establish deliberate input.
        bool deliberate = keyboard ? message is 0x100 or 0x104 : message is 0x201 or 0x204 or 0x207 or 0x20B or 0x20A or 0x20E;
        return deliberate ? injected ? "external-input" : "human-input" : null;
    }

    /**
     * keybd_event(0, 0, …): no virtual key and no scan code, so no application receives a key from it. Programs inject
     * it to satisfy the foreground-lock rules before showing a window; ZeroExLight (WinUI 3) sent two at the start of
     * every drag and stopped it as "external input" (2026-10-27 injected-key probe: vk=0x00 flags=0x10 extra=0).
     */
    internal static bool NullKey(uint key, uint scan) => key == 0 && scan == 0;

    /** Only the kind of input, for the desktop activity log: never which key, button position or window. */
    internal static string InputCategory(bool keyboard, uint message) => keyboard ? "keyboard" : message is 0x20A or 0x20E ? "wheel" : "click";

    internal static bool PhysicalPointerMove(bool keyboard, uint message, uint flags) => !keyboard && message == 0x200 && (flags & 0x3u) == 0;

    /**
     * Input that lands on Web2Term's own windows (scrolling the reply, clicking the panel) does not
     * touch the desktop being operated, so it neither pauses computer use nor counts as interference.
     */
    internal static bool OnControlPlane(uint targetPid, uint controlPid) => targetPid != 0 && targetPid == controlPid;
}

/** Per-watch gesture; points exist only in memory and are never published or logged. */
internal sealed class DesktopMouseShakeGesture
{
    internal const long WindowMs = 1200;
    internal const long IdleMs = 350;
    internal const int StrokePixels = 40;
    internal const int RequiredReversals = 4;
    private readonly Axis horizontal = new(), vertical = new();
    private long? started;
    private long lastMove;

    internal bool Observe(int x, int y, long now)
    {
        if (started == null || now < lastMove || now - started.Value > WindowMs || now - lastMove > IdleMs) {
            started = lastMove = now;
            horizontal.Start(x); vertical.Start(y);
            return false;
        }
        lastMove = now;
        bool shake = horizontal.Observe(x) | vertical.Observe(y);
        if (shake) Reset();
        return shake;
    }
    internal void Reset() { started = null; horizontal.Start(0); vertical.Start(0); }

    private sealed class Axis
    {
        private int extreme, direction, reversals;
        internal void Start(int value) { extreme = value; direction = reversals = 0; }
        internal bool Observe(int value)
        {
            long delta = (long)value - extreme;
            if (direction == 0) {
                if (Math.Abs(delta) >= StrokePixels) { direction = Math.Sign(delta); extreme = value; }
            }
            else if (delta * direction >= 0) extreme = value;
            else if (Math.Abs(delta) >= StrokePixels) {
                direction = -direction; extreme = value;
                return ++reversals >= RequiredReversals;
            }
            return false;
        }
    }
}
