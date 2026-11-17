/**
 * Self-contained B2B Client Report HTML export.
 *
 * Pure read-only aggregation over exact measurement series, Wilson 95% confidence
 * intervals, competitor citation gaps, verbatim answer receipts, and recorded
 * interventions / business outcomes. Zero secrets, zero local filesystem paths,
 * zero external network dependencies.
 */

import { isAgentSurface } from './agent-routes.js';
import { all, getSetting, SETTING_KEYS } from './db.js';
import * as metrics from './metrics.js';
import { listOpportunities } from './opportunities.js';
import { listLedgerEntries, listOutcomeRecords } from './outcomes.js';
import { surfaceLabel } from './subscription-model.js';
import { brandEntity, listEntities, queryAnswers, windowStart } from '../web/queries.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./metrics.js').MeasurementSeries} MeasurementSeries */

const DEFAULT_REPORT_DAYS = 30;
const DEFAULT_RECEIPT_LIMIT = 50;
const MAX_RECEIPT_LIMIT = 200;

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
  return { useStance, statsByEntity: out };
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
 */
export function buildClientReport(db, opts = {}) {
  const nowDate = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const generatedAt = `${nowDate.toISOString().slice(0, 19)}Z`;
  const days = Math.max(1, Math.min(3650, Math.floor(opts.days ?? DEFAULT_REPORT_DAYS)));
  const receiptLimit = Math.max(
    1,
    Math.min(MAX_RECEIPT_LIMIT, Math.floor(opts.receiptLimit ?? DEFAULT_RECEIPT_LIMIT)),
  );

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

  if (!series) {
    return {
      generatedAt,
      demo: Boolean(opts.demo),
      days,
      window: { start: effectiveStart, end: effectiveEnd },
      brand: brand
        ? { id: brand.id, name: brand.name, aliases: brand.aliases, domains: brand.domains }
        : null,
      competitors: competitors.map((c) => ({ name: c.name, domains: c.domains })),
      series: null,
      kpis: {
        mentionRate: null,
        recommendationRate: null,
        recommendationMethod: 'stance',
        brandSov: null,
        brandMentions: 0,
        totalEntityMentions: 0,
      },
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
  const { useStance, statsByEntity } = batchEntitySeriesMetrics(db, series, trackedIds);

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

  return {
    generatedAt,
    demo: Boolean(opts.demo),
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
 * Render the self-contained, single-file interactive HTML B2B client report.
 *
 * @param {ReturnType<typeof buildClientReport>} report
 * @returns {string}
 */
export function renderClientReportHtml(report) {
  const brandName = report.brand?.name ?? 'Unconfigured Brand';
  const titleText = `${brandName} — AI Visibility & Citation Audit`;
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
      --good: #34d399;
      --good-soft: rgba(16, 185, 129, 0.16);
      --warn: #fbbf24;
      --warn-soft: rgba(245, 158, 11, 0.16);
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
      --good: #059669;
      --good-soft: rgba(5, 150, 105, 0.12);
      --warn: #b45309;
      --warn-soft: rgba(217, 119, 6, 0.12);
      --track: rgba(15, 23, 42, 0.1);
      --code-bg: #f1f5f9;
      color-scheme: light;
    }

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
    .ci-track.is-brand .ci-band { background: rgba(59, 130, 246, 0.42); }
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
    .pill-accent { background: var(--accent-soft); color: var(--accent); border-color: rgba(59, 130, 246, 0.3); }
    .pill-good { background: var(--good-soft); color: var(--good); border-color: rgba(16, 185, 129, 0.3); }
    .pill-warn { background: var(--warn-soft); color: var(--warn); border-color: rgba(245, 158, 11, 0.3); }
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
      .kpi-grid { grid-template-columns: 1fr; }
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
        --accent: #1d4ed8;
        --accent-soft: #eff6ff;
        --good: #047857;
        --good-soft: #ecfdf5;
        --warn: #b45309;
        --warn-soft: #fffbeb;
        --track: #e2e8f0;
        --code-bg: #f8fafc;
      }
      body { background: #ffffff !important; background-image: none !important; color: #0f172a !important; font-size: 11pt; }
      .report-shell { max-width: none; padding: 0; }
      .no-print { display: none !important; }
      .glass-card { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; break-inside: avoid; }
      .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .kpi-card, .receipt-item, tr { break-inside: avoid; }
      a { color: #1d4ed8 !important; text-decoration: underline; }
    }
  </style>
</head>
<body>
  <main class="report-shell">
    <div class="topbar">
      <div class="brand-eyebrow">
        <span>Hearsay · B2B AI Visibility Audit</span>
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
    ${leaderboardSectionHtml}
    ${intentsSectionHtml}
    ${gapSectionHtml}
    ${receiptsSectionHtml}
    ${outcomesSectionHtml}

    <footer class="report-footer">
      <span>Generated by Hearsay (MIT, local-first AI recommendation evidence) · Zero blended scores</span>
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
