<#
  sense.ps1 - long-lived Windows sensor + global hotkey helper for @local/situation.

  Windows PowerShell 5.1 ONLY (powershell.exe). Windows.Media.Ocr / WinRT cannot be
  loaded by PowerShell 7. stdout is a JSON-lines protocol (see CONTRACT.md section 1);
  diagnostics go to stderr and, optionally, -LogFile.

  One process does everything: capture, dHash change gating, JPEG encode, OCR,
  clipboard, hotkey message pump, control-file reload. No per-sample process spawn.
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [int]$IntervalMs = 1200,
  [int]$FrameMaxWidth = 1280,
  [int]$JpegQuality = 62,
  [int]$Ocr = 1,
  [int]$Clipboard = 0,
  [int]$IdleSkipSeconds = 240,
  [int]$FrameRetentionMinutes = 30,
  [string]$Hotkey = 'Ctrl+Alt+V',
  [int]$SelfTest = 0,
  [string]$LogFile = '',
  [double]$OcrScale = 2.0,
  [int]$TutorFrameMaxEdge = 1920
)

# ---------------------------------------------------------------------------
# 0. stdout writer: deterministic UTF-8 without BOM, one JSON object per line
# ---------------------------------------------------------------------------
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $script:Utf8 } catch { }
$script:Stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $script:Utf8, 8192)
$script:Stdout.AutoFlush = $true
$script:StdoutBroken = $false
$script:LogPath = $LogFile
$script:StartedIso = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
$script:FrameCount = 0
$script:FrameBytes = [int64]0
$script:OcrCount = 0
$script:HotkeyCount = 0

function Write-Log([string]$msg) {
  try { [Console]::Error.WriteLine(('{0} {1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $msg)) } catch { }
  if ($script:LogPath) {
    try {
      [System.IO.File]::AppendAllText($script:LogPath, ('{0} {1}{2}' -f (Get-Date).ToString('o'), $msg, "`r`n"), $script:Utf8)
    } catch { }
  }
}

function IsoNow { return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz') }
function EpochMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Emit-Json($obj) {
  $json = $null
  try { $json = ConvertTo-Json -InputObject $obj -Compress -Depth 8 }
  catch { Write-Log ('json-serialize-failed: ' + $_.Exception.Message); return }
  if ([string]::IsNullOrWhiteSpace($json)) { return }
  if ($json.IndexOf("`n") -ge 0 -or $json.IndexOf("`r") -ge 0) {
    $json = (($json -split "`r?`n") | Where-Object { $_ -ne '' }) -join ' '
  }
  try { $script:Stdout.WriteLine($json) }
  catch { $script:StdoutBroken = $true }
}

function Emit-Error([string]$message, [bool]$fatal = $false) {
  Emit-Json ([ordered]@{
      type = 'error'; ts = (IsoNow); epoch = (EpochMs); message = $message; fatal = $fatal
    })
}

# ---------------------------------------------------------------------------
# 1. Win32 / GDI+ interop (single Add-Type: compiled once per process)
# ---------------------------------------------------------------------------
$script:Cs = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Sit
{
    public sealed class Canvas : IDisposable
    {
        public Bitmap Bmp;
        public Graphics G;
        public void Ensure(int w, int h)
        {
            if (w < 1) w = 1;
            if (h < 1) h = 1;
            if (Bmp != null && Bmp.Width == w && Bmp.Height == h) return;
            if (G != null) { G.Dispose(); G = null; }
            if (Bmp != null) { Bmp.Dispose(); Bmp = null; }
            Bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            G = Graphics.FromImage(Bmp);
        }
        public void Dispose()
        {
            if (G != null) { G.Dispose(); G = null; }
            if (Bmp != null) { Bmp.Dispose(); Bmp = null; }
        }
    }

    public sealed class HashResult
    {
        public ulong Hash;
        public bool Uniform;
    }

    public static class Native
    {
        public const int WM_HOTKEY = 0x0312;
        const uint SRCCOPY = 0x00CC0020;
        const uint CAPTUREBLT = 0x40000000;
        const uint PM_REMOVE = 0x0001;
        const int SM_CXSCREEN = 0;
        const int SM_CYSCREEN = 1;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
            public uint time; public POINT pt;
        }

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
        [DllImport("user32.dll", SetLastError = true)] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
        [DllImport("gdi32.dll", SetLastError = true)] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

        // -------- DPI --------
        public static string SetDpi()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch { }
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-3))) return "per-monitor"; } catch { }
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-2))) return "system"; } catch { }
            try { if (SetProcessDPIAware()) return "system-legacy"; } catch { }
            try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor-legacy"; } catch { }
            return "unchanged";
        }

        // -------- foreground window --------
        public static long ForeHwnd() { return GetForegroundWindow().ToInt64(); }

        public static string Title(long hwnd)
        {
            IntPtr h = new IntPtr(hwnd);
            int n = GetWindowTextLength(h);
            if (n <= 0) return "";
            StringBuilder sb = new StringBuilder(n + 2);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        public static int Pid(long hwnd)
        {
            uint pid;
            GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
            return (int)pid;
        }

        public static int[] Rect(long hwnd)
        {
            RECT r;
            if (!GetWindowRect(new IntPtr(hwnd), out r)) return null;
            return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
        }

        public static bool IsMinimized(long hwnd) { return IsIconic(new IntPtr(hwnd)); }

        public static bool IsVisible(long hwnd) { return IsWindowVisible(new IntPtr(hwnd)); }

        public static int[] PrimaryScreen()
        {
            return new int[] { GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN) };
        }

        // x, y, width, height of the whole virtual desktop (origins may be negative).
        public static int[] VirtualScreen()
        {
            return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) };
        }

        public static long RootAt(int x, int y)
        {
            POINT point = new POINT();
            point.X = x;
            point.Y = y;
            IntPtr hwnd = WindowFromPoint(point);
            if (hwnd == IntPtr.Zero) return 0;
            IntPtr root = GetAncestor(hwnd, 2);
            if (root == IntPtr.Zero) root = hwnd;
            return root.ToInt64();
        }

        public static long[] HwndsForPid(int pid)
        {
            System.Collections.Generic.List<long> found = new System.Collections.Generic.List<long>();
            EnumProc callback = delegate(IntPtr hwnd, IntPtr lParam)
            {
                uint owner;
                GetWindowThreadProcessId(hwnd, out owner);
                if ((int)owner == pid) found.Add(hwnd.ToInt64());
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found.ToArray();
        }

        public static bool ExcludeFromCapture(long hwnd)
        {
            try { return SetWindowDisplayAffinity(new IntPtr(hwnd), 0x11); }
            catch { return false; }
        }

        public static void ReleaseCapture(long hwnd)
        {
            try { SetWindowDisplayAffinity(new IntPtr(hwnd), 0); } catch { }
        }

        public static string Fingerprint(Canvas src)
        {
            if (src == null || src.Bmp == null) return "";
            BitmapData data = src.Bmp.LockBits(new Rectangle(0, 0, src.Bmp.Width, src.Bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int length = data.Stride * src.Bmp.Height;
                byte[] buffer = new byte[length];
                Marshal.Copy(data.Scan0, buffer, 0, length);
                using (var sha = System.Security.Cryptography.SHA1.Create())
                {
                    byte[] hash = sha.ComputeHash(buffer);
                    char[] chars = new char[hash.Length * 2];
                    const string hex = "0123456789abcdef";
                    for (int i = 0; i < hash.Length; i++)
                    {
                        chars[i * 2] = hex[hash[i] >> 4];
                        chars[i * 2 + 1] = hex[hash[i] & 15];
                    }
                    return new string(chars);
                }
            }
            finally { src.Bmp.UnlockBits(data); }
        }

        public static uint IdleMs()
        {
            LASTINPUTINFO lii = new LASTINPUTINFO();
            lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref lii)) return 0;
            return unchecked((uint)Environment.TickCount - lii.dwTime);
        }

        // -------- capture --------
        public static bool PrintTo(long hwnd, Canvas c, uint flag)
        {
            if (c.G == null || c.Bmp == null) return false;
            Graphics g = c.G;
            bool prev = false;
            try { prev = g.IsClipEmpty; } catch { }
            g.Clear(Color.Black);
            IntPtr hdc = g.GetHdc();
            bool ok = false;
            try { ok = PrintWindow(new IntPtr(hwnd), hdc, flag); }
            finally { g.ReleaseHdc(hdc); }
            return ok;
        }

        public static bool BitBltRect(int x, int y, int w, int h, Canvas c)
        {
            if (c.G == null || w <= 0 || h <= 0) return false;
            Graphics g = c.G;
            IntPtr dst = g.GetHdc();
            IntPtr src = GetDC(IntPtr.Zero);
            bool ok = false;
            try
            {
                if (src != IntPtr.Zero) ok = BitBlt(dst, 0, 0, w, h, src, x, y, SRCCOPY | CAPTUREBLT);
            }
            finally
            {
                if (src != IntPtr.Zero) ReleaseDC(IntPtr.Zero, src);
                g.ReleaseHdc(dst);
            }
            return ok;
        }

        public static void ScaleInto(Canvas src, Canvas dst, int w, int h)
        {
            dst.Ensure(w, h);
            Graphics g = dst.G;
            g.CompositingMode = CompositingMode.SourceCopy;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.None;
            g.DrawImage(src.Bmp, new Rectangle(0, 0, w, h), 0, 0, src.Bmp.Width, src.Bmp.Height, GraphicsUnit.Pixel);
        }

        // -------- dHash (9x8 grayscale -> 64 bits) --------
        public static HashResult DHash(Canvas src, Canvas small)
        {
            HashResult res = new HashResult();
            small.Ensure(9, 8);
            Graphics g = small.G;
            g.CompositingMode = CompositingMode.SourceCopy;
            g.InterpolationMode = InterpolationMode.HighQualityBilinear;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.None;
            g.DrawImage(src.Bmp, new Rectangle(0, 0, 9, 8), 0, 0, src.Bmp.Width, src.Bmp.Height, GraphicsUnit.Pixel);

            BitmapData d = small.Bmp.LockBits(new Rectangle(0, 0, 9, 8), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            byte[] buf = new byte[d.Stride * 8];
            try { Marshal.Copy(d.Scan0, buf, 0, buf.Length); }
            finally { small.Bmp.UnlockBits(d); }

            int[] lum = new int[72];
            int min = 255, max = 0;
            for (int y = 0; y < 8; y++)
            {
                for (int x = 0; x < 9; x++)
                {
                    int i = y * d.Stride + x * 3;
                    int b = buf[i], gg = buf[i + 1], r = buf[i + 2];
                    int l = (r * 299 + gg * 587 + b * 114) / 1000;
                    lum[y * 9 + x] = l;
                    if (l < min) min = l;
                    if (l > max) max = l;
                }
            }
            ulong h = 0;
            for (int y = 0; y < 8; y++)
            {
                for (int x = 0; x < 8; x++)
                {
                    h <<= 1;
                    if (lum[y * 9 + x] > lum[y * 9 + x + 1]) h |= 1UL;
                }
            }
            res.Hash = h;
            res.Uniform = (max - min) <= 2;
            return res;
        }

        public static int PopCount(ulong v)
        {
            int n = 0;
            while (v != 0) { v &= (v - 1); n++; }
            return n;
        }

        public static int Dist(ulong a, ulong b) { return PopCount(a ^ b); }

        // -------- message pump --------
        public static int Pump()
        {
            int n = 0;
            MSG m;
            while (PeekMessage(out m, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                TranslateMessage(ref m);
                DispatchMessage(ref m);
                n++;
                if (n > 512) break;
            }
            return n;
        }

        // -------- hotkey --------
        public static bool Register(long hwnd, int id, uint mods, uint vk)
        {
            return RegisterHotKey(new IntPtr(hwnd), id, mods, vk);
        }

        public static bool Unregister(long hwnd, int id)
        {
            return UnregisterHotKey(new IntPtr(hwnd), id);
        }
    }

    public sealed class HotkeyWindow : NativeWindow, IDisposable
    {
        public static volatile bool Pending;
        public static volatile int LastId;

        public HotkeyWindow(bool messageOnly)
        {
            CreateParams cp = new CreateParams();
            cp.Caption = "SituationSensorHotkey";
            if (messageOnly) cp.Parent = new IntPtr(-3); // HWND_MESSAGE
            this.CreateHandle(cp);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY)
            {
                LastId = m.WParam.ToInt32();
                Pending = true;
            }
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            if (this.Handle != IntPtr.Zero) this.DestroyHandle();
        }
    }

    // Hold-to-talk on a typing key (space). A tap re-types the character on release; a
    // hold past the threshold becomes a start event, the release a stop event. The hook
    // lives on its own thread so screen capture/OCR never delays keyboard input.
    public static class HoldKey
    {
        public const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_KEYUP = 0x0101;
        const int WM_SYSKEYDOWN = 0x0104;
        const int WM_SYSKEYUP = 0x0105;
        const int WM_QUIT = 0x0012;
        const uint LLKHF_INJECTED = 0x10;
        const uint KEYEVENTF_KEYUP = 0x0002;

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        delegate IntPtr LowProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowProc lpfn, IntPtr hMod, uint threadId);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        static extern IntPtr GetModuleHandle(string lpModuleName);
        [DllImport("user32.dll")]
        static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")]
        static extern uint MapVirtualKey(uint uCode, uint uMapType);
        [DllImport("user32.dll")]
        static extern int GetMessage(out Native.MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
        [DllImport("user32.dll")]
        static extern bool TranslateMessage(ref Native.MSG lpMsg);
        [DllImport("user32.dll")]
        static extern IntPtr DispatchMessage(ref Native.MSG lpMsg);
        [DllImport("user32.dll")]
        static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();

        static LowProc proc;
        static IntPtr hook = IntPtr.Zero;
        static uint hookThreadId = 0;
        static System.Threading.Thread thread;
        static System.Threading.Timer timer;
        static volatile bool enabled;
        // Trigger key (space): held on its own it types; paired with the leader it talks.
        static int down;
        static int fired;
        static long downAt;
        // Leader key (e.g. B): never types while held; a tap still types its letter.
        static int leaderDown;
        static int leaderArmed;
        static int chordActive;
        static int chordUsed;
        static long leaderAt;
        static int startPending;
        static int stopPending;

        // Test hook: when true the filter accepts synthesized events too.
        public static volatile bool AcceptInjected;
        static readonly IntPtr Sentinel = new IntPtr(0x53495448);
        public static int Vk = 0x20;
        public static int LeaderVk = 0;
        public static int ArmMs = 200;
        public static int ThresholdMs = 800;
        public static string Error = "";

        public static bool Installed { get { return hook != IntPtr.Zero; } }

        public static bool Install(int vk, int leaderVk, int armMs, int thresholdMs)
        {
            Vk = vk;
            LeaderVk = leaderVk;
            ArmMs = armMs >= 40 ? armMs : 200;
            ThresholdMs = thresholdMs >= 120 ? thresholdMs : 800;
            Error = "";
            System.Threading.ManualResetEventSlim ready = new System.Threading.ManualResetEventSlim(false);
            thread = new System.Threading.Thread(delegate()
            {
                proc = HookProc;
                IntPtr mod = GetModuleHandle(null);
                hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, mod, 0);
                hookThreadId = GetCurrentThreadId();
                enabled = hook != IntPtr.Zero;
                ready.Set();
                Native.MSG msg;
                while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            });
            thread.IsBackground = true;
            thread.Start();
            ready.Wait(3000);
            if (hook == IntPtr.Zero)
            {
                enabled = false;
                Error = "SetWindowsHookEx failed, win32=" + Marshal.GetLastWin32Error();
                return false;
            }
            timer = new System.Threading.Timer(OnThreshold, null, System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
            return true;
        }

        public static void Uninstall()
        {
            enabled = false;
            if (timer != null) { try { timer.Dispose(); } catch { } timer = null; }
            if (hookThreadId != 0) { try { PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch { } }
            if (hook != IntPtr.Zero) { try { UnhookWindowsHookEx(hook); } catch { } hook = IntPtr.Zero; }
            proc = null;
        }

        static void OnThreshold(object state)
        {
            if (!enabled) return;
            if (LeaderVk != 0)
            {
                // Armed leader: a following trigger press becomes a chord.
                if (Interlocked.CompareExchange(ref leaderDown, 0, 0) == 0) return;
                Interlocked.Exchange(ref leaderArmed, 1);
                return;
            }
            if (Interlocked.CompareExchange(ref down, 0, 0) == 0) return;
            if (Interlocked.Exchange(ref fired, 1) == 0) Interlocked.Increment(ref startPending);
        }

        public static void Tick()
        {
            // Chord mode arms on its own timer only: a loop tick must not shorten the
            // arm window, or a fast "b then space" would count as a chord.
            if (LeaderVk != 0) return;
            OnThreshold(null);
        }

        public static int TakeStart() { return Interlocked.Exchange(ref startPending, 0); }

        public static int TakeStop() { return Interlocked.Exchange(ref stopPending, 0); }

        static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0 || !enabled) return CallNextHookEx(hook, nCode, wParam, lParam);
            KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int vk = (int)info.vkCode;
            bool isLeader = LeaderVk != 0 && vk == LeaderVk;
            if (!isLeader && vk != Vk) return CallNextHookEx(hook, nCode, wParam, lParam);
            // Our own re-typed characters must always pass, or a tap would loop forever.
            if (info.dwExtraInfo == Sentinel) return CallNextHookEx(hook, nCode, wParam, lParam);
            if (!AcceptInjected && (info.flags & LLKHF_INJECTED) != 0) return CallNextHookEx(hook, nCode, wParam, lParam);
            int msg = (int)wParam;
            bool isDown = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
            bool isUp = (msg == WM_KEYUP || msg == WM_SYSKEYUP);
            if (!isDown && !isUp) return CallNextHookEx(hook, nCode, wParam, lParam);

            if (isLeader)
            {
                if (isDown)
                {
                    if (Interlocked.CompareExchange(ref leaderDown, 1, 0) == 0)
                    {
                        leaderAt = Environment.TickCount;
                        Interlocked.Exchange(ref leaderArmed, 0);
                        Interlocked.Exchange(ref chordActive, 0);
                        Interlocked.Exchange(ref chordUsed, 0);
                        if (timer != null)
                        {
                            try { timer.Change(ArmMs, System.Threading.Timeout.Infinite); } catch { }
                        }
                    }
                    // Swallow: a leader that is being held must not type its letter.
                    return (IntPtr)1;
                }
                bool wasDown = Interlocked.Exchange(ref leaderDown, 0) == 1;
                bool armed = Interlocked.Exchange(ref leaderArmed, 0) == 1;
                if (timer != null)
                {
                    try { timer.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite); } catch { }
                }
                if (!wasDown) return CallNextHookEx(hook, nCode, wParam, lParam);
                if (Interlocked.Exchange(ref chordActive, 0) == 1)
                {
                    // Releasing the leader during a chord ends the dictation.
                    Interlocked.Exchange(ref chordUsed, 1);
                    Interlocked.Increment(ref stopPending);
                    return (IntPtr)1;
                }
                if (Interlocked.Exchange(ref chordUsed, 0) == 1)
                {
                    // The chord already used this leader press: no letter.
                    return (IntPtr)1;
                }
                // No chord happened: the leader was just a letter held a while, so type it.
                TypeKey(LeaderVk);
                return (IntPtr)1;
            }

            if (isDown)
            {
                bool chord = LeaderVk != 0
                    && Interlocked.CompareExchange(ref leaderArmed, 0, 0) == 1
                    && Interlocked.CompareExchange(ref leaderDown, 0, 0) == 1;
                if (chord)
                {
                    if (Interlocked.Exchange(ref chordActive, 1) == 0)
                    {
                        Interlocked.Exchange(ref chordUsed, 1);
                        Interlocked.Increment(ref startPending);
                    }
                    return (IntPtr)1;
                }
                if (Interlocked.CompareExchange(ref down, 1, 0) == 0)
                {
                    downAt = Environment.TickCount;
                    Interlocked.Exchange(ref fired, 0);
                    if (LeaderVk == 0 && timer != null)
                    {
                        try { timer.Change(ThresholdMs, System.Threading.Timeout.Infinite); } catch { }
                    }
                }
                // Swallow every press: a tap is re-typed on release.
                return (IntPtr)1;
            }

            bool triggerWasDown = Interlocked.Exchange(ref down, 0) == 1;
            bool triggerFired = Interlocked.Exchange(ref fired, 0) == 1;
            bool chordWasActive = Interlocked.Exchange(ref chordActive, 0) == 1;
            if (LeaderVk == 0 && timer != null)
            {
                try { timer.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite); } catch { }
            }
            if (!triggerWasDown && !chordWasActive) return CallNextHookEx(hook, nCode, wParam, lParam);
            if (chordWasActive) Interlocked.Exchange(ref chordUsed, 1); // the leader press was the chord, not a letter
            if (triggerFired || chordWasActive) { Interlocked.Increment(ref stopPending); return (IntPtr)1; }
            TypeKey(Vk);
            return (IntPtr)1;
        }

        static void TypeKey(int vk)
        {
            uint scan = MapVirtualKey((uint)vk, 0);
            UIntPtr tag = new UIntPtr((ulong)Sentinel.ToInt64());
            keybd_event((byte)vk, (byte)scan, 0, tag);
            keybd_event((byte)vk, (byte)scan, KEYEVENTF_KEYUP, tag);
        }
    }

    // Mouse clicks only. Installed while desktop tutoring is active and removed as soon as it stops.
    // The hook records the button and the screen point; it does not swallow the click and it never
    // sees keystrokes. Window titles are resolved on the sensor thread, not inside the hook.
    public static class ClickWatch
    {
        const int WH_MOUSE_LL = 14;
        const int WM_LBUTTONDOWN = 0x0201;
        const int WM_RBUTTONDOWN = 0x0204;
        const int WM_MBUTTONDOWN = 0x0207;
        const int WM_MOUSEWHEEL = 0x020A;
        const int WM_QUIT = 0x0012;

        [StructLayout(LayoutKind.Sequential)]
        struct MSLLHOOKSTRUCT
        {
            public Native.POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public UIntPtr extra;
        }

        struct Click
        {
            public int Button;
            public int X;
            public int Y;
            public long Epoch;
        }

        delegate IntPtr LowProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowProc lpfn, IntPtr hMod, uint threadId);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")]
        static extern int GetMessage(out Native.MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")]
        static extern bool TranslateMessage(ref Native.MSG msg);
        [DllImport("user32.dll")]
        static extern IntPtr DispatchMessage(ref Native.MSG msg);
        [DllImport("user32.dll")]
        static extern bool PostThreadMessage(uint id, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();

        static LowProc proc;
        static IntPtr hook = IntPtr.Zero;
        static uint hookThreadId;
        static System.Threading.Thread thread;
        static volatile bool enabled;
        static readonly object gate = new object();
        static readonly System.Collections.Generic.List<Click> pending = new System.Collections.Generic.List<Click>();
        static readonly DateTime unixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public static string Error = "";

        public static bool Installed { get { return hook != IntPtr.Zero; } }

        public static bool Install()
        {
            if (hook != IntPtr.Zero) return true;
            Error = "";
            System.Threading.ManualResetEventSlim ready = new System.Threading.ManualResetEventSlim(false);
            thread = new System.Threading.Thread(delegate()
            {
                proc = HookProc;
                hook = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
                hookThreadId = GetCurrentThreadId();
                enabled = hook != IntPtr.Zero;
                ready.Set();
                if (!enabled) return;
                Native.MSG msg;
                while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            });
            thread.IsBackground = true;
            thread.Start();
            ready.Wait(3000);
            if (hook == IntPtr.Zero)
            {
                enabled = false;
                Error = "SetWindowsHookEx mouse failed, win32=" + Marshal.GetLastWin32Error();
                return false;
            }
            return true;
        }

        public static void Uninstall()
        {
            enabled = false;
            if (hookThreadId != 0)
            {
                try { PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch { }
            }
            if (hook != IntPtr.Zero)
            {
                try { UnhookWindowsHookEx(hook); } catch { }
                hook = IntPtr.Zero;
            }
            proc = null;
            hookThreadId = 0;
            lock (gate) { pending.Clear(); }
        }

        public static int Drain(int[] buttons, int[] xs, int[] ys, long[] epochs)
        {
            lock (gate)
            {
                int n = pending.Count;
                if (n > buttons.Length) n = buttons.Length;
                for (int i = 0; i < n; i++)
                {
                    buttons[i] = pending[i].Button;
                    xs[i] = pending[i].X;
                    ys[i] = pending[i].Y;
                    epochs[i] = pending[i].Epoch;
                }
                if (n > 0) pending.RemoveRange(0, n);
                return n;
            }
        }

        static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && enabled)
            {
                int message = (int)wParam;
                int button = 0;
                MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if (message == WM_LBUTTONDOWN) button = 1;
                else if (message == WM_RBUTTONDOWN) button = 2;
                else if (message == WM_MBUTTONDOWN) button = 3;
                else if (message == WM_MOUSEWHEEL)
                {
                    int delta = (short)((info.mouseData >> 16) & 0xFFFF);
                    button = delta >= 0 ? 4 : 5;
                }
                if (button != 0)
                {
                    Click click = new Click();
                    click.Button = button;
                    click.X = info.pt.X;
                    click.Y = info.pt.Y;
                    click.Epoch = (long)(DateTime.UtcNow - unixEpoch).TotalMilliseconds;
                    lock (gate)
                    {
                        if (pending.Count < 256) pending.Add(click);
                    }
                }
            }
            return CallNextHookEx(hook, nCode, wParam, lParam);
        }
    }

    // Keyboard activity during tutoring. The hook never swallows a key. Printable keys
    // become text for one typing segment; Enter, Tab, Esc and shortcuts are actions.
    public static class KeyWatch
    {
        const int WH_KEYBOARD_LL = 13;
        const int WM_QUIT = 0x0012;
        const int LLKHF_UP = 0x80;

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public UIntPtr extra;
        }

        class Event
        {
            public int Kind;
            public long Epoch;
            public string Text;
        }

        delegate IntPtr LowProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowProc lpfn, IntPtr hMod, uint threadId);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")]
        static extern int GetMessage(out Native.MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")]
        static extern bool TranslateMessage(ref Native.MSG msg);
        [DllImport("user32.dll")]
        static extern IntPtr DispatchMessage(ref Native.MSG msg);
        [DllImport("user32.dll")]
        static extern bool PostThreadMessage(uint id, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")]
        static extern bool GetKeyboardState(byte[] state);
        [DllImport("user32.dll")]
        static extern int ToUnicode(uint vk, uint scan, byte[] state, [Out] StringBuilder buffer, int capacity, uint flags);

        static LowProc proc;
        static IntPtr hook = IntPtr.Zero;
        static uint hookThreadId;
        static System.Threading.Thread thread;
        static volatile bool enabled;
        static readonly object gate = new object();
        static readonly System.Collections.Generic.List<Event> pending = new System.Collections.Generic.List<Event>();
        static int lastDownVk = -1;
        static readonly DateTime unixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public static string Error = "";

        public static bool Installed { get { return hook != IntPtr.Zero; } }

        public static bool Install()
        {
            if (hook != IntPtr.Zero) return true;
            Error = "";
            System.Threading.ManualResetEventSlim ready = new System.Threading.ManualResetEventSlim(false);
            thread = new System.Threading.Thread(delegate()
            {
                proc = HookProc;
                hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
                hookThreadId = GetCurrentThreadId();
                enabled = hook != IntPtr.Zero;
                ready.Set();
                if (!enabled) return;
                Native.MSG msg;
                while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            });
            thread.IsBackground = true;
            thread.Start();
            ready.Wait(3000);
            if (hook == IntPtr.Zero)
            {
                enabled = false;
                Error = "SetWindowsHookEx keyboard failed, win32=" + Marshal.GetLastWin32Error();
                return false;
            }
            return true;
        }

        public static void Uninstall()
        {
            enabled = false;
            if (hookThreadId != 0)
            {
                try { PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch { }
            }
            if (hook != IntPtr.Zero)
            {
                try { UnhookWindowsHookEx(hook); } catch { }
                hook = IntPtr.Zero;
            }
            proc = null;
            hookThreadId = 0;
            lock (gate) { pending.Clear(); }
        }

        public static int Drain(int[] kinds, long[] epochs, string[] texts)
        {
            lock (gate)
            {
                int n = pending.Count;
                if (n > kinds.Length) n = kinds.Length;
                for (int i = 0; i < n; i++)
                {
                    kinds[i] = pending[i].Kind;
                    epochs[i] = pending[i].Epoch;
                    texts[i] = pending[i].Text ?? "";
                }
                if (n > 0) pending.RemoveRange(0, n);
                return n;
            }
        }

        static bool Down(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        static bool IsModifier(int vk)
        {
            return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C
                || (vk >= 0xA0 && vk <= 0xA5);
        }

        static string KeyName(int vk)
        {
            if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString();
            if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();
            if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x6F);
            if (vk == 0x0D) return "Enter";
            if (vk == 0x09) return "Tab";
            if (vk == 0x1B) return "Esc";
            if (vk == 0x20) return "Space";
            if (vk == 0x08) return "Backspace";
            if (vk == 0x2E) return "Delete";
            if (vk == 0x25) return "Left";
            if (vk == 0x26) return "Up";
            if (vk == 0x27) return "Right";
            if (vk == 0x28) return "Down";
            return "Key" + vk;
        }

        static void Push(int kind, string text)
        {
            Event item = new Event();
            item.Kind = kind;
            item.Epoch = (long)(DateTime.UtcNow - unixEpoch).TotalMilliseconds;
            item.Text = text ?? "";
            lock (gate)
            {
                if (pending.Count < 256) pending.Add(item);
            }
        }

        static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && enabled)
            {
                KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                int vkAll = (int)info.vkCode;
                if ((info.flags & LLKHF_UP) != 0)
                {
                    if (vkAll == lastDownVk) lastDownVk = -1;
                }
                else if (!IsModifier(vkAll) && vkAll == lastDownVk)
                {
                    // auto-repeat of a held key: already recorded once
                }
                else
                {
                    int vk = vkAll;
                    if (!IsModifier(vk)) lastDownVk = vk;
                    if (!IsModifier(vk))
                    {
                        bool ctrl = Down(0x11);
                        bool alt = Down(0x12) || (info.flags & 0x20) != 0;
                        bool shift = Down(0x10);
                        bool win = Down(0x5B) || Down(0x5C);
                        bool action = ctrl || alt || win || vk == 0x0D || vk == 0x09 || vk == 0x1B || (vk >= 0x70 && vk <= 0x87);
                        if (action)
                        {
                            string label = "";
                            if (ctrl) label += "Ctrl+";
                            if (alt) label += "Alt+";
                            if (shift) label += "Shift+";
                            if (win) label += "Win+";
                            Push(3, label + KeyName(vk));
                        }
                        else if (vk == 0x08)
                        {
                            Push(2, "");
                        }
                        else
                        {
                            string text = "";
                            try
                            {
                                byte[] state = new byte[256];
                                GetKeyboardState(state);
                                StringBuilder buffer = new StringBuilder(8);
                                int count = ToUnicode((uint)vk, info.scanCode, state, buffer, buffer.Capacity, 0);
                                if (count > 0) text = buffer.ToString();
                            }
                            catch { text = ""; }
                            if (text.Length > 0) Push(1, text);
                        }
                    }
                }
            }
            return CallNextHookEx(hook, nCode, wParam, lParam);
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $script:Cs -Language CSharp -ErrorAction Stop `
    -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll')
} catch {
  Emit-Error ('interop compile failed: ' + $_.Exception.Message) $true
  try { $script:Stdout.Flush() } catch { }
  exit 2
}

Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
$script:UiaOk = $false
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop; $script:UiaOk = $true } catch { $script:UiaOk = $false }
$script:CaretOk = $false
if ($script:UiaOk) {
  # Compiled separately so a missing TextPattern2 type does not take down the sensor.
  # Caret paragraph (not Document.Value) is what Electron actually exposes for the composer.
  $script:CaretCs = @'
using System;
using UIAutomationClient;

public static class SitCaret {
    const int PatternText2 = 10024;
    const int PatternText = 10014;
    const int PatternValue = 10002;
    const int TypeDocument = 50030;
    const int TypeEdit = 50004;
    const int TypePane = 50033;
    const int TypeWindow = 50032;
    const int TypeCustom = 50025;
    const int PropPassword = 30019;

    public static string Read(int overlayPid, out int x, out int y, out int w, out int h) {
        x = 0;
        y = 0;
        w = 0;
        h = 0;
        try {
            IUIAutomation uia;
            try { uia = new CUIAutomation8(); }
            catch { uia = new CUIAutomation(); }
            IUIAutomationElement el = uia.GetFocusedElement();
            if (el == null) return null;
            try {
                if (overlayPid > 0 && el.CurrentProcessId == overlayPid) return null;
            } catch { }
            if (IsPassword(el)) return null;
            int ctype = 0;
            try { ctype = el.CurrentControlType; } catch { ctype = 0; }
            bool skipValue = ctype == TypeDocument || ctype == TypePane || ctype == TypeWindow || ctype == TypeCustom;
            if (!skipValue) {
                string value = ValueOf(el);
                if (!string.IsNullOrWhiteSpace(value) && !IsUrl(value)) {
                    TryRect(el, ref x, ref y, ref w, ref h);
                    return value.Trim();
                }
            }
            string text = ReadBest(el, ref x, ref y, ref w, ref h);
            if (!string.IsNullOrWhiteSpace(text) && !IsUrl(text)) return text.Trim();
            string nested = ReadBounded(uia.ControlViewWalker, el, 0, 0, ref x, ref y, ref w, ref h);
            if (!string.IsNullOrWhiteSpace(nested) && !IsUrl(nested)) return nested.Trim();
            return null;
        } catch {
            return null;
        }
    }

    static bool IsPassword(IUIAutomationElement el) {
        try {
            object value = el.GetCurrentPropertyValue(PropPassword);
            if (value is bool) return (bool)value;
            if (value is int) return (int)value != 0;
            return false;
        } catch { return false; }
    }

    static string ReadBounded(IUIAutomationTreeWalker walker, IUIAutomationElement el, int depth, int seen, ref int x, ref int y, ref int w, ref int h) {
        if (walker == null || el == null || depth > 3 || seen > 8) return null;
        IUIAutomationElement child = null;
        try { child = walker.GetFirstChildElement(el); } catch { return null; }
        int kids = 0;
        while (child != null && kids < 3 && seen < 8) {
            kids++;
            seen++;
            int ct = 0;
            try { ct = child.CurrentControlType; } catch { ct = 0; }
            if (ct == TypeDocument || ct == TypeEdit || ct == TypePane || ct == TypeCustom) {
                string text = ReadBest(child, ref x, ref y, ref w, ref h);
                if (!string.IsNullOrWhiteSpace(text) && !IsUrl(text)) return text.Trim();
                string deeper = ReadBounded(walker, child, depth + 1, seen, ref x, ref y, ref w, ref h);
                if (!string.IsNullOrWhiteSpace(deeper) && !IsUrl(deeper)) return deeper.Trim();
            }
            try { child = walker.GetNextSiblingElement(child); }
            catch { break; }
        }
        return null;
    }

    static string ValueOf(IUIAutomationElement el) {
        try {
            IUIAutomationValuePattern val = el.GetCurrentPattern(PatternValue) as IUIAutomationValuePattern;
            if (val == null) return null;
            return val.CurrentValue;
        } catch { return null; }
    }

    static void TryRect(IUIAutomationElement el, ref int x, ref int y, ref int w, ref int h) {
        int a = x;
        int b = y;
        int c = w;
        int d = h;
        ReadBest(el, ref a, ref b, ref c, ref d);
        if (c > 0) { x = a; y = b; w = c; h = d; }
    }

    static string ReadBest(IUIAutomationElement el, ref int x, ref int y, ref int w, ref int h) {
        IUIAutomationTextRange range = null;
        try {
            IUIAutomationTextPattern2 pat2 = el.GetCurrentPattern(PatternText2) as IUIAutomationTextPattern2;
            if (pat2 != null) {
                bool active;
                range = pat2.GetCaretRange(out active);
            }
        } catch { range = null; }
        if (range == null) {
            try {
                IUIAutomationTextPattern pat = el.GetCurrentPattern(PatternText) as IUIAutomationTextPattern;
                if (pat != null) {
                    IUIAutomationTextRangeArray sel = pat.GetSelection();
                    if (sel != null && sel.Length > 0) range = sel.GetElement(0);
                }
            } catch { range = null; }
        }
        if (range == null) return null;
        double[] lineRects;
        double[] paraRects;
        string line = UnitText(range, TextUnit.TextUnit_Line, out lineRects);
        string para = UnitText(range, TextUnit.TextUnit_Paragraph, out paraRects);
        string chosen = para;
        double[] rects = paraRects;
        if (!string.IsNullOrWhiteSpace(line) && (string.IsNullOrWhiteSpace(para) || para.Trim().Length > 180)) {
            chosen = line;
            rects = lineRects;
        }
        if (rects == null || rects.Length < 4) rects = lineRects;
        ApplyRect(rects, ref x, ref y, ref w, ref h);
        if (string.IsNullOrWhiteSpace(chosen) || IsUrl(chosen)) return null;
        return chosen;
    }

    static string UnitText(IUIAutomationTextRange range, TextUnit unit, out double[] rects) {
        rects = null;
        try {
            IUIAutomationTextRange clone = range.Clone();
            clone.ExpandToEnclosingUnit(unit);
            try { rects = clone.GetBoundingRectangles(); } catch { rects = null; }
            return clone.GetText(800);
        } catch {
            return null;
        }
    }

    static void ApplyRect(double[] rects, ref int x, ref int y, ref int w, ref int h) {
        if (rects == null || rects.Length < 4) return;
        int i = rects.Length - 4;
        int rw = (int)Math.Ceiling(rects[i + 2]);
        int rh = (int)Math.Ceiling(rects[i + 3]);
        if (rw < 8 || rh < 8) return;
        x = (int)Math.Floor(rects[i]) - 4;
        y = (int)Math.Floor(rects[i + 1]) - 4;
        w = rw + 8;
        h = rh + 8;
        if (w > 900) w = 900;
        if (h > 180) h = 180;
    }

    static bool IsUrl(string value) {
        if (string.IsNullOrWhiteSpace(value)) return false;
        string t = value.Trim();
        return System.Text.RegularExpressions.Regex.IsMatch(t, "^[a-zA-Z][\\w+.-]*://\\S*$");
    }
}
'@
  try {
    Add-Type -TypeDefinition $script:CaretCs -ReferencedAssemblies @('UIAutomationClient.dll', 'UIAutomationTypes.dll') -ErrorAction Stop
    $script:CaretOk = $true
  } catch {
    $script:CaretOk = $false
    Write-Log ('caret reader unavailable: ' + $_.Exception.Message)
  }
}

$script:DpiMode = [Sit.Native]::SetDpi()

# Test hook: let the harness drive the hold-to-talk state machine with synthesized keys.
if ($env:SITUATION_HOLD_ACCEPT_INJECTED -eq '1') { [Sit.HoldKey]::AcceptInjected = $true }

# ---------------------------------------------------------------------------
# 2. Paths
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  Emit-Error '-OutDir is required' $true
  try { $script:Stdout.Flush() } catch { }
  exit 2
}
if (-not [System.IO.Path]::IsPathRooted($OutDir)) {
  $OutDir = [System.IO.Path]::Combine((Get-Location).ProviderPath, $OutDir)
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$script:FramesDir = [System.IO.Path]::Combine($OutDir, 'frames')
$script:ControlPath = [System.IO.Path]::Combine($OutDir, 'control.json')
$script:OcrTmpPath = [System.IO.Path]::Combine($OutDir, ('_ocr-' + $PID + '.png'))
try {
  [void][System.IO.Directory]::CreateDirectory($OutDir)
  [void][System.IO.Directory]::CreateDirectory($script:FramesDir)
} catch {
  Emit-Error ('cannot create OutDir: ' + $_.Exception.Message) $true
  try { $script:Stdout.Flush() } catch { }
  exit 2
}

if ($IntervalMs -lt 200) { $IntervalMs = 200 }
if ($FrameMaxWidth -lt 320) { $FrameMaxWidth = 320 }
$script:MaxFrames = 400
$script:HeartbeatMs = 20000
$script:IdleSampleMs = 30000
$script:PausedSampleMs = 10000
$script:ChangeBits = 6

# ---------------------------------------------------------------------------
# 3. State
# ---------------------------------------------------------------------------
$script:Paused = $false
$script:CaptureOn = $true
$script:OcrOn = ($Ocr -ne 0)
$script:ClipOn = ($Clipboard -ne 0)
$script:Stop = $false
$script:StopReason = ''
$script:ForceShot = $false
$script:LastShotRequest = ''
$script:LastControlCheck = -300
$script:ControlTicks = [int64]-1
$script:LastStatus = ''
$script:PrevFrameHash = $null
$script:LastOcrFrameHash = $null
$script:PrevKey = ''
$script:TutorId = ''
$script:TutorOverlayPid = 0
$script:TutorGap = $false
$script:TutorForeKey = ''
$script:TutorClickPending = $false
$script:LastClickFrameMs = 0
$script:TutorAffinity = @()
$script:TutorHookWarned = $false
$script:TutorKeyWarned = $false
$script:TutorFingerprint = ''
$script:KeySegment = $null
$script:ClickBtn = New-Object 'int[]' 64
$script:ClickX = New-Object 'int[]' 64
$script:ClickY = New-Object 'int[]' 64
$script:ClickEpoch = New-Object 'long[]' 64
$script:KeyKind = New-Object 'int[]' 64
$script:KeyEpoch = New-Object 'long[]' 64
$script:KeyText = New-Object 'string[]' 64
$script:LastFrameMs = 0
$script:LastRetention = 0
$script:LastClip = ''
$script:ClipDisabled = $false
$script:OcrFailLogged = 0
$script:ProcCache = @{}
$script:Sw = [System.Diagnostics.Stopwatch]::StartNew()

$ps = [Sit.Native]::PrimaryScreen()
$script:ScreenW = [int]$ps[0]
$script:ScreenH = [int]$ps[1]

# reusable GDI objects: capture canvas, fit canvas, hash canvas, ocr canvas
$script:Cap = New-Object Sit.Canvas
$script:Fit = New-Object Sit.Canvas
$script:HashCanvas = New-Object Sit.Canvas
$script:OcrCanvas = New-Object Sit.Canvas
$script:CaretCanvas = $null

# JPEG encoder + parameters (built once)
$script:JpegCodec = $null
$script:JpegParams = $null
try {
  $codecs = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()
  foreach ($c in $codecs) { if ($c.MimeType -eq 'image/jpeg') { $script:JpegCodec = $c; break } }
  if ($script:JpegCodec) {
    $script:JpegParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $script:JpegParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality, [int64]$JpegQuality)
    $script:JpegParamsSmall = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $script:JpegParamsSmall.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality, [int64]42)
  }
} catch { $script:JpegEncoderError = $_.Exception.Message }

# ---------------------------------------------------------------------------
# 4. OCR (WinRT, Await/AsTask pattern from _probe/ocr-test.ps1)
# ---------------------------------------------------------------------------
$script:OcrEngine = $null
$script:OcrLang = $null
$script:OcrInitAttempted = $false
$script:AsTaskGeneric = $null

function Initialize-Ocr {
  $script:OcrInitAttempted = $true
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
      })[0]
    if ($null -eq $script:AsTaskGeneric) { throw 'AsTask generic not found' }

    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  } catch {
    Write-Log ('winrt load failed: ' + $_.Exception.Message)
    return $false
  }

  $engine = $null
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
  if ($null -eq $engine) {
    try {
      [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
      $lang = New-Object Windows.Globalization.Language('zh-Hans-CN')
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    } catch { $engine = $null }
  }
  if ($null -eq $engine) {
    try {
      [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
      $lang2 = New-Object Windows.Globalization.Language('en-US')
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang2)
    } catch { $engine = $null }
  }
  if ($null -eq $engine) {
    Write-Log 'no OCR engine available'
    return $false
  }
  $script:OcrEngine = $engine
  try { $script:OcrLang = $engine.RecognizerLanguage.LanguageTag } catch { $script:OcrLang = 'unknown' }
  return $true
}

function Await-WinRt($WinRtTask, $ResultType) {
  $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  if ($netTask.IsFaulted) { throw $netTask.Exception.GetBaseException() }
  return $netTask.Result
}

function Invoke-OcrFile([string]$path) {
  $full = [System.IO.Path]::GetFullPath($path)
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = $null
  try {
    $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    return (Read-OcrStream $stream)
  } finally {
    if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
  }
}

function Read-OcrStream($stream) {
  $bitmap = $null
  try {
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-WinRt ($script:OcrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    # OcrResult.Text collapses lines on this engine build; keep the line structure
    # so Clean-OcrText can turn line breaks into the contract's '; ' separators.
    $parts = New-Object System.Collections.Generic.List[string]
    try {
      foreach ($ln in $result.Lines) {
        $lt = $ln.Text
        if (-not [string]::IsNullOrWhiteSpace($lt)) { [void]$parts.Add($lt) }
      }
    } catch { }
    if ($parts.Count -gt 0) { return ($parts -join "`n") }
    return $result.Text
  } finally {
    if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch { } }
  }
}

$script:CjkClass = '[\p{IsCJKUnifiedIdeographs}\p{IsCJKCompatibilityIdeographs}\u3000-\u303F\uFF00-\uFFEF]'
$script:ReCjkGap = $null
$script:Sha1 = $null
try { $script:Sha1 = [System.Security.Cryptography.SHA1]::Create() } catch { }

function Clean-OcrText([string]$raw) {
  if ([string]::IsNullOrEmpty($raw)) { return '' }
  $s = $raw -replace "`r`n", "`n"
  $s = $s -replace "`r", "`n"
  $lines = $s -split "`n"
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l.Length -eq 0) { continue }
    # strip whitespace that sits between CJK characters / fullwidth punctuation
    $l = [regex]::Replace($l, '(?<=' + $script:CjkClass + ')[ \t\u00A0]+(?=' + $script:CjkClass + ')', '')
    [void]$out.Add($l)
  }
  $joined = ($out -join '; ')
  $joined = [regex]::Replace($joined, ' {2,}', ' ')
  $joined = $joined.Trim()
  $joined = $joined.TrimEnd(';', ' ')
  if ($joined.Length -gt 1800) { $joined = $joined.Substring(0, 1800) }
  return $joined
}

function Get-TextHash([string]$text) {
  if ($null -eq $script:Sha1) { return '' }
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $h = $script:Sha1.ComputeHash($bytes)
    return -join ($h | ForEach-Object { $_.ToString('x2') })
  } catch { return '' }
}

# ---------------------------------------------------------------------------
# 5. Process name cache
# ---------------------------------------------------------------------------
function Resolve-ProcessName([int]$wpid) {
  if ($wpid -le 0) { return '' }
  if ($script:ProcCache.ContainsKey($wpid)) { return $script:ProcCache[$wpid] }
  $n = ''
  try { $n = [System.Diagnostics.Process]::GetProcessById($wpid).ProcessName } catch { $n = '' }
  if ($script:ProcCache.Count -gt 256) { $script:ProcCache.Clear() }
  $script:ProcCache[$wpid] = $n
  return $n
}

# ---------------------------------------------------------------------------
# 6. Hotkey
# ---------------------------------------------------------------------------
$script:HotkeySpec = ''
$script:HotkeyOk = $false
$script:HotkeyHwnd = [int64]0
$script:HotkeyWin = $null
$script:HotkeyVk = 0
$script:HotkeyMods = 0
$script:HotkeyError = ''
$script:HotkeyHold = $false
$script:HoldThresholdMs = 800

$script:KeyMap = @{
  'space' = 0x20; 'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
  'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D; 'ins' = 0x2D
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pgup' = 0x21; 'pagedown' = 0x22; 'pgdn' = 0x22
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'minus' = 0xBD; 'plus' = 0xBB; 'comma' = 0xBC; 'period' = 0xBE; 'slash' = 0xBF
  'semicolon' = 0xBA; 'quote' = 0xDE; 'backtick' = 0xC0; 'tilde' = 0xC0
  'lbracket' = 0xDB; 'rbracket' = 0xDD; 'backslash' = 0xDC
}

function ConvertFrom-HotkeySpec([string]$spec) {
  $res = @{ Ok = $false; Mods = 0; Vk = 0; Text = ''; Error = ''; Hold = $false; LeaderVk = 0 }
  if ([string]::IsNullOrWhiteSpace($spec)) { $res.Error = 'empty'; return $res }
  $parts = @($spec -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_.Trim() -ne '' })
  if ($parts.Count -lt 1) { $res.Error = 'empty'; return $res }

  # "B+Space": hold the leader, press the trigger. Neither key alone is consumed, so
  # the chord is the dictation and the letters still type normally on their own.
  if (($parts.Count -eq 2) -and ($parts[1].ToLowerInvariant() -eq 'space')) {
    $leadLow = $parts[0].ToLowerInvariant()
    $leadVk = 0
    if ($leadLow.Length -eq 1) {
      $leadCode = [int][char]$leadLow[0]
      if (($leadCode -ge 97) -and ($leadCode -le 122)) { $leadVk = $leadCode - 32 }
      elseif (($leadCode -ge 48) -and ($leadCode -le 57)) { $leadVk = $leadCode }
    } elseif ($script:KeyMap.ContainsKey($leadLow)) {
      $leadVk = [int]$script:KeyMap[$leadLow]
    }
    if ($leadVk -ne 0) {
      $res.Ok = $true
      $res.Mods = 0
      $res.Vk = 0x20
      $res.LeaderVk = $leadVk
      $res.Text = ($leadLow.ToUpperInvariant() + '+Space')
      $res.Hold = $true
      return $res
    }
  }

  $mods = 0
  $vk = 0
  $keyLabel = ''
  $hasKey = $false
  $labels = New-Object System.Collections.Generic.List[string]
  foreach ($p in $parts) {
    $low = $p.ToLowerInvariant()
    if ($low -eq 'ctrl' -or $low -eq 'control') {
      $mods = $mods -bor 2
      if (-not $labels.Contains('Ctrl')) { [void]$labels.Add('Ctrl') }
      continue
    }
    if ($low -eq 'alt') {
      $mods = $mods -bor 1
      if (-not $labels.Contains('Alt')) { [void]$labels.Add('Alt') }
      continue
    }
    if ($low -eq 'shift') {
      $mods = $mods -bor 4
      if (-not $labels.Contains('Shift')) { [void]$labels.Add('Shift') }
      continue
    }
    if ($low -eq 'win' -or $low -eq 'windows' -or $low -eq 'super' -or $low -eq 'meta') {
      $mods = $mods -bor 8
      if (-not $labels.Contains('Win')) { [void]$labels.Add('Win') }
      continue
    }
    if ($hasKey) { $res.Error = "multiple keys: $spec"; return $res }
    if ($low.Length -eq 1) {
      $ch = $low[0]
      $code = [int][char]$ch
      if (($code -ge 97) -and ($code -le 122)) { $vk = $code - 32; $keyLabel = $low.ToUpperInvariant() }
      elseif (($code -ge 48) -and ($code -le 57)) { $vk = $code; $keyLabel = $low }
      else { $res.Error = "unsupported key: $p"; return $res }
      $hasKey = $true
      continue
    }
    if ($low -match '^f([1-9]|1[0-9]|2[0-4])$') {
      $n = [int]$low.Substring(1)
      $vk = 0x70 + ($n - 1)
      $keyLabel = 'F' + $n
      $hasKey = $true
      continue
    }
    if ($script:KeyMap.ContainsKey($low)) {
      $vk = [int]$script:KeyMap[$low]
      $keyLabel = (Get-Culture).TextInfo.ToTitleCase($low)
      $hasKey = $true
      continue
    }
    $res.Error = "unknown key: $p"
    return $res
  }
  if (-not $hasKey) { $res.Error = 'no key'; return $res }
  if ($mods -eq 0) {
    # A bare key is only usable when it cannot swallow typing: F1-F24, Pause,
    # CapsLock, ScrollLock register as plain hotkeys. Space is the special case -
    # a global space hotkey would eat every space, so it becomes hold-to-talk
    # (tap still types a space, holding 800ms starts and releasing stops voice).
    if ($vk -eq 0x20) {
      $res.Ok = $true
      $res.Mods = 0
      $res.Vk = 0x20
      $res.Text = 'Space'
      $res.Hold = $true
      return $res
    }
    $bareOk = (($vk -ge 0x70) -and ($vk -le 0x87)) -or ($vk -eq 0x13) -or ($vk -eq 0x14) -or ($vk -eq 0x91)
    if ($bareOk) {
      $res.Ok = $true
      $res.Mods = 0
      $res.Vk = $vk
      $res.Text = $keyLabel
      return $res
    }
    $res.Error = ('no modifier: ' + $keyLabel + ' would be swallowed in every app; use Ctrl+' + $keyLabel + ', or Space for hold-to-talk')
    return $res
  }
  [void]$labels.Add($keyLabel)
  $res.Ok = $true
  $res.Mods = $mods
  $res.Vk = $vk
  $res.Text = ($labels -join '+')
  return $res
}

function Initialize-Hotkey([string]$spec) {
  if ([string]::IsNullOrWhiteSpace($spec)) {
    $script:HotkeyError = 'disabled'
    return
  }
  $hk = ConvertFrom-HotkeySpec $spec
  if (-not $hk.Ok) {
    $script:HotkeyError = 'invalid: ' + $hk.Error + ' (' + $spec + ')'
    return
  }
  $script:HotkeySpec = $hk.Text
  $script:HotkeyMods = $hk.Mods
  $script:HotkeyVk = $hk.Vk

  if ($hk.Hold) {
    # Chord / hold-to-talk: no RegisterHotKey (that would swallow the keys everywhere).
    try {
      $script:HoldThresholdMs = 800
      $script:HoldArmMs = 200
      if ([Sit.HoldKey]::Install([int]$hk.Vk, [int]$hk.LeaderVk, [int]$script:HoldArmMs, [int]$script:HoldThresholdMs)) {
        $script:HotkeyOk = $true
        $script:HotkeyError = ''
        $script:HotkeyHold = $true
      } else {
        $script:HotkeyError = 'hold hook: ' + [Sit.HoldKey]::Error
      }
    } catch {
      $script:HotkeyError = 'hold hook: ' + $_.Exception.Message
    }
    return
  }

  $modsNoRepeat = $hk.Mods -bor 0x4000

  # Window first (message-only preferred), registration second. The window is kept
  # even when the combo is already owned by another process, so the host can still
  # drive the WM_HOTKEY path with PostMessage for tests (hotkeyOk stays false).
  foreach ($msgOnly in @($true, $false)) {
    if ($null -ne $script:HotkeyWin) { break }
    try {
      $win = New-Object Sit.HotkeyWindow($msgOnly)
      $h = [int64]$win.Handle.ToInt64()
      if ($h -ne 0) {
        $script:HotkeyWin = $win
        $script:HotkeyHwnd = $h
      } else {
        try { $win.Dispose() } catch { }
      }
    } catch {
      $script:HotkeyError = 'window: ' + $_.Exception.Message
    }
  }
  if ($null -eq $script:HotkeyWin) {
    if (-not $script:HotkeyError) { $script:HotkeyError = 'hotkey window creation failed' }
    return
  }
  try {
    $ok = [Sit.Native]::Register($script:HotkeyHwnd, 1, [uint32]$modsNoRepeat, [uint32]$hk.Vk)
    if ($ok) {
      $script:HotkeyOk = $true
      $script:HotkeyError = ''
    } else {
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($err -eq 1409) {
        $script:HotkeyError = 'already registered by another process (1409): ' + $hk.Text
      } else {
        $script:HotkeyError = ('RegisterHotKey failed, win32=' + $err)
      }
    }
  } catch {
    $script:HotkeyError = 'RegisterHotKey: ' + $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# 7. Clipboard
# ---------------------------------------------------------------------------
function Test-ClipboardUsable {
  if ($script:ClipDisabled) { return $false }
  try {
    $st = [System.Threading.Thread]::CurrentThread.GetApartmentState()
    if ($st -ne [System.Threading.ApartmentState]::STA) {
      $script:ClipDisabled = $true
      Emit-Error 'clipboard needs STA; sensor started MTA - clipboard disabled' $false
      return $false
    }
  } catch { }
  return $true
}

function Read-ClipboardText {
  if (-not (Test-ClipboardUsable)) { return $null }
  try {
    if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { return $null }
    $t = [System.Windows.Forms.Clipboard]::GetText()
    if ([string]::IsNullOrEmpty($t)) { return $null }
    $t = $t -replace "`r`n", ' '
    $t = $t -replace "[`r`n`t]", ' '
    $t = $t.Trim()
    if ($t.Length -gt 1200) { $t = $t.Substring(0, 1200) }
    return $t
  } catch {
    return $null
  }
}

# ---------------------------------------------------------------------------
# 8. Frames, retention
# ---------------------------------------------------------------------------
function Invoke-Retention([bool]$Force) {
  $nowMs = $script:Sw.ElapsedMilliseconds
  if (-not $Force -and ($nowMs - $script:LastRetention) -lt 15000) { return }
  $script:LastRetention = $nowMs
  try {
    $files = [System.IO.Directory]::GetFiles($script:FramesDir, '*.jpg')
    if ($files.Length -eq 0) { return }
    $cut = [datetime]::Now.AddMinutes(-1 * $FrameRetentionMinutes)
    $kept = New-Object System.Collections.Generic.List[object]
    foreach ($f in $files) {
      try {
        $fi = New-Object System.IO.FileInfo($f)
        if ($FrameRetentionMinutes -gt 0 -and $fi.LastWriteTime -lt $cut) {
          [System.IO.File]::Delete($f)
        } else {
          [void]$kept.Add($fi)
        }
      } catch { }
    }
    if ($kept.Count -gt $script:MaxFrames) {
      $sorted = $kept | Sort-Object LastWriteTime
      $drop = $kept.Count - $script:MaxFrames
      for ($i = 0; $i -lt $drop; $i++) {
        try { [System.IO.File]::Delete($sorted[$i].FullName) } catch { }
      }
    }
  } catch {
    Write-Log ('retention failed: ' + $_.Exception.Message)
  }
}

# ---------------------------------------------------------------------------
# 9. Control file
# ---------------------------------------------------------------------------
function Emit-Status {
  $key = ('{0}|{1}|{2}|{3}|{4}' -f $script:Paused, $script:CaptureOn, $script:OcrOn, $script:ClipOn, $script:OcrLang)
  if ($key -eq $script:LastStatus) { return }
  $script:LastStatus = $key
  Emit-Json ([ordered]@{
      type = 'status'; ts = (IsoNow); epoch = (EpochMs)
      paused = [bool]$script:Paused; capture = [bool]$script:CaptureOn
      ocr = [bool]$script:OcrOn; clipboard = [bool]$script:ClipOn
      ocrLanguage = $script:OcrLang
    })
}

function Read-Control {
  $nowMs = $script:Sw.ElapsedMilliseconds
  # While tutoring, notice "stop watching" on the next loop instead of waiting out the 300ms poll.
  $controlWait = $(if ($script:TutorId -ne '') { 0 } else { 300 })
  if (($nowMs - $script:LastControlCheck) -lt $controlWait) { return }
  $script:LastControlCheck = $nowMs
  if (-not [System.IO.File]::Exists($script:ControlPath)) { return }
  $ticks = [int64]0
  try { $ticks = [System.IO.File]::GetLastWriteTimeUtc($script:ControlPath).Ticks } catch { return }
  if ($ticks -eq $script:ControlTicks) { return }
  $text = $null
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  for ($i = 0; $i -lt 3; $i++) {
    $stream = $null
    $reader = $null
    try {
      $stream = [System.IO.File]::Open($script:ControlPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
      $reader = New-Object System.IO.StreamReader($stream, $script:Utf8)
      $text = $reader.ReadToEnd()
      break
    }
    catch { Start-Sleep -Milliseconds 25 }
    finally {
      if ($null -ne $reader) { $reader.Dispose() }
      if ($null -ne $stream) { $stream.Dispose() }
    }
  }
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  $c = $null
  try { $c = ConvertFrom-Json -InputObject $text } catch {
    Write-Log ('control.json parse failed: ' + $_.Exception.Message)
    return
  }
  try {
    $wasPaused = $script:Paused
    $wasCapturing = $script:CaptureOn
    $wasReading = $script:OcrOn
    if ($null -ne $c.paused) { $script:Paused = [bool]$c.paused }
    if ($null -ne $c.capture) { $script:CaptureOn = [bool]$c.capture }
    if ($null -ne $c.ocr) { $script:OcrOn = [bool]$c.ocr }
    if ($null -ne $c.clipboard) { $script:ClipOn = [bool]$c.clipboard }
    $newTutorId = [string]$c.tutorId
    if ($newTutorId -ne $script:TutorId) {
      $previousTutor = $script:TutorId
      $script:TutorId = $newTutorId
      $script:TutorOverlayPid = [int]$c.tutorOverlayPid
      $script:TutorGap = $false
      $script:PrevKey = ''
      $script:PrevFrameHash = $null
      $script:LastOcrFrameHash = $null
      $script:TutorForeKey = ''
      $script:TutorClickPending = $false
      $script:LastClickFrameMs = 0
      $script:LastFrameMs = 0
      $script:TutorFingerprint = ''
      $script:KeySegment = $null
      if ($newTutorId -eq '') {
        if ($previousTutor -ne '') { Stop-TutorWatch }
      } else {
        Start-TutorWatch
      }
    }
    if ($wasPaused -ne $script:Paused -or $wasCapturing -ne $script:CaptureOn -or $wasReading -ne $script:OcrOn) {
      $script:PrevFrameHash = $null
      $script:LastOcrFrameHash = $null
    }
    if (-not $wasReading -and $script:OcrOn) { $script:OcrInitAttempted = $false }
    if ($null -ne $c.shotRequest) {
      $sr = [string]$c.shotRequest
      if ($sr -eq '' -or $script:Paused -or -not $script:CaptureOn) {
        $script:ForceShot = $false
      } elseif ($sr -ne $script:LastShotRequest) {
        $script:LastShotRequest = $sr
        $script:ForceShot = $true
      }
    }
    if ($null -ne $c.stop) {
      if ([bool]$c.stop) {
        $script:Stop = $true
        $script:StopReason = 'control-stop'
      }
    }
  } catch {
    Write-Log ('control apply failed: ' + $_.Exception.Message)
    return
  }
  $script:ControlTicks = $ticks
  Emit-Status
}

# ---------------------------------------------------------------------------
# 10. OCR for a written frame
# ---------------------------------------------------------------------------
function Invoke-OcrForFrame([string]$frameFull, [int]$fw, [int]$fh) {
  if ($null -eq $script:OcrEngine) {
    if ($script:OcrInitAttempted -or -not (Initialize-Ocr)) { return $null }
    Emit-Status
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $src = $frameFull
  # CONTRACT 1.4x below 1100 px; $OcrScale is a measured quality floor for the
  # zh-Hans engine, which misreads UI text at native scale on this machine.
  $scale = 1.0
  if ($fw -lt 1100) { $scale = 1.4 }
  if ($OcrScale -gt $scale) { $scale = $OcrScale }
  $maxOcrWidth = 2600.0
  if (($fw -gt 0) -and (($fw * $scale) -gt $maxOcrWidth)) { $scale = $maxOcrWidth / $fw }
  if ($scale -gt 1.02) {
    try {
      $tw = [int][math]::Ceiling($fw * $scale)
      $th = [int][math]::Ceiling($fh * $scale)
      [Sit.Native]::ScaleInto($script:Fit, $script:OcrCanvas, $tw, $th)
      $script:OcrCanvas.Bmp.Save($script:OcrTmpPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $src = $script:OcrTmpPath
    } catch {
      Write-Log ('ocr upscale failed: ' + $_.Exception.Message)
      $src = $frameFull
    }
  }
  $raw = $null
  try {
    $raw = Invoke-OcrFile $src
  } catch {
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if (($stamp - $script:OcrFailLogged) -gt 60) {
      $script:OcrFailLogged = $stamp
      Emit-Error ('ocr failed: ' + $_.Exception.Message) $false
    }
    return $null
  } finally {
    try { [System.IO.File]::Delete($script:OcrTmpPath) } catch { }
  }
  $sw.Stop()
  $clean = Clean-OcrText $raw
  $hash = Get-TextHash $clean
  $script:OcrCount++
  return [ordered]@{ lang = $script:OcrLang; ms = [int]$sw.ElapsedMilliseconds; text = $clean; hash = $hash }
}

function Invoke-TutorOcr([int]$fw, [int]$fh) {
  if ($null -eq $script:OcrEngine) {
    if ($script:OcrInitAttempted -or -not (Initialize-Ocr)) { return $null }
    Emit-Status
  }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $memory = New-Object System.IO.MemoryStream
  $random = $null
  try {
    $scale = [math]::Min(2600.0 / $fw, [math]::Max(1.4, $OcrScale))
    $width = [int][math]::Round($fw * $scale)
    $height = [int][math]::Round($fh * $scale)
    [Sit.Native]::ScaleInto($script:Fit, $script:OcrCanvas, $width, $height)
    $script:OcrCanvas.Bmp.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $memory.Position = 0
    $random = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
    $clean = Clean-OcrText (Read-OcrStream $random)
    return [ordered]@{ lang = $script:OcrLang; ms = [int]$watch.ElapsedMilliseconds; text = $clean; hash = (Get-TextHash $clean) }
  } catch {
    return $null
  } finally {
    if ($null -ne $random) { $random.Dispose() }
    $memory.Dispose()
  }
}

# ---------------------------------------------------------------------------
# 11. Desktop tutor: whole virtual screen, window switches, mouse clicks
# ---------------------------------------------------------------------------
function Format-Epoch([int64]$epoch) {
  return [DateTimeOffset]::FromUnixTimeMilliseconds($epoch).ToLocalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
}

function Get-WindowIdentity([int64]$hwnd) {
  $wpid = 0
  $title = ''
  if ($hwnd -ne 0) {
    $wpid = [Sit.Native]::Pid($hwnd)
    try { $title = [Sit.Native]::Title($hwnd) } catch { $title = '' }
  }
  $proc = Resolve-ProcessName $wpid
  $exe = ''
  $app = ''
  if ($proc) {
    $exe = $proc
    if (-not $exe.EndsWith('.exe')) { $exe = $exe + '.exe' }
    $app = [System.IO.Path]::GetFileNameWithoutExtension($exe)
  }
  return @{ hwnd = [int64]$hwnd; pid = [int]$wpid; title = $title; process = $exe; app = $app }
}

function Protect-TutorWindows {
  if ($script:TutorOverlayPid -le 0) { return }
  $hwnds = @([Sit.Native]::HwndsForPid([int]$script:TutorOverlayPid))
  foreach ($h in $hwnds) {
    if ($h) { [void][Sit.Native]::ExcludeFromCapture([int64]$h) }
  }
  $script:TutorAffinity = $hwnds
}

function Start-TutorWatch {
  $clickOk = $false
  $keyOk = $false
  try { $clickOk = [Sit.ClickWatch]::Install() } catch {
    $clickOk = $false
    [Sit.ClickWatch]::Error = $_.Exception.Message
  }
  try { $keyOk = [Sit.KeyWatch]::Install() } catch {
    $keyOk = $false
    [Sit.KeyWatch]::Error = $_.Exception.Message
  }
  if (-not $clickOk -and -not $script:TutorHookWarned) {
    $script:TutorHookWarned = $true
    Emit-Error ('click hook: ' + [Sit.ClickWatch]::Error) $false
  }
  if (-not $keyOk -and -not $script:TutorKeyWarned) {
    $script:TutorKeyWarned = $true
    Emit-Error ('key hook: ' + [Sit.KeyWatch]::Error) $false
  }
  Protect-TutorWindows
  Emit-Json ([ordered]@{
      type = 'tutor-watch'; ts = (IsoNow); epoch = (EpochMs)
      active = $true; clickHook = [bool]$clickOk; keyHook = [bool]$keyOk
    })
}

function Stop-TutorWatch {
  try { [Sit.ClickWatch]::Uninstall() } catch { }
  try { [Sit.KeyWatch]::Uninstall() } catch { }
  $script:KeySegment = $null
  foreach ($h in @($script:TutorAffinity)) {
    if ($h) { try { [Sit.Native]::ReleaseCapture([int64]$h) } catch { } }
  }
  $script:TutorAffinity = @()
  Emit-Json ([ordered]@{
      type = 'tutor-watch'; ts = (IsoNow); epoch = (EpochMs)
      active = $false; clickHook = $false; keyHook = $false
    })
}

function ConvertTo-TutorJpeg {
  $memory = New-Object System.IO.MemoryStream
  try {
    if ($null -eq $script:JpegCodec) { return $null }
    $script:Fit.Bmp.Save($memory, $script:JpegCodec, $script:JpegParams)
    if ($memory.Length -gt 2500000 -and $null -ne $script:JpegParamsSmall) {
      $memory.Dispose()
      $memory = New-Object System.IO.MemoryStream
      $script:Fit.Bmp.Save($memory, $script:JpegCodec, $script:JpegParamsSmall)
    }
    if ($memory.Length -gt 0 -and $memory.Length -le 2500000) {
      return [Convert]::ToBase64String($memory.ToArray())
    }
  } catch {
    Write-Log ('tutor jpeg failed: ' + $_.Exception.Message)
  } finally {
    if ($null -ne $memory) { $memory.Dispose() }
  }
  return $null
}

function Emit-TutorWindow($id) {
  Emit-Json ([ordered]@{
      type = 'window'; ts = (IsoNow); epoch = (EpochMs); tutorId = $script:TutorId
      app = [string]$id.app; process = [string]$id.process; pid = [int]$id.pid
      hwnd = [int64]$id.hwnd; title = [string]$id.title
    })
}

function Emit-TutorClick([int]$button, [int]$x, [int]$y, [int64]$epoch, $id) {
  $name = 'left'
  if ($button -eq 2) { $name = 'right' }
  elseif ($button -eq 3) { $name = 'middle' }
  elseif ($button -eq 4) { $name = 'wheel-up' }
  elseif ($button -eq 5) { $name = 'wheel-down' }
  Emit-Json ([ordered]@{
      type = 'click'; ts = (Format-Epoch $epoch); epoch = $epoch; tutorId = $script:TutorId
      button = $name; x = $x; y = $y
      app = [string]$id.app; process = [string]$id.process; pid = [int]$id.pid
      hwnd = [int64]$id.hwnd; title = [string]$id.title
    })
}

function Invoke-TutorFrame($id) {
  Protect-TutorWindows
  $vs = [Sit.Native]::VirtualScreen()
  $x = [int]$vs[0]; $y = [int]$vs[1]; $w = [int]$vs[2]; $h = [int]$vs[3]
  if ($w -lt 64 -or $h -lt 64) {
    $x = 0; $y = 0; $w = [int]$script:ScreenW; $h = [int]$script:ScreenH
  }
  $script:Cap.Ensure($w, $h)
  $ok = [Sit.Native]::BitBltRect($x, $y, $w, $h, $script:Cap)
  $jpeg = $null
  $ocrOut = $null
  $fw = 0; $fh = 0
  if ($ok) {
    $long = [Math]::Max($w, $h)
    $limit = [int]$TutorFrameMaxEdge
    if ($limit -lt 960) { $limit = 1920 }
    if ($long -gt $limit) {
      $scale = $limit / [double]$long
      $fw = [int][Math]::Max(16, [Math]::Round($w * $scale))
      $fh = [int][Math]::Max(16, [Math]::Round($h * $scale))
    } else {
      $fw = $w; $fh = $h
    }
    [Sit.Native]::ScaleInto($script:Cap, $script:Fit, $fw, $fh)
    $script:LastFrameMs = $script:Sw.ElapsedMilliseconds
    $fingerprint = [Sit.Native]::Fingerprint($script:Fit)
    if ($fingerprint -ne '' -and $fingerprint -eq $script:TutorFingerprint) {
      Emit-Json ([ordered]@{
          type = 'sample'; ts = (IsoNow); epoch = (EpochMs); tutorId = $script:TutorId
          fullscreen = $true; changed = $false; duplicate = $true
          app = [string]$id.app; process = [string]$id.process; pid = [int]$id.pid
          hwnd = [int64]$id.hwnd; title = [string]$id.title
          clipboard = $null
        })
      return
    }
    $script:TutorFingerprint = $fingerprint
    $jpeg = ConvertTo-TutorJpeg
    if ($script:OcrOn -and $fw -gt 0) { $ocrOut = Invoke-TutorOcr $fw $fh }
  }
  $sample = [ordered]@{
    type = 'sample'; ts = (IsoNow); epoch = (EpochMs); tutorId = $script:TutorId
    fullscreen = $true; changed = $true
    app = [string]$id.app; process = [string]$id.process; pid = [int]$id.pid
    hwnd = [int64]$id.hwnd; title = [string]$id.title
    idleMs = [int][Sit.Native]::IdleMs()
    bounds = @($x, $y, $w, $h)
    score = [double]0
    clipboard = $null
  }
  if ($null -ne $jpeg) { $sample['jpeg'] = $jpeg }
  if ($null -ne $ocrOut) { $sample['ocr'] = $ocrOut }
  if (-not $ok) {
    $script:LastFrameMs = $script:Sw.ElapsedMilliseconds
    $sample['captureUnavailable'] = $true
  }
  Emit-Json $sample
}

# The low-level hook only sees raw keys (pinyin under a Chinese IME). Prefer the caret
# paragraph from TextPattern2. Electron often focuses a Document whose ValuePattern is the
# page URL (dsh-app://app/); never accept a URL. If UIA still echoes the pinyin, OCR the
# caret line plus the band under it (IME candidate window) and keep a CJK snapshot.
function Test-UrlText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  return [regex]::IsMatch($value.Trim(), '^[a-zA-Z][\w+.-]*://\S*$')
}

function Test-CjkText([string]$value) {
  if ([string]::IsNullOrEmpty($value)) { return $false }
  return [regex]::IsMatch($value, '[\u3400-\u9FFF]')
}

function Read-ManagedFocusText {
  if (-not $script:UiaOk) { return $null }
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) { return $null }
    $cur = $el.Current
    if ($cur.IsPassword) { return $null }
    if ($script:TutorOverlayPid -gt 0 -and $cur.ProcessId -eq $script:TutorOverlayPid) { return $null }
    $isDoc = $cur.ControlType -eq [System.Windows.Automation.ControlType]::Document
    $isPane = $cur.ControlType -eq [System.Windows.Automation.ControlType]::Pane
    $p = $null
    if (-not $isDoc -and -not $isPane -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
      $v = [string]$p.Current.Value
      if ($v.Length -gt 0 -and -not (Test-UrlText $v)) { return $v }
    }
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) {
      $sel = $null
      try { $sel = $p.GetSelection() } catch { $sel = $null }
      if ($sel -and $sel.Length -gt 0) {
        $para = $sel[0].Clone()
        $para.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Paragraph)
        $pt = ([string]$para.GetText(800)).Trim()
        $line = $sel[0].Clone()
        $line.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Line)
        $lt = ([string]$line.GetText(800)).Trim()
        $chosen = $pt
        if ($lt.Length -gt 0 -and ($pt.Length -eq 0 -or $pt.Length -gt 180)) { $chosen = $lt }
        if ($chosen.Length -gt 0 -and -not (Test-UrlText $chosen)) { return $chosen }
      }
      if (-not $isDoc -and -not $isPane) {
        $doc = ([string]$p.DocumentRange.GetText(4000)).Trim()
        if ($doc.Length -gt 0 -and -not (Test-UrlText $doc)) { return $doc }
      }
    }
  } catch { }
  return $null
}

function Read-FocusedPack {
  $pack = @{ Text = ''; X = 0; Y = 0; W = 0; H = 0 }
  if ($script:CaretOk) {
    try {
      $x = 0; $y = 0; $w = 0; $h = 0
      $text = [SitCaret]::Read([int]$script:TutorOverlayPid, [ref]$x, [ref]$y, [ref]$w, [ref]$h)
      $pack.X = [int]$x
      $pack.Y = [int]$y
      $pack.W = [int]$w
      $pack.H = [int]$h
      if (-not [string]::IsNullOrWhiteSpace([string]$text) -and -not (Test-UrlText $text)) {
        $pack.Text = [string]$text
        return $pack
      }
    } catch { }
  }
  $legacy = Read-ManagedFocusText
  if (-not [string]::IsNullOrWhiteSpace([string]$legacy) -and -not (Test-UrlText $legacy)) {
    $pack.Text = [string]$legacy
  }
  return $pack
}

function Read-CaretOcr([int]$x, [int]$y, [int]$w, [int]$h) {
  if ($w -lt 8 -or $h -lt 8 -or -not $script:OcrOn) { return $null }
  if ($null -eq $script:OcrEngine) {
    if ($script:OcrInitAttempted -or -not (Initialize-Ocr)) { return $null }
  }
  if ($null -eq $script:OcrEngine) { return $null }
  $band = $h + 64
  if ($band -gt 220) { $band = 220 }
  if ($w -gt 900) { $w = 900 }
  if ($null -eq $script:CaretCanvas) { $script:CaretCanvas = New-Object Sit.Canvas }
  $script:CaretCanvas.Ensure($w, $band)
  $ok = $false
  try { $ok = [Sit.Native]::BitBltRect($x, $y, $w, $band, $script:CaretCanvas) } catch { $ok = $false }
  if (-not $ok) { return $null }
  $scale = 2.0
  if (($w * $scale) -gt 1200) { $scale = 1200.0 / [double]$w }
  $tw = [int][Math]::Max(16, [Math]::Round($w * $scale))
  $th = [int][Math]::Max(16, [Math]::Round($band * $scale))
  $memory = New-Object System.IO.MemoryStream
  $random = $null
  try {
    [Sit.Native]::ScaleInto($script:CaretCanvas, $script:OcrCanvas, $tw, $th)
    $script:OcrCanvas.Bmp.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $memory.Position = 0
    $random = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
    return (Clean-OcrText (Read-OcrStream $random))
  } catch {
    return $null
  } finally {
    if ($null -ne $random) { try { $random.Dispose() } catch { } }
    try { $memory.Dispose() } catch { }
  }
}

function Remember-Field([string]$candidate) {
  if (-not $script:KeySegment) { return }
  if ([string]::IsNullOrWhiteSpace($candidate)) { return }
  $t = ($candidate -replace '\s+', ' ').Trim()
  if ($t.Length -eq 0 -or (Test-UrlText $t)) { return }
  if ($t.Length -gt 300) { $t = '...' + $t.Substring($t.Length - 300) }
  $prev = [string]$script:KeySegment.Field
  if ((Test-CjkText $prev) -and -not (Test-CjkText $t)) { return }
  $script:KeySegment.Field = $t
}

function Update-SegmentField {
  if (-not $script:KeySegment) { return }
  $script:KeySegment.SnapAt = [int64]$script:Sw.ElapsedMilliseconds
  try {
    $read = Read-FocusedPack
    if ($null -ne $read -and -not [string]::IsNullOrWhiteSpace([string]$read.Text)) {
      Remember-Field ([string]$read.Text)
    }
    $field = [string]$script:KeySegment.Field
    $raw = ([string]$script:KeySegment.Text).Trim()
    $pinyin = ($raw.Length -ge 2) -and [regex]::IsMatch($raw, '^[A-Za-z ]+$')
    $needOcr = -not (Test-CjkText $field) -and (($field -eq '') -or ($pinyin -and $field -eq $raw))
    $tries = 0
    try { $tries = [int]$script:KeySegment.OcrTries } catch { $tries = 0 }
    $ocrAt = [int64]0
    try { $ocrAt = [int64]$script:KeySegment.OcrAt } catch { $ocrAt = 0 }
    $now = [int64]$script:Sw.ElapsedMilliseconds
    if ($needOcr -and $tries -lt 2 -and ($now - $ocrAt) -ge 400 -and $null -ne $read -and [int]$read.W -ge 8) {
      $script:KeySegment.OcrTries = $tries + 1
      $script:KeySegment.OcrAt = $now
      $ocr = Read-CaretOcr ([int]$read.X) ([int]$read.Y) ([int]$read.W) ([int]$read.H)
      if (Test-CjkText $ocr) { Remember-Field $ocr }
    }
  } catch { }
}

function Get-SegmentText($seg) {
  $raw = ([string]$seg.Text).Trim()
  $field = ([string]$seg.Field).Trim()
  if ($field -ne '' -and $field -ne $raw) { return ('{0} [keys: {1}]' -f $field, $raw) }
  if ($field -ne '') { return $field }
  return [string]$seg.Text
}

function Emit-TutorKeys([string]$phase, [string]$text, [int64]$epoch) {
  $id = Get-WindowIdentity ([Sit.Native]::ForeHwnd())
  if ($script:TutorOverlayPid -gt 0 -and $id.pid -eq $script:TutorOverlayPid) { $id = Get-WindowIdentity 0 }
  Emit-Json ([ordered]@{
      type = 'keys'; phase = $phase; text = $text; ts = (Format-Epoch $epoch); epoch = $epoch
      tutorId = $script:TutorId
      app = [string]$id.app; process = [string]$id.process; pid = [int]$id.pid
      hwnd = [int64]$id.hwnd; title = [string]$id.title
    })
}

function Add-TutorTyping([string]$text, [int64]$epoch) {
  if (-not $script:KeySegment) {
    $script:KeySegment = @{ Text = ''; Last = $script:Sw.ElapsedMilliseconds; SnapAt = 0; Field = ''; OcrAt = 0; OcrTries = 0 }
    Emit-TutorKeys 'start' '' $epoch
    Invoke-TutorFrame (Get-WindowIdentity ([Sit.Native]::ForeHwnd()))
  }
  $script:KeySegment.Text = [string]$script:KeySegment.Text + $text
  $script:KeySegment.Last = $script:Sw.ElapsedMilliseconds
}

function Complete-TutorTyping([int64]$epoch) {
  if (-not $script:KeySegment) { return }
  if (-not (Test-CjkText ([string]$script:KeySegment.Field))) { Update-SegmentField }
  $text = Get-SegmentText $script:KeySegment
  $script:KeySegment = $null
  Emit-TutorKeys 'end' $text $epoch
  Invoke-TutorFrame (Get-WindowIdentity ([Sit.Native]::ForeHwnd()))
}

function Publish-TutorKeys {
  $n = 0
  try { $n = [Sit.KeyWatch]::Drain($script:KeyKind, $script:KeyEpoch, $script:KeyText) } catch { $n = 0 }
  for ($i = 0; $i -lt $n; $i++) {
    $kind = [int]$script:KeyKind[$i]
    $epoch = [int64]$script:KeyEpoch[$i]
    $text = [string]$script:KeyText[$i]
    if ($kind -eq 1) { Add-TutorTyping $text $epoch }
    elseif ($kind -eq 2) {
      if ($script:KeySegment) {
        $typed = [string]$script:KeySegment.Text
        if ($typed.Length -gt 0) { $script:KeySegment.Text = $typed.Substring(0, $typed.Length - 1) }
        $script:KeySegment.Last = $script:Sw.ElapsedMilliseconds
        $script:KeySegment.Field = ''
        $script:KeySegment.SnapAt = 0
        $script:KeySegment.OcrAt = 0
        $script:KeySegment.OcrTries = 0
      }
    } else {
      Complete-TutorTyping $epoch
      Emit-TutorKeys 'action' $text $epoch
      Invoke-TutorFrame (Get-WindowIdentity ([Sit.Native]::ForeHwnd()))
    }
  }
  # Re-read while the segment is still pinyin. A single 150ms snapshot can lock in the
  # composition or a URL; keep polling until CJK lands or the segment closes.
  if ($script:KeySegment) {
    $idle = [int64]$script:Sw.ElapsedMilliseconds - [int64]$script:KeySegment.Last
    $since = [int64]$script:Sw.ElapsedMilliseconds - [int64]$script:KeySegment.SnapAt
    $need = -not (Test-CjkText ([string]$script:KeySegment.Field))
    if ($idle -ge 150 -and $since -ge 150 -and ($need -or [int64]$script:KeySegment.SnapAt -lt [int64]$script:KeySegment.Last)) {
      Update-SegmentField
    }
  }
  if ($script:KeySegment -and (($script:Sw.ElapsedMilliseconds - [int64]$script:KeySegment.Last) -ge 700)) {
    Complete-TutorTyping (EpochMs)
  }
}

function Invoke-TutorWatch {
  if ($script:TutorId -eq '') { return }
  Protect-TutorWindows
  $hwnd = [Sit.Native]::ForeHwnd()
  $id = Get-WindowIdentity $hwnd
  $overlay = ($script:TutorOverlayPid -gt 0 -and $id.pid -eq $script:TutorOverlayPid)
  $key = ('{0}|{1}|{2}' -f $id.hwnd, $id.pid, $id.title)
  if ($key -ne $script:TutorForeKey) {
    $script:TutorForeKey = $key
    if (-not $overlay -and $id.hwnd -ne 0) {
      Emit-TutorWindow $id
      Invoke-TutorFrame $id
    }
  }
  $n = 0
  try { $n = [Sit.ClickWatch]::Drain($script:ClickBtn, $script:ClickX, $script:ClickY, $script:ClickEpoch) } catch { $n = 0 }
  for ($i = 0; $i -lt $n; $i++) {
    $cx = [int]$script:ClickX[$i]
    $cy = [int]$script:ClickY[$i]
    $clickHwnd = [Sit.Native]::RootAt($cx, $cy)
    $clickId = Get-WindowIdentity $clickHwnd
    if ($script:TutorOverlayPid -gt 0 -and $clickId.pid -eq $script:TutorOverlayPid) { continue }
    Emit-TutorClick ([int]$script:ClickBtn[$i]) $cx $cy ([int64]$script:ClickEpoch[$i]) $clickId
    Invoke-TutorFrame $clickId
  }
  Publish-TutorKeys
}

# ---------------------------------------------------------------------------
# 12. One sample
# ---------------------------------------------------------------------------
function Invoke-Sample([bool]$ForceCapture = $false) {
  $hwndL = [Sit.Native]::ForeHwnd()
  $tutor = $script:TutorId -ne ''
  $sampleTs = IsoNow
  $sampleEpoch = EpochMs
  $wpid = 0
  if ($hwndL -ne 0) { $wpid = [Sit.Native]::Pid($hwndL) }
  $procName = Resolve-ProcessName $wpid
  $tutorOwnWindow = $false
  if ($tutor) {
    if ($wpid -eq 0) { $tutorOwnWindow = $true }
    elseif ($script:TutorOverlayPid -ne 0 -and $wpid -eq $script:TutorOverlayPid) { $tutorOwnWindow = $true }
    elseif ($procName -like 'DeepSeek Harness*') { $tutorOwnWindow = $true }
  }
  if ($tutorOwnWindow) {
    if (-not $script:TutorGap) {
      $script:TutorGap = $true
      $script:PrevKey = ''
      $script:PrevFrameHash = $null
      Emit-Json ([ordered]@{ type = 'sample'; ts = $sampleTs; epoch = $sampleEpoch; tutorId = $script:TutorId; tutorGap = $true })
    }
    return
  }
  $script:TutorGap = $false
  $title = ''
  if ($hwndL -ne 0) { $title = [Sit.Native]::Title($hwndL) }
  $procExe = ''
  $appName = ''
  if ($procName) {
    $procExe = $procName
    if (-not $procExe.EndsWith('.exe')) { $procExe = $procExe + '.exe' }
    $appName = [System.IO.Path]::GetFileNameWithoutExtension($procExe)
  }
  $idleMs = [int][Sit.Native]::IdleMs()

  $bx = 0; $by = 0; $bw = $script:ScreenW; $bh = $script:ScreenH
  $frameRel = $null
  $fw = 0; $fh = 0
  $changed = $false
  $score = 0.0
  $ocrOut = $null
  $captureMethod = 'none'
  $capturedOk = $false
  $jpeg = $null

  if ($script:CaptureOn) {
    $key = ('{0}|{1}|{2}' -f $hwndL, $procExe, $title)
    $rect = $null
    if ($hwndL -ne 0 -and -not [Sit.Native]::IsMinimized($hwndL)) { $rect = [Sit.Native]::Rect($hwndL) }
    $capW = 0; $capH = 0
    $hash = [uint64]0
    $uniform = $true

    if (($null -ne $rect) -and ($rect[2] -ge 64) -and ($rect[3] -ge 64)) {
      $capW = [int]$rect[2]; $capH = [int]$rect[3]
      $bx = [int]$rect[0]; $by = [int]$rect[1]; $bw = $capW; $bh = $capH

      $script:Cap.Ensure($capW, $capH)
      $ok = [Sit.Native]::PrintTo($hwndL, $script:Cap, 2)
      $hr = [Sit.Native]::DHash($script:Cap, $script:HashCanvas)
      $captureMethod = 'printwindow-2'
      if (-not $ok -or $hr.Uniform) {
        $script:Cap.Ensure($capW, $capH)
        $ok = [Sit.Native]::PrintTo($hwndL, $script:Cap, 0)
        $hr = [Sit.Native]::DHash($script:Cap, $script:HashCanvas)
        $captureMethod = 'printwindow-0'
      }
      if (-not $tutor -and (-not $ok -or $hr.Uniform) -and [Sit.Native]::ForeHwnd() -eq $hwndL) {
        $script:Cap.Ensure($capW, $capH)
        $ok = [Sit.Native]::BitBltRect($bx, $by, $capW, $capH, $script:Cap)
        $hr = [Sit.Native]::DHash($script:Cap, $script:HashCanvas)
        $captureMethod = 'bitblt-rect'
      }
      if ($ok -and -not $hr.Uniform -and [Sit.Native]::ForeHwnd() -eq $hwndL) {
        $capturedOk = $true
        $hash = [uint64]$hr.Hash
      }
    }

    if ($capturedOk -and $capW -gt 0 -and $capH -gt 0) {
      $dist = 64
      if ($null -ne $script:PrevFrameHash) { $dist = [Sit.Native]::Dist($hash, [uint64]$script:PrevFrameHash) }
      $score = [math]::Round(($dist / 64.0), 4)
      $nowMs = $script:Sw.ElapsedMilliseconds
      $winChanged = ($key -ne $script:PrevKey)
      $bitChanged = ($dist -ge $script:ChangeBits)
      if ($tutor) { $bitChanged = ($dist -ge 3) }
      $heartbeat = (($nowMs - $script:LastFrameMs) -ge $script:HeartbeatMs)
      if ($tutor) { $heartbeat = (($nowMs - $script:LastFrameMs) -ge 6000) }
      $changed = ($winChanged -or $bitChanged)
      if ($ForceCapture -or $changed -or $heartbeat -or ($script:PrevFrameHash -eq $null)) {
        $fw = [math]::Min($FrameMaxWidth, $capW)
        if ($fw -lt 16) { $fw = 16 }
        $fh = [int][math]::Round($capH * ($fw / [double]$capW))
        if ($fh -lt 16) { $fh = 16 }
        [Sit.Native]::ScaleInto($script:Cap, $script:Fit, $fw, $fh)
        $script:LastFrameMs = $nowMs
        $script:PrevFrameHash = $hash
        $script:PrevKey = $key
        if ($tutor) {
          $memory = New-Object System.IO.MemoryStream
          try {
            $script:Fit.Bmp.Save($memory, $script:JpegCodec, $script:JpegParams)
            if ($memory.Length -le 393216) { $jpeg = [Convert]::ToBase64String($memory.ToArray()) }
          } finally { $memory.Dispose() }
          if ($script:OcrOn) { $ocrOut = Invoke-TutorOcr $fw $fh }
        } else {
          $name = (Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '.jpg'
          $full = [System.IO.Path]::Combine($script:FramesDir, $name)
          $script:Fit.Bmp.Save($full, $script:JpegCodec, $script:JpegParams)
          $frameRel = 'frames/' + $name
          $script:FrameCount++
          try { $script:FrameBytes += (New-Object System.IO.FileInfo($full)).Length } catch { }
          Invoke-Retention $false
          if ($script:OcrOn) {
            # Skip repeat OCR on heartbeat frames. A matching hash is approximate.
            $sameAsOcr = ($null -ne $script:LastOcrFrameHash) -and ([uint64]$hash -eq [uint64]$script:LastOcrFrameHash)
            if ($ForceCapture -or $winChanged -or -not $sameAsOcr) {
              $ocrOut = Invoke-OcrForFrame $full $fw $fh
              if ($null -ne $ocrOut) { $script:LastOcrFrameHash = [uint64]$hash }
            }
          }
        }
      }
    } elseif (-not $capturedOk) {
      $script:PrevFrameHash = $null
      $script:LastOcrFrameHash = $null
    }
  }

  $clipOut = $null
  if (-not $tutor -and $script:ClipOn) {
    $ct = Read-ClipboardText
    if ($null -ne $ct -and $ct -ne $script:LastClip) {
      $script:LastClip = $ct
      $clipOut = $ct
    }
  }

  $sample = [ordered]@{
    type      = 'sample'
    ts        = (IsoNow)
    epoch     = (EpochMs)
    app       = $appName
    process   = $procExe
    pid       = [int]$wpid
    hwnd      = [int64]$hwndL
    title     = $title
    idleMs    = [int]$idleMs
    bounds    = @([int]$bx, [int]$by, [int]$bw, [int]$bh)
    changed   = [bool]$changed
    score     = [double]$score
    clipboard = $null
  }
  if ($null -ne $frameRel) {
    $sample['frame'] = $frameRel
    $sample['frameWidth'] = [int]$fw
    $sample['frameHeight'] = [int]$fh
    $sample['capture'] = $captureMethod
  }
  if ($null -ne $ocrOut) { $sample['ocr'] = $ocrOut }
  if ($tutor) {
    $sample['ts'] = $sampleTs
    $sample['epoch'] = $sampleEpoch
    $sample['tutorId'] = $script:TutorId
    if ($null -ne $jpeg) { $sample['jpeg'] = $jpeg }
  }
  if ($null -ne $clipOut) { $sample['clipboard'] = $clipOut }
  if ($script:CaptureOn -and -not $capturedOk) { $sample['captureUnavailable'] = $true }
  if ($ForceCapture) { $sample['force'] = $true; $sample['shotRequest'] = $script:LastShotRequest }
  Emit-Json $sample
}

function Invoke-IdleSample {
  $hwndL = [Sit.Native]::ForeHwnd()
  $title = ''
  $wpid = 0
  if ($hwndL -ne 0) {
    $title = [Sit.Native]::Title($hwndL)
    $wpid = [Sit.Native]::Pid($hwndL)
  }
  $procName = Resolve-ProcessName $wpid
  $procExe = ''
  $appName = ''
  if ($procName) {
    $procExe = $procName
    if (-not $procExe.EndsWith('.exe')) { $procExe = $procExe + '.exe' }
    $appName = [System.IO.Path]::GetFileNameWithoutExtension($procExe)
  }
  $idleMs = [int][Sit.Native]::IdleMs()
  $s = [ordered]@{
    type      = 'sample'
    ts        = (IsoNow)
    epoch     = (EpochMs)
    app       = $appName
    process   = $procExe
    pid       = [int]$wpid
    hwnd      = [int64]$hwndL
    title     = $title
    idleMs    = [int]$idleMs
    bounds    = @(0, 0, [int]$script:ScreenW, [int]$script:ScreenH)
    changed   = $false
    score     = [double]0.0
    clipboard = $null
  }
  $s['idle'] = $true
  Emit-Json $s
}

# ---------------------------------------------------------------------------
# 12. Ready line + boot
# ---------------------------------------------------------------------------
$script:OcrReady = $false
$script:OcrBootError = ''
if ($script:OcrOn) {
  $script:OcrReady = Initialize-Ocr
  if (-not $script:OcrReady) {
    $script:OcrOn = $false
    $script:OcrBootError = 'OCR engine unavailable (Windows.Media.Ocr); OCR disabled'
  }
}

Initialize-Hotkey $Hotkey

Emit-Json ([ordered]@{
    type      = 'ready'
    protocol  = 1
    pid       = $PID
    startedAt = $script:StartedIso
    hotkey    = $script:HotkeySpec
    hotkeyOk  = [bool]$script:HotkeyOk
    hotkeyHold = [bool]$script:HotkeyHold
    hwnd      = [int64]$script:HotkeyHwnd
    ocr       = $(if ($script:OcrReady) { $script:OcrLang } else { $null })
    screen    = @([int]$script:ScreenW, [int]$script:ScreenH)
    outDir    = $OutDir
    dpi       = $script:DpiMode
  })

if ($script:OcrBootError) { Emit-Error $script:OcrBootError $false }
if ($script:HotkeyError -and $script:HotkeyError -ne 'disabled') {
  Emit-Error ('hotkey: ' + $script:HotkeyError) $false
}

# ---------------------------------------------------------------------------
# 13. Self test: one capture + OCR + sample, exit 0
# ---------------------------------------------------------------------------
if ($SelfTest -ne 0) {
  try {
    Invoke-Sample $true
  } catch {
    Emit-Error ('selftest failed: ' + $_.Exception.Message) $false
  }
  if ($null -ne $script:HotkeyWin) { try { [void][Sit.Native]::Unregister($script:HotkeyHwnd, 1) } catch { } }
  try { [Sit.HoldKey]::Uninstall() } catch { }
  try { [Sit.ClickWatch]::Uninstall() } catch { }
  try { [Sit.KeyWatch]::Uninstall() } catch { }
  Emit-Json ([ordered]@{ type = 'bye'; ts = (IsoNow); reason = 'selftest' })
  try { $script:Stdout.Flush() } catch { }
  exit 0
}

# ---------------------------------------------------------------------------
# 14. Main loop
# ---------------------------------------------------------------------------
$nextSample = 0
$lastIdleSample = -100000
$lastPausedSample = -100000
$lastErrorMs = 0
$loopStart = $script:Sw.ElapsedMilliseconds
$lastTutorForeground = [int64]0

try {
  while (-not $script:Stop -and -not $script:StdoutBroken) {
    $t0 = $script:Sw.ElapsedMilliseconds

    try { [void][Sit.Native]::Pump() } catch { Write-Log ('pump: ' + $_.Exception.Message) }

    while ([Sit.HotkeyWindow]::Pending) {
      [Sit.HotkeyWindow]::Pending = $false
      $hid = [int][Sit.HotkeyWindow]::LastId
      $script:HotkeyCount++
      Emit-Json ([ordered]@{ type = 'hotkey'; ts = (IsoNow); epoch = (EpochMs); id = 'toggle'; hwnd = [int64]$script:HotkeyHwnd })
    }

    if ($script:HotkeyHold) {
      try {
        [Sit.HoldKey]::Tick()
        for ($n = [int][Sit.HoldKey]::TakeStart(); $n -gt 0; $n--) {
          $script:HotkeyCount++
          Emit-Json ([ordered]@{ type = 'hotkey'; ts = (IsoNow); epoch = (EpochMs); id = 'start'; hwnd = [int64]0 })
        }
        for ($n = [int][Sit.HoldKey]::TakeStop(); $n -gt 0; $n--) {
          $script:HotkeyCount++
          Emit-Json ([ordered]@{ type = 'hotkey'; ts = (IsoNow); epoch = (EpochMs); id = 'stop'; hwnd = [int64]0 })
        }
      } catch { Write-Log ('hold: ' + $_.Exception.Message) }
    }

    try { Read-Control } catch { Write-Log ('control: ' + $_.Exception.Message) }
    if ($script:Stop) { break }

    $now = $script:Sw.ElapsedMilliseconds
    $idleMs = [int][Sit.Native]::IdleMs()
    if ($script:TutorId -ne '') { $lastTutorForeground = [Sit.Native]::ForeHwnd() } else { $lastTutorForeground = 0 }

    if ($script:TutorId -ne '' -and -not $script:Paused) {
      try { Invoke-TutorWatch }
      catch {
        $msg = $_.Exception.Message
        if (($now - $lastErrorMs) -gt 5000) {
          $lastErrorMs = $now
          Emit-Error ('tutor watch failed: ' + $msg) $false
        } else { Write-Log ('tutor watch failed: ' + $msg) }
      }
    } elseif ($script:Paused) {
      if (($now - $lastPausedSample) -ge $script:PausedSampleMs -or $lastPausedSample -lt 0) {
        Emit-Json ([ordered]@{ type = 'sample'; ts = (IsoNow); epoch = (EpochMs); paused = $true })
        $lastPausedSample = $now
      }
    } elseif (($script:TutorId -eq '') -and ($IdleSkipSeconds -gt 0) -and ($idleMs -gt ($IdleSkipSeconds * 1000)) -and (-not $script:ForceShot)) {
      if (($now - $lastIdleSample) -ge $script:IdleSampleMs -or $lastIdleSample -lt 0) {
        try { Invoke-IdleSample } catch { Write-Log ('sample: ' + $_.Exception.Message) }
        $lastIdleSample = $now
      }
    } elseif ($script:ForceShot -or $now -ge $nextSample) {
      $force = $false
      if ($script:ForceShot) { $force = $true; $script:ForceShot = $false }
      try { Invoke-Sample $force }
      catch {
        $msg = $_.Exception.Message
        if (($now - $lastErrorMs) -gt 5000) {
          $lastErrorMs = $now
          Emit-Error ('sample failed: ' + $msg) $false
        } else { Write-Log ('sample failed: ' + $msg) }
      }
      if ($now -ge $nextSample) { $nextSample = $nextSample + $IntervalMs }
      if ($nextSample -le $now) {
        # A slow tick (dense OCR) must not produce a catch-up burst: stay on the
        # interval grid and skip the missed slot(s) instead.
        $skips = [math]::Ceiling((($now - $nextSample) + 1) / $IntervalMs)
        $nextSample = $nextSample + ($skips * $IntervalMs)
        if ($nextSample -lt ($now + 50)) { $nextSample = $now + 50 }
      }
      $lastIdleSample = $now - $script:IdleSampleMs
    }

    $spent = $script:Sw.ElapsedMilliseconds - $t0
    $wake = 100
    $nowAfter = $script:Sw.ElapsedMilliseconds
    $untilNext = $nextSample - $nowAfter
    if ($untilNext -gt 0 -and $untilNext -lt $wake) { $wake = [int]$untilNext }
    $sleep = $wake - $spent
    if ($sleep -lt 2) { $sleep = 2 }
    [System.Threading.Thread]::Sleep([int]$sleep)
  }
} catch {
  Emit-Error ('fatal loop error: ' + $_.Exception.Message) $true
  $script:StopReason = 'fatal'
} finally {
  try { [Sit.HoldKey]::Uninstall() } catch { }
  try { [Sit.ClickWatch]::Uninstall() } catch { }
  try { [Sit.KeyWatch]::Uninstall() } catch { }
  if ($null -ne $script:HotkeyWin) {
    try { [void][Sit.Native]::Unregister($script:HotkeyHwnd, 1) } catch { }
    try { $script:HotkeyWin.Dispose() } catch { }
  }
  foreach ($c in @($script:Cap, $script:Fit, $script:HashCanvas, $script:OcrCanvas, $script:CaretCanvas)) {
    try { $c.Dispose() } catch { }
  }
  if ($null -ne $script:Sha1) { try { $script:Sha1.Dispose() } catch { } }
}

if ($script:StopReason -eq '') { $script:StopReason = 'stdout-closed' }
Emit-Json ([ordered]@{ type = 'bye'; ts = (IsoNow); reason = $script:StopReason })
try { $script:Stdout.Flush() } catch { }
exit 0
