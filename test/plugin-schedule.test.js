import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { studyFixture } from '../test-support/study-fixture.js';
import { approveStudy, previewStudy, loadStudy, proposeStudyPlan } from '../core/study-workspace.js';
import { previewPluginSchedule, installPluginSchedule, inspectPluginSchedule, removePluginSchedule, pluginScheduleTick } from '../core/plugin-schedule.js';

const now = new Date('2026-10-02T08:00:00Z');
function cron(t) {
  const lock = mkdtempSync(join(tmpdir(), 'hearsay-cron-lock-'));
  t.after(() => rmSync(lock, { recursive: true, force: true }));
  let table = '15 3 * * * /usr/bin/other-job\n';
  let writes = 0;
  return { lock, run: (args, input) => {
    if (args[0] === '-l') return table;
    assert.deepEqual(args, ['-']); table = input; writes++; return '';
  }, table: () => table, writes: () => writes };
}
async function approved(t) {
  const f = await studyFixture(t);
  await approveStudy(f.directory, previewStudy(f.directory).quoteId, { author: 'owner', now });
  return f;
}

test('preview explains actual scope without connecting or installing a task', async (t) => {
  const f = await studyFixture(t);
  const p = previewPluginSchedule(f.directory);
  assert.equal(p.timezone, 'UTC'); assert.equal(p.at, '09:00');
  assert.equal(p.questions.length, 6); assert.equal(p.occurrences, 30);
  assert.equal(p.analysis, 'due_after_collection');
  assert.match(p.command, /schedule-tick/);
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, false);
  assert.equal(existsSync(join(f.directory, 'plugin-schedule.json')), false);
});

test('installation rejects missing and stale founder consent before cron changes', async (t) => {
  const f = await studyFixture(t); const c = cron(t);
  const p = previewPluginSchedule(f.directory);
  await assert.rejects(installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, cronLockDirectory: c.lock }), /approv/i);
  await approveStudy(f.directory, previewStudy(f.directory).quoteId, { author: 'owner', now });
  await assert.rejects(installPluginSchedule(f.directory, 'wrong', { author: 'owner', runCron: c.run, cronLockDirectory: c.lock }), /confirm/i);
  assert.equal(c.writes(), 0);
});

test('cron installation backs up, preserves other jobs and is idempotent', async (t) => {
  const f = await approved(t); const c = cron(t);
  const p = previewPluginSchedule(f.directory);
  const installed = await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now });
  assert.equal(readFileSync(installed.backup, 'utf8'), '15 3 * * * /usr/bin/other-job\n');
  assert.ok(c.table().startsWith('15 3 * * * /usr/bin/other-job\n'));
  assert.equal(c.table().split('\n').filter((line) => line.includes('# hearsay-study-')).length, 1);
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now });
  assert.equal(c.writes(), 1);
  assert.equal(inspectPluginSchedule(f.directory, { runCron: c.run }).status, 'connected');
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, true);
  await removePluginSchedule(f.directory, { runCron: c.run, cronLockDirectory: c.lock, now });
  assert.equal(c.table(), '15 3 * * * /usr/bin/other-job\n');
  assert.equal(inspectPluginSchedule(f.directory, { runCron: c.run }).status, 'disabled');
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, false);
});

test('changed plan stops a saved task before collection', async (t) => {
  const f = await approved(t); const c = cron(t);
  const p = previewPluginSchedule(f.directory);
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now });
  await proposeStudyPlan(f.directory, { ...f.plan, id: 'plan-2', collection: { ...f.plan.collection, at: '10:00' } });
  assert.equal(inspectPluginSchedule(f.directory, { runCron: c.run }).status, 'repair_required');
  let calls = 0;
  const result = await pluginScheduleTick(f.directory, { runCron: c.run, tick: async () => { calls++; } });
  assert.equal(result.status, 'repair_required'); assert.equal(calls, 0);
});

test('runtime removal or replacement requires reconnection before a tick', async (t) => {
  const f = await approved(t); const c = cron(t);
  const entry = join(f.projectDirectory, 'runtime.js');
  writeFileSync(entry, '// original runtime');
  const p = previewPluginSchedule(f.directory, { runtimePath: entry });
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now, runtimePath: entry });
  writeFileSync(entry, '// upgraded runtime');
  assert.equal(inspectPluginSchedule(f.directory, { runCron: c.run }).status, 'repair_required');
  assert.equal((await pluginScheduleTick(f.directory, { runCron: c.run })).status, 'repair_required');
});

test('a collector never claims an agent analysis and disabled ticks do no work', async (t) => {
  const f = await approved(t); const c = cron(t);
  let calls = 0;
  assert.equal((await pluginScheduleTick(f.directory, { runCron: c.run, tick: async () => { calls++; } })).status, 'disabled');
  const p = previewPluginSchedule(f.directory);
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now });
  const result = await pluginScheduleTick(f.directory, { runCron: c.run, tick: async () => { calls++; return { status: 'completed', analysisDue: true }; } });
  assert.equal(result.analysisDue, true); assert.equal(calls, 1);
});

test('host preview supplies agent instructions without pretending a task exists', async (t) => {
  const f = await approved(t);
  const p = previewPluginSchedule(f.directory, { kind: 'host' });
  assert.match(p.instruction, /Analyze/);
  assert.equal(p.analysis, 'host_task_required');
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, false);
});


test('imported runtime modules and the Node binary require fresh scheduler consent after replacement', async (t) => {
  const f = await approved(t); const c = cron(t);
  const root = join(f.projectDirectory, 'runtime');
  mkdirSync(join(root, 'bin'), { recursive: true }); mkdirSync(join(root, 'core'));
  const entry = join(root, 'bin', 'hearsay.js'); const module = join(root, 'core', 'study-schedule.js');
  const node = join(root, 'node');
  writeFileSync(entry, '// entry'); writeFileSync(module, '// original module'); writeFileSync(node, 'original node');
  const opts = { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, runtimePath: entry, nodePath: node, now };
  await installPluginSchedule(f.directory, previewPluginSchedule(f.directory, opts).quoteId, opts);
  writeFileSync(module, '// changed module');
  assert.equal(inspectPluginSchedule(f.directory, opts).status, 'repair_required');
  await installPluginSchedule(f.directory, previewPluginSchedule(f.directory, opts).quoteId, opts);
  writeFileSync(node, 'changed node');
  assert.equal(inspectPluginSchedule(f.directory, opts).status, 'repair_required');
});

test('simultaneous studies preserve both jobs in the shared crontab', async (t) => {
  const first = await approved(t); const second = await approved(t); const c = cron(t);
  const runCron = async (args, input) => {
    const result = c.run(args, input);
    await new Promise((done) => setImmediate(done));
    return result;
  };
  const opts = { author: 'owner', runCron, cronLockDirectory: c.lock, now };
  await Promise.all([first, second].map((f) => installPluginSchedule(f.directory, previewPluginSchedule(f.directory).quoteId, opts)));
  assert.equal(c.table().split('\n').filter((line) => line.includes('# hearsay-study-')).length, 2);
  assert.ok(c.table().startsWith('15 3 * * * /usr/bin/other-job\n'));
});

test('interrupted connection is blocked until an idempotent installation retry repairs it', async (t) => {
  const f = await approved(t); const c = cron(t);
  const p = previewPluginSchedule(f.directory);
  const opts = { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now };
  await assert.rejects(installPluginSchedule(f.directory, p.quoteId, {
    ...opts, connect: async () => { throw new Error('interrupted connection'); },
  }), /interrupted connection/);
  assert.equal(inspectPluginSchedule(f.directory, opts).status, 'repair_required');
  assert.equal((await pluginScheduleTick(f.directory, opts)).status, 'repair_required');
  await installPluginSchedule(f.directory, p.quoteId, opts);
  assert.equal(c.writes(), 1);
  assert.equal(inspectPluginSchedule(f.directory, opts).status, 'connected');
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, true);
});

test('a removed cron job is reported disconnected and ticks cannot collect', async (t) => {
  const f = await approved(t); const c = cron(t);
  const opts = { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now };
  await installPluginSchedule(f.directory, previewPluginSchedule(f.directory).quoteId, opts);
  c.run(['-'], '15 3 * * * /usr/bin/other-job\n');
  assert.equal(inspectPluginSchedule(f.directory, opts).status, 'repair_required');
  let calls = 0;
  assert.equal((await pluginScheduleTick(f.directory, { ...opts, tick: () => { calls++; } })).status, 'repair_required');
  assert.equal(calls, 0);
});


test('reinstalling after removal records a new connection even at the same clock time', async (t) => {
  const f = await approved(t); const c = cron(t);
  const opts = { author: 'owner', runCron: c.run, cronLockDirectory: c.lock, now };
  const quote = previewPluginSchedule(f.directory).quoteId;
  await installPluginSchedule(f.directory, quote, opts);
  await removePluginSchedule(f.directory, opts);
  await installPluginSchedule(f.directory, quote, opts);
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, true);
  assert.equal(inspectPluginSchedule(f.directory, opts).status, 'connected');
});
