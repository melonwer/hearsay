/**
 * Configuration — env parsing, defaults, provider registry (§4.1, §4.2).
 *
 * Secrets rule (§19.6 #9): API keys come from the environment only. They are never
 * written to the database, never logged, and never rendered unmasked in the UI.
 */

import { AGENT_ROUTES } from './agent-routes.js';
import { dirname, resolve } from 'node:path';

import { withEnvFile } from './env-file.js';
import { resolvePortFilePath } from './port-discovery.js';

export { parseEnvFile, withEnvFile } from './env-file.js';

/** @typedef {'openai'|'anthropic'|'gemini'|'perplexity'} ProviderId */

/**
 * @typedef {Object} ProviderConfig
 * @property {ProviderId} id
 * @property {string} label human-facing name of the consumer product
 * @property {string} model model id actually requested
 * @property {string} keyEnv name of the env var holding the key
 * @property {string} modelEnv name of the env var overriding the model
 * @property {boolean} enabled true iff the key env var is non-empty
 * @property {string} apiKey in-memory only — never persist or log this
 * @property {string|null} maskedKey safe-to-render form, e.g. "sk-…4f2"
 */

/**
 * @typedef {Object} Config
 * @property {number} port
 * @property {string} portFile local HTTP-port discovery file
 * @property {string} host
 * @property {string} dbPath
 * @property {string} realDbPath
 * @property {string} demoDbPath
 * @property {string} realDataDir
 * @property {string} demoDataDir
 * @property {string} runAt local-time HH:MM for the daily panel run
 * @property {number} samples samples per prompt per provider per run (1–10)
 * @property {number} concurrency parallel in-flight LLM calls
 * @property {number} timeoutMs per-call timeout
 * @property {boolean} demo demo mode: no live calls, no scheduler, banner shown
 * @property {number} confirmUsd Run-cost confirm threshold in USD (SPEC §3.3); 0 = every run quotes first.
 * @property {Record<string, string|undefined>} pricingEnv resolved nonsecret price overrides
 * @property {{openai:'off'|'auto'|'required',anthropic:'off'|'auto',gemini:'off'|'auto',perplexity:'legacy'}} apiSearchPolicies
 * @property {Record<ProviderId, ProviderConfig>} providers
 * @property {ProviderConfig[]} enabledProviders
 * @property {Record<string, SubscriptionConfig>} subscription
 * @property {string[]} subscriptionSurfaces
 * @property {number} subscriptionSamples
 * @property {number} subscriptionConcurrency
 * @property {number} subscriptionTimeoutMs
 * @property {number} subscriptionIdleTimeoutMs
 * @property {number} subscriptionMaxOutputBytes
 * @property {string} subscriptionDataDir
 */

/**
 * @typedef {Object} SubscriptionConfig
 * @property {string} surface
 * @property {string} label
 * @property {string} executable
 * @property {boolean} enabled
 */

/**
 * Default models. Each was checked against official docs on 2026-09-24 and remains
 * overridable via env (§4.1).
 *
 * - openai      `gpt-5.6-luna`   — cost-tier current chat model in the GPT-5.6 family.
 *                                  Source: https://developers.openai.com/api/docs/models
 *                                  (flagship alias on the same page is `gpt-5.6`).
 * - anthropic   `claude-sonnet-5` — current mainstream mid-tier Sonnet.
 *                                  Source: https://platform.claude.com/docs/en/about-claude/models/overview
 * - gemini      `gemini-3.6-flash` — current stable mainstream Flash tier.
 *                                  Source: https://ai.google.dev/gemini-api/docs/models
 * - perplexity  `sonar`          — "lightweight, cost-effective search model with grounding".
 *                                  Source: https://docs.perplexity.ai/getting-started/models
 *
 * Prices live in core/cost.js, keyed by these same model ids. Change
 * a model here without adding its price there and Hearsay reports "unpriced" rather than
 * billing you at the old model's rate (§4.3).
 */
const PROVIDER_DEFAULTS = /** @type {const} */ ([
  { id: 'openai', label: 'ChatGPT', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', model: 'gpt-5.6-luna' },
  { id: 'anthropic', label: 'Claude', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', model: 'claude-sonnet-5' },
  { id: 'gemini', label: 'Gemini', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', model: 'gemini-3.6-flash' },
  { id: 'perplexity', label: 'Perplexity', keyEnv: 'PERPLEXITY_API_KEY', modelEnv: 'PERPLEXITY_MODEL', model: 'sonar' },
]);

/** Order of provider cards/series everywhere in the UI. */
export const PROVIDER_IDS = /** @type {ProviderId[]} */ (PROVIDER_DEFAULTS.map((p) => p.id));

/**
 * @param {string|undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intIn(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse the HTTP port strictly. Unlike the other integer settings, a malformed
 * port must not partially parse into a different fixed port.
 *
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function portIn(value, fallback) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const port = Number(text);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

/**
 * @param {string|undefined} value
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function floatIn(value, fallback, min) {
  const s = String(value ?? '').trim();
  if (s === '') return fallback; // Number('') is 0, which would silently defeat the fallback
  const n = Number(s);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * @param {string|undefined} value
 * @param {string} fallback must already be valid
 * @returns {string}
 */
function timeOfDay(value, fallback) {
  const v = String(value ?? '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
}

/**
 * Mask a secret for display: keeps a short prefix and the last 3 characters (§11.6).
 * Returns null for empty input so callers never have to special-case "".
 *
 * @param {string} secret
 * @returns {string|null}
 */
export function maskSecret(secret) {
  const s = String(secret ?? '');
  if (s === '') return null;
  if (s.length <= 6) return '…';
  const dash = s.indexOf('-');
  const prefix = dash > 0 && dash <= 5 ? s.slice(0, dash + 1) : s.slice(0, 3);
  return `${prefix}…${s.slice(-3)}`;
}

/**
 * Build the config object from an env record. Pure — takes env in, returns config out,
 * so tests can exercise it without touching `process.env`.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Config}
 */
export function buildConfig(env) {
  const openaiSearchPolicy = String(env.HEARSAY_OPENAI_SEARCH_POLICY ?? 'off').trim() || 'off';
  if (!['off', 'auto', 'required'].includes(openaiSearchPolicy)) {
    throw new RangeError('HEARSAY_OPENAI_SEARCH_POLICY must be off, auto, or required');
  }
  const anthropicSearchPolicy = String(env.HEARSAY_ANTHROPIC_SEARCH_POLICY ?? 'off').trim() || 'off';
  if (!['off', 'auto'].includes(anthropicSearchPolicy)) {
    throw new RangeError('HEARSAY_ANTHROPIC_SEARCH_POLICY must be off or auto');
  }
  const geminiSearchPolicy = String(env.HEARSAY_GEMINI_SEARCH_POLICY ?? 'off').trim() || 'off';
  if (!['off', 'auto'].includes(geminiSearchPolicy)) {
    throw new RangeError('HEARSAY_GEMINI_SEARCH_POLICY must be off or auto');
  }
  for (const [key, policy] of [['HEARSAY_PERPLEXITY_SEARCH_POLICY', 'legacy']]) {
    const value = String(env[key] ?? policy).trim() || policy;
    if (value !== policy) throw new RangeError(`${key} does not support ${value} in this build`);
  }
  /** @type {Record<string, string|undefined>} */
  const pricingEnv = {};
  for (const id of PROVIDER_IDS) {
    for (const suffix of ['IN', 'OUT', 'REQUEST']) {
      const key = `HEARSAY_PRICE_${id.toUpperCase()}_${suffix}`;
      if (env[key] !== undefined) pricingEnv[key] = env[key];
    }
  }
  /** @type {Partial<Record<ProviderId, ProviderConfig>>} */
  const providers = {};
  for (const def of PROVIDER_DEFAULTS) {
    const apiKey = String(env[def.keyEnv] ?? '').trim();
    const model = String(env[def.modelEnv] ?? '').trim() || def.model;
    providers[def.id] = {
      id: def.id,
      label: def.label,
      model,
      keyEnv: def.keyEnv,
      modelEnv: def.modelEnv,
      enabled: apiKey !== '',
      apiKey,
      maskedKey: maskSecret(apiKey),
    };
  }
  const registry = /** @type {Record<ProviderId, ProviderConfig>} */ (providers);
  if (openaiSearchPolicy !== 'off' && registry.openai.model !== 'gpt-5.6-luna') {
    throw new RangeError(`OpenAI web search is validated for gpt-5.6-luna, not ${registry.openai.model}`);
  }
  if (anthropicSearchPolicy !== 'off' && registry.anthropic.model !== 'claude-sonnet-5') {
    throw new RangeError(`Anthropic web search is validated for claude-sonnet-5, not ${registry.anthropic.model}`);
  }

  const demo = String(env.HEARSAY_DEMO ?? '').trim() === '1';
  const realDbPath = String(env.HEARSAY_DB_PATH ?? '').trim() || './data/hearsay.db';
  const demoDbPath = String(env.HEARSAY_DEMO_DB_PATH ?? '').trim() ||
    resolve(dirname(resolve(realDbPath)), 'demo/hearsay.db');
  const realDataDir = String(env.HEARSAY_DATA_DIR ?? '').trim() || dirname(resolve(realDbPath));
  const demoDataDir = String(env.HEARSAY_DEMO_DATA_DIR ?? '').trim() || dirname(resolve(demoDbPath));
  const dbPath = demo ? demoDbPath : realDbPath;
  const subscriptionDataDir = demo ? demoDataDir : realDataDir;
  const subscription = Object.fromEntries(AGENT_ROUTES.map((route) => [route.key, {
    surface: route.id, label: route.label, provider: route.provider, executable: String(env[route.pathEnv] ?? '').trim() || route.executable,
    enabled: String(env[route.enabledEnv] ?? '').trim() === '1',
  }]));
  const subscriptionSurfaces = AGENT_ROUTES.filter((route) => subscription[route.key].enabled).map((route) => route.id);

  return {
    port: portIn(env.PORT, 0),
    portFile: resolvePortFilePath(env),
    host: String(env.HOST ?? '').trim() || '127.0.0.1',
    dbPath,
    realDbPath,
    demoDbPath,
    realDataDir,
    demoDataDir,
    runAt: timeOfDay(env.HEARSAY_RUN_AT, '07:00'),
    samples: intIn(env.HEARSAY_SAMPLES, 3, 1, 10),
    concurrency: intIn(env.HEARSAY_CONCURRENCY, 2, 1, 16),
    timeoutMs: intIn(env.HEARSAY_TIMEOUT_MS, 45000, 1000, 600000),
    demo,
    confirmUsd: floatIn(env.HEARSAY_CONFIRM_USD, 1, 0),
    pricingEnv,
    apiSearchPolicies: {
      openai: /** @type {'off'|'auto'|'required'} */ (openaiSearchPolicy),
      anthropic: /** @type {'off'|'auto'} */ (anthropicSearchPolicy),
      gemini: /** @type {'off'|'auto'} */ (geminiSearchPolicy), perplexity: 'legacy',
    },
    providers: registry,
    enabledProviders: PROVIDER_IDS.map((id) => registry[id]).filter((p) => p.enabled),
    subscription,
    subscriptionSurfaces,
    subscriptionSamples: intIn(env.HEARSAY_SUBSCRIPTION_SAMPLES, 1, 1, 10),
    subscriptionConcurrency: intIn(env.HEARSAY_SUBSCRIPTION_CONCURRENCY, 1, 1, 2),
    subscriptionTimeoutMs: intIn(env.HEARSAY_SUBSCRIPTION_TIMEOUT_MS, 120000, 1000, 600000),
    subscriptionIdleTimeoutMs: intIn(env.HEARSAY_SUBSCRIPTION_IDLE_TIMEOUT_MS, 30000, 1000, 120000),
    subscriptionMaxOutputBytes: intIn(env.HEARSAY_SUBSCRIPTION_MAX_OUTPUT_BYTES, 2 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    subscriptionDataDir,
  };
}

/** Process-wide configuration, resolved once at import time. */
export const config = buildConfig(withEnvFile(process.env));

/**
 * Provider registry in stable UI order: openai, anthropic, gemini, perplexity (§4.2).
 * Same objects as `config.providers`, as an ordered array.
 * @type {ProviderConfig[]}
 */
export const providers = PROVIDER_IDS.map((id) => config.providers[id]);

/**
 * Calls a panel run will make: prompts × enabled providers × samples (§4.2).
 * @param {number} promptCount active prompt count
 * @returns {number}
 */
export function estimateRunCalls(promptCount) {
  return Math.max(0, Math.floor(promptCount)) * config.enabledProviders.length * config.samples;
}
