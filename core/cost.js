/**
 * Price table and run-cost estimator (§4.3).
 *
 * Two binding rules. Every price below was checked against the provider's live pricing
 * page at build time and is overridable via `HEARSAY_PRICE_<PROVIDER>_IN/_OUT`; and an
 * unknown model yields a **null** cost, never a guessed one — a wrong dollar figure is
 * worse than a missing one (§19.6 #13, §15). Every cost figure in the UI, the API and
 * the docs comes from this module's output.
 *
 * The table is keyed by model id, not by provider, on purpose: point `OPENAI_MODEL` at
 * something else and Hearsay reports "unpriced" rather than billing you at the old
 * model's rate. Set `HEARSAY_PRICE_OPENAI_IN` / `_OUT` to teach it the new numbers.
 *
 * ---------------------------------------------------------------------------
 * PRICES VERIFIED 2026-09-24 (USD per 1M tokens, standard non-batch, non-cached):
 *
 *   gpt-5.6-luna      $0.20 in / $1.20 out
 *     https://developers.openai.com/api/docs/models/gpt-5.6-luna
 *   claude-sonnet-5   $2.00 in / $10.00 out
 *     https://platform.claude.com/docs/en/about-claude/pricing
 *   gemini-3.6-flash  $0.75 in / $3.75 out    (output includes thinking tokens)
 *     https://ai.google.dev/gemini-api/docs/pricing
 *     These Gemini rates are time-limited through 2026-12-31; recheck before 2027.
 *   sonar             $1.00 in / $1.00 out    + $0.005 per request
 *     https://docs.perplexity.ai/getting-started/pricing
 *     Perplexity bills a per-request search fee on top of tokens ($5 / $8 / $12 per 1000
 *     requests for low / medium / high search context). At panel-sized prompts that fee
 *     dominates the token cost, so leaving it out would understate Perplexity spend by
 *     roughly an order of magnitude. We default to the low-context tier.
 * ---------------------------------------------------------------------------
 */

export const PRICE_TABLE_VERSION = '2026-09-24-standard';

import { stableIdentity } from './measurement-contract.js';

/** @typedef {import('./config.js').ProviderId} ProviderId */

/**
 * @typedef {Object} ModelPrice
 * @property {ProviderId} provider
 * @property {number} inputPerMTok USD per 1M input tokens
 * @property {number} outputPerMTok USD per 1M output tokens
 * @property {number} requestUsd flat USD per request, 0 for providers that charge none
 */

/** @type {Record<string, ModelPrice>} */
export const MODEL_PRICES = {
  'gpt-5.6-luna': { provider: 'openai', inputPerMTok: 0.2, outputPerMTok: 1.2, requestUsd: 0 },
  'claude-sonnet-5': { provider: 'anthropic', inputPerMTok: 2.0, outputPerMTok: 10.0, requestUsd: 0 },
  'gemini-3.6-flash': { provider: 'gemini', inputPerMTok: 0.75, outputPerMTok: 3.75, requestUsd: 0 },
  sonar: { provider: 'perplexity', inputPerMTok: 1.0, outputPerMTok: 1.0, requestUsd: 0.005 },
};

export const SEARCH_TOOL_PRICES = Object.freeze({
  // Checked against official OpenAI, Anthropic, and Gemini API pricing on 2026-09-24.
  // Gemini has a shared monthly free tier; these are paid list rates, not invoices.
  openai: 0.01,
  anthropic: 0.01,
  gemini: 0.014,
});

/**
 * Token counts assumed by the pre-run estimate (§4.3). A panel prompt is one short
 * question and the answers are a few paragraphs; these are the plan's ~200 in / ~500 out
 * figures. The estimate is labelled an estimate everywhere it is shown — actual spend
 * comes from `responses.cost_usd`, computed from the provider's own usage numbers.
 */
export const ESTIMATE_TOKENS = { input: 200, output: 500 };

const MILLION = 1_000_000;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function positiveNumber(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Resolve the price for a (provider, model) pair.
 *
 * Env overrides win over the table and are per provider, so they keep working when you
 * switch that provider to a model Hearsay has never heard of. Both `_IN` and `_OUT` must
 * be set for an override to apply — half a price is not a price.
 *
 * @param {ProviderId|string} provider
 * @param {string} model
 * @param {Record<string, string|undefined>} [env]
 * @returns {ModelPrice|null} null when the model is unknown and no override is set
 */
export function priceFor(provider, model, env = process.env) {
  const key = String(provider).toUpperCase();
  const inOverride = positiveNumber(env[`HEARSAY_PRICE_${key}_IN`]);
  const outOverride = positiveNumber(env[`HEARSAY_PRICE_${key}_OUT`]);
  const listed = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : null;
  const table = listed?.provider === provider ? listed : null;
  const requestOverride = positiveNumber(env[`HEARSAY_PRICE_${key}_REQUEST`]);

  if (inOverride !== null && outOverride !== null) {
    return {
      provider: /** @type {ProviderId} */ (provider),
      inputPerMTok: inOverride,
      outputPerMTok: outOverride,
      requestUsd: requestOverride ?? table?.requestUsd ?? 0,
    };
  }
  if (!table) return null;
  if (requestOverride !== null) return { ...table, requestUsd: requestOverride };
  return table;
}

/**
 * Cost of one response, in USD, or null when it cannot be known honestly — an unknown
 * model, or a provider that returned no usage counts. Called at insert time so
 * `responses.cost_usd` is a fact about that call, not a later re-derivation (§4.3).
 *
 * @param {{provider: ProviderId|string, model: string, tokensIn: number|null|undefined, tokensOut: number|null|undefined}} call
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|null}
 */
export function costUsd(call, env = process.env) {
  const price = priceFor(call.provider, call.model, env);
  if (!price) return null;
  const tokensIn = positiveNumber(call.tokensIn);
  const tokensOut = positiveNumber(call.tokensOut);
  if (tokensIn === null || tokensOut === null) return null;
  return (tokensIn / MILLION) * price.inputPerMTok + (tokensOut / MILLION) * price.outputPerMTok + price.requestUsd;
}

/**
 * @typedef {{attempt:number, continuation:number, inputTokens:number|null,
 *   outputTokens:number|null, searchCalls?:number|null, requestCompleted?:boolean|null}} BillableAttempt
 */

/**
 * Price reported quantities without inferring billable calls from observed queries,
 * URLs, or citations. A timeout with unknown usage keeps an unknown component.
 *
 * @param {{provider:ProviderId|string, model:string, targetId:string,
 *   searchPolicy:'off'|'auto'|'required'|'legacy', attempts:BillableAttempt[]}} input
 * @param {Record<string,string|undefined>} [env]
 * @returns {{components:import('./measurement-contract.js').UsageComponent[],
 *   knownSubtotalUsd:number|null, computedCostUsd:number|null,
 *   costStatus:'known'|'partial'|'unavailable'}}
 */
export function priceUsage(input, env = process.env) {
  const modelPrice = priceFor(input.provider, input.model, env);
  const key = String(input.provider).toUpperCase();
  const overridden = positiveNumber(env[`HEARSAY_PRICE_${key}_IN`]) !== null &&
    positiveNumber(env[`HEARSAY_PRICE_${key}_OUT`]) !== null;
  const requestOverridden = positiveNumber(env[`HEARSAY_PRICE_${key}_REQUEST`]) !== null;
  const tokenVersion = modelPrice === null ? null : overridden || requestOverridden
    ? `override:${stableIdentity(modelPrice)}` : PRICE_TABLE_VERSION;
  /** @type {import('./measurement-contract.js').UsageComponent[]} */
  const components = [];
  /** @param {BillableAttempt} attempt @param {string} component @param {number|null} quantity @param {string} unit @param {number|null} unitPrice @param {string|null} version */
  const append = (attempt, component, quantity, unit, unitPrice, version) => {
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) throw new RangeError('Usage quantity must be nonnegative and finite');
    components.push({
      targetId: input.targetId, attempt: attempt.attempt, continuation: attempt.continuation,
      component, quantity, unit,
      costUsd: quantity === null || unitPrice === null ? null : quantity * unitPrice,
      costStatus: quantity === null || unitPrice === null ? 'unavailable' : 'known',
      priceVersion: version,
    });
  };
  for (const attempt of input.attempts) {
    if (!Number.isInteger(attempt.attempt) || attempt.attempt < 0 ||
        !Number.isInteger(attempt.continuation) || attempt.continuation < 0) {
      throw new RangeError('Attempt and continuation indices must be nonnegative integers');
    }
    if (attempt.searchCalls !== null && attempt.searchCalls !== undefined &&
        (!Number.isInteger(attempt.searchCalls) || attempt.searchCalls < 0)) {
      throw new RangeError('Reported search calls must be a nonnegative integer');
    }
    append(attempt, 'input_tokens', attempt.inputTokens, 'tokens',
      modelPrice === null ? null : modelPrice.inputPerMTok / MILLION, tokenVersion);
    append(attempt, 'output_tokens', attempt.outputTokens, 'tokens',
      modelPrice === null ? null : modelPrice.outputPerMTok / MILLION, tokenVersion);
    if (input.provider === 'perplexity') {
      append(attempt, 'sonar_request', attempt.requestCompleted === true ? 1 : null,
        'requests', modelPrice?.requestUsd ?? null, tokenVersion);
    } else if (input.searchPolicy === 'auto' || input.searchPolicy === 'required') {
      const searchPrice = SEARCH_TOOL_PRICES[/** @type {keyof typeof SEARCH_TOOL_PRICES} */ (input.provider)] ?? null;
      append(attempt, 'web_search', attempt.searchCalls ?? null, 'calls', searchPrice, PRICE_TABLE_VERSION);
    }
  }
  const known = components.filter((component) => component.costStatus === 'known');
  const knownSubtotalUsd = known.length === 0 ? null : known.reduce((sum, component) => sum + Number(component.costUsd), 0);
  const complete = components.length > 0 && known.length === components.length;
  return {
    components,
    knownSubtotalUsd,
    computedCostUsd: complete ? knownSubtotalUsd : null,
    costStatus: complete ? 'known' : known.length > 0 ? 'partial' : 'unavailable',
  };
}

/**
 * Complete versus partial computed cost for a set of attempted API calls. The subtotal
 * already includes every known component, including components of partial calls.
 * @param {{attemptedCalls:number,unknownCalls:number,knownSubtotalUsd:number|null}} input
 */
export function summarizeComputedCosts(input) {
  const costStatus = input.attemptedCalls === 0 || input.knownSubtotalUsd === null ? 'unavailable'
    : input.unknownCalls > 0 ? 'partial' : 'known';
  return {
    totalUsd: costStatus === 'known' ? input.knownSubtotalUsd : null,
    knownSubtotalUsd: input.knownSubtotalUsd,
    costStatus: /** @type {'known'|'partial'|'unavailable'} */ (costStatus),
    attemptedCalls: input.attemptedCalls,
    unknownCalls: input.unknownCalls,
  };
}

/**
 * @typedef {Object} ProviderEstimate
 * @property {ProviderId|string} provider
 * @property {string} model
 * @property {number} calls
 * @property {number|null} estUsd null when this provider's model has no known price
 * @property {number} assumedSearchCalls search calls forecast for this provider
 * @property {number|null} searchToolUsd included search-tool forecast, null if unpriced
 * @property {boolean} unboundedSearch provider does not enforce a search-call ceiling
 */

/**
 * @typedef {Object} RunEstimate
 * @property {number} calls total calls the run will make
 * @property {number|null} estUsd complete computed estimate, null if any provider is unpriced
 * @property {number|null} knownSubtotalUsd sum over priced providers
 * @property {'known'|'partial'|'unavailable'} costStatus
 * @property {ProviderEstimate[]} perProvider
 * @property {(ProviderId|string)[]} unpriced providers whose model has no known price
 * @property {{input: number, output: number}} assumedTokens what the estimate assumes per call
 * @property {boolean} hasUnboundedSearch forecast is not a spending ceiling
 */

/**
 * Pre-run cost estimate (§4.3): prompts × providers × samples × assumed tokens × price.
 *
 * @param {Object} input
 * @param {number} input.promptCount active prompts
 * @param {number} input.samples samples per prompt per provider
 * @param {{id: ProviderId|string, model: string, searchPolicy?:'off'|'auto'|'required'|'legacy'}[]} input.providers enabled providers
 * @param {number} [input.inputTokens] override the assumed input tokens per call
 * @param {number} [input.outputTokens] override the assumed output tokens per call
 * @param {Record<string, string|undefined>} [env]
 * @returns {RunEstimate}
 */
export function estimateRunCost(input, env = process.env) {
  const promptCount = Math.max(0, Math.floor(input.promptCount));
  const samples = Math.max(0, Math.floor(input.samples));
  const tokensIn = input.inputTokens ?? ESTIMATE_TOKENS.input;
  const tokensOut = input.outputTokens ?? ESTIMATE_TOKENS.output;
  const callsPerProvider = promptCount * samples;

  /** @type {ProviderEstimate[]} */
  const perProvider = [];
  /** @type {(ProviderId|string)[]} */
  const unpriced = [];
  let total = 0;
  let priced = 0;
  let hasUnboundedSearch = false;

  for (const provider of input.providers) {
    const unboundedSearch = provider.searchPolicy === 'auto' || provider.searchPolicy === 'required';
    const assumedSearchCalls = unboundedSearch ? callsPerProvider : 0;
    const searchPrice = unboundedSearch
      ? SEARCH_TOOL_PRICES[/** @type {keyof typeof SEARCH_TOOL_PRICES} */ (provider.id)] ?? null : 0;
    const searchToolUsd = searchPrice === null ? null : searchPrice * assumedSearchCalls;
    hasUnboundedSearch ||= unboundedSearch;
    const unit = costUsd({ provider: provider.id, model: provider.model, tokensIn, tokensOut }, env);
    if (unit === null || searchToolUsd === null) {
      unpriced.push(provider.id);
      perProvider.push({ provider: provider.id, model: provider.model, calls: callsPerProvider,
        estUsd: null, assumedSearchCalls, searchToolUsd, unboundedSearch });
      continue;
    }
    const estUsd = unit * callsPerProvider + searchToolUsd;
    priced += 1;
    total += estUsd;
    perProvider.push({ provider: provider.id, model: provider.model, calls: callsPerProvider,
      estUsd, assumedSearchCalls, searchToolUsd, unboundedSearch });
  }

  return {
    calls: callsPerProvider * input.providers.length,
    estUsd: priced === input.providers.length && priced > 0 ? total : null,
    knownSubtotalUsd: priced === 0 ? null : total,
    costStatus: priced === input.providers.length && priced > 0 ? 'known'
      : priced > 0 ? 'partial' : 'unavailable',
    perProvider,
    unpriced,
    assumedTokens: { input: tokensIn, output: tokensOut },
    hasUnboundedSearch,
  };
}

/**
 * Format a USD amount for display. Sub-cent amounts keep enough precision to stay
 * truthful instead of rounding to "$0.00"; null renders as an em dash, never as $0.
 *
 * @param {number|null|undefined} usd
 * @returns {string}
 */
export function formatUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
