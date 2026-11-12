window.__ModuleLoader__.load({
  id: '@local/situation',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    const NS = 'situation'
    const PANEL_ID = 'situation'
    const DOCK_ID = 'situation-mic'

    const ROUTES = {
      state: '/situation/state',
      events: '/situation/events',
      control: '/situation/control',
      tutor: '/situation/tutor',
      transcribe: '/situation/transcribe',
      frame: '/situation/frame/',
    }

    const POLL_MS = 2000
    const RECONNECT_MS = 3000
    const IDLE_RESET_MS = 2600
    const MAX_RECORD_MS = 120000
    const MAX_AUDIO_BYTES = 24 * 1024 * 1024
    const TARGET_RATE = 16000
    const AUTO_SEND_KEY = 'situation.autoSend'

    // ---------------------------------------------------------------- dictionary

    const DICT = {
      zh: {
        panel: '现场感知',
        title: '现场感知',
        subtitle: '持续感知前台窗口、屏幕文字与语音输入',
        refresh: '刷新',
        'status.loading': '正在读取状态…',
        'status.running': '感知运行中',
        'status.paused': '已暂停',
        'status.stopped': '感知未运行',
        'status.degraded': '运行中（有错误）',
        'status.starting': '启动中',
        'section.window': '当前窗口',
        'section.frame': '最新画面',
        'section.ocr': '屏幕文字',
        'section.recent': '最近的记录',
        'section.controls': '控制',
        'section.voice': '语音',
        'section.errors': '错误',
        'section.counters': '计数',
        'label.app': '应用',
        'label.title': '标题',
        'label.idle': '空闲',
        'label.hotkey': '热键',
        'label.pid': '进程号',
        'label.process': '进程',
        'label.since': '自',
        'label.ocrLang': '识别语言',
        'label.speech': '转写引擎',
        'label.dataDir': '数据目录',
        'value.unknown': '—',
        'frame.empty': '还没有画面',
        'ocr.empty': '没有识别到的文字',
        'recent.empty': '还没有记录',
        'control.pause': '暂停',
        'control.resume': '继续',
        'control.capture': '截图采集',
        'control.ocr': '文字识别',
        'control.clipboard': '剪贴板',
        'control.on': '开',
        'control.off': '关',
        'control.hotkeyPlaceholder': '例如 Ctrl+Alt+V',
        'control.saveHotkey': '保存热键',
        'control.saving': '保存中…',
        'control.saved': '已保存',
        'tutor.start': '开始辅导',
        'tutor.stop': '结束辅导',
        'tutor.loading': '正在打开…',
        'tutor.confirm': '正在观察整个屏幕。',
        'tutor.chooseModelInChat': '请先在对话输入框里选一个可用模型。',
        'tutor.modelChanging': '模型正在切换，请稍后再开始辅导。',
        'tutor.firstText': '首段回复',
        'control.saveFailed': '保存失败',
        'control.hotkeyHint': '保存后感知进程会重启以重新绑定热键。',
        'voice.record': '录制语音',
        'voice.stop': '停止录制',
        'voice.autoSend': '插入后自动发送',
        'voice.available': '转写可用',
        'voice.unavailable': '转写不可用',
        'voice.preparing': '转写模型准备中',
        'voice.last': '最近转写',
        'phase.requesting': '等待麦克风…',
        'phase.recording': '录音中',
        'phase.transcribing': '转写中…',
        'phase.inserted': '已插入',
        'err.mic': '麦克风不可用',
        'err.permission': '麦克风权限被拒绝',
        'err.deviceMissing': '没有可用的麦克风',
        'err.unsupported': '浏览器不支持录音',
        'err.empty': '没有录到声音',
        'err.tooLarge': '录音过长',
        'err.transcribe': '转写失败',
        'err.noComposer': '没有可插入的输入框',
        'err.conflict': '输入框已变化，请重试',
        'mic.dictate': '语音输入',
        'mic.stop': '停止并转写',
        'events.open': '事件流已连接',
        'events.connecting': '事件流连接中',
        'events.reconnecting': '事件流重连中',
        'events.unsupported': '事件流不可用',
        'state.loadFailed': '读取状态失败',
        'counter.samples': '采样',
        'counter.frames': '画面',
        'counter.ocrs': '识别',
        'counter.drops': '丢弃',
        'counter.hotkeys': '热键',
        'counter.transcripts': '转写',
      },
      en: {
        panel: 'Situational awareness',
        title: 'Situational awareness',
        subtitle: 'Continuous desktop sensing: foreground window, screen text and voice input',
        refresh: 'Refresh',
        'status.loading': 'Reading state…',
        'status.running': 'Sensor running',
        'status.paused': 'Paused',
        'status.stopped': 'Sensor stopped',
        'status.degraded': 'Running with errors',
        'status.starting': 'Starting',
        'section.window': 'Current window',
        'section.frame': 'Latest frame',
        'section.ocr': 'Screen text',
        'section.recent': 'Recent timeline',
        'section.controls': 'Controls',
        'section.voice': 'Voice',
        'section.errors': 'Errors',
        'section.counters': 'Counters',
        'label.app': 'App',
        'label.title': 'Title',
        'label.idle': 'idle',
        'label.hotkey': 'Hotkey',
        'label.pid': 'PID',
        'label.process': 'Process',
        'label.since': 'since',
        'label.ocrLang': 'OCR language',
        'label.speech': 'Transcription engine',
        'label.dataDir': 'Data directory',
        'value.unknown': '—',
        'frame.empty': 'No frame yet',
        'ocr.empty': 'No recognised text',
        'recent.empty': 'No events yet',
        'control.pause': 'Pause',
        'control.resume': 'Resume',
        'control.capture': 'Frame capture',
        'control.ocr': 'Text recognition',
        'control.clipboard': 'Clipboard',
        'control.on': 'on',
        'control.off': 'off',
        'control.hotkeyPlaceholder': 'e.g. Ctrl+Alt+V',
        'control.saveHotkey': 'Save hotkey',
        'control.saving': 'Saving…',
        'control.saved': 'Saved',
        'tutor.start': 'Start desktop tutor',
        'tutor.stop': 'Stop desktop tutor',
        'tutor.loading': 'Opening…',
        'tutor.confirm': 'Watching the whole screen.',
        'tutor.chooseModelInChat': 'Select an available model in the chat composer first.',
        'tutor.modelChanging': 'Wait for the model change to finish before starting tutoring.',
        'tutor.firstText': 'First response',
        'control.saveFailed': 'Save failed',
        'control.hotkeyHint': 'Saving restarts the sensor to rebind the hotkey.',
        'voice.record': 'Record voice',
        'voice.stop': 'Stop recording',
        'voice.autoSend': 'Send after insert',
        'voice.available': 'Transcription ready',
        'voice.unavailable': 'Transcription unavailable',
        'voice.preparing': 'Preparing model',
        'voice.last': 'Last transcript',
        'phase.requesting': 'Waiting for microphone…',
        'phase.recording': 'Recording',
        'phase.transcribing': 'Transcribing…',
        'phase.inserted': 'Inserted',
        'err.mic': 'Microphone unavailable',
        'err.permission': 'Microphone permission denied',
        'err.deviceMissing': 'No microphone found',
        'err.unsupported': 'Recording is not supported',
        'err.empty': 'Nothing recorded',
        'err.tooLarge': 'Recording too large',
        'err.transcribe': 'Transcription failed',
        'err.noComposer': 'No composer to insert into',
        'err.conflict': 'Composer changed, try again',
        'mic.dictate': 'Voice input',
        'mic.stop': 'Stop and transcribe',
        'events.open': 'Event stream connected',
        'events.connecting': 'Event stream connecting',
        'events.reconnecting': 'Event stream reconnecting',
        'events.unsupported': 'Event stream unavailable',
        'state.loadFailed': 'Failed to read state',
        'counter.samples': 'samples',
        'counter.frames': 'frames',
        'counter.ocrs': 'ocr',
        'counter.drops': 'drops',
        'counter.hotkeys': 'hotkeys',
        'counter.transcripts': 'transcripts',
      },
    }

    // ---------------------------------------------------------------- palette

    const palette = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    // ---------------------------------------------------------------- small utilities

    function formatTemplate(template, params) {
      if (params === undefined || params === null) return template
      return String(template).replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] === undefined ? match : String(params[name])
      })
    }

    function preferredLanguage() {
      try {
        const raw = typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string' ? navigator.language : 'en'
        return raw.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (error) {
        return 'en'
      }
    }

    function describeError(error) {
      if (error === undefined || error === null) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      try {
        return String(error)
      } catch (nested) {
        return ''
      }
    }

    function formatClock(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (isNaN(date.getTime())) return value.length >= 19 ? value.slice(11, 19) : value
      const pad = (number) => (number < 10 ? '0' + number : String(number))
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function formatIdle(milliseconds) {
      const value = typeof milliseconds === 'number' && isFinite(milliseconds) ? Math.max(0, milliseconds) : 0
      const seconds = Math.round(value / 1000)
      if (seconds < 60) return seconds + 's'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + 'm' + (seconds % 60 ? ' ' + (seconds % 60) + 's' : '')
      const hours = Math.floor(minutes / 60)
      return hours + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '')
    }

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: function () {
          return value
        },
        set: function (next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of Array.from(listeners)) {
            try {
              listener(value)
            } catch (error) {
              /* a broken subscriber must not break the producer */
            }
          }
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
      }
    }

    function useStore(store) {
      const [value, setValue] = React.useState(() => store.get())
      React.useEffect(() => store.subscribe(setValue), [store])
      return value
    }

    function errText(entry) {
      if (typeof entry === 'string') return entry
      const described = describeError(entry)
      if (described !== '') return described
      try {
        return JSON.stringify(entry)
      } catch (error) {
        return ''
      }
    }

    // ---------------------------------------------------------------- stores

    const stateStore = createStore(null)
    const connectionStore = createStore({ phase: 'loading', error: '' })
    const hubStore = createStore({ phase: 'idle', lastEventAt: 0 })

    // ---------------------------------------------------------------- host routes

    let statePromise = null

    function refreshState() {
      if (statePromise) return statePromise
      const run = (async function () {
        try {
          const response = await fetch(ROUTES.state, { headers: { accept: 'application/json' } })
          if (!response || response.ok !== true) throw new Error('HTTP ' + (response ? response.status : '?'))
          const payload = await response.json()
          if (!payload || typeof payload !== 'object') throw new Error('invalid state payload')
          stateStore.set(payload)
          connectionStore.set({ phase: 'ready', error: '' })
          return payload
        } catch (error) {
          connectionStore.set({ phase: 'error', error: describeError(error) })
          return null
        } finally {
          statePromise = null
        }
      })()
      statePromise = run
      return run
    }

    async function readJson(response) {
      if (!response || typeof response.json !== 'function') return null
      try {
        return await response.json()
      } catch (error) {
        return null
      }
    }

    async function postControl(patch) {
      const response = await fetch(ROUTES.control, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await readJson(response)
      if (!response || response.ok !== true) {
        throw new Error(
          payload && typeof payload.error === 'string' && payload.error !== ''
            ? payload.error
            : 'HTTP ' + (response ? response.status : '?'),
        )
      }
      if (payload && payload.state && typeof payload.state === 'object') {
        stateStore.set(payload.state)
        connectionStore.set({ phase: 'ready', error: '' })
      } else {
        refreshState()
      }
      return payload
    }

    async function tutorRequest(action, selection) {
      const response = await fetch(ROUTES.tutor, {
        method: 'POST', headers: { 'x-situation-tutor': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ action, selection }),
      })
      const payload = await readJson(response)
      if (!response.ok || !payload) throw new Error(payload?.error || `HTTP ${response.status}`)
      if (payload.state) stateStore.set(payload.state)
      return payload
    }

    async function postTranscribe(bytes) {
      const response = await fetch(ROUTES.transcribe, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: bytes,
      })
      const payload = await readJson(response)
      if (payload && typeof payload === 'object') return payload
      throw new Error('HTTP ' + (response ? response.status : '?'))
    }

    // ---------------------------------------------------------------- auto-send preference

    function readAutoSend() {
      try {
        return localStorage.getItem(AUTO_SEND_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    function writeAutoSend(value) {
      try {
        localStorage.setItem(AUTO_SEND_KEY, value ? '1' : '0')
      } catch (error) {
        /* private mode: the toggle stays session-only */
      }
    }

    // ---------------------------------------------------------------- composer registry

    const composers = new Map()
    let composerSeq = 0
    let preferredComposer = null

    function registerComposer(sessionId, inputActions) {
      const key = sessionId === null || sessionId === undefined ? 'anonymous' : String(sessionId)
      composerSeq += 1
      const entry = { key: key, sessionId: sessionId, inputActions: inputActions || null, seq: composerSeq }
      composers.set(key, entry)
      preferredComposer = key
      return entry
    }

    function unregisterComposer(entry) {
      if (!entry) return
      if (composers.get(entry.key) === entry) composers.delete(entry.key)
      if (preferredComposer === entry.key) preferredComposer = null
    }

    function activeComposer() {
      if (preferredComposer !== null && composers.has(preferredComposer)) return composers.get(preferredComposer)
      let best = null
      for (const entry of composers.values()) {
        if (best === null || entry.seq > best.seq) best = entry
      }
      return best
    }

    /** Write into the composer the user can see, for the window before any session
     *  composer has registered (a brand-new conversation has no session yet). */
    function insertIntoVisibleComposer(text) {
      const doc = typeof document !== 'undefined' ? document : null
      if (!doc || typeof doc.querySelectorAll !== 'function') return false
      const isTextField = (el) => {
        if (!el || el.disabled === true || el.readOnly === true) return false
        const tag = String(el.tagName || '').toLowerCase()
        if (tag === 'textarea') return true
        if (tag === 'input') return el.type === 'text' || el.type === '' || el.type === 'search'
        return el.isContentEditable === true || el.getAttribute('role') === 'textbox'
      }
      const visible = (el) => {
        if (typeof el.getBoundingClientRect !== 'function') return true
        const box = el.getBoundingClientRect()
        return box.width > 0 && box.height > 0
      }
      const focused = doc.activeElement
      let target = isTextField(focused) && visible(focused) ? focused : null
      if (target === null) {
        let widest = 0
        for (const el of Array.from(doc.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]'))) {
          if (!isTextField(el) || !visible(el)) continue
          const width = el.getBoundingClientRect().width
          if (width >= widest) {
            widest = width
            target = el
          }
        }
      }
      if (target === null) return false
      try {
        target.focus()
        const tag = String(target.tagName || '').toLowerCase()
        if (tag === 'textarea' || tag === 'input') {
          const ctor = tag === 'textarea' ? globalThis.HTMLTextAreaElement : globalThis.HTMLInputElement
          const proto = ctor && ctor.prototype ? ctor.prototype : null
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined
          const current = typeof target.value === 'string' ? target.value : ''
          const start = typeof target.selectionStart === 'number' ? target.selectionStart : current.length
          const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : current.length
          const next = current.slice(0, start) + text + current.slice(end)
          if (!descriptor || typeof descriptor.set !== 'function') target.value = next
          else descriptor.set.call(target, next)
          target.dispatchEvent(new Event('input', { bubbles: true }))
          const caret = start + text.length
          try {
            target.setSelectionRange(caret, caret)
          } catch (error) {
            /* some inputs have no selection API */
          }
          return true
        }
        return doc.execCommand('insertText', false, text) === true
      } catch (error) {
        return false
      }
    }

    // One dictation, at most one insertion: try the session composer, then the visible
    // one, then hold the text while a composer mounts (the moment a chat becomes real).
    let pendingTranscript = null
    let pendingTimer = 0
    const PENDING_DELIVERY_MS = 20000

    function tryDeliverTranscript(text) {
      const target = activeComposer()
      const actions = target && target.inputActions
      if (actions && typeof actions.insertText === 'function' && typeof actions.captureInsertion === 'function') {
        const attempt = () => {
          try {
            return actions.insertText(text, actions.captureInsertion()) === true
          } catch (error) {
            return false
          }
        }
        let inserted = attempt()
        if (!inserted) inserted = attempt()
        if (!inserted) return 'conflict'
        if (readAutoSend() && typeof actions.submit === 'function') {
          try {
            actions.submit()
          } catch (error) {
            /* a refused submit must not undo the insertion */
          }
        }
        return 'ok'
      }
      return insertIntoVisibleComposer(text) ? 'ok' : 'none'
    }

    function deliverTranscript(text) {
      const result = tryDeliverTranscript(text)
      if (result === 'ok') {
        recorder.settle({ phase: 'inserted', messageKey: '', message: '', level: 0, text: text })
        return true
      }
      if (result === 'conflict') {
        recorder.settle({ phase: 'error', messageKey: 'err.conflict', message: '', level: 0, text: text })
        return false
      }
      // 'none': the page has no composer yet (a brand-new conversation renders none).
      // Hold the dictation and insert it as soon as one appears, so the hotkey works
      // before the first message has been sent.
      pendingTranscript = text
      const deadline = Date.now() + PENDING_DELIVERY_MS
      if (pendingTimer) {
        clearTimeout(pendingTimer)
        pendingTimer = 0
      }
      const poll = () => {
        pendingTimer = 0
        const held = pendingTranscript
        if (held === null) return
        const again = tryDeliverTranscript(held)
        if (again === 'ok') {
          pendingTranscript = null
          recorder.settle({ phase: 'inserted', messageKey: '', message: '', level: 0, text: held })
          return
        }
        if (again === 'conflict' || Date.now() >= deadline) {
          pendingTranscript = null
          const key = again === 'conflict' ? 'err.conflict' : 'err.noComposer'
          recorder.settle({ phase: 'error', messageKey: key, message: '', level: 0, text: held })
          return
        }
        pendingTimer = setTimeout(poll, 250)
      }
      pendingTimer = setTimeout(poll, 250)
      return false
    }
    // ---------------------------------------------------------------- audio encoding

    function clampSample(value) {
      return Math.max(-1, Math.min(1, value))
    }

    /** Mono 16 kHz PCM16 WAV with the canonical 44-byte header. */
    function encodeWav(samples) {
      const count = samples.length
      const bytes = new Uint8Array(44 + count * 2)
      const view = new DataView(bytes.buffer)
      const writeText = (at, text) => {
        for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index) & 0xff
      }
      writeText(0, 'RIFF')
      view.setUint32(4, 36 + count * 2, true)
      writeText(8, 'WAVE')
      writeText(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, TARGET_RATE, true)
      view.setUint32(28, TARGET_RATE * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeText(36, 'data')
      view.setUint32(40, count * 2, true)
      for (let index = 0; index < count; index += 1) {
        const value = clampSample(samples[index])
        view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    /** Resample mono float samples; decimation low-passes, interpolation upsamples. */
    function resampleMono(samples, fromRate, toRate) {
      const length = samples.length
      if (length === 0) return new Float32Array(0)
      const from = typeof fromRate === 'number' && fromRate > 0 ? fromRate : TARGET_RATE
      const to = typeof toRate === 'number' && toRate > 0 ? toRate : TARGET_RATE
      if (from === to) return typeof samples.slice === 'function' ? samples.slice() : Float32Array.from(samples)
      const outLength = Math.max(1, Math.floor((length * to) / from))
      const out = new Float32Array(outLength)
      const step = from / to
      if (step >= 1.5) {
        const half = Math.max(0, Math.floor(Math.round(step) / 2))
        for (let index = 0; index < outLength; index += 1) {
          const center = Math.round(index * step)
          let sum = 0
          let count = 0
          for (let offset = center - half; offset <= center + half; offset += 1) {
            if (offset >= 0 && offset < length) {
              sum += samples[offset]
              count += 1
            }
          }
          out[index] = count > 0 ? sum / count : 0
        }
        return out
      }
      for (let index = 0; index < outLength; index += 1) {
        const position = index * step
        const low = Math.floor(position)
        const high = Math.min(low + 1, length - 1)
        const fraction = position - low
        out[index] = samples[low] + (samples[high] - samples[low]) * fraction
      }
      return out
    }

    /** Downmix every channel and resample to the 16 kHz mono the host accepts. */
    function toMono16k(buffer) {
      if (!buffer || typeof buffer.getChannelData !== 'function') return new Float32Array(0)
      const channels = Math.max(1, buffer.numberOfChannels || 1)
      const length = Math.max(0, buffer.length || 0)
      const mono = new Float32Array(length)
      for (let channel = 0; channel < channels; channel += 1) {
        const data = buffer.getChannelData(channel)
        for (let index = 0; index < length; index += 1) mono[index] += data[index] / channels
      }
      return resampleMono(mono, buffer.sampleRate || 48000, TARGET_RATE)
    }

    function stopTracks(stream) {
      if (!stream || typeof stream.getTracks !== 'function') return
      try {
        for (const track of stream.getTracks()) {
          try {
            track.stop()
          } catch (error) {
            /* an already-ended track throws on stop */
          }
        }
      } catch (error) {
        /* stream without tracks: nothing to release */
      }
    }

    function readLevel(entry) {
      const analyser = entry.analyser
      if (!analyser || typeof analyser.getFloatTimeDomainData !== 'function') return 0
      try {
        analyser.getFloatTimeDomainData(entry.samples)
      } catch (error) {
        return 0
      }
      let sum = 0
      for (let index = 0; index < entry.samples.length; index += 1) {
        const sample = entry.samples[index]
        sum += sample * sample
      }
      const rms = Math.sqrt(sum / entry.samples.length)
      return Math.min(1, rms * 6)
    }

    function microphoneKey(error) {
      const name = error && typeof error.name === 'string' ? error.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'err.permission'
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'err.deviceMissing'
      if (name === 'NotReadableError' || name === 'TrackStartError') return 'err.mic'
      return 'err.mic'
    }

    function recordingFailure(key) {
      const error = new Error(key)
      error.situationKey = key
      return error
    }

    // ---------------------------------------------------------------- recorder

    const recorder = (function createRecorder() {
      const listeners = new Set()
      let snapshot = { phase: 'idle', messageKey: '', message: '', level: 0, elapsedMs: 0, text: '' }
      let active = null
      let idleTimer = 0

      function publish(patch) {
        snapshot = Object.assign({}, snapshot, patch)
        for (const listener of Array.from(listeners)) {
          try {
            listener(snapshot)
          } catch (error) {
            /* a broken subscriber must not break the recorder */
          }
        }
      }

      function clearIdle() {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = 0
        }
      }

      function teardown(entry) {
        if (!entry) return
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = 0
        }
        if (entry.levelTimer) {
          clearInterval(entry.levelTimer)
          entry.levelTimer = 0
        }
        if (entry.recorder && entry.recorder.state === 'recording') {
          try {
            entry.recorder.stop()
          } catch (error) {
            /* already stopped */
          }
        }
        stopTracks(entry.stream)
        entry.stream = null
        const context = entry.context
        entry.context = null
        entry.analyser = null
        if (context && typeof context.close === 'function' && context.state !== 'closed') {
          try {
            const closing = context.close()
            if (closing && typeof closing.catch === 'function') closing.catch(() => {})
          } catch (error) {
            /* closing a suspended context can throw */
          }
        }
      }

      function stopRecorder(entry) {
        const handle = entry.recorder
        if (!handle) return Promise.resolve(null)
        return new Promise((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            resolve(new Blob(entry.chunks, { type: handle.mimeType || 'audio/webm' }))
          }
          handle.onstop = finish
          handle.onerror = finish
          try {
            if (handle.state === 'recording') handle.stop()
            else finish()
          } catch (error) {
            finish()
          }
        })
      }

      async function start() {
        if (active) return
        const phase = snapshot.phase
        if (phase === 'requesting' || phase === 'recording' || phase === 'transcribing') return
        const devices = typeof navigator !== 'undefined' && navigator ? navigator.mediaDevices : undefined
        if (!devices || typeof devices.getUserMedia !== 'function') {
          settle({ phase: 'error', messageKey: 'err.mic', message: '', level: 0 })
          return
        }
        if (typeof MediaRecorder !== 'function') {
          settle({ phase: 'error', messageKey: 'err.unsupported', message: '', level: 0 })
          return
        }
        const entry = {
          phase: 'requesting',
          chunks: [],
          stream: null,
          context: null,
          recorder: null,
          analyser: null,
          samples: new Float32Array(256),
          timer: 0,
          levelTimer: 0,
          startedAt: 0,
        }
        active = entry
        clearIdle()
        publish({ phase: 'requesting', messageKey: '', message: '', level: 0, elapsedMs: 0 })

        let stream = null
        try {
          stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        } catch (error) {
          if (active === entry) active = null
          settle({ phase: 'error', messageKey: microphoneKey(error), message: describeError(error), level: 0 })
          return
        }
        if (active !== entry) {
          stopTracks(stream)
          return
        }
        entry.stream = stream

        try {
          const Context =
            typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext)
              ? globalThis.AudioContext || globalThis.webkitAudioContext
              : null
          if (!Context) throw new Error('AudioContext unavailable')
          entry.context = new Context()
          entry.analyser = entry.context.createAnalyser()
          entry.analyser.fftSize = entry.samples.length
          const source = entry.context.createMediaStreamSource(stream)
          source.connect(entry.analyser)
        } catch (error) {
          active = null
          teardown(entry)
          settle({ phase: 'error', messageKey: 'err.unsupported', message: describeError(error), level: 0 })
          return
        }

        try {
          entry.recorder = new MediaRecorder(stream)
          entry.recorder.ondataavailable = (event) => {
            if (event && event.data && event.data.size > 0) entry.chunks.push(event.data)
          }
          entry.recorder.onerror = () => {
            if (active !== entry) return
            active = null
            teardown(entry)
            settle({ phase: 'error', messageKey: 'err.mic', message: '', level: 0 })
          }
          entry.recorder.start()
        } catch (error) {
          active = null
          teardown(entry)
          settle({ phase: 'error', messageKey: 'err.unsupported', message: describeError(error), level: 0 })
          return
        }

        entry.phase = 'recording'
        entry.startedAt = Date.now()
        entry.timer = setTimeout(() => {
          finish()
        }, MAX_RECORD_MS)
        entry.levelTimer = setInterval(() => {
          if (active !== entry) return
          publish({ level: readLevel(entry), elapsedMs: Date.now() - entry.startedAt })
        }, 120)
        publish({ phase: 'recording', messageKey: '', message: '', level: 0, elapsedMs: 0 })
      }

      async function finish() {
        const entry = active
        if (!entry) return
        if (entry.phase !== 'recording') {
          if (entry.phase === 'requesting') cancel()
          return
        }
        entry.phase = 'transcribing'
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = 0
        }
        if (entry.levelTimer) {
          clearInterval(entry.levelTimer)
          entry.levelTimer = 0
        }
        publish({ phase: 'transcribing', messageKey: '', message: '', level: 0 })
        try {
          const blob = await stopRecorder(entry)
          stopTracks(entry.stream)
          entry.stream = null
          if (!blob || blob.size === 0) throw recordingFailure('err.empty')
          const context = entry.context
          if (!context || typeof context.decodeAudioData !== 'function') throw recordingFailure('err.unsupported')
          const decoded = await context.decodeAudioData(await blob.arrayBuffer())
          const bytes = encodeWav(toMono16k(decoded))
          if (bytes.byteLength > MAX_AUDIO_BYTES) throw recordingFailure('err.tooLarge')
          const payload = await postTranscribe(bytes)
          if (!payload || payload.ok !== true) {
            settle({
              phase: 'error',
              messageKey: 'err.transcribe',
              message: payload && typeof payload.error === 'string' ? payload.error : '',
              level: 0,
            })
            return
          }
          const text = typeof payload.text === 'string' ? payload.text.trim() : ''
          if (text === '') {
            settle({ phase: 'error', messageKey: 'err.empty', message: '', level: 0 })
            return
          }
          deliverTranscript(text)
        } catch (error) {
          const key = error && error.situationKey ? error.situationKey : 'err.mic'
          settle({
            phase: 'error',
            messageKey: key,
            message: error && error.situationKey ? '' : describeError(error),
            level: 0,
          })
        } finally {
          if (active === entry) active = null
          teardown(entry)
        }
      }

      function settle(patch) {
        clearIdle()
        publish(patch)
        idleTimer = setTimeout(() => {
          idleTimer = 0
          const phase = snapshot.phase
          if (phase === 'recording' || phase === 'requesting' || phase === 'transcribing') return
          publish({ phase: 'idle', messageKey: '', message: '', level: 0, elapsedMs: 0 })
        }, IDLE_RESET_MS)
      }

      function cancel() {
        const entry = active
        active = null
        if (entry) teardown(entry)
        clearIdle()
        publish({ phase: 'idle', messageKey: '', message: '', level: 0, elapsedMs: 0 })
      }

      function toggle() {
        const phase = snapshot.phase
        if (phase === 'recording') {
          finish()
          return
        }
        if (phase === 'requesting') {
          cancel()
          return
        }
        if (phase === 'transcribing') return
        start()
      }

      function note(text) {
        if (typeof text !== 'string' || text === '') return
        publish({ text: text })
      }

      function dispose() {
        cancel()
        listeners.clear()
      }

      return {
        get: function () {
          return snapshot
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
        start: start,
        finish: finish,
        cancel: cancel,
        toggle: toggle,
        settle: settle,
        note: note,
        dispose: dispose,
      }
    })()

    function recorderStatusText(snapshot, t) {
      const phase = snapshot ? snapshot.phase : 'idle'
      if (phase === 'requesting') return t('phase.requesting')
      if (phase === 'recording') {
        const seconds = Math.max(0, Math.round((snapshot.elapsedMs || 0) / 1000))
        return t('phase.recording') + ' ' + seconds + 's'
      }
      if (phase === 'transcribing') return t('phase.transcribing')
      if (phase === 'inserted') return t('phase.inserted')
      if (phase === 'error') {
        const head = t(snapshot.messageKey || 'err.mic')
        return snapshot.message ? head + ' · ' + snapshot.message : head
      }
      return ''
    }

    // ---------------------------------------------------------------- event stream

    const hub = { source: null, timer: 0, stopped: false, escapeBound: false }

    function parseEventData(event) {
      if (!event || typeof event.data !== 'string') return null
      try {
        const payload = JSON.parse(event.data)
        return payload && typeof payload === 'object' ? payload : null
      } catch (error) {
        return null
      }
    }

    /** The host also pushes partial patches (e.g. `{errors}`), so merge anything that is not a full state. */
    function applyStateEvent(payload) {
      if (!payload || typeof payload !== 'object') return
      const next = payload.state && typeof payload.state === 'object' ? payload.state : payload
      if (!next || typeof next !== 'object') return
      const current = stateStore.get()
      const partial = next.sensor === undefined && next.control === undefined && !Array.isArray(next.recent)
      if (partial && current && typeof current === 'object') {
        stateStore.set(Object.assign({}, current, next))
        return
      }
      stateStore.set(next)
    }

    function applySampleEvent(sample) {
      if (!sample || typeof sample !== 'object') return
      const current = stateStore.get()
      if (!current || typeof current !== 'object') return
      const next = Object.assign({}, current)
      const nextCurrent = Object.assign({}, current.current || {})
      if (typeof sample.app === 'string') nextCurrent.app = sample.app
      if (typeof sample.title === 'string') nextCurrent.title = sample.title
      if (typeof sample.idleMs === 'number') nextCurrent.idleMs = sample.idleMs
      if (typeof sample.process === 'string') nextCurrent.process = sample.process
      next.current = nextCurrent
      if (sample.latest && typeof sample.latest === 'object') next.latest = sample.latest
      if (sample.counters && typeof sample.counters === 'object') next.counters = sample.counters
      next.lastSampleAt = sample.ts || next.lastSampleAt
      stateStore.set(next)
    }

    function onEvent(kind, event) {
      hubStore.set(Object.assign({}, hubStore.get(), { lastEventAt: Date.now() }))
      const payload = parseEventData(event)
      if (kind === 'state') {
        applyStateEvent(payload)
        return
      }
      if (kind === 'sample') {
        applySampleEvent(payload)
        return
      }
      if (kind === 'hotkey') {
        recorder.toggle()
        return
      }
      if (kind === 'transcript' && payload && typeof payload.text === 'string') {
        recorder.note(payload.text)
      }
    }

    function scheduleRetry() {
      if (hub.stopped || hub.timer) return
      hub.timer = setTimeout(() => {
        hub.timer = 0
        const current = hub.source
        if (current && current.readyState !== 2) return
        if (current) {
          try {
            current.close()
          } catch (error) {
            /* already closed */
          }
        }
        hub.source = null
        openEvents()
      }, RECONNECT_MS)
    }

    function openEvents() {
      hub.stopped = false
      if (hub.source) return
      const Ctor = typeof globalThis !== 'undefined' ? globalThis.EventSource : undefined
      if (typeof Ctor !== 'function') {
        hubStore.set({ phase: 'unsupported', lastEventAt: hubStore.get().lastEventAt })
        return
      }
      let source = null
      try {
        source = new Ctor(ROUTES.events)
      } catch (error) {
        hubStore.set({ phase: 'reconnecting', lastEventAt: hubStore.get().lastEventAt })
        scheduleRetry()
        return
      }
      hub.source = source
      hubStore.set({ phase: 'open', lastEventAt: hubStore.get().lastEventAt })
      source.addEventListener('open', () => {
        hubStore.set({ phase: 'open', lastEventAt: hubStore.get().lastEventAt })
      })
      source.addEventListener('error', () => {
        hubStore.set({ phase: 'reconnecting', lastEventAt: hubStore.get().lastEventAt })
        scheduleRetry()
      })
      for (const kind of ['state', 'sample', 'hotkey', 'transcript']) {
        source.addEventListener(kind, (event) => onEvent(kind, event))
      }
    }

    function disposeEvents() {
      hub.stopped = true
      if (hub.timer) {
        clearTimeout(hub.timer)
        hub.timer = 0
      }
      const source = hub.source
      hub.source = null
      if (source) {
        try {
          source.close()
        } catch (error) {
          /* already closed */
        }
      }
    }

    function handleEscape(event) {
      if (!event || event.key !== 'Escape') return
      const phase = recorder.get().phase
      if (phase === 'requesting' || phase === 'recording') {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        recorder.cancel()
      }
    }

    function installEscape() {
      if (hub.escapeBound) return
      if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return
      document.addEventListener('keydown', handleEscape)
      hub.escapeBound = true
    }

    function uninstallEscape() {
      if (!hub.escapeBound) return
      if (typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
        document.removeEventListener('keydown', handleEscape)
      }
      hub.escapeBound = false
    }

    // ---------------------------------------------------------------- translator

    function makeTranslator(ctx) {
      let bound = null
      const locale = ctx ? ctx.locale : undefined
      if (locale && typeof locale.bind === 'function') {
        try {
          const candidate = locale.bind(NS)
          if (typeof candidate === 'function') bound = candidate
        } catch (error) {
          bound = null
        }
      }
      const table = DICT[preferredLanguage()] || DICT.en
      return function translate(key, params) {
        if (bound) {
          try {
            const text = params === undefined ? bound(key) : bound(key, params)
            if (typeof text === 'string' && text !== '' && text !== key) return text
          } catch (error) {
            /* fall through to the bundled dictionary */
          }
        }
        const template = table[key] !== undefined ? table[key] : DICT.en[key] !== undefined ? DICT.en[key] : key
        return formatTemplate(template, params)
      }
    }

    // ---------------------------------------------------------------- glyphs

    function SituationGlyph(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block', color: (props && props.color) || 'currentColor' },
        },
        h('path', {
          d: 'M2.5 12S6.1 6 12 6s9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9 10v4M12 8.5v7M15 10.5v3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      )
    }

    function MicGlyph(props) {
      const size = props && props.size ? props.size : 16
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 9, y: 3, width: 6, height: 10.5, rx: 3, fill: 'currentColor' }),
        h('path', {
          d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', { d: 'M12 18v3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function StopGlyph(props) {
      const size = props && props.size ? props.size : 12
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 2, fill: 'currentColor' }),
      )
    }

    // ---------------------------------------------------------------- shared pieces

    function StatusDot(props) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        h('span', {
          style: {
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: props.color,
            flex: '0 0 auto',
          },
        }),
        h(
          'span',
          { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          props.label,
        ),
      )
    }

    function Pad(props) {
      return h('div', { style: Object.assign({ padding: '24px 28px' }, props.style) }, props.children)
    }

    function Card(props) {
      return h(
        'div',
        {
          style: {
            flex: '1 1 0',
            minWidth: '150px',
            background: palette.layer1,
            border: '1px solid ' + palette.border,
            borderRadius: '10px',
            padding: '14px 16px',
          },
        },
        h('div', { style: { fontSize: '12px', color: palette.muted, marginBottom: '6px' } }, props.label),
        h(
          'div',
          { style: { fontSize: '18px', fontWeight: 600, color: palette.text, wordBreak: 'break-all' } },
          props.value,
        ),
        props.hint ? h('div', { style: { fontSize: '11px', color: palette.muted, marginTop: '4px' } }, props.hint) : null,
      )
    }

    function Section(props) {
      return h(
        'section',
        { style: { marginTop: '26px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px' } },
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, color: palette.text } }, props.title),
          props.subtitle ? h('span', { style: { fontSize: '11px', color: palette.muted } }, props.subtitle) : null,
        ),
        props.children,
      )
    }

    function Rows(props) {
      return h(
        'div',
        {
          style: {
            background: palette.layer1,
            border: '1px solid ' + palette.border,
            borderRadius: '10px',
            overflow: 'hidden',
          },
        },
        props.children,
      )
    }

    function Row(props) {
      const style = {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        borderTop: props.first ? 'none' : '1px solid ' + palette.border,
        color: palette.text,
      }
      return h(
        'div',
        { style: style },
        props.badge
          ? h(
              'span',
              {
                style: {
                  fontSize: '10px',
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                  color: palette.muted,
                  border: '1px solid ' + palette.border,
                  borderRadius: '6px',
                  padding: '2px 6px',
                  flex: '0 0 auto',
                },
              },
              props.badge,
            )
          : null,
        h(
          'span',
          { style: { minWidth: 0, flex: '1 1 auto' } },
          h(
            'span',
            {
              style: {
                display: 'block',
                fontSize: '13px',
                fontWeight: 550,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            props.title,
          ),
          props.detail
            ? h(
                'span',
                {
                  style: {
                    display: 'block',
                    fontSize: '11px',
                    color: palette.muted,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                props.detail,
              )
            : null,
        ),
        props.meta ? h('span', { style: { fontSize: '11px', color: palette.muted, flex: '0 0 auto' } }, props.meta) : null,
      )
    }

    function Notice(props) {
      const color = props.tone === 'error' ? palette.error : props.tone === 'warn' ? palette.warn : palette.muted
      return h(
        'div',
        {
          style: {
            border: '1px solid ' + palette.border,
            borderLeft: '3px solid ' + color,
            background: palette.layer1,
            borderRadius: '8px',
            padding: '12px 14px',
          },
        },
        h('div', { style: { fontSize: '13px', fontWeight: 600, color: palette.text, marginBottom: '4px' } }, props.title),
        props.children
          ? h('div', { style: { fontSize: '12px', color: palette.muted, lineHeight: 1.6, wordBreak: 'break-word' } }, props.children)
          : null,
      )
    }

    function Pill(props) {
      const active = props.active === true
      return h(
        'button',
        {
          type: 'button',
          disabled: props.busy === true,
          'aria-pressed': active ? 'true' : 'false',
          onClick: props.onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: palette.text,
            background: active ? palette.layer2 : palette.layer1,
            border: '1px solid ' + (active ? palette.borderStrong : palette.border),
            borderRadius: '8px',
            padding: '6px 10px',
            cursor: props.busy === true ? 'default' : 'pointer',
            opacity: props.busy === true ? 0.6 : 1,
          },
        },
        props.dot
          ? h('span', {
              style: {
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: active ? palette.ok : palette.idle,
                flex: '0 0 auto',
              },
            })
          : null,
        props.label,
      )
    }

    function LevelBars(props) {
      const weights = [0.35, 0.62, 1, 0.78, 0.48]
      const scaled = Math.max(0.08, Math.min(1, props.level || 0))
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '2px', height: '16px' } },
        weights.map((weight, index) =>
          h('span', {
            key: index,
            style: {
              width: '2px',
              height: Math.max(2, Math.round(16 * weight * scaled)) + 'px',
              borderRadius: '1px',
              background: palette.accent,
            },
          }),
        ),
      )
    }

    // ---------------------------------------------------------------- page

    function sensorStatus(state, t) {
      if (!state || typeof state !== 'object') return { color: palette.idle, label: t('status.loading') }
      const sensor = state.sensor || {}
      const control = state.control || {}
      if (sensor.running !== true) return { color: palette.error, label: t('status.stopped') }
      if (control.paused === true) return { color: palette.warn, label: t('status.paused') }
      if (sensor.lastError) return { color: palette.warn, label: t('status.degraded') }
      if (sensor.ready === false) return { color: palette.warn, label: t('status.starting') }
      return { color: palette.ok, label: t('status.running') }
    }

    function hubStatus(hubState, t) {
      const phase = hubState ? hubState.phase : 'idle'
      if (phase === 'open') return { tone: 'ok', label: t('events.open') }
      if (phase === 'unsupported') return { tone: 'muted', label: t('events.unsupported') }
      if (phase === 'reconnecting') return { tone: 'warn', label: t('events.reconnecting') }
      return { tone: 'muted', label: t('events.connecting') }
    }

    function usePolling() {
      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document && document.hidden === true) return
          refreshState()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
    }

    let tutorArmAt = 0
    const TUTOR_ARM_MS = 4000

    function TutorButton({ t, compact, getTutorSelection, sessionId }) {
      const state = useStore(stateStore)
      const tutor = state?.tutor || {}
      const voiceBusy = ['requesting', 'recording', 'transcribing'].includes(useStore(recorder).phase)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const opening = tutor.active === true && tutor.opened === false && tutorArmAt !== 0 && Date.now() - tutorArmAt < TUTOR_ARM_MS
      const tutorError = error || (typeof tutor.error === 'string' ? tutor.error : '')
      async function toggle() {
        const live = stateStore.get()?.tutor || {}
        setBusy(true)
        setError('')
        try {
          if (live.active) {
            // The desktop process takes a few seconds to show. A second click in that
            // window used to send "stop" and the character vanished before it appeared.
            if (live.opened === false && tutorArmAt !== 0 && Date.now() - tutorArmAt < TUTOR_ARM_MS) {
              setError(t('tutor.loading'))
              return
            }
            tutorArmAt = 0
            await tutorRequest('stop')
          } else {
            tutorArmAt = Date.now()
            await tutorRequest('start', await getTutorSelection(sessionId))
          }
        }
        catch (failure) { setError(describeError(failure)) }
        finally { setBusy(false) }
      }
      return h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
        h('button', {
          type: 'button', onClick: toggle, disabled: busy || (!tutor.active && voiceBusy),
          title: tutorError || (opening ? t('tutor.loading') : undefined),
          style: { padding: compact ? '4px 8px' : '6px 12px', border: '1px solid ' + palette.border,
            borderRadius: '8px', color: palette.text, background: palette.layer1, whiteSpace: 'nowrap' },
        }, t(busy || opening ? 'tutor.loading' : tutor.active ? 'tutor.stop' : 'tutor.start')),
        !compact && tutor.phase === 'selecting' && !opening ? h('span', { role: 'status' }, t('tutor.confirm')) : null,
        !compact && tutor.phase === 'ready' && Number.isFinite(tutor.firstMs)
          ? h('span', {}, `${t('tutor.firstText')} ${(tutor.firstMs / 1000).toFixed(1)}s`) : null,
        tutorError ? h('span', { role: 'alert' }, tutorError) : null,
      )
    }

    function makePanel(t, getTutorSelection) {
      return function SituationPanel() {
        const state = useStore(stateStore)
        const connection = useStore(connectionStore)
        const hubState = useStore(hubStore)
        const voice = useStore(recorder)
        const [hotkeyDraft, setHotkeyDraft] = React.useState(null)
        const [pending, setPending] = React.useState('')
        const [notice, setNotice] = React.useState(null)
        const [autoSend, setAutoSend] = React.useState(() => readAutoSend())

        usePolling()

        const sensor = (state && state.sensor) || {}
        const control = (state && state.control) || {}
        const current = (state && state.current) || {}
        const latest = (state && state.latest) || {}
        const counters = (state && state.counters) || {}
        const speech = (state && state.speech) || {}
        const recent = state && Array.isArray(state.recent) ? state.recent : []
        const errors = state && Array.isArray(state.errors) ? state.errors : []
        const status = sensorStatus(state, t)
        const link = hubStatus(hubState, t)
        const hotkeyText = sensor.hotkey || control.hotkey || ''
        const storedTranscript =
          state && state.lastTranscript && typeof state.lastTranscript.text === 'string'
            ? state.lastTranscript.text
            : ''
        const lastTranscript = voice.text || storedTranscript

        const runControl = (name, patch) => {
          setPending(name)
          setNotice(null)
          postControl(patch)
            .then(() => setNotice({ tone: 'ok', key: 'control.saved', detail: '' }))
            .catch((error) => setNotice({ tone: 'error', key: 'control.saveFailed', detail: describeError(error) }))
            .then(() => setPending(''))
        }

        const saveHotkey = () => {
          const value = typeof hotkeyDraft === 'string' ? hotkeyDraft.trim() : ''
          if (value === '') return
          setPending('hotkey')
          setNotice(null)
          postControl({ hotkey: value })
            .then(() => {
              setHotkeyDraft(null)
              setNotice({ tone: 'ok', key: 'control.saved', detail: '' })
            })
            .catch((error) =>
              setNotice({ tone: 'error', key: 'control.saveFailed', detail: describeError(error) }),
            )
            .then(() => setPending(''))
        }

        const windowLine = [
          current.app || t('value.unknown'),
          current.title ? String(current.title) : '',
        ]
          .filter((part) => part !== '')
          .join(' — ')
        const idleLine =
          typeof current.idleMs === 'number' ? t('label.idle') + ' ' + formatIdle(current.idleMs) : ''

        const header = h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '18px 28px',
              borderBottom: '1px solid ' + palette.border,
              background: palette.base,
            },
          },
          h(
            'span',
            {
              style: {
                display: 'grid',
                placeItems: 'center',
                width: '32px',
                height: '32px',
                borderRadius: '9px',
                background: palette.layer2,
                color: palette.accent,
                flex: '0 0 auto',
              },
            },
            h(SituationGlyph, { size: 20 }),
          ),
          h(
            'div',
            { style: { minWidth: 0, flex: '1 1 auto' } },
            h('div', { style: { fontSize: '14px', fontWeight: 600, color: palette.text } }, t('title')),
            h(
              'div',
              {
                style: {
                  fontSize: '12px',
                  color: palette.muted,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                  minWidth: 0,
                },
              },
              h(StatusDot, { color: status.color, label: status.label }),
              h('span', { style: { opacity: 0.6 } }, '·'),
              h('span', { style: { whiteSpace: 'nowrap' } }, t('label.hotkey') + ' ' + (hotkeyText || t('value.unknown'))),
            ),
            h(
              'div',
              {
                style: {
                  fontSize: '12px',
                  color: palette.muted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginTop: '2px',
                },
              },
              idleLine === '' ? windowLine : windowLine + ' · ' + idleLine,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                refreshState()
              },
              style: {
                fontSize: '12px',
                color: palette.text,
                background: palette.layer1,
                border: '1px solid ' + palette.border,
                borderRadius: '8px',
                padding: '6px 12px',
                cursor: 'pointer',
                flex: '0 0 auto',
              },
            },
            t('refresh'),
          ),
        )

        const body = []

        body.push(h(TutorButton, { key: 'tutor', t, getTutorSelection }))

        if (connection.phase === 'error' && state === null) {
          body.push(h(Notice, { key: 'load-failed', tone: 'error', title: t('state.loadFailed') }, connection.error))
        }

        body.push(
          h(
            'div',
            { key: 'cards', style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
            h(Card, {
              label: t('label.app'),
              value: current.app || t('value.unknown'),
              hint: current.process || undefined,
            }),
            h(Card, {
              label: t('label.idle'),
              value: typeof current.idleMs === 'number' ? formatIdle(current.idleMs) : t('value.unknown'),
              hint: sensor.pid !== undefined ? t('label.pid') + ' ' + sensor.pid : undefined,
            }),
            h(Card, {
              label: t('label.hotkey'),
              value: hotkeyText || t('value.unknown'),
              hint: sensor.hotkeyOk === false ? t('status.degraded') : undefined,
            }),
            h(Card, {
              label: t('label.speech'),
              value: speech.provider || t('value.unknown'),
              hint: speech.available === false ? t('voice.unavailable') : t('voice.available'),
            }),
          ),
        )

        body.push(
          h(
            Section,
            { key: 'window', title: t('section.window'), subtitle: current.process || undefined },
            h(
              Rows,
              undefined,
              h(Row, {
                first: true,
                badge: t('label.title'),
                title: current.title || t('value.unknown'),
                detail: current.app || undefined,
                meta: current.since ? formatClock(current.since) : undefined,
              }),
              h(Row, {
                badge: t('label.ocrLang'),
                title: sensor.ocr || t('value.unknown'),
                detail: latest.ts ? t('label.since') + ' ' + formatClock(latest.ts) : undefined,
              }),
            ),
          ),
        )

        body.push(
          h(
            Section,
            { key: 'frame', title: t('section.frame'), subtitle: latest.ts ? formatClock(latest.ts) : undefined },
            latest.frame
              ? h(
                  'div',
                  {
                    style: {
                      background: palette.layer1,
                      border: '1px solid ' + palette.border,
                      borderRadius: '10px',
                      padding: '8px',
                      display: 'flex',
                      justifyContent: 'center',
                    },
                  },
                  h('img', {
                    src: latest.frame,
                    alt: t('section.frame'),
                    style: { maxWidth: '100%', maxHeight: '320px', borderRadius: '6px', display: 'block' },
                  }),
                )
              : h(Notice, { tone: 'muted', title: t('frame.empty') }),
          ),
        )

        body.push(
          h(
            Section,
            { key: 'ocr', title: t('section.ocr'), subtitle: latest.app || undefined },
            h(
              'div',
              {
                style: {
                  background: palette.layer1,
                  border: '1px solid ' + palette.border,
                  borderRadius: '10px',
                  padding: '12px 14px',
                  fontSize: '12px',
                  lineHeight: 1.7,
                  color: palette.text,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '220px',
                  overflow: 'auto',
                },
              },
              latest.ocrText
                ? latest.ocrText
                : h('span', { style: { color: palette.muted } }, t('ocr.empty')),
            ),
          ),
        )

        body.push(
          h(
            Section,
            { key: 'recent', title: t('section.recent'), subtitle: String(recent.length) },
            recent.length === 0
              ? h(Notice, { tone: 'muted', title: t('recent.empty') })
              : h(
                  'div',
                  { style: { maxHeight: '240px', overflow: 'auto' } },
                  h(
                    Rows,
                    undefined,
                    recent.map((item, index) =>
                      h(Row, {
                        key: (item && item.ts ? item.ts : '') + '-' + index,
                        first: index === 0,
                        badge: item && item.kind ? String(item.kind) : undefined,
                        title: (item && (item.title || item.text || item.app)) || t('value.unknown'),
                        detail: item && item.app ? String(item.app) : undefined,
                        meta: item && item.ts ? formatClock(item.ts) : undefined,
                      }),
                    ),
                  ),
                ),
          ),
        )

        const voiceStatus = recorderStatusText(voice, t)
        const voiceBusy = voice.phase === 'requesting' || voice.phase === 'transcribing'
        const hotkeyValue = hotkeyDraft === null ? hotkeyText : hotkeyDraft

        body.push(
          h(
            Section,
            { key: 'controls', title: t('section.controls'), subtitle: link.label },
            h(
              'div',
              { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              h(Pill, {
                label: control.paused === true ? t('control.resume') : t('control.pause'),
                active: control.paused === true,
                busy: pending === 'paused',
                dot: true,
                onClick: () => runControl('paused', { paused: control.paused !== true }),
              }),
              h(Pill, {
                label: t('control.capture') + ' ' + (control.capture === false ? t('control.off') : t('control.on')),
                active: control.capture !== false,
                busy: pending === 'capture',
                dot: true,
                onClick: () => runControl('capture', { capture: control.capture === false }),
              }),
              h(Pill, {
                label: t('control.ocr') + ' ' + (control.ocr === false ? t('control.off') : t('control.on')),
                active: control.ocr !== false,
                busy: pending === 'ocr',
                dot: true,
                onClick: () => runControl('ocr', { ocr: control.ocr === false }),
              }),
              h(Pill, {
                label: t('control.clipboard') + ' ' + (control.clipboard === true ? t('control.on') : t('control.off')),
                active: control.clipboard === true,
                busy: pending === 'clipboard',
                dot: true,
                onClick: () => runControl('clipboard', { clipboard: control.clipboard !== true }),
              }),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '12px' } },
              h('span', { style: { fontSize: '12px', color: palette.muted } }, t('label.hotkey')),
              h('input', {
                type: 'text',
                value: hotkeyValue,
                placeholder: t('control.hotkeyPlaceholder'),
                spellCheck: false,
                onChange: (event) => {
                  setHotkeyDraft(event && event.target ? event.target.value : '')
                },
                onKeyDown: (event) => {
                  if (event && event.key === 'Enter') saveHotkey()
                },
                style: {
                  fontSize: '12px',
                  color: palette.text,
                  background: palette.layer1,
                  border: '1px solid ' + palette.border,
                  borderRadius: '8px',
                  padding: '6px 10px',
                  minWidth: '180px',
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled: pending === 'hotkey',
                  onClick: saveHotkey,
                  style: {
                    fontSize: '12px',
                    color: palette.text,
                    background: palette.layer1,
                    border: '1px solid ' + palette.border,
                    borderRadius: '8px',
                    padding: '6px 12px',
                    cursor: pending === 'hotkey' ? 'default' : 'pointer',
                    opacity: pending === 'hotkey' ? 0.6 : 1,
                  },
                },
                pending === 'hotkey' ? t('control.saving') : t('control.saveHotkey'),
              ),
              notice
                ? h(
                    'span',
                    {
                      style: {
                        fontSize: '11px',
                        color: notice.tone === 'error' ? palette.error : palette.muted,
                        wordBreak: 'break-word',
                      },
                    },
                    t(notice.key) + (notice.detail ? ' · ' + notice.detail : ''),
                  )
                : null,
            ),
            h('div', { style: { fontSize: '11px', color: palette.muted, marginTop: '6px' } }, t('control.hotkeyHint')),
          ),
        )

        body.push(
          h(
            Section,
            { key: 'voice', title: t('section.voice'), subtitle: speech.provider || undefined },
            h(
              'div',
              { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
              h(Pill, {
                label: voice.phase === 'recording' ? t('voice.stop') : t('voice.record'),
                active: voice.phase === 'recording',
                busy: voiceBusy,
                dot: true,
                onClick: () => recorder.toggle(),
              }),
              voice.phase === 'recording' ? h(LevelBars, { level: voice.level }) : null,
              h(
                'label',
                {
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    color: palette.text,
                    cursor: 'pointer',
                  },
                },
                h('input', {
                  type: 'checkbox',
                  checked: autoSend,
                  onChange: (event) => {
                    const next = !!(event && event.target && event.target.checked)
                    setAutoSend(next)
                    writeAutoSend(next)
                  },
                  style: { accentColor: palette.accent },
                }),
                t('voice.autoSend'),
              ),
              voiceStatus
                ? h('span', { style: { fontSize: '12px', color: palette.muted } }, voiceStatus)
                : null,
            ),
            h(
              'div',
              { style: { fontSize: '11px', color: palette.muted, marginTop: '6px' } },
              speech.available === false
                ? t('voice.unavailable')
                : speech.ready === false
                  ? t('voice.preparing')
                  : t('voice.available'),
            ),
            lastTranscript
              ? h(
                  'div',
                  {
                    style: {
                      fontSize: '12px',
                      color: palette.muted,
                      marginTop: '8px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: '120px',
                      overflow: 'auto',
                    },
                  },
                  t('voice.last') + ' · ' + lastTranscript,
                )
              : null,
          ),
        )

        if (errors.length > 0) {
          body.push(
            h(
              Section,
              { key: 'errors', title: t('section.errors'), subtitle: String(errors.length) },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                errors.map((entry, index) =>
                  h(Notice, { key: 'error-' + index, tone: 'warn', title: errText(entry) }),
                ),
              ),
            ),
          )
        }

        body.push(
          h(
            Section,
            { key: 'counters', title: t('section.counters'), subtitle: link.label },
            h(
              'div',
              { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: palette.muted } },
              ['samples', 'frames', 'ocrs', 'drops', 'hotkeys', 'transcripts'].map((name) =>
                h(
                  'span',
                  { key: name },
                  t('counter.' + name) + ' ' + (counters[name] === undefined ? '0' : String(counters[name])),
                ),
              ),
            ),
          ),
        )

        return h(
          'div',
          {
            style: {
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              background: palette.base,
              color: palette.text,
              fontFamily: 'inherit',
            },
          },
          header,
          h(
            'div',
            { style: { flex: '1 1 auto', overflow: 'auto' } },
            h(Pad, undefined, body),
            h(
              'div',
              { style: { padding: '0 28px 22px', fontSize: '11px', color: palette.muted, wordBreak: 'break-all' } },
              state && state.dataDir ? t('label.dataDir') + ' · ' + state.dataDir : '',
            ),
          ),
        )
      }
    }

    function makePanelIcon() {
      return function SituationIcon(props) {
        return h(SituationGlyph, {
          size: props && props.size ? props.size : 18,
          color: props && props.active ? palette.accent : undefined,
        })
      }
    }

    // ---------------------------------------------------------------- composer dock

    function makeDock(t, getTutorSelection) {
      return function SituationDock(props) {
        const sessionId = props && props.sessionId !== undefined ? props.sessionId : null
        const inputActions = props && props.inputActions ? props.inputActions : null
        React.useEffect(() => {
          const entry = registerComposer(sessionId, inputActions)
          return () => unregisterComposer(entry)
        }, [sessionId, inputActions])

        const voice = useStore(recorder)
        const tutorActive = useStore(stateStore)?.tutor?.active === true
        const recording = voice.phase === 'recording'
        const busy = voice.phase === 'requesting' || voice.phase === 'transcribing'
        const status = recorderStatusText(voice, t)

        return h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              minWidth: 0,
              flex: '0 0 auto',
            },
          },
          h(
            'button',
            {
              type: 'button',
              disabled: busy || tutorActive,
              'aria-pressed': recording ? 'true' : 'false',
              'aria-label': recording ? t('mic.stop') : t('mic.dictate'),
              title: recording ? t('mic.stop') : t('mic.dictate'),
              onMouseDown: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
              },
              onClick: () => {
                recorder.toggle()
              },
              style: {
                width: '28px',
                height: '28px',
                minWidth: '28px',
                padding: 0,
                display: 'grid',
                placeItems: 'center',
                borderRadius: '8px',
                border: '1px solid ' + (recording ? palette.borderStrong : palette.border),
                background: recording ? palette.layer2 : palette.layer1,
                color: recording ? palette.accent : palette.muted,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.7 : 1,
              },
            },
            recording ? h(StopGlyph, { size: 12 }) : h(MicGlyph, { size: 15 }),
          ),
          h(TutorButton, { t, compact: true, getTutorSelection, sessionId }),
          recording ? h(LevelBars, { level: voice.level }) : null,
          status !== '' && !recording
            ? h(
                'span',
                {
                  role: 'status',
                  style: {
                    fontSize: '11px',
                    color: voice.phase === 'error' ? palette.error : palette.muted,
                    whiteSpace: 'nowrap',
                    maxWidth: '150px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                status,
              )
            : null,
          recording
            ? h(
                'span',
                {
                  role: 'status',
                  style: { fontSize: '11px', color: palette.muted, whiteSpace: 'nowrap' },
                },
                Math.max(0, Math.round((voice.elapsedMs || 0) / 1000)) + 's',
              )
            : null,
        )
      }
    }

    // ---------------------------------------------------------------- registration

    function registerAll(ctx, t) {
      const slots = ctx ? ctx.slots : undefined
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
      async function getTutorSelection(sessionId) {
        const id = sessionId ?? ctx.get?.('uiWorkspace')?.selection.getSnapshot()?.sessionId
        const models = ctx.get?.('modelDirectories')
        if (!id || !models) throw new Error(t('tutor.chooseModelInChat'))
        const snapshot = await models.directoryFor(id).load()
        if (snapshot.pending != null) throw new Error(t('tutor.modelChanging'))
        if (!snapshot.routable || !snapshot.current) throw new Error(t('tutor.chooseModelInChat'))
        const { provider, model, reasoningEffort } = snapshot.current
        return { sessionId: id, provider, model, reasoningEffort }
      }
      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 21,
            locale: NS,
            label: () => t('panel'),
          },
          makePanelIcon(),
        ),
      )
      slots.inject('main', () =>
        slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          makePanel(t, getTutorSelection),
        ),
      )
      slots.inject('conversation.composer.dock', () =>
        slots.register(
          {
            name: 'conversation.composer.dock',
            id: DOCK_ID,
            order: 30,
            locale: NS,
          },
          makeDock(t, getTutorSelection),
        ),
      )
      slots.inject('conversation.hero.options', () =>
        slots.register(
          { name: 'conversation.hero.options', id: 'situation-tutor', order: 30, locale: NS },
          ({ sessionId }) => h(TutorButton, { t, compact: true, getTutorSelection, sessionId }),
        ),
      )
    }

    function registerServices(ctx) {
      const cleanup = []
      const locale = ctx ? ctx.locale : undefined
      if (locale && typeof locale.register === 'function') {
        try {
          const dispose = locale.register(NS, DICT)
          if (typeof dispose === 'function') cleanup.push(dispose)
        } catch (error) {
          /* the bundled dictionary still serves the UI */
        }
      }
      cleanup.push(() => recorder.dispose())
      cleanup.push(() => {
        uninstallEscape()
        disposeEvents()
      })
      return () => {
        for (const fn of cleanup) {
          try {
            fn()
          } catch (error) {
            /* one failing disposer must not skip the rest */
          }
        }
      }
    }

    return {
      name: '@local/situation',
      inject: ['slots', 'locale'],
      apply(ctx) {
        const scope = ctx || {}
        const t = makeTranslator(scope)
        if (typeof scope.effect === 'function') {
          scope.effect(() => registerServices(scope), 'situation: dictionaries and event stream')
        } else {
          registerServices(scope)
        }
        openEvents()
        installEscape()
        registerAll(scope, t)
      },
      // Test seam only: the host ignores extra properties on a plugin object.
      __test: {
        DICT: DICT,
        NS: NS,
        stores: { state: stateStore, connection: connectionStore, hub: hubStore },
        recorder: recorder,
        encodeWav: encodeWav,
        resampleMono: resampleMono,
        toMono16k: toMono16k,
        registerComposer: registerComposer,
        unregisterComposer: unregisterComposer,
        activeComposer: activeComposer,
        refreshState: refreshState,
        deliverTranscript: deliverTranscript,
        readAutoSend: readAutoSend,
        writeAutoSend: writeAutoSend,
        disposeEvents: disposeEvents,
      },
    }
  },
})
