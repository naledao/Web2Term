// User-run only: node --test tests/windows-dev-runtime.test.mjs
// Real PE resource editing and file caching with a tiny synthetic executable.
// Never launches Electron, reads an application profile or accesses the network.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const identity = {}
new Script(compile('../src/shared/app-identity.ts')).runInNewContext({ exports: identity })
const resourcesEditor = await import('../build/windows-executable-resources.mjs')
const runtime = {}
new Script(compile('../build/windows-dev-runtime.ts')).runInNewContext({ exports: runtime, Buffer, process,
  console: { info() {} }, require: name => name === '../src/shared/app-identity' ? identity :
    name === './windows-executable-resources.mjs' ? resourcesEditor : require(name) })
const icon = readFileSync(new URL('../build/icon.ico', import.meta.url))

function sourceExecutable() {
  const exe = NtExecutable.createEmpty(false)
  const resources = NtExecutableResource.from(exe)
  const version = Resource.VersionInfo.create(0x409, {}, [
    { lang: 0x409, codepage: 1200, values: { ProductName: 'Electron', FileDescription: 'Electron', FileVersion: '44.5.0' } },
    { lang: 0x804, codepage: 1200, values: { ProductName: 'Electron', FileDescription: 'Electron', FileVersion: '44.5.0' } }
  ])
  version.setFileVersion(44, 5, 0, 0)
  version.outputToResourceEntries(resources.entries)
  const manifest = Buffer.from('<assembly><trustInfo>unchanged fixture manifest</trustInfo></assembly>')
  resources.entries.push({ type: 24, id: 1, lang: 0x409, codepage: 0,
    bin: manifest.buffer.slice(manifest.byteOffset, manifest.byteOffset + manifest.byteLength) })
  resources.outputResource(exe)
  return Buffer.from(exe.generate())
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'w2t-dev-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceDirectory = join(root, 'upstream'), cacheDirectory = join(root, '.cache', 'windows-dev-runtime')
  const iconPath = join(root, 'build', 'icon.ico')
  await mkdir(join(sourceDirectory, 'resources'), { recursive: true })
  await mkdir(dirname(iconPath), { recursive: true })
  await Promise.all([
    writeFile(join(sourceDirectory, 'electron.exe'), sourceExecutable()), writeFile(join(sourceDirectory, 'version'), '44.5.0'),
    writeFile(join(sourceDirectory, 'icudtl.dat'), 'synthetic ICU data'),
    writeFile(join(sourceDirectory, 'resources', 'default_app.asar'), 'synthetic default app'), writeFile(iconPath, icon)
  ])
  const options = { sourceDirectory, cacheDirectory, iconPath }
  return { root, ...options, prepare: () => runtime.prepareWindowsDevelopmentRuntime(options) }
}

test('PE branding replaces all localized product names and embeds Web2Term icons while preserving versions and manifest', () => {
  const branded = runtime.brandWindowsDevelopmentExecutable(sourceExecutable(), icon)
  const resources = NtExecutableResource.from(NtExecutable.from(branded))
  const version = Resource.VersionInfo.fromEntries(resources.entries)[0]
  for (const language of version.getAllLanguagesForStringValues()) {
    const strings = version.getStringValues(language)
    assert.equal(strings.ProductName, identity.APP_DEVELOPMENT_NAME)
    assert.equal(strings.FileDescription, identity.APP_DEVELOPMENT_NAME)
    assert.equal(strings.OriginalFilename, 'electron.exe')
  }
  assert.equal(version.fixedInfo.fileVersionMS, 44 * 65536 + 5)
  const embedded = Resource.IconGroupEntry.fromEntries(resources.entries)[0].getIconItemsFromEntries(resources.entries)
  assert.deepEqual(embedded.map(item => [item.width, item.height]), Data.IconFile.from(icon).icons.map(item => [item.data.width, item.data.height]))
  assert.match(Buffer.from(resources.entries.find(entry => entry.type === 24).bin).toString(), /unchanged fixture manifest/)
})

test('the cached runtime retains electron.exe, includes distribution assets and never edits upstream files', async t => {
  const f = await fixture(t), original = await readFile(join(f.sourceDirectory, 'electron.exe'))
  const executable = await f.prepare()
  assert.equal(basename(executable), 'electron.exe', 'renaming would make app.isPackaged true')
  assert.notEqual(dirname(executable), f.sourceDirectory)
  assert.equal((await readFile(join(dirname(executable), 'resources', 'default_app.asar'))).toString(), 'synthetic default app')
  assert.deepEqual(await readFile(join(f.sourceDirectory, 'electron.exe')), original)
  assert.equal(await f.prepare(), executable, 'unchanged inputs reuse the same immutable runtime')
})

test('Electron or icon changes select a new cache without overwriting a potentially running copy', async t => {
  const f = await fixture(t), first = await f.prepare()
  await writeFile(join(f.sourceDirectory, 'version'), '44.5.1')
  const second = await f.prepare()
  assert.notEqual(first, second)
  await writeFile(f.iconPath, Buffer.concat([icon, Buffer.from('valid trailing ICO padding')]))
  const third = await f.prepare()
  assert.notEqual(second, third)
  assert.ok((await readFile(first)).length > 0)
})

test('missing cached assets rebuild into a fresh directory instead of reusing a partial distribution', async t => {
  const f = await fixture(t), first = await f.prepare()
  await rm(join(dirname(first), 'icudtl.dat'))
  assert.notEqual(await f.prepare(), first)
})

test('failed preparation removes only its staging directory and can recover on the next invocation', async t => {
  const f = await fixture(t)
  await rm(join(f.sourceDirectory, 'icudtl.dat'))
  await assert.rejects(f.prepare(), /ENOENT/)
  assert.deepEqual(await readdir(f.cacheDirectory), [])
  await writeFile(join(f.sourceDirectory, 'icudtl.dat'), 'repaired fixture')
  assert.equal(basename(await f.prepare()), 'electron.exe')
})

test('source and cache overlap is rejected before any copy or recursive cleanup', async t => {
  const f = await fixture(t)
  await assert.rejects(runtime.prepareWindowsDevelopmentRuntime({ ...f, cacheDirectory: join(f.sourceDirectory, 'cache') }), /separate/)
  assert.deepEqual(await readFile(join(f.sourceDirectory, 'electron.exe')), sourceExecutable())
})

test('configuration leaves builds and other operating systems untouched and retains the upstream source across reloads', async t => {
  const unexpected = () => assert.fail('builds and other platforms must not prepare a runtime')
  for (const [command, platform] of [['build', 'win32'], ['serve', 'darwin'], ['serve', 'linux']]) {
    const env = {}
    await runtime.configureWindowsDevelopmentRuntime(command, '', unexpected, env, platform)
    assert.deepEqual(env, {})
  }
  const f = await fixture(t), source = join(f.sourceDirectory, 'electron.exe'), env = {}
  await runtime.configureWindowsDevelopmentRuntime('serve', f.root, () => source, env, 'win32')
  assert.equal(env.WEB2TERM_DEV_ELECTRON_SOURCE, source)
  const executable = env.ELECTRON_EXEC_PATH
  await runtime.configureWindowsDevelopmentRuntime('serve', f.root, unexpected, env, 'win32')
  assert.equal(env.ELECTRON_EXEC_PATH, executable)
  await assert.rejects(runtime.configureWindowsDevelopmentRuntime('serve', f.root, () => 'Web2Term.exe', {}, 'win32'), /retain the electron.exe/)
})
