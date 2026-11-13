import type { QuotaCliRunner } from "./quota-cli.js"
import type { QuotaBridge } from "./quota-bridge.js"

const registryKey = Symbol.for("opencode-qwencloud-oauth.quota-bridge.v1")
const globals = globalThis as typeof globalThis & { [key: symbol]: unknown }

export interface QuotaBridgeLease { workspaceRoot?: string; runner?: QuotaCliRunner }
export interface SharedQuotaBridge {
  port: number
  apiKeyEnv: string
  autoKey: boolean
  shared?: boolean
  stateDirectory?: string
  statuses?: Set<{ running: boolean }>
  token: string
  owned: boolean
  bridge: QuotaBridge
  leases: Map<symbol, QuotaBridgeLease>
}
export interface QuotaBridgeRegistry {
  version: 1
  queue: Promise<void>
  pendingEnvName?: string
  entry?: SharedQuotaBridge
}

export function quotaBridgeRegistry(): QuotaBridgeRegistry {
  const existing = globals[registryKey] as Partial<QuotaBridgeRegistry> | undefined
  if (existing) {
    if (existing.version !== 1 || !existing.queue || typeof existing.queue.then !== "function") throw new Error("Quota bridge registry unavailable.")
    return existing as QuotaBridgeRegistry
  }
  const created: QuotaBridgeRegistry = { version: 1, queue: Promise.resolve() }
  globals[registryKey] = created
  return created
}

export function quotaBridgeEnvironmentNames(): string[] {
  const current = globals[registryKey] as Partial<QuotaBridgeRegistry> | undefined
  if (current?.version !== 1) return []
  return [current.entry?.apiKeyEnv, current.pendingEnvName].filter((name): name is string => typeof name === "string")
}

export function quotaBridgeWorkspaceRoots(): string[] {
  const current = globals[registryKey] as Partial<QuotaBridgeRegistry> | undefined
  if (current?.version !== 1 || !current.entry) return []
  return [...current.entry.leases.values()].flatMap(lease => lease.workspaceRoot ? [lease.workspaceRoot] : [])
}

export function quotaBridgeStateDirectory(): string | undefined {
  return quotaBridgeRegistry().entry?.stateDirectory
}

export function serializeQuotaBridge<T>(registry: QuotaBridgeRegistry, operation: () => Promise<T>): Promise<T> {
  const pending = registry.queue.then(operation)
  registry.queue = pending.then(() => {}, () => {})
  return pending
}
