import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, sampleEligibility, summarizeEvidence } from '../core/research-contract.js';
import { compareResearch, renderResearchReport } from '../core/research-report.js';

const time = '2026-09-26T10:00:00Z';

function bundle() {
  return {
    schemaVersion: 1, runId: 'fixture', createdAt: time, mode: 'exploratory',
    app: { id: 'acme', name: 'Acme', url: 'https://acme.example/', aliases: [], audience: 'Small organizations', useCases: ['Send newsletters'] },
    panel: { id: 'panel-1', createdAt: time, reviewedAt: null,
      questions: [{ id: 'q1', text: 'Which tools can send a monthly newsletter?' }], competitors: [] },
    execution: { id: 'execution-1', routes: [{ id: 'route-1', provider: 'provider-a', profile: 'web-v1', executable: '/tools/provider-a' }],
      samples: 1, timeoutMs: 120000, idleTimeoutMs: 30000, maxOutputBytes: 2097152, envelope: 'neutral-web-v1', language: 'English', location: 'uncontrolled' },
    analysis: { id: 'analysis-1', method: 'annotate-v1' },
    provenance: { producer: 'synthetic-test-fixture', limitations: ['No provider call occurred.'] },
    evidence: [
      { id: 'answer-1', type: 'answer', timestamp: time, origin: 'isolated_host_trial', capture: 'host_reported', sampleId: 'sample-1', data: { text: 'Consider Acme.' } },
      { id: 'search-1', type: 'tool_outcome', timestamp: time, origin: 'isolated_host_trial', capture: 'host_reported', sampleId: 'sample-1', data: { tool: 'search', status: 'completed' } },
    ],
    samples: [{ id: 'sample-1', questionId: 'q1', routeId: 'route-1', host: 'fixture-host', provider: 'provider-a', model: 'observed-model-a', profile: 'web-v1',
      startedAt: time, finishedAt: time, status: 'completed', sessionIsolation: true, brandContext: false, origin: 'isolated_host_trial', capture: 'host_reported',
      evidenceIds: ['answer-1', 'search-1'], mentions: [{ brandId: 'acme', answerId: 'answer-1', excerpt: 'Consider Acme.', positive: true, position: null, confidence: 'certain' }],
      usage: { inputTokens: null, outputTokens: null, durationMs: null, cost: null, remainingAllowance: null }, errorCode: null }],
    recommendations: [],
  };
}

function sum(groups, field) {
  return groups.reduce((total, group) => total + group[field], 0);
}

test('a completed answer with a quota error is not accepted as a completed trial', () => {
  const value = bundle();
  value.samples[0].errorCode = 'quota_exhausted';
  assert.throws(() => validateEvidence(value), { code: 'invalid_bundle' });
});

test('a run cannot claim more trials than its saved execution planned', () => {
  const value = bundle();
  const sample = structuredClone(value.samples[0]);
  sample.id = 'sample-2';
  sample.evidenceIds = ['answer-2', 'search-2'];
  sample.mentions[0].answerId = 'answer-2';
  value.samples.push(sample);
  value.evidence.push(...value.evidence.map((record) => ({
    ...record, id: record.id.replace('-1', '-2'), sampleId: 'sample-2',
  })));
  assert.throws(() => validateEvidence(value), { code: 'invalid_bundle' });
});

test('planned totals retain unrecorded questions without counting them as absences', () => {
  const value = bundle();
  value.panel.questions.push(...Array.from({ length: 5 }, (_, index) => ({
    id: `q${index + 2}`, text: `Which newsletter software meets requirement ${index + 2}?`,
  })));
  const groups = summarizeEvidence(validateEvidence(value));
  assert.equal(sum(groups, 'planned'), 6);
  assert.equal(sum(groups, 'attempted'), 1);
  assert.equal(sum(groups, 'completed'), 1);
  assert.equal(sum(groups, 'eligible'), 1);
  assert.equal(sum(groups, 'recommended'), 1);
});

test('changing app annotation names or aliases makes the comparison incompatible', () => {
  const before = bundle();
  const after = bundle();
  after.app.name = 'Other app';
  after.app.aliases = ['other'];
  const result = compareResearch(validateEvidence(before), validateEvidence(after));
  assert.equal(result.eligible, false);
  assert.equal(result.kind, 'incompatible');
});

test('partial answers never become absences or compatible measurements', () => {
  const before = bundle();
  const after = bundle();
  after.samples[0].status = 'partial';
  after.samples[0].errorCode = 'output_limit';
  const validated = validateEvidence(after);
  assert.equal(sampleEligibility(validated, validated.samples[0]).eligible, false);
  assert.equal(sum(summarizeEvidence(validated), 'eligible'), 0);
  assert.equal(compareResearch(validateEvidence(before), validated).eligible, false);
});

test('model and route executable changes prevent comparison', () => {
  for (const change of [
    (value) => { value.samples[0].model = 'observed-model-b'; },
    (value) => { value.samples[0].model = null; },
    (value) => { value.execution.routes[0].executable = '/tools/provider-b'; },
  ]) {
    const before = bundle();
    const after = bundle();
    change(after);
    assert.equal(compareResearch(validateEvidence(before), validateEvidence(after)).eligible, false);
  }
});

test('changed questions and profiles do not enter the common subset', () => {
  for (const change of [
    (value) => { value.panel.questions[0].text = 'Which tools support a weekly newsletter?'; },
    (value) => { value.samples[0].profile = 'web-v2'; value.execution.routes[0].profile = 'web-v2'; },
  ]) {
    const before = bundle();
    const after = bundle();
    change(after);
    assert.equal(compareResearch(validateEvidence(before), validateEvidence(after)).eligible, false);
  }
});

test('an imported runtime capture claim remains external provenance', () => {
  const value = bundle();
  value.provenance.producer = 'hearsay-runtime';
  value.samples[0].origin = 'supported_cli_measurement';
  value.samples[0].capture = 'runner_captured';
  for (const record of value.evidence) {
    record.origin = 'supported_cli_measurement';
    record.capture = 'runner_captured';
  }
  const validated = validateEvidence(value);
  assert.equal(sampleEligibility(validated, validated.samples[0]).verification, 'external_runner_capture');
  assert.match(renderResearchReport(validated), /Neither is a native dashboard measurement/);
});


test('excluded questions do not become unrecorded slots in a common-subset comparison', () => {
  const before = bundle();
  before.panel.questions.push({ id: 'q2', text: 'Which tools can send a weekly newsletter?' });
  const second = structuredClone(before.samples[0]);
  second.id = 'sample-2';
  second.questionId = 'q2';
  second.evidenceIds = ['answer-2', 'search-2'];
  second.mentions[0].answerId = 'answer-2';
  before.samples.push(second);
  before.evidence.push(...before.evidence.map((record) => ({
    ...record, id: record.id.replace('-1', '-2'), sampleId: 'sample-2',
  })));
  const after = structuredClone(before);
  after.panel.id = 'panel-2';
  after.panel.questions[1].text = 'Which tools can send a daily newsletter?';
  const result = compareResearch(validateEvidence(before), validateEvidence(after));
  assert.equal(result.eligible, true);
  assert.equal(result.kind, 'common_subset');
  assert.deepEqual(result.questionIds, ['q1']);
  assert.equal(sum(result.baseline, 'planned'), 1);
  assert.equal(sum(result.run, 'planned'), 1);
  assert.equal(result.baseline.some((group) => group.unrecorded > 0), false);
  assert.equal(result.run.some((group) => group.unrecorded > 0), false);
});
