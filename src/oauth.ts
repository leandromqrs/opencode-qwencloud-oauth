import { Credential, Integration } from "@opencode/plugin"
import { setTimeout as delay } from "node:timers/promises"
import { createHash, randomBytes } from "node:crypto"

export const AUTH_ORIGIN = "https://t.qwencloud.com"
export const METHOD_ID = Integration.MethodID.make("device")
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const secret = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768 && !/\s/.test(value)
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value * 1000 <= 2_147_483_647

export class OAuthError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly retryAfterMs?: number) { super(`QwenCloud OAuth ${code}.`); this.name = "OAuthError" }
}

export function authorizationStartError(error: unknown): Error {
  const guidance: Record<string, string> = {
    invalid_verification_url: "Qwen returned an incompatible browser authorization URL; the plugin rejected it for safety. Verify the current official authorization contract before retrying.",
    invalid_response: "Qwen returned an incompatible device authorization response. Check plugin/server compatibility.",
    invalid_client: "QwenCloud rejected this device identity. Check client compatibility.",
    invalid_request: "Qwen rejected the device authorization request. Check plugin/server compatibility.",
    access_denied: "Qwen denied device authorization. Check account/service access before retrying.",
    request_failed: "Qwen rejected device authorization. Check service availability or request restrictions before retrying.",
    network_error: "Check connectivity to t.qwencloud.com before retrying.",
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

async function request(path: "code" | "token", params: URLSearchParams, fetcher: Fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  try {
    bounded.throwIfAborted()
    const response = await fetcher(`${AUTH_ORIGIN}/cli/device/${path}?${params}`, {
      method: "POST", redirect: "error", signal: bounded,
      headers: { Accept: "application/json", "User-Agent": "qwencloud-cli/1.5.0" },
    })
    const data = object(await boundedJSON(response, bounded, 64 * 1024).catch(() => undefined))
    bounded.throwIfAborted()
    if (!response.ok) {
      const allowed = ["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant", "invalid_client", "invalid_request"]
      const rawCode = data?.error ?? object(data?.Data)?.Status ?? data?.status
      const code = typeof rawCode === "string" ? rawCode.toLowerCase() : ""
      throw new OAuthError(allowed.includes(code) ? code : "request_failed", response.status, retryAfter(response.headers.get("Retry-After")))
    }
    if (!data) throw new OAuthError("invalid_response")
    return data
  } catch (error) {
    if (signal?.aborted) throw new OAuthError("cancelled")
    if (error instanceof OAuthError) throw error
    throw new OAuthError(bounded.aborted ? "request_timeout" : "network_error")
  }
}

function verificationDestination(value: unknown, origin: string, pathname: string, keys: readonly string[]): URL {
  if (typeof value !== "string" || value.length > 8192 || /[\s\x00-\x1f\x7f\\]/.test(value)) throw new OAuthError("invalid_verification_url")
  let url: URL
  try { url = new URL(value) } catch { throw new OAuthError("invalid_verification_url") }
  if (url.origin !== origin || url.pathname !== pathname || url.username || url.password || value.includes("#")
    || [...url.searchParams.keys()].some(key => !keys.includes(key))
    || keys.some(key => {
      const values = url.searchParams.getAll(key)
      return values.length !== 1 || !values[0] || /[\s\x00-\x1f\x7f\\]/.test(values[0])
    })) throw new OAuthError("invalid_verification_url")
  return url
}

export function validateVerificationURL(value: unknown): string {
  if (typeof value !== "string") throw new OAuthError("invalid_verification_url")
  const url = verificationDestination(value, "https://account.qwencloud.com", "/sso/OIDCAuth", ["app_type", "lang", "auth_token", "oauth_callback"])
  verificationDestination(url.searchParams.get("oauth_callback"), "https://www.qwencloud.com", "/oauth/confirm", ["auth_token"])
  return value
}

function credential(data: Record<string, unknown>, now: number): Credential.OAuth {
  const raw = object(object(data.Data)?.Credentials) ?? object(data.credentials)
  const access = raw?.AccessToken ?? raw?.access_token
  const expireTime = raw?.ExpireTime ?? raw?.expire_time
  const expires = typeof expireTime === "string" ? Date.parse(expireTime) : NaN
  if (!secret(access) || !Number.isSafeInteger(expires) || expires <= now) throw new OAuthError("invalid_response")
  // OpenCode 2.2.5 requires a string; QwenCloud does not implement refresh tokens.
  return { type: "oauth", methodID: METHOD_ID, access, refresh: "", expires }
}

export async function requireReauthentication(): Promise<Credential.OAuth> {
  throw new Error("QwenCloud management session expired. Sign in to qwencloud-oauth again; automatic refresh is not supported by the official CLI protocol.")
}

export interface Login { url: string; expiresAt: number; callback: Promise<Credential.OAuth>; cancel(): void }
export async function beginLogin(options: { clientID: string; fetch?: Fetch; signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<Login> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.clientID)) throw new OAuthError("invalid_client")
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
  const issuedAt = now()
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const envelope = await request("code", new URLSearchParams({ client_id: options.clientID, code_challenge: challenge, code_challenge_method: "S256" }), fetcher, signal)
  const data = object(envelope.Data)
  if (envelope.Success !== true || !data || !secret(data.Token) || !seconds(data.ExpiresIn) || !seconds(data.Interval)) throw new OAuthError("invalid_response")
  const url = validateVerificationURL(data.VerificationUrl)
  const deviceCode = data.Token
  const expiresAt = issuedAt + data.ExpiresIn * 1000
  const remaining = expiresAt - now()
  if (remaining <= 0) throw new OAuthError("expired_token")
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))])
  let interval = data.Interval * 1000
  const callback = (async () => {
    let backoff = interval
    try {
      while (now() < expiresAt) {
        await sleep(Math.min(backoff, Math.max(0, expiresAt - now())), deadline)
        deadline.throwIfAborted()
        if (now() >= expiresAt) break
        try {
          const result = await request("token", new URLSearchParams({ client_id: options.clientID, token: deviceCode, code_verifier: verifier }), fetcher, deadline)
          if (result.Success === false) throw new OAuthError("request_failed")
          const status = object(result.Data)?.Status ?? result.status
          if (typeof status !== "string") throw new OAuthError("invalid_response")
          if (status.toLowerCase() === "complete") return credential(result, now())
          const allowed = ["authorization_pending", "slow_down", "access_denied", "expired_token"]
          throw new OAuthError(allowed.includes(status.toLowerCase()) ? status.toLowerCase() : "invalid_response")
        } catch (error) {
          if (!(error instanceof OAuthError) || deadline.aborted) throw error
          if (error.code === "authorization_pending") { backoff = interval; continue }
          if (error.code === "slow_down") { interval += 5000; backoff = interval; continue }
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
