import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { FreePiAdapter, loadInstallSecret } from '../index.js'

const originalFetch = globalThis.fetch
const options = (model = 'm') => ({ model, messages: [] })
async function failureOf(adapter, request = options()) {
  try { for await (const _chunk of adapter.stream(request)) {} } catch (error) { return error }
  assert.fail('expected stream to fail')
}
function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function streamResponse(text = 'Hello') {
  return new Response(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`, { status: 200 })
}
async function consume(adapter, request) {
  const chunks = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}

test('install key: accepts only server-sized keys and enforces private mode on existing files', () => {
  const home = mkdtempSync(join(tmpdir(), 'freepi-key-'))
  try {
    const key = `fpi_${'a'.repeat(32)}`
    const file = join(home, 'freepi-install.json')
    writeFileSync(file, JSON.stringify({ secret: key }), { mode: 0o644 })
    assert.equal(loadInstallSecret(home), key)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    writeFileSync(file, JSON.stringify({ secret: `fpi_${'b'.repeat(97)}` }), { mode: 0o600 })
    assert.match(loadInstallSecret(home), /^fpi_[A-Za-z0-9_-]{43}$/)
    assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).secret, `fpi_${'b'.repeat(97)}`)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('install key: concurrent first runs use the same exclusive-create winner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'freepi-key-race-'))
  const script = `import { loadInstallSecret } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}; process.stdout.write(loadInstallSecret(process.argv[1]))`
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, home], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part })
    child.stderr.setEncoding('utf8').on('data', part => { stderr += part })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)))
  })
  try {
    const [first, second] = await Promise.all([run(), run()])
    assert.equal(first, second)
    assert.match(first, /^fpi_[A-Za-z0-9_-]{43}$/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('catalog: Auto sends the server default_model and sectioned entries stay listed', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  let completionBody
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/client-version')) return response(200, {
      model: 'display-model',
      default_model: 'picker-default',
      models: [
        { id: 'picker-default', name: 'Picker default', section: 'Models' },
        { id: 'other', name: 'Other', section: 'Other models' },
        { id: 'hidden', unavailable: true },
      ],
    })
    completionBody = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', { status: 200 })
  }
  try {
    const listed = await adapter.listModels('freepi')
    assert.deepEqual(listed.map(model => model.id), ['auto', 'picker-default', 'other'])
    for await (const _chunk of adapter.stream(options('auto'))) {}
    assert.equal(completionBody.model, 'picker-default')
  } finally { globalThis.fetch = originalFetch }
})

test('catalog: falls back to the display model when the server sends no default_model', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  let completionBody
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/client-version')) return response(200, {
      model: 'display-model', models: [{ id: 'listed-first', name: 'Listed first', section: 'Group' }],
    })
    completionBody = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', { status: 200 })
  }
  try {
    for await (const _chunk of adapter.stream(options('auto'))) {}
    assert.equal(completionBody.model, 'display-model')
  } finally { globalThis.fetch = originalFetch }
})

test('errors: global cap is a nonretryable refusal with the server message', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  globalThis.fetch = async () => response(503, { error: { code: 'global_cap', message: 'The daily global cap is full.' } })
  try {
    const error = await failureOf(adapter)
    assert.equal(error.code, 'FREEPI_GLOBAL_CAP')
    assert.equal(error.message, 'The daily global cap is full.')
    assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(error.code), false)
  } finally { globalThis.fetch = originalFetch }
})

test('errors: an unrecognized 5xx response remains a retryable server failure', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  globalThis.fetch = async () => response(502, { error: { code: 'maintenance', message: 'Planned downtime' } })
  try {
    const error = await failureOf(adapter)
    assert.equal(error.code, 'SERVER')
    assert.equal(error.message, 'FreePi had a problem answering. Retry in a moment.')
  } finally { globalThis.fetch = originalFetch }
})

test('errors: context ceiling uses the harness context overflow code', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  globalThis.fetch = async () => response(400, { error: { code: 'context_ceiling', message: 'prompt is too large' } })
  try { assert.equal((await failureOf(adapter)).code, 'CONTEXT_WINDOW_EXCEEDED') }
  finally { globalThis.fetch = originalFetch }
})

test('errors: upstream rate limit carries the Retry-After delay', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  globalThis.fetch = async () => response(429, { error: { code: 'upstream_rate_limited', message: 'Try later' } }, { 'retry-after': '3' })
  try {
    const error = await failureOf(adapter)
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.failure.providerRetryAfterMs, 3000)
    assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(error.code), true)
  } finally { globalThis.fetch = originalFetch }
})

test('sessions: same-session streams queue through full response consumption', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  let active = 0
  let overlap = false
  globalThis.fetch = async (_url, init = {}) => {
    assert.equal(init.headers['x-session-id'], 'same')
    if (++active > 1) {
      overlap = true
      active--
      return response(429, { error: { code: 'concurrent', message: 'one request at a time' } })
    }
    return new Response(new ReadableStream({
      async start(controller) {
        await new Promise(resolve => setTimeout(resolve, 20))
        controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`))
        controller.close()
        active--
      },
      cancel() { active-- },
    }), { status: 200 })
  }
  try {
    const request = { ...options(), sessionId: 'same' }
    const results = await Promise.all([consume(adapter, request), consume(adapter, request)])
    assert.equal(overlap, false)
    assert.equal(results.length, 2)
    assert.ok(results.every(chunks => chunks.length > 0))
  } finally { globalThis.fetch = originalFetch }
})

test('sessions: same-tick normal turn reaches fetch before an auxiliary request', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  const order = []
  globalThis.fetch = async (_url, init = {}) => {
    order.push(JSON.parse(init.body).messages[0]?.content ?? 'empty')
    return streamResponse()
  }
  try {
    await Promise.all([
      consume(adapter, { ...options(), messages: [{ role: 'user', content: [{ type: 'text', text: 'title' }] }], sessionId: 'same', purpose: 'session-title' }),
      consume(adapter, { ...options(), messages: [{ role: 'user', content: [{ type: 'text', text: 'turn' }] }], sessionId: 'same' }),
    ])
    assert.deepEqual(order, ['turn', 'title'])
  } finally { globalThis.fetch = originalFetch }
})

test('sessions: different session ids can fetch concurrently', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  let active = 0
  let maximum = 0
  let bothStarted
  const started = new Promise(resolve => { bothStarted = resolve })
  globalThis.fetch = async () => {
    active++
    maximum = Math.max(maximum, active)
    if (active === 2) bothStarted()
    await started
    const result = streamResponse()
    active--
    return result
  }
  try {
    await Promise.all([
      consume(adapter, { ...options(), sessionId: 'one' }),
      consume(adapter, { ...options(), sessionId: 'two' }),
    ])
    assert.equal(maximum, 2)
  } finally { globalThis.fetch = originalFetch }
})

test('sessions: aborted queued waiter leaves the queue and the next waiter runs', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      await firstGate
      return streamResponse('first')
    }
    return streamResponse('next')
  }
  try {
    const first = consume(adapter, { ...options(), sessionId: 'same' })
    await new Promise(resolve => setImmediate(resolve))
    const controller = new AbortController()
    const waiter = consume(adapter, { ...options(), sessionId: 'same', signal: controller.signal })
    const next = consume(adapter, { ...options(), sessionId: 'same' })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('waiter aborted'))
    releaseFirst()
    const [firstResult, waiterResult, nextResult] = await Promise.allSettled([first, waiter, next])
    assert.equal(firstResult.status, 'fulfilled')
    assert.equal(waiterResult.status, 'rejected')
    assert.equal(waiterResult.reason.message, 'waiter aborted')
    assert.equal(nextResult.status, 'fulfilled')
    assert.equal(calls, 2)
  } finally { globalThis.fetch = originalFetch }
})

test('sessions: stopping a stream early releases its session slot', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      let sent = false
      let pending
      const body = {
        [Symbol.asyncIterator]() { return this },
        next() {
          if (!sent) {
            sent = true
            return Promise.resolve({ value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n'), done: false })
          }
          return new Promise(resolve => { pending = resolve })
        },
        return() {
          pending?.({ done: true })
          return Promise.resolve({ done: true })
        },
      }
      return { ok: true, body }
    }
    return streamResponse('next')
  }
  try {
    const first = adapter.stream({ ...options(), sessionId: 'same' })
    for await (const _chunk of first) break
    await consume(adapter, { ...options(), sessionId: 'same' })
    assert.equal(calls, 2)
  } finally { globalThis.fetch = originalFetch }
})

test('errors: concurrent session refusal is retryable with a short provider delay', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  globalThis.fetch = async () => response(429, { error: { code: 'concurrent', message: 'one request at a time, 12 credits left today' } })
  try {
    const error = await failureOf(adapter, { ...options(), sessionId: 'same' })
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.failure.providerRetryAfterMs, 1500)
    assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(error.code), true)
  } finally { globalThis.fetch = originalFetch }
})

test('stream: body read failures become transport errors unless aborted', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  globalThis.fetch = async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() { throw new Error('socket reset') } } })
  try { assert.equal((await failureOf(adapter)).code, 'TRANSPORT') }
  finally { globalThis.fetch = originalFetch }
})

test('stream: aborted body read preserves the abort error', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  const controller = new AbortController()
  const abortError = new Error('aborted')
  globalThis.fetch = async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() { controller.abort(); throw abortError } } })
  try { assert.equal(await failureOf(adapter, { ...options(), signal: controller.signal }), abortError) }
  finally { globalThis.fetch = originalFetch }
})

test('queue: a slot the server has not freed yet is asked for again, unseen by the harness', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return response(429, { error: { code: 'concurrent', message: 'one request at a time' } })
    return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 })
  }
  try {
    const chunks = []
    for await (const chunk of adapter.stream({ ...options(), sessionId: 's-retry' })) chunks.push(chunk)
    assert.equal(calls, 2)
    assert.equal(chunks.at(-1).type, 'finish')
  } finally { globalThis.fetch = originalFetch }
})

test('queue: cancelling while waiting to ask again ends the request at once', async () => {
  const adapter = new FreePiAdapter('https://gateway.test', 'fpi_secret')
  globalThis.fetch = async () => response(429, { error: { code: 'concurrent', message: 'one request at a time' } })
  const controller = new AbortController()
  try {
    const started = Date.now()
    setTimeout(() => controller.abort(new Error('stopped')), 50)
    await assert.rejects(async () => { for await (const _chunk of adapter.stream({ ...options(), sessionId: 's-abort', signal: controller.signal })) {} }, /stopped/)
    assert.ok(Date.now() - started < 200, 'did not wait out the retry delay')
  } finally { globalThis.fetch = originalFetch }
})
