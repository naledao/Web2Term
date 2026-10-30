import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, FormEvent, JSX, ReactNode, RefObject, SyntheticEvent } from 'react'
import MDEditor from '@uiw/react-md-editor'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import ConversationTranscript from './ConversationTranscript'
import FocusChart, { parseFocusChart } from './FocusChart'
import type { FocusChartData } from './FocusChart'
import FocusSmartUi, { FocusSmartUiContext } from './FocusSmartUi'
import FocusLayout from './FocusLayout'
import FocusComposerModes from './FocusComposerModes'
import FocusCodeBlock from './FocusCodeBlock'
import FocusModelSettings from './FocusModelSettings'
import { parseFocusLayout } from '@shared/focus-layout'
import type { FocusLayoutData } from '@shared/focus-layout'
import { parseFocusUi } from '@shared/focus-smart-ui'
import type { FocusUiAction, FocusUiWidget } from '@shared/focus-smart-ui'
import type { FocusSendOutcome, FocusComposerModeId, FocusModelSettingKind } from '@shared/focus-chat'
import deepseekIcon from '../assets/DeepSeek.svg'
import chatgptIcon from '../assets/ChatGPT.svg'
// The view's brand icon per focus platform (`FOCUS_PLATFORMS`); a platform without one shows its name.
const FOCUS_ICONS: Readonly<Record<string, string>> = { deepseek: deepseekIcon, chatgpt: chatgptIcon }
import type { AppTheme, ConversationAttachment, ConversationMessage, ExecutionRecord } from '@shared/types'
import type { FocusChatState, FocusOwner, FocusTurn, FocusDelivery } from '@shared/focus-chat'
import { cleanFocusAnswer, cleanFocusUserText, focusOwnerKey, focusDelivery, focusPlatformLabel, supportsFocusEdit } from '@shared/focus-chat'
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
const RICH_BLOCK = /<!--focus-(chart|ui|layout) (\{[^\n]*\}) -->\n((?:>[^\n]*(?:\n|$))*)/g
const CHART_MARKER = /<!--focus-(?:chart|ui|layout) [\s\S]*? -->\n?/g
const mathRemarkPlugins = [remarkMath]
const mathRehypePlugins: NonNullable<ComponentProps<typeof MDEditor.Markdown>['rehypePlugins']> = [
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
  if (!blocks.length) return <MDEditor.Markdown source={source} skipHtml disableCopy components={{ pre: FocusCodeBlock }} remarkPlugins={mathRemarkPlugins} rehypePlugins={mathRehypePlugins} wrapperElement={{ 'data-color-mode': theme }} />
  blocks.push(source.slice(last))
  return <>{blocks.map((block, index) => typeof block === 'string'
    ? block.trim() ? <MDEditor.Markdown key={index} source={block} skipHtml disableCopy components={{ pre: FocusCodeBlock }} remarkPlugins={mathRemarkPlugins} rehypePlugins={mathRehypePlugins} wrapperElement={{ 'data-color-mode': theme }} /> : null
    : block.kind === 'chart' ? <FocusChart key={index} data={block.data} /> : block.kind === 'layout'
      ? <FocusLayout key={index} data={block.data} /> : <FocusSmartUi key={index} data={block.data} />)}</>
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

export default function FocusChatView(props: Props): JSX.Element {
  const { owner, visible, theme, messages, messagesReady } = props
  const ownerKey = focusOwnerKey(owner)
  // Apply the default until a toggle is recorded; preserve manual choices across view switches.
  const remembered = (key: string, defaultOpen = false): { open: boolean; onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => void } => ({
    open: detailStates.get(ownerKey)?.get(key) ?? defaultOpen,
    onToggle: event => {
      const states = detailStates.get(ownerKey) ?? new Map<string, boolean>()
      states.set(key, event.currentTarget.open)
      detailStates.set(ownerKey, states)
    }
  })
  const modelLabel = focusPlatformLabel(owner.platformId)
  const modelIcon = FOCUS_ICONS[owner.platformId]
  const [state, setState] = useState<FocusChatState | null>(null)
  const [draft, setDraft] = useState(() => readDraft(owner))
  const [sending, setSending] = useState(false)
  const [changingMode, setChangingMode] = useState<FocusComposerModeId | null>(null)
  const [settingPending, setSettingPending] = useState<FocusModelSettingKind | null>(null)
  const [settingError, setSettingError] = useState('')
  const settingBusy = useRef(false)
  const modelReadAttempted = useRef(false)
  const modelReadAttempts = useRef(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const readEpoch = useRef(0)
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
      const epoch = readEpoch.current
      try {
        if (settingBusy.current) return
        const next = await window.api.getFocusChat(owner)
        if (disposed || epoch !== readEpoch.current || !next || focusOwnerKey(next) !== ownerKey) return
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
  const hiddenMessageIds = useMemo(() => new Set(state?.hiddenMessageIds ?? []), [state?.hiddenMessageIds])
  const history = messages.filter(message => !represented.ids.has(message.id) &&
    !hiddenMessageIds.has(message.id) &&
    !(message.sourceMessageId && represented.sources.has(message.sourceMessageId)) &&
    (message.role !== 'assistant' || !!cleanFocusAnswer(message.content).trim() || message.attachments.length > 0) &&
    !(message.role === 'assistant' && message.sourceMessageId && recordsById.has(message.sourceMessageId)) &&
    !message.sourceMessageId?.startsWith('read-files:'))
  const entries = [...history.map(message => ({ at: message.createdAt, message, turn: null as FocusTurn | null })),
    ...turns.map(turn => ({ at: turn.createdAt, turn, message: null as ConversationMessage | null }))]
    .sort((a, b) => a.at - b.at)
  const lastTurn = turns.at(-1)
  const sendFailure = state?.sendFailure
  const working = !sendFailure && (props.needsAnswer || state?.waiting === true || state?.generating === 'active' || lastTurn?.status === 'working')
  const linkedExecutions = new Set(turns.flatMap(turn => turn.executionIds))
  const unlinkedAttention = records.filter(record => !linkedExecutions.has(record.messageId) && executionNeedsAction(record, focusDelivery(record)))
  const ready = state?.ready === true
  // Computer use waits for its Windows helper; the composer keeps the draft meanwhile.
  const sendBlock = state?.sendBlock || ''
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
        lastSnapshot.current = JSON.stringify(updated); setState(updated)
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
      if (next && focusOwnerKey(next) === ownerKey) { lastSnapshot.current = JSON.stringify(next); setState(next) }
      if (outcome !== 'ok') setError(outcome === 'busy' ? '当前正在处理任务，请稍后切换回答模式。' :
        '开关状态尚未确认，请到原始视图检查后再发送。')
    } catch { if (alive.current) setError('暂时无法同步开关状态，请到原始视图检查。') }
    finally { sendLock.current = false; if (alive.current) setChangingMode(null) }
  }
  const richAnswers = new Map((state?.smartReplies ?? []).map(reply => [reply.sourceMessageId, reply.answer]))
  const actOnUi = useCallback(async (action: FocusUiAction): Promise<FocusSendOutcome> => {
    if (sendLock.current || working || editingId || !ready || state?.nativeDraft) return 'busy'
    sendLock.current = true; setSending(true); readEpoch.current++
    try {
      const result = await window.api.actOnFocusUi({ ...owner, ...action })
      readEpoch.current++
      const next = await window.api.getFocusChat(owner)
      if (alive.current && next && focusOwnerKey(next) === ownerKey) {
        lastSnapshot.current = JSON.stringify(next); setState(next)
      }
      return result
    } finally { sendLock.current = false; if (alive.current) setSending(false) }
  }, [ownerKey, working, editingId, ready, state?.nativeDraft])
  const smartUiContext = useMemo(() => ({ disabled: working || sending || stopping || !!editingId || !ready || !!state?.nativeDraft,
    liveSources: new Set((state?.smartReplies ?? []).map(reply => reply.sourceMessageId)), act: actOnUi, onOriginal: props.onOriginal }),
  [working, sending, stopping, editingId, ready, state?.nativeDraft, state?.smartReplies, actOnUi, props.onOriginal])
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
    if ((!text.trim() && !sourceFiles.length) || sendLock.current || editingId || working || sendFailure || !ready || state?.nativeDraft || sendBlock) return
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
          cancelled: '发送已取消，文字和附件仍保留。',
          'helper-not-ready': 'Windows 桌面助手尚未就绪，消息未发送，草稿已保留。就绪后再发送即可。'
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
          lastSnapshot.current = JSON.stringify(next)
          setState(next)
        }
      }
      return null
    } finally { sendLock.current = false; if (alive.current) setSending(false) }
  }
  const userContent = (messageId: string | null, text: string, attachments: boolean, children?: ReactNode): JSX.Element =>
    <EditableUser text={text} editable={supportsFocusEdit(owner.platformId) && !!owner.conversationId && !!messageId && !!text.trim() && !attachments}
      open={!!messageId && editingId === messageId} disabled={working || sending || stopping || settingPending !== null || !ready || !!state?.nativeDraft}
      onOpen={() => { if (!sendLock.current && messageId) setEditingId(messageId) }} onClose={() => setEditingId(null)}
      onSend={text => editMessage(messageId!, text)}>{children}</EditableUser>
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
        lastSnapshot.current = JSON.stringify(next)
        setState(next)
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
      <details {...remembered('exec:' + record.messageId)}><summary>查看命令与输出{record.exitCode !== null ? ' · 退出码 ' + record.exitCode : ''}</summary><pre>{record.command}</pre>{record.output ? <pre className="focus-execution__output">{record.output}</pre> : null}
        <div className="focus-execution__meta">{record.startedAt && record.finishedAt ? ((record.finishedAt - record.startedAt) / 1000).toFixed(1) + ' 秒 · ' : ''}{delivery === 'sent' ? '结果已回传' : delivery === 'background' ? '已交由后台任务处理，创建、就绪和结束结果单独回传' : delivery === 'pending' && record.status === 'done' ? '等待结果回传' : delivery === 'blocked' || delivery === 'failed' ? '结果尚未回传' : delivery === 'superseded' ? '结果未回传：已由后续执行接替' : ''}</div>
      </details>
      {actionable && ['pending', 'blocked'].includes(record.status) ? <div className="focus-chat__actions"><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId)}>{actionId === record.messageId ? '处理中…' : '运行'}</button><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId, true)}>跳过</button></div> : null}
      {actionable && (delivery === 'blocked' || delivery === 'failed' || ['failed', 'timeout'].includes(record.status)) ? <button type="button" onClick={props.onOpenTerminal}>打开执行控制</button> : null}
    </div>
  )
  const renderTurn = (turn: FocusTurn): JSX.Element => {
    const sendBlocked = !!sendFailure && turn === lastTurn
    const executions = turn.executionIds.flatMap(id => recordsById.get(id) ? [recordsById.get(id)!] : [])
    const deliveryOf = (record: ExecutionRecord): FocusDelivery | undefined => focusDelivery(record, turn.deliveries[record.messageId])
    const running = executions.some(record => record.status === 'running')
    const pending = executions.some(record => ['pending', 'blocked'].includes(record.status))
    const deliveryPending = turn.status === 'working' && executions.some(record => record.status === 'done' && deliveryOf(record) === 'pending')
    // A new tool/result cycle must not move earlier prose into the process panel.
    const answers = turn.segments.flatMap(segment => {
      // Empty command answers are intentional. Rich content may enrich actual
      // prose, but must never recreate a protocol response as an answer bubble.
      if (!segment.answer.trim() ||
        (segment.sourceMessageId && turn.executionIds.includes(segment.sourceMessageId))) return []
      // Older versions saved raw question JSON; normalize it at display time too.
      const text = cleanFocusAnswer((segment.sourceMessageId ? richAnswers.get(segment.sourceMessageId) : '') || segment.answer)
      return text.trim() ? [{ cycle: segment.cycle, sourceMessageId: segment.sourceMessageId, text }] : []
    })
    const hasProcess = turn.segments.some(segment => segment.parts.length > 0) || executions.length > 0 || !!turn.parseFailures?.length
    const label = sendBlocked ? '消息发送失败 · 等待重试' : turn.commandRecovery ? (turn.status === 'working' ? '正在修正指令…' : '指令未执行 · 等待处理') : pending ? '等待你确认下一步' : running ? '正在执行命令…' : deliveryPending ? '正在回传执行结果…' :
      turn.status === 'stopped' ? '已停止 · 已有内容保留' : turn.status === 'working' ? '正在处理…' : '已回复'
    const userMessage = turn.userMessageId ? messagesById.get(turn.userMessageId) : null
    return <article className="focus-turn" data-message-id={turn.id} key={turn.id}>
      <div className={'focus-user' + (turn.userMessageId && editingId === turn.userMessageId ? ' focus-user--editing' : '')}>
        {userContent(turn.userMessageId, turn.userText, !!userMessage?.attachments.length || !!turn.userAttachments?.length, <>
          {userMessage?.attachments.map(props.renderAttachment)}
          {turn.userAttachments?.map((file, index) => <div className="focus-file-sent" key={index}>📎 {file.fileName}<span>{fileSize(file.sizeBytes)}</span></div>)}
        </>)}</div>
      <div className="focus-assistant">
        <div className="focus-assistant__head">{modelIcon ? <img src={modelIcon} alt="" /> : null}<span>{modelLabel}</span></div>
        <details className="focus-process" {...remembered('process:' + turn.id, true)}><summary><span className={turn.status === 'working' && !sendBlocked ? 'focus-chat__pulse' : 'focus-chat__status'} aria-hidden="true">{sendBlocked ? '!' : turn.status === 'working' ? '' : turn.status === 'blocked' ? '!' : turn.status === 'stopped' ? '○' : '✓'}</span>{label}{hasProcess ? <ProcessHint /> : null}</summary>
          <ProcessScroll follow={turn.status === 'working' && !sendBlocked}>
          {turn.segments.map(segment => {
            const segmentExecutions = executions.filter(record => turn.executionCycles?.[record.messageId] === segment.cycle)
            // Empty cycles have margins and padding too; they must not push the placeholder down.
            if (!segment.parts.length && !segmentExecutions.length) return null
            return <div className="focus-process__cycle" key={segment.cycle}>
              {segment.parts.map((part, index) => part.kind === 'reasoning' ? <details className="focus-reasoning" key={index} {...remembered('reasoning:' + turn.id + ':' + segment.cycle + ':' + index)}><summary>思考过程</summary><Markdown text={part.text} theme={theme} /></details> :
                <div className="focus-search" key={index}><span>检索资料</span>{part.url ? <a href={part.url} target="_blank" rel="noreferrer">{part.text}</a> : part.text}</div>)}
              {segmentExecutions.map(record => renderExecution(record, deliveryOf(record), true))}
            </div>
          })}
          {executions.filter(record => !turn.segments.some(segment => segment.cycle === turn.executionCycles?.[record.messageId])).map(record => renderExecution(record, deliveryOf(record), true))}
          {turn.parseFailures?.map(failure => <details className="focus-execution" key={'parse:' + failure.messageId}>
            <summary>指令格式错误 · 未执行</summary><pre>{failure.text}</pre>
          </details>)}
          {!hasProcess ? <p className="focus-chat__muted focus-process__empty">{sendBlocked ? '消息尚未发送成功。' : turn.status === 'working' ? '正在思考…' : '本轮没有额外执行步骤。'}</p> : null}
          </ProcessScroll>
        </details>
        {turn.notice === 'parse-failed' ? <div className="focus-chat__error" role="alert">
          {turn.commandRecovery?.message || '指令格式无效，本条请求未执行。'}
          {turn.commandRecovery && ['blocked', 'failed'].includes(turn.commandRecovery.status) && turn === state?.turns.at(-1)
            ? <button type="button" disabled={!!actionId} onClick={() => void retryFormat(turn.commandRecovery!.token)}>重试修正</button> : null}
          <button type="button" onClick={props.onOpenTerminal}>查看执行控制</button>
        </div> : null}
        {answers.map(answer => <div className="focus-answer" key={answer.cycle} data-question-answer={answer.sourceMessageId ?? ''}><Markdown text={answer.text} theme={theme} /></div>)}
        {answers.length > 0 && turn.status !== 'working' ? <div className="focus-chat__actions"><button type="button" onClick={() => void copy(turn.id, answers.map(answer => answer.text).join('\n\n'))}>{copiedId === turn.id ? '已复制' : '复制回答'}</button></div> : null}
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
          <article className={'focus-history focus-history--' + entry.message!.role + (editingId === entry.message!.id ? ' focus-user--editing' : '')} data-message-id={entry.message!.id} key={entry.message!.id}>
            {entry.message!.role === 'assistant' ? <div className="focus-assistant__head">{modelIcon ? <img src={modelIcon} alt="" /> : null}{modelLabel}</div> : null}
            {entry.message!.role === 'assistant' ? <>{entry.message!.attachments.map(props.renderAttachment)}<div data-question-answer={entry.message!.sourceMessageId ?? ''}><Markdown text={richAnswers.get(entry.message!.sourceMessageId ?? '') || entry.message!.content} theme={theme} /></div></>
              : userContent(entry.message!.id, cleanFocusUserText(entry.message!.content), entry.message!.attachments.length > 0, entry.message!.attachments.map(props.renderAttachment))}
          </article>)}
        {unlinkedAttention.length > 0 ? <details className="focus-process" {...remembered('unlinked-process', true)}>
          <summary>其他执行记录 · {unlinkedAttention.length}<ProcessHint /></summary>
          <ProcessScroll follow={working}>
            {unlinkedAttention.map(record => renderExecution(record, focusDelivery(record), true))}
          </ProcessScroll>
        </details> : null}
      </ConversationTranscript>,
  [state, messages, messagesReady, theme, ownerKey, actionId, copiedId, working, sending, stopping, editingId, settingPending, props.renderAttachment, props.onOpenTerminal, props.onRun, props.onSkip])
  return <FocusSmartUiContext.Provider value={smartUiContext}><section className="focus-chat" aria-label="专注对话" data-theme={theme}>
    <header className="focus-chat__header">
      <span>{modelIcon ? <img className="focus-chat__brand-icon" src={modelIcon} alt={modelLabel} /> : <strong>{modelLabel}</strong>}</span>
      <button type="button" className="focus-chat__new-chat" aria-label="新建对话" title="新建对话"
        disabled={props.newChatDisabled || working || sending || stopping || !!editingId || settingPending !== null} onClick={startNewChat}>
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
        disabled={working || sending || stopping || !!editingId || !ready} pending={settingPending}
        waiting={ready && !state?.modelSettings?.model && !modelReadAttempted.current && settingPending === null}
        onChange={(kind, value) => { void updateModelSettings(kind, value) }} onRefresh={() => { void updateModelSettings('read') }} /> : null}
    </header>
    <div className="focus-chat__transcript" ref={transcriptRef}>
      {transcript}
      <SelectionAsk owner={owner} root={transcriptRef} />
    </div>
    <div className="focus-chat__bottom">
      {props.needsAnswer ? <div className="focus-chat__notice" role="status">{modelLabel} 需要你的回答，任务正在等待。<button type="button" onClick={props.onQuestion}>回答问题</button></div> : null}
      {ready && sendBlock ? <div className="focus-chat__notice" role="status"><span className="focus-chat__pulse" aria-hidden="true" />{sendBlock} 可以先输入，草稿会保留。</div> : null}
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
      <form className="focus-composer" onSubmit={event => void submit(event)}>
        {draftFiles.length ? <div className="focus-composer__files" aria-label="待发送附件">{draftFiles.map(item =>
          <div className="focus-draft-file" key={item.id}>
            <FilePreview file={item.file} onPreview={props.onPreviewImage} />
            <span className="focus-draft-file__name" title={item.file.name}>{item.file.name}<small>{fileSize(item.file.size)} · {sending ? '上传并发送中…' : '待发送'}</small></span>
            <button type="button" disabled={sending} aria-label={'移除附件 ' + item.file.name} onClick={() => removeFile(item.id)}>×</button>
          </div>)}</div> : null}
        <textarea value={draft} disabled={!!editingId} maxLength={20000} rows={2} aria-label="消息" placeholder="描述你想完成的任务…" onChange={event => setDraftText(event.target.value)}
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
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); if (!working && !sending && ready && !sendBlock) event.currentTarget.form?.requestSubmit() } }} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = '' }} />
        <div className="focus-composer__tools"><div className="focus-composer__left">
          <button type="button" className="focus-composer__attachment" disabled={sending || !!editingId || changingMode !== null || settingPending !== null} onClick={() => fileInput.current?.click()} title="添加附件，也可直接粘贴截图或文件">＋ 附件</button>
          {owner.platformId === 'deepseek' ? <FocusComposerModes modes={state?.composerModes ?? []} disabled={sending || stopping || !!working || !!sendFailure || !!editingId || !ready}
            pending={changingMode} onChange={(id, active) => { void changeMode(id, active) }} /> : null}
        </div><span>{modelLabel}</span>
          {working || sendFailure || stopping || (sending && draftFiles.length > 0) ? <button type="button" className="focus-composer__send" disabled={stopping} onClick={() => void stop()} aria-label="结束当前任务">{stopping ? <ComposerPendingIcon /> : <svg className="focus-composer__stop-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="3" width="10" height="10" rx="0.5" fill="currentColor" /></svg>}</button> :
            <button type="submit" className="focus-composer__send" disabled={sending || changingMode !== null || settingPending !== null || !!editingId || !ready || !!state?.nativeDraft || !!sendBlock || (!draft.trim() && !draftFiles.length)} aria-label="发送消息" title={sendBlock || undefined}>{sending ? <ComposerPendingIcon /> : '↑'}</button>}
        </div>
      </form><p className="focus-composer__hint">Enter 发送 · Shift+Enter 换行</p>
    </div>
  </section></FocusSmartUiContext.Provider>
}
