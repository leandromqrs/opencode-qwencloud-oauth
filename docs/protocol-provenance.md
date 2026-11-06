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

Current documented OpenAI bases are `https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1` for PAYG and `https://token-plan.maas.qwencloudapi.com/compatible-mode/v1` for Token Plan. The inspected CLI still contains older Alibaba endpoint defaults. The replacement must verify its routing explicitly, never silently fall back to PAYG, and never send management tokens to model endpoints.

Live OAuth, account catalog and key provisioning remain pending. Inference also remains blocked by the installed OpenCode host transport limitation.

## Key-provisioning evidence and remaining boundary

The inspected CLI's login does not create inference keys. Missing keys direct users to the console's API Keys page. Public console assets expose separate operations for PAYG, personal Token Plan and team Token Plan key creation, but their shared browser transport uses session cookies and CSRF handling. That does not establish that a CLI Bearer management token can invoke those actions through the CLI gateway.

No account key was created, reset, revealed or revoked. Automatic provisioning remains pending verification of that bridge and the correct plan/account/workspace scope; the plugin reports `keyProvisioning: unavailable-contract` rather than pretending login created a usable key.
