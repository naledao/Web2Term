# ChatGPT 文件链接：用户操作的只读诊断

用于确认原始视图的“下载 HTML 页面”为什么在专注视图中只剩纯文字。此探针由用户明确授权新增，
只由用户运行和点击；智能体不启动 Electron、不操作真实页面。

先完整退出 Web2Term，包括托盘中的实例，避免同时打开同一个登录分区。然后在 PowerShell 运行：

```powershell
cd C:\codes\gpt-web-to-codex-terminal
.\node_modules\electron\dist\electron.exe .\tools\diag\chatgpt-file-links-probe.cjs
```

默认打开本次截图的原会话，读取该回复中下载/预览入口的元数据，复用相同用户目录和 `persist:chatgpt` 分区。
支持 `PROBE_START_URL`（仅 ChatGPT 同源）、`PROBE_SOURCE_MESSAGE_ID`、`PROBE_USER_DATA` 和 `PROBE_PROXY`；默认使用本地代理 `http://127.0.0.1:7897`。

1. 等页面载入，滚动到截图中的“下载 HTML 页面”。无需发送消息。
2. 按一次 **F8**，记录点击前的入口结构。
3. **手动点击一次下载链接**。如果出现保存对话框，可保存或取消；记录下实际看到的现象。
4. 等数秒后关闭探针窗口，把终端输出的日志路径和点击结果发给智能体。

若标题显示入口为 0，仍请在入口可见时按 F8 并手动点击一次。日志中的 `targetReplyFound: false`
表示目标回复未定位，不能解释成网页没有文件链接。

日志使用 `fs.appendFileSync` 同步写入 `%TEMP%\gpt-login-diag\chatgpt-file-links-<时间>-<进程号>.log`。

| 事件 | 用途 |
| --- | --- |
| `SNAPSHOT` | 原生入口标签、属性、局部子节点和点击样式；检查有无 `href`、`role`、`tabindex`、文件属性 |
| `FILE-CLICK` | 用户真实点击的入口及祖先属性，确认点击目标和回复归属 |
| `FILE-CLICK-FINISHED` | 原网页是否接管并取消浏览器默认导航 |
| `DOWNLOAD` / `DOWNLOAD-DONE` | 用户操作触发的下载元数据及完成/取消状态 |
| `NEW-WINDOW-REQUEST` | 用户点击要求打开的新窗口的地址形状；探针只记录元数据，不打开额外窗口 |
| `FINAL` | 本次采集覆盖；不代表修复已经生效 |

不记录会话正文、输入草稿、文件名、Cookie、登录凭据、存储、网络请求/响应体或 React 私有对象。
入口文字仅记录长度、下载/预览类别和本次运行内的别名；URL 仅记录协议、固定路径段及参数名，
其余路径段替换成占位符，参数值和片段均省略。动态属性值仅记录长度、形状及本次运行内的别名。
不注册 webRequest/debugger 监听器，不加载项目注入器，不自动点击、输入、发送或猜测文件下载地址。
浏览器仅执行用户的自然操作，用户点击产生的下载保留正常行为。
