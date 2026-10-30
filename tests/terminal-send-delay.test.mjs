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
  return text.startsWith('this.preferredSendDelaySeconds =') || text.startsWith('this.runner.setSendDelay(')
}).map(node => node.getText(source))
assert.equal(settings.length, 2, 'the runtime must restore its saved delay and apply it to the runner')
const methods = ['setTerminalSendDelay', 'switchPlatform'].map(name =>
  runtimeClass.members.find(node => node.name?.getText(source) === name).getText(source)).join('\n')
const compiled = ts.transpileModule(`class Runtime {
  constructor(options, runner) { this.runner = runner; ${settings.join('\n')} }
  ${methods}
}; Runtime`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const Runtime = new Script(compiled).runInNewContext({
  DEEPSEEK_PLATFORM: { id: 'deepseek' },
  buildTerminalPromptParts: () => ({ prefix: '', suffix: '' }),
  IpcChannels: { embedState: 'embed', interceptorEvent: 'interceptor', questionChatState: 'question' },
  console: { info() {} }
})

function fixture(platformId = 'deepseek', initialSendDelaySeconds = 17) {
  let state = { sendDelaySeconds: 0 }
  let summaries = 0
  const runner = { setSendDelay(seconds) { state = { sendDelaySeconds: seconds }; return state } }
  const runtime = new Runtime({ platform: { id: platformId }, initialSendDelaySeconds }, runner)
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
    environment: {}, options: { onSummaryChanged() { summaries++ } },
    taskRunning: () => false, interruptTaskControl() {}, syncWindowsHelperDemand() {},
    ensureEmbed: id => embeds.get(id), toolPrompt: () => '', applyVisibility() {},
    send() {}, syncAutonomousTask() {}
  })
  return { runtime, state: () => state, summaries: () => summaries }
}

test('restoring any platform applies the saved delay, including zero', () => {
  for (const platform of ['deepseek', 'chatgpt', 'claude', 'gemini']) {
    for (const seconds of [0, 1, 17, 600]) {
      const f = fixture(platform, seconds)
      assert.equal(f.state().sendDelaySeconds, seconds, `${platform} restore ${seconds}`)
    }
  }
})

test('editing the wait updates both the real terminal value and the saved preference on every platform', () => {
  for (const platform of ['deepseek', 'chatgpt', 'claude', 'gemini']) {
    const f = fixture(platform)
    for (const seconds of [0, 1, 23, 600]) {
      assert.equal(f.runtime.setTerminalSendDelay(seconds).sendDelaySeconds, seconds)
      assert.equal(f.state().sendDelaySeconds, seconds)
      assert.equal(f.runtime.preferredSendDelaySeconds, seconds)
    }
    assert.equal(f.summaries(), 4)
  }
})

test('switching away from and back to DeepSeek preserves the configured wait', () => {
  for (const seconds of [0, 1, 23, 600]) {
    const f = fixture()
    f.runtime.setTerminalSendDelay(seconds)
    for (const platform of ['chatgpt', 'deepseek', 'claude', 'gemini', 'deepseek']) {
      assert.equal(f.runtime.switchPlatform(platform), true)
      assert.equal(f.state().sendDelaySeconds, seconds, `${platform} must keep ${seconds}`)
      assert.equal(f.runtime.preferredSendDelaySeconds, seconds)
    }
  }
})

test('invalid and out-of-range input is normalized to whole seconds within 0–600', () => {
  const f = fixture()
  for (const [input, expected] of [[-8, 0], [3.9, 3], [601, 600], [NaN, 0], [Infinity, 0]]) {
    assert.equal(f.runtime.setTerminalSendDelay(input).sendDelaySeconds, expected)
    assert.equal(f.runtime.preferredSendDelaySeconds, expected)
  }
})
