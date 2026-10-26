namespace Web2Term.WindowsHelper;

/** No key values, text, coordinates or window titles are retained. */
internal static class DesktopActivityPolicy
{
    internal static string? Classify(bool keyboard, uint message, uint flags, ulong extra, ulong ownMarker)
    {
        bool injected = (flags & (keyboard ? 0x12u : 0x3u)) != 0;
        if (injected && extra == ownMarker) return null;
        // Key-up, pointer motion and button-up alone do not establish deliberate takeover.
        bool deliberate = keyboard ? message is 0x100 or 0x104 : message is 0x201 or 0x204 or 0x207 or 0x20B or 0x20A or 0x20E;
        return deliberate ? injected ? "external-input" : "human-input" : null;
    }

    /** Only the kind of input, for the takeover log: never which key, button position or window. */
    internal static string InputCategory(bool keyboard, uint message) => keyboard ? "keyboard" : message is 0x20A or 0x20E ? "wheel" : "click";

    /**
     * Input that lands on Web2Term's own windows (scrolling the reply, clicking the panel) does not
     * touch the desktop being operated, so it is neither takeover nor interference.
     */
    internal static bool OnControlPlane(uint targetPid, uint controlPid) => targetPid != 0 && targetPid == controlPid;
}
