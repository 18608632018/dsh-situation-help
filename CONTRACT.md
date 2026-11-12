# Situation plugin — build contract (v1)

A DSH plugin that gives the agent a continuous, low-cost sense of what the user is doing:
foreground window + activity log + screen text (Windows OCR) + on-demand screenshots,
plus a global hotkey that toggles voice input and inserts the transcript into the composer.

One long-lived helper process, change-gated capture, window-cropped OCR,
bounded ring buffers, no per-sample process spawn, no VLM call in the hot path.

Bundle id `@local/situation`. Paths below are relative to this plugin directory.

## Files and ownership

| Path | Owner | Purpose |
|---|---|---|
| `CONTRACT.md` | Lead | this file |
| `index.js` | Lead | host plugin: sensor supervisor, store, routes, tools, context injection |
| `client.js` | client-eng | Web UI: sidebar page, dock mic button, SSE listener, recording + transcript insertion |
| `locale/zh.json`, `locale/en.json` | client-eng | display metadata and UI dictionary |
| `sensor/sense.ps1` | sensor-eng | Windows sensor + global hotkey helper |
| `sensor/README.md` | sensor-eng | usage, limits, test steps |
| `package.json`, `cordis.patch.yml`, `icon.svg`, `README.md` | Lead | bundle manifest and docs |

Do not edit files outside your ownership. Read `CONTRACT.md` before starting.

## 1. Sensor process contract (`sensor/sense.ps1`)

Must run under **Windows PowerShell 5.1** (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`),
because Windows.Media.Ocr/WinRT is used. PowerShell 7 cannot load WinRT types.

### Command line

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sense.ps1 `
  -OutDir <dir> -IntervalMs 1200 -FrameMaxWidth 1280 -JpegQuality 62 `
  -Ocr 1 -Clipboard 0 -IdleSkipSeconds 240 -FrameRetentionMinutes 30 `
  -Hotkey "Ctrl+Alt+V" -SelfTest 0
```

- `OutDir` always exists; create `frames` below it.
- `-SelfTest 1`: capture once, run OCR once, print the sample JSON, exit 0. Used by tests.
- Unknown or empty `-Hotkey` => no hotkey, `hotkeyOk:false`, sensor keeps working.

### stdout protocol

UTF-8 JSON, one object per line, no other stdout output. Set
`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)` first.
All timestamps ISO-8601 with local offset, plus `epoch` in milliseconds.

```json
{"type":"ready","protocol":1,"pid":123,"startedAt":"...","hotkey":"Ctrl+Alt+V","hotkeyOk":true,"hwnd":123456,"ocr":"zh-Hans-CN","screen":{"width":1920,"height":1080},"outDir":"..."}
{"type":"sample","ts":"...","epoch":1760000000000,"app":"Code","process":"Code.exe","pid":4242,"title":"client.js — situation-plugin","idleMs":800,"bounds":[0,0,1920,1080],"changed":true,"score":0.31,"frame":"frames/20261110-203000-123.jpg","frameWidth":1280,"frameHeight":720,"ocr":{"lang":"zh-Hans-CN","ms":280,"text":"...","hash":"9f2a..."},"clipboard":null}
{"type":"hotkey","ts":"...","epoch":1760000000000,"id":"toggle","hwnd":123456}
{"type":"status","ts":"...","paused":true,"capture":true,"ocr":true,"clipboard":false}
{"type":"error","ts":"...","message":"...","fatal":false}
{"type":"bye","ts":"...","reason":"control-stop"}
```

- `sample.ocr` is omitted when OCR did not run on this tick. `sample.frame` is omitted when no frame was written.
- `ocr.text` cleaned: newlines -> `; `, CJK inter-character spaces removed, collapsed spaces, max 1800 chars.
  `ocr.hash` = SHA1 of the cleaned text.
- `clipboard`: only present when clipboard capture is on and the text changed; max 1200 chars.
- `changed` = scene changed vs previous tick; `score` = 0..1 share of changed dHash bits (64-bit dHash of a 9x8 grayscale).
- `app` is the process base name without `.exe`; `process` keeps `.exe`.

### Sampling algorithm (performance is the point)

- Loop granularity 100 ms: pump hotkey messages, read control changes (mtime), sample every `IntervalMs`.
- Skip capture/OCR when idle (`GetLastInputInfo` > `IdleSkipSeconds`); emit a lightweight sample every 30 s with `idleMs` only.
- Capture: `PrintWindow` or `BitBlt` of the **foreground window rect** (fallback full virtual screen), scaled to
  `FrameMaxWidth` before JPEG encode (System.Drawing). One GDI bitmap reused per process where practical.
- Write a JPEG only when: window/process changed, or dHash distance >= 6/64, or 20 s since last frame.
- OCR: only when a frame was written and OCR is enabled; crop already to the window; upscale 1.4x when width < 1100;
  rate limit one OCR per `IntervalMs` and never queue more than one.
- Frame retention: delete frames older than `FrameRetentionMinutes`, keep at most 400 files.
- Never spawn another PowerShell process per sample. Use one process for everything.
- Memory: reuse buffers; do not keep more than 2 bitmaps alive.

### Control file (host writes, sensor reads)

`<OutDir>\control.json`, re-read when mtime changes (at most every 300 ms):

```json
{"paused":false,"capture":true,"ocr":true,"clipboard":false,"stop":false,"shotRequest":"2026-11-10T20:30:00.000Z","hotkey":"Ctrl+Alt+V"}
```

- `paused:true` -> no capture/OCR, still emit a sample every 10 s with `paused:true`.
- `shotRequest` changed -> force one frame on the next tick even if unchanged (`force:true` in that sample).
- `stop:true` -> emit `bye` with `reason:"control-stop"` and exit.
- Changing `hotkey` while running may be ignored; host restarts the sensor for that.

### Hotkey

- Win32 `RegisterHotKey` on a hidden message-only window; `WM_HOTKEY` -> emit `hotkey` line.
- Default `Ctrl+Alt+V`; modifiers Alt=1, Ctrl=2, Shift=4, Win=8; support `A-Z`, `0-9`, `F1-F24`, `Space`, `Enter`,
  `Tab`, `Esc`, `Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `Up`, `Down`, `Left`, `Right`.
- Print `hwnd` in `ready` so tests can `PostMessage(hwnd, 0x0312 /* WM_HOTKEY */, 1, 0)`.
- Registration failure must not kill the sensor; emit `error` with `fatal:false` and keep sampling.

### OCR

OCR uses the WinRT `Windows.Media.Ocr` engine via the Await/AsTask pattern in `sensor/sense.ps1`. If
`OcrEngine.TryCreateFromUserProfileLanguages()` returns null, try `TryCreateFromLanguage(new Windows.Globalization.Language("zh-Hans-CN"))`,
then `en-US`; else disable OCR and report `ocr:null` + a non-fatal error.

### Verification the sensor-eng must run and report

1. `-SelfTest 1` -> valid `ready` + `sample` JSON with a real `ocr.text`.
2. Start normally for ~15 s with window switching; capture stdout to a file; show 3+ `sample` lines with different `app`
   and at least one `frame` file that opens as JPEG.
3. Hotkey: `PostMessage` WM_HOTKEY to `ready.hwnd` and show the emitted `hotkey` line.
4. Control: write `{"paused":true,...}` -> samples stop capturing; `stop:true` -> process exits with `bye`.
5. Report captured CPU time over 60 s (`Get-Process`), frame count and total bytes.

## 2. Host routes (`index.js`, same-origin, prefix `/situation`)

All JSON unless noted. Errors: HTTP 4xx/5xx with `{ok:false,error}`.

- `GET /situation/state` -> state object (below).
- `GET /situation/events` -> `text/event-stream`; named events `state`, `sample`, `hotkey`, `transcript`;
  `data:` is one JSON object; heartbeat comment `:\n\n` every 15 s; closes cleanly on request abort.
- `GET /situation/frame/<name>` -> `image/jpeg` only for `frames/[A-Za-z0-9._-]+\.jpg`; 404 otherwise; `cache-control: no-store`.
- `GET /situation/log?minutes=30&limit=120&app=code` -> `{ok,events:[...]}` newest last, bounded.
- `POST /situation/control` body `{paused?,capture?,ocr?,clipboard?,hotkey?}` -> `{ok,state}`; persists overrides to
  `<dataDir>/settings.json`; `hotkey` restarts the sensor.
- `POST /situation/transcribe` raw `audio/wav` body (<= 25 MB) -> `{ok:true,text,ms,provider}` or `{ok:false,error}`.
- `POST /situation/shot` -> requests an immediate frame, returns `{ok,frame,ts}` after up to 4 s or the latest frame.

### State object

```json
{
  "ok": true,
  "sensor": {"running":true,"ready":true,"pid":123,"hotkey":"Ctrl+Alt+V","hotkeyOk":true,
             "ocr":"zh-Hans-CN","startedAt":"...","restarts":0,"lastError":""},
  "control": {"paused":false,"capture":true,"ocr":true,"clipboard":false},
  "current": {"app":"Code","process":"Code.exe","title":"...","idleMs":800,"since":"...","bounds":[0,0,1920,1080]},
  "latest": {"ts":"...","app":"Code","frame":"/situation/frame/20261110-203000-123.jpg","ocrText":"..."},
  "recent": [{"ts":"...","kind":"window|sample|hotkey","app":"Code","title":"...","text":"..."}],
  "counters": {"samples":0,"frames":0,"ocrs":0,"drops":0},
  "speech": {"available":true,"provider":"sensevoice","ready":true},
  "errors": [],
  "dataDir": "C:\\Users\\<user>\\.dsh\\situation",
  "version": 1
}
```

## 3. Tools exposed to the agent

`ctx.tools.register` with object schemas. Names and required fields:

- `situation` — `{action: "now"|"recent"|"log", minutes?: number, limit?: number, app?: string}`
  returns `{summary, app, title, idleSeconds, ocrText, framePath, events: [{time, app, title, text}], running, paused}`.
- `situation_log` — `{minutes?: number, limit?: number, app?: string}` returns `{summary, count, lines: string[]}`.
- `situation_frame` — `{fresh?: boolean}` returns `{summary, path, ts, app, title}`; the path is a real file usable with `read_image`.
- `situation_control` — `{action: "pause"|"resume"|"start"|"stop"|"capture_on"|"capture_off"|"clipboard_on"|"clipboard_off"|"hotkey", hotkey?: string}`
  returns `{ok, summary}`.

The tool descriptions must tell the model when to use them: before answering questions about what the user is
looking at / what they just did / "帮我看看这个", and after the user says "看我的屏幕".

## 4. Auto context injection

While an agent is `running`, inject at most every `autoContextSeconds` (default 60) and on app/title change
(debounced 5 s) a single user-role text block, prefixed `[现场感知]`, at most 400 chars, through `agent.inject`.
Respect `autoContext:false` in config. Never inject into idle agents.

Static system-prompt section instructs the model to call `situation` when the user refers to the screen, and says
the data is local and may be stale by up to one sampling interval.

## 5. Client contract (`client.js`)

Register:

- `sidebar.panellist` id `situation`, order 21, label + eye icon -> opens the page.
- `main` key `situation` -> the page component.
- `conversation.composer.dock` -> a small mic button component. It receives props `{inputActions}` (see
  `dsh-client-ui-conversation` composer dock registration). Store `inputActions` + session id in a module-level
  registry so the hotkey and the page can use the active session's composer.

Behavior:

- EventSource `/situation/events`: on `hotkey` -> toggle recording for the active composer; on `state` -> refresh UI badges.
- Recording: `getUserMedia({audio:true})` -> MediaRecorder -> decode -> resample to mono 16 kHz PCM16 WAV ->
  `POST /situation/transcribe` (content-type `audio/wav`). Show level meter while recording. Cancel on Escape.
- On transcript: `inputActions.captureInsertion()` then `inputActions.insertText(text, span)`; if false, re-capture once;
  optional auto-send via `inputActions.submit()` when the page toggle is on.
- Page sections: status (sensor/hotkey/OCR/speech), current window, latest frame `<img src="/situation/frame/...">`,
  OCR text (scrollable, preserve whitespace), recent timeline, controls (pause/capture/OCR/clipboard toggles,
  hotkey text field + save, "test voice" mic button), error list.
- Style with `--dsw-alias-*` tokens only.
- No imports besides `react`; no `@deepseek-ai/*` requires. Plain `React.createElement` (no JSX build step).
- All visible strings through the local dictionary `NS = 'situation'`, zh + en.

## 6. Acceptance

- `plugin_manager install_bundle` succeeds; `list_plugins` shows `@local/situation` active.
- `GET /situation/state` returns a live snapshot with `sensor.ready:true`.
- Moving between two windows produces new `recent` entries within ~2 s and a fresh JPEG.
- Posting a small WAV to `/situation/transcribe` returns text (SenseVoice model already cached).
- `situation` tool returns a summary with OCR text; `situation_frame` returns a path that `read_image` can open.
- Hotkey event reaches the page (SSE) and the mic button toggles recording.
- Panel renders in the sidebar; restart DSH keeps everything working.

## 7. Desktop tutor

Clicking 开始辅导 starts observation immediately. There is no window picker and no "follow the foreground window" step. The model and reasoning effort are the ones selected in that conversation at click time; the host validates them and fills a default effort when the client omits it.

While tutoring is active the sensor watches the whole virtual desktop. Capture is action-triggered only; there is no timer.

- Window switches: time, process name, window title, then one full-screen frame.
- Pointer: every left, right, middle click and every wheel notch, with time, screen coordinates, and the top-level window under the pointer, then one frame. No click throttle.
- Keyboard: a `WH_KEYBOARD_LL` hook is installed only for the tutor session. Printable keys form one typing segment (a frame when it starts, another about 0.7 s after it pauses) and the characters are kept in the timeline. Enter, Tab, Esc and shortcuts are separate actions and are named (`Ctrl+C`), not treated as typed prose. The hook does not swallow keys.
- Both hooks uninstall as soon as `tutorId` is cleared. Ending tutoring also drops the in-memory buffer.
- Frames are scaled so the long edge is `tutorFrameMaxEdge` (default 1920). An identical bitmap is not stored again. JPEGs stay in memory, capped around 200 MB by dropping the oldest image bytes first, and are not written under `frames\`. The tutor overlay is excluded with `WDA_EXCLUDEFROMCAPTURE`. The DSH window is captured like any other window.

A question is sent only after local speech-to-text returns text. The text timeline is the whole session in order; if it is very long, older lines keep their order but shorten the OCR excerpt. Vision models receive every distinct keyframe. When that exceeds the model's per-request image count or byte limit, the frames are read in time order as batches: earlier batches are pre-read, the bubble shows `正在读取画面 i/n`, and the last batch is sent with the user's question. If the total cannot fit in context, or a batch call fails, earlier frames become an OCR-and-action summary and the bubble says how many frames were summarized. Silence and idle produce no model call.

The default hotkey is `Ctrl+Alt+V` (press once to start recording, press again to send). A configured hold chord such as `B+Space` still means press-and-hold. The panel can change the binding.
