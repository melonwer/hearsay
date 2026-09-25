import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_VERSION, all, get, openDb, run, userVersion } from '../core/db.js';
import {
  COMPARABILITY_STATUSES,
  PROMPT_ORIGINS,
  PROMPT_LANES,
  TARGET_STATUSES,
  WEB_STATUSES,
  comparisonKey,
  createExplorationPrompt,
  eligibilitySql,
  promotePrompt,
  runStatusFromTargets,
} from '../core/subscription-model.js';
import { mentionRate, shareOfVoice } from '../core/metrics.js';
import {
  cleanupArtifacts,
  createArtifactStore,
  hasVerifiedSearch,
  readArtifact,
  recordSearchEvents,
  redactEvent,
  writeArtifact,
} from '../core/artifacts.js';

const FIXTURE = readFileSync(new URL('./fixtures/schema-v1-subscription.sql', import.meta.url), 'utf8');

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-subscription-foundation-'));
  return { dir, dbPath: join(dir, 'hearsay.db') };
}

test('schema-v1 fixture migrates with preserved rows and a verified backup', (t) => {
  const { dir, dbPath } = tempDb();
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(FIXTURE);
  oldDb.close();

  const db = openDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.ok(SCHEMA_VERSION >= 2);
  assert.equal(userVersion(db), SCHEMA_VERSION);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM responses')?.n), 2);
  assert.equal(String(get(db, 'SELECT text FROM responses WHERE id = 1')?.text), 'Acme is a good option.');
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM mentions')?.n), 1);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM citations')?.n), 1);
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM alerts')?.n), 1);

  const response = get(db, `
    SELECT surface, lane, target_status, comparability_status, web_status,
           prompt_text_snapshot, prompt_origin, comparison_key
      FROM responses WHERE id = 1
  `);
  assert.deepEqual(
    { ...response },
    {
      surface: 'openai-api',
      lane: 'tracking',
      target_status: 'completed',
      comparability_status: 'comparable',
      web_status: 'not_applicable',
      prompt_text_snapshot: 'What is the best meeting notes tool?',
      prompt_origin: 'legacy',
      comparison_key: 'legacy:openai:gpt-test',
    },
  );
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM search_events')?.n), 0);

  const backups = readdirSync(dir).filter((name) => /^hearsay\.db\.migration-\d{8}T\d{6}Z\.v1\.db$/.test(name));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(dir, backups[0]));
  assert.equal(Number(backup.prepare('PRAGMA user_version').get().user_version), 1);
  assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM responses').get().n), 2);
  backup.close();
});

test('reopening an upgraded database is idempotent', (t) => {
  const { dir, dbPath } = tempDb();
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(FIXTURE);
  oldDb.close();
  const first = openDb(dbPath);
  first.close();
  const second = openDb(dbPath);
  t.after(() => {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(userVersion(second), SCHEMA_VERSION);
  assert.equal(Number(get(second, 'SELECT COUNT(*) AS n FROM responses')?.n), 2);
  assert.deepEqual(all(second, 'SELECT id FROM search_events'), []);
});

test('exploration prompts stay inactive until explicit promotion', () => {
  const db = openDb(':memory:');
  try {
    run(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'best notes tool', '2026-08-01T00:00:00Z']);
    const created = createExplorationPrompt(db, {
      text: 'Which notes tool should a small team evaluate?',
      origin: 'suggested',
      now: new Date('2026-08-03T10:00:00Z'),
    });
    assert.equal(created.trackingState, 'exploration');
    assert.equal(created.origin, 'suggested');
    assert.equal(created.active, false);
    const before = get(db, 'SELECT tracking_state, active, intent_id, approved_at, promoted_at FROM prompts WHERE id = ?', [created.id]);
    assert.deepEqual({ ...before }, {
      tracking_state: 'exploration',
      active: 0,
      intent_id: null,
      approved_at: null,
      promoted_at: null,
    });

    const promoted = promotePrompt(db, created.id, 1, new Date('2026-08-04T10:00:00Z'));
    assert.equal(promoted.trackingState, 'tracking');
    assert.equal(promoted.active, true);
    assert.equal(promoted.approvedAt, '2026-08-04T10:00:00Z');
    assert.equal(promoted.promotedAt, '2026-08-04T10:00:00Z');
    assert.deepEqual(
      { ...get(db, 'SELECT tracking_state, active, intent_id, approved_at, promoted_at FROM prompts WHERE id = ?', [created.id]) },
      {
        tracking_state: 'tracking',
        active: 1,
        intent_id: 1,
        approved_at: '2026-08-04T10:00:00Z',
        promoted_at: '2026-08-04T10:00:00Z',
      },
    );
  } finally {
    db.close();
  }
});

test('comparison keys are deterministic and separate surface/profile changes', () => {
  const base = {
    surface: 'codex-agent',
    model: 'default',
    promptEnvelopeVersion: 'subscription-search-v1',
    executionProfileHash: 'profile-a',
    locationControl: 'uncontrolled',
    languageControl: 'uncontrolled',
  };
  assert.equal(comparisonKey(base), comparisonKey({ ...base }));
  assert.notEqual(comparisonKey(base), comparisonKey({ ...base, surface: 'claude-code-agent' }));
  assert.notEqual(comparisonKey(base), comparisonKey({ ...base, executionProfileHash: 'profile-b' }));
});

test('eligibility SQL explicitly separates common and verified-subscription cohorts', () => {
  assert.deepEqual(PROMPT_LANES, ['tracking', 'exploration']);
  assert.deepEqual(PROMPT_ORIGINS, ['user_authored', 'suggested', 'imported', 'legacy']);
  assert.deepEqual(TARGET_STATUSES, ['queued', 'running', 'completed', 'failed', 'cancelled']);
  assert.deepEqual(COMPARABILITY_STATUSES, ['comparable', 'non_comparable']);
  assert.deepEqual(WEB_STATUSES, ['verified', 'unavailable', 'unverified', 'failed', 'not_applicable']);
  const common = eligibilitySql('r');
  assert.match(common.sql, /r\.lane = 'tracking'/);
  assert.match(common.sql, /r\.target_status = 'completed'/);
  assert.match(common.sql, /r\.comparability_status = 'comparable'/);
  assert.doesNotMatch(common.sql, /web_status/);
  const subscription = eligibilitySql('r', { subscription: true });
  assert.match(subscription.sql, /r\.web_status = 'verified'/);
  assert.deepEqual(subscription.params, []);
});

test('target statuses reduce to the logical run lifecycle', () => {
  const completed = { target_status: 'completed', comparability_status: 'comparable', web_status: 'verified' };
  assert.equal(runStatusFromTargets([completed, completed]), 'done');
  assert.equal(runStatusFromTargets([completed, { ...completed, target_status: 'failed' }]), 'partial');
  assert.equal(runStatusFromTargets([{ ...completed, target_status: 'completed', comparability_status: 'non_comparable' }]), 'failed');
  assert.equal(runStatusFromTargets([{ ...completed, target_status: 'cancelled' }]), 'cancelled');
  assert.equal(runStatusFromTargets([{ ...completed, target_status: 'missed' }]), 'missed');
});

test('metrics keep API and verified subscription surfaces separate', () => {
  const db = openDb(':memory:');
  try {
    run(db, 'INSERT INTO entities(id, name, aliases, domains, is_self, created_at) VALUES(?,?,?,?,?,?)', [
      1,
      'Acme',
      '[]',
      '[]',
      1,
      '2026-08-01T00:00:00Z',
    ]);
    run(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'best notes', '2026-08-01T00:00:00Z']);
    run(db, 'INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES(?,?,?,?,?,?)', [
      1,
      1,
      'Which notes tool is best?',
      'general',
      1,
      '2026-08-01T00:00:00Z',
    ]);
    run(db, 'INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls) VALUES(?,?,?,?,?,?,?)', [
      1,
      '2026-08-02T00:00:00Z',
      '2026-08-02T00:01:00Z',
      'manual',
      'done',
      3,
      3,
    ]);
    const insert = (id, surface, lane, webStatus, text = 'Acme') => run(db, `
      INSERT INTO responses(
        id, run_id, prompt_id, provider, surface, model, sample_idx, text, created_at,
        lane, target_status, comparability_status, web_status, prompt_text_snapshot, prompt_origin,
        comparison_key
      ) VALUES(?, 1, 1, ?, ?, 'test', ?, ?, '2026-08-02T00:01:00Z', ?, 'completed', 'comparable', ?,
        'Which notes tool is best?', 'user_authored', ?)
    `, [id, surface === 'codex-agent' ? 'openai' : surface.replace('-api', ''), surface, id, text, lane, webStatus, `${surface}:test`]);
    insert(1, 'openai-api', 'tracking', 'not_applicable');
    insert(2, 'codex-agent', 'tracking', 'verified');
    insert(3, 'codex-agent', 'tracking', 'unverified');
    run(db, `INSERT INTO responses(
      id, run_id, prompt_id, provider, surface, model, sample_idx, text, created_at,
      lane, target_status, comparability_status, web_status, prompt_text_snapshot,
      prompt_origin, comparison_key
    ) VALUES(4, 1, 1, 'openai', 'codex-agent', 'new-model', 4, 'Acme',
      '2026-08-02T00:02:00Z', 'tracking', 'completed', 'comparable', 'verified',
      'Which notes tool is best?', 'user_authored', 'codex-agent:new-profile')`);
    run(db, 'INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet) VALUES(?,?,?,?,?,?,?)', [4, 1, 0, 1, 1, 1, 'Acme']);

    assert.equal(mentionRate(db, { entityId: 1, days: 30, now: '2026-08-03T00:00:00Z' }).n, 1);
    assert.equal(
      mentionRate(db, { entityId: 1, surface: 'codex-agent', days: 30, now: '2026-08-03T00:00:00Z' }).n,
      1,
    );
    assert.equal(
      mentionRate(db, { entityId: 1, surface: 'codex-agent', days: 30, now: '2026-08-03T00:00:00Z' }).mentioned,
      1,
      'an explicit surface defaults to the newest comparison series rather than blending profiles',
    );
    assert.deepEqual(
      shareOfVoice(db, { surface: 'codex-agent', days: 30, now: '2026-08-03T00:00:00Z' }).map((row) => [row.name, row.mentions]),
      [['Acme', 1]],
    );
  } finally {
    db.close();
  }
});

test('event redaction happens before artifacts are persisted', () => {
  const event = {
    type: 'tool_result',
    authorization: 'Bearer super-secret-token',
    api_key: 'sk-live-secret',
    email: 'owner@example.com',
    text: 'The visible answer cites https://example.com and sk-another-secret.',
  };
  const redacted = redactEvent(event);
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /super-secret-token|sk-live-secret|owner@example\.com|sk-another-secret/);
  assert.match(serialized, /redacted/i);
  assert.match(serialized, /https:\/\/example\.com/);
});

test('artifact refs are generated, permissioned, readable, and retention-cleanable', () => {
  const { dir } = tempDb();
  const store = createArtifactStore(dir, { retentionDays: 30 });
  const ref = writeArtifact(store, 42, [{ type: 'answer', text: 'safe answer' }]);
  assert.match(ref, /^[a-f0-9]{32}\.jsonl$/);
  assert.deepEqual(readArtifact(store, ref), [{ type: 'answer', text: 'safe answer' }]);
  const path = join(dir, 'artifacts', ref);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => readArtifact(store, '../hearsay.db'), /invalid artifact reference/);

  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(path, old, old);
  assert.equal(cleanupArtifacts(store, new Date('2020-02-01T00:00:00Z')), 1);
  assert.throws(() => readArtifact(store, ref), /not found/);
  rmSync(dir, { recursive: true, force: true });
});

test('raw event artifacts keep unknown fields after redaction and enforce their byte ceiling', () => {
  const { dir } = tempDb();
  try {
    const store = createArtifactStore(dir, { maxBytes: 1024 });
    const ref = writeArtifact(store, 1, [{ type: 'future_search_event',
      query: 'Acme reviews', results: [{ url: 'https://example.org/review' }],
      authorization: 'Bearer private-token',
    }]);
    assert.deepEqual(readArtifact(store, ref), [{ type: 'future_search_event',
      query: 'Acme reviews', results: [{ url: 'https://example.org/review' }],
      authorization: '[REDACTED]',
    }]);
    assert.throws(() => writeArtifact(store, 2, [{ text: 'x'.repeat(2048) }]), /exceeds 1024 bytes/);
    assert.equal(readdirSync(join(dir, 'artifacts')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search events retain verified search separately from fetches and citations', () => {
  const db = openDb(':memory:');
  try {
    run(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'notes', '2026-08-01T00:00:00Z']);
    run(db, 'INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES(?,?,?,?,?,?)', [1, 1, 'best notes?', 'general', 1, '2026-08-01T00:00:00Z']);
    run(db, 'INSERT INTO runs(id, started_at, trigger, status, total_calls, done_calls) VALUES(?,?,?,?,?,?)', [1, '2026-08-01T00:00:00Z', 'manual', 'running', 1, 0]);
    run(db, 'INSERT INTO responses(id, run_id, prompt_id, provider, model, sample_idx, text, created_at) VALUES(?,?,?,?,?,?,?,?)', [1, 1, 1, 'openai', 'test', 0, 'answer', '2026-08-01T00:00:00Z']);
    recordSearchEvents(db, 1, [
      { eventType: 'search', status: 'completed', query: 'best notes', url: 'https://search.example/result', title: 'Result', observedAt: '2026-08-01T00:00:01Z' },
      { eventType: 'fetch', status: 'completed', url: 'https://example.com/page', observedAt: '2026-08-01T00:00:02Z' },
    ]);
    assert.equal(hasVerifiedSearch(db, 1), true);
    assert.deepEqual(
      all(db, 'SELECT event_type, status, query, url FROM search_events ORDER BY id').map((row) => ({ ...row })),
      [
        { event_type: 'search', status: 'completed', query: 'best notes', url: 'https://search.example/result' },
        { event_type: 'fetch', status: 'completed', query: null, url: 'https://example.com/page' },
      ],
    );
  } finally {
    db.close();
  }
});
