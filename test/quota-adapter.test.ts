import assert from "node:assert/strict"
import { test } from "node:test"
import type { Endpoint } from "@opencode/client/service"
import { quotaAdapterConfig, startQuotaAdapter } from "../src/quota-adapter.js"
import { getQwenCloudQuota } from "../src/quota.js"

const token = "test-only-adapter-key-01234567890123456789"
const endpoint: Endpoint = { url: "http://127.0.0.1:4096", auth: { type: "basic", username: "test", password: "native-test-only-password" } }

test("adapter config requires explicit location and a separate Qwen adapter key", () => {
  assert.deepEqual(quotaAdapterConfig(["--location", "/workspace"], { QWENCLOUD_QUOTA_ADAPTER_KEY: token }), { location: "/workspace", port: 62366, token })
  assert.throws(() => quotaAdapterConfig([], { QWENCLOUD_QUOTA_ADAPTER_KEY: token }))
  assert.throws(() => quotaAdapterConfig(["--location", "relative"], { QWENCLOUD_QUOTA_ADAPTER_KEY: token }))
  assert.throws(() => quotaAdapterConfig(["--location", "/workspace"], { JUNIE_QUOTA_ADAPTER_KEY: token }))
  assert.throws(() => quotaAdapterConfig(["--location", "/workspace"], { QWEN_CODE_QUOTA_ADAPTER_KEY: token }))
  assert.throws(() => quotaAdapterConfig(["--location", "/workspace", "--port", "0"], { QWENCLOUD_QUOTA_ADAPTER_KEY: token }))
  assert.throws(() => quotaAdapterConfig(["--location", "/workspace", "--location", "/other"], { QWENCLOUD_QUOTA_ADAPTER_KEY: token }))
})

test("adapter does not discover at startup or before adapter authentication", async () => {
  let discoveries = 0
  const adapter = await startQuotaAdapter({ location: "/workspace", token, port: 0, discover: async () => { discoveries++; return undefined } })
  try {
    assert.equal(discoveries, 0)
    assert.equal((await fetch(adapter.url)).status, 401)
    assert.equal(discoveries, 0)
    const response = await fetch(adapter.url, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "Quota service unavailable" })
    assert.equal(discoveries, 1)
  } finally { await adapter.close() }
})

test("adapter uses only authenticated native qwencloud quota RPC with explicit location", async () => {
  const requests: Request[] = []
  const adapter = await startQuotaAdapter({ location: "/workspace", token, port: 0, discover: async () => endpoint, fetch: async input => {
    const request = input as Request
    requests.push(request)
    return Response.json({ output: await getQwenCloudQuota() })
  } })
  try {
    const response = await fetch(adapter.url, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    const body = await response.json() as { entries: { value: string }[] }
    assert.equal(body.entries[0].value, "Not signed in")
    assert.equal(requests.length, 1)
    const request = requests[0]
    const url = new URL(request.url)
    assert.equal(url.origin + url.pathname, "http://127.0.0.1:4096/api/rpc/qwencloud/quota")
    assert.equal(request.method, "POST")
    assert.equal(request.redirect, "error")
    assert.match(request.headers.get("authorization") ?? "", /^Basic /)
    assert.equal(url.searchParams.get("location[directory]"), "/workspace")
    assert.equal(url.searchParams.size, 1)
    assert.deepEqual(await request.json(), { input: {} })
  } finally { await adapter.close() }
})

test("adapter refuses non-loopback endpoints and missing native authentication", async () => {
  for (const candidate of [
    { ...endpoint, url: "https://example.test" },
    { ...endpoint, url: "http://127.0.0.1:4096/other" },
    { ...endpoint, url: "http://user:secret@127.0.0.1:4096" },
    { ...endpoint, auth: undefined },
  ]) {
    let calls = 0
    const adapter = await startQuotaAdapter({ location: "/workspace", token, port: 0, discover: async () => candidate, fetch: async () => { calls++; throw new Error("must not fetch") } })
    try {
      assert.equal((await fetch(adapter.url, { headers: { Authorization: `Bearer ${token}` } })).status, 503)
      assert.equal(calls, 0)
    } finally { await adapter.close() }
  }
})

test("adapter refuses oversized, redirected and fabricated native results", async () => {
  for (const reply of [
    async () => Response.json({ output: { ...await getQwenCloudQuota(), credits: 100 } }),
    () => new Response("x".repeat(32769), { headers: { "Content-Type": "application/json" } }),
    () => new Response("{}", { status: 302, headers: { Location: "https://example.test" } }),
  ]) {
    const adapter = await startQuotaAdapter({ location: "/workspace", token, port: 0, discover: async () => endpoint, fetch: async () => reply() })
    try {
      const response = await fetch(adapter.url, { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: "Quota service unavailable" })
    } finally { await adapter.close() }
  }
})

test("adapter rediscovers the native owner for each authenticated panel read", async () => {
  let discoveries = 0
  const origins: string[] = []
  const adapter = await startQuotaAdapter({ location: "/workspace", token, port: 0,
    discover: async () => ({ ...endpoint, url: `http://127.0.0.1:${4096 + discoveries++}` }),
    fetch: async input => {
      origins.push(new URL((input as Request).url).origin)
      return Response.json({ output: await getQwenCloudQuota() })
    },
  })
  try {
    for (let index = 0; index < 2; index++) assert.equal((await fetch(adapter.url, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
    assert.deepEqual(origins, ["http://127.0.0.1:4096", "http://127.0.0.1:4097"])
    assert.equal(discoveries, 2)
  } finally { await adapter.close() }
})

test("adapter cancels stalled native discovery, requests and bodies", async () => {
  let requestAborted = false
  let bodyCancelled = false
  for (const stage of ["discovery", "request", "body"] as const) {
    const adapter = await startQuotaAdapter({ location: "/workspace", token, port: 0, requestTimeoutMs: 25,
      discover: async () => stage === "discovery" ? new Promise(() => {}) : endpoint,
      fetch: async input => {
        const request = input as Request
        request.signal.addEventListener("abort", () => { requestAborted = true }, { once: true })
        if (stage === "request") return new Promise(() => {})
        return new Response(new ReadableStream({ cancel() { bodyCancelled = true } }), { headers: { "Content-Type": "application/json" } })
      },
    })
    try { assert.equal((await fetch(adapter.url, { headers: { Authorization: `Bearer ${token}` } })).status, 503) }
    finally { await adapter.close() }
  }
  assert.equal(requestAborted, true)
  assert.equal(bodyCancelled, true)
})
