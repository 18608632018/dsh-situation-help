# dsh-situation-help

DeepSeek Harness（DSH）的一个桌面插件。它在本机持续看屏幕：前台窗口、OCR、按需截图、中文输入，再用全局热键做语音提问，并在桌面上放一个可拖动的辅导悬浮窗和三态小人。

仓库：<https://github.com/18608632018/dsh-situation-help>

这是第三方插件，与 DeepSeek 官方无关，也不是 DeepSeek 的产品。

**English.** `dsh-situation-help` is a third-party desktop plugin for DeepSeek Harness (DSH). It is not affiliated with DeepSeek. On a Windows PC it keeps a local sense of the foreground window, screen text, and on-demand screenshots, captures Chinese input, and adds a global voice hotkey plus a draggable tutor overlay. The mascot is an original character with idle, listening, and answering poses.

## 做什么

插件分四块，由 DSH 按包名 `@local/situation` 加载：

| 部分 | 文件 | 作用 |
|---|---|---|
| Host | `index.js` | 拉起传感器、保存事件、提供 `/situation/*` 路由和 4 个模型工具、把一行文字摘要注入正在运行的会话、把语音交给 DSH 的语音转写 |
| 页面 | `client.js` | 侧栏「现场感知」、输入框旁的麦克风、热键联动、开始辅导 |
| 传感器 | `sensor/sense.ps1` | 一个长期运行的 Windows PowerShell 5.1 进程：前台窗口、空闲、dHash 变化检测、JPEG、Windows.Media.Ocr、全局热键 |
| 悬浮窗 | `tutor.js`、`tutor/desktop.ps1`、`tutor/DesktopTutor.cs` | 桌面辅导：整屏观察、语音提问、气泡回答、三态小人 |

平时它按变化记录前台窗口和屏幕文字，画面没变就不写盘、不跑 OCR。需要看画面时再取一张 JPEG。辅导开始后不再裁剪前台窗口，改为观察整个虚拟桌面（多显示器都算），并且只在有操作时抓图，没有定时截图。

辅导期间会记下这些操作，并各抓一张全屏：窗口切换、鼠标点击（含滚轮）、一段输入的开始，以及停顿约 0.7 秒后的结束、Enter / Tab / Esc / 快捷键。连续打字合成一段文字，不按每个字抓图。和上一帧像素相同的画面只留操作记录。关键帧默认长边约 1920（`tutorFrameMaxEdge`）。这些辅导图只放在内存里，不写进 `frames\`。

中文输入只在辅导期间采集。键盘钩子随辅导装上，结束就卸下，也不吞按键。低层钩子在中文输入法下只能看到拼音。传感器优先读光标所在段落；读到网址就丢掉；如果拿到的仍是拼音，就对光标这一行和它下方的候选条做 OCR，留下汉字。

不说话、不提问时，辅导不会调用模型。提问前先用 DSH 的本地语音转写得到文字，再把这次辅导从开始到现在的操作交给该会话当时选中的模型。能看图的模型会收到去重后的关键帧；张数或体积超出单次限制时按时间分批读，气泡显示「正在读取画面 i/n」。只有总量放不进上下文，或分批失败时，较早的帧才改成文字摘要。

模型还能调用四个工具：`situation`（当前窗口和最近的屏幕文字）、`situation_log`（活动日志）、`situation_frame`（最新截图路径，配合 DSH 的 `read_image`）、`situation_control`（暂停、开关截图 / OCR / 剪贴板、改热键、启停传感器）。

## 小人

小人是原创角色，有三态。悬浮窗可以拖动。图片缺失时，窗口会退回一套简单的矢量形状。

| 状态 | 何时 | 图 |
|---|---|---|
| 待命 | 空闲、观察屏幕 | ![待命](tutor/mascot.png) |
| 听你说 | 正在录音 | ![听你说](tutor/mascot-listen.png) |
| 正在回答 | 分析或回答 | ![正在回答](tutor/mascot-answer.png) |

## 环境

- Windows。截图、OCR、全局热键和悬浮窗都依赖 Win32。
- Windows PowerShell 5.1（`powershell.exe`）。`Windows.Media.Ocr` 是 WinRT，PowerShell 7（`pwsh`）加载不了这些类型。
- 已安装并能加载插件的 DeepSeek Harness。本目录的包名必须仍是 `@local/situation`，DSH 按这个名字加载。
- Node.js 20.3 或更新。辅导代码使用 `AbortSignal.any`（Node.js 20.3 起提供），测试还使用 `node:test`。

系统要有可用的 Windows OCR 语言包。引擎顺序是：当前用户语言 → `zh-Hans-CN` → `en-US`。三个都没有时，OCR 关闭，传感器继续跑，并记一条非致命错误。

## 安装与启用

把本目录交给 DSH 的 `plugin_manager`。下面是 `README` 和 `CONTRACT.md` 里已经在用的写法，把路径换成这台机器上的插件目录：

```text
plugin_manager { action: 'install_bundle', target: '<插件目录>' }
```

安装后重启 DSH。`link:` 目录里的 JS 改动不会被热替换。侧栏出现「现场感知」就是装上了。客户端清单在启动时装入：先在 DSH 窗口按 Ctrl+R；图标仍不在，再重启 DSH。Host 一侧（工具、路由、语音）在插件加载后即生效。

默认配置在 `cordis.patch.yml`，安装时写入。之后在面板里改过的开关和热键写到数据目录的 `settings.json`，覆盖这些默认值。

| 键 | 默认 | 含义 |
|---|---|---|
| `intervalMs` | 1500 | 采样间隔（宿主会夹在 400–10000） |
| `frameMaxWidth` | 1280 | 平时截图的最大宽度 |
| `jpegQuality` | 62 | JPEG 质量 |
| `ocrScale` | 1.6 | OCR 前的放大下限 |
| `ocr` | true | 是否持续 OCR |
| `clipboard` | false | 是否读取剪贴板文本 |
| `idleSkipSeconds` | 240 | 空闲超过该秒数后停止截图和 OCR |
| `frameRetentionMinutes` | 45 | 帧保留多久 |
| `tutorFrameMaxEdge` | 1920 | 辅导关键帧的长边 |
| `hotkey` | Ctrl+Alt+V | 全局语音热键 |
| `autoContext` | true | 向正在运行的会话注入一行现场摘要 |
| `autoContextSeconds` | 60 | 这条摘要的最短间隔 |
| `autoStart` | true | 插件加载后即启动传感器 |

数据目录默认是 `%USERPROFILE%\.dsh\situation\`。设置了 `DSH_HOME` 时改为 `%DSH_HOME%\situation`。配置里的 `dataDir` 可以指定别的目录。

- `frames\*.jpg`：变化帧。传感器按保留时间清理，最多留 400 张。
- `events.jsonl`：活动日志，超过 24 MB 轮转一份 `.1`。
- `control.json`：Host 写给传感器的控制（暂停、截图、OCR、剪贴板、立即截屏、停止、辅导）。
- `settings.json`：面板里保存的开关和热键。

停用和移除：

```text
plugin_manager { action: 'set_plugin', target: '@local/situation', enabled: false }
plugin_manager { action: 'remove_bundle', target: '@local/situation' }
```

面板上的「暂停」，或工具 `situation_control {action:"pause"}`，只暂停记录。已经记下的内容还在。删掉数据目录即可清掉本插件写下的文件；它不往别处写。

装好后可以看状态（端口以当前 DSH 窗口为准）：

```powershell
$base = 'http://127.0.0.1:26977'
(Invoke-WebRequest "$base/situation/state" -UseBasicParsing).Content
```

`sensor.ready` 应为 `true`。在两个窗口之间切换后，`recent` 里应出现新条目，`latest.frame` 应能打开 JPEG。

单独跑传感器时，用 `powershell.exe`，不要用 `pwsh`。参数说明见 `sensor/README.md`。输出目录用当前用户目录，例如：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sensor\sense.ps1 `
  -OutDir "$env:USERPROFILE\.dsh\situation" -IntervalMs 1500 -FrameMaxWidth 1280 -JpegQuality 62 `
  -Ocr 1 -Clipboard 0 -IdleSkipSeconds 240 -FrameRetentionMinutes 45 `
  -Hotkey "Ctrl+Alt+V" -SelfTest 0
```

## 热键

默认 `Ctrl+Alt+V`：按一次开始录音，再按一次结束并送去转写。辅导进行中，这个热键改去开关悬浮窗录音，不再往输入框里插文字。

面板里可以改组合。保存后传感器会重启以重新注册。支持带 Ctrl / Alt / Shift / Win 的字母、数字、功能键和方向键等。

两种按住说话的写法仍然有效：

- 单独的 `Space`：按住至少约 350 毫秒开始，松开结束。轻点仍是普通空格。
- `B+Space` 这种「一个字符 + Space」：按住字符键至少约 200 毫秒再按空格，松开结束。没按够时间就松手时，字符照常输入。

热键注册失败不会停掉感知，面板上 `hotkeyOk` 为 false。`Ctrl+Alt+Space` 在开着中文输入法的 Windows 上经常已经被占用（Win32 错误 1409），所以默认不用它。

输入框旁的麦克风走浏览器录音，第一次要允许麦克风。转写依赖 DSH 已启用的语音转写，本插件不自带模型。

## 隐私

截图、OCR 文字、窗口标题和活动日志都写在本机数据目录里。辅导用的关键帧只留在内存，不进 `frames\`。键盘钩子只在辅导进行时安装。剪贴板默认不读。

这些内容不会自己上传。什么时候发给模型，由 DSH 决定：

- `autoContext` 默认为开。正在运行的会话最多每 60 秒（或窗口标题变化后，5 秒去抖）收到一行 `[现场感知]` 文字，不含图片。`autoContext: false` 可关。辅导进行时不注入。
- 模型调用 `situation_frame` 后，会拿到一张本机 JPEG 的路径，再由 DSH 的 `read_image` 去读。
- 辅导里说完一句并转写成功后，文字时间线和关键帧交给**开启辅导时该会话选中的模型**。用哪家服务、哪个模型，看 DSH 的模型配置。本插件没有 API key。

悬浮窗不会被截进图。辅导窗口在显示时调用 `SetWindowDisplayAffinity`，亲和性值 `0x11`（`WDA_EXCLUDEFROMCAPTURE`）；传感器也会对辅导进程的顶层窗口做同样的排除。DSH 自己的窗口不排除，会照常出现在画面里。

窗口标题、OCR 和自动注入的摘要是屏幕上的外部文字。插件提示模型把它们当参考，不要当成给模型的指令。

## 目录

```text
.
├─ index.js                 Host 插件
├─ client.js                侧栏页面、麦克风、辅导按钮
├─ tutor.js                 辅导会话与分批看图
├─ tutor/
│  ├─ desktop.ps1           编译并启动悬浮窗
│  ├─ DesktopTutor.cs       悬浮窗、拖动、三态小人、本机录音
│  ├─ mascot.png            待命
│  ├─ mascot-listen.png     听你说
│  └─ mascot-answer.png     正在回答
├─ sensor/
│  ├─ sense.ps1             传感器（必须保持纯 ASCII）
│  ├─ test-sensor.ps1       Windows 上的传感器测试
│  └─ README.md             传感器协议与限制
├─ cordis.patch.yml         安装项与默认配置
├─ package.json             清单，包名 @local/situation
├─ icon.svg
├─ locale/                  侧栏标题的中英文
├─ CONTRACT.md              行为契约
├─ tutor-test.mjs
├─ client-test.mjs
├─ host-test.mjs
├─ host-e2e-test.mjs        需要自备 sensor/mock-sense.ps1
├─ README.md
└─ LICENSE                  MIT
```

## 测试

在本目录、Node.js 20.3 或更新版本上：

```text
node tutor-test.mjs
node client-test.mjs
node host-test.mjs
```

这三项不需要 Windows，也不抓真实屏幕。`host-test.mjs` 会检查 `sensor/sense.ps1` 仍是纯 ASCII、无 BOM。

`node host-e2e-test.mjs` 要有一个假的传感器脚本 `sensor/mock-sense.ps1`。仓库不附带这个文件。

传感器本身的测试要在 Windows PowerShell 5.1 里跑，工作目录默认是 `%TEMP%\situation-sensor-test`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sensor\test-sensor.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sensor\test-sensor.ps1 -Stage 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sensor\test-sensor.ps1 -Hotkey "Ctrl+Alt+F12" -WorkDir "$env:TEMP\situation-sensor-test"
```

阶段说明见 `sensor/README.md`。退出码 0 表示通过。

## 已知限制

- 受保护窗口（部分 UWP、以管理员运行的窗口、DRM 或全屏游戏）可能拒绝 `PrintWindow`。退到屏幕复制时，图里会带上压在上面的窗口；最坏是整屏，也可能没有画面。
- 平时只截当前焦点窗口。窗口一切换，旧截图和旧文字就清掉。文字变化很小时，OCR 可能要等下一张变化帧；面板里的立即截图可以强制抓一张。
- 多显示器且缩放比例不同时，整屏兜底可能偏移或裁边。按窗口截图不受影响。
- 空闲只看最后一次键鼠（`GetLastInputInfo`）。看视频、读长文会算成空闲，超过 `idleSkipSeconds` 后就不再截图和 OCR。
- 热键被别的程序占用时，只有语音开关失效，感知继续。
- 语音转写要求 DSH 的语音转写服务可用。服务没开时，辅导会直接拒绝启动。
- 剪贴板采集默认关闭，并且要求 PowerShell 以 STA 运行。`powershell.exe` 默认就是 STA。
- `sensor/sense.ps1` 必须保持纯 ASCII。Windows PowerShell 5.1 会按系统 ANSI 代码页读取没有 BOM 的脚本。

## 许可

[MIT License](LICENSE)。Copyright (c) 2026 18608632018。

小人图是本仓库的原创角色，随同一许可证发布。
