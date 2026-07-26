# Contributing

Thanks for considering it. Hearsay is small on purpose; these rules keep it that way.

## The first law: zero runtime dependencies

`package.json` has no `dependencies` field and every import resolves to a `node:`
builtin or a relative path. That is the product, not an implementation detail — it is
what makes `git clone && node server.js` the whole install story.

**Pull requests that add a runtime dependency are declined, with thanks.** This
includes "just one tiny package". If the feature is impossible without a dependency,
open an issue first and expect the answer to be a hand-rolled subset (see
`web/pages/methodology.js` for the house style: implement exactly the slice you need,
document why). CI and dev scripts may use dev tooling (`typescript`, `playwright`)
installed with `--no-save`; the shipped app never needs `npm install`.

## Running and testing

- Node.js ≥ 22.13 (built-in `node:sqlite`).
- Run the app: `node server.js` (demo data: `node scripts/seed.js` first).
- Run the tests: `node --test` — all of them, every PR. No live network in tests:
  providers are exercised through fixtures in `test/fixtures/`.
- Typecheck: `npm run typecheck` must be clean.

## Code style

- **Plain modern ESM JavaScript with JSDoc types.** No TypeScript sources, no build
  step. `// @ts-ignore` stays rare (≤5 in the whole repo).
- **`core/analyze.js`, `core/metrics.js` and `web/svg.js` stay pure** — no I/O, no
  `Date.now()` inside; timestamps are passed in.
- **Storage is UTC ISO-8601**; local time appears only at render.
- **Every rate displayed carries its n** (and a CI where the spec calls for one). No
  naked percentages, ever.
- Copy rules: no blended "AI visibility score", no rank positions, no prompt-volume
  estimates, no flat dollar figures about Hearsay's own cost — these refusals are
  documented product decisions (see METHODOLOGY.md), not gaps to fill.

## Good first issues

The friendliest places to contribute, in rough order of effort:

- **Prompt-pack additions** — new generic intent/paraphrase templates for the
  suggested-prompts pack (`core/suggest.js`); pure data plus a test.
- **Translations of the suggested prompts** — same pack, other languages.
- **Provider adapters** — a new engine behind the common contract in
  `core/providers/shared.js`, with fixtures for success, 401, 429 and timeout. Look at
  `core/providers/perplexity.js` for the smallest complete example.

Issues labeled `good first issue` track specific instances of all three.
