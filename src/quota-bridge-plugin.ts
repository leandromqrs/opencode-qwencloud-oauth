import { Effect, type Scope } from "effect"
import { readAlibabaConsoleQuota, type QuotaCliRunner } from "./quota-cli.js"
import { startQuotaBridge } from "./quota-bridge.js"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { prepareQuotaBridgeState } from "./quota-bridge-storage.js"
import { startSharedQuotaBridge } from "./quota-bridge-shared.js"
import { quotaBridgeRegistry, serializeQuotaBridge, type QuotaBridgeLease, type SharedQuotaBridge } from "./quota-bridge-state.js"

export interface QuotaBridgeConfig { port: number; apiKeyEnv: string; autoKey?: boolean; shared?: boolean }
export interface QuotaBridgeStatus {
  enabled: boolean
  management: "plugin"
  running: boolean
  url?: string
  diagnostic?: "missing-key" | "invalid-key" | "start-failed" | "incompatible-config"
}

export function parseQuotaBridge(value: unknown): QuotaBridgeConfig | undefined {
  if (value === undefined || value === false) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["port", "apiKeyEnv", "autoKey", "shared"].includes(key))) throw new Error("QwenCloud quotaBridge accepts only port, apiKeyEnv, autoKey and shared.")
  const { port, apiKeyEnv = "QWENCLOUD_QUOTA_ADAPTER_KEY" } = value as Record<string, unknown>
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535 || typeof apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new Error("QwenCloud quotaBridge requires port 1–65535 and a valid apiKeyEnv name.")
  const { autoKey, shared } = value as Record<string, unknown>
  if (autoKey !== undefined && typeof autoKey !== "boolean") throw new Error("QwenCloud quotaBridge autoKey must be boolean.")
  if (shared !== undefined && typeof shared !== "boolean" || shared === true && autoKey !== true) throw new Error("Shared quota bridge requires autoKey.")
  return { port: Number(port), apiKeyEnv, ...(autoKey !== undefined ? { autoKey } : {}), ...(shared !== undefined ? { shared } : {}) }
}

export function acquireQuotaBridge(config?: QuotaBridgeConfig, dependencies: { workspaceRoot?: string; runner?: QuotaCliRunner; stateDirectory?: string } = {}): Effect.Effect<QuotaBridgeStatus, never, Scope.Scope> {
  const status: QuotaBridgeStatus = { enabled: !!config, management: "plugin", running: false }
  if (!config) return Effect.succeed(status)
  return Effect.acquireRelease(
    Effect.promise(async () => {
      try {
        const registry = quotaBridgeRegistry()
        return await serializeQuotaBridge(registry, async () => {
          const id = Symbol()
          const roots = [resolve(process.cwd()) !== resolve(homedir()) ? process.cwd() : undefined, dependencies.workspaceRoot].filter((root): root is string => !!root)
          const existing = registry.entry
          if (existing) {
            if (existing.port !== config.port || existing.apiKeyEnv !== config.apiKeyEnv || existing.autoKey !== !!config.autoKey || !!existing.shared !== !!config.shared || dependencies.stateDirectory !== undefined && resolve(dependencies.stateDirectory) !== existing.stateDirectory || process.env[config.apiKeyEnv] !== existing.token) return { status: { ...status, diagnostic: "incompatible-config" as const } }
            if (config.shared) await prepareQuotaBridgeState({ stateDirectory: existing.stateDirectory, workspaceRoots: roots, token: existing.token })
            existing.leases.set(id, dependencies)
            Object.assign(status, { running: true, url: existing.bridge.url })
            existing.statuses?.add(status)
            return { status, registry, entry: existing, id }
          }
          const previous = process.env[config.apiKeyEnv]
          if (previous === undefined && !config.autoKey) return { status: { ...status, diagnostic: "missing-key" as const } }
          if (previous !== undefined && !/^[\x21-\x7e]{32,512}$/.test(previous)) return { status: { ...status, diagnostic: "invalid-key" as const } }
          if (config.shared && !config.autoKey) return { status: { ...status, diagnostic: "incompatible-config" as const } }
          const sharedState = config.shared ? await prepareQuotaBridgeState({ stateDirectory: dependencies.stateDirectory, workspaceRoots: roots, token: previous }) : undefined
          const token = sharedState?.token ?? previous ?? randomBytes(32).toString("hex")
          const owned = previous === undefined
          const leases = new Map<symbol, QuotaBridgeLease>([[id, dependencies]])
          const statuses = new Set([status])
          registry.pendingEnvName = config.apiKeyEnv
          if (owned && !config.shared) process.env[config.apiKeyEnv] = token
          try {
            const bridge = await (config.shared ? startSharedQuotaBridge : startQuotaBridge)({ port: config.port, token, onAvailability: (available: boolean) => {
              if (owned) {
                if (!available && process.env[config.apiKeyEnv] === token) delete process.env[config.apiKeyEnv]
                if (available && process.env[config.apiKeyEnv] === undefined) process.env[config.apiKeyEnv] = token
              }
              for (const current of statuses) current.running = available && process.env[config.apiKeyEnv] === token
            }, getQuota: signal => {
              const live = leases.values().next().value
              if (!live) return Promise.reject(new Error("Quota bridge unavailable."))
              return readAlibabaConsoleQuota({ ...live, workspaceRoots: [...leases.values()].flatMap(lease => lease.workspaceRoot ? [lease.workspaceRoot] : []), omitEnvKeys: [config.apiKeyEnv] }, signal)
            } })
            if (owned) process.env[config.apiKeyEnv] = token
            const entry: SharedQuotaBridge = { port: config.port, apiKeyEnv: config.apiKeyEnv, autoKey: !!config.autoKey, shared: !!config.shared, stateDirectory: sharedState?.directory, token, owned, bridge, leases, statuses }
            registry.entry = entry
            Object.assign(status, { running: true, url: bridge.url })
            return { status, registry, entry, id }
          } catch {
            if (owned && process.env[config.apiKeyEnv] === token) delete process.env[config.apiKeyEnv]
            return { status: { ...status, diagnostic: "start-failed" as const } }
          } finally { delete registry.pendingEnvName }
        })
      } catch { return { status: { ...status, diagnostic: "start-failed" as const } } }
    }),
    acquired => Effect.promise(async () => {
      if (!("registry" in acquired) || !acquired.registry || !acquired.entry || !acquired.id) return
      const { registry, entry, id } = acquired
      await serializeQuotaBridge(registry, async () => {
        if (registry.entry !== entry) return
        entry.leases.delete(id)
        entry.statuses?.delete(acquired.status)
        if (entry.leases.size) return
        await entry.bridge.close()
        if (entry.owned && process.env[entry.apiKeyEnv] === entry.token) delete process.env[entry.apiKeyEnv]
        delete registry.entry
      })
    }),
  ).pipe(Effect.map(acquired => acquired.status))
}
