// User-run offline regressions. Registry, filesystem and Electron are mocked; no Windows settings change.
// Run: node --test tests/notification-sound.test.mjs tests/desktop-notifications.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/main/notification-sound.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const schemes = 'HKCU\\AppEvents\\Schemes'
const event = 'Notification.Web2Term.WoodDrop'
const eventKey = name => `${schemes}\\Apps\\.Default\\${name}`
const profile = 'C:\\用户\\Web2Term profile'
const destination = win32.join(profile, 'sounds', 'notification-wood-drop.wav')

function fixture({ platform = 'win32', packaged = true, current, scheme = '.Default', failCopy = false,
  failRegistry = () => false } = {}) {
  const registry = new Map([[schemes, scheme]])
  if (current !== undefined) registry.set(`${eventKey(event)}\\.Current`, current)
  const calls = [], warnings = []
  const modules = {
    'node:path': { join: win32.join },
    'node:child_process': { execFile(file, args, options, callback) {
      assert.equal(file, 'C:\\Windows\\System32\\reg.exe')
      assert.equal(options.windowsHide, true)
      assert.equal(options.timeout, 3000)
      assert.equal(options.shell, undefined, 'registry arguments must not be interpreted by a shell')
      const [operation, key] = args
      calls.push({ operation, key, args: Array.from(args) })
      if (failRegistry(operation, key)) { callback(new Error('Access denied'), '', ''); return }
      if (operation === 'query') {
        const value = registry.get(key)
        callback(value === undefined ? new Error('Not found') : null,
          value === undefined ? '' : `\r\n${key}\r\n    (默认)    REG_SZ    ${value}\r\n`, '')
      } else {
        assert.equal(operation, 'add')
        assert.equal(args[2], '/ve')
        assert.equal(args[4], 'REG_SZ')
        registry.set(key, args[6])
        callback(null, '', '')
      }
    } },
    'node:fs/promises': {
      async mkdir(path, options) { calls.push({ operation: 'mkdir', path }); assert.equal(options.recursive, true) },
      async copyFile(source, target) {
        calls.push({ operation: 'copy', source, target })
        if (failCopy) throw new Error('Missing sound recording')
      }
    },
    electron: { app: {
      isPackaged: packaged,
      getPath(name) { assert.equal(name, 'userData'); return profile },
      getAppPath() { return 'C:\\source checkout' }
    } }
  }
  const module = { exports: {} }
  new Script(code).runInNewContext({ module, exports: module.exports,
    process: { platform, env: { SystemRoot: 'C:\\Windows' }, resourcesPath: 'C:\\Program Files\\Web2Term\\resources' },
    console: { warn: (...args) => warnings.push(args) },
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name] }
  })
  return { register: module.exports.registerNotificationSound, registry, calls, warnings }
}

test('registers only a Web2Term sound event and makes its WAV accessible outside app.asar', async () => {
  const f = fixture()
  assert.equal(await f.register(), `ms-winsoundevent:${event}`)
  assert.equal(f.registry.get(`${eventKey(event)}\\.Current`), destination)
  assert.equal(f.registry.get(`${eventKey(event)}\\.Default`), destination)
  assert.equal(f.registry.get(`HKCU\\AppEvents\\EventLabels\\${event}`), 'Web2Term - Wood drop')
  assert.deepEqual(f.calls.find(call => call.operation === 'copy'), { operation: 'copy',
    source: 'C:\\Program Files\\Web2Term\\resources\\notification-wood-drop.wav', target: destination })
  const writes = f.calls.filter(call => call.operation === 'add')
  assert.equal(writes.length, 3)
  assert.ok(writes.every(call => call.key.includes(event)), 'never replace a built-in Windows sound or notification policy')
})

test('repeat startup retains an explicit mute or a user-selected sound', async () => {
  for (const current of ['', 'C:\\my sounds\\custom.wav']) {
    const f = fixture({ current })
    assert.equal(await f.register(), `ms-winsoundevent:${event}`)
    await f.register()
    assert.equal(f.registry.get(`${eventKey(event)}\\.Current`), current)
    assert.ok(!f.calls.some(call => call.operation === 'add' && call.key.endsWith('\\.Current')))
  }
})

test('registering during No Sounds leaves the new event muted and retains its default recording', async () => {
  const f = fixture({ scheme: '.None' })
  assert.equal(await f.register(), `ms-winsoundevent:${event}`)
  assert.equal(f.registry.get(`${eventKey(event)}\\.Current`), '')
  assert.equal(f.registry.get(`${eventKey(event)}\\.Default`), destination)
})

test('an existing event respects the active sound scheme on subsequent launches', async () => {
  const f = fixture()
  await f.register()
  f.registry.set(schemes, '.None')
  f.registry.set(`${eventKey(event)}\\.Current`, '') // Windows applied the new scheme.
  await f.register()
  assert.equal(f.registry.get(`${eventKey(event)}\\.Current`), '')
})

test('development loads the source WAV and uses a separate sound event', async () => {
  const f = fixture({ packaged: false, current: 'C:\\installed selection.wav' })
  assert.equal(await f.register(), `ms-winsoundevent:${event}.Development`)
  assert.equal(f.registry.get(`${eventKey(event)}\\.Current`), 'C:\\installed selection.wav')
  assert.equal(f.registry.get(`${eventKey(event + '.Development')}\\.Current`), destination)
  assert.equal(f.calls.find(call => call.operation === 'copy').source, 'C:\\source checkout\\build\\notification-wood-drop.wav')
})

test('registration failures fall back to native system sound without starting independent audio', async () => {
  for (const options of [
    { failCopy: true },
    { scheme: undefined, failRegistry: (operation, key) => operation === 'query' && key === schemes },
    { failRegistry: operation => operation === 'add' },
    { failRegistry: (operation, key) => operation === 'add' && key.endsWith('\\.Default') },
    { failRegistry: (operation, key) => operation === 'add' && key.includes('EventLabels') }
  ]) {
    const f = fixture(options)
    assert.equal(await f.register(), undefined)
    assert.equal(f.warnings.length, 1)
  }
})

test('unreadable active schemes do not enable a new event', async () => {
  const f = fixture({ scheme: '' })
  assert.equal(await f.register(), undefined)
  assert.ok(!f.calls.some(call => call.operation === 'add'))
})

test('other operating systems do not copy audio or access the Windows registry', async () => {
  for (const platform of ['darwin', 'linux']) {
    const f = fixture({ platform })
    assert.equal(await f.register(), undefined)
    assert.equal(f.calls.length, 0)
  }
})
