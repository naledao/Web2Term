using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using static Web2Term.WindowsHelper.ApplicationInterop;
using static Web2Term.WindowsHelper.ApplicationLaunchInterop;

namespace Web2Term.WindowsHelper;

/** Shell extensions use their own STA; no COM object crosses from the UIA MTA or to the pipe reader. */
internal sealed class WindowsAppLaunchDispatcher(string? protectedExecutable = null) : IAppLaunchDispatcher, IResourceOpenDispatcher
{
    public DispatchAttempt Dispatch(LaunchSelection selection, CancellationToken cancellation) => OnSta(selection, cancellation, null);
    public DispatchAttempt Open(ResourceLease resource, LaunchSelection? selection, CancellationToken cancellation) => OnSta(selection, cancellation, resource);
    private DispatchAttempt OnSta(LaunchSelection? selection, CancellationToken cancellation, ResourceLease? resource)
    {
        TaskCompletionSource<DispatchAttempt> completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        Thread thread = new(() =>
        {
            int initialized = CoInitializeEx(IntPtr.Zero, 6); // APARTMENTTHREADED | DISABLE_OLE1DDE
            if (initialized < 0) { completed.SetResult(new(false, false, "shell_execute", Error: initialized, FailureCode: "unavailable")); return; }
            try { completed.SetResult(DispatchOnSta(selection, cancellation, resource)); }
            catch { completed.TrySetResult(new(false, true, "shell_execute")); }
            finally { CoUninitialize(); }
        }) { IsBackground = true, Name = "Web2Term application launch STA" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        // The independent cancellation channel and process watchdog remain responsive if a Shell extension blocks.
        return completed.Task.GetAwaiter().GetResult();
    }

    private DispatchAttempt DispatchOnSta(LaunchSelection? selection, CancellationToken cancellation, ResourceLease? resource)
    {
        NativeLaunch launch = selection?.Launch ?? new("resource", "", null);
        bool attempted = false;
        string method = "shell_execute";
        string preparationFailure = "stale_catalog";
        object? activation = null;
        IShellItem? item = null;
        IntPtr idList = IntPtr.Zero;
        IntPtr resourceItems = IntPtr.Zero;
        IShellItem? resourceItem = null;
        using HeldFiles held = new();
        try
        {
            HelperInputState.Check(cancellation);
            resource?.Revalidate();
            if (selection == null)
            {
                if (resource == null) return Stale();
                string association = resource.Kind == "url" ? new Uri(resource.Target).Scheme : resource.Kind == "directory" ? "Folder" : Path.GetExtension(resource.Target);
                StringBuilder handler = new(2048); uint capacity = (uint)handler.Capacity;
                VerifiedExecutable? associated = null;
                if (association.Length > 0 && AssocQueryStringW(resource.Kind == "url" ? 0x1000u : 0u, 2, association, "open", handler, ref capacity) == 0)
                {
                    associated = ExecutableVerifier.Verify(handler.ToString());
                    if (Protected(associated?.Path ?? handler.ToString())) return new(false, false, method, FailureCode: "invalid_parameters");
                }
                resource.Revalidate();
                return ShellOpen(resource.Target, null, resource.Kind == "file" ? Path.GetDirectoryName(resource.Target) : null, 0, IntPtr.Zero, cancellation)
                    with { Application = associated != null ? new(associated.Path, null, "association_query") : null };
            }
            if (Protected(launch.Executable?.Path) || resource != null && launch.Arguments.Length != 0)
                return new(false, false, method, FailureCode: "invalid_parameters");
            if (launch.Executable != null) held.VerifyExecutable(launch.Executable);
            if (launch.Kind == "shortcut")
            {
                FileStream source = held.Open(launch.Target);
                if (source.Length > 2_097_152 || launch.SourceFingerprint == null || Convert.ToHexString(SHA256.HashData(source)) != launch.SourceFingerprint)
                    return Stale();
                object? linkObject = null;
                try
                {
                    linkObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-c000-000000000046"), true)!)!;
                    ((IPersistFile)linkObject).Load(launch.Target, 0);
                    IShellLinkW link = (IShellLinkW)linkObject;
                    StringBuilder path = new(2048), arguments = new(32768);
                    link.GetPath(path, path.Capacity, IntPtr.Zero, 4); link.GetArguments(arguments, arguments.Capacity);
                    VerifiedExecutable? target = ExecutableVerifier.Verify(Environment.ExpandEnvironmentVariables(path.ToString()));
                    if (target == null || target.Fingerprint != launch.Executable?.Fingerprint || arguments.ToString() != launch.Arguments ||
                        arguments.Length >= arguments.Capacity - 1 || StringProperty(linkObject, AppUserModelId) != launch.AppUserModelId) return Stale();
                }
                finally { Release(linkObject); }
            }
            else if (launch.Kind == "shell_item")
            {
                SHCreateItemFromParsingName(launch.Target, IntPtr.Zero, typeof(IShellItem).GUID, out item);
                if (!string.Equals(DisplayName(item, 0x80028000), launch.Target, StringComparison.OrdinalIgnoreCase) ||
                    StringProperty(item, AppUserModelId) != launch.AppUserModelId) return Stale();
                if (launch.Executable != null)
                {
                    VerifiedExecutable? current = ExecutableVerifier.Verify(DisplayName(item, 0x80058000));
                    if (current?.Fingerprint != launch.Executable.Fingerprint) return Stale();
                }
            }
            else if (launch.Kind != "executable" || launch.Executable == null ||
                !string.Equals(launch.Target, launch.Executable.Path, StringComparison.OrdinalIgnoreCase)) return Stale();

            string? aumid = launch.AppUserModelId;
            bool packaged = launch.Kind != "shortcut" && IsRegisteredPackage(aumid);
            if (packaged)
            {
                IShellItem? registered = null;
                try
                {
                    SHCreateItemInKnownFolder(AppsFolder, 0, aumid!, typeof(IShellItem).GUID, out registered);
                    if (StringProperty(registered, AppUserModelId) != aumid) return Stale();
                }
                finally { Release(registered); }
                preparationFailure = "unavailable";
                // Event arguments must outlive a cancelled/stopped helper; let Windows manage their lifetime in dllhost.
                CoCreateInstance(new Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c"), IntPtr.Zero, 4,
                    typeof(IApplicationActivationManager).GUID, out activation); // CLSCTX_LOCAL_SERVER
                var manager = (IApplicationActivationManager)activation;
                _ = CoAllowSetForegroundWindow(activation, IntPtr.Zero); // The OS may decline; this is not a focus guarantee.
                method = "application_activation";
                HelperInputState.Check(cancellation);
                if (resource != null)
                {
                    // File/protocol activation preserves the app contract instead of guessing command-line switches.
                    SHCreateItemFromParsingName(resource.Target, IntPtr.Zero, typeof(IShellItem).GUID, out resourceItem);
                    SHCreateShellItemArrayFromShellItem(resourceItem, new Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), out resourceItems);
                    resource.Revalidate();
                    HelperInputState.Check(cancellation);
                    attempted = true;
                    uint activatedPid;
                    int activated = resource.Kind == "url" ? manager.ActivateForProtocol(aumid!, resourceItems, out activatedPid)
                        : manager.ActivateForFile(aumid!, resourceItems, "open", out activatedPid);
                    return activated >= 0 ? new(true, true, method, ReadProcess(activatedPid), Application: new(launch.Executable?.Path, aumid, "selected_reference"))
                        : new(false, true, method, Error: activated, Application: new(launch.Executable?.Path, aumid, "selected_reference"));
                }
                attempted = true;
                int result = manager.ActivateApplication(aumid!, null, 2, out uint pid); // AO_NOERRORUI; no prelaunch/debug/elevation.
                return result >= 0 ? new(true, true, method, ReadProcess(pid)) : new(false, true, method, Error: result);
            }
            if (resource != null)
            {
                if (launch.Executable == null) return new(false, false, method, FailureCode: "invalid_parameters");
                resource.Revalidate();
                return ShellOpen(launch.Executable.Path, ResourceOpenPolicy.QuoteArgument(resource.Target), Path.GetDirectoryName(launch.Executable.Path), 0, IntPtr.Zero, cancellation)
                    with { Application = new(launch.Executable.Path, aumid, "selected_reference") };
            }
            if (item != null) SHGetIDListFromObject(item, out idList);
            return ShellOpen(item == null ? launch.Target : null, null, launch.Kind == "executable" ? Path.GetDirectoryName(launch.Executable!.Path) : null,
                item != null ? 0x0cu : 0u, idList, cancellation);
        }
        catch (OperationCanceledException) { return new(false, attempted, method, FailureCode: "cancelled"); }
        catch { return new(false, attempted, method, FailureCode: attempted ? "launch_failed" : preparationFailure); }
        finally {
            if (idList != IntPtr.Zero) Marshal.FreeCoTaskMem(idList);
            if (resourceItems != IntPtr.Zero) Marshal.Release(resourceItems);
            Release(resourceItem); Release(item); Release(activation);
        }
    }
    private bool Protected(string? path) => path != null && (string.Equals(path, protectedExecutable, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(path, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase));

    private static DispatchAttempt ShellOpen(string? file, string? parameters, string? directory, uint extraMask, IntPtr idList, CancellationToken cancellation)
    {
        if (cancellation.IsCancellationRequested) return new(false, false, "shell_execute", FailureCode: "cancelled");
        HelperInputState.Check(cancellation);
        ShellExecuteInfo info = new() { Size = (uint)Marshal.SizeOf<ShellExecuteInfo>(), Mask = 0x40 | 0x100 | 0x400 | extraMask,
            Verb = "open", File = file, IdList = idList, Parameters = parameters, Directory = directory, Show = 1 };
        try
        {
            bool accepted = ShellExecuteExW(ref info);
            int error = Marshal.GetLastPInvokeError();
            // DDE/single-instance reuse and shell delegates may return no process handle on success.
            ReturnedProcess? process = info.Process == IntPtr.Zero ? null : ReadProcess(GetProcessId(info.Process));
            return accepted ? new(true, true, "shell_execute", process) : new(false, true, "shell_execute", process, error);
        }
        catch { return new(false, true, "shell_execute"); }
        finally { if (info.Process != IntPtr.Zero) CloseHandle(info.Process); }
    }
    private static DispatchAttempt Stale() => new(false, false, "shell_execute", FailureCode: "stale_catalog");

    private static bool IsRegisteredPackage(string? aumid)
    {
        if (string.IsNullOrWhiteSpace(aumid) || aumid.Length > 512) return false;
        int separator = aumid.IndexOf('!');
        if (separator <= 0 || separator == aumid.Length - 1) return false;
        uint count = 0, length = 0;
        int result = GetPackagesByPackageFamily(aumid[..separator], ref count, IntPtr.Zero, ref length, IntPtr.Zero);
        return result is 0 or 122 && count > 0;
    }

    internal static ReturnedProcess? ReadProcess(uint pid)
    {
        if (pid == 0) return null;
        using var handle = OpenProcess(0x1000, false, pid);
        string? started = !handle.IsInvalid && GetProcessTimes(handle, out long created, out _, out _, out _) && created > 0
            ? DateTime.FromFileTimeUtc(created).ToString("O") : null;
        return new(pid, started);
    }

    private sealed class HeldFiles : IDisposable
    {
        private readonly List<FileStream> files = [];
        internal FileStream Open(string path) { FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read); files.Add(file); return file; }
        internal void VerifyExecutable(VerifiedExecutable expected)
        {
            _ = Open(expected.Path); // Keep the current target from replacement/modification through dispatch.
            VerifiedExecutable? actual = ExecutableVerifier.Verify(expected.Path);
            if (actual == null || actual.Fingerprint != expected.Fingerprint) throw new InvalidDataException();
        }
        public void Dispose() { foreach (var file in files) file.Dispose(); }
    }
}
