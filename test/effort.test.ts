import { test } from "node:test"
import assert from "node:assert/strict"
import { Schema } from "effect"
import { Model } from "@opencode/plugin/effect"
import { nativeModel, reconcileCatalog } from "../src/inventory.js"
import { API_BASE } from "../src/transport.js"

test("only exact documented Qwen IDs publish native effort variants without changing the base default", () => {
  for (const id of ["qwen4-max-preview", "qwen4.0-max-preview", "qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-flash", "qwen3.8-2.4t-a95b", "qwen3.8-27b"]) {
    const account = reconcileCatalog({ fetchedAt: 1, models: [{ id }] })[0]
    const native = nativeModel(account)
    assert.deepEqual(account.efforts, ["none", "low", "medium", "xhigh"], id)
    assert.deepEqual(native.variants, ["none", "low", "medium", "xhigh"].map(effort => ({ id: effort, settings: { reasoningEffort: effort } })), id)
    assert.deepEqual(Schema.decodeUnknownSync(Model.Info)(native), native)
    assert.deepEqual(native.settings, { baseURL: API_BASE })
  }
})

test("unknown Qwen IDs, auto and other model families have no inferred efforts", () => {
  for (const id of ["auto", "qwen4-max", "qwen4-max-preview-custom", "qwen3.8-max-latest", "qwen3.8-max-0903", "qwen3.8-flash-custom", "qwen3.8-omni-flash", "qwen3.7-max", "vendor/qwen3.8-max", "Qwen3.8-max", "glm-5.3", "deepseek-v4-pro", "unknown-model"]) {
    const account = reconcileCatalog({ fetchedAt: 1, models: [{ id }] })[0]
    assert.deepEqual(account.efforts, [], id)
    assert.deepEqual(nativeModel(account).variants, [], id)
  }
})
