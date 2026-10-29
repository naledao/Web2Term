import { session } from 'electron'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { normalizeSoftwareProxy } from '../shared/software-proxy'

// In-memory session: never share browser cookies, cache or per-platform proxy settings.
const PARTITION = 'software-network'
let configuration: Promise<void> | null = null
let activeProxy: string | undefined

/** Serialize changes and make HTTP callers wait until the selected route is applied. */
export function applySoftwareProxy(value: string): Promise<void> {
  const proxy = normalizeSoftwareProxy(value)
  const pending = (configuration ?? Promise.resolve()).catch(() => {}).then(async () => {
    const softwareSession = session.fromPartition(PARTITION)
    await softwareSession.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'direct' })
    await softwareSession.closeAllConnections()
    activeProxy = proxy
  })
  configuration = pending
  return pending
}

/** Backend services retain their explicit Authorization headers, but never send cookies. */
export const softwareFetch: typeof fetch = async (input, init) => {
  if (!configuration) throw new Error('软件网络尚未初始化，请重试。')
  await configuration
  return session.fromPartition(PARTITION).fetch(input instanceof URL ? input.href : input, {
    ...init, credentials: 'omit', cache: 'no-store'
  })
}

/** Proxy changes affect the next handshake; established terminals keep their current socket. */
export function createSoftwareSocket(url: string, options: ClientOptions): WebSocket {
  if (activeProxy === undefined) throw new Error('软件网络尚未初始化，请重试。')
  return new WebSocket(url, { ...options, agent: activeProxy ? new HttpsProxyAgent(activeProxy) : undefined })
}
