/**
 * Metrics — read-only SQL, returns plain objects, PURE apart from those reads (§7, §19.6 #6).
 *
 * Binding rules baked in here:
 *  - the window is `days` back from a caller-supplied `now`, and always excludes error
 *    rows ("valid responses" = `responses.error IS NULL`);
 *  - every rate ships with `n`, and carries `lowSample` when `n < 5` (§7 display rule);
 *  - the Wilson 95% interval is the formula in §7, verbatim (anchor: mentioned=17,
 *    n=50 → p=0.34, lo≈0.2244, hi≈0.4785);
 *  - trend days with zero valid responses are OMITTED, never zero-filled (§19.6 #10);
 *  - prompts in category `branded` are excluded from SOV denominators unless
 *    `{includeBranded: true}` (§6.7);
 *  - archived entities never appear (§3).
 *
 * Purity (§19.6 #6): this module never calls `Date.now()` or `new Date()` without an
 * argument, and never reads config or the environment. Callers pass `now` — an ISO-8601
 * UTC string or a Date — and get deterministic output for a given database. Omitting
 * `now` throws, on purpose: a silently-defaulted clock is how "why is the dashboard
 * different from the API?" bugs start.
 */

import { all, get } from './db.js';
import { eligibilitySql } from './subscription-model.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {string|number|bigint|null} SqlValue */
/** @typedef {'openai'|'anthropic'|'gemini'|'perplexity'|string} ProviderId */

/**
 * @typedef {Object} Rate
 * @property {number} n valid responses in the window (the denominator)
 * @property {number} mentioned numerator
 * @property {number|null} p null when n = 0
 * @property {number|null} lo Wilson 95% lower bound
 * @property {number|null} hi Wilson 95% upper bound
 * @property {boolean} lowSample true when n < {@link LOW_SAMPLE_N}
 */

/** Default window, in days (§7). */
export const DEFAULT_DAYS = 30;

/** Rates below this n render a "low sample" badge (§7). */
export const LOW_SAMPLE_N = 5;

/** z for a 95% interval (§7). */
const Z = 1.96;

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * Provider display order, mirroring §4.1 / §11.3. Duplicated here rather than imported
 * from `core/config.js` so that metrics stays free of environment reads (§19.6 #6).
 * Providers found in the data but missing from this list sort after it, alphabetically.
 */
const PROVIDER_ORDER = ['openai', 'anthropic', 'gemini', 'perplexity'];
const API_SURFACES = ['openai-api', 'anthropic-api', 'gemini-api', 'perplexity-api'];
const SUBSCRIPTION_SURFACES = ['codex-agent', 'claude-code-agent'];

/**
 * Wilson 95% score interval (§7, embedded exactly).
 *
 * ```
 * z = 1.96, p̂ = mentioned/n
 * center = (p̂ + z²/2n) / (1 + z²/n)
 * half   = z·√(p̂(1−p̂)/n + z²/4n²) / (1 + z²/n)
 * lo = max(0, center−half), hi = min(1, center+half); n = 0 → p null
 * ```
 *
 * @param {number} mentioned
 * @param {number} n
 * @returns {Rate}
 */
export function wilson(mentioned, n) {
  const total = Number(n) || 0;
  const hits = Number(mentioned) || 0;
  if (total <= 0) {
    return { n: 0, mentioned: 0, p: null, lo: null, hi: null, lowSample: true };
  }
  const p = hits / total;
  const z2 = Z * Z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return {
    n: total,
    mentioned: hits,
    p,
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
    lowSample: total < LOW_SAMPLE_N,
  };
}

/**
 * Normalise a caller-supplied timestamp to a UTC ISO-8601 second-precision string.
 * @param {string|Date|undefined} now
 * @param {string} fn name used in the error message
 * @returns {string}
 */
function requireNow(now, fn) {
  if (now === undefined || now === null || now === '') {
    throw new TypeError(`metrics.${fn}: pass now (ISO-8601 UTC string or Date) — metrics.js holds no clock (§19.6 #6)`);
  }
  const date = now instanceof Date ? now : new Date(String(now));
  if (Number.isNaN(date.getTime())) throw new TypeError(`metrics.${fn}: now is not a valid date: ${String(now)}`);
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Start of the window: `now - days`.
 * @param {string} now ISO-8601 UTC
 * @param {number} days
 * @returns {string}
 */
export function windowStart(now, days) {
  const ms = new Date(now).getTime() - Math.max(0, days) * DAY_MS;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * @typedef {Object} WindowOpts
 * @property {number} [days]
 * @property {string|Date} [now]
 * @property {ProviderId} [provider]
 * @property {string} [surface]
 * @property {string} [comparisonKey]
 * @property {boolean} [subscription]
 * @property {boolean} [includeBranded]
 */

/**
 * Everything any metric accepts, plus the database handle for callers that pass it
 * inside the options object.
 * @typedef {WindowOpts & {db?:Db, entityId?:number, limit?:number, demo?:boolean}} MetricsOpts
 */

/**
 * Accept both call shapes. §7 writes these signatures without a database handle, and the
 * web lane passes the open handle as an extra `db` key in the same options object; this
 * module's own convention is `fn(db, opts)`. Both work, so neither caller has to bend.
 *
 * @param {Db|MetricsOpts|undefined} a
 * @param {MetricsOpts|undefined} b
 * @returns {[Db, MetricsOpts]}
 */
function args(a, b) {
  if (a && typeof (/** @type {Db} */ (a).prepare) === 'function') {
    return [/** @type {Db} */ (a), b ?? {}];
  }
  const opts = /** @type {MetricsOpts} */ (a ?? {});
  if (!opts.db) throw new TypeError('metrics: pass the database, either as the first argument or as opts.db');
  return [opts.db, opts];
}

/**
 * Resolve the shared window options once per call.
 * @param {MetricsOpts} opts
 * @param {string} fn
 * @returns {{start:string, end:string, days:number, provider:ProviderId|null, surface:string|null,
 *   comparisonKey:string|null, subscription:boolean, includeBranded:boolean}}
 */
function resolveWindow(opts, fn) {
  const end = requireNow(opts.now, fn);
  const days = Number.isFinite(opts.days) ? Number(opts.days) : DEFAULT_DAYS;
  const surface = opts.surface ? String(opts.surface) : null;
  return {
    start: windowStart(end, days),
    end,
    days,
    provider: opts.provider ? String(opts.provider) : null,
    surface,
    comparisonKey: opts.comparisonKey ? String(opts.comparisonKey) : null,
    subscription: opts.subscription === true || SUBSCRIPTION_SURFACES.includes(surface ?? ''),
    includeBranded: opts.includeBranded === true,
  };
}

/**
 * SQL fragment + params selecting valid responses inside the window. Always used with
 * `FROM responses r JOIN prompts p ON p.id = r.prompt_id`.
 *
 * @param {{start:string, end:string, provider:ProviderId|null, surface:string|null,
 *   comparisonKey:string|null, subscription:boolean, includeBranded:boolean}} w
 * @returns {{sql:string, params:SqlValue[]}}
 */
function validResponses(w) {
  const eligibility = eligibilitySql('r', {
    surface: w.surface ?? undefined,
    comparisonKey: w.comparisonKey ?? undefined,
    subscription: w.subscription,
  });
  const clauses = [eligibility.sql, 'r.error IS NULL'];
  /** @type {SqlValue[]} */
  const params = [...eligibility.params];
  if (w.surface === null && !w.subscription) {
    clauses[0] = `(((${eligibility.sql}) AND (r.surface IS NULL OR r.surface IN (${API_SURFACES.map(() => '?').join(', ')})))
      OR (r.surface IS NULL AND r.lane IS NULL AND r.target_status IS NULL AND r.comparability_status IS NULL AND r.error IS NULL))`;
    params.push(...API_SURFACES);
  } else if (w.surface === null && w.subscription) {
    clauses.push(`r.surface IN (${SUBSCRIPTION_SURFACES.map(() => '?').join(', ')})`);
    params.push(...SUBSCRIPTION_SURFACES);
  }
  // A surface can legitimately have adjacent series after a model/profile/envelope change.
  // Without an explicit key, report only the newest comparable series for that surface so
  // a dashboard window never joins incompatible observations into one trend.
  if (w.surface !== null && w.comparisonKey === null) {
    clauses.push(`r.comparison_key = (
      SELECT latest.comparison_key
        FROM responses latest
       WHERE latest.surface = ?
         AND latest.comparison_key IS NOT NULL
         AND latest.lane = 'tracking'
         AND latest.target_status = 'completed'
         AND latest.comparability_status = 'comparable'
         ${w.subscription ? "AND latest.web_status = 'verified'" : ''}
       ORDER BY latest.created_at DESC, latest.id DESC
       LIMIT 1
    )`);
    params.push(w.surface);
  }
  clauses.push('r.created_at >= ?', 'r.created_at <= ?');
  params.push(w.start, w.end);
  if (w.provider) {
    clauses.push('r.provider = ?');
    params.push(w.provider);
  }
  if (!w.includeBranded) clauses.push("p.category <> 'branded'");
  return { sql: clauses.join(' AND '), params };
}

/**
 * The brand entity — the single `is_self = 1` row that is not archived (§3).
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @returns {{id:number, name:string}|null}
 */
export function brandEntity(dbOrOpts) {
  const [db] = args(dbOrOpts, {});
  const row = get(db, 'SELECT id, name FROM entities WHERE is_self = 1 AND archived_at IS NULL ORDER BY id LIMIT 1');
  return row ? { id: Number(row.id), name: String(row.name) } : null;
}

/**
 * Mention rate for one entity, with a Wilson 95% interval (§7).
 * Denominator: valid responses in the window (branded prompts excluded by default).
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts & {entityId:number}} [maybeOpts]
 * @returns {Rate}
 */
export function mentionRate(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'mentionRate');
  const filter = validResponses(w);
  const row = get(
    db,
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m WHERE m.response_id = r.id AND m.entity_id = ?)
                     THEN 1 ELSE 0 END) AS mentioned
       FROM responses r JOIN prompts p ON p.id = r.prompt_id
      WHERE ${filter.sql}`,
    [Number(opts.entityId), ...filter.params],
  );
  return wilson(Number(row?.mentioned ?? 0), Number(row?.n ?? 0));
}

/**
 * Recommendation rate for one entity (§7): share of valid responses in which the entity
 * is mentioned *and* flagged `recommended` by the §6.4 heuristics.
 *
 * Branded prompts are excluded by default, exactly as for `mentionRate`, so that the two
 * rates in `/api/summary` share one denominator (§10.4).
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts & {entityId:number}} [maybeOpts]
 * @returns {{n:number, recommended:number, p:number|null, lowSample:boolean}}
 */
export function recommendationRate(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'recommendationRate');
  const filter = validResponses(w);
  const row = get(
    db,
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m
                                   WHERE m.response_id = r.id AND m.entity_id = ? AND m.recommended = 1)
                     THEN 1 ELSE 0 END) AS recommended
       FROM responses r JOIN prompts p ON p.id = r.prompt_id
      WHERE ${filter.sql}`,
    [Number(opts.entityId), ...filter.params],
  );
  const n = Number(row?.n ?? 0);
  const recommended = Number(row?.recommended ?? 0);
  return { n, recommended, p: n > 0 ? recommended / n : null, lowSample: n < LOW_SAMPLE_N };
}

/**
 * Average rank of an entity across the answers that mention it (§7). Null when the
 * entity was not mentioned at all in the window — never 0, which would read as "first".
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts & {entityId:number}} [maybeOpts]
 * @returns {number|null}
 */
export function avgRank(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'avgRank');
  const filter = validResponses(w);
  const row = get(
    db,
    `SELECT AVG(m.rank) AS avg_rank, COUNT(*) AS n
       FROM mentions m
       JOIN responses r ON r.id = m.response_id
       JOIN prompts p ON p.id = r.prompt_id
      WHERE m.entity_id = ? AND ${filter.sql}`,
    [Number(opts.entityId), ...filter.params],
  );
  if (!row || Number(row.n ?? 0) === 0) return null;
  return Number(row.avg_rank);
}

/**
 * Share of voice rows for an explicit window. Shared by `shareOfVoice` and the 7-day
 * delta in `summary`.
 *
 * @param {Db} db
 * @param {{start:string, end:string, provider:ProviderId|null, surface:string|null,
 *   comparisonKey:string|null, subscription:boolean, includeBranded:boolean}} w
 * @returns {{entityId:number, name:string, isSelf:boolean, mentions:number, sov:number}[]}
 */
function sovRows(db, w) {
  const filter = validResponses(w);
  const rows = all(
    db,
    `SELECT e.id AS entity_id, e.name AS name, e.is_self AS is_self,
            (SELECT COUNT(*)
               FROM mentions m
               JOIN responses r ON r.id = m.response_id
               JOIN prompts p ON p.id = r.prompt_id
              WHERE m.entity_id = e.id AND ${filter.sql}) AS mentions
       FROM entities e
      WHERE e.archived_at IS NULL
      ORDER BY e.id`,
    filter.params,
  );

  const total = rows.reduce((sum, row) => sum + Number(row.mentions ?? 0), 0);
  return rows
    .map((row) => ({
      entityId: Number(row.entity_id),
      name: String(row.name),
      isSelf: Number(row.is_self) === 1,
      mentions: Number(row.mentions ?? 0),
      // Σ = 0 → sov 0 (§7). A share of nothing is 0, not a divide-by-zero NaN.
      sov: total > 0 ? Number(row.mentions ?? 0) / total : 0,
    }))
    .sort((a, b) => b.mentions - a.mentions || a.entityId - b.entityId);
}

/**
 * Share of voice per entity: `sov = m_e / Σ m` (§7). Branded prompts are excluded from
 * the denominator by default (§6.7).
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts} [maybeOpts]
 * @returns {{entityId:number, name:string, isSelf:boolean, mentions:number, sov:number}[]}
 */
export function shareOfVoice(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  return sovRows(db, resolveWindow(opts, 'shareOfVoice'));
}

/**
 * Share of voice per UTC day (§7). Days with zero valid responses are OMITTED — the
 * chart renders a gap, not a zero (§19.6 #10). `n` is the day's valid-response count,
 * the denominator behind every share on that day.
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts} [maybeOpts]
 * @returns {{date:string, n:number, series:{entityId:number, name:string, isSelf:boolean, mentions:number, sov:number, n:number}[]}[]}
 */
export function sovTrend(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'sovTrend');
  const filter = validResponses(w);

  const dayRows = all(
    db,
    `SELECT substr(r.created_at, 1, 10) AS day, COUNT(*) AS n
       FROM responses r JOIN prompts p ON p.id = r.prompt_id
      WHERE ${filter.sql}
      GROUP BY day
      ORDER BY day`,
    filter.params,
  );
  if (dayRows.length === 0) return [];

  const entities = all(
    db,
    'SELECT id, name, is_self FROM entities WHERE archived_at IS NULL ORDER BY id',
  ).map((row) => ({ entityId: Number(row.id), name: String(row.name), isSelf: Number(row.is_self) === 1 }));

  const mentionRows = all(
    db,
    `SELECT substr(r.created_at, 1, 10) AS day, m.entity_id AS entity_id, COUNT(*) AS mentions
       FROM mentions m
       JOIN responses r ON r.id = m.response_id
       JOIN prompts p ON p.id = r.prompt_id
       JOIN entities e ON e.id = m.entity_id AND e.archived_at IS NULL
      WHERE ${filter.sql}
      GROUP BY day, m.entity_id`,
    filter.params,
  );

  /** @type {Map<string, Map<number, number>>} */
  const byDay = new Map();
  for (const row of mentionRows) {
    const day = String(row.day);
    if (!byDay.has(day)) byDay.set(day, new Map());
    byDay.get(day)?.set(Number(row.entity_id), Number(row.mentions ?? 0));
  }

  return dayRows.map((row) => {
    const date = String(row.day);
    const n = Number(row.n ?? 0);
    const counts = byDay.get(date) ?? new Map();
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    return {
      date,
      n,
      series: entities.map((entity) => {
        const mentions = counts.get(entity.entityId) ?? 0;
        return {
          entityId: entity.entityId,
          name: entity.name,
          isSelf: entity.isSelf,
          mentions,
          sov: total > 0 ? mentions / total : 0,
          n,
        };
      }),
    };
  });
}

/**
 * Citation share for one entity (§7): of the valid answers that carry any citation, how
 * many cite a domain the entity owns. `share` is null when nothing was cited at all —
 * an absent denominator, not a zero.
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts & {entityId:number}} [maybeOpts]
 * @returns {{answersWithCitations:number, brandCited:number, share:number|null}}
 */
export function citationShare(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'citationShare');
  const filter = validResponses(w);
  const row = get(
    db,
    `SELECT
        SUM(CASE WHEN EXISTS (SELECT 1 FROM citations c WHERE c.response_id = r.id) THEN 1 ELSE 0 END) AS with_citations,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM citations c WHERE c.response_id = r.id AND c.entity_id = ?) THEN 1 ELSE 0 END) AS brand_cited
       FROM responses r JOIN prompts p ON p.id = r.prompt_id
      WHERE ${filter.sql}`,
    [Number(opts.entityId), ...filter.params],
  );
  const answersWithCitations = Number(row?.with_citations ?? 0);
  const brandCited = Number(row?.brand_cited ?? 0);
  return {
    answersWithCitations,
    brandCited,
    share: answersWithCitations > 0 ? brandCited / answersWithCitations : null,
  };
}

/**
 * Order providers for display: §4.1 order first, then anything unexpected, alphabetically.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byProviderOrder(a, b) {
  const ai = PROVIDER_ORDER.indexOf(a);
  const bi = PROVIDER_ORDER.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

/**
 * Per-provider breakdown for the dashboard provider row and `/api/summary` (§7, §10.4).
 * Covers every provider that produced a row in the window — including providers whose
 * only rows are errors, so a broken key is visible instead of silently absent.
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts} [maybeOpts]
 * @returns {{provider:string, n:number, brandMentionRate:Rate, avgRank:number|null, citationShare:number|null, citationN:number, lastError:string|null}[]}
 */
export function providerBreakdown(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow({ ...opts, provider: undefined }, 'providerBreakdown');
  const brand = brandEntity(db);
  const surfaceClause = w.surface === null ? `(r.surface IS NULL OR r.surface IN (${API_SURFACES.map(() => '?').join(', ')}))` : 'r.surface = ?';
  const surfaceParams = w.surface === null ? API_SURFACES : [w.surface];

  const providerRows = all(
    db,
    `SELECT DISTINCT r.provider AS provider
       FROM responses r
      WHERE r.created_at >= ? AND r.created_at <= ?
        AND ${surfaceClause}`,
    [w.start, w.end, ...surfaceParams],
  ).map((row) => String(row.provider));
  providerRows.sort(byProviderOrder);

  return providerRows.map((provider) => {
    const scoped = { ...opts, provider, now: w.end };
    const errorRow = get(
      db,
      `SELECT error FROM responses
        WHERE provider = ? AND error IS NOT NULL AND created_at >= ? AND created_at <= ?
          AND ${w.surface === null ? `(surface IS NULL OR surface IN (${API_SURFACES.map(() => '?').join(', ')}))` : 'surface = ?'}
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [provider, w.start, w.end, ...surfaceParams],
    );
    const rate = brand ? mentionRate(db, { ...scoped, entityId: brand.id }) : wilson(0, 0);
    const citations = brand ? citationShare(db, { ...scoped, entityId: brand.id }) : null;
    return {
      provider,
      surface: w.surface,
      n: rate.n,
      brandMentionRate: rate,
      avgRank: brand ? avgRank(db, { ...scoped, entityId: brand.id }) : null,
      citationShare: citations ? citations.share : null,
      // The share is a rate, so it may never be displayed without its base (§7).
      citationN: citations ? citations.answersWithCitations : 0,
      lastError: errorRow ? String(errorRow.error) : null,
    };
  });
}

/**
 * Per-prompt table (§7). Every prompt is listed, including branded ones (badged in the
 * UI) and prompts with no data yet, whose `perProvider` array is simply empty.
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts} [maybeOpts]
 * @returns {{promptId:number, text:string, category:string, active:boolean, intentId:number,
 *            perProvider:{provider:string, brandMentionRate:Rate, brandRecommended:{n:number, recommended:number, p:number|null}, topEntityName:string|null}[]}[]}
 */
export function promptTable(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow({ ...opts, includeBranded: true }, 'promptTable');
  const filter = validResponses(w);
  const brand = brandEntity(db);
  const brandId = brand ? brand.id : -1;

  const prompts = all(db, 'SELECT id, intent_id, text, category, active FROM prompts ORDER BY id');

  const counts = all(
    db,
    `SELECT r.prompt_id AS prompt_id, r.provider AS provider, COUNT(*) AS n,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m WHERE m.response_id = r.id AND m.entity_id = ?)
                     THEN 1 ELSE 0 END) AS mentioned,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m
                                   WHERE m.response_id = r.id AND m.entity_id = ? AND m.recommended = 1)
                     THEN 1 ELSE 0 END) AS recommended
       FROM responses r JOIN prompts p ON p.id = r.prompt_id
      WHERE ${filter.sql}
      GROUP BY r.prompt_id, r.provider`,
    [brandId, brandId, ...filter.params],
  );

  const tops = all(
    db,
    `SELECT r.prompt_id AS prompt_id, r.provider AS provider, e.name AS name, COUNT(*) AS mentions, MIN(e.id) AS entity_id
       FROM mentions m
       JOIN responses r ON r.id = m.response_id
       JOIN prompts p ON p.id = r.prompt_id
       JOIN entities e ON e.id = m.entity_id AND e.archived_at IS NULL
      WHERE ${filter.sql}
      GROUP BY r.prompt_id, r.provider, e.id
      ORDER BY mentions DESC, e.id ASC`,
    filter.params,
  );

  /** @type {Map<string, string>} */
  const topByKey = new Map();
  for (const row of tops) {
    const key = `${Number(row.prompt_id)}|${String(row.provider)}`;
    if (!topByKey.has(key)) topByKey.set(key, String(row.name));
  }

  /** @type {Map<number, {provider:string, brandMentionRate:Rate, brandRecommended:{n:number, recommended:number, p:number|null}, topEntityName:string|null}[]>} */
  const byPrompt = new Map();
  for (const row of counts) {
    const promptId = Number(row.prompt_id);
    const provider = String(row.provider);
    const n = Number(row.n ?? 0);
    const recommended = Number(row.recommended ?? 0);
    const entry = {
      provider,
      brandMentionRate: wilson(Number(row.mentioned ?? 0), n),
      brandRecommended: { n, recommended, p: n > 0 ? recommended / n : null },
      topEntityName: topByKey.get(`${promptId}|${provider}`) ?? null,
    };
    const list = byPrompt.get(promptId);
    if (list) list.push(entry);
    else byPrompt.set(promptId, [entry]);
  }
  for (const list of byPrompt.values()) list.sort((a, b) => byProviderOrder(a.provider, b.provider));

  return prompts.map((row) => ({
    promptId: Number(row.id),
    intentId: Number(row.intent_id),
    text: String(row.text),
    category: String(row.category),
    active: Number(row.active) === 1,
    perProvider: byPrompt.get(Number(row.id)) ?? [],
  }));
}

/**
 * Intent-level pooling and the two-component variance split (§6.6, §7).
 *
 * For each intent, the brand's mention rate is pooled across that intent's paraphrases
 * (that is the number with the Wilson CI), and two spreads are reported alongside it:
 *
 *  - `rerunSpread` — how far a single paraphrase's mean is expected to wobble from rerun
 *    noise alone: √( mean_i[ p_i(1−p_i)/n_i ] ), the sampling standard error averaged
 *    over paraphrases;
 *  - `phrasingSpread` — how far the paraphrase means actually sit apart: the population
 *    standard deviation of p_i, null for a single-paraphrase intent (nothing to compare).
 *
 * Both are fractions (0–1); the UI renders them as ±points ("58% ± 7 (n=36) · phrasing
 * spread ±19 pts"). Neither is ever hidden, and the phrasing component is never folded
 * into the CI — that conflation is exactly what §6.6 exists to avoid.
 *
 * Branded intents are included here (badged in the UI); only SOV excludes them (§6.7).
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts} [maybeOpts]
 * @returns {{intentId:number, label:string, n:number, pooled:Rate, rerunSpread:number|null,
 *            phrasingSpread:number|null, paraphraseCount:number,
 *            paraphrases:{promptId:number, text:string, n:number, mentioned:number, p:number}[]}[]}
 */
export function intentTable(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow({ ...opts, includeBranded: true }, 'intentTable');
  const filter = validResponses(w);
  const brand = brandEntity(db);
  const brandId = brand ? brand.id : -1;

  const rows = all(
    db,
    `SELECT i.id AS intent_id, i.label AS label, p.id AS prompt_id, p.text AS text,
            COUNT(*) AS n,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m WHERE m.response_id = r.id AND m.entity_id = ?)
                     THEN 1 ELSE 0 END) AS mentioned
       FROM responses r
       JOIN prompts p ON p.id = r.prompt_id
       JOIN intents i ON i.id = p.intent_id
      WHERE ${filter.sql}
      GROUP BY i.id, p.id
      ORDER BY i.id, p.id`,
    [brandId, ...filter.params],
  );

  /** @type {Map<number, {label:string, paraphrases:{promptId:number, text:string, n:number, mentioned:number, p:number}[]}>} */
  const byIntent = new Map();
  for (const row of rows) {
    const intentId = Number(row.intent_id);
    const n = Number(row.n ?? 0);
    if (n === 0) continue;
    const mentioned = Number(row.mentioned ?? 0);
    const bucket = byIntent.get(intentId) ?? { label: String(row.label), paraphrases: [] };
    bucket.paraphrases.push({ promptId: Number(row.prompt_id), text: String(row.text), n, mentioned, p: mentioned / n });
    byIntent.set(intentId, bucket);
  }

  const out = [...byIntent.entries()].map(([intentId, bucket]) => {
    const totalN = bucket.paraphrases.reduce((sum, para) => sum + para.n, 0);
    const totalMentioned = bucket.paraphrases.reduce((sum, para) => sum + para.mentioned, 0);
    const k = bucket.paraphrases.length;

    const rerunVariance = bucket.paraphrases.reduce((sum, para) => sum + (para.p * (1 - para.p)) / para.n, 0) / k;
    const mean = bucket.paraphrases.reduce((sum, para) => sum + para.p, 0) / k;
    const phrasingVariance = bucket.paraphrases.reduce((sum, para) => sum + (para.p - mean) ** 2, 0) / k;

    return {
      intentId,
      label: bucket.label,
      n: totalN,
      pooled: wilson(totalMentioned, totalN),
      rerunSpread: Math.sqrt(rerunVariance),
      phrasingSpread: k >= 2 ? Math.sqrt(phrasingVariance) : null,
      paraphraseCount: k,
      paraphrases: bucket.paraphrases,
    };
  });

  return out.sort((a, b) => b.n - a.n || a.intentId - b.intentId);
}

/**
 * "Who gets cited instead of you" (§7, §11.3): domains cited in valid answers where the
 * brand is NOT mentioned. Citations that resolve to the brand's own domains are skipped —
 * this list is about the shortlist places the brand is missing from.
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts & {limit?:number}} [maybeOpts]
 * @returns {{domain:string, count:number, sampleUrl:string, topPromptId:number|null}[]}
 */
export function citationGap(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'citationGap');
  const filter = validResponses(w);
  const brand = brandEntity(db);
  if (!brand) return [];
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Number(opts.limit)) : 20;

  const rows = all(
    db,
    `SELECT r.id AS response_id, r.prompt_id AS prompt_id, c.domain AS domain, c.url AS url
       FROM responses r
       JOIN prompts p ON p.id = r.prompt_id
       JOIN citations c ON c.response_id = r.id
      WHERE ${filter.sql}
        AND NOT EXISTS (SELECT 1 FROM mentions m WHERE m.response_id = r.id AND m.entity_id = ?)
        AND (c.entity_id IS NULL OR c.entity_id <> ?)
      ORDER BY r.created_at DESC, r.id DESC, c.rank ASC`,
    [...filter.params, brand.id, brand.id],
  );

  /** @type {Map<string, {sampleUrl:string, responses:Set<number>, prompts:Map<number, Set<number>>}>} */
  const byDomain = new Map();
  for (const row of rows) {
    const domain = String(row.domain);
    const responseId = Number(row.response_id);
    const promptId = Number(row.prompt_id);
    let bucket = byDomain.get(domain);
    if (!bucket) {
      bucket = { sampleUrl: String(row.url), responses: new Set(), prompts: new Map() };
      byDomain.set(domain, bucket);
    }
    bucket.responses.add(responseId);
    const seen = bucket.prompts.get(promptId) ?? new Set();
    seen.add(responseId);
    bucket.prompts.set(promptId, seen);
  }

  return [...byDomain.entries()]
    .map(([domain, bucket]) => {
      /** @type {{promptId:number, n:number}|null} */
      let top = null;
      for (const [promptId, responses] of bucket.prompts) {
        if (!top || responses.size > top.n || (responses.size === top.n && promptId < top.promptId)) {
          top = { promptId, n: responses.size };
        }
      }
      return {
        domain,
        count: bucket.responses.size,
        sampleUrl: bucket.sampleUrl,
        topPromptId: top ? top.promptId : null,
      };
    })
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}

/**
 * Actual spend recorded by the adapters (§4.3, §7). Null-safe: responses whose provider
 * returned no usage carry `cost_usd = null` and are simply not counted — the figure is
 * "what we can prove we spent", never an estimate (guardrail 13 keeps estimates in
 * `core/cost.js`).
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts} [maybeOpts]
 * @returns {{totalUsd:number, calls:number, perProvider:{provider:string, usd:number, calls:number}[]}}
 */
export function actualSpend(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'actualSpend');
  const filter = validResponses(w);
  const rows = all(
    db,
    `SELECT provider,
            SUM(COALESCE(cost_usd, 0)) AS usd,
            SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS calls
       FROM responses r JOIN prompts p ON p.id = r.prompt_id
      WHERE ${filter.sql}
      GROUP BY provider`,
    filter.params,
  );

  const perProvider = rows
    .map((row) => ({
      provider: String(row.provider),
      usd: Number(row.usd ?? 0),
      calls: Number(row.calls ?? 0),
    }))
    .filter((row) => row.calls > 0)
    .sort((a, b) => byProviderOrder(a.provider, b.provider));

  return {
    totalUsd: perProvider.reduce((sum, row) => sum + row.usd, 0),
    calls: perProvider.reduce((sum, row) => sum + row.calls, 0),
    perProvider,
  };
}

/**
 * Composite for `GET /api/summary` and the MCP `hearsay_summary` tool (§10.4).
 *
 * `demo` is passed in rather than read from config, because metrics stays free of the
 * environment (§19.6 #6). `generatedAt` is the caller's `now`.
 *
 * @param {Db|MetricsOpts} dbOrOpts open database, or an options object carrying `db`
 * @param {WindowOpts & {demo?:boolean}} [maybeOpts]
 * @returns {{brand:{id:number,name:string}|null, windowDays:number, generatedAt:string, demo:boolean,
 *            sov:{current:ReturnType<typeof shareOfVoice>, delta7d:number|null},
 *            mentionRate:Rate, recommendationRate:ReturnType<typeof recommendationRate>,
 *            providers:ReturnType<typeof providerBreakdown>, openAlerts:number,
 *            lastRun:{finishedAt:string|null, status:string}|null}}
 */
export function summary(dbOrOpts, maybeOpts) {
  const [db, opts] = args(dbOrOpts, maybeOpts);
  const w = resolveWindow(opts, 'summary');
  const brand = brandEntity(db);

  const current = sovRows(db, w);

  /** @type {number|null} */
  let delta7d = null;
  if (brand) {
    const recent = sovRows(db, { ...w, start: windowStart(w.end, 7) });
    const priorEnd = windowStart(w.end, 7);
    const prior = sovRows(db, { ...w, start: windowStart(priorEnd, 7), end: priorEnd });
    const recentTotal = recent.reduce((sum, row) => sum + row.mentions, 0);
    const priorTotal = prior.reduce((sum, row) => sum + row.mentions, 0);
    if (recentTotal > 0 && priorTotal > 0) {
      const recentSov = recent.find((row) => row.entityId === brand.id)?.sov ?? 0;
      const priorSov = prior.find((row) => row.entityId === brand.id)?.sov ?? 0;
      delta7d = recentSov - priorSov;
    }
  }

  const alertRow = get(db, 'SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0');
  const runRow = get(db, 'SELECT finished_at, status FROM runs ORDER BY id DESC LIMIT 1');

  return {
    brand,
    windowDays: w.days,
    generatedAt: w.end,
    demo: opts.demo === true,
    sov: { current, delta7d },
    mentionRate: brand ? mentionRate(db, { ...opts, now: w.end, entityId: brand.id }) : wilson(0, 0),
    recommendationRate: brand
      ? recommendationRate(db, { ...opts, now: w.end, entityId: brand.id })
      : { n: 0, recommended: 0, p: null, lowSample: true },
    providers: providerBreakdown(db, { ...opts, now: w.end }),
    openAlerts: Number(alertRow?.n ?? 0),
    lastRun: runRow
      ? { finishedAt: runRow.finished_at === null ? null : String(runRow.finished_at), status: String(runRow.status) }
      : null,
  };
}
