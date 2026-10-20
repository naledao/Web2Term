/* Readiness only. Actual sending uses the attachment bridge with terminal mode disabled. */
window.__questionChatReady = page => {
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
  const inputs = [...new Set(page.composerSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))].filter(visible)
  return { composer: inputs.length === 1, hasHistory: !!document.querySelector('[data-virtual-list-item-key], .ds-assistant-message-main-content') }
}
