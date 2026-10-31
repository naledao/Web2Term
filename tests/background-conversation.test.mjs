// User-run only: node --test tests/background-conversation.test.mjs
// Actual runtime methods with synthetic owners, sends and callbacks. No Electron, UI or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const names = ['canRunConversationInBackground', 'setActive', 'scheduledTaskReady', 'scheduledOwnerCurrent', 'sendScheduledTask',
  'mailNotificationCurrent', 'toolPromptReadCurrent', 'embedHandlers', 'refreshRemoteRipgrep']
const body = names.map(name => cls.members.find(node => node.name?.getText(source) === name).getText(source)).join('\n')
const Runtime = new Script(ts.transpileModule(`class Runtime { ${body} }; Runtime`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText).runInNewContext({ AbortController, Date, console, process: { platform: 'win32', arch: 'x64' },
  taskPausedByInput: task => task?.paused === true, computerUseSendBlock: () => null,
  sameScheduledTarget: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  supportsFocusView: () => false, writeFocusDiagnostic() {} })

function fixture() {
  const owner = { sessionId: 'workspace-a', platformId: 'chatgpt', conversationId: 'chat-a' }
  const target = { machineId: 'machine-a', transport: 'ssh', key: 'host-a', cwd: '/root', label: 'SSH' }
  const task = { id: 'plan-a', owner, target, revision: 1, enabled: true, deleted: false, prompt: '检查仓库变化' }
  const run = { id: 'run-a', kind: 'task', plannedAt: 10000, missedSince: null }
  const state = { conversationId: owner.conversationId, desktop: false, paused: false, human: false, interrupted: 0, wakes: 0, submissions: 0 }
  const cancellations = [], turns = [], sent = [], notes = []
  const embed = { getState: () => ({ conversationId: state.conversationId }), getComputerUsePageEpoch: () => 'page-a',
    getInterceptorStatus: () => ({ enabled: true, installed: true, promptInjectionEnabled: true, pendingQuestion: null }) }
  const runtime = Object.assign(new Runtime(), { id: owner.sessionId, active: true, activePlatformId: owner.platformId,
    disposed: false, taskEnded: false, stoppingTask: false, focusSending: false, environment: {}, embed,
    lastSubmissions: new Map([[owner.platformId, 'user:first']]),
    embeds: new Map([[owner.platformId, { conversationId: owner.conversationId, embed }]]),
    getComputerUseCapability: () => ({ scopeSupported: state.desktop, computerUseEnabled: true }),
    scheduledTarget: () => target, toolPreferences: () => ({ scheduledTasksEnabled: true, mailNotificationsEnabled: true }),
    options: { localMachineId: target.machineId, scheduledTasks: { wake: () => { state.wakes++ }, store: { get: () => task } },
      desktopCoordinator: { getState: () => ({ humanControl: state.human }), canReleaseHumanControl: () => !state.human } },
    runner: { getAutomation: () => ({ paused: state.paused }), hasInFlightWork: () => false, getTerminalState: () => ({ cwd: '/root' }) },
    taskCoordinator: { latest: () => null, waitingForUser: () => false, context: () => ({ task: null }),
      submit(input) { state.submissions++; assert.equal(input.capability.scopeSupported, false); return null } },
    focusChat: { begin(_platform, _conversation, text) { turns.push(text); return 'turn-a' } },
    mailNotifications: { busy: false, cancel: () => cancellations.push('mail') },
    toolPromptReads: { busy: false, cancel: () => cancellations.push('tools') },
    scheduledTaskTools: { busy: false, cancel: () => cancellations.push('plans') }, backgroundTaskResults: { isSending: false },
    syncWindowsHelperDemand() {}, applyVisibility() {}, interruptTaskControl() { state.interrupted++ },
    taskProgression: { reconcile() {}, wake: async () => {} } })
  embed.sendScheduledUser = async (text, conversationId, runId, signal, current) => {
    assert.equal(current(), true)
    sent.push({ text, conversationId, runId })
    assert.equal(signal.aborted, false)
    const intake = runtime.embedHandlers({ id: owner.platformId }).onUserStarted
    assert.equal(intake(text, [], undefined, { id: 'user:scheduled:' + runId, kind: 'goal' }, runId), 'turn-a')
    return 'ok'
  }
  return { runtime, owner, target, task, run, state, cancellations, turns, sent, notes }
}

test('switching workspace preserves a terminal send and its tool replies without changing their owner', async () => {
  const f = fixture(), abort = new AbortController()
  f.runtime.scheduledSendAbort = abort
  f.runtime.setActive(false)
  assert.equal(abort.signal.aborted, false)
  assert.deepEqual(f.cancellations, [])
  assert.equal(f.state.interrupted, 0)
  assert.equal(f.runtime.scheduledTaskReady(f.task, f.run), null)
  assert.equal(f.runtime.scheduledOwnerCurrent(f.task), true)
  const call = { conversationId: f.owner.conversationId, pageEpoch: 'page-a', sourceSubmissionId: 'user:first' }
  assert.equal(f.runtime.mailNotificationCurrent(call), true)
  assert.equal(f.runtime.toolPromptReadCurrent(call), true)
  assert.equal(f.runtime.toolPromptReadCurrent({ ...call, sourceSubmissionId: 'old' }), false)
  assert.equal(f.runtime.mailNotificationCurrent({ ...call, pageEpoch: 'old' }), false)
  f.runtime.setActive(true)
  assert.equal(f.state.interrupted, 0)
  assert.equal(f.state.wakes, 2)
  assert.deepEqual(f.sent, [], 'selecting a workspace wakes the scheduler without directly resending anything')
})

test('a background scheduled send records its user turn and reopens its own terminal loop after an ended task', async () => {
  const f = fixture()
  f.runtime.active = false; f.runtime.taskEnded = true
  assert.equal(f.runtime.scheduledTaskReady(f.task, f.run), null)
  const result = await f.runtime.sendScheduledTask(f.task, f.run, new AbortController().signal)
  assert.equal(result.outcome, 'ok')
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].conversationId, f.owner.conversationId)
  assert.match(f.turns[0], /检查仓库变化/)
  assert.equal(f.runtime.taskEnded, false, 'later command and tool responses are not dropped as an ended task')
  assert.equal(f.runtime.lastSubmissions.get(f.owner.platformId), 'user:scheduled:run-a')
  assert.equal(f.runtime.focusSending, false)
  assert.equal(f.runtime.scheduledSendAbort, null)
})

test('hiding a workspace during a terminal submission does not abort or duplicate it', async () => {
  const f = fixture(), send = f.runtime.embed.sendScheduledUser
  f.runtime.embed.sendScheduledUser = async (...args) => {
    f.runtime.setActive(false)
    assert.equal(args[3].aborted, false)
    assert.equal(args[4](), true)
    return send(...args)
  }
  assert.equal((await f.runtime.sendScheduledTask(f.task, f.run, new AbortController().signal)).outcome, 'ok')
  assert.equal(f.sent.length, 1)
})

test('hidden conversations retain pause, takeover, target, revision and conversation checks', () => {
  for (const change of [f => { f.state.paused = true }, f => { f.state.human = true },
    f => { f.runtime.options.automationBlocked = () => true }, f => { f.runtime.stoppingTask = true },
    f => { f.runtime.toolPreferences = () => ({ scheduledTasksEnabled: false }) },
    f => { f.state.conversationId = 'chat-b' }, f => { f.runtime.activePlatformId = 'deepseek' },
    f => { f.runtime.scheduledTarget = () => ({ ...f.target, key: 'host-b' }) }]) {
    const f = fixture(); f.runtime.active = false; change(f)
    assert.ok(f.runtime.scheduledTaskReady(f.task, f.run))
    assert.equal(f.runtime.scheduledOwnerCurrent(f.task), false)
  }
  const f = fixture(); f.runtime.active = false
  f.runtime.options.scheduledTasks.store.get = () => ({ ...f.task, revision: 2 })
  assert.equal(f.runtime.scheduledOwnerCurrent(f.task), false)
})

test('desktop-tool tasks still cancel on workspace handover and wait for selection', () => {
  const f = fixture(), abort = new AbortController()
  f.state.desktop = true; f.runtime.scheduledSendAbort = abort
  f.runtime.setActive(false)
  assert.equal(abort.signal.aborted, true)
  assert.equal(f.state.interrupted, 1)
  assert.deepEqual(f.cancellations, ['mail', 'tools', 'plans'])
  assert.match(f.runtime.scheduledTaskReady(f.task, f.run), /桌面操作/)
  assert.equal(f.runtime.scheduledOwnerCurrent(f.task), false)
  const call = { conversationId: f.owner.conversationId, pageEpoch: 'page-a', sourceSubmissionId: 'user:first' }
  assert.equal(f.runtime.mailNotificationCurrent(call), false)
  assert.equal(f.runtime.toolPromptReadCurrent(call), false)
})
