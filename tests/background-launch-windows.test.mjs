// User-run only: node --test tests/background-launch-windows.test.mjs
// Runs generated launchers with synthetic local workloads; no Electron, Hermes or network.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url), exports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/main/background-launch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports, Buffer, require(name) {
  assert.ok(['node:crypto', 'node:path'].includes(name))
  return nodeRequire(name)
} })

async function runWorkload(t, command, forceUnknown = false) {
  const directory = await mkdtemp(join(tmpdir(), 'w2t-background-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const plan = exports.backgroundLaunchPlan(command, 'exit-code regression', 'windows', directory)
  const payload = file => Buffer.from(plan.command.match(new RegExp(
    "'" + file.replace('.', '\\.') + "'\\), \\[Convert\\]::FromBase64String\\('([^']+)'"
  ))[1], 'base64')
  let worker = payload('worker.ps1').toString('utf8')
  if (forceUnknown) {
    const assignment = '$w2tExit = $w2tChild.ExitCode'
    assert.ok(worker.includes(assignment))
    // Simulate an unreadable OS exit status after a real child has finished.
    worker = worker.replace(assignment, '$w2tExit = $null')
  }
  await Promise.all([
    writeFile(join(directory, 'worker.ps1'), worker),
    writeFile(join(directory, 'workload.ps1'), payload('workload.ps1')),
    writeFile(join(directory, 'stdin'), '')
  ])
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const processCode = await new Promise((resolveCode, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'worker.ps1')],
      { cwd: directory, windowsHide: true, timeout: 30000 }, error => {
        if (error && !Number.isInteger(error.code)) reject(error)
        else resolveCode(error?.code ?? 0)
      })
  })
  const exitCode = await readFile(join(directory, 'exit.txt'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return { processCode, exitCode,
    stdout: await readFile(join(directory, 'stdout.log'), 'utf8'),
    stderr: await readFile(join(directory, 'stderr.log'), 'utf8') }
}

const windowsOnly = { skip: process.platform !== 'win32' }
test('successful replies and immediately exiting workloads retain exit code zero', windowsOnly, async t => {
  for (const command of ["Write-Output 'OK'; Write-Output 'HERMES_TEST_EXIT_CODE=0'", 'exit 0']) {
    const result = await runWorkload(t, command)
    assert.equal(result.processCode, 0, result.stderr)
    assert.equal(result.exitCode, '0', result.stderr)
  }
})

test('a success-looking log cannot hide a real nonzero workload exit code', windowsOnly, async t => {
  const result = await runWorkload(t, "Write-Output 'HERMES_TEST_EXIT_CODE=0'; exit 7")
  assert.equal(result.processCode, 7)
  assert.equal(result.exitCode, '7')
})

test('an unreadable exit status is not recorded as workload failure', windowsOnly, async t => {
  const result = await runWorkload(t, "Write-Output 'OK'", true)
  assert.equal(result.processCode, 1, 'the supervisor reports its own error')
  assert.equal(result.exitCode, null, 'the observer must retain an unknown workload exit code')
  assert.match(result.stdout, /OK/)
  assert.match(result.stderr, /Background task supervisor error: The workload exit code is unavailable/)
})

test('a terminating workload error is still recorded as failed', windowsOnly, async t => {
  const result = await runWorkload(t, "throw 'synthetic workload failure'")
  assert.equal(result.processCode, 1)
  assert.equal(result.exitCode, '1')
})
