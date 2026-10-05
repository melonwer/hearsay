import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { studyFixture } from '../test-support/study-fixture.js';
import { approveStudy, previewStudy, loadStudy, proposeStudyPlan } from '../core/study-workspace.js';
import { previewPluginSchedule, installPluginSchedule, inspectPluginSchedule, removePluginSchedule, pluginScheduleTick } from '../core/plugin-schedule.js';

const now = new Date('2026-10-02T08:00:00Z');
function cron() {
  let table = '15 3 * * * /usr/bin/other-job\n';
  let writes = 0;
  return { run: (args, input) => {
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
  const f = await studyFixture(t); const c = cron();
  const p = previewPluginSchedule(f.directory);
  await assert.rejects(installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run }), /approv/i);
  await approveStudy(f.directory, previewStudy(f.directory).quoteId, { author: 'owner', now });
  await assert.rejects(installPluginSchedule(f.directory, 'wrong', { author: 'owner', runCron: c.run }), /confirm/i);
  assert.equal(c.writes(), 0);
});

test('cron installation backs up, preserves other jobs and is idempotent', async (t) => {
  const f = await approved(t); const c = cron();
  const p = previewPluginSchedule(f.directory);
  const installed = await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, now });
  assert.equal(readFileSync(installed.backup, 'utf8'), '15 3 * * * /usr/bin/other-job\n');
  assert.ok(c.table().startsWith('15 3 * * * /usr/bin/other-job\n'));
  assert.equal(c.table().split('\n').filter((line) => line.includes('# hearsay-study-')).length, 1);
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, now });
  assert.equal(c.writes(), 1);
  assert.equal(inspectPluginSchedule(f.directory).status, 'connected');
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, true);
  await removePluginSchedule(f.directory, { runCron: c.run, now });
  assert.equal(c.table(), '15 3 * * * /usr/bin/other-job\n');
  assert.equal(inspectPluginSchedule(f.directory).status, 'disabled');
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, false);
});

test('changed plan stops a saved task before collection', async (t) => {
  const f = await approved(t); const c = cron();
  const p = previewPluginSchedule(f.directory);
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, now });
  await proposeStudyPlan(f.directory, { ...f.plan, id: 'plan-2', collection: { ...f.plan.collection, at: '10:00' } });
  assert.equal(inspectPluginSchedule(f.directory).status, 'repair_required');
  let calls = 0;
  const result = await pluginScheduleTick(f.directory, { tick: async () => { calls++; } });
  assert.equal(result.status, 'repair_required'); assert.equal(calls, 0);
});

test('runtime removal or replacement requires reconnection before a tick', async (t) => {
  const f = await approved(t); const c = cron();
  const entry = join(f.projectDirectory, 'runtime.js');
  writeFileSync(entry, '// original runtime');
  const p = previewPluginSchedule(f.directory, { runtimePath: entry });
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, now, runtimePath: entry });
  writeFileSync(entry, '// upgraded runtime');
  assert.equal(inspectPluginSchedule(f.directory).status, 'repair_required');
  assert.equal((await pluginScheduleTick(f.directory)).status, 'repair_required');
});

test('a collector never claims an agent analysis and disabled ticks do no work', async (t) => {
  const f = await approved(t); const c = cron();
  let calls = 0;
  assert.equal((await pluginScheduleTick(f.directory, { tick: async () => { calls++; } })).status, 'disabled');
  const p = previewPluginSchedule(f.directory);
  await installPluginSchedule(f.directory, p.quoteId, { author: 'owner', runCron: c.run, now });
  const result = await pluginScheduleTick(f.directory, { tick: async () => { calls++; return { status: 'completed', analysisDue: true }; } });
  assert.equal(result.analysisDue, true); assert.equal(calls, 1);
});

test('host preview supplies agent instructions without pretending a task exists', async (t) => {
  const f = await approved(t);
  const p = previewPluginSchedule(f.directory, { kind: 'host' });
  assert.match(p.instruction, /Analyze/);
  assert.equal(p.analysis, 'host_task_required');
  assert.equal(loadStudy(f.directory).manifest.schedule.connected, false);
});
