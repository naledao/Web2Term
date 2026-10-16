// User-run offline checks: temporary files only, no Electron, shell or network.
// Run: node --experimental-strip-types --test tests/command-log.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CommandDiagnosticLog, commandDiagnosticMetadata } from '../src/main/command-log.ts'

const context = {
  sessionId: 'session-a', conversationId: null, appVersion: '0.1.150',
  pageUrl: 'https://chatgpt.com/g/g-p-private-project/c/6ad1b11e-bec4-83e8-be6f-24834af50921'
}
const payload = { event: 'deferred', reason: 'missing-conversation', messageId: 'message-a', waiting: 1 }
const records = (path) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)))
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'command-log-test-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('missing conversation ids retain nested-route, version and session evidence', () => {
  const value = commandDiagnosticMetadata('chatgpt', payload, context)
  assert.equal(value.routeKind, 'chatgpt-nested-conversation')
  assert.equal(value.conversationId, null)
  assert.equal(value.reason, 'missing-conversation')
  assert.equal(value.sessionId, 'session-a')
  assert.equal(value.appVersion, '0.1.150')
  assert.equal(value.messageId, 'message-a')
  assert.equal(value.waiting, 1)
  assert.ok(!JSON.stringify(value).includes('private-project'))
})

test('records distinguish ordinary chats, other platforms and unavailable routes', () => {
  assert.equal(commandDiagnosticMetadata('chatgpt', payload, {
    ...context, pageUrl: 'https://chatgpt.com/c/6ad1b11e-bec4-83e8-be6f-24834af50921'
  }).routeKind, 'chatgpt-conversation')
  assert.equal(commandDiagnosticMetadata('chatgpt', payload, { ...context, pageUrl: 'https://chatgpt.com/' }).routeKind, 'other')
  assert.equal(commandDiagnosticMetadata('claude', payload, context).routeKind, 'other-platform')
  assert.equal(commandDiagnosticMetadata('chatgpt', payload, { ...context, pageUrl: 'invalid' }).routeKind, 'unavailable')
})

test('execution gates, shell outcome and result delivery preserve only recognized metadata', () => {
  const value = commandDiagnosticMetadata('chatgpt', {
    event: 'stored', reason: 'paused', messageId: 'message-a', ownerConversationId: 'conversation-a',
    mode: 'auto', paused: true, enabled: true, autoRun: false, live: true, status: 'pending',
    shellKind: 'windows', shellAlive: true, shellRunning: false, requestId: 1,
    exitCode: -2147024816, rejected: false, timedOut: false, interrupted: false,
    sessionLost: false, deliveryOutcome: 'busy'
  }, context)
  assert.equal(value.mode, 'auto')
  assert.equal(value.paused, true)
  assert.equal(value.autoRun, false)
  assert.equal(value.status, 'pending')
  assert.equal(value.exitCode, -2147024816)
  assert.equal(value.deliveryOutcome, 'busy')
  assert.equal(value.ownerConversationId, 'conversation-a')
})

test('commands, output, project names, error messages and invalid fields never enter default logs', () => {
  const secret = 'private-sentinel'
  const value = commandDiagnosticMetadata('chatgpt', {
    ...payload, reason: secret, messageId: `https://example.test/${secret}`, waiting: -1,
    commandLength: Infinity, enabled: secret, mode: secret, shellKind: secret, status: secret,
    deliveryOutcome: secret, command: secret, description: secret, output: secret,
    errorType: secret, errorMessage: secret, pageUrl: secret, projectName: secret,
    ownerConversationId: `C:\\${secret}`
  }, { ...context, appVersion: secret, sessionId: `C:\\${secret}` })
  assert.equal(value.reason, 'unknown')
  assert.equal(value.errorType, 'Other')
  assert.equal(value.messageId, null)
  assert.equal(value.ownerConversationId, null)
  assert.equal(value.sessionId, null)
  assert.equal(value.appVersion, null)
  assert.equal(value.waiting, undefined)
  assert.equal(value.commandLength, undefined)
  assert.equal(value.mode, undefined)
  assert.ok(!JSON.stringify(value).includes(secret))
})

test('command traces are written synchronously with optional app logging disabled', (t) => {
  const previous = process.env.DSH_APP_LOG
  process.env.DSH_APP_LOG = '0'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_APP_LOG
    else process.env.DSH_APP_LOG = previous
  })
  const log = new CommandDiagnosticLog(directory(t))
  const path = log.write('chatgpt', payload, context)
  assert.ok(path)
  assert.equal(records(path)[0].reason, 'missing-conversation')
  assert.equal(records(path)[0].sequence, 1)
})

test('rotation preserves earlier lifecycle records and per-platform separation', (t) => {
  const root = directory(t)
  const log = new CommandDiagnosticLog(root, 1)
  const first = log.write('chatgpt', payload, context)
  const second = log.write('chatgpt', { event: 'started', messageId: 'message-a' }, context)
  const other = log.write('claude', payload, context)
  assert.notEqual(first, second)
  assert.equal(readdirSync(root).length, 3)
  assert.equal(records(first)[0].event, 'deferred')
  assert.equal(records(second)[0].sequence, 2)
  assert.equal(records(other)[0].platformId, 'claude')
})

test('unrecognized events and failed writes never disrupt command execution', (t) => {
  const root = directory(t)
  const unused = join(root, 'unused')
  assert.equal(new CommandDiagnosticLog(unused).write('chatgpt', { event: 'unknown' }, context), null)
  assert.equal(existsSync(unused), false)
  const blocked = join(root, 'not-a-directory')
  writeFileSync(blocked, 'fixture')
  assert.doesNotThrow(() => assert.equal(new CommandDiagnosticLog(blocked).write('chatgpt', payload, context), null))
})
