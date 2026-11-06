# Contributing

Use Node.js 22+, npm and the pinned OpenCode 2.2.5 contracts. The package is private; development and tests do not require a real account or API key.

## Setup and checks

1. Install dependencies:

   ```sh
   npm ci
   ```

2. Run relevant tests while editing. For inference changes:

   ```sh
   npx tsx --test test/driver.test.ts test/transport.test.ts
   ```

   Use `test/discovery.test.ts` and `test/plugin.test.ts` for account/registration changes, or `test/quota*.test.ts` for quota/adapter work.

3. Before submitting, run the acceptance checks once after reconciling changes:

   ```sh
   npm run typecheck
   npm test
   npm run build
   git diff --check
   ```

Build output goes to ignored `dist/`. Do not edit generated files. There is no separate lint command.

## Change expectations

- Reproduce bugs with focused tests before fixing them. Use synthetic credentials and real loopback fixtures for network behavior; preserve GC and compiled-module coverage.
- Keep refactoring separate from new behavior. Prefer readable names and small diffs over compressed code; do not remove cancellation, validation or account guards to reduce line count.
- Review assertions experimentally: temporarily mutate one relevant condition in an isolated copy, confirm the test fails, then discard the mutation. Never submit a mutation, skipped test or weakened assertion.
- Explain the problem, solution and verification in the change description. Flag untested behavior and dependency changes; use atomic Conventional Commits with English imperative subjects if commits are requested.
- Update [architecture](ARCHITECTURE.md) for changed boundaries and [protocol provenance](docs/protocol-provenance.md) for protocol evidence. Keep the README focused on setup.

## Security

Never include real OAuth tokens, API/adapter keys, device codes, full authorization URLs or private credential files in code, fixtures, screenshots or reports. Supply inference keys only through OpenCode's native prompt. The optional adapter key is separate from both provider credentials.

Ask before live inference, provisioning, purchases, global configuration/service changes or host reloads. Do not repeat quota-exhausted calls or add automatic alternate-plan fallback. Successful dispatch, model visibility and entitlement are different claims.

Report security issues with a synthetic reproduction and redacted output; do not publish working credentials or exploitable private endpoints. See [agent guardrails](AGENTS.md) and [quota semantics](docs/quota.md) before changing those paths.
