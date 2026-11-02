// User-run only: node --test tests/conversation-compaction.test.mjs
// Executes the real snapshot builder and workflow with fake pages. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { setImmediate as immediate } from 'node:timers/promises'
import { test } from 'node:test'
import ts from 'typescript'

const requireNative = createRequire(import.meta.url), modules = new Map()
function load(path) {
  path = resolve(path)
  if (modules.has(path)) return modules.get(path)
  const exports = {}
  modules.set(path, exports)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  new Script(code, { filename: path }).runInNewContext({ exports, Buffer, process, URL, AbortController, structuredClone,
    setTimeout, clearTimeout, require(name) {
      if (name.startsWith('node:')) return requireNative(name)
      assert.ok(name.startsWith('.'), 'No runtime dependency on Electron or third-party services: ' + name)
      return load(resolve(dirname(path), name + '.ts'))
    } })
  return exports
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shared = load(join(root, 'src/shared/conversation-compaction.ts'))
const { ConversationCompaction } = load(join(root, 'src/main/conversation-compaction.ts'))
const owner = { sessionId: 'original-session', platformId: 'chatgpt', conversationId: 'original-chat' }
const source = () => ({ owner, title: '原会话', capturedAt: 1_700_000_000_000, environment: '本机 C:\\project',
  messages: [{ id: 'u1', conversationId: owner.conversationId, role: 'user', sourceMessageId: null,
    content: '保留用户约束，不要主动运行测试', attachments: [], createdAt: 1 }], turns: [], executions: [], hiddenMessageIds: [] })
const seed = () => ({ session: { id: owner.sessionId, title: '原会话', platformId: owner.platformId, conversationId: owner.conversationId,
  projectId: 'project-a', url: 'https://chatgpt.com/', paused: false, promptInjectionEnabled: true, localCwd: 'C:\\project',
  sshHostId: '', sshAttached: false, sshReconnect: false, sshCwd: '', sendDelaySeconds: 3, createdAt: 1 },
  preferences: { fileReadingEnabled: true, backgroundTasksEnabled: false, scheduledTasksEnabled: false, mailNotificationsEnabled: false,
    computerUseEnabled: false, desktopControlEnabled: false, desktopPointClickEnabled: false, computerResultDelaySeconds: 0 } })
const complete = id => shared.COMPACTION_SECTIONS.map(section => '## ' + section + '\n无记录').join('\n\n') + '\n' + shared.compactionEndMarker(id)

test('skill trigger respects line starts, URLs, search text and caret position', () => {
  assert.equal(shared.compactionSkillQuery('//', 2).matches, true)
  assert.equal(shared.compactionSkillQuery('草稿\n  //压缩', 9).matches, true)
  assert.equal(shared.compactionSkillQuery('//nothing', 9).matches, false)
  assert.equal(shared.compactionSkillQuery('https://example.com', 19), null)
  assert.equal(shared.compactionSkillQuery('value // comment', 16), null)
  assert.equal(shared.compactionSkillQuery('///', 3), null)
  assert.equal(shared.compactionSkillQuery('//', -1), null)
})

test('active-branch export deduplicates rows, excludes reasoning and retains executor evidence and missing attachments', () => {
  const input = source()
  input.messages.push({ ...input.messages[0], id: 'replaced', content: '撤销的旧分支', createdAt: 2 },
    { ...input.messages[0], id: 'a1', role: 'assistant', sourceMessageId: 'reply-a', content: '重复存储的旧答案', createdAt: 3 })
  input.hiddenMessageIds = ['replaced']
  input.turns = [{ id: 'turn-a', userMessageId: 'u1', userText: input.messages[0].content, createdAt: 1, status: 'answered',
    userAttachments: [{ fileName: '设计.pdf' }], segments: [{ cycle: 0, sourceMessageId: 'reply-a', answer: '构建通过，等待测试',
      settled: true, parts: [{ kind: 'reasoning', text: '不导出的思考内容' }] }], toolCalls: [], executionIds: [] }]
  input.executions = [{ messageId: 'exec-1', conversationId: owner.conversationId, kind: 'command', command: 'npm run build',
    description: '构建', status: 'done', exitCode: 0, output: 'build passed', deliveryStatus: 'sent', fileRequest: null }]
  const { markdown } = shared.compactionSourceMarkdown(input)
  assert.equal(markdown.split(input.messages[0].content).length - 1, 1)
  assert.ok(markdown.includes('构建通过，等待测试'))
  assert.ok(markdown.includes('npm run build') && markdown.includes('build passed'))
  assert.ok(markdown.includes('设计.pdf') && markdown.includes('不包含原附件字节'))
  for (const excluded of ['撤销的旧分支', '重复存储的旧答案', '不导出的思考内容']) assert.ok(!markdown.includes(excluded))
  assert.throws(() => shared.compactionSourceMarkdown({ ...input, messages: [{ ...input.messages[0], conversationId: 'another' }] }), /其他会话/)
})

test('oversize sources fail without silently truncating; long logs explicitly mark the omitted middle', () => {
  const input = source()
  input.messages[0].content = '你'.repeat(80_001)
  assert.throws(() => shared.compactionSourceMarkdown(input), /单次压缩预算/)
  input.messages[0].content = '请检查'
  input.executions = [{ messageId: 'log', conversationId: owner.conversationId, kind: 'command', command: 'build',
    status: 'done', output: 'x'.repeat(20_000) + '最终错误', exitCode: 1, fileRequest: null }]
  const { markdown } = shared.compactionSourceMarkdown(input)
  assert.ok(markdown.includes('字符省略') && markdown.includes('最终错误'))
})

test('summary requires this job’s visible end marker and all sections; unreadable input cannot become success', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  assert.ok(shared.parseCompactionSummary(id, complete(id)).includes('用户约束'))
  assert.ok(!shared.parseCompactionSummary(id, complete(id)).includes('W2T_COMPACTION_END'))
  assert.throws(() => shared.parseCompactionSummary(id, complete('another-job')), /结束标记/)
  assert.throws(() => shared.parseCompactionSummary(id, '短摘要\n' + shared.compactionEndMarker(id)), /交接结构/)
  assert.throws(() => shared.parseCompactionSummary(id, complete(id) + '\nW2T_COMPACTION_INPUT_INCOMPLETE'), /无法完整读取/)
})

test('missing historical material is retained as background while actual file-read failure remains blocking', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const prompt = shared.compactionPrompt(id), handoff = shared.compactionHandoffPrompt(id)
  assert.ok(prompt.includes('输入范围仅为 source.md 本身'))
  assert.ok(prompt.includes('这些情况不影响基于已读快照生成成功摘要'))
  assert.ok(handoff.includes('不表示本次摘要附件读取失败'))
  const summary = complete(id).replace('## 缺失信息与未验证事项\n无记录',
    '## 缺失信息与未验证事项\n已读取 source.md 全部 2164 行；原历史和原附件不完整，项目状态待验证。')
  assert.ok(shared.parseCompactionSummary(id, summary).includes('原历史和原附件不完整'))
  assert.throws(() => shared.parseCompactionSummary(id, summary + '\nW2T_COMPACTION_INPUT_INCOMPLETE'), /文件正文无法完整读取/)
})

test('protocol decisions use the final line, so quoted failures inside a successful summary are not transport failures', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const summary = complete(id).replace('## 关键决定与失败尝试\n无记录',
    '## 关键决定与失败尝试\n上一轮错误地输出了 W2T_COMPACTION_INPUT_INCOMPLETE，已纠正范围。')
  assert.ok(shared.parseCompactionSummary(id, summary).includes('已纠正范围'))
  assert.throws(() => shared.parseCompactionSummary(id, summary.replace(shared.compactionEndMarker(id), '引用：' + shared.compactionEndMarker(id))), /结束标记/)
  assert.equal(shared.parseCompactionHandoff(id, '已接收；摘要记录过 W2T_HANDOFF_INPUT_INCOMPLETE。\n' + shared.compactionHandoffMarker(id)),
    '已接收；摘要记录过 W2T_HANDOFF_INPUT_INCOMPLETE。')
  assert.throws(() => shared.parseCompactionHandoff(id, 'summary.md 只读到部分。\nW2T_HANDOFF_INPUT_INCOMPLETE'), /文件正文/)
})

test('relative budgets prevent the observed 5.1K to 5.8K expansion and reserve transport overhead', () => {
  const budget = shared.compactionBudget(5100)
  assert.equal(budget.maxSummaryTokens, 2550)
  assert.ok(budget.targetSummaryTokens <= 2000)
  assert.equal(budget.maxContextTokens, 3570)
  assert.throws(() => shared.checkCompactionSummaryBudget('你'.repeat(5251), budget), /摘要过长/)
  const id = '11111111-1111-4111-8111-111111111111'
  const after = shared.checkCompactionContextBudget(id, '你'.repeat(budget.maxSummaryTokens), '已读取交接摘要，等待下一条消息。', budget)
  assert.ok(after < budget.beforeTokens && after <= budget.maxContextTokens)
  assert.throws(() => shared.checkCompactionContextBudget(id, '你'.repeat(2000), '你'.repeat(2500), budget), /超过压缩预算/)
  assert.throws(() => shared.compactionBudget(800), /上下文较短/)
  const long = shared.compactionBudget(80_000)
  assert.ok(long.maxSummaryTokens <= 3000)
})

test('checkpoint prompt preserves continuation state without requesting a fixed-length narrative', () => {
  const id = '11111111-1111-4111-8111-111111111111', budget = shared.compactionBudget(5100)
  const prompt = shared.compactionPrompt(id, budget)
  assert.ok(prompt.includes('上下文检查点') && prompt.includes('当前停点'))
  assert.ok(prompt.includes('最新有效更正覆盖旧说法') && prompt.includes('已完成任务不能变回未完成'))
  assert.ok(prompt.includes('不逐层复述旧摘要') && prompt.includes('不抄完整脚本'))
  assert.ok(prompt.includes('等待用户下一条消息') && prompt.includes('授权边界'))
  assert.ok(prompt.includes(String(budget.maxSummaryTokens)))
  assert.ok(!prompt.includes('3,000～5,000'))
  assert.ok(shared.compactionRecoveryPrompt(id, budget).includes(String(budget.maxSummaryTokens)))
  assert.ok(shared.compactionHandoffPrompt(id).includes('不要复述目标、待办或摘要'))
})

function fixture(t, settings = new Map(), settingsOptions = {}) {
  const subjectOwner = { ...owner, platformId: settingsOptions.platformId ?? owner.platformId }
  const directory = mkdtempSync(join(tmpdir(), 'web2term-compaction-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = [], records = new Map(), created = [], pages = []
  let clock = 1_000, failTarget = settingsOptions.failTarget === true
  const options = { sessionId: owner.sessionId, directory, store: { getSetting: key => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, value) }, canWork: () => true,
    now: () => clock, pause: async () => { clock += 900; await immediate() },
    createTarget: (job, summary) => {
      if (failTarget) { failTarget = false; throw new Error('创建工作区失败') }
      created.push({ id: job.targetId, summary, seed: job.seed })
      return job.targetId
    }, makePage: (platform, url, onUrl) => {
      const page = { url, visible: false, available: true, close() { this.available = false; this.visible = false }, setTheme() {}, setOwnerVisible(value) { this.visible = value },
        setViewport(_bounds, visible) { this.visible = visible },
        async read(marker) {
          const record = records.get(this.url)
          return { ready: true, nativeDraft: false, uploadReady: true, generating: 'idle', hasHistory: !!record,
            requestFound: record?.marker === marker, answer: record?.answer ?? '', replyId: record ? this.url : '',
            cutOff: false, sendFailure: false, oversized: false }
        }, async send(path, prompt, signal, _current, beforeSubmit) {
          const content = await readFile(path, 'utf8')
          signal.throwIfAborted()
          beforeSubmit()
          const stored = JSON.parse(settings.get('conversationCompaction:' + owner.sessionId))
          const handoff = path.endsWith('summary.md'), delivery = handoff ? stored.handoffDelivery : stored.sourceDelivery
          assert.equal(delivery, 'uncertain', 'dispatch intent is durable before a page submit')
          calls.push({ handoff, content, prompt })
          this.url = (platform === 'deepseek' ? 'https://chat.deepseek.com/a/chat/s/' : 'https://chatgpt.com/c/') +
            (handoff ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111')
          records.set(this.url, { marker: shared.compactionRequestMarker(stored.state.id, handoff), answer: handoff
            ? (settingsOptions.verboseHandoff ? '你'.repeat(6000) : '已接收上下文') + '\n' + shared.compactionHandoffMarker(stored.state.id)
            : settingsOptions.verboseSummary ? complete(stored.state.id).replace('## 当前目标\n无记录', '## 当前目标\n' + '你'.repeat(6000))
              : settingsOptions.incomplete ? '输出被截断' : settingsOptions.historyGap ?
              complete(stored.state.id).replace('## 缺失信息与未验证事项\n无记录', '## 缺失信息与未验证事项\n文件已读完，历史附件原件未提供。') : complete(stored.state.id) })
          onUrl(this.url)
          return settingsOptions.unknown && calls.length === 1 ? 'unknown' : 'ok'
        } }
      pages.push(page)
      return page
    } }
  let service = new ConversationCompaction(options)
  t.after(() => service.dispose())
  return { directory, options, records, calls, settings, created, pages, owner: subjectOwner, get service() { return service },
    async start() { return service.start(subjectOwner, async () => ({ contextTokens: 6000, source: { ...source(), owner: subjectOwner },
      seed: { ...seed(), session: { ...seed().session, platformId: subjectOwner.platformId } } })) },
    restart() { service.dispose(); service = new ConversationCompaction(options); return service } }
}
async function settled(f) {
  for (let attempt = 0; attempt < 2000 && f.service.busy; attempt++) await immediate()
  assert.equal(f.service.busy, false, 'workflow settles without real timers')
  return f.service.state(f.owner)
}

test('oversize model summaries stop before creating C and can be manually corrected on the same B page', async t => {
  const f = fixture(t, new Map(), { verboseSummary: true })
  await f.start()
  const state = await settled(f)
  assert.equal(state.phase, 'failed')
  assert.equal(state.hasSummary, false)
  assert.ok(state.message.includes('摘要过长'))
  assert.equal(f.calls.length, 1)
  assert.equal(f.created.length, 0)
  assert.ok(f.service.recoveryPrompt().includes('3000'))
  for (const record of f.records.values()) record.answer = complete(state.id)
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.filter(call => !call.handoff).length, 1)
})

test('unexpectedly verbose handoff acknowledgements cannot be installed as a successful compression', async t => {
  const f = fixture(t, new Map(), { verboseHandoff: true })
  await f.start()
  const state = await settled(f)
  assert.equal(state.phase, 'failed')
  assert.ok(state.message.includes('超过压缩预算'))
  assert.equal(f.calls.length, 2)
  assert.equal(f.created.length, 0)
  const submissions = f.calls.length
  await f.service.resume(owner)
  assert.equal(f.calls.length, submissions, 'retry never repeats the oversized imported context')
})

test('short contexts stay in the source workspace without creating any processing pages', async t => {
  const f = fixture(t)
  await assert.rejects(f.service.start(owner, async () => ({ source: source(), seed: seed(), contextTokens: 800 })), /上下文较短/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.pages.length, 0)
})

test('restart after workspace adoption recovers completion without reopening or resubmitting', async t => {
  const f = fixture(t)
  await f.start()
  const completed = await settled(f)
  const stored = JSON.parse(f.settings.get('conversationCompaction:' + owner.sessionId))
  stored.state.phase = 'importing'
  stored.state.targetSessionId = null
  f.settings.set('conversationCompaction:' + owner.sessionId, JSON.stringify(stored))
  f.options.isAdopted = job => job.state.id === completed.id
  const pageCount = f.pages.length, sendCount = f.calls.length
  f.restart()
  assert.equal(f.service.state(f.owner).phase, 'completed')
  assert.equal(f.service.state(f.owner).targetSessionId, owner.sessionId)
  assert.equal(f.pages.length, pageCount)
  assert.equal(f.calls.length, sendCount)
})

test('full workflow sends two distinct files, saves the summary and inherits frozen session settings', async t => {
  const f = fixture(t)
  await f.start()
  const state = await settled(f)
  assert.equal(state.phase, 'completed')
  assert.equal(state.workerVisible, false)
  assert.ok(f.pages.every(page => !page.visible), 'the complete workflow never opens its native pages')
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].handoff, false)
  assert.equal(f.calls[1].handoff, true)
  assert.ok(f.calls[0].content.includes('不要主动运行测试'))
  assert.ok(f.calls[1].content.includes('## 用户约束'))
  assert.ok(!f.calls[1].content.includes('W2T_COMPACTION_END'))
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].seed.session.projectId, 'project-a')
  assert.equal(f.created[0].seed.preferences.computerUseEnabled, false)
  assert.equal(await readFile(join(f.directory, state.id, 'summary.md'), 'utf8'), f.calls[1].content)
  assert.equal(f.service.state({ ...owner, conversationId: 'another' }), null)
})

test('ambiguous submit survives restart and is checked without submitting source.md twice', async t => {
  const f = fixture(t, new Map(), { unknown: true })
  await f.start()
  assert.equal((await settled(f)).phase, 'uncertain')
  assert.equal(f.calls.length, 1)
  f.restart()
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.filter(call => !call.handoff).length, 1)
  assert.equal(f.calls.filter(call => call.handoff).length, 1)
  assert.ok(f.pages.every(page => !page.visible), 'restart recovery does not require a visible slot')
})

test('DeepSeek uses its own home and conversation identity throughout both submits', async t => {
  const f = fixture(t, new Map(), { platformId: 'deepseek' })
  await f.start()
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
  assert.ok([...f.records.keys()].every(url => url.startsWith('https://chat.deepseek.com/a/chat/s/')))
  assert.equal(f.created[0].seed.session.platformId, 'deepseek')
})

test('invalid summary stops before handoff; manual completion resumes the existing B conversation', async t => {
  const f = fixture(t, new Map(), { incomplete: true })
  await f.start()
  const state = await settled(f)
  assert.equal(state.phase, 'failed')
  assert.equal(state.hasSummary, false)
  assert.equal(f.calls.length, 1)
  const recovery = f.service.recoveryPrompt()
  assert.ok(recovery.includes(shared.compactionEndMarker(state.id)))
  assert.ok(recovery.includes('无需重新上传或补齐原始历史'))
  for (const record of f.records.values()) record.answer = complete(state.id)
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
})

test('history gaps in a successfully read snapshot do not stop either provider from completing the handoff', async t => {
  for (const platformId of ['chatgpt', 'deepseek']) {
    const f = fixture(t, new Map(), { platformId, historyGap: true })
    await f.start()
    assert.equal((await settled(f)).phase, 'completed')
    assert.equal(f.calls.length, 2)
    assert.ok(f.calls[1].content.includes('历史附件原件未提供'))
  }
})

test('confirmed handoff survives a restart before target registration without reopening or resending', async t => {
  const f = fixture(t, new Map(), { failTarget: true })
  await f.start()
  assert.equal((await settled(f)).phase, 'failed')
  const before = f.calls.length
  f.restart()
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, before)
})

test('target creation retry reuses saved handoff and does not resend either attachment', async t => {
  const f = fixture(t, new Map(), { failTarget: true })
  await f.start()
  assert.equal((await settled(f)).phase, 'failed')
  assert.equal(f.calls.length, 2)
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
})

test('a modified saved snapshot is rejected before recovery sends anything', async t => {
  const f = fixture(t, new Map(), { unknown: true })
  await f.start()
  const state = await settled(f)
  await writeFile(join(f.directory, state.id, 'source.md'), 'modified', 'utf8')
  await f.service.resume(owner)
  assert.ok(f.service.state(owner).message.includes('已被修改'))
  assert.equal(f.calls.length, 1)
})

test('cancel retains exported files and cannot continue the cancelled job', async t => {
  const f = fixture(t, new Map(), { unknown: true })
  await f.start()
  const state = await settled(f)
  f.service.cancel()
  await f.service.resume(owner)
  assert.equal(f.service.state(owner).phase, 'cancelled')
  assert.ok((await readFile(join(f.directory, state.id, 'source.md'), 'utf8')).includes('不要主动运行测试'))
  assert.equal(f.calls.length, 1)
})

test('an emergency pause requires explicit recovery and retains the submitted conversation', async t => {
  const f = fixture(t, new Map(), { unknown: true })
  await f.start()
  await settled(f)
  f.service.pauseTask('全局急停')
  assert.equal(f.service.state(owner).phase, 'paused')
  assert.equal(f.calls.length, 1)
  await immediate()
  assert.equal(f.calls.length, 1, 'the paused workflow cannot wake itself')
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
})

test('troubleshooting pages open only on request and hiding them does not disable background recovery', async t => {
  const f = fixture(t, new Map(), { incomplete: true })
  await f.start()
  const state = await settled(f)
  assert.equal(state.phase, 'failed')
  assert.equal(state.workerVisible, false)
  f.service.setViewport(owner, state.id, { x: 0, y: 0, width: 800, height: 500 }, true)
  assert.equal(f.pages[0].visible, false, 'a stray rectangle cannot open a hidden worker')
  f.service.showPage()
  assert.equal(f.service.state(owner).workerVisible, true)
  f.service.setViewport(owner, state.id, { x: 0, y: 0, width: 800, height: 500 }, true)
  assert.equal(f.pages[0].visible, true)
  f.service.hide()
  assert.equal(f.service.state(owner).workerVisible, false)
  assert.equal(f.pages[0].visible, false)
  assert.equal(f.pages[0].available, true)
  for (const record of f.records.values()) record.answer = complete(state.id)
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
})
