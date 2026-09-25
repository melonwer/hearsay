import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeResponse, STANCE_REVISION } from '../core/analyze.js';
import { get, openDb, run, transaction } from '../core/db.js';
import { answerReview, appendCorrection, reanalyzeStoredResponse, storeInterpretation } from '../core/interpretations.js';
import { recommendationRate, stanceRecommendationRate } from '../core/metrics.js';
import { exportAll } from '../web/queries.js';

const AT = '2026-09-25T10:00:00Z';
const ENTITY = [{ id: 1, name: 'Notewell', aliases: [], domains: [] }];

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-stance-'));
  const db = openDb(join(dir, 'hearsay.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  run(db, `INSERT INTO entities(id,name,aliases,domains,is_self,created_at)
    VALUES(1,'Notewell','[]','[]',1,?)`, [AT]);
  run(db, 'INSERT INTO intents(id,label,created_at) VALUES(1,?,?)', ['Which tool?', AT]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Which tool?','general',1,?)`, [AT]);
  run(db, `INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')`, [AT]);
  return db;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {number} id @param {string} text @param {string|null} revision */
function answer(db, id, text, revision = STANCE_REVISION) {
  const analysis = analyzeResponse(text, ENTITY);
  transaction(db, () => {
    run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
      surface,lane,target_status,comparability_status,comparison_key,analysis_revision,error)
      VALUES(?,1,1,'openai','fixture',?, ?, ?, 'openai-api','tracking','completed',
        'comparable','series-one',?,NULL)`, [id, id, text, AT, revision]);
    for (const mention of analysis.mentions) {
      const mentionId = run(db, `INSERT INTO mentions(response_id,entity_id,first_index,
        occurrences,rank,recommended,snippet) VALUES(?,?,?,?,?,?,?)`, [
        id, mention.entity_id, mention.first_index, mention.occurrences,
        mention.rank, mention.recommended, mention.snippet,
      ]).lastInsertRowid;
      if (revision !== null) storeInterpretation(db, mentionId, revision, mention, AT);
    }
  });
}

test('corrections preserve receipts, old cutoffs, and capture-time revision metrics', (t) => {
  const db = fixture(t);
  answer(db, 1, 'I recommend Notewell.');
  answer(db, 2, 'I do not recommend Notewell.');
  answer(db, 3, 'There are several tools to compare.');
  const before = answerReview(db, 2);
  assert.equal(before.mentions[0].originalStance, 'negative');
  assert.equal(before.mentions[0].ruleId, 'explicit_rejection');
  assert.equal(before.mentions[0].recommended, 0);
  assert.equal(before.mentions[0].evidenceStart, 0);
  const baseRate = stanceRecommendationRate(db, { surface: 'openai-api', comparisonKey: 'series-one',
    entityId: 1, analysisRevision: STANCE_REVISION, now: AT });
  assert.deepEqual([baseRate.n, baseRate.positive, baseRate.negative, baseRate.absent, baseRate.p],
    [3, 1, 1, 1, 1 / 3]);

  const corrected = appendCorrection(db, { responseId: 2, interpretationId: before.mentions[0].interpretationId,
    previousCorrectionId: null, replacement: 'positive', reason: 'Reviewed full answer',
    requestId: 'fixture-correction-1', at: AT });
  assert.equal(corrected.mentions[0].effectiveStance, 'positive');
  assert.equal(corrected.mentions[0].corrections[0].originalValue, 'negative');
  assert.equal(corrected.mentions[0].corrections[0].previousValue, 'negative');
  assert.equal(Number(get(db, 'SELECT recommended FROM mentions WHERE response_id = 2')?.recommended), 0);
  assert.equal(answerReview(db, 2, { cutoff: before.correctionCutoff }).mentions[0].effectiveStance, 'negative');
  assert.equal(appendCorrection(db, { responseId: 2, interpretationId: before.mentions[0].interpretationId,
    previousCorrectionId: null, replacement: 'positive', reason: 'Reviewed full answer',
    requestId: 'fixture-correction-1', at: AT }).correctionCutoff, corrected.correctionCutoff);
  assert.throws(() => appendCorrection(db, { responseId: 2,
    interpretationId: before.mentions[0].interpretationId, previousCorrectionId: null,
    replacement: 'neutral', reason: 'Stale', requestId: 'fixture-correction-2', at: AT }), /Stale correction/);

  const current = stanceRecommendationRate(db, { surface: 'openai-api', comparisonKey: 'series-one',
    entityId: 1, analysisRevision: STANCE_REVISION, now: AT });
  const historical = stanceRecommendationRate(db, { surface: 'openai-api', comparisonKey: 'series-one',
    entityId: 1, analysisRevision: STANCE_REVISION, correctionCutoff: before.correctionCutoff, now: AT });
  assert.deepEqual([current.positive, current.p, historical.positive, historical.p], [2, 2 / 3, 1, 1 / 3]);

  assert.equal(reanalyzeStoredResponse(db, 2, 'stance-en-v2', AT), 1);
  const revised = answerReview(db, 2, { revision: 'stance-en-v2' });
  assert.equal(revised.mentions[0].originalStance, 'negative');
  const revisedCorrection = appendCorrection(db, { responseId: 2,
    interpretationId: revised.mentions[0].interpretationId, previousCorrectionId: null,
    replacement: 'neutral', reason: 'Second model review', requestId: 'fixture-correction-v2', at: AT });
  assert.equal(revisedCorrection.revision, 'stance-en-v2');
  assert.equal(revisedCorrection.mentions[0].effectiveStance, 'neutral');
  assert.equal(answerReview(db, 2).mentions[0].effectiveStance, 'positive');
  assert.equal(answerReview(db, 2, { cutoff: before.correctionCutoff }).mentions[0].effectiveStance, 'negative');
  assert.equal(String(get(db, 'SELECT analysis_revision FROM responses WHERE id = 2')?.analysis_revision), STANCE_REVISION);
  const exported = exportAll(db);
  assert.equal(exported.exportFormatVersion, 8);
  assert.equal(exported.tables.mention_corrections.length, 2);
  assert.equal(exported.tables.mention_interpretations.length, 3);
});

test('legacy heuristic stays a disclosed boolean and never enters the new stance rate', (t) => {
  const db = fixture(t);
  answer(db, 1, 'I recommend Notewell.', null);
  const review = answerReview(db, 1);
  assert.equal(review.mentions[0].method, 'legacy_heuristic');
  assert.equal(review.mentions[0].originalStance, null);
  assert.equal(review.mentions[0].legacyRecommended, 1);
  assert.equal(recommendationRate(db, { entityId: 1, surface: 'openai-api', comparisonKey: 'series-one', now: AT }).recommended, 1);
  assert.equal(stanceRecommendationRate(db, { entityId: 1, surface: 'openai-api',
    comparisonKey: 'series-one', analysisRevision: STANCE_REVISION, now: AT }).n, 0);
});

test('reanalysis refuses a changed mention span and preserves the capture interpretation', (t) => {
  const db = fixture(t);
  answer(db, 1, 'Note AI is an option. I recommend Notewell.');
  run(db, "UPDATE entities SET aliases = '[\"Note AI\"]' WHERE id = 1");
  assert.throws(() => reanalyzeStoredResponse(db, 1, 'stance-en-v2', AT), /changed mention detection/);
  assert.equal(answerReview(db, 1).mentions[0].analysisRevision, STANCE_REVISION);
  assert.equal(Number(get(db, `SELECT COUNT(*) AS count FROM mention_interpretations
    WHERE analysis_revision = 'stance-en-v2'`)?.count), 0);
});
