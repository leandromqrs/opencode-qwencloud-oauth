import { boundedJSON, object, type Fetch } from "./oauth.js"
import { sanitizePricing, type PricingMetadata } from "./pricing.js"

export const MANAGEMENT_ORIGIN = "https://cli.qwencloud.com"
export type Modality = "text" | "image" | "video" | "audio"
export interface ListedModel { id: string; context?: number; inputLimit?: number; output?: number; inputModalities?: Modality[]; outputModalities?: Modality[]; pricing?: PricingMetadata }
export interface Catalog { fetchedAt: number; models: ListedModel[] }
export const safeModelID = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)

export class CatalogError extends Error {
  constructor(readonly code: "request_failed" | "invalid_response" | "network_error" | "cancelled", readonly status?: number) { super(`QwenCloud catalog ${code}${status ? ` (${status})` : ""}.`); this.name = "CatalogError" }
  get transient() { return this.code === "network_error" || (this.status !== undefined && this.status >= 500) }
}

export function parseListing(payload: unknown): ListedModel[] {
  const envelope = object(payload)
  if (envelope?.code !== "200") throw new CatalogError("request_failed", ["401", "403"].includes(String(envelope?.code)) ? Number(envelope?.code) : undefined)
  const groups = object(envelope.data)?.Data
  if (!Array.isArray(groups) || groups.length > 2000) throw new CatalogError("invalid_response")
  const models: ListedModel[] = []
  for (const group of groups) {
    const entries = object(group)?.Items
    if (!Array.isArray(entries) || entries.length > 2000) throw new CatalogError("invalid_response")
    for (const entry of entries) {
      const raw = object(entry)
      const info = object(raw?.ModelInfo)
      const inference = object(raw?.InferenceMetadata)
      const pricing = sanitizePricing(raw)
      models.push({ id: raw?.Model as string, ...(limit(info?.ContextWindow) ? { context: Number(info?.ContextWindow) } : {}), ...(limit(info?.MaxInputTokens) ? { inputLimit: Number(info?.MaxInputTokens) } : {}), ...(limit(info?.MaxOutputTokens) ? { output: Number(info?.MaxOutputTokens) } : {}), ...(Array.isArray(inference?.RequestModality) ? { inputModalities: modalities(inference.RequestModality) } : {}), ...(Array.isArray(inference?.ResponseModality) ? { outputModalities: modalities(inference.ResponseModality) } : {}), ...(pricing ? { pricing } : {}) })
      if (models.length > 2000) throw new CatalogError("invalid_response")
    }
  }
  return sanitizeSavedModels(models)
}

const limit = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000
const modalities = (value: unknown[]): Modality[] => [...new Set(value.filter((v): v is string => typeof v === "string").map(v => v.toLowerCase()).filter((v): v is Modality => ["text", "image", "video", "audio"].includes(v)))]

export function sanitizeSavedModels(value: unknown): ListedModel[] {
  if (!Array.isArray(value) || value.length > 2000) throw new CatalogError("invalid_response")
  const models = new Map<string, ListedModel>()
  for (const entry of value) {
    const raw = object(entry)
    if (!raw || !safeModelID(raw.id)) throw new CatalogError("invalid_response")
    const pricing = sanitizePricing(raw.pricing)
    models.set(raw.id, { id: raw.id, ...(limit(raw.context) ? { context: raw.context } : {}), ...(limit(raw.inputLimit) ? { inputLimit: raw.inputLimit } : {}), ...(limit(raw.output) ? { output: raw.output } : {}), ...(Array.isArray(raw.inputModalities) ? { inputModalities: modalities(raw.inputModalities) } : {}), ...(Array.isArray(raw.outputModalities) ? { outputModalities: modalities(raw.outputModalities) } : {}), ...(pricing ? { pricing } : {}) })
  }
  return [...models.values()]
}

export async function discoverCatalog(access: string, fetcher: Fetch = fetch, signal?: AbortSignal): Promise<Catalog> {
  const bounded = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
  try {
    bounded.throwIfAborted()
    if (!access || /\s/.test(access)) throw new CatalogError("invalid_response")
    const response = await fetcher(`${MANAGEMENT_ORIGIN}/data/v2/api.json`, { method: "POST", redirect: "error", signal: bounded, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${access}` }, body: JSON.stringify({ product: "AliyunDeliveryService", action: "ListModelSeries", region: "ap-southeast-1", params: { Language: "en-US" } }) })
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
