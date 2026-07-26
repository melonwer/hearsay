# Contributing

Written in full in Phase 3 (§16). The rules that already bind this codebase:

- **Zero runtime dependencies.** `package.json` has no `dependencies` field and every
  import resolves to a `node:` builtin or a relative path. Pull requests that add a
  runtime dependency are declined; CI may install dev tooling only.
- **Plain modern ESM JavaScript with JSDoc types.** No TypeScript sources, no build step.
  `npm run typecheck` must be clean, and `// @ts-ignore` stays rare (≤5 in the repo).
- **`core/analyze.js`, `core/metrics.js` and `web/svg.js` stay pure** — no I/O, no
  `Date.now()` inside; timestamps are passed in.
- **Tests:** `node:test` + `node:assert`, run with `node --test test/`. No live network in
  tests: providers are exercised through fixtures.
- **Storage is UTC ISO-8601**; local time only at render.
- **Every rate displayed carries its n.**
