using System.Runtime.InteropServices;
using static Web2Term.WindowsHelper.WindowFocusInterop;

namespace Web2Term.WindowsHelper;

internal static class ControlTreeInterop
{
    [ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationValuePattern
    {
        [PreserveSig] int SetValue([MarshalAs(UnmanagedType.BStr)] string value);
        [PreserveSig] int GetCurrentValue([MarshalAs(UnmanagedType.BStr)] out string value);
        [PreserveSig] int GetCurrentIsReadOnly([MarshalAs(UnmanagedType.Bool)] out bool value);
    }
    [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationInvokePattern { [PreserveSig] int Invoke(); }
    [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationTogglePattern { [PreserveSig] int Toggle(); }
    [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationSelectionItemPattern { [PreserveSig] int Select(); }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { internal int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr window, uint property, out Rect value, uint size);
    [ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationTextPattern
    {
        [PreserveSig] int RangeFromPoint(Point point, out IUIAutomationTextRange range);
        [PreserveSig] int RangeFromChild(IUIAutomationElement child, out IUIAutomationTextRange range);
        [PreserveSig] int GetSelection(out IUIAutomationTextRangeArray ranges);
        [PreserveSig] int GetVisibleRanges(out IUIAutomationTextRangeArray ranges);
        [PreserveSig] int GetDocumentRange(out IUIAutomationTextRange range);
    }
    [ComImport, Guid("ce4ae76a-e717-4c98-81ea-47371d028eb6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationTextRangeArray
    {
        [PreserveSig] int GetLength(out int length);
        [PreserveSig] int GetElement(int index, out IUIAutomationTextRange range);
    }
    // SDK prefix through MoveEndpointByRange. These methods only adjust local range objects, never selection or text.
    [ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IUIAutomationTextRange
    {
        [PreserveSig] int Clone(out IUIAutomationTextRange range);
        [PreserveSig] int Compare(IUIAutomationTextRange range, [MarshalAs(UnmanagedType.Bool)] out bool equal);
        [PreserveSig] int CompareEndpoints(int source, IUIAutomationTextRange range, int target, out int result);
        [PreserveSig] int ExpandToEnclosingUnit(int unit);
        [PreserveSig] int FindAttribute(int attribute, [MarshalAs(UnmanagedType.Struct)] object value, [MarshalAs(UnmanagedType.Bool)] bool backward, out IUIAutomationTextRange range);
        [PreserveSig] int FindText([MarshalAs(UnmanagedType.BStr)] string text, [MarshalAs(UnmanagedType.Bool)] bool backward, [MarshalAs(UnmanagedType.Bool)] bool ignoreCase, out IUIAutomationTextRange range);
        [PreserveSig] int GetAttributeValue(int attribute, [MarshalAs(UnmanagedType.Struct)] out object value);
        [PreserveSig] int GetBoundingRectangles(out IntPtr rectangles);
        [PreserveSig] int GetEnclosingElement(out IUIAutomationElement element);
        [PreserveSig] int GetText(int maximum, [MarshalAs(UnmanagedType.BStr)] out string text);
        [PreserveSig] int Move(int unit, int count, out int moved);
        [PreserveSig] int MoveEndpointByUnit(int endpoint, int unit, int count, out int moved);
        [PreserveSig] int MoveEndpointByRange(int endpoint, IUIAutomationTextRange range, int targetEndpoint);
    }
}
