import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import diagnostics from '../tools/diag/renderer-timeline-worker.cjs'
import callbackDiagnostics from '../tools/diag/renderer-callback-stacks.cjs'
import frames from '../tools/diag/renderer-probe-frames.cjs'

const { summarizeTimeline, inspectFunctions, summarizeThrottleTrace } = diagnostics
const asset = 'fixture.12345.js'
const url = 'https://chatgpt.com/cdn/assets/' + asset

test('associates a timer registration, its function and a DOM growth window on one renderer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web2term-timeline-fixture-'))
  const path = join(directory, 'trace.json')
  const common = { pid: 9, tid: 10, ph: 'X' }
  const counter = (id, ts) => ({ ...common, name: `web2term-renderer-sample-${id}`, ph: 'I', ts })
  try {
    await writeFile(path, JSON.stringify({ traceEvents: [
      { ...common, name: 'thread_name', ph: 'M', args: { name: 'CrRendererMain' } },
      { ...common, pid: 99, name: 'TimerInstall', ts: 110, args: { data: { timerId: 5, frame: 'ABC' } } },
      { ...common, name: 'TimerInstall', ts: 120, args: { data: { timerId: 5, frame: 'ABC', stackTrace: [
        { url, scriptId: '40', functionName: 'schedule', lineNumber: 8, columnNumber: 7 }
      ] } } },
      counter(0, 10_000),
      { ...common, name: 'TimerFire', ts: 15_000, dur: 6000, args: { data: { timerId: 5, frame: 'ABC' } } },
      { ...common, name: 'FunctionCall', ts: 15_500, dur: 3000,
        args: { data: { url, scriptId: 41, functionName: 'render', lineNumber: 10, columnNumber: 11 } } },
      counter(1, 25_000),
      counter(2, 30_000)
    ] }))
    const summary = await summarizeTimeline({ path, pid: 9, samples: [
      { index: 0, nodes: 1000 }, { index: 1, nodes: 2400 }, { index: 2, nodes: 1200 }
    ] })
    assert.equal(summary.tid, 10)
    assert.equal(summary.matchedMarkers, 3)
    assert.deepEqual(summary.growth, [{ fromMs: 0, toMs: 15, delta: 1400 }])
    const [timer] = summary.callbacks
    assert.equal(timer.name, 'TimerFire')
    assert.equal(timer.matched, 1)
    assert.equal(timer.stackSource, 'function-in-callback')
    assert.equal(timer.stack[0].line, 10)
    assert.equal(timer.initiator.stack[0].name, 'schedule')
    assert.deepEqual(timer.growthWindows, [0])
  } finally {
    await unlink(path).catch(() => {})
    await rmdir(directory)
  }
})

test('inspects only the selected function body and returns structural calls', () => {
  const source = 'function main(doc) { doc.createElement("private"); function unrelated() { doc.cloneNode(); } }'
  const [summary] = inspectFunctions({ asset, source, locations: [{ line: 1, column: 1 }] })
  assert.equal(summary.status, 'inspected')
  assert.deepEqual(summary.calls.map(call => call.name), ['createElement'])
  assert.equal(JSON.stringify(summary).includes('private'), false)
})

test('keeps the DOM window when only one trace marker survives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web2term-timeline-fixture-'))
  const path = join(directory, 'trace.json')
  const common = { pid: 9, tid: 10, ph: 'X' }
  try {
    await writeFile(path, JSON.stringify({ traceEvents: [
      { ...common, name: 'thread_name', ph: 'M', args: { name: 'CrRendererMain' } },
      { ...common, name: 'TimerInstall', ts: 1_000_000, args: { data: { timerId: 5 } } },
      { ...common, name: 'TimerFire', ts: 2_050_000, dur: 50_000, args: { data: { timerId: 5 } } },
      { ...common, name: 'TimeStamp', ph: 'I', ts: 3_000_000, args: { data: { message: 'web2term-renderer-sample-1' } } }
    ] }))
    const samples = [
      { index: 0, ticksUs: 2_000_000, markerClockMs: 1000, nodes: 1000 },
      { index: 1, ticksUs: 3_000_000, markerClockMs: 2000, nodes: 4000 }
    ]
    const direct = await summarizeTimeline({ path, pid: 9, samples })
    const anchored = await summarizeTimeline({ path, pid: 9, samples: samples.map(({ ticksUs: _, ...sample }) => sample) })
    assert.equal(direct.countersSource, 'performance-ticks')
    assert.equal(anchored.countersSource, 'renderer-clock-aligned')
    for (const summary of [direct, anchored]) {
      assert.equal(summary.matchedMarkers, 1)
      assert.equal(summary.traceCoverageMs, 1000)
      assert.deepEqual(summary.growth, [{ fromMs: 0, toMs: 1000, delta: 3000 }])
      assert.deepEqual(summary.callbacks[0].growthWindows, [0])
    }
  } finally {
    await unlink(path).catch(() => {})
    await rmdir(directory)
  }
})

test('traces hot calls to matched V8 tasks and reports calls without a scheduling event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web2term-timeline-fixture-'))
  const path = join(directory, 'trace.json')
  const pid = 9
  const tid = 10
  const workerTid = 11
  const category = 'disabled-by-default-v8.inspector'
  const scheduled = 'v8::Debugger::AsyncTaskScheduled'
  const run = 'v8::Debugger::AsyncTaskRun'
  const event = (name, ts, dur = 0, args, thread = tid) => ({ pid, tid: thread, cat: 'devtools.timeline', ph: 'X',
    name, ts, dur, args })
  const task = (name, ts, dur, args, thread) => ({ ...event(name, ts, dur, args, thread), cat: category })
  const flow = (id, name, ph, ts, thread = tid) => ({ pid, tid: thread, cat: category, id, name, ph, ts })
  const fn = (name, ts, dur, thread = tid) => event('FunctionCall', ts, dur, { data: {
    url, scriptId: 41, functionName: name, lineNumber: name === 'callback' ? 150 : 151, columnNumber: 9640
  } }, thread)
  const dispatch = (ts, duration) => event('EventDispatch', ts, duration, { data: { type: 'message' } })

  try {
    await writeFile(path, JSON.stringify({ traceEvents: [
      { ...event('thread_name', 0, 0, { name: 'CrRendererMain' }), ph: 'M' },
      event('web2term-renderer-sample-0', 1000),
      event('web2term-renderer-sample-1', 5000),
      event('web2term-renderer-sample-2', 9000),
      fn('send', 1100, 800, workerTid),
      task(scheduled, 1500, 0, { taskName: 'postMessage' }, workerTid),
      task(run, 2000, 700), dispatch(2100, 550), fn('callback', 2150, 400),
      { ...task(run, 5500), ph: 'B' }, dispatch(5600, 500), fn('callback', 5650, 350),
      task(scheduled, 5750, 0, { taskName: 'page-supplied task label' }),
      { ...task(run, 6250), ph: 'E' },
      task(run, 7000, 350), dispatch(7050, 280), fn('callback', 7080, 200),
      task(run, 8000, 350), dispatch(8020, 300), fn('callback', 8050, 200),
      flow(7, scheduled, 's', 1500, workerTid), flow(7, scheduled, 'f', 2000),
      flow(8, run, 's', 2000), flow(8, run, 'f', 5500),
      flow(9, scheduled, 's', 5750), flow(9, scheduled, 'f', 7000),
      { ...flow(10, scheduled, 's', 5750), pid: 99 }, flow(10, scheduled, 'f', 8000),
      event('SchedulePostMessage', 6100, 0, { data: { traceId: '9007199254740993', stackTrace: [
        { url, scriptId: '41', functionName: 'post', lineNumber: 152, columnNumber: 12 }
      ] } }),
      event('HandlePostMessage', 7500, 350, { data: { traceId: '9007199254740993' } }),
      dispatch(7520, 300), fn('receiver', 7550, 200)
    ] }))
    const { execution } = await summarizeTimeline({ path, pid, samples: [
      { index: 0, nodes: 1000 }, { index: 1, nodes: 1200 }, { index: 2, nodes: 4200 }
    ] })
    assert.equal(execution.matchedRuns, 3)
    assert.equal(execution.firstGrowthAtMs, 4)
    const [callback, receiver] = execution.hotFunctions
    assert.equal(callback.stack[0].name, 'callback')
    assert.equal(callback.events, 4)
    assert.equal(callback.beforeGrowth, 1)
    assert.equal(callback.duringGrowth, 3)
    assert.equal(callback.matched, 3)
    assert.equal(callback.matchedDuringGrowth, 2)
    assert.equal(callback.matchedWithStack, 3)
    assert.equal(callback.unmatched, 1)
    assert.deepEqual(callback.contexts[0].outerEvents, ['EventDispatch:message', run])
    assert.equal(callback.upstreams[0].via, 'v8-flow')
    assert.equal(callback.upstreams[0].stack[0].name, 'send')
    assert.equal(callback.upstreams[0].events, 2)
    assert.equal(callback.upstreams[1].scheduledInsideSameFunction, 1)
    assert.equal(receiver.upstreams[0].via, 'post-message-trace-id')
    assert.equal(receiver.upstreams[0].stack[0].name, 'post')
    assert.equal(JSON.stringify(execution).includes('page-supplied task label'), false)
  } finally {
    await unlink(path).catch(() => {})
    await rmdir(directory)
  }
})

test('links a native post to the matching renderer task across categories and threads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web2term-timeline-fixture-'))
  const path = join(directory, 'trace.json')
  const main = { pid: 9, tid: 10, ph: 'X', cat: 'devtools.timeline' }
  const nativeRun = { ...main, name: 'ThreadControllerImpl::RunTask', cat: 'toplevel' }
  const post = { ...main, name: 'SequenceManager PostTask', cat: 'toplevel.flow', ph: 'I', tid: 11 }
  const frame = (name, line) => ({ data: { url, scriptId: '41', functionName: name, lineNumber: line, columnNumber: 1 } })
  try {
    await writeFile(path, JSON.stringify({ traceEvents: [
      { ...main, name: 'thread_name', ph: 'M', args: { name: 'CrRendererMain' } },
      { ...main, name: 'web2term-renderer-sample-0', ts: 1_000 },
      { ...main, name: 'web2term-renderer-sample-1', ts: 9_000 },
      { ...main, tid: 11, name: 'FunctionCall', ts: 1_100, dur: 600, args: frame('handleMessage', 8) },
      { ...post, ts: 1_200 },
      { ...post, ph: 's', id: 7, ts: 1_200 },
      { ...post, ph: 'f', id: 7, tid: 10, ts: 5_000 },
      { ...nativeRun, ts: 5_000, dur: 1_200, args: { src_file: 'C:/excluded/base/simple_watcher.cc', src_func: 'mojo::Notify', src_line: 42 } },
      { ...main, name: 'RunTask', ts: 5_000, dur: 1_200 },
      { ...main, name: 'MessagePort::Accept', cat: 'blink', ts: 5_050, dur: 900 },
      { ...main, name: 'FunctionCall', ts: 5_100, dur: 800, args: frame('callback', 10) },
      { ...post, pid: 99, ts: 6_000 },
      { ...post, pid: 99, ph: 's', id: 8, ts: 6_000 },
      { ...post, ph: 'f', id: 8, tid: 10, ts: 7_000 },
      { ...nativeRun, ts: 7_000, dur: 1_200, args: { task: { posted_from: {
        file_name: 'C:\\excluded\\base\\simple_watcher.cc', function_name: 'mojo::Notify', line_number: 42
      } } } },
      { ...main, name: 'FunctionCall', ts: 7_100, dur: 800, args: frame('callback', 10) }
    ] }))

    const { execution } = await summarizeTimeline({ path, pid: 9, samples: [{ index: 0, nodes: 1000 }, { index: 1, nodes: 2000 }] })
    assert.equal(execution.native.matchedTasks, 1)
    const [callback] = execution.hotFunctions
    assert.equal(callback.nativeTaskEvents, 2)
    assert.equal(callback.nativePostMatches, 1)
    assert.equal(callback.messagePortEvents, 1)
    assert.equal(callback.duringGrowthWithOriginStack, 1)
    assert.deepEqual(callback.nativeTasks[0].postedFrom, { file: 'simple_watcher.cc', function: 'mojo::Notify', line: 42 })
    assert.equal(callback.nativeTasks[0].post.stack[0].name, 'handleMessage')
    assert.equal(callback.nativeTasks[0].post.sameThread, false)
    assert.equal(callback.nativeTasks[0].post.firstQueueMs, 3.8)
    assert.deepEqual(callback.nativeTasks[1].postedFrom, callback.nativeTasks[0].postedFrom)
    assert.equal(callback.nativeTasks[1].post, undefined)
    assert.equal(JSON.stringify(execution).includes('excluded'), false)
  } finally {
    await unlink(path).catch(() => {})
    await rmdir(directory)
  }
})

test('resumes each targeted pause and removes the breakpoint before the final resume', async () => {
  const debuggerApi = new EventEmitter()
  const target = { asset, scriptId: '41', line: 10, column: 1 }
  const location = { scriptId: '41', lineNumber: 9, columnNumber: 3 }
  const commands = []
  const send = async (method, params) => {
    commands.push(method)
    if (method === 'Debugger.enable') {
      debuggerApi.emit('message', {}, 'Debugger.scriptParsed', { scriptId: '41', url: url + '?private-url=1', endLine: 9, endColumn: 20 })
    } else if (method === 'Debugger.getPossibleBreakpoints') {
      assert.equal(params.restrictToFunction, true)
      assert.deepEqual(params.end, { scriptId: '41', lineNumber: 9, columnNumber: 20 })
      return { locations: [location] }
    } else if (method === 'Debugger.setBreakpoint') {
      setImmediate(() => {
        for (let i = 0; i < 3; i += 1) debuggerApi.emit('message', {}, 'Debugger.paused', {
          hitBreakpoints: ['test-breakpoint'], callFrames: [{ functionName: 'callback', location, scopeChain: ['private-scope'] }],
          asyncStackTraceId: { id: '10' }
        })
      })
      return { breakpointId: 'test-breakpoint', actualLocation: location }
    } else if (method === 'Debugger.getStackTrace') {
      return { stackTrace: { description: 'postMessage', callFrames: [{ ...location, url, functionName: 'sender' }] } }
    }
  }

  const result = await callbackDiagnostics.captureCallbackStacks({ debuggerApi, send, cleanupSend: send, target,
    frameMetadata: frames.frameMetadata, signal: new AbortController().signal })
  assert.equal(result.status, 'captured')
  assert.equal(result.samples.length, 3)
  assert.equal(result.samples[0].stack[0].asset, asset)
  assert.equal(result.samples[0].parents[0].name, 'postMessage')
  assert.equal(result.samples[0].parents[0].stack[0].name, 'sender')
  assert.equal(JSON.stringify(result).includes('private-'), false)
  assert.deepEqual(commands.filter(command => /^Debugger\.(resume|removeBreakpoint)$/.test(command)),
    ['Debugger.resume', 'Debugger.resume', 'Debugger.removeBreakpoint', 'Debugger.resume'])
  assert.equal(commands.at(-1), 'Debugger.disable')
  assert.equal(debuggerApi.listenerCount('message'), 0)
})

test('treats an aligned throttled phase with no frames differently from missing markers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web2term-throttle-fixture-'))
  const path = join(directory, 'trace.json')
  const common = { pid: 9, tid: 10, ph: 'X' }
  const marker = (index, ts) => ({ ...common, ph: 'I', name: 'TimeStamp', ts,
    args: { data: { message: `web2term-renderer-sample-${index}` } } })
  const frameTask = ts => ({ ...common, cat: 'toplevel', name: 'ThreadControllerImpl::RunTask', ts, dur: 120,
    args: { src_file: 'cc/trees/proxy_impl.cc', src_func: 'ScheduledActionSendBeginMainFrame' } })
  const callback = ts => ({ ...common, name: 'FunctionCall', ts, dur: 100,
    args: { data: { url, functionName: 'callback', lineNumber: 10, columnNumber: 1 } } })
  try {
    await writeFile(path, JSON.stringify({ traceEvents: [
      { ...common, name: 'thread_name', ph: 'M', args: { name: 'CrRendererMain' } },
      marker(0, 1000), frameTask(1200), callback(1210), marker(1, 2000),
      marker(2, 3000), { ...frameTask(3500), tid: 11 }, marker(3, 4000),
      marker(4, 5000), frameTask(5500), callback(5510), { ...marker(5, 6000), pid: 11 }
    ] }))
    const result = await summarizeThrottleTrace({ path, pid: 9, phases: [
      { name: 'baseline', startMarker: 0, endMarker: 1 },
      { name: 'throttled', startMarker: 2, endMarker: 3 },
      { name: 'restored', startMarker: 4, endMarker: 5 }
    ] })
    assert.equal(result.hotspot.name, 'callback')
    assert.deepEqual(result.phases.map(phase => [phase.aligned, phase.frameTasks, phase.hotspotCalls]),
      [[true, 1, 1], [true, 0, 0], [false, undefined, undefined]])
  } finally {
    await unlink(path).catch(() => {})
    await rmdir(directory)
  }
})
