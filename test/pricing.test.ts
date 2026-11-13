import { test } from "node:test"
import assert from "node:assert/strict"
import { Model } from "@opencode/plugin/effect"
import { Schema } from "effect"
import { parseListing, sanitizeSavedModels } from "../src/catalog.js"
import { nativeModel, reconcileCatalog } from "../src/inventory.js"

const price = (Type: string, Price: string, PriceUnit = "USD/1M tokens", extra = {}) => ({ Type, Price, PriceUnit, PriceName: Type, ...extra })
const pair = (input = "2", output = "6") => [price("input_token", input), price("output_token", output)]
const listing = (metadata: object) => parseListing({ code: "200", data: { Data: [{ Items: [{ Model: "qwen3.8-max", ...metadata }] }] } })
const native = (metadata: object) => nativeModel(reconcileCatalog({ fetchedAt: 1, models: sanitizeSavedModels(JSON.parse(JSON.stringify(listing(metadata)))) })[0])

test("official runtime-compatible null labels and discounts do not discard valid rates", () => {
  for (const optional of [{ PriceName: null, Discount: null }, { PriceName: undefined, Discount: 0.5 }]) {
    const metadata = { Prices: pair().map(item => ({ ...item, ...optional })), MultiPrices: null }
    const model = native(metadata)
    const factor = optional.Discount === 0.5 ? 0.5 : 1
    assert.deepEqual(model.cost, [{ input: 2 * factor, output: 6 * factor, cache: { read: 2 * factor, write: 2 * factor } }])
  }
  assert.equal(native({ Prices: null }).cost.length, 0)
})

test("official prices survive discovery and cached restoration into schema-valid native costs", () => {
  const Prices = pair()
  const models = listing({ Prices, ModelInfo: { ContextWindow: 65536 }, InferenceMetadata: { RequestModality: ["Text"], ResponseModality: ["Text"] } })
  assert.deepEqual(sanitizeSavedModels(JSON.parse(JSON.stringify(models))), models)
  const model = native({ Prices })
  assert.deepEqual(model.cost, [{ input: 2, output: 6, cache: { read: 2, write: 2 } }])
  assert.ok(Schema.is(Model.Info)(model))
  assert.equal(model.id, "qwen3.8-max")
  assert.equal(model.modelID, "qwen3.8-max")
  assert.equal(model.name, "Qwen3.8 Max")
  assert.deepEqual(nativeModel(reconcileCatalog({ fetchedAt: 1, models })[0]).capabilities, { tools: false, input: ["text"], output: ["text"] })
})

test("only absent cache components are estimated, and explicit zero stays zero", () => {
  assert.deepEqual(native({ Prices: [...pair(), price("input_token_cache_read", "0")] }).cost, [{ input: 2, output: 6, cache: { read: 0, write: 2 } }])
  assert.deepEqual(native({ Prices: [...pair(), price("input_token_cache_creation_5m", "2.5")] }).cost, [{ input: 2, output: 6, cache: { read: 2, write: 2.5 } }])
  assert.deepEqual(native({ Prices: pair("0", "0") }).cost, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  for (const item of [price("input_token_cache_read", "bad"), price("input_token_cache", "1", "USD/second"), price("input_token_cache_creation_5m", "-1")]) {
    assert.deepEqual(native({ Prices: [...pair(), item] }).cost, [])
  }
})

test("discounts use official multiplier policy without accepting numeric junk", () => {
  assert.equal(native({ Prices: [price("input_token", "0.14", "Per 1M tokens", { Discount: "0.8" }), price("output_token", "6")] }).cost[0]?.input, 0.112)
  for (const Discount of ["0", "-1", "2", "bad", "0.5junk", "Infinity"]) {
    assert.equal(native({ Prices: [price("input_token", "2", undefined, { Discount }), price("output_token", "6")] }).cost[0]?.input, 2)
  }
  for (const Price of ["", " ", "2junk", "0x10", "Infinity", "NaN", "-1", "1e999", "1e-999"]) {
    assert.deepEqual(native({ Prices: [price("input_token", Price), price("output_token", "6")] }).cost, [])
  }
  assert.deepEqual(native({ Prices: [price("input_token", "1e-300", undefined, { Discount: "1e-300" }), price("output_token", "6")] }).cost, [])
})

test("discount rounding overflow leaves costs unknown before and after cached restoration", () => {
  const models = listing({ Prices: [price("input_token", "1.7976931348623157e308", undefined, { Discount: "1" }), price("output_token", "6")] })
  for (const entries of [models, sanitizeSavedModels(JSON.parse(JSON.stringify(models)))]) {
    assert.deepEqual(nativeModel(reconcileCatalog({ fetchedAt: 1, models: entries })[0]).cost, [])
  }
})

test("unsupported billing units and types never become token tariffs", () => {
  for (const PriceUnit of ["USD/second", "USD/minute", "USD/image", "USD/1K characters", "CNY/1M tokens", "1M tokens", "USD/1K tokens"]) {
    assert.deepEqual(native({ Prices: pair().map(item => ({ ...item, PriceUnit })) }).cost, [])
  }
  for (const Type of ["thinking_input_token", "audio_input_token", "vision_input_token", "input_token_batch", "embedding_token", "image_number", "content_duration"]) {
    assert.deepEqual(native({ Prices: [price(Type, "2"), price("output_token", "6")] }).cost, [])
  }
  assert.deepEqual(native({ Prices: [price("text_input_token", "2"), price("purein_text_output_token", "6")] }).cost, [{ input: 2, output: 6, cache: { read: 2, write: 2 } }])
  const nonToken = listing({ Prices: [price("video_ratio_720p", "0.1", "USD/second")] })
  assert.match(JSON.stringify(nonToken), /USD\/second/)
})

test("user-approved CLI display precedence selects explicit cache before implicit alternatives", () => {
  const Prices = [...pair("0.5", "3"), price("input_token_cache", "0.1"), price("input_token_cache_creation_5m", "0.625"), price("input_token_cache_read", "0.05")]
  assert.deepEqual(native({ Prices }).cost, [{ input: 0.5, output: 3, cache: { read: 0.05, write: 0.625 } }])
  assert.deepEqual(native({ Prices: [...pair(), price("text_input_token", "3"), price("input_token_cache", "0.1"), price("text_input_token_cache", "0.2")] }).cost, [{ input: 2, output: 6, cache: { read: 0.2, write: 2 } }])
  assert.equal(native({ Prices: [...Prices, price("text_input_token_cache", "0.9")] }).cost[0]?.cache.read, 0.05)
  assert.equal(native({ Prices: [...Prices, price("input_token_cache_read", "0")] }).cost[0]?.cache.read, 0)
})

test("same-type tariffs follow last-published CLI display order without modifying source items", () => {
  const Prices = [
    price("input_token", "0.15", "Per 1M tokens", { TimeBand: "synthetic-first" }), price("input_token", "0.3", "Per 1M tokens", { TimeBand: "synthetic-second" }),
    price("output_token", "0.6"), price("output_token", "1.2"),
    price("input_token_cache", "0.003"), price("input_token_cache", "0.006"),
  ]
  assert.deepEqual(native({ Prices }).cost, [{ input: 0.3, output: 1.2, cache: { read: 0.006, write: 0.3 } }])
  assert.deepEqual(listing({ Prices })[0].pricing?.Prices?.map(item => item.Price), Prices.map(item => item.Price))
  assert.equal(native({ Prices: [...pair(), price("input_token", "0")] }).cost[0]?.input, 0)
  for (const invalid of [price("input_token", "bad"), price("input_token_cache", "-1"), price("output_token", "1", "USD/second")]) {
    for (const items of [[invalid, ...Prices], [...Prices, invalid]]) assert.deepEqual(native({ Prices: items }).cost, [])
  }
})

test("batch alternatives do not invalidate synchronous tariffs or become ordinary prices", () => {
  assert.deepEqual(native({ Prices: [...pair(), price("input_token_batch", "1"), price("output_token_batch", "3")] }).cost, [{ input: 2, output: 6, cache: { read: 2, write: 2 } }])
  assert.deepEqual(native({ Prices: [price("input_token_batch", "1"), price("output_token_batch", "3")] }).cost, [])
  for (const Type of ["thinking_input_token", "vision_input_token", "audio_input_token", "new_input_token"]) {
    assert.deepEqual(native({ Prices: [...pair(), price(Type, "3")] }).cost, [])
  }
})

test("the exact observed empty MultiPrices placeholder does not discard flat API prices", () => {
  const Prices = [...pair(), price("input_token_cache", "0.25"), price("input_token_batch", "1"), price("output_token_batch", "3"), price("input_token_cache_creation_5m", "2.5"), price("input_token_cache_read", "0.17")]
  assert.deepEqual(native({ Prices, MultiPrices: [{ Prices: [{}] }] }).cost, [{ input: 2, output: 6, cache: { read: 0.17, write: 2.5 } }])
  for (const MultiPrices of [
    [{ Prices: [{ Type: "input_token_cache", Price: "bad" }] }],
    [{ RangeName: "", Prices: [{}] }], [{ Prices: [{}, {}] }], [{ Prices: [] }],
    [{ Prices: [{}], Condition: "synthetic-condition" }],
    [{ Prices: [{}] }, { RangeName: "Input<=1m", Prices: pair() }],
  ]) assert.deepEqual(native({ Prices, MultiPrices }).cost, [])
})

test("contiguous explicit context ranges take precedence without flattening ambiguous ranges", () => {
  const MultiPrices = [
    { RangeName: "0-128000", Prices: pair() },
    { RangeName: "128000-256000", Prices: pair("4", "12") },
  ]
  assert.deepEqual(native({ Prices: pair("1", "3"), MultiPrices, ModelInfo: { ContextWindow: 256000 } }).cost, [
    { input: 2, output: 6, cache: { read: 2, write: 2 } },
    { input: 4, output: 12, cache: { read: 4, write: 4 }, tier: { type: "context", size: 128000 } },
  ])
  assert.deepEqual(native({ MultiPrices }).cost, [])
  assert.deepEqual(native({ MultiPrices, ModelInfo: { ContextWindow: 300000 } }).cost, [])
  for (const RangeName of ["129000-256000", "64000-256000", "Text mode", "128k-256k", "128000-128000"]) {
    assert.deepEqual(native({ Prices: pair(), MultiPrices: [MultiPrices[0], { RangeName, Prices: pair("4", "12") }], ModelInfo: { ContextWindow: 256000 } }).cost, [])
  }
  assert.deepEqual(native({ Prices: pair(), MultiPrices: [{ RangeName: "0-128000", Prices: [price("image_number", "0.1", "USD/image")] }], ModelInfo: { ContextWindow: 128000 } }).cost, [])
  assert.deepEqual(native({ Prices: pair(), MultiPrices: [] }).cost, native({ Prices: pair() }).cost)
})

test("observed input inequalities use checked decimal context thresholds and CLI cache/discount policy", () => {
  const tiers = (input: string, output: string, cache: string, write: string) => [price("input_token", input), price("output_token", output), price("input_token_cache", cache), price("input_token_batch", "0.2"), price("output_token_batch", "0.8"), price("input_token_cache_creation_5m", write), price("input_token_cache_read", String(Number(cache) / 2))].map(item => item.Type.endsWith("_batch") ? item : { ...item, Discount: "0.8" })
  const MultiPrices = [
    { RangeName: "Input<=256k", Prices: tiers("0.4", "1.6", "0.08", "0.5") },
    { RangeName: "256k<Input<=1m", Prices: tiers("1.2", "4.8", "0.24", "1.5") },
  ]
  const model = native({ MultiPrices, ModelInfo: { ContextWindow: 1000000 } })
  assert.deepEqual(model.cost, [
    { input: 0.32, output: 1.28, cache: { read: 0.032, write: 0.4 } },
    { input: 0.96, output: 3.84, cache: { read: 0.096, write: 1.2 }, tier: { type: "context", size: 256000 } },
  ])
  assert.ok(Schema.is(Model.Info)(model))
  const small = ["Input<=32k", "32k<Input<=128k", "128k<Input<=256k"].map(RangeName => ({ RangeName, Prices: pair() }))
  assert.deepEqual(native({ MultiPrices: small, ModelInfo: { ContextWindow: 256000 } }).cost.map(cost => cost.tier?.size), [undefined, 32000, 128000])
  assert.deepEqual(native({ MultiPrices, ModelInfo: { ContextWindow: 1000001 } }).cost, [])
  for (const RangeName of ["257k<Input<=1m", "128k<Input<=1m", "256k<=Input<=1m", "256k<Input<1m", "256k<Input<=999999999999999999m"]) {
    assert.deepEqual(native({ Prices: pair(), MultiPrices: [MultiPrices[0], { RangeName, Prices: pair() }], ModelInfo: { ContextWindow: 1000000 } }).cost, [])
  }
})

test("pricing bounds and malformed cache metadata remain fail-closed across saved sanitization", () => {
  for (const metadata of [
    { Prices: [...pair(), { Type: "input_token_cache", Price: 1 }] },
    { Prices: Array.from({ length: 65 }, () => price("input_token", "2")) },
    { Prices: [...pair(), price("input_token_cache", "1".repeat(65))] },
    { Prices: pair(), MultiPrices: "bad" },
    { Prices: pair(), MultiPrices: Array.from({ length: 33 }, () => ({ RangeName: "0-1", Prices: pair() })) },
    { Prices: [...pair(), price("input_token_cache", "1", "USD/1M tokens", { PriceName: "x".repeat(257) })] },
    { Prices: pair().map(item => ({ ...item, Currency: "CNY" })) },
    { MultiPrices: Array.from({ length: 5 }, () => ({ RangeName: "0-1", Prices: Array.from({ length: 64 }, () => price("input_token", "2")) })) },
  ]) {
    assert.deepEqual(native(metadata).cost, [])
    assert.ok(JSON.stringify(listing(metadata)).length < 1000)
  }
  assert.deepEqual(native({}).cost, [])
  const saved = sanitizeSavedModels([{ id: "old-model" }])
  assert.deepEqual(saved, [{ id: "old-model" }])
  assert.deepEqual(nativeModel(reconcileCatalog({ fetchedAt: 1, models: saved })[0]).cost, [])
  const invalidSaved = sanitizeSavedModels([{ id: "qwen3.8-max", pricing: { invalid: true } }])
  assert.deepEqual(nativeModel(reconcileCatalog({ fetchedAt: 1, models: invalidSaved })[0]).cost, [])
  assert.doesNotMatch(JSON.stringify(listing({ Prices: pair().map(item => ({ ...item, secret: "PRIVATE" })) })), /PRIVATE/)
})
