import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** @typedef {Record<string, any>} ResearchRecord */
export const RESEARCH_MAX_BYTES = 8 * 1024 * 1024;
const schemas = Object.fromEntries(['project', 'evidence'].map((name) => [name,
  JSON.parse(readFileSync(new URL(`../skill/schemas/${name}.schema.json`, import.meta.url), 'utf8'))]));

export class ResearchError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'ResearchError'; this.code = code; }
}

/** @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** @param {unknown} value */
export function researchHash(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new ResearchError('invalid_bundle', message); }

/** @param {any} value @param {ResearchRecord} schema @param {string} path @param {number} [depth] */
function validateShape(value, schema, path, depth = 0) {
  check(depth < 40, `${path}: nesting limit exceeded`);
  if (schema.anyOf) {
    for (const alternative of schema.anyOf) {
      try { validateShape(value, alternative, path, depth + 1); return; } catch {}
    }
    throw new ResearchError('invalid_bundle', `${path}: invalid value`);
  }
  if ('const' in schema) check(value === schema.const, `${path}: unsupported version`);
  if (schema.enum) check(schema.enum.includes(value), `${path}: invalid choice`);
  const types = schema.type ? [schema.type].flat() : [];
  if (types.length) check(types.some((type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type), `${path}: invalid type`);
  if (typeof value === 'string') {
    check(!schema.minLength || value.length >= schema.minLength, `${path}: empty string`);
    check(!schema.maxLength || value.length <= schema.maxLength, `${path}: too long`);
    if (schema.pattern) check(new RegExp(schema.pattern).test(value), `${path}: invalid identifier`);
    if (schema.format === 'date-time') check(/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), `${path}: invalid timestamp`);
    if (schema.format === 'http-url') check(isHttpUrl(value), `${path}: expected HTTP(S) URL`);
  }
  if (typeof value === 'number') check(Number.isFinite(value) && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum), `${path}: out of range`);
  if (Array.isArray(value)) {
    check(!schema.maxItems || value.length <= schema.maxItems, `${path}: too many items`);
    value.forEach((item, index) => validateShape(item, schema.items ?? {}, `${path}[${index}]`, depth + 1));
  } else if (value && typeof value === 'object') {
    check(!schema.maxProperties || Object.keys(value).length <= schema.maxProperties, `${path}: too many properties`);
    for (const key of schema.required ?? []) check(Object.hasOwn(value, key), `${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      check(!['__proto__', 'constructor', 'prototype'].includes(key), `${path}: unsafe key`);
      check(item === '[REDACTED]' || !/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credentials)$/i.test(key), `${path}: credential field`);
      if (schema.additionalProperties === false) check(Object.hasOwn(schema.properties ?? {}, key), `${path}.${key}: unknown field`);
      validateShape(item, schema.properties?.[key] ?? {}, `${path}.${key}`, depth + 1);
    }
  }
}
/** @param {string} value */
function isHttpUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }
/** @param {ResearchRecord[]} items @param {string} name */
function unique(items, name) { const ids = items.map((item) => item.id); check(new Set(ids).size === ids.length, `${name}: duplicate id`); return new Set(ids); }
/** @param {ResearchRecord} app @param {ResearchRecord} panel */
export function questionIsNeutral(app, panel, text = '') {
  const normalized = ` ${String(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return ![app, ...panel.competitors].some((brand) => [brand.name, ...(brand.aliases ?? []), ...(brand.url ? [new URL(brand.url).hostname.replace(/^www\./, '')] : [])]
    .some((alias) => normalized.includes(` ${String(alias).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `)));
}
/** @param {ResearchRecord} value */
function validatePanel(value) { unique(value.questions, 'questions'); unique(value.competitors, 'competitors'); }
/** @param {unknown} input @param {'project'|'evidence'} name @returns {ResearchRecord} */
function parse(input, name) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  check(Buffer.byteLength(text) <= RESEARCH_MAX_BYTES, 'Bundle exceeds 8 MiB');
  let value;
  try { value = JSON.parse(text); } catch { throw new ResearchError('invalid_bundle', 'Invalid JSON'); }
  validateShape(value, schemas[name], name);
  check(!/(?:Bearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAIza[A-Za-z0-9_-]{30,}|\bsk-[A-Za-z0-9_-]{20,})/.test(text), 'Credential-like content is not allowed');
  return value;
}
/** @param {unknown} input @returns {ResearchRecord} */
export function validateProject(input) {
  const project = parse(input, 'project');
  for (const [collection, current] of [['panels', 'panel'], ['executions', 'execution'], ['analyses', 'analysis']]) {
    const ids = unique(project[collection], collection);
    check(ids.has(project.current[current]), `Unknown current ${current}`);
  }
  project.panels.forEach(validatePanel);
  project.executions.forEach((/** @type {ResearchRecord} */ execution) => unique(execution.routes, 'routes'));
  const execution = project.executions.find((/** @type {ResearchRecord} */ row) => row.id === project.current.execution);
  check(new Set(project.selectedRoutes).size === project.selectedRoutes.length, 'Duplicate selected route');
  check(project.selectedRoutes.every((/** @type {string} */ id) => execution.routes.some((/** @type {ResearchRecord} */ route) => route.id === id)), 'Selection is not in execution revision');
  const evidence = unique(project.discoveryEvidence, 'discovery evidence');
  for (const panel of project.panels) for (const competitor of panel.competitors) check(competitor.evidenceIds.every((/** @type {string} */ id) => evidence.has(id)), 'Competitor has missing discovery evidence');
  return project;
}
/** @param {unknown} input @returns {ResearchRecord} */
export function validateEvidence(input) {
  const bundle = parse(input, 'evidence');
  validatePanel(bundle.panel);
  const questionIds = new Set(bundle.panel.questions.map((/** @type {ResearchRecord} */ q) => q.id));
  const routeIds = unique(bundle.execution.routes, 'routes');
  const evidenceIds = unique(bundle.evidence, 'evidence');
  const sampleIds = unique(bundle.samples, 'samples');
  unique(bundle.recommendations, 'recommendations');
  const brands = new Set([bundle.app.id, ...bundle.panel.competitors.map((/** @type {ResearchRecord} */ b) => b.id)]);
  check(brands.size === bundle.panel.competitors.length + 1, 'App and competitor ids overlap');
  const evidence = new Map(bundle.evidence.map((/** @type {ResearchRecord} */ e) => [e.id, e]));
  for (const item of bundle.evidence) {
    check(item.sampleId === null || sampleIds.has(item.sampleId), `Evidence ${item.id}: unknown sample`);
    if (['returned_source', 'fetched_page', 'final_citation'].includes(item.type)) check(isHttpUrl(item.data.url), `Evidence ${item.id}: invalid source URL`);
    if (item.type === 'answer') check(typeof item.data.text === 'string', `Evidence ${item.id}: missing answer text`);
    if (item.type === 'search_query') check(item.data.query === null || typeof item.data.query === 'string', `Evidence ${item.id}: query must be exposed or null`);
    if (item.type === 'tool_outcome') check(['started', 'completed', 'failed', 'denied', 'unavailable'].includes(item.data.status)
      && ['search', 'fetch'].includes(item.data.tool), `Evidence ${item.id}: invalid tool outcome`);
  }
  for (const competitor of bundle.panel.competitors) check(competitor.evidenceIds.every((/** @type {string} */ id) => evidenceIds.has(id)), `Competitor ${competitor.id}: missing evidence`);
  for (const sample of bundle.samples) {
    check(questionIds.has(sample.questionId) && routeIds.has(sample.routeId), `Sample ${sample.id}: unknown question or route`);
    const route = bundle.execution.routes.find((/** @type {ResearchRecord} */ r) => r.id === sample.routeId);
    check(route.provider === sample.provider && route.profile === sample.profile, `Sample ${sample.id}: execution mismatch`);
    check(sample.status === 'skipped' || sample.startedAt !== null, `Sample ${sample.id}: missing start time`);
    check(sample.status !== 'completed' || sample.finishedAt !== null, `Sample ${sample.id}: missing completion time`);
    check(sample.status !== 'completed' || sample.errorCode === null, `Sample ${sample.id}: completed answer carries a terminal error`);
    check(!sample.startedAt || !sample.finishedAt || Date.parse(sample.finishedAt) >= Date.parse(sample.startedAt), `Sample ${sample.id}: reversed timestamps`);
    check(sample.evidenceIds.every((/** @type {string} */ id) => evidenceIds.has(id) && evidence.get(id).sampleId === sample.id), `Sample ${sample.id}: broken evidence reference`);
    for (const id of sample.evidenceIds) {
      const item = evidence.get(id);
      check(item.origin === sample.origin && item.capture === sample.capture, `Sample ${sample.id}: provenance mismatch`);
    }
    for (const mention of sample.mentions) {
      const answer = evidence.get(mention.answerId);
      check(brands.has(mention.brandId) && sample.evidenceIds.includes(mention.answerId) && answer?.type === 'answer'
        && answer.data.text.includes(mention.excerpt), `Sample ${sample.id}: unsupported mention`);
      check(mention.position === null || mention.positive, `Sample ${sample.id}: position requires recommendation`);
      if (mention.stance !== undefined) check(mention.positive === (mention.stance === 'positive'), `Sample ${sample.id}: inconsistent stance`);
    }
  }
  const slots = new Map();
  for (const sample of bundle.samples) {
    const slot = `${sample.routeId}:${sample.questionId}`;
    slots.set(slot, (slots.get(slot) ?? 0) + 1);
    check(slots.get(slot) <= bundle.execution.samples, 'Sample count exceeds the saved panel slot count');
  }
  for (const action of bundle.recommendations) {
    check(action.evidenceIds.length > 0 && action.evidenceIds.every((/** @type {string} */ id) => evidenceIds.has(id)), `Recommendation ${action.id}: missing evidence`);
    check(action.repeatMeasurement.questionIds.every((/** @type {string} */ id) => questionIds.has(id)), `Recommendation ${action.id}: unknown repeat question`);
    check((action.repeatMeasurement.routeIds ?? []).every((/** @type {string} */ id) => routeIds.has(id)), `Recommendation ${action.id}: unknown repeat route`);
    check(action.draftPath === null || /^drafts\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/.test(action.draftPath) && !action.draftPath.includes('..'), 'Unsafe draft path');
  }
  return bundle;
}

/** @param {ResearchRecord} bundle @param {ResearchRecord} sample */
export function sampleEligibility(bundle, sample) {
  const reasons = [];
  const question = bundle.panel.questions.find((/** @type {ResearchRecord} */ q) => q.id === sample.questionId);
  const evidence = bundle.evidence.filter((/** @type {ResearchRecord} */ e) => sample.evidenceIds.includes(e.id));
  if (sample.status !== 'completed') reasons.push('answer_not_completed');
  if (sample.errorCode !== null) reasons.push('terminal_error');
  if (!evidence.some((/** @type {ResearchRecord} */ e) => e.type === 'answer' && e.data.text.trim())) reasons.push('answer_unavailable');
  if (!questionIsNeutral(bundle.app, bundle.panel, question?.text)) reasons.push('branded_question');
  if (sample.origin === 'host_research') reasons.push('research_context');
  if (sample.brandContext !== false) reasons.push('brand_context_present_or_unknown');
  if (sample.sessionIsolation !== true) reasons.push('session_not_isolated');
  if (!evidence.some((/** @type {ResearchRecord} */ e) => e.type === 'tool_outcome' && e.data.tool === 'search' && e.data.status === 'completed')) reasons.push('completed_search_unavailable');
  return { eligible: reasons.length === 0, reasons, verification: sample.capture === 'runner_captured' ? 'external_runner_capture' : 'host_reported' };
}

/** @param {ResearchRecord} bundle @param {{completePanel?:boolean}} [options] */
export function summarizeEvidence(bundle, options = {}) {
  /** @type {Map<string, ResearchRecord>} */ const groups = new Map();
  for (const sample of bundle.samples) {
    const key = canonicalJson([sample.routeId, sample.provider, sample.model, sample.profile, sample.capture, sample.origin]);
    if (!groups.has(key)) groups.set(key, { route: sample.routeId, provider: sample.provider, model: sample.model, profile: sample.profile,
      capture: sample.capture, origin: sample.origin, planned: 0, unrecorded: 0, attempted: 0, completed: 0, failed: 0, partial: 0, skipped: 0, eligible: 0, mentioned: 0, recommended: 0 });
    const group = /** @type {ResearchRecord} */ (groups.get(key));
    group.planned++;
    if (sample.startedAt !== null) group.attempted++;
    group[sample.status]++;
    if (sampleEligibility(bundle, sample).eligible) {
      group.eligible++;
      if (sample.mentions.some((/** @type {ResearchRecord} */ m) => m.brandId === bundle.app.id && m.confidence === 'certain')) group.mentioned++;
      if (sample.mentions.some((/** @type {ResearchRecord} */ m) => m.brandId === bundle.app.id && m.confidence === 'certain' && m.positive)) group.recommended++;
    }
  }
  for (const route of bundle.execution.routes) {
    if (options.completePanel === false) break;
    const recorded = bundle.samples.filter((/** @type {ResearchRecord} */ sample) => sample.routeId === route.id).length;
    const missing = Math.max(0, bundle.panel.questions.length * bundle.execution.samples - recorded);
    if (!missing) continue;
    const matches = [...groups.values()].filter((group) => group.route === route.id);
    if (matches.length === 1) { matches[0].planned += missing; matches[0].unrecorded = missing; }
    else groups.set(`unrecorded:${route.id}`, { route: route.id, provider: route.provider, model: null, profile: route.profile, capture: 'unavailable', origin: 'unavailable',
      planned: missing, unrecorded: missing, attempted: 0, completed: 0, failed: 0, partial: 0, skipped: 0, eligible: 0, mentioned: 0, recommended: 0 });
  }
  return [...groups.values()];
}
