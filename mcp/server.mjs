#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server (§13, SPEC §2/§6). Newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; logs go to stderr. Most tools proxy a running
 * Hearsay over HTTP at HEARSAY_URL; `hearsay_site_check` runs directly with zero server
 * or API keys, and the forensics tools fall back to opening the local SQLite DB read-only
 * when `server.js` is not running.
 */
import { AGENT_SURFACES } from '../core/agent-routes.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withEnvFile } from '../core/env-file.js';
import { resolveHearsayUrl } from '../core/port-discovery.js';
import { checkSiteV2, SiteCheckError } from '../core/site-check.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// [VERIFY-AT-BUILD]: verified 2026-07-26 against modelcontextprotocol.io/specification/versioning
// — current revision is 2025-11-25; earlier revisions remain valid to echo.
const KNOWN_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Whole-request bound for one tools/call: headers AND body. Env override for tests. */
const TIMEOUT_MS = (() => {
  const n = Number(process.env.HEARSAY_MCP_TIMEOUT_MS ?? '');
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const DAYS = { type: 'integer', minimum: 1, maximum: 365, description: 'Reporting window in days (default 30)' };
const UTC_BOUNDARY = { type: 'string', description: 'UTC timestamp YYYY-MM-DDTHH:mm:ssZ; pass start and end together, with end exclusive' };
const SURFACE = {
  type: 'string',
  enum: ['openai-api', 'anthropic-api', 'gemini-api', 'perplexity-api', ...AGENT_SURFACES],
  description: 'Exact measurement surface; API and subscription-agent surfaces are never blended',
};
const SUBSCRIPTION_SURFACES = {
  type: 'array',
  items: { type: 'string', enum: [...AGENT_SURFACES] },
  minItems: 1,
};
const SUBSCRIPTION_LANE = { type: 'string', enum: ['tracking', 'exploration'], default: 'tracking' };
const ENTITY_FIELDS = {
  name: { type: 'string', description: 'Entity name, e.g. "Acme"' },
  aliases: { type: 'array', items: { type: 'string' }, description: 'Other names it goes by (≥3 chars each)' },
  domains: { type: 'array', items: { type: 'string' }, description: 'Domains it owns, e.g. "acme.com"' },
  ambiguous_name: { type: 'boolean', description: 'Flag an ordinary-word brand name for identity review' },
};
/** @param {Record<string, unknown>} properties @param {string[]} [required] */
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
/** @param {Record<string, any>} args @param {string[]} keys @param {Record<string,string>} [rename] */
function query(args, keys, rename = {}) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args?.[key];
    if (value !== undefined && value !== null) params.set(rename[key] ?? key, String(value));
  }
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

const FORENSICS_FILTER_PROPERTIES = {
  surface: SURFACE,
  provider: { type: 'string', enum: ['openai', 'anthropic', 'gemini', 'perplexity'], description: 'Provider filter' },
  model: { type: 'string', description: 'Exact model ID filter, e.g. "gpt-5.6-luna"' },
  search_policy: { type: 'string', enum: ['off', 'auto', 'required', 'legacy'], description: 'Search policy filter' },
  run_id: { type: 'integer', minimum: 1, description: 'Restrict analysis to one measurement run ID' },
  series_id: { type: 'string', description: 'Exact measurement series ID or comparison key' },
  comparison_key: { type: 'string', description: 'Exact comparison key filter' },
  intent_id: { type: 'integer', minimum: 1, description: 'Restrict analysis to one buyer intent ID' },
  start: UTC_BOUNDARY,
  end: UTC_BOUNDARY,
  include_seeded: { type: 'boolean', description: 'Include demo seeded runs (default false)' },
  exclude_branded: { type: 'boolean', description: 'Exclude branded-category prompts' },
};

/**
 * Build query string for `/api/forensics/*` endpoints.
 * @param {Record<string, any>} args
 * @param {boolean} [includeLimit]
 * @returns {string}
 */
function forensicsQuery(args, includeLimit = false) {
  const mapped = {
    ...args,
    include_seeded: typeof args?.include_seeded === 'boolean' ? (args.include_seeded ? '1' : '0') : undefined,
    exclude_branded: typeof args?.exclude_branded === 'boolean' ? (args.exclude_branded ? '1' : '0') : undefined,
  };
  const keys = [
    'surface', 'provider', 'model', 'search_policy', 'run_id', 'series_id',
    'comparison_key', 'intent_id', 'start', 'end', 'include_seeded', 'exclude_branded',
    ...(includeLimit ? ['limit'] : []),
  ];
  return query(mapped, keys);
}

/**
 * Convert MCP tool arguments into `ForensicFilters` for direct SQLite analyzers.
 * @param {Record<string, any>} args
 * @param {boolean} [includeLimit]
 */
function toForensicFilters(args = {}, includeLimit = false) {
  /** @type {Record<string, unknown>} */
  const filters = {};
  if (typeof args.surface === 'string' && args.surface.trim() !== '') filters.surface = args.surface.trim();
  if (typeof args.provider === 'string' && args.provider.trim() !== '') filters.provider = args.provider.trim();
  if (typeof args.model === 'string' && args.model.trim() !== '') filters.model = args.model.trim();
  if (typeof args.search_policy === 'string' && args.search_policy.trim() !== '') filters.searchPolicy = args.search_policy.trim();
  if (args.run_id !== undefined && args.run_id !== null) filters.runId = Number(args.run_id);
  if (typeof args.series_id === 'string' && args.series_id.trim() !== '') filters.seriesId = args.series_id.trim();
  if (typeof args.comparison_key === 'string' && args.comparison_key.trim() !== '') filters.comparisonKey = args.comparison_key.trim();
  if (args.intent_id !== undefined && args.intent_id !== null) filters.intentId = Number(args.intent_id);
  if (typeof args.start === 'string' && args.start.trim() !== '') filters.start = args.start.trim();
  if (typeof args.end === 'string' && args.end.trim() !== '') filters.end = args.end.trim();
  if (typeof args.include_seeded === 'boolean') filters.includeSeeded = args.include_seeded;
  if (typeof args.exclude_branded === 'boolean') filters.excludeBranded = args.exclude_branded;
  if (includeLimit && args.limit !== undefined && args.limit !== null) filters.limit = Number(args.limit);
  return filters;
}

/**
 * Resolve the configured/default local SQLite database path without creating any file.
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function resolveLocalDbPath(env) {
  const demo = String(env.HEARSAY_DEMO ?? '').trim() === '1';
  const rawReal = String(env.HEARSAY_DB_PATH ?? '').trim();
  const realDbPath = rawReal ? resolve(rawReal) : resolve(REPO_ROOT, 'data/hearsay.db');
  if (!demo) return realDbPath;
  const rawDemo = String(env.HEARSAY_DEMO_DB_PATH ?? '').trim();
  return rawDemo ? resolve(rawDemo) : resolve(dirname(realDbPath), 'demo/hearsay.db');
}

/**
 * Build a concise human-readable summary of a `SiteCheckV2Report`.
 * @param {import('../core/site-check.js').SiteCheckV2Report} report
 * @returns {string}
 */
function formatSiteCheckSummary(report) {
  const blockedBots =
    report.aiBotsAllowed && Array.isArray(report.aiBotsAllowed.blockedBots) && report.aiBotsAllowed.total > 0
      ? report.aiBotsAllowed.blockedBots
      : report.robotsTxt.crawlers.filter((c) => !c.allowed).map((c) => c.bot);
  const allowedCount =
    report.aiBotsAllowed && report.aiBotsAllowed.total > 0
      ? report.aiBotsAllowed.allowed
      : report.robotsTxt.allowedCount;
  const totalBots =
    report.aiBotsAllowed && report.aiBotsAllowed.total > 0
      ? report.aiBotsAllowed.total
      : report.robotsTxt.crawlers.length;
  const p = report.payload;
  const ratio = report.extraction?.forensics?.payloadToProseRatio;
  const parityStr =
    typeof report.proseParityPct === 'number' ? `, proseParity=${report.proseParityPct}%` : '';
  const ratioStr = typeof ratio === 'number' ? `, payloadToProse=${ratio}x` : '';
  const lines = [
    `Hearsay Site Check: ${report.summary.grade.toUpperCase()} (${report.summary.criticalCount} critical, ${report.summary.warningCount} warning, ${report.summary.infoCount} info)`,
    `URL: ${report.finalUrl} | HTTP ${report.status ?? 'ERR'} | mode=${report.mode} | ${report.timingMs}ms | ${report.redirects.count} redirect(s)`,
    report.scopeSummary,
    `Payload: ${(p.htmlBytes / 1024).toFixed(1)}KB raw HTML, ${p.visibleWordCount} visible words, CSR=${p.csrRisk.level}${ratioStr}${parityStr}, truncation(>30KB=${p.truncationRisks.contentStartsAfter30KB}, >100KB=${p.truncationRisks.coreContentPast100KB}, >300KB=${p.truncationRisks.pageExceeds300KB})`,
    `robots.txt: ${allowedCount}/${totalBots} crawlers allowed${blockedBots.length ? ` (blocked: ${blockedBots.join(', ')})` : ''}`,
  ];
  const stackLabels = [
    report.stack?.primaryFramework,
    report.stack?.primaryCms,
    report.stack?.primaryCdn,
    report.stack?.primaryHosting,
  ].filter((v) => typeof v === 'string' && v !== '');
  if (stackLabels.length > 0 || (report.waf && report.waf.state !== 'none')) {
    lines.push(
      `Stack/WAF: ${stackLabels.length ? stackLabels.join(', ') : 'none detected'} | WAF=${report.waf?.state ?? 'none'}`,
    );
  }
  if (report.competitorXray && Array.isArray(report.competitorXray.competitors) && report.competitorXray.competitors.length > 0) {
    const domains = report.competitorXray.competitors.map((c) => c.domain).join(', ');
    lines.push(`Competitor X-Ray: compared against ${domains} (${report.competitorXray.deltas.length} metric deltas)`);
  }
  if (report.findings.length > 0) {
    lines.push('Findings:');
    for (const f of report.findings.slice(0, 6)) {
      lines.push(`- [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`);
    }
  }
  return lines.join('\n');
}

/**
 * Run `checkSiteV2` directly inside the MCP server with zero HTTP backend or API keys.
 * Respects SSRF private-host guard by default (private hosts are never unlockable via tool args).
 * @param {Record<string, any>} args
 */
async function runDirectSiteCheck(args) {
  const rawUrl = args?.url;
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: { code: 'invalid_url', message: 'url must be a non-empty http:// or https:// string' } }) }],
    };
  }
  const rawTimeout = args?.timeoutMs ?? args?.timeout_ms;
  /** @type {number|undefined} */
  let timeoutMs;
  if (rawTimeout !== undefined && rawTimeout !== null) {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n < 500 || n > 120_000) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'invalid_arguments', message: 'timeoutMs must be between 500 and 120000' } }) }],
      };
    }
    timeoutMs = Math.floor(n);
  }
  const rawMaxPages = args?.maxPages ?? args?.max_pages;
  /** @type {number|undefined} */
  let maxPages;
  if (rawMaxPages !== undefined && rawMaxPages !== null) {
    const n = Number(rawMaxPages);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'invalid_arguments', message: 'maxPages must be an integer between 1 and 50' } }) }],
      };
    }
    maxPages = n;
  }
  /** @type {string[]|undefined} */
  let vs;
  if (args?.vs !== undefined && args?.vs !== null) {
    if (
      !Array.isArray(args.vs) ||
      args.vs.length > 5 ||
      args.vs.some((/** @type {unknown} */ u) => typeof u !== 'string' || u.trim() === '')
    ) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'invalid_arguments', message: 'vs must be an array of up to 5 non-empty URL strings' } }) }],
      };
    }
    vs = args.vs.map((/** @type {unknown} */ u) => String(u).trim());
  }
  // Never allow untrusted MCP tool arguments to bypass the SSRF private-host guard.
  const allowPrivateHosts = process.env.HEARSAY_SITE_CHECK_ALLOW_PRIVATE_HOSTS === '1';
  try {
    const report = await checkSiteV2(rawUrl.trim(), {
      single: args?.single === true,
      maxPages,
      vs,
      browser: args?.browser === true,
      checkCaching: args?.checkCaching === true || args?.check_caching === true,
      ignoreRobotsForOwnSite: args?.ignoreRobotsForOwnSite === true || args?.ignore_robots_for_own_site === true,
      timeoutMs,
      allowPrivateHosts,
    });
    const summaryText = formatSiteCheckSummary(report);
    return {
      isError: false,
      content: [
        { type: 'text', text: JSON.stringify({ ...report, summaryText }) },
        { type: 'text', text: summaryText },
      ],
    };
  } catch (err) {
    const code = err instanceof SiteCheckError ? err.code : 'site_check_failed';
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
    };
  }
}

/**
 * Open the configured/default local SQLite database read-only and serve
 * `hearsay_site_check_history` directly when `server.js` is not running.
 * @param {Record<string, any>} args
 * @param {Record<string, string|undefined>} env
 */
async function runDirectSiteCheckHistory(args, env) {
  const rawId = args?.id;
  const rawCompareId = args?.compareWithId ?? args?.compare_with_id;
  if (rawCompareId !== undefined && rawCompareId !== null && (rawId === undefined || rawId === null)) {
    return {
      isError: true,
      text: JSON.stringify({
        error: {
          code: 'invalid_arguments',
          message: 'id is required when compareWithId is provided',
        },
      }),
    };
  }
  const dbPath = resolveLocalDbPath(env);
  if (!existsSync(dbPath)) {
    return {
      isError: true,
      text: JSON.stringify({
        error: {
          code: 'db_unavailable',
          message: 'Hearsay server is not running and no local SQLite database was found at the configured HEARSAY_DB_PATH. Start `node server.js` or set HEARSAY_DB_PATH.',
        },
      }),
    };
  }
  const { DatabaseSync } = await import('node:sqlite');
  /** @type {import('node:sqlite').DatabaseSync|undefined} */
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    const { listSiteChecks, getSiteCheck, diffSavedSiteChecks } = await import('../core/site-check-store.js');
    if (rawId !== undefined && rawId !== null && rawCompareId !== undefined && rawCompareId !== null) {
      const diffResult = diffSavedSiteChecks(db, Number(rawId), Number(rawCompareId));
      if (!diffResult) {
        return {
          isError: true,
          text: JSON.stringify({
            error: {
              code: 'not_found',
              message: `Saved site check #${rawId} or baseline #${rawCompareId} not found`,
            },
          }),
        };
      }
      return {
        isError: false,
        text: JSON.stringify({ ...diffResult, dataSource: 'sqlite_readonly' }),
      };
    }
    if (rawId !== undefined && rawId !== null) {
      const saved = getSiteCheck(db, Number(rawId));
      if (!saved) {
        return {
          isError: true,
          text: JSON.stringify({
            error: {
              code: 'not_found',
              message: `Saved site check #${rawId} not found`,
            },
          }),
        };
      }
      return {
        isError: false,
        text: JSON.stringify({ ...saved, dataSource: 'sqlite_readonly' }),
      };
    }
    const items = listSiteChecks(db, {
      domain: typeof args?.domain === 'string' ? args.domain : undefined,
      limit: args?.limit !== undefined && args?.limit !== null ? Number(args.limit) : 25,
    });
    return {
      isError: false,
      text: JSON.stringify({ items, count: items.length, dataSource: 'sqlite_readonly' }),
    };
  } catch (err) {
    const code = err instanceof RangeError ? 'validation' : 'db_error';
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      text: JSON.stringify({ error: { code, message } }),
    };
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
  }
}

/**
 * Open the configured/default local SQLite database read-only and run a Wave 1 forensic analyzer.
 * @param {'attrition'|'memory_vs_search'|'persistence'} kind
 * @param {Record<string, any>} args
 * @param {Record<string, string|undefined>} env
 */
async function runDirectForensics(kind, args, env) {
  const dbPath = resolveLocalDbPath(env);
  if (!existsSync(dbPath)) {
    return {
      isError: true,
      text: JSON.stringify({
        error: {
          code: 'db_unavailable',
          message: 'Hearsay server is not running and no local SQLite database was found at the configured HEARSAY_DB_PATH. Start `node server.js` or set HEARSAY_DB_PATH.',
        },
      }),
    };
  }
  const filters = toForensicFilters(args, kind === 'attrition');
  const { DatabaseSync } = await import('node:sqlite');
  /** @type {import('node:sqlite').DatabaseSync|undefined} */
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    let report;
    if (kind === 'attrition') {
      const { retrievalAttritionReport } = await import('../core/evidence-report.js');
      report = retrievalAttritionReport(db, filters);
    } else if (kind === 'memory_vs_search') {
      const { memoryVsRetrievalDelta } = await import('../core/evidence-report.js');
      report = memoryVsRetrievalDelta(db, filters);
    } else {
      const { citationPersistenceReport } = await import('../core/opportunities.js');
      report = citationPersistenceReport(db, filters);
    }
    return {
      isError: false,
      text: JSON.stringify({ ...report, dataSource: 'sqlite_readonly' }),
    };
  } catch (err) {
    const code = err instanceof RangeError ? 'validation' : 'db_error';
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      text: JSON.stringify({ error: { code, message } }),
    };
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
  }
}

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {boolean} [readOnly]
 * @property {string} description
 * @property {object} inputSchema
 * @property {(args: Record<string, any>) => {method: string, path: string, body?: unknown}} [call]
 * @property {(args: Record<string, any>) => Promise<{isError: boolean, content: {type: string, text: string}[]}>} [local]
 * @property {(args: Record<string, any>, env: Record<string, string|undefined>) => Promise<{isError: boolean, text: string}>} [fallback]
 */

/** @type {Tool[]} */
const TOOLS = [
  {
    name: 'hearsay_research_import',
    description: 'Import a version-one standalone evidence bundle into the connected database. Validates references, sizes and revisions. Idempotent for identical content; external provenance stays separate from native measurements. Does not run providers or apply recommendations.',
    inputSchema: obj({ bundle: { type: 'object', description: 'Complete version-one evidence.json object' } }, ['bundle']),
    call: (a) => ({ method: 'POST', path: '/api/research/import', body: a.bundle }),
  },
  {
    name: 'hearsay_research_list', readOnly: true,
    description: 'List imported standalone research reports with external provenance, optionally filtered by app identity. No provider calls.',
    inputSchema: obj({ app_id: { type: 'string' } }),
    call: (a) => ({ method: 'GET', path: `/api/research${query(a, ['app_id'])}` }),
  },
  {
    name: 'hearsay_research_get', readOnly: true,
    description: 'Read imported evidence, report, competitors, recommendations and captured observations. Host reports cannot claim native runner verification.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1 } }, ['id']),
    call: (a) => ({ method: 'GET', path: `/api/research/${encodeURIComponent(a.id)}` }),
  },
  {
    name: 'hearsay_study_import',
    description: 'Import an agent-led website study snapshot as immutable external provenance. No provider calls, page changes, or native measurement series are created.',
    inputSchema: obj({ snapshot: { type: 'object', description: 'Complete saved study snapshot' } }, ['snapshot']),
    call: (a) => ({ method: 'POST', path: '/api/studies/import', body: a.snapshot }),
  },
  {
    name: 'hearsay_study_list', readOnly: true,
    description: 'List immutable externally imported website studies, optionally filtered by app identity.',
    inputSchema: obj({ app_id: { type: 'string' } }),
    call: (a) => ({ method: 'GET', path: `/api/studies${query(a, ['app_id'])}` }),
  },
  {
    name: 'hearsay_study_get', readOnly: true,
    description: 'Read one imported study snapshot and its deterministic factual report. Search presence, revision exposure, recommendations and business outcomes remain separate.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1 } }, ['id']),
    call: (a) => ({ method: 'GET', path: `/api/studies/${encodeURIComponent(a.id)}` }),
  },
  {
    name: 'hearsay_status',
    readOnly: true,
    description:
      'Check the optional connected Hearsay dashboard: enabled routes, tracked entities, latest run, schedules and API costs. Standalone skill research does not require this server or this tool.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/status' }),
  },
  {
    name: 'hearsay_summary',
    readOnly: true,
    description:
      'Legacy headline AI-visibility numbers for the tracked brand: share of AI voice vs competitors, brand mention rate with 95% confidence interval and n, historical heuristic recommendation rate, per-provider breakdown, open alert count, last run. Use hearsay_stance_rate for a new exact-revision positive-stance rate.',
    inputSchema: obj({ days: DAYS, surface: SURFACE }),
    call: (a) => ({ method: 'GET', path: `/api/summary${query(a, ['days', 'surface'])}` }),
  },
  {
    name: 'hearsay_series_list',
    readOnly: true,
    description: 'List exact measurement series observed in a window, including surface, execution profile, benchmark, analysis revision, search policy, and attempted/comparable/query coverage. Returns the selected default series ID.',
    inputSchema: obj({ days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/series${query(a, ['days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_series_summary',
    readOnly: true,
    description: 'Read headline rates for one exact measurement series. Returns the selected series ID, coverage, positive stance or disclosed legacy method, mention, source, and citation incidence with their denominators.',
    inputSchema: obj({ days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY, series_id: { type: 'string' } }),
    call: (a) => ({ method: 'GET', path: `/api/series/summary${query(a, ['days', 'start', 'end', 'series_id'])}` }),
  },
  {
    name: 'hearsay_series_export',
    readOnly: true,
    description: 'Export answer receipts, stance reviews, and evidence for one exact series and window. Comparable-only mode matches headline answer denominators.',
    inputSchema: obj({ days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY,
      series_id: { type: 'string' }, comparable_only: { type: 'boolean' } }),
    call: (a) => ({ method: 'GET', path: `/api/series/export${query({ ...a,
      eligible: a.comparable_only ? 1 : undefined }, ['days', 'start', 'end', 'series_id', 'eligible'])}` }),
  },
  {
    name: 'hearsay_intent_evidence',
    readOnly: true,
    description: 'Inspect the buyer questions, observed search queries, source observations, final-answer citations, and answer receipts for one intent in an exact measurement series. Query incidence counts distinct answers, and unknown query-to-source associations remain unknown.',
    inputSchema: obj({ series_id: { type: 'string' }, intent_id: { type: 'integer', minimum: 1 },
      days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }, ['intent_id']),
    call: (a) => ({ method: 'GET', path: `/api/series/evidence${query(a,
      ['series_id', 'intent_id', 'days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_answer_evidence',
    readOnly: true,
    description: 'Read the five stored evidence layers for one answer receipt in an exact measurement series, including original wording, search event associations, nullable source links, citations, and capture metadata.',
    inputSchema: obj({ answer_id: { type: 'integer', minimum: 1 }, series_id: { type: 'string' },
      days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }, ['answer_id']),
    call: (a) => ({ method: 'GET', path: `/api/answers/${a.answer_id}/evidence${query(a,
      ['series_id', 'days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_opportunities',
    readOnly: true,
    description: 'Read deterministic opportunity candidates and the reviewed shortlist for one exact measurement series, intent, and UTC window. Findings retain receipt IDs and never trigger a provider call.',
    inputSchema: obj({ series_id: { type: 'string' }, intent_id: { type: 'integer', minimum: 1 },
      days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }, ['series_id', 'intent_id', 'start', 'end']),
    call: (a) => ({ method: 'GET', path: `/api/opportunities${query(a,
      ['series_id', 'intent_id', 'days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_opportunity',
    readOnly: true,
    description: 'Read one saved opportunity with its exact evidence, action history, follow-up plans, baseline snapshots, and review captures. This only reads stored records and never starts a provider run.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1 } }, ['id']),
    call: (a) => ({ method: 'GET', path: `/api/opportunities/${a.id}` }),
  },
  {
    name: 'hearsay_intervention_comparison',
    readOnly: true,
    description: 'Read a descriptive comparison of one saved baseline and review snapshot. Full benchmark is the default; common subset explicitly drops missing prompt cells. Returns counts, coverage, uncertainty intervals, query/source/citation changes, and comparability reasons. It cannot review an action or start a run.',
    inputSchema: obj({ opportunity_id: { type: 'integer', minimum: 1 },
      plan_id: { type: 'integer', minimum: 1 }, snapshot_id: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['full_benchmark', 'common_subset'] } },
    ['opportunity_id', 'plan_id', 'snapshot_id']),
    call: (a) => ({ method: 'GET', path: `/api/opportunities/${a.opportunity_id}/follow-up/${a.plan_id}/reviews/${a.snapshot_id}/comparison${query(a, ['mode'])}` }),
  },
  {
    name: 'hearsay_weekly_review',
    readOnly: true,
    description: 'Read a local seven-day review for one exact historical measurement series and explicit UTC window. Includes collection health, saved evidence and interventions, prioritized work, reported outcomes and costs. Viewing this report does not run providers or claim causation.',
    inputSchema: obj({ series_id: { type: 'string', minLength: 1 }, start: UTC_BOUNDARY,
      end: UTC_BOUNDARY }, ['series_id', 'start', 'end']),
    call: (a) => ({ method: 'GET', path: `/api/weekly-review${query(a, ['series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_opportunity_propose',
    description: 'Save an assistant-authored opportunity proposal from exact scoped answer, query, source, or citation IDs. The server validates every ID and derives observed facts; your hypothesis stays labeled and a human must accept it before it enters the action queue. This never publishes or starts a measurement run.',
    inputSchema: obj({
      series_id: { type: 'string' }, intent_id: { type: 'integer', minimum: 1 },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY,
      evidence: { type: 'array', minItems: 1, items: obj({
        response_id: { type: 'integer', minimum: 1 }, query_id: { type: 'integer', minimum: 1 },
        source_id: { type: 'integer', minimum: 1 }, citation_id: { type: 'integer', minimum: 1 },
      }, ['response_id']) },
      hypothesis: { type: 'string', minLength: 1, maxLength: 2000 },
      suggested_action: { type: 'string', maxLength: 2000 },
      target_url: { type: 'string', maxLength: 2048 },
      product_area: { type: 'string', maxLength: 200 },
      controllability: { type: 'string', enum: ['owned', 'third_party', 'product'] },
      missing_evidence: { type: 'string', maxLength: 1000 },
      claimed_false_or_outdated: { type: 'boolean', description: 'Classify an alleged false or outdated answer claim as verify_claim until the user attaches and reviews authoritative evidence' },
    }, ['series_id', 'intent_id', 'start', 'end', 'evidence', 'hypothesis']),
    call: (a) => ({ method: 'POST', path: '/api/opportunities/propose', body: a }),
  },
  {
    name: 'hearsay_intent_results',
    readOnly: true,
    description:
      'Per-intent mention rates and phrasing spread. Pass series_id for an exact measurement scope; the no-argument response is the older API compatibility view.',
    inputSchema: obj({ days: DAYS, surface: SURFACE, series_id: { type: 'string' },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/intents/results${query(a, ['days', 'surface', 'series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_prompt_results',
    readOnly: true,
    description:
      'Per-prompt mention rates and captured recommendation values. Pass series_id for exact scope. For current corrected stance, use hearsay_series_summary and answer reviews.',
    inputSchema: obj({ days: DAYS, surface: SURFACE, series_id: { type: 'string' },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/prompts/results${query(a, ['days', 'surface', 'series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_answers_search',
    readOnly: true,
    description:
      'Fetch stored AI answer receipts with mention IDs, current effective stance, captured recommendation bit, analysis revision, rule and span, and cited URLs. Pass series_id from hearsay_series_list for an exact measurement scope; comparable_only reconciles with headline answer counts. Paged; limit ≤ 50.',
    inputSchema: obj({
      provider: { type: 'string', enum: ['openai', 'anthropic', 'gemini', 'perplexity'] },
      surface: SURFACE,
      series_id: { type: 'string' },
      comparable_only: { type: 'boolean' },
      entity_id: { type: 'integer', minimum: 1 },
      prompt_id: { type: 'integer', minimum: 1 },
      days: DAYS,
      start: UTC_BOUNDARY,
      end: UTC_BOUNDARY,
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
    call: (a) => ({ method: 'GET', path: `/api/answers${query({ ...a,
      eligible: a.comparable_only ? 1 : undefined },
    ['provider', 'surface', 'series_id', 'eligible', 'entity_id', 'prompt_id', 'days', 'start', 'end', 'page', 'limit'], { limit: 'per' })}` }),
  },
  {
    name: 'hearsay_answer_review',
    readOnly: true,
    description: 'Inspect a stored answer and its immutable stance rule, answer span, analysis revision, correction history, and effective label at an optional correction cutoff. Legacy heuristic values are disclosed separately.',
    inputSchema: obj({ answer_id: { type: 'integer', minimum: 1 }, revision: { type: 'string' }, cutoff: { type: 'integer', minimum: 0 } }, ['answer_id']),
    call: (a) => ({ method: 'GET', path: `/api/answers/${a.answer_id}/review${query(a, ['revision', 'cutoff'])}` }),
  },
  {
    name: 'hearsay_correct_stance',
    description: 'Append a human stance correction with a reason and the last correction ID seen in hearsay_answer_review. The original answer and automatic label remain intact.',
    inputSchema: obj({
      answer_id: { type: 'integer', minimum: 1 }, interpretation_id: { type: 'integer', minimum: 1 },
      previous_correction_id: { type: ['integer', 'null'], minimum: 1 },
      replacement: { type: 'string', enum: ['positive', 'negative', 'neutral', 'uncertain'] },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      request_id: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['answer_id', 'interpretation_id', 'replacement', 'reason', 'request_id']),
    call: (a) => ({ method: 'POST', path: `/api/answers/${a.answer_id}/corrections`, body: {
      interpretation_id: a.interpretation_id, previous_correction_id: a.previous_correction_id ?? null,
      replacement: a.replacement, reason: a.reason, request_id: a.request_id,
    } }),
  },
  {
    name: 'hearsay_stance_rate',
    readOnly: true,
    description: 'Positive-stance rate and negative, neutral, uncertain, and absent counts for an exact surface and capture-time analysis revision at a correction cutoff.',
    inputSchema: obj({ surface: SURFACE, entity_id: { type: 'integer', minimum: 1 }, revision: { type: 'string' },
      comparison_key: { type: 'string' }, cutoff: { type: 'integer', minimum: 0 }, days: DAYS },
      ['surface', 'entity_id', 'revision']),
    call: (a) => ({ method: 'GET', path: `/api/stance-rate${query(a, ['surface', 'entity_id', 'revision', 'comparison_key', 'cutoff', 'days'])}` }),
  },
  {
    name: 'hearsay_citation_gap',
    readOnly: true,
    description:
      'Domains in legacy citation rows for comparable answers without the tracked brand. Pass series_id to limit results to an exact measurement series; source observations and final-answer citations are separate layers in hearsay_series_summary.',
    inputSchema: obj({ days: DAYS, surface: SURFACE, series_id: { type: 'string' },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/gap${query(a, ['days', 'surface', 'series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_alerts',
    readOnly: true,
    description:
      'List saved alerts. New-series alerts describe measurement health and changed collection conditions. Historical heuristic recommendation and mention alerts remain labeled legacy context; inspect their receipts before drawing a conclusion. open_only=true (default) shows unacknowledged alerts.',
    inputSchema: obj({ open_only: { type: 'boolean', description: 'Default true' } }),
    call: (a) => ({ method: 'GET', path: `/api/alerts?open=${a?.open_only === false ? '0' : '1'}` }),
  },
  {
    name: 'hearsay_cost_estimate',
    readOnly: true,
    description:
      'Preview exact API targets, route budgets, priced components, and unknown costs before spending anything. The computed estimate uses a checked price table and is not an invoice or a hard dollar cap.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/cost/estimate' }),
  },
  {
    name: 'hearsay_suggest_prompts',
    description:
      'Return five editable buyer intent groups with three complete phrasings each. This is a local, zero-usage draft; no provider key or measurement route is needed. Show the exact wording to the human before tracking.',
    inputSchema: obj({
      audience: { type: 'string', description: 'Who is making the buying decision' },
      product_job: { type: 'string', description: 'Product or job the buyer needs done' },
      desired_conversion: { type: 'string', description: 'Action the buyer should take' },
    }),
    call: (a) => ({ method: 'POST', path: '/api/prompts/suggest', body: {
      context: { audience: a?.audience, productJob: a?.product_job, desiredConversion: a?.desired_conversion },
    } }),
  },
  {
    name: 'hearsay_setup_tracking',
    description:
      'Set up brand, competitors, and buyer questions in one transaction. Only use for exact questions the human reviewed in this conversation; set reviewed=true explicitly. A new draft/review/approval workflow is available through hearsay_create_benchmark_draft, hearsay_review_benchmark_draft, and hearsay_approve_benchmark_draft. No measurement route is needed to draft.',
    inputSchema: obj({
      brand: obj(ENTITY_FIELDS),
      competitors: { type: 'array', items: obj(ENTITY_FIELDS) },
      intents: {
        type: 'array',
        items: obj(
          {
            label: { type: 'string', description: 'The underlying question, e.g. "best AI meeting notes tool"' },
            category: { type: 'string', enum: ['general', 'comparison', 'use-case', 'local', 'pricing', 'branded'] },
            paraphrases: { type: 'array', items: { type: 'string' }, description: 'Phrasings of this question (≥1, ≤300 chars each)' },
          },
          ['label', 'paraphrases'],
        ),
      },
      reviewed: { type: 'boolean', description: 'True only after the human reviewed every exact tracking question' },
    }),
    call: (a) => ({ method: 'POST', path: '/api/setup', body: a ?? {} }),
  },
  {
    name: 'hearsay_create_benchmark_draft',
    description: 'Save a buyer-focused benchmark draft without running or approving it. Include buyer context, optional brand/competitors, intent groups, and per-question source notes. Source notes stay local.',
    inputSchema: obj({ payload: { type: 'object', description: 'Draft payload: version 1, context, optional brand and competitors, intents with label/category/paraphrases containing text, sourceNote, selected' } }, ['payload']),
    call: (a) => ({ method: 'POST', path: '/api/setup/drafts', body: { payload: a?.payload } }),
  },
  {
    name: 'hearsay_review_benchmark_draft',
    readOnly: true,
    description: 'Review the exact selected questions, validation problems, category counts, and zero-spend run target count. Relay this review to the human before approval.',
    inputSchema: obj({ draft_id: { type: 'integer', minimum: 1 } }, ['draft_id']),
    call: (a) => ({ method: 'GET', path: `/api/setup/drafts/${a?.draft_id}/review` }),
  },
  {
    name: 'hearsay_approve_benchmark_draft',
    description: 'Approve the exact draft revision and review hash after the human has reviewed its questions. This atomically activates tracking questions but does not start a measurement run.',
    inputSchema: obj({ draft_id: { type: 'integer', minimum: 1 }, revision: { type: 'integer', minimum: 1 }, review_hash: { type: 'string' }, approve: { type: 'boolean' } },
      ['draft_id', 'revision', 'review_hash', 'approve']),
    call: (a) => ({ method: 'POST', path: `/api/setup/drafts/${a?.draft_id}/approve`, body: {
      revision: a?.revision, review_hash: a?.review_hash, approve: a?.approve,
    } }),
  },
  {
    name: 'hearsay_run_panel',
    description:
      'Start a measurement panel run (every active prompt × enabled provider × samples) using the user’s own API keys. If a quote is required, relay it to the human and retry with confirm:true and its quoteId as quote_id after approval. A changed selection invalidates the quote.',
    inputSchema: obj({ confirm: { type: 'boolean', description: 'true = the human approved the quoted cost in this conversation' }, quote_id: { type: 'string', description: 'quoteId returned by the approved preview' } }),
    call: (a) => ({ method: 'POST', path: '/api/run', body: { confirm: a?.confirm === true, quote_id: a?.quote_id } }),
  },
  {
    name: 'hearsay_api_search_schedule',
    description:
      'Preview, enable, or disable web search on the existing daily API panel. Enabling needs a separate approved quote and a target ceiling. Without this consent, daily API runs keep their search-off route even if on-demand search is configured.',
    inputSchema: obj({
      action: { type: 'string', enum: ['preview', 'enable', 'disable'] },
      target_ceiling: { type: 'integer', minimum: 1 },
      confirm: { type: 'boolean' },
      quote_id: { type: 'string', description: 'quoteId returned by the approved schedule preview' },
    }, ['action']),
    call: (a) => a?.action === 'disable'
      ? ({ method: 'DELETE', path: '/api/search-schedule' })
      : ({ method: 'POST', path: '/api/search-schedule', body: {
          target_ceiling: a?.target_ceiling,
          confirm: a?.action === 'enable' && a?.confirm === true,
          quote_id: a?.quote_id,
        } }),
  },
  {
    name: 'hearsay_subscription_preview',
    readOnly: true,
    description:
      'Preview an explicitly selected Codex agent or Claude Code agent measurement: prompts, samples, exact target count, process limits, first-use consent, and included-plan/overage usage. Internal CLI web-search calls have no enforceable ceiling. This never starts a CLI or model request.',
    inputSchema: obj({ surfaces: SUBSCRIPTION_SURFACES, lane: SUBSCRIPTION_LANE, prompt_ids: { type: 'array', items: { type: 'integer', minimum: 1 } }, samples: { type: 'integer', minimum: 1, maximum: 10 } }),
    call: (a) => ({ method: 'POST', path: '/api/subscription/preview', body: { surfaces: a?.surfaces, lane: a?.lane, prompt_ids: a?.prompt_ids, samples: a?.samples } }),
  },
  {
    name: 'hearsay_subscription_run',
    description:
      'Run explicitly selected Codex agent or Claude Code agent buyer-angle prompts through the user’s authenticated subscription CLI. For first-use consent, pass the approved quoteId as quote_id with confirm:true. Results retain final answer, verified web-search events, citations, redacted artifact metadata, and comparability status separately from API runs.',
    inputSchema: obj({ surfaces: SUBSCRIPTION_SURFACES, lane: SUBSCRIPTION_LANE, prompt_ids: { type: 'array', items: { type: 'integer', minimum: 1 } }, samples: { type: 'integer', minimum: 1, maximum: 10 }, confirm: { type: 'boolean' }, quote_id: { type: 'string' } }),
    call: (a) => ({ method: 'POST', path: '/api/subscription/run', body: { surfaces: a?.surfaces, lane: a?.lane, prompt_ids: a?.prompt_ids, samples: a?.samples, confirm: a?.confirm === true, quote_id: a?.quote_id } }),
  },
  {
    name: 'hearsay_subscription_schedule',
    description:
      'Preview, enable, or disable the persistent local-time subscription-agent schedule. Enabling is a separate consent from an on-demand run, requires a target ceiling and a completed verified on-demand run for each selected surface, and records missed occurrences instead of silently replaying them after downtime.',
    inputSchema: obj({
      action: { type: 'string', enum: ['preview', 'enable', 'disable'] },
      run_at: { type: 'string', description: 'Local HH:MM' },
      timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/Berlin' },
      surfaces: SUBSCRIPTION_SURFACES,
      lane: SUBSCRIPTION_LANE,
      prompt_ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
      samples: { type: 'integer', minimum: 1, maximum: 10 },
      target_ceiling: { type: 'integer', minimum: 1 },
      grace_minutes: { type: 'integer', minimum: 0, maximum: 1440 },
      confirm: { type: 'boolean' },
      quote_id: { type: 'string', description: 'quoteId returned by the approved schedule preview' },
    }, ['action']),
    call: (a) => a?.action === 'disable'
      ? ({ method: 'DELETE', path: '/api/subscription/schedule' })
      : ({ method: 'POST', path: '/api/subscription/schedule', body: {
          run_at: a?.run_at,
          timezone: a?.timezone,
          surfaces: a?.surfaces,
          lane: a?.lane,
          prompt_ids: a?.prompt_ids,
          samples: a?.samples,
          target_ceiling: a?.target_ceiling,
          grace_minutes: a?.grace_minutes,
          confirm: a?.action === 'enable' && a?.confirm === true,
          quote_id: a?.quote_id,
        } }),
  },
  {
    name: 'hearsay_exploration_create',
    description:
      'Persist one buyer-angle exploration question as inactive discovery evidence. The question is not added to the approved tracking panel until a human explicitly promotes it.',
    inputSchema: obj({ text: { type: 'string', minLength: 1, maxLength: 300 }, category: { type: 'string' }, origin: { type: 'string', enum: ['user_authored', 'suggested', 'imported'] } }, ['text']),
    call: (a) => ({ method: 'POST', path: '/api/prompts/exploration', body: { text: a?.text, category: a?.category, origin: a?.origin ?? 'user_authored' } }),
  },
  {
    name: 'hearsay_exploration_promote',
    description:
      'Promote an inactive exploration question only after the human reviews its exact wording and target intent. Historical responses keep their original exploration lane and prompt snapshot.',
    inputSchema: obj({ prompt_id: { type: 'integer', minimum: 1 }, intent_id: { type: 'integer', minimum: 1 }, reviewed: { type: 'boolean' } }, ['prompt_id', 'intent_id', 'reviewed']),
    call: (a) => ({ method: 'POST', path: `/api/prompts/${Number(a?.prompt_id)}/promote`, body: { intent_id: Number(a?.intent_id), reviewed: a?.reviewed } }),
  },
  {
    name: 'hearsay_run_status',
    readOnly: true,
    description:
      'Progress of the latest measurement run: status (running/done/failed), done_calls/total_calls, timestamps. Poll this after hearsay_run_panel starts a run. Returns no_runs if the instance has never run a panel.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/runs/latest' }),
  },
  {
    name: 'hearsay_ack_alert',
    description:
      'Acknowledge one alert by id so it leaves the open list. Use after the human has seen the alert and decided what to do about it.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1, description: 'Alert id from hearsay_alerts' } }, ['id']),
    call: (a) => ({ method: 'POST', path: `/api/alerts/${Number(a.id)}/ack`, body: {} }),
  },
  {
    name: 'hearsay_site_check',
    readOnly: true,
    description:
      'Run Hearsay v2 zero-key AI Crawler X-Ray audit directly on any public http/https URL (zero local server or API keys required). Supports default multi-page key-page crawling (or single-page mode), 18-bot RFC 9309 + Content-Signal robots.txt policy analysis, passive stack/CDN/WAF fingerprinting, Accept: text/markdown negotiation, /llms.txt soft-404 probe, optional conditional GET 304 caching check, optional headless browser Bot-vs-Human Markdown diff, and parallel --vs Competitor X-Ray comparison. Strictly enforces SSRF private-host guard.',
    inputSchema: obj(
      {
        url: { type: 'string', minLength: 1, description: 'Public http:// or https:// URL to audit' },
        single: { type: 'boolean', description: 'Audit only the target URL instead of multi-page key-page crawl (default false)' },
        maxPages: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum key pages to audit in crawl mode (default 15)' },
        max_pages: { type: 'integer', minimum: 1, maximum: 50, description: 'Alias for maxPages' },
        vs: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 5,
          description: 'Optional competitor URLs (up to 5) for side-by-side Competitor X-Ray comparison',
        },
        browser: { type: 'boolean', description: 'Compare raw HTML against optional local headless Chromium DOM (default false)' },
        checkCaching: { type: 'boolean', description: 'Perform conditional GET (If-None-Match / If-Modified-Since) 304 check on homepage (default false)' },
        check_caching: { type: 'boolean', description: 'Alias for checkCaching' },
        ignoreRobotsForOwnSite: {
          type: 'boolean',
          description: 'Audit own-site pages disallowed by robots.txt while still flagging the rule (default false)',
        },
        ignore_robots_for_own_site: { type: 'boolean', description: 'Alias for ignoreRobotsForOwnSite' },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 120000, description: 'Per-request timeout in milliseconds (default 10000)' },
        timeout_ms: { type: 'integer', minimum: 500, maximum: 120000, description: 'Alias for timeoutMs' },
      },
      ['url'],
    ),
    local: (a) => runDirectSiteCheck(a),
  },
  {
    name: 'hearsay_site_check_history',
    readOnly: true,
    description:
      'List saved site-check drift history (optionally filtered by domain), load one saved site check report by ID, or diff two saved site checks (`id` vs `compareWithId`) to detect new critical findings, status regressions, prose-parity drops, and newly blocked AI crawlers. Queries the local server when running or falls back directly to read-only SQLite.',
    inputSchema: obj({
      domain: { type: 'string', description: 'Optional domain filter when listing saved site checks (e.g. "example.com")' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum saved checks to return when listing (default 25)' },
      id: { type: 'integer', minimum: 1, description: 'Saved site check ID to load, or the current check ID when compareWithId is also provided' },
      compareWithId: { type: 'integer', minimum: 1, description: 'Baseline saved site check ID to diff against id' },
      compare_with_id: { type: 'integer', minimum: 1, description: 'Alias for compareWithId' },
    }),
    call: (a) => {
      const baselineId = a?.compareWithId ?? a?.compare_with_id;
      if (a?.id !== undefined && a?.id !== null && baselineId !== undefined && baselineId !== null) {
        return {
          method: 'GET',
          path: `/api/check/diff?current=${encodeURIComponent(String(a.id))}&baseline=${encodeURIComponent(String(baselineId))}`,
        };
      }
      if (baselineId !== undefined && baselineId !== null) {
        return {
          method: 'GET',
          path: `/api/check/diff?baseline=${encodeURIComponent(String(baselineId))}`,
        };
      }
      if (a?.id !== undefined && a?.id !== null) {
        return { method: 'GET', path: `/api/check/${encodeURIComponent(String(a.id))}` };
      }
      return { method: 'GET', path: `/api/check/history${query(a, ['domain', 'limit'])}` };
    },
    fallback: (a, env) => runDirectSiteCheckHistory(a, env),
  },
  {
    name: 'hearsay_retrieval_attrition',
    readOnly: true,
    description:
      'Analyze Retrieved-but-Dropped URL attrition and Own-Site Hijacks across search-grounded answers: compares retrieved source observations against final answer citations by ownership (brand_owned, competitor_owned, third_party) with Wilson 95% CIs, and flags answers where your site was cited while a competitor was positively recommended. Queries the local server when running or falls back directly to read-only SQLite.',
    inputSchema: obj({
      ...FORENSICS_FILTER_PROPERTIES,
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum top dropped/cited URLs to return (default 25)' },
    }),
    call: (a) => ({ method: 'GET', path: `/api/forensics/attrition${forensicsQuery(a, true)}` }),
    fallback: (a, env) => runDirectForensics('attrition', a, env),
  },
  {
    name: 'hearsay_memory_vs_search',
    readOnly: true,
    description:
      'Compare parametric model memory (search off / no search used) against verified live web-search retrieval strictly paired on identical prompts within the exact same (provider, model). Classifies brand prompts as memory_anchored, search_dependent, memory_displaced, or absent_in_both with Wilson 95% CIs. Queries the local server when running or falls back directly to read-only SQLite.',
    inputSchema: obj(FORENSICS_FILTER_PROPERTIES),
    call: (a) => ({ method: 'GET', path: `/api/forensics/memory-vs-search${forensicsQuery(a)}` }),
    fallback: (a, env) => runDirectForensics('memory_vs_search', a, env),
  },
  {
    name: 'hearsay_citation_persistence',
    readOnly: true,
    description:
      'Measure multi-wave citation persistence across completed measurement runs and rank persistent third-party off-site outreach targets where competitors are recommended and your brand is absent. Classifies URLs and domains as durable, recurring, ephemeral, or single_wave_unverified with offSiteShare and Wilson 95% CIs. Queries the local server when running or falls back directly to read-only SQLite.',
    inputSchema: obj(FORENSICS_FILTER_PROPERTIES),
    call: (a) => ({ method: 'GET', path: `/api/forensics/persistence${forensicsQuery(a)}` }),
    fallback: (a, env) => runDirectForensics('persistence', a, env),
  },
];

/** @param {unknown} id @param {object} result */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
/** @param {unknown} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

/** @param {{id?: unknown, method?: string, params?: any}} msg */
async function dispatch(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'initialize': {
        const asked = String(params?.protocolVersion ?? '');
        reply(id, {
          protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : KNOWN_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'hearsay', version: VERSION },
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'notifications/initialized':
        return; // acknowledged silently
      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.readOnly ? { annotations: { readOnlyHint: true, idempotentHint: true } } : {}),
          })),
        });
        return;
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          replyError(id, -32602, `Unknown tool: ${params?.name}`);
          return;
        }
        const args = params?.arguments ?? {};
        if (typeof tool.local === 'function') {
          const localResult = await tool.local(args);
          reply(id, {
            content: localResult.content,
            ...(localResult.isError ? { isError: true } : {}),
          });
          return;
        }
        const req = /** @type {NonNullable<Tool['call']>} */ (tool.call)(args);
        /** @param {boolean} isError @param {string} text */
        const content = (isError, text) =>
          reply(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
        const env = withEnvFile(process.env, resolve(REPO_ROOT, '.env'));
        const backend = resolveHearsayUrl(env);
        if (backend.url === null) {
          if (typeof tool.fallback === 'function') {
            const fb = await tool.fallback(args, env);
            content(fb.isError, fb.text);
            return;
          }
          content(true, JSON.stringify({ error: { code: 'unreachable', message: backend.message } }));
          return;
        }
        const controller = new AbortController();
        // Armed until the BODY is read, not just the headers — a backend that stalls
        // mid-stream must abort res.text(), not hang the reply (and the drain-on-end
        // exit) forever. Cleared in finally so a rejected fetch cannot leak the timer.
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(backend.url + req.path, {
            method: req.method,
            headers: req.body === undefined ? {} : { 'content-type': 'application/json' },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
            signal: controller.signal,
          });
          const text = await res.text();
          if (!res.ok && res.status === 404 && typeof tool.fallback === 'function') {
            const fb = await tool.fallback(args, env);
            content(fb.isError, fb.text);
            return;
          }
          content(!res.ok, text);
        } catch (err) {
          const timedOut = controller.signal.aborted;
          if (!timedOut && typeof tool.fallback === 'function') {
            const fb = await tool.fallback(args, env);
            content(fb.isError, fb.text);
            return;
          }
          content(
            true,
            JSON.stringify({
              error: timedOut
                ? { code: 'timeout', message: `Hearsay at ${backend.url} did not answer within ${TIMEOUT_MS}ms` }
                : { code: 'unreachable', message: `Hearsay not reachable at ${backend.url} — is \`node server.js\` running?` },
            }),
          );
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    process.stderr.write(`[hearsay-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    if (!isNotification) replyError(id, -32603, 'Internal error');
  }
}

let buffer = '';
/** In-flight dispatches — piped stdin closes before async tools/call replies land. @type {Set<Promise<void>>} */
const inflight = new Set();
process.stdin.setEncoding('utf8');
/**
 * Parse and dispatch one newline-delimited JSON-RPC line. Never throws, never leaves an
 * unhandled rejection: a malformed line gets a protocol error reply, not a dead session.
 * @param {string} line
 * @returns {void}
 */
function handleLine(line) {
  /** @type {unknown} */
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  if (msg === null || typeof msg !== 'object') {
    // Valid JSON, invalid Request — e.g. the line `null`, which destructuring would
    // otherwise turn into an unhandled rejection that kills the whole session.
    replyError(null, -32600, 'Invalid Request');
    return;
  }
  // JSON-RPC batches: the 2025-03-26 MCP revision (which we offer in initialize)
  // required servers to accept them. Unroll and dispatch individually — replies go out
  // as separate ndjson lines, which stdio clients correlate by id.
  const msgs = Array.isArray(msg) ? msg : [msg];
  if (msgs.length === 0) {
    replyError(null, -32600, 'Invalid Request');
    return;
  }
  for (const one of msgs) {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) {
      replyError(null, -32600, 'Invalid Request');
      continue;
    }
    const p = dispatch(/** @type {{id?: unknown, method?: string, params?: any}} */ (one));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line !== '') handleLine(line);
  }
});
process.stdin.on('end', () => {
  // A final record without a trailing newline is still a request — flush it first.
  const residue = buffer.trim();
  buffer = '';
  if (residue !== '') handleLine(residue);
  // Drain before exiting: every request read from stdin gets its reply written.
  void Promise.allSettled([...inflight]).then(() => process.exit(0));
});
