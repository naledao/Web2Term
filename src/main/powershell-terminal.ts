// Console.ReadLine defaults to a 256-character buffer (254 characters plus CRLF).
// Leave room for the loader's PowerShell syntax as well as the command-frame prefix.
const LINE_DATA = 192

export interface PowerShellExitDiagnostic {
  exitCode: number
  source: 'success' | 'native-exit' | 'powershell-error' | 'exception'
  nativeExitCode: number
  errorCount: number
  ignoredNativeErrorCount: number
  errorsTruncated: boolean
  errors: Array<{ errorId: string; category: string; commandName: string; lineNumber: number }>
}

/** Whitelist metadata again at the logging boundary; never retain messages, arguments or paths. */
export function powerShellExitDiagnosticMetadata(value: unknown): PowerShellExitDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (typeof data.source !== 'string' || !['success', 'native-exit', 'powershell-error', 'exception'].includes(data.source) ||
    !Number.isSafeInteger(data.exitCode) || !Number.isSafeInteger(data.nativeExitCode) ||
    !Number.isSafeInteger(data.errorCount) || Number(data.errorCount) < 0 ||
    !Number.isSafeInteger(data.ignoredNativeErrorCount) || Number(data.ignoredNativeErrorCount) < 0 ||
    !Array.isArray(data.errors) || typeof data.errorsTruncated !== 'boolean') return null
  const identifier = (input: unknown, pattern: RegExp): string =>
    typeof input === 'string' && pattern.test(input) ? input : 'unknown'
  const errors = data.errors.slice(0, 5).map((input: unknown) => {
    const error = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    return {
      errorId: identifier(error.errorId, /^[A-Za-z0-9_.:,-]{1,160}$/),
      category: identifier(error.category, /^[A-Za-z]{1,64}$/),
      commandName: identifier(error.commandName, /^[A-Za-z][A-Za-z0-9]{0,39}-[A-Za-z][A-Za-z0-9]{0,79}$/),
      lineNumber: Number.isSafeInteger(error.lineNumber) && Number(error.lineNumber) >= 0 ? Number(error.lineNumber) : 0
    }
  })
  return {
    exitCode: Number(data.exitCode), source: data.source as PowerShellExitDiagnostic['source'],
    nativeExitCode: Number(data.nativeExitCode), errorCount: Number(data.errorCount),
    ignoredNativeErrorCount: Number(data.ignoredNativeErrorCount),
    errorsTruncated: data.errorsTruncated || data.errors.length > 5, errors
  }
}

/** Only the pending command's private protocol line can supply exit diagnostics. */
export function parsePowerShellExitDiagnostic(line: string, token: string, seq: number): PowerShellExitDiagnostic | null {
  const prefix = `__CT_PS_EXIT_${token}_${seq}__ `
  if (!line.startsWith(prefix) || line.length > 16384) return null
  try { return powerShellExitDiagnosticMetadata(JSON.parse(line.slice(prefix.length))) }
  catch { return null }
}

export function powerShellExitInitialize(prefix: 'ct' | 'w2t'): string {
  return `$${prefix}ExitSource = 'success'; $${prefix}NativeExitCode = 0; $${prefix}ExitErrors = @()`
}

/** Preserve the existing exit policy, taking a snapshot before diagnostic work can affect $Error. */
export function powerShellExitStatus(prefix: 'ct' | 'w2t'): string {
  const variable = '$' + prefix
  return [
    `${variable}NativeExitCode = $LASTEXITCODE; ${variable}ExitErrors = @($Error)`,
    `if (${variable}NativeExitCode -ne 0) { ${variable}Code = ${variable}NativeExitCode; ${variable}ExitSource = 'native-exit' }`,
    `elseif (@(${variable}ExitErrors | Where-Object { $_.FullyQualifiedErrorId -notlike '*NativeCommandError*' }).Count -gt 0) { ${variable}Code = 1; ${variable}ExitSource = 'powershell-error' }`
  ].join('\n')
}

export function powerShellExitException(prefix: 'ct' | 'w2t'): string {
  return `$${prefix}NativeExitCode = $LASTEXITCODE; $${prefix}ExitErrors = @($Error); $${prefix}ExitSource = 'exception'; $${prefix}Code = 1`
}

/** A separate framed record is removed by the receiver, not shown or returned as command output. */
export function powerShellExitReport(tokenExpression: string, seqExpression: string, prefix: 'ct' | 'w2t'): string {
  const variable = '$' + prefix
  return [
    'try {',
    `${variable}ExitFiltered = @(${variable}ExitErrors | Where-Object { $_.FullyQualifiedErrorId -notlike '*NativeCommandError*' })`,
    `${variable}ExitDetails = @(${variable}ExitFiltered | Select-Object -First 5 | ForEach-Object {`,
    `${variable}ExitId = [string]$_.FullyQualifiedErrorId`,
    `if (${variable}ExitId -cnotmatch '^[A-Za-z0-9_.:,-]{1,160}$') { ${variable}ExitId = 'unknown' }`,
    `${variable}ExitCommand = ''; if ($null -ne $_.InvocationInfo -and $null -ne $_.InvocationInfo.MyCommand) { ${variable}ExitCommand = [string]$_.InvocationInfo.MyCommand.Name }`,
    `if (${variable}ExitCommand -cnotmatch '^[A-Za-z][A-Za-z0-9]{0,39}-[A-Za-z][A-Za-z0-9]{0,79}$') { ${variable}ExitCommand = 'unknown' }`,
    `@{ errorId = ${variable}ExitId; category = [string]$_.CategoryInfo.Category; commandName = ${variable}ExitCommand; lineNumber = [int]$_.InvocationInfo.ScriptLineNumber }`,
    '})',
    `${variable}ExitDiagnostic = @{ exitCode = ${variable}Code; source = ${variable}ExitSource; nativeExitCode = ${variable}NativeExitCode; errorCount = ${variable}ExitFiltered.Count; ignoredNativeErrorCount = (${variable}ExitErrors.Count - ${variable}ExitFiltered.Count); errorsTruncated = (${variable}ExitFiltered.Count -gt 5); errors = @(${variable}ExitDetails) }`,
    `[Console]::WriteLine([Environment]::NewLine + '__CT_PS_EXIT_' + ${tokenExpression} + '_' + ${seqExpression} + '__ ' + (ConvertTo-Json -InputObject ${variable}ExitDiagnostic -Compress -Depth 4))`,
    '} catch { }'
  ].join('\n')
}

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

/** Keep command frames short; initialization still passes through Console.ReadLine. */
export function powerShellEnvelope(token: string, seq: number, command: string): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  const script = [
    `$w2tCommand = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    '$LASTEXITCODE = 0; $Error.Clear(); $w2tCode = 0; $w2tSavedIn = [Console]::In',
    powerShellExitInitialize('w2t'),
    'try {',
    "[Console]::SetIn((New-Object IO.StringReader ''))",
    'Invoke-Expression $w2tCommand | Out-String -Stream | ForEach-Object { [Console]::WriteLine($_) }',
    powerShellExitStatus('w2t'),
    `} catch { ${powerShellExitException('w2t')}; [Console]::WriteLine($_.Exception.Message) }`,
    'finally { [Console]::SetIn($w2tSavedIn) }',
    powerShellExitReport(`'${token}'`, String(seq), 'w2t'),
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
    "$w2tStage = 'console_mode'",
    'if ([Console]::IsInputRedirected) { throw "CONSOLE_UNAVAILABLE" }',
    // ReadKey(true) suppresses protocol echo without compiling a native console wrapper.
    // Retain processed Ctrl+C for the raw terminal; managed interruption closes the PTY.
    '[Console]::TreatControlCAsInput = $false',
    "$w2tStage = 'encoding'",
    '$OutputEncoding = New-Object Text.UTF8Encoding $false; [Console]::OutputEncoding = $OutputEncoding; [Console]::InputEncoding = $OutputEncoding',
    "if ($null -ne (Get-Variable PSStyle -ErrorAction SilentlyContinue)) { $PSStyle.OutputRendering = 'PlainText' }",
    "$w2tStage = 'command_loop'",
    '$w2tFrame = New-Object Text.StringBuilder',
    '$w2tLineBuffer = New-Object Text.StringBuilder',
    `[Console]::WriteLine([Environment]::NewLine + '${ready}')`,
    'while ($true) {',
    '$w2tKey = [Console]::ReadKey($true)',
    'if ($w2tKey.Key -ne [ConsoleKey]::Enter) {',
    'if ($w2tKey.KeyChar -eq [char]0 -or $w2tKey.KeyChar -eq [char]10) { continue }',
    'if ($w2tLineBuffer.Length -ge 4096) { throw "INPUT_LINE_TOO_LARGE" }',
    '[void]$w2tLineBuffer.Append($w2tKey.KeyChar)',
    'continue',
    '}',
    '$w2tLine = $w2tLineBuffer.ToString(); [void]$w2tLineBuffer.Clear()',
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
