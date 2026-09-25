/**
 * Plain-SQL reads owned by the web lane (§10.3, §11).
 *
 * The split is deliberate: anything that is a *statistic* (rates, Wilson intervals,
 * share of voice, variance decomposition) lives in `core/metrics.js` (§7) and is
 * reached through `web/data.js`. What lives here is the flat record-keeping the
 * pages and the JSON API need — entity lists, prompt/intent grouping, alert rows,
 * the answers explorer query, run status.
 *
 * Every timestamp read or written here is UTC ISO-8601 (§19.6 #5).
 */

import { all, get, userVersion } from '../core/db.js';
import { assertReviewedSelection } from '../core/benchmark-draft.js';
import { answerReview } from '../core/interpretations.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

/** Prompt categories accepted by the API and offered in the UI (§11.5, §6.7). */
export const CATEGORIES = /** @type {readonly string[]} */ ([
  'general',
  'comparison',
  'use-case',
  'local',
  'pricing',
  'branded',
]);

/** Provider ids, in the fixed UI order (§4.2). */
export const PROVIDERS = /** @type {readonly string[]} */ (['openai', 'anthropic', 'gemini', 'perplexity']);

/**
 * @typedef {Object} Entity
 * @property {number} id
 * @property {string} name
 * @property {string[]} aliases
 * @property {string[]} domains
 * @property {number} is_self 0|1
 * @property {number} ambiguous_name 0|1; identity needs review when set
 * @property {string|null} archived_at
 */

/**
 * @param {unknown} value JSON text from a TEXT column
 * @returns {string[]}
 */
function jsonList(value) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A UTC ISO-8601 cutoff `days` before `now` (§7 window convention).
 * @param {number} days
 * @param {Date} [now]
 * @returns {string}
 */
export function windowStart(days, now = new Date()) {
  const ms = now.getTime() - Math.max(0, days) * 86400000;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * @param {Db} db
 * @param {{includeArchived?: boolean}} [opts]
 * @returns {Entity[]}
 */
export function listEntities(db, { includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT id, name, aliases, domains, is_self, ambiguous_name, archived_at FROM entities ORDER BY is_self DESC, id ASC'
    : 'SELECT id, name, aliases, domains, is_self, ambiguous_name, archived_at FROM entities WHERE archived_at IS NULL ORDER BY is_self DESC, id ASC';
  return all(db, sql).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    aliases: jsonList(row.aliases),
    domains: jsonList(row.domains),
    is_self: Number(row.is_self) === 1 ? 1 : 0,
    ambiguous_name: Number(row.ambiguous_name) === 1 ? 1 : 0,
    archived_at: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
  }));
}

/**
 * @param {Db} db
 * @returns {Entity|null}
 */
export function brandEntity(db) {
  return listEntities(db).find((e) => e.is_self === 1) ?? null;
}

/**
 * Series-colour slot per entity (§11.1): the brand is always index 0 (`--s1`);
 * competitors take 1…3 in entity-id order. Colour follows the entity, never the rank,
 * and the fifth competitor onwards gets grey rather than a new hue.
 *
 * @param {Entity[]} entities
 * @returns {Map<number, number>}
 */
export function colorIndexFor(entities) {
  /** @type {Map<number, number>} */
  const map = new Map();
  const brand = entities.find((e) => e.is_self === 1);
  if (brand) map.set(brand.id, 0);
  let next = 1;
  for (const entity of [...entities].sort((a, b) => a.id - b.id)) {
    if (map.has(entity.id)) continue;
    map.set(entity.id, next);
    next += 1;
  }
  return map;
}

/**
 * @typedef {Object} Prompt
 * @property {number} id
 * @property {number|null} intent_id
 * @property {string} text
 * @property {string} category
 * @property {number} active 0|1
 * @property {'tracking'|'exploration'} tracking_state
 * @property {'user_authored'|'suggested'|'imported'|'legacy'} origin
 * @property {string|null} approved_at
 * @property {string|null} promoted_at
 * @property {string|null} source_note
 * @property {boolean} reviewed
 */

/**
 * @param {Db} db
 * @returns {Prompt[]}
 */
export function listPrompts(db) {
  return all(db, 'SELECT id, intent_id, text, category, active, tracking_state, origin, approved_at, promoted_at, source_note FROM prompts ORDER BY intent_id ASC, id ASC').map(
    (row) => ({
      id: Number(row.id),
      intent_id: row.intent_id === null || row.intent_id === undefined ? null : Number(row.intent_id),
      text: String(row.text),
      category: String(row.category),
      active: Number(row.active) === 1 ? 1 : 0,
      tracking_state: /** @type {'tracking'|'exploration'} */ (String(row.tracking_state ?? 'tracking')),
      origin: /** @type {'user_authored'|'suggested'|'imported'|'legacy'} */ (String(row.origin ?? 'legacy')),
      approved_at: row.approved_at === null || row.approved_at === undefined ? null : String(row.approved_at),
      promoted_at: row.promoted_at === null || row.promoted_at === undefined ? null : String(row.promoted_at),
      source_note: row.source_note === null || row.source_note === undefined ? null : String(row.source_note),
      reviewed: Number(row.active) === 1 && String(row.tracking_state) === 'tracking' && (() => {
        try { assertReviewedSelection(db, [Number(row.id)]); return true; }
        catch { return false; }
      })(),
    }),
  );
}

/**
 * @typedef {Object} Paraphrase
 * @property {number} id
 * @property {string} text
 * @property {number} active 0|1
 * @property {string} category
 * @property {string|null} source_note
 * @property {boolean} reviewed
 */

/**
 * @typedef {Object} Intent
 * @property {number} id
 * @property {string} label
 * @property {Paraphrase[]} paraphrases one wording each (§6.6)
 */

/**
 * Intents with their paraphrases (§10.3, §6.6). A lone prompt is still an intent —
 * with one paraphrase — which is what the UI nudge is about.
 *
 * @param {Db} db
 * @returns {Intent[]}
 */
export function listIntents(db) {
  const intents = all(db, 'SELECT id, label FROM intents ORDER BY id ASC').map((row) => ({
    id: Number(row.id),
    label: String(row.label),
    /** @type {{id: number, text: string, active: number, category: string, source_note: string|null, reviewed:boolean}[]} */
    paraphrases: [],
  }));
  /** @type {Map<number, typeof intents[0]>} */
  const byId = new Map(intents.map((i) => [i.id, i]));
  for (const prompt of listPrompts(db)) {
    if (prompt.intent_id === null) continue;
    const intent = byId.get(prompt.intent_id);
    if (!intent) continue;
    intent.paraphrases.push({
      id: prompt.id,
      text: prompt.text,
      active: prompt.active,
      category: prompt.category,
      source_note: prompt.source_note,
      reviewed: prompt.reviewed,
    });
  }
  return intents;
}

/**
 * An alert row joined to the entity and prompt it fired on (§9, §10.3).
 *
 * @typedef {Object} AlertRow
 * @property {number} id
 * @property {string} created_at UTC ISO-8601
 * @property {number|null} run_id
 * @property {string} severity `good`|`warning`|`serious`
 * @property {string} type
 * @property {number|null} entity_id
 * @property {number|null} prompt_id
 * @property {string|null} provider
 * @property {string|null} surface
 * @property {string} title
 * @property {string} detail
 * @property {number} acknowledged 0|1
 * @property {string|null} entityName
 * @property {string|null} promptText
 */

/**
 * @param {Db} db
 * @param {{open?: boolean, limit?: number, series?:AnswerFilters['series'] & {start:string,end:string}}} [opts]
 * @returns {AlertRow[]}
 */
export function listAlerts(db, { open = true, limit = 200, series } = {}) {
  const clauses = open ? ['a.acknowledged = 0'] : [];
  /** @type {(string|number|null)[]} */
  const params = [];
  if (series) {
    clauses.push(`a.surface IS ? AND EXISTS (SELECT 1 FROM responses r WHERE r.run_id = a.run_id
      AND (a.prompt_id IS NULL OR a.prompt_id = r.prompt_id)
      AND (a.provider IS NULL OR a.provider = r.provider)
      AND r.surface = ? AND r.execution_profile_id IS ? AND r.benchmark_revision_id IS ?
      AND r.analysis_revision IS ? AND r.comparison_key IS ? AND r.search_policy IS ?
      AND r.created_at >= ? AND r.created_at < ?)
      AND NOT EXISTS (SELECT 1 FROM responses r2 WHERE r2.run_id = a.run_id
        AND (a.prompt_id IS NULL OR a.prompt_id = r2.prompt_id)
        AND (a.provider IS NULL OR a.provider = r2.provider)
        AND r2.surface IS a.surface
        AND NOT (r2.execution_profile_id IS ? AND r2.benchmark_revision_id IS ?
          AND r2.analysis_revision IS ? AND r2.comparison_key IS ? AND r2.search_policy IS ?))`);
    params.push(series.surface, series.surface, series.executionProfileId, series.benchmarkRevisionId,
      series.analysisRevision, series.comparisonKey, series.searchPolicy, series.start, series.end);
    params.push(series.executionProfileId, series.benchmarkRevisionId,
      series.analysisRevision, series.comparisonKey, series.searchPolicy);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = all(
    db,
    `SELECT a.id, a.created_at, a.run_id, a.severity, a.type, a.entity_id, a.prompt_id, a.provider, a.surface,
            a.title, a.detail, a.acknowledged,
            e.name AS entityName, p.text AS promptText
       FROM alerts a
       LEFT JOIN entities e ON e.id = a.entity_id
       LEFT JOIN prompts  p ON p.id = a.prompt_id
       ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    [...params, Math.max(1, Math.min(1000, Math.floor(limit)))],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    created_at: String(row.created_at),
    run_id: row.run_id === null ? null : Number(row.run_id),
    severity: String(row.severity),
    type: String(row.type),
    entity_id: row.entity_id === null ? null : Number(row.entity_id),
    prompt_id: row.prompt_id === null ? null : Number(row.prompt_id),
    provider: row.provider === null ? null : String(row.provider),
    surface: row.surface === null || row.surface === undefined ? null : String(row.surface),
    title: String(row.title),
    detail: String(row.detail),
    acknowledged: Number(row.acknowledged) === 1 ? 1 : 0,
    entityName: row.entityName === null || row.entityName === undefined ? null : String(row.entityName),
    promptText: row.promptText === null || row.promptText === undefined ? null : String(row.promptText),
  }));
}

/**
 * @param {Db} db
 * @returns {number}
 */
export function openAlertCount(db) {
  const row = get(db, 'SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0');
  return Number(row?.n ?? 0);
}

/**
 * @param {Db} db
 * @returns {{id: number, status: string, total_calls: number, done_calls: number, started_at: string, finished_at: string|null, trigger: string, surface?: string|null, schedule_key?: string|null, scheduled_for?: string|null, occurrence_local_date?: string|null}|null}
 */
export function latestRun(db) {
  const row = get(
    db,
    `SELECT id, status, total_calls, done_calls, started_at, finished_at, trigger,
            schedule_key, scheduled_for, occurrence_local_date
       FROM runs ORDER BY id DESC LIMIT 1`,
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    status: String(row.status),
    total_calls: Number(row.total_calls ?? 0),
    done_calls: Number(row.done_calls ?? 0),
    started_at: String(row.started_at),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    trigger: String(row.trigger),
    schedule_key: row.schedule_key === null || row.schedule_key === undefined ? null : String(row.schedule_key),
    scheduled_for: row.scheduled_for === null || row.scheduled_for === undefined ? null : String(row.scheduled_for),
    occurrence_local_date: row.occurrence_local_date === null || row.occurrence_local_date === undefined ? null : String(row.occurrence_local_date),
  };
}

/**
 * @param {Db} db
 * @returns {number} active prompts, the multiplier in a run's call count (§4.2)
 */
export function activePromptCount(db) {
  const row = get(db, 'SELECT COUNT(*) AS n FROM prompts WHERE active = 1');
  return Number(row?.n ?? 0);
}

/**
 * @typedef {Object} AnswerFilters
 * @property {string|null} [provider]
 * @property {string|null} [surface]
 * @property {number|null} [promptId]
 * @property {number|null} [entityId]
 * @property {number} [days]
 * @property {number} [page] 1-based
 * @property {number} [per]
 * @property {Date} [now]
 * @property {string} [start] inclusive UTC boundary
 * @property {string} [end] exclusive UTC boundary
 * @property {{surface:string,executionProfileId:string|null,benchmarkRevisionId:string|null,
 *   analysisRevision:string|null,comparisonKey:string|null,searchPolicy:string|null}} [series]
 * @property {boolean} [eligibleOnly]
 */

/**
 * @typedef {Object} AnswerItem
 * @property {number} id
 * @property {string} provider
 * @property {string|null} surface
 * @property {string} model
 * @property {number} sample_idx
 * @property {string} created_at
 * @property {string} prompt
 * @property {number} prompt_id
 * @property {string|null} text
 * @property {string|null} error
 * @property {string|null} lane
 * @property {string|null} target_status
 * @property {string|null} comparability_status
 * @property {string|null} web_status
 * @property {string|null} prompt_text_snapshot
 * @property {string|null} prompt_origin
 * @property {string|null} cli_executable
 * @property {string|null} artifact_ref
 * @property {string} analysis_revision
 * @property {string|null} execution_profile_id
 * @property {string|null} benchmark_revision_id
 * @property {string|null} comparison_key
 * @property {string|null} search_policy
 * @property {number} correction_cutoff
 * @property {ReturnType<typeof answerReview>} review
 * @property {{id:number, entity_id: number, name: string, first_index: number, occurrences: number,
 *   recommended: number, captured_recommended:number, stance:string|null, method:string,
 *   analysis_revision:string, rule_id:string|null, evidence_start:number|null,evidence_end:number|null,
 *   review_flags:string[], snippet: string, rank: number}[]} mentions
 * @property {{url: string, domain: string, entity_id: number|null, rank: number}[]} citations
 * @property {{id:number,event_type:string, status:string, query:string|null, queries:string[], url:string|null, title:string|null, domain:string|null, observed_at:string, rank:number|null}[]} search_events
 * @property {{url:string,title:string|null,provenance:string,search_event_id:number|null}[]} source_observations
 * @property {{url:string,provenance:string,start:number|null,end:number|null}[]} answer_citations
 */

/**
 * The answers explorer / `GET /api/answers` query (§10.3, §11.4). Filtering is
 * server-side: there is no client router and no client-side dataset.
 *
 * @param {Db} db
 * @param {AnswerFilters} [filters]
 * @returns {{total: number, page: number, per: number, pages: number, items: AnswerItem[]}}
 */
export function queryAnswers(db, filters = {}) {
  const per = Math.max(1, Math.min(100, Math.floor(filters.per ?? 20)));
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const days = Math.max(1, Math.min(3650, Math.floor(filters.days ?? 30)));
  const now = filters.now ?? new Date();

  /** @type {string[]} */
  const clauses = ['r.created_at >= ?', 'r.created_at < ?'];
  /** @type {(string|number|null)[]} */
  const params = [filters.start ?? windowStart(days, now),
    filters.end ?? new Date(now.getTime() + 1000).toISOString().slice(0, 19) + 'Z'];

  if (filters.series) {
    clauses.push('r.surface = ?', 'r.execution_profile_id IS ?',
      'r.benchmark_revision_id IS ?', 'r.analysis_revision IS ?',
      'r.comparison_key IS ?', 'r.search_policy IS ?');
    params.push(filters.series.surface, filters.series.executionProfileId,
      filters.series.benchmarkRevisionId, filters.series.analysisRevision,
      filters.series.comparisonKey, filters.series.searchPolicy);
  }
  if (filters.eligibleOnly) {
    clauses.push("r.lane = 'tracking'", "r.target_status = 'completed'",
      "r.comparability_status = 'comparable'", "r.error IS NULL",
      "r.text IS NOT NULL", "trim(r.text) <> ''",
      "(r.answer_status IS NULL OR r.answer_status = 'complete')", "p.category <> 'branded'");
    if (filters.series?.searchPolicy === 'required') clauses.push("r.web_status = 'verified'");
    if (filters.series?.surface === 'codex-agent' || filters.series?.surface === 'claude-code-agent') {
      clauses.push("r.web_status = 'verified'");
    }
  }

  if (filters.provider) {
    clauses.push('r.provider = ?');
    params.push(String(filters.provider));
  }
  if (filters.surface) {
    clauses.push('r.surface = ?');
    params.push(String(filters.surface));
  }
  if (filters.promptId) {
    clauses.push('r.prompt_id = ?');
    params.push(Number(filters.promptId));
  }
  if (filters.entityId) {
    clauses.push('EXISTS (SELECT 1 FROM mentions m WHERE m.response_id = r.id AND m.entity_id = ?)');
    params.push(Number(filters.entityId));
  }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const totalRow = get(db, `SELECT COUNT(*) AS n FROM responses r JOIN prompts p ON p.id = r.prompt_id ${where}`, params);
  const total = Number(totalRow?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / per));

  const rows = all(
    db,
    `SELECT r.id, r.provider, r.surface, r.model, r.sample_idx, r.created_at, r.text, r.error, r.prompt_id,
            r.lane, r.target_status, r.comparability_status, r.web_status,
            r.prompt_text_snapshot, r.prompt_origin, r.cli_executable, r.artifact_ref,
            r.execution_profile_id, r.benchmark_revision_id, r.comparison_key, r.search_policy,
            COALESCE(r.prompt_text_snapshot, p.text) AS prompt
       FROM responses r
       JOIN prompts p ON p.id = r.prompt_id
       ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    [...params, per, (page - 1) * per],
  );

  /** @type {AnswerItem[]} */
  const items = rows.map((row) => {
    const review = answerReview(db, Number(row.id));
    return {
    id: Number(row.id),
    provider: String(row.provider),
    surface: row.surface === null || row.surface === undefined ? null : String(row.surface),
    model: String(row.model),
    sample_idx: Number(row.sample_idx ?? 0),
    created_at: String(row.created_at),
    prompt: String(row.prompt),
    prompt_id: Number(row.prompt_id),
    text: row.text === null || row.text === undefined ? null : String(row.text),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    lane: row.lane === null || row.lane === undefined ? null : String(row.lane),
    target_status: row.target_status === null || row.target_status === undefined ? null : String(row.target_status),
    comparability_status:
      row.comparability_status === null || row.comparability_status === undefined ? null : String(row.comparability_status),
    web_status: row.web_status === null || row.web_status === undefined ? null : String(row.web_status),
    prompt_text_snapshot:
      row.prompt_text_snapshot === null || row.prompt_text_snapshot === undefined ? null : String(row.prompt_text_snapshot),
    prompt_origin: row.prompt_origin === null || row.prompt_origin === undefined ? null : String(row.prompt_origin),
    cli_executable: row.cli_executable === null || row.cli_executable === undefined ? null : String(row.cli_executable),
    artifact_ref: row.artifact_ref === null || row.artifact_ref === undefined ? null : String(row.artifact_ref),
    analysis_revision: String(review.captureRevision),
    execution_profile_id: row.execution_profile_id === null ? null : String(row.execution_profile_id),
    benchmark_revision_id: row.benchmark_revision_id === null ? null : String(row.benchmark_revision_id),
    comparison_key: row.comparison_key === null ? null : String(row.comparison_key),
    search_policy: row.search_policy === null ? null : String(row.search_policy),
    correction_cutoff: review.correctionCutoff,
    review,
    mentions: [],
    citations: [],
    search_events: [],
    source_observations: [],
    answer_citations: [],
    };
  });

  if (items.length === 0) return { total, page, per, pages, items };

  const ids = items.map((item) => item.id);
  const placeholders = ids.map(() => '?').join(', ');
  /** @type {Map<number, AnswerItem>} */
  const byId = new Map(items.map((item) => [item.id, item]));

  const entityNames = new Map(all(db, 'SELECT id, name FROM entities')
    .map((row) => [Number(row.id), String(row.name)]));
  for (const item of items) {
    item.mentions = item.review.mentions.map((mention) => ({
      id: mention.mentionId,
      entity_id: mention.entityId,
      name: entityNames.get(mention.entityId) ?? `Entity ${mention.entityId}`,
      first_index: mention.firstIndex,
      occurrences: mention.occurrences,
      rank: mention.rank,
      recommended: mention.recommended ?? 0,
      captured_recommended: mention.capturedRecommended,
      stance: mention.effectiveStance,
      method: mention.method,
      analysis_revision: mention.analysisRevision,
      rule_id: mention.ruleId,
      evidence_start: mention.evidenceStart,
      evidence_end: mention.evidenceEnd,
      review_flags: mention.reviewFlags,
      snippet: mention.snippet,
    }));
  }

  for (const row of all(
    db,
    `SELECT id, response_id, event_type, status, query, url, title, domain, observed_at, rank
       FROM search_events
      WHERE response_id IN (${placeholders})
      ORDER BY response_id ASC, id ASC`,
    ids,
  )) {
    byId.get(Number(row.response_id))?.search_events.push({
      id: Number(row.id),
      event_type: String(row.event_type),
      status: String(row.status),
      query: row.query === null || row.query === undefined ? null : String(row.query),
      queries: [],
      url: row.url === null || row.url === undefined ? null : String(row.url),
      title: row.title === null || row.title === undefined ? null : String(row.title),
      domain: row.domain === null || row.domain === undefined ? null : String(row.domain),
      observed_at: String(row.observed_at),
      rank: row.rank === null || row.rank === undefined ? null : Number(row.rank),
    });
  }

  const events = new Map(items.flatMap((item) => item.search_events.map((event) => [event.id, event])));
  for (const row of all(db, `SELECT search_event_id, original_text FROM search_queries
      WHERE response_id IN (${placeholders}) ORDER BY search_event_id, ordinal`, ids)) {
    events.get(Number(row.search_event_id))?.queries.push(String(row.original_text));
  }

  for (const row of all(db, `SELECT response_id, search_event_id, url, title, provenance
      FROM source_observations WHERE response_id IN (${placeholders}) ORDER BY response_id, id`, ids)) {
    byId.get(Number(row.response_id))?.source_observations.push({
      url: String(row.url), title: row.title === null ? null : String(row.title),
      provenance: String(row.provenance),
      search_event_id: row.search_event_id === null ? null : Number(row.search_event_id),
    });
  }

  for (const row of all(db, `SELECT response_id, url, provenance, answer_start, answer_end
      FROM answer_citations WHERE response_id IN (${placeholders}) ORDER BY response_id, ordinal`, ids)) {
    byId.get(Number(row.response_id))?.answer_citations.push({
      url: String(row.url), provenance: String(row.provenance),
      start: row.answer_start === null ? null : Number(row.answer_start),
      end: row.answer_end === null ? null : Number(row.answer_end),
    });
  }

  for (const row of all(
    db,
    `SELECT response_id, url, domain, rank, entity_id FROM citations
      WHERE response_id IN (${placeholders})
      ORDER BY response_id ASC, rank ASC`,
    ids,
  )) {
    byId.get(Number(row.response_id))?.citations.push({
      url: String(row.url),
      domain: String(row.domain),
      entity_id: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
      rank: Number(row.rank ?? 1),
    });
  }

  return { total, page, per, pages, items };
}

/**
 * The two most recent answers that mention the brand, with the recommendation state
 * the analyser recorded — the "latest receipts" pair on the dashboard (§11.3 #7).
 *
 * @param {Db} db
 * @param {number} brandId
 * @param {AnswerFilters & {limit?:number}} [opts]
 * @returns {{id: number, provider: string, prompt: string, promptId: number, createdAt: string, snippet: string, recommended: number}[]}
 */
export function latestReceipts(db, brandId, { limit = 2, ...filters } = {}) {
  return queryAnswers(db, { ...filters, entityId: brandId, eligibleOnly: true,
    per: Math.max(1, Math.floor(limit)) }).items.map((item) => {
    const mention = item.mentions.find((row) => row.entity_id === brandId);
    return {
      id: item.id,
      provider: item.provider,
      prompt: item.prompt,
      promptId: item.prompt_id,
      createdAt: item.created_at,
      snippet: mention?.snippet ?? '',
      recommended: mention?.recommended ?? 0,
    };
  });
}

/**
 * Full-database dump for `GET /api/export` — data freedom, no secrets (§10.3, §19.6 #9).
 * API keys live in the environment and are never in any of these tables.
 *
 * @param {Db} db
 * @returns {Record<string, unknown>}
 */
export function exportAll(db) {
  const tables = [
    'settings', 'entities', 'intents', 'prompts', 'runs', 'responses', 'mentions',
    'citations', 'search_events', 'search_queries', 'source_observations',
    'answer_citations', 'usage_components', 'execution_profiles',
    'benchmark_revisions', 'benchmark_drafts', 'mention_interpretations', 'mention_corrections',
    'query_themes', 'query_theme_assignments', 'alerts',
  ];
  /** @type {Record<string, unknown>} */
  const out = {
    exportFormatVersion: 5,
    databaseSchemaVersion: userVersion(db),
    exportedAt: `${new Date().toISOString().slice(0, 19)}Z`,
    tables: {},
  };
  const bucket = /** @type {Record<string, unknown[]>} */ (out.tables);
  for (const table of tables) {
    // Table names come from this constant list only — never from user input.
    bucket[table] = all(db, `SELECT * FROM ${table}`);
  }
  return out;
}
