# User-run probe: does SendInput's dwExtraInfo reach a WH_MOUSE_LL / WH_KEYBOARD_LL hook intact?
# The Windows helper marks its own input as (pid << 32) | 0x57325443 and treats any other injected
# click as "external_input". If the hook only sees the low 32 bits, every helper click is misjudged.
# See tools/diag/README.md, section "mouse-extrainfo-probe.ps1".
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\diag\mouse-extrainfo-probe.ps1
#
# Clicks, wheel and the unassigned virtual key 0x88 are only sent while the cursor is over the
# probe's own window. Logs never hold coordinates, window titles or real key values.

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { Write-Warning '请用 64 位 PowerShell 运行：helper 是 x64，32 位进程的 dwExtraInfo 本身只有 32 位，结论无效。' }

$dir = if ($env:PROBE_LOG_DIR) { $env:PROBE_LOG_DIR } else { Join-Path $env:TEMP 'gpt-login-diag' }
New-Item -ItemType Directory -Force $dir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$log = Join-Path $dir "mouse-extrainfo-$stamp-$PID.log"

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class ExtraInfoProbe
{
    // Same layouts as native/computer-use/windows/ClickInterop.cs and DesktopActivityMonitor.cs.
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort VirtualKey, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion Value; }
    [StructLayout(LayoutKind.Sequential)] struct Pt { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHook { public Pt Point; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyHook { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
    delegate IntPtr HookProc(int code, UIntPtr message, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, UIntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string module);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Pt point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Pt point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);

    struct Seen { public bool Keyboard; public uint Message, Flags; public ulong Extra; }

    const ushort ProbeKey = 0x88; // Unassigned virtual key: nothing acts on it.
    const int PassiveSeconds = 20;
    static readonly object gate = new object();
    static readonly List<Seen> seen = new List<Seen>();
    static readonly List<ulong> ownMarkers = new List<ulong>();
    static HookProc mouseProc, keyProc; // Rooted so the GC cannot collect the callbacks.
    static IntPtr mouseHook, keyHook, formHandle;
    static string logPath;
    static Form form;
    static Label label;
    static volatile bool closing;

    static void Log(string line)
    {
        File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine, new UTF8Encoding(false));
    }

    static IntPtr MouseCallback(int code, UIntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            MouseHook e = (MouseHook)Marshal.PtrToStructure(data, typeof(MouseHook));
            Seen s = new Seen { Keyboard = false, Message = (uint)message.ToUInt64(), Flags = e.Flags, Extra = e.Extra.ToUInt64() };
            lock (gate) seen.Add(s);
        }
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static IntPtr KeyCallback(int code, UIntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            KeyHook e = (KeyHook)Marshal.PtrToStructure(data, typeof(KeyHook));
            // Only the probe's own key is kept; real keys are recorded as message/flags/extra, never their value.
            Seen s = new Seen { Keyboard = true, Message = (uint)message.ToUInt64(), Flags = e.Flags, Extra = e.Key == ProbeKey ? e.Extra.ToUInt64() : 0 };
            lock (gate) seen.Add(s);
        }
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static bool Injected(Seen s) { return (s.Flags & (s.Keyboard ? 0x12u : 0x3u)) != 0; }

    static string Kind(Seen s)
    {
        if (s.Keyboard) return "key";
        switch (s.Message)
        {
            case 0x200: return "move";
            case 0x201: case 0x202: case 0x204: case 0x205: case 0x207: case 0x208: return "button";
            case 0x20A: case 0x20E: return "wheel";
            default: return "other";
        }
    }

    static string Verdict(ulong sent, ulong got)
    {
        if (got == sent) return "PRESERVED";
        ulong low = sent & 0xFFFFFFFFUL;
        if (got == low) return "TRUNCATED_LOW32";
        ulong extended = (low & 0x80000000UL) != 0 ? low | 0xFFFFFFFF00000000UL : low;
        if (got == extended) return "SIGN_EXTENDED_LOW32";
        return "OTHER";
    }

    static Input Mouse(int x, int y, uint flags, uint data, ulong extra)
    {
        Input i = new Input { Type = 0 };
        i.Value.Mouse = new MouseInput { X = x, Y = y, Flags = flags, Data = data, Extra = new UIntPtr(extra) };
        return i;
    }

    static Input Key(bool up, ulong extra)
    {
        Input i = new Input { Type = 1 };
        i.Value.Keyboard = new KeyboardInput { VirtualKey = ProbeKey, Flags = up ? 2u : 0u, Extra = new UIntPtr(extra) };
        return i;
    }

    static void Send(string what, Input input)
    {
        uint accepted = SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
        if (accepted != 1) Log(string.Format("SEND-FAILED {0} error={1}", what, Marshal.GetLastWin32Error()));
        Thread.Sleep(40);
    }

    static void SetStatus(string text)
    {
        try { form.BeginInvoke(new Action(delegate { label.Text = text; })); } catch { }
    }

    static bool OverProbeWindow()
    {
        Pt p;
        if (!GetCursorPos(out p)) return false;
        IntPtr hit = WindowFromPoint(p);
        return hit != IntPtr.Zero && GetAncestor(hit, 2) == formHandle; // GA_ROOT
    }

    static Dictionary<string, string> RunCase(string name, ulong extra)
    {
        Log(string.Format("CASE {0} sent=0x{1:X16}", name, extra));
        Point center = (Point)form.Invoke(new Func<Point>(delegate {
            return form.PointToScreen(new Point(form.ClientSize.Width / 2, form.ClientSize.Height / 2));
        }));
        SetCursorPos(center.X, center.Y);
        Thread.Sleep(150);
        int start;
        lock (gate) start = seen.Count; // After SetCursorPos, so its own move is not attributed to this case.

        Send("move+1", Mouse(1, 0, 0x0001, 0, extra));
        Send("move-1", Mouse(-1, 0, 0x0001, 0, extra));
        bool onWindow = OverProbeWindow();
        if (onWindow)
        {
            Send("left-down", Mouse(0, 0, 0x0002, 0, extra));
            Send("left-up", Mouse(0, 0, 0x0004, 0, extra));
            Send("wheel", Mouse(0, 0, 0x0800, 120, extra));
        }
        else Log("SKIP button/wheel: cursor is not over the probe window (was the mouse moved?)");
        Send("key-down", Key(false, extra));
        Send("key-up", Key(true, extra));
        Thread.Sleep(300);

        List<Seen> window;
        lock (gate) window = seen.GetRange(start, seen.Count - start);
        Dictionary<string, HashSet<string>> byKind = new Dictionary<string, HashSet<string>>();
        int physical = 0;
        foreach (Seen s in window)
        {
            if (!Injected(s)) { physical++; continue; }
            string kind = Kind(s), verdict = Verdict(extra, s.Extra);
            Log(string.Format("SEEN case={0} kind={1} msg=0x{2:X} flags=0x{3:X} extra=0x{4:X16} -> {5}", name, kind, s.Message, s.Flags, s.Extra, verdict));
            if (!byKind.ContainsKey(kind)) byKind[kind] = new HashSet<string>();
            byKind[kind].Add(verdict);
        }
        if (physical > 0) Log(string.Format("NOTE case={0} physicalEvents={1} (real mouse/keyboard during the case; ignored)", name, physical));

        Dictionary<string, string> summary = new Dictionary<string, string>();
        foreach (string kind in new[] { "move", "button", "wheel", "key" })
        {
            HashSet<string> v;
            summary[kind] = !byKind.TryGetValue(kind, out v) ? (kind == "button" || kind == "wheel") && !onWindow ? "SKIPPED" : "NOT_SEEN"
                : v.Count == 1 ? new List<string>(v)[0] : "MIXED(" + string.Join("|", new List<string>(v).ToArray()) + ")";
        }
        Log(string.Format("SUMMARY case={0} move={1} button={2} wheel={3} key={4}", name, summary["move"], summary["button"], summary["wheel"], summary["key"]));
        return summary;
    }

    static bool Ours(ulong extra)
    {
        foreach (ulong marker in ownMarkers) if (Verdict(marker, extra) != "OTHER") return true;
        return false;
    }

    static void Worker()
    {
        try
        {
            Thread.Sleep(600);
            Pt original;
            bool restore = GetCursorPos(out original);
            SetStatus("自动测试中（约 5 秒）……请不要移动鼠标、不要按键。");

            ulong pid = (ulong)(uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            string[] names = { "helper-style", "low32-only", "low32-highbit", "high-bit-64" };
            ulong[] markers = { (pid << 32) | 0x57325443UL, 0x57325443UL, 0xFFC3D44FUL, 0x8000000057325443UL };
            ownMarkers.AddRange(markers);
            Dictionary<string, string> helper = null;
            for (int i = 0; i < names.Length && !closing; i++)
            {
                Dictionary<string, string> result = RunCase(names[i], markers[i]);
                if (i == 0) helper = result;
            }
            if (restore) SetCursorPos(original.X, original.Y);

            if (helper != null)
            {
                string button = helper["button"];
                Log("VERDICT " + (button == "PRESERVED"
                    ? "helper-style marker SURVIVES on mouse buttons: truncation is NOT the cause; check FOREIGN lines for another injector."
                    : button == "TRUNCATED_LOW32" || button == "SIGN_EXTENDED_LOW32"
                        ? "helper-style marker LOSES its high 32 bits on mouse buttons (" + button + "): the helper's own clicks are misjudged as external_input."
                        : "inconclusive for mouse buttons (" + button + "); see SEEN lines.")
                    + " key=" + helper["key"] + " wheel=" + helper["wheel"]);
            }

            int passiveStart;
            lock (gate) passiveStart = seen.Count;
            Log(string.Format("PASSIVE start ({0}s): user may click in PowerPoint placeholders; only foreign injected input is reported", PassiveSeconds));
            for (int left = PassiveSeconds; left > 0 && !closing; left--)
            {
                SetStatus(string.Format("自动测试完成。\n可选：现在去 PowerPoint 点“空白文稿”、标题/副标题占位符，看有没有别的程序在注入点击。\n剩余 {0} 秒，也可以直接关闭本窗口。", left));
                Thread.Sleep(1000);
            }
            List<Seen> passive;
            lock (gate) passive = seen.GetRange(passiveStart, seen.Count - passiveStart);
            Dictionary<string, int> physical = new Dictionary<string, int>();
            int foreign = 0;
            foreach (Seen s in passive)
            {
                string kind = Kind(s);
                if (!Injected(s)) { int n; physical.TryGetValue(kind, out n); physical[kind] = n + 1; continue; }
                if (!s.Keyboard && Ours(s.Extra)) continue;
                foreign++;
                if (kind == "move") continue; // Counted, not listed: cursor tools move constantly.
                Log(string.Format("FOREIGN kind={0} msg=0x{1:X} flags=0x{2:X} extra=0x{3:X16}", kind, s.Message, s.Flags, s.Extra));
            }
            List<string> parts = new List<string>();
            foreach (KeyValuePair<string, int> p in physical) parts.Add(p.Key + "=" + p.Value);
            Log(string.Format("PASSIVE end foreignInjected={0} physical[{1}]", foreign, string.Join(" ", parts.ToArray())));
        }
        catch (Exception error) { Log("ERROR " + error.GetType().Name + ": " + error.Message); }
        finally
        {
            Log("DONE");
            try { form.BeginInvoke(new Action(delegate { form.Close(); })); } catch { }
        }
    }

    public static void Run(string path)
    {
        logPath = path;
        Log(string.Format("START pid={0} is64={1} ptrSize={2} inputSize={3} os={4} apartment={5}",
            System.Diagnostics.Process.GetCurrentProcess().Id, Environment.Is64BitProcess, IntPtr.Size,
            Marshal.SizeOf(typeof(Input)), Environment.OSVersion.VersionString, Thread.CurrentThread.GetApartmentState()));

        form = new Form { Text = "dwExtraInfo 探针", TopMost = true, StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedToolWindow, ClientSize = new Size(460, 200) };
        label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Microsoft YaHei UI", 10f),
            Text = "准备中……" };
        form.Controls.Add(label);
        Thread worker = new Thread(Worker) { IsBackground = true };
        form.Load += delegate {
            formHandle = form.Handle;
            mouseProc = MouseCallback; keyProc = KeyCallback;
            IntPtr module = GetModuleHandle(null);
            mouseHook = SetWindowsHookEx(14, mouseProc, module, 0);
            keyHook = SetWindowsHookEx(13, keyProc, module, 0);
            Log(string.Format("HOOKS mouse={0} keyboard={1}", mouseHook != IntPtr.Zero, keyHook != IntPtr.Zero));
        };
        form.Shown += delegate { form.Activate(); worker.Start(); };
        form.FormClosing += delegate { closing = true; };
        Application.Run(form);
        // Unhook first: with no message loop left, an installed LL hook would stall every real input.
        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
        if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
        if (worker.IsAlive) worker.Join(3000);
    }
}
'@

# An unexpanded LIB (e.g. the literal "%LIB%") is a compiler warning that Add-Type treats as an error.
# This process-only change touches nothing outside this run.
$env:LIB = $null
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
[ExtraInfoProbe]::Run($log)
Write-Host "日志：$log"
