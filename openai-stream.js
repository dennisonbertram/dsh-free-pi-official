// Translation between the harness's provider-neutral request/stream and the OpenAI chat-completions wire format the
// FreePi gateway speaks. No harness imports, so it is unit-testable on its own.

const textOf = (content) => (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')

/** Marker yielded by sseEvents so downstream translators can distinguish [DONE] from EOF. */
const SSE_DONE = '__freepi_done'

/** Harness `GenerateOptions` -> OpenAI chat-completions request body. */
export function toOpenAiBody(options) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages ?? []) {
    const role = message.role ?? 'user' // a request-only user input carries no role
    const text = textOf(message.content)
    if (role === 'system' || role === 'developer') {
      if (text) messages.push({ role: 'system', content: text })
    } else if (role === 'assistant') {
      const calls = (message.content ?? []).filter(block => block.type === 'tool-call')
      if (!text && calls.length === 0) continue
      messages.push({
        role: 'assistant', content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) } : {}),
      })
    } else if (role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: text || (message.isError ? 'error' : '') })
    } else {
      const images = (message.content ?? []).some(block => block.type === 'image')
      messages.push({ role: 'user', content: text + (images ? '\n[An image was attached. This model reads text only.]' : '') })
    }
  }
  return {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
  }
}

/** Split a byte stream into the JSON payloads of its `data:` lines. Yields parsed objects; stops at `[DONE]`. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  function* parseLines(final = false) {
    let cut
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') { done = true; return }
      let parsed
      try { parsed = JSON.parse(data) } catch { continue }
      yield parsed
    }
    if (final && buffer.trim().startsWith('data:')) {
      const data = buffer.trim().slice(5).trim()
      buffer = ''
      if (data === '[DONE]') { done = true; return }
      let parsed
      try { parsed = JSON.parse(data) } catch { return }
      yield parsed
    }
  }
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    yield* parseLines()
    if (done) break
  }
  if (!done) {
    buffer += decoder.decode()
    yield* parseLines(true)
  }
  if (done) yield { [SSE_DONE]: true }
}

/**
 * OpenAI stream events -> harness `StreamChunk`s. Every block-start gets its block-end, indexes rise from 0, usage
 * comes before finish, and finish is last.
 * @param events - async iterable of parsed chunk objects.
 * @param onError - called with an in-stream `{ error }` payload; should throw.
 */
export async function* toStreamChunks(events, onError) {
  let index = -1
  let open = null // { type: 'text' | 'reasoning', text }
  const toolCalls = new Map() // wire index -> { output index, id, name, arguments }
  let usage = null
  let finish = null
  let sawToolCall = false
  let sawDone = false

  function* close() {
    if (!open) return
    const block = open.type === 'tool-call'
      ? { type: 'tool-call', id: open.id, name: open.name, arguments: open.arguments || '{}' }
      : { type: open.type, text: open.text }
    yield { type: 'block-end', index, block }
    open = null
  }
  function* closeTools() {
    for (const [key, call] of toolCalls) {
      yield { type: 'block-end', index: call.index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments || '{}' } }
      toolCalls.delete(key)
    }
  }
  function* openBlock(next) {
    yield* close()
    index++
    open = next
    yield { type: 'block-start', index, blockType: next.type }
  }

  for await (const event of events) {
    if (event?.[SSE_DONE]) { sawDone = true; continue }
    if (event.error) {
      yield* close()
      yield* closeTools()
      onError(event.error)
      return
    }
    if (event.usage) {
      usage = {
        inputTokens: event.usage.prompt_tokens ?? 0, outputTokens: event.usage.completion_tokens ?? 0,
        ...(event.usage.prompt_tokens_details?.cached_tokens ? { cacheReadTokens: event.usage.prompt_tokens_details.cached_tokens } : {}),
      }
    }
    const choice = event.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning !== '') {
      if (toolCalls.size) yield* closeTools()
      if (open?.type !== 'reasoning') yield* openBlock({ type: 'reasoning', text: '' })
      open.text += reasoning
      yield { type: 'reasoning-delta', index, text: reasoning }
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (toolCalls.size) yield* closeTools()
      if (open?.type !== 'text') yield* openBlock({ type: 'text', text: '' })
      open.text += delta.content
      yield { type: 'text-delta', index, text: delta.content }
    }
    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0
      if (open) yield* close()
      let tool = toolCalls.get(key)
      if (!tool) {
        index++
        tool = { index, id: call.id ?? `call_${key}_${Date.now()}`, name: '', arguments: '' }
        toolCalls.set(key, tool)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        sawToolCall = true
      }
      if (call.id) tool.id = call.id
      if (call.function?.name) tool.name += call.function.name
      const argumentsDelta = call.function?.arguments ?? ''
      tool.arguments += argumentsDelta
      yield { type: 'tool-call-delta', index: tool.index, id: tool.id, name: tool.name, argumentsDelta }
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  if (!sawDone && !finish) {
    yield* close()
    yield* closeTools()
    onError({ message: 'FreePi stream ended before a finish reason or [DONE] marker arrived.' })
    return
  }
  yield* close()
  yield* closeTools()
  if (usage) yield { type: 'usage', usage }
  const kind = finish === 'tool_calls' || (finish === null && sawToolCall) ? 'tool-calls' : finish === 'length' ? 'max-tokens' : 'stop'
  yield { type: 'finish', reason: { kind } }
}
