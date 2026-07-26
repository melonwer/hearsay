/**
 * Metrics tests (§7, §15) — hand-built mini database in a temp file, exact expected
 * numbers written out by hand so a wrong query fails loudly rather than plausibly.
 *
 * Fixture (window ends 2026-07-26T12:00:00Z):
 *
 *   entities   1 Notewell (brand)  2 Jotta  3 EchoPad  4 Quillo (archived)
 *   intent 1   "best AI meeting notes tool" → prompts 1 and 2 (general)
 *   intent 2   "Is Notewell any good?"      → prompt 3 (branded)
 *
 *   2026-07-24  prompt 1 · openai ×4  → brand mentioned in 1
 *   2026-07-25  prompt 2 · openai ×4  → brand mentioned in 3
 *   2026-07-25  prompt 1 · anthropic ×2 → brand mentioned in 1
 *   2026-07-25  prompt 3 · openai ×2  (branded — excluded from SOV by default)
 *   2026-07-26  prompt 1 · gemini ×1  → error 'auth' (never a valid response)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, run as exec } from '../core/db.js';
import {
  actualSpend,
  avgRank,
  citationGap,
  citationShare,
  intentTable,
  mentionRate,
  promptTable,
  providerBreakdown,
  recommendationRate,
  shareOfVoice,
  sovTrend,
  summary,
  wilson,
} from '../core/metrics.js';

const NOW = '2026-07-26T12:00:00Z';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

/**
 * @param {import('node:test').TestContext} t
 * @returns {Db}
 */
function emptyDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-metrics-'));
  const db = openDb(join(dir, 'hearsay.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/**
 * @param {Db} db
 * @param {{id:number, name:string, isSelf?:boolean, domains?:string[], archivedAt?:string|null}} entity
 */
function addEntity(db, entity) {
  exec(db, 'INSERT INTO entities(id, name, aliases, domains, is_self, created_at, archived_at) VALUES(?,?,?,?,?,?,?)', [
    entity.id,
    entity.name,
    '[]',
    JSON.stringify(entity.domains ?? []),
    entity.isSelf ? 1 : 0,
    '2026-07-01T00:00:00Z',
    entity.archivedAt ?? null,
  ]);
}

/**
 * @param {Db} db
 * @param {number} id
 * @param {string} label
 */
function addIntent(db, id, label) {
  exec(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [id, label, '2026-07-01T00:00:00Z']);
}

/**
 * @param {Db} db
 * @param {{id:number, intentId:number, text:string, category?:string}} prompt
 */
function addPrompt(db, prompt) {
  exec(db, 'INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES(?,?,?,?,1,?)', [
    prompt.id,
    prompt.intentId,
    prompt.text,
    prompt.category ?? 'general',
    '2026-07-01T00:00:00Z',
  ]);
}

/**
 * @param {Db} db
 * @param {{id:number, startedAt:string, finishedAt?:string|null, trigger?:string, status?:string}} runRow
 */
function addRun(db, runRow) {
  exec(db, 'INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls) VALUES(?,?,?,?,?,?,?)', [
    runRow.id,
    runRow.startedAt,
    runRow.finishedAt ?? null,
    runRow.trigger ?? 'manual',
    runRow.status ?? 'done',
    0,
    0,
  ]);
}

/**
 * @param {Db} db
 * @param {{id:number, runId:number, promptId:number, provider:string, createdAt:string,
 *          error?:string|null, costUsd?:number|null,
 *          mentions?:{entityId:number, rank:number, recommended?:boolean}[],
 *          citations?:{url:string, domain:string, entityId?:number|null}[]}} response
 */
function addResponse(db, response) {
  exec(
    db,
    `INSERT INTO responses(id, run_id, prompt_id, provider, model, sample_idx, text, latency_ms,
                           tokens_in, tokens_out, cost_usd, error, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      response.id,
      response.runId,
      response.promptId,
      response.provider,
      'test-model',
      0,
      response.error ? null : 'answer text',
      120,
      null,
      null,
      response.costUsd ?? null,
      response.error ?? null,
      response.createdAt,
    ],
  );
  for (const mention of response.mentions ?? []) {
    exec(
      db,
      'INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet) VALUES(?,?,?,?,?,?,?)',
      [response.id, mention.entityId, 0, 1, mention.rank, mention.recommended ? 1 : 0, 'snippet'],
    );
  }
  (response.citations ?? []).forEach((citation, i) => {
    exec(db, 'INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES(?,?,?,?,?)', [
      response.id,
      citation.url,
      citation.domain,
      i + 1,
      citation.entityId ?? null,
    ]);
  });
}

/**
 * @param {import('node:test').TestContext} t
 * @returns {Db}
 */
function fixtureDb(t) {
  const db = emptyDb(t);

  addEntity(db, { id: 1, name: 'Notewell', isSelf: true, domains: ['notewell.io'] });
  addEntity(db, { id: 2, name: 'Jotta', domains: ['jotta.app'] });
  addEntity(db, { id: 3, name: 'EchoPad', domains: ['echopad.ai'] });
  addEntity(db, { id: 4, name: 'Quillo', domains: ['quillo.co'], archivedAt: '2026-07-10T00:00:00Z' });

  addIntent(db, 1, 'best AI meeting notes tool');
  addIntent(db, 2, 'Is Notewell any good?');
  addPrompt(db, { id: 1, intentId: 1, text: "What's the best AI meeting notes tool?" });
  addPrompt(db, { id: 2, intentId: 1, text: 'Which AI tool should I use for meeting notes?' });
  addPrompt(db, { id: 3, intentId: 2, text: 'Is Notewell any good?', category: 'branded' });

  addRun(db, { id: 1, startedAt: '2026-07-24T07:00:00Z', finishedAt: '2026-07-24T07:05:00Z' });
  addRun(db, { id: 2, startedAt: '2026-07-25T07:00:00Z', finishedAt: '2026-07-26T07:10:00Z' });

  const d24 = '2026-07-24T07:00:00Z';
  const d25 = '2026-07-25T07:00:00Z';

  // 2026-07-24 · prompt 1 · openai ×4 — brand mentioned once.
  addResponse(db, {
    id: 1,
    runId: 1,
    promptId: 1,
    provider: 'openai',
    createdAt: d24,
    costUsd: 0.002,
    mentions: [
      { entityId: 1, rank: 1, recommended: true },
      { entityId: 2, rank: 2 },
    ],
    citations: [{ url: 'https://worktools.dev/roundup', domain: 'worktools.dev' }],
  });
  addResponse(db, {
    id: 2,
    runId: 1,
    promptId: 1,
    provider: 'openai',
    createdAt: d24,
    mentions: [
      { entityId: 2, rank: 1 },
      { entityId: 4, rank: 2 }, // archived entity — must never surface
    ],
    citations: [
      { url: 'https://reviewradar.io/best-meeting-notes', domain: 'reviewradar.io' },
      { url: 'https://jotta.app/features', domain: 'jotta.app', entityId: 2 },
    ],
  });
  addResponse(db, {
    id: 3,
    runId: 1,
    promptId: 1,
    provider: 'openai',
    createdAt: d24,
    citations: [{ url: 'https://reviewradar.io/2026-roundup', domain: 'reviewradar.io' }],
  });
  addResponse(db, {
    id: 4,
    runId: 1,
    promptId: 1,
    provider: 'openai',
    createdAt: d24,
    mentions: [
      { entityId: 2, rank: 1 },
      { entityId: 3, rank: 2 },
    ],
  });

  // 2026-07-25 · prompt 2 · openai ×4 — brand mentioned three times.
  addResponse(db, {
    id: 5,
    runId: 2,
    promptId: 2,
    provider: 'openai',
    createdAt: d25,
    costUsd: 0.003,
    mentions: [
      { entityId: 1, rank: 1, recommended: true },
      { entityId: 2, rank: 2 },
    ],
    citations: [{ url: 'https://notewell.io/pricing', domain: 'notewell.io', entityId: 1 }],
  });
  addResponse(db, { id: 6, runId: 2, promptId: 2, provider: 'openai', createdAt: d25, mentions: [{ entityId: 1, rank: 1 }] });
  addResponse(db, {
    id: 7,
    runId: 2,
    promptId: 2,
    provider: 'openai',
    createdAt: d25,
    mentions: [
      { entityId: 3, rank: 1 },
      { entityId: 1, rank: 2 },
    ],
  });
  addResponse(db, { id: 8, runId: 2, promptId: 2, provider: 'openai', createdAt: d25, mentions: [{ entityId: 2, rank: 1 }] });

  // 2026-07-25 · prompt 1 · anthropic ×2 — the provider-filter slice.
  addResponse(db, {
    id: 9,
    runId: 2,
    promptId: 1,
    provider: 'anthropic',
    createdAt: d25,
    costUsd: 0.001,
    mentions: [{ entityId: 1, rank: 1 }],
  });
  addResponse(db, { id: 10, runId: 2, promptId: 1, provider: 'anthropic', createdAt: d25 });

  // 2026-07-25 · prompt 3 · openai ×2 — branded prompt, brand mentioned in both.
  addResponse(db, {
    id: 11,
    runId: 2,
    promptId: 3,
    provider: 'openai',
    createdAt: d25,
    mentions: [{ entityId: 1, rank: 1, recommended: true }],
  });
  addResponse(db, { id: 12, runId: 2, promptId: 3, provider: 'openai', createdAt: d25, mentions: [{ entityId: 1, rank: 1 }] });

  // 2026-07-26 · prompt 1 · gemini — an error row: never valid, but still the last error.
  addResponse(db, { id: 13, runId: 2, promptId: 1, provider: 'gemini', createdAt: '2026-07-26T07:00:00Z', error: 'auth' });

  exec(db, 'INSERT INTO alerts(created_at, run_id, severity, type, entity_id, prompt_id, provider, title, detail, acknowledged) VALUES(?,?,?,?,?,?,?,?,?,?)', [
    '2026-07-25T07:20:00Z',
    2,
    'warning',
    'MENTION_DROP',
    1,
    1,
    'openai',
    'Mentions down 30 pts on ChatGPT',
    '3/4 → 1/4 samples',
    0,
  ]);
  exec(db, 'INSERT INTO alerts(created_at, run_id, severity, type, entity_id, prompt_id, provider, title, detail, acknowledged) VALUES(?,?,?,?,?,?,?,?,?,?)', [
    '2026-07-24T07:20:00Z',
    1,
    'good',
    'GAINED_RECOMMENDATION',
    1,
    1,
    'openai',
    'Now recommended on ChatGPT',
    '0/4 → 1/4 samples',
    1,
  ]);

  return db;
}

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} [tolerance]
 * @param {string} [message]
 */
function close(actual, expected, tolerance = 1e-9, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

test('Wilson 95% interval matches the §7 anchor exactly', () => {
  const rate = wilson(17, 50);
  close(rate.p ?? NaN, 0.34, 1e-12, 'p');
  close(rate.lo ?? NaN, 0.2244, 0.0002, 'lo');
  close(rate.hi ?? NaN, 0.4785, 0.0002, 'hi');
  assert.equal(rate.n, 50);
  assert.equal(rate.lowSample, false);
});

test('Wilson with n = 0 reports p null rather than 0%', () => {
  assert.deepEqual(wilson(0, 0), { n: 0, mentioned: 0, p: null, lo: null, hi: null, lowSample: true });
});

test('mentionRate excludes branded prompts by default and includes them on request', (t) => {
  const db = fixtureDb(t);

  const standard = mentionRate(db, { entityId: 1, days: 30, now: NOW });
  assert.equal(standard.n, 10);
  assert.equal(standard.mentioned, 5);
  close(standard.p ?? NaN, 0.5, 1e-12, 'p');
  assert.ok((standard.lo ?? 1) < 0.5 && (standard.hi ?? 0) > 0.5, 'CI brackets the point estimate');

  const branded = mentionRate(db, { entityId: 1, days: 30, now: NOW, includeBranded: true });
  assert.equal(branded.n, 12);
  assert.equal(branded.mentioned, 7);
});

test('mentionRate honours the provider filter and flags low samples', (t) => {
  const db = fixtureDb(t);
  const rate = mentionRate(db, { entityId: 1, days: 30, now: NOW, provider: 'anthropic' });
  assert.equal(rate.n, 2);
  assert.equal(rate.mentioned, 1);
  assert.equal(rate.lowSample, true, 'n = 2 is below the low-sample threshold of 5');
});

test('the window excludes anything older than `days`', (t) => {
  const db = fixtureDb(t);
  const oneDay = mentionRate(db, { entityId: 1, days: 1, now: NOW });
  assert.equal(oneDay.n, 0, 'only the gemini error row falls inside a 1-day window, and errors are not valid');
  assert.equal(oneDay.p, null);
});

test('shareOfVoice divides mentions by the total and skips archived entities', (t) => {
  const db = fixtureDb(t);
  const rows = shareOfVoice(db, { days: 30, now: NOW });
  assert.deepEqual(
    rows.map((r) => [r.entityId, r.mentions]),
    [
      [1, 5],
      [2, 5],
      [3, 2],
    ],
  );
  close(rows[0].sov, 5 / 12, 1e-12, 'brand sov');
  close(rows[2].sov, 2 / 12, 1e-12, 'echopad sov');
  assert.equal(rows[0].isSelf, true);
  assert.ok(!rows.some((r) => r.entityId === 4), 'archived entity is absent');
  close(
    rows.reduce((sum, r) => sum + r.sov, 0),
    1,
    1e-12,
    'shares sum to 1',
  );
});

test('shareOfVoice returns 0 rather than NaN when nothing was mentioned', (t) => {
  const db = emptyDb(t);
  addEntity(db, { id: 1, name: 'Notewell', isSelf: true });
  addEntity(db, { id: 2, name: 'Jotta' });
  addIntent(db, 1, 'intent');
  addPrompt(db, { id: 1, intentId: 1, text: 'prompt' });
  addRun(db, { id: 1, startedAt: '2026-07-25T07:00:00Z', finishedAt: '2026-07-25T07:01:00Z' });
  addResponse(db, { id: 1, runId: 1, promptId: 1, provider: 'openai', createdAt: '2026-07-25T07:00:00Z' });

  const rows = shareOfVoice(db, { days: 30, now: NOW });
  assert.deepEqual(
    rows.map((r) => r.sov),
    [0, 0],
  );
});

test('sovTrend reports one row per measured UTC day and omits days with no data', (t) => {
  const db = fixtureDb(t);
  const trend = sovTrend(db, { days: 30, now: NOW });
  assert.deepEqual(
    trend.map((day) => day.date),
    ['2026-07-24', '2026-07-25'],
    'days without valid responses are gaps, not zeros',
  );

  assert.equal(trend[0].n, 4);
  close(trend[0].series.find((s) => s.entityId === 1)?.sov ?? NaN, 1 / 5, 1e-12, '07-24 brand sov');
  assert.equal(trend[1].n, 6, 'branded-prompt responses stay out of the SOV denominator');
  close(trend[1].series.find((s) => s.entityId === 1)?.sov ?? NaN, 4 / 7, 1e-12, '07-25 brand sov');
  for (const day of trend) {
    for (const series of day.series) assert.equal(series.n, day.n, 'every share carries the day n');
  }
});

test('recommendationRate and avgRank read the §6.4 flags and mention ranks', (t) => {
  const db = fixtureDb(t);
  const rec = recommendationRate(db, { entityId: 1, days: 30, now: NOW });
  assert.deepEqual({ n: rec.n, recommended: rec.recommended }, { n: 10, recommended: 2 });
  close(rec.p ?? NaN, 0.2, 1e-12, 'recommendation rate');

  close(avgRank(db, { entityId: 1, days: 30, now: NOW }) ?? NaN, 1.2, 1e-12, 'avg rank');
  assert.equal(avgRank(db, { entityId: 3, days: 30, now: NOW, provider: 'anthropic' }), null, 'never mentioned → null');
});

test('citationShare counts cited answers, and reports null when nothing was cited', (t) => {
  const db = fixtureDb(t);
  assert.deepEqual(citationShare(db, { entityId: 1, days: 30, now: NOW }), {
    answersWithCitations: 4,
    brandCited: 1,
    share: 0.25,
  });
  assert.deepEqual(citationShare(db, { entityId: 1, days: 30, now: NOW, provider: 'anthropic' }), {
    answersWithCitations: 0,
    brandCited: 0,
    share: null,
  });
});

test('providerBreakdown covers every provider seen, including one that only errored', (t) => {
  const db = fixtureDb(t);
  const rows = providerBreakdown(db, { days: 30, now: NOW });
  assert.deepEqual(
    rows.map((r) => r.provider),
    ['openai', 'anthropic', 'gemini'],
    'stable §4.1 provider order',
  );

  const openai = rows[0];
  assert.deepEqual([openai.n, openai.brandMentionRate.mentioned], [8, 4]);
  close(openai.citationShare ?? NaN, 1 / 4, 1e-12, 'openai citation share');
  // The share's own denominator travels with it, so the UI can print n (§7 display rule).
  assert.equal(openai.citationN, 4, 'answers with citations behind the share');

  const gemini = rows[2];
  assert.deepEqual([gemini.n, gemini.brandMentionRate.p, gemini.avgRank, gemini.citationShare], [0, null, null, null]);
  assert.equal(gemini.citationN, 0);
  assert.equal(gemini.lastError, 'auth', 'a provider that only errors is still visible');
});

test('promptTable lists every prompt, badging branded ones and naming the top entity', (t) => {
  const db = fixtureDb(t);
  const rows = promptTable(db, { days: 30, now: NOW });
  assert.deepEqual(
    rows.map((r) => [r.promptId, r.category]),
    [
      [1, 'general'],
      [2, 'general'],
      [3, 'branded'],
    ],
  );

  const first = rows[0];
  assert.deepEqual(
    first.perProvider.map((p) => p.provider),
    ['openai', 'anthropic'],
  );
  assert.deepEqual(
    [first.perProvider[0].brandMentionRate.n, first.perProvider[0].brandMentionRate.mentioned],
    [4, 1],
  );
  assert.equal(first.perProvider[0].topEntityName, 'Jotta');
  assert.equal(rows[2].perProvider[0].brandRecommended.recommended, 1, 'branded prompt still reports its own numbers');
});

test('intentTable pools paraphrases and splits rerun spread from phrasing spread (§6.6)', (t) => {
  const db = fixtureDb(t);
  const rows = intentTable(db, { days: 30, now: NOW, provider: 'openai' });

  const intent = rows.find((r) => r.intentId === 1);
  assert.ok(intent, 'intent 1 is present');
  assert.equal(intent.paraphraseCount, 2);
  assert.equal(intent.n, 8, 'pooled across both paraphrases');
  assert.equal(intent.pooled.mentioned, 4);
  close(intent.pooled.p ?? NaN, 0.5, 1e-12, 'pooled p');

  // paraphrase means 0.25 and 0.75, each on n = 4.
  // rerun   = √( mean[ p(1−p)/n ] ) = √0.046875 ≈ 0.2165
  // phrasing = population SD of (0.25, 0.75) = 0.25
  close(intent.rerunSpread ?? NaN, Math.sqrt(0.046875), 1e-12, 'rerun spread');
  close(intent.phrasingSpread ?? NaN, 0.25, 1e-12, 'phrasing spread');
  assert.ok(
    (intent.phrasingSpread ?? 0) > (intent.rerunSpread ?? 0),
    'this fixture is phrasing-dominated, as the literature predicts (§6.6)',
  );

  const branded = rows.find((r) => r.intentId === 2);
  assert.ok(branded, 'branded intents appear in intentTable (badged), unlike in SOV');
  assert.equal(branded.paraphraseCount, 1);
  assert.equal(branded.phrasingSpread, null, 'a lone paraphrase has no phrasing spread to report');
});

test('citationGap lists domains cited where the brand is absent', (t) => {
  const db = fixtureDb(t);
  const rows = citationGap(db, { days: 30, now: NOW });
  assert.deepEqual(
    rows.map((r) => [r.domain, r.count, r.topPromptId]),
    [
      ['reviewradar.io', 2, 1],
      ['jotta.app', 1, 1],
    ],
    'worktools.dev and notewell.io are cited in answers that mention the brand, so they are out',
  );
  assert.match(rows[0].sampleUrl, /^https:\/\/reviewradar\.io\//);
  assert.equal(citationGap(db, { days: 30, now: NOW, limit: 1 }).length, 1);
});

test('actualSpend sums only priced calls and stays null-safe', (t) => {
  const db = fixtureDb(t);
  const spend = actualSpend(db, { days: 30, now: NOW });
  close(spend.totalUsd, 0.006, 1e-9, 'total');
  assert.equal(spend.calls, 3, 'responses without provider usage are not counted as priced calls');
  assert.deepEqual(
    spend.perProvider.map((p) => [p.provider, p.calls]),
    [
      ['openai', 2],
      ['anthropic', 1],
    ],
  );
  close(spend.perProvider[0].usd, 0.005, 1e-9, 'openai spend');
});

test('actualSpend on a database with no cost data reports zero, not NaN', (t) => {
  const db = emptyDb(t);
  assert.deepEqual(actualSpend(db, { days: 30, now: NOW }), { totalUsd: 0, calls: 0, perProvider: [] });
});

test('summary matches the §10.4 shape', (t) => {
  const db = fixtureDb(t);
  const result = summary(db, { days: 30, now: NOW, demo: true });

  assert.deepEqual(Object.keys(result).sort(), [
    'brand',
    'demo',
    'generatedAt',
    'lastRun',
    'mentionRate',
    'openAlerts',
    'providers',
    'recommendationRate',
    'sov',
    'windowDays',
  ]);
  assert.deepEqual(result.brand, { id: 1, name: 'Notewell' });
  assert.equal(result.windowDays, 30);
  assert.equal(result.generatedAt, NOW);
  assert.equal(result.demo, true);
  assert.equal(result.mentionRate.n, 10);
  assert.equal(result.recommendationRate.n, 10);
  assert.equal(result.openAlerts, 1, 'acknowledged alerts are not open');
  assert.deepEqual(result.lastRun, { finishedAt: '2026-07-26T07:10:00Z', status: 'done' });
  assert.equal(result.sov.delta7d, null, 'no prior 7-day window to compare against → null, not 0');
  close(result.sov.current[0].sov, 5 / 12, 1e-12, 'brand sov');
});

test('summary delta7d compares the last 7 days with the 7 before them', (t) => {
  const db = emptyDb(t);
  addEntity(db, { id: 1, name: 'Notewell', isSelf: true });
  addEntity(db, { id: 2, name: 'Jotta' });
  addIntent(db, 1, 'intent');
  addPrompt(db, { id: 1, intentId: 1, text: 'prompt' });
  addRun(db, { id: 1, startedAt: '2026-07-15T07:00:00Z', finishedAt: '2026-07-15T07:01:00Z' });

  // Prior window (2026-07-12 → 2026-07-19): brand 1 of 2 mentions → sov 0.5.
  addResponse(db, { id: 1, runId: 1, promptId: 1, provider: 'openai', createdAt: '2026-07-15T07:00:00Z', mentions: [{ entityId: 1, rank: 1 }] });
  addResponse(db, { id: 2, runId: 1, promptId: 1, provider: 'openai', createdAt: '2026-07-15T07:00:00Z', mentions: [{ entityId: 2, rank: 1 }] });
  // Recent window: brand 3 of 4 mentions → sov 0.75.
  addResponse(db, { id: 3, runId: 1, promptId: 1, provider: 'openai', createdAt: '2026-07-24T07:00:00Z', mentions: [{ entityId: 1, rank: 1 }] });
  addResponse(db, { id: 4, runId: 1, promptId: 1, provider: 'openai', createdAt: '2026-07-24T07:00:00Z', mentions: [{ entityId: 1, rank: 1 }] });
  addResponse(db, { id: 5, runId: 1, promptId: 1, provider: 'openai', createdAt: '2026-07-25T07:00:00Z', mentions: [{ entityId: 1, rank: 1 }] });
  addResponse(db, { id: 6, runId: 1, promptId: 1, provider: 'openai', createdAt: '2026-07-25T07:00:00Z', mentions: [{ entityId: 2, rank: 1 }] });

  const result = summary(db, { days: 30, now: NOW });
  close(result.sov.delta7d ?? NaN, 0.25, 1e-12, 'delta7d');
});

test('summary on an empty database degrades honestly instead of throwing', (t) => {
  const db = emptyDb(t);
  const result = summary(db, { days: 30, now: NOW });
  assert.equal(result.brand, null);
  assert.equal(result.mentionRate.p, null);
  assert.equal(result.recommendationRate.p, null);
  assert.deepEqual(result.sov, { current: [], delta7d: null });
  assert.deepEqual(result.providers, []);
  assert.equal(result.lastRun, null);
  assert.equal(result.openAlerts, 0);
});

test('metrics accept the database as an argument or inside the options object', (t) => {
  const db = fixtureDb(t);
  const positional = mentionRate(db, { entityId: 1, days: 30, now: NOW });
  const inOptions = mentionRate({ db, entityId: 1, days: 30, now: NOW });
  assert.deepEqual(inOptions, positional, 'the web lane passes db inside the options object');
  assert.deepEqual(summary({ db, days: 30, now: NOW }).brand, { id: 1, name: 'Notewell' });
  assert.throws(() => mentionRate({ entityId: 1, days: 30, now: NOW }), /pass the database/);
});

test('metrics refuse to invent a clock (§19.6 #6)', (t) => {
  const db = fixtureDb(t);
  assert.throws(() => mentionRate(db, { entityId: 1, days: 30 }), /pass now/);
  assert.throws(() => summary(db, { days: 30, now: 'not-a-date' }), /not a valid date/);
});
