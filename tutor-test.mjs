import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createTutor } from './tutor.js'

function fixture({ vision = false, failOnce = false, maxImages, contextWindow, failAdmit = false, failAfterAsk = false, admitImages, admitBytes, memoryCap } = {}) {
  const sent = []
  const requests = []
  const errors = []
  let admits = 0
  let followups = 0
  let scope
  let transcriptions = 0
  let stops = 0
  let restrictions = 0
  let guard
  const events = new EventEmitter()
  const session = { events: [] }
  const on = (key, callback) => {
    events.on(key, callback)
    return () => events.off(key, callback)
  }
  const selection = { provider: 'local-test', model: 'tutor-test', reasoningEffort: 'max' }
  const modelApi = {
    value: selection,
    current() { return this.value },
    set(next) { this.value = { ...next } },
  }
  const agent = {
    status: 'idle', session, inbox: { nextTurn: [] }, model: modelApi,
    ctx: { on, get: () => ({
      restrict(options) {
        assert.deepEqual(options, { allow: [] })
        restrictions++
        return () => restrictions--
      },
      guard(callback) { guard = callback; return () => { guard = undefined } },
    }) },
    async followup(message) {
      followups++
      if (failAfterAsk) {
        this.status = 'running'
        throw new Error('socket reset')
      }
      this.status = 'running'
      const chosen = this.model.current()
      const turn = requests.length + 1
      events.emit('agent/inbox/claimed', { agent, message, turn })
      const enter = events.listeners('agent/pre-step')[0]
      const initial = { kind: 'enter', messages: [message] }
      const decision = await enter({ agent, messages: [message] }, async () => initial)
      const replay = await enter({ agent, messages: decision.messages }, async () => ({ kind: 'enter', messages: decision.messages }))
      assert.equal(replay.messages.length, decision.messages.length, 'pre-step must not append the same observations twice')
      assert.equal(restrictions, 1)
      assert.ok(guard())
      requests.push({ provider: chosen.provider, model: chosen.model, reasoningEffort: chosen.reasoningEffort, messages: replay.messages })
      for (const item of decision.messages) session.events.push({ type: 'user/message', data: item })
      const frame = { attemptId: `attempt-${turn}` }
      events.emit('agent/assistant-stream', { agent, frame: { ...frame, type: 'start', turn } })
      const text = '先看到安装教程，再看到终端报错。下一步验证依赖版本。'
      const failed = failOnce && turn === 1
      if (!failed) {
        for (const chunk of [{ type: 'reasoning-delta', text: 'hidden analysis' }, { type: 'text-delta', text }]) {
          events.emit('agent/assistant-stream', { agent, frame: { ...frame, type: 'chunk', chunk } })
        }
        const record = { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } }
        session.events.push(record)
        events.emit('session/event', session, record)
      }
      events.emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: failed ? 'error' : 'completed' } } })
      this.status = 'idle'
    },
  }
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, pid: 4242,
    kill() { this.exitCode = 0; this.emit('close') },
  })
  child.stdin.setEncoding('utf8').on('data', (line) => sent.push(JSON.parse(line)))
  child.stdin.once('end', () => child.kill())
  const services = {
    llm: { async resolveModelInfo(_provider, model) {
      if (model === 'text-only') return { inputModalities: ['text'] }
      return {
        inputModalities: vision ? ['text', 'image'] : ['text'],
        ...(maxImages ? { maxImages } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      }
    } },
    sessionController: { async resolveAgent(id) { assert.equal(id, 'originating-chat'); return { agent } } },
    speechToText: {
      snapshot: () => ({ providers: [
        { id: 'remote', location: 'remote', languages: ['auto'] },
        { id: 'local', location: 'host-local', languages: ['auto'] },
      ], selection: { providerId: 'remote', language: 'auto' } }),
      resolve(input) {
        assert.equal(input.providerId, 'local')
        return { ...input, provider: { info: { location: 'host-local' } } }
      },
      async transcribe() { transcriptions++; return { text: '我卡在哪了？' } },
    },
    attachments: {
      ...(admitImages || admitBytes ? { imageLimits: {
        ...(admitImages ? { maxImagesPerMessage: admitImages } : {}),
        ...(admitBytes ? { maxMessageImageBytes: admitBytes } : {}),
      } } : {}),
      async admitPromptContent(blocks) {
        admits++
        const images = blocks.filter((block) => block.type === 'image')
        if (admitImages && images.length > admitImages) {
          throw Object.assign(new Error('Image batch exceeds the configured image-count limit.'), { code: 'TOO_MANY_IMAGES' })
        }
        if (admitBytes && images.length > 1) {
          const bytes = images.reduce((sum, block) => sum + Math.floor(String(block.data ?? '').length * 0.75), 0)
          if (bytes > admitBytes) {
            throw Object.assign(new Error('Image batch exceeds the configured image-count limit.'), { code: 'TOO_MANY_IMAGES' })
          }
        }
        if (failAdmit === 'always' || (failAdmit === 'first' && admits === 1 && images.length > 0)) {
          const error = new Error('Image batch exceeds the configured image-count limit.')
          if (failAdmit === 'always') error.code = 'TOO_MANY_IMAGES'
          throw error
        }
        return blocks.map((block) => block.type === 'image' ? { type: 'image', attachment: block.data } : block)
      },
    },
  }
  const tutor = createTutor({ ctx: { on, get: (key) => services[key] }, script: 'desktop.ps1', memoryCap,
    onChange() {}, onStart(id) { scope = id }, onStop() { stops++ }, onError(message) { errors.push(message) }, launch: () => child })
  const event = (payload) => child.stdout.write(`${JSON.stringify(payload)}\n`)
  const sample = (hwnd, content, extra = {}) => tutor.observe({
    tutorId: scope, epoch: Date.now(), ts: '10:00:00', hwnd, pid: hwnd + 100,
    app: `app-${hwnd}`, changed: true, ocr: { text: content }, jpeg: `pic-${hwnd}`, ...extra,
  })
  const wav = Buffer.alloc(48)
  wav.write('RIFF')
  return { tutor, agent, session, services, sent, requests, errors, event, sample, wav: wav.toString('base64'),
    get scope() { return scope },
    restrictions: () => restrictions, transcriptions: () => transcriptions, stops: () => stops,
    followups: () => followups, admits: () => admits }
}

test('a question sends the whole session timeline, typed text and every distinct frame', async (t) => {
  const f = fixture({ vision: true })
  t.after(() => f.tutor.stop())
  const base = Date.now() - 20_000
  assert.equal(f.tutor.start('originating-chat', 'Ctrl+Alt+V', false), true)
  assert.equal(f.tutor.observing(), true)
  assert.equal(f.tutor.state().phase, 'ready')
  assert.match(f.sent.at(-1).text, /按一次开始，再按一次发送/)
  f.tutor.record({ type: 'window', tutorId: f.scope, epoch: base + 1000, ts: '10:00:01', app: 'Code', title: 'client.js', hwnd: 11, pid: 10 })
  f.tutor.record({ type: 'click', tutorId: f.scope, epoch: base + 2000, ts: '10:00:02', button: 'left', x: 12, y: 40, app: 'Code', title: 'client.js', hwnd: 11, pid: 10 })
  f.tutor.record({ type: 'sample', tutorId: f.scope, epoch: base + 2100, ts: '10:00:02', changed: true, app: 'Code', title: 'client.js', hwnd: 11, pid: 10, ocr: { text: '安装步骤' }, jpeg: 'frame-click' })
  f.tutor.record({ type: 'window', tutorId: f.scope, epoch: base + 4000, ts: '10:00:04', app: 'notepad', title: '笔记.txt', hwnd: 22, pid: 20 })
  f.tutor.record({ type: 'sample', tutorId: f.scope, epoch: base + 9000, ts: '10:00:09', changed: true, app: 'notepad', title: '笔记.txt', hwnd: 22, pid: 20, ocr: { text: '记事本正文' }, jpeg: 'frame-latest' })
  f.tutor.record({ type: 'click', tutorId: f.scope, epoch: base + 5000, ts: '10:00:05', button: 'right', x: 300, y: 80, app: 'notepad', title: '笔记.txt', hwnd: 22, pid: 20 })
  f.tutor.record({ type: 'keys', tutorId: f.scope, epoch: base + 6000, ts: '10:00:06', phase: 'end', text: 'hello world', app: 'notepad', title: '笔记.txt', hwnd: 22, pid: 20 })
  f.tutor.record({ type: 'window', tutorId: f.scope, epoch: base + 7000, ts: '10:00:07', app: 'powershell', title: 'DSH 学习助手', hwnd: 77, pid: 4242 })
  f.tutor.record({ type: 'sample', tutorId: 'old-session', epoch: base + 8000, ts: '10:00:08', changed: true, ocr: { text: 'Previous session' }, jpeg: 'old' })
  f.tutor.record({ type: 'click', tutorId: f.scope, epoch: base - 130_000, ts: '09:00:00', button: 'middle', x: 1, y: 1, app: 'old', title: 'expired' })
  assert.equal(f.requests.length, 0)
  f.tutor.hotkey('toggle')
  assert.equal(f.tutor.state().phase, 'recording')
  assert.match(f.sent.findLast(({ type }) => type === 'display').text, /再按一次/)
  f.tutor.hotkey('toggle')
  assert.equal(f.tutor.state().phase, 'processing')
  f.event({ type: 'audio', wav: f.wav })
  f.event({ type: 'audio', wav: f.wav })
  await setImmediate()
  assert.equal(f.transcriptions(), 1)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].provider, 'local-test')
  assert.equal(f.requests[0].reasoningEffort, 'max')
  const [question, observation] = f.requests[0].messages
  assert.deepEqual(question.content, [{ type: 'text', text: '我卡在哪了？' }])
  const { content } = observation
  assert.match(content[0].text, /中键点击 \(1,1\)[\s\S]*切换到 Code「client\.js」[\s\S]*左键点击 \(12,40\)[\s\S]*安装步骤[\s\S]*切换到 notepad「笔记\.txt」[\s\S]*右键点击 \(300,80\)[\s\S]*输入「hello world」[\s\S]*记事本正文/)
  assert.doesNotMatch(content[0].text, /DSH 学习助手|Previous session/)
  assert.deepEqual(content.filter((block) => block.type === 'image').map((block) => block.attachment), ['frame-click', 'frame-latest'])
  assert.match(f.sent.at(-1).text, /验证依赖版本/)
  assert.doesNotMatch(f.sent.at(-1).text, /hidden analysis/)
  assert.equal(f.restrictions(), 0)
  f.event({ type: 'close' })
  assert.equal(f.stops(), 1)
  assert.equal(f.tutor.active(), false)
})

test('text-only fallback, silence and manual retry never send unrequested calls', async (t) => {
  const f = fixture({ failOnce: true })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  f.event({ type: 'activate' })
  f.sample(1, 'Installation prerequisites')
  f.tutor.hotkey('toggle')
  f.tutor.hotkey('toggle')
  f.event({ type: 'audio', wav: '' })
  assert.match(f.sent.at(-1).text, /没听到/)
  assert.equal(f.requests.length, 0)
  f.tutor.hotkey('toggle')
  f.tutor.hotkey('toggle')
  f.event({ type: 'audio', wav: f.wav })
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sent.at(-1).retry, true)
  f.event({ type: 'retry' })
  await setImmediate()
  assert.equal(f.requests.length, 2)
  assert.equal(f.transcriptions(), 1)
  assert.equal(f.requests[1].messages[1].content.length, 1)
  assert.equal(f.restrictions(), 0)
  assert.equal(f.sent.at(-1).phase, 'ready')
})

test('a busy originating chat leaves the voice question available for retry', async (t) => {
  const f = fixture()
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'B+Space')
  f.event({ type: 'activate' })
  f.agent.status = 'running'
  f.tutor.hotkey('toggle')
  f.tutor.hotkey('toggle')
  f.event({ type: 'audio', wav: f.wav })
  await setImmediate()
  assert.match(f.sent.at(-1).text, /会话正在回答/)
  assert.equal(f.sent.at(-1).retry, true)
  assert.equal(f.requests.length, 0)
  assert.equal(f.restrictions(), 0)
  f.agent.status = 'idle'
  f.event({ type: 'retry' })
  await setImmediate()
  assert.equal(f.transcriptions(), 1)
  assert.equal(f.requests.length, 1)
  assert.equal(f.session.events.at(-1).type, 'assistant/message')
  assert.equal(f.restrictions(), 0)
})

test('the question keeps the model and effort selected when tutoring started', async (t) => {
  const f = fixture({ vision: true })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V', false, {
    provider: 'picked', model: 'text-only', reasoningEffort: 'low',
  }, f.agent)
  assert.equal(f.agent.model.current().model, 'text-only')
  assert.equal(f.agent.model.current().reasoningEffort, 'low')
  f.agent.model.set({ provider: 'changed', model: 'changed-model', reasoningEffort: 'max' })
  f.event({ type: 'activate' })
  f.sample(4, 'Still the pinned model')
  f.tutor.hotkey('toggle')
  f.tutor.hotkey('toggle')
  f.event({ type: 'audio', wav: f.wav })
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].provider, 'picked')
  assert.equal(f.requests[0].model, 'text-only')
  assert.equal(f.requests[0].reasoningEffort, 'low')
  assert.equal(f.requests[0].messages[1].content.length, 1)
  assert.equal(f.agent.model.current().provider, 'changed')
})

test('events from the whole tutoring session stay in the timeline', async (t) => {
  const f = fixture()
  const realNow = Date.now
  t.after(() => {
    Date.now = realNow
    f.tutor.stop()
  })
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  f.event({ type: 'activate' })
  const start = realNow()
  Date.now = () => start
  f.sample(1, 'fresh observation')
  Date.now = () => start + 120_001
  f.tutor.hotkey('toggle')
  f.tutor.hotkey('toggle')
  f.event({ type: 'audio', wav: f.wav })
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.match(f.requests[0].messages[1].content[0].text, /fresh observation/)
})

test('a lost recording returns to ready without calling the model', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture()
  t.after(() => {
    f.tutor.stop()
    t.mock.timers.reset()
  })
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  f.event({ type: 'activate' })
  f.tutor.hotkey('toggle')
  f.tutor.hotkey('toggle')
  assert.equal(f.tutor.state().phase, 'processing')
  t.mock.timers.tick(10_001)
  assert.equal(f.tutor.state().phase, 'ready')
  assert.match(f.sent.at(-1).text, /没有收到录音/)
  assert.equal(f.requests.length, 0)
  assert.equal(f.transcriptions(), 0)
})

function ask(f) {
  f.tutor.hotkey('toggle')
  f.tutor.hotkey('toggle')
  f.event({ type: 'audio', wav: f.wav })
}

function addFrames(f, count) {
  const base = Date.now() - 60_000
  for (let index = 0; index < count; index++) {
    f.tutor.record({
      type: 'sample', tutorId: f.scope, epoch: base + index * 1000, ts: `10:00:${String(index).padStart(2, '0')}`,
      changed: true, app: 'Code', title: `step-${index}`, ocr: { text: `ocr-${index}` }, jpeg: `jpeg-${index}`,
    })
  }
}

function imagesOf(request) {
  return request.messages[1].content.filter((block) => block.type === 'image').map((block) => block.attachment)
}

function imagesIn(message) {
  return message.content.filter((block) => block.type === 'image').map((block) => block.attachment)
}

test('keyframes stay in time order inside one turn and the question is asked once', async (t) => {
  const f = fixture({ vision: true, maxImages: 2 })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  addFrames(f, 5)
  ask(f)
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.equal(f.followups(), 1)
  const messages = f.requests[0].messages
  assert.equal(messages.length, 4)
  assert.equal(messages[0].content[0].text, '我卡在哪了？')
  assert.equal(messages.filter((message) => message.content?.[0]?.text === '我卡在哪了？').length, 1)
  assert.equal(messages[0].source.kind, 'user')
  assert.deepEqual(imagesIn(messages[1]), ['jpeg-0', 'jpeg-1'])
  assert.deepEqual(imagesIn(messages[2]), ['jpeg-2', 'jpeg-3'])
  assert.deepEqual(imagesIn(messages[3]), ['jpeg-4'])
  assert.match(messages[1].content[0].text, /第 1\/3 批/)
  assert.match(messages[3].content[0].text, /第 3\/3 批/)
  assert.match(messages[3].content[0].text, /全部操作/)
  assert.doesNotMatch(messages[1].content[0].text, /全部操作|我卡在哪了/)
  assert.ok(messages.slice(1).every((message) => message.source.kind === '桌面辅导'))
  const visible = messages.map((message) => message.content.map((part) => part.text || '').join('')).join('\n')
  assert.doesNotMatch(visible, /请阅读桌面画面/)
  const progress = f.sent.filter((item) => item.type === 'display').map((item) => item.text).join('\n')
  assert.match(progress, /正在整理画面 1\/3/)
  assert.match(progress, /正在整理画面 2\/3/)
  assert.match(progress, /正在整理画面 3\/3/)
})

test('a failed batch falls back to a visible text summary before any question is sent', async (t) => {
  const f = fixture({ vision: true, maxImages: 2, failAdmit: 'first' })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  addFrames(f, 5)
  ask(f)
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.equal(f.followups(), 1)
  assert.match(f.requests[0].messages[0].content[0].text, /我卡在哪了/)
  assert.match(f.requests[0].messages[1].content[0].text, /较早画面的文字摘要[\s\S]*ocr-0/)
  assert.deepEqual(imagesOf(f.requests[0]), ['jpeg-3', 'jpeg-4'])
  assert.match(f.sent.map((item) => item.text || '').join('\n'), /较早的 3 帧已改为文字摘要/)
  assert.match(f.errors[0], /画面批次附带失败/)
  await setImmediate()
  assert.equal(f.followups(), 1)
})

test('attachment image cap splits one turn and never admits an oversized batch', async (t) => {
  const f = fixture({ vision: true, admitImages: 2 })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  addFrames(f, 5)
  ask(f)
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.equal(f.followups(), 1)
  const observations = f.requests[0].messages.slice(1)
  assert.equal(observations.length, 3)
  assert.deepEqual(observations.map((message) => imagesIn(message)), [
    ['jpeg-0', 'jpeg-1'],
    ['jpeg-2', 'jpeg-3'],
    ['jpeg-4'],
  ])
  assert.equal(f.errors.length, 0)
})

test('attachment byte cap keeps each observation inside one message', async (t) => {
  const f = fixture({ vision: true, admitBytes: 10 })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  const base = Date.now() - 60_000
  for (let index = 0; index < 3; index++) {
    f.tutor.record({
      type: 'sample', tutorId: f.scope, epoch: base + index * 1000, ts: `10:00:0${index}`,
      changed: true, app: 'Code', title: `step-${index}`, ocr: { text: `ocr-${index}` },
      jpeg: `${index}${'b'.repeat(40)}`,
    })
  }
  ask(f)
  await setImmediate()
  assert.equal(f.requests.length, 1)
  const observations = f.requests[0].messages.slice(1)
  assert.equal(observations.length, 3)
  assert.ok(observations.every((message) => imagesIn(message).length === 1))
  assert.equal(f.errors.length, 0)
})

test('a turn keeps at most 16 frames and summarizes the older ones', async (t) => {
  const f = fixture({ vision: true, maxImages: 10 })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  addFrames(f, 20)
  ask(f)
  await setImmediate()
  assert.equal(f.requests.length, 1)
  const images = f.requests[0].messages.slice(1).flatMap((message) => imagesIn(message))
  assert.equal(images.length, 16)
  assert.equal(images[0], 'jpeg-4')
  assert.equal(images.at(-1), 'jpeg-19')
  assert.match(f.requests[0].messages.at(-1).content[0].text, /较早画面的文字摘要[\s\S]*ocr-0/)
  assert.match(f.sent.map((item) => item.text || '').join('\n'), /较早的 4 帧已改为文字摘要/)
})

test('image admission failure before the turn retries once as text', async (t) => {
  const f = fixture({ vision: true, failAdmit: 'always' })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  f.sample(1, 'only text remains')
  ask(f)
  await setImmediate()
  assert.equal(f.followups(), 1)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(imagesOf(f.requests[0]), [])
  assert.match(f.requests[0].messages[1].content[0].text, /only text remains/)
  assert.match(f.errors[0], /辅导回答失败：Image batch exceeds/)
  assert.equal(f.errors.length, 1)
  await setImmediate()
  assert.equal(f.followups(), 1)
})

test('a failure after the turn is submitted does not ask again', async (t) => {
  const f = fixture({ failAfterAsk: true })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  f.sample(1, 'kept for retry')
  ask(f)
  await setImmediate()
  assert.equal(f.followups(), 1)
  assert.equal(f.requests.length, 0)
  assert.match(f.errors[0], /socket reset/)
  assert.match(f.sent.map((item) => item.text || '').join('\n'), /未能完成回答/)
  await setImmediate()
  assert.equal(f.followups(), 1)
})

test('a context window smaller than the frames uses the same visible summary', async (t) => {
  const f = fixture({ vision: true, maxImages: 2, contextWindow: 1 })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  addFrames(f, 5)
  ask(f)
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.match(f.requests[0].messages[1].content[0].text, /ocr-0/)
  assert.deepEqual(imagesOf(f.requests[0]), ['jpeg-3', 'jpeg-4'])
  assert.match(f.sent.map((item) => item.text || '').join('\n'), /较早的 3 帧已改为文字摘要/)
})

test('duplicate frames are not stored again and the whole session stays available', async (t) => {
  const f = fixture({ vision: true })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  const base = Date.now() - 10_000
  f.tutor.record({ type: 'sample', tutorId: f.scope, epoch: base, ts: '10:00:01', changed: true, ocr: { text: 'only once' }, jpeg: 'same-picture' })
  f.tutor.record({ type: 'sample', tutorId: f.scope, epoch: base + 1000, ts: '10:00:02', duplicate: true, changed: false })
  ask(f)
  await setImmediate()
  assert.deepEqual(imagesOf(f.requests[0]), ['same-picture'])
  assert.match(f.requests[0].messages[1].content[0].text, /only once/)
})

test('memory pressure drops old pictures but keeps their text', async (t) => {
  const f = fixture({ vision: true, memoryCap: 400 })
  t.after(() => f.tutor.stop())
  f.tutor.start('originating-chat', 'Ctrl+Alt+V')
  const jpeg = 'x'.repeat(400)
  const base = Date.now() - 10_000
  for (let index = 0; index < 3; index++) {
    f.tutor.record({
      type: 'sample', tutorId: f.scope, epoch: base + index, ts: `10:00:0${index}`, changed: true,
      ocr: { text: `kept-${index}` }, jpeg: `${jpeg}${index}`,
    })
  }
  ask(f)
  await setImmediate()
  f.tutor.record({
    type: 'sample', tutorId: f.scope, epoch: base + 10, ts: '10:00:09', changed: true,
    ocr: { text: 'newest' }, jpeg: `${jpeg}9`,
  })
  ask(f)
  await setImmediate()
  assert.match(f.requests.at(-1).messages[1].content[0].text, /kept-0/)
  assert.deepEqual(imagesOf(f.requests.at(-1)), [`${jpeg}9`])
})

test('a desktop process that fails to launch is reported and does not stay active', () => {
  const errors = []
  const tutor = createTutor({
    ctx: { on() { return () => {} }, get() { return undefined } },
    script: 'missing-desktop.ps1',
    onChange() {},
    onStart() {},
    onStop() {},
    onError(message) { errors.push(message) },
    launch() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  })
  assert.equal(tutor.start('chat', 'Ctrl+Alt+V'), false)
  assert.equal(tutor.active(), false)
  assert.match(tutor.state().error, /启动失败/)
  assert.equal(errors[0], tutor.state().error)
})
