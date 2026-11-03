/* The original page's response preference survey can block the composer and task loop.
 * Match its title AND both actions outside message content before pressing only Skip.
 * Independent of terminal mode, and installed once per document by embed.ts.
 */
;(() => {
  const STATE_KEY = '__cmdTerminalResponsePreference'
  if (window[STATE_KEY]) return

  const CONTROL_SELECTOR = 'button, [role="button"]'
  const TEXT_SELECTOR = 'h1, h2, h3, [role="heading"], p, div, span'
  const CONTENT_SELECTOR = 'pre, code, textarea, input, [contenteditable="true"]'
  const SETTLE_MS = 400
  const RETRY_MS = 1500
  const MAX_ATTEMPTS = 3
  let rules = null
  let timer = null
  let pending = null

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().replace(/？/g, '?').toLowerCase()
  const visible = element => {
    if (!element?.isConnected || !element.getClientRects().length ||
        element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'
  }
  const outsideContent = element => !element.closest(CONTENT_SELECTOR) &&
    (!rules.ignoreSelector || !element.closest(rules.ignoreSelector))
  const enabled = element => !element.disabled && !element.closest('[disabled], [aria-disabled="true"]')
  const matchesLabel = (element, labels) => labels.includes(normalize(element.innerText))

  const findSurvey = () => {
    const controls = [...document.querySelectorAll(CONTROL_SELECTOR)].filter(element => visible(element) && outsideContent(element))
    for (const skip of controls.filter(element => matchesLabel(element, rules.skipLabels) && enabled(element))) {
      for (let scope = skip.parentElement; scope && scope !== document.documentElement; scope = scope.parentElement) {
        const actions = controls.filter(element => scope.contains(element))
        // Ambiguous or unrelated Skip actions must never be selected by document order.
        if (actions.filter(element => matchesLabel(element, rules.skipLabels)).length !== 1) break
        const choices = actions.filter(element => matchesLabel(element, rules.chooseLabels))
        if (choices.length !== 1) continue
        const prompt = [...scope.querySelectorAll(TEXT_SELECTOR)].find(element =>
          rules.promptLabels.includes(normalize(element.textContent)) && visible(element) && outsideContent(element) &&
          !element.closest(CONTROL_SELECTOR) && matchesLabel(element, rules.promptLabels))
        if (prompt) return { skip, prompt, scope }
      }
    }
    return null
  }

  // Coalesce streaming mutations without postponing the scan until the stream ends.
  const schedule = (delay = 150) => {
    if (!rules || timer !== null) return
    timer = setTimeout(() => { timer = null; scan() }, delay)
  }
  const scan = () => {
    if (!rules) return
    const survey = findSurvey()
    if (!survey) { pending = null; return }
    const now = Date.now()
    const sameSurvey = pending && pending.path === location.pathname &&
      pending.prompt === survey.prompt && pending.scope === survey.scope
    if (!sameSurvey || pending.skip !== survey.skip) {
      pending = { ...survey, path: location.pathname, readyAt: now + SETTLE_MS,
        attempts: sameSurvey ? pending.attempts : 0, lastClickAt: sameSurvey ? pending.lastClickAt : 0 }
    }
    if (pending.attempts >= MAX_ATTEMPTS) return
    const wait = Math.max(pending.readyAt, pending.lastClickAt + RETRY_MS) - now
    if (wait > 0) { schedule(wait); return }
    // Do not press a survey covered by another dialog or an offscreen control.
    const rect = survey.skip.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (!hit || !survey.skip.contains(hit)) return
    pending.attempts += 1
    pending.lastClickAt = now
    survey.skip.click()
    console.info('[response-preference] ' + JSON.stringify({ event: 'skip-clicked', attempt: pending.attempts }))
    schedule(RETRY_MS)
  }

  const observer = new MutationObserver(() => schedule())
  window[STATE_KEY] = {
    configure(config) {
      observer.disconnect()
      if (timer !== null) clearTimeout(timer)
      timer = null
      const labels = name => Array.isArray(config?.[name]) ? config[name].filter(value => typeof value === 'string' && value.trim()).map(normalize) : []
      const next = { promptLabels: labels('promptLabels'), skipLabels: labels('skipLabels'), chooseLabels: labels('chooseLabels'),
        ignoreSelector: typeof config?.ignoreSelector === 'string' ? config.ignoreSelector : '' }
      rules = next.promptLabels.length && next.skipLabels.length && next.chooseLabels.length ? next : null
      if (!rules) { pending = null; return }
      observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['hidden', 'inert', 'aria-hidden', 'disabled', 'aria-disabled', 'class', 'style']
      })
      schedule()
    }
  }
})()
