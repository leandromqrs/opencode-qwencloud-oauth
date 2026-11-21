# QwenCloud quota semantics

QwenCloud exposes authenticated quota reads through its control-plane gateway. The old conclusion that Qwen Code subscriptions do not expose quota does **not** apply to this service.

## Individual quota without a CLI

Set `quotaSource: "individual-api"` in the plugin options, leave `quotaBridge` disabled, and sign in to `qwencloud-oauth` in OpenCode. On an explicit `qwencloud/quota` request, the plugin exchanges the active management OAuth credential for a short-lived gateway credential using `GenerateCLIAccessToken`, then calls the Singapore Individual usage route. It uses neither the inference API key nor any CLI credential files, and does not persist the derived credential.

The response has `source: "qwencloud-individual-api"`. It reports only the observed personal monthly window, including a reset timestamp when present. It does not claim the inference key belongs to that account, convert a weekly window to monthly, or fall back to `bl` or BSS when the API fails. Expired management sessions require signing in to OpenCode again.

This route follows the [official QwenCloud CLI 1.7.0 implementation](https://github.com/QwenCloud/qwencloud-cli/blob/v1.7.0/src/services/tokenplan-individual.ts); it is not documented as a stable public API. On 2026-11-21, the plugin's direct HTTP read through an isolated OpenCode host matched `bl`: used fraction `0.8197571410996534`, reset `2026-12-14T16:00:00.000Z`.

## Personal quota through the authenticated CLI

When `quotaSource` is omitted, `qwencloud/quota` retains the existing `bl usage token-plan --output json` behavior on explicit requests only. Install the official `bailian-cli` and complete `bl auth login --console` in the account whose quota you want to inspect. The plugin does not read the CLI credential file or forward management credentials. No listener starts unless `quotaBridge` is explicitly configured. The CLI manages its own session and may refresh stored console credentials.

The native result identifies `source: alibaba-console-cli` and `accountBinding: unverified`: console login is independent of both QwenCloud OAuth and the inference key. A monthly `personalWindows` entry preserves the provider's used fraction and optional reset timestamp; quota-v1 projects remaining percentage, not invented credit totals. Missing values and explicit zero remain distinct. No result is cached or attributed to the active management account. Expired or absent management OAuth does not block this independently authenticated read.

Executable discovery excludes relative/project-local PATH entries, project symlinks and shell launchers. Execution uses fixed arguments without a shell, the home directory as working directory, a ten-second process deadline and bounded stdout/stderr. Errors expose fixed diagnostics, not command output. Missing CLI or console authentication does not fall back to unrelated team balances.

On 2026-11-11, the native RPC returned `ready`, used fraction `0.5715795927593333` and reset `2026-11-14T16:00:00.000Z`: approximately 42.842% remaining. This establishes native CLI retrieval, not account equivalence or panel registration.

## Management quota transport

`qwencloud/managementQuota` preserves the separate BSS reader. Requests use `POST https://cli.qwencloud.com/data/v2/api.json`, Bearer management OAuth, `product: BssOpenAPI-V3`, region `ap-southeast-1`, and string-valued parameters. Validate HTTP, outer business status and each action's inner payload before accepting a balance.

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

For `managementQuota`, `disconnected` means no active management OAuth connection. A stored connection with an expired session returns `error` with `session-expired`; its quota-v1 status asks the user to sign in to QwenCloud again. Unavailable credentials return `credentials-unavailable`, not an expiry claim. A switch to another connected account during a read discards the old result and returns `account-changed`; signing out during a read returns `disconnected`. None of these states implies that the separate inference key is missing or that the Token Plan is exhausted.

The native `status.connected` field retains its original meaning: a management connection is stored, not necessarily usable. `status.management` starts as `stored-unverified` and learns `configured-unverified`, `expired`, `unavailable` or `unauthorized` from explicit quota or catalog refresh calls. `configured-unverified` means credentials passed local presence/expiry checks, not that the server verified authorization. These observations are account-bound and in memory; switching management accounts or receiving credential updates clears them. Integration-registry broadcasts and switches of unrelated credentials do not erase them. Startup and status never resolve credentials or make upstream requests. The inference-key status remains independent.

The OAuth method deliberately does not register a refresh callback: the official service has no supported token-refresh operation. OpenCode 2.2.5 otherwise invokes that callback before returning credentials whose expiration is within five minutes. A callback that only throws a reauthentication error would prevent even still-valid credentials from reaching the quota reader. Without that callback, explicit quota reads can use a still-valid session and classify an actually expired session locally without sending it upstream.

## Implemented scope and adapter

### Custom providers with the existing quota consumer

The active setup uses **Custom providers → QwenCloud Token Plan**, not a QwenCloud-specific fork of OpenCode Quota. The original consumer package, including its existing Codex customization, is restored. The QwenCloud plugin options contain:

```json
{
  "quotaBridge": {
    "port": 62367,
    "apiKeyEnv": "QWENCLOUD_QUOTA_BRIDGE_KEY",
    "autoKey": true,
    "shared": true
  }
}
```

The custom remote definition uses ID `qwencloud-token-plan`, provider ID `qwencloud`, label `QwenCloud Token Plan`, URL `http://127.0.0.1:62367/quota`, format `quota-v1` and the same `apiKeyEnv`. Registration starts disabled; the user explicitly approves activation. No OAuth or inference key is reused. With `shared: true`, the plugin automatically initializes a bridge-only key in `~/.local/state/opencode-qwencloud-oauth/quota-bridge-v1` using a private directory (0700) and key file (0600). Participating hosts use that key through their own process environments. Disposal removes an environment value only if the plugin owns it and it still matches; the private shared key remains for subsequent hosts and reboots. This environment channel assumes the existing trusted-plugin process boundary, not isolation from other plugins. CLI subprocesses receive a copied environment with bridge keys removed.

Multiple locations share local leases, and independent OpenCode processes coordinate on the fixed loopback endpoint. A follower authenticates the existing listener with a port-bound HMAC discovery handshake rather than invoking the quota command. If the owner exits, a live follower attempts to take ownership automatically. Reload/disposal releases local leases and cancels retries; no separate adapter command or host service is needed. Existing environment keys are never overwritten, and conflicting keys or unknown listeners fail closed. Port 62366 was already occupied in the observed host; this configuration uses 62367 without terminating that listener.

Shared state also contains immutable records of participating workspace lexical paths and canonical realpaths. The owner reads their union before each CLI executable discovery, retaining project-local executable fencing across hosts. Records are append-only: stale workspaces can conservatively exclude executable locations. Limits are 1,024 records, 1 MiB of root records and 4,096 characters per path. Corrupt, inaccessible or over-limit state fails closed; records are never silently truncated or pruned. Fencing applies at discovery time and cannot revoke a CLI request already running when a new workspace registers.

The earlier `autoKey: true` mode without `shared` retains its process-local, ephemeral-key behavior. When migrating from it, restart every affected OpenCode host, including OpenChamber and separate terminal hosts, after installing the build and enabling `shared`. An old ephemeral listener cannot authenticate with the persisted key and is deliberately not adopted or terminated. Reloading only one host does not prove that other hosts have loaded the new implementation. No manual bridge startup is required after migration.

The unchanged consumer's `quota_provider_test` succeeded after activation and returned a `remote_api` row under account `QwenCloud Token Plan`, with remaining percentage `42.84204072406666` and reset `2026-11-14T16:00:00.000Z`. Targeted custom-provider refreshes returned the same row in both My and LuminusOS locations. This establishes authenticated ingestion through the standard Custom providers path; it does not bind the CLI account to OAuth or inference credentials.

### Legacy standalone adapter

The implementation covers Token Plan reads only. Free-tier, Coding Plan, wallet and billing reads remain outside this version. The management reader has a ten-second overall deadline, a 256-KiB limit per response, at most four gateway calls and at most 32 returned balances. Legacy subscription/addon reads use the first page; detected additional pages or output truncation produce partial results with diagnostics.

The management seat route uses three calls: routing, seat summary and addon. The legacy route uses four: routing and three commodity reads. Individual-plan retrieval through management OAuth remains unverified; the functioning personal reader uses the separate console CLI instead. See the [protocol evidence](protocol-provenance.md).

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

An earlier local `../opencode-quota` checkout implemented direct native RPC ingestion. It is no longer selected: the user preferred standard Custom providers, avoiding maintenance of a QwenCloud-specific consumer fork. The standalone adapter above remains optional legacy functionality; the active plugin-managed bridge needs no external service. General upstream support remains tracked in [opencode-quota#450](https://github.com/slkiser/opencode-quota/issues/450).
