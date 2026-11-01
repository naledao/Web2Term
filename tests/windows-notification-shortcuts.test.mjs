// User-run offline regressions. All filesystem and Electron operations are mocked.
// Run: node --test tests/windows-notification-shortcuts.test.mjs tests/desktop-notifications.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 as path } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/main/windows-notification-shortcuts.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const appId = 'com.example.gptweb2codexterminal'
const appData = 'C:\\用户\\AppData\\Roaming'
const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const executable = 'C:\\Program Files\\Web2Term\\Web2Term.exe'
const canonical = path.join(programs, 'Web2Term.lnk')
const activator = '{11111111-2222-4333-8444-555555555555}'
const savedActivator = '{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}'
const plain = value => JSON.parse(JSON.stringify(value))
const desired = {
  target: executable, cwd: path.dirname(executable), args: '', description: 'Web2Term',
  icon: executable, iconIndex: 0, appUserModelId: appId, toastActivatorClsid: savedActivator
}

function fixture({ platform = 'win32', packaged = true, existing = desired, writeFails = false,
  unreadable = [], inaccessible = [] } = {}) {
  const files = new Map(), directories = new Map([[programs, []]])
  const targets = new Set([executable])
  const reads = [], writes = [], removed = [], warnings = [], calls = []
  function add(name, details, directory = programs) {
    if (!directories.has(directory)) {
      directories.set(directory, [])
      directories.get(programs).push({ name: path.basename(directory), type: 'directory' })
    }
    const file = path.join(directory, name)
    files.set(file, { ...details })
    directories.get(directory).push({ name, type: 'file' })
    return file
  }
  if (existing) add('Web2Term.lnk', existing)
  const modules = {
    'node:path': path,
    'node:fs': {
      existsSync(file) { calls.push(['exists', file]); return files.has(file) || targets.has(file) || directories.has(file) },
      mkdirSync(directory, options) { calls.push(['mkdir', directory]); assert.equal(options.recursive, true) },
      readdirSync(directory, options) {
        calls.push(['readdir', directory])
        assert.equal(options.withFileTypes, true)
        if (inaccessible.includes(directory)) throw new Error('Access denied')
        return [...directories.get(directory)].map(({ name, type }) => ({ name,
          isDirectory: () => type === 'directory', isFile: () => type === 'file', isSymbolicLink: () => type === 'symlink' }))
      },
      unlinkSync(file) {
        assert.equal(files.get(canonical)?.target, executable, 'a working replacement must exist before removing an old shortcut')
        removed.push(file)
        files.delete(file)
        const directory = path.dirname(file)
        directories.set(directory, directories.get(directory).filter(entry => entry.name !== path.basename(file)))
      }
    },
    electron: {
      app: { isPackaged: packaged, toastActivatorCLSID: activator,
        getPath(name) { calls.push(['getPath', name]); assert.equal(name, 'appData'); return appData } },
      shell: {
        readShortcutLink(file) {
          reads.push(file)
          if (unreadable.includes(file)) throw new Error('Invalid shortcut')
          assert.ok(files.has(file), `Unknown shortcut: ${file}`)
          return { ...files.get(file) }
        },
        writeShortcutLink(file, operation, details) {
          writes.push({ file, operation, details: plain(details) })
          if (writeFails) return false
          if (!files.has(file)) add(path.basename(file), details)
          else files.set(file, plain(details))
          return true
        }
      }
    },
    './app-identity': { APP_NAME: 'Web2Term', APP_ID: appId }
  }
  const module = { exports: {} }
  new Script(code).runInNewContext({ module, exports: module.exports,
    process: { platform, execPath: executable }, console: { info() {}, warn(...args) { warnings.push(args) } },
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name] }
  })
  return { repair: module.exports.repairWindowsNotificationShortcuts, files, directories, targets,
    reads, writes, removed, warnings, calls, add }
}

function legacy(overrides = {}) {
  return { target: 'C:\\Old install\\GPT Web to Codex Terminal.exe', appUserModelId: appId, ...overrides }
}

test('removes the numbered broken legacy shortcut that competes for the installed AUMID', () => {
  const f = fixture()
  const old = f.add('GPT Web to Codex Terminal (2).lnk', legacy())
  f.repair()
  assert.deepEqual(f.removed, [old])
  assert.deepEqual(f.files.get(canonical), desired)
  assert.equal(f.writes.length, 0, 'a healthy canonical link does not need rewriting')
})

test('repairs the renamed executable and blank icon while retaining the persisted toast activator', () => {
  const f = fixture({ existing: { ...desired, target: legacy().target, icon: '', args: '--old', cwd: 'C:\\Old install' } })
  const old = f.add('GPT Web to Codex Terminal.lnk', legacy())
  f.repair()
  assert.deepEqual(f.writes, [{ file: canonical, operation: 'update', details: desired }])
  assert.deepEqual(f.removed, [old])
  f.repair()
  assert.equal(f.writes.length, 1, 'subsequent startups retain the repaired link')
})

test('creates a replacement before removing a broken legacy link when the new shortcut is absent', () => {
  const f = fixture({ existing: null })
  const old = f.add('GPT Web to Codex Terminal.lnk', legacy())
  f.repair()
  assert.deepEqual(f.writes, [{ file: canonical, operation: 'create', details: { ...desired, toastActivatorClsid: activator } }])
  assert.deepEqual(f.removed, [old])
})

test('adds an activator and icon to an installer shortcut without them', () => {
  const f = fixture({ existing: { target: executable, appUserModelId: appId } })
  f.repair()
  assert.deepEqual(f.files.get(canonical), { ...desired, toastActivatorClsid: activator })
})

test('preserves shortcuts for live legacy installations and unrelated applications', () => {
  const f = fixture()
  f.targets.add('C:\\Still installed\\GPT Web to Codex Terminal.exe')
  f.add('GPT Web to Codex Terminal.lnk', legacy({ target: 'C:\\Still installed\\GPT Web to Codex Terminal.exe' }))
  f.add('GPT Web to Codex Terminal (2).lnk', legacy({ appUserModelId: 'another.app' }))
  f.add('GPT Web to Codex Terminal (3).lnk', legacy({ target: 'C:\\Other app\\editor.exe' }))
  f.add('GPT Web to Codex Terminal (4).lnk', legacy({ target: 'Web2Term.exe' }))
  f.add('GPT Web to Codex Terminal (5).lnk', legacy({ target: '' }))
  f.add('My custom Web2Term link.lnk', legacy())
  f.repair()
  assert.deepEqual(f.removed, [])
})

test('finds orphaned pre-rename links in Start Menu subfolders', () => {
  const f = fixture()
  const old = f.add('GPT Web to Codex Terminal (3).lnk', legacy(), path.join(programs, 'Legacy folder'))
  f.repair()
  assert.deepEqual(f.removed, [old])
})

test('never follows directory links outside the Start Menu', () => {
  const f = fixture()
  f.directories.get(programs).push({ name: 'Linked folder', type: 'symlink' })
  f.repair()
  assert.ok(!f.calls.some(([operation, value]) => operation === 'readdir' && value.endsWith('Linked folder')))
})

test('a failed replacement leaves every legacy shortcut intact', () => {
  const f = fixture({ existing: null, writeFails: true })
  const old = f.add('GPT Web to Codex Terminal (2).lnk', legacy())
  f.repair()
  assert.deepEqual(f.removed, [])
  assert.ok(f.files.has(old))
  assert.equal(f.warnings.length, 1)
})

test('an unreadable or foreign canonical shortcut is never overwritten or used to justify cleanup', () => {
  for (const options of [{ unreadable: [canonical] }, { existing: { ...desired, appUserModelId: 'another.app' } }]) {
    const f = fixture(options)
    const old = f.add('GPT Web to Codex Terminal.lnk', legacy())
    f.repair()
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.removed, [])
    assert.ok(f.files.has(old))
    assert.equal(f.warnings.length, 1)
  }
})

test('unreadable links and inaccessible folders do not block other repairs or startup', () => {
  const broken = path.join(programs, 'GPT Web to Codex Terminal.lnk')
  const inaccessible = path.join(programs, 'Restricted folder')
  const f = fixture({ unreadable: [broken], inaccessible: [inaccessible] })
  f.add(path.basename(broken), legacy())
  f.add('GPT Web to Codex Terminal.lnk', legacy(), inaccessible)
  const old = f.add('GPT Web to Codex Terminal (2).lnk', legacy())
  f.repair()
  assert.deepEqual(f.removed, [old])
  assert.ok(f.files.has(broken))
  assert.equal(f.warnings.length, 2)
})

test('development and other operating systems never touch installed shortcuts', () => {
  for (const options of [{ packaged: false }, { platform: 'darwin' }, { platform: 'linux' }]) {
    const f = fixture(options)
    f.repair()
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.reads, [])
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.removed, [])
  }
})
