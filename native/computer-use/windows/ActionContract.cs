using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal sealed record ActionResult(bool Ok, string Execution, string Code, string Message, object? Data = null);

/** Fixed compiled actions only. Never execute text as JavaScript, PowerShell, or other code. */
internal interface IWindowsAction
{
    string Name { get; }
    ActionResult Execute(JsonElement parameters, CancellationToken cancellation);
}
