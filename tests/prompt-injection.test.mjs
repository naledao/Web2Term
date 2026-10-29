// User-run only: node --test tests/prompt-injection.test.mjs
// Actual injection planner, real terminal prompt builder and ledger persistence with in-memory SQLite.
// No Electron, real page, shell or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, structuredClone, require(name) {
      const value = dependencies[name] ?? progressVmModules[name]
      assert.ok(value, 'Unexpected test dependency: ' + name)
      return value
    }
  })
  return exports
}
function methods(path, name, names) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name)
  const body = names.map(name => declaration.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
  return new Script(compile(`class Subject { ${body} }; Subject`)).runInNewContext({ structuredClone })
}

const injection = load('../src/shared/prompt-injection.ts')
const files = load('../src/shared/file-requests.ts')
const background = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': background })
const { ConversationTools } = load('../src/main/conversation-tools.ts', {
  '../shared/conversation-tools': load('../src/shared/conversation-tools.ts'),
  './computer-use-settings': load('../src/main/computer-use-settings.ts'),
  '../shared/prompt-injection': injection
})
const Store = methods('../src/main/db.ts', 'ConversationStore', ['getSetting', 'setSetting', 'setSettings'])
const { planInjection, commitInjection, addInjectionTraffic, noteInjectionViolation, parseInjectionLedger, splitPromptSections } = injection

const linux = { ...types.FALLBACK_ENVIRONMENT, kind: 'posix', osCaption: 'Ubuntu 24.04', shellPath: '/bin/bash', workingDirectory: '/srv/app', detected: true }
const tools = '【工具目录】\n以下只列出当前对话可用工具的摘要，不含调用格式：\n- read_files：读取文件。'
const prefix = (env = linux, toolPrompt = tools) => types.buildTerminalPromptParts(env, toolPrompt).prefix
const sent = (ledger, plan) => commitInjection(ledger, plan, 1)
const plain = value => JSON.parse(JSON.stringify(value))

test('the real prompt splits into its headed sections and keeps inline markers inside them', () => {
  const sections = splitPromptSections(prefix())
  const keys = sections.map(section => section.key)
  for (const heading of ['【角色】', '【任务路由】', '【工作协议】', '【需要执行时】', '【执行环境】', '【工具目录】']) assert.ok(keys.includes(heading), heading)
  assert.ok(!keys.includes('【上一条命令执行结果】'), 'an inline marker does not start a section')
  assert.equal(new Set(keys).size, keys.length, 'repeated headings get distinct keys')
})

test('a new conversation gets the full prompt, an unchanged one only the anchor, and the anchor commits no sections', () => {
  const first = planInjection(null, prefix(), 'chatgpt')
  assert.equal(first.mode, 'full'); assert.equal(first.reason, 'no-ledger'); assert.equal(first.prefix, prefix())
  const ledger = sent(null, first)
  const next = planInjection(ledger, prefix(), 'chatgpt')
  assert.equal(next.mode, 'none'); assert.equal(next.reason, 'unchanged')
  assert.ok(next.prefix.length < 60 && next.prefix.endsWith('\n\n'), 'the anchor is one short line before the separator')
  const after = sent(ledger, next)
  assert.deepEqual(plain(after.sections), plain(ledger.sections))
  assert.equal(after.charsSinceFull, next.prefix.length); assert.equal(after.sendsSinceFull, 1)
})

test('a changed tool catalog or note sends only those sections and names a removed one', () => {
  const ledger = sent(null, planInjection(null, prefix(), 'deepseek'))
  const changedTools = planInjection(ledger, prefix(linux, tools + '\n- send_email：发送邮件。'), 'deepseek')
  assert.equal(changedTools.mode, 'delta'); assert.deepEqual(plain(changedTools.changed), ['【工具目录】'])
  assert.ok(changedTools.prefix.startsWith('【提示词更新】') && changedTools.prefix.includes('send_email'))
  assert.ok(!changedTools.prefix.includes('【工作协议】'), 'unchanged sections stay out of the delta')
  assert.ok(changedTools.prefix.length < prefix().length / 3)

  const noted = sent(ledger, planInjection(ledger, prefix({ ...linux, extraNotes: '用 pnpm' }), 'deepseek'))
  const withoutNotes = planInjection(noted, prefix(), 'deepseek')
  assert.equal(withoutNotes.mode, 'delta'); assert.deepEqual(plain(withoutNotes.removed), ['【用户补充】'])
  assert.ok(withoutNotes.prefix.includes('以下分段已不再适用：【用户补充】'))
})

test('a different machine resends its machine sections but not the shared reply contract', () => {
  const ledger = sent(null, planInjection(null, prefix(), 'chatgpt'))
  const windows = { ...types.FALLBACK_ENVIRONMENT, kind: 'windows', detected: true }
  const plan = planInjection(ledger, prefix(windows), 'chatgpt')
  assert.ok(['delta', 'full'].includes(plan.mode))
  if (plan.mode === 'delta') {
    assert.ok(plan.changed.includes('【执行环境】'))
    assert.ok(!plan.changed.includes('【角色】') && !plan.prefix.includes('【角色】'))
    assert.ok(!plan.changed.includes('【工作协议】') && !plan.prefix.includes('【工作协议】'))
  } else assert.equal(plan.reason, 'mostly-changed')
  const rewritten = planInjection(ledger, prefix(windows, tools.replace('读取文件', '读取任意文件'.repeat(2000))), 'chatgpt')
  assert.equal(rewritten.mode, 'full'); assert.equal(rewritten.reason, 'mostly-changed')
})

test('one violation resends the reply contract, a second one or a used-up budget resends everything', () => {
  const ledger = sent(null, planInjection(null, prefix(), 'chatgpt'))
  const reminder = planInjection(noteInjectionViolation(ledger), prefix(), 'chatgpt')
  assert.equal(reminder.mode, 'reminder')
  assert.ok(reminder.prefix.startsWith('【约定提醒】') && reminder.prefix.includes('【需要执行时】') && reminder.prefix.includes('"command"'))
  const completion = splitPromptSections(prefix()).find(section => section.heading === '【任务完成】')
  assert.ok(completion && reminder.prefix.includes(completion.text), 'the reminder retains the full completion contract, including when not to finish')
  assert.equal(sent(noteInjectionViolation(ledger), reminder).violations, 0, 'the reminder clears the violation')

  assert.equal(planInjection(noteInjectionViolation(noteInjectionViolation(ledger)), prefix(), 'chatgpt').reason, 'violations')
  const busy = addInjectionTraffic(ledger, injection.injectionBudget('chatgpt'))
  assert.equal(planInjection(busy, prefix(), 'chatgpt').reason, 'budget')
  assert.equal(sent(busy, planInjection(busy, prefix(), 'chatgpt')).charsSinceFull, 0)
  assert.ok(injection.injectionBudget('gemini') > injection.injectionBudget('chatgpt'))
  assert.equal(addInjectionTraffic(ledger, -5), ledger)
})

test('ledgers survive a restart per conversation; a draft ledger lives in memory and moves to the new id', t => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  t.after(() => db.close())
  const store = Object.assign(new Store(), { db })
  const choices = new ConversationTools('workspace-a', store)
  const ledger = sent(null, planInjection(null, prefix(), 'chatgpt'))
  choices.setInjectionLedger('chatgpt', 'chat-a', ledger)
  assert.deepEqual(plain(new ConversationTools('workspace-b', store).injectionLedger('chatgpt', 'chat-a')), plain(ledger))
  assert.equal(choices.injectionLedger('deepseek', 'chat-a'), null, 'platforms do not share ledgers')

  choices.setInjectionLedger('chatgpt', null, ledger)
  assert.equal(new ConversationTools('workspace-a', store).injectionLedger('chatgpt', null), null, 'a draft is never persisted')
  choices.bind('chatgpt', null, 'chat-b')
  assert.deepEqual(plain(choices.injectionLedger('chatgpt', 'chat-b')), plain(ledger))
  assert.equal(choices.injectionLedger('chatgpt', null), null)

  choices.setInjectionLedger('chatgpt', null, ledger)
  choices.bind('chatgpt', 'chat-b', null)
  assert.equal(choices.injectionLedger('chatgpt', null), null, 'leaving for a new chat drops a stale draft')
  choices.setInjectionLedger('chatgpt', 'chat-a', null)
  assert.equal(choices.injectionLedger('chatgpt', 'chat-a'), null)
  assert.equal(parseInjectionLedger('{"v":2}'), null); assert.equal(parseInjectionLedger('not json'), null)
})
