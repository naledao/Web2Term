using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Security.Cryptography;
using Microsoft.Win32;
using static Web2Term.WindowsHelper.ApplicationInterop;

namespace Web2Term.WindowsHelper;

/** Windows APIs only. No PowerShell, WMI scripts, command parsing, shortcut Resolve, or app launch. */
internal sealed class WindowsApplicationDiscovery : IApplicationDiscovery
{
    private readonly Dictionary<string, VerifiedExecutable?> verified = new(StringComparer.OrdinalIgnoreCase);
    private VerifiedExecutable? Verify(string path)
    {
        if (!verified.TryGetValue(path, out VerifiedExecutable? value)) verified[path] = value = ExecutableVerifier.Verify(path);
        return value;
    }

    public void Collect(DiscoveryContext context, IReadOnlyDictionary<string, SourceState> sources, Action<AppCandidate> add)
    {
        verified.Clear();
        Run(sources["applications_folder"], () => Applications(context, sources["applications_folder"], add));
        Run(sources["start_menu"], () => StartMenus(context, sources["start_menu"], add));
        Run(sources["app_paths"], () => AppPaths(context, sources["app_paths"], add));
        Run(sources["running_process"], () => Processes(context, sources["running_process"], add));
    }
    private static void Run(SourceState source, Action collect)
    {
        try { collect(); }
        catch (OperationCanceledException) { throw; }
        catch { source.Error(); }
    }

    private void Applications(DiscoveryContext context, SourceState source, Action<AppCandidate> add)
    {
        IShellItem? folder = null;
        object? enumerator = null;
        try
        {
            SHGetKnownFolderItem(AppsFolder, 0, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
            folder.BindToHandler(IntPtr.Zero, EnumItems, typeof(IEnumShellItems).GUID, out enumerator);
            IEnumShellItems items = (IEnumShellItems)enumerator;
            while (true)
            {
                int result = items.Next(1, out IShellItem item, out uint fetched);
                if (result < 0) Marshal.ThrowExceptionForHR(result);
                if (fetched == 0) break;
                try
                {
                    if (!context.Visit(source)) return;
                    string name = DisplayName(item, 0); // SIGDN_NORMALDISPLAY
                    string parsingName = DisplayName(item, 0x80028000); // SIGDN_DESKTOPABSOLUTEPARSING from the actual shell item.
                    if (string.IsNullOrWhiteSpace(name) || parsingName.Length is 0 or > 2048) { source.Error(); continue; }
                    string? aumid = StringProperty(item, AppUserModelId);
                    VerifiedExecutable? executable = null;
                    string? filePath = null;
                    try { filePath = DisplayName(item, 0x80058000); executable = Verify(filePath); } catch (COMException) { /* virtual item */ }
                    if (filePath != null && filePath.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                    {
                        // File-backed Shell shortcuts need the same content fingerprint as Start-menu shortcuts.
                        Shortcut(filePath, source, candidate => add(candidate with { Name = name,
                            Identity = !string.IsNullOrWhiteSpace(aumid) && aumid.Length <= 512 ? "aumid:" + aumid : candidate.Identity }));
                        continue;
                    }
                    string identity = !string.IsNullOrWhiteSpace(aumid) && aumid.Length <= 512 ? "aumid:" + aumid
                        : executable != null ? "exe:" + executable.Path.ToUpperInvariant() : "shell:" + parsingName;
                    add(new(identity, name, source.Source, executable, new("shell_item", parsingName, executable, AppUserModelId: aumid)));
                }
                catch (OperationCanceledException) { throw; }
                catch { source.Error(); }
                finally { Release(item); }
            }
        }
        finally { Release(enumerator); Release(folder); }
    }

    private void StartMenus(DiscoveryContext context, SourceState source, Action<AppCandidate> add)
    {
        string[] roots = [Environment.GetFolderPath(Environment.SpecialFolder.Programs), Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms)];
        foreach (string root in roots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) continue;
            Queue<(string Path, int Depth)> directories = new(); directories.Enqueue((root, 0));
            while (directories.TryDequeue(out var directory))
            {
                if (!context.Visit(source)) return;
                try
                {
                    foreach (string file in Directory.EnumerateFileSystemEntries(directory.Path))
                    {
                        if (!context.Visit(source)) return;
                        try
                        {
                            FileAttributes attributes = File.GetAttributes(file);
                            if ((attributes & FileAttributes.ReparsePoint) != 0) { source.Partial(); continue; }
                            if ((attributes & FileAttributes.Directory) != 0)
                            {
                                if (directory.Depth < 8) directories.Enqueue((file, directory.Depth + 1)); else source.Partial();
                                continue;
                            }
                            if (Path.GetExtension(file).Equals(".lnk", StringComparison.OrdinalIgnoreCase)) Shortcut(file, source, add);
                            else if (Path.GetExtension(file).Equals(".exe", StringComparison.OrdinalIgnoreCase)) AddExecutable(file, Path.GetFileNameWithoutExtension(file), source, add);
                        }
                        catch (OperationCanceledException) { throw; }
                        catch { source.Error(); }
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch { source.Error(); }
            }
        }
    }

    private void Shortcut(string path, SourceState source, Action<AppCandidate> add)
    {
        object? linkObject = null;
        try
        {
            using FileStream sourceFile = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (sourceFile.Length > 2_097_152) { source.Partial(); return; }
            string fingerprint = Convert.ToHexString(SHA256.HashData(sourceFile));
            Type type = Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-c000-000000000046"), true)!;
            linkObject = Activator.CreateInstance(type)!;
            ((IPersistFile)linkObject).Load(path, 0); // Read only. Do not Resolve or invoke the shortcut.
            IShellLinkW link = (IShellLinkW)linkObject;
            StringBuilder target = new(2048); link.GetPath(target, target.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH
            StringBuilder arguments = new(32768); link.GetArguments(arguments, arguments.Capacity);
            VerifiedExecutable? executable = Verify(Environment.ExpandEnvironmentVariables(target.ToString()));
            string? aumid = StringProperty(linkObject, AppUserModelId);
            string identity = !string.IsNullOrWhiteSpace(aumid) && aumid.Length <= 512 ? "aumid:" + aumid
                : executable != null && arguments.Length == 0 ? "exe:" + executable.Path.ToUpperInvariant() : "shortcut:" + path.ToUpperInvariant();
            NativeLaunch? launch = executable != null && arguments.Length < arguments.Capacity - 1
                ? new("shortcut", path, executable, arguments.ToString(), fingerprint, aumid) : null;
            // Unresolvable/document/script shortcuts remain discoverable, but never claim a verified launch reference.
            if (launch == null) source.Partial();
            add(new(identity, Path.GetFileNameWithoutExtension(path), source.Source, executable, launch));
        }
        finally { Release(linkObject); }
    }

    private void AppPaths(DiscoveryContext context, SourceState source, Action<AppCandidate> add)
    {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using RegistryKey root = RegistryKey.OpenBaseKey(hive, view);
                using RegistryKey? paths = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths", false);
                if (paths == null) continue;
                foreach (string name in paths.GetSubKeyNames())
                {
                    if (!context.Visit(source)) return;
                    try
                    {
                        using RegistryKey? key = paths.OpenSubKey(name, false);
                        string? target = key?.GetValue(null, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
                        if (target == null || target.Length > 2048) { source.Error(); continue; }
                        target = target.Trim();
                        if (target.StartsWith('"') && target.EndsWith('"')) target = target[1..^1];
                        AddExecutable(Environment.ExpandEnvironmentVariables(target), Path.GetFileNameWithoutExtension(name), source, add);
                    }
                    catch { source.Error(); }
                }
            }
            catch (OperationCanceledException) { throw; }
            catch { source.Error(); }
        }
    }

    private void AddExecutable(string path, string name, SourceState source, Action<AppCandidate> add)
    {
        VerifiedExecutable? executable = Verify(path);
        if (executable == null) { source.Error(); return; }
        string display = name;
        try { display = FileVersionInfo.GetVersionInfo(executable.Path).ProductName ?? name; } catch { /* use discovered filename */ }
        if (string.IsNullOrWhiteSpace(display)) display = name;
        string identity = "exe:" + executable.Path.ToUpperInvariant();
        add(new(identity, display, source.Source, executable, new("executable", executable.Path, executable)));
        if (!name.Equals(display, StringComparison.OrdinalIgnoreCase)) add(new(identity, name, source.Source, executable));
    }

    private void Processes(DiscoveryContext context, SourceState source, Action<AppCandidate> add)
    {
        Dictionary<uint, (ProcessSummary Summary, long Created)> processes = [];
        Process[] all = Process.GetProcesses();
        try
        {
            foreach (Process process in all)
            {
                if (!context.Visit(source)) break;
                try
                {
                    uint pid = checked((uint)process.Id);
                    if (pid == 0) continue;
                    string name = process.ProcessName;
                    using var handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
                    long created = 0;
                    string? path = null; string? aumid = null;
                    if (!handle.IsInvalid)
                    {
                        if (!GetProcessTimes(handle, out created, out _, out _, out _)) { created = 0; source.Partial(); }
                        StringBuilder image = new(2048); uint length = (uint)image.Capacity;
                        if (QueryFullProcessImageName(handle, 0, image, ref length)) path = image.ToString(); else source.Partial();
                        uint count = 0;
                        if (GetApplicationUserModelId(handle, ref count, null) == 122 && count is > 1 and <= 512)
                        {
                            StringBuilder applicationId = new((int)count);
                            if (GetApplicationUserModelId(handle, ref count, applicationId) == 0) aumid = applicationId.ToString();
                        }
                    }
                    else source.Partial();
                    VerifiedExecutable? executable = path == null ? null : Verify(path);
                    if (path != null && executable == null) source.Partial();
                    string identity = !string.IsNullOrWhiteSpace(aumid) ? "aumid:" + aumid : executable != null ? "exe:" + executable.Path.ToUpperInvariant()
                        : "process:" + pid + ":" + created;
                    ProcessSummary summary = new(pid, created > 0 ? DateTime.FromFileTimeUtc(created).ToString("O") : null, created > 0, []);
                    processes[pid] = (summary, created);
                    add(new(identity, name, source.Source, executable, executable != null ? new("executable", executable.Path, executable, AppUserModelId: aumid) : null, summary));
                }
                catch { source.Error(); }
            }
            // Summaries are metadata only. No window_id or input permission is minted here.
            bool completed = EnumWindows((window, state) =>
            {
                if (context.Cancellation.IsCancellationRequested) return false;
                try
                {
                    if (!IsWindowVisible(window) && !IsIconic(window)) return true;
                    GetWindowThreadProcessId(window, out uint pid);
                    if (!processes.TryGetValue(pid, out var entry) || entry.Created == 0) return true;
                    if (!context.Visit(source)) return false;
                    using var handle = OpenProcess(0x1000, false, pid);
                    if (handle.IsInvalid || !GetProcessTimes(handle, out long created, out _, out _, out _) || created != entry.Created) { source.Partial(); return true; }
                    if (entry.Summary.windows.Count >= 4) { source.Partial(); return true; }
                    StringBuilder title = new(257); GetWindowText(window, title, title.Capacity);
                    GetWindowThreadProcessId(window, out uint afterPid);
                    if (afterPid != pid) { source.Partial(); return true; }
                    entry.Summary.windows.Add(new("0x" + window.ToInt64().ToString("x"), ApplicationCatalog.Clip(title.ToString(), 256), IsWindowVisible(window), IsIconic(window)));
                }
                catch (OperationCanceledException) { return false; }
                catch { source.Error(); }
                return true;
            }, IntPtr.Zero);
            if (!completed) source.Partial();
            context.Cancellation.ThrowIfCancellationRequested();
        }
        finally { foreach (Process process in all) process.Dispose(); }
    }
}
