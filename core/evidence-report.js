import { isAgentSurface, AGENT_SURFACES } from './agent-routes.js';
import { entityForDomain, normaliseUrl } from './analyze.js';
import { all, get, isoNow, run } from './db.js';
import { normalizeObservedQuery, sourceGroupingUrl, stableIdentity } from './measurement-contract.js';
import { answerReview } from './interpretations.js';
import { wilson } from './metrics.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./metrics.js').MeasurementSeries} MeasurementSeries */
/** @typedef {{promptId:number,intentId:number|null,text:string,category:string,source:string}} EvidenceQuestionSnapshot */
/** @typedef {EvidenceQuestionSnapshot & {attemptedTargets:number,comparableAnswers:number,responseIds:number[]}} EvidenceQuestion */
/** @typedef {{id:number,question:EvidenceQuestionSnapshot,text:string,createdAt:string,provider:string,model:string,
 *   surface:string,executionProfileId:string|null,benchmarkRevisionId:string|null,
 *   analysisRevision:string|null,answerStatus:string|null,webStatus:string|null,
 *   queryMetadataStatus:string|null,evidenceCompleteness:string|null,
 *   searchActions:{id:number,eventType:string,status:string,observedAt:string,providerActionId:string|null,
 *     providerEventType:string|null,sequence:number|null,safeError:string|null}[],
 *   searchQueries:{id:number,searchEventId:number|null,originalText:string,normalizedKey:string,ordinal:number}[],
 *   sourceObservations:{id:number,searchEventId:number|null,url:string,normalizedUrl:string|null,
 *     title:string|null,excerpt:string|null,provenance:string,originalOrder:number|null,
 *     urlHost:string|null,publisherDomain:null}[],
 *   answerCitations:{id:number,sourceObservationId:number|null,url:string,provenance:string,
 *     answerStart:number|null,answerEnd:number|null,ordinal:number}[],
 *   groundingReceipt:ReturnType<typeof import('./providers/gemini-grounding.js').parseGeminiGrounding>['receipt']|null,
 *   mentions:(ReturnType<typeof answerReview>['mentions'][number] & {entityName:string|null})[]}} EvidenceAnswer */
/** @typedef {{normalizedKey:string,originalTexts:string[],responseIncidence:number,rawOccurrences:number,
 *   responseIds:number[],queryIds:number[],themeLabels:string[]}} EvidenceQueryGroup */
/** @typedef {{normalizedUrl:string|null,url:string,provenance:string,urlHost:string|null,
 *   publisherDomain:null,responseIncidence:number,rawOccurrences:number,responseIds:number[],
 *   observationIds:number[]}} EvidenceSourceGroup */
/** @typedef {{normalizedUrl:string|null,url:string,provenance:string,urlHost:string|null,
 *   publisherDomain:null,responseIncidence:number,rawOccurrences:number,
 *   responseIds:number[],citationIds:number[]}} EvidenceCitationGroup */
/** @typedef {{themeId:number,label:string,responseIncidence:number,rawOccurrences:number,
 *   responseIds:number[],queryIds:number[],normalizedKeys:string[]}} EvidenceThemeGroup */
/** @typedef {{attemptedTargets:number,completeAnswers:number,comparableAnswers:number,
 *   answersWithQueryMetadata:number,answersWithObservedQueries:number,
 *   queryMetadataUnavailable:number,queryMetadataNotApplicable:number,
 *   responsesWithSourceObservations:number,responsesWithAnswerCitations:number}} EvidenceCoverage */
/** @typedef {{series:MeasurementSeries,intent:{id:number,label:string|null}|null,
 *   questions:EvidenceQuestion[],coverage:EvidenceCoverage,queries:EvidenceQueryGroup[],
 *   themeGroups:EvidenceThemeGroup[],sources:EvidenceSourceGroup[],
 *   citations:EvidenceCitationGroup[],answers:EvidenceAnswer[]}} EvidenceReport */

/** @param {unknown} value @returns {number|null} */
const numberOrNull = (value) => value === null || value === undefined ? null : Number(value);
/** @param {unknown} value @returns {string|null} */
const stringOrNull = (value) => value === null || value === undefined ? null : String(value);

/** @param {string|null} url @returns {string|null} */
function urlHost(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** @param {Db} db @param {MeasurementSeries} series */
function seriesRows(db, series) {
  if (!series || !series.start || !series.end || series.start >= series.end) {
    throw new TypeError('Evidence report requires a selected measurement series and an ordered window');
  }
  return all(db, `SELECT r.id, r.prompt_id, r.prompt_text_snapshot, r.text, r.provider, r.model,
      r.created_at, r.surface, r.execution_profile_id, r.benchmark_revision_id,
      r.analysis_revision, r.comparison_key, r.search_policy, r.answer_status,
      r.target_status, r.comparability_status, r.web_status, r.query_metadata_status,
      r.evidence_completeness, r.error, p.text AS current_prompt_text,
      p.intent_id AS current_intent_id, p.category AS current_category
    FROM responses r LEFT JOIN prompts p ON p.id = r.prompt_id
    WHERE r.lane = 'tracking' AND r.created_at >= ? AND r.created_at < ?
      AND r.surface IS ? AND r.execution_profile_id IS ?
      AND r.benchmark_revision_id IS ? AND r.analysis_revision IS ?
      AND r.comparison_key IS ? AND r.search_policy IS ?
    ORDER BY r.created_at DESC, r.id DESC`, [series.start, series.end, series.surface,
    series.executionProfileId, series.benchmarkRevisionId, series.analysisRevision,
    series.comparisonKey, series.searchPolicy]);
}

/** @param {Record<string, unknown>} row */
function comparable(row) {
  return row.error === null && row.target_status === 'completed'
    && row.comparability_status === 'comparable'
    && typeof row.text === 'string' && row.text.trim() !== ''
    && (row.answer_status === 'complete' || row.answer_status === null)
    && (row.search_policy !== 'required' || row.web_status === 'verified')
    && (!isAgentSurface(row.surface) || row.web_status === 'verified');
}

/** @param {Db} db @param {MeasurementSeries} series */
function historicalQuestions(db, series) {
  /** @type {Map<number, {promptId:number,intentId:number|null,text:string,category:string,source:string}>} */
  const questions = new Map();
  if (!series.benchmarkRevisionId) return questions;
  const row = get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [series.benchmarkRevisionId]);
  if (!row) return questions;
  const snapshot = JSON.parse(String(row.snapshot_json));
  if (!snapshot || !Array.isArray(snapshot.questions)) return questions;
  for (const item of snapshot.questions) {
    if (!item || !Number.isSafeInteger(Number(item.id)) || typeof item.text !== 'string') continue;
    const promptId = Number(item.id);
    questions.set(promptId, { promptId, intentId: numberOrNull(item.intentId), text: item.text,
      category: String(item.category ?? 'general'), source: 'benchmark_snapshot' });
  }
  return questions;
}

/** @param {Record<string, unknown>} row @param {ReturnType<typeof historicalQuestions>} historical */
function questionFor(row, historical) {
  const promptId = Number(row.prompt_id);
  return historical.get(promptId) ?? {
    promptId,
    intentId: numberOrNull(row.current_intent_id),
    text: String(row.prompt_text_snapshot ?? row.current_prompt_text ?? ''),
    category: String(row.current_category ?? 'unknown'),
    source: row.prompt_text_snapshot === null ? 'current_prompt' : 'response_snapshot',
  };
}

/** @param {Db} db @param {number[]} ids @param {string} table */
function childRows(db, ids, table) {
  if (ids.length === 0) return [];
  const result = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    result.push(...all(db, `SELECT * FROM ${table} WHERE response_id IN (${chunk.map(() => '?').join(',')}) ORDER BY response_id, id`, chunk));
  }
  return result;
}

/**
 * Read the selected series at the original question wording. With no intentId, return
 * all intents in the series. A requested intent absent from the series returns null.
 * Query, source, and citation groups each retain their own supporting record IDs.
 *
 * @param {Db} db
 * @param {{series:MeasurementSeries,intentId?:number}} input
 * @returns {EvidenceReport|null}
 */
export function intentEvidenceReport(db, input) {
  const { series } = input;
  const historical = historicalQuestions(db, series);
  const rows = /** @type {(Record<string, unknown> & {question:ReturnType<typeof questionFor>})[]} */ (
    seriesRows(db, series).map((row) => ({ ...row, question: questionFor(row, historical) })));
  const requestedIntent = input.intentId === undefined ? undefined : Number(input.intentId);
  if (requestedIntent !== undefined && !Number.isSafeInteger(requestedIntent)) {
    throw new TypeError('intentId must be an integer');
  }
  const scoped = requestedIntent === undefined ? rows : rows.filter((row) => row.question.intentId === requestedIntent);
  if (requestedIntent !== undefined && scoped.length === 0) return null;
  const eligible = scoped.filter(comparable);
  const ids = eligible.map((row) => Number(row.id));
  /** @type {Map<number, EvidenceAnswer>} */
  const answers = new Map(eligible.map((row) => [Number(row.id), {
    id: Number(row.id), question: row.question, text: String(row.text),
    createdAt: String(row.created_at), provider: String(row.provider), model: String(row.model),
    surface: String(row.surface), executionProfileId: stringOrNull(row.execution_profile_id),
    benchmarkRevisionId: stringOrNull(row.benchmark_revision_id),
    analysisRevision: stringOrNull(row.analysis_revision),
    answerStatus: stringOrNull(row.answer_status), webStatus: stringOrNull(row.web_status),
    queryMetadataStatus: stringOrNull(row.query_metadata_status),
    evidenceCompleteness: stringOrNull(row.evidence_completeness),
    searchActions: [], searchQueries: [], sourceObservations: [], answerCitations: [],
    groundingReceipt: null, mentions: [],
  }]));

  const actions = childRows(db, ids, 'search_events');
  const queries = childRows(db, ids, 'search_queries');
  const sources = childRows(db, ids, 'source_observations');
  const citations = childRows(db, ids, 'answer_citations');
  const groundingReceipts = childRows(db, ids, 'gemini_grounding_receipts');
  const mentions = childRows(db, ids, 'mentions');
  for (const item of actions) answers.get(Number(item.response_id))?.searchActions.push({
    id: Number(item.id), eventType: String(item.event_type), status: String(item.status),
    observedAt: String(item.observed_at), providerActionId: stringOrNull(item.provider_action_id),
    providerEventType: stringOrNull(item.provider_event_type), sequence: numberOrNull(item.sequence),
    safeError: stringOrNull(item.safe_error),
  });
  for (const item of queries) answers.get(Number(item.response_id))?.searchQueries.push({
    id: Number(item.id), searchEventId: numberOrNull(item.search_event_id),
    originalText: String(item.original_text), normalizedKey: normalizeObservedQuery(String(item.original_text)),
    ordinal: Number(item.ordinal),
  });
  for (const item of sources) answers.get(Number(item.response_id))?.sourceObservations.push({
    id: Number(item.id), searchEventId: numberOrNull(item.search_event_id),
    url: String(item.url), normalizedUrl: stringOrNull(item.normalized_url),
    title: stringOrNull(item.title), excerpt: stringOrNull(item.excerpt),
    provenance: String(item.provenance), originalOrder: numberOrNull(item.original_order),
    urlHost: urlHost(String(item.url)), publisherDomain: null,
  });
  for (const item of citations) answers.get(Number(item.response_id))?.answerCitations.push({
    id: Number(item.id), sourceObservationId: numberOrNull(item.source_observation_id),
    url: String(item.url), provenance: String(item.provenance),
    answerStart: numberOrNull(item.answer_start), answerEnd: numberOrNull(item.answer_end),
    ordinal: Number(item.ordinal),
  });
  for (const item of groundingReceipts) {
    const answer = answers.get(Number(item.response_id));
    if (answer) answer.groundingReceipt = JSON.parse(String(item.metadata_json));
  }
  for (const responseId of new Set(mentions.map((mention) => Number(mention.response_id)))) {
    const answer = answers.get(responseId);
    if (answer) answer.mentions = answerReview(db, responseId).mentions.map((mention) => ({
      ...mention,
      entityName: stringOrNull(get(db, 'SELECT name FROM entities WHERE id = ?', [mention.entityId])?.name),
    }));
  }

  /** @type {Map<string, EvidenceQueryGroup>} */
  const queryGroups = new Map();
  /** @type {Map<string, EvidenceSourceGroup>} */
  const sourceGroups = new Map();
  /** @type {Map<string, EvidenceCitationGroup>} */
  const citationGroups = new Map();
  for (const answer of answers.values()) {
    for (const query of answer.searchQueries) {
      const key = query.normalizedKey;
      let group = queryGroups.get(key);
      if (!group) {
        group = { normalizedKey: key, originalTexts: [], responseIncidence: 0,
          rawOccurrences: 0, responseIds: [], queryIds: [], themeLabels: [] };
        queryGroups.set(key, group);
      }
      if (!group.responseIds.includes(answer.id)) { group.responseIds.push(answer.id); group.responseIncidence += 1; }
      if (!group.originalTexts.includes(query.originalText)) group.originalTexts.push(query.originalText);
      group.rawOccurrences += 1;
      group.queryIds.push(query.id);
    }
    for (const source of answer.sourceObservations) {
      const normalizedUrl = (source.normalizedUrl && sourceGroupingUrl(source.normalizedUrl))
        || sourceGroupingUrl(source.url);
      const key = JSON.stringify([normalizedUrl ?? source.url, source.provenance]);
      let group = sourceGroups.get(key);
      if (!group) {
        group = { normalizedUrl, url: source.url, provenance: source.provenance,
          urlHost: source.urlHost, publisherDomain: null, responseIncidence: 0,
          rawOccurrences: 0, responseIds: [], observationIds: [] };
        sourceGroups.set(key, group);
      }
      if (!group.responseIds.includes(answer.id)) { group.responseIds.push(answer.id); group.responseIncidence += 1; }
      group.rawOccurrences += 1;
      group.observationIds.push(source.id);
    }
    for (const citation of answer.answerCitations) {
      const normalizedUrl = sourceGroupingUrl(citation.url);
      const key = JSON.stringify([normalizedUrl ?? citation.url, citation.provenance]);
      let group = citationGroups.get(key);
      if (!group) {
        group = { normalizedUrl, url: citation.url, provenance: citation.provenance,
          urlHost: urlHost(citation.url), publisherDomain: null,
          responseIncidence: 0, rawOccurrences: 0, responseIds: [], citationIds: [] };
        citationGroups.set(key, group);
      }
      if (!group.responseIds.includes(answer.id)) { group.responseIds.push(answer.id); group.responseIncidence += 1; }
      group.rawOccurrences += 1;
      group.citationIds.push(citation.id);
    }
  }
  const themeRows = all(db, `SELECT a.normalized_key, t.id AS theme_id, t.label FROM query_theme_assignments a
    JOIN query_themes t ON t.id = a.theme_id ORDER BY t.label`);
  for (const item of themeRows) queryGroups.get(String(item.normalized_key))?.themeLabels.push(String(item.label));
  /** @type {Map<number, EvidenceThemeGroup>} */
  const themeGroups = new Map();
  for (const item of themeRows) {
    const query = queryGroups.get(String(item.normalized_key));
    if (!query) continue;
    const themeId = Number(item.theme_id);
    let theme = themeGroups.get(themeId);
    if (!theme) {
      theme = { themeId, label: String(item.label), responseIncidence: 0,
        rawOccurrences: 0, responseIds: [], queryIds: [], normalizedKeys: [] };
      themeGroups.set(themeId, theme);
    }
    theme.rawOccurrences += query.rawOccurrences;
    theme.queryIds.push(...query.queryIds);
    theme.normalizedKeys.push(query.normalizedKey);
    for (const responseId of query.responseIds) {
      if (!theme.responseIds.includes(responseId)) theme.responseIds.push(responseId);
    }
    theme.responseIncidence = theme.responseIds.length;
  }

  /** @type {Map<number, EvidenceQuestion>} */
  const questions = new Map();
  for (const row of scoped) {
    const question = row.question;
    let group = questions.get(question.promptId);
    if (!group) {
      group = { ...question, attemptedTargets: 0, comparableAnswers: 0, responseIds: [] };
      questions.set(question.promptId, group);
    }
    group.attemptedTargets += 1;
    if (comparable(row)) { group.comparableAnswers += 1; group.responseIds.push(Number(row.id)); }
  }
  const answerList = [...answers.values()];
  const coverage = {
    attemptedTargets: scoped.length,
    completeAnswers: scoped.filter((row) => row.error === null && row.target_status === 'completed'
      && typeof row.text === 'string' && row.text.trim() !== ''
      && (row.answer_status === 'complete' || row.answer_status === null)).length,
    comparableAnswers: answerList.length,
    answersWithQueryMetadata: answerList.filter((answer) => answer.queryMetadataStatus === 'available').length,
    answersWithObservedQueries: answerList.filter((answer) => answer.searchQueries.length > 0).length,
    queryMetadataUnavailable: answerList.filter((answer) => answer.queryMetadataStatus === 'unavailable').length,
    queryMetadataNotApplicable: answerList.filter((answer) => answer.queryMetadataStatus === 'not_applicable').length,
    responsesWithSourceObservations: answerList.filter((answer) => answer.sourceObservations.length > 0).length,
    responsesWithAnswerCitations: answerList.filter((answer) => answer.answerCitations.length > 0).length,
  };
  const label = requestedIntent === undefined ? null
    : stringOrNull(get(db, 'SELECT label FROM intents WHERE id = ?', [requestedIntent])?.label);
  return {
    series, intent: requestedIntent === undefined ? null : { id: requestedIntent, label },
    questions: [...questions.values()].sort((a, b) => a.promptId - b.promptId),
    coverage,
    queries: [...queryGroups.values()].sort((a, b) => b.responseIncidence - a.responseIncidence
      || b.rawOccurrences - a.rawOccurrences || a.normalizedKey.localeCompare(b.normalizedKey)),
    themeGroups: [...themeGroups.values()].sort((a, b) => b.responseIncidence - a.responseIncidence
      || a.label.localeCompare(b.label)),
    sources: [...sourceGroups.values()].sort((a, b) => b.responseIncidence - a.responseIncidence
      || b.rawOccurrences - a.rawOccurrences || a.url.localeCompare(b.url)),
    citations: [...citationGroups.values()].sort((a, b) => b.responseIncidence - a.responseIncidence
      || b.rawOccurrences - a.rawOccurrences || a.url.localeCompare(b.url)),
    answers: answerList,
  };
}

/** @param {Db} db @param {{series:MeasurementSeries}} input */
export function listEvidenceIntents(db, input) {
  const report = intentEvidenceReport(db, input);
  if (!report) return [];
  /** @type {Map<number, any>} */
  const byIntent = new Map();
  for (const question of report.questions) {
    if (question.intentId === null) continue;
    let item = byIntent.get(question.intentId);
    if (!item) {
      item = { id: question.intentId,
        label: stringOrNull(get(db, 'SELECT label FROM intents WHERE id = ?', [question.intentId])?.label),
        questionCount: 0, attemptedTargets: 0, comparableAnswers: 0 };
      byIntent.set(question.intentId, item);
    }
    item.questionCount += 1;
    item.attemptedTargets += question.attemptedTargets;
    item.comparableAnswers += question.comparableAnswers;
  }
  return [...byIntent.values()].sort((a, b) => b.comparableAnswers - a.comparableAnswers || a.id - b.id);
}

/** @param {Db} db @param {{series:MeasurementSeries,responseId:number}} input
 * @returns {EvidenceAnswer|null} */
export function answerEvidence(db, input) {
  const responseId = Number(input.responseId);
  if (!Number.isSafeInteger(responseId)) throw new TypeError('responseId must be an integer');
  const report = intentEvidenceReport(db, { series: input.series });
  return report?.answers.find((answer) => answer.id === responseId) ?? null;
}

/** @param {Db} db */
export function listQueryThemes(db) {
  const themes = all(db, 'SELECT id, label, created_at FROM query_themes ORDER BY label, id');
  const assignments = all(db, 'SELECT theme_id, normalized_key FROM query_theme_assignments ORDER BY normalized_key');
  return themes.map((theme) => ({ id: Number(theme.id), label: String(theme.label),
    createdAt: String(theme.created_at), normalizedKeys: assignments
      .filter((item) => Number(item.theme_id) === Number(theme.id)).map((item) => String(item.normalized_key)) }));
}

/** @param {Db} db @param {{label:string,now?:Date|string}} input */
export function createQueryTheme(db, input) {
  const label = String(input.label ?? '').trim();
  if (!label || label.length > 120) throw new RangeError('Theme label must have 1 to 120 characters');
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const createdAt = isoNow(now);
  const id = run(db, 'INSERT INTO query_themes(label, created_at) VALUES(?, ?)', [label, createdAt]).lastInsertRowid;
  return { id, label, createdAt, normalizedKeys: [] };
}

/** @param {Db} db @param {{themeId:number,normalizedKey:string,assigned:boolean}} input */
export function setQueryThemeAssignment(db, input) {
  const themeId = Number(input.themeId);
  const normalizedKey = normalizeObservedQuery(String(input.normalizedKey ?? ''));
  if (!Number.isSafeInteger(themeId) || !get(db, 'SELECT 1 FROM query_themes WHERE id = ?', [themeId])) {
    throw new RangeError('Unknown query theme');
  }
  if (!normalizedKey || (input.assigned && !get(db,
    'SELECT 1 FROM search_queries WHERE normalized_key = ? LIMIT 1', [normalizedKey]))) {
    throw new RangeError('Theme assignment requires an observed search query');
  }
  if (input.assigned) run(db, 'INSERT OR IGNORE INTO query_theme_assignments(theme_id, normalized_key) VALUES(?, ?)', [themeId, normalizedKey]);
  else run(db, 'DELETE FROM query_theme_assignments WHERE theme_id = ? AND normalized_key = ?', [themeId, normalizedKey]);
  return { themeId, normalizedKey, assigned: input.assigned };
}

/** @typedef {'brand_owned'|'competitor_owned'|'third_party'} UrlOwnership */
/** @typedef {{id:number,name:string,aliases:string[],domains:string[],isSelf:boolean}} ActiveEntity */
/** @typedef {{mentionId:number,responseId:number,entityId:number,entityName:string,isSelf:boolean,
 *   effectiveStance:string|null,isPositive:boolean,isLegacyUncorrected:boolean,
 *   interpretationId:number|null,correctionId:number|null}} ResolvedMention */
/** @typedef {{surface?:string,provider?:string,model?:string,searchPolicy?:string,
 *   runId?:number,seriesKey?:string,seriesId?:string,comparisonKey?:string,
 *   series?:MeasurementSeries,intentId?:number,start?:string,end?:string,
 *   includeSeeded?:boolean,excludeBranded?:boolean,limit?:number}} ForensicFilters */

const PROVIDER_SORT_ORDER = ['openai', 'anthropic', 'gemini', 'perplexity'];
const DEFAULT_TOP_LIMIT = 25;

/** @param {string} a @param {string} b */
function compareProviders(a, b) {
  const ai = PROVIDER_SORT_ORDER.indexOf(a);
  const bi = PROVIDER_SORT_ORDER.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

/** @param {unknown} raw @returns {string[]} */
function parseJsonStringArray(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/**
 * Execute a chunked `IN (...)` query so large response/mention sets never exceed SQLite's
 * parameter ceiling.
 *
 * @param {Db} db
 * @param {string} sqlPrefix SQL ending with `IN (`
 * @param {number[]} ids
 * @param {string} [sqlSuffix] SQL starting with `)`
 * @returns {Record<string, unknown>[]}
 */
export function chunkedInQuery(db, sqlPrefix, ids, sqlSuffix = ')') {
  if (ids.length === 0) return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    out.push(...all(db, `${sqlPrefix}${chunk.map(() => '?').join(',')}${sqlSuffix}`, chunk));
  }
  return out;
}

/**
 * Compute Hearsay's exact measurement-series identity for a response row.
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function responseSeriesIdentity(row) {
  return stableIdentity([
    stringOrNull(row.surface),
    stringOrNull(row.execution_profile_id),
    stringOrNull(row.benchmark_revision_id),
    stringOrNull(row.analysis_revision),
    stringOrNull(row.comparison_key),
    stringOrNull(row.search_policy),
  ]);
}

/**
 * Load all active (non-archived) entities and identify the brand (`is_self = 1`).
 * @param {Db} db
 * @returns {{entities:ActiveEntity[],byId:Map<number,ActiveEntity>,brand:ActiveEntity|null}}
 */
export function loadActiveEntities(db) {
  const rows = all(db, `SELECT id, name, aliases, domains, is_self
    FROM entities WHERE archived_at IS NULL ORDER BY is_self DESC, id ASC`);
  /** @type {ActiveEntity[]} */
  const entities = rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    aliases: parseJsonStringArray(row.aliases),
    domains: parseJsonStringArray(row.domains),
    isSelf: Number(row.is_self) === 1,
  }));
  /** @type {Map<number, ActiveEntity>} */
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const brand = entities.find((entity) => entity.isSelf) ?? null;
  return { entities, byId, brand };
}

/**
 * Canonicalize a URL and classify its domain ownership against active entities.
 *
 * @param {string} rawUrl
 * @param {string|null} normalizedUrl
 * @param {ActiveEntity[]} entities
 * @param {Map<number, ActiveEntity>} byId
 * @returns {{canonicalUrl:string,domain:string|null,ownership:UrlOwnership,entityId:number|null,entityName:string|null}}
 */
export function classifyUrlOwnership(rawUrl, normalizedUrl, entities, byId) {
  const canonicalUrl = (normalizedUrl && sourceGroupingUrl(normalizedUrl))
    || sourceGroupingUrl(rawUrl)
    || rawUrl;
  const parsed = normaliseUrl(canonicalUrl) ?? normaliseUrl(rawUrl);
  const domain = parsed ? parsed.domain : null;
  const entityId = domain ? entityForDomain(domain, entities) : null;
  const owner = entityId === null ? null : (byId.get(entityId) ?? null);
  /** @type {UrlOwnership} */
  const ownership = owner ? (owner.isSelf ? 'brand_owned' : 'competitor_owned') : 'third_party';
  return {
    canonicalUrl,
    domain,
    ownership,
    entityId: owner ? owner.id : null,
    entityName: owner ? owner.name : null,
  };
}

/**
 * Resolve effective stance per mention for a batch of responses, strictly matching each
 * response's `analysis_revision` and applying the latest human `mention_corrections` row.
 *
 * @param {Db} db
 * @param {Record<string, unknown>[]} responseRows
 * @param {Map<number, ActiveEntity>} entitiesById
 * @returns {Map<number, ResolvedMention[]>}
 */
export function resolveEffectiveMentions(db, responseRows, entitiesById) {
  /** @type {Map<number, ResolvedMention[]>} */
  const byResponse = new Map();
  if (responseRows.length === 0) return byResponse;

  /** @type {Map<number, string>} */
  const revisionByResponse = new Map();
  /** @type {number[]} */
  const responseIds = [];
  for (const row of responseRows) {
    const id = Number(row.id);
    responseIds.push(id);
    revisionByResponse.set(id, stringOrNull(row.analysis_revision) ?? 'legacy-heuristic-v1');
  }

  const mentionRows = chunkedInQuery(
    db,
    'SELECT id, response_id, entity_id, recommended FROM mentions WHERE response_id IN (',
    responseIds,
    ') ORDER BY response_id, id',
  );
  if (mentionRows.length === 0) return byResponse;

  const mentionIds = mentionRows.map((row) => Number(row.id));
  const interpRows = chunkedInQuery(
    db,
    `SELECT id, mention_id, analysis_revision, method, stance, legacy_recommended
     FROM mention_interpretations WHERE mention_id IN (`,
    mentionIds,
    ') ORDER BY id',
  );

  /** @type {Map<string, Record<string, unknown>>} */
  const interpByKey = new Map();
  const interpIds = [];
  for (const row of interpRows) {
    interpIds.push(Number(row.id));
    interpByKey.set(`${Number(row.mention_id)}:${String(row.analysis_revision)}`, row);
  }

  const corrRows = chunkedInQuery(
    db,
    'SELECT id, interpretation_id, replacement FROM mention_corrections WHERE interpretation_id IN (',
    interpIds,
    ') ORDER BY id ASC',
  );
  /** @type {Map<number, {id:number,replacement:string}>} */
  const latestCorrectionByInterp = new Map();
  for (const row of corrRows) {
    latestCorrectionByInterp.set(Number(row.interpretation_id), {
      id: Number(row.id),
      replacement: String(row.replacement),
    });
  }

  for (const m of mentionRows) {
    const entityId = Number(m.entity_id);
    const entity = entitiesById.get(entityId);
    if (!entity) continue; // archived entity excluded
    const responseId = Number(m.response_id);
    const mentionId = Number(m.id);
    const targetRev = revisionByResponse.get(responseId) ?? 'legacy-heuristic-v1';
    const interp = interpByKey.get(`${mentionId}:${targetRev}`) ?? null;
    const interpId = interp ? Number(interp.id) : null;
    const corr = interpId === null ? null : (latestCorrectionByInterp.get(interpId) ?? null);
    const effectiveStance = corr
      ? corr.replacement
      : (interp && interp.stance !== null ? String(interp.stance) : null);
    const isLegacyUncorrected = !corr && (!interp || String(interp.method) === 'legacy_heuristic');
    const resolved = {
      mentionId,
      responseId,
      entityId,
      entityName: entity.name,
      isSelf: entity.isSelf,
      effectiveStance,
      isPositive: effectiveStance === 'positive',
      isLegacyUncorrected,
      interpretationId: interpId,
      correctionId: corr ? corr.id : null,
    };
    let list = byResponse.get(responseId);
    if (!list) { list = []; byResponse.set(responseId, list); }
    list.push(resolved);
  }
  return byResponse;
}

/**
 * Query eligible tracking responses joined with `runs` and `prompts`, honoring exact-series
 * filters and default `includeSeeded: false`.
 *
 * @param {Db} db
 * @param {ForensicFilters} [filters]
 * @param {{completedRunsOnly?:boolean,ignoreSearchPolicyFilter?:boolean}} [opts]
 * @returns {Record<string, unknown>[]}
 */
export function queryForensicResponses(db, filters = {}, opts = {}) {
  const f = filters ?? {};
  const clauses = [
    'r.error IS NULL',
    "r.text IS NOT NULL AND trim(r.text) <> ''",
    "(r.lane = 'tracking' OR r.lane IS NULL)",
    "(r.target_status = 'completed' OR r.target_status IS NULL)",
    "(r.comparability_status = 'comparable' OR r.comparability_status IS NULL)",
    "(r.answer_status = 'complete' OR r.answer_status IS NULL)",
    "(COALESCE(r.search_policy, 'legacy') <> 'required' OR r.web_status = 'verified')",
  ];
  /** @type {(string|number|null)[]} */
  const params = [];

  if (f.includeSeeded !== true) clauses.push("x.trigger <> 'seed'");
  if (opts.completedRunsOnly === true) clauses.push("x.status = 'done'");

  if (f.series) {
    clauses.push('r.surface IS ?');
    clauses.push('r.execution_profile_id IS ?');
    clauses.push('r.benchmark_revision_id IS ?');
    clauses.push('r.analysis_revision IS ?');
    clauses.push('r.comparison_key IS ?');
    params.push(
      f.series.surface ?? null,
      f.series.executionProfileId ?? null,
      f.series.benchmarkRevisionId ?? null,
      f.series.analysisRevision ?? null,
      f.series.comparisonKey ?? null,
    );
    if (!opts.ignoreSearchPolicyFilter) {
      clauses.push('r.search_policy IS ?');
      params.push(f.series.searchPolicy ?? null);
    }
    const windowStart = f.start ?? f.series.start;
    const windowEnd = f.end ?? f.series.end;
    if (windowStart) { clauses.push('r.created_at >= ?'); params.push(String(windowStart)); }
    if (windowEnd) { clauses.push('r.created_at < ?'); params.push(String(windowEnd)); }
  } else {
    if (f.start) { clauses.push('r.created_at >= ?'); params.push(String(f.start)); }
    if (f.end) { clauses.push('r.created_at < ?'); params.push(String(f.end)); }
  }

  if (f.surface) { clauses.push('r.surface = ?'); params.push(String(f.surface)); }
  if (f.provider) { clauses.push('r.provider = ?'); params.push(String(f.provider)); }
  if (f.model) { clauses.push('r.model = ?'); params.push(String(f.model)); }
  if (f.searchPolicy && !opts.ignoreSearchPolicyFilter) {
    clauses.push('r.search_policy = ?');
    params.push(String(f.searchPolicy));
  }
  if (f.comparisonKey) { clauses.push('r.comparison_key = ?'); params.push(String(f.comparisonKey)); }
  if (f.runId !== undefined && f.runId !== null) {
    const runId = Number(f.runId);
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new RangeError('runId must be a positive integer');
    clauses.push('r.run_id = ?');
    params.push(runId);
  }
  if (f.intentId !== undefined && f.intentId !== null) {
    const intentId = Number(f.intentId);
    if (!Number.isSafeInteger(intentId) || intentId <= 0) throw new RangeError('intentId must be a positive integer');
    clauses.push('p.intent_id = ?');
    params.push(intentId);
  }
  if (f.excludeBranded === true) clauses.push("COALESCE(p.category, 'general') <> 'branded'");

  let rows = all(db, `SELECT r.id, r.run_id, r.prompt_id, r.provider, r.model, r.created_at,
      r.surface, r.execution_profile_id, r.benchmark_revision_id, r.analysis_revision,
      r.comparison_key, r.search_policy, r.web_status, r.answer_status, r.target_status,
      r.comparability_status, r.evidence_completeness, r.prompt_text_snapshot,
      p.text AS current_prompt_text, p.intent_id AS current_intent_id, p.category AS current_category,
      x.started_at AS run_started_at, x.finished_at AS run_finished_at, x.trigger AS run_trigger, x.status AS run_status
    FROM responses r
    JOIN runs x ON x.id = r.run_id
    LEFT JOIN prompts p ON p.id = r.prompt_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY r.created_at ASC, r.id ASC`, params);

  // Agent surfaces require verified web search for eligibility.
  rows = rows.filter((row) => !isAgentSurface(row.surface) || row.web_status === 'verified');

  const requestedSeriesKey = f.seriesKey ?? f.seriesId;
  if (requestedSeriesKey) {
    const key = String(requestedSeriesKey);
    rows = rows.filter((row) => stringOrNull(row.comparison_key) === key || responseSeriesIdentity(row) === key);
  }
  return rows;
}

/** @param {Record<string, unknown>[]} rows */
function distinctSeriesSummary(rows) {
  /** @type {Map<string, {seriesId:string,surface:string|null,provider:string,model:string,searchPolicy:string|null,comparisonKey:string|null}>} */
  const map = new Map();
  for (const row of rows) {
    const sid = responseSeriesIdentity(row);
    if (!map.has(sid)) {
      map.set(sid, {
        seriesId: sid,
        surface: stringOrNull(row.surface),
        provider: String(row.provider),
        model: String(row.model),
        searchPolicy: stringOrNull(row.search_policy),
        comparisonKey: stringOrNull(row.comparison_key),
      });
    }
  }
  return [...map.values()];
}

/**
 * Forensics Analyzer 1: Retrieval-to-Citation Attrition & Own-Site Hijack Report.
 *
 * Compares retrieved sources (`source_observations`) against final cited URLs
 * (`answer_citations`) per eligible search-grounded response, broken down by domain
 * ownership (`brand_owned`, `competitor_owned`, `third_party`), and flags Own-Site
 * Hijacks where a brand-owned URL is cited while a competitor receives positive
 * effective stance (respecting latest human `mention_corrections`) and the brand does not.
 *
 * @param {Db} db
 * @param {ForensicFilters} [filters]
 */
export function retrievalAttritionReport(db, filters = {}) {
  const f = filters ?? {};
  const limit = f.limit === undefined ? DEFAULT_TOP_LIMIT : Number(f.limit);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit must be a positive integer');

  const { entities, byId, brand } = loadActiveEntities(db);
  const allScoped = queryForensicResponses(db, f);

  /** @type {Record<string, unknown>[]} */
  const memoryExcluded = [];
  /** @type {Record<string, unknown>[]} */
  const candidateGrounded = [];
  for (const row of allScoped) {
    const policy = stringOrNull(row.search_policy);
    const webStatus = stringOrNull(row.web_status);
    if (policy === 'off' || webStatus === 'not_used' || webStatus === 'not_applicable') {
      memoryExcluded.push(row);
    } else {
      candidateGrounded.push(row);
    }
  }

  const candidateIds = candidateGrounded.map((row) => Number(row.id));
  const rawSources = chunkedInQuery(
    db,
    'SELECT id, response_id, url, normalized_url, provenance FROM source_observations WHERE response_id IN (',
    candidateIds,
    ') ORDER BY response_id, id',
  );
  const rawCitations = chunkedInQuery(
    db,
    'SELECT id, response_id, source_observation_id, url, provenance, ordinal FROM answer_citations WHERE response_id IN (',
    candidateIds,
    ') ORDER BY response_id, ordinal, id',
  );

  /** @type {Map<number, Record<string, unknown>[]>} */
  const sourcesByResponse = new Map();
  for (const s of rawSources) {
    const rid = Number(s.response_id);
    let list = sourcesByResponse.get(rid);
    if (!list) { list = []; sourcesByResponse.set(rid, list); }
    list.push(s);
  }
  /** @type {Map<number, Record<string, unknown>[]>} */
  const citationsByResponse = new Map();
  for (const c of rawCitations) {
    const rid = Number(c.response_id);
    let list = citationsByResponse.get(rid);
    if (!list) { list = []; citationsByResponse.set(rid, list); }
    list.push(c);
  }

  const eligible = candidateGrounded.filter((row) => {
    const rid = Number(row.id);
    const webStatus = stringOrNull(row.web_status);
    return webStatus === 'verified'
      || (sourcesByResponse.get(rid)?.length ?? 0) > 0
      || (citationsByResponse.get(rid)?.length ?? 0) > 0;
  });

  const mentionsByResponse = resolveEffectiveMentions(db, eligible, byId);

  /** @param {UrlOwnership} ownership */
  const makeBucket = (ownership) => ({
    ownership,
    uniqueRetrievedSet: /** @type {Set<string>} */ (new Set()),
    uniqueCitedSet: /** @type {Set<string>} */ (new Set()),
    uniqueDroppedSet: /** @type {Set<string>} */ (new Set()),
    retrievedObservations: 0,
    citedObservations: 0,
    citedFromRetrievedObservations: 0,
    droppedObservations: 0,
  });

  const buckets = {
    brand_owned: makeBucket('brand_owned'),
    competitor_owned: makeBucket('competitor_owned'),
    third_party: makeBucket('third_party'),
  };

  /** @type {Set<string>} */
  const allRetrievedUrls = new Set();
  /** @type {Set<string>} */
  const allCitedUrls = new Set();
  /** @type {Set<string>} */
  const allDroppedUrls = new Set();

  /**
   * @typedef {{url:string,rawUrl:string,domain:string|null,ownership:UrlOwnership,
   *   entityId:number|null,entityName:string|null,retrievedCount:number,citedCount:number,
   *   droppedCount:number,dropRate:number|null,droppedResponseIds:number[],citedResponseIds:number[],
   *   responseIds:number[]}} UrlAttritionStat
   */
  /** @type {Map<string, UrlAttritionStat>} */
  const urlStats = new Map();

  /** @param {{canonicalUrl:string,domain:string|null,ownership:UrlOwnership,entityId:number|null,entityName:string|null}} info @param {string} rawUrl */
  const ensureUrlStat = (info, rawUrl) => {
    let stat = urlStats.get(info.canonicalUrl);
    if (!stat) {
      stat = {
        url: info.canonicalUrl,
        rawUrl,
        domain: info.domain,
        ownership: info.ownership,
        entityId: info.entityId,
        entityName: info.entityName,
        retrievedCount: 0,
        citedCount: 0,
        droppedCount: 0,
        dropRate: null,
        droppedResponseIds: [],
        citedResponseIds: [],
        responseIds: [],
      };
      urlStats.set(info.canonicalUrl, stat);
    }
    return stat;
  };

  /** @type {Map<string, {seriesId:string,surface:string|null,provider:string,model:string,
   *   searchPolicy:string|null,comparisonKey:string|null,n:number,answersWithSourceObservations:number,
   *   retrievedObservations:number,droppedObservations:number,hijackCount:number}>} */
  const seriesStats = new Map();
  /** @type {Map<string, {surface:string,total:number,withSources:number}>} */
  const surfaceSourceCoverage = new Map();

  let answersWithSourceObservations = 0;
  let answersWithCitations = 0;
  let retrievedObservations = 0;
  let citedObservations = 0;
  let citedFromRetrievedObservations = 0;
  let droppedObservations = 0;
  let ownCitedAnswers = 0;
  let legacyStanceSkippedOwnCited = 0;

  /** @type {{responseId:number,promptId:number,promptText:string,provider:string,model:string,
   *   surface:string|null,createdAt:string,ownCitedUrls:string[],recommendedCompetitors:string[],
   *   recommendedCompetitorIds:number[],brandStance:string|null}[]} */
  const hijackReceipts = [];

  for (const row of eligible) {
    const rid = Number(row.id);
    const surfaceName = stringOrNull(row.surface) ?? `${String(row.provider)}-api`;
    let cov = surfaceSourceCoverage.get(surfaceName);
    if (!cov) { cov = { surface: surfaceName, total: 0, withSources: 0 }; surfaceSourceCoverage.set(surfaceName, cov); }
    cov.total += 1;

    const sid = responseSeriesIdentity(row);
    let sStat = seriesStats.get(sid);
    if (!sStat) {
      sStat = {
        seriesId: sid,
        surface: stringOrNull(row.surface),
        provider: String(row.provider),
        model: String(row.model),
        searchPolicy: stringOrNull(row.search_policy),
        comparisonKey: stringOrNull(row.comparison_key),
        n: 0,
        answersWithSourceObservations: 0,
        retrievedObservations: 0,
        droppedObservations: 0,
        hijackCount: 0,
      };
      seriesStats.set(sid, sStat);
    }
    sStat.n += 1;

    const rSources = sourcesByResponse.get(rid) ?? [];
    const rCitations = citationsByResponse.get(rid) ?? [];
    if (rSources.length > 0) {
      answersWithSourceObservations += 1;
      cov.withSources += 1;
      sStat.answersWithSourceObservations += 1;
    }
    if (rCitations.length > 0) answersWithCitations += 1;

    /** @type {Set<number>} */
    const citedSourceIds = new Set();
    /** @type {Map<string, {info:ReturnType<typeof classifyUrlOwnership>,rawUrl:string}>} */
    const citedMap = new Map();
    /** @type {string[]} */
    const ownCitedUrls = [];

    for (const c of rCitations) {
      if (c.source_observation_id !== null && c.source_observation_id !== undefined) {
        citedSourceIds.add(Number(c.source_observation_id));
      }
      const rawUrl = String(c.url);
      const info = classifyUrlOwnership(rawUrl, null, entities, byId);
      if (!citedMap.has(info.canonicalUrl)) {
        citedMap.set(info.canonicalUrl, { info, rawUrl });
        if (info.ownership === 'brand_owned') ownCitedUrls.push(info.canonicalUrl);
      }
    }

    // Deduplicate retrieved sources per response by canonicalUrl while retaining all source IDs.
    /** @type {Map<string, {info:ReturnType<typeof classifyUrlOwnership>,rawUrl:string,sourceIds:number[]}>} */
    const retrievedMap = new Map();
    for (const s of rSources) {
      const rawUrl = String(s.url);
      const info = classifyUrlOwnership(rawUrl, stringOrNull(s.normalized_url), entities, byId);
      let entry = retrievedMap.get(info.canonicalUrl);
      if (!entry) {
        entry = { info, rawUrl, sourceIds: [] };
        retrievedMap.set(info.canonicalUrl, entry);
      }
      entry.sourceIds.push(Number(s.id));
    }

    for (const [canonicalUrl, entry] of citedMap) {
      const bucket = buckets[entry.info.ownership];
      bucket.uniqueCitedSet.add(canonicalUrl);
      bucket.citedObservations += 1;
      allCitedUrls.add(canonicalUrl);
      citedObservations += 1;
      const stat = ensureUrlStat(entry.info, entry.rawUrl);
      stat.citedCount += 1;
      stat.citedResponseIds.push(rid);
      if (!stat.responseIds.includes(rid)) stat.responseIds.push(rid);
    }

    for (const [canonicalUrl, entry] of retrievedMap) {
      const bucket = buckets[entry.info.ownership];
      bucket.uniqueRetrievedSet.add(canonicalUrl);
      bucket.retrievedObservations += 1;
      allRetrievedUrls.add(canonicalUrl);
      retrievedObservations += 1;
      sStat.retrievedObservations += 1;

      const wasCited = citedMap.has(canonicalUrl)
        || entry.sourceIds.some((sourceId) => citedSourceIds.has(sourceId));
      const stat = ensureUrlStat(entry.info, entry.rawUrl);
      stat.retrievedCount += 1;
      if (!stat.responseIds.includes(rid)) stat.responseIds.push(rid);

      if (wasCited) {
        bucket.citedFromRetrievedObservations += 1;
        citedFromRetrievedObservations += 1;
      } else {
        bucket.uniqueDroppedSet.add(canonicalUrl);
        bucket.droppedObservations += 1;
        allDroppedUrls.add(canonicalUrl);
        droppedObservations += 1;
        sStat.droppedObservations += 1;
        stat.droppedCount += 1;
        stat.droppedResponseIds.push(rid);
      }
    }

    // Own-Site Hijack Detection: brand URL cited in answer_citations, competitor has
    // effective stance === 'positive', and brand does NOT have effective stance === 'positive'.
    if (brand && ownCitedUrls.length > 0) {
      ownCitedAnswers += 1;
      const rMentions = mentionsByResponse.get(rid) ?? [];
      const brandMentions = rMentions.filter((m) => m.isSelf);
      const compMentions = rMentions.filter((m) => !m.isSelf);
      const hasLegacyOnly = rMentions.length > 0 && rMentions.every((m) => m.isLegacyUncorrected);
      if (hasLegacyOnly) {
        legacyStanceSkippedOwnCited += 1;
      } else {
        const brandPositive = brandMentions.some((m) => m.isPositive);
        const positiveCompetitors = compMentions.filter((m) => m.isPositive);
        if (!brandPositive && positiveCompetitors.length > 0) {
          /** @type {Map<number, string>} */
          const uniqueComps = new Map();
          for (const c of positiveCompetitors) uniqueComps.set(c.entityId, c.entityName);
          const sortedComps = [...uniqueComps.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0]);
          const brandStance = brandMentions[0]?.effectiveStance ?? null;
          sStat.hijackCount += 1;
          hijackReceipts.push({
            responseId: rid,
            promptId: Number(row.prompt_id),
            promptText: String(row.prompt_text_snapshot ?? row.current_prompt_text ?? ''),
            provider: String(row.provider),
            model: String(row.model),
            surface: stringOrNull(row.surface),
            createdAt: String(row.created_at),
            ownCitedUrls: [...ownCitedUrls].sort(),
            recommendedCompetitors: sortedComps.map(([, name]) => name),
            recommendedCompetitorIds: sortedComps.map(([id]) => id),
            brandStance,
          });
        }
      }
    }
  }

  for (const stat of urlStats.values()) {
    stat.dropRate = stat.retrievedCount > 0 ? stat.droppedCount / stat.retrievedCount : null;
  }

  /** @param {UrlAttritionStat} a @param {UrlAttritionStat} b */
  const sortByDropped = (a, b) => b.droppedCount - a.droppedCount
    || b.retrievedCount - a.retrievedCount || a.url.localeCompare(b.url);
  /** @param {UrlAttritionStat} a @param {UrlAttritionStat} b */
  const sortByCited = (a, b) => b.citedCount - a.citedCount
    || b.retrievedCount - a.retrievedCount || a.url.localeCompare(b.url);

  const allStats = [...urlStats.values()];
  const topDroppedBrandUrls = allStats
    .filter((s) => s.ownership === 'brand_owned' && s.droppedCount > 0)
    .sort(sortByDropped)
    .slice(0, limit);
  const topDroppedThirdPartyUrls = allStats
    .filter((s) => s.ownership === 'third_party' && s.droppedCount > 0)
    .sort(sortByDropped)
    .slice(0, limit);
  const topCitedUrls = allStats
    .filter((s) => s.citedCount > 0)
    .sort(sortByCited)
    .slice(0, limit);

  /** @param {ReturnType<typeof makeBucket>} bucket */
  const formatBucket = (bucket) => {
    const ci = wilson(bucket.droppedObservations, bucket.retrievedObservations);
    return {
      uniqueRetrievedUrls: bucket.uniqueRetrievedSet.size,
      uniqueCitedUrls: bucket.uniqueCitedSet.size,
      uniqueDroppedUrls: bucket.uniqueDroppedSet.size,
      retrievedObservations: bucket.retrievedObservations,
      citedObservations: bucket.citedObservations,
      citedFromRetrievedObservations: bucket.citedFromRetrievedObservations,
      droppedObservations: bucket.droppedObservations,
      attritionRate: { ...ci, dropped: bucket.droppedObservations },
    };
  };

  /** @type {string[]} */
  const limitations = [];
  if (!brand) {
    limitations.push('No active brand entity (is_self = 1) configured; brand-owned classification and own-site hijack detection are unavailable.');
  }
  if (memoryExcluded.length > 0) {
    limitations.push(`Excluded ${memoryExcluded.length} memory-only or non-search ${memoryExcluded.length === 1 ? 'response' : 'responses'} (search_policy='off' or web_status='not_used'/'not_applicable') from retrieval attrition.`);
  }
  for (const cov of [...surfaceSourceCoverage.values()].sort((a, b) => a.surface.localeCompare(b.surface))) {
    if (cov.total > 0 && cov.withSources === 0) {
      limitations.push(`Surface "${cov.surface}" has ${cov.total} search-grounded ${cov.total === 1 ? 'answer' : 'answers'} with no source_observations; retrieval attrition cannot be measured for routes that do not expose retrieved URLs.`);
    } else if (cov.withSources > 0 && cov.withSources < cov.total) {
      const missing = cov.total - cov.withSources;
      limitations.push(`Surface "${cov.surface}" has ${missing} of ${cov.total} search-grounded answers without source_observations; attrition metrics cover only answers with recorded observations.`);
    }
  }
  if (legacyStanceSkippedOwnCited > 0) {
    limitations.push(`${legacyStanceSkippedOwnCited} own-cited ${legacyStanceSkippedOwnCited === 1 ? 'answer uses' : 'answers use'} legacy-heuristic-v1 without stance labels and could not be evaluated for stance-based own-site hijacks.`);
  }
  const distinctSeries = distinctSeriesSummary(eligible);
  if (distinctSeries.length > 1) {
    const labels = distinctSeries.map((s) => `${s.provider}/${s.model} (${s.surface ?? 'unknown'})`).join(', ');
    limitations.push(`Filtered scope spans ${distinctSeries.length} distinct model/series configurations (${labels}); filter by surface, model, or seriesKey for strict single-series analysis.`);
  }
  if (eligible.length === 0 && memoryExcluded.length === 0) {
    limitations.push('No eligible search-grounded answers matched the selected filters.');
  }

  const overallCi = wilson(droppedObservations, retrievedObservations);
  const hijackCount = hijackReceipts.length;

  return {
    n: eligible.length,
    answersWithSourceObservations,
    answersWithCitations,
    answersWithoutSourceObservations: eligible.length - answersWithSourceObservations,
    totalUniqueRetrievedUrls: allRetrievedUrls.size,
    totalUniqueCitedUrls: allCitedUrls.size,
    totalUniqueDroppedUrls: allDroppedUrls.size,
    retrievedObservations,
    citedObservations,
    citedFromRetrievedObservations,
    droppedObservations,
    attritionRate: { ...overallCi, dropped: droppedObservations },
    byOwnership: {
      brand_owned: formatBucket(buckets.brand_owned),
      competitor_owned: formatBucket(buckets.competitor_owned),
      third_party: formatBucket(buckets.third_party),
    },
    topDroppedBrandUrls,
    topDroppedThirdPartyUrls,
    topCitedUrls,
    hijacks: {
      count: hijackCount,
      ownCitedAnswers,
      rate: wilson(hijackCount, ownCitedAnswers),
      overallRate: wilson(hijackCount, eligible.length),
      receipts: hijackReceipts,
    },
    bySeries: [...seriesStats.values()]
      .sort((a, b) => compareProviders(a.provider, b.provider) || a.model.localeCompare(b.model) || a.seriesId.localeCompare(b.seriesId))
      .map((s) => ({
        ...s,
        attritionRate: { ...wilson(s.droppedObservations, s.retrievedObservations), dropped: s.droppedObservations },
      })),
    limitations,
  };
}

/**
 * Forensics Analyzer 2: Parametric Memory vs. Live Retrieval Delta.
 *
 * Strictly pairs parametric memory responses (`search_policy = 'off'` OR `web_status = 'not_used'`,
 * which is Hearsay's persisted representation of `noSearchConfirmed = true`) against verified live
 * retrieval responses (`search_policy IN ('auto', 'required')` AND `web_status = 'verified'`) on
 * identical `prompt_id` within the exact same `(provider, model)` — never blending across models.
 *
 * @param {Db} db
 * @param {ForensicFilters} [filters]
 */
export function memoryVsRetrievalDelta(db, filters = {}) {
  const f = filters ?? {};
  const { entities, byId, brand } = loadActiveEntities(db);
  const rows = queryForensicResponses(db, f, { ignoreSearchPolicyFilter: true });

  /** @typedef {'memory'|'grounded'} DeltaMode */
  /** @type {Map<string, {provider:string,model:string,surfaces:Set<string>,memoryByPrompt:Map<number,Record<string,unknown>[]>,groundedByPrompt:Map<number,Record<string,unknown>[]>,promptTexts:Map<number,string>}>} */
  const groups = new Map();
  let unclassifiedCount = 0;

  for (const row of rows) {
    const policy = stringOrNull(row.search_policy);
    const webStatus = stringOrNull(row.web_status);
    /** @type {DeltaMode|null} */
    let mode = null;
    if ((policy === 'off' && webStatus !== 'verified') || webStatus === 'not_used') {
      mode = 'memory';
    } else if ((policy === 'auto' || policy === 'required') && webStatus === 'verified') {
      mode = 'grounded';
    } else {
      unclassifiedCount += 1;
      continue;
    }

    const provider = String(row.provider);
    const model = String(row.model);
    const groupKey = `${provider}\0${model}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        provider,
        model,
        surfaces: new Set(),
        memoryByPrompt: new Map(),
        groundedByPrompt: new Map(),
        promptTexts: new Map(),
      };
      groups.set(groupKey, group);
    }
    const surfaceName = stringOrNull(row.surface);
    if (surfaceName) group.surfaces.add(surfaceName);

    const promptId = Number(row.prompt_id);
    if (!group.promptTexts.has(promptId)) {
      group.promptTexts.set(promptId, String(row.prompt_text_snapshot ?? row.current_prompt_text ?? ''));
    }
    const targetMap = mode === 'memory' ? group.memoryByPrompt : group.groundedByPrompt;
    let bucket = targetMap.get(promptId);
    if (!bucket) { bucket = []; targetMap.set(promptId, bucket); }
    bucket.push(row);
  }

  // Batch-load mentions and grounded citations only for paired responses.
  /** @type {Record<string, unknown>[]} */
  const allPairedResponses = [];
  /** @type {number[]} */
  const allPairedGroundedIds = [];
  for (const group of groups.values()) {
    for (const [promptId, memList] of group.memoryByPrompt) {
      const gndList = group.groundedByPrompt.get(promptId);
      if (!gndList) continue;
      allPairedResponses.push(...memList, ...gndList);
      for (const r of gndList) allPairedGroundedIds.push(Number(r.id));
    }
  }

  const mentionsByResponse = resolveEffectiveMentions(db, allPairedResponses, byId);
  const citationRows = chunkedInQuery(
    db,
    'SELECT response_id, url FROM answer_citations WHERE response_id IN (',
    allPairedGroundedIds,
    ') ORDER BY response_id, ordinal, id',
  );
  /** @type {Map<number, Set<number>>} */
  const citedEntitiesByResponse = new Map();
  for (const c of citationRows) {
    const info = classifyUrlOwnership(String(c.url), null, entities, byId);
    if (info.entityId === null) continue;
    const rid = Number(c.response_id);
    let set = citedEntitiesByResponse.get(rid);
    if (!set) { set = new Set(); citedEntitiesByResponse.set(rid, set); }
    set.add(info.entityId);
  }

  /** @type {string[]} */
  const limitations = [];
  if (!brand) {
    limitations.push('No active brand entity (is_self = 1) configured; brand-specific delta and prompt classifications are unavailable.');
  }
  if (unclassifiedCount > 0) {
    limitations.push(`Excluded ${unclassifiedCount} ${unclassifiedCount === 1 ? 'response' : 'responses'} with legacy or unverified search state from parametric memory vs. live retrieval pairing.`);
  }

  const sortedGroups = [...groups.values()].sort(
    (a, b) => compareProviders(a.provider, b.provider) || a.model.localeCompare(b.model),
  );

  let pairedModels = 0;
  let unpairedModels = 0;
  let totalPairedPrompts = 0;
  let legacyPairedCount = 0;

  const pairs = sortedGroups.map((group) => {
    const memoryPromptIds = [...group.memoryByPrompt.keys()].sort((a, b) => a - b);
    const groundedPromptIds = [...group.groundedByPrompt.keys()].sort((a, b) => a - b);
    const groundedSet = new Set(groundedPromptIds);
    const memorySet = new Set(memoryPromptIds);

    const pairedPromptIds = memoryPromptIds.filter((id) => groundedSet.has(id));
    const memoryOnlyPromptIds = memoryPromptIds.filter((id) => !groundedSet.has(id));
    const groundedOnlyPromptIds = groundedPromptIds.filter((id) => !memorySet.has(id));

    const memoryOnlyResponseCount = memoryOnlyPromptIds.reduce(
      (sum, id) => sum + (group.memoryByPrompt.get(id)?.length ?? 0), 0);
    const groundedOnlyResponseCount = groundedOnlyPromptIds.reduce(
      (sum, id) => sum + (group.groundedByPrompt.get(id)?.length ?? 0), 0);

    /** @type {'paired'|'memory_only'|'grounded_only'|'no_overlap'} */
    const status = pairedPromptIds.length > 0 ? 'paired'
      : memoryPromptIds.length > 0 && groundedPromptIds.length === 0 ? 'memory_only'
      : groundedPromptIds.length > 0 && memoryPromptIds.length === 0 ? 'grounded_only'
      : 'no_overlap';

    if (status === 'paired') {
      pairedModels += 1;
      totalPairedPrompts += pairedPromptIds.length;
    } else {
      unpairedModels += 1;
      if (status === 'memory_only') {
        limitations.push(`${group.provider}/${group.model} has ${memoryOnlyPromptIds.length} memory-only ${memoryOnlyPromptIds.length === 1 ? 'prompt' : 'prompts'} and no verified live-retrieval runs; paired delta unavailable.`);
      } else if (status === 'grounded_only') {
        limitations.push(`${group.provider}/${group.model} has ${groundedOnlyPromptIds.length} grounded-only ${groundedOnlyPromptIds.length === 1 ? 'prompt' : 'prompts'} and no parametric memory runs; paired delta unavailable.`);
      } else {
        limitations.push(`${group.provider}/${group.model} has both memory and grounded runs, but on disjoint prompts (0 overlapping prompt_ids); paired delta unavailable.`);
      }
    }

    /** @type {Record<string, unknown>[]} */
    const pairedMemoryResponses = [];
    /** @type {Record<string, unknown>[]} */
    const pairedGroundedResponses = [];
    for (const pid of pairedPromptIds) {
      pairedMemoryResponses.push(...(group.memoryByPrompt.get(pid) ?? []));
      pairedGroundedResponses.push(...(group.groundedByPrompt.get(pid) ?? []));
    }

    for (const r of [...pairedMemoryResponses, ...pairedGroundedResponses]) {
      const rMentions = mentionsByResponse.get(Number(r.id)) ?? [];
      if (rMentions.some((m) => m.isLegacyUncorrected)) legacyPairedCount += 1;
    }

    const memN = pairedMemoryResponses.length;
    const gndN = pairedGroundedResponses.length;

    const entityDeltas = entities.map((entity) => {
      let memMentioned = 0;
      let memPositive = 0;
      let gndMentioned = 0;
      let gndPositive = 0;
      let gndCited = 0;

      const classificationCounts = {
        memory_anchored: 0,
        search_dependent: 0,
        memory_displaced: 0,
        absent_in_both: 0,
      };

      const promptClassifications = pairedPromptIds.map((promptId) => {
        const memList = group.memoryByPrompt.get(promptId) ?? [];
        const gndList = group.groundedByPrompt.get(promptId) ?? [];
        let pMemMentioned = 0;
        let pMemPositive = 0;
        let pGndMentioned = 0;
        let pGndPositive = 0;
        let pGndCited = 0;

        for (const r of memList) {
          const rid = Number(r.id);
          const eMentions = (mentionsByResponse.get(rid) ?? []).filter((m) => m.entityId === entity.id);
          if (eMentions.length > 0) {
            pMemMentioned += 1;
            if (eMentions.some((m) => m.isPositive)) pMemPositive += 1;
          }
        }
        for (const r of gndList) {
          const rid = Number(r.id);
          const eMentions = (mentionsByResponse.get(rid) ?? []).filter((m) => m.entityId === entity.id);
          if (eMentions.length > 0) {
            pGndMentioned += 1;
            if (eMentions.some((m) => m.isPositive)) pGndPositive += 1;
          }
          if (citedEntitiesByResponse.get(rid)?.has(entity.id)) pGndCited += 1;
        }

        memMentioned += pMemMentioned;
        memPositive += pMemPositive;
        gndMentioned += pGndMentioned;
        gndPositive += pGndPositive;
        gndCited += pGndCited;

        const inMem = pMemMentioned > 0;
        const inGnd = pGndMentioned > 0;
        /** @type {'memory_anchored'|'search_dependent'|'memory_displaced'|'absent_in_both'} */
        const classification = inMem && inGnd ? 'memory_anchored'
          : !inMem && inGnd ? 'search_dependent'
          : inMem && !inGnd ? 'memory_displaced'
          : 'absent_in_both';
        classificationCounts[classification] += 1;

        return {
          promptId,
          promptText: group.promptTexts.get(promptId) ?? '',
          classification,
          memoryMentioned: pMemMentioned,
          memoryN: memList.length,
          groundedMentioned: pGndMentioned,
          groundedN: gndList.length,
          memoryPositive: pMemPositive,
          groundedPositive: pGndPositive,
          groundedCited: pGndCited,
          memoryResponseIds: memList.map((r) => Number(r.id)),
          groundedResponseIds: gndList.map((r) => Number(r.id)),
        };
      });

      const memoryMentionRate = wilson(memMentioned, memN);
      const groundedMentionRate = wilson(gndMentioned, gndN);
      const deltaMentionRate = memoryMentionRate.p !== null && groundedMentionRate.p !== null
        ? groundedMentionRate.p - memoryMentionRate.p : null;
      const memoryPositiveRate = wilson(memPositive, memN);
      const groundedPositiveRate = wilson(gndPositive, gndN);
      const deltaPositiveRate = memoryPositiveRate.p !== null && groundedPositiveRate.p !== null
        ? groundedPositiveRate.p - memoryPositiveRate.p : null;
      const groundedCitationRate = wilson(gndCited, gndN);

      return {
        entityId: entity.id,
        name: entity.name,
        isSelf: entity.isSelf,
        memoryMentionRate,
        groundedMentionRate,
        deltaMentionRate,
        memoryPositiveRate,
        groundedPositiveRate,
        deltaPositiveRate,
        groundedCitationRate,
        classificationCounts,
        promptClassifications,
      };
    });

    const brandDelta = entityDeltas.find((e) => e.isSelf) ?? null;
    const competitors = entityDeltas.filter((e) => !e.isSelf);
    const surfaces = [...group.surfaces].sort();
    if (status === 'paired' && surfaces.length > 1) {
      limitations.push(`${group.provider}/${group.model} pairs responses across multiple surfaces (${surfaces.join(', ')}); pass filters.surface to restrict to a single surface.`);
    }

    return {
      provider: group.provider,
      model: group.model,
      surfaces,
      status,
      pairedPromptCount: pairedPromptIds.length,
      pairedPromptIds,
      memoryResponseCount: memN,
      groundedResponseCount: gndN,
      unpaired: {
        memoryOnlyPromptCount: memoryOnlyPromptIds.length,
        memoryOnlyPromptIds,
        memoryOnlyResponseCount,
        groundedOnlyPromptCount: groundedOnlyPromptIds.length,
        groundedOnlyPromptIds,
        groundedOnlyResponseCount,
      },
      brand: brandDelta,
      competitors,
      entities: entityDeltas,
      brandPromptClassifications: brandDelta ? brandDelta.promptClassifications : [],
      classificationSummary: brandDelta ? brandDelta.classificationCounts : {
        memory_anchored: 0,
        search_dependent: 0,
        memory_displaced: 0,
        absent_in_both: 0,
      },
    };
  });

  if (legacyPairedCount > 0) {
    limitations.push(`${legacyPairedCount} paired ${legacyPairedCount === 1 ? 'response uses' : 'responses use'} legacy-heuristic-v1 without stance labels; positive stance rates exclude uncorrected legacy mentions.`);
  }
  if (pairs.length === 0) {
    limitations.push('No eligible parametric memory or verified live-retrieval responses matched the selected filters.');
  }

  return {
    brand: brand ? { entityId: brand.id, name: brand.name } : null,
    pairs,
    summary: {
      totalModels: pairs.length,
      pairedModels,
      unpairedModels,
      totalPairedPrompts,
    },
    limitations,
  };
}
