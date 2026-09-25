import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { get, openDb, run, setSetting, SETTING_KEYS } from '../core/db.js';
import { subscriptionExecutionBudget } from '../core/execution-budget.js';
import { stableIdentity } from '../core/measurement-contract.js';
import { startScheduler } from '../core/scheduler.js';
import { saveSubscriptionSchedule, SCHEDULE_CONSENT_VERSION } from '../core/subscription-scheduler.js';
import { trackingHealth } from '../core/tracking-health.js';
import { startServer } from '../server.js';

test('restart after an old API run records a missed occurrence without spending or replaying it', async () => {
  const db = openDb(':memory:');
  const config = buildConfig({ OPENAI_API_KEY: 'fixture', HEARSAY_RUN_AT: '07:00' });
  setSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, '2026-09-21');
  let calls = 0;
  let clock = new Date(2026, 8, 25, 9, 0, 0);
  const scheduler = startScheduler({ db, config, now: () => clock, runPanel: async () => { calls += 1; } });
  try {
    assert.equal(await scheduler.tick(), false);
    assert.equal(calls, 0);
    assert.equal(get(db, "SELECT status FROM runs WHERE schedule_key='api-panel'")?.status, 'missed');
    const health = trackingHealth({ db, config, now: clock });
    assert.equal(health.api.enabled, true);
    assert.equal(health.api.stale, true);
    assert.match(health.api.guidance ?? '', /missed or failed/);
    assert.equal(health.api.recentIssues.length, 1);
    assert.ok(Date.parse(health.api.nextScheduledAt ?? '') > clock.getTime());
    clock = new Date(2026, 8, 26, 7, 0, 0);
    assert.equal(await scheduler.tick(), true);
    assert.equal(calls, 1);
  } finally {
    scheduler.stop();
    db.close();
  }
});

test('an API schedule rejection before run creation is recorded as failed', async () => {
  const db = openDb(':memory:');
  const config = buildConfig({ OPENAI_API_KEY: 'fixture', HEARSAY_RUN_AT: '07:00' });
  let clock = new Date(2026, 8, 25, 6, 0, 0);
  const scheduler = startScheduler({ db, config, now: () => clock,
    runPanel: async () => { throw new Error('preflight rejected'); }, log: () => {} });
  try {
    clock = new Date(2026, 8, 25, 7, 0, 0);
    assert.equal(await scheduler.tick(), false);
    assert.equal(get(db, "SELECT status FROM runs WHERE schedule_key = 'api-panel'")?.status, 'failed');
    const health = trackingHealth({ db, config, now: clock });
    assert.equal(health.api.recentIssues[0]?.status, 'failed');
    assert.equal(health.api.stale, true);
    assert.equal(await scheduler.tick(), false);
    assert.equal(Number(get(db, "SELECT COUNT(*) AS n FROM runs WHERE schedule_key = 'api-panel'")?.n), 1);
  } finally {
    scheduler.stop();
    db.close();
  }
});

test('subscription-only tracking shows a next occurrence and changed profile requires new consent', () => {
  const db = openDb(':memory:');
  const config = buildConfig({ HEARSAY_CODEX_ENABLED: '1' });
  const now = new Date('2026-09-25T06:00:00Z');
  try {
    const hash = stableIdentity([subscriptionExecutionBudget(config, 'codex-agent')]);
    saveSubscriptionSchedule(db, { runAt: '07:00', timeZone: 'UTC', surfaces: ['codex-agent'],
      targetCeiling: 1, consentVersion: SCHEDULE_CONSENT_VERSION, executionBudgetHash: hash, now });
    const health = trackingHealth({ db, config, now });
    assert.equal(health.api.enabled, false);
    assert.equal(health.subscription.enabled, true);
    assert.equal(health.subscription.ready, true);
    assert.equal(health.subscription.nextScheduledAt, '2026-09-25T07:00:00.000Z');
    assert.match(health.subscription.guidance ?? '', /No successful observation yet/);
    const changed = buildConfig({ HEARSAY_CODEX_ENABLED: '1', HEARSAY_CODEX_PATH: '/tmp/new-codex' });
    const afterChange = trackingHealth({ db, config: changed, now });
    assert.equal(afterChange.subscription.enabled, true);
    assert.equal(afterChange.subscription.ready, false);
    assert.equal(afterChange.subscription.consentCurrent, false);
    assert.match(afterChange.subscription.guidance ?? '', /consent cannot be verified/);
    const demo = trackingHealth({ db, config: buildConfig({ HEARSAY_DEMO: '1', HEARSAY_CODEX_ENABLED: '1' }), now });
    assert.equal(demo.api.enabled, false);
    assert.equal(demo.subscription.enabled, false);
    assert.match(demo.subscription.guidance ?? '', /disabled in demo mode/);
  } finally {
    db.close();
  }
});

test('a subscription-only process picks up consent saved after startup', async () => {
  const db = openDb(':memory:');
  const config = buildConfig({ HEARSAY_CODEX_ENABLED: '1' });
  let clock = new Date('2026-09-25T06:00:00Z');
  const scheduler = startScheduler({ db, config, now: () => clock });
  try {
    assert.equal(scheduler.enabled, true);
    assert.equal(await scheduler.tick(), false);
    saveSubscriptionSchedule(db, { runAt: '07:00', timeZone: 'UTC', surfaces: ['codex-agent'],
      targetCeiling: 1, consentVersion: SCHEDULE_CONSENT_VERSION, now: clock });
    clock = new Date('2026-09-25T08:00:00Z');
    assert.equal(await scheduler.tick(), true);
    assert.equal(get(db, "SELECT status FROM runs WHERE schedule_key='subscription-agent'")?.status, 'missed');
    assert.equal(trackingHealth({ db, config, now: clock }).subscription.enabled, true);
  } finally {
    scheduler.stop();
    db.close();
  }
});

test('last successful observation uses completed answers and does not claim failed answers as success', () => {
  const db = openDb(':memory:');
  const config = buildConfig({ HEARSAY_CODEX_ENABLED: '1' });
  try {
    run(db, "INSERT INTO intents(id,label,created_at) VALUES(1,'Question','2026-09-23T00:00:00Z')");
    run(db, "INSERT INTO prompts(id,intent_id,text,created_at) VALUES(1,1,'Question','2026-09-23T00:00:00Z')");
    run(db, "INSERT INTO runs(id,started_at,finished_at,trigger,status) VALUES(1,'2026-09-24T06:00:00Z','2026-09-24T06:01:00Z','manual','done')");
    run(db, `INSERT INTO responses(run_id,prompt_id,provider,model,sample_idx,text,created_at,
      surface,lane,target_status,comparability_status,answer_status,web_status) VALUES(1,1,'codex','fixture',0,'Answer',
      '2026-09-24T06:00:00Z','codex-agent','tracking','completed','comparable','complete','verified')`);
    run(db, "INSERT INTO runs(id,started_at,finished_at,trigger,status) VALUES(2,'2026-09-25T06:00:00Z','2026-09-25T06:01:00Z','manual','failed')");
    run(db, `INSERT INTO responses(run_id,prompt_id,provider,model,sample_idx,created_at,
      surface,target_status,answer_status) VALUES(2,1,'codex','fixture',0,
      '2026-09-25T06:00:00Z','codex-agent','failed','failed')`);
    const health = trackingHealth({ db, config, now: new Date('2026-09-25T07:00:00Z') });
    assert.equal(health.subscription.lastSuccessfulObservationAt, '2026-09-24T06:00:00Z');
  } finally {
    db.close();
  }
});

test('status and pages show subscription-only schedule after it is enabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-tracking-health-'));
  const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'real.db'), HEARSAY_CODEX_ENABLED: '1' });
  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath: config.dbPath, config });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const before = await fetch(`${base}/api/status`).then((response) => response.json());
    assert.equal(before.schedule.schedulerEnabled, false);
    saveSubscriptionSchedule(app.db, { runAt: '23:59', timeZone: 'UTC', surfaces: ['codex-agent'],
      targetCeiling: 1, consentVersion: SCHEDULE_CONSENT_VERSION });
    const after = await fetch(`${base}/api/status`).then((response) => response.json());
    assert.equal(after.schedule.schedulerEnabled, true);
    assert.equal(after.trackingHealth.api.enabled, false);
    assert.equal(after.trackingHealth.subscription.enabled, true);
    assert.ok(after.trackingHealth.subscription.nextScheduledAt);
    await fetch(`${base}/api/entities`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme', is_self: true }) });
    await fetch(`${base}/api/prompts`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Which tool should I choose?', reviewed: true }) });
    const dashboard = await fetch(base).then((response) => response.text());
    const settings = await fetch(`${base}/settings`).then((response) => response.text());
    assert.match(dashboard, /Tracking health/);
    assert.match(settings, /Last successful observation/);
    assert.match(settings, /Subscription agents/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
