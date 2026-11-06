import assert from "node:assert/strict"
import { test } from "node:test"
import { getQwenQuota, readQwenQuota, toQwenQuotaV1 } from "../src/quota.js"

test("quota is unsupported without credentials, clocks, requests or inferred metrics", () => {
  assert.deepEqual(getQwenQuota(), {
    state: "unavailable", reason: "unsupported", message: "Quota not exposed by Qwen Code",
  })
  assert.deepEqual(getQwenQuota(false), { ...getQwenQuota(), connected: false })
  assert.deepEqual(getQwenQuota(true), { ...getQwenQuota(), connected: true })
})

test("quota-v1 publishes only an honest status row", () => {
  assert.deepEqual(toQwenQuotaV1(getQwenQuota()), {
    version: "quota-v1", entries: [{
      kind: "value", name: "quota", label: "Qwen Code quota", resultType: "status",
      value: "Quota not exposed by Qwen Code",
    }],
  })
  assert.equal(toQwenQuotaV1(getQwenQuota(false)).entries[0].value, "Not signed in; quota not exposed by Qwen Code")
})

test("native quota boundary rejects fabricated balances and unknown payloads", () => {
  assert.deepEqual(readQwenQuota(getQwenQuota(true)), getQwenQuota(true))
  for (const value of [null, [], {}, { ...getQwenQuota(), connected: "true" },
    { ...getQwenQuota(), amount: 10 }, { ...getQwenQuota(), percentRemaining: 99 },
    { ...getQwenQuota(), resetAt: 1234 }, { ...getQwenQuota(), reason: "network-error" },
    { ...getQwenQuota(), message: "secret" }]) {
    assert.throws(() => readQwenQuota(value), /Invalid quota status/)
  }
})
