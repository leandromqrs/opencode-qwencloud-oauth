import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Schema, SchemaRepresentation } from "effect"
import { CATALOG_CHANGED_EVENT, createDiscovery as createAccountDiscovery, type ActiveConnection } from "../src/discovery.js"
import { fixtureContext, memoryStorage } from "./discovery-support.js"
import { catalogRPC } from "../src/discovery.js"
import { readQwenCloudQuota, toQwenCloudQuotaV1 } from "../src/quota.js"

const listing = (...ids: string[]) => ({ code: "200", data: { Data: [{ Items: ids.map(Model => ({ Model })) }] } })
const createDiscovery = (...args: Parameters<typeof createAccountDiscovery>) => createAccountDiscovery(args[0], args[1], args[2], { now: () => Date.parse("2026-11-10T00:00:00Z"), ...args[3] })

test("native quota is a fresh independently authenticated CLI read, not an OAuth-bound cache or startup command", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let calls = 0
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, {
    quotaRunner: async signal => {
      assert.equal(signal.aborted, false)
      calls++
      return { ok: true, stdout: JSON.stringify({ per1MonthPercentage: calls === 1 ? 0.5715795927593333 : 0, per1MonthResetTime: 1794672000000, account: "PRIVATE" }) }
    },
    fetch: async () => { throw new Error("CLI quota must not make management requests") },
  })
  await Effect.runPromise(discovery.synchronize)
  await Effect.runPromise(discovery.status)
  await Effect.runPromise(discovery.catalog)
  assert.equal(calls, 0)
  const before = [...storage.values.entries()]
  fixture.setConnection(undefined)
  const result = await Effect.runPromise(discovery.quota)
  const document = JSON.parse(JSON.stringify(result))
  const schema = SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema: catalogRPC.methods.quota.output, definitions: {} })
  assert.deepEqual(Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(document), result)
  assert.deepEqual(readQwenCloudQuota(document), result)
  assert.equal(result.state, "ready")
  assert.equal(result.source, "alibaba-console-cli")
  assert.equal(result.accountBinding, "unverified")
  assert.deepEqual(result.balances, [])
  assert.equal(toQwenCloudQuotaV1(result).entries[0].percentRemaining, 100 - 0.5715795927593333 * 100)
  assert.equal((await Effect.runPromise(discovery.status)).management, "not-connected")
  const second = await Effect.runPromise(discovery.quota)
  assert.equal(second.personalWindows?.[0].usedFraction, 0)
  assert.equal(calls, 2)
  fixture.setConnection({ type: "credential", id: "expired-management" as never, method: "oauth", label: "PRIVATE" })
  fixture.setExpiry(1)
  assert.equal((await Effect.runPromise(discovery.quota)).state, "ready")
  assert.equal(calls, 3)
  assert.equal(fixture.resolves(), 0)
  assert.deepEqual([...storage.values.entries()], before)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|fixture-access|fixture-refresh/)
})

test("separate native key metadata never binds an OAuth catalog to the key owner", async () => {
  const fixture = fixtureContext()
  const managementActive = fixture.ctx.integration.connection.active
  let keyConnection: ActiveConnection | undefined = { type: "credential", id: "private-key-id" as never, method: "key", label: "PRIVATE-KEY-LABEL" }
  const ctx = { ...fixture.ctx, integration: { ...fixture.ctx.integration, connection: {
    ...fixture.ctx.integration.connection,
    active: (id: string) => id === "qwencloud-api-key" ? Effect.sync(() => keyConnection) : managementActive(id),
  } } }
  let calls = 0
  const discovery = createDiscovery(ctx, () => Effect.void, undefined, { fetch: async () => { calls++; return Response.json(listing("management-account-model")) } })
  await Effect.runPromise(discovery.refresh)
  const status = await Effect.runPromise(discovery.status)
  assert.equal(status.inferenceKey.state, "stored-unverified")
  assert.equal(status.inferenceKey.accountBinding, "unverified")
  assert.equal(status.inference, "configured-unverified")
  assert.equal(fixture.resolves(), 1)
  keyConnection = { type: "credential", id: "another-private-key-id" as never, method: "key", label: "OTHER-PRIVATE" }
  await Effect.runPromise(discovery.handleEvent({ type: "credential.switched", data: { integrationID: "qwencloud-api-key" } }))
  assert.equal((await Effect.runPromise(discovery.catalog)).supported.length, 1)
  fixture.setConnection({ type: "credential", id: "other-management-account" as never, method: "oauth", label: "OTHER-PRIVATE" })
  assert.equal((await Effect.runPromise(discovery.catalog)).supported.length, 0)
  assert.equal((await Effect.runPromise(discovery.status)).inferenceKey.accountBinding, "unverified")
  keyConnection = undefined
  assert.equal((await Effect.runPromise(discovery.status)).inferenceKey.state, "not-connected")
  assert.equal(calls, 1)
  assert.equal(fixture.resolves(), 1)
  assert.doesNotMatch(JSON.stringify(status), /private-key-id|PRIVATE-KEY-LABEL|fixture-access/)
})

test("startup and status do not resolve credentials or issue HTTP; metadata survives location reload", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let calls = 0
  const published: unknown[] = []
  const dependencies = { fetch: async (input: string | URL | Request) => {
    calls++
    assert.equal(String(input), "https://cli.qwencloud.com/data/v2/api.json")
    return Response.json(listing("qwen3.8-max", "new-account-model"))
  } }
  const discovery = createDiscovery(fixture.ctx, (models, connection) => Effect.sync(() => { published.push({ models, connection }) }), undefined, dependencies)
  await Effect.runPromise(discovery.synchronize)
  await Effect.runPromise(discovery.status)
  assert.equal(calls, 0)
  assert.equal(fixture.resolves(), 0)
  await Effect.runPromise(discovery.refresh)
  assert.equal(calls, 1)
  const second = createDiscovery(fixture.ctx, () => Effect.void, undefined, dependencies)
  const catalog = await Effect.runPromise(second.catalog)
  assert.equal(catalog.supported.length, 2)
  assert.equal(catalog.entitlement, "unverified")
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify([...storage.values.values(), catalog, published]), /PRIVATE|fixture-access|fixture-refresh/)
  fixture.setConnection(undefined)
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 0)
})

test("403 invalidates shared cache and never publishes stale metadata", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let forbidden = false
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => forbidden ? Response.json({}, { status: 403 }) : Response.json(listing("qwen3.8-max")) })
  await Effect.runPromise(discovery.refresh)
  forbidden = true
  const result = await Effect.runPromise(discovery.refresh)
  assert.ok("error" in result)
  assert.equal((await Effect.runPromise(discovery.catalog)).supported.length, 0)
  const second = createDiscovery(fixture.ctx, () => Effect.void)
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 0)
})

test("durable denial survives failed removal in another running instance and restart", async () => {
  const shared = memoryStorage()
  const storage = { ...shared.storage, remove: () => Effect.die("remove unavailable") }
  const fixture = fixtureContext(storage)
  let forbidden = false
  const first = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => forbidden ? new Response(null, { status: 403 }) : Response.json(listing("account-model")) })
  await Effect.runPromise(first.refresh)
  const second = createDiscovery(fixture.ctx, () => Effect.void)
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 1)
  forbidden = true
  await Effect.runPromise(first.refresh)
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 0)
  assert.equal((await Effect.runPromise(createDiscovery(fixture.ctx, () => Effect.void).catalog)).supported.length, 0)
  assert.equal([...shared.values.values()].some(value => JSON.stringify(value).includes('"denied":true')), true)
})

test("delivered denial events defeat retained cache during complete mutation outage without loops", async () => {
  const shared = memoryStorage()
  let outage = false
  const storage = { ...shared.storage,
    set: (key: string, value: Parameters<typeof shared.storage.set>[1]) => outage ? Effect.die("set unavailable") : shared.storage.set(key, value),
    remove: (key: string) => outage ? Effect.die("remove unavailable") : shared.storage.remove(key),
  }
  const fixture = fixtureContext(storage)
  let forbidden = false
  const events: unknown[] = []
  const first = createDiscovery(fixture.ctx, () => Effect.void, data => Effect.sync(() => { events.push({ type: CATALOG_CHANGED_EVENT, data }) }), { fetch: async () => forbidden ? new Response(null, { status: 403 }) : Response.json(listing("account-model")) })
  await Effect.runPromise(first.refresh)
  let emitted = 0
  const second = createDiscovery(fixture.ctx, () => Effect.void, () => Effect.sync(() => { emitted++ }), { fetch: async () => Response.json(listing("recovered-model")) })
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 1)
  outage = true
  forbidden = true
  await Effect.runPromise(first.refresh)
  const event = events.at(-1)
  assert.doesNotMatch(JSON.stringify(event), /fixture|PRIVATE|credential:/)
  for (const invalid of [{ type: CATALOG_CHANGED_EVENT, data: { deniedAccount: "bad" } }, { type: "other", data: (event as any).data }, { type: CATALOG_CHANGED_EVENT, data: { deniedAccount: "0".repeat(64) } }]) {
    await Effect.runPromise(second.handleEvent(invalid))
    assert.equal((await Effect.runPromise(second.catalog)).supported.length, 1)
  }
  await Effect.runPromise(second.handleEvent(event))
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 0)
  assert.equal(emitted, 0)
  assert.ok("error" in await Effect.runPromise(second.refresh))
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 0)
  outage = false
  await Effect.runPromise(second.synchronize)
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 0)
  await Effect.runPromise(second.refresh)
  assert.equal((await Effect.runPromise(second.catalog)).supported[0].id, "recovered-model")
})

test("403 with a rejecting body cancellation preserves denial and invalidates shared cached models", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let forbidden = false
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => {
    if (!forbidden) return Response.json(listing("qwen3.8-max"))
    return new Response(new ReadableStream({ cancel() { return Promise.reject(new Error("cancellation failed")) } }), { status: 403 })
  } })
  await Effect.runPromise(discovery.refresh)
  forbidden = true
  const result = await Effect.runPromise(discovery.refresh)
  assert.ok("status" in result && result.status === 403)
  assert.equal((await Effect.runPromise(discovery.catalog)).supported.length, 0)
  const restarted = createDiscovery(fixture.ctx, () => Effect.void)
  assert.equal((await Effect.runPromise(restarted.catalog)).supported.length, 0)
})

test("connection switch while listing cannot commit or publish another account catalog", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  const published: unknown[] = []
  const discovery = createDiscovery(fixture.ctx, models => Effect.sync(() => { published.push(models) }), undefined, { fetch: async () => {
    fixture.setConnection({ type: "credential", id: "other-account" as never, method: "oauth", label: "OTHER-PRIVATE" })
    return Response.json(listing("old-account-model"))
  } })
  const result = await Effect.runPromise(discovery.refresh)
  assert.ok("error" in result)
  assert.equal(storage.values.size, 0)
  assert.equal(JSON.stringify(published).includes("old-account-model"), false)
})

test("transient failure can retain marked cache but malformed listing cannot claim a successful refresh", async () => {
  const fixture = fixtureContext()
  let mode = "success"
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => {
    if (mode === "transient") return Response.json({}, { status: 503 })
    if (mode === "malformed") return Response.json({ data: [] })
    return Response.json(listing("account-only"))
  } })
  await Effect.runPromise(discovery.refresh)
  mode = "transient"
  const stale = await Effect.runPromise(discovery.refresh)
  assert.ok("stale" in stale && stale.stale)
  mode = "malformed"
  assert.ok("error" in await Effect.runPromise(discovery.refresh))
})

test("untrusted durable metadata cannot restore secrets, unsupported IDs, or account mismatches", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => Response.json(listing("account-only")) })
  await Effect.runPromise(discovery.refresh)
  const [key, saved] = [...storage.values][0]
  const tampered = structuredClone(saved) as any
  tampered.catalog.models[0].id = "bad\nmodel"
  tampered.email = "PRIVATE"
  storage.values.set(key, tampered)
  const reloaded = createDiscovery(fixture.ctx, () => Effect.void)
  const result = await Effect.runPromise(reloaded.catalog)
  assert.deepEqual(result.supported, [])
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
})

test("expired management sessions invalidate catalog and never send expired credentials", async () => {
  const fixture = fixtureContext()
  let calls = 0
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => { calls++; return Response.json(listing("account-model")) } })
  await Effect.runPromise(discovery.refresh)
  fixture.setExpiry(1)
  assert.match(String((await Effect.runPromise(discovery.refresh) as { error: string }).error), /expired.*sign in/i)
  assert.equal((await Effect.runPromise(discovery.catalog)).supported.length, 0)
  assert.equal((await Effect.runPromise(discovery.status)).management, "expired")
  const quota = await Effect.runPromise(discovery.managementQuota)
  assert.equal(quota.state, "error")
  assert.deepEqual(quota.diagnostics, [{ action: "quota", code: "session-expired" }])
  const status = await Effect.runPromise(discovery.status)
  assert.equal(status.connected, true)
  assert.equal(status.management, "expired")
  assert.equal(calls, 1)
})

test("quota distinguishes absent connections from unavailable or invalid management credentials", async () => {
  for (const expires of [1, NaN, Infinity]) {
    const fixture = fixtureContext()
    fixture.setExpiry(expires)
    let calls = 0
    const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => { calls++; throw new Error("PRIVATE") } })
    const status = await Effect.runPromise(discovery.status)
    assert.equal(status.management, "stored-unverified")
    assert.equal(fixture.resolves(), 0)
    const quota = await Effect.runPromise(discovery.managementQuota)
    assert.equal(quota.state, "error")
    assert.deepEqual(quota.balances, [])
    assert.deepEqual(quota.diagnostics, [{ action: "quota", code: expires === 1 ? "session-expired" : "credentials-unavailable" }])
    assert.equal(calls, 0)
  }
  for (const resolve of [() => Effect.succeed(undefined), () => Effect.fail(new Error("PRIVATE"))]) {
    const fixture = fixtureContext()
    Object.assign(fixture.ctx.integration.connection, { resolve })
    const discovery = createDiscovery(fixture.ctx, () => Effect.void)
    const quota = await Effect.runPromise(discovery.managementQuota)
    assert.equal(quota.state, "error")
    assert.deepEqual(quota.diagnostics, [{ action: "quota", code: "credentials-unavailable" }])
    assert.equal((await Effect.runPromise(discovery.status)).management, "unavailable")
    assert.doesNotMatch(JSON.stringify(quota), /PRIVATE/)
    fixture.setConnection(undefined)
    assert.equal((await Effect.runPromise(discovery.managementQuota)).state, "disconnected")
    assert.equal((await Effect.runPromise(discovery.status)).management, "not-connected")
  }
})

test("management auth observations remain account bound and are cleared by credential updates", async () => {
  const fixture = fixtureContext()
  fixture.setExpiry(1)
  const discovery = createDiscovery(fixture.ctx, () => Effect.void)
  await Effect.runPromise(discovery.managementQuota)
  assert.equal((await Effect.runPromise(discovery.status)).management, "expired")
  await Effect.runPromise(discovery.handleEvent({ type: "integration.updated", data: {} }))
  assert.equal((await Effect.runPromise(discovery.status)).management, "expired")
  await Effect.runPromise(discovery.handleEvent({ type: "credential.switched", data: { integrationID: "qwencloud-api-key" } }))
  assert.equal((await Effect.runPromise(discovery.status)).management, "expired")
  fixture.setConnection({ type: "credential", id: "other-account" as never, method: "oauth", label: "PRIVATE" })
  assert.equal((await Effect.runPromise(discovery.status)).management, "stored-unverified")
  await Effect.runPromise(discovery.managementQuota)
  await Effect.runPromise(discovery.handleEvent({ type: "credential.updated" }))
  assert.equal((await Effect.runPromise(discovery.status)).management, "stored-unverified")
})

test("quota discards another account's response without labeling the new account expired", async () => {
  const fixture = fixtureContext()
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => {
    fixture.setConnection({ type: "credential", id: "other-account" as never, method: "oauth", label: "PRIVATE" })
    return Response.json({ code: "200", data: { IsGray: false } })
  } })
  const quota = await Effect.runPromise(discovery.managementQuota)
  assert.equal(quota.state, "error")
  assert.deepEqual(quota.balances, [])
  assert.deepEqual(quota.diagnostics, [{ action: "quota", code: "account-changed" }])
  assert.equal((await Effect.runPromise(discovery.status)).management, "stored-unverified")
})

test("explicit quota learns authorization rejection without claiming expiry or resolving on status", async () => {
  const fixture = fixtureContext()
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async () => Response.json({}, { status: 401 }) })
  const quota = await Effect.runPromise(discovery.managementQuota)
  assert.equal(quota.state, "error")
  assert.deepEqual(quota.diagnostics, [{ action: "QuerySubscriptionGray", code: "unauthorized" }])
  const resolves = fixture.resolves()
  assert.equal((await Effect.runPromise(discovery.status)).management, "unauthorized")
  assert.equal(fixture.resolves(), resolves)
})

test("quota discards expired credentials resolved while the active account changes", async () => {
  const fixture = fixtureContext()
  Object.assign(fixture.ctx.integration.connection, { resolve: () => Effect.sync(() => {
    fixture.setConnection({ type: "credential", id: "other-account" as never, method: "oauth", label: "PRIVATE" })
    return { type: "oauth", access: "PRIVATE", refresh: "", expires: 1 }
  }) })
  const discovery = createDiscovery(fixture.ctx, () => Effect.void)
  const quota = await Effect.runPromise(discovery.managementQuota)
  assert.deepEqual(quota.diagnostics, [{ action: "quota", code: "account-changed" }])
  assert.equal((await Effect.runPromise(discovery.status)).management, "stored-unverified")
})

test("quota resolves only on explicit RPC, passes cancellation, and discards switched-account results", async () => {
  const fixture = fixtureContext()
  let calls = 0
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async (input, init) => {
    calls++
    assert.equal(String(input), "https://cli.qwencloud.com/data/v2/api.json")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-access")
    assert.ok(init?.signal)
    fixture.setConnection(undefined)
    return Response.json({ code: "403", data: null })
  } })
  await Effect.runPromise(discovery.status)
  assert.equal(fixture.resolves(), 0)
  assert.equal(calls, 0)
  const result = await Effect.runPromise(discovery.managementQuota)
  assert.equal(result.state, "disconnected")
  assert.equal(fixture.resolves(), 1)
  assert.ok(calls > 0)
  assert.doesNotMatch(JSON.stringify(result), /fixture-access|PRIVATE/)
})
