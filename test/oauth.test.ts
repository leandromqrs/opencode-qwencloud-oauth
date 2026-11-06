import { test } from "node:test"
import assert from "node:assert/strict"
import { authorizationStartError, beginLogin, CLIENT_ID, METHOD_ID, OAuthError, singleFlightRefresh, validateVerificationURL } from "../src/oauth.js"

const tokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: "model:invoke profile:read" }
const device = { device_code: "private-device", user_code: "ABCD", verification_uri: "https://chat.qwen.ai/authorize", verification_uri_complete: "https://chat.qwen.ai/authorize?user_code=ABCD&client=qwen-code", expires_in: 120, interval: 5 }

test("verification browser URL is strictly scoped", () => {
  assert.equal(validateVerificationURL(device.verification_uri_complete, "ABCD"), device.verification_uri_complete)
  for (const url of ["http://chat.qwen.ai/authorize", "https://chat.qwen.ai.evil/authorize", "https://user@chat.qwen.ai/authorize", "https://chat.qwen.ai/authorize#fragment", "https://chat.qwen.ai/authorize?user_code=OTHER&client=qwen-code", device.verification_uri_complete + "&redirect_uri=https://evil.test", device.verification_uri_complete + "&user_code=ABCD", device.verification_uri_complete + "&client=qwen-code", "https://chat.qwen.ai/authorize?user_code=ABCD&client=other"]) {
    assert.throws(() => validateVerificationURL(url, "ABCD"))
  }
})

test("server-selected same-origin path and absent client are accepted unchanged without polling", async () => {
  for (const client of ["", "&client=qwen-code"]) {
    let calls = 0
    const complete = `https://chat.qwen.ai/synthetic-device-route?user_code=ABCD${client}`
    const login = await beginLogin({ fetch: async () => {
      calls++
      return Response.json({ ...device, verification_uri: "https://chat.qwen.ai/synthetic-device-route", verification_uri_complete: complete })
    } })
    assert.equal(login.url, complete)
    login.cancel()
    await assert.rejects(login.callback, /cancelled/)
    assert.equal(calls, 1)
  }
})

test("device response cannot change origin or path between base and complete verification URLs", async () => {
  for (const complete of ["https://chat.qwen.ai/other-path?user_code=ABCD", "https://evil.test/authorize?user_code=ABCD"]) {
    let calls = 0
    await assert.rejects(beginLogin({ fetch: async () => {
      calls++
      return Response.json({ ...device, verification_uri_complete: complete })
    } }), error => {
      const message = authorizationStartError(error).message
      assert.match(message, /invalid_verification_url/)
      assert.doesNotMatch(message, /ABCD|private-device|other-path|evil/)
      return true
    })
    assert.equal(calls, 1)
  }
})

test("authorization diagnostics expose only approved codes and numeric HTTP status", () => {
  assert.match(authorizationStartError(new OAuthError("invalid_client", 403)).message, /invalid_client.*HTTP 403/)
  assert.match(authorizationStartError(new OAuthError("network_error")).message, /network_error.*connectivity/i)
  for (const error of [new Error("PRIVATE"), new OAuthError("PRIVATE", 403), { code: "invalid_client", message: "PRIVATE" }]) {
    assert.doesNotMatch(authorizationStartError(error).message, /PRIVATE|403/)
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
