import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDb, run } from '../core/db.js';
import { STANCE_REVISION } from '../core/analyze.js';
import { appendCorrection } from '../core/interpretations.js';
import { listMeasurementSeries, wilson } from '../core/metrics.js';
import {
  memoryVsRetrievalDelta,
  retrievalAttritionReport,
} from '../core/evidence-report.js';
import {
  citationPersistenceReport,
  deriveOpportunityCandidates,
} from '../core/opportunities.js';

const T0 = '2026-10-01T00:00:00Z';

/** @param {import('node:test').TestContext} t */
function createFixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());

  run(db, `INSERT INTO entities(id,name,aliases,domains,is_self,created_at)
    VALUES(1,'Notewell','["Notewell AI"]','["notewell.io"]',1,?)`, [T0]);
  run(db, `INSERT INTO entities(id,name,aliases,domains,is_self,created_at)
    VALUES(2,'Jotta','[]','["jotta.app"]',0,?)`, [T0]);
  run(db, `INSERT INTO entities(id,name,aliases,domains,is_self,created_at)
    VALUES(3,'EchoPad','[]','["echopad.ai"]',0,?)`, [T0]);

  run(db, `INSERT INTO intents(id,label,created_at) VALUES(1,'AI meeting notes',?)`, [T0]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Best AI meeting notes tool?','general',1,?)`, [T0]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(2,1,'Top transcription software for sales teams?','general',1,?)`, [T0]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(3,1,'Private offline meeting notes app?','general',1,?)`, [T0]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(4,1,'Cheapest call summarizer for startups?','general',1,?)`, [T0]);

  let nextRunId = 1;
  let nextRespId = 1;
  let nextSourceId = 1;

  /**
   * @param {{startedAt?:string,finishedAt?:string|null,trigger?:string,status?:string}} [opts]
   */
  function addRun(opts = {}) {
    const id = nextRunId++;
    const startedAt = opts.startedAt ?? `2026-10-0${id}T07:00:00Z`;
    const finishedAt = opts.finishedAt === undefined ? `2026-10-0${id}T07:05:00Z` : opts.finishedAt;
    run(db, `INSERT INTO runs(id,started_at,finished_at,trigger,status) VALUES(?,?,?,?,?)`, [
      id, startedAt, finishedAt, opts.trigger ?? 'manual', opts.status ?? 'done',
    ]);
    return id;
  }

  /**
   * @param {{runId:number,promptId:number,provider?:string,model?:string,surface?:string,
   *   searchPolicy?:string,webStatus?:string,text?:string,createdAt?:string,
   *   comparisonKey?:string,analysisRevision?:string,promptSnapshot?:string,
   *   comparabilityStatus?:string,targetStatus?:string,answerStatus?:string,
   *   executionProfileId?:string|null,benchmarkRevisionId?:string|null}} opts
   */
  function addResponse(opts) {
    const id = nextRespId++;
    const provider = opts.provider ?? 'openai';
    const model = opts.model ?? 'gpt-5.6-luna';
    const surface = opts.surface ?? `${provider}-api`;
    const searchPolicy = opts.searchPolicy ?? 'required';
    const webStatus = opts.webStatus ?? (searchPolicy === 'off' ? 'not_applicable' : 'verified');
    run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
      surface,lane,target_status,comparability_status,web_status,execution_profile_id,
      benchmark_revision_id,analysis_revision,comparison_key,search_policy,answer_status,
      prompt_text_snapshot)
      VALUES(?,?,?,?,?,?,?,?,?,'tracking',?,?,?,?,?,?,?,?,?,?)`, [
      id, opts.runId, opts.promptId, provider, model, id,
      opts.text ?? `Sample answer ${id}`,
      opts.createdAt ?? `2026-10-01T10:00:${String(id).padStart(2, '0')}Z`,
      surface,
      opts.targetStatus ?? 'completed',
      opts.comparabilityStatus ?? 'comparable',
      webStatus,
      opts.executionProfileId ?? null,
      opts.benchmarkRevisionId ?? null,
      opts.analysisRevision ?? STANCE_REVISION,
      opts.comparisonKey ?? `${surface}:${model}:${searchPolicy}`,
      searchPolicy,
      opts.answerStatus ?? 'complete',
      opts.promptSnapshot ?? null,
    ]);
    return id;
  }

  /**
   * @param {number} responseId
   * @param {string} url
   * @param {string} [provenance]
   */
  function addSource(responseId, url, provenance = 'search_result') {
    const id = nextSourceId++;
    const normalized = url.split('#')[0];
    run(db, `INSERT INTO source_observations(id,response_id,url,normalized_url,provenance)
      VALUES(?,?,?,?,?)`, [id, responseId, url, normalized, provenance]);
    return id;
  }

  /**
   * @param {number} responseId
   * @param {string} url
   * @param {number} ordinal
   * @param {number|null} [sourceObservationId]
   */
  function addCitation(responseId, url, ordinal, sourceObservationId = null) {
    run(db, `INSERT INTO answer_citations(response_id,source_observation_id,url,provenance,ordinal)
      VALUES(?,?,?,'native_annotation',?)`, [responseId, sourceObservationId, url, ordinal]);
  }

  /**
   * @param {number} responseId
   * @param {number} entityId
   * @param {'positive'|'negative'|'neutral'|'uncertain'} stance
   * @param {number} [rank]
   */
  function addMention(responseId, entityId, stance, rank = 1) {
    const mentionId = Number(run(db, `INSERT INTO mentions(response_id,entity_id,first_index,
      occurrences,rank,recommended,snippet) VALUES(?,?,0,1,?,?,'snippet')`, [
      responseId, entityId, rank, stance === 'positive' ? 1 : 0,
    ]).lastInsertRowid);
    const interpretationId = Number(run(db, `INSERT INTO mention_interpretations(mention_id,
      analysis_revision,method,stance,rule_id,evidence_start,evidence_end,created_at)
      VALUES(?,?,'positive_stance',?,'fixture_rule',0,6,?)`, [
      mentionId, STANCE_REVISION, stance, T0,
    ]).lastInsertRowid);
    return { mentionId, interpretationId };
  }

  return { db, addRun, addResponse, addSource, addCitation, addMention };
}

test('retrievalAttritionReport computes retrieved-vs-cited attrition, ownership buckets, and Wilson CIs', (t) => {
  const { db, addRun, addResponse, addSource, addCitation } = createFixture(t);
  const run1 = addRun({ startedAt: '2026-10-01T07:00:00Z' });
  const seededRun = addRun({ startedAt: '2026-10-01T08:00:00Z', trigger: 'seed' });

  // Response 1: retrieves 4 URLs (2 brand incl. subdomain, 1 competitor, 1 third-party),
  // cites 1 brand (linked via sourceObservationId) + 1 third-party (hallucinated/not retrieved).
  const r1 = addResponse({ runId: run1, promptId: 1 });
  const s1 = addSource(r1, 'https://docs.notewell.io/guide#top');
  addSource(r1, 'https://notewell.io/pricing');
  addSource(r1, 'https://jotta.app/compare');
  addSource(r1, 'https://g2.com/categories/meeting-notes');
  addCitation(r1, 'https://docs.notewell.io/guide', 0, s1);
  addCitation(r1, 'https://techradar.com/best-notes', 1, null);

  // Response 2: retrieves notewell.io/pricing again (dropped again) + g2.com (cited this time).
  const r2 = addResponse({ runId: run1, promptId: 2 });
  addSource(r2, 'https://notewell.io/pricing#plans');
  addSource(r2, 'https://g2.com/categories/meeting-notes');
  addCitation(r2, 'https://g2.com/categories/meeting-notes', 0, null);

  // Seeded response should be excluded by default (includeSeeded: false).
  const rSeed = addResponse({ runId: seededRun, promptId: 1 });
  addSource(rSeed, 'https://notewell.io/seeded-only');

  const report = retrievalAttritionReport(db);
  assert.equal(report.n, 2);
  assert.equal(report.answersWithSourceObservations, 2);
  assert.equal(report.answersWithCitations, 2);
  assert.equal(report.totalUniqueRetrievedUrls, 4);
  assert.equal(report.totalUniqueCitedUrls, 3);
  assert.equal(report.totalUniqueDroppedUrls, 3);

  // Across r1 (4 retrieved, 1 cited-from-retrieved, 3 dropped) + r2 (2 retrieved, 1 cited, 1 dropped):
  // total retrieved obs = 6, dropped = 4.
  assert.equal(report.retrievedObservations, 6);
  assert.equal(report.citedFromRetrievedObservations, 2);
  assert.equal(report.droppedObservations, 4);
  const expectedOverall = wilson(4, 6);
  assert.equal(report.attritionRate.n, 6);
  assert.equal(report.attritionRate.dropped, 4);
  assert.equal(report.attritionRate.p, expectedOverall.p);
  assert.equal(report.attritionRate.lo, expectedOverall.lo);
  assert.equal(report.attritionRate.hi, expectedOverall.hi);

  // Ownership breakdown:
  // brand_owned: 3 retrieved obs (docs.notewell.io cited, notewell.io/pricing dropped x2) -> 2/3 dropped
  assert.equal(report.byOwnership.brand_owned.retrievedObservations, 3);
  assert.equal(report.byOwnership.brand_owned.droppedObservations, 2);
  assert.equal(report.byOwnership.brand_owned.attritionRate.p, 2 / 3);
  // competitor_owned: 1 retrieved obs, 1 dropped -> 1/1
  assert.equal(report.byOwnership.competitor_owned.retrievedObservations, 1);
  assert.equal(report.byOwnership.competitor_owned.droppedObservations, 1);
  // third_party: 2 retrieved obs (g2.com dropped in r1, cited in r2), 2 cited obs (techradar + g2)
  assert.equal(report.byOwnership.third_party.retrievedObservations, 2);
  assert.equal(report.byOwnership.third_party.droppedObservations, 1);
  assert.equal(report.byOwnership.third_party.citedObservations, 2);

  // Top lists:
  assert.equal(report.topDroppedBrandUrls.length, 1);
  assert.equal(report.topDroppedBrandUrls[0].url, 'https://notewell.io/pricing');
  assert.equal(report.topDroppedBrandUrls[0].droppedCount, 2);
  assert.equal(report.topDroppedThirdPartyUrls.length, 1);
  assert.equal(report.topDroppedThirdPartyUrls[0].url, 'https://g2.com/categories/meeting-notes');
  assert.equal(report.topCitedUrls.length, 3);

  // With includeSeeded: true, seeded run is included.
  const withSeeded = retrievalAttritionReport(db, { includeSeeded: true });
  assert.equal(withSeeded.n, 3);
  assert.equal(withSeeded.totalUniqueRetrievedUrls, 5);
});

test('retrievalAttritionReport detects own-site hijacks and respects human stance corrections', (t) => {
  const { db, addRun, addResponse, addCitation, addMention } = createFixture(t);
  const run1 = addRun();

  // r1: Brand URL cited, competitor Jotta is positive, brand Notewell is neutral -> HIJACK.
  const r1 = addResponse({
    runId: run1,
    promptId: 1,
    promptSnapshot: 'Best AI meeting notes tool?',
  });
  addCitation(r1, 'https://notewell.io/compare', 0);
  const m1Brand = addMention(r1, 1, 'neutral', 1);
  const m1Comp = addMention(r1, 2, 'positive', 2);

  // r2: Brand URL cited, competitor EchoPad is positive, brand is absent -> HIJACK.
  const r2 = addResponse({
    runId: run1,
    promptId: 2,
    promptSnapshot: 'Top transcription software for sales teams?',
  });
  addCitation(r2, 'https://docs.notewell.io/sales', 0);
  addMention(r2, 3, 'positive', 1);

  // r3: Brand URL cited, BOTH brand and competitor positive -> NOT a hijack.
  const r3 = addResponse({ runId: run1, promptId: 3 });
  addCitation(r3, 'https://notewell.io/privacy', 0);
  const m3Brand = addMention(r3, 1, 'positive', 1);
  addMention(r3, 2, 'positive', 2);

  // r4: Competitor positive, brand NOT cited -> NOT an own-site hijack.
  const r4 = addResponse({ runId: run1, promptId: 4 });
  addCitation(r4, 'https://jotta.app/home', 0);
  addMention(r4, 2, 'positive', 1);

  const before = retrievalAttritionReport(db);
  assert.equal(before.hijacks.ownCitedAnswers, 3);
  assert.equal(before.hijacks.count, 2);
  assert.equal(before.hijacks.rate.n, 3);
  assert.equal(before.hijacks.rate.p, 2 / 3);
  assert.equal(before.hijacks.overallRate.n, 4);
  assert.equal(before.hijacks.overallRate.p, 0.5);

  const receipt1 = before.hijacks.receipts.find((item) => item.responseId === r1);
  assert.ok(receipt1);
  assert.equal(receipt1.promptText, 'Best AI meeting notes tool?');
  assert.equal(receipt1.provider, 'openai');
  assert.equal(receipt1.model, 'gpt-5.6-luna');
  assert.deepEqual(receipt1.ownCitedUrls, ['https://notewell.io/compare']);
  assert.deepEqual(receipt1.recommendedCompetitors, ['Jotta']);

  // Human correction 1: downgrade Jotta on r1 from positive -> neutral => r1 is NO LONGER a hijack.
  appendCorrection(db, {
    responseId: r1,
    interpretationId: m1Comp.interpretationId,
    previousCorrectionId: null,
    replacement: 'neutral',
    reason: 'Answer merely listed Jotta without recommending it',
    requestId: 'hijack-corr-1',
    at: '2026-10-02T00:00:00Z',
  });
  const afterDown = retrievalAttritionReport(db);
  assert.equal(afterDown.hijacks.count, 1);
  assert.deepEqual(afterDown.hijacks.receipts.map((item) => item.responseId), [r2]);

  // Human correction 2: downgrade brand Notewell on r3 from positive -> negative => r3 BECOMES a hijack!
  appendCorrection(db, {
    responseId: r3,
    interpretationId: m3Brand.interpretationId,
    previousCorrectionId: null,
    replacement: 'negative',
    reason: 'Answer actually criticized Notewell privacy',
    requestId: 'hijack-corr-2',
    at: '2026-10-02T01:00:00Z',
  });
  const afterBrandDown = retrievalAttritionReport(db);
  assert.equal(afterBrandDown.hijacks.count, 2);
  assert.deepEqual(afterBrandDown.hijacks.receipts.map((item) => item.responseId).sort((a, b) => a - b), [r2, r3]);

  // Human correction 3: restore Jotta on r1 to positive AND promote Notewell on r1 to positive => still not a hijack!
  const corrJottaBack = appendCorrection(db, {
    responseId: r1,
    interpretationId: m1Comp.interpretationId,
    previousCorrectionId: afterDown.hijacks.count === 1 ? 1 : null,
    replacement: 'positive',
    reason: 'Re-reviewed',
    requestId: 'hijack-corr-3',
    at: '2026-10-02T02:00:00Z',
  });
  assert.equal(corrJottaBack.mentions.find((m) => m.entityId === 2)?.effectiveStance, 'positive');
  appendCorrection(db, {
    responseId: r1,
    interpretationId: m1Brand.interpretationId,
    previousCorrectionId: null,
    replacement: 'positive',
    reason: 'Brand was also recommended',
    requestId: 'hijack-corr-4',
    at: '2026-10-02T02:01:00Z',
  });
  const afterBothPos = retrievalAttritionReport(db);
  assert.equal(afterBothPos.hijacks.receipts.some((item) => item.responseId === r1), false);
});

test('retrievalAttritionReport reports explicit limitations for agy-cli, memory-only runs, and mixed series', (t) => {
  const { db, addRun, addResponse, addSource, addCitation } = createFixture(t);
  const run1 = addRun();

  // agy-cli verified search with NO source_observations (only final citation).
  const rAgy = addResponse({
    runId: run1, promptId: 1, provider: 'gemini', model: 'gemini-3.6-flash',
    surface: 'agy-cli', searchPolicy: 'required', webStatus: 'verified',
  });
  addCitation(rAgy, 'https://g2.com/review', 0);

  // openai-api verified search WITH source_observations.
  const rOai = addResponse({
    runId: run1, promptId: 1, provider: 'openai', model: 'gpt-5.6-luna',
    surface: 'openai-api', searchPolicy: 'required', webStatus: 'verified',
  });
  addSource(rOai, 'https://notewell.io/docs');

  // Memory-only run (search_policy = 'off') + auto no_search_confirmed (web_status = 'not_used').
  addResponse({
    runId: run1, promptId: 1, provider: 'openai', model: 'gpt-5.6-luna',
    surface: 'openai-api', searchPolicy: 'off', webStatus: 'not_applicable',
  });
  addResponse({
    runId: run1, promptId: 2, provider: 'openai', model: 'gpt-5.6-luna',
    surface: 'openai-api', searchPolicy: 'auto', webStatus: 'not_used',
  });

  const report = retrievalAttritionReport(db);
  assert.equal(report.n, 2);
  assert.equal(report.answersWithSourceObservations, 1);
  assert.equal(report.answersWithoutSourceObservations, 1);
  assert.equal(report.retrievedObservations, 1);
  assert.equal(report.droppedObservations, 1);
  assert.equal(report.bySeries.length, 2);

  assert.equal(report.limitations.some((msg) => msg.includes('agy-cli') && msg.includes('source_observations')), true);
  assert.equal(report.limitations.some((msg) => msg.includes('Excluded 2 memory-only')), true);
  assert.equal(report.limitations.some((msg) => msg.includes('2 distinct model/series')), true);

  // Filtering by surface/model/runId/seriesKey narrows cleanly without mixed-series warning.
  const narrowed = retrievalAttritionReport(db, {
    surface: 'openai-api', provider: 'openai', model: 'gpt-5.6-luna',
    searchPolicy: 'required', runId: run1, seriesKey: 'openai-api:gpt-5.6-luna:required',
  });
  assert.equal(narrowed.n, 1);
  assert.equal(narrowed.bySeries.length, 1);
  assert.equal(narrowed.limitations.some((msg) => msg.includes('distinct model/series')), false);
});

test('memoryVsRetrievalDelta strictly pairs by prompt_id within (provider, model) and classifies all 4 states', (t) => {
  const { db, addRun, addResponse, addCitation, addMention } = createFixture(t);
  const runMem = addRun({ startedAt: '2026-10-01T07:00:00Z' });
  const runGnd = addRun({ startedAt: '2026-10-01T08:00:00Z' });

  // Model A: openai / gpt-5.6-luna — 4 paired prompts covering all 4 classifications for Brand (Notewell):
  // Prompt 1: memory_anchored (brand in both; brand positive in both; brand cited when grounded)
  const m1 = addResponse({ runId: runMem, promptId: 1, searchPolicy: 'off', webStatus: 'not_applicable' });
  addMention(m1, 1, 'positive');
  const g1 = addResponse({ runId: runGnd, promptId: 1, searchPolicy: 'required', webStatus: 'verified' });
  addMention(g1, 1, 'positive');
  addCitation(g1, 'https://notewell.io/overview', 0);

  // Prompt 2: search_dependent (brand absent in memory via auto/not_used, appears + positive + cited with search)
  const m2 = addResponse({ runId: runMem, promptId: 2, searchPolicy: 'auto', webStatus: 'not_used' });
  addMention(m2, 2, 'positive');
  const g2 = addResponse({ runId: runGnd, promptId: 2, searchPolicy: 'auto', webStatus: 'verified' });
  addMention(g2, 1, 'positive');
  addMention(g2, 2, 'neutral');
  addCitation(g2, 'https://notewell.io/sales', 0);

  // Prompt 3: memory_displaced (brand in memory, DISAPPEARS when search runs; Jotta takes over!)
  const m3 = addResponse({ runId: runMem, promptId: 3, searchPolicy: 'off', webStatus: 'not_applicable' });
  addMention(m3, 1, 'neutral');
  const g3 = addResponse({ runId: runGnd, promptId: 3, searchPolicy: 'required', webStatus: 'verified' });
  addMention(g3, 2, 'positive');
  addCitation(g3, 'https://jotta.app/privacy', 0);

  // Prompt 4: absent_in_both (brand absent in both; EchoPad in grounded only)
  addResponse({ runId: runMem, promptId: 4, searchPolicy: 'off', webStatus: 'not_applicable' });
  const g4 = addResponse({ runId: runGnd, promptId: 4, searchPolicy: 'required', webStatus: 'verified' });
  addMention(g4, 3, 'positive');

  // Strict model separation test:
  // Model B (openai / gpt-5-mini) has ONLY memory on prompt 1.
  // Model C (anthropic / claude-sonnet-5) has ONLY grounded on prompt 1.
  // They MUST NEVER be blended with Model A or with each other!
  const bMem = addResponse({
    runId: runMem, promptId: 1, provider: 'openai', model: 'gpt-5-mini',
    surface: 'openai-api', searchPolicy: 'off', webStatus: 'not_applicable',
  });
  addMention(bMem, 1, 'positive');
  const cGnd = addResponse({
    runId: runGnd, promptId: 1, provider: 'anthropic', model: 'claude-sonnet-5',
    surface: 'anthropic-api', searchPolicy: 'auto', webStatus: 'verified',
  });
  addMention(cGnd, 2, 'positive');

  // Model D (gemini / gemini-3.6-flash): both memory and grounded exist, but on DISJOINT prompt_ids (1 vs 2).
  addResponse({
    runId: runMem, promptId: 1, provider: 'gemini', model: 'gemini-3.6-flash',
    surface: 'gemini-api', searchPolicy: 'off', webStatus: 'not_applicable',
  });
  addResponse({
    runId: runGnd, promptId: 2, provider: 'gemini', model: 'gemini-3.6-flash',
    surface: 'gemini-api', searchPolicy: 'auto', webStatus: 'verified',
  });

  const delta = memoryVsRetrievalDelta(db);
  assert.equal(delta.summary.totalModels, 4);
  assert.equal(delta.summary.pairedModels, 1);
  assert.equal(delta.summary.unpairedModels, 3);
  assert.equal(delta.summary.totalPairedPrompts, 4);

  const luna = delta.pairs.find((p) => p.provider === 'openai' && p.model === 'gpt-5.6-luna');
  assert.ok(luna);
  assert.equal(luna.status, 'paired');
  assert.deepEqual(luna.pairedPromptIds, [1, 2, 3, 4]);
  assert.equal(luna.memoryResponseCount, 4);
  assert.equal(luna.groundedResponseCount, 4);

  // Brand (Notewell): memory 2/4 (0.5), grounded 2/4 (0.5), delta 0;
  // positive: memory 1/4 (0.25), grounded 2/4 (0.5), delta +0.25; grounded citations: 2/4 (0.5)
  assert.ok(luna.brand);
  assert.equal(luna.brand.memoryMentionRate.n, 4);
  assert.equal(luna.brand.memoryMentionRate.p, 0.5);
  assert.equal(luna.brand.groundedMentionRate.n, 4);
  assert.equal(luna.brand.groundedMentionRate.p, 0.5);
  assert.equal(luna.brand.deltaMentionRate, 0);
  assert.equal(luna.brand.memoryPositiveRate.p, 0.25);
  assert.equal(luna.brand.groundedPositiveRate.p, 0.5);
  assert.equal(luna.brand.deltaPositiveRate, 0.25);
  assert.equal(luna.brand.groundedCitationRate.p, 0.5);

  assert.deepEqual(luna.classificationSummary, {
    memory_anchored: 1,
    search_dependent: 1,
    memory_displaced: 1,
    absent_in_both: 1,
  });
  const byPrompt = new Map(luna.brandPromptClassifications.map((item) => [item.promptId, item.classification]));
  assert.equal(byPrompt.get(1), 'memory_anchored');
  assert.equal(byPrompt.get(2), 'search_dependent');
  assert.equal(byPrompt.get(3), 'memory_displaced');
  assert.equal(byPrompt.get(4), 'absent_in_both');

  // Competitor Jotta: memory 1/4 (0.25), grounded 2/4 (0.5), delta +0.25, cited 1/4 (0.25)
  const jotta = luna.competitors.find((c) => c.name === 'Jotta');
  assert.ok(jotta);
  assert.equal(jotta.memoryMentionRate.p, 0.25);
  assert.equal(jotta.groundedMentionRate.p, 0.5);
  assert.equal(jotta.deltaMentionRate, 0.25);
  assert.equal(jotta.groundedCitationRate.p, 0.25);

  // Unpaired models are reported gracefully, never blended:
  const mini = delta.pairs.find((p) => p.model === 'gpt-5-mini');
  assert.equal(mini?.status, 'memory_only');
  assert.equal(mini?.pairedPromptCount, 0);
  assert.equal(mini?.unpaired.memoryOnlyPromptCount, 1);
  assert.equal(mini?.brand?.deltaMentionRate, null);

  const claude = delta.pairs.find((p) => p.model === 'claude-sonnet-5');
  assert.equal(claude?.status, 'grounded_only');
  assert.equal(claude?.unpaired.groundedOnlyPromptCount, 1);

  const gemini = delta.pairs.find((p) => p.model === 'gemini-3.6-flash');
  assert.equal(gemini?.status, 'no_overlap');
  assert.equal(gemini?.pairedPromptCount, 0);
  assert.equal(gemini?.unpaired.memoryOnlyPromptCount, 1);
  assert.equal(gemini?.unpaired.groundedOnlyPromptCount, 1);
});

test('memoryVsRetrievalDelta excludes unpaired prompts on partially overlapping models and respects human stance corrections', (t) => {
  const { db, addRun, addResponse, addMention } = createFixture(t);
  const run1 = addRun({ startedAt: '2026-10-01T07:00:00Z' });
  const run2 = addRun({ startedAt: '2026-10-01T08:00:00Z' });

  // Prompt 1 is paired; Prompt 2 is memory-only; Prompt 3 is grounded-only.
  const m1 = addResponse({ runId: run1, promptId: 1, searchPolicy: 'off', webStatus: 'not_applicable' });
  addMention(m1, 1, 'neutral');
  const m2 = addResponse({ runId: run1, promptId: 2, searchPolicy: 'off', webStatus: 'not_applicable' });
  addMention(m2, 1, 'positive'); // MUST NOT affect paired memory rates!

  const g1 = addResponse({ runId: run2, promptId: 1, searchPolicy: 'required', webStatus: 'verified' });
  const g1Brand = addMention(g1, 1, 'neutral');
  const g3 = addResponse({ runId: run2, promptId: 3, searchPolicy: 'required', webStatus: 'verified' });
  addMention(g3, 1, 'positive'); // MUST NOT affect paired grounded rates!

  const before = memoryVsRetrievalDelta(db);
  const pair = before.pairs[0];
  assert.deepEqual(pair.pairedPromptIds, [1]);
  assert.deepEqual(pair.unpaired.memoryOnlyPromptIds, [2]);
  assert.deepEqual(pair.unpaired.groundedOnlyPromptIds, [3]);
  assert.equal(pair.brand?.memoryMentionRate.n, 1);
  assert.equal(pair.brand?.groundedMentionRate.n, 1);
  assert.equal(pair.brand?.memoryPositiveRate.p, 0);
  assert.equal(pair.brand?.groundedPositiveRate.p, 0);

  // Human correction promotes brand stance on g1 from neutral -> positive.
  appendCorrection(db, {
    responseId: g1,
    interpretationId: g1Brand.interpretationId,
    previousCorrectionId: null,
    replacement: 'positive',
    reason: 'Answer explicitly endorses Notewell',
    requestId: 'delta-corr-1',
    at: '2026-10-02T00:00:00Z',
  });
  const after = memoryVsRetrievalDelta(db);
  assert.equal(after.pairs[0].brand?.groundedPositiveRate.p, 1);
  assert.equal(after.pairs[0].brand?.deltaPositiveRate, 1);
});

test('citationPersistenceReport tie-breaks offSiteTargets by recommendations then citations, respects corrections, and counts zero-citation waves', (t) => {
  const { db, addRun, addResponse, addCitation, addMention } = createFixture(t);
  const w1 = addRun({ startedAt: '2026-10-01T07:00:00Z' });
  const w2 = addRun({ startedAt: '2026-10-02T07:00:00Z' });
  const w3 = addRun({ startedAt: '2026-10-03T07:00:00Z' });

  // Wave 1 & Wave 2 cite 3 third-party URLs (all 2/3 = 0.667 -> durable):
  // - urlA: 2 waves, 2 competitor recommendations, 2 citations
  // - urlB: 2 waves, 1 competitor recommendation (2nd corrected to neutral), 4 citations
  // - urlC: 2 waves, 2 competitor recommendations, 4 citations (2 responses per wave!)
  // Wave 3 has an eligible completed response with 0 citations (still counts as wave 3!).
  /** @type {number[]} */
  const bCompInterps = [];
  for (const runId of [w1, w2]) {
    const rA = addResponse({ runId, promptId: 1 });
    addMention(rA, 2, 'positive');
    addCitation(rA, 'https://alpha.example/review', 0);

    const rB1 = addResponse({ runId, promptId: 2 });
    const mb = addMention(rB1, 2, 'positive');
    bCompInterps.push(mb.interpretationId);
    addCitation(rB1, 'https://beta.example/review', 0);
    const rB2 = addResponse({ runId, promptId: 3 });
    addMention(rB2, 2, 'neutral');
    addCitation(rB2, 'https://beta.example/review', 0);

    const rC1 = addResponse({ runId, promptId: 1 });
    addMention(rC1, 2, 'positive');
    addCitation(rC1, 'https://gamma.example/review', 0);
    const rC2 = addResponse({ runId, promptId: 4 });
    addMention(rC2, 2, 'neutral');
    addCitation(rC2, 'https://gamma.example/review', 0);
  }
  // Wave 3: zero citations.
  addResponse({ runId: w3, promptId: 1 });

  // Human correction downgrades beta's second-wave positive mention to neutral -> beta now has 1 recommendation.
  const betaWave2Resp = Number(
    db.prepare('SELECT response_id FROM mentions m JOIN mention_interpretations i ON i.mention_id = m.id WHERE i.id = ?')
      .get(bCompInterps[1]).response_id,
  );
  appendCorrection(db, {
    responseId: betaWave2Resp,
    interpretationId: bCompInterps[1],
    previousCorrectionId: null,
    replacement: 'neutral',
    reason: 'Mention was factual only',
    requestId: 'persist-corr-1',
    at: '2026-10-04T00:00:00Z',
  });

  const report = citationPersistenceReport(db);
  assert.equal(report.totalWaves, 3);
  assert.equal(report.waves[2].citationCount, 0);
  // Order: all durable with persistenceRate 2/3 ->
  // gamma (2 recs, 4 citations) > alpha (2 recs, 2 citations) > beta (1 rec, 4 citations)
  assert.deepEqual(report.offSiteTargets.map((item) => item.url), [
    'https://gamma.example/review',
    'https://alpha.example/review',
    'https://beta.example/review',
  ]);
  assert.equal(report.offSiteTargets[2].competitorRecommendations, 1);
});

test('citationPersistenceReport refuses to fake durability on 1 wave (single_wave_unverified)', (t) => {
  const { db, addRun, addResponse, addCitation, addMention } = createFixture(t);
  const run1 = addRun({ startedAt: '2026-10-01T07:00:00Z', status: 'done' });
  // An unfinished running run MUST NOT count as a second wave.
  const runPending = addRun({ startedAt: '2026-10-02T07:00:00Z', status: 'running' });

  const r1 = addResponse({ runId: run1, promptId: 1 });
  addCitation(r1, 'https://g2.com/categories/meeting-notes', 0);
  addCitation(r1, 'https://notewell.io/docs', 1);
  addMention(r1, 2, 'positive');

  const rPending = addResponse({ runId: runPending, promptId: 1 });
  addCitation(rPending, 'https://g2.com/categories/meeting-notes', 0);

  const report = citationPersistenceReport(db);
  assert.equal(report.totalWaves, 1);
  assert.equal(report.summary.totalWaves, 1);
  assert.equal(report.summary.durableCount, 0);
  assert.equal(report.summary.singleWaveUnverifiedCount, 2);
  assert.equal(report.summary.ephemeralChurnRate, null);
  assert.equal(report.summary.offSiteShare, 0.5);

  for (const item of report.urls) assert.equal(item.tier, 'single_wave_unverified');
  for (const item of report.domains) assert.equal(item.tier, 'single_wave_unverified');

  // Brand domain kept in domains, excluded from offSiteTargets.
  assert.equal(report.domains.some((d) => d.domain === 'notewell.io' && d.ownership === 'brand_owned'), true);
  assert.equal(report.offSiteTargets.length, 1);
  assert.equal(report.offSiteTargets[0].url, 'https://g2.com/categories/meeting-notes');
  assert.equal(report.offSiteTargets[0].tier, 'single_wave_unverified');
  assert.equal(report.limitations.some((msg) => msg.includes('single_wave_unverified')), true);
});

test('citationPersistenceReport classifies multi-wave durability, ranks offSiteTargets, and enriches opportunities', (t) => {
  const { db, addRun, addResponse, addCitation, addMention } = createFixture(t);

  // Create 5 completed waves (runs 1..5).
  const waves = [1, 2, 3, 4, 5].map((day) => addRun({
    startedAt: `2026-10-0${day}T07:00:00Z`,
    finishedAt: `2026-10-0${day}T07:05:00Z`,
    status: 'done',
  }));

  // Tracked URLs across 5 waves:
  // 1. https://g2.com/best-notes -> waves 1,2,3,4 (4/5 = 0.80 -> durable), Jotta recommended, brand absent
  // 2. https://capterra.com/notes -> waves 1,3,5 (3/5 = 0.60 -> durable boundary!), Jotta recommended, brand absent
  // 3. https://reddit.com/r/saas/thread -> waves 1,2 (2/5 = 0.40 -> recurring), Jotta recommended, brand absent
  // 4. https://blog.example/ephemeral -> wave 1 only (1/5 = 0.20 -> ephemeral), Jotta recommended, brand absent
  // 5. https://forbes.com/roundup -> waves 1,2,3,4 (durable), BOTH brand + competitor mentioned -> brandAbsentCount=0 (not offSiteTarget!)
  // 6. https://notewell.io/guide -> waves 1,2,3 (brand_owned -> in domains/urls, excluded from offSiteTargets)
  // 7. https://jotta.app/features -> waves 1,2,3 (competitor_owned -> in domains/urls, excluded from offSiteTargets)
  waves.forEach((runId, idx) => {
    const waveNum = idx + 1;
    const at = `2026-10-0${waveNum}T07:01:00Z`;

    // Response A: competitor-only response (brand absent)
    const rA = addResponse({ runId, promptId: 1, createdAt: at });
    addMention(rA, 2, 'positive', 1);
    let ord = 0;
    if (waveNum <= 4) addCitation(rA, 'https://g2.com/best-notes', ord++);
    if (waveNum === 1 || waveNum === 3 || waveNum === 5) addCitation(rA, 'https://capterra.com/notes', ord++);
    if (waveNum <= 2) addCitation(rA, 'https://reddit.com/r/saas/thread', ord++);
    if (waveNum === 1) addCitation(rA, 'https://blog.example/ephemeral', ord++);
    if (waveNum <= 3) addCitation(rA, 'https://jotta.app/features', ord++);

    // Response B: brand present response
    const rB = addResponse({ runId, promptId: 2, createdAt: at });
    addMention(rB, 1, 'positive', 1);
    addMention(rB, 2, 'neutral', 2);
    let ordB = 0;
    if (waveNum <= 4) addCitation(rB, 'https://forbes.com/roundup', ordB++);
    if (waveNum <= 3) addCitation(rB, 'https://notewell.io/guide', ordB++);
  });

  const report = citationPersistenceReport(db);
  assert.equal(report.totalWaves, 5);
  assert.equal(report.summary.totalWaves, 5);

  const byUrl = new Map(report.urls.map((u) => [u.url, u]));
  assert.equal(byUrl.get('https://g2.com/best-notes')?.tier, 'durable');
  assert.equal(byUrl.get('https://g2.com/best-notes')?.persistenceRate, 0.8);
  assert.equal(byUrl.get('https://g2.com/best-notes')?.wavesSeen, 4);
  assert.equal(byUrl.get('https://g2.com/best-notes')?.competitorRecommendations, 4);
  assert.equal(byUrl.get('https://g2.com/best-notes')?.brandAbsentCount, 4);
  assert.equal(byUrl.get('https://g2.com/best-notes')?.firstSeenAt, '2026-10-01T07:01:00Z');
  assert.equal(byUrl.get('https://g2.com/best-notes')?.lastSeenAt, '2026-10-04T07:01:00Z');

  assert.equal(byUrl.get('https://capterra.com/notes')?.tier, 'durable');
  assert.equal(byUrl.get('https://capterra.com/notes')?.persistenceRate, 0.6);

  assert.equal(byUrl.get('https://reddit.com/r/saas/thread')?.tier, 'recurring');
  assert.equal(byUrl.get('https://reddit.com/r/saas/thread')?.persistenceRate, 0.4);

  assert.equal(byUrl.get('https://blog.example/ephemeral')?.tier, 'ephemeral');
  assert.equal(byUrl.get('https://blog.example/ephemeral')?.persistenceRate, 0.2);

  assert.equal(byUrl.get('https://forbes.com/roundup')?.tier, 'durable');
  assert.equal(byUrl.get('https://forbes.com/roundup')?.brandAbsentCount, 0);

  // Off-site targets exclude brand_owned, competitor_owned, and brand-present URLs,
  // and sort strictly: durable (0.8) > durable (0.6) > recurring (0.4) > ephemeral (0.2).
  assert.deepEqual(report.offSiteTargets.map((item) => item.url), [
    'https://g2.com/best-notes',
    'https://capterra.com/notes',
    'https://reddit.com/r/saas/thread',
    'https://blog.example/ephemeral',
  ]);

  // All 7 domains (including brand_owned and competitor_owned) appear in report.domains.
  assert.equal(report.domains.length, 7);
  assert.equal(report.domains.find((d) => d.domain === 'notewell.io')?.ownership, 'brand_owned');
  assert.equal(report.domains.find((d) => d.domain === 'jotta.app')?.ownership, 'competitor_owned');

  // Summary checks:
  // Durable URLs: g2, capterra, forbes, notewell.io, jotta.app = 5
  // Recurring URLs: reddit = 1; Ephemeral URLs: blog.example = 1 -> churn = 1/7
  // Citations: third-party = 4 + 3 + 2 + 1 + 4 = 14; brand = 3; competitor = 3; total = 20 -> offSiteShare = 14/20 = 0.7
  assert.equal(report.summary.durableCount, 5);
  assert.equal(report.summary.recurringCount, 1);
  assert.equal(report.summary.ephemeralCount, 1);
  assert.equal(report.summary.ephemeralChurnRate, 1 / 7);
  assert.equal(report.summary.totalCitations, 20);
  assert.equal(report.summary.offSiteShare, 0.7);
});

test('deriveOpportunityCandidates enriches source_without_brand with citationPersistence', (t) => {
  const { db, addRun, addResponse, addSource, addCitation, addMention } = createFixture(t);
  run(db, `INSERT INTO execution_profiles(id,surface,snapshot_json,created_at)
    VALUES('prof-1','openai-api','{}',?)`, [T0]);
  run(db, `INSERT INTO benchmark_revisions(id,snapshot_json,created_at)
    VALUES('bench-1',?,?)`, [JSON.stringify({
    questions: [{ id: 1, intentId: 1, text: 'Best AI meeting notes tool?', category: 'general' }],
    entities: [{ id: 1, role: 'brand', name: 'Notewell' }],
  }), T0]);

  const run1 = addRun({ startedAt: '2026-10-01T07:00:00Z' });
  const run2 = addRun({ startedAt: '2026-10-02T07:00:00Z' });
  for (const [idx, runId] of [run1, run2].entries()) {
    const rid = addResponse({
      runId, promptId: 1, createdAt: `2026-10-0${idx + 1}T10:00:00Z`,
      executionProfileId: 'prof-1', benchmarkRevisionId: 'bench-1',
    });
    addSource(rid, 'https://g2.com/categories/notes');
    addCitation(rid, 'https://g2.com/categories/notes', 0);
    addMention(rid, 2, 'positive');
  }

  const series = listMeasurementSeries(db, {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-05T00:00:00Z',
  })[0];
  assert.ok(series);
  const candidates = deriveOpportunityCandidates(db, { series, intentId: 1 });
  const target = candidates.find((c) => c.candidateType === 'source_without_brand');
  assert.ok(target);
  assert.equal(target.citationPersistence?.tier, 'durable');
  assert.equal(target.citationPersistence?.wavesSeen, 2);
  assert.equal(target.citationPersistence?.totalWaves, 2);
  assert.equal(target.citationPersistence?.persistenceRate, 1);
  assert.equal(target.citationPersistence?.competitorRecommendations, 2);
  assert.equal(target.citationPersistence?.brandAbsentCount, 2);
});

test('all 3 forensic analyzers handle an empty database gracefully without fabricating rates', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());

  const attrition = retrievalAttritionReport(db);
  assert.equal(attrition.n, 0);
  assert.equal(attrition.attritionRate.p, null);
  assert.equal(attrition.attritionRate.n, 0);
  assert.equal(attrition.hijacks.count, 0);
  assert.equal(attrition.hijacks.rate.p, null);
  assert.deepEqual(attrition.hijacks.receipts, []);
  assert.equal(attrition.limitations.length > 0, true);

  const delta = memoryVsRetrievalDelta(db);
  assert.equal(delta.brand, null);
  assert.deepEqual(delta.pairs, []);
  assert.equal(delta.summary.totalModels, 0);
  assert.equal(delta.limitations.length > 0, true);

  const persistence = citationPersistenceReport(db);
  assert.equal(persistence.totalWaves, 0);
  assert.deepEqual(persistence.waves, []);
  assert.deepEqual(persistence.domains, []);
  assert.deepEqual(persistence.urls, []);
  assert.deepEqual(persistence.offSiteTargets, []);
  assert.equal(persistence.summary.durableCount, 0);
  assert.equal(persistence.summary.ephemeralChurnRate, null);
  assert.equal(persistence.summary.offSiteShare, null);
  assert.equal(persistence.limitations.length > 0, true);
});

test('retrievalAttritionReport and citationPersistenceReport deduplicate UTM and tracking query params without collapsing semantic params', (t) => {
  const { db, addRun, addResponse, addSource, addCitation, addMention } = createFixture(t);
  const wave1 = addRun({ startedAt: '2026-10-01T07:00:00Z' });
  const wave2 = addRun({ startedAt: '2026-10-02T07:00:00Z' });

  // Wave 1: retrieves clean URL and a legacy-stored UTM normalized_url, cites OpenAI UTM twin + semantic query URL.
  const r1 = addResponse({ runId: wave1, promptId: 1, createdAt: '2026-10-01T10:00:00Z' });
  addSource(r1, 'https://openrouter.ai/');
  addSource(r1, 'https://docs.example.org/guide?page=2&utm_source=openai&fbclid=fb123');
  addSource(r1, 'https://docs.example.org/guide?page=1');
  addCitation(r1, 'https://openrouter.ai/?utm_source=openai', 0, null);
  addCitation(r1, 'https://docs.example.org/guide?page=2&gclid=gc456&utm_medium=referral', 1, null);
  addMention(r1, 2, 'positive');

  // Wave 2: cites clean openrouter URL (must merge with wave 1's ?utm_source=openai twin -> durable 2/2).
  const r2 = addResponse({ runId: wave2, promptId: 1, createdAt: '2026-10-02T10:00:00Z' });
  addSource(r2, 'https://openrouter.ai/?utm_source=chatgpt.com');
  addCitation(r2, 'https://openrouter.ai/', 0, null);
  addMention(r2, 2, 'positive');

  const attrition = retrievalAttritionReport(db);
  // r1 retrieved 3 distinct URLs (openrouter.ai/, guide?page=2, guide?page=1) and cited 2 of them (openrouter + page=2), dropping only page=1.
  // r2 retrieved 1 URL (openrouter.ai/) and cited it (0 dropped).
  assert.equal(attrition.totalUniqueRetrievedUrls, 3);
  assert.equal(attrition.totalUniqueCitedUrls, 2);
  assert.equal(attrition.totalUniqueDroppedUrls, 1);
  assert.equal(attrition.retrievedObservations, 4);
  assert.equal(attrition.citedFromRetrievedObservations, 3);
  assert.equal(attrition.droppedObservations, 1);
  assert.deepEqual(
    attrition.topDroppedThirdPartyUrls.map((u) => u.url),
    ['https://docs.example.org/guide?page=1'],
  );
  assert.equal(
    attrition.topDroppedThirdPartyUrls.some((u) => u.url.includes('openrouter.ai')),
    false,
  );
  assert.deepEqual(
    attrition.topCitedUrls.map((u) => [u.url, u.citedCount]),
    [
      ['https://openrouter.ai/', 2],
      ['https://docs.example.org/guide?page=2', 1],
    ],
  );

  const persistence = citationPersistenceReport(db);
  assert.equal(persistence.totalWaves, 2);
  assert.equal(persistence.summary.totalUniqueUrls, 2);
  const openrouter = persistence.urls.find((u) => u.url === 'https://openrouter.ai/');
  assert.ok(openrouter);
  assert.equal(openrouter.tier, 'durable');
  assert.equal(openrouter.wavesSeen, 2);
  assert.equal(openrouter.citationCount, 2);
  assert.equal(persistence.urls.some((u) => u.url.includes('utm_source')), false);
});
