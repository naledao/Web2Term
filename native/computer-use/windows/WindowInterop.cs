using System.Runtime.InteropServices;
using System.Text;

namespace Web2Term.WindowsHelper;

internal static class WindowInterop
{
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr window, uint relation);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out uint value, uint size);
    [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(Microsoft.Win32.SafeHandles.SafeProcessHandle process, uint milliseconds);
    internal delegate void WinEventCallback(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint threadId, uint time);
    [DllImport("user32.dll")] internal static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventCallback callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UnhookWinEvent(IntPtr hook);
    [StructLayout(LayoutKind.Sequential)] internal struct Message
    {
        internal IntPtr Window;
        internal uint Id;
        internal UIntPtr WParam;
        internal IntPtr LParam;
        internal uint Time;
        internal int X, Y;
        internal uint Private;
    }
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TranslateMessage(in Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr DispatchMessage(in Message message);
}
