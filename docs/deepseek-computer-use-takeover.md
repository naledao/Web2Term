# 第 38 项：人工接管与异常焦点处理

交付状态：**构建通过，等待测试**。已补充合成输入、管道、协调器和任务恢复用例；未运行测试，未启动 Electron／helper，未操作真实桌面或 DeepSeek 会话。

## 用户体验与触发规则

用户仍然只需布置目标，AI 根据现有工具说明自主操作。应用启动、自己的点击、组合键打开窗口和业务弹窗产生焦点变化，都不会单独触发人工接管。

AI 持有全局桌面控制权期间，用户真实的键盘按下、鼠标按下或滚轮输入视为明确接管。原任务显示“人工接管 · 任务已暂停”，保留原始要求、补充要求、执行记录与未完成原因。其他任务也不能趁此获得桌面控制权。用户点击“继续原任务”后，等待旧执行器退出，向原会话发送可见恢复消息；原生发送确认后才建立新任务代次，先重新观察，再由模型决定后续步骤。空闲、焦点恢复和 helper 重启都不会自动继续。

单独移动鼠标、松开鼠标或松开键盘，不据此认定接管。这个规则用于避免用户只是查看进展时暂停任务；动作执行期间仍有原来的目标、鼠标位置、按键占用与焦点核对。

| 实际事件 | 归类 | 处理 |
| --- | --- | --- |
| 注入标记与本 helper 匹配的 SendInput | helper 自己的输入 | 不触发接管，不吞掉系统事件 |
| 真实键盘 down／sys-key-down、鼠标 down、横向或纵向滚轮 | 明确人工接管 | 原生立即关闭后续输入闸门，主进程暂停原目标并保留结果，等待明确继续 |
| 其他标记的注入输入 | 外部干扰 | 停止当前控制、使旧观察失效并更换 helper；任务保留，要求新 observe，由模型自主换路径 |
| 仅前台窗口变化，包括 AI 点击、启动、弹窗和无法解释的变化 | 焦点变化 | 旧输入观察失效；输入前仍须核对身份、当前窗口和实际焦点。需要时由模型发现、观察、激活并复核窗口 |
| 移动鼠标、key-up 或 mouse-up | 不构成单独接管证据 | 继续依赖实时输入路由核对，不据此抢焦点或暂停整个目标 |
| 旧 watch 的迟到事件 | 历史事件 | 不将替换后的任务标为人工接管；若原生进程已经关闭输入闸门，按外部干扰退役该进程并重新观察 |

这里的“真实／注入”根据 Win32 低级事件的 injected 标志和 ExtraInfo 区分，不记录键码、输入文本、坐标、窗口标题。它用于输入归因，不作为对恶意同权限进程的身份认证。

## 原生监测与输入停止

`DesktopActivityMonitor` 使用独立消息线程注册 `WH_KEYBOARD_LL`、`WH_MOUSE_LL` 和 `EVENT_SYSTEM_FOREGROUND`。只有主进程持有有效桌面 owner 时才设置 watch；没有桌面任务时不会把用户正常输入关联成任务接管。

低级钩子不等待 UIA、管道或 SendInput 的持有锁。明确人工输入或外部注入一经识别，先执行无锁 `RequestStop`，阻止后续 SendInput／UIA 写入；再在线程池中取消实际动作、尝试释放本 helper 已提交且仍持有的按键和鼠标按钮，并发布事件。事件一直传给 `CallNextHookEx`，不拦截用户输入。已提交到 Windows 的批次或已经进入应用的调用可能已生效，取消不代表撤销。

UIA 文字写入、点击语义操作、窗口激活／恢复与应用／资源启动都检查同一停止闸门。旧 helper 停止后不重新打开输入闸门，必须退出并使用新进程。首次握手时钩子安装失败则不声明桌面写入动作；握手后的监测失效会关闭输入并退役。执行前的监测／watch 检查失败返回 `input_monitor_unavailable`，不把未监测的桌面写入当作正常可执行。

原有窗口生命周期、观察版本、真实前台窗口、GUIThreadInfo、输入桌面和忙碌按键核对继续生效。单纯收到焦点事件不会自行执行 `focus_window`，模型依据真实结果选择窗口和恢复方法；异常焦点且没有可用后观察时，诊断要求先取得新观察，不能继续使用旧定位输入。

## 私有协议与任务归属

Windows helper 私有协议升级为 **v4**，旧 v3 helper 必须重新构建。模型侧 computer JSON 仍为 v1；原系统提示词、助手角色和其他工具的调用及确认规则不变，只增加 computer use 工具说明中的接管／焦点规则。

主进程根据 `DesktopCoordinator` 的真实 owner 签发随机 watch id，绑定 session、platform、conversation、task、generation、machine 和当前 helper 进程代次。`watch_desktop` 控制帧在同一 stdin 中先于动作请求写入；动作请求携带该 watch id，helper 执行桌面写入前再次检查监测可用性、watch 和进程代次。

`desktop_activity` 仅包含协议版本、helper 代次、watch id 和分类，不开放给网页或模型。主进程独立校验，再由会话运行器复核实际任务归属。旧 watch 的物理事件不能暂停新目标；旧 helper 代次或畸形帧沿用协议错误退役处理。

## 暂停、结果与继续

人工接管会关闭应用级桌面协调闸门，撤销当前 owner 的输入资格。正在执行的 permit 继续持有，直到真实执行器返回；其他会话排队保留，但不会因原任务释放 owner、焦点恢复或进程空闲而获得控制。

原任务沿用现有取消／恢复链路，持久化为 `status=stopped`、`stop.reason=human-takeover`，界面按“暂停”展示；不另建可绕过原恢复校验的恢复协议。立即撤销后续自动请求、结果重试、步骤令牌和旧观察，取消前台命令及页面生成，独立后台进程继续运行。迟到结果只补充原动作历史，已知执行事实仍保留，取不到实际回执则记 unknown；不会通过取消推断“未执行”，也不会重放历史动作。

用户明确结束任务或全局急停优先于同一次鼠标点击先触发的人工接管，持久化最终明确的停止原因。全局急停保持原有锁定和解除规则。

恢复仍核对原会话、机器、任务代次、页面代次、运行预算和真实发送确认。旧执行器／原生进程尚未退出时拒绝继续。确认恢复后创建新代次，保留原要求和历史线索，但不恢复旧动作、观察、输入权限或发送缓冲；新 observe 成功之前，恢复屏障拒绝输入。用户也可以明确发送新目标，原生提交确认后按同样的退出条件释放人工控制闸门。

外部注入不暂停为“人工接管”：本轮输入停止，helper 退役，实际回执以 `external_input` 回传，执行事实原样保存。诊断要求新观察，主进程保留任务并让模型重新发现窗口、核对后状态、调整方法或选择现有其他工具，不替模型自动重做动作。

## 代码与用户测试

- 原生归因与钩子：`native/computer-use/windows/DesktopActivityPolicy.cs`、`DesktopActivityMonitor.cs`。
- 原生无锁停止与原有按住输入跟踪：`HelperInputState.cs`；管道事件及动作回执：`Program.cs`。
- 主进程 watch、回执保留及退役：`src/main/windows-helper.ts`；全局协调：`desktop-coordinator.ts`；会话暂停与确认恢复：`session-runtime.ts`。
- 暂停原因持久化及恢复摘要：`task-coordinator.ts`、`computer-recovery.ts`、`src/shared/autonomous-task.ts`。
- 异常回执独立处理及焦点诊断：`computer-use-tool.ts`、Windows 适配器、`src/shared/computer-diagnostics.ts`。
- 任务状态和继续入口：`src/renderer/src/components/AutonomousTaskSummary.tsx`。

由用户运行的离线测试：

```powershell
node --test tests/desktop-takeover.test.mjs tests/windows-helper.test.mjs tests/computer-use-tool.test.mjs tests/desktop-coordinator.test.mjs tests/computer-diagnostics.test.mjs tests/computer-recovery.test.mjs tests/emergency-stop.test.mjs tests/windows-observation.test.mjs tests/windows-app-catalog.test.mjs tests/windows-window-catalog.test.mjs
dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj
```

新增用例覆盖自身标记排除、物理 down／滚轮与 up／move 的区分、其他注入来源、无锁停止不等待 SendInput、watch 先于派发、焦点变化不取消任务、旧 watch／进程代次隔离、真实回执与未知结果保留、全局人工控制阻止其他任务获得桌面、明确结束优先级、恢复新代次和观察屏障。

真实桌面测试仍由用户使用 `npm run dev` 启动：让 AI 打开应用、点击弹窗、通过快捷键切换窗口，确认没有误判接管；执行过程中真实按键、点击或滚轮，确认暂停且排队任务没有接着操作；再点击“继续原任务”，确认先取得新观察、核对已发生操作后继续。还需在真实 Windows 环境确认钩子可用性、输入驱动和目标应用的行为；构建通过不能替代这些测试。
