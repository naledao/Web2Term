// User-run only: node --test tests/ssh-file-edit.test.mjs
// In-memory SFTP/files only; no Electron, SSH connection or real file changes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, Buffer, Error, setTimeout, clearTimeout, require(name) {
    if (name.startsWith('node:')) return nodeRequire(name)
    assert.ok(Object.hasOwn(dependencies, name), name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/ssh-file-edit.ts')
const api = load('../src/main/ssh-file-edit.ts', { '../shared/ssh-file-edit': shared })
const target = { sessionId: 'workspace-a', hostId: 'host-a', path: '/project/.env' }

function fixture(initial = Buffer.from('PORT=8080\n'), hooks = {}) {
  const files = new Map([[target.path, { bytes: Buffer.from(initial), mode: 0o100640, uid: 1000, gid: 2000 }]])
  const handles = new Map(), events = []
  let serial = 0, current = true
  const stats = file => ({ size: file.bytes.length, mode: file.mode, uid: file.uid, gid: file.gid,
    isFile: () => !file.symlink, isSymbolicLink: () => !!file.symlink })
  const sftp = {
    end() { events.push('end') },
    lstat(path, done) { const file = files.get(path); done(file ? undefined : new Error('missing'), file && stats(file)) },
    open(path, mode, attrs, done) {
      if (mode === 'wx') {
        if (files.has(path)) { done(new Error('exists')); return }
        files.set(path, { bytes: Buffer.alloc(0), mode: 0o100000 | attrs.mode, uid: 999, gid: 999 })
        events.push('create')
      }
      if (!files.has(path)) { done(new Error('missing')); return }
      const handle = Buffer.from(String(++serial)); handles.set(handle.toString(), path); done(undefined, handle)
    },
    read(handle, buffer, offset, length, position, done) {
      const bytes = files.get(handles.get(handle.toString())).bytes
      const count = Math.min(length, 19, Math.max(0, bytes.length - position))
      bytes.copy(buffer, offset, position, position + count)
      done(undefined, count, buffer, position)
    },
    write(handle, buffer, offset, length, position, done) {
      events.push('write')
      if (hooks.writeError) { done(new Error('synthetic disk full')); return }
      const file = files.get(handles.get(handle.toString()))
      const next = Buffer.alloc(Math.max(file.bytes.length, position + length)); file.bytes.copy(next)
      buffer.copy(next, position, offset, offset + length); file.bytes = next
      hooks.afterWrite?.({ files, disconnect: () => { current = false } })
      done()
    },
    close(handle, done) { handles.delete(handle.toString()); done() },
    fstat(handle, done) { done(undefined, stats(files.get(handles.get(handle.toString())))) },
    fchown(handle, uid, gid, done) { Object.assign(files.get(handles.get(handle.toString())), { uid, gid }); done() },
    fchmod(handle, mode, done) { files.get(handles.get(handle.toString())).mode = 0o100000 | mode; done() },
    ext_openssh_rename(source, destination, done) {
      events.push('rename')
      if (hooks.renameError) { done(new Error('Operation unsupported')); return }
      files.set(destination, files.get(source)); files.delete(source)
      hooks.afterRename?.(() => { current = false })
      done()
    },
    unlink(path, done) { events.push('unlink'); files.delete(path); done() }
  }
  const check = () => { if (!current) throw new Error('原 SSH 连接已断开或切换') }
  return { sftp, files, handles, events, check, disconnect() { current = false },
    read: () => api.readSshTextFile(sftp, target, check),
    save: request => api.saveSshTextFile(sftp, { ...target, ...request }, check) }
}

test('dotfiles and Unicode UTF-8 cross the bridge with a content revision and no file writes', async () => {
  const f = fixture(Buffer.from('名称=中文\nPORT=8080\n')), file = await f.read()
  assert.equal(file.content, '名称=中文\nPORT=8080\n')
  assert.equal(file.hostId, target.hostId)
  assert.match(file.revision, /^[a-f\d]{64}$/)
  assert.deepEqual(f.events, [])
  assert.equal(f.handles.size, 0)
  assert.equal(shared.canEditSshTextFile('.env', 427), true)
  assert.equal(shared.canEditSshTextFile('config.yaml', 427), true)
  assert.equal(shared.canEditSshTextFile('image.png', 427), false)
})

test('saving preserves UTF-8 BOM, CRLF, file permissions and ownership', async () => {
  const f = fixture(Buffer.from('\ufeffPORT=8080\r\n名称=旧值\r\n')), file = await f.read()
  assert.equal(file.content, 'PORT=8080\n名称=旧值\n')
  assert.equal(file.bom, true)
  assert.equal(file.lineEnding, 'CRLF')
  const result = await f.save({ revision: file.revision, content: 'PORT=8081\n名称=新值\n' })
  assert.equal(result.status, 'saved')
  assert.equal(f.files.get(target.path).bytes.toString(), '\ufeffPORT=8081\r\n名称=新值\r\n')
  assert.equal(f.files.get(target.path).mode, 0o100640)
  assert.equal(f.files.get(target.path).uid, 1000)
  assert.equal(f.files.get(target.path).gid, 2000)
  assert.notEqual(result.file.revision, file.revision)
  assert.equal(f.files.size, 1)
  assert.equal(f.handles.size, 0)
})

test('an external change is detected before writing, even when the byte length is unchanged', async () => {
  const f = fixture(), file = await f.read()
  f.files.get(target.path).bytes = Buffer.from('PORT=9090\n')
  assert.equal((await f.save({ revision: file.revision, content: 'PORT=8081\n' })).status, 'conflict')
  assert.equal(f.files.get(target.path).bytes.toString(), 'PORT=9090\n')
  assert.deepEqual(f.events, [])
})

test('a change during staging cancels replacement and removes the temporary file', async () => {
  const f = fixture(undefined, { afterWrite({ files }) { files.get(target.path).bytes = Buffer.from('changed externally\n') } })
  const file = await f.read()
  const result = await f.save({ revision: file.revision, content: 'my edit\n' })
  assert.equal(result.status, 'conflict')
  assert.equal(f.files.get(target.path).bytes.toString(), 'changed externally\n')
  assert.equal(f.events.includes('rename'), false)
  assert.equal(f.files.size, 1)
})

test('failed writes and unsupported atomic rename leave the original intact', async () => {
  for (const hooks of [{ writeError: true }, { renameError: true }]) {
    const f = fixture(undefined, hooks), file = await f.read()
    await assert.rejects(f.save({ revision: file.revision, content: 'new value\n' }))
    assert.equal(f.files.get(target.path).bytes.toString(), 'PORT=8080\n')
    assert.equal(f.files.size, 1)
    assert.equal(f.handles.size, 0)
  }
})

test('disconnecting before replacement cannot overwrite the original or switch hosts', async () => {
  const f = fixture(undefined, { afterWrite({ disconnect }) { disconnect() } }), file = await f.read()
  await assert.rejects(f.save({ revision: file.revision, content: 'new value\n' }), /断开或切换/)
  assert.equal(f.files.get(target.path).bytes.toString(), 'PORT=8080\n')
  assert.equal(f.events.includes('rename'), false)
  assert.equal(f.files.size, 1)
})

test('a confirmed replacement remains successful if the connection changes after its acknowledgement', async () => {
  const f = fixture(undefined, { afterRename(disconnect) { disconnect() } }), file = await f.read()
  const result = await f.save({ revision: file.revision, content: 'new value\n' })
  assert.equal(result.status, 'saved')
  assert.equal(result.file.hostId, target.hostId)
  assert.equal(f.files.get(target.path).bytes.toString(), 'new value\n')
})

test('invalid encodings, binary data, mixed line endings, symlinks and oversized files are not editable', async () => {
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from('a\0b'), Buffer.from('a\r\nb\n'), Buffer.alloc(shared.MAX_SSH_TEXT_FILE_BYTES + 1, 65)]) {
    await assert.rejects(fixture(bytes).read())
  }
  const f = fixture(); f.files.get(target.path).symlink = true
  await assert.rejects(f.read(), /符号链接/)
  assert.equal(f.handles.size, 0)
})

test('empty content saves as a real empty file, while oversized edits do not create a temporary file', async () => {
  const f = fixture(), file = await f.read()
  const result = await f.save({ revision: file.revision, content: '' })
  assert.equal(result.status, 'saved')
  assert.equal(f.files.get(target.path).bytes.length, 0)
  const large = fixture(), original = await large.read()
  await assert.rejects(large.save({ revision: original.revision, content: '中'.repeat(400000) }), /超过 1 MB/)
  assert.deepEqual(large.events, [])
})

test('invalid targets and revisions are rejected before opening a file', async () => {
  const f = fixture()
  for (const request of [{ ...target, path: 'relative' }, { ...target, path: '/a\0b' }, { ...target, sessionId: '' }]) {
    await assert.rejects(api.readSshTextFile(f.sftp, request, f.check))
  }
  await assert.rejects(f.save({ revision: 'invalid', content: 'edit' }))
  assert.equal(f.handles.size, 0)
  assert.deepEqual(f.events, [])
})

test('the channel wrapper closes a completed read and rejects a changed connection before file access', async () => {
  const f = fixture()
  const file = await api.withSshFileChannel(async () => f.sftp, () => true,
    (channel, check) => api.readSshTextFile(channel, target, check))
  assert.equal(file.content, 'PORT=8080\n')
  assert.equal(f.events.at(-1), 'end')
  let current = true, accessed = false
  await assert.rejects(api.withSshFileChannel(async () => { current = false; return f.sftp }, () => current,
    async () => { accessed = true }), /断开或切换/)
  assert.equal(accessed, false)
  let opened = false
  await assert.rejects(api.withSshFileChannel(async () => { opened = true; return f.sftp }, () => false,
    async () => {}), /断开或切换/)
  assert.equal(opened, false)
})
