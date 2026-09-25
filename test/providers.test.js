/**
 * Lane A: provider adapters (§5), the panel runner (§8.1) and the scheduler (§8.2).
 *
 * No test in this file touches the network. `_setFetch()` swaps in canned fixtures from
 * test/fixtures/, and the runner is driven by fake adapters, so the whole lane is
 * exercised without an API key, a bill, or a flaky third party.
 */

import test, { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ProviderError,
  _setFetch,
  _setSleep,
  backoffMs,
  normalizeCitations,
  scrubSecrets,
} from '../core/providers/shared.js';
import * as openai from '../core/providers/openai.js';
import * as anthropic from '../core/providers/anthropic.js';
import * as gemini from '../core/providers/gemini.js';
import * as perplexity from '../core/providers/perplexity.js';
import { adapters, enabledAdapters, getAdapter } from '../core/providers/index.js';

import { buildConfig } from '../core/config.js';
import { isoNow, openDb, run as dbRun, all, get, getSetting, setSetting, SETTING_KEYS } from '../core/db.js';
import {
  CIRCUIT_THRESHOLD,
  DemoModeError,
  RunInProgressError,
  SKIPPED_CIRCUIT,
  recoverStaleRuns,
  runPanel,
} from '../core/runner.js';
import { localDate, localHm, shouldRun, startScheduler } from '../core/scheduler.js';
import { saveApiSearchSchedule } from '../core/api-search-schedule.js';
import { reviewTrackingPrompt } from '../core/benchmark-draft.js';

/**
 * @param {string} name
 * @returns {any}
 */
function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'));
}

const ERRORS = fixture('provider-errors');

/** A key-shaped string. If this ever appears in an error or a row, secrets hygiene broke. */
const FAKE_KEY = 'sk-fixture-not-a-real-key-000';

/**
 * Record every request the adapter makes and reply with the queued responses.
 *
 * @param {{status?: number, body?: unknown}[]} replies consumed in order; the last repeats
 * @returns {{calls: {url: string, init: RequestInit}[]}}
 */
function stubFetch(replies) {
  /** @type {{url: string, init: RequestInit}[]} */
  const calls = [];
  let index = 0;
  _setFetch(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

/** A fetch that never settles until the abort signal fires. */
function stubHangingFetch() {
  _setFetch(
    (_url, init = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
}

/**
 * @param {{init: RequestInit}} call
 * @returns {any}
 */
function bodyOf(call) {
  return JSON.parse(String(call.init.body));
}

/**
 * @param {{init: RequestInit}} call
 * @param {string} name
 * @returns {string|undefined}
 */
function headerOf(call, name) {
  const headers = /** @type {Record<string, string>} */ (call.init.headers ?? {});
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

// ---------------------------------------------------------------------------
// §5.1 — shared plumbing
// ---------------------------------------------------------------------------

describe('shared plumbing (§5.1)', () => {
  afterEach(() => {
    _setFetch();
    _setSleep();
  });

  it('classifies 401 and 403 as auth', async () => {
    stubFetch([{ status: 401, body: ERRORS.openai_401 }]);
    const err = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'auth');

    stubFetch([{ status: 403, body: ERRORS.gemini_403 }]);
    const forbidden = await gemini.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((e) => e);
    assert.equal(forbidden.kind, 'auth');
  });

  it('classifies 429 as quota, after one retry', async () => {
    _setSleep(async () => {});
    const { calls } = stubFetch([{ status: 429, body: ERRORS.openai_429 }]);
    const err = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'quota');
    assert.equal(calls.length, 2, '429 is transient: one retry, then give up');
  });

  it('classifies an aborted request as timeout and does not retry it', async () => {
    stubHangingFetch();
    const started = Date.now();
    const err = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 25 }).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'timeout');
    assert.ok(Date.now() - started < 2000, 'a timeout must not be followed by a backoff sleep');
  });

  it('does not replay a 5xx that may have reached the provider', async () => {
    _setSleep(async () => {});
    const { calls } = stubFetch([
      { status: 500, body: ERRORS.openai_500 },
      { status: 200, body: fixture('openai') },
    ]);
    const error = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((cause) => cause);
    assert.equal(calls.length, 1);
    assert.equal(error.kind, 'other');
  });

  it('does not replay an ambiguous network failure', async () => {
    _setSleep(async () => {});
    let attempts = 0;
    _setFetch(async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    });
    const err = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((e) => e);
    assert.equal(attempts, 1);
    assert.equal(err.kind, 'other');
  });

  it('retains an earlier rate-limited attempt when a retry succeeds', async () => {
    _setSleep(async () => {});
    const { calls } = stubFetch([
      { status: 429, body: ERRORS.openai_429 },
      { status: 200, body: fixture('openai') },
    ]);
    const result = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
    assert.equal(calls.length, 2);
    assert.deepEqual(result.billableAttempts, [
      { attempt: 0, continuation: 0, inputTokens: null, outputTokens: null, requestCompleted: false },
      { attempt: 1, continuation: 0, inputTokens: 24, outputTokens: 187, requestCompleted: true },
    ]);
  });

  it('retains reported usage from a rate-limited attempt before a successful retry', async () => {
    _setSleep(async () => {});
    stubFetch([
      { status: 429, body: { error: { message: 'rate limit' }, usage: { prompt_tokens: 10, completion_tokens: 4 } } },
      { status: 200, body: fixture('openai') },
    ]);
    const result = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
    assert.deepEqual(result.billableAttempts, [
      { attempt: 0, continuation: 0, inputTokens: 10, outputTokens: 4, requestCompleted: false },
      { attempt: 1, continuation: 0, inputTokens: 24, outputTokens: 187, requestCompleted: true },
    ]);
  });

  it('normalizes provider-reported usage on an unsuccessful HTTP response', async () => {
    for (const [adapter, usage, expected] of /** @type {[any, object, [number,number]][]} */ ([
      [openai, { prompt_tokens: 11, completion_tokens: 5 }, [11, 5]],
      [anthropic, { input_tokens: 12, output_tokens: 6 }, [12, 6]],
      [gemini, { promptTokenCount: 13, candidatesTokenCount: 7, thoughtsTokenCount: 2 }, [13, 9]],
      [perplexity, { prompt_tokens: 14, completion_tokens: 8 }, [14, 8]],
    ])) {
      const body = adapter === gemini ? { error: { message: 'failed' }, usageMetadata: usage }
        : { error: { message: 'failed' }, usage };
      stubFetch([{ status: 500, body }]);
      const error = await adapter.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((cause) => cause);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'other');
      assert.deepEqual(error.billableAttempts?.map((attempt) => [attempt.inputTokens, attempt.outputTokens]), [expected]);
    }
  });

  it('retains usage when a successful HTTP response lacks an answer', async () => {
    stubFetch([{ status: 200, body: { usage: { prompt_tokens: 9, completion_tokens: 3 } } }]);
    const error = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((cause) => cause);
    assert.ok(error instanceof ProviderError);
    assert.deepEqual(error.billableAttempts, [
      { attempt: 0, continuation: 0, inputTokens: 9, outputTokens: 3, requestCompleted: true },
    ]);
  });

  it('does not retry a 400', async () => {
    _setSleep(async () => {});
    const { calls } = stubFetch([{ status: 400, body: { error: { message: 'bad request' } } }]);
    const err = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((e) => e);
    assert.equal(calls.length, 1);
    assert.equal(err.kind, 'other');
  });

  it('never leaks a key-shaped string into the error it stores', async () => {
    for (const [adapter, status, body] of /** @type {[any, number, unknown][]} */ ([
      [openai, 401, ERRORS.openai_401],
      [gemini, 403, ERRORS.gemini_403],
      [perplexity, 401, ERRORS.perplexity_401],
    ])) {
      stubFetch([{ status, body }]);
      const err = await adapter.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((e) => e);
      const stored = err.toStorage();
      assert.doesNotMatch(stored, /sk-fixture/, stored);
      assert.doesNotMatch(stored, /pplx-fixture/, stored);
      assert.doesNotMatch(stored, /AIzaFixture/, stored);
      assert.doesNotMatch(stored, new RegExp(FAKE_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), stored);
    }
  });

  it('fails fast with an auth error when the key is missing', async () => {
    const { calls } = stubFetch([{ status: 200, body: fixture('openai') }]);
    const err = await openai.runPrompt('q', { apiKey: '', timeoutMs: 1000 }).catch((e) => e);
    assert.equal(err.kind, 'auth');
    assert.match(err.message, /OPENAI_API_KEY/);
    assert.equal(calls.length, 0, 'no point spending a round-trip on a key we know is absent');
  });

  it('keeps the retry backoff inside the documented 2–8s band', () => {
    assert.equal(backoffMs(1, () => 0), 2000);
    assert.equal(backoffMs(1, () => 1), 5000);
    assert.equal(backoffMs(2, () => 0), 5000);
    assert.equal(backoffMs(2, () => 1), 8000);
  });

  it('scrubs key-shaped strings', () => {
    assert.equal(scrubSecrets('key sk-abcdef1234 here'), 'key [redacted] here');
    assert.equal(scrubSecrets('Authorization: Bearer pplx-abc.def'), 'Authorization: Bearer [redacted]');
    assert.equal(scrubSecrets('key AIzaSyABCDEFGH1234 here'), 'key [redacted] here');
  });

  it('dedupes citations and drops non-URLs, preserving order', () => {
    assert.deepEqual(
      normalizeCitations(['https://a.example/x', { url: 'https://b.example' }, 'https://a.example/x', 42, { nope: 1 }, '  ']),
      [{ url: 'https://a.example/x' }, { url: 'https://b.example' }],
    );
  });
});

// ---------------------------------------------------------------------------
// §5.2 — per-adapter fixture parsing and request shape
// ---------------------------------------------------------------------------

describe('adapters (§5.2)', () => {
  afterEach(() => {
    _setFetch();
    _setSleep();
  });

  it('openai: fixture → ProviderResult', async () => {
    const { calls } = stubFetch([{ status: 200, body: fixture('openai') }]);
    const result = await openai.runPrompt('best AI meeting notes tool?', {
      apiKey: FAKE_KEY,
      model: 'gpt-5.6-luna',
      timeoutMs: 1000,
    });

    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(headerOf(calls[0], 'authorization'), `Bearer ${FAKE_KEY}`);
    const body = bodyOf(calls[0]);
    assert.equal(body.model, 'gpt-5.6-luna');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'best AI meeting notes tool?' }]);

    assert.match(result.text, /^For a small sales team/);
    assert.equal(result.model, 'gpt-5.6-luna');
    assert.deepEqual(result.tokens, { input: 24, output: 187 });
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(result.citations, undefined, 'OpenAI chat completions carry no native citations');
  });

  it('anthropic: fixture → ProviderResult, text blocks concatenated', async () => {
    const { calls } = stubFetch([{ status: 200, body: fixture('anthropic') }]);
    const result = await anthropic.runPrompt('best AI meeting notes tool?', {
      apiKey: FAKE_KEY,
      model: 'claude-sonnet-5',
      timeoutMs: 1000,
    });

    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(headerOf(calls[0], 'x-api-key'), FAKE_KEY);
    assert.equal(headerOf(calls[0], 'anthropic-version'), '2023-06-01');
    const body = bodyOf(calls[0]);
    assert.equal(body.max_tokens, 1024);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'best AI meeting notes tool?' }]);

    assert.match(result.text, /^A few meeting-notes tools/);
    assert.match(result.text, /EchoPad/, 'the second text block must be concatenated, not dropped');
    assert.equal(result.model, 'claude-sonnet-5');
    assert.deepEqual(result.tokens, { input: 22, output: 203 });
  });

  it('anthropic: cache counters fold into input tokens', async () => {
    const payload = fixture('anthropic');
    payload.usage.cache_creation_input_tokens = 100;
    payload.usage.cache_read_input_tokens = 40;
    stubFetch([{ status: 200, body: payload }]);
    const result = await anthropic.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
    assert.deepEqual(result.tokens, { input: 22 + 100 + 40, output: 203 });
  });

  it('gemini: fixture → ProviderResult, parts concatenated, key in a header not a URL', async () => {
    const { calls } = stubFetch([{ status: 200, body: fixture('gemini') }]);
    const result = await gemini.runPrompt('best AI meeting notes tool?', {
      apiKey: FAKE_KEY,
      model: 'gemini-3.6-flash',
      timeoutMs: 1000,
    });

    assert.equal(
      calls[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    );
    assert.doesNotMatch(calls[0].url, /key=/, 'the API key must never appear in a URL (§19.6 #9)');
    assert.equal(headerOf(calls[0], 'x-goog-api-key'), FAKE_KEY);
    const body = bodyOf(calls[0]);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'best AI meeting notes tool?' }] }]);
    assert.equal(body.systemInstruction, undefined, 'no system prompt (§5.1)');

    assert.match(result.text, /^Here are the meeting-notes tools/);
    assert.match(result.text, /Quillo/, 'the second part must be concatenated');
    assert.equal(result.model, 'gemini-3.6-flash');
    // Thinking tokens bill at the output rate, so they belong in `output`.
    assert.deepEqual(result.tokens, { input: 19, output: 168 + 41 });
    assert.equal(result.citations, undefined, 'Gemini generateContent has no native citation array');
  });

  it('perplexity: retrieved results and final references remain separate', async () => {
    const { calls } = stubFetch([{ status: 200, body: fixture('perplexity') }]);
    const result = await perplexity.runPrompt('best AI meeting notes tool?', {
      apiKey: FAKE_KEY,
      model: 'sonar',
      timeoutMs: 1000,
    });

    assert.equal(calls[0].url, 'https://api.perplexity.ai/v1/sonar');
    assert.equal(headerOf(calls[0], 'authorization'), `Bearer ${FAKE_KEY}`);

    assert.match(result.text, /^Based on recent reviews/);
    assert.equal(result.model, 'sonar');
    assert.deepEqual(result.tokens, { input: 26, output: 144 });
    assert.deepEqual(result.sources?.map(({ url, provenance, order }) => [url, provenance, order]), [
      ['https://reviewradar.io/best-ai-meeting-notes', 'search_result', 0],
      ['https://worktools.dev/guides/meeting-notes-2026', 'search_result', 1],
      ['https://notewell.io/customers', 'search_result', 2],
    ]);
    assert.deepEqual(result.answerCitations?.map(({ url, provenance, sourceId }) => [url, provenance, sourceId]), [
      ['https://reviewradar.io/best-ai-meeting-notes', 'explicit_reference', 'search-result:0'],
      ['https://worktools.dev/guides/meeting-notes-2026', 'explicit_reference', 'search-result:1'],
      ['https://notewell.io/customers', 'explicit_reference', 'search-result:2'],
    ]);
    assert.equal(result.searchActions, undefined);
    assert.deepEqual(result.citations, [
      { url: 'https://reviewradar.io/best-ai-meeting-notes' },
      { url: 'https://worktools.dev/guides/meeting-notes-2026' },
      { url: 'https://notewell.io/customers' },
    ]);
  });

  it('perplexity: citations remain explicit when search_results is absent', async () => {
    const payload = fixture('perplexity');
    delete payload.search_results;
    stubFetch([{ status: 200, body: payload }]);
    const result = await perplexity.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
    assert.deepEqual(result.sources, []);
    assert.ok(result.answerCitations?.every(({ sourceId }) => sourceId === null));
    // The fixture's citations array repeats the first URL — dedupe must collapse it.
    assert.deepEqual(result.citations, [
      { url: 'https://reviewradar.io/best-ai-meeting-notes' },
      { url: 'https://worktools.dev/guides/meeting-notes-2026' },
      { url: 'https://notewell.io/customers' },
    ]);
  });

  it('perplexity: two results and one different citation produce two sources and one reference', async () => {
    const payload = fixture('perplexity');
    payload.search_results = payload.search_results.slice(0, 2);
    payload.citations = ['https://reference.example/final'];
    payload.choices[0].message.content = 'Recommended [1].';
    stubFetch([{ status: 200, body: payload }]);
    const result = await perplexity.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
    assert.equal(result.sources?.length, 2);
    assert.deepEqual(result.answerCitations, [{
      url: 'https://reference.example/final', provenance: 'explicit_reference', sourceId: null,
      start: 12, end: 15,
    }]);
    assert.deepEqual(result.citations, [{ url: 'https://reference.example/final' }]);
    assert.equal(result.searchActions, undefined);
  });

  it('perplexity: a failed or truncated choice is not a complete answer', async () => {
    const payload = fixture('perplexity');
    payload.choices[0].finish_reason = 'length';
    stubFetch([{ status: 200, body: payload }]);
    const result = await perplexity.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
    assert.equal(result.answerStatus, 'truncated');
  });

  it('perplexity: invalid numeric references never attach a wrong source', async () => {
    const payload = fixture('perplexity');
    payload.citations = [' https://reviewradar.io/best-ai-meeting-notes ', 'file:///private'];
    payload.choices[0].message.content = 'See [2], then [1], and unsupported [3].';
    payload.choices[0].finish_reason = null;
    stubFetch([{ status: 200, body: payload }]);
    const result = await perplexity.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
    assert.equal(result.answerStatus, 'incomplete');
    assert.deepEqual(result.answerCitations, [{
      url: 'https://reviewradar.io/best-ai-meeting-notes', provenance: 'explicit_reference',
      sourceId: 'search-result:0', start: 14, end: 17,
    }]);
  });

  it('no adapter sends a system prompt or a temperature (§5.1)', async () => {
    const cases = /** @type {[any, unknown][]} */ ([
      [openai, fixture('openai')],
      [anthropic, fixture('anthropic')],
      [gemini, fixture('gemini')],
      [perplexity, fixture('perplexity')],
    ]);
    for (const [adapter, body] of cases) {
      const { calls } = stubFetch([{ status: 200, body }]);
      await adapter.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 });
      const sent = bodyOf(calls[0]);
      assert.equal(sent.temperature, undefined, `${adapter.id} sent a temperature`);
      assert.equal(sent.top_p, undefined, `${adapter.id} sent top_p`);
      assert.equal(sent.system, undefined, `${adapter.id} sent a system prompt`);
      assert.equal(sent.systemInstruction, undefined, `${adapter.id} sent a systemInstruction`);
      if (Array.isArray(sent.messages)) {
        assert.deepEqual(
          sent.messages.map((/** @type {{role: string}} */ m) => m.role),
          ['user'],
          `${adapter.id} sent something other than one user message`,
        );
      }
    }
  });

  it('an unexpected response shape is an "other" error, not a crash', async () => {
    stubFetch([{ status: 200, body: { unexpected: true } }]);
    const err = await openai.runPrompt('q', { apiKey: FAKE_KEY, timeoutMs: 1000 }).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'other');
  });

  it('the registry exposes all four adapters in UI order', () => {
    assert.deepEqual(Object.keys(adapters), ['openai', 'anthropic', 'gemini', 'perplexity']);
    assert.equal(getAdapter('gemini'), gemini);
    assert.equal(getAdapter('nope'), null);

    const cfg = buildConfig({ ANTHROPIC_API_KEY: 'k', PERPLEXITY_API_KEY: 'k' });
    assert.deepEqual(
      enabledAdapters(cfg).map((p) => p.id),
      ['anthropic', 'perplexity'],
    );
  });
});

// ---------------------------------------------------------------------------
// §8.1 — the runner, driven by fake adapters
// ---------------------------------------------------------------------------

/**
 * Minimal analyzer stand-in. Lane B owns the real one (§6); the runner only needs to
 * know that whatever comes back gets written in the same transaction as the response.
 *
 * @param {string} text
 * @param {{id: number, name: string}[]} entities
 * @param {{url: string}[]} [nativeCitations]
 */
function fakeAnalyze(text, entities, nativeCitations = []) {
  const mentions = entities
    .filter((entity) => text.includes(entity.name))
    .map((entity, index) => ({
      entityId: entity.id,
      firstIndex: text.indexOf(entity.name),
      occurrences: 1,
      rank: index + 1,
      recommended: index === 0,
      stance: index === 0 ? 'positive' : 'neutral',
      rule_id: 'fixture_claim',
      evidence_start: text.indexOf(entity.name),
      evidence_end: text.indexOf(entity.name) + entity.name.length,
      review_flags: [],
      snippet: text.slice(0, 40),
    }));
  const citations = nativeCitations.map((citation, index) => ({
    url: citation.url,
    domain: new URL(citation.url).hostname.replace(/^www\./, ''),
    rank: index + 1,
    entityId: null,
  }));
  return { mentions, citations };
}

/**
 * @param {{text?: string, tokens?: {input: number, output: number}, model?: string, citations?: {url:string}[], fail?: () => ProviderError}} [opts]
 */
function fakeAdapter(opts = {}) {
  /** @type {{prompts: string[], inFlight: number, maxInFlight: number}} */
  const stats = { prompts: [], inFlight: 0, maxInFlight: 0 };
  return {
    stats,
    /**
     * @param {string} text
     * @param {{model?: string}} [callOpts]
     */
    async runPrompt(text, callOpts = {}) {
      stats.prompts.push(text);
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((done) => setTimeout(done, 1));
      stats.inFlight -= 1;
      if (opts.fail) throw opts.fail();
      /** @type {import('../core/providers/shared.js').ProviderResult} */
      const result = {
        text: opts.text ?? 'Notewell leads, with Jotta close behind.',
        model: opts.model ?? callOpts.model ?? 'test-model',
        latencyMs: 12,
        tokens: opts.tokens ?? { input: 200, output: 500 },
      };
      if (opts.citations) result.citations = opts.citations;
      return result;
    },
  };
}

/**
 * @param {{prompts?: number}} [opts]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function seedDb(opts = {}) {
  const db = openDb(':memory:');
  const now = isoNow(new Date('2026-07-26T07:00:00Z'));
  dbRun(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, 1, ?)', [
    'Notewell',
    '["Notewell AI"]',
    '["notewell.io"]',
    now,
  ]);
  dbRun(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, 0, ?)', [
    'Jotta',
    '[]',
    '["jotta.app"]',
    now,
  ]);
  dbRun(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', ['best AI meeting notes tool', now]);
  for (let i = 0; i < (opts.prompts ?? 2); i += 1) {
    const promptId = dbRun(db, 'INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(1, ?, ?, 1, ?)', [
      `paraphrase ${i}`,
      'general',
      now,
    ]).lastInsertRowid;
    reviewTrackingPrompt(db, promptId);
  }
  return db;
}

describe('runner (§8.1)', () => {
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('stores Perplexity result sources and final citations in separate evidence tables', async () => {
    dbRun(db, 'UPDATE prompts SET active = 0 WHERE id = 2');
    const payload = fixture('perplexity');
    payload.search_results = payload.search_results.slice(0, 2);
    payload.citations = ['https://reviewradar.io/best-ai-meeting-notes'];
    payload.choices[0].message.content = 'Notewell is recommended [1].';
    stubFetch([{ status: 200, body: payload }]);
    const config = buildConfig({ PERPLEXITY_API_KEY: FAKE_KEY, HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({ db, config, adapters: { perplexity }, analyzeResponse: fakeAnalyze, env: {} });
    assert.equal(summary.okCalls, 1);
    const response = get(db, 'SELECT id, query_metadata_status, search_policy FROM responses LIMIT 1');
    assert.equal(response.query_metadata_status, 'unavailable');
    assert.equal(response.search_policy, 'legacy');
    assert.deepEqual(all(db, 'SELECT url, provenance, original_order FROM source_observations WHERE response_id = ? ORDER BY original_order', [response.id]).map((row) => ({ ...row })), [
      { url: 'https://reviewradar.io/best-ai-meeting-notes', provenance: 'search_result', original_order: 0 },
      { url: 'https://worktools.dev/guides/meeting-notes-2026', provenance: 'search_result', original_order: 1 },
    ]);
    assert.deepEqual(all(db, 'SELECT url, provenance, answer_start, answer_end FROM answer_citations WHERE response_id = ?', [response.id]).map((row) => ({ ...row })), [
      { url: 'https://reviewradar.io/best-ai-meeting-notes', provenance: 'explicit_reference', answer_start: 24, answer_end: 27 },
    ]);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM search_events WHERE response_id = ?', [response.id]).n), 0);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM citations WHERE response_id = ?', [response.id]).n), 1);
  });

  it('fans out prompts × providers × samples and records everything', async () => {
    const config = buildConfig({
      OPENAI_API_KEY: 'k',
      PERPLEXITY_API_KEY: 'k',
      HEARSAY_SAMPLES: '3',
      HEARSAY_CONCURRENCY: '2',
    });
    const openaiFake = fakeAdapter();
    const perplexityFake = fakeAdapter({ citations: [{ url: 'https://reviewradar.io/x' }] });

    /** @type {number[]} */
    const alerted = [];
    const summary = await runPanel({
      db,
      config,
      trigger: 'manual',
      adapters: { openai: openaiFake, perplexity: perplexityFake },
      analyzeResponse: fakeAnalyze,
      evaluateAlerts: (runId) => alerted.push(runId),
      env: {},
    });

    // 2 prompts × 2 providers × 3 samples.
    assert.equal(summary.totalCalls, 12);
    assert.equal(summary.doneCalls, 12);
    assert.equal(summary.okCalls, 12);
    assert.equal(summary.errorCalls, 0);
    assert.equal(summary.status, 'done');
    assert.deepEqual(alerted, [summary.runId], 'alerts.evaluate is called once with the run id');

    const responses = all(db, 'SELECT provider, sample_idx, text, tokens_in, tokens_out, cost_usd FROM responses');
    assert.equal(responses.length, 12);
    assert.equal(new Set(responses.map((r) => r.sample_idx)).size, 3);
    for (const row of responses) {
      assert.equal(row.tokens_in, 200);
      assert.equal(row.tokens_out, 500);
    }

    // Mentions land in the same transaction as their response.
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM mentions')?.n), 24);
    // Native citations only from the provider that has them.
    const citations = all(db, 'SELECT domain FROM citations');
    assert.equal(citations.length, 6);
    assert.ok(citations.every((c) => c.domain === 'reviewradar.io'));

    // Concurrency is honoured across the whole pool, not per provider.
    assert.ok(openaiFake.stats.maxInFlight <= 2);
    assert.ok(perplexityFake.stats.maxInFlight <= 2);

    const runRow = get(db, 'SELECT status, total_calls, done_calls, finished_at FROM runs WHERE id = ?', [summary.runId]);
    assert.equal(runRow?.status, 'done');
    assert.equal(runRow?.total_calls, 12);
    assert.equal(runRow?.done_calls, 12);
    assert.match(String(runRow?.finished_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('persists explicit API surface metadata for every response target', async () => {
    dbRun(db, "UPDATE prompts SET origin = 'user_authored' WHERE id = 1");
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter() },
      analyzeResponse: fakeAnalyze,
      evaluateAlerts: () => {},
      env: {},
    });

    const rows = all(db, `SELECT provider, model, surface, lane, target_status,
      comparability_status, comparability_reason, web_status, prompt_text_snapshot,
      prompt_origin, execution_profile_hash, prompt_envelope_version, comparison_key,
      location_control, artifact_ref, safe_error_code
      FROM responses WHERE run_id = ? ORDER BY prompt_id`, [summary.runId]);
    assert.equal(rows.length, 2);
    assert.deepEqual({ ...rows[0] }, {
      provider: 'openai',
      model: 'gpt-5.6-luna',
      surface: 'openai-api',
      lane: 'tracking',
      target_status: 'completed',
      comparability_status: 'comparable',
      comparability_reason: null,
      web_status: 'not_applicable',
      prompt_text_snapshot: 'paraphrase 0',
      prompt_origin: 'user_authored',
      execution_profile_hash: 'legacy-api-v1',
      prompt_envelope_version: 'api-v1',
      comparison_key: 'legacy:openai:gpt-5.6-luna',
      location_control: 'uncontrolled',
      artifact_ref: null,
      safe_error_code: null,
    });
  });

  it('queues immutable API definitions before calls and keeps them after setup edits', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    /** @type {() => void} */
    let signalStarted = () => {};
    /** @type {() => void} */
    let release = () => {};
    const started = new Promise((resolve) => { signalStarted = () => resolve(undefined); });
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    /** @type {string[]} */
    const sent = [];
    const fake = fakeAdapter();
    const pending = runPanel({
      db, config, analyzeResponse: fakeAnalyze, evaluateAlerts: () => {}, env: {},
      adapters: { openai: { runPrompt: async (text, opts) => {
        sent.push(text);
        signalStarted();
        await gate;
        return fake.runPrompt(text, opts);
      } } },
    });
    await started;
    const queued = all(db, `SELECT r.target_status, r.prompt_text_snapshot,
      r.execution_profile_id, r.benchmark_revision_id, r.search_policy,
      b.snapshot_json FROM responses r
      JOIN benchmark_revisions b ON b.id = r.benchmark_revision_id ORDER BY r.prompt_id`);
    assert.equal(queued.length, 2);
    assert.ok(queued.every((row) => row.target_status === 'queued'));
    assert.ok(queued.every((row) => row.search_policy === 'off'));
    assert.ok(queued.every((row) => row.execution_profile_id && row.benchmark_revision_id));
    assert.match(String(queued[0].snapshot_json), /paraphrase 0/);
    dbRun(db, 'UPDATE prompts SET text = ? WHERE id = 1', ['changed while the run was waiting']);
    release();
    await pending;
    assert.ok(sent.includes('paraphrase 0'));
    assert.equal(String(get(db, 'SELECT prompt_text_snapshot FROM responses WHERE prompt_id = 1')?.prompt_text_snapshot), 'paraphrase 0');
    assert.equal(String(get(db, 'SELECT answer_status FROM responses WHERE prompt_id = 1')?.answer_status), 'complete');
    assert.equal(String(get(db, 'SELECT query_metadata_status FROM responses WHERE prompt_id = 1')?.query_metadata_status), 'not_applicable');
  });

  it('marks queued targets failed when evidence storage rejects an unsafe citation', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({
      db, config, analyzeResponse: fakeAnalyze, evaluateAlerts: () => {}, env: {}, log: () => {},
      adapters: { openai: { runPrompt: async () => ({
        text: 'An answer', model: 'gpt-5.6-luna', latencyMs: 1,
        answerCitations: [{ url: 'file:///etc/passwd', provenance: 'native_annotation',
          sourceId: null, start: null, end: null }],
      }) } },
    });
    assert.equal(summary.status, 'failed');
    assert.equal(summary.errorCalls, 2);
    assert.deepEqual(all(db, `SELECT target_status, answer_status, text, safe_error_code,
      execution_profile_id IS NOT NULL AS has_profile FROM responses ORDER BY id`).map((row) => ({ ...row })), [
      { target_status: 'failed', answer_status: 'complete', text: 'An answer', safe_error_code: 'evidence_invalid', has_profile: 1 },
      { target_status: 'failed', answer_status: 'complete', text: 'An answer', safe_error_code: 'evidence_invalid', has_profile: 1 },
    ]);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM answer_citations')?.n), 0);
  });

  it('computes cost_usd at insert from the priced model, and leaves it null otherwise', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter({ model: 'gpt-5.6-luna' }) },
      analyzeResponse: fakeAnalyze,
      env: {},
    });
    const rows = all(db, 'SELECT id, model, cost_usd, cost_known_subtotal_usd, cost_status, cost_provenance, cost_price_version FROM responses');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.model, 'gpt-5.6-luna');
      assert.ok(Math.abs(Number(row.cost_usd) - (0.00004 + 0.0006)) < 1e-12);
      assert.equal(row.cost_known_subtotal_usd, row.cost_usd);
      assert.equal(row.cost_status, 'known');
      assert.equal(row.cost_provenance, 'computed');
      assert.equal(row.cost_price_version, '2026-09-24-standard');
      assert.deepEqual(all(db, 'SELECT component, cost_status, price_version FROM usage_components WHERE response_id = ? ORDER BY id', [row.id]).map((item) => ({ ...item })), [
        { component: 'input_tokens', cost_status: 'known', price_version: '2026-09-24-standard' },
        { component: 'output_tokens', cost_status: 'known', price_version: '2026-09-24-standard' },
      ]);
    }
    assert.ok(Math.abs((summary.costUsd ?? 0) - 2 * (0.00004 + 0.0006)) < 1e-12);
  });

  it('leaves cost null for a model with no known price', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'private-deployment-1', HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter({ model: 'private-deployment-1' }) },
      analyzeResponse: fakeAnalyze,
      env: {},
    });
    assert.equal(summary.costUsd, null);
    assert.equal(summary.knownSubtotalUsd, null);
    assert.equal(summary.costStatus, 'unavailable');
    assert.equal(summary.attemptedCalls, 2);
    assert.equal(summary.unknownCalls, 2);
    assert.ok(all(db, 'SELECT cost_usd FROM responses').every((r) => r.cost_usd === null));
    assert.ok(all(db, 'SELECT cost_status FROM responses').every((r) => r.cost_status === 'unavailable'));
  });

  it('records usage at the configured override price without a separate runner env', async () => {
    const config = buildConfig({
      OPENAI_API_KEY: 'k', OPENAI_MODEL: 'private-deployment-1', HEARSAY_SAMPLES: '1',
      HEARSAY_PRICE_OPENAI_IN: '3', HEARSAY_PRICE_OPENAI_OUT: '7',
    });
    const summary = await runPanel({
      db, config, adapters: { openai: fakeAdapter() }, analyzeResponse: fakeAnalyze,
    });
    assert.equal(summary.costUsd, 2 * 0.0041);
    const rows = all(db, 'SELECT cost_usd, cost_status, cost_price_version FROM responses');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.cost_usd === 0.0041 && row.cost_status === 'known'));
    assert.ok(rows.every((row) => String(row.cost_price_version).startsWith('override:')));
  });

  it('keeps a failed target and its reported usage cost in the same durable record', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const { calls } = stubFetch([{ status: 500, body: {
      error: { message: 'failed after generation' },
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    } }]);
    const summary = await runPanel({
      db, config, analyzeResponse: fakeAnalyze,
      adapters: { openai: { runPrompt: (text, options) => openai.runPrompt(text, { ...options, apiKey: FAKE_KEY }) } },
    });
    assert.equal(calls.length, 2);
    assert.equal(summary.errorCalls, 2);
    assert.ok(Math.abs(Number(summary.costUsd) - 2 * 0.000068) < 1e-12);
    assert.equal(summary.costStatus, 'known');
    assert.equal(summary.attemptedCalls, 2);
    assert.equal(summary.unknownCalls, 0);
    const rows = all(db, 'SELECT id, target_status, cost_usd, cost_status FROM responses ORDER BY id');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.target_status, 'failed');
      assert.equal(row.cost_status, 'known');
      assert.ok(Math.abs(Number(row.cost_usd) - 0.000068) < 1e-12);
      assert.deepEqual(all(db, 'SELECT component, quantity FROM usage_components WHERE response_id = ? ORDER BY id', [row.id]).map((part) => ({ ...part })), [
        { component: 'input_tokens', quantity: 100 },
        { component: 'output_tokens', quantity: 40 },
      ]);
    }
  });

  it('keeps timeout billing unknown on a failed target after a request was sent', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1', HEARSAY_TIMEOUT_MS: '1000' });
    stubHangingFetch();
    const summary = await runPanel({
      db, config, analyzeResponse: fakeAnalyze,
      adapters: { openai: { runPrompt: (text, options) => openai.runPrompt(text, { ...options, apiKey: FAKE_KEY }) } },
    });
    assert.equal(summary.errorCalls, 2);
    assert.equal(summary.costUsd, null);
    assert.equal(summary.knownSubtotalUsd, null);
    assert.equal(summary.costStatus, 'unavailable');
    assert.equal(summary.unknownCalls, 2);
    const rows = all(db, 'SELECT id, cost_usd, cost_known_subtotal_usd, cost_status FROM responses');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.cost_usd, null);
      assert.equal(row.cost_known_subtotal_usd, null);
      assert.equal(row.cost_status, 'unavailable');
      assert.deepEqual(all(db, 'SELECT component, quantity, cost_status FROM usage_components WHERE response_id = ? ORDER BY id', [row.id]).map((part) => ({ ...part })), [
        { component: 'input_tokens', quantity: null, cost_status: 'unavailable' },
        { component: 'output_tokens', quantity: null, cost_status: 'unavailable' },
      ]);
    }
  });

  it('retains a known subtotal when one attempt has unknown billing', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const adapter = fakeAdapter({ model: 'gpt-5.6-luna' });
    const original = adapter.runPrompt;
    adapter.runPrompt = async (text, options) => ({
      ...await original(text, options),
      billableAttempts: [
        { attempt: 0, continuation: 0, inputTokens: null, outputTokens: null },
        { attempt: 1, continuation: 0, inputTokens: 200, outputTokens: 500 },
      ],
    });
    const summary = await runPanel({ db, config, adapters: { openai: adapter }, analyzeResponse: fakeAnalyze, env: {} });
    assert.equal(summary.costUsd, null);
    assert.ok(Math.abs(Number(summary.knownSubtotalUsd) - 2 * 0.00064) < 1e-12);
    assert.equal(summary.costStatus, 'partial');
    assert.equal(summary.byProvider.openai.costStatus, 'partial');
    const rows = all(db, 'SELECT id, cost_usd, cost_known_subtotal_usd, cost_status FROM responses');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.cost_usd, null);
      assert.ok(Math.abs(Number(row.cost_known_subtotal_usd) - 0.00064) < 1e-12);
      assert.equal(row.cost_status, 'partial');
      assert.deepEqual(all(db, 'SELECT attempt_index, component, cost_status FROM usage_components WHERE response_id = ? ORDER BY id', [row.id]).map((item) => ({ ...item })), [
        { attempt_index: 0, component: 'input_tokens', cost_status: 'unavailable' },
        { attempt_index: 0, component: 'output_tokens', cost_status: 'unavailable' },
        { attempt_index: 1, component: 'input_tokens', cost_status: 'known' },
        { attempt_index: 1, component: 'output_tokens', cost_status: 'known' },
      ]);
    }
  });

  it('retains Anthropic search evidence when a continuation fails', async () => {
    const config = buildConfig({ ANTHROPIC_API_KEY: 'k', HEARSAY_ANTHROPIC_SEARCH_POLICY: 'auto',
      HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({ db, config,
      adapters: { anthropic: { runPrompt: async () => {
        const error = new ProviderError('other', 'Continuation failed', '', [
          { attempt: 0, continuation: 0, inputTokens: 20, outputTokens: 10,
            searchCalls: 1, requestCompleted: true },
          { attempt: 0, continuation: 1, inputTokens: null, outputTokens: null,
            searchCalls: null, requestCompleted: false },
        ]);
        error.partialResult = { text: 'Partial answer', model: 'claude-sonnet-5', latencyMs: 10,
          searchActions: [{ id: 'srvtoolu_fixture', kind: 'search', status: 'completed',
            queryMetadata: 'available', queries: ['best tracker'], observedAt: null,
            providerType: 'web_search' }],
          sources: [{ id: 'source_fixture', url: 'https://example.org/source', title: 'Source',
            provenance: 'search_result', actionId: 'srvtoolu_fixture', order: 0 }],
          answerCitations: [] };
        throw error;
      } } }, analyzeResponse: fakeAnalyze, env: {} });
    assert.equal(summary.errorCalls, 2);
    assert.equal(summary.costStatus, 'partial');
    const row = get(db, 'SELECT id, target_status, comparability_status, evidence_completeness, cost_status FROM responses ORDER BY id LIMIT 1');
    assert.equal(row?.target_status, 'failed');
    assert.equal(row?.comparability_status, 'non_comparable');
    assert.equal(row?.evidence_completeness, 'partial');
    assert.equal(row?.cost_status, 'partial');
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM search_events WHERE response_id = ?', [row?.id])?.n), 1);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM source_observations WHERE response_id = ?', [row?.id])?.n), 1);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM search_queries WHERE response_id = ?', [row?.id])?.n), 1);
    const attempts = all(db, 'SELECT DISTINCT attempt_index, continuation_index FROM usage_components WHERE response_id = ? ORDER BY attempt_index, continuation_index', [row?.id]);
    assert.deepEqual(attempts.map((item) => [item.attempt_index, item.continuation_index]), [[0, 0], [0, 1]]);
    assert.equal(Number(get(db, 'SELECT SUM(quantity) AS n FROM usage_components WHERE response_id = ? AND component = ?', [row?.id, 'input_tokens'])?.n), 20);
  });

  it('leaves cost null when the provider returned no usage counts', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const noUsage = fakeAdapter({ model: 'gpt-5.6-luna' });
    const inner = noUsage.runPrompt.bind(noUsage);
    noUsage.runPrompt = async (text, opts) => {
      const result = await inner(text, opts);
      delete result.tokens;
      return result;
    };
    await runPanel({ db, config, adapters: { openai: noUsage }, analyzeResponse: fakeAnalyze, env: {} });
    const rows = all(db, 'SELECT tokens_in, cost_usd FROM responses');
    assert.ok(rows.every((r) => r.tokens_in === null && r.cost_usd === null));
  });

  it('records failed calls as rows with a classified error, not as a crash', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({
      db,
      config,
      adapters: {
        openai: fakeAdapter(),
        anthropic: fakeAdapter({ fail: () => new ProviderError('timeout', 'No response within 45000 ms') }),
      },
      analyzeResponse: fakeAnalyze,
      env: {},
    });

    assert.equal(summary.status, 'done', 'a partial panel is still usable data');
    assert.equal(summary.okCalls, 2);
    assert.equal(summary.errorCalls, 2);
    const errors = all(db, 'SELECT provider, text, error FROM responses WHERE error IS NOT NULL');
    assert.equal(errors.length, 2);
    for (const row of errors) {
      assert.equal(row.provider, 'anthropic');
      assert.equal(row.text, null);
      assert.match(String(row.error), /^timeout: /);
    }
  });

  it('marks a run failed only when every call errored', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter({ fail: () => new ProviderError('other', 'boom') }) },
      analyzeResponse: fakeAnalyze,
      env: {},
    });
    assert.equal(summary.status, 'failed');
    assert.equal(get(db, 'SELECT status FROM runs WHERE id = ?', [summary.runId])?.status, 'failed');
  });

  it('opens a circuit breaker after 3 consecutive auth errors and skips the rest', async () => {
    // 4 prompts × 1 provider × 2 samples = 8 tasks, all auth failures. The first
    // CIRCUIT_THRESHOLD are attempted; the rest are skipped without a call.
    db.close();
    db = seedDb({ prompts: 4 });
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '2', HEARSAY_CONCURRENCY: '1' });
    const failing = fakeAdapter({ fail: () => new ProviderError('auth', 'Rejected the API key (HTTP 401)') });

    const summary = await runPanel({
      db,
      config,
      adapters: { openai: failing },
      analyzeResponse: fakeAnalyze,
      env: {},
      log: () => {},
    });

    assert.equal(summary.totalCalls, 8);
    assert.equal(summary.doneCalls, 8);
    assert.equal(summary.errorCalls, CIRCUIT_THRESHOLD);
    assert.equal(summary.skippedCalls, 8 - CIRCUIT_THRESHOLD);
    assert.equal(summary.attemptedCalls, CIRCUIT_THRESHOLD);
    assert.equal(summary.unknownCalls, CIRCUIT_THRESHOLD);
    assert.equal(failing.stats.prompts.length, CIRCUIT_THRESHOLD, 'no calls after the breaker opens');
    assert.equal(summary.byProvider.openai.circuitOpen, true);

    const skipped = all(db, 'SELECT error FROM responses WHERE error = ?', [SKIPPED_CIRCUIT]);
    assert.equal(skipped.length, 8 - CIRCUIT_THRESHOLD);
  });

  it('does not open the circuit for timeouts, and a success resets the streak', async () => {
    db.close();
    db = seedDb({ prompts: 4 });
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '2', HEARSAY_CONCURRENCY: '1' });

    let call = 0;
    const flaky = {
      /** @param {string} text */
      async runPrompt(text) {
        call += 1;
        // auth, auth, success, auth, auth, auth → breaker opens on the 6th call only.
        if (call === 3) {
          return { text: 'Notewell wins.', model: 'gpt-5.6-luna', latencyMs: 1, tokens: { input: 1, output: 1 } };
        }
        if (call <= 6) throw new ProviderError('auth', 'Rejected the API key (HTTP 401)');
        throw new ProviderError('timeout', 'No response within 1 ms');
      },
    };

    const summary = await runPanel({
      db,
      config,
      adapters: { openai: flaky },
      analyzeResponse: fakeAnalyze,
      env: {},
      log: () => {},
    });

    assert.equal(summary.okCalls, 1);
    assert.equal(summary.errorCalls, 5, 'calls 1,2,4,5,6 errored before the breaker opened');
    assert.equal(summary.skippedCalls, 2);
  });

  it('refuses a second run while one is in flight (in-process mutex)', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const first = runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter() },
      analyzeResponse: fakeAnalyze,
      env: {},
    });
    await assert.rejects(
      () => runPanel({ db, config, adapters: { openai: fakeAdapter() }, analyzeResponse: fakeAnalyze, env: {} }),
      RunInProgressError,
    );
    await first;
  });

  it('refuses when the database already holds a running row (other process)', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    dbRun(db, "INSERT INTO runs(started_at, trigger, status) VALUES(?, 'cron', 'running')", [isoNow(new Date())]);
    await assert.rejects(
      () => runPanel({ db, config, adapters: { openai: fakeAdapter() }, analyzeResponse: fakeAnalyze, env: {} }),
      RunInProgressError,
    );
  });

  it('atomically refuses a run claimed after the preliminary database check', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const provider = config.providers.openai;
    let injected = false;
    Object.defineProperty(config, 'enabledProviders', {
      configurable: true,
      get() {
        if (!injected) {
          injected = true;
          dbRun(db, "INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?, 'cron', 'running', 1, 0)", [isoNow(new Date())]);
        }
        return [provider];
      },
    });
    await assert.rejects(
      () => runPanel({ db, config, adapters: { openai: fakeAdapter() }, analyzeResponse: fakeAnalyze, env: {} }),
      (error) => error instanceof RunInProgressError && error.runId === 1,
    );
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM runs')?.n), 1);
  });

  it('recovers a stale running row older than two hours, then proceeds', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const threeHoursAgo = isoNow(new Date(Date.now() - 3 * 60 * 60 * 1000));
    dbRun(db, "INSERT INTO runs(started_at, trigger, status) VALUES(?, 'cron', 'running')", [threeHoursAgo]);

    const summary = await runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter() },
      analyzeResponse: fakeAnalyze,
      env: {},
    });

    assert.equal(summary.status, 'done');
    const stale = get(db, 'SELECT status, error FROM runs WHERE id = 1');
    assert.equal(stale?.status, 'failed');
    assert.match(String(stale?.error), /abandoned/);
  });

  it('recoverStaleRuns leaves fresh running rows alone', () => {
    dbRun(db, "INSERT INTO runs(started_at, trigger, status) VALUES(?, 'cron', 'running')", [isoNow(new Date())]);
    assert.equal(recoverStaleRuns(db), 0);
    assert.equal(get(db, 'SELECT status FROM runs WHERE id = 1')?.status, 'running');
  });

  it('marks queued subscription targets from an orphaned run as abandoned failures', () => {
    const runId = Number(dbRun(db, "INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?, 'manual', 'running', 1, 0)", [
      '2026-07-26T00:00:00Z',
    ]).lastInsertRowid);
    dbRun(db, `INSERT INTO responses(
      run_id, prompt_id, provider, surface, model, sample_idx, created_at,
      lane, target_status, comparability_status, web_status, prompt_text_snapshot,
      prompt_origin, location_control
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      runId, 1, 'openai', 'codex-agent', 'default', 0, '2026-07-26T00:00:00Z',
      'tracking', 'queued', 'non_comparable', 'unavailable', 'paraphrase 0',
      'user_authored', 'uncontrolled',
    ]);

    assert.equal(recoverStaleRuns(db, { now: new Date('2026-07-26T03:00:00Z') }), 1);
    assert.deepEqual({ ...get(db, `SELECT target_status, comparability_status,
      comparability_reason, web_status, safe_error_code, error
      FROM responses WHERE run_id = ?`, [runId]) }, {
      target_status: 'failed',
      comparability_status: 'non_comparable',
      comparability_reason: 'abandoned',
      web_status: 'failed',
      safe_error_code: 'abandoned',
      error: 'subscription:abandoned',
    });
  });

  it('refuses to run in demo mode', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_DEMO: '1' });
    await assert.rejects(
      () => runPanel({ db, config, adapters: { openai: fakeAdapter() }, analyzeResponse: fakeAnalyze, env: {} }),
      DemoModeError,
    );
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM runs')?.n), 0, 'a refused run leaves no row behind');
  });

  it('a failing alert evaluator does not lose a completed run', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    /** @type {string[]} */
    const logs = [];
    const summary = await runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter() },
      analyzeResponse: fakeAnalyze,
      evaluateAlerts: () => {
        throw new Error('alerts blew up');
      },
      env: {},
      log: (m) => logs.push(m),
    });
    assert.equal(summary.status, 'done');
    assert.equal(get(db, 'SELECT status FROM runs WHERE id = ?', [summary.runId])?.status, 'done');
    assert.ok(logs.some((m) => /alert evaluation failed/.test(m)));
  });

  it('with no providers enabled, a run is a no-op rather than an error', async () => {
    const config = buildConfig({});
    const summary = await runPanel({ db, config, analyzeResponse: fakeAnalyze, env: {} });
    assert.equal(summary.totalCalls, 0);
    assert.equal(summary.status, 'done');
    assert.equal(summary.costUsd, null);
  });

  it('skips inactive prompts', async () => {
    dbRun(db, 'UPDATE prompts SET active = 0 WHERE id = 1');
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_SAMPLES: '1' });
    const summary = await runPanel({
      db,
      config,
      adapters: { openai: fakeAdapter() },
      analyzeResponse: fakeAnalyze,
      env: {},
    });
    assert.equal(summary.totalCalls, 1);
  });

  it('requires an analyzer — it will not store responses it cannot analyse', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k' });
    await assert.rejects(
      () =>
        runPanel({
          db,
          config,
          adapters: { openai: fakeAdapter() },
          analyzeResponse: /** @type {any} */ (null),
          env: {},
        }),
      TypeError,
    );
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM responses')?.n), 0);
  });
});

// ---------------------------------------------------------------------------
// §8.2 — the scheduler
// ---------------------------------------------------------------------------

describe('scheduler (§8.2)', () => {
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;
  /** @type {{stop: () => void}[]} */
  let started;

  beforeEach(() => {
    db = seedDb();
    started = [];
  });

  afterEach(() => {
    for (const scheduler of started) scheduler.stop();
    db.close();
  });

  /** @param {Parameters<typeof startScheduler>[0]} opts */
  function start(opts) {
    const scheduler = startScheduler(opts);
    started.push(scheduler);
    return scheduler;
  }

  it('formats local date and time without drifting into UTC', () => {
    const at = new Date(2026, 6, 26, 7, 5, 0);
    assert.equal(localDate(at), '2026-07-26');
    assert.equal(localHm(at), '07:05');
  });

  it('shouldRun waits for the hour and then only fires once a day', () => {
    const at = new Date(2026, 6, 26, 7, 5, 0);
    assert.equal(shouldRun({ now: at, runAt: '07:00', lastRunDate: null }), true);
    assert.equal(shouldRun({ now: at, runAt: '07:00', lastRunDate: '2026-07-26' }), false);
    assert.equal(shouldRun({ now: at, runAt: '07:00', lastRunDate: '2026-07-25' }), true);
    assert.equal(shouldRun({ now: at, runAt: '08:00', lastRunDate: null }), false);
  });

  it('fires once past runAt, records the day, then stays quiet', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_RUN_AT: '07:00' });
    /** @type {string[]} */
    const triggers = [];
    let clock = new Date(2026, 6, 26, 6, 59, 0);

    const scheduler = start({
      db,
      config,
      now: () => clock,
      runPanel: async (opts) => {
        triggers.push(opts.trigger);
      },
    });

    assert.equal(await scheduler.tick(), false, 'before runAt: nothing happens');

    clock = new Date(2026, 6, 26, 7, 0, 0);
    assert.equal(await scheduler.tick(), true);
    assert.deepEqual(triggers, ['cron']);
    assert.equal(getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null), '2026-07-26');

    clock = new Date(2026, 6, 26, 9, 30, 0);
    assert.equal(await scheduler.tick(), false, 'already ran today');
    assert.deepEqual(triggers, ['cron']);

    clock = new Date(2026, 6, 27, 7, 1, 0);
    assert.equal(await scheduler.tick(), true, 'next day, next run');
    assert.deepEqual(triggers, ['cron', 'cron']);
  });

  it('preserves the old search-off route on an existing daily schedule', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_RUN_AT: '07:00',
      HEARSAY_OPENAI_SEARCH_POLICY: 'required' });
    let clock = new Date(2026, 6, 26, 6, 59, 0);
    /** @type {import('../core/config.js').Config|null} */
    let receivedConfig = null;
    const scheduler = start({ db, config, now: () => clock,
      runPanel: async (opts) => { receivedConfig = opts.config ?? null; } });
    clock = new Date(2026, 6, 26, 7, 0, 0);
    assert.equal(await scheduler.tick(), true);
    assert.equal(receivedConfig?.apiSearchPolicies.openai, 'off');
    assert.equal(config.apiSearchPolicies.openai, 'required');
  });

  it('keeps Anthropic web search off on an old daily schedule', async () => {
    const config = buildConfig({ ANTHROPIC_API_KEY: 'k', HEARSAY_RUN_AT: '07:00',
      HEARSAY_ANTHROPIC_SEARCH_POLICY: 'auto' });
    let clock = new Date(2026, 6, 26, 6, 59, 0);
    /** @type {import('../core/config.js').Config|null} */
    let receivedConfig = null;
    const scheduler = start({ db, config, now: () => clock,
      runPanel: async (opts) => { receivedConfig = opts.config ?? null; } });
    clock = new Date(2026, 6, 26, 7, 0, 0);
    assert.equal(await scheduler.tick(), true);
    assert.equal(receivedConfig?.apiSearchPolicies.anthropic, 'off');
  });

  it('uses the search route only after recurring consent with a sufficient target ceiling', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_RUN_AT: '07:00',
      HEARSAY_OPENAI_SEARCH_POLICY: 'required' });
    saveApiSearchSchedule(db, config, 999);
    let clock = new Date(2026, 6, 26, 6, 59, 0);
    /** @type {import('../core/config.js').Config|null} */
    let receivedConfig = null;
    const scheduler = start({ db, config, now: () => clock,
      runPanel: async (opts) => { receivedConfig = opts.config ?? config; } });
    clock = new Date(2026, 6, 26, 7, 0, 0);
    assert.equal(await scheduler.tick(), true);
    assert.equal(receivedConfig?.apiSearchPolicies.openai, 'required');
  });

  it('booting after runAt claims the day instead of spending money on the spot', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_RUN_AT: '07:00' });
    let fired = 0;
    const scheduler = start({
      db,
      config,
      now: () => new Date(2026, 6, 26, 23, 10, 0),
      runPanel: async () => {
        fired += 1;
      },
    });
    assert.equal(getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null), '2026-07-26');
    assert.equal(await scheduler.tick(), false);
    assert.equal(fired, 0);
  });

  it('booting before runAt still runs today', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_RUN_AT: '07:00' });
    let clock = new Date(2026, 6, 26, 6, 0, 0);
    let fired = 0;
    const scheduler = start({
      db,
      config,
      now: () => clock,
      runPanel: async () => {
        fired += 1;
      },
    });
    assert.equal(getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null), null);
    clock = new Date(2026, 6, 26, 7, 0, 0);
    assert.equal(await scheduler.tick(), true);
    assert.equal(fired, 1);
  });

  it('a run that already happened today survives a restart', async () => {
    setSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, '2026-07-26');
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_RUN_AT: '07:00' });
    let fired = 0;
    const scheduler = start({
      db,
      config,
      now: () => new Date(2026, 6, 26, 8, 0, 0),
      runPanel: async () => {
        fired += 1;
      },
    });
    assert.equal(await scheduler.tick(), false);
    assert.equal(fired, 0);
  });

  it('a failed run is logged, not thrown, and is not retried until tomorrow', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_RUN_AT: '07:00' });
    /** @type {string[]} */
    const logs = [];
    let clock = new Date(2026, 6, 26, 6, 30, 0);
    const scheduler = start({
      db,
      config,
      now: () => clock,
      log: (m) => logs.push(m),
      runPanel: async () => {
        throw new Error('provider melted');
      },
    });
    clock = new Date(2026, 6, 26, 7, 0, 0);
    assert.equal(await scheduler.tick(), false);
    assert.ok(logs.some((m) => /scheduled run failed/.test(m)));
    assert.equal(getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null), '2026-07-26');
    assert.equal(await scheduler.tick(), false, 'no 60-second retry loop against a broken provider');
  });

  it('is disabled with zero enabled providers (§8.2)', async () => {
    const config = buildConfig({ HEARSAY_RUN_AT: '07:00' }); // no keys at all
    let fired = 0;
    const scheduler = start({
      db,
      config,
      now: () => new Date(2026, 6, 26, 9, 0, 0),
      runPanel: async () => {
        fired += 1;
      },
    });
    assert.equal(scheduler.enabled, false);
    assert.equal(await scheduler.tick(), false);
    assert.equal(fired, 0, 'a keyless install must never write empty done runs on a timer');
    assert.equal(getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null), null);
  });

  it('is disabled in demo mode', async () => {
    const config = buildConfig({ OPENAI_API_KEY: 'k', HEARSAY_DEMO: '1' });
    let fired = 0;
    const scheduler = start({
      db,
      config,
      now: () => new Date(2026, 6, 26, 9, 0, 0),
      runPanel: async () => {
        fired += 1;
      },
    });
    assert.equal(scheduler.enabled, false);
    assert.equal(await scheduler.tick(), false);
    assert.equal(fired, 0);
    assert.equal(getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null), null);
  });
});

// ---------------------------------------------------------------------------
// Guardrail: the only hosts this lane may ever contact (§19.5 #8)
// ---------------------------------------------------------------------------

test('adapters target only the four documented provider hosts', () => {
  const hosts = [openai.endpoint, anthropic.endpoint, gemini.endpointFor('m'), perplexity.endpoint].map(
    (url) => new URL(url).host,
  );
  assert.deepEqual(hosts, [
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'api.perplexity.ai',
  ]);
});
