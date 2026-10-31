/*
 * Injected into the chatgpt.com page's MAIN WORLD by src/main/embed.ts.
 *
 * It is plain browser JavaScript on purpose: it does not run in the app's
 * process, has no access to `window.api`, and must not be type-checked against
 * the Node/Electron libs. It is bundled as a string via Vite's `?raw` import.
 *
 * Two jobs:
 *
 *  1. OUTBOUND — intercept user sends, prepend the system prompt once per task,
 *     and keep later sends on the same confirmed user-message path.
 *
 *  2. INBOUND — watch the thread for the assistant's reply, pull the JSON
 *     command out of it, and report it to the main process so it can be run.
 *     It also exposes `sendRaw()`, which the main process uses to feed command
 *     output back into the conversation WITHOUT the system prompt.
 *
 * Why the composer needs such careful handling: ChatGPT's input is a
 * ProseMirror contenteditable div — it carried `#prompt-textarea` until the markup
 * changed, and what replaced that id is recorded in `src/shared/platforms.ts`. Writing to
 * `innerHTML` does NOT work — ProseMirror owns the document state and will
 * overwrite it, and the send button stays disabled. `document.execCommand(
 * 'insertText')` goes through the browser's editing pipeline, so ProseMirror
 * sees a normal user edit and updates its state.
 */
;(() => {
  const STATE_KEY = '__cmdTerminalInterceptor'
  const LOG_TAG = '[cmd-terminal] '

  /*
   * Which site this copy is running against.
   *
   * These are ChatGPT's values, and they are the DEFAULT rather than a constant because
   * the same script now drives more than one site: the main process pushes the site's
   * descriptor through `configure({ page })` right after injection. Everything
   * site-specific is reachable from here — nothing below this block may contain a
   * ChatGPT selector.
   */
  let PAGE = {
    composerKind: 'contenteditable',
    composerSelectors: [
      'div[contenteditable="true"][data-composer-markdown]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea#pending-home-input',
      '#prompt-textarea',
      'div[contenteditable="true"]'
    ],
    sendButtonSelectors: [
      '[data-composer-footer-responsive] button[aria-label="发送"]',
      'button[aria-label="发送"]',
      '[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="发送消息"]'
    ],
    stopButtonSelectors: [
      '[data-composer-footer-responsive] button[aria-label="停止"]',
      'button[aria-label="停止"]',
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="停止生成"]'
    ],
    assistantSelectors: ['[data-chatgpt-selection-message-id]'],
    ignoreHiddenReplyNodes: true,
    assistantRoleSelectors: [],
    replyStreamingAttribute: '',
    assistantReplySelectors: ['[data-markdown-text-style="assistant-message"]'],
    messageSelectors: ['[data-content-search-unit-key]', '[data-chatgpt-selection-message-id]'],
    messageIdAttr: 'data-chatgpt-selection-message-id',
    fileDraftIgnoreSelector: 'button[aria-label="选择 ChatGPT 模型"]',
    disabledControlSelectors: [],
    fileTurnPositionAttr: '',
    fileTurnPositionSelector: '',
    fileAssistantSelectors: [],
    fileUserTurnSelector: '[class~="group/user-message"][data-chatgpt-search-unit-key]',
    fileUserTurnFallbackSelector: '[data-content-search-unit-key$=":user"]',
    fileUserTurnKeyAttr: 'data-chatgpt-search-unit-key',
    fileUserTurnIdAttr: 'data-turn-key',
    fileImagesMayUseNames: false,
    fileDuplicateNameSuffix: true,
    fileAttachmentCardSelector: ''
  }

  /**
   * How long the reply text must stop changing before we treat it as final.
   * The reply streams token by token; parsing mid-stream would read half a JSON
   * object, and a half-parsed command could be a DIFFERENT, still-valid command
   * (e.g. `{"command":"dir"}` before the real payload arrives).
   */
  const REPLY_SETTLE_MS = 800

  /*
   * How a send is bounded: in TIME, never in retries.
   *
   * It used to be a retry count (`MAX_SEND_ATTEMPTS = 20`), which was a duration only by
   * accident — 20 × the old 150ms confirmation delay ≈ 3s. Once the confirmation became a
   * poll that can legitimately last seconds, the same count ranged from three seconds to a
   * minute depending on whether the page was answering, and "20 attempts" stopped meaning
   * anything a reader could predict. The budget is now stated as the thing it always meant.
   *
   * Two budgets, and the difference matters — see the block in `submitWithRetry` that reads
   * them. `grace` is "stop waiting for the measured button"; `budget`/`timeout` is "stop
   * trying at all".
   */
  /**
   * How long to keep waiting for the SELECTOR-matched send button to render.
   *
   * ChatGPT rebuilds the composer footer after text is written, so the button can honestly be
   * absent for a moment and this window exists for that. It must stay short: when the selector
   * is simply wrong, every millisecond spent here is the user watching their text sit in the
   * box, and the structural fallback would have worked immediately.
   */
  const SEND_BUTTON_GRACE_MS = 700
  /** Total budget for a user-initiated send (~700ms grace + two 3s confirmations). */
  const SEND_ATTEMPT_BUDGET_MS = 8_000
  /**
   * Hard ceiling so a caller awaiting sendRaw() can never hang forever.
   *
   * Comfortably above the worst case the branches can produce (grace + both recovery
   * confirmations ≈ 6.7s) — a ceiling that cuts a recovery action off mid-confirmation
   * reports 'stuck' for a send that actually went out, which is the failure this whole area
   * was rewritten for.
   */
  const SEND_TIMEOUT_MS = 10_000

  /*
   * How the "did the submit actually happen?" question is answered.
   *
   * The ONLY trustworthy signal is the composer clearing, and it is not instantaneous: ChatGPT
   * clears it through its own React/ProseMirror update, which lands some time after the event
   * we dispatched. This used to be a single sample 150ms after the action, and that is simply
   * too short — it produced the worst possible report. Observed: the message went out, the
   * model answered 【任务完成】, the composer was empty on screen, and the terminal still said
   * "结果已写入输入框但没能提交", telling the user to send by hand something that had already
   * been sent.
   *
   * So it polls. A send that worked is detected as soon as it clears — typically a few hundred
   * milliseconds — and only a send that really was ignored burns the whole window. That also
   * makes the retry loop SAFER, not just more accurate: re-dispatching after 150ms while the
   * page was still processing the previous action is how one send becomes several.
   */
  const SEND_CONFIRM_TIMEOUT_MS = 3000
  const SEND_CONFIRM_POLL_MS = 120

  // Re-injection (e.g. after a reload) must not stack duplicate listeners.
  if (window[STATE_KEY]) return

  const state = {
    enabled: false,
    promptInjectionEnabled: true,
    prefix: '',
    replyProtocolPrefix: '',
    replyProtocolVersion: 0,
    prefixIncludesReplyProtocol: false,
    replyProtocolFullLength: 0,
    injectedCount: 0,
    /** True while WE are driving the composer; suppresses prefixing/interception. */
    programmatic: false,
    lastCommandMessageId: null,
    // A settled command is waiting for its result even while awaitingReplySince
    // stays armed for the live command loop. Clear this on every confirmed send.
    replyActionDetected: false,
    /**
     * Timestamp of the last message we sent, cleared once its reply is handled.
     *
     * This is the whole safety model: while it is set, the next assistant message
     * is a reply to us; when it is clear, whatever is on screen is history.
     */
    awaitingReplySince: 0,
    /** Remains true across clarification turns until explicit completion or manual end. */
    taskActive: false,
    /** Only a confirmed user send carrying the prompt consumes this task's injection. */
    taskPromptInjected: false,
    toolPromptRevision: null,
    /** Reject late sends/configuration from a task that has already ended. */
    taskPromptGeneration: 0,
    /** A live question pauses the command loop until an explicit user answer. */
    pendingQuestion: null,
    /** Only this draft may be replaced when retrying a failed dialog submission. */
    answerDraft: null,
    /** Dedupe for the "looked like a command but would not parse" report. */
    lastUnparsedMessageId: null,
    failedCommand: null,
    commandRecoveryUsed: false,
    computerUseEnabled: false,
    /** Main's reason to hold the user's own sends (computer use waiting for its Windows helper). */
    sendBlock: null
  }

  let computerSourceSubmissionId = null
  let mailSourceSubmissionId = null
  // A native edit-and-resend of the last user message that is waiting for generation to start.
  let nativeEditRetry = null
  // Leaked moderation verdicts answered by an automatic unchanged resend; reset by a genuine send.
  let safetyLeak = { count: 0, busy: false, failedKey: null }
  let computerReplyWait = null
  let computerReplySerial = 0
  let pendingComputerRecognition = null
  let computerProtocolContext = { definitions: [], stepToken: null }
  let computerPageEpoch = null

  let taskPromptConfigured = false
  const resetTaskPrompt = (generation = state.taskPromptGeneration + 1) => {
    computerReplyWait = null
    computerSourceSubmissionId = null
    mailSourceSubmissionId = null
    pendingComputerRecognition = null
    state.taskPromptGeneration = generation
    state.taskPromptInjected = false
    state.failedCommand = null
    state.commandRecoveryUsed = false
  }

  /** User-image batches stay page-side until main explicitly asks for their bytes. */
  const pendingUserImageCaptures = new Map()
  let userImageCaptureSerial = 0
  // ChatGPT clears its file input as soon as the upload is accepted. Keep a short-lived
  // copy of the bytes from the selection/paste/drop event so the later send event does
  // not depend on that input or on a thumbnail still being present in the DOM.
  let lastDraftImageCapturedAt = 0
  let lastDraftImagePromise = Promise.resolve([])
  const replyDiagnosticEvents = new Set([
    'installed', 'configured', 'sent', 'sent-raw', 'scan', 'reply-state', 'question',
    'question-cleared', 'command', 'read-files', 'computer-request', 'parse-failed', 'task-finished', 'end-task', 'reply-watchdog',
    'continue-generation', 'command-recovery', 'native-edit'
  ])
  const replyScanEvents = new Set(['scan', 'question', 'command', 'read-files', 'computer-request', 'parse-failed', 'task-finished'])
  let replyScanSnapshot = {}
  let focusReplyBaseline = null
  let focusBaselinePosition = null
  let focusReplyPosition = null
  let focusEditing = null
  let focusModeChanging = null
  let focusModelCache = null
  // Editing can remove the latest reply and temporarily expose an older one. It must
  // never be mistaken for the new reply or re-executed as a fresh command.
  const focusEditExcludedIds = new Set()
  // The focus view's list position (`PAGE.focus.rowPositionAttr`); null on a platform without focus rules.
  const focusRowPosition = (node) => {
    const attribute = PAGE.focus?.rowPositionAttr
    return node && attribute ? node.getAttribute(attribute) || null : null
  }
  /*
   * What pins the reply to the current send: the list position where the rules name one,
   * otherwise the site's stable message id. Never a content hash — that changes while the
   * reply streams, and the anchor would lose its own row.
   */
  const focusReplyAnchor = (node) => {
    if (!node || !PAGE.focus) return null
    if (PAGE.focus.rowPositionAttr) return focusRowPosition(node)
    return PAGE.messageIdAttr ? node.getAttribute(PAGE.messageIdAttr) || null : null
  }
  const userSubmissionScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  let userSubmissionSerial = 0
  // Isolates desktop-result retries without changing the existing task prompt/protocol.
  let computerResultToken = null
  // Object identity keeps cancelled dialog sends separate from any later user send.
  let scopedUserSend = null
  const report = (payload) => {
    try {
      if (payload.event === 'user-message') computerResultToken = null
      // Confirmed human sends and main-owned scheduled goals emit user-message. Tool results do not.
      const submission = payload.event === 'user-message' ? {
        submissionId: `user:${userSubmissionScope}:${++userSubmissionSerial}`, submissionKind: 'goal',
        taskPromptGeneration: state.taskPromptGeneration
      } : {}
      const includeScan = replyScanEvents.has(payload.event) ||
        (payload.event === 'reply-state' && ['non-command-reply', 'question-detected'].includes(payload.reason))
      const diagnostic = replyDiagnosticEvents.has(payload.event) ? {
        ...(includeScan ? replyScanSnapshot : {}),
        enabled: state.enabled,
        awaitingReply: state.awaitingReplySince !== 0,
        taskActive: state.taskActive,
        taskPromptGeneration: state.taskPromptGeneration,
        pendingQuestionFound: state.pendingQuestion !== null,
        lastHandledMessageId: state.lastCommandMessageId
      } : {}
      const event = { ...diagnostic, ...submission, ...payload }
      if (event.event === 'user-message') {
        mailSourceSubmissionId = event.submissionId
        if (event.submissionKind === 'goal') computerSourceSubmissionId = event.submissionId
        if (computerReplyWait) computerReplyWait.sourceSubmissionId = computerSourceSubmissionId
      }
      console.log(LOG_TAG + JSON.stringify(event))
    } catch (_) {
      /* never break the page because reporting failed */
    }
  }

  const collapse = (value) => (value || '').replace(/\s+/g, ' ').trim()

  // A textarea converts CRLF and bare CR to LF when its value is assigned. Git and
  // other terminal tools can put bare CR inside output, so compare and submit the
  // same text the browser actually keeps instead of reporting a false insert failure.
  const normalizeLineEndings = (value) => String(value).replace(/\r\n?/g, '\n')

  /** First element matching any of a selector list. Lists, so a rename degrades. */
  const queryFirst = (selectors) => {
    for (const selector of selectors) {
      const found = document.querySelector(selector)
      if (found) return found
    }
    return null
  }

  const isVisibleElement = (element) => {
    if (!element || !element.isConnected || element.getClientRects().length === 0) return false
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const visibility = getComputedStyle(element).visibility
    return visibility !== 'hidden' && visibility !== 'collapse'
  }

  const queryFirstVisible = (selectors, root = document) => {
    for (const selector of selectors) {
      const found = [...root.querySelectorAll(selector)].find(isVisibleElement)
      if (found) return found
    }
    return null
  }

  const getComposer = (target = null) => {
    // The bootstrap textarea and full editor can coexist during hydration.
    // Resolve the actual event/focus owner before falling back to document order.
    for (const node of [target, document.activeElement]) {
      if (!node || typeof node.closest !== 'function') continue
      for (const selector of PAGE.composerSelectors) {
        const found = node.closest(selector)
        if (isVisibleElement(found) && !found.closest(PAGE.focus?.edit?.turnSelector || ':not(*)') &&
          !found.closest(PAGE.nativeEdit?.rowSelector || ':not(*)')) return found
      }
    }
    // A message's inline edit box is never the composer: composing into it would send the prompt as the edit.
    for (const selector of PAGE.composerSelectors) {
      const found = [...document.querySelectorAll(selector)].find(node => isVisibleElement(node) &&
        !node.closest(PAGE.focus?.edit?.turnSelector || ':not(*)') && !node.closest(PAGE.nativeEdit?.rowSelector || ':not(*)'))
      if (found) return found
    }
    return null
  }

  /**
   * Read the composer.
   *
   * TWO mechanisms, and using the wrong one reads an empty string forever:
   *
   *   - contenteditable (ChatGPT/ProseMirror): the text lives in the DOM, so `innerText`
   *     is the only view of it — `.value` is `undefined` on a div.
   *   - textarea (DeepSeek): a real form control, where `innerText` is always empty and
   *     `.value` holds the text.
   *
   * Detected from the ELEMENT rather than trusted from the descriptor alone: a site that
   * swaps its composer would otherwise leave this reading nothing, silently.
   */
  const readComposer = (element) => {
    if (!element) return ''
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      return String(element.value || '')
    }
    return String(element.innerText || '')
  }

  /**
   * Contenteditable editors are allowed to normalize whitespace and line breaks while
   * accepting an insertText command. Compare the visible text in its normalized form so
   * a successful write is not mistaken for a failed injection.
   */
  const composerMatches = (element, expected) => {
    const actual = readComposer(element)
    return actual === expected || collapse(actual) === collapse(expected)
  }

  /**
   * The assistant's ANSWER text, from a turn element.
   *
   * On ChatGPT the turn's text is the answer, and this returns it unchanged. On a site
   * whose turn also carries reasoning and search citations, the answer is a narrower
   * descendant — and reading the whole turn would hand the JSON extractor the model's
   * private reasoning. That is not a cosmetic difference: reasoning routinely contains
   * braces and quoted JSON of its own, so it can parse as a command the model never issued.
   *
   * Falls back to the turn's own text when the marker is absent, which is the correct
   * behaviour on a site that has none.
   */
  const replyRootOf = (node) => {
    if (!node) return null
    const markers = PAGE.assistantReplySelectors
    if (markers && markers.length > 0) {
      for (const selector of markers) {
        const answer = node.matches(selector) ? node : node.querySelector(selector)
        if (answer) return answer
      }
    }
    return node
  }

  let pendingAssistantCompletion = null
  const setReplyWaiting = (since, reason, messageId = null, computerBaseline = null) => {
    pendingAssistantCompletion = null
    pendingComputerRecognition = null
    // Manual checkNow is allowed for legacy commands, but cannot re-arm desktop history.
    const confirmedSend = ['user-sent', 'result-sent', 'file-send-submitted', 'smart-ui-sent', 'user-edited'].includes(reason)
    // Only a new message starts a fresh retry budget; a resend of the same one keeps counting.
    if (confirmedSend && reason !== 'user-edited') safetyLeak = { count: 0, busy: false, failedKey: null }
    computerReplyWait = since && confirmedSend && PAGE.computerUseRequests === true ? {
      serial: ++computerReplySerial, path: location.pathname, generation: state.taskPromptGeneration,
      sourceSubmissionId: computerSourceSubmissionId, baseline: computerBaseline || computerBaselineOf(), reported: false,
      pageEpoch: computerPageEpoch
    } : null
    if (reason === 'history-baseline' || reason === 'configured-baseline' || reason === 'task-ended') {
      computerSourceSubmissionId = null
      mailSourceSubmissionId = null
    }
    const awaitingReplyBefore = state.awaitingReplySince !== 0
    state.awaitingReplySince = since
    report({ event: 'reply-state', reason, messageId, awaitingReplyBefore })
  }

  /**
   * DeepSeek sometimes answers with its own native tool-call markup (DSML) instead of the
   * JSON block the prompt asks for:
   *
   *   <｜DSML｜function_calls>
   *   <｜DSML｜invoke name="read_files">
   *   <｜DSML｜parameter name="files" string="false">[{"path": "C:\Users\a.png"}]</｜DSML｜parameter>
   *   <｜DSML｜parameter name="description" string="true">查看截图</｜DSML｜parameter>
   *   </｜DSML｜invoke>
   *   </｜DSML｜function_calls>
   *
   * The page renders the bars as `| |` with spaces and may drop the `function_` prefix, so
   * tags are matched by their DSML marker and paired invoke/invocation spelling. Each known tool becomes the same
   * JSON the prompt describes, and every later parser sees exactly that JSON. An invoke of an
   * unknown tool is left alone, so it reads as prose rather than as an invented request.
   */
  const DSML_OPEN = String.raw`<\s*[\s|｜]*DSML[\s|｜]*`
  const DSML_CLOSE = String.raw`<\s*\/[\s|｜]*DSML[\s|｜]*`
  const DSML_INVOKE = new RegExp(`${DSML_OPEN}(invoke|invocation)\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)${DSML_CLOSE}\\1\\s*>`, 'g')
  const DSML_PARAMETER = new RegExp(`${DSML_OPEN}parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)${DSML_CLOSE}parameter\\s*>`, 'g')
  const DSML_WRAPPER = new RegExp(`(?:${DSML_OPEN}|${DSML_CLOSE})\\w*calls\\s*>`, 'g')
  const DSML_INVOKE_START = new RegExp(`${DSML_OPEN}(?:invoke|invocation)\\s+name\\s*=`)
  const DSML_COMPUTER_START = new RegExp(`${DSML_OPEN}(?:invoke|invocation)\\s+name\\s*=\\s*"\\s*computer\\s*"`)
  const DSML_TOOLS = ['read_files', 'questions', 'question', 'read_tool_prompt']
  const looksLikeJsonEnvelope = (text) => /^(?:```(?:json)?\s*)?(?:\{|\[)/i.test(String(text || '').trimStart())
  const looksLikeDsmlToolCall = (text) => DSML_INVOKE_START.test(String(text || ''))
  const looksLikeDsmlComputerCall = (text) => !looksLikeJsonEnvelope(text) && DSML_COMPUTER_START.test(String(text || ''))
  // string="false" is JSON. Models leave Windows paths unescaped (`"C:\Users\a"`), which is
  // either invalid JSON or, worse, valid with `\t`/`\n` inside it; escape lone backslashes first then.
  const dsmlJson = (raw) => {
    const escaped = raw.replace(/\\(["\\/])|\\/g, (match, kept) => kept ? match : '\\\\')
    const attempts = /[A-Za-z]:\\(?!\\)/.test(raw) ? [escaped, raw] : [raw, escaped]
    for (const attempt of attempts) {
      try { return { value: JSON.parse(attempt) } } catch (_) { /* next attempt */ }
    }
    return null
  }
  const dsmlRequest = (name, body) => {
    const tool = name.trim()
    const params = Object.create(null)
    for (const [, key, attributes, rawValue] of body.matchAll(DSML_PARAMETER)) {
      const raw = rawValue.trim()
      const string = /string\s*=\s*"(true|false)"/.exec(attributes)?.[1]
      const json = string === 'true' ? null : string === 'false' || /^[[{]/.test(raw) ? dsmlJson(raw) : null
      params[key.trim()] = json ? json.value : raw
    }
    if (tool === 'read_files') {
      // Native DSML sometimes uses paths:string[] without the JSON contract's description.
      // Adapt only an unambiguous list; the normal file validator still enforces every limit.
      if (!('files' in params) && Array.isArray(params.paths) && params.paths.every(path => typeof path === 'string')) {
        params.files = params.paths.map(path => ({ path }))
        delete params.paths
      }
      if (!('description' in params)) params.description = '读取指定文件'
    }
    if (DSML_TOOLS.includes(tool)) return { type: tool, ...params }
    // The command tool has no `type`; its discriminator is a leading `command` field.
    if (typeof params.command === 'string') return { command: params.command, ...params }
    return null
  }
  // The native tool name supplies type=computer, and this adapter speaks protocol v1.
  // Preserve duplicate fields and typed JSON bytes for the shared strict validator;
  // never apply the legacy Windows-path repair or fill a token/description/action.
  const dsmlComputerRequest = (body) => {
    const fields = []
    let offset = 0, hasType = false, hasVersion = false
    for (const match of body.matchAll(DSML_PARAMETER)) {
      if (body.slice(offset, match.index).trim()) return null
      const [, key, attributes, rawValue] = match
      const string = /^\s+string\s*=\s*"(true|false)"\s*$/.exec(attributes)?.[1]
      if (!string) return null
      const value = string === 'true' ? JSON.stringify(rawValue) : rawValue.trim()
      if (key === 'type') {
        try { if (JSON.parse(value) !== 'computer') return null } catch (_) { return null }
        hasType = true
      }
      if (key === 'version') hasVersion = true
      fields.push(JSON.stringify(key) + ':' + value)
      offset = match.index + match[0].length
    }
    if (body.slice(offset).trim()) return null
    if (!hasVersion) fields.unshift('"version":1')
    if (!hasType) fields.unshift('"type":"computer"')
    return '{' + fields.join(',') + '}'
  }
  const normalizeDsmlToolCalls = (text) => {
    // DSML inside a JSON string is literal user content, not another tool envelope.
    if (looksLikeJsonEnvelope(text)) return text
    if (!looksLikeDsmlToolCall(text)) return text
    if (looksLikeDsmlComputerCall(text) && text.length > 64_000) return text
    let converted = false
    const replaced = text.replace(DSML_INVOKE, (match, _tag, name, body) => {
      const computer = name.trim() === 'computer'
      const request = computer ? dsmlComputerRequest(body) : dsmlRequest(name, body)
      if (!request) return match
      converted = true
      return computer ? request : JSON.stringify(request)
    })
    return converted ? replaced.replace(DSML_WRAPPER, '').replace(/\n{3,}/g, '\n\n').trim() : text
  }

  const readReplyText = (node) => normalizeDsmlToolCalls(String(replyRootOf(node)?.innerText || ''))

  // Code preserves JSON escapes; prose has already passed through Markdown.
  // Read only the final-answer root, never the turn's reasoning or citations.
  const readCommandText = (node) => {
    const root = replyRootOf(node)
    const rendered = readReplyText(node)
    const blocks = root ? [...root.querySelectorAll('pre')] : []
    const block = blocks.findLast(item => /"command"\s*:/.test(String(item.textContent || '')))
    const visible = String(block?.innerText || '')
    const position = visible ? rendered.lastIndexOf(visible) : -1
    // Do not let an earlier code block hide a later malformed prose request.
    return block && position >= 0 && !/"(?:command|background)"/.test(rendered.slice(position + visible.length))
      ? { text: normalizeDsmlToolCalls(String((block.querySelector('code') || block).textContent || '')), source: 'code' }
      : { text: rendered, source: 'rendered' }
  }

  /** Capture before clicking Send. Virtual row positions are a per-send baseline, never durable IDs. */
  const computerBaselineOf = () => {
    const nodes = queryAllAssistant()
    const positions = nodes.map(node => PAGE.fileTurnPositionAttr ? node.getAttribute(PAGE.fileTurnPositionAttr) : null).filter(Boolean)
    // Without row positions (ChatGPT) a reply is new by a message id absent before the send. Every id
    // on the page counts, hidden cached turns included, so no earlier message can come back as new.
    const ids = !PAGE.fileTurnPositionAttr && PAGE.messageIdAttr
      ? [...document.querySelectorAll('[' + PAGE.messageIdAttr + ']')].map(node => node.getAttribute(PAGE.messageIdAttr)).filter(Boolean) : []
    return { path: location.pathname, positions: new Set(positions), maxPosition: positions.length && positions.every(value => /^\d+$/.test(value))
      ? Math.max(...positions.map(Number)) : null, ids: new Set(ids) }
  }

  /**
   * Preserve code bytes while excluding quoted material and the measured reasoning subtree.
   *
   * Code-block chrome is excluded too. DeepSeek's banner now labels its controls 复制／下载 and
   * need not use `<button>` for them; on 2026-10-26 two valid requests were read longer than the
   * visible reply and rejected as ambiguous, since a request with any extra text never runs.
   */
  const readComputerText = (node) => {
    const root = PAGE.assistantReplySelectors.map(selector => node.matches(selector) ? node : node.querySelector(selector)).find(Boolean)
    if (!root) return '' // Unlike legacy reads, there is no whole-turn fallback for desktop input.
    const excluded = element => element.matches('blockquote, q, cite, script, style, button, [role="button"], svg') ||
      (PAGE.focus?.reasoningSelectors || []).some(selector => element.matches(selector))
    const visit = element => {
      if (element.nodeType === 3) {
        const text = element.nodeValue || ''
        return /^(?:json|复制|复制代码|下载|copy|copy code|download)$/i.test(text.trim()) ? '' : text
      }
      if (element.nodeType !== 1 || excluded(element)) return ''
      if (element.tagName === 'PRE') {
        const code = element.querySelector('code')
        return '\n' + (code ? code.textContent : [...element.childNodes].map(visit).join('')) + '\n'
      }
      return '\n' + [...element.childNodes].map(visit).join('') + '\n'
    }
    return normalizeDsmlToolCalls(visit(root).trim())
  }

  /**
   * A chart as Markdown: its title, its accessible data points and its caption. Walking its
   * DOM instead spelled out the SVG's axis ticks and tooltip ("CPU内存0%25%…1234…") and then
   * the screen-reader list, line by line. The interactive chart stays in the original view.
   */
  const chartMarkdown = (root, chart) => {
    // The card's own heading when it has one (the 2026-10-22 screenshot shows it inside the
    // card); the section's aria-label otherwise.
    const titleCandidates = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], strong, b, p, span')]
    const heading = collapse(titleCandidates.find(element =>
      !element.closest('svg, ul, button') && !(chart.captionSelector && element.matches(chart.captionSelector)) &&
      (!['P', 'SPAN'].includes(element.tagName) || element.getAttribute('data-d-default-strong') !== null ||
        Number.parseFloat(getComputedStyle(element).fontWeight) >= 600))?.textContent || '')
    const named = heading || collapse(root.querySelector(chart.titleSelector)?.getAttribute('aria-label') || '')
    // The section's label can be just a type word ("图表 图表", 2026-10-22) while the real title
    // is a heading above the card that is already written out; such a label is no title.
    const title = /^(?:图表|chart)(?:\s+(?:图表|chart))*$/i.test(named) ? '' : named
    const points = [...root.querySelectorAll(chart.dataItemSelector)].map((item) => collapse(item.textContent)).filter(Boolean)
    const caption = chart.captionSelector ? collapse(root.querySelector(chart.captionSelector)?.textContent || '') : ''
    const lines = [title ? '> 📊 **' + title + '**（图表，可在原始视图中交互查看）' : '> 📊 图表（可在原始视图中交互查看）',
      ...(points.length ? ['>', ...points.map((point) => '> - ' + point)] : []),
      ...(caption ? ['>', '> ' + caption] : [])]
    // A machine-readable copy for the focus view, which draws the chart from it. An HTML
    // comment: invisible wherever Markdown is rendered, so the quote above stays the fallback.
    const data = chartData(points)
    // Recharts exposes the rendered series kind. Unknown, mixed and stacked charts
    // stay data tables rather than acquiring an invented line-chart trend.
    const bars = [...root.querySelectorAll('.recharts-bar')]
    const linesPresent = !!root.querySelector('.recharts-line')
    const other = !!root.querySelector('.recharts-area, .recharts-pie, .recharts-scatter, .recharts-radar, .recharts-radial-bar')
    const coordinates = [...root.querySelectorAll('.recharts-rectangle')].map(element => ({
      x: Number.parseFloat(element.getAttribute('x')), y: Number.parseFloat(element.getAttribute('y')),
      height: Number.parseFloat(element.getAttribute('height')) }))
    // Horizontal bars share x rather than y. Redraw only confirmed vertical bars
    // with a common zero baseline, including charts containing negative values.
    const vertical = data && coordinates.length === data.rows.length && coordinates.every(point =>
      Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.height)) &&
      new Set(coordinates.map(point => point.x)).size === coordinates.length && coordinates.every((point, index) =>
        Math.abs(point.y + (data.rows[index].values[0] >= 0 ? point.height : 0) -
          (coordinates[0].y + (data.rows[0].values[0] >= 0 ? coordinates[0].height : 0))) < 1)
    const kind = !other && !linesPresent && bars.length === 1 && data?.series.length === 1 && vertical ? 'bar' :
      !other && !bars.length && linesPresent ? 'line' : 'table'
    const marker = data ? '<!--focus-chart ' + JSON.stringify({ title, caption, kind, ...data }).replace(/</g, '\\u003c').replace(/--/g, '\\u002d\\u002d') + ' -->\n' : ''
    return '\n\n' + marker + lines.join('\n') + '\n\n'
  }

  /**
   * Parse accessible data points such as "周一: 数值 12" or "1: CPU 20%, 内存 50.9%" into
   * series. All-or-nothing: if any point does not parse, or the points disagree on their
   * series, there is no chart and the quoted list is all that is shown.
   */
  const chartData = (points) => {
    if (points.length < 1 || points.length > 200) return null
    const series = []
    const rows = []
    for (const point of points) {
      const split = point.search(/[:：]/)
      if (split <= 0) return null
      const label = point.slice(0, split).trim()
      const parts = point.slice(split + 1).split(/[,，;；]/).map((part) => part.trim()).filter(Boolean)
      if (!label || !parts.length) return null
      const values = []
      for (const part of parts) {
        const match = /^(.*?)\s*(-?\d+(?:\.\d+)?)\s*(%|[A-Za-z]{1,6})?$/.exec(part)
        if (!match) return null
        const value = Number(match[2])
        if (!Number.isFinite(value)) return null
        values.push({ name: match[1].trim(), value, unit: match[3] || '' })
      }
      if (!rows.length) values.forEach((value) => series.push({ name: value.name || '数值', unit: value.unit }))
      else if (values.length !== series.length || values.some((value, index) => (value.name || '数值') !== series[index].name || value.unit !== series[index].unit)) return null
      rows.push({ label, values: values.map((value) => value.value) })
    }
    return series.length <= 6 ? { series, rows } : null
  }

  /** Measured DIL radio cards. Preserve native values/labels; never execute page markup. */
  const smartUiCardsOf = (node) => {
    const rules = PAGE.focus?.smartUi
    if (!rules) return []
    const answer = replyRootOf(node)
    if (!answer) return []
    const roots = [...(answer.matches(rules.rootSelector) ? [answer] : []), ...answer.querySelectorAll(rules.rootSelector)]
    return roots.flatMap(dil => {
      const sourceMessageId = dil.getAttribute(rules.sourceIdAttr)
      if (!sourceMessageId || sourceMessageId !== messageIdOf(node)) return []
      const cards = [...new Set([...dil.querySelectorAll(rules.groupSelector)].map(group => group.closest(rules.cardSelector)))]
        .filter(card => card && dil.contains(card) && card.closest(rules.rootSelector) === dil).slice(0, 8)
      return cards.flatMap((element, index) => {
        const groups = [...element.querySelectorAll(rules.groupSelector)]
        if (groups.length !== 1) return []
        const group = groups[0], controls = [...group.querySelectorAll(rules.optionSelector)]
        const buttons = [...element.querySelectorAll(rules.actionSelector)]
        if (controls.length < 2 || controls.length > 32 || buttons.length < 1 || buttons.length > 4) return []
        const labels = [...dil.querySelectorAll('label')]
        const options = controls.map(control => {
          const labelNode = control.closest('label') || labels.find(label => label.htmlFor === control.id)
          const label = collapse(labelNode?.textContent || control.getAttribute('aria-label') || control.textContent)
          const candidateTitle = collapse(labelNode?.querySelector('strong, b, [data-d-default-strong]')?.textContent).slice(0, 500)
          const title = label.startsWith(candidateTitle) ? candidateTitle : ''
          return { value: control.getAttribute('value') || '', label: label.slice(0, 3000), title,
            description: title && label.startsWith(title) ? label.slice(title.length).trim().slice(0, 3000) : '',
            selected: control.getAttribute('aria-checked') === 'true', disabled: controlDisabled(control) }
        })
        if (options.some(option => !option.value || option.value.length > 500 || !option.label) ||
          new Set(options.map(option => option.value)).size !== options.length || options.filter(option => option.selected).length > 1) return []
        const actions = buttons.map(button => ({ label: collapse(button.textContent).slice(0, 500), disabled: controlDisabled(button) }))
        if (actions.some(button => !button.label)) return []
        const identity = JSON.stringify([options.map(option => [option.value, option.label]), actions.map(action => action.label)])
        let hash = 2166136261
        for (let at = 0; at < identity.length; at++) hash = Math.imul(hash ^ identity.charCodeAt(at), 16777619)
        const data = { version: 1, sourceMessageId, index, signature: (hash >>> 0).toString(16).padStart(8, '0'),
          title: collapse(element.querySelector('h1, h2, h3, h4, h5, h6')?.textContent).slice(0, 500),
          description: collapse(element.querySelector(':scope > p')?.textContent).slice(0, 3000),
          label: collapse(group.getAttribute('aria-label')).slice(0, 500), disabled: controlDisabled(group), options, buttons: actions }
        return [{ element, controls, buttons, data }]
      })
    })
  }
  const smartUiMarkdown = data => {
    const json = JSON.stringify(data).replace(/</g, '\\u003c')
    const fallback = [data.title, data.description, ...data.options.map(option => (option.selected ? '[x] ' : '[ ] ') + option.label), ...data.buttons.map(button => button.label)]
      .filter(Boolean).join('\n').split('\n').map(line => '> ' + line).join('\n')
    return '\n\n<!--focus-ui ' + json + ' -->\n' + fallback + '\n\n'
  }

  // Reuse copies across focus polling; weak keys release them with their native image elements.
  const focusLayoutImageCopies = new WeakMap()

  /** A bounded presentation tree, read from native DIL boxes, images, lists and vector icons. */
  const smartUiLayoutsOf = node => {
    const rules = PAGE.focus?.smartUi, answer = rules ? replyRootOf(node) : null
    if (!answer) return []
    const roots = [...(answer.matches(rules.rootSelector) ? [answer] : []), ...answer.querySelectorAll(rules.rootSelector)]
    const allowed = new Set(['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'small',
      'ul', 'ol', 'li', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'figure', 'figcaption',
      'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])
    const ignored = new Set(['script', 'style', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'link', 'meta', 'foreignobject', 'use', 'animate', 'set'])
    const inlineImageOf = (value, limit) => {
      if (typeof value !== 'string' || value.length > limit) return ''
      const parts = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)((?:;charset=utf-8|;utf8)?)(;base64)?,([\s\S]+)$/i.exec(value)
      if (!parts) return ''
      if (parts[3]) return /^[A-Za-z0-9+/]+={0,2}$/.test(parts[4]) && parts[4].length % 4 !== 1 ? value : ''
      if (parts[1].toLowerCase() !== 'svg+xml') return ''
      try {
        const svg = decodeURIComponent(parts[4])
        if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s/>]/i.test(svg) || /<!DOCTYPE|<!ENTITY/i.test(svg)) return ''
        const src = 'data:image/svg+xml,' + encodeURIComponent(svg)
        return src.length <= limit ? src : ''
      } catch { return '' }
    }
    const urlOf = (value, image = false) => {
      if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return ''
      try {
        const url = new URL(value, location.href)
        return (image ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol)) && url.hostname && !url.username && !url.password ? url.href : ''
      } catch { return '' }
    }
    const imageOf = (image, limit) => {
      const candidates = [image.currentSrc, image.src, image.getAttribute('src'), image.getAttribute('data-src')]
      const origin = new URL(location.href).origin
      for (const source of candidates) {
        if (typeof source !== 'string' || !source) continue
        const inline = inlineImageOf(source, limit)
        if (inline) return inline
        const remote = urlOf(source, true)
        let temporary = false
        try { const url = new URL(source); temporary = url.protocol === 'blob:' && url.origin === origin } catch {}
        const oversized = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(source)
        if (!remote && !temporary && !oversized) continue
        // Copy only decoded native pixels. No fetch, navigation or access to another session is needed.
        const width = image.naturalWidth, height = image.naturalHeight
        if (image.complete && width > 0 && height > 0 && limit >= 1024) {
          const saved = focusLayoutImageCopies.get(image)
          if (saved?.source === source && saved.width === width && saved.height === height && saved.limit === limit) return saved.value || remote
          let value = ''
          try {
            const canvas = document.createElement('canvas')
            for (const edge of [1600, 1024, 640]) {
              const scale = Math.min(1, edge / width, edge / height)
              canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
              const context = canvas.getContext('2d')
              if (!context) break
              context.drawImage(image, 0, 0, canvas.width, canvas.height)
              value = inlineImageOf(canvas.toDataURL('image/png'), limit)
              if (!value) value = inlineImageOf(canvas.toDataURL('image/webp', .85), limit)
              if (value) break
            }
          } catch { /* Tainted remote images keep their validated HTTPS source. */ }
          focusLayoutImageCopies.set(image, { source, width, height, limit, value })
          if (value) return value
        }
        if (remote) return remote
      }
      return ''
    }
    const length = value => /^(?:0|auto|normal|none|\d+(?:\.\d+)?(?:px|%|rem|em))$/.test(value) && (!/^\d/.test(value) || parseFloat(value) <= 2000)
    const pixels = value => Number.parseFloat(value) || 0
    const rgba = value => {
      const raw = String(value), values = raw.match(/-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi)?.map(Number) || []
      if (raw.startsWith('color(srgb ')) for (let index = 0; index < 3; index++) values[index] = Math.max(0, Math.min(1, values[index])) * 255
      return { values, clear: value === 'transparent' || (values.length === 4 && values[3] === 0) }
    }
    const colorTone = (value, neutral, background = false) => {
      const { values } = rgba(value), [r, g, b] = values
      if (values.length < 3) return neutral
      const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
      if (delta <= 25) return neutral
      const hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360
      const tone = hue >= 70 && hue < 165 ? '$success' : hue >= 25 && hue < 70 ? '$warning' : hue < 25 || hue >= 345 ? '$danger' : '$accent'
      return background && ((values[3] ?? 1) < .5 || (max + min) / 2 > 190) ? tone + 'Soft' : tone
    }
    const visibleChildren = element => [...element.children].filter(child => {
      const css = getComputedStyle(child)
      return css.display !== 'none' && !['hidden', 'collapse'].includes(css.visibility) && !child.hasAttribute('hidden')
    })
    // Progress can be an ARIA/native control or just two empty painted DIL boxes.
    // Read its value/geometry, then rebuild a local track rather than replaying transforms.
    const progressOf = element => {
      const tag = element.tagName.toLowerCase()
      if (!['div', 'span', 'progress', 'meter'].includes(tag)) return null
      const semantic = ['progress', 'meter'].includes(tag) || ['progressbar', 'meter'].includes(element.getAttribute('role'))
      if (!semantic && (element.children.length !== 1 || collapse(element.textContent) || element.querySelector('img, picture'))) return null
      const css = getComputedStyle(element)
      if (css.display === 'none' || ['hidden', 'collapse'].includes(css.visibility) || element.hasAttribute('hidden')) return null
      const children = visibleChildren(element), fill = children.length === 1 ? children[0] : null
      const fillCss = fill ? getComputedStyle(fill) : null, height = pixels(css.height), width = pixels(css.width)
      if (!semantic && (height <= 2 || height > 24 || width < 32 ||
        rgba(css.backgroundColor).clear || !fillCss || rgba(fillCss.backgroundColor).clear || pixels(fillCss.height) <= 0 ||
        fill.querySelector('svg, input, button, textarea') || collapse(fill.textContent))) return null
      const number = value => value !== null && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Math.abs(Number(value)) <= 1e9 ? Number(value) : null
      const native = ['progress', 'meter'].includes(tag)
      const min = number(element.getAttribute(native ? 'min' : 'aria-valuemin')) ?? 0
      const max = number(element.getAttribute(native ? 'max' : 'aria-valuemax')) ?? (native ? 1 : 100)
      const now = number(element.getAttribute(native ? 'value' : 'aria-valuenow'))
      let measured = null
      if (width > 0 && fillCss) {
        if (!fillCss.transform || fillCss.transform === 'none') measured = pixels(fillCss.width) / width
        else {
          const matrix = /^matrix\(([^)]+)\)$/.exec(fillCss.transform)?.[1].split(',').map(Number)
          if (matrix?.length === 6 && matrix.every(Number.isFinite) && matrix[0] === 1 && matrix[1] === 0 &&
            matrix[2] === 0 && matrix[3] === 1 && matrix[4] <= 0 && matrix[5] === 0) measured = (pixels(fillCss.width) + matrix[4]) / width
        }
      }
      const ratio = now !== null && max > min ? Math.max(0, Math.min(1, (now - min) / (max - min))) :
        measured !== null && measured >= 0 && measured <= 1 ? measured : null
      return { ratio, height: height > 0 && height <= 32 ? height + 'px' : '8px',
        radius: length(css.borderRadius) ? css.borderRadius : '999px',
        label: collapse(element.getAttribute('aria-label')).slice(0, 500),
        tone: fillCss && !rgba(fillCss.backgroundColor).clear ? colorTone(fillCss.backgroundColor, '$muted') :
          colorTone(css.accentColor, colorTone(css.color, '$accent')),
        track: colorTone(css.backgroundColor, '$soft', true) }
    }
    const separator = element => {
      if (element.tagName.toLowerCase() === 'hr') return true
      if (!['div', 'span'].includes(element.tagName.toLowerCase()) || collapse(element.textContent) || element.querySelector('svg, input, button')) return false
      const style = getComputedStyle(element), height = pixels(style.height)
      return pixels(style.borderTopWidth) > 0 || pixels(style.borderBottomWidth) > 0 ||
        (height > 0 && height <= 2 && !rgba(style.backgroundColor).clear)
    }
    const iconList = element => {
      if (!['div', 'section', 'ul', 'ol'].includes(element.tagName.toLowerCase())) return false
      const style = getComputedStyle(element)
      if (style.display.includes('grid') || (style.display.includes('flex') && !style.flexDirection.startsWith('column'))) return false
      const children = [...element.children].filter(child => {
        const css = getComputedStyle(child)
        return css.display !== 'none' && !['hidden', 'collapse'].includes(css.visibility) && !child.hasAttribute('hidden')
      })
      const rows = children.filter(child => {
        if (!collapse(child.textContent) || !child.querySelector('svg') || child.querySelector('h1, h2, table, ul, ol')) return false
        const css = getComputedStyle(child)
        return child.tagName.toLowerCase() === 'li' || (css.display.includes('flex') && css.flexDirection.startsWith('row'))
      })
      // Keep the list boundary, rather than swallowing the answer's headings and prose.
      return rows.length >= 2 && children.every(child => rows.includes(child) || separator(child))
    }
    const layoutGroup = element => {
      if (!['div', 'section', 'article'].includes(element.tagName.toLowerCase()) || element.getAttribute('data-d-component') === 'Text' ||
        element.closest('button, a')) return false
      const style = getComputedStyle(element)
      if (!style.display.includes('grid') && !(style.display === 'flex' && style.flexDirection.startsWith('row'))) return false
      return [...element.children].filter(child => {
        const css = getComputedStyle(child)
        return css.display !== 'none' && !['hidden', 'collapse'].includes(css.visibility) && !child.hasAttribute('hidden') &&
          (collapse(child.textContent) || child.tagName.toLowerCase() === 'img' || child.querySelector('svg, input, img'))
      }).length >= 2
    }
    const geometry = { viewBox: 'viewBox', width: 'width', height: 'height', d: 'd', x: 'x', y: 'y', x1: 'x1', y1: 'y1', x2: 'x2', y2: 'y2',
      cx: 'cx', cy: 'cy', r: 'r', rx: 'rx', ry: 'ry', points: 'points', fill: 'fill', stroke: 'stroke',
      'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule' }
    return roots.flatMap(dil => {
      const sourceMessageId = dil.getAttribute(rules.sourceIdAttr)
      if (!sourceMessageId || sourceMessageId !== messageIdOf(node)) return []
      const candidates = [dil, ...dil.querySelectorAll('[data-d-component], ul, ol')]
      const lists = new Set(candidates.filter(iconList))
      const galleries = new Set(candidates.filter(element => {
        if (!layoutGroup(element)) return false
        const children = visibleChildren(element)
        return children.length >= 2 && children.length <= 6 && children.every(child =>
          child.tagName.toLowerCase() === 'img' || child.querySelector('img'))
      }))
      const progress = new Map([dil, ...dil.querySelectorAll('div, span, progress, meter')]
        .map(element => [element, progressOf(element)]).filter(([, value]) => value))
      const metrics = new Set(candidates.filter(element => {
        if (!['div', 'section', 'article'].includes(element.tagName.toLowerCase())) return false
        const children = visibleChildren(element)
        // Keep a header, bar and statistics together without absorbing surrounding prose.
        return children.length === 3 && [...progress.keys()].some(bar => children[1] === bar || children[1].contains(bar)) &&
          (layoutGroup(children[0]) || children[0].getAttribute('data-d-component') === 'Text' || /^H[1-6]$/.test(children[0].tagName)) &&
          layoutGroup(children[2])
      }))
      let boxes = [...new Set([...(dil.matches(rules.cardSelector) ? [dil] : []), ...dil.querySelectorAll(rules.cardSelector),
        ...lists, ...metrics, ...progress.keys(), ...candidates.filter(layoutGroup)])].filter(element =>
        element.closest(rules.rootSelector) === dil && !element.closest(rules.groupSelector) && !element.querySelector(rules.groupSelector) &&
        !(PAGE.answerCharts && (element.matches(PAGE.answerCharts.rootSelector) || element.querySelector(PAGE.answerCharts.rootSelector))))
      boxes = boxes.filter(element => !boxes.some(parent => parent !== element && parent.contains(element)))
      // DIL also wraps ordinary paragraphs and inline code. Text components alone
      // are not a layout: keep them in Markdown, outside the presentation trees.
      return boxes.slice(0, 8).flatMap(element => {
        if (!isVisibleElement(element)) return []
        const base = getComputedStyle(element), baseColor = base.color
        let count = 0, chars = 0, images = 0, imageChars = 0, failed = false
        const read = (current, parent, depth) => {
          if (++count > 600 || depth > 22) { failed = true; return null }
          if (current.nodeType === Node.TEXT_NODE) {
            const value = String(current.nodeValue || '').replace(/\s+/g, ' ')
            chars += value.length
            if (value.length > 10000 || chars > 40000) { failed = true; return null }
            return value
          }
          if (current.nodeType !== Node.ELEMENT_NODE) return null
          const nativeTag = current.tagName.toLowerCase()
          if (ignored.has(nativeTag)) return null
          const computed = getComputedStyle(current)
          if (computed.display === 'none' || ['hidden', 'collapse'].includes(computed.visibility) || current.hasAttribute('hidden')) return null
          const bar = progress.get(current)
          if (bar) {
            const attrs = { role: 'progressbar', ...(bar.label ? { 'aria-label': bar.label } : {}),
              ...(bar.ratio !== null ? { 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(bar.ratio * 10000) / 100) } : {}) }
            return { tag: 'div', attrs, style: { display: 'block', width: '100%', height: bar.height, borderRadius: bar.radius,
              overflow: 'hidden', backgroundColor: bar.track, flexShrink: '0' },
            children: bar.ratio === null ? [] : [{ tag: 'div', style: { width: Math.round(bar.ratio * 10000) / 100 + '%',
              height: '100%', borderRadius: bar.radius, backgroundColor: bar.tone } }] }
          }
          const divider = separator(current)
          const href = nativeTag === 'a' ? urlOf(current.href || current.getAttribute('href')) : ''
          const tag = nativeTag === 'a' && !href ? 'span' : allowed.has(nativeTag) ? nativeTag :
            nativeTag === 'button' || nativeTag === 'input' || nativeTag === 'textarea' ? 'span' : 'div'
          const result = { tag }, style = {}, attrs = {}
          const put = (key, value) => { if (value) style[key] = value }
          if (href) attrs.href = href
          if (computed.overflow === 'hidden') put('overflow', 'hidden')
          if (['flex', 'inline-flex', 'grid', 'inline-grid', 'inline-block', 'contents', 'table', 'table-row', 'table-cell'].includes(computed.display)) put('display', computed.display)
          if (computed.display.includes('flex') || computed.display.includes('grid')) {
            for (const key of ['flexDirection', 'flexWrap', 'alignItems', 'justifyContent']) put(key, computed[key])
          }
          for (const key of ['alignSelf', 'flexGrow', 'flexShrink']) if (computed[key] && !['auto', '0', '1'].includes(computed[key])) put(key, computed[key])
          // A grow value of one is significant even though shrink defaults to one.
          if (computed.flexGrow === '1') put('flexGrow', '1')
          if (computed.flexShrink === '0') put('flexShrink', '0')
          for (const key of ['flexBasis', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'rowGap', 'columnGap']) {
            const value = computed[key]
            if (value && !['auto', 'none', 'normal', '0px', '0%'].includes(value) && length(value)) put(key, value)
            if (key === 'flexBasis' && value === '0%') put(key, value)
          }
          for (const key of ['width', 'height']) {
            const value = current.style?.getPropertyValue(key) || ''
            if (current !== element && value && length(value)) put(key, value)
            else if (nativeTag === 'svg' && length(computed[key])) put(key, computed[key])
            else if (key === 'width' && current !== element && parent?.display.includes('flex') && parent.flexDirection === 'row' && computed.flexShrink === '0' && length(computed.width)) put(key, computed.width)
          }
          // Native Divider can be an empty div with a one-pixel background, not a border.
          if (divider && pixels(computed.height) > 0 && pixels(computed.height) <= 2 && length(computed.height)) put('height', computed.height)
          for (const key of ['gridColumn', 'gridRow']) if (computed[key] && /^(?:[1-9]|span [1-8])(?: \/ (?:auto|[1-9]|span [1-8]))?$/.test(computed[key])) put(key, computed[key])
          if (computed.display.includes('grid')) {
            const explicit = current.style?.getPropertyValue('grid-template-columns') || ''
            if (/^repeat\([1-8],\s*minmax\(0(?:px)?,\s*1fr\)\)$/.test(explicit)) put('gridTemplateColumns', explicit)
            else {
              const columns = computed.gridTemplateColumns.split(/\s+/)
              if (columns.length <= 8 && columns.every(value => /^\d+(?:\.\d+)?px$/.test(value))) {
                const total = columns.reduce((sum, value) => sum + pixels(value), 0)
                if (total > 0) put('gridTemplateColumns', columns.map(value => Math.max(.001, Math.round(pixels(value) / total * 1000) / 1000) + 'fr').join(' '))
              }
            }
          }
          for (const key of ['padding', 'margin']) {
            if (current === element && key === 'margin') continue
            const values = ['Top', 'Right', 'Bottom', 'Left'].map(side => computed[key + side] || '0px')
            if (values.every(length) && values.some(value => value !== '0px')) put(key, values.every(value => value === values[0]) ? values[0] : values.join(' '))
          }
          const borders = ['Top', 'Right', 'Bottom', 'Left'].map(side => computed['border' + side + 'Width'] || '0px')
          if (borders.every(length) && borders.some(value => pixels(value) > 0)) {
            put('borderWidth', borders.every(value => value === borders[0]) ? borders[0] : borders.join(' '))
            put('borderStyle', ['solid', 'dashed', 'dotted'].includes(computed.borderTopStyle) ? computed.borderTopStyle : 'solid')
            put('borderColor', '$border')
          }
          const radii = String(computed.borderRadius || '').split(/\s+/).map(value => /^\d+(?:\.\d+)?px$/.test(value) ? Math.min(999, pixels(value)) + 'px' : value)
          if (radii.every(length) && radii.some(value => pixels(value) > 0)) put('borderRadius', radii.join(' '))
          for (const key of ['fontSize', 'lineHeight']) if ((!parent || computed[key] !== parent[key]) && length(computed[key])) put(key, computed[key])
          if ((!parent || computed.fontWeight !== parent.fontWeight) && /^[1-9]00$/.test(computed.fontWeight)) put('fontWeight', computed.fontWeight)
          if (computed.fontStyle === 'italic') put('fontStyle', 'italic')
          if (['center', 'right', 'end'].includes(computed.textAlign)) put('textAlign', computed.textAlign)
          if (['pre-wrap', 'pre-line', 'nowrap'].includes(computed.whiteSpace)) put('whiteSpace', computed.whiteSpace)
          if (!parent || computed.color !== parent.color) {
            put('color', colorTone(computed.color, computed.color === baseColor ? '$text' : '$muted'))
          }
          if (!rgba(computed.backgroundColor).clear) {
            const color = rgba(computed.backgroundColor).values
            put('backgroundColor', divider ? '$border' : colorTone(computed.backgroundColor,
              color.length >= 3 && (Math.min(...color.slice(0, 3)) > 248 || Math.max(...color.slice(0, 3)) < 12) ? '$bg' : '$soft', true))
          }
          if (computed.opacity && Number(computed.opacity) < 1 && Number(computed.opacity) >= 0) put('opacity', computed.opacity)
          if (nativeTag === 'img') {
            const src = imageOf(current, Math.min(131072, 140000 - imageChars))
            const alt = String(current.getAttribute('alt') || '').slice(0, 500)
            if (!src) {
              chars += alt.length || 9
              return { tag: 'span', children: [alt || '图片暂时无法显示'] }
            }
            if (++images > 12) { failed = true; return null }
            if (/^data:/i.test(src)) imageChars += src.length
            const rect = current.getBoundingClientRect(), width = pixels(computed.width) || rect.width || current.naturalWidth,
              height = pixels(computed.height) || rect.height || current.naturalHeight
            // Absolute-positioned native images become normal-flow images with the same crop ratio.
            Object.assign(style, { display: 'block', width: '100%', maxWidth: '100%', height: 'auto',
              objectFit: ['contain', 'cover', 'fill', 'none', 'scale-down'].includes(computed.objectFit) ? computed.objectFit : 'cover' })
            if (width > 0 && height > 0 && width / height >= .05 && width / height <= 20) {
              put('aspectRatio', Math.round(width / height * 10000) / 10000 + ' / 1')
            }
            return { tag: 'img', attrs: { src, alt }, style }
          }
          if (['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'].includes(tag)) {
            for (const [name, key] of Object.entries(geometry)) {
              const value = current.getAttribute(name)
              if (value === null) continue
              if (key === 'fill' || key === 'stroke') attrs[key] = ['none', 'transparent'].includes(value) ? value : 'currentColor'
              else if (key === 'd' && value.length <= 16000 && /^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]*$/.test(value)) attrs[key] = value
              else if (key === 'viewBox' && /^-?\d+(?:\.\d+)?(?:[ ,]+-?\d+(?:\.\d+)?){3}$/.test(value)) attrs[key] = value
              else if (key === 'points' && value.length <= 16000 && /^[0-9.,+\s-]+$/.test(value)) attrs[key] = value
              else if (['strokeLinecap', 'strokeLinejoin', 'fillRule', 'clipRule'].includes(key) && /^(?:butt|round|square|miter|bevel|evenodd|nonzero)$/.test(value)) attrs[key] = value
              else if (/^-?\d+(?:\.\d+)?$/.test(value) && Math.abs(Number(value)) <= 2000) attrs[key] = value
            }
            for (const key of ['fill', 'stroke']) if (!(key in attrs) && computed[key]) attrs[key] =
              ['none', 'transparent'].includes(computed[key]) ? computed[key] : 'currentColor'
          }
          if (Object.keys(style).length) result.style = style
          if (Object.keys(attrs).length) result.attrs = attrs
          if (nativeTag === 'input' || nativeTag === 'textarea') {
            if (nativeTag === 'input' && !['text', 'search', ''].includes(current.getAttribute('type') || '')) return null
            result.children = [String(current.getAttribute('placeholder') || '').slice(0, 500)]
          } else result.children = [...current.childNodes].map(child => read(child, computed, depth + 1)).filter(child => child !== null)
          return result
        }
        const root = read(element, null, 0)
        if (!root || failed || (chars === 0 && images === 0 && !progress.has(element))) return []
        const data = { version: 1, sourceMessageId, label: collapse(element.getAttribute('aria-label') ||
          element.querySelector('h1, h2, h3, h4, strong, b')?.textContent).slice(0, 500) || '智能界面布局',
          width: Math.min(2000, Math.max(32, Math.round(element.getBoundingClientRect().width))),
          ...(lists.has(element) ? { kind: 'list' } : galleries.has(element) ? { kind: 'gallery' } :
            metrics.has(element) || progress.has(element) ? { kind: 'metrics' } : {}), root }
        if (JSON.stringify(data).length > 180000) return []
        const bar = progress.get(element)
        return [{ element, data, fallback: String(element.innerText || '').trim().slice(0, 20000) ||
          (bar ? [bar.label || '进度', bar.ratio === null ? '' : Math.round(bar.ratio * 10000) / 100 + '%'].filter(Boolean).join('：') :
            images ? [...element.querySelectorAll('img')].map(image => String(image.getAttribute('alt') || '图片预览').slice(0, 500)).join('\n') : '') }]
      })
    })
  }
  const layoutMarkdown = layout => '\n\n<!--focus-layout ' + JSON.stringify(layout.data).replace(/</g, '\\u003c') + ' -->\n' +
    layout.fallback.split('\n').map(line => '> ' + line).join('\n') + '\n\n'

  /** Preserve the rendered answer structure as Markdown for the app-owned transcript. */
  const readReplyMarkdown = (node) => {
    const root = replyRootOf(node)
    if (!root) return ''
    const smartCards = PAGE.focus?.smartUi ? smartUiCardsOf(node) : []
    const layouts = PAGE.focus?.smartUi ? smartUiLayoutsOf(node) : []
    const codeCards = new Map()
    const codeMarkdown = []
    const languageAliases = { 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', js: 'javascript', ts: 'typescript',
      py: 'python', sh: 'bash', shell: 'bash', 'shell script': 'bash', ps1: 'powershell',
      yml: 'yaml', md: 'markdown', 'plain text': 'text', plaintext: 'text', txt: 'text' }
    const languages = new Set(('java javascript typescript jsx tsx python c cpp csharp go rust ruby php kotlin swift scala groovy ' +
      'sql json xml html css scss bash powershell yaml markdown dockerfile text diff ini toml properties ' +
      'r lua perl objective-c dart graphql makefile nginx apache console').split(' '))
    const languageOf = (value, explicit = false) => {
      const text = String(value || '').trim().toLowerCase()
      const language = languageAliases[text] || text
      return languages.has(language) || explicit && /^[a-z][\w+-]{0,39}$/.test(language) ? language : ''
    }
    const codeLanguage = (element) => {
      if (!element) return ''
      const declared = element.getAttribute('data-language') || element.getAttribute('data-lang')
      const classes = String(element.getAttribute('class') || element.className || '')
      return languageOf(declared, true) || languageOf(classes.match(/(?:^|\s)(?:language-|lang-)([\w+-]+)/i)?.[1], true)
    }
    // Only a compact header beside one <pre> is treated as code chrome. Normal prose
    // mentioning a language remains part of the answer, and toolbar button text is excluded.
    const headerText = (current) => {
      if (current.nodeType === Node.TEXT_NODE) return String(current.nodeValue || '')
      if (current.nodeType !== Node.ELEMENT_NODE || /^(button|svg|script|style)$/i.test(current.tagName) ||
        current.getAttribute('role') === 'button' || current.getAttribute('aria-hidden') === 'true') return ''
      return [...current.childNodes].map(headerText).join('')
    }
    const pres = [...(root.tagName?.toLowerCase() === 'pre' ? [root] : []), ...(root.querySelectorAll?.('pre') || [])]
      .filter(element => element.tagName?.toLowerCase() === 'pre')
    for (const pre of pres) {
      const code = pre.querySelector('code') || pre
      let language = codeLanguage(code) || codeLanguage(pre)
      let card = pre
      let parent = pre === root ? null : pre.parentElement
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (parent.querySelectorAll('pre').length !== 1) break
        const headers = [...parent.children].filter(child => child !== pre && ![...child.querySelectorAll('pre')].includes(pre))
        const labels = headers.map(child => headerText(child).trim()).filter(Boolean)
        const headerLanguage = labels.map(label => languageOf(label)).find(Boolean)
        const controls = headers.some(child => child.querySelector('button, [role="button"]'))
        if (headerLanguage && controls && labels.every(label => languageOf(label))) {
          language = language || headerLanguage
          card = parent
          break
        }
        language = language || codeLanguage(parent)
        if (parent === root) break
      }
      codeCards.set(card, { code, language })
    }
    const renderCode = (code, language) => {
      const raw = String(code.textContent || '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
      let length = 3
      for (const match of raw.matchAll(/`{3,}/g)) length = Math.max(length, match[0].length + 1)
      const fence = '`'.repeat(length)
      const index = codeMarkdown.push(`${fence}${language}\n${raw}\n${fence}`) - 1
      // Protect literal code from the prose whitespace normalisation below.
      return `\n\n\u0000focus-code:${index}\u0000\n\n`
    }

    const render = (current, depth = 0, strongContext = false) => {
      if (!current) return ''
      if (current.nodeType === Node.TEXT_NODE) return String(current.nodeValue || '')
      if (current.nodeType !== Node.ELEMENT_NODE) return ''

      const element = current
      const codeCard = codeCards.get(element)
      if (codeCard) return renderCode(codeCard.code, codeCard.language)
      const smart = smartCards.find(card => card.element === element)
      if (smart) return smartUiMarkdown(smart.data)
      const layout = layouts.find(item => item.element === element)
      if (layout) return layoutMarkdown(layout)
      const tag = element.tagName.toLowerCase()
      // KaTeX contains three representations of the SAME formula: MathML, its TeX
      // annotation and visual HTML. Consume the outer formula once, before walking
      // children, otherwise every expression is concatenated two or three times.
      if (element.matches('.katex-display, .katex, math')) {
        const annotation = element.querySelector('annotation[encoding="application/x-tex"]')
        const tex = String(annotation?.textContent || '').trim()
        const display = element.matches('.katex-display') || element.getAttribute('display') === 'block'
        if (tex) return display ? '\n\n$$\n' + tex + '\n$$\n\n' : '$' + tex.replace(/\s*\n\s*/g, ' ') + '$'
        // A partial/native formula without TeX still has one readable version.
        // Never fall back to all descendants, which includes accessibility copies.
        const visual = element.querySelector('.katex-html') || element.querySelector('mrow')
        return String(visual?.textContent || element.getAttribute('aria-label') || '')
      }
      const heading = /^h[1-6]$/.test(tag)
      // DIL Text uses p/span with an explicit strong marker or a computed weight;
      // treating these as plain wrappers loses emphasis outside the layout cards.
      const strong = tag === 'strong' || tag === 'b' || element.getAttribute('data-d-default-strong') !== null ||
        (PAGE.focus?.smartUi && (tag === 'p' || tag === 'span') && element.getAttribute('data-d-component') === 'Text' &&
          Number.parseFloat(getComputedStyle(element).fontWeight) >= 600)
      const children = () => [...element.childNodes].map((child) => render(child, depth, strongContext || strong || heading)).join('')
      const emphasis = body => {
        if (!strong || strongContext || !body.trim()) return body
        // Delimiters must touch non-whitespace, especially in inline Text spans.
        return body.replace(/^(\s*)([\s\S]*?\S)(\s*)$/, (_, before, text, after) => before + '**' + text + '**' + after)
      }
      const chart = PAGE.answerCharts
      if (chart && element.matches(chart.rootSelector)) return chartMarkdown(element, chart)
      // ChatGPT's current renderer uses a span marker for inline code instead of a
      // semantic <code> element. Preserve the Markdown delimiter so the backup transcript
      // renders the same gray monospace pill as the native page.
      if (element.getAttribute('data-markdown-copy') === 'inline-code') {
        return `\`${String(element.textContent || '').replace(/\`/g, '\\\`')}\``
      }

      if (tag === 'br') return '\n'
      if (tag === 'hr') return '\n\n---\n\n'
      if (tag === 'pre') {
        const code = element.querySelector('code')
        return renderCode(code || element, codeLanguage(code) || codeLanguage(element))
      }
      if (tag === 'code') return `\`${String(element.textContent || '').replace(/\`/g, '\\`')}\``
      if (tag === 'strong' || tag === 'b') return emphasis(children())
      if (tag === 'em' || tag === 'i') return `*${children()}*`
      if (tag === 'del' || tag === 's') return `~~${children()}~~`
      if (tag === 'a') {
        const label = children().trim() || String(element.getAttribute('href') || '')
        const href = String(element.getAttribute('href') || '')
        return href ? `[${label}](${href})` : label
      }
      if (heading) return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`
      if (tag === 'blockquote') {
        const body = children().trim().split('\n').map((line) => `> ${line}`).join('\n')
        return `\n\n${body}\n\n`
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = [...element.children]
          .filter((child) => child.tagName.toLowerCase() === 'li')
          .map((child, index) => {
            const prefix = tag === 'ol' ? `${index + 1}. ` : '- '
            // Continuation paragraphs (including display math) belong to this item.
            // Render nested lists relative to it, then indent every continuation.
            const body = render(child, 0, strongContext).trim()
            const indent = ' '.repeat(prefix.length)
            return prefix + body.replace(/\n/g, '\n' + indent)
          })
          .join('\n')
        return `\n${items}\n`
      }
      if (tag === 'li') return children()
      if (tag === 'p') return `\n\n${emphasis(children().trim())}\n\n`
      if (tag === 'table') {
        const rows = [...element.querySelectorAll('tr')].map((row) =>
          [...row.querySelectorAll(':scope > th, :scope > td')].map((cell) => render(cell, depth, strongContext).trim().replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|'))
        )
        if (rows.length === 0) return children()
        const width = Math.max(...rows.map((row) => row.length))
        const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')])
        const header = normalized[0]
        const body = normalized.slice(1)
        return `\n\n| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |${body.length ? `\n${body.map((row) => `| ${row.join(' | ')} |`).join('\n')}` : ''}\n\n`
      }
      if (tag === 'div' || tag === 'section' || tag === 'article') return emphasis(children())
      return emphasis(children())
    }

    return render(root)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .replace(/(^|\n)([ \t]*)\u0000focus-code:(\d+)\u0000/g, (_, before, indent, index) =>
        before + indent + codeMarkdown[Number(index)].replace(/\n/g, '\n' + indent))
  }
  /** True when this turn is an ASSISTANT one, decided by structure rather than by class. */
  const isAssistantTurn = (node) => {
    // A missing element is not an assistant turn. The callers do not currently pass null,
    // but `readReplyText` right above guards it and this does not — an asymmetry that would
    // turn a future refactor into a TypeError in a page we do not control.
    if (!node) return false
    // A site's explicit role belongs to the turn, not to its current text renderer.
    // Claude's code-only replies need not contain the usual answer font class.
    const roles = PAGE.assistantRoleSelectors
    if (roles && roles.length > 0) return roles.some((selector) => node.matches(selector))
    const markers = PAGE.assistantReplySelectors
    if (!markers || markers.length === 0) return true
    return markers.some((selector) => node.matches(selector) || node.querySelector(selector) !== null)
  }

  /**
   * Write text into the composer, and report whether it took.
   *
   * The two paths exist for the same underlying reason — a framework owns the editor and
   * ignores a direct DOM write — but the escape hatch differs:
   *
   *   - contenteditable: `document.execCommand('insertText')` goes through the browser's
   *     editing pipeline, so ProseMirror records a normal user edit.
   *   - textarea: React tracks the previous value on the node itself, so assigning
   *     `.value` makes React treat the change as a no-op and the send button stays
   *     disabled. Going through the prototype's native setter and then dispatching
   *     `input` is what makes React see it.
   */
  const writeComposer = (element, text) => {
    if (!element) return false

    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      try {
        const value = normalizeLineEndings(text)
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
        element.focus()
        if (setter) setter.call(element, value)
        else element.value = value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        // DeepSeek may normalize line breaks or surrounding whitespace while its
        // controlled textarea handles the input event. Treat that normalization
        // the same way as the contenteditable path instead of reporting a false
        // insert failure after the text is visibly in the box.
        return composerMatches(element, value)
      } catch (_) {
        return false
      }
    }

    element.focus()
    // Select the whole draft so `insertText` REPLACES it rather than inserting at a caret whose
    // position we cannot control. See `selectAllIn`.
    selectAllIn(element)
    // Keep focus/selection honest so ProseMirror records a real edit.
    document.execCommand('insertText', false, text)
    return composerMatches(element, text)
  }

  const findSendButton = () => findComposerControl(PAGE.sendButtonSelectors)

  /**
   * Fallback for textarea-based composers whose send button has no stable selector.
   * Programmatic sends keep state.programmatic=true, so our own Enter interceptor lets
   * this synthetic event pass through without injecting the terminal prompt again.
   */
  const pressEnter = (element) => {
    if (!element) return
    const init = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }
    try {
      element.focus()
      element.dispatchEvent(new KeyboardEvent('keydown', init))
      element.dispatchEvent(new KeyboardEvent('keypress', init))
      element.dispatchEvent(new KeyboardEvent('keyup', init))
    } catch (_) {
      /* submitWithRetry verifies success by checking whether the composer cleared */
    }
  }

  const findStopButton = () => findComposerControl(PAGE.stopButtonSelectors)
  const replyIsGenerating = (node) => {
    if (findStopButton()) return true
    // Claude can keep its turn explicitly streaming after the toolbar stop
    // control disappears. A pause in thinking/searching is not a final answer.
    try { return !!(node && PAGE.replyStreamingAttribute && node.getAttribute(PAGE.replyStreamingAttribute) === 'true') }
    catch (_) { return false }
  }

  /* ------------------------------------------------------------------ *
   * Site-specific element lookup
   * ------------------------------------------------------------------ */

  /**
   * Every element matching any selector in a list, de-duplicated and in DOCUMENT ORDER.
   *
   * Lists overlap by design — a site may be matched by both a test id and a structural
   * selector — and a duplicated node would make the same turn look like two, which breaks
   * "the newest reply" and the once-per-message dedupe with it. Document order is
   * restored with `compareDocumentPosition` because concatenating per-selector results
   * would otherwise return them grouped by selector.
   */
  const queryAll = (selectors) => {
    const seen = new Set()
    const found = []
    for (const selector of selectors) {
      let matches = []
      try {
        matches = [...document.querySelectorAll(selector)]
      } catch (_) {
        continue
      }
      for (const element of matches) {
        if (seen.has(element)) continue
        seen.add(element)
        found.push(element)
      }
    }
    return found.sort((a, b) => {
      const relation = a.compareDocumentPosition(b)
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
  }

  const queryAllAssistant = () => queryAll(PAGE.assistantSelectors)
  const queryAllMessages = () => queryAll(PAGE.messageSelectors)

  // ChatGPT can keep hidden old turns after the active thread in document order.
  // Use the same candidates for scanning and baselines; visibility here does not
  // depend on whether a rendered turn is currently inside the scroll viewport.
  const replyCandidatesOf = (nodes) => {
    const candidates = PAGE.ignoreHiddenReplyNodes ? nodes.filter(isVisibleElement) : nodes
    return focusEditExcludedIds.size ? candidates.filter(node => !focusEditExcludedIds.has(messageIdOf(node))) : candidates
  }
  const latestReplyNode = (nodes) => {
    const candidates = replyCandidatesOf(nodes)
    // Keep the newest candidate even when it is empty or not yet marked as an
    // assistant. Searching backwards for a command would replay older replies.
    return candidates[candidates.length - 1] || null
  }

  /**
   * A stable id for one message, or null when the site has no such attribute.
   *
   * Used only to look for the attribute; `turnKeyOf` below is what callers should use,
   * because an empty answer here must never become an empty identity.
   */
  const messageIdOf = (node) => {
    if (!node || !PAGE.messageIdAttr) return null
    return node.getAttribute(PAGE.messageIdAttr) || null
  }

  const pageReplyAttrs = () => [...new Set([PAGE.messageIdAttr, PAGE.replyStreamingAttribute].filter(Boolean))]

  /**
   * Identity for one assistant turn — and it must NEVER be empty.
   *
   * A site that gives every turn a stable id (ChatGPT) is the easy case. A site that does
   * not would be unusable rather than merely less safe: the scan below bails out on an
   * empty id, so no command would ever be detected, and the main process keys executions
   * by this value, so an empty id would also collapse every command into a single row.
   *
   * So when there is no attribute, the turn is identified by its CONTENT. That is sound
   * here precisely because the scan only runs after the reply has been quiet for
   * `REPLY_SETTLE_MS`: the text is final by then, so re-rendering the same reply hashes
   * the same and stays suppressed, while a genuinely new reply differs and fires.
   *
   * The cost is real and worth stating: two byte-identical replies inside one conversation
   * become indistinguishable and the second is skipped. That needs the same command AND
   * the same description twice — and the alternative, an empty key, loses every command
   * after the first instead of one duplicate.
   */
  const turnKeyOf = (node) => {
    const attribute = messageIdOf(node)
    if (attribute) return attribute
    const text = String(node.innerText || '')
    if (text === '') return ''
    // djb2: tiny, synchronous, and stable across reloads — unlike a counter, which would
    // hand the same reply a new identity every time the page re-rendered.
    let hash = 5381
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
    }
    return `text:${(hash >>> 0).toString(16)}:${text.length}`
  }

  const userTurns = () => queryAllMessages().filter((node) => !isAssistantTurn(node))

  let focusSendRetry = null
  /** A rejection belongs to the newest user row, never to quoted code or an older turn. */
  const focusSendFailureOf = () => {
    const rules = PAGE.focus?.sendFailure
    if (!rules) return null
    const row = queryAllMessages().filter(isVisibleElement).at(-1)
    if (!row || isAssistantTurn(row)) return null
    const normalized = text => collapse(text).replace(/[，,。.!！]/g, '')
    const messages = rules.messages.map(normalized)
    const matches = element => messages.includes(normalized(element.innerText || ''))
    const errors = [...row.querySelectorAll('*')].filter(element => isVisibleElement(element) && matches(element) &&
      !element.closest('pre, code, a, .ds-markdown') && ![...element.children].some(matches))
    if (errors.length !== 1) return null
    const error = errors[0]
    const allControls = [...row.querySelectorAll(rules.controlSelector)].filter(element =>
      isVisibleElement(element) && !element.contains(error) && !element.closest('pre, code, a, .ds-markdown'))
    // A control's nested role/icon must not count as another candidate.
    const controls = allControls.filter(element => !allControls.some(other => other !== element && other.contains(element)))
    const named = controls.filter(element => rules.retryLabels.some(label =>
      [element.innerText, element.getAttribute('aria-label'), element.getAttribute('title')].some(text => collapse(text || '') === label)))
    // The observed retry icon precedes the error; copy/edit actions follow it.
    // Ambiguous rows stay readable but require checking the original view.
    const icons = controls.filter(element => !collapse(element.innerText || '') &&
      (element.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING))
    const button = named.length === 1 ? named[0] : named.length === 0 && icons.length === 1 ? icons[0] : null
    const position = row.getAttribute(PAGE.focus.rowPositionAttr || '') || ''
    return { row, button, data: {
      id: JSON.stringify([location.pathname, state.taskPromptGeneration, position, turnKeyOf(row)]),
      message: collapse(error.innerText).slice(0, 500),
      retryable: !!button && !controlDisabled(button)
    } }
  }
  const releaseFocusSendRetry = pending => {
    document.removeEventListener('click', pending.onClick, true)
    if (focusSendRetry !== pending) return
    focusSendRetry = null
    if (state.taskPromptGeneration === pending.generation) state.programmatic = false
  }

  /** Best-effort test for an image currently attached to the composer. */
  const hasDraftImageAttachment = () => {
    const fileInputs = [...document.querySelectorAll('input[type="file"]')]
    if (fileInputs.some((input) => [...(input.files || [])].some((file) => String(file.type || '').startsWith('image/')))) {
      return true
    }
    // Use the same bounded draft scope as upload readiness and raw-send guards.
    // An independent ancestor walk can escape into history or a collapsed sidebar.
    const root = attachmentRoot()
    return !!root && attachmentDraftImages(root, attachmentDraftCards(root)).length > 0
  }

  const beginUserImageCapture = () => {
    userImageCaptureSerial += 1
    const token = `img:${Date.now().toString(36)}:${userImageCaptureSerial.toString(36)}`
    const turns = hasNativeImageScope() ? fileUserTurns() : userTurns()
    const baselineImages = new Map(
      [...document.querySelectorAll('img')].map((image) => [image, imageSourceOf(image)])
    )
    // Snapshot the upload cache before submission. A paste for the NEXT message
    // must not be merged into this message while its image reads are pending.
    const filesPromise = lastDraftImagePromise
    const rememberedFiles = Date.now() - lastDraftImageCapturedAt <= 120_000
      ? filesPromise : Promise.resolve([])
    pendingUserImageCaptures.set(token, {
      baselineTurn: turns.length > 0 ? turns[turns.length - 1] : null,
      baselineImages,
      filesPromise,
      draftPromise: Promise.all([captureDraftImageAttachments(), rememberedFiles])
        .then((batches) => mergeImageAttachments(...batches))
    })
    return token
  }

  const discardUserImageCapture = (token) => {
    if (token) pendingUserImageCaptures.delete(token)
  }

  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('attachment read failed'))
    reader.onload = () => {
      const value = String(reader.result || '')
      const comma = value.indexOf(',')
      resolve(comma >= 0 ? value.slice(comma + 1) : '')
    }
    reader.readAsDataURL(blob)
  })

  const imageDataKey = async (base64) => {
    try {
      if (!globalThis.crypto?.subtle) return base64
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
      return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
    } catch (_) {
      return base64
    }
  }

  // Different capture paths can encode identical pixels as different PNG bytes.
  // Normalize only for de-duplication; the original bytes remain the persisted data.
  const canonicalImageKey = async (blob) => {
    try {
      if (typeof createImageBitmap !== 'function') return ''
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) {
        bitmap.close()
        return ''
      }
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const dataUrl = canvas.toDataURL('image/png')
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return ''
      return imageDataKey(dataUrl.slice(comma + 1))
    } catch (_) {
      return ''
    }
  }

  const imageSourceOf = (image) => {
    if (!image) return ''
    const direct = String(image.currentSrc || image.src || '').trim()
    if (direct) return direct
    for (const attribute of ['data-src', 'data-original', 'data-url']) {
      const value = String(image.getAttribute(attribute) || '').trim()
      if (value) return value
    }
    const srcset = String(image.getAttribute('srcset') || '').trim()
    return srcset ? srcset.split(',')[0].trim().split(/\s+/)[0] : ''
  }

  const imageLooksLikeAttachment = (image) => {
    const src = imageSourceOf(image)
    if (!src) return false
    // Local upload previews are usually blob URLs and can still report zero
    // natural dimensions while React is hydrating them.
    if (/^(?:blob:|data:image\/)/i.test(src)) return true
    const width = Number(image.naturalWidth || image.width || 0)
    const height = Number(image.naturalHeight || image.height || 0)
    return width >= 40 && height >= 40
  }

  const collectImages = (root) => {
    if (!root) return []
    const found = []
    if (root.tagName === 'IMG') found.push(root)
    found.push(...root.querySelectorAll('img'))
    return found
  }

  // Measured attachment markup is authoritative. Page-wide image discovery
  // would otherwise archive account avatars and decorative images as uploads.
  const hasNativeImageScope = () => !!(PAGE.fileDraftCardSelector || PAGE.fileAttachmentCardSelector ||
    PAGE.fileDraftImageSelector || PAGE.fileSentImageSelector)
  const sentImageCandidates = (turn) => {
    const root = fileAttachmentRoot(turn)
    if (!root) return []
    if (PAGE.fileSentImageSelector) return [...root.querySelectorAll(PAGE.fileSentImageSelector)]
    if (PAGE.fileAttachmentCardSelector) return [...root.querySelectorAll(PAGE.fileAttachmentCardSelector)].flatMap(collectImages)
    return collectImages(root)
  }

  const imageMimeType = (source) => {
    const value = String(source || '').toLowerCase()
    if (value.startsWith('data:image/')) {
      const match = /^data:([^;,]+)/i.exec(value)
      if (match) return match[1]
    }
    const extension = value.split(/[?#]/)[0].split('.').pop()
    return {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml'
    }[extension] || ''
  }

  const sourceFileNameForImage = (image) => {
    const alt = String(image.getAttribute('alt') || '').trim()
    if (alt && /\.[a-z0-9]{2,8}$/i.test(alt)) return alt
    try {
      const url = new URL(String(image.currentSrc || image.src || ''), location.href)
      const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '')
      if (last && /\.[a-z0-9]{2,8}$/i.test(last)) return last
    } catch (_) {
      /* fall through */
    }
    return ''
  }

  const fileNameForImage = (image, index, mimeType) => {
    const sourceName = sourceFileNameForImage(image)
    if (sourceName) return sourceName
    const ext = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
      'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
    }[mimeType] || 'img'
    return `image-${index + 1}.${ext}`
  }

  const fileNameForFile = (file, index, mimeType) => {
    const name = String(file?.name || '').trim()
    if (name) return name
    const ext = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
      'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
    }[mimeType] || 'img'
    return `image-${index + 1}.${ext}`
  }

  const readFileAttachment = async (file, index) => {
    const mimeType = String(file?.type || '').toLowerCase()
    if (!mimeType.startsWith('image/')) return null
    try {
      const dataBase64 = await blobToBase64(file)
      if (!dataBase64) return null
      return {
        sourceKind: 'file',
        fileName: fileNameForFile(file, index, mimeType),
        mimeType,
        dataBase64,
        width: null,
        height: null,
        sizeBytes: Number(file.size || 0),
        contentKey: (await canonicalImageKey(file)) || dataBase64
      }
    } catch (_) {
      return null
    }
  }

  const readImageAttachment = async (image, index) => {
    const source = imageSourceOf(image)
    if (!source) return null
    try {
      const response = await fetch(source, { credentials: 'include' })
      if (!response.ok) throw new Error(`image fetch failed: ${response.status}`)
      const blob = await response.blob()
      const mimeType = String(blob.type || imageMimeType(source)).toLowerCase()
      if (!mimeType.startsWith('image/')) return null
      const dataBase64 = await blobToBase64(blob)
      if (!dataBase64) return null
      return {
        sourceKind: 'preview',
        sourceFileName: sourceFileNameForImage(image),
        fileName: fileNameForImage(image, index, mimeType),
        mimeType,
        dataBase64,
        width: Number(image.naturalWidth || image.width || 0) || null,
        height: Number(image.naturalHeight || image.height || 0) || null,
        sizeBytes: Number(blob.size || 0),
        contentKey: (await canonicalImageKey(blob)) || dataBase64
      }
    } catch (_) {
      // A sent-turn image can be rendered from a browser blob or a URL that refuses
      // fetch(), even though the page has already decoded it for display. Reading the
      // decoded element through a canvas covers blob URLs and same-origin thumbnails.
      try {
        if (!image.complete || Number(image.naturalWidth || image.width || 0) <= 0) return null
        const width = Number(image.naturalWidth || image.width || 0)
        const height = Number(image.naturalHeight || image.height || 0)
        if (width <= 0 || height <= 0) return null
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) return null
        context.drawImage(image, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/png')
        const comma = dataUrl.indexOf(',')
        if (comma < 0) return null
        const dataBase64 = dataUrl.slice(comma + 1)
        if (!dataBase64) return null
        return {
          sourceKind: 'preview',
          sourceFileName: sourceFileNameForImage(image),
          fileName: fileNameForImage(image, index, 'image/png'),
          mimeType: 'image/png',
          dataBase64,
          width,
          height,
          sizeBytes: Math.floor(dataBase64.length * 0.75),
          contentKey: await imageDataKey(dataBase64)
        }
      } catch (_) {
        return null
      }
    }
  }

  const mergeImageAttachments = (...batches) => {
    const candidates = batches.flat().filter((attachment) => attachment?.dataBase64)
    const originals = []
    const previews = []
    const seen = new Set()
    // Prefer the uploaded bytes even when the DOM preview was read first.
    for (const attachment of [
      ...candidates.filter((item) => item.sourceKind === 'file'),
      ...candidates.filter((item) => item.sourceKind !== 'file')
    ]) {
      const key = attachment.contentKey || attachment.dataBase64
      if (seen.has(key)) continue
      seen.add(key)
      if (attachment.sourceKind === 'file') originals.push(attachment)
      else previews.push(attachment)
    }

    // ChatGPT can resize/re-encode an upload and rename its preview to name(1).jpg.
    // Pixel hashes then differ. Use the existing per-platform filename evidence
    // only for an unambiguous one-preview/one-original pair in this capture.
    // Never collapse two originals or guess from visual similarity: screenshots
    // with a small but meaningful difference must remain separate attachments.
    const matches = previews.map((preview) => preview.sourceFileName
      ? attachmentNameEvidence([preview.sourceFileName], originals)
        .filter((evidence) => evidence.method !== 'missing').map((evidence) => evidence.index)
      : [])
    const claims = new Map()
    for (const indices of matches) {
      for (const index of indices) claims.set(index, (claims.get(index) || 0) + 1)
    }
    return [...originals, ...previews.filter((_, index) =>
      matches[index].length !== 1 || claims.get(matches[index][0]) !== 1
    )]
  }

  const readImageCandidates = async (images, files = []) => {
    const attachments = []
    const seenSources = new Set()
    const seenData = new Set()
    for (const file of files) {
      const attachment = await readFileAttachment(file, attachments.length)
      const contentKey = attachment?.contentKey || attachment?.dataBase64
      if (!attachment || !contentKey || seenData.has(contentKey)) continue
      seenData.add(contentKey)
      attachments.push(attachment)
    }
    for (const image of images) {
      const source = imageSourceOf(image)
      if (!source || seenSources.has(source) || !imageLooksLikeAttachment(image)) continue
      seenSources.add(source)
      const attachment = await readImageAttachment(image, attachments.length)
      const contentKey = attachment?.contentKey || attachment?.dataBase64
      if (!attachment || !contentKey || seenData.has(contentKey)) continue
      seenData.add(contentKey)
      attachments.push(attachment)
    }
    return mergeImageAttachments(attachments)
  }

  const captureDraftImageAttachments = async () => {
    const files = [...document.querySelectorAll('input[type="file"]')]
      .flatMap((input) => [...(input.files || [])])
      .filter((file) => String(file.type || '').startsWith('image/'))
    const images = []
    const seen = new Set()
    const nativeScope = hasNativeImageScope()
    if (nativeScope) {
      const root = attachmentRoot()
      if (root) images.push(...attachmentDraftImages(root, attachmentDraftCards(root)))
    } else {
      let root = attachmentRoot() || getComposer()
      for (let depth = 0; depth < 8 && root && root !== document.body; depth += 1, root = root.parentElement) {
        if (attachmentHasMessages(root)) break
        if ((PAGE.conversationLinkSelectors || []).some((selector) => root.querySelector(selector))) break
        for (const image of collectImages(root)) {
          if (seen.has(image)) continue
          seen.add(image)
          if (imageLooksLikeAttachment(image)) images.push(image)
        }
      }
    }
    // Some ChatGPT builds render the upload preview in a portal that is not an
    // ancestor of the composer. A blob URL is still a strong attachment signal;
    // ordinary remote page images are deliberately not included by this fallback.
    if (!nativeScope && images.length === 0) {
      for (const image of document.querySelectorAll('img')) {
        if (seen.has(image)) continue
        if ([...PAGE.messageSelectors, ...PAGE.assistantReplySelectors,
          ...(PAGE.fileUserTurnSelector ? [PAGE.fileUserTurnSelector] : [])]
          .some((selector) => image.closest(selector))) continue
        if (/^blob:/i.test(imageSourceOf(image))) {
          seen.add(image)
          images.push(image)
        }
      }
    }
    if (files.length === 0 && images.length === 0) return []
    return readImageCandidates(images, files)
  }

  const rememberDraftFiles = (fileList) => {
    // Automatic read_files uploads are archived by main, never by the next human send.
    if (fileSend) return
    const files = [...(fileList || [])]
      .filter((file) => String(file?.type || '').toLowerCase().startsWith('image/'))
    if (files.length === 0) return
    // Do not await inside the DOM event handler. FileReader continues after the
    // page has finished dispatching the event, and the next send can use the cache.
    lastDraftImageCapturedAt = Date.now()
    lastDraftImagePromise = readImageCandidates([], files).catch(() => [])
  }

  // Cover the three browser paths used by ChatGPT's attachment picker. Capture phase
  // is intentional because the app may stop propagation before a bubbling listener sees
  // the file input or drop target.
  document.addEventListener('change', (event) => {
    const target = event.target
    if (target instanceof HTMLInputElement && target.type === 'file') {
      if (fileSend && event.isTrusted) {
        const picked = [...(target.files || [])]
        if (fileSend.selected || picked.length !== fileSend.files.length || picked.some((file, index) => file.name !== fileSend.files[index].fileName || file.size !== fileSend.files[index].sizeBytes)) fileSend.edited = true
      }
      rememberDraftFiles(target.files)
    }
  }, true)
  document.addEventListener('paste', (event) => {
    if (fileSend && event.isTrusted && event.clipboardData?.files?.length) fileSend.edited = true
    rememberDraftFiles(event.clipboardData?.files)
  }, true)
  document.addEventListener('drop', (event) => {
    if (fileSend && event.isTrusted && event.dataTransfer?.files?.length) fileSend.edited = true
    rememberDraftFiles(event.dataTransfer?.files)
  }, true)
  document.addEventListener('beforeinput', (event) => {
    const composer = getComposer()
    if (fileSend && event.isTrusted && composer && (event.target === composer || composer.contains(event.target))) fileSend.edited = true
  }, true)

  const takeUserImageAttachments = async (token) => {
    const capture = pendingUserImageCaptures.get(token)
    if (!capture) return []
    pendingUserImageCaptures.delete(token)

    // Read the file input/thumbnail captured before ChatGPT clears the composer.
    // This is the reliable path for local files and blob previews; waiting for
    // the sent turn alone loses both when the SPA replaces the composer.
    try {
      const draftAttachments = await Promise.race([
        capture.draftPromise || Promise.resolve([]),
        new Promise((resolve) => setTimeout(() => resolve([]), 2200))
      ])
      const mergedDraftAttachments = mergeImageAttachments(Array.isArray(draftAttachments) ? draftAttachments : [])
      if (lastDraftImagePromise === capture.filesPromise) {
        lastDraftImageCapturedAt = 0
        lastDraftImagePromise = Promise.resolve([])
      }
      if (mergedDraftAttachments.length > 0) {
        report({ event: 'user-image-capture', phase: 'draft', count: mergedDraftAttachments.length })
        return mergedDraftAttachments
      }
      report({ event: 'user-image-capture', phase: 'draft', count: 0 })
    } catch (_) {
      /* fall through to the sent-turn scan */
    }

    const deadline = Date.now() + 3000
    let turn = null
    let turnSeenAt = 0
    let images = []
    const nativeScope = hasNativeImageScope()
    const newImages = () => nativeScope ? [] : [...document.querySelectorAll('img')].filter((image) => {
      const previousSource = capture.baselineImages?.get(image)
      const source = imageSourceOf(image)
      return source !== '' && (previousSource === undefined || previousSource !== source) && imageLooksLikeAttachment(image)
    })
    while (Date.now() < deadline) {
      const turns = nativeScope ? fileUserTurns() : userTurns()
      const newest = turns.length > 0 ? turns[turns.length - 1] : null
      if (newest && newest !== capture.baselineTurn) {
        if (turn !== newest) {
          turn = newest
          turnSeenAt = Date.now()
        }
        images = (nativeScope ? sentImageCandidates(turn) : collectImages(turn)).filter((image) => imageLooksLikeAttachment(image))
        if (images.length > 0) break
        // Text-only sends should not make persistence wait the full timeout. Keep a
        // little longer than the old 700ms window because ChatGPT may append the
        // uploaded thumbnail after it has already inserted the text turn.
        if (Date.now() - turnSeenAt >= 1500) return []
      }
      images = newImages()
      if (images.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (images.length === 0) {
      report({ event: 'user-image-capture', phase: 'sent-turn', count: 0 })
      return []
    }
    const attachments = await readImageCandidates(images)
    report({ event: 'user-image-capture', phase: 'sent-turn', count: attachments.length })
    return attachments
  }
  /* ------------------------------------------------------------------ *
   * Keeping the newest message in view
   * ------------------------------------------------------------------ */

  /**
   * The thread's scroll container.
   *
   * ChatGPT's class names are hashed and change without notice, so this is found
   * by BEHAVIOUR rather than by selector: the nearest ancestor that actually
   * overflows vertically. Walking up from the newest turn is tried first because
   * it is cheap and lands on the right element; the full scan is only a fallback
   * for the case where that chain has nothing scrollable in it.
   */
  const findScroller = () => {
    const nodes = queryAllMessages()
    let element = nodes.length > 0 ? nodes[nodes.length - 1].parentElement : null

    while (element) {
      const style = getComputedStyle(element)
      const scrolls = /(auto|scroll)/.test(style.overflowY)
      if (scrolls && element.scrollHeight > element.clientHeight + 4) return element
      element = element.parentElement
    }

    let best = null
    const all = document.querySelectorAll('div')
    for (let i = 0; i < all.length; i += 1) {
      const candidate = all[i]
      if (candidate.scrollHeight <= candidate.clientHeight + 4) continue
      if (!/(auto|scroll)/.test(getComputedStyle(candidate).overflowY)) continue
      // `>=`, not `>`: querySelectorAll returns document order, so on a tie the
      // later element is the INNER one. Between a wrapper and the thread inside
      // it, the thread is the one whose bottom actually matters.
      if (best === null || candidate.scrollHeight >= best.scrollHeight) best = candidate
    }
    return best
  }

  /**
   * Put the newest message back in view.
   *
   * A programmatic send does not make ChatGPT scroll the way a real click does:
   * the message we just injected, and the reply that follows it, land below the
   * fold and the user has to scroll by hand every single time. Its own
   * "stick to the bottom" heuristic is what the synthetic editing pipeline
   * appears to disturb, so the position is set outright instead of being
   * requested.
   *
   * `behavior: 'instant'` is deliberate. The thread is styled with smooth
   * scrolling, and an animated scroll here competes with the re-render that
   * immediately follows the send — the animation is cancelled part-way and
   * settles short, which is the same symptom in a new costume.
   */
  const scrollToBottom = () => {
    const target = findScroller()
    if (!target) return false
    const top = target.scrollHeight
    try {
      target.scrollTo({ top: top, behavior: 'instant' })
    } catch (_) {
      target.scrollTop = top
    }
    return true
  }

  /**
   * Re-assert the position for a moment after a send.
   *
   * The thread keeps growing as the new turn renders and again when the reply
   * starts, so a single scroll lands short. The window is short and fixed rather
   * than running until the reply finishes: past that point the user may be
   * reading something further up, and dragging them back would be worse than the
   * problem being fixed.
   */
  const SCROLL_SETTLE_MS = [0, 120, 350, 700, 1200]

  const scheduleScrollToBottom = () => {
    for (const delay of SCROLL_SETTLE_MS) {
      if (delay === 0) scrollToBottom()
      else setTimeout(scrollToBottom, delay)
    }
  }

  /* ------------------------------------------------------------------ *
   * Composer plumbing
   * ------------------------------------------------------------------ */

  /** Every human turn carries the reply contract; task/environment plans still send once. */
  const userPromptInjection = (conversationPromptInjected = false) => {
    const active = state.enabled && state.promptInjectionEnabled
    const promptInjected = active && !state.taskPromptInjected && !conversationPromptInjected
    const prefix = active ? (promptInjected ? state.prefix : state.replyProtocolPrefix) : ''
    const full = promptInjected && state.prefixIncludesReplyProtocol
    // Snapshot the counts configured WITH this exact prefix. A send can outlive a
    // reconfiguration; its acknowledgement must not estimate the next task's prompt.
    const usage = promptInjected ? state.contextPrefixUsage : state.contextReminderUsage
    return { prefix, metadata: { promptInjected, ...(prefix && state.replyProtocolVersion ? {
      replyProtocolVersion: state.replyProtocolVersion,
      replyProtocolKind: full ? 'full' : 'short',
      replyProtocolLength: full ? state.replyProtocolFullLength : state.replyProtocolPrefix.length
    } : {}), ...(prefix && usage ? { contextUsage: { ...usage, id: Date.now().toString(36) + ':' + Math.random().toString(36).slice(2) } } : {}) } }
  }

  const reportUserInjection = (injection, generation = state.taskPromptGeneration) => {
    if (!injection.prefix) return
    state.injectedCount++
    report({ event: 'injected', count: state.injectedCount, prefixLength: injection.prefix.length,
      taskPromptGeneration: generation, ...injection.metadata })
  }

  /**
   * Select everything in the composer, so the next write REPLACES it.
   *
   * This used to collapse the selection to the start, on the assumption that
   * `execCommand('insertText')` would then insert there. It does not: in a ProseMirror
   * contenteditable the text landed at the END, after whatever the user had typed — observed as
   * "the prompt appears after my sentence". `hasPrefix()` then failed (the prompt was not at the
   * front), so the next keystroke composed again and appended a second copy, and the send never
   * went out.
   *
   * Selecting all removes the dependency on caret placement entirely: the composed string
   * already contains both the prompt and the user's text, so replacing the contents with it is
   * the correct operation no matter where the caret happened to be. It also makes the
   * contenteditable path mean the same thing as the textarea path, which has always been a
   * whole-value replace — one behaviour instead of two.
   */
  const selectAllIn = (element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const insertText = (element, text) => writeComposer(element, text)

  const controlDisabled = (el) =>
    el.disabled === true || el.getAttribute('aria-disabled') === 'true' ||
    (PAGE.disabledControlSelectors || []).some((selector) => el.matches(selector))

  /**
   * The composer's own toolbar controls — the first ancestor holding more than one button.
   *
   * The SAME traversal as `tools/diag/chatgpt-dom-probe.js` uses for its
   * `composer toolbar buttons` section, deliberately: that section is what identified this
   * neighbourhood before, and a report from a real failure should be readable beside it.
   */
  /**
   * Everything that can act as a control.
   *
   * ONE definition, used for BOTH the walk up and the collection. They used to disagree — the
   * walk stopped at the first ancestor holding two `<button>`s while the collection also took
   * `[role="button"]` — and that is why the DeepSeek snapshot was useless: on that site the
   * composer's controls are all `<div role="button">`, so the walk never stopped near the
   * composer at all. It climbed to the first ancestor with real buttons and returned a slice of
   * the page: twelve feature chips, no primary action, exactly where the answer should have been.
   */
  const CONTROL_SELECTOR = 'button, [role="button"]'

  const composerToolbarRoot = () => {
    const element = getComposer()
    if (!element) return null
    let node = element
    let hops = 0
    while (node && node !== document.body && hops < 10) {
      if ([...node.querySelectorAll(CONTROL_SELECTOR)].filter(isVisibleElement).length >= 2) break
      node = node.parentElement
      hops += 1
    }
    if (!node || node === document.body || hops >= 10) return null
    return node
  }

  const composerToolbarControls = () => {
    const root = composerToolbarRoot()
    return root ? [...root.querySelectorAll(CONTROL_SELECTOR)].filter(isVisibleElement) : []
  }

  const focusModelPickerParts = () => {
    const rules = PAGE.focus?.modelSettings
    if (!rules) return null
    const triggers = queryAll([rules.triggerSelector]).filter(isVisibleElement)
    if (triggers.length !== 1) return null
    const trigger = triggers[0], id = trigger.getAttribute('aria-controls')
    const candidate = id ? document.getElementById(id) : null
    const menu = candidate?.getAttribute('role') === 'menu' && isVisibleElement(candidate) && trigger.id &&
      (candidate.getAttribute('aria-labelledby') || '').split(/\s+/).includes(trigger.id) &&
      trigger.getAttribute('aria-expanded') === 'true' ? candidate : null
    return { trigger, menu, rules }
  }
  /** Passive between explicit refreshes; never opens a menu from the polling loop. */
  const focusModelSettingsOf = () => {
    const rules = PAGE.focus?.modelSettings
    if (!rules) { focusModelCache = null; return { model: null, effort: null, models: [], efforts: [] } }
    // A home send may pass through an interim /c/<id> before its final route.
    // Carry the confirmed selection through that send's generation, not just
    // the first hop. Explicit history navigation clears this in armBaseline.
    const sending = state.programmatic || state.awaitingReplySince !== 0 || fileSend?.submitted
    const firstSend = focusModelCache &&
      (focusModelCache.path === rules.newChatPath || focusModelCache.firstSendGeneration === state.taskPromptGeneration) && sending &&
      new RegExp(rules.conversationPathPattern).test(location.pathname)
    if (!focusModelCache || (focusModelCache.path !== location.pathname && !firstSend)) {
      focusModelCache = { path: location.pathname, data: { model: null, effort: null, models: [], efforts: [] } }
    }
    if (firstSend && focusModelCache.path !== location.pathname) focusModelCache.firstSendGeneration = state.taskPromptGeneration
    if (!sending || focusModelCache.firstSendGeneration !== state.taskPromptGeneration) delete focusModelCache.firstSendGeneration
    focusModelCache.path = location.pathname
    const data = focusModelCache.data
    // React can replace or briefly remove the trigger while sending. A missing
    // DOM node is not evidence that the confirmed selection changed.
    const parts = focusModelPickerParts()
    if (!parts) return { ...data, models: data.models.slice(), efforts: data.efforts.slice() }
    const { trigger, menu } = parts
    if (menu) {
      // Both tracks stay mounted. The inactive model track is aria-hidden, but
      // its radio selection is authoritative and lets reads avoid changing views.
      const items = [...menu.querySelectorAll(rules.modelSelector)].map(node => ({
        value: collapse(node.textContent || ''), checked: node.getAttribute('aria-checked')
      })).filter(item => /^GPT[- ]?\d[A-Za-z0-9 ._()+:/-]{0,75}$/.test(item.value))
      if (items.length && items.length <= 20 && new Set(items.map(item => item.value)).size === items.length) {
        data.models = items.map(item => ({ value: item.value, label: item.value }))
        const selected = items.filter(item => item.checked === 'true')
        data.model = selected.length === 1 ? selected[0].value : null
      } else { data.models = []; data.model = null }
      const slider = menu.querySelector(rules.sliderSelector), input = slider?.querySelector('[role="slider"]')
      data.efforts = input?.getAttribute('aria-valuemin') === '0' && input.getAttribute('aria-valuemax') === '2' &&
        !controlDisabled(slider) && slider.querySelector('[aria-disabled="true"], [data-locked="true"]') === null
        ? rules.efforts.map(({ value, label }) => ({ value, label })) : []
    }
    const effort = trigger.getAttribute(rules.effortAttribute)
    if (effort !== null || menu) data.effort = data.efforts.some(item => item.value === effort) ? effort : null
    return { ...data, models: data.models.slice(), efforts: data.efforts.slice() }
  }

  const focusComposerModeControls = () => {
    const rules = PAGE.focus?.composerModes || []
    if (!rules.length) return []
    const selector = PAGE.focus.composerModeControlSelector || CONTROL_SELECTOR
    let node = getComposer()?.parentElement, partial = []
    for (let depth = 0; node && node !== document.body && depth < 10; depth++, node = node.parentElement) {
      const controls = [...node.querySelectorAll(selector)].filter(isVisibleElement)
      const found = rules.filter(rule => controls.some(control => rule.labels.includes(collapse(control.textContent))))
      // The inner footer can contain attachment/send only. Keep walking until the
      // named mode switches are actually present, not just any two buttons.
      if (found.length === rules.length) return controls
      if (!partial.length && found.length) partial = controls
    }
    return partial
  }

  /** Read only the two named switches inside the current composer's input region. */
  const focusComposerModesOf = () => {
    const controls = focusComposerModeControls()
    return (PAGE.focus?.composerModes || []).map(rule => {
      const matches = controls.filter(control => rule.labels.includes(collapse(control.textContent)))
      const control = matches.length === 1 ? matches[0] : null
      let active = null
      if (control) {
        for (const attribute of ['aria-pressed', 'aria-checked', 'aria-selected', 'data-state', 'data-selected', 'data-checked']) {
          const value = control.getAttribute(attribute)
          if (['true', 'on', 'checked', 'active', 'selected'].includes(value)) { active = true; break }
          if (['false', 'off', 'unchecked', 'inactive', 'unselected'].includes(value)) { active = false; break }
        }
        if (active === null && rule.activeSelector && rule.inactiveSelector) {
          const on = control.matches(rule.activeSelector), off = control.matches(rule.inactiveSelector)
          if (on !== off) active = on
        }
      }
      return { control, data: { id: rule.id, active, disabled: !control || active === null || controlDisabled(control) } }
    })
  }

  const findComposerControl = (selectors) => {
    // After returning home ChatGPT can retain an older disabled send button.
    // The user's 2026-10-06 failure found that button while the active toolbar's
    // send button was enabled. The current composer scope is authoritative,
    // including when its own send button is disabled or temporarily absent.
    const root = composerToolbarRoot()
    return queryFirstVisible(selectors, root || document)
  }

  const describeControl = (el) => ({
    tag: el.tagName.toLowerCase(),
    /*
     * `role` matters, and its absence made the first DeepSeek report unreadable: that site's
     * composer controls are all `<div role="button">`, so a snapshot that named only the tag
     * made twelve working controls look like decoration.
     */
    role: el.getAttribute('role') || '',
    testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
    aria: el.getAttribute('aria-label') || '',
    disabled: controlDisabled(el),
    /*
     * Visible text. On DeepSeek this is the ONLY thing that tells one control from another:
     * all twelve carry no aria label at all, and their class lists differ only in a modifier
     * that was being cut off.
     */
    text: collapse(el.innerText || '').slice(0, 24),
    /*
     * 200, not 90. At 90 the twelve DeepSeek controls came back indistinguishable — which is
     * precisely the information the snapshot exists to carry.
     */
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 200)
  })

  /**
   * The composer toolbar as a report payload: how many controls there are, and what they are.
   *
   * BOTH ENDS, not the first N. The control that matters is the composer's primary action — the
   * send button, or the stop button while a reply is streaming — and it sits at the END of the
   * row. The walk up to the first ancestor holding more than one button can overshoot on a site
   * whose composer is nested inside a panel full of chips, which is what DeepSeek does: its
   * snapshot came back as twelve feature buttons and no primary action at all, truncated exactly
   * where the answer would have been. `toolbarCount` says when the two windows left a gap.
   */
  const toolbarSnapshot = () => {
    const controls = composerToolbarControls()
    const seen = new Set()
    const picked = []
    for (const el of [...controls.slice(0, 8), ...controls.slice(-16)]) {
      if (seen.has(el)) continue
      seen.add(el)
      picked.push(el)
    }
    return { toolbarCount: controls.length, toolbar: picked.map(describeControl) }
  }

  /**
   * Everything that could explain "the text went in and the send never happened".
   *
   * Reported when a send is finally given up on. The alternative is what this cost the last
   * time: the app said only `stuck`, while the interceptor had already seen which of half a
   * dozen things was on screen and threw all of it away. The main process prints this with
   * `console.warn`, which `DSH_APP_LOG=1` mirrors into `<userData>/logs/`, so a failure
   * leaves something readable behind instead of a dead end.
   *
   * The toolbar inventory is the part that matters. It is the probe's own traversal, so a
   * failure NAMES the button the app failed to click — the replacement selector can then be
   * written from the report rather than guessed at.
   */
  const diagnoseSendFailure = (attempts, recoveryTried) => {
    const element = getComposer()
    const button = findSendButton()
    return {
      attempts,
      recoveryTried,
      composerKind: element ? element.tagName.toLowerCase() : null,
      composerTextLength: readComposer(element).length,
      composerLeft: collapse(readComposer(element)).slice(0, 80),
      sendButtonFound: button !== null,
      sendButtonDisabled: button ? controlDisabled(button) : null,
      sendButtonVisible: !!button && isVisibleElement(button),
      sendButtonInComposer: !!button && !!composerToolbarRoot()?.contains(button),
      sendButton: button ? describeControl(button) : null,
      stopButtonFound: findStopButton() !== null,
      ...toolbarSnapshot()
    }
  }

  /**
   * Actions tried, IN ORDER, once the selector-matched button cannot be used at all.
   *
   * INSURANCE, not the normal path.
   *
   * `sendButtonSelectors` currently match. Clicking the send button and pressing Enter both
   * still prepend the system prompt (user-tested, both routes), and a click can only reach
   * `intercept()` through the interceptor that matches on that list — so on today's page the
   * first branch of `submitWithRetry` wins and none of this runs.
   *
   * It exists because the same class of change has already happened TWICE in one generation:
   * `#prompt-textarea` and `[data-message-author-role]` both went to zero matches and the
   * automation died silently. When a send-button selector goes the same way, "the button was
   * not found" ends the send OUTRIGHT — the result sits in the composer and every later round
   * of the loop is lost with it, which is not a degradation worth accepting when a structural
   * click costs one line.
   *
   * Both are heuristics, and both are safe to be wrong: the caller verifies by watching the
   * composer CLEAR, so an action that does nothing costs one pass and the next one runs.
   *
   *   - `toolbar-last` — the last enabled control in the composer's toolbar. On ChatGPT that
   *     row is [attach][model][dictation][primary], and the primary slot holds the send button
   *     whenever there is something to send. Structural: needs no label, no test id, and no
   *     stable class name.
   *   - `enter` — how a real user sends, and the one path that needs no element at all.
   */
  const RECOVERY_ACTIONS = ['toolbar-last', 'enter']

  /** The last ENABLED control in the composer toolbar — ChatGPT's primary action slot. */
  const lastToolbarControl = () => {
    const controls = composerToolbarControls()
    for (let i = controls.length - 1; i >= 0; i -= 1) {
      if (!controlDisabled(controls[i])) return controls[i]
    }
    return null
  }

  const runRecovery = (action, element) => {
    if (action === 'enter') {
      pressEnter(element)
      return
    }
    /*
     * Only click when our text is STILL in the box.
     *
     * The primary slot only holds the send button while there is something to send. With an
     * empty composer ChatGPT puts the VOICE button there, and clicking that would start
     * dictation on the user's machine as a side effect of a failed send. If the text is gone
     * the send is already lost, so Enter — which does nothing at all in that state — is the
     * only safe move.
     */
    if (collapse(readComposer(element)) === '') {
      pressEnter(element)
      return
    }
    /*
     * Never click the primary slot while a reply is still generating: in that state the slot
     * holds the STOP button, and the one outcome worse than a result that does not send is a
     * result that silently cancels the model's answer on its way past.
     */
    if (findStopButton()) {
      pressEnter(element)
      return
    }
    const candidate = lastToolbarControl()
    if (candidate) pressButton(candidate)
    else pressEnter(element)
  }

  /**
   * Clicking send is NOT proof that the message went out. ChatGPT ignores the
   * click while it is still finishing the previous turn, and the text then just
   * sits in the composer looking sent. The only trustworthy signal is that the
   * composer actually cleared — so verify, and retry until it does.
   *
   * `done` is only supplied for programmatic sends, so the caller can report the
   * real outcome instead of assuming success.
   */
  const submitWithRetry = (
    text,
    attempt,
    isRaw,
    done,
    deadline = 0,
    recovery = 0,
    graceUntil = 0,
    attachmentToken = null,
    sendContext = { taskPromptGeneration: state.taskPromptGeneration, promptInjected: false }
  ) => {
    /** Which recovery action THIS pass used, so the report can name it. */
    let recoveryTried = null
    if (!isRaw && sendContext.question === undefined) sendContext.question = state.pendingQuestion
      ? { messageId: state.pendingQuestion.messageId, source: state.pendingQuestion.taskSource || null } : null
    if (PAGE.computerUseRequests === true && !sendContext.computerBaseline) sendContext.computerBaseline = computerBaselineOf()

    // Capture the newest assistant turn BEFORE clicking Send. ChatGPT can create
    // the placeholder for the NEW assistant turn synchronously (or within the
    // 150ms confirmation delay below). Reading lastAssistantId() only after the
    // composer clears can therefore mark the fresh reply as already handled and
    // make every later MutationObserver scan skip its command forever.
    const replyBaselineId = lastAssistantId()
    const focusBaselineNode = latestReplyNode(queryAllAssistant().filter(node => isAssistantTurn(node)))
    const replyBaselinePosition = focusRowPosition(focusBaselineNode)

    const finish = (ok) => {
      if (sendContext.taskPromptGeneration !== state.taskPromptGeneration ||
          sendContext.scope?.cancelled === true ||
          (sendContext.computerResultToken !== undefined && sendContext.computerResultToken !== computerResultToken) ||
          (sendContext.path !== undefined && sendContext.path !== location.pathname)) {
        discardUserImageCapture(attachmentToken)
        if (!sendContext.scope?.cancelled && sendContext.taskPromptGeneration === state.taskPromptGeneration &&
            (sendContext.computerResultToken === undefined || sendContext.computerResultToken === computerResultToken)) state.programmatic = false
        if (done) done(sendContext.scope?.cancelled && !sendContext.scope.attempted ? 'cancelled' : 'stuck')
        return
      }
      const clarification = !isRaw && sendContext.question !== null
      state.programmatic = false
      if (ok) {
        focusReplyBaseline = replyBaselineId
        focusBaselinePosition = replyBaselinePosition
        focusReplyPosition = null
        state.replyActionDetected = false
        if (!isRaw) {
          if (sendContext.promptInjected) state.taskPromptInjected = true
          draftRejected = false
          state.failedCommand = null
          state.commandRecoveryUsed = false
        }
        // Once a message actually goes out, the next assistant turn is ours.
        setReplyWaiting(Date.now(), isRaw ? 'result-sent' : 'user-sent', null, sendContext.computerBaseline)
        state.taskActive = true
        // Ignore only the assistant turn that existed BEFORE this send. Never
        // baseline the new placeholder/reply that may already have appeared.
        state.lastCommandMessageId = replyBaselineId
        if (state.pendingQuestion && (!sendContext.question || state.pendingQuestion.messageId === sendContext.question.messageId)) {
          report({ event: 'question-cleared', messageId: state.pendingQuestion.messageId })
          state.pendingQuestion = null
          state.answerDraft = null
        }
        // The send landed, so the new turn is about to render below the fold.
        scheduleScrollToBottom()
      }
      if (ok && !isRaw) report({ event: 'user-message', text: userTextOf(text), attachmentToken: attachmentToken || undefined,
        ...(sendContext.scheduledRunId ? { scheduledRunId: sendContext.scheduledRunId, submissionId: 'user:scheduled:' + sendContext.scheduledRunId } : {}),
        submissionKind: clarification ? 'clarification' : 'goal', ...(clarification ? {
          answeredQuestionId: sendContext.question.messageId, questionSource: sendContext.question.source,
          taskPromptGeneration: sendContext.taskPromptGeneration } : {}) })
      if (!ok) discardUserImageCapture(attachmentToken)
      report(
        ok
          ? isRaw
            ? { event: 'sent-raw', text: text.slice(0, 200), textLength: text.length }
            : {
                event: 'sent', text: userTextOf(text).slice(0, 400),
                promptInjected: sendContext.promptInjected,
                replyProtocolVersion: sendContext.replyProtocolVersion,
                replyProtocolKind: sendContext.replyProtocolKind,
                replyProtocolLength: sendContext.replyProtocolLength,
                contextUsage: sendContext.contextUsage,
                conversationPromptInjected: sendContext.conversationPromptInjected === true,
                taskPromptGeneration: sendContext.taskPromptGeneration
              }
          : {
              event: 'send-failed',
              text: text.slice(0, 200),
              ...diagnoseSendFailure(attempt, recoveryTried)
            }
      )
      if (done) done(ok ? 'ok' : 'stuck')
    }

    // A task may end during the initial send delay, retry wait or confirmation poll.
    // Its old submission must never click Send or re-open the task afterwards.
    if (sendContext.taskPromptGeneration !== state.taskPromptGeneration ||
        sendContext.scope?.cancelled === true ||
        (sendContext.computerResultToken !== undefined && sendContext.computerResultToken !== computerResultToken) ||
        (sendContext.path !== undefined && sendContext.path !== location.pathname)) {
      finish(false)
      return
    }

    const button = findSendButton()
    const element = getComposer()
    const generating = findStopButton() !== null
    // A textarea site has no send-button selector worth trusting, so Enter is its real
    // submit path rather than a fallback — which is why this one is not gated on anything.
    const textControl =
      element !== null && (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')

    /*
     * TWO DIFFERENT INSTANTS, and conflating them is what made this feel slow.
     *
     *   - `graceUntil` — stop WAITING for the selector-matched button to render. Short.
     *   - `deadline`   — stop trying altogether. The ceiling for the whole send.
     *
     * The fallback used to hang off `deadline`, so on the command-result path the text sat in
     * the composer for the entire retry budget (~5s) before anything was clicked — reported as
     * "内容已经在框中好一会了，才发送出去". It was self-inflicted: the wait bought nothing,
     * because the selector it was waiting for was never going to match.
     *
     * The guard below is a TOTAL budget, and it is safe to enforce it here now that the
     * fallback no longer depends on reaching it. It could not be before: with the fallback
     * gated on "out of retries", a guard at the top fired at the same instant and made every
     * late branch unreachable, which is how a result got written into the composer and never
     * submitted at all.
     */
    if (Date.now() >= deadline) {
      finish(false)
      return
    }

    const fallbackDue =
      recovery < RECOVERY_ACTIONS.length && element !== null && Date.now() >= graceUntil

    if (button && !generating && !controlDisabled(button)) {
      if (sendContext.scope) sendContext.scope.attempted = true
      pressButton(button)
    } else if (button === null && !generating && textControl) {
      if (sendContext.scope) sendContext.scope.attempted = true
      pressEnter(element)
    } else if (button === null && !generating && fallbackDue) {
      /*
       * The selector never matched and the grace period is over — go structural NOW.
       *
       * ONE recovery action per pass, never two back to back: running them together would
       * risk sending the same text twice, because a click that clears the composer and a
       * synthetic Enter in the same tick can both be accepted by the page. The poll below
       * decides whether the next action is needed at all.
       *
       * Only for `button === null`, deliberately. A button that IS found but disabled means the
       * page is refusing to send — usually because it is still generating — and clicking the
       * primary slot in that state risks hitting Stop and cancelling the reply.
       */
      recoveryTried = RECOVERY_ACTIONS[recovery]
      /*
       * The full diagnosis rides along here, not only on `send-failed`.
       *
       * A run where every send succeeds THROUGH the recovery never reports `send-failed`, so
       * the one report carrying a toolbar snapshot never fired — and "which button is the send
       * button?" stayed unanswered while the app appeared to work. That is exactly what the
       * last session's log showed: six `send-recovery action=toolbar-last` lines and not one
       * snapshot of the toolbar that made them necessary.
       */
      report({
        event: 'send-recovery',
        action: recoveryTried,
        attempt,
        ...diagnoseSendFailure(attempt, recoveryTried)
      })
      if (sendContext.scope) sendContext.scope.attempted = true
      runRecovery(recoveryTried, element)
    } else {
      // The send button only enables once the editor has committed the edit, and it can
      // disappear entirely while a reply is streaming. Both are worth waiting out.
      setTimeout(
        () => submitWithRetry(text, attempt + 1, isRaw, done, deadline, recovery, graceUntil, attachmentToken, sendContext),
        80
      )
      return
    }

    /*
     * Poll for the composer to clear instead of sampling it once at +150ms — see
     * SEND_CONFIRM_TIMEOUT_MS for the failure that came out of the single sample.
     */
    const confirmStartedAt = Date.now()
    const confirm = () => {
      if (sendContext.taskPromptGeneration !== state.taskPromptGeneration ||
          sendContext.scope?.cancelled === true ||
          (sendContext.computerResultToken !== undefined && sendContext.computerResultToken !== computerResultToken) ||
          (sendContext.path !== undefined && sendContext.path !== location.pathname)) {
        finish(false)
        return
      }
      const box = getComposer()
      if (!box || collapse(readComposer(box)) === '') {
        finish(true)
        return
      }
      if (Date.now() - confirmStartedAt < SEND_CONFIRM_TIMEOUT_MS) {
        setTimeout(confirm, SEND_CONFIRM_POLL_MS)
        return
      }
      /*
       * The window closed with the text still in the box, so whatever this pass did, it did not
       * take.
       *
       * If this pass ran a recovery action, the measured route is already abandoned: step to
       * the NEXT action, and only give up once there is none left. Anything else would re-run
       * the same action forever, since the condition that chose it (`fallbackDue`) stays true.
       */
      if (recoveryTried !== null) {
        if (recovery + 1 < RECOVERY_ACTIONS.length) {
          submitWithRetry(text, attempt, isRaw, done, deadline, recovery + 1, graceUntil, attachmentToken, sendContext)
        } else {
          finish(false)
        }
        return
      }
      if (Date.now() < deadline) {
        submitWithRetry(text, attempt + 1, isRaw, done, deadline, recovery, graceUntil, attachmentToken, sendContext)
        return
      }
      finish(false)
    }
    setTimeout(confirm, SEND_CONFIRM_POLL_MS)
  }

  /**
   * Press a control the way a user would, whichever kind of element it is.
   *
   * `.click()` is enough for a real `<button>` (ChatGPT). DeepSeek's send control is a
   * `<div role="button">` owned by a component library, and those frequently act on
   * pointerdown/pointerup rather than on `click` — in which case `.click()` does nothing
   * at all and the send silently never happens.
   *
   * So the full sequence is dispatched, and the caller still verifies by watching the
   * composer clear. The verification is what makes this safe: a duplicate dispatch that the
   * framework ignores is harmless, while a missing one is the difference between working
   * and not.
   */
  const pressButton = (element) => {
    if (!element) return
    const base = { bubbles: true, cancelable: true, view: window }
    try {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function'
          ? PointerEvent
          : MouseEvent
        element.dispatchEvent(new Ctor(type, { ...base, button: 0, buttons: 1 }))
      }
      if (typeof element.click === 'function') element.click()
      else element.dispatchEvent(new MouseEvent('click', base))
    } catch (_) {
      /* the composer check below is the real verdict */
    }
  }

  /** @returns true when the event was consumed and the send was taken over. */
  /**
   * Marks where the injected prompt ends and the user's own words begin.
   *
   * A splitter that instead guessed the boundary from the prompt's LAST 【…】 section
   * looked reasonable and was wrong in three ways, all caught by tests: a greedy match
   * swallowed the prompt's tail, a user message containing its own 【…】 (for example
   * 「把【已完成】加到文档里」) was cut in half, and a message with no 【 at all could not
   * be split. The boundary is only knowable where the text is COMPOSED, so it is recorded
   * there rather than re-derived later.
   *
   * Use default-ignorable Unicode separators. The former NUL/SOH pair rendered as two
   * missing-glyph squares in the original page; readers still accept it for old messages.
   */
  const USER_TEXT_SENTINEL = '\u2063\u2063'

  /**
   * True once composing this draft has failed.
   *
   * Cleared on the next successful injection. Without it, an injection that cannot take
   * (a composer whose write path this site does not accept) is retried on every keystroke:
   * the reported counter climbs into the thousands, the composer appears to be "constantly
   * injected", and the user's own message never leaves.
   */
  let draftRejected = false

  /**
   * Recover what the USER typed from the text that was actually submitted.
   *
   * `submitWithRetry` is handed the composed string — the injected system prompt with
   * the user's words appended after the sentinel — and that composed string is what must
   * go to ChatGPT. Everything downstream that means "what the user asked for" (the goal
   * shown in the UI) needs the user's part only: reporting the whole prompt would put the
   * entire system prompt on screen.
   *
   * Falls back to the full text when no sentinel is present, which is the honest answer
   * for a message that carried no prompt (terminal mode off) or an empty submit.
   */
  const userTextOf = (composed) => {
    const text = String(composed || '')
    const at = Math.max(text.lastIndexOf(USER_TEXT_SENTINEL), text.lastIndexOf('\u0000\u0001'))
    if (at === -1) return text
    return text.slice(at + USER_TEXT_SENTINEL.length)
  }

  // Older conversations may predate the persisted injection flag. Read only user
  // turns, requiring both the system protocol and tool declarations as evidence.
  const conversationPromptInHistory = () => userTurns().some(node => {
    const text = node.textContent || node.innerText || ''
    return text.includes('【角色】') && (text.includes('终端助手') || text.includes('【任务完成】')) && text.includes('【工作协议】') &&
      text.includes('【执行环境】') && (text.includes('【工具：') || text.includes('【工具目录】'))
  })

  /** Forward one explicit focus action to the live native component, once. */
  const actOnSmartUi = async (request, expectedPath, diagnostic = {}) => {
    diagnostic.stage = 'prepare'
    diagnostic.submitted = false
    const finish = (outcome, reason) => { diagnostic.reason = reason; return outcome }
    const rules = PAGE.focus?.smartUi
    if (!rules || !request || !['choose', 'submit'].includes(request.kind) ||
      !Number.isSafeInteger(request.index) || request.index < 0 || request.index >= 8 ||
      typeof request.sourceMessageId !== 'string' || typeof request.signature !== 'string' || !request.token) return finish('invalid', 'invalid-request')
    if (location.pathname !== expectedPath) return finish('unavailable', 'conversation-changed')
    if (focusEditing) return finish('busy', 'edit-in-progress')
    if (state.programmatic) return finish('busy', 'programmatic-send')
    if (fileSend) return finish('busy', 'file-send')
    if (state.awaitingReplySince) return finish('busy', 'awaiting-reply')
    if (state.pendingQuestion) return finish('busy', 'question-pending')
    if (findStopButton()) return finish('busy', 'model-generating')
    const composer = getComposer()
    if (!composer) return finish('no-composer', 'no-composer')
    if (collapse(readComposer(composer))) return finish('busy', 'text-draft')
    if (draftAttachmentEvidence(attachmentSnapshot())) return finish('busy', 'attachment-draft')
    if (hasDraftImageAttachment()) return finish('busy', 'image-draft')
    if (PAGE.focus.edit && queryAll([PAGE.focus.edit.editorSelector]).some(isVisibleElement)) return finish('busy', 'history-edit-draft')
    diagnostic.stage = 'locate'
    const locate = () => {
      const nodes = queryAllAssistant().filter(node => messageIdOf(node) === request.sourceMessageId && isVisibleElement(node))
      if (nodes.length !== 1) return null
      return smartUiCardsOf(nodes[0]).find(card => card.data.index === request.index && card.data.signature === request.signature && isVisibleElement(card.element)) || null
    }
    let card = locate()
    if (!card || card.data.disabled) return finish('unavailable', card ? 'component-disabled' : 'component-missing')
    const token = { token: request.token, generation: state.taskPromptGeneration, submitted: false }
    const current = () => focusEditing === token && location.pathname === expectedPath && state.taskPromptGeneration === token.generation
    const pause = () => new Promise(resolve => setTimeout(resolve, 60))
    let confirmed = false
    focusEditing = token
    state.programmatic = true
    const clickControl = () => {
      const live = locate()
      if (!live || live.data.disabled) return null
      if (request.kind === 'choose') {
        const index = live.data.options.findIndex(option => option.value === request.optionValue && !option.disabled)
        return index < 0 ? null : live.controls[index]
      }
      return live.data.options.some(option => option.value === request.selectedValue && option.selected) &&
        !live.data.buttons[request.buttonIndex]?.disabled ? live.buttons[request.buttonIndex] : null
    }
    const guardClick = event => {
      const click = token.nativeClick
      if (!click?.prepared || click.received || !event.isTrusted) return
      const target = clickControl()
      if (!current() || !target || target !== click.target || !(event.target === target || target.contains(event.target))) {
        click.failure = 'native-click-target-changed'
        event.preventDefault(); event.stopImmediatePropagation()
        return
      }
      if (event.type === 'click') {
        click.received = true
        diagnostic.nativeClickReceived = true
        diagnostic.clickTrusted = true
        queueMicrotask(() => { diagnostic.clickPrevented = event.defaultPrevented })
      }
    }
    const inputEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
    const requestClick = () => {
      diagnostic.nativeClickReceived = false
      token.nativeClick = { prepared: false, received: false, failure: null,
        prepare() {
          if (this.prepared) return null
          this.prepared = true
          const target = clickControl()
          if (!current() || !target || !target.isConnected || !isVisibleElement(target) || controlDisabled(target)) {
            this.failure = 'native-click-target-changed'
            return { ok: false, reason: this.failure }
          }
          try { target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }) } catch (_) {}
          const rect = target.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
          const hit = document.elementFromPoint(x, y)
          if (rect.width <= 0 || rect.height <= 0 || !hit || !(hit === target || target.contains(hit))) {
            this.failure = 'native-click-unreachable'
            return { ok: false, reason: this.failure }
          }
          this.target = target
          return { ok: true, x, y }
        } }
      for (const type of inputEvents) document.addEventListener(type, guardClick, true)
      report({ event: 'focus-ui-click', focusEditToken: request.token })
    }
    try {
      if (request.kind === 'choose') {
        const index = card.data.options.findIndex(option => option.value === request.optionValue && !option.disabled)
        if (index < 0) return finish('invalid', 'invalid-request')
        if (card.data.options[index].selected) return finish('ok', 'option-confirmed')
        diagnostic.stage = 'confirm'
        requestClick()
        const deadline = Date.now() + 2500
        while (current() && Date.now() < deadline) {
          await pause()
          if (token.nativeClick.failure) return finish('stuck', token.nativeClick.failure)
          card = locate()
          if (token.nativeClick.received && card?.data.options.some(option => option.value === request.optionValue && option.selected)) {
            // Native Radix/React state gets a turn to settle before enabling submit.
            await pause(); await pause(); await pause()
            if (!current()) return finish('cancelled', 'cancelled')
            return locate()?.data.options.some(option => option.value === request.optionValue && option.selected)
              ? finish('ok', 'option-confirmed') : finish('stuck', 'option-unconfirmed')
          }
        }
        return current() ? finish('stuck', diagnostic.nativeClickReceived ? 'option-unconfirmed' : 'native-click-not-received') : finish('cancelled', 'cancelled')
      }
      if (!Number.isSafeInteger(request.buttonIndex) || !card.buttons[request.buttonIndex] || card.data.buttons[request.buttonIndex].disabled ||
        !request.selectedValue || !card.data.options.some(option => option.value === request.selectedValue && option.selected)) return finish('unavailable', 'form-not-ready')
      const baseline = queryAllAssistant().map(messageIdOf).filter(Boolean)
      for (const id of baseline) focusEditExcludedIds.add(id)
      token.submitted = true
      diagnostic.stage = 'submit'
      diagnostic.submitted = true
      // The native handler adds genui_state_snapshots and may create a branch. Do not
      // synthesize a plain chat send, construct its API payload, or retry this click.
      requestClick()
      const deadline = Date.now() + SEND_TIMEOUT_MS
      while (current() && Date.now() < deadline) {
        if (token.nativeClick.failure) return finish('stuck', token.nativeClick.failure)
        const submission = token.submission
        if (submission && !submission.matched) return finish('stuck', 'request-mismatch')
        const groups = PAGE.focus.edit ? queryAll([PAGE.focus.edit.turnSelector]).filter(isVisibleElement) : []
        if (token.nativeClick.received && submission?.matched && groups.some(group => group.getAttribute(PAGE.focus.edit.turnIdAttr) === submission.messageId)) {
          focusReplyBaseline = null; focusBaselinePosition = null; focusReplyPosition = null
          state.replyActionDetected = false; state.failedCommand = null; state.commandRecoveryUsed = false; state.lastCommandMessageId = null
          draftRejected = false
          report({ event: 'user-message', text: submission.text, focusEditToken: request.token })
          setReplyWaiting(Date.now(), 'smart-ui-sent')
          state.taskActive = true
          report({ event: 'sent', text: submission.text.slice(0, 400), promptInjected: false, taskPromptGeneration: token.generation })
          scheduleScrollToBottom(); confirmed = true
          diagnostic.stage = 'confirm'
          return finish('ok', 'new-user-confirmed')
        }
        await pause()
      }
      return current() ? finish('stuck', !diagnostic.nativeClickReceived ? 'native-click-not-received' :
        token.submission ? 'submit-unconfirmed' : 'request-not-observed') : finish('cancelled', 'cancelled')
    } finally {
      for (const type of inputEvents) document.removeEventListener(type, guardClick, true)
      if (focusEditing === token) focusEditing = null
      if (state.taskPromptGeneration === token.generation) state.programmatic = false
      if (confirmed) scheduleCheck()
    }
  }

  /** Measured native edit form. Submit ONCE, then require matching request and DOM ids. */
  const editFocusUser = async (request, expectedPath, diagnostic = {}) => {
    diagnostic.stage = 'prepare'
    diagnostic.submitted = false
    const finish = (outcome, reason) => { diagnostic.reason = reason; return outcome }
    const rules = PAGE.focus?.edit
    if (!rules || !request || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 20000 ||
      typeof request.originalText !== 'string' || !request.originalText.trim() ||
      typeof request.token !== 'string' || !request.token || request.token.length > 160) return finish('invalid', 'invalid-request')
    if (location.pathname !== expectedPath) return finish('unavailable', 'conversation-changed')
    if (focusEditing || state.programmatic || fileSend || state.awaitingReplySince || state.pendingQuestion || findStopButton()) return finish('busy', 'page-busy')
    const composer = getComposer()
    if (!composer) return finish('no-composer', 'no-composer')
    if (collapse(readComposer(composer)) || draftAttachmentEvidence(attachmentSnapshot()) || hasDraftImageAttachment() ||
      queryAll([rules.editorSelector]).some(isVisibleElement)) return finish('busy', 'native-draft')
    if (state.enabled && state.promptInjectionEnabled && !state.prefix) return finish('unavailable', 'missing-prefix')
    diagnostic.stage = 'locate'
    const groups = () => queryAll([rules.turnSelector]).filter(group => isVisibleElement(group) && group.querySelector(rules.userTextSelector))
    const originalGroups = groups()
    const normalized = text => collapse(userTextOf(normalizeLineEndings(text)))
    const original = normalized(request.originalText)
    diagnostic.originalLength = original.length
    diagnostic.groupCount = originalGroups.length
    const anchor = request.replyMessageId ? queryAllAssistant().find(node => messageIdOf(node) === request.replyMessageId &&
      isVisibleElement(node.closest(rules.turnSelector))) : null
    const candidates = anchor ? [anchor.closest(rules.turnSelector)] : originalGroups.filter(group =>
      normalized(readComposer(group.querySelector(rules.userTextSelector))) === original)
    diagnostic.anchored = !!anchor
    diagnostic.candidateCount = candidates.length
    if (candidates.length !== 1) return finish('unavailable', 'candidate-not-unique')
    const group = candidates[0]
    const originalId = group.getAttribute(rules.turnIdAttr)
    const index = originalGroups.indexOf(group)
    const originalIds = originalGroups.map(item => item.getAttribute(rules.turnIdAttr))
    diagnostic.pageTextLength = normalized(readComposer(group.querySelector(rules.userTextSelector))).length
    if (!originalId || index < 0) return finish('unavailable', 'invalid-position')
    const edit = rules.buttonSelectors.map(selector => group.querySelector(selector)).find(node => node && !controlDisabled(node))
    if (!edit) return finish('unavailable', 'edit-button-missing')
    const token = { token: request.token, generation: state.taskPromptGeneration }
    const current = () => focusEditing === token && location.pathname === expectedPath && state.taskPromptGeneration === token.generation
    const pause = () => new Promise(resolve => setTimeout(resolve, 60))
    let editor = null, submitted = false, confirmed = false
    focusEditing = token
    state.programmatic = true
    const injection = userPromptInjection()
    const text = normalizeLineEndings(request.text)
    const payload = injection.prefix ? injection.prefix + USER_TEXT_SENTINEL + text : text
    const oldReplies = queryAllAssistant().map(messageIdOf).filter(Boolean)
    try {
      diagnostic.stage = 'open'
      group.scrollIntoView?.({ block: 'center' })
      pressButton(edit)
      const openDeadline = Date.now() + 2000
      while (current() && Date.now() < openDeadline) {
        editor = group.querySelector(rules.editorSelector)
        if (editor && isVisibleElement(editor)) break
        await pause()
      }
      if (!current()) return finish('cancelled', 'cancelled')
      if (!editor || !isVisibleElement(editor)) return finish('no-composer', 'editor-missing')
      // A long injected prompt is folded in the message bubble (including a 显示更多
      // caption). Its preview cannot verify the human text. The native editor contains
      // the complete original; verify it before replacing anything in that editor.
      diagnostic.stage = 'verify'
      const originalEditorValue = readComposer(editor)
      const fullOriginal = normalized(originalEditorValue)
      diagnostic.editorTextLength = originalEditorValue.length
      diagnostic.originalMatches = fullOriginal === original || (!!anchor && fullOriginal.endsWith(original))
      if (!diagnostic.originalMatches) return finish('unavailable', 'original-text-mismatch')
      diagnostic.stage = 'insert'
      if (!insertText(editor, payload) || !composerMatches(editor, payload)) return finish('insert-failed', 'insert-failed')
      // execCommand can update the DOM before ProseMirror's observer and React's submit
      // closure commit the draft. The unchanged message already has an enabled button;
      // that button alone is not evidence that the newly inserted text is ready.
      editor.blur?.()
      diagnostic.stage = 'submit'
      let button = null
      let stableSince = Date.now(), stableEditor = editor
      diagnostic.editorStableReads = 0
      const insertedAt = Date.now()
      const buttonDeadline = Date.now() + 2000
      while (current() && Date.now() < buttonDeadline) {
        await pause()
        if (!current()) break
        const liveGroup = queryAll([rules.turnSelector]).find(item => item.getAttribute(rules.turnIdAttr) === originalId)
        editor = liveGroup?.querySelector(rules.editorSelector)
        diagnostic.draftMatches = !!editor && isVisibleElement(editor) && composerMatches(editor, payload)
        if (!diagnostic.draftMatches) return finish('insert-failed', 'draft-not-stable')
        if (editor !== stableEditor) { stableEditor = editor; stableSince = Date.now(); diagnostic.editorStableReads = 0 }
        diagnostic.editorStableReads++
        diagnostic.settleMs = Date.now() - insertedAt
        button = editor.closest('form')?.querySelector(rules.submitSelector)
        if (Date.now() - stableSince >= 180 && button && isVisibleElement(button) && !controlDisabled(button)) break
        button = null
      }
      if (!current()) return finish('cancelled', 'cancelled')
      if (!editor.isConnected || !button || controlDisabled(button) || !composerMatches(editor, payload) || findStopButton()) return finish('busy', 'form-not-ready')
      // Establish the fence before clicking; mutation/settle callbacks may run while the
      // native page is replacing the old branch and before its new reply exists.
      for (const id of oldReplies) focusEditExcludedIds.add(id)
      submitted = true
      diagnostic.submitted = true
      token.submitted = true
      pressButton(button)
      diagnostic.stage = 'confirm'
      const deadline = Date.now() + SEND_TIMEOUT_MS
      while (current() && Date.now() < deadline) {
        const submission = token.submission
        if (submission) {
          for (const key of ['requestBodyReadable', 'requestTextMatches', 'requestOriginalMatches', 'requestUserLength', 'requestCount']) {
            if (submission[key] !== undefined) diagnostic[key] = submission[key]
          }
          if (!submission.requestTextMatches) return finish('stuck', submission.reason)
        }
        const nextGroups = groups()
        const next = nextGroups[index]
        const newId = next?.getAttribute(rules.turnIdAttr)
        if (submission?.requestTextMatches && newId === submission.messageId && !originalIds.includes(newId) &&
          nextGroups.slice(0, index).every((item, offset) => item.getAttribute(rules.turnIdAttr) === originalIds[offset]) &&
          // The bubble may be folded. Its id must belong to a native request whose
          // actual body matches the edit, not just any newly generated user message.
          !next.querySelector(rules.editorSelector)) {
          focusReplyBaseline = null
          focusBaselinePosition = null
          focusReplyPosition = null
          state.replyActionDetected = false
          state.failedCommand = null
          state.commandRecoveryUsed = false
          state.lastCommandMessageId = null
          draftRejected = false
          if (injection.metadata.promptInjected) {
            state.taskPromptInjected = true
          }
          reportUserInjection(injection, token.generation)
          report({ event: 'user-message', text, focusEditToken: request.token })
          setReplyWaiting(Date.now(), 'user-edited')
          state.taskActive = true
          report({ event: 'sent', text: text.slice(0, 400), ...injection.metadata, taskPromptGeneration: token.generation })
          scheduleScrollToBottom()
          confirmed = true
          return finish('ok', 'new-user-confirmed')
        }
        await pause()
      }
      return current() ? finish('stuck', token.submission ? 'submit-unconfirmed' : 'request-not-observed') : finish('cancelled', 'cancelled')
    } finally {
      // Before submit, restore the native message when our own edit could not be prepared.
      // After submit, leave an uncertain result alone: no automatic retry or cancellation.
      if (!submitted && current() && editor?.isConnected) {
        const cancel = [...(editor.closest('form')?.querySelectorAll('button[type="button"]') || [])]
          .find(node => collapse(node.textContent) === rules.cancelLabel)
        if (cancel) pressButton(cancel)
      }
      if (focusEditing === token) focusEditing = null
      if (state.taskPromptGeneration === token.generation) state.programmatic = false
      if (confirmed) scheduleCheck()
    }
  }

  /** Metadata only; synthetic result sends must not masquerade as user attempts. */
  const noteUserSend = (event, reason, element) => {
    if (!event.isTrusted) return
    report({
      event: 'send-observed',
      trigger: event.type === 'keydown' ? 'enter' : 'click',
      reason,
      enabled: state.enabled,
      promptInjectionEnabled: state.promptInjectionEnabled,
      prefixLength: state.prefix.length,
      programmatic: state.programmatic,
      taskPromptInjected: state.taskPromptInjected,
      taskPromptGeneration: state.taskPromptGeneration,
      composerFound: !!element,
      composerKind: element ? element.tagName.toLowerCase() : null,
      composerTextLength: readComposer(element).length,
      targetMatchesComposer: !!element && element.contains(event.target),
      defaultPrevented: event.defaultPrevented === true,
      isComposing: event.isComposing === true
    })
  }

  /*
   * A short note above the composer, in the page itself: the user pressed Enter here, so this
   * is where they look. The draft stays in the composer; nothing is sent or cleared.
   */
  let sendBlockNotice = null
  let sendBlockNoticeTimer = null
  const showSendBlockNotice = (message, ms) => {
    try {
      if (!sendBlockNotice || !sendBlockNotice.isConnected) {
        sendBlockNotice = document.createElement('div')
        sendBlockNotice.setAttribute('role', 'status')
        sendBlockNotice.setAttribute('data-web2term-notice', 'send-block')
        Object.assign(sendBlockNotice.style, {
          position: 'fixed', left: '50%', bottom: '140px', transform: 'translateX(-50%)', zIndex: '2147483647',
          maxWidth: 'min(560px, calc(100vw - 32px))', padding: '10px 16px', borderRadius: '10px',
          background: 'rgba(30, 41, 59, 0.94)', color: '#fff', font: '13px/1.6 system-ui, sans-serif',
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)', pointerEvents: 'none'
        })
        document.body.appendChild(sendBlockNotice)
      }
      sendBlockNotice.textContent = message
      if (sendBlockNoticeTimer) clearTimeout(sendBlockNoticeTimer)
      sendBlockNoticeTimer = setTimeout(() => {
        sendBlockNoticeTimer = null
        sendBlockNotice?.remove()
        sendBlockNotice = null
      }, ms)
    } catch (_) { /* The send is still held; the notice is only a courtesy. */ }
  }

  const intercept = (event) => {
    const element = getComposer(event.target)
    // Our own sends must pass through untouched: no prefix, no interception.
    if (state.programmatic) {
      noteUserSend(event, 'programmatic-send', element)
      return false
    }
    // Before the terminal-mode checks: with computer use on, every user send waits for the
    // helper. An empty composer is left to the checks below, which ignore it.
    if (state.sendBlock && element && (collapse(userTextOf(readComposer(element))) !== '' || hasDraftImageAttachment())) {
      noteUserSend(event, 'computer-helper-not-ready', element)
      event.preventDefault()
      event.stopImmediatePropagation()
      showSendBlockNotice(state.sendBlock + ' 草稿已保留。', 6000)
      return true
    }
    if (!state.enabled) {
      noteUserSend(event, 'terminal-disabled', element)
      return false
    }
    if (state.promptInjectionEnabled && !state.prefix) {
      noteUserSend(event, 'missing-prefix', element)
      return false
    }
    // This draft already failed to compose. Attempting again on every keystroke is how the
    // injected counter ran away; the user's text sends as-is instead.
    if (state.promptInjectionEnabled && draftRejected) {
      noteUserSend(event, 'draft-rejected', element)
      return false
    }

    if (!element) {
      noteUserSend(event, 'composer-missing', element)
      return false
    }
    const draft = readComposer(element)
    // Strip any prefix left by a failed submit before composing the current plan once.
    const text = userTextOf(draft)
    const draftHasImage = hasDraftImageAttachment()

    /*
     * An EMPTY draft is not a message, and this is not a nicety — it is the guard against the
     * app talking to the model on its own.
     *
     * Nothing above checks it: `hasPrefix` compares against a sentence that is not there, so an
     * empty composer fails that test, and everything below then composes the SYSTEM PROMPT with
     * an empty user tail and SENDS it — a whole message in the conversation containing nothing
     * the user wrote. Observed twice in one session, from a control the app clicked itself.
     *
     * Returning false here is also the CORRECT behaviour for the user: pressing Enter in an
     * empty composer should do nothing, which is what the site does once we stop stealing the
     * event.
     */
    if (collapse(text) === '' && !draftHasImage) {
      noteUserSend(event, 'empty-draft', element)
      return false
    }

    noteUserSend(event, 'accepted', element)

    // Always track a real user send, even when the pre-send thumbnail detector misses the
    // attachment. ChatGPT commonly clears its file input after upload, while the sent turn
    // still contains the image; tracking every text send lets us recover it there.
    const attachmentToken = beginUserImageCapture()

    event.preventDefault()
    event.stopImmediatePropagation()
    state.programmatic = true

    const injection = userPromptInjection()
    const sendContext = {
      taskPromptGeneration: state.taskPromptGeneration,
      ...injection.metadata
    }
    if (!injection.prefix) {
      // Skipping the prefix must still capture images, publish the user turn and arm
      // the next reply. Synthetic Enter/click events bypass this handler above.
      if (draft !== text && (!insertText(element, text) || collapse(readComposer(element)) !== collapse(text))) {
        state.programmatic = false
        discardUserImageCapture(attachmentToken)
        report({ event: 'inject-failed' })
        showSendBlockNotice('未能清除上次发送留下的提示词，请保留正文后重试。', 6000)
        return true
      }
      submitWithRetry(
        text, 0, false, null,
        Date.now() + SEND_ATTEMPT_BUDGET_MS, 0,
        Date.now() + SEND_BUTTON_GRACE_MS, attachmentToken, sendContext
      )
      return true
    }

    /*
     * ONE write, carrying everything.
     *
     * This used to be two — the prompt first, then the sentinel and the user's text — which
     * works on a contenteditable composer because `execCommand` INSERTS at the caret. A
     * textarea write is a whole-value REPLACE, so the second call deleted the prompt that the
     * first had just written: the message went out with no system prompt and the app could
     * never tell.
     *
     * Composing first and writing once makes both mechanisms behave the same way.
     */
    const composed = injection.prefix + USER_TEXT_SENTINEL + text
    const wrote = insertText(element, composed)

    /*
     * Verify, rather than assume.
     *
     * A REPLACE that silently did not take leaves the composer holding something other than
     * what we composed. Submitting then would send the wrong text — and `hasPrefix` would keep
     * failing, so every later keystroke would inject again. That is exactly how the injected
     * counter reached four figures while nothing was actually sent.
     */
    const verified = wrote && collapse(readComposer(element)) === collapse(composed)

    if (!verified) {
      /*
       * The injection did not take. Two rules, both learned the hard way:
       *
       *  1. NEVER trap the user's message. Fall back to sending their text as-is, without the
       *     system prompt: a degraded terminal turn is recoverable, a composer that eats what
       *     you type is not.
       *  2. Do not try again on the same draft. Interception is re-entered on every keystroke,
       *     and an injection that failed once fails every time — retrying is what produced the
       *     runaway counter and the appearance of the prompt being "constantly injected".
       */
      draftRejected = true
      report({ event: 'inject-failed' })
      submitWithRetry(
        text,
        0,
        false,
        null,
        Date.now() + SEND_ATTEMPT_BUDGET_MS,
        0,
        Date.now() + SEND_BUTTON_GRACE_MS,
        attachmentToken,
        { taskPromptGeneration: sendContext.taskPromptGeneration, promptInjected: false }
      )
      return true
    }

    draftRejected = false
    reportUserInjection(injection)
    setTimeout(
      () =>
        submitWithRetry(
          composed,
          0,
          false,
          null,
          Date.now() + SEND_ATTEMPT_BUDGET_MS,
          0,
          Date.now() + SEND_BUTTON_GRACE_MS,
          attachmentToken,
          sendContext
        ),
      60
    )
    return true
  }

  /* ------------------------------------------------------------------ *
   * The site's own edit-and-resend (PAGE.nativeEdit, DeepSeek)
   * ------------------------------------------------------------------ */

  const nativeEditRows = () => PAGE.nativeEdit ? queryAll([PAGE.nativeEdit.rowSelector]).filter(isVisibleElement) : []
  // An open edit box replaces the bubble, so a row is the user's when it holds no reply.
  const latestUserRow = () => nativeEditRows().filter(row => !isAssistantTurn(row)).pop() || null
  const nativeEditor = (row) => row ? [...row.querySelectorAll(PAGE.nativeEdit.editorSelector)].find(isVisibleElement) || null : null

  /** Only the current task's latest message may be retried; anything older is the user's own history edit. */
  const nativeEditRejection = (row, auto) => {
    if (row !== latestUserRow()) return 'native-edit-not-latest'
    if (PAGE.computerUseRequests !== true || !state.enabled || !state.computerUseEnabled || !computerSourceSubmissionId ||
      !state.taskActive || state.pendingQuestion || state.programmatic || focusEditing || (!auto && safetyLeak.busy)) return 'native-edit-no-task'
    return null
  }

  /**
   * The site sends the edited message itself; the app never composes into an edit box. The wait
   * is armed only once generation actually starts, so a send that did not happen cannot leave
   * the task waiting for a reply that will never come. The baseline is taken before the send:
   * row keys are message ids, so the replaced reply stays in it and the new reply's id does not.
   */
  const startNativeEditRetry = (row, auto) => {
    const rejected = nativeEditRejection(row, auto)
    if (rejected) { report({ event: 'native-edit', reason: rejected }); return false }
    const attempt = { auto, baseline: computerBaselineOf(), previous: lastAssistantId(), startedAt: Date.now() }
    nativeEditRetry = attempt
    const poll = () => {
      if (nativeEditRetry !== attempt) return
      if (findStopButton()) {
        nativeEditRetry = null
        safetyLeak.busy = false
        state.taskActive = true
        state.lastCommandMessageId = attempt.previous
        setReplyWaiting(Date.now(), 'user-edited', null, attempt.baseline)
        report({ event: 'native-edit', reason: 'native-edit-retry', attempt: safetyLeak.count })
        scheduleCheck()
        return
      }
      if (Date.now() - attempt.startedAt < 10000) { setTimeout(poll, 200); return }
      nativeEditRetry = null
      report({ event: 'native-edit', reason: 'native-edit-unconfirmed' })
      if (auto) giveUpSafetyLeak(attempt.previous, 'generation')
    }
    setTimeout(poll, 200)
    return true
  }

  /** @returns true when the event belongs to an open edit box and must not reach the composer interceptor. */
  const handleNativeEditSend = (event) => {
    if (!PAGE.nativeEdit || !(event.target instanceof Element)) return false
    const row = event.target.closest(PAGE.nativeEdit.rowSelector)
    const editor = nativeEditor(row)
    if (!editor) return false
    if (event.type === 'click' && !event.target.closest(PAGE.nativeEdit.submitSelector)) return false
    if (event.type === 'keydown' && (event.target !== editor || event.shiftKey || event.isComposing || event.repeat || event.defaultPrevented)) return true
    // The automatic resend armed its own attempt before pressing send.
    if (!event.isTrusted || nativeEditRetry?.auto) return true
    if (collapse(editor.value) !== '') startNativeEditRetry(row, false)
    return true
  }

  /** A center point the page itself would deliver to `element` (or, for a hover-only toolbar, to its row). */
  const nativeEditPoint = (element, row) => {
    if (!element || !isVisibleElement(element)) return null
    try { element.scrollIntoView({ block: 'nearest' }) } catch (_) { /* measured as-is */ }
    const rect = element.getBoundingClientRect()
    const x = Math.round(rect.left + rect.width / 2)
    const y = Math.round(rect.top + rect.height / 2)
    const hit = document.elementFromPoint(x, y)
    return hit && (element.contains(hit) || hit.contains(element) || row.contains(hit)) ? { x, y } : null
  }
  const nativeEditWait = async (probe, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const found = probe()
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return null
  }
  const giveUpSafetyLeak = (messageId, step) => {
    safetyLeak.busy = false
    safetyLeak.failedKey = messageId
    report({ event: 'native-edit', reason: 'safety-leak-failed', messageId, step })
    scheduleCheck()
  }

  /**
   * Resend the latest user message unchanged, by real clicks the main process makes at points
   * measured here (the site ignores script clicks, as with 继续生成). Every miss gives up and lets
   * the reply settle as before; nothing else on the page is ever clicked.
   */
  const resendAfterSafetyLeak = async (messageId) => {
    safetyLeak.busy = true
    const row = latestUserRow()
    if (!row || nativeEditRejection(row, true)) return giveUpSafetyLeak(messageId, 'row')
    const editPoint = nativeEditPoint(row.querySelector(PAGE.nativeEdit.buttonSelector), row)
    if (!editPoint) return giveUpSafetyLeak(messageId, 'edit-button')
    report({ event: 'native-edit', reason: 'safety-leak-edit-click', messageId, ...editPoint })
    const editor = await nativeEditWait(() => nativeEditor(latestUserRow()), 3000)
    if (!editor || collapse(editor.value) === '') return giveUpSafetyLeak(messageId, 'editor')
    const editRow = editor.closest(PAGE.nativeEdit.rowSelector)
    const sendPoint = nativeEditPoint(editRow.querySelector(PAGE.nativeEdit.submitSelector), editRow)
    if (!sendPoint) return giveUpSafetyLeak(messageId, 'submit')
    if (!startNativeEditRetry(editRow, true)) return giveUpSafetyLeak(messageId, 'task')
    report({ event: 'native-edit', reason: 'safety-leak-send-click', messageId, ...sendPoint })
  }

  /** @returns true while a leaked moderation verdict is being answered by a resend instead of ending the task. */
  const handleSafetyLeak = (messageId, text) => {
    const source = PAGE.nativeEdit?.safetyLeakPattern
    if (!source || PAGE.computerUseRequests !== true) return false
    let pattern
    try { pattern = new RegExp(source, 'i') } catch (_) { return false }
    if (!pattern.test(String(text || '').trim())) return false
    if (safetyLeak.busy || nativeEditRetry) return true
    if (safetyLeak.failedKey === messageId) return false
    report({ event: 'native-edit', reason: 'safety-leak-detected', messageId, attempt: safetyLeak.count })
    if (safetyLeak.count >= 2) {
      safetyLeak.failedKey = messageId
      report({ event: 'native-edit', reason: 'safety-leak-limit', messageId, attempt: safetyLeak.count })
      return false
    }
    safetyLeak.count += 1
    void resendAfterSafetyLeak(messageId).catch(() => giveUpSafetyLeak(messageId, 'error'))
    return true
  }

  // Capture phase, on `document`: survives ChatGPT's client-side route changes,
  // and runs before React's own handlers on the composer.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter') return
      // Enter in a message's edit box sends that edit natively (measured); it is never a composer send.
      if (handleNativeEditSend(event)) return
      const element = getComposer(event.target)
      if (!element || !element.contains(event.target)) {
        const target = event.target
        // Ignore unrelated shortcuts, but record a real editor the adapter missed.
        if (target && typeof target.closest === 'function' && target.closest('textarea, [contenteditable="true"], [role="textbox"]')) {
          noteUserSend(event, element ? 'composer-target-mismatch' : 'composer-missing', element)
        }
        return
      }
      if (event.shiftKey || event.isComposing || event.defaultPrevented || event.repeat) {
        const reason = event.isComposing ? 'ime-composition' : event.shiftKey ? 'shift-enter' : event.repeat ? 'repeat-key' : 'event-prevented'
        noteUserSend(event, reason, element)
        return
      }
      intercept(event)
    },
    true
  )

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!target || typeof target.closest !== 'function') return
      if (!PAGE.sendButtonSelectors.some((selector) => target.closest(selector))) return
      // The edit box's 发送 shares the send button's classes; it resends that message, not the composer.
      if (handleNativeEditSend(event)) return
      // While a reply streams the primary button is stop. A user's own stop is never answered with 继续.
      if (event.isTrusted && state.awaitingReplySince !== 0 && collapse(readComposer(getComposer())) === '') userStoppedAt = Date.now()
      intercept(event)
    },
    true
  )

  /* ------------------------------------------------------------------ *
   * Inbound: find the command in the assistant's reply
   * ------------------------------------------------------------------ */

  /**
   * Pull every balanced top-level `{...}` out of `text`.
   * Brace counting is string-aware so braces inside quoted values do not
   * throw it off.
   */
  const balancedObjects = (text, includeIncomplete = false) => {
    const found = []
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') {
        if (depth === 0) start = i
        depth += 1
      } else if (ch === '}') {
        if (depth > 0) {
          depth -= 1
          if (depth === 0 && start >= 0) {
            found.push(text.slice(start, i + 1))
            start = -1
          }
        }
      }
    }
    if (includeIncomplete && start >= 0 && depth > 0) found.push(text.slice(start))
    return found
  }

  // Recognition of the top-level discriminator only. Keep the bytes (including duplicate
  // fields) intact for the later strict protocol validator; never use command JSON repair.
  const hasComputerDiscriminator = (raw) => {
    let depth = 0
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (ch === '"') {
        const start = i++
        for (; i < raw.length; i++) {
          if (raw[i] === '\\') { i++; continue }
          if (raw[i] === '"') break
        }
        if (depth !== 1) continue
        let key
        try { key = JSON.parse(raw.slice(start, i + 1)) } catch (_) { continue }
        if (key !== 'type') continue
        const tail = raw.slice(i + 1)
        const value = /^\s*:\s*("(?:[^"\\]|\\.)*")/.exec(tail)
        if (value) {
          try { if (JSON.parse(value[1]) === 'computer') return true } catch (_) {}
        } else if (/^\s*:\s*"computer(?:\s|$)/.test(tail)) return true
      } else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') depth--
    }
    return false
  }
  const looksLikeComputerReply = (text) => looksLikeDsmlComputerCall(text) || balancedObjects(String(text || ''), true).some(hasComputerDiscriminator)
  const extractComputerRequest = (text) => {
    // DeepSeek sometimes leaks one pseudo tag block of prose before the request (seen on 2026-10-27:
    // <system>…</system>, once <bsystem>…</bsystem>). Only that single LEADING block is dropped; any
    // other text around the JSON still makes the request ambiguous.
    const cleaned = String(text || '').trim().replace(/^<(b?system)>[\s\S]*?<\/\1>/i, '').trim()
      .replace(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i, '$1').trim()
    // A malformed or incomplete native computer call must receive protocol feedback,
    // never settle as prose or fall through to a command nested inside its parameters.
    if (looksLikeDsmlComputerCall(cleaned)) return { outcome: 'invalid',
      issue: cleaned.length > 64_000 ? 'oversized-request' : 'invalid-json', rawJson: cleaned.slice(0, 64_000) }
    const objects = balancedObjects(cleaned, true)
    if (!objects.some(hasComputerDiscriminator)) return null
    if (cleaned.length > 64_000) return { outcome: 'invalid', issue: 'oversized-request', rawJson: cleaned.slice(0, 64_000) }
    if (objects.length !== 1 || objects[0] !== cleaned) return { outcome: 'invalid', issue: 'ambiguous-request', rawJson: cleaned }
    try {
      const value = JSON.parse(cleaned)
      return { outcome: value?.type === 'computer' ? 'candidate' : 'invalid',
        issue: value?.type === 'computer' ? null : 'ambiguous-request', rawJson: cleaned }
    } catch (_) { return { outcome: 'invalid', issue: 'invalid-json', rawJson: cleaned } }
  }

  const computerWaitRebindable = (wait) => (wait.path === '/' || wait.baseline?.path === '/') && wait.path !== location.pathname &&
    !!PAGE.conversationPathPattern && new RegExp(PAGE.conversationPathPattern).test(location.pathname)
  const computerWaitCurrent = (wait) => {
    if (!wait || computerReplyWait !== wait || wait.reported || !state.enabled || !state.computerUseEnabled ||
      !wait.sourceSubmissionId || state.awaitingReplySince === 0 || state.pendingQuestion ||
      wait.pageEpoch !== computerPageEpoch ||
      wait.generation !== state.taskPromptGeneration) return false
    // The first confirmed send creates the SPA conversation route. ChatGPT can pass through an interim
    // /c/<uuid> before the real one (2026-10-27 reply log), so a send from the new-chat page follows the
    // current conversation route until its request is reported; main still requires the task's own conversation.
    if (computerWaitRebindable(wait)) { wait.path = location.pathname; wait.bindCount = (wait.bindCount || 0) + 1 }
    return wait.path === location.pathname
  }
  const computerTurnIsNew = (node, wait) => {
    if (!node?.isConnected || !isVisibleElement(node)) return false
    if (!PAGE.fileTurnPositionAttr && PAGE.messageIdAttr) {
      if (!wait.baseline.ids?.size && wait.baseline.path !== '/') return false
      const id = messageIdOf(node)
      // History rendered later lands above the newest turn; only the newest can be this send's reply.
      return !!id && !wait.baseline.ids.has(id) && latestReplyNode(queryAllAssistant()) === node
    }
    // An empty virtual list in an existing conversation proves no history boundary.
    // Only a new chat's home route may start from an empty baseline.
    if (!wait.baseline.positions.size && wait.baseline.path !== '/') return false
    const position = PAGE.fileTurnPositionAttr ? node.getAttribute(PAGE.fileTurnPositionAttr) : null
    if (!position || wait.baseline.positions.has(position)) return false
    return wait.baseline.maxPosition === null || (/^\d+$/.test(position) && Number(position) > wait.baseline.maxPosition)
  }
  /**
   * Why a computer-shaped reply was not this send's live reply, check by check, in the order
   * computerWaitCurrent and computerTurnIsNew apply them. Read-only: it never binds wait.path.
   * Flags, counts and path shapes (id segments replaced) only; no text or ids leave the page.
   */
  const computerPathShape = (path) => typeof path === 'string' ? path.replace(/[^/]{12,}/g, ':id').slice(0, 60) : null
  const computerLiveDiagnostics = (node, wait) => {
    const info = { waitPresent: !!wait, waitIsCurrent: !!wait && wait === computerReplyWait, locationPath: computerPathShape(location.pathname) }
    const fail = (failed) => ({ failed, ...info })
    if (!wait) return fail('no-wait')
    const bindable = computerWaitRebindable(wait)
    // Conversation ids already appear in the reply log; the rest of each path stays a shape.
    const conversationOf = (path) => (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16}/i.exec(String(path || '')) || [null])[0]
    Object.assign(info, {
      waitConversationId: conversationOf(wait.path), locationConversationId: conversationOf(location.pathname), bindCount: wait.bindCount || 0,
      reported: wait.reported, enabled: state.enabled, computerUseEnabled: state.computerUseEnabled,
      sourceSubmission: !!wait.sourceSubmissionId, awaiting: state.awaitingReplySince !== 0, pendingQuestion: !!state.pendingQuestion,
      epochMatch: wait.pageEpoch === computerPageEpoch, waitGeneration: wait.generation, stateGeneration: state.taskPromptGeneration,
      waitPath: computerPathShape(wait.path), baselinePath: computerPathShape(wait.baseline?.path), pathBindable: bindable,
      pathMatch: wait.path === location.pathname || bindable
    })
    if (!info.waitIsCurrent) return fail('stale-wait')
    if (wait.reported) return fail('reported')
    if (!state.enabled) return fail('disabled')
    if (!state.computerUseEnabled) return fail('computer-off')
    if (!wait.sourceSubmissionId) return fail('no-source')
    if (!info.awaiting) return fail('not-awaiting')
    if (info.pendingQuestion) return fail('pending-question')
    if (!info.epochMatch) return fail('epoch')
    if (wait.generation !== state.taskPromptGeneration) return fail('generation')
    if (!info.pathMatch) return fail('path')
    const candidates = replyCandidatesOf(queryAllAssistant())
    Object.assign(info, {
      nodeConnected: !!node?.isConnected, nodeVisible: !!node && isVisibleElement(node),
      baselineIdCount: wait.baseline?.ids?.size ?? 0, baselinePositionCount: wait.baseline?.positions?.size ?? 0,
      replyCandidateCount: candidates.length, latestIsNode: candidates[candidates.length - 1] === node
    })
    if (!info.nodeConnected || !info.nodeVisible) return fail('node-hidden')
    if (!PAGE.fileTurnPositionAttr && PAGE.messageIdAttr) {
      const id = messageIdOf(node)
      Object.assign(info, { idPresent: !!id, idInBaseline: !!id && !!wait.baseline.ids?.has(id) })
      if (!wait.baseline.ids?.size && wait.baseline.path !== '/') return fail('empty-baseline')
      if (!id) return fail('no-id')
      if (info.idInBaseline) return fail('id-in-baseline')
      if (!info.latestIsNode) return fail('not-latest')
      return fail('none')
    }
    const position = PAGE.fileTurnPositionAttr ? node.getAttribute(PAGE.fileTurnPositionAttr) : null
    Object.assign(info, { positionPresent: !!position, positionInBaseline: !!position && wait.baseline.positions.has(position) })
    if (!wait.baseline.positions.size && wait.baseline.path !== '/') return fail('empty-baseline')
    if (!position) return fail('no-position')
    if (info.positionInBaseline) return fail('position-in-baseline')
    return fail(computerTurnIsNew(node, wait) ? 'none' : 'position-not-after-baseline')
  }
  // Provenance is transport metadata only; command/read_files JSON and their execution rules stay unchanged.
  const legacyTaskSource = (node) => {
    const wait = computerReplyWait
    if (PAGE.computerUseRequests !== true || !computerWaitCurrent(wait) || !computerTurnIsNew(node, wait)) return {}
    wait.reported = true
    return { sourceSubmissionId: wait.sourceSubmissionId, taskPromptGeneration: wait.generation, pagePath: wait.path }
  }
  const checkComputerRequest = (node, messageId) => {
    if (PAGE.computerUseRequests !== true) return false
    const input = readComputerText(node)
    const request = extractComputerRequest(input)
    if (!request && !looksLikeComputerReply(readReplyText(node))) return false
    // Claim computer-shaped replies before the lenient command/read_files/questions branches.
    // Quotes/examples can be ignored, but can never become a Shell request.
    const wait = computerReplyWait
    if (!request || !computerWaitCurrent(wait) || !computerTurnIsNew(node, wait)) {
      noteScan(messageId, !request ? 'computer-quoted-content' : 'computer-not-live',
        request ? { computerLive: computerLiveDiagnostics(node, wait) } : undefined)
      return true
    }
    if (findContinueButton(node)) { noteScan(messageId, 'computer-reply-cut-off'); return true }
    if (pendingComputerRecognition?.wait === wait && pendingComputerRecognition.text === input) return true
    const recognition = { wait, text: input, key: turnKeyOf(node) }
    pendingComputerRecognition = recognition
    setTimeout(() => {
      if (pendingComputerRecognition !== recognition || !computerWaitCurrent(wait)) return
      pendingComputerRecognition = null
      const latest = latestReplyNode(queryAllAssistant())
      if (!latest || !isAssistantTurn(latest) || !computerTurnIsNew(latest, wait) ||
        replyIsGenerating(latest) || findContinueButton(latest) ||
        turnKeyOf(latest) !== recognition.key || readComputerText(latest) !== input) { scheduleCheck(); return }
      wait.reported = true
      state.lastCommandMessageId = turnKeyOf(latest)
      lastLiveComputer = { messageId: `computer:${userSubmissionScope}:${wait.serial}`, since: state.awaitingReplySince }
      state.replyActionDetected = true
      const checked = window.__computerUseProtocol?.check(request.rawJson, computerProtocolContext.definitions)
      const protocolCode = !checked ? 'invalid_envelope' : !checked.ok ? checked.error.code
        : computerProtocolContext.stepToken && checked.stepToken !== computerProtocolContext.stepToken ? 'stale_step_token' : null
      report({ event: 'computer-request', messageId: `computer:${userSubmissionScope}:${wait.serial}`,
        sourceSubmissionId: wait.sourceSubmissionId, taskPromptGeneration: wait.generation,
        pagePath: wait.path, rawJson: request.rawJson, computerOutcome: request.outcome, computerIssue: request.issue,
        computerPageEpoch: wait.pageEpoch,
        computerProtocolCode: protocolCode, live: true })
    }, 250)
    return true
  }

  /**
   * The system prompt advertises a valid JSON schema, but models sometimes copy old
   * habits or add a trailing comma, so repair the obvious variants before giving up.
   */
  const repairJson = (text) =>
    text
      // "key","value"  ->  "key":"value"
      .replace(/"([A-Za-z0-9_]+)"\s*,\s*("(?:[^"\\]|\\.)*")\s*([,}])/g, '"$1":$2$3')
      // trailing comma before } or ]
      .replace(/,\s*([}\]])/g, '$1')

  /**
   * Read a `"key": "value"` pair out of text that may not be valid JSON.
   *
   * The value ends at the first quote followed by `,` or `}` — that is what
   * separates the real terminator from the unescaped quotes the model leaves
   * inside a cmd command, which is full of them: `for /f "tokens=1"`,
   * `if not "%a"==""`, `cmd /c "..."`.
   *
   * A backslash only counts as an escape when a legal JSON escape follows it, so
   * an unescaped Windows path such as `C:\Users` survives intact.
   */
  const readJsonishString = (text, key) => {
    const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text)
    if (!match) return null

    let value = ''
    let i = match.index + match[0].length

    while (i < text.length) {
      const ch = text[i]

      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1]
        if (next === '"' || next === '\\' || next === '/') {
          value += next
          i += 2
          continue
        }
        if (next === 'n') {
          value += '\n'
          i += 2
          continue
        }
        if (next === 'r') {
          value += '\r'
          i += 2
          continue
        }
        if (next === 't') {
          value += '\t'
          i += 2
          continue
        }
        // Not a JSON escape — keep the backslash (a Windows path, most likely).
        value += '\\'
        i += 1
        continue
      }

      if (ch === '"') {
        if (/^\s*[,}]/.test(text.slice(i + 1))) return value
        // An unescaped quote inside the value.
        value += '"'
        i += 1
        continue
      }

      value += ch
      i += 1
    }

    return null
  }

  /**
   * Last resort for a reply whose JSON cannot be parsed.
   *
   * Dropping the command silently is the worst outcome available: the terminal
   * shows nothing at all, so nothing distinguishes "the model forgot to escape
   * its quotes" from "the model had nothing to say". It then looks like the app
   * simply stopped working.
   */
  const normalizeTimeoutSeconds = (value, command) => {
    if (!String(command || '').trim()) return 0
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return 120
    return Math.min(Math.max(Math.floor(seconds), 1), 1800)
  }

  const hasBackgroundField = (candidate) => [...candidate.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].some(match => {
    try { return JSON.parse(match[0].slice(0, match[0].lastIndexOf(':')).trim()) === 'background' }
    catch { return false }
  })
  const lenientCommand = (candidate) => {
    if (hasBackgroundField(candidate)) return null
    const paths = escapeLiteralWindowsPaths(candidate)
    if (paths.ambiguous) return null
    candidate = paths.repaired
    const command = readJsonishString(candidate, 'command')
    if (command === null || invalidCommandControls(command)) return null
    const description = readJsonishString(candidate, 'description')
    const timeoutMatch = candidate.match(/"timeout_seconds"\s*:\s*(\d+)/)
    return {
      command: command.trim(),
      description: (description ?? '').trim(),
      timeoutSeconds: normalizeTimeoutSeconds(timeoutMatch?.[1], command),
      rawJson: JSON.stringify({ command: command.trim(), description: (description ?? '').trim(), timeout_seconds: normalizeTimeoutSeconds(timeoutMatch?.[1], command) })
    }
  }

  let commandParseIssue = null
  const commandIssue = (code, field = '', offset = 0) => {
    commandParseIssue = { parseErrorCode: code, parseErrorField: field, parseErrorOffset: offset }
    return null
  }

  // Tokenize the envelope before decoding values. Regex field extraction cannot
  // distinguish a top-level flag from the word "background" inside shell text.
  const commandEnvelope = (candidate) => {
    let i = 0
    const fields = new Map()
    const space = () => { while (/\s/.test(candidate[i] || '') && i < candidate.length) i++ }
    const string = () => {
      const start = i++
      while (i < candidate.length) {
        const ch = candidate[i++]
        if (ch === '\\') { i++; continue }
        if (ch === '"') return candidate.slice(start, i)
      }
      throw new Error('invalid-json')
    }
    try {
      space()
      if (candidate[i++] !== '{') return null
      space()
      while (candidate[i] !== '}') {
        if (candidate[i] !== '"') throw new Error('invalid-json')
        const key = JSON.parse(string())
        if (fields.has(key)) return commandIssue('duplicate-field', key, i)
        space()
        if (candidate[i++] !== ':') throw new Error('invalid-json')
        space()
        const start = i
        if (candidate[i] === '"') string()
        else {
          let depth = 0
          while (i < candidate.length) {
            const ch = candidate[i]
            if (ch === '"') { string(); continue }
            if (depth === 0 && (ch === ',' || ch === '}')) break
            if (ch === '{' || ch === '[') depth++
            if (ch === '}' || ch === ']') depth--
            if (depth < 0) throw new Error('invalid-json')
            i++
          }
        }
        fields.set(key, { raw: candidate.slice(start, i).trim(), offset: start })
        space()
        if (candidate[i] !== ',') break
        i++
        space()
        // A trailing envelope comma is harmless; never alter string contents.
        if (candidate[i] === '}') break
      }
      if (candidate[i++] !== '}') throw new Error('invalid-json')
      space()
      if (i !== candidate.length) throw new Error('invalid-json')
      return fields
    } catch { return commandIssue('invalid-json', '', i) }
  }

  // Narrow recovery: an entire single-quoted Windows absolute path in a shell
  // command, with consistently literal separators. Mixed escaping or unknown
  // boundaries stay invalid. Decode JSON elsewhere normally (including \n).
  const invalidJsonEscape = (text) => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '\\') continue
      const next = text[++i]
      if ('"\\/bfnrt'.includes(next ?? '\u0000')) continue
      if (next === 'u' && /^[\da-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) { i += 4; continue }
      return true
    }
    return false
  }
  const invalidCommandControls = (command) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(command) ||
    [...command.matchAll(/'(?:[A-Za-z]:|\\\\)[^']*'/g)].some(match => /[\u0000-\u001f]/.test(match[0]))
  const escapeLiteralWindowsPaths = (raw) => {
    let changed = false
    let ambiguous = false
    const repaired = raw.replace(/'(?:[A-Za-z]:\\|\\\\)[^'"\r\n]*'/g, (path, offset) => {
      if (raw[offset - 1] === "'" || raw[offset + path.length] === "'") {
        ambiguous ||= invalidJsonEscape(path)
        return path
      }
      const body = path.slice(1, -1)
      const separators = body.startsWith('\\\\') ? body.slice(2) : body
      if (!invalidJsonEscape(body)) return path
      if (/\\{2,}/.test(separators)) { ambiguous = true; return path }
      changed = true
      return path.replace(/\\/g, '\\\\')
    })
    return { repaired, changed, ambiguous }
  }
  const recoverWindowsString = (raw) => {
    const { repaired, changed, ambiguous } = escapeLiteralWindowsPaths(raw)
    if (!changed || ambiguous) return null
    try { return JSON.parse(repaired) } catch { return null }
  }

  const toCommand = (candidate) => {
    const fields = commandEnvelope(candidate)
    if (!fields) {
      // Keep the historical foreground quote fallback, but never use it for a
      // flag-bearing or duplicate-field envelope whose execution mode is unclear.
      if (commandParseIssue?.parseErrorCode === 'duplicate-field' || hasBackgroundField(candidate)) return null
      const legacy = lenientCommand(candidate)
      if (legacy) commandParseIssue = null
      return legacy
    }
    const parsed = Object.create(null)
    let repaired = false
    for (const [key, field] of fields) {
      try { parsed[key] = JSON.parse(field.raw) }
      catch {
        const value = key === 'command' ? recoverWindowsString(field.raw) : null
        if (value === null) return commandIssue('invalid-json', key, field.offset)
        parsed[key] = value
        repaired = true
      }
    }
    if (typeof parsed.command !== 'string') return commandIssue('invalid-command', 'command')
    if ('background' in parsed && typeof parsed.background !== 'boolean') return commandIssue('invalid-background', 'background')
    if (parsed.background === true && !parsed.command.trim()) return commandIssue('invalid-command', 'command')
    if (('background_kind' in parsed || 'readiness' in parsed) && (parsed.background !== true ||
      !['job', 'service'].includes(parsed.background_kind) ||
      ('readiness' in parsed && (parsed.background_kind !== 'service' || !parsed.readiness || typeof parsed.readiness !== 'object' || Array.isArray(parsed.readiness))))) return commandIssue('invalid-background', 'background_kind')
    if (invalidCommandControls(parsed.command)) return commandIssue('invalid-command', 'command')
    commandParseIssue = null
    return {
      command: parsed.command.trim(),
      ...(parsed.background === true ? { background: true } : {}),
      ...(parsed.background_kind ? { backgroundOptions: { kind: parsed.background_kind, ...(parsed.readiness ? { readiness: parsed.readiness } : {}) } } : {}),
      description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
      timeoutSeconds: normalizeTimeoutSeconds(parsed.timeout_seconds, parsed.command),
      rawJson: JSON.stringify(parsed),
      ...(repaired ? { parseRepair: 'windows-path' } : {})
    }
  }

  /** Only the last command-shaped request may run; an invalid one never replays an older one. */
  const extractCommand = (rawText) => {
    commandParseIssue = null
    const text = String(rawText || '')
    if (!text) return null

    // Drop markdown code fences but keep their contents.
    const cleaned = text.replace(/^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/, '$1')
    const candidates = balancedObjects(cleaned, true)

    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (!/"command"\s*:/.test(candidates[i])) {
        if (hasBackgroundField(candidates[i]) || /"command"\s*$/.test(candidates[i])) return commandIssue('invalid-json')
        continue
      }
      // A malformed last request must not replay an earlier request in this answer.
      return toCommand(candidates[i])
    }

    /*
     * Some PowerShell replies contain a valid command value but put raw `"` characters
     * inside the outer JSON string, for example `$q + '"type"'`. `balancedObjects()` is
     * intentionally JSON-aware, so those quotes make it stop tracking the outer object
     * before `toCommand()` gets a candidate. The command field reader already handles this
     * common model mistake safely; give it the last command-shaped object as a fallback.
     */
    const starts = [...cleaned.matchAll(/\{\s*"command"\s*:/g)].map((match) => match.index ?? -1).filter((index) => index >= 0)
    for (let i = starts.length - 1; i >= 0; i -= 1) {
      if (hasBackgroundField(cleaned.slice(starts[i]))) return commandIssue('invalid-json')
      const parsed = lenientCommand(cleaned.slice(starts[i]))
      if (parsed) { commandParseIssue = null; return parsed }
    }
    return null
  }

  // Different page instances must not reuse a pending recovery token after reload.
  let commandFailureSerial = Math.floor(Math.random() * 0x100000000) * 100000
  const commandParseFailed = (node, messageId, input) => {
    if (state.lastUnparsedMessageId === messageId) return
    state.lastUnparsedMessageId = messageId
    const live = state.enabled && state.awaitingReplySince !== 0 && !state.replyActionDetected
    const attempts = balancedObjects(input.text)
    const issue = input.issue || commandParseIssue || { parseErrorCode: 'invalid-json', parseErrorField: '', parseErrorOffset: 0 }
    const failure = { messageId, token: ++commandFailureSerial, generation: state.taskPromptGeneration,
      path: location.pathname, ...issue, status: state.commandRecoveryUsed ? 'failed' : 'pending' }
    if (live) {
      state.failedCommand = failure
      // The model has finished this reply. It is no longer generating a command.
      setReplyWaiting(0, 'command-format-error', messageId)
    }
    report({ event: 'parse-failed', messageId, live, ...issue, commandSource: input.source,
      parseFailureToken: failure.token, recoveryStatus: failure.status,
      text: input.text.slice(0, 20000), textLength: input.text.length, objectCount: attempts.length,
      lastObject: attempts.at(-1)?.slice(0, 1200) ?? null })
  }

  const looksLikeReadFilesReply = (text) => /"type"\s*:\s*"read_files"/.test(String(text || ''))
  const extractReadFiles = (text) => {
    const candidates = balancedObjects(String(text || '').replace(/```[a-zA-Z0-9_-]*/g, '\n'))
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      let request
      try { request = JSON.parse(candidates[i]) } catch (_) { continue }
      if (!request || request.type !== 'read_files' || 'command' in request || 'questions' in request) continue
      // DSML's paths alias is removed only when it supplied the sole valid path list.
      if ('paths' in request) return null
      if (!Array.isArray(request.files) || request.files.length < 1 || request.files.length > 3) return null
      if (typeof request.description !== 'string' || !request.description.trim() || request.description.length > 2000) return null
      const files = []
      for (const item of request.files) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null
        if (typeof item.path !== 'string' || !item.path.trim() || item.path.length > 4096 || /[\u0000-\u001f]/.test(item.path)) return null
        // Match the main-process parser, including older replies: always upload
        // the complete file; legacy text/range/encoding options are discarded.
        files.push({ path: item.path.trim() })
      }
      return { files, description: request.description.trim() }
    }
    return null
  }

  // Questions have their own discriminator. Never send a question-shaped object
  // through the lenient command parser, even if it also contains a command field.
  const looksLikeQuestionReply = (text) => /"type"\s*:\s*"questions?"/.test(String(text || ''))
  // Options are strings, but models also write {"label","description"}; both become one line.
  const questionOption = (option) => {
    if (typeof option === 'string') return option.trim()
    if (!option || typeof option !== 'object' || typeof option.label !== 'string') return ''
    const label = option.label.trim()
    const description = typeof option.description === 'string' ? option.description.trim() : ''
    const text = label && description ? `${label}：${description}` : label
    return text.length > 300 ? `${text.slice(0, 299)}…` : text
  }
  /** A parsed question/questions object as dialog pages, or null when any part is unusable. */
  const questionPages = (parsed) => {
    if (!parsed || (parsed.type !== 'question' && parsed.type !== 'questions') || 'command' in parsed) return null
    const items = parsed.type === 'questions'
      ? parsed.questions
      : [{ question: parsed.question, placeholder: parsed.placeholder, options: parsed.options }]
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) return null
    const questions = []
    for (const item of items) {
      if (!item || typeof item !== 'object') return null
      if (typeof item.question !== 'string' || !item.question.trim() || item.question.length > 16000) return null
      if (item.placeholder !== undefined && (typeof item.placeholder !== 'string' || item.placeholder.length > 1000)) return null
      if (item.options !== undefined && (!Array.isArray(item.options) || item.options.length > 8)) return null
      const options = (item.options || []).map(questionOption)
      if (options.some((option) => !option || option.length > 300)) return null
      questions.push({ question: item.question.trim(), placeholder: (item.placeholder || '').trim(), options })
    }
    return { questions }
  }
  const extractQuestion = (rawText) => {
    // The string-aware scanner ignores outer fences while preserving Markdown
    // fences inside question values. Replacing them before JSON.parse corrupts
    // the string and prevents a multiline command from reaching the dialog.
    const candidates = balancedObjects(String(rawText || ''))
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      for (const attempt of [candidates[i], repairJson(candidates[i])]) {
        let parsed
        try {
          parsed = JSON.parse(attempt)
        } catch (_) {
          continue
        }
        if (!parsed || (parsed.type !== 'question' && parsed.type !== 'questions')) continue
        const question = questionPages(parsed)
        // The model's own JSON is kept so 重新执行指令 can show and replay exactly what it sent.
        return question ? { ...question, rawJson: attempt } : null
      }
    }
    return null
  }

  /**
   * A command-shaped reply must never fall through to the clean transcript. DeepSeek can
   * render the command before its final streamed text is stable, and its rendered turn key
   * may then differ from the key reported with the command event. The content marker is the
   * reliable safety net in that case; the main process also applies the same guard at insert
   * time for pages that report an assistant turn through another path.
   */
  const looksLikeScheduledReply = (text) => /"type"\s*:\s*"scheduled_task"/.test(String(text || ''))
  const looksLikeMailReply = (text) => /"type"\s*:\s*"send_email"/.test(String(text || ''))
  const looksLikeToolPromptReadReply = (text) => /"type"\s*:\s*"read_tool_prompt"/.test(String(text || ''))
  const looksLikeCommandReply = (text) => /\{\s*["']command["']\s*:\s*["']/s.test(String(text || '')) || looksLikeReadFilesReply(text) || looksLikeScheduledReply(text) || looksLikeMailReply(text) || looksLikeToolPromptReadReply(text)

  // Reading a tool definition has no side effect, so a request inside a short explanation is
  // still honoured. Malformed requests go to main, which answers with the expected format.
  const checkToolPromptRead = (messageId, text) => {
    if (!looksLikeToolPromptReadReply(text)) return false
    if (!state.enabled || state.awaitingReplySince === 0 || !mailSourceSubmissionId) {
      state.lastCommandMessageId = messageId
      return true
    }
    const candidates = balancedObjects(String(text)).filter((raw) => {
      try { return JSON.parse(raw)?.type === 'read_tool_prompt' } catch (_) { return false }
    })
    const rawJson = candidates.length === 1 && candidates[0].length <= 4000 ? candidates[0] : '{"type":"read_tool_prompt","invalid":true}'
    state.lastCommandMessageId = messageId
    state.replyActionDetected = true
    setReplyWaiting(0, 'tool-prompt-read-detected', messageId)
    report({ event: 'tool-prompt-read', messageId, rawJson, live: true,
      sourceSubmissionId: mailSourceSubmissionId, taskPromptGeneration: state.taskPromptGeneration,
      pagePath: location.pathname, computerPageEpoch })
    return true
  }

  const checkMailNotification = (messageId, text) => {
    if (!looksLikeMailReply(text)) return false
    if (!state.enabled || state.awaitingReplySince === 0 || !mailSourceSubmissionId) {
      state.lastCommandMessageId = messageId
      return true
    }
    // The scanner already ignores outer Markdown fences. Replacing fences would
    // corrupt code snippets inside a JSON body. Malformed/mixed requests go to
    // main for a failure receipt and can never fall through to another tool.
    const candidates = balancedObjects(String(text))
    let rawJson = candidates.length === 1 ? candidates[0] : String(text)
    if (candidates.length === 1) {
      const outside = String(text).replace(candidates[0], '').replace(/```(?:json)?/gi, '')
        .replace(/^(?:json|Copy code|复制代码|复制)\s*$/gim, '').trim()
      // A schema example inside a normal explanation is not a send instruction.
      if (outside) rawJson = '{"type":"send_email","invalid":true}'
    }
    if (rawJson.length > 125000) rawJson = '{"type":"send_email","invalid":true}'
    state.lastCommandMessageId = messageId
    state.replyActionDetected = true
    setReplyWaiting(0, 'mail-notification-detected', messageId)
    report({ event: 'mail-notification', messageId, rawJson, live: true,
      sourceSubmissionId: mailSourceSubmissionId, taskPromptGeneration: state.taskPromptGeneration,
      pagePath: location.pathname, computerPageEpoch })
    return true
  }

  // Older transcript rows were saved before the page's inline-code marker was
  // understood. Refresh only turns with a stable page id: the main process updates
  // existing rows by that id, and never creates history rows from a page scan.
  const reportedHistoryMarkdown = new Map()
  const syncRenderedAssistantHistory = () => {
    if (!PAGE.messageIdAttr || findStopButton()) return
    for (const node of queryAllAssistant()) {
      if (!isAssistantTurn(node) || replyIsGenerating(node)) continue
      const messageId = messageIdOf(node)
      if (!messageId) continue
      const text = readReplyMarkdown(node)
      if (!text || looksLikeCommandReply(text) || looksLikeQuestionReply(text) || looksLikeComputerReply(text) || looksLikeDsmlToolCall(text) || reportedHistoryMarkdown.get(messageId) === text) continue
      reportedHistoryMarkdown.set(messageId, text)
      report({ event: 'assistant-history-markdown', messageId, text })
    }
  }
  const scheduleRenderedAssistantHistory = () => {
    if (!PAGE.messageIdAttr) return
    setTimeout(syncRenderedAssistantHistory, 800)
    setTimeout(syncRenderedAssistantHistory, 2800)
  }

  let settleTimer = null
  /** The last live command reported, so a reply that keeps growing cannot report it twice. */
  let lastLiveCommand = null
  let lastReplyScanAt = 0
  let lastReplyMutationAt = 0

  const scheduleCheck = () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      checkForCommand()
    }, REPLY_SETTLE_MS)
  }

  /**
   * Record why a settled reply produced no command, including changes within that same reply.
   *
   * WHY THIS EXISTS. Every early return in `checkForCommand` below is silent, and between them
   * they cover the whole distance from "the reply is on screen" to "a command ran". So when a
   * model answers with a perfectly good JSON block and nothing happens, there is nothing
   * anywhere to read: not in the app log, not in the terminal, not in the UI. That is not a
   * hypothetical — it is why this was added, after a DeepSeek reply sat there unexecuted with
   * only three `injected` lines in the log to show for the session.
   *
   * Suppress unchanged snapshots, not just repeated message ids/reasons. A cached old turn
   * can keep returning "already-handled" even after a visible JSON reply arrives elsewhere.
   */
  let lastScanNote = ''
  const noteScan = (messageId, reason, extra) => {
    const key = JSON.stringify([
      location.pathname, messageId, reason, state.enabled, state.awaitingReplySince !== 0,
      state.taskActive, state.taskPromptGeneration, state.lastCommandMessageId,
      state.pendingQuestion !== null, replyScanSnapshot
    ])
    if (key === lastScanNote) return
    lastScanNote = key
    report({ event: 'scan', reason, messageId, ...extra })
  }

  const diagnosticReplyKind = (text) => !text.trim() ? 'empty' : looksLikeComputerReply(text) ? 'computer' : looksLikeQuestionReply(text) ? 'questions' :
    looksLikeReadFilesReply(text) ? 'read-files' : looksLikeCommandReply(text) ? 'command' : 'prose'

  /** Compare the scanner's chosen node with rendered answers; never change its decisions. */
  const snapshotReplyScan = (node, nodes) => {
    try {
      const text = readReplyText(node)
      const replyRoot = replyRootOf(node)
      const toolbar = composerToolbarRoot()
      const streaming = node && PAGE.replyStreamingAttribute ? node.getAttribute(PAGE.replyStreamingAttribute) : null
      const renderedTurns = nodes.filter(isVisibleElement)
      const lastMatchedTurn = nodes[nodes.length - 1] || null
      const visibleTurns = renderedTurns.filter(isAssistantTurn)
      const lastVisibleTurn = visibleTurns[visibleTurns.length - 1] || null
      const lastVisibleText = readReplyText(lastVisibleTurn)
      // Query answer markers independently: a new reply may lack the wrapper/id selector.
      const visibleAnswers = queryAll(PAGE.assistantReplySelectors).filter(isVisibleElement)
      const visibleAnswer = visibleAnswers[visibleAnswers.length - 1] || null
      const visibleAnswerText = String(visibleAnswer?.innerText || '')
      const visibleAnswerOwner = visibleAnswer && PAGE.assistantSelectors
        .map((selector) => visibleAnswer.closest(selector)).find(Boolean)
      return {
        replySnapshotAvailable: true,
        assistantTurnCount: nodes.length,
        hiddenTurnCount: nodes.length - renderedTurns.length,
        lastMatchedMessageId: lastMatchedTurn ? turnKeyOf(lastMatchedTurn) : null,
        selectedFromRenderedTurns: PAGE.ignoreHiddenReplyNodes === true,
        replyTextLength: text.length,
        replyKind: diagnosticReplyKind(text),
        answerMarkerFound: !!node && PAGE.assistantReplySelectors.some((selector) => node.matches(selector) || node.querySelector(selector)),
        replyRootIsTurn: !!node && replyRoot === node,
        selectedNodeVisible: isVisibleElement(node),
        selectedReplyVisible: isVisibleElement(replyRoot),
        selectedNodeTextLength: String(node?.innerText || '').length,
        replyTextContentLength: String(replyRoot?.textContent || '').length,
        visibleAssistantTurnCount: visibleTurns.length,
        lastVisibleMessageId: lastVisibleTurn ? turnKeyOf(lastVisibleTurn) : null,
        selectedMatchesLastVisible: !!node && node === lastVisibleTurn,
        lastVisibleReplyTextLength: lastVisibleText.length,
        lastVisibleReplyKind: diagnosticReplyKind(lastVisibleText),
        lastVisibleReplyCodeBlockCount: lastVisibleTurn ? lastVisibleTurn.querySelectorAll('pre').length : 0,
        visibleAnswerMarkerCount: visibleAnswers.length,
        visibleAnswerOwnerMessageId: visibleAnswerOwner ? turnKeyOf(visibleAnswerOwner) : null,
        visibleAnswerTextLength: visibleAnswerText.length,
        visibleAnswerKind: diagnosticReplyKind(visibleAnswerText),
        visibleAnswerCodeBlockCount: visibleAnswer ? visibleAnswer.querySelectorAll('pre').length : 0,
        visibleCodeBlockCount: [...document.querySelectorAll('pre')].filter(isVisibleElement).length,
        codeBlockCount: node ? node.querySelectorAll('pre').length : 0,
        replyStreamingState: streaming === null ? 'missing' : streaming === 'true' || streaming === 'false' ? streaming : 'unknown',
        stopButtonFound: queryFirstVisible(PAGE.stopButtonSelectors, toolbar || document) !== null,
        stopButtonOnPage: queryFirstVisible(PAGE.stopButtonSelectors) !== null,
        composerFound: getComposer() !== null,
        toolbarRootFound: toolbar !== null
      }
    } catch (_) {
      return { replySnapshotAvailable: false }
    }
  }

  /**
   * A reply the SERVER cut off (DeepSeek: 服务器暂时不可用 → 已停止 → 继续生成).
   *
   * Without this the partial text settles like any other reply: prose is saved as the final
   * answer and the task ends, or a thinking-only turn simply sits there, and auto mode stalls
   * until the user presses the button. Pressing it is what the user would do.
   *
   * Only while the app is waiting for its OWN reply, so a restored conversation's old
   * stopped turn is never resumed. Only a button inside or after the newest turn, so an
   * earlier turn's leftover control is history. Cooldown between presses because the
   * retry needs time to restart the stream; a cap because a server that keeps failing must
   * eventually hand the partial reply back to the normal path instead of looping forever.
   */
  const CONTINUE_COOLDOWN_MS = 5000
  const CONTINUE_LIMIT = 5
  let continueAttempts = { since: 0, count: 0, at: 0 }
  let continueTimer = null

  const findContinueButton = (latest) => {
    const labels = PAGE.continueButtonLabels || []
    if (labels.length === 0) return null
    const matches = [...document.querySelectorAll(CONTROL_SELECTOR)].filter((element) =>
      labels.includes(collapse(element.innerText)) && isVisibleElement(element) && !controlDisabled(element))
    const button = matches[matches.length - 1] || null
    if (!button || !latest || latest.contains(button)) return button
    return latest.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING ? null : button
  }

  /** @returns true while the cut-off reply is being resumed and must not be read as final. */
  const continueCutOffReply = (latest) => {
    if (state.awaitingReplySince === 0 || state.pendingQuestion || findStopButton()) return false
    const button = findContinueButton(latest)
    if (!button) return false
    if (continueAttempts.since !== state.awaitingReplySince) {
      continueAttempts = { since: state.awaitingReplySince, count: 0, at: 0 }
    }
    if (continueAttempts.count >= CONTINUE_LIMIT) {
      if (continueAttempts.count === CONTINUE_LIMIT) {
        continueAttempts.count += 1
        report({ event: 'continue-generation', reason: 'continue-limit', attempt: CONTINUE_LIMIT })
      }
      return false
    }
    const wait = continueAttempts.at + CONTINUE_COOLDOWN_MS - Date.now()
    if (wait <= 0) {
      continueAttempts.count += 1
      continueAttempts.at = Date.now()
      /*
       * The press itself is made by the main process, as a real mouse click at the point
       * reported here. A script-dispatched click is untrusted, and DeepSeek ignores it: on
       * 2026-10-22 five `pressButton` presses in a row produced no DOM mutation at all.
       *
       * Only a point that actually lands on the button is reported — never a click on
       * whatever covers it — and never a control that is also a send button, because the
       * capturing click interceptor would then compose and submit the prompt.
       */
      try { button.scrollIntoView({ block: 'nearest' }) } catch (_) { /* measured as-is */ }
      const rect = button.getBoundingClientRect()
      const x = Math.round(rect.left + rect.width / 2)
      const y = Math.round(rect.top + rect.height / 2)
      const hit = document.elementFromPoint(x, y)
      const reachable = !!hit && (hit === button || button.contains(hit)) &&
        !PAGE.sendButtonSelectors.some((selector) => button.closest(selector))
      report({
        event: 'continue-generation',
        reason: reachable ? 'continue-clicked' : 'continue-unreachable',
        attempt: continueAttempts.count,
        ...(reachable ? { x, y } : {})
      })
    }
    // A press that changes nothing renders no mutation, so re-check on a timer.
    if (continueTimer) clearTimeout(continueTimer)
    continueTimer = setTimeout(() => {
      continueTimer = null
      scheduleCheck()
    }, wait > 0 ? wait : CONTINUE_COOLDOWN_MS)
    return true
  }

  /**
   * A reply the SITE ended by itself mid-thinking: the reasoning header reads 已停止, no answer was
   * written and no 继续生成 control is offered. Without an answer marker the turn never passes the
   * role check below, so the wait for our own reply would hang until something else ends the task.
   *
   * Send 继续, as the user would — only during our own live wait, only after the turn has stayed
   * stopped for STOPPED_SETTLE_MS, never after the user pressed stop themselves, and at most
   * STOPPED_LIMIT times in a row (a real answer resets the count).
   */
  const STOPPED_SETTLE_MS = 4000
  const STOPPED_LIMIT = 3
  let stoppedReply = { key: '', at: 0 }
  let stoppedContinues = 0
  let userStoppedAt = 0
  const stoppedReasoning = (node) => {
    const labels = PAGE.stoppedReplyLabels || []
    const reasoning = (PAGE.focus?.reasoningSelectors || []).map((selector) => node.querySelector(selector)).find(Boolean)
    if (!labels.length || !reasoning || PAGE.assistantReplySelectors.some((selector) => node.matches(selector) || node.querySelector(selector))) return false
    return [...node.querySelectorAll('div, span')].some((element) => !reasoning.contains(element) && labels.includes(collapse(element.textContent)))
  }
  const continueStoppedReply = (node) => {
    if (state.awaitingReplySince === 0 || !state.enabled || !state.taskActive || state.pendingQuestion || state.programmatic ||
        userStoppedAt >= state.awaitingReplySince || findStopButton() || replyIsGenerating(node) || !stoppedReasoning(node)) {
      stoppedReply = { key: '', at: 0 }
      return false
    }
    const key = turnKeyOf(node), now = Date.now()
    if (key === state.lastCommandMessageId) return false // Already answered with 继续 (or handled otherwise).
    if (stoppedReply.key !== key) {
      stoppedReply = { key, at: now }
      setTimeout(scheduleCheck, STOPPED_SETTLE_MS) // A stopped turn renders no further mutation to wake the scan.
      return true
    }
    if (now - stoppedReply.at < STOPPED_SETTLE_MS) return true
    if (stoppedContinues >= STOPPED_LIMIT) {
      noteScan(key, 'stopped-continue-limit')
      return false
    }
    stoppedContinues += 1
    stoppedReply = { key: '', at: 0 }
    state.lastCommandMessageId = key
    const attempt = stoppedContinues
    void window[STATE_KEY].sendRaw('继续', null, { path: location.pathname, generation: state.taskPromptGeneration })
      .then((outcome) => {
        // A refused send (busy page, draft) may be retried by a later scan, within the same limit.
        if (outcome !== 'ok' && state.lastCommandMessageId === key) state.lastCommandMessageId = null
        report({ event: 'continue-generation', reason: outcome === 'ok' ? 'stopped-continue-sent' : 'stopped-continue-failed', attempt, outcome })
      })
    return true
  }

  /**
   * Runs after the reply has been quiet for REPLY_SETTLE_MS. Only the LAST
   * assistant message is considered, and each message id is reported at most
   * once — the main process does the durable deduplication against SQLite.
   */
  const checkForCommand = () => {
    lastReplyScanAt = Date.now()
    replyScanSnapshot = {}
    if (focusEditing || focusModeChanging) return
    // Confirm our submitted user turn before accepting a fast next assistant action.
    if (fileSend?.submitted) {
      fileSendStatus(fileSend.token)
      if (fileSend?.submitted) return
    }
    const nodes = queryAllAssistant()
    const node = latestReplyNode(nodes)
    replyScanSnapshot = snapshotReplyScan(node, nodes)
    if (nodes.length === 0) {
      noteScan('', 'no-turns', { selectors: PAGE.assistantSelectors })
      return
    }

    if (!node) {
      noteScan('', 'no-visible-turns')
      return
    }
    // Before the role check: a turn cut off while thinking may have no answer marker yet.
    if (continueCutOffReply(node)) return
    if (continueStoppedReply(node)) return

    /*
     * Only assistant turns count, and this is checked FIRST.
     *
     * The turn selector is "one element per turn, either role" — it has to be, because a
     * role is not always marked. The USER's own message is not a reply, and on a site whose
     * turns are plain divs it is otherwise indistinguishable: the app would try to parse the
     * user's own words as a command, and would consume the awaiting flag with them.
     *
     * Before the turn key, so a user turn never becomes `lastAssistantId` and never spends a
     * content hash.
     */
    if (!isAssistantTurn(node)) {
      /*
       * Usually correct — the newest turn is the user's own message. But it is ALSO exactly
       * what a reply marker that stopped matching looks like, and the two are indistinguishable
       * from the outside without this note. Its `tag`/`cls` say which one it was.
       */
      noteScan(turnKeyOf(node), 'not-assistant-turn', {
        tag: node.tagName.toLowerCase(),
        cls: String(node.className || '').slice(0, 120),
        wanted: PAGE.assistantRoleSelectors?.length ? PAGE.assistantRoleSelectors : PAGE.assistantReplySelectors
      })
      return
    }

    /*
     * `turnKeyOf`, never a raw attribute read.
     *
     * This used to be `messageIdOf(node) || ''` followed by `if (!messageId) return` —
     * which on a site without the attribute means the function returns immediately,
     * forever: no command is ever detected, and nothing anywhere reports a problem. That
     * is the exact failure this guard exists to prevent now.
     */
    stoppedContinues = 0 // A reply with an answer ends a run of automatic 继续.
    const messageId = turnKeyOf(node)
    if (!messageId) {
      // `turnKeyOf` only returns '' for a turn that renders no text at all, so this is a
      // placeholder rather than a reply — worth one line, because it is also what an empty
      // identity would look like if that function ever regressed.
      noteScan('', 'no-key', { cls: String(node.className || '').slice(0, 120) })
      return
    }
    if (messageId === state.lastCommandMessageId && !(PAGE.computerUseRequests === true &&
      computerWaitCurrent(computerReplyWait) && computerTurnIsNew(node, computerReplyWait) &&
      looksLikeComputerReply(readComputerText(node)))) {
      /*
       * Already dealt with — routinely correct, since the observer re-runs on every mutation.
       *
       * But it is ALSO what this turn looks like after the branch below has marked it handled
       * EARLY, while the model was merely pausing mid-reply. That mistake is invisible from
       * here and total: the real command in the same turn can never be parsed afterwards,
       * because this guard returns first, every time, silently. One note per turn is what makes
       * the two cases tellable apart.
       */
      noteScan(messageId, 'already-handled')
      return
    }

    /*
     * The narrowed answer text, never the whole turn: on DeepSeek the turn's text starts
     * with its reasoning and search citations, and that reasoning contains `ds-markdown`
     * blocks with braces and quoted JSON of its own — perfectly capable of parsing as a
     * command the model never issued to us.
     */
    const text = readReplyText(node)
    if (replyIsGenerating(node)) {
      noteScan(messageId, 'still-generating')
      return
    }
    if (checkComputerRequest(node, messageId)) return
    if (checkMailNotification(messageId, text)) return
    if (checkToolPromptRead(messageId, text)) return
    if (looksLikeScheduledReply(text)) {
      if (state.awaitingReplySince === 0 || !state.enabled) { state.lastCommandMessageId = messageId; return }
      const candidates = balancedObjects(String(text).replace(/```[a-zA-Z0-9_-]*/g, '\n')).filter(raw => {
        try { return JSON.parse(raw)?.type === 'scheduled_task' } catch (_) { return false }
      })
      if (candidates.length !== 1 || candidates[0].length > 25000) {
        if (state.lastUnparsedMessageId !== messageId) {
          state.lastUnparsedMessageId = messageId
          report({ event: 'parse-failed', reason: 'invalid-scheduled-task', text: text.slice(0, 2000) })
        }
        return
      }
      // The latest human send, answers included: main admits a plan only from the submission it saw last.
      const sourceSubmissionId = mailSourceSubmissionId
      state.lastCommandMessageId = messageId
      state.replyActionDetected = true
      setReplyWaiting(0, 'scheduled-task-detected', messageId)
      report({ event: 'scheduled-task', messageId, rawJson: candidates[0], live: true,
        sourceSubmissionId, pagePath: location.pathname, computerPageEpoch })
      return
    }
    if (looksLikeReadFilesReply(text)) {
      const parsed = extractReadFiles(text)
      if (!parsed) {
        commandParseFailed(node, messageId, { text, source: 'rendered', issue: {
          reason: 'invalid-read-files', parseErrorCode: 'invalid-read-files', parseErrorField: 'files', parseErrorOffset: 0
        } })
        return
      }
      state.lastCommandMessageId = messageId
      state.replyActionDetected = state.enabled
      state.failedCommand = null
      state.commandRecoveryUsed = false
      if (state.enabled) report({ event: 'read-files', messageId, ...parsed, rawJson: text, live: state.awaitingReplySince !== 0,
        ...(state.awaitingReplySince !== 0 ? legacyTaskSource(node) : {}) })
      return
    }
    if (looksLikeQuestionReply(text)) {
      // Live clarification continues even when terminal command execution is disabled.
      if (state.awaitingReplySince === 0) {
        state.lastCommandMessageId = messageId
        noteScan(messageId, 'question-not-live')
        // Not asked again, but kept for 重新执行指令 — an old question can still be replayed.
        const history = extractQuestion(text)
        if (history) report({ event: 'question-history', messageId, rawJson: history.rawJson })
        return
      }
      const question = extractQuestion(text)
      if (!question) {
        if (state.lastUnparsedMessageId !== messageId) {
          state.lastUnparsedMessageId = messageId
          report({ event: 'parse-failed', text: text.slice(0, 2000), reason: 'invalid-question' })
        }
        return
      }
      state.lastCommandMessageId = messageId
      const provenance = legacyTaskSource(node)
      const taskSource = provenance.sourceSubmissionId ? { ...provenance, pageEpoch: computerPageEpoch } : null
      setReplyWaiting(0, 'question-detected', messageId)
      state.pendingQuestion = { messageId, ...question, taskSource }
      report({ event: 'question', messageId, ...question, live: true, questionSource: taskSource })
      // Keep readable questions in the app transcript, rather than the transport JSON.
      report({
        event: 'assistant-message',
        messageId,
        text: question.questions.map((item, index) => `${index + 1}. ${item.question}`).join('\n')
      })
      return
    }
    if (state.pendingQuestion) return
    const commandInput = readCommandText(node)
    const parsed = extractCommand(commandInput.text)

    // Nothing runnable yet. Deliberately do NOT mark it handled and do NOT
    // consume the awaiting flag: ChatGPT renders the assistant turn — and keeps
    // re-rendering it — before any text arrives, so the first thing seen after a
    // send is usually an empty placeholder turn. Consuming the flag there made
    // the real reply look like restored history.
    if (!parsed) {
      // Do not persist an unparseable or still-streaming command as ordinary assistant prose.
      // Leaving it unhandled lets a later DOM mutation retry the parser; the DB guard prevents
      // the same class of leak if the page reports the turn by another route.
      if (looksLikeCommandReply(text)) {
        commandParseFailed(node, messageId, commandInput)
        return
      }
      // Only complain about a reply that is actually FINISHED. An unbalanced brace
      // count means it is still streaming, and reporting then is a pure false
      // alarm: the very first fragment of a command is `{"command":"`, which
      // parses as nothing and looks exactly like a malformed reply.
      const opens = (text.match(/\{/g) || []).length
      const closes = (text.match(/\}/g) || []).length
      const finished = opens > 0 && opens === closes

      if (finished && state.lastUnparsedMessageId !== messageId && /"command"\s*:/.test(text)) {
        /*
         * The WHOLE reply, not the first 300 characters.
         *
         * The terminal line the user sees quotes 160 characters and then asserts "多半是引号没转义"
         * — a guess baked into the message text, and one that is wrong often enough to matter.
         * What actually answers "which character broke this" is the text JSON.parse choked on,
         * plus the object that was extracted to feed it. Both are cheap, and 300 characters did
         * not even reach the end of the `command` value.
         */
        commandParseFailed(node, messageId, commandInput)
        return
      }

      // Commit only a settled final answer. Keep the wait owned until the
      // delayed Markdown read confirms that generation has not resumed.
      if (text.trim() && state.awaitingReplySince !== 0 && pendingAssistantCompletion?.messageId !== messageId) {
        const completion = { messageId, path: location.pathname, generation: state.taskPromptGeneration }
        pendingAssistantCompletion = completion
        // ChatGPT can remove the stop control before its Markdown renderer has
        // replaced the final plain text with <code>/<strong>/<table> nodes. Read
        // once more after that DOM pass so the database keeps the formatting.
        setTimeout(() => {
          if (pendingAssistantCompletion !== completion) return
          pendingAssistantCompletion = null
          if (completion.path !== location.pathname || completion.generation !== state.taskPromptGeneration ||
              state.awaitingReplySince === 0 || state.pendingQuestion) return
          const nodes = queryAllAssistant()
          const latest = latestReplyNode(nodes)
          if (!latest || !isAssistantTurn(latest) || !latest.isConnected) return
          if (continueCutOffReply(latest)) return
          if (replyIsGenerating(latest) || turnKeyOf(latest) !== messageId || readReplyText(latest) !== text) {
            scheduleCheck()
            return
          }
          // A leaked moderation verdict is not the model's answer: resend instead of ending the task.
          if (handleSafetyLeak(messageId, text)) return
          const markdown = readReplyMarkdown(latest) || text
          const completed = /^(?:#{1,6}\s*)?(?:\*\*)?(?:【任务完成】|任务完成(?=$|[\s。！!：:]))/.test(text.trimStart())
          // Capture the live reply's owner before clearing its wait and advancing the page generation.
          const completionSource = completed ? legacyTaskSource(latest) : {}
          replyScanSnapshot = snapshotReplyScan(latest, nodes)
          state.lastCommandMessageId = messageId
          setReplyWaiting(0, 'non-command-reply', messageId)
          if (completed) {
            state.taskActive = false
            resetTaskPrompt()
          }
          report({ event: 'assistant-message', messageId, text: markdown })
          report({ event: 'task-finished', messageId, completed, live: true,
            taskPromptGeneration: completion.generation, pagePath: completion.path,
            ...completionSource, computerPageEpoch })
        }, 250)
      }

      /*
       * The catch-all, and the one that would have answered the question this was written for.
       *
       * A site with neither a stop button nor a streaming attribute cannot tell "still
       * streaming, just quiet" from "finished". DeepSeek has neither, so a pause longer
       * than REPLY_SETTLE_MS mid-reply can be taken as final, the turn
       * is marked handled, and the command that arrives afterwards is skipped forever by the
       * `already-handled` guard. The three fields below are what separate that from an ordinary
       * "the model wrote prose and meant nothing by it".
       */
      noteScan(messageId, 'no-command', {
        textHead: collapse(text).slice(0, 120),
        bracesBalanced: finished,
        awaitingReply: state.awaitingReplySince !== 0
      })

      return
    }

    // "Have we sent anything in this page view?" — NOT consumed here.
    //
    // Consuming it on the first report is what made the flag misfire: any earlier
    // quiet period (ChatGPT renders the assistant turn before its text arrives)
    // ate the flag, and the real reply then looked like restored history. It is
    // only reset when history is actually being loaded, i.e. by armBaseline().
    // A parseable command is not necessarily a finished reply. ChatGPT can pause
    // long enough for REPLY_SETTLE_MS while it is still streaming; executing here
    // would let the shell finish before the current assistant turn is done, so the
    // raw result gets inserted into a composer that ChatGPT still refuses to send.
    // The stop button disappearing mutates the DOM and schedules another check.
    // Terminal mode is off: treat the reply as ordinary chat and never report it as a command.
    if (!state.enabled) {
      state.lastCommandMessageId = messageId
      noteScan(messageId, 'terminal-mode-off')
      return
    }
    const live = state.awaitingReplySince !== 0
    /*
     * The same command from the same turn, during the same wait, is the same command.
     *
     * Without a stable message id the turn key is a content hash, so a reply that grows after
     * it looked settled gets a NEW key. Measured on DeepSeek, 2026-10-22: the answer went from
     * 721 to 762 characters a second after its command was reported, with no stop button on
     * either scan, and the identical 671-character command ran twice. The row position covers
     * a turn element the site remounts while it grows.
     */
    const position = PAGE.fileTurnPositionAttr ? node.getAttribute(PAGE.fileTurnPositionAttr) : null
    if (live && lastLiveCommand && lastLiveCommand.since === state.awaitingReplySince &&
        (lastLiveCommand.node === node || (position && lastLiveCommand.position === position)) &&
        lastLiveCommand.command === parsed.command && lastLiveCommand.description === parsed.description &&
        lastLiveCommand.background === (parsed.background === true) && JSON.stringify(lastLiveCommand.backgroundOptions) === JSON.stringify(parsed.backgroundOptions)) {
      state.lastCommandMessageId = messageId
      noteScan(messageId, 'duplicate-command')
      return
    }
    if (live) {
      lastLiveCommand = {
        since: state.awaitingReplySince, node, position, command: parsed.command, description: parsed.description,
        background: parsed.background === true, backgroundOptions: parsed.backgroundOptions
      }
    }
    state.lastCommandMessageId = messageId
    state.replyActionDetected = true
    state.failedCommand = null
    state.commandRecoveryUsed = false

    report({
      event: 'command',
      messageId,
      command: parsed.command,
      background: parsed.background === true,
      backgroundOptions: parsed.backgroundOptions,
      commandSource: commandInput.source,
      parseRepair: parsed.parseRepair,
      description: parsed.description,
      timeoutSeconds: parsed.timeoutSeconds,
      rawJson: parsed.rawJson,
      live,
      ...(live ? legacyTaskSource(node) : {})
    })
  }

  /**
   * The turn key of the newest ASSISTANT turn among the active reply candidates.
   *
   * `turnKeyOf` for the same reason as above: this value becomes
   * `state.lastCommandMessageId`, and a null there would disable the suppression that
   * stops a re-rendered old reply from looking fresh.
   *
   * Scans backwards past any user turn: on a site with unmarked roles the newest element
   * matching the turn selector is often the USER's message, and baselining against that
   * would leave the real reply looking like something we had already handled.
   */
  const lastAssistantId = () => {
    const nodes = replyCandidatesOf(queryAllAssistant())
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      if (isAssistantTurn(nodes[i])) return turnKeyOf(nodes[i])
    }
    return null
  }

  /**
   * Called when history is (re)loaded: a real conversation change, or a page
   * (re)load. It forgets what we have handled so the restored replies are
   * re-evaluated, and clears any stale "awaiting a reply" flag left over from
   * the conversation we came from.
   *
   * It resets unconditionally: deciding WHICH navigations count as "history is
   * being restored" belongs to the main process, which is the side that can see
   * the previous conversation id. Sending the first message of a new chat
   * creates the conversation, so that URL change must not land here.
   */
  const armBaseline = () => {
    if (focusModelCache) delete focusModelCache.firstSendGeneration
    setReplyWaiting(0, 'history-baseline')
    state.lastCommandMessageId = null
    state.pendingQuestion = null
    state.answerDraft = null
    state.failedCommand = null
    state.commandRecoveryUsed = false
    return true
  }

  /**
   * Force an immediate re-check of the last reply, bypassing the "already
   * handled" guard.
   *
   * Treated as live on purpose: this is the user explicitly asking to resume, so
   * in auto mode the command it finds should run.
   */
  const checkNow = () => {
    if (state.failedCommand?.status === 'uncertain') return false
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
    state.lastCommandMessageId = null
    state.lastUnparsedMessageId = null
    setReplyWaiting(Date.now(), 'manual-resume')
    state.taskActive = true
    checkForCommand()
    return true
  }

  // Block ChatGPT sidebar conversation links while the current task is active.
  document.addEventListener(
    'click',
    (event) => {
      if (!state.taskActive) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (!anchor) return
      const href = anchor.getAttribute('href') || ''
      if (!href.startsWith('/c/') && !/^https:\/\/chatgpt\.com\/c\//i.test(href)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true
  )

  let historyPath = location.pathname
  const observer = new MutationObserver(() => {
    lastReplyMutationAt = Date.now()
    scheduleCheck()
    if (location.pathname !== historyPath) {
      historyPath = location.pathname
      reportedHistoryMarkdown.clear()
      scheduleRenderedAssistantHistory()
    }
  })
  const observeReplyMutations = () => observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    // ChatGPT may create a turn node before assigning data-message-id. Without
    // observing that attribute, a fully rendered reply can remain invisible to
    // the scanner if no later text mutation happens. Claude can finish solely
    // by flipping data-is-streaming, without another text mutation.
    attributes: true,
    attributeFilter: pageReplyAttrs()
  })
  observeReplyMutations()

  /**
   * Last resort for 结束任务: click the composer's primary action, when nothing else found a
   * stop control.
   *
   * WHY THIS IS NOT A SELECTOR. DeepSeek gives its send and stop controls the SAME classes.
   * Measured while a reply was streaming: the primary control read
   *
   *   <div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle
   *                              ds-button--m ds-button--icon-relative-m _52c986b">
   *
   * with no `ds-button--disabled` — byte for byte what DeepSeek's SEND selector matches once the
   * composer holds text. The two states are told apart by the icon inside, and no CSS selector
   * can see an icon.
   *
   * So adding that selector to `stopButtonSelectors` is not the fix; it is the trap. It would
   * match an idle page too, and `checkForCommand` returns on its first line whenever
   * `findStopButton()` is truthy — the automation would stop detecting commands entirely, and
   * the symptom would look like the model refusing to cooperate.
   *
   * The composer being EMPTY is the discriminator, and only code can apply it: with nothing
   * typed, the primary action cannot be a send, so if it is live it is the stop control. That is
   * why this lives in `endTask` — an explicit "stop everything" from the user — and not in the
   * selector list that gates command parsing.
   *
   * Two guards, both needed:
   *
   *   - `awaitingReplySince` — a stop control only exists while a reply is pending. Without this
   *     the click would land on whatever the primary slot holds when idle, which on ChatGPT is
   *     the VOICE button: ending a task would start dictation.
   *   - empty composer — otherwise the click could submit a half-written draft.
   */
  /**
   * Explicit 继续原任务: the user chose to go on whatever the page was doing. Stop a streaming reply,
   * drop an open question and end a wait nothing will answer, so the recovery message can be sent.
   * Never touches what the user typed or attached: a draft still refuses the send.
   */
  const clearForResume = async () => {
    const until = async (ready, ms) => {
      const end = Date.now() + ms
      while (!ready() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 150))
      return ready()
    }
    if (state.programmatic || fileSend) await until(() => !state.programmatic && !fileSend, 3000)
    const generating = () => {
      if (findStopButton()) return true
      const latest = latestReplyNode(queryAllAssistant())
      return !!latest && replyIsGenerating(latest)
    }
    if (generating()) {
      const stop = findStopButton()
      if (stop) pressButton(stop)
      else clickPrimaryWhileWaiting()
      await until(() => !generating(), 5000)
    }
    if (state.pendingQuestion) {
      report({ event: 'question-cleared', messageId: state.pendingQuestion.messageId })
      state.pendingQuestion = null
      state.answerDraft = null
    }
    if (state.awaitingReplySince !== 0) setReplyWaiting(0, 'resume-forced')
  }
  // The last live desktop request reported to main, so main's refusal can end exactly that wait.
  let lastLiveComputer = null
  // Why the last human-task send was refused, for main to name the actual reason.
  let lastUserSendBlock = null

  const clickPrimaryWhileWaiting = () => {
    if (state.awaitingReplySince === 0) return null
    const element = getComposer()
    if (!element || collapse(readComposer(element)) !== '') return null
    const candidate = lastToolbarControl()
    if (!candidate) return null

    /*
     * `programmatic` MUST be set around this click, and leaving it out was a real bug.
     *
     * The primary action also matches `sendButtonSelectors`, so the page-level CLICK interceptor
     * claims the click and runs `intercept()` — which composes the system prompt, reports
     * `injected`, and submits it as a message. Two consequences, both observed:
     *
     *   - a stray conversation turn containing the prompt and nothing the user wrote, and
     *   - `intercept` calls `preventDefault()` + `stopImmediatePropagation()`, so the site's own
     *     handler never sees the click and the reply is NOT stopped. The fallback could not have
     *     worked, whatever the button was.
     *
     * `programmatic` is exactly the "this event is ours, do not compose" flag `sendRaw` uses.
     * Reset on a timer rather than inline so it covers the whole dispatch, and so a throw can
     * never leave it stuck on — a permanently-true flag would stop the prompt being injected
     * for every later message.
     */
    state.programmatic = true
    try {
      pressButton(candidate)
    } finally {
      setTimeout(() => {
        state.programmatic = false
      }, 0)
    }
    return candidate
  }

  /* ------------------------------------------------------------------ *
   * Public surface used by the main process
   * ------------------------------------------------------------------ */

  // Attachment discovery is structural: no guessed attachment card class names.
  // The user-driven attachment probe reports this same snapshot.
  const attachmentMessageSelectors = () => [
    ...PAGE.messageSelectors, ...PAGE.assistantSelectors, ...PAGE.assistantReplySelectors,
    ...(PAGE.fileAssistantSelectors || []),
    ...(PAGE.fileUserTurnSelector ? [PAGE.fileUserTurnSelector] : []),
    ...(PAGE.fileUserTurnFallbackSelector ? [PAGE.fileUserTurnFallbackSelector] : [])
  ]
  const attachmentHasMessages = (node) => attachmentMessageSelectors()
    .some((selector) => node.matches(selector) || node.querySelector(selector))
  const attachmentNavigationSelector = 'nav, aside, [role="navigation"]'
  const attachmentRoot = () => {
    const composer = getComposer()
    if (!composer) return null
    if (PAGE.fileComposerRootSelector) {
      const root = composer.closest(PAGE.fileComposerRootSelector)
      return root && !attachmentHasMessages(root) ? root : null
    }
    let candidate = null
    let root = composer.parentElement
    for (let depth = 0; root && root !== document.body && depth < 16; depth += 1, root = root.parentElement) {
      // Both sites can render cards above the toolbar; ChatGPT can also move
      // them OUTSIDE the native form after upload. A form is a candidate, not
      // a boundary. Widen only within the composer branch, never into history.
      // The 2026-10-06 capture placed the active inputs at depth 8 and their
      // native form at depth 10, beyond the former eight-ancestor limit.
      if (attachmentHasMessages(root)) break
      // A collapsed sidebar may contain no conversation links. Its landmark is
      // still a page boundary, including while hidden chat history is unmounted.
      if (root.matches(attachmentNavigationSelector) || root.querySelector(attachmentNavigationSelector)) break
      if ((PAGE.conversationLinkSelectors || []).some((selector) => root.querySelector(selector))) break
      if (root.matches('form') || root.querySelectorAll(CONTROL_SELECTOR).length >= 2) candidate = root
    }
    return candidate
  }
  const attachmentNameSources = (root, referenceAttribute = '', withoutNavigation = false) => {
    const clone = root.cloneNode(true)
    clone.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"]), input').forEach((node) => node.remove())
    if (withoutNavigation) clone.querySelectorAll('a[href], nav, aside, [role="navigation"]').forEach((node) => node.remove())
    if (PAGE.fileDraftIgnoreSelector) clone.querySelectorAll(PAGE.fileDraftIgnoreSelector).forEach((node) => node.remove())
    // Keep every filename node/label as its own source. A container's textContent
    // concatenates sibling cards without spaces ("first...second.mdthird...").
    // Inspecting each subtree also preserves filenames split across inline spans.
    const sources = [clone, ...clone.querySelectorAll('*')].flatMap((node) => [
      collapse(node.textContent || ''), node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')
    ])
    const references = referenceAttribute ? [root, ...root.querySelectorAll(`[${referenceAttribute}]`)].flatMap((node) =>
      String(node.getAttribute(referenceAttribute) || '').split(/\s+/).filter(Boolean).slice(0, 8).map((id) => {
        const target = document.getElementById(id)
        // Gemini's current card links a hidden CDK tooltip. Never search all
        // tooltips or read arbitrary referenced conversation nodes.
        return target?.getAttribute('role') === 'tooltip' ? String(target.textContent || '') : ''
      })) : []
    return [...new Set([...sources, ...references].filter(Boolean))]
  }
  const attachmentDraftCards = (root) => {
    const cardSelector = PAGE.fileDraftCardSelector || PAGE.fileAttachmentCardSelector
    return cardSelector ? [...root.querySelectorAll(cardSelector)] : []
  }
  // The images counted as draft-attachment evidence. Shared with diagnostics so
  // the log describes exactly the nodes that made a draft look non-empty.
  const attachmentDraftImages = (root, cards) => {
    const cardSelector = PAGE.fileDraftCardSelector || PAGE.fileAttachmentCardSelector
    const previewImages = PAGE.fileDraftImageSelector ? cards.flatMap((card) => [...card.querySelectorAll(PAGE.fileDraftImageSelector)])
      : cardSelector ? cards.flatMap(collectImages) : [...root.querySelectorAll('img')]
    return previewImages.filter((img) => {
      // The outer composer branch can contain navigation or a model picker.
      // Neither their visible icons nor local avatar URLs are upload previews.
      if (img.closest(attachmentNavigationSelector) ||
        (PAGE.fileDraftIgnoreSelector && img.closest(PAGE.fileDraftIgnoreSelector)) ||
        attachmentMessageSelectors().some((selector) => img.closest(selector))) return false
      const localPreview = /^(blob:|data:)/.test(img.currentSrc || img.src || '')
      if (!localPreview && !(img.naturalWidth >= 40 && img.naturalHeight >= 40)) return false
      // Without a measured card scope, the root can include page decorations.
      // DeepSeek's hidden static image has 132px natural dimensions but no
      // rendered area; counting it makes an empty new chat return `busy`.
      // Keep native cards and local upload previews conservative, even while
      // they are hidden or hydrating, so existing user attachments stay owned.
      if (cardSelector || localPreview) return true
      if (!isVisibleElement(img)) return false
      const rect = img.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
  }
  const attachmentSnapshot = () => {
    const root = attachmentRoot()
    const inputFiles = [...document.querySelectorAll('input[type="file"]')].reduce((sum, input) => sum + (input.files?.length || 0), 0)
    if (!root) return { rootFound: false, text: '', nameSources: [], images: 0, cards: 0, uploading: false, error: false, inputFiles }
    const cardSelector = PAGE.fileDraftCardSelector || PAGE.fileAttachmentCardSelector
    const cards = attachmentDraftCards(root)
    const images = attachmentDraftImages(root, cards)
    const nameSources = [...new Set((PAGE.fileDraftCardSelector ? cards : [root])
      .flatMap((node) => attachmentNameSources(node, PAGE.fileDraftNameReferenceAttribute)))]
    /*
     * Filename-shaped text counts as a pending draft only when it is not navigation.
     *
     * The root is bounded by the message list, and a page that starts HIDDEN (the focus view
     * is the default) renders no message rows at all — so the root widened to the whole page
     * shell and the sidebar's conversation titles, which are links, read as a file nobody
     * attached: every focus-view send returned busy until the page had been shown once
     * (2026-10-22 raw-send log: attachment-draft with 0 cards, 0 files, 0 images).
     */
    const draftText = PAGE.fileDraftCardSelector ? nameSources.join(' ')
      : attachmentNameSources(root, PAGE.fileDraftNameReferenceAttribute, true).join(' ')
    return {
      rootFound: true,
      text: nameSources.join(' '), draftText, nameSources,
      images: images.length,
      cards: cards.length,
      uploading: cardSelector
        ? cards.some((card) => card.matches('[role="progressbar"], [aria-busy="true"]') || card.querySelector('[role="progressbar"], [aria-busy="true"]') ||
          (PAGE.fileUploadProgressSelector && card.querySelector(PAGE.fileUploadProgressSelector)))
        : !!root.querySelector('[role="progressbar"], [aria-busy="true"]'),
      error: !!root.querySelector('[role="alert"], [aria-invalid="true"]'),
      inputFiles
    }
  }
  const normalizeAttachmentName = (text) => String(text || '').normalize('NFC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  const attachmentNameEvidence = (sources, files) => {
    const raw = (Array.isArray(sources) ? sources : [sources]).map((source) => String(source || ''))
    const normalized = raw.map(normalizeAttachmentName)
    const names = files.map((file) => normalizeAttachmentName(file.fileName))
    const nameCharacter = (character) => !!character && /[\p{L}\p{N}_.-]/u.test(character)
    const containsName = (source, name) => {
      if (!name) return false
      for (let offset = source.indexOf(name); offset !== -1; offset = source.indexOf(name, offset + 1)) {
        if (!nameCharacter(source[offset - 1]) && !nameCharacter(source[offset + name.length])) return true
      }
      return false
    }
    const evidence = names.map((name, index) => ({
      index, nameLength: String(files[index].fileName || '').length,
      method: !name ? 'missing' : raw.some((source) => containsName(source, files[index].fileName)) ? 'exact'
        : normalized.some((source) => containsName(source, name)) ? 'normalized' : 'missing'
    }))
    const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const nameParts = names.map((name) => {
      const dot = name.lastIndexOf('.')
      return { stem: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot) : '' }
    })
    const duplicatePatterns = PAGE.fileDuplicateNameSuffix ? nameParts.map(({ stem, extension }) =>
      `${escapePattern(stem)} ?\\([1-9]\\d*\\)${escapePattern(extension)}`) : []
    const duplicateNames = duplicatePatterns.map((pattern) => new RegExp(`^${pattern}$`, 'u'))
    // ChatGPT can replace the original upload label with name(1).ext after
    // processing. Accept only a unique alias in THIS batch; report(1).md may
    // itself be another requested file and must not also acknowledge report.md.
    duplicatePatterns.forEach((pattern, index) => {
      if (evidence[index].method !== 'missing') return
      for (const source of normalized) {
        for (const match of source.matchAll(new RegExp(pattern, 'gu'))) {
          const alias = match[0]
          if (!containsName(source, alias)) continue
          const candidates = names.filter((name, candidate) => name === alias || duplicateNames[candidate].test(alias))
          if (candidates.length === 1) evidence[index].method = 'renamed'
        }
      }
    })
    // Some file cards replace part of a long name with an actual ellipsis after
    // upload. A displayed prefix/suffix must identify ONE file in this batch;
    // two similarly named files must never be acknowledged by the same card.
    for (const source of normalized) {
      for (const match of source.matchAll(/…+|\.{3,}/g)) {
        const before = source.slice(0, match.index)
        const after = source.slice(match.index + match[0].length)
        const candidates = []
        names.forEach((name, index) => {
          let head = Math.min(name.length - 1, before.length)
          while (head > 0 && !before.endsWith(name.slice(0, head))) head--
          if (name.slice(0, head).replace(/\s/g, '').length < 12) return
          const boundary = before[before.length - head - 1]
          if (boundary && /[\p{L}\p{N}_.-]/u.test(boundary)) return
          // A renamed card may also show a literal ellipsis: prefix…(1).md.
          // Remove only the observed counter immediately before this extension.
          const extension = nameParts[index].extension
          const suffix = PAGE.fileDuplicateNameSuffix && extension
            ? after.replace(new RegExp(` ?\\([1-9]\\d*\\)(?=${escapePattern(extension)}(?:$|[^\\p{L}\\p{N}_.-]))`, 'u'), '')
            : after
          let tail = Math.min(name.length - head - 1, suffix.length)
          while (tail > 0 && !suffix.startsWith(name.slice(-tail))) tail--
          // Do not accept a different continuous name following the ellipsis.
          if (suffix[tail] && /[\p{L}\p{N}_.()-]/u.test(suffix[tail])) return
          candidates.push(index)
        })
        if (candidates.length === 1 && evidence[candidates[0]].method === 'missing') evidence[candidates[0]].method = 'truncated'
      }
    }
    return evidence
  }
  const draftAttachmentEvidence = (snapshot = attachmentSnapshot()) => {
    if (snapshot.inputFiles > 0 || snapshot.images > 0 || snapshot.uploading || snapshot.cards > 0) return true
    // Claude has measured native cards, including extensionless files after
    // FileList resets. Toolbar text such as "Sonnet 5.5" is not file evidence.
    if (PAGE.fileAttachmentCardSelector) return false
    const text = snapshot.draftText ?? snapshot.text
    return /[^\s]+\.[a-z0-9]{1,10}(?:\s|$)/i.test(text) || /\S{12,}(?:…+|\.{3,})(?:\s|$)/.test(text)
  }
  // ChatGPT exposes separate media/image inputs alongside a general attachment
  // input. A picture matches all three; prefer the unique unrestricted input.
  const chooseAttachmentInput = (files, nearbyInputs, allInputs) => {
    const rulesFor = (input) => String(input.accept || '').toLowerCase().split(',').map((item) => item.trim()).filter(Boolean)
    const accepts = (input) => {
      const rules = rulesFor(input)
      return files.every((file) => !rules.length || rules.some((rule) => rule.startsWith('.') ? file.fileName.toLowerCase().endsWith(rule) : rule.endsWith('/*') ? file.mimeType.startsWith(rule.slice(0, -1)) : file.mimeType === rule))
    }
    const eligible = (input) => !input.disabled && (files.length === 1 || input.multiple) && accepts(input)
    const nearby = nearbyInputs.filter(eligible)
    const candidates = nearby.length ? nearby : allInputs.filter(eligible)
    const unrestricted = candidates.filter((input) => !rulesFor(input).length)
    if (unrestricted.length === 1) return unrestricted[0]
    return candidates.length === 1 ? candidates[0] : null
  }
  const findAttachmentInput = (files) => {
    const root = attachmentRoot()
    const nearby = root ? [...root.querySelectorAll('input[type="file"]')] : []
    // A measured local input scope is authoritative, even when its controls
    // are disabled or reject this type. Never borrow a hidden editor's input.
    return chooseAttachmentInput(files, nearby, nearby.length ? nearby : [...document.querySelectorAll('input[type="file"]')])
  }
  const attachmentInputDiagnostics = (files, composer, root) => {
    const inputs = [...document.querySelectorAll('input[type="file"]')]
    const composers = [...new Set(PAGE.composerSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
    const nearby = root ? inputs.filter((input) => root.contains(input)) : []
    const chosen = chooseAttachmentInput(files, nearby, nearby.length ? nearby : inputs)
    return {
      composerCandidates: composers.slice(0, 12).map((node, index) => ({
        index, tag: node.tagName.toLowerCase(), visible: isVisibleElement(node),
        selected: node === composer, focused: node === document.activeElement || node.contains(document.activeElement)
      })),
      fileInputs: inputs.slice(0, 12).map((input, index) => ({
        index, accept: input.accept, multiple: input.multiple, disabled: input.disabled,
        nearComposer: nearby.includes(input), compatible: chooseAttachmentInput(files, [input], [input]) === input,
        selected: input === chosen, connected: input.isConnected,
        hiddenAncestor: !!input.parentElement?.closest('[hidden], [inert], [aria-hidden="true"]'),
        // File inputs are normally hidden. Inspect their owners rather than
        // treating the input's own visibility as proof that it is inactive.
        ancestors: (() => {
          const rows = []
          for (let node = input.parentElement, depth = 0; node && node !== document.body && depth < 16; node = node.parentElement, depth++) {
            const containsComposer = !!composer && node.contains(composer)
            const hasMessages = attachmentHasMessages(node)
            rows.push({
              depth, tag: node.tagName.toLowerCase(), visible: isVisibleElement(node),
              containsComposer, hasMessages, isForm: node.matches('form'),
              fileInputs: inputs.filter((item) => node.contains(item)).length,
              composers: composers.filter((item) => node === item || node.contains(item)).length,
              visibleComposers: composers.filter((item) => (node === item || node.contains(item)) && isVisibleElement(item)).length
            })
            // The first shared owner or transcript boundary is sufficient;
            // no text, labels, IDs or page-wide tree is read into the log.
            if (containsComposer || hasMessages) break
          }
          return rows
        })()
      }))
    }
  }
  const fileUserTurnRoot = (node) => PAGE.fileUserTurnSelector
    ? node?.closest?.(PAGE.fileUserTurnSelector) || (PAGE.fileUserTurnFallbackSelector ? node?.closest?.(PAGE.fileUserTurnFallbackSelector) : null) || node : node
  const fileUserTurns = () => [...new Set([
    // Attachment-only messages can have no text unit during send. Find their
    // measured outer wrappers directly instead of waiting for text to hydrate.
    ...(PAGE.fileUserTurnSelector ? [...document.querySelectorAll(PAGE.fileUserTurnSelector)] : []),
    ...userTurns()
  ].map(fileUserTurnRoot))].filter((node) => {
    // An assistant placeholder can precede its answer marker. A known role
    // suffix is sufficient to exclude it from attachment acknowledgements.
    const roleNode = PAGE.fileUserTurnSelector ? node?.closest?.('[data-content-search-unit-key]') || node : node
    if (PAGE.fileUserTurnSelector && /:assistant$/.test(String(roleNode?.getAttribute('data-content-search-unit-key') || ''))) return false
    return !(PAGE.fileAssistantSelectors || []).some((selector) => node.matches?.(selector) || node.querySelector?.(selector))
  })
  const fileTurnBoundary = (parent, unit) => ({
    hasOtherMessages: [...PAGE.messageSelectors, ...(PAGE.fileUserTurnSelector ? [PAGE.fileUserTurnSelector] : [])].some((selector) => parent.matches(selector) || [...parent.querySelectorAll(selector)].some((message) => message !== unit && !unit.contains(message))),
    hasAssistant: PAGE.assistantReplySelectors.some((selector) => parent.matches(selector) || parent.querySelector(selector)),
    hasComposer: !!getComposer() && parent.contains(getComposer())
  })
  const fileAttachmentRoot = (node) => {
    if (!node || !PAGE.fileUserTurnSelector) return node
    const unit = fileUserTurnRoot(node)
    // The measured full user wrapper already contains the card and text. It
    // needs no ancestor widening, even when it has no text marker at all.
    if (unit.matches?.(PAGE.fileUserTurnSelector)) return unit
    let root = unit
    // File cards may be siblings of the selectable text. Widen only inside
    // this user message, stopping before any other message or the composer.
    for (let parent = unit.parentElement, depth = 0; parent && parent !== document.body && depth < 6; parent = parent.parentElement, depth++) {
      const boundary = fileTurnBoundary(parent, unit)
      if (boundary.hasOtherMessages || boundary.hasAssistant || boundary.hasComposer) break
      root = parent
    }
    return root
  }
  const fileTurnText = (root) => attachmentNameSources(root).join(' ')
  const fileTurnPositionNode = (node) => PAGE.fileTurnPositionSelector ? node?.closest?.(PAGE.fileTurnPositionSelector) : node
  const fileUserTurnKey = (node) => (PAGE.fileUserTurnKeyAttr ? node?.getAttribute(PAGE.fileUserTurnKeyAttr) : '') ||
    node?.getAttribute('data-content-search-unit-key') || messageIdOf(node) ||
    (PAGE.fileTurnPositionAttr ? String(fileTurnPositionNode(node)?.getAttribute(PAGE.fileTurnPositionAttr) || '').trim() : '')
  // DeepSeek's row key is useful only for the short interval around a send.
  // It must never become the persistent identity used to deduplicate commands.
  const fileUserTurnPosition = (node) => {
    const value = PAGE.fileTurnPositionAttr ? fileTurnPositionNode(node)?.getAttribute(PAGE.fileTurnPositionAttr) : null
    return value != null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
  }
  const isNewFileUserTurn = (newest, turns, baseline) => {
    if (!newest) return false
    if (PAGE.fileTurnPositionAttr) {
      const position = fileUserTurnPosition(newest)
      // Recycling the same DOM node is allowed, re-rendering the same row is not.
      if (position !== null && baseline.maxPosition !== null) return position > baseline.maxPosition
      // Final message keys need not be numeric, even when placeholder keys are.
      // Snapshot the opaque keys too; never assume every row is a list index.
      const key = fileUserTurnKey(newest)
      return !!key && !baseline.keys.has(key)
    }
    const key = fileUserTurnKey(newest)
    // A positional unit key can repeat; the turn's own message id cannot.
    const turnId = fileUserTurnId(newest)
    if (turnId && baseline.turnIds && !baseline.turnIds.has(turnId)) return true
    return key ? !baseline.keys.has(key) : newest !== baseline.node && turns.length > baseline.count
  }
  const fileTurnKeyShape = (key) => !key ? 'none' : /^fallback-turn-/.test(key) ? 'fallback'
    : /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(key) ? 'id' : 'other'
  const fileUserTurnId = (node) => PAGE.fileUserTurnIdAttr
    ? String(node?.closest?.(`[${PAGE.fileUserTurnIdAttr}]`)?.getAttribute(PAGE.fileUserTurnIdAttr) || '').trim() : ''
  const turnShowsFiles = (node, files) => {
    if (!node || !files.length) return false
    const root = fileAttachmentRoot(node)
    const cards = PAGE.fileAttachmentCardSelector
      ? [...(root.matches?.(PAGE.fileAttachmentCardSelector) ? [root] : []), ...root.querySelectorAll(PAGE.fileAttachmentCardSelector)] : [root]
    const allImages = [...new Set(PAGE.fileSentImageSelector ? cards.flatMap((card) => [...card.querySelectorAll(PAGE.fileSentImageSelector)]) : cards.flatMap(collectImages))]
    const images = allImages.filter(imageLooksLikeAttachment)
    const nameSources = cards.flatMap((card) => attachmentNameSources(card))
    const imagesExpected = files.filter((file) => file.mimeType.startsWith('image/')).length
    const names = attachmentNameEvidence(nameSources, files)
    if (PAGE.fileImagesMayUseNames && names.every((name) => name.method !== 'missing')) return true
    return images.length >= imagesExpected && files.every((file, index) => file.mimeType.startsWith('image/') || names[index].method !== 'missing')
  }
  let fileSend = null
  const confirmedFileSends = new Set()
  /** Non-whitespace characters of a long caption that must appear in a folded user message. */
  const FILE_CAPTION_PREFIX = 300
  const fileSendStatus = (token) => {
    if (confirmedFileSends.has(token)) return { status: 'sent' }
    if (!fileSend || fileSend.token !== token) return { status: 'stale' }
    if (fileSend.computer && (fileSend.computer.generation !== state.taskPromptGeneration || fileSend.computer.path !== location.pathname || !state.computerUseEnabled)) return { status: 'busy' }
    if (fileSend.focus && fileSend.focus.generation !== state.taskPromptGeneration) return { status: 'busy' }
    const composer = getComposer()
    if (!composer) return { status: 'no-composer' }
    const snapshot = attachmentSnapshot()
    if (fileSend.submitted) {
      const turns = fileUserTurns()
      const captionToMatch = fileSend.focus ? fileSend.focus.text : fileSend.caption
      const expectedCaption = captionToMatch ? captionToMatch.replace(/\s+/g, '') : ''
      // ChatGPT folds a long user message (… 显示更多) and keeps only its start in the DOM
      // (2026-10-27: an 11043-character result was sent but never confirmed). Its opening
      // characters, together with the new turn, its files and the cleared draft, still identify it.
      const captionIn = (turn) => {
        const text = turn ? fileTurnText(turn).replace(/\s+/g, '') : ''
        const prefix = expectedCaption.length > FILE_CAPTION_PREFIX && !text.includes(expectedCaption) && text.includes(expectedCaption.slice(0, FILE_CAPTION_PREFIX))
        return { text, prefix, seen: !captionToMatch || (!!turn && (text.includes(expectedCaption) || prefix)) }
      }
      const isNew = (turn) => isNewFileUserTurn(turn, turns, fileSend.baselineUser)
      // Prefer the new user row carrying the attachments and this caption, not a nested text node, an
      // assistant placeholder without an answer marker yet, or older history rendered after the send.
      const newest = turns.find((turn) => isNew(turn) && turnShowsFiles(turn, fileSend.files) && captionIn(turn).seen) ||
        turns.find((turn) => isNew(turn) && turnShowsFiles(turn, fileSend.files)) || turns.find(isNew) || turns.at(-1)
      fileSend.lastCheckedTurn = newest
      // Keep correlation in local state; never add a marker or status text to the message.
      const draftCleared = composerMatches(composer, '') && !draftAttachmentEvidence()
      const newTurnSeen = isNew(newest)
      const turnFilesSeen = turnShowsFiles(newest, fileSend.files)
      const { text: turnText, prefix: captionPrefixSeen, seen: captionSeen } = captionIn(newest)
      const sent = !fileSend.edited && draftCleared && newTurnSeen && turnFilesSeen && captionSeen
      if (sent) {
        const focus = fileSend.focus
        const computer = fileSend.computer
        const focusFiles = fileSend.files
        confirmedFileSends.add(token)
        if (confirmedFileSends.size > 8) confirmedFileSends.delete(confirmedFileSends.values().next().value)
        state.programmatic = false
        lastDraftImageCapturedAt = 0
        lastDraftImagePromise = Promise.resolve([])
        fileSend = null
        if (focus) {
          if (focus.promptInjected) state.taskPromptInjected = true
          draftRejected = false
          state.replyActionDetected = false
          report({ event: 'user-message', text: focus.text, focusFiles, focusSendToken: token, attachmentToken: focus.attachmentToken,
            submissionKind: focus.submissionKind })
          report({ event: 'sent', text: focus.text.slice(0, 400), promptInjected: focus.promptInjected,
            ...focus.injection.metadata, taskPromptGeneration: focus.generation })
        } else report({ event: 'sent-raw', text: computer ? '[computer observation attachment]' : '[read_files attachments]',
          attachmentKind: computer ? 'computer' : 'files' })
        if (state.enabled && state.awaitingReplySince !== 0) scheduleCheck()
        scheduleScrollToBottom()
        return { status: 'sent' }
      }
      return {
        status: 'confirming', draftCleared, newTurnSeen, turnFilesSeen, captionSeen, captionPrefixSeen,
        turnTextLength: turnText.length, captionLength: expectedCaption.length, edited: fileSend.edited,
        // Key shapes and visibility only; no key or id values leave the page.
        turnKeyShape: fileTurnKeyShape(fileUserTurnKey(newest)), turnIdPresent: !!fileUserTurnId(newest),
        turnIdKnown: !!fileUserTurnId(newest) && !!fileSend.baselineUser.turnIds?.has(fileUserTurnId(newest)),
        turnVisible: !!newest && isVisibleElement(newest), hiddenUserTurnCount: turns.filter((turn) => !isVisibleElement(turn)).length,
        newTurnCount: turns.filter(isNew).length, baselineTurnIdCount: fileSend.baselineUser.turnIds?.size ?? 0,
        turnPosition: fileUserTurnPosition(newest), baselinePosition: fileSend.baselineUser.maxPosition,
        turnKeyPresent: !!fileUserTurnKey(newest), turnKeyKnown: fileSend.baselineUser.keys.has(fileUserTurnKey(newest)),
        baselineKeyCount: fileSend.baselineUser.keys.size, userTurnCount: turns.length,
        baselinePositionAvailable: fileSend.baselineUser.maxPosition !== null
      }
    }
    // Whitespace-blind, like the confirmation's captionSeen: ChatGPT's composer adds a space before a URL it
    // links ("target":"https://… became "target":" https://…, 2026-10-27 caption-check log).
    const draftText = readComposer(composer).replace(/\s+/g, '')
    if (fileSend.edited || draftText !== String(fileSend.caption || '').replace(/\s+/g, '')) return { status: 'busy' }
    if (snapshot.error) return { status: 'upload-failed', ...snapshot }
    const imagesExpected = fileSend.files.filter((item) => item.mimeType.startsWith('image/')).length
    const nameEvidence = attachmentNameEvidence(snapshot.nameSources, fileSend.files)
    nameEvidence.forEach((name, index) => {
      if (name.method === 'missing' && fileSend.files[index].mimeType.startsWith('image/') && snapshot.images >= imagesExpected) name.method = 'image'
    })
    const namesSeen = nameEvidence.every((name) => name.method !== 'missing')
    const button = findSendButton()
    const sendDisabled = button ? controlDisabled(button) : null
    const stopFound = !!findStopButton()
    const readyBlockReason = !fileSend.selected ? 'files-not-selected' : !snapshot.rootFound ? 'attachment-root-missing'
      : !namesSeen ? 'attachment-names-missing' : snapshot.uploading ? 'upload-in-progress'
        : !button ? 'send-button-missing' : sendDisabled ? 'send-button-disabled' : stopFound ? 'still-generating' : ''
    return {
      status: readyBlockReason ? 'uploading' : 'ready',
      ...snapshot, imagesExpected, namesSeen, nameEvidence, sendFound: !!button, sendDisabled, stopFound,
      readyBlockReason, nameSourceCount: snapshot.nameSources.length,
      missingNameCount: nameEvidence.filter((name) => name.method === 'missing').length
    }
  }

  window[STATE_KEY] = {
    questionSourceMessageId(answer) {
      const node = queryAllAssistant().find(candidate => replyRootOf(candidate) === answer)
      return node ? turnKeyOf(node) : null
    },
    beginFileSend(token, files) {
      if (!files.length) return 'no-files'
      const composer = getComposer()
      if (!composer) return 'no-composer'
      if (fileSend?.token === token && !fileSend.submitted && composerMatches(composer, '')) {
        if (fileSend.edited) return 'busy'
        state.programmatic = true
        const snapshot = attachmentSnapshot()
        if (fileSend.files.length && !snapshot.images && !snapshot.inputFiles && !snapshot.uploading && attachmentNameEvidence(snapshot.nameSources, fileSend.files).every((name) => name.method === 'missing')) fileSend.selected = false
        if (!fileSend.selected) { fileSend.chooserControls = new WeakSet(); fileSend.chooserSteps = {} }
        return fileSend.selected ? 'resume' : 'ok'
      }
      if (state.programmatic || findStopButton() || collapse(readComposer(composer)) !== '' || draftAttachmentEvidence()) return 'busy'
      if (!attachmentRoot()) return 'no-composer'
      const input = PAGE.fileLocalUploadSelector ? null : files.length ? findAttachmentInput(files) : null
      if (files.length && !input && !PAGE.fileLocalUploadSelector) {
        const candidates = [...document.querySelectorAll('input[type="file"]')].filter((item) => !item.disabled && (files.length === 1 || item.multiple))
        if (candidates.length && candidates.every((item) => !chooseAttachmentInput(files, [item], [item]))) return 'unsupported-file-type'
        return 'no-file-input'
      }
      input?.setAttribute('data-codex-file-input', token)
      state.programmatic = true
      fileSend = { token, files, input, selected: false, edited: false, submitted: false, baselineUser: null, baselineAssistant: null, chooserControls: new WeakSet(), chooserSteps: {} }
      return 'ok'
    },
    fileSendStatus,
    beginComputerFileSend(token, files, options) {
      if (PAGE.computerUseRequests !== true || !state.enabled || !state.computerUseEnabled || !options ||
        options.path !== location.pathname || options.generation !== state.taskPromptGeneration || state.pendingQuestion ||
        (state.awaitingReplySince !== 0 && !state.replyActionDetected) || !Array.isArray(files) || files.length !== 1 ||
        files[0].mimeType !== 'image/png' || typeof token !== 'string' || !token.startsWith('computer-image:img_')) return 'busy'
      const result = this.beginFileSend(token, files)
      if (result === 'ok' || result === 'resume') fileSend.computer = { path: options.path, generation: options.generation }
      return result
    },
    beginFocusFileSend(token, files, text, expectedPath) {
      if (location.pathname !== expectedPath || typeof text !== 'string' || text.length > 20000 ||
        !Array.isArray(files) || files.length < 1 || files.length > 3 || state.awaitingReplySince !== 0 || state.pendingQuestion) return 'busy'
      if (state.enabled && state.promptInjectionEnabled && !state.prefix) return 'busy'
      const result = this.beginFileSend(token, files)
      if (result === 'ok' || result === 'resume') {
        fileSend.focus = { text: normalizeLineEndings(text), generation: state.taskPromptGeneration, prepared: false,
          submissionKind: state.pendingQuestion ? 'clarification' : 'goal' }
      }
      return result
    },
    prepareFocusFileSendCaption(token) {
      if (fileSend?.token !== token || !fileSend.focus || fileSend.focus.prepared ||
        fileSend.focus.generation !== state.taskPromptGeneration || fileSendStatus(token).status !== 'ready') return false
      const composer = getComposer()
      if (!composer || !composerMatches(composer, '')) return false
      const focus = fileSend.focus
      focus.injection = userPromptInjection()
      focus.promptInjected = focus.injection.metadata.promptInjected
      if (focus.promptInjected && !state.prefix) return false
      fileSend.caption = focus.injection.prefix ? focus.injection.prefix + USER_TEXT_SENTINEL + focus.text : focus.text
      fileSend.captionComposer = composer
      if (fileSend.caption && !insertText(composer, fileSend.caption)) { fileSend.edited = true; return false }
      focus.prepared = true
      reportUserInjection(focus.injection)
      return true
    },
    openFileChooser(token) {
      const active = () => fileSend?.token === token && !fileSend.selected && !fileSend.submitted && !fileSend.edited &&
        state.programmatic && composerMatches(getComposer(), '') && !findStopButton() && !draftAttachmentEvidence()
      if (!PAGE.fileLocalUploadSelector || !active()) return false
      const visibleControl = (node) => node && node.getClientRects().length > 0 &&
        !node.closest?.('[aria-hidden="true"]') && !controlDisabled(node)
      const unused = (node) => visibleControl(node) && !fileSend.chooserControls.has(node)
      const clickOnce = (kind, node, result) => {
        fileSend.chooserSteps[kind] = true
        fileSend.chooserControls.add(node)
        pressButton(node)
        return result
      }
      const local = [...document.querySelectorAll(PAGE.fileLocalUploadSelector)].filter(visibleControl)
      if (local.length === 1 && !fileSend.chooserSteps.native && unused(local[0])) return clickOnce('native', local[0], true)
      const labels = PAGE.fileLocalUploadLabels || []
      const menus = [...document.querySelectorAll('[role="menu"]')].filter((node) => node.getClientRects().length > 0 && !node.closest?.('[aria-hidden="true"]'))
      const candidates = [...new Set(menus.flatMap((menu) => [...menu.querySelectorAll(CONTROL_SELECTOR + ',[role="menuitem"]')]))].filter((node) => {
        if (!visibleControl(node)) return false
        const clone = node.cloneNode(true)
        clone.querySelectorAll('svg, mat-icon, gem-icon, [aria-hidden="true"]').forEach((icon) => icon.remove())
        return labels.includes(collapse(node.getAttribute('aria-label') || '')) || labels.includes(collapse(clone.textContent || ''))
      })
      // Only the unique Files entry in a visible menu qualifies. Drive/photos,
      // hidden helper buttons and filenames mentioned in history cannot qualify.
      // It can open a chooser directly OR expose the measured local submenu;
      // the main process polls until the native chooser event arrives.
      if (candidates.length === 1 && !fileSend.chooserSteps.caption && unused(candidates[0])) return clickOnce('caption', candidates[0], 'waiting')
      if (!menus.length && !local.length && !fileSend.chooserSteps.menu) {
        const root = attachmentRoot()
        const menu = (PAGE.fileUploadMenuSelectors || []).flatMap((selector) => [...(root?.querySelectorAll(selector) || [])]).find(unused)
        if (!menu) return 'waiting'
        // The main process has already intercepted file chooser dialogs.
        return clickOnce('menu', menu, 'waiting')
      }
      return 'waiting'
    },
    fileChooserDiagnostics() {
      const root = attachmentRoot()
      const visibleControl = (node) => node.getClientRects().length > 0 && !node.closest?.('[aria-hidden="true"]') && !controlDisabled(node)
      const menus = [...document.querySelectorAll('[role="menu"]')].filter(visibleControl)
      const native = PAGE.fileLocalUploadSelector ? [...document.querySelectorAll(PAGE.fileLocalUploadSelector)].filter(visibleControl) : []
      const captions = [...new Set(menus.flatMap((menu) => [...menu.querySelectorAll(CONTROL_SELECTOR + ',[role="menuitem"]')]))].filter((node) => {
        if (!visibleControl(node)) return false
        const clone = node.cloneNode(true)
        clone.querySelectorAll('svg, mat-icon, gem-icon, [aria-hidden="true"]').forEach((icon) => icon.remove())
        return (PAGE.fileLocalUploadLabels || []).includes(collapse(node.getAttribute('aria-label') || '')) ||
          (PAGE.fileLocalUploadLabels || []).includes(collapse(clone.textContent || ''))
      })
      return { rootFound: !!root, menuCount: menus.length, localEntryCount: native.length, captionEntryCount: captions.length,
        entryAmbiguous: native.length > 1 || captions.length > 1,
        entryClicked: !!(fileSend?.chooserSteps.caption || fileSend?.chooserSteps.native) }
    },
    fileSelectionApplied(token) {
      if (fileSend?.token === token) fileSend.selected = true
    },
    refreshFileInput(token) {
      if (!fileSend || fileSend.token !== token || fileSend.selected || !composerMatches(getComposer(), '')) return false
      const input = findAttachmentInput(fileSend.files)
      if (!input) return false
      fileSend.input?.removeAttribute('data-codex-file-input')
      fileSend.input = input
      input.setAttribute('data-codex-file-input', token)
      return true
    },
    attachmentDiagnostics: (files = fileSend?.files || []) => {
      const composer = getComposer()
      const root = attachmentRoot()
      const send = findSendButton()
      const snapshot = attachmentSnapshot()
      return {
        ...snapshot, composerFound: !!composer,
        rootIsForm: !!root?.matches('form'),
        nameEvidence: attachmentNameEvidence(snapshot.nameSources, files),
        nameSourceCount: snapshot.nameSources.length,
        sendFound: !!send, sendDisabled: send ? controlDisabled(send) : null,
        draftEmpty: composer ? collapse(readComposer(composer)) === '' : null, stopFound: !!findStopButton(),
        // Counts only: diagnostics never return file-card or conversation text.
        attachmentAncestors: (() => {
          const ancestors = []
          for (let node = composer?.parentElement, depth = 0; node && node !== document.body && depth < 16; node = node.parentElement, depth++) {
            const hasMessages = attachmentHasMessages(node)
            const isForm = node.matches('form')
            if (hasMessages) { ancestors.push({ depth, hasMessages: true, isForm }); break }
            const labels = [...node.querySelectorAll('[title], [aria-label]')].map((item) => [item.getAttribute('title'), item.getAttribute('aria-label')].filter(Boolean).join(' ')).join(' ')
            ancestors.push({
              depth, hasMessages: false, isForm, selectedRoot: node === root,
              controls: node.querySelectorAll(CONTROL_SELECTOR).length,
              fileInputs: node.querySelectorAll('input[type="file"]').length,
              visible: isVisibleElement(node),
              images: node.querySelectorAll('img').length,
              textNameMatches: files.filter((file) => String(node.textContent || '').includes(file.fileName)).length,
              labelNameMatches: files.filter((file) => labels.includes(file.fileName)).length
            })
          }
          return ancestors
        })(),
        // Where each image counted in `images` sits, so a page icon mistaken for a
        // draft preview can be told apart from a real one. Never the full src.
        draftImages: (() => {
          if (!root) return []
          const anchor = composer?.getBoundingClientRect()
          return attachmentDraftImages(root, attachmentDraftCards(root)).slice(0, 8).map((img) => {
            let depth = null
            for (let node = composer?.parentElement, level = 0; node && node !== document.body && level < 16; node = node.parentElement, level++) {
              if (node.contains(img)) { depth = level; break }
            }
            const source = img.currentSrc || img.src || ''
            let scheme = 'none'
            let host = ''
            if (source) {
              try {
                const url = new URL(source, location.href)
                scheme = url.protocol.replace(/:$/, '')
                if (scheme === 'https' || scheme === 'http') host = url.hostname
              } catch { scheme = 'invalid' }
            }
            const rect = img.getBoundingClientRect()
            const landmark = img.closest('nav, aside, header, footer, a, button, [role="button"]')
            return {
              depth, scheme, host,
              naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
              width: Math.round(rect.width), height: Math.round(rect.height),
              offsetX: anchor ? Math.round(rect.left - anchor.left) : null,
              offsetY: anchor ? Math.round(rect.top - anchor.top) : null,
              visible: isVisibleElement(img), complete: img.complete,
              altLength: String(img.getAttribute('alt') || '').length,
              landmark: landmark ? (landmark.getAttribute('role') === 'button' ? 'role-button' : landmark.tagName.toLowerCase()) : ''
            }
          })
        })(),
        userAttachmentAncestors: (() => {
          const unit = fileUserTurnRoot(fileSend?.lastCheckedTurn)
          if (!unit) return []
          const root = fileAttachmentRoot(unit)
          const files = fileSend.files
          const ancestors = []
          for (let node = unit, depth = 0; node && node !== document.body && depth < 7; node = node.parentElement, depth++) {
            const boundary = node === unit ? { hasOtherMessages: false, hasAssistant: false, hasComposer: false } : fileTurnBoundary(node, unit)
            // Report the boundary itself without reading another message's text.
            if (boundary.hasOtherMessages || boundary.hasAssistant || boundary.hasComposer) { ancestors.push({ depth, selectedRoot: false, ...boundary }); break }
            const text = fileTurnText(node)
            ancestors.push({ depth, selectedRoot: node === root, ...boundary, images: collectImages(node).filter(imageLooksLikeAttachment).length, filenameMatches: files.filter((file) => text.includes(file.fileName)).length })
          }
          return ancestors
        })(),
        ...attachmentInputDiagnostics(files, composer, root)
      }
    },
    prepareFileSendCaption(token, caption) {
      if (typeof caption !== 'string' || !caption.trim() || caption.length > (fileSend?.computer ? 200000 : 50000) || fileSendStatus(token).status !== 'ready') return false
      // Uploads wait on an empty draft. Add the owned question only once the
      // attachment is ready; subsequent user edits still invalidate this send.
      const composer = getComposer()
      if (!composer || !composerMatches(composer, '') || fileSend.caption) return false
      fileSend.caption = normalizeLineEndings(caption)
      fileSend.captionComposer = composer
      if (!insertText(composer, fileSend.caption)) { fileSend.edited = true; return false }
      return true
    },
    /**
     * Why an inserted caption stopped reading as ready. Lengths, flags and a few code points at the
     * first difference only; the caption and draft text themselves are never returned.
     */
    fileSendCaptionDiagnostics(token) {
      if (!fileSend || fileSend.token !== token) return { fileSendPresent: !!fileSend, tokenMatches: false }
      const composer = getComposer()
      const caption = fileSend.caption || ''
      const actual = composer ? readComposer(composer) : ''
      const expected = collapse(caption), seen = collapse(actual)
      let firstDiffAt = -1
      if (expected !== seen) { firstDiffAt = 0; while (firstDiffAt < expected.length && expected[firstDiffAt] === seen[firstDiffAt]) firstDiffAt++ }
      const codes = (text) => firstDiffAt < 0 ? [] : [...text.slice(Math.max(0, firstDiffAt - 3), firstDiffAt + 3)].map(char => char.codePointAt(0))
      const root = attachmentRoot()
      const alerts = root ? [...root.querySelectorAll('[role="alert"]')] : []
      const invalid = root ? [...root.querySelectorAll('[aria-invalid="true"]')] : []
      const previous = fileSend.captionComposer || null
      return {
        tokenMatches: true, edited: fileSend.edited, submitted: fileSend.submitted,
        computerStale: !!fileSend.computer && (fileSend.computer.generation !== state.taskPromptGeneration ||
          fileSend.computer.path !== location.pathname || !state.computerUseEnabled),
        composerFound: !!composer, composerSame: !!composer && composer === previous,
        previousComposerConnected: previous ? previous.isConnected : null, composerTag: composer ? composer.tagName : null,
        composerInvalid: composer?.getAttribute('aria-invalid') === 'true',
        captionLength: caption.length, composerTextLength: actual.length, exactMatch: actual === caption,
        collapsedMatch: expected === seen, collapsedCaptionLength: expected.length, collapsedComposerLength: seen.length,
        firstDiffAt, captionCodesAtDiff: codes(expected), composerCodesAtDiff: codes(seen),
        rootFound: !!root, alertCount: alerts.length,
        alerts: alerts.slice(0, 3).map(element => collapse(element.innerText || element.textContent).slice(0, 80)),
        invalidCount: invalid.length, invalidTags: invalid.slice(0, 3).map(element => element.tagName)
      }
    },
    submitFileSend(token) {
      if (fileSendStatus(token).status !== 'ready') return false
      if (fileSend.focus && (!fileSend.focus.prepared || fileSend.focus.generation !== state.taskPromptGeneration)) return false
      const button = findSendButton()
      const turns = fileUserTurns()
      const positions = turns.map(fileUserTurnPosition).filter((position) => position !== null)
      fileSend.baselineUser = {
        node: turns.at(-1) || null, count: turns.length, keys: new Set(turns.map(fileUserTurnKey).filter(Boolean)),
        turnIds: new Set(turns.map(fileUserTurnId).filter(Boolean)),
        maxPosition: positions.length ? Math.max(...positions) : turns.length ? null : -1
      }
      fileSend.baselineAssistant = lastAssistantId()
      const focusBaselineNode = latestReplyNode(queryAllAssistant().filter(node => isAssistantTurn(node)))
      focusReplyBaseline = fileSend.baselineAssistant
      focusBaselinePosition = focusRowPosition(focusBaselineNode)
      focusReplyPosition = null
      fileSend.submitted = true
      // App-owned uploads retain the original image bytes in main, bound to this send token.
      // The acknowledgement records those bytes, without scraping a thumbnail from the page.
      // Mark the reply before clicking: a synchronous new assistant turn must not be baselined.
      if (fileSend.computer) state.replyActionDetected = false
      setReplyWaiting(Date.now(), 'file-send-submitted')
      state.taskActive = true
      state.lastCommandMessageId = fileSend.baselineAssistant
      pressButton(button)
      return true
    },
    releaseFileSend(token) {
      if (fileSend?.token === token) {
        state.programmatic = false
        if (fileSend.focus && !fileSend.submitted) {
          discardUserImageCapture(fileSend.focus.attachmentToken)
          fileSend = null
          return true
        }
        if (fileSend.submitted) {
          // Preserve the main-process 'unknown' outcome and never click again,
          // but don't let an expired acknowledgement block all future replies.
          fileSend = null
          if (state.enabled && state.awaitingReplySince !== 0) scheduleCheck()
        }
      }
      return true
    },
    configure(config) {
      if (!config) return { ...state }
      if (typeof config.computerPageEpoch === 'string' && config.computerPageEpoch !== computerPageEpoch) {
        computerPageEpoch = config.computerPageEpoch
        computerReplyWait = null
        pendingComputerRecognition = null
        computerSourceSubmissionId = null
        mailSourceSubmissionId = null
      }
      if (config.computerProtocol && Array.isArray(config.computerProtocol.definitions)) {
        computerProtocolContext = { definitions: config.computerProtocol.definitions,
          stepToken: typeof config.computerProtocol.stepToken === 'string' ? config.computerProtocol.stepToken : null }
      }
      if (typeof config.enabled === 'boolean') state.enabled = config.enabled
      if (typeof config.computerUseEnabled === 'boolean') {
        state.computerUseEnabled = config.computerUseEnabled
        if (!config.computerUseEnabled) { computerReplyWait = null; pendingComputerRecognition = null }
      }
      if (config.sendBlock === null || typeof config.sendBlock === 'string') {
        const block = config.sendBlock || null
        // Tell the user who just tried that the wait is over; never announce it unprompted.
        if (state.sendBlock && !block && sendBlockNotice?.isConnected) showSendBlockNotice('Windows 桌面助手已就绪，现在可以发送了。', 3000)
        state.sendBlock = block
      }
      if (typeof config.promptInjectionEnabled === 'boolean') state.promptInjectionEnabled = config.promptInjectionEnabled
      if (typeof config.prefix === 'string') state.prefix = config.prefix
      if (typeof config.replyProtocolPrefix === 'string') state.replyProtocolPrefix = config.replyProtocolPrefix
      state.contextPrefixUsage = config.contextPrefixUsage
      state.contextReminderUsage = config.contextReminderUsage
      if (Number.isSafeInteger(config.replyProtocolVersion) && config.replyProtocolVersion > 0) state.replyProtocolVersion = config.replyProtocolVersion
      if (typeof config.prefixIncludesReplyProtocol === 'boolean') state.prefixIncludesReplyProtocol = config.prefixIncludesReplyProtocol
      if (Number.isSafeInteger(config.replyProtocolFullLength) && config.replyProtocolFullLength > 0) state.replyProtocolFullLength = config.replyProtocolFullLength
      // Restore main's snapshot after a full reload, or accept a NEW task boundary.
      // Reconfiguring the same task (environment probe, mode toggle) must not undo a
      // prompt send that the page has confirmed before main receives its report.
      if (Number.isSafeInteger(config.taskPromptGeneration) &&
          config.taskPromptGeneration >= state.taskPromptGeneration &&
          (!taskPromptConfigured || config.taskPromptGeneration > state.taskPromptGeneration)) {
        if (config.taskPromptGeneration > state.taskPromptGeneration) {
          computerReplyWait = null
          computerSourceSubmissionId = null
          mailSourceSubmissionId = null
          pendingComputerRecognition = null
          state.programmatic = false
          draftRejected = false
          state.failedCommand = null
          state.commandRecoveryUsed = false
        }
        state.taskPromptGeneration = config.taskPromptGeneration
        state.taskPromptInjected = config.taskPromptInjected === true
        taskPromptConfigured = true
      }
      // Tool choices change inside the same task: refresh the next human prompt without
      // changing its generation, live question, or outstanding computer request.
      if (Number.isSafeInteger(config.toolPromptRevision) && config.toolPromptRevision >= 0 &&
          (state.toolPromptRevision === null || config.toolPromptRevision >= state.toolPromptRevision)) {
        const changed = state.toolPromptRevision !== null && config.toolPromptRevision > state.toolPromptRevision
        state.toolPromptRevision = config.toolPromptRevision
        if (changed) state.taskPromptInjected = false
      }
      /*
       * The site's selectors arrive with the config, because this script is injected as
       * source and cannot import anything: the main process is the only place that knows
       * which platform this page is. Merged rather than replaced so a partial descriptor
       * keeps ChatGPT's defaults instead of matching nothing at all.
       */
      if (config.page && typeof config.page === 'object') {
        // `composerKind` is accepted for documentation but deliberately not used: the
        // read/write path decides from the ELEMENT (see readComposer), so a site that
        // changes its composer still works without a descriptor update.
        const { composerKind: _kind, ...selectors } = config.page
        PAGE = { ...PAGE, computerUseRequests: false, conversationPathPattern: '', ignoreHiddenReplyNodes: false, assistantRoleSelectors: [], replyStreamingAttribute: '', disabledControlSelectors: [], conversationLinkSelectors: [], continueButtonLabels: [], stoppedReplyLabels: [], focus: null, nativeEdit: null, answerCharts: null, fileTurnPositionAttr: '', fileTurnPositionSelector: '', fileAssistantSelectors: [], fileUserTurnSelector: '', fileUserTurnFallbackSelector: '', fileUserTurnKeyAttr: '', fileUserTurnIdAttr: '', fileImagesMayUseNames: false, fileDuplicateNameSuffix: false, fileAttachmentCardSelector: '', fileDraftCardSelector: '', fileDraftIgnoreSelector: '', fileDraftImageSelector: '', fileSentImageSelector: '', fileDraftNameReferenceAttribute: '', fileUploadProgressSelector: '', fileComposerRootSelector: '', fileUploadMenuSelectors: [], fileLocalUploadSelector: '', fileLocalUploadLabels: [], ...selectors }
        observeReplyMutations()
      }
      // A freshly (re)loaded page has no message of ours outstanding, so nothing
      // it renders can be a reply to us.
      if (config.armBaseline === true) {
        if (focusModelCache) delete focusModelCache.firstSendGeneration
        setReplyWaiting(0, 'configured-baseline')
        state.lastCommandMessageId = null
        state.pendingQuestion = null
        state.answerDraft = null
        state.failedCommand = null
        state.commandRecoveryUsed = false
      }
      report({
        event: 'configured',
        enabled: state.enabled,
        promptInjectionEnabled: state.promptInjectionEnabled,
        prefixLength: state.prefix.length,
        replyProtocolVersion: state.replyProtocolVersion,
        taskPromptInjected: state.taskPromptInjected,
        taskPromptGeneration: state.taskPromptGeneration
      })
      scheduleRenderedAssistantHistory()
      return { ...state }
    },

    /** Manually terminate the current task, including an in-progress model reply. */
    endTask(generation = null) {
      // Main has already advanced this boundary. Its configure() may arrive before
      // or after the stop call; applying the same value must never advance it twice.
      if (generation !== null && (!Number.isSafeInteger(generation) || generation < state.taskPromptGeneration)) return false
      if (fileSend) {
        state.programmatic = false
        fileSend = null
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }

      /*
       * Report what the stop button looked like BEFORE clicking it.
       *
       * `findStopButton()` is the only thing in this app that can stop ChatGPT generating, and
       * it is the one selector group nothing has ever observed: the DOM probe reported all four
       * as MISS, but no probe tick ever ran while a reply was streaming, so those MISSes proved
       * nothing. That left "does 结束任务 actually stop the model?" unanswerable from the
       * outside — the caller just received `true` either way, which is a claim, not a fact.
       *
       * The toolbar inventory is what makes it answerable. It is the probe's own traversal, so
       * when the composer's primary slot holds the stop button this names it — aria label, test
       * id, class and all — and the selector can be written from the log rather than guessed. Read
       * before the click, because clicking is precisely what removes it from the page.
       */
      const stop = findStopButton()
      /*
       * When no stop SELECTOR matched, try the composer's primary action instead.
       *
       * DeepSeek cannot have a stop selector at all — see `clickPrimaryWhileWaiting` — so on
       * that site this is the only thing that can stop a reply, and it is not a guess: it is
       * gated on a reply actually being pending and the composer being empty.
       */
      const primaryFallback = stop === null ? clickPrimaryWhileWaiting() : null

      report({
        event: 'end-task',
        stopButtonFound: stop !== null,
        stopButton: stop ? describeControl(stop) : null,
        // WHICH entry matched, so a working list can be pruned instead of left as a guess.
        matchedBy: stop
          ? PAGE.stopButtonSelectors.filter((selector) => {
              try {
                return stop.matches(selector)
              } catch (_) {
                return false
              }
            })
          : [],
        // What the structural fallback clicked, or null when it did not run.
        primaryFallback: primaryFallback ? describeControl(primaryFallback) : null,
        ...toolbarSnapshot(),
        awaitingReply: state.awaitingReplySince !== 0,
        taskActive: state.taskActive
      })

      if (stop && typeof stop.click === 'function') stop.click()
      state.programmatic = false
      setReplyWaiting(0, 'task-ended')
      state.taskActive = false
      resetTaskPrompt(generation === null ? state.taskPromptGeneration + 1 : generation)
      draftRejected = false
      state.pendingQuestion = null
      state.answerDraft = null
      state.lastCommandMessageId = lastAssistantId()
      state.lastUnparsedMessageId = null
      return true
    },

    /**
     * Type `text` into the composer and submit it WITHOUT the system prompt.
     * Used to hand command output or collected user answers back to the model.
     *
     * Resolves only once the send has been CONFIRMED (the composer cleared), so
     * callers can tell the user the truth instead of assuming success.
     *
     * @returns Promise<'ok' | 'no-composer' | 'busy' | 'insert-failed' | 'stuck'>
     */
    /** App-owned composer: the same confirmed user-send path and prompt boundary. */
    prepareFocusSendRetry(failureId, expectedPath, token) {
      if (location.pathname !== expectedPath || typeof token !== 'string' || !token || token.length > 160) return { ok: false }
      const failure = focusSendFailureOf(), composer = getComposer()
      if (!failure || failure.data.id !== failureId || !failure.data.retryable || !composer) return { ok: false }
      if (focusSendRetry || state.programmatic || fileSend || focusEditing || state.pendingQuestion || findStopButton() ||
        collapse(readComposer(composer)) || draftAttachmentEvidence() || hasDraftImageAttachment()) return { ok: false, outcome: 'busy' }
      const button = failure.button
      try { button.scrollIntoView({ block: 'nearest' }) } catch (_) { /* no synthetic fallback */ }
      const rect = button.getBoundingClientRect(), x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (!hit || !(hit === button || button.contains(hit)) || controlDisabled(button)) return { ok: false }
      const pending = { token, path: expectedPath, generation: state.taskPromptGeneration, received: false,
        baseline: lastAssistantId(), confirming: false,
        onClick: event => {
          if (focusSendRetry === pending && event.isTrusted && (event.target === button || button.contains(event.target))) pending.received = true
        } }
      focusSendRetry = pending
      state.programmatic = true
      document.addEventListener('click', pending.onClick, true)
      return { ok: true, x, y }
    },
    async finishFocusSendRetry(token, dispatched) {
      const pending = focusSendRetry
      if (!pending || pending.token !== token) return 'unavailable'
      if (!dispatched) { releaseFocusSendRetry(pending); return 'cancelled' }
      if (pending.confirming) return 'busy'
      pending.confirming = true
      const current = () => focusSendRetry === pending && location.pathname === pending.path && state.taskPromptGeneration === pending.generation
      try {
        const deadline = Date.now() + 8000
        while (current() && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 120))
          if (!current()) return 'cancelled'
          if (pending.received && !focusSendFailureOf() && (findStopButton() || lastAssistantId() !== pending.baseline)) {
            state.replyActionDetected = false
            setReplyWaiting(Date.now(), 'message-retry')
            state.taskActive = true
            scheduleScrollToBottom()
            return 'ok'
          }
        }
        return !current() ? 'cancelled' : focusSendFailureOf() ? 'stuck' : 'unknown'
      } finally { releaseFocusSendRetry(pending) }
    },
    async sendUser(text, expectedPath, options = null) {
      lastUserSendBlock = null
      const element = getComposer()
      if (!element) return Promise.resolve('no-composer')
      if (typeof text !== 'string' || !text.trim() || text.length > 20000) return Promise.resolve('invalid')
      // Same guards as before, each now named in the raw-send log: a bare 'busy' left
      // "the focus view cannot send after startup" with nothing to read.
      const busy = (reason, details = {}) => {
        lastUserSendBlock = reason
        report({ event: 'raw-busy', reason, composerTextLength: readComposer(element).length, ...details })
        return Promise.resolve('busy')
      }
      if (location.pathname !== expectedPath) return busy('conversation-changed')
      if (options?.force === true) await clearForResume()
      if (state.programmatic) return busy('programmatic-send')
      if (fileSend) return busy('file-send')
      if (state.awaitingReplySince !== 0 || state.pendingQuestion) return busy('awaiting-reply')
      if (findStopButton()) return busy('model-generating', { stopButtonFound: true })
      if (collapse(readComposer(element)) !== '') return busy('text-draft')
      const attachments = attachmentSnapshot()
      if (draftAttachmentEvidence(attachments)) return busy('attachment-draft', {
        attachmentRootFound: attachments.rootFound, attachmentCards: attachments.cards,
        attachmentInputFiles: attachments.inputFiles, attachmentImages: attachments.images, attachmentUploading: attachments.uploading
      })
      if (hasDraftImageAttachment()) return busy('image-draft')
      const conversationPromptInjected = !!options?.scheduledRunId && options.conversationPromptInjected === true
      const injection = userPromptInjection(conversationPromptInjected)
      if (injection.metadata.promptInjected && !state.prefix) return Promise.resolve('unavailable')
      const payload = injection.prefix ? injection.prefix + USER_TEXT_SENTINEL + normalizeLineEndings(text) : normalizeLineEndings(text)
      const sendContext = { taskPromptGeneration: state.taskPromptGeneration, ...injection.metadata, conversationPromptInjected,
        ...(options?.scope ? { scope: options.scope, ...(!options.scope.allowNewConversation ? { path: expectedPath } : {}) } : {}),
        ...(options?.scheduledRunId ? { scheduledRunId: options.scheduledRunId, computerResultToken: options.computerResultToken, path: expectedPath } : {}) }
      state.programmatic = true
      if (!insertText(element, payload) || !composerMatches(element, payload)) {
        state.programmatic = false
        return Promise.resolve('insert-failed')
      }
      if (options?.scope) options.scope.payload = payload
      reportUserInjection(injection)
      return new Promise(resolve => submitWithRetry(
        payload, 0, false, resolve, Date.now() + SEND_TIMEOUT_MS, 0,
        Date.now() + SEND_BUTTON_GRACE_MS, null, sendContext
      ))
    },

    sendScopedUser(text, expectedPath, token, allowNewConversation = false) {
      if (typeof token !== 'string' || !/^[\w-]{1,128}$/.test(token)) return Promise.resolve('invalid')
      if (scopedUserSend || state.programmatic) return Promise.resolve('busy')
      const scope = { token, path: expectedPath, allowNewConversation, cancelled: false, attempted: false, payload: null }
      scopedUserSend = scope
      return this.sendUser(text, expectedPath, { scope }).finally(() => {
        if (scopedUserSend === scope) scopedUserSend = null
      })
    },

    cancelScopedUser(token) {
      const scope = scopedUserSend
      if (!scope || scope.token !== token) return
      scope.cancelled = true
      // Remove only our exact draft; never erase text the user has since edited.
      const element = getComposer()
      if (scope.payload && location.pathname === scope.path && element && composerMatches(element, scope.payload)) insertText(element, '')
      scopedUserSend = null
      state.programmatic = false
    },

    sendScheduledUser(text, expectedPath, runId, conversationPromptInjected = false) {
      if (typeof runId !== 'string' || !/^[\w-]{1,128}$/.test(runId)) return Promise.resolve('invalid')
      const token = 'scheduled:' + runId
      computerResultToken = token
      const promptKnown = conversationPromptInjected === true || state.taskPromptInjected || conversationPromptInHistory()
      return this.sendUser(text, expectedPath, { scheduledRunId: runId, computerResultToken: token, conversationPromptInjected: promptKnown }).finally(() => {
        if (computerResultToken === token) computerResultToken = null
      })
    },

    async editUser(request, expectedPath) {
      const diagnostic = {}
      const outcome = await editFocusUser(request, expectedPath, diagnostic)
      return { outcome, diagnostic }
    },

    /** Metadata from main's passive observer, scoped to this one outstanding submit. */
    noteEditSubmission(token, submission) {
      if (!focusEditing || focusEditing.token !== token || !focusEditing.submitted || !submission ||
        typeof submission.requestBodyReadable !== 'boolean') return false
      focusEditing.submission = submission
      return true
    },

    async smartUiAction(request, expectedPath) {
      const diagnostic = {}
      const outcome = await actOnSmartUi(request, expectedPath, diagnostic)
      return { outcome, diagnostic }
    },
    prepareSmartUiClick(token) {
      if (!focusEditing || focusEditing.token !== token || focusEditing.generation !== state.taskPromptGeneration) return null
      return focusEditing.nativeClick?.prepare() || null
    },
    failSmartUiClick(token, reason) {
      if (!focusEditing || focusEditing.token !== token || !focusEditing.nativeClick ||
        !['native-click-window-unfocused', 'native-click-dispatch-failed'].includes(reason)) return false
      focusEditing.nativeClick.failure = reason
      return true
    },
    noteSmartUiSubmission(token, submission) {
      if (!focusEditing || focusEditing.token !== token || !focusEditing.submitted || !submission ||
        typeof submission.matched !== 'boolean' || (submission.matched && (typeof submission.text !== 'string' || !submission.text.trim() || submission.text.length > 20000))) return false
      focusEditing.submission = submission
      return true
    },

    /** A missed native card send can be recovered from its adjacent rendered user row. */
    readSmartUiRecovery(sourceIds, expectedPath) {
      const rules = PAGE.focus?.edit
      if (!PAGE.focus?.smartUi || !rules || location.pathname !== expectedPath || focusEditing || state.programmatic ||
        fileSend || state.awaitingReplySince || state.pendingQuestion || !Array.isArray(sourceIds) || sourceIds.length > 200) return null
      const groups = queryAll([rules.turnSelector]).filter(group => isVisibleElement(group) && group.querySelector(rules.userTextSelector))
      if (groups.length < 2) return null
      const group = groups.at(-1), previous = groups.at(-2), user = group.querySelector(rules.userTextSelector)
      const parents = queryAllAssistant().filter(node => previous.contains(node) && sourceIds.includes(messageIdOf(node)) && smartUiCardsOf(node).length > 0)
      const ids = [...new Set(parents.map(messageIdOf))]
      if (ids.length !== 1 || user.querySelector('img, input, textarea, [contenteditable="true"]')) return null
      const userMessageId = group.getAttribute(rules.turnIdAttr), userText = userTextOf(normalizeLineEndings(user.innerText || '')).trim()
      if (!/^[a-zA-Z0-9_:-]{1,160}$/.test(userMessageId || '') || !userText || userText.length > 20000) return null
      return { sourceMessageId: ids[0], userMessageId, userText }
    },
    adoptSmartUiRecovery(recovery, expectedPath) {
      if (!recovery) return false
      const live = this.readSmartUiRecovery([recovery.sourceMessageId], expectedPath)
      if (!live || live.userMessageId !== recovery.userMessageId || live.userText !== recovery.userText) return false
      // Align only the passive focus reader. Historical replies must never arm command execution.
      focusReplyBaseline = recovery.sourceMessageId
      focusBaselinePosition = null
      focusReplyPosition = null
      return true
    },

    prepareFocusModelClick(token, step) {
      const operation = focusModeChanging, click = operation?.click
      if (!operation || operation.token !== token || !click || click.step !== step || click.prepared || !operation.current()) return null
      click.prepared = true
      const target = click.target
      if (!target.isConnected || !isVisibleElement(target) || controlDisabled(target) || !click.validate()) { click.dispatched = false; return null }
      const box = target.getBoundingClientRect()
      const fraction = click.fraction === null ? .5 : getComputedStyle(target).direction === 'rtl' ? 1 - click.fraction : click.fraction
      const x = Math.max(box.left + 1, Math.min(box.right - 1, box.left + box.width * fraction)), y = box.top + box.height / 2
      const hit = document.elementFromPoint(x, y)
      if (box.width < 3 || box.height < 3 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hit || !target.contains(hit)) {
        click.dispatched = false; return null
      }
      return { x, y }
    },
    finishFocusModelClick(token, step, dispatched) {
      const operation = focusModeChanging, click = operation?.click
      if (!operation || operation.token !== token || !click || click.step !== step || (dispatched === true && !click.prepared) || !operation.current()) return false
      click.dispatched = dispatched === true
      return true
    },
    /** One owned menu operation, driven by trusted native input and confirmed from DOM state. */
    async updateModelSettings(kind, value, expectedPath, token) {
      const result = (outcome, reason) => ({ outcome, reason, settings: focusModelSettingsOf() })
      if (!PAGE.focus?.modelSettings || !['read', 'model', 'effort'].includes(kind) || typeof token !== 'string' ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(token) || (kind === 'read' ? value !== null : typeof value !== 'string' || value.length > 80)) return result('invalid', 'invalid-request')
      if (location.pathname !== expectedPath || !getComposer()) return result('unavailable', 'page-unavailable')
      if (focusModeChanging || focusEditing || fileSend || state.programmatic || state.awaitingReplySince || state.pendingQuestion || findStopButton()) return result('busy', 'page-busy')
      const operation = { token, generation: state.taskPromptGeneration, path: expectedPath, click: null, step: 0, current: null }
      operation.current = () => focusModeChanging === operation && location.pathname === operation.path && state.taskPromptGeneration === operation.generation
      const deadline = Date.now() + 7000
      const waitFor = async (predicate, timeout = 1100) => {
        const end = Math.min(deadline, Date.now() + timeout)
        while (operation.current() && Date.now() < end) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        return operation.current() && predicate()
      }
      const nativeClick = async (target, fraction = null, validate = () => true) => {
        if (!target || !operation.current() || Date.now() >= deadline || operation.step >= 5) return false
        const click = { target, fraction, validate, step: ++operation.step, prepared: false, dispatched: null }
        operation.click = click
        report({ event: 'focus-model-click', focusModelToken: token, count: click.step })
        await waitFor(() => click.dispatched !== null)
        return click.dispatched === true && operation.current()
      }
      const confirmed = async predicate => {
        let stable = 0
        return await waitFor(() => { stable = predicate() ? stable + 1 : 0; return stable >= 3 })
      }
      focusModeChanging = operation
      let openedHere = false, outcome = 'unknown', reason = 'selection-unconfirmed'
      try {
        const perform = async () => {
          await waitFor(() => !!focusModelPickerParts())
          let parts = focusModelPickerParts()
          if (!parts || controlDisabled(parts.trigger)) return ['unavailable', 'control-missing']
          if (parts.trigger.getAttribute('aria-expanded') !== 'true') {
            openedHere = true
            if (!await nativeClick(parts.trigger, null, () => focusModelPickerParts()?.trigger === parts.trigger)) return ['unknown', 'native-input-failed']
          }
          if (!await waitFor(() => !!focusModelPickerParts()?.menu)) return ['unknown', 'menu-unavailable']
          parts = focusModelPickerParts()
          let data = focusModelSettingsOf()
          if (!data.models.length) return ['unavailable', 'model-options-missing']
          if (kind === 'read') return data.model ? ['ok', 'settings-read'] : ['unknown', 'selection-unconfirmed']
          if (kind === 'model') {
            if (!data.models.some(item => item.value === value)) return ['invalid', 'option-unavailable']
            if (data.model === value) return ['ok', 'already-selected']
            const locate = () => [...(focusModelPickerParts()?.menu?.querySelectorAll(parts.rules.modelSelector) || [])]
              .filter(node => collapse(node.textContent || '') === value)
            let matches = locate()
            if (matches.length !== 1) return ['unavailable', 'option-unavailable']
            if (!isVisibleElement(matches[0]) || matches[0].closest('[aria-hidden="true"]')) {
              const toggles = [...parts.menu.querySelectorAll(parts.rules.viewToggleSelector)].filter(node => isVisibleElement(node) && !node.closest('[aria-hidden="true"]'))
              if (toggles.length !== 1 || !await nativeClick(toggles[0])) return ['unknown', 'native-input-failed']
              if (!await waitFor(() => locate().some(node => isVisibleElement(node) && !node.closest('[aria-hidden="true"]')))) return ['unknown', 'menu-unavailable']
            }
            matches = locate()
            if (matches.length !== 1 || !await nativeClick(matches[0], null, () => locate().length === 1 && locate()[0] === matches[0])) return ['unknown', 'native-input-failed']
            return await confirmed(() => focusModelSettingsOf().model === value) ? ['ok', 'selection-confirmed'] : ['unknown', 'selection-unconfirmed']
          }
          if (!data.efforts.some(item => item.value === value)) return ['invalid', 'option-unavailable']
          if (data.effort === value) return ['ok', 'already-selected']
          const model = data.model, rule = parts.rules.efforts.find(item => item.value === value)
          const slider = parts.menu.querySelector(parts.rules.sliderSelector)
          const root = slider?.querySelector(parts.rules.sliderRootSelector)
          if (!root || slider.closest('[aria-hidden="true"]')) return ['unavailable', 'slider-unavailable']
          if (!await nativeClick(root, rule.position / 2, () => focusModelSettingsOf().model === model &&
            focusModelPickerParts()?.menu?.querySelector(parts.rules.sliderSelector) === slider)) return ['unknown', 'native-input-failed']
          return await confirmed(() => focusModelSettingsOf().model === model && focusModelSettingsOf().effort === value)
            ? ['ok', 'selection-confirmed'] : ['unknown', 'selection-unconfirmed']
        }
        ;[outcome, reason] = await perform()
      } catch { outcome = 'unknown'; reason = 'page-exception' }
      finally {
        if (openedHere && operation.current()) {
          const trigger = focusModelPickerParts()?.trigger
          if (trigger?.getAttribute('aria-expanded') === 'true') {
            const closed = await nativeClick(trigger) && await waitFor(() => focusModelPickerParts()?.trigger.getAttribute('aria-expanded') !== 'true', 500)
            if (!closed && outcome === 'ok') { outcome = 'unknown'; reason = 'menu-close-unconfirmed' }
          }
        }
        if (!operation.current()) { outcome = 'cancelled'; reason = 'conversation-changed' }
        if (focusModeChanging === operation) focusModeChanging = null
      }
      return result(outcome, reason)
    },

    /** One requested mode change. No draft writes, submit, state replay or automatic retry. */
    async setComposerMode(id, active, expectedPath) {
      if (typeof active !== 'boolean' || !(PAGE.focus?.composerModes || []).some(rule => rule.id === id)) return 'invalid'
      if (location.pathname !== expectedPath || !getComposer()) return 'unavailable'
      if (focusModeChanging || focusEditing || fileSend || state.programmatic || state.awaitingReplySince !== 0 || findStopButton()) return 'busy'
      const operation = { path: expectedPath, generation: state.taskPromptGeneration }
      const current = () => focusModeChanging === operation && location.pathname === operation.path &&
        state.taskPromptGeneration === operation.generation
      const locate = () => focusComposerModesOf().find(mode => mode.data.id === id)
      let mode = locate()
      if (!mode?.control || mode.data.active === null) return 'unavailable'
      if (mode.data.disabled) return 'busy'
      if (mode.data.active === active) return 'ok'
      focusModeChanging = operation
      try {
        pressButton(mode.control)
        const deadline = Date.now() + 2000
        let stable = 0
        while (current() && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 80))
          if (!current()) return 'cancelled'
          mode = locate()
          stable = mode?.data.active === active ? stable + 1 : 0
          if (stable >= 2) return 'ok'
        }
        return current() ? 'unknown' : 'cancelled'
      } finally { if (focusModeChanging === operation) focusModeChanging = null }
    },

    /** Read-only view data. User text is exposed only through the scoped recovery read above. */
    focusSnapshot() {
      // Every page-specific read below comes from the platform's measured focus rules.
      const rules = PAGE.focus || { reasoningSelectors: [] }
      const composer = getComposer()
      const sendFailure = focusSendFailureOf()?.data ?? null
      const composerModes = rules.composerModes ? focusComposerModesOf().map(mode => mode.data) : undefined
      const modelSettings = rules.modelSettings ? focusModelSettingsOf() : undefined
      const modelControl = rules.modelSettings ? focusModelPickerParts() : null
      const modelSettingsReady = rules.modelSettings ? !!modelControl && !controlDisabled(modelControl.trigger) : undefined
      const rendered = new Map()
      const markdownOf = node => {
        if (!rendered.has(node)) rendered.set(node, readReplyMarkdown(node))
        return rendered.get(node)
      }
      const protocolReply = raw => looksLikeCommandReply(raw) || looksLikeQuestionReply(raw) || extractCommand(raw) ||
        (state.enabled && state.awaitingReplySince !== 0 &&
          (raw.trim().startsWith('{') || raw.trim().startsWith(String.fromCharCode(96).repeat(3) + 'json')))
      const smartReplies = rules.smartUi ? queryAllAssistant().filter(node => isVisibleElement(node) &&
        (node.matches?.(rules.smartUi.rootSelector) || node.querySelector?.(rules.smartUi.rootSelector))).slice(-8)
        .flatMap(node => {
          // Rich-content refreshes obey the same protocol filter as the live answer.
          // Otherwise a saved command segment or a readable clarification can be
          // overwritten with its protocol JSON. DIL wrappers also contain ordinary code blocks.
          if (protocolReply(readReplyText(node))) return []
          const answer = markdownOf(node)
          if (looksLikeCommandReply(answer) || looksLikeQuestionReply(answer)) return []
          // Never replace a complete saved answer with a truncated live copy or cut
          // through a widget marker. Oversize replies use the normal answer channel.
          return answer.length <= 250000 ? [{ sourceMessageId: messageIdOf(node), answer }] : []
        }) : []
      if (focusEditing) return { path: location.pathname, ready: !!composer, nativeDraft: false, waiting: true, generating: 'unknown', reply: null, smartReplies, composerModes, modelSettings, modelSettingsReady }
      let generating = 'unknown'
      if (rules.generatingIcon) {
        const { primaryControlSelector, generatingPrefixes, idlePrefixes } = rules.generatingIcon
        const primary = [...composerToolbarControls()].reverse().find(control => control.matches(primaryControlSelector))
        const icon = primary?.querySelector('svg path')?.getAttribute('d') || ''
        generating = generatingPrefixes.some(prefix => icon.startsWith(prefix)) ? 'active' :
          idlePrefixes.some(prefix => icon.startsWith(prefix)) ? 'idle' : 'unknown'
      } else if (PAGE.focus) {
        // A measured stop control is shown exactly while a reply streams.
        generating = findStopButton() ? 'active' : 'idle'
      }
      const rows = queryAllAssistant().filter(node => isAssistantTurn(node))
      let node = focusReplyPosition === null ? latestReplyNode(rows) :
        rows.find(item => focusReplyAnchor(item) === focusReplyPosition)
      if (!node || (focusReplyPosition === null && turnKeyOf(node) === focusReplyBaseline)) node = null
      if (node && focusReplyPosition === null) {
        const anchor = focusReplyAnchor(node)
        // A virtual position is valid only during this send, never persisted as an identity;
        // a stable id needs no ordering check, the baseline id above already excluded the old reply.
        if (!anchor || (rules.rowPositionAttr && (!/^\d+$/.test(anchor) ||
          (focusBaselinePosition && /^\d+$/.test(focusBaselinePosition) && Number(anchor) <= Number(focusBaselinePosition))))) node = null
        else focusReplyPosition = anchor
      }
      /*
       * A reply still working, before its id-bearing element exists. ChatGPT renders its
       * 已处理 activity first and the id only arrives with the answer — measured 2026-10-22:
       * id turns stayed at 7 for the whole 70 s of activity and became 8 on completion. So
       * the newest turn group that holds no id yet is this send's reply in progress; it has
       * reasoning but no answer, and no identity to pin until the id appears.
       */
      let pending = null
      if (!node && focusReplyPosition === null && rules.reasoningScopeSelector && PAGE.messageIdAttr) {
        const groups = queryAll([rules.reasoningScopeSelector]).filter(isVisibleElement)
        const last = groups.at(-1)
        if (last && !last.querySelector('[' + PAGE.messageIdAttr + ']')) pending = last
      }
      let reply = null
      if (node || pending) {
        const answer = node ? PAGE.assistantReplySelectors.map(selector => node.querySelector(selector)).find(Boolean) || null : null
        // Reasoning may live beside the turn rather than in it (ChatGPT's activity block).
        const reasoningRoot = pending || (rules.reasoningScopeSelector ? node.closest(rules.reasoningScopeSelector) || node : node)
        const thoughts = [...new Set(rules.reasoningSelectors.flatMap(selector => [...reasoningRoot.querySelectorAll(selector)]))]
          .filter(thought => !answer || (thought !== answer && !answer.contains(thought) && !thought.contains(answer)))
        // A pending group also holds the user's own message: its links are not sources.
        const sources = node ? [...node.querySelectorAll('a[href]')].filter(link =>
          !answer?.contains(link) && !thoughts.some(thought => thought.contains(link))) : []
        const ordered = [...thoughts.map(element => ({ kind: 'reasoning', element })),
          ...sources.map(element => ({ kind: 'search', element }))]
          .sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        const parts = ordered.slice(0, 50).flatMap(part => {
          const text = part.kind === 'reasoning' ? readReplyMarkdown(part.element) : String(part.element.innerText || '').trim()
          if (!text.trim()) return []
          if (part.kind === 'reasoning') return [{ kind: part.kind, text: text.slice(0, 50000) }]
          try {
            const url = new URL(part.element.getAttribute('href'), location.href)
            return /^https?:$/.test(url.protocol) ? [{ kind: part.kind, text: text.slice(0, 500), url: url.href.slice(0, 2000) }] : []
          } catch { return [] }
        })
        const raw = answer ? readReplyText(node) : ''
        const protocol = protocolReply(raw)
        reply = { sourceMessageId: node ? turnKeyOf(node) : '', parts,
          answer: answer && !protocol ? markdownOf(node).slice(0, 250000) : '' }
      }
      const historyDraft = !!rules.edit && queryAll([rules.edit.editorSelector]).some(isVisibleElement)
      return { path: location.pathname, ready: !!composer, nativeDraft: historyDraft || (!!composer && collapse(readComposer(composer)) !== ''),
        waiting: state.awaitingReplySince !== 0 || state.programmatic, generating, reply, smartReplies, composerModes, modelSettings, modelSettingsReady, sendFailure }
    },

    async recoverCommand(token, generation, allowSend, manual = false, expectedMessageId = null) {
      const failure = state.failedCommand
      if (!failure || failure.token !== token || failure.generation !== generation ||
        generation !== state.taskPromptGeneration || failure.path !== location.pathname ||
        !state.enabled || !state.taskActive || state.awaitingReplySince !== 0 ||
        lastAssistantId() !== failure.messageId || (expectedMessageId !== null && expectedMessageId !== failure.messageId)) return 'stale'
      const publish = (status) => {
        if (state.failedCommand !== failure || state.taskPromptGeneration !== generation || failure.path !== location.pathname) return
        failure.status = status
        report({ event: 'command-recovery', messageId: failure.messageId, parseFailureToken: token, recoveryStatus: status })
      }
      if (failure.status === 'uncertain' || failure.status === 'sent' || failure.sending) return 'stale'
      if (!allowSend) { publish('blocked'); return 'busy' }
      if (state.commandRecoveryUsed && !manual) { publish('failed'); return 'limit' }
      const labels = { 'invalid-background': 'background 必须为布尔值 true 或 false',
        'duplicate-field': '存在重复字段', 'invalid-command': 'command 字段无效',
        'invalid-json': 'JSON 格式或字符串转义无效' }
      const text = failure.parseErrorCode === 'invalid-read-files'
        ? ['【文件读取请求格式错误：未执行】',
          '本条请求没有读取或上传文件。请保留原来要读取的路径，单独输出一个完整的 json 代码块：',
          '{"type":"read_files","files":[{"path":"文件的完整路径"}],"description":"说明读取目的"}',
          '使用 files 数组，不要使用 paths；一次读取 1–3 个文件，每项包含非空 path，description 为非空字符串。Windows 路径中的反斜杠必须正确转义。',
          '只修正这次文件读取请求，不要重新执行已完成的命令或重新启动后台任务，不要报告任务完成。'].join('\n')
        : ['【指令格式错误：未执行】', labels[failure.parseErrorCode] || '指令格式无效',
          '本条请求没有启动进程。请仅重新提交最后一条请求的完整合法 JSON，保留原命令意图和 background 执行属性。',
          '使用 json 代码块，Windows 路径中的反斜杠必须正确转义。不要改为前台执行，不要报告任务完成。'].join('\n')
      failure.sending = true
      state.commandRecoveryUsed = true
      // Consume exactly this failed reply so a DOM redraw cannot resubmit it.
      state.lastCommandMessageId = failure.messageId
      publish('pending')
      let outcome
      try { outcome = await window[STATE_KEY].sendRaw(text, null, { requireIdle: true, path: failure.path, generation }) }
      catch { outcome = 'stuck' }
      failure.sending = false
      publish(outcome === 'ok' ? 'sent' : outcome === 'stuck' || outcome === 'insert-failed' ? 'uncertain' : 'blocked')
      return outcome
    },

    sendComputerResult(text, options) {
      if (!options || typeof options.computerResultToken !== 'string') return Promise.resolve('busy')
      computerResultToken = options.computerResultToken
      return this.sendRaw(text, null, options).finally(() => {
        if (computerResultToken === options.computerResultToken) computerResultToken = null
      })
    },

    cancelComputerResult(token) {
      if (computerResultToken !== token) return
      computerResultToken = null
      state.programmatic = false
    },

    sendRaw(text, ownedDraft = null, options = null) {
      const element = getComposer()
      if (!element) return Promise.resolve('no-composer')
      const blocked = (reason, details = {}) => {
        // Log only counts/flags at the guard that actually refused this send.
        // Never include the user's draft, command output or toolbar labels.
        report({ event: 'raw-busy', reason, composerTextLength: readComposer(element).length, ...details })
        return Promise.resolve('busy')
      }
      if (state.programmatic) return blocked('programmatic-send')
      if (options?.computerResultToken !== undefined && options.computerResultToken !== computerResultToken) return blocked('computer-result-cancelled')
      if (options?.generation !== undefined && options.generation !== state.taskPromptGeneration) return blocked('task-changed')
      if (options?.path !== undefined && options.path !== location.pathname) return blocked('conversation-changed')
      if (options?.requireIdle && ((state.awaitingReplySince !== 0 && !state.replyActionDetected) || state.pendingQuestion)) return blocked('awaiting-reply')
      if (findStopButton()) return blocked('model-generating', { stopButtonFound: true })
      if (hasDraftImageAttachment()) return blocked('image-draft')
      const attachments = attachmentSnapshot()
      if (draftAttachmentEvidence(attachments)) return blocked('attachment-draft', {
        attachmentRootFound: attachments.rootFound,
        attachmentCards: attachments.cards,
        attachmentInputFiles: attachments.inputFiles,
        attachmentImages: attachments.images,
        attachmentUploading: attachments.uploading
      })
      // Never clobber something the user is in the middle of typing.
      const existing = readComposer(element)
      if (collapse(existing) !== '') {
        if (!ownedDraft || !composerMatches(element, ownedDraft)) return blocked('text-draft')
      }

      const payload = normalizeLineEndings(text)
      const taskPromptGeneration = state.taskPromptGeneration

      state.programmatic = true
      let inserted = false
      try {
        // Reuse an unchanged answer draft, or replace only our own failed draft
        // when the user revised an answer on a previous page before retrying.
        inserted = composerMatches(element, payload) || insertText(element, payload)
      } catch (_) {
        inserted = false
      }
      if (!inserted) {
        state.programmatic = false
        report({ event: 'inject-failed' })
        return Promise.resolve('insert-failed')
      }

      return new Promise((resolve) => {
        let settled = false
        let timeout = null
        const done = (outcome) => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          resolve(outcome)
        }

        // Hard ceiling: this promise is awaited across IPC. Clear it as soon as
        // this raw send settles; otherwise an OLD send's 10s timer can fire while
        // a newer command result is being retried, flip programmatic=false, and
        // let the normal click interceptor prepend the system prompt to that raw result.
        timeout = setTimeout(() => {
          if (taskPromptGeneration === state.taskPromptGeneration &&
              (options?.computerResultToken === undefined || options.computerResultToken === computerResultToken)) state.programmatic = false
          done('stuck')
        }, SEND_TIMEOUT_MS)

        /*
         * `SEND_TIMEOUT_MS` is the ceiling for EVERYTHING, and the two budgets passed here are
         * what keep the branches inside it: the grace period ends the wait for a measured
         * button, and the deadline stops the whole thing. The realistic worst case is
         * grace + two recovery confirmations ≈ 6.7s.
         */
        submitWithRetry(
          payload,
          0,
          true,
          done,
          Date.now() + SEND_TIMEOUT_MS,
          0,
          Date.now() + SEND_BUTTON_GRACE_MS,
          null,
          { taskPromptGeneration, promptInjected: false, ...(options?.path !== undefined ? { path: options.path } : {}),
            ...(options?.question ? { question: options.question } : {}),
            ...(options?.computerResultToken !== undefined ? { computerResultToken: options.computerResultToken } : {}) }
        )
      })
    },

    /** Local dismissal: preserve task state and never send cancellation feedback. */
    cancelQuestion(messageId) {
      if (!state.pendingQuestion || state.pendingQuestion.messageId !== messageId) return 'stale'
      if (state.programmatic) return 'busy'
      // A failed answer send can leave our draft in the page composer. Clear only
      // that unchanged draft, retaining any text the user has subsequently edited.
      const draft = state.answerDraft?.messageId === messageId ? state.answerDraft.text : null
      const element = draft ? getComposer() : null
      if (element && composerMatches(element, draft) && !insertText(element, '')) return 'draft-clear-failed'
      state.pendingQuestion = null
      state.answerDraft = null
      // lastCommandMessageId already marks this question as handled. Keep it and
      // the task's prompt boundary so DOM/configuration updates cannot reopen it.
      report({ event: 'question-cleared', messageId })
      return 'cancelled'
    },

    /** Reopen a recorded question (from 重新执行指令) as if the model had just asked it. */
    replayQuestion(messageId, payloadJson, taskSource = null) {
      if (typeof messageId !== 'string' || !messageId) return 'invalid'
      let question = null
      try {
        question = questionPages(JSON.parse(String(payloadJson)))
      } catch (_) { /* reported as invalid below */ }
      if (!question) return 'invalid'
      if (state.programmatic || state.awaitingReplySince !== 0) return 'busy'
      if (taskSource && (taskSource.pageEpoch !== computerPageEpoch || taskSource.taskPromptGeneration !== state.taskPromptGeneration ||
        taskSource.pagePath !== location.pathname || taskSource.sourceSubmissionId !== computerSourceSubmissionId)) return 'invalid'
      state.pendingQuestion = { messageId, ...question, taskSource }
      state.answerDraft = null
      report({ event: 'question', messageId, ...question, rawJson: String(payloadJson), live: true, questionReplay: true, questionSource: taskSource })
      return 'ok'
    },

    async answerQuestion(messageId, answer, expectedSource = null) {
      // Answers belong to the conversation; terminal mode and execution flags do not expire them.
      if (!state.pendingQuestion || state.pendingQuestion.messageId !== messageId) return 'stale'
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 20000) return 'invalid-answer'
      const pending = state.pendingQuestion
      const source = pending.taskSource || null
      if (expectedSource && (!source || ['sourceSubmissionId', 'taskPromptGeneration', 'pagePath', 'pageEpoch'].some(key => source[key] !== expectedSource[key]) ||
        source.pageEpoch !== computerPageEpoch || source.pagePath !== location.pathname || source.taskPromptGeneration !== state.taskPromptGeneration)) return 'stale'
      const ownedDraft = state.answerDraft?.messageId === messageId ? state.answerDraft.text : null
      const taskPromptGeneration = state.taskPromptGeneration
      // Keep the question's raw delivery/ownership flow, adding only the per-user contract.
      // sendRaw already accounts for the complete payload's context length, so do not emit a second sent event.
      const injection = userPromptInjection(true)
      const text = normalizeLineEndings(answer)
      const payload = injection.prefix ? injection.prefix + USER_TEXT_SENTINEL + text : text
      const outcome = await window[STATE_KEY].sendRaw(payload, ownedDraft, { generation: taskPromptGeneration, path: location.pathname, question: { messageId, source } })
      if (outcome === 'ok') {
        reportUserInjection(injection, taskPromptGeneration)
        report({ event: 'user-message', text: answer, submissionKind: 'clarification', taskPromptGeneration, contextUsage: injection.metadata.contextUsage,
          answeredQuestionId: messageId, questionSource: source })
      } else if (outcome === 'stuck' || outcome === 'insert-failed') {
        // A retry may replace only the text that this submission left in the composer.
        const element = getComposer()
        if (element && composerMatches(element, payload)) {
          state.answerDraft = { messageId, text: payload }
        }
      }
      return outcome
    },

    takeUserImageAttachments,
    /** Main refused this live desktop request (stale token, paused task …); nothing will answer it, so stop waiting. */
    releaseRejectedComputer(messageId) {
      if (!lastLiveComputer || lastLiveComputer.messageId !== messageId || state.awaitingReplySince === 0 ||
        lastLiveComputer.since !== state.awaitingReplySince) return false
      lastLiveComputer = null
      setReplyWaiting(0, 'computer-rejected')
      return true
    },
    userSendBlock: () => lastUserSendBlock,
    checkNow,
    armBaseline,
    status: () => ({ ...state })
  }

  // Passive snapshots still run when continuous mutations postpone the settle timer.
  // They never parse, accept or execute a command, and stop recording when the task is idle.
  const replyWatchdog = () => {
    try {
      if (state.awaitingReplySince !== 0 || state.taskActive) {
        const nodes = queryAllAssistant()
        const node = latestReplyNode(nodes)
        const now = Date.now()
        report({
          event: 'reply-watchdog',
          ...snapshotReplyScan(node, nodes),
          messageId: node ? turnKeyOf(node) : null,
          lastScanAgeMs: lastReplyScanAt ? Math.max(0, now - lastReplyScanAt) : null,
          lastMutationAgeMs: lastReplyMutationAt ? Math.max(0, now - lastReplyMutationAt) : null,
          replySettlePending: settleTimer !== null,
          fileSendPending: fileSend?.submitted === true
        })
      }
    } catch (_) {
      report({ event: 'reply-watchdog', replySnapshotAvailable: false })
    } finally {
      setTimeout(replyWatchdog, 5000)
    }
  }
  setTimeout(replyWatchdog, 5000)
  report({ event: 'installed' })
})()
