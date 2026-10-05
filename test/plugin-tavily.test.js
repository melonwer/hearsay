import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectTavilyUsage } from '../core/tavily-search.js';

test('credential absence makes no provider request', async () => {
  let calls = 0;
  const result = await inspectTavilyUsage({ apiKey: '', fetch: async () => { calls++; } });
  assert.equal(result.status, 'missing_key'); assert.equal(calls, 0);
});
test('read-only capacity inspection calls usage without searches or raw secret output', async () => {
  const calls = [];
  const result = await inspectTavilyUsage({ apiKey: 'tvly-fixture-secret', fetch: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ key: { usage: 10, limit: 200 }, account: { current_plan: 'free', plan_usage: 15, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 }, debug: 'tvly-fixture-secret' });
  } });
  assert.equal(result.status, 'available');
  assert.equal(result.usage.keyUsage, 10); assert.equal(result.usage.accountUsage, 15);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.tavily.com/usage');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(JSON.stringify(result).includes('tvly-fixture-secret'), false);
});
test('authentication, unsafe free policy and unavailable capacity remain actionable', async () => {
  const options = { apiKey: 'fixture-key' };
  assert.equal((await inspectTavilyUsage({ ...options, fetch: async () => Response.json({}, { status: 401 }) })).status, 'authentication_required');
  assert.equal((await inspectTavilyUsage({ ...options, fetch: async () => Response.json({}) })).status, 'unknown_capacity');
  assert.equal((await inspectTavilyUsage({ ...options, fetch: async () => { throw new Error('fixture-key'); } })).status, 'unavailable');
  const result = await inspectTavilyUsage({ ...options, fetch: async () => Response.json({ key: { usage: 0, limit: 1000 }, account: { current_plan: 'free', plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: 100 } }) });
  assert.equal(result.status, 'free_mode_unprotected');
});
