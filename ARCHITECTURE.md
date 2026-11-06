# Architecture

The package is an Effect-native OpenCode 2.2.5 plugin. It follows the official QwenCloud CLI's separation of management OAuth and inference keys; it does not reuse Qwen Code subscription auth.

## Components

```mermaid
flowchart TD
    Host[OpenCode] --> Plugin[Plugin registration and hooks]
    Credentials[(Native credential storage)] -. Management OAuth .-> Management[Discovery and quota]
    Credentials -. Separate inference key .-> Driver[Native Token Plan driver]
    Plugin --> Management
    Management --> API[QwenCloud management API]
    Management --> Cache[(Account-scoped catalog cache)]
    Cache --> Inventory[Published model inventory]
    Inventory -. Active catalog guard .-> Driver
    Plugin --> Driver
    Driver --> Validation[Final request validation]
    Validation --> Endpoint[Fixed Token Plan endpoint]
    Endpoint --> Stream[SSE response]
    Stream --> Host
    Lifetime[Scope-owned deadline and cancellation] -.-> Driver
    Lifetime -.-> Stream
```

- `src/index.ts`: native integrations, provider registration, RPC methods and account/catalog hooks.
- `src/oauth.ts`, `src/catalog.ts`: device authorization with PKCE, bounded management responses and model metadata validation.
- `src/discovery.ts`, `src/inventory.ts`: account-scoped catalog cache, invalidation and native model definitions.
- `src/driver.ts`, `src/transport.ts`: Token Plan chat driver, final request validation and stream-lifetime cancellation.
- `src/quota.ts`, `src/quota-adapter.ts`, `src/quota-bridge.ts`: BSS quota observations, native RPC access and an optional authenticated loopback listener.

## Credentials and storage

OpenCode owns both credential records: `qwencloud-oauth` for management and `qwencloud-api-key` for inference. The plugin never imports the CLI's private login files or provisions keys. A key's format or presence does not establish its owner or entitlement.

Plugin storage contains a device-client UUID and sanitized catalog metadata, not credentials. Cache records are partitioned by management connection and routing, with denial tombstones preventing revoked metadata from returning after reload. OAuth expiry requires signing in again; there is no supported refresh-token endpoint.

The optional quota adapter has a third, independent bearer key. It discovers OpenCode's authenticated loopback service and calls quota RPC for an explicit project location. See [quota setup](docs/quota.md) for its private key file and service scripts.

## Request flows

1. **Login:** `oauth.ts` talks to `https://t.qwencloud.com`, validates the browser/callback destinations, polls with PKCE and returns credentials to OpenCode. Disposing the authorization scope cancels polling.
2. **Management:** explicit catalog/quota reads use `https://cli.qwencloud.com/data/v2/api.json`. Account changes discard in-flight results; authorization denials invalidate cached models. Catalog/status reads restore metadata without upstream calls. RPC exposes `catalog`, `status`, `refresh` and `quota` under `qwencloud`.
3. **Chat:** the provider resolves only the separate native key. Its source connection is fenced to that key, while the HTTP hook verifies the selected model against the active management catalog. Neither check claims that the key belongs to the management account.
4. **Dispatch:** `driver.ts` wraps the native route with an operation-scoped `FetchHttpClient.Fetch`. After host HTTP-hook conversion, `prepareRequest` pins POST `/chat/completions`, validates the body model, replaces upstream headers and refuses redirects. The registered driver uses only `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`; the isolated PAYG helper is not a fallback.
5. **Lifetime:** a scope-owned controller/timer, retained requests and explicit response-reader cancellation enforce the deadline before headers and throughout SSE, even under garbage collection. Completion or interruption clears the timer and listeners. Do not replace this with a fetch-only timeout or global fetch patch.

`timeoutMs` is the only plugin option: 1,000–600,000 milliseconds, default 120,000. A separate internal `qwencloudTimeoutMs` survives the host's removal of native transport settings before provider-module construction.

## Quota boundaries

```mermaid
sequenceDiagram
    participant Consumer as Quota consumer
    participant Adapter as Optional loopback adapter
    participant RPC as Native quota RPC
    participant BSS as QwenCloud BSS
    Consumer->>Adapter: GET /quota with independent bearer key
    Adapter->>Adapter: Authenticate and validate request
    Adapter->>RPC: Query quota for explicit project location
    RPC->>BSS: QuerySubscriptionGray with management OAuth
    BSS-->>RPC: Routing observation
    RPC->>BSS: Read seat or legacy quota scopes
    BSS-->>RPC: Available values and failures
    RPC-->>Adapter: Quota observations with diagnostics
    Adapter-->>Consumer: Bounded quota-v1 response
```

BSS routing follows `QuerySubscriptionGray`: seat summary/addon or legacy personal/team/addon reads. Credits remain distinct from raw tokens, spending limits and Junie credits. Missing values, failures and partial results must not become zero or “not subscribed.” Team aggregate balances are not individual allocations; expiration is not a reset. Details and bounds are in [quota semantics](docs/quota.md).

The optional bridge binds IPv4 loopback, authenticates before quota access, rejects browser origins/duplicate authorization and bounds connections, payloads and request time. It is separate from plugin/project lifecycles and is not enabled by loading the plugin.

## Verification

Tests use synthetic credentials, mocked management responses and real loopback sockets. Driver coverage includes the lossy host conversion, fragmented SSE/tools/reasoning/usage, zero-request redirect sinks, socket closure before/during streaming, forced GC and compiled file-URL loading with separate AI/Effect copies. Catalog tests cover switching accounts, durable denials and storage failures; quota/adapter tests cover partial observations and hostile requests.

Local tests do not establish upstream entitlement. The recorded native checks reached the provider but returned purchase/quota errors, not successful generations. See [protocol provenance](docs/protocol-provenance.md) for dated evidence and official sources.
