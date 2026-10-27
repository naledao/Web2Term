// electron-builder afterPack hook. A Windows installer without a complete self-contained helper would
// silently ship computer use as unavailable, so fail the package instead. Other platforms are untouched.
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

module.exports = async function verifyWindowsHelperPackage(context) {
  if (context.electronPlatformName !== 'win32') return
  const { selfContainedProblems } = await import(pathToFileURL(join(__dirname, 'windows-helper-common.mjs')).href)
  const problems = selfContainedProblems(join(context.appOutDir, 'resources', 'windows-helper'))
  if (problems.length) throw new Error(`Windows 安装包中的 helper 资源不完整（请先运行 npm run helper:publish）：${problems.join('；')}`)
}
