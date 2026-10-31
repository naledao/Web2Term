// User-run only: node --test tests/focus-composer-state.test.mjs tests/focus-page.test.mjs
// Actual composer JSX and scoped native-stop methods. No Electron, session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
} }).outputText
const source = path => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true,
  path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
function find(file, predicate) {
  const visit = node => predicate(node) ? node : ts.forEachChild(node, visit)
  const node = visit(file)
  assert.ok(node, 'Missing production implementation')
  return node
}
const view = source('../src/renderer/src/components/FocusChatView.tsx')
const button = find(view, node => ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression) &&
  node.expression.whenTrue.getText(view).startsWith('<button') && node.expression.whenTrue.getText(view).includes('focus-composer__send')).expression
const flags = ['nativeGenerating', 'composerBusy'].map(name => {
  const node = find(view, node => ts.isVariableDeclaration(node) && node.name.getText(view) === name)
  return `const ${name} = ${node.initializer.getText(view)};`
}).join('\n')
const buttonCode = compile(flags + '\nconst actual = () => (' + button.getText(view) + '); actual')
function renderButton(overrides = {}) {
  const context = {
    exports: {},
    state: { generating: 'idle', waiting: true, nativeDraft: false, turns: [{ status: 'working' }] },
    props: { needsAnswer: false }, ready: true, stopping: false, sending: false, sendFailure: null, changingMode: null, settingPending: null,
    editingId: null, sendBlock: '', draft: '新消息', draftFiles: [], stop() {},
    ComposerPendingIcon: () => jsxRuntime.jsx('span', { children: 'pending' }),
    require: name => { assert.equal(name, 'react/jsx-runtime'); return jsxRuntime }, ...overrides
  }
  const Actual = new Script(buttonCode).runInNewContext(context)
  return renderToStaticMarkup(jsxRuntime.jsx(Actual, {}))
}

test('native idle shows an enabled send arrow despite a waiting task or interrupted execution history', () => {
  const html = renderButton()
  assert.match(html, /type="submit"/)
  assert.match(html, /aria-label="发送消息"/)
  assert.ok(!html.includes('disabled'))
  assert.ok(!html.includes('focus-composer__stop-icon'))
})

test('only native generation shows Stop; empty drafts, unknown controls and local uploads do not', () => {
  const active = renderButton({ state: { generating: 'active', waiting: false } })
  assert.match(active, /aria-label="停止生成"/)
  assert.match(active, /focus-composer__stop-icon/)
  for (const overrides of [{ draft: '' }, { sending: true }, { state: { generating: 'unknown' } }]) {
    const html = renderButton(overrides)
    assert.match(html, /type="submit"/)
    assert.match(html, /disabled=""/)
    assert.ok(!html.includes('focus-composer__stop-icon'))
  }
  assert.ok(!renderButton({ draft: '', draftFiles: [{}] }).includes('disabled'))
})

const embedFile = source('../src/main/embed.ts')
const embedClass = find(embedFile, node => ts.isClassDeclaration(node) && node.name?.text === 'ChatGptEmbed')
const methods = ['stopFocusGeneration', 'sendFocusUser', 'sendUserTask'].map(name =>
  embedClass.members.find(node => node.name?.getText(embedFile) === name).getText(embedFile)).join('\n')
const Bridge = new Script(compile(`class Bridge { ${methods} }; Bridge`)).runInNewContext({ URL, setTimeout, clearTimeout, supportsFocusView: () => true })

test('native Stop is a single scoped click, with no click for idle, covered or navigated pages', async () => {
  for (const scenario of ['active', 'idle', 'covered', 'navigated', 'unconfirmed']) {
    const clicks = [], scripts = []
    let url = 'https://chat.deepseek.com/a/chat/s/one'
    const contents = {
      getURL: () => url, isDestroyed: () => false,
      async executeJavaScript(script) {
        scripts.push(script)
        if (script.includes('prepareFocusStop')) {
          if (scenario === 'navigated') url = 'https://chat.deepseek.com/a/chat/s/two'
          return scenario === 'idle' ? { outcome: 'ok' } : scenario === 'covered' ? { outcome: 'unavailable' }
            : { outcome: 'ok', x: 20, y: 30, generation: 4 }
        }
        assert.ok(script.includes('finishFocusStop'))
        return scenario === 'unconfirmed' ? 'unknown' : 'ok'
      }
    }
    const bridge = Object.assign(new Bridge(), { focusPage: () => contents, clickAt: (...point) => clicks.push(point) })
    const outcome = await bridge.stopFocusGeneration()
    assert.equal(outcome, scenario === 'covered' ? 'unavailable' : scenario === 'navigated' ? 'cancelled' : scenario === 'unconfirmed' ? 'unknown' : 'ok')
    assert.equal(clicks.length, ['active', 'unconfirmed'].includes(scenario) ? 1 : 0, scenario)
    assert.ok(scripts.every(script => !script.includes('endTask')), scenario)
  }
})

test('only the explicit focus sender opts into native composer availability', async () => {
  const sends = []
  const bridge = Object.assign(new Bridge(), {
    platform: { id: 'deepseek', homeUrl: 'https://chat.deepseek.com/' },
    liveContents: () => ({ getURL: () => 'https://chat.deepseek.com/a/chat/s/one',
      executeJavaScript: script => new Script(script).runInNewContext({ window: { __cmdTerminalInterceptor: {
        sendUser(...args) { sends.push(args); return 'ok' }
      } } }) })
  })
  await bridge.sendFocusUser('人工输入')
  await bridge.sendUserTask('自动任务')
  await bridge.sendUserTask('明确恢复', true)
  assert.equal(sends[0][2].fromFocus, true)
  assert.equal(sends[1][2], undefined)
  assert.equal(sends[2][2].force, true)
  assert.equal(sends[2][2].fromFocus, undefined)
})

test('a timed-out stop preparation cannot dispatch a late native click', async () => {
  let expire, resolvePoint
  const SlowBridge = new Script(compile(`class Bridge { ${methods} }; Bridge`)).runInNewContext({
    URL, setTimeout(callback) { expire = callback; return 1 }, clearTimeout() {}, supportsFocusView: () => true
  })
  const clicks = []
  const bridge = Object.assign(new SlowBridge(), {
    focusPage: () => ({ getURL: () => 'https://chat.deepseek.com/a/chat/s/one', isDestroyed: () => false,
      executeJavaScript: () => new Promise(resolve => { resolvePoint = resolve }) }),
    clickAt: (...point) => clicks.push(point)
  })
  const pending = bridge.stopFocusGeneration()
  expire()
  assert.equal(await pending, 'unavailable')
  resolvePoint({ outcome: 'ok', x: 20, y: 30, generation: 4 })
  await Promise.resolve()
  assert.equal(clicks.length, 0)
})

const runtimeFile = source('../src/main/session-runtime.ts')
const runtimeClass = find(runtimeFile, node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const stopMethod = runtimeClass.members.find(node => node.name?.getText(runtimeFile) === 'stopFocusGeneration').getText(runtimeFile)
const Runtime = new Script(compile(`class Runtime { ${stopMethod} }; Runtime`)).runInNewContext({})
test('focus Stop never cancels terminal automation and cannot cross conversation ownership', async () => {
  let owned = true, stops = 0
  const runtime = Object.assign(new Runtime(), {
    ownsFocus: () => owned,
    embed: { async stopFocusGeneration() { stops++; return 'ok' } },
    stopAutomation() { assert.fail('native Stop must not end the terminal task') }
  })
  assert.equal(await runtime.stopFocusGeneration({}), 'ok')
  owned = false
  assert.equal(await runtime.stopFocusGeneration({}), 'unavailable')
  assert.equal(stops, 1)
  owned = true
  runtime.embed.stopFocusGeneration = async () => { owned = false; return 'ok' }
  assert.equal(await runtime.stopFocusGeneration({}), 'cancelled')
})

const pageFile = source('../src/main/injected/send-interceptor.js')
function pageMethod(name, context) {
  const node = find(pageFile, node => ts.isMethodDeclaration(node) && node.name.getText(pageFile) === name)
  return new Script('({' + node.getText(pageFile) + '})').runInNewContext(context)[name]
}
test('the page measures only a reachable native Stop, never a covering element or another route', () => {
  const button = { scrollIntoView() {}, contains: () => false,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 20, height: 10 }) }
  for (const scenario of ['active', 'idle', 'covered', 'disabled', 'route']) {
    const context = {
      location: { pathname: '/one' }, state: { taskPromptGeneration: 4 },
      focusGenerationState: () => scenario === 'idle' ? 'idle' : 'active',
      findStopButton: () => button, isVisibleElement: () => true, controlDisabled: () => scenario === 'disabled',
      document: { elementFromPoint: () => scenario === 'covered' ? {} : button }
    }
    const result = pageMethod('prepareFocusStop', context)(scenario === 'route' ? '/two' : '/one')
    assert.equal(result.outcome, ['covered', 'disabled', 'route'].includes(scenario) ? 'unavailable' : 'ok')
    if (scenario === 'active') assert.deepEqual([result.x, result.y, result.generation], [20, 25, 4])
    else assert.equal(result.x, undefined)
  }
})

test('native stop confirmation preserves task state and rejects stale or unconfirmed results', async () => {
  for (const scenario of ['confirmed', 'route', 'generation', 'unconfirmed']) {
    let now = 0, generating = 'active'
    const state = { taskPromptGeneration: 4, taskActive: true, awaitingReplySince: 123 }
    const context = {
      location: { pathname: '/one' }, state, Date: { now: () => now }, focusGenerationState: () => generating,
      setTimeout(callback) {
        now += 1000
        if (scenario === 'confirmed') generating = 'idle'
        if (scenario === 'route') context.location.pathname = '/two'
        if (scenario === 'generation') state.taskPromptGeneration++
        callback()
      }
    }
    const result = await pageMethod('finishFocusStop', context)('/one', 4)
    assert.equal(result, scenario === 'confirmed' ? 'ok' : scenario === 'unconfirmed' ? 'unknown' : 'cancelled')
    assert.equal(state.taskActive, true)
    assert.equal(state.awaitingReplySince, 123)
  }
})
