import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { CATALOG_CHANGED_EVENT, createDiscovery } from "../src/discovery.js"
import { fixtureContext, memoryStorage } from "./discovery-support.js"

test("startup and status do not resolve credentials or issue HTTP; metadata survives location reload", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let calls = 0
  const published: unknown[] = []
  const dependencies = { fetch: async (input: string | URL | Request) => {
    calls++
    return String(input).endsWith("/models") ? Response.json({ data: [{ id: "qwen3.8-max" }, { id: "new-account-model" }] }) : Response.json({ member_type: "pro", email: "PRIVATE-EMAIL", sub: "PRIVATE-SUB", name: "PRIVATE-NAME" })
  } }
  const discovery = createDiscovery(fixture.ctx, (models, connection) => Effect.sync(() => { published.push({ models, connection }) }), undefined, dependencies)
  await Effect.runPromise(discovery.synchronize)
  await Effect.runPromise(discovery.status)
  assert.equal(calls, 0)
  assert.equal(fixture.resolves(), 0)
  await Effect.runPromise(discovery.refresh)
  assert.equal(calls, 2)
  const second = createDiscovery(fixture.ctx, () => Effect.void, undefined, dependencies)
  const catalog = await Effect.runPromise(second.catalog)
  assert.equal(catalog.supported.length, 2)
  assert.equal(catalog.membership, "pro")
  assert.equal(calls, 2)
  assert.doesNotMatch(JSON.stringify([...storage.values.values(), catalog, published]), /PRIVATE|fixture-access|fixture-refresh/)
  fixture.setConnection(undefined)
  assert.equal((await Effect.runPromise(second.catalog)).supported.length, 0)
})

test("403 invalidates shared cache and never publishes stale metadata", async () => {
  const storage = memoryStorage()
  const fixture = fixtureContext(storage.storage)
  let forbidden = false
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async input => String(input).endsWith("/models")
    ? forbidden ? Response.json({}, { status: 403 }) : Response.json({ data: [{ id: "qwen3.8-max" }] })
    : Response.json({ member_type: "plus" }) })
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
  const first = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async input => String(input).endsWith("/models")
    ? forbidden ? new Response(null, { status: 403 }) : Response.json({ data: [{ id: "account-model" }] })
    : Response.json({ member_type: "plus" }) })
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
  const first = createDiscovery(fixture.ctx, () => Effect.void, data => Effect.sync(() => { events.push({ type: CATALOG_CHANGED_EVENT, data }) }), { fetch: async input => String(input).endsWith("/models")
    ? forbidden ? new Response(null, { status: 403 }) : Response.json({ data: [{ id: "account-model" }] })
    : Response.json({ member_type: "plus" }) })
  await Effect.runPromise(first.refresh)
  let emitted = 0
  const second = createDiscovery(fixture.ctx, () => Effect.void, () => Effect.sync(() => { emitted++ }), { fetch: async input => String(input).endsWith("/models") ? Response.json({ data: [{ id: "recovered-model" }] }) : Response.json({ member_type: "plus" }) })
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
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async input => {
    if (!String(input).endsWith("/models")) return Response.json({ member_type: "plus" })
    if (!forbidden) return Response.json({ data: [{ id: "qwen3.8-max" }] })
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
    return Response.json({ data: [{ id: "old-account-model" }] })
  } })
  const result = await Effect.runPromise(discovery.refresh)
  assert.ok("error" in result)
  assert.equal(storage.values.size, 0)
  assert.equal(JSON.stringify(published).includes("old-account-model"), false)
})

test("transient failure can retain marked cache but malformed listing cannot claim a successful refresh", async () => {
  const fixture = fixtureContext()
  let mode = "success"
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async input => {
    if (!String(input).endsWith("/models")) return Response.json({ member_type: "pro" })
    if (mode === "transient") return Response.json({}, { status: 503 })
    if (mode === "malformed") return Response.json({ data: [] })
    return Response.json({ data: [{ id: "account-only" }] })
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
  const discovery = createDiscovery(fixture.ctx, () => Effect.void, undefined, { fetch: async input => String(input).endsWith("/models") ? Response.json({ data: [{ id: "account-only" }] }) : Response.json({ member_type: "pro" }) })
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
