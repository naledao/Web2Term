# Web2Term 管理接口：用户、概览与机器

管理员就是 `user_account.role = 'ADMIN'` 的普通登录账号，用自己的登录 JWT 调用（`Authorization: Bearer <token>`）。
未登录或凭据失效返回 `401`，普通账号返回 `403 ADMIN_REQUIRED`。反馈管理接口见 [feedback.md](feedback.md)，更新说明管理见 [release-notes.md](release-notes.md)。

第一个管理员需要在服务器上手动设置：

```sql
UPDATE user_account SET role = 'ADMIN' WHERE email = 'admin@example.com';
```

## 数据库（schema 5）

- `user_account.last_login_at`：最后一次成功登录的 Unix 毫秒时间；升级前登录的账号为空，下次登录后才有值。
- `admin_audit_log`：管理员对账号的操作记录（操作人、目标账号、动作、改动前后的值、时间），不设外键，账号行即使被删也保留记录。

## 用户

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/users?q=&role=&enabled=&limit=20&offset=0` | 账号列表，按注册先后倒序 |
| `GET` | `/api/v1/admin/users/{publicId}` | 账号详情：设备、最近 5 条反馈、最近 20 条操作记录 |
| `PATCH` | `/api/v1/admin/users/{publicId}` | 修改 `enabled` 和／或 `role` |
| `POST` | `/api/v1/admin/users/{publicId}/revoke-sessions` | 让该账号所有登录失效 |

- 账号用 `publicId` 标识，内部数字 ID 和 `token_version` 不会出现在响应里。
- `q` 模糊匹配邮箱或昵称（也可以是完整的 `publicId`）；`role` 为 `USER` / `ADMIN`；`enabled` 为 `1` / `0`。
- 列表每项包含 `publicId`、`email`、`nickname`、`role`、`enabled`、`createdAt`、`updatedAt`、`lastLoginAt`、`deviceCount`、`feedbackCount`，时间均为 Unix 毫秒。
- 详情响应为 `{"user": {...列表字段, "devices": [...], "recentFeedback": [...], "audit": [...]}, "onlineDeviceIds": [...]}`，在线状态以当前 WebSocket 连接为准。
- `PATCH` 请求体如 `{"enabled": false}` 或 `{"role": "ADMIN"}`。**禁用账号会同时让它的所有登录失效**，重新启用后也必须重新登录。
- 保护规则（违反时返回 `409`）：
  - `SELF_CHANGE_FORBIDDEN`：不能禁用自己或取消自己的管理员身份；
  - `LAST_ADMIN`：不能禁用或降级最后一个启用中的管理员（在同一事务中检查）。
- `revoke-sessions` 让 `token_version` 加 1，返回 `{"user": {...}, "disconnectedConnections": n, "self": bool}`。
- 禁用和吊销都会立即断开该账号已连接的设备 WebSocket；之后的重连会因登录失效被拒绝。
- 每次修改和吊销都会写入 `admin_audit_log`。

## 概览

`GET /api/v1/admin/stats` 返回：

| 字段 | 内容 |
| --- | --- |
| `users` | `total`、`new7d`（近 7 天注册）、`active7d`（近 7 天登录，依赖 `last_login_at`）、`disabled`、`admins` |
| `feedback` | `pending`、`inProgress`、`new7d`、`total` |
| `releaseNotes` | `published`（已到发布时间）、`scheduled`（预约中）、`drafts`、`offline` |
| `machines` | `total`、`read7d`、`read30d`、`dailyNew`（近 30 天每日新增，北京时间）、`noteReach`（最近 10 条已发布说明的已读机器数） |
| `onlineDevices` | 当前连接到后端的设备数 |

## 机器

机器统计**只来自更新说明的已读记录**（`app_release_note_read`）：只包含打开过“版本更新说明”的客户端，不是全部安装量；机器 ID 是客户端本地生成的随机 UUID，不关联账号。

- `machines.total`：表中不同 `machine_id` 的数量；`read7d` / `read30d`：最近一次已读在该时间范围内的机器数。
- `dailyNew`：按每台机器**第一次**已读的日期（UTC+8）计数，固定返回 30 天，没有新增的日期计为 0。
- `GET /api/v1/admin/machines?q=&limit=20&offset=0`：按最近已读时间倒序列出机器，含 `firstReadAt`、`lastReadAt`、`readCount`（读过几条说明）和 `feedbackCount`（同一机器 ID 提交的反馈数）。`q` 只能包含十六进制字符和连字符，按机器 ID 片段匹配。
- 更新说明管理列表（`GET /api/v1/admin/release-notes`）每项增加 `readCount`，并在顶层返回 `machineCount`，用于计算覆盖率。
