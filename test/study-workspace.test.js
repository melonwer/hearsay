import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { studyPlan, studyFixture, STUDY_TIME } from '../test-support/study-fixture.js';
import { validateStudyPlan, validateStudyRecord, studyHash } from '../core/study-contract.js';
import { approveStudy, appendStudyRecord, captureStudyPage, loadStudy, previewStudy, proposeStudyPlan, recordStudyAnalysis, recordStudyDecision, recordStudyVersion, withStudyLock } from '../core/study-workspace.js';

test('plans retain editable buyer angles and reject branded or mismatched questions', () => {
  assert.equal(validateStudyPlan(studyPlan()).questions.length, 6);
  for (const mutate of [
    (plan) => { plan.questions[0].text = 'Can Drip Score rate my outfit?'; },
    (plan) => { plan.questions[0].angleId = 'unknown'; },
    (plan) => { plan.angles[0].questionIds = ['q3']; },
    (plan) => { plan.tavily.collectionCredits = 179; },
    (plan) => { plan.studyId = '../escape'; },
    (plan) => { plan.collection.timezone = 'Invalid/Zone'; },
  ]) {
    const plan = studyPlan(); mutate(plan);
    assert.throws(() => validateStudyPlan(plan), { code: 'invalid_study' });
  }
});

test('credential fields and credential-like content never enter saved study records', () => {
  const plan = studyPlan(); plan.apiKey = 'hidden';
  assert.throws(() => validateStudyPlan(plan), { code: 'invalid_study' });
  assert.throws(() => validateStudyRecord('analysis', { version: 1, id: 'a1', studyId: 's1', appId: 'a1', author: 'agent', occurrenceIds: [], evidenceIds: [], recommendation: 'continue', reason: 'Bearer abcdefghijklmnop', nextAction: 'Wait' }), { code: 'invalid_study' });
});

test('each plan revision requires its exact quote and retains earlier approvals', async (t) => {
  const fixture = await studyFixture(t);
  const preview = previewStudy(fixture.directory);
  assert.equal(preview.estimate.tavily.collectionCredits, 180);
  await assert.rejects(approveStudy(fixture.directory, 'wrong', { author: 'owner', now: new Date(STUDY_TIME) }), { code: 'approval_required' });
  const approval = await approveStudy(fixture.directory, preview.quoteId, { author: 'owner', now: new Date(STUDY_TIME) });
  assert.equal(approval.planHash, studyHash(fixture.plan));
  assert.equal(loadStudy(fixture.directory).manifest.approvalId, approval.id);
  const revised = studyPlan({ id: 'plan-2', collection: { ...fixture.plan.collection, firstReviewDays: 2 } });
  await proposeStudyPlan(fixture.directory, revised);
  assert.equal(loadStudy(fixture.directory).manifest.approvalId, null);
  await assert.rejects(approveStudy(fixture.directory, preview.quoteId, { author: 'owner' }), { code: 'approval_required' });
  const second = await approveStudy(fixture.directory, previewStudy(fixture.directory).quoteId, { author: 'owner' });
  const saved = loadStudy(fixture.directory);
  assert.deepEqual(saved.plans.map((plan) => plan.id), ['plan-1', 'plan-2']);
  assert.equal(JSON.parse(readFileSync(join(fixture.directory, 'angles', 'plan-1.json'), 'utf8')).angles[0].id, 'outfit-scoring');
  assert.equal(JSON.parse(readFileSync(join(fixture.directory, 'angles', 'plan-2.json'), 'utf8')).id, 'plan-2');
  assert.equal(saved.approvals.length, 2);
  assert.equal(saved.manifest.approvalId, second.id);
  await assert.rejects(proposeStudyPlan(fixture.directory, { ...revised, outcome: { ...revised.outcome, metric: 'sales' } }), { code: 'immutable_record' });
});

test('captures preserve source hashes and content while new external page text remains pending', async (t) => {
  const fixture = await studyFixture(t);
  const html = '<html><body><h1>Outfit feedback</h1><script>dynamic()</script><p>Original photo score</p></body></html>';
  const first = await captureStudyPage(fixture.directory, { html, now: new Date(STUDY_TIME) });
  assert.equal(readFileSync(join(fixture.directory, first.originalPath), 'utf8'), html);
  assert.equal(first.originalSha256, createHash('sha256').update(html).digest('hex'));
  assert.equal(loadStudy(fixture.directory).pages[0].content, 'Outfit feedback Original photo score');
  const v1 = await recordStudyVersion(fixture.directory, { id: 'v1', pageId: first.id, status: 'captured', author: 'owner' });
  assert.equal(loadStudy(fixture.directory).manifest.activeVersionId, v1.id);
  const changed = await captureStudyPage(fixture.directory, { html: '<h1>Brand new clothing feedback</h1>' });
  const snapshot = loadStudy(fixture.directory);
  assert.deepEqual(snapshot.manifest.pendingPageIds, [changed.id]);
  assert.equal(snapshot.manifest.activeVersionId, v1.id);
  assert.equal(existsSync(join(fixture.directory, 'search-runs')), false);
  writeFileSync(join(fixture.directory, first.originalPath), 'tampered');
  assert.throws(() => loadStudy(fixture.directory), { code: 'capture_changed' });
});

test('an unreviewed later capture stays pending and cannot be published from a draft-only decision', async (t) => {
  const fixture = await studyFixture(t);
  const first = await captureStudyPage(fixture.directory, { html: '<p>Baseline</p>' });
  await recordStudyVersion(fixture.directory, { id: 'v1', pageId: first.id, status: 'captured', author: 'owner' });
  const second = await captureStudyPage(fixture.directory, { html: '<p>Unreviewed change</p>' });
  await recordStudyVersion(fixture.directory, { id: 'v2', pageId: second.id, status: 'captured', author: 'agent' });
  assert.equal(loadStudy(fixture.directory).manifest.activeVersionId, 'v1');
  assert.deepEqual(loadStudy(fixture.directory).manifest.pendingPageIds, [second.id]);
  await appendStudyRecord(fixture.directory, 'change', { id: 'draft-change', hypothesis: 'Draft copy.', evidenceIds: [second.id], status: 'proposed' });
  const draft = await recordStudyDecision(fixture.directory, { id: 'draft-decision', changeId: 'draft-change', action: 'approve', author: 'owner', reason: 'Draft only.', scope: { actions: ['draft'], repository: null, publishTarget: null } });
  await assert.rejects(recordStudyVersion(fixture.directory, { id: 'v3', pageId: second.id, changeId: 'draft-change', decisionId: draft.id, status: 'published', publishedAt: STUDY_TIME, author: 'agent' }), { code: 'approval_required' });
});

test('direct captures retain original HTTP response bytes before decoding derived text', async (t) => {
  const fixture = await studyFixture(t);
  const bytes = Buffer.concat([Buffer.from('<h1>Outfit feedback '), Buffer.from([0xff, 0xfe]), Buffer.from('</h1>')]);
  const receipt = await captureStudyPage(fixture.directory, { fetch: async () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  assert.deepEqual(readFileSync(join(fixture.directory, receipt.originalPath)), bytes);
  assert.equal(receipt.originalSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(receipt.sourceEncoding, 'bytes');
  assert.equal(receipt.contentEncoding, 'utf-8');
  assert.equal(loadStudy(fixture.directory).pages[0].content, 'Outfit feedback ��');
});

test('separately bounded page captures remain readable when their history exceeds 8 MiB', async (t) => {
  const fixture = await studyFixture(t);
  for (let index = 0; index < 3; index++) await captureStudyPage(fixture.directory, { content: String(index).repeat(3 * 1024 * 1024) });
  const saved = loadStudy(fixture.directory);
  assert.equal(saved.pages.length, 3);
  assert.equal(saved.pages[0].content.length, 3 * 1024 * 1024);
  await appendStudyRecord(fixture.directory, 'event', { id: 'large-history-note', type: 'note', note: 'History still works.' });
  assert.equal(loadStudy(fixture.directory).events[0].note, 'History still works.');
});

test('page versions and a reversion preserve history and link the owner decision', async (t) => {
  const fixture = await studyFixture(t, { permissions: { actions: ['capture', 'collect', 'draft', 'publish', 'revert'], repository: null, publishTarget: null } });
  const first = await captureStudyPage(fixture.directory, { html: '<p>Original outfit feedback</p>' });
  await recordStudyVersion(fixture.directory, { id: 'v1', pageId: first.id, status: 'captured', author: 'owner' });
  await appendStudyRecord(fixture.directory, 'change', { id: 'c1', hypothesis: 'Clearer feedback copy helps leads.', evidenceIds: [first.id], status: 'proposed' });
  const second = await captureStudyPage(fixture.directory, { html: '<p>New helpful outfit feedback</p>' });
  const decision = await recordStudyDecision(fixture.directory, { id: 'd1', pageId: second.id, changeId: 'c1', action: 'approve', author: 'owner', reason: 'Apply the clearer copy', scope: { actions: ['publish'], repository: null, publishTarget: null } });
  await recordStudyVersion(fixture.directory, { id: 'v2', pageId: second.id, changeId: 'c1', decisionId: decision.id, status: 'published', publishedAt: STUDY_TIME, author: 'owner' });
  const revert = await recordStudyDecision(fixture.directory, { id: 'd2', pageId: first.id, changeId: 'c1', action: 'revert', author: 'owner', reason: 'Revert the copy', scope: { actions: ['revert'], repository: null, publishTarget: null } });
  await recordStudyVersion(fixture.directory, { id: 'v3', pageId: first.id, changeId: 'c1', decisionId: revert.id, revertsVersionId: 'v2', status: 'reverted', author: 'owner' });
  const saved = loadStudy(fixture.directory);
  assert.equal(saved.manifest.activeVersionId, 'v3');
  assert.deepEqual(saved.versions.map((version) => version.pageId), [first.id, second.id, first.id]);
  assert.equal(saved.events.filter((event) => event.type === 'owner_decision').length, 2);
  assert.equal(saved.pages.length, 2);
});

test('a publish decision is bound to its exact captured page', async (t) => {
  const fixture = await studyFixture(t, { permissions: { actions: ['collect', 'publish'], repository: null, publishTarget: fixtureTarget() } });
  const first = await captureStudyPage(fixture.directory, { content: 'Baseline' });
  await recordStudyVersion(fixture.directory, { id: 'v1', pageId: first.id, author: 'owner' });
  await appendStudyRecord(fixture.directory, 'change', { id: 'c1', hypothesis: 'Approved copy', evidenceIds: [first.id], status: 'proposed' });
  const approvedPage = await captureStudyPage(fixture.directory, { content: 'Approved new copy' });
  const decision = await recordStudyDecision(fixture.directory, { id: 'd1', pageId: approvedPage.id, changeId: 'c1', action: 'approve', author: 'owner', reason: 'This exact copy', scope: { actions: ['publish'], repository: null, publishTarget: fixtureTarget() } });
  await recordStudyVersion(fixture.directory, { id: 'v2', pageId: approvedPage.id, changeId: 'c1', decisionId: decision.id, status: 'published', author: 'agent' });
  const unrelated = await captureStudyPage(fixture.directory, { content: 'Unapproved replacement', url: 'https://unrelated.example/' });
  await assert.rejects(recordStudyVersion(fixture.directory, { id: 'v3', pageId: unrelated.id, changeId: 'c1', decisionId: decision.id, status: 'published', author: 'agent' }), { code: 'approval_required' });
});

function fixtureTarget() { return 'https://drip.example/'; }

test('foreign records, unresolved references and unsafe paths fail without a write', async (t) => {
  const fixture = await studyFixture(t);
  await assert.rejects(appendStudyRecord(fixture.directory, 'change', { id: 'foreign', studyId: 'other', hypothesis: 'Test', evidenceIds: [], status: 'proposed' }), { code: 'study_mismatch' });
  await assert.rejects(recordStudyVersion(fixture.directory, { id: 'v1', pageId: 'missing', author: 'owner', status: 'captured' }), { code: 'invalid_study' });
  await assert.rejects(appendStudyRecord(fixture.directory, 'change', { id: 'c1', hypothesis: 'Test', evidenceIds: ['missing'], status: 'proposed', draftPath: '../outside.patch' }), { code: 'invalid_study' });
  symlinkSync(fixture.projectDirectory, join(fixture.directory, 'pages'));
  await assert.rejects(captureStudyPage(fixture.directory, { html: '<p>Test</p>' }), { code: 'unsafe_path' });
});

test('saved search receipts cannot silently substitute tracked questions or unsafe source URLs', async (t) => {
  const fixture = await studyFixture(t);
  const base = { id: 's1', planId: 'plan-1', status: 'completed', records: [{ id: 'result1', questionId: 'q1', angleId: 'outfit-scoring', query: fixture.plan.questions[0].text, status: 'completed', credits: 1, requestId: 'request1', results: [{ url: 'https://drip.example/', title: 'Outfit ratings', content: 'Outfit ratings', score: 0.9 }] }] };
  await appendStudyRecord(fixture.directory, 'search-run', base);
  for (const mutate of [
    (row) => { row.records[0].query = 'Can Drip Score score my outfit?'; },
    (row) => { row.records[0].questionId = 'q2'; },
    (row) => { row.records[0].results[0].url = 'file:///etc/passwd'; },
  ]) { const row = structuredClone(base); row.id = 's2'; mutate(row); await assert.rejects(appendStudyRecord(fixture.directory, 'search-run', row), { code: 'invalid_study' }); }
});

test('serialized concurrent appends are immutable and nested locking is reentrant', async (t) => {
  const fixture = await studyFixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => appendStudyRecord(fixture.directory, 'event', { id: `e${index}`, type: 'note', note: `Saved ${index}` })));
  await withStudyLock(fixture.directory, () => appendStudyRecord(fixture.directory, 'event', { id: 'nested', type: 'note', note: 'Saved in lock' }));
  assert.equal(loadStudy(fixture.directory).events.length, 13);
  await appendStudyRecord(fixture.directory, 'event', { id: 'nested', type: 'note', note: 'Saved in lock' });
  await assert.rejects(appendStudyRecord(fixture.directory, 'event', { id: 'nested', type: 'note', note: 'Overwrite' }), { code: 'immutable_record' });
  assert.equal(loadStudy(fixture.directory).manifest.recordIds.events.length, 13);
});

test('analysis clears only linked occurrences, including failed collection evidence', async (t) => {
  const fixture = await studyFixture(t);
  for (const occurrenceId of ['day-1', 'day-2']) await appendStudyRecord(fixture.directory, 'event', { id: `complete-${occurrenceId}`, type: 'occurrence_completed', occurrenceId, planId: 'plan-1', status: 'failed', attemptedAt: STUDY_TIME, finishedAt: STUDY_TIME, evidenceIds: [], analysisDue: true });
  assert.deepEqual(loadStudy(fixture.directory).manifest.analysisDue, ['day-1', 'day-2']);
  await recordStudyAnalysis(fixture.directory, { id: 'a1', occurrenceIds: ['day-1'], evidenceIds: ['complete-day-1'], recommendation: 'continue', reason: 'No search evidence was captured.', nextAction: 'Inspect route readiness.', author: 'agent' });
  assert.deepEqual(loadStudy(fixture.directory).manifest.analysisDue, ['day-2']);
  await assert.rejects(recordStudyAnalysis(fixture.directory, { id: 'a2', occurrenceIds: ['missing'], evidenceIds: [], recommendation: 'continue', reason: 'Test', nextAction: 'Wait', author: 'agent' }), { code: 'invalid_study' });
});

test('an interrupted occurrence leaves analysis due before collection can finish', async (t) => {
  const fixture = await studyFixture(t);
  await appendStudyRecord(fixture.directory, 'event', { id: 'claim', type: 'occurrence_claimed', occurrenceId: 'day-1', planId: 'plan-1', status: 'claimed', attemptedAt: STUDY_TIME, evidenceIds: [], analysisDue: true });
  assert.deepEqual(loadStudy(fixture.directory).manifest.analysisDue, ['day-1']);
});

test('owner approvals cannot exceed the saved action targets or authorize a different change', async (t) => {
  const fixture = await studyFixture(t);
  const capture = await captureStudyPage(fixture.directory, { html: '<p>Baseline</p>' });
  await recordStudyVersion(fixture.directory, { id: 'v1', pageId: capture.id, status: 'captured', author: 'owner' });
  await appendStudyRecord(fixture.directory, 'change', { id: 'c1', hypothesis: 'Test', evidenceIds: [capture.id], status: 'proposed' });
  await assert.rejects(recordStudyDecision(fixture.directory, { id: 'bad', changeId: 'c1', action: 'approve', author: 'owner', reason: 'Publish', scope: { actions: ['publish'], repository: null, publishTarget: 'https://elsewhere.example/' } }), { code: 'invalid_study' });
  const changed = await captureStudyPage(fixture.directory, { html: '<p>Changed copy</p>' });
  await assert.rejects(recordStudyVersion(fixture.directory, { id: 'v2', pageId: changed.id, status: 'published', author: 'agent' }), { code: 'approval_required' });
  assert.throws(() => validateStudyRecord('event', { version: 1, id: 'forged', studyId: 'outfit-study', appId: 'drip-score', type: 'owner_decision', action: 'approve', author: 'agent', reason: 'Publish' }), { code: 'invalid_study' });
});

test('approving a revised plan can restart collection without erasing the earlier stop', async (t) => {
  const fixture = await studyFixture(t);
  await appendStudyRecord(fixture.directory, 'event', { id: 'stop', type: 'collection_stopped', reason: 'Reached the old allowance' });
  await proposeStudyPlan(fixture.directory, studyPlan({ id: 'plan-2' }));
  await approveStudy(fixture.directory, previewStudy(fixture.directory).quoteId, { author: 'owner' });
  assert.equal(loadStudy(fixture.directory).manifest.status, 'approved');
  assert.equal(loadStudy(fixture.directory).events[0].reason, 'Reached the old allowance');
});

test('changes can cite preserved project discovery sources', async (t) => {
  const fixture = await studyFixture(t);
  await appendStudyRecord(fixture.directory, 'change', { id: 'source-change', hypothesis: 'Clarify the product description.', evidenceIds: ['product-evidence'], status: 'proposed' });
  assert.deepEqual(loadStudy(fixture.directory).changes[0].evidenceIds, ['product-evidence']);
});

test('load recovers an appended event even if the mutable manifest was stale', async (t) => {
  const fixture = await studyFixture(t);
  const file = join(fixture.directory, 'study.json');
  const stale = readFileSync(file, 'utf8');
  await appendStudyRecord(fixture.directory, 'event', { id: 'stopped', type: 'collection_stopped', reason: 'Owner requested stop' });
  writeFileSync(file, stale);
  assert.equal(loadStudy(fixture.directory).manifest.status, 'stopped');
  assert.equal(loadStudy(fixture.directory).manifest.schedule.stoppedReason, 'Owner requested stop');
});

test('a completed review saves JSON and markdown together without replacing earlier reports', async (t) => {
  const fixture = await studyFixture(t);
  const review = { id: 'r1', summary: 'Exposure is pending.', evidenceIds: [], markdown: '# Saved review\n\nContinue observing.\n' };
  await appendStudyRecord(fixture.directory, 'review', review);
  assert.equal(readFileSync(join(fixture.directory, 'reviews', 'r1', 'report.md'), 'utf8'), review.markdown);
  assert.equal(loadStudy(fixture.directory).reviews[0].summary, review.summary);
  await assert.rejects(appendStudyRecord(fixture.directory, 'review', { ...review, summary: 'Changed' }), { code: 'immutable_record' });
});
