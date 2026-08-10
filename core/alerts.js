/**
 * Alert rules engine (§9).
 *
 * `evaluate(db, runId)` runs once per finished run and writes at most one row per
 * `(type, entity_id, prompt_id, provider)` per 7 days. Four rules, all comparative:
 *
 *   LOST_RECOMMENDATION    serious  recommended in each of the 2 previous runs, 0 now
 *   GAINED_RECOMMENDATION  good     0 in each of the 2 previous runs, ≥1 now
 *   OVERTAKEN              warning  competitor's 7-day SOV passed the brand's
 *   MENTION_DROP           warning  per-provider mention rate ≤ previous run − 25 pts
 *
 * Every `detail` carries the numbers behind the claim ("3/9 → 0/9 samples"), because an
 * alert a user cannot check is a scare, not a measurement (§9, §19.6 #4).
 *
 * "Previous runs" are earlier `done` runs of the same kind: live runs compare with live
 * runs, and seeded runs compare with seeded runs, so the demo universe produces its
 * storylines through this same code path instead of hand-written alert rows (§12).
 */

import { all, get, isoNow, run as exec } from './db.js';
import { shareOfVoice } from './metrics.js';
import { eligibilitySql } from './subscription-model.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

/**
 * @typedef {Object} CreatedAlert
 * @property {number} id
 * @property {'good'|'warning'|'serious'} severity
 * @property {'LOST_RECOMMENDATION'|'GAINED_RECOMMENDATION'|'OVERTAKEN'|'MENTION_DROP'} type
 * @property {number|null} entityId
 * @property {number|null} promptId
 * @property {string|null} provider
 * @property {string|null} [surface]
 * @property {string} title
 * @property {string} detail
 */

/** Mention-rate drop, in points, that opens a MENTION_DROP alert (§9). */
export const MENTION_DROP_POINTS = 25;

/** Both runs need at least this many valid samples before a drop is worth claiming (§9). */
export const MENTION_DROP_MIN_N = 3;

/** Window in which an identical alert is treated as already reported (§9). */
export const DEDUP_DAYS = 7;

/** Window used for the SOV comparison behind OVERTAKEN (§9). */
export const SOV_WINDOW_DAYS = 7;

/** Prompt text is truncated to this many characters inside a title (§9). */
const TITLE_PROMPT_CHARS = 40;

/** Alert titles are human sentences, ≤ 90 chars (§3). */
const TITLE_MAX = 90;

/**
 * Consumer-product names for provider ids (§4.1). Kept local so the rules engine reads
 * no environment; unknown ids fall through unchanged.
 * @type {Record<string, string>}
 */
const PROVIDER_LABELS = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
};

const API_SURFACES = ['openai-api', 'anthropic-api', 'gemini-api', 'perplexity-api'];
const AGENT_SURFACES = ['codex-agent', 'claude-code-agent'];

/**
 * @param {string} provider
 * @returns {string}
 */
function label(provider) {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * @param {number|null} fraction
 * @returns {string}
 */
function pct(fraction) {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}%`;
}

/**
 * @param {string} now ISO-8601 UTC
 * @param {number} days
 * @returns {string}
 */
function daysBefore(now, days) {
  return `${new Date(new Date(now).getTime() - days * 86_400_000).toISOString().slice(0, 19)}Z`;
}

/**
 * Eligibility for alert comparisons. The null-surface branch is the API-only legacy
 * compatibility path; an explicit agent surface always requires verified web evidence.
 *
 * @param {string|null} surface
 * @param {string} alias
 * @returns {{sql:string, params:(string|number|null)[]}}
 */
function alertEligibility(surface, alias = 'r') {
  const common = eligibilitySql(alias, {
    surface: surface ?? undefined,
    subscription: surface !== null && AGENT_SURFACES.includes(surface),
  });
  if (surface === null) {
    return {
      sql: `(((${common.sql}) AND (${alias}.surface IS NULL OR ${alias}.surface IN (${API_SURFACES.map(() => '?').join(', ')})))
        OR (${alias}.surface IS NULL AND ${alias}.lane IS NULL AND ${alias}.target_status IS NULL
            AND ${alias}.comparability_status IS NULL AND ${alias}.error IS NULL))`,
      params: [...common.params, ...API_SURFACES],
    };
  }
  return common;
}

/**
 * All targets for one run/surface must be complete before comparative alerts are valid.
 *
 * @param {Db} db
 * @param {number} runId
 * @param {string|null} surface
 * @returns {boolean}
 */
function completeSurfaceCohort(db, runId, surface) {
  const scope = surface === null
    ? { sql: `(r.surface IS NULL OR r.surface IN (${API_SURFACES.map(() => '?').join(', ')}))`, params: API_SURFACES }
    : { sql: 'r.surface = ?', params: [surface] };
  const rows = all(
    db,
    `SELECT r.error, r.target_status, r.comparability_status, r.web_status
       FROM responses r
      WHERE r.run_id = ? AND (${scope.sql})`,
    [runId, ...scope.params],
  );
  if (rows.length === 0) return false;
  return rows.every((row) => {
    if (row.error !== null && row.error !== undefined) return false;
    if (row.target_status === null || row.target_status === undefined) return true;
    if (String(row.target_status) !== 'completed' || String(row.comparability_status) !== 'comparable') return false;
    return surface === null || !AGENT_SURFACES.includes(surface) || String(row.web_status) === 'verified';
  });
}

/**
 * Per-(prompt, provider) recommendation counts for one run, over its valid responses.
 * @param {Db} db
 * @param {number} runId
 * @param {number} entityId
 * @param {string|null} surface
 * @returns {Map<string, {promptId:number, provider:string, n:number, recommended:number}>}
 */
function recommendationCounts(db, runId, entityId, surface) {
  const scope = alertEligibility(surface);
  const rows = all(
    db,
    `SELECT r.prompt_id AS prompt_id, r.provider AS provider, COUNT(*) AS n,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m
                                   WHERE m.response_id = r.id AND m.entity_id = ? AND m.recommended = 1)
                     THEN 1 ELSE 0 END) AS recommended
       FROM responses r
      WHERE r.run_id = ? AND r.error IS NULL AND (${scope.sql})
      GROUP BY r.prompt_id, r.provider`,
    [entityId, runId, ...scope.params],
  );
  /** @type {Map<string, {promptId:number, provider:string, n:number, recommended:number}>} */
  const map = new Map();
  for (const row of rows) {
    const promptId = Number(row.prompt_id);
    const provider = String(row.provider);
    map.set(`${promptId}|${provider}`, {
      promptId,
      provider,
      n: Number(row.n ?? 0),
      recommended: Number(row.recommended ?? 0),
    });
  }
  return map;
}

/**
 * Per-provider brand mention counts for one run. Branded prompts are left out, matching
 * the SOV convention (§6.7) — a navigational prompt should not prop up a discovery rate.
 * @param {Db} db
 * @param {number} runId
 * @param {number} entityId
 * @param {string|null} surface
 * @returns {Map<string, {n:number, mentioned:number, p:number}>}
 */
function providerMentionCounts(db, runId, entityId, surface) {
  const scope = alertEligibility(surface);
  const rows = all(
    db,
    `SELECT r.provider AS provider, COUNT(*) AS n,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM mentions m WHERE m.response_id = r.id AND m.entity_id = ?)
                     THEN 1 ELSE 0 END) AS mentioned
       FROM responses r JOIN prompts p ON p.id = r.prompt_id
      WHERE r.run_id = ? AND r.error IS NULL AND p.category <> 'branded' AND (${scope.sql})
      GROUP BY r.provider`,
    [entityId, runId, ...scope.params],
  );
  /** @type {Map<string, {n:number, mentioned:number, p:number}>} */
  const map = new Map();
  for (const row of rows) {
    const n = Number(row.n ?? 0);
    if (n === 0) continue;
    const mentioned = Number(row.mentioned ?? 0);
    map.set(String(row.provider), { n, mentioned, p: mentioned / n });
  }
  return map;
}

/**
 * The prompt texts referenced by a set of ids.
 * @param {Db} db
 * @param {number[]} promptIds
 * @returns {Map<number, string>}
 */
function promptTexts(db, promptIds) {
  /** @type {Map<number, string>} */
  const map = new Map();
  for (const id of new Set(promptIds)) {
    const row = get(db, 'SELECT text FROM prompts WHERE id = ?', [id]);
    if (row) map.set(id, String(row.text));
  }
  return map;
}

/**
 * True when an identical alert was already written inside the dedup window (§9).
 * `IS` rather than `=` so NULL entity/prompt/provider columns compare properly.
 *
 * @param {Db} db
 * @param {{type:string, entityId:number|null, promptId:number|null, provider:string|null, surface:string|null}} key
 * @param {string} since ISO-8601 UTC
 * @returns {boolean}
 */
function alreadyReported(db, key, since) {
  const row = get(
    db,
    `SELECT 1 AS hit FROM alerts
      WHERE type = ? AND entity_id IS ? AND prompt_id IS ? AND provider IS ? AND surface IS ? AND created_at >= ?
      LIMIT 1`,
    [key.type, key.entityId, key.promptId, key.provider, key.surface, since],
  );
  return row !== undefined;
}

/**
 * Candidate alert, before dedup.
 * @typedef {Object} Candidate
 * @property {'good'|'warning'|'serious'} severity
 * @property {'LOST_RECOMMENDATION'|'GAINED_RECOMMENDATION'|'OVERTAKEN'|'MENTION_DROP'} type
 * @property {number|null} entityId
 * @property {number|null} promptId
 * @property {string|null} provider
 * @property {string|null} [surface]
 * @property {string} title
 * @property {string} detail
 */

/**
 * Evaluate the alert rules for a finished run and persist whatever survives dedup (§9).
 *
 * The run itself may still be marked `running` — the runner evaluates alerts before it
 * flips the status (§8.1 step 5), so only *prior* runs are required to be `done`.
 *
 * Called either way round — `evaluate(db, runId)` or `evaluate(runId, db)`, which is how
 * §8.1's runner hook passes them — so the seam does not depend on argument order.
 *
 * @param {Db|number} dbOrRunId
 * @param {number|Db} runIdOrDb
 * @param {{now?: string|Date, surface?: string}} [opts] `now` is the evaluation timestamp;
 *   defaults to the current UTC time, and `surface` selects one comparable cohort.
 * @returns {CreatedAlert[]} alerts actually written, in rule order
 */
export function evaluate(dbOrRunId, runIdOrDb, opts = {}) {
  const swapped = typeof dbOrRunId === 'number';
  const db = /** @type {Db} */ (swapped ? runIdOrDb : dbOrRunId);
  const runId = Number(swapped ? dbOrRunId : runIdOrDb);
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('alerts.evaluate: pass the open database and the run id');
  }
  const now = opts.now === undefined ? isoNow() : isoNow(opts.now instanceof Date ? opts.now : new Date(String(opts.now)));
  const surface = opts.surface === undefined ? null : String(opts.surface);

  const runRow = get(db, 'SELECT id, trigger FROM runs WHERE id = ?', [Number(runId)]);
  if (!runRow) return [];
  const trigger = String(runRow.trigger);

  const brandRow = get(db, 'SELECT id, name FROM entities WHERE is_self = 1 AND archived_at IS NULL ORDER BY id LIMIT 1');
  if (!brandRow) return [];
  const brand = { id: Number(brandRow.id), name: String(brandRow.name) };
  if (!completeSurfaceCohort(db, Number(runId), surface)) return [];

  // Compare like with like: live runs against live runs, seeded runs against seeded runs.
  const kindClause = trigger === 'seed' ? "trigger = 'seed'" : "trigger <> 'seed'";
  const priorRuns = all(
    db,
    `SELECT id, started_at, finished_at FROM runs
      WHERE id < ? AND status = 'done' AND ${kindClause}
      ORDER BY id DESC LIMIT 2`,
    [Number(runId)],
  ).map((row) => ({
    id: Number(row.id),
    at: String(row.finished_at ?? row.started_at),
  }));

  /** @type {Candidate[]} */
  const candidates = [];

  const current = recommendationCounts(db, Number(runId), brand.id, surface);
  const prev1 = priorRuns[0] ? recommendationCounts(db, priorRuns[0].id, brand.id, surface) : null;
  const prev2 = priorRuns[1] ? recommendationCounts(db, priorRuns[1].id, brand.id, surface) : null;

  // --- LOST_RECOMMENDATION / GAINED_RECOMMENDATION (need 2 prior runs) ----------------
  if (prev1 && prev2) {
    const texts = promptTexts(db, [...current.values()].map((entry) => entry.promptId));
    for (const [key, cur] of current) {
      if (cur.n === 0) continue;
      const one = prev1.get(key);
      const two = prev2.get(key);
      if (!one || !two || one.n === 0 || two.n === 0) continue;

      const prompt = truncate(texts.get(cur.promptId) ?? `prompt ${cur.promptId}`, TITLE_PROMPT_CHARS);
      const history = `${two.recommended}/${two.n} → ${one.recommended}/${one.n} → ${cur.recommended}/${cur.n} samples`;

      if (one.recommended >= 1 && two.recommended >= 1 && cur.recommended === 0) {
        candidates.push({
          severity: 'serious',
          type: 'LOST_RECOMMENDATION',
          entityId: brand.id,
          promptId: cur.promptId,
          provider: cur.provider,
          title: truncate(`Lost recommendation on ${label(cur.provider)} for “${prompt}”`, TITLE_MAX),
          detail: `${brand.name} was recommended in each of the two previous runs and in none of this run's samples (${history}) on ${label(cur.provider)}.`,
        });
      } else if (one.recommended === 0 && two.recommended === 0 && cur.recommended >= 1) {
        candidates.push({
          severity: 'good',
          type: 'GAINED_RECOMMENDATION',
          entityId: brand.id,
          promptId: cur.promptId,
          provider: cur.provider,
          title: truncate(`Now recommended on ${label(cur.provider)} for “${prompt}”`, TITLE_MAX),
          detail: `${brand.name} was not recommended in either of the two previous runs and is now (${history}) on ${label(cur.provider)}.`,
        });
      }
    }
  }

  // --- MENTION_DROP (needs 1 prior run, n ≥ 3 on both sides) -------------------------
  if (priorRuns[0]) {
    const curByProvider = providerMentionCounts(db, Number(runId), brand.id, surface);
    const prevByProvider = providerMentionCounts(db, priorRuns[0].id, brand.id, surface);
    for (const [provider, cur] of curByProvider) {
      const prev = prevByProvider.get(provider);
      if (!prev) continue;
      if (cur.n < MENTION_DROP_MIN_N || prev.n < MENTION_DROP_MIN_N) continue;
      const dropPoints = (prev.p - cur.p) * 100;
      if (dropPoints < MENTION_DROP_POINTS) continue;
      const delta = Math.round(dropPoints);
      candidates.push({
        severity: 'warning',
        type: 'MENTION_DROP',
        entityId: brand.id,
        promptId: null,
        provider,
        title: truncate(`Mentions down ${delta} pts on ${label(provider)}`, TITLE_MAX),
        detail: `${brand.name} was mentioned in ${prev.mentioned}/${prev.n} valid answers on ${label(provider)} last run and ${cur.mentioned}/${cur.n} this run (${pct(prev.p)} → ${pct(cur.p)}, ${delta} pts).`,
      });
    }
  }

  // --- OVERTAKEN (needs 1 prior run to have something to compare against) ------------
  if (priorRuns[0]) {
    const recent = shareOfVoice(db, { days: SOV_WINDOW_DAYS, now, ...(surface === null ? {} : { surface }) });
    const prior = shareOfVoice(db, { days: SOV_WINDOW_DAYS, now: priorRuns[0].at, ...(surface === null ? {} : { surface }) });
    const recentTotal = recent.reduce((sum, row) => sum + row.mentions, 0);
    const priorTotal = prior.reduce((sum, row) => sum + row.mentions, 0);

    if (recentTotal > 0 && priorTotal > 0) {
      const brandNow = recent.find((row) => row.entityId === brand.id)?.sov ?? 0;
      const brandPrior = prior.find((row) => row.entityId === brand.id)?.sov ?? 0;
      for (const competitor of recent) {
        if (competitor.entityId === brand.id) continue;
        const competitorPrior = prior.find((row) => row.entityId === competitor.entityId);
        if (!competitorPrior) continue;
        if (!(competitor.sov > brandNow)) continue;
        if (!(competitorPrior.sov <= brandPrior)) continue;
        candidates.push({
          severity: 'warning',
          type: 'OVERTAKEN',
          entityId: competitor.entityId,
          promptId: null,
          provider: null,
          title: truncate(`${competitor.name} passed you in share of AI voice`, TITLE_MAX),
          detail: `${competitor.name} went ${pct(competitorPrior.sov)} → ${pct(competitor.sov)} of share of AI voice against your ${pct(brandPrior)} → ${pct(brandNow)}, over the last ${SOV_WINDOW_DAYS} days (n=${recentTotal} mentions).`,
        });
      }
    }
  }

  // --- persist whatever survives the 7-day dedup ------------------------------------
  const since = daysBefore(now, DEDUP_DAYS);
  /** @type {CreatedAlert[]} */
  const created = [];
  for (const candidate of candidates) {
    const key = {
      type: candidate.type,
      entityId: candidate.entityId,
      promptId: candidate.promptId,
      provider: candidate.provider,
      surface,
    };
    if (alreadyReported(db, key, since)) continue;
    const result = exec(
      db,
      `INSERT INTO alerts(created_at, run_id, severity, type, entity_id, prompt_id, provider, surface, title, detail, acknowledged)
       VALUES(?,?,?,?,?,?,?,?,?,?,0)`,
      [
        now,
        Number(runId),
        candidate.severity,
        candidate.type,
        candidate.entityId,
        candidate.promptId,
        candidate.provider,
        surface,
        candidate.title,
        candidate.detail,
      ],
    );
    created.push({ id: result.lastInsertRowid, ...candidate, surface });
  }
  return created;
}
