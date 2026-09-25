import test from 'node:test';
import assert from 'node:assert/strict';

import { all, get, openDb, run } from '../core/db.js';
import {
  approveDraft,
  assertReviewedSelection,
  createDraft,
  getDraft,
  reviewDraft,
  reviewTrackingPrompt,
  updateDraft,
  validateTrackingQuestion,
} from '../core/benchmark-draft.js';

const payload = {
  context: {
    audience: 'Operations teams',
    productJob: 'summarize meetings',
    desiredConversion: 'start a trial',
    languagePreference: 'English',
    marketContext: 'Germany',
    contextNotes: 'Asked during sales calls',
  },
  brand: { name: 'Notewell', aliases: ['Notewell AI'], domains: ['notewell.io'] },
  competitors: [],
  intents: [
    { label: 'Choose a meeting tool', category: 'general', paraphrases: [
      { text: 'Which meeting notes tool is best for operations teams?', sourceNote: 'Sales call 12', selected: true },
      { text: 'What is a good meeting notes tool?', sourceNote: 'Support ticket 4', selected: false },
    ] },
    { label: 'Consider Notewell', category: 'general', paraphrases: [
      { text: 'Is Notewell good for meeting notes?', sourceNote: 'Interview 8', selected: true },
    ] },
  ],
};

/** @param {ReturnType<typeof openDb>} db */
function selectedIds(db) {
  return all(db, 'SELECT id FROM prompts WHERE tracking_state = ? AND active = 1 ORDER BY id', ['tracking'])
    .map((row) => Number(row.id));
}

test('draft review approves selected questions atomically with private notes and a repeatable receipt', () => {
  const db = openDb(':memory:');
  try {
    const draft = createDraft(db, payload);
    assert.equal(draft?.revision, 1);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM prompts')?.n, 0);
    const review = reviewDraft(db, draft.id);
    assert.equal(review.selectedQuestionCount, 2);
    assert.deepEqual(review.validationErrors, []);
    assert.deepEqual(review.byCategory, { general: 1, branded: 1 });
    assert.deepEqual(review.retaggedBranded, ['Is Notewell good for meeting notes?']);

    const receipt = approveDraft(db, draft.id, 1, review.reviewHash);
    assert.deepEqual(receipt.created, { entities: 1, intents: 2, prompts: 2 });
    assert.equal(receipt.activeQuestionCount, 2);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM prompts')?.n, 2);
    assert.deepEqual(approveDraft(db, draft.id, 1, review.reviewHash), receipt);
    assertReviewedSelection(db, selectedIds(db));

    const note = get(db, 'SELECT source_note FROM prompts WHERE text LIKE ?', ['Which meeting%']);
    assert.equal(note?.source_note, 'Sales call 12');
    const snapshot = get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [receipt.benchmarkRevisionId]);
    assert.ok(snapshot);
    assert.equal(String(snapshot.snapshot_json).includes('Sales call 12'), false);
    assert.equal(String(snapshot.snapshot_json).includes('Operations teams'), false);
    assert.equal(String(snapshot.snapshot_json).includes('Germany'), false);
  } finally { db.close(); }
});

test('invalid questions and stale reviews leave entities, intents, and prompts untouched', () => {
  const db = openDb(':memory:');
  try {
    const draft = createDraft(db, { ...payload, intents: [{ label: 'Buy', category: 'general', paraphrases: [
      { text: 'Best tool for {audience}?', selected: true },
    ] }] });
    const invalid = reviewDraft(db, draft.id);
    assert.match(invalid.validationErrors[0].message, /placeholder/);
    assert.throws(() => approveDraft(db, draft.id, 1, invalid.reviewHash), /placeholder/);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM entities')?.n, 0);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM prompts')?.n, 0);

    const edited = updateDraft(db, draft.id, 1, payload);
    assert.equal(edited?.revision, 2);
    assert.throws(() => approveDraft(db, draft.id, 1, invalid.reviewHash), /Draft changed/);
    assert.throws(() => approveDraft(db, draft.id, 2, invalid.reviewHash), /Review changed/);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM prompts')?.n, 0);
    assert.equal(getDraft(db, draft.id)?.status, 'draft');
  } finally { db.close(); }
});

test('case and space equivalent questions are rejected before any approval writes', () => {
  const db = openDb(':memory:');
  try {
    const duplicate = structuredClone(payload);
    duplicate.intents[0].paraphrases[1] = {
      text: '  WHICH  MEETING NOTES TOOL IS BEST FOR OPERATIONS TEAMS?  ',
      sourceNote: 'Another interview', selected: true,
    };
    const draft = createDraft(db, duplicate);
    const review = reviewDraft(db, draft.id);
    assert.ok(review.validationErrors.some((item) => item.message === 'Duplicate question'));
    assert.throws(() => approveDraft(db, draft.id, 1, review.reviewHash), /Duplicate question/);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM entities')?.n, 0);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM prompts')?.n, 0);
  } finally { db.close(); }
});

test('question and entity edits invalidate exact review fingerprints while old snapshot remains', () => {
  const db = openDb(':memory:');
  try {
    const draft = createDraft(db, payload);
    const review = reviewDraft(db, draft.id);
    const receipt = approveDraft(db, draft.id, 1, review.reviewHash);
    const ids = selectedIds(db);
    const snapshotBefore = String(get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [receipt.benchmarkRevisionId])?.snapshot_json);
    run(db, 'UPDATE prompts SET text = ? WHERE id = ?', ['Which meeting notes app is best for operations teams?', ids[0]]);
    assert.throws(() => assertReviewedSelection(db, ids), /review the panel/);
    reviewTrackingPrompt(db, ids[0]);
    assertReviewedSelection(db, ids);
    run(db, 'UPDATE entities SET aliases = ? WHERE is_self = 1', [JSON.stringify(['Notewell AI', 'NW'])]);
    assert.throws(() => assertReviewedSelection(db, ids), /review the panel/);
    assert.equal(String(get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [receipt.benchmarkRevisionId])?.snapshot_json), snapshotBefore);
  } finally { db.close(); }
});

test('name-only entity drafts preserve existing aliases and domains', () => {
  const db = openDb(':memory:');
  try {
    const first = createDraft(db, payload);
    approveDraft(db, first.id, 1, reviewDraft(db, first.id).reviewHash);
    const next = createDraft(db, {
      ...payload,
      brand: { name: 'Notewell' },
      intents: [{ label: 'Evaluate support', category: 'general', paraphrases: [
        { text: 'What support do meeting notes tools offer?', selected: true },
      ] }],
    });
    approveDraft(db, next.id, 1, reviewDraft(db, next.id).reviewHash);
    const brand = get(db, 'SELECT aliases, domains FROM entities WHERE is_self = 1');
    assert.deepEqual(JSON.parse(String(brand?.aliases)), ['Notewell AI']);
    assert.deepEqual(JSON.parse(String(brand?.domains)), ['notewell.io']);
  } finally { db.close(); }
});

test('legacy approval timestamp without fingerprint is review-needed; approved draft edits make a new draft', () => {
  const db = openDb(':memory:');
  try {
    run(db, `INSERT INTO intents(label, created_at) VALUES(?, ?)`, ['Legacy question', '2026-01-01T00:00:00Z']);
    const id = run(db, `INSERT INTO prompts(intent_id,text,category,active,created_at,tracking_state,approved_at)
      VALUES(1, ?, 'general', 1, ?, 'tracking', ?)`, ['What tool should I use?', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']).lastInsertRowid;
    assert.throws(() => assertReviewedSelection(db, [id]), /review the panel/);
    reviewTrackingPrompt(db, id);
    assertReviewedSelection(db, [id]);

    const draft = createDraft(db, payload);
    const review = reviewDraft(db, draft.id);
    approveDraft(db, draft.id, 1, review.reviewHash);
    const next = updateDraft(db, draft.id, 1, { ...payload, context: { ...payload.context, audience: 'Founders' } });
    assert.notEqual(next?.id, draft.id);
    assert.equal(next?.status, 'draft');
    assert.equal(getDraft(db, draft.id)?.status, 'approved');
  } finally { db.close(); }
});

test('question validator rejects unresolved template tokens and keeps ordinary comparisons', () => {
  for (const placeholder of ['{audience}', '[category]', '<market>']) {
    assert.throws(() => validateTrackingQuestion(`Best tool for ${placeholder}?`), /placeholder/);
  }
  assert.equal(validateTrackingQuestion('Does Jotta compare well with other meeting tools?'),
    'Does Jotta compare well with other meeting tools?');
});
