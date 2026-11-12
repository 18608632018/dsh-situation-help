# sensor — Windows 桌面感知 + 全局热键

`sense.ps1` 是 @local/situation 的传感器助手：**一个长驻进程**同时做前台窗口采样、空闲检测、
窗口截图、Windows OCR、剪贴板读取和全局热键，把结果以 UTF-8 JSON 行写到 stdout。
宿主（`index.js`）只读这些行，不参与采集。

性能上的取舍：没有子进程、没有模块重复导入、没有 VLM。截图对象和 GDI 位图全程复用，
**只在画面真变了才写 JPEG 和跑 OCR**。

## 必须用 powershell.exe 5.1

`Windows.Media.Ocr` 属于 WinRT，**PowerShell 7 加载不了这些类型**（会抛 `TypeNotFound`）。
所有命令都用 `powershell.exe`，不要用 `pwsh`。

## 运行

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sense.ps1 `
  -OutDir "$env:USERPROFILE\.dsh\situation" -IntervalMs 1200 -FrameMaxWidth 1280 -JpegQuality 62 `
  -Ocr 1 -Clipboard 0 -IdleSkipSeconds 240 -FrameRetentionMinutes 30 `
  -Hotkey "Ctrl+Alt+V" -SelfTest 0
```

自检（一次截图 + 一次 OCR + 一行 sample + 退出 0）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sense.ps1 -SelfTest 1 -OutDir "$env:TEMP\situation-selftest"
```

进程模型：前台进程、长驻、**stdout 只有 JSON 行**（诊断走 stderr，`-LogFile` 再落一份）。
宿主关掉管道后写 stdout 会失败，进程随即以 `bye reason=stdout-closed` 收尾并退出。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `OutDir` | 必填 | 输出目录，自动建 `frames\` 和 `_ocr.png` |
| `IntervalMs` | 1200 | 采样周期（下限 200） |
| `FrameMaxWidth` | 1280 | JPEG 缩放宽度（下限 320） |
| `JpegQuality` | 62 | JPEG 质量 |
| `Ocr` | 1 | 0 关闭 OCR |
| `Clipboard` | 0 | 1 读剪贴板文本（需 STA） |
| `IdleSkipSeconds` | 240 | 空闲超过该秒数就不截图/OCR |
| `FrameRetentionMinutes` | 30 | 帧保留时长，0 表示不按时间删 |
| `Hotkey` | `Ctrl+Alt+V` | 空或非法则不注册热键，传感器照常工作。宿主总是显式传 `-Hotkey`。`Ctrl+Alt+Space` 在常驻输入法的中文 Windows 上经常已被占用（Win32 1409） |
| `SelfTest` | 0 | 1 只跑一次然后退出 0 |
| `LogFile` | 空 | 额外把诊断写到该文件（扩展参数） |
| `OcrScale` | 2.0 | OCR 前放大倍数下限，见下文（扩展参数） |

## stdout 协议

每行一个 JSON 对象，其它什么都不能有。字段与 `CONTRACT.md` §1 一致，另外有几个**只增不改**的字段：

| 行 | 契约字段 | 附加字段 |
|---|---|---|
| `ready` | type protocol pid startedAt hotkey hotkeyOk hwnd ocr screen outDir | `dpi` |
| `sample` | type ts epoch app process pid title idleMs bounds changed score frame frameWidth frameHeight ocr clipboard | `capture`（用了哪条采集路径）、`force`、`paused`、`idle` |
| `hotkey` | type ts epoch id hwnd | — |
| `status` | type ts epoch paused capture ocr clipboard | — |
| `error` | type ts epoch message fatal | — |
| `bye` | type ts reason | — |

- `sample.ocr` 只在本次真跑了 OCR 时出现：`{lang, ms, text, hash}`。
- `sample.frame` 只在本次真写了 JPEG 时出现，值是 `frames/xxx.jpg`（正斜杠，相对 OutDir）。
- `clipboard` 一直存在，未变化/未开启时为 `null`，变化时是 ≤1200 字符的文本。
- `changed` 只表示“判定为画面变化”（窗口/进程/标题变了，或 dHash 距离 ≥ 6/64）；20 秒心跳
  写帧时 `changed` 可能是 `false` 但带 `frame`。
- `score` = 与**上一张写出的帧**相比变化的 dHash 位数占比（0..1，64 位）。
- `app` 是不带 `.exe` 的进程名，`process` 带 `.exe`。

## control.json（宿主写，传感器读）

`<OutDir>\control.json`，**按 mtime 热加载**，最多每 300 ms 检查一次；读取失败保留上一次的有效配置。

```json
{"paused":false,"capture":true,"ocr":true,"clipboard":false,"stop":false,"shotRequest":"2026-11-10T20:30:00.000Z"}
```

- `paused:true` → 不截图不 OCR，每 10 s 输出一条 `paused:true` 的轻量 sample。
- `stop:true` → 输出 `bye reason=control-stop` 并退出 0。
- `shotRequest` 变化 → 下一拍强制写帧，该 sample 带 `force:true`。
- `hotkey` 运行时忽略（宿主改热键要重启进程）。
- 四个开关（paused/capture/ocr/clipboard）任一变化都会输出一行 `status`。

注意：`control.json` 里有 `stop:true` 时，新起的进程会立刻退出。测试或重启前先删掉它
（`test-sensor.ps1` 每次启动前都会删）。

## 热键

- Win32 `RegisterHotKey`（带 `MOD_NOREPEAT`）+ 隐藏窗口 + 自建消息泵（`PeekMessage`/`DispatchMessage`，
  100 ms 循环里泵一次），`WM_HOTKEY (0x0312)` → 一行 `hotkey`。
- 窗口先按 **message-only**（parent = `HWND_MESSAGE`）建；失败再建隐藏顶层窗口。
- 语法：`Ctrl/Control`、`Alt`、`Shift`、`Win` 组合一个键；键名支持 `A-Z`、`0-9`、`F1-F24`、
  `Space Enter Tab Esc Backspace Delete Insert Home End PageUp PageDown Up Down Left Right`
  以及 `Minus Plus Comma Period Slash Semicolon Quote Backtick [ ] \`。
- **注册失败不会让进程退出**：输出 `error fatal=false`，`ready.hotkeyOk=false`，继续采样。
- `ready.hwnd` 是热键窗口句柄；即使注册失败窗口也会保留，所以测试仍可用
  `PostMessage(hwnd, 0x0312, 1, 0)` 打通 `hotkey` 这条路径。**`hotkeyOk` 才代表热键真的生效。**
- 在一台中文 Windows 11（输入法常驻）上观察过：`Ctrl+Alt+Space` 和 `Ctrl+Shift+Space`
  会被别的进程占用（Win32 错误 1409 `ERROR_HOTKEY_ALREADY_REGISTERED`）。因此进程默认热键是
  `Ctrl+Alt+V`（可以注册，`hotkeyOk:true`）。`Ctrl+Alt+F12`、`Ctrl+Alt+M/K`、`Alt+Space`、
  `Win+Alt+Space`、`Ctrl+Space` 在那台机器上也空闲。宿主应把热键做成可配置，并能容忍 `hotkeyOk:false`。
- **单键 `Space` = 长按说话（hold-to-talk）**，不走 `RegisterHotKey`（那会把系统的空格键一起吃
  掉）。实现：`Sit.HoldKey` 的 `WH_KEYBOARD_LL` 钩子跑在独立线程上（有自己的 `GetMessage` 泵，
  所以截图/OCR 的耗时不会拖慢键盘），按下即吞掉、抬起才补发一个空格：
  - 轻敲（< 350 ms）：抬起时用 `keybd_event` 补一个空格并带 `dwExtraInfo` 哨兵值，哨兵事件直接放行
    → 打字手感不变；
  - 按住 ≥ 350 ms：发 `hotkey id=start`；抬起发 `hotkey id=stop`（宿主按 toggle 处理即可）；
  - 只对 `Space` 生效；其它裸键只允许 `F1-F24`、`Pause`、`CapsLock`、`ScrollLock`，
    剩下的裸键会被拒绝（否则那个字符在所有程序里都会消失）。
  - 测试用环境变量 `SITUATION_HOLD_ACCEPT_INJECTED=1` 让钩子接受合成事件。
- **`B+Space`（组合键，可选）= 按住 B 再按空格说话**。宿主默认热键已改为 `Ctrl+Alt+V`（按一次开始、再按一次结束）。`ConvertFrom-HotkeySpec` 认出
  「单字符 + Space」就切到 chord 模式，`Install(triggerVk, leaderVk, armMs=200, holdMs)`。
  - 引子键（B）按下即被吞掉，抬起时若没组成 chord 就补发一个 `b` → 单独敲 B 仍是正常字母，
    长按 B 也不会丢字符；
  - B 按住 ≥ 200 ms（ArmMs）后按空格 → 立刻发 `hotkey id=start`，松开空格或松开 B 发
    `hotkey id=stop`；chord 期间两个键都不会进到前台程序；
  - B 还没到 200 ms 就按空格（快速打「b 空格」）不算 chord，两个字符照常输入；
  - 定时器只在钩子线程里跑，`Tick()` 在 chord 模式下不参与，避免主循环把 200 ms 窗口缩短。

## 桌面辅导时的整屏观察

`control.json` 的 `tutorId` 非空时，传感器不再按前台窗口裁剪，也没有定时截图，而是每次操作抓一张整屏：

- 前台窗口变化输出 `type=window`，并立刻截图。
- 只在这段时间安装 `Sit.ClickWatch`（`WH_MOUSE_LL`）和 `Sit.KeyWatch`（`WH_KEYBOARD_LL`）。点击和滚轮不拦截，输出 `type=click`（`left`/`right`/`middle`/`wheel-up`/`wheel-down`）。键盘钩子也不吞键：连续可打印字符合成一段，`type=keys phase=start` 时截一张，停顿约 0.7 秒后 `phase=end` 带上这段文字再截一张；Enter、Tab、Esc 和带 Ctrl/Alt/Win 的组合键是 `phase=action`，名称如 `Ctrl+C`，并立刻截图。
- `tutorId` 变回空字符串时两个钩子立刻 `Uninstall`，并再发一行 `type=tutor-watch, active=false, clickHook=false, keyHook=false`。
- 画面按较长边缩到 `-TutorFrameMaxEdge`（默认 1920）。与上一帧像素相同则发 `duplicate=true` 且不带 `jpeg`。JPEG 只放在 sample 里，**不写** `frames\`。
- 辅导进程的顶层窗口调用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，避免小人进入截图。多显示器覆盖 `SM_*VIRTUALSCREEN`。DSH 窗口不排除。

平时的前台窗口采样（下面一节）在 `tutorId` 为空时不变。

## 采集与变化判定

每个采样 tick 依次尝试：

1. `PrintWindow(hwnd, PW_RENDERFULLCONTENT=2)` — 目标窗口位图，最干净；
2. `PrintWindow(hwnd, 0)` — 老系统/老程序兜底；
3. `BitBlt` 前台窗口矩形（屏幕 DC，`SRCCOPY|CAPTUREBLT`） — 但会拍到压在上面的窗口；
4. `BitBlt` 整个虚拟屏 — 最后兜底，`bounds` 同时改成虚拟屏范围。

每一步都算一次 9×8 灰度 dHash；如果 `PrintWindow` 返回成功但整幅图**明暗差 ≤ 2**（典型是 UWP /
受保护 / GPU 合成窗口的黑图），就当成失败继续往下降级。`sample.capture` 记录最终用了哪条路径。

写帧条件：窗口/进程/标题变化、dHash 距离 ≥ 6/64、距上一帧 ≥ 20 s、`shotRequest` 强制。

DPI：启动第一步就调 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，失败依次退
`PER_MONITOR`、`SYSTEM`、`SetProcessDPIAware`、`SetProcessDpiAwareness(2)`；`ready.dpi` 报告实际拿到哪一档，
这样 `GetWindowRect`/`BitBlt` 都是物理像素。

## OCR

- 引擎链：`TryCreateFromUserProfileLanguages()` → `zh-Hans-CN` → `en-US`，全失败则关闭 OCR 并报非致命 error。
- 每帧只在新帧写出后跑一次，单线程内联，天然“不重叠、不排队”。
- 放大：契约要求宽度 <1100 px 时 1.4×。一次实测里，zh-Hans 引擎在 1280 px 上读拉丁字母很差，
  所以另加一个**放大下限** `-OcrScale`（默认 2.0，宽度上限 2600 px）。`-OcrScale 1` 就退化成纯契约行为。
- 文本组装：用 `OcrResult.Lines` 逐行拼接（该次实测的引擎 `OcrResult.Text` 会把换行吞掉），
  再按契约清洗：换行 → `; `、CJK/全角标点之间的空白删掉、连续空格压成一个、截断 1800 字符。
- `hash` = 清洗后文本的 SHA1（UTF-8，小写 hex）。

## 资源与磁盘

- 复用对象：截图画布、缩放画布、9×8 dHash 画布（+ 仅在需要放大时用的 OCR 画布），JPEG 编码器参数只建一次。
  同时在活的大位图最多 3 张（采集、缩放、OCR 临时），加一张 9×8 的小图；尺寸变化才重建。
- 保留策略：每 15 s 检查一次 `frames\`，删 `FrameRetentionMinutes` 之前的，且最多保留 400 个。
- 帧名 `yyyyMMdd-HHmmss-fff.jpg`（与契约示例一致），不会被两张同名覆盖。
- OCR 临时文件固定为 `<OutDir>\_ocr.png`，每帧覆盖，不参与保留策略。

## 实测（2026-11-10，1920×1080，Windows 11，zh-Hans-CN 引擎）

| 指标 | 数值 |
|---|---|
| tick 起点间隔（1200 ms 配置） | 平均 1198–1200 ms，sd 54–64 ms，min 1124–1128，max 1291–1298 |
| 每 tick 固定成本（截图 + dHash + 消息泵，不含 OCR/JPEG） | 约 20 ms（≈1.7% 单核 @1200 ms） |
| 稀疏画面 OCR（记事本、空白页） | 40–230 ms |
| 密集页面 OCR（浏览器排行榜页，1280×725 帧，2× 放大） | 400–900 ms，平均 ~330 ms、最大 701 ms；主要随文字量增长，与放大倍数只有 +15% 关系 |
| 单帧 JPEG（1280 宽，q62） | 27–67 KB，平均 43 KB |
| 60 s 常驻（屏幕持续变化） | CPU 6.6–8.5 s = **11–14% 单核**；50 样本 / 9–16 帧 / 0.49–0.70 MB；工作集 164–180 MB；**OCR 占 CPU 的 58%** |
| 60 s 常驻（屏幕基本不动） | 无新帧就不写盘不 OCR，只剩每 tick 约 20 ms 的截图判定（≈1.7% 单核，估算值） |

那次实测里 OCR 是唯一的大头，所以调优顺序是：先 `-OcrScale 1.4`（或 1）省 15–30%，再 `-IntervalMs 2000`
拉长周期，最后才是关 OCR。屏幕不动时这些都不跑。

## 已知限制

- **受保护窗口**：部分 UWP、提权窗口、DRM/游戏全屏会拒绝 `PrintWindow`，只能退到 `BitBlt` 屏幕矩形，
  此时截图包含压在上面的窗口内容；最坏是整屏。
- **多显示器混合 DPI**：虚拟屏范围取 `GetSystemMetrics(SM_*VIRTUALSCREEN)`，不同缩放比的显示器上
  这个值按主屏 DPI 折算，最后兜底的整屏截图可能偏移或裁边（窗口级截图不受影响）。
- **OCR 语言**：若只安装了 `zh-Hans-CN`（没有 `en-US`），纯英文界面识别质量一般；
  换机器或装上语言包后，引擎链会自动选更好的。
- **剪贴板**：需要 STA。`powershell.exe` 默认 STA；若被 `-Mta` 启动，剪贴板自动关闭并报非致命 error。
- **热键**：组合被占用时 `hotkeyOk:false`（见上文）。
- **每 tick 都会截图**：变化判定必须看图，所以截图是每拍固定成本；写盘和 OCR 才是被门控的部分。
- **空闲跳过**：`GetLastInputInfo` 只看键鼠，看视频/读屏会算空闲，此时只在 `idleMs` 超阈值后每 30 s 一条轻量 sample。

## 测试

```powershell
# 全量（约 90 s）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test-sensor.ps1

# 单阶段，1..5
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test-sensor.ps1 -Stage 1

# 换热键 / 换工作目录
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test-sensor.ps1 -Hotkey "Ctrl+Alt+F12" -WorkDir "$env:TEMP\situation-sensor-test"
```

五个阶段：

1. `-SelfTest 1`：exit 0、每行都能 `ConvertFrom-Json`、`ready` 完整、`sample.ocr.text` 非空、`hash` 是 40 位 hex、JPEG 能用 `Image.FromFile` 打开。
2. 常驻 15 s 并在两个窗口间来回切：≥5 条 sample、≥3 个不同 `app|title`、≥2 个不同 app、至少一次 OCR、最后一张帧能打开，并统计 tick 间隔抖动。
3. 热键：从 `ready.hwnd` 发 `PostMessage(0x0312,1,0)`，断言出现 `hotkey` 行且 `id=toggle`。
4. 控制文件：`paused:true` 后帧数不再增长且有 `paused:true` 的 sample；`stop:true` 后进程退出、出现 `bye reason=control-stop`。
5. 成本：跑 60 s，报 CPU 秒数、样本数、帧数、总字节、工作集。

退出码 0 = 全部通过。

## 与契约的偏差（都是加法，改回很容易）

1. **OCR 放大倍数**：契约只要求 <1100 px 时 1.4×。一次实测里，zh-Hans 引擎在 1280 px 读拉丁文本几乎不可用，
   1.4×/2× 能多读出 30–60% 的行，因此默认再叠一个 `OcrScale=2.0` 的放大下限（宽度上限 2600 px）。
   `-OcrScale 1` 即纯契约行为。多花的时间约 15%。
2. **OCR 文本来自 `OcrResult.Lines`**：该次实测的 `OcrResult.Text` 不含换行，直接用它会让
   “换行 → `; `”这条清洗规则失效、整页糊成一行。改用逐行拼接后再走同一套清洗。
3. **`hwnd` 在注册失败时也非 0**：窗口保留着，测试才能 `PostMessage`；`hotkeyOk` 才是权威。
4. **附加字段**：`ready.dpi`、`sample.capture`。都是只增不改，宿主忽略即可。
5. **`paused` / `idle` 轻量 sample**：契约说“只给 idleMs”，实际还带了 app/title/process/pid/bounds，
   便于宿主在没有帧的情况下也能显示当前窗口。
6. **扩展参数**：`-LogFile`、`-OcrScale`，默认值等于契约行为。
7. **`changed` 与心跳**：20 s 心跳写帧时 `changed` 可能为 `false` 而仍带 `frame`；这是契约
   “窗口/进程变化 or dHash≥6 or 20 s 心跳”三条独立条件的直接结果。
8. **默认热键 `Ctrl+Alt+V`**：与宿主和 `CONTRACT.md` 一致。`Ctrl+Alt+Space` 在常驻输入法的中文 Windows 上经常返回 1409（`ERROR_HOTKEY_ALREADY_REGISTERED`）。宿主始终显式传 `-Hotkey`。
9. **相同画面不重复 OCR**：若某帧的 64 位 dHash 与上一次已 OCR 的帧完全相同（心跳帧、窗口来回切回
   同一画面），跳过引擎调用——像素相同则文本必然相同，省下每帧约 0.4 s。`-SelfTest` 强制 OCR。
