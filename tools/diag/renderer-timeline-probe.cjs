const { contentTracing } = require('electron')
const { mkdtemp, unlink, rmdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { Worker } = require('node:worker_threads')
const { captureCallbackStacks } = require('./renderer-callback-stacks.cjs')

const WINDOW_MS = 10_000
const POLL_MS = 1000
const DISCOVERY_MS = 90_000
const TRACE_BUFFER_KIB = 48 * 1024
const MARK_PREFIX = 'web2term-renderer-sample-'
const MAX_SOURCE_CHARS = 5_000_000
const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-v8.inspector', 'v8', 'v8.execute',
  'blink.user_timing', 'blink', 'toplevel', 'toplevel.flow']

async function analyze(data, signal) {
  if (signal.aborted) return null
  const worker = new Worker(join(__dirname, 'renderer-timeline-worker.cjs'), {
    workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512 }
  })
  let timer
  let abort
  try {
    return await new Promise(resolve => {
      abort = () => resolve(null)
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(abort, 35_000)
      worker.once('message', ({ result }) => resolve(result ?? null))
      worker.once('error', abort)
      worker.once('exit', abort)
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await worker.terminate().catch(() => {})
  }
}

function locationsFrom(timeline, cpu, allocations) {
  const locations = new Map()
  const traceStacks = items => items.flatMap(item => [item.stack, item.initiator?.stack ?? []])
  const hotFunctions = timeline?.execution.hotFunctions ?? []
  const stacks = [
    ...hotFunctions.flatMap(item => [item.stack, ...item.upstreams.map(upstream => upstream.stack),
      ...item.nativeTasks.flatMap(task => task.post?.stack ?? [])]),
    ...traceStacks(timeline?.callbacks ?? []),
    ...[cpu, allocations].flatMap(profile => (profile?.stacks ?? []).map(stack => stack.leafFirst)),
    ...traceStacks(timeline?.activity ?? [])
  ]
  for (const frame of stacks.flat()) {
    if (frame.source !== 'chatgpt' || !frame.line || !frame.column) continue
    if (!frame.scriptId && !frame.asset) continue
    const key = frame.scriptId ? `id:${frame.scriptId}` : `asset:${frame.asset}`
    if (!locations.has(key)) locations.set(key, [])
    const entries = locations.get(key)
    if (entries.length >= 8 || entries.some(entry => entry.line === frame.line && entry.column === frame.column)) continue
    entries.push({ line: frame.line, column: frame.column, name: frame.name })
  }
  return locations
}

async function findScripts(debuggerApi, send, locations, frameMetadata, signal) {
  if (!locations.size) return []
  const scripts = new Map()
  const priorities = new Map([...locations.keys()].map((key, index) => [key, index]))
  const listener = (_event, method, params, subSession) => {
    if (method !== 'Debugger.scriptParsed' || subSession) return
    const { scriptId, source, asset } = frameMetadata(params)
    const keys = [`id:${scriptId}`, `asset:${asset}`].filter(key => locations.has(key))
    if (!keys.length || source !== 'chatgpt' || !scriptId || scripts.has(scriptId)) return
    const positions = [...new Map(keys.flatMap(key => locations.get(key))
      .map(position => [`${position.line}:${position.column}`, position])).values()].slice(0, 8)
    const priority = Math.min(...keys.map(key => priorities.get(key)))
    scripts.set(scriptId, { scriptId, source, asset, positions, priority,
      sha256: /^[a-f0-9]{64}$/i.test(params.hash) ? params.hash : undefined,
      hasSourceMap: Boolean(params.sourceMapURL) })
  }
  debuggerApi.on('message', listener)
  try {
    await send('Debugger.enable', {}, undefined, 5000)
    await send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {})
    const result = []
    let inspected = 0
    const ordered = [...scripts.values()].sort((a, b) => a.priority - b.priority)
    for (const { positions, priority: _, ...script } of ordered) {
      if (signal.aborted || result.length >= 24) break
      if (!script.asset || inspected >= 5) { result.push({ ...script, positions }); continue }
      inspected += 1
      try {
        const { scriptSource } = await send('Debugger.getScriptSource', { scriptId: script.scriptId }, undefined, 5000)
        if (typeof scriptSource !== 'string' || scriptSource.length > MAX_SOURCE_CHARS) {
          result.push({ ...script, positions, status: 'source-size-or-format' })
          continue
        }
        const functions = await analyze({ kind: 'source', asset: script.asset, source: scriptSource, locations: positions }, signal)
        result.push({ ...script, positions, functions, status: functions ? 'inspected' : 'source-analysis-unavailable' })
      } catch { result.push({ ...script, positions, status: 'source-unavailable' }) }
    }
    return result
  } finally {
    debuggerApi.off('message', listener)
    await send('Debugger.disable').catch(() => {})
  }
}

function createTimelineProbe({ write, command, connectedDom, readCpuProfile, readAllocationProfile, frameMetadata }) {
  const lifetime = new AbortController()
  let recording
  let closing
  let discoveryTimer
  let selected = false
  let finished = false
  let cancelTarget
  const writeLive = (event, fields) => {
    if (!lifetime.signal.aborted) write(event, fields)
  }

  function startTrace(metadata) {
    // Electron forwards this dictionary to Chromium, which reads `record_mode`.
    recording = contentTracing.startRecording({
      record_mode: 'record-continuously', trace_buffer_size_in_kb: TRACE_BUFFER_KIB,
      included_process_ids: [metadata.pid], included_categories: TRACE_CATEGORIES, excluded_categories: ['*']
    }).then(() => {
      writeLive('PERF-TRACE-START', { ...metadata, scope: 'target-process', recordMode: 'record-continuously',
        bufferKiB: TRACE_BUFFER_KIB, categories: TRACE_CATEGORIES })
      return true
    }, () => {
      writeLive('PERF-UNAVAILABLE', { ...metadata, phase: 'trace-start', reason: 'trace-start-unavailable' })
      return false
    })
    return recording
  }

  function finishTrace(metadata, samples = []) {
    if (closing) return closing
    closing = (async () => {
      if (!await recording) return null
      let directory
      let path
      try {
        directory = await mkdtemp(join(tmpdir(), 'web2term-renderer-trace-'))
        path = join(directory, 'trace.json')
        const buffer = metadata && await Promise.race([
          contentTracing.getTraceBufferUsage().catch(() => null), delay(500, null, { ref: false })
        ])
        await contentTracing.stopRecording(path)
        if (!metadata || lifetime.signal.aborted) return null
        const timeline = await analyze({ kind: 'trace', path, pid: metadata.pid, samples }, lifetime.signal)
        if (!timeline) writeLive('PERF-UNAVAILABLE', { ...metadata, phase: 'timeline', reason: 'trace-analysis-unavailable' })
        return timeline && { ...timeline, bufferUsage: Number.isFinite(buffer?.percentage) ? buffer.percentage : undefined }
      } catch {
        writeLive('PERF-UNAVAILABLE', { ...metadata, phase: 'timeline', reason: 'trace-read-unavailable' })
        return null
      } finally {
        if (path) await unlink(path).catch(() => {})
        if (directory) await rmdir(directory).catch(() => {})
      }
    })()
    return closing
  }

  async function capture(contents, metadata) {
    const control = new AbortController()
    const { signal } = control
    const debuggerApi = contents.debugger
    let attached = false
    const onDetach = () => { attached = false; control.abort() }
    const onNavigation = details => { if (details.isMainFrame && !details.isSameDocument) control.abort() }
    const detach = () => {
      control.abort()
      contents.off('did-start-navigation', onNavigation)
      debuggerApi.off('detach', onDetach)
      try { if (attached && debuggerApi.isAttached()) debuggerApi.detach() } catch { /* View closed. */ }
      attached = false
    }
    const cleanupSend = async (method, params, session, timeout) => {
      if (!attached) throw new Error('target-ended')
      return command(debuggerApi, method, params, session, timeout)
    }
    const send = (method, params, session, timeout) => signal.aborted
      ? Promise.reject(new Error('target-ended'))
      : cleanupSend(method, params, session, timeout)
    const validTarget = () => attached && !signal.aborted && !contents.isDestroyed() && contents.getOSProcessId() === metadata.pid
    cancelTarget = detach
    let phase = 'attach'

    async function readNodes() {
      try {
        const result = await send('Memory.getDOMCounters')
        return Number.isSafeInteger(result.nodes) && result.nodes >= 0 ? result.nodes : null
      } catch { return null }
    }

    try {
      debuggerApi.attach('1.3')
      attached = true
      debuggerApi.on('detach', onDetach)
      contents.on('did-start-navigation', onNavigation)
      const connected = await connectedDom(send)
      if (!validTarget()) throw new Error('target-changed')
      phase = 'observe-growth'
      const baseline = await readNodes()
      let observed = baseline
      for (let i = 0; i < 4; i += 1) {
        await delay(POLL_MS, undefined, { signal })
        observed = await readNodes()
        if (observed !== null && ((baseline !== null && observed - baseline >= 500) || observed >= 20_000)) break
      }
      const growing = baseline !== null && observed !== null && observed - baseline >= 500
      const hasMetricsClock = await send('Performance.enable', { timeDomain: 'timeTicks' }).then(() => true, () => false)
      writeLive('PERF-TARGET', { ...metadata, growthDetectedBeforeWindow: growing, baseline, observed,
        visibility: connected?.visibility, windowMs: WINDOW_MS, hasMetricsClock })
      if (!validTarget()) throw new Error('target-changed')
      phase = 'trace-start'
      await Promise.race([startTrace(metadata), delay(2000, undefined, { signal, ref: false })])
      if (!validTarget()) throw new Error('target-changed')

      phase = 'profiles'
      const samples = []
      const takeSamples = async () => {
        const started = Date.now()
        for (let index = 0; index <= WINDOW_MS / POLL_MS; index += 1) {
          if (!validTarget() || Date.now() - started > WINDOW_MS + 1500) return
          const metrics = hasMetricsClock ? await send('Performance.getMetrics').then(result => result.metrics, () => []) : []
          const timestamp = metrics?.find(metric => metric.name === 'Timestamp')?.value
          const nodesMetric = metrics?.find(metric => metric.name === 'Nodes')?.value
          const validNodesMetric = Number.isSafeInteger(nodesMetric) && nodesMetric >= 0
          const nodes = validNodesMetric ? nodesMetric : await readNodes()
          const mark = MARK_PREFIX + index
          const label = JSON.stringify(mark)
          const marker = await send('Runtime.evaluate', {
            expression: `(() => {
              const entry = performance.mark(${label})
              console.timeStamp?.(${label})
              performance.clearMarks(${label})
              return entry.startTime
            })()`,
            returnByValue: true, silent: true, timeout: 500
          }).catch(() => null)
          const markerClockMs = marker?.result?.value
          samples.push({ index, nodes,
            ticksUs: Number.isFinite(timestamp) && validNodesMetric ? Math.round(timestamp * 1_000_000) : undefined,
            markerClockMs: Number.isFinite(markerClockMs) ? markerClockMs : undefined })
          const pause = started + (index + 1) * POLL_MS - Date.now()
          if (index < WINDOW_MS / POLL_MS && pause > 0) await delay(pause, undefined, { signal })
        }
      }

      // Flush the trace as soon as the last DOM sample is taken. The final
      // profiler commands may still be waiting for the renderer to respond.
      const [cpuResult, allocationResult, timelineResult] = await Promise.allSettled([
        (async () => { await delay(2000, undefined, { signal }); return readCpuProfile(send, undefined, signal) })(),
        readAllocationProfile(send, signal, WINDOW_MS, true),
        takeSamples().then(() => validTarget() ? finishTrace(metadata, samples) : finishTrace(), () => finishTrace())
      ])
      if (!validTarget()) throw new Error('target-changed')
      const cpu = cpuResult.status === 'fulfilled' ? cpuResult.value : null
      const allocations = allocationResult.status === 'fulfilled' ? allocationResult.value : null
      writeLive('PERF-PROFILES', { ...metadata, samples, cpu, allocations, allocationsIncludeCollected: Boolean(allocations) })

      phase = 'timeline'
      const timeline = timelineResult.status === 'fulfilled' ? timelineResult.value : null
      const traceCaptured = (timeline?.targetEvents ?? 0) > 0
      const timelineAligned = traceCaptured && timeline.traceCoverageMs > 0 && timeline.countersSource !== 'unavailable'
      const profileWindowAligned = timelineAligned && timeline.countersSource !== 'trace-counters'
      if (timeline) {
        const { execution, ...summary } = timeline
        writeLive('PERF-TIMELINE', { ...metadata, ...summary })
        writeLive('PERF-ASYNC', { ...metadata, ...execution })
      }
      if (timeline?.targetEvents === 0) writeLive('PERF-UNAVAILABLE', { ...metadata, phase, reason: 'trace-no-target-events' })
      if (traceCaptured && !timelineAligned) writeLive('PERF-UNAVAILABLE', { ...metadata, phase, reason: 'trace-clock-unavailable' })

      phase = 'script-source'
      if (!validTarget()) throw new Error('target-changed')
      const scripts = await findScripts(debuggerApi, send, locationsFrom(timeline, cpu, allocations), frameMetadata, signal)
      writeLive('PERF-SCRIPTS', { ...metadata, scripts })

      phase = 'callback-stacks'
      if (!validTarget()) throw new Error('target-changed')
      const hotspot = timelineAligned ? timeline.execution.hotFunctions.find(group => group.stack[0]?.source === 'chatgpt') : undefined
      const target = hotspot?.stack[0]
      let stackCapture
      if (!hotspot || hotspot.duringGrowth < 2) stackCapture = { status: 'no-repeated-growth-callback' }
      else if (hotspot.duringGrowth - hotspot.duringGrowthWithOriginStack < 2) stackCapture = { status: 'upstream-in-trace', target }
      else if (!target?.asset || !target.scriptId || !target.line || !target.column) stackCapture = { status: 'no-source-location', target }
      else stackCapture = await captureCallbackStacks({ debuggerApi, send, cleanupSend, target, frameMetadata, signal })
      writeLive('PERF-CALLBACK-STACKS', { ...metadata, ...stackCapture })
      writeLive('PERF-DONE', { ...metadata, timeline: timelineAligned, traceCaptured, profileWindowAligned,
        matchedAsyncRuns: timeline?.execution.matchedRuns, matchedNativeTasks: timeline?.execution.native.matchedTasks,
        callbackStacks: stackCapture.status,
        cpu: Boolean(cpu), allocations: Boolean(allocations) })
      if (!lifetime.signal.aborted) console.info('[renderer-diag] performance capture recorded')
    } catch {
      writeLive('PERF-UNAVAILABLE', { ...metadata, phase, reason: signal.aborted ? 'target-ended' : 'protocol-unavailable' })
      if (!lifetime.signal.aborted) console.info(`[renderer-diag] performance capture stopped (${phase})`)
    } finally {
      detach()
      cancelTarget = undefined
      finished = true
      await finishTrace()
    }
  }

  return {
    begin() {
      discoveryTimer = setTimeout(() => {
        if (selected || finished) return
        finished = true
        writeLive('PERF-UNAVAILABLE', { phase: 'selection', reason: 'no-hot-chatgpt-renderer' })
        console.info('[renderer-diag] performance capture stopped (no hot ChatGPT renderer)')
      }, DISCOVERY_MS)
    },
    consider(metrics, owners, tick) {
      if (selected || finished || lifetime.signal.aborted) return
      const candidates = metrics.filter(({ memory, cpu }) =>
        cpu.percentCPUUsage >= 5 && (memory.privateBytes ?? memory.workingSetSize) >= 256 * 1024)
        .sort((a, b) => b.cpu.percentCPUUsage - a.cpu.percentCPUUsage)
      for (const { pid, creationTime } of candidates) {
        const matches = (owners.get(pid) ?? []).filter(owner => owner.isMain)
        if (matches.length !== 1 || matches[0].view.page !== 'chatgpt') continue
        const { id: viewId, contents } = matches[0].view
        if (contents.isDestroyed() || contents.isDevToolsOpened() || contents.debugger.isAttached()) continue
        selected = true
        clearTimeout(discoveryTimer)
        void capture(contents, { tick, pid, creationTime, viewId }).catch(() => {
          writeLive('PERF-UNAVAILABLE', { tick, pid, viewId, phase: 'target', reason: 'target-disconnected' })
          void finishTrace()
        })
        return
      }
    },
    stop() { lifetime.abort(); clearTimeout(discoveryTimer); cancelTarget?.(); void finishTrace() }
  }
}

module.exports = { createTimelineProbe, analyze }
