// The only helper script that uses the network: `npm run helper:restore`, run explicitly (CI does it
// before `npm run dist:win`). It fills the local NuGet cache; build and publish stay offline afterwards.
import { NUGET_ORG, PACKAGE_PROPERTIES, dotnet, fail, project, supportedHost } from './windows-helper-common.mjs'

if (!supportedHost) fail('Windows helper 依赖恢复仅支持 Windows x64；其他系统的构建与安装包不包含 helper。')
const failure = 'Windows helper 依赖恢复失败；请检查网络、代理和本机 .NET 8 或更高版本 SDK。'
// Development (framework-dependent) graph used by `npm run build`.
dotnet(['restore', project, '--source', NUGET_ORG, '-p:NuGetAudit=false', '--verbosity', 'minimal'], failure)
// Self-contained graph used by `npm run helper:publish`, including the .NET runtime pack.
dotnet(['restore', project, '--source', NUGET_ORG, ...PACKAGE_PROPERTIES, '--verbosity', 'minimal'], failure)
