const GATEWAY = "https://cli.qwencloud.com/data/v2/api.json"
const MAX_BYTES = 262_144
const MAX_BALANCES = 32
const TIMEOUT_MS = 10_000
const DECIMAL = /^\d+(?:\.\d+)?$/
const actions = ["quota", "QuerySubscriptionGray", "GetSeatSubscriptionSummary", "DescribeFrInstances"] as const
const states = ["disconnected", "ready", "partial", "error", "unknown"] as const
const kinds = ["personal", "team", "addon"] as const
const scopes = ["personal", "team-aggregate", "unknown"] as const
const statuses = ["valid", "exhaust", "expire", "unknown"] as const
const codes = ["invalid-credentials", "cancelled", "timeout", "unauthorized", "rate-limited", "http-error", "network-error", "body-too-large", "invalid-response", "business-error", "truncated", "invalid-amount", "invalid-reset", "inconsistent-balance", "missing-balance"] as const

export interface QwenCloudQuotaBalance {
  id: string
  kind: typeof kinds[number]
  scope: typeof scopes[number]
  status: typeof statuses[number]
  unit: "Credits"
  action: "GetSeatSubscriptionSummary" | "DescribeFrInstances"
  total?: string
  remaining?: string
  resetAt?: string
}

export interface QwenCloudQuotaDiagnostic {
  action: typeof actions[number]
  code: typeof codes[number]
}

export interface QwenCloudQuota {
  state: typeof states[number]
  source: "qwencloud-token-plan"
  observedAt: string
  balances: QwenCloudQuotaBalance[]
  diagnostics: QwenCloudQuotaDiagnostic[]
}

const amountSchema = { type: "string", pattern: "^\\d+(?:\\.\\d+)?$", maxLength: 96 } as const
const timeSchema = { type: "string", format: "date-time", maxLength: 32 } as const
export const qwenCloudQuotaSchema = {
  type: "object", additionalProperties: false,
  required: ["state", "source", "observedAt", "balances", "diagnostics"],
  properties: {
    state: { enum: states }, source: { const: "qwencloud-token-plan" }, observedAt: timeSchema,
    balances: { type: "array", maxItems: MAX_BALANCES, items: {
      type: "object", additionalProperties: false,
      required: ["id", "kind", "scope", "status", "unit", "action"],
      properties: {
        id: { type: "string", pattern: "^(personal|team|addon)-[1-9][0-9]{0,2}$" },
        kind: { enum: kinds }, scope: { enum: scopes }, status: { enum: statuses }, unit: { const: "Credits" },
        action: { enum: ["GetSeatSubscriptionSummary", "DescribeFrInstances"] },
        total: amountSchema, remaining: amountSchema, resetAt: timeSchema,
      },
    } },
    diagnostics: { type: "array", maxItems: 32, items: {
      type: "object", additionalProperties: false, required: ["action", "code"],
      properties: { action: { enum: actions }, code: { enum: codes } },
    } },
  },
} as const

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Failure("invalid-response")
  return value as Record<string, unknown>
}

function amount(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) value = String(value)
  return typeof value === "string" && value.length <= 96 && DECIMAL.test(value) ? value : undefined
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined
  const [year, month, day] = value.slice(0, 10).split("-").map(Number)
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || Number(value.slice(11, 13)) > 23) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function reset(value: unknown): string | undefined {
  if (typeof value === "number" || (typeof value === "string" && /^\d{1,16}$/.test(value))) {
    const ms = Number(value)
    if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 253402300799999) return undefined
    return new Date(ms).toISOString()
  }
  return iso(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

export function readQwenCloudQuota(value: unknown): QwenCloudQuota {
  try {
    const data = record(value)
    if (!onlyKeys(data, ["state", "source", "observedAt", "balances", "diagnostics"]) || !states.includes(data.state as QwenCloudQuota["state"]) || data.source !== "qwencloud-token-plan" || typeof data.observedAt !== "string" || iso(data.observedAt) !== data.observedAt || !Array.isArray(data.balances) || data.balances.length > MAX_BALANCES || !Array.isArray(data.diagnostics) || data.diagnostics.length > 32) throw new Error()
    const ids = new Set<string>()
    const balances = data.balances.map(raw => {
      const b = record(raw)
      if (!onlyKeys(b, ["id", "kind", "scope", "status", "unit", "action", "total", "remaining", "resetAt"]) || typeof b.id !== "string" || !/^(personal|team|addon)-[1-9][0-9]{0,2}$/.test(b.id) || ids.has(b.id) || !kinds.includes(b.kind as QwenCloudQuotaBalance["kind"]) || !scopes.includes(b.scope as QwenCloudQuotaBalance["scope"]) || !statuses.includes(b.status as QwenCloudQuotaBalance["status"]) || b.unit !== "Credits" || !["GetSeatSubscriptionSummary", "DescribeFrInstances"].includes(b.action as string)) throw new Error()
      if (!b.id.startsWith(`${b.kind}-`) || b.scope !== (b.kind === "personal" ? "personal" : b.kind === "team" ? "team-aggregate" : "unknown") || (b.action === "GetSeatSubscriptionSummary" && b.kind !== "team")) throw new Error()
      for (const key of ["total", "remaining"]) if (key in b && (typeof b[key] !== "string" || amount(b[key]) === undefined)) throw new Error()
      if ("resetAt" in b && (typeof b.resetAt !== "string" || iso(b.resetAt) !== b.resetAt || b.action !== "GetSeatSubscriptionSummary")) throw new Error()
      ids.add(b.id)
      return { ...b } as unknown as QwenCloudQuotaBalance
    })
    const diagnostics = data.diagnostics.map(raw => {
      const d = record(raw)
      if (!onlyKeys(d, ["action", "code"]) || !actions.includes(d.action as QwenCloudQuotaDiagnostic["action"]) || !codes.includes(d.code as QwenCloudQuotaDiagnostic["code"])) throw new Error()
      return { ...d } as unknown as QwenCloudQuotaDiagnostic
    })
    const hasAmounts = balances.some(b => b.total !== undefined || b.remaining !== undefined)
    if ((data.state === "ready" && (!hasAmounts || diagnostics.length)) || (data.state === "partial" && (!hasAmounts || !diagnostics.length)) || ((data.state === "disconnected" || data.state === "error") && balances.length) || (data.state === "unknown" && hasAmounts) || (data.state === "error" && !diagnostics.length)) throw new Error()
    return { state: data.state as QwenCloudQuota["state"], source: "qwencloud-token-plan", observedAt: data.observedAt as string, balances, diagnostics }
  } catch { throw new Error("Invalid QwenCloud quota response.") }
}

class Failure extends Error {
  constructor(readonly code: QwenCloudQuotaDiagnostic["code"]) { super(code) }
}

async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Failure("cancelled"))
    if (signal.aborted) listener()
    else signal.addEventListener("abort", listener, { once: true })
  })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener("abort", listener) }
}

function business(data: Record<string, unknown>): void {
  if (("Success" in data && data.Success !== true) || ("Code" in data && data.Code !== "200" && data.Code !== 200 && data.Code !== "Success" && data.Code !== "SUCCESS")) throw new Failure("business-error")
}

async function request(action: QwenCloudQuotaDiagnostic["action"], params: Record<string, string>, token: string, fetcher: typeof fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  const response = await cancellable(fetcher(GATEWAY, {
    method: "POST", redirect: "error", signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ product: "BssOpenAPI-V3", action, region: "ap-southeast-1", params }),
  }).then(response => {
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Failure("cancelled") }
    return response
  }), signal)
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {})
    throw new Failure(response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 429 ? "rate-limited" : "http-error")
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) { void response.body?.cancel().catch(() => {}); throw new Failure("body-too-large") }
  if (!response.body || !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel().catch(() => {}); throw new Failure("invalid-response") }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await cancellable(reader.read(), signal)
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_BYTES) throw new Failure("body-too-large")
      chunks.push(next.value)
    }
    let raw: Record<string, unknown>
    try { raw = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))) }
    catch { throw new Failure("invalid-response") }
    if (raw.code !== "200") throw new Failure("business-error")
    business(raw)
    const data = record(raw.data)
    business(data)
    return data
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

function scaled(value: string, places: number): bigint {
  const [whole, fraction = ""] = value.split(".")
  return BigInt(whole + fraction.padEnd(places, "0"))
}

function percentage(total: string, remaining: string): number | undefined {
  const places = Math.max(total.split(".")[1]?.length ?? 0, remaining.split(".")[1]?.length ?? 0)
  const t = scaled(total, places)
  const r = scaled(remaining, places)
  return t > 0n && r <= t ? Number(r * 10000n / t) / 100 : undefined
}

export async function getQwenCloudQuota(accessToken?: string, fetcher: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<QwenCloudQuota> {
  const result: QwenCloudQuota = { state: "unknown", source: "qwencloud-token-plan", observedAt: new Date().toISOString(), balances: [], diagnostics: [] }
  const diagnostic = (action: QwenCloudQuotaDiagnostic["action"], code: QwenCloudQuotaDiagnostic["code"]) => {
    if (!result.diagnostics.some(d => d.action === action && d.code === code)) result.diagnostics.push({ action, code })
  }
  if (accessToken === undefined || accessToken === "") return { ...result, state: "disconnected" }
  if (typeof accessToken !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(accessToken)) return { ...result, state: "error", diagnostics: [{ action: "quota", code: "invalid-credentials" }] }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(onAbort, TIMEOUT_MS)
  const call = async (action: QwenCloudQuotaDiagnostic["action"], params: Record<string, string> = {}) => {
    try { return await request(action, params, accessToken, fetcher, controller.signal) }
    catch (error) {
      diagnostic(action, controller.signal.aborted ? signal?.aborted ? "cancelled" : "timeout" : error instanceof Failure ? error.code : "network-error")
      return undefined
    }
  }
  const append = (raw: unknown, kind: QwenCloudQuotaBalance["kind"], index: number, seat: boolean) => {
    const action = seat ? "GetSeatSubscriptionSummary" : "DescribeFrInstances"
    if (result.balances.length >= MAX_BALANCES) { diagnostic(action, "truncated"); return }
    try {
      const item = record(raw)
      const equity = seat && Array.isArray(item.EquityList) && item.EquityList.length ? record(item.EquityList[0]) : undefined
      const b: QwenCloudQuotaBalance = {
        id: `${kind}-${index + 1}`, kind, scope: kind === "personal" ? "personal" : kind === "team" ? "team-aggregate" : "unknown",
        status: "unknown", unit: "Credits", action,
      }
      const rawStatus = typeof item.Status === "object" && item.Status !== null ? record(item.Status).Code : item.Status
      if (statuses.includes(rawStatus as QwenCloudQuotaBalance["status"])) b.status = rawStatus as QwenCloudQuotaBalance["status"]
      const total = seat ? equity?.TotalValue ?? item.TotalValue : item.InitCapacityBaseValue
      const remaining = seat ? equity?.SurplusValue ?? item.SurplusValue : item.CapacityTypeCode === "periodMonthlyShift" ? item.periodCapacityBaseValue ?? item.CurrCapacityBaseValue : item.CurrCapacityBaseValue
      for (const [key, value] of [["total", total], ["remaining", remaining]] as const) {
        if (value !== undefined && value !== null) {
          const parsed = amount(value)
          if (parsed === undefined) diagnostic(action, "invalid-amount")
          else b[key] = parsed
        }
      }
      if (b.total === undefined && b.remaining === undefined) diagnostic(action, "missing-balance")
      if (b.total !== undefined && b.remaining !== undefined) {
        const places = Math.max(b.total.split(".")[1]?.length ?? 0, b.remaining.split(".")[1]?.length ?? 0)
        if (scaled(b.remaining, places) > scaled(b.total, places)) diagnostic(action, "inconsistent-balance")
      }
      if (seat && item.NextCycleFlushTime !== undefined && item.NextCycleFlushTime !== null) {
        const parsed = reset(item.NextCycleFlushTime)
        if (parsed) b.resetAt = parsed
        else diagnostic(action, "invalid-reset")
      }
      result.balances.push(b)
    } catch { diagnostic(action, "invalid-response") }
  }
  const instances = async (kind: QwenCloudQuotaBalance["kind"]) => {
    const code = kind === "personal" ? "sfm_tokenplanpersonal_dp_intl" : kind === "team" ? "sfm_tokenplanteams_dp_intl" : "sfm_tokenplanteamsaddon_dp_intl"
    const pageSize = kind === "addon" ? 100 : 10
    const data = await call("DescribeFrInstances", { Group: "tokenPlan", CommodityCode: code, PageNum: "1", PageSize: String(pageSize) })
    if (!data) return
    if (!Array.isArray(data.Data)) { diagnostic("DescribeFrInstances", "invalid-response"); return }
    const total = data.TotalCount
    if (total !== undefined && (!Number.isSafeInteger(total) || Number(total) < data.Data.length)) diagnostic("DescribeFrInstances", "invalid-response")
    if ((typeof total === "number" && total > data.Data.length) || (total === undefined && data.Data.length >= pageSize)) diagnostic("DescribeFrInstances", "truncated")
    data.Data.slice(0, MAX_BALANCES).forEach((item, index) => append(item, kind, index, false))
    if (data.Data.length > MAX_BALANCES) diagnostic("DescribeFrInstances", "truncated")
  }
  try {
    const route = await call("QuerySubscriptionGray")
    if (route) {
      if (typeof route.IsGray !== "boolean") diagnostic("QuerySubscriptionGray", "invalid-response")
      else if (!route.IsGray) await Promise.all([instances("personal"), instances("team"), instances("addon")])
      else await Promise.all([
        (async () => {
          const response = await call("GetSeatSubscriptionSummary", { productCode: "sfm_tokenplanteams_dp_intl" })
          if (!response) return
          try {
            const data = response.Data === undefined ? response : record(response.Data)
            business(data)
            if (!Array.isArray(data.SubscriptionGroupList)) throw new Failure("invalid-response")
            data.SubscriptionGroupList.slice(0, MAX_BALANCES).forEach((item, index) => append(item, "team", index, true))
            if (data.SubscriptionGroupList.length > MAX_BALANCES) diagnostic("GetSeatSubscriptionSummary", "truncated")
          } catch (error) { diagnostic("GetSeatSubscriptionSummary", error instanceof Failure ? error.code : "invalid-response") }
        })(),
        instances("addon"),
      ])
    }
    result.balances.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]))
    const measured = result.balances.some(b => b.total !== undefined || b.remaining !== undefined)
    result.state = measured ? result.diagnostics.length ? "partial" : "ready" : result.diagnostics.some(d => d.code !== "missing-balance") ? "error" : "unknown"
    if (result.state === "error") result.balances = []
    result.observedAt = new Date().toISOString()
    return result
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort) }
}

export interface QwenCloudQuotaV1Entry {
  kind: "value" | "percent"
  name: string
  label: string
  resultType: "balance" | "quota" | "status"
  value?: string
  percentRemaining?: number
  observedAtIso: string
  resetTimeIso?: string
}

export function toQwenCloudQuotaV1(value: QwenCloudQuota): { version: "quota-v1"; entries: QwenCloudQuotaV1Entry[] } {
  const quota = readQwenCloudQuota(value)
  const entries: QwenCloudQuotaV1Entry[] = []
  for (const b of quota.balances) {
    const label = b.kind === "personal" ? "Personal Token Plan" : b.kind === "team" ? "Team aggregate Token Plan" : "Addon scope unknown"
    const metadata = { observedAtIso: quota.observedAt, ...(b.resetAt ? { resetTimeIso: b.resetAt } : {}) }
    const suffix = b.status === "valid" ? "" : ` (${b.status})`
    if (b.status === "expire") {
      entries.push({ ...metadata, kind: "value", name: b.id, label, resultType: "status", value: "Expired" })
      continue
    }
    if (b.remaining !== undefined) entries.push({ ...metadata, kind: "value", name: `${b.id}-remaining`, label: `${label} remaining${suffix}`, resultType: "balance", value: `${b.remaining} Credits` })
    if (b.total !== undefined) entries.push({ ...metadata, kind: "value", name: `${b.id}-total`, label: `${label} allocation${suffix}`, resultType: "quota", value: `${b.total} Credits` })
    const percent = b.total !== undefined && b.remaining !== undefined ? percentage(b.total, b.remaining) : undefined
    if (percent !== undefined) entries.push({ ...metadata, kind: "percent", name: `${b.id}-percent`, label: `${label} remaining${suffix}`, resultType: "quota", percentRemaining: percent })
  }
  if (quota.state !== "ready" || !entries.length) entries.push({
    kind: "value", name: "status", label: "QwenCloud Token Plan", resultType: "status", observedAtIso: quota.observedAt,
    value: quota.state === "disconnected" ? "Not signed in" : quota.state === "partial" ? "Partial quota data; some reads failed or were incomplete" : quota.state === "error" ? "Quota read failed" : "No Token Plan balance observed",
  })
  return { version: "quota-v1", entries }
}
