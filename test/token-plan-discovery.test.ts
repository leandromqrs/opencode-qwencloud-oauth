import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { createDiscovery } from "../src/discovery.js"
import { nativeModel } from "../src/inventory.js"
import { TOKEN_PLAN_SUPPORT } from "../src/token-plan.js"
import { fixtureContext, memoryStorage } from "./discovery-support.js"

const during = Date.parse("2026-11-12T00:00:00Z")
const after = Date.parse("2026-11-26T00:00:00+08:00")
const listing = (...ids: string[]) => ({ code: "200", data: { Data: [{ Items: ids.map(Model => ({ Model })) }] } })

test("cache restoration derives documented efforts for observed and supplemental models without HTTP", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { now: () => during, fetch: async () => Response.json(listing("qwen3.8-max")) })
  await Effect.runPromise(discovery.refresh)
  const restored = createDiscovery(fixture.ctx, () => Effect.void, undefined, { now: () => during, fetch: async () => { throw new Error("No startup HTTP") } })
  const result = await Effect.runPromise(restored.catalog)
  for (const id of ["qwen3.8-max", "qwen4-max-preview"]) {
    const account = result.supported.find(model => model.id === id)
    assert.ok(account)
    assert.deepEqual(account.efforts, ["none", "low", "medium", "xhigh"])
    assert.deepEqual(nativeModel(account).variants.map(variant => variant.id), account.efforts)
  }
  assert.deepEqual(result.supported.find(model => model.id === "auto")?.efforts, [])
  assert.doesNotMatch(JSON.stringify([...storage.values.values()]), /reasoningEffort|efforts|qwen4-max-preview/)
})

test("successful account discovery publishes documented support separately without saving fabricated observations", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let calls = 0
  const published: string[][] = []
  const dependencies = { now: () => during, fetch: async () => { calls++; return Response.json(listing(...Array.from({ length: 186 }, (_, i) => `model-${i}`))) } }
  const discovery = createDiscovery(fixture.ctx, models => Effect.sync(() => { published.push(models.map(model => model.id)) }), undefined, dependencies)
  assert.deepEqual((await Effect.runPromise(discovery.catalog)).supported, [])
  const result = await Effect.runPromise(discovery.refresh)
  assert.ok("accountListed" in result)
  if (!("accountListed" in result)) throw new Error("Expected catalog")
  assert.equal(result.accountListed?.models.length, 186)
  assert.equal(result.supported.length, 188)
  assert.deepEqual(result.tokenPlanSupport, TOKEN_PLAN_SUPPORT)
  assert.equal(result.entitlement, "unverified")
  assert.deepEqual(published.at(-1)?.slice(-2), ["qwen4-max-preview", "auto"])
  assert.deepEqual(nativeModel(result.supported[186]).cost, [])
  assert.doesNotMatch(JSON.stringify([...storage.values.values()]), /qwen4-max-preview|token-plan-documentation/)
  const restored = createDiscovery(fixture.ctx, () => Effect.void, undefined, dependencies)
  assert.equal((await Effect.runPromise(restored.catalog)).supported.length, 188)
  assert.equal(calls, 1)
  assert.equal(fixture.resolves(), 1)
})

test("expiry removes preview entries at runtime, in bindings and across cache restoration without HTTP", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let now = during
  let calls = 0
  const published: string[][] = []
  const dependencies = { now: () => now, fetch: async () => { calls++; return Response.json(listing("account-model", "qwen4-max-preview", "qwen4.0-max-preview")) } }
  const discovery = createDiscovery(fixture.ctx, models => Effect.sync(() => { published.push(models.map(model => model.id)) }), undefined, dependencies)
  await Effect.runPromise(discovery.refresh)
  const connection = await Effect.runPromise(fixture.ctx.integration.connection.active("qwencloud-oauth"))
  assert.ok(connection)
  assert.ok(discovery.bindings(connection!).some(model => model.id === "qwen4-max-preview"))
  now = after
  assert.deepEqual(discovery.bindings(connection!).map(model => model.id), ["account-model"])
  await Effect.runPromise(discovery.synchronize)
  assert.deepEqual(published.at(-1), ["account-model"])
  assert.deepEqual((await Effect.runPromise(discovery.catalog)).supported.map(model => model.id), ["account-model"])
  assert.deepEqual((await Effect.runPromise(createDiscovery(fixture.ctx, () => Effect.void, undefined, dependencies).catalog)).supported.map(model => model.id), ["account-model"])
  assert.equal(calls, 1)
})

test("documentation supplements remain fenced by accounts, failed discovery and durable denials", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let forbidden = true
  const dependencies = { now: () => during, fetch: async () => forbidden ? new Response(null, { status: 403 }) : Response.json(listing("account-model")) }
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, dependencies)
  await Effect.runPromise(discovery.refresh)
  assert.deepEqual((await Effect.runPromise(discovery.catalog)).supported, [])
  forbidden = false
  await Effect.runPromise(discovery.refresh)
  assert.equal((await Effect.runPromise(discovery.catalog)).supported.length, 3)
  forbidden = true
  await Effect.runPromise(discovery.refresh)
  assert.deepEqual((await Effect.runPromise(createDiscovery(fixture.ctx, () => Effect.void, undefined, dependencies).catalog)).supported, [])
  fixture.setConnection({ type: "credential", id: "other-account" as never, method: "oauth", label: "PRIVATE" })
  assert.deepEqual((await Effect.runPromise(discovery.catalog)).supported, [])
  fixture.setConnection(undefined)
  assert.deepEqual((await Effect.runPromise(discovery.catalog)).supported, [])
})

test("routing migration refuses old-host snapshots instead of silently changing their provenance", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { now: () => during, fetch: async () => Response.json(listing("account-model")) })
  await Effect.runPromise(discovery.refresh)
  const [key, value] = [...storage.values][0]
  const old = structuredClone(value) as any
  old.routing = old.routing.replace("token-plan.maas.qwencloudapi.com", "token-plan.ap-southeast-1.maas.aliyuncs.com")
  storage.values.set(key, old)
  const restarted = createDiscovery(fixture.ctx, () => Effect.void, undefined, { now: () => during, fetch: async () => { throw new Error("No startup HTTP") } })
  assert.deepEqual((await Effect.runPromise(restarted.catalog)).supported, [])
  assert.equal((await Effect.runPromise(restarted.status)).storage, "invalid")
})
