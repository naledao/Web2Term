# Web2Term Go 后端

独立的 Go + SQLite 服务，内置邮箱验证码登录、用户注册、JWT 签发与校验、设备管理、Agent / Desktop WebSocket 路由，以及版本更新说明与机器阅读状态。**不依赖 Nacos、外部 user-service 或 MySQL。** 邮件通过 SMTP 发送。

默认监听 `:10088`，本机地址为 `http://127.0.0.1:10088`。需要 Go 1.26 或更新版本，SQLite 使用纯 Go 驱动，不需要 CGO。

更新说明管理可通过本地 stdio MCP 交给 Codex 使用：见 [MCP 构建、私密配置与接入说明](mcp/README.md)。MCP 使用独立管理令牌，不需要用户登录 JWT，也不新增服务器监听端口。

## 本地构建与配置

在 `backend` 目录构建，按仓库约定由使用者启动、验收：

```powershell
go build -trimpath -o bin/web2term-backend.exe ./cmd/server
$env:WEB2TERM_JWT_SECRET = '<至少 32 字节的随机密钥>'
$env:SMTP_HOST = 'smtp.qq.com'
$env:SMTP_PORT = '465'
$env:SMTP_MODE = 'tls'
$env:SMTP_USERNAME = '<QQ 邮箱地址>'
$env:SMTP_PASSWORD = '<QQ 邮箱 SMTP 授权码>'
$env:SMTP_FROM = $env:SMTP_USERNAME
./bin/web2term-backend.exe
```

配置通过环境变量读取，`.env.example` 是参考文件，程序不自动加载 `.env`。正式部署使用下面的 systemd `EnvironmentFile`。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WEB2TERM_ADDR` | `:10088` | HTTP / WebSocket 监听地址 |
| `WEB2TERM_DB_PATH` | `data/web2term.db` | SQLite 文件；相对路径基于进程工作目录 |
| `WEB2TERM_JWT_SECRET` | 必填 | 至少 32 字节随机密钥，重启后应保持不变；更换会使已签发令牌失效 |
| `RELEASE_NOTES_ADMIN_TOKEN` | 空 | 更新说明管理接口的独立 Bearer 令牌；空值禁用管理接口，公共读取与已读登记仍可使用 |
| `SMTP_HOST` | 空 | SMTP 主机，QQ 邮箱为 `smtp.qq.com` |
| `SMTP_PORT` | `465` | SMTP 端口 |
| `SMTP_MODE` | `tls` | `tls` 使用隐式 TLS；`starttls` 强制 STARTTLS；不允许明文认证 |
| `SMTP_USERNAME` | 空 | SMTP 登录账号 |
| `SMTP_PASSWORD` | 空 | SMTP 授权码 |
| `SMTP_FROM` | 同 `SMTP_USERNAME` | 发件邮箱地址 |

未配置 SMTP 时服务可以启动，但验证码请求返回 `503 LOGIN_CODE_SEND_FAILED`，不会在日志或接口中暴露验证码。SMTP 只填写部分参数时启动失败。

## GitHub 构建后通过 SSH 部署

工作流是 `.github/workflows/backend-deploy.yml`，两个 job 都使用 **GitHub 托管的 `ubuntu-latest`**。服务器无需安装 GitHub Actions runner / listener，也无需安装 Go、Node 或编译工具链。

- `main` 分支的 `backend/**` 或该 workflow 变化时自动触发，也可通过 Actions 手动运行。
- 构建 job 生成 Linux amd64、关闭 CGO 的二进制，计算 SHA-256，将当前提交与运行编号写入部署包，并上传为 artifact。
- 部署 job 下载同一次运行的 artifact，使用 SSH 私钥认证及固定的主机公钥，将部署包传给服务器脚本。
- 脚本校验包内容、校验和及架构后，原子切换 `current` 链接，重启 systemd 服务并检查 `http://127.0.0.1:10088/healthz`。
- 健康检查失败恢复上一版程序。SQLite 和配置文件不随代码覆盖。回滚仅恢复程序，数据库结构升级需要另外规划备份。
- GitHub concurrency 和服务器 `flock` 防止并行部署相互覆盖。旧版本保留在 `releases/`，不自动删除。

当前部署目标：

| 项目 | 值 |
| --- | --- |
| 服务器 | `38.49.42.56`，Ubuntu 22.04，x86_64 |
| SSH 端口 | `3302` |
| 后端端口 | `10088` |
| 版本目录 | `/opt/web2term-backend/releases/<提交>-<运行>-<次数>/` |
| 当前程序 | `/opt/web2term-backend/current/web2term-backend` |
| SQLite 数据 | `/var/lib/web2term-backend/web2term.db` |
| 配置 | `/etc/web2term-backend/backend.env`，root 所有，权限 `0600` |
| 服务 | `web2term-backend.service`，运行用户 `web2term-backend` |
| 部署入口 | `/usr/local/sbin/web2term-backend-deploy` |

仓库 Actions 配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `BACKEND_SSH_PRIVATE_KEY` | 专用 Ed25519 私钥 |
| Secret | `BACKEND_SSH_KNOWN_HOSTS` | 已核实的 `[38.49.42.56]:3302` 主机公钥条目 |
| Variable | `BACKEND_SSH_HOST` | `38.49.42.56` |
| Variable | `BACKEND_SSH_PORT` | `3302` |
| Variable | `BACKEND_SSH_USER` | `root` |

专用公钥在服务器 `authorized_keys` 中带有 `restrict` 和固定 `command`，仅能调用部署入口，不能打开交互 Shell 或创建转发。后端程序由单独的非 root 用户运行。

### 首次初始化服务器

`deploy/bootstrap.sh`、`deploy/deploy.sh` 和 `deploy/web2term-backend.service` 是初始化模板。将它们与 `deploy-key.pub`、填写好的 `backend.env` 放入服务器同一个 root 私有目录，再由管理员运行：

```bash
bash /root/<初始化目录>/bootstrap.sh
```

初始化会建立服务用户、目录、systemd 单元及受限部署公钥；不启动后端，不安装 Actions runner，不修改原有服务。重复初始化保留已存在的环境配置、JWT 密钥和 SQLite。

日常 workflow 只更新后端二进制。修改 `deploy.sh` 或 systemd 单元后，需要管理员重新运行初始化来安装这些部署基础设施文件。

QQ 邮箱授权码和 JWT 密钥只保存在服务器配置中，不加入仓库，也不随 artifact 分发。将本地改动推送到 `main` 后工作流才会在 GitHub 上运行。

使用者可以检查部署及运行日志：

```bash
systemctl status web2term-backend --no-pager
journalctl -u web2term-backend -n 100 --no-pager
```

`healthz` 表示 HTTP 服务存活，不代表实际验证码投递已验收。服务器的网络规则也需要允许客户端访问 TCP `10088`。

## 登录与接口

邮箱统一去除两端空白并转小写。验证码是随机 6 位数字，有效期 10 分钟，每个邮箱至少间隔 60 秒才能重新发送，每小时最多 10 次。一个验证码最多尝试 5 次，登录后失效。SQLite 只保存带密钥的验证码摘要，不保存验证码明文。

HTTP 层额外限制同一来源 IP 每 10 分钟最多发送 5 次验证码、尝试登录 30 次，不信任客户端自行提供的 `X-Forwarded-For`。若使用反向代理，代理后的请求会共用来源 IP 配额。

首次成功验证邮箱时自动创建用户。登录成功返回兼容现有客户端的 `accessToken`、`tokenType`、`expiresInSeconds` 和 `user`。JWT 使用 HS256，固定校验算法、签发者、受众和 24 小时有效期；每次鉴权也检查本地用户是否启用及令牌版本。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `POST` | `/api/user/login/code` | 使用 SMTP 发送验证码，成功 `204` |
| `POST` | `/api/user/login` | 验证邮箱及验证码，创建/查询本地用户并返回 JWT |
| `GET` | `/api/user/devices` | 查询当前登录用户的设备 |
| `PATCH` | `/api/user/devices/{deviceId}` | 修改设备名称，成功 `204` |
| WebSocket | `/ws/agent` | `Authorization`、`X-Device-Id`、可选 `X-Device-Name` |
| WebSocket | `/ws/desktop` | `Authorization`、`X-Desktop-Client-Id`、`X-Agent-Id` |
| `GET` | `/healthz` | 返回 `{"status":"ok"}` |

设备归属、禁用设备、心跳、连接替换和单设备桌面占用规则继续保留；消息按服务端绑定双向原样转发。单条消息上限 64 KiB，非法 JSON/二进制/缺少 `type` 时关闭。Agent 90 秒无消息时断开，程序启动时清理遗留在线状态。详细登录协议见 [登录 API](docs/user_login_api.md)。

## 版本更新说明

本模块与其他接口使用同一个 `10088` 端口、进程和 SQLite 连接，不再单独启动或部署服务。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/release-notes?machineId=UUID` | 分页查询公开版本及当前机器阅读状态 |
| `GET` | `/api/v1/release-notes/{id}?machineId=UUID` | 获取 HTML 正文 |
| `POST` | `/api/v1/release-notes/{id}/read` | 登记当前机器已读 |
| `GET/POST` | `/api/v1/admin/release-notes` | 管理列表和新增版本 |
| `GET/PUT/DELETE` | `/api/v1/admin/release-notes/{id}` | 读取、替换或删除维护记录 |

公开接口按客户端的机器 UUID 区分阅读状态，不要求登录；管理接口需要 `RELEASE_NOTES_ADMIN_TOKEN`，普通登录 JWT 不授予发布权限。完整字段、错误码和发布示例见 [更新说明 API](docs/release-notes.md)，示例正文位于 `examples/release-note.json`。配置通过现有 systemd 环境文件注入，现有后端 workflow 会构建和部署本模块。

## SQLite 与迁移

数据库版本为 `3`：版本 `1` 保存设备，版本 `2` 添加 `user_account` 和 `login_code`，版本 `3` 添加 `app_release_note` 和 `app_release_note_read`。升级在单个事务中完成，保留账号、验证码和设备记录。WAL、5 秒忙等待及单连接写入用于控制锁竞争。连接路由保存在内存中，只支持单实例。

旧外部 user-service 签发的 JWT 不再接受。旧设备所属用户 ID 不会自动映射到新本地账号；升级时新账号 ID 会避开旧设备用户 ID，防止新注册用户继承他人的设备。如已存在旧数据，应由管理员导入对应用户身份并明确映射设备归属，再开放连接。旧 MySQL 数据不自动导入。

备份时停止后端后复制数据库，或使用 SQLite 在线备份；运行时不要仅复制主文件而遗漏 WAL。

## 构建与测试分工

遵守仓库 `AGENTS.md`：智能体执行构建与静态检查，不运行测试、不发验证码、不启动真实后端。测试由使用者在 `backend` 目录运行：

```powershell
go test ./...
# 已配置竞态检测器所需 C 工具链时：
go test -race ./...
```

测试使用临时 SQLite、模拟邮件投递和本机 httptest 服务，无需 Nacos 或真实 SMTP。覆盖验证码过期/复用/错误次数、用户和 JWT、算法及受众校验、设备归属、持久化、WebSocket 路由，以及更新说明发布/下线、HTML 保留、机器阅读隔离、管理鉴权、旧库升级和迁移回滚。构建通过，等待使用者运行测试与真实部署验收。
