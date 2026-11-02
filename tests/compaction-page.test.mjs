// User-run only: node --test tests/compaction-page.test.mjs
// Real page controller with a synthetic native host. No Electron process or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function fixture() {
  const calls = [], sends = []
  class Contents extends EventEmitter {
    destroyed = false
    location = ''
    isDestroyed() { return this.destroyed }
    getUserAgent() { return 'Mozilla/5.0 Chrome/152 Electron/44.5.0 web2term/0.1.210' }
    setUserAgent() {}
    setWindowOpenHandler() {}
    getURL() { return this.location }
    setBackgroundThrottling(value) { calls.push(['throttle', value]) }
    loadURL(url) {
      this.location = url
      calls.push(['load', url, { ...host.viewport }, host.nativeVisible])
      return Promise.resolve()
    }
    close() { this.destroyed = true }
  }
  let host
  class View {
    webContents = new Contents()
    nativeVisible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    viewport = { width: 0, height: 0 }
    constructor() { host = this }
    setBackgroundColor() {}
    setBounds(bounds) {
      this.bounds = { ...bounds }
      // The measured native host propagates size while visible, not while hidden.
      if (this.nativeVisible) this.viewport = { width: bounds.width, height: bounds.height }
      calls.push(['bounds', { ...bounds }])
    }
    setVisible(visible) {
      this.nativeVisible = visible
      if (visible) this.viewport = { width: this.bounds.width, height: this.bounds.height }
      calls.push(['visible', visible])
    }
  }
  const exports = {}, dependencies = {
    electron: { WebContentsView: View, shell: { openExternal() { throw new Error('No external browser in this test') } } },
    '../shared/deepseek-question': { questionChatBounds: raw => raw },
    './question-chat-page': { questionPageCall() { throw new Error('No page execution in native-host tests') } },
    './question-chat-send': { async sendQuestionChatAttachment(_contents, _platform, _path, _prompt, _signal, current, beforeSubmit, sizePolicy) {
      sends.push({ current: current(), sizePolicy })
      if (!current()) return 'cancelled'
      beforeSubmit()
      return 'ok'
    } },
    './injected/send-interceptor.js?raw': { default: '' },
    './injected/question-chat-sender.js?raw': { default: '' },
    './injected/theme.js?raw': { default: '' }
  }
  const source = readFileSync(new URL('../src/main/compaction-page.ts', import.meta.url), 'utf8')
  new Script(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)
    .runInNewContext({ exports, require(name) { assert.ok(name in dependencies, name); return dependencies[name] } })
  const parent = new EventEmitter()
  parent.isDestroyed = () => false
  parent.getContentSize = () => [1440, 900]
  parent.contentView = { addChildView() {}, removeChildView() {} }
  const page = new exports.CompactionPage(parent, { partition: 'persist:test', homeUrl: 'https://example.invalid/', page: {} },
    'light', 'https://example.invalid/', () => {}, { x: 50, y: 70, width: 1000, height: 700 })
  return { page, host, calls, sends }
}

test('a background worker initializes nonzero layout before hiding and its first navigation', () => {
  const f = fixture(), load = f.calls.find(call => call[0] === 'load')
  assert.equal(load[2].width, 1000)
  assert.equal(load[2].height, 700)
  assert.equal(load[3], false)
  assert.equal(f.page.visible, false)
  assert.equal(f.page.available, true)
  assert.ok(!f.calls.some(call => call[0] === 'visible' && call[1] === true), 'no native show before loading')
  f.page.close()
})

test('a hidden worker can send while retaining its dispatch ownership check', async () => {
  const f = fixture(), signal = new AbortController().signal
  let submitted = 0
  assert.equal(await f.page.send('source.md', 'prompt', signal, () => true, () => submitted++), 'ok')
  assert.equal(f.sends[0].sizePolicy, 'unlimited', 'generated compaction attachments have no application size cap')
  assert.equal(f.page.visible, false)
  assert.equal(submitted, 1)
  assert.equal(await f.page.send('source.md', 'prompt', signal, () => false, () => submitted++), 'cancelled')
  assert.equal(submitted, 1)
  f.page.close()
})

test('closing the optional presentation preserves the real viewport and unthrottled rendering', () => {
  const f = fixture()
  f.page.setViewport({ x: 10, y: 10, width: 900, height: 650 }, true)
  assert.equal(f.page.visible, true)
  f.page.setViewport({ x: 0, y: 0, width: 0, height: 0 }, false)
  assert.equal(f.page.visible, false)
  assert.equal(f.page.available, true)
  assert.equal(f.host.bounds.width, 900)
  assert.equal(f.host.bounds.height, 650)
  assert.deepEqual(f.calls.at(-1), ['throttle', false])
  f.calls.length = 0
  f.host.webContents.emit('dom-ready')
  assert.deepEqual(f.calls, [['throttle', false]])
  f.page.close()
  assert.equal(f.page.available, false)
})
