# 内置 ripgrep 与搜索提示词

软件通过固定版本的 `@vscode/ripgrep-universal` 开发依赖准备各目标的二进制。
`npm run dev` 和 `npm run build` 会在本地执行 `ripgrep:prepare`，只复制依赖中的文件，
不下载、不执行二进制。安装包通过 `extraResources` 只包含目标系统/架构的一个 `rg`
和许可文件，位于 `resources/ripgrep/`，不会把全平台 npm 包或暂存目录放进 app.asar。

打包后的 `afterPack` 检查目标元数据、SHA256 和许可证，然后继续原有的 Windows helper 检查。
macOS 检查发生在签名之前。开发环境从 `out/ripgrep/<系统>-<架构>/` 读取资源。
更新依赖时需同步检查上游 ripgrep、PCRE2 的许可文件；它们保存在 `build/ripgrep-licenses/`。
来源分别为 https://github.com/BurntSushi/ripgrep/blob/master/LICENSE-MIT 和
https://github.com/PCRE2Project/pcre2/blob/main/LICENCE.md。

本机终端启动时只修改子进程 PATH，保留原路径，不改系统/用户 PATH 或 shell 配置。
PowerShell 的注册路径刷新保留内置目录；POSIX 登录 shell 读取配置之后再次加入内置目录。
所有本机 ConversationShell（主终端、额外终端、重开和后台任务控制终端）共用该入口，
后台子进程继承启动终端的 PATH。

环境报告新增 `ripgrep`（Windows JSON）或 `RG`（POSIX），值为 `available`/`missing`。
探测失败、旧报告未包含该字段时为 `unknown`。SSH/设备探测的是远端自身的命令环境，
不会使用桌面的资源状态，也不会自动往远端安装软件。

基础系统提示词新增独立的【文件定位与内容搜索】段：优先 `rg --files` 和 `rg -n -F`，
只保留可用状态、常用命令和搜索范围；未安装时只发系统搜索的替代说明，不注入 rg 用法。
退出码统一放在【读取结果】，不在搜索段重复。现有对话在下个任务开始时沿用分段增量注入。
搜索规则不依赖工具目录开关或 `read_tool_prompt`。

保留真实退出码：`rg` 的 0 是命中，1 是未命中，2 是错误。基础【读取结果】明确指出
即使通用命令记录将退出码 1 标为失败，也应按 `rg` 的未命中解释；不更改其他命令的退出码语义。

## 用户验收

智能体只构建，不执行以下测试。由用户运行：

```powershell
npm run test:ripgrep
```

该测试仅使用临时文件和本机子 shell，不启动 Electron、不访问真实会话或网络。
覆盖资源目标隔离、PATH 大小写与驱动器根目录、中文空格安装路径、PowerShell/POSIX
探测、持续终端的真实 0/1/2 退出码、第二终端、许可与哈希、旧对话增量更新。
macOS 另运行 `npm run test:mac`。

真实应用只通过 `npm run dev` 由用户启动。检查新建/重开/额外终端和后台任务能运行
`rg --version`；在系统提示词预览中核对搜索段；切换到无 rg 的 SSH/设备后核对状态改变。
安装包仍需在 Windows x64 和 macOS ARM64 环境验收。交付状态为构建通过、等待测试。
