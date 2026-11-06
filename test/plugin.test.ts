import { test } from "node:test"
import assert from "node:assert/strict"
import plugin, { parseOptions } from "../src/index.js"
import { type Plugin } from "@opencode/plugin/effect"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { Effect, Exit, Scope, Stream } from "effect"
import { memoryStorage } from "./discovery-support.js"

test("configuration cannot enable an inference bypass or fabricate models", () => {
  assert.deepEqual(parseOptions({}), { timeoutMs: 120_000 })
  for (const options of [{ unsafe: true }, { models: ["invented"] }, { baseURL: "https://evil.test" }, { timeoutMs: 0 }]) assert.throws(() => parseOptions(options))
})

test("native plugin registers OAuth/RPC without startup HTTP; inference blocks before credential resolution", async () => {
  let auth: IntegrationOAuthMethodRegistration | undefined
  let inventory: any
  let resolves = 0
  let requests = 0
  const handlers: Record<string, () => Effect.Effect<any>> = {}
  const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
  const registration = { dispose: Effect.void, events: { emit: () => Effect.void } }
  const integration = { id: "qwen-code-oauth", name: "" }
  const original = globalThis.fetch
  globalThis.fetch = async () => { requests++; throw new Error("network forbidden") }
  const ctx = {
    options: {}, storage: memoryStorage().storage, event: { subscribe: () => Stream.empty },
    provider: { transform: (fn: any) => Effect.sync(() => { fn({ add: (value: unknown) => { inventory = value } }); return registration }), reload: () => Effect.void },
    integration: {
      transform: (fn: any) => Effect.sync(() => { fn({ method: { update: (value: typeof auth) => { auth = value } }, update: (_id: string, cb: (value: typeof integration) => void) => cb(integration) }); return registration }),
      connection: { active: () => Effect.succeed({ type: "credential", id: "fixture", method: "oauth", label: "PRIVATE" }), resolve: () => Effect.sync(() => { resolves++; throw new Error("must not resolve") }) },
    },
    rpc: { register: (definition: any, implementations: typeof handlers) => Effect.sync(() => { assert.equal(definition.id, "qwen-code"); Object.assign(handlers, implementations); return registration }) },
    session: { hook: (name: string, callback: any, scope: any) => Effect.sync(() => { assert.equal(scope.providerID, "qwen-code"); hooks.set(name, callback); return registration }) },
  }
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
    assert.equal(plugin.id, "opencode-qwen-code-oauth")
    assert.equal(inventory.info.package, "@opencode/ai/providers/openai-compatible")
    assert.deepEqual(inventory.models, [])
    assert.equal(integration.name, "Qwen Code")
    assert.equal(auth?.integrationID, "qwen-code-oauth")
    assert.equal(auth?.method.id, "device")
    assert.equal(auth?.method.label, "Sign in with Qwen Plus / Pro")
    assert.deepEqual(Object.keys(handlers).sort(), ["catalog", "quota", "refresh", "status"])
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({})), /host correction/)
    assert.deepEqual(await Effect.runPromise(handlers.quota()), { state: "unavailable", reason: "unsupported", message: "Quota not exposed by Qwen Code", connected: true })
    assert.equal(resolves, 0)
    assert.equal(requests, 0)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); globalThis.fetch = original }
})

test("native authorization scope disposal cancels an in-flight token poll", async () => {
  let auth!: IntegrationOAuthMethodRegistration
  const registration = { dispose: Effect.void, events: { emit: () => Effect.void } }
  const ctx = {
    options: {}, storage: memoryStorage().storage, event: { subscribe: () => Stream.empty },
    provider: { transform: () => Effect.succeed(registration), reload: () => Effect.void },
    rpc: { register: () => Effect.succeed(registration) }, session: { hook: () => Effect.succeed(registration) },
    integration: { connection: { active: () => Effect.succeed(undefined) }, transform: (fn: any) => Effect.sync(() => { fn({ method: { update: (value: typeof auth) => { auth = value } }, update: () => {} }); return registration }) },
  }
  let started!: () => void
  const polling = new Promise<void>(resolve => { started = resolve })
  let aborted = false
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("device/code")) return Response.json({ device_code: "private-device", user_code: "ABCD", verification_uri: "https://chat.qwen.ai/authorize", verification_uri_complete: "https://chat.qwen.ai/authorize?user_code=ABCD&client=qwen-code", expires_in: 120, interval: 0.001 })
    started()
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")) }, { once: true }))
  }
  const pluginScope = await Effect.runPromise(Scope.make())
  const authScope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(pluginScope)))
    const authorization = await Effect.runPromise(auth.authorize({} as never).pipe(Scope.provide(authScope)))
    assert.equal(authorization.mode, "auto")
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
