# 内置邮箱验证码登录 API

所有接口由本 Go 服务直接处理，用户、设备和验证码摘要保存在同一个 SQLite 文件中。

## 发送验证码

`POST /api/user/login/code`，`Content-Type: application/json`：

```json
{"email":"user@example.com"}
```

成功返回 `204 No Content`。验证码通过配置的 SMTP 发送，6 位数字、10 分钟有效，不能从接口或日志读取。

## 登录

`POST /api/user/login`，`Content-Type: application/json`：

```json
{"email":"user@example.com","code":"123456"}
```

验证成功即消费验证码；邮箱首次登录时自动注册用户。成功 `200`：

```json
{
  "accessToken":"<JWT>",
  "tokenType":"Bearer",
  "expiresInSeconds":86400,
  "user":{
    "publicId":"usr_<随机标识>",
    "email":"user@example.com",
    "nickname":"user@example.com",
    "avatarUrl":null,
    "role":"USER"
  }
}
```

后续设备接口及 WebSocket 握手携带 `Authorization: Bearer <JWT>`。JWT 校验在 `internal/auth/service.go` 中直接完成，不调用其他服务。没有外部令牌 introspection 接口。

## 错误

错误体使用 `{"code":"稳定错误码","message":"说明"}`：

| 状态 | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_EMAIL` | 邮箱格式不正确 |
| 400 | `INVALID_LOGIN_CODE` | 验证码不是 6 位数字 |
| 401 | `LOGIN_CODE_INCORRECT` | 验证码错误、已用、已过期或超过 5 次尝试 |
| 401 | `UNAUTHORIZED` | JWT 无效、过期、用户已禁用或令牌版本已撤销 |
| 403 | `USER_DISABLED` | 用户被禁用，无法登录 |
| 429 | `LOGIN_CODE_TOO_FREQUENT` | 邮箱重发/小时限额或来源 IP 发送限额触发 |
| 429 | `RATE_LIMITED` | 来源 IP 登录尝试限额触发 |
| 503 | `LOGIN_CODE_SEND_FAILED` | SMTP 未配置或投递失败 |
| 500 | `INTERNAL_ERROR` | 存储或内部操作失败 |

请求体解析失败返回 `400`，超过 16 KiB 返回 `413`。每个邮箱重发间隔为 60 秒、每小时最多 10 次；同一来源 IP 每 10 分钟最多 5 次发送和 30 次登录。验证码投递失败也保留重发限额，避免无限重试发送。
