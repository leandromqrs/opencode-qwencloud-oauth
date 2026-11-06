# OpenCode QwenCloud OAuth

An unofficial OpenCode V2 integration for **[QwenCloud](https://home.qwencloud.com/)**, based on the official `@qwencloud/qwencloud-cli` 1.5.0 protocol.

> [!WARNING]
> The replacement targets QwenCloud. The initial repository history targeted the wrong service, Qwen Code subscription OAuth at `chat.qwen.ai`. Its old quota limitations and model metadata do not describe QwenCloud. Live login completion, account quota, and key provisioning remain unverified.

> [!CAUTION]
> Model inference remains blocked on the tested OpenCode 2.2.5 host, which drops HTTP-hook redirect and cancellation policies. No automatic host executable replacement or unsafe bypass is provided.

## What this project targets

- QwenCloud device authorization with PKCE and native OpenCode credential storage.
- Account model metadata from the authenticated QwenCloud management gateway.
- Actual Token Plan Credit observations, with personal, team and Credit Pack balances kept distinct.
- An independent, authenticated loopback adapter for the existing quota panel.
- Automatic inference-key provisioning is requested but **not implemented**: the CLI does not create a key at login, and the console's key-management operations have not been verified with CLI OAuth credentials. Existing keys must not be reset or replaced silently.

QwenCloud management OAuth and inference API keys are separate credentials. The CLI does not use its management access token directly as the inference API key. Login alone must not be advertised as proof that model inference is usable.

## Development

Requirements: Node.js 22+, npm, OpenCode 2.2.5, and a QwenCloud account.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The package is private. Build output, OAuth credentials, and adapter keys are not committed. Dependencies remain pinned to the tested OpenCode contract.

## Registration and login

After building, add this entry to the `plugins` array of your global or project `opencode.jsonc`, preserving existing entries:

```jsonc
{
  "package": "/absolute/path/to/opencode-qwencloud-oauth",
  "options": { "timeoutMs": 120000 }
}
```

Stable IDs are `opencode-qwencloud-oauth` for the plugin, `qwencloud-oauth` for the integration, `qwencloud` for the provider and RPC namespace, and `device` for the OAuth method.

```sh
opencode auth login qwencloud-oauth --method device
```

Approve only the authorization link presented by native OpenCode. Never paste tokens into chat. The plugin must not import the CLI's private login files.

## Quota and model metadata

Authenticated control-plane operations go to `cli.qwencloud.com`; they are not model inference. Token Plan quota is measured in **Credits**, not raw tokens or Junie credits. Display only observed values, preserving zero and separating absent data from failed requests.

Team aggregate balances must not be labeled as the current member's quota. Subscription expiration is not a quota reset. Free-tier allowances, Coding Plan windows, PAYG spending and configured spending limits are separate concepts, not substitutes for Token Plan balance.

The standalone adapter uses a dedicated `QWENCLOUD_QUOTA_ADAPTER_KEY`, not an OAuth token or inference API key. The planned loopback endpoint is `http://127.0.0.1:62366/quota`; no provider should be enabled before the adapter and the quota panel's service environment are validated.

## Security and evidence

- Fixed HTTPS destinations; no credential-bearing redirects or silent cross-plan fallback.
- PKCE verifier and device token remain private, including when sent as query parameters by the official protocol.
- Native credential storage only; no OAuth tokens or API keys in plugin metadata storage, logs, examples or the repository.
- No automatic purchases, upgrades, key resets or revocation of existing clients.
- Model visibility is not proof of inference entitlement or Token Plan inclusion.
- The QwenCloud replacement passed **58 tests**, strict TypeScript checking, production build and launcher syntax checks. Public device initialization returned HTTP 200; its production browser URL was verified without token polling or account authorization. These checks do not establish successful account login or inference.
- Dependency audit found 24 moderate findings and no high or critical findings before the replacement; no unverified dependency overrides were applied.

See [protocol provenance](docs/protocol-provenance.md) and [quota semantics](docs/quota.md).
