# QwenCloud quota semantics

QwenCloud exposes authenticated quota reads through its control-plane gateway. The old conclusion that Qwen Code subscriptions do not expose quota does **not** apply to this service.

## Transport

Requests use `POST https://cli.qwencloud.com/data/v2/api.json`, Bearer management OAuth, `product: BssOpenAPI-V3`, region `ap-southeast-1`, and string-valued parameters. Validate HTTP, outer business status and each action's inner payload before accepting a balance.

## Token Plan Credits

The official [Token Plan service](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/services/tokenplan-service.ts) uses `QuerySubscriptionGray` to choose the seat-based path. A failed routing query is not proof that the legacy path applies.

Seat summaries use `GetSeatSubscriptionSummary` and product code `sfm_tokenplanteams_dp_intl`. Groups can contain `TotalValue`, `SurplusValue`, `EquityList` and `NextCycleFlushTime`. Numeric cycle timestamps are milliseconds. These may be team/account aggregates, not the current user's individual allocation.

Legacy balances use `DescribeFrInstances` with `Group: tokenPlan` and commodity codes:

- Personal: `sfm_tokenplanpersonal_dp_intl`.
- Team: `sfm_tokenplanteams_dp_intl`.
- Addon: `sfm_tokenplanteamsaddon_dp_intl`.

`InitCapacityBaseValue` is allocation; `CurrCapacityBaseValue` is remaining. For `CapacityTypeCode: periodMonthlyShift`, the CLI prefers `periodCapacityBaseValue`; preserve an explicit zero rather than using a truthiness fallback. Only validated active instances can be presented as current allowance. Pagination and partial failures must remain visible, not silently produce a complete-looking sum.

Do not divide by Junie's 100,000 conversion factor. Keep plan allowance and Credit Packs separate. Do not infer reset from `EndTime` or advertised plan allocations.

## Other measurements

`DescribeFqInstance` exposes free-tier capacities with their own units and cycle dates. Multiple model IDs can share one template allowance; do not sum duplicate model projections.

Coding Plan quota windows, PAYG usage and `DescribeUsageLimit` spending controls are separate measurements. A configured spending limit is not a monetary wallet balance. No monetary-wallet endpoint was established in this research.

## Truthful states

Before live account validation, quota is **unverified**, not unsupported. Distinguish disconnected, unknown, partial, failed, absent and available observations. Never turn errors or missing values into zero or “not subscribed.” Preserve source, scope, unit, observation time and independently optional total/remaining/reset fields.

## Implemented scope and adapter

The replacement implements Token Plan reads only. Free-tier, Coding Plan, wallet and billing reads remain outside this version. A read has a ten-second overall deadline, a 256-KiB limit per response, at most four gateway calls and at most 32 returned balances. Legacy subscription/addon reads use the first page; detected additional pages or output truncation produce partial results with diagnostics.

The standalone adapter invokes `qwencloud/quota` for an explicit native location after validating its independent key. Its native response limit is 32 KiB; its loopback listener remains separate from project/plugin lifecycles.

After building and preparing an owner-private key file:

```sh
bash scripts/quota-adapter.sh start --location /absolute/project
bash scripts/quota-adapter.sh status
bash scripts/quota-adapter.sh stop
```

Use `run` for foreground operation. The unit is `opencode-qwencloud-quota-adapter.service`, with default key file `~/.config/opencode/qwencloud/quota-adapter.key` (respecting `XDG_CONFIG_HOME`) and key environment name `QWENCLOUD_QUOTA_ADAPTER_KEY`. Never reuse an OAuth token or inference key as this adapter key.

The quota panel's OpenCode process must receive the same adapter key. Exporting it in another terminal does not update a running server. The current transient adapter is not boot-enabled; starting a service once is not a persistent reboot repair.

Official product semantics: [Token Plan overview](https://docs.qwencloud.com/token-plan/overview), [personal plan](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview), [team plan](https://docs.qwencloud.com/token-plan/team/token-plan-team-overview).
