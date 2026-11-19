/**
 * Entry point — boots the HTTP server (and, from Phase 1, the scheduler).
 *
 * `node server.js` is the whole install story: no build step, no dependencies,
 * one SQLite file.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_ROUTES } from './core/agent-routes.js';
import * as defaultClientExport from './core/client-export.js';
import { buildConfig, config as processConfig, formatLocationControl } from './core/config.js';
import { evaluateSpendCap } from './core/cost.js';
import { get, getSetting, isoNow, openDb, setSetting, SETTING_KEYS } from './core/db.js';
import { updateEnvFile, withEnvFile } from './core/env-file.js';
import { memoryVsRetrievalDelta, retrievalAttritionReport } from './core/evidence-report.js';
import { assertInstancePaths, ensureInstanceKind } from './core/instance.js';
import { resolveMeasurementSeries } from './core/metrics.js';
import { citationPersistenceReport } from './core/opportunities.js';
import { removePortFile, writePortFile } from './core/port-discovery.js';
import { checkDataForSeoHealth, MODES as DATAFORSEO_MODES } from './core/providers/dataforseo.js';
import { scrubSecrets } from './core/providers/shared.js';
import { recoverStaleRuns } from './core/runner.js';
import { localDate, startScheduler } from './core/scheduler.js';
import { seedIfDemoAndEmpty } from './core/seed.js';
import { checkSite, renderSiteCheckText, SiteCheckError, validateSiteUrl } from './core/site-check.js';
import { getSubscriptionSchedule } from './core/subscription-scheduler.js';
import { maskOnboardingHint, SURFACE_LABEL } from './web/layout.js';
import { createRouter, isLoopbackRequest, sendError, sendJson } from './web/router.js';
import { ApiError, DEFAULT_DAYS, registerApiRoutes } from './web/pages/api.js';
import { registerPageRoutes } from './web/pages/index.js';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(APP_DIR, 'public');

/** @returns {string} */
function readVersion() {
  try {
    const pkg = /** @type {{version?: string}} */ (
      JSON.parse(readFileSync(resolve(APP_DIR, 'package.json'), 'utf8'))
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

/**
 * Describe the configured inference routes for the production-entrypoint message.
 * This is pure so startup copy can be exercised without opening a database or port.
 *
 * @param {import('./core/config.js').Config} config
 * @returns {string|null} startup guidance, or null when an API route is already configured
 */
export function startupGuidance(config) {
  if (config.demo) return 'Demo mode: live provider calls and the scheduler are disabled.';

  const labels = (config.subscriptionSurfaces ?? []).map((surface) => SURFACE_LABEL[surface] ?? surface);
  if ((config.enabledProviders ?? []).length > 0) return null;
  if (labels.length > 0) {
    return `No API keys are configured. Subscription measurements are enabled for ${labels.join(
      ' and ',
    )}; Hearsay can run through signed-in plan allowance, which may incur overage.`;
  }
  return 'No inference route is configured. Authenticate Codex or Claude Code and set HEARSAY_CODEX_ENABLED=1 or HEARSAY_CLAUDE_CODE_ENABLED=1, or configure an optional API key for direct API measurements.';
}

/**
 * Reconstruct an env map matching an injected `Config` object so in-process onboarding
 * mutations preserve custom test/embedder configuration fields.
 *
 * @param {import('./core/config.js').Config} cfg
 * @param {{dbPath?: string, portFile?: string}} [overrides]
 * @returns {Record<string, string|undefined>}
 */
function envFromConfig(cfg, overrides = {}) {
  const defaultDemoDerived = resolve(dirname(resolve(cfg.realDbPath)), 'demo/hearsay.db');
  const realDbPath =
    overrides.dbPath && !cfg.demo
      ? overrides.dbPath
      : overrides.dbPath && cfg.demo && cfg.realDbPath === './data/hearsay.db'
        ? join(dirname(resolve(overrides.dbPath)), 'real-hearsay.db')
        : cfg.realDbPath;
  /** @type {Record<string, string|undefined>} */
  const env = {
    PORT: String(cfg.port),
    HOST: cfg.host,
    HEARSAY_DB_PATH: realDbPath,
    HEARSAY_PORT_FILE: overrides.portFile ?? cfg.portFile,
    HEARSAY_RUN_AT: cfg.runAt,
    HEARSAY_SAMPLES: String(cfg.samples),
    HEARSAY_CONCURRENCY: String(cfg.concurrency),
    HEARSAY_TIMEOUT_MS: String(cfg.timeoutMs),
    HEARSAY_DEMO: cfg.demo ? '1' : '0',
    HEARSAY_CONFIRM_USD: String(cfg.confirmUsd),
    HEARSAY_OPENAI_SEARCH_POLICY: cfg.apiSearchPolicies.openai,
    HEARSAY_ANTHROPIC_SEARCH_POLICY: cfg.apiSearchPolicies.anthropic,
    HEARSAY_GEMINI_SEARCH_POLICY: cfg.apiSearchPolicies.gemini,
    HEARSAY_SUBSCRIPTION_SAMPLES: String(cfg.subscriptionSamples),
    HEARSAY_SUBSCRIPTION_CONCURRENCY: String(cfg.subscriptionConcurrency),
    HEARSAY_SUBSCRIPTION_TIMEOUT_MS: String(cfg.subscriptionTimeoutMs),
    HEARSAY_SUBSCRIPTION_IDLE_TIMEOUT_MS: String(cfg.subscriptionIdleTimeoutMs),
    HEARSAY_SUBSCRIPTION_MAX_OUTPUT_BYTES: String(cfg.subscriptionMaxOutputBytes),
    ...cfg.pricingEnv,
  };

  if (overrides.dbPath && cfg.demo && cfg.demoDbPath === defaultDemoDerived) {
    env.HEARSAY_DEMO_DB_PATH = overrides.dbPath;
  } else if (cfg.demoDbPath !== defaultDemoDerived) {
    env.HEARSAY_DEMO_DB_PATH = cfg.demoDbPath;
  }
  if (cfg.realDataDir !== dirname(resolve(cfg.realDbPath))) {
    env.HEARSAY_DATA_DIR = cfg.realDataDir;
  }
  if (cfg.demoDataDir !== dirname(resolve(cfg.demoDbPath))) {
    env.HEARSAY_DEMO_DATA_DIR = cfg.demoDataDir;
  }

  for (const provider of Object.values(cfg.providers)) {
    if (provider.apiKey !== '') env[provider.keyEnv] = provider.apiKey;
    env[provider.modelEnv] = provider.model;
  }
  for (const route of AGENT_ROUTES) {
    const sub = cfg.subscription[route.key];
    if (!sub) continue;
    env[route.enabledEnv] = sub.enabled ? '1' : '0';
    if (sub.executable && sub.executable !== route.executable) {
      env[route.pathEnv] = sub.executable;
    }
  }
  if (cfg.monthlyUsdCap !== null && cfg.monthlyUsdCap !== undefined) {
    env.HEARSAY_MONTHLY_USD_CAP = String(cfg.monthlyUsdCap);
  }
  if (cfg.allowUnverifiedModels) {
    env.HEARSAY_ALLOW_UNVERIFIED_MODELS = '1';
  }
  if (cfg.locationCode !== null && cfg.locationCode !== undefined) {
    env.HEARSAY_LOCATION_CODE = String(cfg.locationCode);
  }
  if (cfg.locationCountry) env.HEARSAY_LOCATION_COUNTRY = cfg.locationCountry;
  if (cfg.locationCity) env.HEARSAY_LOCATION_CITY = cfg.locationCity;
  if (cfg.languageCode) env.HEARSAY_LANGUAGE_CODE = cfg.languageCode;
  if (cfg.dataforseo?.login) env.DATAFORSEO_LOGIN = cfg.dataforseo.login;
  if (cfg.dataforseo?.password) env.DATAFORSEO_PASSWORD = cfg.dataforseo.password;
  return env;
}

/**
 * @typedef {Object} OnboardingRuntime
 * @property {() => string} getEnvFile
 * @property {(key: string) => string} getEnvValue
 * @property {() => string|undefined} getPathEnv
 * @property {() => import('node:sqlite').DatabaseSync} getDb
 * @property {() => import('./core/config.js').Config} getConfig
 * @property {(updates: Record<string, string|null>) => Promise<import('./core/config.js').Config>} updateProviders
 * @property {(demo: boolean) => Promise<{switched: boolean, demo: boolean}>} switchMode
 * @property {() => (import('./core/site-check.js').SiteCheckReport & {text: string})|null} [getLastSiteCheck]
 * @property {(receipt: (import('./core/site-check.js').SiteCheckReport & {text: string})|null) => void} [setLastSiteCheck]
 * @property {() => (import('./core/providers/dataforseo.js').DataForSeoHealthResult & {checkedAt: string})|null} [getLastDataForSeoHealth]
 * @property {(result: (import('./core/providers/dataforseo.js').DataForSeoHealthResult & {checkedAt: string})|null) => void} [setLastDataForSeoHealth]
 */

/**
 * @typedef {Object} SiteCheckDi
 * @property {typeof checkSite} [checkSite]
 * @property {boolean} [allowPrivateHosts]
 * @property {typeof globalThis.fetch} [fetch]
 * @property {(hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>} [lookup]
 */

const SETTINGS_ENV_KEYS = /** @type {const} */ ([
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'HEARSAY_LOCATION_CODE',
  'HEARSAY_LOCATION_COUNTRY',
  'HEARSAY_LOCATION_CITY',
  'HEARSAY_LANGUAGE_CODE',
  'HEARSAY_MONTHLY_USD_CAP',
  'HEARSAY_ALLOW_UNVERIFIED_MODELS',
]);

const SEARCH_POLICY_VALUES = new Set(['off', 'auto', 'required', 'legacy']);
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ACCENT_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ISO_COUNTRY_RE = /^[A-Za-z]{2}$/;
const LANGUAGE_CODE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/**
 * Wrap a Wave 2 JSON handler with the standard Hearsay error envelope (`{"error":{"code","message"}}`).
 * @param {(ctx: import('./web/router.js').Ctx) => unknown|Promise<unknown>} fn
 * @param {number} [status]
 * @returns {import('./web/router.js').Handler}
 */
function wave2Json(fn, status = 200) {
  return async (ctx) => {
    try {
      const result = await fn(ctx);
      if (result === undefined || ctx.res.headersSent) return;
      sendJson(ctx.res, status, result);
    } catch (err) {
      if (err instanceof ApiError) {
        sendError(ctx, err.status, err.message, {}, err.code);
        return;
      }
      if (err instanceof SiteCheckError) {
        const httpStatus =
          err.code === 'ssrf_blocked'
            ? 403
            : err.code === 'timeout'
              ? 504
              : err.code === 'fetch_failed'
                ? 502
                : 422;
        sendError(ctx, httpStatus, err.message, {}, err.code);
        return;
      }
      if (err instanceof RangeError) {
        sendError(ctx, 400, err.message, {}, 'bad_request');
        return;
      }
      throw err;
    }
  };
}

/** @param {import('./web/router.js').Ctx} ctx */
function assertLoopback(ctx) {
  if (!isLoopbackRequest(ctx.req)) {
    throw new ApiError(403, 'forbidden', 'This endpoint is restricted to local loopback requests.');
  }
}

/** @param {unknown} body @returns {Record<string, unknown>} */
function requireJsonObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'bad_request', 'Body must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (body);
}

/**
 * @param {URL} url
 * @param {string} key
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseIntQuery(url, key, fallback, min, max) {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, 'bad_request', `${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * @param {URL} url
 * @param {string[]} keys
 * @returns {boolean|undefined}
 */
function parseBoolQuery(url, keys) {
  for (const key of keys) {
    const raw = url.searchParams.get(key);
    if (raw === null || raw.trim() === '') continue;
    const norm = raw.trim().toLowerCase();
    if (norm === '1' || norm === 'true') return true;
    if (norm === '0' || norm === 'false') return false;
    throw new ApiError(400, 'bad_request', `${key} must be 1, 0, true, or false`);
  }
  return undefined;
}

/**
 * @param {URL} url
 * @param {string[]} keys
 * @param {number} [maxLen]
 * @returns {string|undefined}
 */
function parseStrQuery(url, keys, maxLen = 128) {
  for (const key of keys) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (/[\r\n\0]/.test(trimmed)) {
      throw new ApiError(400, 'bad_request', `${key} cannot contain control characters`);
    }
    if (trimmed.length > maxLen) {
      throw new ApiError(400, 'bad_request', `${key} must be ${maxLen} characters or fewer`);
    }
    return trimmed;
  }
  return undefined;
}

/**
 * Parse shared forensics query parameters into `ForensicFilters`.
 * @param {URL} url
 * @returns {import('./core/evidence-report.js').ForensicFilters}
 */
function parseForensicQuery(url) {
  /** @type {import('./core/evidence-report.js').ForensicFilters} */
  const filters = {};
  const surface = parseStrQuery(url, ['surface'], 120);
  if (surface !== undefined) filters.surface = surface;

  const provider = parseStrQuery(url, ['provider'], 64);
  if (provider !== undefined) filters.provider = provider;

  const model = parseStrQuery(url, ['model'], 120);
  if (model !== undefined) filters.model = model;

  const searchPolicy = parseStrQuery(url, ['search_policy', 'searchPolicy'], 32);
  if (searchPolicy !== undefined) {
    if (!SEARCH_POLICY_VALUES.has(searchPolicy)) {
      throw new ApiError(400, 'bad_request', 'search_policy must be one of: off, auto, required, legacy');
    }
    filters.searchPolicy = searchPolicy;
  }

  /** @type {Array<[string[], 'runId'|'intentId']>} */
  const intParams = [
    [['run_id', 'runId'], 'runId'],
    [['intent_id', 'intentId'], 'intentId'],
  ];
  for (const [paramKeys, targetKey] of intParams) {
    const raw = parseStrQuery(url, paramKeys, 32);
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new ApiError(400, 'bad_request', `${paramKeys[0]} must be a positive integer`);
      }
      filters[targetKey] = n;
    }
  }

  const seriesKey = parseStrQuery(url, ['series_id', 'series_key', 'seriesId', 'seriesKey'], 128);
  if (seriesKey !== undefined) filters.seriesKey = seriesKey;

  const comparisonKey = parseStrQuery(url, ['comparison_key', 'comparisonKey'], 128);
  if (comparisonKey !== undefined) filters.comparisonKey = comparisonKey;

  const start = parseStrQuery(url, ['start'], 40);
  const end = parseStrQuery(url, ['end'], 40);
  if (start !== undefined && (!UTC_SECOND_RE.test(start) || !Number.isFinite(Date.parse(start)))) {
    throw new ApiError(400, 'bad_request', 'start must be a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)');
  }
  if (end !== undefined && (!UTC_SECOND_RE.test(end) || !Number.isFinite(Date.parse(end)))) {
    throw new ApiError(400, 'bad_request', 'end must be a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)');
  }
  if (start !== undefined && end !== undefined && start >= end) {
    throw new ApiError(400, 'bad_request', 'start must precede end');
  }
  if (start !== undefined) filters.start = start;
  if (end !== undefined) filters.end = end;

  const includeSeeded = parseBoolQuery(url, ['include_seeded', 'includeSeeded']);
  if (includeSeeded !== undefined) filters.includeSeeded = includeSeeded;

  const excludeBranded = parseBoolQuery(url, ['exclude_branded', 'excludeBranded']);
  if (excludeBranded !== undefined) filters.excludeBranded = excludeBranded;

  const rawLimit = parseStrQuery(url, ['limit'], 16);
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isSafeInteger(n) || n < 1 || n > 200) {
      throw new ApiError(400, 'bad_request', 'limit must be an integer between 1 and 200');
    }
    filters.limit = n;
  }

  return filters;
}

/**
 * Scrub credentials, Basic auth headers, and API key patterns from diagnostic error strings.
 * @param {string|null|undefined} text
 * @param {string} login
 * @param {string} password
 * @returns {string|null}
 */
function scrubDataForSeoError(text, login, password) {
  if (text === null || text === undefined) return null;
  let out = scrubSecrets(String(text)).replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]');
  const basicToken = login && password ? Buffer.from(`${login}:${password}`, 'utf8').toString('base64') : '';
  for (const secret of [basicToken, password, login]) {
    if (secret && secret.length >= 3) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/**
 * Parse a flexible boolean toggle value.
 * @param {unknown} value
 * @param {string} field
 * @returns {boolean}
 */
function parseBooleanField(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new ApiError(422, 'unprocessable', `${field} must be a boolean`);
}

/**
 * Parse a numeric input that may arrive as a number or numeric form string.
 * @param {unknown} value
 * @param {string} field
 * @param {{integer?: boolean, min: number, max: number}} bounds
 * @returns {number}
 */
function parseBoundedNumber(value, field, { integer = false, min, max }) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new ApiError(422, 'unprocessable', `${field} must be a number`);
  }
  const strVal = typeof value === 'string' ? value.trim() : String(value);
  if (strVal === '') {
    throw new ApiError(422, 'unprocessable', `${field} cannot be empty`);
  }
  const n = Number(strVal);
  if (!Number.isFinite(n)) {
    throw new ApiError(422, 'unprocessable', `${field} must be a finite number`);
  }
  if (integer && !Number.isInteger(n)) {
    throw new ApiError(422, 'unprocessable', `${field} must be an integer`);
  }
  if (n < min || n > max) {
    throw new ApiError(422, 'unprocessable', `${field} must be between ${min} and ${max}`);
  }
  return n;
}

/**
 * Build a secret-free snapshot of Hearsay's extended settings and `.env` status.
 * NEVER exposes raw `DATAFORSEO_PASSWORD` or any password characters.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./core/config.js').Config} cfg
 */
function buildSettingsSnapshot(db, cfg) {
  const spendCap = evaluateSpendCap(db, {
    additionalEstimatedUsd: 0,
    monthlyUsdCap: cfg.monthlyUsdCap,
  });
  const loginConfigured = cfg.dataforseo.login !== '';
  const passwordConfigured = cfg.dataforseo.password !== '';
  return {
    includeBrandedInSov: Boolean(getSetting(db, SETTING_KEYS.INCLUDE_BRANDED_IN_SOV, false)),
    dataforseo: {
      configured: cfg.dataforseo.enabled,
      loginConfigured,
      passwordConfigured,
      maskedLogin: maskOnboardingHint(cfg.dataforseo.login),
      maskedPassword: passwordConfigured ? '****' : null,
    },
    geolocation: {
      locationCode: cfg.locationCode,
      locationCountry: cfg.locationCountry,
      locationCity: cfg.locationCity,
      languageCode: cfg.languageCode,
      locationControl: formatLocationControl(cfg),
    },
    spendCap: {
      monthlyUsdCap: cfg.monthlyUsdCap,
      ...spendCap,
      monthUtc: new Date().toISOString().slice(0, 7),
      utilizationPct:
        spendCap.capUsd !== null && spendCap.capUsd > 0
          ? Math.min(100, (spendCap.spentUsd / spendCap.capUsd) * 100)
          : null,
    },
    allowUnverifiedModels: cfg.allowUnverifiedModels,
    env: {
      DATAFORSEO_LOGIN: { configured: loginConfigured },
      DATAFORSEO_PASSWORD: { configured: passwordConfigured },
      HEARSAY_LOCATION_CODE: { configured: cfg.locationCode !== null, value: cfg.locationCode },
      HEARSAY_LOCATION_COUNTRY: { configured: cfg.locationCountry !== null, value: cfg.locationCountry },
      HEARSAY_LOCATION_CITY: { configured: cfg.locationCity !== null, value: cfg.locationCity },
      HEARSAY_LANGUAGE_CODE: { configured: cfg.languageCode !== null, value: cfg.languageCode },
      HEARSAY_MONTHLY_USD_CAP: { configured: cfg.monthlyUsdCap !== null, value: cfg.monthlyUsdCap },
      HEARSAY_ALLOW_UNVERIFIED_MODELS: { configured: cfg.allowUnverifiedModels, value: cfg.allowUnverifiedModels },
    },
  };
}

/**
 * Register Wave 2 HTTP API endpoints (forensics, pre-flight site check, spend cap,
 * DataForSEO health canary, extended `.env` settings, and white-label report export).
 *
 * @param {import('./web/router.js').Router} router
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   config: import('./core/config.js').Config,
 *   runtime?: OnboardingRuntime,
 *   siteCheck?: SiteCheckDi,
 *   dataforseoHealth?: typeof checkDataForSeoHealth,
 *   clientExport?: typeof defaultClientExport,
 * }} deps
 */
function registerWave2Routes(router, deps) {
  const getDb = () => (deps.runtime ? deps.runtime.getDb() : deps.db);
  const getConfig = () => (deps.runtime ? deps.runtime.getConfig() : deps.config);

  router.add(
    'POST',
    '/api/site-check',
    wave2Json(async (ctx) => {
      assertLoopback(ctx);
      const body = requireJsonObject(ctx.body);
      const rawUrl = body.url;
      if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
        throw new ApiError(422, 'invalid_url', 'url must be a non-empty http:// or https:// string');
      }
      if (rawUrl.trim().length > 2048) {
        throw new ApiError(422, 'invalid_url', 'url must be 2048 characters or fewer');
      }
      validateSiteUrl(rawUrl);

      const browser =
        body.browser === undefined || body.browser === null
          ? false
          : parseBooleanField(body.browser, 'browser');
      const rawTimeout = body.timeoutMs ?? body.timeout_ms;
      const timeoutMs =
        rawTimeout === undefined || rawTimeout === null || rawTimeout === ''
          ? 10_000
          : parseBoundedNumber(rawTimeout, 'timeoutMs', { integer: true, min: 500, max: 60_000 });

      const di = deps.siteCheck ?? {};
      const runCheck = di.checkSite ?? checkSite;
      // Never accept allowPrivateHosts from the HTTP request body — only via trusted test DI.
      const report = await runCheck(rawUrl.trim(), {
        browser,
        timeoutMs,
        allowPrivateHosts: di.allowPrivateHosts === true,
        ...(di.fetch ? { fetch: di.fetch } : {}),
        ...(di.lookup ? { lookup: di.lookup } : {}),
      });
      const receipt = { ...report, text: renderSiteCheckText(report) };
      deps.runtime?.setLastSiteCheck?.(receipt);
      return receipt;
    }),
  );

  router.add(
    'GET',
    '/api/forensics/attrition',
    wave2Json((ctx) => retrievalAttritionReport(getDb(), parseForensicQuery(ctx.url))),
  );

  router.add(
    'GET',
    '/api/forensics/memory-vs-search',
    wave2Json((ctx) => memoryVsRetrievalDelta(getDb(), parseForensicQuery(ctx.url))),
  );

  router.add(
    'GET',
    '/api/forensics/persistence',
    wave2Json((ctx) => citationPersistenceReport(getDb(), parseForensicQuery(ctx.url))),
  );

  router.add(
    'GET',
    '/api/spend-cap',
    wave2Json(() => {
      const activeDb = getDb();
      const activeConfig = getConfig();
      const evaluation = evaluateSpendCap(activeDb, {
        additionalEstimatedUsd: 0,
        monthlyUsdCap: activeConfig.monthlyUsdCap,
      });
      return {
        ...evaluation,
        monthlyUsdCap: activeConfig.monthlyUsdCap,
        monthUtc: new Date().toISOString().slice(0, 7),
        utilizationPct:
          evaluation.capUsd !== null && evaluation.capUsd > 0
            ? Math.min(100, (evaluation.spentUsd / evaluation.capUsd) * 100)
            : null,
      };
    }),
  );

  router.add(
    'POST',
    '/api/dataforseo/health',
    wave2Json(async (ctx) => {
      assertLoopback(ctx);
      const body = requireJsonObject(ctx.body);
      const rawMode = body.mode === undefined || body.mode === null || body.mode === '' ? 'google-aio' : body.mode;
      if (typeof rawMode !== 'string' || !DATAFORSEO_MODES.includes(/** @type {*} */ (rawMode.trim()))) {
        throw new ApiError(422, 'unprocessable', `mode must be one of: ${DATAFORSEO_MODES.join(', ')}`);
      }
      const mode = /** @type {'google-aio'|'chatgpt-web'} */ (rawMode.trim());

      const activeConfig = getConfig();
      const rawLoc = body.locationCode ?? body.location_code;
      const locationCode =
        rawLoc === undefined || rawLoc === null || rawLoc === ''
          ? activeConfig.locationCode ?? undefined
          : parseBoundedNumber(rawLoc, 'locationCode', { integer: true, min: 1, max: 999_999_999 });

      const rawLang = body.languageCode ?? body.language_code;
      let languageCode = activeConfig.languageCode ?? undefined;
      if (rawLang !== undefined && rawLang !== null && rawLang !== '') {
        if (typeof rawLang !== 'string' || !LANGUAGE_CODE_RE.test(rawLang.trim())) {
          throw new ApiError(422, 'unprocessable', 'languageCode must be a valid language tag (e.g. en, en-US)');
        }
        languageCode = rawLang.trim();
      }

      const rawTimeout = body.timeoutMs ?? body.timeout_ms;
      const timeoutMs =
        rawTimeout === undefined || rawTimeout === null || rawTimeout === ''
          ? undefined
          : parseBoundedNumber(rawTimeout, 'timeoutMs', { integer: true, min: 1000, max: 30_000 });

      const rawProbe = body.probePrompt ?? body.probe_prompt;
      let probePrompt;
      if (rawProbe !== undefined && rawProbe !== null && rawProbe !== '') {
        if (typeof rawProbe !== 'string' || /[\r\n\0]/.test(rawProbe) || rawProbe.trim().length > 200) {
          throw new ApiError(422, 'unprocessable', 'probePrompt must be a single-line string of at most 200 characters');
        }
        probePrompt = rawProbe.trim();
      }

      const healthFn = deps.dataforseoHealth ?? checkDataForSeoHealth;
      const rawResult = await healthFn({
        mode,
        login: activeConfig.dataforseo.login,
        password: activeConfig.dataforseo.password,
        ...(locationCode !== undefined ? { locationCode } : {}),
        ...(languageCode !== undefined ? { languageCode } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(probePrompt !== undefined ? { probePrompt } : {}),
      });

      const safeResult = {
        ok: Boolean(rawResult?.ok),
        mode: String(rawResult?.mode ?? mode),
        statusCode: typeof rawResult?.statusCode === 'number' ? rawResult.statusCode : null,
        latencyMs: typeof rawResult?.latencyMs === 'number' && Number.isFinite(rawResult.latencyMs) ? rawResult.latencyMs : 0,
        costUsd: typeof rawResult?.costUsd === 'number' && Number.isFinite(rawResult.costUsd) ? rawResult.costUsd : null,
        error: scrubDataForSeoError(rawResult?.error, activeConfig.dataforseo.login, activeConfig.dataforseo.password),
        checkedAt: isoNow(),
      };
      deps.runtime?.setLastDataForSeoHealth?.(safeResult);
      return safeResult;
    }),
  );

  router.replace(
    'GET',
    '/api/export/report',
    wave2Json((ctx) => {
      const activeDb = getDb();
      const activeConfig = getConfig();
      const now = isoNow();
      const requestedSeriesId = ctx.url.searchParams.get('series_id');
      const start = ctx.url.searchParams.get('start');
      const end = ctx.url.searchParams.get('end');
      if (!requestedSeriesId && (start !== null || end !== null)) {
        throw new ApiError(400, 'bad_request', 'start and end require series_id');
      }
      if ((start === null) !== (end === null)) {
        throw new ApiError(400, 'bad_request', 'start and end must be supplied together');
      }
      if (
        start !== null &&
        (!UTC_SECOND_RE.test(start) ||
          !UTC_SECOND_RE.test(end ?? '') ||
          !Number.isFinite(Date.parse(start)) ||
          !Number.isFinite(Date.parse(end ?? '')) ||
          start >= (end ?? ''))
      ) {
        throw new ApiError(400, 'bad_request', 'start and end must be ordered UTC timestamps');
      }

      const days = parseIntQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 3650);
      const range = start === null ? {} : { start, end: /** @type {string} */ (end) };
      let series;
      try {
        series = resolveMeasurementSeries(activeDb, {
          now,
          days,
          seriesId: requestedSeriesId || undefined,
          ...range,
        });
      } catch (err) {
        if (err instanceof RangeError) throw new ApiError(404, 'series_not_found', err.message);
        throw err;
      }
      if (requestedSeriesId && !series) {
        throw new ApiError(404, 'series_not_found', 'No series in this window');
      }
      const receiptLimit = parseIntQuery(ctx.url, 'receipt_limit', 50, 1, 200);

      const brandLabel = parseStrQuery(ctx.url, ['brand_label'], 120);
      const footerNote = parseStrQuery(ctx.url, ['footer_note'], 300);
      const accentColor = parseStrQuery(ctx.url, ['accent_color'], 16);
      if (accentColor !== undefined && !ACCENT_COLOR_RE.test(accentColor)) {
        throw new ApiError(400, 'bad_request', 'accent_color must be a hex color (e.g. #2a78d6)');
      }

      /** @type {{brandLabel?: string, accentColor?: string, footerNote?: string}} */
      const whiteLabel = {
        ...(brandLabel !== undefined ? { brandLabel } : {}),
        ...(accentColor !== undefined ? { accentColor } : {}),
        ...(footerNote !== undefined ? { footerNote } : {}),
      };

      const exportMod = /** @type {any} */ (deps.clientExport ?? defaultClientExport);
      const report = exportMod.buildClientReport(activeDb, {
        days,
        seriesId: series?.id,
        start: series?.start ?? range.start,
        end: series?.end ?? range.end,
        now,
        receiptLimit,
        demo: activeConfig.demo,
        ...whiteLabel,
      });
      const renderFn =
        typeof exportMod.renderClientReportHtml === 'function'
          ? exportMod.renderClientReportHtml
          : exportMod.renderClientReport;
      const htmlBody = renderFn(report, whiteLabel);

      const slug =
        (report.brand?.name ?? 'brand')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'brand';
      const datePart = report.generatedAt.slice(0, 10);
      const filename = `hearsay-client-report-${slug}-${datePart}.html`;
      const inline =
        ctx.url.searchParams.get('inline') === '1' || ctx.url.searchParams.get('inline') === 'true';

      ctx.res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(htmlBody),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      ctx.res.end(htmlBody);
    }),
  );

  router.add(
    'GET',
    '/api/settings',
    wave2Json((ctx) => {
      assertLoopback(ctx);
      return buildSettingsSnapshot(getDb(), getConfig());
    }),
  );

  router.add(
    'POST',
    '/api/settings',
    wave2Json(async (ctx) => {
      assertLoopback(ctx);
      if (!deps.runtime) {
        throw new ApiError(503, 'not_ready', 'Live runtime configuration updates are unavailable');
      }

      const body = requireJsonObject(ctx.body);
      const allowedFields = new Set([
        ...SETTINGS_ENV_KEYS,
        'clearKeys',
        'clear_keys',
        'includeBrandedInSov',
      ]);
      for (const field of Object.keys(body)) {
        if (!allowedFields.has(field)) {
          throw new ApiError(422, 'unprocessable', `Unsupported settings field: ${field}`);
        }
      }

      /** @type {Record<string, string|null>} */
      const updates = {};

      if (body.DATAFORSEO_LOGIN !== undefined) {
        if (body.DATAFORSEO_LOGIN === null) {
          updates.DATAFORSEO_LOGIN = null;
        } else if (typeof body.DATAFORSEO_LOGIN !== 'string') {
          throw new ApiError(422, 'unprocessable', 'DATAFORSEO_LOGIN must be a string or null');
        } else {
          if (/[\r\n\0]/.test(body.DATAFORSEO_LOGIN)) {
            throw new ApiError(422, 'unprocessable', 'DATAFORSEO_LOGIN cannot contain control characters');
          }
          const trimmed = body.DATAFORSEO_LOGIN.trim();
          if (trimmed.length > 256) {
            throw new ApiError(422, 'unprocessable', 'DATAFORSEO_LOGIN must be 256 characters or fewer');
          }
          if (trimmed !== '') updates.DATAFORSEO_LOGIN = trimmed;
        }
      }

      if (body.DATAFORSEO_PASSWORD !== undefined) {
        if (body.DATAFORSEO_PASSWORD === null) {
          updates.DATAFORSEO_PASSWORD = null;
        } else if (typeof body.DATAFORSEO_PASSWORD !== 'string') {
          throw new ApiError(422, 'unprocessable', 'DATAFORSEO_PASSWORD must be a string or null');
        } else {
          if (/[\r\n\0]/.test(body.DATAFORSEO_PASSWORD)) {
            throw new ApiError(422, 'unprocessable', 'DATAFORSEO_PASSWORD cannot contain control characters');
          }
          const trimmed = body.DATAFORSEO_PASSWORD.trim();
          if (trimmed.length > 512) {
            throw new ApiError(422, 'unprocessable', 'DATAFORSEO_PASSWORD must be 512 characters or fewer');
          }
          if (trimmed !== '') updates.DATAFORSEO_PASSWORD = trimmed;
        }
      }

      if (body.HEARSAY_LOCATION_CODE !== undefined) {
        if (body.HEARSAY_LOCATION_CODE === null || body.HEARSAY_LOCATION_CODE === '') {
          updates.HEARSAY_LOCATION_CODE = null;
        } else {
          const code = parseBoundedNumber(body.HEARSAY_LOCATION_CODE, 'HEARSAY_LOCATION_CODE', {
            integer: true,
            min: 1,
            max: 999_999_999,
          });
          updates.HEARSAY_LOCATION_CODE = String(code);
        }
      }

      if (body.HEARSAY_LOCATION_COUNTRY !== undefined) {
        if (body.HEARSAY_LOCATION_COUNTRY === null || body.HEARSAY_LOCATION_COUNTRY === '') {
          updates.HEARSAY_LOCATION_COUNTRY = null;
        } else if (typeof body.HEARSAY_LOCATION_COUNTRY !== 'string') {
          throw new ApiError(422, 'unprocessable', 'HEARSAY_LOCATION_COUNTRY must be a 2-letter ISO country code');
        } else {
          const code = body.HEARSAY_LOCATION_COUNTRY.trim().toUpperCase();
          if (!ISO_COUNTRY_RE.test(code)) {
            throw new ApiError(422, 'unprocessable', 'HEARSAY_LOCATION_COUNTRY must be a 2-letter ISO country code (e.g. US, GB)');
          }
          updates.HEARSAY_LOCATION_COUNTRY = code;
        }
      }

      if (body.HEARSAY_LOCATION_CITY !== undefined) {
        if (body.HEARSAY_LOCATION_CITY === null || body.HEARSAY_LOCATION_CITY === '') {
          updates.HEARSAY_LOCATION_CITY = null;
        } else if (typeof body.HEARSAY_LOCATION_CITY !== 'string') {
          throw new ApiError(422, 'unprocessable', 'HEARSAY_LOCATION_CITY must be a string or null');
        } else {
          if (/[\r\n\0]/.test(body.HEARSAY_LOCATION_CITY)) {
            throw new ApiError(422, 'unprocessable', 'HEARSAY_LOCATION_CITY cannot contain control characters');
          }
          const trimmed = body.HEARSAY_LOCATION_CITY.trim();
          if (trimmed.length > 120) {
            throw new ApiError(422, 'unprocessable', 'HEARSAY_LOCATION_CITY must be 120 characters or fewer');
          }
          updates.HEARSAY_LOCATION_CITY = trimmed === '' ? null : trimmed;
        }
      }

      if (body.HEARSAY_LANGUAGE_CODE !== undefined) {
        if (body.HEARSAY_LANGUAGE_CODE === null || body.HEARSAY_LANGUAGE_CODE === '') {
          updates.HEARSAY_LANGUAGE_CODE = null;
        } else if (typeof body.HEARSAY_LANGUAGE_CODE !== 'string') {
          throw new ApiError(422, 'unprocessable', 'HEARSAY_LANGUAGE_CODE must be a language code string');
        } else {
          const trimmed = body.HEARSAY_LANGUAGE_CODE.trim();
          if (!LANGUAGE_CODE_RE.test(trimmed) || trimmed.length > 16) {
            throw new ApiError(422, 'unprocessable', 'HEARSAY_LANGUAGE_CODE must be a valid language tag (e.g. en, en-US)');
          }
          updates.HEARSAY_LANGUAGE_CODE = trimmed;
        }
      }

      if (body.HEARSAY_MONTHLY_USD_CAP !== undefined) {
        if (body.HEARSAY_MONTHLY_USD_CAP === null || body.HEARSAY_MONTHLY_USD_CAP === '') {
          updates.HEARSAY_MONTHLY_USD_CAP = null;
        } else {
          const cap = parseBoundedNumber(body.HEARSAY_MONTHLY_USD_CAP, 'HEARSAY_MONTHLY_USD_CAP', {
            integer: false,
            min: 0.0001,
            max: 1_000_000,
          });
          updates.HEARSAY_MONTHLY_USD_CAP = String(cap);
        }
      }

      if (body.HEARSAY_ALLOW_UNVERIFIED_MODELS !== undefined) {
        if (body.HEARSAY_ALLOW_UNVERIFIED_MODELS === null || body.HEARSAY_ALLOW_UNVERIFIED_MODELS === '') {
          updates.HEARSAY_ALLOW_UNVERIFIED_MODELS = null;
        } else {
          const enabled = parseBooleanField(body.HEARSAY_ALLOW_UNVERIFIED_MODELS, 'HEARSAY_ALLOW_UNVERIFIED_MODELS');
          updates.HEARSAY_ALLOW_UNVERIFIED_MODELS = enabled ? '1' : '0';
        }
      }

      const rawClear = body.clearKeys ?? body.clear_keys;
      if (rawClear !== undefined && rawClear !== null) {
        if (!Array.isArray(rawClear)) {
          throw new ApiError(422, 'unprocessable', 'clearKeys must be an array of supported setting keys');
        }
        for (const item of rawClear) {
          if (typeof item !== 'string' || !SETTINGS_ENV_KEYS.includes(/** @type {*} */ (item.trim()))) {
            throw new ApiError(422, 'unprocessable', `Unsupported setting key in clearKeys: ${String(item)}`);
          }
          updates[item.trim()] = null;
        }
      }

      if (body.includeBrandedInSov !== undefined) {
        const includeBranded = parseBooleanField(body.includeBrandedInSov, 'includeBrandedInSov');
        setSetting(getDb(), SETTING_KEYS.INCLUDE_BRANDED_IN_SOV, includeBranded);
      }

      if (Object.keys(updates).length > 0) {
        try {
          await deps.runtime.updateProviders(updates);
        } catch (err) {
          if (err instanceof RangeError) {
            throw new ApiError(422, 'unprocessable', err.message);
          }
          throw err;
        }
      }

      return {
        ok: true,
        ...buildSettingsSnapshot(getDb(), getConfig()),
      };
    }),
  );
}

/**
 * Build the router for a given database + config.
 *
 * The page and API route tables live in `web/` (§10.2, §10.3); this function only
 * wires them together, so the HTTP surface stays in one lane.
 *
 * @param {Object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {import('./core/config.js').Config} deps.config
 * @param {OnboardingRuntime} [deps.runtime]
 * @param {SiteCheckDi} [deps.siteCheck]
 * @param {typeof checkDataForSeoHealth} [deps.dataforseoHealth]
 * @param {typeof defaultClientExport} [deps.clientExport]
 * @returns {import('./web/router.js').Router}
 */
export function buildRouter({ db, config, runtime, siteCheck, dataforseoHealth, clientExport }) {
  const router = createRouter({ publicDir: PUBLIC_DIR });
  const routeDeps = { db, config, version: VERSION, ...(runtime ? { runtime } : {}) };
  registerPageRoutes(router, routeDeps);
  registerApiRoutes(router, routeDeps);
  registerWave2Routes(router, {
    db,
    config,
    runtime,
    siteCheck,
    dataforseoHealth,
    clientExport,
  });
  return router;
}

/**
 * Boot an HTTP server. Pass `port: 0` for an ephemeral port (tests).
 *
 * @param {Object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string} [opts.dbPath]
 * @param {string} [opts.portFile]
 * @param {string} [opts.envFile]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {boolean} [opts.syncProcessEnv]
 * @param {import('./core/config.js').Config} [opts.config]
 * @param {SiteCheckDi} [opts.siteCheck]
 * @param {typeof checkDataForSeoHealth} [opts.dataforseoHealth]
 * @param {typeof defaultClientExport} [opts.clientExport]
 * @param {(message: string) => void} [opts.log] boot diagnostics; stderr by default
 * @returns {Promise<{server: import('node:http').Server, port: number, db: import('node:sqlite').DatabaseSync, config: import('./core/config.js').Config, scheduler: import('./core/scheduler.js').Scheduler, envFile: string, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const envFile = opts.envFile
    ? resolve(opts.envFile)
    : opts.config
      ? join(
          dirname(
            resolve(
              opts.config.realDbPath !== './data/hearsay.db'
                ? opts.config.realDbPath
                : (opts.dbPath ?? opts.config.realDbPath),
            ),
          ),
          '.env',
        )
      : resolve(process.env.HEARSAY_ENV_FILE ?? resolve(process.cwd(), '.env'));
  const syncProcessEnv = opts.syncProcessEnv ?? !opts.config;

  const baseEnv = opts.config
    ? withEnvFile({ ...envFromConfig(opts.config, { dbPath: opts.dbPath, portFile: opts.portFile }), ...opts.env }, envFile)
    : withEnvFile({ ...process.env, ...opts.env }, envFile);

  const initialConfig = opts.config ?? buildConfig(baseEnv);
  const initialDbPath = opts.dbPath ?? initialConfig.dbPath;
  const port = opts.port ?? initialConfig.port;
  const host = opts.host ?? initialConfig.host;
  const portFile = opts.portFile ?? initialConfig.portFile;
  const log = opts.log ?? ((/** @type {string} */ message) => process.stderr.write(`${message}\n`));

  assertInstancePaths(initialConfig, initialDbPath);
  const initialDb = openDb(initialDbPath);
  try {
    ensureInstanceKind(initialDb, initialConfig.demo);
  } catch (error) {
    initialDb.close();
    throw error;
  }
  // Demo mode with nothing to show boots into the fictional universe rather than an empty
  // dashboard (§12). Never touches a database that already has rows, seeded or live.
  const seeded = seedIfDemoAndEmpty(initialDb, initialConfig);
  if (seeded) {
    process.stderr.write(
      `Demo mode: seeded ${seeded.responses} answers over ${seeded.runs} days (${seeded.from} to ${seeded.to}).\n`,
    );
  }

  // §8.1 step 1: a 'running' row older than 2h is an orphan from a crashed process —
  // mark it failed now, or runPanel refuses with RunInProgressError for up to 2h.
  const recovered = recoverStaleRuns(initialDb);
  if (recovered > 0) log(`Recovered ${recovered} stale running run(s) — marked failed.`);

  // §8.2: the daily scheduler. startScheduler itself declines demo mode and keyless
  // installs; the boot log states the next run time when it is live.
  const initialScheduler = startScheduler({ db: initialDb, config: initialConfig, log });
  if (initialScheduler.enabled && initialConfig.enabledProviders.length > 0) {
    const ranToday = getSetting(initialDb, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null) === localDate(new Date());
    log(`Scheduler: next panel run ${ranToday ? 'tomorrow' : 'today'} at ${initialConfig.runAt} (local time).`);
  }
  if (!initialConfig.demo && initialConfig.subscriptionSurfaces.length > 0) {
    const schedule = getSubscriptionSchedule(initialDb);
    log(schedule
      ? `Subscription schedule: ${schedule.runAt} (${schedule.timeZone}); see tracking health for the next occurrence and consent state.`
      : 'Subscription runner available; no active recurring schedule.');
  }

  const state = {
    env: { ...baseEnv },
    config: initialConfig,
    dbPath: initialDbPath,
    db: initialDb,
    scheduler: initialScheduler,
    /** @type {(import('./core/site-check.js').SiteCheckReport & {text: string})|null} */
    lastSiteCheck: null,
    /** @type {(import('./core/providers/dataforseo.js').DataForSeoHealthResult & {checkedAt: string})|null} */
    lastDataForSeoHealth: null,
    /** @type {import('./web/router.js').Router} */
    router: /** @type {*} */ (null),
  };

  const routerExtras = {
    ...(opts.siteCheck ? { siteCheck: opts.siteCheck } : {}),
    ...(opts.dataforseoHealth ? { dataforseoHealth: opts.dataforseoHealth } : {}),
    ...(opts.clientExport ? { clientExport: opts.clientExport } : {}),
  };

  let mutationQueue = Promise.resolve();
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  const serialize = (fn) => {
    const runNext = mutationQueue.then(fn, fn);
    mutationQueue = runNext.then(() => undefined, () => undefined);
    return runNext;
  };

  /** @type {OnboardingRuntime} */
  const runtime = {
    getEnvFile: () => envFile,
    getEnvValue: (key) => String(state.env[key] ?? ''),
    getPathEnv: () => state.env.PATH ?? process.env.PATH,
    getDb: () => state.db,
    getConfig: () => state.config,
    getLastSiteCheck: () => state.lastSiteCheck,
    setLastSiteCheck: (receipt) => {
      state.lastSiteCheck = receipt;
    },
    getLastDataForSeoHealth: () => state.lastDataForSeoHealth,
    setLastDataForSeoHealth: (result) => {
      state.lastDataForSeoHealth = result;
    },
    updateProviders: (updates) =>
      serialize(() => {
        /** @type {Record<string, string|undefined>} */
        const nextEnv = { ...state.env };
        for (const [key, value] of Object.entries(updates)) {
          if (value === null || value === '') {
            delete nextEnv[key];
          } else {
            nextEnv[key] = value;
          }
        }
        const nextConfig = buildConfig(nextEnv);
        assertInstancePaths(nextConfig, state.dbPath);
        updateEnvFile(envFile, updates);
        if (syncProcessEnv) {
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === '') {
              delete process.env[key];
            } else {
              process.env[key] = value;
            }
          }
        }
        state.scheduler.stop();
        const nextScheduler = startScheduler({ db: state.db, config: nextConfig, log });
        const nextRouter = buildRouter({ db: state.db, config: nextConfig, runtime, ...routerExtras });
        state.env = nextEnv;
        state.config = nextConfig;
        state.scheduler = nextScheduler;
        state.router = nextRouter;
        return nextConfig;
      }),
    switchMode: (targetDemo) =>
      serialize(() => {
        const running = get(state.db, "SELECT id FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
        if (running) {
          const err = new Error(`Cannot switch workspace mode while run #${running.id} is in progress.`);
          err.name = 'RunInProgressError';
          throw err;
        }

        /** @type {Record<string, string|undefined>} */
        const nextEnv = { ...state.env, HEARSAY_DEMO: targetDemo ? '1' : '0' };
        const nextConfig = buildConfig(nextEnv);
        const nextDbPath = nextConfig.dbPath;
        assertInstancePaths(nextConfig, nextDbPath);

        if (nextConfig.demo === state.config.demo && resolve(nextDbPath) === resolve(state.dbPath)) {
          updateEnvFile(envFile, { HEARSAY_DEMO: targetDemo ? '1' : '0' });
          if (syncProcessEnv) process.env.HEARSAY_DEMO = targetDemo ? '1' : '0';
          state.env = nextEnv;
          return { switched: false, demo: state.config.demo };
        }

        const nextDb = openDb(nextDbPath);
        try {
          ensureInstanceKind(nextDb, nextConfig.demo);
          const demoSeeded = seedIfDemoAndEmpty(nextDb, nextConfig);
          if (demoSeeded) {
            log(`Demo mode: seeded ${demoSeeded.responses} answers over ${demoSeeded.runs} days (${demoSeeded.from} to ${demoSeeded.to}).`);
          }
          recoverStaleRuns(nextDb);
          updateEnvFile(envFile, { HEARSAY_DEMO: targetDemo ? '1' : '0' });
        } catch (err) {
          try {
            nextDb.close();
          } catch {
            /* ignore close error */
          }
          throw err;
        }

        if (syncProcessEnv) process.env.HEARSAY_DEMO = targetDemo ? '1' : '0';
        state.scheduler.stop();
        const nextScheduler = startScheduler({ db: nextDb, config: nextConfig, log });
        const nextRouter = buildRouter({ db: nextDb, config: nextConfig, runtime, ...routerExtras });

        const prevDb = state.db;
        state.env = nextEnv;
        state.config = nextConfig;
        state.dbPath = nextDbPath;
        state.db = nextDb;
        state.scheduler = nextScheduler;
        state.router = nextRouter;
        prevDb.close();

        return { switched: true, demo: state.config.demo };
      }),
  };

  state.router = buildRouter({ db: state.db, config: state.config, runtime, ...routerExtras });

  const server = createServer((req, res) => {
    void state.router.handle(req, res);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen(undefined);
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  try {
    writePortFile(portFile, boundPort);
  } catch (error) {
    state.scheduler.stop();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(() => done(undefined)));
    state.db.close();
    throw error;
  }

  return {
    server,
    port: boundPort,
    envFile,
    get db() {
      return state.db;
    },
    get config() {
      return state.config;
    },
    get scheduler() {
      return state.scheduler;
    },
    close: async () => {
      await mutationQueue;
      state.scheduler.stop();
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((done) => server.close(() => done(undefined)));
      removePortFile(portFile, boundPort);
      state.db.close();
    },
  };
}

/** @returns {boolean} */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const app = await startServer();
  process.stdout.write(`Hearsay v${VERSION} listening on http://${app.config.host}:${app.port}\n`);
  const guidance = startupGuidance(app.config);
  if (guidance) process.stdout.write(`${guidance}\n`);
}
