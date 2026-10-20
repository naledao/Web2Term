// User-run offline regression: node --test tests/web2term-environment.test.mjs
// Calls the real runtime probe/prompt update methods with fake shells and views.
// Never constructs SessionRuntime, starts Electron/a shell, or contacts a service.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const forbidden = () => { throw new Error('Real I/O is forbidden in this test') }
function load(relative, dependencies = {}, desktop = 'win32') {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  new Script(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, Buffer, URL, console,
    process: { platform: desktop, env: {} },
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return exports
}
const files = load('../src/shared/file-requests.ts')
const types = load('../src/shared/types.ts', { './file-requests': files })
const platforms = load('../src/shared/platforms.ts', { './types': types })
const REPORT = 'OSCAP=Ubuntu 26.04.1 LTS|OSVER=7.0.0-38-generic|ARCH=x86_64|SHELLP=/usr/bin/bash|SHELLV=GNU bash, version 5.3.9|CWD=/home/fixture'
const result = (output, patch = {}) => ({ output, exitCode: 0, rejected: false, interrupted: false,
  timedOut: false, sessionLost: false, cwd: '/home/fixture', ...patch })

function fixture({ transport = 'web2term', desktop = 'win32', output = REPORT, flags = {} } = {}) {
  const environment = load('../src/main/environment.ts', {
    'node:os': { arch: () => 'x64', homedir: () => desktop === 'darwin' ? '/Users/desktop' : 'C:\\Users\\desktop', release: () => 'desktop-version' },
    './posix-shell': { localPosixShellPath: () => '/bin/zsh' }, '../shared/types': types
  }, desktop)
  const { SessionRuntime } = load('../src/main/session-runtime.ts', {
    'node:crypto': { randomUUID: forbidden }, 'mysql2/promise': { createConnection: forbidden },
    './mysql-field-value': {}, electron: {}, './command-log': {},
    '../shared/types': types, '../shared/platforms': platforms, './file-access': {},
    'node:os': { homedir: forbidden }, './commands': {}, './db': {}, './nacos-view': {},
    './mysql-table-rows': {}, './redis-reader': {}, './embed': {}, './environment': environment,
    './shell': { resolvePowerShell: () => 'powershell.exe' }, './ssh': {}, './web2term-shell': {}, './terminal-notes': {}
  }, desktop)
  const runtime = Object.create(SessionRuntime.prototype)
  const prompts = new Map()
  const events = []
  const remote = { alive: true, cwd: '/home/fixture' }
  let probeCalls = 0
  Object.assign(runtime, {
    id: 'environment-fixture', disposed: false,
    web2term: transport === 'web2term' ? { ...remote, hostId: 'web2term:fixture',
      binding: { deviceName: 'Private device name', agentId: 'private-device-id' } } : null,
    remoteShell: transport === 'ssh' ? remote : null,
    environment: transport === 'local' ? environment.nodeFallback() : { ...types.FALLBACK_ENVIRONMENT, kind: 'posix', osCaption: 'Linux' },
    environmentScope: { scope: transport === 'local' ? 'local' : 'ssh', hostId: '', label: '' },
    embeds: new Map(platforms.CHAT_PLATFORMS.map((platform) => [platform.id, { platform,
      embed: { setPromptParts: (parts) => prompts.set(platform.id, parts) } }])),
    runner: { runEnvironmentProbe: async () => { probeCalls++; return {
      kind: transport !== 'local' || desktop === 'darwin' ? 'posix' : 'windows', result: result(output, flags)
    } } },
    ssh: { getState: () => ({ name: 'Private SSH name', target: 'private-ssh-address', hostId: 'ssh:fixture' }) },
    currentNotes: () => ({ scope: transport === 'local' ? 'local' : 'ssh', hostId: 'fixture', directory: runtime.environment.workingDirectory,
      directoryKey: 'fixture', label: 'fixture', text: 'directory-specific guidance', legacyText: '' }),
    readRedisConnectionsState: () => ({ connections: [] }), broadcastConversations() {},
    send: (channel, payload) => events.push({ channel, payload }), options: { onSummaryChanged() {} }
  })
  return { runtime, prompts, events, probeCalls: () => probeCalls }
}

test('web2term on a Windows desktop uses the remote Linux report and updates every platform prompt', async () => {
  const { runtime, prompts, events, probeCalls } = fixture()
  const info = await runtime.probeEnvironment()
  assert.equal(probeCalls(), 1)
  assert.equal(info.kind, 'posix')
  assert.equal(info.osCaption, 'Ubuntu 26.04.1 LTS')
  assert.equal(info.osVersion, '7.0.0-38-generic')
  assert.equal(info.architecture, 'x86_64')
  assert.equal(info.shellPath, '/usr/bin/bash')
  assert.equal(info.shellVersion, 'GNU bash, version 5.3.9')
  assert.equal(info.powerShellExe, '')
  assert.equal(info.detected, true)
  assert.equal(info.workingDirectory, '/home/fixture')
  assert.equal(runtime.environmentScope.scope, 'ssh')
  assert.equal(runtime.environmentScope.hostId, 'web2term:fixture')
  assert.equal(prompts.size, platforms.CHAT_PLATFORMS.length)
  for (const parts of prompts.values()) {
    assert.ok(parts.basePrompt.includes('你是 Linux / POSIX 终端助手'))
    assert.ok(parts.basePrompt.includes('Ubuntu 26.04.1 LTS'))
    assert.ok(parts.basePrompt.includes('/usr/bin/bash'))
    assert.ok(parts.basePrompt.includes('/home/fixture'))
    assert.ok(parts.basePrompt.endsWith('directory-specific guidance'))
    assert.equal(parts.toolPrompt, '')
    for (const privateValue of ['Private device name', 'private-device-id', 'Private SSH name', 'private-ssh-address', 'C:\\Users\\desktop']) {
      assert.ok(!parts.prefix.includes(privateValue))
    }
  }
  assert.ok(events.some((event) => event.channel === types.IpcChannels.environmentChanged && event.payload.kind === 'posix'))
})

test('web2term results never inherit local macOS defaults either', async () => {
  const { runtime, prompts } = fixture({ desktop: 'darwin' })
  const info = await runtime.probeEnvironment()
  assert.equal(info.kind, 'posix')
  assert.equal(info.remoteName, 'Private device name')
  assert.equal(info.shellPath, '/usr/bin/bash')
  assert.equal(runtime.environmentScope.scope, 'ssh')
  for (const parts of prompts.values()) assert.ok(parts.basePrompt.includes('你是 Linux / POSIX 终端助手'))
})

test('SSH and local Windows/macOS probes keep their existing parsers and prompt dialects', async () => {
  const ssh = fixture({ transport: 'ssh' })
  assert.equal((await ssh.runtime.probeEnvironment()).remoteName, 'Private SSH name')
  assert.equal(ssh.runtime.environmentScope.hostId, 'ssh:fixture')
  const windows = fixture({ transport: 'local', output: JSON.stringify({ osCaption: 'Windows fixture', osVersion: '10.0',
    architecture: '64-bit', powerShellVersion: '5.1', workingDirectory: 'C:\\Users\\desktop' }) })
  assert.equal((await windows.runtime.probeEnvironment()).kind, 'windows')
  assert.equal(windows.runtime.environmentScope.scope, 'local')
  for (const parts of windows.prompts.values()) assert.ok(parts.basePrompt.includes('直接写 PowerShell'))
  const mac = fixture({ transport: 'local', desktop: 'darwin', output: 'OSCAP=macOS|OSVER=15.0|ARCH=arm64|SHELLP=/bin/zsh|SHELLV=5.9|CWD64=L1VzZXJzL2Rlc2t0b3A=' })
  assert.equal((await mac.runtime.probeEnvironment()).osCaption, 'macOS')
  assert.equal(mac.runtime.environment.workingDirectory, '/Users/desktop')
  for (const parts of mac.prompts.values()) assert.ok(parts.basePrompt.includes('你是 macOS 终端助手'))
})

test('closed web2term sessions do not probe or fall back to the local desktop', async () => {
  const { runtime, prompts, probeCalls } = fixture()
  runtime.web2term.alive = false
  const info = await runtime.probeEnvironment()
  assert.equal(probeCalls(), 0)
  assert.equal(info.kind, 'posix')
  assert.equal(prompts.size, 0)
})

test('failed or retired probes cannot overwrite the current environment or prompts', async () => {
  for (const flag of ['rejected', 'interrupted', 'timedOut', 'sessionLost']) {
    const { runtime, prompts } = fixture({ flags: { [flag]: true } })
    await runtime.probeEnvironment()
    assert.equal(runtime.environment.osCaption, 'Linux')
    assert.equal(prompts.size, 0)
  }
  const { runtime, prompts } = fixture()
  let finish
  runtime.runner.runEnvironmentProbe = () => new Promise((resolve) => { finish = resolve })
  const pending = runtime.probeEnvironment()
  runtime.web2term.alive = false
  finish({ kind: 'posix', result: result(REPORT) })
  await pending
  assert.equal(runtime.environment.osCaption, 'Linux')
  assert.equal(prompts.size, 0)
})
