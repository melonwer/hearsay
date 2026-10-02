/** Optional dashboard reader for immutable, externally produced study snapshots. */
import { createHash } from 'node:crypto';
import { all, get, isoNow, run, transaction } from './db.js';
import { deriveStudyReport } from './study-report.js';
import { validateStudySnapshot, StudyError } from './study-contract.js';
import { StudyOutcomeError, normalizeStudyOutcome, parseStudyOutcomeCsv } from './study-outcomes.js';

export class StudyStoreError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'invalid_study_snapshot') { super(message); this.name = 'StudyStoreError'; this.code = code; }
}
/** @param {unknown} value @param {string} name */
function required(value, name) { if (typeof value !== 'string' || !value.trim() || value.length > 240) throw new StudyStoreError(`${name} must be a non-empty string`); return value.trim(); }
/** @param {unknown} value */
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** @param {unknown} input */
function snapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StudyStoreError('Study snapshot must be an object');
  let item;
  try { item = /** @type {Record<string, any>} */ (validateStudySnapshot(structuredClone(input))); }
  catch (error) { if (error instanceof StudyError) throw new StudyStoreError(error.message, error.code); throw error; }
  const studyId = required(item.manifest?.studyId ?? item.studyId, 'studyId');
  const appId = required(item.manifest?.appId ?? item.appId ?? item.plan?.app?.id, 'appId');
  for (const key of ['manifest', 'plan', 'plans', 'approvals', 'pages', 'versions', 'searchRuns', 'researchRuns', 'changes', 'events', 'outcomes', 'reviews', 'analyses']) {
    if (item[key] !== undefined && !Array.isArray(item[key]) && (key !== 'manifest' && key !== 'plan')) throw new StudyStoreError(`${key} must be an array`);
  }
  item.version = 1; item.studyId = studyId; item.appId = appId;
  return item;
}

/**
 * Import a validated standalone snapshot as external provenance. Re-importing the same
 * bytes is idempotent; a changed snapshot for the same study is a conflict.
 * @param {import('node:sqlite').DatabaseSync} db @param {unknown} input
 */
export function importStudySnapshot(db, input) {
  const item = snapshot(input); const contentHash = hash(item); const now = isoNow();
  return transaction(db, () => {
    const existing = get(db, 'SELECT id,content_hash FROM study_imports WHERE study_id = ? AND content_hash = ? LIMIT 1', [item.studyId, contentHash]);
    const identity = get(db, 'SELECT app_id FROM study_imports WHERE study_id = ? ORDER BY id DESC LIMIT 1', [item.studyId]);
    if (identity && String(identity.app_id) !== item.appId) throw new StudyStoreError('Study identifier belongs to a different app identity', 'app_identity_conflict');
    if (existing && existing.content_hash === contentHash) {
      return { id: Number(existing.id), imported: false, studyId: item.studyId, appId: item.appId, contentHash, provenance: 'external' };
    }
    const id = Number(run(db, 'INSERT INTO study_imports(study_id,app_id,content_hash,snapshot_json,imported_at) VALUES(?,?,?,?,?)', [item.studyId, item.appId, contentHash, JSON.stringify(item), now]).lastInsertRowid);
    return { id, imported: true, studyId: item.studyId, appId: item.appId, contentHash, provenance: 'external', importedAt: now };
  });
}
/** @param {import('node:sqlite').DatabaseSync} db @param {string|null} [appId] */
export function listStudySnapshots(db, appId = null) {
  const rows = all(db, appId ? 'SELECT id,study_id,app_id,content_hash,imported_at,provenance FROM study_imports WHERE app_id = ? ORDER BY id DESC LIMIT 500' : 'SELECT id,study_id,app_id,content_hash,imported_at,provenance FROM study_imports ORDER BY id DESC LIMIT 500', appId ? [appId] : []);
  return rows.map((row) => ({ id: Number(row.id), studyId: String(row.study_id), appId: String(row.app_id), contentHash: String(row.content_hash), importedAt: String(row.imported_at), provenance: String(row.provenance) }));
}
/** @param {import('node:sqlite').DatabaseSync} db @param {number} id */
export function getStudySnapshot(db, id) {
  const row = get(db, 'SELECT * FROM study_imports WHERE id = ?', [id]); if (!row) throw new StudyStoreError('Study snapshot not found', 'not_found');
  const data = JSON.parse(String(row.snapshot_json));
  return { id: Number(row.id), studyId: String(row.study_id), appId: String(row.app_id), contentHash: String(row.content_hash), importedAt: String(row.imported_at), provenance: 'external', snapshot: data, report: deriveStudyReport(data) };
}
/** @param {import('node:sqlite').DatabaseSync} db @param {number} id @param {{source:string, csv:string, changeId?:string}} input */
export function appendStudyOutcomes(db, id, input) {
  const item = getStudySnapshot(db, id); const records = parseStudyOutcomeCsv(input.csv, { studyId: item.studyId, appId: item.appId, source: input.source, changeId: input.changeId });
  const next = structuredClone(item.snapshot); next.outcomes = [...(next.outcomes ?? []), ...records];
  const oldHash = item.contentHash; const newHash = hash(next);
  if (newHash === oldHash) return item;
  throw new StudyStoreError('Imported snapshots are immutable; outcomes must be imported as a new snapshot', 'immutable_snapshot');
}

export { normalizeStudyOutcome, parseStudyOutcomeCsv, StudyOutcomeError };

/** Compatibility name used by the standalone study CLI. @param {import('node:sqlite').DatabaseSync} db @param {unknown} input */
export function importStudy(db, input) { return importStudySnapshot(db, input); }
