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
  if (platform === 'win32') {
    // No process launch: verify the native addons and their worker scripts really escaped app.asar.
    const pty = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
    for (const file of [`prebuilds/win32-${arch}/conpty.node`, `prebuilds/win32-${arch}/conpty_console_list.node`,
      'lib/windowsTerminal.js', 'lib/conpty_console_list_agent.js', 'lib/worker/conoutSocketWorker.js']) {
      if (!readFileSync(join(pty, file)).length) throw new Error(`Packaged PowerShell terminal resource missing: ${file}`)
    }
    const sound = readFileSync(join(resources, 'notification-wood-drop.wav'))
    const source = readFileSync(join(__dirname, 'notification-wood-drop.wav'))
    if (!sound.equals(source)) throw new Error('Packaged notification sound is missing or corrupt.')
  }
  await verifyWindowsHelper(context)
}
