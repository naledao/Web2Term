import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { EnvironmentKind } from '../shared/types'
import type { BackgroundTaskRegistration } from '../shared/background-tasks'
import type { ShellResult } from './shell'

const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`
const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

export interface BackgroundLaunchPlan {
  command: string
  cwd: string
  registration(output: string): BackgroundTaskRegistration | null
  recovery(output: string): string | null
}

/** Registration happens before any startup-log read and also after a failed startup response. */
export async function startManagedBackground(plan: BackgroundLaunchPlan,
  run: (command: string) => Promise<ShellResult>, register: (registration: BackgroundTaskRegistration) => number
): Promise<{ result: ShellResult; registered: number }> {
  let result: ShellResult
  try { result = await run(plan.command) }
  catch {
    return { registered: 0, result: { output: '后台任务启动通道中断，启动结果未确认；请先检查原任务，避免重复启动。',
      exitCode: null, cwd: plan.cwd, rejected: false, interrupted: false, timedOut: false, sessionLost: true } }
  }
  if (result.rejected) return { result, registered: 0 }
  let registration = plan.registration(result.output)
  if (!registration) {
    const recovery = plan.recovery(result.output)
    if (recovery) {
      try {
        const recovered = await run(recovery)
        registration = plan.registration(recovered.output)
      } catch { /* Preserve the original failure and never launch a second process. */ }
    }
  }
  if (!registration) return { registered: 0, result: { ...result, exitCode: 1,
    output: result.output + '\n软件未确认后台任务的启动信息；不要重复启动，请先检查本次执行记录。' } }
  const summary = `后台任务 PID: ${registration.pid}\n标准输出: ${registration.log_path}\n错误输出: ${registration.stderr_path}\n退出码文件: ${registration.exit_code_path}`
  try {
    const registered = register(registration)
    if (registered < 1) throw new Error('registration declined')
    result = { ...result, output: '软件已启动并登记后台任务。\n' + summary, exitCode: 0 }
    return { result, registered }
  } catch {
    // Keep the real PID and recovery paths visible even if storage unexpectedly fails.
    return { registered: 0, result: { ...result, exitCode: 1,
      output: '后台进程已启动，但软件登记失败；请保留以下信息，避免重复启动。\n' + summary } }
  }
}

/**
 * The app owns the launcher, metadata and exit-code writer. The model supplies only the
 * workload. A private response token prevents workload output from registering other PIDs.
 * Each worker writes its PID manifest BEFORE starting the workload, so a lost startup
 * response can be recovered without finding or guessing unrelated processes.
 */
export function backgroundLaunchPlan(command: string, name: string, kind: EnvironmentKind, cwd: string,
  token = randomUUID().replace(/-/g, '')): BackgroundLaunchPlan {
  if (!command.trim() || command.length > 200000 || !/^[a-z\d]{8,64}$/i.test(token)) throw new Error('后台任务启动参数无效。')
  const marker = `__W2T_LAUNCH_${token}__`
  let startup: string
  if (kind === 'windows') {
    const workload = Buffer.from('\ufeff' + [
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding',
      '$LASTEXITCODE = 0; $Error.Clear()',
      command,
      '$w2tCode = $LASTEXITCODE',
      "if (@($Error | Where-Object { $_.FullyQualifiedErrorId -notmatch '^NativeCommandError' }).Count -gt 0) { $w2tCode = 1 }",
      'exit $w2tCode'
    ].join('\n'), 'utf16le').toString('base64')
    const worker = [
      "$ErrorActionPreference = 'Stop'",
      "$w2tExit = 1; $w2tOut = Join-Path $PSScriptRoot 'stdout.log'; $w2tErr = Join-Path $PSScriptRoot 'stderr.log'",
      // Failure here prevents the actual workload from starting.
      "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pid'), [string]$PID, [Text.Encoding]::ASCII)",
      'try {',
      "  $w2tTask = '& ' + [char]39 + (Join-Path $PSScriptRoot 'workload.ps1').Replace([string][char]39, ([string][char]39 + [char]39)) + [char]39",
      '  $w2tTask64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($w2tTask))',
      `  $w2tChild = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-OutputFormat','Text','-EncodedCommand',$w2tTask64) -WorkingDirectory ${psQuote(cwd)} -RedirectStandardInput (Join-Path $PSScriptRoot 'stdin') -RedirectStandardOutput $w2tOut -RedirectStandardError $w2tErr -WindowStyle Hidden -PassThru`,
      '  $w2tChild.WaitForExit()',
      '  $w2tExit = $w2tChild.ExitCode',
      "  if ($null -eq $w2tExit) { throw 'The workload exit code is unavailable' }",
      '} catch {',
      "  $w2tExit = 1; [IO.File]::AppendAllText($w2tErr, ('Background workload failed: ' + $_.Exception.Message + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))",
      '} finally {',
      "  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'exit.txt'), [string]$w2tExit, [Text.Encoding]::ASCII)",
      '}',
      'exit $w2tExit'
    ].join('\n')
    startup = [
      `$w2tDir = Join-Path ([IO.Path]::GetTempPath()) 'w2t-background-${token}'`,
      // A replay cannot overwrite a task's logs; each new execution gets its own token.
      'if (Test-Path -LiteralPath $w2tDir) { throw "Background task directory already exists" }',
      '$null = [IO.Directory]::CreateDirectory($w2tDir)',
      "[IO.File]::WriteAllText((Join-Path $w2tDir 'stdin'), '', [Text.Encoding]::ASCII)",
      `[IO.File]::WriteAllBytes((Join-Path $w2tDir 'workload.ps1'), [Convert]::FromBase64String('${workload}'))`,
      `[IO.File]::WriteAllBytes((Join-Path $w2tDir 'worker.ps1'), [Convert]::FromBase64String('${Buffer.from('\ufeff' + worker, 'utf8').toString('base64')}'))`,
      "$w2tLocation = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($w2tDir))",
      `Write-Output ('${marker}context:' + $w2tLocation)`,
      "$w2tInvoke = '& ' + [char]39 + (Join-Path $w2tDir 'worker.ps1').Replace([string][char]39, ([string][char]39 + [char]39)) + [char]39",
      '$w2tEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($w2tInvoke))',
      `$w2tProcess = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$w2tEncoded) -WorkingDirectory ${psQuote(cwd)} -RedirectStandardInput (Join-Path $w2tDir 'stdin') -RedirectStandardOutput (Join-Path $w2tDir 'launcher.log') -RedirectStandardError (Join-Path $w2tDir 'launcher.err.log') -WindowStyle Hidden -PassThru`,
      `Write-Output ('${marker}' + [string]$w2tProcess.Id + ':' + $w2tLocation)`
    ].join('\n')
  } else {
    const worker = [
      '#!/bin/sh',
      'w2t_dir=$1',
      'umask 077',
      'printf \'%s\\n\' "$$" > "$w2t_dir/pid" || exit 1',
      // An inner shell makes `exit` in the workload return to the supervisor.
      '/bin/sh "$w2t_dir/workload.sh" </dev/null >"$w2t_dir/stdout.log" 2>"$w2t_dir/stderr.log"',
      'w2t_code=$?',
      'printf \'%s\\n\' "$w2t_code" > "$w2t_dir/exit.txt"',
      'exit "$w2t_code"'
    ].join('\n')
    startup = [
      '(',
      'umask 077',
      'w2t_dir=$(mktemp -d "${TMPDIR:-/tmp}/w2t-background-' + token + '.XXXXXXXX") || exit 1',
      `printf '%s' ${shQuote(command)} > "$w2t_dir/workload.sh" || exit 1`,
      `printf '%s' ${shQuote(worker)} > "$w2t_dir/worker.sh" || exit 1`,
      'w2t_location=$(printf \'%s\' "$w2t_dir" | base64 | tr -d \'\\r\\n\')',
      `printf '${marker}context:%s\\n' "$w2t_location"`,
      // No pipe belongs to the foreground terminal. SSH may close its channel freely.
      'nohup /bin/sh "$w2t_dir/worker.sh" "$w2t_dir" </dev/null >"$w2t_dir/launcher.log" 2>&1 &',
      'w2t_pid=$!',
      `printf '${marker}%s:%s\\n' "$w2t_pid" "$w2t_location"`,
      ')'
    ].join('\n')
  }

  const directory = (encoded: string): string | null => {
    if (!encoded || encoded.length > 8192 || !/^[a-z\d+/]+={0,2}$/i.test(encoded)) return null
    const value = Buffer.from(encoded, 'base64').toString('utf8')
    const dialect = kind === 'windows' ? win32 : posix
    return value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) && dialect.isAbsolute(value)
      && dialect.basename(value).startsWith(`w2t-background-${token}`) ? value : null
  }
  return {
    command: startup,
    cwd,
    registration(output) {
      for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith(marker)) continue
        const match = /^(\d+):([a-z\d+/]+=*)$/i.exec(line.slice(marker.length).trim())
        if (!match) continue
        const dir = directory(match[2]), pid = Number(match[1])
        if (!dir || !Number.isSafeInteger(pid) || pid <= 0) continue
        const dialect = kind === 'windows' ? win32 : posix
        return { pid, name: name.trim().slice(0, 200) || '后台任务', log_path: dialect.join(dir, 'stdout.log'),
          stderr_path: dialect.join(dir, 'stderr.log'), exit_code_path: dialect.join(dir, 'exit.txt') }
      }
      return null
    },
    recovery(output) {
      const line = output.split(/\r?\n/).find(value => value.startsWith(marker + 'context:'))
      const encoded = line?.slice((marker + 'context:').length).trim()
      const dir = encoded ? directory(encoded) : null
      if (!dir) return null
      if (kind === 'windows') return [
        `$w2tPidPath = Join-Path ${psQuote(dir)} 'pid'`,
        // The manifest is a tiny, closed file, not either actively redirected log.
        'if (Test-Path -LiteralPath $w2tPidPath) {',
        '  $w2tPid = [IO.File]::ReadAllText($w2tPidPath).Trim()',
        `  if ($w2tPid -match '^[0-9]+$') { Write-Output ('${marker}' + $w2tPid + ':${encoded}') }`,
        '}'
      ].join('\n')
      return `if [ -r ${shQuote(posix.join(dir, 'pid'))} ]; then w2t_pid=$(cat ${shQuote(posix.join(dir, 'pid'))}); case "$w2t_pid" in ''|*[!0-9]*) ;; *) printf '${marker}%s:${encoded}\\n' "$w2t_pid" ;; esac; fi`
    }
  }
}
