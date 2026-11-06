import assert from "node:assert/strict"
import { request } from "node:http"
import { test } from "node:test"
import { startQuotaBridge } from "../src/quota-bridge.js"
import { getQwenCloudQuota, toQwenCloudQuotaV1 } from "../src/quota.js"

const token = "test-only-adapter-key-01234567890123456789"

test("bridge authenticates before calling native quota and projects validated observations", async () => {
  let reads = 0
  const quota = await getQwenCloudQuota()
  const bridge = await startQuotaBridge({ port: 0, token, getQuota: async () => { reads++; return quota } })
  try {
    assert.equal(reads, 0)
    const unauthorized = await fetch(bridge.url)
    assert.equal(unauthorized.status, 401)
    assert.equal(reads, 0)
    const response = await fetch(bridge.url, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(await response.json(), toQwenCloudQuotaV1(quota))
    assert.equal(reads, 1)
  } finally { await bridge.close() }
})

test("bridge rejects browser requests, wrong routes, host, method and request bodies", async () => {
  let reads = 0
  const bridge = await startQuotaBridge({ port: 0, token, getQuota: async () => { reads++; return getQwenCloudQuota() } })
  try {
    for (const [url, init, status] of [
      [bridge.url, { headers: { Origin: "https://example.test" } }, 403],
      [bridge.url + "?x=1", {}, 404],
      [bridge.url, { method: "POST" }, 405],
    ] as const) assert.equal((await fetch(url, init)).status, status)
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(bridge.url, { headers: { Host: "example.test" } }, response => { response.resume(); resolve(response.statusCode) })
      outgoing.on("error", reject)
      outgoing.end()
    })
    assert.equal(wrongHost, 400)
    const result = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(bridge.url, { method: "GET", headers: { Authorization: `Bearer ${token}`, "Content-Length": "1" } }, response => { response.resume(); resolve(response.statusCode) })
      outgoing.on("error", reject)
      outgoing.end("x")
    })
    assert.equal(result, 400)
    assert.equal(reads, 0)
  } finally { await bridge.close() }
})

test("bridge bounds stalled native calls and hides error details", async () => {
  const bridge = await startQuotaBridge({ port: 0, token, requestTimeoutMs: 25, getQuota: async () => new Promise(() => {}) })
  try {
    const response = await fetch(bridge.url, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "Quota service unavailable" })
  } finally { await bridge.close() }
  const invalid = await startQuotaBridge({ port: 0, token, getQuota: async () => ({ ...await getQwenCloudQuota(), amount: 10 }) })
  try { assert.equal((await fetch(invalid.url, { headers: { Authorization: `Bearer ${token}` } })).status, 503) }
  finally { await invalid.close() }
})

test("bridge rejects malformed configuration and cancels active reads on close", async () => {
  await assert.rejects(startQuotaBridge({ port: 0, token: "short", getQuota: async () => getQwenCloudQuota() }))
  const signal = AbortSignal.abort()
  await assert.rejects(startQuotaBridge({ port: 0, token, signal, getQuota: async () => getQwenCloudQuota() }))
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let aborted = false
  const bridge = await startQuotaBridge({ port: 0, token, getQuota: async signal => {
    signal.addEventListener("abort", () => { aborted = true }, { once: true })
    started()
    return new Promise(() => {})
  } })
  const pending = fetch(bridge.url, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
  await entered
  await bridge.close()
  await pending
  assert.equal(aborted, true)
  await bridge.close()
})

test("bridge rejects duplicate authorization headers before invoking quota", async () => {
  let reads = 0
  const bridge = await startQuotaBridge({ port: 0, token, getQuota: async () => { reads++; return getQwenCloudQuota() } })
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(bridge.url, { headers: ["Authorization", `Bearer ${token}`, "Authorization", `Bearer ${token}`, "Host", new URL(bridge.url).host] }, response => { response.resume(); resolve(response.statusCode) })
      outgoing.on("error", reject)
      outgoing.end()
    })
    assert.equal(status, 401)
    assert.equal(reads, 0)
  } finally { await bridge.close() }
})
