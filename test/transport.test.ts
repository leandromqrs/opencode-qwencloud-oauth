import { test } from "node:test"
import assert from "node:assert/strict"
import { API_BASE, inferenceBase, isInferenceKey, prepareRequest } from "../src/transport.js"

test("opaque API keys permit printable punctuation but reject header injection and excessive length", async () => {
  const key = "sk-sp-fixture.part+/=:opaque"
  const secured = await prepareRequest(new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "fixture" }) }), key, ["fixture"], { plan: "token-plan" })
  assert.equal(secured.headers.get("authorization"), `Bearer ${key}`)
  for (const value of ["sk-sp-foo\r\nInjected: yes", "sk-sp-foo bar", "sk-sp-\u0000", "sk-" + "a".repeat(32766), undefined]) assert.equal(isInferenceKey(value), false)
})

test("explicit inference plan pins the documented Token Plan endpoint separately from PAYG", () => {
  assert.equal(inferenceBase({ plan: "token-plan" }), "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1")
  assert.equal(inferenceBase({ plan: "payg", region: "ap-southeast-1" }), "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
})

test("isolated API-key transport pins plan and preserves chat payload without invented variants", async () => {
  const body = { model: "catalog-model", messages: [], stream: true, tools: [{ type: "function", function: { name: "lookup", parameters: {} } }], enable_thinking: true }
  const request = new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify(body) })
  const lowered = await prepareRequest(request, "sk-sp-fixture", ["catalog-model"], { plan: "token-plan" })
  assert.equal(lowered.redirect, "error")
  assert.equal(lowered.headers.get("authorization"), "Bearer sk-sp-fixture")
  assert.deepEqual(await lowered.json(), body)
  for (const url of ["https://evil.test/chat/completions", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", `${API_BASE}/responses`, `${API_BASE}/chat/completions?leak=1`]) await assert.rejects(prepareRequest(new Request(url, { method: "POST", body: "{}" }), "sk-sp-fixture", [], { plan: "token-plan" }), /destination/)
})

test("management tokens and cross-plan fallback are rejected", async () => {
  for (const key of ["management-access", "sk-ws-fixture"]) await assert.rejects(prepareRequest(new Request(`${API_BASE}/chat/completions`, { method: "POST", body: "{}" }), key, [], { plan: "token-plan" }), /API key/)
  const payg = inferenceBase({ plan: "payg", region: "ap-southeast-1" })
  await assert.rejects(prepareRequest(new Request(`${payg}/chat/completions`, { method: "POST", body: "{}" }), "sk-sp-fixture", [], { plan: "payg", region: "ap-southeast-1" }), /API key/)
})

test("missing inference key directs manual creation without resolving OAuth or attempting fallback", async () => {
  await assert.rejects(prepareRequest(new Request(`${API_BASE}/chat/completions`, { method: "POST", body: "{}" }), "", [], { plan: "token-plan" }), /https:\/\/home\.qwencloud\.com\/api-keys/)
})

test("auto rejects documented unsupported controls without dropping or changing other model payloads", async () => {
  for (const extra of [{ tool_choice: "auto" }, { thinking_budget: 0 }, { tool_choice: null }, { thinking_budget: null }]) {
    const request = (model: string) => new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ model, messages: [], ...extra }) })
    await assert.rejects(prepareRequest(request("auto"), "sk-sp-fixture", ["auto"], { plan: "token-plan" }), /auto does not support tool_choice or thinking_budget/)
    const preserved = await prepareRequest(request("catalog-model"), "sk-sp-fixture", ["catalog-model"], { plan: "token-plan" })
    assert.deepEqual(await preserved.json(), { model: "catalog-model", messages: [], ...extra })
  }
  const body = { model: "auto", messages: [], stream: true }
  const request = new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify(body) })
  assert.deepEqual(await (await prepareRequest(request, "sk-sp-fixture", ["auto"], { plan: "token-plan" })).json(), body)
  await assert.rejects(prepareRequest(new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify(body) }), "sk-sp-fixture", [], { plan: "token-plan" }), /active catalog/)
})
