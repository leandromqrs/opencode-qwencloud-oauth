import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { beginLogin, validateVerificationURL } from "../src/oauth.js"
import { discoverCatalog } from "../src/catalog.js"

const clientID = "8ad8c5d0-71a8-45b8-a358-5ea67058b45b"
test("QwenCloud PKCE exchanges management credentials without fabricated scopes or refresh", async () => {
  let clock = Date.now()
  let challenge = ""
  let calls = 0
  const login = await beginLogin({ clientID, now: () => clock, sleep: async ms => { clock += ms }, fetch: async (input, init) => {
    calls++
    const url = new URL(String(input))
    assert.equal(url.origin, "https://t.qwencloud.com")
    assert.equal(url.searchParams.get("client_id"), clientID)
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.body, undefined)
    assert.equal(url.searchParams.has("scope"), false)
    if (url.pathname === "/cli/device/code") {
      challenge = url.searchParams.get("code_challenge")!
      assert.equal(url.searchParams.get("code_challenge_method"), "S256")
      return Response.json({ Success: true, Data: { Token: "synthetic-device", VerificationUrl: `https://account.qwencloud.com/sso/OIDCAuth?${new URLSearchParams({ app_type: "synthetic-app", lang: "en-US", auth_token: "synthetic-browser", oauth_callback: "https://www.qwencloud.com/oauth/confirm?auth_token=synthetic-callback" })}`, ExpiresIn: 120, Interval: 1 } })
    }
    assert.equal(url.pathname, "/cli/device/token")
    assert.equal(createHash("sha256").update(url.searchParams.get("code_verifier")!).digest("base64url"), challenge)
    assert.equal(url.searchParams.get("token"), "synthetic-device")
    return Response.json({ Success: true, Data: { Status: "complete", Credentials: { AccessToken: "synthetic-management", ExpireTime: new Date(clock + 3600000).toISOString(), RefreshToken: "must-not-use" } } })
  } })
  const value = await login.callback
  assert.equal(value.access, "synthetic-management")
  assert.equal(value.refresh, "")
  assert.equal(calls, 2)
})

test("QwenCloud catalog uses management gateway not inference models endpoint", async () => {
  const catalog = await discoverCatalog("synthetic-management", async (input, init) => {
    assert.equal(String(input), "https://cli.qwencloud.com/data/v2/api.json")
    assert.equal(init?.method, "POST")
    assert.deepEqual(JSON.parse(String(init?.body)), { product: "AliyunDeliveryService", action: "ListModelSeries", region: "ap-southeast-1", params: { Language: "en-US" } })
    return Response.json({ code: "200", data: { Data: [{ Items: [{ Model: "catalog-model", ModelInfo: { ContextWindow: 65536, MaxOutputTokens: 4096 }, InferenceMetadata: { RequestModality: ["Text", "Image"], ResponseModality: ["Text"] }, private: "discard" }] }] } })
  })
  assert.equal(catalog.models[0].context, 65536)
  assert.doesNotMatch(JSON.stringify(catalog), /discard|synthetic-management/)
})

test("verification URL cannot escape approved auth origin or carry redirect destinations", () => {
  for (const value of ["https://chat.qwen.ai/activate", "https://t.qwencloud.com.evil/activate", "https://user@t.qwencloud.com/activate", "https://t.qwencloud.com/activate#x", "https://t.qwencloud.com/activate?token=a&token=b", "https://t.qwencloud.com/activate?redirect_uri=https://evil.test"]) assert.throws(() => validateVerificationURL(value))
})
