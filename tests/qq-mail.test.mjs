// Offline only. All persistence, encryption and SMTP checks are replaced by fakes.
// Run by the user: npm run test:qq-mail. Never starts Electron or contacts QQ.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
function load(path, dependencies = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function('exports', 'require', code)(exports, name => dependencies[name] ?? nodeRequire(name))
  return exports
}
const mailProtocol = load('../src/shared/mail-notification.ts')
const { QqMailService } = load('../src/main/qq-mail.ts', { '../shared/mail-notification': mailProtocol })

const code = 'abcdefghijklmnop'
const draft = { senderEmail: '123456789@qq.com', authorizationCode: code }

function fixture(overrides = {}, storeOverrides = {}) {
  const values = new Map()
  const checks = []
  let writes = 0
  const dependencies = {
    encryptionAvailable: () => true,
    encrypt: value => `sealed:${Buffer.from(value).toString('base64')}`,
    decrypt: value => {
      if (!value.startsWith('sealed:')) throw new Error('Cannot decrypt')
      return Buffer.from(value.slice(7), 'base64').toString()
    },
    verify: async credentials => { checks.push(credentials) },
    ...overrides
  }
  const store = {
    getSetting: key => values.get(key) ?? null,
    setSetting: (key, value) => { writes += 1; values.set(key, value) },
    ...storeOverrides
  }
  const service = new QqMailService(store, dependencies)
  return { service, restart: () => new QqMailService(store, dependencies), values, checks, get writes() { return writes } }
}

test('reading empty settings and saving do not contact SMTP', () => {
  const f = fixture()
  assert.deepEqual(f.service.getSettings(), {
    recipientEmail: '', recipientError: null,
    senderEmail: '', hasAuthorizationCode: false, encryptionAvailable: true, credentialError: null
  })
  assert.equal(f.service.save(draft).ok, true)
  assert.equal(f.checks.length, 0)
})

test('sender and code are normalized, stored together, and public state never returns the code', () => {
  const f = fixture()
  const result = f.service.save({ senderEmail: ' Alias.Name@QQ.COM ', authorizationCode: 'abcd efgh ijkl mnop' })
  assert.equal(result.ok, true)
  assert.equal(result.settings.senderEmail, 'alias.name@qq.com')
  assert.equal(result.settings.hasAuthorizationCode, true)
  assert.equal(f.writes, 1)
  const saved = JSON.parse(f.values.get('qqMail'))
  assert.equal(saved.senderEmail, 'alias.name@qq.com')
  assert.ok(saved.secret.startsWith('sealed:'))
  assert.ok(!JSON.stringify(saved).includes(code))
  assert.ok(!JSON.stringify(result).includes(code))
  assert.ok(!('authorizationCode' in f.service.getSettings()))
  assert.ok(!('secret' in f.service.getSettings()))
})

test('a blank code preserves credentials for the same sender and survives a service restart', async () => {
  const f = fixture()
  f.service.save(draft)
  assert.equal(f.service.save({ ...draft, authorizationCode: '' }).ok, true)
  const restarted = new QqMailService({ getSetting: key => f.values.get(key) ?? null, setSetting: (key, value) => f.values.set(key, value) }, {
    encryptionAvailable: () => true,
    encrypt: value => `sealed:${Buffer.from(value).toString('base64')}`,
    decrypt: value => Buffer.from(value.slice(7), 'base64').toString(),
    verify: async credentials => { f.checks.push(credentials) }
  })
  assert.equal((await restarted.verify({ senderEmail: '123456789@QQ.COM', authorizationCode: '' })).ok, true)
  assert.deepEqual(f.checks, [{ user: draft.senderEmail, pass: code }])
})

test('first save and changing sender both require a matching new authorization code', () => {
  const f = fixture()
  assert.equal(f.service.save({ ...draft, authorizationCode: '' }).ok, false)
  f.service.save(draft)
  const original = f.values.get('qqMail')
  assert.equal(f.service.save({ senderEmail: '987654321@qq.com', authorizationCode: '' }).ok, false)
  assert.equal(f.values.get('qqMail'), original)
  assert.equal(f.service.save({ senderEmail: '987654321@qq.com', authorizationCode: 'ponmlkjihgfedcba' }).ok, true)
})

test('rejects other providers, injected addresses, malformed drafts and invalid codes before writing', () => {
  const f = fixture()
  for (const senderEmail of ['test@gmail.com', '123@qq.com.evil.test', 'a@qq.com,b@qq.com', 'a@qq.com\r\nBcc: b@qq.com', '.a@qq.com', 'a..b@qq.com']) {
    assert.equal(f.service.save({ ...draft, senderEmail }).ok, false)
  }
  for (const invalid of [null, {}, { ...draft, authorizationCode: 123 }, { ...draft, authorizationCode: 'too-short' }]) {
    assert.equal(f.service.save(invalid).ok, false)
  }
  assert.equal(f.writes, 0)
  assert.equal(f.checks.length, 0)
})

test('safe storage being unavailable prevents persistence without falling back to plaintext', () => {
  const f = fixture({ encryptionAvailable: () => false })
  assert.equal(f.service.getSettings().encryptionAvailable, false)
  assert.equal(f.service.save(draft).ok, false)
  assert.equal(f.writes, 0)
})

test('encryption errors preserve the old configuration and do not echo the secret', () => {
  const f = fixture({ encrypt: () => { throw new Error(code) } })
  f.values.set('qqMail', 'existing configuration')
  const result = f.service.save(draft)
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes(code))
  assert.equal(f.values.get('qqMail'), 'existing configuration')
})

test('corrupt saved configuration can be repaired by entering both fields', () => {
  const f = fixture()
  f.values.set('qqMail', '{not json')
  assert.ok(f.service.getSettings().credentialError)
  assert.equal(f.service.save({ ...draft, authorizationCode: '' }).ok, false)
  assert.equal(f.service.save(draft).ok, true)
  assert.equal(f.service.getSettings().credentialError, null)
})

test('unreadable saved secrets are flagged and cannot silently be reused', () => {
  const f = fixture({ decrypt: () => { throw new Error(code) } })
  f.values.set('qqMail', JSON.stringify({ senderEmail: draft.senderEmail, secret: 'unreadable' }))
  const state = f.service.getSettings()
  assert.equal(state.hasAuthorizationCode, true)
  assert.ok(state.credentialError)
  assert.ok(!JSON.stringify(state).includes(code))
  assert.equal(f.service.save({ ...draft, authorizationCode: '' }).ok, false)
  assert.equal(f.service.clear().ok, true)
  assert.equal(f.service.getSettings().credentialError, null)
})

test('checking an unsaved draft performs only one authentication check and never saves', async () => {
  const f = fixture()
  assert.equal((await f.service.verify(draft)).ok, true)
  assert.equal(f.checks.length, 1)
  assert.equal(f.writes, 0)
  assert.equal(f.service.getSettings().hasAuthorizationCode, false)
})

test('server errors are sanitized and do not trigger automatic retries', async () => {
  for (const errorCode of ['EAUTH', 'ETIMEDOUT', 'ESOCKET']) {
    let attempts = 0
    const f = fixture({ verify: async () => { attempts += 1; throw Object.assign(new Error(`server echoed ${code}`), { code: errorCode }) } })
    const result = await f.service.verify(draft)
    assert.equal(result.ok, false)
    assert.ok(!JSON.stringify(result).includes(code))
    assert.equal(attempts, 1)
  }
})

test('concurrent checks and configuration writes are blocked until the check settles', async () => {
  let complete
  const f = fixture({ verify: () => new Promise(resolve => { complete = resolve }) })
  const pending = f.service.verify(draft)
  assert.equal((await f.service.verify(draft)).ok, false)
  assert.equal(f.service.save(draft).ok, false)
  assert.equal(f.service.clear().ok, false)
  complete()
  assert.equal((await pending).ok, true)
  assert.equal(f.service.save(draft).ok, true)
})

test('clearing removes both sender and encrypted code', () => {
  const f = fixture()
  f.service.save(draft)
  const result = f.service.clear()
  assert.equal(result.ok, true)
  assert.equal(f.values.get('qqMail'), '')
  assert.equal(result.settings.senderEmail, '')
  assert.equal(result.settings.hasAuthorizationCode, false)
})

test('the default recipient can be saved without sender credentials or safe storage', () => {
  const f = fixture({
    encryptionAvailable: () => false,
    encrypt: () => { throw new Error('must not encrypt') },
    decrypt: () => { throw new Error('must not decrypt') }
  })
  const result = f.service.saveRecipient(' Alias.Name@QQ.COM ')
  assert.equal(result.ok, true)
  assert.equal(result.settings.recipientEmail, 'alias.name@qq.com')
  assert.equal(result.settings.senderEmail, '')
  assert.equal(result.settings.hasAuthorizationCode, false)
  assert.equal(f.values.get('qqMailRecipient'), 'alias.name@qq.com')
  assert.equal(f.values.has('qqMail'), false)
  assert.equal(f.checks.length, 0)
  assert.equal(f.restart().getSettings().recipientEmail, 'alias.name@qq.com')
})

test('invalid recipients preserve the previous default and never write or contact SMTP', () => {
  const f = fixture()
  f.service.saveRecipient('123456789@qq.com')
  const previousWrites = f.writes
  for (const invalid of [
    null, undefined, 123, {}, ['a@qq.com'], '', '   ', 'a@gmail.com', 'a@qq.com.evil.test',
    'a@qq.com,b@qq.com', 'a@qq.com;b@qq.com', 'Name <a@qq.com>', 'a@qq.com\r\nBcc: b@qq.com',
    '.a@qq.com', 'a..b@qq.com', 'a b@qq.com', `${'a'.repeat(65)}@qq.com`
  ]) {
    const result = f.service.saveRecipient(invalid)
    assert.equal(result.ok, false, `recipient must be rejected: ${String(invalid)}`)
    assert.match(result.message, /QQ 收件邮箱/)
  }
  assert.equal(f.writes, previousWrites)
  assert.equal(f.service.getSettings().recipientEmail, '123456789@qq.com')
  assert.equal(f.checks.length, 0)
})

test('editing the recipient preserves sender credentials and clearing the sender preserves the recipient', () => {
  const f = fixture()
  f.service.save(draft)
  const sender = f.values.get('qqMail')
  assert.equal(f.service.saveRecipient('987654321@qq.com').ok, true)
  assert.equal(f.values.get('qqMail'), sender)
  assert.equal(f.service.saveRecipient('new.alias@qq.com').ok, true)
  assert.equal(f.values.get('qqMail'), sender)
  const cleared = f.service.clear()
  assert.equal(cleared.ok, true)
  assert.equal(cleared.settings.recipientEmail, 'new.alias@qq.com')
  assert.equal(f.restart().getSettings().recipientEmail, 'new.alias@qq.com')
})

test('clearing the recipient preserves sender credentials and survives a restart', () => {
  const f = fixture()
  f.service.save(draft)
  f.service.saveRecipient(draft.senderEmail)
  const sender = f.values.get('qqMail')
  const result = f.service.clearRecipient()
  assert.equal(result.ok, true)
  assert.equal(result.settings.recipientEmail, '')
  assert.equal(result.settings.recipientError, null)
  assert.equal(result.settings.senderEmail, draft.senderEmail)
  assert.equal(result.settings.hasAuthorizationCode, true)
  assert.equal(f.values.get('qqMail'), sender)
  assert.equal(f.restart().getSettings().recipientEmail, '')
  assert.equal(f.checks.length, 0)
})

test('recipient reads and writes still work when the saved sender configuration is damaged', () => {
  const f = fixture()
  f.values.set('qqMail', '{not json')
  const result = f.service.saveRecipient('123456789@qq.com')
  assert.equal(result.ok, true)
  assert.equal(result.settings.recipientEmail, '123456789@qq.com')
  assert.ok(result.settings.credentialError)
  assert.equal(f.values.get('qqMail'), '{not json')
  assert.equal(f.service.clearRecipient().ok, true)
})

test('a malformed stored recipient is flagged independently and can be replaced or cleared', () => {
  const f = fixture()
  f.service.save(draft)
  f.values.set('qqMailRecipient', 'invalid@example.com')
  const state = f.service.getSettings()
  assert.equal(state.recipientEmail, '')
  assert.ok(state.recipientError)
  assert.equal(state.credentialError, null)
  assert.equal(state.senderEmail, draft.senderEmail)
  const repaired = f.service.saveRecipient('123456789@qq.com')
  assert.equal(repaired.ok, true)
  assert.equal(repaired.settings.recipientError, null)
  f.values.set('qqMailRecipient', 'invalid@example.com')
  const cleared = f.service.clearRecipient()
  assert.equal(cleared.ok, true)
  assert.equal(cleared.settings.recipientError, null)
  assert.equal(cleared.settings.recipientEmail, '')
})

test('recipient persistence errors are reported without losing the saved default or exposing storage errors', () => {
  const f = fixture({}, { setSetting: () => { throw new Error('private database failure') } })
  f.values.set('qqMailRecipient', '123456789@qq.com')
  for (const result of [f.service.saveRecipient('987654321@qq.com'), f.service.clearRecipient()]) {
    assert.equal(result.ok, false)
    assert.ok(!result.message.includes('private database failure'))
  }
  assert.equal(f.service.getSettings().recipientEmail, '123456789@qq.com')
  assert.equal(f.checks.length, 0)
})

const notification = { type: 'send_email', subject: '任务完成', body: '处理已完成。\n请检查结果。' }
const send = (f, source = 'call-a', input = notification, controller = new AbortController(), current = () => true) =>
  f.service.sendNotification(input, source, controller.signal, current)
function configured(overrides = {}, storeOverrides = {}) {
  const f = fixture(overrides, storeOverrides)
  f.service.save(draft)
  f.service.saveRecipient('987654321@qq.com')
  return f
}

test('a notification uses only saved addresses and decrypted credentials; public results and claims contain no secrets or body', async () => {
  const sent = [], f = configured({ send: async message => { sent.push(message) } })
  assert.equal(f.service.availability().available, true)
  const result = await send(f)
  assert.equal(result.status, 'sent')
  assert.equal(result.ok, true)
  assert.deepEqual(sent, [{ auth: { user: draft.senderEmail, pass: code }, recipientEmail: '987654321@qq.com',
    subject: notification.subject, body: notification.body }])
  assert.equal(f.checks.length, 0, 'sending must not add a separate login probe')
  const claims = [...f.values].filter(([key]) => key.startsWith('qqMailDelivery:'))
  assert.equal(claims.length, 1)
  assert.ok(!JSON.stringify([result, claims]).includes(code))
  assert.ok(!JSON.stringify(claims).includes(notification.body))
})

test('missing or broken configuration fails without connecting to SMTP', async () => {
  let attempts = 0
  const f = fixture({ send: async () => { attempts++ } })
  assert.equal(f.service.availability().available, false)
  assert.equal((await send(f)).status, 'failed')
  f.service.save(draft)
  assert.equal((await send(f)).status, 'failed')
  f.values.set('qqMailRecipient', 'other@example.com')
  assert.equal((await send(f)).status, 'failed')
  f.service.saveRecipient('987654321@qq.com')
  f.values.set('qqMail', '{broken')
  assert.equal((await send(f)).status, 'failed')
  assert.equal(attempts, 0)
})

test('recipient overrides, header injection and empty or oversized content cannot trigger SMTP', async () => {
  let attempts = 0
  const f = configured({ send: async () => { attempts++ } })
  for (const input of [
    { ...notification, to: 'elsewhere@qq.com' }, { ...notification, command: 'anything' },
    { ...notification, subject: 'one\r\nBcc: x@qq.com' }, { ...notification, subject: ' ' },
    { ...notification, subject: 'x'.repeat(201) }, { ...notification, body: '' },
    { ...notification, body: 'x'.repeat(20001) }, { ...notification, body: '\0' }, null
  ]) assert.equal((await send(f, 'invalid', input)).status, 'failed')
  assert.equal(attempts, 0)
})

test('duplicate and restarted calls return the durable result without sending twice', async () => {
  let attempts = 0
  const f = configured({ send: async () => { attempts++ } })
  const first = await send(f)
  assert.deepEqual(await send(f), first)
  assert.deepEqual(await f.restart().sendNotification(notification, 'call-a', new AbortController().signal, () => true), first)
  assert.equal(attempts, 1)
  assert.equal((await send(f, 'new-human-call')).status, 'sent')
  assert.equal(attempts, 2)
})

test('a concurrent duplicate or a restart with an interrupted claim never repeats the external effect', async () => {
  let finish, attempts = 0
  const f = configured({ send: () => { attempts++; return new Promise(resolve => { finish = resolve }) } })
  const first = send(f)
  assert.equal((await send(f)).status, 'unknown')
  assert.equal((await f.restart().sendNotification(notification, 'call-a', new AbortController().signal, () => true)).status, 'unknown')
  assert.equal(attempts, 1)
  finish()
  assert.equal((await first).status, 'sent')
})

test('auth failures and uncertain SMTP outcomes are sanitized, persisted and never automatically retried', async () => {
  for (const [codeValue, expected] of [['EAUTH', 'failed'], ['EUNCERTAIN', 'unknown']]) {
    let attempts = 0
    const f = configured({ send: async () => { attempts++; throw Object.assign(new Error(`server echoed ${code}`), { code: codeValue }) } })
    const result = await send(f)
    assert.equal(result.status, expected)
    assert.ok(!JSON.stringify(result).includes(code))
    assert.equal((await send(f)).status, expected)
    assert.equal(attempts, 1)
  }
})

test('cancelled or stale calls never start SMTP and a changed configuration revokes the transaction guard', async () => {
  let attempts = 0, guard
  const f = configured({ send: async (_message, _signal, current) => { attempts++; guard = current } })
  const controller = new AbortController(); controller.abort()
  assert.equal((await send(f, 'aborted', notification, controller)).status, 'cancelled')
  assert.equal((await send(f, 'stale', notification, new AbortController(), () => false)).status, 'cancelled')
  assert.equal(attempts, 0)
  await send(f)
  assert.equal(guard(), true)
  f.service.saveRecipient('new@qq.com')
  assert.equal(guard(), false)
})

test('failing the durable claim prevents SMTP; failing the final record keeps acceptance and prevents replay', async () => {
  for (const failAt of [1, 2]) {
    let attempts = 0, claimWrites = 0
    const f = configured({ send: async () => { attempts++ } })
    const originalStore = {
      getSetting: key => f.values.get(key) ?? null,
      setSetting(key, value) {
        if (key.startsWith('qqMailDelivery:') && ++claimWrites === failAt) throw new Error('disk failure')
        f.values.set(key, value)
      }
    }
    const service = new QqMailService(originalStore, {
      encryptionAvailable: () => true, encrypt: value => value,
      decrypt: value => Buffer.from(value.slice(7), 'base64').toString(), verify: async () => {},
      send: async () => { attempts++ }
    })
    const result = await service.sendNotification(notification, 'call-a', new AbortController().signal, () => true)
    assert.equal(result.status, failAt === 1 ? 'failed' : 'sent')
    assert.equal(attempts, failAt === 1 ? 0 : 1)
    if (failAt === 2) {
      assert.equal((await service.sendNotification(notification, 'call-a', new AbortController().signal, () => true)).status, 'unknown')
      assert.equal(attempts, 1)
    }
  }
})
