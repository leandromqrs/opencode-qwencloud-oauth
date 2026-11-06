import { Model, Provider } from "@opencode/plugin/effect"
import type { Catalog } from "./catalog.js"
import { API_BASE } from "./transport.js"

export const METADATA_SOURCE = "https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/models/generated/model-registry.json"
export const EFFORT_SOURCE = "https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/core/openaiContentGenerator/pipeline.ts#L1631-L1664"
export const MODALITY_SOURCE = "https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/qwen/subscription-models.ts#L30-L33"
export type Effort = "off" | "low" | "medium" | "high"
export const knownModel = (id: string) => id === "qwen3.8-max" || id === "qwen3.8-flash"
export interface AccountModel { id: string; context: number | null; output: number | null; efforts: Effort[]; metadata: "official-embedded" | "unknown" }

export function effortBody(effort: Effort): Record<string, unknown> {
  return effort === "off" ? { enable_thinking: false } : { enable_thinking: true, thinking_budget: { low: 4096, medium: 16384, high: 32768 }[effort] }
}

export function reconcileCatalog(catalog: Catalog): AccountModel[] {
  return catalog.models.map(({ id }) => knownModel(id)
    ? { id, context: 1_000_000, output: 131072, efforts: ["off", "low", "medium", "high"], metadata: "official-embedded" }
    : { id, context: null, output: null, efforts: [], metadata: "unknown" })
}

export function nativeModel(model: AccountModel): Model.Info {
  const provider = Provider.ID.make("qwen-code")
  return {
    ...Model.Info.default(provider, Model.ID.make(model.id)),
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: API_BASE },
    capabilities: { tools: knownModel(model.id), input: knownModel(model.id) ? ["text", "image", "video"] : ["text"], output: ["text"] },
    limit: { context: model.context ?? 0, output: model.output ?? 0 }, cost: [],
    variants: model.efforts.map(effort => ({ id: Model.VariantID.make(effort), body: effortBody(effort) })),
  }
}
