using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.ClickInterop;

namespace Web2Term.WindowsHelper;

internal static class ScrollInterop
{
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { internal int Left, Top, Right, Bottom; }
    internal static Input Wheel(ScrollOptions options) => new() { Type = 0, Value = new() { Mouse = new() {
        Flags = options.Axis == "horizontal" ? 0x1000u : 0x0800u, Data = unchecked((uint)options.Delta), Extra = Marker } } };
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", ExactSpelling = true, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WheelRouting(uint action, uint parameter, out uint value, uint flags);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ScreenToClient(IntPtr window, ref Point point);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetClientRect(IntPtr window, out Rect rect);
}
