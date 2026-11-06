import { Model, Provider } from "@opencode/plugin/effect"
import type { Catalog, Modality } from "./catalog.js"
import { API_BASE } from "./transport.js"

export const METADATA_SOURCE = "https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/types/api-models.ts"
export interface AccountModel { id: string; context: number | null; inputLimit: number | null; output: number | null; inputModalities: Modality[] | null; outputModalities: Modality[] | null; efforts: never[]; metadata: "management-catalog" }

export function reconcileCatalog(catalog: Catalog): AccountModel[] {
  return catalog.models.map(model => ({ id: model.id, context: model.context ?? null, inputLimit: model.inputLimit ?? null, output: model.output ?? null, inputModalities: model.inputModalities ?? null, outputModalities: model.outputModalities ?? null, efforts: [], metadata: "management-catalog" }))
}

export function nativeModel(model: AccountModel): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make("qwencloud"), Model.ID.make(model.id)),
    package: new URL("./driver.js", import.meta.url).href,
    settings: { baseURL: API_BASE },
    capabilities: { tools: false, input: model.inputModalities ?? [], output: model.outputModalities ?? [] },
    limit: { context: model.context ?? 0, output: model.output ?? 0 }, cost: [], variants: [],
  }
}
