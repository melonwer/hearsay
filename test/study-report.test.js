import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveStudyExposure, deriveStudyReport } from '../core/study-report.js';
import { normalizeStudyOutcome, parseStudyOutcomeCsv } from '../core/study-outcomes.js';

test('exposure requires distinguishing revision text and never claims indexing', () => {
  const versions = [{ id: 'v1', pageId: 'p1' }, { id: 'v2', pageId: 'p2', status: 'published' }];
  const pages = [{ id: 'p1', url: 'https://example.test/', content: 'Old promise' }, { id: 'p2', url: 'https://example.test/', content: 'New promise' }];
  const urlOnly = deriveStudyExposure({ url: 'https://example.test/', versions, pages, activeVersionId: 'v2' });
  assert.equal(urlOnly.status, 'url_only'); assert.equal(urlOnly.confirmsRevision, false); assert.equal(urlOnly.confirmsIndexing, false);
  const observed = deriveStudyExposure({ url: 'https://example.test/', content: 'New promise', versions, pages, activeVersionId: 'v2' });
  assert.equal(observed.status, 'active_revision_observed'); assert.equal(observed.confirmsRevision, true); assert.equal(observed.confirmsIndexing, false);
});

test('report keeps search requests and recommendation observations separate', () => {
  const report = deriveStudyReport({ version: 1, studyId: 's1', appId: 'a1', plan: { id: 'p1', app: { id: 'a1' }, angles: [{ id: 'angle-1', label: 'Outfit scoring' }], questions: [{ id: 'q1', angleId: 'angle-1' }], comparison: { design: 'unchanged_reference' }, collection: {} }, searchRuns: [{ records: [{ angleId: 'angle-1', status: 'completed' }, { angleId: 'angle-1', status: 'failed' }] }], researchRuns: [{ samples: [{ angleId: 'angle-1', recommended: true }] }], events: [], approvals: [], outcomes: [], analyses: [] });
  assert.equal(report.summary.searchRequests, 2); assert.equal(report.summary.recommendationObservations, 0); assert.match(report.markdown, /URL matches do not establish/);
});

test('business report marks missing denominators and distinguishes controlled assignment', () => {
  const base = { version: 1, studyId: 's1', appId: 'a1', plan: { app: { id: 'a1' }, targetUrl: 'https://example.test/', comparison: { design: 'controlled_allocation', referenceUrl: null }, outcome: { minimumDenominator: 10, minimumObservations: 1, minimumEffect: 0.01 }, angles: [], questions: [], collection: {} }, searchRuns: [], researchRuns: [], events: [], approvals: [], analyses: [] };
  const missing = deriveStudyReport({ ...base, outcomes: [{ source: 'crm', recordKey: 'b', pageUrl: 'https://example.test/', periodStart: '2026-01-01', periodEnd: '2026-01-02', metric: 'leads', value: 2, unit: 'count', denominator: null, phase: 'baseline' }, { source: 'crm', recordKey: 'a', pageUrl: 'https://example.test/', periodStart: '2026-01-02', periodEnd: '2026-01-03', metric: 'leads', value: 3, unit: 'count', denominator: null, phase: 'after' }] });
  assert.equal(missing.business[0].conclusion, 'inconclusive');
  const controlledPlan = { ...base.plan, comparison: { ...base.plan.comparison, assignment: { method: 'randomized' } } };
  const controlled = deriveStudyReport({ ...base, plan: controlledPlan, outcomes: [
    { source: 'crm', recordKey: 'b1', pageUrl: 'https://example.test/', periodStart: '2026-01-01', periodEnd: '2026-01-02', metric: 'leads', value: 2, unit: 'count', denominator: 20, changeId: 'change-1', assignment: 'randomized', cohort: 'treatment', phase: 'baseline' },
    { source: 'crm', recordKey: 'b2', pageUrl: 'https://example.test/', periodStart: '2026-01-01', periodEnd: '2026-01-02', metric: 'leads', value: 2, unit: 'count', denominator: 20, changeId: 'change-1', assignment: 'randomized', cohort: 'control', phase: 'baseline' },
    { source: 'crm', recordKey: 'a1', pageUrl: 'https://example.test/', periodStart: '2026-01-02', periodEnd: '2026-01-03', metric: 'leads', value: 4, unit: 'count', denominator: 20, changeId: 'change-1', assignment: 'randomized', cohort: 'treatment', phase: 'after' },
    { source: 'crm', recordKey: 'a2', pageUrl: 'https://example.test/', periodStart: '2026-01-02', periodEnd: '2026-01-03', metric: 'leads', value: 2, unit: 'count', denominator: 20, changeId: 'change-1', assignment: 'randomized', cohort: 'control', phase: 'after' },
  ] });
  assert.equal(controlled.business[0].conclusion, 'documented_controlled_comparison');
});

test('controlled reports require a real control cohort and preserve normalized rates', () => {
  const base = { version: 1, studyId: 's1', appId: 'a1', plan: { app: { id: 'a1' }, targetUrl: 'https://example.test/', comparison: { design: 'controlled_allocation', referenceUrl: null, assignment: { method: 'randomized' } }, outcome: { minimumDenominator: 1, minimumObservations: 1, reviewPeriodDays: 1, minimumEffect: 0.01 }, angles: [], questions: [], collection: {} }, searchRuns: [], researchRuns: [], events: [], approvals: [], analyses: [] };
  const row = (key, phase, value, denominator, cohort = null, assignment = 'randomized') => ({ source: 'analytics', recordKey: key, pageUrl: 'https://example.test/', periodStart: phase === 'baseline' ? '2026-01-01' : '2026-01-03', periodEnd: phase === 'baseline' ? '2026-01-02' : '2026-01-05', metric: 'conversion', value, unit: 'rate', denominator, changeId: 'change-1', phase, cohort, assignment });
  const missingControl = deriveStudyReport({ ...base, outcomes: [row('tb', 'baseline', 0.1, 100, 'treatment'), row('ta', 'after', 0.1, 200, 'treatment')] }).business[0];
  assert.equal(missingControl.conclusion, 'inconclusive');
  assert.ok(missingControl.inconclusiveReasons.includes('missing_control_cohort'));
  const valid = deriveStudyReport({ ...base, outcomes: [row('tb', 'baseline', 0.1, 100, 'treatment'), row('cb', 'baseline', 0.1, 100, 'control'), row('ta', 'after', 0.1, 200, 'treatment'), row('ca', 'after', 0.1, 200, 'control')] }).business[0];
  assert.equal(valid.baselineRate, 0.1);
  assert.equal(valid.afterRate, 0.1);
  assert.equal(valid.absoluteEffect, 0);
  assert.equal(valid.conclusion, 'below_minimum_effect');
});

test('revised question wording does not inherit old search presence', () => {
  const plan = { id: 'p2', app: { id: 'a1', url: 'https://example.test/' }, targetUrl: 'https://example.test/', angles: [{ id: 'a1', label: 'Angle' }], questions: [{ id: 'q1', angleId: 'a1', text: 'New neutral question?' }] };
  const report = deriveStudyReport({ plan, searchRuns: [{ lane: 'collection', records: [{ questionId: 'q1', angleId: 'a1', query: 'Old neutral question?', status: 'completed', results: [{ url: 'https://example.test/', title: 'Old', content: 'Old' }] }] }] });
  assert.deepEqual(report.angles[0].searchPresence, { found: 0, completed: 0, rate: null });
});

test('normalized rate outcomes use denominator-weighted averages', () => {
  const plan = { app: { id: 'a1' }, targetUrl: 'https://example.test/', comparison: { design: 'before_after', referenceUrl: null }, outcome: { minimumDenominator: 1, minimumObservations: 1, reviewPeriodDays: 1 }, angles: [], questions: [], collection: {} };
  const row = (recordKey, phase, denominator) => ({ source: 'analytics', recordKey, pageUrl: plan.targetUrl, periodStart: phase === 'baseline' ? '2026-01-01' : '2026-01-03', periodEnd: phase === 'baseline' ? '2026-01-02' : '2026-01-04', metric: 'conversion', value: 0.1, unit: 'rate', denominator, changeId: 'change-1', phase });
  const report = deriveStudyReport({ plan, outcomes: [row('b', 'baseline', 100), row('a', 'after', 200)] }).business[0];
  assert.equal(report.baselineRate, 0.1);
  assert.equal(report.afterRate, 0.1);
});

test('controlled reports reject mismatched arm windows, assignment, and per-arm sample', () => {
  const plan = { app: { id: 'a1' }, targetUrl: 'https://example.test/', comparison: { design: 'controlled_allocation', referenceUrl: null, assignment: { method: 'randomized' } }, outcome: { minimumDenominator: 1, minimumObservations: 2, reviewPeriodDays: 1, minimumEffect: 0.01 }, angles: [], questions: [], collection: {} };
  const outcomes = [['baseline', 'treatment', '2025-01-01', '2025-01-02', 1], ['baseline', 'control', '2026-01-01', '2026-01-02', 1], ['after', 'treatment', '2025-01-03', '2025-01-04', 5], ['after', 'control', '2026-01-03', '2026-01-04', 1]].map(([phase, cohort, start, end, value], index) => ({ source: 'crm', recordKey: String(index), pageUrl: plan.targetUrl, periodStart: start, periodEnd: end, metric: 'qualified_leads', unit: 'count', value, denominator: 20, changeId: 'c1', phase, cohort, assignment: 'first-time visitors choose treatment' }));
  const report = deriveStudyReport({ plan, outcomes }).business[0];
  assert.equal(report.comparable, false);
  assert.ok(report.inconclusiveReasons.includes('unmatched_windows'));
  assert.ok(report.inconclusiveReasons.includes('insufficient_sample'));
  assert.ok(report.inconclusiveReasons.includes('assignment_undocumented'));
});

test('unchanged reference requires matched target and reference windows', () => {
  const plan = { app: { id: 'a1' }, targetUrl: 'https://target.test/', comparison: { design: 'unchanged_reference', referenceUrl: 'https://ref.test/' }, outcome: { minimumDenominator: 1, minimumObservations: 1, reviewPeriodDays: 1 }, angles: [], questions: [], collection: {} };
  const row = (recordKey, pageUrl, phase, start, end) => ({ source: 'crm', recordKey, pageUrl, periodStart: start, periodEnd: end, metric: 'leads', value: 2, unit: 'count', denominator: 20, changeId: 'change-1', phase });
  const report = deriveStudyReport({ version: 1, studyId: 's1', appId: 'a1', plan, outcomes: [row('tb', plan.targetUrl, 'baseline', '2026-01-01', '2026-01-03'), row('ta', plan.targetUrl, 'after', '2026-01-03', '2026-01-05'), row('rb', 'https://ref.test/', 'baseline', '2026-01-01', '2026-01-02'), row('ra', 'https://ref.test/', 'after', '2026-01-03', '2026-01-05')], searchRuns: [], researchRuns: [], events: [], approvals: [], analyses: [] });
  assert.equal(report.business[0].conclusion, 'inconclusive'); assert.ok(report.business[0].inconclusiveReasons.includes('unmatched_windows'));
});

test('outcome normalization preserves absent denominators and CSV detects duplicates', () => {
  const item = normalizeStudyOutcome({ source: 'crm', recordKey: 'r1', pageUrl: 'https://example.test/', periodStart: '2026-01-01', periodEnd: '2026-01-02', metric: 'qualified leads', value: 4, unit: 'count', attributionMethod: 'owner supplied', phase: 'baseline' });
  assert.equal(item.denominator, null);
  assert.throws(() => normalizeStudyOutcome({ ...item, value: '' }), /value is required/);
  assert.throws(() => normalizeStudyOutcome({ ...item, value: 1.5, unit: 'count' }), /integer/);
  assert.throws(() => normalizeStudyOutcome({ ...item, periodStart: '2026-02-30' }), /calendar/);
  assert.throws(() => normalizeStudyOutcome({ ...item, pageUrl: 'file:///tmp/page' }), /HTTP/);
  const csv = 'recordKey,pageUrl,periodStart,periodEnd,metric,value,unit,currency,denominator,attributionMethod,trafficNotes,changeId,phase,cohort,assignment\n' + 'r1,https://example.test/,2026-01-01,2026-01-02,qualified leads,4,count,,,owner supplied,,c1,baseline,,\n';
  assert.equal(parseStudyOutcomeCsv(csv, { source: 'crm' })[0].recordKey, 'r1');
  assert.throws(() => parseStudyOutcomeCsv(csv + csv.split('\n')[1] + '\n', { source: 'crm' }), /duplicate/);
});

test('reports deduplicate pending analysis and render the assistant decision without inheriting obsolete scheduler state', () => {
  const snapshot = { manifest: { status: 'approved', schedule: { connected: false, stoppedReason: null } }, plan: { id: 'p2', app: { id: 'a1' }, collection: {}, angles: [], questions: [] },
    approvals: [{ id: 'a2', planId: 'p2' }], searchRuns: [], researchRuns: [], outcomes: [], versions: [],
    events: [{ type: 'schedule_connected', planId: 'p1', kind: 'host' }, { type: 'collection_stopped', planId: 'p1' },
      { type: 'occurrence_claimed', occurrenceId: 'day-1', analysisDue: true }, { type: 'occurrence_completed', occurrenceId: 'day-1', analysisDue: true }], analyses: [] };
  assert.equal(deriveStudyReport(snapshot).summary.analysisDue, 1);
  assert.equal(deriveStudyReport(snapshot).scheduling.status, 'configured_disconnected');
  snapshot.analyses = [{ id: 'analysis-1', occurrenceIds: ['day-1'], recommendation: 'Improve the photo upload explanation', reason: 'Buyer questions exposed missing instructions.', nextAction: 'Approve one copy change.', evidenceIds: ['page-1'] }];
  const report = deriveStudyReport(snapshot);
  assert.equal(report.summary.analysisDue, 0);
  assert.match(report.markdown, /Improve the photo upload explanation/);
  assert.match(report.markdown, /Approve one copy change/);
});

test('angle search presence counts only completed neutral searches and keeps paraphrases distinct', () => {
  const plan = { id: 'p1', app: { id: 'a1', url: 'https://drip.example/' }, targetUrl: 'https://drip.example/',
    angles: [{ id: 'a1', label: 'Outfit scoring' }], questions: [{ id: 'q1', angleId: 'a1', text: 'Which apps rate outfits?' }, { id: 'q2', angleId: 'a1', text: 'Where can I get outfit feedback?' }] };
  const row = (questionId, status, url) => ({ questionId, angleId: 'a1', query: plan.questions.find((q) => q.id === questionId).text, status, results: url ? [{ url }] : [] });
  const report = deriveStudyReport({ plan, searchRuns: [{ lane: 'collection', records: [row('q1', 'completed', 'https://drip.example/features'), row('q2', 'completed', 'https://other.example/'), row('q1', 'failed')] }, { lane: 'diagnostic', records: [row('q1', 'completed', 'https://drip.example/')] }] });
  assert.deepEqual(report.angles[0].searchPresence, { found: 1, completed: 2, rate: 0.5 });
  assert.equal(report.angles[0].questions[0].searchPresence.found, 1);
  assert.equal(report.angles[0].questions[0].searchPresence.completed, 1);
  assert.equal(report.angles[0].questions[1].searchPresence.found, 0);
  assert.match(report.markdown, /1\/2 completed searches found the website/);
});
