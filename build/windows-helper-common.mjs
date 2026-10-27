// Shared by the helper build, restore and publish scripts. Nothing here launches Electron or the helper.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const project = join(root, 'native/computer-use/windows/Web2Term.WindowsHelper.csproj')
export const supportedHost = process.platform === 'win32' && process.arch === 'x64'
/** Read by the main process before spawning; the handshake stays the authoritative check. */
export const MANIFEST_NAME = 'web2term-helper.json'
export const EXECUTABLE_NAME = 'Web2Term.WindowsHelper.exe'
export const PACKAGE_OUTPUT = join(root, 'out/windows-helper-package')
export const NUGET_ORG = 'https://api.nuget.org/v3/index.json'
/*
 * The self-contained flavour restores into its own obj/bin so it never shares project.assets.json or
 * incremental outputs with the framework-dependent `npm run build` flavour. Restore and publish must
 * pass exactly these properties, otherwise `--no-restore` would compile against a different graph.
 */
export const PACKAGE_PROPERTIES = ['-p:SelfContained=true', '-p:BaseIntermediateOutputPath=obj/package/',
  '-p:BaseOutputPath=bin/package/', '-p:NuGetAudit=false']

/** Fails the build when the TypeScript and C# private protocol constants disagree. */
export function protocolVersion() {
  const read = (file, pattern) => {
    const match = readFileSync(join(root, file), 'utf8').match(pattern)
    if (!match) fail(`无法从 ${file} 读取 Windows helper 协议版本。`)
    return Number(match[1])
  }
  const main = read('src/shared/windows-helper.ts', /WINDOWS_HELPER_PROTOCOL_VERSION\s*=\s*(\d+)/)
  const helper = read('native/computer-use/windows/Protocol.cs', /const\s+int\s+Version\s*=\s*(\d+)/)
  if (main !== helper) fail(`Windows helper 协议版本不一致：主进程 v${main}，helper v${helper}。请同时更新两侧后再构建。`)
  return main
}

export function writeManifest(directory, selfContained) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  writeFileSync(join(directory, MANIFEST_NAME), JSON.stringify({ protocolVersion: protocolVersion(), arch: 'x64', selfContained, appVersion: version }, null, 2) + '\n')
}

/**
 * Problems that would make an installed helper unusable without a separate .NET install, or rejected by
 * the main process. Empty means the directory is a complete self-contained helper for this protocol.
 */
export function selfContainedProblems(directory) {
  const problems = []
  const readJson = name => {
    try { return JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch { problems.push(`缺少或无法读取 ${name}`); return null }
  }
  for (const name of [EXECUTABLE_NAME, 'hostfxr.dll', 'hostpolicy.dll', 'coreclr.dll', 'Microsoft.Windows.SDK.NET.dll', 'WinRT.Runtime.dll']) {
    if (!existsSync(join(directory, name))) problems.push(`缺少 ${name}`)
  }
  const options = readJson('Web2Term.WindowsHelper.runtimeconfig.json')?.runtimeOptions
  if (options && (!Array.isArray(options.includedFrameworks) || options.framework || options.frameworks)) problems.push('helper 不是自包含发布，仍依赖本机 .NET 运行时')
  const manifest = readJson(MANIFEST_NAME)
  if (manifest && (manifest.protocolVersion !== protocolVersion() || manifest.arch !== 'x64' || manifest.selfContained !== true)) problems.push(`${MANIFEST_NAME} 与当前协议或自包含要求不符`)
  return problems
}

/** An empty local feed: restore may only resolve packages already in the local NuGet cache. */
export function offlineFeed() {
  const feed = join(root, 'out/windows-helper-offline-feed')
  mkdirSync(feed, { recursive: true })
  return feed
}

export function dotnet(args, failure) {
  const result = spawnSync('dotnet', args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1' } })
  if (result.error || result.status !== 0) fail(failure, result.status || 1)
}

export function fail(message, status = 1) {
  console.error(message)
  process.exit(status)
}
