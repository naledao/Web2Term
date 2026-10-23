// User-run only: node --test tests/command-recovery.test.mjs
// Isolates the actual main-process delivery methods; the page bridge is a fake.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/embed.ts', import.meta.url), 'utf8')
const start = source.indexOf('  /** Page-side token, generation and path checks')
const end = source.indexOf('  async sendFileResult(', start)
assert.ok(start > 0 && end > start)
const isolated = 'class Recovery { constructor(contents) { this.contents = contents; this.interceptor = {}; ' +
  'this.handlers = { onInterceptor() {}, onCommandRecovery() {} } } ' +
  'liveContents() { return this.contents } getInterceptorStatus() { return this.interceptor } ' +
  source.slice(start, end) + ' }; module.exports = Recovery'
const module = { exports: null }
new Script(ts.transpileModule(isolated, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ module })
const Recovery = module.exports
const pending = () => ({ messageId: 'reply-1', token: 11, generation: 3, status: 'pending', message: 'pending' })

test('lost page bridge after a pending event reports uncertain even though the snapshot object changed', async () => {
  const recovery = new Recovery({ executeJavaScript: async () => {
    recovery.setCommandRecovery(pending())
    throw new Error('bridge lost')
  } })
  recovery.interceptor.commandRecovery = pending()
  assert.equal(await recovery.recoverCommand(true), 'stuck')
  assert.equal(recovery.interceptor.commandRecovery.status, 'uncertain')
})

test('a confirmed sent event cannot be overwritten by a late transport exception', async () => {
  const recovery = new Recovery({ executeJavaScript: async () => {
    recovery.setCommandRecovery({ ...pending(), status: 'sent' })
    throw new Error('bridge lost after confirmation')
  } })
  recovery.interceptor.commandRecovery = pending()
  await recovery.recoverCommand(true)
  assert.equal(recovery.interceptor.commandRecovery.status, 'sent')
})

test('a newer failed request keeps its own recovery state when the older call fails', async () => {
  const recovery = new Recovery({ executeJavaScript: async () => {
    recovery.interceptor.commandRecovery = { ...pending(), token: 12, messageId: 'reply-2' }
    throw new Error('older bridge failed')
  } })
  recovery.interceptor.commandRecovery = pending()
  await recovery.recoverCommand(true)
  assert.equal(recovery.interceptor.commandRecovery.token, 12)
  assert.equal(recovery.interceptor.commandRecovery.status, 'pending')
})

test('the bridge result closes a pending state even when the console status event is missed', async () => {
  for (const [outcome, status] of [['ok', 'sent'], ['busy', 'blocked'], ['stale', 'blocked'], ['limit', 'failed'], ['stuck', 'uncertain']]) {
    const recovery = new Recovery({ executeJavaScript: async () => outcome })
    recovery.interceptor.commandRecovery = pending()
    assert.equal(await recovery.recoverCommand(true), outcome)
    assert.equal(recovery.interceptor.commandRecovery.status, status)
  }
})
