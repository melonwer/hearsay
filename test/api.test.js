/**
 * Agent-surface API tests (Phase 2 plan Tasks 2–9) plus the shared boot/api
 * harness the e2e suite reuses. Every test boots a real server on port 0 with a
 * throwaway DB — no live network ever (§15); provider fetch is stubbed via
 * _setFetch() where a test needs a "live-ish" run.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../server.js';
import { buildConfig } from '../core/config.js';
import { run as dbRun } from '../core/db.js';
import { _setFetch } from '../core/providers/shared.js';

after(() => {
  _setFetch(); // restore the real fetch, matching test/providers.test.js
});

/**
 * Boot a server on an ephemeral port with a throwaway DB.
 * @param {Record<string, string>} [env]
 * @returns {Promise<Awaited<ReturnType<typeof startServer>> & {base: string, config: import('../core/config.js').Config}>}
 */
export async function boot(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-api-'));
  const config = buildConfig({ HEARSAY_DB_PATH: join(dir, 'test.db'), ...env });
  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath: config.dbPath, config });
  return { ...app, base: `http://127.0.0.1:${app.port}`, config };
}

/**
 * JSON request helper.
 * @param {string} base @param {string} method @param {string} path @param {unknown} [body]
 * @returns {Promise<{status: number, body: *}>}
 */
export async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('plumbing: /api/status route exists and echoes the package version', async () => {
  const app = await boot();
  try {
    const { status, body } = await api(app.base, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
  } finally {
    await app.close();
  }
});

test('status: empty DB → configured:false, zero counts, null lastRun, no key material', async () => {
  const app = await boot({ OPENAI_API_KEY: 'sk-super-secret-value' });
  try {
    const { status, body } = await api(app.base, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.configured, false);
    assert.deepEqual(body.counts, { entities: 0, intents: 0, activePrompts: 0 });
    assert.equal(body.lastRun, null);
    assert.equal(body.providers.find((/** @type {*} */ p) => p.id === 'openai').enabled, true);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('sk-super-secret-value') && !raw.includes('apiKey') && !raw.includes('maskedKey'));
  } finally {
    await app.close();
  }
});

test('status: configured flips true with a brand and an active prompt', async () => {
  const app = await boot();
  try {
    await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true });
    await api(app.base, 'POST', '/api/prompts', { text: 'best acme-like tool?' });
    const { body } = await api(app.base, 'GET', '/api/status');
    assert.equal(body.configured, true);
    assert.equal(body.counts.activePrompts, 1);
  } finally {
    await app.close();
  }
});

/**
 * Minimal live-ish fixture: one entity, one prompt, one fake-keyed provider. The
 * stubbed fetch sleeps 50ms so a 1-call run is still status='running' when the
 * handler reads the row back one tick after firing (§8 mechanics).
 * @param {Record<string, string>} [env]
 */
async function bootRunnable(env = {}) {
  const app = await boot({ OPENAI_API_KEY: 'test-key-not-real', HEARSAY_SAMPLES: '1', ...env });
  await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true, domains: ['acme.example'] });
  await api(app.base, 'POST', '/api/prompts', { text: 'best acme-like tool?' });
  _setFetch(async () => {
    await sleep(50);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Try Acme.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
        model: 'stub',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return app;
}

test('run gate: below threshold starts immediately with 202 + runId', async () => {
  const app = await bootRunnable({ HEARSAY_CONFIRM_USD: '999' });
  try {
    const { status, body } = await api(app.base, 'POST', '/api/run', {});
    assert.equal(status, 202);
    assert.equal(typeof body.runId, 'number');
  } finally {
    await app.close();
  }
});

test('run gate: HEARSAY_CONFIRM_USD=0 always quotes; confirm:true starts', async () => {
  const app = await bootRunnable({ HEARSAY_CONFIRM_USD: '0' });
  try {
    const quote = await api(app.base, 'POST', '/api/run', {});
    assert.equal(quote.status, 200);
    assert.equal(quote.body.status, 'quote_required');
    assert.equal(typeof quote.body.calls, 'number');
    assert.ok(Array.isArray(quote.body.perProvider));
    // a quote must not have created a run
    assert.equal((await api(app.base, 'GET', '/api/runs/latest')).status, 404);
    const go = await api(app.base, 'POST', '/api/run', { confirm: true });
    assert.equal(go.status, 202);
  } finally {
    await app.close();
  }
});

test('run: zero enabled providers → 400 no_providers, and no empty run row is written', async () => {
  const app = await boot(); // no provider keys
  try {
    await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true });
    await api(app.base, 'POST', '/api/prompts', { text: 'best tool?' });
    // confirm:true bypasses the quote gate — without a guard this wrote a 0-call
    // status='done' run that later shadowed real prior runs in alert evaluation.
    const { status, body } = await api(app.base, 'POST', '/api/run', { confirm: true });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'no_providers');
    assert.equal((await api(app.base, 'GET', '/api/runs/latest')).status, 404);
  } finally {
    await app.close();
  }
});

test('run gate: unknown model cost quotes even below call threshold', async () => {
  const app = await bootRunnable({ OPENAI_MODEL: 'mystery-model-9000', HEARSAY_CONFIRM_USD: '999' });
  try {
    const { status, body } = await api(app.base, 'POST', '/api/run', {});
    assert.equal(status, 200);
    assert.equal(body.status, 'quote_required');
    assert.equal(body.estUsd, null);
  } finally {
    await app.close();
  }
});

test('suggest: zero keys → 200 starter pack, nothing persisted', async () => {
  const app = await boot(); // no provider keys
  try {
    const before = (await api(app.base, 'GET', '/api/prompts')).body.length;
    const { status, body } = await api(app.base, 'POST', '/api/prompts/suggest', {});
    assert.equal(status, 200);
    assert.equal(body.source, 'starter-pack');
    assert.ok(Array.isArray(body.intents) && body.intents.length > 0);
    assert.ok(body.intents.every((/** @type {*} */ i) => typeof i.label === 'string' && Array.isArray(i.paraphrases)));
    assert.equal((await api(app.base, 'GET', '/api/prompts')).body.length, before);
  } finally {
    await app.close();
  }
});

test('setup: happy path creates brand + competitors + intents transactionally', async () => {
  const app = await boot();
  try {
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
  } finally {
    await app.close();
  }
});

test('setup: dedupe-skip on rerun; append paraphrase to existing intent', async () => {
  const app = await boot();
  try {
    const payload = { brand: { name: 'Acme' }, intents: [{ label: 'best tool', paraphrases: ['best tool?'] }] };
    await api(app.base, 'POST', '/api/setup', payload);
    const again = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme' },
      intents: [{ label: 'best tool', paraphrases: ['best tool?', 'which tool is best'] }],
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.created, { entities: 0, intents: 0, prompts: 1 });
    assert.equal(again.body.skipped.length, 2); // brand + duplicate paraphrase
  } finally {
    await app.close();
  }
});

test('setup: validation is all-or-nothing (bad alias → 422, zero writes)', async () => {
  const app = await boot();
  try {
    const { status, body } = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', aliases: ['ab'] },
      intents: [{ label: 'ok', paraphrases: ['ok?'] }],
    });
    assert.equal(status, 422);
    assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
    const s = await api(app.base, 'GET', '/api/status');
    assert.deepEqual(s.body.counts, { entities: 0, intents: 0, activePrompts: 0 });
  } finally {
    await app.close();
  }
});

test('setup: empty body 422; payload-internal domain dupe 422; competitor-name brand 409', async () => {
  const app = await boot();
  try {
    const empty = await api(app.base, 'POST', '/api/setup', {});
    assert.equal(empty.status, 422);
    assert.equal(empty.body.error.code, 'nothing_to_do');

    const dupe = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['same.example'] },
      competitors: [{ name: 'Jotta', domains: ['same.example'] }],
    });
    assert.equal(dupe.status, 422);

    await api(app.base, 'POST', '/api/entities', { name: 'Jotta', is_self: false });
    const promo = await api(app.base, 'POST', '/api/setup', { brand: { name: 'Jotta' } });
    assert.equal(promo.status, 409);
    assert.equal(promo.body.error.code, 'entity_exists');
  } finally {
    await app.close();
  }
});

/**
 * Insert a finished run plus one stored answer directly (FKs are ON, so the whole
 * chain is needed). Returns the response id for hanging mentions/citations off it.
 * @param {import('node:sqlite').DatabaseSync} db @param {number} promptId @param {string} [text]
 * @returns {number|bigint}
 */
function seedResponse(db, promptId, text = 'an answer') {
  const runId = dbRun(
    db,
    "INSERT INTO runs(started_at, finished_at, trigger, status, total_calls, done_calls) VALUES('2026-07-01T00:00:00Z','2026-07-01T00:01:00Z','api','done',1,1)",
  ).lastInsertRowid;
  return dbRun(
    db,
    "INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, created_at) VALUES(?, ?, 'openai', 'test-model', 0, ?, '2026-07-01T00:00:30Z')",
    [runId, promptId, text],
  ).lastInsertRowid;
}

test('entities: PATCH is_self=true on an archived entity is refused, brand stays visible', async () => {
  const app = await boot();
  try {
    await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true });
    const jotta = (await api(app.base, 'POST', '/api/entities', { name: 'Jotta' })).body;
    const prompt = (await api(app.base, 'POST', '/api/prompts', { text: 'best tool?' })).body;
    const responseId = seedResponse(app.db, prompt.id);
    dbRun(
      app.db,
      "INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet) VALUES(?, ?, 0, 1, 1, 0, 'snippet')",
      [responseId, jotta.id],
    );

    const del = await api(app.base, 'DELETE', `/api/entities/${jotta.id}`);
    assert.equal(del.body.archived, true, 'entity with mentions soft-archives');

    // Making a hidden archived row the brand would strip is_self from the live brand
    // and leave the deployment with no visible brand at all.
    const patch = await api(app.base, 'PATCH', `/api/entities/${jotta.id}`, { is_self: true });
    assert.equal(patch.status, 409);

    const status = await api(app.base, 'GET', '/api/status');
    assert.equal(status.body.configured, true, 'the live brand must keep is_self');
  } finally {
    await app.close();
  }
});

test('entities: DELETE of a cited-but-unmentioned entity archives — no dangling citation ids', async () => {
  const app = await boot();
  try {
    // Quillo is cited via its domain but never named in answer text: 0 mentions,
    // 1 citation. The old mentions-only guard hard-deleted it, leaving
    // citations.entity_id (no FK) pointing at a row that no longer exists.
    const quillo = (await api(app.base, 'POST', '/api/entities', { name: 'Quillo', domains: ['quillo.co'] })).body;
    const prompt = (await api(app.base, 'POST', '/api/prompts', { text: 'best tool?' })).body;
    const responseId = seedResponse(app.db, prompt.id);
    dbRun(
      app.db,
      "INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES(?, 'https://quillo.co/docs', 'quillo.co', 1, ?)",
      [responseId, quillo.id],
    );

    const del = await api(app.base, 'DELETE', `/api/entities/${quillo.id}`);
    assert.equal(del.status, 200);
    assert.notEqual(del.body.deleted, true, 'citation receipts must keep their entity');

    // Every citation entity_id in /api/answers must resolve to a real entity.
    const entityIds = new Set((await api(app.base, 'GET', '/api/entities')).body.map((/** @type {*} */ e) => e.id));
    const answers = await api(app.base, 'GET', '/api/answers');
    for (const item of answers.body.items) {
      for (const citation of item.citations) {
        assert.ok(
          citation.entity_id === null || entityIds.has(citation.entity_id),
          `citation entity_id ${citation.entity_id} resolves to no entity`,
        );
      }
    }
  } finally {
    await app.close();
  }
});

test('answers page: a legacy non-http citation never renders as a clickable href', async () => {
  const app = await boot();
  try {
    await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true });
    const prompt = (await api(app.base, 'POST', '/api/prompts', { text: 'best tool?' })).body;
    const responseId = seedResponse(app.db, prompt.id, 'Some answer text with no links.');
    // Simulates a row stored before the analyzer's http(s) allowlist existed.
    dbRun(
      app.db,
      "INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES(?, 'javascript://x/%0aalert(1)', 'x', 1, NULL)",
      [responseId],
    );
    const res = await fetch(`${app.base}/answers`);
    const page = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!page.includes('href="javascript:'), 'stored javascript: URL must not become a link');
  } finally {
    await app.close();
  }
});

test('setup: non-array competitors/intents → 422 validation envelope, not 500', async () => {
  const app = await boot();
  try {
    // Easy agent schema slip: a single object (or a string) where an array belongs.
    for (const payload of [
      { competitors: { name: 'Jotta' } },
      { intents: 'best tool?' },
      { competitors: 42 },
      { intents: [{ label: 'x', paraphrases: 'not-an-array' }] },
    ]) {
      const { status, body } = await api(app.base, 'POST', '/api/setup', payload);
      assert.equal(status, 422, `expected 422 for ${JSON.stringify(payload)}, got ${status}`);
      assert.notEqual(body.error.code, 'internal_error');
    }
    // Zero writes on every one of them.
    const s = await api(app.base, 'GET', '/api/status');
    assert.deepEqual(s.body.counts, { entities: 0, intents: 0, activePrompts: 0 });
  } finally {
    await app.close();
  }
});

test('setup: different existing brand → 409 brand_exists; demo mode → 400', async () => {
  const app = await boot();
  try {
    await api(app.base, 'POST', '/api/entities', { name: 'Notewell', is_self: true });
    const conflict = await api(app.base, 'POST', '/api/setup', { brand: { name: 'Acme' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'brand_exists');
  } finally {
    await app.close();
  }

  const demo = await boot({ HEARSAY_DEMO: '1' });
  try {
    const blocked = await api(demo.base, 'POST', '/api/setup', { brand: { name: 'Acme' } });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'demo_mode');
  } finally {
    await demo.close();
  }
});

test('results routes: arrays with days validation', async () => {
  const app = await boot();
  try {
    for (const path of ['/api/intents/results', '/api/prompts/results']) {
      const ok = await api(app.base, 'GET', path);
      assert.equal(ok.status, 200, `${path} status`);
      assert.ok(Array.isArray(ok.body), `${path} returns array`);
      const bad = await api(app.base, 'GET', `${path}?days=0`);
      assert.equal(bad.status, 400, `${path}?days=0 rejected`);
    }
  } finally {
    await app.close();
  }
});

test('runs/latest: 404 no_runs when no run has ever happened', async () => {
  const app = await boot();
  try {
    const { status, body } = await api(app.base, 'GET', '/api/runs/latest');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'no_runs');
  } finally {
    await app.close();
  }
});

test('config: HEARSAY_CONFIRM_USD parses as float >= 0, default 1', () => {
  assert.equal(buildConfig({}).confirmUsd, 1);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: '0' }).confirmUsd, 0);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: '2.5' }).confirmUsd, 2.5);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: 'garbage' }).confirmUsd, 1);
  assert.equal(buildConfig({ HEARSAY_CONFIRM_USD: '-3' }).confirmUsd, 1);
});
