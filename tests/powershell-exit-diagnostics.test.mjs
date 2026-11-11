// User-run regressions: node --test tests/powershell-exit-diagnostics.test.mjs tests/command-log.test.mjs
// Synthetic framing plus harmless local PowerShell on Windows. No Electron, application
// profile, network, process termination or real port queries. Agents must not run these tests.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const powershell = {}
new Script(compile(readFileSync(new URL('../src/main/powershell-terminal.ts', import.meta.url), 'utf8')))
  .runInNewContext({ exports: powershell, Buffer })
const plain = value => JSON.parse(JSON.stringify(value))
const metadata = (patch = {}) => ({ exitCode: 1, source: 'powershell-error', nativeExitCode: 0,
  errorCount: 1, ignoredNativeErrorCount: 0, errorsTruncated: false,
  errors: [{ errorId: 'FixtureError,Write-Error', category: 'NotSpecified', commandName: 'Write-Error', lineNumber: 1 }], ...patch })
const framed = (token, seq, value) => `__CT_PS_EXIT_${token}_${seq}__ ${JSON.stringify(value)}`

test('metadata parser accepts only the pending identity, complete JSON and bounded numeric fields', () => {
  const value = metadata(), line = framed('fixture', 2, value)
  assert.deepEqual(plain(powershell.parsePowerShellExitDiagnostic(line, 'fixture', 2)), value)
  assert.equal(powershell.parsePowerShellExitDiagnostic(line, 'other', 2), null)
  assert.equal(powershell.parsePowerShellExitDiagnostic(line, 'fixture', 1), null)
  assert.equal(powershell.parsePowerShellExitDiagnostic(line.slice(0, -1), 'fixture', 2), null)
  for (const patch of [{ source: 'private source' }, { errorCount: -1 }, { nativeExitCode: '1' }, { errors: null }]) {
    assert.equal(powershell.parsePowerShellExitDiagnostic(framed('fixture', 2, metadata(patch)), 'fixture', 2), null)
  }
  assert.equal(powershell.parsePowerShellExitDiagnostic(framed('fixture', 2, { ...value, message: 'x'.repeat(17000) }), 'fixture', 2), null)
})

function localReceiver() {
  const source = ts.createSourceFile('shell.ts', readFileSync(new URL('../src/main/shell.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ConversationShell')
  const body = ['handleData', 'handleLine', 'clearPending'].map(name => declaration.members.find(node => node.name?.getText(source) === name).getText(source)).join('\n')
  return new Script(compile(`class Receiver { ${body} }\nReceiver`)).runInNewContext({
    Buffer, setTimeout, clearTimeout, IDLE_TIMEOUT_MS: 1000,
    parsePowerShellExitDiagnostic: powershell.parsePowerShellExitDiagnostic
  })
}

test('local receiver removes split diagnostic frames from live/model output and attaches matching metadata', () => {
  const Receiver = localReceiver(), shell = new Receiver(), output = []
  let result
  Object.assign(shell, { kind: 'windows', sessionToken: 'fixture', currentCwd: 'C:\\fixture', lineBuffer: '',
    decode: chunk => chunk.toString(), options: { onOutput: chunk => output.push(chunk) },
    pending: { seq: 2, output: '', resolve: value => { result = value }, idleTimer: setTimeout(() => {}, 1000), ceilingTimer: setTimeout(() => {}, 1000) } })
  const line = framed('fixture', 2, metadata())
  shell.handleData(Buffer.from('SUCCESS\r\n' + line.slice(0, 30)))
  assert.equal(result, undefined)
  shell.handleData(Buffer.from(line.slice(30) + '\r\n__CT_DONE_fixture_2__ 1 C:\\fixture\r\n'))
  assert.equal(result.output, 'SUCCESS')
  assert.equal(result.exitCode, 1)
  assert.equal(result.powerShellExit.source, 'powershell-error')
  assert.equal(output.join(''), 'SUCCESS\n')
})

test('local receiver ignores invalid or inconsistent diagnostics without changing command completion', () => {
  for (const line of ['__CT_PS_EXIT_fixture_2__ invalid-json', framed('fixture', 2, metadata({ exitCode: 7 }))]) {
    const Receiver = localReceiver(), shell = new Receiver(), output = []
    let result
    Object.assign(shell, { kind: 'windows', sessionToken: 'fixture', currentCwd: 'C:\\fixture', options: { onOutput: chunk => output.push(chunk) },
      pending: { seq: 2, output: 'SUCCESS\n', resolve: value => { result = value } } })
    shell.handleLine(line)
    shell.handleLine('__CT_DONE_fixture_2__ 1 C:\\fixture')
    assert.equal(result.exitCode, 1)
    assert.equal(result.output, 'SUCCESS')
    assert.equal(result.powerShellExit, undefined)
    assert.deepEqual(output, [])
  }
})

function wrapper() {
  const source = ts.createSourceFile('shell.ts', readFileSync(new URL('../src/main/shell.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildWrapper')
  return new Script(compile(declaration.getText(source) + '\nbuildWrapper')).runInNewContext({
    WINDOWS_PATH_REFRESH_SCRIPT: '', ...powershell
  })('fixture')
}

const windows = { skip: process.platform !== 'win32', timeout: 15000 }
for (const transport of ['pipe', 'envelope']) {
  test(`${transport} PowerShell records hidden errors, exceptions and native codes without changing outcomes`, windows, () => {
    const cases = [
      { command: "'SUCCESS'", source: 'success', code: 0, errors: 0 },
      { command: "Write-Error -Message 'private-error-message' -ErrorId FixtureError -ErrorAction SilentlyContinue; 'SUCCESS'",
        source: 'powershell-error', code: 1, errors: 1 },
      { command: "throw 'private-exception-message'", source: 'exception', code: 1, errors: 1 },
      { command: 'cmd.exe /c exit 7', source: 'native-exit', code: 7, errors: 0 }
    ]
    for (const item of cases) {
      const script = transport === 'pipe' ? wrapper()
        : Buffer.from(powershell.powerShellEnvelope('fixture', 1, item.command).trimEnd().split('\r')
          .map(line => line.slice(1)).join(''), 'base64').toString('utf8')
      const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, encoding: 'utf8', timeout: 10000,
        input: transport === 'pipe' ? Buffer.from(item.command, 'utf16le').toString('base64') + '\n' : ''
      })
      const line = output.split(/\r?\n/).find(line => line.startsWith('__CT_PS_EXIT_fixture_1__ '))
      assert.ok(line, output)
      const diagnostic = powershell.parsePowerShellExitDiagnostic(line, 'fixture', 1)
      assert.ok(diagnostic, line)
      assert.equal(diagnostic.source, item.source)
      assert.equal(diagnostic.exitCode, item.code)
      assert.equal(diagnostic.errorCount >= item.errors, true)
      assert.match(output, new RegExp(`__CT_DONE_fixture_1__ ${item.code} `))
      assert.equal(line.includes('private-error-message'), false)
      assert.equal(line.includes('private-exception-message'), false)
      if (item.source === 'powershell-error') {
        assert.match(output, /SUCCESS/)
        assert.equal(diagnostic.errors[0].commandName, 'Write-Error')
        assert.equal(diagnostic.errors[0].lineNumber, 1)
        assert.match(diagnostic.errors[0].errorId, /FixtureError/)
      }
    }
  })
}
