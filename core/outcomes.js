import { createHash } from 'node:crypto';
import { all, get, isoNow, run, transaction } from './db.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

export const OUTCOME_CSV_HEADER = 'record_id,period_start,period_end,landing_page,metric_name,value,unit,currency,attribution_method,notes,supersedes_id';
export const OUTCOME_EXTENDED_CSV_COLUMNS = Object.freeze(['intervention_id', 'opportunity_id', 'page_role', 'comparison_page']);
export const CONTROL_PAGE_NOTE = 'An unchanged comparison page bounds background period drift when traffic is comparable; it is not causal proof on its own.';

const CSV_COLUMNS = OUTCOME_CSV_HEADER.split(',');
const ALLOWED_OPTIONAL_CSV = new Set(OUTCOME_EXTENDED_CSV_COLUMNS);
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const PAGE_ROLES = new Set(['changed', 'control']);

export class OutcomeError extends Error {
  /** @param {string} message @param {number} [status] @param {string} [code] */
  constructor(message, status = 400, code = 'invalid_outcome') {
    super(message);
    this.name = 'OutcomeError';
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} value @param {string} name @param {number} [limit] */
function required(value, name, limit = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new OutcomeError(`${name} is required and must be at most ${limit} characters`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) throw new OutcomeError(`${name} contains control characters`);
  return value.trim();
}

/** @param {unknown} value @param {string} name @param {number} [limit] */
function optional(value, name, limit = 2000) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > limit) throw new OutcomeError(`${name} must be at most ${limit} characters`);
  if (/\u0000/u.test(value)) throw new OutcomeError(`${name} contains a null character`);
  return value;
}

/** @param {unknown} value @param {string} name @param {number} [limit] */
function optionalTrimmed(value, name, limit = 200) {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  if (typeof raw !== 'string') throw new OutcomeError(`${name} must be a string of at most ${limit} characters`);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > limit) throw new OutcomeError(`${name} must be at most ${limit} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(trimmed)) throw new OutcomeError(`${name} contains control characters`);
  return trimmed;
}

/** @param {unknown} value */
function pageRole(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new OutcomeError("pageRole must be 'changed' or 'control'");
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (!PAGE_ROLES.has(normalized)) throw new OutcomeError("pageRole must be 'changed' or 'control'");
  return /** @type {'changed'|'control'} */ (normalized);
}

/** @param {unknown} value @param {string} name */
function utc(value, name) {
  let text = required(value, name, 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00Z';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)
    || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 19) + 'Z' !== text) {
    throw new OutcomeError(`${name} must be a valid UTC timestamp or ISO date`);
  }
  return text;
}

/** @param {unknown} value @param {string} name */
function currency(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const code = required(value, name, 3);
  if (!CURRENCIES.has(code)) throw new OutcomeError(`${name} must be a supported ISO currency`);
  return code;
}

/** @param {unknown} value @param {string} name */
function decimal(value, name) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^(?:0|[0-9]+)(?:\.[0-9]+)?$/.test(raw)
    || raw.length > 40) throw new OutcomeError(`${name} must be a nonnegative decimal without exponent notation`);
  const [whole, fraction = ''] = raw.split('.');
  const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
  const canonicalFraction = fraction.replace(/0+$/, '');
  return canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole;
}

/** @param {unknown} value @param {string} name */
function count(value, name) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new OutcomeError(`${name} must be a nonnegative safe integer`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new OutcomeError(`${name} must be a nonnegative safe integer`);
  return String(number);
}

/** @param {unknown} value @param {string} name */
function positiveId(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '') return null;
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number < 1 || String(number) !== String(trimmed)) {
    throw new OutcomeError(`${name} must be a positive integer ID`);
  }
  return number;
}

/** @param {unknown} value */
function atTime(value) {
  if (value !== undefined && typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    throw new OutcomeError('now must be a valid date');
  }
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new OutcomeError('now must be a valid date');
  return isoNow(date);
}

/** @param {unknown} value */
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }

/** @param {Record<string, unknown>} input */
function normalizeOutcome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OutcomeError('Outcome must be an object');
  const source = required(input.source, 'source', 160);
  const recordKey = required(input.recordKey !== undefined ? input.recordKey : input.record_key, 'recordKey', 200);
  const periodStart = utc(input.periodStart !== undefined ? input.periodStart : input.period_start, 'periodStart');
  const periodEnd = utc(input.periodEnd !== undefined ? input.periodEnd : input.period_end, 'periodEnd');
  if (periodStart >= periodEnd) throw new OutcomeError('periodStart must precede periodEnd');
  const metricName = required(input.metricName !== undefined ? input.metricName : input.metric_name, 'metricName', 160);
  const unit = required(input.unit, 'unit', 80);
  const currencyCode = currency(input.currency, 'currency');
  if (unit === 'count' && currencyCode) throw new OutcomeError('Count records cannot have currency');
  if (unit === 'money' && !currencyCode) throw new OutcomeError('Money records require currency');
  const value = unit === 'count' ? count(input.value, 'value') : decimal(input.value, 'value');
  const attributionMethod = required(
    input.attributionMethod !== undefined ? input.attributionMethod : input.attribution_method,
    'attributionMethod',
    160,
  );
  const landingPage = optional(input.landingPage !== undefined ? input.landingPage : input.landing_page, 'landingPage', 2048);
  const notes = optional(input.notes, 'notes', 8000);
  const supersedesId = positiveId(input.supersedesId !== undefined ? input.supersedesId : input.supersedes_id, 'supersedesId');
  const interventionId = optionalTrimmed(
    input.interventionId !== undefined ? input.interventionId : input.intervention_id,
    'interventionId',
    200,
  );
  const opportunityId = positiveId(
    input.opportunityId !== undefined ? input.opportunityId : input.opportunity_id,
    'opportunityId',
  );
  const role = pageRole(input.pageRole !== undefined ? input.pageRole : input.page_role);
  const comparisonPage = optionalTrimmed(
    input.comparisonPage !== undefined ? input.comparisonPage : input.comparison_page,
    'comparisonPage',
    2048,
  );
  return {
    source, recordKey, periodStart, periodEnd, metricName, value, unit,
    currency: currencyCode, attributionMethod, landingPage, notes, supersedesId,
    interventionId, opportunityId, pageRole: role, comparisonPage,
  };
}

/**
 * Preserve byte-for-byte v13 hashes when action-link fields are absent so upgraded
 * workspaces can replay legacy manual records and CSV batches idempotently.
 * @param {ReturnType<typeof normalizeOutcome>} item
 */
function outcomeHash(item) {
  const base = {
    source: item.source, recordKey: item.recordKey, periodStart: item.periodStart,
    periodEnd: item.periodEnd, metricName: item.metricName, value: item.value,
    unit: item.unit, currency: item.currency, attributionMethod: item.attributionMethod,
    landingPage: item.landingPage, notes: item.notes, supersedesId: item.supersedesId,
  };
  if (item.interventionId === null && item.opportunityId === null
    && item.pageRole === null && item.comparisonPage === null) {
    return hash(base);
  }
  return hash({
    ...base,
    interventionId: item.interventionId,
    opportunityId: item.opportunityId,
    pageRole: item.pageRole,
    comparisonPage: item.comparisonPage,
  });
}

/** @param {Db} db @param {ReturnType<typeof normalizeOutcome>} item @param {string} author @param {string} now @param {number|null} importRowId */
function insertOutcome(db, item, author, now, importRowId) {
  const contentHash = outcomeHash(item);
  const existing = get(db, 'SELECT * FROM outcome_records WHERE source = ? AND record_key = ?', [item.source, item.recordKey]);
  if (existing) {
    if (existing.content_hash !== contentHash) throw new OutcomeError('Record identity already exists with different content', 409, 'identity_conflict');
    return outcomeRow(existing);
  }
  if (item.opportunityId !== null && !get(db, 'SELECT 1 FROM opportunities WHERE id = ?', [item.opportunityId])) {
    throw new OutcomeError('opportunityId was not found', 404, 'not_found');
  }
  if (item.supersedesId !== null) {
    const predecessor = get(db, 'SELECT id,source FROM outcome_records WHERE id = ?', [item.supersedesId]);
    if (!predecessor || predecessor.source !== item.source) {
      throw new OutcomeError('supersedesId must reference an outcome from the same source');
    }
    if (get(db, 'SELECT id FROM outcome_records WHERE supersedes_id = ?', [item.supersedesId])) {
      throw new OutcomeError('Outcome already has a correction', 409, 'correction_conflict');
    }
  }
  const id = run(db, `INSERT INTO outcome_records(source,record_key,import_row_id,period_start,period_end,
    metric_name,value_text,unit,currency,attribution_method,landing_page,notes,author,created_at,
    supersedes_id,content_hash,intervention_id,opportunity_id,page_role,comparison_page)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    item.source, item.recordKey, importRowId, item.periodStart, item.periodEnd,
    item.metricName, item.value, item.unit, item.currency, item.attributionMethod,
    item.landingPage, item.notes, author, now, item.supersedesId, contentHash,
    item.interventionId, item.opportunityId, item.pageRole, item.comparisonPage,
  ]).lastInsertRowid;
  return outcomeRow(get(db, 'SELECT * FROM outcome_records WHERE id = ?', [id]));
}

/** @param {import('./db.js').Row|undefined} row */
function outcomeRow(row) {
  if (!row) throw new OutcomeError('Outcome record was not saved', 500, 'storage_error');
  return {
    id: Number(row.id), source: String(row.source), recordKey: String(row.record_key),
    importRowId: row.import_row_id === null ? null : Number(row.import_row_id),
    periodStart: String(row.period_start), periodEnd: String(row.period_end),
    metricName: String(row.metric_name), value: String(row.value_text), unit: String(row.unit),
    currency: row.currency === null ? null : String(row.currency),
    attributionMethod: String(row.attribution_method),
    landingPage: row.landing_page === null ? null : String(row.landing_page),
    notes: row.notes === null ? null : String(row.notes), author: String(row.author),
    createdAt: String(row.created_at), supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
    interventionId: row.intervention_id === null || row.intervention_id === undefined ? null : String(row.intervention_id),
    opportunityId: row.opportunity_id === null || row.opportunity_id === undefined ? null : Number(row.opportunity_id),
    pageRole: row.page_role === null || row.page_role === undefined ? null : /** @type {'changed'|'control'} */ (String(row.page_role)),
    comparisonPage: row.comparison_page === null || row.comparison_page === undefined ? null : String(row.comparison_page),
  };
}

/** @param {Db} db @param {Record<string, unknown>} input */
export function recordOutcome(db, input) {
  const item = normalizeOutcome(input);
  const author = required(input.author, 'author', 120);
  const now = atTime(input.now);
  return transaction(db, () => insertOutcome(db, item, author, now, null));
}

/** @param {string[]} headerRow */
function validateCsvHeader(headerRow) {
  if (headerRow.length < CSV_COLUMNS.length
    || headerRow.slice(0, CSV_COLUMNS.length).join(',') !== OUTCOME_CSV_HEADER) {
    throw new OutcomeError(`CSV header must be: ${OUTCOME_CSV_HEADER} (with optional trailing ${OUTCOME_EXTENDED_CSV_COLUMNS.join(',')})`);
  }
  const seen = new Set(CSV_COLUMNS);
  for (const extra of headerRow.slice(CSV_COLUMNS.length)) {
    if (!ALLOWED_OPTIONAL_CSV.has(extra) || seen.has(extra)) {
      throw new OutcomeError(`Unsupported or duplicate CSV column: ${extra}`);
    }
    seen.add(extra);
  }
  return headerRow;
}

/** @param {string} csvText */
function parseCsv(csvText) {
  if (typeof csvText !== 'string' || Buffer.byteLength(csvText, 'utf8') > 2_000_000) {
    throw new OutcomeError('CSV must be UTF-8 text of at most 2 MB');
  }
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let state = 'start';
  let endedWithNewline = false;
  const pushField = () => { row.push(field); field = ''; state = 'start'; };
  const pushRow = () => {
    pushField();
    rows.push(row);
    if (rows.length > 10_001) throw new OutcomeError('CSV exceeds 10000 records');
    row = [];
  };
  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (csvText[i + 1] === '"') { field += '"'; i += 1; }
        else state = 'after_quote';
      } else field += char;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r') {
        if (csvText[i + 1] !== '\n') throw new OutcomeError('CSV has a bare carriage return');
        i += 1;
      }
      pushRow();
      endedWithNewline = true;
    } else if (state === 'start' && char === '"') {
      state = 'quoted';
    } else if (state === 'after_quote' || char === '"') {
      throw new OutcomeError('CSV has malformed quoted field');
    } else {
      field += char;
      state = 'unquoted';
    }
    if (field.length > 8192) throw new OutcomeError('CSV field exceeds 8192 characters');
    if (char !== '\n' && char !== '\r') endedWithNewline = false;
  }
  if (state === 'quoted') throw new OutcomeError('CSV has an unterminated quoted field');
  if (!endedWithNewline && (row.length || field !== '' || state !== 'start')) pushRow();
  if (rows.length === 0) throw new OutcomeError(`CSV header must be: ${OUTCOME_CSV_HEADER}`);
  const headerColumns = validateCsvHeader(rows[0]);
  for (const [index, columns] of rows.entries()) {
    if (columns.length !== headerColumns.length) {
      throw new OutcomeError(`CSV row ${index + 1} has ${columns.length} fields; expected ${headerColumns.length}`);
    }
  }
  return rows.slice(1).map((columns) => Object.fromEntries(headerColumns.map((column, index) => [column, columns[index]])));
}

/** @param {Db} db @param {{source:string,importId:string,csvText:string,author:string,now?:Date|string}} input */
export function importOutcomeCsv(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OutcomeError('Import must be an object');
  const source = required(input.source, 'source', 160);
  const importId = required(input.importId, 'importId', 200);
  const author = required(input.author, 'author', 120);
  const now = atTime(input.now);
  const parsed = parseCsv(input.csvText);
  const items = parsed.map((row) => normalizeOutcome({
    source, recordKey: row.record_id,
    periodStart: row.period_start, periodEnd: row.period_end, landingPage: row.landing_page,
    metricName: row.metric_name, value: row.value, unit: row.unit, currency: row.currency,
    attributionMethod: row.attribution_method, notes: row.notes, supersedesId: row.supersedes_id,
    interventionId: row.intervention_id, opportunityId: row.opportunity_id,
    pageRole: row.page_role, comparisonPage: row.comparison_page,
  }));
  const sha256 = hash(input.csvText);
  return transaction(db, () => {
    const existing = get(db, 'SELECT id,sha256 FROM outcome_imports WHERE source = ? AND import_id = ?', [source, importId]);
    if (existing) {
      if (existing.sha256 !== sha256) throw new OutcomeError('Import identity already exists with different CSV', 409, 'import_conflict');
      return { id: Number(existing.id), source, importId, sha256, replayed: true,
        records: all(db, `SELECT o.* FROM outcome_import_items i
          JOIN outcome_records o ON o.id = i.outcome_id WHERE i.import_row_id = ? ORDER BY i.ordinal`,
        [Number(existing.id)]).map(outcomeRow) };
    }
    const id = run(db, `INSERT INTO outcome_imports(source,import_id,raw_csv,sha256,author,created_at)
      VALUES(?,?,?,?,?,?)`, [source, importId, input.csvText, sha256, author, now]).lastInsertRowid;
    const records = items.map((item, ordinal) => {
      const record = insertOutcome(db, item, author, now, id);
      run(db, 'INSERT INTO outcome_import_items(import_row_id,ordinal,outcome_id) VALUES(?,?,?)',
        [id, ordinal, record.id]);
      return record;
    });
    return { id, source, importId, sha256, replayed: false, records };
  });
}

/** @param {Db} db @param {Record<string, unknown>} input */
export function recordLedgerEntry(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OutcomeError('Ledger entry must be an object');
  const source = required(input.source, 'source', 160);
  const entryKey = required(input.entryKey, 'entryKey', 200);
  const kind = required(input.kind, 'kind', 20);
  if (!['time', 'expense'].includes(kind)) throw new OutcomeError('kind must be time or expense');
  const activity = required(input.activity, 'activity', 200);
  const periodStart = utc(input.periodStart, 'periodStart');
  const periodEnd = utc(input.periodEnd, 'periodEnd');
  if (periodStart >= periodEnd) throw new OutcomeError('periodStart must precede periodEnd');
  const minutes = kind === 'time' && input.minutes !== null && input.minutes !== undefined && input.minutes !== ''
    ? Number(count(input.minutes, 'minutes')) : null;
  if (kind === 'expense' && input.minutes !== null && input.minutes !== undefined && input.minutes !== '') {
    throw new OutcomeError('Expense entries cannot have minutes');
  }
  const amount = kind === 'expense' && input.amount !== null && input.amount !== undefined && input.amount !== ''
    ? decimal(input.amount, 'amount') : null;
  if (kind === 'time' && input.amount !== null && input.amount !== undefined && input.amount !== '') {
    throw new OutcomeError('Time entries cannot have an amount');
  }
  const currencyCode = currency(input.currency, 'currency');
  if (kind === 'time' && currencyCode) throw new OutcomeError('Time entries cannot have currency');
  if (amount !== null && currencyCode === null) throw new OutcomeError('Known expenses require currency');
  const notes = optional(input.notes, 'notes', 8000);
  const opportunityId = positiveId(input.opportunityId, 'opportunityId');
  if (opportunityId !== null && !get(db, 'SELECT 1 FROM opportunities WHERE id = ?', [opportunityId])) {
    throw new OutcomeError('opportunityId was not found', 404, 'not_found');
  }
  const author = required(input.author, 'author', 120);
  const now = atTime(input.now);
  const item = { source, entryKey, kind, activity, periodStart, periodEnd, minutes, amount,
    currency: currencyCode, notes, opportunityId };
  const contentHash = hash(item);
  return transaction(db, () => {
    const existing = get(db, 'SELECT * FROM ledger_entries WHERE source = ? AND entry_key = ?', [source, entryKey]);
    if (existing) {
      if (existing.content_hash !== contentHash) throw new OutcomeError('Ledger identity already exists with different content', 409, 'identity_conflict');
      return ledgerRow(existing);
    }
    const id = run(db, `INSERT INTO ledger_entries(source,entry_key,kind,activity,period_start,period_end,
      minutes,amount_text,currency,notes,author,created_at,opportunity_id,content_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [source, entryKey, kind, activity, periodStart,
      periodEnd, minutes, amount, currencyCode, notes, author, now, opportunityId, contentHash]).lastInsertRowid;
    return ledgerRow(get(db, 'SELECT * FROM ledger_entries WHERE id = ?', [id]));
  });
}

/** @param {import('./db.js').Row|undefined} row */
function ledgerRow(row) {
  if (!row) throw new OutcomeError('Ledger entry was not saved', 500, 'storage_error');
  return { id: Number(row.id), source: String(row.source), entryKey: String(row.entry_key),
    kind: String(row.kind), activity: String(row.activity), periodStart: String(row.period_start),
    periodEnd: String(row.period_end), minutes: row.minutes === null ? null : Number(row.minutes),
    amount: row.amount_text === null ? null : String(row.amount_text),
    currency: row.currency === null ? null : String(row.currency),
    notes: row.notes === null ? null : String(row.notes), author: String(row.author),
    createdAt: String(row.created_at), opportunityId: row.opportunity_id === null ? null : Number(row.opportunity_id) };
}

/** @param {{start?:string,end?:string}} scope */
function window(scope) {
  const start = scope.start === undefined ? null : utc(scope.start, 'start');
  const end = scope.end === undefined ? null : utc(scope.end, 'end');
  if (start !== null && end !== null && start >= end) throw new OutcomeError('start must precede end');
  return { start, end };
}

/** @param {Db} db @param {{start?:string,end?:string,interventionId?:string,opportunityId?:number}} [scope] */
export function listOutcomeRecords(db, scope = {}) {
  const { start, end } = window(scope);
  const filterIntervention = scope.interventionId === undefined ? null : optionalTrimmed(scope.interventionId, 'interventionId', 200);
  const filterOpportunity = scope.opportunityId === undefined ? null : positiveId(scope.opportunityId, 'opportunityId');
  const rows = all(db, `SELECT o.* FROM outcome_records o
    WHERE NOT EXISTS (SELECT 1 FROM outcome_records successor WHERE successor.supersedes_id = o.id)
    ORDER BY o.period_start, o.id`).map(outcomeRow);
  return rows.filter((item) => (start === null || item.periodEnd > start)
    && (end === null || item.periodStart < end)
    && (filterIntervention === null || item.interventionId === filterIntervention)
    && (filterOpportunity === null || item.opportunityId === filterOpportunity)).map((item) => {
    const overlapIds = rows.filter((other) => other.id !== item.id && other.source === item.source
      && other.metricName === item.metricName && other.unit === item.unit
      && other.currency === item.currency && other.landingPage === item.landingPage
      && other.pageRole === item.pageRole
      && other.attributionMethod === item.attributionMethod
      && other.periodStart < item.periodEnd && other.periodEnd > item.periodStart).map((other) => other.id);
    return { ...item, overlapIds, hasOverlap: overlapIds.length > 0 };
  });
}

/** @param {Db} db @param {{start?:string,end?:string}} [scope] */
export function listLedgerEntries(db, scope = {}) {
  const { start, end } = window(scope);
  return all(db, `SELECT * FROM ledger_entries WHERE (? IS NULL OR period_end > ?)
    AND (? IS NULL OR period_start < ?) ORDER BY period_start, id`, [start, start, end, end]).map(ledgerRow);
}

/** @param {unknown} value */
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** @param {Db} db @param {{start?:string,end?:string}} [scope] */
export function exportOutcomeCsv(db, scope = {}) {
  const { start, end } = window(scope);
  const rows = all(db, `SELECT o.*, i.import_id FROM outcome_records o
    LEFT JOIN outcome_imports i ON i.id = o.import_row_id
    WHERE (? IS NULL OR o.period_end > ?) AND (? IS NULL OR o.period_start < ?)
    ORDER BY o.id`, [start, start, end, end]);
  const hasActionLinks = rows.some((row) => row.intervention_id !== null || row.opportunity_id !== null
    || row.page_role !== null || row.comparison_page !== null);
  const header = hasActionLinks
    ? ['source', 'import_id', ...CSV_COLUMNS, 'author', 'created_at', ...OUTCOME_EXTENDED_CSV_COLUMNS]
    : ['source', 'import_id', ...CSV_COLUMNS, 'author', 'created_at'];
  const lines = rows.map((row) => {
    const base = [row.source, row.import_id, row.record_key, row.period_start,
      row.period_end, row.landing_page, row.metric_name, row.value_text, row.unit,
      row.currency, row.attribution_method, row.notes, row.supersedes_id, row.author,
      row.created_at];
    const values = hasActionLinks
      ? [...base, row.intervention_id, row.opportunity_id, row.page_role, row.comparison_page]
      : base;
    return values.map(csvCell).join(',');
  });
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * Exact decimal arithmetic & Changed-vs-Control Page Business Comparison
 * ------------------------------------------------------------------ */

/** @param {string} text */
function splitDecimal(text) {
  const neg = text.startsWith('-');
  const raw = neg ? text.slice(1) : text;
  const [whole, fraction = ''] = raw.split('.');
  return { neg, whole: whole || '0', fraction };
}

/** @param {bigint} value @param {number} scale */
function formatScaled(value, scale) {
  if (value === 0n) return '0';
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  if (scale === 0) return `${sign}${abs.toString()}`;
  const digits = abs.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/** @param {string} a @param {string} b */
export function addExactDecimal(a, b) {
  const pa = splitDecimal(a);
  const pb = splitDecimal(b);
  const scale = Math.max(pa.fraction.length, pb.fraction.length);
  const factor = 10n ** BigInt(scale);
  const va = (BigInt(pa.whole) * factor + BigInt(pa.fraction.padEnd(scale, '0'))) * (pa.neg ? -1n : 1n);
  const vb = (BigInt(pb.whole) * factor + BigInt(pb.fraction.padEnd(scale, '0'))) * (pb.neg ? -1n : 1n);
  return formatScaled(va + vb, scale);
}

/** @param {string} a @param {string} b */
export function subExactDecimal(a, b) {
  return addExactDecimal(a, b.startsWith('-') ? b.slice(1) : `-${b}`);
}

/** @param {string|null} value */
function signedLabel(value) {
  if (value === null) return null;
  return value === '0' || value.startsWith('-') ? value : `+${value}`;
}

/** @param {{periodStart:string,periodEnd:string,value:string,source?:string}[]} rows */
function summarizeArmWindow(rows) {
  if (!rows.length) return { total: null, records: 0, hasOverlap: false, windowStart: null, windowEnd: null, recordIds: [] };
  let hasOverlap = false;
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[i].periodStart < rows[j].periodEnd && rows[i].periodEnd > rows[j].periodStart) {
        hasOverlap = true;
      }
    }
  }
  const sortedStarts = rows.map((item) => item.periodStart).sort();
  const sortedEnds = rows.map((item) => item.periodEnd).sort();
  const total = hasOverlap ? null : rows.reduce((sum, item) => addExactDecimal(sum, String(item.value)), '0');
  return {
    total,
    records: rows.length,
    hasOverlap,
    windowStart: sortedStarts[0] ?? null,
    windowEnd: sortedEnds.at(-1) ?? null,
    recordIds: rows.map((/** @type {any} */ item) => item.id).filter((id) => typeof id === 'number'),
  };
}

/**
 * Compute exact Changed-Page vs. Unchanged Control-Page business comparison across
 * baseline and post-change windows (or review-window-only when baseline is absent).
 *
 * @param {ReturnType<typeof listOutcomeRecords>} records
 * @param {{
 *   interventionId?: string|null,
 *   opportunityId?: number|null,
 *   targetPage?: string|null,
 *   comparisonPage?: string|null,
 *   baselineStart?: string|null,
 *   baselineEnd?: string|null,
 *   postStart: string,
 *   postEnd: string,
 * }} options
 */
export function compareControlledPageOutcomes(records, options) {
  const postStart = utc(options.postStart, 'postStart');
  const postEnd = utc(options.postEnd, 'postEnd');
  if (postStart >= postEnd) throw new OutcomeError('postStart must precede postEnd');
  const baselineStart = options.baselineStart ? utc(options.baselineStart, 'baselineStart') : null;
  const baselineEnd = options.baselineEnd ? utc(options.baselineEnd, 'baselineEnd') : null;
  if ((baselineStart === null) !== (baselineEnd === null)) {
    throw new OutcomeError('baselineStart and baselineEnd must be provided together');
  }
  if (baselineStart !== null && baselineEnd !== null && baselineStart >= baselineEnd) {
    throw new OutcomeError('baselineStart must precede baselineEnd');
  }
  const targetPage = options.targetPage ?? null;
  const fallbackControlPage = options.comparisonPage ?? null;

  /** @type {Map<string, {metricName:string,unit:string,currency:string|null,rows:typeof records}>} */
  const groups = new Map();
  for (const record of records) {
    const key = `${record.metricName}\u0000${record.unit}\u0000${record.currency ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { metricName: record.metricName, unit: record.unit, currency: record.currency, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(record);
  }

  const items = [...groups.values()].map((group) => {
    const inferredComparisonPage = fallbackControlPage
      ?? group.rows.find((row) => row.comparisonPage)?.comparisonPage ?? null;
    const inferredTargetPage = targetPage
      ?? group.rows.find((row) => row.pageRole === 'changed' && row.landingPage)?.landingPage ?? null;

    /** @param {(typeof records)[number]} row */
    const classifyArm = (row) => {
      if (row.pageRole === 'changed') return 'changed';
      if (row.pageRole === 'control') return 'control';
      if (inferredTargetPage && row.landingPage === inferredTargetPage) return 'changed';
      if (inferredComparisonPage && row.landingPage === inferredComparisonPage) return 'control';
      return 'unassigned';
    };

    /** @param {(typeof records)[number]} row */
    const classifyPhase = (row) => {
      const inPost = row.periodEnd > postStart && row.periodStart < postEnd;
      const inBaseline = baselineStart !== null && baselineEnd !== null
        ? (row.periodEnd > baselineStart && row.periodStart < baselineEnd)
        : row.periodEnd <= postStart;
      if (inPost && inBaseline) return 'straddling';
      if (inPost) return 'post';
      if (inBaseline) return 'baseline';
      return 'outside';
    };

    const changedBaselineRows = [];
    const changedPostRows = [];
    const controlBaselineRows = [];
    const controlPostRows = [];
    let straddlingRecords = 0;
    let unassignedRecords = 0;

    for (const row of group.rows) {
      const phase = classifyPhase(row);
      if (phase === 'outside') continue;
      if (phase === 'straddling') { straddlingRecords += 1; continue; }
      const arm = classifyArm(row);
      if (arm === 'unassigned') { unassignedRecords += 1; continue; }
      if (arm === 'changed' && phase === 'baseline') changedBaselineRows.push(row);
      else if (arm === 'changed' && phase === 'post') changedPostRows.push(row);
      else if (arm === 'control' && phase === 'baseline') controlBaselineRows.push(row);
      else if (arm === 'control' && phase === 'post') controlPostRows.push(row);
    }

    const cb = summarizeArmWindow(changedBaselineRows);
    const cp = summarizeArmWindow(changedPostRows);
    const ub = summarizeArmWindow(controlBaselineRows);
    const up = summarizeArmWindow(controlPostRows);

    const changedDelta = cb.total !== null && cp.total !== null ? subExactDecimal(cp.total, cb.total) : null;
    const controlDelta = ub.total !== null && up.total !== null ? subExactDecimal(up.total, ub.total) : null;
    const differenceInChange = changedDelta !== null && controlDelta !== null
      ? subExactDecimal(changedDelta, controlDelta) : null;
    const windowDifference = cp.total !== null && up.total !== null
      ? subExactDecimal(cp.total, up.total) : null;

    const anyOverlap = cb.hasOverlap || cp.hasOverlap || ub.hasOverlap || up.hasOverlap;
    const warnings = [];
    if (anyOverlap) warnings.push('Overlapping records exist inside a page window; totals are withheld to avoid double-counting');
    if (straddlingRecords > 0) warnings.push(`${straddlingRecords} outcome record${straddlingRecords === 1 ? '' : 's'} straddled baseline and review boundaries`);
    if (cb.windowStart && cb.windowEnd && cp.windowStart && cp.windowEnd) {
      const baseMs = Date.parse(cb.windowEnd) - Date.parse(cb.windowStart);
      const postMs = Date.parse(cp.windowEnd) - Date.parse(cp.windowStart);
      if (baseMs !== postMs) warnings.push('Baseline and post-change outcome window durations differ');
    }
    if (ub.windowStart && ub.windowEnd && cb.windowStart && cb.windowEnd
      && (ub.windowStart !== cb.windowStart || ub.windowEnd !== cb.windowEnd)) {
      warnings.push('Changed and control baseline outcome windows do not match');
    }
    if (up.windowStart && up.windowEnd && cp.windowStart && cp.windowEnd
      && (up.windowStart !== cp.windowStart || up.windowEnd !== cp.windowEnd)) {
      warnings.push('Changed and control post-change outcome windows do not match');
    }

    let status = 'incomplete';
    if (anyOverlap) status = 'overlap_blocked';
    else if (differenceInChange !== null) status = 'controlled_before_after';
    else if (windowDifference !== null) status = 'review_window_only';
    else if (changedDelta !== null) status = 'before_after_only';

    const resolvedControlPage = inferredComparisonPage
      ?? controlPostRows.find((row) => row.landingPage)?.landingPage
      ?? controlBaselineRows.find((row) => row.landingPage)?.landingPage ?? null;

    return {
      interventionId: options.interventionId ?? null,
      opportunityId: options.opportunityId ?? null,
      metricName: group.metricName,
      unit: group.unit,
      currency: group.currency,
      status,
      changed: {
        page: inferredTargetPage,
        baseline: cb.total,
        post: cp.total,
        delta: changedDelta,
        signedDelta: signedLabel(changedDelta),
        baselineRecords: cb.records,
        postRecords: cp.records,
        baselineRecordIds: cb.recordIds,
        postRecordIds: cp.recordIds,
        hasOverlap: cb.hasOverlap || cp.hasOverlap,
      },
      control: {
        page: resolvedControlPage,
        baseline: ub.total,
        post: up.total,
        delta: controlDelta,
        signedDelta: signedLabel(controlDelta),
        baselineRecords: ub.records,
        postRecords: up.records,
        baselineRecordIds: ub.recordIds,
        postRecordIds: up.recordIds,
        hasOverlap: ub.hasOverlap || up.hasOverlap,
      },
      differenceInChange,
      signedDifferenceInChange: signedLabel(differenceInChange),
      differenceInChangeNumber: differenceInChange === null ? null : Number(differenceInChange),
      windowDifference,
      signedWindowDifference: signedLabel(windowDifference),
      unassignedRecords,
      warnings,
      note: CONTROL_PAGE_NOTE,
    };
  }).filter((item) => item.changed.baselineRecords + item.changed.postRecords
    + item.control.baselineRecords + item.control.postRecords > 0);

  return {
    interventionId: options.interventionId ?? null,
    opportunityId: options.opportunityId ?? null,
    baselineWindow: baselineStart && baselineEnd ? { start: baselineStart, end: baselineEnd } : null,
    postWindow: { start: postStart, end: postEnd },
    status: items.some((item) => item.status === 'controlled_before_after') ? 'controlled_before_after'
      : items.some((item) => item.status === 'review_window_only') ? 'review_window_only'
        : items.some((item) => item.status === 'before_after_only') ? 'before_after_only'
          : items.length ? items[0].status : 'not_recorded',
    items,
    note: CONTROL_PAGE_NOTE,
  };
}

/**
 * Summarize action-linked business outcomes for one shipped opportunity / intervention
 * across explicit baseline and review windows.
 * @param {Db} db
 * @param {{
 *   opportunityId?: number|null,
 *   interventionId?: string|null,
 *   targetPage?: string|null,
 *   comparisonPage?: string|null,
 *   baselineStart: string,
 *   baselineEnd: string,
 *   reviewStart: string,
 *   reviewEnd: string,
 * }} input
 */
export function summarizeInterventionOutcomes(db, input) {
  const allActive = listOutcomeRecords(db);
  const oppId = input.opportunityId ?? null;
  const intId = input.interventionId ?? (oppId !== null ? String(oppId) : null);
  const linked = allActive.filter((record) =>
    (oppId !== null && record.opportunityId === oppId)
    || (intId !== null && (record.interventionId === intId || (oppId !== null && record.interventionId === `opp-${oppId}`))));
  return compareControlledPageOutcomes(linked, {
    interventionId: intId,
    opportunityId: oppId,
    targetPage: input.targetPage ?? null,
    comparisonPage: input.comparisonPage ?? null,
    baselineStart: input.baselineStart,
    baselineEnd: input.baselineEnd,
    postStart: input.reviewStart,
    postEnd: input.reviewEnd,
  });
}

/**
 * Discover all action-linked or page-role outcomes overlapping a weekly review window
 * `[start, end)` and pair them with any saved baseline outcomes for the same action.
 * @param {Db} db
 * @param {{start:string,end:string}} scope
 */
export function summarizeWeeklyControlledOutcomes(db, scope) {
  const start = utc(scope.start, 'start');
  const end = utc(scope.end, 'end');
  const allActive = listOutcomeRecords(db);
  const inWeek = allActive.filter((item) => item.periodEnd > start && item.periodStart < end
    && (item.interventionId !== null || item.opportunityId !== null || item.pageRole !== null));
  if (!inWeek.length) return [];

  /** @type {Map<string, {key:string,interventionId:string|null,opportunityId:number|null}>} */
  const groups = new Map();
  for (const row of inWeek) {
    const key = row.opportunityId !== null
      ? `opp:${row.opportunityId}`
      : row.interventionId !== null
        ? `int:${row.interventionId}`
        : 'workspace:unlinked';
    if (!groups.has(key)) {
      groups.set(key, { key, interventionId: row.interventionId, opportunityId: row.opportunityId });
    }
  }

  return [...groups.values()].map((action) => {
    const oppRow = action.opportunityId !== null
      ? get(db, 'SELECT id, change_description, suggested_action, target_url, shipped_at FROM opportunities WHERE id = ?', [action.opportunityId])
      : null;
    const latestPlan = action.opportunityId !== null
      ? get(db, 'SELECT baseline_json FROM follow_up_plans WHERE opportunity_id = ? ORDER BY version DESC LIMIT 1', [action.opportunityId])
      : null;
    const planBaseline = latestPlan ? JSON.parse(String(latestPlan.baseline_json)) : null;
    const matching = allActive.filter((record) => {
      if (action.opportunityId !== null) {
        return record.opportunityId === action.opportunityId
          || record.interventionId === String(action.opportunityId)
          || (action.interventionId !== null && record.interventionId === action.interventionId);
      }
      if (action.interventionId !== null) return record.interventionId === action.interventionId;
      return record.opportunityId === null && record.interventionId === null && record.pageRole !== null;
    });

    const summary = compareControlledPageOutcomes(matching, {
      interventionId: action.interventionId,
      opportunityId: action.opportunityId,
      targetPage: oppRow?.target_url ? String(oppRow.target_url) : null,
      baselineStart: planBaseline?.windowStart ?? null,
      baselineEnd: planBaseline?.windowEnd ?? null,
      postStart: start,
      postEnd: end,
    });

    const label = oppRow
      ? `Opportunity #${oppRow.id}${oppRow.change_description ? `: ${oppRow.change_description}` : oppRow.suggested_action ? `: ${oppRow.suggested_action}` : ''}`
      : action.interventionId
        ? `Action ${action.interventionId}`
        : 'Workspace page comparison';

    return {
      ...summary,
      label,
      shippedAt: oppRow?.shipped_at ? String(oppRow.shipped_at) : null,
    };
  }).filter((entry) => entry.items.length > 0);
}
