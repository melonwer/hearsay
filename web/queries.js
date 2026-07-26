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

import { all, get } from '../core/db.js';

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
    ? 'SELECT id, name, aliases, domains, is_self, archived_at FROM entities ORDER BY is_self DESC, id ASC'
    : 'SELECT id, name, aliases, domains, is_self, archived_at FROM entities WHERE archived_at IS NULL ORDER BY is_self DESC, id ASC';
  return all(db, sql).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    aliases: jsonList(row.aliases),
    domains: jsonList(row.domains),
    is_self: Number(row.is_self) === 1 ? 1 : 0,
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
 * @property {number} intent_id
 * @property {string} text
 * @property {string} category
 * @property {number} active 0|1
 */

/**
 * @param {Db} db
 * @returns {Prompt[]}
 */
export function listPrompts(db) {
  return all(db, 'SELECT id, intent_id, text, category, active FROM prompts ORDER BY intent_id ASC, id ASC').map(
    (row) => ({
      id: Number(row.id),
      intent_id: Number(row.intent_id),
      text: String(row.text),
      category: String(row.category),
      active: Number(row.active) === 1 ? 1 : 0,
    }),
  );
}

/**
 * @typedef {Object} Paraphrase
 * @property {number} id
 * @property {string} text
 * @property {number} active 0|1
 * @property {string} category
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
    /** @type {{id: number, text: string, active: number, category: string}[]} */
    paraphrases: [],
  }));
  /** @type {Map<number, typeof intents[0]>} */
  const byId = new Map(intents.map((i) => [i.id, i]));
  for (const prompt of listPrompts(db)) {
    const intent = byId.get(prompt.intent_id);
    if (!intent) continue;
    intent.paraphrases.push({
      id: prompt.id,
      text: prompt.text,
      active: prompt.active,
      category: prompt.category,
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
 * @property {string} title
 * @property {string} detail
 * @property {number} acknowledged 0|1
 * @property {string|null} entityName
 * @property {string|null} promptText
 */

/**
 * @param {Db} db
 * @param {{open?: boolean, limit?: number}} [opts]
 * @returns {AlertRow[]}
 */
export function listAlerts(db, { open = true, limit = 200 } = {}) {
  const where = open ? 'WHERE a.acknowledged = 0' : '';
  const rows = all(
    db,
    `SELECT a.id, a.created_at, a.run_id, a.severity, a.type, a.entity_id, a.prompt_id, a.provider,
            a.title, a.detail, a.acknowledged,
            e.name AS entityName, p.text AS promptText
       FROM alerts a
       LEFT JOIN entities e ON e.id = a.entity_id
       LEFT JOIN prompts  p ON p.id = a.prompt_id
       ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    [Math.max(1, Math.min(1000, Math.floor(limit)))],
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
 * @returns {{id: number, status: string, total_calls: number, done_calls: number, started_at: string, finished_at: string|null, trigger: string}|null}
 */
export function latestRun(db) {
  const row = get(
    db,
    'SELECT id, status, total_calls, done_calls, started_at, finished_at, trigger FROM runs ORDER BY id DESC LIMIT 1',
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
 * @property {number|null} [promptId]
 * @property {number|null} [entityId]
 * @property {number} [days]
 * @property {number} [page] 1-based
 * @property {number} [per]
 * @property {Date} [now]
 */

/**
 * @typedef {Object} AnswerItem
 * @property {number} id
 * @property {string} provider
 * @property {string} model
 * @property {number} sample_idx
 * @property {string} created_at
 * @property {string} prompt
 * @property {number} prompt_id
 * @property {string|null} text
 * @property {string|null} error
 * @property {{entity_id: number, name: string, first_index: number, occurrences: number, recommended: number, snippet: string, rank: number}[]} mentions
 * @property {{url: string, domain: string, entity_id: number|null, rank: number}[]} citations
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

  /** @type {string[]} */
  const clauses = ['r.created_at >= ?'];
  /** @type {(string|number)[]} */
  const params = [windowStart(days, filters.now)];

  if (filters.provider) {
    clauses.push('r.provider = ?');
    params.push(String(filters.provider));
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

  const totalRow = get(db, `SELECT COUNT(*) AS n FROM responses r ${where}`, params);
  const total = Number(totalRow?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / per));

  const rows = all(
    db,
    `SELECT r.id, r.provider, r.model, r.sample_idx, r.created_at, r.text, r.error, r.prompt_id,
            p.text AS prompt
       FROM responses r
       JOIN prompts p ON p.id = r.prompt_id
       ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    [...params, per, (page - 1) * per],
  );

  /** @type {AnswerItem[]} */
  const items = rows.map((row) => ({
    id: Number(row.id),
    provider: String(row.provider),
    model: String(row.model),
    sample_idx: Number(row.sample_idx ?? 0),
    created_at: String(row.created_at),
    prompt: String(row.prompt),
    prompt_id: Number(row.prompt_id),
    text: row.text === null || row.text === undefined ? null : String(row.text),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    mentions: [],
    citations: [],
  }));

  if (items.length === 0) return { total, page, per, pages, items };

  const ids = items.map((item) => item.id);
  const placeholders = ids.map(() => '?').join(', ');
  /** @type {Map<number, AnswerItem>} */
  const byId = new Map(items.map((item) => [item.id, item]));

  for (const row of all(
    db,
    `SELECT m.response_id, m.entity_id, m.first_index, m.occurrences, m.rank, m.recommended, m.snippet, e.name
       FROM mentions m JOIN entities e ON e.id = m.entity_id
      WHERE m.response_id IN (${placeholders})
      ORDER BY m.response_id ASC, m.rank ASC`,
    ids,
  )) {
    byId.get(Number(row.response_id))?.mentions.push({
      entity_id: Number(row.entity_id),
      name: String(row.name),
      first_index: Number(row.first_index),
      occurrences: Number(row.occurrences ?? 1),
      rank: Number(row.rank ?? 1),
      recommended: Number(row.recommended) === 1 ? 1 : 0,
      snippet: String(row.snippet ?? ''),
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
 * @param {{limit?: number, days?: number, now?: Date}} [opts]
 * @returns {{id: number, provider: string, prompt: string, promptId: number, createdAt: string, snippet: string, recommended: number}[]}
 */
export function latestReceipts(db, brandId, { limit = 2, days = 30, now } = {}) {
  return all(
    db,
    `SELECT r.id, r.provider, r.created_at, r.prompt_id, p.text AS prompt, m.snippet, m.recommended
       FROM mentions m
       JOIN responses r ON r.id = m.response_id
       JOIN prompts   p ON p.id = r.prompt_id
      WHERE m.entity_id = ? AND r.error IS NULL AND r.created_at >= ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?`,
    [Number(brandId), windowStart(days, now), Math.max(1, Math.floor(limit))],
  ).map((row) => ({
    id: Number(row.id),
    provider: String(row.provider),
    prompt: String(row.prompt),
    promptId: Number(row.prompt_id),
    createdAt: String(row.created_at),
    snippet: String(row.snippet ?? ''),
    recommended: Number(row.recommended) === 1 ? 1 : 0,
  }));
}

/**
 * Full-database dump for `GET /api/export` — data freedom, no secrets (§10.3, §19.6 #9).
 * API keys live in the environment and are never in any of these tables.
 *
 * @param {Db} db
 * @returns {Record<string, unknown>}
 */
export function exportAll(db) {
  const tables = ['settings', 'entities', 'intents', 'prompts', 'runs', 'responses', 'mentions', 'citations', 'alerts'];
  /** @type {Record<string, unknown>} */
  const out = { exportedAt: `${new Date().toISOString().slice(0, 19)}Z`, tables: {} };
  const bucket = /** @type {Record<string, unknown[]>} */ (out.tables);
  for (const table of tables) {
    // Table names come from this constant list only — never from user input.
    bucket[table] = all(db, `SELECT * FROM ${table}`);
  }
  return out;
}
