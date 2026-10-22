// User-run only: node --test tests/focus-upload-ownership.test.mjs
// Actual runtime/embed methods with synthetic collaborators; no Electron, disk writes or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function actualMethod(relative, name, globals = {}) {
  const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const file = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true)
  const find = node => ts.isMethodDeclaration(node) && node.name.getText(file) === name ? node : ts.forEachChild(node, find)
  const method = find(file)
  assert.ok(method, 'Actual method missing: ' + name)
  const source = 'class Subject { ' + method.getText(file) + ' }\nSubject.prototype.' + name
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  return new Script(code).runInNewContext({ AbortController, ...globals })
}
const image = { fileName: 'logo.png', mimeType: 'image/png', sizeBytes: 3, dataBase64: 'YWJj' }

function runtimeFixture(initialConversationId = null) {
  let conversationId = initialConversationId, cleaned = 0
  const records = []
  const subject = {
    id: 'workspace', activePlatformId: 'deepseek', disposed: false, focusSending: false,
    embed: { getState: () => ({ conversationId }) },
    ownsFocus(owner) { return owner.sessionId === this.id && owner.platformId === this.activePlatformId && owner.conversationId === conversationId }
  }
  const send = actualMethod('../src/main/session-runtime.ts', 'sendFocusMessage', {
    validFocusFiles: () => true,
    stageFocusAttachments: async () => ({ attachments: [{ fileName: 'logo.png' }], cleanup: async () => { cleaned++ } }),
    randomUUID: () => 'owned-send', writeFocusDiagnostic: (_owner, data) => records.push(data)
  })
  return { subject, records, setConversation(id) { conversationId = id }, cleaned: () => cleaned,
    send: () => send.call(subject, { sessionId: 'workspace', platformId: 'deepseek', conversationId: initialConversationId, text: '说明图片', files: [image] }) }
}

test('home-to-created-chat binding keeps the runtime owner alive until the uploader confirms', async () => {
  const f = runtimeFixture()
  f.subject.embed.sendFocusFiles = async (_text, _files, token, current, signal, images) => {
    assert.equal(current(), true)
    f.setConversation('created-chat')
    // Regression: strict ownsFocus(request) used to become false at this point.
    assert.equal(current(), true)
    assert.equal(current(), true, 'a delayed virtual row must still be allowed to confirm')
    assert.equal(signal.aborted, false)
    assert.equal(token, 'focus:owned-send')
    assert.equal(images[0].dataBase64, image.dataBase64)
    return 'ok'
  }
  assert.equal(await f.send(), 'ok')
  assert.equal(f.cleaned(), 1)
  assert.equal(f.subject.focusSending, false)
  assert.equal(f.subject.focusUploadAbort, null)
})

test('an existing conversation, platform replacement, disposal and cancellation still invalidate ownership', async () => {
  for (const cause of ['existing-chat-changed', 'platform-changed', 'embed-replaced', 'disposed', 'cancelled']) {
    const f = runtimeFixture(cause === 'existing-chat-changed' ? 'existing' : null)
    f.subject.embed.sendFocusFiles = async (_text, _files, _token, current, signal) => {
      if (cause === 'existing-chat-changed') f.setConversation('another')
      if (cause === 'platform-changed') f.subject.activePlatformId = 'chatgpt'
      if (cause === 'embed-replaced') f.subject.embed = {}
      if (cause === 'disposed') f.subject.disposed = true
      if (cause === 'cancelled') f.subject.focusUploadAbort.abort()
      assert.equal(current(), false, cause)
      if (cause === 'cancelled') assert.equal(signal.aborted, true)
      return 'unknown'
    }
    assert.equal(await f.send(), 'unknown', cause)
    assert.equal(f.cleaned(), 1, cause)
  }
})

function embedFixture(images = [image]) {
  const started = [], captured = [], fallback = []
  const handle = actualMethod('../src/main/embed.ts', 'handlePageReport', {
    INTERCEPTOR_LOG_TAG: '[cmd-terminal] ', console: { info() {}, warn() {} },
    writeReplyDiagnostic: () => null, writePromptDiagnostic: () => null
  })
  const subject = {
    platform: { id: 'deepseek' }, focusSendImages: new Map([['focus:owned', images]]),
    interceptor: { pendingQuestion: null }, liveContents: () => null, getInterceptorStatus: () => ({}),
    handlers: {
      onUserStarted(...args) { started.push(args); return 'turn' },
      onUserMessage(...args) { captured.push(args) }, onInterceptor() {}
    },
    deliverUserMessage(...args) { fallback.push(args) }
  }
  return { started, captured, fallback,
    report(data) { handle.call(subject, '[cmd-terminal] ' + JSON.stringify(data)) } }
}

test('a confirmed owned token stores original image bytes once without scraping a thumbnail', () => {
  const f = embedFixture()
  const message = { event: 'user-message', text: '说明图片', focusSendToken: 'focus:owned', focusFiles: [image] }
  f.report(message)
  f.report(message)
  f.report({ ...message, focusSendToken: 'focus:another' })
  assert.equal(f.started.length, 1)
  assert.equal(f.captured.length, 1)
  assert.equal(f.captured[0][1][0].dataBase64, image.dataBase64)
  assert.equal(f.captured[0][2], 'turn')
  assert.equal(f.captured[0][3], 'provided')
  assert.equal(f.fallback.length, 0)
})

test('file-only messages still establish a human turn and native paste keeps the existing capture path', () => {
  const f = embedFixture([])
  f.report({ event: 'user-message', text: '', focusSendToken: 'focus:owned', focusFiles: [{ ...image, mimeType: 'application/pdf' }] })
  assert.equal(f.started.length, 1)
  assert.equal(f.captured.length, 1)
  f.report({ event: 'user-message', text: '', attachmentToken: 'img:native' })
  assert.equal(f.fallback.length, 1)
  assert.equal(f.fallback[0][1], 'img:native')
})
