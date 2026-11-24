# Web2Term 意见反馈 API

意见反馈与登录、设备、版本更新说明共用同一个 Go 后端、HTTP 监听和 SQLite 文件（schema 4，表 `app_feedback`）。
两个接口都**必须登录**：请求头携带邮箱登录得到的 `Authorization: Bearer <accessToken>`，否则返回 `401 UNAUTHORIZED`。
每个账号只能看到自己提交的反馈。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/feedback` | 提交一条文字反馈 |
| `GET` | `/api/v1/feedback?limit=20&offset=0` | 分页查看当前账号自己的反馈，按提交时间倒序 |

## 提交

```http
POST /api/v1/feedback
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "machineId": "f15f800e-0123-4123-8123-123456789abc",
  "category": "bug",
  "content": "第一行\n第二行",
  "email": "",
  "appVersion": "0.1.242",
  "platform": "win32-x64"
}
```

| 字段 | 规则 |
| --- | --- |
| `category` | 必填，`bug` / `feature` / `improvement` / `other` |
| `content` | 必填，去掉首尾空白后 1～5000 个字符；保留换行和制表符，拒绝其他控制字符 |
| `email` | 选填联系邮箱，≤254 字符；留空时保存为账号的登录邮箱。桌面端不提供该输入，始终留空 |
| `machineId` | 选填，客户端本机 UUID，统一转为小写；只做排查用，不返回给客户端 |
| `appVersion` / `platform` | 选填，单行文本，分别 ≤32 / ≤64 字符 |

请求体上限 64 KB。成功返回 `201`，响应体与列表中的单条记录相同。

## 列表

`limit` 为 1～100，默认 20；`offset` 为 0～1000000，默认 0。

```json
{
  "items": [
    {
      "id": 1,
      "category": "bug",
      "content": "第一行\n第二行",
      "email": "user@example.com",
      "appVersion": "0.1.242",
      "platform": "win32-x64",
      "status": 0,
      "createdAt": 1793145600000,
      "updatedAt": 1793145600000
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

`status`：0 待处理、1 处理中、2 已解决、3 已关闭。内部备注 `admin_note` 和 `machine_id` 不会出现在任何客户端接口里。

## 限流与错误

- 每个账号 24 小时内最多 20 条，超出返回 `429 FEEDBACK_DAILY_LIMIT`。
- 同一 IP 10 分钟内最多 30 次提交，超出返回 `429 FEEDBACK_TOO_FREQUENT`。
- 参数错误返回 `400`，响应体为 `{"code": "...", "message": "..."}`，`code` 取值：
  `INVALID_FEEDBACK_CATEGORY`、`INVALID_FEEDBACK_CONTENT`、`INVALID_EMAIL`、`INVALID_MACHINE_ID`、`INVALID_CLIENT_INFO`、`INVALID_PAGINATION`。
- 账号被禁用返回 `403 USER_DISABLED`。

## 当前账号

`GET /api/user/me`（需要登录）返回当前账号的 `publicId`、`email`、`nickname`、`avatarUrl` 和 `role`。
客户端用它在不重新登录的情况下得知账号是否已被设为管理员。

## 管理接口

管理员就是 `user_account.role = 'ADMIN'` 的普通登录账号，使用自己的登录 token 调用；普通账号返回 `403 ADMIN_REQUIRED`，未登录返回 `401`。
这与更新说明的 `RELEASE_NOTES_ADMIN_TOKEN` 相互独立。第一个管理员需要在服务器上手动设置：

```sql
UPDATE user_account SET role = 'ADMIN' WHERE email = 'admin@example.com';
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/feedback?status=&category=&q=&limit=20&offset=0` | 全部用户的反馈，按提交时间倒序 |
| `GET` | `/api/v1/admin/feedback/{id}` | 单条反馈详情 |
| `PATCH` | `/api/v1/admin/feedback/{id}` | 修改处理状态和/或内部备注 |

- `status` 为 0～3，留空表示全部；`category` 同提交接口；`q` 最多 100 字，模糊匹配反馈内容、联系邮箱和提交账号的邮箱（`%`、`_` 按字面匹配）。
- 列表在用户接口字段之外增加 `machineId`、`adminNote` 和 `user`（`publicId`、`email`、`nickname`），并返回 `statusCounts`：在当前类型和搜索条件下各状态的数量，不受 `status` 筛选影响。
- `PATCH` 请求体为 `{"status": 2, "adminNote": "已修复"}`，两个字段都可省略但不能同时省略；`adminNote` 最多 2000 字，传空字符串表示清空。成功返回更新后的详情。
- 不存在的反馈返回 `404 FEEDBACK_NOT_FOUND`。

桌面客户端中，管理员账号的标题栏会出现“管理后台”入口，打开独立窗口处理反馈。
