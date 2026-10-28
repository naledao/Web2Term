import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/computer-use-tool.test.mjs
// Actual tool definitions, registry and runtime methods with fake executors.
// No Electron, native helper, desktop input, shell, browser, user data or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, structuredClone, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name];
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return exports
}
const protocol = load('../src/shared/computer-use-protocol.ts')
const shared = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const { ComputerUseTool, throwIfDesktopInterrupted } = load('../src/main/computer-use-tool.ts', { '../shared/computer-use': shared })
const { DesktopCoordinator } = load('../src/main/desktop-coordinator.ts')
const files = load('../src/shared/file-requests.ts')
const background = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': background })
const toolPrompts = load('../src/shared/tool-prompts.ts', { './types': types })
const preferences = { computerUseEnabled: true, desktopControlEnabled: true }
const local = { sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }
const definition = () => ({ action: 'observe', description: '取得已定位窗口的观察结果',
  parameters: [{ name: 'window_id', type: 'string', description: '从实际发现结果取得的窗口引用', required: true }],
  example: { window_id: 'window:example' } })
const plain = value => JSON.parse(JSON.stringify(value))
test('desktop interruptions retain execution facts and never publish unvalidated native payloads', () => {
  for (const code of ['external_input', 'human_paused', 'input_monitor_unavailable']) for (const execution of ['not_executed', 'executed', 'unknown']) {
    assert.throws(() => throwIfDesktopInterrupted({ ok: false, code, execution, message: 'Actual receipt', data: { unvalidated: true } }), error => {
      assert.equal(error.result.code, code); assert.equal(error.result.execution, execution)
      assert.deepEqual(plain(error.result.data), { helper_code: code }); return true
    })
  }
  assert.doesNotThrow(() => throwIfDesktopInterrupted({ ok: true, code: 'ok', execution: 'executed', message: '' }))
})
function fixture({ validate = () => null, execute = async parameters => ({ message: '执行器已返回观察', data: parameters }) } = {}) {
  let active = true, saved = { ...preferences }, target = { ...local }, executions = 0, changes = 0
  const tool = new ComputerUseTool(() => { changes++ })
  const context = {
    capability: () => shared.resolveComputerUseCapability(saved, target, tool.definitions()),
    isCurrent: () => active
  }
  const unregister = tool.register(definition(), { validate, execute: async (...args) => { executions++; return execute(...args) } })
  return { tool, context, unregister, invoke: (parameters = { window_id: 'window:real' }, action = 'observe', extra = {}) =>
    tool.invoke({ action, parameters }, { ...context, ...extra }),
    setActive(value) { active = value }, setPreferences(value) { saved = value }, setTarget(value) { target = { ...local, ...value } },
    executions: () => executions, changes: () => changes }
}

test('desktop dispatcher requires a live main-issued permit for the exact task and operation kind', async () => {
  const coordinator = new DesktopCoordinator(), tool = new ComputerUseTool(() => {}, coordinator)
  let executions = 0, keep = true
  tool.register(definition(), { validate: () => null, execute: async () => { executions++; return { message: 'Synthetic observation' } } })
  const lease = { sessionId: local.sessionId, platformId: local.platformId, conversationId: 'chat-a', taskId: 'task-a', generation: 1 }
  const context = { lease, capability: () => shared.resolveComputerUseCapability(preferences, local, tool.definitions()), isCurrent: () => true }
  const call = { action: 'observe', parameters: { window_id: 'window:real' } }
  for (const desktopPermit of [undefined, { release() {} }]) {
    const result = await tool.invoke(call, { ...context, desktopPermit })
    assert.equal(result.execution, 'not_executed'); assert.equal(result.code, 'inactive_context')
  }
  const request = kind => coordinator.acquire({ owner: { ...lease, machineId: 'machine-a' }, kind, signal: new AbortController().signal,
    current: () => true, eligible: () => true, keep: () => keep })
  const desktopPermit = await request('desktop')
  assert.equal((await tool.invoke(call, { ...context, lease: { ...lease, generation: 2 }, desktopPermit })).execution, 'not_executed')
  assert.equal((await tool.invoke(call, { ...context, desktopPermit })).execution, 'executed')
  desktopPermit.release()
  assert.equal((await tool.invoke(call, { ...context, desktopPermit })).execution, 'not_executed')
  const commandPermit = await request('command')
  assert.equal((await tool.invoke(call, { ...context, desktopPermit: commandPermit })).execution, 'not_executed')
  assert.equal(executions, 1)
  commandPermit.release(); keep = false; coordinator.reconcile(); coordinator.dispose()
})

test('only registered actions become available and capability snapshots do not expose mutable registry data', () => {
  const tool = new ComputerUseTool()
  assert.equal(shared.resolveComputerUseCapability(preferences, local, tool.definitions()).available, false)
  const original = definition()
  const unregister = tool.register(original, { validate: () => null, execute: async () => ({ message: 'observed' }) })
  original.description = 'tampered'
  original.example.window_id = 'tampered'
  const capability = shared.resolveComputerUseCapability(preferences, local, tool.definitions())
  assert.equal(capability.available, true)
  assert.equal(capability.reason, 'ready')
  assert.deepEqual(plain(capability.actions), ['observe'])
  assert.notEqual(capability.actionDefinitions[0].description, 'tampered')
  capability.actionDefinitions[0].example.window_id = 'tampered-again'
  assert.equal(tool.definitions()[0].example.window_id, 'window:example')
  unregister()
  assert.equal(tool.definitions().length, 0)
  assert.equal(shared.resolveComputerUseCapability(preferences, local, tool.definitions()).available, false)
})

test('disabled, remote, unsupported sites and unsupported hosts do not publish registered desktop actions', () => {
  const f = fixture()
  for (const context of [{ connection: 'ssh' }, { connection: 'web2term' }, { platformId: 'claude' },
    { hostPlatform: 'darwin' }, { hostArch: 'arm64' }, { sessionId: null, connection: 'none' }]) {
    const capability = shared.resolveComputerUseCapability(preferences, { ...local, ...context }, f.tool.definitions())
    assert.equal(capability.available, false)
    assert.equal(capability.actions.length, 0)
    assert.equal(capability.actionDefinitions.length, 0)
  }
  for (const saved of [{}, { computerUseEnabled: true }, { desktopControlEnabled: true }]) {
    const capability = shared.resolveComputerUseCapability(saved, local, f.tool.definitions())
    assert.equal(capability.available, false)
    assert.equal(capability.actionDefinitions.length, 0)
  }
})

test('tool descriptions include actual parameters, request fields without examples and real result semantics', () => {
  const f = fixture()
  const declaration = shared.computerUseCapabilityPrompt(f.context.capability())
  assert.match(declaration, /用于发现、观察和操作本机业务应用/)
  assert.match(declaration, /命令、文件和后台任务继续使用对应工具/)
  assert.match(declaration, /window_id!?:string/)
  assert.match(declaration, /输入必须引用当前任务最新观察/)
  assert.match(declaration, /ok 不代表业务目标完成/)
  assert.match(declaration, /调用 complete_task/)
  assert.doesNotMatch(declaration, /当前没有可调用/)
  assert.match(declaration, /type="computer"、version=1、action、step_token 和 description/)
  assert.match(declaration, /action 使用当前可调用动作名/)
  assert.match(declaration, /observe：/)
  assert.match(declaration, /不得混入 command、read_files 或 questions/)
  assert.doesNotMatch(declaration, /```json|示例|例如|window:example/)
  const originalTools = types.toolPromptForPlatform('deepseek')
  const currentTools = types.toolPromptForPlatform('deepseek', true, declaration)
  const environment = { ...types.FALLBACK_ENVIRONMENT, extraNotes: '沿用项目约定。' }
  const baseline = types.buildTerminalPromptParts(environment, originalTools)
  const current = types.buildTerminalPromptParts(environment, currentTools)
  assert.equal(current.basePrompt, baseline.basePrompt)
  assert.equal(current.toolPrompt, originalTools + '\n\n' + declaration)
  assert.equal(current.prefix, baseline.prefix.replace(originalTools, () => currentTools))
  assert.doesNotMatch(current.toolPrompt, /task_plan|重新定义.*角色|自主规划助手/)
})

test('unavailable backends publish purpose and status without an executable computer example', () => {
  const capability = shared.resolveComputerUseCapability(preferences, local)
  const prompt = shared.computerUseCapabilityPrompt(capability)
  assert.match(prompt, /用于发现、观察和操作本机业务应用/)
  assert.match(prompt, /桌面执行器尚未接入/)
  assert.match(prompt, /不要输出 computer 工具请求/)
  assert.doesNotMatch(prompt, /```json|"type":"computer"/)
})

test('registrations need usable metadata, a matching example and a mandatory executor validator', () => {
  const tool = new ComputerUseTool()
  const handler = { validate: () => null, execute: async () => ({ message: 'ok' }) }
  const invalid = [
    { ...definition(), action: 'command' },
    { ...definition(), action: 'invalid-action' },
    { ...definition(), parameters: [...definition().parameters, ...definition().parameters] },
    { ...definition(), parameters: [{ name: 'command', type: 'string', description: 'no shell fallback', required: true }], example: { command: 'fake' } },
    { ...definition(), parameters: [{ name: 'step_token', type: 'string', description: 'reserved', required: true }], example: { step_token: 'fake' } },
    { ...definition(), example: {} },
    { ...definition(), example: { window_id: 123 } }
  ]
  for (const item of invalid) assert.throws(() => tool.register(item, handler), /invalid-computer-use-registration/)
  assert.throws(() => tool.register(definition(), { execute: handler.execute }), /invalid-computer-use-registration/)
  assert.equal(tool.definitions().length, 0)
  tool.register(definition(), handler)
  assert.throws(() => tool.register(definition(), handler), /duplicate-computer-use-action/)
})

test('desktop calls use their registered executor and return structured tool results', async () => {
  const f = fixture()
  const output = await f.invoke()
  assert.equal(output.type, 'computer_result')
  assert.equal(output.version, 1)
  assert.equal(output.action, 'observe')
  assert.equal(output.ok, true)
  assert.equal(output.execution, 'executed')
  assert.equal(output.code, 'ok')
  assert.equal(output.data.window_id, 'window:real')
  assert.equal(f.executions(), 1)
})

test('unknown actions and command-shaped parameters are rejected without any execution', async () => {
  const f = fixture()
  assert.equal((await f.invoke({ command: 'never execute' }, 'command')).code, 'unknown_action')
  for (const parameters of [null, [], {}, { window_id: 42 }, { window_id: 'window:real', command: 'never execute' }]) {
    const output = await f.invoke(parameters)
    assert.equal(output.code, 'invalid_parameters')
    assert.equal(output.execution, 'not_executed')
  }
  assert.equal(f.executions(), 0)
})

test('action validation errors do not dispatch or convert the request to another tool', async () => {
  for (const validate of [() => '窗口引用已失效。', () => { throw new Error('invalid observation') }]) {
    const f = fixture({ validate })
    const output = await f.invoke()
    assert.equal(output.code, 'invalid_parameters')
    assert.equal(output.execution, 'not_executed')
    assert.equal(f.executions(), 0)
  }
})

test('live settings, connection, current context and cancellation are rechecked before execution', async () => {
  const f = fixture()
  f.setPreferences({ computerUseEnabled: false, desktopControlEnabled: true })
  assert.equal((await f.invoke()).code, 'unavailable')
  f.setPreferences(preferences)
  f.setTarget({ connection: 'ssh' })
  assert.equal((await f.invoke()).code, 'unavailable')
  f.setTarget({})
  f.setActive(false)
  assert.equal((await f.invoke()).code, 'inactive_context')
  f.setActive(true)
  const controller = new AbortController()
  controller.abort()
  assert.equal((await f.invoke(undefined, 'observe', { signal: controller.signal })).code, 'cancelled')
  assert.equal(f.executions(), 0)
})

test('a backend or task revoked during validation cannot execute', async () => {
  for (const revoke of [f => f.setActive(false), f => f.setPreferences({}), f => f.unregister()]) {
    let f
    f = fixture({ validate: () => { revoke(f); return null } })
    const output = await f.invoke()
    assert.equal(output.ok, false)
    assert.equal(output.execution, 'not_executed')
    assert.equal(f.executions(), 0)
  }
})

test('executor exceptions remain unknown and do not retry a possibly effective action', async () => {
  const f = fixture({ execute: async () => { throw new Error('input may already have been sent') } })
  const output = await f.invoke()
  assert.equal(output.ok, false)
  assert.equal(output.code, 'executor_error')
  assert.equal(output.execution, 'unknown')
  assert.equal(f.executions(), 1)
})

test('in-flight parameters are isolated and stale unregistration cannot remove a replacement', async () => {
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  const f = fixture({ execute: async parameters => { await gate; return { message: 'observed', data: parameters } } })
  const parameters = { window_id: 'window:original' }
  const running = f.invoke(parameters)
  parameters.window_id = 'window:tampered'
  finish()
  assert.equal((await running).data.window_id, 'window:original')
  f.unregister()
  f.tool.register(definition(), { validate: () => null, execute: async () => ({ message: 'replacement' }) })
  f.unregister()
  assert.equal(f.tool.definitions().length, 1)
  assert.equal((await f.invoke()).message, 'replacement')
  assert.equal(f.changes(), 3)
})

const source = ts.createSourceFile('session-runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const runtimeClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const runtimeMethods = ['getComputerUseCapability', 'invokeComputerUseTool', 'refreshComputerUseCapabilities', 'toolPrompt'].map(name => {
  const method = runtimeClass.members.find(node => node.name?.getText(source) === name)
  assert.ok(method, name)
  return method.getText(source)
}).join('\n')
const Runtime = new Script(compile(`class Runtime { ${runtimeMethods} }; Runtime`)).runInNewContext({
  process: { platform: 'win32', arch: 'x64' }, ...shared, IpcChannels: types.IpcChannels,
  toolCatalogPrompt: toolPrompts.toolCatalogPrompt, buildTerminalPromptParts: types.buildTerminalPromptParts
})

test('actual runtime refreshes only tool descriptions and dispatches with its live session scope', async () => {
  const prompts = new Map()
  let executions = 0
  const runtime = Object.assign(new Runtime(), {
    id: 'session-A', activePlatformId: 'deepseek', active: true, disposed: false, remoteShell: null, web2term: null,
    options: { settings: () => preferences }, ssh: { getState: () => ({ attached: false }) },
    environment: { ...types.FALLBACK_ENVIRONMENT }, stopAutonomousTask() {}, send() {},
    embeds: new Map(['deepseek', 'chatgpt'].map(id => [id, { platform: { id }, embed: { setPromptParts: parts => prompts.set(id, parts), setComputerUseRecognitionEnabled() {} } }]))
  })
  runtime.computerUseTool = new ComputerUseTool(() => runtime.refreshComputerUseCapabilities())
  const unregister = runtime.computerUseTool.register(definition(), {
    validate: () => null, execute: async () => { executions++; return { message: 'observed' } }
  })
  // Only the summary and step state are injected; the action list is sent when the AI reads the computer tool.
  assert.match(prompts.get('deepseek').toolPrompt, /- computer：[\s\S]*【computer use 状态】/)
  assert.doesNotMatch(prompts.get('deepseek').toolPrompt, /【computer 当前可调用动作与参数】/)
  assert.doesNotMatch(prompts.get('chatgpt').toolPrompt, /- computer：/)
  assert.equal(prompts.get('deepseek').basePrompt, types.buildTerminalPromptParts(runtime.environment).basePrompt)
  assert.equal((await runtime.invokeComputerUseTool({ action: 'observe', parameters: { window_id: 'window:real' } })).ok, true)
  runtime.remoteShell = { alive: true }
  assert.equal((await runtime.invokeComputerUseTool({ action: 'observe', parameters: { window_id: 'window:real' } })).code, 'unavailable')
  runtime.remoteShell = null
  runtime.disposed = true
  assert.equal((await runtime.invokeComputerUseTool({ action: 'observe', parameters: { window_id: 'window:real' } })).code, 'inactive_context')
  assert.equal(executions, 1)
  runtime.disposed = false
  unregister()
  assert.match(prompts.get('deepseek').toolPrompt, /当前没有可调用的 computer 桌面动作/)
})
