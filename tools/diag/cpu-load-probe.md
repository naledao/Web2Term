# CPU 与终端输出对界面响应的对照实验

由用户运行，智能体只读日志。本探针不启动 Electron、不联网、不读取会话、账号、命令历史或应用数据库，也不修改应用代码。

计算负载在独立 Node 进程的工作线程中执行，模拟 AI 经本机终端启动多线程计算程序。每组运行时间为 5～30 秒，默认 30 秒；工作线程共享单调时钟截止时间，即使协调线程定时器延迟，也会自行结束计算。启动工作线程最多另等待 10 秒。默认模式是空闲基线；CPU 模式默认使用半数可用逻辑处理器。

## 实验方法

应用只由用户通过以下命令启动：

```powershell
npm run dev
```

在 Web2Term 的**本机终端**里逐条执行下面命令，也可以让 AI 逐条执行同样的命令。使用前台命令，AI 的命令超时设为至少 45 秒。每组结束后等待数秒再开始下一组。工作目录为 `C:\codes\gpt-web-to-codex-terminal`。

| 组别 | 用途 |
| --- | --- |
| A 基线 | 测量没有额外计算及大量输出时的响应 |
| B 半核计算 | 观察保留部分 CPU 余量时的响应；只有每秒一条状态输出 |
| C 全核计算 | 观察 CPU 争用对应用的影响；只有每秒一条状态输出 |
| D 纯输出 | 单独观察接收输出、历史拼接、IPC 和界面渲染的影响 |
| E 混合，可选 | 同时增加 CPU 和输出压力 |
| F 降优先级，可选 | 与 C 对照，观察让计算进程让出调度优先权是否有帮助 |

```powershell
# A：空闲基线
node tools/diag/cpu-load-probe.cjs --mode=baseline --seconds=30

# B：半数可用核心计算
node tools/diag/cpu-load-probe.cjs --mode=cpu --workers=half --seconds=30

# C：全部可用核心计算
node tools/diag/cpu-load-probe.cjs --mode=cpu --workers=all --seconds=30

# D：每秒约 64 KiB 的合成输出
node tools/diag/cpu-load-probe.cjs --mode=output --rate-kib=64 --seconds=30

# E：全核计算 + 输出
node tools/diag/cpu-load-probe.cjs --mode=mixed --workers=all --rate-kib=64 --seconds=30

# F：全核计算，计算进程使用低于普通的 CPU 优先级
node tools/diag/cpu-load-probe.cjs --mode=cpu --workers=all --priority=below-normal --seconds=30
```

若 D 没有明显影响，可另做一组 `--rate-kib=256`；每秒最多支持 512 KiB，不会无限制刷屏。考虑管道背压及实际调度，实际写入速率可能低于设定值，以日志为准。`--workers=1` 可单独观察单核满载。为限制工作线程内存开销，工作线程数最多 64；超大机器需要显式选择不超过 64 个线程。

测试的是**实际执行命令的机器**。如果终端连接 SSH 或远程设备，计算负载在远端产生，不能用它判断本机 CPU 争用；返回的大量输出仍会增加本机处理开销。

## 每组做相同的界面操作

为了区分 CPU 饱和与长历史造成的额外负担，先在短会话中做 A～D，再在已有大量记录的会话中重复。记录软件版本、开发模式或安装版、会话大致记录量，以及终端连接方式，保证对照条件一致。

- 在专注视图输入一段草稿，观察是否跟手，不需要发送消息。
- 切换终端、专注和原始视图，观察延迟。
- 滚动历史，展开一条旧命令的输出，观察延迟。
- 同时观察 Windows 任务管理器的整机 CPU、内存和 Web2Term/Electron 进程组。对比其他应用是否也变慢。
- 单独再跑一次 B，在运行约 10 秒时点终端“中断”，记录从点击到停止计算、恢复输入的时间；如通过 AI 发起，再另测一次“结束任务”。

每项可记为：流畅 / 可感知延迟 / 1～3 秒 / 超过 3 秒，并记录中断是否成功。脚本不自动点击界面，不自动测量 Electron 输入或绘制延迟。

## 终止和清理

- Web2Term 本机终端优先用“中断”；在普通 PowerShell 中可用 Ctrl+C。
- 未能及时操作时，计算线程会在本组截止时间到达后自行停止；系统调度和输出排空仍可能使终端提示稍晚出现。
- 本探针没有子进程、计划任务或后台服务。所有工作线程属于同一个 Node 进程，应用终止该进程时线程也会被终止。
- Windows 当前终端中断使用进程树终止，可能来不及写入 `END`，这时不能仅凭缺少 `END` 判断中断失败。结合点击时间、最后一条样本和任务管理器判断。

## 日志位置及解释

每次运行一个日志文件：

```text
%TEMP%\gpt-login-diag\cpu-load-<UTC 时间>-<PID>.log
```

启动及结束时打印 `LOG=...`。日志用 `fs.appendFileSync` 同步追加，合成刷屏内容不会复制进日志。日志不包含会话内容、Cookie、凭据或截图。

| 字段 / 事件 | 含义 |
| --- | --- |
| `SETUP` / `START` | 参数、可用/整机逻辑处理器数、实际线程数、进程优先级及 PID |
| `systemCpuPct` | 根据操作系统 CPU 时间差计算的整机平均 CPU 使用率，可能与任务管理器的采样时刻及算法有差异 |
| `probeCpuPctAllCores` | 压力进程全部线程 CPU 时间按整机核心数归一化后的占用；100% 近似占满整机计算资源 |
| `probeCpuCoreEquivalents` | 压力进程消耗的逻辑核心等效数量，例如 4 左右表示约四个核心持续计算；不表示硬件核心利用率精确相等 |
| `probeRssMiB` / `systemFreeMiB` | 压力进程含工作线程的常驻内存、系统可用内存；用于发现内存不足这一混杂因素 |
| `probeLoopP95Ms` / `probeLoopMaxMs` | **压力进程协调线程**的事件循环间隔分布；包含约 20ms 的采样间隔，不能直接当成 Electron 的界面延迟 |
| `timerLateMs` / `intervalMs` | 该探针每秒采样定时器的延后及实际样本间隔，不是界面点击耗时 |
| `outputBytes` / `outputKiBPerSecond` | 已提交给标准输出流的合成数据量/速率，不代表软件已经完成显示；不含每秒的小条状态消息 |
| `backpressureEvents` / `blockedOutputTicks` | 标准输出出现背压，以及暂停生产输出的次数；也可能受 PowerShell/终端管道影响 |
| `END.reason` | 正常结束、中断、启动失败或输出管道关闭等原因 |

脚本响应 stdout 背压：写入受阻时停止生成后续批次，不累积待补发输出。每批最多 64 KiB，总合成输出量受速率 × 时间限制。默认 D 最多约 1.875 MiB，256 KiB/s 组最多约 7.5 MiB。

## 如何判断结果

- B 流畅、C 变慢，且其他应用也变慢：支持“整机 CPU 争用”的解释；F 若改善，说明调度优先级可能有帮助。优先级不等于 CPU 配额。
- C 仍可操作、D 却明显卡：重点检查终端输出拼接、主进程处理、快照传输与渲染。
- 短会话流畅、长会话明显慢：重点检查随历史规模增长的工作。
- E 比 C、D 都更差：可能是计算资源争用和输出处理开销叠加。
- CPU 没接近饱和但软件单独冻结：不能简单归因于“指令吃 CPU”，需要结合软件日志进一步定位主进程/渲染阻塞。

这些是判断方向，不能仅凭一项指标下结论。实验后把对应日志路径和每组界面观察结果发给智能体，由智能体读取日志再分析。

参考：[Electron 性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)、[Windows 调度优先级](https://learn.microsoft.com/en-us/windows/win32/procthread/scheduling-priorities)、[Node 工作线程](https://nodejs.org/api/worker_threads.html)、[事件循环延迟采样](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions)。
