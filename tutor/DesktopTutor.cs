using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace DesktopTutor
{
    public sealed class Shell
    {
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly Dispatcher dispatcher = Dispatcher.CurrentDispatcher;
        private readonly Window overlay = new Window();
        private readonly TextBlock badge = Label("桌面辅导", 12);
        private readonly TextBlock answer = Label("", 16);
        private readonly Button retry = new Button { Content = "重试" };
        private readonly ScrollViewer scroll = new ScrollViewer { MaxHeight = 360, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        private WaveCapture recorder;
        private bool closing;
        private string observingLabel = "屏幕观察";
        private System.Windows.Controls.Image mascotImage;
        private readonly Dictionary<string, ImageSource> mascotStates = new Dictionary<string, ImageSource>();
        private string mascotState = "";
        private bool userMoved;
        private double anchorRight, anchorBottom;

        public static void Run()
        {
            var shell = new Shell();
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            shell.BuildOverlay();
            var reader = new Thread(shell.ReadHost) { IsBackground = true };
            reader.Start();
            shell.overlay.Show();
            shell.Emit(new { type = "opened" });
            app.Run();
        }

        private static TextBlock Label(string value, double size)
        {
            return new TextBlock { Text = value, FontSize = size, TextWrapping = TextWrapping.Wrap,
                Foreground = new SolidColorBrush(Color.FromRgb(33, 42, 64)), Margin = new Thickness(0, 3, 0, 3) };
        }

        private void BuildOverlay()
        {
            overlay.Title = "DSH 学习助手";
            overlay.ShowActivated = false;
            overlay.ShowInTaskbar = false;
            overlay.Topmost = true;
            overlay.AllowsTransparency = true;
            overlay.Background = Brushes.Transparent;
            overlay.WindowStyle = WindowStyle.None;
            overlay.ResizeMode = ResizeMode.NoResize;
            overlay.SizeToContent = SizeToContent.WidthAndHeight;
            overlay.WindowStartupLocation = WindowStartupLocation.Manual;
            overlay.SourceInitialized += (s, e) => {
                var hwnd = new WindowInteropHelper(overlay).Handle;
                Native.NoActivate(hwnd);
                Native.ExcludeFromCapture(hwnd);
                // Deliver clicks (the close button) without stealing the foreground.
                var source = HwndSource.FromHwnd(hwnd);
                if (source != null) source.AddHook(Native.MouseActivateWithoutFocus);
            };
            overlay.SizeChanged += (s, e) => PositionOverlay();
            overlay.Closed += (s, e) => Close();

            var layout = new StackPanel { HorizontalAlignment = HorizontalAlignment.Right };
            var bubble = new Border { Background = new SolidColorBrush(Color.FromRgb(243, 246, 255)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(206, 218, 245)), BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(16), Padding = new Thickness(15, 10, 15, 10),
                Width = 380, Margin = new Thickness(0, 0, 0, 8) };
            var bubbleContents = new StackPanel();
            answer.Text = "正在观察整个屏幕。按一次快捷键开始提问，再按一次发送。";
            scroll.Content = answer;
            bubbleContents.Children.Add(scroll);
            retry.Margin = new Thickness(0, 8, 0, 0);
            retry.HorizontalAlignment = HorizontalAlignment.Left;
            retry.Visibility = Visibility.Collapsed;
            retry.Click += (s, e) => Emit(new { type = "retry" });
            bubbleContents.Children.Add(retry);
            bubble.Child = bubbleContents;
            answer.Tag = bubble;
            layout.Children.Add(bubble);

            var pill = new Border { Background = Brushes.White, BorderBrush = new SolidColorBrush(Color.FromRgb(206, 218, 245)),
                BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(20), Padding = new Thickness(7, 4, 8, 4),
                HorizontalAlignment = HorizontalAlignment.Right };
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            badge.VerticalAlignment = VerticalAlignment.Center;
            badge.Margin = new Thickness(7, 0, 7, 0);
            row.Children.Add(badge);
            var close = new Button { Content = "×", ToolTip = "结束辅导", Width = 24, Height = 24, Focusable = false };
            close.Click += (s, e) => Close();
            row.Children.Add(close);
            pill.Child = row;
            pill.VerticalAlignment = VerticalAlignment.Bottom;
            var footer = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var mascot = DrawCharacter();
            mascot.VerticalAlignment = VerticalAlignment.Bottom;
            mascot.Margin = new Thickness(0, 0, 4, 0);
            footer.Children.Add(mascot);
            footer.Children.Add(pill);
            pill.MouseLeftButtonDown += (s, e) => StartDrag();
            layout.Children.Add(footer);
            overlay.Content = layout;
        }

        private void PositionOverlay()
        {
            if (userMoved) {
                double vl = SystemParameters.VirtualScreenLeft, vt = SystemParameters.VirtualScreenTop;
                double vr = vl + SystemParameters.VirtualScreenWidth, vb = vt + SystemParameters.VirtualScreenHeight;
                overlay.Left = Math.Max(vl, Math.Min(anchorRight, vr) - overlay.ActualWidth);
                overlay.Top = Math.Max(vt, Math.Min(anchorBottom, vb) - overlay.ActualHeight);
                return;
            }
            Rect area = SystemParameters.WorkArea;
            overlay.Left = Math.Max(area.Left, area.Right - overlay.ActualWidth - 20);
            overlay.Top = Math.Max(area.Top, area.Bottom - overlay.ActualHeight - 20);
        }

        private FrameworkElement DrawCharacter()
        {
            // Original mascot artwork (tutor/mascot.png) when present; vector fallback below.
            try {
                string path = Environment.GetEnvironmentVariable("DESKTOP_TUTOR_MASCOT");
                if (!string.IsNullOrEmpty(path) && File.Exists(path)) {
                    // Three poses: idle (mascot.png), listening (mascot-listen.png), answering (mascot-answer.png).
                    string dir = Path.GetDirectoryName(path);
                    mascotStates["idle"] = LoadBitmap(path);
                    foreach (var name in new[] { "listen", "answer" }) {
                        string p = Path.Combine(dir, "mascot-" + name + ".png");
                        mascotStates[name] = File.Exists(p) ? LoadBitmap(p) : mascotStates["idle"];
                    }
                    var image = new System.Windows.Controls.Image { Source = mascotStates["idle"], Width = 60, Height = 100, Stretch = Stretch.Uniform,
                        Cursor = System.Windows.Input.Cursors.SizeAll, ToolTip = "拖动可移动位置" };
                    RenderOptions.SetBitmapScalingMode(image, BitmapScalingMode.HighQuality);
                    image.MouseLeftButtonDown += (s, e) => StartDrag();
                    mascotImage = image;
                    mascotState = "idle";
                    return image;
                }
            } catch { }
            // Original artwork drawn as WPF shapes so it stays sharp at desktop DPI.
            var canvas = new Canvas { Width = 48, Height = 48, IsHitTestVisible = false };
            Dot(canvas, 0, 0, 48, 48, "#E7EDFF");
            Dot(canvas, 9, 29, 30, 17, "#6883D8");
            Dot(canvas, 6, 5, 36, 30, "#354B87");
            Dot(canvas, 9, 11, 30, 24, "#FFE0C6");
            Dot(canvas, 9, 7, 27, 10, "#354B87");
            Dot(canvas, 15, 20, 4, 5, "#25324D");
            Dot(canvas, 29, 20, 4, 5, "#25324D");
            Dot(canvas, 12, 25, 6, 3, "#F6ACA7");
            Dot(canvas, 30, 25, 6, 3, "#F6ACA7");
            Dot(canvas, 22, 27, 5, 3, "#A65F64");
            return canvas;
        }

        private static ImageSource LoadBitmap(string file)
        {
            var bitmap = new System.Windows.Media.Imaging.BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            bitmap.UriSource = new Uri(file, UriKind.Absolute);
            bitmap.EndInit();
            bitmap.Freeze();
            return bitmap;
        }

        private void SetMascot(string state)
        {
            if (mascotImage == null || state == mascotState || !mascotStates.ContainsKey(state)) return;
            mascotState = state;
            mascotImage.Source = mascotStates[state];
        }

        private void StartDrag()
        {
            try { overlay.DragMove(); } catch (InvalidOperationException) { return; }
            userMoved = true;
            anchorRight = overlay.Left + overlay.ActualWidth;
            anchorBottom = overlay.Top + overlay.ActualHeight;
        }

        private static void Dot(Canvas canvas, double left, double top, double width, double height, string color)
        {
            var shape = new System.Windows.Shapes.Ellipse { Width = width, Height = height,
                Fill = (Brush)new BrushConverter().ConvertFromString(color) };
            Canvas.SetLeft(shape, left);
            Canvas.SetTop(shape, top);
            canvas.Children.Add(shape);
        }

        private void ReadHost()
        {
            try {
                var parser = new JavaScriptSerializer();
                string line;
                while ((line = Console.ReadLine()) != null) {
                    var command = parser.Deserialize<Dictionary<string, object>>(line);
                    dispatcher.BeginInvoke(new Action(() => Handle(command)));
                }
            } catch (IOException) { }
            finally { dispatcher.BeginInvoke(new Action(Close)); }
        }

        private void Handle(Dictionary<string, object> command)
        {
            if (closing || command == null || !command.ContainsKey("type")) return;
            switch ((string)command["type"]) {
                case "display": {
                    var phase = command.ContainsKey("phase") ? (string)command["phase"] : "";
                    var value = command.ContainsKey("text") && command["text"] is string ? (string)command["text"] : "";
                    const string watchPrefix = "屏幕观察 · ";
                    bool observing = value.StartsWith(watchPrefix, StringComparison.Ordinal);
                    if (observing) observingLabel = "屏幕观察";
                    badge.Text = phase == "recording" ? "听你说" : phase == "processing" ? "正在分析" : phase == "answering" ? "正在回答" : observingLabel;
                    SetMascot(phase == "recording" ? "listen" : (phase == "processing" || phase == "answering") ? "answer" : "idle");
                    answer.Text = observing ? value.Substring(watchPrefix.Length) : value;
                    ((Border)answer.Tag).Visibility = answer.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
                    scroll.ScrollToEnd();
                    retry.Visibility = command.ContainsKey("retry") && (bool)command["retry"] ? Visibility.Visible : Visibility.Collapsed;
                    break;
                }
                case "record":
                    if (recorder == null) {
                        recorder = new WaveCapture((finished, wav, failure) => dispatcher.BeginInvoke(new Action(() => {
                            if (recorder != finished || closing) return;
                            recorder = null;
                            if (failure) Emit(new { type = "audio-error" });
                            else Emit(new { type = "audio", wav = wav });
                        })));
                        recorder.Start();
                    }
                    break;
                case "record-end":
                    if (recorder != null) recorder.Stop();
                    break;
            }
        }

        private void Emit(object value)
        {
            try { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
            catch (IOException) { dispatcher.BeginInvoke(new Action(Close)); }
        }

        private void Close()
        {
            if (closing) return;
            closing = true;
            if (recorder != null) { recorder.Stop(); recorder = null; }
            Emit(new { type = "close" });
            Application.Current.Shutdown();
        }
    }

    internal static class Native
    {
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr hwnd, int index, int value);
        [DllImport("user32.dll")] private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

        internal static void NoActivate(IntPtr hwnd)
        {
            const int extendedStyle = -20;
            SetWindowLong(hwnd, extendedStyle, GetWindowLong(hwnd, extendedStyle) | 0x08000000 | 0x80);
        }

        internal static void ExcludeFromCapture(IntPtr hwnd)
        {
            try { SetWindowDisplayAffinity(hwnd, 0x11); } catch (Exception) { }
        }

        internal static IntPtr MouseActivateWithoutFocus(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            const int WM_MOUSEACTIVATE = 0x0021;
            const int MA_NOACTIVATE = 3;
            if (msg == WM_MOUSEACTIVATE) {
                handled = true;
                return new IntPtr(MA_NOACTIVATE);
            }
            return IntPtr.Zero;
        }

    }

    internal sealed class WaveCapture
    {
        private const int SampleRate = 16000;
        private const int Seconds = 30;
        private readonly ManualResetEvent stopped = new ManualResetEvent(false);
        private readonly Action<WaveCapture, string, bool> completed;

        [StructLayout(LayoutKind.Sequential, Pack = 2)]
        private struct Format
        {
            public ushort encoding, channels;
            public uint samplesPerSecond, bytesPerSecond;
            public ushort blockAlign, bits, extraSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Header
        {
            public IntPtr data;
            public uint bufferLength, bytesRecorded;
            public UIntPtr user;
            public uint flags, loops;
            public IntPtr next;
            public UIntPtr reserved;
        }

        [DllImport("winmm.dll")] private static extern uint waveInOpen(out IntPtr handle, uint device, ref Format format, IntPtr callback, IntPtr instance, uint flags);
        [DllImport("winmm.dll")] private static extern uint waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);
        [DllImport("winmm.dll")] private static extern uint waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);
        [DllImport("winmm.dll")] private static extern uint waveInAddBuffer(IntPtr handle, IntPtr header, uint size);
        [DllImport("winmm.dll")] private static extern uint waveInStart(IntPtr handle);
        [DllImport("winmm.dll")] private static extern uint waveInReset(IntPtr handle);
        [DllImport("winmm.dll")] private static extern uint waveInClose(IntPtr handle);

        internal WaveCapture(Action<WaveCapture, string, bool> completed) { this.completed = completed; }
        internal void Start() { new Thread(Record) { IsBackground = true }.Start(); }
        internal void Stop() { try { stopped.Set(); } catch (ObjectDisposedException) { } }

        private void Record()
        {
            IntPtr wave = IntPtr.Zero, data = IntPtr.Zero, header = IntPtr.Zero;
            uint headerSize = (uint)Marshal.SizeOf(typeof(Header));
            bool prepared = false, failure = false;
            string result = "";
            try {
                var format = new Format { encoding = 1, channels = 1, samplesPerSecond = SampleRate,
                    bytesPerSecond = SampleRate * 2, blockAlign = 2, bits = 16 };
                Require(waveInOpen(out wave, uint.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0));
                int bytes = SampleRate * 2 * Seconds;
                data = Marshal.AllocHGlobal(bytes);
                header = Marshal.AllocHGlobal((int)headerSize);
                Marshal.StructureToPtr(new Header { data = data, bufferLength = (uint)bytes }, header, false);
                Require(waveInPrepareHeader(wave, header, headerSize));
                prepared = true;
                Require(waveInAddBuffer(wave, header, headerSize));
                Require(waveInStart(wave));
                stopped.WaitOne(TimeSpan.FromSeconds(Seconds));
                Require(waveInReset(wave));
                var returned = (Header)Marshal.PtrToStructure(header, typeof(Header));
                var pcm = new byte[Math.Min(bytes, (int)returned.bytesRecorded) & ~1];
                Marshal.Copy(data, pcm, 0, pcm.Length);
                if (HasSound(pcm)) result = Wav(pcm);
            } catch (Exception) { failure = true; }
            finally {
                if (wave != IntPtr.Zero) {
                    waveInReset(wave);
                    if (prepared) waveInUnprepareHeader(wave, header, headerSize);
                    waveInClose(wave);
                }
                if (header != IntPtr.Zero) Marshal.FreeHGlobal(header);
                if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
                stopped.Dispose();
            }
            completed(this, result, failure);
        }

        private static void Require(uint code)
        {
            if (code != 0) throw new InvalidOperationException("Wave input error " + code);
        }

        private static bool HasSound(byte[] pcm)
        {
            int audibleSamples = 0;
            for (int i = 0; i < pcm.Length; i += 2) {
                int sample = (short)(pcm[i] | pcm[i + 1] << 8);
                if (Math.Abs(sample) > 160 && ++audibleSamples >= SampleRate / 20) return true;
            }
            return false;
        }

        private static string Wav(byte[] pcm)
        {
            using (var stream = new MemoryStream())
            using (var writer = new BinaryWriter(stream)) {
                writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(pcm.Length + 36);
                writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
                writer.Write((short)1); writer.Write((short)1); writer.Write(SampleRate);
                writer.Write(SampleRate * 2); writer.Write((short)2); writer.Write((short)16);
                writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(pcm.Length); writer.Write(pcm);
                return Convert.ToBase64String(stream.ToArray());
            }
        }
    }
}
