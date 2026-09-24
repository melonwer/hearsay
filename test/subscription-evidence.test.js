import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { parseClaudeStreamJsonl, parseCodexJsonl } from '../core/agent-parsers.js';
import { normalizeSubscriptionEvidence } from '../core/subscription-evidence.js';

test('CLI fixtures keep searches and fetches as separate completed actions', () => {
  const codex = parseCodexJsonl(readFileSync(new URL('./fixtures/codex-search.jsonl', import.meta.url), 'utf8'));
  const claude = parseClaudeStreamJsonl(readFileSync(new URL('./fixtures/claude-search.jsonl', import.meta.url), 'utf8'));
  const codexEvidence = normalizeSubscriptionEvidence(codex.searchEvents);
  const claudeEvidence = normalizeSubscriptionEvidence(claude.searchEvents);
  assert.deepEqual(codexEvidence.actions.map((action) => [action.kind, action.status, action.queries]), [
    ['search', 'completed', ['best project tracker for a small team']],
  ]);
  assert.equal(codexEvidence.sources[0].url, 'https://acme.example/guide');
  assert.deepEqual(claudeEvidence.actions.map((action) => [action.kind, action.status]), [
    ['search', 'completed'], ['fetch', 'completed'],
  ]);
  assert.equal(claudeEvidence.sources[0].provenance, 'fetch');
});

test('start and completion of one action reconcile without merging a later repeat', () => {
  /** @type {import('../core/agent-parsers.js').SearchEvent[]} */
  const events = [
    { eventType: 'search', status: 'started', query: 'Acme pricing', url: null, title: null,
      domain: null, observedAt: null, rank: null, providerEventType: 'item.started', actionId: 'call-1' },
    { eventType: 'search', status: 'completed', query: 'Acme pricing', url: 'https://source.example/?q=1',
      title: 'Source', domain: 'source.example', observedAt: null, rank: 1,
      providerEventType: 'item.completed', actionId: 'call-1' },
    { eventType: 'search', status: 'completed', query: 'Acme pricing', url: 'https://other.example/',
      title: 'Other', domain: 'other.example', observedAt: null, rank: 1,
      providerEventType: 'item.completed', actionId: 'call-2' },
  ];
  const result = normalizeSubscriptionEvidence(events);
  assert.deepEqual(result.actions.map((action) => [action.id, action.status]), [
    ['search:call-1', 'completed'], ['search:call-2', 'completed'],
  ]);
  assert.deepEqual(result.sources.map((source) => [source.url, source.actionId]), [
    ['https://source.example/?q=1', 'search:call-1'],
    ['https://other.example/', 'search:call-2'],
  ]);
});

test('missing IDs pair only an unambiguous start with its terminal event', () => {
  /** @type {import('../core/agent-parsers.js').SearchEvent[]} */
  const events = [
    { eventType: 'search', status: 'started', query: null, url: null, title: null,
      domain: null, observedAt: null, rank: null, providerEventType: 'start', actionId: null },
    { eventType: 'search', status: 'completed', query: 'actual exposed query', url: null, title: null,
      domain: null, observedAt: null, rank: null, providerEventType: 'complete', actionId: null },
    { eventType: 'search', status: 'completed', query: 'actual exposed query', url: null, title: null,
      domain: null, observedAt: null, rank: null, providerEventType: 'complete', actionId: null },
  ];
  const result = normalizeSubscriptionEvidence(events);
  assert.deepEqual(result.actions.map((action) => [action.status, action.queries]), [
    ['completed', ['actual exposed query']],
    ['completed', ['actual exposed query']],
  ]);
});
