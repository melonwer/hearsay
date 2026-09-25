import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, run } from '../core/db.js';
import {
  actualSpend, evidenceIncidence, listMeasurementSeries, mentionRate, providerBreakdown,
  resolveMeasurementSeries, stanceRecommendationRate,
} from '../core/metrics.js';

const START = '2026-09-01T00:00:00Z';
const END = '2026-09-03T00:00:00Z';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-series-'));
  const db = openDb(join(dir, 'hearsay.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  run(db, `INSERT INTO entities(id,name,aliases,domains,is_self,created_at)
    VALUES(1,'Notewell','[]','[]',1,?)`, [START]);
  run(db, 'INSERT INTO intents(id,label,created_at) VALUES(1,?,?)', ['Which tool?', START]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Which tool?','general',1,?)`, [START]);
  run(db, `INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')`, [START]);
  for (const id of ['profile-a', 'profile-b', 'profile-agent']) {
    run(db, 'INSERT INTO execution_profiles(id,surface,snapshot_json,created_at) VALUES(?,?,?,?)', [
      id, id === 'profile-agent' ? 'codex-agent' : 'openai-api', '{}', START,
    ]);
  }
  for (const id of ['benchmark-a', 'benchmark-b']) {
    run(db, 'INSERT INTO benchmark_revisions(id,snapshot_json,created_at) VALUES(?,?,?)', [id, '{}', START]);
  }
  return db;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id:number, at:string, surface?:string, profile?:string, benchmark?:string,
 *  revision?:string, key?:string, policy?:string, answerStatus?:string,
 *  targetStatus?:string, comparability?:string, webStatus?:string,
 *  queryMetadata?:string, text?:string|null, error?:string|null,
 *  mentioned?:boolean, cost?:number|null}} item
 */
function answer(db, item) {
  const surface = item.surface ?? 'openai-api';
  run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,error,
    created_at,surface,lane,target_status,comparability_status,web_status,
    execution_profile_id,benchmark_revision_id,analysis_revision,comparison_key,
    search_policy,answer_status,query_metadata_status,cost_usd)
    VALUES(?,1,1,?,?,?, ?,?, ?,?,'tracking',?,?,?, ?,?,?,?, ?,?,?,?)`, [
    item.id, surface === 'codex-agent' ? 'openai' : 'openai', 'fixture', item.id,
    item.text === undefined ? 'Notewell is an option.' : item.text, item.error ?? null,
    item.at, surface, item.targetStatus ?? 'completed', item.comparability ?? 'comparable',
    item.webStatus ?? 'not_applicable', item.profile ?? 'profile-a', item.benchmark ?? 'benchmark-a',
    item.revision ?? 'stance-en-v1', item.key ?? 'key-a', item.policy ?? 'off',
    item.answerStatus ?? 'complete', item.queryMetadata ?? 'not_applicable', item.cost ?? 1,
  ]);
  if (item.mentioned) {
    run(db, `INSERT INTO mentions(response_id,entity_id,first_index,occurrences,rank,recommended,snippet)
      VALUES(?,1,0,1,1,1,'Notewell')`, [item.id]);
  }
}

test('series selection uses exact stored dimensions and the historical half-open window', (t) => {
  const db = fixture(t);
  answer(db, { id: 1, at: '2026-09-01T12:00:00Z', mentioned: true });
  answer(db, { id: 2, at: '2026-09-02T12:00:00Z', profile: 'profile-b',
    key: 'key-b', policy: 'auto', webStatus: 'not_applicable' });
  answer(db, { id: 3, at: '2026-09-03T00:00:00Z', profile: 'profile-b',
    benchmark: 'benchmark-b', revision: 'stance-en-v2', key: 'key-c', policy: 'required' });
  const historical = listMeasurementSeries(db, { start: START, end: END });
  assert.equal(historical.length, 2);
  assert.deepEqual(historical.map((series) => [series.comparisonKey, series.searchPolicy]),
    [['key-b', 'auto'], ['key-a', 'off']]);
  assert.equal(historical[0].start, START);
  assert.equal(historical[0].end, END);
  assert.equal(resolveMeasurementSeries(db, { start: START, end: END })?.comparisonKey, 'key-b');
  assert.equal(mentionRate(db, { entityId: 1, surface: 'openai-api', start: START, end: END }).mentioned, 0,
    'surface fallback must resolve its latest key inside the requested window');
  assert.equal(listMeasurementSeries(db, { start: START, end: '2026-09-04T00:00:00Z' }).length, 3);
  const selectedAgain = listMeasurementSeries(db, { start: START, end: '2026-09-04T00:00:00Z' })
    .find((series) => series.comparisonKey === 'key-a');
  assert.equal(historical.find((series) => series.comparisonKey === 'key-a')?.id, selectedAgain?.id);
  assert.throws(() => resolveMeasurementSeries(db, { start: START, end: END, seriesId: 'missing' }),
    /does not exist/);
});

test('coverage and exact metrics exclude incomplete and noncomparable targets', (t) => {
  const db = fixture(t);
  answer(db, { id: 1, at: '2026-09-01T10:00:00Z', mentioned: true });
  answer(db, { id: 2, at: '2026-09-01T11:00:00Z', answerStatus: 'truncated', mentioned: true });
  answer(db, { id: 3, at: '2026-09-01T12:00:00Z', error: 'transport',
    targetStatus: 'failed', answerStatus: 'failed', text: null, mentioned: true });
  answer(db, { id: 4, at: '2026-09-01T13:00:00Z', comparability: 'non_comparable', mentioned: true });
  answer(db, { id: 5, at: '2026-09-02T10:00:00Z', profile: 'profile-b', key: 'key-b',
    policy: 'auto', webStatus: 'unverified', queryMetadata: 'available', mentioned: false });
  answer(db, { id: 6, at: '2026-09-02T11:00:00Z', surface: 'codex-agent',
    profile: 'profile-agent', key: 'key-agent', policy: 'required', webStatus: 'verified',
    queryMetadata: 'available', mentioned: true });
  answer(db, { id: 7, at: '2026-09-02T12:00:00Z', surface: 'codex-agent',
    profile: 'profile-agent', key: 'key-agent', policy: 'required', webStatus: 'unverified',
    mentioned: true });
  run(db, `INSERT INTO source_observations(response_id,url,normalized_url,provenance)
    VALUES(5,'https://example.com','https://example.com','reported_source')`);
  run(db, `INSERT INTO source_observations(response_id,url,normalized_url,provenance)
    VALUES(5,'https://example.com','https://example.com','reported_source')`);
  run(db, `INSERT INTO answer_citations(response_id,url,provenance,ordinal)
    VALUES(5,'https://example.com','native_annotation',1)`);
  run(db, `INSERT INTO answer_citations(response_id,url,provenance,ordinal)
    VALUES(5,'https://example.com','native_annotation',2)`);
  const series = listMeasurementSeries(db, { start: START, end: END });
  const off = series.find((item) => item.searchPolicy === 'off');
  const auto = series.find((item) => item.searchPolicy === 'auto');
  const required = series.find((item) => item.searchPolicy === 'required');
  assert.ok(off && auto && required);
  assert.deepEqual([off.attemptedTargets, off.completeAnswers, off.comparableAnswers], [4, 2, 1]);
  assert.deepEqual([auto.attemptedTargets, auto.completeAnswers, auto.comparableAnswers,
    auto.verifiedSearchAnswers, auto.queryMetadataAnswers], [1, 1, 1, 0, 1]);
  assert.deepEqual([required.attemptedTargets, required.completeAnswers,
    required.comparableAnswers, required.verifiedSearchAnswers], [2, 2, 1, 1]);
  assert.deepEqual([mentionRate(db, { entityId: 1, series: off }).n,
    mentionRate(db, { entityId: 1, series: auto }).n,
    mentionRate(db, { entityId: 1, series: required }).n], [1, 1, 1]);
  assert.deepEqual([mentionRate(db, { entityId: 1, series: off }).mentioned,
    mentionRate(db, { entityId: 1, series: auto }).mentioned,
    mentionRate(db, { entityId: 1, series: required }).mentioned], [1, 0, 1]);
  const incidence = evidenceIncidence(db, { entityId: 1, series: auto });
  assert.deepEqual([incidence.n, incidence.responsesWithSourceObservations,
    incidence.responsesWithAnswerCitations, incidence.responsesWithMentions], [1, 1, 1, 0]);
  assert.deepEqual([incidence.sourceRate.mentioned, incidence.citationRate.mentioned,
    incidence.mentionRate.mentioned], [1, 1, 0]);
  assert.equal(resolveMeasurementSeries(db, { start: START, end: END })?.id, required.id);
  const stance = stanceRecommendationRate(db, { entityId: 1, series: auto,
    analysisRevision: 'stance-en-v1' });
  assert.equal(stance.n, 1);
  assert.equal(stance.absent, 1);
  assert.equal(stance.lo, 0);
  assert.equal(stance.hi, 0.7934567085261071);
});

test('profile, benchmark, analysis, and policy each split a measurement series', (t) => {
  const db = fixture(t);
  const at = '2026-09-02T12:00:00Z';
  answer(db, { id: 1, at, mentioned: true });
  answer(db, { id: 2, at, profile: 'profile-b', mentioned: true });
  answer(db, { id: 3, at, benchmark: 'benchmark-b', mentioned: true });
  answer(db, { id: 4, at, revision: 'stance-en-v2', mentioned: true });
  answer(db, { id: 5, at, policy: 'auto', webStatus: 'not_applicable', mentioned: true });
  const series = listMeasurementSeries(db, { start: START, end: END });
  assert.equal(series.length, 5);
  assert.equal(new Set(series.map((item) => item.id)).size, 5);
  for (const item of series) {
    assert.equal(item.comparableAnswers, 1);
    assert.equal(mentionRate(db, { entityId: 1, series: item }).n, 1);
  }
});

test('exact provider errors and spend remain inside the selected series', (t) => {
  const db = fixture(t);
  answer(db, { id: 1, at: '2026-09-01T10:00:00Z', mentioned: true });
  answer(db, { id: 2, at: '2026-09-01T11:00:00Z', targetStatus: 'failed',
    answerStatus: 'failed', error: 'series-a-error', text: null });
  answer(db, { id: 3, at: '2026-09-02T10:00:00Z', profile: 'profile-b',
    key: 'key-b', policy: 'auto', targetStatus: 'failed', answerStatus: 'failed',
    error: 'series-b-error', text: null });
  const off = listMeasurementSeries(db, { start: START, end: END }).find((series) => series.searchPolicy === 'off');
  assert.ok(off);
  const providers = providerBreakdown(db, { series: off });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].lastError, 'series-a-error');
  assert.equal(providers[0].brandMentionRate.n, 1);
  const spend = actualSpend(db, { series: off });
  assert.equal(spend.attemptedCalls, 2);
  assert.equal(spend.totalUsd, 2);
});

test('default now window includes observations stamped in the current second', (t) => {
  const db = fixture(t);
  answer(db, { id: 1, at: '2026-09-02T12:00:00Z', mentioned: true });
  answer(db, { id: 2, at: '2026-09-01T12:00:00Z', mentioned: true });
  const selected = resolveMeasurementSeries(db, { now: '2026-09-02T12:00:00Z', days: 1 });
  assert.equal(selected?.comparableAnswers, 2);
  assert.equal(selected?.start, '2026-09-01T12:00:00Z');
  assert.equal(selected?.end, '2026-09-02T12:00:01Z');
  assert.equal(mentionRate(db, { entityId: 1, series: selected ?? undefined }).mentioned, 2);
  assert.equal(mentionRate(db, { entityId: 1, series: selected ?? undefined, days: 0.5 }).n, 1);
});
