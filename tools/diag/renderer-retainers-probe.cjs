const { freemem } = require('node:os')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { Worker } = require('node:worker_threads')

const MIN_FREE_BYTES = 3 * 1024 ** 3
const MAX_PENDING_SNAPSHOT_BYTES = 256 * 1024 ** 2
const SNAPSHOT_TIMEOUT_MS = 75_000
const ANALYSIS_TIMEOUT_MS = 55_000
const GROWTH_WAIT_MS = 30_000
const ANALYSIS_HEAP_MIB = 768
const MIN_PRIVATE_GROWTH_KIB = 16 * 1024

class ProbeError extends Error {
  constructor(code, details) {
    super(code)
    this.details = details
  }
}

function collectSnapshot(debuggerApi, send, signal) {
  if (signal.aborted) throw new ProbeError('capture-ended')
  const worker = new Worker(join(__dirname, 'renderer-heap-summary-worker.cjs'), {
    resourceLimits: { maxOldGenerationSizeMb: ANALYSIS_HEAP_MIB }
  })
  let bytes = 0
  let pendingBytes = 0
  let backlogLimit = false
  let layout
  let workerResult
  let workerExited = false
  let timer
  let cancel
  const terminate = () => { void worker.terminate().catch(() => {}) }
  const analysis = new Promise(resolve => {
    cancel = () => { terminate(); resolve({ error: 'capture-ended' }) }
    worker.on('message', message => {
      if (message.layout) layout = message.layout
      if (Number.isInteger(message.consumedBytes)) {
        pendingBytes -= message.consumedBytes
        return
      }
      workerResult = message
      resolve(message.result)
    })
    worker.once('error', () => { workerExited = true; resolve({ error: 'snapshot-analysis-worker-failed' }) })
    worker.once('exit', () => { workerExited = true; resolve({ error: 'snapshot-analysis-worker-exited' }) })
    signal.addEventListener('abort', cancel, { once: true })
  })
  const onChunk = (_event, method, params, sessionId) => {
    if (method !== 'HeapProfiler.addHeapSnapshotChunk' || sessionId ||
        signal.aborted || typeof params.chunk !== 'string') return
    const chunkBytes = Buffer.byteLength(params.chunk)
    bytes += chunkBytes
    if (workerResult || workerExited || backlogLimit) return
    pendingBytes += chunkBytes
    if (pendingBytes > MAX_PENDING_SNAPSHOT_BYTES) {
      backlogLimit = true
      terminate()
      return
    }
    try { worker.postMessage({ chunk: params.chunk, bytes: chunkBytes }) }
    catch { workerExited = true; terminate() }
  }
  debuggerApi.on('message', onChunk)

  return (async () => {
    try {
      try {
        await send('HeapProfiler.takeHeapSnapshot', { captureNumericValue: false }, undefined, SNAPSHOT_TIMEOUT_MS)
      } catch {
        throw new ProbeError('snapshot-command-failed', { snapshotBytes: bytes, layout })
      }
      if (signal.aborted) throw new ProbeError('capture-ended')
      if (backlogLimit) throw new ProbeError('snapshot-stream-backlog', { snapshotBytes: bytes, layout })
      if (!bytes) throw new ProbeError('snapshot-no-chunks')
      if (!workerExited && !workerResult) worker.postMessage(null)
      const summary = await Promise.race([
        analysis,
        new Promise(resolve => { timer = setTimeout(() => resolve({ error: 'snapshot-analysis-timeout' }), ANALYSIS_TIMEOUT_MS) })
      ])
      if (summary.error) throw new ProbeError(summary.error, { snapshotBytes: bytes, layout, parser: summary.diagnostic })
      return { bytes, ...summary }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      debuggerApi.off('message', onChunk)
      terminate()
    }
  })()
}

async function mapScripts(debuggerApi, send, ids, frameMetadata) {
  const scripts = new Map()
  const onScript = (_event, method, params, sessionId) => {
    if (method !== 'Debugger.scriptParsed' || sessionId || !ids.has(params.scriptId)) return
    const { source, asset } = frameMetadata({ url: params.url, scriptId: params.scriptId, functionName: '' })
    const sha256 = /^[a-f0-9]{64}$/i.test(params.hash) ? params.hash : undefined
    scripts.set(params.scriptId, { scriptId: params.scriptId, source, asset, sha256,
      hasSourceMap: Boolean(params.sourceMapURL) })
  }
  debuggerApi.on('message', onScript)
  try {
    await send('Debugger.enable', {}, undefined, 5000)
    return [...scripts.values()]
  } finally {
    debuggerApi.off('message', onScript)
    await send('Debugger.disable').catch(() => {})
  }
}

function groupChanges(first, second) {
  const groups = new Set([...Object.keys(first.groups), ...Object.keys(second.groups)])
  return Object.fromEntries([...groups].map(group => [group, {
    detached: (second.groups[group]?.detached ?? 0) - (first.groups[group]?.detached ?? 0),
    attached: (second.groups[group]?.attached ?? 0) - (first.groups[group]?.attached ?? 0),
    unknown: (second.groups[group]?.unknown ?? 0) - (first.groups[group]?.unknown ?? 0),
    detachedSelfBytes: (second.groups[group]?.selfBytes ?? 0) - (first.groups[group]?.selfBytes ?? 0)
  }]))
}

function scriptIds(profiles, snapshots = []) {
  const ids = new Set()
  for (const profile of [profiles.cpu, profiles.allocations]) {
    for (const stack of profile?.stacks ?? []) {
      for (const frame of stack.leafFirst) if (frame.scriptId && frame.scriptId !== '0') ids.add(frame.scriptId)
    }
  }
  for (const snapshot of snapshots) {
    for (const path of snapshot.paths) {
      for (const frame of path.leafFirst) if (frame.location?.scriptId) ids.add(frame.location.scriptId)
    }
  }
  return ids
}

function createRetainersProbe({ write, command, connectedDom, measure, captureProfiles, frameMetadata }) {
  let started = false
  let stopped = false
  let cancel
  let previousPrivate = new Map()

  async function capture(contents, metadata) {
    const debuggerApi = contents.debugger
    const controller = new AbortController()
    const { signal } = controller
    let attached = false
    let phase = 'attach'
    let documentChanged = false
    const onNavigation = (_event, details) => {
      if (details?.isMainFrame && !details.isSameDocument) {
        documentChanged = true
        controller.abort()
      }
    }
    const onDetach = () => { attached = false; controller.abort() }
    const finish = () => {
      controller.abort()
      contents.off('did-start-navigation', onNavigation)
      debuggerApi.off('detach', onDetach)
      try { if (attached && debuggerApi.isAttached()) debuggerApi.detach() } catch { /* View closed. */ }
      attached = false
    }
    const send = (method, params, sessionId, timeoutMs) => {
      if (!attached || signal.aborted) return Promise.reject(new ProbeError('capture-ended'))
      return command(debuggerApi, method, params, sessionId, timeoutMs)
    }
    cancel = finish

    try {
      if (freemem() < MIN_FREE_BYTES) throw new ProbeError('system-memory-low')
      debuggerApi.attach('1.3')
      attached = true
      debuggerApi.on('detach', onDetach)
      contents.on('did-start-navigation', onNavigation)
      const original = await connectedDom(send)
      if (!original?.timeOrigin) throw new ProbeError('document-identity-unavailable')
      const initialUrl = contents.getURL()
      async function checkDocument() {
        if (documentChanged || contents.isDestroyed() || contents.getOSProcessId() !== metadata.pid ||
            contents.getURL() !== initialUrl) throw new ProbeError('document-changed')
        if (signal.aborted) throw new ProbeError('capture-ended')
        const connected = await connectedDom(send)
        if (!connected?.timeOrigin || connected.timeOrigin !== original.timeOrigin) throw new ProbeError('document-identity-changed')
        return connected
      }

      async function take(which) {
        phase = which
        const before = await checkDocument()
        const memoryBefore = await measure(send)
        if (freemem() < MIN_FREE_BYTES) throw new ProbeError('system-memory-low')
        write('RETAINERS-SNAPSHOT-START', { ...metadata, phase, connected: before, memory: memoryBefore })
        const summary = await collectSnapshot(debuggerApi, send, signal)
        const connected = await checkDocument()
        const memory = await measure(send)
        write('RETAINERS-SNAPSHOT', { ...metadata, phase, connected, memory, ...summary })
        return summary
      }

      async function writeScripts(profiles, snapshots) {
        const ids = scriptIds(profiles, snapshots)
        if (!ids.size) return
        const scripts = await mapScripts(debuggerApi, send, ids, frameMetadata)
        write('RETAINERS-SCRIPTS', { ...metadata, requested: ids.size, scripts })
      }

      await send('HeapProfiler.enable', {}, undefined, 5000)
      write('RETAINERS-TARGET', { ...metadata, growthWaitMs: GROWTH_WAIT_MS, snapshotReader: 'streaming' })
      let first
      try {
        first = await take('baseline')
      } catch (error) {
        // A parser failure still leaves the attached renderer available for
        // an ordinary profile and script identification in the same run.
        if (error instanceof ProbeError && error.details?.snapshotBytes && error.message !== 'snapshot-command-failed') {
          try {
            await checkDocument()
            const profiles = await captureProfiles(send, signal)
            await checkDocument()
            write('RETAINERS-HOTSPOTS', { ...metadata, phase: 'snapshot-fallback', ...profiles })
            await writeScripts(profiles)
          } catch { /* Report the original snapshot failure below. */ }
        }
        throw error
      }
      phase = 'observe-growth'
      const [profiles] = await Promise.all([
        captureProfiles(send, signal),
        delay(GROWTH_WAIT_MS, undefined, { signal })
      ])
      await checkDocument()
      write('RETAINERS-HOTSPOTS', { ...metadata, ...profiles })
      const second = await take('follow-up')
      phase = 'resolve-scripts'
      write('RETAINERS-COMPARISON', { ...metadata, nodeDelta: second.nodeCount - first.nodeCount,
        groups: groupChanges(first, second) })
      await writeScripts(profiles, [first, second])
      if (!stopped) console.info('[renderer-diag] heap comparison recorded')
    } catch (error) {
      if (!stopped) {
        const reason = documentChanged ? 'document-changed'
          : error instanceof ProbeError ? error.message : 'target-protocol-failed'
        write('RETAINERS-UNAVAILABLE', { ...metadata, phase, reason,
          ...(error instanceof ProbeError ? error.details : undefined) })
        console.info(`[renderer-diag] heap comparison stopped (${phase}: ${reason})`)
      }
    } finally {
      finish()
      cancel = undefined
    }
  }

  return {
    consider(metrics, owners, tick) {
      if (stopped || started) return
      const memoryFor = ({ memory }) => memory.privateBytes ?? memory.workingSetSize
      const processKey = ({ pid, creationTime }) => `${pid}:${creationTime}`
      const lastPrivate = previousPrivate
      previousPrivate = new Map(metrics.map(metric => [processKey(metric), memoryFor(metric)]))
      const candidates = metrics.filter(metric => {
        const memory = memoryFor(metric)
        const previous = lastPrivate.get(processKey(metric))
        return metric.cpu.percentCPUUsage >= 5 && memory >= 256 * 1024 &&
          previous !== undefined && memory - previous >= MIN_PRIVATE_GROWTH_KIB
      })
        .sort((a, b) => b.cpu.percentCPUUsage - a.cpu.percentCPUUsage)
      for (const { pid, creationTime } of candidates) {
        const mainOwners = (owners.get(pid) ?? []).filter(owner => owner.isMain)
        if (mainOwners.length !== 1 || mainOwners[0].view.page !== 'chatgpt') continue
        const { id: viewId, contents } = mainOwners[0].view
        if (contents.isDestroyed() || contents.isDevToolsOpened() || contents.debugger.isAttached()) continue
        started = true
        void capture(contents, { tick, pid, creationTime, viewId }).catch(() => {
          if (!stopped) write('RETAINERS-UNAVAILABLE', { tick, pid, viewId, phase: 'attach', reason: 'target-disconnected' })
        })
        return
      }
    },
    stop() { stopped = true; cancel?.() }
  }
}

module.exports = { createRetainersProbe }
