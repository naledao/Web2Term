import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, FormEvent, JSX, ReactNode, RefObject } from 'react'
import MDEditor from '@uiw/react-md-editor'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import ConversationTranscript from './ConversationTranscript'
import FocusChart, { parseFocusChart } from './FocusChart'
import type { FocusChartData } from './FocusChart'
import FocusSmartUi, { FocusSmartUiContext } from './FocusSmartUi'
import FocusLayout from './FocusLayout'
import { cleanFocusCitationCopy, FocusCitationContext } from './FocusCitationLink'
import FocusMessageLink from './FocusMessageLink'
import { rehypeFocusFileLinks, cleanFocusFileLinkCopy } from '@shared/focus-file-links'
import FocusFilePreviewProvider from './FocusFilePreview'
import FocusComposerModes from './FocusComposerModes'
import FocusCompaction, { useConversationCompaction } from './FocusCompaction'
import FocusSkillIcon from './FocusSkillIcon'
import FocusMessageSkills from './FocusMessageSkills'
import { FOCUS_SKILLS, focusSkillQuery, validFocusToolSkills, focusSkillUnavailable } from '@shared/focus-skills'
import type { FocusSkillId, FocusToolSkill } from '@shared/focus-skills'
import type { ConversationToolsState } from '@shared/conversation-tools'
import FocusCodeBlock, { FocusCodeThemeContext } from './FocusCodeBlock'
import FocusTokenUsage from './FocusTokenUsage'
import FocusExecutionOutput from './FocusExecutionOutput'
import OutputText from './OutputText'
import { groupFocusExecutions, mergeFocusChatUpdate } from '@shared/focus-history'
import { estimateFocusConversation } from '@shared/focus-token-usage'
import FocusModelSettings from './FocusModelSettings'
import { parseFocusLayout } from '@shared/focus-layout'
import type { FocusLayoutData } from '@shared/focus-layout'
import { parseFocusUi } from '@shared/focus-smart-ui'
import type { FocusUiAction, FocusUiWidget } from '@shared/focus-smart-ui'
import type { FocusSendOutcome, FocusComposerModeId, FocusModelSettingKind, FocusOutboundFailure, FocusOutboundQueueItem, FocusOutboundQueueState } from '@shared/focus-chat'
import deepseekIcon from '../assets/DeepSeek.svg'
import chatgptIcon from '../assets/ChatGPT.svg'
// The view's brand icon per focus platform (`FOCUS_PLATFORMS`); a platform without one shows its name.
const FOCUS_ICONS: Readonly<Record<string, string>> = { deepseek: deepseekIcon, chatgpt: chatgptIcon }
import type { AppTheme, ConversationAttachment, ConversationMessage, ExecutionRecord } from '@shared/types'
import type { FocusChatState, FocusChatUpdate, FocusOwner, FocusTurn, FocusDelivery, FocusToolCall } from '@shared/focus-chat'
import { cleanFocusAnswer, cleanFocusUserText, focusOwnerKey, focusDelivery, focusPlatformLabel, supportsFocusEdit } from '@shared/focus-chat'
import { FOCUS_MAX_FILES, FOCUS_MAX_FILE_BYTES, FOCUS_MAX_BATCH_BYTES } from '@shared/focus-chat'
import type { FocusAttachmentInput } from '@shared/focus-chat'
import './FocusChatView.css'

interface Props {
  owner: FocusOwner
  viewConversationId?: string | null
  theme: AppTheme
  visible: boolean
  messages: ConversationMessage[]
  messagesReady: boolean
  needsAnswer: boolean
  newChatDisabled: boolean
  onNewChat(): void
  onQuestion(): void
  onOriginal(): void
  onOpenTerminal(): void
  onSkillSettings(skill: FocusToolSkill, trigger: HTMLButtonElement): void
  onRun(messageId: string): Promise<void>
  onSkip(messageId: string): Promise<void>
  onPreviewImage(source: string, name: string): void
  renderAttachment(attachment: ConversationAttachment): ReactNode
}
const processPositions = new Map<string, { top: number; pinned: boolean }>()
/** The expanded process scrolls on its own; preserve its reading position across lazy remounts. */
function ProcessScroll(props: { scrollKey: string; follow: boolean; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(processPositions.get(props.scrollKey)?.pinned ?? true)
  const follow = useRef(props.follow)
  const syncRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    const content = contentRef.current
    if (!element || !content) return
    const previous = processPositions.get(props.scrollKey)
    if (previous) element.scrollTop = previous.top
    const sync = (): void => {
      // A closed <details> has no viewport; retain the user's follow preference until it opens.
      if (follow.current && pinned.current && element.clientHeight > 0) element.scrollTop = element.scrollHeight
    }
    syncRef.current = sync
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    // The viewport stops growing at max-height, but new cards and late markdown still grow this wrapper.
    observer.observe(content)
    const details = element.closest('details.focus-process')
    details?.addEventListener('toggle', sync)
    sync()
    return () => {
      observer.disconnect()
      details?.removeEventListener('toggle', sync)
      syncRef.current = null
    }
  }, [])
  useLayoutEffect(() => {
    // Keep the final update in view when a working turn changes to completed.
    if (props.follow) follow.current = true
    syncRef.current?.()
    follow.current = props.follow
  })
  return <div className="focus-process__body" ref={ref} onScroll={event => {
    const element = event.currentTarget
    if (element.clientHeight === 0) return
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
    // Re-insert so eviction drops the least recently scrolled process, not the oldest one.
    processPositions.delete(props.scrollKey)
    if (processPositions.size >= 200) processPositions.delete(processPositions.keys().next().value!)
    processPositions.set(props.scrollKey, { top: element.scrollTop, pinned: pinned.current })
  }}><div className="focus-process__content" ref={contentRef}>{props.children}</div></div>
}
function ProcessHint(): JSX.Element {
  return <span className="focus-process__hint">查看过程
    <svg className="focus-process__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4" /></svg>
  </span>
}
function ComposerPendingIcon(): JSX.Element {
  return <svg className="focus-composer__pending-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
    <circle cx="3" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="13" cy="8" r="1.25" />
  </svg>
}
const labels: Record<string, string> = {
  pending: '等待确认', blocked: '等待确认', running: '正在执行', done: '执行完成',
  failed: '执行失败', timeout: '执行超时', interrupted: '已中断', skipped: '已跳过'
}
/*
 * Whether 查看过程 / 思考过程 / 查看命令与输出 blocks are open, per conversation owner.
 * The view unmounts on every switch to the original or local view, so DOM state alone came
 * back collapsed. Remember both open and closed choices so default-open processes stay
 * collapsed when the user closes them. Kept in memory for the app's lifetime.
 */
const detailStates = new Map<string, Map<string, boolean>>()
/** Native closed details still build their React children. Defer expensive bodies until opened. */
function FocusDetails({ ownerKey, stateKey, defaultOpen = false, className, summary, children }: {
  ownerKey: string; stateKey: string; defaultOpen?: boolean; className?: string
  summary: ReactNode; children(): ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(() => detailStates.get(ownerKey)?.get(stateKey) ?? defaultOpen)
  return <details className={className} open={open} onToggle={event => {
    if (event.target !== event.currentTarget) return
    const next = event.currentTarget.open
    const states = detailStates.get(ownerKey) ?? new Map<string, boolean>()
    states.set(stateKey, next)
    detailStates.set(ownerKey, states)
    setOpen(next)
  }}><summary>{summary}</summary>{open ? children() : null}</details>
}
const EMPTY_TURNS: FocusTurn[] = []
const EMPTY_RECORDS: ExecutionRecord[] = []
const EMPTY_TOOL_CALLS: FocusToolCall[] = []
interface DraftFile { id: string; file: File }
// Keep unsent files across view switches in memory, never in localStorage.
const fileDrafts = new Map<string, DraftFile[]>()
const fileDraftListeners = new Map<string, Set<() => void>>()
function saveFileDraft(ownerKey: string, files: DraftFile[]): void {
  if (files.length) fileDrafts.set(ownerKey, files)
  else fileDrafts.delete(ownerKey)
  fileDraftListeners.get(ownerKey)?.forEach(listener => listener())
}
interface QueuedDraft { ownerKey: string; text: string; skills: FocusToolSkill[]; files: DraftFile[]; at: number }
// The composer clears its draft once the main process queues a message. Keep that draft here, keyed by
// clientRequestId, so a queued message that ends unsent can be handed back to the composer.
const queuedDrafts = new Map<string, QueuedDraft>()
const QUEUED_DRAFT_TTL_MS = 30 * 60_000
function rememberQueuedDraft(requestId: string, draft: QueuedDraft): void {
  for (const [id, item] of queuedDrafts) if (draft.at - item.at > QUEUED_DRAFT_TTL_MS) queuedDrafts.delete(id)
  queuedDrafts.set(requestId, draft)
}
function sendOutcomeDescription(result: string, modelLabel: string): string {
  const descriptions: Record<string, string> = {
    busy: '页面正在处理或保留着草稿，消息未重发。可稍后再试或切回原始视图处理。',
    stuck: '发送结果尚未确认。草稿已保留，请先到原始视图核对，避免重复发送。',
    'no-composer': '尚未找到网页输入框，请切回原始视图完成登录或页面验证。',
    'insert-failed': '网页没有接受输入，草稿已保留。请切回原始视图处理。',
    unavailable: '当前页面不可用或会话已切换，草稿已保留。',
    invalid: '请输入文字或添加附件；附件最多 3 个，单个 20 MB，合计 25 MB。',
    'upload-failed': '附件上传未完成，附件已保留。请到原始视图检查是否留有上传草稿后再重试。',
    'unsupported-file-type': modelLabel + ' 当前输入区不接受该附件类型，附件已保留。',
    unknown: '附件消息是否发送成功尚未确认，附件已保留。请先到原始视图核对，避免重复发送。',
    cancelled: '发送已取消，文字和附件仍保留。',
    'helper-not-ready': 'Windows 桌面助手尚未就绪，消息未发送，草稿已保留。就绪后再发送即可。'
  }
  return descriptions[result] || '消息未发送，草稿已保留。'
}
const QUEUE_KIND_LABELS: Record<FocusOutboundQueueItem['kind'], string> = {
  user: '你的消息', 'tool-result': '工具结果', scheduled: '定时任务', question: '回答', recovery: '恢复消息', auxiliary: '辅助消息'
}
const QUEUE_RETRY_LABELS: Record<string, string> = {
  busy: '等待页面空闲', 'no-composer': '等待网页输入框', 'insert-failed': '网页未接受输入，稍后重试'
}
const QUEUE_COLLAPSED_KEY = 'focus-outbound-queue-collapsed'
function readQueueCollapsed(): boolean {
  try { return localStorage.getItem(QUEUE_COLLAPSED_KEY) === '1' } catch { return false }
}
function activeQueueStatus(item: FocusOutboundQueueItem): string {
  if (!item.retryReason) return (item.attempt ?? 1) > 1 ? `发送中 · 第 ${item.attempt} 次尝试` : '发送中'
  return `${QUEUE_RETRY_LABELS[item.retryReason] ?? '等待重试'} · 已尝试 ${item.attempt ?? 1} 次`
}
interface QueueTrayProps {
  queue: FocusOutboundQueueState
  collapsed: boolean
  onToggle(): void
  onCancelActive(id: string): void
  onEdit(item: FocusOutboundQueueItem): void
  onDelete(item: FocusOutboundQueueItem): void
}
/**
 * The AI outbound lane for this conversation, docked to the top of the composer: what is being sent
 * now and why it may be waiting, then what follows in order. Only the user's own waiting messages can
 * be edited or deleted — automated items (tool results, scheduled runs, answers) must keep their order.
 */
function OutboundQueueTray({ queue, collapsed, onToggle, onCancelActive, onEdit, onDelete }: QueueTrayProps): JSX.Element | null {
  const [confirming, setConfirming] = useState<string | null>(null)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(null), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const { active } = queue
  const queued = queue.queued ?? []
  if (!active && !queued.length) return null
  // The blocked head has its own banner; it is counted in `pending` but not listed here.
  const waiting = queue.pending - (queue.blocked ? 1 : 0)
  const hidden = waiting - (active ? 1 : 0) - queued.length
  const kind = (item: FocusOutboundQueueItem): string => QUEUE_KIND_LABELS[item.kind] ?? '消息'
  const files = (item: FocusOutboundQueueItem): string => item.attachments?.length ? `附件：${item.attachments.map(file => file.name).join('、')}` : ''
  return <section className={'focus-queue' + (collapsed ? ' is-collapsed' : '')} aria-label="AI 发送队列">
    <button type="button" className="focus-queue__head" aria-expanded={!collapsed} onClick={onToggle}>
      <span className={'focus-queue__dot' + (active?.retryReason ? ' is-waiting' : '')} aria-hidden="true" />
      <span className="focus-queue__title">发送队列</span>
      <span className="focus-queue__count">{waiting} 条</span>
      <span className="focus-queue__peek">{collapsed && active ? `${activeQueueStatus(active)}：${active.text || kind(active)}` : '按顺序自动发出'}</span>
      <svg className="focus-queue__chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {collapsed ? null : <ol className="focus-queue__list">
      {active ? <li className="focus-queue__item is-active" aria-live="polite">
        <span className={'focus-queue__marker' + (active.retryReason ? ' is-waiting' : '')} aria-hidden="true"><span /></span>
        <span className="focus-queue__body">
          <span className="focus-queue__line"><span className="focus-queue__kind">{kind(active)}</span>
            <span className="focus-queue__text" title={active.text}>{active.text || '（无文字）'}</span></span>
          <span className="focus-queue__meta">{[activeQueueStatus(active), files(active)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="focus-queue__actions">
          <button type="button" className={confirming === active.id ? 'is-danger' : undefined}
            title="停止这条消息的发送；如果已经提交到网页，结果需要到原始视图核对"
            onClick={() => { if (confirming === active.id) { setConfirming(null); onCancelActive(active.id) } else setConfirming(active.id) }}>
            {confirming === active.id ? '确认取消？' : '取消'}</button>
        </span>
      </li> : null}
      {queued.map((item, index) => <li key={item.id} className="focus-queue__item">
        <span className="focus-queue__marker" aria-label={`第 ${index + 1} 条等待`}>{index + 1}</span>
        <span className="focus-queue__body">
          <span className="focus-queue__line"><span className="focus-queue__kind">{kind(item)}</span>
            <span className="focus-queue__text" title={item.text}>{item.text || '（无文字）'}</span></span>
          <span className="focus-queue__meta">{[item.restorable ? '等待发送' : '自动发送，保持顺序', files(item)].filter(Boolean).join(' · ')}</span>
        </span>
        {item.restorable ? <span className="focus-queue__actions">
          <button type="button" title="移出队列并放回输入框修改" onClick={() => onEdit(item)}>编辑</button>
          <button type="button" title="移出队列，不再发送" onClick={() => onDelete(item)}>删除</button>
        </span> : null}
      </li>)}
      {hidden > 0 ? <li className="focus-queue__more">还有 {hidden} 条等待发送</li> : null}
    </ol>}
  </section>
}
function FilePreview({ file, onPreview }: { file: File; onPreview(source: string, name: string): void }): JSX.Element {
  const [source, setSource] = useState('')
  const image = /^(image\/(png|jpeg|webp|gif|bmp|avif))$/.test(file.type)
  useEffect(() => {
    if (!image) return
    const url = URL.createObjectURL(file)
    setSource(url)
    return () => URL.revokeObjectURL(url)
  }, [file, image])
  if (!image || !source) return <span className="focus-draft-file__icon" aria-hidden="true">📎</span>
  return <button type="button" className="focus-draft-file__thumb" onClick={() => onPreview(source, file.name)} aria-label={'预览图片 ' + file.name} title="点击查看大图">
      <img src={source} alt={file.name} />
    </button>
}
/**
 * Clipboard text without its leading and trailing blank lines. Web selections spanning
 * blocks, code-block copy buttons and terminal output all add line breaks around the text,
 * which landed as empty lines in the composer. Inner lines and the first line's indent stay.
 */
function trimPastedLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
}
const fileSize = (size: number): string => size < 1024 * 1024 ? Math.max(1, Math.ceil(size / 1024)) + ' KB' : (size / 1024 / 1024).toFixed(1) + ' MB'
function encodeFile(file: File): Promise<FocusAttachmentInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('file-read-failed'))
    reader.onabort = () => reject(new Error('file-read-aborted'))
    reader.onload = () => {
      const data = String(reader.result ?? '')
      const index = data.indexOf(',')
      if (index < 0) { reject(new Error('file-read-failed')); return }
      resolve({ fileName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, dataBase64: data.slice(index + 1) })
    }
    reader.readAsDataURL(file)
  })
}
function draftKey(owner: FocusOwner): string { return 'focus-chat.draft.' + focusOwnerKey(owner) }
function readSkillDraft(key: string): FocusToolSkill[] {
  try { const value: unknown = JSON.parse(localStorage.getItem('focus-chat.skills.' + key) || '[]'); return validFocusToolSkills(value) ? value : [] }
  catch { return [] }
}
function saveSkillDraft(key: string, skills: FocusToolSkill[]): void {
  try { if (skills.length) localStorage.setItem('focus-chat.skills.' + key, JSON.stringify(skills)); else localStorage.removeItem('focus-chat.skills.' + key) }
  catch { /* Keep the current input's selection in memory. */ }
}
function readDraft(owner: FocusOwner): string {
  try { return (localStorage.getItem(draftKey(owner)) || '').slice(0, 20000) } catch { return '' }
}
function executionNeedsAction(record: ExecutionRecord, delivery?: FocusDelivery): boolean {
  return ['pending', 'blocked', 'failed', 'timeout', 'interrupted'].includes(record.status) ||
    delivery === 'blocked' || delivery === 'failed' ||
    (record.kind === 'read_files' && record.deliveryStatus === 'failed')
}
// Memoized: parsing and highlighting every answer again on each keystroke made typing stutter.
/*
 * A chart marker written by the page script (`chartMarkdown`), followed by its quoted
 * fallback list. The focus view draws the chart in place of both; a marker that does not
 * parse leaves the quote, and the comment itself is never shown (skipHtml).
 */
const RICH_BLOCK = /<!--focus-(chart|ui|layout) (\{[^\n]*\}) -->\n((?:>[^\n]*(?:\n|$))*)/g
const CHART_MARKER = /<!--focus-(?:chart|ui|layout) [\s\S]*? -->\n?/g
const mathRemarkPlugins = [remarkMath]
const mathRehypePlugins: NonNullable<ComponentProps<typeof MDEditor.Markdown>['rehypePlugins']> = [
  rehypeFocusFileLinks,
  [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }]
]
/** DeepSeek commonly emits LaTeX delimiters instead of Markdown math delimiters. */
function normalizeMathDelimiters(markdown: string): string {
  return markdown.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g, token => {
    if (token.startsWith('```') || token.startsWith('~~~')) return token
    if (token.startsWith('\\[')) return `\n$$\n${token.slice(2, -2).trim()}\n$$\n`
    return `$${token.slice(2, -2).replace(/\s*\n\s*/g, ' ')}$`
  })
}
const Markdown = memo(function Markdown({ text, theme }: { text: string; theme: AppTheme }): JSX.Element {
  const source = normalizeMathDelimiters(cleanFocusAnswer(text))
  const blocks: Array<string | { kind: 'chart'; data: FocusChartData } | { kind: 'ui'; data: FocusUiWidget } | { kind: 'layout'; data: FocusLayoutData }> = []
  let last = 0
  for (const match of source.matchAll(RICH_BLOCK)) {
    const data = match[1] === 'chart' ? parseFocusChart(match[2]) : match[1] === 'layout' ? parseFocusLayout(match[2]) : parseFocusUi(match[2])
    if (!data) continue
    const block = match[1] === 'chart' ? { kind: 'chart' as const, data: data as FocusChartData } :
      match[1] === 'layout' ? { kind: 'layout' as const, data: data as FocusLayoutData } : { kind: 'ui' as const, data: data as FocusUiWidget }
    blocks.push(source.slice(last, match.index), block)
    last = match.index + match[0].length
  }
  if (!blocks.length) return <FocusCodeThemeContext.Provider value={theme}><MDEditor.Markdown source={source} skipHtml disableCopy components={{ pre: FocusCodeBlock, a: FocusMessageLink }} remarkPlugins={mathRemarkPlugins} rehypePlugins={mathRehypePlugins} wrapperElement={{ 'data-color-mode': theme }} /></FocusCodeThemeContext.Provider>
  blocks.push(source.slice(last))
  return <FocusCodeThemeContext.Provider value={theme}>{blocks.map((block, index) => typeof block === 'string'
    ? block.trim() ? <MDEditor.Markdown key={index} source={block} skipHtml disableCopy components={{ pre: FocusCodeBlock, a: FocusMessageLink }} remarkPlugins={mathRemarkPlugins} rehypePlugins={mathRehypePlugins} wrapperElement={{ 'data-color-mode': theme }} /> : null
    : block.kind === 'chart' ? <FocusChart key={index} data={block.data} /> : block.kind === 'layout'
      ? <FocusLayout key={index} data={block.data} /> : <FocusSmartUi key={index} data={block.data} />)}</FocusCodeThemeContext.Provider>
})

interface AskContext { range: Range; answer: HTMLElement; text: string; answerText: string; sourceMessageId: string; backward: boolean }
/**
 * 询问 AI for a selection inside a focus-view answer — the page's own popup cannot appear
 * here, because this view covers the page. Only text inside ONE answer counts (marked with
 * `data-question-answer`, whose value is that answer's capture key); reasoning, commands and
 * user turns are not answers. Like the page popup it never takes focus on its own, so the
 * selection and Ctrl+C keep working until the user clicks into the box.
 */
function SelectionAsk({ owner, root }: { owner: FocusOwner; root: RefObject<HTMLDivElement | null> }): JSX.Element | null {
  const [context, setContext] = useState<AskContext | null>(null)
  const [question, setQuestion] = useState('')
  const [status, setStatus] = useState<{ text: string; pending: boolean } | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const panel = useRef<HTMLElement>(null)
  const composing = useRef(false)
  const contextRef = useRef<AskContext | null>(null)
  contextRef.current = context

  const close = (): void => { setContext(null); setQuestion(''); setStatus(null); setPlace(null) }
  const position = (): void => {
    const current = contextRef.current
    if (!current) return
    if (!current.answer.isConnected) { close(); return }
    const host = root.current
    if (!host) return
    const view = host.getBoundingClientRect()
    const viewport = window.visualViewport
    const minX = Math.max(view.left, viewport?.offsetLeft ?? 0) + 12
    const minY = Math.max(view.top, viewport?.offsetTop ?? 0) + 12
    const right = Math.min(view.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth)) - 12
    const bottom = Math.min(view.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)) - 12
    const width = Math.min(360, right - minX)
    const maxHeight = bottom - minY
    if (width < 120 || maxHeight < 80) { close(); return }
    const rects = [...current.range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 &&
      rect.bottom > view.top && rect.top < view.bottom && rect.right > view.left && rect.left < view.right)
    const anchor = current.backward ? rects[0] : rects.at(-1)
    const height = Math.min(panel.current?.offsetHeight ?? 180, maxHeight)
    const maxX = Math.max(minX, right - width)
    const maxY = Math.max(minY, bottom - height)
    const updatePlace = (left: number, top: number): void => {
      // Range rectangles use viewport coordinates; the panel is absolute inside the transcript.
      const next = { left: Math.round(Math.max(minX, Math.min(left, maxX)) - view.left),
        top: Math.round(Math.max(minY, Math.min(top, maxY)) - view.top), width, maxHeight }
      setPlace(previous => previous?.left === next.left && previous.top === next.top &&
        previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next)
    }
    if (!anchor) {
      // A draft stays where it is while its author scrolls; an untouched one goes away.
      if (!question && panel.current && !panel.current.contains(document.activeElement)) close()
      else if (panel.current) {
        const previous = panel.current.getBoundingClientRect()
        updatePlace(previous.left, previous.top)
      }
      return
    }
    const below = anchor.bottom + 10
    updatePlace(anchor.left, below + height <= bottom ? below : anchor.top - height - 10)
  }

  useEffect(() => {
    const host = root.current
    if (!host) return
    const read = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
      const range = selection.getRangeAt(0)
      const answerOf = (node: Node): HTMLElement | null =>
        (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-question-answer]') ?? null
      const answer = answerOf(range.startContainer)
      const text = selection.toString().trim()
      if (!answer || answer !== answerOf(range.endContainer) || !host.contains(answer) || !text) return
      const current = contextRef.current
      if (current && current.answer === answer && current.text === text &&
        current.range.startContainer === range.startContainer && current.range.startOffset === range.startOffset &&
        current.range.endContainer === range.endContainer && current.range.endOffset === range.endOffset) return
      setContext({ range: range.cloneRange(), answer, text, answerText: answer.innerText,
        sourceMessageId: answer.dataset.questionAnswer ?? '',
        backward: selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset })
      setQuestion('')
      setStatus(null)
    }
    const released = (): void => { setTimeout(read, 0) }
    // Like the page popup: a press anywhere else dismisses it; a new drag may open it again.
    const pressed = (event: PointerEvent): void => {
      if (event.button !== 0 || !contextRef.current || panel.current?.contains(event.target as Node)) return
      close()
    }
    host.addEventListener('pointerup', released)
    host.addEventListener('keyup', released)
    document.addEventListener('pointerdown', pressed, true)
    return () => {
      host.removeEventListener('pointerup', released)
      host.removeEventListener('keyup', released)
      document.removeEventListener('pointerdown', pressed, true)
    }
  })

  useLayoutEffect(() => {
    if (!context) return
    position()
    const reposition = (): void => position()
    const observer = new ResizeObserver(reposition)
    if (panel.current) observer.observe(panel.current)
    if (root.current) observer.observe(root.current)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  })

  const submit = async (): Promise<void> => {
    const current = contextRef.current
    if (!current || status?.pending) return
    if (!question.trim()) { setStatus({ text: '请先输入要提问的问题。', pending: false }); return }
    if (question.length > 20000 || current.text.length > 20000) { setStatus({ text: '问题或选中文字过长，请缩短后重试。', pending: false }); return }
    // A re-rendered answer is no longer the text the user selected from.
    if (!current.answer.isConnected || current.answer.innerText !== current.answerText) {
      setStatus({ text: '选区已失效，请重新选中文字并输入问题。', pending: false }); return
    }
    setStatus({ text: '正在整理本地对话…', pending: true })
    let failure: string
    try {
      failure = await window.api.askFocusSelection({ ...owner, selectedText: current.text, question, answerText: current.answerText,
        ...(current.sourceMessageId ? { sourceMessageId: current.sourceMessageId } : {}) })
    } catch {
      failure = '提问未完成，请重试。'
    }
    if (contextRef.current !== current) return
    if (failure) { setStatus({ text: failure, pending: false }); return }
    window.getSelection()?.removeAllRanges()
    close()
  }

  useEffect(() => {
    if (!context) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || composing.current ||
        event.target instanceof Element && event.target.closest('.app-popover')) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [context])

  if (!context) return null
  return <section className="focus-ask" ref={panel} role="dialog" aria-modal="false" aria-labelledby="focus-ask-title" aria-busy={status?.pending === true}
    style={place ?? { visibility: 'hidden' }}>
    <div className="focus-ask__head">
      <span className="focus-ask__title" id="focus-ask-title">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 14.5 2.75 17v-4.25a6.75 6.75 0 1 1 3 2.25H5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M6.75 8h6.5M6.75 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        询问 AI
      </span>
      <button type="button" className="focus-ask__close" aria-label="关闭询问 AI" title="关闭（Esc）" onClick={close}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
    <blockquote className="focus-ask__quote" aria-label="选中的内容">{context.text}</blockquote>
    <textarea className="focus-ask__input" aria-label="询问 AI" placeholder="针对这段内容提问…" rows={2} spellCheck={false}
      value={question} readOnly={status?.pending === true} maxLength={20000}
      onChange={event => { setQuestion(event.target.value); if (status && !status.pending) setStatus(null) }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
        event.preventDefault()
        void submit()
      }} />
    {status ? <div className="focus-ask__status" role="status" data-pending={status.pending}>{status.text}</div> : null}
    <div className="focus-ask__foot"><span>Enter 提问 · Shift+Enter 换行</span><span>Esc 关闭</span></div>
  </section>
}

/** Keep the inline draft local so typing does not rebuild every answer/process block. */
function EditableUser({ text, children, editable, open, disabled, onOpen, onClose, onSend }: {
  text: string; children?: ReactNode; editable: boolean; open: boolean; disabled: boolean
  onOpen(): void; onClose(): void; onSend(text: string): Promise<string | null>
}): JSX.Element {
  const [value, setValue] = useState(text)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const lock = useRef(false)
  const composing = useRef(false)
  useEffect(() => {
    if (!open) return
    setValue(text)
    setError('')
    input.current?.focus()
    input.current?.setSelectionRange(text.length, text.length)
  }, [open, text])
  const cancel = (): void => {
    if (lock.current) return
    onClose()
    requestAnimationFrame(() => trigger.current?.focus())
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (lock.current || disabled || !value.trim()) return
    lock.current = true
    setPending(true)
    setError('')
    try { const failure = await onSend(value); if (failure) setError(failure) }
    catch { setError('重发结果尚未确认，请先到原始视图核对。') }
    finally { lock.current = false; setPending(false) }
  }
  if (open) return <div className="focus-user__bubble"><form className="focus-message-edit" onSubmit={event => void submit(event)} aria-busy={pending}>
    <textarea ref={input} aria-label="编辑已发送的消息" value={value} maxLength={20000} rows={Math.min(10, Math.max(3, value.split('\n').length))}
      disabled={pending} onChange={event => setValue(event.target.value)}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
        if (event.key === 'Escape') { event.preventDefault(); cancel() }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          if (!event.repeat && !pending && !disabled) event.currentTarget.form?.requestSubmit()
        }
      }} />
    <p className="focus-message-edit__hint">重新发送后，后续消息将由新回复替换。Enter 发送 · Shift+Enter 换行</p>
    {error ? <p className="focus-message-edit__error" role="alert">{error}</p> : null}
    <div className="focus-message-edit__actions">
      <button type="button" disabled={pending} onClick={cancel}>取消</button>
      <button type="submit" disabled={pending || disabled || !value.trim()}>{pending ? '正在重新发送…' : '重新发送'}</button>
    </div>
  </form></div>
  return <><div className="focus-user__bubble">{text ? <p>{text}</p> : null}{children}</div>{editable ? <div className="focus-user__actions">
    <button ref={trigger} type="button" className="focus-user__edit" aria-label="编辑消息" title="编辑消息" disabled={disabled} onClick={onOpen}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M16 3a2.12 2.12 0 0 1 3 3L9 16l-4 1 1-4Z" /><path d="M4 21h16" />
      </svg>
    </button>
  </div> : null}</>
}

function FocusChatView(props: Props): JSX.Element {
  const { owner, visible, theme, messages, messagesReady } = props
  const ownerKey = focusOwnerKey(owner)
  // UI state follows the continuous chat; API calls retain the physical page owner.
  const viewOwner = { ...owner, conversationId: props.viewConversationId ?? owner.conversationId }
  const viewOwnerKey = focusOwnerKey(viewOwner)
  const modelLabel = focusPlatformLabel(owner.platformId)
  const modelIcon = FOCUS_ICONS[owner.platformId]
  const [state, setState] = useState<FocusChatState | null>(null)
  const [draft, setDraft] = useState(() => readDraft(viewOwner))
  const compaction = useConversationCompaction(owner, visible)
  const [skillCaret, setSkillCaret] = useState(draft.length)
  const [skillsDismissed, setSkillsDismissed] = useState(false)
  const skillQuery = focusSkillQuery(draft, skillCaret)
  const [skillIndex, setSkillIndex] = useState(0)
  const [selectedSkills, setSelectedSkills] = useState<FocusToolSkill[]>(() => readSkillDraft(viewOwnerKey))
  const [toolState, setToolState] = useState<ConversationToolsState | null>(null)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const matchingSkills = FOCUS_SKILLS.filter(skill => skillQuery?.ids.includes(skill.id))
  const activeSkill = matchingSkills[Math.min(skillIndex, Math.max(0, matchingSkills.length - 1))]
  const [sending, setSending] = useState(false)
  const [changingMode, setChangingMode] = useState<FocusComposerModeId | null>(null)
  const [settingPending, setSettingPending] = useState<FocusModelSettingKind | null>(null)
  const [settingError, setSettingError] = useState('')
  const settingBusy = useRef(false)
  const modelReadAttempted = useRef(false)
  const modelReadAttempts = useRef(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const skillsOpen = !!skillQuery && !skillsDismissed && !editingId
  const readEpoch = useRef(0)
  const [stopping, setStopping] = useState(false)
  const [draftFiles, setDraftFiles] = useState<DraftFile[]>(() => fileDrafts.get(viewOwnerKey) ?? [])
  const filesRef = useRef<DraftFile[]>(draftFiles)
  const fileInput = useRef<HTMLInputElement>(null)
  const sendLock = useRef(false)
  const sendCancelled = useRef(false)
  /** Queue failures already restored or dismissed here, while their dismissal reaches the main process. */
  const handledQueueFailures = useRef(new Set<string>())
  const [, setHandledQueueFailureCount] = useState(0)
  const [queueCollapsed, setQueueCollapsed] = useState(readQueueCollapsed)
  /**
   * Waiting composer messages the user pulled out of the queue, by clientRequestId. Their cancellation
   * reaches the main process as a failure: 'restored' (draft already back) and 'discard' are dismissed
   * silently; 'restore' (no local draft, e.g. after a reload) restores the text the main process kept.
   */
  const queuePullbacks = useRef(new Map<string, 'restored' | 'restore' | 'discard'>())
  const [error, setError] = useState('')
  const [actionId, setActionId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const alive = useRef(true)
  const composing = useRef(false)
  const draftRef = useRef(draft)
  const snapshotRef = useRef<FocusChatState | null>(null)
  const applySnapshot = (update: FocusChatUpdate): void => {
    const next = mergeFocusChatUpdate(snapshotRef.current, update)
    if (next && next !== snapshotRef.current) {
      snapshotRef.current = next
      setState(next)
    }
  }
  const transcriptRef = useRef<HTMLDivElement>(null)
  const citationRoot = useRef<HTMLElement>(null)
  useEffect(() => { alive.current = true; return () => {
    alive.current = false
  } }, [])
  useEffect(() => { setSkillIndex(0) }, [skillQuery?.query, skillQuery?.start])
  useEffect(() => {
    if (!visible) return
    let disposed = false, pushed = false
    const apply = (next: ConversationToolsState): void => {
      if (!disposed && focusOwnerKey(next.owner) === ownerKey) setToolState(next)
    }
    const off = window.api.onConversationToolsChanged(next => { if (focusOwnerKey(next.owner) === ownerKey) { pushed = true; apply(next) } })
    void window.api.getConversationTools(owner).then(next => { if (!pushed) apply(next) }).catch(() => {})
    return () => { disposed = true; off() }
  }, [ownerKey, visible])
  useEffect(() => {
    const update = (): void => {
      const files = fileDrafts.get(viewOwnerKey) ?? []
      filesRef.current = files
      setDraftFiles(files)
    }
    const listeners = fileDraftListeners.get(viewOwnerKey) ?? new Set<() => void>()
    listeners.add(update)
    fileDraftListeners.set(viewOwnerKey, listeners)
    update()
    return () => { listeners.delete(update); if (!listeners.size) fileDraftListeners.delete(viewOwnerKey) }
  }, [viewOwnerKey])
  const addFiles = (incoming: File[]): void => {
    if (!incoming.length || sendLock.current) return
    const current = filesRef.current
    if (current.length + incoming.length > FOCUS_MAX_FILES) { setError('每条消息最多添加 3 个附件。'); return }
    if (incoming.some(file => !file.size || file.size > FOCUS_MAX_FILE_BYTES)) { setError('附件不能为空，单个附件不能超过 20 MB。'); return }
    if ([...current.map(item => item.file), ...incoming].reduce((sum, file) => sum + file.size, 0) > FOCUS_MAX_BATCH_BYTES) { setError('本条消息的附件合计不能超过 25 MB。'); return }
    const added = incoming.map(file => ({ id: crypto.randomUUID(), file }))
    filesRef.current = [...current, ...added]
    saveFileDraft(viewOwnerKey, filesRef.current)
    setDraftFiles(filesRef.current)
    setError('')
  }
  const removeFile = (id: string): void => {
    if (sendLock.current) return
    filesRef.current = filesRef.current.filter(file => file.id !== id)
    saveFileDraft(viewOwnerKey, filesRef.current)
    setDraftFiles(filesRef.current)
  }

  useEffect(() => {
    if (!visible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const epoch = readEpoch.current
      try {
        if (settingBusy.current) return
        const next = await window.api.pollFocusChat(owner, snapshotRef.current?.historyCursor)
        if (disposed || epoch !== readEpoch.current || !next || focusOwnerKey(next) !== ownerKey) return
        applySnapshot(next)
      } catch {
        if (!disposed) setError('暂时无法读取页面状态，请稍后重试或切回原始视图。')
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll() }, 900)
      }
    }
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [ownerKey, visible])

  const turns = state?.turns ?? EMPTY_TURNS
  const records = state?.executions ?? EMPTY_RECORDS
  const tokenUsage = useMemo(() => estimateFocusConversation({ messages, turns, executions: records,
    hiddenMessageIds: state?.hiddenMessageIds, smartReplies: state?.smartReplies, contextUsage: state?.contextUsage }),
  [messages, turns, records, state?.hiddenMessageIds, state?.smartReplies, state?.contextUsage])
  const recordsById = useMemo(() => new Map(records.map(record => [record.messageId, record])), [records])
  const messagesById = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const represented = useMemo(() => {
    const ids = new Set<string>()
    const sources = new Set<string>()
    for (const turn of turns) {
      if (turn.userMessageId) ids.add(turn.userMessageId)
      for (const segment of turn.segments) if (segment.sourceMessageId) sources.add(JSON.stringify([!!turn.archived, segment.sourceMessageId]))
      for (const call of turn.toolCalls ?? []) sources.add(JSON.stringify([!!turn.archived, call.sourceMessageId]))
    }
    return { ids, sources }
  }, [turns])
  // Only explicitly associated rows are merged. Unknown old history stays readable.
  const hiddenMessageIds = useMemo(() => new Set(state?.hiddenMessageIds ?? []), [state?.hiddenMessageIds])
  const compactionBoundaries = state?.compactions
  const entries = useMemo(() => {
    const history = messages.filter(message => !represented.ids.has(message.id) &&
    !hiddenMessageIds.has(message.id) &&
    !(message.sourceMessageId && represented.sources.has(JSON.stringify([!!message.archived, message.sourceMessageId]))) &&
    (message.role !== 'assistant' || !!cleanFocusAnswer(message.content).trim() || message.attachments.length > 0) &&
    !(message.role === 'assistant' && message.sourceMessageId && recordsById.has(message.sourceMessageId)) &&
    !message.sourceMessageId?.startsWith('read-files:'))
    return [...history.map(message => ({ at: message.createdAt, message, turn: null as FocusTurn | null, compaction: null })),
    ...turns.map(turn => ({ at: turn.createdAt, turn, message: null as ConversationMessage | null, compaction: null })),
    ...(compactionBoundaries ?? []).map(compaction => ({ at: compaction.createdAt, compaction, turn: null, message: null }))]
    .sort((a, b) => a.at - b.at)
  }, [messages, represented, hiddenMessageIds, recordsById, turns, compactionBoundaries])
  const lastTurn = turns.filter(turn => !turn.archived).at(-1)
  const sendFailure = state?.sendFailure
  const working = !sendFailure && (props.needsAnswer || state?.waiting === true || state?.generating === 'active' || lastTurn?.status === 'working')
  const nativeGenerating = state?.generating === 'active'
  const ready = state?.ready === true
  // Computer use waits for its Windows helper; the composer keeps the draft meanwhile.
  const skillModeUnavailable = state?.promptInjection?.phase === 'disabled' ? '请先启用终端模式和提示词注入，再使用按需技能。' : ''
  const selectedUnavailable = selectedSkills.length ? skillModeUnavailable || selectedSkills.map(id => focusSkillUnavailable(id, toolState)).find(Boolean) || '' : ''
  const sendBlock = selectedUnavailable || (selectedSkills.includes('computer') ? state?.sendBlock || '' : '')
  const updateModelSettings = useCallback(async (kind: FocusModelSettingKind, value?: string, automatic = false): Promise<void> => {
    if (sendLock.current || working || editingId || !ready || !visible) return
    sendLock.current = true; settingBusy.current = true; readEpoch.current++
    setSettingPending(kind); setSettingError(''); setError('')
    try {
      const result = await window.api.updateFocusModelSettings({ ...owner, kind, ...(value !== undefined ? { value } : {}) })
      readEpoch.current++
      const next = await window.api.getFocusChat(owner)
      if (!alive.current) return
      if (next && focusOwnerKey(next) === ownerKey) {
        const updated = { ...next, modelSettings: result.settings ?? next.modelSettings }
        applySnapshot(updated)
      }
      // Only failures before native input may be retried automatically. A dispatched
      // click with an unknown result must remain a user-confirmed operation.
      const retryBeforeInput = kind === 'read' && automatic && modelReadAttempts.current < 3 &&
        (result.outcome === 'busy' || result.outcome === 'unavailable' && ['control-missing', 'page-unavailable'].includes(result.reason ?? ''))
      if (retryBeforeInput) modelReadAttempted.current = false
      else if (result.outcome !== 'ok') setSettingError(result.outcome === 'busy' ? '当前正在处理任务，请稍后切换模型或思考强度。' :
        kind === 'read' ? '暂时无法读取模型设置，请点击顶部刷新或到原始视图检查。' : '切换结果尚未确认，请到原始视图核对后再发送。')
    } catch { if (alive.current) setSettingError('暂时无法同步模型设置，请到原始视图检查。') }
    finally { sendLock.current = false; settingBusy.current = false; if (alive.current) setSettingPending(null) }
  }, [ownerKey, working, editingId, ready, visible])
  useEffect(() => {
    if (owner.platformId !== 'chatgpt' || !visible || !ready || working || editingId || sendLock.current || modelReadAttempted.current) return
    // A new conversation id remounts this view after the first send. Its page
    // snapshot already carries the confirmed settings; do not reopen a hidden
    // native menu as soon as the task finishes.
    if (state?.modelSettings?.model) { modelReadAttempted.current = true; return }
    // The home composer can mount well before its model trigger. Passive snapshots
    // wait for that control without consuming the one owned menu read or locking send.
    if (state?.modelSettingsReady !== true || settingPending !== null) return
    modelReadAttempted.current = true
    modelReadAttempts.current++
    void updateModelSettings('read', undefined, true)
  }, [ownerKey, visible, ready, working, editingId, sending, settingPending, state?.modelSettings?.model, state?.modelSettingsReady, updateModelSettings])
  useEffect(() => {
    if (state?.modelSettings?.model) setSettingError('')
  }, [ownerKey, state?.modelSettings?.model])
  const startNewChat = (): void => {
    // Loading home again can retain conversationId=null and this React instance.
    modelReadAttempted.current = false
    modelReadAttempts.current = 0
    setSettingError('')
    props.onNewChat()
  }
  const changeMode = async (id: FocusComposerModeId, active: boolean): Promise<void> => {
    if (sendLock.current || working || editingId || !ready) return
    sendLock.current = true
    readEpoch.current++
    setChangingMode(id); setError('')
    try {
      const outcome = await window.api.setFocusComposerMode({ ...owner, id, active })
      readEpoch.current++
      const next = await window.api.getFocusChat(owner)
      if (!alive.current) return
      if (next && focusOwnerKey(next) === ownerKey) applySnapshot(next)
      if (outcome !== 'ok') setError(outcome === 'busy' ? '当前正在处理任务，请稍后切换回答模式。' :
        '开关状态尚未确认，请到原始视图检查后再发送。')
    } catch { if (alive.current) setError('暂时无法同步开关状态，请到原始视图检查。') }
    finally { sendLock.current = false; if (alive.current) setChangingMode(null) }
  }
  const richAnswers = useMemo(() => new Map((state?.smartReplies ?? []).map(reply => [reply.sourceMessageId, reply.answer])), [state?.smartReplies])
  const actOnUi = useCallback(async (action: FocusUiAction): Promise<FocusSendOutcome> => {
    if (sendLock.current || working || editingId || !ready || state?.nativeDraft) return 'busy'
    sendLock.current = true; setSending(true); readEpoch.current++
    try {
      const result = await window.api.actOnFocusUi({ ...owner, ...action })
      readEpoch.current++
      const next = await window.api.getFocusChat(owner)
      if (alive.current && next && focusOwnerKey(next) === ownerKey) {
        applySnapshot(next)
      }
      return result
    } finally { sendLock.current = false; if (alive.current) setSending(false) }
  }, [ownerKey, working, editingId, ready, state?.nativeDraft])
  const smartUiContext = useMemo(() => ({ disabled: working || sending || stopping || !!editingId || !ready || !!state?.nativeDraft,
    liveSources: new Set((state?.smartReplies ?? []).map(reply => reply.sourceMessageId)), act: actOnUi, onOriginal: props.onOriginal }),
  [working, sending, stopping, editingId, ready, state?.nativeDraft, state?.smartReplies, actOnUi, props.onOriginal])
  const citationContext = useMemo(() => ({ owner, ownerKey, visible, containerRef: citationRoot, onOriginal: props.onOriginal }),
    [ownerKey, visible, props.onOriginal])
  const setDraftText = (text: string): void => {
    draftRef.current = text
    setDraft(text)
    try { localStorage.setItem(draftKey(viewOwner), text) } catch { /* Keep the in-memory draft. */ }
  }
  /** Hands an unsent queued message back to the composer, after anything the user typed since. */
  const restoreQueuedDraft = (text: string, skills: FocusToolSkill[], files: DraftFile[]): void => {
    const current = draftRef.current
    if (text) setDraftText((current.trim() ? current + '\n\n' + text : text).slice(0, 20000))
    if (skills.length) setSelectedSkills(previous => {
      const next = [...new Set([...previous, ...skills])]
      saveSkillDraft(viewOwnerKey, next)
      return next
    })
    if (files.length) {
      const merged = [...filesRef.current, ...files.filter(file => !filesRef.current.some(item => item.id === file.id))].slice(0, FOCUS_MAX_FILES)
      filesRef.current = merged
      saveFileDraft(viewOwnerKey, merged)
      setDraftFiles(merged)
    }
  }
  const dismissQueueFailure = (id: string): void => {
    handledQueueFailures.current.add(id)
    setHandledQueueFailureCount(handledQueueFailures.current.size)
    void window.api.resolveFocusOutboundQueue(owner, id, 'dismiss-failure').catch(() => {})
  }
  const outboundFailures = state?.outboundQueue?.failures
  const outboundPending = state?.outboundQueue?.pending ?? 0
  useEffect(() => {
    if (!alive.current) return
    if (!outboundFailures?.length) {
      // Settled without a failure: this view's remembered drafts were sent. Very recent entries may
      // predate the snapshot that first counts them, so they are left for the next one.
      if (!outboundPending) for (const [id, item] of queuedDrafts) if (item.ownerKey === viewOwnerKey && Date.now() - item.at > 5000) queuedDrafts.delete(id)
      return
    }
    for (const failure of outboundFailures) {
      const pullback = queuePullbacks.current.get(failure.sourceId)
      if (pullback && !handledQueueFailures.current.has(failure.id)) {
        queuePullbacks.current.delete(failure.sourceId)
        if (pullback === 'restore') restoreQueuedFailure(failure)
        else dismissQueueFailure(failure.id)
        continue
      }
      const saved = queuedDrafts.get(failure.sourceId)
      // A possibly-submitted message is never restored silently: restoring could invite a duplicate send.
      if (!saved || failure.uncertain || handledQueueFailures.current.has(failure.id)) continue
      restoreQueuedFailure(failure)
      setError('排队的消息未发送：' + sendOutcomeDescription(failure.outcome, modelLabel))
    }
  }, [ownerKey, viewOwnerKey, outboundFailures, outboundPending])
  /** Restores the full local draft when this renderer still holds it, otherwise the text the main process kept. */
  function restoreQueuedFailure(failure: FocusOutboundFailure): void {
    const saved = queuedDrafts.get(failure.sourceId)
    queuedDrafts.delete(failure.sourceId)
    if (saved) restoreQueuedDraft(saved.text, saved.skills, saved.files)
    else restoreQueuedDraft(failure.text, [], [])
    dismissQueueFailure(failure.id)
  }
  // Failures left to the user: possibly-submitted ones, and ones whose draft this renderer no longer holds (e.g. after a reload).
  const promptQueueFailures = (outboundFailures ?? []).filter(failure => !queuePullbacks.current.has(failure.sourceId) &&
    (failure.uncertain || !queuedDrafts.has(failure.sourceId)) && !handledQueueFailures.current.has(failure.id))
  const outboundQueue = state?.outboundQueue
  const queueTrayVisible = !!outboundQueue && (!!outboundQueue.active || !!outboundQueue.queued?.length)
  const lastEditableQueued = [...(outboundQueue?.queued ?? [])].reverse().find(item => item.restorable && item.sourceId)
  const toggleQueue = (): void => {
    const next = !queueCollapsed
    setQueueCollapsed(next)
    try { localStorage.setItem(QUEUE_COLLAPSED_KEY, next ? '1' : '0') } catch { /* Per-viewer convenience only. */ }
  }
  /** Takes a waiting composer message out of the lane; 'edit' puts it back in the composer, 'discard' drops it. */
  const pullQueued = async (item: FocusOutboundQueueItem, mode: 'edit' | 'discard'): Promise<void> => {
    const sourceId = item.sourceId
    if (!sourceId) return
    let removed = false
    try { removed = await window.api.resolveFocusOutboundQueue(owner, item.id, 'cancel') } catch { removed = false }
    if (!alive.current) return
    if (!removed) { setError('这条消息已经开始发送，无法再修改。'); return }
    const saved = queuedDrafts.get(sourceId)
    queuedDrafts.delete(sourceId)
    if (mode === 'discard') { queuePullbacks.current.set(sourceId, 'discard'); return }
    if (saved) {
      restoreQueuedDraft(saved.text, saved.skills, saved.files)
      queuePullbacks.current.set(sourceId, 'restored')
    } else queuePullbacks.current.set(sourceId, 'restore')
    requestAnimationFrame(() => composerInput.current?.focus())
  }
  const cancelActiveQueued = (id: string): void => {
    void window.api.resolveFocusOutboundQueue(owner, id, 'cancel').then(ok => {
      if (!ok && alive.current) setError('这条消息的发送已经结束，无需取消。')
    }).catch(() => {})
  }
  const compactionDisabled = !owner.conversationId ? '请先开始一个对话，再压缩已有记录。' :
    working || sending || stopping || !!editingId || settingPending !== null || !ready || !!state?.nativeDraft || !!sendFailure
      ? '请等待当前回答、发送或编辑结束后再压缩。' : compaction.blocked ? '正在处理压缩任务。' :
        compaction.state && !['completed', 'cancelled'].includes(compaction.state.phase) ? '请先继续检查或取消已有压缩任务。' : ''
  const startCompaction = async (): Promise<void> => {
    if (compactionDisabled || sendLock.current || !skillQuery?.ids.includes('compact')) return
    const original = draftRef.current, query = { ...skillQuery }
    sendLock.current = true
    try {
      if (await compaction.start()) {
        setSkillsDismissed(true)
        if (alive.current && draftRef.current === original) {
          setDraftText(original.slice(0, query.start) + original.slice(query.end))
          setSkillCaret(query.start)
        }
      }
    } finally { sendLock.current = false }
  }
  const changeSkills = (skills: FocusToolSkill[]): void => { setSelectedSkills(skills); saveSkillDraft(viewOwnerKey, skills) }
  const skillDisabled = (id: FocusSkillId): string => id === 'compact' ? compactionDisabled :
    sending || stopping || !!editingId || settingPending !== null || compaction.blocked ? '当前操作结束后可选择技能。' : skillModeUnavailable || focusSkillUnavailable(id, toolState)
  const chooseSkill = (id: FocusSkillId): void => {
    if (!skillQuery || skillDisabled(id)) return
    if (id === 'compact') { void startCompaction(); return }
    if (!selectedSkills.includes(id)) changeSkills([...selectedSkills, id])
    const next = draftRef.current.slice(0, skillQuery.start) + draftRef.current.slice(skillQuery.end)
    const caret = skillQuery.start
    setDraftText(next); setSkillCaret(caret); setSkillsDismissed(true)
    requestAnimationFrame(() => { composerInput.current?.focus(); composerInput.current?.setSelectionRange(caret, caret) })
  }
  // Through the editing pipeline, so Ctrl+Z still undoes the paste; a direct write is the fallback.
  const insertPastedText = (input: HTMLTextAreaElement, text: string): void => {
    input.focus()
    if (document.execCommand('insertText', false, text)) return
    const start = input.selectionStart, end = input.selectionEnd
    setDraftText((draftRef.current.slice(0, start) + text + draftRef.current.slice(end)).slice(0, 20000))
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = draftRef.current
    const submittedSkills = [...selectedSkills]
    const sourceFiles = filesRef.current
    if ((!text.trim() && !sourceFiles.length) || sendLock.current || editingId || props.needsAnswer || sendFailure || !ready || state?.nativeDraft || sendBlock || compaction.blocked) return
    sendLock.current = true
    sendCancelled.current = false
    setSending(true)
    setError('')
    try {
      const files = await Promise.all(sourceFiles.map(item => encodeFile(item.file)))
      // Reading files can finish after a conversation change; never send an abandoned draft.
      if (!alive.current || sendCancelled.current) return
      const clientRequestId = crypto.randomUUID()
      const result = await window.api.sendFocusMessage({ ...owner, text, files, skills: submittedSkills, clientRequestId })
      // The main process owns an immutable copy of the payload once it accepts the queue item.
      if (result === 'queued') rememberQueuedDraft(clientRequestId, { ownerKey: viewOwnerKey, text, skills: submittedSkills, files: sourceFiles, at: Date.now() })
      if (result === 'ok' || result === 'queued') {
        // A home -> chat navigation may unmount this composer before the result.
        if (JSON.stringify(readSkillDraft(viewOwnerKey)) === JSON.stringify(submittedSkills)) saveSkillDraft(viewOwnerKey, [])
        if (alive.current) setSelectedSkills([])
        const submittedIds = new Set(sourceFiles.map(item => item.id))
        saveFileDraft(viewOwnerKey, (fileDrafts.get(viewOwnerKey) ?? []).filter(item => !submittedIds.has(item.id)))
        try { if (localStorage.getItem(draftKey(viewOwner)) === text) localStorage.removeItem(draftKey(viewOwner)) } catch { /* Optional draft persistence. */ }
        if (alive.current && draftRef.current === text) setDraftText('')
        if (alive.current) {
          filesRef.current = []
          setDraftFiles([])
        }
      } else if (alive.current) {
        setError(sendOutcomeDescription(result, modelLabel))
      }
    } catch { if (alive.current) setError('发送结果未确认，草稿已保留。请到原始视图核对后再操作。') }
    finally { sendLock.current = false; if (alive.current) setSending(false) }
  }
  const stop = async (): Promise<void> => {
    if (stopping) return
    sendCancelled.current = true
    setStopping(true)
    try {
      readEpoch.current++
      const outcome = await window.api.stopFocusGeneration(owner)
      readEpoch.current++
      const next = await window.api.getFocusChat(owner)
      if (alive.current && next && focusOwnerKey(next) === ownerKey) applySnapshot(next)
      if (alive.current && outcome !== 'ok') setError('停止生成未确认，请到原始视图查看当前状态。')
    }
    catch { if (alive.current) setError('停止生成未确认，请到原始视图查看当前状态。') }
    finally { if (alive.current) setStopping(false) }
  }
  const editMessage = async (messageId: string, text: string): Promise<string | null> => {
    if (sendLock.current || working || !ready || state?.nativeDraft) return '页面正在处理或保留着草稿，请稍后再试。'
    sendLock.current = true
    setSending(true)
    readEpoch.current++
    try {
      const result = await window.api.editFocusMessage({ ...owner, messageId, text })
      readEpoch.current++
      if (result !== 'ok') return result === 'stuck' ? '是否重发成功尚未确认。请先到原始视图核对，避免重复发送。'
        : result === 'busy' ? '页面正在处理或保留着草稿，请结束当前任务或处理原网页草稿后再试。'
          : result === 'cancelled' ? '重新发送已取消，修改内容已保留。'
            : result === 'insert-failed' ? '网页未接受修改，内容已保留。请到原始视图检查。'
              : '未能定位这条原始消息，修改内容已保留。请到原始视图检查。'
      if (alive.current) {
        setEditingId(null)
        const next = await window.api.getFocusChat(owner)
        if (alive.current && next && focusOwnerKey(next) === ownerKey) {
          applySnapshot(next)
        }
      }
      return null
    } finally { sendLock.current = false; if (alive.current) setSending(false) }
  }
  const userContent = (messageId: string | null, text: string, attachments: boolean, children?: ReactNode, archived = false, skills?: FocusToolSkill[]): JSX.Element =>
    <><FocusMessageSkills skills={skills} /><EditableUser text={text} editable={!archived && supportsFocusEdit(owner.platformId) && !!owner.conversationId && !!messageId && !!text.trim() && !attachments &&
      !messagesById.get(messageId)?.sourceMessageId?.startsWith('compaction:')}
      open={!!messageId && editingId === messageId} disabled={working || sending || stopping || settingPending !== null || !ready || !!state?.nativeDraft}
      onOpen={() => { if (!sendLock.current && messageId) setEditingId(messageId) }} onClose={() => setEditingId(null)}
      onSend={text => editMessage(messageId!, text)}>{children}</EditableUser></>
  const action = async (id: string, skip = false): Promise<void> => {
    if (actionId) return
    setActionId(id)
    try { await (skip ? props.onSkip(id) : props.onRun(id)) }
    catch { if (alive.current) setError('操作尚未确认，请打开执行控制查看记录。') }
    finally { if (alive.current) setActionId(null) }
  }
  const copy = async (id: string, text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(cleanFocusFileLinkCopy(cleanFocusCitationCopy(cleanFocusAnswer(text).replace(CHART_MARKER, '')))); setCopiedId(id); setTimeout(() => { if (alive.current) setCopiedId(current => current === id ? null : current) }, 2000) }
    catch { setError('复制失败，可以选择正文手动复制。') }
  }
  const retrySend = async (): Promise<void> => {
    if (!sendFailure?.retryable || sendLock.current || actionId || stopping || !ready || state?.nativeDraft) return
    sendLock.current = true
    setActionId('native-send-retry')
    setError('')
    readEpoch.current++
    try {
      const result = await window.api.retryFocusSend(owner, sendFailure.id)
      if (!alive.current) return
      if (result !== 'ok') setError(result === 'stuck' ? '消息仍未发送成功，请稍后重试。'
        : result === 'busy' ? '网页正在处理或保留着草稿，请稍后重试。'
          : result === 'cancelled' ? '会话状态已变化，请核对当前消息。'
            : result === 'unknown' ? '重试发送的结果尚未确认，请到原始视图核对。'
              : '未能定位这条消息的重试控件，请到原始视图处理。')
      const next = await window.api.getFocusChat(owner)
      if (alive.current && next && focusOwnerKey(next) === ownerKey) {
        applySnapshot(next)
      }
    } catch { if (alive.current) setError('重试发送的结果尚未确认，请到原始视图核对。') }
    finally { readEpoch.current++; sendLock.current = false; if (alive.current) setActionId(null) }
  }
  const retryFormat = async (token: number): Promise<void> => {
    if (actionId) return
    setActionId('format:' + token)
    try {
      const result = await window.api.retryCommandRecovery(props.owner, token)
      if (result !== 'ok' && alive.current) setError(result === 'stuck'
        ? '修正请求是否发送成功尚未确认，请先到原始视图核对。'
        : '修正请求未发送，请处理网页草稿、确认当前会话并恢复自动执行后重试。')
    } catch { if (alive.current) setError('发送结果未确认，请先到原始视图核对。') }
    finally { if (alive.current) setActionId(null) }
  }
  const renderExecution = (record: ExecutionRecord, delivery?: FocusDelivery, actionable = false): JSX.Element => (
    <div className={'focus-execution' + (executionNeedsAction(record, delivery) ? ' focus-execution--attention' : '')} key={record.messageId}>
      <div className="focus-execution__head"><strong>{record.description || (record.kind === 'read_files' ? '读取文件' : '执行命令')}</strong><span>{labels[record.status] || record.status}</span></div>
      {actionable && ['pending', 'blocked'].includes(record.status) ? <pre>{record.command}</pre> : null}
      <FocusDetails ownerKey={viewOwnerKey} stateKey={'exec:' + record.messageId} summary={<>查看命令与输出{record.exitCode !== null ? ' · 退出码 ' + record.exitCode : ''}</>}>{() => <><pre>{record.command}</pre><FocusExecutionOutput owner={owner} record={record} />
        <div className="focus-execution__meta">{record.startedAt && record.finishedAt ? ((record.finishedAt - record.startedAt) / 1000).toFixed(1) + ' 秒 · ' : ''}{delivery === 'sent' ? '结果已回传' : delivery === 'background' ? '已交由后台任务处理，创建、就绪和结束结果单独回传' : delivery === 'pending' && record.status === 'done' ? '等待结果回传' : delivery === 'blocked' || delivery === 'failed' ? '结果尚未回传' : delivery === 'superseded' ? '结果未回传：已由后续执行接替' : ''}</div>
      </>}</FocusDetails>
      {actionable && ['pending', 'blocked'].includes(record.status) ? <div className="focus-chat__actions"><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId)}>{actionId === record.messageId ? '处理中…' : '运行'}</button><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId, true)}>跳过</button></div> : null}
      {actionable && (delivery === 'blocked' || delivery === 'failed' || ['failed', 'timeout'].includes(record.status)) ? <button type="button" onClick={props.onOpenTerminal}>打开执行控制</button> : null}
    </div>
  )
  const renderToolCall = (call: FocusToolCall): JSX.Element => {
    const statuses = { running: '正在调用', done: '调用完成', failed: '调用失败', blocked: '未执行', cancelled: '已取消', unknown: '执行结果未确认' }
    const delivery = { pending: '等待结果回传', sent: '结果已回传', blocked: '结果回传已中止', failed: '结果回传失败', unknown: '结果回传未确认' }
    return <div className={'focus-execution' + (['failed', 'blocked', 'unknown'].includes(call.status) ? ' focus-execution--attention' : '')}
      key={call.id} data-tool-name={call.tool}>
      <div className="focus-execution__head"><strong>{call.title}</strong><span>{statuses[call.status]}</span></div>
      {call.request ? <p className="focus-chat__muted">{call.request}</p> : null}
      <FocusDetails ownerKey={viewOwnerKey} stateKey={'tool:' + call.id} summary="查看调用详情">{() => <>
        {call.result ? <OutputText className="focus-execution__output" text={call.result} /> : <p className="focus-chat__muted">{call.status === 'running' ? '正在等待工具返回结果。' : '暂无结果摘要。'}</p>}
        <div className="focus-execution__meta">{delivery[call.delivery]}</div>
      </>}</FocusDetails>
    </div>
  }
  const renderTurn = (turn: FocusTurn): JSX.Element => {
    const turnWorking = !turn.archived && turn.status === 'working'
    const sendBlocked = !!sendFailure && turn === lastTurn
    // Only explicit turn ownership belongs in this process. Unlinked history stays in the terminal.
    const { executions, byCycle, unassigned, toolsByCycle, unassignedTools } = groupFocusExecutions(turn, recordsById)
    const executionIds = new Set(turn.executionIds)
    const toolSources = new Set((turn.toolCalls ?? []).map(call => call.sourceMessageId))
    const deliveryOf = (record: ExecutionRecord): FocusDelivery | undefined => focusDelivery(record, turn.deliveries[record.messageId])
    const running = !turn.archived && executions.some(record => record.status === 'running')
    const toolRunning = turnWorking && turn.toolCalls?.some(call => call.status === 'running')
    const pending = !turn.archived && executions.some(record => ['pending', 'blocked'].includes(record.status))
    const deliveryPending = turnWorking && (executions.some(record => record.status === 'done' && deliveryOf(record) === 'pending') ||
      turn.toolCalls?.some(call => call.status === 'done' && call.delivery === 'pending'))
    // A new tool/result cycle must not move earlier prose into the process panel.
    const answers = turn.segments.flatMap(segment => {
      // Empty command answers are intentional. Rich content may enrich actual
      // prose, but must never recreate a protocol response as an answer bubble.
      if (!segment.answer.trim() ||
        (segment.sourceMessageId && (executionIds.has(segment.sourceMessageId) || toolSources.has(segment.sourceMessageId)))) return []
      // Older versions saved raw question JSON; normalize it at display time too.
      const text = cleanFocusAnswer((!turn.archived && segment.sourceMessageId ? richAnswers.get(segment.sourceMessageId) : '') || segment.answer)
      return text.trim() ? [{ cycle: segment.cycle, sourceMessageId: segment.sourceMessageId, text }] : []
    })
    const hasProcess = turn.segments.some(segment => segment.parts.length > 0) || executions.length > 0 || !!turn.toolCalls?.length || !!turn.parseFailures?.length
    const label = sendBlocked ? '消息发送失败 · 等待重试' : turn.commandRecovery && !turn.archived ? (turnWorking ? '正在修正指令…' : '指令未执行 · 等待处理') : pending ? '等待你确认下一步' : running ? '正在执行命令…' : toolRunning ? '正在调用工具…' : deliveryPending ? '正在回传执行结果…' :
      turn.status === 'stopped' ? '已停止 · 已有内容保留' : turnWorking ? '正在处理…' : '已回复'
    const userMessage = turn.userMessageId ? messagesById.get(turn.userMessageId) : null
    return <article className="focus-turn" data-message-id={turn.id} key={turn.id}>
      <div className={'focus-user' + (turn.userMessageId && editingId === turn.userMessageId ? ' focus-user--editing' : '')}>
        {userContent(turn.userMessageId, turn.userText, !!userMessage?.attachments.length || !!turn.userAttachments?.length, <>
          {userMessage?.attachments.map(props.renderAttachment)}
          {turn.userAttachments?.map((file, index) => <div className="focus-file-sent" key={index}>📎 {file.fileName}<span>{fileSize(file.sizeBytes)}</span></div>)}
        </>, turn.archived, turn.userSkills)}</div>
      <div className="focus-assistant">
        <div className="focus-assistant__head">{modelIcon ? <img src={modelIcon} alt="" /> : null}<span>{modelLabel}</span></div>
        <FocusDetails className="focus-process" ownerKey={viewOwnerKey} stateKey={'process:' + turn.id} defaultOpen summary={<><span className={turnWorking && !sendBlocked ? 'focus-chat__pulse' : 'focus-chat__status'} aria-hidden="true">{sendBlocked ? '!' : turnWorking ? '' : turn.status === 'blocked' ? '!' : turn.status === 'stopped' ? '○' : '✓'}</span>{label}{hasProcess ? <ProcessHint /> : null}</>}>{() =>
          <ProcessScroll scrollKey={viewOwnerKey + ':turn:' + turn.id} follow={turnWorking && !sendBlocked}>
          {turn.segments.map(segment => {
            const segmentExecutions = byCycle.get(segment.cycle) ?? EMPTY_RECORDS
            const segmentTools = toolsByCycle.get(segment.cycle) ?? EMPTY_TOOL_CALLS
            // Empty cycles have margins and padding too; they must not push the placeholder down.
            if (!segment.parts.length && !segmentExecutions.length && !segmentTools.length) return null
            return <div className="focus-process__cycle" key={segment.cycle}>
              {segment.parts.map((part, index) => part.kind === 'reasoning' ? <FocusDetails className="focus-reasoning" key={index} ownerKey={viewOwnerKey} stateKey={'reasoning:' + turn.id + ':' + segment.cycle + ':' + index} summary="思考过程">{() => <Markdown text={part.text} theme={theme} />}</FocusDetails> :
                <div className="focus-search" key={index}><span>检索资料</span>{part.url ? <a href={part.url} target="_blank" rel="noreferrer">{part.text}</a> : part.text}</div>)}
              {segmentExecutions.map(record => renderExecution(record, deliveryOf(record), !turn.archived))}
              {segmentTools.map(renderToolCall)}
            </div>
          })}
          {unassigned.map(record => renderExecution(record, deliveryOf(record), !turn.archived))}
          {unassignedTools.map(renderToolCall)}
          {turn.parseFailures?.map(failure => <details className="focus-execution" key={'parse:' + failure.messageId}>
            <summary>指令格式错误 · 未执行</summary><pre>{failure.text}</pre>
          </details>)}
          {!hasProcess ? <p className="focus-chat__muted focus-process__empty">{sendBlocked ? '消息尚未发送成功。' : turnWorking ? '正在思考…' : '本轮没有额外执行步骤。'}</p> : null}
          </ProcessScroll>
        }</FocusDetails>
        {turn.notice === 'parse-failed' ? <div className="focus-chat__error" role="alert">
          {turn.commandRecovery?.message || '指令格式无效，本条请求未执行。'}
          {!turn.archived && turn.commandRecovery && ['blocked', 'failed'].includes(turn.commandRecovery.status) && turn === lastTurn
            ? <button type="button" disabled={!!actionId} onClick={() => void retryFormat(turn.commandRecovery!.token)}>重试修正</button> : null}
          {!turn.archived ? <button type="button" onClick={props.onOpenTerminal}>查看执行控制</button> : null}
        </div> : null}
        {answers.map(answer => <div className="focus-answer" key={answer.cycle} data-question-answer={turn.archived ? undefined : answer.sourceMessageId ?? ''}><Markdown text={answer.text} theme={theme} /></div>)}
        {answers.length > 0 && !turnWorking ? <div className="focus-chat__actions"><button type="button" onClick={() => void copy(turn.id, answers.map(answer => answer.text).join('\n\n'))}>{copiedId === turn.id ? '已复制' : '复制回答'}</button></div> : null}
      </div>
    </article>
  }
  /*
   * The draft lives in this component, so every keystroke re-renders it. Rebuilding the whole
   * transcript each time (and re-running ProcessScroll's layout read) is what made typing
   * stutter in a long task; it depends only on the values listed here, never on the draft.
   */
  const transcript = useMemo(() =>
      <ConversationTranscript scrollKey={'focus:' + viewOwnerKey} ready={messagesReady && state !== null}>
        {entries.length === 0 ? <div className="focus-chat__empty">{modelIcon ? <img src={modelIcon} alt="" /> : null}<h2>从一个目标开始</h2><p>说说你想解决的问题，一起找到下一步。</p></div> : entries.map(entry => entry.compaction ?
          <div className="focus-chat__compacted" role="note" aria-label="会话已压缩" data-message-id={entry.compaction.id} key={entry.compaction.id}>
            <span aria-hidden="true">✓</span><span>会话已压缩</span>
          </div> : entry.turn ? renderTurn(entry.turn) :
          <article className={'focus-history focus-history--' + entry.message!.role + (editingId === entry.message!.id ? ' focus-user--editing' : '')} data-message-id={entry.message!.id} key={entry.message!.id}>
            {entry.message!.role === 'assistant' ? <div className="focus-assistant__head">{modelIcon ? <img src={modelIcon} alt="" /> : null}{modelLabel}</div> : null}
            {entry.message!.role === 'assistant' ? <>{entry.message!.attachments.map(props.renderAttachment)}<div data-question-answer={entry.message!.archived ? undefined : entry.message!.sourceMessageId ?? ''}><Markdown text={(!entry.message!.archived && richAnswers.get(entry.message!.sourceMessageId ?? '')) || entry.message!.content} theme={theme} /></div></>
              : userContent(entry.message!.id, cleanFocusUserText(entry.message!.content), entry.message!.attachments.length > 0, entry.message!.attachments.map(props.renderAttachment), entry.message!.archived)}
          </article>)}
      </ConversationTranscript>,
  [state, messages, messagesReady, theme, ownerKey, viewOwnerKey, actionId, copiedId, working, sending, stopping, editingId, settingPending, props.renderAttachment, props.onOpenTerminal, props.onRun, props.onSkip])
  return <FocusCitationContext.Provider value={citationContext}><FocusSmartUiContext.Provider value={smartUiContext}><section ref={citationRoot} className="focus-chat" aria-label="专注对话" data-theme={theme}>
    <FocusFilePreviewProvider key={ownerKey} owner={owner} visible={visible}>
    <header className="focus-chat__header">
      <span>{modelIcon ? <img className="focus-chat__brand-icon" src={modelIcon} alt={modelLabel} /> : <strong>{modelLabel}</strong>}</span>
      <button type="button" className="focus-chat__new-chat" aria-label="新建对话" title="新建对话"
        disabled={props.newChatDisabled || working || sending || stopping || !!editingId || settingPending !== null || compaction.blocked} onClick={startNewChat}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.375 2.625a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
        </svg>
      </button>
      {owner.platformId === 'deepseek' ? <dl className="focus-chat__model-info" aria-label="DeepSeek 固定模型信息" title="DeepSeek 网页端不提供模型和思考强度切换，此处固定显示。">
        <dt>当前模型</dt><dd className="focus-chat__model-name">DeepSeek-V4.1-Flash-1017</dd>
        <dt>思考强度</dt><dd>high</dd>
      </dl> : null}
      {owner.platformId === 'chatgpt' ? <FocusModelSettings settings={state?.modelSettings ?? null}
        disabled={working || sending || stopping || !!editingId || !ready || compaction.blocked} pending={settingPending}
        waiting={ready && !state?.modelSettings?.model && !modelReadAttempted.current && settingPending === null}
        onChange={(kind, value) => { void updateModelSettings(kind, value) }} onRefresh={() => { void updateModelSettings('read') }} /> : null}
      <FocusTokenUsage usage={tokenUsage} injection={state?.promptInjection} loading={!messagesReady || state === null} />
    </header>
    <div className="focus-chat__transcript" ref={transcriptRef}>
      {transcript}
      <SelectionAsk owner={owner} root={transcriptRef} />
    </div>
    <div className="focus-chat__bottom">
      {props.needsAnswer ? <div className="focus-chat__notice" role="status">{modelLabel} 需要你的回答，任务正在等待。<button type="button" onClick={props.onQuestion}>回答问题</button></div> : null}
      {ready && sendBlock ? <div className="focus-chat__notice" role="status"><span className="focus-chat__pulse" aria-hidden="true" />{sendBlock} 可以先输入，草稿会保留。</div> : null}
      {promptQueueFailures.map(failure => {
        const local = queuedDrafts.has(failure.sourceId)
        return <div key={failure.id} className="focus-send-failure" role="alert">
          <div className="focus-send-failure__text"><strong>{failure.uncertain ? '排队的消息可能已发送' : '排队的消息未发送'}</strong>
            <p>{failure.uncertain ? '发送中途被取消，结果未确认。请先到原始视图核对：已发送就忽略；未发送再恢复草稿。' : sendOutcomeDescription(failure.outcome, modelLabel)}</p>
            <small>{failure.text.length > 120 ? failure.text.slice(0, 120) + '…' : failure.text}
              {failure.attachments?.length && !local ? `（附件需重新添加：${failure.attachments.map(file => file.name).join('、')}）` : ''}</small></div>
          <div className="focus-send-failure__actions">
            {failure.uncertain ? <button type="button" onClick={props.onOriginal}>查看原始视图</button> : null}
            {local || failure.text ? <button type="button" onClick={() => restoreQueuedFailure(failure)}>{local ? '恢复草稿' : '恢复文字到输入框'}</button> : null}
            <button type="button" onClick={() => { queuedDrafts.delete(failure.sourceId); dismissQueueFailure(failure.id) }}>忽略</button>
          </div>
        </div>
      })}
      {state?.outboundQueue?.blocked ? <div className="focus-send-failure" role="alert">
        <div className="focus-send-failure__text"><strong>发送队列已暂停</strong><p>{state.outboundQueue.blockedReason || '队首消息的发送状态尚未确认。'}</p>
          <small>请先到原始视图核对队首消息，按核对结果跳过它，后续消息才会继续发送。</small></div>
        <div className="focus-send-failure__actions">
          <button type="button" onClick={props.onOriginal}>查看原始视图</button>
          {state.outboundQueue.blocked.restorable ? <>
            <button type="button" onClick={() => void window.api.resolveFocusOutboundQueue(owner, state.outboundQueue!.blocked!.id, 'acknowledge-skip')}>已发送，跳过</button>
            <button type="button" onClick={() => void window.api.resolveFocusOutboundQueue(owner, state.outboundQueue!.blocked!.id, 'restore-skip')}>未发送，恢复草稿并跳过</button>
          </> : <button type="button" onClick={() => void window.api.resolveFocusOutboundQueue(owner, state.outboundQueue!.blocked!.id, 'acknowledge-skip')}>已核对，跳过队首</button>}
        </div>
      </div> : null}
      {!ready ? <div className="focus-chat__notice">网页尚未就绪。<button type="button" onClick={props.onOriginal}>切回原始视图完成登录或检查页面</button></div> : null}
      {state?.nativeDraft && !sending ? <div className="focus-chat__notice">原网页输入框中保留着内容，专注视图不会覆盖。<button type="button" onClick={props.onOriginal}>查看原始视图</button></div> : null}
      {sendFailure ? <div className="focus-send-failure" role="alert" aria-busy={actionId === 'native-send-retry'}>
        <div className="focus-send-failure__text"><strong>消息未发送成功</strong><p>{sendFailure.message}</p>
          <small>{sendFailure.retryable ? '消息内容已保留，重试只发送这条消息。' : '原网页暂未提供可用的重试控件，请在原始视图中处理。'}</small></div>
        <div className="focus-send-failure__actions">
          <button type="button" disabled={!sendFailure.retryable || !!actionId || sending || stopping || !ready || !!state?.nativeDraft}
            onClick={() => void retrySend()}>{actionId === 'native-send-retry' ? '正在重试…' : '重试发送'}</button>
          <button type="button" onClick={props.onOriginal}>查看原始视图</button>
        </div>
      </div> : null}
      {settingError ? <div className="focus-chat__error" role="alert">{settingError}<button type="button" onClick={props.onOriginal}>查看原始视图</button></div> : null}
      {error ? <div className="focus-chat__error" role="alert">{error}<button type="button" onClick={props.onOriginal}>查看原始视图</button></div> : null}
      <FocusCompaction owner={owner} visible={visible} state={compaction.state} pending={compaction.pending} error={compaction.error} act={compaction.act} />
      {queueTrayVisible ? <OutboundQueueTray queue={outboundQueue!} collapsed={queueCollapsed} onToggle={toggleQueue}
        onCancelActive={cancelActiveQueued} onEdit={item => void pullQueued(item, 'edit')} onDelete={item => void pullQueued(item, 'discard')} /> : null}
      <form className={'focus-composer' + (queueTrayVisible ? ' has-queue' : '')} onSubmit={event => void submit(event)}>
        {skillsOpen ? <div className="focus-skills" id={'focus-skills-' + owner.sessionId} role="listbox" aria-label="选择技能">
          <div className="focus-skills__label">技能 · ↑↓ 选择 · Enter 确定 · Esc 关闭</div>
          {matchingSkills.length ? matchingSkills.map((skill, index) => <div className="focus-skills__row" key={skill.id} role="presentation"><button type="button" role="option" aria-selected={activeSkill?.id === skill.id} id={'focus-skill-' + skill.id + '-' + owner.sessionId}
            className="focus-skills__item" disabled={!!skillDisabled(skill.id)} onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => setSkillIndex(index)} onClick={() => chooseSkill(skill.id)}>
            <span className="focus-skills__icon" aria-hidden="true"><FocusSkillIcon skill={skill.id} /></span>
            <span className="focus-skills__body"><strong>{skill.name}</strong><small>{skillDisabled(skill.id) || (selectedSkills.includes(skill.id as FocusToolSkill) ? '已添加到当前输入' : skill.description)}</small></span>
            <span className="focus-skills__key">↵</span>
          </button></div>) : <div className="focus-skills__empty">没有匹配的技能</div>}
        </div> : null}
        {selectedSkills.length ? <div className="focus-composer__skills" aria-label="本次使用的技能">
          {selectedSkills.map(id => <span className="focus-skill-chip" key={id}><FocusSkillIcon skill={id} /><span>{FOCUS_SKILLS.find(skill => skill.id === id)!.name}</span>
            <button type="button" disabled={sending} aria-label={FOCUS_SKILLS.find(skill => skill.id === id)!.name + '设置'} onClick={event => props.onSkillSettings(id, event.currentTarget)}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 7h10m4 0h4M3 17h4m4 0h10" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
            </button>
            <button type="button" disabled={sending} aria-label={'移除' + FOCUS_SKILLS.find(skill => skill.id === id)!.name} onClick={() => changeSkills(selectedSkills.filter(skill => skill !== id))}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </span>)}<small>随本次任务按需加载</small>
        </div> : null}
        {draftFiles.length ? <div className="focus-composer__files" aria-label="待发送附件">{draftFiles.map(item =>
          <div className="focus-draft-file" key={item.id}>
            <FilePreview file={item.file} onPreview={props.onPreviewImage} />
            <span className="focus-draft-file__name" title={item.file.name}>{item.file.name}<small>{fileSize(item.file.size)} · {sending ? '上传并发送中…' : '待发送'}</small></span>
            <button type="button" disabled={sending} aria-label={'移除附件 ' + item.file.name} onClick={() => removeFile(item.id)}>×</button>
          </div>)}</div> : null}
        <textarea ref={composerInput} value={draft} disabled={!!editingId || compaction.blocked} maxLength={20000} rows={2} aria-label="消息"
          placeholder={queueTrayVisible ? '继续输入，新消息会排在队列后按顺序发送… 输入 // 选择技能' : '描述你想完成的任务… 输入 // 选择技能'}
          aria-expanded={skillsOpen} aria-controls={skillsOpen ? 'focus-skills-' + owner.sessionId : undefined}
          aria-activedescendant={skillsOpen && activeSkill ? 'focus-skill-' + activeSkill.id + '-' + owner.sessionId : undefined}
          onSelect={event => setSkillCaret(event.currentTarget.selectionStart)}
          onChange={event => { setDraftText(event.target.value); setSkillCaret(event.currentTarget.selectionStart); setSkillsDismissed(false) }}
          onPaste={event => {
            const files = [...event.clipboardData.files]
            const pastedFiles = files.length ? files : [...event.clipboardData.items].filter(item => item.kind === 'file').flatMap(item => { const file = item.getAsFile(); return file ? [file] : [] })
            const raw = event.clipboardData.getData('text/plain')
            const text = trimPastedLines(raw)
            const input = event.currentTarget
            if (!pastedFiles.length) {
              // Plain text keeps the browser's own paste (and its undo) unless there is blank-line padding to drop.
              if (text === raw) return
              event.preventDefault()
              insertPastedText(input, text)
              return
            }
            event.preventDefault()
            if (sendLock.current) { setError('当前正在发送，请等待完成后再粘贴附件。'); return }
            addFiles(pastedFiles)
            if (text) insertPastedText(input, text)
          }}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
            if (skillsOpen) {
              if (['ArrowUp', 'ArrowDown', 'Escape', 'Enter'].includes(event.key) && !event.shiftKey) {
                event.preventDefault()
                if (event.key === 'Escape') setSkillsDismissed(true)
                if (event.key === 'ArrowDown' && matchingSkills.length) setSkillIndex((skillIndex + 1) % matchingSkills.length)
                if (event.key === 'ArrowUp' && matchingSkills.length) setSkillIndex((skillIndex - 1 + matchingSkills.length) % matchingSkills.length)
                if (event.key === 'Enter' && !event.repeat && activeSkill) chooseSkill(activeSkill.id)
                return
              }
            }
            // As in terminal agents: ↑ in an empty composer pulls the last waiting message back for editing.
            if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
              !draftRef.current && !filesRef.current.length && lastEditableQueued) {
              event.preventDefault()
              void pullQueued(lastEditableQueued, 'edit')
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!sending && ready && !sendBlock && !compaction.blocked) event.currentTarget.form?.requestSubmit() }
          }} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = '' }} />
        <div className="focus-composer__tools"><div className="focus-composer__left">
          <button type="button" className="focus-composer__attachment" disabled={sending || !!editingId || changingMode !== null || settingPending !== null || compaction.blocked} onClick={() => fileInput.current?.click()} title="添加附件，也可直接粘贴截图或文件">＋ 附件</button>
          {owner.platformId === 'deepseek' ? <FocusComposerModes modes={state?.composerModes ?? []} disabled={sending || stopping || !!working || !!sendFailure || !!editingId || !ready || compaction.blocked}
            pending={changingMode} onChange={(id, active) => { void changeMode(id, active) }} /> : null}
        </div><span>{modelLabel}</span>
          {nativeGenerating || stopping ? <button type="button" className="focus-composer__send" disabled={stopping || sending || !ready} onClick={() => void stop()} aria-label="停止生成">{stopping ? <ComposerPendingIcon /> : <svg className="focus-composer__stop-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="3" width="10" height="10" rx="0.5" fill="currentColor" /></svg>}</button> :
            <button type="submit" className="focus-composer__send" disabled={sending || props.needsAnswer || !!sendFailure || changingMode !== null || settingPending !== null || !!editingId || !ready || !!state?.nativeDraft || !!sendBlock || compaction.blocked || skillsOpen || (!!state?.outboundQueue?.blocked) || (!draft.trim() && !draftFiles.length)} aria-label="发送消息" title={state?.outboundQueue?.blockedReason || sendBlock || undefined}>{sending ? <ComposerPendingIcon /> : '↑'}</button>}
        </div>
      </form><p className="focus-composer__hint">Enter 发送 · Shift+Enter 换行{lastEditableQueued ? ' · ↑ 编辑排队的消息' : ''}</p>
    </div>
    </FocusFilePreviewProvider></section></FocusSmartUiContext.Provider></FocusCitationContext.Provider>
}

export default memo(FocusChatView)
