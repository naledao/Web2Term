/*
 * Chat answer selection UI, injected by embed.ts as browser JavaScript.
 * A closed shadow root keeps its textarea out of the page adapter's composer
 * queries. Events outside the shadow root target the host, not that textarea.
 * Submission is handed to main through a metadata-only, per-view console tag.
 */
;(() => {
  const STATE_KEY = '__cmdTerminalSelectionQuestion'
  if (window[STATE_KEY]) return

  let config = { answerSelectors: [], answerFallbackSelectors: [], theme: 'light', css: '', reportTag: '' }
  let host = null
  let shadow = null
  let stylesheet = null
  let input = null
  let quote = null
  let feedback = null
  let busy = false
  let context = null
  let dismissed = null
  let previousFocus = null
  let pointerSelecting = false
  let pointerInside = false
  let composing = false
  let selectionTimer = 0
  let positionFrame = 0
  let lastDiagnostic = ''
  let selectionStage = 'selection-read'

  const reportUI = (phase, details = {}) => {
    if (!config.reportTag) return
    const metadata = { event: 'question-ui', phase, ...details }
    const signature = JSON.stringify(metadata)
    if (signature === lastDiagnostic) return
    lastDiagnostic = signature
    console.log(config.reportTag + signature)
  }
  const answerCount = () => new Set([...config.answerSelectors, ...config.answerFallbackSelectors]
    .flatMap(selector => [...document.querySelectorAll(selector)])).size

  const inside = (node) => !!host && !!node && (node === host || shadow.contains(node))
  const fromPopover = (event) => !!host && event.composedPath().includes(host)
  const answerOf = (node) => {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
    if (!element || inside(element) || element.closest('input, textarea, button, [role="button"], [contenteditable="true"], .ds-think-content')) return null
    if (config.answerFallbackSelectors.length) {
      const turn = config.answerFallbackSelectors.map(selector => element.closest(selector)).find(Boolean)
      if (!turn) return null
      // Match the transcript extractor's preferred answer root. Falling back
      // only when it is absent supports Claude's code-only turns without
      // treating user messages or surrounding controls as assistant answers.
      const answer = config.answerSelectors.map(selector => turn.matches(selector) ? turn : turn.querySelector(selector)).find(Boolean) || turn
      return answer.contains(element) ? answer : null
    }
    for (const selector of config.answerSelectors) {
      const answer = element.closest(selector)
      if (answer) return answer
    }
    return null
  }
  const sameSelection = (left, right) => !!left && !!right &&
    left.path === right.path && left.text === right.text &&
    left.range.startContainer === right.range.startContainer && left.range.startOffset === right.range.startOffset &&
    left.range.endContainer === right.range.endContainer && left.range.endOffset === right.range.endOffset

  const createUIElement = (tag, attributes = {}, text) => {
    const element = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
    if (text !== undefined) element.textContent = text
    return element
  }
  const createIcon = (paths, attributes = {}) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [name, value] of Object.entries({ viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true', ...attributes })) svg.setAttribute(name, value)
    for (const attributes of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value)
      svg.append(path)
    }
    return svg
  }

  function dismiss(restoreFocus = false) {
    if (busy && config.reportTag) console.log(config.reportTag + JSON.stringify({ event: 'question-cancel' }))
    busy = false
    clearTimeout(selectionTimer)
    cancelAnimationFrame(positionFrame)
    selectionTimer = 0
    positionFrame = 0
    if (context) dismissed = context
    context = null
    if (!host) return
    const focusedInside = document.activeElement === host
    if (host.matches(':popover-open')) host.hidePopover()
    host.hidden = true
    input.value = ''
    input.readOnly = false
    feedback.textContent = ''
    host.removeAttribute('aria-busy')
    input.style.height = ''
    composing = false
    if (focusedInside) {
      input.blur()
      if (restoreFocus && previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true })
      }
    }
    previousFocus = null
  }

  function ensureUI() {
    if (host?.isConnected) return
    host = document.createElement('div')
    host.id = 'cmd-terminal-selection-question'
    host.setAttribute('popover', 'manual')
    host.hidden = true
    host.dataset.theme = config.theme
    shadow = host.attachShadow({ mode: 'closed' })
    stylesheet = document.createElement('style')
    stylesheet.textContent = config.css
    shadow.append(stylesheet)
    // Build nodes directly. A page enforcing Trusted Types rejects even static
    // strings assigned to innerHTML; no HTML policy or security bypass is needed.
    const panel = createUIElement('section', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'question-title' })
    const heading = createUIElement('div', { class: 'question-head' })
    const title = createUIElement('span', { class: 'question-title', id: 'question-title' })
    title.append(createIcon([
      { d: 'M5 14.5 2.75 17v-4.25a6.75 6.75 0 1 1 3 2.25H5Z', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round' },
      { d: 'M6.75 8h6.5M6.75 11h4', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }
    ]), '询问 AI')
    const close = createUIElement('button', { class: 'question-close', type: 'button', 'aria-label': '关闭询问 AI', title: '关闭（Esc）' })
    close.append(createIcon([{ d: 'm6 6 8 8M14 6l-8 8', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }]))
    heading.append(title, close)
    quote = createUIElement('blockquote', { class: 'question-quote', id: 'question-quote', 'aria-label': '选中的内容' })
    input = createUIElement('textarea', { class: 'question-input', 'aria-label': '询问 AI', 'aria-describedby': 'question-quote',
      placeholder: '针对这段内容提问…', rows: '2', spellcheck: 'false' })
    feedback = createUIElement('div', { class: 'question-feedback', role: 'status', 'aria-live': 'polite' })
    const foot = createUIElement('div', { class: 'question-foot' })
    foot.append(createUIElement('span', { class: 'question-submit-hint' }, 'Enter 提问 · Shift+Enter 换行'), createUIElement('span', {}, 'Esc 关闭'))
    panel.append(heading, quote, input, feedback, foot)
    shadow.append(panel)
    close.addEventListener('click', () => dismiss(true))
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = Math.min(144, Math.max(64, input.scrollHeight)) + 'px'
      schedulePosition()
    })
    input.addEventListener('compositionstart', () => { composing = true })
    input.addEventListener('compositionend', () => { composing = false })
    // Let browser editing, paste and IME retain their native default actions;
    // only stop them from bubbling to the site's own message composer handlers.
    for (const name of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'cut', 'copy', 'compositionstart', 'compositionupdate', 'compositionend']) {
      shadow.addEventListener(name, (event) => event.stopPropagation())
    }
    document.body.append(host)
  }

  function position() {
    positionFrame = 0
    if (!context || !host || host.hidden) return
    if (context.path !== location.pathname || !context.answer.isConnected) {
      dismiss()
      return
    }
    const viewport = window.visualViewport
    const bounds = {
      left: viewport?.offsetLeft || 0,
      top: viewport?.offsetTop || 0,
      width: viewport?.width || document.documentElement.clientWidth,
      height: viewport?.height || document.documentElement.clientHeight
    }
    const margin = 12
    const width = Math.min(360, bounds.width - margin * 2)
    if (width < 120 || bounds.height < 100) {
      dismiss()
      return
    }
    host.style.width = width + 'px'
    host.style.maxHeight = (bounds.height - margin * 2) + 'px'
    const rects = [...context.range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 &&
      rect.bottom > bounds.top && rect.top < bounds.top + bounds.height &&
      rect.right > bounds.left && rect.left < bounds.left + bounds.width)
    const anchor = context.backward ? rects[0] : rects.at(-1)
    const panel = host.getBoundingClientRect()
    const minX = bounds.left + margin
    const minY = bounds.top + margin
    const maxX = Math.max(minX, bounds.left + bounds.width - width - margin)
    const maxY = Math.max(minY, bounds.top + bounds.height - panel.height - margin)
    if (!anchor) {
      // Keep a draft on screen if its author scrolls while typing. With no draft,
      // leaving the quoted passage's viewport dismisses the selection affordance.
      if (input.value || document.activeElement === host) {
        host.style.left = Math.round(Math.max(minX, Math.min(panel.left, maxX))) + 'px'
        host.style.top = Math.round(Math.max(minY, Math.min(panel.top, maxY))) + 'px'
        return
      }
      dismiss()
      return
    }
    const height = panel.height
    const below = anchor.bottom + 10
    const above = anchor.top - height - 10
    host.style.left = Math.round(Math.max(minX, Math.min(anchor.left, maxX))) + 'px'
    host.style.top = Math.round(Math.max(minY, Math.min(below + height + margin <= bounds.top + bounds.height ? below : above, maxY))) + 'px'
  }

  function schedulePosition() {
    if (context && !positionFrame) positionFrame = requestAnimationFrame(position)
  }

  function readSelection() {
    selectionStage = 'selection-read'
    selectionTimer = 0
    if (pointerSelecting || pointerInside || document.activeElement === host) return
    const selection = window.getSelection()
    if (selection && (inside(selection.anchorNode) || inside(selection.focusNode))) return
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
      reportUI('no-selection')
      dismiss()
      return
    }
    const range = selection.getRangeAt(0)
    selectionStage = 'answer-match'
    const answer = answerOf(range.startContainer)
    const endAnswer = answerOf(range.endContainer)
    const text = selection.toString().trim()
    if (!answer || answer !== endAnswer || !text) {
      reportUI('answer-rejected', { selectedLength: text.length, answerCount: answerCount(),
        startAnswerFound: !!answer, endAnswerFound: !!endAnswer, sameAnswer: !!answer && answer === endAnswer })
      dismiss()
      return
    }
    const next = { range: range.cloneRange(), answer, text, path: location.pathname, answerText: answer.innerText || '',
      backward: selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset }
    if (sameSelection(next, dismissed)) { reportUI('previously-dismissed', { selectedLength: text.length }); return }
    if (!sameSelection(next, context)) {
      previousFocus = document.activeElement
      selectionStage = 'ui-create'
      ensureUI()
      input.value = ''
      input.style.height = ''
      quote.textContent = text
      context = next
    }
    host.hidden = false
    selectionStage = 'popover-open'
    if (!host.matches(':popover-open')) host.showPopover()
    // Showing the non-modal popover must not steal the text selection or Ctrl+C.
    selectionStage = 'position'
    position()
    reportUI(host.hidden ? 'out-of-view' : 'shown', { selectedLength: text.length, answerCount: answerCount() })
  }

  function scheduleSelection(delay = 100) {
    clearTimeout(selectionTimer)
    selectionTimer = setTimeout(() => {
      try { readSelection() } catch (error) {
        reportUI('selection-error', { errorName: ['TypeError', 'NotSupportedError', 'InvalidStateError'].includes(error?.name) ? error.name : 'Error',
          errorStage: selectionStage, trustedTypesBlocked: /TrustedHTML|Trusted Types|trusted-types/i.test(String(error?.message || '')) })
      }
    }, delay)
  }

  document.addEventListener('selectionchange', () => {
    if (!pointerSelecting && !pointerInside && document.activeElement !== host) scheduleSelection()
  })
  window.addEventListener('pointerdown', (event) => {
    if (fromPopover(event)) { pointerInside = true; return }
    if (event.button !== 0) return
    pointerSelecting = true
    dismiss()
    // A deliberate new drag over the same words may reopen a dismissed popup.
    if (answerOf(event.target)) dismissed = null
    reportUI('drag-start', { startAnswerFound: !!answerOf(event.target) })
  }, true)
  const finishPointerSelection = (event) => {
    if (pointerInside || fromPopover(event)) { pointerInside = false; return }
    if (!pointerSelecting) return
    pointerSelecting = false
    reportUI('drag-end')
    scheduleSelection(0)
  }
  // Sites can stop pointerup before it reaches document. Read the selection
  // from the window capture phase, with mouseup covering a lost pointerup.
  // The state guard above makes the two release events idempotent.
  window.addEventListener('pointerup', finishPointerSelection, true)
  window.addEventListener('mouseup', finishPointerSelection, true)
  window.addEventListener('pointercancel', () => { pointerSelecting = false; pointerInside = false }, true)
  // Stop Enter from reaching site-level shortcuts; retain native textarea/IME
  // defaults. Escape closes this UI unless the user is still composing text.
  for (const name of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(name, (event) => {
      if (fromPopover(event) && event.key === 'Enter') {
        event.stopImmediatePropagation()
        if (name === 'keydown' && shadow.activeElement === input && config.reportTag &&
            !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
            !event.repeat && !event.isComposing && !composing && event.keyCode !== 229 && event.isTrusted) {
          event.preventDefault()
          if (busy) return
          if (!input.value.trim()) { setStatus('请先输入要提问的问题。'); return }
          if (input.value.length > 20000 || context.text.length > 20000) {
            setStatus('问题或选中文字过长，请缩短后重试。'); return
          }
          setStatus('正在整理本地对话…', true)
          console.log(config.reportTag + JSON.stringify({ event: 'question-submit' }))
        }
      }
      if (name !== 'keydown' || event.key !== 'Escape' || event.isComposing || composing || event.keyCode === 229 || !context) return
      event.preventDefault()
      event.stopImmediatePropagation()
      dismiss(true)
    }, true)
  }
  window.addEventListener('scroll', schedulePosition, true)
  window.addEventListener('resize', schedulePosition)
  window.visualViewport?.addEventListener('resize', schedulePosition)
  window.visualViewport?.addEventListener('scroll', schedulePosition)
  window.addEventListener('popstate', () => dismiss())
  window.addEventListener('hashchange', () => dismiss())
  window.addEventListener('blur', () => { pointerSelecting = false; pointerInside = false })

  function setStatus(message, pending = false) {
    if (!context || !host) return
    busy = pending
    input.readOnly = pending
    host.setAttribute('aria-busy', String(pending))
    feedback.textContent = String(message || '')
    feedback.dataset.pending = String(pending)
    schedulePosition()
  }

  window[STATE_KEY] = {
    configure(next) {
      config = { answerSelectors: Array.isArray(next.answerSelectors) ? next.answerSelectors : [],
        answerFallbackSelectors: Array.isArray(next.answerFallbackSelectors) ? next.answerFallbackSelectors : [],
        theme: next.theme === 'dark' ? 'dark' : 'light', css: String(next.css || ''), reportTag: String(next.reportTag || '') }
      if (host) {
        host.dataset.theme = config.theme
        stylesheet.textContent = config.css
        schedulePosition()
      }
      reportUI('configured', { selectorCount: config.answerSelectors.length, answerCount: answerCount(),
        popoverSupported: typeof document.createElement('div').showPopover === 'function' })
    },
    dismiss,
    setStatus,
    getSubmission() {
      if (!context || !context.answer.isConnected || context.path !== location.pathname) return null
      if (!context.answer.contains(context.range.startContainer) || !context.answer.contains(context.range.endContainer) ||
          context.range.toString().trim() !== context.text || (context.answer.innerText || '') !== context.answerText) return null
      return { selectedText: context.text, question: input.value.trim(), sourcePath: context.path,
        answerText: context.answerText,
        sourceMessageId: window.__cmdTerminalInterceptor?.questionSourceMessageId?.(context.answer) || undefined }
    },
    // Read-only draft for diagnostics.
    // Neither the selection nor the question is logged or sent anywhere here.
    getDraft() {
      return context ? { selectedText: context.text, question: input.value, sourcePath: context.path } : null
    }
  }
})()
