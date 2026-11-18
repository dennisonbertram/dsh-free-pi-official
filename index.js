// FreePi for DeepSeek Harness, host half. Registers the `freepi` model provider (beside any others the profile has)
// and tells the browser half which FreePi bar to show. It holds one secret, the install key, which identifies this
// installation to the FreePi server. The key alone buys nothing: the server serves a model request only once someone
// has signed in to the FreePi bar of this installation, and only while that bar is visibly on screen.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { sseEvents, toOpenAiBody, toStreamChunks } from './openai-stream.js'
import { createSessionQueue } from './session-queue.js'

export const name = 'freepi'
export const inject = ['llm']

const PROVIDER = 'freepi'
const VERSION = '0.1.0-beta.3'
// `auto` is the harness-side name for "the server's current default model". A request sends the real id of that
// default (the `model` field of /client-version); only if that is unknown does `auto` itself go out, which the server
// resolves to its default like any id it does not know.
const AUTO = { id: 'auto', name: 'FreePi Auto' }
const CONTEXT_WINDOW = 200_000
const MAX_OUTPUT_TOKENS = 32_768
const sessionQueue = createSessionQueue()

/** The server's rule for an install key. */
const KEY_RE = /^fpi_[A-Za-z0-9_-]{32,96}$/

/** Read the install key, creating it on first run. Stored in the harness home, readable by this user only. */
export function loadInstallSecret(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const file = join(home, 'freepi-install.json')
  try {
    const secret = JSON.parse(readFileSync(file, 'utf8')).secret
    if (typeof secret === 'string' && KEY_RE.test(secret)) {
      chmodSync(file, 0o600)
      return secret
    }
  } catch { /* first run, or an unreadable file: make a new key */ }
  const secret = `fpi_${randomBytes(32).toString('base64url')}`
  mkdirSync(home, { recursive: true })
  // Written in full to a private temp file, then hard-linked into place: the key file appears with its content or not
  // at all, so a second process starting at the same moment never reads a half-written file.
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`
  writeFileSync(temp, JSON.stringify({ secret }), { mode: 0o600, flag: 'wx' })
  try {
    for (;;) {
      try {
        linkSync(temp, file)
        return secret
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        let winner
        try { winner = JSON.parse(readFileSync(file, 'utf8')).secret } catch { /* malformed file: replace it */ }
        if (typeof winner === 'string' && KEY_RE.test(winner)) {
          chmodSync(file, 0o600)
          return winner
        }
        // ponytail: two processes replacing the same malformed file at once can still end with different keys.
        try { unlinkSync(file) } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError }
      }
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

/** The public id the browser half shows the gateway. Derived one-way from the secret. */
export const installIdOf = (secret) => createHash('sha256').update(secret).digest('hex').slice(0, 32)

const failure = (message, code, options) => new LlmError(message, code, options)

export class FreePiAdapter extends LlmAdapter {
  #gateway
  #secret
  #status = { at: 0, value: null }
  #defaultModel = null

  constructor(gateway, secret) {
    super()
    this.#gateway = gateway
    this.#secret = secret
  }

  providerInfo() {
    return { id: PROVIDER, name: 'FreePi (free, with ads)' }
  }

  // Refusals (ads not showing, allowance used up, region) are answers, not outages: never retried.
  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT'], initialDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0.2 }
  }

  #headers() {
    return { ...attributionHeaders(), authorization: `Bearer ${this.#secret}`, 'x-freepi-client': 'dsh', 'x-freepi-client-version': VERSION }
  }

  /**
   * The server's public model list, cached for a minute. The list is a courtesy: the server decides what each account
   * and region may actually use, whatever the client asks for.
   */
  async #models(signal) {
    if (this.#status.value && Date.now() - this.#status.at < 60_000) return this.#status.value
    try {
      const response = await fetch(`${this.#gateway}/client-version`, { headers: { 'x-freepi-client': 'dsh', 'x-freepi-client-version': VERSION }, ...(signal ? { signal } : {}) })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const json = await response.json()
      const listed = (Array.isArray(json.models) ? json.models : [])
        .filter(model => typeof model?.id === 'string' && !model.unavailable)
        .map(model => ({ id: model.id, name: String(model.display_name ?? model.name ?? model.id) }))
      // `default_model` is the catalog default's id. A server that predates it sends only `model`, a display field.
      const named = [json.default_model, json.model].find(value => typeof value === 'string' && value)
      this.#defaultModel = named ?? null
      const models = [AUTO, ...listed]
      this.#status = { at: Date.now(), value: models }
      return models
    } catch {
      return this.#status.value ?? [AUTO]
    }
  }

  async listModels(provider) {
    return (await this.#models()).map(model => ({ provider, id: model.id, name: model.name, inputModalities: ['text'] }))
  }

  async resolveModel(provider, model, signal) {
    const models = await this.#models(signal)
    const found = models.find(entry => entry.id === model)
    return {
      provider, id: model, name: found?.name ?? model, inputModalities: ['text'],
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: MAX_OUTPUT_TOKENS,
    }
  }

  async *stream(options) {
    const body = toOpenAiBody(options)
    if (body.model === AUTO.id) {
      await this.#models(options.signal)
      if (this.#defaultModel) body.model = this.#defaultModel
    }
    const release = await sessionQueue.acquire(options.sessionId, {
      signal: options.signal,
      auxiliary: options.purpose !== undefined,
    })
    try {
      // The server frees a session's slot a few milliseconds after its stream ends, so the request queued right
      // behind one that just finished can still be told "one at a time". Nothing has been yielded yet, so asking
      // again here is invisible; after these tries the harness's own retry policy takes over.
      let response
      for (const wait of [250, 500, 1000, 0]) {
        try {
          response = await fetch(`${this.#gateway}/v1/chat/completions`, {
            method: 'POST',
            headers: { ...this.#headers(), 'content-type': 'application/json', ...(options.sessionId ? { 'x-session-id': String(options.sessionId) } : {}) },
            body: JSON.stringify(body),
            ...(options.signal ? { signal: options.signal } : {}),
          })
        } catch (error) {
          if (options.signal?.aborted) throw error
          throw failure('FreePi could not be reached. Check your connection, then retry.', 'TRANSPORT')
        }
        if (response.status !== 429 || wait === 0) break
        const peek = await response.clone().json().catch(() => ({}))
        if (peek.error?.code !== 'concurrent') break
        // Abortable, so a cancelled request frees its session's slot at once.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, wait)
          options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason) }, { once: true })
        })
      }

      if (!response.ok || !response.body) {
        const json = await response.json().catch(() => ({}))
        const code = typeof json.error?.code === 'string' ? json.error.code : `http_${response.status}`
        const message = typeof json.error?.message === 'string' ? json.error.message : `FreePi refused the request (${response.status}).`
        if (code === 'context_ceiling') throw failure(message, 'CONTEXT_WINDOW_EXCEEDED', { status: response.status })
        if (response.status === 429 && code === 'upstream_rate_limited') {
          const retryAfter = response.headers.get('retry-after')
          const seconds = retryAfter === null ? NaN : Number(retryAfter)
          const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000
            : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Date.parse(retryAfter) - Date.now() : NaN
          throw failure(message, 'RATE_LIMIT', { status: response.status, ...(delay > 0 ? { providerRetryAfterMs: delay } : {}) })
        }
        if (response.status === 429 && code === 'concurrent') {
          throw failure(message, 'RATE_LIMIT', { status: response.status, providerRetryAfterMs: 1500 })
        }
        if (response.status >= 500 && code === 'global_cap') throw failure(message, 'FREEPI_GLOBAL_CAP', { status: response.status })
        if (response.status >= 500) throw failure('FreePi had a problem answering. Retry in a moment.', 'SERVER', { status: response.status })
        // The key is unknown until someone signs in to the bar of this installation.
        if (response.status === 401) throw failure('Sign in to FreePi in the bar above the composer, then retry.', 'FREEPI_NOT_SIGNED_IN', { status: response.status })
        throw failure(message, `FREEPI_${code.toUpperCase()}`, { status: response.status })
      }
      const guardedBody = {
        async *[Symbol.asyncIterator]() {
          try { yield* response.body }
          catch (error) {
            if (options.signal?.aborted) throw error
            throw failure('FreePi connection stopped while reading the response. Check your connection, then retry.', 'TRANSPORT')
          }
        },
      }
      yield* toStreamChunks(sseEvents(guardedBody), (error) => {
        throw failure(error.message ?? 'The model stopped unexpectedly.', 'SERVER')
      })
    } finally {
      release()
    }
  }
}

export function apply(ctx, config = {}) {
  const gateway = String(config.gateway ?? process.env.FREEPI_GATEWAY ?? 'https://api.freepi.ai').replace(/\/+$/, '')
  const secret = loadInstallSecret()
  const adapter = new FreePiAdapter(gateway, secret)
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'freepi: model provider')

  // The browser half asks which FreePi bar to embed. Only the public install id leaves the host, never the key.
  // Profiles without a web server (headless, SDK) simply never run this part; the provider above still registers,
  // and the gateway refuses its requests because no bar is on screen.
  const body = JSON.stringify({ gateway, install_id: installIdOf(secret), version: VERSION })
  // An HTTP request (the web page, and the desktop app, which forwards the page's request with the host cookie) must
  // pass the harness's own access check, its Host/Origin fence and signed-in cookie, so another page open in the
  // browser cannot call this route. Only a webServer.readResource(request, peer) read arrives with a Peer, and the
  // harness admitted that Peer already.
  ctx.inject(['webServer', 'connection'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: '/freepi/pairing',
      resource: async (request, peer) => {
        const refused = peer === undefined ? web.connection.requestRejection(request) : undefined
        if (refused !== undefined) return new Response(null, { status: refused, headers: { 'cache-control': 'no-store' } })
        return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      },
    }), 'freepi: pairing route')
  })
}
