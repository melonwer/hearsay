# Hearsay Phase 3 — Agent Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent surface per `docs/superpowers/specs/2026-07-26-agent-surface-design.md` (SPEC): the 13-tool zero-dep MCP server, the operator SKILL.md, the two straggler CLI scripts (`run-panel.js` with `--estimate`, `suggest-prompts.js`), `test/mcp.test.js`, and the README agent quickstart.

**Architecture:** `mcp/server.mjs` is a thin stdio JSON-RPC 2.0 proxy over the Phase-2 HTTP API at `HEARSAY_URL` — one declarative tool table drives both `tools/list` and `tools/call`; no DB access, no API keys, no SDK. All judgment lives in `skill/SKILL.md`. CLI scripts import core modules in-process (they are local, not HTTP clients).

**Tech Stack:** Node ≥22.5 built-ins only (`node:http`, `node:child_process`, `node:util` parseArgs, `node:test`). Zero npm dependencies.

## Global Constraints

- **Node:** the system `node` is v18 — **always use `~/.local/node-lts/bin/node`** (Node 24) for every command in this plan. Where a doc says `node`, that's what end users type; where a *step* says run something, use the full path.
- **Zero runtime npm dependencies** (§19.6 #1). `package.json` never gains a `dependencies` key.
- MCP stdout is **protocol-pure**: every stdout line is a JSON-RPC message; all logging goes to stderr (§13).
- No live network in tests: the MCP tests run against a stub `node:http` backend; CLI tests run with zero provider keys (§15).
- Secrets: no API key, masked or not, may appear in MCP output, CLI output, or README examples (§19.6 #9).
- ESM + JSDoc, `npm run typecheck` green (jsconfig includes `mcp` and `scripts`).
- `[VERIFY-AT-BUILD]` (§0): the MCP protocol version string. Check the current MCP spec revision if network access is available; otherwise use `'2025-06-18'` as latest-known and keep the echo-if-known rule below. Do the same sanity check for the `annotations` field names (`readOnlyHint`, `idempotentHint`).
- SPEC shapes are binding. HTTP contract details (envelope, `quote_required`, `no_runs`, …) shipped in Phase 2 — do not re-derive them, hit the real routes.
- Commit after every task.

---

### Task 1: Entry gate

**Files:** none.

- [ ] **Step 1:** `cd /home/d4ydy/hearsay && ~/.local/node-lts/bin/node --test` → 196/196 pass (or more, never fewer) and `npm run typecheck` clean. If red, stop and report.
- [ ] **Step 2:** Confirm Phase 2 routes exist: `rg -n "'/api/status'|'/api/setup'|quote_required" web/pages/api.js` → all three hit.

---

### Task 2: `scripts/run-panel.js` — real CLI with `--estimate`

The file is still a Phase 1 stub (it prints "not implemented"). Finish it per §8.1 + SPEC §7.

**Files:**
- Rewrite: `scripts/run-panel.js`
- Test: `test/cli.test.js` (new)

**Interfaces:**
- Consumes: `config` from `core/config.js`, `openDb` from `core/db.js`, `runPanel` from `core/runner.js` (Phase-2 signature: `runPanel({ db, config, trigger })`), `costEstimate` from `web/pages/api.js`, per-provider `runPrompt(text, { model, timeoutMs })` from `core/providers/index.js`'s registry.
- Produces: `node scripts/run-panel.js` (run a panel), `--estimate` (print quote JSON, no run), `--once --prompt "…"` (live smoke, gated by `HEARSAY_LIVE_TEST=1`).

- [ ] **Step 1: Failing tests** — create `test/cli.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const NODE = process.execPath; // the same Node running the tests

function tmpDb() {
  return join(mkdtempSync(join(tmpdir(), 'hearsay-cli-')), 'test.db');
}

test('run-panel --estimate prints the quote JSON and never runs', async () => {
  const { stdout } = await exec(NODE, ['scripts/run-panel.js', '--estimate'], {
    env: { ...process.env, HEARSAY_DB_PATH: tmpDb(), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PERPLEXITY_API_KEY: '' },
  });
  const quote = JSON.parse(stdout);
  assert.equal(quote.calls, 0); // empty DB, zero providers
  assert.ok(Array.isArray(quote.perProvider));
});

test('run-panel --prompt without HEARSAY_LIVE_TEST refuses (no accidental spend)', async () => {
  await assert.rejects(
    exec(NODE, ['scripts/run-panel.js', '--once', '--prompt', 'test'], {
      env: { ...process.env, HEARSAY_DB_PATH: tmpDb(), HEARSAY_LIVE_TEST: '' },
    }),
    /HEARSAY_LIVE_TEST/,
  );
});
```

- [ ] **Step 2: Verify FAIL** — `~/.local/node-lts/bin/node --test test/cli.test.js` (stub exits 1 with no JSON).
- [ ] **Step 3: Implement** `scripts/run-panel.js`:

```js
/**
 * CLI: node scripts/run-panel.js [--estimate] [--once --prompt "..."]
 *
 * Default: run one full panel through core/runner.js with trigger='manual'.
 * --estimate: print the §4.3 cost quote as JSON and exit — nothing runs, nothing is
 *   written. Same numbers the API's quote_required response uses (SPEC §3.3).
 * --once --prompt "...": live smoke for humans — one prompt through each enabled
 *   provider, no DB writes. Guarded by HEARSAY_LIVE_TEST=1 because it spends money.
 */

import { parseArgs } from 'node:util';
import { config } from '../core/config.js';
import { openDb } from '../core/db.js';
import { runPanel } from '../core/runner.js';
import { costEstimate } from '../web/pages/api.js';
import { registry } from '../core/providers/index.js';

const { values } = parseArgs({
  options: {
    estimate: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    prompt: { type: 'string' },
  },
});

if (values.estimate) {
  const db = openDb(config.dbPath);
  process.stdout.write(`${JSON.stringify(costEstimate({ db, config }), null, 2)}\n`);
  process.exit(0);
}

if (values.prompt !== undefined) {
  if (process.env.HEARSAY_LIVE_TEST !== '1') {
    process.stderr.write('--prompt makes real provider calls. Set HEARSAY_LIVE_TEST=1 to confirm.\n');
    process.exit(1);
  }
  for (const provider of config.enabledProviders) {
    const t0 = Date.now();
    try {
      const result = await registry[provider.id].runPrompt(/** @type {string} */ (values.prompt), {
        model: provider.model,
        timeoutMs: config.timeoutMs,
      });
      process.stdout.write(`${provider.id} ${Date.now() - t0}ms: ${result.text.slice(0, 120).replace(/\n/g, ' ')}\n`);
    } catch (err) {
      process.stdout.write(`${provider.id} ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.exit(0);
}

const db = openDb(config.dbPath);
const summary = await runPanel({ db, config, trigger: 'manual' });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
```

Adapt the two import shapes to reality before coding: `rg -n "^export" core/providers/index.js` for the registry's real export name, and check `runPanel`'s exact Phase-2 options object in `core/runner.js`. The behavior contract above is fixed; the names follow the code.

- [ ] **Step 4: Verify PASS** — `~/.local/node-lts/bin/node --test test/cli.test.js`; typecheck clean.
- [ ] **Step 5: Commit** — `git add scripts/run-panel.js test/cli.test.js && git commit -m "feat: run-panel CLI with --estimate quote and guarded live smoke"`

---

### Task 3: `scripts/suggest-prompts.js` — real CLI

Also still a stub. §6.7's CLI surface; `suggestIntents` already falls back to the starter pack with zero keys (its tests prove it), so this is thin.

**Files:**
- Rewrite: `scripts/suggest-prompts.js`
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `suggestIntents(input)` from `core/suggest.js` — check its exact input object with `rg -n "suggestIntents" core/suggest.js test/suggest.test.js` (the test file shows working call shapes).
- Produces: `node scripts/suggest-prompts.js "Brand" brand.com [--keywords "..."]` → draft intents JSON on stdout, never writes to the DB.

- [ ] **Step 1: Failing test:**

```js
test('suggest-prompts prints draft intents with zero keys (starter pack), writes nothing', async () => {
  const dbPath = tmpDb();
  const { stdout } = await exec(NODE, ['scripts/suggest-prompts.js', 'Acme', 'acme.example'], {
    env: { ...process.env, HEARSAY_DB_PATH: dbPath, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PERPLEXITY_API_KEY: '' },
  });
  const draft = JSON.parse(stdout);
  assert.ok(Array.isArray(draft.intents) && draft.intents.length > 0);
  assert.ok(draft.intents.every((i) => typeof i.label === 'string' && Array.isArray(i.paraphrases)));
});
```

- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Implement:** positional args `name`, `domain` (both optional-but-recommended; no args → still emit the generic starter pack), `--keywords` via `parseArgs` with `allowPositionals: true`. Build `brand = { name, aliases: [], domains: domain ? [domain] : [] }`, call `suggestIntents` with the same input shape `web/pages/api.js`'s `suggestPrompts` uses (copy it — that call is proven), and print `JSON.stringify({ source, intents }, null, 2)`. No DB opens unless `suggestIntents` requires one — it must never insert (assert nothing in the code path calls `run(db, 'INSERT…')`).
- [ ] **Step 4: Verify PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git commit -m "feat: suggest-prompts CLI (draft-only, starter-pack fallback)" -- scripts/suggest-prompts.js test/cli.test.js`

---

### Task 4: MCP server — framing + handshake, with the test harness

**Files:**
- Rewrite: `mcp/server.mjs`
- Test: `test/mcp.test.js` (new)

**Interfaces:**
- Produces: the JSON-RPC skeleton every later task plugs into, and the `test/mcp.test.js` harness (`stubBackend`, `startMcp`, `rpc`) Tasks 5–6 reuse.

- [ ] **Step 1: Failing tests** — create `test/mcp.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Stub Hearsay: routes = { 'GET /api/status': {status, body}, … }. Records requests. */
export async function stubBackend(routes) {
  /** @type {{method: string, url: string, body: string}[]} */
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? '', url: req.url ?? '', body });
    const hit = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
    res.writeHead(hit?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit?.body ?? { error: { code: 'not_found', message: 'stub: no route' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Spawn mcp/server.mjs; returns send/next/lines/kill. Every stdout line must parse. */
export function startMcp(hearsayUrl) {
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env: { ...process.env, HEARSAY_URL: hearsayUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  /** @type {unknown[]} */
  const lines = [];
  /** @type {((msg: unknown) => void)[]} */
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      const msg = JSON.parse(line); // throws = stdout purity violation = test failure
      lines.push(msg);
      waiters.shift()?.(msg);
    }
  });
  return {
    lines,
    send: (/** @type {object} */ obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    next: () => new Promise((resolve) => waiters.push(resolve)),
    kill: () => child.kill(),
  };
}

export async function rpc(mcp, method, params, id) {
  mcp.send({ jsonrpc: '2.0', id, method, params });
  return mcp.next();
}

test('mcp: initialize handshake, ping, unknown method, notification silence', async () => {
  const backend = await stubBackend({});
  const mcp = startMcp(backend.url);

  const init = await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1);
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-06-18'); // echoed: it's one we know
  assert.equal(init.result.serverInfo.name, 'hearsay');
  assert.deepEqual(init.result.capabilities, { tools: {} });

  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // no reply expected

  const pong = await rpc(mcp, 'ping', {}, 2);
  assert.deepEqual(pong.result, {});

  const nope = await rpc(mcp, 'bogus/method', {}, 3);
  assert.equal(nope.error.code, -32601);

  // notification produced no line of its own: ids seen are exactly 1,2,3
  assert.deepEqual(mcp.lines.map((l) => /** @type {*} */ (l).id), [1, 2, 3]);
  mcp.kill();
  await backend.close();
});

test('mcp: unknown protocolVersion → server answers with its own latest', async () => {
  const backend = await stubBackend({});
  const mcp = startMcp(backend.url);
  const init = await rpc(mcp, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} }, 1);
  assert.match(init.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(init.result.protocolVersion, '1999-01-01');
  mcp.kill();
  await backend.close();
});
```

- [ ] **Step 2: Verify FAIL** (current file is a comment stub exporting nothing; the child produces no output → tests hang and fail on timeout; run with `--test-timeout 10000`).
- [ ] **Step 3: Implement** the skeleton in `mcp/server.mjs`:

```js
#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server (§13, SPEC §2/§6). Newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; logs go to stderr. Data comes from a running
 * Hearsay over HTTP at HEARSAY_URL — this process holds no API keys and opens no DB.
 */
import { readFileSync } from 'node:fs';

const HEARSAY_URL = (process.env.HEARSAY_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const KNOWN_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']; // [VERIFY-AT-BUILD]
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** @param {unknown} id @param {object} result */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
/** @param {unknown} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

/** @param {{id?: unknown, method?: string, params?: any}} msg */
async function dispatch(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'initialize': {
        const asked = String(params?.protocolVersion ?? '');
        reply(id, {
          protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : KNOWN_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'hearsay', version: VERSION },
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'notifications/initialized':
        return; // acknowledged silently
      case 'tools/list':
      case 'tools/call':
        // Implemented in Tasks 5–6.
        replyError(id, -32601, `${method} not wired yet`);
        return;
      default:
        if (!isNotification) replyError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    process.stderr.write(`[hearsay-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    if (!isNotification) replyError(id, -32603, 'Internal error');
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    try {
      void dispatch(JSON.parse(line));
    } catch {
      replyError(null, -32700, 'Parse error');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
```

- [ ] **Step 4: Verify PASS** — both handshake tests green.
- [ ] **Step 5: Commit** — `git add mcp/server.mjs test/mcp.test.js && git commit -m "feat: MCP stdio skeleton — handshake, ping, framing"`

---

### Task 5: MCP `tools/list` — the 13-tool declarative table

**Files:**
- Modify: `mcp/server.mjs`
- Test: `test/mcp.test.js`

**Interfaces:**
- Produces: `TOOLS` array — `{name, description, readOnly, inputSchema, call(args) → {method, path, body?}}` — Task 6 executes `call`.

- [ ] **Step 1: Failing tests:**

```js
test('mcp tools/list: exactly 13 tools, schemas, read-only annotations', async () => {
  const backend = await stubBackend({});
  const mcp = startMcp(backend.url);
  await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
  const list = await rpc(mcp, 'tools/list', {}, 2);
  const tools = list.result.tools;
  assert.equal(tools.length, 13);
  const names = tools.map((t) => t.name);
  for (const name of [
    'hearsay_status', 'hearsay_summary', 'hearsay_intent_results', 'hearsay_prompt_results',
    'hearsay_answers_search', 'hearsay_citation_gap', 'hearsay_alerts', 'hearsay_cost_estimate',
    'hearsay_suggest_prompts', 'hearsay_setup_tracking', 'hearsay_run_panel', 'hearsay_run_status',
    'hearsay_ack_alert',
  ]) assert.ok(names.includes(name), `missing ${name}`);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, `${t.name} description too thin to trigger on`);
  }
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
  assert.deepEqual(readOnly, [
    'hearsay_alerts', 'hearsay_answers_search', 'hearsay_citation_gap', 'hearsay_cost_estimate',
    'hearsay_intent_results', 'hearsay_prompt_results', 'hearsay_run_status', 'hearsay_status',
    'hearsay_summary',
  ]);
  assert.equal(tools.find((t) => t.name === 'hearsay_ack_alert').inputSchema.required?.includes('id'), true);
  mcp.kill();
  await backend.close();
});
```

- [ ] **Step 2: Verify FAIL** (-32601 today).
- [ ] **Step 3: Implement.** Add to `mcp/server.mjs` (schema fragments shared; descriptions are binding copy — trigger-rich per §13/SPEC §2, honest per §1.5):

```js
const DAYS = { type: 'integer', minimum: 1, maximum: 365, description: 'Reporting window in days (default 30)' };
const ENTITY_FIELDS = {
  name: { type: 'string', description: 'Entity name, e.g. "Acme"' },
  aliases: { type: 'array', items: { type: 'string' }, description: 'Other names it goes by (≥3 chars each)' },
  domains: { type: 'array', items: { type: 'string' }, description: 'Domains it owns, e.g. "acme.com"' },
};
/** @param {Record<string, unknown>} properties @param {string[]} [required] */
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
/** @param {Record<string, unknown>} args @param {string[]} keys @param {Record<string,string>} [rename] */
function query(args, keys, rename = {}) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args?.[key];
    if (value !== undefined && value !== null) params.set(rename[key] ?? key, String(value));
  }
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

const TOOLS = [
  {
    name: 'hearsay_status',
    readOnly: true,
    description:
      'Check whether the local Hearsay AI-visibility tracker is running and configured: enabled providers (ChatGPT, Claude, Gemini, Perplexity), tracked brand/competitor/prompt counts, last measurement run, schedule, 30-day API spend. Call this FIRST for any AI visibility / GEO / AI SEO / brand-monitoring question.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/status' }),
  },
  {
    name: 'hearsay_summary',
    readOnly: true,
    description:
      'Headline AI-visibility numbers for the tracked brand: share of AI voice vs competitors, brand mention rate with 95% confidence interval and n, recommendation rate, per-provider breakdown across ChatGPT, Claude, Gemini and Perplexity, open alert count, last run.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/summary${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_intent_results',
    readOnly: true,
    description:
      'Phrasing-robust results per tracked intent (question), pooled across its paraphrases: mention rate with Wilson CI, rerun spread vs phrasing spread (variance decomposition). The most honest per-question number Hearsay has — prefer it over per-prompt results when both exist.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/intents/results${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_prompt_results',
    readOnly: true,
    description:
      'Per-prompt (single paraphrase) results, broken down per provider: brand mention rate, whether the brand is recommended, and which entity leads each prompt. Use for drill-down after hearsay_intent_results, or to inspect competitor prompt-space.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/prompts/results${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_answers_search',
    readOnly: true,
    description:
      'Fetch the raw stored AI answers (the receipts): full text with detected brand/competitor mentions, recommendation flags and cited URLs. Filter by provider (openai|anthropic|gemini|perplexity), entity_id, prompt_id, days. Paged; limit ≤ 50.',
    inputSchema: obj({
      provider: { type: 'string', enum: ['openai', 'anthropic', 'gemini', 'perplexity'] },
      entity_id: { type: 'integer', minimum: 1 },
      prompt_id: { type: 'integer', minimum: 1 },
      days: DAYS,
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
    call: (a) => ({ method: 'GET', path: `/api/answers${query(a, ['provider', 'entity_id', 'prompt_id', 'days', 'page', 'limit'], { limit: 'per' })}` }),
  },
  {
    name: 'hearsay_citation_gap',
    readOnly: true,
    description:
      'The action list: domains that AI answers cite in answers where the tracked brand is NOT mentioned — who gets cited instead of you, ranked by frequency. The shortlist of places to earn citations for GEO / AI SEO work.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/gap${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_alerts',
    readOnly: true,
    description:
      'List AI-visibility alerts: lost/gained recommendations, competitors overtaking share of AI voice, mention-rate drops — each with severity and the underlying numbers. open_only=true (default) shows unacknowledged alerts.',
    inputSchema: obj({ open_only: { type: 'boolean', description: 'Default true' } }),
    call: (a) => ({ method: 'GET', path: `/api/alerts?open=${a?.open_only === false ? '0' : '1'}` }),
  },
  {
    name: 'hearsay_cost_estimate',
    readOnly: true,
    description:
      'Preview what one measurement panel run would cost before spending anything: total API calls and estimated USD per provider, from the live price table. Costs go to the user’s own provider keys.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/cost/estimate' }),
  },
  {
    name: 'hearsay_suggest_prompts',
    description:
      'Draft tracking intents and paraphrases for the configured brand — the answer to "I don’t know which prompts to track". Returns a DRAFT ONLY; nothing is saved. Show the draft to the human for review, then persist the approved set with hearsay_setup_tracking. Works without provider keys (built-in starter pack).',
    inputSchema: obj({
      category_hint: { type: 'string', description: 'Product category, e.g. "AI meeting notes tool"' },
      keywords: { type: 'string', description: 'Pasted SEO keywords or topics to steer the draft' },
    }),
    call: (a) => ({ method: 'POST', path: '/api/prompts/suggest', body: { category_hint: a?.category_hint, keywords: a?.keywords } }),
  },
  {
    name: 'hearsay_setup_tracking',
    description:
      'Set up or extend AI-visibility tracking in one transactional call: create the brand, competitors, and the intent/paraphrase prompt panel Hearsay measures across ChatGPT, Claude, Gemini and Perplexity. Existing names/prompts are skipped and reported, never duplicated. Only call with prompts the human has reviewed in this conversation.',
    inputSchema: obj({
      brand: obj(ENTITY_FIELDS),
      competitors: { type: 'array', items: obj(ENTITY_FIELDS) },
      intents: {
        type: 'array',
        items: obj(
          {
            label: { type: 'string', description: 'The underlying question, e.g. "best AI meeting notes tool"' },
            category: { type: 'string', enum: ['general', 'comparison', 'use-case', 'local', 'pricing', 'branded'] },
            paraphrases: { type: 'array', items: { type: 'string' }, description: 'Phrasings of this question (≥1, ≤300 chars each)' },
          },
          ['label', 'paraphrases'],
        ),
      },
    }),
    call: (a) => ({ method: 'POST', path: '/api/setup', body: a ?? {} }),
  },
  {
    name: 'hearsay_run_panel',
    description:
      'Start a measurement panel run (every active prompt × enabled provider × samples) using the user’s own API keys. Above the cost threshold this returns a quote_required estimate instead of running — relay the estimate to the human and only retry with confirm:true after they explicitly approve the spend.',
    inputSchema: obj({ confirm: { type: 'boolean', description: 'true = the human approved the quoted cost in this conversation' } }),
    call: (a) => ({ method: 'POST', path: '/api/run', body: { confirm: a?.confirm === true } }),
  },
  {
    name: 'hearsay_run_status',
    readOnly: true,
    description:
      'Progress of the latest measurement run: status (running/done/failed), done_calls/total_calls, timestamps. Poll this after hearsay_run_panel starts a run. Returns no_runs if the instance has never run a panel.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/runs/latest' }),
  },
  {
    name: 'hearsay_ack_alert',
    description:
      'Acknowledge one alert by id so it leaves the open list. Use after the human has seen the alert and decided what to do about it.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1, description: 'Alert id from hearsay_alerts' } }, ['id']),
    call: (a) => ({ method: 'POST', path: `/api/alerts/${Number(a.id)}/ack`, body: {} }),
  },
];
```

Wire `tools/list` in `dispatch`:

```js
case 'tools/list':
  reply(id, {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.readOnly ? { annotations: { readOnlyHint: true, idempotentHint: true } } : {}),
    })),
  });
  return;
```

- [ ] **Step 4: Verify PASS**; typecheck clean (JSDoc-annotate `TOOLS` as needed).
- [ ] **Step 5: Commit** — `git commit -m "feat: MCP tools/list — 13-tool declarative table" -- mcp/server.mjs test/mcp.test.js`

---

### Task 6: MCP `tools/call` — HTTP dispatch + error mapping

**Files:**
- Modify: `mcp/server.mjs`
- Test: `test/mcp.test.js`

**Interfaces:**
- Consumes: `TOOLS[i].call(args)` (Task 5).
- Produces: SPEC §6 mapping — 2xx → text content; non-2xx → `isError:true` with the envelope verbatim; network failure → `isError:true` `unreachable`; `quote_required` (a 200) is NORMAL content; unknown tool → `-32602`.

- [ ] **Step 1: Failing tests:**

```js
test('mcp tools/call: happy path, param mapping, error mapping, unreachable', async () => {
  const backend = await stubBackend({
    'GET /api/summary': { status: 200, body: { brand: { id: 1, name: 'Acme' }, windowDays: 7 } },
    'GET /api/answers': { status: 200, body: { total: 0, page: 1, items: [] } },
    'POST /api/setup': { status: 422, body: { error: { code: 'validation', message: '1 problem(s) — nothing was saved' }, errors: [] } },
    'POST /api/run': { status: 200, body: { status: 'quote_required', calls: 300, estUsd: 2.4, perProvider: [] } },
    'POST /api/alerts/7/ack': { status: 200, body: { ok: true } },
  });
  const mcp = startMcp(backend.url);
  await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);

  const call = (id, name, args) => rpc(mcp, 'tools/call', { name, arguments: args }, id);

  const summary = await call(2, 'hearsay_summary', { days: 7 });
  assert.notEqual(summary.result.isError, true);
  assert.equal(JSON.parse(summary.result.content[0].text).brand.name, 'Acme');
  assert.equal(backend.seen.at(-1).url, '/api/summary?days=7');

  await call(3, 'hearsay_answers_search', { provider: 'perplexity', limit: 10, page: 2 });
  assert.equal(backend.seen.at(-1).url, '/api/answers?provider=perplexity&page=2&per=10');

  const invalid = await call(4, 'hearsay_setup_tracking', { brand: { name: 'X', aliases: ['ab'] } });
  assert.equal(invalid.result.isError, true);
  assert.equal(JSON.parse(invalid.result.content[0].text).error.code, 'validation');

  const quote = await call(5, 'hearsay_run_panel', {});
  assert.notEqual(quote.result.isError, true); // a quote is a successful outcome
  assert.equal(JSON.parse(quote.result.content[0].text).status, 'quote_required');
  assert.equal(JSON.parse(backend.seen.at(-1).body).confirm, false);

  await call(6, 'hearsay_ack_alert', { id: 7 });
  assert.equal(backend.seen.at(-1).url, '/api/alerts/7/ack');

  const unknown = await call(7, 'hearsay_teleport', {});
  assert.equal(unknown.error.code, -32602);

  mcp.kill();
  await backend.close();

  // unreachable backend → isError content, process stays alive
  const dead = startMcp('http://127.0.0.1:9'); // discard port, nothing listens
  await rpc(dead, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
  const down = await rpc(dead, 'tools/call', { name: 'hearsay_status', arguments: {} }, 2);
  assert.equal(down.result.isError, true);
  assert.equal(JSON.parse(down.result.content[0].text).error.code, 'unreachable');
  const pong = await rpc(dead, 'ping', {}, 3);
  assert.deepEqual(pong.result, {}); // still alive
  dead.kill();
});
```

- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Implement** in `dispatch`:

```js
case 'tools/call': {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) {
    replyError(id, -32602, `Unknown tool: ${params?.name}`);
    return;
  }
  const req = tool.call(params?.arguments ?? {});
  /** @param {boolean} isError @param {string} text */
  const content = (isError, text) =>
    reply(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch(HEARSAY_URL + req.path, {
      method: req.method,
      headers: req.body === undefined ? {} : { 'content-type': 'application/json' },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    content(!res.ok, text);
  } catch {
    content(
      true,
      JSON.stringify({
        error: { code: 'unreachable', message: `Hearsay not reachable at ${HEARSAY_URL} — is \`node server.js\` running?` },
      }),
    );
  }
  return;
}
```

(`dispatch` is already `async` and errors already route to stderr + `-32603` from Task 4.)

- [ ] **Step 4: Verify PASS** — full `~/.local/node-lts/bin/node --test`; typecheck clean.
- [ ] **Step 5: Commit** — `git commit -m "feat: MCP tools/call — HTTP dispatch and SPEC error mapping" -- mcp/server.mjs test/mcp.test.js`

---

### Task 7: `skill/SKILL.md` — the operator's brain

**Files:**
- Rewrite: `skill/SKILL.md` with exactly this content (SPEC §5; ≤150 lines — this is ~105):

- [ ] **Step 1: Write the file:**

````markdown
---
name: hearsay-ai-visibility
description: Operate and interpret a local Hearsay AI-visibility tracker via its
  MCP tools (hearsay_*) — set up brand tracking, generate prompt panels, run
  measurements, and report share of AI voice / brand mentions in ChatGPT, Claude,
  Gemini and Perplexity with honest statistics (confidence intervals, n, phrasing
  spread). Use for AI visibility, GEO, AI SEO, LLM brand monitoring questions.
---

# Operating Hearsay

## First move — always

Call `hearsay_status` before anything else, then branch:

- **Unreachable** → tell the human to start it: `node server.js` in the hearsay
  directory (needs Node ≥ 22.5), then retry.
- **`configured: false`** → run the onboarding playbook below.
- **Configured** → answer the question with the *narrowest* tool that holds the
  answer (summary for headlines, intent_results for per-question, answers_search
  for receipts). Don't sweep every tool.

## Onboarding playbook (unconfigured instance)

1. Ask the human at most two questions: their brand (+ domain), and their main
   competitors. Ask for a category description only if it isn't obvious.
2. `hearsay_suggest_prompts` with what you learned.
3. **Show the full draft** — every intent and paraphrase — and ask what to keep.
   **HARD RULE: never call `hearsay_setup_tracking` with prompts the human has
   not seen in this conversation.** The draft is a draft; the human decides.
4. `hearsay_setup_tracking` with the approved set (brand + competitors + intents).
5. `hearsay_run_panel` `{}`. If it returns `quote_required`, relay the calls and
   estimated cost and get an explicit yes before calling again with
   `confirm: true`. **Never confirm spend the human hasn't approved in this
   conversation.**
6. Poll `hearsay_run_status` until `done`, then narrate `hearsay_summary` using
   the honesty rules below.

## Honesty rules (bind your narration, not just the UI)

- Every rate carries its n: "58% ± 7 (n=36)", never "58%".
- When an intent has multiple paraphrases, state the phrasing spread: "phrasing
  spread ±19 pts — how you ask matters more than rerun noise."
- n < 5 → say "low sample, directional at best".
- Days without runs are gaps, not zeros. Never interpolate.
- Demo mode data is fictional — say so every time you quote it.
- **Never invent a blended "AI visibility score", a rank position, or a prompt
  volume estimate — even if asked.** Hearsay refuses these on purpose (they're
  not measurable honestly). Explain that and offer share of voice, mention rate
  with CI, and receipts instead.
- These numbers measure the API surface, not the logged-in consumer apps —
  a documented, directional baseline (see /methodology). Say "directional" when
  the stakes sound high.

## Weekly report recipe

Compose from `hearsay_summary` + `hearsay_intent_results` + `hearsay_alerts` +
`hearsay_citation_gap` + 2–3 receipts from `hearsay_answers_search`:

```
## AI visibility — week of {date}
**Share of AI voice:** {sov}% ({delta} pts vs prior week) · answers analyzed: {n}
**Mention rate:** {p}% ± {ci} (n={n}) {phrasing spread if >1 paraphrase}
**Movers:** {intents with the biggest CI-respecting change, one line each}
**Alerts:** {open alerts, severity + one-line detail each}
**Cited instead of you:** {top 3 gap domains, with counts}
**Receipts:** {2 short answer quotes, provider + date, one good one bad}
```

## Alert triage

- `LOST_RECOMMENDATION` (serious): find the receipt via `hearsay_answers_search`
  (filter to that prompt + provider), quote what the AI says now, suggest checking
  what changed on the cited pages.
- `OVERTAKEN` (warning): compare intent results for you vs that competitor;
  which intents flipped?
- `MENTION_DROP` (warning): check `hearsay_run_status`/provider errors first —
  a failed provider looks like a drop.
- `GAINED_RECOMMENDATION` (good): quote the receipt; note what page got cited.
- Ack with `hearsay_ack_alert` only after the human has seen it.

## GEO playbook (honest version)

- `hearsay_citation_gap` domains are the shortlist: earn citations there
  (guest content, listings, docs) rather than chasing a score.
- For `comparison` intents you lose: a fair, factual comparison page is the
  highest-leverage asset.
- After shipping content: `hearsay_run_panel`, then compare **intent-level**
  numbers before/after — respect the CIs; a within-CI wiggle is not a win.
- Watch competitor prompt-space with `hearsay_prompt_results`: which prompts
  do they lead, and with what recommendation rate?

## Troubleshooting

- Provider `auth`/`quota` errors in status/summary → that provider's key in
  `.env` (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY /
  PERPLEXITY_API_KEY); a provider is enabled iff its key is set.
- `demo_mode` errors → the instance runs fictional demo data; set
  `HEARSAY_DEMO=0` and add a key to go live.
- Keys are only ever spent on measurement runs — reading results is free.

Install: copy this folder to `~/.claude/skills/hearsay-ai-visibility/`.
````

- [ ] **Step 2: Verify** — line count ≤150 (`wc -l skill/SKILL.md`); no tool named here that isn't in Task 5's table (`rg -o "hearsay_[a-z_]+" skill/SKILL.md | sort -u` ⊆ the 13 names).
- [ ] **Step 3: Commit** — `git commit -m "feat: hearsay-ai-visibility operator skill" -- skill/SKILL.md`

---

### Task 8: README agent quickstart

**Files:**
- Modify: `README.md` (add a section after the quickstart block; the full §16 README rewrite belongs to the ship plan, not here)

- [ ] **Step 1: Add:**

````markdown
## Use it from your agent

Hearsay ships an MCP server — your agent brings its own model, so reading
results costs no API keys. With [Claude Code](https://claude.com/claude-code):

```sh
claude mcp add hearsay -- node /absolute/path/to/hearsay/mcp/server.mjs
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "hearsay": { "command": "node", "args": ["/absolute/path/to/hearsay/mcp/server.mjs"] } } }
```

Then just ask: *"How's our AI visibility this week?"* — or, on a fresh install,
*"Set up tracking for Acme vs Jotta and EchoPad"* and the agent will draft your
prompt panel, quote the run cost, and report honest numbers. The optional
operator skill in `skill/` teaches it the full playbook (copy to
`~/.claude/skills/hearsay-ai-visibility/`).

The server reads a running Hearsay at `HEARSAY_URL` (default
`http://127.0.0.1:3000`).
````

- [ ] **Step 2: Commit** — `git commit -m "docs: agent quickstart (MCP registration)" -- README.md`

---

### Task 9: Phase 3 exit gate

- [ ] **Step 1:** Full `~/.local/node-lts/bin/node --test` and `npm run typecheck` — green, ≥ the 196 baseline plus the new mcp/cli suites.
- [ ] **Step 2:** §19.5 #5 round-trip, live: start `HEARSAY_DEMO=1 ~/.local/node-lts/bin/node server.js`, then pipe three JSON-RPC lines (initialize, tools/list, tools/call hearsay_summary) into `HEARSAY_URL=http://127.0.0.1:3000 ~/.local/node-lts/bin/node mcp/server.mjs` and eyeball real demo numbers in the reply.
- [ ] **Step 3:** Zero-dep audit: `rg -n "from ['\"]" -g '*.js' -g '*.mjs' --glob '!node_modules' mcp/ scripts/ | rg -v "node:|\./|\.\./"` → no matches; `package.json` still has no `dependencies` key.
- [ ] **Step 4:** Stdout-purity spot check: `printf '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' | HEARSAY_URL=http://127.0.0.1:9 ~/.local/node-lts/bin/node mcp/server.mjs | head -1` parses as JSON and nothing else lands on stdout.
- [ ] **Step 5:** Commit anything outstanding; report done.

**Left for humans / the ship plan (do NOT do here):** real-client test in Claude Desktop, the onboarding-conversation acceptance run (SPEC §9's gate item), demo GIF + screenshots (`scripts/screenshot.js`), full §16 README/METHODOLOGY rewrite, version tag.
