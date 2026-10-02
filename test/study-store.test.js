import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfig } from '../core/config.js';
import { startServer } from '../server.js';
import { openDb } from '../core/db.js';
import { importStudySnapshot, listStudySnapshots, getStudySnapshot } from '../core/study-store.js';

function validSnapshot() {
  const plan = { version: 1, id: 'plan-1', studyId: 's1', appId: 'a1', createdAt: '2026-01-01T00:00:00Z', app: { id: 'a1', name: 'App', url: 'https://example.test/', aliases: [], audience: 'founders', useCases: ['test'] }, targetUrl: 'https://example.test/', comparison: { design: 'before_after', referenceUrl: null, assignment: null, trafficNotes: 'owner supplied' }, outcome: { metric: 'leads', unit: 'count', minimumDenominator: 1, minimumObservations: 1, minimumEffect: 0, lossLimit: 0, reviewPeriodDays: 1, stopRules: ['review'] }, angles: [{ id: 'angle-1', label: 'Test', buyerJob: 'test', rationale: 'test', evidenceIds: [], questionIds: ['question-1'] }], questions: [{ id: 'question-1', angleId: 'angle-1', text: 'Which apps help founders test a page?' }], collection: { at: '09:00', timezone: 'UTC', occurrences: 1, maxDays: 1, firstReviewDays: 1, reviewEveryDays: 1 }, tavily: { enabled: false, accountId: null, searchDepth: 'basic', maxResults: 1, collectionCredits: 0, diagnosticCredits: 0, allowance: 0, strictFreeMode: true }, permissions: { actions: [], repository: null, publishTarget: null }, reportDestination: null, research: null };
  return { version: 1, studyId: 's1', appId: 'a1', manifest: { version: 1, id: 's1', studyId: 's1', appId: 'a1', currentPlanId: 'plan-1', approvalId: null, activeVersionId: null }, plans: [plan], plan, approvals: [], pages: [], versions: [], searchRuns: [], researchRuns: [], changes: [], events: [], outcomes: [], reviews: [], analyses: [] };
}

test('study dashboard imports are immutable external snapshots', () => {
  const db = openDb(':memory:');
  const snapshot = validSnapshot();
  const first = importStudySnapshot(db, snapshot); const again = importStudySnapshot(db, snapshot);
  assert.equal(first.imported, true); assert.equal(again.imported, false); assert.equal(listStudySnapshots(db, 'a1').length, 1);
  const detail = getStudySnapshot(db, first.id); assert.equal(detail.provenance, 'external'); assert.equal(detail.report.studyId, 's1');
  assert.throws(() => db.prepare('UPDATE study_imports SET app_id = ? WHERE id = ?').run('x', first.id), /immutable/);
  db.close();
});


test('study dashboard API import/list/detail keeps external provenance and renders it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-study-dashboard-'));
  const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'study.db'), HEARSAY_DATA_DIR: directory, HEARSAY_DEMO: '0' });
  const app = await startServer({ host: '127.0.0.1', port: 0, portFile: join(directory, 'port'), dbPath: config.dbPath, config, log: () => {} });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`; const snapshot = validSnapshot();
  const imported = await (await fetch(`${base}/api/studies/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) })).json();
  assert.equal(imported.provenance, 'external');
  const historical = structuredClone(snapshot); historical.events = [{ version: 1, id: 'event-1', studyId: 's1', appId: 'a1', type: 'note', createdAt: '2026-01-02T00:00:00Z' }];
  const second = await (await fetch(`${base}/api/studies/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(historical) })).json(); assert.notEqual(second.id, imported.id);
  const list = await (await fetch(`${base}/api/studies?app_id=a1`)).json(); assert.equal(list.studies.length, 2);
  const detail = await (await fetch(`${base}/api/studies/${imported.id}`)).json(); assert.equal(detail.provenance, 'external');
  const page = await (await fetch(`${base}/research?study_id=${imported.id}`)).text(); assert.match(page, /immutable snapshot/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
});
