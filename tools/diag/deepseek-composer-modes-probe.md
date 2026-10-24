# DeepSeek 输入框开关：只读探针

由用户运行并手动操作。不要由智能体启动 Electron。先退出使用同一账号分区的项目窗口，避免并发打开会话目录。

```powershell
cd C:\codes\gpt-web-to-codex-terminal
node_modules\electron\dist\electron.exe tools\diag\deepseek-composer-modes-probe.cjs
```

直接载入真实 DeepSeek 网页。使用现有 `persist:deepseek` 登录分区，默认代理为 `http://127.0.0.1:7897`。
可用 `PROBE_PROXY`、`PROBE_USER_DATA`、`PROBE_PARTITION` 和同源 `PROBE_START_URL` 覆盖。

不用发送消息，也不必菜单打点。先手动把两个开关都关闭，然后依次点击，每次间隔约一秒：

1. 点击“深度思考”。
2. 点击“智能搜索”。
3. 再点击“深度思考”。
4. 再点击“智能搜索”。

探针自动记录真实手动点击及后续状态变化。标题显示是否找到两个开关、每个开关的点击次数，
应分别至少为 2。需要明确标注时仍可用菜单记录四种组合，F8 可额外采集。
完成后关闭窗口，终端会输出日志路径：
`%TEMP%\gpt-login-diag\deepseek-composer-modes-<timestamp>-<pid>.log`。

日志用同步 append，包含两个已知控件的语义状态、类名、颜色、祖先层级，以及工具栏内其他按钮的匿名结构。
不会在仅含附件/发送的内层工具栏提前停止；独立搜索整页的已知开关文案，未使用语义按钮时也记录文字节点与祖先结构。
不读取消息正文、输入框值、cookie、存储或网络请求体；不自动点击、输入、发消息，也不加载项目注入器。
`FINAL.complete` 仅表示找到两个开关，且各有至少两次手动点击（或四种人工打点齐全）；
不代表适配已经可用。智能体读取状态差异后确定选择规则。
