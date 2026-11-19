/**
 * BYOK DataForSEO adapter, geolocation wiring, OpenAI user_location, and
 * unverified-model opt-in tests. Zero live network calls — all HTTP is mocked via `_setFetch`.
 */

import test, { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CHATGPT_WEB_ENDPOINT,
  DEFAULT_LANGUAGE_CODE,
  DEFAULT_LOCATION_CODE,
  GOOGLE_AIO_ENDPOINT,
  checkDataForSeoHealth,
  runPrompt as runDataForSeo,
} from '../core/providers/dataforseo.js';
import { OPTIONAL_PROVIDERS, adapters, byId, getAdapter } from '../core/providers/index.js';
import { runPrompt as runOpenai, responsesEndpoint } from '../core/providers/openai.js';
import { runPrompt as runAnthropic } from '../core/providers/anthropic.js';
import { runPrompt as runGemini } from '../core/providers/gemini.js';
import { ProviderError, _setFetch, _setSleep } from '../core/providers/shared.js';
import { buildConfig, formatLocationControl } from '../core/config.js';
import { apiExecutionBudget } from '../core/execution-budget.js';
import { get, isoNow, openDb, run as dbRun } from '../core/db.js';
import { reviewTrackingPrompt } from '../core/benchmark-draft.js';
import { runPanel } from '../core/runner.js';

const CREDS = { login: 'demo-user@example.com', password: 'super-secret-password-999' };
const EXPECTED_BASIC = `Basic ${Buffer.from(`${CREDS.login}:${CREDS.password}`, 'utf8').toString('base64')}`;

const openaiSearchFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/openai-responses-search.json', import.meta.url)), 'utf8'),
);
const anthropicSearchFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/anthropic-search.json', import.meta.url)), 'utf8'),
);
const geminiGroundedFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/gemini-grounded.json', import.meta.url)), 'utf8'),
);

/**
 * @param {{status?: number, body?: unknown}[]} replies
 */
function stubFetch(replies) {
  /** @type {{url: string, headers: Record<string, string>, body: any}[]} */
  const calls = [];
  let index = 0;
  _setFetch(async (url, init = {}) => {
    const headers = Object.fromEntries(
      Object.entries(/** @type {Record<string, string>} */ (init.headers ?? {})).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers, body });
    const reply = replies[Math.min(index++, replies.length - 1)];
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

function googleAioPresentPayload() {
  return {
    version: '0.1.20261101',
    status_code: 20000,
    status_message: 'Ok.',
    cost: 0.0025,
    tasks: [{
      id: 'dfs-aio-task-1',
      status_code: 20000,
      status_message: 'Ok.',
      cost: 0.0025,
      result: [{
        keyword: 'best ai meeting notes app',
        location_code: 2840,
        language_code: 'en',
        items: [
          {
            type: 'ai_overview',
            markdown: 'Top AI meeting notes apps include Notewell and Jotta for sales teams.',
            items: [
              {
                type: 'ai_overview_element',
                title: 'Notewell',
                text: 'Strong CRM sync and accurate action items.',
                references: [
                  { url: 'https://reviewradar.io/meeting-notes', title: 'ReviewRadar Guide' },
                ],
              },
            ],
            references: [
              { url: 'https://notewell.io/features', title: 'Notewell Features' },
              { url: 'https://reviewradar.io/meeting-notes', title: 'ReviewRadar Guide' },
            ],
          },
          {
            type: 'organic',
            rank_group: 1,
            url: 'https://reviewradar.io/meeting-notes',
            title: 'Best AI Meeting Notes Apps 2026',
            description: 'Hands-on benchmark of top AI meeting recorders.',
          },
          {
            type: 'organic',
            rank_group: 2,
            url: 'https://jotta.app/compare',
            title: 'Jotta vs Competitors',
            description: 'Compare Jotta meeting summaries.',
          },
        ],
      }],
    }],
  };
}

function googleAioAbsentPayload() {
  return {
    status_code: 20000,
    status_message: 'Ok.',
    cost: 0.002,
    tasks: [{
      id: 'dfs-aio-task-empty',
      status_code: 20000,
      status_message: 'Ok.',
      cost: 0.002,
      result: [{
        keyword: 'notewell login',
        items: [
          {
            type: 'organic',
            rank_group: 1,
            url: 'https://notewell.io/login',
            title: 'Notewell Login',
            description: 'Sign in to your Notewell workspace.',
          },
        ],
      }],
    }],
  };
}

function chatgptScraperPayload() {
  return {
    status_code: 20000,
    status_message: 'Ok.',
    cost: 0.006,
    tasks: [{
      id: 'dfs-cgpt-task-1',
      status_code: 20000,
      status_message: 'Ok.',
      cost: 0.006,
      result: [{
        model: 'gpt-5-web',
        markdown: 'For small sales teams, **Notewell** is widely recommended alongside **Jotta**.',
        fan_out_queries: ['best ai meeting notes for sales teams 2026', 'notewell vs jotta reviews'],
        search_results: [
          {
            url: 'https://reviewradar.io/best-meeting-notes',
            title: 'ReviewRadar 2026 Roundup',
            description: 'Independent review of meeting assistants.',
          },
          {
            url: 'https://jotta.app/pricing',
            title: 'Jotta Pricing',
            description: 'Plans for growing teams.',
          },
        ],
        sources: [
          {
            url: 'https://notewell.io/sales',
            title: 'Notewell for Sales',
            snippet: 'Automatic CRM notes and call recaps.',
          },
          {
            url: 'https://reviewradar.io/best-meeting-notes',
            title: 'ReviewRadar 2026 Roundup',
          },
        ],
        citations: [
          { url: 'https://notewell.io/sales' },
          { url: 'https://reviewradar.io/best-meeting-notes' },
        ],
      }],
    }],
  };
}

afterEach(() => {
  _setFetch();
  _setSleep();
});

describe('DataForSEO BYOK adapter', () => {
  it('google-aio: extracts AI Overview text, references as answerCitations, organic SERP as sources, and task cost', async () => {
    const calls = stubFetch([{ body: googleAioPresentPayload() }]);
    const result = await runDataForSeo('best ai meeting notes app', {
      ...CREDS,
      mode: 'google-aio',
      timeoutMs: 2000,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GOOGLE_AIO_ENDPOINT);
    assert.equal(calls[0].headers.authorization, EXPECTED_BASIC);
    assert.deepEqual(calls[0].body, [{
      keyword: 'best ai meeting notes app',
      location_code: DEFAULT_LOCATION_CODE,
      language_code: DEFAULT_LANGUAGE_CODE,
      load_async_ai_overview: true,
      expand_ai_overview: true,
    }]);

    assert.equal(result.mode, 'google-aio');
    assert.equal(result.answerStatus, 'complete');
    assert.equal(result.noAioPresent, false);
    assert.match(result.text, /Notewell and Jotta/);
    assert.equal(result.locationControl, 'location_code:2840');
    assert.equal(result.languageCode, 'en');
    assert.equal(result.costUsd, 0.0025);
    assert.equal(result.providerReportedChargeUsd, 0.0025);

    assert.equal(result.searchActions?.length, 1);
    assert.deepEqual(result.searchActions?.[0].queries, ['best ai meeting notes app']);
    assert.deepEqual(
      result.sources?.map(({ url, provenance, order }) => [url, provenance, order]),
      [
        ['https://reviewradar.io/meeting-notes', 'search_result', 0],
        ['https://jotta.app/compare', 'search_result', 1],
      ],
    );
    assert.deepEqual(
      result.answerCitations?.map(({ url, provenance, sourceId }) => [url, provenance, sourceId]),
      [
        ['https://notewell.io/features', 'native_annotation', null],
        ['https://reviewradar.io/meeting-notes', 'native_annotation', 'dataforseo:google-aio:dfs-aio-task-1:organic:0'],
      ],
    );
    assert.deepEqual(result.citations, [
      { url: 'https://notewell.io/features' },
      { url: 'https://reviewradar.io/meeting-notes' },
    ]);
    assert.equal(result.billableAttempts?.[0].searchCalls, 1);
  });

  it('google-aio: extracts text from nested ai_overview items when markdown/text are absent', async () => {
    const payload = googleAioPresentPayload();
    delete payload.tasks[0].result[0].items[0].markdown;
    stubFetch([{ body: payload }]);
    const result = await runDataForSeo('best ai meeting notes app', { ...CREDS, mode: 'google-aio' });
    assert.equal(result.answerStatus, 'complete');
    assert.equal(result.noAioPresent, false);
    assert.match(result.text, /Notewell: Strong CRM sync/);
  });

  it('google-aio: cleanly reports answerStatus=empty and noAioPresent=true when no AI Overview triggered', async () => {
    stubFetch([{ body: googleAioAbsentPayload() }]);
    const result = await runDataForSeo('notewell login', { ...CREDS, mode: 'google-aio' });

    assert.equal(result.text, '');
    assert.equal(result.answerStatus, 'empty');
    assert.equal(result.noAioPresent, true);
    assert.deepEqual(result.answerCitations, []);
    assert.deepEqual(result.citations, []);
    assert.equal(result.sources?.length, 1);
    assert.equal(result.sources?.[0].url, 'https://notewell.io/login');
    assert.equal(result.sources?.[0].provenance, 'search_result');
    assert.equal(result.costUsd, 0.002);
  });

  it('google-aio: handles DataForSEO 40102 (No Search Results) cleanly as empty/noAioPresent', async () => {
    stubFetch([{
      body: {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.002,
        tasks: [{ id: 't-empty', status_code: 40102, status_message: 'No Search Results.', cost: 0.002, result: null }],
      },
    }]);
    const result = await runDataForSeo('obscure query', { ...CREDS, mode: 'google-aio' });
    assert.equal(result.answerStatus, 'empty');
    assert.equal(result.noAioPresent, true);
    assert.deepEqual(result.sources, []);
  });

  it('chatgpt-web: extracts consumer-UI response, sources, citations, fan-out queries, and cost', async () => {
    const calls = stubFetch([{ body: chatgptScraperPayload() }]);
    const result = await runDataForSeo('best ai meeting notes for sales?', {
      ...CREDS,
      mode: 'chatgpt-web',
      locationCode: 2826,
      languageCode: 'en-GB',
      timeoutMs: 2000,
    });

    assert.equal(calls[0].url, CHATGPT_WEB_ENDPOINT);
    assert.equal(calls[0].headers.authorization, EXPECTED_BASIC);
    assert.deepEqual(calls[0].body, [{
      prompt: 'best ai meeting notes for sales?',
      location_code: 2826,
      language_code: 'en-GB',
      web_search: true,
    }]);

    assert.equal(result.mode, 'chatgpt-web');
    assert.equal(result.model, 'gpt-5-web');
    assert.equal(result.answerStatus, 'complete');
    assert.match(result.text, /\*\*Notewell\*\*/);
    assert.equal(result.locationControl, 'location_code:2826');
    assert.equal(result.languageCode, 'en-GB');
    assert.equal(result.costUsd, 0.006);
    assert.equal(result.providerReportedChargeUsd, 0.006);

    assert.equal(result.searchActions?.length, 1);
    assert.deepEqual(result.searchActions?.[0].queries, [
      'best ai meeting notes for sales teams 2026',
      'notewell vs jotta reviews',
    ]);
    assert.equal(result.searchActions?.[0].queryMetadata, 'available');

    assert.equal(result.sources?.filter((s) => s.provenance === 'search_result').length, 2);
    assert.equal(result.sources?.filter((s) => s.provenance === 'reported_source').length, 2);
    assert.deepEqual(
      result.answerCitations?.map(({ url, provenance }) => [url, provenance]),
      [
        ['https://notewell.io/sales', 'native_annotation'],
        ['https://reviewradar.io/best-meeting-notes', 'native_annotation'],
      ],
    );
    assert.ok(result.answerCitations?.every((c) => c.sourceId !== null));
  });

  it('classifies HTTP 401 as auth error and never leaks Basic credentials or password', async () => {
    const basicRaw = Buffer.from(`${CREDS.login}:${CREDS.password}`, 'utf8').toString('base64');
    stubFetch([{
      status: 401,
      body: {
        status_code: 40100,
        status_message: `Unauthorized for Basic ${basicRaw} (${CREDS.login} / ${CREDS.password})`,
      },
    }]);
    const err = await runDataForSeo('q', { ...CREDS, mode: 'google-aio' }).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'auth');
    const stored = err.toStorage();
    assert.doesNotMatch(stored, new RegExp(CREDS.password));
    assert.doesNotMatch(stored, new RegExp(CREDS.login));
    assert.doesNotMatch(stored, new RegExp(basicRaw.replace(/[+/=]/g, '\\$&')));
  });

  it('fails fast with auth error when credentials are missing without making any HTTP call', async () => {
    const calls = stubFetch([{ body: googleAioPresentPayload() }]);
    const err = await runDataForSeo('q', { login: '', password: '', mode: 'google-aio' }).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'auth');
    assert.equal(calls.length, 0);
  });

  it('health canary verifies credentials, shape, and cost cleanly on both modes', async () => {
    const okCalls = stubFetch([{ body: googleAioPresentPayload() }]);
    const healthy = await checkDataForSeoHealth({
      ...CREDS,
      mode: 'google-aio',
      locationCode: 2826,
      languageCode: 'en',
    });
    assert.equal(okCalls.length, 1);
    assert.equal(okCalls[0].body[0].location_code, 2826);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.mode, 'google-aio');
    assert.equal(healthy.statusCode, 200);
    assert.equal(healthy.costUsd, 0.0025);
    assert.equal(healthy.error, null);
    assert.equal(typeof healthy.latencyMs, 'number');

    const failCalls = stubFetch([{
      status: 401,
      body: { status_code: 40100, status_message: `Bad password ${CREDS.password}` },
    }]);
    const authFail = await checkDataForSeoHealth({ ...CREDS, mode: 'chatgpt-web' });
    assert.equal(failCalls.length, 1);
    assert.equal(authFail.ok, false);
    assert.equal(authFail.mode, 'chatgpt-web');
    assert.equal(authFail.statusCode, 401);
    assert.equal(authFail.costUsd, null);
    assert.ok(authFail.error);
    assert.doesNotMatch(authFail.error, new RegExp(CREDS.password));

    const missingCalls = stubFetch([{ body: googleAioPresentPayload() }]);
    const missing = await checkDataForSeoHealth({ login: '', password: '', mode: 'google-aio' });
    assert.equal(missing.ok, false);
    assert.equal(missing.statusCode, null);
    assert.equal(missingCalls.length, 0);
  });

  it('registers DataForSEO under OPTIONAL_PROVIDERS / getAdapter without altering core 4-provider adapters', async () => {
    assert.deepEqual(Object.keys(adapters), ['openai', 'anthropic', 'gemini', 'perplexity']);
    assert.ok(OPTIONAL_PROVIDERS['dataforseo-aio']);
    assert.ok(OPTIONAL_PROVIDERS['dataforseo-chatgpt']);
    assert.equal(getAdapter('dataforseo-aio'), OPTIONAL_PROVIDERS['dataforseo-aio']);
    assert.equal(byId('dataforseo-chatgpt'), OPTIONAL_PROVIDERS['dataforseo-chatgpt']);

    const calls = stubFetch([{ body: chatgptScraperPayload() }]);
    const res = await getAdapter('dataforseo-chatgpt')?.runPrompt('compare tools', {
      apiKey: `${CREDS.login}:${CREDS.password}`,
      locationCode: 2276,
    });
    assert.equal(calls[0].url, CHATGPT_WEB_ENDPOINT);
    assert.equal(calls[0].body[0].location_code, 2276);
    assert.match(res?.text ?? '', /Notewell/);
  });
});

describe('geolocation wiring & OpenAI user_location', () => {
  it('parses geolocation env vars and formats location_control cleanly', () => {
    const unset = buildConfig({});
    assert.equal(unset.locationCode, null);
    assert.equal(unset.locationCountry, null);
    assert.equal(unset.locationCity, null);
    assert.equal(unset.languageCode, null);
    assert.equal(formatLocationControl(unset), 'uncontrolled');

    const cityCfg = buildConfig({
      HEARSAY_LOCATION_COUNTRY: 'us',
      HEARSAY_LOCATION_CITY: 'London',
      HEARSAY_LANGUAGE_CODE: 'en',
    });
    assert.equal(cityCfg.locationCountry, 'US');
    assert.equal(cityCfg.locationCity, 'London');
    assert.equal(cityCfg.languageCode, 'en');
    assert.equal(formatLocationControl(cityCfg), 'country:US;city:London');

    const codeCfg = buildConfig({ HEARSAY_LOCATION_CODE: '2840' });
    assert.equal(codeCfg.locationCode, 2840);
    assert.equal(formatLocationControl(codeCfg), 'location_code:2840');
  });

  it('includes approximate user_location on OpenAI web_search only when configured', async () => {
    const calls = stubFetch([{ body: openaiSearchFixture }, { body: openaiSearchFixture }]);

    await runOpenai('best cameras?', {
      apiKey: 'sk-fixture-000',
      model: 'gpt-5.6-luna',
      searchPolicy: 'required',
      timeoutMs: 1000,
      userLocation: { country: 'GB', city: 'London', region: 'England' },
    });
    assert.equal(calls[0].url, responsesEndpoint);
    assert.deepEqual(calls[0].body.tools, [{
      type: 'web_search',
      user_location: {
        type: 'approximate',
        country: 'GB',
        city: 'London',
        region: 'England',
      },
    }]);

    await runOpenai('best cameras?', {
      apiKey: 'sk-fixture-000',
      model: 'gpt-5.6-luna',
      searchPolicy: 'required',
      timeoutMs: 1000,
    });
    assert.deepEqual(calls[1].body.tools, [{ type: 'web_search' }]);
  });

  it('runner persists configured location_control and forwards userLocation to OpenAI', async () => {
    const db = openDb(':memory:');
    try {
      const now = isoNow(new Date('2026-11-10T10:00:00Z'));
      dbRun(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, 1, ?)', [
        'Acme', '[]', '["acme.io"]', now,
      ]);
      dbRun(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', ['best camera', now]);
      const promptId = dbRun(
        db,
        'INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(1, ?, ?, 1, ?)',
        ['Which camera should I buy?', 'general', now],
      ).lastInsertRowid;
      reviewTrackingPrompt(db, promptId);

      const calls = stubFetch([{ body: openaiSearchFixture }]);
      const cfg = buildConfig({
        OPENAI_API_KEY: 'sk-fixture-000',
        HEARSAY_OPENAI_SEARCH_POLICY: 'required',
        HEARSAY_SAMPLES: '1',
        HEARSAY_LOCATION_COUNTRY: 'US',
        HEARSAY_LOCATION_CITY: 'London',
      });
      const summary = await runPanel({
        db,
        config: cfg,
        adapters: { openai: { runPrompt: runOpenai } },
        analyzeResponse: () => ({ mentions: [], citations: [] }),
        evaluateAlerts: () => {},
        env: {},
        log: () => {},
      });
      assert.equal(summary.okCalls, 1);
      assert.deepEqual(calls[0].body.tools, [{
        type: 'web_search',
        user_location: { type: 'approximate', country: 'US', city: 'London' },
      }]);
      const row = get(db, 'SELECT location_control FROM responses WHERE run_id = ?', [summary.runId]);
      assert.equal(row?.location_control, 'country:US;city:London');
    } finally {
      db.close();
    }
  });
});

describe('allowUnverifiedModels opt-in', () => {
  it('keeps strict RangeError when unset and allows unvalidated search models with warning when opted in', async () => {
    assert.throws(
      () => buildConfig({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-6-preview', HEARSAY_OPENAI_SEARCH_POLICY: 'required' }),
      RangeError,
    );
    assert.throws(
      () => buildConfig({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-sonnet-6', HEARSAY_ANTHROPIC_SEARCH_POLICY: 'auto' }),
      RangeError,
    );
    assert.throws(
      () => apiExecutionBudget(
        buildConfig({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-4-flash', HEARSAY_GEMINI_SEARCH_POLICY: 'auto' }),
        'gemini',
      ),
      RangeError,
    );

    const optInCfg = buildConfig({
      OPENAI_API_KEY: 'sk-fixture-000',
      OPENAI_MODEL: 'gpt-6-preview',
      HEARSAY_OPENAI_SEARCH_POLICY: 'required',
      ANTHROPIC_API_KEY: 'sk-ant-fixture-000',
      ANTHROPIC_MODEL: 'claude-sonnet-6',
      HEARSAY_ANTHROPIC_SEARCH_POLICY: 'auto',
      GEMINI_API_KEY: 'AIzaFixtureKey0000000',
      GEMINI_MODEL: 'gemini-4-flash',
      HEARSAY_GEMINI_SEARCH_POLICY: 'auto',
      HEARSAY_ALLOW_UNVERIFIED_MODELS: '1',
    });
    assert.equal(optInCfg.allowUnverifiedModels, true);

    const openaiBudget = apiExecutionBudget(optInCfg, 'openai');
    const anthropicBudget = apiExecutionBudget(optInCfg, 'anthropic');
    const geminiBudget = apiExecutionBudget(optInCfg, 'gemini');
    assert.equal(openaiBudget.unverifiedModelWarning, true);
    assert.equal(anthropicBudget.unverifiedModelWarning, true);
    assert.equal(geminiBudget.unverifiedModelWarning, true);

    const validatedCfg = buildConfig({
      OPENAI_API_KEY: 'sk-fixture-000',
      HEARSAY_OPENAI_SEARCH_POLICY: 'required',
      HEARSAY_ALLOW_UNVERIFIED_MODELS: '1',
    });
    assert.equal(apiExecutionBudget(validatedCfg, 'openai').unverifiedModelWarning, false);

    stubFetch([
      { body: openaiSearchFixture },
      { body: anthropicSearchFixture },
      { body: geminiGroundedFixture },
    ]);
    const oRes = await runOpenai('q', {
      apiKey: 'sk-fixture-000',
      model: 'gpt-6-preview',
      searchPolicy: 'required',
      allowUnverifiedModels: true,
      timeoutMs: 1000,
    });
    assert.equal(oRes.answerStatus, 'complete');

    const aRes = await runAnthropic('q', {
      apiKey: 'sk-ant-fixture-000',
      model: 'claude-sonnet-6',
      searchPolicy: 'auto',
      allowUnverifiedModels: true,
      timeoutMs: 1000,
    });
    assert.equal(aRes.answerStatus, 'complete');

    const gRes = await runGemini('q', {
      apiKey: 'AIzaFixtureKey0000000',
      model: 'gemini-4-flash',
      searchPolicy: 'auto',
      allowUnverifiedModels: true,
      timeoutMs: 1000,
    });
    assert.equal(gRes.answerStatus, 'complete');
  });
});
