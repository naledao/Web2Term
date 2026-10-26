# 第 31 项：动作执行与交付状态分离

本项在第 30 项不可覆盖的接纳登记之上，增加 `computer_actions` 和 `computer_observations` 两张独立 SQLite 表。每个客户端执行 ID 分别保存动作生命周期、执行事实、结果正文及交付生命周期；一个动作可以是“已完成／输入已执行”，同时其截图交付仍处于“上传中／失败／未知”。交付失败不能把动作重置为待执行。

保持现有系统提示词、助手角色、模型工具 JSON 协议、自动／手动确认和桌面租约规则。任务概况继续使用原有步骤摘要，新增 `failed` 交付值用于表示已经确认未提交的失败；完整动作历史存入专用表，后续展示可调用主进程只读历史接口。

## 两个生命周期与一个执行事实

| 字段 | 状态 | 含义 |
| --- | --- | --- |
| `execution_state` | queued、dispatching、completed、failed、cancelled、unknown | 动作待执行、已经进入执行器、执行器成功返回、失败、取消或执行结果未知 |
| `execution_fact` | not_executed、executed、unknown | 原执行器实际返回的输入／调用事实；failed 或 cancelled 也可能携带 executed，不能据状态名假定没有副作用 |
| `delivery_state` | pending、uploading、sending、sent、failed、unknown、cancelled | 原结果等待交付、截图上传／提交中、文字提交中、已确认发送、已确认未提交的失败、提交未知或交付取消 |

`completed` 只表示这个工具动作已返回成功，`sent` 只表示原页面确认收到结果；两者都不表示整个业务目标完成。失败或未知的动作结果可以成功交付给模型，其执行状态不会因此变为 completed。

`computer_actions` 通过执行 ID 关联原接纳记录，保存原始结果快照 `result_json`、精确回传正文 `delivery_text`、交付尝试次数／当前尝试 ID、派发及返回时间。交付成功后保留历史正文，原任务步骤用于调度的临时 resultText 仍可清空。

`computer_observations` 通过执行 ID 保存本次结果中实际生成的截图引用、SHA-256、MIME 类型及交付状态。数据库不存截图字节、base64 或临时文件路径。图片文件继续由原观察服务按任务身份、散列和有效期管理；表中的历史引用不能作为再次输入或读取任意路径的授权。

## 派发、结果和交付的落盘顺序

1. 接纳请求时，在原任务／去重事务中同时创建 queued／not_executed／pending 的动作记录。
2. 真正进入执行器之前，将任务步骤和 dispatching／unknown 状态一起提交；数据库失败时不派发输入。
3. 执行器返回后，先单独保存实际结果与观察引用，再处理任务连续性摘要和回传正文。后续格式化、截图准备或发送失败不能覆盖已经保存的执行事实。
4. 保存原回传正文后，每轮交付生成独立尝试 ID，写入 uploading 或 sending 并递增次数，之后才调用页面发送器。
5. 发送器的真实回执只更新交付状态。结果和回传正文不可被另一份内容覆盖，已经派发或返回的动作不能再转回 queued／dispatching。

任务步骤与其交付状态在同一事务内更新；对照检查任务、会话、平台、代次和执行 ID。单独补记旧回执时只允许按不可变登记归属写历史，不更新当前任务。当前活动的执行凭据仍由第 27 项管理，持久状态不替代运行授权。

## 重试与不确定结果

页面 busy／no-composer 且能够确认尚未提交时，保留同一结果和截图，沿用原等待重试。已确认的文字插入失败、截图准备失败，或上传在进入提交阶段之前失败，记录为 failed；同一结果累计三次此类失败后停止自动交付，busy／no-composer 不计入失败次数。重试使用原有延迟调度，不重新执行动作、截图或消费令牌。正常页面状态通知不会绕过这段失败重试等待。

只有当前进程中仍保留的原结果可以参与交付重试。截图过期／缺失时不重做点击来补图；准备失败如实记录，连续失败后保留执行事实和正文，停止自动提交。暂停、换目标或关闭会话仍能阻止后续交付。

一旦进入提交阶段，丢失回执、IPC／页面变化、超时或实际提交状态不明均记为 unknown，停止自动重发。进入提交调用之后，即使返回 false 也不据此认定没有提交。普通文件与终端发送继续沿用原返回语义；新增的“确认未提交”分类只用于 computer 结果。

## 取消与迟到回执

- 排队期间取消：execution_state=cancelled、execution_fact=not_executed，交付 cancelled。
- 执行期间取消：暂记执行 unknown，交付取消；实际执行器迟到返回后可补记 completed／failed／unknown 及真实执行事实，不再交付到新目标。
- 结果返回后取消：保留执行事实，取消尚未开始的交付。
- 上传／提交期间取消：保留执行事实，交付先记 unknown；同一尝试随后取得真实正向确认时可补记 sent，仍不激活旧任务的下一枚令牌。

旧平台、其他会话／代次、其他执行 ID 或非当前交付尝试不能覆盖记录。取消、持久化错误或发送失败不会通过删除去重登记让同一动作重新执行。

## 类型隔离与已有数据库

桌面状态保存在独立表中，不经过 `executions.command`。终端存储入口拒绝 computer／未知工具类型；历史 `executions.kind` 为未知值时读取为 invalid，终端运行与历史重放均拒绝执行，不再默认回退到 command。

新表采用可重复执行的增量建表。升级前只有第 30 项接纳记录、没有结果证据的历史动作，补为 unknown；已知属于纯协议反馈的旧记录保留 not_executed。已有完整动作记录不会被这一步覆盖。

本项不从数据库重建执行器、排队请求、步骤令牌或附件上传能力。第 32 项已接入异常退出时残留 dispatching／uploading／sending 状态的统一归类、检查点和用户显式恢复原任务后的重新观察门槛，详见 [异常恢复说明](deepseek-computer-use-recovery.md)。

## 代码与用户测试

状态类型位于 `src/shared/computer-actions.ts`；SQL 状态转换位于 `src/main/computer-action-storage.ts`；任务事务与只读历史接口位于 `src/main/db.ts`；实际落盘时机、交付重试和取消位于 `src/main/task-progression.ts`。`SessionRuntime`、`ChatGptEmbed` 和 `page-files` 区分准备／上传失败与提交未知。

已编写真实内存 SQLite／合成执行器与页面回执用例，覆盖输入成功但上传失败、同一结果重试、三次失败停止、提交未知、执行器失败／异常、取消及迟到回执、结果／发送确认写入失败、观察元数据、旧记录升级、跨归属／尝试隔离及未知类型拒绝。测试不使用用户数据库，不启动真实进程或操作桌面。

用户可运行：

```powershell
node --test tests/computer-action-states.test.mjs tests/computer-delivery-classification.test.mjs tests/computer-action-dedup.test.mjs tests/task-progression.test.mjs tests/background-execution-storage.test.mjs tests/recent-command-run.test.mjs
```

交付状态：构建通过，等待测试。智能体未运行测试、启动 Electron／helper、执行真实命令或操作真实桌面；构建和语法检查不代表真实功能已经验收。
