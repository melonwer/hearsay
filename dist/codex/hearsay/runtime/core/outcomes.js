import { createHash } from 'node:crypto';
import { all, get, isoNow, run, transaction } from './db.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

export const OUTCOME_CSV_HEADER = 'record_id,period_start,period_end,landing_page,metric_name,value,unit,currency,attribution_method,notes,supersedes_id';
const CSV_COLUMNS = OUTCOME_CSV_HEADER.split(',');
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

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
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || String(number) !== String(value)) {
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
  const recordKey = required(input.recordKey, 'recordKey', 200);
  const periodStart = utc(input.periodStart, 'periodStart');
  const periodEnd = utc(input.periodEnd, 'periodEnd');
  if (periodStart >= periodEnd) throw new OutcomeError('periodStart must precede periodEnd');
  const metricName = required(input.metricName, 'metricName', 160);
  const unit = required(input.unit, 'unit', 80);
  const currencyCode = currency(input.currency, 'currency');
  if (unit === 'count' && currencyCode) throw new OutcomeError('Count records cannot have currency');
  if (unit === 'money' && !currencyCode) throw new OutcomeError('Money records require currency');
  const value = unit === 'count' ? count(input.value, 'value') : decimal(input.value, 'value');
  const attributionMethod = required(input.attributionMethod, 'attributionMethod', 160);
  const landingPage = optional(input.landingPage, 'landingPage', 2048);
  const notes = optional(input.notes, 'notes', 8000);
  const supersedesId = positiveId(input.supersedesId, 'supersedesId');
  return { source, recordKey, periodStart, periodEnd, metricName, value, unit,
    currency: currencyCode, attributionMethod, landingPage, notes, supersedesId };
}

/** @param {ReturnType<typeof normalizeOutcome>} item */
function outcomeHash(item) { return hash(item); }

/** @param {Db} db @param {ReturnType<typeof normalizeOutcome>} item @param {string} author @param {string} now @param {number|null} importRowId */
function insertOutcome(db, item, author, now, importRowId) {
  const contentHash = outcomeHash(item);
  const existing = get(db, 'SELECT * FROM outcome_records WHERE source = ? AND record_key = ?', [item.source, item.recordKey]);
  if (existing) {
    if (existing.content_hash !== contentHash) throw new OutcomeError('Record identity already exists with different content', 409, 'identity_conflict');
    return outcomeRow(existing);
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
    supersedes_id,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    item.source, item.recordKey, importRowId, item.periodStart, item.periodEnd,
    item.metricName, item.value, item.unit, item.currency, item.attributionMethod,
    item.landingPage, item.notes, author, now, item.supersedesId, contentHash,
  ]).lastInsertRowid;
  return outcomeRow(get(db, 'SELECT * FROM outcome_records WHERE id = ?', [id]));
}

/** @param {import('./db.js').Row|undefined} row */
function outcomeRow(row) {
  if (!row) throw new OutcomeError('Outcome record was not saved', 500, 'storage_error');
  return { id: Number(row.id), source: String(row.source), recordKey: String(row.record_key),
    importRowId: row.import_row_id === null ? null : Number(row.import_row_id),
    periodStart: String(row.period_start), periodEnd: String(row.period_end),
    metricName: String(row.metric_name), value: String(row.value_text), unit: String(row.unit),
    currency: row.currency === null ? null : String(row.currency),
    attributionMethod: String(row.attribution_method),
    landingPage: row.landing_page === null ? null : String(row.landing_page),
    notes: row.notes === null ? null : String(row.notes), author: String(row.author),
    createdAt: String(row.created_at), supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id) };
}

/** @param {Db} db @param {Record<string, unknown>} input */
export function recordOutcome(db, input) {
  const item = normalizeOutcome(input);
  const author = required(input.author, 'author', 120);
  const now = atTime(input.now);
  return transaction(db, () => insertOutcome(db, item, author, now, null));
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
  if (rows.length === 0 || rows[0].join(',') !== OUTCOME_CSV_HEADER) {
    throw new OutcomeError(`CSV header must be exactly: ${OUTCOME_CSV_HEADER}`);
  }
  for (const [index, columns] of rows.entries()) {
    if (columns.length !== CSV_COLUMNS.length) throw new OutcomeError(`CSV row ${index + 1} has ${columns.length} fields; expected ${CSV_COLUMNS.length}`);
  }
  return rows.slice(1).map((columns) => Object.fromEntries(CSV_COLUMNS.map((column, index) => [column, columns[index]])));
}

/** @param {Db} db @param {{source:string,importId:string,csvText:string,author:string,now?:Date|string}} input */
export function importOutcomeCsv(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OutcomeError('Import must be an object');
  const source = required(input.source, 'source', 160);
  const importId = required(input.importId, 'importId', 200);
  const author = required(input.author, 'author', 120);
  const now = atTime(input.now);
  const parsed = parseCsv(input.csvText);
  const items = parsed.map((row) => normalizeOutcome({ source, recordKey: row.record_id,
    periodStart: row.period_start, periodEnd: row.period_end, landingPage: row.landing_page,
    metricName: row.metric_name, value: row.value, unit: row.unit, currency: row.currency,
    attributionMethod: row.attribution_method, notes: row.notes, supersedesId: row.supersedes_id }));
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

/** @param {Db} db @param {{start?:string,end?:string}} [scope] */
export function listOutcomeRecords(db, scope = {}) {
  const { start, end } = window(scope);
  const rows = all(db, `SELECT o.* FROM outcome_records o
    WHERE NOT EXISTS (SELECT 1 FROM outcome_records successor WHERE successor.supersedes_id = o.id)
    ORDER BY o.period_start, o.id`).map(outcomeRow);
  return rows.filter((item) => (start === null || item.periodEnd > start)
    && (end === null || item.periodStart < end)).map((item) => {
    const overlapIds = rows.filter((other) => other.id !== item.id && other.source === item.source
      && other.metricName === item.metricName && other.unit === item.unit
      && other.currency === item.currency && other.landingPage === item.landingPage
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
  const header = ['source', 'import_id', ...CSV_COLUMNS, 'author', 'created_at'];
  const lines = rows.map((row) => [row.source, row.import_id, row.record_key, row.period_start,
    row.period_end, row.landing_page, row.metric_name, row.value_text, row.unit,
    row.currency, row.attribution_method, row.notes, row.supersedes_id, row.author,
    row.created_at].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
