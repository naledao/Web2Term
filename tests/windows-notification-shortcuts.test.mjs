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
const developmentRoot = 'C:\\开发 目录\\Web2Term'
const developmentExecutable = path.join(developmentRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const developmentManifest = path.join(developmentRoot, 'package.json')
const activator = '{11111111-2222-4333-8444-555555555555}'
const savedActivator = '{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}'
const plain = value => JSON.parse(JSON.stringify(value))
const desired = {
  target: executable, cwd: path.dirname(executable), args: '', description: 'Web2Term',
  icon: executable, iconIndex: 0, appUserModelId: appId, toastActivatorClsid: savedActivator
}

function fixture({ platform = 'win32', packaged = true, existing = desired, writeFails = false,
  unreadable = [], inaccessible = [] } = {}) {
  const files = new Map(), manifests = new Map(), directories = new Map([[programs, []]])
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
      readFileSync(file, encoding) {
        calls.push(['readFile', file])
        assert.equal(encoding, 'utf8')
        if (unreadable.includes(file)) throw new Error('Access denied')
        if (!manifests.has(file)) throw new Error('File not found')
        return manifests.get(file)
      },
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
  return { repair: module.exports.repairWindowsNotificationShortcuts, files, manifests, directories, targets,
    reads, writes, removed, warnings, calls, add }
}

function legacy(overrides = {}) {
  return { target: 'C:\\Old install\\GPT Web to Codex Terminal.exe', appUserModelId: appId, ...overrides }
}

function development(overrides = {}) {
  return { target: developmentExecutable, appUserModelId: appId, ...overrides }
}

test('removes a project Electron shortcut competing with the installed identity even while its target exists', () => {
  for (const name of ['web2term', 'gpt-web-to-codex-terminal']) {
    const f = fixture()
    f.targets.add(developmentExecutable)
    f.manifests.set(developmentManifest, JSON.stringify({ name }))
    const old = f.add('Electron.lnk', development())
    f.repair()
    assert.deepEqual(f.removed, [old])
    assert.ok(f.targets.has(developmentExecutable), 'only the conflicting shortcut is removed')
    assert.deepEqual(f.files.get(canonical), desired)
    assert.equal(f.writes.length, 0)
    f.repair()
    assert.deepEqual(f.removed, [old], 'subsequent startups do not repeat the cleanup')
  }
})

test('finds numbered project Electron shortcuts in Start Menu subfolders', () => {
  const f = fixture()
  f.manifests.set(developmentManifest, JSON.stringify({ name: 'web2term' }))
  const old = f.add('eLeCtRoN (2).LNK', development(), path.join(programs, 'Development'))
  f.repair()
  assert.deepEqual(f.removed, [old])
})

test('preserves Electron shortcuts with separate identities, unrelated projects or unrecognized targets', () => {
  const unrelatedRoot = 'C:\\Other project'
  const unrelatedExecutable = path.join(unrelatedRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  const f = fixture()
  f.manifests.set(developmentManifest, JSON.stringify({ name: 'web2term' }))
  f.manifests.set(path.join(unrelatedRoot, 'package.json'), JSON.stringify({ name: 'another-app' }))
  f.add('Electron.lnk', development({ appUserModelId: `${appId}.development` }))
  f.add('Electron (2).lnk', development({ appUserModelId: 'another.app' }))
  f.add('Electron (3).lnk', development({ appUserModelId: '' }))
  f.add('Electron (4).lnk', development({ target: unrelatedExecutable }))
  f.add('Electron (5).lnk', development({ target: 'C:\\Other app\\electron.exe' }))
  f.add('Electron (6).lnk', development({ target: 'node_modules\\electron\\dist\\electron.exe' }))
  f.add('Electron (7).lnk', development({ target: '' }))
  f.add('My Electron shortcut.lnk', development())
  f.repair()
  assert.deepEqual(f.removed, [])
  assert.deepEqual(f.writes, [])
})

test('missing, malformed, unrecognized or unreadable project manifests never justify removing an Electron shortcut', () => {
  for (const contents of [undefined, '{invalid', 'null', '[]', '"web2term"', '{}', '{"name":"another-app"}']) {
    const f = fixture()
    if (contents !== undefined) f.manifests.set(developmentManifest, contents)
    const old = f.add('Electron.lnk', development())
    f.repair()
    assert.deepEqual(f.removed, [])
    assert.ok(f.files.has(old))
  }
  const f = fixture({ unreadable: [developmentManifest] })
  f.manifests.set(developmentManifest, JSON.stringify({ name: 'web2term' }))
  const old = f.add('Electron.lnk', development())
  f.repair()
  assert.deepEqual(f.removed, [])
  assert.ok(f.files.has(old))
})

test('ensures a working installed shortcut before cleaning up a project Electron shortcut', () => {
  const f = fixture({ existing: null })
  f.manifests.set(developmentManifest, JSON.stringify({ name: 'web2term' }))
  const old = f.add('Electron.lnk', development())
  f.repair()
  assert.deepEqual(f.writes, [{ file: canonical, operation: 'create', details: { ...desired, toastActivatorClsid: activator } }])
  assert.deepEqual(f.removed, [old])
})

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
  f.manifests.set(developmentManifest, JSON.stringify({ name: 'web2term' }))
  const old = f.add('GPT Web to Codex Terminal (2).lnk', legacy())
  const electron = f.add('Electron.lnk', development())
  f.repair()
  assert.deepEqual(f.removed, [])
  assert.ok(f.files.has(old))
  assert.ok(f.files.has(electron))
  assert.equal(f.warnings.length, 1)
})

test('an unreadable or foreign canonical shortcut is never overwritten or used to justify cleanup', () => {
  for (const options of [{ unreadable: [canonical] }, { existing: { ...desired, appUserModelId: 'another.app' } }]) {
    const f = fixture(options)
    f.manifests.set(developmentManifest, JSON.stringify({ name: 'web2term' }))
    const old = f.add('GPT Web to Codex Terminal.lnk', legacy())
    const electron = f.add('Electron.lnk', development())
    f.repair()
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.removed, [])
    assert.ok(f.files.has(old))
    assert.ok(f.files.has(electron))
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
