using System.Runtime.InteropServices;
using System.Text;

namespace Web2Term.WindowsHelper;

internal static class ClickInterop
{
    [StructLayout(LayoutKind.Sequential)] internal struct MouseInput { internal int X, Y; internal uint Data, Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct KeyboardInput { internal ushort VirtualKey, Scan; internal uint Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputUnion { [FieldOffset(0)] internal MouseInput Mouse; [FieldOffset(0)] internal KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] internal struct Input { internal uint Type; internal InputUnion Value; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
    // Low-level mouse hooks receive only the low 32 bits of dwExtraInfo (keyboard keeps all 64), so the
    // marker must fit in 31 bits: "W2" plus the low 16 bits of the pid, never sign-extended.
    internal static readonly UIntPtr Marker = new(0x57320000u | ((uint)Environment.ProcessId & 0xFFFFu));
    internal static Input Mouse(int x, int y, uint flags) => new() { Type = 0, Value = new() { Mouse = new() { X = x, Y = y, Flags = flags, Extra = Marker } } };
    internal static Input Unicode(char unit, bool up) => new() { Type = 1, Value = new() { Keyboard = new() { Scan = unit, Flags = up ? 6u : 4u, Extra = Marker } } };
    internal static Input VirtualKey(ushort vk, bool extended, bool up) => new() { Type = 1, Value = new() { Keyboard = new() { VirtualKey = vk, Flags = (extended ? 1u : 0u) | (up ? 2u : 0u), Extra = Marker } } };
    internal static (uint Down, uint Up) ButtonFlags(string button) => button switch { "left" => (0x0002u, 0x0004u), "right" => (0x0008u, 0x0010u), "middle" => (0x0020u, 0x0040u), _ => throw new InvalidDataException() };
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);
    [DllImport("user32.dll")] internal static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint size, out uint needed);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseDesktop(IntPtr desktop);
}
