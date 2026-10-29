// Runs before signing. Check copied bytes/target metadata without launching any program.
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { Arch } = require('builder-util')
const verifyWindowsHelper = require('./verify-windows-helper-package.cjs')

module.exports = async function verifyPackageResources(context) {
  const platform = context.electronPlatformName
  const arch = Arch[context.arch] === 'armv7l' ? 'arm' : Arch[context.arch]
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const directory = join(resources, 'ripgrep')
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const binary = readFileSync(join(directory, platform === 'win32' ? 'rg.exe' : 'rg'))
  const sha256 = createHash('sha256').update(binary).digest('hex')
  if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch || manifest.sha256 !== sha256) {
    throw new Error(`Packaged ripgrep is missing, corrupt or for another target (${platform}-${arch}); run npm run ripgrep:prepare.`)
  }
  for (const license of ['LICENSE-vscode-ripgrep.txt', 'LICENSE-ripgrep.txt', 'LICENSE-PCRE2.txt']) {
    if (!readFileSync(join(directory, license), 'utf8').trim()) throw new Error(`Missing ripgrep notice: ${license}`)
  }
  await verifyWindowsHelper(context)
}
