// Loaded by the user-started development app. All output is bounded metadata.
const { app, webContents } = require('electron')
const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { sourceKind, frameMetadata } = require('./renderer-probe-frames.cjs')

const INTERVAL_MS = 8000
const DURATION_MS = 5 * 60_000
const COMMAND_TIMEOUT_MS = 2200
const PROFILE_MS = 2500
const PROFILE_GAP_MS = 45_000
const MAX_PROFILES = 8
const ALLOCATION_MS = 15_000
const ALLOCATION_INTERVAL_BYTES = 128 * 1024
const MAX_ALLOCATION_PROFILES = 2
const CONNECTED_NODE_LIMIT = 100_000
const MAX_LOG_BYTES = 2 * 1024 * 1024
let started = false

function processOwners() {
  const owners = new Map()
  for (const contents of webContents.getAllWebContents()) {
    try {
      const url = contents.getURL()
      if (!url || contents.getType() === 'remote') continue
      const mainPid = contents.getOSProcessId()
      const view = { contents, id: contents.id, kind: contents.getType(), page: sourceKind(url) }
      const byPid = new Map()
      if (mainPid > 0) byPid.set(mainPid, { view, isMain: true, frameSites: new Set() })
      for (const frame of contents.mainFrame.framesInSubtree) {
        const pid = frame.osProcessId
        if (pid <= 0 || pid === mainPid) continue
        if (!byPid.has(pid)) byPid.set(pid, { view, isMain: false, frameSites: new Set() })
        byPid.get(pid).frameSites.add(sourceKind(frame.url))
      }
      for (const [pid, owner] of byPid) {
        if (!owners.has(pid)) owners.set(pid, [])
        owners.get(pid).push(owner)
      }
    } catch {
      // A destroyed or navigating view can lose its frame tree between property reads.
    }
  }
  return owners
}

function ownerMetadata({ view, isMain, frameSites }) {
  return { viewId: view.id, kind: view.kind, page: view.page, target: isMain ? 'main' : 'subframe',
    frameSites: [...frameSites] }
}

function framePid(contents, url) {
  if (!url || url.startsWith('about:') || url.startsWith('data:')) return null
  try {
    const pids = new Set()
    for (const frame of contents.mainFrame.framesInSubtree) {
      if (frame.url === url && frame.osProcessId > 0) pids.add(frame.osProcessId)
    }
    return pids.size === 1 ? pids.values().next().value : null
  } catch {
    return null
  }
}

function profileSummary(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id)
  }

  const hits = new Map()
  for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1)
  let idleSamples = 0
  const stacks = []
  for (const [id, samples] of [...hits].sort((a, b) => b[1] - a[1])) {
    if (nodes.get(id)?.callFrame.functionName === '(idle)') {
      idleSamples += samples
      continue
    }
    if (stacks.length >= 8) continue
    const stack = []
    for (let current = id; current !== undefined && stack.length < 5; current = parents.get(current)) {
      const frame = nodes.get(current)?.callFrame
      if (!frame || frame.functionName === '(root)') break
      stack.push(frameMetadata(frame))
    }
    if (stack.length) stacks.push({ samples, leafFirst: stack })
  }
  return { totalSamples: profile.samples?.length ?? 0, idleSamples, stacks }
}

function allocationSummary(profile) {
  const pending = [{ node: profile.head, parents: [] }]
  const allocations = []
  let estimatedBytes = 0
  while (pending.length) {
    const { node, parents } = pending.pop()
    const stack = node.callFrame.functionName === '(root)' ? parents : [node.callFrame, ...parents].slice(0, 6)
    estimatedBytes += node.selfSize
    if (node.selfSize > 0 && stack.length) allocations.push({ bytes: node.selfSize, stack })
    for (const child of node.children) pending.push({ node: child, parents: stack })
  }
  allocations.sort((a, b) => b.bytes - a.bytes)
  return { estimatedBytes, samples: profile.samples.length,
    stacks: allocations.slice(0, 12).map(({ bytes, stack }) => ({ bytes, leafFirst: stack.map(frame => frameMetadata(frame)) })) }
}

async function readCpuProfile(send, sessionId, signal) {
  await send('Profiler.enable', {}, sessionId)
  await send('Profiler.setSamplingInterval', { interval: 4000 }, sessionId)
  await send('Profiler.start', {}, sessionId)
  await delay(PROFILE_MS, undefined, { signal })
  const { profile } = await send('Profiler.stop', {}, sessionId)
  return profileSummary(profile)
}

async function readAllocationProfile(send, signal, duration, includeCollected = false) {
  await send('HeapProfiler.enable', {}, undefined, 5000)
  await send('HeapProfiler.startSampling', {
    samplingInterval: ALLOCATION_INTERVAL_BYTES,
    stackDepth: 12,
    ...(includeCollected ? { includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true } : {})
  }, undefined, 5000)
  await delay(duration, undefined, { signal })
  const { profile } = await send('HeapProfiler.stopSampling', {}, undefined, 5000)
  return allocationSummary(profile)
}

async function captureRetainersProfiles(send, signal) {
  const [cpu, allocations] = await Promise.allSettled([
    (async () => {
      await delay(8000, undefined, { signal })
      return readCpuProfile(send, undefined, signal)
    })(),
    readAllocationProfile(send, signal, ALLOCATION_MS)
  ])
  return { cpu: cpu.status === 'fulfilled' ? cpu.value : null,
    allocations: allocations.status === 'fulfilled' ? allocations.value : null }
}

async function connectedDom(send, sessionId) {
  try {
    // Count node identities in the current document without reading their text or attributes.
    const response = await send('Runtime.evaluate', {
      expression: `(() => {
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
        let nodes = 0;
        while (nodes < ${CONNECTED_NODE_LIMIT} && walker.nextNode()) nodes++;
        return { nodes, visibility: document.visibilityState, timeOrigin: performance.timeOrigin };
      })()`,
      returnByValue: true, silent: true, timeout: 400
    }, sessionId)
    const nodes = response.result?.value?.nodes
    const visibility = response.result?.value?.visibility
    const timeOrigin = response.result?.value?.timeOrigin
    if (!Number.isInteger(nodes) || nodes < 0 || nodes > CONNECTED_NODE_LIMIT) return null
    return { nodes, capped: nodes === CONNECTED_NODE_LIMIT, timeOrigin: Number.isFinite(timeOrigin) ? timeOrigin : undefined,
      visibility: ['hidden', 'visible'].includes(visibility) ? visibility : undefined }
  } catch {
    return null
  }
}

function command(debuggerApi, method, params = {}, sessionId, timeoutMs = COMMAND_TIMEOUT_MS) {
  let timer
  return Promise.race([
    debuggerApi.sendCommand(method, params, sessionId),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

async function measure(send, sessionId) {
  const [heap, dom] = await Promise.allSettled([
    send('Runtime.getHeapUsage', {}, sessionId),
    send('Memory.getDOMCounters', {}, sessionId)
  ])
  return {
    heap: heap.status === 'fulfilled' ? {
      usedBytes: heap.value.usedSize, totalBytes: heap.value.totalSize,
      embedderBytes: heap.value.embedderHeapUsedSize, backingStorageBytes: heap.value.backingStorageSize
    } : null,
    dom: dom.status === 'fulfilled' ? {
      documents: dom.value.documents, nodes: dom.value.nodes, listeners: dom.value.jsEventListeners
    } : null
  }
}

function start({ throttleTarget } = {}) {
  if (started || app.isPackaged || process.env.WEB2TERM_RENDERER_DIAG !== '1') return
  const directory = join(app.getPath('temp'), 'gpt-login-diag')
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(directory, `renderer-memory-${stamp}-${process.pid}.log`)
  const attachments = new Set()
  const lastProfile = new Map()
  const allocatedProfiles = new Set()
  const allocationAttempts = new Map()
  let timer, endTimer
  let bytes = 0
  let profileCount = 0
  let tick = 0
  let capturing = false
  let stopped = false
  const throttle = process.env.WEB2TERM_RENDERER_DIAG_THROTTLE === '1' && typeof throttleTarget === 'function'
    ? require('./renderer-throttle-probe.cjs').createThrottleProbe({ write, command, getOwners: processOwners, throttleTarget })
    : null
  const timeline = !throttle && process.env.WEB2TERM_RENDERER_DIAG_TIMELINE === '1'
    ? require('./renderer-timeline-probe.cjs').createTimelineProbe({
      write, command, connectedDom, readCpuProfile, readAllocationProfile, frameMetadata
    })
    : null
  const retainers = !throttle && !timeline && process.env.WEB2TERM_RENDERER_DIAG_RETAINERS === '1'
    ? require('./renderer-retainers-probe.cjs').createRetainersProbe({
      write, command, connectedDom, measure, captureProfiles: captureRetainersProfiles, frameMetadata
    })
    : null

  function write(event, fields = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n'
    const lineBytes = Buffer.byteLength(line)
    if (bytes + lineBytes > MAX_LOG_BYTES) { stop('log-limit'); return }
    try {
      appendFileSync(logPath, line, 'utf8')
      bytes += lineBytes
    } catch {
      stop('write-failed')
    }
  }

  function stop(reason) {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    clearTimeout(endTimer)
    app.off('before-quit', onQuit)
    app.off('render-process-gone', onRendererGone)
    throttle?.stop()
    timeline?.stop()
    retainers?.stop()
    for (const detach of attachments) detach()
    if (reason !== 'write-failed') write('STOP', { reason, tick })
    console.info(`[renderer-diag] ${reason} → ${logPath}`)
  }

  function onQuit() { stop('app-quit') }
  function onRendererGone(_event, contents, details) {
    write('RENDERER-GONE', { viewId: contents.id, reason: details.reason, exitCode: details.exitCode })
  }

  async function capture(view, targets, sampleTick) {
    const { contents } = view
    const unavailable = (reason, pid) => {
      if (!stopped) write('TARGET-UNAVAILABLE', { tick: sampleTick, viewId: view.id, pid, reason })
    }
    if (contents.isDestroyed()) { unavailable('view-closed'); return }
    const debuggerApi = contents.debugger
    const sessions = new Map()
    let attached = false
    const onDetach = () => { attached = false }
    const onMessage = (_event, method, { targetInfo, sessionId }) => {
      if (method === 'Target.attachedToTarget' && targetInfo?.type === 'iframe') {
        sessions.set(sessionId, targetInfo.url)
      } else if (method === 'Target.detachedFromTarget') {
        sessions.delete(sessionId)
      }
    }
    const detach = () => {
      debuggerApi.off('message', onMessage)
      debuggerApi.off('detach', onDetach)
      attachments.delete(detach)
      try { if (attached && debuggerApi.isAttached()) debuggerApi.detach() } catch { /* View closed. */ }
      attached = false
    }
    const send = (method, params, sessionId, timeoutMs) => {
      if (!attached || stopped) return Promise.reject(new Error('detached'))
      return command(debuggerApi, method, params, sessionId, timeoutMs)
    }
    try {
      if (contents.isDevToolsOpened() || debuggerApi.isAttached()) { unavailable('debugger-in-use'); return }
      debuggerApi.attach('1.3')
      attached = true
      debuggerApi.on('detach', onDetach)
      attachments.add(detach)
      if (targets.some(({ owner }) => !owner.isMain)) {
        debuggerApi.on('message', onMessage)
        try {
          await send('Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
            filter: [{ type: 'iframe' }, { exclude: true }]
          })
        } catch { unavailable('iframe-discovery-unavailable') }
      }

      await Promise.all(targets.map(async ({ metric, owner }) => {
        const pid = metric.pid
        const child = owner.isMain ? null : [...sessions].find(([, url]) => framePid(contents, url) === pid)
        if (!owner.isMain && !child) { unavailable('iframe-target-unmatched', pid); return }
        const sameProcess = () => {
          if (!attached || contents.isDestroyed()) return false
          return child ? sessions.has(child[0]) && framePid(contents, child[1]) === pid
            : contents.getOSProcessId() === pid
        }
        if (!sameProcess()) { unavailable('process-changed', pid); return }
        const sessionId = child?.[0]
        const metadata = { tick: sampleTick, pid, ...ownerMetadata(owner) }
        const memory = await measure(send, sessionId)
        if (stopped) return
        if (!sameProcess()) { unavailable('process-changed', pid); return }
        write('TARGET-MEMORY', { ...metadata, ...memory })

        const key = `${pid}:${metric.creationTime}`
        const captureCpu = async () => {
          const now = Date.now()
          if (metric.cpu.percentCPUUsage < 5 || profileCount >= MAX_PROFILES ||
              now - (lastProfile.get(key) ?? 0) < PROFILE_GAP_MS) return
          lastProfile.set(key, now)
          profileCount += 1
          try {
            const profile = await readCpuProfile(send, sessionId)
            if (stopped) return
            if (!sameProcess()) { unavailable('process-changed', pid); return }
            write('CPU-PROFILE', { ...metadata, ...profile })
          } catch { unavailable('cpu-profile-unavailable', pid) }
        }
        const captureAllocations = async () => {
          const attempts = allocationAttempts.get(key) ?? 0
          if (view.page !== 'chatgpt' || !owner.isMain || (memory.dom?.nodes ?? 0) < 20_000 ||
              allocatedProfiles.has(key) || allocatedProfiles.size >= MAX_ALLOCATION_PROFILES || attempts >= 2) return
          allocatedProfiles.add(key)
          allocationAttempts.set(key, attempts + 1)
          let captured = false
          try {
            const before = await connectedDom(send, sessionId)
            await send('HeapProfiler.enable', {}, sessionId, 5000)
            await send('HeapProfiler.startSampling', { samplingInterval: ALLOCATION_INTERVAL_BYTES, stackDepth: 12 }, sessionId, 5000)
            write('ALLOCATION-START', { ...metadata, connected: before, memory })
            await delay(ALLOCATION_MS)
            const { profile } = await send('HeapProfiler.stopSampling', {}, sessionId, 5000)
            if (!sameProcess()) { unavailable('process-changed', pid); return }
            const [connected, after] = await Promise.all([connectedDom(send, sessionId), measure(send, sessionId)])
            if (stopped) return
            if (!sameProcess()) { unavailable('process-changed', pid); return }
            if (before?.timeOrigin && connected?.timeOrigin && before.timeOrigin !== connected.timeOrigin) {
              unavailable('document-changed-during-allocation-profile', pid)
              return
            }
            write('ALLOCATION-PROFILE', {
              ...metadata, connected, memory: after, ...allocationSummary(profile)
            })
            captured = true
          } catch { unavailable('allocation-profile-unavailable', pid) }
          finally { if (!captured) allocatedProfiles.delete(key) }
        }
        await Promise.all([captureCpu(), captureAllocations()])
      }))
    } catch {
      unavailable('target-disconnected')
    } finally {
      detach()
    }
  }

  function sample() {
    if (stopped) return
    tick += 1
    try {
      const metrics = app.getAppMetrics()
      const owners = processOwners()
      write('PROCESSES', { tick, processes: metrics.map(({ pid, creationTime, type, cpu, memory }) => ({
        pid, creationTime, type, cpuPercent: Math.round(cpu.percentCPUUsage * 100) / 100,
        workingSetKiB: memory.workingSetSize, privateKiB: memory.privateBytes,
        owners: owners.get(pid)?.map(ownerMetadata) ?? []
      })) })
      if (stopped || capturing) return
      if (throttle) { throttle.consider(metrics, owners, tick); return }
      if (timeline) { timeline.consider(metrics, owners, tick); return }
      if (retainers) { retainers.consider(metrics, owners, tick); return }
      const activeRenderers = metrics.filter(({ pid, memory, cpu }) => owners.has(pid)
        && (cpu.percentCPUUsage >= 5 || (memory.privateBytes ?? memory.workingSetSize) >= 512 * 1024))
      activeRenderers.sort((a, b) => b.cpu.percentCPUUsage - a.cpu.percentCPUUsage)
      const byView = new Map()
      for (const metric of activeRenderers.slice(0, 2)) {
        const candidates = owners.get(metric.pid)
        const owner = candidates.find(candidate => candidate.isMain) ?? candidates[0]
        if (!byView.has(owner.view)) byView.set(owner.view, [])
        byView.get(owner.view).push({ metric, owner })
      }
      if (!byView.size) return
      capturing = true
      const sampleTick = tick
      void Promise.allSettled([...byView].map(([view, targets]) => capture(view, targets, sampleTick)))
        .finally(() => { capturing = false })
    } catch {
      write('SAMPLE-UNAVAILABLE', { tick })
    }
  }

  started = true
  write('START', { pid: process.pid, electron: process.versions.electron, chrome: process.versions.chrome,
    mode: throttle ? 'throttle' : timeline ? 'timeline' : retainers ? 'retainers' : 'sampling',
    intervalMs: INTERVAL_MS, durationMs: DURATION_MS, profileMs: PROFILE_MS, allocationMs: ALLOCATION_MS })
  if (stopped) return
  console.info(`[renderer-diag] logging to ${logPath}`)
  app.once('before-quit', onQuit)
  app.on('render-process-gone', onRendererGone)
  throttle?.begin()
  const ready = timeline?.begin()
  sample()
  if (stopped) return
  timer = setInterval(sample, INTERVAL_MS)
  endTimer = setTimeout(() => stop('duration-reached'), DURATION_MS)
  return ready
}

module.exports = { start }
