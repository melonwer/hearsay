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

test('plumbing: /api/status route exists and echoes the package version', { todo: true }, async () => {
  const app = await boot();
  try {
    const { status, body } = await api(app.base, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
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
