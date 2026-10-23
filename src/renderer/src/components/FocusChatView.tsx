import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, JSX, ReactNode, RefObject, SyntheticEvent } from 'react'
import MDEditor from '@uiw/react-md-editor'
import ConversationTranscript from './ConversationTranscript'
import FocusChart, { parseFocusChart } from './FocusChart'
import type { FocusChartData } from './FocusChart'
import deepseekIcon from '../assets/DeepSeek.svg'
import chatgptIcon from '../assets/ChatGPT.svg'
// The view's brand icon per focus platform (`FOCUS_PLATFORMS`); a platform without one shows its name.
const FOCUS_ICONS: Readonly<Record<string, string>> = { deepseek: deepseekIcon, chatgpt: chatgptIcon }
import type { AppTheme, ConversationAttachment, ConversationMessage, ExecutionRecord } from '@shared/types'
import type { FocusChatState, FocusOwner, FocusTurn, FocusDelivery } from '@shared/focus-chat'
import { cleanFocusAnswer, cleanFocusUserText, focusOwnerKey, focusDelivery, focusPlatformLabel } from '@shared/focus-chat'
import { FOCUS_MAX_FILES, FOCUS_MAX_FILE_BYTES, FOCUS_MAX_BATCH_BYTES } from '@shared/focus-chat'
import type { FocusAttachmentInput } from '@shared/focus-chat'
import './FocusChatView.css'

interface Props {
  owner: FocusOwner
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
  onRun(messageId: string): Promise<void>
  onSkip(messageId: string): Promise<void>
  onStop(): Promise<void>
  onPreviewImage(source: string, name: string): void
  renderAttachment(attachment: ConversationAttachment): ReactNode
}
/** The expanded process scrolls on its own; a working turn keeps its newest step in view unless the user scrolled up. */
function ProcessScroll(props: { follow: boolean; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const follow = useRef(props.follow)
  const syncRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    const content = contentRef.current
    if (!element || !content) return
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
  }}><div className="focus-process__content" ref={contentRef}>{props.children}</div></div>
}
function ProcessHint(): JSX.Element {
  return <span className="focus-process__hint">查看过程
    <svg className="focus-process__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4" /></svg>
  </span>
}
const labels: Record<string, string> = {
  pending: '等待确认', blocked: '等待确认', running: '正在执行', done: '执行完成',
  failed: '执行失败', timeout: '执行超时', interrupted: '已中断', skipped: '已跳过'
}
/*
 * Which 查看过程 / 思考过程 / 查看命令与输出 blocks the user opened, per conversation owner.
 * The view unmounts on every switch to the original or local view, so DOM state alone came
 * back collapsed. Kept in memory for the app's lifetime, like the unsent attachments below.
 */
const openDetails = new Map<string, Set<string>>()
interface DraftFile { id: string; file: File }
// Keep unsent files across view switches in memory, never in localStorage.
const fileDrafts = new Map<string, DraftFile[]>()
const fileDraftListeners = new Map<string, Set<() => void>>()
function saveFileDraft(ownerKey: string, files: DraftFile[]): void {
  if (files.length) fileDrafts.set(ownerKey, files)
  else fileDrafts.delete(ownerKey)
  fileDraftListeners.get(ownerKey)?.forEach(listener => listener())
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
const CHART_BLOCK = /<!--focus-chart (\{[\s\S]*?\}) -->\n((?:>[^\n]*(?:\n|$))*)/g
const CHART_MARKER = /<!--focus-chart [\s\S]*? -->\n?/g
const Markdown = memo(function Markdown({ text, theme }: { text: string; theme: AppTheme }): JSX.Element {
  const source = cleanFocusAnswer(text)
  const blocks: Array<string | FocusChartData> = []
  let last = 0
  for (const match of source.matchAll(CHART_BLOCK)) {
    const chart = parseFocusChart(match[1])
    if (!chart) continue
    blocks.push(source.slice(last, match.index), chart)
    last = match.index + match[0].length
  }
  if (!blocks.length) return <MDEditor.Markdown source={source} skipHtml wrapperElement={{ 'data-color-mode': theme }} />
  blocks.push(source.slice(last))
  return <>{blocks.map((block, index) => typeof block === 'string'
    ? block.trim() ? <MDEditor.Markdown key={index} source={block} skipHtml wrapperElement={{ 'data-color-mode': theme }} /> : null
    : <FocusChart key={index} data={block} />)}</>
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

export default function FocusChatView(props: Props): JSX.Element {
  const { owner, visible, theme, messages, messagesReady } = props
  const ownerKey = focusOwnerKey(owner)
  // `open` follows the remembered set; the browser toggles the element itself and onToggle records it.
  const remembered = (key: string): { open: boolean; onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => void } => ({
    open: openDetails.get(ownerKey)?.has(key) ?? false,
    onToggle: event => {
      const set = openDetails.get(ownerKey) ?? new Set<string>()
      if (event.currentTarget.open) set.add(key)
      else set.delete(key)
      if (set.size) openDetails.set(ownerKey, set)
      else openDetails.delete(ownerKey)
    }
  })
  const modelLabel = focusPlatformLabel(owner.platformId)
  const modelIcon = FOCUS_ICONS[owner.platformId]
  const [state, setState] = useState<FocusChatState | null>(null)
  const [draft, setDraft] = useState(() => readDraft(owner))
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [draftFiles, setDraftFiles] = useState<DraftFile[]>(() => fileDrafts.get(ownerKey) ?? [])
  const filesRef = useRef<DraftFile[]>(draftFiles)
  const fileInput = useRef<HTMLInputElement>(null)
  const sendLock = useRef(false)
  const sendCancelled = useRef(false)
  const [error, setError] = useState('')
  const [actionId, setActionId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const alive = useRef(true)
  const composing = useRef(false)
  const draftRef = useRef(draft)
  const lastSnapshot = useRef('')
  const transcriptRef = useRef<HTMLDivElement>(null)
  useEffect(() => { alive.current = true; return () => {
    alive.current = false
  } }, [])
  useEffect(() => {
    const update = (): void => {
      const files = fileDrafts.get(ownerKey) ?? []
      filesRef.current = files
      setDraftFiles(files)
    }
    const listeners = fileDraftListeners.get(ownerKey) ?? new Set<() => void>()
    listeners.add(update)
    fileDraftListeners.set(ownerKey, listeners)
    update()
    return () => { listeners.delete(update); if (!listeners.size) fileDraftListeners.delete(ownerKey) }
  }, [ownerKey])
  const addFiles = (incoming: File[]): void => {
    if (!incoming.length || sendLock.current) return
    const current = filesRef.current
    if (current.length + incoming.length > FOCUS_MAX_FILES) { setError('每条消息最多添加 3 个附件。'); return }
    if (incoming.some(file => !file.size || file.size > FOCUS_MAX_FILE_BYTES)) { setError('附件不能为空，单个附件不能超过 20 MB。'); return }
    if ([...current.map(item => item.file), ...incoming].reduce((sum, file) => sum + file.size, 0) > FOCUS_MAX_BATCH_BYTES) { setError('本条消息的附件合计不能超过 25 MB。'); return }
    const added = incoming.map(file => ({ id: crypto.randomUUID(), file }))
    filesRef.current = [...current, ...added]
    saveFileDraft(ownerKey, filesRef.current)
    setDraftFiles(filesRef.current)
    setError('')
  }
  const removeFile = (id: string): void => {
    if (sendLock.current) return
    filesRef.current = filesRef.current.filter(file => file.id !== id)
    saveFileDraft(ownerKey, filesRef.current)
    setDraftFiles(filesRef.current)
  }

  useEffect(() => {
    if (!visible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await window.api.getFocusChat(owner)
        if (disposed || !next || focusOwnerKey(next) !== ownerKey) return
        const signature = JSON.stringify(next)
        if (signature !== lastSnapshot.current) {
          lastSnapshot.current = signature
          setState(next)
        }
      } catch {
        if (!disposed) setError('暂时无法读取页面状态，请稍后重试或切回原始视图。')
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll() }, 900)
      }
    }
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [ownerKey, visible])

  const turns = state?.turns ?? []
  const records = state?.executions ?? []
  const recordsById = useMemo(() => new Map(records.map(record => [record.messageId, record])), [records])
  const messagesById = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const represented = useMemo(() => {
    const ids = new Set<string>()
    const sources = new Set<string>()
    for (const turn of turns) {
      if (turn.userMessageId) ids.add(turn.userMessageId)
      for (const segment of turn.segments) if (segment.sourceMessageId) sources.add(segment.sourceMessageId)
    }
    return { ids, sources }
  }, [turns])
  // Only explicitly associated rows are merged. Unknown old history stays readable.
  const history = messages.filter(message => !represented.ids.has(message.id) &&
    !(message.sourceMessageId && represented.sources.has(message.sourceMessageId)) &&
    !message.sourceMessageId?.startsWith('read-files:'))
  const entries = [...history.map(message => ({ at: message.createdAt, message, turn: null as FocusTurn | null })),
    ...turns.map(turn => ({ at: turn.createdAt, turn, message: null as ConversationMessage | null }))]
    .sort((a, b) => a.at - b.at)
  const lastTurn = turns.at(-1)
  const working = props.needsAnswer || state?.waiting === true || state?.generating === 'active' || lastTurn?.status === 'working'
  const linkedExecutions = new Set(turns.flatMap(turn => turn.executionIds))
  const unlinkedAttention = records.filter(record => !linkedExecutions.has(record.messageId) && executionNeedsAction(record, focusDelivery(record)))
  const ready = state?.ready === true
  const setDraftText = (text: string): void => {
    draftRef.current = text
    setDraft(text)
    try { localStorage.setItem(draftKey(owner), text) } catch { /* Keep the in-memory draft. */ }
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
    const sourceFiles = filesRef.current
    if ((!text.trim() && !sourceFiles.length) || sendLock.current || working || !ready || state?.nativeDraft) return
    sendLock.current = true
    sendCancelled.current = false
    setSending(true)
    setError('')
    try {
      const files = await Promise.all(sourceFiles.map(item => encodeFile(item.file)))
      // Reading files can finish after a conversation change; never send an abandoned draft.
      if (!alive.current || sendCancelled.current) return
      const result = await window.api.sendFocusMessage({ ...owner, text, files })
      // Clearing the source draft after a first-send route change is safe only
      // when its exact value still belongs to this confirmed submission.
      if (result === 'ok') {
        const submittedIds = new Set(sourceFiles.map(item => item.id))
        saveFileDraft(ownerKey, (fileDrafts.get(ownerKey) ?? []).filter(item => !submittedIds.has(item.id)))
        try { if (localStorage.getItem(draftKey(owner)) === text) localStorage.removeItem(draftKey(owner)) } catch { /* Optional draft persistence. */ }
        if (alive.current && draftRef.current === text) setDraftText('')
        if (alive.current) {
          filesRef.current = []
          setDraftFiles([])
        }
      } else if (alive.current) {
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
          cancelled: '发送已取消，文字和附件仍保留。'
        }
        setError(descriptions[result] || '消息未发送，草稿已保留。')
      }
    } catch { if (alive.current) setError('发送结果未确认，草稿已保留。请到原始视图核对后再操作。') }
    finally { sendLock.current = false; if (alive.current) setSending(false) }
  }
  const stop = async (): Promise<void> => {
    if (stopping) return
    sendCancelled.current = true
    setStopping(true)
    try { await props.onStop() }
    catch { if (alive.current) setError('结束任务未确认，请打开执行控制查看当前状态。') }
    finally { if (alive.current) setStopping(false) }
  }
  const action = async (id: string, skip = false): Promise<void> => {
    if (actionId) return
    setActionId(id)
    try { await (skip ? props.onSkip(id) : props.onRun(id)) }
    catch { if (alive.current) setError('操作尚未确认，请打开执行控制查看记录。') }
    finally { if (alive.current) setActionId(null) }
  }
  const copy = async (id: string, text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(cleanFocusAnswer(text).replace(CHART_MARKER, '')); setCopiedId(id); setTimeout(() => { if (alive.current) setCopiedId(current => current === id ? null : current) }, 2000) }
    catch { setError('复制失败，可以选择正文手动复制。') }
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
      <details {...remembered('exec:' + record.messageId)}><summary>查看命令与输出{record.exitCode !== null ? ' · 退出码 ' + record.exitCode : ''}</summary><pre>{record.command}</pre>{record.output ? <pre className="focus-execution__output">{record.output}</pre> : null}
        <div className="focus-execution__meta">{record.startedAt && record.finishedAt ? ((record.finishedAt - record.startedAt) / 1000).toFixed(1) + ' 秒 · ' : ''}{delivery === 'sent' ? '结果已回传' : delivery === 'pending' && record.status === 'done' ? '等待结果回传' : delivery === 'blocked' || delivery === 'failed' ? '结果尚未回传' : delivery === 'superseded' ? '结果未回传：已由后续执行接替' : ''}</div>
      </details>
      {actionable && ['pending', 'blocked'].includes(record.status) ? <div className="focus-chat__actions"><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId)}>{actionId === record.messageId ? '处理中…' : '运行'}</button><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId, true)}>跳过</button></div> : null}
      {actionable && (delivery === 'blocked' || delivery === 'failed' || ['failed', 'timeout'].includes(record.status)) ? <button type="button" onClick={props.onOpenTerminal}>打开执行控制</button> : null}
    </div>
  )
  const renderTurn = (turn: FocusTurn): JSX.Element => {
    const executions = turn.executionIds.flatMap(id => recordsById.get(id) ? [recordsById.get(id)!] : [])
    const deliveryOf = (record: ExecutionRecord): FocusDelivery | undefined => focusDelivery(record, turn.deliveries[record.messageId])
    const running = executions.some(record => record.status === 'running')
    const pending = executions.some(record => ['pending', 'blocked'].includes(record.status))
    const deliveryPending = executions.some(record => record.status === 'done' && deliveryOf(record) === 'pending')
    const answer = turn.segments.at(-1)?.answer || ''
    const hasProcess = turn.segments.some(segment => segment.parts.length > 0) || executions.length > 0 || !!turn.parseFailures?.length
    const label = turn.commandRecovery ? (turn.status === 'working' ? '正在修正指令…' : '指令未执行 · 等待处理') : pending ? '等待你确认下一步' : running ? '正在执行命令…' : deliveryPending ? '正在回传执行结果…' :
      turn.status === 'stopped' ? '已停止 · 已有内容保留' : turn.status === 'working' ? '正在处理…' : '已回复'
    const userMessage = turn.userMessageId ? messagesById.get(turn.userMessageId) : null
    return <article className="focus-turn" data-message-id={turn.id} key={turn.id}>
      <div className="focus-user">{turn.userText ? <p>{turn.userText}</p> : null}{userMessage?.attachments.map(props.renderAttachment)}
        {turn.userAttachments?.map((file, index) => <div className="focus-file-sent" key={index}>📎 {file.fileName}<span>{fileSize(file.sizeBytes)}</span></div>)}</div>
      <div className="focus-assistant">
        <div className="focus-assistant__head">{modelIcon ? <img src={modelIcon} alt="" /> : null}<span>{modelLabel}</span></div>
        <details className="focus-process" {...remembered('process:' + turn.id)}><summary><span className={turn.status === 'working' ? 'focus-chat__pulse' : 'focus-chat__status'} aria-hidden="true">{turn.status === 'working' ? '' : turn.status === 'blocked' ? '!' : turn.status === 'stopped' ? '○' : '✓'}</span>{label}{hasProcess ? <ProcessHint /> : null}</summary>
          <ProcessScroll follow={turn.status === 'working'}>
          {turn.segments.map(segment => {
            const segmentExecutions = executions.filter(record => turn.executionCycles?.[record.messageId] === segment.cycle)
            const commentary = segment !== turn.segments.at(-1) ? segment.answer : ''
            // Empty cycles have margins and padding too; they must not push the placeholder down.
            if (!segment.parts.length && !commentary && !segmentExecutions.length) return null
            return <div className="focus-process__cycle" key={segment.cycle}>
              {segment.parts.map((part, index) => part.kind === 'reasoning' ? <details className="focus-reasoning" key={index} {...remembered('reasoning:' + turn.id + ':' + segment.cycle + ':' + index)}><summary>思考过程</summary><Markdown text={part.text} theme={theme} /></details> :
                <div className="focus-search" key={index}><span>检索资料</span>{part.url ? <a href={part.url} target="_blank" rel="noreferrer">{part.text}</a> : part.text}</div>)}
              {commentary ? <div className="focus-process__commentary"><Markdown text={commentary} theme={theme} /></div> : null}
              {segmentExecutions.map(record => renderExecution(record, deliveryOf(record), true))}
            </div>
          })}
          {executions.filter(record => !turn.segments.some(segment => segment.cycle === turn.executionCycles?.[record.messageId])).map(record => renderExecution(record, deliveryOf(record), true))}
          {turn.parseFailures?.map(failure => <details className="focus-execution" key={'parse:' + failure.messageId}>
            <summary>指令格式错误 · 未执行</summary><pre>{failure.text}</pre>
          </details>)}
          {!hasProcess ? <p className="focus-chat__muted focus-process__empty">{turn.status === 'working' ? '正在思考…' : '本轮没有额外执行步骤。'}</p> : null}
          </ProcessScroll>
        </details>
        {turn.notice === 'parse-failed' ? <div className="focus-chat__error" role="alert">
          {turn.commandRecovery?.message || '指令格式无效，本条请求未执行。'}
          {turn.commandRecovery && ['blocked', 'failed'].includes(turn.commandRecovery.status) && turn === state?.turns.at(-1)
            ? <button type="button" disabled={!!actionId} onClick={() => void retryFormat(turn.commandRecovery!.token)}>重试修正</button> : null}
          <button type="button" onClick={props.onOpenTerminal}>查看执行控制</button>
        </div> : null}
        {answer ? <div className="focus-answer" data-question-answer={turn.segments.at(-1)?.sourceMessageId ?? ''}><Markdown text={answer} theme={theme} /></div> : null}
        {answer && turn.status !== 'working' ? <div className="focus-chat__actions"><button type="button" onClick={() => void copy(turn.id, answer)}>{copiedId === turn.id ? '已复制' : '复制回答'}</button></div> : null}
      </div>
    </article>
  }
  /*
   * The draft lives in this component, so every keystroke re-renders it. Rebuilding the whole
   * transcript each time (and re-running ProcessScroll's layout read) is what made typing
   * stutter in a long task; it depends only on the values listed here, never on the draft.
   */
  const transcript = useMemo(() =>
      <ConversationTranscript scrollKey={'focus:' + ownerKey} ready={messagesReady && state !== null}>
        {entries.length === 0 ? <div className="focus-chat__empty">{modelIcon ? <img src={modelIcon} alt="" /> : null}<h2>从一个目标开始</h2><p>说说你想解决的问题，一起找到下一步。</p></div> : entries.map(entry => entry.turn ? renderTurn(entry.turn) :
          <article className={'focus-history focus-history--' + entry.message!.role} data-message-id={entry.message!.id} key={entry.message!.id}>
            {entry.message!.role === 'assistant' ? <div className="focus-assistant__head">{modelIcon ? <img src={modelIcon} alt="" /> : null}{modelLabel}</div> : null}
            {entry.message!.attachments.map(props.renderAttachment)}
            {entry.message!.role === 'assistant' ? <div data-question-answer={entry.message!.sourceMessageId ?? ''}><Markdown text={entry.message!.content} theme={theme} /></div> : <p>{cleanFocusUserText(entry.message!.content)}</p>}
          </article>)}
        {unlinkedAttention.length > 0 ? <details className="focus-process" {...remembered('unlinked-process')}>
          <summary>其他执行记录 · {unlinkedAttention.length}<ProcessHint /></summary>
          <ProcessScroll follow={working}>
            {unlinkedAttention.map(record => renderExecution(record, focusDelivery(record), true))}
          </ProcessScroll>
        </details> : null}
      </ConversationTranscript>,
  [state, messages, messagesReady, theme, ownerKey, actionId, copiedId, working, props.renderAttachment, props.onOpenTerminal, props.onRun, props.onSkip])
  return <section className="focus-chat" aria-label="专注对话" data-theme={theme}>
    <header className="focus-chat__header">
      <span>{modelIcon ? <img className="focus-chat__brand-icon" src={modelIcon} alt={modelLabel} /> : <strong>{modelLabel}</strong>}</span>
      <button type="button" className="focus-chat__new-chat" aria-label="新建对话" title="新建对话"
        disabled={props.newChatDisabled || working || sending || stopping} onClick={props.onNewChat}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.375 2.625a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
        </svg>
      </button>
    </header>
    <div className="focus-chat__transcript" ref={transcriptRef}>
      {transcript}
      <SelectionAsk owner={owner} root={transcriptRef} />
    </div>
    <div className="focus-chat__bottom">
      {props.needsAnswer ? <div className="focus-chat__notice" role="status">{modelLabel} 需要你的回答，任务正在等待。<button type="button" onClick={props.onQuestion}>回答问题</button></div> : null}
      {!ready ? <div className="focus-chat__notice">网页尚未就绪。<button type="button" onClick={props.onOriginal}>切回原始视图完成登录或检查页面</button></div> : null}
      {state?.nativeDraft && !sending ? <div className="focus-chat__notice">原网页输入框中保留着内容，专注视图不会覆盖。<button type="button" onClick={props.onOriginal}>查看原始视图</button></div> : null}
      {error ? <div className="focus-chat__error" role="alert">{error}<button type="button" onClick={props.onOriginal}>查看原始视图</button></div> : null}
      <form className="focus-composer" onSubmit={event => void submit(event)}>
        {draftFiles.length ? <div className="focus-composer__files" aria-label="待发送附件">{draftFiles.map(item =>
          <div className="focus-draft-file" key={item.id}>
            <FilePreview file={item.file} onPreview={props.onPreviewImage} />
            <span className="focus-draft-file__name" title={item.file.name}>{item.file.name}<small>{fileSize(item.file.size)} · {sending ? '上传并发送中…' : '待发送'}</small></span>
            <button type="button" disabled={sending} aria-label={'移除附件 ' + item.file.name} onClick={() => removeFile(item.id)}>×</button>
          </div>)}</div> : null}
        <textarea value={draft} maxLength={20000} rows={2} aria-label="消息" placeholder="描述你想完成的任务…" onChange={event => setDraftText(event.target.value)}
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
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); if (!working && !sending && ready) event.currentTarget.form?.requestSubmit() } }} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = '' }} />
        <div className="focus-composer__tools"><button type="button" disabled={sending} onClick={() => fileInput.current?.click()} title="添加附件，也可直接粘贴截图或文件">＋ 附件</button><span>{modelLabel}</span>
          {working || stopping || (sending && draftFiles.length > 0) ? <button type="button" className="focus-composer__send" disabled={stopping} onClick={() => void stop()} aria-label="结束当前任务">{stopping ? '…' : <svg className="focus-composer__stop-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="3" width="10" height="10" rx="0.5" fill="currentColor" /></svg>}</button> :
            <button type="submit" className="focus-composer__send" disabled={sending || !ready || !!state?.nativeDraft || (!draft.trim() && !draftFiles.length)} aria-label="发送消息">{sending ? '…' : '↑'}</button>}
        </div>
      </form><p className="focus-composer__hint">Enter 发送 · Shift+Enter 换行</p>
    </div>
  </section>
}
