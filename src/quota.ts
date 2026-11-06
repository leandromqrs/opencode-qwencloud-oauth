export const QWEN_QUOTA_MESSAGE = "Quota not exposed by Qwen Code" as const

export interface QwenQuota {
  state: "unavailable"
  reason: "unsupported"
  message: typeof QWEN_QUOTA_MESSAGE
  connected?: boolean
}

export const qwenQuotaSchema = {
  type: "object",
  properties: {
    state: { const: "unavailable" },
    reason: { const: "unsupported" },
    message: { const: QWEN_QUOTA_MESSAGE },
    connected: { type: "boolean" },
  },
  required: ["state", "reason", "message"],
  additionalProperties: false,
} as const

export function getQwenQuota(connected?: boolean): QwenQuota {
  return {
    state: "unavailable", reason: "unsupported", message: QWEN_QUOTA_MESSAGE,
    ...(connected === undefined ? {} : { connected }),
  }
}

export function readQwenQuota(value: unknown): QwenQuota {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid quota status.")
  const data = value as Record<string, unknown>
  if (Object.keys(data).some(key => !["state", "reason", "message", "connected"].includes(key)) || data.state !== "unavailable" || data.reason !== "unsupported" || data.message !== QWEN_QUOTA_MESSAGE || (data.connected !== undefined && typeof data.connected !== "boolean")) throw new Error("Invalid quota status.")
  return getQwenQuota(data.connected as boolean | undefined)
}

export function toQwenQuotaV1(quota: QwenQuota) {
  const status = readQwenQuota(quota)
  return { version: "quota-v1" as const, entries: [{
    kind: "value" as const, name: "quota", label: "Qwen Code quota", resultType: "status" as const,
    value: status.connected === false ? "Not signed in; quota not exposed by Qwen Code" : status.message,
  }] }
}
