import { test } from "node:test"
import assert from "node:assert/strict"
import { nativeModel, reconcileCatalog } from "../src/inventory.js"
import { supplementTokenPlan, TOKEN_PLAN_SUPPORT } from "../src/token-plan.js"

const during = Date.parse("2026-11-12T00:00:00Z")
const catalog = (ids = ["qwen3.8-max"]) => reconcileCatalog({ fetchedAt: 1, models: ids.map(id => ({ id })) })

test("documented Token Plan models supplement a nonempty catalog with distinct provenance and unknown tariffs", () => {
  const original = catalog(Array.from({ length: 186 }, (_, i) => `catalog-${i}`))
  const models = supplementTokenPlan(original, during)
  assert.equal(models.length, 188)
  assert.deepEqual(models.slice(0, 186), original)
  assert.deepEqual(models.slice(186).map(model => model.id), ["qwen4-max-preview", "auto"])
  for (const model of models.slice(186)) {
    assert.equal(model.metadata, "token-plan-documentation")
    assert.deepEqual(model.provenance, TOKEN_PLAN_SUPPORT)
    const native = nativeModel(model)
    assert.deepEqual(native.cost, [])
    assert.deepEqual(native.limit, model.id === "qwen4-max-preview" ? { context: 1000000, output: 393216 } : { context: 0, output: 0 })
    assert.deepEqual(native.capabilities, model.id === "qwen4-max-preview" ? { tools: true, input: ["text", "image", "video"], output: ["text"] } : { tools: false, input: [], output: [] })
    const efforts = model.id === "qwen4-max-preview" ? ["none", "low", "medium", "xhigh"] : []
    assert.deepEqual(model.efforts, efforts)
    assert.deepEqual(native.variants.map(variant => variant.id), efforts)
  }
  assert.equal(nativeModel(models[186]).name, "Qwen4 Max Preview")
  assert.deepEqual(supplementTokenPlan([], during), [])
})

test("the documentation snapshot is time bounded and never extends Qwen4 preview from management metadata", () => {
  const start = Date.parse("2026-11-11T10:00:00+08:00")
  const end = Date.parse("2026-11-26T00:00:00+08:00")
  assert.equal(supplementTokenPlan(catalog(), start).length, 3)
  assert.equal(supplementTokenPlan(catalog(), end - 1).length, 3)
  for (const now of [start - 1, end, end + 1, NaN, Infinity]) {
    assert.deepEqual(supplementTokenPlan(catalog(["qwen3.8-max", "qwen4-max-preview", "qwen4.0-max-preview"]), now).map(model => model.id), ["qwen3.8-max"])
  }
  assert.deepEqual(supplementTokenPlan(catalog(), end).map(model => model.id), ["qwen3.8-max"])
})

test("advertised entries never overwrite management rates or fabricate an alias model", () => {
  const source = catalog(["qwen4-max-preview", "auto", "account-only"])
  const supported = supplementTokenPlan(source, during)
  assert.deepEqual(supported.slice(1), source.slice(1))
  assert.equal(source[0].context, null)
  assert.equal(supported[0].context, 1000000)
  assert.equal(supplementTokenPlan(catalog(), during).some(model => model.id === "qwen4.0-max-preview"), false)
  const alias = { ...catalog(["qwen4.0-max-preview"])[0], context: 1000000 }
  const canonical = { ...alias, id: "qwen4-max-preview", context: 900000 }
  const normalized = supplementTokenPlan([alias], during)
  assert.equal(normalized[0].id, "qwen4-max-preview")
  assert.deepEqual(nativeModel(normalized[0]).limit, { context: 1000000, output: 393216 })
  const combined = supplementTokenPlan([alias, canonical], during).filter(model => model.id.startsWith("qwen4"))
  assert.equal(combined.length, 1)
  assert.deepEqual(nativeModel(combined[0]).limit, { context: 900000, output: 393216 })
})

test("documented preview defaults preserve known catalog limits, modalities and tariffs", () => {
  const source = reconcileCatalog({ fetchedAt: 1, models: [{ id: "qwen4-max-preview", context: 800000, inputLimit: 700000, output: 65536, inputModalities: ["text"], outputModalities: ["text"], pricing: { Prices: [{ Type: "input", PriceUnit: "USD/1M tokens", Price: "1", PriceName: "input" }] } }] })
  const before = structuredClone(source)
  const supported = supplementTokenPlan(source, during)[0]
  assert.deepEqual(nativeModel(supported).limit, { context: 800000, output: 65536 })
  assert.deepEqual(nativeModel(supported).capabilities, { tools: true, input: ["text"], output: ["text"] })
  assert.equal(supported.inputLimit, 700000)
  assert.deepEqual(supported.pricing, source[0].pricing)
  assert.equal(supported.metadata, "management-catalog")
  assert.deepEqual(supported.provenance, TOKEN_PLAN_SUPPORT)
  assert.deepEqual(source, before)
})

test("preview fallbacks retain explicit zero, empty modalities and disabled tools", () => {
  const source = { ...catalog(["qwen4-max-preview"])[0], context: 0, output: 0, inputModalities: [], outputModalities: [], tools: false }
  const supported = supplementTokenPlan([source], during)[0]
  assert.deepEqual(nativeModel(supported).limit, { context: 0, output: 0 })
  assert.deepEqual(nativeModel(supported).capabilities, { tools: false, input: [], output: [] })
})
