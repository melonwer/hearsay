import { all, get, run, transaction, isoNow } from './db.js';
import { validateEvidence, canonicalJson, researchHash, ResearchError, summarizeEvidence } from './research-contract.js';
import { renderResearchReport, compareResearch } from './research-report.js';
/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./research-contract.js').ResearchRecord} Record */

/** @param {Db} db @param {unknown} input */
export function importResearch(db, input) {
  const bundle = validateEvidence(input);
  const hash = researchHash(bundle);
  return transaction(db, () => {
    const existing = get(db, 'SELECT id, content_hash FROM research_runs WHERE app_id = ? AND run_id = ?', [bundle.app.id, bundle.runId]);
    if (existing) {
      if (existing.content_hash !== hash) throw new ResearchError('import_conflict', 'Run identifier already exists with different content');
      return { id: Number(existing.id), imported: false, contentHash: hash, provenance: 'external' };
    }
    for (const row of all(db, 'SELECT bundle_json FROM research_runs WHERE app_id = ?', [bundle.app.id])) {
      const prior = JSON.parse(String(row.bundle_json));
      if (['name', 'url'].some((key) => prior.app[key] !== bundle.app[key])) throw new ResearchError('app_identity_conflict', 'App identifier belongs to a different saved identity; use a separate app identifier');
      for (const key of ['panel', 'execution', 'analysis']) if (prior[key].id === bundle[key].id && canonicalJson(prior[key]) !== canonicalJson(bundle[key])) {
        throw new ResearchError('revision_conflict', `${key} revision identifier has different content`);
      }
    }
    const id = Number(run(db, `INSERT INTO research_runs(app_id,run_id,content_hash,schema_version,bundle_json,report_markdown,imported_at)
      VALUES(?,?,?,?,?,?,?)`, [bundle.app.id, bundle.runId, hash, 1, canonicalJson(bundle), renderResearchReport(bundle), isoNow()]).lastInsertRowid);
    for (const item of bundle.evidence) run(db, `INSERT INTO research_evidence(research_id,evidence_id,kind,origin,capture,observation_json) VALUES(?,?,?,?,?,?)`,
      [id, item.id, item.type, item.origin, item.capture, canonicalJson(item)]);
    return { id, imported: true, contentHash: hash, provenance: 'external' };
  });
}
/** @param {Db} db @param {string|null} [appId] @returns {Record[]} */
export function listResearch(db, appId = null) {
  return all(db, `SELECT id,app_id,run_id,content_hash,imported_at,
    json_extract(bundle_json,'$.app.name') AS name, json_extract(bundle_json,'$.createdAt') AS observed_at,
    json_extract(bundle_json,'$.mode') AS mode FROM research_runs ${appId ? 'WHERE app_id = ?' : ''} ORDER BY id DESC LIMIT 500`, appId ? [appId] : []).map((row) => ({ ...row, provenance: 'external' }));
}
/** @param {Db} db @param {number} id */
export function getResearch(db, id) {
  const row = get(db, 'SELECT * FROM research_runs WHERE id = ?', [id]);
  if (!row) throw new ResearchError('not_found', 'Research run not found');
  const bundle = JSON.parse(String(row.bundle_json));
  return { id: Number(row.id), contentHash: String(row.content_hash), importedAt: String(row.imported_at), provenance: 'external', bundle,
    report: String(row.report_markdown), summary: summarizeEvidence(bundle), actions: all(db, 'SELECT * FROM research_actions WHERE research_id = ?', [id]) };
}
/** @param {Db} db @param {number} baseline @param {number} id */
export function compareImportedResearch(db, baseline, id) { return compareResearch(getResearch(db, baseline).bundle, getResearch(db, id).bundle); }
/** @param {Db} db @param {number} id @param {string} actionId */
export function proposeResearchAction(db, id, actionId) {
  const research = getResearch(db, id);
  if (!research.bundle.recommendations.some((/** @type {Record} */ action) => action.id === actionId)) throw new ResearchError('not_found', 'Recommendation not found');
  run(db, `INSERT INTO research_actions(research_id,action_id,status,created_at) VALUES(?,?,'proposed',?) ON CONFLICT(research_id,action_id) DO NOTHING`, [id, actionId, isoNow()]);
  return get(db, 'SELECT * FROM research_actions WHERE research_id = ? AND action_id = ?', [id, actionId]);
}
/** @param {Db} db @param {number} id @param {string} status @param {string} reason */
export function reviewResearchAction(db, id, status, reason) {
  if (!['accepted', 'dismissed'].includes(status) || !reason.trim() || reason.length > 2000) throw new ResearchError('invalid_review', 'A review decision and reason are required');
  const result = run(db, 'UPDATE research_actions SET status = ?, review_reason = ?, reviewed_at = ? WHERE id = ? AND status = ?', [status, reason.trim(), isoNow(), id, 'proposed']);
  if (!result.changes) throw new ResearchError('review_conflict', 'Proposal is missing or already reviewed');
  return get(db, 'SELECT * FROM research_actions WHERE id = ?', [id]);
}
/** @param {Db} db @returns {Record[]} */
export function listResearchActions(db) {
  return all(db, `SELECT a.*,r.app_id,r.run_id,r.bundle_json FROM research_actions a JOIN research_runs r ON r.id=a.research_id ORDER BY a.id DESC LIMIT 500`).map((row) => {
    const bundle = JSON.parse(String(row.bundle_json));
    const { bundle_json, ...rest } = row;
    return { ...rest, recommendation: bundle.recommendations.find((/** @type {Record} */ action) => action.id === row.action_id), app: bundle.app.name, provenance: 'external' };
  });
}
