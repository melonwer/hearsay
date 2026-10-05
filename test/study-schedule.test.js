import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { studyFixture, STUDY_TIME } from '../test-support/study-fixture.js';
import { agentRoute } from '../core/agent-routes.js';
import { previewResearchRun, runResearchPanel, writeJson, readJson } from '../core/research-workspace.js';
import { researchScheduleTick } from '../core/research-schedule.js';
import { researchHash } from '../core/research-contract.js';
import { createStudy, previewStudy, approveStudy, loadStudy, captureStudyPage, recordStudyVersion, recordStudyAnalysis, proposeStudyPlan, appendStudyRecord } from '../core/study-workspace.js';
import { deriveStudyReport } from '../core/study-report.js';
import { prepareStudyResearch, collectStudyOccurrence, collectStudyDiagnostic, studyScheduleTick, connectStudySchedule, stopStudyCollection } from '../core/study-schedule.js';

const started = new Date('2026-10-02T08:00:00Z');

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hearsay-study-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = await studyFixture(t, { tavily: { enabled: true, accountId: 'fixture-account', searchDepth: 'basic', maxResults: 5, collectionCredits: 180, diagnosticCredits: 20, allowance: 200, strictFreeMode: true } });
  const { plan, studyDirectory } = base;
  const capture = await captureStudyPage(studyDirectory, { html: '<h1>Outfit ratings from photos</h1>', content: 'Outfit ratings from photos', now: started });
  await recordStudyVersion(studyDirectory, { id: 'v1', pageId: capture.id, status: 'published', author: 'owner', publishedAt: started.toISOString() });
  const accountDirectory = join(root, 'account');
  let requests = 0;
  const fetch = async (url, options) => {
    if (String(url).endsWith('/usage')) return new Response(JSON.stringify({ key: { usage: requests, limit: 1000 }, account: { current_plan: 'free', plan_usage: requests, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }));
    requests++;
    const query = JSON.parse(options.body).query;
    return new Response(JSON.stringify({ query, results: [{ url: plan.targetUrl, title: 'Outfit scoring', content: 'Outfit ratings from photos', score: 0.9 }], request_id: `request-${requests}`, usage: { credits: 1 } }));
  };
  return { root, studyDirectory, accountDirectory, fetch, requestCount: () => requests, plan };
}

test('one reviewed baseline plus 29 daily repeats uses 180 credits and leaves analysis due', async (t) => {
  const f = await fixture(t);
  const options = { accountDirectory: f.accountDirectory, fetch: f.fetch, apiKey: 'fixture-key', now: started };
  await assert.rejects(collectStudyOccurrence(f.studyDirectory, options), /approv/i);
  assert.equal(f.requestCount(), 0);
  const preview = previewStudy(f.studyDirectory);
  await approveStudy(f.studyDirectory, preview.quoteId, { author: 'owner', now: started });
  const first = await collectStudyOccurrence(f.studyDirectory, options);
  assert.equal(first.status, 'completed');
  await collectStudyOccurrence(f.studyDirectory, options);
  assert.equal(f.requestCount(), 6);
  for (let day = 1; day < 30; day++) {
    const now = new Date(started.getTime() + day * 86400000 + 3600000);
    await studyScheduleTick(f.studyDirectory, { ...options, now });
  }
  assert.equal(f.requestCount(), 180);
  const saved = loadStudy(f.studyDirectory);
  assert.equal(saved.manifest.analysisDue.length, 30);
  assert.equal(saved.searchRuns.length, 30);
  const stopped = await studyScheduleTick(f.studyDirectory, { ...options, now: new Date('2026-11-01T09:00:00Z') });
  assert.equal(stopped.status, 'stopped');
  assert.equal(f.requestCount(), 180);
});

test('configured scheduling, connected receipt, missed occurrence and stopped collection are distinct', async (t) => {
  const f = await fixture(t);
  await approveStudy(f.studyDirectory, previewStudy(f.studyDirectory).quoteId, { author: 'owner', now: started });
  assert.equal(loadStudy(f.studyDirectory).manifest.schedule.connected, false);
  await connectStudySchedule(f.studyDirectory, { kind: 'host', receipt: { jobId: 'fixture-job', verifiedAt: started.toISOString() }, command: 'fixture daily task', now: started });
  assert.equal(loadStudy(f.studyDirectory).manifest.schedule.connected, true);
  const options = { accountDirectory: f.accountDirectory, fetch: f.fetch, apiKey: 'fixture-key' };
  await collectStudyOccurrence(f.studyDirectory, { ...options, now: started });
  await studyScheduleTick(f.studyDirectory, { ...options, now: new Date('2026-10-04T09:00:00Z') });
  assert.equal(f.requestCount(), 12);
  assert.ok(loadStudy(f.studyDirectory).manifest.schedule.missedOccurrenceIds.length);
  await stopStudyCollection(f.studyDirectory, 'Owner stopped collection');
  assert.equal((await studyScheduleTick(f.studyDirectory, { ...options, now: new Date('2026-10-05T09:00:00Z') })).status, 'stopped');
  assert.equal(f.requestCount(), 12);
});

test('a single study decision binds distinct account quotes and verified baseline before recurring trials', async (t) => {
  const f = await studyFixture(t);
  const route = agentRoute('codex-agent');
  f.project.executions[0] = { ...f.project.executions[0], routes: [{ id: route.id, provider: route.provider, profile: route.profile, executable: '/fixture/codex' }], timeoutMs: 1000, idleTimeoutMs: 1000, maxOutputBytes: 100000 };
  f.project.selectedRoutes = [route.id];
  writeJson(join(f.projectDirectory, 'project.json'), f.project);
  const capture = await captureStudyPage(f.directory, { html: '<h1>Outfit ratings from photos</h1>', now: started });
  await recordStudyVersion(f.directory, { id: 'v1', pageId: capture.id, status: 'published', author: 'owner', publishedAt: STUDY_TIME });
  const preview = await previewResearchRun(f.projectDirectory, { discover: async (routes) => routes.map((item) => ({ id: item.id, executable: item.executable, profile: item.profile, version: 'fixture 1', profileHash: 'fixture-profile' })) });
  const bound = await prepareStudyResearch(f.directory, { preview, now: started });
  const approval = await approveStudy(f.directory, bound.quoteId, { author: 'owner', now: started });
  let prompts = [];
  const options = { now: started, researchPreview: preview, runnerFactory: () => ({ preflight: async () => ({ authenticated: true, authKind: 'subscription' }), run: async (input) => {
    prompts.push(input);
    return { text: 'Drip Score is a good option for outfit photos.', searchEvents: [{ eventType: 'search', status: 'completed', query: input.promptText, results: [] }], sessionIsolation: true, brandContext: false, cliVersion: 'fixture 1', executionProfileHash: 'fixture-profile' };
  } }) };
  await assert.rejects(collectStudyOccurrence(f.directory, { ...options, scheduled: true }), /search-verified.*trial/i);
  assert.equal(prompts.length, 0);
  const baseline = await collectStudyOccurrence(f.directory, options);
  assert.equal(baseline.status, 'completed');
  assert.deepEqual(prompts.map((item) => item.promptText), f.plan.questions.map((item) => item.text));
  assert.ok(prompts.every((item) => !JSON.stringify(item).includes('Drip Score') && !JSON.stringify(item).includes('drip.example')));
  const consent = readJson(join(f.projectDirectory, 'consent.json'));
  assert.equal(consent.studyApprovalId, approval.id);
  await assert.rejects(runResearchPanel(f.projectDirectory, { execute: true, preview, runnerFactory: options.runnerFactory }), /study.*coordinator/i);
  const repeated = await collectStudyOccurrence(f.directory, { ...options, scheduled: true, now: new Date('2026-10-03T09:00:00Z') });
  assert.equal(repeated.status, 'completed');
  const recurring = readJson(join(f.projectDirectory, 'schedule.json'));
  assert.equal(recurring.studyApprovalId, approval.id);
  assert.notEqual(recurring.quoteId, consent.quoteId);
  assert.equal((await researchScheduleTick(f.projectDirectory, { now: new Date('2026-10-04T09:00:00Z'), preview, run: async () => { throw new Error('Must use the bounded study coordinator'); } })).status, 'study_managed');
  assert.equal(loadStudy(f.directory).approvals.length, 1);
  f.project.executions[0].samples = 2;
  writeJson(join(f.projectDirectory, 'project.json'), f.project);
  await assert.rejects(collectStudyOccurrence(f.directory, { ...options, scheduled: true, now: new Date('2026-10-04T09:00:00Z') }), /changed/i);
  assert.equal(prompts.length, 12);
});

test('interrupted claims keep analysis due and cannot send again while diagnostic searches remain separately bounded', async (t) => {
  const f = await fixture(t);
  const approval = await approveStudy(f.studyDirectory, previewStudy(f.studyDirectory).quoteId, { author: 'owner', now: started });
  const options = { accountDirectory: f.accountDirectory, fetch: f.fetch, apiKey: 'fixture-key', now: started };
  const occurrenceId = `collection-2026-10-02-${researchHash(approval.id).slice(0, 12)}`;
  await appendStudyRecord(f.studyDirectory, 'event', { id: 'interrupted-start', type: 'occurrence_claimed', occurrenceId, planId: f.plan.id,
    approvalId: approval.id, status: 'claimed', attemptedAt: started.toISOString(), evidenceIds: [], analysisDue: true });
  const result = await collectStudyOccurrence(f.studyDirectory, options);
  assert.equal(result.status, 'missed');
  assert.equal(f.requestCount(), 0);
  assert.deepEqual(loadStudy(f.studyDirectory).manifest.analysisDue, [occurrenceId]);
});

test('brand diagnostics preserve their evidence and cannot enter the neutral collection budget', async (t) => {
  const f = await fixture(t);
  await approveStudy(f.studyDirectory, previewStudy(f.studyDirectory).quoteId, { author: 'owner', now: started });
  const options = { accountDirectory: f.accountDirectory, fetch: f.fetch, apiKey: 'fixture-key', now: started,
    diagnosticId: 'freshness-1', queries: [{ id: 'diagnostic-1', angleId: 'outfit-scoring', text: 'Drip Score outfit scoring new page' }] };
  const result = await collectStudyDiagnostic(f.studyDirectory, options);
  assert.equal(result.creditSummary.collectionSpent, 0);
  assert.equal(result.creditSummary.diagnosticSpent, 1);
  await collectStudyDiagnostic(f.studyDirectory, options);
  assert.equal(f.requestCount(), 1);
  assert.equal(loadStudy(f.studyDirectory).searchRuns[0].lane, 'diagnostic');
  await collectStudyOccurrence(f.studyDirectory, { ...options, now: started });
  assert.equal(f.requestCount(), 7);
});

test('concurrent daily ticks converge on one saved occurrence and changed words require a new approval', async (t) => {
  const f = await fixture(t);
  await approveStudy(f.studyDirectory, previewStudy(f.studyDirectory).quoteId, { author: 'owner', now: started });
  const options = { accountDirectory: f.accountDirectory, fetch: f.fetch, apiKey: 'fixture-key', now: started };
  const results = await Promise.all([collectStudyOccurrence(f.studyDirectory, options), collectStudyOccurrence(f.studyDirectory, options)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(f.requestCount(), 6);
  const { proposeStudyPlan } = await import('../core/study-workspace.js');
  const next = structuredClone(f.plan); next.id = 'plan-2'; next.questions[0].text = 'Where can I get a detailed outfit rating from a photo?';
  await proposeStudyPlan(f.studyDirectory, next);
  await assert.rejects(collectStudyOccurrence(f.studyDirectory, { ...options, now: new Date('2026-10-03T09:00:00Z') }), /approv/i);
  assert.equal(f.requestCount(), 6);
});

test('same-day reapproval leaves the new collection due for its own analysis', async (t) => {
  const f = await fixture(t);
  await approveStudy(f.studyDirectory, previewStudy(f.studyDirectory).quoteId, { author: 'owner', now: started });
  const options = { accountDirectory: f.accountDirectory, fetch: f.fetch, apiKey: 'fixture-key', now: started };
  const first = await collectStudyOccurrence(f.studyDirectory, options);
  await recordStudyAnalysis(f.studyDirectory, { id: 'baseline-analysis', occurrenceIds: [first.occurrenceId], evidenceIds: first.evidenceIds,
    recommendation: 'Continue', reason: 'Baseline saved.', nextAction: 'Collect again.', author: 'agent' });
  await proposeStudyPlan(f.studyDirectory, { ...f.plan, id: 'plan-2', questions: f.plan.questions.map((q, i) => i === 0 ? { ...q, text: 'Which services rate clothing in photos?' } : q) });
  await approveStudy(f.studyDirectory, previewStudy(f.studyDirectory).quoteId, { author: 'owner', now: started });
  const second = await collectStudyOccurrence(f.studyDirectory, options);
  assert.notEqual(second.occurrenceId, first.occurrenceId);
  const saved = loadStudy(f.studyDirectory);
  assert.deepEqual(saved.manifest.analysisDue, [second.occurrenceId]);
  assert.equal(deriveStudyReport(saved).summary.analysisDue, 1);
  await collectStudyOccurrence(f.studyDirectory, options);
  assert.equal(f.requestCount(), 12);
});
