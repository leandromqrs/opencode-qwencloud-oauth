import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { toQwenCloudQuotaV1, type QwenCloudQuota } from "./quota.js"

export interface QuotaBridgeOptions {
  port: number
  token: string
  getQuota: (signal: AbortSignal) => Promise<QwenCloudQuota>
  signal?: AbortSignal
  requestTimeoutMs?: number
  sharedHealth?: boolean
}

export interface QuotaBridge {
  url: string
  close(): Promise<void>
}

export function quotaBridgeProof(token: string, direction: "request" | "response", nonce: string): string {
  return createHmac("sha256", token).update(`qwencloud-quota-bridge-v1:${direction}:${nonce}`).digest("hex")
}

export function validQuotaBridgeProof(token: string, direction: "request" | "response", nonce: string, proof: string): boolean {
  return /^[a-f0-9]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(quotaBridgeProof(token, direction, nonce), "hex"))
}

function headerCount(request: IncomingMessage, name: string): number {
  return request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === name).length
}

function send(response: ServerResponse, status: number, body: string): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    Connection: "close",
    ...(status === 405 ? { Allow: "GET" } : {}),
  })
  response.end(body)
}

function reject(response: ServerResponse, status: number): void {
  send(response, status, JSON.stringify({ error: status === 503 ? "Quota service unavailable" : "Request rejected" }))
}

async function loadQuota(getQuota: QuotaBridgeOptions["getQuota"], signal: AbortSignal): Promise<QwenCloudQuota> {
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Cancelled"))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted()
      return getQuota(signal)
    }), cancelled])
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort) }
}

export async function startQuotaBridge(options: QuotaBridgeOptions): Promise<QuotaBridge> {
  const timeoutMs = options.requestTimeoutMs ?? 12_000
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535 || typeof options.token !== "string" || !/^[\x21-\x7e]{32,512}$/.test(options.token) || typeof options.getQuota !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid quota bridge options.")
  if (options.signal?.aborted) throw new Error("Quota bridge start cancelled.")
  const expectedAuth = createHash("sha256").update(`Bearer ${options.token}`).digest()
  const sockets = new Set<Socket>()
  const active = new Set<AbortController>()
  let authority = ""
  let closing: Promise<void> | undefined
  let healthWindow = 0, healthCount = 0
  const server = createServer({
    maxHeaderSize: 4_096,
    headersTimeout: 3_000,
    requestTimeout: 5_000,
    connectionsCheckingInterval: 500,
    keepAliveTimeout: 1,
  }, (request, response) => {
    void handle(request, response).catch(() => reject(response, 503))
  })
  server.maxHeadersCount = 32
  server.maxConnections = 16
  server.maxRequestsPerSocket = 1
  server.setTimeout(timeoutMs + 5_000, socket => socket.destroy())
  server.on("connection", socket => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  server.on("checkContinue", (_request, response) => reject(response, 400))
  server.on("checkExpectation", (_request, response) => reject(response, 400))
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.on("connect", (_request, socket) => socket.destroy())
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    else socket.destroy()
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) return reject(response, 503)
    if (request.method !== "GET") return reject(response, 405)
    const health = options.sharedHealth && request.url === "/quota-bridge-health"
    if (request.url !== "/quota" && !health) return reject(response, 404)
    if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== authority || headerCount(request, "host") !== 1) return reject(response, 400)
    if (request.headers.origin !== undefined) return reject(response, 403)
    if (request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) return reject(response, 400)
    if (health) {
      if (Date.now() - healthWindow >= 1000) { healthWindow = Date.now(); healthCount = 0 }
      if (++healthCount > 32) return reject(response, 429)
      const nonce = request.headers["x-qwencloud-nonce"], proof = request.headers["x-qwencloud-proof"]
      const challenge = `${authority.slice("127.0.0.1:".length)}:${nonce}`
      if (request.headers.authorization !== undefined || typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) || typeof proof !== "string" || headerCount(request, "x-qwencloud-nonce") !== 1 || headerCount(request, "x-qwencloud-proof") !== 1 || !validQuotaBridgeProof(options.token, "request", challenge, proof)) return reject(response, 401)
      response.writeHead(204, { "X-Qwencloud-Protocol": "1", "X-Qwencloud-Proof": quotaBridgeProof(options.token, "response", challenge), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", Connection: "close" })
      response.end()
      return
    }
    const authorization = request.headers.authorization
    if (typeof authorization !== "string" || authorization.length > 519 || headerCount(request, "authorization") !== 1 || !timingSafeEqual(createHash("sha256").update(authorization).digest(), expectedAuth)) return reject(response, 401)
    const controller = new AbortController()
    active.add(controller)
    const onClose = () => controller.abort()
    response.once("close", onClose)
    const timer = setTimeout(onClose, timeoutMs)
    try { send(response, 200, JSON.stringify(toQwenCloudQuotaV1(await loadQuota(options.getQuota, controller.signal)))) }
    catch { reject(response, 503) }
    finally {
      clearTimeout(timer)
      response.removeListener("close", onClose)
      active.delete(controller)
    }
  }

  const onStop = () => { void close() }
  function close(): Promise<void> {
    if (closing) return closing
    options.signal?.removeEventListener("abort", onStop)
    for (const controller of active) controller.abort()
    closing = new Promise<void>(resolve => {
      server.close(() => { server.removeAllListeners(); resolve() })
      server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
    })
    return closing
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => { server.removeListener("listening", onListening); reject(new Error("Unable to start quota bridge.")) }
      const onListening = () => { server.removeListener("error", onError); resolve() }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen({ host: "127.0.0.1", port: options.port, exclusive: true })
    })
    server.on("error", onStop)
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Unable to start quota bridge.")
    authority = `127.0.0.1:${address.port}`
    options.signal?.addEventListener("abort", onStop, { once: true })
    if (options.signal?.aborted) throw new Error("Quota bridge start cancelled.")
    return { url: `http://${authority}/quota`, close }
  } catch {
    await close()
    throw new Error("Unable to start quota bridge.")
  }
}
