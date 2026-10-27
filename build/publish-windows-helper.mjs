// Packaging flavour: self-contained win-x64 publish, so installed users need no separate .NET runtime.
// Offline like `npm run build`: dependencies come from `npm run helper:restore`. Never launches the helper.
import { rmSync } from 'node:fs'
import { PACKAGE_OUTPUT, PACKAGE_PROPERTIES, dotnet, fail, offlineFeed, project, protocolVersion, selfContainedProblems, supportedHost, writeManifest } from './windows-helper-common.mjs'

if (supportedHost) {
  protocolVersion()
  const failure = 'Windows helper 自包含发布失败；发布不会联网下载依赖，请先运行 npm run helper:restore 准备 .NET 运行时包。'
  // Stale files from an earlier publish must not ride along into the installer.
  rmSync(PACKAGE_OUTPUT, { recursive: true, force: true })
  dotnet(['restore', project, '--source', offlineFeed(), '--ignore-failed-sources', ...PACKAGE_PROPERTIES, '--verbosity', 'minimal'], failure)
  dotnet(['publish', project, '--configuration', 'Release', '--no-restore', '--output', PACKAGE_OUTPUT, ...PACKAGE_PROPERTIES, '--verbosity', 'minimal'], failure)
  writeManifest(PACKAGE_OUTPUT, true)
  const problems = selfContainedProblems(PACKAGE_OUTPUT)
  if (problems.length) fail(`Windows helper 自包含发布不完整：${problems.join('；')}`)
} else {
  console.log('非 Windows x64 主机：跳过 Windows helper 发布；本平台安装包不包含 helper。')
}
