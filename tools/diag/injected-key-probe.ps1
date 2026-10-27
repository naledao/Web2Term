# User-run probe: which injected keyboard events interrupt a computer-use drag?
# Every drag on 2026-10-27 stopped ~0.9 s after it started with desktop-activity "external-input keyboard":
# an injected key-down that does not carry Web2Term's marker. The helper sends no keyboard input during a
# drag, so another program injects it. This logs those events only, to name the key and the context.
# See tools/diag/README.md, section "injected-key-probe.ps1".
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\diag\injected-key-probe.ps1
#
# Logged per foreign injected key event: message, virtual-key code, flags, dwExtraInfo and the foreground
# process name/pid. Never logged: physical (non-injected) keys, the character a VK_PACKET carries,
# window titles, coordinates, and Web2Term's own marked input.

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { Write-Warning '请用 64 位 PowerShell 运行：32 位进程看到的 dwExtraInfo 只有 32 位。' }

$dir = if ($env:PROBE_LOG_DIR) { $env:PROBE_LOG_DIR } else { Join-Path $env:TEMP 'gpt-login-diag' }
New-Item -ItemType Directory -Force $dir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$log = Join-Path $dir "injected-key-$stamp-$PID.log"

$source = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class InjectedKeyProbe
{
    // Same layout as native/computer-use/windows/DesktopActivityMonitor.cs.
    [StructLayout(LayoutKind.Sequential)] struct KeyHook { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
    delegate IntPtr HookProc(int code, UIntPtr message, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, UIntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string module);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

    struct Seen { public DateTime At; public uint Message, Key, Flags, Pid; public ulong Extra; }

    const uint VkPacket = 0xE7;
    static readonly ConcurrentQueue<Seen> queue = new ConcurrentQueue<Seen>();
    static readonly AutoResetEvent pending = new AutoResetEvent(false);
    static HookProc keyProc; // Rooted so the GC cannot collect the callback.
    static IntPtr keyHook;
    static string logPath;
    static Form form;
    static Label label;
    static volatile bool closing;
    static int foreign, own;

    static void Log(string line)
    {
        File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine, new UTF8Encoding(false));
    }

    // native/computer-use/windows/ClickInterop.cs: 0x57320000 | (pid & 0xFFFF), fits in 31 bits.
    static bool Web2TermMarker(ulong extra) { return extra <= 0xFFFFFFFFUL && (extra & 0xFFFF0000UL) == 0x57320000UL; }

    static IntPtr KeyCallback(int code, UIntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            KeyHook e = (KeyHook)Marshal.PtrToStructure(data, typeof(KeyHook));
            bool injected = (e.Flags & 0x12u) != 0; // LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED, as the helper checks.
            ulong extra = e.Extra.ToUInt64();
            if (injected && Web2TermMarker(extra)) Interlocked.Increment(ref own);
            else if (injected)
            {
                // Keep the hook fast: the foreground pid only; names and file writes happen on the writer thread.
                uint pid = 0;
                GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                queue.Enqueue(new Seen { At = DateTime.UtcNow, Message = (uint)message.ToUInt64(), Key = e.Key, Flags = e.Flags, Pid = pid, Extra = extra });
                pending.Set();
            }
            // Physical keys are neither queued nor counted.
        }
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static string MessageName(uint message)
    {
        switch (message)
        {
            case 0x100: return "keydown";
            case 0x101: return "keyup";
            case 0x104: return "syskeydown";
            case 0x105: return "syskeyup";
            default: return "0x" + message.ToString("X");
        }
    }

    static string ProcessName(uint pid)
    {
        if (pid == 0) return "none";
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "unavailable"; }
    }

    static void Writer()
    {
        while (!closing || !queue.IsEmpty)
        {
            pending.WaitOne(250);
            Seen s;
            while (queue.TryDequeue(out s))
            {
                int n = Interlocked.Increment(ref foreign);
                // A VK_PACKET carries a character in its scan code; only "packet" is written, never the character.
                string key = s.Key == VkPacket ? "packet" : "0x" + s.Key.ToString("X2");
                // The helper interrupts on keydown/syskeydown (DesktopActivityPolicy.Classify).
                bool interrupts = s.Message == 0x100 || s.Message == 0x104;
                Log(string.Format("FOREIGN n={0} at={1} msg={2} vk={3} flags=0x{4:X} extra=0x{5:X16} lowerIl={6} interrupts={7} foreground={8}({9})",
                    n, s.At.ToString("HH:mm:ss.fff"), MessageName(s.Message), key, s.Flags, s.Extra, (s.Flags & 0x2u) != 0, interrupts, ProcessName(s.Pid), s.Pid));
                SetStatus();
            }
        }
    }

    static void SetStatus()
    {
        try { form.BeginInvoke(new Action(delegate {
            label.Text = string.Format("正在记录非 Web2Term 标记的注入按键。\n现在让 AI 做一次拖拽，失败后关闭本窗口。\n\n外部注入按键：{0}　Web2Term 自己的：{1}", foreign, own);
        })); } catch { }
    }

    public static void Run(string path)
    {
        logPath = path;
        Log(string.Format("START pid={0} is64={1} os={2}", Process.GetCurrentProcess().Id, Environment.Is64BitProcess, Environment.OSVersion.VersionString));
        form = new Form { Text = "注入按键探针", TopMost = true, StartPosition = FormStartPosition.Manual,
            FormBorderStyle = FormBorderStyle.FixedToolWindow, ClientSize = new Size(420, 130), Location = new Point(40, 40) };
        label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Microsoft YaHei UI", 10f), Text = "准备中……" };
        form.Controls.Add(label);
        Thread writer = new Thread(Writer) { IsBackground = true };
        form.Load += delegate {
            keyProc = KeyCallback;
            keyHook = SetWindowsHookEx(13, keyProc, GetModuleHandle(null), 0);
            Log(string.Format("HOOK keyboard={0}", keyHook != IntPtr.Zero));
            writer.Start(); SetStatus();
        };
        form.FormClosing += delegate { closing = true; pending.Set(); };
        Application.Run(form);
        // Unhook first: with no message loop left, an installed LL hook would stall every real key.
        if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
        if (writer.IsAlive) writer.Join(3000);
        Log(string.Format("DONE foreignInjected={0} web2termMarked={1}", foreign, own));
    }
}
'@

# An unexpanded LIB (e.g. the literal "%LIB%") is a compiler warning that Add-Type treats as an error.
# This process-only change touches nothing outside this run.
$env:LIB = $null
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
[InjectedKeyProbe]::Run($log)
Write-Host "日志：$log"
