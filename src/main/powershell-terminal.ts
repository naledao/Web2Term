// Console.ReadLine defaults to a 256-character buffer (254 characters plus CRLF).
// Leave room for the loader's PowerShell syntax as well as the command-frame prefix.
const LINE_DATA = 192

export interface PowerShellBootstrapFailure {
  bootstrapStage: 'decode' | 'console_type' | 'console_mode' | 'encoding' | 'command_loop' | 'unknown'
  errorId: string
}

/** Accept only bounded diagnostic identifiers; never log arbitrary terminal output. */
export function parsePowerShellBootstrapFailure(line: string, ready: string): PowerShellBootstrapFailure | null {
  const prefix = ready + '_FAILED'
  if (line !== prefix && !line.startsWith(prefix + ' ')) return null
  const fallback: PowerShellBootstrapFailure = { bootstrapStage: 'unknown', errorId: 'unknown' }
  const [stage, errorId, extra] = line.slice(prefix.length + 1).split(' ')
  if (extra !== undefined || !['decode', 'console_type', 'console_mode', 'encoding', 'command_loop'].includes(stage)
    || !/^[A-Za-z0-9_.:-]{1,40}$/u.test(errorId ?? '')) return fallback
  return { bootstrapStage: stage as PowerShellBootstrapFailure['bootstrapStage'], errorId }
}

/** The Console.ReadLine limit also applies inside ConPTY, including after initialization. */
export function powerShellEnvelope(token: string, seq: number, command: string): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  const script = [
    `$w2tCommand = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    '$LASTEXITCODE = 0; $Error.Clear(); $w2tCode = 0; $w2tSavedIn = [Console]::In',
    'try {',
    "[Console]::SetIn((New-Object IO.StringReader ''))",
    'Invoke-Expression $w2tCommand | Out-String -Stream | ForEach-Object { [Console]::WriteLine($_) }',
    "if ($LASTEXITCODE -ne 0) { $w2tCode = $LASTEXITCODE } elseif (@($Error | Where-Object { $_.FullyQualifiedErrorId -notlike '*NativeCommandError*' }).Count -gt 0) { $w2tCode = 1 }",
    '} catch { [Console]::WriteLine($_.Exception.Message); $w2tCode = 1 }',
    'finally { [Console]::SetIn($w2tSavedIn) }',
    `[Console]::WriteLine([Environment]::NewLine + '__CT_DONE_${token}_${seq}__ ' + $w2tCode + ' ' + (Get-Location).Path)`
  ].join('\n')
  const data = Buffer.from(script, 'utf8').toString('base64')
  if (data.length >= 2097152) throw new Error('PowerShell command exceeds the frame limit')
  const lines: string[] = []
  for (let offset = 0; offset < data.length; offset += LINE_DATA) {
    lines.push((offset + LINE_DATA >= data.length ? '=' : '+') + data.slice(offset, offset + LINE_DATA))
  }
  return lines.join('\r') + '\r'
}

/** Send this line alone: PSReadLine can read ahead and retain subsequent lines in its own queue. */
export function powerShellPrepare(ready: string): string {
  return "Remove-Module PSReadLine -ErrorAction SilentlyContinue; function global:PSConsoleHostReadLine { [Console]::ReadLine() }; "
    + `[Console]::WriteLine([Environment]::NewLine + '${ready}_INPUT')\r`
}

/** Send after the input acknowledgement; retain the existing PowerShell's directory and variables. */
export function powerShellBootstrap(ready: string): string {
  const script = [
    "$ErrorActionPreference = 'Continue'",
    'Remove-Module PSReadLine -ErrorAction SilentlyContinue',
    "$w2tStage = 'console_type'",
    "Add-Type -ErrorAction Stop -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class W2TConsole { [DllImport(\"kernel32.dll\")] public static extern IntPtr GetStdHandle(int n); [DllImport(\"kernel32.dll\")] public static extern bool GetConsoleMode(IntPtr h, out uint m); [DllImport(\"kernel32.dll\")] public static extern bool SetConsoleMode(IntPtr h, uint m); }'",
    "$w2tStage = 'console_mode'",
    '$w2tInputHandle = [W2TConsole]::GetStdHandle(-10); [uint32]$w2tInputMode = 0',
    'if (-not [W2TConsole]::GetConsoleMode($w2tInputHandle, [ref]$w2tInputMode)) { throw "CONSOLE_UNAVAILABLE" }',
    // ECHO_INPUT; retain processed input, so a raw Ctrl+C still reaches the console.
    'if (-not [W2TConsole]::SetConsoleMode($w2tInputHandle, ($w2tInputMode -band [uint32]4294967291))) { throw "CONSOLE_MODE_UNAVAILABLE" }',
    "$w2tStage = 'encoding'",
    '$OutputEncoding = New-Object Text.UTF8Encoding $false; [Console]::OutputEncoding = $OutputEncoding; [Console]::InputEncoding = $OutputEncoding',
    "if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = 'PlainText' }",
    "$w2tStage = 'command_loop'",
    '$w2tFrame = New-Object Text.StringBuilder',
    `[Console]::WriteLine([Environment]::NewLine + '${ready}')`,
    'while ($true) {',
    '$w2tLine = [Console]::ReadLine(); if ($null -eq $w2tLine) { break }',
    "if ($w2tLine.Length -lt 1) { continue }; if ($w2tLine[0] -ne '+' -and $w2tLine[0] -ne '=') { continue }",
    'if ($w2tFrame.Length + $w2tLine.Length -gt 2097152) { throw "Command too large" }',
    '[void]$w2tFrame.Append($w2tLine.Substring(1))',
    "if ($w2tLine[0] -eq '=') {",
    'try { $w2tScript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($w2tFrame.ToString())); [void]$w2tFrame.Clear(); Invoke-Expression $w2tScript } catch { [void]$w2tFrame.Clear(); [Console]::WriteLine($_.Exception.Message) }',
    '}',
    '}',
    'exit'
  ].join('\n')
  // ASCII bootstrap avoids shell quoting and preserves non-ASCII paths in subsequent commands.
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  const lines = [
    `$w2tFailure = '${ready}_FAILED'`,
    "$w2tStage = 'decode'",
    'function global:W2TBootstrapFailure {',
    'param($w2tError)',
    "$w2tErrorId = ([string]$w2tError.FullyQualifiedErrorId).Split(',')[0]",
    "if ($w2tErrorId -notmatch '^[A-Za-z0-9_.:-]{1,40}$') { $w2tErrorId = 'unknown' }",
    "[Console]::WriteLine([Environment]::NewLine + $w2tFailure + ' ' + $w2tStage + ' ' + $w2tErrorId)",
    '}',
    // Native ConsoleHost submits a multiline block only when it receives a blank line.
    '',
    '$w2tStartup = New-Object Text.StringBuilder'
  ]
  for (let offset = 0; offset < encoded.length; offset += LINE_DATA) lines.push(`[void]$w2tStartup.Append('${encoded.slice(offset, offset + LINE_DATA)}')`)
  lines.push('try {',
    `if ($w2tStartup.Length -ne ${encoded.length}) { throw 'BOOTSTRAP_LENGTH_MISMATCH' }`,
    'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($w2tStartup.ToString())))',
    '} catch { W2TBootstrapFailure $_ }', '')
  return lines.join('\r') + '\r'
}
