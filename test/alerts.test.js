/**
 * Alert rule tests (§9, §15) — each rule fires, each rule's negative stays quiet, the
 * 7-day dedup holds, and the recommendation rules refuse to speak without two prior runs.
 *
 * Hand-built mini database in a temp file; every response is written sample by sample so
 * the "3/3 → 0/3" arithmetic in an alert's detail can be checked against the fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, run as exec } from '../core/db.js';
import { evaluate } from '../core/alerts.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

const BRAND = 1;
const RIVAL = 2;

/**
 * @param {import('node:test').TestContext} t
 * @returns {Db}
 */
function newDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-alerts-'));
  const db = openDb(join(dir, 'hearsay.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  exec(db, 'INSERT INTO entities(id, name, aliases, domains, is_self, created_at) VALUES(?,?,?,?,?,?)', [
    BRAND,
    'Notewell',
    '[]',
    '["notewell.io"]',
    1,
    '2026-07-01T00:00:00Z',
  ]);
  exec(db, 'INSERT INTO entities(id, name, aliases, domains, is_self, created_at) VALUES(?,?,?,?,?,?)', [
    RIVAL,
    'Jotta',
    '[]',
    '["jotta.app"]',
    0,
    '2026-07-01T00:00:00Z',
  ]);
  exec(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'best AI meeting notes tool', '2026-07-01T00:00:00Z']);
  return db;
}

/**
 * @param {Db} db
 * @param {number} id
 * @param {string} text
 */
function addPrompt(db, id, text) {
  exec(db, 'INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES(?,?,?,?,1,?)', [
    id,
    1,
    text,
    'general',
    '2026-07-01T00:00:00Z',
  ]);
}

/**
 * @param {Db} db
 * @param {{id:number, at:string, trigger?:string, status?:string}} runRow
 */
function addRun(db, runRow) {
  exec(db, 'INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls) VALUES(?,?,?,?,?,0,0)', [
    runRow.id,
    runRow.at,
    runRow.at,
    runRow.trigger ?? 'manual',
    runRow.status ?? 'done',
  ]);
}

/** @param {Db} db */
function addTrackingDefinition(db) {
  exec(db, 'INSERT INTO benchmark_revisions(id, snapshot_json, created_at) VALUES(?,?,?)', [
    'test-benchmark', '{}', '2026-07-01T00:00:00Z',
  ]);
}

/**
 * Write one response per sample.
 *
 * `rec`     brand mentioned and flagged recommended (§6.4)
 * `mention` brand mentioned, not recommended
 * `rival`   competitor mentioned instead
 * `empty`   nobody mentioned
 *
 * @param {Db} db
 * @param {{runId:number, promptId:number, provider:string, at:string, samples:('rec'|'mention'|'rival'|'empty')[]}} spec
 */
function addSamples(db, spec) {
  spec.samples.forEach((sample, index) => {
    const inserted = exec(
      db,
      `INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, latency_ms, error, created_at)
       VALUES(?,?,?,?,?,?,?,NULL,?)`,
      [spec.runId, spec.promptId, spec.provider, 'test-model', index, 'answer text', 100, spec.at],
    );
    const entityId = sample === 'rival' ? RIVAL : sample === 'empty' ? null : BRAND;
    if (entityId === null) return;
    exec(
      db,
      'INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet) VALUES(?,?,?,?,?,?,?)',
      [inserted.lastInsertRowid, entityId, 0, 1, 1, sample === 'rec' ? 1 : 0, 'snippet'],
    );
  });
}

/**
 * Three runs of two prompts across four providers.
 *
 *   prompt 1 · openai      rec,rec,mention → rec,mention,mention → mention×3   LOST fires
 *   prompt 1 · anthropic   rec,rival,rival → mention,rival,rival → rec,rec,rival
 *   prompt 2 · openai      rival×3         → rec,rec,rival       → mention,rival,rival
 *   prompt 2 · anthropic   rival×3         → rival×3             → rec,rec,rival  GAINED fires
 *   prompt 2 · gemini      —               → mention×3           → rival×3        MENTION_DROP fires
 *   prompt 2 · perplexity  —               → mention×3           → mention×3
 *
 * @param {import('node:test').TestContext} t
 * @returns {Db}
 */
function threeRunDb(t) {
  const db = newDb(t);
  addPrompt(db, 1, "What's the best AI meeting notes tool for distributed sales teams?");
  addPrompt(db, 2, 'Which AI tool should I use for meeting notes?');

  addRun(db, { id: 1, at: '2026-07-24T07:00:00Z' });
  addRun(db, { id: 2, at: '2026-07-25T07:00:00Z' });
  addRun(db, { id: 3, at: '2026-07-26T07:00:00Z' });

  const at = { 1: '2026-07-24T07:00:00Z', 2: '2026-07-25T07:00:00Z', 3: '2026-07-26T07:00:00Z' };

  addSamples(db, { runId: 1, promptId: 1, provider: 'openai', at: at[1], samples: ['rec', 'rec', 'mention'] });
  addSamples(db, { runId: 2, promptId: 1, provider: 'openai', at: at[2], samples: ['rec', 'mention', 'mention'] });
  addSamples(db, { runId: 3, promptId: 1, provider: 'openai', at: at[3], samples: ['mention', 'mention', 'mention'] });

  addSamples(db, { runId: 1, promptId: 1, provider: 'anthropic', at: at[1], samples: ['rec', 'rival', 'rival'] });
  addSamples(db, { runId: 2, promptId: 1, provider: 'anthropic', at: at[2], samples: ['mention', 'rival', 'rival'] });
  addSamples(db, { runId: 3, promptId: 1, provider: 'anthropic', at: at[3], samples: ['rec', 'rec', 'rival'] });

  addSamples(db, { runId: 1, promptId: 2, provider: 'openai', at: at[1], samples: ['rival', 'rival', 'rival'] });
  addSamples(db, { runId: 2, promptId: 2, provider: 'openai', at: at[2], samples: ['rec', 'rec', 'rival'] });
  addSamples(db, { runId: 3, promptId: 2, provider: 'openai', at: at[3], samples: ['mention', 'rival', 'rival'] });

  addSamples(db, { runId: 1, promptId: 2, provider: 'anthropic', at: at[1], samples: ['rival', 'rival', 'rival'] });
  addSamples(db, { runId: 2, promptId: 2, provider: 'anthropic', at: at[2], samples: ['rival', 'rival', 'rival'] });
  addSamples(db, { runId: 3, promptId: 2, provider: 'anthropic', at: at[3], samples: ['rec', 'rec', 'rival'] });

  addSamples(db, { runId: 2, promptId: 2, provider: 'gemini', at: at[2], samples: ['mention', 'mention', 'mention'] });
  addSamples(db, { runId: 3, promptId: 2, provider: 'gemini', at: at[3], samples: ['rival', 'rival', 'rival'] });

  addSamples(db, { runId: 2, promptId: 2, provider: 'perplexity', at: at[2], samples: ['mention', 'mention', 'mention'] });
  addSamples(db, { runId: 3, promptId: 2, provider: 'perplexity', at: at[3], samples: ['mention', 'mention', 'mention'] });

  return db;
}

test('new stance revisions suppress lost/gained heuristic recommendation alerts', (t) => {
  const db = threeRunDb(t);
  exec(db, "UPDATE responses SET analysis_revision = 'stance-en-v1' WHERE run_id = 3");
  const alerts = evaluate(db, 3, { now: '2026-07-26T08:00:00Z' });
  assert.equal(alerts.some((alert) => alert.type === 'LOST_RECOMMENDATION' ||
    alert.type === 'GAINED_RECOMMENDATION'), false);
});

test('tracking series suppress business alerts for one positive-to-zero flip and a larger drop', (t) => {
  const db = threeRunDb(t);
  addTrackingDefinition(db);
  exec(db, `UPDATE responses SET lane = 'tracking', surface = provider || '-api',
    target_status = 'completed', comparability_status = 'comparable',
    comparison_key = 'same-profile', analysis_revision = 'stance-en-v1',
    benchmark_revision_id = 'test-benchmark'`);

  const alerts = evaluate(db, 3, { now: '2026-07-26T08:00:00Z' });
  assert.deepEqual(alerts, [], 'valid tracking observations are described in the comparison report');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM alerts').get()?.n), 0);
});

test('tracking failures produce scoped operational health, not visibility loss', (t) => {
  const db = newDb(t);
  addPrompt(db, 1, 'prompt');
  addRun(db, { id: 1, at: '2026-07-26T07:00:00Z', status: 'partial' });
  addSamples(db, {
    runId: 1, promptId: 1, provider: 'openai', at: '2026-07-26T07:00:00Z',
    samples: ['mention', 'empty', 'empty', 'empty'],
  });
  addTrackingDefinition(db);
  exec(db, `UPDATE responses SET lane = 'tracking', surface = 'openai-api',
    comparison_key = 'same-profile', target_status = 'completed',
    comparability_status = 'comparable', benchmark_revision_id = 'test-benchmark' WHERE run_id = 1`);
  exec(db, `UPDATE responses SET target_status = 'failed', comparability_status = 'non_comparable',
    error = 'provider:error' WHERE run_id = 1 AND sample_idx = 1`);
  exec(db, `UPDATE responses SET comparability_status = 'non_comparable'
    WHERE run_id = 1 AND sample_idx = 2`);
  exec(db, `UPDATE responses SET target_status = 'queued', comparability_status = NULL
    WHERE run_id = 1 AND sample_idx = 3`);
  exec(db, 'UPDATE entities SET is_self = 0 WHERE id = ?', [BRAND]);

  const alerts = evaluate(db, 1, { now: NOW, surface: 'openai-api' });
  assert.deepEqual(alerts.map(({ type, severity, surface }) => [type, severity, surface]),
    [['MEASUREMENT_HEALTH', 'warning', 'openai-api']]);
  assert.match(alerts[0].detail, /1\/4 tracking targets were comparable/);
  assert.match(alerts[0].detail, /1 failed, 0 cancelled, 1 incomplete, and 1 completed without comparable evidence/);
  assert.match(alerts[0].detail, /collection issue, not a measured visibility loss/);
  assert.deepEqual(evaluate(db, 1, { now: NOW, surface: 'openai-api' }), [], 'health dedup is surface scoped');
});

test('existing legacy alert rows remain after newer tracking observations', (t) => {
  const db = threeRunDb(t);
  const historical = evaluate(db, 3, { now: NOW });
  assert.ok(historical.some((alert) => alert.type === 'LOST_RECOMMENDATION'));
  addRun(db, { id: 4, at: '2026-07-27T07:00:00Z' });
  addSamples(db, { runId: 4, promptId: 1, provider: 'openai', at: '2026-07-27T07:00:00Z', samples: ['empty'] });
  addTrackingDefinition(db);
  exec(db, `UPDATE responses SET lane = 'tracking', surface = 'openai-api',
    target_status = 'completed', comparability_status = 'comparable',
    comparison_key = 'new-profile', benchmark_revision_id = 'test-benchmark' WHERE run_id = 4`);

  assert.deepEqual(evaluate(db, 4, { now: '2026-07-27T12:00:00Z' }), []);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE type = 'LOST_RECOMMENDATION'").get()?.n), 1);
});

test('upgraded legacy tracking rows keep their historical alert rules', (t) => {
  const db = threeRunDb(t);
  exec(db, `UPDATE responses SET lane = 'tracking', surface = provider || '-api',
    target_status = 'completed', comparability_status = 'comparable',
    comparison_key = 'legacy:' || provider || ':test-model'`);

  const alerts = evaluate(db, 3, { now: NOW });
  assert.equal(ofType(alerts, 'LOST_RECOMMENDATION').length, 1);
  assert.equal(ofType(alerts, 'MENTION_DROP').length, 1);
  assert.equal(ofType(alerts, 'MEASUREMENT_HEALTH').length, 0);
});

const NOW = '2026-07-26T12:00:00Z';

/**
 * @param {import('../core/alerts.js').CreatedAlert[]} alerts
 * @param {string} type
 * @returns {import('../core/alerts.js').CreatedAlert[]}
 */
const ofType = (alerts, type) => alerts.filter((alert) => alert.type === type);

test('LOST_RECOMMENDATION fires only where the last two runs both recommended the brand', (t) => {
  const db = threeRunDb(t);
  const alerts = evaluate(db, 3, { now: NOW });
  const lost = ofType(alerts, 'LOST_RECOMMENDATION');

  assert.equal(lost.length, 1, 'exactly one (prompt, provider) pair lost its recommendation');
  assert.deepEqual([lost[0].promptId, lost[0].provider, lost[0].severity], [1, 'openai', 'serious']);
  assert.match(lost[0].title, /^Lost recommendation on ChatGPT for “/);
  assert.ok(lost[0].title.length <= 90, 'titles stay inside the 90-char column (§3)');
  assert.match(lost[0].detail, /2\/3 → 1\/3 → 0\/3 samples/, 'the detail carries the numbers (§9)');
});

test('GAINED_RECOMMENDATION fires only after two runs with none', (t) => {
  const db = threeRunDb(t);
  const gained = ofType(evaluate(db, 3, { now: NOW }), 'GAINED_RECOMMENDATION');

  assert.deepEqual(
    gained.map((alert) => [alert.promptId, alert.provider]),
    [[2, 'anthropic']],
    'prompt 1 · anthropic had a recommendation two runs ago, so it is not a gain',
  );
  assert.equal(gained[0].severity, 'good');
  assert.match(gained[0].title, /^Now recommended on Claude for “/);
  assert.match(gained[0].detail, /0\/3 → 0\/3 → 2\/3 samples/);
});

test('MENTION_DROP fires on a 25-point per-provider fall and ignores smaller moves', (t) => {
  const db = threeRunDb(t);
  const drops = ofType(evaluate(db, 3, { now: NOW }), 'MENTION_DROP');

  assert.deepEqual(
    drops.map((alert) => alert.provider),
    ['gemini'],
    'openai fell 17 pts and perplexity held flat — neither clears the 25-point bar',
  );
  assert.equal(drops[0].severity, 'warning');
  assert.equal(drops[0].title, 'Mentions down 100 pts on Gemini');
  assert.match(drops[0].detail, /3\/3 .* last run and 0\/3 this run \(100% → 0%, 100 pts\)/);
});

test('MENTION_DROP stays quiet when either run has fewer than three valid samples', (t) => {
  const db = newDb(t);
  addPrompt(db, 1, 'prompt');
  addRun(db, { id: 1, at: '2026-07-25T07:00:00Z' });
  addRun(db, { id: 2, at: '2026-07-26T07:00:00Z' });
  addSamples(db, { runId: 1, promptId: 1, provider: 'openai', at: '2026-07-25T07:00:00Z', samples: ['mention', 'mention'] });
  addSamples(db, { runId: 2, promptId: 1, provider: 'openai', at: '2026-07-26T07:00:00Z', samples: ['rival', 'rival'] });

  assert.deepEqual(ofType(evaluate(db, 2, { now: NOW }), 'MENTION_DROP'), [], 'n = 2 is too thin to claim a drop');
});

test('the recommendation rules need two prior runs before they say anything', (t) => {
  const db = threeRunDb(t);
  const alerts = evaluate(db, 2, { now: '2026-07-25T12:00:00Z' });
  assert.deepEqual(ofType(alerts, 'LOST_RECOMMENDATION'), []);
  assert.deepEqual(ofType(alerts, 'GAINED_RECOMMENDATION'), []);
});

test('OVERTAKEN fires when a competitor crosses above the brand between runs', (t) => {
  const db = newDb(t);
  addPrompt(db, 1, 'prompt');
  addRun(db, { id: 1, at: '2026-07-25T07:00:00Z' });
  addRun(db, { id: 2, at: '2026-07-26T07:00:00Z' });
  // Run 1: brand 3 mentions, rival 1 → brand ahead at the previous evaluation.
  addSamples(db, { runId: 1, promptId: 1, provider: 'openai', at: '2026-07-25T07:00:00Z', samples: ['mention', 'mention', 'mention', 'rival'] });
  // Run 2: rival 6, brand 0 → rival now leads the 7-day window.
  addSamples(db, { runId: 2, promptId: 1, provider: 'openai', at: '2026-07-26T07:00:00Z', samples: ['rival', 'rival', 'rival', 'rival', 'rival', 'rival'] });

  const overtaken = ofType(evaluate(db, 2, { now: NOW }), 'OVERTAKEN');
  assert.equal(overtaken.length, 1);
  assert.deepEqual([overtaken[0].entityId, overtaken[0].severity, overtaken[0].provider], [RIVAL, 'warning', null]);
  assert.equal(overtaken[0].title, 'Jotta passed you in share of AI voice');
  assert.match(overtaken[0].detail, /25% → 70% .* against your 75% → 30%/);
  assert.match(overtaken[0].detail, /n=10 mentions/, 'the share carries the count behind it (§19.6 #4)');
});

test('OVERTAKEN stays quiet while the brand keeps its lead', (t) => {
  const db = threeRunDb(t);
  assert.deepEqual(ofType(evaluate(db, 3, { now: NOW }), 'OVERTAKEN'), []);
});

test('OVERTAKEN stays quiet when the competitor was already ahead last run', (t) => {
  const db = newDb(t);
  addPrompt(db, 1, 'prompt');
  addRun(db, { id: 1, at: '2026-07-25T07:00:00Z' });
  addRun(db, { id: 2, at: '2026-07-26T07:00:00Z' });
  addSamples(db, { runId: 1, promptId: 1, provider: 'openai', at: '2026-07-25T07:00:00Z', samples: ['rival', 'rival', 'rival', 'mention'] });
  addSamples(db, { runId: 2, promptId: 1, provider: 'openai', at: '2026-07-26T07:00:00Z', samples: ['rival', 'rival', 'mention'] });

  assert.deepEqual(ofType(evaluate(db, 2, { now: NOW }), 'OVERTAKEN'), [], 'a standing lead is not a new overtake');
});

test('an identical alert inside 7 days is skipped, and allowed again after', (t) => {
  const db = threeRunDb(t);
  const first = evaluate(db, 3, { now: NOW });
  assert.ok(first.length >= 3, 'the first evaluation writes the alerts');

  assert.deepEqual(evaluate(db, 3, { now: '2026-07-27T12:00:00Z' }), [], 'same (type, entity, prompt, provider) within 7 days');
  assert.deepEqual(evaluate(db, 3, { now: '2026-08-01T12:00:00Z' }), [], 'still inside the 7-day window');

  const later = evaluate(db, 3, { now: '2026-08-04T12:00:00Z' });
  assert.ok(
    later.some((alert) => alert.type === 'MENTION_DROP'),
    'past the dedup window the same condition may be reported again',
  );

  const rows = db.prepare('SELECT COUNT(*) AS n FROM alerts').get();
  assert.equal(Number(rows?.n), first.length + later.length, 'nothing is written twice inside the window');
});

test('written rows carry run, severity, acknowledged state and a numeric detail', (t) => {
  const db = threeRunDb(t);
  evaluate(db, 3, { now: NOW });
  const rows = db.prepare('SELECT * FROM alerts ORDER BY id').all();

  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.equal(Number(row.run_id), 3);
    assert.equal(Number(row.acknowledged), 0);
    assert.equal(String(row.created_at), NOW);
    assert.ok(['good', 'warning', 'serious'].includes(String(row.severity)));
    assert.match(String(row.detail), /\d/, 'every detail carries numbers');
    assert.ok(String(row.title).length <= 90);
  }
});

test('evaluate is a no-op for an unknown run or a database with no brand', (t) => {
  const db = threeRunDb(t);
  assert.deepEqual(evaluate(db, 999, { now: NOW }), []);

  exec(db, 'UPDATE entities SET is_self = 0 WHERE id = ?', [BRAND]);
  assert.deepEqual(evaluate(db, 3, { now: NOW }), [], 'without a brand entity there is nothing to alert about');
});

test('seeded runs compare against seeded runs, and live runs ignore them', (t) => {
  const db = newDb(t);
  addPrompt(db, 1, 'prompt');
  addRun(db, { id: 1, at: '2026-07-24T07:00:00Z', trigger: 'seed' });
  addRun(db, { id: 2, at: '2026-07-25T07:00:00Z', trigger: 'seed' });
  addRun(db, { id: 3, at: '2026-07-26T07:00:00Z', trigger: 'seed' });
  addSamples(db, { runId: 1, promptId: 1, provider: 'openai', at: '2026-07-24T07:00:00Z', samples: ['rec', 'rec', 'rec'] });
  addSamples(db, { runId: 2, promptId: 1, provider: 'openai', at: '2026-07-25T07:00:00Z', samples: ['rec', 'rec', 'mention'] });
  addSamples(db, { runId: 3, promptId: 1, provider: 'openai', at: '2026-07-26T07:00:00Z', samples: ['mention', 'mention', 'mention'] });

  const seeded = evaluate(db, 3, { now: NOW });
  assert.deepEqual(
    ofType(seeded, 'LOST_RECOMMENDATION').map((alert) => alert.provider),
    ['openai'],
    'the seeded universe produces its storyline through the same rules (§12)',
  );

  // A live run standing alone has no live history to compare with.
  addRun(db, { id: 4, at: '2026-07-26T09:00:00Z', trigger: 'manual' });
  addSamples(db, { runId: 4, promptId: 1, provider: 'openai', at: '2026-07-26T09:00:00Z', samples: ['mention', 'mention', 'mention'] });
  assert.deepEqual(ofType(evaluate(db, 4, { now: NOW }), 'LOST_RECOMMENDATION'), []);
});

test('evaluate accepts either argument order, matching the §8.1 runner hook', (t) => {
  const db = threeRunDb(t);
  const alerts = evaluate(3, db, { now: NOW });
  assert.ok(alerts.length >= 3, 'evaluate(runId, db) works like evaluate(db, runId)');
  assert.throws(() => evaluate(3, 3, { now: NOW }), /pass the open database/);
});

test('a run still marked running is evaluated — the runner finalises status afterwards (§8.1)', (t) => {
  const db = threeRunDb(t);
  exec(db, "UPDATE runs SET status = 'running', finished_at = NULL WHERE id = 3");
  const alerts = evaluate(db, 3, { now: NOW });
  assert.ok(alerts.length >= 3, 'alerts are evaluated before the run row is finalised');
});
