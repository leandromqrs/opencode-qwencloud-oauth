import assert from "node:assert/strict"
import test from "node:test"
import { getIndividualQuota, readQwenCloudQuota } from "../src/quota.js"

const usage = (data: unknown) => ({
  code: "200", successResponse: true, data: {
    success: true, errorCode: "", DataV2: { ret: ["SUCCESS::ok"], data: { code: "SUCCESS", success: true, data } },
  },
})
const issued = { code: "200", successResponse: true, data: { cliAccessToken: "derived-token" } }

test("Individual quota uses the derived credential at the regional gateway and preserves zero", async () => {
  const requests: Request[] = []
  const result = await getIndividualQuota("management-token", async (url, init) => {
    requests.push(new Request(url, init))
    return Response.json(requests.length === 1 ? issued : usage({
      per1WeekPercentage: 0.75, per1MonthPercentage: 0, per1MonthResetTime: 1797264000000,
    }))
  })
  const [issuer, gateway] = requests
  assert.equal(issuer.url, "https://cli.qwencloud.com/data/v2/api.json")
  assert.equal(issuer.headers.get("Authorization"), "Bearer management-token")
  assert.deepEqual(await issuer.json(), { product: "ModelStudioRegional", action: "GenerateCLIAccessToken", version: "2026-02-10", region: "ap-southeast-1", params: {} })
  assert.equal(new URL(gateway.url).origin, "https://ap-southeast-1-cs-data.qwencloud.com")
  assert.equal(gateway.headers.get("Authorization"), "Bearer derived-token")
  assert.ok(requests.every(request => request.redirect === "error"))
  assert.equal(result.source, "qwencloud-individual-api")
  assert.deepEqual(readQwenCloudQuota(result).personalWindows, [{
    period: "monthly", scope: "personal", usedFraction: 0, resetAt: "2026-12-14T16:00:00.000Z",
  }])
})

test("Individual quota does not forward a rejected or echoed management credential", async () => {
  let requests = 0
  const result = await getIndividualQuota("management-token", async () => {
    requests++
    return Response.json({ ...issued, data: { cliAccessToken: "management-token" } })
  })
  assert.equal(requests, 1)
  assert.equal(result.diagnostics[0]?.code, "invalid-response")
})

test("Individual quota distinguishes a missing month, an invalid ratio and an invalid reset", async () => {
  for (const [data, state, code] of [
    [{ per1WeekPercentage: 0.25 }, "unknown", "missing-balance"],
    [{ per1MonthPercentage: 1.1 }, "error", "invalid-amount"],
    [{ per1MonthPercentage: 0.25, per1MonthResetTime: "tomorrow" }, "error", "invalid-reset"],
  ] as const) {
    let requests = 0
    const result = readQwenCloudQuota(await getIndividualQuota("management-token", async () => Response.json(++requests === 1 ? issued : usage(data))))
    assert.equal(result.state, state)
    assert.equal(result.diagnostics[0]?.code, code)
    assert.equal(result.personalWindows, undefined)
  }
})
