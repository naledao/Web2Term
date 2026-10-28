# 更新说明管理 MCP

本地 stdio MCP，通过 HTTP 调用 Go 后端 `/api/v1/admin/release-notes`，供 Codex 管理更新说明。使用官方 `github.com/modelcontextprotocol/go-sdk`，不需要 Node、SQLite、独立数据库或新增服务端监听端口。Codex 启动 MCP 子进程；只有调用工具时才访问后端，连接和列举工具不发送后台请求。

## 当前机器上的接入

在仓库根目录用 PowerShell 构建：

```powershell
Set-Location C:\codes\gpt-web-to-codex-terminal\backend
go build -trimpath -ldflags='-s -w' -o bin/web2term-release-notes-mcp.exe ./cmd/release-notes-mcp
```

实际配置保存在仓库外：

```text
C:\Users\24196\.codex\mcp-configs\web2term-release-notes.json
```

该文件已填写当前后端地址与此前生成的独立管理令牌，仅当前 Windows 账号有访问权限。仓库中的 `config.example.json` 只有占位符。修改令牌时，服务器 `RELEASE_NOTES_ADMIN_TOKEN` 和这个 JSON 的 `adminToken` 必须一致；修改后让使用方重新连接 MCP。

把 `codex.example.toml` 的表合并到 `%USERPROFILE%\.codex\config.toml`，或由使用者运行下面的 Codex CLI 命令完成注册（二选一）：

```powershell
codex mcp add web2term-release-notes -- 'C:\codes\gpt-web-to-codex-terminal\backend\bin\web2term-release-notes-mcp.exe' --config 'C:\Users\24196\.codex\mcp-configs\web2term-release-notes.json'
```

重新打开使用该配置的 Codex 会话即可加载工具。Codex 的 TOML 仅包含程序和私密文件路径，令牌不进入命令行、工具参数或仓库。配置方式参见 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)。本实现提供接入片段，不自动改写全局 Codex 配置。

将 MCP 交给其他机器使用时，复制对应系统的可执行文件及私密 JSON，调整 `command` 和 `--config` 的绝对路径。Linux 可使用 `bin/web2term-release-notes-mcp-linux-amd64` 或 `-linux-arm64`；私密 JSON 必须 `chmod 600`。程序不依赖仓库工作目录。

## 私密 JSON 字段

结构见 `config.example.json`，不要把真实令牌填进这个示例文件。

| 字段 | 含义 |
| --- | --- |
| `baseUrl` | 后端根地址，例如 `http://38.49.42.56:10088`，不要附加 `/api/v1/admin/release-notes`；支持 HTTPS 和反向代理路径前缀，不接受 URL 内嵌凭据、查询参数及片段 |
| `adminToken` | 与服务器 `RELEASE_NOTES_ADMIN_TOKEN` 相同的固定令牌，32～4096 个可打印 ASCII 字符，不含空白；与用户登录 JWT 无关 |
| `timeoutSeconds` | 单次 HTTP 请求超时，默认 20 秒，可设 1～120 秒；如提高超时，应相应提高 Codex 的 `tool_timeout_sec`，修改类工具需要先读再写 |

当前地址使用 HTTP，Bearer 令牌随每次管理请求发送；使用 HTTPS 反向代理后，将 `baseUrl` 改为相应 HTTPS 地址即可。

## 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `release_notes_list` | `limit?`、`offset?` | 列举所有状态，默认 20 条，最多 100 条；不返回 HTML |
| `release_notes_get` | `id` | 读取完整说明，包括 HTML |
| `release_notes_create` | `version`、`title`、`contentHtml?`、`status?`、`publishedAt?` | 新建，默认草稿 |
| `release_notes_update` | `id` 及至少一个修改字段：`version?`、`title?`、`contentHtml?`、`status?`、`publishedAt?`、`clearPublishedAt?` | 读取后合并，只替换传入字段；草稿/下线记录可用 `clearPublishedAt=true` 清空时间 |
| `release_notes_publish` | `id`、`publishedAt?` | 发布，默认将发布时间改为当前时间；指定未来时间则预约展示 |
| `release_notes_unpublish` | `id` | 改为下线，保留正文、发布时间和阅读历史 |
| `release_notes_delete` | `id` | 永久删除说明及关联阅读记录 |

所有 `id` 使用十进制字符串（例如 `"42"`），避免 SQLite int64 ID 在 JSON 客户端中丢失精度。状态为 `0` 草稿、`1` 已发布、`2` 已下线。时间均为非负 Unix 毫秒时间戳。版本号唯一，标题 1～200 个字符，HTML 正文最多 1 MiB，发布时正文不能为空。

示例调用参数：

```json
{"version":"0.1.190","title":"Web2Term 0.1.190 更新说明","contentHtml":"<article><h3>优化</h3><ul><li>改进连接体验</li></ul></article>"}
```

以上传给 `release_notes_create`，返回草稿 ID 后，可用 `release_notes_get` 查看，再按用户发布要求调用 `release_notes_publish`：

```json
{"id":"42"}
```

可以直接对 Codex 说：“列出最近 20 条更新说明”“为 0.1.190 创建草稿”“把 ID 为 42 的说明标题改为……”“发布 ID 为 42 的更新说明”。Codex 无需知道或再次输入令牌。

## 行为与错误

工具同时返回结构化结果和 MCP 文本内容。只读/写入/删除行为使用 MCP annotations 标注；权限决策由接入方原有配置处理。

- 修改、发布和下线通过读取后调用后端完整 `PUT` 实现，保留未传入字段，但不支持并发条件更新。同一记录应避免多个管理端同时编辑。
- 不自动重试写请求。创建或修改超时后，先用列表/详情确认结果，防止重复创建或覆盖。
- 不跟随 HTTP 重定向；响应上限 8 MiB；错误只返回已知代码和固定说明，不透传响应正文、原始网络错误或令牌。后端返回内容中若含有当前令牌也会脱敏。
- `UNAUTHORIZED` 表示两端令牌不一致；`ADMIN_DISABLED` 表示后端没有启用管理令牌；404 也可能表示后端尚未部署本仓库中的更新说明模块。
- 启动时仅读取本地配置，不做真实接口探测。后端需先部署包含更新说明模块的版本；MCP 二进制本身不能为旧服务器补充接口。

## 构建与测试分工

源码入口是 `../cmd/release-notes-mcp`，协议与 HTTP 适配在 `../internal/releasenotesmcp`。仓库约定智能体只做构建和静态检查，测试由用户运行：

```powershell
Set-Location C:\codes\gpt-web-to-codex-terminal\backend
go test ./internal/releasenotesmcp
```

测试仅使用 `httptest` 本地模拟后端和 MCP 内存传输，覆盖工具发现、输入 schema、鉴权头、草稿默认值、读后合并、发布/下线/删除、ID 精度、错误脱敏及禁止重定向，不连接生产服务器。构建通过、等待测试不等于功能已验收。
