// User-run only: node --test tests/windows-app-details.test.mjs
// Actual Windows taskbar property setup with a synthetic window; no Electron launch or UI input.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(file, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, ...globals, require: name => dependencies[name] })
  return exports
}
const identity = load('../src/shared/app-identity.ts')
const quoting = load('../src/shared/windows-command-line.ts')
function fixture(packaged = false, platform = 'win32') {
  const calls = [], executable = packaged ? 'C:\\Program Files\\Web2Term\\Web2Term.exe'
    : 'C:\\开发 目录\\.cache\\windows-dev-runtime\\fixture\\electron.exe'
  const { configureWindowsAppDetails } = load('../src/main/windows-app-details.ts', {
    electron: { app: { isPackaged: packaged, getAppPath: () => 'C:\\开发 目录\\Web2Term' } },
    './app-identity': identity, '../shared/windows-command-line': quoting
  }, { process: { platform, execPath: executable } })
  configureWindowsAppDetails({ setAppDetails: options => calls.push(JSON.parse(JSON.stringify(options))) })
  return { calls, executable }
}

test('development sets its own taskbar group, branded executable icon and complete project relaunch command', () => {
  const f = fixture()
  assert.deepEqual(f.calls, [{ appId: identity.APP_DEVELOPMENT_ID, appIconPath: f.executable, appIconIndex: 0,
    relaunchCommand: '"' + f.executable + '" "C:\\开发 目录\\Web2Term"', relaunchDisplayName: identity.APP_DEVELOPMENT_NAME }])
})
test('installed taskbar identity retains the stable installed AUMID and launches the installed executable', () => {
  const f = fixture(true)
  assert.deepEqual(f.calls, [{ appId: identity.APP_ID, appIconPath: f.executable, appIconIndex: 0,
    relaunchCommand: '"' + f.executable + '"', relaunchDisplayName: identity.APP_NAME }])
})
test('other operating systems do not receive Windows taskbar properties', () => {
  for (const platform of ['darwin', 'linux']) assert.deepEqual(fixture(false, platform).calls, [])
})
test('Windows relaunch arguments preserve spaces, Unicode, shell metacharacters and trailing backslashes', () => {
  assert.equal(quoting.quoteWindowsArgument('C:\\目录 & test\\app.exe'), '"C:\\目录 & test\\app.exe"')
  assert.equal(quoting.quoteWindowsArgument('C:\\'), '"C:\\\\"')
  assert.equal(quoting.quoteWindowsArgument('a"b'), '"a\\"b"')
})
