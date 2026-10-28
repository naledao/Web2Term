# Web2Term 版本更新说明服务

独立的 Go HTTP 服务，使用服务端 SQLite 文件保存版本更新 HTML 及按机器 ID 区分的已读状态。
当前目录是独立 Go module，使用 Go 1.26+、标准库 `net/http` 和纯 Go 驱动 `modernc.org/sqlite`；构建无需 C 编译器。

## 启动

以下命令由用户在本目录运行。启动会创建数据目录和 SQLite 文件，并在事务内执行嵌入的数据库迁移。

```powershell
cd C:\codes\gpt-web-to-codex-terminal\services\release-notes
$env:RELEASE_NOTES_ADMIN_TOKEN = '替换为你自己生成的管理令牌'
go run ./cmd/server
```

默认监听 `127.0.0.1:8091`，数据库默认保存为工作目录下的 `data/release-notes.db`。
服务启动日志使用 JSON，按 Ctrl+C 会停止接收请求并关闭数据库。
管理令牌为空时，全部管理接口返回 `503 ADMIN_DISABLED`；读取和已读接口仍可使用。
`.env.example` 仅说明变量，程序不自动加载 `.env` 文件。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `RELEASE_NOTES_ADDR` | `127.0.0.1:8091` | HTTP 监听地址 |
| `RELEASE_NOTES_DB` | `./data/release-notes.db` | SQLite 文件位置，相对路径按工作目录解析 |
| `RELEASE_NOTES_ADMIN_TOKEN` | 空 | 管理接口的 Bearer 令牌；空值禁用管理接口 |

可使用 `-addr` 和 `-db` 覆盖对应环境变量。对外提供访问时，将监听地址改为所需地址，并通过 HTTPS 入口提供服务；客户端通过 HTTP API 访问，数据库文件保留在服务端。

```powershell
go run ./cmd/server -addr 0.0.0.0:8091 -db ./data/release-notes.db
```

## 构建

```powershell
$env:CGO_ENABLED = '0'
go build -o ./dist/release-notes.exe ./cmd/server
```

Linux amd64 交叉编译：

```powershell
$env:CGO_ENABLED = '0'
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
go build -o ./dist/release-notes-linux-amd64 ./cmd/server
Remove-Item Env:GOOS, Env:GOARCH
```

构建出的程序已包含 SQLite 驱动和初始建表 SQL，可与环境变量配置一起部署。
SQLite 使用 WAL、外键约束和 5000 毫秒 busy timeout，连接设置会应用到每个新连接；当前连接池上限为 1。
数据库迁移使用 `PRAGMA user_version`，初始版本为 1；遇到比程序更新的数据库版本会拒绝启动。

## 客户端接口

客户端接口无需管理令牌。机器 ID 仅用来区分阅读状态，使用客户端本地持久保存的 `localMachineId`，请求中的 UUID 会统一为小写。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | 检查服务及数据库连接 |
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

用户可编辑 `examples/release-note.json` 后发布：

```powershell
$headers = @{ Authorization = "Bearer $env:RELEASE_NOTES_ADMIN_TOKEN" }
$body = Get-Content -LiteralPath ./examples/release-note.json -Raw -Encoding utf8
Invoke-RestMethod -Uri http://127.0.0.1:8091/api/v1/admin/release-notes -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

接口错误使用下列结构，服务端异常详情仅记录在日志中：

```json
{"error":{"code":"VERSION_EXISTS","message":"该版本的更新说明已存在。"}}
```

## 数据结构与迁移

建表 SQL 位于 `internal/store/migrations/001_initial.sql`，通过 `go:embed` 编入程序，服务首次启动自动执行。
不要将早期设计稿单独执行到新服务数据库；迁移以本目录的实际代码为准。

| 表 | 内容 |
| --- | --- |
| `app_release_note` | 版本号、标题、HTML 正文、草稿／发布／下线状态及时间 |
| `app_release_note_read` | `(machine_id, release_note_id)` 联合主键、最近阅读时间 |

无阅读记录即未读，有记录即已读。机器 ID 不关联账号和当前连接的 SSH／远程设备。
客户端清空本地应用数据而重新生成 UUID 后，按新机器计算阅读状态。
数据库文件、WAL 文件、构建产物和本地环境文件已加入忽略规则。

## 测试分工

按仓库约定，测试由用户运行，智能体只编写测试和读取输出。
用例通过临时 SQLite 文件和 `httptest` 请求覆盖发布可见性、机器阅读隔离、重复登记、HTML 保留、接口鉴权、数据持久化、外键级联和输入边界，不依赖真实第三方网站。

```powershell
go test ./...
```

交付状态为构建通过、等待用户测试；构建不会启动 HTTP 服务，也不代表接口已通过运行测试。
