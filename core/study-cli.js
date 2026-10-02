import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResearchError, researchHash } from './research-contract.js';
import { readJson } from './research-workspace.js';
import { createStudy, proposeStudyPlan, previewStudy, approveStudy, inspectStudy, loadStudy, captureStudyPage, recordStudyVersion, appendStudyRecord,
  recordStudyDecision, recordStudyAnalysis } from './study-workspace.js';
import { prepareStudyResearch, collectStudyOccurrence, collectStudyDiagnostic, studyScheduleTick, connectStudySchedule, stopStudyCollection } from './study-schedule.js';
import { deriveStudyReport } from './study-report.js';
import { normalizeStudyOutcome, parseStudyOutcomeCsv } from './study-outcomes.js';
import { previewTavilyReconciliation, reconcileTavilyLedger } from './tavily-search.js';

/** @typedef {import('./research-contract.js').ResearchRecord} Record */

export const STUDY_HELP = `
Website studies (saved records; no server required):
hearsay study create --project DIR --input PLAN_JSON
hearsay study propose --study DIR --input PLAN_JSON
hearsay study prepare-routes --study DIR
hearsay study preview|inspect --study DIR [--json]
hearsay study approve --study DIR --confirm HASH --author OWNER
hearsay study capture --study DIR [--input HTML_FILE] [--url URL]
hearsay study version|change|decision|analysis --study DIR --input RECORD_JSON
hearsay study collect|tick --study DIR [--account-directory DIR]
hearsay study diagnostic --study DIR --input DIAGNOSTIC_JSON [--account-directory DIR]
hearsay study tavily-recovery-preview|tavily-recover --input RECOVERY_JSON --account-directory DIR [--confirm HASH --author OWNER]
hearsay study outcomes --study DIR --input JSON_OR_CSV --source SOURCE [--change ID]
hearsay study report|export --study DIR [--output FILE] [--json]
hearsay study connect --study DIR --input INSTALLED_JOB_RECEIPT_JSON
hearsay study stop --study DIR --reason TEXT
hearsay study import --input SNAPSHOT_JSON --database ABSOLUTE_PATH

The host agent proposes sourced buyer angles and analyzes each collection.
Approval enables only the exact scope. A runtime tick collects evidence and
marks analysis due; record a verified host automation receipt with connect.
Tavily reads TAVILY_API_KEY from the environment. No key is saved in records.
`;

/** @param {string} action @param {Record} values */
export async function studyCommand(action, values) {
  const input = () => {
    if (!values.input) throw new ResearchError('invalid_arguments', '--input is required');
    return readJson(resolve(values.input));
  };
  if (action === 'create') {
    if (!values.project) throw new ResearchError('invalid_arguments', '--project is required');
    return createStudy(resolve(values.project), input());
  }
  if (action === 'import') {
    if (!values.database || resolve(values.database) !== values.database) throw new ResearchError('invalid_arguments', 'Import requires explicit absolute --database');
    const { openDb } = await import('./db.js');
    const { importStudySnapshot } = await import('./study-store.js');
    const db = openDb(values.database);
    try { return importStudySnapshot(db, input()); } finally { db.close(); }
  }
  if (action === 'tavily-recovery-preview' || action === 'tavily-recover') {
    if (!values['account-directory']) throw new ResearchError('invalid_arguments', '--account-directory is required for shared account recovery');
    const options = { ...input(), accountDirectory: resolve(values['account-directory']) };
    return action === 'tavily-recovery-preview' ? previewTavilyReconciliation(options) : reconcileTavilyLedger({ ...options, confirm: values.confirm, author: values.author });
  }
  if (!values.study) throw new ResearchError('invalid_arguments', '--study is required');
  const directory = resolve(values.study);
  if (action === 'preview') return previewStudy(directory);
  if (action === 'inspect') return inspectStudy(directory);
  if (action === 'propose') return proposeStudyPlan(directory, input());
  if (action === 'prepare-routes') return prepareStudyResearch(directory);
  if (action === 'approve') {
    if (!values.confirm || !values.author) throw new ResearchError('invalid_arguments', '--confirm and --author are required');
    return approveStudy(directory, values.confirm, { author: values.author });
  }
  if (action === 'capture') return captureStudyPage(directory, { url: values.url,
    ...(values.input ? { html: readFileSync(resolve(values.input), 'utf8'), method: 'owner_supplied_html' } : {}) });
  if (action === 'version') return recordStudyVersion(directory, input());
  if (action === 'decision') return recordStudyDecision(directory, input());
  if (action === 'analysis') return recordStudyAnalysis(directory, input());
  if (action === 'change') {
    const record = input(); const snapshot = loadStudy(directory);
    const result = await appendStudyRecord(directory, 'change', { version: 1, appId: snapshot.manifest.appId, studyId: snapshot.manifest.studyId,
      createdAt: new Date().toISOString(), ...record });
    return result;
  }
  if (action === 'collect' || action === 'tick') {
    const options = { accountDirectory: values['account-directory'] ? resolve(values['account-directory']) : undefined };
    return action === 'tick' ? studyScheduleTick(directory, options) : collectStudyOccurrence(directory, options);
  }
  if (action === 'diagnostic') return collectStudyDiagnostic(directory, { ...input(), accountDirectory: values['account-directory'] ? resolve(values['account-directory']) : undefined });
  if (action === 'connect') return connectStudySchedule(directory, input());
  if (action === 'stop') return stopStudyCollection(directory, values.reason ?? '');
  if (action === 'outcomes') {
    if (!values.input) throw new ResearchError('invalid_arguments', '--input is required');
    const snapshot = loadStudy(directory);
    const raw = readFileSync(resolve(values.input), 'utf8');
    const scope = { studyId: snapshot.manifest.studyId, appId: snapshot.manifest.appId, source: values.source, changeId: values.change };
    const csv = values.input.toLowerCase().endsWith('.csv');
    const parsed = csv ? parseStudyOutcomeCsv(raw, scope) : JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.records ?? [parsed];
    const records = rows.map((/** @type {Record} */ item) => {
      const normalized = normalizeStudyOutcome({ ...scope, ...item, trafficNotes: item.trafficNotes ?? '' });
      const prior = snapshot.outcomes.find((/** @type {Record} */ record) => record.source === normalized.source && record.recordKey === normalized.recordKey);
      return { ...normalized, version: 1, id: item.id ?? `outcome-${researchHash({ source: normalized.source, recordKey: normalized.recordKey }).slice(0, 24)}`,
        studyId: scope.studyId, appId: scope.appId, createdAt: prior?.createdAt ?? item.createdAt ?? new Date().toISOString() };
    });
    for (const record of records) {
      const prior = snapshot.outcomes.find((/** @type {Record} */ item) => item.source === record.source && item.recordKey === record.recordKey);
      if (prior && researchHash({ ...prior, createdAt: null }) !== researchHash({ ...record, createdAt: null })) throw new ResearchError('outcome_conflict', 'Outcome source and record key already have different content');
    }
    if (csv) {
      const importId = `outcome-import-${researchHash(raw).slice(0, 24)}`;
      const prior = snapshot.events.find((/** @type {Record} */ item) => item.id === importId);
      await appendStudyRecord(directory, 'event', { version: 1, id: importId, studyId: scope.studyId, appId: scope.appId, type: 'outcome_import',
        rawCsv: raw, source: scope.source, contentHash: researchHash(raw), createdAt: prior?.createdAt ?? new Date().toISOString() });
    }
    const saved = [];
    for (const record of records) saved.push(await appendStudyRecord(directory, 'outcome', record));
    return { saved };
  }
  if (action === 'report') {
    const snapshot = loadStudy(directory);
    const report = deriveStudyReport(snapshot);
    const record = { ...report, id: `review-${report.id}`, createdAt: new Date().toISOString(), planId: snapshot.plan.id };
    const existing = snapshot.reviews.find((/** @type {Record} */ item) => item.id === record.id);
    if (!existing) {
      await appendStudyRecord(directory, 'review', record);
    }
    if (values.output) writeFileSync(resolve(values.output), report.markdown, { mode: 0o600 });
    return values.json ? report : { report: report.markdown };
  }
  if (action === 'export') {
    const snapshot = loadStudy(directory);
    const bundle = { version: 1, id: `export-${randomUUID()}`, appId: snapshot.manifest.appId, studyId: snapshot.manifest.studyId, provenance: 'external', ...snapshot };
    if (values.output) writeFileSync(resolve(values.output), JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
    return bundle;
  }
  throw new ResearchError('invalid_arguments', 'Unknown study command; use --help');
}
