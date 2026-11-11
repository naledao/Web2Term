import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { TextDecoder } from 'node:util'
import type { SFTPWrapper, Stats } from 'ssh2'
import { MAX_SSH_TEXT_FILE_BYTES, validSshTextFileTarget } from '../shared/ssh-file-edit'
import type { SshTextFile, SshTextFileSaveRequest, SshTextFileSaveResult, SshTextFileTarget } from '../shared/ssh-file-edit'

type Current = () => boolean
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const verify = (current: Current): void => {
  if (!current()) throw new Error('原 SSH 连接已断开或切换，文件操作已停止；编辑内容仍可复制。')
}

/** One bounded SFTP operation. Timeout/disconnect rejects even a missing server callback. */
export async function withSshFileChannel<T>(open: () => Promise<SFTPWrapper>, current: Current,
  action: (sftp: SFTPWrapper, check: () => void) => Promise<T>): Promise<T> {
  verify(current)
  let channel: SFTPWrapper | undefined, timer: ReturnType<typeof setTimeout> | undefined, expired = false
  const check = (): void => { if (expired) throw new Error('远程文件操作超时，请重新打开文件后核对。'); verify(current) }
  const operation = (async () => {
    const sftp = await open()
    channel = sftp
    try { check(); return await action(sftp, check) }
    finally { sftp.end() }
  })()
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; channel?.end(); reject(new Error('远程文件操作超过 60 秒，请核对后重试。')) }, 60000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

function callback(call: (done: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => call(error => error ? reject(error) : resolve()))
}
function openFile(sftp: SFTPWrapper, path: string, mode: 'r' | 'wx'): Promise<Buffer> {
  return new Promise((resolve, reject) => sftp.open(path, mode, { mode: 0o600 }, (error, handle) => error ? reject(error) : resolve(handle)))
}
function statFile(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.lstat(path, (error, stats) => error ? reject(error) : resolve(stats)))
}

async function readBytes(sftp: SFTPWrapper, path: string, check: () => void): Promise<{ bytes: Buffer; stats: Stats }> {
  check()
  const stats = await statFile(sftp, path)
  check()
  if (!stats.isFile()) throw new Error('仅支持编辑普通文本文件；符号链接请打开其实际目标文件。')
  if (stats.size > MAX_SSH_TEXT_FILE_BYTES) throw new Error('文件超过 1 MB，请下载后编辑。')
  const handle = await openFile(sftp, path, 'r')
  try {
    const data = Buffer.alloc(MAX_SSH_TEXT_FILE_BYTES + 1)
    let offset = 0
    while (offset < data.length) {
      check()
      const count = await new Promise<number>((resolve, reject) => sftp.read(handle, data, offset,
        Math.min(32768, data.length - offset), offset, (error, read) => error ? reject(error) : resolve(read)))
      if (count === 0) break
      offset += count
    }
    check()
    if (offset > MAX_SSH_TEXT_FILE_BYTES) throw new Error('文件超过 1 MB，请下载后编辑。')
    return { bytes: data.subarray(0, offset), stats }
  } finally { await callback(done => sftp.close(handle, done)).catch(() => {}) }
}

function textFile(target: SshTextFileTarget, bytes: Buffer): SshTextFile {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error('文件不是有效的 UTF-8 文本，请下载后使用对应编码编辑。') }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('文件包含二进制内容，无法作为文本编辑。')
  const bom = text.startsWith('\ufeff')
  if (bom) text = text.slice(1)
  const ending = /\r\n|\r|\n/.exec(text)?.[0]
  // A mixed-ending file cannot be round-tripped by a line-based editor without changes.
  if (ending && /[\r\n]/.test(text.replaceAll(ending, ''))) {
    throw new Error('文件混用了多种换行格式，请下载后编辑，以免保存时改变原格式。')
  }
  return { ...target, content: text.replace(/\r\n|\r/g, '\n'), revision: digest(bytes), size: bytes.length,
    bom, lineEnding: ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : 'LF' }
}

export async function readSshTextFile(sftp: SFTPWrapper, target: SshTextFileTarget, check: () => void): Promise<SshTextFile> {
  if (!validSshTextFileTarget(target)) throw new Error('远程文件地址无效。')
  const { bytes } = await readBytes(sftp, target.path, check)
  return textFile(target, bytes)
}

/** Stage beside the original, recheck its bytes, and atomically replace it after a complete write. */
export async function saveSshTextFile(sftp: SFTPWrapper, request: SshTextFileSaveRequest, check: () => void): Promise<SshTextFileSaveResult> {
  if (!validSshTextFileTarget(request) || typeof request.content !== 'string' || request.content.length > MAX_SSH_TEXT_FILE_BYTES ||
    typeof request.revision !== 'string' || !/^[a-f\d]{64}$/.test(request.revision)) throw new Error('文件保存参数无效。')
  const original = await readBytes(sftp, request.path, check)
  if (digest(original.bytes) !== request.revision) return { status: 'conflict' }
  const previous = textFile(request, original.bytes)
  const ending = previous.lineEnding === 'CRLF' ? '\r\n' : previous.lineEnding === 'CR' ? '\r' : '\n'
  const bytes = Buffer.from((previous.bom ? '\ufeff' : '') + request.content.replace(/\r\n|\r/g, '\n').replaceAll('\n', ending), 'utf8')
  if (bytes.length > MAX_SSH_TEXT_FILE_BYTES) throw new Error('修改后的文件超过 1 MB，尚未保存。')
  // Validate again before any write; the bridge may receive arbitrary content.
  const saved = textFile(request, bytes)
  const temporary = posix.join(posix.dirname(request.path), `.web2term-edit-${randomUUID()}.tmp`)
  let staged = false, handle: Buffer | null = null
  try {
    check()
    handle = await openFile(sftp, temporary, 'wx')
    staged = true
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      check()
      await callback(done => sftp.write(handle!, bytes, offset, Math.min(32768, bytes.length - offset), offset, done))
    }
    check()
    const attrs = await new Promise<Stats>((resolve, reject) => sftp.fstat(handle!, (error, stats) => error ? reject(error) : resolve(stats)))
    if (attrs.uid !== original.stats.uid || attrs.gid !== original.stats.gid) {
      await callback(done => sftp.fchown(handle!, original.stats.uid, original.stats.gid, done))
    }
    await callback(done => sftp.fchmod(handle!, original.stats.mode & 0o7777, done))
    await callback(done => sftp.close(handle!, done))
    handle = null
    const latest = await readBytes(sftp, request.path, check)
    if (digest(latest.bytes) !== request.revision || latest.stats.mode !== original.stats.mode ||
      latest.stats.uid !== original.stats.uid || latest.stats.gid !== original.stats.gid) return { status: 'conflict' }
    check()
    try { await callback(done => sftp.ext_openssh_rename(temporary, request.path, done)) }
    catch (error) {
      if (error instanceof Error && /unsupported|not support/i.test(error.message)) throw new Error('此服务器不支持安全替换文件，原文件未覆盖，请下载后编辑。')
      throw error
    }
    staged = false
    // The server has acknowledged the replacement on the original host. A later
    // workspace/connection change must not turn that confirmed save into a failure.
    return { status: 'saved', file: saved }
  } finally {
    if (handle) await callback(done => sftp.close(handle!, done)).catch(() => {})
    if (staged) await callback(done => sftp.unlink(temporary, done)).catch(() => {})
  }
}
