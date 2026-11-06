export const API_BASE = "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1"
export const HOST_TRANSPORT_BLOCKER = "QwenCloud inference is blocked: OpenCode 2.2.5 HTTP hooks lose Request.redirect and Request.signal. A verified host correction is required before credential-bearing inference can be enabled. Management OAuth tokens are not inference API keys; no PAYG fallback is allowed."

export function assertHostTransportSafe(): never { throw new Error(HOST_TRANSPORT_BLOCKER) }

export type InferenceRouting = { plan: "token-plan" } | { plan: "payg"; region: "ap-southeast-1" }

export function inferenceBase(routing: InferenceRouting): string {
  if (routing.plan === "token-plan") return API_BASE
  if (routing.plan !== "payg" || routing.region !== "ap-southeast-1") throw new Error("Explicit supported QwenCloud plan and region required.")
  return `https://${routing.region}.maas.qwencloudapi.com/compatible-mode/v1`
}

export async function prepareRequest(request: Request, apiKey: string, allowedModels: readonly string[], routing: InferenceRouting, timeoutMs = 120_000): Promise<Request> {
  const base = inferenceBase(routing)
  if (request.url !== `${base}/chat/completions` || request.method !== "POST") throw new Error("Unsupported QwenCloud inference destination.")
  request.signal.throwIfAborted()
  const tokenPlan = apiKey.startsWith("sk-sp-")
  if (!/^sk-[A-Za-z0-9_-]+$/.test(apiKey) || tokenPlan !== (routing.plan === "token-plan")) throw new Error("QwenCloud requires a plan-specific inference API key, never a management token.")
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
  return new Request(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) })
}
