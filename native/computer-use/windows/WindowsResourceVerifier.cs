using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using static Web2Term.WindowsHelper.ApplicationInterop;

namespace Web2Term.WindowsHelper;

internal static class WindowsResourceVerifier
{
    internal static ResourceLease? Verify(string kind, string target)
    {
        if (kind == "url") return ResourceOpenPolicy.Url(target) ? new(kind, target) : null;
        if (kind is not ("file" or "directory") || !ResourceOpenPolicy.LocalPath(target)) return null;
        SafeFileHandle? handle = null;
        try
        {
            handle = Open(target);
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out FileIdentity identity) || !KindMatches(kind, identity) ||
                !string.Equals(Canonical(handle), target, StringComparison.OrdinalIgnoreCase)) { handle.Dispose(); return null; }
            SafeFileHandle held = handle;
            return new(kind, target, () => {
                using SafeFileHandle current = Open(target);
                if (current.IsInvalid || !GetFileInformationByHandle(current, out FileIdentity actual) || !KindMatches(kind, actual) ||
                    identity.Volume != actual.Volume || identity.IndexHigh != actual.IndexHigh || identity.IndexLow != actual.IndexLow ||
                    !string.Equals(Canonical(current), target, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            }, held);
        }
        catch { handle?.Dispose(); return null; }
    }
    private static bool KindMatches(string kind, FileIdentity identity) => (identity.Attributes & 0x40) == 0 && ((identity.Attributes & 0x10) != 0) == (kind == "directory");
    private static SafeFileHandle Open(string target) => CreateFileW(target, 0x80, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero); // attributes; share read/write, hold against replacement; backup semantics for directories.
    private static string? Canonical(SafeFileHandle handle)
    {
        StringBuilder path = new(2048);
        uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity) return null;
        string final = path.ToString();
        if (final.StartsWith("\\\\?\\", StringComparison.Ordinal)) final = final[4..];
        return ResourceOpenPolicy.LocalPath(final) ? final : null;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] private struct FileIdentity
    {
        internal uint Attributes;
        internal long Creation, Access, Modified;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileIdentity information);
}
