import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run: node --test tests/computer-use-capabilities.test.mjs
// Pure capability/settings functions and actual runtime methods with fake views.
// Does not launch Electron, a desktop helper, a shell, a browser, or any network request.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(relative, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(relative, import.meta.url), 'utf8')), { filename: relative })
    .runInNewContext({ exports, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name];
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected runtime dependency: ${name}`)
      return dependencies[name]
    } })
  return exports
}
const protocol = load('../src/shared/computer-use-protocol.ts')
const capability = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const persistence = load('../src/main/computer-use-settings.ts')
const files = load('../src/shared/file-requests.ts')
const background = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': background })
const enabled = { computerUseEnabled: true, desktopControlEnabled: true }
const local = { sessionId: 'task-session', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }
const resolve = (preferences = enabled, context = {}) => capability.resolveComputerUseCapability(preferences, { ...local, ...context })

test('saved intent never advertises a desktop driver or actions before they are implemented', () => {
  const state = resolve()
  assert.equal(state.scopeSupported, true)
  assert.equal(state.enabled, true)
  assert.equal(state.available, false)
  assert.equal(state.reason, 'runtime-not-ready')
  assert.equal(state.actions.length, 0)
  assert.match(state.message, /桌面执行器尚未接入/)
})

test('only DeepSeek on the Windows x64 local host is in scope', () => {
  for (const [context, reason] of [
    [{ platformId: 'chatgpt' }, 'unsupported-platform'],
    [{ platformId: 'claude' }, 'unsupported-platform'],
    [{ platformId: 'gemini' }, 'unsupported-platform'],
    [{ platformId: 'unknown' }, 'unsupported-platform'],
    [{ hostPlatform: 'darwin' }, 'unsupported-os'],
    [{ hostPlatform: 'linux' }, 'unsupported-os'],
    [{ hostArch: 'arm64' }, 'unsupported-arch'],
    [{ hostArch: 'ia32' }, 'unsupported-arch'],
    [{ connection: 'ssh' }, 'remote-session'],
    [{ connection: 'web2term' }, 'remote-session'],
    [{ connection: 'none', sessionId: null }, 'no-session']
  ]) {
    const state = resolve(enabled, context)
    assert.equal(state.scopeSupported, false, JSON.stringify(context))
    assert.equal(state.enabled, false)
    assert.equal(state.available, false)
    assert.equal(state.reason, reason)
    assert.equal(state.actions.length, 0)
  }
})

test('both preferences must be real booleans and neither turns the other on', () => {
  assert.equal(resolve({}).reason, 'computer-use-disabled')
  assert.equal(resolve({ computerUseEnabled: true }).reason, 'desktop-disabled')
  assert.equal(resolve({ desktopControlEnabled: true }).reason, 'computer-use-disabled')
  assert.equal(resolve({ computerUseEnabled: 'true', desktopControlEnabled: 1 }).enabled, false)
  assert.equal(resolve(enabled).reason, 'runtime-not-ready')
})

test('old settings default off; preferences round-trip and partial updates preserve the other flag', () => {
  const values = new Map([['theme', 'dark']])
  const store = { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => values.set(key, value) }
  assert.equal(persistence.readComputerUsePreferences(store).computerUseEnabled, false)
  assert.equal(persistence.readComputerUsePreferences(store).desktopControlEnabled, false)
  persistence.saveComputerUsePreferences(store, enabled)
  const reopened = { getSetting: key => new Map(values).get(key) ?? null }
  assert.equal(persistence.readComputerUsePreferences(reopened).desktopControlEnabled, true)
  persistence.saveComputerUsePreferences(store, { desktopControlEnabled: false, unrelated: true })
  const saved = persistence.readComputerUsePreferences(store)
  assert.equal(saved.computerUseEnabled, true)
  assert.equal(saved.desktopControlEnabled, false)
  assert.equal(values.get('theme'), 'dark')
  assert.equal(values.has('unrelated'), false)
})

test('an invalid flag rejects the whole preferences patch before any write', () => {
  const writes = []
  const store = { getSetting: () => null, setSetting: (...args) => writes.push(args) }
  for (const value of ['true', 1, null, {}, []]) {
    assert.throws(() => persistence.saveComputerUsePreferences(store, {
      computerUseEnabled: true, desktopControlEnabled: value
    }), /必须为布尔值/)
  }
  assert.equal(writes.length, 0)
  persistence.saveComputerUsePreferences(store, { desktopControlEnabled: undefined })
  assert.equal(writes.length, 0)
})

test('capability declarations preserve existing tools and never publish a computer action schema', () => {
  const previous = types.toolPromptForPlatform('deepseek')
  assert.equal(capability.computerUseCapabilityPrompt(resolve({})), '')
  const declaration = capability.computerUseCapabilityPrompt(resolve())
  const prompt = types.toolPromptForPlatform('deepseek', true, declaration)
  assert.ok(prompt.startsWith(previous))
  assert.match(prompt, /视觉理解能力已由用户确认/)
  assert.match(prompt, /不要输出 computer 工具请求/)
  assert.doesNotMatch(prompt, /"type"\s*:\s*"computer"/)
  const remote = types.toolPromptForPlatform('deepseek', false, capability.computerUseCapabilityPrompt(resolve(enabled, { connection: 'web2term' })))
  assert.doesNotMatch(remote, /【工具：read_files】/)
  assert.match(remote, /远程会话暂不提供本机桌面控制/)
  assert.equal(types.toolPromptForPlatform('unknown', true, declaration), '')
})

test('legacy saved enablement is retained until an explicit computer use setting replaces it', () => {
  const values = new Map([['autonomousExecutionEnabled', '1'], ['desktopControlEnabled', '1'], ['executionMode', 'manual']])
  const store = { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => values.set(key, value) }
  const restored = persistence.readComputerUsePreferences(store)
  assert.equal(restored.computerUseEnabled, true)
  assert.equal(restored.desktopControlEnabled, true)
  assert.equal(Object.hasOwn(restored, 'autonomousExecutionEnabled'), false)
  assert.equal(resolve(restored).enabled, true)
  persistence.saveComputerUsePreferences(store, { computerUseEnabled: false })
  assert.equal(persistence.readComputerUsePreferences(store).computerUseEnabled, false)
  assert.equal(values.get('computerUseEnabled'), '0')
  assert.equal(values.get('autonomousExecutionEnabled'), '1')
  assert.equal(values.get('executionMode'), 'manual')
  assert.equal(values.get('desktopControlEnabled'), '1')
  persistence.saveComputerUsePreferences(store, { computerUseEnabled: true })
  assert.equal(persistence.readComputerUsePreferences(store).computerUseEnabled, true)
  for (const legacy of ['0', 'true', '', null]) {
    assert.equal(persistence.readComputerUsePreferences({ getSetting: key => key === 'autonomousExecutionEnabled' ? legacy : null }).computerUseEnabled, false)
  }
})

test('computer use contributes only its tool declaration and leaves the existing system and tools intact', () => {
  const environment = { ...types.FALLBACK_ENVIRONMENT, extraNotes: '保持项目原有约定。' }
  const originalTools = types.toolPromptForPlatform('deepseek')
  const baseline = types.buildTerminalPromptParts(environment, originalTools)
  const declaration = capability.computerUseCapabilityPrompt(resolve())
  const currentTools = types.toolPromptForPlatform('deepseek', true, declaration)
  const current = types.buildTerminalPromptParts(environment, currentTools)
  assert.equal(current.basePrompt, baseline.basePrompt)
  assert.equal(current.toolPrompt, originalTools + '\n\n' + declaration)
  assert.equal(current.prefix, baseline.prefix.replace(originalTools, () => currentTools))
  assert.match(declaration, /【工具能力：computer use】/)
  assert.doesNotMatch(declaration, /AI 自主执行|自主规划|task_plan/)
})

const runtimeSource = ts.createSourceFile('session-runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const runtimeClass = runtimeSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const methods = ['getComputerUseCapability', 'refreshComputerUseCapabilities', 'toolPrompt'].map(name => {
  const method = runtimeClass.members.find(member => member.name?.getText(runtimeSource) === name)
  assert.ok(method, `Runtime method ${name} missing`)
  return method.getText(runtimeSource)
})
const runtimeExports = {}
new Script(compile(`class RuntimeFixture { ${methods.join('\n')} }\nexports.RuntimeFixture = RuntimeFixture`))
  .runInNewContext({ exports: runtimeExports, process: { platform: 'win32', arch: 'x64' },
    ...capability, IpcChannels: types.IpcChannels, toolPromptForPlatform: types.toolPromptForPlatform, buildTerminalPromptParts: types.buildTerminalPromptParts })

test('runtime uses the live connection and refreshes cached platform prompts without executing work', () => {
  let preferences = enabled
  let attached = false
  const prompts = new Map()
  const runtime = Object.assign(new runtimeExports.RuntimeFixture(), {
    id: 'task-session', activePlatformId: 'deepseek', disposed: false, remoteShell: null, web2term: null,
    environment: { ...types.FALLBACK_ENVIRONMENT, kind: 'posix', osCaption: 'Remote Linux' },
    options: { settings: () => preferences }, ssh: { getState: () => ({ attached }) },
    computerUseTool: { definitions: () => [] },
    stopAutonomousTask() {}, send() {},
    embeds: new Map(['deepseek', 'chatgpt'].map(id => [id, {
      platform: { id }, embed: { setPromptParts: parts => prompts.set(id, parts), setComputerUseRecognitionEnabled() {} }
    }]))
  })
  assert.equal(runtime.getComputerUseCapability().scopeSupported, true)
  attached = true
  assert.equal(runtime.getComputerUseCapability().reason, 'remote-session')
  attached = false
  runtime.remoteShell = { alive: false }
  assert.equal(runtime.getComputerUseCapability().reason, 'remote-session')
  runtime.remoteShell = null
  runtime.web2term = { alive: false }
  assert.equal(runtime.getComputerUseCapability().reason, 'remote-session')
  runtime.web2term = null
  runtime.refreshComputerUseCapabilities()
  assert.match(prompts.get('deepseek').toolPrompt, /桌面执行器尚未接入/)
  assert.match(prompts.get('chatgpt').toolPrompt, /首版仅适配 DeepSeek/)
  preferences = { computerUseEnabled: false, desktopControlEnabled: false }
  runtime.refreshComputerUseCapabilities()
  assert.doesNotMatch(prompts.get('deepseek').toolPrompt, /【工具能力：computer use】/)
  prompts.clear()
  runtime.disposed = true
  runtime.refreshComputerUseCapabilities()
  assert.equal(prompts.size, 0)
})

test('computer result delay is saved as whole seconds within 0–600', () => {
  const values = new Map()
  const store = { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => values.set(key, value) }
  assert.throws(() => persistence.saveComputerUsePreferences(store, { computerResultDelaySeconds: 1.5 }), /回传间隔/)
  assert.throws(() => persistence.saveComputerUsePreferences(store, { computerResultDelaySeconds: 601 }), /回传间隔/)
  assert.throws(() => persistence.saveComputerUsePreferences(store, { computerResultDelaySeconds: '5' }), /回传间隔/)
  assert.equal(values.size, 0)
  persistence.saveComputerUsePreferences(store, { computerResultDelaySeconds: 5 })
  assert.equal(persistence.readComputerUsePreferences(store).computerResultDelaySeconds, 5)
  assert.equal(persistence.readComputerUsePreferences({ getSetting: () => null }).computerResultDelaySeconds, undefined)
  assert.equal(capability.normalizeComputerUsePreferences({ computerResultDelaySeconds: '9999' }).computerResultDelaySeconds, 600)
})

test('user sends wait for the Windows helper only while computer use is on', () => {
  const helper = (phase, code, message = 'Windows helper 握手超时，已停止本次进程。') =>
    ({ phase, code, message, generation: 1, pid: null, protocolVersion: null, actions: [] })
  const block = (preferences, state, context) => capability.computerUseSendBlock(
    capability.resolveComputerUseCapability(preferences, { ...local, ...context }, [], state))
  assert.match(block(enabled, helper('starting', 'starting')), /正在启动/)
  assert.match(block(enabled, helper('stopped', 'not_started')), /正在启动/)
  const failed = block(enabled, helper('error', 'handshake_timeout'))
  assert.match(failed, /握手超时/)
  assert.match(failed, /关闭 computer use/)
  assert.equal(block(enabled, { ...helper('ready', 'ready'), actions: ['observe'] }), null)
  assert.equal(block({ computerUseEnabled: false, desktopControlEnabled: true }, helper('starting', 'starting')), null)
  assert.equal(block(enabled, helper('starting', 'starting'), { platformId: 'chatgpt' }), null)
  assert.equal(block(enabled, undefined), null, 'no helper manager means nothing to wait for')
})
