const { setTimeout: delay } = require('node:timers/promises')

const MAX_HITS = 3
const MAX_FRAMES = 8
const MAX_ASYNC_PARENTS = 4
const WAIT_MS = 2500
const ASYNC_LABELS = new Set(['postMessage', 'setTimeout', 'setInterval', 'requestAnimationFrame',
  'requestIdleCallback', 'Promise.then', 'Promise.catch', 'Promise.finally', 'await', 'queueMicrotask'])

async function readAsyncParents(initial, parentId, send, frameMetadata) {
  const parents = []
  let trace = initial
  let unresolved = parentId
  for (let index = 0; index < MAX_ASYNC_PARENTS && (trace || unresolved); index += 1) {
    if (!trace) {
      const result = await send('Debugger.getStackTrace', { stackTraceId: unresolved }, undefined, 500).catch(() => null)
      trace = result?.stackTrace
      if (!trace) break
    }
    parents.push({ name: ASYNC_LABELS.has(trace.description) ? trace.description : undefined,
      stack: (trace.callFrames ?? []).slice(0, MAX_FRAMES).map(frame => frameMetadata(frame)) })
    unresolved = trace.parentId
    trace = trace.parent
  }
  return { parents, moreOrUnavailable: Boolean(trace || unresolved) }
}

async function captureCallbackStacks({ debuggerApi, send, cleanupSend, target, frameMetadata, signal }) {
  const scriptUrls = new Map()
  const hits = []
  let breakpointId
  let resolved
  let arming = false
  let scriptEnd
  let interrupted = false
  let removeBreakpoint
  let resume = Promise.resolve()
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const stopBreaking = () => {
    if (breakpointId && !removeBreakpoint) {
      removeBreakpoint = cleanupSend('Debugger.removeBreakpoint', { breakpointId }, undefined, 700).catch(() => {})
    }
    return removeBreakpoint
  }

  function onMessage(_event, method, params, session) {
    if (session) return
    if (method === 'Debugger.scriptParsed') {
      if (params.scriptId === target.scriptId || scriptUrls.size < 4096) scriptUrls.set(params.scriptId, params.url)
      if (params.scriptId === target.scriptId) {
        scriptEnd = { lineNumber: params.endLine, columnNumber: params.endColumn }
      }
      return
    }
    if (method !== 'Debugger.paused') return

    const matched = breakpointId && params.hitBreakpoints?.includes(breakpointId)
    if (matched && hits.length < MAX_HITS && !signal.aborted) {
      const stack = (params.callFrames ?? []).slice(0, MAX_FRAMES).map(frame => frameMetadata({
        ...frame.location, functionName: frame.functionName, url: frame.url || scriptUrls.get(frame.location?.scriptId)
      }))
      hits.push({ stack, asyncStackTrace: params.asyncStackTrace, asyncStackTraceId: params.asyncStackTraceId })
    }
    if (!matched && !arming) interrupted = true
    const complete = hits.length >= MAX_HITS || signal.aborted || interrupted
    if (complete) void stopBreaking()
    resume = cleanupSend('Debugger.resume', {}, undefined, 700)
      .catch(() => cleanupSend('Debugger.resume', {}, undefined, 700).catch(() => {}))
    if (complete) void resume.then(finish)
  }

  debuggerApi.on('message', onMessage)
  try {
    await send('Debugger.enable', {}, undefined, 2500)
    const loaded = frameMetadata({ scriptId: target.scriptId, url: scriptUrls.get(target.scriptId) })
    if (loaded.source !== 'chatgpt' || loaded.asset !== target.asset) return { status: 'script-unavailable', target }
    if (interrupted) return { status: 'interrupted', target }
    await send('Debugger.setAsyncCallStackDepth', { maxDepth: 8 }, undefined, 1000)
    const { scriptId, line, column } = target
    const end = scriptEnd?.lineNumber <= line + 1 ? scriptEnd : { lineNumber: line + 1, columnNumber: 0 }
    const { locations } = await send('Debugger.getPossibleBreakpoints', {
      start: { scriptId, lineNumber: line - 1, columnNumber: column - 1 },
      end: { scriptId, ...end },
      restrictToFunction: true
    }, undefined, 1500)
    const candidate = locations?.find(location => location.scriptId === scriptId)
    if (!candidate) return { status: 'breakpoint-location-unavailable', target }
    await send('Debugger.setSkipAllPauses', { skip: false }, undefined, 1000)
    if (interrupted) return { status: 'interrupted', target }
    const location = { scriptId, lineNumber: candidate.lineNumber, columnNumber: candidate.columnNumber }
    arming = true
    const result = await send('Debugger.setBreakpoint', { location }, undefined, 1500)
    breakpointId = result.breakpointId
    const actual = result.actualLocation
    arming = false
    resolved = frameMetadata({ ...actual, url: scriptUrls.get(actual?.scriptId) })
    if (!breakpointId) return { status: 'breakpoint-unavailable', target }
    await Promise.race([done, delay(WAIT_MS, undefined, { signal, ref: false })])
    await stopBreaking()
    await resume
    const samples = await Promise.all(hits.map(async ({ stack, asyncStackTrace, asyncStackTraceId }) => ({
      stack, ...await readAsyncParents(asyncStackTrace, asyncStackTraceId, send, frameMetadata)
    })))
    return { status: samples.length ? 'captured' : interrupted ? 'interrupted' : 'no-hit', target, resolved, samples }
  } catch {
    return { status: signal.aborted ? 'target-ended' : 'protocol-unavailable', target, resolved }
  } finally {
    await stopBreaking()
    await resume
    await cleanupSend('Debugger.disable', {}, undefined, 700).catch(() => {})
    debuggerApi.off('message', onMessage)
  }
}

module.exports = { captureCallbackStacks }
