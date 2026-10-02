import { createHash } from 'node:crypto';
import { canonicalJson, questionIsNeutral, validateEvidence, validateProject } from './research-contract.js';

/** @typedef {Record<string, any>} StudyRecord */
export const STUDY_MAX_BYTES = 8 * 1024 * 1024;
export const STUDY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const credentialContent = /(?:Bearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAIza[A-Za-z0-9_-]{30,}|\bsk-[A-Za-z0-9_-]{20,}|\btvly-[A-Za-z0-9_-]{12,})/;
const credentialField = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credentials)$/i;

export class StudyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'StudyError'; this.code = code; }
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
export function checkStudy(condition, message) { if (!condition) throw new StudyError('invalid_study', message); }
/** @param {unknown} value */
export function studyHash(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
/** @param {string|Uint8Array} value */
export function studyTextHash(value) { return createHash('sha256').update(value).digest('hex'); }
/** @param {unknown} value @param {string} [name] */
export function studyIdentifier(value, name = 'id') { checkStudy(typeof value === 'string' && STUDY_ID.test(value), `${name}: invalid identifier`); return value; }
/** @param {unknown} value @param {string} [name] */
export function studyUrl(value, name = 'url') {
  checkStudy(typeof value === 'string' && value.length <= 8192, `${name}: invalid URL`);
  try { const url = new URL(value); checkStudy(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, `${name}: expected HTTP(S) URL without credentials`); }
  catch { throw new StudyError('invalid_study', `${name}: invalid URL`); }
  return value;
}
/** @param {unknown} value @param {string} name @param {boolean} [nullable] */
function timestamp(value, name, nullable = false) {
  if (nullable && value === null) return;
  checkStudy(typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), `${name}: invalid timestamp`);
}
/** @param {unknown} value @param {string} name @param {number} [limit] */
function text(value, name, limit = 100000) { checkStudy(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, `${name}: expected nonempty text`); }
/** @param {unknown} value @param {string} name */
function object(value, name) { checkStudy(value !== null && typeof value === 'object' && !Array.isArray(value), `${name}: expected object`); }
/** @param {unknown} value @param {string} name @param {number} [max] */
function array(value, name, max = 10000) { checkStudy(Array.isArray(value) && value.length <= max, `${name}: invalid array`); }
/** @param {any} value @param {string} name @param {number} min @param {number} max */
function number(value, name, min, max) { checkStudy(Number.isFinite(value) && value >= min && value <= max, `${name}: out of range`); }
/** @param {any} value @param {string} name @param {number} min @param {number} max */
function integer(value, name, min, max) { number(value, name, min, max); checkStudy(Number.isSafeInteger(value), `${name}: expected integer`); }
/** @param {any[]} items @param {string} name */
function unique(items, name) { const ids = items.map((item) => typeof item === 'string' ? studyIdentifier(item, name) : studyIdentifier(item.id, name)); checkStudy(new Set(ids).size === ids.length, `${name}: duplicate identifier`); return new Set(ids); }
/** @param {unknown} value @param {string} name */
function ids(value, name) { array(value, name); return unique(/** @type {any[]} */ (value), name); }
/** @param {unknown} input @param {boolean} [boundRecordSize] @returns {StudyRecord} */
function parse(input, boundRecordSize = true) {
  let source;
  try { source = typeof input === 'string' ? input : JSON.stringify(input); } catch { throw new StudyError('invalid_study', 'Expected JSON data'); }
  checkStudy(typeof source === 'string' && (!boundRecordSize || Buffer.byteLength(source) <= STUDY_MAX_BYTES), 'Study record exceeds 8 MiB');
  let value;
  try { value = JSON.parse(source); } catch { throw new StudyError('invalid_study', 'Invalid JSON'); }
  object(value, 'record');
  /** @param {any} item @param {number} depth */
  const scan = (item, depth) => {
    checkStudy(depth < 40, 'Nesting limit exceeded');
    if (typeof item === 'string') checkStudy(!credentialContent.test(item), 'Credential-like content is not allowed');
    if (typeof item === 'number') checkStudy(Number.isFinite(item), 'Nonfinite values are not allowed');
    if (Array.isArray(item)) { checkStudy(item.length <= 10000, 'Too many array entries'); item.forEach((entry) => scan(entry, depth + 1)); }
    else if (item && typeof item === 'object') {
      checkStudy(Object.keys(item).length <= 1000, 'Too many object fields');
      for (const [key, entry] of Object.entries(item)) {
        checkStudy(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe object key');
        checkStudy(!credentialField.test(key) || entry === '[REDACTED]', 'Credential fields are not allowed');
        scan(entry, depth + 1);
      }
    }
  };
  scan(value, 0); return value;
}
/** @param {unknown} value @param {string} name */
function relativePath(value, name) {
  checkStudy(typeof value === 'string' && value.length <= 1024 && /^[a-zA-Z0-9._/-]+$/.test(value) && !value.startsWith('/') && !value.split('/').some((part) => !part || part === '.' || part === '..'), `${name}: unsafe relative path`);
}

/** @param {StudyRecord} scope @param {StudyRecord} permissions */
function decisionScope(scope, permissions) {
  object(scope, 'decision scope'); array(scope.actions, 'decision actions', 100);
  checkStudy(scope.actions.length > 0 && new Set(scope.actions).size === scope.actions.length && scope.actions.every((/** @type {unknown} */ action) => typeof action === 'string' && permissions.actions.includes(action)), 'Decision exceeds plan action permissions');
  checkStudy(scope.repository === permissions.repository && scope.publishTarget === permissions.publishTarget, 'Decision target differs from plan permissions');
}

/** @param {unknown} input @returns {StudyRecord} */
export function validateStudyPlan(input) {
  const plan = parse(input);
  const known = ['version', 'id', 'studyId', 'appId', 'createdAt', 'app', 'targetUrl', 'comparison', 'outcome', 'angles', 'questions', 'collection', 'tavily', 'permissions', 'reportDestination', 'research'];
  checkStudy(Object.keys(plan).every((key) => known.includes(key)), 'Plan has unknown fields');
  checkStudy(plan.version === 1, 'Unsupported study plan version'); studyIdentifier(plan.id); studyIdentifier(plan.studyId, 'studyId');
  if (plan.createdAt !== undefined) timestamp(plan.createdAt, 'createdAt');
  object(plan.app, 'app'); studyIdentifier(plan.app.id, 'app.id'); text(plan.app.name, 'app.name');
  checkStudy(plan.appId === undefined || plan.appId === plan.app.id, 'App identity mismatch');
  if (plan.app.url !== null) studyUrl(plan.app.url, 'app.url');
  array(plan.app.aliases, 'app.aliases', 50); plan.app.aliases.forEach((/** @type {unknown} */ alias) => text(alias, 'app alias'));
  text(plan.app.audience, 'app.audience'); array(plan.app.useCases, 'app.useCases', 100); plan.app.useCases.forEach((/** @type {unknown} */ job) => text(job, 'use case'));
  studyUrl(plan.targetUrl, 'targetUrl');
  object(plan.comparison, 'comparison');
  checkStudy(['before_after', 'unchanged_reference', 'controlled_allocation'].includes(plan.comparison.design), 'Invalid comparison design');
  if (plan.comparison.referenceUrl !== null) studyUrl(plan.comparison.referenceUrl, 'referenceUrl');
  if (plan.comparison.design === 'unchanged_reference') checkStudy(plan.comparison.referenceUrl !== null && plan.comparison.referenceUrl !== plan.targetUrl, 'An unchanged reference needs a different page');
  checkStudy(plan.comparison.assignment === null || typeof plan.comparison.assignment === 'string' || typeof plan.comparison.assignment === 'object', 'Invalid assignment');
  if (plan.comparison.design === 'controlled_allocation') checkStudy((typeof plan.comparison.assignment === 'string' && plan.comparison.assignment.trim()) || (plan.comparison.assignment && typeof plan.comparison.assignment.method === 'string' && plan.comparison.assignment.method.trim()), 'Controlled allocation needs an assignment method');
  checkStudy(typeof plan.comparison.trafficNotes === 'string', 'Missing traffic notes');
  object(plan.outcome, 'outcome'); text(plan.outcome.metric, 'outcome.metric'); text(plan.outcome.unit, 'outcome.unit');
  integer(plan.outcome.minimumDenominator, 'minimumDenominator', 1, 1e12); integer(plan.outcome.minimumObservations, 'minimumObservations', 1, 1e12);
  number(plan.outcome.minimumEffect, 'minimumEffect', 0, 1e12); number(plan.outcome.lossLimit, 'lossLimit', 0, 1e12); integer(plan.outcome.reviewPeriodDays, 'reviewPeriodDays', 1, 3652);
  array(plan.outcome.stopRules, 'stopRules', 100); checkStudy(plan.outcome.stopRules.length > 0, 'At least one stop rule is required'); plan.outcome.stopRules.forEach((/** @type {unknown} */ rule) => text(rule, 'stop rule'));
  array(plan.angles, 'angles', 100); array(plan.questions, 'questions', 100); checkStudy(plan.angles.length > 0 && plan.questions.length > 0, 'Angles and questions are required');
  const angles = unique(plan.angles, 'angles'); const questions = unique(plan.questions, 'questions');
  for (const angle of plan.angles) {
    text(angle.label, 'angle.label'); text(angle.buyerJob, 'angle.buyerJob'); text(angle.rationale, 'angle.rationale'); ids(angle.evidenceIds, 'angle evidence'); const linked = ids(angle.questionIds, 'angle questions');
    checkStudy(linked.size > 0 && angle.questionIds.every((/** @type {string} */ id) => questions.has(id)), 'Angle has missing questions');
    checkStudy(angle.questionIds.every((/** @type {string} */ id) => plan.questions.some((/** @type {StudyRecord} */ question) => question.id === id && question.angleId === angle.id)), 'Angle/question relation mismatch');
  }
  for (const question of plan.questions) {
    studyIdentifier(question.angleId, 'question.angleId'); text(question.text, 'question.text');
    checkStudy(angles.has(question.angleId) && plan.angles.find((/** @type {StudyRecord} */ angle) => angle.id === question.angleId).questionIds.includes(question.id), 'Question has missing angle');
    checkStudy(questionIsNeutral(plan.app, { competitors: [] }, question.text), 'Tracked questions must be neutral');
  }
  object(plan.collection, 'collection'); checkStudy(typeof plan.collection.at === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plan.collection.at), 'Invalid collection time');
  text(plan.collection.timezone, 'timezone', 256); try { new Intl.DateTimeFormat('en', { timeZone: plan.collection.timezone }); } catch { throw new StudyError('invalid_study', 'Invalid collection timezone'); }
  integer(plan.collection.occurrences, 'occurrences', 1, 3652); integer(plan.collection.maxDays, 'maxDays', 1, 3652);
  integer(plan.collection.firstReviewDays, 'firstReviewDays', 1, plan.collection.maxDays); integer(plan.collection.reviewEveryDays, 'reviewEveryDays', 1, plan.collection.maxDays);
  object(plan.tavily, 'tavily'); checkStudy(typeof plan.tavily.enabled === 'boolean' && typeof plan.tavily.strictFreeMode === 'boolean', 'Invalid Tavily selection');
  checkStudy(['basic', 'advanced'].includes(plan.tavily.searchDepth), 'Invalid search depth');
  checkStudy(plan.tavily.accountId === null || typeof plan.tavily.accountId === 'string', 'Invalid Tavily account'); if (plan.tavily.enabled) studyIdentifier(plan.tavily.accountId, 'tavily.accountId');
  integer(plan.tavily.maxResults, 'maxResults', 1, 20); for (const key of ['collectionCredits', 'diagnosticCredits', 'allowance']) integer(plan.tavily[key], key, 0, 1e6);
  const collectionCost = plan.questions.length * plan.collection.occurrences * (plan.tavily.searchDepth === 'advanced' ? 2 : 1);
  checkStudy(plan.tavily.collectionCredits >= collectionCost || !plan.tavily.enabled && plan.tavily.collectionCredits === 0, 'Tavily collection allowance cannot cover the plan');
  checkStudy(plan.tavily.allowance >= plan.tavily.collectionCredits + plan.tavily.diagnosticCredits, 'Tavily allowance cannot cover both lanes');
  object(plan.permissions, 'permissions'); array(plan.permissions.actions, 'permission actions', 100); plan.permissions.actions.forEach((/** @type {unknown} */ action) => text(action, 'permission action', 256));
  checkStudy(new Set(plan.permissions.actions).size === plan.permissions.actions.length, 'Duplicate permission action');
  for (const key of ['repository', 'publishTarget']) checkStudy(plan.permissions[key] === null || typeof plan.permissions[key] === 'string', `Invalid permission ${key}`);
  checkStudy(plan.reportDestination === null || typeof plan.reportDestination === 'string' || typeof plan.reportDestination === 'object', 'Invalid report destination');
  if (plan.reportDestination?.kind === 'local') relativePath(plan.reportDestination.path, 'Report path');
  if (plan.research !== null) {
    object(plan.research, 'research'); for (const key of ['projectHash', 'runQuote', 'scheduleQuote']) text(plan.research[key], `research.${key}`, 256);
    integer(plan.research.targetCount, 'research.targetCount', 1, 1000); object(plan.research.runPreview, 'runPreview'); object(plan.research.schedulePreview, 'schedulePreview');
    checkStudy(plan.research.runPreview.quoteId === plan.research.runQuote && plan.research.schedulePreview.quoteId === plan.research.scheduleQuote, 'Research preview does not match its quotes');
  }
  return plan;
}

/** @param {string} kind @param {unknown} input @returns {StudyRecord} */
export function validateStudyRecord(kind, input) {
  const row = parse(input);
  checkStudy(['approval', 'page', 'version', 'search-run', 'research-run', 'change', 'event', 'outcome', 'review', 'analysis'].includes(kind), 'Unknown study record kind');
  checkStudy(row.version === 1, 'Unsupported study record version'); for (const key of ['id', 'studyId', 'appId']) studyIdentifier(row[key], key);
  for (const key of ['createdAt', 'timestamp', 'capturedAt', 'approvedAt', 'publishedAt', 'attemptedAt', 'finishedAt', 'startedAt', 'completedAt', 'periodStart', 'periodEnd']) if (row[key] !== undefined) timestamp(row[key], key, true);
  for (const key of ['planId', 'pageId', 'changeId', 'decisionId', 'revertsVersionId', 'runId', 'occurrenceId', 'approvalId', 'activeVersionId', 'searchRunId', 'researchRunId', 'analysisId']) if (row[key] !== undefined && row[key] !== null) studyIdentifier(row[key], key);
  for (const key of ['evidenceIds', 'occurrenceIds']) if (row[key] !== undefined) ids(row[key], key);
  for (const key of ['originalPath', 'contentPath', 'draftPath']) if (row[key] !== undefined && row[key] !== null) relativePath(row[key], key);
  if (kind === 'approval') { studyIdentifier(row.planId); text(row.planHash, 'planHash', 256); text(row.quoteId, 'quoteId', 256); text(row.author, 'author'); timestamp(row.approvedAt, 'approvedAt'); object(row.scope, 'scope'); }
  if (kind === 'page') {
    studyUrl(row.requestedUrl, 'requestedUrl'); studyUrl(row.finalUrl, 'finalUrl'); text(row.method, 'method', 256); text(row.extractionRevision, 'extractionRevision', 256); timestamp(row.capturedAt, 'capturedAt');
    for (const key of ['originalSha256', 'contentSha256']) checkStudy(typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key]), `Invalid ${key}`);
    relativePath(row.originalPath, 'originalPath'); relativePath(row.contentPath, 'contentPath');
    checkStudy(row.originalPath.startsWith(`pages/${row.id}/`) && row.contentPath.startsWith(`pages/${row.id}/`), 'Capture paths do not match page identity');
    if (row.content !== undefined) checkStudy(typeof row.content === 'string', 'Invalid extracted page content');
  }
  if (kind === 'version') { studyIdentifier(row.pageId); checkStudy(['captured', 'published', 'reverted'].includes(row.status), 'Invalid page version status'); text(row.author, 'author'); }
  if (kind === 'change') { text(row.hypothesis, 'hypothesis'); ids(row.evidenceIds, 'change evidence'); checkStudy(['proposed', 'drafted', 'published', 'reverted', 'rejected'].includes(row.status), 'Invalid change status'); }
  if (kind === 'event') {
    text(row.type, 'event type', 256);
    if (row.type.startsWith('occurrence_')) { studyIdentifier(row.occurrenceId); studyIdentifier(row.planId); text(row.status, 'occurrence status', 256); timestamp(row.attemptedAt, 'attemptedAt'); ids(row.evidenceIds, 'occurrence evidence'); }
    if (row.type === 'owner_decision') {
      studyIdentifier(row.planId); text(row.author, 'decision author'); text(row.reason, 'decision reason');
      checkStudy(['approve', 'accept', 'reject', 'suggest_change', 'keep', 'revise', 'revert', 'ignore'].includes(row.action), 'Invalid owner decision');
      if (['approve', 'accept', 'revert'].includes(row.action)) { object(row.scope, 'decision scope'); array(row.scope.actions, 'decision actions', 100); checkStudy(row.scope.actions.length > 0, 'Decision action scope is empty'); }
    }
  }
  if (kind === 'research-run') { studyIdentifier(row.runId); if (row.evidence !== undefined) validateEvidence(row.evidence); }
  if (kind === 'search-run') {
    text(row.status, 'search status', 256); array(row.records, 'search records', 100); unique(row.records, 'search record ids');
    if (row.lane !== undefined) checkStudy(['collection', 'diagnostic'].includes(row.lane), 'Invalid search lane');
    if (row.searchDepth !== undefined) checkStudy(['basic', 'advanced'].includes(row.searchDepth), 'Invalid search depth');
    for (const search of row.records) {
      studyIdentifier(search.questionId, 'questionId'); studyIdentifier(search.angleId, 'angleId'); text(search.query, 'search query'); text(search.status, 'search record status', 256);
      number(search.credits, 'search credits', 0, 1000000); array(search.results, 'search results', 20);
      for (const source of search.results) { studyUrl(source.url, 'search source URL'); checkStudy(typeof source.title === 'string' && typeof source.content === 'string', 'Search source text unavailable'); number(source.score, 'search relevance score', 0, 1); }
    }
    if (row.exposures !== undefined) array(row.exposures, 'search exposures');
  }
  if (kind === 'outcome') {
    text(row.source, 'source'); text(row.recordKey, 'recordKey'); studyUrl(row.pageUrl, 'pageUrl'); timestamp(row.periodStart, 'periodStart'); timestamp(row.periodEnd, 'periodEnd');
    checkStudy(Date.parse(row.periodEnd) >= Date.parse(row.periodStart), 'Outcome period is reversed'); text(row.metric, 'metric'); text(row.unit, 'unit'); number(row.value, 'value', 0, 1e15);
    if (row.denominator !== null) number(row.denominator, 'denominator', 0, 1e15);
    checkStudy(row.currency === null || typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency), 'Invalid outcome currency');
    checkStudy(row.attributionMethod === null || typeof row.attributionMethod === 'string', 'Invalid attribution method'); checkStudy(typeof row.trafficNotes === 'string', 'Missing outcome traffic notes');
    checkStudy(['baseline', 'after'].includes(row.phase), 'Invalid outcome phase');
    if (row.rawCsv !== undefined) checkStudy(studyTextHash(row.rawCsv) === row.rawCsvSha256, 'CSV source hash mismatch');
  }
  if (kind === 'analysis') { ids(row.occurrenceIds, 'analysis occurrences'); ids(row.evidenceIds, 'analysis evidence'); for (const key of ['recommendation', 'reason', 'nextAction', 'author']) text(row[key], key); }
  if (kind === 'review') { checkStudy(typeof row.markdown === 'string', 'A saved review needs markdown'); if (row.evidenceIds !== undefined) ids(row.evidenceIds, 'review evidence'); }
  return row;
}

export const STUDY_COLLECTIONS = { approval: 'approvals', page: 'pages', version: 'versions', 'search-run': 'searchRuns', 'research-run': 'researchRuns', change: 'changes', event: 'events', outcome: 'outcomes', review: 'reviews', analysis: 'analyses' };

/** @param {unknown} input @returns {StudyRecord} */
export function validateStudySnapshot(input) {
  const snapshot = parse(input, false); object(snapshot.manifest, 'manifest');
  const { manifest } = snapshot; checkStudy(manifest.version === 1, 'Unsupported study manifest version'); for (const key of ['id', 'studyId', 'appId']) studyIdentifier(manifest[key], key);
  checkStudy(manifest.id === manifest.studyId, 'Study manifest identity mismatch'); array(snapshot.plans, 'plans', 1000);
  snapshot.plans = snapshot.plans.map(validateStudyPlan); checkStudy(snapshot.plans.length > 0, 'No study plans'); unique(snapshot.plans, 'plans');
  snapshot.plan = validateStudyPlan(snapshot.plan); checkStudy(snapshot.plan.id === manifest.currentPlanId && snapshot.plans.some((/** @type {StudyRecord} */ plan) => studyHash(plan) === studyHash(snapshot.plan)), 'Current plan mismatch');
  for (const plan of snapshot.plans) checkStudy(plan.studyId === manifest.studyId && plan.app.id === manifest.appId, 'Plan belongs to a different study');
  array(snapshot.discoveryEvidence ?? [], 'discoveryEvidence');
  if (snapshot.discoveryEvidence?.length) {
    const project = { schemaVersion: 1, app: snapshot.plan.app, discoveryEvidence: snapshot.discoveryEvidence,
      panels: [{ id: 'study-validation-panel', createdAt: '2026-01-01T00:00:00Z', reviewedAt: null, questions: [], competitors: [] }],
      executions: [{ id: 'study-validation-execution', routes: [], samples: 1, timeoutMs: null, idleTimeoutMs: null, maxOutputBytes: null, envelope: 'study-validation', language: 'uncontrolled', location: 'uncontrolled' }],
      analyses: [{ id: 'study-validation-analysis', method: 'study-validation' }], current: { panel: 'study-validation-panel', execution: 'study-validation-execution', analysis: 'study-validation-analysis' }, selectedRoutes: [], tracking: { timezone: null, schedule: null, targetCeiling: null } };
    try { validateProject(project); } catch { throw new StudyError('invalid_study', 'Invalid discovery evidence'); }
  }
  for (const [kind, collection] of Object.entries(STUDY_COLLECTIONS)) {
    array(snapshot[collection], collection); snapshot[collection] = snapshot[collection].map((/** @type {unknown} */ row) => validateStudyRecord(kind, row)); unique(snapshot[collection], collection);
    for (const row of snapshot[collection]) checkStudy(row.studyId === manifest.studyId && row.appId === manifest.appId, 'Record belongs to a different study');
  }
  const sets = Object.fromEntries(['plans', ...Object.values(STUDY_COLLECTIONS)].map((key) => [key, new Set(snapshot[key].map((/** @type {StudyRecord} */ row) => row.id))]));
  const evidence = new Set([...Object.values(sets).flatMap((set) => [...set]), ...(snapshot.discoveryEvidence ?? []).map((/** @type {StudyRecord} */ row) => row.id), ...snapshot.researchRuns.flatMap((/** @type {StudyRecord} */ run) => (run.evidence?.evidence ?? []).map((/** @type {StudyRecord} */ row) => row.id))]);
  const occurrences = new Set(snapshot.events.filter((/** @type {StudyRecord} */ event) => event.type.startsWith('occurrence_')).map((/** @type {StudyRecord} */ event) => event.occurrenceId));
  const references = { planId: 'plans', pageId: 'pages', changeId: 'changes', decisionId: 'events', revertsVersionId: 'versions', approvalId: 'approvals', activeVersionId: 'versions', searchRunId: 'searchRuns', researchRunId: 'researchRuns', analysisId: 'analyses' };
  for (const collection of Object.values(STUDY_COLLECTIONS)) for (const row of snapshot[collection]) {
    for (const [key, target] of Object.entries(references)) if (row[key] !== undefined && row[key] !== null) checkStudy(sets[target].has(row[key]), `${row.id}: unresolved ${key}`);
    if (row.evidenceIds !== undefined) checkStudy(row.evidenceIds.every((/** @type {string} */ id) => evidence.has(id)), `${row.id}: unresolved evidence`);
    if (row.occurrenceIds !== undefined) checkStudy(row.occurrenceIds.every((/** @type {string} */ id) => occurrences.has(id)), `${row.id}: unresolved occurrence`);
    if (collection === 'approvals') { const plan = snapshot.plans.find((/** @type {StudyRecord} */ plan) => plan.id === row.planId); checkStudy(row.planHash === studyHash(plan) && row.quoteId === studyHash({ version: 1, plan }), 'Approval does not bind its plan'); checkStudy(studyHash(row.scope) === studyHash(plan), 'Approval scope differs from its plan'); }
    if (collection === 'researchRuns' && row.evidence) checkStudy(row.evidence.runId === row.runId && row.evidence.app.id === manifest.appId, 'Research run identity mismatch');
    if (collection === 'pages' && row.content !== undefined) checkStudy(studyTextHash(row.content) === row.contentSha256, 'Extracted page content hash mismatch');
    if (collection === 'searchRuns' && row.lane !== 'diagnostic') {
      const searchPlan = snapshot.plans.find((/** @type {StudyRecord} */ plan) => plan.id === row.planId) ?? snapshot.plan;
      for (const result of row.records) {
        const question = searchPlan.questions.find((/** @type {StudyRecord} */ question) => question.id === result.questionId);
        checkStudy(question?.angleId === result.angleId && question.text === result.query, 'Search receipt changed a tracked question');
      }
      if (row.searchDepth !== undefined) checkStudy(row.searchDepth === searchPlan.tavily.searchDepth, 'Search receipt changed the approved depth');
    }
    if (collection === 'events' && row.type === 'owner_decision' && ['approve', 'accept', 'revert'].includes(row.action)) {
      const decisionPlan = snapshot.plans.find((/** @type {StudyRecord} */ plan) => plan.id === row.planId); decisionScope(row.scope, decisionPlan.permissions);
    }
    if (collection === 'versions' && row.decisionId) {
      const decision = snapshot.events.find((/** @type {StudyRecord} */ event) => event.id === row.decisionId);
      checkStudy(decision.type === 'owner_decision' && ['approve', 'accept', 'keep', 'revert'].includes(decision.action), 'Version action has no approving decision');
      checkStudy(!row.changeId || decision.changeId === row.changeId, 'Version decision refers to a different change');
      checkStudy(row.status !== 'reverted' || decision.action === 'revert', 'Reversion decision required');
    }
  }
  for (const key of ['approvalId', 'activeVersionId']) if (manifest[key] !== null) checkStudy(sets[key === 'approvalId' ? 'approvals' : 'versions'].has(manifest[key]), `Unresolved manifest ${key}`);
  return snapshot;
}
