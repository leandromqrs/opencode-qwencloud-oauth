import assert from "node:assert/strict"
import { test } from "node:test"
import { getQwenCloudQuota, readQwenCloudQuota, toQwenCloudQuotaV1 } from "../src/quota.js"

const token = "synthetic-oauth-token"
const wrap = (data: unknown) => Response.json({ code: "200", data })
const instance = { Status: "valid", InitCapacityBaseValue: "100.000000000000000001", CurrCapacityBaseValue: "20.000000000000000001" }

function legacy(overrides: Partial<Record<string, unknown>> = {}): typeof fetch {
  return async (input, init) => {
    assert.equal(input, "https://cli.qwencloud.com/data/v2/api.json")
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`)
    const body = JSON.parse(init?.body as string)
    assert.equal(body.product, "BssOpenAPI-V3")
    assert.equal(body.region, "ap-southeast-1")
    if (body.action === "QuerySubscriptionGray") return wrap({ IsGray: false })
    assert.equal(body.action, "DescribeFrInstances")
    assert.equal(body.params.Group, "tokenPlan")
    assert.equal(body.params.PageNum, "1")
    const code = body.params.CommodityCode as string
    assert.equal(body.params.PageSize, code.includes("addon") ? "100" : "10")
    return wrap(overrides[code] ?? { Data: code.includes("personal") ? [instance] : [], TotalCount: code.includes("personal") ? 1 : 0 })
  }
}

test("disconnected and pre-cancelled reads never fetch", async () => {
  const never: typeof fetch = async () => { throw new Error("must not fetch") }
  assert.equal((await getQwenCloudQuota(undefined, never)).state, "disconnected")
  const cancelled = await getQwenCloudQuota(token, never, AbortSignal.abort())
  assert.equal(cancelled.diagnostics[0].code, "cancelled")
})

test("legacy preserves exact Credits, explicit period zero, scope and no expiration reset", async () => {
  const result = await getQwenCloudQuota(token, legacy({ sfm_tokenplanpersonal_dp_intl: {
    Data: [{ ...instance, CapacityTypeCode: "periodMonthlyShift", periodCapacityBaseValue: "0", EndTime: 1900000000000, Uid: "private" }], TotalCount: 1,
  } }))
  assert.equal(result.state, "ready")
  assert.deepEqual(result.balances[0], { id: "personal-1", kind: "personal", scope: "personal", status: "valid", unit: "Credits", total: instance.InitCapacityBaseValue, remaining: "0", action: "DescribeFrInstances" })
  assert.ok(!JSON.stringify(result).includes("private"))
  assert.deepEqual(readQwenCloudQuota(result), result)
  const rows = toQwenCloudQuotaV1(result).entries
  assert.ok(rows.some(row => row.kind === "percent" && row.percentRemaining === 0))
  assert.ok(rows.some(row => row.kind === "value" && row.value === "0 Credits"))
  const numericZero = await getQwenCloudQuota(token, legacy({ sfm_tokenplanpersonal_dp_intl: { Data: [{ ...instance, CapacityTypeCode: "periodMonthlyShift", periodCapacityBaseValue: 0 }] } }))
  assert.equal(numericZero.balances[0].remaining, "0")
})

test("seat route reads aggregate groups and addons separately with millisecond reset", async () => {
  const result = await getQwenCloudQuota(token, async (_input, init) => {
    const body = JSON.parse(init?.body as string)
    if (body.action === "QuerySubscriptionGray") return wrap({ IsGray: true })
    if (body.action === "GetSeatSubscriptionSummary") {
      assert.deepEqual(body.params, { productCode: "sfm_tokenplanteams_dp_intl" })
      return wrap({ Success: true, Code: "200", Data: { Uid: "private", SubscriptionGroupList: [
        { TotalValue: "999", SurplusValue: "999", EquityList: [{ TotalValue: "100", SurplusValue: "25.5" }], NextCycleFlushTime: 1900000000000 },
        { TotalValue: "10", SurplusValue: "0", NextCycleFlushTime: "2030-03-17T17:46:40Z" },
      ] } })
    }
    assert.equal(body.params.CommodityCode, "sfm_tokenplanteamsaddon_dp_intl")
    return wrap({ Data: [{ ...instance, CurrCapacityBaseValue: "3" }] })
  })
  assert.equal(result.state, "ready")
  assert.equal(result.balances[0].scope, "team-aggregate")
  assert.equal(result.balances[0].remaining, "25.5")
  assert.equal(result.balances[0].resetAt, new Date(1900000000000).toISOString())
  assert.equal(result.balances[2].kind, "addon")
  assert.equal(result.balances[2].scope, "unknown")
  assert.ok(toQwenCloudQuotaV1(result).entries.some(row => row.kind === "percent" && row.percentRemaining === 25.5))
})

test("missing data is unknown, never zero or not subscribed", async () => {
  const empty = await getQwenCloudQuota(token, legacy({ sfm_tokenplanpersonal_dp_intl: { Data: [], TotalCount: 0 } }))
  assert.equal(empty.state, "unknown")
  assert.deepEqual(empty.balances, [])
  const missing = await getQwenCloudQuota(token, legacy({ sfm_tokenplanpersonal_dp_intl: { Data: [{ Status: "valid" }] } }))
  assert.equal(missing.state, "unknown")
  assert.equal(missing.balances[0].remaining, undefined)
  assert.ok(toQwenCloudQuotaV1(missing).entries.every(row => row.kind !== "percent"))
})

test("partial failures and pagination are explicit, business failures cannot become absence", async () => {
  const result = await getQwenCloudQuota(token, legacy({
    sfm_tokenplanteams_dp_intl: { Success: false, Code: "Denied", Message: "secret" },
    sfm_tokenplanteamsaddon_dp_intl: { Data: [instance], TotalCount: 101 },
  }))
  assert.equal(result.state, "partial")
  assert.ok(result.diagnostics.some(d => d.code === "business-error"))
  assert.ok(result.diagnostics.some(d => d.code === "truncated"))
  assert.ok(!JSON.stringify(result).includes("secret"))
  const denied = await getQwenCloudQuota(token, async () => Response.json({ code: "403", message: token }))
  assert.equal(denied.state, "error")
  assert.equal(denied.diagnostics[0].code, "business-error")
})

test("routing failure is an error, not a legacy fallback", async () => {
  let calls = 0
  const result = await getQwenCloudQuota(token, async () => { calls++; return wrap({}) })
  assert.equal(calls, 1)
  assert.equal(result.state, "error")
})

test("malformed amounts, reset values and inconsistent allocations do not generate percentages", async () => {
  const result = await getQwenCloudQuota(token, legacy({ sfm_tokenplanpersonal_dp_intl: { Data: [
    { ...instance, InitCapacityBaseValue: "1", CurrCapacityBaseValue: "2" },
    { ...instance, InitCapacityBaseValue: "NaN", CurrCapacityBaseValue: "-1" },
  ] } }))
  assert.equal(result.state, "partial")
  assert.ok(!toQwenCloudQuotaV1(result).entries.some(row => row.kind === "percent"))
  for (const bad of [null, {}, { ...result, token }, { ...result, balances: [{ ...result.balances[0], unit: "USD" }] }]) assert.throws(() => readQwenCloudQuota(bad))
})

test("responses are bounded and errors sanitized", async () => {
  for (const [reply, code] of [
    [() => new Response("", { status: 401 }), "unauthorized"],
    [() => new Response("", { status: 429 }), "rate-limited"],
    [() => new Response("", { status: 302 }), "http-error"],
    [() => new Response("x".repeat(262145), { headers: { "content-type": "application/json" } }), "body-too-large"],
    [() => Response.json({ code: "200", data: { Success: false, Message: token } }), "business-error"],
    [() => Response.json({ code: "200", Success: false, data: { IsGray: false }, Message: token }), "business-error"],
  ] as const) {
    const result = await getQwenCloudQuota(token, async () => reply())
    assert.equal(result.state, "error")
    assert.equal(result.diagnostics[0].code, code)
    assert.ok(!JSON.stringify(result).includes(token))
  }
})

test("missing quantities keep other observations explicitly partial", async () => {
  const result = await getQwenCloudQuota(token, legacy({ sfm_tokenplanteams_dp_intl: { Data: [{ Status: "valid" }] } }))
  assert.equal(result.state, "partial")
  assert.ok(result.diagnostics.some(d => d.code === "missing-balance"))
  const unknown = await getQwenCloudQuota(token, legacy({ sfm_tokenplanpersonal_dp_intl: { Data: [{ Status: "valid" }] } }))
  assert.equal(unknown.state, "unknown")
  assert.deepEqual(readQwenCloudQuota(unknown), unknown)
})

test("invalid seat resets are omitted and diagnostics survive alongside usable balances", async () => {
  for (const value of ["2030-02-30T00:00:00Z", "tomorrow", -1, 999999999999999999]) {
    const result = await getQwenCloudQuota(token, async (_input, init) => {
      const body = JSON.parse(init?.body as string)
      if (body.action === "QuerySubscriptionGray") return wrap({ IsGray: true })
      if (body.action === "DescribeFrInstances") return wrap({ Data: [] })
      return wrap({ SubscriptionGroupList: [{ TotalValue: "100", SurplusValue: "25", NextCycleFlushTime: value }] })
    })
    assert.equal(result.state, "partial")
    assert.equal(result.balances[0].resetAt, undefined)
    assert.ok(result.diagnostics.some(d => d.code === "invalid-reset"))
  }
})

test("cancellation bounds fetch and streaming bodies even when fetch ignores abort", async () => {
  for (const bodyStage of [false, true]) {
    const controller = new AbortController()
    let cancelled = false
    const promise = getQwenCloudQuota(token, async () => {
      queueMicrotask(() => controller.abort())
      return bodyStage ? new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { "content-type": "application/json" } }) : new Promise(() => {})
    }, controller.signal)
    const result = await promise
    assert.equal(result.diagnostics[0].code, "cancelled")
    if (bodyStage) assert.equal(cancelled, true)
  }
})
