# OpenCode QwenCloud OAuth

Unofficial [QwenCloud](https://home.qwencloud.com/) integration for OpenCode V2: browser login, account model discovery, Token Plan chat and read-only quota.

> [!IMPORTANT]
> This is QwenCloud, not Qwen Code at `chat.qwen.ai`. OAuth reads management data; sending messages requires a separate Token Plan API key and available model quota.

## Setup

Requires **Node.js 22+, npm and OpenCode 2.2.5**.

1. Build this checkout:

   ```sh
   npm ci
   npm run build
   ```

2. Append this entry to `plugins` in your project or global `opencode.jsonc`, preserving existing entries:

   ```json
   { "package": "/absolute/path/to/opencode-qwencloud-oauth" }
   ```

3. Sign in through the authorization link shown by OpenCode:

   ```sh
   opencode auth login qwencloud-oauth --method device
   ```

4. Fetch the account catalog, replacing the path with a location that loads the plugin:

   ```sh
   opencode api post '/api/rpc/qwencloud/refresh?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
   ```

5. Create a Token Plan key at [API Keys](https://home.qwencloud.com/api-keys), then enter it in OpenCode's native prompt:

   ```sh
   opencode auth login qwencloud-api-key
   ```

Keys stay in OpenCode's credential storage, not plugin settings. Never paste them into chat or commit them. Login does not create keys; missing quota never triggers purchases or PAYG fallback.

## Status and details

Account discovery and native request dispatch have been verified. Live checks returned purchase/quota errors, **not a completed generation**. A listed model is not proof of entitlement; an unrecognized quota response is not zero balance.

[Architecture](ARCHITECTURE.md) · [Agent instructions](AGENTS.md) · [Contribution guide](CONTRIBUTING.md) · [Quota adapter](docs/quota.md) · [Protocol and verification evidence](docs/protocol-provenance.md)
