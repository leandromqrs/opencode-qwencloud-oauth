import { boundedJSON, object, type Fetch } from "./oauth.js"
import { API_BASE } from "./transport.js"

export interface ListedModel { id: string }
export interface Catalog { fetchedAt: number; models: ListedModel[] }
export const safeModelID = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)

export class CatalogError extends Error {
  constructor(readonly code: "request_failed" | "invalid_response" | "network_error" | "cancelled", readonly status?: number) { super(`Qwen catalog ${code}${status ? ` (${status})` : ""}.`); this.name = "CatalogError" }
  get transient() { return this.code === "network_error" || (this.status !== undefined && this.status >= 500) }
}

export function parseListing(payload: unknown): ListedModel[] {
  const entries = object(payload)?.data
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 2000) throw new CatalogError("invalid_response")
  const ids = new Set<string>()
  for (const entry of entries) {
    const value = object(entry)?.id
    const id = typeof value === "string" ? value.trim() : undefined
    if (!safeModelID(id)) throw new CatalogError("invalid_response")
    ids.add(id)
  }
  return [...ids].map(id => ({ id }))
}

export async function discoverCatalog(access: string, fetcher: Fetch = fetch, signal?: AbortSignal): Promise<Catalog> {
  const bounded = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
  try {
    bounded.throwIfAborted()
    const response = await fetcher(`${API_BASE}/models`, { method: "GET", redirect: "error", signal: bounded, headers: { Accept: "application/json", Authorization: `Bearer ${access}` } })
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new CatalogError("request_failed", response.status) }
    let data: unknown
    try { data = await boundedJSON(response, bounded) } catch { bounded.throwIfAborted(); throw new CatalogError("invalid_response") }
    return { fetchedAt: Date.now(), models: parseListing(data) }
  } catch (error) {
    if (signal?.aborted) throw new CatalogError("cancelled")
    if (error instanceof CatalogError) throw error
    throw new CatalogError("network_error")
  }
}
