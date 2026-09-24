/**
 * Cost table and estimator (§4.3, §15).
 *
 * The rule under test throughout: Hearsay reports a number it can defend, or it reports
 * nothing. An unknown model must produce `null`, never a plausible-looking guess.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESTIMATE_TOKENS,
  MODEL_PRICES,
  PRICE_TABLE_VERSION,
  SEARCH_TOOL_PRICES,
  costUsd,
  estimateRunCost,
  formatUsd,
  priceFor,
  priceUsage,
} from '../core/cost.js';
import { PROVIDER_IDS, buildConfig } from '../core/config.js';

/** Tests pass their own env record so nothing depends on the developer's shell. */
const NO_ENV = /** @type {Record<string, string|undefined>} */ ({});

test('price table covers every default model in the provider registry', () => {
  assert.equal(PRICE_TABLE_VERSION, '2026-09-24-standard');
  const config = buildConfig({});
  for (const id of PROVIDER_IDS) {
    const model = config.providers[id].model;
    const price = priceFor(id, model, NO_ENV);
    assert.ok(price, `no price for the default ${id} model "${model}"`);
    assert.equal(price.provider, id);
    assert.ok(price.inputPerMTok > 0, `${id} input price must be positive`);
    assert.ok(price.outputPerMTok > 0, `${id} output price must be positive`);
  }
});

test('an unknown model has no price — we never guess one', () => {
  assert.equal(priceFor('openai', 'gpt-未来-9000', NO_ENV), null);
  assert.equal(priceFor('gemini', 'gpt-5.6-luna', NO_ENV), null);
  assert.equal(
    costUsd({ provider: 'openai', model: 'gpt-未来-9000', tokensIn: 1000, tokensOut: 1000 }, NO_ENV),
    null,
  );
});

test('env override prices a model the table has never heard of', () => {
  const env = { HEARSAY_PRICE_OPENAI_IN: '0.25', HEARSAY_PRICE_OPENAI_OUT: '2' };
  const price = priceFor('openai', 'some-private-deployment', env);
  assert.deepEqual(price, {
    provider: 'openai',
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    requestUsd: 0,
  });
  // 1M in at $0.25 + 1M out at $2.
  assert.equal(costUsd({ provider: 'openai', model: 'some-private-deployment', tokensIn: 1e6, tokensOut: 1e6 }, env), 2.25);
});

test('env override beats the built-in table', () => {
  const env = { HEARSAY_PRICE_ANTHROPIC_IN: '2', HEARSAY_PRICE_ANTHROPIC_OUT: '10' };
  const price = priceFor('anthropic', 'claude-sonnet-5', env);
  assert.equal(price?.inputPerMTok, 2);
  assert.equal(price?.outputPerMTok, 10);
});

test('half an override is not an override', () => {
  // Only _IN set: fall back to the table rather than pricing output at zero.
  const price = priceFor('gemini', 'gemini-3.6-flash', { HEARSAY_PRICE_GEMINI_IN: '0.10' });
  assert.equal(price?.inputPerMTok, MODEL_PRICES['gemini-3.6-flash'].inputPerMTok);
  // Only _IN set on an unknown model: still unpriced.
  assert.equal(priceFor('gemini', 'gemini-mystery', { HEARSAY_PRICE_GEMINI_IN: '0.10' }), null);
});

test('a garbage override is ignored rather than trusted', () => {
  const env = { HEARSAY_PRICE_OPENAI_IN: 'free', HEARSAY_PRICE_OPENAI_OUT: '-3' };
  const price = priceFor('openai', 'gpt-5.6-luna', env);
  assert.equal(price?.inputPerMTok, MODEL_PRICES['gpt-5.6-luna'].inputPerMTok);
  assert.equal(price?.outputPerMTok, MODEL_PRICES['gpt-5.6-luna'].outputPerMTok);
});

test('costUsd arithmetic, per 1M tokens', () => {
  // gpt-5.6-luna: $0.20 in / $1.20 out per MTok.
  const cost = costUsd({ provider: 'openai', model: 'gpt-5.6-luna', tokensIn: 200, tokensOut: 500 }, NO_ENV);
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - (0.00004 + 0.0006)) < 1e-12, `got ${cost}`);
});

test('costUsd includes Perplexity’s per-request search fee', () => {
  // sonar: $1/$1 per MTok + $0.005 per request. At panel prompt sizes the request fee is
  // ~90% of the bill, so dropping it would understate Perplexity spend by an order of
  // magnitude — exactly the kind of flattering-but-wrong number §4.3 forbids.
  const cost = costUsd({ provider: 'perplexity', model: 'sonar', tokensIn: 200, tokensOut: 500 }, NO_ENV);
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - (0.0002 + 0.0005 + 0.005)) < 1e-12, `got ${cost}`);
});

test('missing usage counts mean no cost, not a zero cost', () => {
  assert.equal(costUsd({ provider: 'openai', model: 'gpt-5.6-luna', tokensIn: null, tokensOut: 500 }, NO_ENV), null);
  assert.equal(costUsd({ provider: 'openai', model: 'gpt-5.6-luna', tokensIn: 200, tokensOut: undefined }, NO_ENV), null);
});

test('search pricing uses reported billable calls and leaves missing usage partial', () => {
  assert.equal(SEARCH_TOOL_PRICES.openai, 0.01);
  const attempt = { attempt: 0, continuation: 0, inputTokens: 200, outputTokens: 500 };
  const unknown = priceUsage({ provider: 'openai', model: 'gpt-5.6-luna', targetId: '7',
    searchPolicy: 'required', attempts: [attempt] }, NO_ENV);
  assert.equal(unknown.costStatus, 'partial');
  assert.equal(unknown.computedCostUsd, null);
  assert.ok(Math.abs(Number(unknown.knownSubtotalUsd) - 0.00064) < 1e-12);
  assert.deepEqual(unknown.components.map((component) => [component.component, component.quantity, component.costStatus]), [
    ['input_tokens', 200, 'known'], ['output_tokens', 500, 'known'], ['web_search', null, 'unavailable'],
  ]);
  const reported = priceUsage({ provider: 'openai', model: 'gpt-5.6-luna', targetId: '7',
    searchPolicy: 'required', attempts: [{ ...attempt, searchCalls: 2 }] }, NO_ENV);
  assert.equal(reported.costStatus, 'known');
  assert.ok(Math.abs(Number(reported.computedCostUsd) - 0.02064) < 1e-12);
});

test('a timeout attempt with unknown billing does not turn a later success into a complete cost', () => {
  const result = priceUsage({ provider: 'anthropic', model: 'claude-sonnet-5', targetId: '9',
    searchPolicy: 'auto', attempts: [
      { attempt: 0, continuation: 0, inputTokens: null, outputTokens: null, searchCalls: null },
      { attempt: 1, continuation: 0, inputTokens: 100, outputTokens: 200, searchCalls: 0 },
    ] }, NO_ENV);
  assert.equal(result.components.length, 6);
  assert.equal(result.costStatus, 'partial');
  assert.equal(result.computedCostUsd, null);
  assert.ok(Math.abs(Number(result.knownSubtotalUsd) - 0.0022) < 1e-12);
});

test('Sonar request fee is one request component, independent of result URLs', () => {
  const result = priceUsage({ provider: 'perplexity', model: 'sonar', targetId: '10',
    searchPolicy: 'legacy', attempts: [{ attempt: 0, continuation: 0, inputTokens: 200,
      outputTokens: 500, requestCompleted: true }] }, NO_ENV);
  assert.deepEqual(result.components.map((component) => [component.component, component.quantity]), [
    ['input_tokens', 200], ['output_tokens', 500], ['sonar_request', 1],
  ]);
  assert.ok(Math.abs(Number(result.computedCostUsd) - 0.0057) < 1e-12);
  assert.ok(result.components.every((component) => component.priceVersion === PRICE_TABLE_VERSION));
});

test('billable search counts reject fractional or negative values', () => {
  for (const searchCalls of [-1, 0.5]) {
    assert.throws(() => priceUsage({ provider: 'openai', model: 'gpt-5.6-luna', targetId: '11',
      searchPolicy: 'auto', attempts: [{ attempt: 0, continuation: 0, inputTokens: 1,
        outputTokens: 1, searchCalls }] }, NO_ENV), /Reported search calls/);
  }
});

test('estimateRunCost multiplies prompts × providers × samples', () => {
  const estimate = estimateRunCost(
    {
      promptCount: 12,
      samples: 3,
      providers: [
        { id: 'openai', model: 'gpt-5.6-luna' },
        { id: 'perplexity', model: 'sonar' },
      ],
    },
    NO_ENV,
  );

  assert.equal(estimate.calls, 72);
  assert.deepEqual(estimate.assumedTokens, ESTIMATE_TOKENS);
  assert.deepEqual(estimate.unpriced, []);
  assert.equal(estimate.costStatus, 'known');

  const perCallOpenai = 0.00004 + 0.0006;
  const perCallPerplexity = 0.0002 + 0.0005 + 0.005;
  assert.equal(estimate.perProvider.length, 2);
  assert.equal(estimate.perProvider[0].calls, 36);
  assert.ok(Math.abs((estimate.perProvider[0].estUsd ?? 0) - perCallOpenai * 36) < 1e-12);
  assert.ok(Math.abs((estimate.perProvider[1].estUsd ?? 0) - perCallPerplexity * 36) < 1e-12);
  assert.ok(Math.abs((estimate.estUsd ?? 0) - (perCallOpenai + perCallPerplexity) * 36) < 1e-12);
});

test('search estimate includes one tool call per target and labels the forecast unbounded', () => {
  const estimate = estimateRunCost({ promptCount: 2, samples: 1,
    providers: [{ id: 'openai', model: 'gpt-5.6-luna', searchPolicy: 'required' }] }, NO_ENV);
  assert.equal(estimate.hasUnboundedSearch, true);
  assert.equal(estimate.perProvider[0].assumedSearchCalls, 2);
  assert.equal(estimate.perProvider[0].searchToolUsd, 0.02);
  assert.ok(Math.abs(Number(estimate.estUsd) - 0.02128) < 1e-12);
});

test('bounded Anthropic search includes its tool-call forecast without claiming an internal unlimited route', () => {
  const estimate = estimateRunCost({ promptCount: 1, samples: 1,
    providers: [{ id: 'anthropic', model: 'claude-sonnet-5', searchPolicy: 'auto',
      searchCallLimitEnforced: true }] }, NO_ENV);
  assert.equal(estimate.hasSearch, true);
  assert.equal(estimate.hasUnboundedSearch, false);
  assert.equal(estimate.perProvider[0].searchToolUsd, 0.01);
  assert.ok(Math.abs(Number(estimate.estUsd) - 0.0154) < 1e-12);
});

test('estimateRunCost reports unpriced providers instead of hiding them in the total', () => {
  const estimate = estimateRunCost(
    {
      promptCount: 2,
      samples: 1,
      providers: [
        { id: 'openai', model: 'gpt-5.6-luna' },
        { id: 'gemini', model: 'gemini-something-new' },
      ],
    },
    NO_ENV,
  );

  assert.equal(estimate.calls, 4);
  assert.deepEqual(estimate.unpriced, ['gemini']);
  assert.equal(estimate.perProvider[1].estUsd, null);
  assert.equal(estimate.estUsd, null);
  assert.equal(estimate.costStatus, 'partial');
  assert.ok(Math.abs((estimate.knownSubtotalUsd ?? 0) - (0.00004 + 0.0006) * 2) < 1e-12);
});

test('estimateRunCost with nothing priced returns null, not zero', () => {
  const estimate = estimateRunCost(
    { promptCount: 5, samples: 2, providers: [{ id: 'openai', model: 'mystery-model' }] },
    NO_ENV,
  );
  assert.equal(estimate.calls, 10);
  assert.equal(estimate.estUsd, null);
});

test('estimateRunCost with no enabled providers costs nothing and claims nothing', () => {
  const estimate = estimateRunCost({ promptCount: 12, samples: 3, providers: [] }, NO_ENV);
  assert.equal(estimate.calls, 0);
  assert.equal(estimate.estUsd, null);
  assert.deepEqual(estimate.perProvider, []);
});

test('estimateRunCost accepts caller token assumptions', () => {
  const estimate = estimateRunCost(
    {
      promptCount: 1,
      samples: 1,
      providers: [{ id: 'openai', model: 'gpt-5.6-luna' }],
      inputTokens: 1e6,
      outputTokens: 0,
    },
    NO_ENV,
  );
  assert.equal(estimate.estUsd, 0.2);
  assert.deepEqual(estimate.assumedTokens, { input: 1e6, output: 0 });
});

test('formatUsd keeps sub-cent amounts truthful and nulls honest', () => {
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(undefined), '—');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0032), '$0.0032');
  assert.equal(formatUsd(0.412), '$0.412');
  assert.equal(formatUsd(4.125), '$4.13');
});
