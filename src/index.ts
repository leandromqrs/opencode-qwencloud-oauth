import { Integration, Plugin, Provider } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { authorizationStartError, beginLogin, METHOD_ID, type Login } from "./oauth.js"
import { randomUUID } from "node:crypto"
import { CATALOG_CHANGED_EVENT, catalogRPC, connectionKey, createDiscovery, type ActiveConnection, type CatalogNotification } from "./discovery.js"
import { nativeModel, type AccountModel } from "./inventory.js"
import { API_BASE, DEFAULT_TIMEOUT_MS, KEY_INTEGRATION_ID } from "./transport.js"
import { acquireQuotaBridge, parseQuotaBridge, type QuotaBridgeConfig } from "./quota-bridge-plugin.js"
import { publishQwenCloudQuota } from "./quota-publication.js"

export const PROVIDER_ID = Provider.ID.make("qwencloud")
export const INTEGRATION_ID = Integration.ID.make("qwencloud-oauth")
export { catalogRPC } from "./discovery.js"
export { KEY_INTEGRATION_ID } from "./transport.js"

export function parseOptions(options: Record<string, unknown>): { timeoutMs: number; quotaBridge?: QuotaBridgeConfig; quotaSource?: "individual-api"; publishQuota?: true } {
  if (Object.keys(options).some(key => key !== "timeoutMs" && key !== "quotaBridge" && key !== "quotaSource" && key !== "publishQuota")) throw new Error("Unsupported QwenCloud option.")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 600_000) throw new Error("Qwen timeoutMs must be between 1000 and 600000.")
  const quotaBridge = parseQuotaBridge(options.quotaBridge)
  const quotaSource = options.quotaSource
  if (quotaSource !== undefined && quotaSource !== "individual-api") throw new Error("QwenCloud quotaSource must be individual-api when set.")
  if (quotaSource && quotaBridge) throw new Error("Disable quotaBridge when using the Individual API.")
  if (options.publishQuota !== undefined && typeof options.publishQuota !== "boolean") throw new Error("QwenCloud publishQuota must be true or false.")
  if (options.publishQuota === true && quotaSource !== "individual-api") throw new Error("QwenCloud publishQuota requires quotaSource: individual-api.")
  return { timeoutMs: Number(timeoutMs), ...(quotaBridge ? { quotaBridge } : {}), ...(quotaSource ? { quotaSource } : {}), ...(options.publishQuota === true ? { publishQuota: true } : {}) }
}

export default Plugin.define({
  id: "opencode-qwencloud-oauth",
  effect: ctx => Effect.gen(function* () {
    const options = parseOptions(ctx.options)
    const quotaBridge = yield* acquireQuotaBridge(options.quotaBridge, { workspaceRoot: ctx.location?.directory })
    const storedID = yield* ctx.storage.get("device-client-id:v1")
    const clientID = typeof storedID === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(storedID) ? storedID : randomUUID()
    if (clientID !== storedID) yield* ctx.storage.set("device-client-id:v1", clientID)
    let discovered: { models: AccountModel[]; connection: ActiveConnection } | undefined
    let keyConnection = yield* ctx.integration.connection.active(KEY_INTEGRATION_ID)
    let notify: (data: CatalogNotification) => Effect.Effect<void> = () => Effect.void
    const discovery = createDiscovery(ctx, (models, connection) => Effect.gen(function* () {
      discovered = { models, connection }
      yield* ctx.provider.reload()
    }), data => notify(data), { quotaSource: options.quotaSource })
    const synchronize = Effect.gen(function* () {
      yield* discovery.synchronize
      const next = yield* ctx.integration.connection.active(KEY_INTEGRATION_ID)
      if (JSON.stringify(next) !== JSON.stringify(keyConnection)) {
        keyConnection = next
        yield* ctx.provider.reload()
      }
    })
    const logins = new Set<Login>()
    yield* Effect.addFinalizer(() => Effect.sync(() => { for (const login of logins) login.cancel(); logins.clear() }))
    yield* ctx.provider.transform(editor => {
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID), name: "QwenCloud", activation: "enabled", integrationID: Integration.ID.make(KEY_INTEGRATION_ID),
          package: new URL("./driver.js", import.meta.url).href,
          settings: { baseURL: API_BASE, timeout: options.timeoutMs, qwencloudTimeoutMs: options.timeoutMs, transport: "http" },
        },
        ...(keyConnection?.type === "credential" && keyConnection.method === "key" ? { sourceConnection: keyConnection } : {}),
        models: discovered?.models.map(nativeModel) ?? [],
      })
    })
    const registration = yield* ctx.rpc.register(catalogRPC, {
      refresh: () => discovery.refresh, status: () => discovery.status.pipe(Effect.map(status => ({ ...status, quotaBridge }))), catalog: () => discovery.catalog, quota: () => discovery.quota, managementQuota: () => discovery.managementQuota,
    }).pipe(Effect.orDie)
    notify = data => registration.events.emit("catalogUpdated", { ...data }).pipe(Effect.catch(() => Effect.void))
    yield* ctx.integration.transform(editor => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { id: METHOD_ID, type: "oauth", label: "Sign in to QwenCloud" },
        authorize: () => Effect.gen(function* () {
          const login = yield* Effect.acquireRelease(
            Effect.tryPromise({ try: signal => beginLogin({ clientID, signal }), catch: authorizationStartError }).pipe(Effect.tap(login => Effect.sync(() => { logins.add(login) }))),
            login => Effect.sync(() => { logins.delete(login); login.cancel() }),
          )
          return { mode: "auto" as const, url: login.url, expiresAt: login.expiresAt,
            instructions: "Sign in to load your models and check your quota. To send messages, connect a Token Plan API key separately under QwenCloud API key. Create a key at https://home.qwencloud.com/api-keys; it is shown only once. The key's account is not verified.",
            callback: Effect.tryPromise({ try: () => login.callback, catch: error => error }),
          }
        }),
      })
      editor.update(INTEGRATION_ID, integration => { integration.name = "QwenCloud account" })
      editor.method.update({ integrationID: KEY_INTEGRATION_ID, method: { type: "key", label: "Enter your QwenCloud Token Plan API key" } })
      editor.update(KEY_INTEGRATION_ID, integration => { integration.name = "QwenCloud API key" })
    })
    yield* ctx.session.hook("http.request", event => Effect.gen(function* () {
      yield* discovery.synchronize
      const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection || !discovered || connectionKey(connection) !== connectionKey(discovered.connection) || !discovery.bindings(connection).some(model => model.id === event.model.id)) {
        return yield* Effect.die(new Error("QwenCloud model is not in the active account-bound catalog. Sign in and refresh the catalog."))
      }
    }), { providerID: PROVIDER_ID })
    yield* ctx.session.hook("retry", event => Effect.sync(() => { event.decision = { retry: false } }), { providerID: PROVIDER_ID })
    yield* ctx.event.subscribe({ types: [CATALOG_CHANGED_EVENT, "integration.updated", "credential.updated", "credential.switched"] }).pipe(
      Stream.runForEach(event => discovery.handleEvent(event).pipe(Effect.andThen(synchronize))), Effect.catch(() => Effect.void), Effect.forkScoped,
    )
    yield* synchronize.pipe(Effect.andThen(Effect.sleep("15 seconds")), Effect.forever, Effect.forkScoped)
    if (options.publishQuota) yield* publishQwenCloudQuota(ctx, discovery.quota).pipe(Effect.forkScoped)
  }),
})
