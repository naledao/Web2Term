import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { editWindowsDevelopmentExecutable } from './windows-executable-resources.mjs'
import { APP_DEVELOPMENT_NAME } from '../src/shared/app-identity'

const SCHEMA = 1
const runtimeFiles = ['electron.exe', 'icudtl.dat', 'resources/default_app.asar', 'version']
interface RuntimeCache { fingerprint: string; directory: string; executableBytes: number }
interface RuntimeOptions { sourceDirectory: string; cacheDirectory: string; iconPath: string; log?: (text: string) => void }

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Edit only PE resources; preserve Electron's versions, manifest and electron.exe basename. */
export function brandWindowsDevelopmentExecutable(executable: Buffer, icon: Buffer): Buffer {
  return editWindowsDevelopmentExecutable(executable, icon, APP_DEVELOPMENT_NAME)
}

/** Prepare files only. electron-vite remains the sole owner of launching/restarting Electron. */
export async function prepareWindowsDevelopmentRuntime(options: RuntimeOptions): Promise<string> {
  await mkdir(options.cacheDirectory, { recursive: true })
  const source = await realpath(options.sourceDirectory), cache = await realpath(options.cacheDirectory)
  if (!relative(source, cache) || inside(source, cache) || inside(cache, source)) {
    throw new Error('The development runtime cache must be separate from its source distribution')
  }
  const [executable, icon, version] = await Promise.all([
    readFile(join(source, 'electron.exe')), readFile(options.iconPath), readFile(join(source, 'version'), 'utf8')
  ])
  const fingerprint = createHash('sha256').update(JSON.stringify([SCHEMA, APP_DEVELOPMENT_NAME, version.trim()]))
    .update(executable).update(icon).digest('hex')
  const indexPath = join(cache, `${fingerprint}.json`)
  try {
    const saved = JSON.parse(await readFile(indexPath, 'utf8')) as RuntimeCache
    if (saved.fingerprint === fingerprint && /^[a-f0-9]{24}-[a-f0-9-]{36}$/.test(saved.directory)
      && Number.isSafeInteger(saved.executableBytes) && saved.executableBytes > 0) {
      const directory = join(cache, saved.directory)
      const files = await Promise.all(runtimeFiles.map(file => stat(join(directory, file))))
      if (files.every(file => file.isFile()) && files[0].size === saved.executableBytes) return join(directory, 'electron.exe')
    }
  } catch { /* Missing or incomplete caches are rebuilt into a new immutable directory. */ }

  const staging = await mkdtemp(join(cache, '.preparing-'))
  let published = false
  let temporaryIndex: string | undefined
  try {
    await cp(source, staging, { recursive: true })
    const branded = brandWindowsDevelopmentExecutable(executable, icon)
    await writeFile(join(staging, 'electron.exe'), branded)
    await Promise.all(runtimeFiles.map(file => stat(join(staging, file))))
    const directory = `${fingerprint.slice(0, 24)}-${randomUUID()}`
    const destination = join(cache, directory)
    if (!inside(cache, staging) || !inside(cache, destination)) throw new Error('Invalid development runtime cache path')
    await rename(staging, destination)
    published = true
    temporaryIndex = join(cache, `.index-${randomUUID()}.json`)
    await writeFile(temporaryIndex, JSON.stringify({ fingerprint, directory, executableBytes: branded.length } satisfies RuntimeCache))
    await rename(temporaryIndex, indexPath)
    options.log?.(`[dev-runtime] Prepared ${APP_DEVELOPMENT_NAME}, Electron ${version.trim()}`)
    return join(destination, 'electron.exe')
  } finally {
    if (temporaryIndex && inside(cache, temporaryIndex) && basename(temporaryIndex).startsWith('.index-')) {
      await rm(temporaryIndex, { force: true })
    }
    // Only this invocation's unpublished staging folder may be removed. Existing
    // cached runtimes may still be in use by another developer window.
    if (!published && inside(cache, staging) && basename(staging).startsWith('.preparing-')) {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

export async function configureWindowsDevelopmentRuntime(command: string, root: string,
  electronExecutable: () => string, env = process.env, platform = process.platform): Promise<void> {
  if (command !== 'serve' || platform !== 'win32') return
  const sourceExecutable = env.WEB2TERM_DEV_ELECTRON_SOURCE || env.ELECTRON_EXEC_PATH || electronExecutable()
  if (basename(sourceExecutable).toLowerCase() !== 'electron.exe') {
    throw new Error('The Windows development runtime must retain the electron.exe filename')
  }
  env.WEB2TERM_DEV_ELECTRON_SOURCE = sourceExecutable
  env.ELECTRON_EXEC_PATH = await prepareWindowsDevelopmentRuntime({
    sourceDirectory: resolve(sourceExecutable, '..'), cacheDirectory: resolve(root, '.cache', 'windows-dev-runtime'),
    iconPath: resolve(root, 'build', 'icon.ico'), log: console.info
  })
  console.info(`[dev-runtime] Executable: ${env.ELECTRON_EXEC_PATH}`)
}
