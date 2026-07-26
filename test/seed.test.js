/** Phase 1 Lane D (§12) — determinism, alert storylines, FK integrity */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { all, get, openDb } from '../core/db.js';
import {
  DEMO_DAYS,
  DEMO_ENTITIES,
  DEMO_PROVIDERS,
  DEMO_SAMPLES,
  NEUTRAL_DOMAINS,
  isEmpty,
  mulberry32,
  seed,
  seedIfDemoAndEmpty,
  wipe,
} from '../core/seed.js';

/** Fixed anchor so the window is the same on every machine and every day. */
const NOW = new Date('2026-07-26T11:23:45Z');

/**
 * @param {Parameters<typeof seed>[1]} [opts]
 * @returns {{db: import('node:sqlite').DatabaseSync, summary: ReturnType<typeof seed>}}
 */
function seeded(opts = {}) {
  const db = openDb(':memory:');
  const summary = seed(db, { now: NOW, ...opts });
  return { db, summary };
}

// One full universe, shared by every read-only assertion below: seeding 4,320 answers and
// evaluating the rules 30 times is the expensive part, and none of these tests mutate it.
const demo = seeded();
after(() => demo.db.close());

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Record<string, number>}
 */
function tableCounts(db) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of ['entities', 'intents', 'prompts', 'runs', 'responses', 'mentions', 'citations', 'alerts']) {
    counts[table] = Number(get(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1);
  }
  return counts;
}

/**
 * Every alert, as a comparable signature — type, provider and the prompt it points at.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]}
 */
function alertSignatures(db) {
  return all(
    db,
    `SELECT a.created_at AS at, a.type AS type, a.severity AS severity, a.provider AS provider,
            e.name AS entity, p.text AS prompt, a.title AS title, a.detail AS detail
       FROM alerts a
       LEFT JOIN entities e ON e.id = a.entity_id
       LEFT JOIN prompts p ON p.id = a.prompt_id
      ORDER BY a.id`,
  ).map((row) => JSON.stringify(row));
}

test('mulberry32 is a stable stream for a given seed', () => {
  const a = mulberry32(1337);
  const b = mulberry32(1337);
  const c = mulberry32(1338);
  const first = [a(), a(), a(), a()];
  assert.deepEqual(first, [b(), b(), b(), b()]);
  assert.notDeepEqual(first, [c(), c(), c(), c()]);
  for (const value of first) {
    assert.ok(value >= 0 && value < 1, `${value} is outside [0, 1)`);
  }
});

test('two seeds produce identical databases (§12, §15)', (t) => {
  const left = seeded();
  const right = seeded();
  t.after(() => {
    left.db.close();
    right.db.close();
  });

  assert.deepEqual(tableCounts(left.db), tableCounts(right.db));
  assert.deepEqual(left.summary, right.summary);

  // Mention counts per (day, provider, entity) — the §15 determinism contract.
  const perDay = (/** @type {import('node:sqlite').DatabaseSync} */ db) =>
    all(
      db,
      `SELECT substr(r.created_at, 1, 10) AS day, r.provider AS provider, m.entity_id AS entity_id, COUNT(*) AS n
         FROM mentions m JOIN responses r ON r.id = m.response_id
        GROUP BY day, provider, entity_id
        ORDER BY day, provider, entity_id`,
    ).map((row) => `${row.day}|${row.provider}|${row.entity_id}|${row.n}`);
  assert.deepEqual(perDay(left.db), perDay(right.db));

  // …and the alerts that fell out of them, down to the numbers in each detail line.
  assert.deepEqual(alertSignatures(left.db), alertSignatures(right.db));

  // Answer texts are template-assembled from the same stream, so they match byte for byte.
  const texts = (/** @type {import('node:sqlite').DatabaseSync} */ db) =>
    all(db, 'SELECT text FROM responses ORDER BY id').map((row) => String(row.text));
  assert.deepEqual(texts(left.db), texts(right.db));
});

test('re-seeding after --force reproduces the same universe', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());

  // A short window: this is about --force resetting ids and counters, not about the
  // 30-day storylines, which the determinism test above covers in full.
  const first = seed(db, { now: NOW, days: 6 });
  const firstAlerts = alertSignatures(db);
  wipe(db);
  assert.equal(isEmpty(db), true, 'wipe should leave an empty database');

  const second = seed(db, { now: NOW, days: 6 });
  assert.deepEqual(second, first);
  assert.deepEqual(alertSignatures(db), firstAlerts);
});

test('the universe has the shape §12 specifies', () => {
  const { db, summary } = demo;

  assert.equal(summary.entities, 4);
  assert.equal(summary.intents, 5);
  assert.equal(summary.prompts, 12);
  assert.equal(summary.runs, DEMO_DAYS);
  assert.equal(summary.responses, DEMO_DAYS * DEMO_PROVIDERS.length * 12 * DEMO_SAMPLES);

  // Exactly one brand entity, and it is Notewell (§3 "exactly one row with is_self=1").
  const selves = all(db, 'SELECT name FROM entities WHERE is_self = 1');
  assert.equal(selves.length, 1);
  assert.equal(selves[0].name, 'Notewell');

  // 5 intents × 2–3 paraphrases.
  const perIntent = all(db, 'SELECT intent_id, COUNT(*) AS n FROM prompts GROUP BY intent_id ORDER BY intent_id');
  assert.equal(perIntent.length, 5);
  for (const row of perIntent) {
    assert.ok(Number(row.n) >= 2 && Number(row.n) <= 3, `intent ${row.intent_id} has ${row.n} paraphrases`);
  }

  // A branded intent exists, is tagged so the SOV denominator can exclude it (§6.7),
  // and every other prompt carries a real category.
  const branded = all(db, "SELECT text FROM prompts WHERE category = 'branded' ORDER BY id");
  assert.ok(branded.length >= 1, 'no branded prompt to demo the SOV-exclusion badge');
  assert.ok(
    branded.some((row) => String(row.text) === 'Is Notewell any good?'),
    'the §12 branded prompt is missing',
  );
  assert.ok(
    all(db, "SELECT id FROM prompts WHERE category = 'comparison'").length >= 1,
    'no comparison prompt in the demo universe',
  );
  assert.equal(all(db, 'SELECT id FROM prompts WHERE active = 0').length, 0);

  // All four engines answered every prompt, every run.
  const providers = all(db, 'SELECT DISTINCT provider FROM responses ORDER BY provider').map((r) => String(r.provider));
  assert.deepEqual(providers, DEMO_PROVIDERS.map((p) => p.id).sort());
});

test('every run is a seeded, finished run (§12)', () => {
  const { db } = demo;

  const triggers = all(db, 'SELECT DISTINCT trigger FROM runs').map((row) => String(row.trigger));
  assert.deepEqual(triggers, ['seed'], 'seeded data must never masquerade as a live run (§19.6 #3)');

  const statuses = all(db, 'SELECT DISTINCT status FROM runs').map((row) => String(row.status));
  assert.deepEqual(statuses, ['done']);

  const runs = all(db, 'SELECT started_at, finished_at, total_calls, done_calls FROM runs ORDER BY id');
  assert.equal(runs.length, DEMO_DAYS);
  for (const run of runs) {
    assert.match(String(run.started_at), /^\d{4}-\d{2}-\d{2}T07:00:00Z$/, 'runs land at 07:00Z (§12)');
    assert.ok(String(run.finished_at) > String(run.started_at));
    assert.equal(Number(run.done_calls), Number(run.total_calls));
  }

  // The window ends on the last full UTC day — yesterday relative to the seed (§12).
  const days = all(db, 'SELECT DISTINCT substr(started_at, 1, 10) AS day FROM runs ORDER BY day').map((r) =>
    String(r.day),
  );
  assert.equal(days.length, DEMO_DAYS);
  assert.equal(days[days.length - 1], '2026-07-25');
  assert.equal(days[0], '2026-06-26');
  const responseDays = all(db, 'SELECT DISTINCT substr(created_at, 1, 10) AS day FROM responses ORDER BY day').map(
    (r) => String(r.day),
  );
  assert.deepEqual(responseDays, days, 'every response belongs to its run day');
});

test('seeded responses carry no tokens and no cost (§12)', () => {
  const { db } = demo;

  const priced = get(
    db,
    'SELECT COUNT(*) AS n FROM responses WHERE tokens_in IS NOT NULL OR tokens_out IS NOT NULL OR cost_usd IS NOT NULL',
  );
  assert.equal(Number(priced?.n), 0, 'cost tracking starts with live runs, not with the demo');

  // Errors are a live-run concern; the demo universe is all valid answers.
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM responses WHERE error IS NOT NULL')?.n), 0);
  assert.equal(Number(get(db, "SELECT COUNT(*) AS n FROM responses WHERE text IS NULL OR text = ''")?.n), 0);
});

test('answers come from several template families, and the hedging ones never recommend', () => {
  const { db } = demo;

  // The hedging families carry no §6.4 trigger phrase and no list, so their only route to
  // a recommendation would be R3 — which is why they are padded past 400 characters.
  const hedging =
    "r.text LIKE 'Before the names:%' OR r.text LIKE 'A few names come up%' " +
    "OR r.text LIKE 'There is no single answer%' OR r.text LIKE '%both come up for%'";
  const hedged = get(
    db,
    `SELECT COUNT(*) AS n, MIN(length(r.text)) AS shortest,
            (SELECT SUM(m.recommended) FROM mentions m JOIN responses r2 ON r2.id = m.response_id
              WHERE ${hedging.replace(/r\.text/g, 'r2.text')}) AS recommended
       FROM responses r WHERE ${hedging}`,
  );
  assert.ok(Number(hedged?.n) > 0, 'no hedged answers at all — the template families collapsed');
  assert.ok(Number(hedged?.shortest) >= 400, `a hedged answer is ${hedged?.shortest} chars, so §6.4 R3 would fire`);
  assert.equal(Number(hedged?.recommended ?? 0), 0, 'a hedged answer must not count as a recommendation');

  // Ranked lists exist too, and their lead entity is recommended (§6.4 R2).
  const lists = get(
    db,
    `SELECT COUNT(*) AS n FROM responses r WHERE r.text LIKE '%1. %' OR r.text LIKE '%
- %'`,
  );
  assert.ok(Number(lists?.n) > 0, 'no ranked-list answers in the demo universe');

  // Four distinct openings at minimum: the explorer should not look stamped out (§12).
  const openings = new Set(
    all(db, 'SELECT text FROM responses').map((row) => String(row.text).slice(0, 16)),
  );
  assert.ok(openings.size >= 6, `only ${openings.size} distinct answer openings`);
});

test('the storylines produce all four alert types (§9, §12)', () => {
  const { db, summary } = demo;

  for (const type of ['MENTION_DROP', 'OVERTAKEN', 'LOST_RECOMMENDATION', 'GAINED_RECOMMENDATION']) {
    assert.ok((summary.alertTypes[type] ?? 0) >= 1, `the demo universe produced no ${type} alert`);
  }

  // The Gemini cliff: the brand's mention rate falls in the last week (§12).
  const drop = get(
    db,
    "SELECT provider, detail FROM alerts WHERE type = 'MENTION_DROP' AND provider = 'gemini' ORDER BY created_at DESC LIMIT 1",
  );
  assert.ok(drop, 'no MENTION_DROP on Gemini — the scripted cliff did not land');
  assert.match(String(drop?.detail), /Notewell was mentioned in \d+\/\d+ valid answers/);

  // Jotta crossing the brand in share of voice (§12).
  const overtaken = get(db, "SELECT e.name AS name FROM alerts a JOIN entities e ON e.id = a.entity_id WHERE a.type = 'OVERTAKEN' ORDER BY a.created_at DESC LIMIT 1");
  assert.equal(String(overtaken?.name), 'Jotta');

  // Every alert is a real row of the §3 shape: severities in range, titles inside the cap,
  // details carrying numbers (§9, §19.6 #4).
  for (const alert of all(db, 'SELECT type, severity, title, detail, acknowledged, run_id FROM alerts')) {
    assert.ok(['good', 'warning', 'serious'].includes(String(alert.severity)));
    assert.ok(String(alert.title).length <= 90, `title too long: ${alert.title}`);
    assert.match(String(alert.detail), /\d/, 'an alert without numbers is a scare, not a measurement');
    assert.equal(Number(alert.acknowledged), 0);
    assert.ok(Number(alert.run_id) > 0, 'alerts point at the run that produced them');
  }

  // The brand's Gemini mention rate really does collapse in the last week, and really does
  // climb on Perplexity — the alerts above are downstream of the data, not hand-written.
  const rate = (/** @type {string} */ provider, /** @type {string} */ from, /** @type {string} */ to) => {
    const row = get(
      db,
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m JOIN entities e ON e.id = m.entity_id
                                     WHERE m.response_id = r.id AND e.is_self = 1) THEN 1 ELSE 0 END) AS mentioned
         FROM responses r JOIN prompts p ON p.id = r.prompt_id
        WHERE r.provider = ? AND p.category <> 'branded' AND r.created_at >= ? AND r.created_at < ?`,
      [provider, from, to],
    );
    return Number(row?.mentioned ?? 0) / Math.max(1, Number(row?.n ?? 0));
  };
  const geminiBefore = rate('gemini', '2026-07-05', '2026-07-19');
  const geminiAfter = rate('gemini', '2026-07-19', '2026-07-26');
  assert.ok(geminiBefore - geminiAfter > 0.25, `Gemini fell only ${geminiBefore} → ${geminiAfter}`);
  const perplexityStart = rate('perplexity', '2026-06-26', '2026-07-03');
  const perplexityEnd = rate('perplexity', '2026-07-19', '2026-07-26');
  assert.ok(perplexityEnd - perplexityStart > 0.1, `Perplexity rose only ${perplexityStart} → ${perplexityEnd}`);
});

test('every write passes foreign-key and schema checks (§15)', () => {
  const { db } = demo;

  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), [], 'seeded rows broke referential integrity');
  assert.equal(all(db, 'PRAGMA integrity_check').map((row) => String(row.integrity_check)).join(','), 'ok');

  // Mentions describe their own answer: offsets and snippets come from analyzeResponse,
  // so a mention must be findable in the text it points at.
  const sample = all(
    db,
    `SELECT r.text AS text, e.name AS name, m.first_index AS first_index, m.rank AS rank, m.snippet AS snippet
       FROM mentions m JOIN responses r ON r.id = m.response_id JOIN entities e ON e.id = m.entity_id
      ORDER BY m.id LIMIT 200`,
  );
  assert.ok(sample.length > 0);
  for (const row of sample) {
    const text = String(row.text);
    assert.ok(Number(row.rank) >= 1);
    assert.ok(text.slice(Number(row.first_index)).startsWith(String(row.name)));
    assert.ok(String(row.snippet).includes(String(row.name)));
  }

  // Ranks within one answer are 1..k with no gaps.
  for (const row of all(
    db,
    `SELECT response_id, COUNT(*) AS n, MIN(rank) AS lo, MAX(rank) AS hi
       FROM mentions GROUP BY response_id HAVING hi <> n OR lo <> 1 LIMIT 5`,
  )) {
    assert.fail(`response ${row.response_id} has ranks ${row.lo}..${row.hi} for ${row.n} mentions`);
  }
});

test('only Perplexity cites, and only invented domains (§12, §19.5 #8)', () => {
  const { db } = demo;

  const stray = get(
    db,
    "SELECT COUNT(*) AS n FROM citations c JOIN responses r ON r.id = c.response_id WHERE r.provider <> 'perplexity'",
  );
  assert.equal(Number(stray?.n), 0, 'only Perplexity returns native citations (§5.2)');

  const perAnswer = all(
    db,
    `SELECT r.id AS id, COUNT(c.id) AS n
       FROM responses r LEFT JOIN citations c ON c.response_id = r.id
      WHERE r.provider = 'perplexity'
      GROUP BY r.id`,
  );
  assert.ok(perAnswer.length > 0);
  for (const row of perAnswer) {
    assert.ok(Number(row.n) >= 1 && Number(row.n) <= 3, `perplexity answer ${row.id} has ${row.n} citations`);
  }

  const entityDomains = DEMO_ENTITIES.flatMap((entity) => entity.domains);
  const allowed = new Set([...entityDomains, ...NEUTRAL_DOMAINS]);
  for (const row of all(db, 'SELECT DISTINCT domain FROM citations')) {
    assert.ok(allowed.has(String(row.domain)), `unexpected citation domain ${row.domain}`);
  }
  // Domains that belong to an entity are attributed to it; neutral ones are not.
  for (const row of all(db, 'SELECT domain, entity_id FROM citations GROUP BY domain, entity_id')) {
    const owned = entityDomains.includes(String(row.domain));
    assert.equal(row.entity_id !== null, owned, `${row.domain} attribution is wrong`);
  }
});

test('the demo universe never names a real brand (§19.5 #8)', () => {
  const { db } = demo;

  const corpus = [
    ...all(db, 'SELECT text AS t FROM responses').map((r) => String(r.t)),
    ...all(db, 'SELECT text AS t FROM prompts').map((r) => String(r.t)),
    ...all(db, 'SELECT label AS t FROM intents').map((r) => String(r.t)),
    ...all(db, 'SELECT url AS t FROM citations').map((r) => String(r.t)),
  ].join('\n');

  for (const forbidden of [
    'OpenAI',
    'ChatGPT',
    'Anthropic',
    'Claude',
    'Gemini',
    'Perplexity',
    'Otter',
    'Fireflies',
    'Granola',
    'Fathom',
    'Zoom',
    'Notion',
    'example.com',
  ]) {
    assert.ok(!corpus.includes(forbidden), `seeded text mentions ${forbidden}`);
  }
});

test('isEmpty / wipe / demo boot hook (§12)', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());

  assert.equal(isEmpty(db), true);
  assert.equal(seedIfDemoAndEmpty(db, { demo: false }, { now: NOW, days: 4 }), null, 'demo mode off must not seed');
  assert.equal(isEmpty(db), true);

  const summary = seedIfDemoAndEmpty(db, { demo: true }, { now: NOW, days: 4 });
  assert.ok(summary, 'demo mode with an empty database should seed');
  assert.equal(isEmpty(db), false);

  // A populated database is never seeded twice.
  const before = tableCounts(db);
  assert.equal(seedIfDemoAndEmpty(db, { demo: true }, { now: NOW, days: 4 }), null);
  assert.deepEqual(tableCounts(db), before);

  wipe(db);
  assert.equal(isEmpty(db), true);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});
