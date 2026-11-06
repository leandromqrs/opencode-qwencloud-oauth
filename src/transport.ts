export const API_BASE = "https://api.qwen.ai/compatible-mode/v1"
export const HOST_TRANSPORT_BLOCKER = "Qwen Code inference is blocked: OpenCode 2.2.5 HTTP hooks lose Request.redirect and Request.signal. A verified host correction is required before credential-bearing inference can be enabled."

export function assertHostTransportSafe(): never { throw new Error(HOST_TRANSPORT_BLOCKER) }

export async function prepareRequest(request: Request, access: string, allowedModels: readonly string[], timeoutMs = 120_000): Promise<Request> {
  if (request.url !== `${API_BASE}/chat/completions` || request.method !== "POST") throw new Error("Unsupported Qwen inference destination.")
  request.signal.throwIfAborted()
  if (!access || /\s/.test(access)) throw new Error("Invalid Qwen access credential.")
  const text = await request.text()
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Qwen request too large.")
  let body: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    body = value as Record<string, unknown>
  } catch { throw new Error("Invalid Qwen request body.") }
  if (typeof body.model !== "string" || !allowedModels.includes(body.model)) throw new Error("Qwen model is not in the active account catalog.")
  if (body.model === "qwen3.8-max" || body.model === "qwen3.8-flash") {
    delete body.reasoning
    delete body.reasoning_effort
    const template = body.chat_template_kwargs
    if (template && typeof template === "object" && !Array.isArray(template)) {
      const { enable_thinking: _thinking, ...rest } = template as Record<string, unknown>
      if (Object.keys(rest).length) body.chat_template_kwargs = rest
      else delete body.chat_template_kwargs
    }
    if (body.enable_thinking === false) delete body.thinking_budget
  }
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${access}` })
  return new Request(`${API_BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) })
}
