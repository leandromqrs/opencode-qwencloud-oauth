# Qwen subscription quota availability

## What is known

The official Qwen Code v0.26.8 subscription design exposes identity and membership, account model discovery, and inference error handling. It does not define a supported endpoint for remaining quota, a current balance, or a complete allocation/reset schedule.

The CLI's `/usage` command reports local statistics. Historical free-tier daily request counts do not establish an allocation for a current Plus/Pro account. A plan name alone is not enough to calculate remaining credits.

## Panel contract

Return a `quota-v1` status row explaining that quota is not exposed. Do not label it a balance, fabricate zero, display a percentage, or infer a reset date. Adapter reachability and account quota availability are different states.

The optional standalone adapter uses an independent key and explicit OpenCode location. It must only invoke the native Qwen quota RPC after successful adapter authentication. No OAuth tokens should leave native context, and no adapter TCP listener should be owned by a project plugin scope.

## Local validation

On 2026-11-06 the plugin was registered globally and the standalone adapter was started against this checkout. Native status confirmed a disconnected account and blocked inference. The native quota RPC returned the unsupported status without authentication to Qwen. The bridge returned HTTP 401 without its adapter key and HTTP 200 with that key, projecting a status-only `quota-v1` response.

The `qwen-code-quota` custom provider was saved **disabled**. The quota panel still needs the independent `QWEN_CODE_QUOTA_ADAPTER_KEY` in its OpenCode service environment before enabling it. A variable exported in another terminal does not update an already-running service. Do not enable the provider and rely on a fallback OAuth/API key; use the dedicated adapter key only.

The adapter's private key lives outside the repository at `~/.config/opencode/qwen-code/quota-adapter.key`. The transient service is not boot-enabled. These checks establish local adapter operation, not a live Qwen account login, remaining-quota API, or enabled panel integration.

## Exhaustion is not a quota query

The [official subscription design](https://github.com/QwenLM/qwen-code/blob/v0.26.8/docs/design/qwen-subscription.md#quota-exhaustion-presentation) identifies exhaustion only when HTTP **402** and `error.code = insufficient_quota` occur together. Optional `quota.reset_at` is an integer Unix timestamp in seconds; missing, invalid, or elapsed timestamps must be omitted.

That error is observed as a result of a model or search request, not a supported balance endpoint. Do not issue inference to provoke it. No exhaustion/reset observation has been collected for this account.
