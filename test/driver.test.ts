import { test } from "node:test"
import assert from "node:assert/strict"
import { make } from "@opencode/ai"
import { model as createModel } from "@opencode/ai/providers/openai-compatible"
import { API_BASE, prepareRequest } from "../src/transport.js"

test("real 2.2.5 Chat driver lowers native body overlay and preserves tools/reasoning/fragmented SSE", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    const request = await prepareRequest(new Request(input, init), "sk-sp-fixture", ["qwen3.8-max"], { plan: "token-plan" })
    assert.equal(request.url, `${API_BASE}/chat/completions`)
    const body = await request.json()
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    assert.equal(body.enable_thinking, true)
    assert.equal(body.thinking_budget, undefined)
    assert.equal(body.reasoning_effort, undefined)
    assert.equal(body.tools[0].type, "function")
    assert.equal(body.tools[0].function.name, "lookup")
    assert.equal(body.tool_choice, "auto")
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "fixture-id", object: "chat.completion.chunk", created: 1, model: "qwen3.8-max", choices: [{ index: 0, delta, finish_reason }] })
    const frames = [
      chunk({ role: "assistant", reasoning_content: "Considering" }),
      chunk({ content: "Olá" }),
      chunk({ tool_calls: [{ index: 0, id: "fixture-tool", type: "function", function: { name: "lookup", arguments: '{"q":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] }),
      chunk({}, "tool_calls"),
      { id: "fixture-id", object: "chat.completion.chunk", created: 1, model: "qwen3.8-max", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of new TextEncoder().encode(frames)) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } }), { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const client = make()
    const model = createModel("qwen3.8-max", { baseURL: API_BASE, apiKey: "placeholder", provider: "qwencloud", body: { enable_thinking: true } })
    const events = []
    for await (const event of client.stream({ model, prompt: "fixture", tools: [{ name: "lookup", description: "Fixture tool", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }], toolChoice: "auto" })) events.push(event)
    assert.equal(calls, 1)
    assert.ok(events.some(event => event.type === "text-delta" && event.text === "Olá"))
    assert.ok(events.some(event => event.type === "reasoning-delta"))
    assert.ok(events.some(event => event.type === "tool-call"))
    assert.ok(events.some(event => event.type === "finish"))
  } finally { globalThis.fetch = original }
})
