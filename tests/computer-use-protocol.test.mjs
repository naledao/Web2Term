import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/computer-use-protocol.test.mjs
// Real protocol factory, coordinator, dispatcher, progression and session entry; all IO is synthetic.
// No Electron, browser session, desktop, terminal process or network is started.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, structuredClone, AbortController, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name];
      if (name === '../shared/computer-actions') return load('../src/shared/computer-actions.ts')
      assert.ok(Object.hasOwn(dependencies, name), name)
      return dependencies[name]
    }
  })
  return exports
}
const protocol = load('../src/shared/computer-use-protocol.ts')
const shared = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const taskData = load('../src/shared/autonomous-task.ts')
const crypto = { 'node:crypto': { createHash, randomUUID } }
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', crypto)
const { TaskProgression } = load('../src/main/task-progression.ts', crypto)
const { ComputerUseTool } = load('../src/main/computer-use-tool.ts', { '../shared/computer-use': shared })
const token = 'cu_' + 'a'.repeat(32)
const definitions = [
  { action: 'observe', description: 'Synthetic observation', parameters: [], example: {} },
  { action: 'click', description: 'Synthetic bounded input', locatorAlternatives: [['element_id'], ['x', 'y']], parameters: [
    { name: 'window_id', type: 'string', required: true, description: 'Known window', minLength: 1, maxLength: 64 },
    { name: 'observation_id', type: 'string', required: true, description: 'Current observation', minLength: 1, maxLength: 64 },
    { name: 'element_id', type: 'string', required: false, description: 'Observed element', minLength: 1, maxLength: 64 },
    { name: 'x', type: 'number', required: false, description: 'Image x', minimum: 0, maximum: 1920 },
    { name: 'y', type: 'number', required: false, description: 'Image y', minimum: 0, maximum: 1080 },
    { name: 'button', type: 'string', required: false, description: 'Button', enum: ['left', 'right'] }
  ], example: { window_id: 'window-A', observation_id: 'obs-A', element_id: 'element-A' } }
]
const envelope = (patch = {}) => ({ type: 'computer', version: 1, action: 'observe', step_token: token, description: '观察当前界面，确认下一步操作目标', ...patch })
const click = (patch = {}) => envelope({ action: 'click', window_id: 'window-A', observation_id: 'obs-A', element_id: 'element-A', ...patch })
const plain = value => JSON.parse(JSON.stringify(value))
const check = raw => protocol.computerUseProtocol.check(typeof raw === 'string' ? raw : JSON.stringify(raw), definitions)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('strict parsing yields one typed request and action parameters without protocol metadata', () => {
  const parsed = check(click())
  assert.equal(parsed.ok, true)
  assert.equal(parsed.stepToken, token)
  assert.deepEqual(plain(parsed.call), { action: 'click', description: envelope().description, parameters: {
    window_id: 'window-A', observation_id: 'obs-A', element_id: 'element-A'
  } })
  assert.equal(check(envelope()).ok, true)
})

test('description is required Chinese display metadata, bounded and stripped from executor parameters', () => {
  for (const description of [undefined, null, 1, '', '  ', 'click QQ', '中'.repeat(161), '点击\n联系人', '点击\u0000联系人']) {
    const result = check(click({ description }))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'invalid_description')
    assert.equal(result.error.field, 'description')
  }
  const result = check(click({ description: '  点击 QQ 联系人入口  ' }))
  assert.equal(result.ok, true)
  assert.equal(result.call.description, '点击 QQ 联系人入口')
  assert.equal(Object.hasOwn(result.call.parameters, 'description'), false)
  assert.equal(check(click({ description: '中'.repeat(160) })).ok, true)
})

test('decoded duplicate keys at every depth, unsafe object keys and malformed JSON are rejected', () => {
  const cases = [
    ['{"type":"computer","type":"command"}', 'duplicate_field'],
    [String.raw`{"type":"computer","ty\u0070e":"computer"}`, 'duplicate_field'],
    ['{"type":"computer","options":{"x":1,"x":2}}', 'duplicate_field'],
    ['{"type":"computer","options":[{"x":1,"x":2}]}', 'duplicate_field'],
    ['{"type":"computer","__proto__":{"polluted":true}}', 'unsafe_field'],
    ['{"type":"computer","options":{"constructor":{}}}', 'unsafe_field'],
    [JSON.stringify(envelope()).replace(/}$/, ',}'), 'invalid_json'],
    ['{"type":"computer","version":01}', 'invalid_json'],
    ['{"type":"computer","x":"bad\\q"}', 'invalid_json'],
    ['{"type":"computer","options":[1,]}', 'invalid_json'],
    [JSON.stringify(envelope()) + '\n' + JSON.stringify(envelope()), 'ambiguous_request']
  ]
  for (const [raw, expected] of cases) {
    const result = check(raw)
    assert.equal(result.ok, false, raw)
    assert.equal(result.error.code, expected, raw)
  }
  assert.equal({}.polluted, undefined)
})

test('only the current protocol envelope and registered actions are allowed', () => {
  const cases = [
    [envelope({ type: 'command' }), 'invalid_envelope'],
    [envelope({ version: '1' }), 'unsupported_version'],
    [envelope({ version: 2 }), 'unsupported_version'],
    [envelope({ action: 'run_script' }), 'unknown_action'],
    [envelope({ step_token: 'made-up' }), 'invalid_step_token'],
    [envelope({ step_token: null }), 'invalid_step_token'],
    [envelope({ command: 'must-not-run' }), 'ambiguous_request'],
    [envelope({ type: 'computer', questions: [] }), 'ambiguous_request'],
    [envelope({ read_files: {} }), 'ambiguous_request'],
    [envelope({ task_id: 'another-task' }), 'invalid_parameters'],
    [envelope({ permissions: ['anything'] }), 'invalid_parameters']
  ]
  for (const [raw, expected] of cases) {
    const result = check(raw)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, expected)
  }
  assert.equal(check([envelope()]).ok, false)
  assert.equal(check('```json\n' + JSON.stringify(envelope()) + '\n```').ok, false, 'main never repairs transport JSON')
})

test('parameter bounds, enums and mutually exclusive complete locator groups are enforced', () => {
  const coordinates = { ...click(), x: 0, y: 1080 }
  delete coordinates.element_id
  assert.equal(check(coordinates).ok, true)
  for (const request of [click({ x: 10, y: 10 }), { ...coordinates, x: -1 }, { ...coordinates, y: 1081 },
    { ...coordinates, x: '10' }, click({ window_id: '' }), click({ window_id: 'x'.repeat(65) }), click({ button: 'middle' }),
    click({ extra: true }), { ...coordinates, y: undefined }, { ...coordinates, x: undefined, y: undefined }]) {
    const result = check(request)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'invalid_parameters')
  }
})

test('invalid parameters name the offending fields and list the accepted ones', () => {
  const coordinates = { ...click(), x: 0, y: 1080 }
  delete coordinates.element_id
  const unknown = check({ ...coordinates, scroll_amount: 778 })
  assert.equal(unknown.error.code, 'invalid_parameters'); assert.equal(unknown.error.field, 'scroll_amount')
  assert.match(unknown.error.message, /未知字段 scroll_amount/); assert.match(unknown.error.message, /可用参数：/)
  const range = check({ ...coordinates, x: -1 })
  assert.equal(range.error.field, 'x'); assert.match(range.error.message, /x 应为/)
  assert.match(check(click({ x: 10, y: 10 })).error.message, /定位方式须且只能完整使用一组/)
})

test('unbounded or precision-losing inputs fail before any executor can see them', () => {
  const cases = [
    ['{"type":"computer","x":1e309}', 'invalid_parameters'],
    ['{"type":"computer","x":9007199254740993}', 'invalid_parameters'],
    [JSON.stringify(envelope({ text: 'x'.repeat(33_000) })), 'limit_exceeded'],
    [' '.repeat(64_001), 'limit_exceeded'],
    ['{"type":"computer","options":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}', 'limit_exceeded'],
    [JSON.stringify(envelope({ options: Array(257).fill(1) })), 'limit_exceeded']
  ]
  for (const [raw, expected] of cases) {
    const result = check(raw)
    assert.equal(result.ok, false)
    // Whitespace-only data is empty JSON before length checking, also safely rejected.
    assert.equal(result.error.code, raw.trim() ? expected : 'invalid_json')
  }
})

test('the exact shipped factory remains self-contained when injected in a page JS realm', () => {
  const browser = new Script('(' + protocol.createComputerUseProtocol.toString() + ')()').runInNewContext()
  const corpus = [JSON.stringify(click()), JSON.stringify(click({ x: 1 })), '{"type":"computer","type":"computer"}',
    JSON.stringify(envelope({ version: 9 }))]
  for (const raw of corpus) assert.deepEqual(plain(browser.check(raw, definitions)), plain(check(raw)))
})

test('registered constraints survive normalization and invalid registrations cannot become model capabilities', () => {
  const normalized = shared.normalizeComputerUseActionDefinition(definitions[1])
  assert.deepEqual(plain(normalized.locatorAlternatives), [['element_id'], ['x', 'y']])
  assert.equal(normalized.parameters.find(item => item.name === 'x').maximum, 1920)
  const prompt = shared.computerUseCapabilityPrompt(shared.resolveComputerUseCapability(
    { computerUseEnabled: true, desktopControlEnabled: true },
    { sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }, definitions), token)
  assert.match(prompt, /≤1920/)
  assert.match(prompt, /定位二选一/)
  assert.equal(JSON.parse(prompt.match(/```json\n([^]*?)\n```/)[1]).step_token, token)
  for (const bad of [
    { ...definitions[1], locatorAlternatives: [['element_id'], ['element_id', 'x']] },
    { ...definitions[1], locatorAlternatives: [['missing'], ['x', 'y']] },
    { ...definitions[1], parameters: definitions[1].parameters.map(item => item.name === 'x' ? { ...item, minimum: 2000 } : item) },
    { ...definitions[1], example: { ...definitions[1].example, x: 1 } }
  ]) assert.equal(shared.normalizeComputerUseActionDefinition(bad), null)
})

const runtimeSource = ts.createSourceFile('session-runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const declaration = runtimeSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const methods = ['receiveComputerUseRequest', 'advanceComputerUse', 'syncAutonomousTask'].map(name => {
  const method = declaration.members.find(node => node.name?.getText(runtimeSource) === name)
  assert.ok(method, name)
  return method.getText(runtimeSource)
}).join('\n')
const Runtime = new Script(compile(`class Actual { ${methods} }; Actual`)).runInNewContext({
  computerUseProtocol: protocol.computerUseProtocol, console: { warn() {} }
})

function fixture(options = {}) {
  const records = new Map(), snapshots = [], executions = [], sends = [], timers = []
  let loop, runtime, humanSerial = 0, messageSerial = 0, paused = false
  const store = {
    autonomousTaskGeneration: () => Math.max(0, ...[...records.values()].map(task => task.generation)),
    autonomousTaskBySubmission: (_s, _p, id) => [...records.values()].find(task => task.sourceSubmissionId === id) ?? null,
    latestAutonomousTask: (_s, _p, id) => [...records.values()].filter(task => task.conversationId === id).sort((a, b) => b.generation - a.generation)[0] ?? null,
    saveAutonomousTasks(tasks) {
      for (const task of tasks) {
        options.beforeSave?.(task)
        const parsed = taskData.parseAutonomousTask(JSON.stringify(task))
        assert.ok(parsed, 'all persisted progress must remain readable')
        records.set(task.id, parsed)
        snapshots.push(parsed)
      }
    }
  }
  const coordinator = new TaskCoordinator('session-A', store, () => loop?.reconcile())
  const tool = new ComputerUseTool()
  for (const definition of options.unavailable ? [] : definitions) tool.register(definition, {
    validate(parameters) {
      if (parameters.observation_id && parameters.observation_id !== 'obs-A') return '观察已失效，未执行。'
      return null
    },
    async execute(parameters, context) {
      executions.push({ action: definition.action, parameters, context })
      return options.execute ? options.execute(parameters, context) : { message: 'Synthetic real executor returned', data: { observation_id: 'obs-A' } }
    }
  })
  const capability = () => shared.resolveComputerUseCapability({ computerUseEnabled: true, desktopControlEnabled: true }, {
    sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local'
  }, tool.definitions())
  const submit = () => coordinator.submit({ platformId: 'deepseek', conversationId: 'chat-A', submission: { id: `user:fixture:${++humanSerial}`, kind: 'goal' },
    text: '检查报表。', attachments: [], capability: capability(),
    machine: { id: 'machine-A', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\reports' } })
  const firstToken = coordinator.computerStepToken('deepseek')
  const first = submit()
  const entry = { conversationId: 'chat-A', platform: { conversationIdFromPath: path => /^\/a\/chat\/s\/([^/]+)$/.exec(path)?.[1] ?? null },
    embed: { getState: () => ({ conversationId: 'chat-A' }) } }
  runtime = Object.assign(new Runtime(), { id: 'session-A', active: true, disposed: false, activePlatformId: 'deepseek',
    taskCoordinator: coordinator, getComputerUseCapability: capability, embeds: new Map([['deepseek', entry]]) })
  loop = new TaskProgression({ coordinator,
    isCurrent: lease => runtime.active && !runtime.disposed && coordinator.owns(lease), canRun: () => !paused,
    invoke: (call, lease, signal) => tool.invoke(call, { capability, isCurrent: () => coordinator.owns(lease) && runtime.active, signal }),
    async send(text, lease, signal) {
      const result = JSON.parse(text)
      sends.push({ text, result, lease, signal })
      assert.equal(coordinator.current('deepseek').progress.currentStep.delivery, 'sending')
      assert.equal(coordinator.computerStepToken('deepseek'), null, 'the next token is not active before send acknowledgement')
      return options.send ? options.send(result, lease, signal) : 'ok'
    },
    schedule(callback) { const timer = { active: true, callback }; timers.push(timer); return () => { timer.active = false } },
    onError: lease => coordinator.fail(lease.platformId, lease.conversationId)
  })
  runtime.taskProgression = loop
  const pageRequest = (raw, patch = {}) => ({ messageId: `computer:fixture:${++messageSerial}`,
    sourceSubmissionId: coordinator.current('deepseek')?.sourceSubmissionId ?? first.sourceSubmissionId,
    taskPromptGeneration: 3, pagePath: '/a/chat/s/chat-A', outcome: 'candidate', issue: null,
    rawJson: raw ?? JSON.stringify(envelope({ step_token: coordinator.computerStepToken('deepseek') })), ...patch })
  return { coordinator, loop, runtime, first, firstToken, tool, capability, submit, executions, sends, snapshots, records, timers,
    pageRequest, receive: request => runtime.receiveComputerUseRequest('deepseek', request),
    progress: () => coordinator.current('deepseek')?.progress,
    lease: () => { const task = coordinator.current('deepseek'); return { taskId: task.id, generation: task.generation, sessionId: task.sessionId, platformId: task.platformId, conversationId: task.conversationId } },
    pause(value) { paused = value },
    async flush() { await loop.wake() },
    async retry() {
      const timer = timers.find(item => item.active); assert.ok(timer); timer.active = false; timer.callback(); await loop.wake()
    }
  }
}

test('the pre-send token binds to the confirmed goal, is consumed once, and rotates only after delivery', async () => {
  const f = fixture()
  assert.equal(f.coordinator.computerStepToken('deepseek'), f.firstToken)
  const request = f.pageRequest()
  assert.equal(f.receive(request), true)
  await f.flush()
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends.length, 1)
  const result = f.sends[0].result
  assert.equal(f.progress().currentStep.description, envelope().description)
  assert.equal(f.snapshots.at(-1).progress.currentStep.description, envelope().description)
  assert.equal(Object.hasOwn(f.executions[0].parameters, 'description'), false)
  assert.equal(result.execution, 'executed')
  assert.equal(result.task_id, f.first.id)
  assert.notEqual(result.next_step_token, f.firstToken)
  assert.equal(f.coordinator.computerStepToken('deepseek'), result.next_step_token)
  assert.equal(f.coordinator.isComputerStepToken(f.lease(), f.firstToken), false)
  assert.equal(f.receive(request), true, 'duplicate delivery is acknowledged without executing again')
  await f.flush()
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends.length, 1)
})

test('a replay with a different transport ID is acknowledged without executing or sending stale-token feedback', async () => {
  const f = fixture(), original = f.pageRequest()
  f.receive(original); await f.flush()
  const token = f.coordinator.computerStepToken('deepseek')
  assert.equal(f.receive({ ...original, messageId: 'computer:remount:99' }), true)
  await f.flush(); assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 1)
  assert.equal(f.coordinator.computerStepToken('deepseek'), token)
  f.receive(f.pageRequest()); await f.flush(); assert.equal(f.executions.length, 2)
})

test('main rejects forged page validity and sends a not-executed error that the model can correct', async () => {
  const f = fixture()
  const duplicate = JSON.stringify(envelope({ step_token: f.firstToken })).replace(/}$/, ',"action":"click"}')
  f.receive(f.pageRequest(duplicate, { outcome: 'candidate' }))
  await f.flush()
  assert.equal(f.executions.length, 0)
  assert.equal(f.sends[0].result.code, 'duplicate_field')
  assert.equal(f.sends[0].result.execution, 'not_executed')
  const next = f.sends[0].result.next_step_token
  f.receive(f.pageRequest(JSON.stringify(envelope({ step_token: next }))))
  await f.flush()
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends[1].result.ok, true)
  assert.equal(f.progress().stepCount, 2)
})

test('missing description returns corrective feedback without executing the action', async () => {
  const f = fixture()
  f.receive(f.pageRequest(JSON.stringify(envelope({ step_token: f.firstToken, description: undefined }))))
  await f.flush()
  assert.equal(f.executions.length, 0)
  assert.equal(f.sends[0].result.code, 'invalid_description')
  assert.equal(f.sends[0].result.execution, 'not_executed')
  f.receive(f.pageRequest(JSON.stringify(envelope({ step_token: f.sends[0].result.next_step_token }))))
  await f.flush()
  assert.equal(f.executions.length, 1)
})

test('a consumed token in another response cannot replay its desktop action', async () => {
  const f = fixture()
  const raw = JSON.stringify(envelope({ step_token: f.firstToken }))
  f.receive(f.pageRequest(raw)); await f.flush()
  f.receive(f.pageRequest(raw)); await f.flush()
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends[1].result.code, 'stale_step_token')
  assert.equal(f.sends[1].result.execution, 'not_executed')
})

test('unknown actions, conflicting locators, bounds and the executor validator all fail before input', async () => {
  const f = fixture()
  const cases = [
    [() => envelope({ action: 'run_script' }), 'unknown_action'],
    [() => click({ x: 1, y: 2 }), 'invalid_parameters'],
    [() => { const request = click({ x: -1, y: 2 }); delete request.element_id; return request }, 'invalid_parameters'],
    [() => click({ observation_id: 'expired-observation' }), 'invalid_parameters']
  ]
  for (const [make, expected] of cases) {
    f.receive(f.pageRequest(JSON.stringify({ ...make(), step_token: f.coordinator.computerStepToken('deepseek') })))
    await f.flush()
    assert.equal(f.sends.at(-1).result.code, expected)
    assert.equal(f.sends.at(-1).result.execution, 'not_executed')
  }
  assert.equal(f.executions.length, 0)
})

test('a missing backend returns unavailable without registering pretend desktop actions', async () => {
  const f = fixture({ unavailable: true })
  f.receive(f.pageRequest()); await f.flush()
  assert.equal(f.sends[0].result.code, 'unavailable')
  assert.equal(f.sends[0].result.execution, 'not_executed')
  assert.equal(f.tool.definitions().length, 0)
  assert.equal(f.executions.length, 0)
})

test('a new goal invalidates the old source and token, and cross-task metadata cannot override ownership', async () => {
  const f = fixture(), old = f.pageRequest()
  const next = f.submit()
  assert.notEqual(f.coordinator.computerStepToken('deepseek'), f.firstToken)
  assert.equal(f.receive(old), false)
  f.receive(f.pageRequest(JSON.stringify(envelope({ step_token: f.firstToken })))); await f.flush()
  assert.equal(f.sends[0].result.code, 'stale_step_token')
  assert.equal(f.sends[0].result.task_id, next.id)
  f.receive(f.pageRequest(JSON.stringify(envelope({ step_token: f.coordinator.computerStepToken('deepseek'), task_id: f.first.id })))); await f.flush()
  assert.equal(f.sends[1].result.code, 'invalid_parameters')
  assert.equal(f.executions.length, 0)
})

test('busy delivery retries only the same result and token; uncertain delivery never activates the next token', async () => {
  const outcomes = ['busy', 'no-composer', 'ok']
  const f = fixture({ send: () => outcomes.shift() })
  f.receive(f.pageRequest()); await f.flush()
  await f.retry(); await f.retry()
  assert.equal(f.executions.length, 1)
  assert.equal(new Set(f.sends.map(item => item.text)).size, 1)
  assert.equal(f.coordinator.computerStepToken('deepseek'), f.sends[0].result.next_step_token)
  const g = fixture({ send: () => 'unknown' })
  g.receive(g.pageRequest()); await g.flush()
  const next = g.sends[0].result.next_step_token
  assert.equal(g.coordinator.computerStepToken('deepseek'), null)
  assert.equal(g.coordinator.isComputerStepToken(g.lease(), next, true), false)
  assert.equal(g.receive(g.pageRequest(JSON.stringify(envelope({ step_token: next })))), false)
  assert.equal(g.executions.length, 1)
  assert.equal(g.progress().phase, 'blocked')
})

test('a fast next request waits for acknowledgement before its pending token can execute', async () => {
  const ack = deferred(), started = deferred()
  let sends = 0
  const f = fixture({ send: () => { if (++sends > 1) return 'ok'; started.resolve(); return ack.promise } })
  f.receive(f.pageRequest()); await started.promise
  const next = f.sends[0].result.next_step_token
  assert.equal(f.coordinator.computerStepToken('deepseek'), null)
  assert.equal(f.receive(f.pageRequest(JSON.stringify(envelope({ step_token: next })))), true)
  assert.equal(f.executions.length, 1)
  ack.resolve('ok'); await f.flush(); await f.flush()
  assert.equal(f.executions.length, 2)
  assert.equal(f.sends.length, 2)
})

test('a late acknowledgement from a superseded task cannot activate a grant in the new goal', async () => {
  const ack = deferred(), started = deferred()
  const f = fixture({ send: () => { started.resolve(); return ack.promise } })
  const oldLease = f.lease()
  f.receive(f.pageRequest()); await started.promise
  const oldNext = f.sends[0].result.next_step_token
  const nextGoal = f.submit()
  const current = f.coordinator.computerStepToken('deepseek')
  assert.equal(f.sends[0].signal.aborted, true)
  ack.resolve('ok'); await f.flush()
  assert.equal(f.coordinator.current('deepseek').id, nextGoal.id)
  assert.equal(f.coordinator.computerStepToken('deepseek'), current)
  assert.equal(f.coordinator.isComputerStepToken(oldLease, oldNext), false)
  assert.equal(f.progress().stepCount, 0)
})

test('a page-reported truncation cannot turn a valid prefix into executable input', async () => {
  const f = fixture()
  f.receive(f.pageRequest(undefined, { outcome: 'invalid', issue: 'oversized-request' })); await f.flush()
  assert.equal(f.executions.length, 0)
  assert.equal(f.sends[0].result.code, 'limit_exceeded')
  assert.equal(f.sends[0].result.execution, 'not_executed')
})

test('pause and storage failure keep actions from running before their reservation is safe', async () => {
  const f = fixture()
  f.pause(true); f.receive(f.pageRequest()); await f.flush()
  assert.equal(f.executions.length, 0)
  f.pause(false); await f.flush()
  assert.equal(f.executions.length, 1)
  const g = fixture({ beforeSave(task) { if (task.progress?.phase === 'waiting-tool') throw new Error('disk full') } })
  assert.equal(g.receive(g.pageRequest()), false)
  await g.flush()
  assert.equal(g.executions.length, 0)
  assert.equal(g.sends.length, 0)
})

test('interrupting an action and restoring history revoke its grants and discard its late result', async () => {
  const output = deferred(), f = fixture({ execute: () => output.promise })
  const lease = f.lease()
  f.receive(f.pageRequest())
  f.coordinator.stop('deepseek', 'interrupted')
  assert.equal(f.executions[0].context.signal.aborted, true)
  output.resolve({ message: 'late' }); await f.flush()
  assert.equal(f.sends.length, 0)
  assert.equal(f.coordinator.isComputerStepToken(lease, f.firstToken), false)
  const restored = new TaskCoordinator('session-A', {
    autonomousTaskGeneration: () => 1, autonomousTaskBySubmission: () => null,
    latestAutonomousTask: () => f.records.get(f.first.id), saveAutonomousTasks() {}
  }, () => {})
  const history = restored.context('deepseek', 'chat-A')
  assert.equal(history.task.status, 'interrupted')
  assert.equal(restored.isComputerStepToken(lease, f.firstToken), false)
  assert.equal(restored.isComputerStepToken(lease, history.task.progress.currentStep.nextStepToken), false)
})
