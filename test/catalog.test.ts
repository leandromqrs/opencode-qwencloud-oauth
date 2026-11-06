import { test } from "node:test"
import assert from "node:assert/strict"
import { discoverCatalog, parseListing } from "../src/catalog.js"
import { nativeModel, reconcileCatalog, METADATA_SOURCE } from "../src/inventory.js"

test("catalog uses actual IDs only and ignores unverified endpoint metadata", () => {
  assert.deepEqual(parseListing({ data: [{ id: " qwen3.8-max ", context: 42 }, { id: "new-model" }, { id: "new-model" }] }), [{ id: "qwen3.8-max" }, { id: "new-model" }])
  assert.throws(() => parseListing({ data: [{ id: "bad\nmodel" }] }))
  assert.throws(() => parseListing({ data: [] }))
  const models = reconcileCatalog({ fetchedAt: 1, models: [{ id: "new-model" }] })
  assert.equal(models[0].context, null)
  assert.deepEqual(models[0].efforts, [])
  assert.deepEqual(nativeModel(models[0]).limit, { context: 0, output: 0 })
  assert.deepEqual(nativeModel(models[0]).cost, [])
  assert.match(METADATA_SOURCE, /v0.26.8/)
})

test("only known subscription IDs receive embedded limits and budget variants", () => {
  const models = reconcileCatalog({ fetchedAt: 1, models: [{ id: "qwen3.8-max" }, { id: "qwen3.8-flash" }] })
  const native = nativeModel(models[0])
  assert.equal(native.package, "@opencode/ai/providers/openai-compatible")
  assert.equal(native.limit.context, 1_000_000)
  assert.deepEqual(native.variants.map(v => v.id), ["off", "low", "medium", "high"])
  assert.deepEqual(native.variants.find(v => v.id === "medium")?.body, { enable_thinking: true, thinking_budget: 16384 })
})

test("discovery pins destination, rejects redirects, bounds response, preserves 403", async () => {
  const result = await discoverCatalog("fixture", async (input, init) => {
    assert.equal(String(input), "https://api.qwen.ai/compatible-mode/v1/models")
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture")
    return Response.json({ data: [{ id: "account-model" }] })
  })
  assert.deepEqual(result.models, [{ id: "account-model" }])
  await assert.rejects(discoverCatalog("fixture", async () => Response.json({ error: { message: "PRIVATE" } }, { status: 403 })), error => error instanceof Error && "status" in error && error.status === 403 && !error.message.includes("PRIVATE"))
  await assert.rejects(discoverCatalog("fixture", async () => new Response("x".repeat(1024 * 1024 + 1))), /invalid_response/)
})
