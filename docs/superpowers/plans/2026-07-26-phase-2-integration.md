# Hearsay Phase 2 — Integration + Agent-Surface API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete master-plan §19 Phase 2 (end-to-end integration, e2e tests, polish gates) plus the Phase-2 portion of the approved agent-surface spec (`docs/superpowers/specs/2026-07-26-agent-surface-design.md`): 4 new API endpoints, the run cost gate, and the suggest starter-pack fallback.

**Architecture:** All new endpoints are handlers in `web/pages/api.js` registered via the existing `registerApiRoutes(router, deps)` table, throwing `ApiError` into the existing `json()` envelope wrapper. Statistics still come only from `core/metrics.js`/`core/cost.js` through `web/data.js` (`soft`/`strict`). No core-module (§4–§9) contract changes.

**Tech Stack:** Node ≥22.5 built-ins only — `node:http`, `node:sqlite`, `node:test`. Zero npm dependencies (hard gate, §19.6 #1).

## Global Constraints

- **Zero runtime npm dependencies.** `package.json` must never gain a `dependencies` key (§19.6 #1).
- Plain ESM JavaScript with JSDoc types; `npm run typecheck` (`tsc --noEmit`, checkJs strict) must stay green; ≤5 `@ts-ignore` repo-wide (§17).
- Error envelope: success = the object itself; error = `{"error":{"code","message"}}` with matching HTTP status (§10.3).
- Timestamps UTC ISO-8601 via `isoNow()` from `core/db.js` (§19.6 #4).
- Secrets: API keys never in DB, logs, exports, error messages, or any API response — masked or not (§19.6 #9).
- Cost figures only ever come from `core/cost.js` output — no hardcoded dollar amounts (§19.6 #13).
- No live network in tests; provider fetch is stubbed via `_setFetch()` from `core/providers/shared.js` (§15).
- The spec for every shape in this plan: `docs/superpowers/specs/2026-07-26-agent-surface-design.md` (referred to below as SPEC). If a helper name in this plan differs from what Phase 1 actually shipped, follow the file's existing idiom — **the HTTP contract in SPEC is binding, internal names are not.**
- Commit after every task (small, descriptive commits).

---

### Task 1: Phase 1 exit gate — do not start until this passes

**Files:** none modified.

- [ ] **Step 1: Verify no Phase 1 stubs remain**

Run: `rg -n "skip: 'Phase 1" test/`
Expected: **no matches**. If `router.test.js` or `seed.test.js` still carry `{ skip: 'Phase 1 …' }` stubs, Phase 1 is not finished — stop and finish Phase 1 first. (`e2e.test.js`'s Phase 2 stub is ours to replace, in Task 10.)

- [ ] **Step 2: Verify the suite and typecheck are green**

Run: `node --test && npm run typecheck`
Expected: all tests pass, typecheck clean. Fix nothing here; if red, Phase 1 owns it.

---

### Task 2: `HEARSAY_CONFIRM_USD` in config

**Files:**
- Modify: `core/config.js` (`buildConfig`, `Config` typedef)
- Modify: `.env.example`
- Test: `test/api.test.js` (new file, harness built here and reused by Tasks 3–9)

**Interfaces:**
- Produces: `config.confirmUsd: number` (float ≥ 0, default 1) — consumed by Task 5's run gate.
- Produces: `test/api.test.js` `boot(env)` helper — `{ base, db, close }` around `startServer({port: 0})` — consumed by every later task's tests.

- [ ] **Step 1: Write the failing tests**

Create `test/api.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';
import { buildConfig } from '../core/config.js';

/** Boot a server on an ephemeral port with a throwaway DB. */
export async function boot(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-api-'));
  const config = buildConfig({ HEARSAY_DB_PATH: join(dir, 'test.db'), ...env });
  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath: config.dbPath, config });
  return { ...app, base: `http://127.0.0.1:${app.port}`, config };
}

/** JSON request helper. Returns {status, body}. */
export async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('config: HEARSAY_CONFIRM_USD parses as float >= 0, default 1', () => {
  assert.equal(buildConfig({}).confirmUsd, 1);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: '0' }).confirmUsd, 0);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: '2.5' }).confirmUsd, 2.5);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: 'garbage' }).confirmUsd, 1);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: '-3' }).confirmUsd, 1);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/api.test.js` → FAIL (`confirmUsd` undefined).

- [ ] **Step 3: Implement**

In `core/config.js`, inside the object returned by `buildConfig`, after `demo`:

```js
confirmUsd: floatIn(env.HEARSAY_CONFIRM_USD, 1, 0),
```

Add next to the existing `intIn` helper (same style):

```js
/**
 * @param {string|undefined} raw @param {number} fallback @param {number} min
 * @returns {number}
 */
function floatIn(raw, fallback, min) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n >= min ? n : fallback;
}
```

Add `confirmUsd: number` to the `Config` typedef with the comment: `Run-cost confirm threshold in USD (SPEC §3.3); 0 = every run quotes first.`

In `.env.example`, under the sampling-design section:

```
# Runs estimated above this many dollars (or >200 calls, or with unknown cost) return a
# cost quote first and need {"confirm":true} to start. 0 = always quote first.
HEARSAY_CONFIRM_USD=1
```

- [ ] **Step 4: Run to verify pass** — `node --test test/api.test.js` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git add core/config.js .env.example test/api.test.js && git commit -m "feat: HEARSAY_CONFIRM_USD threshold in config"`

---

### Task 3: API plumbing — `WithStatus` and `version` in deps

**Files:**
- Modify: `web/pages/api.js` (`json()` wrapper, `ApiDeps` typedef)
- Modify: `server.js` (`buildRouter`)
- Test: `test/api.test.js`

**Interfaces:**
- Produces: `export class WithStatus { constructor(status, body) }` in `web/pages/api.js` — a handler that returns `new WithStatus(202, data)` gets that status instead of `json()`'s default. Consumed by Tasks 5 and 8.
- Produces: `ApiDeps` gains `version: string`; `buildRouter` passes `version: VERSION` to `registerApiRoutes`. Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

```js
test('plumbing: /api/status route exists and echoes the package version', async () => {
  const app = await boot();
  const { status, body } = await api(app.base, 'GET', '/api/status');
  assert.equal(status, 200);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
  await app.close();
});
```

(Fails until Task 6 lands the full handler; the plumbing makes it *possible*. Keep the test — it goes green in Task 6; `node --test` accepts an expected-fail marker meanwhile: write it with `test(..., { todo: true }, ...)` and remove `todo` in Task 6.)

- [ ] **Step 2: Implement**

In `web/pages/api.js`:

```js
/** Lets a handler pick its own success status inside the json() wrapper (SPEC §3.3). */
export class WithStatus {
  /** @param {number} status @param {unknown} body */
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}
```

In `json()`, after `const data = await handler(ctx);`:

```js
if (data instanceof WithStatus) {
  sendJson(ctx.res, data.status, data.body);
  return;
}
```

Add `@property {string} version` to the `ApiDeps` typedef. In `server.js` `buildRouter`, change the API registration line to `registerApiRoutes(router, { db, config, version: VERSION });`.

- [ ] **Step 3: Verify** — `node --test test/api.test.js` (todo test tolerated) and `npm run typecheck` clean.
- [ ] **Step 4: Commit** — `git commit -m "feat: WithStatus + version plumbing in api deps" -- web/pages/api.js server.js test/api.test.js`

---

### Task 4: `GET /api/runs/latest` → 404 `no_runs` on empty history

**Files:**
- Modify: `web/pages/api.js` (runs/latest registration)
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `latestRun(db)` from `web/queries.js` (returns object or `null`).
- Produces: SPEC §3.3 clarification — `404 {"error":{"code":"no_runs",…}}` instead of a bare `null` 200.

- [ ] **Step 1: Failing test**

```js
test('runs/latest: 404 no_runs when no run has ever happened', async () => {
  const app = await boot();
  const { status, body } = await api(app.base, 'GET', '/api/runs/latest');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'no_runs');
  await app.close();
});
```

- [ ] **Step 2: Verify FAIL** — currently returns `200` with `null` body.
- [ ] **Step 3: Implement** — replace the route body:

```js
router.add(
  'GET',
  '/api/runs/latest',
  json(() => {
    const run_ = latestRun(db);
    if (run_ === null) throw new ApiError(404, 'no_runs', 'No panel runs yet');
    return run_;
  }),
);
```

- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat: 404 no_runs for empty run history" -- web/pages/api.js test/api.test.js`

---

### Task 5: `POST /api/run` cost gate (quote-then-confirm)

**Files:**
- Modify: `web/pages/api.js` (`startRun`, its registration)
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `costEstimate(deps)` (same file), `config.confirmUsd` (Task 2), `WithStatus` (Task 3), `_setFetch` from `core/providers/shared.js`.
- Produces: SPEC §3.3 contract — `200 quote_required` | `202 {runId, estUsd}` | `409` with progress numbers in the message | `400 demo_mode`.

- [ ] **Step 1: Failing tests**

```js
import { _setFetch } from '../core/providers/shared.js';

/** Minimal live-ish fixture: one entity, one prompt, one fake-keyed provider. */
async function bootRunnable(env = {}) {
  const app = await boot({ OPENAI_API_KEY: 'test-key-not-real', HEARSAY_SAMPLES: '1', ...env });
  await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true, domains: ['acme.example'] });
  await api(app.base, 'POST', '/api/prompts', { text: 'best acme-like tool?' });
  _setFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: 'Try Acme.' } }], usage: { prompt_tokens: 5, completion_tokens: 5 }, model: 'stub' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  return app;
}

test('run gate: below threshold starts immediately with 202 + runId', async () => {
  const app = await bootRunnable({ HEARSAY_CONFIRM_USD: '999' });
  const { status, body } = await api(app.base, 'POST', '/api/run', {});
  assert.equal(status, 202);
  assert.equal(typeof body.runId, 'number');
  await app.close();
});

test('run gate: HEARSAY_CONFIRM_USD=0 always quotes; confirm:true starts', async () => {
  const app = await bootRunnable({ HEARSAY_CONFIRM_USD: '0' });
  const quote = await api(app.base, 'POST', '/api/run', {});
  assert.equal(quote.status, 200);
  assert.equal(quote.body.status, 'quote_required');
  assert.equal(typeof quote.body.calls, 'number');
  assert.ok(Array.isArray(quote.body.perProvider));
  // a quote must not have created a run
  assert.equal((await api(app.base, 'GET', '/api/runs/latest')).status, 404);
  const go = await api(app.base, 'POST', '/api/run', { confirm: true });
  assert.equal(go.status, 202);
  await app.close();
});

test('run gate: unknown model cost quotes even below call threshold', async () => {
  const app = await bootRunnable({ OPENAI_MODEL: 'mystery-model-9000', HEARSAY_CONFIRM_USD: '999' });
  const { status, body } = await api(app.base, 'POST', '/api/run', {});
  assert.equal(status, 200);
  assert.equal(body.status, 'quote_required');
  assert.equal(body.estUsd, null);
  await app.close();
});
```

Cleanup: restore the real fetch in an `after` hook (`_setFetch(globalThis.fetch)` or the module's documented reset — follow how `test/providers.test.js` does it).

- [ ] **Step 2: Verify FAIL** — today every POST /api/run is 202 and ignores the body.
- [ ] **Step 3: Implement** — rewrite `startRun` (keep the existing start mechanics verbatim from the current implementation for the "start" branch):

```js
/**
 * SPEC §3.3: demo → 400; running → 409 with progress; over-threshold or unknown
 * cost without confirm → 200 quote; otherwise start → 202.
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {Promise<WithStatus>}
 */
async function startRun({ db, config }, ctx) {
  if (config.demo) {
    throw new ApiError(400, 'demo_mode', 'Demo mode is on, so live provider calls are disabled. Set HEARSAY_DEMO=0.');
  }
  const running = get(db, "SELECT id, done_calls, total_calls FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  if (running) {
    throw new ApiError(409, 'already_running', `Run ${running.id} in progress: ${running.done_calls}/${running.total_calls} calls done`);
  }
  if (typeof (/** @type {*} */ (runner).runPanel) !== 'function') throw new NotReadyError('runPanel');

  const body = ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? /** @type {Record<string, unknown>} */ (ctx.body) : {};
  const confirm = body.confirm === true;
  const estimate = costEstimate({ db, config });
  const needsQuote =
    !confirm &&
    (config.confirmUsd === 0 || estimate.estUsd === null || estimate.estUsd > config.confirmUsd || estimate.calls > 200);
  if (needsQuote) {
    return new WithStatus(200, {
      status: 'quote_required',
      calls: estimate.calls,
      estUsd: estimate.estUsd,
      perProvider: estimate.perProvider,
      confirmHint: 'POST /api/run with {"confirm":true} to start',
    });
  }

  // …existing start mechanics from the current startRun (fire runPanel({trigger:'api'}),
  // swallow-and-log rejection, setImmediate tick, read back the running row)…
  return new WithStatus(202, { runId: started ? Number(started.id) : null, estUsd: estimate.estUsd });
}
```

Registration becomes `json((ctx) => startRun(deps, ctx))` (drop the fixed `202` — `WithStatus` now carries it). Check `web/router.js` body parsing: if it rejects a body-less POST or non-JSON POST with 415, keep sending `{}` from callers (UI/CLI/MCP always send JSON) and note it in the route comment.

- [ ] **Step 4: Verify PASS** — `node --test test/api.test.js`; run full `node --test` (the runner/e2e neighbours must stay green).
- [ ] **Step 5: Commit** — `git commit -m "feat: server-side quote-then-confirm cost gate on /api/run" -- web/pages/api.js test/api.test.js`

---

### Task 6: `GET /api/status`

**Files:**
- Modify: `web/pages/api.js`
- Test: `test/api.test.js` (un-`todo` the Task 3 test, add the ones below)

**Interfaces:**
- Consumes: `PROVIDER_IDS` from `core/config.js`; `listEntities`, `brandEntity`, `activePromptCount`, `latestRun` from `web/queries.js`; `soft(metrics,'actualSpend',…)`; `deps.version` (Task 3).
- Produces: SPEC §3.1 shape, consumed later by the Phase 3 MCP `hearsay_status` tool.

- [ ] **Step 1: Failing tests**

```js
test('status: empty DB → configured:false, zero counts, null lastRun, no key material', async () => {
  const app = await boot({ OPENAI_API_KEY: 'sk-super-secret-value' });
  const { status, body } = await api(app.base, 'GET', '/api/status');
  assert.equal(status, 200);
  assert.equal(body.configured, false);
  assert.deepEqual(body.counts, { entities: 0, intents: 0, activePrompts: 0 });
  assert.equal(body.lastRun, null);
  assert.equal(body.providers.find((p) => p.id === 'openai').enabled, true);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('sk-super-secret-value') && !raw.includes('apiKey') && !raw.includes('maskedKey'));
  await app.close();
});

test('status: configured flips true with a brand and an active prompt', async () => {
  const app = await boot();
  await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true });
  await api(app.base, 'POST', '/api/prompts', { text: 'best acme-like tool?' });
  const { body } = await api(app.base, 'GET', '/api/status');
  assert.equal(body.configured, true);
  assert.equal(body.counts.activePrompts, 1);
  await app.close();
});
```

- [ ] **Step 2: Verify FAIL** (404 today).
- [ ] **Step 3: Implement**

```js
import { PROVIDER_IDS } from '../../core/config.js';

/**
 * SPEC §3.1 — orientation endpoint; must work on an empty DB. Never includes key
 * material in any form (§19.6 #9): providers are re-shaped to four safe fields.
 * @param {ApiDeps} deps
 */
function statusReport({ db, config, version }) {
  const brand = brandEntity(db);
  const activePrompts = activePromptCount(db);
  return {
    version,
    demo: config.demo,
    configured: brand !== null && activePrompts > 0,
    providers: PROVIDER_IDS.map((id) => {
      const p = config.providers[id];
      return { id: p.id, label: p.label, model: p.model, enabled: p.enabled };
    }),
    counts: {
      entities: listEntities(db).length,
      intents: Number(get(db, 'SELECT COUNT(*) AS n FROM intents')?.n ?? 0),
      activePrompts,
    },
    schedule: { runAt: config.runAt, schedulerEnabled: !config.demo && config.enabledProviders.length > 0 },
    lastRun: latestRun(db),
    spend30dUsd: Number(soft(/** @type {*} */ (metrics), 'actualSpend', { db, days: 30 }, null)?.totalUsd ?? 0),
  };
}
```

Register: `router.add('GET', '/api/status', json(() => statusReport(deps)));`

- [ ] **Step 4: Verify PASS**, typecheck clean.
- [ ] **Step 5: Commit** — `git commit -m "feat: GET /api/status orientation endpoint" -- web/pages/api.js test/api.test.js`

---

### Task 7: `GET /api/intents/results` + `GET /api/prompts/results`

**Files:**
- Modify: `web/pages/api.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `strict(metrics, 'intentTable', {db, days})` and `strict(metrics, 'promptTable', {db, days})` (§7 shapes are the contract).
- Produces: the backing routes for Phase 3's `hearsay_intent_results` / `hearsay_prompt_results` (SPEC §3.5).

- [ ] **Step 1: Failing tests**

```js
test('results routes: arrays with days validation', async () => {
  const app = await boot();
  for (const path of ['/api/intents/results', '/api/prompts/results']) {
    const ok = await api(app.base, 'GET', path);
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body));
    const bad = await api(app.base, 'GET', `${path}?days=0`);
    assert.equal(bad.status, 400);
  }
  await app.close();
});
```

- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Implement** (mirror the `/api/gap` registration exactly):

```js
router.add(
  'GET',
  '/api/intents/results',
  json((ctx) => strict(/** @type {*} */ (metrics), 'intentTable', { db, days: intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 365) })),
);
router.add(
  'GET',
  '/api/prompts/results',
  json((ctx) => strict(/** @type {*} */ (metrics), 'promptTable', { db, days: intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 365) })),
);
```

Route-order check: `web/router.js` matches `:param` segments, so `/api/intents/results` must be registered **before** any `/api/intents/:id` GET could shadow it (today only PATCH has `:id` — verify and add a comment).

- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat: intent/prompt results read routes" -- web/pages/api.js test/api.test.js`

---

### Task 8: suggest starter-pack fallback

**Files:**
- Modify: `web/pages/api.js` (`suggestPrompts`)
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `starterPack` from `core/suggest.js` via the `suggest` namespace in `web/data.js`.
- Produces: SPEC §3.4 — `200 {source:'starter-pack'|'llm', intents:[…]}`; the `no_provider_key` 400 path is deleted.

- [ ] **Step 1: Failing test**

```js
test('suggest: zero keys → 200 starter pack, nothing persisted', async () => {
  const app = await boot(); // no provider keys
  const before = (await api(app.base, 'GET', '/api/prompts')).body.length;
  const { status, body } = await api(app.base, 'POST', '/api/prompts/suggest', {});
  assert.equal(status, 200);
  assert.equal(body.source, 'starter-pack');
  assert.ok(Array.isArray(body.intents) && body.intents.length > 0);
  assert.ok(body.intents.every((i) => typeof i.label === 'string' && Array.isArray(i.paraphrases)));
  assert.equal((await api(app.base, 'GET', '/api/prompts')).body.length, before);
  await app.close();
});
```

- [ ] **Step 2: Verify FAIL** — today this is `400 no_provider_key`.
- [ ] **Step 3: Implement** — in `suggestPrompts`, replace the zero-provider throw:

```js
if (config.enabledProviders.length === 0) {
  // SPEC §3.4: never a dead end — same §20.3 pack the wizard uses, still draft-only.
  const pack = strict(/** @type {*} */ (suggest), 'starterPack', args);
  return { source: 'starter-pack', intents: /** @type {*} */ (pack)?.intents ?? pack };
}
```

(Move the `args` construction above the branch so both paths share it.) Wrap the LLM path's return the same way: `return { source: 'llm', intents: (result)?.intents ?? result };`. If `/setup`'s wizard page code branched on the old 400, update it to branch on `source` instead (grep: `rg -n "no_provider_key" web/`).

- [ ] **Step 4: Verify PASS**, plus existing `suggest.test.js` stays green.
- [ ] **Step 5: Commit** — `git commit -m "feat: starter-pack fallback for /api/prompts/suggest" -- web/pages/api.js web/pages/setup.js test/api.test.js`

---

### Task 9: `POST /api/setup` — transactional bulk create/append

**Files:**
- Modify: `web/pages/api.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `str/strList/checkAliases/normaliseDomain/assertDomainsFree/idParam` helpers (same file); `transaction/get/run/isoNow` from `core/db.js`; `containsAlias`, `aliasesFor` from `core/analyze.js`; `PROMPT_CATEGORIES` from `core/suggest.js`; `WithStatus` (Task 3).
- Produces: SPEC §3.2 contract — the backing endpoint for Phase 3's `hearsay_setup_tracking`.

- [ ] **Step 1: Failing tests**

```js
test('setup: happy path creates brand + competitors + intents transactionally', async () => {
  const app = await boot();
  const { status, body } = await api(app.base, 'POST', '/api/setup', {
    brand: { name: 'Acme', aliases: ['Acme AI'], domains: ['acme.example'] },
    competitors: [{ name: 'Jotta', domains: ['jotta.example'] }],
    intents: [
      { label: 'best acme-like tool', category: 'general', paraphrases: ['best acme-like tool?', 'top acme-like tools 2026'] },
      { label: 'is Acme any good', category: 'general', paraphrases: ['is Acme any good?'] },
    ],
  });
  assert.equal(status, 200);
  assert.deepEqual(body.created, { entities: 2, intents: 2, prompts: 3 });
  // brand-name paraphrase forced to category 'branded' (SOV-denominator invariant)
  assert.deepEqual(body.retagged_branded, ['is Acme any good?']);
  assert.equal(body.config.activePrompts, 3);
  await app.close();
});

test('setup: dedupe-skip on rerun; append paraphrase to existing intent', async () => {
  const app = await boot();
  const payload = { brand: { name: 'Acme' }, intents: [{ label: 'best tool', paraphrases: ['best tool?'] }] };
  await api(app.base, 'POST', '/api/setup', payload);
  const again = await api(app.base, 'POST', '/api/setup', {
    brand: { name: 'Acme' },
    intents: [{ label: 'best tool', paraphrases: ['best tool?', 'which tool is best'] }],
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.created, { entities: 0, intents: 0, prompts: 1 });
  assert.equal(again.body.skipped.length, 2); // brand + duplicate paraphrase
  await app.close();
});

test('setup: validation is all-or-nothing (bad alias → 422, zero writes)', async () => {
  const app = await boot();
  const { status, body } = await api(app.base, 'POST', '/api/setup', {
    brand: { name: 'Acme', aliases: ['ab'] },
    intents: [{ label: 'ok', paraphrases: ['ok?'] }],
  });
  assert.equal(status, 422);
  assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
  const s = await api(app.base, 'GET', '/api/status');
  assert.deepEqual(s.body.counts, { entities: 0, intents: 0, activePrompts: 0 });
  await app.close();
});

test('setup: different existing brand → 409 brand_exists; demo mode → 400', async () => {
  const app = await boot();
  await api(app.base, 'POST', '/api/entities', { name: 'Notewell', is_self: true });
  const conflict = await api(app.base, 'POST', '/api/setup', { brand: { name: 'Acme' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'brand_exists');
  await app.close();

  const demo = await boot({ HEARSAY_DEMO: '1' });
  const blocked = await api(demo.base, 'POST', '/api/setup', { brand: { name: 'Acme' } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'demo_mode');
  await demo.close();
});
```

Also cover (same file, same pattern): empty body → 422 `nothing_to_do`; payload-internal domain duplicate → 422; brand name matching an existing *competitor* → 409 `entity_exists`.

- [ ] **Step 2: Verify FAIL** (404 today).
- [ ] **Step 3: Implement.** One handler, structured exactly as: 409 pre-checks → collect `errors[]` → 422 via `WithStatus` if any → single `transaction` → report. Sketch (complete the obvious symmetric branches):

```js
const SETUP_CATEGORIES = PROMPT_CATEGORIES.includes('branded') ? PROMPT_CATEGORIES : [...PROMPT_CATEGORIES, 'branded'];

/** @param {ApiDeps} deps @param {import('../router.js').Ctx} ctx */
function setupTracking({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on. Set HEARSAY_DEMO=0 to configure live tracking.');
  const body = asObject(ctx.body);
  const brand = body.brand === undefined ? null : asObject(body.brand);
  const competitors = (body.competitors === undefined ? [] : /** @type {unknown[]} */ (body.competitors)).map(asObject);
  const intents = (body.intents === undefined ? [] : /** @type {unknown[]} */ (body.intents)).map(asObject);
  if (brand === null && competitors.length === 0 && intents.length === 0) {
    throw new ApiError(422, 'nothing_to_do', 'Provide at least one of brand, competitors, intents');
  }

  // 409 pre-checks (SPEC §3.2) — before field validation.
  const existingBrand = get(db, 'SELECT id, name FROM entities WHERE is_self = 1 AND archived_at IS NULL');
  if (brand !== null && existingBrand && String(existingBrand.name).toLowerCase() !== String(brand.name ?? '').trim().toLowerCase()) {
    throw new ApiError(409, 'brand_exists', `Brand is "${existingBrand.name}" — changing the brand is destructive; use the web UI.`);
  }
  if (brand !== null && !existingBrand) {
    const clash = get(db, 'SELECT id FROM entities WHERE name = ? COLLATE NOCASE', [String(brand.name ?? '').trim()]);
    if (clash) throw new ApiError(409, 'entity_exists', 'That name already exists as a competitor — promoting it to brand is a web-UI action.');
  }

  // Validate everything, then write everything (all-or-nothing).
  /** @type {{path: string, message: string}[]} */
  const errors = [];
  const check = (/** @type {string} */ path, /** @type {() => void} */ fn) => {
    try { fn(); } catch (err) { errors.push({ path, message: err instanceof Error ? err.message : String(err) }); }
  };
  const seenDomains = new Set();
  const validateEntity = (/** @type {Record<string, unknown>} */ e, /** @type {string} */ path) => {
    check(`${path}.name`, () => str(e.name, 'name', { max: 120, required: true }));
    check(`${path}.aliases`, () => checkAliases(strList(e.aliases, 'aliases') ?? []));
    check(`${path}.domains`, () => {
      const ds = (strList(e.domains, 'domains') ?? []).map(normaliseDomain).filter((d) => d !== '');
      for (const d of ds) {
        if (seenDomains.has(d)) throw new ApiError(422, 'unprocessable', `Domain ${d} appears twice in this payload`);
        seenDomains.add(d);
      }
      assertDomainsFree(db, ds, null);
    });
  };
  if (brand !== null) validateEntity(brand, 'brand');
  competitors.forEach((c, i) => validateEntity(c, `competitors[${i}]`));
  intents.forEach((intent, i) => {
    check(`intents[${i}].label`, () => str(intent.label, 'label', { max: 300, required: true }));
    check(`intents[${i}].category`, () => {
      const cat = str(intent.category, 'category', { max: 40 }) ?? 'general';
      if (!SETUP_CATEGORIES.includes(cat)) throw new ApiError(422, 'unprocessable', `category must be one of: ${SETUP_CATEGORIES.join(', ')}`);
    });
    const ps = strList(intent.paraphrases, `intents[${i}].paraphrases`) ?? [];
    if (ps.length === 0) errors.push({ path: `intents[${i}].paraphrases`, message: 'each intent needs at least one paraphrase' });
    ps.forEach((p, j) => check(`intents[${i}].paraphrases[${j}]`, () => str(p, 'paraphrase', { max: 300, required: true })));
  });
  if (errors.length > 0) {
    return new WithStatus(422, { error: { code: 'validation', message: `${errors.length} problem(s) — nothing was saved` }, errors });
  }

  // Apply.
  const created = { entities: 0, intents: 0, prompts: 0 };
  /** @type {{type: string, value: string, reason: string}[]} */
  const skipped = [];
  /** @type {string[]} */
  const retagged = [];
  transaction(db, () => {
    const ensureEntity = (/** @type {Record<string, unknown>} */ e, /** @type {boolean} */ isSelf) => {
      const name = /** @type {string} */ (str(e.name, 'name', { max: 120, required: true }));
      if (get(db, 'SELECT id FROM entities WHERE name = ? COLLATE NOCASE', [name])) {
        skipped.push({ type: 'entity', value: name, reason: 'exists' });
        return;
      }
      run(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, ?, ?)', [
        name,
        JSON.stringify(checkAliases(strList(e.aliases, 'aliases') ?? [])),
        JSON.stringify((strList(e.domains, 'domains') ?? []).map(normaliseDomain).filter((d) => d !== '')),
        isSelf ? 1 : 0,
        isoNow(),
      ]);
      created.entities += 1;
    };
    if (brand !== null) ensureEntity(brand, true);
    for (const c of competitors) ensureEntity(c, false);

    const brandRow = brandEntity(db);
    const brandAliases = brandRow === null ? [] : aliasesFor(brandRow);
    for (const intent of intents) {
      const label = /** @type {string} */ (str(intent.label, 'label', { max: 300, required: true }));
      let intentId = Number(get(db, 'SELECT id FROM intents WHERE label = ?', [label])?.id ?? 0);
      if (intentId === 0) {
        intentId = Number(run(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', [label, isoNow()]).lastInsertRowid);
        created.intents += 1;
      }
      const category = str(intent.category, 'category', { max: 40 }) ?? 'general';
      for (const raw of strList(intent.paraphrases, 'paraphrases') ?? []) {
        const text = /** @type {string} */ (str(raw, 'paraphrase', { max: 300, required: true }));
        if (get(db, 'SELECT id FROM prompts WHERE text = ?', [text])) {
          skipped.push({ type: 'prompt', value: text, reason: 'duplicate' });
          continue;
        }
        // SOV-denominator invariant (SPEC §3.2): brand-name prompts are always 'branded'.
        const isBranded = brandAliases.length > 0 && containsAlias(text, brandAliases);
        if (isBranded && category !== 'branded') retagged.push(text);
        run(db, 'INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(?, ?, ?, 1, ?)', [
          intentId, text, isBranded ? 'branded' : category, isoNow(),
        ]);
        created.prompts += 1;
      }
    }
  });

  return {
    created,
    skipped,
    retagged_branded: retagged,
    config: {
      entities: listEntities(db).length,
      intents: Number(get(db, 'SELECT COUNT(*) AS n FROM intents')?.n ?? 0),
      activePrompts: activePromptCount(db),
    },
  };
}
```

Imports to add at top of `web/pages/api.js`: `containsAlias, aliasesFor` from `../../core/analyze.js`; `PROMPT_CATEGORIES` via the `suggest` namespace or directly from `../../core/suggest.js`. Register: `router.add('POST', '/api/setup', json((ctx) => setupTracking(deps, ctx)));`. If `containsAlias(text, aliases)`'s actual signature differs (check `core/analyze.js:199`), adapt the call — the invariant is what's binding.

- [ ] **Step 4: Verify PASS** — all setup tests + full suite + typecheck.
- [ ] **Step 5: Commit** — `git commit -m "feat: POST /api/setup transactional bulk tracking setup" -- web/pages/api.js test/api.test.js`

---

### Task 10: dashboard run button honors the quote

**Files:**
- Modify: `public/app.js` (run-button handler)

**Interfaces:**
- Consumes: Task 5's `quote_required` response.
- Produces: the §11.2/§4.3 UI confirm step, now driven by the server's single source of truth.

- [ ] **Step 1: Implement** (no automated browser tests in this stack — the gate itself is server-tested in Task 5; keep this handler dumb):

In the run-button click handler, replace the single POST with:

```js
async function startPanelRun() {
  const first = await postJson('/api/run', {});
  if (first.status === 'quote_required') {
    const usd = first.estUsd === null ? 'unknown cost' : `≈ $${first.estUsd.toFixed(2)}`;
    if (!window.confirm(`This run makes ${first.calls} API calls (${usd}). Start it?`)) return;
    await postJson('/api/run', { confirm: true });
  }
  pollRunProgress(); // existing /api/runs/latest polling
}
```

Adapt names to the file's existing helpers (`postJson`/`pollRunProgress` or equivalents already present from Lane C — `rg -n "api/run" public/app.js`).

- [ ] **Step 2: Manual verify** — `HEARSAY_CONFIRM_USD=0 node server.js` with a key set: button shows the browser confirm with real numbers; cancel does nothing; OK starts and the progress bar moves.
- [ ] **Step 3: Commit** — `git commit -m "feat: run button relays server cost quote" -- public/app.js`

---

### Task 11: e2e.test.js — replace the Phase 2 stub

**Files:**
- Rewrite: `test/e2e.test.js`
- Consumes: `boot`/`api` helpers exported from `test/api.test.js`; `node scripts/seed.js` behavior via `core/seed.js` (Lane D, done per Task 1 gate).

Master-plan §15 e2e row + SPEC §8, as one suite:

- [ ] **Step 1: Write the tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, api } from './api.test.js';

const PAGES = ['/', '/answers', '/prompts', '/entities', '/alerts', '/settings', '/methodology', '/setup'];

test('e2e: every page renders on an empty DB', async () => {
  const app = await boot();
  for (const path of PAGES) {
    const res = await fetch(app.base + path);
    assert.ok([200, 302].includes(res.status), `${path} → ${res.status}`); // '/' may redirect to /setup (§11.8)
  }
  await app.close();
});

test('e2e: seeded demo instance tells the full story', async () => {
  const app = await boot({ HEARSAY_DEMO: '1' }); // auto-seeds when empty (§12)
  const summary = await api(app.base, 'GET', '/api/summary');
  assert.equal(summary.status, 200);
  for (const key of ['brand', 'windowDays', 'generatedAt', 'demo', 'sov', 'mentionRate', 'recommendationRate', 'providers', 'openAlerts', 'lastRun']) {
    assert.ok(key in summary.body, `summary missing ${key}`); // §10.4 key-shape
  }
  assert.equal(summary.body.demo, true);
  assert.ok(summary.body.openAlerts >= 2, 'seed storylines must produce alerts (§12)');

  assert.equal((await api(app.base, 'POST', '/api/run', { confirm: true })).status, 400); // demo blocks runs
  assert.equal((await api(app.base, 'POST', '/api/setup', { brand: { name: 'X' } })).status, 400);

  const answers = await api(app.base, 'GET', '/api/answers?provider=perplexity');
  assert.ok(answers.body.items.every((item) => item.provider === 'perplexity'));

  const s = await api(app.base, 'GET', '/api/status');
  assert.equal(s.body.demo, true);
  assert.equal(s.body.configured, true);
  await app.close();
});
```

If demo auto-seed happens in `server.js` boot rather than `startServer` (check — §12 says auto-seed on `HEARSAY_DEMO=1` with empty DB), seed explicitly first with the seeder's exported function and `trigger:'seed'`, matching how `seed.test.js` invokes it.

- [ ] **Step 2: Verify PASS** — `node --test test/e2e.test.js`, then full `node --test`.
- [ ] **Step 3: Commit** — `git commit -m "test: end-to-end suite over seeded demo instance" -- test/e2e.test.js`

---

### Task 12: Phase 2 exit gate — §19 checklist + docs

**Files:**
- Modify: `SECURITY.md` (one sentence)

- [ ] **Step 1: SECURITY.md** — add to the trust-boundary section: *"`POST /api/setup` sits inside the same localhost/reverse-proxy trust boundary as the other CRUD endpoints — anyone who can reach the port could already reconfigure Hearsay; the agent surface adds convenience, not exposure."*
- [ ] **Step 2: Full verification** — `node --test` (everything, including coverage if CI uses `--experimental-test-coverage`) and `npm run typecheck`: green.
- [ ] **Step 3: §19 Phase 2 manual pass** (run `HEARSAY_DEMO=1 node server.js`, check in a browser, both themes):
  - demo banner strip on every page; empty states on a fresh non-demo DB
  - keyboard/a11y: tab order sane, toggles have aria labels, every `<svg>` has `<title>`
  - dark mode on every page (toggle top-right)
  - circuit breaker + mutex: confirm the Lane A unit tests exist and pass (`node --test test/providers.test.js` and the runner tests; `rg -n "circuit|mutex|RunInProgress" test/`)
- [ ] **Step 4: Zero-dep audit** — `rg -n "from ['\"]" --glob '!node_modules' -g '*.js' -g '*.mjs' | rg -v "node:|\./|\.\./"` → no matches; `package.json` has no `dependencies` key (§19.5 #2).
- [ ] **Step 5: Commit** — `git commit -m "docs: Phase 2 gate — SECURITY.md trust-boundary note" -- SECURITY.md`

---

## Out of scope for this plan (Phase 3 — next plan)

MCP server rewrite (13 tools per SPEC §2/§6), `skill/SKILL.md` (SPEC §5), `scripts/run-panel.js --estimate`, `test/mcp.test.js`, README agent quickstart + demo GIF. Do not start these here.
