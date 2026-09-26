import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildConfig } from '../core/config.js';
import { startServer } from '../server.js';

function fixture(runId = 'run-1') {
  const at = '2026-09-26T10:00:00Z';
  return {
    schemaVersion: 1, runId, createdAt: at, mode: 'research_audit',
    app: { id: 'acme', name: 'Acme', url: 'https://acme.example/', aliases: [], audience: 'Small teams', useCases: ['Send newsletters'] },
    panel: { id: 'panel-1', createdAt: at, reviewedAt: null, questions: [{ id: 'q1', text: 'Which tools help a small team send newsletters?' }], competitors: [] },
    execution: { id: 'execution-1', routes: [], samples: 1, timeoutMs: null, idleTimeoutMs: null, maxOutputBytes: null, envelope: 'host-audit-v1', language: 'English', location: 'uncontrolled' },
    analysis: { id: 'analysis-1', method: 'audit-v1' },
    provenance: { producer: 'hearsay-runtime', limitations: ['Synthetic fixture claiming a producer name; import must remain external.'] },
    evidence: [{ id: 'page-1', type: 'fetched_page', timestamp: at, origin: 'host_research', capture: 'host_reported', sampleId: null, data: { url: 'https://acme.example/docs', title: 'Newsletter setup' } }],
    samples: [],
    recommendations: [{ id: 'guide', title: 'Explain newsletter setup', evidenceIds: ['page-1'], hypothesis: 'A setup guide may answer buyer questions.', proposedChange: 'Draft a setup guide.', effort: 'small', priority: 'high', repeatMeasurement: { questionIds: ['q1'], routeIds: [], supports: 'Buyers find the guide useful.', rejects: 'The guide does not answer their questions.' }, draftPath: 'drafts/guide/content.md' }],
    traceEvents: [{ type: 'source_opened', timestamp: at, url: 'https://acme.example/docs' }],
  };
}

async function server(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-research-api-'));
  const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'research.db'), HEARSAY_DATA_DIR: directory, HEARSAY_DEMO: '0' });
  const app = await startServer({ host: '127.0.0.1', port: 0, portFile: join(directory, 'port'), dbPath: config.dbPath, config, log: () => {} });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { ...app, directory, base, request };
}

test('research HTTP import is immutable, idempotent and separate from native measurements', async (t) => {
  const app = await server(t);
  const input = fixture();
  const first = await app.request('/api/research/import', input);
  assert.equal(first.status, 200);
  assert.equal(first.body.imported, true);
  assert.equal(first.body.provenance, 'external');
  const again = await app.request('/api/research/import', input);
  assert.equal(again.status, 200);
  assert.equal(again.body.imported, false);
  assert.equal(again.body.id, first.body.id);
  const list = await app.request('/api/research?app_id=acme');
  assert.equal(list.body.runs.length, 1);
  assert.equal(list.body.runs[0].provenance, 'external');
  assert.deepEqual((await app.request('/api/research?app_id=other')).body.runs, []);
  const detail = await app.request(`/api/research/${first.body.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.bundle, input);
  assert.deepEqual(detail.body.bundle.traceEvents, input.traceEvents);
  assert.equal(detail.body.provenance, 'external');
  assert.match(detail.body.report, /Neither is a native dashboard measurement/);
  assert.deepEqual(detail.body.actions, []);
  for (const table of ['runs', 'responses', 'mentions', 'source_observations', 'research_actions']) {
    assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  const changed = structuredClone(input);
  changed.provenance.limitations.push('Changed content.');
  const conflict = await app.request('/api/research/import', changed);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'import_conflict');
  assert.deepEqual((await app.request(`/api/research/${first.body.id}`)).body.bundle, input);
});

test('research HTTP validation and revision conflicts return actionable client errors', async (t) => {
  const app = await server(t);
  const invalid = fixture(); invalid.schemaVersion = 99;
  const rejected = await app.request('/api/research/import', invalid);
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.error.code, 'invalid_bundle');
  const badTrace = fixture(); badTrace.traceEvents[0].password = 'not-a-real-credential';
  assert.equal((await app.request('/api/research/import', badTrace)).status, 422);
  await app.request('/api/research/import', fixture());
  const changed = fixture('run-2'); changed.panel.questions[0].text = 'Which tools support weekly mail?';
  const conflict = await app.request('/api/research/import', changed);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'revision_conflict');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM research_runs').get().n, 1);
  assert.equal((await app.request('/api/research/999')).status, 404);
  assert.equal((await app.request('/api/research/not-a-number')).status, 404);
  const second = await app.request('/api/research/import', fixture('run-2'));
  assert.equal(second.status, 200);
  const comparison = await app.request(`/api/research/${second.body.id}/compare?baseline=1`);
  assert.equal(comparison.status, 200);
  assert.equal(comparison.body.eligible, false);
  assert.equal(comparison.body.kind, 'incompatible');
});

test('research proposals stay proposed until an explicit reasoned review', async (t) => {
  const app = await server(t);
  const imported = await app.request('/api/research/import', fixture());
  const id = imported.body.id;
  assert.equal((await app.request(`/api/research/${id}/propose`, { action_id: 'unknown' })).status, 404);
  const proposal = await app.request(`/api/research/${id}/propose`, { action_id: 'guide' });
  assert.equal(proposal.status, 200);
  assert.equal(proposal.body.status, 'proposed');
  assert.equal(proposal.body.reviewed_at, null);
  const duplicate = await app.request(`/api/research/${id}/propose`, { action_id: 'guide' });
  assert.equal(duplicate.body.id, proposal.body.id);
  const reviewPath = `/api/research/actions/${proposal.body.id}/review`;
  assert.equal((await app.request(reviewPath, { status: 'accepted', reason: '   ' })).status, 422);
  assert.equal((await app.request(reviewPath, { status: 'published', reason: 'Unsupported state.' })).status, 422);
  assert.equal((await app.request(`/api/research/${id}`)).body.actions[0].status, 'proposed');
  const reviewed = await app.request(reviewPath, { status: 'accepted', reason: 'The linked evidence supports drafting this guide.' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.status, 'accepted');
  assert.ok(reviewed.body.reviewed_at);
  assert.equal((await app.request(reviewPath, { status: 'dismissed', reason: 'Second decision.' })).status, 409);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
});

test('research mutation endpoints enforce origin and JSON request boundaries', async (t) => {
  const app = await server(t);
  for (const origin of ['https://untrusted.example', 'null']) {
    const response = await app.request('/api/research/import', fixture(), { origin });
    assert.equal(response.status, 403);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM research_runs').get().n, 0);
  const accepted = await app.request('/api/research/import', fixture(), { origin: app.base });
  assert.equal(accepted.status, 200);
  const response = await app.request(`/api/research/${accepted.body.id}/propose`, { action_id: 'guide' }, { origin: 'https://untrusted.example' });
  assert.equal(response.status, 403);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM research_actions').get().n, 0);
  const malformed = await fetch(app.base + '/api/research/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const wrongType = await fetch(app.base + '/api/research/import', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
});

test('three MCP research tools map to the temporary HTTP server', async (t) => {
  const app = await server(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))], {
    cwd: app.directory, env: { PATH: process.env.PATH, HEARSAY_URL: app.base, HEARSAY_MCP_TIMEOUT_MS: '5000' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', (line) => { const value = JSON.parse(line); pending.get(value.id)?.(value); });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timeout')); }, 5000);
    pending.set(id, (value) => { clearTimeout(timer); pending.delete(id); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tools = await rpc('tools/list', {});
  for (const name of ['hearsay_research_import', 'hearsay_research_list', 'hearsay_research_get']) assert.ok(tools.result.tools.some((tool) => tool.name === name));
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, undefined);
    return JSON.parse(response.result.content[0].text);
  };
  const imported = await call('hearsay_research_import', { bundle: fixture() });
  assert.equal(imported.provenance, 'external');
  assert.equal((await call('hearsay_research_list', { app_id: 'acme' })).runs.length, 1);
  const detail = await call('hearsay_research_get', { id: imported.id });
  assert.equal(detail.bundle.runId, 'run-1');
  assert.equal(detail.provenance, 'external');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM responses').get().n, 0);
});
