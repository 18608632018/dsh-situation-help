// Structural harness for the situation host plugin: no DSH, no real sensor.
// Run: node host-test.mjs
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { apply, nextTutorOwned, shouldStartTurnInject } from './index.js'

const dataDir = mkdtempSync(join(tmpdir(), 'situation-test-'))
const tools = new Map()
const routes = []
const sections = []
const effects = []
const injected = []

const webServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

const systemPrompt = {
  section(section) {
    sections.push(section)
    return () => {}
  },
}

const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
  inject(deps, cb) {
    injected.push(deps)
    const child = Object.create(ctx)
    child.webServer = webServer
    child.systemPrompt = systemPrompt
    child.speechToText = undefined
    child.agents = { list: () => [] }
    cb(child)
    return () => {}
  },
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'systemPrompt') return systemPrompt
    if (name === 'speechToText') return undefined
    if (name === 'agents') return { list: () => [] }
    return undefined
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
}

apply(ctx, { dataDir, autoStart: false, intervalMs: 5000 })

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

const turnCases = [
  [{ autoContext: true, tutorActive: true, tutorJustStopped: false, paused: false, stop: false, prev: 'idle', status: 'running' }, false, 'tutoring does not inject into its own turn'],
  [{ autoContext: true, tutorActive: false, tutorJustStopped: true, paused: false, stop: false, prev: 'idle', status: 'running' }, false, 'a tutor answer still running after stop is not a user turn'],
  [{ autoContext: true, tutorActive: false, tutorJustStopped: false, paused: false, stop: false, prev: 'idle', status: 'running' }, true, 'a user turn gets the timeline'],
  [{ autoContext: true, tutorActive: false, tutorJustStopped: true, paused: false, stop: false, prev: 'idle', status: 'idle' }, false, 'idle after tutoring is not a turn start'],
  [{ autoContext: true, tutorActive: false, tutorJustStopped: false, paused: false, stop: false, prev: 'running', status: 'running' }, false, 'a mid-turn poll is not a new turn'],
  [{ autoContext: true, tutorActive: false, tutorJustStopped: false, paused: false, stop: false, prev: undefined, status: 'running' }, false, 'the first sighting is not a turn start'],
  [{ autoContext: false, tutorActive: false, tutorJustStopped: false, paused: false, stop: false, prev: 'idle', status: 'running' }, false, 'autoContext off'],
  [{ autoContext: true, tutorActive: false, tutorJustStopped: false, paused: true, stop: false, prev: 'idle', status: 'running' }, false, 'paused sensing does not inject'],
]
for (const [input, expected, label] of turnCases) {
  assert(shouldStartTurnInject(input) === expected, label)
}
assert(nextTutorOwned(false, { tutorOn: true, justStopped: false, status: 'running' }) === true, 'a turn that starts while tutoring is owned')
assert(nextTutorOwned(false, { tutorOn: false, justStopped: true, status: 'running' }) === true, 'a tutor answer still running after stop stays owned')
assert(nextTutorOwned(true, { tutorOn: false, justStopped: false, status: 'running' }) === true, 'ownership lasts until the agent is idle')
assert(nextTutorOwned(true, { tutorOn: false, justStopped: false, status: 'idle' }) === false, 'idle releases the tutor turn')
assert(nextTutorOwned(false, { tutorOn: false, justStopped: false, status: 'running' }) === false, 'a later user turn is not owned')

const sensorPath = join(dirname(fileURLToPath(import.meta.url)), 'sensor', 'sense.ps1')
const sensorBytes = readFileSync(sensorPath)
assert(sensorBytes[0] !== 0xEF, 'sense.ps1 has no UTF-8 BOM')
assert(!sensorBytes.some((byte) => byte > 127), 'sense.ps1 stays pure ASCII for Windows PowerShell 5')
const sensorText = sensorBytes.toString('ascii')
const psUrlPattern = "^[a-zA-Z][\\w+.-]*://\\S*$"
const csUrlPattern = "^[a-zA-Z][\\\\w+.-]*://\\\\S*$"
assert(sensorText.includes('function Test-UrlText'), 'URL rejection helper is present')
assert(sensorText.includes(psUrlPattern), 'PowerShell URL pattern is present')
assert(sensorText.includes(csUrlPattern), 'caret reader URL pattern is present')
assert(sensorText.includes('GetCaretRange'), 'TextPattern2 caret range is the Electron path')
assert(sensorText.includes('TextUnit_Paragraph'), 'caret text expands to the paragraph')
assert(sensorText.includes('function Read-CaretOcr'), 'OCR of the caret band is the fallback')
assert(sensorText.includes('function Test-CjkText'), 'committed CJK is preferred over later pinyin')
assert(sensorText.includes('TypeDocument = 50030'), 'document values are not treated as field text')
const urlText = /^[a-zA-Z][\w+.-]*:\/\/\S*$/
const rejectedUrls = ['dsh-app://app/', 'dsh-app://app/index.html', 'https://example.com/a', 'http://x', 'HTTP://X']
const keptText = ['yingpan', 'hello world', 'see https://example.com', 'C:\\Windows', '']
for (const value of rejectedUrls) assert(urlText.test(value.trim()), `reject URL ${value}`)
for (const value of keptText) assert(!urlText.test(value.trim()), `keep non-URL ${value || '(empty)'}`)

assert(tools.size === 4, `expected 4 tools, got ${tools.size}: ${[...tools.keys()].join(',')}`)
assert(sections.some((s) => s.name === 'situation:guidance'), 'system prompt section registered')
assert(routes.some((r) => r.path === '/situation/state'), 'state route registered')
assert(routes.some((r) => r.path === '/situation/events'), 'events route registered')
assert(routes.some((r) => r.path === '/situation/transcribe'), 'transcribe route registered')
assert(routes.some((r) => r.kind === 'prefix' && r.path === '/situation/frame'), 'frame prefix route registered')

function callRoute(path, method = 'GET', body = null) {
  const route = routes.find((r) => r.path === path.split('?')[0])
  assert(route !== undefined, `route ${path} exists`)
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      url: path,
      on(event, fn) {
        listeners[event] = fn
        return req
      },
      destroy() {},
    }
    let status = 0
    let headers = {}
    let payload = ''
    const res = {
      writeHead(code, hdrs) {
        status = code
        headers = hdrs ?? {}
      },
      write(chunk) {
        payload += chunk
        return true
      },
      end(chunk) {
        if (chunk !== undefined) payload += chunk
        resolve({ status, headers, payload })
      },
      destroy() {},
    }
    const pending = route.handler(req, res)
    if (body !== null) {
      const buffer = Buffer.from(body)
      listeners.data?.(buffer)
      listeners.end?.()
    } else {
      listeners.end?.()
    }
    Promise.resolve(pending).catch((error) => resolve({ status: 500, payload: String(error) }))
  })
}

const stateResponse = await callRoute('/situation/state')
const state = JSON.parse(stateResponse.payload)
assert(state.ok === true, 'state ok')
assert(state.control.hotkey === 'Ctrl+Alt+V', 'default hotkey is press once to start and again to stop')
assert(state.sensor.running === false, 'autoStart false leaves sensor stopped')
assert(typeof state.dataDir === 'string', 'state has dataDir')

const controlResponse = await callRoute('/situation/control', 'POST', JSON.stringify({ paused: true }))
const control = JSON.parse(controlResponse.payload)
assert(control.ok === true && control.state.control.paused === true, 'control pause applied')
const controlFile = JSON.parse(readFileSync(join(dataDir, 'control.json'), 'utf8'))
assert(controlFile.paused === true, 'control.json written')

const now = await tools.get('situation').execute({ action: 'now' }, {})
assert(typeof now.summary === 'string' && now.summary.includes('现场感知'), 'situation summary')
assert(Array.isArray(now.lines), 'situation lines array')

const log = await tools.get('situation_log').execute({ minutes: 5 }, {})
assert(typeof log.count === 'number', 'situation_log count')

const frame = await tools.get('situation_frame').execute({}, {})
assert(typeof frame.path === 'string', 'situation_frame path string')

const controlTool = await tools.get('situation_control').execute({ action: 'resume' }, {})
assert(controlTool.ok === true, 'situation_control resume')

const logRoute = await callRoute('/situation/log?minutes=5&limit=10')
assert(JSON.parse(logRoute.payload).ok === true, 'log route ok')

await tutorHostScenario()

for (const { label, dispose } of effects) {
  try { await dispose?.() } catch (error) { console.error(`dispose ${label}: ${error.message}`) }
}

console.log(JSON.stringify({
  ok: true,
  tools: [...tools.keys()],
  routes: routes.map((r) => `${r.kind}:${r.path}`),
  sections: sections.map((s) => s.name),
  injected,
  dataDir,
  controlFileWritten: existsSync(join(dataDir, 'control.json')),
}, null, 2))

async function tutorHostScenario() {
  const tutorDir = mkdtempSync(join(tmpdir(), 'situation-tutor-'))
  const sensor = join(tutorDir, 'mock-sensor.sh')
  writeFileSync(sensor, `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-OutDir" ]; then
    out=$arg
  fi
  prev=$arg
done
printf '%s\\n' '{"type":"ready","protocol":1,"pid":1,"hotkey":"Ctrl+Alt+V","hotkeyOk":true,"hotkeyHold":false,"hwnd":1,"ocr":"zh-Hans-CN","startedAt":"2026-01-01T00:00:00.000Z"}'
while true; do
  if [ -n "$out" ] && [ -f "$out/hotkey.trigger" ]; then
    rm -f "$out/hotkey.trigger"
    printf '%s\\n' '{"type":"hotkey","id":"toggle","ts":"2026-01-01T00:00:01.000Z","epoch":1}'
  fi
  sleep 0.05
done
`, 'utf8')
  chmodSync(sensor, 0o755)

  const applied = []
  const resolvedCalls = []
  const localRoutes = []
  const localEffects = []
  let tutorChild = null
  const agent = {
    status: 'idle',
    session: { id: 's1' },
    model: {
      current() { return { provider: 'old', model: 'old', reasoningEffort: 'max' } },
      set(value) { applied.push({ ...value }) },
    },
  }
  const webServer = { register(route) { localRoutes.push(route); return () => {} } }
  const systemPrompt = { section() { return () => {} } }
  const localCtx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(fn) { const dispose = fn(); localEffects.push({ dispose }); return dispose },
    inject(_deps, cb) {
      const child = Object.create(localCtx)
      child.webServer = webServer
      child.systemPrompt = systemPrompt
      cb(child)
      return () => {}
    },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'speechToText') return { ready: true }
      if (name === 'llm') return {
        async resolveCallConfig(input) {
          resolvedCalls.push(input)
          if (input.model === 'missing-model') throw new Error('unknown model')
          return { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort || 'high' }
        },
      }
      if (name === 'sessionController') return { async resolveAgent() { return { agent } } }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    tools: { register() { return () => {} } },
  }

  function tutorLaunch() {
    tutorChild = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      pid: 4242,
      kill() { this.exitCode = 0; this.emit('close', 0) },
    })
    tutorChild.stdin.once('finish', () => tutorChild.kill())
    return tutorChild
  }

  apply(localCtx, { dataDir: tutorDir, autoStart: true, sensorProgram: sensor, sensorScript: sensor, tutorLaunch })

  function call(path, method = 'GET', body = null) {
    const route = localRoutes.find((item) => item.path === path.split('?')[0])
    assert(route !== undefined, `tutor route ${path}`)
    return new Promise((resolve) => {
      const listeners = {}
      const req = {
        method,
        url: path,
        headers: {
          host: '127.0.0.1:26977',
          'content-type': 'application/json',
          'x-situation-tutor': '1',
          'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '127.0.0.1' },
        on(event, fn) { listeners[event] = fn; return req },
        destroy() {},
      }
      let status = 0
      let payload = ''
      const res = {
        writeHead(code) { status = code },
        write(chunk) { payload += chunk; return true },
        end(chunk) { if (chunk !== undefined) payload += chunk; resolve({ status, payload }) },
        destroy() {},
      }
      const pending = route.handler(req, res)
      if (body !== null) {
        listeners.data?.(Buffer.from(body))
        listeners.end?.()
      } else listeners.end?.()
      Promise.resolve(pending).catch((error) => resolve({ status: 500, payload: String(error) }))
    })
  }

  async function waitFor(predicate) {
    const start = Date.now()
    while (Date.now() - start < 4000) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(`timed out waiting for tutor host scenario`)
  }

  try {
    await waitFor(async () => {
      const state = JSON.parse((await call('/situation/state')).payload)
      return state.sensor?.ready === true && state.sensor?.hotkeyOk === true
    })

    const rejected = await call('/situation/tutor', 'POST', JSON.stringify({
      action: 'start',
      selection: { sessionId: 's1', provider: 'fixture', model: 'missing-model', reasoningEffort: null },
    }))
    assert(rejected.status === 400, `bad model should be 400, got ${rejected.status} ${rejected.payload}`)
    const afterReject = JSON.parse(readFileSync(join(tutorDir, 'control.json'), 'utf8'))
    assert(afterReject.paused !== true, 'a rejected start must not pause sensing')

    const clip = await call('/situation/control', 'POST', JSON.stringify({ clipboard: true }))
    assert(JSON.parse(clip.payload).ok === true, 'clipboard toggle before tutoring')

    const sse = []
    const eventsRoute = localRoutes.find((item) => item.path === '/situation/events')
    const sseReq = { on() { return sseReq }, headers: {} }
    eventsRoute.handler(sseReq, { writeHead() {}, write(chunk) { sse.push(String(chunk)); return true }, end() {} })

    writeFileSync(join(tutorDir, 'hotkey.trigger'), '1')
    await waitFor(() => sse.some((chunk) => chunk.includes('event: hotkey')))
    const hotkeyBefore = sse.filter((chunk) => chunk.includes('event: hotkey')).length

    const started = await call('/situation/tutor', 'POST', JSON.stringify({
      action: 'start',
      selection: { sessionId: 's1', provider: 'fixture', model: 'tutor-model', reasoningEffort: null },
    }))
    assert(started.status === 200, `start failed ${started.status} ${started.payload}`)
    const startedBody = JSON.parse(started.payload)
    assert(startedBody.state.tutor.active === true, 'tutor becomes active')
    assert(startedBody.state.tutor.phase === 'ready', 'observation starts without a second click')
    assert(startedBody.state.tutor.opened === false, 'window has not reported opened')
    assert(startedBody.state.control.paused === false, 'tutoring keeps the shared timeline recording')
    assert(resolvedCalls.at(-1).model === 'tutor-model', 'resolver saw the click-time model')
    assert(resolvedCalls.at(-1).reasoningEffort === undefined, 'null effort is omitted so the resolver can default it')
    assert(applied.at(-1)?.reasoningEffort === 'high', `default effort was not applied: ${JSON.stringify(applied)}`)
    assert(applied.at(-1).provider === 'fixture' && applied.at(-1).model === 'tutor-model', 'click-time model is applied')

    const watching = JSON.parse(readFileSync(join(tutorDir, 'control.json'), 'utf8'))
    assert(typeof watching.tutorId === 'string' && watching.tutorId.length > 0, 'tutor scope is armed immediately')
    assert(watching.paused === false, 'the sensor runs in tutor mode')
    assert(watching.tutorOverlayPid === 4242, 'overlay pid is excluded from capture')
    assert(watching.clipboard === false, 'clipboard capture is suspended while tutoring')

    writeFileSync(join(tutorDir, 'hotkey.trigger'), '1')
    await waitFor(async () => JSON.parse((await call('/situation/state')).payload).tutor?.phase === 'recording')
    const hotkeyAfter = sse.filter((chunk) => chunk.includes('event: hotkey')).length
    assert(hotkeyAfter === hotkeyBefore, 'once tutoring has started the hotkey toggles recording instead of the composer')

    const stopped = await call('/situation/tutor', 'POST', JSON.stringify({ action: 'stop' }))
    assert(stopped.status === 200, `stop failed ${stopped.status} ${stopped.payload}`)
    const restored = JSON.parse(stopped.payload)
    assert(restored.state.tutor.active === false, 'tutor stops')
    assert(restored.state.control.paused === false, 'the previous sensing state is restored')
    const file = JSON.parse(readFileSync(join(tutorDir, 'control.json'), 'utf8'))
    assert(file.paused === false, 'sensor file resumes')
    assert(file.tutorId === '', 'observation scope is cleared')
    assert(file.clipboard === true, 'the clipboard choice from before tutoring is restored')
    const settingsPath = join(tutorDir, 'settings.json')
    assert(existsSync(settingsPath), 'clipboard choice was persisted')
    assert(JSON.parse(readFileSync(settingsPath, 'utf8')).paused !== true, 'tutor must not persist paused=true')

    const again = await call('/situation/tutor', 'POST', JSON.stringify({
      action: 'start',
      selection: { sessionId: 's1', provider: 'fixture', model: 'tutor-model', reasoningEffort: null },
    }))
    assert(JSON.parse(again.payload).state.tutor.active === true, 'tutor can start again')
    const capture = await call('/situation/control', 'POST', JSON.stringify({ capture: false }))
    const captureBody = JSON.parse(capture.payload)
    assert(capture.status === 200 && captureBody.ok === true, 'capture toggle is not rejected while tutoring')
    assert(captureBody.state.tutor.active === true, 'capture toggle does not end tutoring')
    const paused = await call('/situation/control', 'POST', JSON.stringify({ paused: true }))
    const pausedBody = JSON.parse(paused.payload)
    assert(paused.status === 200 && pausedBody.ok === true, 'pause while tutoring is not a 409')
    assert(pausedBody.state.tutor.active === false, 'pause ends the tutor instead of deadlocking')
    assert(pausedBody.state.control.paused === true, 'pause applies after the tutor stops')
  } finally {
    for (const { dispose } of localEffects) {
      try { await dispose?.() } catch { /* the scenario reports its own assertion */ }
    }
  }
}
