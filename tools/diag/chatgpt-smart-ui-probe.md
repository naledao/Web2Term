# ChatGPT 智能 UI · 用户操作探针

针对回答中的生成式交互组件：例如截图里的单选卡片、说明文字和「按这个方向深入设计」按钮。
此轮只取证，不改专注会话。用户运行、选择和提交；智能体读日志后确定适配方式。

## 运行

先关闭正常应用，避免与探针同时使用 `persist:chatgpt`。在 PowerShell 中运行：

```powershell
Set-Location 'C:\codes\gpt-web-to-codex-terminal'
$env:PROBE_START_URL = 'https://chatgpt.com/c/替换为截图这条会话的ID'
.\node_modules\electron\dist\electron.exe .\tools\diag\chatgpt-smart-ui-probe.cjs
```

请把第二行替换成原始视图地址栏里的真实会话 URL。也可以省略第二行，从探针里的 ChatGPT
侧栏打开目标会话。支持普通 `/c/…` 以及项目中的会话链接，只接受 `https://chatgpt.com` 同源。

默认代理是 `http://127.0.0.1:7897`，只在探针进程设置。需要更改时，在启动前设置
`$env:PROBE_PROXY = 'http://127.0.0.1:端口'`；直连用 `'direct'`。
`PROBE_USER_DATA` 和 `PROBE_PARTITION` 可改为独立目录/分区，默认复用应用登录状态。
探针不读应用配置、storage、Cookie 或凭据。

页面加载不等待网络监听初始化，避免先前探针的空白窗口问题。网络不可用时仍采集 DOM，
并明确记录 `NETWORK-UNAVAILABLE`。不要打开 DevTools，它会占用网络观察所需的 debugger。

## 操作顺序（约 3 分钟）

优先使用已经出现这种组件的会话。按钮会按原网页行为真实提交或生成回复，请只手动点一次。

1. 找到带单选卡片和按钮的回答，滚动到组件完整可见，等页面稳定。
2. **按 F5 刷新一次**。历史回答和组件恢复后等 3 秒，**按 F6**，采集初始结构和历史接口。
3. 选择第二项，等 2 秒，**按 F6**。再选择第三项，等 2 秒，**按 F6**。
   先不要提交；这两步区分原生 radio、ARIA 状态、自定义选中样式和隐藏表单值。
4. 如果组件支持键盘，手动用 Tab 进入选项区域，再按方向键或空格选择一次，停 2 秒。
   没有键盘交互时跳过，不必强行尝试。
5. 鼠标悬停提交按钮，按 F6，然后**只点一次按钮**。观察底部输入框是否被填入文字、
   是否新增用户消息、是否直接开始生成，以及原组件是否禁用或替换。探针会自动记录前后状态。
6. 等回复完全结束，再等 5 秒，按 F6。若按钮仅填入草稿、没有发送，先按 F6 保留这个状态；
   再由你决定是否手动点原网页发送按钮，探针不代发。
7. **再按 F5 刷新一次**，等历史和组件恢复，停 3 秒，按 F6，采集选中项是否保留、
   提交状态是否恢复、交互后的新消息及历史中的组件定义。
8. 关闭探针窗口，等待终端打印「日志已保存」，把完整路径发给智能体。

若刷新后组件消失，不要反复刷新或重新登录，直接按 F6、关闭窗口并发日志。
若还有复选框、下拉框等组件，可以在同一次采集中再操作一组；不要为采集重复点击同一提交按钮。

## 日志与采集范围

同步追加到临时目录，不写入仓库：

```text
%TEMP%\gpt-login-diag\chatgpt-smart-ui-<timestamp>-<pid>.log
```

| 事件 / 字段 | 用途 |
| --- | --- |
| `PAGE-LOAD-START` / `DOM-READY` / `PAGE-LOADED` | 区分导航、DOM 就绪和加载完成，定位空白窗口 |
| `OBSERVER-READY` / `NETWORK-READY` | DOM、被动网络监听是否成功安装 |
| `SNAPSHOT.components` | 候选组件、选项和按钮的属性、值摘要、选中/禁用状态、表单、标签关联、祖先链及布局样式 |
| `SNAPSHOT.assistantControls` | 最近回答的控件总览；没有 radio/checkbox 语义的自定义按钮也保留证据 |
| `STRUCTURE` | 组件的脱敏标签树，标记它在 Markdown、消息 ID 和回合容器之间的位置 |
| `PAGE-EVENT` | 可信的 click/change/input/submit/键盘事件；click/submit/keydown 在默认行为前采集，input/change 在事件发生时采集，另采 120ms、700ms 后状态 |
| `SNAPSHOT.composers` | 底部输入框的长度和摘要，辨别组件是否只是填入草稿 |
| `SNAPSHOT.iframes` / `discovery.shadowRoots` | iframe 和开放 Shadow DOM 是否参与渲染；closed shadow root 无法读取 |
| `component-message` | 组件相关 postMessage 的来源和字段类型，不包含消息值 |
| `REQUEST` / `REQUEST-BODY` | 相关接口、方法、请求结构、消息/组件/选项 ID 摘要及 `genui_state_snapshots` 等字段 |
| `RESPONSE-SUMMARY` | 历史或已完成流的 JSON 结构、组件相关字段、消息 ID；JSON 字符串内的组件定义另记结构 |
| `COVERAGE` / `LIMIT` / `…-UNAVAILABLE` | 实际覆盖状态和采集边界，缺失证据不当成已验证 |

页面选择器为当前应用的消息/回答标记的独立副本。组件通过原生控件、ARIA 角色、
表单及结构属性进行发现，不预设一个尚未实测的 ChatGPT 智能 UI 组件选择器。
独立子帧只读取 ChatGPT 同源、`*.oaiusercontent.com`、about:blank/srcdoc；其它 iframe
仅记录外层结构和来源。发现规则漏掉自定义控件时，还能从最近回答的控件清单定位。

## 数据和行为边界

- 不自动点击、输入、选择、提交、刷新，不发送额外 API 请求，不重放请求。
- 不加载应用的发送拦截器，不执行任何模型输出的命令。
- 不记录聊天正文、选项/按钮文案原文、输入值原文、提示词、附件、Cookie、Token、请求头或 storage。
  固定通用界面标签（如「提交」「取消」）、结构类名/角色/测试标记可原样记录。
- 文本、ID、组件值使用本次运行随机盐的 HMAC 摘要和长度；相同值可跨 DOM/请求/响应关联。
  不同运行的摘要不可比较。密码或凭据字段不读取其值。
- 使用 `fs.appendFileSync`，在窗口销毁前采集最终快照。身份处理器只注册一次，限 ChatGPT 主机。
- 只观察已经发生的相关 XHR/Fetch；不关闭网页安全选项。流式正文在请求完成后读取，取消或
  debugger 取不到正文会明确记录；不能保证拿到中断的流。刷新后的历史接口用于补充组件结构。
- 每帧最多 8 个候选组件、每组件标签树最多 360 个节点；最多 12 个可读帧、24 个开放 shadow root，
  DOM 扫描最多 10000 个元素。请求最多 160 个、正文最多 2 MiB、日志上限约 32 MiB，达到限制有记录。
- 源码和序列化后的页面脚本均做语法检查；构建通过不等于真实采集成功。

交付状态：探针已编写，构建通过，等待用户运行采集。
