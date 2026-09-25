import { all, get, isoNow, run } from './db.js';
import { normalizeObservedQuery, sourceGroupingUrl } from './measurement-contract.js';
import { answerReview } from './interpretations.js';

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
    && (!['codex-agent', 'claude-code-agent'].includes(String(row.surface)) || row.web_status === 'verified');
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
    searchActions: [], searchQueries: [], sourceObservations: [], answerCitations: [], mentions: [],
  }]));

  const actions = childRows(db, ids, 'search_events');
  const queries = childRows(db, ids, 'search_queries');
  const sources = childRows(db, ids, 'source_observations');
  const citations = childRows(db, ids, 'answer_citations');
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
      const normalizedUrl = source.normalizedUrl ?? sourceGroupingUrl(source.url);
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
