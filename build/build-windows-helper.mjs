// Build only. This script never launches Electron or the helper and never restores from the network.
// Development flavour: framework-dependent, uses the developer's .NET 8 runtime. Installers use publish-windows-helper.mjs.
import { join } from 'node:path'
import { dotnet, offlineFeed, project, protocolVersion, root, supportedHost, writeManifest } from './windows-helper-common.mjs'

if (supportedHost) {
  protocolVersion()
  const output = join(root, 'out/windows-helper')
  const failure = 'Windows helper 编译失败；需要本机 .NET 8 或更高版本 SDK 及 .NET 8 引用/宿主包。构建不会联网下载依赖，缺少依赖时先运行 npm run helper:restore。'
  // An explicit empty local feed excludes user/global network sources. Windows SDK/WinRT
  // targeting dependencies must already be present in the local NuGet cache.
  dotnet(['restore', project, '--source', offlineFeed(), '--ignore-failed-sources', '-p:NuGetAudit=false', '--verbosity', 'minimal'], failure)
  dotnet(['build', project, '--configuration', 'Release', '--no-restore', '--output', output, '--verbosity', 'minimal'], failure)
  writeManifest(output, false)
}
