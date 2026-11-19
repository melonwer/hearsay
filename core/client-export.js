/**
 * Self-contained B2B Client Report HTML export.
 *
 * Pure read-only aggregation over exact measurement series, Wilson 95% confidence
 * intervals, competitor citation gaps, verbatim answer receipts, and recorded
 * interventions / business outcomes. Zero secrets, zero local filesystem paths,
 * zero external network dependencies.
 */

import { isAgentSurface } from './agent-routes.js';
import { entityForDomain } from './analyze.js';
import { all, getSetting, SETTING_KEYS } from './db.js';
import { memoryVsRetrievalDelta, retrievalAttritionReport } from './evidence-report.js';
import * as metrics from './metrics.js';
import { citationPersistenceReport, listOpportunities } from './opportunities.js';
import { listLedgerEntries, listOutcomeRecords } from './outcomes.js';
import { surfaceLabel } from './subscription-model.js';
import { brandEntity, listEntities, queryAnswers, windowStart } from '../web/queries.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./metrics.js').MeasurementSeries} MeasurementSeries */
/** @typedef {{brandLabel?: string|null, accentColor?: string|null, footerNote?: string|null, brand_label?: string|null, accent_color?: string|null, footer_note?: string|null}} WhiteLabelInput */
/** @typedef {{brandLabel: string|null, accentColor: string|null, footerNote: string|null}} SanitizedWhiteLabel */

const DEFAULT_REPORT_DAYS = 30;
const DEFAULT_RECEIPT_LIMIT = 50;
const MAX_RECEIPT_LIMIT = 200;
const ACCENT_HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const VALID_CSS_HEX_LENGTHS = new Set([3, 4, 6, 8]);

const PROVIDER_LABELS = /** @type {Record<string, string>} */ ({
  openai: 'ChatGPT (OpenAI)',
  anthropic: 'Claude (Anthropic)',
  gemini: 'Gemini (Google)',
  perplexity: 'Perplexity',
});

/**
 * Strict HTML escaping for text nodes and quoted attributes.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Strictly sanitize optional white-label options.
 * - `brandLabel` and `footerNote` are bounded strings (HTML-escaped at render time).
 * - `accentColor` is validated strictly against `/^#[0-9a-fA-F]{3,8}$/` (CSS hex lengths 3/4/6/8)
 *   to prevent CSS injection; any invalid color is discarded (`null`).
 *
 * @param {WhiteLabelInput|null|undefined} [opts]
 * @returns {SanitizedWhiteLabel}
 */
export function sanitizeWhiteLabelOptions(opts = {}) {
  const input = opts && typeof opts === 'object' ? opts : {};
  const rawLabel = input.brandLabel ?? input.brand_label;
  const rawAccent = input.accentColor ?? input.accent_color;
  const rawFooter = input.footerNote ?? input.footer_note;

  const brandLabel =
    typeof rawLabel === 'string' && rawLabel.trim() !== ''
      ? rawLabel.trim().slice(0, 120)
      : null;

  const footerNote =
    typeof rawFooter === 'string' && rawFooter.trim() !== ''
      ? rawFooter.trim().slice(0, 300)
      : null;

  let accentColor = null;
  if (typeof rawAccent === 'string') {
    const trimmed = rawAccent.trim();
    if (ACCENT_HEX_RE.test(trimmed) && VALID_CSS_HEX_LENGTHS.has(trimmed.length - 1)) {
      accentColor = trimmed;
    }
  }

  return { brandLabel, accentColor, footerNote };
}

/**
 * Convert a validated hex color string (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`)
 * into an `rgba(r, g, b, alpha)` CSS color string.
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
function hexToRgba(hex, alpha) {
  const raw = hex.slice(1);
  let r = 59;
  let g = 130;
  let b = 246;
  if (raw.length === 3 || raw.length === 4) {
    r = Number.parseInt(raw[0] + raw[0], 16);
    g = Number.parseInt(raw[1] + raw[1], 16);
    b = Number.parseInt(raw[2] + raw[2], 16);
  } else if (raw.length === 6 || raw.length === 8) {
    r = Number.parseInt(raw.slice(0, 2), 16);
    g = Number.parseInt(raw.slice(2, 4), 16);
    b = Number.parseInt(raw.slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Validate that a URL uses http: or https: before rendering it in an href attribute.
 * @param {unknown} rawUrl
 * @returns {string|null}
 */
function safeHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Extract a normalized domain from a URL string.
 * @param {string} rawUrl
 * @returns {string}
 */
function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(rawUrl ?? '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .replace(/^www\./, '');
  }
}

/**
 * Format a 0..1 proportion as a percentage string.
 * @param {number|null|undefined} p
 * @param {number} [digits]
 * @returns {string}
 */
function fmtPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

/**
 * Format a Wilson rate with 95% confidence interval and sample count.
 * @param {{p: number|null, n: number, lo?: number|null, hi?: number|null}|null|undefined} rate
 * @returns {string}
 */
function fmtRateSummary(rate) {
  if (!rate || rate.p === null || rate.p === undefined || !Number.isFinite(rate.p)) {
    return `— (n=${Number(rate?.n ?? 0)})`;
  }
  const hasBounds =
    typeof rate.lo === 'number' &&
    typeof rate.hi === 'number' &&
    Number.isFinite(rate.lo) &&
    Number.isFinite(rate.hi);
  const bounds = hasBounds ? ` [${fmtPct(rate.lo)}–${fmtPct(rate.hi)}]` : '';
  return `${fmtPct(rate.p)}${bounds} · n=${rate.n}`;
}

/**
 * Compute per-entity mention rate, recommendation rate, and average rank across a single
 * exact measurement series in one pass so multi-entity leaderboards render in milliseconds
 * even on multi-thousand-answer datasets while matching `core/metrics.js` identically.
 *
 * @param {Db} db
 * @param {MeasurementSeries} series
 * @param {number[]} entityIds
 */
function batchEntitySeriesMetrics(db, series, entityIds) {
  const includeBranded = Boolean(getSetting(db, SETTING_KEYS.INCLUDE_BRANDED_IN_SOV, false));
  const useStance =
    Boolean(series.analysisRevision) && series.analysisRevision !== 'legacy-heuristic-v1';

  /** @type {string[]} */
  const clauses = [
    'r.created_at >= ?',
    'r.created_at < ?',
    'r.surface = ?',
    'r.execution_profile_id IS ?',
    'r.benchmark_revision_id IS ?',
    'r.analysis_revision IS ?',
    'r.comparison_key IS ?',
    'r.search_policy IS ?',
    "r.lane = 'tracking'",
    "r.target_status = 'completed'",
    "r.comparability_status = 'comparable'",
    'r.error IS NULL',
    'r.text IS NOT NULL',
    "trim(r.text) <> ''",
    "(r.answer_status = 'complete' OR r.answer_status IS NULL)",
  ];
  /** @type {(string|number|null)[]} */
  const params = [
    series.start,
    series.end,
    series.surface,
    series.executionProfileId,
    series.benchmarkRevisionId,
    series.analysisRevision,
    series.comparisonKey,
    series.searchPolicy,
  ];
  if (series.searchPolicy === 'required' || isAgentSurface(series.surface)) {
    clauses.push("r.web_status = 'verified'");
  }
  if (!includeBranded) {
    clauses.push("p.category <> 'branded'");
  }

  const eligibleRows = all(
    db,
    `SELECT r.id, r.analysis_revision
       FROM responses r
       JOIN prompts p ON p.id = r.prompt_id
      WHERE ${clauses.join(' AND ')}`,
    params,
  );
  const totalN = eligibleRows.length;
  const legacyN = eligibleRows.filter(
    (r) => r.analysis_revision === null || r.analysis_revision === 'legacy-heuristic-v1',
  ).length;
  const stanceN = useStance
    ? eligibleRows.filter((r) => r.analysis_revision === series.analysisRevision).length
    : 0;
  const eligibleIds = eligibleRows.map((r) => Number(r.id));

  /** @type {Map<number, {id: number, stance: string}>} */
  const interpByMention = new Map();
  if (useStance && series.analysisRevision && eligibleIds.length > 0) {
    const correctionsByInterp = new Map();
    for (const c of all(
      db,
      'SELECT id, interpretation_id, replacement FROM mention_corrections ORDER BY id ASC',
    )) {
      correctionsByInterp.set(Number(c.interpretation_id), String(c.replacement));
    }
    for (const row of all(
      db,
      'SELECT id, mention_id, stance FROM mention_interpretations WHERE analysis_revision = ?',
      [series.analysisRevision],
    )) {
      const iid = Number(row.id);
      const effectiveStance = correctionsByInterp.get(iid) ?? String(row.stance);
      interpByMention.set(Number(row.mention_id), { id: iid, stance: effectiveStance });
    }
  }

  /**
   * @type {Map<number, {
   *   mentionedResponses: Set<number>,
   *   legacyRecResponses: Set<number>,
   *   firstMentionByResponse: Map<number, number>,
   *   rankSum: number,
   *   rankCount: number
   * }>}
   */
  const buckets = new Map();
  for (const eid of entityIds) {
    buckets.set(eid, {
      mentionedResponses: new Set(),
      legacyRecResponses: new Set(),
      firstMentionByResponse: new Map(),
      rankSum: 0,
      rankCount: 0,
    });
  }

  for (let offset = 0; offset < eligibleIds.length; offset += 400) {
    const chunk = eligibleIds.slice(offset, offset + 400);
    const ph = chunk.map(() => '?').join(',');
    for (const m of all(
      db,
      `SELECT id, response_id, entity_id, rank, recommended
         FROM mentions
        WHERE response_id IN (${ph})
        ORDER BY id ASC`,
      chunk,
    )) {
      const bucket = buckets.get(Number(m.entity_id));
      if (!bucket) continue;
      const rid = Number(m.response_id);
      const mid = Number(m.id);
      bucket.mentionedResponses.add(rid);
      if (Number(m.recommended) === 1) bucket.legacyRecResponses.add(rid);
      if (!bucket.firstMentionByResponse.has(rid)) {
        bucket.firstMentionByResponse.set(rid, mid);
      }
      if (m.rank !== null && m.rank !== undefined) {
        bucket.rankSum += Number(m.rank);
        bucket.rankCount += 1;
      }
    }
  }

  /**
   * @type {Map<number, {
   *   mentionRate: ReturnType<typeof metrics.wilson>,
   *   recommendationRate: {n: number, recommended: number, p: number|null, lo: number|null, hi: number|null, lowSample: boolean},
   *   avgRank: number|null
   * }>}
   */
  const out = new Map();
  for (const [eid, bucket] of buckets.entries()) {
    const mentionStat = metrics.wilson(bucket.mentionedResponses.size, totalN);
    let recStat;
    if (useStance) {
      let positive = 0;
      for (const mid of bucket.firstMentionByResponse.values()) {
        const interp = interpByMention.get(mid);
        if (interp?.stance === 'positive') positive += 1;
      }
      const w = metrics.wilson(positive, stanceN);
      recStat = {
        n: stanceN,
        recommended: positive,
        p: w.p,
        lo: w.lo,
        hi: w.hi,
        lowSample: w.lowSample,
      };
    } else {
      const recommended = bucket.legacyRecResponses.size;
      const w = metrics.wilson(recommended, legacyN);
      recStat = {
        n: legacyN,
        recommended,
        p: w.p,
        lo: w.lo,
        hi: w.hi,
        lowSample: w.lowSample,
      };
    }
    const avgRank = bucket.rankCount > 0 ? bucket.rankSum / bucket.rankCount : null;
    out.set(eid, { mentionRate: mentionStat, recommendationRate: recStat, avgRank });
  }
  return { useStance, statsByEntity: out, eligibleIds };
}

/**
 * Compute brand-owned domain citation rate across the exact eligible response IDs of
 * the selected measurement series (checks both `answer_citations` and legacy `citations`).
 *
 * @param {Db} db
 * @param {number[]} eligibleIds
 * @param {{id: number, name: string, aliases?: string[], domains: string[]}|null} brand
 */
function queryBrandCitationRate(db, eligibleIds, brand) {
  const totalN = eligibleIds.length;
  const domains = (brand?.domains ?? []).map((d) => extractDomain(d)).filter(Boolean);
  if (!brand || domains.length === 0) {
    return {
      brandDomainsConfigured: false,
      citationRate: { ...metrics.wilson(0, totalN), cited: 0 },
    };
  }
  const brandEntityList = [{ id: brand.id, name: brand.name, aliases: brand.aliases ?? [], domains }];
  /** @type {Set<number>} */
  const citedResponses = new Set();

  for (let offset = 0; offset < eligibleIds.length; offset += 400) {
    const chunk = eligibleIds.slice(offset, offset + 400);
    const ph = chunk.map(() => '?').join(',');

    for (const row of all(
      db,
      `SELECT response_id, url FROM answer_citations WHERE response_id IN (${ph})`,
      chunk,
    )) {
      const domain = extractDomain(String(row.url ?? ''));
      if (domain && entityForDomain(domain, brandEntityList) === brand.id) {
        citedResponses.add(Number(row.response_id));
      }
    }

    for (const row of all(
      db,
      `SELECT response_id, url, domain, entity_id FROM citations WHERE response_id IN (${ph})`,
      chunk,
    )) {
      if (row.entity_id !== null && row.entity_id !== undefined && Number(row.entity_id) === brand.id) {
        citedResponses.add(Number(row.response_id));
        continue;
      }
      const domain = (String(row.domain ?? '') || extractDomain(String(row.url ?? '')))
        .toLowerCase()
        .replace(/^www\./, '');
      if (domain && entityForDomain(domain, brandEntityList) === brand.id) {
        citedResponses.add(Number(row.response_id));
      }
    }
  }

  const w = metrics.wilson(citedResponses.size, totalN);
  return {
    brandDomainsConfigured: true,
    citationRate: { ...w, cited: citedResponses.size },
  };
}

/**
 * Compute top domains cited in comparable answers where at least one tracked competitor
 * appears and the brand does NOT appear, using direct SQL reads without per-row review overhead.
 * Falls back to general brand-absent citation gaps if no competitors are configured yet.
 *
 * @param {Db} db
 * @param {Object} opts
 * @param {MeasurementSeries} opts.series
 * @param {{id: number, domains: string[]}|null} opts.brand
 * @param {Map<number, {name: string, isSelf: boolean}>} opts.entityMap
 * @param {number} [opts.limit]
 */
function queryCompetitorCitationGaps(db, { series, brand, entityMap, limit = 12 }) {
  const brandDomains = new Set(
    (brand?.domains ?? []).map((d) => extractDomain(d)).filter(Boolean),
  );
  const competitorIds = [...entityMap.entries()]
    .filter(([, e]) => !e.isSelf)
    .map(([id]) => id);
  const hasConfiguredCompetitors = competitorIds.length > 0;

  /** @type {string[]} */
  const clauses = [
    'r.created_at >= ?',
    'r.created_at < ?',
    'r.surface = ?',
    'r.execution_profile_id IS ?',
    'r.benchmark_revision_id IS ?',
    'r.analysis_revision IS ?',
    'r.comparison_key IS ?',
    'r.search_policy IS ?',
    "r.lane = 'tracking'",
    "r.target_status = 'completed'",
    "r.comparability_status = 'comparable'",
    'r.error IS NULL',
    'r.text IS NOT NULL',
    "trim(r.text) <> ''",
    "(r.answer_status IS NULL OR r.answer_status = 'complete')",
    "p.category <> 'branded'",
  ];
  /** @type {(string|number|null)[]} */
  const params = [
    series.start,
    series.end,
    series.surface,
    series.executionProfileId,
    series.benchmarkRevisionId,
    series.analysisRevision,
    series.comparisonKey,
    series.searchPolicy,
  ];
  if (series.searchPolicy === 'required' || isAgentSurface(series.surface)) {
    clauses.push("r.web_status = 'verified'");
  }
  if (brand !== null) {
    clauses.push('NOT EXISTS (SELECT 1 FROM mentions mb WHERE mb.response_id = r.id AND mb.entity_id = ?)');
    params.push(brand.id);
  }
  if (hasConfiguredCompetitors) {
    clauses.push(
      `EXISTS (SELECT 1 FROM mentions mc WHERE mc.response_id = r.id AND mc.entity_id IN (${competitorIds.map(() => '?').join(',')}))`,
    );
    params.push(...competitorIds);
  }

  const candidateRows = all(
    db,
    `SELECT r.id, COALESCE(r.prompt_text_snapshot, p.text) AS prompt
       FROM responses r
       JOIN prompts p ON p.id = r.prompt_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY r.created_at DESC, r.id DESC`,
    params,
  );
  if (candidateRows.length === 0) return [];

  const responseIds = candidateRows.map((row) => Number(row.id));
  const promptByResponse = new Map(candidateRows.map((row) => [Number(row.id), String(row.prompt)]));

  /** @type {Map<number, string[]>} */
  const compsByResponse = new Map();
  /** @type {Map<number, Map<string, string>>} */
  const citedByResponse = new Map();

  // Chunk IN clauses safely below SQLite parameter limits.
  for (let offset = 0; offset < responseIds.length; offset += 400) {
    const chunk = responseIds.slice(offset, offset + 400);
    const ph = chunk.map(() => '?').join(',');

    if (hasConfiguredCompetitors) {
      for (const row of all(
        db,
        `SELECT response_id, entity_id FROM mentions WHERE response_id IN (${ph})`,
        chunk,
      )) {
        const ent = entityMap.get(Number(row.entity_id));
        if (!ent || ent.isSelf) continue;
        let list = compsByResponse.get(Number(row.response_id));
        if (!list) {
          list = [];
          compsByResponse.set(Number(row.response_id), list);
        }
        if (!list.includes(ent.name)) list.push(ent.name);
      }
    }

    for (const row of all(
      db,
      `SELECT response_id, url FROM answer_citations WHERE response_id IN (${ph}) ORDER BY response_id, ordinal`,
      chunk,
    )) {
      const rid = Number(row.response_id);
      const url = String(row.url);
      const domain = extractDomain(url);
      if (!domain || brandDomains.has(domain)) continue;
      let map = citedByResponse.get(rid);
      if (!map) {
        map = new Map();
        citedByResponse.set(rid, map);
      }
      if (!map.has(domain)) map.set(domain, url);
    }

    for (const row of all(
      db,
      `SELECT response_id, url, domain FROM citations WHERE response_id IN (${ph}) ORDER BY response_id, rank`,
      chunk,
    )) {
      const rid = Number(row.response_id);
      const url = String(row.url);
      const domain = (String(row.domain ?? '') || extractDomain(url)).toLowerCase().replace(/^www\./, '');
      if (!domain || brandDomains.has(domain)) continue;
      let map = citedByResponse.get(rid);
      if (!map) {
        map = new Map();
        citedByResponse.set(rid, map);
      }
      if (!map.has(domain)) map.set(domain, url);
    }
  }

  /**
   * @type {Map<string, {
   *   domain: string,
   *   responseIds: Set<number>,
   *   competitors: Set<string>,
   *   sampleUrl: string,
   *   samplePrompt: string
   * }>}
   */
  const byDomain = new Map();

  for (const rid of responseIds) {
    const cited = citedByResponse.get(rid);
    if (!cited || cited.size === 0) continue;
    const comps = compsByResponse.get(rid) ?? [];
    const prompt = promptByResponse.get(rid) ?? '';
    for (const [domain, sampleUrl] of cited.entries()) {
      let bucket = byDomain.get(domain);
      if (!bucket) {
        bucket = {
          domain,
          responseIds: new Set(),
          competitors: new Set(),
          sampleUrl,
          samplePrompt: prompt,
        };
        byDomain.set(domain, bucket);
      }
      bucket.responseIds.add(rid);
      for (const c of comps) bucket.competitors.add(c);
    }
  }

  return [...byDomain.values()]
    .map((bucket) => ({
      domain: bucket.domain,
      count: bucket.responseIds.size,
      competitors: [...bucket.competitors],
      sampleUrl: bucket.sampleUrl,
      samplePrompt: bucket.samplePrompt,
    }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}

/**
 * Assemble the complete, secret-free, path-free B2B client report model.
 *
 * @param {Db} db
 * @param {Object} [opts]
 * @param {number} [opts.days]
 * @param {string} [opts.seriesId]
 * @param {string} [opts.start]
 * @param {string} [opts.end]
 * @param {string|Date} [opts.now]
 * @param {number} [opts.receiptLimit]
 * @param {boolean} [opts.demo]
 * @param {string|null} [opts.brandLabel]
 * @param {string|null} [opts.accentColor]
 * @param {string|null} [opts.footerNote]
 * @param {string|null} [opts.brand_label]
 * @param {string|null} [opts.accent_color]
 * @param {string|null} [opts.footer_note]
 */
export function buildClientReport(db, opts = {}) {
  const nowDate = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const generatedAt = `${nowDate.toISOString().slice(0, 19)}Z`;
  const days = Math.max(1, Math.min(3650, Math.floor(opts.days ?? DEFAULT_REPORT_DAYS)));
  const receiptLimit = Math.max(
    1,
    Math.min(MAX_RECEIPT_LIMIT, Math.floor(opts.receiptLimit ?? DEFAULT_RECEIPT_LIMIT)),
  );
  const whiteLabel = sanitizeWhiteLabelOptions(opts);

  const range =
    opts.start && opts.end ? { start: opts.start, end: opts.end } : {};

  const series = metrics.resolveMeasurementSeries(db, {
    now: generatedAt,
    days,
    seriesId: opts.seriesId || undefined,
    ...range,
  });

  if (opts.seriesId && !series) {
    const err = new RangeError('No measurement series found in the requested window');
    throw err;
  }

  const entities = listEntities(db);
  const brand = brandEntity(db);
  const competitors = entities.filter((e) => e.is_self !== 1);
  const entityMap = new Map(
    entities.map((e) => [e.id, { name: e.name, isSelf: e.is_self === 1 }]),
  );

  const effectiveStart = series?.start ?? opts.start ?? windowStart(days, nowDate);
  const effectiveEnd = series?.end ?? opts.end ?? generatedAt;

  const outcomes = listOutcomeRecords(db, { start: effectiveStart, end: effectiveEnd });
  const ledger = listLedgerEntries(db, { start: effectiveStart, end: effectiveEnd });

  const includeSeeded = Boolean(opts.demo);
  const attritionFilters = series
    ? { series, includeSeeded }
    : { start: effectiveStart, end: effectiveEnd, includeSeeded };
  const memoryFilters = { start: effectiveStart, end: effectiveEnd, includeSeeded };
  const persistenceFilters = series
    ? { series, includeSeeded }
    : { start: effectiveStart, end: effectiveEnd, includeSeeded };

  const forensics = {
    attrition: retrievalAttritionReport(db, attritionFilters),
    memoryVsSearch: memoryVsRetrievalDelta(db, memoryFilters),
    persistence: citationPersistenceReport(db, persistenceFilters),
  };

  if (!series) {
    return {
      generatedAt,
      demo: Boolean(opts.demo),
      whiteLabel,
      days,
      window: { start: effectiveStart, end: effectiveEnd },
      brand: brand
        ? { id: brand.id, name: brand.name, aliases: brand.aliases, domains: brand.domains }
        : null,
      competitors: competitors.map((c) => ({ name: c.name, domains: c.domains })),
      series: null,
      kpis: {
        mentionRate: null,
        citationRate: null,
        brandDomainsConfigured: (brand?.domains?.length ?? 0) > 0,
        recommendationRate: null,
        recommendationMethod: 'stance',
        brandSov: null,
        brandSovCi: null,
        brandMentions: 0,
        totalEntityMentions: 0,
      },
      volatility: {
        surfaceScope: 'No completed measurement series in window',
        comparableAnswers: 0,
        attemptedTargets: 0,
        maxPhrasingSpread: null,
        avgPhrasingSpread: null,
        maxRerunSpread: null,
        avgRerunSpread: null,
        multiParaphraseIntents: 0,
        totalIntents: 0,
      },
      forensics,
      leaderboard: [],
      intents: [],
      providers: [],
      citationGaps: [],
      receipts: [],
      totalComparableReceipts: 0,
      interventions: [],
      outcomes,
      ledger,
    };
  }

  const scope = {
    series,
    now: generatedAt,
    start: series.start,
    end: series.end,
  };

  const sovRows = metrics.shareOfVoice(db, scope);
  const trackedIds = [...new Set([...(brand ? [brand.id] : []), ...sovRows.map((r) => r.entityId)])];
  const { useStance, statsByEntity, eligibleIds } = batchEntitySeriesMetrics(db, series, trackedIds);
  const { brandDomainsConfigured, citationRate } = queryBrandCitationRate(db, eligibleIds, brand);

  const brandStats = brand ? statsByEntity.get(brand.id) : undefined;
  const mentionRate = brandStats?.mentionRate ?? null;
  const recommendationRate = brandStats?.recommendationRate ?? null;
  const totalEntityMentions = sovRows.reduce((sum, row) => sum + Number(row.mentions ?? 0), 0);
  const brandSovRow = brand ? sovRows.find((row) => row.entityId === brand.id) : null;
  // Wilson 95% CI on Share of AI Voice (brand mentions out of total tracked-entity mentions)
  const brandSovCi =
    brand && totalEntityMentions > 0
      ? metrics.wilson(Number(brandSovRow?.mentions ?? 0), totalEntityMentions)
      : null;

  const leaderboard = sovRows
    .slice()
    .sort((a, b) => Number(b.sov ?? 0) - Number(a.sov ?? 0))
    .map((row) => {
      const entityStats = statsByEntity.get(row.entityId);
      const sovCi =
        totalEntityMentions > 0
          ? metrics.wilson(Number(row.mentions ?? 0), totalEntityMentions)
          : null;
      return {
        entityId: row.entityId,
        name: row.name,
        isSelf: Boolean(row.isSelf),
        mentions: Number(row.mentions ?? 0),
        sov: Number(row.sov ?? 0),
        sovCi,
        mentionRate: entityStats?.mentionRate ?? metrics.wilson(0, 0),
        recommendationRate: entityStats?.recommendationRate ?? {
          n: 0,
          recommended: 0,
          p: null,
          lo: null,
          hi: null,
          lowSample: true,
        },
        avgRank: entityStats?.avgRank ?? null,
      };
    });

  const intents = metrics.intentTable(db, scope);
  const providers = metrics.providerBreakdown(db, scope).map((p) => ({
    provider: p.provider,
    label: PROVIDER_LABELS[p.provider] ?? surfaceLabel(series.surface),
    n: p.n,
    brandMentionRate: p.brandMentionRate,
    avgRank: p.avgRank,
    citationShare: p.citationShare,
    citationN: p.citationN ?? 0,
  }));

  const receiptPage = queryAnswers(db, {
    series,
    start: series.start,
    end: series.end,
    days,
    now: nowDate,
    page: 1,
    per: receiptLimit,
    eligibleOnly: true,
  });
  const citationGaps = queryCompetitorCitationGaps(db, {
    series,
    brand,
    entityMap,
    limit: 12,
  });

  const receipts = receiptPage.items.map((item) => {
    const queries = [
      ...new Set(
        item.search_events.flatMap((ev) => [
          ...(ev.query ? [ev.query] : []),
          ...(ev.queries ?? []),
        ]),
      ),
    ].filter(Boolean);

    /** @type {string[]} */
    const citedUrls = [];
    /** @type {Set<string>} */
    const seenUrls = new Set();
    for (const c of item.answer_citations ?? []) {
      if (c.url && !seenUrls.has(c.url)) {
        seenUrls.add(c.url);
        citedUrls.push(c.url);
      }
    }
    for (const c of item.citations ?? []) {
      if (c.url && !seenUrls.has(c.url)) {
        seenUrls.add(c.url);
        citedUrls.push(c.url);
      }
    }

    const brandMention = brand ? item.mentions.find((m) => m.entity_id === brand.id) : null;
    return {
      id: item.id,
      provider: item.provider,
      surface: item.surface,
      surfaceLabel: surfaceLabel(item.surface ?? `${item.provider}-api`),
      model: item.model,
      createdAt: item.created_at,
      prompt: item.prompt,
      webStatus: item.web_status,
      searchQueries: queries,
      citedUrls,
      mentions: item.mentions.map((m) => ({
        name: m.name,
        isSelf: brand !== null && m.entity_id === brand.id,
        rank: m.rank,
        recommended: m.recommended === 1,
        stance: m.stance,
      })),
      brandPresent: Boolean(brandMention),
      brandRecommended: brandMention?.recommended === 1,
      text: item.text ?? '',
    };
  });

  /**
   * @type {{
   *   id: number,
   *   status: string,
   *   priority: number|null,
   *   observedFinding: string,
   *   suggestedAction: string|null,
   *   changeDescription: string|null,
   *   targetUrl: string|null,
   *   shippedAt: string|null,
   *   owner: string|null,
   *   reviewDate: string|null
   * }[]}
   */
  let interventions = [];
  try {
    interventions = listOpportunities(db, { series })
      .filter((opp) => opp.status !== 'dismissed' && opp.status !== 'combined')
      .map((opp) => ({
        id: opp.id,
        status: opp.status,
        priority: opp.priority ?? null,
        observedFinding: opp.observedFinding,
        suggestedAction: opp.suggestedAction ?? null,
        changeDescription: opp.changeDescription ?? null,
        targetUrl: opp.targetUrl ?? null,
        shippedAt: opp.shippedAt ?? null,
        owner: opp.owner ?? null,
        reviewDate: opp.reviewDate ?? null,
      }));
  } catch {
    interventions = [];
  }

  const phrasingSpreads = intents
    .map((i) => i.phrasingSpread)
    .filter(isFiniteNumber);
  const rerunSpreads = intents
    .map((i) => i.rerunSpread)
    .filter(isFiniteNumber);
  const volatility = {
    surfaceScope: `${surfaceLabel(series.surface)} (${series.surface}, search=${series.searchPolicy ?? 'legacy'})`,
    comparableAnswers: series.comparableAnswers,
    attemptedTargets: series.attemptedTargets,
    maxPhrasingSpread: phrasingSpreads.length > 0 ? Math.max(...phrasingSpreads) : null,
    avgPhrasingSpread:
      phrasingSpreads.length > 0
        ? phrasingSpreads.reduce((sum, v) => sum + v, 0) / phrasingSpreads.length
        : null,
    maxRerunSpread: rerunSpreads.length > 0 ? Math.max(...rerunSpreads) : null,
    avgRerunSpread:
      rerunSpreads.length > 0
        ? rerunSpreads.reduce((sum, v) => sum + v, 0) / rerunSpreads.length
        : null,
    multiParaphraseIntents: intents.filter((i) => Number(i.paraphraseCount ?? 0) > 1).length,
    totalIntents: intents.length,
  };

  return {
    generatedAt,
    demo: Boolean(opts.demo),
    whiteLabel,
    days,
    window: { start: series.start, end: series.end },
    brand: brand
      ? { id: brand.id, name: brand.name, aliases: brand.aliases, domains: brand.domains }
      : null,
    competitors: competitors.map((c) => ({ name: c.name, domains: c.domains })),
    series: {
      id: series.id,
      surface: series.surface,
      surfaceLabel: surfaceLabel(series.surface),
      searchPolicy: series.searchPolicy ?? 'legacy',
      executionProfileId: series.executionProfileId ?? 'legacy',
      benchmarkRevisionId: series.benchmarkRevisionId ?? 'legacy',
      analysisRevision: series.analysisRevision ?? 'legacy',
      attemptedTargets: series.attemptedTargets,
      completeAnswers: series.completeAnswers,
      comparableAnswers: series.comparableAnswers,
      verifiedSearchAnswers: series.verifiedSearchAnswers,
      queryMetadataAnswers: series.queryMetadataAnswers,
    },
    kpis: {
      mentionRate,
      citationRate,
      brandDomainsConfigured,
      recommendationRate: recommendationRate
        ? {
            n: recommendationRate.n,
            recommended: recommendationRate.recommended,
            p: recommendationRate.p,
            lo: recommendationRate.lo ?? null,
            hi: recommendationRate.hi ?? null,
            lowSample: recommendationRate.n < metrics.LOW_SAMPLE_N,
          }
        : null,
      recommendationMethod: useStance ? 'stance' : 'legacy',
      brandSov: brandSovRow ? Number(brandSovRow.sov ?? 0) : null,
      brandSovCi,
      brandMentions: Number(brandSovRow?.mentions ?? 0),
      totalEntityMentions,
    },
    volatility,
    forensics,
    leaderboard,
    intents,
    providers,
    citationGaps,
    receipts,
    totalComparableReceipts: receiptPage.total,
    interventions,
    outcomes,
    ledger,
  };
}

/**
 * Render a horizontal confidence-interval bar widget in pure HTML/CSS.
 * @param {{p: number|null, lo?: number|null, hi?: number|null}|null|undefined} rate
 * @param {boolean} [isAccent]
 * @returns {string}
 */
function renderCiBar(rate, isAccent = false) {
  if (!rate || rate.p === null || rate.p === undefined || !Number.isFinite(rate.p)) {
    return '<div class="ci-track" aria-hidden="true"></div>';
  }
  const pPct = Math.max(0, Math.min(100, rate.p * 100));
  const loPct =
    typeof rate.lo === 'number' && Number.isFinite(rate.lo)
      ? Math.max(0, Math.min(100, rate.lo * 100))
      : pPct;
  const hiPct =
    typeof rate.hi === 'number' && Number.isFinite(rate.hi)
      ? Math.max(loPct, Math.min(100, rate.hi * 100))
      : pPct;
  const widthPct = Math.max(1.5, hiPct - loPct);
  const cls = isAccent ? 'ci-track is-brand' : 'ci-track';
  return `<div class="${cls}" aria-hidden="true"><span class="ci-band" style="left:${loPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></span><span class="ci-point" style="left:${pPct.toFixed(1)}%"></span></div>`;
}

/**
 * Render an external link safely (only http:/https:, fully HTML-escaped).
 * @param {string|null|undefined} rawUrl
 * @param {string} [label]
 * @returns {string}
 */
function renderSafeLink(rawUrl, label) {
  const display = label ?? rawUrl ?? '';
  const safeHref = safeHttpUrl(rawUrl);
  if (!safeHref) return `<code>${escapeHtml(display)}</code>`;
  return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a>`;
}

/**
 * Format a signed percentage-point delta (e.g. +24 pts, -10 pts, 0 pts).
 * @param {number|null|undefined} delta
 * @returns {string}
 */
function fmtSignedPts(delta) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return '—';
  const pts = Math.round(delta * 100);
  return `${pts > 0 ? '+' : ''}${pts} pts`;
}

/**
 * Render a horizontal proportion fill bar with optional Wilson CI markers.
 * @param {{p: number|null, lo?: number|null, hi?: number|null}|null|undefined} rate
 * @param {'mention'|'citation'|'recommendation'} tone
 * @returns {string}
 */
function renderSeparationBar(rate, tone) {
  const pPct =
    rate && typeof rate.p === 'number' && Number.isFinite(rate.p)
      ? Math.max(0, Math.min(100, rate.p * 100))
      : 0;
  return `<div class="sep-bar-track sep-tone-${tone}" aria-hidden="true"><span class="sep-bar-fill" style="width:${pPct.toFixed(1)}%"></span></div>${renderCiBar(rate, tone === 'recommendation')}`;
}

/**
 * Render an honest limitations list when present.
 * @param {string[]|null|undefined} limitations
 * @returns {string}
 */
function renderLimitationsBox(limitations) {
  const items = Array.isArray(limitations) ? limitations.filter(Boolean) : [];
  if (items.length === 0) return '';
  return `<div class="limitations-box">
    <span class="meta-label">Methodological Notes &amp; Limitations</span>
    <ul class="compact-list">${items.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
  </div>`;
}

/**
 * Render explicit Mention vs. Citation vs. Positive Recommendation side-by-side separation bars.
 * @param {ReturnType<typeof buildClientReport>} report
 * @returns {string}
 */
function renderSeparationBarsSection(report) {
  if (!report.series) return '';
  const mention = report.kpis?.mentionRate ?? null;
  const citation = report.kpis?.citationRate ?? null;
  const recommendation = report.kpis?.recommendationRate ?? null;
  const domainsConfigured = report.kpis?.brandDomainsConfigured ?? Boolean(report.brand?.domains?.length);
  const recMethodLabel =
    report.kpis?.recommendationMethod === 'stance'
      ? 'Positive stance (verified rule / human review)'
      : 'Legacy heuristic recommendation flag';
  const hijackCount = Number(report.forensics?.attrition?.hijacks?.count ?? 0);

  const mentionP = typeof mention?.p === 'number' ? mention.p : null;
  const citationP = domainsConfigured && typeof citation?.p === 'number' ? citation.p : null;
  const recP = typeof recommendation?.p === 'number' ? recommendation.p : null;

  /** @type {string[]} */
  const calloutParts = [];
  if (mentionP !== null && recP !== null && mentionP > recP) {
    calloutParts.push(
      `Mentions (${fmtPct(mentionP)}) exceed positive recommendations (${fmtPct(recP)}) by ${Math.round((mentionP - recP) * 100)} percentage points — appearing in an answer is not the same as being endorsed.`,
    );
  }
  if (citationP !== null && recP !== null && citationP > recP) {
    calloutParts.push(
      `Brand domain citations (${fmtPct(citationP)}) exceed positive recommendations (${fmtPct(recP)}) — AI models can cite your pages while recommending a competitor.`,
    );
  }
  if (hijackCount > 0) {
    calloutParts.push(
      `${hijackCount} Own-Site Hijack ${hijackCount === 1 ? 'receipt was' : 'receipts were'} detected where your domain was cited while a competitor received a positive recommendation.`,
    );
  }
  const separationTakeaway =
    calloutParts.length > 0
      ? calloutParts.join(' ')
      : 'Hearsay keeps brand mentions, owned-domain citations, and positive recommendations strictly separated so being cited is never misread as being recommended.';

  return `<section class="glass-card section-block separation-section" aria-label="Mention vs. Citation vs. Positive Recommendation">
    <div class="section-header">
      <h2>Mention vs. Citation vs. Positive Recommendation</h2>
      <p class="muted">Three distinct stages on the exact same comparable answer denominator — never blended into one score so being cited is never confused with being recommended.</p>
    </div>
    <div class="separation-grid">
      <article class="sep-card">
        <div class="sep-head">
          <span class="sep-title">1. Mention Rate</span>
          <span class="pill pill-accent">Named</span>
        </div>
        <div class="sep-value">${escapeHtml(fmtPct(mention?.p))}</div>
        <p class="sep-meta">${escapeHtml(
          mention && mention.p !== null
            ? `${mention.mentioned}/${mention.n} answers · 95% CI [${fmtPct(mention.lo)}–${fmtPct(mention.hi)}]`
            : `n=${mention?.n ?? 0}`,
        )}</p>
        ${renderSeparationBar(mention, 'mention')}
        <p class="muted small sep-caption">Brand named anywhere in the answer (positive, neutral, or negative).</p>
      </article>
      <article class="sep-card">
        <div class="sep-head">
          <span class="sep-title">2. Brand Citation Rate</span>
          <span class="pill pill-cite">Linked Source</span>
        </div>
        <div class="sep-value">${domainsConfigured ? escapeHtml(fmtPct(citation?.p)) : '—'}</div>
        <p class="sep-meta">${escapeHtml(
          !domainsConfigured
            ? 'No brand domain configured'
            : citation && citation.p !== null
              ? `${citation.cited}/${citation.n} answers · 95% CI [${fmtPct(citation.lo)}–${fmtPct(citation.hi)}]`
              : `n=${citation?.n ?? 0}`,
        )}</p>
        ${renderSeparationBar(domainsConfigured ? citation : null, 'citation')}
        <p class="muted small sep-caption">${
          domainsConfigured
            ? 'Owned brand domain linked in answer citations or legacy source rows.'
            : 'Add your brand domain(s) to measure owned-domain citation incidence.'
        }</p>
      </article>
      <article class="sep-card">
        <div class="sep-head">
          <span class="sep-title">3. Positive Recommendation</span>
          <span class="pill pill-good">Endorsed</span>
        </div>
        <div class="sep-value">${escapeHtml(fmtPct(recommendation?.p))}</div>
        <p class="sep-meta">${escapeHtml(
          recommendation && recommendation.p !== null
            ? `${recommendation.recommended}/${recommendation.n} answers · 95% CI [${fmtPct(recommendation.lo)}–${fmtPct(recommendation.hi)}]`
            : `n=${recommendation?.n ?? 0}`,
        )}</p>
        ${renderSeparationBar(recommendation, 'recommendation')}
        <p class="muted small sep-caption">${escapeHtml(recMethodLabel)}.</p>
      </article>
    </div>
    <p class="callout-note small">${escapeHtml(separationTakeaway)}</p>
  </section>`;
}

/**
 * @param {number|null|undefined} v
 * @returns {v is number}
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Render the auto-generated "Why Live Chat on Your Phone May Differ" volatility & methodology callout.
 * @param {ReturnType<typeof buildClientReport>} report
 * @returns {string}
 */
function renderVolatilityCallout(report) {
  const mention = report.kpis?.mentionRate ?? null;
  const rec = report.kpis?.recommendationRate ?? null;
  const vol = report.volatility ?? null;
  const surfaceScope =
    vol?.surfaceScope ??
    (report.series
      ? `${report.series.surfaceLabel} (${report.series.surface}, search=${report.series.searchPolicy})`
      : 'No completed measurement series in window');
  const comparableAnswers = vol?.comparableAnswers ?? report.series?.comparableAnswers ?? 0;
  const attemptedTargets = vol?.attemptedTargets ?? report.series?.attemptedTargets ?? 0;

  const phrasingSpreads = (report.intents ?? [])
    .map((i) => i.phrasingSpread)
    .filter(isFiniteNumber);
  const rerunSpreads = (report.intents ?? [])
    .map((i) => i.rerunSpread)
    .filter(isFiniteNumber);
  const maxPhrasingSpread =
    vol?.maxPhrasingSpread !== undefined
      ? vol.maxPhrasingSpread
      : phrasingSpreads.length > 0
        ? Math.max(...phrasingSpreads)
        : null;
  const maxRerunSpread =
    vol?.maxRerunSpread !== undefined
      ? vol.maxRerunSpread
      : rerunSpreads.length > 0
        ? Math.max(...rerunSpreads)
        : null;

  const ciSummary =
    mention && mention.p !== null
      ? `Answer Rate ${fmtPct(mention.p)} with 95% Wilson CI [${fmtPct(mention.lo)}–${fmtPct(mention.hi)}] across n=${mention.n} comparable answers${
          rec && rec.p !== null
            ? `; Positive Recommendation ${fmtPct(rec.p)} [${fmtPct(rec.lo)}–${fmtPct(rec.hi)}]`
            : ''
        }.`
      : 'No comparable answers in this window yet — once a panel runs, Hearsay computes exact Wilson 95% intervals instead of a point guess.';

  const spreadSummary =
    maxPhrasingSpread !== null || maxRerunSpread !== null
      ? `Observed phrasing spread across buyer paraphrases: ${
          maxPhrasingSpread !== null ? `up to ±${Math.round(maxPhrasingSpread * 100)} pts` : 'not yet measured (need ≥2 paraphrases per intent)'
        }; identical-prompt rerun spread: ${
          maxRerunSpread !== null ? `up to ±${Math.round(maxRerunSpread * 100)} pts` : 'not yet measured (need ≥2 samples per prompt)'
        }.`
      : 'Only single-phrasing or single-sample observations are present in this window; run ≥2 paraphrases and ≥2 samples per prompt to separate wording sensitivity from model rerun noise.';

  return `<section class="glass-card section-block volatility-callout" aria-label="Why Live Chat on Your Phone May Differ">
    <div class="section-header">
      <div class="callout-title-row">
        <h2>Why Live Chat on Your Phone May Differ</h2>
        <span class="pill pill-warn">Volatility &amp; Methodology</span>
      </div>
      <p class="muted">A single prompt typed into a consumer phone app is an <code>n=1</code> draw shaped by account memory, chat history, geolocation, A/B routing, and stochastic sampling — not a stable market share.</p>
    </div>
    <div class="volatility-grid">
      <div class="vol-item">
        <span class="meta-label">Explicit Surface Scope</span>
        <p><strong>${escapeHtml(surfaceScope)}</strong></p>
        <p class="muted small">${comparableAnswers} of ${attemptedTargets} attempted targets were comparable. API routes and subscription-agent surfaces are never blended because consumer UIs layer personalization and silent model routing.</p>
      </div>
      <div class="vol-item">
        <span class="meta-label">Measured 95% Wilson Intervals</span>
        <p>${escapeHtml(ciSummary)}</p>
        <p class="muted small">Hearsay refuses to collapse noisy binary outcomes into a single fake 0–100 visibility score; wide intervals honestly show where more samples are required.</p>
      </div>
      <div class="vol-item">
        <span class="meta-label">Paraphrase vs. Rerun Spread</span>
        <p>${escapeHtml(spreadSummary)}</p>
        <p class="muted small">Small wording edits often shift brand recall more than rerunning the exact same prompt — which is why one ad-hoc phone check rarely reproduces.</p>
      </div>
    </div>
  </section>`;
}

/**
 * Render Section: Retrieved-but-Dropped Attrition & Own-Site Hijacks.
 * @param {ReturnType<typeof retrievalAttritionReport>|null|undefined} attrition
 * @returns {string}
 */
function renderAttritionSection(attrition) {
  if (!attrition) return '';
  const hasData =
    attrition.retrievedObservations > 0 ||
    attrition.citedObservations > 0 ||
    attrition.hijacks.count > 0;
  const brandBucket = attrition.byOwnership.brand_owned;
  const thirdPartyBucket = attrition.byOwnership.third_party;

  const droppedBrandRows = attrition.topDroppedBrandUrls
    .slice(0, 10)
    .map(
      (item) => `<tr>
        <td class="url-cell">${renderSafeLink(item.rawUrl || item.url, item.url)}</td>
        <td class="num">${item.retrievedCount}</td>
        <td class="num">${item.citedCount}</td>
        <td class="num"><strong>${item.droppedCount}</strong></td>
        <td class="num">${escapeHtml(fmtPct(item.dropRate))}</td>
      </tr>`,
    )
    .join('');

  const droppedThirdPartyRows = attrition.topDroppedThirdPartyUrls
    .slice(0, 8)
    .map(
      (item) => `<tr>
        <td class="url-cell">${renderSafeLink(item.rawUrl || item.url, item.url)}<div class="muted small">${escapeHtml(item.domain ?? '')}</div></td>
        <td class="num">${item.retrievedCount}</td>
        <td class="num">${item.citedCount}</td>
        <td class="num"><strong>${item.droppedCount}</strong></td>
        <td class="num">${escapeHtml(fmtPct(item.dropRate))}</td>
      </tr>`,
    )
    .join('');

  const hijackRows = attrition.hijacks.receipts
    .slice(0, 10)
    .map(
      (h) => `<tr>
        <td><strong>#${h.responseId}</strong><div class="muted small">${escapeHtml(h.provider)} / ${escapeHtml(h.model)}</div></td>
        <td>${escapeHtml(h.promptText)}</td>
        <td class="url-cell">${h.ownCitedUrls.map((u) => `<div>${renderSafeLink(u)}</div>`).join('')}</td>
        <td>
          <span class="pill pill-danger">${escapeHtml(h.recommendedCompetitors.join(', '))}</span>
          <div class="muted small">Brand stance: ${escapeHtml(h.brandStance ?? 'absent')}</div>
        </td>
      </tr>`,
    )
    .join('');

  return `<section class="glass-card section-block forensics-section" id="forensics-attrition">
    <details class="forensics-details"${hasData ? ' open' : ''}>
      <summary class="forensics-summary">
        <div>
          <h2>Retrieved-but-Dropped Attrition &amp; Own-Site Hijacks</h2>
          <p class="muted">Tracks URLs retrieved during live search (<code>source_observations</code>) that were dropped before final citations (<code>answer_citations</code>), plus answers citing your own domain while recommending a competitor.</p>
        </div>
        <div class="forensics-badges">
          <span class="pill ${attrition.attritionRate.p !== null ? 'pill-warn' : 'pill-muted'}">Attrition: ${escapeHtml(fmtPct(attrition.attritionRate.p))}</span>
          <span class="pill ${attrition.hijacks.count > 0 ? 'pill-danger' : 'pill-good'}">Hijacks: ${attrition.hijacks.count}</span>
        </div>
      </summary>
      <div class="forensics-body">
        <div class="mini-kpi-grid">
          <div class="mini-kpi">
            <span class="meta-label">Overall Attrition Rate</span>
            <strong>${escapeHtml(fmtPct(attrition.attritionRate.p))}</strong>
            <span class="muted small">${escapeHtml(
              attrition.retrievedObservations > 0
                ? `${attrition.droppedObservations}/${attrition.retrievedObservations} retrieved dropped · 95% CI [${fmtPct(attrition.attritionRate.lo)}–${fmtPct(attrition.attritionRate.hi)}]`
                : 'No source_observations recorded',
            )}</span>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Brand-Owned Attrition</span>
            <strong>${escapeHtml(fmtPct(brandBucket.attritionRate.p))}</strong>
            <span class="muted small">${brandBucket.droppedObservations}/${brandBucket.retrievedObservations} dropped · ${brandBucket.citedObservations} cited</span>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Third-Party Attrition</span>
            <strong>${escapeHtml(fmtPct(thirdPartyBucket.attritionRate.p))}</strong>
            <span class="muted small">${thirdPartyBucket.droppedObservations}/${thirdPartyBucket.retrievedObservations} dropped · ${thirdPartyBucket.citedObservations} cited</span>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Own-Site Hijacks</span>
            <strong>${attrition.hijacks.count} / ${attrition.hijacks.ownCitedAnswers}</strong>
            <span class="muted small">${escapeHtml(
              attrition.hijacks.ownCitedAnswers > 0
                ? `${fmtPct(attrition.hijacks.rate.p)} of own-cited answers`
                : 'No own-cited answers observed',
            )}</span>
          </div>
        </div>

        ${
          droppedBrandRows
            ? `<div class="sub-block">
                <h3>Top Retrieved-but-Dropped Brand URLs</h3>
                <div class="table-wrap">
                  <table>
                    <thead><tr><th>Brand URL</th><th class="num">Retrieved</th><th class="num">Cited</th><th class="num">Dropped</th><th class="num">Drop Rate</th></tr></thead>
                    <tbody>${droppedBrandRows}</tbody>
                  </table>
                </div>
              </div>`
            : ''
        }

        ${
          hijackRows
            ? `<div class="sub-block">
                <h3>Own-Site Hijack Receipts (Your Page Cited, Competitor Recommended)</h3>
                <div class="table-wrap">
                  <table>
                    <thead><tr><th>Receipt</th><th>Buyer Prompt</th><th>Your Cited URL(s)</th><th>Competitor Recommended</th></tr></thead>
                    <tbody>${hijackRows}</tbody>
                  </table>
                </div>
              </div>`
            : ''
        }

        ${
          droppedThirdPartyRows
            ? `<div class="sub-block">
                <h3>Top Retrieved-but-Dropped Third-Party URLs</h3>
                <div class="table-wrap">
                  <table>
                    <thead><tr><th>Third-Party URL</th><th class="num">Retrieved</th><th class="num">Cited</th><th class="num">Dropped</th><th class="num">Drop Rate</th></tr></thead>
                    <tbody>${droppedThirdPartyRows}</tbody>
                  </table>
                </div>
              </div>`
            : ''
        }

        ${!hasData ? '<p class="empty-note">No search-grounded retrieval attrition or own-site hijack observations were available in this scope.</p>' : ''}
        ${renderLimitationsBox(attrition.limitations)}
      </div>
    </details>
  </section>`;
}

/**
 * Render Section: Parametric Memory vs. Grounded Search Delta.
 * @param {ReturnType<typeof memoryVsRetrievalDelta>|null|undefined} delta
 * @returns {string}
 */
function renderMemoryVsSearchSection(delta) {
  if (!delta) return '';
  const paired = delta.pairs.filter((p) => p.status === 'paired');
  const hasPaired = paired.length > 0;

  const modelRows = paired
    .map((pair) => {
      const b = pair.brand;
      const cls = pair.classificationSummary;
      return `<tr>
        <td>
          <strong>${escapeHtml(pair.provider)} / ${escapeHtml(pair.model)}</strong>
          <div class="muted small">${escapeHtml(pair.surfaces.join(', '))} · ${pair.pairedPromptCount} paired prompt(s)</div>
        </td>
        <td class="num">${escapeHtml(b ? fmtRateSummary(b.memoryMentionRate) : '—')}</td>
        <td class="num">${escapeHtml(b ? fmtRateSummary(b.groundedMentionRate) : '—')}</td>
        <td class="num"><strong>${escapeHtml(b ? fmtSignedPts(b.deltaMentionRate) : '—')}</strong></td>
        <td class="num">${escapeHtml(b ? fmtSignedPts(b.deltaPositiveRate) : '—')}</td>
        <td>
          <div class="pill-wrap">
            <span class="pill pill-good">anchored: ${cls.memory_anchored}</span>
            <span class="pill pill-accent">search_dep: ${cls.search_dependent}</span>
            <span class="pill pill-danger">displaced: ${cls.memory_displaced}</span>
            <span class="pill pill-muted">absent: ${cls.absent_in_both}</span>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  /** @type {Record<string, string>} */
  const classBadgeStyle = {
    memory_anchored: 'pill-good',
    search_dependent: 'pill-accent',
    memory_displaced: 'pill-danger',
    absent_in_both: 'pill-muted',
  };

  const promptRows = paired
    .flatMap((pair) =>
      pair.brandPromptClassifications.map((item) => ({
        modelLabel: `${pair.provider}/${pair.model}`,
        ...item,
      })),
    )
    .slice(0, 15)
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.promptText)}<div class="muted small">${escapeHtml(item.modelLabel)}</div></td>
        <td><span class="pill ${classBadgeStyle[item.classification] ?? 'pill-muted'}">${escapeHtml(item.classification)}</span></td>
        <td class="num">${item.memoryMentioned}/${item.memoryN}</td>
        <td class="num">${item.groundedMentioned}/${item.groundedN}</td>
        <td class="num">${item.groundedCited}/${item.groundedN}</td>
      </tr>`,
    )
    .join('');

  return `<section class="glass-card section-block forensics-section" id="forensics-memory-vs-search">
    <details class="forensics-details"${hasPaired ? ' open' : ''}>
      <summary class="forensics-summary">
        <div>
          <h2>Parametric Memory vs. Grounded Search Delta</h2>
          <p class="muted">Strictly pairs search-off parametric memory runs against verified live-retrieval runs on identical prompts within the exact same <code>(provider, model)</code> — never blending across models.</p>
        </div>
        <div class="forensics-badges">
          <span class="pill ${hasPaired ? 'pill-accent' : 'pill-muted'}">${delta.summary.pairedModels} paired model(s)</span>
          <span class="pill pill-muted">${delta.summary.totalPairedPrompts} paired prompt(s)</span>
        </div>
      </summary>
      <div class="forensics-body">
        <div class="mini-kpi-grid">
          <div class="mini-kpi">
            <span class="meta-label">Paired Models</span>
            <strong>${delta.summary.pairedModels} / ${delta.summary.totalModels}</strong>
            <span class="muted small">Exact (provider, model) pairs</span>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Unpaired Models</span>
            <strong>${delta.summary.unpairedModels}</strong>
            <span class="muted small">Memory-only, grounded-only, or disjoint prompts</span>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Paired Buyer Prompts</span>
            <strong>${delta.summary.totalPairedPrompts}</strong>
            <span class="muted small">Evaluated in both memory &amp; live search</span>
          </div>
        </div>

        ${
          modelRows
            ? `<div class="sub-block">
                <h3>Model-by-Model Memory vs. Grounded Retrieval Comparison</h3>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Provider / Model</th>
                        <th class="num">Memory Mention (95% CI)</th>
                        <th class="num">Grounded Mention (95% CI)</th>
                        <th class="num">Mention Delta</th>
                        <th class="num">Positive Stance Delta</th>
                        <th>Prompt Classifications</th>
                      </tr>
                    </thead>
                    <tbody>${modelRows}</tbody>
                  </table>
                </div>
              </div>`
            : '<p class="empty-note">No exact (provider, model) pairs with both parametric memory and verified live-retrieval responses exist in this window yet.</p>'
        }

        ${
          promptRows
            ? `<div class="sub-block">
                <h3>Paired Prompt Classification Breakdown</h3>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Buyer Prompt</th>
                        <th>Classification</th>
                        <th class="num">Memory Mentions</th>
                        <th class="num">Grounded Mentions</th>
                        <th class="num">Grounded Brand Citations</th>
                      </tr>
                    </thead>
                    <tbody>${promptRows}</tbody>
                  </table>
                </div>
              </div>`
            : ''
        }

        ${renderLimitationsBox(delta.limitations)}
      </div>
    </details>
  </section>`;
}

/**
 * Render Section: Persistent Off-Site Targets (`citationPersistenceReport`).
 * @param {ReturnType<typeof citationPersistenceReport>|null|undefined} persistence
 * @returns {string}
 */
function renderPersistenceSection(persistence) {
  if (!persistence) return '';
  const s = persistence.summary;
  const hasTargets = persistence.offSiteTargets.length > 0;
  const hasDomains = persistence.domains.length > 0;

  /** @type {Record<string, {cls: string, label: string}>} */
  const tierStyles = {
    durable: { cls: 'pill-good', label: 'durable' },
    recurring: { cls: 'pill-accent', label: 'recurring' },
    single_wave_unverified: { cls: 'pill-warn', label: 'single_wave_unverified' },
    ephemeral: { cls: 'pill-muted', label: 'ephemeral' },
  };
  /** @param {string} tier */
  const tierBadge = (tier) => {
    const t = tierStyles[tier] ?? { cls: 'pill-muted', label: tier };
    return `<span class="pill ${t.cls}">${escapeHtml(t.label)}</span>`;
  };

  const targetRows = persistence.offSiteTargets
    .slice(0, 15)
    .map(
      (item) => `<tr>
        <td>${tierBadge(item.tier)}</td>
        <td class="url-cell">
          <strong>${escapeHtml(item.domain)}</strong>
          <div class="small">${renderSafeLink(item.rawUrl || item.url, item.url)}</div>
        </td>
        <td class="num">${item.wavesSeen}/${item.totalWaves} (${escapeHtml(fmtPct(item.persistenceRate))})</td>
        <td class="num"><strong>${item.citationCount}</strong></td>
        <td>
          <strong>${item.competitorRecommendations} rec(s)</strong>
          <div class="muted small">${
            item.recommendedCompetitorNames.length > 0
              ? escapeHtml(item.recommendedCompetitorNames.join(', '))
              : item.competitorNames.length > 0
                ? escapeHtml(item.competitorNames.join(', '))
                : 'Brand absent'
          }</div>
        </td>
      </tr>`,
    )
    .join('');

  const domainRows =
    !hasTargets && hasDomains
      ? persistence.domains
          .slice(0, 10)
          .map(
            (d) => `<tr>
              <td>${tierBadge(d.tier)}</td>
              <td><strong>${escapeHtml(d.domain)}</strong> <span class="pill pill-muted">${escapeHtml(d.ownership)}</span></td>
              <td class="num">${d.wavesSeen}/${d.totalWaves} (${escapeHtml(fmtPct(d.persistenceRate))})</td>
              <td class="num">${d.citationCount}</td>
              <td class="num">${d.competitorRecommendations}</td>
            </tr>`,
          )
          .join('')
      : '';

  return `<section class="glass-card section-block forensics-section" id="forensics-persistence">
    <details class="forensics-details"${hasTargets || hasDomains ? ' open' : ''}>
      <summary class="forensics-summary">
        <div>
          <h2>Persistent Off-Site Targets</h2>
          <p class="muted">Multi-wave citation durability across completed runs — prioritizes third-party earned-media URLs that persist across waves while competitors are recommended and your brand is absent.</p>
        </div>
        <div class="forensics-badges">
          <span class="pill pill-accent">Off-site share: ${escapeHtml(fmtPct(s.offSiteShare))}</span>
          <span class="pill ${s.totalWaves < 2 ? 'pill-warn' : 'pill-good'}">${s.totalWaves} wave(s)</span>
        </div>
      </summary>
      <div class="forensics-body">
        <div class="mini-kpi-grid">
          <div class="mini-kpi">
            <span class="meta-label">Off-Site Citation Share</span>
            <strong>${escapeHtml(fmtPct(s.offSiteShare))}</strong>
            <span class="muted small">${escapeHtml(
              s.totalCitations > 0
                ? `${s.ownershipCounts.third_party}/${s.totalCitations} citations third-party · 95% CI [${fmtPct(s.offSiteShareCi.lo)}–${fmtPct(s.offSiteShareCi.hi)}]`
                : 'No answer citations recorded',
            )}</span>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Completed Waves</span>
            <strong>${s.totalWaves}</strong>
            <span class="muted small">${s.totalUniqueUrls} unique cited URL(s) · ${s.totalUniqueDomains} domain(s)</span>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Durability Tiers</span>
            <div class="pill-wrap">
              <span class="pill pill-good">durable: ${s.durableCount}</span>
              <span class="pill pill-accent">recurring: ${s.recurringCount}</span>
              <span class="pill pill-warn">single_wave_unverified: ${s.singleWaveUnverifiedCount}</span>
              <span class="pill pill-muted">ephemeral: ${s.ephemeralCount}</span>
            </div>
          </div>
          <div class="mini-kpi">
            <span class="meta-label">Off-Site Outreach Targets</span>
            <strong>${s.offSiteTargetCount}</strong>
            <span class="muted small">Third-party URLs with brand absent &amp; competitor present</span>
          </div>
        </div>

        ${
          targetRows
            ? `<div class="sub-block">
                <h3>Prioritized Third-Party Off-Site Outreach Targets</h3>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Durability Tier</th>
                        <th>Domain &amp; Canonical URL</th>
                        <th class="num">Waves Seen</th>
                        <th class="num">Citations</th>
                        <th>Competitor Impact</th>
                      </tr>
                    </thead>
                    <tbody>${targetRows}</tbody>
                  </table>
                </div>
              </div>`
            : domainRows
              ? `<div class="sub-block">
                  <h3>Cited Domain Persistence Overview</h3>
                  <div class="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Durability Tier</th>
                          <th>Domain</th>
                          <th class="num">Waves Seen</th>
                          <th class="num">Citations</th>
                          <th class="num">Competitor Recs</th>
                        </tr>
                      </thead>
                      <tbody>${domainRows}</tbody>
                    </table>
                  </div>
                </div>`
              : '<p class="empty-note">No persistent off-site targets or cited URLs were recorded in completed runs for this window.</p>'
        }

        ${renderLimitationsBox(persistence.limitations)}
      </div>
    </details>
  </section>`;
}

/**
 * Render the self-contained, single-file interactive HTML B2B client report.
 *
 * @param {ReturnType<typeof buildClientReport>} report
 * @param {WhiteLabelInput} [opts]
 * @returns {string}
 */
export function renderClientReportHtml(report, opts = {}) {
  const whiteLabel = sanitizeWhiteLabelOptions({
    ...(report?.whiteLabel ?? {}),
    ...(opts ?? {}),
  });
  const brandName = report.brand?.name ?? 'Unconfigured Brand';
  const headerBrandLabel = whiteLabel.brandLabel
    ? `${whiteLabel.brandLabel} · AI Visibility Evidence Dossier`
    : 'Hearsay · B2B AI Visibility Audit';
  const titleText = whiteLabel.brandLabel
    ? `${brandName} — ${whiteLabel.brandLabel}`
    : `${brandName} — AI Visibility & Citation Audit`;
  const footerText = whiteLabel.footerNote
    ? whiteLabel.footerNote
    : whiteLabel.brandLabel
      ? `Prepared by ${whiteLabel.brandLabel} · Confidence intervals & verbatim receipts · Zero blended scores`
      : 'Generated by Hearsay (MIT, local-first AI recommendation evidence) · Zero blended scores';
  const accentOverrideCss = whiteLabel.accentColor
    ? `
    :root, html[data-theme="dark"], html[data-theme="light"] {
      --accent: ${whiteLabel.accentColor};
      --accent-solid: ${whiteLabel.accentColor};
      --accent-soft: ${hexToRgba(whiteLabel.accentColor, 0.16)};
      --accent-band: ${hexToRgba(whiteLabel.accentColor, 0.42)};
      --accent-border: ${hexToRgba(whiteLabel.accentColor, 0.35)};
    }`
    : '';
  const demoPill = report.demo
    ? '<span class="pill pill-warn">Demo Sample Dataset</span>'
    : '<span class="pill pill-accent">Verified Audit Snapshot</span>';

  const seriesMetaHtml = report.series
    ? `<div class="meta-grid">
        <div class="meta-cell"><span class="meta-label">Measurement Surface</span><strong>${escapeHtml(report.series.surfaceLabel)}</strong><code>${escapeHtml(report.series.surface)}</code></div>
        <div class="meta-cell"><span class="meta-label">Window (UTC)</span><strong>${escapeHtml(report.window.start.slice(0, 10))} → ${escapeHtml(report.window.end.slice(0, 10))}</strong><span class="muted">${report.days}d window · generated ${escapeHtml(report.generatedAt)}</span></div>
        <div class="meta-cell"><span class="meta-label">Coverage Funnel</span><strong>${report.series.comparableAnswers} / ${report.series.attemptedTargets} comparable</strong><span class="muted">${report.series.verifiedSearchAnswers} verified search · ${report.series.queryMetadataAnswers} with query metadata</span></div>
        <div class="meta-cell"><span class="meta-label">Series Contract</span><code>${escapeHtml(report.series.id.slice(0, 16))}</code><span class="muted">search: ${escapeHtml(report.series.searchPolicy)} · analysis: ${escapeHtml(report.series.analysisRevision)}</span></div>
      </div>`
    : `<p class="empty-note">No completed measurement series was found in the selected ${report.days}-day window (${escapeHtml(report.window.start)} to ${escapeHtml(report.window.end)} UTC).</p>`;

  const mentionKpi = report.kpis.mentionRate;
  const recKpi = report.kpis.recommendationRate;
  const sovCi = report.kpis.brandSovCi;

  const kpiSectionHtml = report.series
    ? `<section class="kpi-grid" aria-label="Headline visibility metrics">
        <article class="glass-card kpi-card">
          <span class="kpi-label">Answer Rate (Brand Mention)</span>
          <div class="kpi-main">${escapeHtml(fmtPct(mentionKpi?.p))}</div>
          <p class="kpi-ci">${escapeHtml(
            mentionKpi && mentionKpi.p !== null
              ? `95% Wilson CI [${fmtPct(mentionKpi.lo)}–${fmtPct(mentionKpi.hi)}] · ${mentionKpi.mentioned}/${mentionKpi.n} answers (n=${mentionKpi.n})`
              : `n=${mentionKpi?.n ?? 0}`,
          )}${mentionKpi?.lowSample ? ' <span class="pill pill-warn">low sample</span>' : ''}</p>
          ${renderCiBar(mentionKpi, true)}
        </article>
        <article class="glass-card kpi-card">
          <span class="kpi-label">Share of AI Voice</span>
          <div class="kpi-main">${escapeHtml(fmtPct(report.kpis.brandSov, 1))}</div>
          <p class="kpi-ci">${escapeHtml(
            sovCi && sovCi.p !== null
              ? `95% Wilson CI [${fmtPct(sovCi.lo, 1)}–${fmtPct(sovCi.hi, 1)}] · ${report.kpis.brandMentions}/${report.kpis.totalEntityMentions} entity mentions (n=${report.kpis.totalEntityMentions})`
              : `0/${report.kpis.totalEntityMentions} tracked mentions (n=${report.kpis.totalEntityMentions})`,
          )}</p>
          ${renderCiBar(sovCi, true)}
        </article>
        <article class="glass-card kpi-card">
          <span class="kpi-label">Positive Recommendation Rate</span>
          <div class="kpi-main">${escapeHtml(fmtPct(recKpi?.p))}</div>
          <p class="kpi-ci">${escapeHtml(
            recKpi && recKpi.p !== null
              ? `95% Wilson CI [${fmtPct(recKpi.lo)}–${fmtPct(recKpi.hi)}] · ${recKpi.recommended}/${recKpi.n} answers (n=${recKpi.n})`
              : `n=${recKpi?.n ?? 0}`,
          )}${recKpi?.lowSample ? ' <span class="pill pill-warn">low sample</span>' : ''}</p>
          ${renderCiBar(recKpi, true)}
        </article>
      </section>`
    : '';

  const leaderboardRowsHtml = report.leaderboard
    .map(
      (row) => `<tr class="${row.isSelf ? 'row-brand' : ''}">
        <td>
          <strong>${escapeHtml(row.name)}</strong>
          ${row.isSelf ? '<span class="pill pill-accent">Brand</span>' : ''}
        </td>
        <td class="num">
          <div class="cell-metric">${escapeHtml(fmtRateSummary(row.mentionRate))}</div>
          ${renderCiBar(row.mentionRate, row.isSelf)}
        </td>
        <td class="num">
          <div class="cell-metric">${escapeHtml(fmtPct(row.sov, 1))} <span class="muted">(${row.mentions}/${report.kpis.totalEntityMentions})</span></div>
          ${renderCiBar(row.sovCi, row.isSelf)}
        </td>
        <td class="num">${escapeHtml(fmtRateSummary(row.recommendationRate))}</td>
        <td class="num">${row.avgRank === null || !Number.isFinite(row.avgRank) ? '—' : row.avgRank.toFixed(1)}</td>
      </tr>`,
    )
    .join('');

  const leaderboardSectionHtml =
    report.leaderboard.length > 0
      ? `<section class="glass-card section-block">
          <div class="section-header">
            <h2>Competitive Share of AI Voice &amp; Answer Rates</h2>
            <p class="muted">Non-branded comparable answers only. Every proportion carries its Wilson 95% confidence interval and exact sample count.</p>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Entity</th>
                  <th class="num">Answer Rate (95% CI)</th>
                  <th class="num">Share of Voice</th>
                  <th class="num">Recommendation Rate</th>
                  <th class="num">Avg Rank</th>
                </tr>
              </thead>
              <tbody>${leaderboardRowsHtml}</tbody>
            </table>
          </div>
        </section>`
      : '';

  const intentRowsHtml = report.intents
    .map(
      (intent) => `<tr>
        <td><strong>${escapeHtml(intent.label)}</strong><div class="muted small">${intent.paraphraseCount} phrasing(s)</div></td>
        <td class="num">
          <div class="cell-metric">${escapeHtml(fmtRateSummary({ ...intent.pooled, n: intent.n }))}</div>
          ${renderCiBar(intent.pooled, true)}
        </td>
        <td class="num">${intent.phrasingSpread === null ? '—' : `±${Math.round(intent.phrasingSpread * 100)} pts`}</td>
        <td class="num">${intent.rerunSpread === null ? '—' : `±${Math.round(intent.rerunSpread * 100)} pts`}</td>
      </tr>`,
    )
    .join('');

  const intentsSectionHtml =
    report.intents.length > 0
      ? `<section class="glass-card section-block">
          <div class="section-header">
            <h2>Buyer Intent &amp; Phrasing Sensitivity</h2>
            <p class="muted">Separates wording sensitivity across paraphrases from model rerun noise on identical prompts.</p>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Buyer Intent</th>
                  <th class="num">Brand Answer Rate (95% CI)</th>
                  <th class="num">Phrasing Spread</th>
                  <th class="num">Rerun Spread</th>
                </tr>
              </thead>
              <tbody>${intentRowsHtml}</tbody>
            </table>
          </div>
        </section>`
      : '';

  const gapRowsHtml = report.citationGaps
    .map((gap) => {
      const safeHref = safeHttpUrl(gap.sampleUrl);
      const urlMarkup = safeHref
        ? `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(gap.sampleUrl)}</a>`
        : `<code>${escapeHtml(gap.sampleUrl)}</code>`;
      return `<tr>
        <td><strong>${escapeHtml(gap.domain)}</strong></td>
        <td class="num"><strong>${gap.count}</strong></td>
        <td>${gap.competitors.length > 0 ? escapeHtml(gap.competitors.join(', ')) : '<span class="muted">Unbranded omission</span>'}</td>
        <td class="url-cell">${urlMarkup}<div class="muted small">Prompt: ${escapeHtml(gap.samplePrompt)}</div></td>
      </tr>`;
    })
    .join('');

  const gapSectionHtml = `<section class="glass-card section-block">
    <div class="section-header">
      <h2>Top Citation-Gap Domains</h2>
      <p class="muted">Third-party domains cited in comparable AI answers where competitors appear and ${escapeHtml(brandName)} is absent.</p>
    </div>
    ${
      report.citationGaps.length > 0
        ? `<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cited Domain</th>
                  <th class="num">Answers</th>
                  <th>Competitors Mentioned</th>
                  <th>Sample Cited Source &amp; Prompt</th>
                </tr>
              </thead>
              <tbody>${gapRowsHtml}</tbody>
            </table>
          </div>`
        : '<p class="empty-note">No competitor citation-gap domains recorded in this series and window.</p>'
    }
  </section>`;

  const receiptsHtml = report.receipts
    .map((receipt, idx) => {
      const statusBadge = receipt.brandRecommended
        ? '<span class="pill pill-good">Recommended</span>'
        : receipt.brandPresent
          ? '<span class="pill pill-accent">Brand Mentioned</span>'
          : '<span class="pill pill-muted">Brand Omitted</span>';

      const queriesMarkup =
        receipt.searchQueries.length > 0
          ? `<ul class="compact-list">${receipt.searchQueries.map((q) => `<li><code>${escapeHtml(q)}</code></li>`).join('')}</ul>`
          : '<span class="muted">No search query recorded (unsearched route or provider omitted query metadata)</span>';

      const urlsMarkup =
        receipt.citedUrls.length > 0
          ? `<ul class="compact-list">${receipt.citedUrls
              .map((u) => {
                const href = safeHttpUrl(u);
                return href
                  ? `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a></li>`
                  : `<li><code>${escapeHtml(u)}</code></li>`;
              })
              .join('')}</ul>`
          : '<span class="muted">No URLs cited in answer</span>';

      const entitiesMarkup =
        receipt.mentions.length > 0
          ? receipt.mentions
              .map(
                (m) =>
                  `<span class="pill ${m.isSelf ? 'pill-accent' : 'pill-muted'}">#${m.rank} ${escapeHtml(m.name)}${m.stance ? ` · ${escapeHtml(m.stance)}` : ''}</span>`,
              )
              .join(' ')
          : '<span class="muted">No tracked entities mentioned</span>';

      const receiptFilterKey = receipt.brandPresent ? 'mentioned' : 'omitted';

      return `<details class="receipt-item" data-receipt-state="${receiptFilterKey}"${idx < 3 ? ' open' : ''}>
        <summary class="receipt-summary">
          <div class="receipt-summary-main">
            <span class="pill pill-surface">${escapeHtml(receipt.surfaceLabel)} · ${escapeHtml(receipt.model)}</span>
            ${statusBadge}
            <span class="receipt-prompt-title">${escapeHtml(receipt.prompt)}</span>
          </div>
          <span class="receipt-meta muted">${escapeHtml(receipt.createdAt)} · ${receipt.citedUrls.length} citation(s)</span>
        </summary>
        <div class="receipt-body">
          <div class="receipt-meta-grid">
            <div><span class="meta-label">Exact Buyer Prompt</span><p>${escapeHtml(receipt.prompt)}</p></div>
            <div><span class="meta-label">Web Search Queries Executed</span><div>${queriesMarkup}</div></div>
            <div><span class="meta-label">Cited URLs</span><div>${urlsMarkup}</div></div>
            <div><span class="meta-label">Detected Entities &amp; Stance</span><div class="pill-wrap">${entitiesMarkup}</div></div>
          </div>
          <div class="receipt-text-block">
            <span class="meta-label">Verbatim Model Response (Receipt #${receipt.id})</span>
            <pre class="receipt-verbatim">${escapeHtml(receipt.text)}</pre>
          </div>
        </div>
      </details>`;
    })
    .join('');

  const receiptsSectionHtml = `<section class="glass-card section-block">
    <div class="section-header section-header-row">
      <div>
        <h2>Verbatim Answer Receipts</h2>
        <p class="muted">${
          report.totalComparableReceipts > report.receipts.length
            ? `Showing the ${report.receipts.length} most recent of ${report.totalComparableReceipts} comparable answers.`
            : `${report.receipts.length} comparable answer receipt(s) in this window.`
        }</p>
      </div>
      ${
        report.receipts.length > 0
          ? `<div class="receipt-controls no-print" role="toolbar" aria-label="Receipt filters">
              <button type="button" class="btn-ghost is-active" data-receipt-filter="all" aria-pressed="true">All (${report.receipts.length})</button>
              <button type="button" class="btn-ghost" data-receipt-filter="mentioned" aria-pressed="false">Mentioned (${report.receipts.filter((r) => r.brandPresent).length})</button>
              <button type="button" class="btn-ghost" data-receipt-filter="omitted" aria-pressed="false">Omitted (${report.receipts.filter((r) => !r.brandPresent).length})</button>
              <button type="button" class="btn-ghost" id="expand-all-receipts">Expand all</button>
              <button type="button" class="btn-ghost" id="collapse-all-receipts">Collapse all</button>
            </div>`
          : ''
      }
    </div>
    ${
      report.receipts.length > 0
        ? `<div class="receipt-list">${receiptsHtml}</div>`
        : '<p class="empty-note">No comparable answer receipts available for this window.</p>'
    }
  </section>`;

  const interventionsHtml =
    report.interventions.length > 0
      ? `<div class="sub-block">
          <h3>Tracked Page Interventions &amp; Opportunities</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID &amp; Status</th>
                  <th>Action / Change Shipped</th>
                  <th>Target URL</th>
                  <th>Shipped / Review</th>
                </tr>
              </thead>
              <tbody>
                ${report.interventions
                  .map((item) => {
                    const href = item.targetUrl ? safeHttpUrl(item.targetUrl) : null;
                    return `<tr>
                      <td><strong>#${item.id}</strong> <span class="pill pill-muted">${escapeHtml(item.status)}</span></td>
                      <td>${escapeHtml(item.changeDescription || item.suggestedAction || item.observedFinding)}</td>
                      <td class="url-cell">${
                        href
                          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.targetUrl)}</a>`
                          : item.targetUrl
                            ? `<code>${escapeHtml(item.targetUrl)}</code>`
                            : '<span class="muted">—</span>'
                      }</td>
                      <td class="muted small">${escapeHtml(item.shippedAt ? `Shipped ${item.shippedAt}` : item.reviewDate ? `Review ${item.reviewDate}` : 'Unscheduled')}</td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>`
      : '';

  const outcomesHtml =
    report.outcomes.length > 0
      ? `<div class="sub-block">
          <h3>Reported Business Outcomes</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th class="num">Reported Value</th>
                  <th>Landing Page</th>
                  <th>Period &amp; Attribution</th>
                </tr>
              </thead>
              <tbody>
                ${report.outcomes
                  .map(
                    (o) => `<tr>
                      <td><strong>${escapeHtml(o.metricName)}</strong><div class="muted small">${escapeHtml(o.source)}</div></td>
                      <td class="num"><strong>${escapeHtml(o.value)}</strong> ${escapeHtml(o.unit)}${o.currency ? ` ${escapeHtml(o.currency)}` : ''}</td>
                      <td>${o.landingPage ? `<code>${escapeHtml(o.landingPage)}</code>` : '<span class="muted">Workspace-wide</span>'}</td>
                      <td>
                        <div>${escapeHtml(o.periodStart.slice(0, 10))} → ${escapeHtml(o.periodEnd.slice(0, 10))}</div>
                        <div class="muted small">${escapeHtml(o.attributionMethod)}${o.notes ? ` · ${escapeHtml(o.notes)}` : ''}</div>
                      </td>
                    </tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>`
      : '';

  const outcomesSectionHtml = `<section class="glass-card section-block">
    <div class="section-header">
      <h2>Interventions &amp; Business Outcomes</h2>
      <p class="muted">Observed side-by-side with AI citation evidence in the ${escapeHtml(report.window.start.slice(0, 10))} → ${escapeHtml(report.window.end.slice(0, 10))} window (descriptive, non-causal).</p>
    </div>
    ${
      interventionsHtml || outcomesHtml
        ? `${interventionsHtml}${outcomesHtml}`
        : '<p class="empty-note">No page interventions or business outcome records have been logged for this window yet.</p>'
    }
  </section>`;

  const separationSectionHtml = renderSeparationBarsSection(report);
  const volatilitySectionHtml = renderVolatilityCallout(report);
  const attritionSectionHtml = renderAttritionSection(report.forensics?.attrition);
  const memoryVsSearchSectionHtml = renderMemoryVsSearchSection(report.forensics?.memoryVsSearch);
  const persistenceSectionHtml = renderPersistenceSection(report.forensics?.persistence);

  const competitorsLine =
    report.competitors.length > 0
      ? report.competitors.map((c) => escapeHtml(c.name)).join(', ')
      : 'None configured';

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>${escapeHtml(titleText)}</title>
  <style>
    :root, html[data-theme="dark"] {
      --bg: #0a0c10;
      --bg-glow: rgba(59, 130, 246, 0.08);
      --surface: rgba(17, 21, 28, 0.84);
      --surface-elevated: rgba(24, 30, 40, 0.78);
      --ink: #f8fafc;
      --ink-2: #cbd5e1;
      --muted: #94a3b8;
      --border: rgba(255, 255, 255, 0.1);
      --border-strong: rgba(255, 255, 255, 0.18);
      --accent: #60a5fa;
      --accent-solid: #3b82f6;
      --accent-soft: rgba(59, 130, 246, 0.16);
      --accent-band: rgba(59, 130, 246, 0.42);
      --accent-border: rgba(59, 130, 246, 0.3);
      --cite: #a78bfa;
      --cite-soft: rgba(139, 92, 246, 0.16);
      --good: #34d399;
      --good-soft: rgba(16, 185, 129, 0.16);
      --warn: #fbbf24;
      --warn-soft: rgba(245, 158, 11, 0.16);
      --danger: #f87171;
      --danger-soft: rgba(239, 68, 68, 0.16);
      --track: rgba(255, 255, 255, 0.09);
      --code-bg: rgba(10, 12, 16, 0.65);
      color-scheme: dark;
    }

    html[data-theme="light"] {
      --bg: #f8fafc;
      --bg-glow: rgba(37, 99, 235, 0.05);
      --surface: rgba(255, 255, 255, 0.94);
      --surface-elevated: #f1f5f9;
      --ink: #0f172a;
      --ink-2: #334155;
      --muted: #64748b;
      --border: rgba(15, 23, 42, 0.1);
      --border-strong: rgba(15, 23, 42, 0.2);
      --accent: #2563eb;
      --accent-solid: #2563eb;
      --accent-soft: rgba(37, 99, 235, 0.1);
      --accent-band: rgba(37, 99, 235, 0.38);
      --accent-border: rgba(37, 99, 235, 0.28);
      --cite: #7c3aed;
      --cite-soft: rgba(124, 58, 237, 0.12);
      --good: #059669;
      --good-soft: rgba(5, 150, 105, 0.12);
      --warn: #b45309;
      --warn-soft: rgba(217, 119, 6, 0.12);
      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, 0.12);
      --track: rgba(15, 23, 42, 0.1);
      --code-bg: #f1f5f9;
      color-scheme: light;
    }${accentOverrideCss}

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background-color: var(--bg);
      background-image: radial-gradient(ellipse 80% 40% at 50% -10%, var(--bg-glow), transparent);
      color: var(--ink);
      font: 15px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.88em;
    }
    code {
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 4px;
      overflow-wrap: anywhere;
    }

    .report-shell {
      max-width: 1120px;
      margin: 0 auto;
      padding: 28px 20px 64px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .brand-eyebrow {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn-ghost, .btn-solid {
      padding: 7px 13px;
      border-radius: 7px;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--ink);
    }
    .btn-solid {
      background: var(--accent-solid);
      border-color: var(--accent-solid);
      color: #ffffff;
    }
    .btn-ghost:hover { border-color: var(--border-strong); }
    .btn-ghost.is-active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
    }
    .receipt-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .glass-card {
      background: var(--surface);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }

    .hero-card { margin-bottom: 18px; }
    .hero-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    h1 { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 6px; }
    h2 { font-size: 17px; font-weight: 620; letter-spacing: -0.01em; margin: 0 0 4px; }
    h3 { font-size: 14px; font-weight: 600; margin: 0 0 8px; color: var(--ink-2); }
    p { margin: 0 0 8px; }
    .muted { color: var(--muted); }
    .small { font-size: 12.5px; }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .meta-cell {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .meta-label {
      font-size: 11.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .kpi-card { display: flex; flex-direction: column; gap: 6px; }
    .kpi-label { font-size: 13px; font-weight: 600; color: var(--ink-2); }
    .kpi-main { font-size: 32px; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; line-height: 1.15; }
    .kpi-ci { font-size: 12.5px; color: var(--muted); margin: 0 0 4px; font-variant-numeric: tabular-nums; }

    .ci-track {
      display: block;
      width: 100%;
      position: relative;
      height: 7px;
      border-radius: 999px;
      background: var(--track);
      overflow: hidden;
      min-width: 90px;
    }
    .ci-band {
      position: absolute;
      top: 0;
      bottom: 0;
      background: rgba(148, 163, 184, 0.42);
      border-radius: 999px;
    }
    .ci-track.is-brand .ci-band { background: var(--accent-band); }
    .ci-point {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 3px;
      margin-left: -1.5px;
      background: var(--ink);
      border-radius: 2px;
    }
    .ci-track.is-brand .ci-point { background: var(--accent); }

    .separation-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .sep-card {
      padding: 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--surface-elevated);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .sep-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .sep-title { font-size: 13px; font-weight: 600; color: var(--ink-2); }
    .sep-value { font-size: 28px; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; line-height: 1.1; }
    .sep-meta { font-size: 12px; color: var(--muted); margin: 0; font-variant-numeric: tabular-nums; }
    .sep-caption { margin: 4px 0 0; }
    .sep-bar-track {
      height: 10px;
      border-radius: 999px;
      background: var(--track);
      overflow: hidden;
      margin-bottom: 4px;
    }
    .sep-bar-fill {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--accent-solid);
    }
    .sep-tone-citation .sep-bar-fill { background: var(--cite); }
    .sep-tone-recommendation .sep-bar-fill { background: var(--good); }
    .callout-note {
      margin: 12px 0 0;
      padding: 10px 12px;
      border-radius: 8px;
      border-left: 3px solid var(--accent);
      background: var(--surface-elevated);
      color: var(--ink-2);
    }

    .volatility-callout { border-left: 3px solid var(--warn); }
    .callout-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .volatility-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .vol-item {
      padding: 12px;
      border-radius: 9px;
      border: 1px solid var(--border);
      background: var(--surface-elevated);
    }

    .forensics-details { width: 100%; }
    .forensics-summary {
      cursor: pointer;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
      list-style: none;
    }
    .forensics-summary::-webkit-details-marker { display: none; }
    .forensics-badges {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .forensics-body {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .mini-kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .mini-kpi {
      padding: 11px 12px;
      border-radius: 9px;
      border: 1px solid var(--border);
      background: var(--surface-elevated);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mini-kpi strong { font-size: 18px; font-variant-numeric: tabular-nums; }
    .limitations-box {
      margin-top: 14px;
      padding: 11px 13px;
      border-radius: 9px;
      border: 1px solid var(--border);
      background: var(--code-bg);
      color: var(--ink-2);
      font-size: 12.5px;
    }

    .section-block { margin-bottom: 18px; }
    .section-header { margin-bottom: 14px; }
    .section-header-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .sub-block { margin-top: 14px; }

    .table-wrap { overflow-x: auto; max-width: 100%; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 10px 10px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--muted);
    }
    th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr.row-brand td { background: var(--accent-soft); }
    .cell-metric { margin-bottom: 5px; }
    .url-cell { max-width: 380px; overflow-wrap: anywhere; }

    .pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      border: 1px solid var(--border);
      background: var(--surface-elevated);
      color: var(--ink-2);
      white-space: nowrap;
    }
    .pill-accent { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border); }
    .pill-cite { background: var(--cite-soft); color: var(--cite); border-color: rgba(139, 92, 246, 0.35); }
    .pill-good { background: var(--good-soft); color: var(--good); border-color: rgba(16, 185, 129, 0.3); }
    .pill-warn { background: var(--warn-soft); color: var(--warn); border-color: rgba(245, 158, 11, 0.3); }
    .pill-danger { background: var(--danger-soft); color: var(--danger); border-color: rgba(239, 68, 68, 0.35); }
    .pill-surface { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 500; }
    .pill-wrap { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }

    .receipt-list { display: grid; gap: 10px; }
    .receipt-item {
      border: 1px solid var(--border);
      border-radius: 9px;
      background: var(--surface-elevated);
      overflow: hidden;
    }
    .receipt-summary {
      cursor: pointer;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      list-style: none;
    }
    .receipt-summary::-webkit-details-marker { display: none; }
    .receipt-summary-main {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .receipt-prompt-title { font-weight: 600; overflow-wrap: anywhere; }
    .receipt-body {
      padding: 14px;
      border-top: 1px solid var(--border);
      background: var(--surface);
    }
    .receipt-meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }
    .compact-list { margin: 4px 0 0; padding-left: 18px; }
    .compact-list li { margin-bottom: 3px; overflow-wrap: anywhere; }
    .receipt-verbatim {
      margin: 6px 0 0;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--code-bg);
      color: var(--ink);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.5;
    }

    .empty-note { color: var(--muted); padding: 8px 0 0; }
    .report-footer {
      margin-top: 24px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 12.5px;
      color: var(--muted);
    }

    @media (max-width: 860px) {
      .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .kpi-grid, .separation-grid, .volatility-grid { grid-template-columns: 1fr; }
      .receipt-meta-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .meta-grid { grid-template-columns: 1fr; }
    }

    @media print {
      @page { margin: 14mm; }
      :root, html[data-theme="dark"], html[data-theme="light"] {
        --bg: #ffffff;
        --surface: #ffffff;
        --surface-elevated: #f8fafc;
        --ink: #0f172a;
        --ink-2: #334155;
        --muted: #475569;
        --border: #cbd5e1;
        --border-strong: #94a3b8;
        --accent: ${whiteLabel.accentColor ?? '#1d4ed8'};
        --accent-solid: ${whiteLabel.accentColor ?? '#1d4ed8'};
        --accent-soft: ${whiteLabel.accentColor ? hexToRgba(whiteLabel.accentColor, 0.1) : '#eff6ff'};
        --accent-band: ${whiteLabel.accentColor ? hexToRgba(whiteLabel.accentColor, 0.35) : 'rgba(29, 78, 216, 0.35)'};
        --accent-border: ${whiteLabel.accentColor ? hexToRgba(whiteLabel.accentColor, 0.3) : 'rgba(29, 78, 216, 0.3)'};
        --cite: #6d28d9;
        --cite-soft: #f5f3ff;
        --good: #047857;
        --good-soft: #ecfdf5;
        --warn: #b45309;
        --warn-soft: #fffbeb;
        --danger: #b91c1c;
        --danger-soft: #fef2f2;
        --track: #e2e8f0;
        --code-bg: #f8fafc;
      }
      body { background: #ffffff !important; background-image: none !important; color: #0f172a !important; font-size: 11pt; }
      .report-shell { max-width: none; padding: 0; }
      .no-print { display: none !important; }
      .glass-card { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; break-inside: avoid; }
      .kpi-grid, .separation-grid, .volatility-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .kpi-card, .sep-card, .vol-item, .mini-kpi, .receipt-item, tr { break-inside: avoid; }
      a { color: ${whiteLabel.accentColor ?? '#1d4ed8'} !important; text-decoration: underline; }
    }
  </style>
</head>
<body>
  <main class="report-shell">
    <div class="topbar">
      <div class="brand-eyebrow">
        <span>${escapeHtml(headerBrandLabel)}</span>
        ${demoPill}
      </div>
      <div class="toolbar no-print">
        <button type="button" class="btn-ghost" id="theme-toggle" aria-pressed="false">Light mode</button>
        <button type="button" class="btn-solid" id="print-report">Print / Save as PDF</button>
      </div>
    </div>

    <header class="glass-card hero-card">
      <div class="hero-head">
        <div>
          <h1>${escapeHtml(brandName)}</h1>
          <p class="muted">Tracked competitors: ${competitorsLine}${
            report.brand?.domains?.length
              ? ` · Brand domain(s): ${escapeHtml(report.brand.domains.join(', '))}`
              : ''
          }</p>
        </div>
      </div>
      ${seriesMetaHtml}
    </header>

    ${kpiSectionHtml}
    ${separationSectionHtml}
    ${volatilitySectionHtml}
    ${leaderboardSectionHtml}
    ${intentsSectionHtml}
    ${attritionSectionHtml}
    ${memoryVsSearchSectionHtml}
    ${persistenceSectionHtml}
    ${gapSectionHtml}
    ${receiptsSectionHtml}
    ${outcomesSectionHtml}

    <footer class="report-footer">
      <span>${escapeHtml(footerText)}</span>
      <span>${escapeHtml(report.generatedAt)}</span>
    </footer>
  </main>
  <script>
    (function () {
      var root = document.documentElement;
      var toggle = document.getElementById('theme-toggle');
      var printBtn = document.getElementById('print-report');
      var expandBtn = document.getElementById('expand-all-receipts');
      var collapseBtn = document.getElementById('collapse-all-receipts');

      function applyMode(mode) {
        root.setAttribute('data-theme', mode);
        if (toggle) {
          var isLight = mode === 'light';
          toggle.setAttribute('aria-pressed', String(isLight));
          toggle.textContent = isLight ? 'Dark mode' : 'Light mode';
        }
      }

      if (toggle) {
        toggle.addEventListener('click', function () {
          var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
          applyMode(next);
        });
      }
      if (printBtn) {
        printBtn.addEventListener('click', function () {
          window.print();
        });
      }
      if (expandBtn) {
        expandBtn.addEventListener('click', function () {
          var items = document.querySelectorAll('details.receipt-item');
          for (var i = 0; i < items.length; i += 1) items[i].open = true;
        });
      }
      if (collapseBtn) {
        collapseBtn.addEventListener('click', function () {
          var items = document.querySelectorAll('details.receipt-item');
          for (var i = 0; i < items.length; i += 1) items[i].open = false;
        });
      }
      var filterBtns = document.querySelectorAll('[data-receipt-filter]');
      for (var f = 0; f < filterBtns.length; f += 1) {
        filterBtns[f].addEventListener('click', function (ev) {
          var btn = ev.currentTarget;
          var wanted = btn.getAttribute('data-receipt-filter') || 'all';
          for (var j = 0; j < filterBtns.length; j += 1) {
            var active = filterBtns[j] === btn;
            filterBtns[j].classList.toggle('is-active', active);
            filterBtns[j].setAttribute('aria-pressed', String(active));
          }
          var items = document.querySelectorAll('details.receipt-item');
          for (var k = 0; k < items.length; k += 1) {
            var state = items[k].getAttribute('data-receipt-state');
            items[k].hidden = wanted !== 'all' && state !== wanted;
          }
        });
      }
    })();
  </script>
</body>
</html>
`;
}

/** Backwards-compatible alias for `renderClientReportHtml`. */
export const renderClientReport = renderClientReportHtml;
