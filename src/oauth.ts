import { Credential, Integration } from "@opencode/plugin"
import { setTimeout as delay } from "node:timers/promises"

export const AUTH_ORIGIN = "https://auth.qwen.ai"
export const CLIENT_ID = "qwen-code-cli"
export const SCOPE = "model:invoke profile:read"
export const METHOD_ID = Integration.MethodID.make("device")
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type Membership = "plus" | "pro" | "lite" | "free" | "unknown"
export const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const secret = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768 && !/\s/.test(value)
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value * 1000 <= 2_147_483_647

export class OAuthError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly retryAfterMs?: number) { super(`Qwen OAuth ${code}.`); this.name = "OAuthError" }
}

export function authorizationStartError(error: unknown): Error {
  const guidance: Record<string, string> = {
    invalid_verification_url: "Qwen returned an incompatible browser authorization URL; the plugin rejected it for safety. Verify the current official authorization contract before retrying.",
    invalid_response: "Qwen returned an incompatible device authorization response. Check plugin/server compatibility.",
    invalid_client: "Qwen rejected the fixed public OAuth client. Check current service availability and client compatibility.",
    invalid_request: "Qwen rejected the device authorization request. Check plugin/server compatibility.",
    access_denied: "Qwen denied device authorization. Check account/service access before retrying.",
    request_failed: "Qwen rejected device authorization. Check service availability or request restrictions before retrying.",
    network_error: "Check connectivity to auth.qwen.ai before retrying.",
    request_timeout: "The Qwen authorization request timed out. Check connectivity before retrying.",
    cancelled: "Device authorization was cancelled.",
    expired_token: "The device authorization grant expired. Start sign-in again.",
  }
  if (!(error instanceof OAuthError) || !Object.hasOwn(guidance, error.code)) return new Error("Qwen device authorization could not start; retry later.")
  const status = Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? ` (HTTP ${error.status})` : ""
  return new Error(`Qwen device authorization ${error.code}${status}. ${guidance[error.code]}`)
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const numeric = Number(value)
  const ms = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined
}

export async function boundedJSON(response: Response, signal: AbortSignal, maxBytes = 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new Error("Empty response.")
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error("Response exceeds size limit.")
      chunks.push(value)
    }
    signal.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function request(path: "device/code" | "token" | "userinfo", fetcher: Fetch, signal?: AbortSignal, form?: URLSearchParams, access?: string): Promise<Record<string, unknown>> {
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  try {
    bounded.throwIfAborted()
    const response = await fetcher(`${AUTH_ORIGIN}/api/oauth/${path}`, {
      method: form ? "POST" : "GET", redirect: "error", signal: bounded,
      headers: { Accept: "application/json", ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      ...(form ? { body: form.toString() } : {}),
    })
    const data = object(await boundedJSON(response, bounded, 64 * 1024).catch(() => undefined))
    bounded.throwIfAborted()
    if (!response.ok) {
      const allowed = ["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant", "invalid_client", "invalid_request"]
      throw new OAuthError(typeof data?.error === "string" && allowed.includes(data.error) ? data.error : "request_failed", response.status, retryAfter(response.headers.get("Retry-After")))
    }
    if (!data) throw new OAuthError("invalid_response")
    return data
  } catch (error) {
    if (signal?.aborted) throw new OAuthError("cancelled")
    if (error instanceof OAuthError) throw error
    throw new OAuthError(bounded.aborted ? "request_timeout" : "network_error")
  }
}

export function validateVerificationURL(value: unknown, userCode?: string, verificationURI?: string): string {
  if (typeof value !== "string" || value.length > 4096) throw new OAuthError("invalid_verification_url")
  let url: URL
  try { url = new URL(value) } catch { throw new OAuthError("invalid_verification_url") }
  if (url.origin !== "https://chat.qwen.ai" || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => key !== "user_code" && key !== "client")
    || url.searchParams.getAll("user_code").length > 1 || url.searchParams.getAll("client").length > 1
    || (url.searchParams.has("client") && url.searchParams.get("client") !== "qwen-code")
    || (userCode !== undefined && (url.searchParams.getAll("user_code").length !== 1 || url.searchParams.get("user_code") !== userCode))
    || (verificationURI !== undefined && url.pathname !== new URL(verificationURI).pathname)) throw new OAuthError("invalid_verification_url")
  return value
}

function credential(data: Record<string, unknown>, now: number): Credential.OAuth {
  if (!secret(data.access_token) || !secret(data.refresh_token) || data.token_type !== "Bearer" || !seconds(data.expires_in) || typeof data.scope !== "string") throw new OAuthError("invalid_response")
  const scopes = new Set(data.scope.split(/\s+/))
  if (!scopes.has("model:invoke") || !scopes.has("profile:read")) throw new OAuthError("invalid_scope")
  const lifetime = data.expires_in * 1000
  return { type: "oauth", methodID: METHOD_ID, access: data.access_token, refresh: data.refresh_token, expires: Math.floor(now + lifetime - Math.min(30_000, lifetime / 10)) }
}

export function singleFlightRefresh(fetcher: Fetch = fetch) {
  const pending = new Map<string, Promise<Credential.OAuth>>()
  return (previous: Credential.OAuth): Promise<Credential.OAuth> => {
    const running = pending.get(previous.refresh)
    if (running) return running
    const result = request("token", fetcher, undefined, new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: previous.refresh }))
      .then(data => credential(data, Date.now())).finally(() => pending.delete(previous.refresh))
    pending.set(previous.refresh, result)
    return result
  }
}

export interface Login { url: string; expiresAt: number; callback: Promise<Credential.OAuth>; cancel(): void }
export async function beginLogin(options: { fetch?: Fetch; signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}): Promise<Login> {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
  const issuedAt = now()
  const data = await request("device/code", fetcher, signal, new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }))
  if (!secret(data.device_code) || typeof data.user_code !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(data.user_code) || !seconds(data.expires_in) || !seconds(data.interval)) throw new OAuthError("invalid_response")
  const verificationURI = validateVerificationURL(data.verification_uri)
  const url = validateVerificationURL(data.verification_uri_complete, data.user_code, verificationURI)
  const deviceCode = data.device_code
  const expiresAt = issuedAt + data.expires_in * 1000
  const remaining = expiresAt - now()
  if (remaining <= 0) throw new OAuthError("expired_token")
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))])
  let interval = data.interval * 1000
  const callback = (async () => {
    let backoff = interval
    try {
      while (now() < expiresAt) {
        await sleep(Math.min(backoff, Math.max(0, expiresAt - now())), deadline)
        deadline.throwIfAborted()
        if (now() >= expiresAt) break
        try {
          return credential(await request("token", fetcher, deadline, new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT_ID, device_code: deviceCode })), now())
        } catch (error) {
          if (!(error instanceof OAuthError) || deadline.aborted) throw error
          if (error.status === 400 && error.code === "authorization_pending") { backoff = interval; continue }
          if (error.status === 400 && error.code === "slow_down") { interval += 5000; backoff = interval; continue }
          if (error.status === 429 || (error.status !== undefined && error.status >= 500) || error.code === "network_error" || error.code === "request_timeout") {
            backoff = Math.max(interval, Math.min(60_000, backoff * 2), error.retryAfterMs ?? 0)
            continue
          }
          throw error
        }
      }
      throw new OAuthError("expired_token")
    } catch (error) {
      if (signal.aborted) throw new OAuthError("cancelled")
      if (deadline.aborted || now() >= expiresAt) throw new OAuthError("expired_token")
      if (error instanceof OAuthError) throw error
      throw new OAuthError("request_failed")
    }
  })()
  void callback.catch(() => {})
  return { url, expiresAt, callback, cancel: () => controller.abort() }
}

export async function getMembership(access: string, fetcher: Fetch = fetch, signal?: AbortSignal): Promise<Membership> {
  const data = await request("userinfo", fetcher, signal, undefined, access)
  return ["plus", "pro", "lite", "free"].includes(String(data.member_type)) ? data.member_type as Membership : "unknown"
}
