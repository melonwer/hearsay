import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MIGRATIONS, SCHEMA_VERSION, all, get, openDb, run, userVersion } from '../core/db.js';
import { artifactAvailability, cleanupArtifacts, createArtifactStore, writeArtifact } from '../core/artifacts.js';
import { benchmarkRevision, executionProfile } from '../core/measurement-contract.js';
import { storeMeasurementEvidence, storeTargetDefinition } from '../core/measurement-storage.js';
import { recoverStaleRuns } from '../core/runner.js';
import { exportAll } from '../web/queries.js';

const V1 = readFileSync(new URL('./fixtures/schema-v1-subscription.sql', import.meta.url), 'utf8');

/** @param {DatabaseSync} db */
function advanceFixtureToV4(db) {
  for (const migration of MIGRATIONS.filter((item) => item.version >= 2 && item.version <= 4)) {
    if (migration.version === 2) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    if (typeof migration.apply === 'function') migration.apply(db);
    else db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${migration.version}`);
    db.exec('COMMIT');
    if (migration.version === 2) db.exec('PRAGMA foreign_keys = ON');
  }
}

test('populated v4 data survives current migrations with a readable v4 backup and no invented revisions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-measurement-migration-'));
  const path = join(dir, 'hearsay.db');
  const oldDb = new DatabaseSync(path);
  oldDb.exec(V1);
  advanceFixtureToV4(oldDb);
  run(oldDb, `INSERT INTO search_events(response_id, event_type, status, query, observed_at)
    VALUES(1, 'search', 'completed', 'original query', '2026-08-01T00:00:00Z')`);
  run(oldDb, 'UPDATE responses SET artifact_ref = ? WHERE id = 1', ['fixture-artifact.jsonl']);
  oldDb.close();

  const db = openDb(path);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(userVersion(db), SCHEMA_VERSION);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM responses')?.n), 2);
  assert.equal(String(get(db, 'SELECT text FROM responses WHERE id = 1')?.text), 'Acme is a good option.');
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM mentions')?.n), 1);
  const legacyInterpretation = get(db, `SELECT method, stance, legacy_recommended
    FROM mention_interpretations WHERE mention_id = (SELECT id FROM mentions LIMIT 1)`);
  assert.equal(legacyInterpretation?.method, 'legacy_heuristic');
  assert.equal(legacyInterpretation?.stance, null);
  assert.equal(Number(legacyInterpretation?.legacy_recommended),
    Number(get(db, 'SELECT recommended FROM mentions LIMIT 1')?.recommended));
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM citations')?.n), 1);
  assert.deepEqual({ ...get(db, `SELECT search_policy, execution_profile_id, benchmark_revision_id,
    analysis_revision, query_metadata_status FROM responses WHERE id = 1`) }, {
    search_policy: 'legacy', execution_profile_id: null, benchmark_revision_id: null,
    analysis_revision: null, query_metadata_status: null,
  });
  assert.equal(String(get(db, 'SELECT query FROM search_events WHERE response_id = 1')?.query), 'original query');
  assert.equal(String(get(db, 'SELECT artifact_ref FROM responses WHERE id = 1')?.artifact_ref), 'fixture-artifact.jsonl');
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);

  const backups = readdirSync(dir).filter((name) => /^hearsay\.db\.migration-.*\.v4\.db$/.test(name));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(dir, backups[0]));
  assert.equal(userVersion(backup), 4);
  assert.equal(Number(get(backup, 'SELECT COUNT(*) AS n FROM responses')?.n), 2);
  backup.close();
});

test('populated v5 costs survive v6 without invented price provenance', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-cost-migration-'));
  const path = join(dir, 'hearsay.db');
  const oldDb = new DatabaseSync(path);
  oldDb.exec(V1);
  advanceFixtureToV4(oldDb);
  const fifth = MIGRATIONS.find((item) => item.version === 5);
  oldDb.exec('BEGIN');
  oldDb.exec(String(fifth?.sql));
  oldDb.exec('PRAGMA user_version = 5');
  oldDb.exec('COMMIT');
  run(oldDb, 'UPDATE responses SET cost_usd = ? WHERE id = 1', [0.123]);
  oldDb.close();

  const db = openDb(path);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(userVersion(db), SCHEMA_VERSION);
  assert.deepEqual({ ...get(db, `SELECT cost_usd, cost_known_subtotal_usd, cost_status,
    cost_provenance, cost_price_version FROM responses WHERE id = 1`) }, {
    cost_usd: 0.123, cost_known_subtotal_usd: null, cost_status: null,
    cost_provenance: null, cost_price_version: null,
  });
  const backupName = readdirSync(dir).find((name) => /^hearsay\.db\.migration-.*\.v5\.db$/.test(name));
  assert.ok(backupName);
  const backup = new DatabaseSync(join(dir, backupName));
  assert.equal(userVersion(backup), 5);
  backup.close();
  const exported = /** @type {Record<string, Record<string, unknown>[]>} */ (exportAll(db).tables);
  assert.equal(exported.responses.find((row) => row.id === 1)?.cost_usd, 0.123);
  assert.equal(exported.responses.find((row) => row.id === 1)?.cost_price_version, null);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});

test('new evidence rows retain distinct queries, sources, citations, and attempt usage', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const at = '2026-09-24T00:00:00Z';
  run(db, 'INSERT INTO intents(id, label, created_at) VALUES(1, ?, ?)', ['buyer intent', at]);
  run(db, 'INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES(1, 1, ?, ?, 1, ?)', ['Which tool?', 'discovery', at]);
  run(db, "INSERT INTO runs(id, started_at, trigger, status) VALUES(1, ?, 'manual', 'running')", [at]);
  run(db, 'INSERT INTO execution_profiles(id, surface, snapshot_json, created_at) VALUES(?, ?, ?, ?)',
    ['profile-1', 'openai-api', '{"searchPolicy":"required"}', at]);
  run(db, 'INSERT INTO benchmark_revisions(id, snapshot_json, created_at) VALUES(?, ?, ?)',
    ['benchmark-1', '{"questions":["Which tool?"]}', at]);
  const responseId = run(db, `INSERT INTO responses(
    run_id, prompt_id, provider, surface, model, sample_idx, created_at,
    execution_profile_id, benchmark_revision_id, analysis_revision, search_policy,
    answer_status, evidence_completeness, query_metadata_status
  ) VALUES(1, 1, 'openai', 'openai-api', 'fixture', 0, ?, ?, ?, 'rules-v1',
    'required', 'complete', 'complete', 'available')`, [at, 'profile-1', 'benchmark-1']).lastInsertRowid;
  const eventId = run(db, `INSERT INTO search_events(response_id, event_type, status, observed_at,
    provider_action_id, sequence) VALUES(?, 'search', 'completed', ?, 'call-1', 1)`, [responseId, at]).lastInsertRowid;
  assert.throws(() => run(db, `INSERT INTO search_events(response_id, event_type, status,
    observed_at, provider_action_id, sequence) VALUES(?, 'search', 'completed', ?, 'call-1', 2)`, [responseId, at]), /UNIQUE constraint failed/);
  run(db, `INSERT INTO search_queries(response_id, search_event_id, original_text, normalized_key, ordinal)
    VALUES(?, ?, 'Acme pricing?', 'Acme pricing?', 1)`, [responseId, eventId]);
  run(db, `INSERT INTO source_observations(response_id, search_event_id, url, normalized_url,
    provenance, original_order) VALUES(?, ?, 'https://competitor.example/', 'https://competitor.example/',
    'reported_source', 1)`, [responseId, eventId]);
  run(db, `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
    VALUES(?, 'https://different.example/', 'native_annotation', 1)`, [responseId]);
  run(db, `INSERT INTO usage_components(response_id, attempt_index, continuation_index, component,
    quantity, unit, cost_status, price_version) VALUES(?, 0, 0, 'search', 1, 'calls', 'partial', '2026-09-24')`, [responseId]);

  assert.equal(String(get(db, 'SELECT original_text FROM search_queries WHERE response_id = ?', [responseId])?.original_text), 'Acme pricing?');
  assert.equal(String(get(db, 'SELECT url FROM source_observations WHERE response_id = ?', [responseId])?.url), 'https://competitor.example/');
  assert.equal(String(get(db, 'SELECT url FROM answer_citations WHERE response_id = ?', [responseId])?.url), 'https://different.example/');
  assert.equal(String(get(db, 'SELECT cost_status FROM usage_components WHERE response_id = ?', [responseId])?.cost_status), 'partial');
  assert.throws(() => run(db, `INSERT INTO responses(run_id, prompt_id, provider, surface, model, sample_idx,
    created_at, execution_profile_id, benchmark_revision_id) VALUES(1, 1, 'openai', 'openai-api',
    'fixture', 0, ?, 'profile-1', 'benchmark-1')`, [at]), /UNIQUE constraint failed/);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});

test('queued target keeps its original definitions and stores provider evidence atomically', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const at = '2026-09-24T10:00:00Z';
  run(db, 'INSERT INTO intents(id, label, created_at) VALUES(1, ?, ?)', ['buyer intent', at]);
  run(db, 'INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES(1, 1, ?, ?, 1, ?)', ['Which tool?', 'discovery', at]);
  run(db, "INSERT INTO runs(id, started_at, trigger, status) VALUES(1, ?, 'manual', 'running')", [at]);
  const targetId = run(db, `INSERT INTO responses(run_id, prompt_id, provider, surface, model,
    sample_idx, created_at, target_status) VALUES(1, 1, 'openai', 'codex-agent', 'default',
    0, ?, 'queued')`, [at]).lastInsertRowid;
  const profile = executionProfile({ surface: 'codex-agent', route: 'codex-search-v1',
    model: 'default', searchPolicy: 'required' });
  const benchmark = benchmarkRevision({
    questions: [{ id: 1, intentId: 1, category: 'discovery', text: 'Which tool?' }],
    entities: [{ id: 1, role: 'brand', name: 'Acme', aliases: [], domains: ['acme.example'] }],
    weighting: 'equal', scope: 'main',
  });
  storeTargetDefinition(db, targetId, { profile, benchmark, analysisRevision: 'rules-v1',
    searchPolicy: 'required', at });
  benchmark.snapshot.questions[0].text = 'Edited later';
  assert.equal(String(get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [benchmark.id])?.snapshot_json)
    .includes('Which tool?'), true);
  assert.throws(() => storeTargetDefinition(db, targetId, { profile, benchmark,
    analysisRevision: 'rules-v2', searchPolicy: 'required', at }), /Definition ID does not match/);

  const evidence = {
    policy: /** @type {const} */ ('required'), answerStatus: /** @type {const} */ ('complete'),
    answer: 'Acme is discussed.', at,
    actions: [{ id: 'call-1', kind: /** @type {const} */ ('search'), status: /** @type {const} */ ('completed'),
      queryMetadata: /** @type {const} */ ('available'), queries: ['  Cafe\u0301  pricing? '],
      observedAt: at, providerType: 'web_search_call' }],
    sources: [{ id: 'source-1', url: 'https://competitor.example/page?q=1#section', title: 'Competitor',
      provenance: /** @type {const} */ ('reported_source'), actionId: 'call-1', order: 1 }],
    citations: [{ url: 'https://cited.example/', provenance: /** @type {const} */ ('native_annotation'),
      sourceId: null, start: 0, end: 5 }],
    usage: [{ targetId: String(targetId), attempt: 0, continuation: 0, component: 'web_search',
      quantity: 1, unit: 'calls', costUsd: null, costStatus: /** @type {const} */ ('partial'),
      priceVersion: null }],
  };
  assert.throws(() => storeMeasurementEvidence(db, targetId, {
    ...evidence, sources: [{ ...evidence.sources[0], url: 'file:///etc/passwd' }],
  }), /HTTP\(S\) URL/);
  assert.throws(() => storeMeasurementEvidence(db, targetId, {
    ...evidence, usage: [{ ...evidence.usage[0], targetId: 'someone-else' }],
  }), /Usage target ID is wrong/);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM search_events WHERE response_id = ?', [targetId])?.n), 0);
  assert.equal(get(db, 'SELECT answer_status FROM responses WHERE id = ?', [targetId])?.answer_status, null);

  storeMeasurementEvidence(db, targetId, evidence);
  assert.deepEqual({ ...get(db, `SELECT text, search_policy, target_status, answer_status, web_status,
    evidence_completeness, query_metadata_status, comparability_status FROM responses WHERE id = ?`, [targetId]) }, {
    text: 'Acme is discussed.', search_policy: 'required', target_status: 'completed',
    answer_status: 'complete', web_status: 'verified',
    evidence_completeness: 'complete', query_metadata_status: 'available',
    comparability_status: 'comparable',
  });
  assert.equal(String(get(db, 'SELECT original_text FROM search_queries WHERE response_id = ?', [targetId])?.original_text), '  Cafe\u0301  pricing? ');
  assert.deepEqual({ ...get(db, 'SELECT query, url FROM search_events WHERE response_id = ?', [targetId]) }, {
    query: '  Cafe\u0301  pricing? ', url: 'https://competitor.example/page?q=1#section',
  });
  assert.equal(String(get(db, 'SELECT normalized_key FROM search_queries WHERE response_id = ?', [targetId])?.normalized_key), 'Café pricing?');
  assert.equal(String(get(db, 'SELECT normalized_url FROM source_observations WHERE response_id = ?', [targetId])?.normalized_url), 'https://competitor.example/page?q=1');
  assert.equal(String(get(db, 'SELECT url FROM answer_citations WHERE response_id = ?', [targetId])?.url), 'https://cited.example/');
  assert.equal(String(get(db, 'SELECT cost_status FROM usage_components WHERE response_id = ?', [targetId])?.cost_status), 'partial');
  assert.throws(() => storeMeasurementEvidence(db, targetId, evidence), /unfinished target/);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM source_observations WHERE response_id = ?', [targetId])?.n), 1);

  const dir = mkdtempSync(join(tmpdir(), 'hearsay-expired-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir, { retentionDays: 1 });
  const ref = writeArtifact(store, targetId, [{ type: 'provider-event' }]);
  run(db, 'UPDATE responses SET artifact_ref = ? WHERE id = ?', [ref, targetId]);
  assert.equal(artifactAvailability(store, ref), 'available');
  utimesSync(join(store.root, ref), new Date('2026-09-20T00:00:00Z'), new Date('2026-09-20T00:00:00Z'));
  assert.equal(cleanupArtifacts(store, new Date('2026-09-24T00:00:00Z')), 1);
  assert.equal(artifactAvailability(store, ref), 'expired');

  const exported = exportAll(db);
  const tables = /** @type {Record<string, Record<string, unknown>[]>} */ (exported.tables);
  assert.equal(exported.exportFormatVersion, 7);
  assert.equal(exported.databaseSchemaVersion, SCHEMA_VERSION);
  assert.equal(tables.execution_profiles.length, 1);
  assert.equal(tables.benchmark_revisions.length, 1);
  assert.equal(tables.search_queries[0].original_text, '  Cafe\u0301  pricing? ');
  assert.equal(tables.source_observations[0].url, 'https://competitor.example/page?q=1#section');
  assert.equal(tables.answer_citations[0].url, 'https://cited.example/');
  assert.equal(tables.usage_components[0].cost_status, 'partial');
});

test('interrupted target recovery keeps its definition and invents no evidence', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const at = '2026-09-24T00:00:00Z';
  run(db, 'INSERT INTO intents(id, label, created_at) VALUES(1, ?, ?)', ['buyer intent', at]);
  run(db, 'INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES(1, 1, ?, ?, 1, ?)', ['Which tool?', 'discovery', at]);
  run(db, "INSERT INTO runs(id, started_at, trigger, status, total_calls, done_calls) VALUES(1, ?, 'manual', 'running', 1, 0)", [at]);
  const targetId = run(db, `INSERT INTO responses(run_id, prompt_id, provider, surface, model,
    sample_idx, created_at, target_status, prompt_text_snapshot) VALUES(1, 1, 'openai',
    'codex-agent', 'default', 0, ?, 'queued', 'Which tool?')`, [at]).lastInsertRowid;
  const profile = executionProfile({ surface: 'codex-agent', route: 'codex-search-v1',
    model: 'default', searchPolicy: 'required' });
  const benchmark = benchmarkRevision({ questions: [{ id: 1, intentId: 1, category: 'discovery', text: 'Which tool?' }],
    entities: [], weighting: 'equal', scope: 'main' });
  storeTargetDefinition(db, targetId, { profile, benchmark, analysisRevision: 'rules-v1',
    searchPolicy: 'required', at });
  run(db, "UPDATE responses SET target_status = 'running' WHERE id = ?", [targetId]);

  assert.equal(recoverStaleRuns(db, { now: new Date('2026-09-24T03:00:00Z') }), 1);
  assert.deepEqual({ ...get(db, `SELECT target_status, answer_status, evidence_completeness,
    execution_profile_id, benchmark_revision_id, analysis_revision, query_metadata_status
    FROM responses WHERE id = ?`, [targetId]) }, {
    target_status: 'failed', answer_status: 'failed', evidence_completeness: 'unavailable',
    execution_profile_id: profile.id, benchmark_revision_id: benchmark.id,
    analysis_revision: 'rules-v1', query_metadata_status: 'unavailable',
  });
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM search_queries WHERE response_id = ?', [targetId])?.n), 0);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});
