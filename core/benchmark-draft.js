import { containsAlias, MIN_ALIAS_LENGTH } from './analyze.js';
import { all, get, isoNow, run, transaction } from './db.js';
import { benchmarkRevision, stableIdentity } from './measurement-contract.js';
import { PROMPT_CATEGORIES } from './suggest.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {{draftId:number,created:{entities:number,intents:number,prompts:number},
 * skipped:{type:string,value:string,reason:string}[],retaggedBranded:string[],
 * benchmarkRevisionId:string,activeQuestionCount:number}} ApprovalReceipt */

const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_INTENTS = 50;
const MAX_PARAPHRASES = 5;
const MAX_SOURCE_NOTE = 1000;
const PLACEHOLDER = /\{[^{}]{0,100}\}|\[[^\[\]]{0,100}\]|<[^<>]{0,100}>/u;

export class BenchmarkDraftError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'BenchmarkDraftError';
    this.code = code;
    this.status = status;
  }
}

/** @param {unknown} value @param {string} name @param {number} max @returns {string} */
function boundedString(value, name, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BenchmarkDraftError('invalid_draft', `${name} must be text`);
  if (value.length > max) throw new BenchmarkDraftError('invalid_draft', `${name} must be ${max} characters or fewer`);
  return value.trim();
}

/** @param {unknown} value @param {string} name @returns {string[]} */
function boundedStrings(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new BenchmarkDraftError('invalid_draft', `${name} must be a list of at most 20 values`);
  }
  return value.map((item, index) => boundedString(item, `${name}[${index}]`, 120)).filter(Boolean);
}

/** @param {unknown} value @param {string} name */
function entityInput(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BenchmarkDraftError('invalid_draft', `${name} must be an entity`);
  }
  const row = /** @type {Record<string, unknown>} */ (value);
  return {
    name: boundedString(row.name, `${name}.name`, 120),
    aliases: row.aliases === undefined ? undefined : boundedStrings(row.aliases, `${name}.aliases`),
    domains: row.domains === undefined ? undefined : boundedStrings(row.domains, `${name}.domains`),
  };
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function normalizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BenchmarkDraftError('invalid_draft', 'Draft must be an object');
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  const rawContext = input.context === undefined ? {} : input.context;
  if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) {
    throw new BenchmarkDraftError('invalid_draft', 'context must be an object');
  }
  const context = /** @type {Record<string, unknown>} */ (rawContext);
  const competitors = input.competitors === undefined ? [] : input.competitors;
  const intents = input.intents === undefined ? [] : input.intents;
  if (!Array.isArray(competitors) || competitors.length > 20) {
    throw new BenchmarkDraftError('invalid_draft', 'competitors must be a list of at most 20 entities');
  }
  if (!Array.isArray(intents) || intents.length > MAX_INTENTS) {
    throw new BenchmarkDraftError('invalid_draft', `intents must be a list of at most ${MAX_INTENTS} groups`);
  }
  const normalized = {
    version: 1,
    context: {
      audience: boundedString(context.audience, 'context.audience', 300),
      productJob: boundedString(context.productJob, 'context.productJob', 300),
      desiredConversion: boundedString(context.desiredConversion, 'context.desiredConversion', 300),
      languagePreference: boundedString(context.languagePreference, 'context.languagePreference', 80),
      marketContext: boundedString(context.marketContext, 'context.marketContext', 300),
      contextNotes: boundedString(context.contextNotes, 'context.contextNotes', 2000),
    },
    brand: entityInput(input.brand, 'brand'),
    competitors: competitors.map((item, index) => {
      if (!item) throw new BenchmarkDraftError('invalid_draft', `competitors[${index}] must be an entity`);
      return entityInput(item, `competitors[${index}]`);
    }),
    intents: intents.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new BenchmarkDraftError('invalid_draft', `intents[${index}] must be a group`);
      }
      const intent = /** @type {Record<string, unknown>} */ (item);
      if (!Array.isArray(intent.paraphrases) || intent.paraphrases.length > MAX_PARAPHRASES) {
        throw new BenchmarkDraftError('invalid_draft', `intents[${index}].paraphrases must have at most ${MAX_PARAPHRASES} entries`);
      }
      return {
        label: boundedString(intent.label, `intents[${index}].label`, 300),
        category: boundedString(intent.category, `intents[${index}].category`, 40) || 'general',
        paraphrases: intent.paraphrases.map((entry, entryIndex) => {
          const phrase = typeof entry === 'string' ? { text: entry } : entry;
          if (!phrase || typeof phrase !== 'object' || Array.isArray(phrase)) {
            throw new BenchmarkDraftError('invalid_draft', `intents[${index}].paraphrases[${entryIndex}] must be a question`);
          }
          const row = /** @type {Record<string, unknown>} */ (phrase);
          if (row.selected !== undefined && typeof row.selected !== 'boolean') {
            throw new BenchmarkDraftError('invalid_draft', `intents[${index}].paraphrases[${entryIndex}].selected must be true or false`);
          }
          return {
            text: boundedString(row.text, `intents[${index}].paraphrases[${entryIndex}].text`, 1000),
            sourceNote: boundedString(row.sourceNote, `intents[${index}].paraphrases[${entryIndex}].sourceNote`, MAX_SOURCE_NOTE),
            selected: row.selected === undefined ? true : row.selected === true,
          };
        }),
      };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_DRAFT_BYTES) {
    throw new BenchmarkDraftError('invalid_draft', 'Draft is too large');
  }
  return normalized;
}

/** @param {unknown} value @returns {string} */
export function validateTrackingQuestion(value) {
  if (typeof value !== 'string') throw new BenchmarkDraftError('invalid_question', 'Question must be text');
  const text = value.trim();
  if (!text) throw new BenchmarkDraftError('invalid_question', 'Question cannot be empty');
  if (text.length > 300) throw new BenchmarkDraftError('invalid_question', 'Question must be 300 characters or fewer');
  if (PLACEHOLDER.test(text)) throw new BenchmarkDraftError('invalid_question', 'Replace every placeholder before tracking');
  return text;
}

/** @param {Db} db @returns {{id:number,role:'brand'|'competitor',name:string,aliases:string[],domains:string[]}[]} */
function entitySnapshot(db) {
  return all(db, 'SELECT id, name, aliases, domains, is_self FROM entities WHERE archived_at IS NULL ORDER BY id')
    .map((row) => ({
      id: Number(row.id),
      role: /** @type {'brand'|'competitor'} */ (Number(row.is_self) === 1 ? 'brand' : 'competitor'),
      name: String(row.name),
      aliases: /** @type {string[]} */ (JSON.parse(String(row.aliases))),
      domains: /** @type {string[]} */ (JSON.parse(String(row.domains))),
    }));
}

/** @param {string} value @returns {string} */
function normalizedDomain(value) {
  const domain = value.trim().toLowerCase().replace(/\.$/u, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(domain)) {
    throw new BenchmarkDraftError('invalid_draft', `Invalid domain: ${value}`);
  }
  return domain;
}

/** @param {Db} db @param {number} id */
export function getDraft(db, id) {
  const row = get(db, 'SELECT * FROM benchmark_drafts WHERE id = ?', [id]);
  if (!row) return null;
  return {
    id: Number(row.id),
    revision: Number(row.revision),
    status: String(row.status),
    payload: JSON.parse(String(row.payload_json)),
    reviewHash: row.review_hash === null ? null : String(row.review_hash),
    approvedBenchmarkId: row.approved_benchmark_id === null ? null : String(row.approved_benchmark_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    approvedAt: row.approved_at === null ? null : String(row.approved_at),
  };
}

/** @param {Db} db @param {unknown} payload */
export function createDraft(db, payload) {
  const normalized = normalizePayload(payload);
  const now = isoNow();
  const id = run(db, `INSERT INTO benchmark_drafts(payload_json, created_at, updated_at)
    VALUES(?, ?, ?)`, [JSON.stringify(normalized), now, now]).lastInsertRowid;
  return getDraft(db, id);
}

/** @param {Db} db @param {number} id @param {number} expectedRevision @param {unknown} payload */
export function updateDraft(db, id, expectedRevision, payload) {
  const normalized = normalizePayload(payload);
  return transaction(db, () => {
    const current = getDraft(db, id);
    if (!current) throw new BenchmarkDraftError('not_found', 'No such draft', 404);
    if (current.revision !== expectedRevision) throw new BenchmarkDraftError('stale_draft', 'Draft changed; review the latest revision', 409);
    if (current.status === 'approved') {
      const now = isoNow();
      const clonedId = run(db, `INSERT INTO benchmark_drafts(payload_json, created_at, updated_at)
        VALUES(?, ?, ?)`, [JSON.stringify(normalized), now, now]).lastInsertRowid;
      return getDraft(db, clonedId);
    }
    run(db, `UPDATE benchmark_drafts SET revision = revision + 1, payload_json = ?,
      review_hash = NULL, updated_at = ? WHERE id = ?`, [JSON.stringify(normalized), isoNow(), id]);
    return getDraft(db, id);
  });
}

/** @param {string} value @returns {string} */
function duplicateKey(value) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

/** @param {Record<string, unknown>} payload @param {ReturnType<typeof entitySnapshot>} current */
function reviewPayload(payload, current) {
  /** @type {{path:string,message:string}[]} */
  const validationErrors = [];
  const context = /** @type {Record<string, string>} */ (payload.context);
  for (const field of ['audience', 'productJob', 'desiredConversion']) {
    if (!context[field]) validationErrors.push({ path: `context.${field}`, message: `${field} is required` });
  }
  const brand = /** @type {{name:string,aliases?:string[],domains?:string[]}|null} */ (payload.brand);
  const existingBrand = current.find((entity) => entity.role === 'brand');
  if (!brand?.name && !existingBrand) validationErrors.push({ path: 'brand.name', message: 'Brand is required' });
  const names = new Set();
  const domains = new Map();
  for (const entity of current) for (const domain of entity.domains) {
    domains.set(normalizedDomain(domain), duplicateKey(entity.name));
  }
  for (const [index, entity] of [brand, .../** @type {Array<{name:string,aliases?:string[],domains?:string[]}>} */ (payload.competitors)].entries()) {
    if (!entity) continue;
    if (!entity.name) validationErrors.push({ path: index === 0 ? 'brand.name' : `competitors[${index - 1}].name`, message: 'Name is required' });
    const key = duplicateKey(entity.name);
    if (key && names.has(key)) validationErrors.push({ path: 'competitors', message: `Duplicate entity: ${entity.name}` });
    names.add(key);
    for (const alias of entity.aliases ?? []) {
      if (alias.length < MIN_ALIAS_LENGTH) {
        validationErrors.push({ path: index === 0 ? 'brand.aliases' : `competitors[${index - 1}].aliases`,
          message: `Aliases must be at least ${MIN_ALIAS_LENGTH} characters` });
      }
    }
    for (const rawDomain of entity.domains ?? []) {
      try {
        const domain = normalizedDomain(rawDomain);
        const owner = domains.get(domain);
        if (owner && owner !== key) {
          validationErrors.push({ path: index === 0 ? 'brand.domains' : `competitors[${index - 1}].domains`,
            message: `Domain ${domain} belongs to another entity` });
        }
        domains.set(domain, key);
      } catch (error) {
        validationErrors.push({ path: index === 0 ? 'brand.domains' : `competitors[${index - 1}].domains`,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (brand?.name && existingBrand && duplicateKey(brand.name) !== duplicateKey(existingBrand.name)) {
    validationErrors.push({ path: 'brand.name', message: 'A different brand is already configured' });
  }
  const brandAliases = [brand?.name ?? existingBrand?.name ?? '', ...(brand?.aliases ?? existingBrand?.aliases ?? [])].filter(Boolean);
  /** @type {{label:string,category:string,paraphrases:{text:string,sourceNote:string,category:string}[]}[]} */
  const selectedIntents = [];
  /** @type {string[]} */
  const retaggedBranded = [];
  const seenText = new Set();
  const seenLabels = new Set();
  /** @type {Record<string, number>} */
  const byCategory = {};
  for (const [i, intent] of /** @type {Array<{label:string,category:string,paraphrases:Array<{text:string,sourceNote:string,selected:boolean}>}>} */ (payload.intents).entries()) {
    const selected = intent.paraphrases.filter((phrase) => phrase.selected);
    if (!selected.length) continue;
    if (!intent.label) validationErrors.push({ path: `intents[${i}].label`, message: 'Intent label is required' });
    else if (seenLabels.has(duplicateKey(intent.label))) validationErrors.push({ path: `intents[${i}].label`, message: 'Duplicate intent label' });
    seenLabels.add(duplicateKey(intent.label));
    if (!PROMPT_CATEGORIES.includes(intent.category)) {
      validationErrors.push({ path: `intents[${i}].category`, message: 'Choose a valid category' });
    }
    /** @type {{text:string,sourceNote:string,category:string}[]} */
    const phrases = [];
    for (const [j, phrase] of intent.paraphrases.entries()) {
      if (!phrase.selected) continue;
      let text = phrase.text;
      try { text = validateTrackingQuestion(text); }
      catch (err) {
        validationErrors.push({ path: `intents[${i}].paraphrases[${j}].text`, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const key = duplicateKey(text);
      if (seenText.has(key)) validationErrors.push({ path: `intents[${i}].paraphrases[${j}].text`, message: 'Duplicate question' });
      seenText.add(key);
      const namesBrand = brandAliases.length > 0 && containsAlias(text, brandAliases);
      const category = namesBrand ? 'branded' : intent.category;
      if (namesBrand && intent.category !== 'branded') retaggedBranded.push(text);
      if (category === 'branded' && !namesBrand) {
        validationErrors.push({ path: `intents[${i}].paraphrases[${j}].text`, message: 'Branded questions must name the tracked brand' });
      }
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      phrases.push({ text, sourceNote: phrase.sourceNote, category });
    }
    selectedIntents.push({ label: intent.label, category: intent.category, paraphrases: phrases });
  }
  const selectedQuestionCount = selectedIntents.reduce((sum, intent) => sum + intent.paraphrases.length, 0);
  if (selectedQuestionCount === 0) validationErrors.push({ path: 'intents', message: 'Select at least one question' });
  return { selectedIntents, selectedQuestionCount, byCategory, retaggedBranded, validationErrors };
}

/** @param {Db} db @param {ReturnType<typeof reviewPayload>} summary */
function projectedPanel(db, summary) {
  const rows = all(db, 'SELECT text, tracking_state, active FROM prompts');
  const active = new Set(rows.filter((row) => row.tracking_state === 'tracking' && Number(row.active) === 1)
    .map((row) => duplicateKey(String(row.text))));
  for (const intent of summary.selectedIntents) for (const phrase of intent.paraphrases) {
    const key = duplicateKey(phrase.text);
    if (rows.some((row) => duplicateKey(String(row.text)) === key && row.tracking_state === 'exploration')) {
      summary.validationErrors.push({ path: 'intents', message: `Question already exists in exploration: ${phrase.text}` });
    }
    active.add(key);
  }
  return active.size;
}

/** @param {Db} db @param {number} id */
export function reviewDraft(db, id) {
  const draft = getDraft(db, id);
  if (!draft) throw new BenchmarkDraftError('not_found', 'No such draft', 404);
  const current = entitySnapshot(db);
  const summary = reviewPayload(draft.payload, current);
  return {
    draftId: id,
    revision: draft.revision,
    reviewHash: stableIdentity({ id, revision: draft.revision, payload: draft.payload, entities: current }),
    projectedActiveQuestionCount: projectedPanel(db, summary),
    ...summary,
  };
}

/** @param {Db} db @param {{name:string,aliases?:string[],domains?:string[]}} entity @param {boolean} isSelf */
function upsertEntity(db, entity, isSelf) {
  const existing = get(db, 'SELECT id, is_self, aliases, domains FROM entities WHERE name = ? COLLATE NOCASE', [entity.name]);
  const now = isoNow();
  if (existing) {
    if (isSelf && Number(existing.is_self) !== 1) {
      throw new BenchmarkDraftError('entity_conflict', 'Brand name is already used by a competitor', 409);
    }
    if (!isSelf && Number(existing.is_self) === 1) {
      throw new BenchmarkDraftError('entity_conflict', 'Competitor name is already the brand', 409);
    }
    run(db, `UPDATE entities SET aliases = ?, domains = ?, archived_at = NULL WHERE id = ?`,
      [JSON.stringify(entity.aliases ?? JSON.parse(String(existing.aliases))),
        JSON.stringify(entity.domains?.map(normalizedDomain) ?? JSON.parse(String(existing.domains))), Number(existing.id)]);
    return false;
  }
  if (isSelf && get(db, 'SELECT id FROM entities WHERE is_self = 1 AND archived_at IS NULL')) {
    throw new BenchmarkDraftError('entity_conflict', 'A different brand is already configured', 409);
  }
  run(db, `INSERT INTO entities(name, aliases, domains, is_self, created_at)
    VALUES(?, ?, ?, ?, ?)`, [entity.name, JSON.stringify(entity.aliases ?? []),
      JSON.stringify(entity.domains?.map(normalizedDomain) ?? []), isSelf ? 1 : 0, now]);
  return true;
}

/** @param {Db} db @param {Record<string, unknown>} row */
function promptFingerprint(db, row) {
  return stableIdentity({
    text: String(row.text),
    category: String(row.category),
    intentId: Number(row.intent_id),
    intentLabel: String(row.intent_label),
    entities: entitySnapshot(db),
  });
}

/** @param {Db} db @param {number} promptId @param {string} [at] */
export function reviewTrackingPrompt(db, promptId, at = isoNow()) {
  const row = get(db, `SELECT p.*, i.label AS intent_label FROM prompts p
    LEFT JOIN intents i ON i.id = p.intent_id WHERE p.id = ?`, [promptId]);
  if (!row) throw new BenchmarkDraftError('not_found', 'No such question', 404);
  if (row.tracking_state !== 'tracking' || row.intent_id === null) {
    throw new BenchmarkDraftError('review_required', 'Promote this exploration question before reviewing it', 409);
  }
  validateTrackingQuestion(row.text);
  const brand = entitySnapshot(db).find((entity) => entity.role === 'brand');
  const aliases = brand ? [brand.name, ...brand.aliases] : [];
  if (aliases.length && containsAlias(String(row.text), aliases) && row.category !== 'branded') {
    throw new BenchmarkDraftError('invalid_question', 'A question naming the tracked brand must use the branded category');
  }
  const fingerprint = promptFingerprint(db, row);
  run(db, 'UPDATE prompts SET approved_at = ?, approval_fingerprint = ? WHERE id = ?', [at, fingerprint, promptId]);
  return fingerprint;
}

/** @param {Db} db @param {number[]} promptIds */
export function assertReviewedSelection(db, promptIds) {
  if (!Array.isArray(promptIds) || promptIds.length === 0) {
    throw new BenchmarkDraftError('review_required', 'Select at least one reviewed tracking question', 409);
  }
  const rows = all(db, `SELECT p.*, i.label AS intent_label FROM prompts p
    LEFT JOIN intents i ON i.id = p.intent_id WHERE p.id IN (${promptIds.map(() => '?').join(',')})`, promptIds);
  if (rows.length !== new Set(promptIds).size) {
    throw new BenchmarkDraftError('review_required', 'The selected question set has changed; review it again', 409);
  }
  for (const row of rows) {
    if (row.tracking_state !== 'tracking' || Number(row.active) !== 1 || !row.approved_at ||
      !row.approval_fingerprint || row.approval_fingerprint !== promptFingerprint(db, row)) {
      throw new BenchmarkDraftError('review_required', 'Tracking questions or entities changed; review the panel before running', 409);
    }
  }
}

/** @param {Db} db @returns {string|null} */
export function recordCurrentBenchmarkRevision(db) {
  const questions = all(db, `SELECT id, intent_id, category, text FROM prompts
    WHERE tracking_state = 'tracking' AND active = 1 ORDER BY id`)
    .map((row) => ({ id: Number(row.id), intentId: Number(row.intent_id), category: String(row.category), text: String(row.text) }));
  if (!questions.length) return null;
  const benchmark = benchmarkRevision({ questions, entities: entitySnapshot(db), weighting: 'equal', scope: 'tracking' });
  run(db, 'INSERT OR IGNORE INTO benchmark_revisions(id, snapshot_json, created_at) VALUES(?, ?, ?)',
    [benchmark.id, JSON.stringify(benchmark.snapshot), isoNow()]);
  return benchmark.id;
}

/** @param {Db} db @param {number} id @param {number} expectedRevision @param {string} reviewHash
 * @returns {ApprovalReceipt} */
export function approveDraft(db, id, expectedRevision, reviewHash) {
  return transaction(db, /** @returns {ApprovalReceipt} */ () => {
    const draft = getDraft(db, id);
    if (!draft) throw new BenchmarkDraftError('not_found', 'No such draft', 404);
    if (draft.revision !== expectedRevision) throw new BenchmarkDraftError('stale_draft', 'Draft changed; review the latest revision', 409);
    if (draft.status === 'approved') {
      if (draft.reviewHash !== reviewHash) throw new BenchmarkDraftError('stale_review', 'Review changed; review the latest panel', 409);
      const row = get(db, 'SELECT approval_receipt_json FROM benchmark_drafts WHERE id = ?', [id]);
      return /** @type {ApprovalReceipt} */ (JSON.parse(String(row?.approval_receipt_json)));
    }
    const review = reviewDraft(db, id);
    if (review.reviewHash !== reviewHash) throw new BenchmarkDraftError('stale_review', 'Review changed; review the latest panel', 409);
    if (review.validationErrors.length) {
      throw new BenchmarkDraftError('invalid_draft', review.validationErrors.map((item) => `${item.path}: ${item.message}`).join('; '));
    }
    const payload = draft.payload;
    const created = { entities: 0, intents: 0, prompts: 0 };
    /** @type {{type:string,value:string,reason:string}[]} */
    const skipped = [];
    const brand = /** @type {{name:string,aliases?:string[],domains?:string[]}|null} */ (payload.brand);
    if (brand && upsertEntity(db, brand, true)) created.entities += 1;
    for (const competitor of /** @type {Array<{name:string,aliases?:string[],domains?:string[]}>} */ (payload.competitors)) {
      if (upsertEntity(db, competitor, false)) created.entities += 1;
    }
    /** @type {number[]} */
    const reviewedPromptIds = [];
    for (const intent of review.selectedIntents) {
      const existingIntent = get(db, 'SELECT id FROM intents WHERE label = ?', [intent.label]);
      const intentId = existingIntent ? Number(existingIntent.id)
        : run(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', [intent.label, isoNow()]).lastInsertRowid;
      if (!existingIntent) created.intents += 1;
      for (const phrase of intent.paraphrases) {
        const existingPrompt = get(db, 'SELECT id, tracking_state FROM prompts WHERE text = ? COLLATE NOCASE', [phrase.text]);
        if (existingPrompt && existingPrompt.tracking_state !== 'tracking') {
          throw new BenchmarkDraftError('question_conflict', `Question already exists in exploration: ${phrase.text}`, 409);
        }
        let promptId;
        if (existingPrompt) {
          promptId = Number(existingPrompt.id);
          run(db, `UPDATE prompts SET intent_id = ?, category = ?, source_note = ?, active = 1 WHERE id = ?`,
            [intentId, phrase.category, phrase.sourceNote || null, promptId]);
          skipped.push({ type: 'prompt', value: phrase.text, reason: 'existing question reviewed' });
        } else {
          promptId = run(db, `INSERT INTO prompts(intent_id, text, category, active, created_at,
            tracking_state, origin, source_note) VALUES(?, ?, ?, 1, ?, 'tracking', 'user_authored', ?)`,
            [intentId, phrase.text, phrase.category, isoNow(), phrase.sourceNote || null]).lastInsertRowid;
          created.prompts += 1;
        }
        reviewedPromptIds.push(promptId);
      }
    }
    for (const promptId of reviewedPromptIds) reviewTrackingPrompt(db, promptId);
    const reviewedQuestions = all(db, `SELECT p.*, i.label AS intent_label FROM prompts p
      JOIN intents i ON i.id = p.intent_id
      WHERE p.tracking_state = 'tracking' AND p.active = 1 AND p.approval_fingerprint IS NOT NULL ORDER BY p.id`)
      .filter((row) => row.approval_fingerprint === promptFingerprint(db, row))
      .map((row) => ({ id: Number(row.id), intentId: Number(row.intent_id), category: String(row.category), text: String(row.text) }));
    const benchmarkId = recordCurrentBenchmarkRevision(db);
    const now = isoNow();
    const receipt = {
      draftId: id,
      created,
      skipped,
      retaggedBranded: review.retaggedBranded,
      benchmarkRevisionId: /** @type {string} */ (benchmarkId),
      activeQuestionCount: reviewedQuestions.length,
    };
    run(db, `UPDATE benchmark_drafts SET status = 'approved', review_hash = ?,
      approved_benchmark_id = ?, approval_receipt_json = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
      [reviewHash, benchmarkId, JSON.stringify(receipt), now, now, id]);
    return receipt;
  });
}
