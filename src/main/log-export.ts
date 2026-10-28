import { app } from 'electron'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { arch, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { deflateRaw } from 'node:zlib'

const deflate = promisify(deflateRaw)

/** Older logs rarely explain a current problem and make the archive large. */
export const LOG_EXPORT_DAYS = 7

interface LogSource {
  /** Folder inside the archive. */
  folder: string
  directory: string
}

interface ZipEntry {
  name: Buffer
  crc: number
  size: number
  compressedSize: number
  dosTime: number
  dosDate: number
  offset: number
}

/**
 * Everything diagnostic this machine wrote in the last few days, as one zip.
 *
 * `diag/` is the always-on probe and prompt metadata in %TEMP%\gpt-login-diag; `app/` is the
 * console log that exists only when the app ran with DSH_APP_LOG=1. A manifest records the
 * app version and OS so logs from different machines can be told apart.
 */
export async function exportDiagnosticLogs(target: string, now = Date.now()): Promise<{ fileCount: number; bytes: number }> {
  const sources: LogSource[] = [
    { folder: 'diag', directory: join(tmpdir(), 'gpt-login-diag') },
    { folder: 'app', directory: join(app.getPath('userData'), 'logs') }
  ]
  const since = now - LOG_EXPORT_DAYS * 24 * 60 * 60 * 1000
  const handle = await open(target, 'w')
  const entries: ZipEntry[] = []
  let offset = 0, fileCount = 0, bytes = 0
  const add = async (name: string, data: Buffer, modified: Date): Promise<void> => {
    const compressed = await deflate(data)
    const entry: ZipEntry = { name: Buffer.from(name, 'utf8'), crc: crc32(data), size: data.length,
      compressedSize: compressed.length, ...dosDateTime(modified), offset }
    const header = localHeader(entry)
    await handle.write(header)
    await handle.write(compressed)
    offset += header.length + compressed.length
    entries.push(entry)
  }
  try {
    const files: Array<{ name: string; path: string; modified: Date }> = []
    for (const source of sources) {
      let names: string[]
      try { names = await readdir(source.directory) } catch { continue }
      for (const name of names.sort()) {
        if (!name.endsWith('.log')) continue
        const path = join(source.directory, name)
        const info = await stat(path).catch(() => null)
        if (info?.isFile() && info.mtimeMs >= since) files.push({ name: `${source.folder}/${name}`, path, modified: info.mtime })
      }
    }
    // A zip without ZIP64 holds at most 65535 entries; the manifest takes one.
    for (const file of files.slice(-65000)) {
      const data = await readFile(file.path).catch(() => null)
      if (!data) continue
      await add(file.name, data, file.modified)
      fileCount += 1
      bytes += data.length
    }
    const manifest = { app: app.getName(), version: app.getVersion(), electron: process.versions.electron,
      os: platform(), osRelease: release(), arch: arch(), exportedAt: new Date(now).toISOString(),
      days: LOG_EXPORT_DAYS, fileCount, bytes }
    await add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), new Date(now))
    const directory = Buffer.concat(entries.map(centralHeader))
    await handle.write(directory)
    await handle.write(endOfDirectory(entries.length, directory.length, offset))
  } finally {
    await handle.close()
  }
  return { fileCount, bytes }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/** Deflate, UTF-8 names (flag bit 11); no ZIP64, so each file and the archive stay under 4 GiB. */
function localHeader(entry: ZipEntry): Buffer {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x0800, 6)
  header.writeUInt16LE(8, 8)
  header.writeUInt16LE(entry.dosTime, 10)
  header.writeUInt16LE(entry.dosDate, 12)
  header.writeUInt32LE(entry.crc, 14)
  header.writeUInt32LE(entry.compressedSize, 18)
  header.writeUInt32LE(entry.size, 22)
  header.writeUInt16LE(entry.name.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, entry.name])
}

function centralHeader(entry: ZipEntry): Buffer {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x0800, 8)
  header.writeUInt16LE(8, 10)
  header.writeUInt16LE(entry.dosTime, 12)
  header.writeUInt16LE(entry.dosDate, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compressedSize, 20)
  header.writeUInt32LE(entry.size, 24)
  header.writeUInt16LE(entry.name.length, 28)
  // Extra, comment, disk number, internal and external attributes stay zero.
  header.writeUInt32LE(entry.offset, 42)
  return Buffer.concat([header, entry.name])
}

function endOfDirectory(count: number, size: number, offset: number): Buffer {
  const record = Buffer.alloc(22)
  record.writeUInt32LE(0x06054b50, 0)
  record.writeUInt16LE(count, 8)
  record.writeUInt16LE(count, 10)
  record.writeUInt32LE(size, 12)
  record.writeUInt32LE(offset, 16)
  return record
}
