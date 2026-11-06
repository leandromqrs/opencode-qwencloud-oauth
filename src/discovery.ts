import { Rpc, type Plugin } from "@opencode/plugin/effect"
import { Effect, Semaphore, type Schema } from "effect"
import { createHash } from "node:crypto"
import { CatalogError, discoverCatalog, parseListing, type Catalog } from "./catalog.js"
import { EFFORT_SOURCE, METADATA_SOURCE, MODALITY_SOURCE, reconcileCatalog, type AccountModel } from "./inventory.js"
import { AUTH_ORIGIN, CLIENT_ID, getMembership, object, type Fetch, type Membership } from "./oauth.js"
import { API_BASE, HOST_TRANSPORT_BLOCKER } from "./transport.js"
import { getQwenQuota, qwenQuotaSchema } from "./quota.js"

export const CATALOG_CHANGED_EVENT = "rpc.qwen-code.catalogUpdated"
const VERSION = 1
const ROUTING = `${AUTH_ORIGIN}:${CLIENT_ID}:${API_BASE}`
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const
const publicOutput = { type: "object", additionalProperties: true } as const
const catalogEventSchema = { type: "object", properties: { deniedAccount: { type: "string", pattern: "^[a-f0-9]{64}$" } }, additionalProperties: false } as const
export interface CatalogNotification { deniedAccount?: string }
export const catalogRPC = Rpc.define({ id: "qwen-code", methods: {
  refresh: { input: emptyInput, output: publicOutput }, status: { input: emptyInput, output: publicOutput },
  catalog: { input: emptyInput, output: publicOutput }, quota: { input: emptyInput, output: qwenQuotaSchema },
}, events: { catalogUpdated: { schema: catalogEventSchema } } })
export type ActiveConnection = Parameters<Plugin.Context["integration"]["connection"]["resolve"]>[0]
export const connectionKey = (connection: ActiveConnection | undefined) => connection?.type === "credential" && connection.method === "oauth" ? `credential:${connection.id}` : undefined
const accountHash = (connection: ActiveConnection) => createHash("sha256").update(`${ROUTING}:${connectionKey(connection)}`).digest("hex")
export const catalogStorageKey = (connection: ActiveConnection) => `catalog:v${VERSION}:${accountHash(connection)}`
interface Snapshot { catalog: Catalog; membership: Membership }

function restore(value: unknown, connection: ActiveConnection): Snapshot | undefined {
  const record = object(value)
  if (!record || !connectionKey(connection) || connection.type !== "credential" || record.version !== VERSION || record.routing !== ROUTING || record.metadataSource !== METADATA_SOURCE || record.connectionID !== connection.id) return undefined
  const saved = object(record.catalog)
  if (!saved || !Number.isSafeInteger(saved.fetchedAt) || Number(saved.fetchedAt) <= 0 || Number(saved.fetchedAt) > Date.now() + 60_000) return undefined
  const membership: Membership = ["plus", "pro", "lite", "free"].includes(String(record.membership)) ? record.membership as Membership : "unknown"
  try { return { catalog: { fetchedAt: Number(saved.fetchedAt), models: parseListing({ data: saved.models }) }, membership } } catch { return undefined }
}

function snapshot(connection: ActiveConnection, value: Snapshot) {
  return { version: VERSION, routing: ROUTING, metadataSource: METADATA_SOURCE, connectionID: connection.type === "credential" ? connection.id : undefined, catalog: value.catalog, membership: value.membership }
}

export function createDiscovery(ctx: Plugin.Context, publish: (models: AccountModel[], connection: ActiveConnection) => Effect.Effect<void>, notify: (data: CatalogNotification) => Effect.Effect<void> = () => Effect.void, dependencies: { fetch?: Fetch } = {}) {
  let cached: { connection: ActiveConnection; snapshot: Snapshot; models: AccountModel[] } | undefined
  let refreshing = false
  let storageState: "available" | "invalid" | "unavailable" = "available"
  const denied = new Set<string>()
  const lock = Semaphore.makeUnsafe(1)
  const active = Effect.suspend(() => ctx.integration.connection.active("qwen-code-oauth"))
  const current = Effect.gen(function* () {
    const result = yield* lock.withPermit(Effect.gen(function* () {
      const connection = yield* active
      const old = cached
      if (!connectionKey(connection) || connectionKey(cached?.connection) !== connectionKey(connection)) cached = undefined
      if (connection && connectionKey(connection)) {
        const loaded = yield* ctx.storage.get(catalogStorageKey(connection)).pipe(Effect.map(value => ({ ok: true, value })), Effect.catchDefect(() => Effect.succeed({ ok: false, value: undefined })))
        if (connectionKey(connection) !== connectionKey(yield* active)) { cached = undefined; return { connection: undefined, changed: !!old, previous: old?.connection } }
        storageState = loaded.ok ? "available" : "unavailable"
        const record = object(loaded.value)
        const tombstone = record?.version === VERSION && record.routing === ROUTING && record.accountHash === accountHash(connection) && record.denied === true
        if (tombstone) denied.add(accountHash(connection))
        const restored = loaded.ok && !denied.has(accountHash(connection)) ? restore(loaded.value, connection) : undefined
        if (loaded.ok && loaded.value !== undefined && !restored && !tombstone) storageState = "invalid"
        if (!restored) cached = undefined
        else if (!cached || JSON.stringify(cached.snapshot) !== JSON.stringify(restored)) {
          const source = { type: "credential" as const, id: connection.type === "credential" ? connection.id : "" as never, method: "oauth" as const, label: "Qwen Code connection" }
          cached = { connection: source, snapshot: restored, models: reconcileCatalog(restored.catalog) }
        }
      }
      return { connection, changed: old !== cached, previous: old?.connection }
    }))
    if (result.changed) {
      if (cached && connectionKey(cached.connection) === connectionKey(yield* active)) yield* publish(cached.models, cached.connection)
      else if (result.previous) yield* publish([], result.previous)
    }
    return result.connection
  })
  const status = Effect.gen(function* () {
    const connection = yield* current
    const ageMs = cached ? Math.max(0, Date.now() - cached.snapshot.catalog.fetchedAt) : null
    return { connected: !!connectionKey(connection), refreshing, refreshedAt: cached?.snapshot.catalog.fetchedAt ?? null, supportedModels: cached?.models.length ?? 0, membership: cached?.snapshot.membership ?? "unknown", storage: storageState, freshness: ageMs === null ? "missing" : ageMs > STALE_AFTER_MS ? "stale" : "fresh", ageMs, inference: "blocked", inferenceReason: HOST_TRANSPORT_BLOCKER }
  })
  const catalog = Effect.gen(function* () {
    yield* current
    return { metadataSource: METADATA_SOURCE, effortSource: EFFORT_SOURCE, modalitySource: MODALITY_SOURCE, limitSource: "Official embedded Max/Flash limits, not live endpoint metadata; other limits unknown (native zero sentinel).", capabilitySource: "Official subscription Max/Flash modalities and Chat driver; unknown IDs conservative text-only, tools disabled.", pricing: "unknown", accountListed: cached?.snapshot.catalog ?? null, supported: cached?.models ?? [], membership: cached?.snapshot.membership ?? "unknown", inference: "blocked" }
  })
  const invalidate = (connection: ActiveConnection) => Effect.gen(function* () {
    const hash = accountHash(connection)
    yield* lock.withPermit(Effect.gen(function* () {
      denied.add(hash)
      const saved = yield* ctx.storage.set(catalogStorageKey(connection), { version: VERSION, routing: ROUTING, accountHash: hash, denied: true }).pipe(Effect.as(true), Effect.catchDefect(() => Effect.succeed(false)))
      if (!saved) yield* ctx.storage.remove(catalogStorageKey(connection)).pipe(Effect.catchDefect(() => Effect.sync(() => { storageState = "unavailable" })))
    }))
    yield* current
    yield* notify({ deniedAccount: hash })
  })
  const handleEvent = (event: unknown) => Effect.gen(function* () {
    const envelope = object(event)
    const data = object(envelope?.data)
    if (envelope?.type === CATALOG_CHANGED_EVENT && typeof data?.deniedAccount === "string" && /^[a-f0-9]{64}$/.test(data.deniedAccount)) {
      const hash = data.deniedAccount
      yield* lock.withPermit(Effect.sync(() => { denied.add(hash) }))
    }
    yield* current
  }).pipe(Effect.asVoid)
  const refresh = Effect.gen(function* () {
    if (refreshing) return { error: "Qwen catalog refresh is already running." }
    refreshing = true
    return yield* Effect.gen(function* () {
      const connection = yield* current
      if (!connection || !connectionKey(connection)) return { error: "Sign in to Qwen Code before refreshing the catalog." }
      const credential = yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!credential || credential.type !== "oauth") return { error: "Qwen OAuth credentials unavailable; sign in again." }
      if (connectionKey(connection) !== connectionKey(yield* active)) return { error: "Active Qwen connection changed; refresh again." }
      const outcome = yield* Effect.tryPromise({
        try: async signal => {
          const listing = await discoverCatalog(credential.access, dependencies.fetch, signal)
          const membership = await getMembership(credential.access, dependencies.fetch, signal).catch((): Membership => "unknown")
          signal.throwIfAborted()
          return { catalog: listing, membership }
        }, catch: error => error instanceof CatalogError ? error : new CatalogError("network_error"),
      }).pipe(Effect.map(value => ({ ok: true as const, value })), Effect.catch(error => Effect.succeed({ ok: false as const, error })))
      if (connectionKey(connection) !== connectionKey(yield* active)) return { error: "Active Qwen connection changed; refresh again." }
      if (!outcome.ok) {
        if (outcome.error.status === 403 || outcome.error.status === 401) yield* invalidate(connection)
        if (outcome.error.transient && cached && connectionKey(cached.connection) === connectionKey(connection)) return { ...(yield* catalog), stale: true }
        return { error: outcome.error.message, ...(outcome.error.status ? { status: outcome.error.status } : {}) }
      }
      const committed = yield* lock.withPermit(Effect.gen(function* () {
        if (connectionKey(connection) !== connectionKey(yield* active)) return false
        const saved = yield* ctx.storage.set(catalogStorageKey(connection), snapshot(connection, outcome.value) as unknown as Schema.Json).pipe(Effect.as(true), Effect.catchDefect(() => Effect.sync(() => { storageState = "unavailable"; return false })))
        if (saved) denied.delete(accountHash(connection))
        return saved && connectionKey(connection) === connectionKey(yield* active)
      }))
      if (!committed) return { error: "Qwen catalog could not be saved or the active connection changed; refresh again." }
      yield* current
      yield* notify({})
      return yield* catalog
    }).pipe(Effect.ensuring(Effect.sync(() => { refreshing = false })))
  })
  const quota = current.pipe(Effect.map(connection => getQwenQuota(!!connectionKey(connection))))
  return { refresh, status, catalog, quota, handleEvent, synchronize: current.pipe(Effect.asVoid), bindings: (connection: ActiveConnection) => cached && connectionKey(cached.connection) === connectionKey(connection) ? cached.models : [] }
}
