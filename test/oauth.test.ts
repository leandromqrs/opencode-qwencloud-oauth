import { test } from "node:test"
import assert from "node:assert/strict"
import { beginLogin, CLIENT_ID, METHOD_ID, singleFlightRefresh, validateVerificationURL } from "../src/oauth.js"

const tokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: "model:invoke profile:read" }
const device = { device_code: "private-device", user_code: "ABCD", verification_uri: "https://chat.qwen.ai/authorize", verification_uri_complete: "https://chat.qwen.ai/authorize?user_code=ABCD&client=qwen-code", expires_in: 120, interval: 5 }

test("verification browser URL is strictly scoped", () => {
  assert.equal(validateVerificationURL(device.verification_uri_complete, "ABCD"), device.verification_uri_complete)
  for (const url of ["http://chat.qwen.ai/authorize", "https://chat.qwen.ai.evil/authorize", "https://user@chat.qwen.ai/authorize", "https://chat.qwen.ai/other", "https://chat.qwen.ai/authorize?user_code=OTHER&client=qwen-code", device.verification_uri_complete + "&redirect_uri=https://evil.test"]) {
    assert.throws(() => validateVerificationURL(url, "ABCD"))
  }
})

test("device flow uses native credentials, first interval, slow_down and no PKCE", async () => {
  let now = 1_000_000
  const delays: number[] = []
  const calls: { url: string; body: URLSearchParams }[] = []
  let poll = 0
  const login = await beginLogin({ now: () => now, sleep: async ms => { delays.push(ms); now += ms }, fetch: async (input, init) => {
    assert.equal(init?.redirect, "error")
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body)) })
    if (String(input).endsWith("device/code")) return Response.json(device)
    if (++poll === 1) return Response.json({ error: "slow_down", error_description: "private" }, { status: 400 })
    return Response.json(tokens)
  } })
  const credential = await login.callback
  assert.deepEqual(delays, [5000, 10000])
  assert.equal(calls[0].body.get("scope"), "model:invoke profile:read")
  assert.equal(calls[1].body.get("client_id"), CLIENT_ID)
  assert.equal(calls[1].body.get("device_code"), "private-device")
  assert.equal(calls[1].body.has("code_verifier"), false)
  assert.equal(credential.access, tokens.access_token)
  assert.equal(credential.refresh, tokens.refresh_token)
  assert.equal(JSON.stringify(login).includes("private-device"), false)
  login.cancel()
})

test("device deadline includes the first interval and cancellation stops polling", async () => {
  let now = 1000
  let polls = 0
  const login = await beginLogin({ now: () => now, sleep: async ms => { now += ms }, fetch: async input => {
    if (String(input).endsWith("device/code")) return Response.json({ ...device, expires_in: 2 })
    polls++; return Response.json(tokens)
  } })
  await assert.rejects(login.callback, /expired/)
  assert.equal(polls, 0)
  const cancelled = await beginLogin({ fetch: async () => Response.json(device) })
  cancelled.cancel()
  await assert.rejects(cancelled.callback, /cancelled/)
})

test("refresh is single flight and requires rotation pair without leaking upstream errors", async () => {
  let calls = 0
  const refresh = singleFlightRefresh(async (_input, init) => {
    calls++
    assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token")
    return Response.json(tokens)
  })
  const old = { type: "oauth" as const, methodID: METHOD_ID, access: "old-access", refresh: "old-refresh", expires: 1 }
  const result = await Promise.all([refresh(old), refresh(old)])
  assert.equal(calls, 1)
  assert.equal(result[0].refresh, "fixture-refresh")
  const incomplete = singleFlightRefresh(async () => Response.json({ ...tokens, refresh_token: undefined }))
  await assert.rejects(incomplete(old), /invalid_response/)
  const failed = singleFlightRefresh(async () => Response.json({ error: "invalid_grant", error_description: "SECRET" }, { status: 400 }))
  await assert.rejects(failed(old), error => error instanceof Error && !error.message.includes("SECRET") && error.message.includes("invalid_grant"))
})

test("pending and transient Retry-After backoff are bounded by original device grant", async () => {
  let now = 1_000_000
  const delays: number[] = []
  let polls = 0
  const login = await beginLogin({ now: () => now, sleep: async ms => { delays.push(ms); now += ms }, fetch: async input => {
    if (String(input).endsWith("device/code")) return Response.json({ ...device, expires_in: 20 })
    polls++
    return polls === 1 ? Response.json({ error: "authorization_pending" }, { status: 400 }) : Response.json({ error: "PRIVATE" }, { status: 429, headers: { "Retry-After": "99999" } })
  } })
  await assert.rejects(login.callback, /expired_token/)
  assert.deepEqual(delays, [5000, 5000, 10000])
  assert.equal(polls, 2)
})

test("device errors are sanitized and denied grants stop without another poll", async () => {
  let polls = 0
  const login = await beginLogin({ sleep: async () => {}, fetch: async input => {
    if (String(input).endsWith("device/code")) return Response.json(device)
    polls++
    return Response.json({ error: "access_denied", error_description: "PRIVATE-device-token-email" }, { status: 400 })
  } })
  await assert.rejects(login.callback, error => error instanceof Error && /access_denied/.test(error.message) && !error.message.includes("PRIVATE"))
  assert.equal(polls, 1)
})
