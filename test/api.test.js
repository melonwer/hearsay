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
import { get, run as dbRun } from '../core/db.js';
import { _setFetch } from '../core/providers/shared.js';
import { isRunning } from '../core/runner.js';

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
    assert.equal(quote.body.executionBudgets[0].searchPolicy, 'off');
    assert.equal(quote.body.executionBudgets[0].maxSearchCalls, 0);
    // a quote must not have created a run
    assert.equal((await api(app.base, 'GET', '/api/runs/latest')).status, 404);
    const go = await api(app.base, 'POST', '/api/run', { confirm: true, quote_id: quote.body.quoteId });
    assert.equal(go.status, 202);
  } finally {
    await app.close();
  }
});

test('OpenAI search run requires its forecast quote and persists separate evidence', async () => {
  for (let attempt = 0; attempt < 100 && isRunning(); attempt += 1) await sleep(20);
  assert.equal(isRunning(), false);
  const app = await bootRunnable({ HEARSAY_OPENAI_SEARCH_POLICY: 'required', HEARSAY_CONFIRM_USD: '999' });
  let providerCalls = 0;
  _setFetch(async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ model: 'gpt-5.6-luna', status: 'completed',
      usage: { input_tokens: 120, output_tokens: 74 },
      output: [
        { id: 'search_one', type: 'web_search_call', status: 'completed',
          action: { type: 'search', query: 'best tracker',
            sources: [{ url: 'https://example.org/source', title: 'Source' }] } },
        { type: 'message', status: 'completed', content: [{ type: 'output_text',
          text: 'Try Acme.', annotations: [{ type: 'url_citation',
            url: 'https://example.net/citation', start_index: 4, end_index: 9 }] }] },
      ] }), { status: 200 });
  });
  try {
    const quote = await api(app.base, 'POST', '/api/run', {});
    assert.equal(quote.status, 200);
    assert.equal(quote.body.status, 'quote_required');
    assert.equal(quote.body.hasUnboundedSearch, true);
    assert.equal(quote.body.perProvider[0].assumedSearchCalls, 1);
    assert.equal(quote.body.perProvider[0].searchToolUsd, 0.01);
    assert.equal(providerCalls, 0);
    const started = await api(app.base, 'POST', '/api/run', {
      confirm: true, quote_id: quote.body.quoteId,
    });
    assert.equal(started.status, 202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (get(app.db, 'SELECT status FROM runs WHERE id = ?', [started.body.runId])?.status === 'done') break;
      await sleep(20);
    }
    assert.equal(providerCalls, 1);
    const response = get(app.db, 'SELECT id, web_status, search_policy, cost_usd, comparability_status FROM responses WHERE run_id = ?', [started.body.runId]);
    assert.equal(response?.web_status, 'verified');
    assert.equal(response?.search_policy, 'required');
    assert.equal(response?.comparability_status, 'comparable');
    assert.ok(Math.abs(Number(response?.cost_usd) - 0.0101128) < 1e-12);
    assert.equal(Number(get(app.db, 'SELECT COUNT(*) AS count FROM search_events WHERE response_id = ?', [response?.id])?.count), 1);
    assert.equal(Number(get(app.db, 'SELECT COUNT(*) AS count FROM source_observations WHERE response_id = ?', [response?.id])?.count), 1);
    assert.equal(Number(get(app.db, 'SELECT COUNT(*) AS count FROM answer_citations WHERE response_id = ? AND source_observation_id IS NULL', [response?.id])?.count), 1);
    const answer = (await api(app.base, 'GET', '/api/answers')).body.items.find((item) => item.id === response?.id);
    assert.deepEqual(answer.search_events[0].queries, ['best tracker']);
    assert.equal(answer.source_observations[0].url, 'https://example.org/source');
    assert.equal(answer.answer_citations[0].url, 'https://example.net/citation');
    const page = await fetch(`${app.base}/answers`).then((result) => result.text());
    assert.match(page, /Reported sources/);
    assert.match(page, /https:\/\/example\.net\/citation/);
  } finally {
    await app.close();
  }
});

test('daily API search needs separate recurring consent and invalidates changed selections', async () => {
  const app = await bootRunnable({ HEARSAY_OPENAI_SEARCH_POLICY: 'required' });
  try {
    const before = await api(app.base, 'GET', '/api/search-schedule');
    assert.equal(before.body.approved, false);
    const preview = await api(app.base, 'POST', '/api/search-schedule', { target_ceiling: 1 });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.status, 'schedule_confirmation_required');
    assert.equal(preview.body.hasUnboundedSearch, true);
    dbRun(app.db, 'UPDATE prompts SET text = ? WHERE active = 1', ['Changed after preview']);
    const stale = await api(app.base, 'POST', '/api/search-schedule', {
      target_ceiling: 1, confirm: true, quote_id: preview.body.quoteId,
    });
    assert.equal(stale.status, 409);
    const fresh = await api(app.base, 'POST', '/api/search-schedule', { target_ceiling: 1 });
    const enabled = await api(app.base, 'POST', '/api/search-schedule', {
      target_ceiling: 1, confirm: true, quote_id: fresh.body.quoteId,
    });
    assert.equal(enabled.status, 201);
    assert.equal((await api(app.base, 'GET', '/api/search-schedule')).body.approved, true);
    await api(app.base, 'POST', '/api/prompts', { text: 'another question?' });
    assert.equal((await api(app.base, 'GET', '/api/search-schedule')).body.approved, false);
    assert.equal((await api(app.base, 'DELETE', '/api/search-schedule')).body.disabled, true);
  } finally {
    await app.close();
  }
});

test('bounded Anthropic search still requires an on-demand quote and separate schedule consent', async () => {
  const app = await bootRunnable({ ANTHROPIC_API_KEY: 'fixture-key',
    HEARSAY_ANTHROPIC_SEARCH_POLICY: 'auto', HEARSAY_CONFIRM_USD: '999' });
  try {
    const quote = await api(app.base, 'POST', '/api/run', {});
    assert.equal(quote.body.status, 'quote_required');
    assert.equal(quote.body.hasSearch, true);
    assert.equal(quote.body.hasUnboundedSearch, false);
    const budget = quote.body.executionBudgets.find((item) => item.surface === 'anthropic-api');
    assert.equal(budget.maxSearchCalls, 3);
    assert.equal(budget.maxContinuations, 1);
    const schedule = await api(app.base, 'POST', '/api/search-schedule', { target_ceiling: 2 });
    assert.equal(schedule.body.status, 'schedule_confirmation_required');
  } finally { await app.close(); }
});

test('Anthropic web-search run persists linked result and final citation with priced usage', async () => {
  for (let attempt = 0; attempt < 100 && isRunning(); attempt += 1) await sleep(20);
  assert.equal(isRunning(), false);
  const app = await boot({ ANTHROPIC_API_KEY: 'fixture-key', HEARSAY_ANTHROPIC_SEARCH_POLICY: 'auto',
    HEARSAY_SAMPLES: '1', HEARSAY_CONFIRM_USD: '999' });
  await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true });
  await api(app.base, 'POST', '/api/prompts', { text: 'best tracker?' });
  assert.equal(Number(get(app.db, 'SELECT COUNT(*) AS n FROM prompts WHERE active = 1')?.n), 1);
  let providerCalls = 0;
  _setFetch(async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ model: 'claude-sonnet-5', stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 60,
        server_tool_use: { web_search_requests: 1 } },
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'best tracker' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
          { type: 'web_search_result', url: 'https://example.org/source', title: 'Source',
            encrypted_content: 'fixture-encrypted' },
        ] },
        { type: 'text', text: 'Try Acme.', citations: [
          { type: 'web_search_result_location', url: 'https://example.org/source',
            title: 'Source', encrypted_index: 'fixture-index' },
        ] },
      ] }), { status: 200 });
  });
  try {
    const quote = await api(app.base, 'POST', '/api/run', {});
    assert.equal(quote.body.status, 'quote_required');
    assert.equal(providerCalls, 0);
    const started = await api(app.base, 'POST', '/api/run', { confirm: true,
      quote_id: quote.body.quoteId });
    assert.equal(started.status, 202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (get(app.db, 'SELECT status FROM runs WHERE id = ?', [started.body.runId])?.status === 'done') break;
      await sleep(20);
    }
    const row = get(app.db, 'SELECT id, web_status, comparability_status, cost_usd, error FROM responses WHERE run_id = ?', [started.body.runId]);
    assert.equal(providerCalls, 1, JSON.stringify({ run: get(app.db, 'SELECT status, error FROM runs WHERE id = ?', [started.body.runId]), row }));
    assert.equal(row?.web_status, 'verified');
    assert.equal(row?.comparability_status, 'comparable');
    assert.ok(Math.abs(Number(row?.cost_usd) - 0.0108) < 1e-12);
    assert.equal(Number(get(app.db, `SELECT COUNT(*) AS n FROM answer_citations ac
      JOIN source_observations so ON so.id = ac.source_observation_id
      WHERE ac.response_id = ? AND ac.url = so.url`, [row?.id])?.n), 1);
  } finally { await app.close(); }
});

test('API confirmation rejects a quote after the approved prompt changes', async () => {
  const app = await bootRunnable({ HEARSAY_CONFIRM_USD: '0' });
  try {
    const quote = await api(app.base, 'POST', '/api/run', {});
    assert.match(quote.body.quoteId, /^[a-f0-9]{64}$/);
    dbRun(app.db, 'UPDATE prompts SET text = ? WHERE active = 1', ['Edited after the quote']);
    const stale = await api(app.base, 'POST', '/api/run', { confirm: true, quote_id: quote.body.quoteId });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'stale_quote');
    assert.equal((await api(app.base, 'GET', '/api/runs/latest')).status, 404);
    const fresh = await api(app.base, 'POST', '/api/run', {});
    assert.notEqual(fresh.body.quoteId, quote.body.quoteId);
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

test('run quote uses configured price overrides for an unlisted model', async () => {
  const app = await bootRunnable({
    OPENAI_MODEL: 'private-deployment-1', HEARSAY_CONFIRM_USD: '0',
    HEARSAY_PRICE_OPENAI_IN: '3', HEARSAY_PRICE_OPENAI_OUT: '7',
  });
  try {
    const { status, body } = await api(app.base, 'POST', '/api/run', {});
    assert.equal(status, 200);
    assert.equal(body.costStatus, 'known');
    assert.equal(body.estUsd, 0.0041);
    assert.equal(body.unpriced.length, 0);
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

test('suggest: with a key, the first enabled provider drafts — competitors included', async () => {
  const app = await boot({ OPENAI_API_KEY: 'sk-test-suggest' });
  try {
    await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['acme.example'] },
      competitors: [{ name: 'Jotta', domains: ['jotta.example'] }],
    });
    /** @type {{url: string, body: string}[]} */
    const calls = [];
    const draft = {
      intents: [{ label: 'best acme-like tool', category: 'general', paraphrases: ['best tool?', 'top tools 2026', 'which tool should I pick?'] }],
    };
    _setFetch(async (url, init = {}) => {
      calls.push({ url: String(url), body: String(init.body ?? '') });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { status, body } = await api(app.base, 'POST', '/api/prompts/suggest', { category_hint: 'meeting notes' });
    assert.equal(status, 200);
    assert.equal(body.source, 'llm');
    assert.equal(body.intents.length, 1);
    assert.equal(body.intents[0].label, 'best acme-like tool');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('api.openai.com'));
    // The §6.7 drafting prompt must carry the tracked competitors, not just the brand.
    assert.match(String(JSON.parse(calls[0].body).messages[0].content), /Competitors: Jotta/);
    assert.equal((await api(app.base, 'GET', '/api/prompts')).body.length, 0); // draft only
  } finally {
    _setFetch();
    await app.close();
  }
});

test('suggest: provider failure falls back to the starter pack, labeled honestly', async () => {
  const app = await boot({ OPENAI_API_KEY: 'sk-test-suggest' });
  try {
    await api(app.base, 'POST', '/api/setup', { brand: { name: 'Acme' }, competitors: [{ name: 'Jotta' }] });
    // 401 classifies as auth without a retry, so no backoff sleep in the test.
    _setFetch(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    const { status, body } = await api(app.base, 'POST', '/api/prompts/suggest', {});
    assert.equal(status, 200);
    assert.equal(body.source, 'starter-pack');
    assert.equal(body.reason, 'provider-error');
    // The fallback pack sees the tracked rival too, not a {Competitor} placeholder.
    assert.ok(body.intents.some((/** @type {*} */ i) => String(i.label).includes('Jotta')));
  } finally {
    _setFetch();
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

test('boot: stale running runs (>2h) are marked failed at startup (§8.1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-boot-'));
  const dbPath = join(dir, 'boot.db');
  // Simulate a crash mid-run: a 'running' row three hours old, left in the DB file.
  const { openDb } = await import('../core/db.js');
  const pre = openDb(dbPath);
  const started = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  dbRun(pre, "INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?, 'api', 'running', 8, 3)", [
    started,
  ]);
  pre.close();

  const config = buildConfig({ HEARSAY_DB_PATH: dbPath });
  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath, config });
  try {
    const { status, body } = await api(`http://127.0.0.1:${app.port}`, 'GET', '/api/runs/latest');
    assert.equal(status, 200);
    assert.equal(body.status, 'failed', 'orphaned running row must be recovered at boot');
  } finally {
    await app.close();
  }
});

test('boot: scheduler starts with keys (with a next-run log line), stays off for demo/keyless (§8.2)', async () => {
  /** @type {string[]} */
  const logs = [];
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-sched-'));
  const config = buildConfig({ HEARSAY_DB_PATH: join(dir, 's.db'), OPENAI_API_KEY: 'k' });
  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath: config.dbPath, config, log: (m) => logs.push(m) });
  try {
    assert.equal(app.scheduler?.enabled, true);
    assert.ok(
      logs.some((m) => /next panel run/.test(m) && m.includes(config.runAt)),
      `boot log must state the next run time, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    await app.close();
  }

  const demo = await boot({ HEARSAY_DEMO: '1', OPENAI_API_KEY: 'k' });
  try {
    assert.equal(demo.scheduler?.enabled, false);
  } finally {
    await demo.close();
  }
  const keyless = await boot();
  try {
    assert.equal(keyless.scheduler?.enabled, false);
  } finally {
    await keyless.close();
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

test('answer history keeps the response prompt snapshot after the tracked prompt is edited', async () => {
  const app = await boot();
  try {
    await api(app.base, 'POST', '/api/entities', { name: 'Acme', is_self: true });
    const prompt = (await api(app.base, 'POST', '/api/prompts', { text: 'Which notes tool did buyers ask about?' })).body;
    const responseId = seedResponse(app.db, prompt.id, 'The historical answer.');
    dbRun(app.db, 'UPDATE responses SET prompt_text_snapshot = ? WHERE id = ?', ['Which notes tool did buyers ask about?', responseId]);
    dbRun(app.db, 'UPDATE prompts SET text = ? WHERE id = ?', ['Which calendar tool is current?', prompt.id]);

    const answers = await api(app.base, 'GET', '/api/answers?days=365');
    assert.equal(answers.status, 200);
    assert.equal(answers.body.items[0].prompt, 'Which notes tool did buyers ask about?');

    const page = await (await fetch(`${app.base}/answers?days=365`)).text();
    const answerPrompt = page.match(/<p class="answer-prompt">([^<]+)<\/p>/)?.[1];
    assert.equal(answerPrompt, 'Which notes tool did buyers ask about?');
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

test('subscription preview and run quote expose exact agent surface without API keys', async () => {
  const app = await boot({ HEARSAY_CODEX_ENABLED: '1' });
  try {
    const setup = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['acme.example'] },
      intents: [{ label: 'best tracker', paraphrases: ['Which tracker is best?'] }],
    });
    assert.equal(setup.status, 200);
    const preview = await api(app.base, 'POST', '/api/subscription/preview', { surfaces: ['codex-agent'], samples: 2 });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.totalTargets, 2);
    assert.equal(preview.body.perSurface[0].surface, 'codex-agent');
    assert.equal(preview.body.usageModel, 'included_plan_allowance_or_overage');
    assert.equal(preview.body.executionBudgets[0].maxSearchCalls, null);
    assert.equal(preview.body.executionBudgets[0].searchCallLimitEnforced, false);
    const quote = await api(app.base, 'POST', '/api/subscription/run', { surfaces: ['codex-agent'] });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.status, 'quote_required');
    assert.equal(quote.body.firstUseSurfaces[0], 'codex-agent');
  } finally {
    await app.close();
  }
});

test('subscription consent rejects a stale question quote before any CLI work', async () => {
  const app = await boot({ HEARSAY_CODEX_ENABLED: '1' });
  try {
    await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['acme.example'] },
      intents: [{ label: 'best tracker', paraphrases: ['Which tracker is best?'] }],
    });
    const quote = await api(app.base, 'POST', '/api/subscription/run', { surfaces: ['codex-agent'] });
    dbRun(app.db, 'UPDATE prompts SET text = ? WHERE active = 1', ['Which edited tracker is best?']);
    const stale = await api(app.base, 'POST', '/api/subscription/run', {
      surfaces: ['codex-agent'], confirm: true, quote_id: quote.body.quoteId,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'stale_quote');
    assert.equal((await api(app.base, 'GET', '/api/runs/latest')).status, 404);
  } finally {
    await app.close();
  }
});

test('subscription cancellation is available through HTTP and the settings UI', async () => {
  const app = await boot({
    HEARSAY_CODEX_ENABLED: '1',
    HEARSAY_CODEX_PATH: join(process.cwd(), 'test-support', 'fake-subscription-cli.mjs'),
    HEARSAY_SUBSCRIPTION_TIMEOUT_MS: '5000',
    HEARSAY_SUBSCRIPTION_IDLE_TIMEOUT_MS: '5000',
  });
  try {
    const setup = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['acme.example'] },
      intents: [{ label: 'best tracker', paraphrases: ['Which tracker is best?'] }],
    });
    assert.equal(setup.status, 200);

    const started = await api(app.base, 'POST', '/api/subscription/run', {
      surfaces: ['codex-agent'],
      confirm: true,
      quote_id: (await api(app.base, 'POST', '/api/subscription/preview', { surfaces: ['codex-agent'] })).body.quoteId,
    });
    assert.equal(started.status, 202);
    assert.equal(typeof started.body.runId, 'number');

    const settings = await fetch(`${app.base}/settings`).then((response) => response.text());
    assert.match(settings, new RegExp(`data-subscription-cancel="${started.body.runId}"`));

    const cancelled = await api(app.base, 'POST', `/api/subscription/runs/${started.body.runId}/cancel`, {});
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.status, 'cancellation_requested');

    let latest;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      latest = await api(app.base, 'GET', '/api/runs/latest');
      if (latest.body?.status !== 'running') break;
      await sleep(20);
    }
    assert.equal(latest.body.status, 'cancelled');
  } finally {
    await app.close();
  }
});

test('exploration prompts are persisted separately and promote explicitly', async () => {
  const app = await boot();
  try {
    const setup = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['acme.example'] },
      intents: [{ label: 'best tracker', paraphrases: ['Which tracker is best?'] }],
    });
    assert.equal(setup.status, 200);
    const exploration = await api(app.base, 'POST', '/api/prompts/exploration', { text: 'What should a small team compare?', origin: 'user_authored' });
    assert.equal(exploration.status, 201);
    assert.equal(exploration.body.tracking_state, 'exploration');
    assert.equal(exploration.body.active, 0);
    const intentId = Number(get(app.db, 'SELECT id FROM intents WHERE label = ?', ['best tracker'])?.id);
    const promoted = await api(app.base, 'POST', `/api/prompts/${exploration.body.id}/promote`, { intent_id: intentId });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.tracking_state, 'tracking');
    assert.equal(promoted.body.active, 1);
  } finally {
    await app.close();
  }
});

test('subscription schedule requires separate consent and stores the local-time ceiling', async () => {
  const app = await boot({ HEARSAY_CODEX_ENABLED: '1' });
  try {
    const setup = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['acme.example'] },
      intents: [{ label: 'best tracker', paraphrases: ['Which tracker is best?'] }],
    });
    assert.equal(setup.status, 200);
    const promptId = Number(get(app.db, 'SELECT id FROM prompts LIMIT 1')?.id);
    const preview = await api(app.base, 'POST', '/api/subscription/schedule', {
      run_at: '07:00',
      timezone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      prompt_ids: [promptId],
      samples: 1,
      target_ceiling: 1,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.status, 'schedule_confirmation_required');
    assert.equal((await api(app.base, 'GET', '/api/subscription/schedule')).body, null);
    const stale = await api(app.base, 'POST', '/api/subscription/schedule', {
      run_at: '08:00', timezone: 'Europe/Berlin', surfaces: ['codex-agent'],
      lane: 'tracking', prompt_ids: [promptId], samples: 1, target_ceiling: 1,
      confirm: true, quote_id: preview.body.quoteId,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'stale_quote');

    const runId = Number(dbRun(app.db, "INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?,?,?,?,?)", ['2026-08-09T00:00:00Z', 'manual', 'done', 1, 1]).lastInsertRowid);
    dbRun(app.db, `INSERT INTO responses(
      run_id, prompt_id, provider, surface, model, sample_idx, text, created_at,
      lane, target_status, comparability_status, web_status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      runId, promptId, 'openai', 'codex-agent', 'default', 0, 'Acme', '2026-08-09T00:00:00Z',
      'tracking', 'completed', 'comparable', 'verified',
    ]);
    const saved = await api(app.base, 'POST', '/api/subscription/schedule', {
      run_at: '07:00',
      timezone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      prompt_ids: [promptId],
      samples: 1,
      target_ceiling: 1,
      confirm: true,
      quote_id: preview.body.quoteId,
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.timeZone, 'Europe/Berlin');
    assert.equal(saved.body.targetCeiling, 1);
    assert.match(saved.body.revisionHash, /^[a-f0-9]{64}$/);
    const deleted = await api(app.base, 'DELETE', '/api/subscription/schedule');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.disabled, true);
  } finally {
    await app.close();
  }
});

test('subscription scheduling does not accept verified results from a cron run', async () => {
  const app = await boot({ HEARSAY_CODEX_ENABLED: '1' });
  try {
    const setup = await api(app.base, 'POST', '/api/setup', {
      brand: { name: 'Acme', domains: ['acme.example'] },
      intents: [{ label: 'best tracker', paraphrases: ['Which tracker is best?'] }],
    });
    assert.equal(setup.status, 200);
    const promptId = Number(get(app.db, 'SELECT id FROM prompts LIMIT 1')?.id);
    const runId = Number(dbRun(app.db, "INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?,?,?,?,?)", [
      '2026-08-09T00:00:00Z', 'cron', 'done', 1, 1,
    ]).lastInsertRowid);
    dbRun(app.db, `INSERT INTO responses(
      run_id, prompt_id, provider, surface, model, sample_idx, text, created_at,
      lane, target_status, comparability_status, web_status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      runId, promptId, 'openai', 'codex-agent', 'default', 0, 'Acme', '2026-08-09T00:00:00Z',
      'tracking', 'completed', 'comparable', 'verified',
    ]);

    const scheduleBody = {
      run_at: '07:00',
      timezone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      prompt_ids: [promptId],
      samples: 1,
      target_ceiling: 1,
    };
    const preview = await api(app.base, 'POST', '/api/subscription/schedule', scheduleBody);
    const rejected = await api(app.base, 'POST', '/api/subscription/schedule', { ...scheduleBody, confirm: true, quote_id: preview.body.quoteId });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, 'schedule_prerequisite_missing');
  } finally {
    await app.close();
  }
});
