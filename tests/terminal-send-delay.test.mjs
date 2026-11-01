// User-run only: node --test tests/terminal-send-delay.test.mjs
// Actual runtime settings and platform-switch code with fake terminals/pages.
// No Electron, app profile, real shell, desktop input or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const filename = '../src/main/session-runtime.ts'
const source = ts.createSourceFile(filename, readFileSync(new URL(filename, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const runtimeClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const constructor = runtimeClass.members.find(ts.isConstructorDeclaration)
// Keep the real restore expressions, without starting any of the constructor's
// Electron views, shell processes or external services.
const settings = constructor.body.statements.filter(node => {
  const text = node.getText(source)
  return ['this.activePlatformId =', 'this.sendDelayCustomized =', 'this.preferredSendDelaySeconds =', 'this.runner.setSendDelay(']
    .some(prefix => text.startsWith(prefix))
}).map(node => node.getText(source))
assert.equal(settings.length, 4, 'the runtime must restore its platform, delay mode and value, then apply it to the runner')
const defaultDelay = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'defaultTerminalSendDelaySeconds')
const methods = ['setTerminalSendDelay', 'switchPlatform', 'persistentState'].map(name =>
  runtimeClass.members.find(node => node.name?.getText(source) === name).getText(source)).join('\n')
const compiled = ts.transpileModule(`${defaultDelay.getText(source)}
class Runtime {
  constructor(options, runner) { this.runner = runner; ${settings.join('\n')} }
  ${methods}
}; Runtime`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const Runtime = new Script(compiled).runInNewContext({
  DEEPSEEK_PLATFORM: { id: 'deepseek' },
  buildTerminalPromptParts: () => ({ prefix: '', suffix: '' }),
  IpcChannels: { embedState: 'embed', interceptorEvent: 'interceptor', questionChatState: 'question' },
  console: { info() {} }
})

function fixture(platformId = 'deepseek', initialSendDelaySeconds, initialSendDelayCustomized) {
  let state = { sendDelaySeconds: 0 }
  let summaries = 0
  const runner = {
    setSendDelay(seconds) { state = { sendDelaySeconds: seconds }; return state },
    getTerminalState: () => ({ ...state, cwd: '' }), getAutomation: () => ({ paused: false })
  }
  const runtime = new Runtime({ platform: { id: platformId }, initialSendDelaySeconds, initialSendDelayCustomized }, runner)
  const embeds = new Map(['deepseek', 'chatgpt', 'claude', 'gemini'].map(id => [id, {
    platform: { id, label: id },
    embed: {
      setPromptParts() {}, armCommandBaseline: async () => {},
      getState: () => ({ conversationId: `${id}-chat` }),
      getInterceptorStatus: () => ({}), getQuestionChatState: () => ({})
    }
  }]))
  Object.assign(runtime, {
    id: 'delay-fixture', activePlatformId: platformId, focusSending: false, embeds,
    projectId: null, customTitle: '', promptInjectionEnabled: true, sshCwd: '', createdAt: 1,
    ssh: { getState: () => ({ attached: false, status: 'disconnected', hostId: '' }) },
    activeEmbed: () => embeds.get(runtime.activePlatformId),
    environment: {}, options: { onSummaryChanged() { summaries++ } },
    taskRunning: () => false, interruptTaskControl() {}, syncWindowsHelperDemand() {},
    ensureEmbed: id => embeds.get(id), toolPrompt: () => '', applyVisibility() {},
    send() {}, syncAutonomousTask() {}
  })
  return { runtime, state: () => state, summaries: () => summaries }
}

test('new sessions use their platform default and follow every platform switch', () => {
  for (const startingPlatform of ['deepseek', 'chatgpt', 'claude', 'gemini']) {
    const f = fixture(startingPlatform)
    assert.equal(f.state().sendDelaySeconds, startingPlatform === 'deepseek' ? 6 : 3)
    for (const platform of ['chatgpt', 'deepseek', 'claude', 'gemini', 'deepseek']) {
      f.runtime.switchPlatform(platform)
      const expected = platform === 'deepseek' ? 6 : 3
      assert.equal(f.state().sendDelaySeconds, expected, `${startingPlatform} -> ${platform}`)
      assert.equal(f.runtime.preferredSendDelaySeconds, expected)
      assert.equal(f.runtime.sendDelayCustomized, false)
    }
  }
})

test('restoring a custom wait applies the saved value, including zero and values matching defaults', () => {
  for (const platform of ['deepseek', 'chatgpt', 'claude', 'gemini']) {
    for (const seconds of [0, 1, 3, 6, 17, 600]) {
      const f = fixture(platform, seconds, true)
      assert.equal(f.state().sendDelaySeconds, seconds, `${platform} restore ${seconds}`)
      assert.equal(f.runtime.sendDelayCustomized, true)
    }
  }
})

test('legacy defaults carried from another platform are corrected and keep following switches', () => {
  for (const platform of ['deepseek', 'chatgpt', 'claude', 'gemini']) {
    for (const seconds of [3, 6]) {
      const f = fixture(platform, seconds)
      assert.equal(f.state().sendDelaySeconds, platform === 'deepseek' ? 6 : 3)
      f.runtime.switchPlatform(platform === 'deepseek' ? 'chatgpt' : 'deepseek')
      assert.equal(f.state().sendDelaySeconds, platform === 'deepseek' ? 3 : 6)
      assert.equal(f.runtime.sendDelayCustomized, false)
    }
  }
})

test('legacy non-default waits remain custom, including immediate return', () => {
  for (const seconds of [0, 1, 17, 600]) {
    const f = fixture('deepseek', seconds)
    assert.equal(f.state().sendDelaySeconds, seconds)
    f.runtime.switchPlatform('chatgpt')
    assert.equal(f.state().sendDelaySeconds, seconds)
    assert.equal(f.runtime.sendDelayCustomized, true)
  }
})

test('editing the wait updates both the real terminal value and the saved preference on every platform', () => {
  for (const platform of ['deepseek', 'chatgpt', 'claude', 'gemini']) {
    const f = fixture(platform)
    for (const seconds of [0, 1, 23, 600]) {
      assert.equal(f.runtime.setTerminalSendDelay(seconds).sendDelaySeconds, seconds)
      assert.equal(f.state().sendDelaySeconds, seconds)
      assert.equal(f.runtime.preferredSendDelaySeconds, seconds)
      assert.equal(f.runtime.sendDelayCustomized, true)
    }
    assert.equal(f.summaries(), 4)
  }
})

test('switching away from and back to DeepSeek preserves the configured wait', () => {
  for (const seconds of [0, 1, 3, 6, 23, 600]) {
    const f = fixture()
    f.runtime.setTerminalSendDelay(seconds)
    for (const platform of ['chatgpt', 'deepseek', 'claude', 'gemini', 'deepseek']) {
      assert.equal(f.runtime.switchPlatform(platform), true)
      assert.equal(f.state().sendDelaySeconds, seconds, `${platform} must keep ${seconds}`)
      assert.equal(f.runtime.preferredSendDelaySeconds, seconds)
    }
  }
})

test('automatic mode and explicit custom waits survive persistence and restart', () => {
  for (const customWait of [undefined, 0, 3, 6, 23]) {
    const f = fixture()
    if (customWait !== undefined) f.runtime.setTerminalSendDelay(customWait)
    f.runtime.switchPlatform('chatgpt')
    const saved = f.runtime.persistentState()
    assert.equal(saved.sendDelaySeconds, customWait ?? 3)
    assert.equal(saved.sendDelayCustomized, customWait !== undefined)
    const restored = fixture(saved.platformId, saved.sendDelaySeconds, saved.sendDelayCustomized)
    assert.equal(restored.state().sendDelaySeconds, saved.sendDelaySeconds)
    restored.runtime.switchPlatform('deepseek')
    assert.equal(restored.state().sendDelaySeconds, customWait ?? 6)
  }
})

test('rejected, unknown and unchanged platform switches leave the delay and its mode alone', () => {
  const f = fixture()
  for (const platform of ['deepseek', 'unknown']) assert.equal(f.runtime.switchPlatform(platform), false)
  f.runtime.focusSending = true
  assert.equal(f.runtime.switchPlatform('chatgpt'), false)
  f.runtime.focusSending = false
  f.runtime.taskRunning = () => true
  f.runtime.taskCoordinator = { current: () => null }
  assert.equal(f.runtime.switchPlatform('chatgpt'), false)
  assert.equal(f.state().sendDelaySeconds, 6)
  assert.equal(f.runtime.preferredSendDelaySeconds, 6)
  assert.equal(f.runtime.sendDelayCustomized, false)
  assert.equal(f.summaries(), 0)
})

test('invalid and out-of-range input is normalized to whole seconds within 0–600', () => {
  const f = fixture()
  for (const [input, expected] of [[-8, 0], [3.9, 3], [601, 600], [NaN, 0], [Infinity, 0]]) {
    assert.equal(f.runtime.setTerminalSendDelay(input).sendDelaySeconds, expected)
    assert.equal(f.runtime.preferredSendDelaySeconds, expected)
  }
})
