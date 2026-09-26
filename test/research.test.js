import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { all, get, openDb, run } from '../core/db.js';
import { RESEARCH_MAX_BYTES, sampleEligibility, summarizeEvidence, validateEvidence, validateProject } from '../core/research-contract.js';
import { compareResearch, renderResearchReport } from '../core/research-report.js';
import { getResearch, importResearch, listResearch, proposeResearchAction, reviewResearchAction } from '../core/research-store.js';

const at = '2026-09-26T09:00:00Z';
const finished = '2026-09-26T09:00:10Z';

function bundle() {
  return {
    schemaVersion: 1, runId: 'run-1', createdAt: at, mode: 'exploratory',
    app: { id: 'tasknest', name: 'TaskNest', url: 'https://tasknest.example/', aliases: ['Task Nest'], audience: 'Small agencies', useCases: ['Client task planning'] },
    panel: {
      id: 'panel-1', createdAt: at, reviewedAt: at,
      questions: [{ id: 'q1', text: 'Which task planning tools work for a small agency?' }, { id: 'q2', text: 'Which project tools support client approvals?' }],
      competitors: [{ id: 'boardstack', name: 'BoardStack', url: 'https://boardstack.example/', aliases: [], relationship: 'direct', reason: 'Offers agency task boards', evidenceIds: ['discovery'] }],
    },
    execution: {
      id: 'execution-1', routes: [{ id: 'codex', provider: 'openai', profile: 'codex-isolated-v1', executable: '/usr/bin/codex' }],
      samples: 1, timeoutMs: 120000, idleTimeoutMs: 60000, maxOutputBytes: 1048576, envelope: 'subscription-search-v1', language: 'en', location: 'uncontrolled',
    },
    analysis: { id: 'analysis-1', method: 'hearsay-evidence-v1' },
    provenance: { producer: 'Fixture host', limitations: ['Synthetic captured events for testing; no provider call'] },
    evidence: [{ id: 'discovery', type: 'fetched_page', timestamp: at, origin: 'host_research', capture: 'host_reported', sampleId: null, data: { url: 'https://boardstack.example/', title: 'Agency task boards' } }],
    samples: [],
    recommendations: [{ id: 'action-1', title: 'Explain client approvals', evidenceIds: ['discovery'], hypothesis: 'Approval documentation may help buyers assess the product', proposedChange: 'Draft a client approval guide', effort: 'small', priority: 'high', repeatMeasurement: { questionIds: ['q2'], supports: 'More eligible recommendations cite approval documentation', rejects: 'No eligible recommendation cites the new documentation' }, draftPath: 'drafts/action-1/guide.md' }],
  };
}

function addSample(value, options = {}) {
  const id = options.id ?? `sample-${value.samples.length + 1}`;
  const sample = {
    id, questionId: 'q1', routeId: 'codex', host: 'codex-cli', provider: 'openai', model: 'fixture-model', profile: 'codex-isolated-v1',
    startedAt: at, finishedAt: finished, status: 'completed', sessionIsolation: true, brandContext: false,
    origin: 'supported_cli_measurement', capture: 'runner_captured', evidenceIds: [`${id}-answer`, `${id}-search`],
    mentions: [{ brandId: 'tasknest', answerId: `${id}-answer`, excerpt: 'I recommend TaskNest.', positive: true, position: 1, confidence: 'certain' }],
    usage: { inputTokens: null, outputTokens: null, durationMs: 10000, cost: null, remainingAllowance: null }, errorCode: null,
    ...options,
  };
  value.samples.push(sample);
  value.evidence.push(
    { id: `${id}-answer`, type: 'answer', timestamp: finished, origin: sample.origin, capture: sample.capture, sampleId: id, data: { text: 'I recommend TaskNest. BoardStack is another option.' } },
    { id: `${id}-search`, type: 'tool_outcome', timestamp: at, origin: sample.origin, capture: sample.capture, sampleId: id, data: { tool: 'search', status: 'completed' } },
  );
  return sample;
}

function database(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

test('standalone templates validate without requiring runtime metadata or measurements', () => {
  const project = validateProject(readFileSync(new URL('../skill/templates/project.json', import.meta.url), 'utf8'));
  const evidence = validateEvidence(readFileSync(new URL('../skill/templates/evidence.json', import.meta.url), 'utf8'));
  assert.deepEqual(project.selectedRoutes, []);
  assert.deepEqual(summarizeEvidence(evidence), []);
  assert.equal(evidence.mode, 'research_audit');
  assert.match(renderResearchReport(evidence), /Template only; no research performed/);
});

test('bundle boundary rejects versions, unknown fields, unsafe content, invalid URLs and oversized input', () => {
  const changes = [
    (value) => { value.schemaVersion = 99; },
    (value) => { value.unrecognized = true; },
    (value) => { value.createdAt = 'yesterday'; },
    (value) => { value.app.url = 'javascript:alert(1)'; },
    (value) => { value.app.url = 'https://user:password@example.com/'; },
    (value) => { value.provenance.apiKey = 'private'; },
    (value) => { value.provenance.limitations = ['Bearer abcdefghijklmnopqrstuvwxyz']; },
    (value) => { value.evidence[0].data.url = 'file:///etc/passwd'; },
  ];
  for (const change of changes) {
    const value = bundle(); change(value);
    assert.throws(() => validateEvidence(value), { code: 'invalid_bundle' });
  }
  assert.throws(() => validateEvidence('{'), { code: 'invalid_bundle' });
  assert.throws(() => validateEvidence(' '.repeat(RESEARCH_MAX_BYTES + 1)), /exceeds 8 MiB/);
});

test('evidence references, supporting excerpts and provenance must remain connected', () => {
  const changes = [
    (value) => { value.samples[0].evidenceIds.push('missing'); },
    (value) => { value.samples[0].questionId = 'missing'; },
    (value) => { value.samples[0].provider = 'another-provider'; },
    (value) => { value.evidence[1].sampleId = 'missing'; },
    (value) => { value.evidence[1].capture = 'host_reported'; },
    (value) => { value.samples[0].mentions[0].excerpt = 'This text was never answered'; },
    (value) => { value.samples[0].mentions[0].positive = false; },
    (value) => { value.recommendations[0].evidenceIds = []; },
    (value) => { value.recommendations[0].repeatMeasurement.questionIds = ['missing']; },
    (value) => { value.recommendations[0].draftPath = 'drafts/action-1/../../source.js'; },
    (value) => { value.panel.competitors[0].evidenceIds = ['missing']; },
    (value) => { value.evidence.push(structuredClone(value.evidence[0])); },
  ];
  for (const change of changes) {
    const value = bundle(); addSample(value); change(value);
    assert.throws(() => validateEvidence(value), { code: 'invalid_bundle' });
  }
});

test('independent eligibility excludes research context, contamination and unobserved search', () => {
  const cases = [
    [{ brandContext: true }, 'brand_context_present_or_unknown'],
    [{ brandContext: null }, 'brand_context_present_or_unknown'],
    [{ sessionIsolation: false }, 'session_not_isolated'],
    [{ sessionIsolation: null }, 'session_not_isolated'],
    [{ origin: 'host_research', capture: 'host_reported' }, 'research_context'],
    [{ status: 'partial' }, 'answer_not_completed'],
    [{ status: 'failed', errorCode: 'quota_exceeded' }, 'answer_not_completed'],
  ];
  for (const [options, reason] of cases) {
    const value = bundle(); const sample = addSample(value, options);
    validateEvidence(value);
    assert.equal(sampleEligibility(value, sample).eligible, false);
    assert.ok(sampleEligibility(value, sample).reasons.includes(reason));
  }
  for (const text of ['Should I use TaskNest?', 'What are alternatives to Task Nest?', 'Is BoardStack better?', 'Review tasknest.example']) {
    const value = bundle(); const sample = addSample(value); value.panel.questions[0].text = text;
    assert.ok(sampleEligibility(value, sample).reasons.includes('branded_question'));
  }
  const value = bundle(); const sample = addSample(value);
  value.evidence[2].data.status = 'started';
  assert.ok(sampleEligibility(value, sample).reasons.includes('completed_search_unavailable'));
  value.evidence[2].data.status = 'completed';
  value.evidence[1].data.text = ' ';
  assert.ok(sampleEligibility(value, sample).reasons.includes('answer_unavailable'));
});

test('failed and partial answers never count as absences, and unavailable metadata stays unknown', () => {
  const value = bundle();
  value.execution.samples = 4;
  addSample(value);
  addSample(value, { mentions: [], status: 'failed', errorCode: 'authentication_required' });
  addSample(value, { mentions: [], status: 'partial' });
  addSample(value, { mentions: [], status: 'skipped', startedAt: null, finishedAt: null });
  validateEvidence(value);
  assert.deepEqual(summarizeEvidence(value), [{
    route: 'codex', provider: 'openai', model: 'fixture-model', profile: 'codex-isolated-v1', capture: 'runner_captured', origin: 'supported_cli_measurement',
    planned: 8, unrecorded: 4, attempted: 3, completed: 1, failed: 1, partial: 1, skipped: 1, eligible: 1, mentioned: 1, recommended: 1,
  }]);
  const unknown = addSample(value, { model: null, questionId: 'q2' });
  validateEvidence(value);
  assert.equal(summarizeEvidence(value).length, 3);
  assert.equal(summarizeEvidence(value)[1].model, null);
  assert.equal(unknown.usage.cost, null);
  assert.equal(unknown.usage.remainingAllowance, null);
  assert.match(renderResearchReport(value), /\| 4 \| 3 \| 1 \| 1 \| 1 \| 1 \| 0 \| 1 \| 1\/1 \| 1\/1 \|/);
});

test('a failed second provider cannot invalidate or join the successful provider denominator', () => {
  const value = bundle();
  addSample(value);
  value.execution.routes.push({ id: 'claude', provider: 'anthropic', profile: 'claude-isolated-v1', executable: '/usr/bin/claude' });
  addSample(value, { routeId: 'claude', provider: 'anthropic', model: 'claude-fixture', profile: 'claude-isolated-v1', status: 'failed', mentions: [], errorCode: 'quota_exceeded' });
  addSample(value, { profile: 'codex-isolated-v2', routeId: 'codex-new' });
  value.execution.routes.push({ id: 'codex-new', provider: 'openai', profile: 'codex-isolated-v2', executable: '/usr/bin/codex' });
  validateEvidence(value);
  assert.deepEqual(summarizeEvidence(value).map(({ provider, profile, eligible, failed, recommended }) => ({ provider, profile, eligible, failed, recommended })), [
    { provider: 'openai', profile: 'codex-isolated-v1', eligible: 1, failed: 0, recommended: 1 },
    { provider: 'anthropic', profile: 'claude-isolated-v1', eligible: 0, failed: 1, recommended: 0 },
    { provider: 'openai', profile: 'codex-isolated-v2', eligible: 1, failed: 0, recommended: 1 },
  ]);
});

test('sources, queries, fetched pages and answer citations stay distinct in reports', () => {
  const value = bundle();
  const sample = addSample(value, { origin: 'isolated_host_trial', capture: 'host_reported' });
  value.evidence.push({ id: 'citation', type: 'final_citation', timestamp: finished, origin: sample.origin, capture: sample.capture, sampleId: sample.id, data: { url: 'https://tasknest.example/docs' } });
  value.evidence.push({ id: 'query', type: 'search_query', timestamp: at, origin: sample.origin, capture: sample.capture, sampleId: sample.id, data: { query: null } });
  sample.evidenceIds.push('citation', 'query');
  validateEvidence(value);
  assert.equal(sampleEligibility(value, sample).verification, 'host_reported');
  const report = renderResearchReport(value);
  assert.match(report, /final_citation/);
  assert.match(report, /search_query/);
  assert.match(report, /fetched_page/);
  assert.doesNotMatch(report, /returned_source/);
  assert.match(report, /Hypothesis: Approval documentation/);
  assert.match(report, /Supports: More eligible recommendations/);
  assert.match(report, /Rejects: No eligible recommendation/);
});

test('untrusted source URLs cannot add Markdown links to generated reports', () => {
  const value = bundle();
  value.evidence[0].data.url = 'https://example.com/) [injected](javascript:alert(1))';
  value.panel.competitors[0].url = 'https://example.com/) [competitor-injection](https://attacker.example/)';
  let validated;
  try {
    validated = validateEvidence(value);
  } catch (error) {
    assert.equal(error.code, 'invalid_bundle');
    return;
  }
  const report = renderResearchReport(validated);
  assert.ok(!report.includes('[injected](javascript:'), 'Source URL escaped into a separate Markdown link');
  assert.ok(!report.includes('[competitor-injection](https://attacker.example/)'), 'Competitor URL escaped into a separate Markdown link');
});

test('comparisons identify common questions and refuse incompatible model, profile, settings and analysis', () => {
  const baseline = bundle(); addSample(baseline); addSample(baseline, { questionId: 'q2' });
  const same = structuredClone(baseline); same.runId = 'run-2';
  assert.equal(compareResearch(baseline, same).kind, 'matching_revisions');
  assert.equal(compareResearch(baseline, same).eligible, true);
  const changed = structuredClone(same); changed.panel.id = 'panel-2'; changed.panel.questions[1].text = 'Which project tools work without a subscription?';
  const comparison = compareResearch(baseline, changed);
  assert.equal(comparison.kind, 'common_subset');
  assert.deepEqual(comparison.questionIds, ['q1']);
  assert.deepEqual(comparison.excludedQuestionIds, ['q2']);
  assert.equal(comparison.baseline[0].eligible, 1);
  for (const modify of [
    (value) => { value.samples.forEach((sample) => { sample.model = null; }); },
    (value) => { value.samples.forEach((sample) => { sample.model = 'different-model'; }); },
    (value) => { value.execution.id = 'execution-2'; value.execution.routes[0].profile = 'new-profile'; value.samples.forEach((sample) => { sample.profile = 'new-profile'; }); },
    (value) => { value.execution.timeoutMs = 60000; value.execution.id = 'execution-2'; },
    (value) => { value.analysis.id = 'analysis-2'; value.analysis.method = 'new-analysis'; },
    (value) => { value.app.id = 'another-app'; },
  ]) {
    const other = structuredClone(same); modify(other);
    assert.equal(compareResearch(baseline, other).eligible, false);
    assert.equal(compareResearch(baseline, other).kind, 'incompatible');
  }
});

test('imports are content-idempotent, preserve external provenance and leave native measurements untouched', (t) => {
  const db = database(t); const value = bundle(); addSample(value);
  const first = importResearch(db, value);
  assert.equal(first.imported, true);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  const second = importResearch(db, JSON.stringify(reordered));
  assert.equal(second.imported, false);
  assert.equal(second.id, first.id);
  assert.equal(second.contentHash, first.contentHash);
  const saved = getResearch(db, first.id);
  assert.equal(saved.provenance, 'external');
  assert.deepEqual(saved.bundle, value);
  assert.match(saved.report, /Neither is a native dashboard measurement/);
  assert.equal(listResearch(db, 'tasknest').length, 1);
  assert.equal(listResearch(db, 'another-app').length, 0);
  assert.equal(get(db, 'SELECT count(*) AS count FROM research_evidence').count, 3);
  assert.equal(get(db, 'SELECT count(*) AS count FROM responses').count, 0);
  assert.equal(get(db, 'SELECT count(*) AS count FROM runs').count, 0);
  assert.equal(get(db, 'SELECT count(*) AS count FROM search_events').count, 0);
});

test('conflicting runs and reused revision identifiers cannot overwrite imported evidence', (t) => {
  const db = database(t); const value = bundle(); addSample(value); const first = importResearch(db, value);
  const conflict = structuredClone(value); conflict.provenance.producer = 'Changed producer';
  assert.throws(() => importResearch(db, conflict), { code: 'import_conflict' });
  const revision = structuredClone(value); revision.runId = 'run-2'; revision.panel.questions[0].text = 'A changed question?';
  assert.throws(() => importResearch(db, revision), { code: 'revision_conflict' });
  assert.deepEqual(getResearch(db, first.id).bundle, value);
  assert.equal(listResearch(db).length, 1);
  assert.throws(() => run(db, "UPDATE research_runs SET report_markdown = 'replacement' WHERE id = ?", [first.id]), /immutable/);
  assert.throws(() => run(db, 'DELETE FROM research_evidence WHERE research_id = ?', [first.id]), /immutable/);
});

test('evidence insertion failure rolls back the run and earlier inserted observations', (t) => {
  const db = database(t); const value = bundle(); addSample(value);
  db.exec("CREATE TRIGGER reject_fixture_search BEFORE INSERT ON research_evidence WHEN NEW.kind = 'tool_outcome' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END;");
  assert.throws(() => importResearch(db, value), /fixture insert failure/);
  assert.deepEqual(all(db, 'SELECT id FROM research_runs'), []);
  assert.deepEqual(all(db, 'SELECT evidence_id FROM research_evidence'), []);
  db.exec('DROP TRIGGER reject_fixture_search');
  assert.equal(importResearch(db, value).imported, true);
});

test('recommendations remain proposals until a reasoned review accepts or dismisses them', (t) => {
  const db = database(t); const imported = importResearch(db, bundle());
  const action = proposeResearchAction(db, imported.id, 'action-1');
  assert.equal(action.status, 'proposed');
  assert.equal(proposeResearchAction(db, imported.id, 'action-1').id, action.id);
  assert.throws(() => reviewResearchAction(db, action.id, 'accepted', ''), { code: 'invalid_review' });
  assert.equal(reviewResearchAction(db, action.id, 'accepted', 'Evidence supports drafting this guide').status, 'accepted');
  assert.throws(() => reviewResearchAction(db, action.id, 'dismissed', 'Second decision'), { code: 'review_conflict' });
  assert.equal(get(db, 'SELECT count(*) AS count FROM responses').count, 0);
});


test('imports reject different app identities reusing the same history identifier', (t) => {
  const db = database(t);
  const original = bundle();
  importResearch(db, original);
  for (const change of [(value) => value.app.url = 'https://unrelated.example/', (value) => value.app.name = 'Unrelated Product']) {
    const next = structuredClone(original); next.runId = 'run-2'; change(next);
    assert.throws(() => importResearch(db, next), { code: 'app_identity_conflict' });
  }
  assert.equal(listResearch(db).length, 1);
});
