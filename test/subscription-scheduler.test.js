import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, all, get, run } from '../core/db.js';
import {
  DEFAULT_SUBSCRIPTION_GRACE_MINUTES,
  SCHEDULE_CONSENT_VERSION,
  getSubscriptionSchedule,
  localDateInZone,
  saveSubscriptionSchedule,
  scheduledInstantForLocalDate,
  subscriptionScheduleTick,
} from '../core/subscription-scheduler.js';

function config() {
  return {
    demo: false,
    subscriptionSurfaces: ['codex-agent'],
    subscriptionSamples: 1,
  };
}

test('subscription schedules persist explicit consent and a deterministic revision', () => {
  const db = openDb(':memory:');
  try {
    const schedule = saveSubscriptionSchedule(db, {
      runAt: '07:00',
      timeZone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      promptIds: [4, 2],
      samples: 1,
      targetCeiling: 2,
      graceMinutes: 10,
      consentVersion: SCHEDULE_CONSENT_VERSION,
      now: new Date('2026-08-10T06:00:00Z'),
    });
    assert.equal(schedule.scheduleKey, 'subscription-agent');
    assert.equal(schedule.timeZone, 'Europe/Berlin');
    assert.equal(schedule.graceMinutes, DEFAULT_SUBSCRIPTION_GRACE_MINUTES);
    assert.match(schedule.revisionHash, /^[a-f0-9]{64}$/);
    assert.equal(schedule.consentVersion, SCHEDULE_CONSENT_VERSION);
    assert.equal(getSubscriptionSchedule(db)?.revisionHash, schedule.revisionHash);
  } finally {
    db.close();
  }
});

test('scheduled local times resolve in the requested IANA zone across a repeated DST hour', () => {
  const first = scheduledInstantForLocalDate('2026-10-25', '02:30', 'Europe/Berlin');
  assert.equal(localDateInZone(first, 'Europe/Berlin'), '2026-10-25');
  assert.equal(first.toISOString(), '2026-10-25T00:30:00.000Z');
  const second = new Date(first.getTime() + 60 * 60 * 1000);
  assert.equal(localDateInZone(second, 'Europe/Berlin'), '2026-10-25');
  assert.equal(localDateInZone(new Date('2026-10-26T00:30:00Z'), 'Europe/Berlin'), '2026-10-26');
});

test('a late scheduler records one missed local-date occurrence and does not replay it', async () => {
  const db = openDb(':memory:');
  try {
    run(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'best tracker', '2026-08-09T00:00:00Z']);
    run(db, `INSERT INTO prompts(id, intent_id, text, category, active, created_at, tracking_state, origin)
      VALUES(?,?,?,?,?,?,?,?)`, [1, 1, 'Which tracker is best?', 'general', 1, '2026-08-09T00:00:00Z', 'tracking', 'user_authored']);
    saveSubscriptionSchedule(db, {
      runAt: '07:00',
      timeZone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      promptIds: [1],
      samples: 1,
      targetCeiling: 1,
      graceMinutes: 10,
      consentVersion: SCHEDULE_CONSENT_VERSION,
      now: new Date('2026-08-09T06:00:00Z'),
    });
    const tickOptions = {
      db,
      config: config(),
      now: new Date('2026-08-10T06:15:00Z'),
      preview: () => ({ totalTargets: 1 }),
      runSubscription: async () => {},
    };
    assert.equal(await subscriptionScheduleTick(tickOptions), true);
    assert.equal(Number(get(db, "SELECT COUNT(*) AS n FROM runs WHERE status = 'missed'")?.n), 1);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM runs WHERE occurrence_local_date = ?', ['2026-08-10'])?.n), 1);
    assert.equal(await subscriptionScheduleTick(tickOptions), false);
    assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM runs WHERE schedule_key = ?', ['subscription-agent'])?.n), 1);
  } finally {
    db.close();
  }
});

test('a due occurrence is claimed before the runner and remains single across repeated ticks', async () => {
  const db = openDb(':memory:');
  try {
    run(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'best tracker', '2026-08-09T00:00:00Z']);
    run(db, `INSERT INTO prompts(id, intent_id, text, category, active, created_at, tracking_state, origin)
      VALUES(?,?,?,?,?,?,?,?)`, [1, 1, 'Which tracker is best?', 'general', 1, '2026-08-09T00:00:00Z', 'tracking', 'user_authored']);
    saveSubscriptionSchedule(db, {
      runAt: '07:00',
      timeZone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      promptIds: [1],
      samples: 1,
      targetCeiling: 1,
      graceMinutes: 10,
      consentVersion: SCHEDULE_CONSENT_VERSION,
      now: new Date('2026-08-09T06:00:00Z'),
    });
    let calls = 0;
    const runSubscription = async ({ db: targetDb, existingRunId }) => {
      calls += 1;
      assert.ok(existingRunId > 0);
      assert.equal(Number(get(targetDb, 'SELECT COUNT(*) AS n FROM runs WHERE id = ?', [existingRunId])?.n), 1);
      run(targetDb, "UPDATE runs SET status = 'done', finished_at = started_at WHERE id = ?", [existingRunId]);
    };
    const options = {
      db,
      config: config(),
      now: new Date('2026-08-10T05:05:00Z'),
      preview: () => ({ totalTargets: 1 }),
      runSubscription,
    };
    assert.equal(await subscriptionScheduleTick(options), true);
    assert.equal(calls, 1);
    assert.equal(await subscriptionScheduleTick(options), false);
    assert.equal(calls, 1);
    assert.deepEqual(all(db, 'SELECT status, occurrence_local_date FROM runs ORDER BY id').map((row) => ({ ...row })), [
      { status: 'done', occurrence_local_date: '2026-08-10' },
    ]);
  } finally {
    db.close();
  }
});

test('scheduler leaves a due occurrence unclaimed while another live run exists', async () => {
  const db = openDb(':memory:');
  try {
    run(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'best tracker', '2026-08-09T00:00:00Z']);
    run(db, `INSERT INTO prompts(id, intent_id, text, category, active, created_at, tracking_state, origin)
      VALUES(?,?,?,?,?,?,?,?)`, [1, 1, 'Which tracker is best?', 'general', 1, '2026-08-09T00:00:00Z', 'tracking', 'user_authored']);
    saveSubscriptionSchedule(db, {
      runAt: '07:00',
      timeZone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      promptIds: [1],
      samples: 1,
      targetCeiling: 1,
      graceMinutes: 10,
      consentVersion: SCHEDULE_CONSENT_VERSION,
      now: new Date('2026-08-09T06:00:00Z'),
    });
    run(db, `INSERT INTO runs(started_at, trigger, status, total_calls, done_calls)
      VALUES(?, 'api', 'running', 1, 0)`, ['2026-08-10T05:00:00Z']);

    let calls = 0;
    const changed = await subscriptionScheduleTick({
      db,
      config: config(),
      now: new Date('2026-08-10T05:05:00Z'),
      preview: () => ({ totalTargets: 1 }),
      runSubscription: async () => {
        calls += 1;
      },
    });

    assert.equal(changed, false);
    assert.equal(calls, 0);
    assert.equal(Number(get(db, "SELECT COUNT(*) AS n FROM runs WHERE trigger = 'cron'")?.n), 0);
  } finally {
    db.close();
  }
});

test('a stale claimed subscription occurrence is recovered with abandoned targets', async () => {
  const db = openDb(':memory:');
  try {
    run(db, 'INSERT INTO intents(id, label, created_at) VALUES(?,?,?)', [1, 'best tracker', '2026-08-09T00:00:00Z']);
    run(db, `INSERT INTO prompts(id, intent_id, text, category, active, created_at, tracking_state, origin)
      VALUES(?,?,?,?,?,?,?,?)`, [1, 1, 'Which tracker is best?', 'general', 1, '2026-08-09T00:00:00Z', 'tracking', 'user_authored']);
    const schedule = saveSubscriptionSchedule(db, {
      runAt: '07:00',
      timeZone: 'Europe/Berlin',
      surfaces: ['codex-agent'],
      lane: 'tracking',
      promptIds: [1],
      samples: 1,
      targetCeiling: 1,
      graceMinutes: 10,
      consentVersion: SCHEDULE_CONSENT_VERSION,
      now: new Date('2026-08-09T06:00:00Z'),
    });
    const runId = Number(run(db, `INSERT INTO runs(
      started_at, trigger, status, total_calls, done_calls, schedule_key,
      schedule_revision_hash, scheduled_for, occurrence_local_date
    ) VALUES(?, 'cron', 'running', 1, 0, ?, ?, ?, ?)`, [
      '2026-08-10T00:00:00Z', schedule.scheduleKey, schedule.revisionHash,
      '2026-08-10T05:00:00Z', '2026-08-10',
    ]).lastInsertRowid);
    run(db, `INSERT INTO responses(
      run_id, prompt_id, provider, surface, model, sample_idx, created_at,
      lane, target_status, comparability_status, web_status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      runId, 1, 'openai', 'codex-agent', 'default', 0, '2026-08-10T00:00:00Z',
      'tracking', 'running', 'non_comparable', 'unavailable',
    ]);
    let attempts = 0;
    assert.equal(await subscriptionScheduleTick({
      db,
      config: config(),
      now: new Date('2026-08-10T08:00:00Z'),
      runSubscription: async () => { attempts += 1; },
    }), false);
    assert.equal(attempts, 0);
    assert.deepEqual({ ...get(db, 'SELECT status, error FROM runs WHERE id = ?', [runId]) }, {
      status: 'failed',
      error: 'abandoned: process exited before the run finished',
    });
    assert.deepEqual({ ...get(db, 'SELECT target_status, safe_error_code, error FROM responses WHERE run_id = ?', [runId]) }, {
      target_status: 'failed',
      safe_error_code: 'abandoned',
      error: 'subscription:abandoned',
    });
  } finally {
    db.close();
  }
});
