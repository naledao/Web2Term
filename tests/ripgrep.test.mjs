// USER-RUN ONLY: npm run test:ripgrep
// Temporary files/local shells only. No Electron, app profile, third-party service or network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { binPathFor } from '@vscode/ripgrep-universal'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'w2t-rg-中文 ')))
after(() => rmSync(root, { recursive: true, force: true }))
const osName = platform => platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
const binaryName = platform => platform === 'win32' ? 'rg.exe' : 'rg'
const devTarget = (base, platform, arch) => join(base, `${osName(platform)}-${arch === 'arm' ? 'armv7l' : arch}`)
const sourceBinary = binPathFor({ os: process.platform, arch: process.arch })
const tools = join(root, '内置工具 with spaces', 'ripgrep')

function resource(directory, platform, arch, actual = false) {
  mkdirSync(directory, { recursive: true })
  const executable = join(directory, binaryName(platform))
  if (actual) copyFileSync(sourceBinary, executable)
  else writeFileSync(executable, 'fixture binary')
  chmodSync(executable, 0o755)
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema: 1, platform, arch,
    packageVersion: '1.18.0', sha256: createHash('sha256').update(readFileSync(executable)).digest('hex') }))
  return executable
}
// Put one real executable in the default development location of the bundled fixture.
const hostBinary = resource(devTarget(tools, process.platform, process.arch), process.platform, process.arch, true)
const bundle = join(root, 'subject.cjs')
writeFileSync(bundle, buildSync({
  stdin: {
    contents: `export { bundledRipgrepPath, withRipgrepPath } from './src/main/bundled-ripgrep';
      export { ConversationShell } from './src/main/shell';
      export { buildPosixWrapper } from './src/main/posix-shell';
      export { DETECT_COMMAND, REMOTE_DETECT_COMMAND, LOCAL_POSIX_DETECT_COMMAND,
        parseRemoteEnvironment, parseLocalPosixEnvironment, parseWindowsEnvironment } from './src/main/environment';
      export { buildTerminalPrefix, buildTerminalPrompt, fileSearchPrompt, FALLBACK_ENVIRONMENT } from './src/shared/types';
      export { planInjection, commitInjection } from './src/shared/prompt-injection';`,
    resolveDir: project, loader: 'ts'
  },
  define: { __dirname: JSON.stringify(join(dirname(tools), 'main')) },
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].contents)
const subject = createRequire(import.meta.url)(bundle)

test('packaged resources take priority and wrong-target or missing resources cannot be advertised', () => {
  const resourcesPath = join(root, 'installed app resources')
  const developmentRoot = join(root, 'development')
  const development = resource(devTarget(developmentRoot, 'win32', 'x64'), 'win32', 'x64')
  const options = { platform: 'win32', arch: 'x64', resourcesPath, developmentRoot }
  assert.equal(subject.bundledRipgrepPath(options), development)
  const installed = resource(join(resourcesPath, 'ripgrep'), 'win32', 'x64')
  assert.equal(subject.bundledRipgrepPath(options), installed)
  writeFileSync(join(resourcesPath, 'ripgrep', 'manifest.json'), JSON.stringify({ schema: 1, platform: 'darwin', arch: 'arm64' }))
  assert.equal(subject.bundledRipgrepPath(options), development)
  rmSync(development)
  assert.equal(subject.bundledRipgrepPath(options), null)
})

test('Windows PATH is local, case-insensitive, deduplicated and preserves drive roots', () => {
  const env = { PATH: 'C:\\custom;C:', Path: 'C:\\CUSTOM\\;C:\\;C:\\Program Files\\Web2Term\\ripgrep', KEEP: 'yes' }
  const before = { ...env }
  const next = subject.withRipgrepPath(env, 'C:\\Program Files\\Web2Term\\ripgrep\\rg.exe', 'win32')
  assert.deepEqual(env, before)
  assert.deepEqual(Object.keys(next).filter(key => key.toLowerCase() === 'path'), ['Path'])
  assert.deepEqual(next.Path.split(';'), ['C:\\Program Files\\Web2Term\\ripgrep', 'C:\\custom', 'C:', 'C:\\'])
  assert.equal(next.KEEP, 'yes')
  assert.deepEqual(subject.withRipgrepPath(env, null, 'win32'), env)
})

test('POSIX startup restores the tool path after login and safely quotes apostrophes', () => {
  const env = { PATH: '/usr/bin:/bin', OTHER: 'value' }
  const next = subject.withRipgrepPath(env, "/Applications/User's App/rg", 'darwin')
  assert.equal(next.PATH, "/Applications/User's App:/usr/bin:/bin")
  assert.equal(env.PATH, '/usr/bin:/bin')
  const wrapper = subject.buildPosixWrapper('fixture', 'darwin', "/Applications/User's App")
  assert.ok(wrapper.includes("export PATH='/Applications/User'\\''s App':\"$PATH\""))
})

test('environment reports describe only the current machine, including legacy reports', () => {
  const windows = subject.parseWindowsEnvironment(JSON.stringify({ osCaption: 'Windows', powerShellVersion: '5.1', ripgrep: 'available' }), 'powershell.exe')
  assert.equal(windows.ripgrep, 'available')
  const remote = 'OSCAP=Ubuntu|OSVER=6|ARCH=x86_64|SHELLP=/bin/sh|CWD=/home/user'
  assert.equal(subject.parseRemoteEnvironment(remote + '|RG=missing', 'private', 'private').ripgrep, 'missing')
  assert.equal(subject.parseRemoteEnvironment(remote + '|RG=available', '', '').ripgrep, 'available')
  assert.equal(subject.parseRemoteEnvironment(remote, '', '').ripgrep, 'unknown')
  assert.equal(subject.parseRemoteEnvironment('', '', '').ripgrep, 'unknown')
  assert.equal(subject.parseWindowsEnvironment('{}', 'powershell.exe').ripgrep, 'unknown')
  assert.ok(subject.DETECT_COMMAND.includes('Get-Command rg'))
  assert.ok(subject.REMOTE_DETECT_COMMAND.includes('command -v rg'))
})

test('search guidance is always inline, capability-aware, and updates existing conversations by delta', () => {
  const env = { ...subject.FALLBACK_ENVIRONMENT, ripgrep: 'available' }
  const available = subject.buildTerminalPrompt(env)
  assert.ok(available.includes('rg 已就绪'))
  assert.ok(available.includes('rg --files') && available.includes('rg -n -F'))
  assert.ok(available.includes('rg 返回 1 仅表示未命中，2 表示错误，勿因通用失败标签重复执行'))
  assert.ok(!available.includes('你是 PowerShell 终端助手'))
  const missingPrompt = subject.fileSearchPrompt({ ...env, ripgrep: 'missing' })
  assert.ok(missingPrompt.includes('当前终端无 rg') && !missingPrompt.includes('rg --files'))
  assert.ok(subject.fileSearchPrompt({ ...env, ripgrep: 'unknown' }).includes('先确认 rg 是否可用'))
  const first = subject.planInjection(null, subject.buildTerminalPrefix(env), 'chatgpt')
  const ledger = subject.commitInjection(null, first, 1)
  const delta = subject.planInjection(ledger, subject.buildTerminalPrefix({ ...env, ripgrep: 'missing' }), 'chatgpt')
  assert.equal(delta.mode, 'delta')
  assert.deepEqual(delta.changed, ['【文件定位与内容搜索】'])
  assert.ok(delta.prefix.includes('当前终端无 rg'))
  assert.ok(!delta.prefix.includes('【工作协议】'))
})

async function shell(t, cwd) {
  const instance = new subject.ConversationShell({ initialCwd: cwd })
  t.after(async () => { instance.dispose(); await instance.whenQuiescent() })
  return instance
}

test('real persistent terminals find bundled rg in a Unicode path and preserve exit codes 0, 1 and 2', { timeout: 30000 }, async t => {
  assert.equal(subject.bundledRipgrepPath(), hostBinary)
  const cwd = join(root, 'project with spaces')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, '源码 file.txt'), 'needle literal .*\n中文 needle\n', 'utf8')
  mkdirSync(join(cwd, '.git'))
  mkdirSync(join(cwd, 'node_modules'))
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(cwd, 'node_modules', 'ignored.txt'), 'needle')
  writeFileSync(join(cwd, '.hidden.txt'), 'needle')
  const instance = await shell(t, cwd)
  const report = await instance.run(instance.probeCommand)
  assert.equal(report.exitCode, 0, report.output)
  const env = process.platform === 'win32'
    ? subject.parseWindowsEnvironment(report.output, 'powershell.exe')
    : subject.parseLocalPosixEnvironment(report.output)
  assert.equal(env.ripgrep, 'available', report.output)
  const located = await instance.run(process.platform === 'win32'
    ? '(Get-Command rg -CommandType Application).Source' : 'command -v rg')
  assert.equal(located.exitCode, 0, located.output)
  assert.equal(realpathSync(located.output.trim()), realpathSync(hostBinary))
  const files = await instance.run("rg --files -g '*.txt'")
  assert.equal(files.exitCode, 0, files.output)
  assert.ok(files.output.includes('源码 file.txt'))
  assert.ok(!files.output.includes('ignored.txt') && !files.output.includes('.hidden.txt'))
  const hit = await instance.run("rg -n -F --color never -- 'needle literal .*' '源码 file.txt'")
  assert.equal(hit.exitCode, 0, hit.output)
  assert.match(hit.output, /1:needle literal \.\*/)
  const missing = await instance.run("rg -n -F --color never -- 'does-not-exist' '源码 file.txt'")
  assert.equal(missing.exitCode, 1, missing.output)
  const invalid = await instance.run("rg --color never -- '[' '源码 file.txt'")
  assert.equal(invalid.exitCode, 2, invalid.output)
  // A newly opened/reopened session uses the same startup path; no global install required.
  const second = await shell(t, cwd)
  const version = await second.run('rg --version')
  assert.equal(version.exitCode, 0, version.output)
  assert.match(version.output, /ripgrep \d/)
  const inherited = await second.run(process.platform === 'win32'
    ? 'cmd.exe /d /c rg --version' : "/bin/sh -c 'rg --version'")
  assert.equal(inherited.exitCode, 0, inherited.output)
  assert.match(inherited.output, /ripgrep \d/)
})

test('packaging hook rejects missing or changed resources before signing', async () => {
  const verify = createRequire(import.meta.url)(join(project, 'build', 'verify-package-resources.cjs'))
  const appOutDir = join(root, 'mac installer')
  const directory = join(appOutDir, 'Fixture.app', 'Contents', 'Resources', 'ripgrep')
  const context = { electronPlatformName: 'darwin', arch: 3, appOutDir,
    packager: { appInfo: { productFilename: 'Fixture' } } }
  await assert.rejects(verify(context))
  resource(directory, 'darwin', 'arm64')
  for (const name of ['LICENSE-ripgrep.txt', 'LICENSE-vscode-ripgrep.txt', 'LICENSE-PCRE2.txt']) {
    writeFileSync(join(directory, name), 'fixture notice')
  }
  await verify(context)
  writeFileSync(join(directory, 'rg'), 'changed bytes')
  await assert.rejects(verify(context), /corrupt|another target/)
})

test('all installer targets have staged binaries, target manifests, hashes and notices', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'x64']]) {
    const directory = devTarget(join(project, 'out', 'ripgrep'), platform, arch)
    assert.ok(existsSync(directory), 'Run npm run ripgrep:prepare before this test')
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.platform, platform)
    assert.equal(manifest.arch, arch)
    assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(join(directory, binaryName(platform)))).digest('hex'))
    for (const name of ['LICENSE-ripgrep.txt', 'LICENSE-vscode-ripgrep.txt', 'LICENSE-PCRE2.txt']) {
      assert.ok(readFileSync(join(directory, name), 'utf8').trim())
    }
  }
})
