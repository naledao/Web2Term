// User-run offline regressions. Electron, filesystem and registry calls are mocked.
// Run: node --test tests/windows-notification-identity.test.mjs tests/desktop-notifications.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 as path } from 'node:path'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/main/windows-notification-identity.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const appId = 'com.example.gptweb2codexterminal'
const developmentId = `${appId}.development`
const key = `HKCU\\Software\\Classes\\AppUserModelId\\${developmentId}`
const appData = 'C:\\用户\\AppData\\Roaming'
const profile = path.join(appData, 'Web2Term')
const checkout = 'C:\\开发 目录 & tools\\Web2Term'
const sourceExecutable = path.join(checkout, 'node_modules', 'electron', 'dist', 'electron.exe')
const executable = path.join(checkout, '.cache', 'windows-dev-runtime', 'fixture', 'electron.exe')
const shortcutPath = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Electron.lnk')
const developmentName = 'Web2Term (Development)'
const canonical = path.join(path.dirname(shortcutPath), `${developmentName}.lnk`)
const icon = path.join(profile, 'notifications', 'development', 'icon.png')
const generatedActivator = '{11111111-2222-4333-8444-555555555555}'
const persistedActivator = '{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}'
const ownedShortcut = { target: sourceExecutable, appUserModelId: developmentId, toastActivatorClsid: persistedActivator }
const quoting = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/windows-command-line.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: quoting })

function fixture({ platform = 'win32', packaged = false, shortcut = ownedShortcut, unreadable = false,
  failCopy = false, failValue = null, existing, unreadableCanonical = false, failShortcut = false } = {}) {
  const calls = [], warnings = [], registry = new Map(), links = new Map(), writes = []
  if (shortcut) links.set(shortcutPath, { ...shortcut })
  if (existing) links.set(canonical, { ...existing })
  let activator = generatedActivator
  const installedKey = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`
  registry.set(installedKey, { DisplayName: 'Installed Web2Term', IconUri: 'C:\\installed\\icon.png' })
  const app = { isPackaged: packaged,
    getPath(name) { calls.push(['getPath', name]); assert.ok(['appData', 'userData'].includes(name)); return name === 'appData' ? appData : profile },
    getAppPath: () => checkout,
    get toastActivatorCLSID() { return activator },
    setToastActivatorCLSID(value) { calls.push(['activator', value]); activator = value } }
  const modules = {
    'node:path': path,
    'node:fs': { existsSync: file => links.has(file),
      mkdirSync(directory, options) { calls.push(['mkdir', directory]); assert.equal(options.recursive, true) },
      unlinkSync(file) {
        assert.equal(links.get(canonical)?.target, executable, 'ensure a branded replacement before retiring a legacy link')
        assert.equal(file, shortcutPath); calls.push(['unlink', file]); links.delete(file)
      } },
    'node:fs/promises': {
      async mkdir(directory, options) { calls.push(['mkdir', directory]); assert.equal(options.recursive, true) },
      async copyFile(source, destination) { calls.push(['copy', source, destination]); if (failCopy) throw new Error('Missing icon') }
    },
    'node:child_process': { execFile(file, args, options, callback) {
      assert.equal(file, 'C:\\Windows\\System32\\reg.exe')
      assert.equal(options.windowsHide, true)
      assert.equal(options.timeout, 3000)
      assert.equal(options.shell, undefined, 'paths and values must be literal process arguments')
      const [operation, target, valueFlag, name, typeFlag, type, dataFlag, value, force] = args
      assert.equal(operation, 'add'); assert.equal(target, key); assert.equal(valueFlag, '/v')
      assert.equal(typeFlag, '/t'); assert.equal(type, name === 'CustomActivator' ? 'REG_SZ' : 'REG_EXPAND_SZ')
      assert.equal(dataFlag, '/d'); assert.equal(force, '/f')
      calls.push(['registry', target, name, value])
      if (failValue === name) { callback(new Error('Access denied')); return }
      const entry = registry.get(target) ?? {}
      entry[name] = value; registry.set(target, entry)
      callback(null)
    } },
    electron: { app, shell: {
      readShortcutLink(file) {
        calls.push(['shortcut', file]); assert.ok(links.has(file))
        if (file === shortcutPath && unreadable || file === canonical && unreadableCanonical) throw new Error('Invalid shortcut')
        return { ...links.get(file) }
      },
      writeShortcutLink(file, operation, details) {
        assert.equal(file, canonical)
        writes.push({ file, operation, details: JSON.parse(JSON.stringify(details)) })
        if (failShortcut) return false
        links.set(file, { ...details }); return true
      }
    } },
    './app-identity': { APP_ID: appId, APP_DEVELOPMENT_ID: developmentId, APP_DEVELOPMENT_NAME: developmentName },
    '../shared/windows-command-line': quoting
  }
  const module = { exports: {} }
  new Script(code).runInNewContext({ module, exports: module.exports,
    process: { platform, execPath: executable, env: { SystemRoot: 'C:\\Windows', WEB2TERM_DEV_ELECTRON_SOURCE: sourceExecutable } },
    console: { warn: (...args) => warnings.push(args) },
    require(name) { assert.ok(name in modules, name); return modules[name] }
  })
  return { register: module.exports.registerWindowsDevelopmentNotificationIdentity, calls, warnings, registry, links, writes,
    installed: () => registry.get(installedKey) }
}

test('development registers the Web2Term notification header and a stable branded PNG for its separate AUMID', async () => {
  const f = fixture()
  await f.register()
  assert.deepEqual(f.registry.get(key), { DisplayName: developmentName, IconUri: icon, CustomActivator: persistedActivator })
  assert.deepEqual(f.writes[0], { file: canonical, operation: 'create', details: {
    target: executable, cwd: path.dirname(executable), args: '"' + checkout + '"', description: developmentName,
    icon: executable, iconIndex: 0, appUserModelId: developmentId, toastActivatorClsid: persistedActivator
  } })
  assert.equal(f.links.has(shortcutPath), false)
  assert.deepEqual(f.calls.find(call => call[0] === 'copy'), ['copy', path.join(checkout, 'build', 'icon.png'), icon])
  assert.deepEqual(f.installed(), { DisplayName: 'Installed Web2Term', IconUri: 'C:\\installed\\icon.png' })
  assert.equal(f.warnings.length, 0)
  await f.register()
  assert.equal(f.registry.get(key).IconUri, icon, 'restarts reuse a stable icon location')
  assert.equal(f.writes.length, 1, 'Electron and later startups retain a healthy branded shortcut')
})

test('a fresh development checkout registers the same activator that Electron will use for its first shortcut', async () => {
  const f = fixture({ shortcut: null })
  await f.register()
  assert.equal(f.registry.get(key).CustomActivator, generatedActivator)
  assert.equal(f.links.get(canonical).toastActivatorClsid, generatedActivator)
})

test('the existing project Electron activator is retained even if the old shortcut used the installed AUMID', async () => {
  const f = fixture({ shortcut: { ...ownedShortcut, appUserModelId: appId } })
  await f.register()
  assert.equal(f.registry.get(key).CustomActivator, persistedActivator)
  assert.equal(f.installed().DisplayName, 'Installed Web2Term')
})

test('unrelated, malformed or unreadable Electron shortcut metadata cannot supply the registered activator', async () => {
  for (const options of [
    { shortcut: { ...ownedShortcut, appUserModelId: 'another.app' } },
    { shortcut: { ...ownedShortcut, target: 'C:\\another checkout\\electron.exe' } },
    { shortcut: { ...ownedShortcut, toastActivatorClsid: '' }, retain: false },
    { unreadable: true }
  ]) {
    const f = fixture(options)
    await f.register()
    assert.equal(f.registry.get(key).CustomActivator, generatedActivator)
    assert.equal(f.links.get(canonical).toastActivatorClsid, generatedActivator)
    assert.equal(f.links.has(shortcutPath), options.retain !== false, 'only a positively identified legacy shortcut can be retired')
  }
})

test('missing icon files and denied registry writes are reported without aborting application startup', async () => {
  for (const options of [{ failCopy: true }, { failValue: 'DisplayName' }, { failValue: 'IconUri' }, { failValue: 'CustomActivator' }]) {
    const f = fixture(options)
    await assert.doesNotReject(f.register())
    assert.equal(f.warnings.length, 1)
    assert.equal(f.installed().DisplayName, 'Installed Web2Term')
    if (options.failCopy) assert.ok(!f.calls.some(call => call[0] === 'registry'))
  }
})

test('packaged applications and other operating systems do not install development branding', async () => {
  for (const options of [{ packaged: true }, { platform: 'darwin' }, { platform: 'linux' }]) {
    const f = fixture(options)
    await f.register()
    assert.deepEqual(f.calls, [])
    assert.equal(f.registry.has(key), false)
  }
})

test('a moved branded runtime repairs its shortcut while preserving the canonical activator', async () => {
  const f = fixture({ existing: { target: 'C:\\old cache\\electron.exe', appUserModelId: developmentId,
    toastActivatorClsid: generatedActivator, icon: '' } })
  await f.register()
  assert.equal(f.writes[0].operation, 'update')
  assert.equal(f.links.get(canonical).target, executable)
  assert.equal(f.links.get(canonical).icon, executable)
  assert.equal(f.links.get(canonical).toastActivatorClsid, generatedActivator)
  assert.equal(f.registry.get(key).CustomActivator, generatedActivator)
})

test('a failed, unreadable or foreign replacement leaves the legacy shortcut and registry untouched', async () => {
  for (const options of [{ failShortcut: true },
    { existing: { ...ownedShortcut, appUserModelId: 'another.app' } },
    { existing: { ...ownedShortcut }, unreadableCanonical: true }]) {
    const f = fixture(options)
    await f.register()
    assert.ok(f.links.has(shortcutPath))
    assert.equal(f.registry.has(key), false)
    assert.equal(f.warnings.length, 1)
  }
})
