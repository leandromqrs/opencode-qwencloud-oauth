export const API_BASE = "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1"
export const KEY_INTEGRATION_ID = "qwencloud-api-key"
export const DEFAULT_TIMEOUT_MS = 600_000

export function isInferenceKey(value: unknown): value is string {
  return typeof value === "string" && /^sk-[\x21-\x7e]{1,32765}$/.test(value)
}

export type InferenceRouting = { plan: "token-plan" } | { plan: "payg"; region: "ap-southeast-1" }

export function inferenceBase(routing: InferenceRouting): string {
  if (routing.plan === "token-plan") return API_BASE
  if (routing.plan !== "payg" || routing.region !== "ap-southeast-1") throw new Error("Explicit supported QwenCloud plan and region required.")
  return "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
}

type ImageSize = { width: number; height: number }

const view = (bytes: Buffer): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function pngSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function gifSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 10 || (bytes.toString("ascii", 0, 6) !== "GIF87a" && bytes.toString("ascii", 0, 6) !== "GIF89a")) return undefined
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

function bmpSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 26 || bytes.toString("ascii", 0, 2) !== "BM") return undefined
  return { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) }
}

function webpSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return undefined
  const format = bytes.toString("ascii", 12, 16)
  if (format === "VP8X" && bytes.length >= 30) return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) }
  if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = view(bytes).getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (format === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const data = view(bytes)
    return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff }
  }
  return undefined
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const data = view(bytes)
  let offset = 2
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    if (marker === 0xda || marker === 0xd9 || offset + 4 > bytes.length) return undefined
    const length = data.getUint16(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return undefined
      return { width: data.getUint16(offset + 7), height: data.getUint16(offset + 5) }
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

function imageSize(mime: string, bytes: Buffer): ImageSize | undefined {
  if (mime === "image/png") return pngSize(bytes)
  if (mime === "image/gif") return gifSize(bytes)
  if (mime === "image/bmp" || mime === "image/x-ms-bmp") return bmpSize(bytes)
  if (mime === "image/webp") return webpSize(bytes)
  if (mime === "image/jpeg" || mime === "image/jpg") return jpegSize(bytes)
  return undefined
}

// DashScope rejects the entire request when any inline image has a side of 10px
// or less, and tool exports do produce 1x1 placeholders. Only the header window
// is decoded; formats or payloads that cannot be measured pass through untouched.
const HEADER_WINDOW = 262_144

function screenInlineImages(body: Record<string, unknown>): void {
  if (!Array.isArray(body.messages)) return
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue
    const content = (message as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (let index = 0; index < content.length; index += 1) {
      const part = content[index]
      if (!part || typeof part !== "object" || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      if (record.type !== "image_url" || !record.image_url || typeof record.image_url !== "object") continue
      const url = (record.image_url as Record<string, unknown>).url
      if (typeof url !== "string") continue
      const match = /^data:([^;,]+);base64,/u.exec(url)
      if (!match) continue
      const mime = match[1]!.toLowerCase()
      const bytes = Buffer.from(url.slice(match[0].length, match[0].length + HEADER_WINDOW), "base64")
      const size = imageSize(mime, bytes)
      if (!size || (size.width > 10 && size.height > 10)) continue
      content[index] = { type: "text", text: `[Image omitted: ${size.width}x${size.height} ${mime} is below the QwenCloud minimum of 11x11 pixels.]` }
    }
  }
}

// DashScope only understands function tools: a message carrying a "custom" (freeform) tool call fails
// validation with "tool_calls.N.function Field required". Replay such calls as function calls so history
// stays valid, and drop the custom declarations it cannot represent.
function downgradeCustomTools(body: Record<string, unknown>): void {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue
      message.tool_calls = message.tool_calls.map((call: unknown) => {
        if (!isRecord(call) || call.type !== "custom" || !isRecord(call.custom)) return call
        const { type: _type, custom, ...rest } = call
        const { name, input } = custom as Record<string, unknown>
        return { ...rest, type: "function", function: { name, arguments: JSON.stringify({ input: typeof input === "string" ? input : "" }) } }
      })
    }
  }
  if (Array.isArray(body.tools)) {
    const declared = body.tools.length
    const kept = body.tools.filter((tool: unknown) => !isRecord(tool) || tool.type !== "custom")
    body.tools = kept
    if (kept.length === 0 && declared > 0) {
      delete body.tools
      delete body.tool_choice
      delete body.parallel_tool_calls
    }
  }
  if (isRecord(body.tool_choice) && body.tool_choice.type === "custom") body.tool_choice = "auto"
}

export async function prepareRequest(request: Request, apiKey: string, allowedModels: readonly string[], routing: InferenceRouting, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<Request> {
  const base = inferenceBase(routing)
  if (request.url !== `${base}/chat/completions` || request.method !== "POST") throw new Error("Unsupported QwenCloud inference destination.")
  request.signal.throwIfAborted()
  signal?.throwIfAborted()
  const tokenPlan = apiKey.startsWith("sk-sp-")
  if (!isInferenceKey(apiKey) || tokenPlan !== (routing.plan === "token-plan")) throw new Error("QwenCloud requires a plan-specific inference API key, never a management token. Create a separate API key at https://home.qwencloud.com/api-keys (shown once).")
  const text = await request.text()
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("QwenCloud request too large.")
  let body: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    body = value as Record<string, unknown>
  } catch { throw new Error("Invalid QwenCloud request body.") }
  if (typeof body.model !== "string" || !allowedModels.includes(body.model)) throw new Error("QwenCloud model is not in the active catalog.")
  if (body.model === "auto" && (Object.hasOwn(body, "tool_choice") || Object.hasOwn(body, "thinking_budget"))) throw new Error("QwenCloud auto does not support tool_choice or thinking_budget.")
  screenInlineImages(body)
  downgradeCustomTools(body)
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` })
  return new Request(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: signal ?? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) })
}
