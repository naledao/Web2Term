using System.Text.Json;
using System.Text.RegularExpressions;

namespace Web2Term.WindowsHelper;

internal static partial class ResourceOpenPolicy
{
    internal static bool LocalPath(string path) => path.Length is >= 3 and <= 1024 && char.IsAsciiLetter(path[0]) && path[1] == ':' &&
        path[2] is '\\' or '/' && !path.AsSpan(2).Contains(':') && !path.Any(c => c < 32 || "<>\"|?*".Contains(c)) &&
        path[3..].Split(['\\', '/']).All(part => part.Length == 0 || (!part.EndsWith('.') && !part.EndsWith(' ') && !DeviceName().IsMatch(part)));
    internal static bool Url(string target) => target.Length <= 4096 && HttpStart().IsMatch(target) &&
        !target.Any(c => char.IsWhiteSpace(c) || c < 32 || "<>\"\\".Contains(c)) && !EncodedControl().IsMatch(target) &&
        Uri.TryCreate(target, UriKind.Absolute, out Uri? uri) && uri.Scheme is "http" or "https" && uri.Host.Length > 0 && uri.UserInfo.Length == 0;
    internal static bool ExplicitAppRequired(string target) => ExecutableExtension().IsMatch(target);
    internal static string QuoteArgument(string target) => "\"" + target + new string('\\', target.Reverse().TakeWhile(c => c == '\\').Count()) + "\"";
    [GeneratedRegex(@"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)] private static partial Regex DeviceName();
    [GeneratedRegex(@"^https?://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)] private static partial Regex HttpStart();
    [GeneratedRegex(@"%(?:0[0-9a-f]|1[0-9a-f]|7f)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)] private static partial Regex EncodedControl();
    [GeneratedRegex(@"\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|cpl|lnk|url|appref-ms|reg)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)] private static partial Regex ExecutableExtension();
}

/** A verified local resource, held until dispatch finishes. URL verification never makes a network request. */
internal sealed class ResourceLease(string kind, string target, Action? revalidate = null, IDisposable? held = null) : IDisposable
{
    private int disposed;
    internal string Kind { get; } = kind;
    internal string Target { get; } = target;
    internal void Revalidate() => revalidate?.Invoke();
    public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) held?.Dispose(); }
}
internal interface IResourceOpenDispatcher { DispatchAttempt Open(ResourceLease resource, LaunchSelection? selection, CancellationToken cancellation); }
internal sealed record ResourceOpenResult(string kind, string target, string handler, OpenApplication? application, string? catalog_id, string? app_id, string? launch_reference_id,
    string dispatch_status, string method, int? native_error, ReturnedProcess? returned_process, string before_at, string observed_at,
    bool observation_complete, LaunchCandidate[] candidate_windows, bool control_conversation_preserved = true, bool content_verified = false,
    bool target_window_confirmed = false, bool goal_verified = false);

/** Reuse launch observation/uncertainty rules while keeping resource and application identities separate on the wire. */
internal sealed class ResourceOpenService(IResourceOpenDispatcher dispatcher, IAppWindowProbe probe, Action<int, CancellationToken>? wait = null)
{
    private sealed class DispatchAdapter(IResourceOpenDispatcher dispatcher, ResourceLease resource, LaunchSelection? selection) : IAppLaunchDispatcher
    {
        internal DispatchAttempt? Attempt;
        public DispatchAttempt Dispatch(LaunchSelection ignored, CancellationToken cancellation)
        {
            try { return Attempt = dispatcher.Open(resource, selection, cancellation); }
            finally { resource.Dispose(); }
        }
    }
    internal ActionResult Open(ResourceLease resource, LaunchSelection? selection, int milliseconds, CancellationToken cancellation)
    {
        // Internal observation context only; it is never returned as a catalog reference.
        LaunchSelection observation = selection ?? new("", "", "", "", new("resource", "", null));
        DispatchAdapter adapter = new(dispatcher, resource, selection);
        ActionResult result = new ApplicationLaunchService(adapter, probe, wait).Launch(observation, milliseconds, cancellation);
        ResourceOpenResult? data = result.Data is AppLaunchResult launched ? new(resource.Kind, resource.Target, selection == null ? "system_association" : "discovered_app",
            adapter.Attempt?.Application, selection?.CatalogId, selection?.AppId, selection?.ReferenceId, launched.dispatch_status, launched.method, launched.native_error,
            launched.returned_process, launched.before_at, launched.observed_at, launched.observation_complete, launched.candidate_windows) : null;
        return new(result.Ok, result.Execution, result.Code == "launch_failed" ? "open_failed" : result.Code,
            result.Ok ? "资源打开请求已派发。网页由控制对话之外的浏览器处理，可能复用外部窗口；候选窗口、PID 或系统成功回执不能证明资源内容已加载或任务完成，请继续观察。"
                : result.Execution != "not_executed" ? "资源打开可能已经生效；已派发的操作不会因取消或故障撤销，请先核对实际窗口，不要自动重开。"
                    : result.Code == "stale_catalog" ? "应用引用或资源身份已变化，本次未派发，请重新核实资源或 list_apps。"
                        : result.Code == "invalid_parameters" ? "资源或应用引用不支持此打开方式，本次未派发；请使用系统关联或其他已发现的无预置参数应用引用。"
                            : result.Code == "cancelled" ? "资源打开已取消，本次未派发。" : "无法核实资源或打开组件不可用，本次未派发。", data);
    }
}

internal sealed class OpenResourceAction(ApplicationCatalog catalog, ResourceOpenService opener, Func<string, string, ResourceLease?> verify) : IWindowsAction
{
    public string Name => "open";
    public ActionResult Execute(JsonElement parameters, CancellationToken cancellation)
    {
        if (parameters.ValueKind != JsonValueKind.Object) return Invalid();
        string[] names = parameters.EnumerateObject().Select(property => property.Name).ToArray();
        bool selected = names.Any(name => name is "catalog_id" or "app_id" or "launch_reference_id");
        string[] allowed = selected ? ["kind", "target", "wait_ms", "catalog_id", "app_id", "launch_reference_id"] : ["kind", "target", "wait_ms"];
        if (names.Length != allowed.Length || names.Distinct().Count() != names.Length || names.Any(name => !allowed.Contains(name))) return Invalid();
        foreach (string name in allowed.Where(name => name != "wait_ms")) if (parameters.GetProperty(name).ValueKind != JsonValueKind.String) return Invalid();
        string kind = parameters.GetProperty("kind").GetString()!, target = parameters.GetProperty("target").GetString()!;
        if (kind is not ("file" or "directory" or "url") || (kind == "url" ? !ResourceOpenPolicy.Url(target) : !ResourceOpenPolicy.LocalPath(target)) ||
            (kind == "file" && !selected && ResourceOpenPolicy.ExplicitAppRequired(target)) ||
            parameters.GetProperty("wait_ms").ValueKind != JsonValueKind.Number || !parameters.GetProperty("wait_ms").TryGetInt32(out int milliseconds) || milliseconds is < 0 or > 5000) return Invalid();
        if (cancellation.IsCancellationRequested) return new(false, "not_executed", "cancelled", "资源打开已取消，本次未派发。");
        LaunchSelection? selection = selected ? catalog.ResolveLaunch(parameters.GetProperty("catalog_id").GetString()!, parameters.GetProperty("app_id").GetString()!,
            parameters.GetProperty("launch_reference_id").GetString()!) : null;
        if (selected && selection == null) return new(false, "not_executed", "stale_catalog", "应用引用已过期，请重新 list_apps，本次未派发。");
        if (selection?.Launch.Arguments.Length > 0) return Invalid();
        ResourceLease? resource;
        try { resource = verify(kind, target); }
        catch { resource = null; }
        using (resource)
        {
            if (resource == null || resource.Kind != kind || resource.Target != target) return Invalid();
            return opener.Open(resource, selection, milliseconds, cancellation);
        }
    }
    private static ActionResult Invalid() => new(false, "not_executed", "invalid_parameters", "无法核实资源路径、类型、URL 或参数，本次未派发。");
}
