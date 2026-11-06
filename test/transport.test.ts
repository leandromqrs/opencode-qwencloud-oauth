import { test } from "node:test"
import assert from "node:assert/strict"
import { assertHostTransportSafe, prepareRequest } from "../src/transport.js"

test("production transport guard fails closed without resolving credentials", () => {
  assert.throws(() => assertHostTransportSafe(), /OpenCode.*redirect.*signal/)
})

test("isolated transport lowering pins routing and strips conflicting known-model reasoning", async () => {
  const request = new Request("https://api.qwen.ai/compatible-mode/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer placeholder" }, body: JSON.stringify({ model: "qwen3.8-max", messages: [], stream: true, tools: [{ type: "function", function: { name: "lookup", parameters: {} } }], reasoning: { effort: "high" }, reasoning_effort: "high", chat_template_kwargs: { enable_thinking: true, other: 1 }, enable_thinking: false, thinking_budget: 32768 }) })
  const lowered = await prepareRequest(request, "fixture-access", ["qwen3.8-max"])
  assert.equal(lowered.redirect, "error")
  assert.equal(lowered.headers.get("authorization"), "Bearer fixture-access")
  const body = await lowered.json()
  assert.equal(body.reasoning, undefined)
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.thinking_budget, undefined)
  assert.deepEqual(body.chat_template_kwargs, { other: 1 })
  assert.equal(body.tools[0].function.name, "lookup")
  for (const url of ["https://evil.test/chat/completions", "https://api.qwen.ai/compatible-mode/v1/responses", "https://api.qwen.ai/compatible-mode/v1/chat/completions?leak=1"]) {
    await assert.rejects(prepareRequest(new Request(url, { method: "POST", body: "{}" }), "fixture", []), /destination/)
  }
})
