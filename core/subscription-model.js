/**
 * Shared storage vocabulary for subscription-agent measurements.
 *
 * This module is deliberately independent of the runner and web layers. It owns the
 * values that determine whether a retained response may enter a comparable metric and
 * the small state transitions used by exploration/promotion and run finalisation.
 */

import { createHash } from 'node:crypto';

import { get, isoNow, run, transaction } from './db.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

export const PROMPT_LANES = /** @type {const} */ (['tracking', 'exploration']);
export const PROMPT_ORIGINS = /** @type {const} */ (['user_authored', 'suggested', 'imported', 'legacy']);
export const TARGET_STATUSES = /** @type {const} */ (['queued', 'running', 'completed', 'failed', 'cancelled']);
export const COMPARABILITY_STATUSES = /** @type {const} */ (['comparable', 'non_comparable']);
export const WEB_STATUSES = /** @type {const} */ (['verified', 'unavailable', 'unverified', 'failed', 'not_applicable']);
export const SURFACES = /** @type {const} */ ([
  'openai-api',
  'anthropic-api',
  'gemini-api',
  'perplexity-api',
  'codex-agent',
  'claude-code-agent',
]);

/** @typedef {'tracking'|'exploration'} PromptLane */
/** @typedef {'user_authored'|'suggested'|'imported'|'legacy'} PromptOrigin */
/** @typedef {'queued'|'running'|'completed'|'failed'|'cancelled'} TargetStatus */
/** @typedef {'comparable'|'non_comparable'} ComparabilityStatus */
/** @typedef {'verified'|'unavailable'|'unverified'|'failed'|'not_applicable'} WebStatus */

export class SubscriptionModelError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SubscriptionModelError';
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {readonly string[]} allowed
 * @returns {string}
 */
function enumValue(value, field, allowed) {
  const string = String(value ?? '');
  if (!allowed.includes(string)) throw new SubscriptionModelError(`${field} must be one of: ${allowed.join(', ')}`);
  return string;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function promptText(value, field = 'text') {
  const text = String(value ?? '').trim();
  if (text === '') throw new SubscriptionModelError(`${field} cannot be empty`);
  if (text.length > 300) throw new SubscriptionModelError(`${field} must be 300 characters or fewer`);
  return text;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{id:number, text:string, category:string, active:boolean, trackingState:PromptLane,
 *   origin:PromptOrigin, intentId:number|null, approvedAt:string|null, promotedAt:string|null}}
 */
function promptView(row) {
  return {
    id: Number(row.id),
    text: String(row.text),
    category: String(row.category),
    active: Number(row.active) === 1,
    trackingState: /** @type {PromptLane} */ (String(row.tracking_state)),
    origin: /** @type {PromptOrigin} */ (String(row.origin)),
    intentId: row.intent_id === null || row.intent_id === undefined ? null : Number(row.intent_id),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : String(row.approved_at),
    promotedAt: row.promoted_at === null || row.promoted_at === undefined ? null : String(row.promoted_at),
  };
}

/**
 * Create an inactive, persisted exploration question.
 *
 * @param {Db} db
 * @param {{text:string, category?:string, origin?:'user_authored'|'suggested'|'imported', now?:Date}} input
 * @returns {ReturnType<typeof promptView>}
 */
export function createExplorationPrompt(db, input) {
  const text = promptText(input?.text);
  const category = promptText(input?.category ?? 'general', 'category');
  const origin = enumValue(input?.origin ?? 'suggested', 'origin', PROMPT_ORIGINS.filter((v) => v !== 'legacy'));
  const createdAt = isoNow(input?.now ?? new Date());
  const existing = get(db, 'SELECT id FROM prompts WHERE text = ?', [text]);
  if (existing) throw new SubscriptionModelError('That prompt text already exists');
  const id = run(
    db,
    `INSERT INTO prompts(intent_id, text, category, active, created_at, tracking_state, origin)
     VALUES(NULL, ?, ?, 0, ?, 'exploration', ?)`,
    [text, category, createdAt, origin],
  ).lastInsertRowid;
  return promptView(/** @type {Record<string, unknown>} */ (get(db, 'SELECT * FROM prompts WHERE id = ?', [id])));
}

/**
 * Promote an inactive exploration question into the approved tracking panel.
 *
 * @param {Db} db
 * @param {number} promptId
 * @param {number} intentId
 * @param {Date|string} [now]
 * @returns {ReturnType<typeof promptView>}
 */
export function promotePrompt(db, promptId, intentId, now = new Date()) {
  const prompt = get(db, 'SELECT * FROM prompts WHERE id = ?', [Number(promptId)]);
  if (!prompt) throw new SubscriptionModelError('No such prompt');
  if (String(prompt.tracking_state) !== 'exploration' || Number(prompt.active) !== 0 || prompt.intent_id !== null) {
    throw new SubscriptionModelError('Only an inactive exploration prompt can be promoted');
  }
  if (!get(db, 'SELECT id FROM intents WHERE id = ?', [Number(intentId)])) {
    throw new SubscriptionModelError('No such intent');
  }
  const at = isoNow(typeof now === 'string' ? new Date(now) : now);
  transaction(db, () => {
    run(
      db,
      `UPDATE prompts
          SET intent_id = ?, active = 1, tracking_state = 'tracking', approved_at = ?, promoted_at = ?
        WHERE id = ? AND tracking_state = 'exploration' AND active = 0 AND intent_id IS NULL`,
      [Number(intentId), at, at, Number(promptId)],
    );
  });
  return promptView(/** @type {Record<string, unknown>} */ (get(db, 'SELECT * FROM prompts WHERE id = ?', [Number(promptId)])));
}

/**
 * Read the immutable question metadata used when inserting a response target.
 *
 * @param {Db} db
 * @param {number} promptId
 * @returns {{text:string, origin:PromptOrigin, trackingState:PromptLane}|null}
 */
export function promptSnapshot(db, promptId) {
  const row = get(db, 'SELECT text, origin, tracking_state FROM prompts WHERE id = ?', [Number(promptId)]);
  if (!row) return null;
  return {
    text: String(row.text),
    origin: /** @type {PromptOrigin} */ (String(row.origin)),
    trackingState: /** @type {PromptLane} */ (String(row.tracking_state)),
  };
}

/**
 * Build the comparison identity from the dimensions that change answer comparability.
 * Explicit ordering prevents object-property insertion order from changing a series id.
 *
 * @param {{surface:string, model?:string|null, promptEnvelopeVersion?:string|null,
 *   executionProfileHash?:string|null, locationControl?:string|null, languageControl?:string|null}} input
 * @returns {string}
 */
export function comparisonKey(input) {
  const dimensions = [
    String(input.surface ?? ''),
    String(input.model ?? ''),
    String(input.promptEnvelopeVersion ?? ''),
    String(input.executionProfileHash ?? ''),
    String(input.locationControl ?? 'uncontrolled'),
    String(input.languageControl ?? 'uncontrolled'),
  ];
  return createHash('sha256').update(JSON.stringify(dimensions)).digest('hex');
}

/**
 * Return the common metric eligibility predicate. Callers append it to a `WHERE` clause
 * and can request the extra verified-search requirement for subscription surfaces.
 *
 * @param {string} [alias]
 * @param {{subscription?:boolean, surface?:string, comparisonKey?:string}} [options]
 * @returns {{sql:string, params:(string|number|null)[]}}
 */
export function eligibilitySql(alias = 'r', options = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new SubscriptionModelError('Invalid SQL alias');
  const clauses = [
    `${alias}.lane = 'tracking'`,
    `${alias}.target_status = 'completed'`,
    `${alias}.comparability_status = 'comparable'`,
  ];
  /** @type {(string|number|null)[]} */
  const params = [];
  if (options.subscription === true) clauses.push(`${alias}.web_status = 'verified'`);
  if (options.surface !== undefined) {
    clauses.push(`${alias}.surface = ?`);
    params.push(options.surface);
  }
  if (options.comparisonKey !== undefined) {
    clauses.push(`${alias}.comparison_key = ?`);
    params.push(options.comparisonKey);
  }
  return { sql: clauses.join(' AND '), params };
}

/**
 * @param {Record<string, unknown>} target
 * @returns {boolean}
 */
function targetComparable(target) {
  const targetStatus = String(target.target_status ?? target.targetStatus ?? '');
  const comparison = String(target.comparability_status ?? target.comparabilityStatus ?? '');
  if (targetStatus !== 'completed' || comparison !== 'comparable') return false;
  const surface = String(target.surface ?? '');
  return !['codex-agent', 'claude-code-agent'].includes(surface) || String(target.web_status ?? target.webStatus ?? '') === 'verified';
}

/**
 * Reduce persisted target states to the logical run status.
 *
 * @param {Record<string, unknown>[]} targets
 * @returns {'done'|'partial'|'failed'|'cancelled'|'missed'}
 */
export function runStatusFromTargets(targets) {
  if (targets.length === 0) return 'failed';
  const statuses = targets.map((target) => String(target.target_status ?? target.targetStatus ?? ''));
  if (statuses.includes('missed')) return 'missed';
  const comparable = targets.filter(targetComparable).length;
  if (comparable === targets.length) return 'done';
  if (comparable > 0) return 'partial';
  if (statuses.includes('cancelled') && statuses.every((status) => status === 'cancelled' || status === 'queued' || status === 'running')) {
    return 'cancelled';
  }
  return 'failed';
}
