import { AGENT_ROUTES } from './agent-routes.js';
import { createHash } from 'node:crypto';

export const SEARCH_POLICIES = /** @type {const} */ (['off', 'auto', 'required', 'legacy']);
export const ANSWER_STATUSES = /** @type {const} */ (['complete', 'empty', 'refused', 'truncated', 'incomplete', 'failed']);
export const SEARCH_STATES = /** @type {const} */ (['verified', 'not_used', 'unavailable', 'unverified', 'failed', 'not_applicable']);

/** @typedef {typeof SEARCH_POLICIES[number]} SearchPolicy */
/** @typedef {typeof ANSWER_STATUSES[number]} AnswerStatus */
/** @typedef {typeof SEARCH_STATES[number]} SearchState */
/** @typedef {'complete'|'partial'|'unavailable'} EvidenceCompleteness */
/** @typedef {'search'|'fetch'} ActionKind */
/** @typedef {'started'|'completed'|'failed'|'denied'|'unavailable'} ActionStatus */
/**
 * @typedef {{id:string, kind:ActionKind, status:ActionStatus, queryMetadata:'available'|'unavailable',
 *   queries:string[], observedAt:string|null, providerType:string|null}} SearchAction
 */
/**
 * @typedef {{id:string, url:string, title:string|null, excerpt?:string|null,
 *   provenance:'search_result'|'reported_source'|'fetch', actionId:string|null,
 *   order:number|null}} SourceObservation
 */
/**
 * @typedef {{url:string, provenance:'native_annotation'|'explicit_reference'|'text_link',
 *   sourceId:string|null, start:number|null, end:number|null}} AnswerCitation
 */
/**
 * @typedef {{targetId:string, attempt:number, continuation:number, component:string,
 *   quantity:number|null, unit:string, costUsd:number|null,
 *   costStatus:'known'|'partial'|'unavailable', priceVersion:string|null}} UsageComponent
 */
/**
 * @typedef {{targetId:string, attempt:number, continuation:number, status:'started'|'complete'|'failed'|'cancelled',
 *   actions:SearchAction[], usage:UsageComponent[]}} AttemptReceipt
 */
/**
 * @typedef {{question:string, envelopeVersion:string|null, actions:SearchAction[],
 *   sources:SourceObservation[], citations:AnswerCitation[], answer:string,
 *   answerStatus:AnswerStatus, returnedModel:string|null, attempts:AttemptReceipt[]}} EvidenceReceipt
 */

const ROUTE_CAPABILITIES = /** @type {const} */ ({
  'openai-chat-completions-v1': { surface: 'openai-api', policies: ['off'] },
  'openai-responses-web-search-v1': { surface: 'openai-api', policies: ['auto', 'required'] },
  'anthropic-messages-v1': { surface: 'anthropic-api', policies: ['off'] },
  'anthropic-messages-web-search-v1': { surface: 'anthropic-api', policies: ['auto'] },
  'gemini-generate-content-v1': { surface: 'gemini-api', policies: ['off'] },
  'gemini-generate-content-google-search-v1': { surface: 'gemini-api', policies: ['auto'] },
  'perplexity-sonar-v1': { surface: 'perplexity-api', policies: ['legacy'] },
  ...Object.fromEntries(AGENT_ROUTES.map((route) => [route.profile, { surface: route.id, policies: ['required'] }])),
});

/**
 * @param {string} route
 * @param {string} surface
 * @param {SearchPolicy} policy
 * @returns {void}
 */
export function assertRoutePolicy(route, surface, policy) {
  const capability = /** @type {{surface:string, policies:readonly string[]}|undefined} */ (
    /** @type {Record<string, unknown>} */ (ROUTE_CAPABILITIES)[route]
  );
  if (!capability || capability.surface !== surface || !capability.policies.includes(policy)) {
    throw new RangeError(`Unsupported search policy ${policy} for ${surface} on ${route}`);
  }
}

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** @param {unknown} value @returns {string} */
export function stableIdentity(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** @param {unknown} value @returns {unknown} */
function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(Object.entries(record)
      .filter(([key]) => !/(?:api.?key|authorization|auth.?token|access.?token|bearer.?token|secret|password|credential|private.?key)/i.test(key))
      .map(([key, item]) => [key, withoutSecrets(item)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('Profile settings must be finite');
  return value;
}

/**
 * @typedef {Object} ExecutionProfileInput
 * @property {string} surface
 * @property {string} route
 * @property {string} model
 * @property {SearchPolicy} searchPolicy
 * @property {string|null} [toolVersion]
 * @property {string|null} [envelopeVersion]
 * @property {string|null} [locationControl]
 * @property {string|null} [languageControl]
 * @property {Record<string, unknown>} [requestSettings]
 * @property {Record<string, unknown>} [limits]
 */

/**
 * @param {ExecutionProfileInput} input
 * @returns {{id:string, snapshot:Record<string, unknown>}}
 */
export function executionProfile(input) {
  assertRoutePolicy(input.route, input.surface, input.searchPolicy);
  if (!input.model) throw new TypeError('Execution profile requires a model');
  const snapshot = {
    surface: input.surface,
    route: input.route,
    model: input.model,
    searchPolicy: input.searchPolicy,
    toolVersion: input.toolVersion ?? null,
    envelopeVersion: input.envelopeVersion ?? null,
    locationControl: input.locationControl ?? 'uncontrolled',
    languageControl: input.languageControl ?? 'uncontrolled',
    requestSettings: withoutSecrets(input.requestSettings ?? {}),
    limits: withoutSecrets(input.limits ?? {}),
  };
  return { id: stableIdentity(snapshot), snapshot };
}

/**
 * @typedef {{id:string|number, intentId:string|number|null, category:string, text:string}} BenchmarkQuestion
 * @typedef {{id:string|number, role:'brand'|'competitor', name:string, aliases:string[], domains:string[]}} BenchmarkEntity
 * @typedef {{questions:BenchmarkQuestion[], entities:BenchmarkEntity[], weighting:'equal', scope:string}} BenchmarkInput
 */

/**
 * @param {BenchmarkInput} input
 * @returns {{id:string, snapshot:BenchmarkInput}}
 */
export function benchmarkRevision(input) {
  if (input.weighting !== 'equal') throw new RangeError('Only equal prompt weights are supported');
  if (!Array.isArray(input.questions) || input.questions.length === 0) throw new TypeError('Benchmark requires questions');
  const snapshot = structuredClone(input);
  return { id: stableIdentity(snapshot), snapshot };
}

/**
 * @param {{executionProfileId:string, benchmarkRevisionId:string, analysisRevision:string,
 *   start:string, end:string}} input
 * @returns {{id:string, executionProfileId:string, benchmarkRevisionId:string, analysisRevision:string,
 *   start:string, end:string}}
 */
export function comparisonSelection(input) {
  for (const key of ['executionProfileId', 'benchmarkRevisionId', 'analysisRevision']) {
    if (!input[/** @type {'executionProfileId'|'benchmarkRevisionId'|'analysisRevision'} */ (key)]) {
      throw new TypeError(`Comparison selection requires ${key}`);
    }
  }
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!utc.test(input.start) || !utc.test(input.end) || !Number.isFinite(Date.parse(input.start)) ||
      !Number.isFinite(Date.parse(input.end)) || Date.parse(input.start) >= Date.parse(input.end)) {
    throw new RangeError('Comparison selection requires an ordered half-open UTC window');
  }
  const snapshot = {
    executionProfileId: input.executionProfileId,
    benchmarkRevisionId: input.benchmarkRevisionId,
    analysisRevision: input.analysisRevision,
    start: input.start,
    end: input.end,
  };
  return { ...snapshot, id: stableIdentity(snapshot) };
}

/** @param {string} query @returns {string} */
export function normalizeObservedQuery(query) {
  return query.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** @param {string} original @returns {string|null} */
export function sourceGroupingUrl(original) {
  try {
    const url = new URL(original);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * @param {{actions:SearchAction[], sources:SourceObservation[], citations:AnswerCitation[]}} evidence
 * @returns {{searchActions:number, queryOccurrences:number, sourceObservations:number, answerCitations:number,
 *   queryMetadata:'available'|'unavailable'}}
 */
export function evidenceCounts(evidence) {
  const searches = evidence.actions.filter((action) => action.kind === 'search');
  return {
    searchActions: searches.length,
    queryOccurrences: searches.reduce((count, action) => count + action.queries.length, 0),
    sourceObservations: evidence.sources.length,
    answerCitations: evidence.citations.length,
    queryMetadata: searches.some((action) => action.queryMetadata === 'available') ? 'available' : 'unavailable',
  };
}

/**
 * @param {{policy:SearchPolicy, answerStatus:AnswerStatus, actions:SearchAction[],
 *   noSearchConfirmed?:boolean}} input
 * @returns {{searchState:SearchState, evidenceCompleteness:EvidenceCompleteness,
 *   comparable:boolean, exclusion:string|null}}
 */
export function assessObservation(input) {
  const searches = input.actions.filter((action) => action.kind === 'search');
  const complete = searches.some((action) => action.status === 'completed');
  const failed = searches.some((action) => action.status === 'failed' || action.status === 'denied');
  const unfinished = searches.some((action) => action.status === 'started' || action.status === 'unavailable');
  /** @type {SearchState} */
  let searchState = 'unverified';
  if (input.policy === 'off') searchState = 'not_applicable';
  else if (complete) searchState = 'verified';
  else if (failed) searchState = 'failed';
  else if (input.policy === 'auto' && input.noSearchConfirmed && searches.length === 0) searchState = 'not_used';
  else if (searches.length === 0 && input.policy === 'legacy') searchState = 'unavailable';
  /** @type {EvidenceCompleteness} */
  const evidenceCompleteness = failed || unfinished ? 'partial' : searchState === 'unavailable' || searchState === 'unverified' ? 'unavailable' : 'complete';
  const exclusion = input.answerStatus !== 'complete' ? `answer_${input.answerStatus}`
    : input.policy === 'off' && searches.length > 0 ? 'off_policy_search_observed'
      : input.policy === 'auto' && evidenceCompleteness === 'partial' ? 'search_execution_partial'
    : input.policy === 'required' && searchState !== 'verified' ? 'required_search_unverified'
      : input.policy === 'required' && evidenceCompleteness !== 'complete' ? 'required_search_partial'
        : null;
  return { searchState, evidenceCompleteness, comparable: exclusion === null, exclusion };
}
