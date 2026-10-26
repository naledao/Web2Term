# Windows helper（第 07—23 项）

此项目提供独立进程、stdio 协议、父进程监督和 MTA 工作线程。第 08—23 项已注册 `list_apps` 应用发现、`launch_app` 应用启动、`open` 资源打开、`list_windows` 窗口发现、`focus_window` 窗口激活／恢复、`observe` 截图／控件／焦点观察、`validate_observation` 只读复核、`click` 点击／双击、`type_text` 文字输入、`press_key` 按键／组合键、`scroll` 区域滚动、`drag` 拖拽／基础画布输入、`inspect_interactions` 菜单／弹窗关联发现及 `wait_for` 条件等待；其他动作由后续功能注册。Shell 启动使用独立 STA 线程，窗口元数据、UIA 控件／焦点和 WGC 截图在 MTA；窗口创建／销毁事件使用独立消息循环。主进程只声明与真实 helper 同时已接入的动作，不接受脚本或命令字符串执行。

## 构建与启动

- Windows x64 开发机需要 .NET 8 或更高版本 SDK，以及本机已有的 .NET 8 引用包、win-x64 宿主包和 `Microsoft.Windows.SDK.NET.Ref 10.0.19041.57`（WGC／C#/WinRT 投影）。构建使用缓存中的固定版本，不联网恢复；缺失依赖时应单独准备依赖后再构建。截图要求 Windows 10 2004（19041）或更新版本。
- `npm run build` 会在现有类型检查与前端打包之后编译 helper 到 `out/windows-helper/`。构建脚本只使用本地 NuGet 源，随后以 `--no-restore` 编译，不启动 helper、不联网下载依赖。
- 完成构建后，项目仍然只用 `npm run dev` 运行。开启 computer use 和桌面控制，并进入活动的本机 DeepSeek 会话时，由 Electron 主进程按需启动 helper，无需单独运行它。
- 开发产物依赖本机 .NET 8 运行时。面向最终用户的自包含发布、Windows 安装资源与 CI 属于第 44 项；主进程已预留打包后的 `resources/windows-helper/` 路径，缺失时明确报告不可用，不回退到任意 PATH 程序。
- 其他系统的 `npm run build` 跳过此项目，不影响既有 macOS/Linux 构建。

## 私有通信协议

使用继承的 stdin/stdout 管道传输 UTF-8 JSON Lines，不开放 HTTP 或固定命名管道。每个实例有独立进程代次；所有私有消息携带 `version: 4`。第 15—16 项要求可信观察绑定及物理坐标契约，握手拒绝 v1／v2／v3 helper；模型侧 computer JSON 仍保持 `version: 1`。stdout 只用于协议；stderr 只输出固定诊断码，不写参数、路径、窗口文字或输入内容。

1. 主进程发送 `hello`：随机 `id`、随机 `nonce`、`parent_pid`。
2. helper 返回 `ready`：回显 `id/nonce`，声明真实 `pid`、`arch: x64`、`apartment: MTA`、`elevated` 和编译注册的 `actions`。主进程核对后才允许发送动作。普通 `asInvoker` 启动，不申请 UAC 提权；继承 Web2Term 的权限，以管理员身份运行（含 UAC 关闭的管理员账号）时 `elevated: true`，仍可正常就绪，此时可操作的窗口范围包括管理员窗口。
3. 动作通过 `request` 发送，字段固定为 `id`、`epoch`、`action`、`parameters`、`timeout_ms`。此入口仅供主进程中已实现的动作适配器使用，不暴露给网页或渲染进程；helper 动作声明也不能自动替代主进程注册和第 06 项校验。
4. `result` 回显 `id/epoch`，包含 `ok/execution/code/message/data`。每次最多一个动作；取消和超时不能被解释为操作已经回滚。已派发后失联，结果为 `unknown`，不得自动重放。
5. `ping/pong`、`cancel/cancelled` 和 `shutdown` 在读管道线程处理，不排进 MTA 队列。取消回执仅证明收到取消信号；仍需动作结果，超过取消宽限就终止进程。

限制：请求帧最多 64 KiB，结果帧最多 256 KiB；helper 在分配完整帧前限制输入长度，拒绝重复／危险字段、未知控制消息、嵌套过深和超量集合。握手 5 秒，空闲心跳间隔 3 秒、响应期限 2 秒；动作默认 15 秒，可由主进程设置为 100 ms 至 120 秒。停止／取消的宽限为 500 ms，随后强制终止；独立 native 看门狗也会结束超时工作进程。

## 生命周期与隔离

- 全应用共享一个管理器，多会话幂等登记需求；没有活动且已授权的本机 DeepSeek 会话时关闭 helper。设置关闭、平台／会话／连接切换及会话销毁会释放需求。
- 启动、读写和等待均异步；UIA 在无窗口的独立 MTA 线程运行，COM 对象不会返回主线程。后续 UIA 驱动应在此线程创建、使用和释放对象。
- 普通故障按需进行有界重启：每分钟最多启动三次，初次失败后等待 1 秒、第二次失败后等待 2 秒；不重放动作。版本／格式／权限错误及产物缺失不自动循环重启。新的进程必须重新握手，旧进程的迟到响应直接丢弃。
- 父进程退出或 stdin EOF 时 helper 退出。关闭应用时主进程主动关闭管道并终止子进程；阻塞的 MTA 不妨碍控制通道或父进程监督。

## 待用户测试

`tests/windows-helper.test.mjs` 使用模拟管道和时钟覆盖管理器与会话需求生命周期，运行命令为 `node --test tests/windows-helper.test.mjs`。真实启动、权限、父进程退出和 native 管道行为仍需用户在 Windows 上验收。按仓库约定，智能体只编写测试，不运行测试或启动 Electron/helper。

线程与进程 API 依据：[微软 UI Automation 线程说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)、[Node.js child_process](https://nodejs.org/api/child_process.html)。

## 应用发现 list_apps

`ApplicationCatalog` 在 MTA 上维护当前目录快照和启动引用；`WindowsApplicationDiscovery` 通过 Windows API 采集以下来源：

- Applications 虚拟目录：枚举真实 Shell item，读取名称、系统提供的解析引用及可获得的 AppUserModelID。
- 开始菜单：扫描用户和公共 Programs 目录，仅读取 `.lnk` 和实际 `.exe`；读取快捷方式目标与已有参数，不调用 Resolve、不修复链接、不执行目标。不能核实为 exe 的文档／脚本／失效快捷方式可保留名称候选，但不发布启动引用。
- App Paths：读取 HKCU/HKLM 的 32/64 位注册视图，使用真实默认路径并核实文件。不会根据名称搜索或拼接猜测路径，也不会把包含命令参数的字符串当成 exe 路径。
- 运行进程：读取可获得的可执行路径、AppUserModelID、PID 和创建时间；将同一进程创建身份下的可见／最小化顶层窗口概况关联给应用。无权限取得的信息保留为空，并标记来源受限。

按实际身份合并：相同 exe 的普通入口可以合并别名和来源；不同 AppUserModelID、不同路径，以及带独立参数用途的快捷方式不会仅凭同名合并。`app_id` 根据真实身份生成，`launch_references` 根据核实的系统引用／文件身份生成，实际启动描述保留在 helper 内，不接受模型覆盖路径或已有参数。第 09 项已在派发前重新核对当前引用、实际 Shell 项与文件状态；快捷方式引用还绑定原始文件的 SHA-256、实际目标及已有参数。

调用参数：

| 参数 | 规则 |
| --- | --- |
| `query` | 可选，最多 200 字符；按名称、别名和实际路径进行忽略大小写的子串查询。空值列出候选，带窗口的应用优先。 |
| `limit` | 默认 12，范围 1—25；实际页长还受结果字节预算限制。 |
| `cursor` | 原样使用上一页 `next_cursor`，保持相同 query；绑定目录快照，最长两分钟有效。 |
| `refresh` | 可选布尔值，重新采集；不能与 cursor 同时使用。无 cursor 时可复用 30 秒内的快照。 |
| `register_path` | 从现有文件／终端工具取得的真实本机绝对 exe 路径；不能与 cursor 同时使用。主进程解析真实路径并读取 PE 头，helper 再核实实际文件及格式后临时登记；不接受 UNC、设备路径、替代数据流、脚本、DLL 或不存在的文件。最多登记 128 项，刷新时删除已失效项。 |

返回 `catalog_id`、采集时间、应用清单、匹配总数、分页信息及每个来源的 `complete/partial/unavailable` 状态。应用项包含名称、别名、来源、可获得的真实 exe 路径、核实后的启动引用及进程／窗口概况。`list_apps` 中的 `hwnd` 只是此次采集的元数据，不产生可供后续动作选择的 `window_id`；此类引用由第 11 项 `list_windows` 独立登记。

目录最多 4096 项，来源采集有数量和约 10 秒软预算；阻塞的系统调用仍受 30 秒动作期限与 helper 看门狗监督。每项最多 8 个别名、4 个启动引用、8 个进程及每进程 4 个窗口；截断和访问失败会标记不完整，单页按 180 KiB 数据预算裁剪。零匹配不等于未安装，AI 可以换关键词、刷新或借助现有文件／终端工具找到真实路径。

主进程独立校验返回字段、身份格式、数量、路径和分页结构，仅登记当前任务上下文与当前 helper 代次中的有效结果。切换快照、helper 重启／停止、格式异常或过期目录反馈时清理旧引用；结果不确定时不假装已登记。此流程不增加用户预选应用、逐步确认、视觉自检或新的系统角色提示。

测试由用户运行：

- `node --test tests/windows-app-catalog.test.mjs tests/windows-helper.test.mjs`：主进程协议、参数、PE 读取、结果校验、旧任务／旧进程隔离和运行管理，全部使用模拟 IO。
- 原生目录合并／分页等测试位于 `tests/native-app-catalog/`，无需测试框架包。完成项目构建后，可先用 `dotnet restore tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --source out/windows-helper-offline-feed -p:NuGetAudit=false` 从本地还原，再用 `dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --configuration Release --no-restore` 运行。测试使用合成来源和文件核实器，不采集真实应用或操作桌面。

目录 API 依据：[Applications 已知目录](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)、[Shell item 枚举与属性读取](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishellitem-bindtohandler)、[App Paths 注册规则](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)、[AppUserModelID 属性](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-id)。

## 应用启动 launch_app

`launch_app` 使用当前 helper 已返回、主进程已登记的启动引用。DeepSeek 根据任务自主选择应用，无需用户预选应用或窗口；此动作通过现有 computer use 工具说明通道发布，不改动现有系统提示词、助手角色或其他工具规则。

| 参数 | 规则 |
| --- | --- |
| `app_id` | 必填，使用 `list_apps` 实际返回的应用编号。 |
| `launch_reference_id` | 必填，必须属于同一应用、当前快照及当前 helper 代次。 |
| `wait_ms` | 可选整数，默认 1500，范围 0—5000；限制派发后窗口观察的等待时间。 |

模型不能提交路径、命令、额外参数或覆盖 `catalog_id`。主进程注入可信快照编号，并绑定 helper 代次；native 再检查引用属于当前目录、快照未超过两分钟。刷新目录、helper 重启或旧目录反馈会作废主进程旧引用。便携 exe 必须先通过 `list_apps.register_path` 核实登记。

派发前保持已知 exe 的只读文件句柄并重新核实真实路径、PE 类型和文件身份；快捷方式还锁定源文件、复核 SHA-256、目标、原有参数与 AppUserModelID；文件型 Shell 快捷方式使用相同流程。Shell 应用项重新解析并比较实际身份。任一核实失败均在系统启动调用前返回 `stale_catalog / not_executed`，由模型重新发现应用。

传统应用、快捷方式和 Shell 应用项在独立 STA 上调用 `ShellExecuteExW` 的 `open` 操作，使用 `SEE_MASK_NOASYNC` 处理无消息循环的 Shell 调用。实际注册的打包应用使用 `IApplicationActivationManager`，通过 `CLSCTX_LOCAL_SERVER` 让 Windows 管理激活参数的生命周期。只使用已登记的启动信息，不请求提权，不传入模型提供的参数。每次请求最多派发一次；激活失败或结果不确定时，不切换启动方法、不自动重试。

返回值包含 `catalog_id/app_id/launch_reference_id`、`dispatch_status`、`method`、`native_error`、可获得的 `returned_process`，以及派发前后采集时间、`observation_complete` 和 `candidate_windows`。成功派发不一定返回新进程；单实例复用、代理进程、现有业务窗口和没有候选窗口均是正常可能结果。PID 与创建时间只是匹配线索，不能单凭 PID 认定目标窗口。

候选窗口最多 12 个，附带标题、PID／进程创建时间、可见／最小化／前台状态，以及 AppUserModelID、实际 exe、返回进程或窗口变化等匹配依据。完整基线下的新建／变化窗口可作为未确认的候选；缺少基线、权限受限或采集截断时明确标记观察不完整。每轮窗口采集有 512 个枚举项、256 个窗口和约两秒软预算，后续采样受 `wait_ms` 与次数共同约束，整个动作仍受 30 秒期限及 helper 看门狗监督。

启动结果始终包含 `target_window_confirmed: false` 和 `goal_verified: false`，本动作不生成可操作的 `window_id`。第 11 项已提供独立的窗口查询与引用；候选窗口仍需结合后续截图／控件观察与焦点能力确认业务内容。`execution` 区分未派发、已派发和派发结果不确定；取消不会撤销已经启动的应用，helper 故障／超时／重启也不会重放启动动作。主进程独立校验返回的选择身份、字段、时间、候选数量和状态一致性，再按原任务回传结果。

已补充上述 Node 测试中的启动参数、已知引用、代次隔离、单实例／代理进程、错误结果、取消及不重试用例；原生测试新增合成启动器与窗口观察器，覆盖目录过期、PID 复用、观察不完整及等待预算等情况。测试源码可编译，测试及真实 Windows 启动行为由用户运行验收；智能体未启动测试程序、Electron 或 helper。交付状态为“构建通过，等待测试”。

启动 API 依据：[ShellExecuteExW 与 COM 线程要求](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw)、[SHELLEXECUTEINFOW 的异步与进程句柄规则](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow)、[打包应用激活](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateapplication)、[激活管理器的进程外生命周期](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-iapplicationactivationmanager)、[查询已注册包族](https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getpackagesbypackagefamily)。

## 文件、目录与网页打开 open

`open` 沿用现有任务、单次步骤令牌、helper 代次和结果回传链路，不改现有系统提示词或其他工具。网页默认交给 Windows 关联的外部浏览器；helper 不持有 Electron 控制页对象，也不调用控制对话的导航接口，因此业务页面与 DeepSeek 控制对话分开。浏览器可以复用自己的业务窗口／标签页，此动作不保证每次新建浏览器窗口。选择应用或窗口不需要用户逐步参与。

| 参数 | 规则 |
| --- | --- |
| `kind` | 必填，`file`、`directory` 或 `url`；必须与实际资源类型一致。 |
| `target` | 必填，本机磁盘绝对路径最多 1024 字符，或完整 HTTP(S) URL 最多 4096 字符。路径按字面处理，不展开环境变量，不将其拼成命令。 |
| `app_id`、`launch_reference_id` | 可选，必须成对提供并属于 `list_apps` 已实际返回的同一应用；不提供时使用系统关联。目录快照由主进程注入，模型不能覆盖。 |
| `wait_ms` | 可选，默认 1500，范围 0—5000，沿用启动动作的有界候选窗口观察。 |

主进程先做资源类型、路径／URL 和字段校验，再用 `realpath + stat` 核实真实本机路径与文件／目录类型；符号链接解析到网络／设备路径时拒绝派发。helper 独立校验同一资源，并打开文件／目录的元数据句柄，核对最终路径、卷与文件编号及类型；在实际系统调用前再次核实。句柄允许读写并在派发结束时释放，避免后续观察阶段继续占用文档。文件不存在、类型不符、身份改变或路径不可核实均返回未执行结果，不创建资源、不猜测位置。

URL 只接受带主机的 `http://` 或 `https://`，拒绝用户名密码、控制字符、反斜杠、`file:`、自定义协议与命令字段；主进程进行 URL 规范化，helper 再独立校验。不做网络可达性自检，不因 URL 校验而发起请求。拒绝 UNC、设备名、替代数据流和含歧义尾部字符的本机路径。程序、脚本和快捷方式不能通过默认文件关联冒充普通文档运行：启动应用继续使用 `launch_app`，查看脚本可以显式选择已发现的编辑器。

系统关联使用 STA 上的 `ShellExecuteExW(open)`，文件／目录／URL 位于独立的目标字段，文档参数为空。查询到的关联程序只作为线索返回，无法核实时为 `null`；不会把关联查询当成已确认实际业务应用。helper 拒绝显式选择 Web2Term／helper 自身作为资源处理器，也拒绝查询到的自身默认处理器，保护控制对话。

指定已发现应用时，继续执行第 09 项的目录及启动来源复核。传统应用使用已核实 exe，并将资源编码为一个完整参数，保留空格与尾部目录分隔符，不经过 Shell 命令解析器；带预置参数的快捷方式不支持此入口，模型应选择同应用无预置参数的引用或系统关联。打包应用使用 `ActivateForFile`／`ActivateForProtocol` 和单项 `IShellItemArray` 传递资源，不猜测启动开关。应用不支持该资源、没有系统关联、接口失败或结果不确定时均返回实际情况，不自动换程序、改命令或再次打开。

返回 `kind/target`、`handler`、可获得的 `application`、所选应用引用、派发状态、系统错误、返回进程和派发前后的候选窗口。`application.basis` 区分 `association_query` 与 `selected_reference`，这些信息均不能替代后续业务窗口确认。候选窗口与等待预算复用第 09 项；`control_conversation_preserved` 固定为 `true`，`content_verified`、`target_window_confirmed`、`goal_verified` 固定为 `false`。系统接受打开、已有实例收到请求、返回 PID 或候选窗口出现，都不能证明文件／网页内容已加载或任务完成。取消和 helper 故障保留 `not_executed/executed/unknown` 的真实语义，已派发操作不重放；主进程独立校验返回资源、应用引用、字段和状态一致性。

已在 `tests/windows-app-catalog.test.mjs` 与 `tests/native-app-catalog/ResourceOpenTests.cs` 补充参数／类型、路径和 URL、默认／指定应用、过期引用、异步核实期间换任务／重启、单实例、取消、错误回执、资源释放和不重复派发用例。测试只使用模拟资源与窗口；按前述命令由用户运行。智能体仅编译原生测试源码、检查 Node 文件语法并执行项目构建，未运行测试、打开资源或启动 Electron/helper。真实文件关联、默认浏览器和打包应用的文件／协议激活仍待 Windows 用户测试。

资源 API 依据：[Shell 文档参数与进程句柄规则](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow)、[文件激活](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateforfile)、[协议激活](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateforprotocol)、[单项 Shell item 数组](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-shcreateshellitemarrayfromshellitem)、[关联查询](https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-assocquerystringw)、[文件／目录句柄](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)。

## 窗口发现与身份管理 list_windows

`list_windows` 在 MTA 上采集当前桌面的顶层窗口，不激活窗口或发送输入。通过 Win32 获取标题、线程／进程编号、进程创建时间、真实可执行路径和可获得的进程／窗口 AppUserModelID，返回可见、最小化、前台、启用与 DWM cloaked 状态，以及 `GW_OWNER` 关系。进程名称来自实际进程映像文件名，不猜测产品名称；无法取得的应用信息保留为 `null`。UIA 控件树和截图仍由后续条目接入。

| 参数 | 规则 |
| --- | --- |
| `query` | 可选，最多 200 字符；按标题、实际进程名称、路径及 AppUserModelID 子串查询，忽略大小写。 |
| `pid` | 可选，1—4294967295 的整数；仅用于筛选，不能代替窗口身份。 |
| `include_hidden` | 默认 `false`，包括可见或最小化窗口；`true` 时也包括隐藏窗口。 |
| `limit` | 默认 25，范围 1—50；结果还受 180 KiB 页预算限制。 |
| `cursor` | 原样使用上一页 `next_cursor`，保留相同 query／pid／include_hidden；绑定同一快照、任务作用域和两分钟有效期。 |

不带 cursor 的查询总是重新采集，并作废本任务上一快照及其中的窗口引用。返回 `snapshot_id`、采集／过期时间、原筛选条件、窗口行、匹配数、分页和 `complete/limitations`。相同标题、相同应用、同一进程的多个窗口不会合并。每行包含不透明 `window_id` 或 `null`、原始句柄元数据和身份核实状态；只有身份核实成功的行才发布引用。`owner_hwnd` 是关系元数据；`owner_window_id` 仅在已核实 owner 也作为本页窗口行返回时提供，不凭裸句柄创建可操作引用。

窗口引用绑定 HWND、PID、进程创建时间、线程编号、窗口类和窗口生命周期代次。helper 使用 `SetWinEventHook(EVENT_OBJECT_CREATE/DESTROY)` 的 OUTOFCONTEXT 事件，在独立消息循环记录窗口创建／销毁；不向目标进程注入代码、不设置窗口属性、不修改目标窗口。采集前后有界同步事件并核对身份；事件线程不可用、同步失败、采集期间身份变化或无法读取进程创建身份时，仅保留窗口信息，不发放可用引用。事件记录最多 8192 项，溢出会更换全局代次，使旧身份失效；helper 结束时关闭监听。

主进程从现有调度器传入的真实 `TaskLease` 生成私有任务作用域，按工具注册、会话、对话、任务及任务代次隔离引用。作用域不出现在模型动作参数中；模型不能覆盖 scope／task／generation，也不能把启动候选或自报句柄登记为窗口。只有通过当前 helper 代次、结果结构、筛选、有效期、身份与 owner 一致性校验的窗口行才登记；旧任务、旧进程、迟到／被新查询替代的结果不能写入或清掉新任务的引用。能力关闭、过期、注销、helper 停止／重启和格式异常时不提供旧引用。

原生 `WindowCatalog.Resolve(scope_id, window_id, cancellation)` 是为后续窗口动作提供的必经身份校验入口：只接受已实际发布且未过期的引用，重新读取真实窗口，并比较完整身份与生命周期代次。窗口消失、PID／HWND 复用、线程／窗口类改变、监测代次变化或身份无法读取时作废引用，不恢复已撤销的编号。标题、位置、最小化、前台和 owner 等状态变化不会伪造新窗口身份，Resolve 返回新读取的状态。主进程 `lookup` 只提供当前任务已知的引用，不能替代 native Resolve。

快照不锁定外部窗口；事件和 Win32 查询也不是一次原子操作。第 12 项已在恢复／激活前及观察后调用 Resolve，并独立核对实时前台与焦点。后续输入动作仍须在实际动作入口重新校验窗口、前台／焦点、弹窗和观察约束，不能单凭 `IsWindow`、标题、旧快照或一次成功激活执行输入。发现窗口或身份核实成功均不表示已确认业务内容或完成任务；同名窗口由 AI 结合后续观察继续核对，不要求用户预选。

采集有最多 1024 次枚举、512 个窗口及约两秒软预算；单页最多 50 行、180 KiB，最多保留 16 个任务快照，每个快照最多 512 个分页引用，两分钟后失效。范围淘汰、取消和失败不会自动恢复引用。阻塞的系统调用仍受 15 秒动作期限及 helper 看门狗限制，控制管道保持独立。

新增 `tests/windows-window-catalog.test.mjs` 与 `tests/native-app-catalog/WindowCatalogTests.cs`，覆盖同名多窗口、owner、筛选／分页、任务／代次／过期隔离、部分信息、PID 与同进程 HWND 复用、生命周期变化、取消、资源上限及迟到结果。Node 测试可由用户运行 `node --test tests/windows-window-catalog.test.mjs`；原生测试随前述 native 测试项目运行，使用合成窗口与生命周期，不调用 Win32 或操作桌面。智能体仅检查语法、编译测试源码和构建项目，未运行测试、Electron/helper 或真实桌面枚举。交付状态为“构建通过，等待测试”。

窗口 API 依据：[顶层窗口枚举](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)、[owner 关系](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindow)、[WinEvent 线程与事件队列](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)、[创建／销毁事件](https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants)、[IsWindow 与句柄复用的限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindow)。

## 窗口激活与恢复 focus_window

`focus_window` 只接受当前任务在 `list_windows` 中实际获得的有效窗口引用。主进程复核任务／会话／对话、已知引用、快照期限和 helper 代次，注入私有 scope_id；helper 在操作前通过 `WindowCatalog.Resolve` 重新读取窗口身份，拒绝裸句柄、PID、启动候选或模型提供的作用域。每次恢复和激活的原生入口还会再次校验身份；窗口消失、复用、过期或无法核实时不继续操作其他窗口。

| 参数 | 规则 |
| --- | --- |
| `window_id` | 必填，原样使用当前 `list_windows` 行中身份核实成功的引用，不允许猜测。 |
| `restore` | 默认 `true`，允许恢复最小化窗口或显示隐藏窗口；`false` 时这些窗口返回 `restore_required`，不恢复或激活。 |
| `wait_ms` | 默认 1500，范围 0—3000；是恢复／激活后的观察软预算，系统及 UIA 调用还受整个动作的 15 秒期限与看门狗约束。 |

最小化窗口使用 `ShowWindowAsync(SW_RESTORE)`，隐藏窗口使用 `SW_SHOW`；该回执只说明请求是否排入队列，随后读取真实状态，再决定是否激活。每次工具调用最多恢复一次、调用 `SetForegroundWindow` 两次，观察及等待同时受耗时、次数和剩余预算限制。只有已知回执且目标尚未成为前台时才可能做第二次有界尝试；接口结果未知时立即停止，不重放。已经在前台且 Win32／UIA 焦点一致时可直接完成状态核对，恢复／激活次数均为零。

窗口被禁用或 cloaked 时返回 `window_blocked`，可附带 `GetLastActivePopup` 的阻挡句柄线索，不自动改选弹窗或把句柄升级成操作引用。AI 可以据此重新查询、观察并选择下一步。实现不合并线程输入队列、不模拟 Alt／点击／键盘、不修改前台锁设置、不置顶或请求提权；Windows 拒绝前台切换时保留实际结果，不把拒绝当成已成功激活。

核对包括 `GetForegroundWindow`、`GetGUIThreadInfo` 的 active／focus HWND 和焦点根窗口；UIA 使用当前 MTA 上的 `IUIAutomation.GetFocusedElement`、HasKeyboardFocus、原生窗口属性及有界 RawView 祖先读取关联根窗口，重新取得焦点元素比较，再读取 Win32 路由以发现焦点变化。每次动作最多两轮 UIA 读取，每轮最多 32 层和约 500 ms 软预算；COM 调用阻塞时仍由动作期限处理。UIA 只读取焦点身份，不读取控件正文，不调用 SetFocus，不包含第 14 项的通用控件树。窗口身份、可见／非最小化／启用／非 cloaked、实际前台、Win32 路由和 UIA 焦点必须一致，才报告 `focus_confirmed=true`。

返回原窗口与快照编号、采集时间、恢复回执、逐次激活回执、新读取的目标状态、前台／active／focus／焦点根句柄、Win32／UIA 核对结果和阻挡线索。`status` 区分 `focused`、`foreground_only`、`denied`、`blocked`、`restore_required`、`stale`、`cancelled` 和 `unknown`。仅在前台、UIA 不可用／不一致或键盘路由不明确时均不报告完整焦点成功；对应错误保留实际观察供模型自主继续。主进程再次校验原始选择身份、结构、状态、回执次数、结果码和 execution 一致性，再更新当前任务窗口元数据。

`execution` 区分系统调用前拒绝、已派发变化和结果未知。已处于目标焦点的成功结果中 `execution=executed` 表示状态核对步骤完成，回执字段明确显示未发生恢复／激活调用；不会虚构窗口变化。取消或原上下文结束时保留已有派发事实，不能视为恢复或激活已经回滚；迟到结果不覆盖新任务或新窗口快照。返回结果始终包含 `input_ready=false` 和 `goal_verified=false`：采集不是原子快照，一次焦点成功不构成后续输入许可或任务完成证明，未来输入入口仍须实时复核。

沿用现有任务推进与结果自动回传；客户端是否在操作系统前台不作为任务暂停条件。代码中的会话 active 状态用于当前会话归属，未增加窗口 blur 暂停，也不会为了继续任务而强行将 Web2Term 拉回前台。现有系统提示词、助手角色、确认规则及其他工具保持原样。

已扩展 `tests/windows-window-catalog.test.mjs` 并新增 `tests/native-app-catalog/WindowFocusTests.cs`，覆盖已在前台、最小化／隐藏恢复、禁用／cloaked、弹窗线索、OS 拒绝、API 成功但未激活、UIA 不可用／冲突、焦点丢失、旧引用、取消、异常不确定及迟到任务隔离。Node 和原生测试仍按前述命令由用户运行；原生测试只链接纯逻辑与合成后端，不包含真实 Windows／UIA 调用。智能体仅检查语法、编译测试源码并构建项目，未运行测试、启动 Electron/helper 或实际恢复／激活窗口。交付状态为“构建通过，等待测试”。

焦点 API 依据：[SetForegroundWindow 的限制与回执](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)、[异步恢复／显示](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindowasync)、[GUI 线程焦点信息](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo)、[UIA 当前焦点元素](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-getfocusedelement)、[UIA 接口布局](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/UIAutomationClient.h)、[最近活动的 owned popup](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastactivepopup)。

## 桌面概览、窗口与区域截图 observe

第 13 项通过同一工具说明通道注册 `observe`，仅在主进程和 helper 均已接入并就绪时发布。保持现有系统提示词、助手角色、任务入口、确认规则和其他工具的行为。

模型参数：

- `target` 必填，取 `desktop`、`window` 或 `region`。
- `desktop` 默认只截主显示器，并返回最多 16 个显示器的 `monitor_id`、物理边界、主屏标记与可取得的 DPI。模型可用真实返回的 `monitor_id` 查看其他显示器，不固定上传所有屏幕。显示器引用由设备／边界／DPI 等实际状态生成，拓扑改变后旧编号不匹配。
- `window` 必须提供当前任务 `list_windows` 实际返回的 `window_id`。`region` 可以提供 `window_id`，或提供 `monitor_id`／默认主屏；两者互斥。窗口引用在主进程按真实任务核对，在 native 入口及采集后由 `Resolve` 重新核实完整身份。裸 HWND、PID、自报 scope／任务和输出路径不能成为模型参数。
- `region` 必须完整提供 `x/y/width/height`，含义是选定来源原始像素内的矩形。拒绝越界，不静默截断。其他 target 不接受裁剪字段。
- `max_dimension` 默认 1600，可选 256—2560；保持比例、不放大。源图上限 3200 万像素及每边 32768，最终 PNG 上限 8 MiB。太大时返回错误，供模型选择更小区域或尺寸。

原生后端使用 Windows Graphics Capture 的 `CreateForWindow/CreateForMonitor`、D3D11 和 `CreateFreeThreaded` 帧池，按需拉取一帧，不需要用户选择器或 DispatcherQueue。使用 `SoftwareBitmap` 深拷贝真实表面，在释放帧之前取出 BGRA 像素，再按本次裁剪、实际目标宽高进行有界缩图和 RGB PNG 编码。保留系统捕获边框，关闭截图光标，不绕过内容保护，也不以 GDI 或全部屏幕作为自动回退。

截图不恢复或激活窗口，不授予焦点或输入许可。隐藏／最小化窗口返回 `restore_required`，由模型决定先调用 `focus_window`；cloaked、已声明显示保护或无法捕获的来源返回实际错误。WGC 支持或第一帧不可用时报告失败，不把成功读取元数据当成截图。受保护内容可能呈现空白，截图和上传成功均不表示已读到业务内容。

helper 为 PerMonitorV2 DPI awareness，元数据使用桌面物理像素。记录 `observation_id`、采集前／帧获取／采集后的时间、原始来源边界和尺寸、裁剪、上传 PNG 实际尺寸及散列。连续变换为 `desktop_x=origin_x+image_x*scale_x`，y 同理；第 16 项按实际编码采样取 floor 得到输入物理像素；缩图取整后的 x/y 比例分别保存，无留边。不同 DPI、负桌面坐标和旋转后的显示器以实际物理边界与帧尺寸为准。主进程独立检查这些等式、窗口身份、显示器、PNG 结构与 CRC、解压像素预算和 SHA-256，再允许交付。

捕获前后重新读取窗口身份／边界／显示状态、显示器拓扑与 DPI，要求 WGC item、帧 ContentSize、SoftwareBitmap 和来源尺寸一致。变化返回 `stale_window`、`stale_observation` 或对应状态，不发布旧几何下的可用截图。此检查不能把外部界面变成原子快照；同尺寸内容变化、移动后又返回原位等仍可能发生。`content_verified/input_ready/goal_verified` 固定为 false；第 14—16 项已接入有界控件树、输入前失效复核和坐标映射，第 17—21 项已接入点击／双击、文字输入、按键／组合键、区域滚动、拖拽与操作后观察，其他输入由后续条目实现。

图片不以 base64 塞进 256 KiB 管道帧。主进程为本次请求创建 `%TEMP%/web2term-observe-xxxxxx/capture.png` 私有输出目录，路径只经内部管道传给 helper；native 限定临时目录格式、拒绝 reparse 目录并以 CreateNew 写入，主进程再按固定路径、有界读取、文件类型及散列核对。模型仅收到任务绑定的 `img_…` 附件引用；不能自报文件路径。附件上传前再次核对原任务与文件散列。

`TaskProgression` 保存文字与不透明附件引用，临时文件保留到原步骤交付结束。复用 `sendPageFiles` 的 caption/CDP 原生附件链路，将文字和一张图提交为同一条消息；校验原平台、原对话路径、页面代次和取消信号，页面单独标记 computer 结果，不把它作为新用户目标。生成中／草稿占用时只等待同一结果，未知发送或上传后草稿变化时停止自动提交，不重新截图，不重放动作。客户端失去操作系统前台不新增暂停条件。截图与文字实际送达仍需用户在真实 DeepSeek 会话验收。

正常发送成功、取消、工具注销及服务退出清理临时文件；最多 32 份待交付截图，15 分钟过期，由定时清理回收。过期、篡改、跨任务和迟到结果不能交付。图片字节和本机临时路径不写入任务结果、会话数据库或默认诊断日志。异常退出遗留目录回收、全工具统一发送协调和显式历史图像属于后续第 29／43 项。

已补充 `tests/windows-observation.test.mjs`、`tests/native-app-catalog/ObservationTests.cs` 及 `tests/task-progression.test.mjs` 用例。用户可运行 `node --test tests/windows-observation.test.mjs tests/task-progression.test.mjs`，原生纯逻辑用例沿用前述测试项目命令。合成测试不启动 helper、操作窗口或截取真实桌面。智能体只做语法检查、测试源码编译及 `npm run build`，交付状态为“构建通过，等待测试”。

API 依据：[Win32 直接指定窗口](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)、[无 DispatcherQueue 帧池](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded)、[表面深拷贝](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.imaging.softwarebitmap.createcopyfromsurfaceasync)、[Microsoft 帧内容尺寸及生命周期说明](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/develop/media-authoring-processing/screen-capture.md)。

## 控件树与焦点读取（第 14 项）

控件读取扩展在现有 `observe` 工具内。`target=controls` 必须提供当前任务 `list_windows` 返回的 `window_id`，只读控件和 UIA 焦点，不创建截图文件、不依赖 WGC 成功。`target=window` 或带 `window_id` 的 `region` 可指定 `include_controls=true`，把截图、控件摘要与文字通过现有附件链路同消息回传。区域截图的控件树仍以整个选定窗口为范围，控件 `bounds` 为桌面物理坐标，不是上传缩略图内坐标。不自动寻找或改选其他窗口，不要求用户先定位控件。

控件选项仅在上述读取模式生效，网页与主进程继续沿用严格工具协议，native 独立校验内部参数：

| 参数 | 默认值 | 范围与含义 |
| --- | --- | --- |
| `max_depth` | 4 | 1—8，窗口根深度为 0。 |
| `max_elements` | 100 | 1—200，包含根节点；独立访问预算最多是该值的四倍。 |
| `timeout_ms` | 1200 | 100—3000 毫秒软预算；不能打断已阻塞的一次 COM 调用，仍受 20 秒 helper 动作期限及独立看门狗保护。 |
| `include_selection` | false | 只尝试当前窗口内、已返回焦点控件的 Text 模式选区，最多 4 段／2048 个 UTF-16 字符。 |

使用 Windows 内置 UIA3 COM 的 `CUIAutomation8`，不增加 FlaUI 依赖。所有 COM 对象在现有 MTA 创建、使用并释放；只对一个已核实窗口调用 `ElementFromHandleBuildCache`。属性缓存范围为单个元素，通过 Control View walker 逐节点获取子项／兄弟，不从桌面根遍历、不对整棵子树调用无界 FindAll。焦点归属通过全局 UIA 焦点与有界 Raw View 祖先核对，读取前后比较实际焦点；这里返回 UIA 焦点证据，不代替第 12 项独立 Win32 焦点检查。

每行包含 `element_id/parent_id/depth/control_type/role/name/name_truncated/password/enabled/focused/offscreen/selected/bounds/patterns/properties_complete`。按实际 ControlType 映射 role；模式列表来自 UIA 的可用性属性，本次不 Invoke、SetFocus、SetValue、Select 或注入输入。无法取得的字段保留 null 并明确标记部分结果；不把不支持的属性猜成已验证状态。隐藏／不在选定窗口范围内／属于其他顶层窗口的分支不发布，保留窗口根作为结构关联。

密码控件及密码状态未知的控件屏蔽名称、不读选区并停止向下遍历。普通名称最多 256 字符，超限标记截断。`include_selection` 不读取 Value 或文档全文；只有焦点落在已返回控件且支持 Text 模式时，才有界读取选区。读取选区前后重新核对密码状态与焦点；焦点变化时清空选区，返回 changed。焦点在其他窗口、控件不在本次返回树内、模式不支持、保护字段、空选区、不可用和截断分别返回状态，不改由用户提供坐标。

单次结果的节点序列化预算约 100 KiB，留出名称转义、选区和外层字段空间；主进程还对整个控件结果设置 140 KiB 校验上限。`complete/limitations` 区分节点、深度、时间、字节、名称、选区截断、提供方错误、属性缺失、循环及焦点变化。提供方失败时保留此前已完整取得的有界节点，必要时可以是空树；模型可改用截图或其他实际可用工具。取消不发布新控件引用。

结果包含独立 `observation_id`、窗口身份、采集前后时间、窗口物理边界、根编号、控件行、焦点关联和选区状态。读取前后复核窗口完整身份、可见／最小化状态及边界，变化返回 stale_window／stale_observation。图像与控件同时读取时，再比较两份观察的窗口身份、边界与时间关系，不一致就不发布组合结果。主进程独立核对结构、预算、父子关系、重复编号、role／模式、密码字段、焦点／选区关系和真实任务／helper 代次，迟到结果不能进入新任务。

UIA 和截图不是原子快照，窗口内部内容／控件布局仍可能在采集中改变。固定 `snapshot_atomic=false`，并保持 `content_verified/input_ready/goal_verified=false`。`element_id` 每次读取重新生成，仅用于本轮控件结构、焦点和选区关联，不保留 COM 对象或把旧编号当成后续输入许可；第 15 项已接入实时复核、观察绑定和失效处理，第 16 项已接入 DPI／多屏及完整图像坐标映射，第 17—21 项已接入点击／双击、文字输入、按键／组合键、区域滚动、拖拽与操作后观察，其他输入由后续条目实现。

组合结果仍沿用自动回传和去重流程，忙碌保留同一份图片与文字，发送不确定停止自动重发。computer 附件 caption 上限为 200000 字符，容纳有界控件摘要；其他文件附件 caption 仍保持原上限。控件名称／选区不写入默认诊断日志；工具结果按现有任务步骤落盘并在确认发送后清除待发文字。现有系统提示词、助手角色、规划方式、确认规则和其他工具保持原样。

已扩展 `tests/windows-observation.test.mjs` 并新增 `tests/native-app-catalog/ControlTreeTests.cs`，覆盖控件层级、角色与模式、可见性、密码屏蔽、各类预算、提供方错误、循环、选区、焦点变化、身份／布局变化、取消、对象释放、组合观察和主进程拒绝畸形数据。原生测试只链接纯逻辑和合成后端，不包含真实 UIA 调用。按仓库约定由用户运行测试；智能体仅做语法检查、测试源码编译和 `npm run build`，交付状态为“构建通过，等待测试”。

API 依据：[UIA 缓存与快照语义](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients)、[定位与遍历 UIA 元素](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-obtainingelements)、[UIA Text 模型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-understandingtheuiautomationtextobjectmodel)、[MTA 线程约束](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)、[Microsoft SDK COM 接口布局](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/UIAutomationClient.h)。

## 第 15 项：观察绑定与失效处理

`WindowsObservationService` 与原生 `ObservationRegistry` 共同登记当前任务最近一组观察。主进程以会话、平台、原对话、任务与任务代次、helper 进程代次生成私有 `os_` 作用域，并从已持久化占用的工具步骤注入 `source_step_id` 和 `step_token` 的 SHA-256 摘要。它们不能由模型参数覆盖；原令牌和摘要不进入公开观察。公开 `binding` 只返回来源步骤和到期时间。组合截图及其 `controls.observation_id` 是同一组的两个引用，控件编号必须来自该组；实际上传图像边界约束 `x/y`。新观察开始即放弃旧组，失败也不会复活旧引用；有效期为 2 分钟，任务／helper 变化、注销、关闭和重启不能恢复旧观察授权。原生最多保留 16 个作用域，已失效的运行时引用不能用于输入。

新增只读 `validate_observation` 动作，实际在主进程与 helper 都注册且 helper 就绪后才对 DeepSeek 声明。参数如下，仍使用现有 computer JSON 和每轮新的 `step_token`：

| 字段 | 规则 |
| --- | --- |
| `observation_id` | 当前任务最近一次 `observe` 的图片或组合控件观察编号；必填。 |
| `element_id` | 可选，必须是同一组中实际返回的控件；与坐标互斥。 |
| `x`、`y` | 必须成对，采用实际上传图像像素，不能超过图片边界；纯控件观察不能使用坐标。 |
| `purpose` | 默认 `inspect`；`pointer` 需要控件或坐标，`keyboard` 需要控件。输入用途还需窗口前台、焦点路由及目标可用，显示器概览不能直接作为窗口输入来源。 |

原生状态检查在采集／复核前后进行，包含完整窗口身份与生命周期、visible／minimized／enabled／cloaked／owner、物理边界、显示器拓扑／DPI、前台／active／focus／捕获／菜单状态、UIA 焦点运行时身份、可见 owned 窗口／最近弹窗和 WinEvent 修订。UIA 焦点采样为有界只读操作，不读取名称或内容；UIA 不可用保持明确状态，不阻断原有截图能力。窗口创建／销毁与布局／焦点事件在同一独立消息线程接收，但使用不同修订表；移动或焦点切换不会伪装成 HWND 生命周期变化。即使状态随后恢复，已记录的修订变化或已失败的观察也不能重新生效。事件监听、来源、焦点路由等必要状态不可获取时，不凭缓存发布可输入结论。

控件读取结束释放全部 COM 对象，只保留登记需要的私有运行时标识。指定控件的复核会按原预算重读、不再读取选区，比较运行时标识、属性／边界及祖先关系；未在新范围中找到、字段不完整、焦点改变或提供方失败时返回失效，不按名称或旧索引猜测替代控件。UIA RuntimeId 可能随时间复用，不能作为长期身份。纯控件复核只比较已观察的有界范围，仍不代表完整业务内容。图像／坐标复核重新捕获同来源，按原裁剪与缩图编码并核对散列，从而发现滚动、画布内容等变化；动态图像可能导致保守失效，可由 AI 自主选择更小区域或可用的控件定位。控件定位不因无关图片动画而直接失败，目标与窗口状态仍须复核。

已执行或结果不确定的 `launch_app`、`open`、`focus_window` 会推进观察失效代次。它们继续正常自动执行和回传，不暂停任务，也不自动改选弹窗。只读复核返回 `valid/reason/checked_at`，始终包含 `action_not_executed=true`、`input_ready=false`、`snapshot_atomic=false`；通过只代表当次检查，没有执行输入。为第 17 项起的输入动作提供 `WithCurrentObservation`：实际 native handler 必须在同 MTA 上实时复核后立即执行其有界派发，不能消费过去的一次 `validate_observation` 成功结果作为输入许可。此项尚未实现点击／键盘输入，外部进程也可能在最后一次检查之后改变状态，不能承诺桌面原子操作。

已知观察失效时，主进程先作废旧组，再按保存的真实来源参数最多调用一次 `observe`。结果保留 `stale_observation` 和旧定位未执行事实，同时携带 `refreshed_observation` 及可选新图片，经原任务的同消息附件链路自动送回 DeepSeek。刷新不会再次触发刷新，也不重放任何输入；未知、跨任务、已替换的编号不会触发刷新。窗口已关闭／窗口引用过期或截图受保护时，保留 `refresh_error`，由 AI 自主重新发现窗口或选择其他工具。主进程独立校验复核字段、结果码、时间、来源、helper 代次和执行事实；取消或迟到结果不能进入新任务。错误结果可以携带新图片，交付忙碌只重试同一份结果，不重新观察；交付不确定沿用停止重发规则。

新增 `tests/native-app-catalog/ObservationBindingTests.cs`，并扩展 `tests/windows-observation.test.mjs`、`tests/task-progression.test.mjs`。覆盖步骤来源及令牌摘要隔离、组合编号、最新观察／过期／重启失效、窗口／焦点／弹窗／拓扑修订、图像变化、控件身份／祖先／状态变化、派发前阻断、取消、单次刷新和错误附件交付。用户可运行 `node --test tests/windows-observation.test.mjs tests/task-progression.test.mjs`，原生合成用例随前述 native 测试项目运行。智能体仅检查 Node 语法、编译原生测试源码及运行 `npm run build`，未运行测试、启动 Electron/helper、截屏或读取实际控件；交付状态为“构建通过，等待测试”。

API 依据：[UIA RuntimeId 的作用域与复用限制](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid?view=windowsdesktop-10.0)、[WinEvent 事件常量](https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants)、[SetWinEventHook 事件线程要求](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)。

## 第 16 项：DPI、多屏与坐标转换

继续使用 `observe` 与 `validate_observation`，不新增模型规划或独立工具。模型提交的 `x/y` 是原始上传 PNG 左上角为 `(0,0)` 的像素索引，右／下边界不包含在有效范围内。网页缩略预览、CSS／Electron DIP 和桌面物理坐标均不能作为请求坐标覆盖这个约定。截图返回实际图像尺寸、物理 `source_bounds`、来源像素 `crop`、`transform.content_bounds` 及 `pixel_mapping=nearest_floor`。当前编码器不留边，内容矩形为整个 PNG；接收端独立核对，拒绝伪造的留边或变换。通用转换器支持已核实的内容矩形偏移，留边点不转换。

`src/shared/windows-coordinates.ts` 与 `Coordinates.cs` 独立实现相同整数公式，与 `ObservationPng.Encode` 的实际采样一致：

```text
physical_x = source_bounds.x + crop.x + floor((image_x - content_bounds.x) * crop.width / content_bounds.width)
physical_y = source_bounds.y + crop.y + floor((image_y - content_bounds.y) * crop.height / content_bounds.height)
```

图像最长边缩放造成的宽／高取整分别处理，不使用一个近似比例替代。窗口跨不同 DPI 显示器时仍使用物理像素，不再乘 DPI；竖屏使用系统提供的实际边界／帧尺寸，不二次旋转。负 X／Y 原点保留。每个落点必须完整落在观察来源和裁剪内容内，并属于一个真实显示器；窗口部分离屏、显示器间的空隙、重复重叠归属、整数溢出和不一致的内容矩形均不钳制到附近位置。

`WindowsDpiContext` 在 WGC 来源／捕获、UIA 边界与 Win32 状态采样入口核对当前线程为 Per-Monitor V2。进程继续使用原 manifest 的 PMv2，不临时切换其他应用或线程的 DPI 模式。显示器物理边界合集必须与 `GetSystemMetrics` 的虚拟屏原点／尺寸相符，不相符按状态变化拒绝发布。`coordinate_context` 记录 `dpi_awareness=per_monitor_v2`、`virtual_bounds` 和 `GetDpiForWindow` 的 `window_dpi`；后者依目标窗口自身 DPI 感知模式返回证据，不能拿来二次缩放截图坐标。

逐屏比例以 `GetScaleFactorForMonitor` 的成功结果记录为 `scale_percent`；失败时丢弃 API 给出的回退比例并返回 null。已移除 PM-aware 线程不应使用的 `GetDpiForMonitor`。既有 `dpi_x/dpi_y` 没有独立可靠来源时保留 null，不从离散比例伪造测量值。物理坐标计算依赖已核实的几何，不依赖这些诊断字段。窗口 DPI 或逐屏比例变化分别纳入采集前后、观察登记和派发前的状态比较。

图像坐标复核成功时，`ObservationValidation.coordinate` 返回：

| 字段 | 含义 |
| --- | --- |
| `image` | 本次请求的原 PNG 像素点。 |
| `desktop` | 按实际编码采样换算的桌面物理像素点。 |
| `monitor_id` | 落点所在的真实显示器；空隙或歧义不返回成功定位。 |
| `virtual_bounds` | 本次观察绑定的整个虚拟桌面边界，包含负原点。 |
| `absolute` | 后续 Win32 绝对鼠标输入的 0—65535 坐标，标记 `coordinate_space=win32_absolute_virtual_desktop` 和 `require_virtual_desktop=true`。 |

归一化选择像素区间的中心：`floor((2*offset+1)*65536/(2*size))`，并反算核对仍属于原物理像素。宽／高为 1 不除以零；极端大虚拟桌面上无法以 16 位精确表达的点拒绝转换。后续第 17 项实际鼠标输入必须使用 `ABSOLUTE` 和 `VIRTUALDESK`，并核对输入后的真实状态，不能把主屏归一化用于副屏。主进程依据自己已校验并保存的原观察，独立重算点、显示器、虚拟边界及归一化，逐字段比较 helper 输出；缺失、伪造或额外字段不能发布成功定位。

窗口移动／移屏、尺寸、窗口 DPI、屏幕比例或拓扑变化会沿用第 15 项的 `stale_observation` 与最多一次刷新，新结果不携带旧定位。`WithCurrentObservation` 在同 MTA 上复核并转换后，把当次结果传给 native 派发回调；回调不得消费模型自报的桌面坐标或过去的复核成功。`input_ready=false`、`action_not_executed=true`、`snapshot_atomic=false` 继续保留。本项未增加 SendInput、移动鼠标或点击；桌面并非原子快照，第 17—21 项已接入点击／文字／按键／滚动／拖拽派发与后观察；其他输入由后续条目实现。

私有 helper 协议为 v4，握手拒绝旧观察／坐标契约的 v1／v2／v3；网页 computer JSON 仍为 v1。用户需使用本次构建产物并重新启动开发应用，运行方式继续只有 `npm run dev`。

新增 `tests/fixtures/windows-coordinate-cases.json`，由 `tests/windows-coordinates.test.mjs` 和 `tests/native-app-catalog/CoordinateTests.cs` 共用（原生嵌入资源），共 11 组固定数据。覆盖 100%／125%／150%／200%、非整数缩图、负 X／Y、跨屏、裁剪、留边、竖屏、屏幕空隙、部分离屏、单像素、重叠归属和超大桌面精度；另扩展主进程伪造几何／归一化、DPI／比例变化、单次刷新及派发回调只收新坐标的用例。Node 测试可由用户运行 `node --test tests/windows-coordinates.test.mjs tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-helper.test.mjs`，原生仍沿用前述测试项目命令。智能体只做源码／语法检查、原生测试源码编译与 `npm run build`，未执行测试、启动 Electron／helper 或操作真实桌面。交付标准为“构建通过，等待测试”。

API 依据：[PMv2 与物理像素](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)、[虚拟桌面系统度量](https://learn.microsoft.com/en-us/windows/win32/gdi/multiple-monitor-system-metrics)、[窗口 DPI 的语义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow)、[GetDpiForMonitor 的调用限制](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getdpiformonitor)、[显示器缩放及失败回退](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getscalefactorformonitor)、[MOUSEINPUT 绝对／虚拟桌面坐标](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)。

## 第 17 项：点击与双击

`WindowsObservationService` 与 helper 同时注册 `click`，实际 helper 宣布支持后才通过现有工具说明通道发布。新动作沿用私有 v4 和模型侧 computer v1；同一 v4 私有协议内按实际 helper 的动作清单声明能力；旧版 v3 helper 需重新构建。仍使用当前 DeepSeek 模型和原任务／步骤令牌，不改变系统提示词、助手角色、其他工具或确认规则。

| 参数 | 规则 |
| --- | --- |
| `observation_id` | 最近一组观察的图片或组合控件编号，必填；不得用历史观察授权输入。 |
| `element_id` | 同一组控件编号；与完整 `x/y` 恰好选择一种。控件可以来自 controls-only 观察。 |
| `x/y` | 原上传 PNG 中的完整像素点，由第 16 项转换；不能传桌面坐标、缩略图坐标、DPI 倍率或原生句柄。 |
| `button` | 默认 left，可选 left／right／middle，表示 Win32 左／右／中键事件。 |
| `click_count` | 默认 1，上限 2；双击始终使用鼠标输入。 |
| `method` | 默认 auto；mouse 明确使用鼠标。auto 的适合控件优先选择一次语义操作。 |

主进程依据当前 lease、helper 代次、已占用的当前 request step 和原观察来源校验，原令牌与其摘要只进入私有管道。模型不能覆盖任务、作用域、窗口、request_id 或输入实现。控件引用须来自本组；图像点须位于原 PNG 内；显示器概览不能直接授权窗口点击。源观察在主进程派发前被消费，即使回执未知，也不重新启用旧引用。

`ClickService` 在原 MTA 上调用 `WithCurrentObservation`，复核来源步骤／代次、窗口身份、最新布局、DPI、焦点和弹窗。控件路径还按原有界预算重开 UIA 会话，查找私有运行时标识，比较属性、边界和 Control View 祖先；当前节点与模式对象在回调结束释放，不保留可跨轮调用的 COM 对象。控件选点取已核实边界、窗口和实际显示器交集中的可见整数点；每次调用前检查 Win32 真实命中根窗口，且 UIA `ElementFromPoint` 的元素须为目标或其后代。遮挡或提供方无法核对时不猜测其他控件／祖先，不输入。

左键单击且 method=auto 时，只选择适合目标角色的一个模式：

| 控件 | 操作 |
| --- | --- |
| button／hyperlink／menu_item／split_button，且支持 invoke | `IUIAutomationInvokePattern.Invoke` 一次。 |
| check_box，且支持 toggle | `IUIAutomationTogglePattern.Toggle` 一次；不擅自循环到期望状态。 |
| radio_button／list_item／tab_item／tree_item／data_item，且支持 selection_item | `IUIAutomationSelectionItemPattern.Select` 一次。 |
| 无适合模式、只读模式准备确认不支持，或明确 method=mouse／其他键／双击 | 使用鼠标路径。 |

取得模式本身是只读准备；只有未开始任何输入且明确没有适合模式时可以改用鼠标。模式调用开始后，无论 HRESULT 失败、异常、取消或超时，均不再调用其他模式或补一次鼠标。成功回执仅说明调用完成，不说明业务目标已满足。

鼠标路径先使用第 16 项计算的物理点与虚拟桌面绝对坐标，派发一条带 helper 标记的 MOVE／ABSOLUTE／VIRTUALDESK／NOCOALESCE 事件。有界等待最多 200ms 并读取实际指针位置，随后重新复核观察、当前控件和真实命中；图像路径会重新核对原画面散列，悬停／弹窗导致变化即停止按钮派发，返回 stale 和一次新观察。按钮批次再次核对当前桌面、前台窗口、落点、DPI 和鼠标位置；单击插入一对 down/up，双击以一次 SendInput 批次插入两对 down/up，不另行移动或自动补发。

所有按钮事件时间由系统填写；双击是否被应用解释为双击仍取决于应用行为，不能用事件接收数证明文件已打开。结构布局为 Windows x64 INPUT（40 字节，联合体偏移 8）与 MOUSEINPUT（32 字节），并在合成测试中提供 ABI 检查。输入事件带 helper 进程标记，为后续干扰区分保留依据；本项没有新增全局输入 hook、键盘工具或急停快捷键。

`WindowsClickBackend` 不激活或恢复窗口，不附加输入队列或更改权限。要求本线程桌面为当前输入桌面、目标已在前台且可用、实际命中属于完整身份相符的目标；用户已有鼠标按钮、Shift／Control／Alt／Windows 键按下时不叠加输入，也不主动释放它们。拒绝 Web2Term 控制窗口和 helper 自身窗口。已确认前台、命中与归属的鼠标操作可在键盘焦点为空时建立焦点；这不授权后续键盘输入，键盘准备状态保持独立。窗口自身焦点修订仍核对，后台控制对话的文档焦点变化只更新其自身修订，不污染前台业务窗口的全局焦点版本。

原生登记近期已派发 request_id，重复步骤不能因新观察再次执行；每次进入派发回调也作废旧输入代次。SendInput 的接收数量按原值保存，0 不伪报成功，部分接收或异常保留 unknown。平衡序列的接受前缀若遗留本次 down，或调用异常无法确认平衡时，仅尝试一次对应的 up，记录释放是否被接受；不重发 down、不释放其他按键、不声称已回滚。取消前检查贯穿移动和按钮派发，单个已提交的平衡批次不会拆成重复调用。进程硬终止、UIPI 和 OS 拒绝等情况仍可能无法确认输入或释放；完整独立急停／退出释放属于后续第 37 项，不承诺持久的“恰好一次”。

点击回执分别保存 request/source/observation/window、所选路径、移动是否尝试及接受、click_attempted／click_completed、按钮请求／接收数、必要释放及物理点、采集时间，并固定 goal_verified=false／input_ready=false。主进程独立核对当前步骤、原观察、控件角色／支持模式、物理点、接收数、释放关系、时间和 execution；错误／伪造回执不能发布成功。鼠标已移动但按钮未派发时，明确分开记录两个事实；UIA 或按钮调用可能已生效时不降为 not_executed。

有效请求返回后，主进程最多按原来源再调用一次 observe，把 click 回执与新观察经原对话自动回传。controls-only 返回新控件树，截图或组合来源沿用单图／文字同消息链路。后续观察失败保留 post_observation_error 及原点击事实，成功点击不会因缺少新截图被标为未执行；部分输入、坏回执或未知结果只允许补取观察，不会再次调用 click。窗口关闭／新弹窗由 AI 根据后状态重新发现，不自动替换目标。忙碌交付只发送同一份结果，未知发送停止重发；取消、旧任务和更换 helper 的迟到结果不会进入新任务。

已新增 `tests/native-app-catalog/ClickTests.cs` 并扩展主进程与推进测试。合成用例覆盖 UIA 角色与模式、只读回退、语义失败不补点、所有按钮与单／双击、移动未到达、悬停变化、遮挡／控件失效、前台无键盘焦点、部分事件／释放、取消、重复 request、原生 ABI／严格协议、主进程回执独立校验、controls-only 后观察以及交付重试不重放。可由用户运行 `node --test tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-coordinates.test.mjs tests/windows-helper.test.mjs`；原生仍使用前述测试项目命令，全部为模拟后端。智能体只做语法检查、编译测试源码及 `npm run build`，未运行测试、启动 Electron／helper、移动鼠标或实际点击。交付状态为“构建通过，等待测试”。

API 依据：[SendInput 接收数、串行批次与权限限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[INPUT 布局](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-input)、[现有按键状态](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate)、[UIA 控件模式](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-control-patterns-overview)。COM UUID 与方法次序另按本机 Microsoft Windows SDK 的 UIAutomationClient.h 核对。

## 第 18 项：文字输入

主进程与 helper 注册 `type_text`，只在当前 helper 实际声明支持后发布。沿用 computer v1、私有管道 v4、原任务和单次步骤令牌；系统提示词、助手角色、其他工具与确认规则保持原样。`click` 和 `type_text` 共用主进程的输入后观察／附件交付流程，各自独立校验回执，不因观察或交付失败重放输入。

| 参数 | 规则 |
| --- | --- |
| `observation_id` | 本任务最近一组包含控件的观察；图片／组合控件编号均可。 |
| `element_id` | 同组已返回且实际获得键盘焦点的文字控件，必填。可由 AI 先 click，再 observe(include_controls=true) 或 observe(target=controls) 获取，不需要用户选窗口或手动聚焦。 |
| `text` | 最多 8192 个 UTF-16 单元；保留首尾空格，接受中文、emoji、逻辑换行和制表。拒绝无效代理项、NUL、退格、ESC 等其他控制字符。仅 replace 允许空串清空。 |
| `mode` | 默认 insert：在光标／当前选区插入，不擅自清空全文。replace：明确替换整个控件值，仅使用可写 UIA Value 模式。 |

主进程先核对最新观察、控件归属、完整属性、enabled／focused／offscreen 和焦点关联。helper 同 MTA 调用 `WithCurrentObservation` 的 keyboard 检查，再按私有运行时身份与祖先重新解析控件。要求窗口已在前台、Win32／UIA 键盘焦点相符且实际可编辑；可编辑证据来自 ValueIsReadOnly=false 或 TextPattern 的 IsReadOnly 属性=false，未知或只读不输入。拒绝非活动桌面、其他窗口的焦点、控制软件本身以及用户已按住的鼠标／修饰键；不自动切窗、设置焦点、移动光标或全选。

insert 使用 `KEYEVENTF_UNICODE`，`wVk=0`，`wScan` 为原文字的 UTF-16 单元；每单元一对 down/up，每段最多 32 单元，不能在代理对中间切段。CRLF／CR／LF 作为逻辑换行统一发送一个 Unicode U+000D，Tab 发送 Unicode U+0009；不生成 VK_RETURN／VK_TAB、快捷键，也不解释 `{ENTER}`、`^`、`%`、Shell 或脚本语法。字符如何显示／处理由应用决定，不能仅凭 SendInput 接收数声称已换行、保存或发送。多行及复杂编辑器仍需看实际后状态。

每段前核对窗口身份／生命周期、物理边界、DPI／拓扑、焦点、弹窗及当前控件属性、祖先、可编辑性。段间给应用一个有界处理机会。首次输入前仍要求原观察修订一致；同一次输入开始后的内容／光标事件允许更新修订，避免自己刚输入一段就被当作人工接管。窗口、焦点或几何等检查继续执行；本项没有增加全局输入 hook，也不承诺隔离外部进程对同一控件的并发编辑。

replace 对非密码、支持 Value 且当前非只读的控件调用一次 `IUIAutomationValuePattern.SetValue`。该操作表达整框替换；不支持时不清空、不全选、不改用 Unicode 插入。调用开始后无论 HRESULT 失败或异常都不切换路径或重输。ValuePattern 并非所有多行／富文本编辑器都支持；模型应根据错误和新观察选择插入或现有文件／终端工具。

本地可选验证通过 TextPattern 有界读取最多 16384 单元的全文；insert 还需单一选区的前／后缀，以构造“前缀 + 本次文字 + 后缀”的预期结果，避免仅因全文包含相同片段就误报成功。范围读取前后核对密码状态和真实焦点，并再次读取全文以发现采样过程中变化。输入完成后最多四次短暂回读，按逻辑换行比较完整结果；只有一致才标记 `verification=matched`、`content_verified=true`。明确不同为 mismatched；不支持、超预算、读取／焦点失败或无法得到完整选区时为 unavailable。密码不读取内容，不使用 replace，不声称已验证。全文和选区前后缀只在本次 helper 调用内保留，不放入回执或日志。

回执包括 request／source／observation／window／element、mode／method、原文长度与 SHA-256、input_attempted／input_completed、每段的偏移／长度／实际事件接收数、必要释放及验证状态。主进程从原始文字独立重算规范化、分段、代理对边界与散列，核对接收数、释放关系、实际模式、时间、焦点来源和 execution。任何矛盾／坏回执都是 unknown，不能采信其中“未执行”的自报字段。

SendInput 返回部分数量或异常时，停止后续文字；若已知前缀留下本次 Unicode down，或无法确认平衡，只尝试一次 Unicode up，记录接受数量，不重发 down、不释放用户修饰键。完整已接收的前几段后发生取消／失焦时，明确记录已经执行的部分；部分或未知接收保留 unknown。UIA 调用不能在 COM 方法内部回滚；helper 硬期限、进程退出等仍可能无法确认最终效果。每次已进入派发的观察作废，近期 request 去重；持久步骤去重仍由主进程的单次令牌负责。

每次有效调用后，最多按原参数补取一次 observe，把 `type_text` 回执与新观察一并自动回传原 DeepSeek 对话。controls-only 保持纯控件结果，组合来源仍是一张图片及文字。后观察失败保留 `post_observation_error` 与原输入事实；已完整派发不会因截图失败变成未执行。忙碌仅重发同一结果，未知发送停止重发；取消、换任务／会话和 helper 更换的迟到结果不进入新任务。模型收到部分输入／未知结果后应先核对内容，不能为了补回执或截图重输全文。

新增 `TypeTextTests.cs`，扩展 `windows-observation.test.mjs` 与 `task-progression.test.mjs`，用模拟窗口、UIA 和输入接收数覆盖 Unicode／代理对／多行、选区插入、显式替换及清空、只读与密码、正常自身修订、焦点／弹窗／DPI 变化、部分接收／释放、取消、去重、坏回执与交付不重输。用户可运行：

```powershell
node --test tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-coordinates.test.mjs tests/windows-helper.test.mjs
dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --configuration Release --no-restore
```

智能体只做语法检查、原生测试源码编译及 `npm run build`；未执行测试、启动 Electron／helper 或向真实应用输入。交付状态为“构建通过，等待测试”。更新后运行项目仍只使用 `npm run dev`，重新启动后由新的 helper 宣布能力，无需单独拉起 helper。

API 依据：[KEYEVENTF_UNICODE 与 VK_PACKET／WM_CHAR](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)、[SetValue 的可写前提](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationvaluepattern-setvalue)、[Value 与多行 Text 模式的边界](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue?view=netframework-4.8.1)。Value／TextRange COM UUID 与方法顺序按本机 Windows SDK 10.0.26100.0 核对。

## 第 19 项：按键与组合键

主进程与 helper 注册 `press_key`，仅在实际 helper 声明能力后发布；沿用模型 computer v1、私有管道 v4、原任务／单次步骤令牌和输入后观察／自动回传。现有系统提示词、助手角色、确认规则、文字输入与其他工具保持原样。

| 参数 | 规则 |
| --- | --- |
| `observation_id` | 本任务最近一组业务窗口观察，必填；图片或同组控件编号均可。显示器概览不授权按键。 |
| `element_id` | 可选。指定时必须是本组实际获得焦点的控件，重新核对身份／祖先／属性；不要求控件可编辑。省略时使用已核对 Win32 焦点路由的窗口级路径。 |
| `key` | 一个受支持的单键或组合，最多 80 个 ASCII 字符，例如 Tab、Escape、Control+S、Control+Shift+S、Alt+F4。仅名称、数字、加号和空格；不支持多条序列、原生码、脚本、延时、重复或跨轮按住。 |

| 按键组 | 支持内容 |
| --- | --- |
| 修饰键 | Control、Alt、Shift、Win；单个修饰键也可独立按一次。组合修饰键按 Control／Alt／Shift／Win 排序，不接受同义词重复或只由多个修饰键组成的组合。 |
| 导航／编辑 | Backspace、Tab、Enter、Escape、Space、CapsLock、PageUp／PageDown、End／Home、Left／Up／Right／Down、Insert／Delete、Menu。 |
| 字母／数字／功能键 | A—Z、0—9、F1—F24。大小写只是按键标识，不会自动补 Shift；键盘布局和锁定状态仍影响应用响应，输入正文继续用 type_text。 |
| 数字小键盘 | Numpad0—Numpad9、NumpadEnter、Multiply、Add、Subtract、Decimal、Divide；例如 Control+Add。主 Enter 与 NumpadEnter 的扩展标记明确区分。 |
| 别名 | Ctrl／Ctl、Option、Windows／Meta、Esc、Return、Spacebar、PgUp／PgDn、Del／Ins、ArrowLeft／Right／Up／Down、Apps；两侧独立规范化为同一名称。 |

例如 `shift + ctrl + s` 规范为 `Control+Shift+S`。组合只有一个主键；`A+B`、`Ctrl++S`、`Ctrl+Control+S`、`{ENTER}`、`0x41`、`VK_RETURN` 等不会变为其他输入。Control+Alt+Delete 属于不受此路径支持的安全注意序列，解析阶段拒绝，不提供提权、切换安全桌面或其他替代实现。

窗口级路径先复核最新观察的内容／状态，再核对窗口身份、生命周期、前台／active、真实 Win32 focus、物理几何／DPI／拓扑、弹窗及输入桌面；窗口截图路径不依赖已暴露的 UIA 控件，可用于 UIA 不可读时的键盘导航。指定控件则复用 `WithCurrentObservation(keyboard)` 和有界 UIA 解析，并以实时属性和实际焦点对象再次核对。公开 `validate_observation` 的 keyboard 规则不变，不将过去的只读通过结果变为可复用按键许可。

派发要求目标为已观察的前台业务窗口，目标键和所有修饰键当前未按下；不借用或主动释放用户已有的按键。复用既有输入桌面／窗口身份及控制窗口隔离，拒绝鼠标／修饰键占用和菜单／捕获／移动状态。不自动激活、恢复、聚焦窗口或附加输入队列；第 22 项已接入菜单／弹窗关联发现及核实后的菜单输入路由；未知菜单上下文仍拒绝输入。

`PressKeyProtocol` 在 TypeScript 和 C# 中独立映射虚拟键和扩展标记。键盘 INPUT 使用 `wVk`、`wScan=0` 以及必要的 EXTENDEDKEY／KEYUP，不使用文字路径的 UNICODE 标志；沿用 40 字节 INPUT 和 24 字节 KEYBDINPUT 及 helper 来源标记。一个组合仅提交一次 SendInput 批次，序列为修饰键 down、主键 down/up、修饰键逆序 up。例如 Control+Shift+S 为：

```text
Control down → Shift down → S down → S up → Shift up → Control up
```

组合中间不执行其他业务操作或观察，也不在主键按下后因正常焦点变化再派发第二个主键。完整已提交组合可能正常打开窗口、切换焦点或关闭来源窗口；这些属于待核对的业务结果，不能反过来把已派发事件当作未执行。

每次派发前占用近期 request，并在派发回调结束后作废旧输入代次；主进程发送前也消费旧观察。SendInput 接收 0 明确 not_executed；完整接收标记 input_completed=true／execution=executed；部分或未知接收为 unknown。依据串行输入序列的实际接收前缀，计算本次仍可能按下的键，逆序只提交一次 key-up 清理。未知接收时对本次所有可能按下的键尝试 up；清理只包含本组合中的键，不补 down、不改路径或重放主键。记录释放接受数，即使为 0、部分或未知也不伪称已回滚。

取消检查发生在观察、控件解析、只读准备和最终提交之前；已提交平衡批次不会为响应取消而重新拆发，异常通过 finally 清理可能遗留的键，焦点已变化时仍可尝试本次必要 up。进程硬终止、OS 拒绝或系统桌面变化仍可能无法确认释放；独立急停／退出释放及全局干扰区分属于第 37—38 项，本项不承诺持续按住状态、桌面原子性或崩溃后的恰好一次。

回执包含 request／source／observation／window／可选 element、规范化 key、input_attempted／input_completed、请求／接收事件数、逆序 release_keys／实际释放接收数及时间，并固定 goal_verified=false／input_ready=false。主进程从原始 key 独立重算规范组合、事件总数和待释放前缀，核对来源、控件焦点、完整性、顺序及 execution；任何矛盾或额外字段均为 invalid_result／unknown，不采信坏回执自报的“未执行”。

有效调用后最多按保存的真实来源补取一次 observe，将 `press_key` 回执与文字／单图或 controls-only 结果自动回传原对话。窗口关闭或后观察受阻时保留 post_observation_error 和原按键事实，AI 根据实际后状态重新发现窗口；不会为了补截图再次保存、确认、删除或按键。结果发送忙碌只重发同一份结果；未知发送、任务切换／取消和 helper 更换沿用原有隔离规则。

新增 `tests/fixtures/windows-key-cases.json`，两端共用 16 组固定映射及非法输入；新增原生 `PressKeyTests.cs`，扩展主进程和自动推进测试。覆盖修饰键／扩展键、窗口与非编辑控件、焦点／DPI／图像失效、每个部分接收前缀、未知输入／释放失败、取消、去重、坏回执和交付重试不重按。用户可继续运行：

```powershell
node --test tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-coordinates.test.mjs tests/windows-helper.test.mjs
dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --configuration Release --no-restore
```

智能体只检查语法、编译原生测试源码及运行 `npm run build`，未运行测试、启动 Electron／helper 或实际按键。交付状态为“构建通过，等待测试”。重新启动开发应用继续只使用 `npm run dev`，由新 helper 宣布 press_key 能力。

API 依据：[虚拟键编码](https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes)、[KEYBDINPUT 标记](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)、[扩展键与键盘状态](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-keyboard-input)、[SendInput 串行输入与现有按键状态](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。

## 区域滚动（第 20 项）

`scroll` 是现有 computer use 工具中的一个动作，不更改系统提示词、助手角色、确认规则或现有工具。主进程和实际 helper 同时注册后才发布能力，模型 computer JSON 继续为 v1，私有协议继续为 v4。模型只需给出以下字段，任务绑定、步骤编号与令牌散列由主进程补齐：

| 字段 | 规则 |
| --- | --- |
| observation_id | 当前任务最近一组业务窗口观察；显示器概览不能直接授权滚动。 |
| element_id 或 x／y | 二选一：同组真实控件，或原上传 PNG 中完整的零起点像素落点。不能省略定位、沿用当前鼠标、混用定位或覆盖桌面坐标。 |
| direction | up、down、left、right；一次一个方向。 |
| amount | 整数 1—10，省略为 3；每单位是一个 120 的滚轮刻度，单位不是像素或行数。 |

图像路径复用可信物理坐标转换；控件路径在原预算内重新解析运行时身份、属性、祖先和可见边界，使用控件／窗口／显示器可见交集中的点，不要求控件可编辑或具有 ScrollPattern。移动前检查当前观察、窗口身份、前台、活动输入桌面、弹窗、DPI／拓扑、遮挡、鼠标／修饰键占用及控制窗口隔离。仅接受实际命中的窗口客户端区域；标题栏、边框和其他窗口不作为滚动区域。

为避免滚轮按系统策略落入其他子窗口，派发前读取 `SPI_GETMOUSEWHEELROUTING`：垂直模式为 `MOUSEWHEEL_ROUTING_MOUSE_POS`（2）时按鼠标位置核对；其他垂直模式、读取失败及水平滚轮要求真实 Win32 focus HWND 与命中 HWND 完全一致。不更改系统设置、不隐式点击或聚焦、不用 Shift+滚轮模拟水平输入。不能确认时返回 scroll_blocked，由 AI 结合新观察选择定位／聚焦步骤。该检查确认的是原生窗口路由，应用仍可能忽略事件或将事件传给父容器，不能据此宣称某个内部虚拟面板已按指定距离滚动。

每次先提交一个带 ABSOLUTE／VIRTUALDESK 的鼠标移动事件，复用有界到达确认，再复核窗口／焦点／命中／路由。图像路径重新采集同来源图像比较散列；控件路径通过 `BuildUpdatedCache` 获取新属性并重新核对身份、祖先和真实命中，避免把移动前缓存当作实时状态。悬停引起图片或控件变化、窗口／DPI／焦点变化、取消或鼠标未到达时，不继续派发滚轮，保留已发生的移动事实。

全部检查通过后，最多一次 SendInput 提交一个 MOUSEEVENTF_WHEEL 或 MOUSEEVENTF_HWHEEL 事件，wheel_delta 分别为 up／right 正值、down／left 负值，幅度为 amount×120；滚轮事件本身不带移动标志，也不按住鼠标按钮。没有循环滚到底、隐式换区域、回退键盘或失败补滚。近期 request 在首个移动前占用，观察输入代次在派发后作废；取消停止尚未派发的事件，已发生部分不可回滚。

回执分开记录 move_attempted／move_accepted 和 scroll_attempted／scroll_completed／wheel_events_requested／wheel_events_accepted，包含请求与观察来源、控件、落点、方向、刻度、轴、带符号 delta、路由和时间。移动接收 0 且未发滚轮为 not_executed；仅移动接收成功为 executed，但 scroll_completed=false；滚轮接收数未知为 unknown，完整接收一个事件为 executed／scroll_completed=true。scroll_completed 只表示输入接收，scroll_verified／goal_verified／input_ready 始终为 false。主进程从原请求独立重算方向、delta、落点及执行状态，拒绝矛盾字段，坏回执或失联不能证明“未执行”。

调用后最多补取一次原来源观察，将回执与新截图／控件树按原任务自动回传。后观察失败保留原输入事实及 post_observation_error，发送忙碌只重发同一份结果；不会为了补截图或回传再次滚动。DeepSeek 根据真实后状态判断位移、边界、实际作用区域和下一步；不保证应用支持水平滚轮，不把事件接收当成目标达成。

已补充原生合成用例（方向／刻度／标志、路由策略、非编辑区域、悬停／实时控件失效、零／未知接收、取消、去重及严格协议），并补充主进程独立回执校验与结果发送不重滚用例。用户可运行：

```powershell
node --test tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-coordinates.test.mjs tests/windows-helper.test.mjs
dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --configuration Release --no-restore
```

智能体只做语法检查、原生测试源码编译及 `npm run build`；未运行测试、启动 Electron／helper 或操作真实桌面。交付状态为“构建通过，等待测试”。真实应用仍需检查垂直／水平滚动、嵌套滚动容器、不同滚轮路由设置、到达边界和混合 DPI 多屏行为。开发应用继续只使用 `npm run dev` 启动，由新 helper 宣布 scroll 能力。

API 依据：[MOUSEINPUT 滚轮方向、刻度与标志](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)、[系统滚轮路由参数](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfow)、[鼠标滚轮焦点与消息传播](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-mouse-input)、[水平滚轮消息](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousehwheel)。

## 拖拽与基础画布输入（第 21 项）

`drag` 作为现有 computer use 工具的一个动作提供给 DeepSeek。沿用工具说明、步骤令牌、任务自动推进及结果回传，不改变系统提示词、角色、确认规则或现有工具。只有主进程与实际 helper 同时接入才声明能力，模型协议保持 v1，私有 helper 协议保持 v4。

| 参数 | 约束 |
| --- | --- |
| observation_id | 当前任务最近一组业务窗口图像观察。显示器概览和 controls-only 不能作为拖拽输入来源。 |
| path | 2—33 个仅含整数 x／y 的原 PNG 像素点，范围 0—2559，且必须落在实际图像内。首点为按下位置，末点为释放位置。相邻点不得重复；允许闭合折线。 |
| button | left／right／middle，默认 left。一次只持有一个鼠标按钮。 |
| duration_ms | 整数 100—3000，默认 600，表示轨迹计划时长；实际时长还包含状态检查和鼠标到达确认。 |

两个点表示直线拖动，更多点表示保留拐点的折线，可用于滑块、选区、对象移动及基础画布输入。按键修饰、原生句柄／坐标、控件编号、脚本、压力／倾斜／触摸、多按钮、重复指令和跨请求持续按住均不接受。本项限制在同一窗口的客户端区域；跨应用拖放和原生窗口边框／标题栏拖动没有接入。

主进程依据保存的图像转换全部锚点，helper 从私有注册表获取同一来源图像独立转换，不消费模型上报的物理几何。两端以同一整数取整规则细分，每段每轴最多 16 个物理像素，最多 256 段。逐像素检查路径的窗口与显示器几何，另行检查每个实际派发点，拒绝屏幕空隙、歧义显示器及无法精确编码的绝对坐标；超限时不截断或钳制，由模型重新规划有界动作。共用的 `windows-drag-cases.json` 覆盖正负坐标、取整、拐点及闭合路径。

动作开始前在原 MTA 严格复核观察内容、窗口身份、前台／active、物理几何／DPI／拓扑、焦点、菜单／捕获／弹窗、用户已按住的鼠标／修饰键及本软件控制窗口隔离，检查所有派发点都命中同一业务窗口的可见客户端。整条路径检查后再次复核原图像，随后提交一次带 ABSOLUTE／VIRTUALDESK／NOCOALESCE 的起点移动并确认到达。悬停后重新比对图像／状态及所有派发点；失效则不按下。近期 request 在首次输入前占用，已占用请求不能用新观察重放。

按下只提交一个按钮 down，确认系统按钮状态后开始轨迹。每段等待用不超过 25ms 的等待片段检查取消和当前原生状态，移动前后确认预期鼠标位置；每次 Move 使用一个绝对移动事件并有界确认到达。持有期间使用 Win32 和只读窗口／显示器几何检查，不调用 UIA、不抓截图。允许本次拖动导致的目标窗口内部焦点、内容及鼠标捕获变化；捕获必须归属同一目标根窗口，真实前台／窗口身份、客户端命中、物理边界、DPI／拓扑仍须一致。其他按钮／修饰键占用、鼠标离开预期位置、外部捕获、菜单、可见活动弹窗或来源变化会停止后续轨迹。分段检查不是桌面原子锁，不能完全区分并发修改；全局接管识别继续由第 38 项完善。

完整路径末尾仅提交一次正常 up。取消或异常通过 finally 停止后续移动，并依据 down／up 的实际接收事实决定清理：down 明确接收 0 时不释放；down 可能或确定接收且正常 up 未确认时，只额外尝试一次本次按钮的 up，不再按下、不重拖、不回滚，也不释放其他按钮。必要清理不受已经取消的 token 阻止，可在焦点变化后尝试。up 清理成功只能说明释放事件接收，不能证明拖放或选区结果。系统拒绝、硬超时或进程强制退出时无法保证释放；独立急停及退出释放仍由第 37 项实现，本项不宣称已有全局急停。

回执包含 request／source／observation／window、按钮／时长、物理起终点／计划段数、起点移动接收／到达、down 接收／状态确认、每个已尝试分段的连续序号／接收／到达、正常 up 及必要释放尝试／接收数。未发生输入为 not_executed；仅起点移动成功而未按下为 executed，但 drag_completed=false；可能已按下后未完整完成的手势为 unknown，即使清理已接收也不降为“未执行”。完整按下、全部分段到达和正常 up 接收后才有 drag_completed=true／executed。drag_verified／goal_verified／input_ready 固定 false；实际拖放、选区或画布内容须依据新观察判断。

主进程独立重算路径、起终点／段数、连续接收前缀、事件先后和释放义务。矛盾／多余字段、伪造成功或坏回执自报“未执行”统一为 invalid_result／unknown。派发后旧输入观察失效，调用后最多自动补取一次原来源观察；后观察失败保留输入事实及 post_observation_error，发送忙碌只重发同一结果，不为补截图或回传而重拖。旧任务／旧 helper 的迟到结果不发入新任务。

已编写两端共用几何数据、原生合成窗口／路径／部分输入／取消／必要释放／去重／严格协议测试，以及主进程回执伪造、图像失效、路径边界及自动交付不重拖测试。用户可运行：

```powershell
node --test tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-coordinates.test.mjs tests/windows-helper.test.mjs
dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --configuration Release --no-restore
```

智能体只做语法检查、原生测试源码编译及 `npm run build`，未运行测试、启动 Electron／helper 或操作真实桌面。交付状态为“构建通过，等待测试”。实际应用需检查左右中键拖动、滑块／选区／画布、多段轨迹、正常捕获、取消／干扰及混合 DPI 多屏；应用是否处理输入仍需真实后状态确认。开发启动继续只使用 `npm run dev`，由新 helper 宣布 drag 能力。

API 依据：[SendInput 接收数、串行输入及按键状态](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[GUITHREADINFO 前台线程焦点／捕获／菜单状态](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-guithreadinfo)、[跨线程捕获读取须用 GetGUIThreadInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getcapture)。

## 菜单、弹窗与文件对话框（第 22 项）

新增只读 `inspect_interactions`，参数为当前普通业务 `window_id` 和可选 `limit`（默认 8，范围 1—16）。主进程补入任务私有 scope，helper 不接受脚本、原生句柄、路径或确认指令。该动作只发现关联和发布可用引用，不激活窗口、不选择文件、不点击确定，也不将工具结果当成任务完成。仍由当前 DeepSeek 读取内容、理解影响，按用户目标组合已有工具。系统提示词、角色、确认规则及终端／文件／后台工具保持原样；模型 v1／私有 v4 协议不变。

发现依据为实际顶层窗口身份、生命周期及最多 8 层 GW_OWNER 链，所有中间 owner 都必须核实并同时发布；不凭标题、同 PID 或进程名称推断关联。可以检查已被模态窗口禁用的父窗口。窗口行分类为 dialog（原生 #32770）、owned_window 或 menu；class_name 只用于窗口形态分类，不代表已识别“保存／覆盖／删除”等业务含义。`is_modal` 来自真正支持 WindowPattern 的 UIA IsModal 属性，读取失败／不支持返回 null，并标记 modality_unavailable；不能把窗口禁用或未知值等同于已知模态／非模态。

结果携带原 parent、派生窗口／owner_chain／is_modal、菜单 owner／root／输入引用、采集时间、有效期、完整性和限制。属性读取前后重新采集原生 GUI 状态及关联窗口图，身份、owner、前台、菜单状态或窗口集合变化时不发布该批引用。仍保留 snapshot_atomic=false／input_ready=false／goal_verified=false，工具结果不是输入许可。枚举、属性或数量受限时明确 complete=false，不将结果为空解释为“没有弹窗”。UIA 调用受 helper 动作硬超时约束，不能保证第三方提供方在软预算内返回。

派生引用最长有效 30 秒，且不超过原 list_windows 快照的 2 分钟有效期；每个 scope 最多保留 64 个派生引用。重新检查同一来源只替换其旧派生引用及菜单上下文，保留来源窗口和其他来源的引用；新的 list_windows 查询仍按原规则整体换批。后续 observe、focus_window 和输入都会实时重新核实窗口身份／生命周期；引用过期、句柄重用、换任务／helper 或关闭菜单时拒绝旧引用。

菜单路由有四种状态：

| menu.mode | 含义与下一步 |
| --- | --- |
| popup | 发现独立 #32768 原生菜单，已核实真实前台 owner、菜单标志、线程／进程及捕获归属。观察返回的菜单引用，以 click 或窗口级 press_key 操作。 |
| owner | 没有可发布的独立菜单窗口，但可实时核实活动菜单的前台 owner。观察 keyboard_window_id 指向的原窗口及控件，再用点击或窗口级按键，不伪造菜单项。 |
| none | 当次未见原生菜单模式；仍应根据截图／控件检查自绘的嵌入弹层。 |
| unavailable | 菜单模式存在但不能核实与本业务窗口的关联；没有输入路由许可，需继续发现和观察。 |

活动菜单不执行 focus_window，避免激活关闭菜单。截图不可用时可显式使用 observe(target=controls)，读取当前可用控件；不回退抓取整个桌面。菜单可能使 UIA 焦点不可读，结果保留 unavailable：只在私有菜单上下文和真实 Win32 路由核实、控件／树及观察状态一致时，允许指针或不指定 element_id 的窗口级按键；不将背景焦点控件冒充菜单目标。模型必须根据实际菜单内容选择方向键、Enter、Escape 或其他适用按键，不对未知菜单统一按 Enter。

菜单权限仅存在于 helper 私有上下文，每次 Resolve 和派发都复核菜单存活、前台／active、owner 根、线程／进程、捕获、输入桌面及用户鼠标／修饰键占用。源窗口的普通引用仍不能自行绕过菜单拦截。上下文具有独立身份，刷新、关闭或重新建立路由会使旧观察失效；owner 路由关闭后，来源窗口恢复普通窗口身份。菜单期间不通过文字输入、滚动或拖拽路径操作，只有点击和窗口级按键接入。菜单 owner 中的背景非 menu_item 控件不直接调用 UIA 语义操作，以免绕过真实菜单路由；菜单控件使用更新后的 UIA 缓存重新核对属性、祖先及真实命中。

文件选择、另存为、覆盖或未保存提示的正常衔接为：检查原业务窗口 → observe 新对话框的截图／控件 → 必要时激活该普通对话框 → 根据任务填写／选择／确认或取消 → 根据新观察判断结果。没有硬编码按钮标题、默认文件路径或自动接受未知提示。输入打开新对话框或关闭菜单时，原来源的后观察可能失败；保留原输入接收事实和 post_observation_error，同时返回 interaction_hint（来源 parent_window_id 与建议 inspect_interactions），让模型自动检查新状态。不会为补观察或交付结果而再次按键／点击。

自绘嵌入菜单可继续通过原窗口截图／UIA 控件判断；无可靠 owner、提供方缺失、独立非激活弹层或无法核实的捕获仍可能返回不可用。该实现不承诺所有第三方菜单／对话框都能操作，不通过绕过权限、直接窗口消息或未知 API 强制确认。实际保存、下载和产物内容仍需后状态／文件核对。

已编写原生合成 owner 嵌套／跨进程／同名与循环、模态未知、GUI／窗口图变化、popup／owner／外部菜单、引用过期／重用／去重预算、菜单焦点／上下文失效与后台语义绕过测试；主进程覆盖严格协议、关系与模式伪造、短期引用、迟到结果、菜单关闭后的输入事实及结果交付不重扫／不重按。用户可运行：

```powershell
node --test tests/windows-window-catalog.test.mjs tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-helper.test.mjs
dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --configuration Release --no-restore
```

智能体只做 Node 语法检查、原生测试源码编译及 npm run build，未运行测试、启动 Electron／helper 或操作真实桌面。交付状态为“构建通过，等待测试”。真实应用需检查文件选择／另存为／覆盖和未保存提示、上下文／嵌套菜单、截图不可用时的控件路径、菜单关闭／焦点变化和混合 DPI；项目继续只使用 npm run dev 启动。

API 依据：[GW_OWNER 与窗口关系](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindow)、[GUITHREADINFO 菜单／焦点／捕获状态](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-guithreadinfo)、[UIA 模态属性](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-control-pattern-propids)、[UIA Menu 控件类型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-supportmenucontroltype)。

## 第 23 项：条件等待（wait_for）

这是 computer use 的一个只读动作，复用现有能力说明、DeepSeek 请求识别、任务／步骤令牌和结果自动交付。保持现有系统提示词、助手角色、确认规则及其他工具不变。

模型一次提交一个条件及其专属字段：

| condition | 字段 | 满足条件的证据 |
| --- | --- | --- |
| window_present | query（1—200 字符非空白子串），可选 pid | 忽略大小写地匹配真实标题、应用名、可执行文件路径或 AppUserModelID；完整枚举中唯一可见、非最小化、非 cloaked、身份已核实的普通窗口。排除菜单和本软件控制窗口。 |
| text_present | window_id、text（1—200 字符非空白子串） | 目标窗口有界 UIA 树中至少一个可见、属性完整、已确认非密码的控件名称包含 text，区分大小写。不是 OCR、TextPattern 全文或编辑框 ValuePattern 内容；提供方不暴露名称时可能无法确认。 |
| control_available | window_id、selector: { name, role? } | 按 1—256 字符完整名称精确匹配，可选现有 UIA role；窗口启用，控件可见且启用，完整树内唯一匹配。多个同名控件不选择第一个，不接受旧 element_id。 |

其他公开字段为 timeout_ms（默认 10000，100—30000）及 observation（默认 controls，可选 window）。字段互斥，主进程和 helper 均拒绝脚本、正则、裸句柄和额外字段。控件树固定深度 4、最多 100 个控件、不读取选中文本，单次 UIA 软预算 100—500ms。部分树里已观察到文字可以证明存在；未匹配只能说明本次没看到。部分树不能证明控件唯一，因此不报告唯一控件可用。密码、离屏、属性未知及名称截断均沿用原有脱敏与限制。

主进程用 performance.now 的单调时钟管理检查期限，用可取消的异步定时器本地推进，每次仅请求一次 helper wait_for 采样。首次间隔 250ms，修订未变（含事件不可用）时退避到 500／1000ms，修订改变后回到 250ms；最多 128 次检查。复用现有 WinEvent 消息循环的修订，不逐轮注册监听、不让模型反复发工具调用，不在轮询中截图、聚焦、点击或输入。事件只提示变化；检查前后修订变化时返回 state_changed，不能把事件或稳定状态当谓词证据。多窗口／多控件明确返回歧义，模型需细化条件。

公开 timeout_ms 限制条件检查阶段：单次原生请求按剩余期限向下取整设置硬超时，范围 100—4000ms（100ms 为既有 helper 协议的最小粒度）；UIA 的协作软预算不能强行中断已阻塞的 COM 调用，仍由既有 helper 取消宽限／强制终止机制处理。取消、换任务、作用域失效或 helper 代次更换会停止后续采样／后观察与旧结果发布。时间到达之后才返回的满足采样也按超时处理，不继续补等。

window_present 无需先 list_windows。helper 在同一私有作用域内登记最多 32 个等待发现的普通窗口引用，同一身份复用引用，不重建原 list_windows 批次，不清除原普通窗口或关联弹窗引用；主进程独立校验采样后才接纳。新引用可继续 observe、focus_window 或 inspect_interactions，仍受原快照两分钟期限及每次入口真实身份／生命周期检查约束，不延长原期限。新 list_windows 仍会使旧批次失效。总引用边界为原普通窗口 512、关联引用 64、等待引用 32；活动菜单仍通过第 22 项专门路径发现。

等待结束后至多调用一次现有 observe，默认返回新控件树；observation=window 返回一张同来源 PNG 加控件树。该采集使用原有独立 20 秒硬期限，不计入检查阶段 timeout_ms 或 wait_elapsed_ms，因此整次工具可能超过检查期限。新观察绑定当前真实步骤，可以作为后续动作来源，输入仍需原生实时复核。文字／控件会根据新树重新计算，已变化或采集失败时不报告满足；窗口发现的唯一性和 query 匹配来自 last_check，结束观察确认同一真实窗口仍可观察，所有读取均非桌面原子快照。没有唯一窗口时返回最后发现概要及 target_unresolved，不猜测来源或截取整个桌面。

结果包含 condition、condition_met、status、timeout_ms、wait_elapsed_ms、checks、last_check，以及 observation 或 post_observation_error；采样失败附 check_error。checks 记录已返回的 helper 检查请求数，包含失败请求；等待期间中断且无法收到回执时 execution 保留 unknown。超时为 wait_timeout，目标不唯一为 wait_ambiguous，不可恢复的采样错误、协议或最终证据失败为 wait_failed（可恢复的 UIA 不可用持续到期限时仍为 wait_timeout）；即使失败也交付可用的新观察。snapshot_atomic、input_ready、goal_verified 固定 false；仅表示本次固定条件是否有证据，业务目标由 DeepSeek 按后状态继续判断。页面忙碌只重发保存的结果和附件，不重跑等待。

已编写两端严格参数／伪造回执、文字与控件谓词、部分树／禁用／密码／多目标、窗口引用保持与容量／过期／生命周期、事件变化、单调超时／退避、取消／换任务／helper、最终状态变化／采集失败和忙碌交付用例。用户可运行以下测试；智能体仅做语法检查、测试源码编译与项目构建：

```powershell
node --test tests/windows-wait.test.mjs tests/windows-window-catalog.test.mjs tests/windows-observation.test.mjs tests/task-progression.test.mjs tests/windows-helper.test.mjs

dotnet run --project tests/native-app-catalog/Web2Term.AppCatalog.Tests.csproj --configuration Release --no-restore
```

真实应用需在 npm run dev 中检查延迟出现的窗口、加载后出现的 UIA 文字／启用控件、多窗口／同名控件、文字未通过 UIA 暴露、超时、停止及模型连续自主调用。交付状态为“构建通过，等待测试”，未运行测试或操作真实桌面。

计时依据：[Node 单调 performance.now](https://nodejs.org/api/perf_hooks.html#performancenow)、[可取消异步定时器](https://nodejs.org/api/timers.html#timerspromisessettimeoutdelay-value-options)。


## 第 38 项：人工接管与异常焦点

当前私有协议为 v4，拒绝旧 v3 helper；模型侧 computer JSON 仍为 v1。主进程根据全局桌面 owner 签发 `watch_desktop`，帧含随机 `watch_id` 与 helper `epoch`；动作请求也携带 `watch_id`。只有有效监测及匹配 watch 才允许 click／type_text／press_key／scroll／drag／focus_window／launch_app／open。

`DesktopActivityMonitor` 独立消息线程注册低级键盘、鼠标钩子及前台事件。自身 marker 的注入输入排除；物理 key-down／鼠标 down／滚轮归为 `human-input`，其他注入为 `external-input`，仅焦点变化为 `focus-changed`，监测线程失效为 `monitor-unavailable`。移动、up 本身不判人工接管；键盘落在前台窗口、点击和滚轮落在指针下的窗口，其根窗口属于 Web2Term 主进程时（在软件自己的界面里滚动、点击、输入）不算接管或干扰。`desktop_activity`（协议 v5）只附带输入类别 `input`：keyboard／click／wheel，焦点与监测事件为 null；不包含键码、文本、坐标或窗口标题。主进程把非焦点事件的类型写入 %TEMP%gpt-login-diagdesktop-activity-*.log。

钩子内只设置无锁输入停止闸门，避免与 SendInput 等待钩子返回时死锁；清理、取消与协议发布在钩子外完成，不等待 UIA。自身持有的 key-up／mouse-up 沿用输入跟踪账本；已进入系统的输入无法撤销。UIA 写入／点击、程序启动和窗口激活也复核停止闸门。

人工接管暂停原任务并阻止其他排队目标接管桌面，直到用户明确继续且旧执行器退出、真实提交确认；恢复后先新 observe。焦点事件只使旧输入观察失效；外部注入及监测不可用停止本轮并退役进程，由模型基于实际结果重新观察，不误判成人工接管。迟到旧 watch 不暂停替换目标。

实现与用户测试步骤见 [第 38 项说明](../../../docs/deepseek-computer-use-takeover.md)。本次只构建，未运行原生／Node 测试或真实桌面动作，状态为“构建通过，等待测试”。
