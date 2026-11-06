import { test } from "node:test"
import assert from "node:assert/strict"
import { API_BASE, assertHostTransportSafe, inferenceBase, prepareRequest } from "../src/transport.js"

test("production transport blocks before credential resolution", () => {
  assert.throws(() => assertHostTransportSafe(), /OpenCode.*redirect.*signal/)
})

test("isolated API-key transport pins plan and preserves chat payload without invented variants", async () => {
  const body = { model: "catalog-model", messages: [], stream: true, tools: [{ type: "function", function: { name: "lookup", parameters: {} } }], enable_thinking: true }
  const request = new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify(body) })
  const lowered = await prepareRequest(request, "sk-sp-fixture", ["catalog-model"], { plan: "token-plan" })
  assert.equal(lowered.redirect, "error")
  assert.equal(lowered.headers.get("authorization"), "Bearer sk-sp-fixture")
  assert.deepEqual(await lowered.json(), body)
  for (const url of ["https://evil.test/chat/completions", `${API_BASE}/responses`, `${API_BASE}/chat/completions?leak=1`]) await assert.rejects(prepareRequest(new Request(url, { method: "POST", body: "{}" }), "sk-sp-fixture", [], { plan: "token-plan" }), /destination/)
})

test("management tokens and cross-plan fallback are rejected", async () => {
  for (const key of ["management-access", "sk-ws-fixture"]) await assert.rejects(prepareRequest(new Request(`${API_BASE}/chat/completions`, { method: "POST", body: "{}" }), key, [], { plan: "token-plan" }), /API key/)
  const payg = inferenceBase({ plan: "payg", region: "ap-southeast-1" })
  await assert.rejects(prepareRequest(new Request(`${payg}/chat/completions`, { method: "POST", body: "{}" }), "sk-sp-fixture", [], { plan: "payg", region: "ap-southeast-1" }), /API key/)
})
