import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get, openDb, run } from '../core/db.js';
import { createQueryTheme, setQueryThemeAssignment } from '../core/evidence-report.js';
import { captureFollowUpReview, saveFollowUpPlan } from '../core/follow-up.js';
import { compareIntervention, saveInterventionReview } from '../core/intervention-comparison.js';
import { appendCorrection } from '../core/interpretations.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { attachOpportunityPageEvidence, combineOpportunities, createOpportunity,
  deriveOpportunityCandidates, generateOpportunityCandidates, getOpportunity,
  listOpportunities, reviewOpportunity, reviewOpportunityPageEvidence } from '../core/opportunities.js';

const START = '2026-09-01T00:00:00Z';
const END = '2026-09-10T00:00:00Z';

/** @param {import('node:sqlite').DatabaseSync} db @param {Omit<Parameters<typeof reviewOpportunity>[1], 'expectedVersion'>} input */
const review = (db, input) => reviewOpportunity(db, { ...input,
  expectedVersion: getOpportunity(db, input.id)?.recordVersion ?? 0 });
/** @param {import('node:sqlite').DatabaseSync} db @param {Omit<Parameters<typeof attachOpportunityPageEvidence>[1], 'expectedVersion'>} input */
const attach = (db, input) => attachOpportunityPageEvidence(db, { ...input,
  expectedVersion: getOpportunity(db, input.id)?.recordVersion ?? 0 });
/** @param {import('node:sqlite').DatabaseSync} db @param {Omit<Parameters<typeof reviewOpportunityPageEvidence>[1], 'expectedVersion'>} input */
const reviewPage = (db, input) => reviewOpportunityPageEvidence(db, { ...input,
  expectedVersion: getOpportunity(db, input.id)?.recordVersion ?? 0 });
/** @param {import('node:sqlite').DatabaseSync} db @param {Omit<Parameters<typeof combineOpportunities>[1], 'expectedVersion'|'sourceExpectedVersion'>} input */
const combine = (db, input) => combineOpportunities(db, { ...input,
  expectedVersion: getOpportunity(db, input.targetId)?.recordVersion ?? 0,
  sourceExpectedVersion: getOpportunity(db, input.sourceId)?.recordVersion ?? 0 });

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  run(db, 'INSERT INTO entities(id,name,aliases,domains,is_self,created_at) VALUES(1,\'Acme\',\'[]\',\'[]\',1,?)', [START]);
  run(db, 'INSERT INTO intents(id,label,created_at) VALUES(1,\'Choosing a tool\',?)', [START]);
  run(db, 'INSERT INTO intents(id,label,created_at) VALUES(2,\'Other buyer\',?)', [START]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Which tool works?','general',1,?)`, [START]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(2,2,'Which other tool?','general',1,?)`, [START]);
  for (const id of [1, 2, 3]) run(db, `INSERT INTO runs(id,started_at,trigger,status)
    VALUES(?,?,'manual','done')`, [id, START]);
  for (const id of ['profile-a', 'profile-b']) run(db, `INSERT INTO execution_profiles(id,surface,snapshot_json,created_at)
    VALUES(?,'openai-api','{}',?)`, [id, START]);
  run(db, `INSERT INTO benchmark_revisions(id,snapshot_json,created_at) VALUES('benchmark-a',?,?)`, [
    JSON.stringify({ questions: [
      { id: 1, intentId: 1, text: 'Which tool works?', category: 'general' },
      { id: 2, intentId: 2, text: 'Which other tool?', category: 'general' },
    ], entities: [{ id: 1, role: 'brand', name: 'Acme' }] }), START,
  ]);
  /** @param {number} id @param {number} runId @param {number} promptId @param {string} at @param {string} [profile] */
  function answer(id, runId, promptId, at, profile = 'profile-a') {
    run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
      surface,lane,target_status,comparability_status,web_status,execution_profile_id,
      benchmark_revision_id,analysis_revision,comparison_key,search_policy,answer_status,
      query_metadata_status,prompt_text_snapshot)
      VALUES(?,?,?,'openai','fixture',?,'A comparison answer',?,'openai-api','tracking',
      'completed','comparable','verified',?,'benchmark-a','stance-en-v1','comparison-a',
      'auto','complete','available',?)`, [id, runId, promptId, id, at, profile,
      promptId === 1 ? 'Which tool works?' : 'Which other tool?']);
  }
  answer(1, 1, 1, '2026-09-02T10:00:00Z');
  answer(2, 1, 1, '2026-09-02T11:00:00Z');
  answer(3, 2, 1, '2026-09-03T10:00:00Z');
  answer(4, 2, 2, '2026-09-03T11:00:00Z');
  answer(5, 3, 1, '2026-09-03T12:00:00Z', 'profile-b');
  for (const id of [1, 2, 3]) {
    run(db, `INSERT INTO search_queries(id,response_id,original_text,normalized_key,ordinal)
      VALUES(?,?,'best tool','best tool',0)`, [id, id]);
    run(db, `INSERT INTO source_observations(id,response_id,url,normalized_url,excerpt,provenance)
      VALUES(?,?,'https://example.org/guide','https://example.org/guide','Page excerpt','search_result')`, [id, id]);
  }
  const theme = createQueryTheme(db, { label: 'Evaluation', now: START });
  setQueryThemeAssignment(db, { themeId: theme.id, normalizedKey: 'best tool', assigned: true });
  const series = listMeasurementSeries(db, { start: START, end: END })
    .find((item) => item.executionProfileId === 'profile-a');
  assert.ok(series);
  return { db, series, answer, theme };
}

test('repeated source and user theme require two distinct completed runs; IDs retain their layer', (t) => {
  const { db, series } = fixture(t);
  run(db, "UPDATE runs SET status='running' WHERE id=2");
  assert.deepEqual(deriveOpportunityCandidates(db, { series, intentId: 1 }), []);
  run(db, "UPDATE runs SET status='done' WHERE id=2");
  const candidates = deriveOpportunityCandidates(db, { series, intentId: 1 });
  assert.deepEqual(candidates.map((item) => item.candidateType).sort(), ['query_theme', 'source_without_brand']);
  const source = candidates.find((item) => item.candidateType === 'source_without_brand');
  assert.deepEqual(source?.support, { responseCount: 3, completedRunCount: 2 });
  assert.deepEqual(source?.evidence.sourceIds, [1, 2, 3]);
  assert.deepEqual(source?.evidence.queryIds, []);
  for (const responseId of [1, 3]) run(db, `INSERT INTO source_observations(response_id,url,normalized_url,provenance)
    VALUES(?,'https://example.org/guide','https://example.org/guide','reported_source')`, [responseId]);
  assert.equal(deriveOpportunityCandidates(db, { series, intentId: 1 })
    .filter((item) => item.candidateType === 'source_without_brand').length, 2);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM opportunities')?.n), 0);
  assert.equal(generateOpportunityCandidates(db, { series, intentId: 1,
    candidateKey: source.candidateKey }).length, 1);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM opportunities')?.n), 1);
  assert.throws(() => generateOpportunityCandidates(db, { series, intentId: 1,
    candidateKey: 'missing' }), /unavailable/);
});

test('a corrected brand stance uses the benchmark brand and current review decision', (t) => {
  const { db, series } = fixture(t);
  const mentionId = run(db, `INSERT INTO mentions(response_id,entity_id,first_index,occurrences,rank,
    recommended,snippet) VALUES(1,1,0,1,1,1,'A comparison answer')`).lastInsertRowid;
  const interpretationId = run(db, `INSERT INTO mention_interpretations(mention_id,analysis_revision,
    method,stance,rule_id,evidence_start,evidence_end,created_at)
    VALUES(?,'stance-en-v1','positive_stance','positive','fixture-rule',0,1,?)`, [mentionId, START]).lastInsertRowid;
  run(db, 'UPDATE entities SET is_self=0 WHERE id=1');
  assert.equal(deriveOpportunityCandidates(db, { series, intentId: 1 })
    .some((item) => item.candidateType === 'negative_brand_statement'), false);
  const corrected = appendCorrection(db, { responseId: 1, interpretationId: Number(interpretationId),
    previousCorrectionId: null, replacement: 'negative', reason: 'Read the saved answer',
    requestId: 'opportunity-stance-1', at: START });
  assert.equal(corrected.mentions[0].effectiveStance, 'negative');
  assert.deepEqual(deriveOpportunityCandidates(db, { series, intentId: 1 })
    .find((item) => item.candidateType === 'negative_brand_statement')?.evidence.responseIds, [1]);
  const saved = generateOpportunityCandidates(db, { series, intentId: 1 })
    .find((item) => item.candidateType === 'negative_brand_statement');
  assert.ok(saved);
  assert.equal(saved.evidence.stanceReviews?.[0]?.correctionId, corrected.mentions[0].correctionId);
  appendCorrection(db, { responseId: 1, interpretationId: Number(interpretationId),
    previousCorrectionId: corrected.mentions[0].correctionId, replacement: 'neutral',
    reason: 'Second review', requestId: 'opportunity-stance-2', at: START });
  assert.equal(deriveOpportunityCandidates(db, { series, intentId: 1 })
    .some((item) => item.candidateType === 'negative_brand_statement'), false);
  assert.equal(getOpportunity(db, saved.id)?.staleEvidence, true);
});

test('manual and assistant proposals validate exact scope and require human acceptance', (t) => {
  const { db, series } = fixture(t);
  const evidence = { responseIds: [1], queryIds: [1], sourceIds: [1], citationIds: [] };
  assert.throws(() => createOpportunity(db, { series, intentId: 1, evidence: { ...evidence, responseIds: [4] },
    origin: 'manual', author: 'user' }), /outside the selected scope/);
  assert.throws(() => createOpportunity(db, { series, intentId: 1,
    evidence: { ...evidence, queryIds: [3] }, origin: 'manual', author: 'user' }), /outside the selected responses/);
  assert.throws(() => createOpportunity(db, { series, intentId: 1,
    evidence: { ...evidence, sourceIds: [999] }, origin: 'manual', author: 'user' }), /outside the selected responses/);
  const wrongWindow = { ...series, start: '2026-09-04T00:00:00Z' };
  assert.throws(() => createOpportunity(db, { series: wrongWindow, intentId: 1, evidence,
    origin: 'manual', author: 'user' }), /series|Intent/);
  const proposed = createOpportunity(db, { series, intentId: 1, evidence, origin: 'assistant',
    author: 'mcp_assistant', hypothesis: 'Acme may need a guide.' });
  assert.equal(proposed.status, 'pending');
  assert.match(proposed.observedFinding, /1 selected comparable answer/);
  assert.doesNotMatch(proposed.observedFinding, /Acme may need a guide/);
  assert.equal(listOpportunities(db, { series }).length, 1);
  assert.throws(() => review(db, { id: proposed.id, status: 'planned',
    author: 'mcp_assistant' }), /Assistant cannot accept/);
  assert.equal(review(db, { id: proposed.id, status: 'investigate', author: 'user',
    priority: 3, effortBand: 'low' }).priority, 3);
  assert.throws(() => createOpportunity(db, { series, intentId: 1, evidence, origin: 'manual',
    author: 'user' }), /already has an opportunity/);
});

test('page actions require reviewed, attributed evidence; false claims need a user authority assertion', (t) => {
  const { db, series } = fixture(t);
  run(db, `INSERT INTO search_events(id,response_id,event_type,status,observed_at)
    VALUES(6,1,'fetch','completed','2026-09-02T10:00:00Z')`);
  run(db, `INSERT INTO source_observations(id,response_id,search_event_id,url,normalized_url,excerpt,provenance)
    VALUES(6,1,6,'https://acme.example/docs','https://acme.example/docs',
      'Acme handles local processing.','fetch')`);
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [1, 6], citationIds: [] },
    origin: 'manual', author: 'user', targetUrl: 'https://acme.example/docs',
    claimedFalseOrOutdated: true });
  const plan = { id: item.id, status: 'planned', actionKind: 'page_change',
    targetUrl: 'https://acme.example/docs',
    suggestedAction: 'Explain the local-processing capability on the docs page.',
    owner: 'Product team', reviewDate: '2026-10-01', author: 'user' };
  assert.throws(() => review(db, plan), /reviewed page evidence/);
  assert.throws(() => attach(db, { id: item.id,
    url: 'https://example.org/guide', observedAt: '2026-09-02T10:00:00Z', excerpt: 'Page excerpt',
    provenance: 'observed_fetch', sourceObservationId: 1, author: 'user' }), /Observed fetch excerpt/);
  const fetched = attach(db, { id: item.id,
    url: 'https://acme.example/docs', observedAt: '2026-09-02T10:00:00Z',
    excerpt: 'Acme handles local processing.', provenance: 'observed_fetch',
    sourceObservationId: 6, author: 'user' });
  assert.equal(fetched?.sourceObservationId, 6);
  assert.equal(fetched?.isAuthoritative, false);
  const page = attach(db, { id: item.id, url: 'https://acme.example/docs',
    observedAt: '2026-09-04T10:00:00Z', excerpt: 'Acme handles local processing.',
    provenance: 'manual_user', author: 'user' });
  assert.ok(page);
  reviewPage(db, { id: item.id, pageEvidenceId: page.id, author: 'user' });
  assert.throws(() => review(db, plan), /authoritative evidence/);
  const authority = attach(db, { id: item.id, url: 'https://acme.example/docs',
    observedAt: '2026-09-04T10:00:00Z', excerpt: 'Acme handles local processing.',
    provenance: 'manual_user', isAuthoritative: true, author: 'user' });
  assert.ok(authority);
  reviewPage(db, { id: item.id, pageEvidenceId: authority.id, author: 'user' });
  assert.equal(review(db, plan).status, 'planned');
});

test('dismissal, resurfacing, no action, combination, and stale records preserve provenance', (t) => {
  const { db, series, answer } = fixture(t);
  const generated = generateOpportunityCandidates(db, { series, intentId: 1 });
  const source = generated.find((item) => item.candidateType === 'source_without_brand');
  const theme = generated.find((item) => item.candidateType === 'query_theme');
  assert.ok(source && theme);
  review(db, { id: source.id, status: 'dismissed', dismissalReason: 'Not relevant',
    author: 'user', now: '2026-09-04T00:00:00Z' });
  assert.equal(deriveOpportunityCandidates(db, { series, intentId: 1 })
    .some((item) => item.candidateKey === source.candidateKey), false);
  assert.equal(generateOpportunityCandidates(db, { series, intentId: 1 })
    .some((item) => item.candidateKey === source.candidateKey), false);
  answer(6, 3, 1, '2026-09-03T13:00:00Z');
  run(db, `INSERT INTO source_observations(id,response_id,url,normalized_url,provenance)
    VALUES(6,6,'https://example.org/guide','https://example.org/guide','search_result')`);
  assert.equal(deriveOpportunityCandidates(db, { series, intentId: 1 })
    .some((item) => item.candidateKey === source.candidateKey), false);
  answer(7, 3, 1, '2026-09-05T10:00:00Z');
  run(db, `INSERT INTO source_observations(id,response_id,url,normalized_url,provenance)
    VALUES(7,7,'https://example.org/guide','https://example.org/guide','search_result')`);
  const resurfaced = deriveOpportunityCandidates(db, { series, intentId: 1 })
    .find((item) => item.candidateKey === source.candidateKey);
  assert.deepEqual(resurfaced?.newResponseIds, [7]);
  assert.match(resurfaced?.resurfacedExplanation ?? '', /New supporting answer 7/);
  generateOpportunityCandidates(db, { series, intentId: 1 });
  assert.equal(getOpportunity(db, source.id)?.status, 'investigate');
  assert.equal(getOpportunity(db, source.id)?.events.some((event) => event.eventType === 'resurfaced'), true);
  review(db, { id: theme.id, status: 'no_action', dismissalReason: 'No value', author: 'user' });
  const combined = combine(db, { targetId: source.id, sourceId: theme.id, author: 'user' });
  assert.equal(combined?.events.some((event) => event.eventType === 'combined_source'), true);
  assert.equal(getOpportunity(db, theme.id)?.status, 'combined');
  run(db, 'DELETE FROM responses WHERE id = 1');
  assert.equal(getOpportunity(db, source.id)?.staleEvidence, true);
  assert.throws(() => review(db, { id: source.id, status: 'planned', author: 'user' }),
    /owner and review date/);
  assert.throws(() => review(db, { id: source.id, status: 'planned', author: 'user',
    owner: 'Product team', reviewDate: '2026-10-01' }), /no longer available/);
});

test('a shipped action keeps its selected baseline, versioned dates, and observed profile changes', (t) => {
  const { db, series, answer } = fixture(t);
  const first = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-04T00:00:00Z' });
  const second = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [3], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-04T00:00:00Z' });
  assert.notEqual(first.id, second.id);
  const planned = review(db, { id: first.id, status: 'planned', owner: 'Content team',
    reviewDate: '2026-09-22', author: 'user', now: '2026-09-05T00:00:00Z' });
  assert.throws(() => reviewOpportunity(db, { id: first.id, expectedVersion: first.recordVersion,
    priority: 3, author: 'user' }), (error) => error.code === 'conflict');
  assert.throws(() => review(db, { id: first.id, status: 'shipped', author: 'user',
    now: '2026-09-10T00:00:00Z' }), /change description/);
  const fields = { id: first.id, baselineStart: START, baselineEnd: END,
    intentIds: [1], comparisonIntentIds: [2], primaryMetric: 'positive_stance_rate',
    expectedDirection: 'increase', reviewStart: '2026-09-11T00:00:00Z',
    reviewEnd: '2026-09-20T00:00:00Z', observationDelayDays: 1, author: 'user' };
  assert.throws(() => saveFollowUpPlan(db, { ...fields, expectedVersion: planned.recordVersion,
    reviewStart: '2026-09-09T00:00:00Z', now: '2026-09-09T00:00:00Z' }), /nonoverlapping/);
  const firstPlan = saveFollowUpPlan(db, { ...fields, expectedVersion: planned.recordVersion,
    now: '2026-09-09T00:00:00Z' });
  assert.deepEqual(firstPlan.baseline.answers.map((item) => item.responseId).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(firstPlan.retrospective, false);
  const shipped = review(db, { id: first.id, status: 'shipped', author: 'user',
    changeDescription: 'Published a clearer comparison page', shippedAt: '2026-09-10T00:00:00Z',
    estimatedEffortHours: 4, actualEffortHours: 5,
    now: '2026-09-10T01:00:00Z' });
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.actualEffortHours, 5);
  assert.throws(() => captureFollowUpReview(db, { id: second.id, planId: firstPlan.id,
    expectedVersion: second.recordVersion, author: 'user', now: '2026-09-21T00:00:00Z' }),
  /Only a shipped action/);
  answer(8, 3, 1, '2026-09-12T10:00:00Z');
  answer(9, 3, 1, '2026-09-12T11:00:00Z', 'profile-b');
  run(db, "INSERT INTO benchmark_revisions(id,snapshot_json,created_at) VALUES('benchmark-b','{}',?)", [START]);
  run(db, "UPDATE responses SET model='fixture-v2', benchmark_revision_id='benchmark-b' WHERE id=9");
  const capture = captureFollowUpReview(db, { id: first.id, planId: firstPlan.id,
    expectedVersion: shipped.recordVersion, author: 'user', now: '2026-09-21T00:00:00Z' });
  assert.deepEqual(capture.answers.map((item) => item.responseId), [8]);
  assert.equal(capture.seriesChanges.some((item) => item.executionProfileId === 'profile-b'
    && item.benchmarkRevisionId === 'benchmark-b' && item.model === 'fixture-v2'), true);
  assert.equal(capture.partialWindow, false);
  assert.deepEqual(getOpportunity(db, first.id)?.followUpPlans[0].baseline.answers
    .map((item) => item.responseId).sort((a, b) => a - b), [1, 2, 3, 4]);
  const changed = saveFollowUpPlan(db, { ...fields, expectedVersion: getOpportunity(db, first.id).recordVersion,
    reviewStart: '2026-09-12T00:00:00Z', reviewEnd: '2026-09-22T00:00:00Z',
    now: '2026-09-22T00:00:00Z' });
  assert.equal(changed.version, 2);
  assert.equal(changed.retrospective, true);
  assert.equal(getOpportunity(db, first.id)?.followUpPlans[0].reviewSnapshots[0].id, capture.id);
  assert.equal(getOpportunity(db, first.id)?.followUpPlans[0].reviewWindow.end, '2026-09-20T00:00:00Z');
  assert.equal(getOpportunity(db, first.id)?.events.some((item) => item.eventType === 'follow_up_planned'), true);
  run(db, 'DELETE FROM responses WHERE id = 1');
  assert.equal(getOpportunity(db, first.id)?.staleEvidence, true);
  assert.deepEqual(getOpportunity(db, first.id)?.followUpPlans[0].baseline.answers
    .map((item) => item.responseId).sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('historical shipment flags a late baseline and preserves each date edit', (t) => {
  const { db, series } = fixture(t);
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-04T00:00:00Z' });
  review(db, { id: item.id, status: 'planned', owner: 'Product team',
    reviewDate: '2026-09-22', author: 'user', now: '2026-09-05T00:00:00Z' });
  const shipped = review(db, { id: item.id, status: 'shipped',
    changeDescription: 'Updated buyer guide', shippedAt: '2026-09-09T00:00:00Z',
    author: 'user', now: '2026-09-10T00:00:00Z' });
  const plan = saveFollowUpPlan(db, { id: item.id, expectedVersion: shipped.recordVersion,
    baselineStart: START, baselineEnd: END, intentIds: [1], comparisonIntentIds: [],
    primaryMetric: 'brand_mention_rate', expectedDirection: 'increase',
    reviewStart: '2026-09-11T00:00:00Z', reviewEnd: '2026-09-20T00:00:00Z',
    observationDelayDays: 1, author: 'user', now: '2026-09-12T00:00:00Z' });
  assert.equal(plan.retrospective, true);
  assert.equal(plan.baselineAfterPublication, true);
  const changed = review(db, { id: item.id, shippedAt: '2026-09-08T00:00:00Z',
    author: 'user', now: '2026-09-13T00:00:00Z' });
  assert.equal(changed.shippedAt, '2026-09-08T00:00:00Z');
  const last = changed.events.at(-1);
  assert.equal(last?.details.previous.shippedAt, '2026-09-09T00:00:00Z');
  assert.equal(last?.details.shippedAt, '2026-09-08T00:00:00Z');
});

test('saved comparison gives each benchmark prompt equal weight despite unequal repeats', (t) => {
  const { db, series, answer } = fixture(t);
  run(db, "INSERT INTO prompts(id,intent_id,text,category,active,created_at) VALUES(3,1,'How private is the tool?','general',1,?)", [START]);
  run(db, 'UPDATE benchmark_revisions SET snapshot_json = ? WHERE id = ?', [
    JSON.stringify({ questions: [
      { id: 1, intentId: 1, text: 'Which tool works?', category: 'general' },
      { id: 2, intentId: 2, text: 'Which other tool?', category: 'general' },
      { id: 3, intentId: 1, text: 'How private is the tool?', category: 'general' },
    ], entities: [{ id: 1, role: 'brand', name: 'Acme' }], weighting: 'equal' }), 'benchmark-a',
  ]);
  answer(10, 3, 3, '2026-09-04T10:00:00Z');
  for (const responseId of [1, 10]) {
    const mentionId = run(db, `INSERT INTO mentions(response_id,entity_id,
      first_index,occurrences,rank,recommended,snippet) VALUES(?,1,0,1,1,0,'Acme')`, [responseId]).lastInsertRowid;
    run(db, `INSERT INTO mention_interpretations(mention_id,analysis_revision,method,stance,
      rule_id,evidence_start,evidence_end,created_at)
      VALUES(?,'stance-en-v1','positive_stance','neutral','fixture',0,1,?)`, [mentionId, START]);
  }
  run(db, `INSERT INTO answer_citations(response_id,url,provenance,ordinal)
    VALUES(1,'https://acme.example/guide','text_link',1)`);
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-05T00:00:00Z' });
  const planned = review(db, { id: item.id, status: 'planned', owner: 'Product team',
    reviewDate: '2026-09-22', author: 'user', now: '2026-09-06T00:00:00Z' });
  const plan = saveFollowUpPlan(db, { id: item.id, expectedVersion: planned.recordVersion,
    baselineStart: START, baselineEnd: END, intentIds: [1], comparisonIntentIds: [],
    primaryMetric: 'brand_mention_rate', expectedDirection: 'increase',
    reviewStart: '2026-09-11T00:00:00Z', reviewEnd: '2026-09-20T00:00:00Z',
    observationDelayDays: 0, author: 'user', now: '2026-09-07T00:00:00Z' });
  const shipped = review(db, { id: item.id, status: 'shipped',
    changeDescription: 'Published a product comparison', shippedAt: '2026-09-10T00:00:00Z',
    author: 'user', now: '2026-09-10T01:00:00Z' });
  answer(11, 3, 1, '2026-09-12T10:00:00Z');
  for (const id of [12, 13, 14]) answer(id, 3, 3, `2026-09-${id + 1}T10:00:00Z`);
  const reviewMentionId = run(db, `INSERT INTO mentions(response_id,entity_id,first_index,occurrences,rank,
    recommended,snippet) VALUES(11,1,0,1,1,0,'Acme')`).lastInsertRowid;
  run(db, `INSERT INTO mention_interpretations(mention_id,analysis_revision,method,stance,
    rule_id,evidence_start,evidence_end,created_at)
    VALUES(?,'stance-en-v1','positive_stance','neutral','fixture',0,1,?)`, [reviewMentionId, START]);
  const capture = captureFollowUpReview(db, { id: item.id, planId: plan.id,
    expectedVersion: shipped.recordVersion, author: 'user', now: '2026-09-21T00:00:00Z' });
  const full = compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: capture.id });
  assert.equal(full.status, 'observed_decrease');
  assert.deepEqual(full.scope.expectedPromptIds, [1, 3]);
  assert.deepEqual([full.metric.before.n, full.metric.before.hits, full.metric.before.rate], [4, 2, 2 / 3]);
  assert.deepEqual([full.metric.after.n, full.metric.after.hits, full.metric.after.rate], [4, 1, 1 / 2]);
  assert.equal(Math.round(full.metric.deltaPercentagePoints * 100) / 100, -16.67);
  assert.equal(full.metric.before.perPrompt[0].interval.n, 3);
  assert.equal(full.scope.baseline.dataCutoff, '2026-09-07T00:00:00Z');
  assert.equal(full.scope.review.dataCutoff, '2026-09-21T00:00:00Z');
  assert.equal(full.coverage.before.comparableAnswers, 4);
  assert.equal(full.coverage.after.comparableAnswers, 4);
  assert.equal(full.coverage.before.answersWithSourceObservations, 3);
  assert.equal(full.coverage.after.answersWithSourceObservations, 0);
  assert.equal(full.warnings.some((warning) => warning.includes('metadata coverage changed')), true);
  assert.deepEqual(full.changes.queries.find((row) => row.key === 'best tool')?.beforeResponseIds
    .slice().sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(full.changes.citations[0].beforeResponses, 1);
  assert.equal(full.changes.citations[0].afterResponses, 0);
  assert.throws(() => review(db, { id: item.id, status: 'reviewed', author: 'user',
    now: '2026-09-22T00:00:00Z' }), /saved human judgment/);
  const userReview = saveInterventionReview(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: capture.id, expectedVersion: getOpportunity(db, item.id).recordVersion,
    judgment: 'inconclusive', rationale: 'The series is small and other changes may matter.',
    author: 'user', now: '2026-09-22T00:00:00Z' });
  assert.equal(userReview.judgment, 'inconclusive');
  assert.equal(getOpportunity(db, item.id)?.status, 'reviewed');
  assert.equal(userReview.report.metric.before.rate, 2 / 3);
  assert.equal(userReview.report.scope.baseline.correctionCutoff, 0);
  assert.equal(userReview.report.scope.review.correctionCutoff, 0);
});

test('missing full-benchmark cells require an explicit common subset; zero samples differ from zero mentions', (t) => {
  const { db, series, answer } = fixture(t);
  run(db, "INSERT INTO prompts(id,intent_id,text,category,active,created_at) VALUES(3,1,'How private is the tool?','general',1,?)", [START]);
  run(db, 'UPDATE benchmark_revisions SET snapshot_json = ? WHERE id = ?', [
    JSON.stringify({ questions: [
      { id: 1, intentId: 1, text: 'Which tool works?', category: 'general' },
      { id: 3, intentId: 1, text: 'How private is the tool?', category: 'general' },
    ], entities: [{ id: 1, role: 'brand', name: 'Acme' }], weighting: 'equal' }), 'benchmark-a',
  ]);
  answer(10, 3, 3, '2026-09-04T10:00:00Z');
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-05T00:00:00Z' });
  const planned = review(db, { id: item.id, status: 'planned', owner: 'Product team',
    reviewDate: '2026-09-22', author: 'user', now: '2026-09-06T00:00:00Z' });
  const plan = saveFollowUpPlan(db, { id: item.id, expectedVersion: planned.recordVersion,
    baselineStart: START, baselineEnd: END, intentIds: [1], comparisonIntentIds: [],
    primaryMetric: 'brand_mention_rate', expectedDirection: 'increase',
    reviewStart: '2026-09-11T00:00:00Z', reviewEnd: '2026-09-20T00:00:00Z',
    observationDelayDays: 0, author: 'user', now: '2026-09-07T00:00:00Z' });
  const shipped = review(db, { id: item.id, status: 'shipped',
    changeDescription: 'Published comparison', shippedAt: '2026-09-10T00:00:00Z',
    author: 'user', now: '2026-09-10T01:00:00Z' });
  const empty = captureFollowUpReview(db, { id: item.id, planId: plan.id,
    expectedVersion: shipped.recordVersion, author: 'user', now: '2026-09-21T00:00:00Z' });
  assert.equal(compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: empty.id }).status, 'insufficient_data');
  answer(11, 3, 1, '2026-09-11T00:00:00Z');
  answer(12, 3, 1, '2026-09-20T00:00:00Z');
  const oneCell = captureFollowUpReview(db, { id: item.id, planId: plan.id,
    expectedVersion: getOpportunity(db, item.id).recordVersion,
    author: 'user', now: '2026-09-22T00:00:00Z' });
  const full = compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: oneCell.id });
  const common = compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: oneCell.id, mode: 'common_subset' });
  assert.equal(full.status, 'insufficient_data');
  assert.equal(full.metric.after.rate, null);
  assert.equal(common.status, 'observed_no_difference');
  assert.deepEqual(common.scope.selectedPromptIds, [1]);
  assert.deepEqual(common.scope.droppedCells, [
    { promptId: 3, baselineHasAnswer: true, reviewHasAnswer: false },
  ]);
  assert.deepEqual([common.metric.before.n, common.metric.before.hits, common.metric.before.rate], [3, 0, 0]);
  assert.deepEqual([common.metric.after.n, common.metric.after.hits, common.metric.after.rate], [1, 0, 0]);
  assert.deepEqual(oneCell.answers.map((answer) => answer.responseId), [11]);
});

test('changed profile metadata and analysis revisions remain incomparable', (t) => {
  const { db, series, answer } = fixture(t);
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-05T00:00:00Z' });
  const planned = review(db, { id: item.id, status: 'planned', owner: 'Product team',
    reviewDate: '2026-09-22', author: 'user', now: '2026-09-06T00:00:00Z' });
  const plan = saveFollowUpPlan(db, { id: item.id, expectedVersion: planned.recordVersion,
    baselineStart: START, baselineEnd: END, intentIds: [1], comparisonIntentIds: [],
    primaryMetric: 'brand_mention_rate', expectedDirection: 'increase',
    reviewStart: '2026-09-11T00:00:00Z', reviewEnd: '2026-09-20T00:00:00Z',
    observationDelayDays: 0, author: 'user', now: '2026-09-07T00:00:00Z' });
  const shipped = review(db, { id: item.id, status: 'shipped',
    changeDescription: 'Published comparison', shippedAt: '2026-09-10T00:00:00Z',
    author: 'user', now: '2026-09-10T01:00:00Z' });
  answer(8, 3, 1, '2026-09-12T10:00:00Z');
  run(db, `UPDATE execution_profiles SET snapshot_json='{"model":"alias-v2"}' WHERE id='profile-a'`);
  const capture = captureFollowUpReview(db, { id: item.id, planId: plan.id,
    expectedVersion: shipped.recordVersion, author: 'user', now: '2026-09-21T00:00:00Z' });
  const drift = compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: capture.id });
  assert.equal(drift.status, 'incomparable');
  assert.equal(drift.reasons.some((reason) => reason.includes('profile metadata changed')), true);
  const changedPanel = { ...structuredClone(capture), id: undefined };
  changedPanel.promptPanel.questions[0].text = 'A revised buyer question';
  const panelSnapshotId = run(db, `INSERT INTO follow_up_review_snapshots(plan_id,snapshot_json,author,captured_at)
    VALUES(?,?,?,?)`, [plan.id, JSON.stringify(changedPanel), 'fixture', '2026-09-21T00:30:00Z']).lastInsertRowid;
  const panelReport = compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: panelSnapshotId });
  assert.equal(panelReport.reasons.some((reason) => reason.includes('prompt panel changed')), true);
  const changedRevision = { ...structuredClone(capture), id: undefined };
  changedRevision.series.analysisRevision = 'stance-en-v2';
  const revisionSnapshotId = run(db, `INSERT INTO follow_up_review_snapshots(plan_id,snapshot_json,author,captured_at)
    VALUES(?,?,?,?)`, [plan.id, JSON.stringify(changedRevision), 'fixture', '2026-09-21T01:00:00Z']).lastInsertRowid;
  const revisionReport = compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: revisionSnapshotId });
  assert.equal(revisionReport.status, 'incomparable');
  assert.equal(revisionReport.reasons.some((reason) => reason.includes('analysis revision')), true);
});

test('saved human review pins corrected stance and flags another shipped action on the intent', (t) => {
  const { db, series, answer } = fixture(t);
  run(db, "UPDATE responses SET text='Acme is a useful comparison' WHERE id=1");
  const baselineMentionId = run(db, `INSERT INTO mentions(response_id,entity_id,first_index,
    occurrences,rank,recommended,snippet) VALUES(1,1,0,1,1,1,'Acme')`).lastInsertRowid;
  run(db, `INSERT INTO mention_interpretations(mention_id,analysis_revision,method,stance,
    rule_id,evidence_start,evidence_end,created_at)
    VALUES(?,'stance-en-v1','positive_stance','positive','fixture',0,4,?)`, [baselineMentionId, START]);
  const item = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-05T00:00:00Z' });
  const other = createOpportunity(db, { series, intentId: 1,
    evidence: { responseIds: [3], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual', author: 'user', now: '2026-09-05T00:00:00Z' });
  const planned = review(db, { id: item.id, status: 'planned', owner: 'Product team',
    reviewDate: '2026-09-22', author: 'user', now: '2026-09-06T00:00:00Z' });
  const plan = saveFollowUpPlan(db, { id: item.id, expectedVersion: planned.recordVersion,
    baselineStart: START, baselineEnd: END, intentIds: [1], comparisonIntentIds: [],
    primaryMetric: 'positive_stance_rate', expectedDirection: 'increase',
    reviewStart: '2026-09-11T00:00:00Z', reviewEnd: '2026-09-20T00:00:00Z',
    observationDelayDays: 0, author: 'user', now: '2026-09-07T00:00:00Z' });
  const shipped = review(db, { id: item.id, status: 'shipped',
    changeDescription: 'Published comparison', shippedAt: '2026-09-10T00:00:00Z',
    author: 'user', now: '2026-09-10T01:00:00Z' });
  review(db, { id: other.id, status: 'planned', owner: 'Product team', reviewDate: '2026-09-22',
    author: 'user', now: '2026-09-11T00:00:00Z' });
  review(db, { id: other.id, status: 'shipped', changeDescription: 'Changed the same buyer page',
    shippedAt: '2026-09-12T00:00:00Z', author: 'user', now: '2026-09-12T01:00:00Z' });
  answer(8, 3, 1, '2026-09-13T10:00:00Z');
  run(db, "UPDATE responses SET text='Acme is unsuitable here' WHERE id=8");
  const reviewMentionId = run(db, `INSERT INTO mentions(response_id,entity_id,first_index,
    occurrences,rank,recommended,snippet) VALUES(8,1,0,1,1,0,'Acme')`).lastInsertRowid;
  const interpretationId = run(db, `INSERT INTO mention_interpretations(mention_id,analysis_revision,
    method,stance,rule_id,evidence_start,evidence_end,created_at)
    VALUES(?,'stance-en-v1','positive_stance','negative','fixture',0,4,?)`, [reviewMentionId, START]).lastInsertRowid;
  const capture = captureFollowUpReview(db, { id: item.id, planId: plan.id,
    expectedVersion: shipped.recordVersion, author: 'user', now: '2026-09-21T00:00:00Z' });
  const report = compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: capture.id });
  assert.equal(report.status, 'observed_decrease');
  assert.deepEqual([report.metric.before.rate, report.metric.after.rate], [1 / 3, 0]);
  assert.deepEqual(report.confounders.map((action) => action.opportunityId), [other.id]);
  const saved = saveInterventionReview(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: capture.id, expectedVersion: getOpportunity(db, item.id).recordVersion,
    judgment: 'inconclusive', rationale: 'A second page changed during the review window.',
    author: 'user', now: '2026-09-22T00:00:00Z' });
  appendCorrection(db, { responseId: 8, interpretationId, previousCorrectionId: null,
    replacement: 'positive', reason: 'Reviewed the saved answer',
    requestId: 'c14-later-correction', at: '2026-09-23T00:00:00Z' });
  assert.equal(compareIntervention(db, { opportunityId: item.id, planId: plan.id,
    snapshotId: capture.id }).metric.after.rate, 0);
  assert.equal(getOpportunity(db, item.id)?.interventionReviews[0].report.metric.after.rate, 0);
  assert.equal(saved.report.scope.review.correctionCutoff, 0);
});
