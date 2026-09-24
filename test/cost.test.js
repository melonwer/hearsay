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
  costUsd,
  estimateRunCost,
  formatUsd,
  priceFor,
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

  const perCallOpenai = 0.00004 + 0.0006;
  const perCallPerplexity = 0.0002 + 0.0005 + 0.005;
  assert.equal(estimate.perProvider.length, 2);
  assert.equal(estimate.perProvider[0].calls, 36);
  assert.ok(Math.abs((estimate.perProvider[0].estUsd ?? 0) - perCallOpenai * 36) < 1e-12);
  assert.ok(Math.abs((estimate.perProvider[1].estUsd ?? 0) - perCallPerplexity * 36) < 1e-12);
  assert.ok(Math.abs((estimate.estUsd ?? 0) - (perCallOpenai + perCallPerplexity) * 36) < 1e-12);
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
  assert.ok(Math.abs((estimate.estUsd ?? 0) - (0.00004 + 0.0006) * 2) < 1e-12);
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
