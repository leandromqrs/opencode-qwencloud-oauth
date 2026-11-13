import { test } from "node:test"
import assert from "node:assert/strict"
import plugin, { parseOptions } from "../src/index.js"
import { type Plugin } from "@opencode/plugin/effect"
import type { IntegrationMethodRegistration, IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { Effect, Exit, Scope, Stream } from "effect"
import { fixtureContext, memoryStorage } from "./discovery-support.js"

test("configuration cannot enable an inference bypass or fabricate models", () => {
  assert.deepEqual(parseOptions({}), { timeoutMs: 600_000 })
  assert.deepEqual(parseOptions({ timeoutMs: 120_000 }), { timeoutMs: 120_000 })
  for (const options of [{ unsafe: true }, { models: ["invented"] }, { baseURL: "https://evil.test" }, { timeoutMs: 0 }]) assert.throws(() => parseOptions(options))
})

test("native plugin registers separate key auth and secured driver without startup HTTP or credential resolution", async () => {
  let auth: IntegrationOAuthMethodRegistration | undefined
  let inventory: any
  let resolves = 0
  let requests = 0
  const handlers: Record<string, () => Effect.Effect<any>> = {}
  const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
  const registration = { dispose: Effect.void, events: { emit: () => Effect.void } }
  const integration = { id: "qwencloud-oauth", name: "" }
  const keyIntegration = { id: "qwencloud-api-key", name: "" }
  const methods: IntegrationMethodRegistration[] = []
  let keyConnected = false
  const original = globalThis.fetch
  globalThis.fetch = async () => { requests++; throw new Error("network forbidden") }
  const storage = memoryStorage()
  const ctx = {
    options: {}, storage: storage.storage, event: { subscribe: () => Stream.empty },
    provider: { transform: (fn: any) => Effect.sync(() => { fn({ add: (value: unknown) => { inventory = value } }); return registration }), reload: () => Effect.void },
    integration: {
      transform: (fn: any) => Effect.sync(() => { fn({ method: { update: (value: IntegrationMethodRegistration) => { methods.push(value); if (value.method.type === "oauth") auth = value as IntegrationOAuthMethodRegistration } }, update: (id: string, cb: (value: typeof integration) => void) => cb(id === integration.id ? integration : keyIntegration) }); return registration }),
      connection: { active: (id: string) => Effect.sync(() => id === "qwencloud-api-key" ? keyConnected ? { type: "credential", id: "private-key-id", method: "key", label: "PRIVATE-KEY-LABEL" } : undefined : { type: "credential", id: "fixture", method: "oauth", label: "PRIVATE" }), resolve: () => Effect.sync(() => { resolves++; throw new Error("must not resolve") }) },
    },
    rpc: { register: (definition: any, implementations: typeof handlers) => Effect.sync(() => { assert.equal(definition.id, "qwencloud"); Object.assign(handlers, implementations); return registration }) },
    session: { hook: (name: string, callback: any, scope: any) => Effect.sync(() => { assert.equal(scope.providerID, "qwencloud"); hooks.set(name, callback); return registration }) },
  }
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
    assert.equal(plugin.id, "opencode-qwencloud-oauth")
    assert.equal(inventory.info.package, new URL("../src/driver.js", import.meta.url).href)
    assert.equal(inventory.info.settings.apiKey, undefined)
    assert.equal(inventory.sourceConnection, undefined)
    assert.deepEqual(inventory.models, [])
    assert.equal(integration.name, "QwenCloud")
    assert.equal(inventory.info.integrationID, "qwencloud-api-key")
    assert.equal(keyIntegration.name, "QwenCloud API key")
    assert.deepEqual(methods.map(value => [value.integrationID, value.method.type]), [["qwencloud-oauth", "oauth"], ["qwencloud-api-key", "key"]])
    assert.equal("authorize" in methods[1], false)
    assert.equal(auth?.integrationID, "qwencloud-oauth")
    assert.equal(auth?.method.id, "device")
    assert.equal(auth?.method.label, "Sign in with QwenCloud")
    assert.deepEqual(Object.keys(handlers).sort(), ["catalog", "managementQuota", "quota", "refresh", "status"])
    assert.equal((await Effect.runPromise(handlers.status())).keyProvisioning, "manual-key-required")
    assert.deepEqual((await Effect.runPromise(handlers.status())).inferenceKey, { integrationID: "qwencloud-api-key", state: "not-connected", accountBinding: "unverified" })
    keyConnected = true
    const withKey = await Effect.runPromise(handlers.status())
    assert.deepEqual(withKey.inferenceKey, { integrationID: "qwencloud-api-key", state: "stored-unverified", accountBinding: "unverified" })
    assert.equal(withKey.inference, "configured-unverified")
    assert.doesNotMatch(JSON.stringify(withKey), /private-key-id|PRIVATE-KEY-LABEL/)
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ model: { id: "invented" } })), /active account-bound catalog/)
    keyConnected = false
    assert.equal((await Effect.runPromise(handlers.status())).inferenceKey.state, "not-connected")
    assert.equal(resolves, 0)
    assert.equal(requests, 0)
    assert.deepEqual([...storage.values.keys()], ["device-client-id:v1"])
    const deviceID = storage.values.get("device-client-id:v1")
    assert.match(String(deviceID), /^[a-f0-9-]{36}$/)
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
    assert.equal(storage.values.get("device-client-id:v1"), deviceID)
    assert.equal(requests, 0)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); globalThis.fetch = original }
})

test("native OAuth resolution does not refresh valid near-expiry sessions or hide actual expiry", async () => {
  let auth!: IntegrationOAuthMethodRegistration
  let expires = Date.now() + 60_000
  let calls = 0
  let refreshes = 0
  const handlers: Record<string, () => Effect.Effect<any>> = {}
  const registration = { dispose: Effect.void, events: { emit: () => Effect.void } }
  const fixture = fixtureContext()
  const ctx = {
    ...fixture.ctx, options: {}, event: { subscribe: () => Stream.empty },
    provider: { transform: () => Effect.succeed(registration), reload: () => Effect.void },
    rpc: { register: (_definition: unknown, implementations: typeof handlers) => Effect.sync(() => { Object.assign(handlers, implementations); return registration }) },
    session: { hook: () => Effect.succeed(registration) },
    integration: {
      transform: (fn: any) => Effect.sync(() => {
        fn({ method: { update: (value: IntegrationMethodRegistration) => { if (value.method.type === "oauth") auth = value as IntegrationOAuthMethodRegistration } }, update: () => {} })
        return registration
      }),
      connection: {
        active: (id: string) => id === "qwencloud-oauth" ? fixture.ctx.integration.connection.active(id) : Effect.succeed(undefined),
        resolve: () => Effect.gen(function* () {
          const credential = { type: "oauth" as const, methodID: "device" as never, access: "fixture-access", refresh: "", expires }
          if (auth.refresh && credential.expires <= Date.now() + 5 * 60_000) {
            refreshes++
            return yield* auth.refresh(credential)
          }
          return credential
        }),
      },
    },
  }
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), "https://cli.qwencloud.com/data/v2/api.json")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-access")
    const { action } = JSON.parse(init?.body as string)
    return Response.json({ code: "200", data: action === "QuerySubscriptionGray" ? { IsGray: false } : { Data: [] } })
  }
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
    assert.equal(typeof handlers.quota, "function")
    assert.equal(typeof handlers.managementQuota, "function")
    const quota = await Effect.runPromise(handlers.managementQuota())
    assert.equal(quota.state, "unknown")
    assert.deepEqual(quota.diagnostics, [])
    assert.equal(calls, 4)
    assert.equal(refreshes, 0)
    assert.equal(auth.refresh, undefined)
    assert.equal((await Effect.runPromise(handlers.status())).management, "configured-unverified")
    expires = 1
    const expired = await Effect.runPromise(handlers.managementQuota())
    assert.equal(expired.state, "error")
    assert.deepEqual(expired.diagnostics, [{ action: "quota", code: "session-expired" }])
    assert.equal((await Effect.runPromise(handlers.status())).management, "expired")
    assert.equal(calls, 4)
    assert.equal(refreshes, 0)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); globalThis.fetch = original }
})

test("native provider fences its key and account-bound documented support including preview expiry", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-12T00:00:00Z") })
  const fixture = fixtureContext()
  const registration = { dispose: Effect.void, events: { emit: () => Effect.void } }
  let keyConnection = { type: "credential", id: "fixture-key", method: "key", label: "PRIVATE" }
  let emit!: (event: unknown) => void
  const event = new Promise<unknown>(resolve => { emit = resolve })
  let sourceReloaded!: () => void
  const keyReloaded = new Promise<void>(resolve => { sourceReloaded = resolve })
  let transform!: (editor: any) => void
  let inventory: any
  let reloads = 0
  const handlers: Record<string, () => Effect.Effect<any>> = {}
  const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
  const apply = () => transform({ add: (record: unknown) => { inventory = record } })
  const ctx = {
    ...fixture.ctx, options: { timeoutMs: 2345 }, event: { subscribe: () => Stream.fromAsyncIterable({ async *[Symbol.asyncIterator]() { yield await event } }, error => error) },
    integration: { ...fixture.ctx.integration,
      connection: { ...fixture.ctx.integration.connection, active: (id: string) => id === "qwencloud-api-key" ? Effect.succeed(keyConnection) : fixture.ctx.integration.connection.active(id) },
      transform: () => Effect.succeed(registration),
    },
    provider: { transform: (fn: typeof transform) => Effect.sync(() => { transform = fn; apply(); return registration }), reload: () => Effect.sync(() => { reloads++; apply(); if (inventory.sourceConnection?.id === "other-key") sourceReloaded() }) },
    rpc: { register: (_definition: unknown, implementations: typeof handlers) => Effect.sync(() => { Object.assign(handlers, implementations); return registration }) },
    session: { hook: (name: string, callback: any) => Effect.sync(() => { hooks.set(name, callback); return registration }) },
  }
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(input, "https://cli.qwencloud.com/data/v2/api.json")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-access")
    return Response.json({ code: "200", data: { Data: [{ Items: [{ Model: "qwen3.8-max", Prices: [{ Type: "input_token", Price: "2", PriceUnit: "USD/1M tokens", PriceName: "Input" }, { Type: "output_token", Price: "6", PriceUnit: "USD/1M tokens", PriceName: "Output" }, { Type: "input_token_cache", Price: "0.25", PriceUnit: "USD/1M tokens", PriceName: "Implicit cache" }, { Type: "input_token_batch", Price: "1", PriceUnit: "USD/1M tokens", PriceName: "Batch input" }, { Type: "output_token_batch", Price: "3", PriceUnit: "USD/1M tokens", PriceName: "Batch output" }, { Type: "input_token_cache_creation_5m", Price: "2.5", PriceUnit: "USD/1M tokens", PriceName: "Explicit cache creation" }, { Type: "input_token_cache_read", Price: "0.17", PriceUnit: "USD/1M tokens", PriceName: "Explicit cache read" }], MultiPrices: [{ Prices: [{}] }] }] }] } })
  }
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
    assert.equal(fixture.resolves(), 0)
    assert.equal(inventory.sourceConnection.id, "fixture-key")
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ model: { id: "qwen4-max-preview" } })), /active account-bound catalog/)
    const refreshed = await Effect.runPromise(handlers.refresh())
    assert.match(refreshed.pricing, /reference.*cache.*estimated/i)
    assert.match(refreshed.pricing, /CLI display order and explicit-cache precedence/)
    assert.deepEqual(refreshed.accountListed.models[0].pricing.Prices.map((item: { Price: string }) => item.Price), ["2", "6", "0.25", "1", "3", "2.5", "0.17"])
    assert.equal("cache" in refreshed.accountListed.models[0].pricing, false)
    assert.equal(calls, 1)
    assert.equal(fixture.resolves(), 1)
    assert.equal(inventory.models.length, 3)
    assert.equal(inventory.models[0].package, inventory.info.package)
    assert.deepEqual(inventory.models[0].cost, [{ input: 2, output: 6, cache: { read: 0.17, write: 2.5 } }])
    assert.equal(inventory.info.settings.qwencloudTimeoutMs, 2345)
    assert.equal(inventory.sourceConnection.method, "key")
    assert.notEqual(inventory.sourceConnection.id, "fixture-account")
    await Effect.runPromise(hooks.get("http.request")!({ model: { id: "qwen3.8-max" } }))
    await Effect.runPromise(hooks.get("http.request")!({ model: { id: "qwen4-max-preview" } }))
    await Effect.runPromise(hooks.get("http.request")!({ model: { id: "auto" } }))
    assert.equal(refreshed.supported.find((model: any) => model.id === "qwen4-max-preview").metadata, "token-plan-documentation")
    assert.deepEqual(inventory.models.find((model: any) => model.id === "qwen4-max-preview").cost, [])
    for (const id of ["invented", "qwen4.0-max-preview"]) await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ model: { id } })), /active account-bound catalog/)
    keyConnection = { ...keyConnection, id: "other-key" }
    emit({ type: "credential.switched", data: { integrationID: "qwencloud-api-key" } })
    await keyReloaded
    assert.equal(inventory.sourceConnection.id, "other-key")
    assert.equal(inventory.models.length, 3)
    assert.equal((await Effect.runPromise(handlers.status())).inferenceKey.accountBinding, "unverified")
    t.mock.timers.setTime(Date.parse("2026-11-26T00:00:00+08:00"))
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ model: { id: "qwen4-max-preview" } })), /active account-bound catalog/)
    assert.equal(inventory.models.length, 1)
    await Effect.runPromise(hooks.get("http.request")!({ model: { id: "qwen3.8-max" } }))
    fixture.setConnection({ type: "credential", id: "other-account" as never, method: "oauth", label: "PRIVATE" })
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ model: { id: "qwen3.8-max" } })), /active account-bound catalog/)
    assert.equal(inventory.models.length, 0)
    assert.ok(reloads >= 2)
    assert.equal(fixture.resolves(), 1)
    assert.equal(calls, 1)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); globalThis.fetch = original }
})

test("native authorization scope disposal cancels an in-flight token poll", async () => {
  let auth!: IntegrationOAuthMethodRegistration
  const registration = { dispose: Effect.void, events: { emit: () => Effect.void } }
  const ctx = {
    options: {}, storage: memoryStorage().storage, event: { subscribe: () => Stream.empty },
    provider: { transform: () => Effect.succeed(registration), reload: () => Effect.void },
    rpc: { register: () => Effect.succeed(registration) }, session: { hook: () => Effect.succeed(registration) },
    integration: { connection: { active: () => Effect.succeed(undefined) }, transform: (fn: any) => Effect.sync(() => { fn({ method: { update: (value: IntegrationMethodRegistration) => { if (value.method.type === "oauth") auth = value as IntegrationOAuthMethodRegistration } }, update: () => {} }); return registration }) },
  }
  let started!: () => void
  const polling = new Promise<void>(resolve => { started = resolve })
  let aborted = false
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/cli/device/code") return Response.json({ Success: true, Data: { Token: "private-device", VerificationUrl: `https://account.qwencloud.com/sso/OIDCAuth?${new URLSearchParams({ app_type: "synthetic-app", lang: "en-US", auth_token: "synthetic-browser", oauth_callback: "https://www.qwencloud.com/oauth/confirm?auth_token=synthetic-callback" })}`, ExpiresIn: 120, Interval: 0.001 } })
    started()
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")) }, { once: true }))
  }
  const pluginScope = await Effect.runPromise(Scope.make())
  const authScope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(pluginScope)))
    const authorization = await Effect.runPromise(auth.authorize({} as never).pipe(Scope.provide(authScope)))
    assert.equal(authorization.mode, "auto")
    assert.match(authorization.instructions, /https:\/\/home\.qwencloud\.com\/api-keys/)
    assert.doesNotMatch(authorization.instructions, /not established/)
    if (authorization.mode !== "auto") throw new Error("Expected native auto authorization")
    const result = Effect.runPromise(authorization.callback)
    void result.catch(() => {})
    await polling
    await Effect.runPromise(Scope.close(authScope, Exit.void))
    await assert.rejects(result, /cancelled/)
    assert.equal(aborted, true)
  } finally {
    await Effect.runPromise(Scope.close(authScope, Exit.void))
    await Effect.runPromise(Scope.close(pluginScope, Exit.void))
    globalThis.fetch = original
  }
})
