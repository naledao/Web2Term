# 第 32 项：异常退出与未知结果恢复

本项补齐客户端启动恢复、helper／执行器结果未知后的重新观察门槛，以及用户显式恢复原任务的入口。computer use 仍是一个工具，现有系统提示词、助手角色、模型请求 JSON、终端／文件协议和自动／手动确认规则保持原样。

启动和打开历史只恢复记录。用户在原会话的任务概况中展开详情、点击“恢复原任务”后，软件通过既有用户消息通道发送恢复上下文；只有网页确认这条消息已经发送，才建立新任务编号、任务代次和步骤令牌。AI 随后根据真实观察及产物核对决定下一步。

## 启动时的状态收敛

`ConversationStore` 在建表和迁移后、会话运行时创建前执行 `recoverInterruptedComputerActions`。动作、截图交付状态和活动任务检查点在同一个 SQLite `BEGIN IMMEDIATE` 事务中恢复；失败则整体回滚并抛出，不带着部分恢复状态继续启动。

| 崩溃时保留的状态 | 启动后的状态 | 保留的事实 |
| --- | --- | --- |
| queued | cancelled／not_executed | 尚未进入执行器，不自动派发 |
| dispatching | unknown／unknown | 可能已经生效，不能按未执行补跑 |
| completed、failed、cancelled、unknown | 原执行状态和 execution_fact | failed／cancelled 也可能已经执行，不能据名称抹去事实 |
| pending、failed 交付 | cancelled | 本进程中的交付缓冲和附件授权不恢复 |
| uploading、sending 交付 | unknown | 上传／提交可能已完成，不能自动重发 |
| sent、unknown、cancelled 交付 | 原交付状态 | 已确认送达和未确认送达保持区别 |

`result_json`、`delivery_text`、交付次数、派发时间、不可变请求登记、截图 ID／SHA-256／MIME 元数据保持原样。截图交付状态同步为所属动作的恢复状态，不重建 PNG 文件、上传令牌或旧观察输入权限。重复执行恢复不会把 unknown 重新变成 queued，也不会改写已经中断的任务检查点。

活动任务由 recorded 转为 interrupted，等待中的后台依赖改为 cancelled。保留原始目标、全部用户补充、附件元数据、机器信息及已有 continuity 应用／窗口／资源索引；本项没有把“打开过文件”升级为“产物已经验证”。最近 computer 步骤以独立动作表中的真实执行／交付事实为准，避免崩溃发生在结果已落盘、步骤摘要尚未更新之间时丢失事实。清空步骤临时发送正文和旧步骤令牌，旧请求回执继续作为只读历史保存。

## 检查点与重新观察门槛

任务 payload 中新增经校验的 `recovery` 字段：版本、原因、来源任务／代次、检查点时间、是否需要新观察、未知执行 ID，以及后来取得的新观察步骤 ID。它是状态说明，不是执行凭据；损坏的检查点不会被静默忽略并恢复运行。

主进程记录当前步骤的未知结果时，将实际结果与 `requiresObservation=true` 一起提交。这个规则覆盖 helper 崩溃、通信丢失、执行器异常和无法确认输入事实的实际回执。派发前明确未执行的失败不会被伪装为已执行。

如果任务检查点更新失败，但独立动作表仍可保存实际回执，则先单独保住动作结果，再按持久化错误停止推进，不交付结果、不释放下一步令牌。检查点失败不能把已经返回的 executed 事实抹掉；整个数据库不可写时仍保留派发前的 unknown 记录供下次启动恢复。

门槛生效期间，computer 工具允许 `list_apps`、`list_windows` 和 `observe`，便于模型重新找到目标。其他 computer 动作返回 `recovery_required`、execution=not_executed，不获取输入执行机会；这份反馈照常消费一个新步骤、登记并交付，不重用上次动作。只有当前任务／代次当前步骤的 `observe` 成功返回 executed，才解除门槛；发现窗口、观察失败、历史截图或旧任务迟到的成功回执都不能解除。

第 33 项进一步将输入已执行但操作后观察失败、或失败的非只读动作缺少有效后状态的情况登记为 `result_verification`，沿用这里的新观察门槛；原动作的 executed 事实保持不变，详见 [自主诊断说明](deepseek-computer-use-diagnostics.md)。

恢复状态随 `computer_result.task_recovery` 提供给模型。取得观察后仍沿用现有发送确认、步骤令牌、窗口身份、helper 代次、观察有效期和坐标复核规则。重新观察成功只说明取得了新界面证据，不表示整个业务目标已经完成。既有终端和文件工具仍可用于核对真实产物，执行与确认规则沿用原路径。

## helper 异常退出

复用 WindowsHelperManager 的现有监督链路：已派发请求失去 helper 回执时返回 unknown；未派发的请求保留 not_executed。管理器按已有预算等待旧进程退场后重启，不重发原请求。新进程使用新 generation，原应用／窗口／观察引用不能借此恢复；全局桌面协调器继续等待 helper 退场屏障。

本项在这一真实未知回执后持久化重新观察门槛，不另起 helper、监控进程或探针。软件关闭后进程内租约、排队动作、待发送附件和步骤令牌不会从数据库恢复。

## 用户恢复原任务

恢复入口仅对原 DeepSeek 会话中的 interrupted／stopped 任务或交付受阻的 recorded 任务提供。主进程复核管理界面 IPC 来源、会话／平台、任务编号／代次、本机身份、当前能力、暂停状态、已有工作和待回答问题；页面仍沿用原生草稿、附件、生成中等发送保护。对仍处于 blocked 的活动任务，先停止旧任务的交付及重试，再发送恢复消息，防止旧定时器与恢复回合交错。

恢复消息明确包含原目标、补充要求、原附件元数据、已知资源和窗口线索、最近动作的执行事实／交付状态，以及实际结果中的有界信息摘录。最多取最近 32 个动作，使用第 33 条判断是否还有更早记录；不发送原 wire 请求、步骤令牌、截图字节或可执行队列。消息受原生用户发送的 20,000 字符限制，优先保留完整用户要求；较早的窗口、动作、资源摘要按需裁剪，并附裁剪标记，数据库内原记录保留。仅用户要求和必要元数据就超过限制时明确报错，不悄悄截断目标。

恢复发送确认后，新任务保留原 originalRequest、用户输入和 continuity，使用新的任务编号、generation、来源用户发送编号和 computer 令牌。旧 currentStep、工具请求、后台等待及执行授权都不复制。新任务再次要求新观察；用户无需逐步指定应用、窗口或补救动作。

发送 busy／no-composer／明确插入失败等可确认未提交的结果，允许用户处理页面后重新点击恢复。发送确认丢失、异常返回或调用异常时保留当前进程的待确认恢复意图，不自动重发；同一文档内再次点击会提示先核对原对话。迟到的真实确认仍可建立恢复任务，但切换平台／会话、替换目标或文档更新后的旧确认不能创建或覆盖新任务。软件再次启动不会从历史恢复这份待发送意图。

任何检查点都不能证明崩溃期间的操作严格只执行一次。恢复后由模型结合界面、文件内容及实际产物核对，决定补救或继续；已经生效的操作事实必须保留。

## 范围与后续项目

本项提供异常恢复所需的入口、持久状态和新观察门槛。第 36 项完整的暂停／恢复交互仍待实现；用户主动暂停不会被这个入口自动解除。第 42 项完整的上下文管理、证据摘要策略及长任务接续仍待实现；本项不自动新建 DeepSeek 对话。

代码涉及 `src/main/computer-recovery.ts`、`db.ts`、`task-coordinator.ts`、`task-progression.ts`、`session-runtime.ts`、`embed.ts`、管理界面 IPC／preload，以及 `src/renderer/src/components/AutonomousTaskSummary.tsx`。共享任务类型与恢复返回码分别在 `src/shared/autonomous-task.ts`、`computer-use.ts` 中声明。

## 用户测试

已编写 `tests/computer-recovery.test.mjs`，使用实际内存 SQLite、实际恢复／任务协调／推进代码和合成页面回执，覆盖排队／派发／结果已落盘／上传／提交各时机、重复恢复、截图元数据、事务回滚、显式恢复归属、新代次、新观察门槛、旧结果迟到、恢复确认丢失、草稿忙碌、受阻交付退场，以及消息边界和损坏检查点。既有 helper 测试已经包含崩溃返回 unknown、新进程 generation 变化和不重放请求的用例。

由用户运行：

```powershell
node --test tests/computer-recovery.test.mjs tests/computer-action-states.test.mjs tests/computer-action-dedup.test.mjs tests/computer-delivery-classification.test.mjs tests/windows-helper.test.mjs tests/autonomous-task-entry.test.mjs tests/task-progression.test.mjs tests/task-continuity.test.mjs tests/project-terminal-notes.test.mjs tests/workspace-projects.test.mjs tests/web2term-environment.test.mjs
```

真实会话测试仍只通过 `npm run dev` 启动：在可丢弃的示例任务上分别检查客户端中断、helper 中断、结果发送中断及恢复后先观察的行为。由用户运行并操作，智能体只读取用户提供的日志，不启动 Electron／helper、不运行测试、不操作真实桌面。

交付状态：构建通过，等待测试。构建和语法检查不代表真实功能已经验收。
