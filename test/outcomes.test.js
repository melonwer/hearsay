import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get, openDb, run } from '../core/db.js';
import { exportOutcomeCsv, importOutcomeCsv, listLedgerEntries, listOutcomeRecords,
  OUTCOME_CSV_HEADER, OutcomeError, recordLedgerEntry, recordOutcome } from '../core/outcomes.js';

const START = '2026-09-01T00:00:00Z';
const NEXT = '2026-09-02T00:00:00Z';
const END = '2026-09-03T00:00:00Z';
const LATER = '2026-09-04T00:00:00Z';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

/** @param {Record<string, unknown>} [overrides] */
function outcome(overrides = {}) {
  return { source: 'analytics', recordKey: 'r1', periodStart: START, periodEnd: NEXT,
    landingPage: 'https://example.test/guide', metricName: 'qualified_leads', value: '2',
    unit: 'count', attributionMethod: 'unattributed', notes: 'Reported by user', author: 'owner',
    now: END, ...overrides };
}

/** @param {Record<string, unknown>} [overrides] */
function ledger(overrides = {}) {
  return { source: 'manual', entryKey: 'e1', kind: 'time', activity: 'Review evidence',
    periodStart: START, periodEnd: NEXT, minutes: 35, author: 'owner', now: END, ...overrides };
}

/** @param {string[]} fields */
function csvLine(fields) {
  return fields.map((field) => /[",\r\n]/.test(field)
    ? `"${field.replaceAll('"', '""')}"` : field).join(',');
}

/** @param {string} recordId @param {Record<string,string>} [overrides] */
function csvRecord(recordId, overrides = {}) {
  const row = { record_id: recordId, period_start: START, period_end: NEXT,
    landing_page: 'https://example.test/guide', metric_name: 'qualified_leads', value: '2',
    unit: 'count', currency: '', attribution_method: 'unattributed', notes: '', supersedes_id: '', ...overrides };
  return csvLine(OUTCOME_CSV_HEADER.split(',').map((key) => row[key]));
}

test('manual records are immutable, idempotent by source and key, and preserve canonical values', (t) => {
  const db = fixture(t);
  const first = recordOutcome(db, outcome({ periodStart: '2026-09-01', periodEnd: '2026-09-02', value: '02' }));
  assert.equal(first.value, '2');
  assert.equal(first.periodStart, START);
  assert.equal(recordOutcome(db, outcome()).id, first.id);
  assert.throws(() => recordOutcome(db, outcome({ value: '3' })),
    (error) => error instanceof OutcomeError && error.status === 409 && error.code === 'identity_conflict');
  assert.equal(recordOutcome(db, outcome({ source: 'other' })).recordKey, 'r1');
  assert.throws(() => run(db, 'UPDATE outcome_records SET value_text = ? WHERE id = ?', ['999', first.id]), /immutable/);
});

test('explicit same-source corrections replace active reads while export retains history', (t) => {
  const db = fixture(t);
  const first = recordOutcome(db, outcome());
  assert.throws(() => recordOutcome(db, outcome({ source: 'other', recordKey: 'wrong-source', supersedesId: first.id })), /same source/);
  const corrected = recordOutcome(db, outcome({ recordKey: 'r1-corrected', value: '4', supersedesId: first.id }));
  assert.deepEqual(listOutcomeRecords(db).map((item) => item.id), [corrected.id]);
  assert.throws(() => recordOutcome(db, outcome({ recordKey: 'r1-second', value: '5', supersedesId: first.id })),
    (error) => error instanceof OutcomeError && error.code === 'correction_conflict');
  const exported = exportOutcomeCsv(db);
  assert.match(exported, /r1,/);
  assert.match(exported, /r1-corrected,/);
  assert.match(exported, new RegExp(`,${first.id},owner,`));
});

test('strict bounded CSV imports replay, deduplicate across batches, and retain the raw input', (t) => {
  const db = fixture(t);
  const csv = `${OUTCOME_CSV_HEADER}\r\n${csvRecord('r1', { notes: 'A "quoted",\nline' })}\r\n`;
  const first = importOutcomeCsv(db, { source: 'analytics', importId: 'batch-1', csvText: csv, author: 'owner', now: END });
  assert.equal(first.replayed, false);
  assert.equal(first.records[0].notes, 'A "quoted",\nline');
  assert.equal(get(db, 'SELECT raw_csv FROM outcome_imports WHERE id = ?', [first.id])?.raw_csv, csv);
  const replay = importOutcomeCsv(db, { source: 'analytics', importId: 'batch-1', csvText: csv, author: 'other', now: LATER });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.records.map((item) => item.id), first.records.map((item) => item.id));
  const secondCsv = `${OUTCOME_CSV_HEADER}\n${csvRecord('r1', { notes: 'A "quoted",\nline', value: '02' })}\n`;
  const second = importOutcomeCsv(db, { source: 'analytics', importId: 'batch-2', csvText: secondCsv, author: 'owner' });
  assert.equal(second.records[0].id, first.records[0].id);
  assert.deepEqual(importOutcomeCsv(db, { source: 'analytics', importId: 'batch-2', csvText: secondCsv, author: 'owner' })
    .records.map((item) => item.id), [first.records[0].id]);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_records')?.n), 1);
  assert.throws(() => importOutcomeCsv(db, { source: 'analytics', importId: 'batch-1',
    csvText: `${OUTCOME_CSV_HEADER}\n${csvRecord('r1', { value: '3' })}\n`, author: 'owner' }),
  (error) => error instanceof OutcomeError && error.code === 'import_conflict');
  assert.throws(() => importOutcomeCsv(db, { source: 'analytics', importId: 'batch-3',
    csvText: `${OUTCOME_CSV_HEADER}\n${csvRecord('r1', { value: '3' })}\n`, author: 'owner' }),
  (error) => error instanceof OutcomeError && error.code === 'identity_conflict');
});

test('a malformed later CSV row rolls back the whole import', (t) => {
  const db = fixture(t);
  const bad = `${OUTCOME_CSV_HEADER}\n${csvRecord('good')}\n${csvRecord('bad', { period_end: '2026-02-30' })}\n`;
  assert.throws(() => importOutcomeCsv(db, { source: 'analytics', importId: 'bad', csvText: bad, author: 'owner' }), /valid UTC/);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_records')?.n), 0);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_imports')?.n), 0);
  for (const csv of [`${OUTCOME_CSV_HEADER}\n${csvRecord('good')}\n"unterminated`,
    `${OUTCOME_CSV_HEADER}\n${csvRecord('good').replace('good', '"bad"x')}`,
    `${OUTCOME_CSV_HEADER}\n${csvRecord('good')}\rBAD`,
    `${OUTCOME_CSV_HEADER}\n${csvRecord('good')},extra`]) {
    assert.throws(() => importOutcomeCsv(db, { source: 'analytics', importId: 'malformed', csvText: csv, author: 'owner' }), OutcomeError);
  }
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_records')?.n), 0);
});

test('a conflicting later CSV row rolls back earlier valid inserts', (t) => {
  const db = fixture(t);
  recordOutcome(db, outcome({ recordKey: 'existing' }));
  const csv = `${OUTCOME_CSV_HEADER}\n${csvRecord('new')}\n${csvRecord('existing', { value: '7' })}\n`;
  assert.throws(() => importOutcomeCsv(db, { source: 'analytics', importId: 'conflict', csvText: csv, author: 'owner' }),
    (error) => error instanceof OutcomeError && error.code === 'identity_conflict');
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_records')?.n), 1);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_imports')?.n), 0);
});

test('CSV rejects malformed count and currency before committing any row', (t) => {
  const db = fixture(t);
  for (const badRow of [csvRecord('bad-count', { value: '1.5' }),
    csvRecord('bad-currency', { unit: 'money', value: '12.50', currency: 'ZZZ' })]) {
    const csv = `${OUTCOME_CSV_HEADER}\n${csvRecord('good')}\n${badRow}\n`;
    assert.throws(() => importOutcomeCsv(db, { source: 'analytics', importId: 'bad', csvText: csv, author: 'owner' }), OutcomeError);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_records')?.n), 0);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM outcome_imports')?.n), 0);
  }
});

test('counts, dates, currency, and numeric values reject malformed inputs', (t) => {
  const db = fixture(t);
  for (const value of ['1.5', '-1', '9007199254740992', '1e3']) {
    assert.throws(() => recordOutcome(db, outcome({ recordKey: value, value })), /safe integer/);
  }
  for (const periodEnd of ['2026-09-01T00:00:00Z', '2026-02-30', '2026-09-03T00:00:00+02:00']) {
    assert.throws(() => recordOutcome(db, outcome({ periodEnd })), OutcomeError);
  }
  assert.throws(() => recordOutcome(db, outcome({ currency: 'ZZZ' })), /currency/);
  assert.throws(() => recordOutcome(db, outcome({ currency: 'USD' })), /Count records/);
  assert.throws(() => recordOutcome(db, outcome({ unit: 'money' })), /require currency/);
  assert.equal(recordOutcome(db, outcome({ recordKey: 'revenue', metricName: 'revenue',
    value: '0004.5000', unit: 'money', currency: 'USD' })).value, '4.5');
});

test('overlaps are flagged without summing and scoped windows use half-open boundaries', (t) => {
  const db = fixture(t);
  const first = recordOutcome(db, outcome({ recordKey: 'a', periodStart: START, periodEnd: END }));
  const overlapping = recordOutcome(db, outcome({ recordKey: 'b', periodStart: NEXT, periodEnd: LATER }));
  const boundary = recordOutcome(db, outcome({ recordKey: 'c', periodStart: LATER,
    periodEnd: '2026-09-05T00:00:00Z' }));
  const allRows = listOutcomeRecords(db);
  assert.deepEqual(allRows.find((item) => item.id === first.id)?.overlapIds, [overlapping.id]);
  assert.deepEqual(allRows.find((item) => item.id === overlapping.id)?.overlapIds, [first.id]);
  assert.deepEqual(allRows.find((item) => item.id === boundary.id)?.overlapIds, []);
  assert.deepEqual(listOutcomeRecords(db, { start: START, end: NEXT }).map((item) => item.id), [first.id]);
  assert.deepEqual(listOutcomeRecords(db, { start: END, end: LATER }).map((item) => item.id), [overlapping.id]);
  assert.deepEqual(listOutcomeRecords(db, { start: LATER, end: '2026-09-05T00:00:00Z' })
    .map((item) => item.id), [boundary.id]);
  assert.equal(exportOutcomeCsv(db, { start: END, end: LATER }).includes(',a,'), false);
});

test('ledger distinguishes unknown time and cost from zero and preserves currencies', (t) => {
  const db = fixture(t);
  const knownTime = recordLedgerEntry(db, ledger());
  assert.equal(recordLedgerEntry(db, ledger()).id, knownTime.id);
  assert.throws(() => recordLedgerEntry(db, ledger({ minutes: 36 })),
    (error) => error instanceof OutcomeError && error.status === 409);
  const unknownTime = recordLedgerEntry(db, ledger({ entryKey: 'e2', minutes: null }));
  const unknownExpense = recordLedgerEntry(db, ledger({ entryKey: 'e3', kind: 'expense',
    activity: 'Contractor', minutes: null, amount: null, currency: 'EUR' }));
  const knownExpense = recordLedgerEntry(db, ledger({ entryKey: 'e4', kind: 'expense',
    activity: 'Research', minutes: null, amount: '0012.3400', currency: 'USD' }));
  assert.equal(unknownTime.minutes, null);
  assert.equal(unknownExpense.amount, null);
  assert.equal(knownExpense.amount, '12.34');
  assert.equal(knownExpense.currency, 'USD');
  assert.deepEqual(listLedgerEntries(db, { start: NEXT, end: END }), []);
  assert.equal(listLedgerEntries(db, { start: START, end: NEXT }).length, 4);
  assert.throws(() => recordLedgerEntry(db, ledger({ entryKey: 'e5', kind: 'expense',
    minutes: null, amount: '4' })), /currency/);
  assert.throws(() => recordLedgerEntry(db, ledger({ entryKey: 'e6', minutes: -1 })), /safe integer/);
  assert.throws(() => recordLedgerEntry(db, ledger({ entryKey: 'e7', opportunityId: 999 })), /not found/);
  assert.throws(() => run(db, 'DELETE FROM ledger_entries WHERE id = ?', [knownTime.id]), /immutable/);
});

test('CSV export neutralizes formulas after whitespace in every text field', (t) => {
  const db = fixture(t);
  recordOutcome(db, outcome({ source: '=SOURCE()', recordKey: '+KEY()',
    landingPage: '  @PAGE()', metricName: '=METRIC()', unit: '@UNIT()',
    attributionMethod: '-METHOD()', notes: '\t=HYPERLINK("https://bad.test")',
    author: '+AUTHOR()' }));
  const csv = exportOutcomeCsv(db);
  assert.match(csv, /'=SOURCE\(\)/);
  assert.match(csv, /'\+KEY\(\)/);
  assert.match(csv, /'  @PAGE\(\)/);
  assert.match(csv, /'=METRIC\(\)/);
  assert.match(csv, /'@UNIT\(\)/);
  assert.match(csv, /'-METHOD\(\)/);
  assert.match(csv, /'\t=HYPERLINK/);
  assert.match(csv, /'\+AUTHOR\(\)/);
  assert.doesNotMatch(csv, /(?:^|,)\s*[=+@-](?:SOURCE|KEY|PAGE|METRIC|UNIT|METHOD|AUTHOR)/m);
});
