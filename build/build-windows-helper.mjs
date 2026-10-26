// Build only. This script never launches Electron or the helper and never restores from the network.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32' && process.arch === 'x64') {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const project = join(root, 'native/computer-use/windows/Web2Term.WindowsHelper.csproj')
  const feed = join(root, 'out/windows-helper-offline-feed')
  mkdirSync(feed, { recursive: true })
  const run = args => {
    const result = spawnSync('dotnet', args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1' } })
    if (result.error || result.status !== 0) {
      console.error('Windows helper 编译失败；需要本机 .NET 8 或更高版本 SDK 及 .NET 8 引用/宿主包。构建不会联网下载依赖。')
      process.exit(result.status || 1)
    }
  }
  // An explicit empty local feed excludes user/global network sources. Windows SDK/WinRT
  // targeting dependencies must already be present in the local NuGet cache.
  run(['restore', project, '--source', feed, '--ignore-failed-sources', '-p:NuGetAudit=false', '--verbosity', 'minimal'])
  run(['build', project, '--configuration', 'Release', '--no-restore', '--output', join(root, 'out/windows-helper'), '--verbosity', 'minimal'])
}
