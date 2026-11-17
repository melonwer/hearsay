/** Durable business outcome normalization for standalone website studies. */
import { addExactDecimal, CONTROL_PAGE_NOTE, subExactDecimal } from './outcomes.js';

export { CONTROL_PAGE_NOTE };

const MAX_TEXT = 8000;
const PHASES = new Set(['baseline', 'after']);
const PAGE_ROLES = new Set(['changed', 'control']);
const OPTIONAL_STUDY_CSV = new Set(['interventionId', 'intervention_id', 'pageRole', 'page_role', 'comparisonPage', 'comparison_page']);

export class StudyOutcomeError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'invalid_outcome') { super(message); this.name = 'StudyOutcomeError'; this.code = code; }
}

/** @param {unknown} value @param {string} name @param {number} max */
function text(value, name, max = 512) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new StudyOutcomeError(`${name} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}
/** @param {unknown} value @param {string} name */
function httpUrl(value, name) {
  const result = text(value, name, 2048);
  try {
    const parsedUrl = new URL(result);
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error();
  } catch {
    throw new StudyOutcomeError(`${name} must be an HTTP(S) URL without credentials`);
  }
  return result;
}
/** @param {unknown} value @param {string} name */
function date(value, name) {
  const result = text(value, name, 80);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(result);
  const instant = Date.parse(result);
  if (!match || !Number.isFinite(instant)) throw new StudyOutcomeError(`${name} must be an ISO date`);
  const check = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (check.getUTCFullYear() !== Number(match[1]) || check.getUTCMonth() !== Number(match[2]) - 1 || check.getUTCDate() !== Number(match[3])) throw new StudyOutcomeError(`${name} is not a calendar date`);
  return new Date(instant).toISOString();
}
/** @param {unknown} value @param {string} name @param {boolean} [integer] */
function numberValue(value, name, integer = false) {
  if (value === null || value === undefined || value === '' || (typeof value === 'string' && value.trim() === '')) throw new StudyOutcomeError(`${name} is required`);
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new StudyOutcomeError(`${name} must be a finite non-negative${integer ? ' integer' : ''}`);
  return n;
}
/** @param {unknown} value @param {string} name */
function optionalText(value, name, max = MAX_TEXT) {
  if (value == null || value === '') return null;
  return text(value, name, max);
}
/** @param {unknown} value */
function optionalPageRole(value) {
  if (value == null || value === '') return null;
  const role = text(value, 'pageRole', 32).toLowerCase();
  if (!PAGE_ROLES.has(role)) throw new StudyOutcomeError('pageRole must be changed or control');
  return /** @type {'changed'|'control'} */ (role);
}

/**
 * Normalize one owner supplied observation. Missing denominators remain null and are
 * deliberately never inferred from values or traffic notes.
 * @param {Record<string, unknown>} input
 */
export function normalizeStudyOutcome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StudyOutcomeError('Outcome must be an object');
  const source = text(input.source, 'source', 160);
  const recordKey = text(input.recordKey ?? input.record_id, 'recordKey', 240);
  const pageUrl = httpUrl(input.pageUrl ?? input.page_url, 'pageUrl');
  const periodStart = date(input.periodStart ?? input.period_start, 'periodStart');
  const periodEnd = date(input.periodEnd ?? input.period_end, 'periodEnd');
  if (periodStart >= periodEnd) throw new StudyOutcomeError('periodStart must precede periodEnd');
  const metric = text(input.metric ?? input.metricName ?? input.metric_name, 'metric', 160);
  const unit = text(input.unit, 'unit', 80).toLowerCase();
  if (!['count', 'money', 'rate', 'ratio', 'number'].includes(unit)) throw new StudyOutcomeError('unit must be count, money, rate, ratio, or number');
  const value = numberValue(input.value, 'value', unit === 'count');
  const currency = optionalText(input.currency, 'currency', 8)?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new StudyOutcomeError('currency must be a three-letter ISO code');
  if (unit === 'money' && !currency) throw new StudyOutcomeError('money outcomes require currency');
  if (unit !== 'money' && currency) throw new StudyOutcomeError('currency is only valid for money outcomes');
  const denominator = input.denominator == null || input.denominator === '' ? null : numberValue(input.denominator, 'denominator', true);
  const attributionMethod = text(input.attributionMethod ?? input.attribution_method, 'attributionMethod', 200);
  const trafficNotes = optionalText(input.trafficNotes ?? input.traffic_notes, 'trafficNotes') ?? '';
  const changeId = optionalText(input.changeId ?? input.change_id ?? input.interventionId ?? input.intervention_id, 'changeId', 240);
  const phase = text(input.phase, 'phase', 32).toLowerCase();
  if (!PHASES.has(phase)) throw new StudyOutcomeError('phase must be baseline or after');
  const cohort = optionalText(input.cohort, 'cohort', 200);
  const assignment = optionalText(input.assignment, 'assignment', 2000);
  const pageRole = optionalPageRole(input.pageRole ?? input.page_role);
  const rawComparisonPage = input.comparisonPage ?? input.comparison_page;
  const comparisonPage = rawComparisonPage == null || rawComparisonPage === '' ? null : httpUrl(rawComparisonPage, 'comparisonPage');
  return {
    version: 1,
    source, recordKey, pageUrl, periodStart, periodEnd, metric, value, unit, currency,
    denominator, attributionMethod, trafficNotes, changeId, phase,
    ...(cohort ? { cohort } : {}), ...(assignment ? { assignment } : {}),
    ...(pageRole ? { pageRole } : {}), ...(comparisonPage ? { comparisonPage } : {}),
  };
}

/** Basic RFC4180 parser retaining quoted commas/newlines. @param {string} csv */
function parseCsv(csv) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 2_000_000) throw new StudyOutcomeError('CSV must be UTF-8 text no larger than 2 MB');
  /** @type {string[][]} */ const rows = []; let row = /** @type {string[]} */ ([]); let field = ''; let state = 'start';
  const pushField = () => { row.push(field); field = ''; state = 'start'; };
  const pushRow = () => { pushField(); if (row.length === 1 && row[0] === '' && !rows.length) return; rows.push(row); row = []; };
  for (let i = 0; i < csv.length; i += 1) {
    const c = csv[i];
    if (state === 'quoted') { if (c === '"' && csv[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') state = 'after_quote'; else field += c; continue; }
    if (state === 'after_quote') { if (c === ',') pushField(); else if (c === '\n' || c === '\r') { if (c === '\r' && csv[i + 1] === '\n') i += 1; pushRow(); } else throw new StudyOutcomeError('CSV has malformed quoted field'); continue; }
    if (c === '"') { if (state !== 'start') throw new StudyOutcomeError('CSV has malformed quoted field'); state = 'quoted'; }
    else if (c === ',') pushField();
    else if (c === '\n' || c === '\r') { if (c === '\r' && csv[i + 1] === '\n') i += 1; pushRow(); }
    else { field += c; state = 'unquoted'; }
  }
  if (state === 'quoted') throw new StudyOutcomeError('CSV has an unterminated quoted field');
  if (state === 'after_quote' || field !== '' || row.length) pushRow();
  if (!rows.length) throw new StudyOutcomeError('CSV is empty');
  return rows;
}

const CSV_COLUMNS = ['recordKey', 'pageUrl', 'periodStart', 'periodEnd', 'metric', 'value', 'unit', 'currency', 'denominator', 'attributionMethod', 'trafficNotes', 'changeId', 'phase', 'cohort', 'assignment'];

/** @param {string[]} header */
function validateHeader(header) {
  if (header.length < CSV_COLUMNS.length || header.slice(0, CSV_COLUMNS.length).join(',') !== CSV_COLUMNS.join(',')) {
    throw new StudyOutcomeError(`CSV header must be exactly: ${CSV_COLUMNS.join(',')}`);
  }
  const seen = new Set(CSV_COLUMNS);
  for (const extra of header.slice(CSV_COLUMNS.length)) {
    if (!OPTIONAL_STUDY_CSV.has(extra) || seen.has(extra)) {
      throw new StudyOutcomeError(`Unsupported or duplicate CSV column: ${extra}`);
    }
    seen.add(extra);
  }
  return header;
}

/**
 * Parse owner-supplied outcome CSV. The raw CSV is never rewritten by this function.
 * @param {string} csv
 * @param {{studyId?:string,appId?:string,source:string,changeId?:string}} options
 */
export function parseStudyOutcomeCsv(csv, options) {
  if (!options || typeof options !== 'object') throw new StudyOutcomeError('CSV options are required');
  const source = text(options.source, 'source', 160);
  const rows = parseCsv(csv);
  const header = validateHeader((rows.shift() ?? []).map((item) => item.trim()));
  /** @type {Map<string,string>} */ const seen = new Map();
  return rows.filter((row) => row.some((cell) => cell !== '')).map((row, index) => {
    if (row.length !== header.length) throw new StudyOutcomeError(`CSV row ${index + 2} has ${row.length} fields; expected ${header.length}`);
    /** @type {Record<string,unknown>} */ const item = { source };
    header.forEach((key, i) => { item[key] = row[i] === '' ? null : row[i]; });
    if (options.changeId && !item.changeId && !item.interventionId && !item.intervention_id) item.changeId = options.changeId;
    const normalized = normalizeStudyOutcome(item);
    const prior = seen.get(normalized.recordKey);
    const encoded = JSON.stringify(normalized);
    if (prior && prior !== encoded) throw new StudyOutcomeError(`CSV contains conflicting duplicate recordKey ${normalized.recordKey}`, 'duplicate_conflict');
    if (prior) throw new StudyOutcomeError(`CSV contains duplicate recordKey ${normalized.recordKey}`, 'duplicate_record');
    seen.set(normalized.recordKey, encoded);
    return { ...normalized, ...(options.studyId ? { studyId: options.studyId } : {}), ...(options.appId ? { appId: options.appId } : {}) };
  });
}

export const studyOutcomeCsvColumns = Object.freeze([...CSV_COLUMNS]);

/** @param {number|string} value */
function decimalText(value) {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return value;
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? String(num) : '0';
}

/** @param {string|null} value */
function signedLabel(value) {
  if (value === null) return null;
  return value === '0' || value.startsWith('-') ? value : `+${value}`;
}

/** @param {any[]} rows */
function sumRows(rows) {
  if (!rows.length) return null;
  return rows.reduce((sum, item) => addExactDecimal(sum, decimalText(item.value)), '0');
}

/**
 * Summarize observed Changed-Page vs. Unchanged Control-Page business totals and
 * difference-in-change across baseline and post-change phases for a study bucket.
 *
 * @param {Record<string, any>[]} rows
 * @param {{targetUrl?:string|null, referenceUrl?:string|null}} [options]
 */
export function summarizeStudyPageComparison(rows, options = {}) {
  const targetUrl = options.targetUrl ?? rows.find((item) => item.pageRole === 'changed')?.pageUrl ?? null;
  const referenceUrl = options.referenceUrl
    ?? rows.find((item) => item.comparisonPage)?.comparisonPage
    ?? rows.find((item) => item.pageRole === 'control')?.pageUrl ?? null;

  const targetRows = rows.filter((item) => item.pageRole === 'changed'
    || (item.pageRole !== 'control' && (targetUrl ? item.pageUrl === targetUrl : !referenceUrl || item.pageUrl !== referenceUrl)));
  const controlRows = rows.filter((item) => item.pageRole === 'control'
    || (item.pageRole !== 'changed' && Boolean(referenceUrl && item.pageUrl === referenceUrl)));

  const changedBaseline = sumRows(targetRows.filter((item) => item.phase === 'baseline'));
  const changedAfter = sumRows(targetRows.filter((item) => item.phase === 'after'));
  const controlBaseline = sumRows(controlRows.filter((item) => item.phase === 'baseline'));
  const controlAfter = sumRows(controlRows.filter((item) => item.phase === 'after'));

  const changedDelta = changedBaseline !== null && changedAfter !== null
    ? subExactDecimal(changedAfter, changedBaseline) : null;
  const controlDelta = controlBaseline !== null && controlAfter !== null
    ? subExactDecimal(controlAfter, controlBaseline) : null;
  const differenceInChange = changedDelta !== null && controlDelta !== null
    ? subExactDecimal(changedDelta, controlDelta) : null;
  const afterDifference = changedAfter !== null && controlAfter !== null
    ? subExactDecimal(changedAfter, controlAfter) : null;

  return {
    changedPage: targetUrl,
    controlPage: referenceUrl,
    changed: {
      baseline: changedBaseline,
      after: changedAfter,
      delta: changedDelta,
      signedDelta: signedLabel(changedDelta),
    },
    control: {
      baseline: controlBaseline,
      after: controlAfter,
      delta: controlDelta,
      signedDelta: signedLabel(controlDelta),
    },
    differenceInChange,
    signedDifferenceInChange: signedLabel(differenceInChange),
    differenceInChangeNumber: differenceInChange === null ? null : Number(differenceInChange),
    afterDifference,
    signedAfterDifference: signedLabel(afterDifference),
    note: CONTROL_PAGE_NOTE,
  };
}
