import { Model } from "@opencode/plugin/effect"
import { Schema } from "effect"
import { object } from "./oauth.js"

export interface PriceItem { Type: string; PriceUnit: string; Price: string; PriceName: string; Discount?: string }
export interface PriceRange { RangeName: string; Prices: PriceItem[] }
export interface PricingMetadata { Prices?: PriceItem[]; MultiPrices?: PriceRange[]; invalid?: true }

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)

function emptyRangePlaceholder(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false
  const range = object(value[0])
  if (!range || Object.keys(range).length !== 1 || !Object.hasOwn(range, "Prices") || !Array.isArray(range.Prices) || range.Prices.length !== 1) return false
  const item = object(range.Prices[0])
  return item !== undefined && Object.keys(item).length === 0
}

export function sanitizePricing(value: unknown): PricingMetadata | undefined {
  if (value === undefined) return undefined
  const raw = object(value)
  if (!raw || raw.invalid === true) return { invalid: true }
  let count = 0
  const prices = (value: unknown): PriceItem[] | undefined => {
    if (!Array.isArray(value) || value.length > 64 || (count += value.length) > 256) return undefined
    const result: PriceItem[] = []
    for (const entry of value) {
      const item = object(entry)
      if (!item) return undefined
      const name = item.PriceName ?? item.Type
      const discount = typeof item.Discount === "number" && Number.isFinite(item.Discount) ? String(item.Discount) : item.Discount ?? undefined
      if (!text(item.Type, 128) || !text(item.PriceUnit, 96) || !text(item.Price, 64) || !text(name, 256) || (discount !== undefined && !text(discount, 64)) || (item.Currency !== undefined && item.Currency !== "USD")) return undefined
      result.push({ Type: item.Type, PriceUnit: item.PriceUnit, Price: item.Price, PriceName: name, ...(discount !== undefined ? { Discount: discount } : {}) })
    }
    return result
  }
  const result: PricingMetadata = {}
  if (raw.Prices !== undefined && raw.Prices !== null) {
    const items = prices(raw.Prices)
    if (!items) return { invalid: true }
    result.Prices = items
  }
  if (raw.MultiPrices !== undefined && raw.MultiPrices !== null && !emptyRangePlaceholder(raw.MultiPrices)) {
    if (!Array.isArray(raw.MultiPrices) || raw.MultiPrices.length > 32) return { invalid: true }
    result.MultiPrices = []
    for (const entry of raw.MultiPrices) {
      const range = object(entry)
      if (!range || !text(range.RangeName, 128)) return { invalid: true }
      const items = prices(range.Prices)
      if (!items) return { invalid: true }
      result.MultiPrices.push({ RangeName: range.RangeName, Prices: items })
    }
  }
  return result.Prices !== undefined || result.MultiPrices !== undefined ? result : undefined
}

function decimal(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined
  const number = Number(value)
  if (number === 0 && /[1-9]/.test(value.split(/[eE]/)[0])) return undefined
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

const tokenTypes = new Set([
  "input_token", "text_input_token", "output_token", "purein_text_output_token",
  "input_token_cache_read", "text_input_token_cache", "input_token_cache", "input_token_cache_creation_5m",
])
const batchTypes = new Set(["input_token_batch", "output_token_batch", "thinking_input_token_batch", "thinking_output_token_batch"])

function tokenCost(prices: PriceItem[]): Model.Cost | undefined {
  const rates = new Map<string, number>()
  for (const item of prices) {
    if (batchTypes.has(item.Type)) continue
    if (!tokenTypes.has(item.Type) || !["USD/1M tokens", "Per 1M tokens"].includes(item.PriceUnit)) return undefined
    const base = decimal(item.Price)
    if (base === undefined) return undefined
    const discount = item.Discount === undefined ? undefined : decimal(item.Discount)
    const rate = discount !== undefined && discount > 0 && discount <= 1 ? Number((base * discount).toPrecision(10)) : base
    if (!Number.isFinite(rate) || base > 0 && rate === 0) return undefined
    rates.set(item.Type, rate)
  }
  const input = rates.get("input_token") ?? rates.get("text_input_token")
  const output = rates.get("output_token") ?? rates.get("purein_text_output_token")
  if (input === undefined || output === undefined) return undefined
  // The user chose the CLI's display precedence, not an assertion about the request's billing mode.
  const read = rates.get("input_token_cache_read") ?? rates.get("text_input_token_cache") ?? rates.get("input_token_cache")
  // Native costs require cache rates; absent tariffs use the user-approved ordinary-input estimate.
  return Schema.decodeUnknownSync(Model.Cost)({ input, output, cache: { read: read ?? input, write: rates.get("input_token_cache_creation_5m") ?? input } })
}

function contextRange(label: string): [number, number] | undefined {
  const integer = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(label)
  if (integer) return [Number(integer[1]), Number(integer[2])]
  const inequality = /^(?:(0|[1-9]\d*)([km]?)<)?Input<=(0|[1-9]\d*)([km]?)$/.exec(label)
  if (!inequality) return undefined
  const tokens = (amount: string | undefined, suffix: string | undefined) => Number(amount ?? 0) * (suffix === "k" ? 1000 : suffix === "m" ? 1000000 : 1)
  return [tokens(inequality[1], inequality[2]), tokens(inequality[3], inequality[4])]
}

export function nativeCosts(pricing: PricingMetadata | undefined, context?: number | null): Model.Info["cost"] {
  if (!pricing || pricing.invalid) return []
  if (pricing.MultiPrices?.length) {
    const costs: Model.Cost[] = []
    let end = 0
    for (const range of pricing.MultiPrices) {
      const bounds = contextRange(range.RangeName)
      if (!bounds) return []
      const [lower, upper] = bounds
      if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper > 1_000_000_000 || lower !== end || upper <= lower) return []
      const cost = tokenCost(range.Prices)
      if (!cost) return []
      costs.push(lower === 0 ? cost : { ...cost, tier: { type: "context", size: lower } })
      end = upper
    }
    // Native tiers have no upper bound, so do not extend the last advertised range beyond known context.
    return context !== undefined && context !== null && context <= end ? costs : []
  }
  const cost = tokenCost(pricing.Prices ?? [])
  return cost ? [cost] : []
}
