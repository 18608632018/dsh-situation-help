// End-to-end supervisor test with a mock PowerShell sensor (no real capture).
// Run: node host-e2e-test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './index.js'

const dataDir = mkdtempSync(join(tmpdir(), 'situation-e2e-'))
const mock = join(dirname(fileURLToPath(import.meta.url)), 'sensor', 'mock-sense.ps1')
const tools = new Map()
const routes = []
const effects = []
const injects = []

const fakeAgent = {
  id: 'agent-1',
  status: 'running',
  inject(message) { injects.push(message) },
}

const webServer = { register(route) { routes.push(route); return () => {} } }
const systemPrompt = { section() { return () => {} } }

const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  effect(fn, label) { const dispose = fn(); effects.push({ label, dispose }); return dispose },
  inject(deps, cb) {
    const child = Object.create(ctx)
    child.webServer = webServer
    child.systemPrompt = systemPrompt
    child.agents = { list: () => [fakeAgent] }
    child.speechToText = undefined
    cb(child)
    return () => {}
  },
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'systemPrompt') return systemPrompt
    if (name === 'agents') return { list: () => [fakeAgent] }
    return undefined
  },
  tools: {
    register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
  },
}

apply(ctx, { dataDir, sensorScript: mock, intervalMs: 300, autoStart: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await sleep(2600)

const route = (path) => routes.find((r) => r.path === path)
function callGet(path) {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: path, on() { return req } }
    let payload = ''
    const res = {
      writeHead() {},
      write(chunk) { payload += chunk; return true },
      end(chunk) { if (chunk !== undefined) payload += chunk; resolve(payload) },
      destroy() {},
    }
    route(path.split('?')[0]).handler(req, res)
  })
}

const state = JSON.parse(await callGet('/situation/state'))
const now = await tools.get('situation').execute({ action: 'now' }, {})
const log = await tools.get('situation_log').execute({ minutes: 60, limit: 10 }, {})

const assertions = {
  sensorReady: state.sensor.ready === true,
  sensorRunning: state.sensor.running === true,
  hasWindow: typeof state.current.app === 'string' && state.current.app !== '',
  receivedFrames: state.counters.frames > 0,
  recognizedText: state.counters.ocrs > 0,
  currentWindowCapture: state.latest.app === '' || state.latest.app === state.current.app,
  windowHistory: Array.isArray(state.recent) && state.recent.some((e) => e.kind === 'window'),
  injectedContext: injects.length > 0,
  toolSummary: now.summary.includes('当前窗口'),
  logCount: log.count > 0,
  counters: state.counters.samples > 2,
}

console.log(JSON.stringify({ assertions, injectSample: injects[0] ?? null, state: { current: state.current, latest: state.latest, counters: state.counters } }, null, 2))

for (const { dispose } of effects) {
  try { await dispose?.() } catch { /* ignore */ }
}

const failed = Object.entries(assertions).filter(([, ok]) => !ok)
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map(([k]) => k).join(', ')}`)
  process.exit(1)
}
console.log('E2E_OK')
