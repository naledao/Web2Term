# 选中文字后按 Enter 获取 DeepSeek 分享链接

这是单独的直接流程测试：**打开原会话 → 选中回答文字 → 点击“询问 AI”输入框 → Enter → 获取链接**。
不需要手动创建分享，不用 F6/F7/F9，不依赖旧测试的消息 `[20,19]` 或请求模板。

先关闭正常应用及其他探针，在仓库根目录运行：

```powershell
.\node_modules\electron\dist\electron.exe .\tools\diag\deepseek-selection-share-probe.cjs
```

1. 在探针中打开要测试的**已有会话**，等约 3 秒，让本轮页面的历史请求完成。
2. 在一条 DeepSeek 回答正文中选中文字，点击浮出的“询问 AI”输入框。
3. 输入问题并按 Enter。为单独测试获取链接，空问题也允许；Shift+Enter 换行，输入法选字的回车不触发。
4. 成功后，窗口标题和终端显示分享链接，并自动复制至剪贴板。
5. 检查网页中没有出现分享弹窗，并核对链接中的消息范围。可以通过“测试”菜单记录人工检查结果。
6. 关闭探针，把终端打印的 `.log` 路径交给智能体。

这一步只获取分享链接，不新建聊天、不把问题发给模型。复用 `persist:deepseek` 登录分区，
进程内代理默认 `http://127.0.0.1:7897`；支持 `PROBE_PROXY`、`PROBE_USER_DATA`、
`PROBE_START_URL`，不修改系统设置。

消息数据来自这次打开会话时实际收到的 JSON 历史响应。探针把选区所属回答的正文与服务器
消息唯一匹配，取得真实消息编号；`data-virtual-list-item-key` 只记作观察值，不用于构造编号。
识别到父消息关系时沿父链取截至所选回答的历史；没有父关系但服务器消息编号顺序明确时
使用该列表的前缀，日志注明 `server-array-prefix-needs-range-check`，须人工核对范围。
消息结构、正文、顺序或编号无法唯一确认时，直接记录原因，不猜编号、不打开分享弹窗。

`POST /api/v0/share/create`、`chat_session_id`、`message_ids` 和返回的
`data.biz_data.share_id` 已由前一轮用户测试确认。历史响应结构的识别仍需本轮日志确认；
如果未识别成功，`HISTORY-SCHEMA` 保留字段结构供修正，原文和凭据不落盘。

日志和本轮操作说明位于 `%TEMP%\gpt-login-diag\`：

```text
deepseek-selection-share-<timestamp>-<pid>.log
deepseek-selection-share-<timestamp>-<pid>.txt
```

| 事件 | 用途 |
| --- | --- |
| `HISTORY-REQUEST` | 实际会话历史请求路径，不猜接口、不主动额外请求历史 |
| `START` / `PROXY-READY` / `WINDOW-CREATED` | 启动和窗口创建阶段 |
| `NETWORK-ENABLE-START` / `NETWORK-READY` | 网络观察器初始化，和页面加载并行进行，不阻塞首个页面 |
| `PAGE-LOAD-START` / `PAGE-LOADED` | 页面开始加载及完成，便于定位空白窗口 |
| `LOAD-FAILED` / `RENDER-PROCESS-GONE` | 页面加载或页面进程失败；同时在标题显示提示 |
| `HISTORY-READY` | 识别到的消息编号、角色、父关系和正文长度/摘要 |
| `HISTORY-SCHEMA` | 暂未识别的实际响应字段结构，字符串不保存原文 |
| `QUESTION-ENTER` | 选区与问题长度，来源会话摘要和临时虚拟行号 |
| `SELECTION-BLOCKED` | 无消息数据、正文重复或其他无法确定的情况 |
| `CREATE-START` | 本次匹配的回答编号、实际提交的消息范围 |
| `CREATE-RESPONSE` | HTTP 和业务返回结构 |
| `SHARE-LINK` | 实际取得的分享链接和复制结果 |
| `USER-CHECK` | 用户明确核对的弹窗与范围结果 |
| `COVERAGE` | Enter 尝试次数和成功次数；不把缺少证据当成成功 |

认证头、会话正文、问题正文只在内存使用，不写日志；只持久化字段结构、长度/摘要、
消息编号和关系、状态、最终分享链接。使用同步 `fs.appendFileSync` 写日志，单窗口仅一个
CDP 观察器，不注册重复 `webRequest` 监听器。请求有 15 秒时限、并发锁和会话切换中止，
不自动重试或自动回退到网页分享流程。

构建通过只说明静态检查完成；真实流程由用户运行，智能体不启动 Electron 做测试。
