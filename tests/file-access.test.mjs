// User-run offline regressions: node --test tests/file-access.test.mjs
// Real attachment preparation with synthetic files and mocked filesystem/SSH.
// No Electron, user files, disk writes or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({ exports, Buffer, TextDecoder, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}

const requests = load('../src/shared/file-requests.ts')
const configBytes = Buffer.from('\ufeff{\r\n  // 保留注释、换行和尾逗号\r\n  "provider": { "example": {} },\r\n}\r\n')

function fixture(files) {
  const cwd = path.resolve(tmpdir(), 'web2term-file-access-fixture')
  const sources = new Map(Object.entries(files).map(([name, bytes]) => [path.join(cwd, name), Buffer.from(bytes)]))
  const writes = new Map(), removals = [], reads = []
  const api = load('../src/main/file-access.ts', {
    '../shared/file-requests': requests,
    'node:path': path, 'node:os': { tmpdir }, 'node:crypto': { createHash },
    'node:fs/promises': {
      async open(filename, mode) {
        assert.equal(mode, 'r')
        const bytes = sources.get(filename)
        assert.ok(bytes, 'Only synthetic source files may be opened')
        reads.push(filename)
        let offset = 0
        return {
          async stat() { return { isFile: () => true, size: bytes.length } },
          async read(buffer, bufferOffset, length) {
            const bytesRead = Math.min(length, bytes.length - offset)
            bytes.copy(buffer, bufferOffset, offset, offset + bytesRead)
            offset += bytesRead
            return { bytesRead }
          },
          async close() {}
        }
      },
      async mkdtemp(prefix) { return prefix + 'fixture' },
      async mkdir() {},
      async writeFile(filename, bytes) {
        assert.equal(sources.has(filename), false, 'Never overwrite a source file')
        writes.set(filename, Buffer.from(bytes))
      },
      async rm(filename) { removals.push(filename) }
    }
  })
  const request = {
    type: 'read_files', description: '读取测试配置',
    files: Object.keys(files).map(filename => ({ path: filename })),
    context: { scope: 'local', hostId: '', cwd }
  }
  return { api, request, sources, writes, removals, reads }
}

test('DeepSeek uploads JSONC as a text snapshot while preserving BOM, comments, CRLF and original bytes', async () => {
  for (const filename of ['opencode.jsonc', 'OPENCODE.JSONC']) {
    const f = fixture({ [filename]: configBytes })
    const result = await f.api.prepareFiles(f.request, new AbortController().signal, undefined, 'deepseek')
    assert.equal(result.failed, false)
    assert.equal(result.attachments.length, 1)
    const attachment = result.attachments[0]
    assert.equal(attachment.fileName, filename + '.txt')
    assert.equal(path.basename(attachment.path), attachment.fileName)
    assert.equal(attachment.mimeType, 'text/plain')
    assert.equal(attachment.textNameAlias, true)
    assert.equal(attachment.sizeBytes, configBytes.length)
    assert.equal(attachment.sha256, createHash('sha256').update(configBytes).digest('hex'))
    assert.deepEqual(f.writes.get(attachment.path), configBytes)
    assert.deepEqual(f.sources.get(path.join(f.request.context.cwd, filename)), configBytes)
    assert.ok(result.text.includes(path.join(f.request.context.cwd, filename)))
    assert.match(result.text, /临时附件增加 \.txt 后缀/)
    assert.doesNotMatch(result.text, /保留注释|"provider"/)
    assert.equal(result.images.length, 0)
    await result.cleanup()
    assert.equal(f.removals.length, 1)
    assert.equal(path.dirname(f.removals[0]), path.resolve(tmpdir()))
    assert.ok(path.basename(f.removals[0]).startsWith('gpt-read-files-'))
    assert.equal(path.dirname(path.dirname(attachment.path)), f.removals[0])
  }
})

test('SSH JSONC snapshots use the same transport alias without attempting a local source read', async () => {
  const f = fixture({ 'opencode.jsonc': configBytes })
  const request = { ...f.request, context: { scope: 'ssh', hostId: 'fixture-host', cwd: '/srv/config' } }
  const signal = new AbortController().signal
  let remoteReads = 0
  const result = await f.api.prepareFiles(request, signal, async (filename, limit, abort) => {
    remoteReads++
    assert.equal(filename, '/srv/config/opencode.jsonc')
    assert.equal(limit, f.api.MAX_FILE_BYTES)
    assert.equal(abort, signal)
    return Buffer.from(configBytes)
  }, 'deepseek')
  assert.equal(result.failed, false)
  assert.equal(remoteReads, 1)
  assert.equal(f.reads.length, 0)
  assert.equal(result.attachments[0].fileName, 'opencode.jsonc.txt')
  assert.equal(result.attachments[0].mimeType, 'text/plain')
  assert.deepEqual(f.writes.get(result.attachments[0].path), configBytes)
  await result.cleanup()
})

test('other platforms retain the original JSONC attachment name and bytes', async () => {
  for (const platformId of ['chatgpt', 'claude', 'gemini', undefined]) {
    const f = fixture({ 'opencode.jsonc': configBytes })
    const result = await f.api.prepareFiles(f.request, new AbortController().signal, undefined, platformId)
    assert.equal(result.failed, false)
    assert.equal(result.attachments[0].fileName, 'opencode.jsonc')
    assert.equal(result.attachments[0].textNameAlias, false)
    assert.deepEqual(f.writes.get(result.attachments[0].path), configBytes)
    await result.cleanup()
  }
})

test('binary and invalid UTF-8 bytes are never disguised as JSONC text attachments', async () => {
  for (const bytes of [Buffer.from([0, 1, 2, 3]), Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 65, 0])]) {
    const f = fixture({ 'opencode.jsonc': bytes })
    const result = await f.api.prepareFiles(f.request, new AbortController().signal, undefined, 'deepseek')
    assert.equal(result.attachments[0].fileName, 'opencode.jsonc')
    assert.equal(result.attachments[0].mimeType, 'application/octet-stream')
    assert.equal(result.attachments[0].textNameAlias, false)
    assert.deepEqual(f.writes.get(result.attachments[0].path), bytes)
    await result.cleanup()
  }
})

test('DeepSeek keeps already supported extensions and existing extensionless text aliases', async () => {
  const f = fixture({ 'opencode.json': '{}\n', 'sample.ts': 'export const value = 1\n', '.gitconfig': '[core]\neditor=code\n' })
  const result = await f.api.prepareFiles(f.request, new AbortController().signal, undefined, 'deepseek')
  assert.equal(result.failed, false)
  assert.deepEqual(Array.from(result.attachments, file => file.fileName), ['opencode.json', 'sample.ts', '.gitconfig.txt'])
  assert.deepEqual(Array.from(result.attachments, file => file.mimeType), ['application/json', 'text/plain', 'text/plain'])
  assert.deepEqual(Array.from(result.attachments, file => file.textNameAlias), [false, false, true])
  await result.cleanup()
})

test('a JSONC transport alias colliding with a requested filename does not overwrite either source', async () => {
  const existingText = Buffer.from('different original file\n')
  const f = fixture({ 'opencode.jsonc': configBytes, 'opencode.jsonc.txt': existingText })
  const result = await f.api.prepareFiles(f.request, new AbortController().signal, undefined, 'deepseek')
  assert.equal(result.failed, true)
  assert.equal(result.attachments.length, 1)
  assert.match(result.text, /本次附件含同名文件/)
  assert.equal(f.writes.size, 1)
  assert.deepEqual(f.sources.get(path.join(f.request.context.cwd, 'opencode.jsonc')), configBytes)
  assert.deepEqual(f.sources.get(path.join(f.request.context.cwd, 'opencode.jsonc.txt')), existingText)
  await result.cleanup()
})
