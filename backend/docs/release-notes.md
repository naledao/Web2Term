# Web2Term 版本更新说明 API

版本更新说明已合并到 Web2Term Go 后端，与邮箱登录、设备管理和 WebSocket 共用 HTTP 监听、进程、SQLite 文件与连接池。
默认基础地址为 `http://127.0.0.1:10088`，服务端保存版本更新 HTML 及按机器 ID 区分的已读状态。

## 配置与部署

构建、启动和 SSH 部署统一遵循 [后端说明](../README.md)，无需额外启动一个服务或部署第二个二进制。
数据使用后端的 `WEB2TERM_DB_PATH`，默认 `data/web2term.db`；启动时在事务内执行嵌入的数据库迁移。
管理令牌为空时，全部管理接口返回 `503 ADMIN_DISABLED`；读取和已读接口仍可使用。
管理令牌独立于普通用户的登录 JWT，只有持有管理令牌的调用方才能维护说明。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WEB2TERM_ADDR` | `:10088` | 后端统一 HTTP / WebSocket 监听地址 |
| `WEB2TERM_DB_PATH` | `data/web2term.db` | 后端统一 SQLite 文件位置，相对路径按工作目录解析 |
| `RELEASE_NOTES_ADMIN_TOKEN` | 空 | 管理接口的 Bearer 令牌；空值禁用管理接口 |

旧的独立监听地址、数据库变量和命令行参数不再使用。线上配置写入 `/etc/web2term-backend/backend.env`，修改后由使用者重启 `web2term-backend.service`。
后端的现有 GitHub 构建和 SSH 部署流程会一并包含本模块，不需要新增 workflow。
SQLite 使用 WAL、外键约束和 5000 毫秒 busy timeout；连接池与账号、设备操作共用，上限为 1。

## 客户端接口

客户端接口无需管理令牌。机器 ID 仅用来区分阅读状态，使用客户端本地持久保存的 `localMachineId`，请求中的 UUID 会统一为小写。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | 后端统一 HTTP 存活检查 |
| `GET` | `/api/v1/release-notes?machineId=UUID&limit=20&offset=0` | 分页获取可展示的版本及当前机器的已读状态 |
| `GET` | `/api/v1/release-notes/{id}?machineId=UUID` | 获取单个版本的 HTML 正文和阅读状态 |
| `POST` | `/api/v1/release-notes/{id}/read` | 将某个版本登记为当前机器已读 |

`limit` 为 1～100，默认 20；`offset` 为 0～1000000，默认 0。
只公开 `status = 1` 且已到发布时间的说明，按发布时间及 ID 倒序排列。
未发布、已下线、未到发布时间及不存在的说明，在正文和已读接口中均返回 404。

列表响应不包含 HTML，`unreadCount` 是当前机器对全部可展示版本的未读总数，不受当前分页影响：

```json
{
  "items": [
    {
      "id": 1,
      "version": "0.1.189",
      "title": "Web2Term 0.1.189 更新说明",
      "publishedAt": 1793145600000,
      "isRead": false,
      "readAt": null
    }
  ],
  "total": 1,
  "unreadCount": 1,
  "limit": 20,
  "offset": 0
}
```

正文接口在上面单条记录的字段之外增加 `contentHtml`，类型为字符串。服务保留保存的 HTML 内容，直接以 JSON 字段返回。
GET 列表和正文都不会自动登记已读。建议客户端成功展示某个版本后再提交：

```http
POST /api/v1/release-notes/1/read
Content-Type: application/json

{"machineId":"f15f800e-0123-4123-8123-123456789abc"}
```

```json
{
  "id": 1,
  "machineId": "f15f800e-0123-4123-8123-123456789abc",
  "isRead": true,
  "readAt": 1793145600000
}
```

重复提交只更新最近阅读时间；并发请求不会创建重复阅读记录，也不会将阅读时间倒退。

## 管理接口

全部请求需要 `Authorization: Bearer <RELEASE_NOTES_ADMIN_TOKEN>`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/release-notes?limit=20&offset=0` | 列出全部发布状态的记录，列表不包含正文 |
| `POST` | `/api/v1/admin/release-notes` | 新增更新说明 |
| `GET` | `/api/v1/admin/release-notes/{id}` | 获取完整维护记录 |
| `PUT` | `/api/v1/admin/release-notes/{id}` | 完整替换版本、标题、HTML、状态和发布时间 |
| `DELETE` | `/api/v1/admin/release-notes/{id}` | 物理删除说明及其阅读记录 |

创建或更新的请求体：

```json
{
  "version": "0.1.189",
  "title": "Web2Term 0.1.189 更新说明",
  "contentHtml": "<article><h3>新增</h3><ul><li>具体内容</li></ul></article>",
  "status": 1,
  "publishedAt": null
}
```

- `version` 唯一，最多 32 个 ASCII 字符，支持 `0.1.189`、预发布及构建后缀，输入前缀 `v` 会被移除。
- `title` 去除首尾空白后必须是 1～200 个字符。
- `contentHtml` 最多 1 MiB；草稿可以为空，发布时必须非空。新增、修复、优化的内容与排版都写在 HTML 内。
- `status` 每次创建、替换都必须指定：`0` 草稿、`1` 已发布、`2` 已下线。
- `publishedAt` 是非负 Unix 毫秒时间戳。创建已发布记录时留空会使用当前服务端时间；编辑已发布记录时留空会保留原发布时间，原来没有时间则使用当前时间。设为未来时间可预约展示。
- `PUT` 是完整替换请求，需提交完整正文；设置 `status = 2` 即下线，下线保留阅读记录。
- 修改同一说明的 HTML 保留已有阅读状态；新增版本获得新 ID，对所有机器未读。
- `createdAt`、`updatedAt`、`readAt` 由服务端生成。所有时间均为 Unix 毫秒。
- JSON 请求禁止未知字段及多个顶层值；管理请求体上限为 8 MiB，以容纳 HTML 的 JSON 转义；已读请求体上限为 1 KiB。

新增返回 HTTP 201，附带管理详情的 `Location`；更新返回 200，删除返回 204。
版本号冲突返回 409，未提供或错误的管理令牌返回 401。

用户可在 `backend` 目录编辑 `examples/release-note.json` 后发布：

```powershell
$headers = @{ Authorization = "Bearer $env:RELEASE_NOTES_ADMIN_TOKEN" }
$body = Get-Content -LiteralPath ./examples/release-note.json -Raw -Encoding utf8
Invoke-RestMethod -Uri http://127.0.0.1:10088/api/v1/admin/release-notes -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

接口错误使用下列结构，服务端异常详情仅记录在日志中：

```json
{"error":{"code":"VERSION_EXISTS","message":"该版本的更新说明已存在。"}}
```

## 数据结构与迁移

需要由 Codex 管理更新说明时，可使用仓库内的 [更新说明管理 MCP](../mcp/README.md)。它封装上述管理接口，令牌保存在仓库外的私密 JSON 配置中。

建表 SQL 位于后端的 `internal/store/release_notes_schema.sql`，通过 `go:embed` 编入程序。
后端数据库版本从 `2` 升级到 `3` 时，在同一事务中添加这两张表；已有账号、验证码和设备记录不改写。
新数据库会按顺序初始化设备、账号和更新说明结构。遇到更高版本或升级错误时拒绝启动，升级失败会回滚事务。

| 表 | 内容 |
| --- | --- |
| `app_release_note` | 版本号、标题、HTML 正文、草稿／发布／下线状态及时间 |
| `app_release_note_read` | `(machine_id, release_note_id)` 联合主键、最近阅读时间 |

无阅读记录即未读，有记录即已读。机器 ID 不关联账号和当前连接的 SSH／远程设备。
客户端清空本地应用数据而重新生成 UUID 后，按新机器计算阅读状态。
数据库文件、WAL 文件、构建产物和本地环境文件已加入忽略规则。

如果以前已经运行过独立版本并在其他位置保存了 `release-notes.db`，先备份，再把 `app_release_note` 和 `app_release_note_read` 的数据导入后端对应表，保留说明 ID 及阅读关联。不要直接用旧独立数据库文件替换后端数据库；它的版本号和账号/设备结构与后端不同。本次代码合并不连接或改写其他位置的历史数据库。

## 测试分工

按仓库约定，测试由用户在 `backend` 目录运行，智能体只执行构建、静态检查和读取输出。
用例通过临时 SQLite 文件和 `httptest` 请求覆盖发布可见性、机器阅读隔离、重复登记、HTML 保留、接口鉴权、数据持久化、外键级联和输入边界，不依赖真实第三方网站。

```powershell
go test ./...
```

交付状态为构建通过、等待用户测试；构建不会启动 HTTP 服务，也不代表接口已通过运行测试。
