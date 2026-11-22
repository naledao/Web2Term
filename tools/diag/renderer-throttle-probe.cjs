const { app, contentTracing } = require('electron')
const { mkdtemp, unlink, rmdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { analyze } = require('./renderer-timeline-probe.cjs')

const PHASE_MS = 10_000
const SAMPLE_MS = 2000
const SETTLE_MS = 1800
const DISCOVERY_MS = 180_000
const RETRY_MS = 15_000
const MAX_ATTEMPTS = 4
const CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing']

function rounded(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined
}

function summarizePhase(phase, trace) {
  const { name, samples } = phase
  const first = samples[0]
  const last = samples.at(-1)
  const seconds = (last.ms - first.ms) / 1000
  const cpu = samples.slice(1).map(sample => sample.cpuPercent).filter(Number.isFinite)
  return { name, seconds: rounded(seconds), visibility: [...new Set(samples.map(sample => sample.visibility))],
    meanCpuPercent: cpu.length ? rounded(cpu.reduce((sum, value) => sum + value, 0) / cpu.length) : undefined,
    cpuSeconds: rounded(last.cpuSeconds - first.cpuSeconds),
    privateMiBChange: rounded((last.privateKiB - first.privateKiB) / 1024),
    privateMiBPerSecond: rounded((last.privateKiB - first.privateKiB) / 1024 / seconds),
    domChange: Number.isFinite(first.nodes) && Number.isFinite(last.nodes) ? last.nodes - first.nodes : undefined,
    traceAligned: trace?.aligned ?? false,
    frameTasks: trace?.frameTasks, framesPerSecond: rounded(trace?.frameTasks * 1000 / trace?.traceMs),
    hotspotCalls: trace?.hotspotCalls, hotspotCallsPerSecond: rounded(trace?.hotspotCalls * 1000 / trace?.traceMs) }
}

function createThrottleProbe({ write, command, getOwners, throttleTarget }) {
  let busy = false
  let finished = false
  let stopped = false
  let discoveryEnded = false
  let attempts = 0
  let lastOutcome
  let timer
  let interrupt
  const attempted = new Map()
  const blocked = new Map()
  const writeLive = (event, fields) => { if (!stopped) write(event, fields) }

  function finishUnavailable(reason, fields = {}) {
    if (stopped || finished) return
    finished = true
    clearTimeout(timer)
    writeLive('THROTTLE-UNAVAILABLE', { attempts, lastOutcome, ...fields, reason })
    console.info(`[renderer-diag] background throttling comparison stopped (${reason})`)
  }

  function reportAttempt(result) {
    busy = false
    if (stopped) return
    lastOutcome = result.outcome
    if (result.outcome === 'captured') {
      finished = true
      clearTimeout(timer)
      writeLive('THROTTLE-DONE', result)
      console.info('[renderer-diag] background throttling comparison finished')
    } else if (result.restoreFailed) {
      finishUnavailable('restore-unavailable', result)
    } else if (attempts >= MAX_ATTEMPTS || discoveryEnded) {
      finishUnavailable(discoveryEnded ? 'discovery-timeout' : 'attempt-limit', result)
    } else {
      writeLive('THROTTLE-RETRY', result)
    }
  }

  async function capture(contents, target, metadata) {
    const control = new AbortController()
    const { signal } = control
    const debuggerApi = contents.debugger
    const phases = []
    let attached = false
    let recording = false
    let release
    let guardTimer
    let stage = 'attach'
    let outcome = 'protocol-unavailable'
    let directory
    let path
    let bufferUsage
    let trace
    let restoreFailed = false
    const restore = () => {
      if (!release) return
      const previous = release
      release = undefined
      try { previous() } catch { restoreFailed = true }
    }
    const cancel = reason => {
      restore()
      control.abort(reason)
    }
    interrupt = () => cancel('probe-stopped')
    const onNavigation = details => { if (details.isMainFrame) cancel('navigation') }
    const onDetach = () => { attached = false; cancel('debugger-detached') }
    const onDestroyed = () => cancel('view-closed')
    const checkTarget = () => {
      signal.throwIfAborted()
      const reason = contents.isDestroyed() ? 'view-closed' :
        contents.getOSProcessId() !== metadata.pid ? 'renderer-changed' : target.blockReason()
      if (reason) cancel(reason)
      signal.throwIfAborted()
    }
    const send = (method, params, timeout) => command(debuggerApi, method, params, undefined, timeout)

    async function pageState(marker) {
      const label = marker === undefined ? 'null' : JSON.stringify(`web2term-renderer-sample-${marker}`)
      const result = await send('Runtime.evaluate', { expression: `(() => {
        const state = window.__cmdTerminalInterceptor?.rendererThrottleProbeState?.()
        const label = ${label}
        if (state?.idle && label) {
          performance.mark(label)
          console.timeStamp?.(label)
          performance.clearMarks(label)
        }
        return state ?? null
      })()`, returnByValue: true, silent: true, timeout: 500 }, 1600).catch(() => null)
      const value = result?.result?.value
      return typeof value?.idle === 'boolean' && ['visible', 'hidden', 'prerender'].includes(value.visibility) ? value : null
    }

    async function checkPage(marker) {
      const state = await pageState(marker)
      checkTarget()
      if (!state) cancel('page-state-unavailable')
      else if (!state.idle) cancel('page-busy')
      signal.throwIfAborted()
      return state
    }

    async function runPhase(name, enabled) {
      stage = name
      const startMarker = phases.length * 2
      const samples = []
      const start = performance.now()
      for (let i = 0; i <= PHASE_MS / SAMPLE_MS; i += 1) {
        const pause = start + i * SAMPLE_MS - performance.now()
        if (pause > 0) await delay(pause, undefined, { signal })
        checkTarget()
        const owners = getOwners().get(metadata.pid)
        if (owners?.length !== 1 || owners[0].view.id !== contents.id || !owners[0].isMain) cancel('renderer-shared-or-changed')
        if (contents.getBackgroundThrottling() !== enabled) cancel('throttle-state-changed')
        signal.throwIfAborted()
        const marker = i === 0 ? startMarker : i === PHASE_MS / SAMPLE_MS ? startMarker + 1 : undefined
        const state = await checkPage(marker)
        const ms = performance.now()
        const metric = app.getAppMetrics().find(item => item.pid === metadata.pid && item.creationTime === metadata.creationTime)
        if (!metric) cancel('renderer-metric-unavailable')
        signal.throwIfAborted()
        const dom = await send('Memory.getDOMCounters', {}, 900).catch(() => null)
        checkTarget()
        samples.push({ ms, visibility: state.visibility, cpuPercent: rounded(metric.cpu.percentCPUUsage),
          cpuSeconds: metric.cpu.cumulativeCPUUsage, privateKiB: metric.memory.privateBytes,
          workingSetKiB: metric.memory.workingSetSize, nodes: dom?.nodes })
      }
      const phase = { name, startMarker, endMarker: startMarker + 1, samples }
      phases.push(phase)
      const origin = samples[0].ms
      writeLive('THROTTLE-PHASE', { ...metadata, name, enabled, samples: samples.map(({ ms, ...sample }) => ({
        ...sample, elapsedMs: rounded(ms - origin) })) })
    }

    try {
      contents.on('did-start-navigation', onNavigation)
      contents.on('destroyed', onDestroyed)
      debuggerApi.on('detach', onDetach)
      checkTarget()
      debuggerApi.attach('1.3')
      attached = true
      stage = 'preflight'
      if (contents.getBackgroundThrottling()) cancel('already-throttled')
      signal.throwIfAborted()
      await checkPage()
      stage = 'start-trace'
      directory = await mkdtemp(join(tmpdir(), 'web2term-throttle-trace-'))
      path = join(directory, 'trace.json')
      checkTarget()
      await contentTracing.startRecording({ record_mode: 'record-continuously', trace_buffer_size_in_kb: 48 * 1024,
        included_process_ids: [metadata.pid], included_categories: CATEGORIES, excluded_categories: ['*'] })
      recording = true
      checkTarget()
      writeLive('THROTTLE-TARGET', { ...metadata, nativeHidden: true, phaseMs: PHASE_MS, settleMs: SETTLE_MS })

      await runPhase('baseline', false)
      stage = 'apply-throttle'
      checkTarget()
      release = target.apply(reason => {
        if (reason === 'restore-unavailable') restoreFailed = true
        cancel(reason)
      })
      if (!release) cancel(target.blockReason() ?? 'throttling-unavailable')
      signal.throwIfAborted()
      guardTimer = setInterval(() => {
        try { checkTarget() } catch { if (!signal.aborted) cancel('eligibility-unavailable') }
      }, 250)
      stage = 'settle-throttled'
      await delay(SETTLE_MS, undefined, { signal })
      await runPhase('throttled', true)
      clearInterval(guardTimer)
      stage = 'restore-throttle'
      restore()
      if (restoreFailed) cancel('restore-unavailable')
      stage = 'settle-restored'
      await delay(SETTLE_MS, undefined, { signal })
      await runPhase('restored', false)
      stage = 'trace-analysis'
      outcome = 'captured'
    } catch {
      outcome = signal.aborted ? signal.reason : 'protocol-unavailable'
    } finally {
      clearInterval(guardTimer)
      restore()
      debuggerApi.off('detach', onDetach)
      contents.off('did-start-navigation', onNavigation)
      contents.off('destroyed', onDestroyed)
      try { if (attached && debuggerApi.isAttached()) debuggerApi.detach() } catch { /* View closed. */ }
      try {
        if (recording) {
          const buffer = await Promise.race([contentTracing.getTraceBufferUsage().catch(() => null), delay(500, null, { ref: false })])
          bufferUsage = buffer?.percentage
          await contentTracing.stopRecording(path)
          if (phases.length && !stopped) trace = await analyze({ kind: 'throttle', path, pid: metadata.pid,
            phases: phases.map(({ name, startMarker, endMarker }) => ({ name, startMarker, endMarker })) }, signal)
        }
      } catch {
        if (outcome === 'captured') outcome = 'trace-unavailable'
      } finally {
        if (path) await unlink(path).catch(() => {})
        if (directory) await rmdir(directory).catch(() => {})
      }
      interrupt = undefined
    }
    const summaries = phases.map(phase => summarizePhase(phase, trace?.phases.find(item => item.name === phase.name)))
    const baselineRate = summaries[0]?.framesPerSecond
    const throttledRate = summaries[1]?.framesPerSecond
    if (outcome === 'captured') {
      if (!trace) outcome = 'trace-unavailable'
      else if (trace.limited || summaries.some(phase => !phase.traceAligned)) outcome = 'trace-incomplete'
      else if (!baselineRate) outcome = 'no-baseline-frames'
    }
    return { ...metadata, stage, outcome, restoreFailed, bufferUsage, traceLimited: trace?.limited,
      matchedMarkers: trace?.matchedMarkers, hotspot: trace?.hotspot,
      frameRateRatio: baselineRate > 0 ? rounded(throttledRate / baselineRate) : undefined, phases: summaries }
  }

  return {
    begin() {
      timer = setTimeout(() => {
        discoveryEnded = true
        if (!busy) finishUnavailable(attempts ? 'discovery-timeout' : 'no-hot-hidden-idle-target')
      }, DISCOVERY_MS)
    },
    consider(metrics, owners, tick) {
      if (busy || finished || stopped || discoveryEnded) return
      const candidates = metrics.filter(metric => metric.cpu.percentCPUUsage >= 5)
        .sort((a, b) => b.cpu.percentCPUUsage - a.cpu.percentCPUUsage)
      for (const { pid, creationTime } of candidates) {
        const matches = owners.get(pid)
        if (matches?.length !== 1 || !matches[0].isMain || matches[0].view.page !== 'chatgpt') continue
        const { contents, id: viewId } = matches[0].view
        if (contents.isDestroyed()) continue
        const target = throttleTarget(contents)
        const reason = contents.isDevToolsOpened() ? 'devtools-open' : contents.debugger.isAttached() ? 'debugger-in-use' :
          target ? target.blockReason() : 'unmanaged-view'
        if (reason) {
          if (blocked.get(viewId) !== reason) writeLive('THROTTLE-BLOCKED', { pid, viewId, tick, reason })
          blocked.set(viewId, reason)
          continue
        }
        blocked.delete(viewId)
        const lastAttempt = attempted.get(viewId)
        const now = performance.now()
        if (lastAttempt !== undefined && now - lastAttempt < RETRY_MS) continue
        attempted.set(viewId, now)
        const metadata = { pid, creationTime, viewId, tick, attempt: ++attempts }
        busy = true
        void capture(contents, target, metadata).then(reportAttempt, () =>
          reportAttempt({ ...metadata, outcome: 'capture-unavailable' }))
        return
      }
    },
    stop() { stopped = true; clearTimeout(timer); interrupt?.() }
  }
}

module.exports = { createThrottleProbe }
