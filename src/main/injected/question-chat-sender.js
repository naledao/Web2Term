/* Readiness only. Actual sending uses the attachment bridge with terminal mode disabled. */
window.__questionChatReady = page => {
  const visible = node => node.isConnected !== false && node.getClientRects().length > 0 &&
    !node.closest?.('[hidden], [inert], [aria-hidden="true"]') && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  // Use the same selector priority as the sending bridge. A generic editable
  // fallback can also match Gemini's other editors; it must not make the one
  // measured Quill composer ambiguous merely by being present on the page.
  const groups = page.composerSelectors.map(selector => [...new Set(document.querySelectorAll(selector))].filter(visible))
  const candidates = [...new Set(groups.flat())]
  const selectorIndex = groups.findIndex(group => group.length > 0)
  const focused = page.composerSelectors.map(selector => document.activeElement?.closest?.(selector)).find(node => node && visible(node))
  const inputs = focused ? [focused] : selectorIndex >= 0 ? groups[selectorIndex] : []
  const historySelectors = [...(page.messageSelectors || []), ...(page.assistantSelectors || [])]
  const hasHistory = historySelectors.some(selector => [...document.querySelectorAll(selector)]
    .some(node => !page.ignoreHiddenReplyNodes || visible(node)))
  // ChatGPT initially renders textarea#pending-home-input before mounting its
  // full editor and uploader. It accepts early manual input, but cannot yet
  // receive our attachment. Keep polling without consuming the send attempt.
  const composer = inputs.length === 1 && (page.composerKind !== 'contenteditable' || inputs[0].isContentEditable)
  const fileInputs = [...document.querySelectorAll('input[type="file"]')].filter(input => !input.disabled)
  const enabledControl = node => visible(node) && !node.closest('[aria-hidden="true"]') && !node.disabled &&
    node.getAttribute('aria-disabled') !== 'true' && !(page.disabledControlSelectors || []).some(selector => node.matches(selector))
  // Gemini mounts a transient file input after its upload menu is opened.
  // Wait for the measured toolbar entry without opening the menu here.
  const root = composer && page.fileComposerRootSelector ? inputs[0].closest(page.fileComposerRootSelector) : null
  const uploadEntries = page.fileLocalUploadSelector ? [...new Set([
    ...document.querySelectorAll(page.fileLocalUploadSelector),
    ...(page.fileUploadMenuSelectors || []).flatMap(selector => [...(root?.querySelectorAll(selector) || [])])
  ])].filter(enabledControl) : []
  return {
    composer, hasHistory, uploadReady: page.fileLocalUploadSelector ? uploadEntries.length > 0 : fileInputs.length > 0,
    composerCount: inputs.length, composerTag: inputs.length === 1 ? inputs[0].tagName.toLowerCase() : '',
    composerCandidateCount: candidates.length, composerSelectorIndex: selectorIndex, composerSelectorCounts: groups.map(group => group.length),
    fileInputCount: fileInputs.length, uploadEntryCount: uploadEntries.length, uploadRootFound: !!root
  }
}
