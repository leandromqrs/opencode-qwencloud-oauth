import { Rpc, type Plugin } from "@opencode/plugin/effect"
import { Effect, Semaphore, type Schema } from "effect"
import { createHash } from "node:crypto"
import { CatalogError, discoverCatalog, sanitizeSavedModels, MANAGEMENT_ORIGIN, type Catalog } from "./catalog.js"
import { METADATA_SOURCE, reconcileCatalog, type AccountModel } from "./inventory.js"
import { AUTH_ORIGIN, object, type Fetch } from "./oauth.js"
import { API_BASE, KEY_INTEGRATION_ID } from "./transport.js"
import { getIndividualQuota, getQwenCloudQuota, individualQuotaResult, qwenCloudQuotaSchema, type QwenCloudQuota } from "./quota.js"
import { readAlibabaConsoleQuota, type QuotaCliRunner } from "./quota-cli.js"
import { supplementTokenPlan, TOKEN_PLAN_SUPPORT } from "./token-plan.js"

export const CATALOG_CHANGED_EVENT = "rpc.qwencloud.catalogUpdated"
const VERSION = 2
const ROUTING = `${AUTH_ORIGIN}:${MANAGEMENT_ORIGIN}:ap-southeast-1:${API_BASE}`
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const
const publicOutput = { type: "object", additionalProperties: true } as const
const catalogEventSchema = { type: "object", properties: { deniedAccount: { type: "string", pattern: "^[a-f0-9]{64}$" } }, additionalProperties: false } as const
export interface CatalogNotification { deniedAccount?: string }
export const catalogRPC = Rpc.define({ id: "qwencloud", methods: {
  refresh: { input: emptyInput, output: publicOutput }, status: { input: emptyInput, output: publicOutput },
  catalog: { input: emptyInput, output: publicOutput }, quota: { input: emptyInput, output: qwenCloudQuotaSchema },
  managementQuota: { input: emptyInput, output: qwenCloudQuotaSchema },
}, events: { catalogUpdated: { schema: catalogEventSchema } } })
export type ActiveConnection = Parameters<Plugin.Context["integration"]["connection"]["resolve"]>[0]
export const connectionKey = (connection: ActiveConnection | undefined) => connection?.type === "credential" && connection.method === "oauth" ? `credential:${connection.id}` : undefined
const accountHash = (connection: ActiveConnection) => createHash("sha256").update(`${ROUTING}:${connectionKey(connection)}`).digest("hex")
export const catalogStorageKey = (connection: ActiveConnection) => `catalog:v${VERSION}:${accountHash(connection)}`
interface Snapshot { catalog: Catalog }
type ManagementState = "configured-unverified" | "expired" | "unavailable" | "unauthorized"

function quotaFailure(code: "session-expired" | "credentials-unavailable" | "account-changed"): QwenCloudQuota {
  return { state: "error", source: "qwencloud-token-plan", observedAt: new Date().toISOString(), balances: [], diagnostics: [{ action: "quota", code }] }
}

function restore(value: unknown, connection: ActiveConnection): Snapshot | undefined {
  const record = object(value)
  if (!record || !connectionKey(connection) || connection.type !== "credential" || record.version !== VERSION || record.routing !== ROUTING || record.metadataSource !== METADATA_SOURCE || record.connectionID !== connection.id) return undefined
  const saved = object(record.catalog)
  if (!saved || !Number.isSafeInteger(saved.fetchedAt) || Number(saved.fetchedAt) <= 0 || Number(saved.fetchedAt) > Date.now() + 60_000) return undefined
  try { return { catalog: { fetchedAt: Number(saved.fetchedAt), models: sanitizeSavedModels(saved.models) } } } catch { return undefined }
}

function snapshot(connection: ActiveConnection, value: Snapshot) {
  return { version: VERSION, routing: ROUTING, metadataSource: METADATA_SOURCE, connectionID: connection.type === "credential" ? connection.id : undefined, catalog: value.catalog }
}

/** Account-bound metadata and explicit management reads; published models do not establish inference entitlement. */
export function createDiscovery(ctx: Plugin.Context, publish: (models: AccountModel[], connection: ActiveConnection) => Effect.Effect<void>, notify: (data: CatalogNotification) => Effect.Effect<void> = () => Effect.void, dependencies: { fetch?: Fetch; quotaRunner?: QuotaCliRunner; now?: () => number; quotaSource?: "individual-api" } = {}) {
  const supportedModels = (catalog: Catalog) => supplementTokenPlan(reconcileCatalog(catalog), (dependencies.now ?? Date.now)())
  let cached: { connection: ActiveConnection; snapshot: Snapshot; models: AccountModel[] } | undefined
  let refreshing = false
  let storageState: "available" | "invalid" | "unavailable" = "available"
  let management: { connection: string; state: ManagementState; expires?: number } | undefined
  const denied = new Set<string>()
  const automaticAttempts = new Set<string>()
  const lock = Semaphore.makeUnsafe(1)
  const active = Effect.suspend(() => ctx.integration.connection.active("qwencloud-oauth"))
  const observeManagement = (connection: ActiveConnection, credential: { type: string; expires?: number; access?: string } | undefined): ManagementState => {
    const validExpiry = credential?.type === "oauth" && Number.isSafeInteger(credential.expires) && Number(credential.expires) > 0
    const state = !validExpiry || !credential?.access ? "unavailable" : Number(credential.expires) <= Date.now() ? "expired" : "configured-unverified"
    management = { connection: connectionKey(connection)!, state, ...(validExpiry ? { expires: credential.expires } : {}) }
    return state
  }
  const current = Effect.gen(function* () {
    const result = yield* lock.withPermit(Effect.gen(function* () {
      const connection = yield* active
      const old = cached
      if (!connectionKey(connection) || connectionKey(cached?.connection) !== connectionKey(connection)) cached = undefined
      if (management?.connection !== connectionKey(connection)) management = undefined
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
        else {
          const models = supportedModels(restored.catalog)
          if (!cached || JSON.stringify(cached.snapshot) !== JSON.stringify(restored) || JSON.stringify(cached.models) !== JSON.stringify(models)) {
            const source = { type: "credential" as const, id: connection.type === "credential" ? connection.id : "" as never, method: "oauth" as const, label: "QwenCloud connection" }
            cached = { connection: source, snapshot: restored, models }
          }
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
    const keyConnection = yield* ctx.integration.connection.active(KEY_INTEGRATION_ID)
    const keyStored = keyConnection?.type === "credential" && keyConnection.method === "key"
    const ageMs = cached ? Math.max(0, Date.now() - cached.snapshot.catalog.fetchedAt) : null
    return {
      connected: !!connectionKey(connection), refreshing,
      management: !connectionKey(connection) ? "not-connected" : !management ? "stored-unverified" : management.expires !== undefined && management.expires <= Date.now() ? "expired" : management.state,
      refreshedAt: cached?.snapshot.catalog.fetchedAt ?? null,
      supportedModels: cached?.models.length ?? 0,
      storage: storageState,
      freshness: ageMs === null ? "missing" : ageMs > STALE_AFTER_MS ? "stale" : "fresh", ageMs,
      inference: keyStored ? "configured-unverified" : "key-required",
      keyProvisioning: "manual-key-required",
      inferenceKey: {
        integrationID: KEY_INTEGRATION_ID,
        state: keyStored ? "stored-unverified" : "not-connected",
        accountBinding: "unverified",
      },
    }
  })
  const catalog = Effect.gen(function* () {
    const { inference } = yield* status
    return {
      metadataSource: METADATA_SOURCE,
      tokenPlanSupport: TOKEN_PLAN_SUPPORT,
      limitSource: "QwenCloud management catalog ModelInfo; documentation-only entries and missing limits unknown (native zero sentinel).",
      capabilitySource: "QwenCloud InferenceMetadata modalities; exact Qwen effort variants from official documentation; documentation-only modalities and tool support unknown.",
      pricing: "QwenCloud management catalog reference tariffs using CLI display order and explicit-cache precedence; absent cache rates estimated at ordinary input; not actual Token Plan cash charges.", entitlement: "unverified",
      accountListed: cached?.snapshot.catalog ?? null,
      supported: cached?.models ?? [], inference,
    }
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
    if (envelope?.type === "credential.updated" || (envelope?.type === "credential.switched" && data?.integrationID === "qwencloud-oauth")) management = undefined
    if (envelope?.type === CATALOG_CHANGED_EVENT && typeof data?.deniedAccount === "string" && /^[a-f0-9]{64}$/.test(data.deniedAccount)) {
      const hash = data.deniedAccount
      yield* lock.withPermit(Effect.sync(() => { denied.add(hash) }))
    }
    yield* current
    if (envelope?.type === "credential.switched" && data?.integrationID === "qwencloud-oauth") {
      const key = connectionKey(yield* active)
      if (key && !cached && !automaticAttempts.has(key)) {
        automaticAttempts.add(key)
        yield* refresh
      }
    }
  }).pipe(Effect.asVoid)
  const refresh = Effect.gen(function* () {
    if (refreshing) return { error: "Qwen catalog refresh is already running." }
    refreshing = true
    return yield* Effect.gen(function* () {
      const connection = yield* current
      if (!connection || !connectionKey(connection)) return { error: "Sign in to QwenCloud before refreshing the catalog." }
      const credential = yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (connectionKey(connection) !== connectionKey(yield* active)) return { error: "Active Qwen connection changed; refresh again." }
      const authState = observeManagement(connection, credential)
      if (!credential || credential.type !== "oauth") return { error: "Qwen OAuth credentials unavailable; sign in again." }
      if (authState === "unavailable") {
        if (!Number.isSafeInteger(credential.expires) || credential.expires <= 0) yield* invalidate(connection)
        return { error: "Qwen OAuth credentials unavailable; check the QwenCloud connection." }
      }
      if (authState === "expired") { yield* invalidate(connection); return { error: "QwenCloud session expired; sign in again." } }
      const outcome = yield* Effect.tryPromise({
        try: async signal => {
          const listing = await discoverCatalog(credential.access, dependencies.fetch, signal)
          signal.throwIfAborted()
          return { catalog: listing }
        }, catch: error => error instanceof CatalogError ? error : new CatalogError("network_error"),
      }).pipe(Effect.map(value => ({ ok: true as const, value })), Effect.catch(error => Effect.succeed({ ok: false as const, error })))
      if (connectionKey(connection) !== connectionKey(yield* active)) return { error: "Active Qwen connection changed; refresh again." }
      if (!outcome.ok) {
        if (outcome.error.status === 403 || outcome.error.status === 401) {
          management = { connection: connectionKey(connection)!, state: "unauthorized" }
          yield* invalidate(connection)
        }
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
  const authenticatedQuota = (source: "individual-api" | "management-bss") => Effect.gen(function* () {
    const individual = source === "individual-api"
    const disconnected = individual
      ? Effect.sync(() => individualQuotaResult("disconnected"))
      : Effect.promise(() => getQwenCloudQuota())
    const fail = (code: "session-expired" | "credentials-unavailable" | "account-changed") => individual ? individualQuotaResult("error", code) : quotaFailure(code)
    const connection = yield* current
    const account = connectionKey(connection)
    if (!connection || !account) return yield* disconnected

    const activeAccount = active.pipe(Effect.map(connectionKey))
    const credential = yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const resolvedAccount = yield* activeAccount
    if (account !== resolvedAccount) return resolvedAccount ? fail("account-changed") : yield* disconnected
    const authState = observeManagement(connection, credential)
    if (authState === "expired") return fail("session-expired")
    if (authState === "unavailable" || credential?.type !== "oauth") return fail("credentials-unavailable")

    const readQuota = individual ? getIndividualQuota : getQwenCloudQuota
    const result = yield* Effect.promise(signal => readQuota(credential.access, dependencies.fetch, signal))
    const completedAccount = yield* activeAccount
    if (account !== completedAccount) return completedAccount ? fail("account-changed") : yield* disconnected
    const managementDenied = result.diagnostics.some(d => d.code === "unauthorized" && (!individual || d.action === "GenerateCLIAccessToken"))
    if (managementDenied) management = { connection: account, state: "unauthorized" }
    return result
  })
  const managementQuota = authenticatedQuota("management-bss")
  const quota = dependencies.quotaSource === "individual-api" ? authenticatedQuota("individual-api")
    : Effect.promise(signal => readAlibabaConsoleQuota({ runner: dependencies.quotaRunner, workspaceRoot: ctx.location?.directory }, signal))
  return { refresh, status, catalog, quota, managementQuota, handleEvent, synchronize: current.pipe(Effect.asVoid), bindings: (connection: ActiveConnection) => cached && connectionKey(cached.connection) === connectionKey(connection) ? supportedModels(cached.snapshot.catalog) : [] }
}
