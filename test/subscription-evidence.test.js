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

test('Codex preserves multiple exposed queries and results in one completed action', () => {
  const lines = [
    { type: 'item.started', item: { type: 'web_search_call', id: 'ws-1', action: {
      type: 'search', queries: ['Acme pricing', 'Acme reviews'],
    } } },
    { type: 'item.completed', item: { type: 'web_search_call', id: 'ws-1', status: 'completed',
      results: [
        { url: 'https://pricing.example/', title: 'Pricing', rank: 1 },
        { url: 'https://reviews.example/', title: 'Reviews', rank: 2 },
      ] } },
    { type: 'item.completed', item: { type: 'unknown_web_search_format', results: [
      { url: 'https://unknown.example/' },
    ] } },
  ];
  const parsed = parseCodexJsonl(lines.map(JSON.stringify).join('\n'));
  const evidence = normalizeSubscriptionEvidence(parsed.searchEvents);
  assert.equal(parsed.webStatus, 'verified');
  assert.equal(parsed.rawEvents.length, 3);
  assert.deepEqual(evidence.actions.map((action) => [action.id, action.status, action.queries]), [
    ['search:ws-1', 'completed', ['Acme pricing', 'Acme reviews']],
  ]);
  assert.deepEqual(evidence.sources.map((source) => [source.url, source.order, source.actionId]), [
    ['https://pricing.example/', 1, 'search:ws-1'],
    ['https://reviews.example/', 2, 'search:ws-1'],
  ]);
});

test('a repeated terminal event does not double count one action or its results', () => {
  const event = { type: 'item.completed', item: { type: 'web_search_call', id: 'ws-repeat',
    action: { queries: ['Acme details'] }, results: [{ url: 'https://example.net/a', title: 'A' }],
  } };
  const parsed = parseCodexJsonl([event, event].map(JSON.stringify).join('\n'));
  const evidence = normalizeSubscriptionEvidence(parsed.searchEvents);
  assert.equal(evidence.actions.length, 1);
  assert.equal(evidence.sources.length, 1);
});

test('Claude tool result keeps structured search results and multiple input queries', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search-1',
      name: 'WebSearch', input: { queries: ['Acme features', 'Acme price'] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1',
      content: [
        { type: 'web_search_result', url: 'https://one.example/', title: 'One' },
        { type: 'web_search_result', url: 'https://two.example/', title: 'Two' },
      ] }] } },
    { type: 'result', subtype: 'success', result: 'Answer.' },
  ];
  const parsed = parseClaudeStreamJsonl(lines.map(JSON.stringify).join('\n'));
  const evidence = normalizeSubscriptionEvidence(parsed.searchEvents);
  assert.equal(parsed.webStatus, 'verified');
  assert.deepEqual(evidence.actions.map((action) => [action.status, action.queries]), [
    ['completed', ['Acme features', 'Acme price']],
  ]);
  assert.deepEqual(evidence.sources.map((source) => [source.url, source.order]), [
    ['https://one.example/', 0], ['https://two.example/', 1],
  ]);
});

test('unknown CLI event shape stays inspectable and cannot verify search', () => {
  const raw = { type: 'item.completed', item: { type: 'future_tool_call',
    action: { queries: ['hidden query'] }, results: [{ url: 'https://source.example/' }] } };
  const parsed = parseCodexJsonl(JSON.stringify(raw));
  assert.equal(parsed.webStatus, 'unavailable');
  assert.deepEqual(parsed.searchEvents, []);
  assert.deepEqual(parsed.rawEvents, [raw]);
});

test('an ID-free completion without query closes one unambiguous started search', () => {
  const parsed = parseCodexJsonl([
    { type: 'item.started', item: { type: 'web_search_call', action: { query: 'Acme' } } },
    { type: 'item.completed', item: { type: 'web_search_call', results: [
      { url: 'https://acme.example/' },
    ] } },
  ].map(JSON.stringify).join('\n'));
  const evidence = normalizeSubscriptionEvidence(parsed.searchEvents);
  assert.equal(evidence.actions.length, 1);
  assert.deepEqual(evidence.actions[0].queries, ['Acme']);
  assert.equal(evidence.actions[0].status, 'completed');
  assert.equal(evidence.sources[0].actionId, evidence.actions[0].id);
});

test('a completed action with no query does not invent query metadata', () => {
  const parsed = parseCodexJsonl(JSON.stringify({ type: 'item.completed', item: {
    type: 'web_search_call', id: 'ws-1', results: [{ url: 'https://example.org/' }],
  } }));
  const evidence = normalizeSubscriptionEvidence(parsed.searchEvents);
  assert.equal(evidence.actions[0].queryMetadata, 'unavailable');
  assert.deepEqual(evidence.actions[0].queries, []);
  assert.equal(evidence.sources.length, 1);
});
