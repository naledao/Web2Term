# Claude 模型与思考设置：只读探针

由用户运行并手动操作，智能体只读日志。运行前请先退出正在使用同一登录分区的 Web2Term 窗口，避免并发占用用户目录。

```powershell
cd C:\codes\gpt-web-to-codex-terminal
node_modules\electron\dist\electron.exe tools\diag\claude-model-settings-probe.cjs
```

直接打开真实 `https://claude.ai/new` 页面，复用 Web2Term 用户目录与 `persist:claude` 登录分区，默认代理 `http://127.0.0.1:7897`（使用系统直连时可先设 `$env:PROBE_PROXY=''`）。支持 `PROBE_USER_DATA`、`PROBE_PARTITION`（例如指定多账号分区的 `persist:claude-<uuid>`）、`PROBE_PROXY`、同源 `PROBE_START_URL` 覆盖。

无需发消息：

1. 等待输入框加载就绪。
2. 点击展开原生模型下拉菜单，停留 2 秒；若有「More models / 更多模型」子菜单，也悬停/点开停留 2 秒。
3. 手动切换另一个模型，等待 2 秒，再切回原模型。
4. 若界面上有「Extended thinking / 扩展思考 / 思考强度 / Effort」开关或菜单，开启/展开一次停留 2 秒后再恢复。
5. 完成后关闭窗口，把终端输出的日志路径发给智能体。

窗口标题会实时显示已采集的模型项数、思考/强度项数和手动点击数；可随时按 `F8` 手动补充采集当前状态。

日志写入 `%TEMP%\gpt-login-diag\claude-model-settings-<timestamp>-<pid>.log`（使用 `fs.appendFileSync`）。仅记录输入区控件结构、弹层菜单与选中状态标记、白名单模型/思考标签、长度信息及别名引用；不读取或记录消息正文、草稿内容、Cookie、存储或网络请求/响应体，也不自动点击或发送消息。
