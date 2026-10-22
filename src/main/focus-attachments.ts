import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { PreparedAttachment } from './file-access'
import type { FocusAttachmentInput } from '../shared/focus-chat'
import { validFocusFiles } from '../shared/focus-chat'

/** Only caller-supplied bytes are staged; renderer paths are never read. */
export async function stageFocusAttachments(files: FocusAttachmentInput[]): Promise<{ attachments: PreparedAttachment[]; cleanup(): Promise<void> }> {
  if (!files.length || !validFocusFiles(files)) throw new Error('invalid-focus-files')
  const directory = await mkdtemp(join(tmpdir(), 'gpt-focus-files-'))
  const cleanup = async (): Promise<void> => {
    // Verify the exact generated target before a recursive removal on Windows.
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('gpt-focus-files-')) throw new Error('invalid-focus-temp-directory')
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const attachments: PreparedAttachment[] = []
    for (const [index, file] of files.entries()) {
      const bytes = Buffer.from(file.dataBase64, 'base64')
      if (bytes.length !== file.sizeBytes || bytes.toString('base64') !== file.dataBase64) throw new Error('invalid-focus-file-bytes')
      // Separate folders retain original names, including duplicates, without collisions.
      const folder = join(directory, String(index))
      await mkdir(folder)
      // Windows reserved characters are normalized only in the temporary copy.
      let fileName = file.fileName.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/g, '') || 'attachment'
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) fileName = '_' + fileName
      const path = join(folder, fileName)
      if (dirname(resolve(path)) !== resolve(folder)) throw new Error('invalid-focus-file-name')
      await writeFile(path, bytes, { flag: 'wx' })
      attachments.push({ path, fileName, mimeType: file.mimeType, sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    return { attachments, cleanup }
  } catch (error) { await cleanup().catch(() => {}); throw error }
}
