import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDb, run } from '../core/db.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { createOpportunity, reviewOpportunity } from '../core/opportunities.js';
import { recordLedgerEntry, recordOutcome } from '../core/outcomes.js';
import { buildWeeklyReview, renderWeeklyMarkdown } from '../core/weekly-review.js';

const FIRST = '2026-09-01T00:00:00Z';
const FIRST_END = '2026-09-08T00:00:00Z';
const EMPTY_START = FIRST_END;
const EMPTY_END = '2026-09-15T00:00:00Z';
const NOW = '2026-09-25T00:00:00Z';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  run(db, "INSERT INTO entities(id,name,aliases,domains,is_self,created_at) VALUES(1,'Acme','[]','[]',1,?)", [FIRST]);
  run(db, "INSERT INTO intents(id,label,created_at) VALUES(1,'Choose a tool',?)", [FIRST]);
  run(db, "INSERT INTO prompts(id,intent_id,text,category,active,created_at) VALUES(1,1,'Which tool?','general',1,?)", [FIRST]);
  run(db, "INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')", [FIRST]);
  run(db, "INSERT INTO execution_profiles(id,surface,snapshot_json,created_at) VALUES('profile','openai-api','{}',?)", [FIRST]);
  run(db, `INSERT INTO benchmark_revisions(id,snapshot_json,created_at) VALUES('benchmark',?,?)`, [
    JSON.stringify({ questions: [{ id: 1, intentId: 1, text: 'Which tool?', category: 'general' }],
      entities: [{ id: 1, role: 'brand', name: 'Acme' }] }), FIRST,
  ]);
  run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
    surface,lane,target_status,comparability_status,web_status,execution_profile_id,
    benchmark_revision_id,analysis_revision,comparison_key,search_policy,answer_status,
    query_metadata_status,cost_usd)
    VALUES(1,1,1,'openai','fixture',0,'Acme is mentioned',?,'openai-api','tracking',
    'completed','comparable','verified','profile','benchmark','legacy-heuristic-v1',
    'comparison','auto','complete','available',0.25)`, ['2026-09-03T00:00:00Z']);
  const series = listMeasurementSeries(db, { start: FIRST, end: FIRST_END })[0];
  assert.ok(series);
  return { db, series };
}

test('known series renders an empty week and carries older user-prioritized work', (t) => {
  const { db, series } = fixture(t);
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-04T00:00:00Z' });
  reviewOpportunity(db, { id: item.id, status: 'investigate', priority: 2,
    expectedVersion: item.recordVersion, author: 'user', now: '2026-09-04T01:00:00Z' });
  const report = buildWeeklyReview(db, { seriesId: series.id,
    start: EMPTY_START, end: EMPTY_END, now: NOW });
  assert.deepEqual([report.coverage.attemptedTargets, report.coverage.comparableAnswers], [0, 0]);
  assert.equal(report.scope.series.id, series.id);
  assert.equal(report.opportunities.length, 1);
  assert.deepEqual([report.opportunities[0].windowStart, report.opportunities[0].windowEnd],
    [FIRST, FIRST_END]);
  assert.equal(report.outcomesStatus, 'not_recorded');
  assert.equal(report.measurementSpend.costStatus, 'unavailable');
  assert.equal(report.actionState, 'review_items');
  assert.match(renderWeeklyMarkdown(report), /Business outcomes not recorded/);
  assert.doesNotMatch(renderWeeklyMarkdown(report), /ROI|caused by your change/i);
});

test('a shipped action due after its original measurement window enters the weekly review', (t) => {
  const { db, series } = fixture(t);
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-04T00:00:00Z' });
  const planned = reviewOpportunity(db, { id: item.id, status: 'planned', owner: 'Product',
    reviewDate: '2026-09-12', expectedVersion: item.recordVersion,
    author: 'user', now: '2026-09-05T00:00:00Z' });
  reviewOpportunity(db, { id: item.id, status: 'shipped',
    changeDescription: 'Clarified the docs', productArea: 'Docs', shippedAt: '2026-09-07T00:00:00Z',
    expectedVersion: planned.recordVersion, author: 'user', now: '2026-09-07T00:00:00Z' });
  const report = buildWeeklyReview(db, { seriesId: series.id,
    start: EMPTY_START, end: EMPTY_END, now: NOW });
  assert.deepEqual(report.dueReviews.map((row) => row.id), [item.id]);
  assert.deepEqual([report.dueReviews[0].windowStart, report.dueReviews[0].windowEnd],
    [FIRST, FIRST_END]);
  assert.deepEqual(report.opportunities, []);
});

test('weekly review requires a known explicit series and one completed UTC week', (t) => {
  const { db, series } = fixture(t);
  const selection = { seriesId: series.id, start: EMPTY_START, end: EMPTY_END, now: NOW };
  assert.throws(() => buildWeeklyReview(db, { ...selection, seriesId: '' }), /explicit measurement series/);
  assert.throws(() => buildWeeklyReview(db, { ...selection, seriesId: 'unknown' }), /not found/);
  assert.throws(() => buildWeeklyReview(db, { ...selection, end: '2026-09-16T00:00:00Z' }), /exactly seven days/);
  assert.throws(() => buildWeeklyReview(db, { ...selection, now: '2026-09-14T00:00:00Z' }), /future/);
});

test('weekly review separates reported outcomes, partial expenses, time, and computed API spend', (t) => {
  const { db, series } = fixture(t);
  recordOutcome(db, { source: 'analytics', recordKey: 'lead-1', periodStart: FIRST,
    periodEnd: FIRST_END, metricName: 'qualified leads', value: '2', unit: 'count',
    currency: null, attributionMethod: 'unattributed', landingPage: '/pricing',
    notes: 'Reported by analytics', author: 'user', now: NOW });
  recordLedgerEntry(db, { source: 'team', entryKey: 'review-time', kind: 'time',
    activity: 'review', periodStart: FIRST, periodEnd: FIRST_END, minutes: 45,
    amount: null, currency: null, notes: '', author: 'user', now: NOW });
  recordLedgerEntry(db, { source: 'vendor', entryKey: 'unknown-invoice', kind: 'expense',
    activity: 'measurement', periodStart: FIRST, periodEnd: FIRST_END, minutes: null,
    amount: null, currency: null, notes: 'Bill not received', author: 'user', now: NOW });
  const report = buildWeeklyReview(db, { seriesId: series.id,
    start: FIRST, end: FIRST_END, now: NOW });
  assert.equal(report.reportedOutcomes[0].value, '2');
  assert.equal(report.reportedOutcomes[0].attributionMethod, 'unattributed');
  assert.equal(report.measurementSpend.costStatus, 'known');
  assert.equal(report.measurementSpend.knownSubtotalUsd, 0.25);
  assert.deepEqual(report.reportedLedger.map((item) => item.kind), ['time', 'expense']);
  assert.equal(report.reportedLedger[1].amount, null);
  assert.equal(report.importantEvidence[0].responseId, 1);
  assert.equal(report.actionState, 'nothing_requires_action');
  assert.match(report.interpretation, /neither proves/);
  const markdown = renderWeeklyMarkdown(report);
  assert.match(markdown, /qualified leads: 2 count/);
  assert.match(markdown, /unattributed/);
  assert.match(markdown, /known subtotal 0.25 USD/);
  assert.match(markdown, /User-reported expense: unknown/);
});

test('a partial API cost remains a known subtotal with an unknown component', (t) => {
  const { db, series } = fixture(t);
  run(db, `UPDATE responses SET cost_usd = NULL, cost_known_subtotal_usd = 0.10,
    cost_status = 'partial' WHERE id = 1`);
  const report = buildWeeklyReview(db, { seriesId: series.id,
    start: FIRST, end: FIRST_END, now: NOW });
  assert.equal(report.measurementSpend.costStatus, 'partial');
  assert.equal(report.measurementSpend.totalUsd, null);
  assert.equal(report.measurementSpend.knownSubtotalUsd, 0.10);
  assert.equal(report.measurementSpend.unknownCalls, 1);
  assert.match(report.health.join(' '), /known subtotal with unknown components/);
});
