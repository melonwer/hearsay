/**
 * Configuration — env parsing, defaults, provider registry (§4.1, §4.2).
 *
 * Secrets rule (§19.6 #9): API keys come from the environment only. They are never
 * written to the database, never logged, and never rendered unmasked in the UI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
 * @property {string} host
 * @property {string} dbPath
 * @property {string} runAt local-time HH:MM for the daily panel run
 * @property {number} samples samples per prompt per provider per run (1–10)
 * @property {number} concurrency parallel in-flight LLM calls
 * @property {number} timeoutMs per-call timeout
 * @property {boolean} demo demo mode: no live calls, no scheduler, banner shown
 * @property {number} confirmUsd Run-cost confirm threshold in USD (SPEC §3.3); 0 = every run quotes first.
 * @property {Record<ProviderId, ProviderConfig>} providers
 * @property {ProviderConfig[]} enabledProviders
 * @property {{codex: SubscriptionConfig, claudeCode: SubscriptionConfig}} subscription
 * @property {('codex-agent'|'claude-code-agent')[]} subscriptionSurfaces
 * @property {number} subscriptionSamples
 * @property {number} subscriptionConcurrency
 * @property {number} subscriptionTimeoutMs
 * @property {number} subscriptionIdleTimeoutMs
 * @property {number} subscriptionMaxOutputBytes
 * @property {string} subscriptionDataDir
 */

/**
 * @typedef {Object} SubscriptionConfig
 * @property {'codex-agent'|'claude-code-agent'} surface
 * @property {string} label
 * @property {string} executable
 * @property {boolean} enabled
 */

/**
 * Default models. Each was checked against current official docs at build time
 * (2026-07-26) rather than recalled — every one is overridable via env (§4.1).
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
 * Re-verified 2026-07-26 by Lane A alongside each provider's endpoint, request shape and
 * per-token price; the prices live in core/cost.js, keyed by these same model ids. Change
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
 * Minimal `.env` parser (§4.1). Documented limitations, on purpose — we do not take
 * a dotenv dependency: `KEY=VALUE` lines only, `#` comments, values are trimmed, and
 * one matching pair of surrounding quotes is removed. No interpolation, no multi-line
 * values, no `export ` prefix handling.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` (when present) into a plain env record. Real environment variables
 * always win over file values.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} [file]
 * @returns {Record<string, string|undefined>}
 */
export function withEnvFile(env, file = resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return { ...env };
  /** @type {Record<string, string|undefined>} */
  const merged = { ...parseEnvFile(readFileSync(file, 'utf8')) };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

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

  const dbPath = String(env.HEARSAY_DB_PATH ?? '').trim() || './data/hearsay.db';
  const subscriptionDataDir = String(env.HEARSAY_DATA_DIR ?? '').trim() || dirname(resolve(dbPath));
  const codexEnabled = String(env.HEARSAY_CODEX_ENABLED ?? '').trim() === '1';
  const claudeEnabled = String(env.HEARSAY_CLAUDE_CODE_ENABLED ?? '').trim() === '1';
  const subscription = /** @type {{codex: SubscriptionConfig, claudeCode: SubscriptionConfig}} */ ({
    codex: {
      surface: 'codex-agent',
      label: 'Codex agent',
      executable: String(env.HEARSAY_CODEX_PATH ?? '').trim() || 'codex',
      enabled: codexEnabled,
    },
    claudeCode: {
      surface: 'claude-code-agent',
      label: 'Claude Code agent',
      executable: String(env.HEARSAY_CLAUDE_CODE_PATH ?? '').trim() || 'claude',
      enabled: claudeEnabled,
    },
  });
  const subscriptionSurfaces = /** @type {('codex-agent'|'claude-code-agent')[]} */ ([]);
  if (codexEnabled) subscriptionSurfaces.push('codex-agent');
  if (claudeEnabled) subscriptionSurfaces.push('claude-code-agent');
  return {
    port: intIn(env.PORT, 3000, 1, 65535),
    host: String(env.HOST ?? '').trim() || '127.0.0.1',
    dbPath,
    runAt: timeOfDay(env.HEARSAY_RUN_AT, '07:00'),
    samples: intIn(env.HEARSAY_SAMPLES, 3, 1, 10),
    concurrency: intIn(env.HEARSAY_CONCURRENCY, 2, 1, 16),
    timeoutMs: intIn(env.HEARSAY_TIMEOUT_MS, 45000, 1000, 600000),
    demo: String(env.HEARSAY_DEMO ?? '').trim() === '1',
    confirmUsd: floatIn(env.HEARSAY_CONFIRM_USD, 1, 0),
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
