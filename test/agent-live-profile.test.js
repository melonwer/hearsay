import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexJsonl, parseClaudeStreamJsonl } from '../core/agent-parsers.js';
import { CodexCliRunner } from '../core/agent-runners.js';
import { redactEvent, redactCapturedOutput } from '../core/artifacts.js';
import { probeAuthentication, preflightCli } from '../core/agent-process.js';

const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n');
const stream = (action = { type: 'search', queries: ['newsletter software', 'self hosted newsletters'] }, status) => jsonl([
  { type: 'item.started', item: { id: 'search-1', type: 'web_search', query: '', action: { type: 'other' } } },
  { type: 'item.completed', item: { id: 'search-1', type: 'web_search', query: 'newsletter software ...', status, action,
    results: [{ type: 'text_result', title: 'Newsletter product', url: 'https://source.example/' }] } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'A newsletter tool. https://citation.example/' } },
  { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
]);

test('current Codex web_search events retain exact queries, returned sources and final citations separately', () => {
  const parsed = parseCodexJsonl(stream());
  assert.equal(parsed.webStatus, 'verified');
  assert.equal(parsed.model, null);
  assert.equal(parsed.searchEvents.filter((event) => event.status === 'completed').length, 1);
  assert.deepEqual(parsed.searchEvents[1].queries, ['newsletter software', 'self hosted newsletters']);
  assert.deepEqual(parsed.searchEvents[1].results, [{ title: 'Newsletter product', url: 'https://source.example/', rank: null }]);
  assert.deepEqual(parsed.citations, ['https://citation.example/']);
});

test('current Codex open, find and unknown actions do not establish completed search', () => {
  for (const type of ['open', 'find', 'other']) {
    const parsed = parseCodexJsonl(stream({ type, url: 'https://source.example/' }));
    assert.notEqual(parsed.webStatus, 'verified');
    assert.equal(parsed.searchEvents.filter((event) => event.eventType === 'search' && event.status === 'completed').length, 0);
  }
  const failed = parseCodexJsonl(stream(undefined, 'rate_limited'));
  assert.equal(failed.errorCode, 'rate_limited');
  assert.equal(failed.webStatus, 'failed');
});

test('only exposed model metadata becomes an observed model', async (t) => {
  assert.equal(parseCodexJsonl(jsonl([{ type: 'turn.started', model: 'observed-model' }])).model, 'observed-model');
  assert.equal(parseClaudeStreamJsonl(jsonl([{ type: 'assistant', message: { model: 'observed-claude', content: [] } }])).model, 'observed-claude');
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-observed-model-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runner = new CodexCliRunner({ dataDir: directory, executable: '/synthetic/codex',
    discoverImpl: async () => ({ executable: '/synthetic/codex', version: 'fixture', help: '' }),
    preflightImpl: async () => ({ authenticated: true, authKind: 'subscription' }),
    spawnBoundedImpl: async () => ({ stdout: stream(), stderr: '', exitCode: 0, signal: null }),
  });
  const result = await runner.run({ responseId: 1, promptText: 'Which newsletter tool?', promptOrigin: 'user_authored', model: 'configured-only' });
  assert.equal(result.model, null);
  assert.equal(result.webStatus, 'verified');
});

test('event redaction preserves numeric usage while excluding credential values', () => {
  assert.deepEqual(redactEvent({ usage: { input_tokens: 120, output_tokens: 40, cached_input_tokens: 10 },
    access_token: 'private', refresh_token: 'private', api_key: 'private', inputTokens: 'private' }), {
    usage: { input_tokens: 120, output_tokens: 40, cached_input_tokens: 10 },
    access_token: '[REDACTED]', refresh_token: '[REDACTED]', api_key: '[REDACTED]', inputTokens: '[REDACTED]',
  });
});


test('partial and malformed captures exclude credential fields while retaining observations', () => {
  const raw = '{"access_token":"private-token","usage":{"input_tokens":5}}\n{"refresh_token":"private-refresh", broken\nanswer text';
  const scrubbed = redactCapturedOutput(raw);
  assert.ok(!scrubbed.includes('private-token'));
  assert.ok(!scrubbed.includes('private-refresh'));
  assert.match(scrubbed, /"input_tokens":5/);
  assert.match(scrubbed, /answer text/);
});


test('account probes refuse API-key logins instead of changing the billing route', async () => {
  for (const stdout of ['Logged in using API key', '{"loggedIn":true,"authMethod":"api_key"}', '{"loggedIn":true,"authMethod":"claude.ai","apiKeySource":"apiKeyHelper"}']) {
    const probe = await probeAuthentication({ executable: 'synthetic', args: ['login', 'status'], execFileImpl: async () => ({ stdout, stderr: '' }) });
    assert.equal(probe.authenticated, false);
    await assert.rejects(preflightCli({ discovered: { executable: 'synthetic', version: 'fixture', help: '' }, requiredFlags: [], authProbe: async () => probe }), { code: 'authentication_missing' });
  }
  for (const stdout of ['Logged in using ChatGPT', '{"loggedIn":true,"authMethod":"claude.ai","apiKeySource":null}']) {
    const probe = await probeAuthentication({ executable: 'synthetic', args: ['login', 'status'], execFileImpl: async () => ({ stdout, stderr: '' }) });
    assert.equal(probe.authenticated, true);
    assert.equal(probe.authKind, 'subscription');
  }
});
