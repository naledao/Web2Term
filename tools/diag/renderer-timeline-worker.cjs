const { createReadStream } = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')
const { frameMetadata } = require('./renderer-probe-frames.cjs')

const MARK_PREFIX = 'web2term-renderer-sample-'
const MAX_EVENTS = 100_000
const MAX_ASYNC_EVENTS = 100_000
const MAX_EVENT_CHARS = 256 * 1024
const FALLBACK_WINDOW_US = 10_000_000
const ASYNC_CATEGORY = 'disabled-by-default-v8.inspector'
const ASYNC_SCHEDULED = 'v8::Debugger::AsyncTaskScheduled'
const ASYNC_RUN = 'v8::Debugger::AsyncTaskRun'
const ASYNC_CANCELED = 'v8::Debugger::AsyncTaskCanceled'
const ASYNC_EVENTS = new Set([ASYNC_SCHEDULED, ASYNC_RUN, ASYNC_CANCELED])
const FLOW_PHASES = new Set(['s', 't', 'f'])
const NATIVE_FLOW_CATEGORY = 'toplevel.flow'
const NATIVE_RUNS = new Set(['ThreadControllerImpl::RunTask', 'ThreadPool_RunTask'])
const NATIVE_POSTS = new Set(['SequenceManager PostTask', 'ThreadPool_PostTask'])
const MESSAGE_PORT_ACCEPT = 'MessagePort::Accept'
const TASK_NAMES = new Set(['Promise.then', 'Promise.catch', 'Promise.finally', 'await', 'queueMicrotask',
  'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'postMessage', 'postTask',
  'scheduler.postTask', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'MessagePort.postMessage'])
const INITIATORS = {
  TimerInstall: 'TimerFire',
  RequestAnimationFrame: 'FireAnimationFrame',
  RequestIdleCallback: 'FireIdleCallback',
  SchedulePostTaskCallback: 'RunPostTaskCallback',
  SchedulePostMessage: 'HandlePostMessage'
}
const CALLBACKS = new Set(Object.values(INITIATORS))
const ACTIVITY = new Set(['FunctionCall', 'EventDispatch', 'RunMicrotasks', 'ParseHTML', 'InvalidateLayout',
  'UpdateLayoutTree', 'Layout', 'RunTask', ...CALLBACKS])
const EXECUTION_CONTEXTS = new Set(['FunctionCall', 'EventDispatch', 'RunMicrotasks', 'RunTask', 'EvaluateScript',
  'v8.evaluateModule', ASYNC_RUN, MESSAGE_PORT_ACCEPT, ...NATIVE_RUNS, ...CALLBACKS])
const JS_ENTRY_POINTS = new Set(['FunctionCall', 'EventDispatch', 'RunMicrotasks', 'EvaluateScript', 'v8.evaluateModule'])
const GC = new Set(['MinorGC', 'MajorGC', 'GCEvent', 'V8.GC_MINOR', 'V8.GC_MAJOR', 'V8.GCScavenger', 'V8.GCCompactor'])
const EVENT_TYPES = new Set(['message', 'scroll', 'resize', 'visibilitychange', 'selectionchange', 'storage', 'pointermove'])

async function* traceEvents(path) {
  let opening = ''
  let inEvents = false
  let object = ''
  let oversized = false
  let depth = 0
  let inString = false
  let escaped = false
  for await (let chunk of createReadStream(path, { encoding: 'utf8' })) {
    if (!inEvents) {
      opening += chunk
      const match = /^\s*\[|"traceEvents"\s*:\s*\[/.exec(opening)
      if (!match) {
        if (opening.length > 64 * 1024) throw new Error('trace-header-not-found')
        continue
      }
      chunk = opening.slice(match.index + match[0].length)
      opening = ''
      inEvents = true
    }
    let start = depth ? 0 : -1
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
      } else if (char === '{') {
        if (!depth) start = index
        depth += 1
      } else if (char === '}' && depth) {
        depth -= 1
        if (depth) continue
        if (!oversized && object.length + index + 1 - start <= MAX_EVENT_CHARS) {
          yield JSON.parse(object + chunk.slice(start, index + 1))
        }
        object = ''
        oversized = false
        start = -1
      } else if (char === '"' && depth) inString = true
      else if (char === ']' && !depth) return
    }
    if (depth && !oversized) {
      if (object.length + chunk.length - start <= MAX_EVENT_CHARS) object += chunk.slice(start)
      else { oversized = true; object = '' }
    }
  }
  throw new Error('trace-incomplete')
}

function traceStack(data) {
  const stack = data.stackTrace?.callFrames ?? data.stackTrace
  if (Array.isArray(stack) && stack.length) return stack.slice(0, 6).map(frame => frameMetadata(frame, false))
  const url = data.url ?? data.scriptName
  return data.scriptId || url ? [frameMetadata({ ...data, url, lineNumber: data.lineNumber ?? data.line,
    columnNumber: data.columnNumber ?? data.column }, false)] : []
}

function markerIndex(event) {
  const label = event.name === 'TimeStamp' ? event.args?.data?.message : event.name
  if (typeof label !== 'string' || !label.startsWith(MARK_PREFIX)) return null
  const suffix = label.slice(MARK_PREFIX.length)
  if (!/^\d{1,3}$/.test(suffix) || Number(suffix) >= 128) return null
  return Number(suffix)
}

function traceId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value)
  return typeof value === 'string' && /^(?:\d{1,20}|0x[0-9a-f]{1,16})$/i.test(value) ? value : null
}

function nativeSource(args) {
  const origin = args?.task?.posted_from
  const path = args?.src_file ?? args?.src ?? origin?.file_name
  const file = typeof path === 'string' ? /(?:^|[\\/])([a-zA-Z0-9_.-]{1,100}\.(?:cc|cpp|mm|h))$/.exec(path)?.[1] : undefined
  if (!file) return undefined
  const symbol = args?.src_func ?? origin?.function_name
  const line = args?.src_line ?? origin?.line_number
  return { file, function: typeof symbol === 'string' && /^[a-zA-Z_~][\w:~]{0,159}$/.test(symbol) ? symbol : undefined,
    line: Number.isSafeInteger(line) && line > 0 ? line : undefined }
}

function timelineData(event, marker) {
  const { name, ts, dur, tid, ph } = event
  const data = event.args?.data ?? event.args?.beginData ?? event.args ?? {}
  const callback = Object.hasOwn(INITIATORS, name) ? INITIATORS[name] : CALLBACKS.has(name) ? name : null
  const id = (callback === 'TimerFire' ? data.timerId : data.id ?? data.taskId)
  const frame = typeof data.frame === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(data.frame) ? data.frame : ''
  const messageId = callback === 'HandlePostMessage' ? traceId(data.traceId) : null
  const key = callback && Number.isSafeInteger(id) ? `${tid}:${frame}:${callback}:${id}` : null
  const taskName = event.args?.taskName ?? data.taskName
  return {
    name, ts, tid, ph, duration: Number.isFinite(dur) && dur >= 0 ? dur : 0,
    marker,
    key: messageId !== null ? `postMessage:${messageId}` : key,
    nodes: name === 'UpdateCounters' && Number.isSafeInteger(data.nodes) ? data.nodes : undefined,
    eventType: name === 'EventDispatch' && EVENT_TYPES.has(data.type) ? data.type : undefined,
    taskName: name === ASYNC_SCHEDULED && TASK_NAMES.has(taskName) ? taskName : undefined,
    postedFrom: NATIVE_RUNS.has(name) ? nativeSource(event.args) : undefined,
    stack: traceStack(data)
  }
}

function completeEvents(events) {
  const pending = []
  const result = []
  for (const event of events) {
    if (event.ph === 'B') pending.push(event)
    else if (event.ph === 'E') {
      const match = pending.findLastIndex(start => start.name === event.name)
      if (match >= 0) {
        const [start] = pending.splice(match, 1)
        result.push({ ...start, duration: event.ts - start.ts })
      }
    } else result.push(event)
  }
  return result.concat(pending).sort((a, b) => a.ts - b.ts)
}

function firstFunctionIn(event, functions) {
  if (event.duration <= 0) return null
  let before = 0
  let after = functions.length
  while (before < after) {
    const mid = (before + after) >>> 1
    if (functions[mid].ts < event.ts) before = mid + 1
    else after = mid
  }
  const next = functions[before]
  return next && next.ts < event.ts + event.duration ? next : null
}

function alignSamples(samples, marked, traceFrom, traceTo) {
  const valid = samples.filter(sample => Number.isSafeInteger(sample.nodes) && sample.nodes >= 0)
  const ticks = valid.filter(sample => Number.isFinite(sample.ticksUs))
    .map(sample => ({ ts: sample.ticksUs, nodes: sample.nodes, index: sample.index }))
    .sort((a, b) => a.ts - b.ts)
  const comparable = ticks.length >= 2 && ticks[0].ts <= traceTo && ticks.at(-1).ts >= traceFrom
  const matchingTicks = ticks.filter(point => marked.has(point.index))
  if (comparable && (!matchingTicks.length ||
      matchingTicks.some(point => Math.abs(marked.get(point.index) - point.ts) < 250_000))) {
    return { points: ticks, source: 'performance-ticks' }
  }

  const offsets = valid.filter(sample => marked.has(sample.index) && Number.isFinite(sample.markerClockMs))
    .map(sample => marked.get(sample.index) - sample.markerClockMs * 1000).sort((a, b) => a - b)
  if (offsets.length) {
    // One trace marker fixes the origin of the monotonic clock for the whole
    // document. Prefer direct markers where available.
    const offset = offsets[Math.floor(offsets.length / 2)]
    const points = valid.flatMap(sample => {
      const ts = marked.get(sample.index) ?? (Number.isFinite(sample.markerClockMs) ? offset + sample.markerClockMs * 1000 : null)
      return ts === null ? [] : [{ ts, nodes: sample.nodes }]
    }).sort((a, b) => a.ts - b.ts)
    if (points.length >= 2) return { points, source: 'renderer-clock-aligned' }
  }

  const points = valid.filter(sample => marked.has(sample.index))
    .map(sample => ({ ts: marked.get(sample.index), nodes: sample.nodes })).sort((a, b) => a.ts - b.ts)
  return points.length >= 2 ? { points, source: 'inspector-markers' } : null
}

function flowEdges(events, flows) {
  const bindings = new Map()
  for (const event of events) {
    const key = `${event.tid}:${event.ts}`
    // JSON timestamps are rounded to microseconds. Skip ambiguous endpoints.
    bindings.set(key, bindings.has(key) ? null : event)
  }

  const starts = new Map()
  const edges = []
  for (const { key, phase, tid, ts } of flows.sort((a, b) => a.ts - b.ts)) {
    const endpoint = bindings.get(`${tid}:${ts}`)
    if (phase === 's') {
      starts.set(key, endpoint)
      continue
    }
    const from = starts.get(key)
    if (phase === 'f') starts.delete(key)
    if (from && endpoint && from !== endpoint) edges.push([from, endpoint])
  }
  return edges
}

function matchAsyncRuns(events, flows) {
  const schedules = new Map()
  for (const [from, endpoint] of flowEdges(events, flows)) {
    // Perfetto can emit schedule → first run → later run as separate edges.
    const scheduled = from.name === ASYNC_SCHEDULED ? from : schedules.get(from)
    if (scheduled && endpoint.name === ASYNC_RUN) schedules.set(endpoint, scheduled)
  }
  return schedules
}

function matchNativePosts(events, flows) {
  // Perfetto uses the source category on both exported flow markers. The
  // destination slice can be in `toplevel` while the post is in `toplevel.flow`.
  const posts = new Map()
  for (const [from, run] of flowEdges(events, flows)) {
    if (NATIVE_POSTS.has(from.name) && NATIVE_RUNS.has(run.name)) posts.set(run, from)
  }
  return posts
}

function matchRegistrations(events) {
  const registrations = new Map()
  const callbacks = new Map()
  for (const event of events) {
    if (!event.key) continue
    if (Object.hasOwn(INITIATORS, event.name)) registrations.set(event.key, event)
    else if (registrations.has(event.key)) callbacks.set(event, registrations.get(event.key))
  }
  return callbacks
}

function executionParents(threads) {
  const parents = new Map()
  const order = name => NATIVE_RUNS.has(name) ? 0 : name === 'RunTask' ? 1 : name === 'FunctionCall' ? 3 : 2
  for (const events of threads.values()) {
    const active = []
    const ordered = [...events].sort((a, b) => a.ts - b.ts || b.duration - a.duration ||
      order(a.name) - order(b.name))
    for (const event of ordered) {
      const end = event.ts + event.duration
      while (active.length) {
        const outer = active.at(-1)
        if (outer.ts + outer.duration > event.ts && outer.ts + outer.duration >= end) break
        active.pop()
      }
      if (active.length) parents.set(event, active.at(-1))
      if (event.duration > 0 && EXECUTION_CONTEXTS.has(event.name)) active.push(event)
    }
  }
  return parents
}

function enclosingCall(event, parents) {
  let caller = parents.get(event)
  while (caller && (!JS_ENTRY_POINTS.has(caller.name) || !caller.stack.length)) caller = parents.get(caller)
  return caller
}

function functionOrigins({ functions, threads, registrations, schedules, nativePosts, windows, start, end, inMs, overlaps }) {
  const parents = executionParents(threads)
  const groups = new Map()
  for (const event of functions) {
    if (event.ts + event.duration <= start || event.ts >= end) continue
    const key = JSON.stringify(event.stack)
    if (!groups.has(key)) groups.set(key, { stack: event.stack, events: 0, durationUs: 0, beforeGrowth: 0,
      duringGrowth: 0, matched: 0, matchedDuringGrowth: 0, matchedWithStack: 0,
      duringGrowthWithOriginStack: 0, nativeTaskEvents: 0, nativePostMatches: 0, messagePortEvents: 0,
      firstAtMs: inMs(event.ts), firstDuringGrowthAtMs: undefined,
      contexts: new Map(), upstreams: new Map(), nativeTasks: new Map() })
    const group = groups.get(key)
    const duringGrowth = windows.some(window => overlaps(event, window))
    group.events += 1
    group.durationUs += Math.min(event.ts + event.duration, end) - Math.max(start, event.ts)
    if (windows.length && event.ts + event.duration <= windows[0].start) group.beforeGrowth += 1
    if (duringGrowth) {
      group.duringGrowth += 1
      group.firstDuringGrowthAtMs ??= inMs(event.ts)
    }

    const context = []
    let asyncRun
    let registration
    let nativeRun
    let inMessagePort = false
    let inJsTask = true
    for (let outer = parents.get(event); outer; outer = parents.get(outer)) {
      if (context.length < 6) context.push([outer.name, outer.eventType].filter(Boolean).join(':'))
      if (NATIVE_RUNS.has(outer.name)) {
        nativeRun = outer
        break
      }
      if (outer.name === MESSAGE_PORT_ACCEPT) inMessagePort = true
      if (inJsTask && outer.name === ASYNC_RUN) {
        if (asyncRun) inJsTask = false
        else asyncRun = outer
      }
      if (inJsTask) registration ??= registrations.get(outer)
      if (outer.name === 'RunTask') inJsTask = false
    }
    const contextKey = JSON.stringify(context)
    if (!group.contexts.has(contextKey)) group.contexts.set(contextKey, { events: 0, outerEvents: context })
    group.contexts.get(contextKey).events += 1

    const post = nativePosts.get(nativeRun)
    const postStack = post?.stack.length ? post.stack : post ? enclosingCall(post, parents)?.stack ?? [] : []
    if (inMessagePort) group.messagePortEvents += 1
    if (nativeRun) {
      group.nativeTaskEvents += 1
      if (post) group.nativePostMatches += 1
      const nativeKey = JSON.stringify([nativeRun.name, nativeRun.postedFrom, inMessagePort, post?.name, postStack])
      if (!group.nativeTasks.has(nativeKey)) group.nativeTasks.set(nativeKey, {
        name: nativeRun.name, postedFrom: nativeRun.postedFrom, inMessagePort, events: 0, duringGrowth: 0,
        post: post ? { name: post.name, stack: postStack, sameThread: post.tid === nativeRun.tid,
          firstAtMs: inMs(post.ts), firstQueueMs: Math.round((nativeRun.ts - post.ts) / 100) / 10 } : undefined
      })
      const task = group.nativeTasks.get(nativeKey)
      task.events += 1
      if (duringGrowth) task.duringGrowth += 1
    }

    const scheduled = schedules.get(asyncRun)
    const initiator = scheduled ?? registration
    const caller = initiator && enclosingCall(initiator, parents)
    const stack = initiator?.stack.length ? initiator.stack : caller?.stack ?? []
    if (duringGrowth && (postStack.length || stack.length)) group.duringGrowthWithOriginStack += 1
    if (!initiator) continue
    group.matched += 1
    if (duringGrowth) group.matchedDuringGrowth += 1
    if (stack.length) group.matchedWithStack += 1
    const via = scheduled ? 'v8-flow' : initiator.name === 'SchedulePostMessage' ? 'post-message-trace-id' : 'callback-registration'
    const stackSource = initiator.stack.length ? 'event' : stack.length ? 'enclosing-call' : undefined
    const upstreamKey = JSON.stringify([via, initiator.name, initiator.taskName, stack])
    if (!group.upstreams.has(upstreamKey)) group.upstreams.set(upstreamKey, { via, name: initiator.name,
      taskName: initiator.taskName, stack, stackSource, events: 0, duringGrowth: 0, scheduledInsideSameFunction: 0,
      firstScheduledAtMs: inMs(initiator.ts), firstCallAtMs: inMs(event.ts) })
    const upstream = group.upstreams.get(upstreamKey)
    upstream.events += 1
    if (duringGrowth) upstream.duringGrowth += 1
    if (caller?.name === 'FunctionCall' && JSON.stringify(caller.stack) === key) upstream.scheduledInsideSameFunction += 1
    upstream.firstScheduledAtMs = Math.min(upstream.firstScheduledAtMs, inMs(initiator.ts))
  }
  return [...groups.values()].sort((a, b) => b.durationUs - a.durationUs || b.events - a.events).slice(0, 8)
    .map(({ durationUs, contexts, upstreams, nativeTasks, ...group }) => ({ ...group, durationMs: Math.round(durationUs / 100) / 10,
      unmatched: group.events - group.matched,
      contexts: [...contexts.values()].sort((a, b) => b.events - a.events).slice(0, 4),
      upstreams: [...upstreams.values()].sort((a, b) => b.events - a.events).slice(0, 5),
      nativeTasks: [...nativeTasks.values()].sort((a, b) => b.events - a.events).slice(0, 5) }))
}

async function summarizeTimeline({ path, pid, samples }) {
  const records = []
  const asyncRecords = []
  const flows = []
  const nativeRecords = []
  const nativeFlows = []
  let mainTid
  let limited = false
  let asyncLimited = false
  let nativeLimited = false
  for await (const event of traceEvents(path)) {
    if (event.pid !== pid || typeof event.name !== 'string') continue
    if (event.name === 'thread_name' && /^CrRendererMain$|^RendererMain$/.test(event.args?.name)) mainTid = event.tid
    if (!Number.isFinite(event.ts) || !Number.isSafeInteger(event.tid)) continue
    if (FLOW_PHASES.has(event.ph)) {
      const id = traceId(event.id)
      if (id === null) continue
      const marker = { key: `${event.name}:${id}`, phase: event.ph, ts: event.ts, tid: event.tid }
      if (event.cat === ASYNC_CATEGORY) {
        if (flows.length >= MAX_ASYNC_EVENTS) asyncLimited = true
        else flows.push(marker)
      } else if (event.cat === NATIVE_FLOW_CATEGORY && NATIVE_POSTS.has(event.name)) {
        if (nativeFlows.length >= MAX_ASYNC_EVENTS) nativeLimited = true
        else nativeFlows.push(marker)
      }
      continue
    }
    if (ASYNC_EVENTS.has(event.name)) {
      if (asyncRecords.length >= MAX_ASYNC_EVENTS) asyncLimited = true
      else asyncRecords.push(timelineData(event, null))
      continue
    }
    const nativeCategory = NATIVE_RUNS.has(event.name) ? 'toplevel' : NATIVE_POSTS.has(event.name) ? NATIVE_FLOW_CATEGORY :
      event.name === MESSAGE_PORT_ACCEPT ? 'blink' : undefined
    if (nativeCategory) {
      if (event.cat !== nativeCategory) continue
      if (nativeRecords.length >= MAX_ASYNC_EVENTS) nativeLimited = true
      else nativeRecords.push(timelineData(event, null))
      continue
    }
    const marker = markerIndex(event)
    if (!Object.hasOwn(INITIATORS, event.name) && !EXECUTION_CONTEXTS.has(event.name) && !ACTIVITY.has(event.name) && !GC.has(event.name) &&
        event.name !== 'UpdateCounters' && marker === null) continue
    if (records.length >= MAX_EVENTS) { limited = true; continue }
    records.push(timelineData(event, marker))
  }

  let threadSource = 'metadata'
  if (mainTid === undefined) {
    const candidates = new Map()
    for (const event of records) {
      const weight = event.marker !== null ? 10_000 : event.nodes !== undefined ? 10 : CALLBACKS.has(event.name) ? 1 : 0
      candidates.set(event.tid, (candidates.get(event.tid) ?? 0) + weight)
    }
    mainTid = [...candidates].sort((a, b) => b[1] - a[1])[0]?.[0]
    threadSource = 'marker-or-activity'
  }
  const threads = new Map()
  for (const event of records.concat(asyncRecords, nativeRecords)) {
    if (!threads.has(event.tid)) threads.set(event.tid, [])
    threads.get(event.tid).push(event)
  }
  for (const [tid, threadEvents] of threads) {
    threads.set(tid, completeEvents(threadEvents.sort((a, b) => a.ts - b.ts)))
  }
  const events = (threads.get(mainTid) ?? []).filter(event => !ASYNC_EVENTS.has(event.name))
  const processEvents = [...threads.values()].flat().sort((a, b) => a.ts - b.ts)
  const registrations = matchRegistrations(processEvents)
  const schedules = matchAsyncRuns(processEvents.filter(event => ASYNC_EVENTS.has(event.name)), flows)
  const nativePosts = matchNativePosts(processEvents.filter(event => NATIVE_RUNS.has(event.name) || NATIVE_POSTS.has(event.name)), nativeFlows)
  const marked = new Map()
  for (const event of records) {
    if (event.marker === null) continue
    marked.set(event.marker, Math.min(marked.get(event.marker) ?? Infinity, event.ts))
  }
  const traceFrom = events[0]?.ts ?? 0
  const traceTo = events.reduce((end, event) => Math.max(end, event.ts + event.duration), traceFrom)
  const aligned = alignSamples(samples, marked, traceFrom, traceTo)
  const tailFrom = Math.max(traceFrom, traceTo - FALLBACK_WINDOW_US)
  const counters = []
  for (const { ts, nodes } of events) {
    if (nodes === undefined || ts < tailFrom) continue
    if (!counters.length || ts - counters.at(-1).ts >= 500_000) counters.push({ ts, nodes })
  }
  const points = aligned?.points ?? counters
  const countersSource = aligned?.source ?? (counters.length >= 2 ? 'trace-counters' : 'unavailable')
  const start = aligned ? points[0].ts : tailFrom
  const end = aligned ? points.at(-1).ts : traceTo
  const coverage = Math.max(0, Math.min(end, traceTo) - Math.max(start, traceFrom))
  const windows = points.slice(1).flatMap((point, index) => {
    const previous = points[index]
    return point.nodes - previous.nodes >= 500 ? [{ start: previous.ts, end: point.ts, delta: point.nodes - previous.nodes }] : []
  })

  const inMs = ts => Math.round((ts - start) / 100) / 10
  const overlaps = (event, window) => event.ts < window.end && event.ts + event.duration >= window.start
  const functions = events.filter(event => event.name === 'FunctionCall' && event.stack.length)
  const groups = new Map()
  for (const event of events) {
    if (event.ts + event.duration < start || event.ts > end || (!ACTIVITY.has(event.name) && !GC.has(event.name))) continue
    const initiator = registrations.get(event)
    const nested = !event.stack.length && CALLBACKS.has(event.name) ? firstFunctionIn(event, functions) : null
    const stack = nested?.stack ?? event.stack
    const signature = JSON.stringify([event.name, event.eventType, stack, initiator?.stack ?? []])
    if (!groups.has(signature)) groups.set(signature, { name: event.name, eventType: event.eventType, stack,
      stackSource: nested ? 'function-in-callback' : stack.length ? 'event' : undefined,
      initiator: initiator ? { name: initiator.name, atMs: inMs(initiator.ts), stack: initiator.stack } : undefined,
      events: 0, matched: 0, duration: 0, growthWindows: new Set() })
    const group = groups.get(signature)
    group.events += 1
    group.matched += Number(Boolean(initiator))
    group.duration += event.duration
    for (const [index, window] of windows.entries()) if (overlaps(event, window)) group.growthWindows.add(index)
  }
  const ordered = [...groups.values()].sort((a, b) => b.growthWindows.size - a.growthWindows.size ||
    b.duration - a.duration || b.events - a.events)
  const summarize = ({ duration, growthWindows, ...group }) => ({
    ...group, durationMs: Math.round(duration / 100) / 10, growthWindows: [...growthWindows]
  })
  return { tid: mainTid, threadSource, limited, matchedMarkers: marked.size, countersSource,
    targetEvents: events.length, windowMs: inMs(end), traceCoverageMs: Math.round(coverage / 100) / 10,
    growthWindowCount: windows.length,
    dom: points.slice(0, 64).map(point => ({ atMs: inMs(point.ts), nodes: point.nodes })),
    growth: windows.slice(0, 64).map(window => ({ fromMs: inMs(window.start), toMs: inMs(window.end), delta: window.delta })),
    callbacks: ordered.filter(group => CALLBACKS.has(group.name) || group.name === 'EventDispatch').slice(0, 12).map(summarize),
    activity: ordered.slice(0, 24).map(summarize),
    execution: { limited: asyncLimited || limited, flowEvents: flows.length,
      schedules: asyncRecords.filter(event => event.name === ASYNC_SCHEDULED && event.ph !== 'E').length,
      runs: asyncRecords.filter(event => event.name === ASYNC_RUN && event.ph !== 'E').length,
      matchedRuns: schedules.size, firstGrowthAtMs: windows.length ? inMs(windows[0].start) : undefined,
      native: { limited: nativeLimited, flowEvents: nativeFlows.length, matchedTasks: nativePosts.size,
        runs: nativeRecords.filter(event => NATIVE_RUNS.has(event.name) && event.ph !== 'E').length,
        messagePortAccepts: nativeRecords.filter(event => event.name === MESSAGE_PORT_ACCEPT && event.ph !== 'E').length },
      hotFunctions: functionOrigins({ functions, threads, registrations, schedules, nativePosts, windows, start, end, inMs, overlaps }) } }
}

async function summarizeThrottleTrace({ path, pid, phases }) {
  const marks = new Map()
  const frames = []
  const calls = []
  let mainTid
  let limited = false
  for await (const event of traceEvents(path)) {
    if (event.pid !== pid || !Number.isSafeInteger(event.tid)) continue
    if (event.name === 'thread_name' && /^(CrRendererMain|RendererMain)$/.test(event.args?.name)) mainTid = event.tid
    if (!Number.isFinite(event.ts) || event.ph === 'E' || FLOW_PHASES.has(event.ph)) continue
    const marker = markerIndex(event)
    if (marker !== null) {
      const previous = marks.get(marker)
      if (!previous || event.ts < previous.ts) marks.set(marker, { ts: event.ts, tid: event.tid })
      continue
    }
    if (event.name === 'ThreadControllerImpl::RunTask' && event.cat === 'toplevel' &&
        nativeSource(event.args)?.function?.split('::').at(-1) === 'ScheduledActionSendBeginMainFrame') {
      if (frames.length < MAX_EVENTS) frames.push({ ts: event.ts, tid: event.tid })
      else limited = true
    }
    if (event.name === 'FunctionCall') {
      const frame = traceStack(event.args?.data ?? event.args ?? {})[0]
      if (frame?.source !== 'chatgpt' || !frame.asset || !frame.line || !frame.column) continue
      if (calls.length < MAX_EVENTS) {
        calls.push({ ts: event.ts, tid: event.tid, frame, duration: Number.isFinite(event.dur) ? event.dur : 0 })
      } else limited = true
    }
  }

  mainTid ??= marks.get(phases[0]?.startMarker)?.tid
  const results = phases.map(({ name, startMarker, endMarker }) => {
    const from = marks.get(startMarker)
    const to = marks.get(endMarker)
    if (!from || !to || from.tid !== mainTid || to.tid !== mainTid || to.ts <= from.ts) return { name, aligned: false }
    const inWindow = event => event.tid === mainTid && event.ts >= from.ts && event.ts < to.ts
    const functions = new Map()
    for (const call of calls.filter(inWindow)) {
      const key = JSON.stringify(call.frame)
      if (!functions.has(key)) functions.set(key, { frame: call.frame, duration: 0, calls: 0 })
      const group = functions.get(key)
      group.calls += 1
      group.duration += Math.min(call.duration, to.ts - call.ts)
    }
    return { name, aligned: true, frameTasks: frames.filter(inWindow).length,
      traceMs: (to.ts - from.ts) / 1000, functions }
  })

  const baseline = results.find(result => result.name === 'baseline')
  const hotspot = [...(baseline?.functions?.entries() ?? [])]
    .sort(([, a], [, b]) => b.duration - a.duration || b.calls - a.calls)[0]
  return { mainTid, limited, matchedMarkers: marks.size, hotspot: hotspot?.[1].frame,
    phases: results.map(({ functions, ...result }) => ({ ...result,
      hotspotCalls: functions && hotspot ? functions.get(hotspot[0])?.calls ?? 0 : undefined })) }
}

const DOM_APIS = new Set([
  'createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment', 'cloneNode', 'importNode',
  'adoptNode', 'parseFromString', 'createContextualFragment', 'insertAdjacentHTML', 'createHTMLDocument',
  'appendChild', 'replaceChildren', 'replaceWith', 'innerHTML', 'outerHTML', 'DOMParser', 'getBoundingClientRect',
  'getComputedStyle', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'postTask',
  'subscribe', 'useMemo', 'useEffect', 'useLayoutEffect'
])

function inspectFunctions({ asset, source, locations }) {
  const ts = require('typescript')
  const file = ts.createSourceFile(asset, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  return locations.map(location => {
    let position
    try { position = file.getPositionOfLineAndCharacter(location.line - 1, location.column - 1) }
    catch { return { ...location, status: 'invalid-position' } }
    let fn
    function seek(node) {
      if (position < node.pos || position >= node.end) return
      if (ts.isFunctionLike(node) && node.body) fn = node
      ts.forEachChild(node, seek)
    }
    seek(file)
    if (!fn) return { ...location, status: 'function-not-found' }
    const calls = new Map()
    function visit(node) {
      if (ts.isFunctionLike(node)) return
      let target
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) target = node.expression
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)) {
        if (ts.isPropertyAccessExpression(node.left) && ['innerHTML', 'outerHTML'].includes(node.left.name.text)) target = node.left
      }
      const name = target && (ts.isPropertyAccessExpression(target) ? target.name.text : ts.isIdentifier(target) ? target.text : null)
      if (DOM_APIS.has(name)) {
        if (!calls.has(name)) calls.set(name, { name, occurrences: 0, positions: [] })
        const entry = calls.get(name)
        entry.occurrences += 1
        if (entry.positions.length < 4) {
          const pos = file.getLineAndCharacterOfPosition(node.getStart(file))
          entry.positions.push({ line: pos.line + 1, column: pos.character + 1 })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(fn.body)
    return { ...location, status: 'inspected', calls: [...calls.values()] }
  })
}

if (parentPort) {
  Promise.resolve().then(() => workerData.kind === 'trace' ? summarizeTimeline(workerData) :
    workerData.kind === 'throttle' ? summarizeThrottleTrace(workerData) : inspectFunctions(workerData))
    .then(result => parentPort.postMessage({ result }), () => parentPort.postMessage({ error: 'analysis-unavailable' }))
}

module.exports = { summarizeTimeline, inspectFunctions, summarizeThrottleTrace }
