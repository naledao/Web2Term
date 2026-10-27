using System.Text;
using System.Text.Json;

namespace Web2Term.WindowsHelper;

internal static class Protocol
{
    internal const int Version = 7; // Physical double-Escape gesture events; model protocol stays v1.
    internal const int MaxRequestBytes = 65_536;
    internal const int MaxFrameBytes = 262_144;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    // ReadLineAsync alone permits an unbounded line allocation. Limit bytes before decoding.
    internal static async Task<JsonDocument?> ReadAsync(Stream input, CancellationToken cancellation)
    {
        using MemoryStream bytes = new();
        byte[] single = new byte[1];
        while (await input.ReadAsync(single, cancellation) != 0)
        {
            if (single[0] == 10)
            {
                string json = Utf8.GetString(bytes.GetBuffer(), 0, checked((int)bytes.Length));
                JsonDocument document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
                try
                {
                    CheckTree(document.RootElement);
                    if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
                    return document;
                }
                catch { document.Dispose(); throw; }
            }
            if (bytes.Length >= MaxRequestBytes) throw new InvalidDataException();
            bytes.WriteByte(single[0]);
        }
        if (bytes.Length != 0) throw new InvalidDataException();
        return null;
    }

    private static void CheckTree(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            HashSet<string> names = new(StringComparer.Ordinal);
            foreach (JsonProperty property in value.EnumerateObject())
            {
                if (!names.Add(property.Name) || property.Name is "__proto__" or "constructor" or "prototype" || names.Count > 128)
                    throw new InvalidDataException();
                CheckTree(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            if (value.GetArrayLength() > 256) throw new InvalidDataException();
            foreach (JsonElement item in value.EnumerateArray()) CheckTree(item);
        }
        else if (value.ValueKind == JsonValueKind.String && value.GetString()!.Length > 32_768) throw new InvalidDataException();
    }

    internal static void Fields(JsonElement value, params string[] fields)
    {
        HashSet<string> expected = new(fields, StringComparer.Ordinal);
        if (value.EnumerateObject().Any(property => !expected.Remove(property.Name)) || expected.Count != 0) throw new InvalidDataException();
        if (value.GetProperty("version").GetInt32() != Version) throw new InvalidDataException();
    }

    internal static string Id(JsonElement value, string field = "id")
    {
        string? id = value.GetProperty(field).GetString();
        if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException();
        return id!;
    }
}

internal sealed class ProtocolWriter(Stream output)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    internal async Task SendAsync(object frame)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
        if (bytes.Length > Protocol.MaxFrameBytes) throw new InvalidDataException();
        await gate.WaitAsync();
        try
        {
            await output.WriteAsync(bytes);
            await output.WriteAsync(new byte[] { 10 });
            await output.FlushAsync();
        }
        finally { gate.Release(); }
    }
}
