// User-run offline regressions for the actual injected capture code.
// Run: node --test tests/image-attachment-capture.test.mjs
// No Electron, browser session, real user database or network access.
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'

const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const entry = '    takeUserImageAttachments,'
assert.equal(source.split(entry).length, 2)
// Expose private entry points only inside this offline VM, without changing the
// production public API or reproducing the capture/merge implementation here.
const instrumented = source.replace(entry, `${entry}
    imageFixture: { beginUserImageCapture, rememberDraftFiles },`)
const base64 = (value) => Buffer.from(value).toString('base64')

class ElementFixture {
  nodeType = 1
  isConnected = true
  parentElement = null
  files = []
  constructor(tag, attributes = {}, children = []) {
    this.tagName = tag.toUpperCase()
    this.attributes = attributes
    this.replaceChildren(...children)
  }
  getAttribute(name) { return this.attributes[name] ?? null }
  getClientRects() { return [{}] }
  replaceChildren(...children) {
    for (const child of this.children || []) child.parentElement = null
    this.children = children
    for (const child of children) child.parentElement = this
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]) }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()))
    const tag = /^[a-z][\w-]*/i.exec(selector)?.[0] || ''
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false
    const attributes = [...selector.matchAll(/\[([\w-]+)(?:([*^$~]?=)"([^"]*)")?\]/g)]
    if (selector.slice(tag.length).replace(/\[([^\]]*)\]/g, '') !== '') return false
    return attributes.every(([, name, operator, expected]) => {
      const value = this.getAttribute(name)
      if (value === null) return false
      if (!operator) return true
      if (operator === '~=') return value.split(/\s+/).includes(expected)
      if (operator === '$=') return value.endsWith(expected)
      return value === expected
    })
  }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node
    return null
  }
  compareDocumentPosition() { return 4 }
}

function imageFile(name, content, { width = 1220, height = 2656, type = 'image/jpeg', pixels = content, gate, fail = false } = {}) {
  return { name, content, type, size: Buffer.byteLength(content), width, height, pixels, gate, fail }
}

function fixture() {
  let now = 1_000_000
  let serial = 0
  const composer = new ElementFixture('div', { contenteditable: 'true', role: 'textbox' })
  const cards = new ElementFixture('div')
  const input = new ElementFixture('input', { type: 'file' })
  const form = new ElementFixture('form', {}, [cards, composer, input])
  const body = new ElementFixture('body', {}, [form])
  const resources = new Map()
  const reports = []
  const window = {}
  const document = {
    body, activeElement: composer, addEventListener() {},
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    createElement(tag) {
      assert.equal(tag, 'canvas')
      let drawn
      return {
        width: 0, height: 0,
        getContext: () => ({ drawImage(image) { drawn = image } }),
        toDataURL() { return `data:image/png;base64,${base64(`${this.width}x${this.height}:${drawn.pixels}`)}` }
      }
    }
  }
  new Script(instrumented).runInNewContext({
    window, document, URL, location: { href: 'https://offline.invalid/c/fixture', pathname: '/c/fixture' },
    Element: ElementFixture, HTMLInputElement: ElementFixture,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ visibility: 'visible' }),
    crypto: webcrypto, atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Date: class extends Date { static now() { return now } },
    setTimeout(callback, delay) {
      // Only sent-turn polling needs to advance the clock. Watchdog and timeout
      // callbacks stay dormant so fixtures cannot start recurring background work.
      if (delay === 100) queueMicrotask(() => { now += delay; callback() })
      return 1
    },
    clearTimeout() {},
    console: { log(line) { reports.push(JSON.parse(line.slice('[cmd-terminal] '.length))) } },
    FileReader: class {
      readAsDataURL(blob) {
        Promise.resolve(blob.gate).then(() => {
          if (blob.fail) throw new Error('fixture file read failed')
          this.result = `data:${blob.type};base64,${base64(blob.content)}`
          this.onload()
        }).catch((error) => { this.error = error; this.onerror() })
      }
    },
    createImageBitmap: async (blob) => ({ width: blob.width, height: blob.height, pixels: blob.pixels, close() {} }),
    async fetch(url) {
      assert.ok(resources.has(url), 'fixtures must never fetch a real resource')
      const resource = resources.get(url)
      if (resource.canvasOnly) throw new Error('fixture fetch unavailable')
      return { ok: true, blob: async () => resource }
    }
  })
  const controller = window.__cmdTerminalInterceptor
  return {
    input, body, form, reports,
    remember: (files) => controller.imageFixture.rememberDraftFiles(files),
    begin: () => controller.imageFixture.beginUserImageCapture(),
    take: (token) => controller.takeUserImageAttachments(token),
    advance(ms) { now += ms },
    preview(name, content, options = {}) {
      const resource = imageFile(name, content, { width: 940, height: 2048, type: 'image/png', ...options })
      resource.canvasOnly = options.canvasOnly === true
      const src = `blob:https://offline.invalid/${++serial}`
      resources.set(src, resource)
      const image = new ElementFixture('img', { alt: name })
      Object.assign(image, { src, naturalWidth: resource.width, naturalHeight: resource.height, complete: true, pixels: resource.pixels })
      return image
    },
    show(...images) { cards.replaceChildren(...images) }
  }
}

const contents = (attachments) => Array.from(attachments, (attachment) => attachment.dataBase64)

test('a cached JPEG and its renamed, resized PNG preview produce one original attachment', async () => {
  const app = fixture()
  const original = imageFile('1f77436cf3df4e4482934f792fd051ac.jpg', 'original-jpeg')
  app.remember([original]) // The web page has already cleared its FileList.
  app.show(app.preview('1f77436cf3df4e4482934f792fd051ac(1).jpg', 'resized-preview-png'))
  const saved = await app.take(app.begin())
  assert.equal(saved.length, 1)
  assert.equal(saved[0].fileName, original.name)
  assert.equal(saved[0].mimeType, 'image/jpeg')
  assert.equal(saved[0].dataBase64, base64(original.content))
  assert.equal(app.reports.at(-1).count, 1)
})

test('the same original discovered through FileList and the upload cache is saved once', async () => {
  const app = fixture()
  const original = imageFile('photo.jpg', 'original')
  app.input.files = [original]
  app.remember([original])
  app.show(app.preview('photo.jpg', 'preview'))
  assert.deepEqual(contents(await app.take(app.begin())), [base64('original')])
})

test('multiple different originals retain their bytes while their previews are removed', async () => {
  const app = fixture()
  app.remember([imageFile('first.jpg', 'first-original'), imageFile('second.jpg', 'second-original')])
  app.show(app.preview('first.jpg', 'first-preview'), app.preview('second(1).jpg', 'second-preview'))
  assert.deepEqual(contents(await app.take(app.begin())), [base64('first-original'), base64('second-original')])
})

test('adding another image does not discard an earlier preview absent from the latest upload cache', async () => {
  const app = fixture()
  app.remember([imageFile('first.jpg', 'first-original')])
  app.remember([imageFile('second.jpg', 'second-original')])
  app.show(app.preview('first.jpg', 'first-preview'), app.preview('second.jpg', 'second-preview'))
  assert.deepEqual(new Set(contents(await app.take(app.begin()))), new Set([base64('first-preview'), base64('second-original')]))
})

test('different files with the same name are never deduplicated by filename alone', async () => {
  const app = fixture()
  app.remember([imageFile('image.jpg', 'first-original'), imageFile('image.jpg', 'second-original')])
  app.show(app.preview('image.jpg', 'first-preview'), app.preview('image.jpg', 'second-preview'))
  const saved = await app.take(app.begin())
  assert.equal(saved.filter((attachment) => attachment.sourceKind === 'file').length, 2)
  assert.deepEqual(new Set(contents(saved)), new Set(['first-original', 'second-original', 'first-preview', 'second-preview'].map(base64)))
})

test('two previews sharing one filename cannot both be claimed by one cached original', async () => {
  const app = fixture()
  app.remember([imageFile('image.jpg', 'latest-original')])
  app.show(app.preview('image.jpg', 'earlier-preview'), app.preview('image.jpg', 'latest-preview'))
  const saved = await app.take(app.begin())
  assert.ok(contents(saved).includes(base64('earlier-preview')))
  assert.ok(contents(saved).includes(base64('latest-original')))
})

test('unnamed and unrelated previews remain available as fallback attachments', async () => {
  const app = fixture()
  app.remember([imageFile('image-1.png', 'original', { type: 'image/png' })])
  app.show(app.preview('', 'unidentified-preview'))
  assert.equal((await app.take(app.begin())).length, 2, 'a generated display filename is not upload identity')
})

test('a canvas preview and an original with identical decoded pixels share the same content key', async () => {
  const app = fixture()
  app.remember([imageFile('original.png', 'original-encoded-png', { type: 'image/png', pixels: 'same-pixels' })])
  app.show(app.preview('', 'different-encoded-png', { width: 1220, height: 2656, pixels: 'same-pixels', canvasOnly: true }))
  assert.deepEqual(contents(await app.take(app.begin())), [base64('original-encoded-png')])
})

test('preview capture still works when original-file capture fails or is unavailable', async () => {
  const app = fixture()
  app.remember([imageFile('photo.jpg', 'unreadable-original', { fail: true })])
  app.show(app.preview('photo.jpg', 'preview', { canvasOnly: true }))
  const saved = await app.take(app.begin())
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mimeType, 'image/png')
  assert.equal(saved[0].sourceKind, 'preview')
})

test('a blob image in conversation history is excluded from a new draft', async () => {
  const app = fixture()
  const oldTurn = new ElementFixture('div', { 'data-content-search-unit-key': 'old:user' }, [app.preview('old.jpg', 'old-preview')])
  app.body.replaceChildren(oldTurn, app.form)
  app.remember([imageFile('new.jpg', 'new-original')])
  assert.deepEqual(contents(await app.take(app.begin())), [base64('new-original')])
})

test('expired cache data cannot replace the current preview', async () => {
  const app = fixture()
  app.remember([imageFile('photo.jpg', 'stale-original')])
  app.advance(120_001)
  app.show(app.preview('photo.jpg', 'current-preview'))
  assert.deepEqual(contents(await app.take(app.begin())), [base64('current-preview')])
})

test('a later paste is isolated from an in-flight capture and survives its cache cleanup', async () => {
  const app = fixture()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  app.remember([imageFile('first.jpg', 'first-original', { gate })])
  app.show(app.preview('first.jpg', 'first-preview'))
  const first = app.begin()
  app.remember([imageFile('second.jpg', 'second-original')])
  app.show(app.preview('second.jpg', 'second-preview'))
  release()
  assert.deepEqual(contents(await app.take(first)), [base64('first-original')])
  assert.deepEqual(contents(await app.take(app.begin())), [base64('second-original')])
  assert.equal((await app.take(first)).length, 0, 'a capture token is consumed once')
})
