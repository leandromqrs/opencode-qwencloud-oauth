export const API_BASE = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
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
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` })
  return new Request(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: signal ?? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) })
}
