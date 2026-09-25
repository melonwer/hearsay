import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, run } from '../core/db.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { appendCorrection } from '../core/interpretations.js';
import {
  answerEvidence, createQueryTheme, intentEvidenceReport, listEvidenceIntents,
  listQueryThemes, setQueryThemeAssignment,
} from '../core/evidence-report.js';

const START = '2026-09-01T00:00:00Z';
const END = '2026-09-03T00:00:00Z';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-evidence-'));
  const db = openDb(join(dir, 'hearsay.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  run(db, 'INSERT INTO intents(id,label,created_at) VALUES(1,?,?)', ['Choosing software', START]);
  run(db, 'INSERT INTO intents(id,label,created_at) VALUES(2,?,?)', ['Other intent', START]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Which service works?','general',1,?)`, [START]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(2,1,'What service should I buy?','general',1,?)`, [START]);
  run(db, `INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')`, [START]);
  run(db, `INSERT INTO execution_profiles(id,surface,snapshot_json,created_at)
    VALUES('profile-a','openai-api','{}',?)`, [START]);
  run(db, `INSERT INTO execution_profiles(id,surface,snapshot_json,created_at)
    VALUES('profile-b','openai-api','{}',?)`, [START]);
  run(db, `INSERT INTO benchmark_revisions(id,snapshot_json,created_at) VALUES('benchmark-a',?,?)`, [
    JSON.stringify({ questions: [
      { id: 1, intentId: 1, text: 'Which service works?', category: 'general' },
      { id: 2, intentId: 1, text: 'What service should I buy?', category: 'general' },
    ] }), START,
  ]);
  /** @param {number} id @param {number} promptId @param {string} at @param {string} [metadata] @param {string} [profile] @param {string} [comparability] */
  function answer(id, promptId, at, metadata = 'available', profile = 'profile-a', comparability = 'comparable') {
    run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
      surface,lane,target_status,comparability_status,web_status,execution_profile_id,
      benchmark_revision_id,analysis_revision,comparison_key,search_policy,answer_status,
      query_metadata_status,prompt_text_snapshot)
      VALUES(?,1,?,'openai','test-model',?, ?,?,'openai-api','tracking','completed',?,
        'verified',?,'benchmark-a','stance-en-v1','comparison-a','auto','complete',?,?)`, [
      id, promptId, id, `Answer ${id}`, at, comparability, profile, metadata,
      promptId === 1 ? 'Which service works?' : 'What service should I buy?',
    ]);
  }
  answer(1, 1, '2026-09-01T10:00:00Z');
  answer(2, 2, '2026-09-01T11:00:00Z');
  answer(3, 1, '2026-09-01T12:00:00Z', 'unavailable');
  answer(4, 1, '2026-09-01T13:00:00Z', 'available', 'profile-a', 'non_comparable');
  answer(5, 1, END);
  answer(6, 1, '2026-09-01T14:00:00Z', 'available', 'profile-b');
  run(db, `UPDATE prompts SET text = 'Edited later', intent_id = 2 WHERE id = 1`);
  const selected = listMeasurementSeries(db, { start: START, end: END })
    .find((series) => series.executionProfileId === 'profile-a');
  assert.ok(selected);
  return { db, series: selected };
}

test('intent report groups observed queries by answer incidence and preserves five evidence layers', (t) => {
  const { db, series } = fixture(t);
  run(db, `INSERT INTO search_events(id,response_id,event_type,status,observed_at,provider_action_id)
    VALUES(1,1,'search','completed',?,'action-1')`, [START]);
  run(db, `INSERT INTO search_events(id,response_id,event_type,status,observed_at,provider_action_id)
    VALUES(2,1,'search','completed',?,'action-2')`, [START]);
  run(db, `INSERT INTO search_events(id,response_id,event_type,status,observed_at,provider_action_id)
    VALUES(3,2,'search','completed',?,'action-3')`, [START]);
  for (const [responseId, eventId, text, ordinal] of [
    [1, 1, ' best   CRM ', 0], [1, 1, 'Another query', 1],
    [1, 2, 'best CRM', 0], [2, 3, 'best CRM', 0],
  ]) {
    run(db, `INSERT INTO search_queries(response_id,search_event_id,original_text,normalized_key,ordinal)
      VALUES(?,?,?,?,?)`, [Number(responseId), Number(eventId), String(text), String(text).trim().replace(/\s+/g, ' '), Number(ordinal)]);
  }
  run(db, `INSERT INTO source_observations(id,response_id,search_event_id,url,normalized_url,title,provenance)
    VALUES(1,1,1,'https://example.org/page#one','https://example.org/page','First title','search_result')`);
  run(db, `INSERT INTO source_observations(id,response_id,search_event_id,url,normalized_url,title,provenance)
    VALUES(2,1,NULL,'https://example.org/page#two','https://example.org/page','Second title','search_result')`);
  run(db, `INSERT INTO source_observations(id,response_id,search_event_id,url,normalized_url,title,provenance)
    VALUES(3,2,NULL,'https://redirect.example/go?to=publisher','https://redirect.example/go?to=publisher','Redirect','reported_source')`);
  run(db, `INSERT INTO answer_citations(id,response_id,source_observation_id,url,provenance,ordinal)
    VALUES(1,1,NULL,'https://example.org/page','native_annotation',0)`);
  run(db, `INSERT INTO answer_citations(id,response_id,source_observation_id,url,provenance,ordinal)
    VALUES(2,2,3,'https://redirect.example/go?to=publisher','explicit_reference',0)`);

  const report = intentEvidenceReport(db, { series, intentId: 1 });
  assert.ok(report);
  assert.equal(report.intent?.label, 'Choosing software');
  assert.deepEqual(report.questions.map((q) => [q.promptId, q.text, q.intentId]), [
    [1, 'Which service works?', 1], [2, 'What service should I buy?', 1],
  ]);
  assert.deepEqual([report.coverage.attemptedTargets, report.coverage.comparableAnswers,
    report.coverage.answersWithQueryMetadata, report.coverage.answersWithObservedQueries,
    report.coverage.queryMetadataUnavailable], [4, 3, 2, 2, 1]);
  const best = report.queries.find((q) => q.normalizedKey === 'best CRM');
  assert.deepEqual([best?.responseIncidence, best?.rawOccurrences, best?.responseIds], [2, 3, [2, 1]]);
  assert.deepEqual(best?.originalTexts.sort(), [' best   CRM ', 'best CRM']);
  assert.equal(report.queries.find((q) => q.normalizedKey === 'Another query')?.responseIncidence, 1);
  assert.equal(report.sources.find((s) => s.normalizedUrl === 'https://example.org/page')?.responseIncidence, 1);
  assert.equal(report.sources.find((s) => s.normalizedUrl === 'https://example.org/page')?.rawOccurrences, 2);
  assert.equal(report.sources.find((s) => s.urlHost === 'redirect.example')?.publisherDomain, null);
  const first = report.answers.find((answer) => answer.id === 1);
  assert.equal(first?.sourceObservations[1].searchEventId, null);
  assert.equal(first?.answerCitations[0].sourceObservationId, null);
  assert.equal(first?.searchActions.length, 2);
  assert.equal(first?.question.text, 'Which service works?');
  assert.equal(first?.createdAt, '2026-09-01T10:00:00Z');
  assert.equal(first?.model, 'test-model');
  assert.equal(answerEvidence(db, { series, responseId: 4 }), null);
  assert.equal(answerEvidence(db, { series, responseId: 5 }), null);
  assert.equal(answerEvidence(db, { series, responseId: 6 }), null);
  assert.equal(intentEvidenceReport(db, { series, intentId: 2 }), null);
  assert.deepEqual(listEvidenceIntents(db, { series }).map((item) => [item.id, item.questionCount]), [[1, 2]]);
});

test('manual themes annotate raw query groups without changing their counts', (t) => {
  const { db, series } = fixture(t);
  run(db, `INSERT INTO search_queries(response_id,original_text,normalized_key,ordinal)
    VALUES(1,'best CRM','best CRM',0)`);
  run(db, `INSERT INTO search_queries(response_id,original_text,normalized_key,ordinal)
    VALUES(1,'CRM price','CRM price',1)`);
  run(db, `INSERT INTO search_queries(response_id,original_text,normalized_key,ordinal)
    VALUES(2,'best CRM','best CRM',0)`);
  const theme = createQueryTheme(db, { label: 'Evaluation criteria', now: START });
  assert.deepEqual(setQueryThemeAssignment(db, {
    themeId: theme.id, normalizedKey: ' best  CRM ', assigned: true,
  }), { themeId: theme.id, normalizedKey: 'best CRM', assigned: true });
  setQueryThemeAssignment(db, { themeId: theme.id, normalizedKey: 'CRM price', assigned: true });
  assert.deepEqual(listQueryThemes(db)[0]?.normalizedKeys, ['CRM price', 'best CRM']);
  const report = intentEvidenceReport(db, { series, intentId: 1 });
  const grouped = report?.queries.find((query) => query.normalizedKey === 'best CRM');
  assert.deepEqual([grouped?.themeLabels, grouped?.responseIncidence, grouped?.rawOccurrences],
    [['Evaluation criteria'], 2, 2]);
  assert.deepEqual([report?.themeGroups[0]?.responseIncidence, report?.themeGroups[0]?.rawOccurrences,
    report?.themeGroups[0]?.responseIds.length, report?.themeGroups[0]?.queryIds.length], [2, 3, 2, 3]);
  assert.throws(() => setQueryThemeAssignment(db, {
    themeId: theme.id, normalizedKey: 'never observed', assigned: true,
  }), /observed search query/);
  setQueryThemeAssignment(db, { themeId: theme.id, normalizedKey: 'best CRM', assigned: false });
  assert.deepEqual(intentEvidenceReport(db, { series })?.queries
    .find((query) => query.normalizedKey === 'best CRM')?.themeLabels, []);
});

test('answer detail shows saved stance spans and correction history', (t) => {
  const { db, series } = fixture(t);
  run(db, `INSERT INTO entities(id,name,aliases,domains,is_self,created_at)
    VALUES(1,'Answer Co','[]','[]',1,?)`, [START]);
  const mentionId = run(db, `INSERT INTO mentions(response_id,entity_id,first_index,occurrences,rank,recommended,snippet)
    VALUES(1,1,0,1,1,1,'Answer')`).lastInsertRowid;
  const interpretationId = run(db, `INSERT INTO mention_interpretations(mention_id,analysis_revision,
    method,stance,rule_id,evidence_start,evidence_end,created_at)
    VALUES(?,'stance-en-v1','positive_stance','positive','fixture',0,6,?)`, [mentionId, START]).lastInsertRowid;
  appendCorrection(db, { responseId: 1, interpretationId, previousCorrectionId: null,
    replacement: 'negative', reason: 'The answer discourages use', requestId: 'correction-1', at: END });
  const detail = answerEvidence(db, { series, responseId: 1 });
  assert.deepEqual([detail?.mentions[0]?.entityName, detail?.mentions[0]?.originalStance,
    detail?.mentions[0]?.effectiveStance, detail?.mentions[0]?.evidenceStart,
    detail?.mentions[0]?.evidenceEnd, detail?.mentions[0]?.corrections[0]?.reason],
  ['Answer Co', 'positive', 'negative', 0, 6, 'The answer discourages use']);
});

test('empty selected series and missing intent stay empty, not fabricated', (t) => {
  const { db, series } = fixture(t);
  const empty = { ...series, start: '2026-08-01T00:00:00Z', end: '2026-08-02T00:00:00Z' };
  const report = intentEvidenceReport(db, { series: empty });
  assert.deepEqual([report?.questions.length, report?.queries.length, report?.answers.length,
    report?.coverage.comparableAnswers], [0, 0, 0, 0]);
  assert.equal(intentEvidenceReport(db, { series: empty, intentId: 1 }), null);
  assert.equal(answerEvidence(db, { series: empty, responseId: 1 }), null);
});
