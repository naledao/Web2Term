# 第 33 项：AI 自主诊断与换路径

本项在 computer 工具的实际结果中加入结构化 `diagnosis`，帮助 DeepSeek 结合原目标、最新观察和当前工具能力选择下一步。客户端负责提供已知事实和可用选项，不自动执行修复脚本，不固定“失败后依次调用哪些工具”的流程。

现有系统提示词、助手角色、工具请求 JSON、协议版本和自动／手动确认规则保持原样。仅在既有 computer 工具说明中补充诊断字段的含义和使用规则：常规窗口定位、焦点修复、控件失效和方法调整优先由 AI 处理；确需用户提供缺失资料或授权时，沿用原有提问与确认规则。

## 诊断从哪里来

`TaskProgression` 取得执行器回执后，`TaskCoordinator` 在结果落盘和发送前结合运行预算信号生成诊断。分类依据是实际 `code`、`execution`、明确的空发现结果、操作后观察错误以及本次有效观察中的控件完整性。不解析错误消息里的自然语言来猜测根因，也不把网页／控件文本改写成客户端指令。

诊断不覆盖 `ok`、`code`、`execution`、原 `message`、`data` 或附件。输入已执行而截图失败时，执行事实仍为 executed；不能把缺图改成“未执行”。正常完整的成功结果不增加诊断，部分控件树、空发现结果和操作后观察失败即使 ok=true 也可以携带诊断。

| 结果信号 | 诊断类别 | 可供模型选择的方向 |
| --- | --- | --- |
| stale_catalog／stale_window／stale_observation／recovery_required | reference_stale | 刷新真实应用／窗口引用或重新观察，不猜测旧编号 |
| focus_denied／focus_unconfirmed／restore_required／window_blocked | focus_unconfirmed | 核对窗口状态、真实交互关系、焦点及新观察 |
| wait_timeout | loading_timeout | 核对等待条件和当前状态，再决定调整条件、有界等待或换工具；不直接断言加载故障 |
| wait_ambiguous | ambiguous_target | 缩小实际选择范围，不默认选择第一个窗口或控件 |
| 应用／窗口查询成功但本页为空 | target_not_found | 调整查询、重新发现或核对分页；空结果不证明应用不存在 |
| click／type_text／press_key／scroll／drag 的 failed／blocked | input_failed | 根据真实后状态调整定位或方法，不盲目重做输入 |
| 截图失败、操作后观察失败、只读结果校验失败 | observation_failed | 图片与控件读取之间换方法，保留原输入事实 |
| 当前观察中的 controls.complete=false | partial_observation | 使用已有窗口图像或换图像观察；部分树不能证明控件不存在 |
| 既有协议错误码 | protocol_error | 按当前动作定义、新令牌及真实引用修正请求 |
| unavailable | backend_unavailable | 依据实际能力选择其他已提供工具，不虚构可用桌面动作 |
| cancelled／inactive_context | context_ended | 不提供自动修复路径，尊重原任务取消与失效 |
| 其他未知／失败结果 | effect_unconfirmed／action_failed | 保留真实事实，先核对再决定下一步 |

类别描述的是已观察到的信号，不是已经证明的根因。例如超时可能来自条件不合适、窗口变化或业务尚未完成；客户端不据此直接重启应用。

## 返回字段

`computer_result.diagnosis` 包含：

- `category`、`basis=structured_tool_result`：结果信号的分类和来源。
- `facts`：原 action／code／execution、操作后观察是否失败，以及本次结果中有效观察的有界元数据。
- `may_have_side_effects`：是否属于可能已经生效的非只读动作。
- `requires_fresh_observation`：下一次桌面补救输入前是否需要新的 observe。
- `same_action_retry`：区分只读请求归属复核后可重新请求、修正请求后再选、先核对已生效事实，以及上下文结束停止。
- `candidate_paths`：当前实际可用的 computer 动作或既有 command／read_files 选项，附用途说明；没有自动执行的参数、命令或脚本。
- `guidance`、`model_selects_next_step=true`、`goal_verified=false`：由模型选择下一步，诊断和成功回传都不表示原业务目标完成。

最新观察摘要只包含真实 observation_id、target、window_id、观察时间和控件完整性；controls-only 使用控件树自身的观察时间。控件文本、选区、输入文字和截图字节不复制进诊断。原始观察和 PNG 继续使用同一结果的 data／附件交付，不为生成诊断额外截图或读取 UIA。

## 候选路径与工具边界

`SessionRuntime` 根据原任务当前真实归属、工具开关、平台／本机范围、helper 当前公布动作和既有文件能力提供诊断上下文。桌面动作仅从当前能力清单筛选；没有实际可用动作时不建议调用一个未来动作。command／read_files 沿用原有协议、执行器、文件边界和确认方式，不作为客户端直接调用的降级执行器。

候选项是一组可选方向，不要求按顺序执行。例如 UIA 部分结果可以使用已有图像；图像采集失败时可以考虑 controls；控件／图像定位方式调整由模型根据实际结果选择。建议不会提供猜测的 window_id、element_id、坐标或应用启动参数。

常规失败成功交付后，任务继续等待模型选择下一步。模型可以继续调用 computer，也可以使用现有终端和文件能力；不需要用户为每次定位或切换工具确认。用户原有手动执行、授权和任务暂停规则仍然有效。

## 已生效操作必须先核对

只读发现、观察、复核和条件等待失败，可以在任务归属仍有效时由模型决定重新请求；客户端不会自动重试这些动作。超时后的新等待仍使用原工具的期限和预算，不启动无界轮询。

点击、输入、打开、启动等非只读动作返回 executed 或 unknown 时，不能据“失败”或缺图认定没有副作用。已有有效操作后观察时，诊断指向本次 data 中的新证据，模型先查后状态再决定；输入事实仍为 unknown 时继续沿用第 32 项的新 observe 门槛。

当输入已执行但操作后观察失败，或已派发的失败动作没有有效后状态时，诊断要求 fresh observation。TaskCoordinator 记录 `recovery.reason=result_verification`，复用第 32 项的持久化门槛：取得当前任务的成功新 observe 前，只允许 list_apps／list_windows／observe，其他 computer 动作返回 recovery_required／not_executed。这不会把原 completed／executed 动作改成 unknown，也不会为补截图重新执行输入。

已确认执行结果和检查点按现有事务规则落盘；若检查点更新失败，仍尽可能单独保存执行器实际回执并停止推进。诊断上下文读取失败时使用空候选能力继续按实际回执分类；诊断不能让执行事实丢失或触发动作重跑。

## 保存、交付和恢复

诊断生成一次，随 `result_json` 和精确的 `delivery_text` 保存。busy／no-composer 或已确认未提交的交付重试复用原正文、诊断和附件，不重复动作、截图或诊断采集。提交未知继续按第 31—32 项停止重发，不把交付错误误当成桌面动作失败。

旧任务迟到的结果只更新原动作历史，不读取新目标的可用能力、不向新目标回传，也不能清除其恢复门槛。恢复原任务的历史摘要保留诊断类别及需核对状态，不恢复旧进程的候选能力或授权；启动和恢复仍须重新发现、观察。

## 范围和用户测试

本项提供诊断证据、可用路径和必要的后状态核对规则。第 34 项已接入重复动作／无进展检测、执行期限和可配置运行上限，诊断同时使用 progress_control 信号，详见 [运行控制说明](deepseek-computer-use-progress.md)；第 35 项的业务完成判定与完整产物验证仍待实现。本项不把诊断生成、工具成功或模型自述当成任务完成。

实现主要位于 `src/shared/computer-diagnostics.ts`、`src/main/task-progression.ts`、`task-coordinator.ts`、`session-runtime.ts` 和 `computer-recovery.ts`。结果类型、检查点原因和序列化回退分别更新在共享 computer／任务类型及 `computer-action-storage.ts` 中。

已编写 `tests/computer-diagnostics.test.mjs`：使用实际诊断／推进／协调代码、内存 SQLite 与合成回执，覆盖错误分类、可用能力筛选、只读与输入重试区别、最新观察与 controls-only 时间、部分树、空查询、超时／歧义、取消、后截图失败保留 executed、新观察门槛、跨工具接续、交付不重执行、元数据失败及旧任务迟到。

由用户运行：

```powershell
node --test tests/computer-diagnostics.test.mjs tests/computer-recovery.test.mjs tests/computer-action-states.test.mjs tests/computer-action-dedup.test.mjs tests/task-progression.test.mjs tests/task-tool-collaboration.test.mjs tests/task-continuity.test.mjs
```

真实 DeepSeek 页面及桌面行为由用户通过 `npm run dev` 启动后测试，智能体读取用户提供的日志再分析，不运行测试或启动 Electron／helper。

交付状态：构建通过，等待测试。构建和语法检查不代表功能已经验收。
