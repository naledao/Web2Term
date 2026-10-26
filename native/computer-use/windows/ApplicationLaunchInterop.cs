using System.Runtime.InteropServices;

namespace Web2Term.WindowsHelper;

internal static class ApplicationLaunchInterop
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct ShellExecuteInfo
    {
        internal uint Size;
        internal uint Mask;
        internal IntPtr Window;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Verb;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? File;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Parameters;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Directory;
        internal int Show;
        internal IntPtr Instance;
        internal IntPtr IdList;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Class;
        internal IntPtr ClassKey;
        internal uint HotKey;
        internal IntPtr Icon;
        internal IntPtr Process;
    }
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IApplicationActivationManager
    {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string applicationId,
            [MarshalAs(UnmanagedType.LPWStr)] string? arguments, uint options, out uint processId);
        [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string applicationId, IntPtr items,
            [MarshalAs(UnmanagedType.LPWStr)] string? verb, out uint processId);
        [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string applicationId, IntPtr items, out uint processId);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ShellExecuteExW(ref ShellExecuteInfo info);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    internal static extern void SHCreateItemFromParsingName(string name, IntPtr context, in Guid iid, out ApplicationInterop.IShellItem item);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    internal static extern void SHCreateItemInKnownFolder(in Guid folder, uint flags, string child, in Guid iid, out ApplicationInterop.IShellItem item);
    [DllImport("shell32.dll", PreserveSig = false)]
    internal static extern void SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object item, out IntPtr idList);
    [DllImport("shell32.dll", PreserveSig = false)]
    internal static extern void SHCreateShellItemArrayFromShellItem(ApplicationInterop.IShellItem item, in Guid iid, out IntPtr items);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern int AssocQueryStringW(uint flags, uint value, string association, string? extra, System.Text.StringBuilder output, ref uint length);
    [DllImport("shell32.dll", PreserveSig = false)]
    internal static extern void SHGetPropertyStoreForWindow(IntPtr window, in Guid iid, out ApplicationInterop.IPropertyStore store);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern int GetPackagesByPackageFamily(string family, ref uint count, IntPtr names, ref uint length, IntPtr buffer);
    [DllImport("kernel32.dll")] internal static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("ole32.dll")] internal static extern int CoInitializeEx(IntPtr reserved, uint model);
    [DllImport("ole32.dll")] internal static extern void CoUninitialize();
    [DllImport("ole32.dll", PreserveSig = false)]
    internal static extern void CoCreateInstance(in Guid classId, IntPtr outer, uint context, in Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out object instance);
    [DllImport("ole32.dll")]
    internal static extern int CoAllowSetForegroundWindow([MarshalAs(UnmanagedType.IUnknown)] object instance, IntPtr reserved);
}
