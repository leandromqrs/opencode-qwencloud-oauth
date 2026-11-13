import { documentedEfforts, type AccountModel } from "./inventory.js"

export const TOKEN_PLAN_SUPPORT = {
  sources: [
    "https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview",
    "https://docs.qwencloud.com/token-plan/team/token-plan-team-overview",
  ],
  reviewedAt: "2026-11-12",
  validFrom: "2026-11-11T10:00:00+08:00",
  validUntil: "2026-11-26T00:00:00+08:00",
} as const

const previewIDs = new Set(["qwen4-max-preview", "qwen4.0-max-preview"])

export function supplementTokenPlan(models: AccountModel[], now: number): AccountModel[] {
  const valid = Number.isFinite(now) && now >= Date.parse(TOKEN_PLAN_SUPPORT.validFrom) && now < Date.parse(TOKEN_PLAN_SUPPORT.validUntil)
  const inventory = models.filter(model => model.id !== "qwen4.0-max-preview" && (valid || !previewIDs.has(model.id)))
  const alias = models.find(model => model.id === "qwen4.0-max-preview")
  if (valid && alias && !inventory.some(model => model.id === "qwen4-max-preview")) inventory.push({ ...alias, id: "qwen4-max-preview" })
  if (!valid || inventory.length === 0) return inventory
  // Documentation grants advertised support, not account entitlement; never persist these entries as observations.
  for (const id of ["qwen4-max-preview", "auto"]) {
    if (inventory.some(model => model.id === id)) continue
    inventory.push({ id, context: null, inputLimit: null, output: null, inputModalities: null, outputModalities: null, efforts: documentedEfforts(id), metadata: "token-plan-documentation", provenance: TOKEN_PLAN_SUPPORT })
  }
  return inventory
}
