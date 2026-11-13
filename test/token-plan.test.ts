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
    assert.deepEqual(native.limit, { context: 0, output: 0 })
    assert.deepEqual(native.capabilities, { tools: false, input: [], output: [] })
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
  assert.deepEqual(supplementTokenPlan(source, during), source)
  assert.equal(supplementTokenPlan(catalog(), during).some(model => model.id === "qwen4.0-max-preview"), false)
  const alias = { ...catalog(["qwen4.0-max-preview"])[0], context: 1000000 }
  const canonical = { ...alias, id: "qwen4-max-preview", context: 900000 }
  const normalized = supplementTokenPlan([alias], during)
  assert.deepEqual(normalized[0], { ...alias, id: "qwen4-max-preview" })
  assert.deepEqual(supplementTokenPlan([alias, canonical], during).filter(model => model.id.startsWith("qwen4")), [canonical])
})
