# ChatGPT 模型与思考强度：只读探针

由用户运行并手动操作，智能体只读日志。先退出使用相同登录分区的项目窗口，避免并发打开会话目录。

```powershell
cd C:\codes\gpt-web-to-codex-terminal
node_modules\electron\dist\electron.exe tools\diag\chatgpt-model-settings-probe.cjs
```

直接打开真实 ChatGPT 网页，使用 `persist:chatgpt` 登录分区，默认代理 `http://127.0.0.1:7897`。
与应用相同，优先复用含 `conversations.db` 的现有 Web2Term 或历史用户目录，不复制或移动目录。
支持 `PROBE_USER_DATA`、`PROBE_PARTITION`、`PROBE_PROXY`、同源 `PROBE_START_URL` 覆盖。

不用发消息，不用打点：

1. 展开原生模型菜单，保持两秒；如果有相关子菜单，也展开一次。
2. 切换另一个模型，等待两秒，再切回原模型。
3. 展开思考强度菜单，保持两秒；切换另一个强度，等待两秒，再切回来。
4. 模型和强度如果共用一个菜单，请把相关层级都展开一次。
5. 完成后关闭窗口，把终端输出的日志路径发给智能体。

标题显示累计采集到的模型/强度选项数和手动点击数。F8 可补充采集当前状态。
若某类选项数始终为零，展开相应菜单后按一次 F8，再关闭窗口；零表示未识别，不能当成不支持切换。

日志落在 `%TEMP%\gpt-login-diag\chatgpt-model-settings-<timestamp>-<pid>.log`，使用 `fs.appendFileSync`。
包括原生触发按钮、输入框祖先中的控件、通过 portal 或 `aria-controls` 发现的菜单、选项结构、
ARIA/`data-state` 选中标记、勾选图标路径，以及真实点击前后的结构。
包含 `data-selected-reasoning-effort`、滑杆的 `aria-valuemin/max/now`、刻度的 `data-selected`，
以及手动拖动或方向键操作前后的滑杆结构；可用左右方向键额外观察键盘控件。
动态 DOM ID 使用本次页面内的别名，保留引用关系；仅保留白名单模型名、强度和菜单标签，其他文字仅记长度。
编辑器值与消息区域被排除，不记录 HTML、消息正文、输入草稿、Cookie、存储、网络请求/响应体或原始异常。
不调用第三方 API、不加载项目注入器、不自动点击/输入/发送，不注册 webRequest 或 debugger 监听器。

`FINAL.modelMenuSeen`、`effortMenuSeen` 只表示采集覆盖，不代表适配可用。
智能体应先对照菜单打开、选择、关闭后的标记，再实现读取与切换。
