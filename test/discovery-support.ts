import { Effect, type Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { ActiveConnection } from "../src/discovery.js"

export function memoryStorage() {
  const values = new Map<string, Schema.Json>()
  const storage: Plugin.Context["storage"] = {
    get: key => Effect.sync(() => structuredClone(values.get(key))),
    set: (key, value) => Effect.sync(() => { values.set(key, structuredClone(value)) }),
    remove: key => Effect.sync(() => { values.delete(key) }),
    scan: options => Effect.sync(() => ({ entries: [...values].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) })),
  }
  return { values, storage }
}

export function fixtureContext(storage = memoryStorage().storage) {
  let connection: ActiveConnection | undefined = { type: "credential", id: "fixture-account" as never, method: "oauth", label: "PRIVATE-EMAIL" }
  let resolves = 0
  const ctx = {
    storage,
    integration: { connection: {
      active: () => Effect.sync(() => connection),
      resolve: () => Effect.sync(() => { resolves++; return { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600_000 } }),
    } },
  } as unknown as Plugin.Context
  return { ctx, setConnection: (value: ActiveConnection | undefined) => { connection = value }, resolves: () => resolves }
}
