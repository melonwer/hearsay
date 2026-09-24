import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPrompt, endpoint } from '../core/providers/anthropic.js';
import { ProviderError, _setFetch, _setSleep } from '../core/providers/shared.js';
import { assessObservation } from '../core/measurement-contract.js';
import { buildConfig } from '../core/config.js';
import { apiExecutionBudget } from '../core/execution-budget.js';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/anthropic-search.json', import.meta.url)), 'utf8'));
const options = { apiKey: 'fixture-key', model: 'claude-sonnet-5', timeoutMs: 1000, searchPolicy: /** @type {const} */ ('auto') };

/** @param {{status?:number,body:unknown}[]} replies */
function stub(replies) {
  /** @type {{url:string,body:Record<string,unknown>}[]} */
  const calls = [];
  let index = 0;
  _setFetch(async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const reply = replies[Math.min(index++, replies.length - 1)];
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

afterEach(() => { _setFetch(); _setSleep(); });

test('basic Anthropic search preserves two actions, sources, citations, and reported search use', async () => {
  const calls = stub([{ body: fixture }]);
  const result = await runPrompt('Which tracker?', options);
  assert.equal(calls[0].url, endpoint);
  assert.deepEqual(calls[0].body, {
    model: 'claude-sonnet-5', max_tokens: 1024,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: 'Which tracker?' }],
  });
  assert.equal(result.text, 'Try Acme.');
  assert.deepEqual(result.searchActions?.map((action) =>
    [action.id, action.status, action.queries]), [
    ['srvtoolu_a', 'completed', ['best project tracker']],
    ['srvtoolu_b', 'completed', []],
  ]);
  assert.deepEqual(result.sources?.map((source) => source.url), [
    'https://example.org/review', 'https://example.org/catalog',
  ]);
  assert.deepEqual(result.answerCitations, [{ url: 'https://example.net/guide',
    provenance: 'native_annotation', sourceId: null, start: null, end: null }]);
  assert.equal(result.billableAttempts?.[0].searchCalls, 2);
  assert.equal(assessObservation({ policy: 'auto', answerStatus: result.answerStatus ?? 'failed',
    actions: result.searchActions ?? [] }).comparable, true);
});

test('auto no-search and HTTP 200 tool error remain distinct', async () => {
  const noSearch = { ...fixture, usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'text', text: 'Acme.' }] };
  const toolError = { ...fixture, usage: { input_tokens: 10, output_tokens: 5,
    server_tool_use: { web_search_requests: 0 } }, content: [fixture.content[0],
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_a', content: {
      type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: 'Acme.' }] };
  stub([{ body: noSearch }, { body: toolError }]);
  const plain = await runPrompt('q', options);
  const failed = await runPrompt('q', options);
  assert.equal(plain.noSearchConfirmed, true);
  assert.equal(plain.billableAttempts?.[0].searchCalls, 0);
  assert.equal(failed.searchActions?.[0].status, 'failed');
  assert.equal(assessObservation({ policy: 'auto', answerStatus: failed.answerStatus ?? 'failed',
    actions: failed.searchActions ?? [] }).comparable, false);
});

test('a citation links to one matching reported result and remains separate from others', async () => {
  const body = structuredClone(fixture);
  body.content[4].citations[0].url = 'https://example.org/review';
  stub([{ body }]);
  const result = await runPrompt('q', options);
  assert.equal(result.answerCitations?.[0].sourceId, 'srvtoolu_a:source:0');
  assert.equal(result.sources?.length, 2);
});

test('pause continuation resends original blocks and reduces remaining search uses', async () => {
  const paused = { ...fixture, stop_reason: 'pause_turn', usage: { input_tokens: 20, output_tokens: 10,
    server_tool_use: { web_search_requests: 1 } }, content: fixture.content.slice(0, 2) };
  const finished = { ...fixture, usage: { input_tokens: 25, output_tokens: 15,
    server_tool_use: { web_search_requests: 1 } }, content: fixture.content.slice(2) };
  const calls = stub([{ body: paused }, { body: finished }]);
  const result = await runPrompt('q', options);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.messages, [
    { role: 'user', content: 'q' }, { role: 'assistant', content: paused.content },
  ]);
  assert.equal(calls[1].body.tools[0].max_uses, 2);
  assert.equal(result.answerStatus, 'complete');
  assert.deepEqual(result.billableAttempts?.map((attempt) =>
    [attempt.continuation, attempt.searchCalls]), [[0, 1], [1, 1]]);
  assert.deepEqual(result.tokens, { input: 45, output: 25 });
  assert.equal(result.searchActions?.length, 2);
});

test('repeated pause reaches continuation cap without a third request', async () => {
  const paused = { ...fixture, stop_reason: 'pause_turn', usage: { input_tokens: 20, output_tokens: 10,
    server_tool_use: { web_search_requests: 1 } }, content: fixture.content.slice(0, 2) };
  const calls = stub([{ body: paused }, { body: paused }]);
  const result = await runPrompt('q', options);
  assert.equal(calls.length, 2);
  assert.equal(result.answerStatus, 'incomplete');
});

test('failed continuation retains earlier search evidence and both attempt receipts', async () => {
  const paused = { ...fixture, stop_reason: 'pause_turn', usage: { input_tokens: 20, output_tokens: 10,
    server_tool_use: { web_search_requests: 1 } }, content: fixture.content.slice(0, 2) };
  const calls = stub([{ body: paused }, { status: 500, body: { error: { message: 'server failed' },
    usage: { input_tokens: 5, output_tokens: 1 } } }]);
  const error = await runPrompt('q', options).catch((e) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(calls.length, 2);
  assert.equal(error.partialResult?.searchActions?.[0].status, 'completed');
  assert.deepEqual(error.billableAttempts?.map((attempt) =>
    [attempt.continuation, attempt.inputTokens, attempt.searchCalls]), [[0, 20, 1], [1, 5, null]]);
});

test('unsupported policy and model reject before a request', async () => {
  const calls = stub([{ body: fixture }]);
  await assert.rejects(runPrompt('q', { ...options, model: 'other' }), RangeError);
  await assert.rejects(runPrompt('q', { ...options, searchPolicy: 'required' }), RangeError);
  assert.equal(calls.length, 0);
  const config = buildConfig({ ANTHROPIC_API_KEY: 'fixture-key', HEARSAY_ANTHROPIC_SEARCH_POLICY: 'auto' });
  const budget = apiExecutionBudget(config, 'anthropic');
  assert.deepEqual([budget.maxSearchCalls, budget.maxContinuations, budget.searchCallLimitEnforced], [3, 1, true]);
});

test('missing credential fails before any search request', async () => {
  const calls = stub([{ body: fixture }]);
  const error = await runPrompt('q', { ...options, apiKey: '' }).catch((e) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, 'auth');
  assert.equal(calls.length, 0);
});

test('a 429 retry is one target with separate attempt usage and one search action', async () => {
  _setSleep(async () => {});
  const calls = stub([{ status: 429, body: { error: { message: 'rate limit' },
    usage: { input_tokens: 3, output_tokens: 1,
      server_tool_use: { web_search_requests: 0 } } } }, { body: fixture }]);
  const result = await runPrompt('q', options);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.billableAttempts?.map((attempt) =>
    [attempt.attempt, attempt.continuation, attempt.inputTokens, attempt.searchCalls]), [
    [0, 0, 3, 0], [1, 0, 100, 2],
  ]);
  assert.equal(result.searchActions?.length, 2);
});

test('Anthropic search timeout and cancellation do not replay an ambiguous call', async () => {
  let calls = 0;
  _setFetch((_url, init = {}) => {
    calls += 1;
    return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  });
  const timedOut = await runPrompt('q', { ...options, timeoutMs: 25 }).catch((e) => e);
  assert.equal(timedOut.kind, 'timeout');
  const controller = new AbortController();
  const pending = runPrompt('q', { ...options, signal: controller.signal });
  controller.abort();
  const cancelled = await pending.catch((e) => e);
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(calls, 2);
});
