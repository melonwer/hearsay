/**
 * Hard monthly USD spend cap kill-switch tests.
 * Covers `monthlyApiSpend`, `evaluateSpendCap`, pre-run refusal, mid-run kill-switch,
 * UTC month boundaries, and seeded-run exclusion.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildConfig } from '../core/config.js';
import { evaluateSpendCap, monthlyApiSpend } from '../core/cost.js';
import { all, get, isoNow, openDb, run as dbRun } from '../core/db.js';
import { reviewTrackingPrompt } from '../core/benchmark-draft.js';
import { SKIPPED_SPEND_CAP, SpendCapExceededError, runPanel } from '../core/runner.js';

/**
 * @param {number} [promptCount]
 */
function createTestDb(promptCount = 2) {
  const db = openDb(':memory:');
  const at = isoNow(new Date('2026-11-01T00:00:00Z'));
  dbRun(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, 1, ?)', [
    'Notewell', '[]', '["notewell.io"]', at,
  ]);
  dbRun(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', ['best meeting tool', at]);
  for (let i = 0; i < promptCount; i += 1) {
    const promptId = dbRun(
      db,
      'INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(1, ?, ?, 1, ?)',
      [`prompt ${i}`, 'general', at],
    ).lastInsertRowid;
    reviewTrackingPrompt(db, promptId);
  }
  return db;
}

/**
 * Insert a synthetic historical run + response with explicit cost and timestamp.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{trigger: 'manual'|'cron'|'api'|'seed', createdAt: string, costUsd?: number|null, knownSubtotalUsd?: number|null, reportedChargeUsd?: number|null}} entry
 */
function insertResponse(db, entry) {
  const runId = dbRun(
    db,
    "INSERT INTO runs(started_at, finished_at, trigger, status, total_calls, done_calls) VALUES(?, ?, ?, 'done', 1, 1)",
    [entry.createdAt, entry.createdAt, entry.trigger],
  ).lastInsertRowid;
  dbRun(
    db,
    `INSERT INTO responses(
      run_id, prompt_id, provider, surface, model, sample_idx, text,
      cost_usd, cost_known_subtotal_usd, reported_charge_usd, reported_charge_provenance, created_at
    ) VALUES(?, 1, 'openai', 'openai-api', 'gpt-5.6-luna', 0, 'Notewell.', ?, ?, ?, ?, ?)`,
    [
      runId,
      entry.costUsd ?? null,
      entry.knownSubtotalUsd ?? null,
      entry.reportedChargeUsd ?? null,
      entry.reportedChargeUsd == null ? null : 'provider_reported',
      entry.createdAt,
    ],
  );
}

describe('monthly USD spend cap kill-switch', () => {
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;

  beforeEach(() => {
    db = createTestDb(3);
  });

  afterEach(() => {
    db.close();
  });

  it('parses HEARSAY_MONTHLY_USD_CAP as positive finite number or null', () => {
    assert.equal(buildConfig({}).monthlyUsdCap, null);
    assert.equal(buildConfig({ HEARSAY_MONTHLY_USD_CAP: '' }).monthlyUsdCap, null);
    assert.equal(buildConfig({ HEARSAY_MONTHLY_USD_CAP: '0' }).monthlyUsdCap, null);
    assert.equal(buildConfig({ HEARSAY_MONTHLY_USD_CAP: '-10' }).monthlyUsdCap, null);
    assert.equal(buildConfig({ HEARSAY_MONTHLY_USD_CAP: 'not-a-number' }).monthlyUsdCap, null);
    assert.equal(buildConfig({ HEARSAY_MONTHLY_USD_CAP: '25.5' }).monthlyUsdCap, 25.5);
  });

  it('monthlyApiSpend aggregates current UTC month live runs and ignores seeded & other-month runs', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    // Current UTC month live runs:
    insertResponse(db, { trigger: 'manual', createdAt: '2026-11-01T00:00:00Z', costUsd: 1.25 });
    insertResponse(db, { trigger: 'cron', createdAt: '2026-11-10T08:00:00Z', costUsd: null, knownSubtotalUsd: 0.75 });
    insertResponse(db, { trigger: 'api', createdAt: '2026-11-30T23:59:59Z', costUsd: null, reportedChargeUsd: 0.50 });
    // Seeded run in the same month MUST be ignored:
    insertResponse(db, { trigger: 'seed', createdAt: '2026-11-05T12:00:00Z', costUsd: 999.99 });
    // Prior month & next month MUST be ignored:
    insertResponse(db, { trigger: 'manual', createdAt: '2026-10-31T23:59:59Z', costUsd: 50.00 });
    insertResponse(db, { trigger: 'manual', createdAt: '2026-12-01T00:00:00Z', costUsd: 75.00 });

    const spent = monthlyApiSpend(db, now);
    assert.ok(Math.abs(spent - 2.5) < 1e-12, `expected $2.50, got ${spent}`);

    // December rollover check:
    const decSpent = monthlyApiSpend(db, new Date('2026-12-02T00:00:00Z'));
    assert.ok(Math.abs(decSpent - 75.0) < 1e-12, `expected $75.00, got ${decSpent}`);
  });

  it('evaluateSpendCap returns allowed vs blocked with accurate spent/projected/remaining fields', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    insertResponse(db, { trigger: 'manual', createdAt: '2026-11-02T10:00:00Z', costUsd: 8.0 });

    const uncapped = evaluateSpendCap(db, { additionalEstimatedUsd: 50, monthlyUsdCap: null, now });
    assert.deepEqual(uncapped, {
      allowed: true,
      spentUsd: 8,
      projectedUsd: 58,
      capUsd: null,
      remainingUsd: null,
      reason: null,
    });

    const allowed = evaluateSpendCap(db, { additionalEstimatedUsd: 2.0, monthlyUsdCap: 10.0, now });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.spentUsd, 8);
    assert.equal(allowed.projectedUsd, 10);
    assert.equal(allowed.capUsd, 10);
    assert.equal(allowed.remainingUsd, 2);
    assert.equal(allowed.reason, null);

    const blocked = evaluateSpendCap(db, { additionalEstimatedUsd: 2.01, monthlyUsdCap: 10.0, now });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.spentUsd, 8);
    assert.ok(Math.abs(blocked.projectedUsd - 10.01) < 1e-12);
    assert.equal(blocked.capUsd, 10);
    assert.equal(blocked.remainingUsd, 2);
    assert.equal(blocked.reason, 'spend_cap_exceeded');
  });

  it('blocks a live run before creation when spend + estimate exceeds monthlyUsdCap', async () => {
    const nowDate = new Date('2026-11-15T12:00:00Z');
    insertResponse(db, { trigger: 'manual', createdAt: '2026-11-10T10:00:00Z', costUsd: 4.999 });
    const runsBefore = Number(get(db, 'SELECT COUNT(*) AS n FROM runs')?.n);
    let adapterCalls = 0;

    const cfg = buildConfig({
      OPENAI_API_KEY: 'sk-fixture',
      HEARSAY_SAMPLES: '1',
      HEARSAY_MONTHLY_USD_CAP: '5.00',
    });

    const err = await runPanel({
      db,
      config: cfg,
      now: () => nowDate,
      adapters: {
        openai: {
          async runPrompt() {
            adapterCalls += 1;
            return { text: 'Notewell.', model: 'gpt-5.6-luna', latencyMs: 5, tokens: { input: 200, output: 500 } };
          },
        },
      },
      analyzeResponse: () => ({ mentions: [], citations: [] }),
      evaluateAlerts: () => {},
      env: {},
      log: () => {},
    }).catch((e) => e);

    assert.ok(err instanceof SpendCapExceededError);
    assert.equal(err.code, 'spend_cap_exceeded');
    assert.equal(err.evaluation.reason, 'spend_cap_exceeded');
    assert.equal(adapterCalls, 0, 'provider must never be called when pre-run cap is exceeded');
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM runs')?.n), runsBefore, 'no run row should be created');
  });

  it('ignores seeded runs when enforcing monthlyUsdCap on a live run', async () => {
    const nowDate = new Date('2026-11-15T12:00:00Z');
    // Massive seeded spend should NOT block a live run:
    insertResponse(db, { trigger: 'seed', createdAt: '2026-11-05T10:00:00Z', costUsd: 500.0 });

    const cfg = buildConfig({
      OPENAI_API_KEY: 'sk-fixture',
      HEARSAY_SAMPLES: '1',
      HEARSAY_MONTHLY_USD_CAP: '1.00',
    });

    const summary = await runPanel({
      db,
      config: cfg,
      now: () => nowDate,
      adapters: {
        openai: {
          async runPrompt() {
            return { text: 'Notewell.', model: 'gpt-5.6-luna', latencyMs: 5, tokens: { input: 200, output: 500 } };
          },
        },
      },
      analyzeResponse: () => ({ mentions: [], citations: [] }),
      evaluateAlerts: () => {},
      env: {},
      log: () => {},
    });

    assert.equal(summary.status, 'done');
    assert.equal(summary.okCalls, 3);
    assert.equal(summary.skippedCalls, 0);
  });

  it('stops remaining targets mid-run with spend_cap_exceeded when cumulative spend crosses cap', async () => {
    const nowDate = new Date('2026-11-15T12:00:00Z');
    let adapterCalls = 0;

    // 3 prompts × 1 sample × openai default estimate (~$0.00064 each = ~$0.00192 total),
    // so pre-run estimate passes a $0.01 cap. Target #1 actually uses 10,000 output tokens
    // ($0.012 on gpt-5.6-luna), pushing cumulative spend past $0.01 so targets #2 and #3 stop.
    const cfg = buildConfig({
      OPENAI_API_KEY: 'sk-fixture',
      HEARSAY_SAMPLES: '1',
      HEARSAY_CONCURRENCY: '1',
      HEARSAY_MONTHLY_USD_CAP: '0.01',
    });

    const summary = await runPanel({
      db,
      config: cfg,
      now: () => nowDate,
      adapters: {
        openai: {
          async runPrompt() {
            adapterCalls += 1;
            return {
              text: 'Notewell is a thorough recommendation.',
              model: 'gpt-5.6-luna',
              latencyMs: 10,
              tokens: { input: 500, output: 10000 },
            };
          },
        },
      },
      analyzeResponse: () => ({ mentions: [], citations: [] }),
      evaluateAlerts: () => {},
      env: {},
      log: () => {},
    });

    assert.equal(adapterCalls, 1, 'remaining targets must be physically prevented from calling the provider');
    assert.equal(summary.okCalls, 1);
    assert.equal(summary.skippedCalls, 2);
    assert.equal(summary.doneCalls, 3);
    assert.equal(summary.attemptedCalls, 1);

    const rows = all(
      db,
      'SELECT target_status, safe_error_code, error, comparability_reason, cost_usd FROM responses WHERE run_id = ? ORDER BY id',
      [summary.runId],
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0].target_status, 'completed');
    assert.ok(Number(rows[0].cost_usd) > 0.01);
    for (const stopped of rows.slice(1)) {
      assert.equal(stopped.target_status, 'failed');
      assert.equal(stopped.safe_error_code, 'spend_cap_exceeded');
      assert.equal(stopped.error, SKIPPED_SPEND_CAP);
      assert.equal(stopped.comparability_reason, 'spend_cap_exceeded');
    }
  });
});
