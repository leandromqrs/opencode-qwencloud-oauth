# Protocol provenance

Research baseline: official Qwen Code v0.26.8, published 2026-11-05, commit `21ed8f1efbb351b973d96e2bc9efa78f278df99c`. Source inspection is not live account validation.

## Official sources

- [Authentication guide](https://github.com/QwenLM/qwen-code/blob/v0.26.8/docs/users/configuration/auth.md)
- [Production OAuth constants](https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/qwen/oauth-config.ts)
- [Subscription device/token client](https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/qwen/subscription-oauth-client.ts)
- [Session and model catalog lifecycle](https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/qwen/subscription-session.ts)
- [Fixed inference transport](https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/qwen/subscription-content-generator.ts)
- [Subscription model metadata](https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/qwen/subscription-models.ts)
- [Subscription design and security contract](https://github.com/QwenLM/qwen-code/blob/v0.26.8/docs/design/qwen-subscription.md)
- [OpenAI request pipeline and thinking mappings](https://github.com/QwenLM/qwen-code/blob/v0.26.8/packages/core/src/core/openaiContentGenerator/pipeline.ts)

## Current subscription OAuth

Fixed auth origin: `https://auth.qwen.ai`. Public client ID: `qwen-code-cli`. Scope: `model:invoke profile:read`. No client secret.

- Device authorization: `POST /api/oauth/device/code`.
- Polling and refresh: `POST /api/oauth/token`.
- Identity/membership: `GET /api/oauth/userinfo`.
- Refresh-token revocation: `POST /api/oauth/revoke`.

POST bodies use form encoding. Device polling honors the returned interval and original expiry, `authorization_pending`, `slow_down`, cancellation, and bounded backoff. Tokens require a nonempty access token and refresh token, `Bearer` token type, scope, and a positive expiry. Refresh rotates the complete token pair.

Browser authorization uses the server-returned verification URLs on the Qwen web origin. The design document's `/authorize` path and `client=qwen-code` parameter are illustrative, not required response fields: the official client validates both fields as URLs and returns them unchanged. A live device request returned same-origin verification URLs with a different path and no `client` parameter. The plugin preserves the supplied URL, requires matching base/complete paths and user codes, and rejects foreign origins, userinfo, fragments and unexpected or duplicate query parameters. Do not construct a fake success URL or treat website login as account activation.

The legacy `qwen-oauth` flow is different: it uses old endpoints, PKCE, and optional resource routing. Its source presence does not make the discontinued free service a supported target.

## Models and reasoning

The current gateway is `https://api.qwen.ai/compatible-mode/v1`. Model discovery is authenticated `GET /models`; inference uses OpenAI Chat Completions at `/chat/completions`.

The official model parser consumes IDs, not limits, prices, tool support, or reasoning capabilities. It accepts actual server-returned IDs rather than a predefined list. A forbidden response must not fall back to cached models. Unknown metadata must remain unknown.

Official subscription thinking mappings for `qwen3.8-max` and `qwen3.8-flash` are:

| Selection | `enable_thinking` | `thinking_budget` |
| --- | --- | --- |
| off | false | omitted |
| low | true | 4096 |
| medium | true | 16384 |
| high | true | 32768 |

Upstream `xhigh` and `max` collapse to the high budget, not distinct stronger modes. Conflicting `reasoning`, `reasoning_effort`, and nested thinking switches must not override this subscription mapping. Unknown model IDs must not receive speculative controls.

The upstream design records parameter acceptance for Max, not strict budget enforcement or Flash gateway acceptance. This project has not repeated those inference probes.

## Host transport limitation

Installed OpenCode 2.2.5 converts hook-returned Requests through a path that drops their redirect policy and signal. This was separately diagnosed during the Junie integration. Correct source-level request preparation does not establish safe end-to-end host dispatch. Production inference must remain blocked; metadata requests use a separately bounded direct fetch path.
