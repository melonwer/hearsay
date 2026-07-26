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
 * PRICES VERIFIED 2026-07-26 (USD per 1M tokens, standard non-batch, non-cached):
 *
 *   gpt-5.6-luna      $1.00 in / $6.00 out
 *     https://developers.openai.com/api/docs/models
 *   claude-sonnet-5   $3.00 in / $15.00 out   (list price)
 *     https://platform.claude.com/docs/en/about-claude/models/overview
 *     NOTE: introductory pricing of $2 / $10 applies through 2026-08-31. We default to
 *     the list price so the estimate stays correct after that date and errs high rather
 *     than low; override with HEARSAY_PRICE_ANTHROPIC_IN/_OUT to bill at the intro rate.
 *   gemini-3.6-flash  $1.50 in / $7.50 out    (output includes thinking tokens)
 *     https://ai.google.dev/gemini-api/docs/pricing
 *   sonar             $1.00 in / $1.00 out    + $0.005 per request
 *     https://docs.perplexity.ai/getting-started/pricing
 *     Perplexity bills a per-request search fee on top of tokens ($5 / $8 / $12 per 1000
 *     requests for low / medium / high search context). At panel-sized prompts that fee
 *     dominates the token cost, so leaving it out would understate Perplexity spend by
 *     roughly an order of magnitude. We default to the low-context tier.
 * ---------------------------------------------------------------------------
 */

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
  'gpt-5.6-luna': { provider: 'openai', inputPerMTok: 1.0, outputPerMTok: 6.0, requestUsd: 0 },
  'claude-sonnet-5': { provider: 'anthropic', inputPerMTok: 3.0, outputPerMTok: 15.0, requestUsd: 0 },
  'gemini-3.6-flash': { provider: 'gemini', inputPerMTok: 1.5, outputPerMTok: 7.5, requestUsd: 0 },
  sonar: { provider: 'perplexity', inputPerMTok: 1.0, outputPerMTok: 1.0, requestUsd: 0.005 },
};

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
  const table = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : null;
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
 * @typedef {Object} ProviderEstimate
 * @property {ProviderId|string} provider
 * @property {string} model
 * @property {number} calls
 * @property {number|null} estUsd null when this provider's model has no known price
 */

/**
 * @typedef {Object} RunEstimate
 * @property {number} calls total calls the run will make
 * @property {number|null} estUsd sum over priced providers; null when nothing is priced
 * @property {ProviderEstimate[]} perProvider
 * @property {(ProviderId|string)[]} unpriced providers whose model has no known price
 * @property {{input: number, output: number}} assumedTokens what the estimate assumes per call
 */

/**
 * Pre-run cost estimate (§4.3): prompts × providers × samples × assumed tokens × price.
 *
 * @param {Object} input
 * @param {number} input.promptCount active prompts
 * @param {number} input.samples samples per prompt per provider
 * @param {{id: ProviderId|string, model: string}[]} input.providers enabled providers
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

  for (const provider of input.providers) {
    const unit = costUsd({ provider: provider.id, model: provider.model, tokensIn, tokensOut }, env);
    if (unit === null) {
      unpriced.push(provider.id);
      perProvider.push({ provider: provider.id, model: provider.model, calls: callsPerProvider, estUsd: null });
      continue;
    }
    const estUsd = unit * callsPerProvider;
    priced += 1;
    total += estUsd;
    perProvider.push({ provider: provider.id, model: provider.model, calls: callsPerProvider, estUsd });
  }

  return {
    calls: callsPerProvider * input.providers.length,
    estUsd: priced === 0 ? null : total,
    perProvider,
    unpriced,
    assumedTokens: { input: tokensIn, output: tokensOut },
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
