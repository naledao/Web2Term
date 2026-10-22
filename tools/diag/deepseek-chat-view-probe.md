# DeepSeek 聊天视图 · 自动日志采集

由用户运行探针并正常操作 DeepSeek，智能体读取日志后再设计新视图。**无需截图、采集菜单、快捷键或手动标记状态。**

## 操作步骤

1. 关闭正常应用和其他探针。
2. 在项目根目录的 PowerShell 运行下面的命令。
3. 在打开的 DeepSeek 窗口正常聊天。可以展开/收起思考、上传测试附件或滚动历史；结束后直接关闭窗口，把终端最后打印的日志路径发给智能体。

```powershell
Set-Location 'C:\codes\gpt-web-to-codex-terminal'
.\node_modules\electron\dist\electron.exe .\tools\diag\deepseek-chat-view-probe.cjs
```

这是用户运行的独立诊断入口。正常项目仍只通过 npm run dev 启动；智能体不启动探针，不执行测试。

如果需要本地代理，在启动前设置当前 PowerShell 环境：

```powershell
$env:PROBE_PROXY = 'http://127.0.0.1:7897'
```

未设置时使用 Electron/系统默认网络环境，不读取应用保存的模型代理。PROBE_PROXY=direct 可强制探针直连。
PROBE_USER_DATA 可指定独立测试资料目录；PROBE_START_URL 可指定已有会话，只接受 https://chat.deepseek.com 同源地址。
默认复用应用的 persist:deepseek 登录状态。探针不导入、读取、清理或打印 Cookie；网页本身会正常维护自己的登录状态。

## 可以自然操作的内容

发一条包含代码和表格的普通问题即可。想观察思考过程时，可以开启网页已有的“深度思考”，等回答出现后展开或收起。
有需要时再操作附件、历史、网页主题或窗口大小，不需要按顺序执行，也不要求覆盖每一种状态。
没有出现的状态由日志如实记录为缺少证据，不需要为了补齐而反复登录或发送。

## 唯一的输出文件

所有结果自动追加到同一个文件：

```text
%TEMP%\gpt-login-diag\deepseek-chat-view-<timestamp>-<pid>.log
```

终端在启动和正常关闭后都会打印完整路径。只需提供这个路径，智能体可以从本机读取。
本版不生成 PNG、截图或单独的结构 HTML；以前版本留下的文件不属于本轮采集结果。

## 自动记录机制

- 页面被动监听输入、Enter、控件点击、表单提交、文件选择、details 折叠、滚动和窗口尺寸变化，只记录事件类型、结构属性与长度/数量。
- MutationObserver 汇总 DOM 变化，触发自动快照；完整 DOM 读取合并节流为至少约 900 毫秒间隔。
- 每 1.2 秒额外请求一次快照，作为页面观察器不可用时的兜底；没有变化则不重复写快照。
- 页面结构变化时自动把脱敏 DOM 写入同一日志的 STRUCTURE 事件，去除正文长度对结构比较的影响，避免流式输出每个字都重复写整棵树。
- 不再使用旧版“240 次自动变化后停止”的上限。关闭窗口前尝试保存最终快照与 COVERAGE；页面无响应时有关闭时限，此前日志仍保留。
- 不点击、输入、发送、展开、滚动或修改网页设置；不读取 storage、网络响应或认证头，也不调用模型接口、不连接终端执行。

## 日志解释

| 事件或字段 | 含义与边界 |
| --- | --- |
| START / PROXY / PAGE-LOADED | 版本、代理模式、页面加载阶段，不记录代理凭据 |
| OBSERVER-READY / OBSERVER-FAILED | 被动观察器是否安装成功；失败时继续周期性 DOM 快照 |
| PAGE-EVENT | 实际发生的操作或 DOM 变化；Enter 包含输入法和 Shift 状态，但不等于发送成功 |
| SNAPSHOT.reason / changes | 触发原因及自动比较出的变化，如输入、回答/思考长度或可见性、控件、滚动容器、主题 |
| selectorMatches | 已有适配器选择器的数量与可见性；当前没出现的元素不能直接判定为适配失效 |
| counts / turns / fileInputs | 已挂载消息、思考和回答长度、代码块、表格、图片尺寸、文件数量与总大小 |
| composerAncestors / lastTurnAncestors | 容器层级、布局尺寸和滚动位置，用于分析当前展示视图 |
| STRUCTURE.markup | 自动采集的脱敏标签结构，和对应快照共用 id；不是可执行网页 |
| CAPTURE-FAILED / FINAL-INCOMPLETE | 页面或文件不可用、采集超时、关闭时最终快照不完整 |
| COVERAGE | 自动观察到的元素、操作数量、快照/结构数量和失败次数，不宣称功能测试通过 |

用户/助手的角色只有存在证据时才标记；没有现有助手标记的消息保留 unclassified，不猜用户身份。
虚拟滚动卸载的历史不会被补齐，data-virtual-list-item-key 仅为临时位置，不能用于持久消息或执行幂等标识。
当前选择器独立复制自 src/shared/platforms.ts 的 DEEPSEEK_PAGE；适配器修改时应同步检查。
发送和停止曾共用类名，日志只记录实际控件及变化，不根据类名或短暂无变化宣告“生成完成”。

## 数据与静态检查

日志不保存聊天正文、草稿、附件名、图片地址、链接目标、页面标题、Cookie、Token、认证头或 storage。
未知控件标签只记字符数；会话编号替换为摘要，URL 查询参数不落盘；脱敏结构移除正文与外部资源。
文件选择只记录数量和总字节数，脚本不选择、读取或上传任何附件。

日志使用 fs.appendFileSync 同步追加到系统临时目录。只注册一个 onBeforeSendHeaders 身份处理器，不重复注册 webRequest 监听器。
页面观察器按本轮唯一标识只安装一次，重载后重新安装。
启动时通过 vm.Script 解析实际序列化后的两个页面脚本，避免只检查外层 CommonJS 语法。

构建通过只说明静态检查完成；真实采集等待用户运行，设计在读取本轮日志之后开始。
