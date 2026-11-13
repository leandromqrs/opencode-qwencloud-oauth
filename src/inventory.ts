import { Model, Provider } from "@opencode/plugin/effect"
import type { Catalog, Modality } from "./catalog.js"
import { API_BASE } from "./transport.js"
import { nativeCosts, type PricingMetadata } from "./pricing.js"

export const METADATA_SOURCE = "https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/types/api-models.ts"
export interface AccountModel { id: string; context: number | null; inputLimit: number | null; output: number | null; inputModalities: Modality[] | null; outputModalities: Modality[] | null; pricing?: PricingMetadata; efforts: never[]; metadata: "management-catalog" }

export function reconcileCatalog(catalog: Catalog): AccountModel[] {
  return catalog.models.map(model => ({ id: model.id, context: model.context ?? null, inputLimit: model.inputLimit ?? null, output: model.output ?? null, inputModalities: model.inputModalities ?? null, outputModalities: model.outputModalities ?? null, ...(model.pricing ? { pricing: model.pricing } : {}), efforts: [], metadata: "management-catalog" }))
}

const qwenNameParts = new Map(Object.entries({
  max: "Max", flash: "Flash", omni: "Omni", realtime: "Realtime", livetranslate: "LiveTranslate",
  plus: "Plus", pro: "Pro", preview: "Preview", latest: "Latest", turbo: "Turbo", lite: "Lite", character: "Character", ja: "JA",
  audio: "Audio", image: "Image", asr: "ASR", tts: "TTS", vl: "VL", ocr: "OCR", mt: "MT",
  filetrans: "FileTrans", streaming: "Streaming", message: "Message", next: "Next",
  voice: "Voice", enrollment: "Enrollment", text: "Text", embedding: "Embedding", rerank: "Rerank", coder: "Coder",
}))
const glmNameParts = new Map(Object.entries({ fast: "Fast", preview: "Preview", prime: "Prime" }))
const kimiNameParts = new Map(Object.entries({ pro: "Pro", code: "Code" }))
const videoTasks = { t2v: "T2V", i2v: "I2V", r2v: "R2V", kf2v: "KF2V" }
const modelNameFamilies: { pattern: RegExp; prefix: string; parts: ReadonlyMap<string, string>; numeric?: RegExp }[] = [
  { pattern: /^qwen(\d+(?:\.\d+)?)?(?:-|$)/, prefix: "Qwen", parts: qwenNameParts, numeric: /^(?:\d+\.\d+|a?\d+(?:\.\d+)?[bt]|\d{4})$/ },
  { pattern: /^deepseek-v(\d+(?:\.\d+)?)(?:-|$)/, prefix: "DeepSeek V", parts: new Map(Object.entries({ flash: "Flash", pro: "Pro" })), numeric: /^\d{4}$/ },
  { pattern: /^glm-(\d+(?:\.\d+)?)(?:-|$)/, prefix: "GLM-", parts: glmNameParts },
  { pattern: /^ZHIPU\/GLM-(\d+(?:\.\d+)?)(?:-|$)/, prefix: "Zhipu / GLM-", parts: glmNameParts },
  { pattern: /^kimi-k(\d+(?:\.\d+)?)(?:-|$)/, prefix: "Kimi K", parts: kimiNameParts },
  { pattern: /^kimi\/kimi-k(\d+(?:\.\d+)?)(?:-|$)/, prefix: "Kimi / Kimi K", parts: kimiNameParts },
  { pattern: /^wan(\d+(?:\.\d+)?)(?:-|$)/, prefix: "Wan", parts: new Map(Object.entries({
    ...videoTasks, t2i: "T2I", i2i: "I2I", vace: "VACE", video: "Video", image: "Image", videoedit: "VideoEdit",
    prime: "Prime", pro: "Pro", flash: "Flash", preview: "Preview", plus: "Plus", turbo: "Turbo", animate: "Animate", move: "Move", mix: "Mix",
  })) },
  { pattern: /^fun-asr(?:-|$)/, prefix: "FunASR", parts: new Map(Object.entries({ realtime: "Realtime", flash: "Flash" })) },
  { pattern: /^cosyvoice-v(\d+(?:\.\d+)?)(?:-|$)/, prefix: "CosyVoice V", parts: new Map(Object.entries({ plus: "Plus", flash: "Flash" })) },
  { pattern: /^z-image(?:-|$)/, prefix: "Z-Image", parts: new Map(Object.entries({ turbo: "Turbo" })) },
  { pattern: /^tongyi-embedding(?:-|$)/, prefix: "Tongyi Embedding", parts: new Map(Object.entries({ vision: "Vision", plus: "Plus", flash: "Flash" })) },
  { pattern: /^text-embedding-v(\d+(?:\.\d+)?)(?:-|$)/, prefix: "Text Embedding V", parts: new Map() },
  { pattern: /^happyhorse-(\d+(?:\.\d+)?)(?:-|$)/, prefix: "HappyHorse ", parts: new Map(Object.entries({ ...videoTasks, video: "Video", edit: "Edit" })) },
  { pattern: /^happyoyster-(\d+(?:\.\d+)?)(?:-|$)/, prefix: "HappyOyster ", parts: new Map(Object.entries({ adventure: "Adventure", directing: "Directing" })) },
  { pattern: /^pixverse\/pixverse-v(\d+(?:\.\d+)?)(?:-|$)/, prefix: "PixVerse / PixVerse V", parts: new Map(Object.entries({ ...videoTasks, it2v: "IT2V" })) },
  { pattern: /^vidu\/viduq(\d+)(?:-|$)/, prefix: "Vidu / Vidu Q", parts: new Map(Object.entries({
    pro: "Pro", fast_img2video: "Fast Image to Video", mix_reference2video: "Mix Reference to Video",
    drama_reference2video: "Drama Reference to Video", ad_reference2video: "Ad Reference to Video",
  })) },
  { pattern: /^vidu\/vidu(?:-|$)/, prefix: "Vidu / Vidu", parts: new Map(Object.entries({ image_reference2image: "Image Reference to Image" })) },
  { pattern: /^decision-model(?:-|$)/, prefix: "Decision Model", parts: new Map(Object.entries({ preview: "Preview" })) },
  { pattern: /^voice-enrollment$/, prefix: "Voice Enrollment", parts: new Map() },
]

function modelDisplayName(id: string): string {
  if (id.endsWith("-")) return id
  for (const family of modelNameFamilies) {
    const match = family.pattern.exec(id)
    if (!match) continue
    const suffix = id.slice(match[0].length)
    const date = /(?:^|-)(\d{4}-\d{2}-\d{2})$/.exec(suffix)
    const body = date ? suffix.slice(0, date.index) : suffix
    const parts = body ? body.split("-").map(part => family.parts.get(part) ?? (family.numeric?.test(part) ? part.toUpperCase() : undefined)) : []
    if (parts.some(part => part === undefined)) return id
    return [`${family.prefix}${match[1] ?? ""}`, ...parts, ...(date ? [date[1]] : [])].join(" ")
  }
  return id
}

export function nativeModel(model: AccountModel): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make("qwencloud"), Model.ID.make(model.id)),
    name: modelDisplayName(model.id),
    package: new URL("./driver.js", import.meta.url).href,
    settings: { baseURL: API_BASE },
    capabilities: { tools: false, input: model.inputModalities ?? [], output: model.outputModalities ?? [] },
    limit: { context: model.context ?? 0, output: model.output ?? 0 }, cost: nativeCosts(model.pricing, model.context), variants: [],
  }
}
