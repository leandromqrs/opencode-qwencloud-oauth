import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service, type Endpoint } from "@opencode/client/service"
import { startQuotaBridge, type QuotaBridge } from "./quota-bridge.js"
import { qwenQuotaSchema, readQwenQuota } from "./quota.js"

const quotaRPC = {
  id: "qwen-code",
  methods: { quota: { input: { type: "object", additionalProperties: false }, output: qwenQuotaSchema } },
  events: {},
} as const

export interface QuotaAdapterOptions {
  location: string
  token: string
  port?: number
  signal?: AbortSignal
  requestTimeoutMs?: number
  discover?: () => Promise<Endpoint | undefined>
  fetch?: typeof globalThis.fetch
}

function validLocation(location: string): boolean {
  return typeof location === "string" && location.length <= 4_096 && isAbsolute(location) && !/[\x00-\x1f\x7f]/.test(location)
}

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Quota service unavailable."))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort) }
}

function boundedRpcFetch(endpoint: Endpoint, directory: string, fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  const base = new URL(endpoint.url)
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/" || endpoint.auth?.type !== "basic" || !endpoint.auth.username || !endpoint.auth.password) throw new Error("Quota service unavailable.")
  return async (input, init) => {
    const request = new Request(input, { ...init, redirect: "error" })
    const url = new URL(request.url)
    if (url.origin !== base.origin || url.pathname !== "/api/rpc/qwen-code/quota" || url.hash || request.method !== "POST" || url.searchParams.size !== 1 || url.searchParams.get("location[directory]") !== directory) throw new Error("Quota service unavailable.")
    request.signal.throwIfAborted()
    const pending = fetcher(request).then(response => {
      if (request.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        throw new Error("Quota service unavailable.")
      }
      return response
    })
    const response = await cancellable(pending, request.signal)
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > 8_192 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      void response.body?.cancel().catch(() => {})
      throw new Error("Quota service unavailable.")
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await cancellable(reader.read(), request.signal)
        if (done) break
        size += value.byteLength
        if (size > 8_192) throw new Error("Quota service unavailable.")
        if (value.byteLength) chunks.push(value)
      }
      return new Response(Buffer.concat(chunks), { headers: { "Content-Type": "application/json" } })
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

export async function startQuotaAdapter(options: QuotaAdapterOptions): Promise<QuotaBridge> {
  if (!validLocation(options.location)) throw new Error("Invalid quota adapter configuration.")
  const location = { directory: resolve(options.location) }
  return startQuotaBridge({
    port: options.port ?? 62_366,
    token: options.token,
    signal: options.signal,
    requestTimeoutMs: options.requestTimeoutMs,
    getQuota: async signal => {
      try {
        signal.throwIfAborted()
        const endpoint = await cancellable((options.discover ?? Service.discover)(), signal)
        if (!endpoint) throw new Error("Quota service unavailable.")
        signal.throwIfAborted()
        const fetch = boundedRpcFetch(endpoint, location.directory, options.fetch ?? globalThis.fetch)
        const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint), fetch })
        return readQwenQuota(await client.rpc(quotaRPC).quota({}, { location, signal }))
      } catch { throw new Error("Quota service unavailable.") }
    },
  })
}

export function quotaAdapterConfig(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): { location: string; port: number; token: string } {
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!["--location", "--port", "--api-key-env"].includes(name) || !value || flags.has(name)) throw new Error("Invalid quota adapter configuration.")
    flags.set(name, value)
  }
  const location = flags.get("--location")
  const rawPort = flags.get("--port") ?? "62366"
  const port = Number(rawPort)
  const keyEnv = flags.get("--api-key-env") ?? "QWEN_CODE_QUOTA_ADAPTER_KEY"
  if (!location || !validLocation(location) || !/^\d{1,5}$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Z][A-Z0-9_]{0,127}$/.test(keyEnv)) throw new Error("Invalid quota adapter configuration.")
  const token = env[keyEnv]?.trim()
  if (!token || !/^[\x21-\x7e]{32,512}$/.test(token)) throw new Error("Invalid quota adapter configuration.")
  return { location: resolve(location), port, token }
}

async function main(): Promise<void> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    const adapter = await startQuotaAdapter({ ...quotaAdapterConfig(process.argv.slice(2)), signal: controller.signal })
    process.stdout.write("Qwen Code quota status adapter is ready.\n")
    try {
      await new Promise<void>(resolve => {
        if (controller.signal.aborted) resolve()
        else controller.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    } finally { await adapter.close() }
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Quota adapter failed; check its configuration, adapter key environment and listener port.\n")
    process.exitCode = 1
  })
}
