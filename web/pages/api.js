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

import { get, isoNow, run, transaction, getSetting, setSetting, SETTING_KEYS } from '../../core/db.js';
import { sendJson, sendError } from '../router.js';
import { cost, metrics, NotReadyError, runner, soft, strict, suggest } from '../data.js';
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
import { PROVIDER_IDS } from '../../core/config.js';
import { PROMPT_CATEGORIES } from '../../core/suggest.js';

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

  if (get(db, 'SELECT id FROM entities WHERE name = ?', [name])) {
    throw new ApiError(409, 'conflict', `An entity named ${name} already exists`);
  }
  assertDomainsFree(db, domains, null);

  const id = transaction(db, () => {
    const result = run(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, ?, ?)', [
      name,
      JSON.stringify(aliases),
      JSON.stringify(domains),
      isSelf ? 1 : 0,
      isoNow(),
    ]);
    // Exactly one row carries is_self (§3) — enforced here, not by the schema.
    if (isSelf) makeSelf(db, result.lastInsertRowid);
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
  if (mentions > 0) {
    // Soft delete: past answers keep their receipts, metrics stop counting it.
    run(db, 'UPDATE entities SET archived_at = ? WHERE id = ?', [isoNow(), id]);
    return { archived: true, mentions };
  }
  run(db, 'DELETE FROM entities WHERE id = ?', [id]);
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
  const category = checkCategory(str(body.category, 'category', { max: 40 }));
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
    return run(db, 'INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(?, ?, ?, 1, ?)', [
      target,
      text,
      category,
      isoNow(),
    ]).lastInsertRowid;
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
  const active = bool(body.active, 'active');
  const intentId = body.intent_id === undefined || body.intent_id === null ? undefined : idParam(String(body.intent_id));

  if (text !== undefined && text !== existing.text && get(db, 'SELECT id FROM prompts WHERE text = ?', [text])) {
    throw new ApiError(409, 'conflict', 'That prompt text already exists');
  }
  if (intentId !== undefined && !get(db, 'SELECT id FROM intents WHERE id = ?', [intentId])) {
    throw new ApiError(404, 'not_found', 'No such intent');
  }

  transaction(db, () => {
    if (text !== undefined) run(db, 'UPDATE prompts SET text = ? WHERE id = ?', [text, id]);
    if (category !== undefined) run(db, 'UPDATE prompts SET category = ? WHERE id = ?', [category, id]);
    if (active !== undefined) run(db, 'UPDATE prompts SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    if (intentId !== undefined) run(db, 'UPDATE prompts SET intent_id = ? WHERE id = ?', [intentId, id]);
  });

  return listPrompts(db).find((prompt) => prompt.id === id) ?? null;
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
    return { deactivated: true };
  }
  run(db, 'DELETE FROM prompts WHERE id = ?', [id]);
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
 * @returns {{calls: number, estUsd: number|null, perProvider: {provider: string, calls: number, estUsd: number|null}[]}}
 */
export function costEstimate({ db, config }) {
  const prompts = activePromptCount(db);
  const enabled = config.enabledProviders;
  const callsPerProvider = prompts * config.samples;

  /** @type {{calls?: number, estUsd?: number|null, perProvider?: {provider: string, calls: number, estUsd: number|null}[]}|null} */
  const estimate = soft(
    /** @type {*} */ (cost),
    'estimateRunCost',
    { promptCount: prompts, samples: config.samples, providers: enabled.map(({ id, model }) => ({ id, model })) },
    null,
  );
  if (estimate && typeof estimate === 'object' && Array.isArray(estimate.perProvider)) {
    return {
      calls: Number(estimate.calls ?? callsPerProvider * enabled.length),
      estUsd: estimate.estUsd ?? null,
      perProvider: estimate.perProvider,
    };
  }
  return {
    calls: callsPerProvider * enabled.length,
    estUsd: null,
    perProvider: enabled.map((provider) => ({ provider: provider.id, calls: callsPerProvider, estUsd: null })),
  };
}

/** Names `core/suggest.js` may expose for its draft entry point (§6.7). */
const SUGGEST_NAMES = ['suggestIntents', 'suggestPrompts', 'suggest', 'generateIntents'];

/**
 * @param {ApiDeps} deps
 * @param {import('../router.js').Ctx} ctx
 * @returns {Promise<unknown>}
 */
async function suggestPrompts({ db, config }, ctx) {
  const body = asObject(ctx.body);
  const args = {
    db,
    config,
    categoryHint: str(body.category_hint, 'category_hint', { max: 200 }),
    keywords: str(body.keywords, 'keywords', { max: 500 }),
    brand: brandEntity(db),
  };
  if (config.enabledProviders.length === 0) {
    // SPEC §3.4: never a dead end — same §20.3 pack the wizard uses, still draft-only.
    const competitors = listEntities(db).filter((e) => !e.is_self);
    const pack = strict(/** @type {*} */ (suggest), 'starterPack', { ...args, competitors });
    return { source: 'starter-pack', intents: /** @type {*} */ (pack)?.intents ?? pack };
  }
  const name = SUGGEST_NAMES.find((candidate) => typeof (/** @type {*} */ (suggest)[candidate]) === 'function');
  if (name === undefined) throw new NotReadyError('suggest');
  // Draft only — this never persists anything (§6.7).
  const result = await Promise.resolve(strict(/** @type {*} */ (suggest), name, args));
  return { source: 'llm', intents: /** @type {*} */ (result)?.intents ?? result };
}

const SETUP_CATEGORIES = PROMPT_CATEGORIES.includes('branded') ? PROMPT_CATEGORIES : [...PROMPT_CATEGORIES, 'branded'];

/**
 * Brand-word test for PROMPT tagging (SPEC §3.2 branded auto-tag). Deliberately
 * stricter than the analyzer's §6.2 answer matching: a hyphen is word-INTERNAL here,
 * so "best acme-like tool?" is discovery phrasing (stays in SOV denominators) while
 * "is Acme any good?" is navigational (branded). See the SPEC §3.2 example.
 * @param {string} text
 * @param {string[]} aliases
 * @returns {boolean}
 */
function mentionsBrandWord(text, aliases) {
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'iu').test(text);
  });
}

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
  intents.forEach((intent, i) => {
    check(`intents[${i}].label`, () => str(intent.label, 'label', { max: 300, required: true }));
    check(`intents[${i}].category`, () => {
      const cat = str(intent.category, 'category', { max: 40 }) ?? 'general';
      if (!SETUP_CATEGORIES.includes(cat)) throw new ApiError(422, 'unprocessable', `category must be one of: ${SETUP_CATEGORIES.join(', ')}`);
    });
    const ps = strList(intent.paraphrases, `intents[${i}].paraphrases`) ?? [];
    if (ps.length === 0) errors.push({ path: `intents[${i}].paraphrases`, message: 'each intent needs at least one paraphrase' });
    ps.forEach((p, j) => check(`intents[${i}].paraphrases[${j}]`, () => str(p, 'paraphrase', { max: 300, required: true })));
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
          continue;
        }
        // SOV-denominator invariant (SPEC §3.2): brand-name prompts are always 'branded'.
        const isBranded = brandAliases.length > 0 && mentionsBrandWord(text, brandAliases);
        if (isBranded && category !== 'branded') retagged.push(text);
        run(db, 'INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(?, ?, ?, 1, ?)', [
          intentId,
          text,
          isBranded ? 'branded' : category,
          isoNow(),
        ]);
        created.prompts += 1;
      }
    }
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
  const running = get(db, "SELECT id, done_calls, total_calls FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  if (running) {
    throw new ApiError(409, 'already_running', `Run ${running.id} in progress: ${running.done_calls}/${running.total_calls} calls done`);
  }
  if (typeof (/** @type {*} */ (runner).runPanel) !== 'function') throw new NotReadyError('runPanel');

  // Callers always send a JSON body ({} at minimum) — the router 415s non-JSON POSTs.
  const body = ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? /** @type {Record<string, unknown>} */ (ctx.body) : {};
  const confirm = body.confirm === true;
  const estimate = costEstimate({ db, config });
  const needsQuote =
    !confirm &&
    (config.confirmUsd === 0 || estimate.estUsd === null || estimate.estUsd > config.confirmUsd || estimate.calls > 200);
  if (needsQuote) {
    return new WithStatus(200, {
      status: 'quote_required',
      calls: estimate.calls,
      estUsd: estimate.estUsd,
      perProvider: estimate.perProvider,
      confirmHint: 'POST /api/run with {"confirm":true} to start',
    });
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
  return new WithStatus(202, { runId: started ? Number(started.id) : null, estUsd: estimate.estUsd });
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
  return {
    version,
    demo: config.demo,
    configured: brand !== null && activePrompts > 0,
    providers: PROVIDER_IDS.map((id) => {
      const p = config.providers[id];
      return { id: p.id, label: p.label, model: p.model, enabled: p.enabled };
    }),
    counts: {
      entities: listEntities(db).length,
      intents: Number(get(db, 'SELECT COUNT(*) AS n FROM intents')?.n ?? 0),
      activePrompts,
    },
    schedule: { runAt: config.runAt, schedulerEnabled: !config.demo && config.enabledProviders.length > 0 },
    lastRun: latestRun(db),
    spend30dUsd: Number(soft(/** @type {*} */ (metrics), 'actualSpend', { db, days: 30, now: isoNow() }, null)?.totalUsd ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Summary (§10.4)
 * ------------------------------------------------------------------ */

/**
 * @param {ApiDeps} deps
 * @param {number} days
 * @returns {unknown}
 */
export function summary({ db, config }, days) {
  const brand = brandEntity(db);
  const brandId = brand?.id ?? null;
  // One clock for the whole summary — §7 refuses to default it (§19.6 #6), and every
  // window in one response has to be measured from the same instant to be comparable.
  const now = isoNow();
  /** @param {string} name @param {Record<string, unknown>} args */
  const need = (name, args) => strict(/** @type {*} */ (metrics), name, { db, now, ...args });

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
    recommendationRate: rec === null ? null : { p: rec.p, n: rec.n },
    providers,
    openAlerts: Number(get(db, 'SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0')?.n ?? 0),
    lastRun: run_ === null ? null : { finishedAt: run_.finished_at, status: run_.status },
  };
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

  router.add(
    'GET',
    '/api/summary',
    json((ctx) => summary(deps, intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 365))),
  );

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
  router.add(
    'POST',
    '/api/prompts/suggest',
    json((ctx) => suggestPrompts(deps, ctx)),
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
    json((ctx) =>
      strict(/** @type {*} */ (metrics), 'intentTable', {
        db,
        now: isoNow(),
        days: intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 365),
      }),
    ),
  );
  router.add(
    'GET',
    '/api/prompts/results',
    json((ctx) =>
      strict(/** @type {*} */ (metrics), 'promptTable', {
        db,
        now: isoNow(),
        days: intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 365),
      }),
    ),
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
    json((ctx) =>
      strict(/** @type {*} */ (metrics), 'citationGap', {
        db,
        now: isoNow(),
        days: intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 365),
        limit: intQuery(ctx.url, 'limit', 20, 1, 100),
      }),
    ),
  );

  router.add(
    'POST',
    '/api/run',
    json((ctx) => startRun(deps, ctx)),
  );
  router.add(
    'POST',
    '/api/setup',
    json((ctx) => setupTracking(deps, ctx)),
  );
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
      const result = queryAnswers(db, {
        provider: providerParam === '' ? null : providerParam,
        promptId: intQuery(ctx.url, 'prompt_id', 0, 1, Number.MAX_SAFE_INTEGER) || null,
        entityId: intQuery(ctx.url, 'entity_id', 0, 1, Number.MAX_SAFE_INTEGER) || null,
        days: intQuery(ctx.url, 'days', DEFAULT_DAYS, 1, 3650),
        page: intQuery(ctx.url, 'page', 1, 1, 100000),
        per: intQuery(ctx.url, 'per', 20, 1, 100),
      });
      return {
        total: result.total,
        page: result.page,
        items: result.items.map((item) => ({
          id: item.id,
          provider: item.provider,
          model: item.model,
          created_at: item.created_at,
          prompt: item.prompt,
          text: item.text,
          error: item.error,
          mentions: item.mentions.map((mention) => ({
            name: mention.name,
            first_index: mention.first_index,
            recommended: mention.recommended,
          })),
          citations: item.citations.map((citation) => ({
            url: citation.url,
            domain: citation.domain,
            entity_id: citation.entity_id,
          })),
        })),
      };
    }),
  );

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
