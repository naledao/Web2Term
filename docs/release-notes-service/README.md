# Go 后端版本更新说明模块设计

版本更新说明已合并到 [`backend`](../../backend/README.md)，与登录、设备和 WebSocket 使用同一个 Go 进程及 `10088` 端口。
实际建表 SQL 为 [`release_notes_schema.sql`](../../backend/internal/store/release_notes_schema.sql)，由后端数据库升级到版本 `3` 时自动迁移。
接口、发布 HTML 及测试说明见 [更新说明 API](../../backend/docs/release-notes.md)；标题栏按钮接入见 [客户端更新说明](../client-release-notes.md)。

## 数据归属

- Go 服务通过 HTTP API 对桌面客户端提供更新说明和阅读状态。
- SQLite 使用后端统一的 `WEB2TERM_DB_PATH`（默认 `data/web2term.db`）；发布数据、阅读记录、账号和设备共用这个服务端文件。
- 客户端通过 API 访问，由 Go 服务读写 SQLite。
- `machine_id` 沿用客户端持久保存的 `localMachineId`，由服务校验并统一为小写 UUID。
- 此 ID 标识客户端的本地应用数据实例；清空应用数据生成新 ID 后，会按新机器计算阅读状态。

## 表与规则

- `app_release_note`：每个版本一条记录，版本号唯一，统一不带 `v` 前缀；`content_html` 直接保存完整 HTML 内容。
- `app_release_note_read`：使用 `(machine_id, release_note_id)` 联合主键。有记录表示已读，无记录表示未读。
- 草稿为 `status = 0`，发布为 `1`，下线为 `2`。仅展示已发布且 `published_at` 不晚于服务端当前时间的说明。
- `published_at`、`created_at`、`updated_at`、`read_at` 都使用 UTC Unix 毫秒时间戳，由 Go 服务生成。草稿的 `published_at` 可以为空。
- `updated_at` 需在 Go 的更新语句中显式赋值，不依赖 SQLite 自动更新。
- 建议在具体版本的 HTML 成功展示后调用已读接口；读取列表或正文接口本身不登记已读。
- 修改同一条说明的 HTML 保留原阅读状态；新增版本使用新的说明 ID，自然对所有机器未读。
- 物理删除说明时，通过外键级联删除对应阅读记录；下线说明会保留阅读记录。

## 查询示例

列表不携带 HTML 正文，避免每次加载版本列表都传输全部内容。参数依次为本机 UUID、服务端当前毫秒时间、分页条数、偏移量。

```sql
SELECT n.id, n.version, n.title, n.published_at,
       CASE WHEN r.release_note_id IS NULL THEN 0 ELSE 1 END AS is_read,
       r.read_at
FROM app_release_note AS n
LEFT JOIN app_release_note_read AS r
       ON r.release_note_id = n.id AND r.machine_id = ?
WHERE n.status = 1 AND n.published_at <= ?
ORDER BY n.published_at DESC, n.id DESC
LIMIT ? OFFSET ?;
```

查看某个版本时读取 HTML 正文，参数依次为说明 ID、服务端当前毫秒时间。

```sql
SELECT id, version, title, content_html, published_at
FROM app_release_note
WHERE id = ? AND status = 1 AND published_at <= ?;
```

登记已读时只接受当前可展示的说明。重复调用更新阅读时间，不产生重复记录。参数依次为本机 UUID、阅读时间、说明 ID、服务端当前毫秒时间；两个时间使用同一次服务端取值。

```sql
INSERT INTO app_release_note_read (machine_id, release_note_id, read_at)
SELECT ?, n.id, ?
FROM app_release_note AS n
WHERE n.id = ? AND n.status = 1 AND n.published_at <= ?
ON CONFLICT (machine_id, release_note_id)
DO UPDATE SET read_at = MAX(app_release_note_read.read_at, excluded.read_at);
```

## 服务连接设置

初始化数据库时启用 WAL。每个数据库连接都启用外键约束和 5000 毫秒的 busy timeout。
Go 若使用 `database/sql` 连接池，应通过所选 SQLite 驱动的连接配置或连接初始化机制应用这些设置。
当前实现已将连接池限制为一个连接，写操作保持短事务。
实际迁移 SQL 不包含连接设置和事务边界，由 Go 的存储层统一配置连接并开启迁移事务，失败时回滚。
迁移版本由后端统一的 `PRAGMA user_version` 保存，后续结构变化通过单独的版本化迁移处理，不再维护独立服务的数据库版本。
