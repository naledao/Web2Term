// Offline preparation only. npm ci supplies every target binary; no executables are run here.
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { binPathFor } from '@vscode/ripgrep-universal'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(require.resolve('@vscode/ripgrep-universal')))
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const platforms = { win32: 'win', darwin: 'mac', linux: 'linux' }

for (const target of await readdir(join(packageRoot, 'bin'))) {
  const [platform, arch] = target.split('-')
  if (!platforms[platform] || !arch) throw new Error(`Unsupported ripgrep target: ${target}`)
  const directory = join(projectRoot, 'out', 'ripgrep', `${platforms[platform]}-${arch === 'arm' ? 'armv7l' : arch}`)
  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg'
  const source = binPathFor({ os: platform, arch })
  const sha256 = createHash('sha256').update(await readFile(source)).digest('hex')
  await mkdir(directory, { recursive: true })
  await copyFile(source, join(directory, binaryName))
  if (platform !== 'win32') await chmod(join(directory, binaryName), 0o755)
  await copyFile(join(packageRoot, 'LICENSE'), join(directory, 'LICENSE-vscode-ripgrep.txt'))
  for (const name of await readdir(join(projectRoot, 'build', 'ripgrep-licenses'))) {
    await copyFile(join(projectRoot, 'build', 'ripgrep-licenses', name), join(directory, name))
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema: 1, platform, arch, packageVersion: version, sha256 }, null, 2) + '\n')
}
console.log(`Prepared bundled ripgrep (${version}) for desktop targets; no network or execution.`)
