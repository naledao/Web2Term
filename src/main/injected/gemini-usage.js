(() => {
  if (location.origin !== 'https://gemini.google.com' || !/^\/(?:u\/\d{1,3}\/)?usage\/?$/.test(location.pathname)) return null

  const compact = text => String(text ?? '').replace(/\s+/g, ' ').trim()
  const visible = node => node.getClientRects().length > 0 &&
    !node.closest('nav, aside, dialog, [role="dialog"], [hidden], [inert], [aria-hidden="true"]') &&
    !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const main = [...document.querySelectorAll('main, [role="main"]')].find(visible)
  if (!main) return null

  const limitName = {
    current: /^(?:当前用量|目前用量|current usage)$/i,
    weekly: /^(?:每周限额|每週限額|每周用量上限|每週用量上限|weekly (?:usage )?limit)$/i
  }
  const percentPattern = /^(?:(?:已使用|已用|used)\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*[%％]|(\d{1,3}(?:[.,]\d{1,2})?)\s*[%％]\s*used)$/i
  const resetPrefix = /^(?:重[置設][时時][间間]\s*[：:]?\s*|reset time\s*:\s*|resets?\s+(?:at\s+|on\s+|in\s+)?)(.+)$/i
  const rows = { current: null, weekly: null }
  const seen = new Set()
  // Each observed quota lives in its own list item. The weekly item's reset
  // time comes before its percentage, so pair values by ancestry.
  for (const heading of [...main.querySelectorAll('li strong')].slice(0, 120)) {
    const name = compact(heading.textContent)
    const key = Object.keys(limitName).find(key => limitName[key].test(name))
    if (!key || !visible(heading)) continue
    if (seen.has(key)) return null
    seen.add(key)
    const item = heading.closest('li')
    const values = [...item.querySelectorAll('strong')].filter(node => visible(node) && node.closest('li') === item)
      .map(node => percentPattern.exec(compact(node.textContent))).filter(Boolean)
    if (values.length !== 1) continue

    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
    let resetLabel = null
    for (let node = walker.nextNode(), count = 0; node && count < 80; node = walker.nextNode(), count++) {
      if (!node.parentElement || !visible(node.parentElement) || node.parentElement.closest('li') !== item) continue
      const label = resetPrefix.exec(compact(node.nodeValue))?.[1]
      if (!label || label.length > 72 || !/\d/.test(label) || /[%％@<>]/.test(label)) continue
      resetLabel = label
      break
    }
    rows[key] = { usedPercent: Number((values[0][1] ?? values[0][2]).replace(',', '.')), resetLabel }
  }
  return rows.current && rows.weekly ? rows : null
})()
