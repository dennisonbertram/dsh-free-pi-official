// The plugin's translation between harness messages and the OpenAI wire format.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sseEvents, toOpenAiBody, toStreamChunks } from '../openai-stream.js'

async function collect(iterable) { const out = []; for await (const item of iterable) out.push(item); return out }
async function* from(items) { yield* items }
const text = (value) => [{ type: 'text', text: value }]

test('request: system prompt, roles, tool calls and tool results map to OpenAI messages', () => {
  const body = toOpenAiBody({
    model: 'auto', system: 'be brief', maxTokens: 100,
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
    messages: [
      { role: 'developer', content: text('context') },
      { role: 'user', content: text('list files') },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
      { role: 'tool', toolCallId: 'c1', content: text('a.txt') },
      { content: text('and now?') }, // a request-only user input has no role
    ],
  })
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'system', content: 'context' },
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
    { role: 'user', content: 'and now?' },
  ])
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 100)
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }])
})

test('request: stop sequences are passed to the server', () => {
  assert.deepEqual(toOpenAiBody({ model: 'm', stop: ['END', 'HALT'], messages: [] }).stop, ['END', 'HALT'])
  assert.equal(Object.hasOwn(toOpenAiBody({ model: 'm', messages: [] }), 'stop'), false)
})

test('sse: lines split across network chunks are reassembled, and [DONE] ends the stream', async () => {
  const encoder = new TextEncoder()
  const events = await collect(sseEvents(from(['data: {"a"', ':1}\n\ndata: {"b":2}\n', '\ndata: [DONE]\n\ndata: {"c":3}\n\n'].map(part => encoder.encode(part)))))
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { __freepi_done: true }])
})

test('sse: parses the final data line without a newline and flushes the decoder', async () => {
  const encoder = new TextEncoder()
  const bytes = encoder.encode('data: {"text":"終"}')
  const events = await collect(sseEvents(from([bytes.slice(0, -1), bytes.slice(-1)])))
  assert.deepEqual(events, [{ text: '終' }])
})

test('stream: text becomes one balanced block, with usage before finish', async () => {
  const chunks = await collect(toStreamChunks(from([
    { choices: [{ delta: { role: 'assistant', content: '' } }] },
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]), () => { throw new Error('unexpected') }))
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('stream: reasoning, then text, then two tool calls each get their own block', async () => {
  const chunks = await collect(toStreamChunks(from([
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'read', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]), () => { throw new Error('unexpected') }))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start').map(chunk => [chunk.index, chunk.blockType]), [[0, 'reasoning'], [1, 'text'], [2, 'tool-call'], [3, 'tool-call']])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'ok' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"a":1}' },
    { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('stream: interleaved tool calls retain one block each and complete their arguments', async () => {
  const chunks = await collect(toStreamChunks(from([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'read', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'write', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a":1}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b":2}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]), () => { throw new Error('unexpected') }))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index), [0, 1])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'tool-call', id: 'c0', name: 'read', arguments: '{"a":1}' },
    { type: 'tool-call', id: 'c1', name: 'write', arguments: '{"b":2}' },
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.index), [0, 1, 0, 1])
})

test('stream: adopts a late tool id and joins name fragments', async () => {
  const chunks = await collect(toStreamChunks(from([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'real-id', function: { name: 'file', arguments: '}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]), () => { throw new Error('unexpected') }))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'tool-call', id: 'real-id', name: 'read_file', arguments: '{}' },
  ])
})

test('stream: missing DONE and finish_reason is an error, but finish_reason alone succeeds', async () => {
  let message
  await assert.rejects(collect(toStreamChunks(from([{ choices: [{ delta: { content: 'partial' } }] }]), error => { message = error.message; throw new Error(error.message) })), /before a finish reason/)
  assert.match(message, /\[DONE\]/)
  const success = await collect(toStreamChunks(from([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), () => { throw new Error('unexpected') }))
  assert.deepEqual(success.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('stream: an error sent inside the stream is surfaced, not swallowed', async () => {
  await assert.rejects(collect(toStreamChunks(from([{ error: { message: 'boom' } }]), (error) => { throw new Error(error.message) })), /boom/)
})

test('stream: balances started blocks before surfacing an in-stream error', async () => {
  const chunks = []
  await assert.rejects(async () => {
    for await (const chunk of toStreamChunks(from([
      { choices: [{ delta: { content: 'partial' } }] },
      { error: { message: 'provider failed' } },
    ]), error => { throw new Error(error.message) })) chunks.push(chunk)
  }, /provider failed/)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end'])
})
