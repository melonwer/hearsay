import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPrompt, endpoint, responsesEndpoint } from '../core/providers/openai.js';
import { _setFetch, _setSleep, ProviderError } from '../core/providers/shared.js';
import { assessObservation } from '../core/measurement-contract.js';
import { priceUsage } from '../core/cost.js';
import { apiExecutionBudget } from '../core/execution-budget.js';
import { buildConfig } from '../core/config.js';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/openai-responses-search.json', import.meta.url)), 'utf8'));
const options = { apiKey: 'sk-fixture-not-a-real-key-000', model: 'gpt-5.6-luna', timeoutMs: 1000 };

/** @param {unknown[]} responses */
function stub(responses) {
  /** @type {{url:string,body:Record<string,unknown>}[]} */
  const calls = [];
  let index = 0;
  _setFetch(async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const response = responses[Math.min(index++, responses.length - 1)];
    const record = /** @type {{status?:number,body?:unknown}} */ (response);
    return new Response(JSON.stringify(record.body ?? response), {
      status: typeof record.status === 'number' ? record.status : 200,
    });
  });
  return calls;
}

afterEach(() => { _setFetch(); _setSleep(); });

test('search request is explicit and keeps actions, sources, citations, and usage distinct', async () => {
  const calls = stub([fixture]);
  const result = await runPrompt('Which camera should I buy?', { ...options, searchPolicy: 'required' });
  assert.equal(calls[0].url, responsesEndpoint);
  assert.deepEqual(calls[0].body, {
    model: 'gpt-5.6-luna', input: [{ role: 'user', content: 'Which camera should I buy?' }],
    tools: [{ type: 'web_search' }], tool_choice: 'required',
    include: ['web_search_call.action.sources'], max_output_tokens: 2048,
  });
  assert.equal(result.text, 'Try Acme. See this guide.');
  assert.deepEqual(result.searchActions?.map(({ kind, status, queries, queryMetadata }) =>
    ({ kind, status, queries, queryMetadata })), [
    { kind: 'search', status: 'completed', queries: ['best trail cameras'], queryMetadata: 'available' },
    { kind: 'search', status: 'completed', queries: [], queryMetadata: 'unavailable' },
  ]);
  assert.deepEqual(result.sources?.map(({ url, actionId }) => ({ url, actionId })), [
    { url: 'https://example.org/review', actionId: 'ws_one:0' },
    { url: 'https://example.org/catalog', actionId: 'ws_one:0' },
  ]);
  assert.deepEqual(result.answerCitations, [{
    url: 'https://example.net/guide', provenance: 'native_annotation', sourceId: null, start: 14, end: 24,
  }]);
  assert.deepEqual(result.billableAttempts, [{
    attempt: 0, continuation: 0, inputTokens: 120, outputTokens: 74,
    requestCompleted: true, searchCalls: 2,
  }]);
  assert.equal(assessObservation({ policy: 'required', answerStatus: result.answerStatus ?? 'failed',
    actions: result.searchActions ?? [] }).comparable, true);
  const priced = priceUsage({ provider: 'openai', model: result.model, targetId: '1',
    searchPolicy: 'required', attempts: result.billableAttempts ?? [] }, {});
  assert.equal(priced.computedCostUsd, 0.0201128);
});

test('auto no-search is confirmed, while required no-search is excluded', async () => {
  const noSearch = { ...fixture, output: [fixture.output[2]] };
  const calls = stub([noSearch, noSearch]);
  const auto = await runPrompt('q', { ...options, searchPolicy: 'auto' });
  const required = await runPrompt('q', { ...options, searchPolicy: 'required' });
  assert.equal(calls[0].body.tool_choice, 'auto');
  assert.equal(auto.noSearchConfirmed, true);
  assert.equal(auto.billableAttempts?.[0].searchCalls, 0);
  assert.equal(assessObservation({ policy: 'auto', answerStatus: auto.answerStatus ?? 'failed',
    actions: auto.searchActions ?? [], noSearchConfirmed: auto.noSearchConfirmed }).searchState, 'not_used');
  assert.equal(assessObservation({ policy: 'required', answerStatus: required.answerStatus ?? 'failed',
    actions: required.searchActions ?? [] }).exclusion, 'required_search_unverified');
});

test('partial, refusal, and failed tool output stays non-comparable and unpriced for uncertain search', async () => {
  const calls = stub([
    { ...fixture, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { ...fixture, output: [...fixture.output.slice(0, 1), { type: 'message', status: 'completed',
      content: [{ type: 'refusal', refusal: 'Cannot answer' }] }] },
    { ...fixture, output: [{ ...fixture.output[0], status: 'failed' }, fixture.output[2]] },
  ]);
  const partial = await runPrompt('q', { ...options, searchPolicy: 'required' });
  const refusal = await runPrompt('q', { ...options, searchPolicy: 'required' });
  const failedTool = await runPrompt('q', { ...options, searchPolicy: 'required' });
  assert.equal(calls.length, 3);
  assert.equal(partial.answerStatus, 'truncated');
  assert.equal(partial.billableAttempts?.[0].searchCalls, null);
  assert.equal(refusal.answerStatus, 'refused');
  assert.equal(failedTool.searchActions?.[0].status, 'failed');
  assert.equal(failedTool.billableAttempts?.[0].searchCalls, null);
  assert.equal(assessObservation({ policy: 'required', answerStatus: failedTool.answerStatus ?? 'failed',
    actions: failedTool.searchActions ?? [] }).comparable, false);
});

test('search errors preserve normalized usage and never replay ambiguous failures', async () => {
  _setSleep(async () => {});
  const calls = stub([{ status: 429, body: { usage: { input_tokens: 4, output_tokens: 2 } } },
    { status: 429, body: { usage: { input_tokens: 5, output_tokens: 3 } } }]);
  const error = await runPrompt('q', { ...options, searchPolicy: 'required' }).catch((e) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, 'quota');
  assert.equal(calls.length, 2);
  assert.deepEqual(error.billableAttempts?.map((attempt) =>
    [attempt.inputTokens, attempt.outputTokens, attempt.searchCalls]), [[4, 2, null], [5, 3, null]]);
});

test('search cancellation and oversized responses stop without replaying the target', async () => {
  const controller = new AbortController();
  let calls = 0;
  _setFetch((_url, init = {}) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  const pending = runPrompt('q', { ...options, searchPolicy: 'required', signal: controller.signal });
  controller.abort();
  const cancelled = await pending.catch((e) => e);
  assert.ok(cancelled instanceof ProviderError);
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(calls, 1);

  _setFetch(async () => {
    calls += 1;
    return new Response('x'.repeat(2 * 1024 * 1024 + 1));
  });
  const oversized = await runPrompt('q', { ...options, searchPolicy: 'required' }).catch((e) => e);
  assert.ok(oversized instanceof ProviderError);
  assert.match(oversized.message, /exceeded/);
  assert.equal(calls, 2);
});

test('search timeout preserves an unknown attempt and does not retry', async () => {
  let calls = 0;
  _setFetch((_url, init = {}) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  const error = await runPrompt('q', { ...options, searchPolicy: 'required', timeoutMs: 25 }).catch((e) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, 'timeout');
  assert.equal(error.billableAttempts?.[0].inputTokens, null);
  assert.equal(calls, 1);
});

test('completed search with no reported results still verifies search; exposed query arrays stay separate', async () => {
  const body = { ...fixture, output: [{ ...fixture.output[1],
    action: { type: 'search', queries: ['camera reviews', 'camera prices'], sources: [] } }, fixture.output[2]] };
  stub([body]);
  const result = await runPrompt('q', { ...options, searchPolicy: 'required' });
  assert.deepEqual(result.searchActions?.[0].queries, ['camera reviews', 'camera prices']);
  assert.deepEqual(result.sources, []);
  assert.equal(assessObservation({ policy: 'required', answerStatus: result.answerStatus ?? 'failed',
    actions: result.searchActions ?? [] }).searchState, 'verified');
});

test('search authorization failure is classified and carries unknown tool billing', async () => {
  const calls = stub([{ status: 401, body: { error: { message: 'invalid key' } } }]);
  const error = await runPrompt('q', { ...options, searchPolicy: 'required' }).catch((e) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, 'auth');
  assert.equal(error.billableAttempts?.[0].searchCalls, null);
  assert.equal(calls.length, 1);
});

test('search policy and model are validated before a network call; default route remains off', async () => {
  const calls = stub([{ choices: [{ message: { content: 'Plain answer' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }]);
  await assert.rejects(runPrompt('q', { ...options, model: 'other', searchPolicy: 'required' }), RangeError);
  await assert.rejects(runPrompt('q', { ...options, searchPolicy: 'legacy' }), RangeError);
  const off = await runPrompt('q', options);
  assert.equal(off.text, 'Plain answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  const config = buildConfig({ HEARSAY_DEMO: '0', OPENAI_API_KEY: options.apiKey,
    HEARSAY_OPENAI_SEARCH_POLICY: 'required' });
  assert.equal(apiExecutionBudget(config, 'openai').route, 'openai-responses-web-search-v1');
  assert.equal(apiExecutionBudget(config, 'openai').searchCallLimitEnforced, false);
});
