# 文件预览与右上角下载：用户操作的只读探针

目标行为：在专注会话内部打开文件预览，右上角提供下载按钮。本探针先测量原网页完成同一过程时的
入口、预览容器、内容承载方式及下载动作，再根据日志实现专注会话内的对应界面。

上一份日志已经确认入口是无 `href` 的 `span[role="link"][tabindex="0"]`，点击后打开文件界面。
本探针保留这段证据采集，并继续跟随预览出现、工具栏点击和真实下载。它不实现预览功能，也不自动操作页面。

先完整退出 Web2Term，包括托盘中的实例，避免同时打开相同会话分区。在 PowerShell 中运行：

```powershell
& 'C:\codes\gpt-web-to-codex-terminal\node_modules\electron\dist\electron.exe' 'C:\codes\gpt-web-to-codex-terminal\tools\diag\chatgpt-file-preview-probe.cjs'
```

默认打开本次截图中的原会话。支持 `PROBE_START_URL`（ChatGPT 同源）、`PROBE_SOURCE_MESSAGE_ID`、
`PROBE_USER_DATA` 和 `PROBE_PROXY`，默认代理 `http://127.0.0.1:7897`。
复用原用户目录和 `persist:chatgpt`，不导入项目模块或终端提示词注入器。

1. 找到“下载 HTML 页面”，**手动点击一次**，等原生预览或文件界面完整出现。
2. 保持预览打开，按一次 **F8**。同时会自动采集，不需要反复按键。
3. **手动点击预览右上角的下载按钮**；有保存窗口时保存或取消均可。如果先打开“更多”菜单才能下载，按正常流程操作即可。
4. 如果文件界面有“预览／代码”页签，可手动切换一次，再切回预览；不输入、不修改、不运行代码。
5. 关闭预览，再关闭探针主窗口。把终端打印的**日志路径**及右上角按钮实际表现发给智能体。

若预览或下载按钮没有出现，保持当时状态按 F8 后结束；采集缺失不代表功能不存在。
原网页由用户点击请求打开的 HTTP/HTTPS/Blob 子窗口会正常显示并继续采集，不再被旧探针阻止。

日志：`%TEMP%\gpt-login-diag\chatgpt-file-preview-<时间>-<进程号>.log`，使用 `fs.appendFileSync`。

| 事件 | 说明 |
| --- | --- |
| `SOURCE-CLICK` | 原会话文件入口的真实结构与用户点击 |
| `SNAPSHOT.previews` | 新出现或展开的弹层／侧栏／门户容器、控件及相对位置，含下载按钮是否位于右上角 |
| `SNAPSHOT.iframes` | iframe 来源协议、sandbox、srcdoc 是否存在及同源可读性；不记录 HTML |
| 子帧 `SNAPSHOT` | ChatGPT、oaiusercontent、Blob 或 about 子帧的容器和工具栏结构；其他来源不注入读取函数 |
| `PREVIEW-CLICK` | 预览工具栏、下载、菜单、关闭等用户点击的结构信息 |
| `FILE-RESPONSE` | 点击后的有限 GET/HEAD 响应元数据：状态、MIME、附件类型及脱敏地址形状，无响应体 |
| `DOWNLOAD` / `DOWNLOAD-DONE` | 实际下载事件和保存／取消结果；不记录文件名、保存路径或内容 |
| `FINAL.coverage` | 分别报告入口点击、预览容器、预览框架、下载控件、下载事件及下载完成的采集覆盖 |

隐私与边界：不记录会话正文、HTML/代码内容、输入值、Cookie、令牌、请求／响应体、React 私有对象或截图。
文字与动态属性仅保留长度、动作类别及本次运行内的别名；URL 的文件名、动态路径段、参数值、片段和凭据省略，
只保留协议、固定路径形状、参数名及本次运行加盐引用。容器几何仅记录尺寸和内部相对位置，
控件内的 SVG 图标仅记录受限数字路径，便于识别没有文字或 ARIA 标签的下载图标。
只在用户点击文件入口或按 F8 后观察有限网络元数据；每个 session 只注册一次 `webRequest.onCompleted`，关闭时注销。
不注册 debugger、不发请求／重放请求、不自动点击、输入或发送，用户点击产生的预览和下载保留原生行为。

智能体只完成静态检查和构建，不运行探针。构建通过及采集覆盖均不能代替真实功能验收。
