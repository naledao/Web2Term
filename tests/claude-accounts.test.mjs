// User-run only: node --test tests/claude-accounts.test.mjs
// Offline unit tests for Claude account removal and cleanup helpers. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const partitionCalls = new Map()
const fakeElectron = {
  session: {
    fromPartition(partition) {
      let record = partitionCalls.get(partition)
      if (!record) {
        record = { closeAllConnections: 0, clearStorageData: 0, clearCache: 0, clearAuthCache: 0 }
        partitionCalls.set(partition, record)
      }
      return {
        async setProxy() {},
        async closeAllConnections() { record.closeAllConnections += 1 },
        async clearStorageData() { record.clearStorageData += 1 },
        async clearCache() { record.clearCache += 1 },
        async clearAuthCache() { record.clearAuthCache += 1 }
      }
    }
  }
}

const modules = new Map()
function load(path) {
  path = resolve(path)
  if (modules.has(path)) return modules.get(path)
  const exports = {}
  modules.set(path, exports)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  new Script(code, { filename: path }).runInNewContext({
    exports,
    Buffer,
    process,
    URL,
    Intl,
    console,
    AbortController,
    structuredClone,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === 'electron') return fakeElectron
      if (name.startsWith('node:')) return nodeRequire(name)
      assert.ok(name.startsWith('.'), 'Unexpected dependency in offline test: ' + name)
      return load(resolve(dirname(path), name + '.ts'))
    }
  })
  return exports
}

const sharedAccounts = load(join(root, 'src/shared/claude-accounts.ts'))
const mainAccounts = load(join(root, 'src/main/claude-accounts.ts'))
const { ConversationTools } = load(join(root, 'src/main/conversation-tools.ts'))
const compaction = load(join(root, 'src/main/conversation-compaction.ts'))
const { ScheduledTaskStore } = load(join(root, 'src/main/scheduled-task-store.ts'))
const { ScheduledTasks } = load(join(root, 'src/main/scheduled-tasks.ts'))

function memoryStore() {
  const map = new Map()
  return {
    getSetting(key) { return map.get(key) ?? null },
    setSetting(key, value) { map.set(key, value) },
    setSettings(values) { for (const [key, value] of Object.entries(values)) map.set(key, value) }
  }
}

test('removeClaudeAccount rejects default, invalid, or unknown ids and keeps remaining accounts', () => {
  const store = memoryStore()
  const work = mainAccounts.newClaudeAccount('工作账号')
  const personal = mainAccounts.newClaudeAccount('个人账号')
  mainAccounts.saveClaudeAccount(store, work)
  mainAccounts.saveClaudeAccount(store, personal)

  assert.throws(() => mainAccounts.removeClaudeAccount(store, sharedAccounts.DEFAULT_CLAUDE_ACCOUNT_ID), /默认账号不能删除/)
  assert.throws(() => mainAccounts.removeClaudeAccount(store, 'not-a-uuid'), /Claude 账号不可用/)
  assert.throws(() => mainAccounts.removeClaudeAccount(store, '00000000-0000-4000-8000-000000000000'), /Claude 账号不可用/)

  const remaining = mainAccounts.removeClaudeAccount(store, work.id)
  assert.deepEqual(remaining.map(item => item.id), [sharedAccounts.DEFAULT_CLAUDE_ACCOUNT_ID, personal.id])
  assert.deepEqual(mainAccounts.listClaudeAccounts(store).map(item => item.id), [sharedAccounts.DEFAULT_CLAUDE_ACCOUNT_ID, personal.id])

  const restored = mainAccounts.restoreClaudeWorkspace(
    JSON.stringify({
      accountId: work.id,
      locations: {
        [work.id]: 'https://claude.ai/chat/11111111-1111-4111-8111-111111111111',
        [personal.id]: 'https://claude.ai/chat/22222222-2222-4222-8222-222222222222'
      }
    }),
    remaining
  )
  assert.equal(restored.accountId, sharedAccounts.DEFAULT_CLAUDE_ACCOUNT_ID)
  assert.equal(restored.locations.has(work.id), false)
  assert.equal(restored.locations.has(personal.id), true)
})

test('clearClaudeAccountPartition cleans only custom account partitions', async () => {
  partitionCalls.clear()
  await mainAccounts.clearClaudeAccountPartition(sharedAccounts.DEFAULT_CLAUDE_ACCOUNT_ID)
  await mainAccounts.clearClaudeAccountPartition('invalid')
  assert.equal(partitionCalls.size, 0)

  const id = '11111111-1111-4111-8111-111111111111'
  await mainAccounts.clearClaudeAccountPartition(id)
  assert.deepEqual(partitionCalls.get(`persist:claude-${id}`), {
    closeAllConnections: 1,
    clearStorageData: 1,
    clearCache: 1,
    clearAuthCache: 1
  })
})

test('ConversationTools.clearClaudeAccountDraft isolates and clears only the target draft scope', () => {
  const store = memoryStore()
  const tools = new ConversationTools('session-1', store)
  const accountA = '11111111-1111-4111-8111-111111111111'
  const accountB = '22222222-2222-4222-8222-222222222222'

  tools.claudeAccountId = accountA
  tools.update('claude', null, { fileReadingEnabled: false })
  tools.submitted('claude')
  tools.markPromptInjected('claude', null)

  tools.claudeAccountId = accountB
  tools.update('claude', null, { fileReadingEnabled: false })

  tools.clearClaudeAccountDraft(accountA)

  tools.claudeAccountId = accountA
  assert.equal(tools.read('claude', null).fileReadingEnabled, true)
  assert.equal(tools.hasInjectedPrompt('claude', null), false)

  tools.claudeAccountId = accountB
  assert.equal(tools.read('claude', null).fileReadingEnabled, false)
})

test('savedCompactionUsesClaudeAccount identifies resumable handoff jobs targeting an account', () => {
  const store = memoryStore()
  const targetAccount = '11111111-1111-4111-8111-111111111111'
  const key = compaction.compactionStorageKey('session-1')

  store.setSetting(key, JSON.stringify({
    version: 1,
    state: { phase: 'paused', generationPlatformId: 'claude', generationAccountId: targetAccount }
  }))
  assert.equal(compaction.savedCompactionUsesClaudeAccount(store, 'session-1', undefined, targetAccount), true)
  assert.equal(compaction.savedCompactionUsesClaudeAccount(store, 'session-1', undefined, '22222222-2222-4222-8222-222222222222'), false)

  store.setSetting(key, JSON.stringify({
    version: 1,
    state: { phase: 'ready-to-export', generationPlatformId: 'claude', generationAccountId: targetAccount }
  }))
  assert.equal(compaction.savedCompactionUsesClaudeAccount(store, 'session-1', undefined, targetAccount), false)
})

test('ScheduledTasks.removeClaudeAccount deletes only scheduled tasks owned by the deleted account', () => {
  const db = new DatabaseSync(':memory:')
  const store = new ScheduledTaskStore(db)
  const changed = []
  const scheduler = new ScheduledTasks(store, {
    now: () => 1_700_000_000_000,
    ready: () => null,
    changed: id => changed.push(id),
    schedule: () => ({ unref() {} }),
    cancel: () => {}
  })
  const accountA = '11111111-1111-4111-8111-111111111111'
  const accountB = '22222222-2222-4222-8222-222222222222'
  const target = { machineId: 'm1', transport: 'local', key: 'm1', cwd: 'C:\\proj', label: '本机' }
  const req = { type: 'scheduled_task', schedule: { kind: 'interval', minutes: 30 }, prompt: '检查状态' }

  scheduler.create({ sessionId: 's1', platformId: 'claude', conversationId: 'chat-1', claudeAccountId: accountA }, target, req, 'src-1')
  scheduler.create({ sessionId: 's2', platformId: 'claude', conversationId: 'chat-2', claudeAccountId: accountB }, target, req, 'src-2')
  scheduler.create({ sessionId: 's1', platformId: 'claude', conversationId: 'chat-3' }, target, req, 'src-3')

  assert.equal(store.claudeAccountTasks(accountA).length, 1)
  assert.equal(scheduler.hasSendingClaudeAccount(accountA), false)

  scheduler.removeClaudeAccount(accountA)

  assert.equal(store.claudeAccountTasks(accountA).length, 0)
  assert.equal(store.tasks('s1').length, 1)
  assert.equal(store.tasks('s1')[0].owner.conversationId, 'chat-3')
  assert.equal(store.tasks('s2').length, 1)
  assert.ok(changed.includes('s1'))
})
