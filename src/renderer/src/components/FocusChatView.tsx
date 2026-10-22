import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, JSX, ReactNode } from 'react'
import MDEditor from '@uiw/react-md-editor'
import ConversationTranscript from './ConversationTranscript'
import deepseekIcon from '../assets/DeepSeek.svg'
import type { AppTheme, ConversationAttachment, ConversationMessage, ExecutionRecord } from '@shared/types'
import type { FocusChatState, FocusOwner, FocusTurn, FocusDelivery } from '@shared/focus-chat'
import { cleanFocusAnswer, cleanFocusUserText, focusOwnerKey, focusDelivery } from '@shared/focus-chat'
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
  onQuestion(): void
  onOriginal(): void
  onControl(): void
  onRun(messageId: string): Promise<void>
  onSkip(messageId: string): Promise<void>
  onStop(): Promise<void>
  renderAttachment(attachment: ConversationAttachment): ReactNode
}
/** The expanded process scrolls on its own; a working turn keeps its newest step in view unless the user scrolled up. */
function ProcessScroll(props: { follow: boolean; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const element = ref.current
    if (props.follow && pinned.current && element) element.scrollTop = element.scrollHeight
  })
  return <div className="focus-process__body" ref={ref} onScroll={event => {
    const element = event.currentTarget
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }}>{props.children}</div>
}
const labels: Record<string, string> = {
  pending: '等待确认', blocked: '等待确认', running: '正在执行', done: '执行完成',
  failed: '执行失败', timeout: '执行超时', interrupted: '已中断', skipped: '已跳过'
}
interface DraftFile { id: string; file: File }
// Keep unsent files across view switches in memory, never in localStorage.
const fileDrafts = new Map<string, DraftFile[]>()
const fileDraftListeners = new Map<string, Set<() => void>>()
function saveFileDraft(ownerKey: string, files: DraftFile[]): void {
  if (files.length) fileDrafts.set(ownerKey, files)
  else fileDrafts.delete(ownerKey)
  fileDraftListeners.get(ownerKey)?.forEach(listener => listener())
}
function FilePreview({ file }: { file: File }): JSX.Element {
  const [source, setSource] = useState('')
  const image = /^(image\/(png|jpeg|webp|gif|bmp|avif))$/.test(file.type)
  useEffect(() => {
    if (!image) return
    const url = URL.createObjectURL(file)
    setSource(url)
    return () => URL.revokeObjectURL(url)
  }, [file, image])
  return image && source ? <img src={source} alt={file.name} /> : <span className="focus-draft-file__icon" aria-hidden="true">📎</span>
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
function Markdown({ text, theme }: { text: string; theme: AppTheme }): JSX.Element {
  return <MDEditor.Markdown source={cleanFocusAnswer(text)} skipHtml wrapperElement={{ 'data-color-mode': theme }} />
}

export default function FocusChatView(props: Props): JSX.Element {
  const { owner, visible, theme, messages, messagesReady } = props
  const ownerKey = focusOwnerKey(owner)
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
  const alive = useRef(true)
  const composing = useRef(false)
  const draftRef = useRef(draft)
  const lastSnapshot = useRef('')
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
          'unsupported-file-type': 'DeepSeek 当前输入区不接受该附件类型，附件已保留。',
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
  const copy = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(cleanFocusAnswer(text)) }
    catch { setError('复制失败，可以选择正文手动复制。') }
  }
  const renderExecution = (record: ExecutionRecord, delivery?: FocusDelivery, actionable = false): JSX.Element => (
    <div className={'focus-execution' + (executionNeedsAction(record, delivery) ? ' focus-execution--attention' : '')} key={record.messageId}>
      <div className="focus-execution__head"><strong>{record.description || (record.kind === 'read_files' ? '读取文件' : '执行命令')}</strong><span>{labels[record.status] || record.status}</span></div>
      {actionable && ['pending', 'blocked'].includes(record.status) ? <pre>{record.command}</pre> : null}
      <details><summary>查看命令与输出{record.exitCode !== null ? ' · 退出码 ' + record.exitCode : ''}</summary><pre>{record.command}</pre>{record.output ? <pre className="focus-execution__output">{record.output}</pre> : null}
        <div className="focus-execution__meta">{record.startedAt && record.finishedAt ? ((record.finishedAt - record.startedAt) / 1000).toFixed(1) + ' 秒 · ' : ''}{delivery === 'sent' ? '结果已回传' : delivery === 'pending' && record.status === 'done' ? '等待结果回传' : delivery === 'blocked' || delivery === 'failed' ? '结果尚未回传' : ''}</div>
      </details>
      {actionable && ['pending', 'blocked'].includes(record.status) ? <div className="focus-chat__actions"><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId)}>{actionId === record.messageId ? '处理中…' : '运行'}</button><button type="button" disabled={!!actionId} onClick={() => void action(record.messageId, true)}>跳过</button></div> : null}
      {actionable && (delivery === 'blocked' || delivery === 'failed' || ['failed', 'timeout'].includes(record.status)) ? <button type="button" onClick={props.onControl}>打开执行控制</button> : null}
    </div>
  )
  const renderTurn = (turn: FocusTurn): JSX.Element => {
    const executions = turn.executionIds.flatMap(id => recordsById.get(id) ? [recordsById.get(id)!] : [])
    const deliveryOf = (record: ExecutionRecord): FocusDelivery | undefined => focusDelivery(record, turn.deliveries[record.messageId])
    const attention = executions.filter(record => executionNeedsAction(record, deliveryOf(record)))
    const running = executions.some(record => record.status === 'running')
    const pending = executions.some(record => ['pending', 'blocked'].includes(record.status))
    const deliveryPending = executions.some(record => record.status === 'done' && deliveryOf(record) === 'pending')
    const answer = turn.segments.at(-1)?.answer || ''
    const hasProcess = turn.segments.some(segment => segment.parts.length > 0) || executions.length > 0
    const label = pending ? '等待你确认下一步' : running ? '正在执行命令…' : deliveryPending ? '正在回传执行结果…' :
      turn.status === 'stopped' ? '已停止 · 已有内容保留' : turn.status === 'working' ? '正在处理…' : '已回复'
    const userMessage = turn.userMessageId ? messagesById.get(turn.userMessageId) : null
    return <article className="focus-turn" data-message-id={turn.id} key={turn.id}>
      <div className="focus-user">{turn.userText ? <p>{turn.userText}</p> : null}{userMessage?.attachments.map(props.renderAttachment)}
        {turn.userAttachments?.map((file, index) => <div className="focus-file-sent" key={index}>📎 {file.fileName}<span>{fileSize(file.sizeBytes)}</span></div>)}</div>
      <div className="focus-assistant">
        <div className="focus-assistant__head"><img src={deepseekIcon} alt="" /><span>DeepSeek</span></div>
        <details className="focus-process"><summary><span className={turn.status === 'working' ? 'focus-chat__pulse' : 'focus-chat__status'} aria-hidden="true">{turn.status === 'working' ? '' : turn.status === 'stopped' ? '○' : '✓'}</span>{label}{hasProcess ? <span className="focus-process__hint">查看过程</span> : null}</summary>
          <ProcessScroll follow={turn.status === 'working'}>
          {turn.segments.map(segment => <div className="focus-process__cycle" key={segment.cycle}>
            {segment.parts.map((part, index) => part.kind === 'reasoning' ? <details className="focus-reasoning" key={index}><summary>思考过程</summary><Markdown text={part.text} theme={theme} /></details> :
              <div className="focus-search" key={index}><span>检索资料</span>{part.url ? <a href={part.url} target="_blank" rel="noreferrer">{part.text}</a> : part.text}</div>)}
            {segment !== turn.segments.at(-1) && segment.answer ? <div className="focus-process__commentary"><Markdown text={segment.answer} theme={theme} /></div> : null}
            {executions.filter(record => turn.executionCycles?.[record.messageId] === segment.cycle && !attention.includes(record)).map(record => renderExecution(record, deliveryOf(record)))}
          </div>)}
          {executions.filter(record => turn.executionCycles?.[record.messageId] === undefined && !attention.includes(record)).map(record => renderExecution(record, deliveryOf(record)))}
          {!hasProcess ? <p className="focus-chat__muted">{turn.status === 'working' ? '正在等待页面更新。' : '本轮没有额外执行步骤。'}</p> : null}
          </ProcessScroll>
        </details>
        {attention.map(record => renderExecution(record, deliveryOf(record), true))}
        {turn.notice === 'parse-failed' ? <div className="focus-chat__error" role="alert">模型返回的指令暂时无法识别，任务仍在等待。<button type="button" onClick={props.onControl}>查看执行控制</button></div> : null}
        {answer ? <div className="focus-answer"><Markdown text={answer} theme={theme} /></div> : null}
        {answer && turn.status !== 'working' ? <div className="focus-chat__actions"><button type="button" onClick={() => void copy(answer)}>复制回答</button></div> : null}
      </div>
    </article>
  }
  return <section className="focus-chat" aria-label="专注对话" data-theme={theme}>
    <header className="focus-chat__header"><span><img className="focus-chat__brand-icon" src={deepseekIcon} alt="DeepSeek" /></span></header>
    <div className="focus-chat__transcript">
      <ConversationTranscript scrollKey={'focus:' + ownerKey} ready={messagesReady && state !== null}>
        {entries.length === 0 ? <div className="focus-chat__empty"><img src={deepseekIcon} alt="" /><h2>从一个目标开始</h2><p>描述你想完成的任务，处理过程会归入同一轮对话。</p></div> : entries.map(entry => entry.turn ? renderTurn(entry.turn) :
          <article className={'focus-history focus-history--' + entry.message!.role} data-message-id={entry.message!.id} key={entry.message!.id}>
            {entry.message!.role === 'assistant' ? <div className="focus-assistant__head"><img src={deepseekIcon} alt="" />DeepSeek</div> : null}
            {entry.message!.attachments.map(props.renderAttachment)}
            {entry.message!.role === 'assistant' ? <Markdown text={entry.message!.content} theme={theme} /> : <p>{cleanFocusUserText(entry.message!.content)}</p>}
          </article>)}
        {unlinkedAttention.map(record => renderExecution(record, focusDelivery(record), true))}
      </ConversationTranscript>
    </div>
    <div className="focus-chat__bottom">
      {props.needsAnswer ? <div className="focus-chat__notice" role="status">DeepSeek 需要你的回答，任务正在等待。<button type="button" onClick={props.onQuestion}>回答问题</button></div> : null}
      {!ready ? <div className="focus-chat__notice">网页尚未就绪。<button type="button" onClick={props.onOriginal}>切回原始视图完成登录或检查页面</button></div> : null}
      {state?.nativeDraft && !sending ? <div className="focus-chat__notice">原网页输入框中保留着内容，专注视图不会覆盖。<button type="button" onClick={props.onOriginal}>查看原始视图</button></div> : null}
      {error ? <div className="focus-chat__error" role="alert">{error}<button type="button" onClick={props.onOriginal}>查看原始视图</button></div> : null}
      <form className="focus-composer" onSubmit={event => void submit(event)}>
        {draftFiles.length ? <div className="focus-composer__files" aria-label="待发送附件">{draftFiles.map(item =>
          <div className="focus-draft-file" key={item.id}>
            <FilePreview file={item.file} />
            <span className="focus-draft-file__name" title={item.file.name}>{item.file.name}<small>{fileSize(item.file.size)} · {sending ? '上传并发送中…' : '待发送'}</small></span>
            <button type="button" disabled={sending} aria-label={'移除附件 ' + item.file.name} onClick={() => removeFile(item.id)}>×</button>
          </div>)}</div> : null}
        <textarea value={draft} maxLength={20000} rows={2} aria-label="消息" placeholder="描述你想完成的任务…" onChange={event => setDraftText(event.target.value)}
          onPaste={event => {
            const files = [...event.clipboardData.files]
            const pastedFiles = files.length ? files : [...event.clipboardData.items].filter(item => item.kind === 'file').flatMap(item => { const file = item.getAsFile(); return file ? [file] : [] })
            if (!pastedFiles.length) return
            event.preventDefault()
            if (sendLock.current) { setError('当前正在发送，请等待完成后再粘贴附件。'); return }
            addFiles(pastedFiles)
            const text = event.clipboardData.getData('text/plain')
            if (text) {
              const input = event.currentTarget
              setDraftText((draftRef.current.slice(0, input.selectionStart) + text + draftRef.current.slice(input.selectionEnd)).slice(0, 20000))
            }
          }}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); if (!working && !sending && ready) event.currentTarget.form?.requestSubmit() } }} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = '' }} />
        <div className="focus-composer__tools"><button type="button" disabled={sending} onClick={() => fileInput.current?.click()} title="添加附件，也可直接粘贴截图或文件">＋ 附件</button><span>DeepSeek</span>
          {working || stopping || (sending && draftFiles.length > 0) ? <button type="button" className="focus-composer__send" disabled={stopping} onClick={() => void stop()} aria-label="结束当前任务">{stopping ? '…' : <svg className="focus-composer__stop-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="3" width="10" height="10" rx="0.5" fill="currentColor" /></svg>}</button> :
            <button type="submit" className="focus-composer__send" disabled={sending || !ready || !!state?.nativeDraft || (!draft.trim() && !draftFiles.length)} aria-label="发送消息">{sending ? '…' : '↑'}</button>}
        </div>
      </form><p className="focus-composer__hint">Enter 发送 · Shift+Enter 换行</p>
    </div>
  </section>
}
