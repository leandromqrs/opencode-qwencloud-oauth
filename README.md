# OpenCode Qwen Code OAuth

An experimental, unofficial Qwen Plus/Pro integration for OpenCode V2, using the current Qwen Code subscription OAuth protocol.

> [!CAUTION]
> **Inference is blocked on the currently tested OpenCode 2.2.5 host.** Its HTTP hook conversion drops plugin-supplied redirect and cancellation settings. The plugin must reject model requests until a corrected transport is implemented and verified. Signing in and querying model metadata do not establish safe inference.

> [!IMPORTANT]
> The current official Qwen Code client does not expose a supported remaining-quota or balance endpoint. The quota integration reports that limitation as a **status**, not a credit balance, percentage, allocation, or reset. Historical free-tier allowances and local CLI usage statistics are not account quota.

## Scope

- Current **Qwen Account with Subscription** OAuth for Plus/Pro accounts.
- OpenCode-managed credentials; no importing Qwen CLI token files.
- Authenticated account model discovery, with account-scoped durable metadata storage.
- Native OpenAI-compatible **Chat Completions**, not Responses, with documented Qwen thinking controls where applicable.
- An optional, independently managed quota panel adapter that reports quota availability honestly.

This is not Alibaba ModelStudio, DashScope Coding Plan, Token Plan, or the discontinued legacy free Qwen OAuth product. It does not run the Qwen Code agent inside OpenCode.

## Development setup

Requirements: Node.js 22+, npm, OpenCode 2.2.5, and an active Qwen Plus or Pro subscription.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

### Register and sign in

Add this entry to the `plugins` array in your global or project `opencode.jsonc`, preserving existing entries:

```jsonc
{
  "package": "/absolute/path/to/opencode-qwen-code-oauth",
  "options": { "timeoutMs": 120000 }
}
```

Build before registration, then use native authentication:

```sh
opencode auth login qwen-code-oauth --method device
```

Complete the authorization URL shown by OpenCode. The plugin honors the server's device-code expiry and cancels polling when authorization is cancelled or its scope closes. It does not import an existing Qwen CLI login.

### Discover account models

Use an explicit location whose configuration loads the plugin; the API CLI may otherwise target Home rather than the shell directory:

```sh
opencode api post '/api/rpc/qwen-code/refresh?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
opencode api post '/api/rpc/qwen-code/status?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
opencode api post '/api/rpc/qwen-code/catalog?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
opencode api post '/api/rpc/qwen-code/quota?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
```

Refresh performs authenticated metadata requests, not inference. It publishes only returned IDs under `qwen-code/<model-id>`. Startup and 15-second cross-location synchronization restore local metadata without resolving credentials or making upstream requests. Refresh metadata explicitly when needed; freshness becomes stale after 24 hours.

The final local validation passed **40 tests**, strict TypeScript checking, the production build, and launcher syntax checks. Real login and account discovery are not yet validated for this project. Do not interpret mocked driver tests or protocol research as verified inference.

## Authentication and discovery contract

The stable integration ID is `qwen-code-oauth`; the provider ID is `qwen-code`. The intended display name is **Qwen Code**. The package is `opencode-qwen-code-oauth`.

The current subscription protocol uses device authorization through `auth.qwen.ai`, browser approval at `chat.qwen.ai`, and the fixed `api.qwen.ai/compatible-mode/v1` gateway. It does not use the legacy OAuth client's PKCE or `resource_url` routing.

Discovery must use the active native connection and the actual `/models` response. It must not advertise an illustrative model as account entitlement. Persist only whitelisted metadata, scoped to the connection and routing; reject late results after account changes. Cache restoration must not perform startup HTTP requests or wait on native activation readiness.

No real account authorization, catalog retrieval, or inference has been performed for this project yet.

## Quota panel

The existing quota plugin accepts a custom remote provider returning `quota-v1`. A standalone loopback adapter can forward the plugin's native quota-status RPC without exposing Qwen OAuth credentials or tying its TCP listener to a project lifecycle.

The Qwen adapter uses its own key, `QWEN_CODE_QUOTA_ADAPTER_KEY`, and port **62366** by default. It does not share the Junie adapter's key, port, provider ID, or credit conversion rules. No provider is enabled automatically before validation.

After building and preparing an owner-private key file, launch it with an explicit OpenCode location:

```sh
bash scripts/quota-adapter.sh start --location /absolute/project
bash scripts/quota-adapter.sh status
bash scripts/quota-adapter.sh stop
```

Use `run` instead of `start` for a foreground process. Optional flags are `--port` and `--key-file`. The default key file is `$XDG_CONFIG_HOME/opencode/qwen-code/quota-adapter.key`, or `~/.config/opencode/qwen-code/quota-adapter.key`; it must be an owned regular file with mode `0400` or `0600`, not a symlink. Never reuse an OAuth token as the adapter key.

The transient user service is `opencode-qwen-code-quota-adapter.service`. It survives project reloads but is not enabled at boot. The quota panel's separate process must have access to the same adapter key through its configured environment variable. See the disabled [custom-provider example](examples/quota-bridge.json).

Expected result: a status such as **Quota not exposed by Qwen Code**, rather than invented remaining credits. A public supported quota API, if introduced later, requires a separately verified contract.

## Security and evidence

- Fixed HTTPS auth and gateway destinations, redirects rejected, bounded timeouts and response sizes.
- Server-supplied browser URLs validated before presentation.
- Device codes, access tokens, refresh tokens, raw response errors, and identity fields excluded from logs and evidence.
- Native OAuth cancellation closes polling; token refresh requires the complete rotated token pair.
- Refresh single-flight is local to a plugin instance; native OpenCode owns credential persistence and cross-instance coordination. A catalog HTTP 401 invalidates cached metadata and fails closed rather than rotating an unexpired credential outside native storage. Sign in again if needed. Native logout does not send remote token revocation.
- Forbidden metadata is replaced by a durable account-scoped denial marker and invalidation notification. If both storage writes and deletion fail, only locations receiving the event can observe that denial; filtered events and a complete storage outage prevent guaranteed cross-location invalidation. A location retaining a denial requires its own successful explicit refresh to recover.
- No automatic inference, remote endpoint probing, forced subscription changes, or host executable replacement.
- Dependency audit reported **24 moderate findings**, no high or critical findings. The two underlying advisories concern `glob` cancellation and `minimatch` denial of service, propagated through dependency chains including `@opencode/plugin` tooling. Several chains have no available fix under the pinned host dependency graph. Runtime exploitability has not been established; no automatic fixes or unverified overrides were applied.

The protocol baseline is official Qwen Code **v0.26.8**, commit `21ed8f1efbb351b973d96e2bc9efa78f278df99c`. See [protocol provenance](docs/protocol-provenance.md) and [quota limitations](docs/quota.md).
