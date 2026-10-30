/**
 * User-run CPU/output experiment. Never starts Electron, a shell, or a background process.
 * No network or application data. Logs append synchronously under the OS temporary directory.
 * Workers share a monotonic deadline and cancellation flag; killing this process kills them.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const { monitorEventLoopDelay } = require('node:perf_hooks')

const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6
const round = value => Number(value.toFixed(2))

function cpuWorker() {
  const control = new Int32Array(workerData.control, 0, 2)
  const deadline = new Float64Array(workerData.control, 8, 1)
  parentPort.postMessage({ event: 'ready' })
  while (Atomics.load(control, 0) === 0) Atomics.wait(control, 0, 0, 1000)
  let checksum = 1, batches = 0
  // No output or growing data structure in the compute loop.
  while (Atomics.load(control, 0) === 1 && monotonicMs() < deadline[0]) {
    for (let index = 0; index < 32768; index++) checksum = Math.imul(checksum ^ index, 1664525) + 1013904223 | 0
    batches++
  }
  parentPort.postMessage({ event: 'finished', batches, checksum })
  parentPort.close()
}

function optionsFor(args) {
  const values = { mode: 'baseline', seconds: '30', workers: 'half', 'rate-kib': '64', priority: 'inherit' }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help' || args[index] === '-h') return null
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[index])
    if (!match || !Object.hasOwn(values, match[1])) throw new Error('Unknown option; use --help.')
    const value = match[2] ?? args[++index]
    if (!value || value.startsWith('--')) throw new Error('Every option needs a value.')
    values[match[1]] = value
  }
  const integer = (name, min, max) => {
    if (!/^\d+$/.test(values[name])) throw new Error(name + ' must be an integer.')
    const value = Number(values[name])
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + ' must be between ' + min + ' and ' + max + '.')
    return value
  }
  if (!['baseline', 'cpu', 'output', 'mixed'].includes(values.mode)) throw new Error('mode must be baseline, cpu, output or mixed.')
  if (!['inherit', 'below-normal'].includes(values.priority)) throw new Error('priority must be inherit or below-normal.')
  const available = os.availableParallelism()
  let workers = values.workers === 'half' ? Math.max(1, Math.floor(available / 2))
    : values.workers === 'all' ? available : integer('workers', 1, available)
  if (!['cpu', 'mixed'].includes(values.mode)) workers = 0
  // Avoid unexpectedly creating hundreds of V8 instances on large servers.
  if (workers > 64) throw new Error('This probe caps workers at 64; select --workers=64 or fewer.')
  return { mode: values.mode, seconds: integer('seconds', 5, 30), workers,
    rateKiB: ['output', 'mixed'].includes(values.mode) ? integer('rate-kib', 1, 512) : 0,
    priority: values.priority, available, logical: os.cpus().length }
}

function cpuTimes() {
  let idle = 0, total = 0
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }
  return { idle, total }
}

function main() {
  const options = optionsFor(process.argv.slice(2))
  if (!options) {
    process.stdout.write('User-run only. Defaults to a 30-second idle baseline.\n' +
      'node tools/diag/cpu-load-probe.cjs --mode=baseline|cpu|output|mixed\n' +
      '  --seconds=5..30 --workers=half|all|N --rate-kib=1..512\n' +
      '  --priority=inherit|below-normal\n' +
      'Ctrl+C or Web2Term terminal interrupt stops the experiment.\n')
    return
  }
  if (options.priority === 'below-normal') os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
  const directory = path.join(os.tmpdir(), 'gpt-login-diag')
  fs.mkdirSync(directory, { recursive: true })
  const logFile = path.join(directory, 'cpu-load-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
  const log = (event, data = {}) => fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8')
  const shared = new SharedArrayBuffer(16)
  const control = new Int32Array(shared, 0, 2)
  const deadline = new Float64Array(shared, 8, 1)
  const entries = []
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  let started = false, ending = false, stdoutBlocked = false, stdoutBroken = false
  let startupTimer, deadlineTimer, sampleTimer, outputTimer
  let startedAt = 0, lastSampleAt = 0, lastOutputAt = 0
  let previousCpu, previousTimes, outputBytes = 0, previousOutputBytes = 0
  let outputCredit = 0
  let backpressureEvents = 0, blockedOutputTicks = 0, samples = 0
  // Fixed 256-byte ASCII lines; no application prompts, commands or output are captured.
  const outputLine = '[cpu-load synthetic output] '.padEnd(255, 'x') + '\n'

  const emit = text => {
    if (stdoutBroken) return false
    const accepted = process.stdout.write(text)
    if (!accepted) { stdoutBlocked = true; backpressureEvents++ }
    return accepted
  }
  const sample = (final = false) => {
    if (!started) return
    const now = monotonicMs(), intervalMs = now - lastSampleAt
    if (intervalMs < 1) return
    const cpu = process.cpuUsage(), times = cpuTimes()
    const coreEquivalents = ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / (intervalMs * 1000)
    const totalTicks = times.total - previousTimes.total
    const systemCpuPct = totalTicks > 0 ? 100 * (1 - (times.idle - previousTimes.idle) / totalTicks) : null
    const record = { elapsedMs: round(now - startedAt), intervalMs: round(intervalMs),
      timerLateMs: final ? null : round(Math.max(0, intervalMs - 1000)),
      systemCpuPct: systemCpuPct === null ? null : round(systemCpuPct),
      probeCpuPctAllCores: round(100 * coreEquivalents / Math.max(1, options.logical)),
      probeCpuCoreEquivalents: round(coreEquivalents), probeRssMiB: round(process.memoryUsage.rss() / 1048576),
      systemFreeMiB: round(os.freemem() / 1048576),
      probeLoopP95Ms: round(histogram.percentile(95) / 1e6), probeLoopMaxMs: round(histogram.max / 1e6),
      outputBytes, outputKiBPerSecond: round((outputBytes - previousOutputBytes) * 1000 / intervalMs / 1024),
      backpressureEvents, blockedOutputTicks, final }
    log('SAMPLE', record)
    samples++
    if (!final && !stdoutBlocked) emit('[cpu-load] t=' + Math.round(record.elapsedMs / 1000) + 's systemCPU=' +
      record.systemCpuPct + '% probeCPU=' + record.probeCpuPctAllCores + '% outputKiB=' + Math.round(outputBytes / 1024) + '\n')
    previousCpu = cpu; previousTimes = times; previousOutputBytes = outputBytes; lastSampleAt = now
    histogram.reset()
  }

  async function finish(reason, exitCode = 0) {
    if (ending) return
    ending = true
    Atomics.store(control, 0, 2)
    Atomics.notify(control, 0)
    clearTimeout(startupTimer); clearTimeout(deadlineTimer); clearInterval(sampleTimer); clearInterval(outputTimer)
    try { sample(true) } catch { process.stderr.write('[cpu-load] Could not append final sample.\n') }
    histogram.disable()
    await Promise.allSettled(entries.map(entry => entry.worker.terminate()))
    try {
      log('END', { reason, exitCode, elapsedMs: started ? round(monotonicMs() - startedAt) : 0,
        outputBytes, samples, backpressureEvents, blockedOutputTicks, workers: options.workers })
    } catch { process.stderr.write('[cpu-load] Could not append END record.\n'); exitCode = 1 }
    process.exitCode = exitCode
    if (!stdoutBroken) emit('[cpu-load] END reason=' + reason + '\nLOG=' + logFile + '\n')
  }

  function start() {
    if (started || ending) return
    started = true
    clearTimeout(startupTimer)
    startedAt = lastSampleAt = lastOutputAt = monotonicMs()
    previousCpu = process.cpuUsage(); previousTimes = cpuTimes()
    histogram.enable()
    deadline[0] = startedAt + options.seconds * 1000
    log('START', { ...options, pid: process.pid, priorityValue: os.getPriority(), node: process.version,
      totalMemoryMiB: round(os.totalmem() / 1048576),
      note: 'Loop and CPU metrics describe the probe, not Electron or its renderer.' })
    emit('[cpu-load] START mode=' + options.mode + ' workers=' + options.workers + '/' + options.available +
      ' seconds=' + options.seconds + ' rateKiB=' + options.rateKiB + '\nLOG=' + logFile + '\n')
    Atomics.store(control, 0, 1)
    Atomics.notify(control, 0)
    sampleTimer = setInterval(() => {
      try { sample() } catch { void finish('sample-or-log-error', 1) }
    }, 1000)
    deadlineTimer = setTimeout(() => { void finish('completed') }, options.seconds * 1000)
    if (options.rateKiB) outputTimer = setInterval(() => {
      const now = monotonicMs(), intervalMs = now - lastOutputAt
      lastOutputAt = now
      if (ending || now >= deadline[0]) return
      if (stdoutBlocked) { blockedOutputTicks++; outputCredit = 0; return }
      // No catch-up burst and no unbounded queue when the terminal cannot drain output.
      outputCredit = Math.min(outputCredit + options.rateKiB * 1024 * Math.min(intervalMs, 200) / 1000, 65536,
        options.rateKiB * 1024 * options.seconds - outputBytes)
      const lines = Math.floor(outputCredit / 256)
      if (lines > 0) {
        const text = outputLine.repeat(lines)
        outputBytes += Buffer.byteLength(text)
        outputCredit -= Buffer.byteLength(text)
        emit(text)
      }
    }, 100)
  }

  process.stdout.on('drain', () => { stdoutBlocked = false })
  process.stdout.on('error', () => { stdoutBroken = true; void finish('stdout-closed', 1) })
  process.on('SIGINT', () => { void finish('interrupted', 130) })
  process.on('SIGTERM', () => { void finish('terminated', 143) })
  log('SETUP', { ...options, pid: process.pid })
  emit('[cpu-load] Preparing experiment. LOG=' + logFile + '\n')
  if (!options.workers) { start(); return }
  startupTimer = setTimeout(() => { void finish('worker-startup-timeout', 1) }, 10000)
  try {
    for (let index = 0; index < options.workers; index++) {
      const worker = new Worker(__filename, { workerData: { control: shared },
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 } })
      const entry = { worker, ready: false }
      entries.push(entry)
      worker.on('message', message => {
        if (message?.event === 'ready') {
          entry.ready = true
          if (entries.length === options.workers && entries.every(item => item.ready)) start()
        }
      })
      worker.on('error', () => { void finish('worker-error', 1) })
      worker.on('exit', () => {
        if (!ending && (!started || monotonicMs() < deadline[0] - 100)) void finish('worker-exited-early', 1)
      })
    }
  } catch { void finish('worker-start-failed', 1) }
}

if (!isMainThread) cpuWorker()
else {
  try { main() }
  catch (error) { process.stderr.write('[cpu-load] ' + error.message + '\n'); process.exitCode = 1 }
}
