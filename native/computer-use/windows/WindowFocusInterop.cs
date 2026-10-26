using System.Runtime.InteropServices;

namespace Web2Term.WindowsHelper;

internal static class WindowFocusInterop
{
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] internal static extern IntPtr GetLastActivePopup(IntPtr window);
    [StructLayout(LayoutKind.Sequential)] internal struct GuiThreadInfo
    {
        internal uint Size, Flags;
        internal IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        internal int Left, Top, Right, Bottom;
    }
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }

    // Prefix vtables in Microsoft UIAutomationClient.h. Unused slots preserve ABI; only read methods are invoked.
    [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomation
    {
        [PreserveSig] int CompareElements(IUIAutomationElement first, IUIAutomationElement second, [MarshalAs(UnmanagedType.Bool)] out bool same);
        [PreserveSig] int CompareRuntimeIds(IntPtr first, IntPtr second, out int same);
        [PreserveSig] int GetRootElement(out IUIAutomationElement element);
        [PreserveSig] int ElementFromHandle(IntPtr window, out IUIAutomationElement element);
        [PreserveSig] int ElementFromPoint(Point point, out IUIAutomationElement element);
        [PreserveSig] int GetFocusedElement(out IUIAutomationElement element);
        [PreserveSig] int GetRootElementBuildCache(IntPtr cache, out IUIAutomationElement element);
        [PreserveSig] int ElementFromHandleBuildCache(IntPtr window, IUIAutomationCacheRequest cache, out IUIAutomationElement element);
        [PreserveSig] int ElementFromPointBuildCache(Point point, IntPtr cache, out IUIAutomationElement element);
        [PreserveSig] int GetFocusedElementBuildCache(IntPtr cache, out IUIAutomationElement element);
        [PreserveSig] int CreateTreeWalker(IntPtr condition, out IUIAutomationTreeWalker walker);
        [PreserveSig] int GetControlViewWalker(out IUIAutomationTreeWalker walker);
        [PreserveSig] int GetContentViewWalker(out IUIAutomationTreeWalker walker);
        [PreserveSig] int GetRawViewWalker(out IUIAutomationTreeWalker walker);
        [PreserveSig] int GetRawViewCondition(out IntPtr condition);
        [PreserveSig] int GetControlViewCondition(out IntPtr condition);
        [PreserveSig] int GetContentViewCondition(out IntPtr condition);
        [PreserveSig] int CreateCacheRequest(out IUIAutomationCacheRequest cache);
    }
    [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationElement
    {
        [PreserveSig] int SetFocus(); // Declared for slot alignment; focus_window never calls it.
        [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
        [PreserveSig] int FindFirst(int scope, IntPtr condition, out IntPtr found);
        [PreserveSig] int FindAll(int scope, IntPtr condition, out IntPtr found);
        [PreserveSig] int FindFirstBuildCache(int scope, IntPtr condition, IntPtr cache, out IntPtr found);
        [PreserveSig] int FindAllBuildCache(int scope, IntPtr condition, IntPtr cache, out IntPtr found);
        [PreserveSig] int BuildUpdatedCache(IUIAutomationCacheRequest cache, out IUIAutomationElement updated);
        [PreserveSig] int GetCurrentPropertyValue(int property, [MarshalAs(UnmanagedType.Struct)] out object value);
        [PreserveSig] int GetCurrentPropertyValueEx(int property, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object value);
        [PreserveSig] int GetCachedPropertyValue(int property, [MarshalAs(UnmanagedType.Struct)] out object value);
        [PreserveSig] int GetCachedPropertyValueEx(int property, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object value);
        [PreserveSig] int GetCurrentPatternAs(int pattern, ref Guid iid, out IntPtr value);
        [PreserveSig] int GetCachedPatternAs(int pattern, ref Guid iid, out IntPtr value);
        [PreserveSig] int GetCurrentPattern(int pattern, [MarshalAs(UnmanagedType.IUnknown)] out object? value);
    }
    [ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationTreeWalker
    {
        [PreserveSig] int GetParentElement(IUIAutomationElement element, out IUIAutomationElement? parent);
        [PreserveSig] int GetFirstChildElement(IUIAutomationElement element, out IUIAutomationElement? child);
        [PreserveSig] int GetLastChildElement(IUIAutomationElement element, out IUIAutomationElement? child);
        [PreserveSig] int GetNextSiblingElement(IUIAutomationElement element, out IUIAutomationElement? sibling);
        [PreserveSig] int GetPreviousSiblingElement(IUIAutomationElement element, out IUIAutomationElement? sibling);
        [PreserveSig] int NormalizeElement(IUIAutomationElement element, out IUIAutomationElement? normalized);
        [PreserveSig] int GetParentElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest cache, out IUIAutomationElement? parent);
        [PreserveSig] int GetFirstChildElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest cache, out IUIAutomationElement? child);
        [PreserveSig] int GetLastChildElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest cache, out IUIAutomationElement? child);
        [PreserveSig] int GetNextSiblingElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest cache, out IUIAutomationElement? sibling);
    }
    [ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationCacheRequest
    {
        [PreserveSig] int AddProperty(int property);
        [PreserveSig] int AddPattern(int pattern);
        [PreserveSig] int Clone(out IUIAutomationCacheRequest cache);
        [PreserveSig] int GetTreeScope(out int scope);
        [PreserveSig] int SetTreeScope(int scope);
    }
}
