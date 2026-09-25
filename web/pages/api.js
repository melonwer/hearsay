/**
 * /api/* — the JSON API shared by the UI, the CLI and the MCP server (§10.3).
 *
 * Envelope (§10.3): success is the object itself; an error is
 * `{"error":{"code","message"}}` with the matching status. Validation lives here
 * rather than in the pages, because the MCP server and `curl` reach these same
 * routes and have to hit the same rules.
 *
 * Statistics are never recomputed here — they come from `core/metrics.js` (§7) and
 * `core/cost.js` (§4.3) through `web/data.js`. When one of those has not landed, the
 * endpoint answers 503 rather than 200 with an invented shape.
 */

import { all, get, isoNow, run, transaction, getSetting, setSetting, SETTING_KEYS } from '../../core/db.js';
import { estimateRunCost, PRICE_TABLE_VERSION } from '../../core/cost.js';
import { apiExecutionBudget } from '../../core/execution-budget.js';
import { API_SEARCH_SCHEDULE_CONSENT_VERSION, apiScheduleQuoteId,
  apiSearchScheduleApproved, disableApiSearchSchedule, getApiSearchSchedule, hasEnabledApiSearch,
  saveApiSearchSchedule } from '../../core/api-search-schedule.js';
import { stableIdentity } from '../../core/measurement-contract.js';
import { sendJson, sendError, sendHtml } from '../router.js';
import { metrics, NotReadyError, runner, soft, strict, suggest } from '../data.js';
import {
  activePromptCount,
  brandEntity,
  CATEGORIES,
  exportAll,
  latestRun,
  listAlerts,
  listEntities,
  listIntents,
  listPrompts,
  PROVIDERS,
  queryAnswers,
} from '../queries.js';
import { aliasesFor, MIN_ALIAS_LENGTH } from '../../core/analyze.js';
import { answerReview, appendCorrection, STANCES } from '../../core/interpretations.js';
import { answerEvidence, createQueryTheme, intentEvidenceReport, listEvidenceIntents,
  listQueryThemes, setQueryThemeAssignment } from '../../core/evidence-report.js';
import { OpportunityError, deriveOpportunityCandidates, generateOpportunityCandidates,
  listOpportunities, getOpportunity, createOpportunity, reviewOpportunity,
  attachOpportunityPageEvidence, reviewOpportunityPageEvidence,
  combineOpportunities } from '../../core/opportunities.js';
import { saveFollowUpPlan, captureFollowUpReview } from '../../core/follow-up.js';
import { compareIntervention, saveInterventionReview } from '../../core/intervention-comparison.js';
import { buildWeeklyReview, renderWeeklyMarkdown, WeeklyReviewError } from '../../core/weekly-review.js';
import { OutcomeError, recordOutcome, importOutcomeCsv, recordLedgerEntry,
  exportOutcomeCsv } from '../../core/outcomes.js';
import { renderWeeklyReviewExport } from './weekly-review.js';
import { trackingHealth } from '../../core/tracking-health.js';
import { listMeasurementSeries, resolveMeasurementSeries, stanceRecommendationRate } from '../../core/metrics.js';
import { PROVIDER_IDS } from '../../core/config.js';
import {
  createExplorationPrompt,
  promotePrompt,
  surfaceLabel,
  SubscriptionModelError,
  SURFACES,
} from '../../core/subscription-model.js';
import { PROMPT_CATEGORIES } from '../../core/suggest.js';
import { createDraft, getDraft, updateDraft, reviewDraft, approveDraft,
  reviewTrackingPrompt, validateTrackingQuestion, assertReviewedSelection,
  recordCurrentBenchmarkRevision, mentionsBrandWord, BenchmarkDraftError } from '../../core/benchmark-draft.js';
import {
  SubscriptionConfirmationError,
  SubscriptionRunError,
  subscriptionPreview,
  runSubscriptionPanel,
} from '../../core/subscription-runner.js';
import { DemoModeError } from '../../core/runner.js';
import {
  DEFAULT_SUBSCRIPTION_GRACE_MINUTES,
  SCHEDULE_CONSENT_VERSION,
  SubscriptionScheduleError,
  disableSubscriptionSchedule,
  getSubscriptionSchedule,
  saveSubscriptionSchedule,
} from '../../core/subscription-scheduler.js';

const SURFACE_IDS = /** @type {string[]} */ ([...SURFACES]);

/** @type {WeakMap<import('node:sqlite').DatabaseSync, Map<number, AbortController>>} */
const subscriptionControllers = new WeakMap();

/** @param {import('node:sqlite').DatabaseSync} db @returns {Map<number, AbortController>} */
function controllersFor(db) {
  let controllers = subscriptionControllers.get(db);
  if (!controllers) {
    controllers = new Map();
    subscriptionControllers.set(db, controllers);
  }
  return controllers;
}

/** Default reporting window (§7). */
export const DEFAULT_DAYS = 30;

/** An error with an HTTP status and a §10.3 error code. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = code;
  }
}

/** Lets a handler pick its own success status inside the json() wrapper (SPEC §3.3). */
export class WithStatus {
  /**
   * @param {number} status
   * @param {unknown} body
   */
  constructor(status, body) {
    /** @type {number} */
    this.status = status;
    /** @type {unknown} */
    this.body = body;
  }
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function asObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'bad_request', 'Body must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (body);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{max?: number, required?: boolean}} [opts]
 * @returns {string|undefined}
 */
function str(value, field, { max = 300, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(422, 'unprocessable', `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ApiError(422, 'unprocessable', `${field} must be a string`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw new ApiError(422, 'unprocessable', `${field} cannot be empty`);
  if (trimmed.length > max) throw new ApiError(422, 'unprocessable', `${field} must be ${max} characters or fewer`);
  return trimmed;
}

/**
 * An optional array-of-objects field (SPEC §3.2). Anything that is not an array — a
 * single object, a string, a number — is a 422 with the field's path in the message,
 * never a raw TypeError that the router would surface as a 500.
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, unknown>[]}
 */
function objectList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiError(422, 'unprocessable', `${field} must be an array of objects`);
  return value.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApiError(422, 'unprocessable', `${field}[${i}] must be an object`);
    }
    return /** @type {Record<string, unknown>} */ (item);
  });
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]|undefined}
 */
function strList(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ApiError(422, 'unprocessable', `${field} must be an array of strings`);
  return value.map((item, i) => {
    if (typeof item !== 'string') throw new ApiError(422, 'unprocessable', `${field}[${i}] must be a string`);
    return item.trim();
  });
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {boolean|undefined}
 */
function bool(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  throw new ApiError(422, 'unprocessable', `${field} must be a boolean`);
}

/**
 * @param {string} params
 * @returns {number}
 */
function idParam(params) {
  const id = Number.parseInt(params, 10);
  if (!Number.isFinite(id) || id <= 0) throw new ApiError(404, 'not_found', 'No such record');
  return id;
}

/**
 * @param {URL} url
 * @param {string} key
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intQuery(url, key, fallback, min, max) {
  const value = url.searchParams.get(key);
  if (value === null || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, 'bad_request', `${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * Optional surface query shared by metric and answer routes.
 * @param {URL} url
 * @returns {string|undefined}
 */
function surfaceQuery(url) {
  const value = url.searchParams.get('surface');
  if (value === null || value.trim() === '') return undefined;
  if (!SURFACE_IDS.includes(value)) throw new ApiError(400, 'bad_request', `surface must be one of: ${SURFACE_IDS.join(', ')}`);
  return value;
}

/**
 * @param {string|undefined} category
 * @returns {string}
 */
function checkCategory(category) {
  if (category === undefined) return 'general';
  if (!CATEGORIES.includes(category)) {
    throw new ApiError(422, 'unprocessable', `category must be one of: ${CATEGORIES.join(', ')}`);
  }
  return category;
}

/**
 * Domains are normalised the way the analyser normalises cited hostnames, so the
 * uniqueness check here means the same thing as the citation match later (§6.3).
 * @param {string} value
 * @returns {string}
 */
function normaliseDomain(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .replace(/^www\./, '');
}

/**
 * @typedef {Object} ApiDeps
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {import('../../core/config.js').Config} config
 * @property {string} version package.json version, surfaced by /api/status (SPEC §3.1)
 */

/* ------------------------------------------------------------------ *
 * Entities
 * ------------------------------------------------------------------ */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} domains
 * @param {number|null} exceptId
 * @returns {void}
 */
function assertDomainsFree(db, domains, exceptId) {
  if (domains.length === 0) return;
  const wanted = new Set(domains.map(normaliseDomain).filter((domain) => domain !== ''));
  if (wanted.size === 0) return;
  for (const row of listEntities(db, { includeArchived: true })) {
    if (exceptId !== null && row.id === exceptId) continue;
    for (const owned of row.domains.map(normaliseDomain)) {
      if (wanted.has(owned)) {
        throw new ApiError(409, 'conflict', `Domain ${owned} already belongs to ${row.name}`);
      }
    }
  }
}

/**
 * @param {string[]} aliases
 * @returns {string[]}
 */
function checkAliases(aliases) {
  for (const alias of aliases) {
    if (alias.length > 0 && alias.length < MIN_ALIAS_LENGTH) {
      throw new ApiError(
        422,
        'unprocessable',
        `Alias "${alias}" is shorter than ${MIN_ALIAS_LENGTH} characters — it would match too much text to be evidence`,
      );
    }
  }
  return aliases.filter((alias) => alias !== '');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} keepId
 * @returns {void}
 */
function makeSelf(db, keepId) {
  run(db, 'UPDATE entities SET is_self = 0 WHERE id != ?', [keepId]);
  run(db, 'UPDATE entities SET is_self = 1 WHERE id = ?', [keepId]);
}

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function createEntity({ db }, ctx) {
  const body = asObject(ctx.body);
  const name = /** @type {string} */ (str(body.name, 'name', { max: 120, required: true }));
  const aliases = checkAliases(strList(body.aliases, 'aliases') ?? []);
  const domains = (strList(body.domains, 'domains') ?? []).map(normaliseDomain).filter((domain) => domain !== '');
  const isSelf = bool(body.is_self, 'is_self') ?? false;
  const ambiguousName = bool(body.ambiguous_name, 'ambiguous_name') ?? false;

  if (get(db, 'SELECT id FROM entities WHERE name = ?', [name])) {
    throw new ApiError(409, 'conflict', `An entity named ${name} already exists`);
  }
  assertDomainsFree(db, domains, null);

  const id = transaction(db, () => {
    const result = run(db, 'INSERT INTO entities(name, aliases, domains, is_self, ambiguous_name, created_at) VALUES(?, ?, ?, ?, ?, ?)', [
      name,
      JSON.stringify(aliases),
      JSON.stringify(domains),
      isSelf ? 1 : 0,
      ambiguousName ? 1 : 0,
      isoNow(),
    ]);
    // Exactly one row carries is_self (§3) — enforced here, not by the schema.
    if (isSelf) makeSelf(db, result.lastInsertRowid);
    recordCurrentBenchmarkRevision(db);
    return result.lastInsertRowid;
  });

  return listEntities(db, { includeArchived: true }).find((entity) => entity.id === id) ?? null;
}

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function patchEntity({ db }, ctx) {
  const id = idParam(ctx.params.id);
  const existing = listEntities(db, { includeArchived: true }).find((entity) => entity.id === id);
  if (!existing) throw new ApiError(404, 'not_found', 'No such entity');
  const body = asObject(ctx.body);

  const name = str(body.name, 'name', { max: 120 });
  const aliases = body.aliases === undefined ? undefined : checkAliases(strList(body.aliases, 'aliases') ?? []);
  const domains =
    body.domains === undefined
      ? undefined
      : (strList(body.domains, 'domains') ?? []).map(normaliseDomain).filter((domain) => domain !== '');
  const isSelf = bool(body.is_self, 'is_self');
  const ambiguousName = bool(body.ambiguous_name, 'ambiguous_name');

  // The single-is_self invariant (§3) must land on a VISIBLE row: brandEntity()
  // excludes archived entities, so parking the flag on an archived one would strip
  // is_self from the live brand and leave the deployment with no brand at all.
  if (isSelf === true && existing.archived_at !== null) {
    throw new ApiError(409, 'conflict', 'Cannot make an archived entity the brand');
  }

  if (domains !== undefined) assertDomainsFree(db, domains, id);
  if (name !== undefined && name !== existing.name && get(db, 'SELECT id FROM entities WHERE name = ?', [name])) {
    throw new ApiError(409, 'conflict', `An entity named ${name} already exists`);
  }

  transaction(db, () => {
    if (name !== undefined) run(db, 'UPDATE entities SET name = ? WHERE id = ?', [name, id]);
    if (aliases !== undefined) run(db, 'UPDATE entities SET aliases = ? WHERE id = ?', [JSON.stringify(aliases), id]);
    if (domains !== undefined) run(db, 'UPDATE entities SET domains = ? WHERE id = ?', [JSON.stringify(domains), id]);
    if (isSelf === true) makeSelf(db, id);
    if (isSelf === false) run(db, 'UPDATE entities SET is_self = 0 WHERE id = ?', [id]);
    if (ambiguousName !== undefined) run(db, 'UPDATE entities SET ambiguous_name = ? WHERE id = ?', [ambiguousName ? 1 : 0, id]);
    recordCurrentBenchmarkRevision(db);
  });

  return listEntities(db, { includeArchived: true }).find((entity) => entity.id === id) ?? null;
}

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function deleteEntity({ db }, ctx) {
  const id = idParam(ctx.params.id);
  if (!get(db, 'SELECT id FROM entities WHERE id = ?', [id])) throw new ApiError(404, 'not_found', 'No such entity');
  const mentions = Number(get(db, 'SELECT COUNT(*) AS n FROM mentions WHERE entity_id = ?', [id])?.n ?? 0);
  const citations = Number(get(db, 'SELECT COUNT(*) AS n FROM citations WHERE entity_id = ?', [id])?.n ?? 0);
  if (mentions > 0 || citations > 0) {
    // Soft delete: past answers keep their receipts — text mentions AND citation
    // matches — and metrics stop counting it. citations.entity_id carries no FK, so a
    // hard delete here would leave dangling ids in /api/answers and /api/export.
    run(db, 'UPDATE entities SET archived_at = ? WHERE id = ?', [isoNow(), id]);
    recordCurrentBenchmarkRevision(db);
    return { archived: true, mentions, citations };
  }
  run(db, 'DELETE FROM entities WHERE id = ?', [id]);
  recordCurrentBenchmarkRevision(db);
  return { deleted: true };
}

/* ------------------------------------------------------------------ *
 * Prompts & intents
 * ------------------------------------------------------------------ */

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function createPrompt({ db }, ctx) {
  const body = asObject(ctx.body);
  const text = /** @type {string} */ (str(body.text, 'text', { max: 300, required: true }));
  if (body.reviewed !== true) throw new ApiError(422, 'review_required', 'Review this exact question and submit reviewed: true');
  draftAction(() => validateTrackingQuestion(text));
  const sourceNote = str(body.source_note, 'source_note', { max: 1000 }) ?? null;
  const requestedCategory = checkCategory(str(body.category, 'category', { max: 40 }));
  const brand = brandEntity(db);
  const category = brand && mentionsBrandWord(text, aliasesFor(brand)) ? 'branded' : requestedCategory;
  const intentId = body.intent_id === undefined || body.intent_id === null ? null : idParam(String(body.intent_id));

  if (get(db, 'SELECT id FROM prompts WHERE text = ?', [text])) {
    throw new ApiError(409, 'conflict', 'That prompt text already exists');
  }
  if (intentId !== null && !get(db, 'SELECT id FROM intents WHERE id = ?', [intentId])) {
    throw new ApiError(404, 'not_found', 'No such intent');
  }

  const id = transaction(db, () => {
    let target = intentId;
    if (target === null) {
      // No intent given → a single-paraphrase intent labelled with the prompt (§3).
      const existing = get(db, 'SELECT id FROM intents WHERE label = ?', [text]);
      target = existing
        ? Number(existing.id)
        : run(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', [text, isoNow()]).lastInsertRowid;
    }
    const createdId = run(db, `INSERT INTO prompts(
      intent_id, text, category, active, created_at, tracking_state, origin, approved_at, source_note
    ) VALUES(?, ?, ?, 1, ?, 'tracking', 'user_authored', ?, ?)`, [
      target,
      text,
      category,
      isoNow(),
      isoNow(),
      sourceNote,
    ]).lastInsertRowid;
    draftAction(() => reviewTrackingPrompt(db, Number(createdId)));
    recordCurrentBenchmarkRevision(db);
    return createdId;
  });

  return listPrompts(db).find((prompt) => prompt.id === id) ?? null;
}

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function patchPrompt({ db }, ctx) {
  const id = idParam(ctx.params.id);
  const existing = listPrompts(db).find((prompt) => prompt.id === id);
  if (!existing) throw new ApiError(404, 'not_found', 'No such prompt');
  const body = asObject(ctx.body);

  const text = str(body.text, 'text', { max: 300 });
  const category = body.category === undefined ? undefined : checkCategory(str(body.category, 'category', { max: 40 }));
  const brand = brandEntity(db);
  const effectiveCategory = brand && mentionsBrandWord(text ?? existing.text, aliasesFor(brand)) ? 'branded' : category;
  const active = bool(body.active, 'active');
  const intentId = body.intent_id === undefined || body.intent_id === null ? undefined : idParam(String(body.intent_id));
  const sourceNote = str(body.source_note, 'source_note', { max: 1000 });
  const changesQuestion = (text !== undefined && text !== existing.text)
    || (effectiveCategory !== undefined && effectiveCategory !== existing.category)
    || (intentId !== undefined && intentId !== existing.intent_id);
  if ((changesQuestion || (active === true && existing.active !== 1)) && body.reviewed !== true) {
    throw new ApiError(422, 'review_required', 'Review this exact question and submit reviewed: true');
  }
  if (text !== undefined) draftAction(() => validateTrackingQuestion(text));

  if (existing.tracking_state === 'exploration' && (active === true || intentId !== undefined)) {
    throw new ApiError(409, 'promotion_required', 'Exploration prompts must be promoted explicitly before activation or assignment');
  }

  if (text !== undefined && text !== existing.text && get(db, 'SELECT id FROM prompts WHERE text = ?', [text])) {
    throw new ApiError(409, 'conflict', 'That prompt text already exists');
  }
  if (intentId !== undefined && !get(db, 'SELECT id FROM intents WHERE id = ?', [intentId])) {
    throw new ApiError(404, 'not_found', 'No such intent');
  }

  transaction(db, () => {
    if (text !== undefined) run(db, 'UPDATE prompts SET text = ? WHERE id = ?', [text, id]);
    if (effectiveCategory !== undefined) run(db, 'UPDATE prompts SET category = ? WHERE id = ?', [effectiveCategory, id]);
    if (active !== undefined) run(db, 'UPDATE prompts SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    if (intentId !== undefined) run(db, 'UPDATE prompts SET intent_id = ? WHERE id = ?', [intentId, id]);
    if (sourceNote !== undefined) run(db, 'UPDATE prompts SET source_note = ? WHERE id = ?', [sourceNote, id]);
    if (body.reviewed === true && active !== false && existing.tracking_state === 'tracking') {
      draftAction(() => reviewTrackingPrompt(db, id));
    }
    if (changesQuestion || active !== undefined) recordCurrentBenchmarkRevision(db);
  });

  return listPrompts(db).find((prompt) => prompt.id === id) ?? null;
}

/**
 * Create an inactive exploration question. Exploration is deliberately a separate
 * endpoint so the ordinary prompt CRUD path cannot accidentally add discovery
 * evidence to the approved tracking panel.
 *
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {WithStatus|Record<string, unknown>}
 */
function createExploration({ db }, ctx) {
  const body = asObject(ctx.body);
  const text = /** @type {string} */ (str(body.text, 'text', { max: 300, required: true }));
  const category = str(body.category, 'category', { max: 40 }) ?? 'general';
  const origin = str(body.origin, 'origin', { max: 30 }) ?? 'user_authored';
  if (!['user_authored', 'suggested', 'imported'].includes(origin)) {
    throw new ApiError(422, 'unprocessable', 'origin must be user_authored, suggested, or imported');
  }
  try {
    return new WithStatus(
      201,
      explorationApiView(
        createExplorationPrompt(db, {
          text,
          category,
          origin: /** @type {'user_authored'|'suggested'|'imported'} */ (origin),
        }),
      ),
    );
  } catch (error) {
    if (error instanceof SubscriptionModelError) {
      const conflict = error.message.includes('already exists');
      throw new ApiError(conflict ? 409 : 422, conflict ? 'conflict' : 'unprocessable', error.message);
    }
    throw error;
  }
}

/** @param {Record<string, unknown>} prompt @returns {Record<string, unknown>} */
function explorationApiView(prompt) {
  return {
    id: Number(prompt.id),
    intent_id: prompt.intentId === null || prompt.intentId === undefined ? null : Number(prompt.intentId),
    text: String(prompt.text),
    category: String(prompt.category),
    active: prompt.active ? 1 : 0,
    tracking_state: String(prompt.trackingState),
    origin: String(prompt.origin),
    approved_at: prompt.approvedAt ?? null,
    promoted_at: prompt.promotedAt ?? null,
  };
}

/**
 * Promote an inactive exploration question into a tracked intent. This is the only
 * API path that changes an exploration prompt's lane/state.
 *
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {Record<string, unknown>}
 */
function promoteExploration({ db }, ctx) {
  const promptId = idParam(ctx.params.id);
  const body = asObject(ctx.body);
  if (body.reviewed !== true) throw new ApiError(422, 'review_required', 'Review this exact exploration question and submit reviewed: true');
  const intentId = body.intent_id === undefined || body.intent_id === null ? null : idParam(String(body.intent_id));
  if (intentId === null) throw new ApiError(422, 'unprocessable', 'intent_id is required to promote an exploration prompt');
  try {
    const promoted = promotePrompt(db, promptId, intentId);
    recordCurrentBenchmarkRevision(db);
    return explorationApiView(promoted);
  } catch (error) {
    if (error instanceof SubscriptionModelError) {
      const missing = error.message === 'No such prompt' || error.message === 'No such intent';
      throw new ApiError(missing ? 404 : 409, missing ? 'not_found' : 'conflict', error.message);
    }
    throw error;
  }
}

/**
 * Parse the shared subscription run selection fields. This keeps preview and run
 * requests byte-for-byte aligned so the quote cannot describe a different target set
 * from the confirmed request.
 *
 * @param {Record<string, unknown>} body
 * @returns {{surfaces?:string[], lane?:'tracking'|'exploration', promptIds?:number[], samples?:number, targetCeiling?:number}}
 */
function subscriptionSelection(body) {
  const rawSurfaces = strList(body.surfaces, 'surfaces');
  const surfaces = rawSurfaces === undefined ? undefined : rawSurfaces.filter((surface) => surface !== '');
  const laneValue = str(body.lane, 'lane', { max: 20 });
  if (laneValue !== undefined && laneValue !== 'tracking' && laneValue !== 'exploration') {
    throw new ApiError(422, 'unprocessable', 'lane must be tracking or exploration');
  }
  const rawPromptIds = body.prompt_ids;
  let promptIds;
  if (rawPromptIds !== undefined && rawPromptIds !== null) {
    if (!Array.isArray(rawPromptIds)) throw new ApiError(422, 'unprocessable', 'prompt_ids must be an array of positive integers');
    promptIds = rawPromptIds.map((value, index) => {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) throw new ApiError(422, 'unprocessable', `prompt_ids[${index}] must be a positive integer`);
      return id;
    });
  }
  const sampleValue = body.samples;
  let samples;
  if (sampleValue !== undefined && sampleValue !== null) {
    const number = Number(sampleValue);
    if (!Number.isInteger(number) || number < 1 || number > 10) throw new ApiError(422, 'unprocessable', 'samples must be an integer between 1 and 10');
    samples = number;
  }
  const ceilingValue = body.target_ceiling;
  let targetCeiling;
  if (ceilingValue !== undefined && ceilingValue !== null) {
    const number = Number(ceilingValue);
    if (!Number.isInteger(number) || number < 1 || number > 100000) throw new ApiError(422, 'unprocessable', 'target_ceiling must be an integer between 1 and 100000');
    targetCeiling = number;
  }
  return {
    surfaces,
    lane: /** @type {'tracking'|'exploration'|undefined} */ (laneValue),
    promptIds,
    samples,
    targetCeiling,
  };
}

/** @param {ReturnType<typeof subscriptionPreview>} preview */
function previewBody(preview) {
  return {
    lane: preview.lane,
    surfaces: preview.surfaces,
    prompts: preview.prompts.map((prompt) => ({
      id: prompt.promptId,
      text: prompt.promptText,
      origin: prompt.promptOrigin,
      lane: prompt.lane,
    })),
    samples: preview.samples,
    totalTargets: preview.totalTargets,
    perSurface: preview.perSurface,
    firstUseSurfaces: preview.firstUseSurfaces,
    estimatedCost: preview.estimatedCost,
    usageModel: preview.usageModel,
    quoteId: preview.quoteId,
    executionBudgets: preview.executionBudgets,
  };
}

/** @param {string} quoteId @param {Record<string, unknown>} fields @param {number} ceiling */
function scheduleQuoteId(quoteId, fields, ceiling) {
  return stableIdentity({ kind: 'subscription-schedule-v1', quoteId, fields, ceiling, consentVersion: SCHEDULE_CONSENT_VERSION });
}

/** @param {unknown} error @returns {never} */
function mapSubscriptionError(error) {
  if (error instanceof DemoModeError) throw new ApiError(400, 'demo_mode', error.message);
  if (error instanceof SubscriptionConfirmationError) {
    throw new ApiError(409, 'subscription_confirmation_required', error.message);
  }
  if (error instanceof SubscriptionRunError) {
    throw new ApiError(error.code === 'already_running' ? 409 : 400, error.code, error.message);
  }
  throw error;
}

/**
 * `POST /api/subscription/preview` — allowance-only preview. It never probes a CLI
 * or starts a model request.
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function previewSubscription({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on — subscription agent calls are disabled.');
  try {
    return previewBody(subscriptionPreview({ db, config, ...subscriptionSelection(asObject(ctx.body)) }));
  } catch (error) {
    return mapSubscriptionError(error);
  }
}

/**
 * `POST /api/subscription/run` — quote until first-use allowance consent, then accept
 * the run asynchronously. The CLI never receives provider API keys from this layer.
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {Promise<WithStatus>}
 */
async function startSubscription({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on — subscription agent calls are disabled.');
  const body = asObject(ctx.body);
  const selection = subscriptionSelection(body);
  let preview;
  try {
    preview = subscriptionPreview({ db, config, ...selection });
  } catch (error) {
    return mapSubscriptionError(error);
  }
  const needsConfirmation = preview.firstUseSurfaces.length > 0 && body.confirm !== true;
  if (needsConfirmation) {
    return new WithStatus(200, { status: 'quote_required', ...previewBody(preview), confirmHint: 'POST /api/subscription/run with the same selection, quote_id, and {"confirm":true} to start' });
  }
  if (body.confirm === true && preview.firstUseSurfaces.length > 0 && body.quote_id === undefined) {
    return new WithStatus(200, { status: 'quote_required', ...previewBody(preview), confirmHint: 'Confirm this quote_id to start' });
  }
  if (body.quote_id !== undefined && body.quote_id !== preview.quoteId) {
    throw new ApiError(409, 'stale_quote', 'The subscription selection or execution settings changed; preview the run again.');
  }
  const running = get(db, "SELECT id, done_calls, total_calls FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  if (running) throw new ApiError(409, 'already_running', `Run ${running.id} in progress: ${running.done_calls}/${running.total_calls} calls done`);
  /** @type {number|null} */
  let runId = null;
  /** @type {(runId:number)=>void} */
  let resolveRunCreated;
  /** @type {(error:unknown)=>void} */
  let rejectRunCreated;
  const runCreated = new Promise((resolve, reject) => {
    resolveRunCreated = resolve;
    rejectRunCreated = reject;
  });
  const promise = runSubscriptionPanel({
    db,
    config,
    ...selection,
    confirm: body.confirm === true,
    trigger: 'manual',
    onRunCreated: (createdRunId, controller) => {
      runId = createdRunId;
      controllersFor(db).set(createdRunId, controller);
      resolveRunCreated(createdRunId);
    },
  });
  const cleanupController = () => {
    if (runId === null) return;
    const controllers = subscriptionControllers.get(db);
    controllers?.delete(runId);
  };
  promise.then(
    cleanupController,
    (error) => {
      cleanupController();
      if (runId === null) {
        rejectRunCreated(error);
        return;
      }
      if (error instanceof SubscriptionConfirmationError || error instanceof SubscriptionRunError || error instanceof DemoModeError) return;
      process.stderr.write(`[hearsay] subscription run failed: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  );
  let started;
  try {
    started = await runCreated;
  } catch (error) {
    mapSubscriptionError(error);
  }
  return new WithStatus(202, {
    runId: Number(started),
    ...previewBody(preview),
  });
}

/**
 * Request cancellation of an accepted in-process subscription run. API runs and
 * scheduled worker runs are intentionally outside this handle map.
 *
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {WithStatus}
 */
function cancelSubscription({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on — subscription agent calls are disabled.');
  const runId = idParam(ctx.params.id);
  const row = get(
    db,
    `SELECT r.id, r.status
       FROM runs r
      WHERE r.id = ?
        AND r.trigger = 'manual'
        AND EXISTS (SELECT 1 FROM responses s WHERE s.run_id = r.id AND s.surface IN ('codex-agent', 'claude-code-agent'))`,
    [runId],
  );
  if (!row) throw new ApiError(404, 'not_found', 'No such subscription run');
  if (String(row.status) !== 'running') throw new ApiError(409, 'run_not_running', `Subscription run ${runId} is already ${row.status}`);
  const controller = subscriptionControllers.get(db)?.get(runId);
  if (!controller) throw new ApiError(409, 'not_cancellable', 'This subscription run is not controlled by the current Hearsay process');
  controller.abort();
  return new WithStatus(202, { status: 'cancellation_requested', runId });
}

/**
 * @param {Record<string, unknown>} body
 * @returns {{runAt:string,timeZone:string,graceMinutes:number}}
 */
function subscriptionScheduleFields(body) {
  const runAt = str(body.run_at ?? body.runAt, 'run_at', { max: 5, required: true });
  const timeZone = str(body.timezone ?? body.time_zone ?? body.timeZone, 'timezone', { max: 80, required: true });
  const rawGrace = body.grace_minutes ?? body.graceMinutes;
  const graceMinutes = rawGrace === undefined || rawGrace === null ? DEFAULT_SUBSCRIPTION_GRACE_MINUTES : Number(rawGrace);
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 1440) {
    throw new ApiError(422, 'unprocessable', 'grace_minutes must be an integer between 0 and 1440');
  }
  return {
    runAt: /** @type {string} */ (runAt),
    timeZone: /** @type {string} */ (timeZone),
    graceMinutes,
  };
}

/** @param {string[]} surfaces @param {import('node:sqlite').DatabaseSync} db */
function requireVerifiedSubscriptionSurfaces(surfaces, db) {
  for (const surface of surfaces) {
    const row = get(
      db,
      `SELECT 1 AS hit
         FROM responses r
         JOIN runs run ON run.id = r.run_id
        WHERE r.surface = ?
          AND run.trigger = 'manual'
          AND r.target_status = 'completed'
          AND r.comparability_status = 'comparable'
          AND r.web_status = 'verified'
       LIMIT 1`,
      [surface],
    );
    if (!row) throw new ApiError(409, 'schedule_prerequisite_missing', `${surface} needs one completed verified on-demand run before scheduling`);
  }
}

/**
 * `POST /api/subscription/schedule` — explicit persistent schedule consent. The
 * first response is a quote; only the confirmed response writes the schedule.
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {WithStatus|Record<string, unknown>}
 */
function configureSubscriptionSchedule({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on — subscription agent calls are disabled.');
  const body = asObject(ctx.body);
  const selection = subscriptionSelection(body);
  if (selection.surfaces === undefined || selection.surfaces.length === 0) {
    throw new ApiError(422, 'unprocessable', 'surfaces is required for a subscription schedule');
  }
  const fields = subscriptionScheduleFields(body);
  let preview;
  try {
    preview = subscriptionPreview({ db, config, ...selection });
  } catch (error) {
    return mapSubscriptionError(error);
  }
  if (selection.targetCeiling === undefined) {
    throw new ApiError(422, 'unprocessable', 'target_ceiling is required for a subscription schedule');
  }
  if (selection.targetCeiling < preview.totalTargets) {
    throw new ApiError(422, 'schedule_budget_exceeded', `target_ceiling ${selection.targetCeiling} is below the current ${preview.totalTargets} targets`);
  }
  const quoteId = scheduleQuoteId(preview.quoteId, fields, selection.targetCeiling);
  if (body.confirm !== true) {
    return new WithStatus(200, {
      status: 'schedule_confirmation_required',
      ...previewBody(preview),
      runAt: fields.runAt,
      timeZone: fields.timeZone,
      targetCeiling: selection.targetCeiling,
      graceMinutes: fields.graceMinutes,
      consentVersion: SCHEDULE_CONSENT_VERSION,
      quoteId,
      confirmHint: 'POST /api/subscription/schedule with the same selection, quote_id, and {"confirm":true} to enable persistent scheduled allowance use',
    });
  }
  if (body.quote_id !== quoteId) {
    throw new ApiError(409, 'stale_quote', 'The schedule selection or execution settings changed; preview the schedule again.');
  }
  requireVerifiedSubscriptionSurfaces(selection.surfaces, db);
  try {
    const schedule = saveSubscriptionSchedule(db, {
      ...fields,
      surfaces: selection.surfaces,
      lane: selection.lane ?? 'tracking',
      promptIds: selection.promptIds ?? [],
      samples: selection.samples ?? config.subscriptionSamples,
      targetCeiling: selection.targetCeiling,
      consentVersion: SCHEDULE_CONSENT_VERSION,
      executionBudgetHash: stableIdentity(preview.executionBudgets),
    });
    return new WithStatus(201, schedule);
  } catch (error) {
    if (error instanceof SubscriptionScheduleError) throw new ApiError(422, 'unprocessable', error.message);
    throw error;
  }
}

/** @param {ApiDeps} deps @returns {Record<string, unknown>|null} */
function readSubscriptionSchedule({ db }) {
  return getSubscriptionSchedule(db);
}

/** @param {ApiDeps} deps @returns {Record<string, boolean>} */
function deleteSubscriptionSchedule({ db }) {
  return { disabled: disableSubscriptionSchedule(db) };
}

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function deletePrompt({ db }, ctx) {
  const id = idParam(ctx.params.id);
  if (!get(db, 'SELECT id FROM prompts WHERE id = ?', [id])) throw new ApiError(404, 'not_found', 'No such prompt');
  const responses = Number(get(db, 'SELECT COUNT(*) AS n FROM responses WHERE prompt_id = ?', [id])?.n ?? 0);
  if (responses > 0) {
    run(db, 'UPDATE prompts SET active = 0 WHERE id = ?', [id]);
    recordCurrentBenchmarkRevision(db);
    return { deactivated: true };
  }
  run(db, 'DELETE FROM prompts WHERE id = ?', [id]);
  recordCurrentBenchmarkRevision(db);
  return { deleted: true };
}

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {unknown}
 */
function patchIntent({ db }, ctx) {
  const id = idParam(ctx.params.id);
  if (!get(db, 'SELECT id FROM intents WHERE id = ?', [id])) throw new ApiError(404, 'not_found', 'No such intent');
  const body = asObject(ctx.body);
  const label = str(body.label, 'label', { max: 300 });
  if (label !== undefined) {
    const clash = get(db, 'SELECT id FROM intents WHERE label = ? AND id != ?', [label, id]);
    if (clash) throw new ApiError(409, 'conflict', 'An intent with that label already exists');
    run(db, 'UPDATE intents SET label = ? WHERE id = ?', [label, id]);
    recordCurrentBenchmarkRevision(db);
  }
  return listIntents(db).find((intent) => intent.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * Cost, suggestions, runs
 * ------------------------------------------------------------------ */

/**
 * `GET /api/cost/estimate` (§4.3, §10.3). `estUsd` is null — never a guess — when the
 * price table has no entry for a configured model (§19.6 #13).
 *
 * @param {Pick<ApiDeps, 'db'|'config'>} deps
 * @returns {{calls: number, estUsd: number|null, knownSubtotalUsd:number|null,
 *   costStatus:'known'|'partial'|'unavailable', unpriced:string[],
 *   perProvider: import('../../core/cost.js').ProviderEstimate[], hasUnboundedSearch:boolean, hasSearch:boolean,
 *   quoteId:string, executionBudgets:ReturnType<typeof apiExecutionBudget>[]}}
 */
export function costEstimate({ db, config }) {
  const prompts = activePromptCount(db);
  const enabled = config.enabledProviders;
  const executionBudgets = enabled.map(({ id }) => apiExecutionBudget(config, id));
  const quoteInput = {
    kind: 'api-run-v1', priceTableVersion: PRICE_TABLE_VERSION,
    prompts: all(db, 'SELECT id, intent_id, text, category, origin FROM prompts WHERE active = 1 ORDER BY id'),
    entities: all(db, 'SELECT id, name, aliases, domains, is_self FROM entities WHERE archived_at IS NULL ORDER BY id'),
    executionBudgets, samples: config.samples, concurrency: config.concurrency,
  };

  const estimate = estimateRunCost(
    { promptCount: prompts, samples: config.samples, providers: enabled.map(({ id, model }, index) =>
      ({ id, model, searchPolicy: config.apiSearchPolicies[id],
        searchCallLimitEnforced: executionBudgets[index].searchCallLimitEnforced })) },
    config.pricingEnv,
  );
  const quoteId = stableIdentity({ ...quoteInput,
    estimatedCosts: estimate.perProvider,
    costStatus: estimate.costStatus,
  });
  return {
    calls: estimate.calls,
    estUsd: estimate.estUsd,
    knownSubtotalUsd: estimate.knownSubtotalUsd,
    costStatus: estimate.costStatus,
    unpriced: estimate.unpriced,
    perProvider: estimate.perProvider,
    hasUnboundedSearch: estimate.hasUnboundedSearch,
    hasSearch: estimate.hasSearch,
    executionBudgets,
    quoteId,
  };
}

/**
 * Explicit consent to add web search to the existing daily API schedule.
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 */
function configureApiSearchSchedule({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on — API calls are disabled.');
  if (!hasEnabledApiSearch(config)) {
    throw new ApiError(422, 'unsupported_search_schedule', 'Enable a validated API web-search route first.');
  }
  const body = asObject(ctx.body);
  const targetCeiling = body.target_ceiling;
  if (!Number.isInteger(targetCeiling) || Number(targetCeiling) < 1) {
    throw new ApiError(422, 'unprocessable', 'target_ceiling must be a positive integer');
  }
  const estimate = costEstimate({ db, config });
  if (estimate.calls > Number(targetCeiling)) {
    throw new ApiError(422, 'schedule_budget_exceeded',
      `target_ceiling ${targetCeiling} is below the current ${estimate.calls} targets`);
  }
  const quoteId = apiScheduleQuoteId(config, estimate.quoteId, Number(targetCeiling));
  if (body.confirm !== true) {
    return new WithStatus(200, { status: 'schedule_confirmation_required',
      ...estimate, runAt: config.runAt, targetCeiling, consentVersion: API_SEARCH_SCHEDULE_CONSENT_VERSION,
      quoteId, confirmHint: 'POST /api/search-schedule with the same target_ceiling, quote_id, and {"confirm":true} to add web search to daily API runs' });
  }
  if (body.quote_id !== quoteId) {
    throw new ApiError(409, 'stale_quote', 'The schedule selection or execution settings changed; preview the schedule again.');
  }
  return new WithStatus(201, saveApiSearchSchedule(db, config, Number(targetCeiling)));
}

/** @param {ApiDeps} deps */
function readApiSearchSchedule({ db, config }) {
  return { schedule: getApiSearchSchedule(db), approved: apiSearchScheduleApproved(db, config) };
}

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {Promise<unknown>}
 */
async function suggestPrompts({ db }, ctx) {
  const body = asObject(ctx.body);
  const context = body.context === undefined ? body : asObject(body.context);
  const proposedBrand = body.brand === undefined || body.brand === null ? brandEntity(db) : asObject(body.brand);
  const proposedCompetitors = body.competitors === undefined
    ? listEntities(db).filter((e) => !e.is_self)
    : objectList(body.competitors, 'competitors');
  const args = {
    productJob: str(context.productJob, 'productJob', { max: 200 }) ?? str(body.category_hint, 'category_hint', { max: 200 }) ?? '',
    audience: str(context.audience, 'audience', { max: 200 }) ?? '',
    desiredConversion: str(context.desiredConversion, 'desiredConversion', { max: 200 }) ?? '',
    brand: proposedBrand,
    competitors: proposedCompetitors,
  };
  const pack = strict(/** @type {*} */ (suggest), 'starterPack', args);
  return { source: 'starter-pack', reason: 'zero-usage-local-draft', intents: /** @type {*} */ (pack)?.intents ?? pack };
}

/** @template T @param {() => T} action @returns {T} */
function draftAction(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof BenchmarkDraftError) throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

/** @param {ApiDeps} deps @param {import('../router.js').Ctx} ctx */
function createSetupDraft({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on.');
  const body = asObject(ctx.body);
  return draftAction(() => createDraft(db, body.payload));
}

/** @param {ApiDeps} deps @param {import('../router.js').Ctx} ctx */
function updateSetupDraft({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on.');
  const body = asObject(ctx.body);
  return draftAction(() => updateDraft(db, idParam(ctx.params.id), Number(body.revision), body.payload));
}

/** @param {ApiDeps} deps @param {import('../router.js').Ctx} ctx */
function reviewSetupDraft({ db, config }, ctx) {
  const result = draftAction(() => reviewDraft(db, idParam(ctx.params.id)));
  const count = result.projectedActiveQuestionCount;
  const apiCalls = count * config.samples * config.enabledProviders.length;
  const subscriptionCalls = count * config.subscriptionSamples * config.subscriptionSurfaces.length;
  return { ...result, apiCalls, subscriptionCalls, totalCalls: apiCalls + subscriptionCalls,
    hasRunRoute: config.enabledProviders.length + config.subscriptionSurfaces.length > 0 };
}

/** @param {ApiDeps} deps @param {import('../router.js').Ctx} ctx */
function approveSetupDraft({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on.');
  const body = asObject(ctx.body);
  if (body.approve !== true) throw new ApiError(422, 'review_required', 'Explicit approve: true is required');
  const receipt = draftAction(() => approveDraft(db, idParam(ctx.params.id), Number(body.revision), String(body.review_hash ?? '')));
  const activeIds = all(db, `SELECT id FROM prompts WHERE active = 1 AND tracking_state = 'tracking' ORDER BY id`)
    .map((row) => Number(row.id));
  let panelReady = false;
  try { assertReviewedSelection(db, activeIds); panelReady = true; }
  catch (error) { if (!(error instanceof BenchmarkDraftError)) throw error; }
  return { ...receipt, panelReady,
    reviewNext: panelReady ? null : '/prompts',
    continuityNotice: 'The next run uses a new benchmark revision; runs already queued keep their earlier question snapshots.' };
}

/** @param {ApiDeps} deps */
function activePanelReview({ db, config }) {
  const questions = all(db, `SELECT p.id, p.text, p.category, p.source_note, i.label AS intent
    FROM prompts p LEFT JOIN intents i ON i.id = p.intent_id
    WHERE p.tracking_state = 'tracking' AND p.active = 1 ORDER BY p.id`).map((row) => ({
    id: Number(row.id), text: String(row.text), category: String(row.category),
    intent: row.intent === null ? null : String(row.intent),
    sourceNote: row.source_note === null ? null : String(row.source_note),
  }));
  const entities = all(db, `SELECT id, name, aliases, domains, is_self FROM entities
    WHERE archived_at IS NULL ORDER BY id`).map((row) => ({
    id: Number(row.id), name: String(row.name), aliases: String(row.aliases),
    domains: String(row.domains), isSelf: Number(row.is_self) === 1,
  }));
  const count = questions.length;
  const apiCalls = count * config.samples * config.enabledProviders.length;
  const subscriptionCalls = count * config.subscriptionSamples * config.subscriptionSurfaces.length;
  return { reviewHash: stableIdentity({ questions, entities }), questions, entities,
    apiCalls, subscriptionCalls, totalCalls: apiCalls + subscriptionCalls,
    continuityNotice: 'Changing a question or entity starts a new benchmark revision at the next run. Earlier answer snapshots stay unchanged.' };
}

/** @param {ApiDeps} deps @param {import('../router.js').Ctx} ctx */
function approveActivePanel(deps, ctx) {
  const body = asObject(ctx.body);
  if (body.reviewed !== true) throw new ApiError(422, 'review_required', 'Review the exact active panel and submit reviewed: true');
  return transaction(deps.db, () => {
    const current = activePanelReview(deps);
    if (current.reviewHash !== body.review_hash) {
      throw new ApiError(409, 'stale_review', 'The active panel changed; review it again');
    }
    if (current.questions.length === 0) throw new ApiError(422, 'no_questions', 'Add at least one tracking question');
    for (const question of current.questions) draftAction(() => reviewTrackingPrompt(deps.db, question.id));
    return { reviewed: current.questions.length, reviewHash: current.reviewHash,
      continuityNotice: current.continuityNotice };
  });
}

const SETUP_CATEGORIES = PROMPT_CATEGORIES.includes('branded') ? PROMPT_CATEGORIES : [...PROMPT_CATEGORIES, 'branded'];

/**
 * `POST /api/setup` — SPEC §3.2 transactional bulk create/append, the backing
 * endpoint for the agent's hearsay_setup_tracking. Validate everything first,
 * then write everything in one transaction; 422 lists every problem with zero
 * writes. Never merges or renames — those stay UI actions (409s).
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {WithStatus|Record<string, unknown>}
 */
function setupTracking({ db, config }, ctx) {
  if (config.demo) throw new ApiError(400, 'demo_mode', 'Demo mode is on. Set HEARSAY_DEMO=0 to configure live tracking.');
  const body = asObject(ctx.body);
  const brand = body.brand === undefined ? null : asObject(body.brand);
  const competitors = objectList(body.competitors, 'competitors');
  const intents = objectList(body.intents, 'intents');
  if (intents.length > 0 && body.reviewed !== true) {
    throw new ApiError(422, 'review_required', 'Review every exact question and submit reviewed: true');
  }
  if (brand === null && competitors.length === 0 && intents.length === 0) {
    throw new ApiError(422, 'nothing_to_do', 'Provide at least one of brand, competitors, intents');
  }

  // 409 pre-checks (SPEC §3.2) — before field validation.
  const existingBrand = get(db, 'SELECT id, name FROM entities WHERE is_self = 1 AND archived_at IS NULL');
  if (brand !== null && existingBrand && String(existingBrand.name).toLowerCase() !== String(brand.name ?? '').trim().toLowerCase()) {
    throw new ApiError(409, 'brand_exists', `Brand is "${existingBrand.name}" — changing the brand is destructive; use the web UI.`);
  }
  if (brand !== null && !existingBrand) {
    const clash = get(db, 'SELECT id FROM entities WHERE name = ? COLLATE NOCASE', [String(brand.name ?? '').trim()]);
    if (clash) throw new ApiError(409, 'entity_exists', 'That name already exists as a competitor — promoting it to brand is a web-UI action.');
  }

  // Validate everything, then write everything (all-or-nothing).
  /** @type {{path: string, message: string}[]} */
  const errors = [];
  /** @param {string} path @param {() => void} fn */
  const check = (path, fn) => {
    try {
      fn();
    } catch (err) {
      errors.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  };
  const seenDomains = new Set();
  /** @param {Record<string, unknown>} e @param {string} path */
  const validateEntity = (e, path) => {
    check(`${path}.name`, () => str(e.name, 'name', { max: 120, required: true }));
    check(`${path}.aliases`, () => checkAliases(strList(e.aliases, 'aliases') ?? []));
    check(`${path}.domains`, () => {
      const ds = (strList(e.domains, 'domains') ?? []).map(normaliseDomain).filter((d) => d !== '');
      for (const d of ds) {
        if (seenDomains.has(d)) throw new ApiError(422, 'unprocessable', `Domain ${d} appears twice in this payload`);
        seenDomains.add(d);
      }
      // A rerun re-sends domains that already belong to the same-named (soon to be
      // dedupe-skipped) entity — except that entity, or reruns would 422.
      const own = get(db, 'SELECT id FROM entities WHERE name = ? COLLATE NOCASE', [String(e.name ?? '').trim()]);
      assertDomainsFree(db, ds, own ? Number(own.id) : null);
    });
  };
  if (brand !== null) validateEntity(brand, 'brand');
  competitors.forEach((c, i) => validateEntity(c, `competitors[${i}]`));
  const seenQuestions = new Set();
  intents.forEach((intent, i) => {
    check(`intents[${i}].label`, () => str(intent.label, 'label', { max: 300, required: true }));
    check(`intents[${i}].category`, () => {
      const cat = str(intent.category, 'category', { max: 40 }) ?? 'general';
      if (!SETUP_CATEGORIES.includes(cat)) throw new ApiError(422, 'unprocessable', `category must be one of: ${SETUP_CATEGORIES.join(', ')}`);
    });
    const ps = strList(intent.paraphrases, `intents[${i}].paraphrases`) ?? [];
    if (ps.length === 0) errors.push({ path: `intents[${i}].paraphrases`, message: 'each intent needs at least one paraphrase' });
    ps.forEach((p, j) => check(`intents[${i}].paraphrases[${j}]`, () => {
      const text = /** @type {string} */ (str(p, 'paraphrase', { max: 300, required: true }));
      draftAction(() => validateTrackingQuestion(text));
      const key = text.replace(/\s+/gu, ' ').toLocaleLowerCase();
      if (seenQuestions.has(key)) throw new ApiError(422, 'duplicate_question', 'Duplicate paraphrase in this setup');
      seenQuestions.add(key);
    }));
  });
  if (errors.length > 0) {
    return new WithStatus(422, { error: { code: 'validation', message: `${errors.length} problem(s) — nothing was saved` }, errors });
  }

  // Apply.
  const created = { entities: 0, intents: 0, prompts: 0 };
  /** @type {{type: string, value: string, reason: string}[]} */
  const skipped = [];
  /** @type {string[]} */
  const retagged = [];
  /** @type {number[]} */
  const reviewedPromptIds = [];
  transaction(db, () => {
    /** @param {Record<string, unknown>} e @param {boolean} isSelf */
    const ensureEntity = (e, isSelf) => {
      const name = /** @type {string} */ (str(e.name, 'name', { max: 120, required: true }));
      if (get(db, 'SELECT id FROM entities WHERE name = ? COLLATE NOCASE', [name])) {
        skipped.push({ type: 'entity', value: name, reason: 'exists' });
        return;
      }
      const result = run(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, ?, ?)', [
        name,
        JSON.stringify(checkAliases(strList(e.aliases, 'aliases') ?? [])),
        JSON.stringify((strList(e.domains, 'domains') ?? []).map(normaliseDomain).filter((d) => d !== '')),
        isSelf ? 1 : 0,
        isoNow(),
      ]);
      if (isSelf) makeSelf(db, result.lastInsertRowid);
      created.entities += 1;
    };
    if (brand !== null) ensureEntity(brand, true);
    for (const c of competitors) ensureEntity(c, false);

    const brandRow = brandEntity(db);
    const brandAliases = brandRow === null ? [] : aliasesFor(brandRow);
    for (const intent of intents) {
      const label = /** @type {string} */ (str(intent.label, 'label', { max: 300, required: true }));
      let intentId = Number(get(db, 'SELECT id FROM intents WHERE label = ?', [label])?.id ?? 0);
      if (intentId === 0) {
        intentId = Number(run(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', [label, isoNow()]).lastInsertRowid);
        created.intents += 1;
      }
      const category = str(intent.category, 'category', { max: 40 }) ?? 'general';
      for (const raw of strList(intent.paraphrases, 'paraphrases') ?? []) {
        const text = /** @type {string} */ (str(raw, 'paraphrase', { max: 300, required: true }));
        if (get(db, 'SELECT id FROM prompts WHERE text = ?', [text])) {
          skipped.push({ type: 'prompt', value: text, reason: 'duplicate' });
          reviewedPromptIds.push(Number(get(db, 'SELECT id FROM prompts WHERE text = ?', [text])?.id));
          continue;
        }
        // SOV-denominator invariant (SPEC §3.2): brand-name prompts are always 'branded'.
        const isBranded = brandAliases.length > 0 && mentionsBrandWord(text, brandAliases);
        if (isBranded && category !== 'branded') retagged.push(text);
        const inserted = run(db, `INSERT INTO prompts(
          intent_id, text, category, active, created_at, tracking_state, origin, approved_at
        ) VALUES(?, ?, ?, 1, ?, 'tracking', 'user_authored', ?)`, [
          intentId,
          text,
          isBranded ? 'branded' : category,
          isoNow(),
          isoNow(),
        ]);
        reviewedPromptIds.push(Number(inserted.lastInsertRowid));
        created.prompts += 1;
      }
    }
    for (const promptId of reviewedPromptIds) draftAction(() => reviewTrackingPrompt(db, promptId));
    recordCurrentBenchmarkRevision(db);
  });

  return {
    created,
    skipped,
    retagged_branded: retagged,
    config: {
      entities: listEntities(db).length,
      intents: Number(get(db, 'SELECT COUNT(*) AS n FROM intents')?.n ?? 0),
      activePrompts: activePromptCount(db),
    },
  };
}

/**
 * SPEC §3.3: demo → 400; running → 409 with progress; over-threshold or unknown
 * cost without confirm → 200 quote; otherwise start → 202. The gate lives here so
 * UI, curl, and MCP are protected identically (§4.3, §19.6 #13).
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {Promise<WithStatus>}
 */
async function startRun({ db, config }, ctx) {
  if (config.demo) {
    throw new ApiError(400, 'demo_mode', 'Demo mode is on, so live provider calls are disabled. Set HEARSAY_DEMO=0.');
  }
  // With zero providers a "run" would be an empty 0-call row finalised as 'done' —
  // which later shadows the last genuine run when alerts pick their prior runs.
  if (config.enabledProviders.length === 0) {
    throw new ApiError(400, 'no_providers', 'No provider API keys configured — add one to .env to run a panel');
  }
  const running = get(db, "SELECT id, done_calls, total_calls FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  if (running) {
    throw new ApiError(409, 'already_running', `Run ${running.id} in progress: ${running.done_calls}/${running.total_calls} calls done`);
  }
  if (typeof (/** @type {*} */ (runner).runPanel) !== 'function') throw new NotReadyError('runPanel');
  const activeIds = all(db, `SELECT id FROM prompts WHERE active = 1 AND tracking_state = 'tracking' ORDER BY id`)
    .map((row) => Number(row.id));
  assertReviewedSelection(db, activeIds);

  // Callers always send a JSON body ({} at minimum) — the router 415s non-JSON POSTs.
  const body = ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? /** @type {Record<string, unknown>} */ (ctx.body) : {};
  const confirm = body.confirm === true;
  const estimate = costEstimate({ db, config });
  const needsQuote = estimate.hasSearch || config.confirmUsd === 0 ||
    estimate.estUsd === null || estimate.estUsd > config.confirmUsd || estimate.calls > 200;
  if (needsQuote && (!confirm || body.quote_id === undefined)) {
    return new WithStatus(200, {
      status: 'quote_required',
      calls: estimate.calls,
      estUsd: estimate.estUsd,
      knownSubtotalUsd: estimate.knownSubtotalUsd,
      costStatus: estimate.costStatus,
      unpriced: estimate.unpriced,
      perProvider: estimate.perProvider,
      hasUnboundedSearch: estimate.hasUnboundedSearch,
      hasSearch: estimate.hasSearch,
      executionBudgets: estimate.executionBudgets,
      quoteId: estimate.quoteId,
      confirmHint: 'POST /api/run with this quote_id and {"confirm":true} to start',
    });
  }
  if (body.quote_id !== undefined && body.quote_id !== estimate.quoteId) {
    throw new ApiError(409, 'stale_quote', 'The API selection or execution settings changed; preview the run again.');
  }

  // 202: the run is accepted, not finished. Progress is read from /api/runs/latest.
  const before = Number(get(db, 'SELECT COALESCE(MAX(id), 0) AS id FROM runs')?.id ?? 0);
  const promise = Promise.resolve(/** @type {*} */ (runner).runPanel({ db, config, trigger: 'api' }));
  promise.catch((err) => {
    process.stderr.write(`[hearsay] run failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
  // The run row appears a few ticks after firing; a fast run may even be 'done'
  // already. Briefly poll for the new row (any status) instead of sampling one tick.
  let started = null;
  for (let i = 0; i < 100 && !started; i += 1) {
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 10);
    });
    started = get(db, 'SELECT id FROM runs WHERE id > ? ORDER BY id DESC LIMIT 1', [before]);
  }
  return new WithStatus(202, { runId: started ? Number(started.id) : null,
    estUsd: estimate.estUsd, costStatus: estimate.costStatus });
}

/**
 * `GET /api/status` — SPEC §3.1 orientation endpoint; must work on an empty DB
 * (unlike /api/summary, which presumes a configured brand). Never includes key
 * material in any form (§19.6 #9): providers are re-shaped to four safe fields.
 * @param {ApiDeps} deps
 * @returns {unknown}
 */
function statusReport({ db, config, version }) {
  const brand = brandEntity(db);
  const activePrompts = activePromptCount(db);
  const activeIds = all(db, `SELECT id FROM prompts WHERE active = 1 AND tracking_state = 'tracking' ORDER BY id`)
    .map((row) => Number(row.id));
  let panelReviewed = false;
  try { assertReviewedSelection(db, activeIds); panelReviewed = true; }
  catch (error) { if (!(error instanceof BenchmarkDraftError)) throw error; }
  /** @type {{totalUsd:number|null,knownSubtotalUsd:number|null,
   * costStatus:'known'|'partial'|'unavailable'}|null} */
  const spend = soft(/** @type {*} */ (metrics), 'actualSpend', { db, days: 30, now: isoNow() }, null);
  return {
    version,
    demo: config.demo,
    configured: brand !== null && activePrompts > 0 && (panelReviewed || config.demo),
    reviewNeeded: !config.demo && activePrompts > 0 && !panelReviewed,
    providers: PROVIDER_IDS.map((id) => {
      const p = config.providers[id];
      return { id: p.id, label: p.label, model: p.model, enabled: p.enabled };
    }),
    surfaces: SURFACE_IDS.map((surface) => {
      const isAgent = surface.endsWith('-agent');
      const providerId = surface.replace(/-api$/, '');
      const provider = isAgent ? null : config.providers[/** @type {import('../../core/config.js').ProviderId} */ (providerId)];
      return {
        id: surface,
        label: surfaceLabel(surface),
        kind: isAgent ? 'subscription' : 'api',
        enabled: isAgent
          ? config.subscriptionSurfaces.includes(
              /** @type {'codex-agent'|'claude-code-agent'} */ (surface),
            )
          : Boolean(provider?.enabled),
      };
    }),
    counts: {
      entities: listEntities(db).length,
      intents: Number(get(db, 'SELECT COUNT(*) AS n FROM intents')?.n ?? 0),
      activePrompts,
    },
    schedule: {
      runAt: config.runAt,
      schedulerEnabled: !config.demo && (config.enabledProviders.length > 0 ||
        config.subscriptionSurfaces.length > 0 && getSubscriptionSchedule(db) !== null),
      subscription: getSubscriptionSchedule(db),
    },
    trackingHealth: trackingHealth({ db, config }),
    subscription: {
      surfaces: config.subscriptionSurfaces.map((surface) => ({
        id: surface,
        label: surfaceLabel(surface),
        enabled: true,
        optedIn: getSetting(db, SETTING_KEYS.SUBSCRIPTION_SURFACE_OPT_IN, /** @type {string[]} */ ([])).includes(surface),
      })),
      samples: config.subscriptionSamples,
      concurrency: config.subscriptionConcurrency,
      usageModel: 'included_plan_allowance_or_overage',
    },
    lastRun: latestRun(db),
    spend30dUsd: spend?.totalUsd ?? null,
    spend30dKnownSubtotalUsd: spend?.knownSubtotalUsd ?? null,
    spend30dCostStatus: spend?.costStatus ?? 'unavailable',
  };
}

/* ------------------------------------------------------------------ *
 * Summary (§10.4)
 * ------------------------------------------------------------------ */

/**
 * @param {ApiDeps} deps
 * @param {number} days
 * @param {string|undefined} [surface]
 * @returns {unknown}
 */
export function summary({ db, config }, days, surface) {
  const brand = brandEntity(db);
  const brandId = brand?.id ?? null;
  // One clock for the whole summary — §7 refuses to default it (§19.6 #6), and every
  // window in one response has to be measured from the same instant to be comparable.
  const now = isoNow();
  /** @param {string} name @param {Record<string, unknown>} args */
  const need = (name, args) => strict(/** @type {*} */ (metrics), name, { db, now, ...(surface ? { surface } : {}), ...args });

  const current = /** @type {{entityId:number,name:string,isSelf:boolean,mentions:number,sov:number}[]} */ (
    need('shareOfVoice', { days })
  );
  const sov7 = /** @type {typeof current} */ (need('shareOfVoice', { days: 7 }));
  const sov14 = /** @type {typeof current} */ (need('shareOfVoice', { days: 14 }));

  /** @param {typeof current} rows */
  const brandShare = (rows) => {
    const total = rows.reduce((sum, row) => sum + Number(row.mentions ?? 0), 0);
    const mine = rows.find((row) => row.entityId === brandId);
    return total > 0 && mine ? { n: total, k: Number(mine.mentions ?? 0) } : null;
  };
  const now7 = brandShare(sov7);
  const now14 = brandShare(sov14);
  const delta7d =
    now7 === null || now14 === null || now14.n - now7.n <= 0 || now7.n <= 0
      ? null
      : now7.k / now7.n - (now14.k - now7.k) / (now14.n - now7.n);

  const mention = brandId === null ? null : need('mentionRate', { entityId: brandId, days });
  const rec = /** @type {{n:number,recommended:number,p:number|null}|null} */ (
    brandId === null ? null : need('recommendationRate', { entityId: brandId, days })
  );
  const providers = need('providerBreakdown', { days });
  const run_ = latestRun(db);

  return {
    brand: brand === null ? null : { id: brand.id, name: brand.name },
    windowDays: days,
    generatedAt: now,
    demo: config.demo,
    sov: { current, delta7d },
    mentionRate: mention,
    recommendationRate: rec === null ? null : { p: rec.p, n: rec.n, method: 'legacy_heuristic' },
    providers,
    openAlerts: Number(get(db, 'SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0')?.n ?? 0),
    lastRun: run_ === null ? null : { finishedAt: run_.finished_at, status: run_.status },
  };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {URL} url @param {string} now */
function selectedSeries(db, url, now) {
  const days = intQuery(url, 'days', DEFAULT_DAYS, 1, 3650);
  const seriesId = url.searchParams.get('series_id');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  if ((start === null) !== (end === null)) {
    throw new ApiError(400, 'bad_request', 'start and end must be supplied together');
  }
  if (start !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(end ?? '') ||
      !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end ?? '')) || start >= (end ?? ''))) {
    throw new ApiError(400, 'bad_request', 'start and end must be ordered UTC timestamps');
  }
  const range = start === null ? {} : { start, end: /** @type {string} */ (end) };
  try {
    return { days, series: resolveMeasurementSeries(db, { now, days,
      seriesId: seriesId || undefined, ...range }), range };
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError(404, 'series_not_found', error.message);
    throw error;
  }
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Record<string, unknown>} selection */
function selectedOpportunitySeries(db, selection) {
  const url = new URL('http://localhost/api/opportunities');
  for (const key of ['series_id', 'start', 'end']) {
    const value = str(selection[key], key, { max: 128, required: true });
    url.searchParams.set(key, /** @type {string} */ (value));
  }
  const { series } = selectedSeries(db, url, isoNow());
  if (!series) throw new ApiError(404, 'series_not_found', 'No such series in this window');
  return series;
}

/** @param {unknown} value @param {string} name */
function opportunityId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(422, 'unprocessable', `${name} must be a positive integer`);
  }
  return id;
}

/** @param {unknown} value @param {string} name */
function opportunityIds(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(422, 'unprocessable', `${name} must be an array`);
  return [...new Set(value.map((item) => opportunityId(item, name)))];
}

/** @param {unknown} value */
function optionalHours(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return Number(value);
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Record<string, unknown>} body */
function opportunityEvidence(db, body) {
  if (body.evidence !== undefined) {
    const records = objectList(body.evidence, 'evidence');
    const responseIds = new Set();
    const queryIds = new Set();
    const sourceIds = new Set();
    const citationIds = new Set();
    for (const item of records) {
      const responseId = opportunityId(item.response_id, 'evidence.response_id');
      responseIds.add(responseId);
      for (const [field, table, output] of /** @type {[string,string,Set<number>][]} */ ([
        ['query_id', 'search_queries', queryIds],
        ['source_id', 'source_observations', sourceIds],
        ['citation_id', 'answer_citations', citationIds],
      ])) {
        if (item[field] === undefined) continue;
        const id = opportunityId(item[field], `evidence.${field}`);
        if (Number(get(db, `SELECT response_id FROM ${table} WHERE id = ?`, [id])?.response_id) !== responseId) {
          throw new ApiError(422, 'unprocessable', `evidence.${field} does not belong to response #${responseId}`);
        }
        output.add(id);
      }
    }
    return { responseIds: [...responseIds], queryIds: [...queryIds],
      sourceIds: [...sourceIds], citationIds: [...citationIds] };
  }
  return { responseIds: opportunityIds(body.response_ids, 'response_ids'),
    queryIds: opportunityIds(body.query_ids, 'query_ids'),
    sourceIds: opportunityIds(body.source_ids, 'source_ids'),
    citationIds: opportunityIds(body.citation_ids, 'citation_ids') };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {URL} url */
function exactSeriesSummary(db, url) {
  const now = isoNow();
  const { days, series } = selectedSeries(db, url, now);
  if (series === null) return { selectedSeriesId: null, series: null, windowDays: days,
    brand: brandEntity(db), mentionRate: null, recommendationRate: null,
    shareOfVoice: [], providers: [], coverage: null };
  const brand = brandEntity(db);
  const options = { series, now, start: series.start, end: series.end };
  const mentionRate = brand === null ? null : metrics.mentionRate(db, { ...options, entityId: brand.id });
  const recommendationRate = brand === null ? null
    : series.analysisRevision && series.analysisRevision !== 'legacy-heuristic-v1'
      ? stanceRecommendationRate(db, { ...options, entityId: brand.id,
        analysisRevision: series.analysisRevision })
      : metrics.recommendationRate(db, { ...options, entityId: brand.id });
  return {
    selectedSeriesId: series.id, series, windowDays: days,
    brand: brand === null ? null : { id: brand.id, name: brand.name },
    coverage: { attemptedTargets: series.attemptedTargets, completeAnswers: series.completeAnswers,
      comparableAnswers: series.comparableAnswers, verifiedSearchAnswers: series.verifiedSearchAnswers,
      queryMetadataAnswers: series.queryMetadataAnswers,
      metricEligibleAnswers: mentionRate?.n ?? 0 },
    mentionRate,
    evidenceIncidence: brand === null ? null : metrics.evidenceIncidence(db, { ...options, entityId: brand.id }),
    recommendationRate,
    shareOfVoice: metrics.shareOfVoice(db, options),
    providers: metrics.providerBreakdown(db, options),
  };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {URL} url
 * @param {'intentTable'|'promptTable'|'citationGap'} name @param {Record<string,unknown>} [extra] */
function metricResult(db, url, name, extra = {}) {
  const now = isoNow();
  const days = intQuery(url, 'days', DEFAULT_DAYS, 1, 3650);
  const seriesId = url.searchParams.get('series_id');
  if (!seriesId && (url.searchParams.has('start') || url.searchParams.has('end'))) {
    throw new ApiError(400, 'bad_request', 'start and end require series_id');
  }
  if (!seriesId) return strict(/** @type {*} */ (metrics), name, {
    db, now, days, surface: surfaceQuery(url), ...extra,
  });
  const { series } = selectedSeries(db, url, now);
  if (!series) throw new ApiError(404, 'series_not_found', 'No series in this window');
  const results = strict(/** @type {*} */ (metrics), name, {
    db, now, start: series.start, end: series.end, series, ...extra,
  });
  return { selectedSeriesId: series.id, series, results };
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Wrap a handler so thrown `ApiError`/`NotReadyError` become the §10.3 envelope and
 * anything else becomes a 500 with no internals in it (§19.6 #9).
 *
 * @param {(ctx: import('../router.js').Ctx) => unknown} handler
 * @param {number} [okStatus]
 * @returns {import('../router.js').Handler}
 */
function json(handler, okStatus = 200) {
  return async (ctx) => {
    try {
      const data = await handler(ctx);
      if (ctx.res.writableEnded) return;
      if (data instanceof WithStatus) {
        sendJson(ctx.res, data.status, data.body);
        return;
      }
      sendJson(ctx.res, okStatus, data);
    } catch (err) {
      if (err instanceof ApiError) {
        sendError(ctx, err.status, err.message, {}, err.code);
        return;
      }
      if (err instanceof BenchmarkDraftError) {
        sendError(ctx, err.status, err.message, {}, err.code);
        return;
      }
      if (err instanceof OpportunityError) {
        sendError(ctx, err.status, err.message, {}, err.code);
        return;
      }
      if (err instanceof WeeklyReviewError || err instanceof OutcomeError) {
        sendError(ctx, err.status, err.message, {}, err.code);
        return;
      }
      if (err instanceof NotReadyError) {
        sendError(ctx, 503, `${err.fnName} is not available in this build yet`, {}, 'not_ready');
        return;
      }
      throw err;
    }
  };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {ApiDeps} deps
 * @returns {void}
 */
export function registerApiRoutes(router, deps) {
  const { db } = deps;

  /** @param {import('../router.js').Ctx} ctx */
  const weeklySelection = (ctx) => buildWeeklyReview(db, {
    seriesId: ctx.url.searchParams.get('series_id') ?? '',
    start: ctx.url.searchParams.get('start') ?? '',
    end: ctx.url.searchParams.get('end') ?? '', now: isoNow(),
  });
  router.add('GET', '/api/weekly-review', json((ctx) => weeklySelection(ctx)));
  router.add('GET', '/api/weekly-review/export', json((ctx) => {
    const report = weeklySelection(ctx);
    const format = ctx.url.searchParams.get('format');
    const name = `hearsay-weekly-review-${report.scope.start.slice(0, 10)}`;
    const headers = { 'Content-Disposition': `attachment; filename="${name}.${format === 'markdown' ? 'md' : format === 'html' ? 'html' : 'json'}"`,
      'Cache-Control': 'no-store' };
    if (format === 'json') {
      sendJson(ctx.res, 200, report, headers);
    } else if (format === 'markdown') {
      const body = renderWeeklyMarkdown(report);
      ctx.res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff', ...headers });
      ctx.res.end(body);
    } else if (format === 'html') {
      sendHtml(ctx.res, 200, renderWeeklyReviewExport(report), headers);
    } else {
      throw new ApiError(400, 'bad_request', 'format must be json, markdown, or html');
    }
  }));
  router.add('POST', '/api/outcomes', json((ctx) => {
    const body = asObject(ctx.body);
    return recordOutcome(db, { source: body.source, recordKey: body.record_key,
      periodStart: body.period_start, periodEnd: body.period_end,
      landingPage: body.landing_page, metricName: body.metric_name, value: body.value,
      unit: body.unit, currency: body.currency, attributionMethod: body.attribution_method,
      notes: body.notes, supersedesId: body.supersedes_id, author: body.author });
  }, 201));
  router.add('POST', '/api/outcomes/import', json((ctx) => {
    const body = asObject(ctx.body);
    const source = str(body.source, 'source', { max: 160, required: true });
    const importId = str(body.import_id, 'import_id', { max: 200, required: true });
    const author = str(body.author, 'author', { max: 120, required: true });
    if (typeof body.csv_text !== 'string') {
      throw new ApiError(422, 'unprocessable', 'csv_text must be a string');
    }
    return importOutcomeCsv(db, { source: /** @type {string} */ (source),
      importId: /** @type {string} */ (importId), csvText: body.csv_text,
      author: /** @type {string} */ (author) });
  }, 201));
  router.add('POST', '/api/ledger', json((ctx) => {
    const body = asObject(ctx.body);
    return recordLedgerEntry(db, { source: body.source, entryKey: body.entry_key,
      kind: body.kind, activity: body.activity, periodStart: body.period_start,
      periodEnd: body.period_end, minutes: body.minutes, amount: body.amount,
      currency: body.currency, notes: body.notes, opportunityId: body.opportunity_id,
      author: body.author });
  }, 201));
  router.add('GET', '/api/outcomes/export', json((ctx) => {
    const start = ctx.url.searchParams.get('start') ?? undefined;
    const end = ctx.url.searchParams.get('end') ?? undefined;
    const body = exportOutcomeCsv(db, { start, end });
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment; filename="hearsay-reported-outcomes.csv"',
      'Cache-Control': 'no-store' });
    ctx.res.end(body);
  }));

  router.add(
    'GET',
    '/api/summary',
    json((ctx) => summary(deps, intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 365), surfaceQuery(ctx.url))),
  );
  router.add('GET', '/api/series', json((ctx) => {
    const now = isoNow();
    const { days, series, range } = selectedSeries(db, ctx.url, now);
    return { windowDays: days, selectedSeriesId: series?.id ?? null,
      window: series ? { start: series.start, end: series.end, exclusiveEnd: true } : null,
      series: listMeasurementSeries(db, { now, days, ...range }) };
  }));
  router.add('GET', '/api/series/summary', json((ctx) => exactSeriesSummary(db, ctx.url)));
  router.add('GET', '/api/series/evidence', json((ctx) => {
    const { series } = selectedSeries(db, ctx.url, isoNow());
    if (!series) return { selectedSeriesId: null, series: null, intents: [], report: null };
    const intents = listEvidenceIntents(db, { series });
    const intentId = ctx.url.searchParams.has('intent_id')
      ? intQuery(ctx.url, 'intent_id', 0, 1, Number.MAX_SAFE_INTEGER) : null;
    if (intentId === null) return { selectedSeriesId: series.id, series, intents, report: null };
    const report = intentEvidenceReport(db, { series, intentId });
    if (!report) throw new ApiError(404, 'intent_not_found', 'No such intent in this series');
    return { selectedSeriesId: series.id, series, intents, report };
  }));
  router.add('GET', '/api/answers/:id/evidence', json((ctx) => {
    const { series } = selectedSeries(db, ctx.url, isoNow());
    if (!series) throw new ApiError(404, 'series_not_found', 'No series in this window');
    const detail = answerEvidence(db, { series, responseId: idParam(ctx.params.id) });
    if (!detail) throw new ApiError(404, 'answer_not_found', 'No such answer in this series');
    return { selectedSeriesId: series.id, series, answer: detail };
  }));
  router.add('GET', '/api/opportunities', json((ctx) => {
    const series = selectedOpportunitySeries(db, Object.fromEntries(ctx.url.searchParams));
    const intentId = ctx.url.searchParams.has('intent_id')
      ? opportunityId(ctx.url.searchParams.get('intent_id'), 'intent_id') : undefined;
    const intents = listEvidenceIntents(db, { series });
    if (intentId !== undefined && !intents.some((intent) => intent.id === intentId)) {
      throw new ApiError(404, 'intent_not_found', 'No such intent in this series');
    }
    const items = listOpportunities(db, { series,
      includeDismissed: ctx.url.searchParams.get('include_dismissed') === '1' });
    return { selectedSeriesId: series.id, series, intents,
      candidates: deriveOpportunityCandidates(db, { series, intentId }),
      opportunities: items.filter((item) => item.status !== 'pending'),
      pendingProposals: items.filter((item) => item.status === 'pending') };
  }));
  router.add('POST', '/api/opportunities/generate', json((ctx) => {
    const body = asObject(ctx.body);
    const series = selectedOpportunitySeries(db, body);
    const intentId = body.intent_id === undefined ? undefined : opportunityId(body.intent_id, 'intent_id');
    return { selectedSeriesId: series.id, series,
      opportunities: generateOpportunityCandidates(db, { series, intentId,
        candidateKey: str(body.candidate_key, 'candidate_key', { max: 64 }), now: isoNow() }) };
  }));
  router.add('GET', '/api/opportunities/:id', json((ctx) => {
    const opportunity = getOpportunity(db, idParam(ctx.params.id));
    if (!opportunity) throw new ApiError(404, 'not_found', 'No such opportunity');
    return opportunity;
  }));
  router.add('POST', '/api/opportunities', json((ctx) => {
    const body = asObject(ctx.body);
    const series = selectedOpportunitySeries(db, body);
    return createOpportunity(db, { series, intentId: opportunityId(body.intent_id, 'intent_id'),
      evidence: opportunityEvidence(db, body), origin: 'manual', author: 'user',
      buyerRelevance: str(body.buyer_relevance, 'buyer_relevance', { max: 1000 }),
      hypothesis: str(body.hypothesis, 'hypothesis', { max: 2000 }),
      suggestedAction: str(body.suggested_action, 'suggested_action', { max: 2000 }),
      targetUrl: str(body.target_url, 'target_url', { max: 2048 }),
      productArea: str(body.product_area, 'product_area', { max: 200 }),
      controllability: str(body.controllability, 'controllability', { max: 30 }),
      effortBand: str(body.effort_band, 'effort_band', { max: 30 }),
      claimedFalseOrOutdated: bool(body.claimed_false_or_outdated, 'claimed_false_or_outdated'),
      now: isoNow() });
  }, 201));
  router.add('POST', '/api/opportunities/propose', json((ctx) => {
    const body = asObject(ctx.body);
    const series = selectedOpportunitySeries(db, body);
    return createOpportunity(db, { series, intentId: opportunityId(body.intent_id, 'intent_id'),
      evidence: opportunityEvidence(db, body), origin: 'assistant', author: 'mcp_assistant',
      hypothesis: str(body.hypothesis, 'hypothesis', { max: 2000, required: true }),
      suggestedAction: str(body.suggested_action, 'suggested_action', { max: 2000 }),
      targetUrl: str(body.target_url, 'target_url', { max: 2048 }),
      productArea: str(body.product_area, 'product_area', { max: 200 }),
      controllability: str(body.controllability, 'controllability', { max: 30 }),
      claimedFalseOrOutdated: bool(body.claimed_false_or_outdated, 'claimed_false_or_outdated'),
      now: isoNow() });
  }, 201));
  router.add('PATCH', '/api/opportunities/:id', json((ctx) => {
    const body = asObject(ctx.body);
    return reviewOpportunity(db, { id: idParam(ctx.params.id),
      expectedVersion: opportunityId(body.expected_version, 'expected_version'),
      status: str(body.status, 'status', { max: 30 }),
      priority: body.priority === undefined ? undefined : Number(body.priority),
      effortBand: str(body.effort_band, 'effort_band', { max: 30 }),
      estimatedEffortHours: optionalHours(body.estimated_effort_hours),
      actualEffortHours: optionalHours(body.actual_effort_hours),
      owner: str(body.owner, 'owner', { max: 200 }),
      reviewDate: str(body.review_date, 'review_date', { max: 30 }),
      changeDescription: str(body.change_description, 'change_description', { max: 2000 }),
      shippedAt: str(body.shipped_at, 'shipped_at', { max: 30 }),
      dismissalReason: str(body.dismissal_reason, 'dismissal_reason', { max: 1000 }),
      hypothesis: str(body.hypothesis, 'hypothesis', { max: 2000 }),
      suggestedAction: str(body.suggested_action, 'suggested_action', { max: 2000 }),
      targetUrl: str(body.target_url, 'target_url', { max: 2048 }),
      productArea: str(body.product_area, 'product_area', { max: 200 }),
      controllability: str(body.controllability, 'controllability', { max: 30 }),
      actionKind: str(body.action_kind, 'action_kind', { max: 30 }),
      author: 'user', now: isoNow() });
  }));
  router.add('POST', '/api/opportunities/:id/follow-up', json((ctx) => {
    const body = asObject(ctx.body);
    return saveFollowUpPlan(db, { id: idParam(ctx.params.id),
      expectedVersion: opportunityId(body.expected_version, 'expected_version'),
      baselineStart: /** @type {string} */ (str(body.baseline_start, 'baseline_start', { max: 30, required: true })),
      baselineEnd: /** @type {string} */ (str(body.baseline_end, 'baseline_end', { max: 30, required: true })),
      intentIds: opportunityIds(body.intent_ids, 'intent_ids'),
      comparisonIntentIds: opportunityIds(body.comparison_intent_ids, 'comparison_intent_ids'),
      primaryMetric: /** @type {string} */ (str(body.primary_metric, 'primary_metric', { max: 80, required: true })),
      expectedDirection: /** @type {string} */ (str(body.expected_direction, 'expected_direction', { max: 30, required: true })),
      reviewStart: /** @type {string} */ (str(body.review_start, 'review_start', { max: 30, required: true })),
      reviewEnd: /** @type {string} */ (str(body.review_end, 'review_end', { max: 30, required: true })),
      observationDelayDays: body.observation_delay_days === undefined ? 0 : Number(body.observation_delay_days),
      author: 'user', now: isoNow() });
  }, 201));
  router.add('POST', '/api/opportunities/:id/follow-up/:plan_id/capture', json((ctx) => {
    const body = asObject(ctx.body);
    return captureFollowUpReview(db, { id: idParam(ctx.params.id),
      planId: idParam(ctx.params.plan_id),
      expectedVersion: opportunityId(body.expected_version, 'expected_version'),
      author: 'user', now: isoNow() });
  }, 201));
  router.add('GET', '/api/opportunities/:id/follow-up/:plan_id/reviews/:snapshot_id/comparison', json((ctx) =>
    compareIntervention(db, { opportunityId: idParam(ctx.params.id),
      planId: idParam(ctx.params.plan_id), snapshotId: idParam(ctx.params.snapshot_id),
      mode: ctx.url.searchParams.get('mode') ?? undefined })));
  router.add('POST', '/api/opportunities/:id/follow-up/:plan_id/reviews/:snapshot_id', json((ctx) => {
    const body = asObject(ctx.body);
    return saveInterventionReview(db, { opportunityId: idParam(ctx.params.id),
      planId: idParam(ctx.params.plan_id), snapshotId: idParam(ctx.params.snapshot_id),
      mode: /** @type {string|undefined} */ (str(body.mode, 'mode', { max: 30 })),
      expectedVersion: opportunityId(body.expected_version, 'expected_version'),
      judgment: /** @type {string} */ (str(body.judgment, 'judgment', { max: 30, required: true })),
      rationale: /** @type {string} */ (str(body.rationale, 'rationale', { max: 4000, required: true })),
      author: 'user', now: isoNow() });
  }, 201));
  router.add('POST', '/api/opportunities/:id/page-evidence', json((ctx) => {
    const body = asObject(ctx.body);
    return attachOpportunityPageEvidence(db, { id: idParam(ctx.params.id),
      expectedVersion: opportunityId(body.expected_version, 'expected_version'),
      url: /** @type {string} */ (str(body.url, 'url', { max: 2048, required: true })),
      observedAt: /** @type {string} */ (str(body.observed_at, 'observed_at', { max: 30, required: true })),
      excerpt: /** @type {string} */ (str(body.excerpt, 'excerpt', { max: 2000, required: true })),
      provenance: /** @type {'manual_user'|'manual_assistant'|'observed_fetch'} */ (
        str(body.provenance, 'provenance', { max: 30, required: true })),
      sourceObservationId: body.source_observation_id === undefined && body.source_id === undefined
        ? undefined : opportunityId(body.source_observation_id ?? body.source_id, 'source_observation_id'),
      isAuthoritative: bool(body.is_authoritative, 'is_authoritative'),
      author: 'user', now: isoNow() });
  }, 201));
  router.add('POST', '/api/opportunities/:id/page-evidence/:evidence_id/review', json((ctx) => {
    const body = asObject(ctx.body);
    if (bool(body.reviewed, 'reviewed') !== true) {
      throw new ApiError(422, 'unprocessable', 'reviewed must be true');
    }
    return reviewOpportunityPageEvidence(db, { id: idParam(ctx.params.id),
      expectedVersion: opportunityId(body.expected_version, 'expected_version'),
      pageEvidenceId: idParam(ctx.params.evidence_id), author: 'user', now: isoNow() });
  }));
  router.add('POST', '/api/opportunities/:id/combine', json((ctx) => {
    const body = asObject(ctx.body);
    return combineOpportunities(db, { targetId: idParam(ctx.params.id),
      expectedVersion: opportunityId(body.expected_version, 'expected_version'),
      sourceId: opportunityId(body.source_id, 'source_id'),
      sourceExpectedVersion: opportunityId(body.source_expected_version, 'source_expected_version'),
      author: 'user', now: isoNow() });
  }));
  router.add('GET', '/api/query-themes', json(() => ({ themes: listQueryThemes(db) })));
  router.add('POST', '/api/query-themes', json((ctx) => {
    const label = str(asObject(ctx.body).label, 'label', { max: 80, required: true });
    if (get(db, 'SELECT id FROM query_themes WHERE label = ?', [/** @type {string} */ (label)])) {
      throw new ApiError(409, 'conflict', 'A query theme with that label already exists');
    }
    try {
      return createQueryTheme(db, { label: /** @type {string} */ (label), now: isoNow() });
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError(422, 'unprocessable', error.message);
      throw error;
    }
  }, 201));
  router.add('POST', '/api/query-theme-assignments', json((ctx) => {
    const body = asObject(ctx.body);
    const themeId = Number(body.theme_id);
    if (!Number.isSafeInteger(themeId) || themeId < 1) {
      throw new ApiError(422, 'unprocessable', 'theme_id must be a positive integer');
    }
    const normalizedKey = str(body.normalized_key, 'normalized_key', { max: 500, required: true });
    if (typeof body.assigned !== 'boolean') throw new ApiError(422, 'unprocessable', 'assigned must be a boolean');
    try {
      return setQueryThemeAssignment(db, { themeId,
        normalizedKey: /** @type {string} */ (normalizedKey), assigned: body.assigned });
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError(422, 'unprocessable', error.message);
      throw error;
    }
  }));
  router.add('GET', '/api/series/export', json((ctx) => {
    const now = isoNow();
    const { days, series } = selectedSeries(db, ctx.url, now);
    if (!series) return { exportFormatVersion: 1, selectedSeriesId: null, series: null, answers: [] };
    /** @type {ReturnType<typeof queryAnswers>['items']} */
    const answers = [];
    let page = 1;
    let pages;
    do {
      const result = queryAnswers(db, { series, start: series.start, end: series.end,
        days, now: new Date(now), page, per: 100,
        eligibleOnly: ctx.url.searchParams.get('eligible') === '1' });
      answers.push(...result.items);
      pages = result.pages;
      page += 1;
    } while (page <= pages);
    return { exportFormatVersion: 1, selectedSeriesId: series.id, series,
      eligibleOnly: ctx.url.searchParams.get('eligible') === '1', answers };
  }));

  router.add(
    'GET',
    '/api/entities',
    json(() => listEntities(db, { includeArchived: true })),
  );
  router.add(
    'POST',
    '/api/entities',
    json((ctx) => createEntity(deps, ctx), 201),
  );
  router.add(
    'PATCH',
    '/api/entities/:id',
    json((ctx) => patchEntity(deps, ctx)),
  );
  router.add(
    'DELETE',
    '/api/entities/:id',
    json((ctx) => deleteEntity(deps, ctx)),
  );

  router.add(
    'GET',
    '/api/prompts',
    json(() => listPrompts(db)),
  );
  router.add(
    'POST',
    '/api/prompts',
    json((ctx) => createPrompt(deps, ctx), 201),
  );
  router.add('GET', '/api/prompts/review', json(() => activePanelReview(deps)));
  router.add('POST', '/api/prompts/review', json((ctx) => approveActivePanel(deps, ctx)));
  router.add(
    'POST',
    '/api/prompts/exploration',
    json((ctx) => createExploration(deps, ctx), 201),
  );
  router.add(
    'POST',
    '/api/prompts/suggest',
    json((ctx) => suggestPrompts(deps, ctx)),
  );
  router.add(
    'POST',
    '/api/prompts/:id/promote',
    json((ctx) => promoteExploration(deps, ctx)),
  );
  router.add(
    'PATCH',
    '/api/prompts/:id',
    json((ctx) => patchPrompt(deps, ctx)),
  );
  router.add(
    'DELETE',
    '/api/prompts/:id',
    json((ctx) => deletePrompt(deps, ctx)),
  );

  router.add(
    'GET',
    '/api/intents',
    json(() => listIntents(db)),
  );
  // SPEC §3.5 read wrappers over §7's intentTable/promptTable — the §7 shapes are the
  // contract. Registered before any GET /api/intents/:id could exist: the router
  // matches :param segments, and today only PATCH uses :id, so no shadowing.
  router.add(
    'GET',
    '/api/intents/results',
    json((ctx) => metricResult(db, ctx.url, 'intentTable')),
  );
  router.add(
    'GET',
    '/api/prompts/results',
    json((ctx) => metricResult(db, ctx.url, 'promptTable')),
  );
  router.add(
    'PATCH',
    '/api/intents/:id',
    json((ctx) => patchIntent(deps, ctx)),
  );

  router.add(
    'GET',
    '/api/cost/estimate',
    json(() => costEstimate(deps)),
  );

  router.add(
    'GET',
    '/api/gap',
    json((ctx) => metricResult(db, ctx.url, 'citationGap', {
      limit: intQuery(ctx.url, 'limit', 20, 1, 100),
    })),
  );

  router.add(
    'POST',
    '/api/run',
    json((ctx) => startRun(deps, ctx)),
  );
  router.add('GET', '/api/search-schedule', json(() => readApiSearchSchedule(deps)));
  router.add('POST', '/api/search-schedule', json((ctx) => configureApiSearchSchedule(deps, ctx)));
  router.add('DELETE', '/api/search-schedule', json(() => ({ disabled: disableApiSearchSchedule(db) })));
  router.add(
    'POST',
    '/api/subscription/preview',
    json((ctx) => previewSubscription(deps, ctx)),
  );
  router.add(
    'POST',
    '/api/subscription/run',
    json((ctx) => startSubscription(deps, ctx)),
  );
  router.add(
    'POST',
    '/api/subscription/runs/:id/cancel',
    json((ctx) => cancelSubscription(deps, ctx)),
  );
  router.add(
    'GET',
    '/api/subscription/schedule',
    json(() => readSubscriptionSchedule(deps)),
  );
  router.add(
    'POST',
    '/api/subscription/schedule',
    json((ctx) => configureSubscriptionSchedule(deps, ctx)),
  );
  router.add(
    'DELETE',
    '/api/subscription/schedule',
    json(() => deleteSubscriptionSchedule(deps)),
  );
  router.add(
    'POST',
    '/api/setup',
    json((ctx) => setupTracking(deps, ctx)),
  );
  router.add('POST', '/api/setup/drafts', json((ctx) => createSetupDraft(deps, ctx), 201));
  router.add('GET', '/api/setup/drafts/:id', json((ctx) => {
    const draft = getDraft(db, idParam(ctx.params.id));
    if (!draft) throw new ApiError(404, 'not_found', 'No such benchmark draft');
    return draft;
  }));
  router.add('PUT', '/api/setup/drafts/:id', json((ctx) => updateSetupDraft(deps, ctx)));
  router.add('GET', '/api/setup/drafts/:id/review', json((ctx) => reviewSetupDraft(deps, ctx)));
  router.add('POST', '/api/setup/drafts/:id/approve', json((ctx) => approveSetupDraft(deps, ctx)));
  router.add(
    'GET',
    '/api/status',
    json(() => statusReport(deps)),
  );

  router.add(
    'GET',
    '/api/runs/latest',
    json(() => {
      const run_ = latestRun(db);
      if (run_ === null) throw new ApiError(404, 'no_runs', 'No panel runs yet');
      return run_;
    }),
  );

  router.add(
    'GET',
    '/api/answers',
    json((ctx) => {
      const providerParam = ctx.url.searchParams.get('provider');
      if (providerParam !== null && providerParam !== '' && !PROVIDERS.includes(providerParam)) {
        throw new ApiError(400, 'bad_request', `provider must be one of: ${PROVIDERS.join(', ')}`);
      }
      const now = isoNow();
      const requestedSeriesId = ctx.url.searchParams.get('series_id');
      if (!requestedSeriesId && (ctx.url.searchParams.has('start') || ctx.url.searchParams.has('end'))) {
        throw new ApiError(400, 'bad_request', 'start and end require series_id');
      }
      const selection = requestedSeriesId ? selectedSeries(db, ctx.url, now) : null;
      if (selection && !selection.series) throw new ApiError(404, 'series_not_found', 'No series in this window');
      const days = intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 3650);
      const result = queryAnswers(db, {
        provider: providerParam === '' ? null : providerParam,
        surface: surfaceQuery(ctx.url) ?? null,
        promptId: intQuery(ctx.url, 'prompt_id', 0, 1, Number.MAX_SAFE_INTEGER) || null,
        entityId: intQuery(ctx.url, 'entity_id', 0, 1, Number.MAX_SAFE_INTEGER) || null,
        days,
        now: new Date(now),
        series: selection?.series ?? undefined,
        start: selection?.series?.start,
        end: selection?.series?.end,
        eligibleOnly: ctx.url.searchParams.get('eligible') === '1',
        page: intQuery(ctx.url, 'page', 1, 1, 100000),
        per: intQuery(ctx.url, 'per', 20, 1, 100),
      });
      return {
        total: result.total,
        page: result.page,
        selectedSeriesId: selection?.series?.id ?? null,
        coverage: selection?.series ? {
          attemptedTargets: selection.series.attemptedTargets,
          completeAnswers: selection.series.completeAnswers,
          comparableAnswers: selection.series.comparableAnswers,
          verifiedSearchAnswers: selection.series.verifiedSearchAnswers,
          queryMetadataAnswers: selection.series.queryMetadataAnswers,
        } : null,
        items: result.items.map((item) => ({
          id: item.id,
          provider: item.provider,
          surface: item.surface,
          surface_label: surfaceLabel(item.surface ?? `${item.provider}-api`),
          model: item.model,
          created_at: item.created_at,
          prompt: item.prompt,
          text: item.text,
          error: item.error,
          lane: item.lane,
          target_status: item.target_status,
          comparability_status: item.comparability_status,
          web_status: item.web_status,
          prompt_text_snapshot: item.prompt_text_snapshot,
          prompt_origin: item.prompt_origin,
          cli_executable: item.cli_executable,
          artifact_ref: item.artifact_ref,
          analysis_revision: item.analysis_revision,
          execution_profile_id: item.execution_profile_id,
          benchmark_revision_id: item.benchmark_revision_id,
          comparison_key: item.comparison_key,
          search_policy: item.search_policy,
          correction_cutoff: item.correction_cutoff,
          mentions: item.mentions.map((mention) => ({
            id: mention.id,
            entity_id: mention.entity_id,
            name: mention.name,
            first_index: mention.first_index,
            recommended: mention.recommended,
            captured_recommended: mention.captured_recommended,
            stance: mention.stance,
            method: mention.method,
            analysis_revision: mention.analysis_revision,
            rule_id: mention.rule_id,
            evidence_start: mention.evidence_start,
            evidence_end: mention.evidence_end,
            review_flags: mention.review_flags,
          })),
          citations: item.citations.map((citation) => ({
            url: citation.url,
            domain: citation.domain,
            entity_id: citation.entity_id,
          })),
          search_events: item.search_events,
          source_observations: item.source_observations,
          answer_citations: item.answer_citations,
        })),
      };
    }),
  );

  router.add('GET', '/api/answers/:id/review', json((ctx) => {
    const responseId = idParam(ctx.params.id);
    if (!get(db, 'SELECT id FROM responses WHERE id = ?', [responseId])) {
      throw new ApiError(404, 'not_found', 'No such answer');
    }
    const revision = ctx.url.searchParams.get('revision') || undefined;
    if (revision && revision.length > 100) throw new ApiError(400, 'bad_request', 'revision is too long');
    const cutoff = ctx.url.searchParams.has('cutoff')
      ? intQuery(ctx.url, 'cutoff', 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
    try {
      return answerReview(db, responseId, { revision, cutoff });
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError(409, 'review_unavailable', error.message);
      throw error;
    }
  }));

  router.add('POST', '/api/answers/:id/corrections', json((ctx) => {
    const responseId = idParam(ctx.params.id);
    const body = asObject(ctx.body);
    const interpretationId = Number(body.interpretation_id);
    const previousCorrectionId = body.previous_correction_id === undefined || body.previous_correction_id === null
      ? null : Number(body.previous_correction_id);
    if (!Number.isSafeInteger(interpretationId) || interpretationId <= 0 ||
        (previousCorrectionId !== null && (!Number.isSafeInteger(previousCorrectionId) || previousCorrectionId <= 0))) {
      throw new ApiError(422, 'unprocessable', 'Invalid interpretation or correction ID');
    }
    const replacement = /** @type {string} */ (str(body.replacement, 'replacement', { max: 20, required: true }));
    if (!STANCES.includes(replacement)) throw new ApiError(422, 'unprocessable', 'Unknown stance');
    const reason = /** @type {string} */ (str(body.reason, 'reason', { max: 1000, required: true }));
    const requestId = /** @type {string} */ (str(body.request_id, 'request_id', { max: 128, required: true }));
    try {
      return appendCorrection(db, { responseId, interpretationId, previousCorrectionId,
        replacement, reason, requestId, at: isoNow() });
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError(409, 'correction_conflict', error.message);
      if (error instanceof TypeError) throw new ApiError(422, 'unprocessable', error.message);
      throw error;
    }
  }));

  router.add('GET', '/api/stance-rate', json((ctx) => {
    const surface = surfaceQuery(ctx.url);
    if (!surface) throw new ApiError(400, 'bad_request', 'surface is required');
    const analysisRevision = ctx.url.searchParams.get('revision');
    if (!analysisRevision || analysisRevision.length > 100) throw new ApiError(400, 'bad_request', 'revision is required');
    const entityId = intQuery(ctx.url, 'entity_id', 0, 1, Number.MAX_SAFE_INTEGER);
    if (!entityId) throw new ApiError(400, 'bad_request', 'entity_id is required');
    const correctionCutoff = ctx.url.searchParams.has('cutoff')
      ? intQuery(ctx.url, 'cutoff', 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
    try {
      return stanceRecommendationRate(db, { surface, entityId, analysisRevision,
        correctionCutoff, comparisonKey: ctx.url.searchParams.get('comparison_key') || undefined,
        days: intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 3650), now: isoNow() });
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new ApiError(409, 'stance_rate_unavailable', error.message);
      }
      throw error;
    }
  }));

  router.add(
    'GET',
    '/api/alerts',
    json((ctx) => listAlerts(db, { open: (ctx.url.searchParams.get('open') ?? '1') !== '0' })),
  );
  router.add(
    'POST',
    '/api/alerts/:id/ack',
    json((ctx) => {
      const id = idParam(ctx.params.id);
      const changed = run(db, 'UPDATE alerts SET acknowledged = 1 WHERE id = ?', [id]).changes;
      if (changed === 0) throw new ApiError(404, 'not_found', 'No such alert');
      return { ok: true };
    }),
  );

  router.add(
    'GET',
    '/api/export',
    json(() => exportAll(db)),
  );

  // Not in the §10.3 table, but §11.6 requires a persisted branded-prompt SOV toggle
  // and there is no other endpoint that could carry it. Kept to that one setting.
  router.add(
    'PATCH',
    '/api/settings',
    json((ctx) => {
      const body = asObject(ctx.body);
      const includeBranded = bool(body.includeBrandedInSov, 'includeBrandedInSov');
      if (includeBranded !== undefined) setSetting(db, SETTING_KEYS.INCLUDE_BRANDED_IN_SOV, includeBranded);
      return {
        includeBrandedInSov: Boolean(getSetting(db, SETTING_KEYS.INCLUDE_BRANDED_IN_SOV, false)),
      };
    }),
  );
}
