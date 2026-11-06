import { test } from "node:test"
import assert from "node:assert/strict"
import { authorizationStartError, beginLogin, OAuthError, requireReauthentication, validateVerificationURL } from "../src/oauth.js"

const clientID = "8ad8c5d0-71a8-45b8-a358-5ea67058b45b"
const verificationURL = (callback = "https://www.qwencloud.com/oauth/confirm?auth_token=synthetic-callback") => `https://account.qwencloud.com/sso/OIDCAuth?${new URLSearchParams({ app_type: "synthetic-app", lang: "en-US", auth_token: "synthetic-browser", oauth_callback: callback })}`
const device = { Success: true, Data: { Token: "private-device", VerificationUrl: verificationURL(), ExpiresIn: 120, Interval: 5 } }
const complete = (now: number) => ({ Success: true, Data: { Status: "complete", Credentials: { AccessToken: "fixture-management", ExpireTime: new Date(now + 3600000).toISOString() } } })
const isInit = (input: string | URL | Request) => new URL(String(input)).pathname === "/cli/device/code"

test("production SSO URL with nested QwenCloud callback is accepted unchanged", async () => {
  const url = verificationURL()
  assert.equal(validateVerificationURL(url), url)
  const login = await beginLogin({ clientID, fetch: async () => Response.json({ ...device, Data: { ...device.Data, VerificationUrl: url } }) })
  assert.equal(login.url, url)
  login.cancel()
  await assert.rejects(login.callback, /cancelled/)
})

test("SSO verification requires exact HTTPS origin, route and unique nonempty query fields", () => {
  const valid = verificationURL()
  for (const value of [
    valid.replace("https://account.", "http://account."),
    valid.replace("account.qwencloud.com", "account.qwencloud.com.evil.test"),
    valid.replace("https://account.", "https://user@account."),
    valid.replace("/sso/OIDCAuth", "/sso/other"),
    `${valid}#fragment`, `${valid}#`, `${valid}&auth_token=duplicate`,
    `${valid}&redirect_uri=https://evil.test`,
    "https://t.qwencloud.com/activate?token=synthetic",
  ]) assert.throws(() => validateVerificationURL(value), /invalid_verification_url/)
  for (const key of ["app_type", "lang", "auth_token", "oauth_callback"]) {
    const missing = new URL(valid)
    missing.searchParams.delete(key)
    assert.throws(() => validateVerificationURL(missing.toString()))
    missing.searchParams.set(key, "")
    assert.throws(() => validateVerificationURL(missing.toString()))
    missing.searchParams.set(key, "synthetic")
    missing.searchParams.append(key, "duplicate")
    assert.throws(() => validateVerificationURL(missing.toString()))
  }
})

test("nested oauth_callback cannot escape the observed confirmation destination", () => {
  for (const callback of [
    "https://evil.test/oauth/confirm?auth_token=synthetic",
    "https://www.qwencloud.com.evil.test/oauth/confirm?auth_token=synthetic",
    "http://www.qwencloud.com/oauth/confirm?auth_token=synthetic",
    "https://user@www.qwencloud.com/oauth/confirm?auth_token=synthetic",
    "https://www.qwencloud.com/other?auth_token=synthetic",
    "https://www.qwencloud.com/oauth/confirm?auth_token=synthetic#fragment",
    "https://www.qwencloud.com/oauth/confirm?auth_token=synthetic&auth_token=duplicate",
    "https://www.qwencloud.com/oauth/confirm?auth_token=synthetic&redirect_uri=https://evil.test",
    "https://www.qwencloud.com/oauth/confirm", "https://www.qwencloud.com/oauth/confirm?auth_token=",
    "https://www.qwencloud.com/oauth/confirm?auth_token=%0Aunsafe",
    "%2568ttps%253A%252F%252Fevil.test", "//evil.test/oauth/confirm",
  ]) assert.throws(() => validateVerificationURL(verificationURL(callback)), /invalid_verification_url/)
})

test("authorization diagnostics expose only approved codes and numeric HTTP status", () => {
  assert.match(authorizationStartError(new OAuthError("invalid_client", 403)).message, /invalid_client.*HTTP 403/)
  assert.match(authorizationStartError(new OAuthError("network_error")).message, /network_error.*connectivity/i)
  for (const error of [new Error("PRIVATE"), new OAuthError("PRIVATE", 403), { code: "invalid_client", message: "PRIVATE" }]) assert.doesNotMatch(authorizationStartError(error).message, /PRIVATE|403/)
})

test("device flow waits first and retains slow_down interval for subsequent polls", async () => {
  let now = 1000000
  const delays: number[] = []
  let polls = 0
  const login = await beginLogin({ clientID, now: () => now, sleep: async ms => { delays.push(ms); now += ms }, fetch: async (input, init) => {
    assert.equal(init?.redirect, "error")
    if (isInit(input)) return Response.json(device)
    polls++
    return Response.json(polls === 1 ? { Success: true, Data: { Status: "slow_down" } } : polls === 2 ? { status: "authorization_pending" } : complete(now))
  } })
  const value = await login.callback
  assert.deepEqual(delays, [5000, 10000, 10000])
  assert.equal(value.refresh, "")
  assert.doesNotMatch(JSON.stringify(login), /private-device|fixture-management/)
})

test("device deadline includes first wait and cancellation stops polling", async () => {
  let now = 1000
  let polls = 0
  const login = await beginLogin({ clientID, now: () => now, sleep: async ms => { now += ms }, fetch: async input => {
    if (isInit(input)) return Response.json({ ...device, Data: { ...device.Data, ExpiresIn: 2 } })
    polls++; return Response.json(complete(now))
  } })
  await assert.rejects(login.callback, /expired/)
  assert.equal(polls, 0)
  const cancelled = await beginLogin({ clientID, fetch: async () => Response.json(device) })
  cancelled.cancel()
  await assert.rejects(cancelled.callback, /cancelled/)
})

test("QwenCloud has no invented refresh exchange", async () => {
  await assert.rejects(requireReauthentication(), /Sign in.*again.*refresh/i)
})

test("pending and Retry-After backoff remain bounded by original grant", async () => {
  let now = 1000000
  let polls = 0
  const delays: number[] = []
  const login = await beginLogin({ clientID, now: () => now, sleep: async ms => { delays.push(ms); now += ms }, fetch: async input => {
    if (isInit(input)) return Response.json({ ...device, Data: { ...device.Data, ExpiresIn: 20 } })
    polls++
    return polls === 1 ? Response.json({ Data: { Status: "authorization_pending" } }) : Response.json({ error: "PRIVATE" }, { status: 429, headers: { "Retry-After": "99999" } })
  } })
  await assert.rejects(login.callback, /expired_token/)
  assert.deepEqual(delays, [5000, 5000, 10000])
  assert.equal(polls, 2)
})

test("denied grants stop and errors cannot disclose response bodies or query secrets", async () => {
  let polls = 0
  const login = await beginLogin({ clientID, sleep: async () => {}, fetch: async input => {
    if (isInit(input)) return Response.json(device)
    polls++
    return Response.json({ Data: { Status: "access_denied" }, error_description: "PRIVATE" })
  } })
  await assert.rejects(login.callback, error => error instanceof Error && /access_denied/.test(error.message) && !error.message.includes("PRIVATE"))
  assert.equal(polls, 1)
  await assert.rejects(beginLogin({ clientID, fetch: async () => { throw new Error("PRIVATE?token=secret") } }), error => error instanceof Error && !/PRIVATE|secret/.test(error.message))
})

test("malformed completion and missing or expired credential expiry are rejected", async () => {
  for (const credentials of [{ AccessToken: "fixture" }, { AccessToken: "fixture", ExpireTime: "1970-01-01T00:00:00Z" }, { AccessToken: "fixture", ExpireTime: "not-a-date" }]) {
    const login = await beginLogin({ clientID, sleep: async () => {}, fetch: async input => Response.json(isInit(input) ? device : { Data: { Status: "complete", Credentials: credentials } }) })
    await assert.rejects(login.callback, /invalid_response/)
  }
})
