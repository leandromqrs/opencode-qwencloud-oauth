import { test } from "node:test"
import assert from "node:assert/strict"
import { discoverCatalog, parseListing, sanitizeSavedModels } from "../src/catalog.js"
import { nativeModel, reconcileCatalog, METADATA_SOURCE } from "../src/inventory.js"

const wire = (items: unknown[]) => ({ code: "200", data: { Data: [{ Items: items }] } })
test("catalog sanitizes actual management metadata and never embeds subscription assumptions", () => {
  assert.deepEqual(parseListing(wire([{ Model: "new-model" }, { Model: "new-model" }])), [{ id: "new-model" }])
  assert.throws(() => parseListing(wire([{ Model: "bad\nmodel" }])))
  assert.deepEqual(parseListing(wire([])), [])
  assert.throws(() => parseListing({ data: [] }))
  const model = reconcileCatalog({ fetchedAt: 1, models: [{ id: "qwen3.8-max" }] })[0]
  assert.equal(model.context, null)
  assert.deepEqual(model.efforts, [])
  assert.deepEqual(nativeModel(model).limit, { context: 0, output: 0 })
  assert.deepEqual(nativeModel(model).cost, [])
  assert.deepEqual(nativeModel(model).variants, [])
  assert.match(METADATA_SOURCE, /QwenCloud\/qwencloud-cli/)
})

test("rich catalog limits and modalities are sanitized without claiming tools or entitlement", () => {
  const listing = parseListing(wire([{ Model: "vision-model", ModelInfo: { ContextWindow: 65536, MaxInputTokens: 60000, MaxOutputTokens: 4096 }, InferenceMetadata: { RequestModality: ["Text", "Image", "PRIVATE"], ResponseModality: ["Text"] }, email: "PRIVATE" }]))
  const native = nativeModel(reconcileCatalog({ fetchedAt: 1, models: listing })[0])
  assert.equal(native.limit.context, 65536)
  assert.equal(native.limit.output, 4096)
  assert.deepEqual(native.capabilities.input, ["text", "image"])
  assert.equal(native.capabilities.tools, false)
  assert.doesNotMatch(JSON.stringify(listing), /PRIVATE/)
  assert.deepEqual(sanitizeSavedModels([{ id: "model", context: -1, output: Infinity, secret: "PRIVATE" }]), [{ id: "model" }])
})

test("discovery rejects redirects, oversized bodies and preserves HTTP and business denials", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(discoverCatalog("fixture", async () => Response.json({ message: "PRIVATE" }, { status })), error => error instanceof Error && "status" in error && error.status === status && !error.message.includes("PRIVATE"))
    await assert.rejects(discoverCatalog("fixture", async () => Response.json({ code: String(status), message: "PRIVATE" })), error => error instanceof Error && "status" in error && error.status === status)
  }
  await assert.rejects(discoverCatalog("fixture", async () => new Response("x".repeat(1024 * 1024 + 1))), /invalid_response/)
  await assert.rejects(discoverCatalog("fixture", async () => { throw new TypeError("redirect secret") }), /network_error/)
})
