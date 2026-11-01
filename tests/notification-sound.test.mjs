// User-run offline regressions. All audio and time are synthetic; no sound or Electron is started.
// Run: node --test tests/notification-sound.test.mjs tests/desktop-notifications.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/renderer/src/notification-sound.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture() {
  let clock = 0, playback = () => Promise.resolve()
  const sounds = [], warnings = []
  class Audio {
    plays = 0
    pauses = 0
    loads = 0
    currentTime = 0
    onended = null
    onerror = null
    constructor(source) { this.source = source; sounds.push(this) }
    play() { this.plays++; return playback() }
    pause() { this.pauses++ }
    removeAttribute(name) { assert.equal(name, 'src'); this.source = null }
    load() { this.loads++ }
  }
  const module = { exports: {} }
  new Script(code).runInNewContext({ module, exports: module.exports, Audio,
    performance: { now: () => clock }, console: { warn: (...args) => warnings.push(args) } })
  const player = new module.exports.NotificationSoundPlayer('notification-wood-drop.wav')
  return { player, audio: sounds[0], sounds, warnings, time(value) { clock = value }, playback(value) { playback = value } }
}

test('plays the selected recording from its start and reuses one audio element', async () => {
  const f = fixture()
  assert.equal(f.audio.source, 'notification-wood-drop.wav')
  assert.equal(f.audio.preload, 'auto')
  f.audio.currentTime = 0.4
  await f.player.play()
  assert.equal(f.audio.currentTime, 0)
  assert.equal(f.audio.plays, 1)
  f.audio.onended()
  f.time(1200)
  await f.player.play()
  assert.equal(f.audio.plays, 2)
  assert.equal(f.sounds.length, 1)
})

test('a burst neither overlaps nor cuts off a sound, even while play() is still pending', async () => {
  const f = fixture()
  let finish
  f.playback(() => new Promise(resolve => { finish = resolve }))
  const first = f.player.play()
  f.time(50)
  await f.player.play()
  f.time(1100)
  await f.player.play()
  assert.equal(f.audio.plays, 1)
  assert.equal(f.audio.pauses, 0)
  finish()
  await first
  await f.player.play()
  assert.equal(f.audio.plays, 1, 'the resolved play promise means playback started, not ended')
})

test('coalesces notifications within one second, then allows another completed sound', async () => {
  const f = fixture()
  await f.player.play()
  f.audio.onended()
  f.time(700)
  await f.player.play()
  assert.equal(f.audio.plays, 1)
  f.time(1000)
  await f.player.play()
  assert.equal(f.audio.plays, 2)
})

test('a rejected playback request is logged and permits a later notification to retry', async () => {
  const f = fixture()
  f.playback(() => Promise.reject(new Error('Audio unavailable')))
  await f.player.play()
  assert.equal(f.warnings.length, 1)
  f.playback(() => Promise.resolve())
  await f.player.play()
  assert.equal(f.audio.plays, 2)
})

test('an asynchronous media failure releases the playback lock', async () => {
  const f = fixture()
  await f.player.play()
  f.audio.onerror()
  f.time(1000)
  await f.player.play()
  assert.equal(f.audio.plays, 2)
})

test('cleanup releases audio and prevents playback from stale listeners', async () => {
  const f = fixture()
  await f.player.play()
  f.player.dispose()
  f.time(1500)
  await f.player.play()
  assert.equal(f.audio.plays, 1)
  assert.equal(f.audio.pauses, 1)
  assert.equal(f.audio.loads, 1)
  assert.equal(f.audio.source, null)
  assert.equal(f.audio.onended, null)
  assert.equal(f.audio.onerror, null)
})
