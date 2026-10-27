# DeepSeek 编辑已发送消息 · 用户操作探针

为两件事测量 DeepSeek 原网页的真实结构，此轮只采集，不改软件实现。**用户运行、用户操作，智能体读日志。**

1. 在原生页面编辑**最后一条**用户消息并重新发送时，软件要识别出来，当成同一任务的重试。
2. DeepSeek 回复只有 `<ds_safety>…</ds_safety>Safe` 时，软件要自动点编辑、原样重新发送。

两件都依赖目前没测过的元素：编辑按钮（铅笔图标，没有文字）、编辑框、编辑框里的发送／取消按钮、
`1 / 2` 版本切换，以及编辑提交走的接口。

## 运行

先关闭正常应用和其他探针。探针使用应用的 `persist:deepseek` 分区，共用登录状态。
在项目根目录的 PowerShell 运行：

```powershell
Set-Location 'C:\codes\gpt-web-to-codex-terminal'
.\node_modules\electron\dist\electron.exe .\tools\diag\deepseek-edit-probe.cjs
```

需要本地代理时，只为本次终端设置（未设置时用系统默认网络，不读取应用保存的代理）：

```powershell
$env:PROBE_PROXY = 'http://127.0.0.1:7897'
# 或 $env:PROBE_PROXY = 'direct'
```

`PROBE_START_URL` 可指定 `https://chat.deepseek.com` 同源会话地址；`PROBE_USER_DATA`、`PROBE_PARTITION`、
`PROBE_LOG_DIR` 可改资料目录、分区、日志目录，默认无需设置。

## 必做操作（约 3～5 分钟）

用一个专门的纯文字测试对话。编辑会真实重发给模型，这是手动操作原网页的正常结果。
不要开「深度思考」和「智能搜索」，回复越短越好。

1. 新建对话，依次发送下面三条，每次等回复完全结束：
   - `只回复：第一轮苹果。`
   - `只回复：第二轮香蕉。`
   - `只回复：第三轮橘子。`
2. **按 F5 刷新一次**，等历史消息恢复，再等 3 秒。
3. 鼠标移到**最后一条（第三轮）用户消息**上，停 2 秒，**按 F6**。
   点它下方的**编辑（铅笔）图标**。编辑框出现后停 3 秒，**按 F6**。
4. 把内容改成 `只回复：第三轮草莓。`，停 3 秒，点**取消**，再停 3 秒。
5. **原样重发**（自动重试要做的就是这一步）：再点同一条消息的编辑图标，**不改内容**，停 3 秒，
   用鼠标点编辑框里的**发送**按钮。等新回复完全结束，再等 5 秒。
6. **改内容用 Enter 发送**：再编辑这条消息，改成 `只回复：第三轮葡萄。`，停 3 秒，在编辑框里**按 Enter 一次**。
   如果 Enter 只是换行、没有发送，不要连按；停 3 秒后用鼠标点发送。等回复结束，再等 5 秒。
7. 如果消息下方出现 `1 / 3`、`2 / 3` 一类的版本切换：点一次 **<**，停 3 秒，再点一次 **>**，停 3 秒。没有就跳过。
8. 可选：点最后一条回复下方的**重新生成**（圆形箭头）图标一次，等回复结束，再等 5 秒。
9. **按 F5 刷新一次**，等消息恢复，再等 5 秒。
10. 直接关闭探针窗口。终端会打印日志路径，把路径发给智能体即可。

如果碰巧出现 `<ds_safety>…` 那种回复，什么都不用做，停 5 秒后按 F6，日志会记录它在页面和网络里的位置。

## 读日志

日志：`%TEMP%\gpt-login-diag\deepseek-edit-<时间>-<pid>.log`

| 行 | 含义 |
| --- | --- |
| `PAGE-EVENT action=click kind=… inRow rowKey icon` | 点了哪个控件：`edit`／`cancel`／`send`／`pager`／`regenerate`，或无文字图标（`other`，靠 `icon` 路径前缀识别） |
| `PAGE-EVENT action=key inRow` | 编辑框里按 Enter／Esc；`inRow=true` 表示编辑框在消息行内 |
| `SNAPSHOT editors[]` | 每个输入框：是否在消息行内（`inRow`、`rowKey`）、附近控件、各控件匹配了哪些发送按钮选择器（`sendMatches`） |
| `SNAPSHOT rows[]` | 最近几行：`key`、角色、控件（含图标路径前缀）、版本切换文字、`safety`（`<ds_safety>` 是否出现在回复正文） |
| `STRUCTURE` | 用户消息行和打开编辑框的行的 DOM 结构，文字只记长度 |
| `REQUEST` / `REQUEST-BODY` | 编辑提交、重新生成走的接口和请求体结构（字段名、类型、`parent_message_id` 等小整数编号） |
| `RESPONSE-SUMMARY` | 流式回复的事件名、`p` 路径计数、消息编号与父子关系、`safetyRecords`（流里是否有 `ds_safety`） |
| `COVERAGE` | 本轮覆盖了哪些操作；`false` 的项没有观察到，不算已测 |

## 规则

- 探针不点击、不输入、不发请求、不重放请求，只观察你自己的操作。
- 不记录消息正文、回复正文、Cookie、请求头；文字只记长度。允许原样记录的只有：控件上的固定文字
  （编辑、取消、发送、复制、重新生成…）、`1 / 2` 这类版本文字、`Safe`／`Unsafe` 判定词、图标路径的前 24 个字符。
- 会话 ID 等字符串编号用本轮随机盐做 HMAC 别名；DeepSeek 的消息编号是会话内的小整数，原样记录，用来看分支关系。
- 只注册一个 `onBeforeSendHeaders` 监听器，身份处理与 `deepseek-chat-view-probe.cjs` 相同。
- 日志用 `fs.appendFileSync` 同步追加，落在 `%TEMP%`，不进仓库。调查结束后可以删除 `%TEMP%\gpt-login-diag`。
