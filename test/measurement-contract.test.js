import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertRoutePolicy,
  assessObservation,
  benchmarkRevision,
  comparisonSelection,
  evidenceCounts,
  executionProfile,
  normalizeObservedQuery,
  sourceGroupingUrl,
} from '../core/measurement-contract.js';

/** @param {'started'|'completed'|'failed'} status @param {string[]} [queries] */
function search(status, queries = []) {
  return {
    id: 'search-1', kind: /** @type {const} */ ('search'), status,
    queryMetadata: /** @type {const} */ (queries.length > 0 ? 'available' : 'unavailable'),
    queries, observedAt: null, providerType: 'fixture',
  };
}

test('baseline routes reject search policies that their adapters do not implement', () => {
  assert.doesNotThrow(() => assertRoutePolicy('openai-chat-completions-v1', 'openai-api', 'off'));
  assert.throws(() => assertRoutePolicy('openai-chat-completions-v1', 'openai-api', 'required'), /Unsupported search policy/);
  assert.throws(() => assertRoutePolicy('perplexity-sonar-v1', 'perplexity-api', 'off'), /Unsupported search policy/);
  assert.throws(() => assertRoutePolicy('codex-search-v1', 'openai-api', 'required'), /Unsupported search policy/);
});

test('profile identity includes answer settings but excludes credentials and object key order', () => {
  const base = {
    surface: 'openai-api', route: 'openai-chat-completions-v1', model: 'fixture-model',
    searchPolicy: /** @type {const} */ ('off'),
    requestSettings: { maxOutputTokens: 100, nested: { temperature: 0.4, apiKey: 'secret-one' } },
    limits: { maxElapsedMs: 1000, authToken: 'secret-two' },
  };
  const first = executionProfile(base);
  const reordered = executionProfile({
    ...base,
    requestSettings: { nested: { apiKey: 'different-secret', temperature: 0.4 }, maxOutputTokens: 100 },
    limits: { authToken: 'different-secret', maxElapsedMs: 1000 },
  });
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(first.id, reordered.id);
  assert.equal(first.snapshot.locationControl, 'uncontrolled');
  assert.equal(first.snapshot.languageControl, 'uncontrolled');
  assert.deepEqual(first.snapshot.requestSettings, { maxOutputTokens: 100, nested: { temperature: 0.4 } });
  assert.deepEqual(first.snapshot.limits, { maxElapsedMs: 1000 });
  assert.notEqual(first.id, executionProfile({ ...base, model: 'another-model' }).id);
  assert.notEqual(first.id, executionProfile({ ...base, limits: { maxElapsedMs: 2000 } }).id);
  assert.throws(() => executionProfile({ ...base, limits: { maxElapsedMs: Infinity } }), /finite/);
});

test('benchmark and analysis edits change an exact series without editing old snapshots', () => {
  const input = {
    questions: [{ id: 1, intentId: 7, category: 'discovery', text: 'Which tool handles audits?' }],
    entities: [{ id: 2, role: /** @type {const} */ ('brand'), name: 'Acme', aliases: ['Acme Pro'], domains: ['acme.example'] }],
    weighting: /** @type {const} */ ('equal'), scope: 'main',
  };
  const first = benchmarkRevision(input);
  const same = benchmarkRevision({ scope: 'main', weighting: 'equal', entities: input.entities, questions: input.questions });
  assert.equal(first.id, same.id);
  input.entities[0].aliases.push('Acme Enterprise');
  const changed = benchmarkRevision(input);
  assert.notEqual(first.id, changed.id);
  assert.deepEqual(first.snapshot.entities[0].aliases, ['Acme Pro']);

  const selection = comparisonSelection({
    executionProfileId: 'profile-a', benchmarkRevisionId: first.id, analysisRevision: 'rules-v1',
    start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z',
  });
  assert.equal(selection.start, '2026-09-01T00:00:00Z');
  assert.equal(selection.id, comparisonSelection(selection).id);
  assert.notEqual(selection.id, comparisonSelection({
    ...selection, analysisRevision: 'rules-v2',
  }).id);
  assert.notEqual(selection.id, comparisonSelection({
    ...selection, benchmarkRevisionId: changed.id,
  }).id);
  assert.throws(() => comparisonSelection({ ...selection, end: selection.start }), /ordered half-open UTC window/);
});

test('auto distinguishes a confirmed no-search answer from missing tool metadata', () => {
  assert.deepEqual(assessObservation({
    policy: 'auto', answerStatus: 'complete', actions: [], noSearchConfirmed: true,
  }), { searchState: 'not_used', evidenceCompleteness: 'complete', comparable: true, exclusion: null });
  assert.deepEqual(assessObservation({
    policy: 'auto', answerStatus: 'complete', actions: [],
  }), { searchState: 'unverified', evidenceCompleteness: 'unavailable', comparable: true, exclusion: null });
});

test('verified search with hidden queries keeps sources distinct from answer citations', () => {
  const actions = [search('completed')];
  assert.deepEqual(assessObservation({ policy: 'required', answerStatus: 'complete', actions }), {
    searchState: 'verified', evidenceCompleteness: 'complete', comparable: true, exclusion: null,
  });
  assert.deepEqual(evidenceCounts({
    actions,
    sources: [
      { url: 'https://competitor.example', title: null, provenance: 'reported_source', actionId: 'search-1', order: 1 },
      { url: 'https://other.example', title: null, provenance: 'reported_source', actionId: 'search-1', order: 2 },
    ],
    citations: [{ url: 'https://cited.example', provenance: 'native_annotation', sourceId: null, start: 0, end: 5 }],
  }), {
    searchActions: 1, queryOccurrences: 0, sourceObservations: 2, answerCitations: 1,
    queryMetadata: 'unavailable',
  });
});

test('failed or unfinished search is retained but excluded from comparable answers', () => {
  assert.deepEqual(assessObservation({
    policy: 'required', answerStatus: 'complete', actions: [search('completed'), search('failed')],
  }), { searchState: 'verified', evidenceCompleteness: 'partial', comparable: false, exclusion: 'required_search_partial' });
  assert.deepEqual(assessObservation({
    policy: 'required', answerStatus: 'complete', actions: [search('started')],
  }), { searchState: 'unverified', evidenceCompleteness: 'partial', comparable: false, exclusion: 'required_search_unverified' });
  assert.deepEqual(assessObservation({
    policy: 'auto', answerStatus: 'complete', actions: [search('failed')],
  }), { searchState: 'failed', evidenceCompleteness: 'partial', comparable: false, exclusion: 'search_execution_partial' });
  assert.deepEqual(assessObservation({
    policy: 'off', answerStatus: 'complete', actions: [search('completed')],
  }), { searchState: 'not_applicable', evidenceCompleteness: 'complete', comparable: false, exclusion: 'off_policy_search_observed' });
});

test('observed query grouping preserves case and punctuation; URLs retain query parameters', () => {
  assert.equal(normalizeObservedQuery('  Cafe\u0301   Pro\npricing?  '), 'Café Pro pricing?');
  assert.notEqual(normalizeObservedQuery('Acme?'), normalizeObservedQuery('acme?'));
  assert.equal(sourceGroupingUrl('HTTPS://Example.COM/path?a=1#section'), 'https://example.com/path?a=1');
  assert.notEqual(sourceGroupingUrl('https://example.com/path?a=1'), sourceGroupingUrl('https://example.com/path?a=2'));
  assert.equal(sourceGroupingUrl('file:///etc/passwd'), null);
});
