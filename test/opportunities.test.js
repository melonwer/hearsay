import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get, openDb, run } from '../core/db.js';
import { createQueryTheme, setQueryThemeAssignment } from '../core/evidence-report.js';
import { appendCorrection } from '../core/interpretations.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { attachOpportunityPageEvidence, combineOpportunities, createOpportunity,
  deriveOpportunityCandidates, generateOpportunityCandidates, getOpportunity,
  listOpportunities, reviewOpportunity, reviewOpportunityPageEvidence } from '../core/opportunities.js';

const START = '2026-09-01T00:00:00Z';
const END = '2026-09-10T00:00:00Z';

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
  assert.throws(() => reviewOpportunity(db, { id: proposed.id, status: 'planned',
    author: 'mcp_assistant' }), /Assistant cannot accept/);
  assert.equal(reviewOpportunity(db, { id: proposed.id, status: 'investigate', author: 'user',
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
  assert.throws(() => reviewOpportunity(db, plan), /reviewed page evidence/);
  assert.throws(() => attachOpportunityPageEvidence(db, { id: item.id,
    url: 'https://example.org/guide', observedAt: '2026-09-02T10:00:00Z', excerpt: 'Page excerpt',
    provenance: 'observed_fetch', sourceObservationId: 1, author: 'user' }), /Observed fetch excerpt/);
  const fetched = attachOpportunityPageEvidence(db, { id: item.id,
    url: 'https://acme.example/docs', observedAt: '2026-09-02T10:00:00Z',
    excerpt: 'Acme handles local processing.', provenance: 'observed_fetch',
    sourceObservationId: 6, author: 'user' });
  assert.equal(fetched?.sourceObservationId, 6);
  assert.equal(fetched?.isAuthoritative, false);
  const page = attachOpportunityPageEvidence(db, { id: item.id, url: 'https://acme.example/docs',
    observedAt: '2026-09-04T10:00:00Z', excerpt: 'Acme handles local processing.',
    provenance: 'manual_user', author: 'user' });
  assert.ok(page);
  reviewOpportunityPageEvidence(db, { id: item.id, pageEvidenceId: page.id, author: 'user' });
  assert.throws(() => reviewOpportunity(db, plan), /authoritative evidence/);
  const authority = attachOpportunityPageEvidence(db, { id: item.id, url: 'https://acme.example/docs',
    observedAt: '2026-09-04T10:00:00Z', excerpt: 'Acme handles local processing.',
    provenance: 'manual_user', isAuthoritative: true, author: 'user' });
  assert.ok(authority);
  reviewOpportunityPageEvidence(db, { id: item.id, pageEvidenceId: authority.id, author: 'user' });
  assert.equal(reviewOpportunity(db, plan).status, 'planned');
});

test('dismissal, resurfacing, no action, combination, and stale records preserve provenance', (t) => {
  const { db, series, answer } = fixture(t);
  const generated = generateOpportunityCandidates(db, { series, intentId: 1 });
  const source = generated.find((item) => item.candidateType === 'source_without_brand');
  const theme = generated.find((item) => item.candidateType === 'query_theme');
  assert.ok(source && theme);
  reviewOpportunity(db, { id: source.id, status: 'dismissed', dismissalReason: 'Not relevant',
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
  reviewOpportunity(db, { id: theme.id, status: 'no_action', dismissalReason: 'No value', author: 'user' });
  const combined = combineOpportunities(db, { targetId: source.id, sourceId: theme.id, author: 'user' });
  assert.equal(combined?.events.some((event) => event.eventType === 'combined_source'), true);
  assert.equal(getOpportunity(db, theme.id)?.status, 'combined');
  run(db, 'DELETE FROM responses WHERE id = 1');
  assert.equal(getOpportunity(db, source.id)?.staleEvidence, true);
  assert.throws(() => reviewOpportunity(db, { id: source.id, status: 'planned', author: 'user' }),
    /owner and review date/);
  assert.throws(() => reviewOpportunity(db, { id: source.id, status: 'planned', author: 'user',
    owner: 'Product team', reviewDate: '2026-10-01' }), /no longer available/);
});
