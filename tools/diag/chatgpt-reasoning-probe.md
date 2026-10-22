# ChatGPT 思考过程 · 结构采集

专注对话已接入 ChatGPT，但 ChatGPT 回答上方「已思考 N 秒 / Thought for Ns」那块的页面结构从未实测，
所以 `src/shared/platforms.ts` 里 `CHATGPT_PAGE.focus.reasoningSelectors` 目前是空的，专注对话不显示 ChatGPT 的思考过程。

这个探针由用户运行、用户操作，只读取页面结构写日志；智能体读日志后再填选择器。**无需截图。**

## 操作步骤

1. 关闭正常应用（它和探针共用 `persist:chatgpt` 登录状态）。
2. 在项目根目录的 PowerShell 运行：

```powershell
Set-Location 'C:\codes\gpt-web-to-codex-terminal'
.\node_modules\electron\dist\electron.exe .\tools\diag\chatgpt-reasoning-probe.cjs
```

3. 在打开的 ChatGPT 窗口里：
   1. 选一个会先思考再回答的模型（模型菜单里带「思考 / Thinking」的那种），开一个新对话。
   2. 发一个需要推理的问题，例如：`一个三位数，各位数字之和是 15，百位比个位大 3，十位是个位的 2 倍，求这个数，并说明推理过程。`
   3. **等它思考和输出的过程中不要操作**，让日志记下「正在思考」的状态，直到回答完全结束。
   4. 回答结束后，**点一下回答上方的「已思考 N 秒」**把思考过程展开，等 5 秒；再点一次收起，等 5 秒。
   5. 如果页面上有其它带思考过程的旧对话，可以打开其中一个，同样展开、收起一次（可选）。
4. 直接关闭窗口。终端最后会打印日志路径，把这个路径发给智能体即可。

### 采集回答里的图表等智能组件

专注对话把回答转成 Markdown 时，会把 ChatGPT 回答里的交互式图表逐字拆成坐标轴文字和数据列表。
探针同时记录回答内部这类组件的结构。操作：

1. 关闭正常应用，按上面的命令启动探针，开一个新对话。
2. 发一条会让 ChatGPT 画图的消息，例如：`用折线图展示这组数据：周一 12，周二 18，周三 9，周四 22，周五 15。`
3. 等回答（含图表）完全出来后再等 10 秒；把鼠标在图表上移动一下，让提示框出现，停 3 秒。
4. 图表右上角如有按钮（例如分享、更多），不用点。直接关闭窗口，把日志路径发给智能体。

图表只出现在最近 4 个回答里才会被采集，所以请在新对话里做，或者画完图后不要再发很多条消息。

如果 ChatGPT 页面打不开，多半是代理不对。探针默认用 `http://127.0.0.1:7897`，可以在启动前改：

```powershell
$env:PROBE_PROXY = 'http://127.0.0.1:端口'   # 或 'direct' 表示直连
```

`PROBE_START_URL` 可直接打开某个已有会话（只接受 `https://chatgpt.com` 同源地址），
`PROBE_USER_DATA` / `PROBE_PARTITION` 可改用独立的测试资料目录或分区。探针不读取应用保存的代理设置。

## 日志

```text
%TEMP%\gpt-login-diag\chatgpt-reasoning-<timestamp>-<pid>.log
```

| 事件 | 含义 |
| --- | --- |
| START / PROXY / PAGE-LOADED / OBSERVER-READY | 版本、代理模式、页面加载与被动观察器安装 |
| SNAPSHOT | 最近 4 个助手回合：外层回合容器、带 ID 的消息元素、回答正文元素的位置关系；`stopFound` 表示当时是否在生成；`candidates` 是像思考块的元素（标题像「已思考…」，或属性/类名含 reason、thought、think、collapse 等），附带它在回答之前还是之后、是否可点击、到回合容器的路径、紧随其后的兄弟元素尺寸 |
| STRUCTURE | 这几个回合的脱敏标签结构，`probe-mark` 标出 ID-TURN / ANSWER / UNIT-ASSISTANT；回答正文内部只记字数 |
| SNAPSHOT.turns[].answerChildren | 回答正文的直接子元素：标签、类名、data 属性名、字数，以及是否普通 Markdown 块（段落、列表、表格、代码、标题） |
| SNAPSHOT.turns[].widgets | 回答里的组件（含较大的 svg、canvas、iframe、figure、role=img/figure 等）：所在的顶层块、从组件到正文的路径、svg 尺寸与内部元素计数、iframe 主机名、列表/表格数量、视觉隐藏的文字节点数、按钮标签 |
| STRUCTURE.turns[].widgets[].markup | 组件的脱敏结构；svg 只记尺寸和元素计数，`probe-hidden` 标出视觉隐藏（读屏用）的节点，文字只记字数，纯数字记为 `[num chars=N]` |
| PAGE-EVENT | 点击（含是否在回答内）、Enter、details 展开收起、DOM 变化次数 |
| COVERAGE | 是否观察到生成中、空闲、思考候选元素、对思考标题的点击；没观察到的状态不算已覆盖 |

## 数据边界

- 不点击、不输入、不发送、不展开任何东西；只读 DOM，所有操作由用户完成。
- 不记录聊天正文、思考内容、草稿、链接地址、图片地址、Cookie、Token、请求头或 storage。
- 文字一律只记字数。只有固定格式的界面标题会原样记录，例如「已思考 12 秒」「Thought for 12s」「思考中」；
  像「Thinking about 某主题」这种可能含模型内容的标题，只记为 `[reasoning-like label chars=N]`。
- 会话 ID 替换成摘要；属性值除 role、aria-expanded、data-state、data-testid 等结构字段外只记长度。
- 只为 `persist:chatgpt` 注册一个 `onBeforeSendHeaders` 身份处理器；日志用 `fs.appendFileSync` 同步写入。
- 启动时用 `vm.Script` 解析序列化后的页面脚本，避免只检查外层文件语法。

选择器常量独立复制自 `src/shared/platforms.ts` 的 `CHATGPT_PAGE`，适配器改动时要同步。
候选元素只是发现线索，不是结论；智能体读日志确认结构后才会写入 `reasoningSelectors`。
