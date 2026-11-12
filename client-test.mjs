// client-test.mjs — headless harness for situation-plugin/client.js
//
// Loads client.js the way the DSH web host does (window.__ModuleLoader__.load), stubs
// react/document/localStorage/fetch/EventSource/navigator.mediaDevices, and asserts the
// three slot registrations, the panel tree, the SSE hotkey -> record -> transcribe ->
// insert path, the WAV encoder, the resample step, the dictionaries, the missing-service
// guards and the dispose path.
//
// Run: node client-test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ----------------------------------------------------------------- diagnostics

const results = []
let current = ''

function section(name) {
  current = name
}

function pass(name) {
  results.push({ ok: true, section: current, name })
}

function fail(name, error) {
  results.push({ ok: false, section: current, name, error })
}

function check(name, run) {
  try {
    const value = run()
    pass(name)
    return value
  } catch (error) {
    fail(name, error)
    return undefined
  }
}

async function checkAsync(name, run) {
  try {
    const value = await run()
    pass(name)
    return value
  } catch (error) {
    fail(name, error)
    return undefined
  }
}

// ----------------------------------------------------------------- fake react

const reactEffects = []

const React = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props || {})
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(callback, deps) {
    reactEffects.push({ callback, deps })
  },
  useRef(value) {
    return { current: value === undefined ? null : value }
  },
  useCallback(callback) {
    return callback
  },
  useMemo(factory) {
    return factory()
  },
}

// ----------------------------------------------------------------- fake document

const documentListeners = []
globalThis.document = {
  hidden: false,
  addEventListener(type, listener) {
    documentListeners.push({ type, listener })
  },
  removeEventListener(type, listener) {
    const index = documentListeners.findIndex((entry) => entry.type === type && entry.listener === listener)
    if (index >= 0) documentListeners.splice(index, 1)
  },
}

// ----------------------------------------------------------------- fake localStorage

const storage = new Map()
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null
  },
  setItem(key, value) {
    storage.set(key, String(value))
  },
  removeItem(key) {
    storage.delete(key)
  },
}

// ----------------------------------------------------------------- fake audio stack

const audio = { getUserMediaCalls: 0, trackStops: 0, decodeCalls: 0, renderedBuffers: [] }

const fakeTrack = {
  label: 'fake-microphone',
  stop() {
    audio.trackStops += 1
  },
  addEventListener() {},
}

const fakeStream = {
  getTracks: () => [fakeTrack],
  getAudioTracks: () => [fakeTrack],
}

function makeAudioBuffer(options) {
  const channels = options.channels
  const length = options.length
  const sampleRate = options.sampleRate
  const data = new Float32Array(length)
  data.fill(options.value)
  const perChannel = []
  for (let index = 0; index < channels; index += 1) perChannel.push(data)
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel) => perChannel[channel] || data,
  }
}

class FakeMediaRecorder {
  constructor(stream) {
    this.stream = stream
    this.state = 'inactive'
    this.mimeType = 'audio/webm;codecs=opus'
    this.ondataavailable = null
    this.onstop = null
    this.onerror = null
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    if (typeof this.ondataavailable === 'function') {
      this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) })
    }
    if (typeof this.onstop === 'function') this.onstop()
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running'
  }

  createAnalyser() {
    return {
      fftSize: 256,
      getFloatTimeDomainData(target) {
        target.fill(0.2)
      },
    }
  }

  createMediaStreamSource() {
    return { connect() {} }
  }

  async decodeAudioData() {
    audio.decodeCalls += 1
    const buffer = makeAudioBuffer({ channels: 2, length: 4800, sampleRate: 48000, value: 0.25 })
    audio.renderedBuffers.push(buffer)
    return buffer
  }

  async close() {
    this.state = 'closed'
  }
}

function installMediaGlobals() {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        language: 'zh-CN',
        mediaDevices: {
          async getUserMedia(constraints) {
            audio.getUserMediaCalls += 1
            audio.lastConstraints = constraints
            return fakeStream
          },
        },
      },
      configurable: true,
      writable: true,
    })
  } catch (error) {
    globalThis.navigator.mediaDevices = {
      async getUserMedia(constraints) {
        audio.getUserMediaCalls += 1
        audio.lastConstraints = constraints
        return fakeStream
      },
    }
    globalThis.navigator.language = 'zh-CN'
  }
  globalThis.MediaRecorder = FakeMediaRecorder
  globalThis.AudioContext = FakeAudioContext
  delete globalThis.webkitAudioContext
}

// ----------------------------------------------------------------- fake EventSource

class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type, data) {
    const list = this.listeners.get(type) || []
    for (const listener of list) listener({ type, data })
    return list.length
  }

  close() {
    this.closed = true
    this.readyState = 2
  }
}

// ----------------------------------------------------------------- fake fetch

const sampleState = {
  ok: true,
  sensor: {
    running: true,
    ready: true,
    pid: 4242,
    hotkey: 'Ctrl+Alt+Space',
    hotkeyOk: true,
    ocr: 'zh-Hans-CN',
    startedAt: '2026-11-10T20:00:00+08:00',
    restarts: 0,
    lastError: '',
  },
  control: { paused: false, capture: true, ocr: true, clipboard: false },
  current: {
    app: 'Code',
    process: 'Code.exe',
    title: 'client.js — situation-plugin',
    idleMs: 800,
    since: '2026-11-10T20:20:00+08:00',
    bounds: [0, 0, 1920, 1080],
  },
  latest: {
    ts: '2026-11-10T20:25:00+08:00',
    app: 'Code',
    frame: '/situation/frame/20261110-202500-123.jpg',
    ocrText: '这是一个测试窗口 test window',
  },
  recent: [
    { ts: '2026-11-10T20:24:00+08:00', kind: 'window', app: 'Code', title: 'client.js — situation-plugin', text: '' },
    { ts: '2026-11-10T20:25:00+08:00', kind: 'sample', app: 'Code', title: 'client.js', text: '' },
  ],
  counters: { samples: 12, frames: 3, ocrs: 2, drops: 0 },
  speech: { available: true, provider: 'sensevoice', ready: true },
  errors: [],
  dataDir: 'C:\\Users\\example\\.dsh\\situation',
  version: 1,
}

const fetchLog = []
let transcribePayload = { ok: true, text: '你好世界', ms: 900, provider: 'sensevoice' }

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
  }
}

globalThis.fetch = async (url, options = {}) => {
  fetchLog.push({ url, options })
  if (url === '/situation/state') return jsonResponse(sampleState)
  if (url === '/situation/control') return jsonResponse({ ok: true, state: sampleState })
  if (url === '/situation/tutor') {
    const body = options.body ? JSON.parse(options.body) : {}
    const tutor = body.action === 'stop'
      ? { active: false, error: '' }
      : { active: true, phase: 'selecting', opened: false }
    return jsonResponse({ ok: true, state: { ...sampleState, tutor } })
  }
  if (url === '/situation/transcribe') return jsonResponse(transcribePayload)
  return jsonResponse({ ok: false, error: 'unexpected route ' + url }, 404)
}

// ----------------------------------------------------------------- module loader

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
  addEventListener() {},
  removeEventListener() {},
}

installMediaGlobals()
globalThis.EventSource = FakeEventSource

const source = readFileSync(path.join(here, 'client.js'), 'utf8')
vm.runInThisContext(source, { filename: 'client.js' })

// ----------------------------------------------------------------- tree helpers

function expandTree(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expandTree)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expandTree(node.type(node.props || {}))
  const props = Object.assign({}, node.props)
  if (props.children !== undefined) props.children = expandTree(props.children)
  return { type: node.type, props }
}

function walkHosts(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walkHosts(item, visit)
    return
  }
  visit(node)
  const children = node.props ? node.props.children : undefined
  if (children !== undefined) walkHosts(children, visit)
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  const children = node.props ? node.props.children : undefined
  if (children !== undefined) collectText(children, out)
  return out
}

function makeCtx() {
  const registrations = []
  const tables = new Map()
  const disposers = []
  const chatModels = new Map([
    ['s1', { provider: 'fixture', model: 'existing-chat-model', reasoningEffort: 'max' }],
    ['home', { provider: 'fixture', model: 'draft-chat-model', reasoningEffort: 'low' }],
    ['active', { provider: 'other-fixture', model: 'panel-chat-model' }],
  ])
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') return { selection: { getSnapshot: () => ({ sessionId: 'active' }) } }
      if (name === 'modelDirectories') return { directoryFor: (id) => ({
        async load() { return { current: chatModels.get(id), routable: chatModels.has(id), pending: null } },
      }) }
    },
    effect(callback, label) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push({ label, dispose })
      return () => {}
    },
    slots: {
      inject(name, build) {
        build()
        return () => {}
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    locale: {
      register(namespace, dictionary) {
        tables.set(namespace, dictionary)
        return () => tables.delete(namespace)
      },
      bind(namespace) {
        return (key, params) => {
          const table = tables.get(namespace) || {}
          const language = table.zh || table.en || {}
          const template = language[key] !== undefined ? language[key] : key
          if (!params) return template
          return String(template).replace(/\{(\w+)\}/g, (match, name) =>
            params[name] === undefined ? match : String(params[name]),
          )
        }
      },
    },
  }
  return { ctx, registrations, disposers, tables, chatModels }
}

// ----------------------------------------------------------------- main

async function main() {
  section('module')
  check('client.js calls window.__ModuleLoader__.load', () => {
    assert.ok(captured, 'load() was never called')
  })
  check('module id is @local/situation', () => {
    assert.equal(captured.id, '@local/situation')
  })

  const plugin = check('factory returns a plugin object', () => {
    const built = captured.factory((name) => {
      assert.equal(name, 'react', 'client.js may only require react')
      return React
    })
    assert.ok(built && typeof built.apply === 'function')
    return built
  })
  if (!plugin) throw new Error('factory failed; later checks cannot run')

  check('plugin declares inject slots + locale', () => {
    assert.deepEqual(plugin.inject, ['slots', 'locale'])
  })

  const frame = makeCtx()
  const applied = check('apply() completes with a full context', () => {
    plugin.apply(frame.ctx)
    return true
  })
  if (!applied) throw new Error('apply failed; later checks cannot run')

  // ------------------------------------------------------------- registrations

  section('registrations')
  const byName = new Map(frame.registrations.map((entry) => [entry.spec.name, entry]))
  check('four slot registrations including the DSH start page', () => {
    assert.deepEqual(
      frame.registrations.map((entry) => entry.spec.name),
      ['sidebar.panellist', 'main', 'conversation.composer.dock', 'conversation.hero.options'],
    )
  })
  check('sidebar.panellist id/order/label', () => {
    const entry = byName.get('sidebar.panellist')
    assert.ok(entry)
    assert.equal(entry.spec.id, 'situation')
    assert.equal(entry.spec.order, 21)
    assert.equal(entry.spec.locale, 'situation')
    assert.equal(entry.spec.label(), '现场感知')
    assert.equal(typeof entry.component, 'function')
  })
  check('main key is situation', () => {
    const entry = byName.get('main')
    assert.ok(entry)
    assert.equal(entry.spec.key, 'situation')
    assert.equal(entry.spec.locale, 'situation')
    assert.equal(typeof entry.component, 'function')
  })
  check('composer dock id/order', () => {
    const entry = byName.get('conversation.composer.dock')
    assert.ok(entry)
    assert.equal(entry.spec.id, 'situation-mic')
    assert.equal(entry.spec.order, 30)
    assert.equal(typeof entry.component, 'function')
  })

  // ------------------------------------------------------------- event stream

  section('event stream')
  check('EventSource opened on /situation/events', () => {
    assert.equal(FakeEventSource.instances.length, 1, 'expected one EventSource')
    const source = FakeEventSource.instances[0]
    assert.equal(source.url, '/situation/events')
  })
  check('named listeners state|sample|hotkey|transcript', () => {
    const source = FakeEventSource.instances[0]
    for (const kind of ['state', 'sample', 'hotkey', 'transcript']) {
      assert.equal((source.listeners.get(kind) || []).length, 1, 'missing listener for ' + kind)
    }
  })
  check('SSE state event updates the store', () => {
    const source = FakeEventSource.instances[0]
    source.dispatch('state', JSON.stringify(Object.assign({}, sampleState, { counters: { samples: 99, frames: 4, ocrs: 1, drops: 0 } })))
    assert.equal(plugin.__test.stores.state.get().counters.samples, 99)
  })
  check('SSE partial state patch merges instead of replacing', () => {
    const source = FakeEventSource.instances[0]
    source.dispatch('state', JSON.stringify({ errors: ['20:00:00 hotkey failed'] }))
    const state = plugin.__test.stores.state.get()
    assert.equal(state.errors[0], '20:00:00 hotkey failed')
    assert.equal(state.current.app, 'Code', 'partial patch must keep the rest of the state')
    assert.equal(state.sensor.running, true)
  })
  check('SSE sample event merges window fields', () => {
    const source = FakeEventSource.instances[0]
    source.dispatch('sample', JSON.stringify({ ts: '2026-11-10T20:26:00+08:00', app: 'Edge', title: 'docs', idleMs: 0 }))
    const current = plugin.__test.stores.state.get().current
    assert.equal(current.app, 'Edge')
    assert.equal(current.title, 'docs')
    assert.equal(current.idleMs, 0)
  })
  check('SSE sample clears the previous window screenshot and OCR', () => {
    const source = FakeEventSource.instances[0]
    const captured = { frame: '/situation/frame/test.jpg', ocrText: 'prior window' }
    const cleared = { frame: '', ocrText: '', app: '', ts: '', ocrAt: '' }
    source.dispatch('sample', JSON.stringify({ app: 'Test', latest: captured }))
    assert.equal(plugin.__test.stores.state.get().latest.ocrText, 'prior window')
    source.dispatch('sample', JSON.stringify({ app: 'Edge', latest: cleared }))
    assert.deepEqual(plugin.__test.stores.state.get().latest, cleared)
  })

  // ------------------------------------------------------------- panel

  section('panel')
  plugin.__test.stores.state.set(sampleState)
  let panelTree = null
  check('panel renders a tree without throwing', () => {
    panelTree = expandTree(byName.get('main').component({}))
    assert.ok(panelTree, 'panel returned nothing')
  })
  check('panel shows the window, frame, OCR text and hotkey', () => {
    const text = collectText(panelTree).join(' ')
    assert.ok(text.includes('现场感知'), 'title missing')
    assert.ok(text.includes('感知运行中'), 'sensor status missing')
    assert.ok(text.includes('Code'), 'app missing')
    assert.ok(text.includes('client.js — situation-plugin'), 'window title missing')
    assert.ok(text.includes('Ctrl+Alt+Space'), 'hotkey missing')
    assert.ok(text.includes('这是一个测试窗口 test window'), 'OCR text missing')
    const images = []
    walkHosts(panelTree, (node) => {
      if (node.type === 'img') images.push(node.props)
    })
    assert.equal(images.length, 1, 'expected one <img>')
    assert.equal(images[0].src, '/situation/frame/20261110-202500-123.jpg')
  })
  check('panel exposes the voice test button and auto-send toggle', () => {
    const labels = []
    walkHosts(panelTree, (node) => {
      if (node.type === 'button') labels.push(collectText(node).join(' '))
      if (node.type === 'input' && node.props.type === 'checkbox') labels.push('checkbox')
    })
    assert.ok(labels.some((label) => label.includes('录制语音')), 'record button missing')
    assert.ok(labels.includes('checkbox'), 'auto-send checkbox missing')
  })
  await checkAsync('panel polling skips while hidden and fetches when visible', async () => {
    const polling = reactEffects.filter((entry) => Array.isArray(entry.deps) && entry.deps.length === 0)
    assert.ok(polling.length >= 1, 'polling effect missing')
    const effect = polling[polling.length - 1]
    const before = fetchLog.filter((call) => call.url === '/situation/state').length

    globalThis.document.hidden = true
    const stopHidden = effect.callback()
    await wait(0)
    const hiddenCount = fetchLog.filter((call) => call.url === '/situation/state').length
    if (typeof stopHidden === 'function') stopHidden()
    assert.equal(hiddenCount, before, 'hidden page must not poll')

    globalThis.document.hidden = false
    const stopVisible = effect.callback()
    await wait(0)
    const visibleCount = fetchLog.filter((call) => call.url === '/situation/state').length
    if (typeof stopVisible === 'function') stopVisible()
    assert.equal(visibleCount, before + 1, 'visible page must poll once on mount')
  })
  check('panel renders the empty/paused/error state', () => {
    plugin.__test.stores.state.set({
      ok: true,
      sensor: { running: false, ready: false, lastError: 'RegisterHotKey failed' },
      control: { paused: true },
      current: {},
      latest: {},
      recent: [],
      counters: {},
      errors: ['hotkey registration failed'],
      speech: { available: false },
      dataDir: 'C:\\tmp',
      version: 1,
    })
    const tree = expandTree(byName.get('main').component({}))
    const text = collectText(tree).join(' ')
    assert.ok(text.includes('感知未运行'), 'stopped status missing')
    assert.ok(text.includes('还没有画面'), 'empty frame branch missing')
    assert.ok(text.includes('没有识别到的文字'), 'empty OCR branch missing')
    assert.ok(text.includes('还没有记录'), 'empty timeline branch missing')
    assert.ok(text.includes('hotkey registration failed'), 'error list missing')
    assert.ok(text.includes('转写不可用'), 'speech unavailable branch missing')
    const images = []
    walkHosts(tree, (node) => {
      if (node.type === 'img') images.push(node.props)
    })
    assert.equal(images.length, 0, 'no <img> should render without a frame')
    plugin.__test.stores.state.set(sampleState)
  })

  // ------------------------------------------------------------- controls

  section('controls')
  await checkAsync('pause button posts {paused:true} to /situation/control', async () => {
    const buttons = []
    walkHosts(panelTree, (node) => {
      if (node.type === 'button') buttons.push(node.props)
    })
    const pause = buttons.find((props) => collectText({ props }).join(' ').trim() === '暂停')
    assert.ok(pause, 'pause button not found')
    pause.onClick()
    await wait(0)
    const call = fetchLog.find((entry) => entry.url === '/situation/control')
    assert.ok(call, 'control route was not called')
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.headers['content-type'], 'application/json')
    assert.equal(call.options.body, JSON.stringify({ paused: true }))
  })


  // ------------------------------------------------------------- dock

  section('dock')
  const inserts = []
  const fakeActions = {
    accepted: true,
    submitted: false,
    captureInsertion() {
      return { start: 0, end: 0, draftRev: 7 }
    },
    insertText(text, span) {
      if (!this.accepted) return false
      inserts.push({ text, span })
      return true
    },
    submit() {
      this.submitted = true
    },
  }
  check('dock renders without throwing', () => {
    const tree = expandTree(byName.get('conversation.composer.dock').component({ sessionId: 's1', inputActions: fakeActions }))
    const buttons = []
    walkHosts(tree, (node) => {
      if (node.type === 'button') buttons.push(node.props)
    })
    const mic = buttons.find((button) => button['aria-label'] === '语音输入')
    assert.ok(mic, 'expected the dictation mic')
    assert.equal(mic.style.width, '28px')
    assert.equal(mic.style.height, '28px')
  })
  for (const [page, slot, sessionId] of [
    ['existing conversation', 'conversation.composer.dock', 's1'],
    ['start page', 'conversation.hero.options', 'home'],
    ['sidebar panel', 'main', undefined],
  ]) {
    await checkAsync(`${page} starts tutoring with its chat model and effort`, async () => {
      const entry = byName.get(slot)
      assert.ok(entry, `no tutor control registered for ${slot}`)
      const tree = expandTree(entry.component({ sessionId, inputActions: fakeActions }))
      let launch
      walkHosts(tree, (node) => {
        if (node.type === 'button' && node.props.children === '开始辅导') launch = node.props.onClick
      })
      assert.equal(typeof launch, 'function')
      const before = fetchLog.length
      await launch()
      const calls = fetchLog.slice(before).filter((item) => item.url === '/situation/tutor')
      assert.equal(calls.length, 1)
      const target = sessionId ?? 'active'
      assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'start', selection: { sessionId: target, ...frame.chatModels.get(target) } })
      await plugin.__test.refreshState()
    })
  }
  await checkAsync('a second click while the desktop window is opening does not stop tutoring', async () => {
    const entry = byName.get('conversation.hero.options')
    const tree = expandTree(entry.component({ sessionId: 'home' }))
    let launch
    walkHosts(tree, (node) => {
      if (node.type === 'button' && node.props.children === '开始辅导') launch = node.props.onClick
    })
    const before = fetchLog.length
    await launch()
    await launch()
    const calls = fetchLog.slice(before).filter((item) => item.url === '/situation/tutor')
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(calls[0].options.body).action, 'start')
    const realNow = Date.now
    Date.now = () => realNow() + 5000
    try {
      await launch()
    } finally {
      Date.now = realNow
    }
    const later = fetchLog.slice(before).filter((item) => item.url === '/situation/tutor')
    assert.equal(later.length, 2)
    assert.equal(JSON.parse(later[1].options.body).action, 'stop')
    await plugin.__test.refreshState()
  })
  check('tutor startup failure is visible from every entry', () => {
    plugin.__test.stores.state.set({
      ...sampleState,
      tutor: { active: false, error: '桌面辅导窗口启动失败。' },
    })
    for (const [slot, sessionId] of [
      ['conversation.composer.dock', 's1'],
      ['conversation.hero.options', 'home'],
      ['main', undefined],
    ]) {
      const tree = expandTree(byName.get(slot).component({ sessionId, inputActions: fakeActions }))
      assert.ok(collectText(tree).join('\n').includes('桌面辅导窗口启动失败。'), slot)
    }
    plugin.__test.stores.state.set(sampleState)
  })
  check('dock registers the active composer', () => {
    const entry = plugin.__test.registerComposer('s1', fakeActions)
    assert.equal(plugin.__test.activeComposer(), entry)
  })

  // ------------------------------------------------------------- hotkey round trip

  section('hotkey')
  const sse = FakeEventSource.instances[0]
  await checkAsync('hotkey starts recording', async () => {
    sse.dispatch('hotkey', JSON.stringify({ type: 'hotkey', id: 'toggle' }))
    await wait(20)
    assert.equal(plugin.__test.recorder.get().phase, 'recording')
    assert.ok(audio.getUserMediaCalls >= 1, 'getUserMedia was not called')
    assert.deepEqual(audio.lastConstraints.audio.echoCancellation, true)
  })
  await checkAsync('hotkey again stops, transcribes and inserts', async () => {
    sse.dispatch('hotkey', JSON.stringify({ type: 'hotkey', id: 'toggle' }))
    await wait(80)
    assert.equal(plugin.__test.recorder.get().phase, 'inserted')
    assert.equal(inserts.length, 1, 'expected one insertion')
    assert.equal(inserts[0].text, '你好世界')
    assert.deepEqual(inserts[0].span, { start: 0, end: 0, draftRev: 7 })
    assert.equal(fakeActions.submitted, false, 'auto-send defaults to off')
  })
  check('transcribe POST carries a 16 kHz mono PCM16 WAV', () => {
    const call = fetchLog.find((entry) => entry.url === '/situation/transcribe')
    assert.ok(call, 'transcribe was not called')
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.headers['content-type'], 'audio/wav')
    const bytes = call.options.body
    assert.ok(bytes instanceof Uint8Array, 'body must be a byte array')
    // 4800 stereo samples @48k -> 4800 mono -> 1600 @16k -> 44 + 3200 bytes
    assert.equal(bytes.byteLength, 44 + 1600 * 2)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'RIFF')
    assert.equal(view.getUint16(22, true), 1, 'channels')
    assert.equal(view.getUint32(24, true), 16000, 'sample rate')
    assert.equal(view.getUint16(34, true), 16, 'bit depth')
    assert.equal(view.getInt16(44, true), 8192, 'first PCM sample of 0.25')
  })
  check('auto-send submits after insertion when enabled', () => {
    plugin.__test.writeAutoSend(true)
    assert.equal(plugin.__test.readAutoSend(), true)
    const before = inserts.length
    plugin.__test.deliverTranscript('自动发送')
    assert.equal(inserts.length, before + 1)
    assert.equal(inserts[inserts.length - 1].text, '自动发送')
    assert.equal(fakeActions.submitted, true)
    plugin.__test.writeAutoSend(false)
  })
  check('insertion conflict retries once then reports', () => {
    fakeActions.accepted = false
    plugin.__test.deliverTranscript('冲突')
    const snapshot = plugin.__test.recorder.get()
    assert.equal(snapshot.phase, 'error')
    assert.equal(snapshot.messageKey, 'err.conflict')
    fakeActions.accepted = true
  })
  check('dictation lands in the visible composer when none is registered', () => {
    // A brand-new conversation has no session composer yet; the transcript must reach
    // the composer the user is looking at instead of waiting for a first message.
    const registered = plugin.__test.activeComposer()
    plugin.__test.unregisterComposer(registered)
    const events = []
    const field = {
      tagName: 'TEXTAREA',
      value: '前缀',
      selectionStart: 2,
      selectionEnd: 2,
      disabled: false,
      readOnly: false,
      focus() {},
      setSelectionRange(start, end) {
        this.selectionStart = start
        this.selectionEnd = end
      },
      dispatchEvent(event) {
        events.push(event.type)
      },
      getBoundingClientRect() {
        return { width: 640, height: 40 }
      },
    }
    const realDocument = globalThis.document
    const realTextarea = globalThis.HTMLTextAreaElement
    globalThis.document = {
      hidden: false,
      activeElement: null,
      querySelectorAll() {
        return [field]
      },
      addEventListener() {},
      removeEventListener() {},
    }
    globalThis.HTMLTextAreaElement = { prototype: {} }
    try {
      plugin.__test.deliverTranscript('说话')
      assert.equal(field.value, '前缀说话')
      assert.equal(events.includes('input'), true, 'an input event must update the draft')
      assert.equal(field.selectionStart, 4, 'the caret must follow the inserted text')
      const snapshot = plugin.__test.recorder.get()
      assert.equal(snapshot.phase, 'inserted')
      assert.equal(snapshot.text, '说话')
    } finally {
      globalThis.document = realDocument
      globalThis.HTMLTextAreaElement = realTextarea
      plugin.__test.registerComposer('s1', fakeActions)
    }
  })
  await checkAsync('Escape cancels an active recording', async () => {
    sse.dispatch('hotkey', JSON.stringify({ type: 'hotkey', id: 'toggle' }))
    await wait(20)
    assert.equal(plugin.__test.recorder.get().phase, 'recording')
    const keydown = documentListeners.filter((entry) => entry.type === 'keydown')
    assert.equal(keydown.length, 1, 'expected one keydown listener')
    let prevented = false
    keydown[0].listener({ key: 'Escape', preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(plugin.__test.recorder.get().phase, 'idle')
    assert.ok(audio.trackStops >= 2, 'microphone tracks were not released')
  })

  // ------------------------------------------------------------- wav + resample

  section('audio')
  check('encodeWav writes the canonical 44-byte header', () => {
    const wav = plugin.__test.encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]))
    assert.equal(wav.byteLength, 54)
    const view = new DataView(wav.buffer)
    const ascii = (from, to) => String.fromCharCode(...wav.slice(from, to))
    assert.equal(ascii(0, 4), 'RIFF')
    assert.equal(view.getUint32(4, true), 46, 'RIFF size = bytes - 8')
    assert.equal(ascii(8, 12), 'WAVE')
    assert.equal(ascii(12, 16), 'fmt ')
    assert.equal(view.getUint32(16, true), 16, 'fmt chunk size')
    assert.equal(view.getUint16(20, true), 1, 'PCM format')
    assert.equal(view.getUint16(22, true), 1, 'mono')
    assert.equal(view.getUint32(24, true), 16000, 'sample rate')
    assert.equal(view.getUint32(28, true), 32000, 'byte rate')
    assert.equal(view.getUint16(32, true), 2, 'block align')
    assert.equal(view.getUint16(34, true), 16, 'bits per sample')
    assert.equal(ascii(36, 40), 'data')
    assert.equal(view.getUint32(40, true), 10, 'data size')
    assert.equal(view.getInt16(44, true), 0)
    assert.equal(view.getInt16(46, true), 16384)
    assert.equal(view.getInt16(48, true), -16384)
    assert.equal(view.getInt16(50, true), 32767)
    assert.equal(view.getInt16(52, true), -32768)
  })
  check('resampleMono decimates 48k to 16k', () => {
    const resampled = plugin.__test.resampleMono(new Float32Array(48000).fill(0.5), 48000, 16000)
    assert.equal(resampled.length, 16000)
    for (const value of resampled) assert.equal(value, 0.5)
  })
  check('toMono16k downmixes stereo', () => {
    const mono = plugin.__test.toMono16k(
      makeAudioBuffer({ channels: 2, length: 3200, sampleRate: 32000, value: 0.4 }),
    )
    assert.equal(mono.length, 1600)
    assert.ok(Math.abs(mono[0] - 0.4) < 1e-6)
  })

  // ------------------------------------------------------------- dictionaries

  section('locale')
  check('client dictionary covers every key in both languages', () => {
    const zh = Object.keys(plugin.__test.DICT.zh)
    const en = Object.keys(plugin.__test.DICT.en)
    assert.deepEqual(zh.sort(), en.sort(), 'zh and en key sets differ')
    assert.ok(zh.length >= 60, 'suspiciously small dictionary: ' + zh.length)
  })
  check('locale/zh.json meta', () => {
    const parsed = JSON.parse(readFileSync(path.join(here, 'locale', 'zh.json'), 'utf8'))
    assert.equal(parsed.meta.title, '现场感知')
    assert.ok(typeof parsed.meta.description === 'string' && parsed.meta.description.length > 10)
  })
  check('locale/en.json meta', () => {
    const parsed = JSON.parse(readFileSync(path.join(here, 'locale', 'en.json'), 'utf8'))
    assert.equal(parsed.meta.title, 'Situational awareness')
    assert.ok(typeof parsed.meta.description === 'string' && parsed.meta.description.length > 10)
  })

  // ------------------------------------------------------------- guards

  section('guards')
  check('apply works with slots only (no locale, no effect)', () => {
    const specs = []
    plugin.apply({
      slots: {
        inject(name, build) {
          build()
        },
        register(spec) {
          specs.push(spec)
          return () => {}
        },
      },
    })
    assert.equal(specs.length, 4)
  })
  check('apply works with an empty context', () => {
    plugin.apply({})
  })

  // ------------------------------------------------------------- dispose

  section('dispose')
  check('dispose closes the stream, removes the key listener and idles the recorder', () => {
    assert.ok(frame.disposers.length >= 1, 'no disposer registered through ctx.effect')
    for (const entry of frame.disposers) entry.dispose()
    assert.equal(sse.closed, true, 'EventSource was not closed')
    assert.equal(documentListeners.filter((entry) => entry.type === 'keydown').length, 0)
    assert.equal(plugin.__test.recorder.get().phase, 'idle')
  })
}

// ----------------------------------------------------------------- report

let failed = 0
try {
  await main()
} catch (error) {
  failed += 1
  console.error('')
  console.error('FATAL: ' + (error && error.stack ? error.stack : String(error)))
}

const width = results.reduce((max, entry) => Math.max(max, entry.name.length), 0)
let lastSection = ''
console.log('')
console.log('situation client harness')
console.log('='.repeat(width + 16))
for (const entry of results) {
  if (entry.section !== lastSection) {
    lastSection = entry.section
    console.log('')
    console.log('[' + lastSection + ']')
  }
  const status = entry.ok ? 'PASS' : 'FAIL'
  console.log('  ' + status + '  ' + entry.name.padEnd(width))
  if (!entry.ok) {
    failed += 1
    const detail = entry.error && entry.error.message ? entry.error.message : String(entry.error)
    console.log('        ' + detail)
  }
}
console.log('')
console.log('='.repeat(width + 16))
console.log((results.length - failed) + ' passed, ' + failed + ' failed, ' + results.length + ' checks')
process.exitCode = failed === 0 ? 0 : 1
