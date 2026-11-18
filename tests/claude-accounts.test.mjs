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
const sharedPlatformAccounts = load(join(root, 'src/shared/platform-accounts.ts'))
const sharedFocusChat = load(join(root, 'src/shared/focus-chat.ts'))
const sharedTools = load(join(root, 'src/shared/conversation-tools.ts'))
const mainAccounts = load(join(root, 'src/main/claude-accounts.ts'))
const platformAccounts = load(join(root, 'src/main/platform-accounts.ts'))
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

test('Gemini accounts are stored, restored, cleared, and isolated independently from Claude', async () => {
  const store = memoryStore()
  const geminiWork = platformAccounts.newPlatformAccount('Gemini 工作号')
  const geminiPersonal = platformAccounts.newPlatformAccount('Gemini 个人号')
  const claudeWork = platformAccounts.newPlatformAccount('Claude 工作号')
  platformAccounts.savePlatformAccount(store, 'gemini', geminiWork)
  platformAccounts.savePlatformAccount(store, 'gemini', geminiPersonal)
  platformAccounts.savePlatformAccount(store, 'claude', claudeWork)

  assert.deepEqual(platformAccounts.listPlatformAccounts(store, 'gemini').map(item => item.id),
    [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, geminiWork.id, geminiPersonal.id])
  assert.deepEqual(platformAccounts.listPlatformAccounts(store, 'claude').map(item => item.id),
    [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, claudeWork.id])

  assert.throws(() => platformAccounts.removePlatformAccount(store, 'gemini', sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID), /默认账号不能删除/)
  assert.throws(() => platformAccounts.removePlatformAccount(store, 'gemini', claudeWork.id), /Gemini 账号不可用/)

  const remaining = platformAccounts.removePlatformAccount(store, 'gemini', geminiWork.id)
  assert.deepEqual(remaining.map(item => item.id), [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, geminiPersonal.id])

  const restored = platformAccounts.restorePlatformWorkspace(
    'gemini',
    JSON.stringify({
      accountId: geminiWork.id,
      locations: {
        [geminiWork.id]: 'https://gemini.google.com/app/1111222233334444',
        [geminiPersonal.id]: 'https://gemini.google.com/app/aaaabbbbccccdddd',
        [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID]: 'https://accounts.google.com/v3/signin'
      }
    }),
    remaining
  )
  assert.equal(restored.accountId, sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID)
  assert.equal(restored.locations.has(geminiWork.id), false)
  assert.equal(restored.locations.get(geminiPersonal.id), 'https://gemini.google.com/app/aaaabbbbccccdddd')
  assert.equal(restored.locations.has(sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID), false)

  partitionCalls.clear()
  await platformAccounts.clearPlatformAccountPartition('gemini', sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID)
  await platformAccounts.clearPlatformAccountPartition('gemini', geminiPersonal.id)
  assert.deepEqual(partitionCalls.get(`persist:gemini-${geminiPersonal.id}`), {
    closeAllConnections: 1,
    clearStorageData: 1,
    clearCache: 1,
    clearAuthCache: 1
  })
})

test('Gemini account scopes isolate drafts, owner keys, saved compaction checks, and scheduled tasks', () => {
  const store = memoryStore()
  const tools = new ConversationTools('session-1', store)
  const geminiA = '33333333-3333-4333-8333-333333333333'
  const geminiB = '44444444-4444-4444-8444-444444444444'

  tools.setAccountScope('gemini', geminiA)
  tools.update('gemini', null, { fileReadingEnabled: false })
  tools.setAccountScope('gemini', geminiB)
  assert.equal(tools.read('gemini', null).fileReadingEnabled, true)
  tools.update('gemini', null, { backgroundTasksEnabled: false })
  tools.clearPlatformAccountDraft('gemini', geminiA)
  tools.setAccountScope('gemini', geminiA)
  assert.equal(tools.read('gemini', null).fileReadingEnabled, true)
  tools.setAccountScope('gemini', geminiB)
  assert.equal(tools.read('gemini', null).backgroundTasksEnabled, false)

  const ownerDefault = { sessionId: 'session-1', platformId: 'gemini', conversationId: null }
  const ownerA = { sessionId: 'session-1', platformId: 'gemini', conversationId: null, accountId: geminiA }
  assert.notEqual(sharedFocusChat.focusOwnerKey(ownerDefault), sharedFocusChat.focusOwnerKey(ownerA))
  assert.equal(sharedTools.sameConversationToolsOwner(ownerDefault, ownerA), false)

  const key = compaction.compactionStorageKey('session-1')
  store.setSetting(key, JSON.stringify({
    version: 1,
    state: { phase: 'paused', generationPlatformId: 'gemini', generationAccountId: geminiA }
  }))
  assert.equal(compaction.savedCompactionUsesAccount(store, 'session-1', undefined, 'gemini', geminiA), true)
  assert.equal(compaction.savedCompactionUsesAccount(store, 'session-1', undefined, 'claude', geminiA), false)

  const db = new DatabaseSync(':memory:')
  const taskStore = new ScheduledTaskStore(db)
  const scheduler = new ScheduledTasks(taskStore, {
    now: () => 1_700_000_000_000,
    ready: () => null,
    changed: () => {},
    schedule: () => ({ unref() {} }),
    cancel: () => {}
  })
  const target = { machineId: 'm1', transport: 'local', key: 'm1', cwd: 'C:\\proj', label: '本机' }
  const req = { type: 'scheduled_task', schedule: { kind: 'interval', minutes: 30 }, prompt: '检查状态' }
  scheduler.create({ sessionId: 's1', platformId: 'gemini', conversationId: '1111111111111111', accountId: geminiA }, target, req, 'g-1')
  scheduler.create({ sessionId: 's1', platformId: 'gemini', conversationId: '2222222222222222', accountId: geminiB }, target, req, 'g-2')
  scheduler.create({ sessionId: 's1', platformId: 'gemini', conversationId: '3333333333333333' }, target, req, 'g-3')

  assert.equal(taskStore.platformAccountTasks('gemini', geminiA).length, 1)
  scheduler.removePlatformAccount('gemini', geminiA)
  assert.equal(taskStore.platformAccountTasks('gemini', geminiA).length, 0)
  assert.equal(taskStore.tasks('s1').length, 2)
})

test('DeepSeek accounts are stored, restored, cleared, and isolated independently', async () => {
  const store = memoryStore()
  const deepseekWork = platformAccounts.newPlatformAccount('DeepSeek 工作号')
  const deepseekPersonal = platformAccounts.newPlatformAccount('DeepSeek 个人号')
  const claudeWork = platformAccounts.newPlatformAccount('Claude 工作号')
  platformAccounts.savePlatformAccount(store, 'deepseek', deepseekWork)
  platformAccounts.savePlatformAccount(store, 'deepseek', deepseekPersonal)
  platformAccounts.savePlatformAccount(store, 'claude', claudeWork)

  assert.deepEqual(platformAccounts.listPlatformAccounts(store, 'deepseek').map(item => item.id),
    [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, deepseekWork.id, deepseekPersonal.id])
  assert.deepEqual(platformAccounts.listPlatformAccounts(store, 'claude').map(item => item.id),
    [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, claudeWork.id])

  assert.throws(() => platformAccounts.removePlatformAccount(store, 'deepseek', sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID), /默认账号不能删除/)
  assert.throws(() => platformAccounts.removePlatformAccount(store, 'deepseek', claudeWork.id), /DeepSeek 账号不可用/)

  const remaining = platformAccounts.removePlatformAccount(store, 'deepseek', deepseekWork.id)
  assert.deepEqual(remaining.map(item => item.id), [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, deepseekPersonal.id])

  const restored = platformAccounts.restorePlatformWorkspace(
    'deepseek',
    JSON.stringify({
      accountId: deepseekWork.id,
      locations: {
        [deepseekWork.id]: 'https://chat.deepseek.com/a/chat/s/ds_work_chat',
        [deepseekPersonal.id]: 'https://chat.deepseek.com/a/chat/s/ds_personal_chat',
        [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID]: 'https://chat.deepseek.com/sign_in'
      }
    }),
    remaining
  )
  assert.equal(restored.accountId, sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID)
  assert.equal(restored.locations.has(deepseekWork.id), false)
  assert.equal(restored.locations.get(deepseekPersonal.id), 'https://chat.deepseek.com/a/chat/s/ds_personal_chat')
  assert.equal(restored.locations.has(sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID), false)

  partitionCalls.clear()
  await platformAccounts.clearPlatformAccountPartition('deepseek', sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID)
  await platformAccounts.clearPlatformAccountPartition('deepseek', deepseekPersonal.id)
  assert.deepEqual(partitionCalls.get(`persist:deepseek-${deepseekPersonal.id}`), {
    closeAllConnections: 1,
    clearStorageData: 1,
    clearCache: 1,
    clearAuthCache: 1
  })
})

test('DeepSeek account scopes isolate drafts, owner keys, saved compaction checks, and scheduled tasks', () => {
  const store = memoryStore()
  const tools = new ConversationTools('session-1', store)
  const deepseekA = '55555555-5555-4555-8555-555555555555'
  const deepseekB = '66666666-6666-4666-8666-666666666666'

  tools.setAccountScope('deepseek', deepseekA)
  tools.update('deepseek', null, { fileReadingEnabled: false })
  tools.setAccountScope('deepseek', deepseekB)
  assert.equal(tools.read('deepseek', null).fileReadingEnabled, true)
  tools.update('deepseek', null, { backgroundTasksEnabled: false })
  tools.clearPlatformAccountDraft('deepseek', deepseekA)
  tools.setAccountScope('deepseek', deepseekA)
  assert.equal(tools.read('deepseek', null).fileReadingEnabled, true)
  tools.setAccountScope('deepseek', deepseekB)
  assert.equal(tools.read('deepseek', null).backgroundTasksEnabled, false)

  const ownerDefault = { sessionId: 'session-1', platformId: 'deepseek', conversationId: null }
  const ownerA = { sessionId: 'session-1', platformId: 'deepseek', conversationId: null, accountId: deepseekA }
  assert.notEqual(sharedFocusChat.focusOwnerKey(ownerDefault), sharedFocusChat.focusOwnerKey(ownerA))
  assert.equal(sharedTools.sameConversationToolsOwner(ownerDefault, ownerA), false)

  const key = compaction.compactionStorageKey('session-1')
  store.setSetting(key, JSON.stringify({
    version: 1,
    state: { phase: 'paused', generationPlatformId: 'deepseek', generationAccountId: deepseekA }
  }))
  assert.equal(compaction.savedCompactionUsesAccount(store, 'session-1', undefined, 'deepseek', deepseekA), true)
  assert.equal(compaction.savedCompactionUsesAccount(store, 'session-1', undefined, 'gemini', deepseekA), false)

  const db = new DatabaseSync(':memory:')
  const taskStore = new ScheduledTaskStore(db)
  const scheduler = new ScheduledTasks(taskStore, {
    now: () => 1_700_000_000_000,
    ready: () => null,
    changed: () => {},
    schedule: () => ({ unref() {} }),
    cancel: () => {}
  })
  const target = { machineId: 'm1', transport: 'local', key: 'm1', cwd: 'C:\\proj', label: '本机' }
  const req = { type: 'scheduled_task', schedule: { kind: 'interval', minutes: 30 }, prompt: '检查状态' }
  scheduler.create({ sessionId: 's1', platformId: 'deepseek', conversationId: 'ds_chat_1', accountId: deepseekA }, target, req, 'ds-1')
  scheduler.create({ sessionId: 's1', platformId: 'deepseek', conversationId: 'ds_chat_2', accountId: deepseekB }, target, req, 'ds-2')
  scheduler.create({ sessionId: 's1', platformId: 'deepseek', conversationId: 'ds_chat_3' }, target, req, 'ds-3')

  assert.equal(taskStore.platformAccountTasks('deepseek', deepseekA).length, 1)
  scheduler.removePlatformAccount('deepseek', deepseekA)
  assert.equal(taskStore.platformAccountTasks('deepseek', deepseekA).length, 0)
  assert.equal(taskStore.tasks('s1').length, 2)
})

test('ChatGPT accounts are stored, restored, cleared, and isolated independently', async () => {
  const store = memoryStore()
  const chatgptWork = platformAccounts.newPlatformAccount('ChatGPT 工作号')
  const chatgptPersonal = platformAccounts.newPlatformAccount('ChatGPT 个人号')
  const claudeWork = platformAccounts.newPlatformAccount('Claude 工作号')
  platformAccounts.savePlatformAccount(store, 'chatgpt', chatgptWork)
  platformAccounts.savePlatformAccount(store, 'chatgpt', chatgptPersonal)
  platformAccounts.savePlatformAccount(store, 'claude', claudeWork)

  assert.deepEqual(platformAccounts.listPlatformAccounts(store, 'chatgpt').map(item => item.id),
    [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, chatgptWork.id, chatgptPersonal.id])
  assert.deepEqual(platformAccounts.listPlatformAccounts(store, 'claude').map(item => item.id),
    [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, claudeWork.id])

  assert.throws(() => platformAccounts.removePlatformAccount(store, 'chatgpt', sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID), /默认账号不能删除/)
  assert.throws(() => platformAccounts.removePlatformAccount(store, 'chatgpt', claudeWork.id), /ChatGPT 账号不可用/)

  const remaining = platformAccounts.removePlatformAccount(store, 'chatgpt', chatgptWork.id)
  assert.deepEqual(remaining.map(item => item.id), [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID, chatgptPersonal.id])

  const restored = platformAccounts.restorePlatformWorkspace(
    'chatgpt',
    JSON.stringify({
      accountId: chatgptWork.id,
      locations: {
        [chatgptWork.id]: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
        [chatgptPersonal.id]: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222',
        [sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID]: 'https://auth.openai.com/log-in'
      }
    }),
    remaining
  )
  assert.equal(restored.accountId, sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID)
  assert.equal(restored.locations.has(chatgptWork.id), false)
  assert.equal(restored.locations.get(chatgptPersonal.id), 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222')
  assert.equal(restored.locations.has(sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID), false)

  partitionCalls.clear()
  await platformAccounts.clearPlatformAccountPartition('chatgpt', sharedPlatformAccounts.DEFAULT_PLATFORM_ACCOUNT_ID)
  await platformAccounts.clearPlatformAccountPartition('chatgpt', chatgptPersonal.id)
  assert.deepEqual(partitionCalls.get(`persist:chatgpt-${chatgptPersonal.id}`), {
    closeAllConnections: 1,
    clearStorageData: 1,
    clearCache: 1,
    clearAuthCache: 1
  })
})

test('ChatGPT account scopes isolate drafts, owner keys, saved compaction checks, and scheduled tasks', () => {
  const store = memoryStore()
  const tools = new ConversationTools('session-1', store)
  const chatgptA = '77777777-7777-4777-8777-777777777777'
  const chatgptB = '88888888-8888-4888-8888-888888888888'

  tools.setAccountScope('chatgpt', chatgptA)
  tools.update('chatgpt', null, { fileReadingEnabled: false })
  tools.setAccountScope('chatgpt', chatgptB)
  assert.equal(tools.read('chatgpt', null).fileReadingEnabled, true)
  tools.update('chatgpt', null, { backgroundTasksEnabled: false })
  tools.clearPlatformAccountDraft('chatgpt', chatgptA)
  tools.setAccountScope('chatgpt', chatgptA)
  assert.equal(tools.read('chatgpt', null).fileReadingEnabled, true)
  tools.setAccountScope('chatgpt', chatgptB)
  assert.equal(tools.read('chatgpt', null).backgroundTasksEnabled, false)

  const ownerDefault = { sessionId: 'session-1', platformId: 'chatgpt', conversationId: null }
  const ownerA = { sessionId: 'session-1', platformId: 'chatgpt', conversationId: null, accountId: chatgptA }
  assert.notEqual(sharedFocusChat.focusOwnerKey(ownerDefault), sharedFocusChat.focusOwnerKey(ownerA))
  assert.equal(sharedTools.sameConversationToolsOwner(ownerDefault, ownerA), false)

  const key = compaction.compactionStorageKey('session-1')
  store.setSetting(key, JSON.stringify({
    version: 1,
    state: { phase: 'paused', generationPlatformId: 'chatgpt', generationAccountId: chatgptA }
  }))
  assert.equal(compaction.savedCompactionUsesAccount(store, 'session-1', undefined, 'chatgpt', chatgptA), true)
  assert.equal(compaction.savedCompactionUsesAccount(store, 'session-1', undefined, 'deepseek', chatgptA), false)

  const db = new DatabaseSync(':memory:')
  const taskStore = new ScheduledTaskStore(db)
  const scheduler = new ScheduledTasks(taskStore, {
    now: () => 1_700_000_000_000,
    ready: () => null,
    changed: () => {},
    schedule: () => ({ unref() {} }),
    cancel: () => {}
  })
  const target = { machineId: 'm1', transport: 'local', key: 'm1', cwd: 'C:\\proj', label: '本机' }
  const req = { type: 'scheduled_task', schedule: { kind: 'interval', minutes: 30 }, prompt: '检查状态' }
  scheduler.create({ sessionId: 's1', platformId: 'chatgpt', conversationId: '11111111-1111-4111-8111-111111111111', accountId: chatgptA }, target, req, 'gpt-1')
  scheduler.create({ sessionId: 's1', platformId: 'chatgpt', conversationId: '22222222-2222-4222-8222-222222222222', accountId: chatgptB }, target, req, 'gpt-2')
  scheduler.create({ sessionId: 's1', platformId: 'chatgpt', conversationId: '33333333-3333-4333-8333-333333333333' }, target, req, 'gpt-3')

  assert.equal(taskStore.platformAccountTasks('chatgpt', chatgptA).length, 1)
  scheduler.removePlatformAccount('chatgpt', chatgptA)
  assert.equal(taskStore.platformAccountTasks('chatgpt', chatgptA).length, 0)
  assert.equal(taskStore.tasks('s1').length, 2)
})
