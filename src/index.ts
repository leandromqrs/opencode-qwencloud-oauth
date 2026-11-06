import { Integration, Plugin, Provider } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { authorizationStartError, beginLogin, METHOD_ID, requireReauthentication, type Login } from "./oauth.js"
import { randomUUID } from "node:crypto"
import { CATALOG_CHANGED_EVENT, catalogRPC, createDiscovery, type ActiveConnection, type CatalogNotification } from "./discovery.js"
import { nativeModel, type AccountModel } from "./inventory.js"
import { API_BASE, assertHostTransportSafe } from "./transport.js"

export const PROVIDER_ID = Provider.ID.make("qwencloud")
export const INTEGRATION_ID = Integration.ID.make("qwencloud-oauth")
export { catalogRPC } from "./discovery.js"

export function parseOptions(options: Record<string, unknown>): { timeoutMs: number } {
  if (Object.keys(options).some(key => key !== "timeoutMs")) throw new Error("QwenCloud accepts only timeoutMs; gateway overrides, fabricated models and unsafe inference bypasses are unsupported.")
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 600_000) throw new Error("Qwen timeoutMs must be between 1000 and 600000.")
  return { timeoutMs: Number(timeoutMs) }
}

export default Plugin.define({
  id: "opencode-qwencloud-oauth",
  effect: ctx => Effect.gen(function* () {
    const options = parseOptions(ctx.options)
    const storedID = yield* ctx.storage.get("device-client-id:v1")
    const clientID = typeof storedID === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(storedID) ? storedID : randomUUID()
    if (clientID !== storedID) yield* ctx.storage.set("device-client-id:v1", clientID)
    let discovered: { models: AccountModel[]; connection: ActiveConnection } | undefined
    let notify: (data: CatalogNotification) => Effect.Effect<void> = () => Effect.void
    const discovery = createDiscovery(ctx, (models, connection) => Effect.gen(function* () {
      discovered = { models, connection }
      yield* ctx.provider.reload()
    }), data => notify(data))
    const logins = new Set<Login>()
    yield* Effect.addFinalizer(() => Effect.sync(() => { for (const login of logins) login.cancel(); logins.clear() }))
    yield* ctx.provider.transform(editor => {
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID), name: "QwenCloud", activation: "enabled", integrationID: INTEGRATION_ID,
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: API_BASE, apiKey: "qwencloud-inference-blocked", timeout: options.timeoutMs, transport: "http" },
        },
        ...(discovered ? { sourceConnection: discovered.connection } : {}),
        models: discovered?.models.map(nativeModel) ?? [],
      })
    })
    const registration = yield* ctx.rpc.register(catalogRPC, {
      refresh: () => discovery.refresh, status: () => discovery.status, catalog: () => discovery.catalog, quota: () => discovery.quota,
    }).pipe(Effect.orDie)
    notify = data => registration.events.emit("catalogUpdated", { ...data }).pipe(Effect.catch(() => Effect.void))
    yield* ctx.integration.transform(editor => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { id: METHOD_ID, type: "oauth", label: "Sign in with QwenCloud" },
        authorize: () => Effect.gen(function* () {
          const login = yield* Effect.acquireRelease(
            Effect.tryPromise({ try: signal => beginLogin({ clientID, signal }), catch: authorizationStartError }).pipe(Effect.tap(login => Effect.sync(() => { logins.add(login) }))),
            login => Effect.sync(() => { logins.delete(login); login.cancel() }),
          )
          return { mode: "auto" as const, url: login.url, expiresAt: login.expiresAt,
            instructions: "Authorize QwenCloud management access in the browser. No model request or key reset is made. The official CLI requires a separate inference API key; automatic key provisioning is not established. Inference remains blocked pending a verified host transport correction.",
            callback: Effect.tryPromise({ try: () => login.callback, catch: error => error }),
          }
        }),
        refresh: () => Effect.tryPromise({ try: requireReauthentication, catch: error => error }),
      })
      editor.update(INTEGRATION_ID, integration => { integration.name = "QwenCloud" })
    })
    yield* ctx.session.hook("http.request", () => Effect.sync(assertHostTransportSafe), { providerID: PROVIDER_ID })
    yield* ctx.session.hook("retry", event => Effect.sync(() => { event.decision = { retry: false } }), { providerID: PROVIDER_ID })
    yield* ctx.event.subscribe({ types: [CATALOG_CHANGED_EVENT, "integration.updated", "credential.updated", "credential.switched"] }).pipe(
      Stream.runForEach(event => discovery.handleEvent(event)), Effect.catch(() => Effect.void), Effect.forkScoped,
    )
    yield* discovery.synchronize.pipe(Effect.andThen(Effect.sleep("15 seconds")), Effect.forever, Effect.forkScoped)
  }),
})
