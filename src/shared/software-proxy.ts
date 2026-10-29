export const DEFAULT_SOFTWARE_PROXY = 'http://127.0.0.1:7897'

/** A single HTTP(S) proxy shared by backend HTTP and WebSocket connections. */
export function normalizeSoftwareProxy(value: unknown): string {
  if (typeof value !== 'string') throw new Error('软件代理必须是文本。')
  const input = value.trim()
  if (!input) return ''
  if (input.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(input)) {
    throw new Error('软件代理地址不能包含空白、控制字符或反斜杠。')
  }
  let address: URL
  try {
    address = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(input) ? input : `http://${input}`)
  } catch {
    throw new Error('软件代理地址无效，请填写 http://主机:端口 或 https://主机:端口。')
  }
  if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.port === '0' ||
    address.username || address.password || address.pathname !== '/' || input.includes('?') || input.includes('#')) {
    throw new Error('软件代理仅支持 HTTP / HTTPS 地址，请勿包含账号、密码、路径或查询参数。')
  }
  return address.origin
}

/** A saved empty value deliberately selects direct connections, including after restart. */
export function readSoftwareProxy(value: string | null | undefined): string {
  try { return normalizeSoftwareProxy(value ?? DEFAULT_SOFTWARE_PROXY) }
  catch { return DEFAULT_SOFTWARE_PROXY }
}
