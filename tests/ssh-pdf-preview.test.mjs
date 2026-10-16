// User-run offline regressions. Fake SFTP and protocol handlers; no Electron or network.
// Run: node --test tests/ssh-pdf-preview.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({
    exports, Buffer, ArrayBuffer, Uint8Array, AbortController, Error, URL, Response,
    __dirname: path.resolve('out/main'),
    require(name) { assert.ok(name in dependencies, `unexpected dependency ${name}`); return dependencies[name] }
  })
  return exports
}
const shared = load('../src/shared/pdf-preview.ts')
const { SshPdfPreviewReader } = load('../src/main/ssh-pdf-preview.ts', {
  'node:path': path, '../shared/pdf-preview': shared
})
const request = { requestId: 'fixture-1', hostId: 'host-a', path: '/root/简历/曾强.PDF' }
const contents = Buffer.from('%PDF-1.7\nfixture bytes\n%%EOF')
const connected = () => ({ attached: true, status: 'connected', hostId: 'host-a' })

test('PDF bytes cross the bridge as an independent ArrayBuffer, with the original host and Unicode path', async () => {
  const original = Buffer.from(contents)
  const reader = new SshPdfPreviewReader({
    getState: connected,
    async readFileForModel(filename, hostId, maxBytes, signal) {
      assert.equal(filename, request.path)
      assert.equal(hostId, request.hostId)
      assert.equal(maxBytes, 32 * 1024 * 1024)
      assert.equal(signal.aborted, false)
      return original
    }
  })
  const result = await reader.read(request)
  assert.equal(result.hostId, request.hostId)
  assert.equal(result.path, request.path)
  assert.ok(result.data instanceof ArrayBuffer)
  assert.deepEqual(Buffer.from(result.data), contents)
  original.fill(0)
  assert.deepEqual(Buffer.from(result.data), contents)
})

test('invalid requests, disconnected hosts and host mismatches never start a file read', async () => {
  let reads = 0
  let state = connected()
  const reader = new SshPdfPreviewReader({
    getState: () => state,
    async readFileForModel() { reads++; return contents }
  })
  for (const invalid of [null, { ...request, path: 'relative.pdf' }, { ...request, path: '/file.txt' },
    { ...request, path: '/nul\0.pdf' }, { ...request, requestId: '../bad' }, { ...request, hostId: 'host-b' }]) {
    await assert.rejects(reader.read(invalid))
  }
  state = { ...state, status: 'disconnected' }
  await assert.rejects(reader.read(request), /断开或切换/)
  assert.equal(reads, 0)
})

test('non-PDF content and oversized files have useful errors', async () => {
  const reader = new SshPdfPreviewReader({ getState: connected, async readFileForModel() { return Buffer.from('<html>not a PDF</html>') } })
  await assert.rejects(reader.read(request), /不是有效的 PDF/)
  const large = new SshPdfPreviewReader({ getState: connected, async readFileForModel() { throw new Error('远端文件超过本次读取大小上限。') } })
  await assert.rejects(large.read(request), /32 MB.*下载/)
})

test('a switched host cannot publish bytes from an earlier read', async () => {
  let state = connected()
  const reader = new SshPdfPreviewReader({ getState: () => state, async readFileForModel() {
    state = { ...state, hostId: 'host-b' }
    return contents
  } })
  await assert.rejects(reader.read(request), /断开或切换/)
})

test('replacement and close cancel the correct read, and late completion cannot clear a newer request', async () => {
  const reads = []
  const reader = new SshPdfPreviewReader({
    getState: connected,
    readFileForModel(_filename, _hostId, _maxBytes, signal) {
      return new Promise((resolve) => reads.push({ resolve, signal }))
    }
  })
  const first = reader.read(request)
  const second = reader.read({ ...request, requestId: 'fixture-2' })
  assert.equal(reads[0].signal.aborted, true)
  assert.equal(reads[1].signal.aborted, false)
  reads[0].resolve(contents)
  await assert.rejects(first, /取消/)
  reader.cancel('fixture-1')
  assert.equal(reads[1].signal.aborted, false)
  reader.cancel('fixture-2')
  assert.equal(reads[1].signal.aborted, true)
  reads[1].resolve(contents)
  await assert.rejects(second, /取消/)

  const third = reader.read({ ...request, requestId: 'fixture-3' })
  reads[2].resolve(contents)
  assert.equal((await third).data.byteLength, contents.length)
})

test('the packaged asset protocol exposes only its bundled viewer resources', async () => {
  const assets = load('../src/shared/pdf-assets.ts')
  const files = []
  let handler
  let scheme
  const source = load('../src/main/pdf-assets.ts', {
    'node:path': path,
    'node:fs/promises': { async readFile(filename) { files.push(filename); return Buffer.from('fixture asset') } },
    'node:module': { createRequire() { return { resolve() { throw new Error('packaged viewer must not read node_modules') } } } },
    electron: {
      app: { isPackaged: true, getAppPath: () => path.resolve('fixture-app') },
      protocol: { registerSchemesAsPrivileged(value) { scheme = value[0] }, handle(_scheme, callback) { handler = callback } }
    },
    '../shared/pdf-assets': assets
  })
  source.registerPdfAssetScheme()
  source.registerPdfAssetHandler()
  assert.equal(scheme.privileges.supportFetchAPI, true)
  assert.equal(scheme.privileges.bypassCSP, undefined)
  const valid = await handler({ url: 'pdf-asset://viewer/pdfium.wasm', method: 'GET' })
  assert.equal(valid.status, 200)
  assert.equal(valid.headers.get('Content-Type'), 'application/wasm')
  assert.equal(valid.headers.get('Access-Control-Allow-Origin'), '*')
  assert.equal(await valid.text(), 'fixture asset')
  assert.ok(files[0].endsWith(path.join('out', 'renderer', 'pdf-assets', 'pdfium.wasm')))
  for (const url of ['pdf-asset://other/pdfium.wasm', 'pdf-asset://viewer/../../secret.txt',
    'pdf-asset://viewer/%2e%2e%2fsecret.txt', 'pdf-asset://viewer/__proto__', 'pdf-asset://user@viewer/pdfium.wasm']) {
    assert.equal((await handler({ url, method: 'GET' })).status, 404)
  }
  assert.equal((await handler({ url: 'pdf-asset://viewer/pdfium.wasm', method: 'POST' })).status, 404)
  assert.equal(files.length, 1)
})
