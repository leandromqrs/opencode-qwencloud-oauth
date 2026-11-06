# QwenCloud protocol provenance

Baseline: installed `@qwencloud/qwencloud-cli` **1.5.0**, official repository [QwenCloud/qwencloud-cli](https://github.com/QwenCloud/qwencloud-cli), inspected revision `264999e87d2fe819a9c570a9f3cbc1c9864a5163`.

The installed package manifest confirms its identity and repository; bundled constants corroborate the inspected protocol. This is not a claim of byte-identical build provenance. Source research did not read CLI credential files or invoke inference.

## Device authorization

Official sources:

- [Auth client](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/api/auth-client.ts)
- [Login lifecycle](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/auth/login-flow.ts)
- [Client identity](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/auth/client-id.ts)
- [PKCE](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/auth/pkce.ts)

Initialization is `POST https://t.qwencloud.com/cli/device/code` with query parameters `client_id`, `code_challenge` and `code_challenge_method=S256`. The client ID is a locally generated persistent UUID, not the public client identifier from Qwen Code subscription OAuth. The plugin must own its own client ID.

The response uses `Success` and `Data`, whose fields include `Token`, `VerificationUrl`, `ExpiresIn` and `Interval`. Polling is `POST /cli/device/token` with `client_id`, `token` and `code_verifier`. Successful credentials include `Data.Credentials.AccessToken` and `ExpireTime`. The CLI also accepts compatibility spellings.

These query values are secrets: never copy the upstream pattern of exposing complete URLs in errors. Two public device initializations verified the production browser destination as `https://account.qwencloud.com/sso/OIDCAuth`, with query keys `app_type`, `lang`, `auth_token` and `oauth_callback`. The nested callback destination is `https://www.qwencloud.com/oauth/confirm`, with its own `auth_token`. Validation pins these destinations and rejects duplicate or extra parameters; the server URL is returned unchanged. No issued codes, tokens or complete URLs were logged or retained, and no token polling or account approval was performed in those checks.

The inspected CLI has no implemented refresh endpoint. Expired management credentials require login again. Its displayed scopes are hardcoded status metadata, not negotiated evidence.

## Management requests and catalog

The authenticated gateway is `POST https://cli.qwencloud.com/data/v2/api.json` with Bearer management credentials. Its envelope contains `product`, `action`, `region` and `params`; parameter values are flattened to strings. HTTP 200 alone is insufficient: the outer business `code` must be the string `"200"`.

Model discovery uses `product: AliyunDeliveryService`, `action: ListModelSeries`, `region: ap-southeast-1` and `params.Language: en-US`. Groups are returned under `data.Data`, containing `Items`. IDs and metadata use the actual `Model`, `InferenceMetadata` and `ModelInfo` fields. Do not reuse the old service's embedded reasoning mappings.

Sources: [request adapter](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/api/request-adapter.ts), [models service](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/services/models-service.ts).

## Inference is a separate credential boundary

The [invocation resolver](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/services/invocation-credential-resolver.ts) obtains API keys separately from management OAuth. Model calls use the compatible Chat endpoint, not the control-plane gateway.

For parity with the inspected CLI, the native driver uses `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` for Token Plan. Token Plan keys use the `sk-sp-` prefix. Although the isolated transport utility knows the CLI's DashScope Intl destination, the registered driver accepts Token Plan keys only: it never falls back to PAYG or sends management tokens to model endpoints.

Native OAuth completion and authenticated catalog discovery were verified on 2026-11-06: the account returned 186 catalog entries. Catalog visibility does not establish model entitlement. Token Plan reads selected the seat route but returned an unrecognized summary shape; no balance or absence of subscription has been established.

The native driver provides an operation-scoped `FetchHttpClient.Fetch` implementation. It applies `prepareRequest` after host HTTP-hook serialization and immediately before fetch, so redirect refusal and cancellation are not lost in that conversion. A scope-owned deadline and explicit response-reader cancellation keep streaming timeouts effective through garbage collection. Tests exercise the host conversion sequence, real loopback sockets and compiled provider loading with separate Effect copies. No host binary patch, global fetch replacement or unsafe bypass is required.

On 2026-11-06, the user supplied a separate key through a private secret prompt; it was stored through OpenCode's native key connection, not in project files. Two minimal native chat checks reached the provider: `qwen3.6-plus` was denied as unpurchased, and `qwen3.7-plus` returned exhausted monthly quota with reset on November 14 at 16:00 UTC. These are live provider errors, not successful model generations. No automatic purchase, quota retry or alternate-plan fallback was attempted.

## Explicit inference key flow

The inspected CLI's login does not create inference keys. Missing keys direct users to the console's API Keys page. Public console assets expose separate operations for PAYG, personal Token Plan and team Token Plan key creation, but their shared browser transport uses session cookies and CSRF handling. That does not establish that a CLI Bearer management token can invoke those actions through the CLI gateway.

The integration follows the CLI rather than those browser-only operations: users create a key at `https://home.qwencloud.com/api-keys` and supply it separately. No account key was created, reset, revealed or revoked. Automatic provisioning and experimental console key probes are not part of this flow.

## Token Plan quota flow

The CLI's `usage summary` delegates to [TokenPlanService](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/services/tokenplan-service.ts). It calls BSS `QuerySubscriptionGray`, then uses the seat summary and addons for migrated accounts, or `DescribeFrInstances` for legacy team, personal and addon commodities. The personal legacy commodity is `sfm_tokenplanpersonal_dp_intl`.

The console's personal `/tokenplan/personal/api/v2/usage` gateway route is not used by the inspected CLI. Experimental probes returned an empty `ret` tuple, not a recognized success. They established neither a quota nor OAuth permission for personal console operations, and are excluded from the CLI-aligned flow. Failed or unrecognized BSS responses remain inconclusive instead of being converted to zero balance or no subscription.
