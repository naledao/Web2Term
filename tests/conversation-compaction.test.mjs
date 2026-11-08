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
const complete = () => shared.COMPACTION_SECTIONS.map(section => '## ' + section + '\n无记录').join('\n\n')

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

test('sources above the former token and character limits retain the complete conversation text', () => {
  for (const content of ['你'.repeat(80_001), 'a'.repeat(300_001)]) {
    const input = source()
    input.messages[0].content = '对话开始\n' + content + '\n对话结束'
    const { markdown, messageCount, tokens } = shared.compactionSourceMarkdown(input)
    assert.ok(markdown.includes(input.messages[0].content), 'the complete conversation is exported without truncation')
    assert.equal(messageCount, 1)
    if (content.startsWith('你')) {
      assert.ok(tokens > 80_000 && markdown.length < 300_000, 'exceeds only the former token limit')
    } else {
      assert.ok(markdown.length > 300_000 && tokens < 80_000, 'exceeds only the former character limit')
    }
  }
})

test('long logs explicitly mark the omitted middle', () => {
  const input = source()
  input.messages[0].content = '请检查'
  input.executions = [{ messageId: 'log', conversationId: owner.conversationId, kind: 'command', command: 'build',
    status: 'done', output: 'x'.repeat(20_000) + '最终错误', exitCode: 1, fileRequest: null }]
  const { markdown } = shared.compactionSourceMarkdown(input)
  assert.ok(markdown.includes('字符省略') && markdown.includes('最终错误'))
})

test('the whole finished reply is kept without any marker, section or length check', () => {
  assert.equal(shared.compactionReplyText('\r\n只有一句话\r\n'), '只有一句话')
  const fenced = '```markdown\n## 当前目标\n无记录\n```'
  assert.equal(shared.compactionReplyText(fenced), fenced, 'wrapping fences are part of the output too')
  const long = '你'.repeat(80_000)
  assert.equal(shared.compactionReplyText(long), long)
  const quoted = complete() + '\nW2T_COMPACTION_INPUT_INCOMPLETE'
  assert.equal(shared.compactionReplyText(quoted), quoted, 'former protocol lines are ordinary text')
})

test('prompts no longer ask for end or failure markers', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  for (const prompt of [shared.compactionPrompt(id), shared.compactionRecoveryPrompt(id), shared.compactionHandoffPrompt(id)]) {
    for (const marker of ['W2T_COMPACTION_END', 'W2T_COMPACTION_INPUT_INCOMPLETE', 'W2T_HANDOFF_READY', 'W2T_HANDOFF_INPUT_INCOMPLETE', '结束标记']) {
      assert.ok(!prompt.includes(marker), marker)
    }
  }
  assert.ok(shared.compactionPrompt(id).includes('输入范围仅为 source.md 本身'))
  assert.ok(shared.compactionPrompt(id).split('\n').at(-1) === '任务标识：' + shared.compactionRequestMarker(id))
  assert.ok(shared.compactionHandoffPrompt(id).split('\n').at(-1) === '任务标识：' + shared.compactionRequestMarker(id, true))
})

test('relative budgets guide the prompt length and reserve transport overhead', () => {
  const budget = shared.compactionBudget(5100)
  assert.equal(budget.maxSummaryTokens, 2550)
  assert.ok(budget.targetSummaryTokens <= 2000)
  assert.equal(budget.maxContextTokens, 3570)
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
    now: () => clock, pause: async () => { clock += 900; await settingsOptions.beforePause?.(); await immediate() },
    createTarget: (job, summary) => {
      if (failTarget) { failTarget = false; throw new Error('创建工作区失败') }
      created.push({ id: job.targetId, summary, seed: job.seed })
      return job.targetId
    }, makePage: (platform, url, onUrl) => {
      const page = { url, visible: false, available: true, draft: !!settingsOptions.draft, clears: 0,
        close() { this.available = false; this.visible = false }, setTheme() {}, setOwnerVisible(value) { this.visible = value },
        async clearDraft() { this.clears++; if (settingsOptions.draft === 'stuck') return false; this.draft = false; return true },
        setViewport(_bounds, visible) { this.visible = visible },
        async read(marker) {
          const record = records.get(this.url)
          await settingsOptions.beforeRead?.({ record, page: this })
          return { ready: true, nativeDraft: this.draft, uploadReady: true, generating: 'idle', hasHistory: !!record,
            requestFound: record?.marker === marker, answer: record?.answer ?? '', replyId: record ? this.url : '',
            cutOff: !!record?.cutOff, sendFailure: false, oversized: false }
        }, async send(path, prompt, signal, current, beforeSubmit) {
          assert.equal(this.draft, false, 'a leftover composer draft is never sent with the request')
          const handoff = path.endsWith('summary.md')
          const content = await readFile(path, 'utf8')
          await settingsOptions.beforeSend?.({ handoff, signal, current, page: this })
          if (signal.aborted || !current()) return 'cancelled'
          beforeSubmit()
          const stored = JSON.parse(settings.get('conversationCompaction:' + owner.sessionId))
          const delivery = handoff ? stored.handoffDelivery : stored.sourceDelivery
          assert.equal(delivery, 'uncertain', 'dispatch intent is durable before a page submit')
          calls.push({ handoff, content, prompt })
          this.url = (platform === 'deepseek' ? 'https://chat.deepseek.com/a/chat/s/' : 'https://chatgpt.com/c/') +
            (handoff ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111')
          records.set(this.url, { marker: shared.compactionRequestMarker(stored.state.id, handoff), cutOff: !handoff && !!settingsOptions.cutOff,
            answer: handoff ? (settingsOptions.verboseHandoff ? '你'.repeat(6000) : '已接收上下文')
              : settingsOptions.verboseSummary ? complete().replace('## 当前目标\n无记录', '## 当前目标\n' + '你'.repeat(6000))
              : settingsOptions.cutOff ? '输出被截断' : settingsOptions.freeform ? '没有按章节写的摘要' : settingsOptions.historyGap ?
              complete().replace('## 缺失信息与未验证事项\n无记录', '## 缺失信息与未验证事项\n文件已读完，历史附件原件未提供。') : complete() })
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

// Use the actual runtime callbacks with the real workflow and synthetic pages.
// A permanently-true canWork stub would miss the workspace-switch regression.
const runtimePath = join(root, 'src/main/session-runtime.ts')
const runtimeAst = ts.createSourceFile(runtimePath, readFileSync(runtimePath, 'utf8'), ts.ScriptTarget.Latest, true)
const runtimeClass = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const runtimeMethods = ['ownsFocus', 'compactionService', 'summary'].map(name => runtimeClass.members.find(node => node.name?.getText(runtimeAst) === name).getText(runtimeAst))
const Runtime = new Script(ts.transpileModule(`class Runtime { ${runtimeMethods.join('\n')} }; Runtime`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText).runInNewContext({ join, app: { getPath: () => tmpdir() },
  supportsFocusView: load(join(root, 'src/shared/focus-chat.ts')).supportsFocusView,
  ConversationCompaction: class { constructor(options) { this.options = options } } })
function backgroundRuntime(f) {
  const selected = [], updates = [], state = { conversationId: f.owner.conversationId, blocked: false, executing: false }
  const sourceEmbed = { getState: () => ({ conversationId: state.conversationId }) }
  const otherPlatformId = f.owner.platformId === 'chatgpt' ? 'deepseek' : 'chatgpt'
  const runtime = Object.assign(new Runtime(), { id: f.owner.sessionId, active: true, disposed: false,
    activePlatformId: f.owner.platformId, customTitle: '来源聊天', createdAt: 1,
    embeds: new Map([[f.owner.platformId, { platform: { id: f.owner.platformId }, embed: sourceEmbed }],
      [otherPlatformId, { platform: { id: otherPlatformId }, embed: { getState: () => ({ conversationId: 'other-chat' }) } }]]),
    activeEmbed() { return this.embeds.get(this.activePlatformId) }, taskRunning: () => false,
    ssh: { getState: () => ({ attached: false }) },
    runner: { hasInFlightWork: () => state.executing }, options: { store: f.options.store,
      computerUseBlocked: () => state.blocked, onCompactionTargetOpen: id => selected.push(id),
      onSummaryChanged: () => updates.push(runtime.summary()) } })
  Object.defineProperty(runtime, 'embed', { get() { return this.embeds.get(this.activePlatformId).embed } })
  const options = runtime.compactionService().options
  runtime.compaction = f.service
  Object.assign(f.options, { canWork: options.canWork, canAdopt: options.canAdopt, onComplete: options.onComplete,
    onStateChanged: options.onStateChanged })
  return { runtime, state, selected, updates, otherPlatformId }
}

test('sidebar summaries publish background compression and clear the marker after completion', async t => {
  const hooks = {}, f = fixture(t, new Map(), hooks), { runtime, updates } = backgroundRuntime(f)
  assert.equal(runtime.summary().compacting, false)
  hooks.beforeSend = () => { runtime.active = false }
  await f.start()
  assert.equal((await settled(f)).phase, 'completed')
  assert.ok(updates.some(item => item.compacting), 'the sidebar receives progress without polling the selected chat')
  assert.ok(updates.every(item => item.id === f.owner.sessionId), 'only the source workspace owns this marker')
  assert.equal(updates.at(-1).compacting, false)
  assert.equal(runtime.summary().compacting, false)
})

test('a failed background compression clears its sidebar marker', async t => {
  const f = fixture(t, new Map(), { cutOff: true }), { runtime, updates } = backgroundRuntime(f)
  runtime.active = false
  await f.start()
  assert.equal((await settled(f)).phase, 'failed')
  assert.ok(updates.some(item => item.compacting))
  assert.equal(updates.at(-1).compacting, false)
})

test('workspace switches during uploads and summary generation finish in the background without taking focus', async t => {
  for (const platformId of ['chatgpt', 'deepseek']) {
    for (const stage of ['source-upload', 'summary-generation', 'summary-upload']) {
      await t.test(platformId + ': ' + stage, async t => {
        const hooks = { platformId }, f = fixture(t, new Map(), hooks), background = backgroundRuntime(f)
        let switched = false
        const switchAway = () => { background.runtime.active = false; f.service.hide(); switched = true }
        hooks.beforeSend = ({ handoff }) => {
          if (stage === (handoff ? 'summary-upload' : 'source-upload')) switchAway()
        }
        hooks.beforeRead = ({ record }) => { if (stage === 'summary-generation' && record) switchAway() }
        await f.start()
        const state = await settled(f)
        assert.equal(switched, true)
        assert.equal(state.phase, 'completed')
        assert.equal(f.calls.filter(call => !call.handoff).length, 1)
        assert.equal(f.calls.filter(call => call.handoff).length, 1)
        assert.equal(f.created.length, 1)
        assert.equal(f.created[0].seed.session.id, f.owner.sessionId)
        assert.equal(f.created[0].seed.session.platformId, platformId)
        assert.equal(background.runtime.active, false)
        assert.deepEqual(background.selected, [], 'completion must not select the source workspace')
        assert.ok(f.pages.every(page => !page.visible))
      })
    }
  }
})

test('switching platforms during upload finishes both exchanges and waits to adopt without resending', async t => {
  const hooks = {}, f = fixture(t, new Map(), hooks), background = backgroundRuntime(f)
  hooks.beforeSend = () => { background.runtime.activePlatformId = background.otherPlatformId; f.service.hide() }
  await f.start()
  let stored
  for (let attempt = 0; attempt < 2000; attempt++) {
    stored = JSON.parse(f.settings.get('conversationCompaction:' + f.owner.sessionId))
    if (stored.handoffAnswer) break
    await immediate()
  }
  assert.ok(stored.handoffAnswer, 'summary generation and import finish while another platform is selected')
  assert.equal(f.service.busy, true)
  assert.equal(f.created.length, 0, 'another platform must not be overwritten')
  assert.equal(f.calls.length, 2)
  assert.equal(background.runtime.activePlatformId, background.otherPlatformId)
  assert.equal(background.runtime.summary().compacting, true, 'the marker remains while adoption waits')
  background.runtime.activePlatformId = f.owner.platformId
  // Adoption can finish even if the user has since selected another workspace.
  background.runtime.active = false
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
  assert.equal(f.created.length, 1)
  assert.deepEqual(background.selected, [])
})

test('background compaction retains source ownership while global emergency remains independent', t => {
  const f = fixture(t), { runtime, state, otherPlatformId } = backgroundRuntime(f)
  runtime.active = false
  runtime.activePlatformId = otherPlatformId
  assert.equal(f.options.canWork(f.owner), true)
  assert.equal(f.options.canWork({ ...f.owner, sessionId: 'another-workspace' }), false)
  assert.equal(f.options.canWork({ ...f.owner, platformId: otherPlatformId }), false)
  state.conversationId = 'another-source'
  assert.equal(f.options.canWork(f.owner), false)
  state.conversationId = f.owner.conversationId
  state.blocked = true
  assert.equal(f.options.canWork(f.owner), true)
  state.blocked = false
  runtime.disposed = true
  assert.equal(f.options.canWork(f.owner), false)
})

test('a busy source delays background adoption until execution ends without repeating either exchange', async t => {
  const hooks = {}, f = fixture(t, new Map(), hooks), { runtime, state } = backgroundRuntime(f)
  runtime.active = false
  state.executing = true
  let deferred = false
  hooks.beforePause = () => {
    const stored = JSON.parse(f.settings.get('conversationCompaction:' + f.owner.sessionId))
    if (stored.handoffAnswer) {
      assert.equal(f.created.length, 0)
      assert.equal(f.calls.length, 2)
      deferred = true
      state.executing = false
    }
  }
  await f.start()
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(deferred, true)
  assert.equal(f.calls.length, 2)
})

test('cancel and emergency pause still stop a background upload and require explicit recovery', async t => {
  for (const action of ['cancel', 'pause']) {
    await t.test(action, async t => {
      const hooks = {}, f = fixture(t, new Map(), hooks), { runtime, updates } = backgroundRuntime(f)
      hooks.beforeSend = () => {
        runtime.active = false
        if (action === 'cancel') f.service.cancel()
        else f.service.pauseTask('全局急停')
      }
      await f.start()
      assert.equal((await settled(f)).phase, action === 'cancel' ? 'cancelled' : 'paused')
      runtime.active = true
      await immediate()
      assert.equal(f.service.busy, false)
      assert.equal(f.calls.length, 0)
      assert.equal(f.created.length, 0)
      assert.ok(f.pages.every(page => !page.available))
      assert.equal(updates.at(-1).compacting, false)
    })
  }
})

test('long, unstructured or verbose replies are saved in full and the compression completes', async t => {
  for (const options of [{ verboseSummary: true }, { freeform: true }, { verboseHandoff: true }]) {
    await t.test(Object.keys(options)[0], async t => {
      const f = fixture(t, new Map(), options)
      await f.start()
      const state = await settled(f)
      assert.equal(state.phase, 'completed')
      assert.equal(f.calls.length, 2)
      assert.equal(f.created.length, 1)
      const answer = [...f.records.values()].find(record => !record.marker.includes('HANDOFF')).answer
      assert.equal(await readFile(join(f.directory, state.id, 'summary.md'), 'utf8'), answer + '\n')
      const stored = JSON.parse(f.settings.get('conversationCompaction:' + owner.sessionId))
      assert.equal(stored.handoffAnswer, options.verboseHandoff ? '你'.repeat(6000) : '已接收上下文')
    })
  }
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

test('any leftover composer draft on the compression page is cleared before sending', async t => {
  const f = fixture(t, new Map(), { draft: true })
  await f.start()
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
  assert.ok(f.pages.every(page => page.clears === 1), 'each fresh page clears its restored draft once')
})

test('a composer draft that cannot be cleared stops before any submit', async t => {
  const f = fixture(t, new Map(), { draft: 'stuck' })
  await f.start()
  const state = await settled(f)
  assert.equal(state.phase, 'failed')
  assert.match(state.message, /无法清除/)
  assert.equal(f.calls.length, 0)
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

test('a platform cut-off stops before handoff; manual completion resumes the existing B conversation', async t => {
  const f = fixture(t, new Map(), { cutOff: true })
  await f.start()
  const state = await settled(f)
  assert.equal(state.phase, 'failed')
  assert.ok(state.message.includes('截断'))
  assert.equal(state.hasSummary, false)
  assert.equal(f.calls.length, 1)
  const recovery = f.service.recoveryPrompt()
  assert.ok(recovery.includes('从头重新完整输出交接摘要'))
  assert.ok(!recovery.includes('W2T_COMPACTION_END'))
  for (const record of f.records.values()) { record.answer = complete(); record.cutOff = false }
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
  const f = fixture(t, new Map(), { cutOff: true })
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
  for (const record of f.records.values()) { record.answer = complete(); record.cutOff = false }
  await f.service.resume(owner)
  assert.equal((await settled(f)).phase, 'completed')
  assert.equal(f.calls.length, 2)
})
