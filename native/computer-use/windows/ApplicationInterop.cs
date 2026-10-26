using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Web2Term.WindowsHelper;

internal static class ApplicationInterop
{
    internal static readonly Guid AppsFolder = new("1e87508d-89c2-42f0-8a7e-645a0f50ca58");
    internal static readonly Guid EnumItems = new("94f60519-2850-4924-aa5a-d15e84868039");
    internal static readonly Guid PropertyStoreHandler = new("0384e1a4-1523-439c-a4c8-ab911052f586");
    internal static readonly PropertyKey AppUserModelId = new(new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"), 5);

    [StructLayout(LayoutKind.Sequential)]
    internal readonly struct PropertyKey(Guid format, uint property)
    {
        internal readonly Guid Format = format;
        internal readonly uint Property = property;
    }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PropVariant
    {
        [FieldOffset(0)] internal ushort Type;
        [FieldOffset(8)] internal IntPtr Pointer;
    }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr context, in Guid handler, in Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
    [ComImport, Guid("70629033-e363-4a28-a567-0db78006e6d7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IEnumShellItems
    {
        [PreserveSig] int Next(uint count, out IShellItem item, out uint fetched);
        void Skip(uint count);
        void Reset();
        void Clone(out IEnumShellItems clone);
    }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(in PropertyKey key, out PropVariant value);
        void SetValue(in PropertyKey key, in PropVariant value);
        void Commit();
    }
    [ComImport, Guid("000214f9-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr findData, uint flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    internal static string DisplayName(IShellItem item, uint kind)
    {
        item.GetDisplayName(kind, out IntPtr pointer);
        try { return Marshal.PtrToStringUni(pointer) ?? ""; }
        finally { Marshal.FreeCoTaskMem(pointer); }
    }
    internal static string? StringProperty(object item, in PropertyKey key)
    {
        object? storeObject = null;
        try
        {
            if (item is IPropertyStore direct) return Read(direct, key);
            if (item is not IShellItem shellItem) return null;
            shellItem.BindToHandler(IntPtr.Zero, PropertyStoreHandler, typeof(IPropertyStore).GUID, out storeObject);
            return Read((IPropertyStore)storeObject, key);
        }
        catch (COMException) { return null; }
        finally { Release(storeObject); }
    }
    private static string? Read(IPropertyStore store, in PropertyKey key)
    {
        store.GetValue(key, out PropVariant value);
        try { return value.Type == 31 ? Marshal.PtrToStringUni(value.Pointer) : null; } // VT_LPWSTR only.
        finally { PropVariantClear(ref value); }
    }
    internal static void Release(object? value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }

    [DllImport("shell32.dll", PreserveSig = false)]
    internal static extern void SHGetKnownFolderItem(in Guid folder, uint flags, IntPtr token, in Guid iid, out IShellItem item);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern int GetApplicationUserModelId(SafeProcessHandle process, ref uint length, StringBuilder? id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint count, uint flags);
    internal delegate bool EnumWindowCallback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsIconic(IntPtr window);
}
