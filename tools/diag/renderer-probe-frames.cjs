const INJECTED_SOURCE = 'web2term-diagnostics://injected/chat-interceptor.js'
const SITES = {
  chatgpt: ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com'],
  claude: ['claude.ai', 'anthropic.com', 'claudeusercontent.com'],
  deepseek: ['deepseek.com', 'deepseekusercontent.com'],
  gemini: ['gemini.google.com', 'gstatic.com', 'googleusercontent.com'],
  'google-auth': ['accounts.google.com'],
  cloudflare: ['cloudflare.com']
}

function sourceKind(value) {
  if (value === INJECTED_SOURCE) return 'web2term-interceptor'
  if (!value || value === 'about:blank' || value === 'about:srcdoc') return 'inline'
  try {
    const url = new URL(value)
    if (url.protocol === 'blob:') return sourceKind(url.origin)
    if (url.protocol === 'file:') return 'local-file'
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'other'
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'loopback'
    for (const [kind, hosts] of Object.entries(SITES)) {
      if (hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return kind
    }
    return 'other-web'
  } catch {
    return 'other'
  }
}

function frameMetadata(frame, zeroBased = true) {
  const source = sourceKind(frame.url)
  const sourceIsApp = ['web2term-interceptor', 'loopback', 'local-file'].includes(source)
  const asset = source === 'chatgpt'
    ? /^https:\/\/(?:[\w-]+\.)?(?:oaistatic\.com|chatgpt\.com)\/(?:assets|cdn\/assets|_next\/static)\/(?:[\w.-]+\/)*([\w.-]{1,110}\.m?js)(?:[?#]|$)/.exec(frame.url)?.[1]
    : undefined
  const name = frame.functionName
  const nativeName = ['(program)', '(garbage collector)'].includes(name)
  const safeName = typeof name === 'string' && name.length <= 64 && /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*){0,4}$/.test(name)
  const position = value => Number.isInteger(value) && value >= (zeroBased ? 0 : 1) ? value + Number(zeroBased) : undefined
  return {
    source,
    asset,
    scriptId: /^\d{1,12}$/.test(frame.scriptId) ? String(frame.scriptId) : undefined,
    line: position(frame.lineNumber),
    column: position(frame.columnNumber),
    name: nativeName || ((sourceIsApp || asset) && safeName) ? name : undefined
  }
}

module.exports = { sourceKind, frameMetadata }
