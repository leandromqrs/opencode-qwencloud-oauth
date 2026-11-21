# OpenCode QwenCloud OAuth

An unofficial [QwenCloud](https://home.qwencloud.com/) plugin for OpenCode V2. Sign in to discover the models listed for your account, then connect a separate Token Plan API key to use them in OpenCode.

[Quick start](#quick-start) · [Quota and troubleshooting](#quota-and-troubleshooting) · [Development](#development)

> [!IMPORTANT]
> This is QwenCloud, not Qwen Code at `chat.qwen.ai`. OAuth reads management data; sending messages requires a separate Token Plan API key and available model quota.

## Quick start

Requires **Node.js 22+**, npm, a QwenCloud account, and OpenCode V2. The plugin pins the OpenCode 2.2.5 SDK; browser login and catalog refresh have also been verified on a 2.3.2 host.

1. Clone and build the plugin:

   ```sh
   git clone https://github.com/leandromqrs/opencode-qwencloud-oauth.git
   cd opencode-qwencloud-oauth
   npm ci --ignore-scripts
   npm run build
   ```

2. Append this entry to `plugins` in your project or global `opencode.jsonc`, preserving existing entries:

   ```json
   { "package": "/absolute/path/to/opencode-qwencloud-oauth" }
   ```

3. From a project that loads the plugin, start device login and open the authorization link:

   ```sh
   opencode auth login qwencloud-oauth --method device
   ```

4. The plugin fetches the account catalog automatically after connecting. If it needs to be refreshed manually, replace the path with a location that loads the plugin:

   ```sh
   opencode api post '/api/rpc/qwencloud/refresh?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
   ```

5. To send messages, select an existing Token Plan key or create one at [API Keys](https://home.qwencloud.com/api-keys), then enter it in OpenCode's native prompt:

   ```sh
   opencode auth login qwencloud-api-key
   ```

Keys stay in OpenCode's credential storage, not plugin settings. Never paste them into chat or commit them. Login does not create keys; missing quota never triggers purchases or PAYG fallback.

## Quota and troubleshooting

- **`session-expired`:** repeat device login and refresh the catalog. Management OAuth does not refresh automatically; leave your Token Plan API key unchanged.
- **`invalid-response` from management quota:** the plugin could not interpret the response. It does not mean your session expired or your balance is zero.
- **`cli-not-found` from Token Plan quota:** OpenCode cannot find the official Bailian CLI (`bl`). See the [quota guide](docs/quota.md) for CLI setup and the optional OpenCode Quota panel bridge.

Catalog visibility does not guarantee that your key can use a model. The [Token Plan notes](docs/token-plan.md) distinguish observed catalog metadata, documented additions, and live checks.

## Development

```sh
npm run typecheck
npm test
npm run build
```

[Architecture](ARCHITECTURE.md) · [Configuration examples](examples) · [Protocol evidence](docs/protocol-provenance.md)
