# Agent instructions

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing credential routing, discovery or streaming. This private TypeScript/ESM package targets OpenCode 2.2.5 and Node.js 22+; source imports use `.js` extensions.

## Working commands

```sh
npm ci
npm run typecheck
npx tsx --test test/driver.test.ts test/transport.test.ts
```

Choose focused tests for the files changed. Before handoff, run `npm test`, `npm run build` and `git diff --check`, unless a coordinating session owns those final checks. There is no configured lint command.

## Invariants

- Keep OAuth management and native inference-key integrations separate. Do not read private credential files, print secrets or add secret-bearing RPC/config fields.
- Preserve account-bound cache invalidation, denial tombstones, key source fencing and the active-catalog HTTP guard. Model visibility is not inference entitlement.
- Keep final-fetch request validation, fixed destinations, redirect refusal and no automatic PAYG fallback. Keys are bounded opaque printable strings; do not restrict their punctuation beyond the existing validator.
- Retain the driver's scope-owned timer/controller, strong request references and response-reader cancellation. Run the forced-GC regression and compiled-loader test after transport changes; preserve the portable return annotation on `model`.
- Preserve explicit zero, missing/partial/error quota states and separate personal/team/addon scopes. Do not weaken tests or native schema validation to make checks pass.

## Scope and evidence

Keep changes small and behavior-preserving unless asked otherwise. Add comments only for non-obvious contracts or reasons; remove obsolete comments, not security rationale. Keep documentation in English and detailed protocol evidence outside the README.

Live calls, key creation, purchases, global configuration/service changes and host reloads require explicit authorization. Use synthetic credentials and loopback fixtures by default. Do not claim a successful generation from a purchase/quota error. Report exact checks and limitations; never commit or push without a request.
