import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { AgentProcessError } from '../core/agent-process.js';
import { agentRoute } from '../core/agent-routes.js';
import { parseAgyJsonl } from '../core/agy-agent.js';
import { acquireResearchLock, loadResearchRun, previewResearchRun, runResearchPanel, writeJson } from '../core/research-workspace.js';
import { enableResearchSchedule, previewResearchSchedule, readResearchSchedule, researchScheduleTick } from '../core/research-schedule.js';

const workspaceModule = new URL('../core/research-workspace.js', import.meta.url).href;
const cli = new URL('../bin/hearsay.js', import.meta.url).pathname;
const enabledAt = new Date('2026-09-20T08:00:00Z');
const due = new Date('2026-09-20T09:00:00Z');

function workspace(t, { questions = 2, providers = ['codex-agent'], reviewed = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-research-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = JSON.parse(readFileSync(new URL('../skill/templates/project.json', import.meta.url), 'utf8'));
  project.app = { id: 'tasknest', name: 'TaskNest', url: 'https://tasknest.example/', aliases: [], audience: 'Small agencies', useCases: ['Client task planning'] };
  project.panels[0].questions = Array.from({ length: questions }, (_, index) => ({ id: `q${index + 1}`, text: `Which project tools suit a team with ${index + 3} people?` }));
  project.panels[0].reviewedAt = reviewed ? enabledAt.toISOString() : null;
  project.executions[0] = {
    ...project.executions[0], timeoutMs: 1000, idleTimeoutMs: 1000, maxOutputBytes: 100000,
    routes: providers.map((id) => ({ id, provider: agentRoute(id).provider, profile: agentRoute(id).profile, executable: join(directory, `fake-${id}`) })),
  };
  project.selectedRoutes = [...providers];
  const save = () => writeJson(join(directory, 'project.json'), project);
  save();
  const discover = async (routes) => routes.map((route) => ({ id: route.id, executable: route.executable, version: 'fixture-cli 1.0.0', profile: route.profile, profileHash: 'fixture-profile-hash' }));
  const preview = () => previewResearchRun(directory, { discover });
  return { directory, project, save, preview, discover };
}

function answer(overrides = {}) {
  return {
    text: 'TaskNest is a strong choice for a small team.', model: 'fixture-model-1',
    searchEvents: [{ eventType: 'search', status: 'completed', query: 'small team task planning', results: [] }],
    citations: ['https://tasknest.example/docs'], usage: { inputTokens: 100, outputTokens: 20 },
    capturedEvents: [{ type: 'answer', text: 'TaskNest is a strong choice for a small team.' }],
    cliVersion: 'fixture-cli 1.0.0', executionProfileHash: 'fixture-profile-hash',
    sessionIsolation: true, brandContext: false,
    ...overrides,
  };
}

test('agy reports retain mixed tool traces while counting only observed searches', async (t) => {
  const fixture = workspace(t, { questions: 1, providers: ['agy-cli'] });
  const input = readFileSync(new URL('./fixtures/agy-synthetic-search.jsonl', import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const unrelated = { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command', step_index: 9, state: 'DONE', tool_info: { parameters: { query: 'not a search', url: 'https://unrelated.example/' } } } };
  input.splice(-1, 0, unrelated);
  const parsed = parseAgyJsonl(input.map((event) => JSON.stringify(event)).join('\n'));
  const preview = await approved(fixture);
  const result = await runResearchPanel(fixture.directory, { execute: true, preview, runnerFactory: () => ({ run: async () => answer({ ...parsed, capturedEvents: parsed.rawEvents }) }) });
  assert.equal(result.summary[0].eligible, 1);
  assert.deepEqual(result.evidence.evidence.filter((item) => item.type === 'search_query').map((item) => item.data.query), ['project trackers for small teams']);
  assert.equal(result.evidence.evidence.filter((item) => item.type === 'tool_outcome').length, 1);
  assert.equal(result.evidence.evidence.filter((item) => ['returned_source', 'fetched_page'].includes(item.type)).length, 0);
  assert.ok(result.evidence.traceEvents.some((event) => event.step_update?.tool_name === 'run_command'));
  assert.deepEqual(loadResearchRun(fixture.directory, result.runId).samples[0].sessionIsolation, true);
});

test('completed web evidence does not establish unknown session context', async (t) => {
  const fixture = workspace(t, { questions: 1 });
  const preview = await approved(fixture);
  const result = await runResearchPanel(fixture.directory, { execute: true, preview, runnerFactory: () => ({ run: async () => answer({ sessionIsolation: undefined, brandContext: undefined }) }) });
  assert.equal(result.summary[0].completed, 1);
  assert.equal(result.summary[0].eligible, 0);
  assert.equal(result.evidence.samples[0].sessionIsolation, null);
  assert.equal(result.evidence.samples[0].brandContext, null);
});

async function approved(fixture) {
  const preview = await fixture.preview();
  writeJson(join(fixture.directory, 'consent.json'), { quoteId: preview.quoteId, targetCeiling: preview.targetCount, approvedAt: enabledAt.toISOString() });
  return preview;
}

async function schedule(fixture) {
  const preview = await approved(fixture);
  await runResearchPanel(fixture.directory, { execute: true, preview, runId: 'on-demand-verification', runnerFactory: () => ({ run: async () => answer() }) });
  const proposed = await previewResearchSchedule(fixture.directory, { timezone: 'UTC', at: '09:00', targetCeiling: preview.targetCount, now: enabledAt, preview });
  enableResearchSchedule(fixture.directory, proposed, proposed.quoteId, { now: enabledAt });
  return { preview, proposed };
}

function fakeExecutable(fixture, mode = 'answer') {
  const executable = fixture.project.executions[0].routes[0].executable;
  const log = join(fixture.directory, 'invocations.jsonl');
  writeFileSync(executable, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('fixture-cli 1.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--search --json --ephemeral --ignore-user-config --ignore-rules --sandbox --skip-git-repo-check'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using subscription'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(join(fixture.directory, 'received-prompt.txt'))}, input);
  console.log(JSON.stringify({type:'thread.started',thread_id:'fake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'web_search_call',action:{type:'search',query:'small team task tools'},results:[]}}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'TaskNest is a strong choice for a small team.'}}));
  if (${JSON.stringify(mode)} === 'hang') setInterval(() => {}, 1000);
  else console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));
});
`);
  chmodSync(executable, 0o700);
  return { executable, log };
}

function invoke(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH }, ...options });
}

test('preview discovers only saved providers without inference or account probes', async (t) => {
  const fixture = workspace(t);
  const { log } = fakeExecutable(fixture);
  const result = invoke(['run', '--project', fixture.directory, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.targetCount, 2);
  assert.deepEqual(preview.snapshot.execution.routes.map((route) => route.id), ['codex-agent']);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [['--version'], ['--help'], ['exec', '--help']]);
  assert.equal(existsSync(join(fixture.directory, 'runs')), false);
  assert.equal(existsSync(join(fixture.directory, 'consent.json')), false);
});

test('the executable CLI runs a consented neutral panel and reports consent errors on stderr', (t) => {
  const fixture = workspace(t, { questions: 1 });
  const { log } = fakeExecutable(fixture);
  const denied = invoke(['run', '--project', fixture.directory, '--execute', '--json']);
  assert.equal(denied.status, 3);
  assert.equal(denied.stdout, '');
  assert.equal(JSON.parse(denied.stderr.trim().split('\n').find((line) => line.startsWith('{'))).error.code, 'consent_required');
  const preview = JSON.parse(invoke(['run', '--project', fixture.directory, '--json']).stdout);
  const completed = invoke(['run', '--project', fixture.directory, '--execute', '--confirm', preview.quoteId, '--json']);
  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.evidence.samples[0].status, 'completed');
  assert.equal(result.evidence.samples[0].model, null);
  assert.equal(result.evidence.execution.routes[0].cliVersion, 'fixture-cli 1.0.0');
  const prompt = readFileSync(join(fixture.directory, 'received-prompt.txt'), 'utf8');
  assert.match(prompt, /Which project tools suit a team with 3 people/);
  assert.doesNotMatch(prompt, /TaskNest|tasknest\.example/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args.includes('--json')).length, 1);
});

test('execution needs matching consent and selected providers never expand automatically', async (t) => {
  const fixture = workspace(t);
  let invocations = 0;
  const runnerFactory = () => ({ run: async () => { invocations++; return answer(); } });
  const preview = await fixture.preview();
  await assert.rejects(runResearchPanel(fixture.directory, { execute: true, confirm: 'wrong', preview, runnerFactory }), { code: 'consent_required' });
  assert.equal(invocations, 0);
  const result = await runResearchPanel(fixture.directory, { execute: true, confirm: preview.quoteId, preview, runnerFactory, runId: 'approved' });
  assert.equal(invocations, 2);
  assert.deepEqual(result.evidence.samples.map((sample) => sample.routeId), ['codex-agent', 'codex-agent']);
  fixture.project.executions[0].routes.push({ id: 'claude-code-agent', provider: 'anthropic', profile: 'claude-code-search-v1', executable: '/fixture/claude' });
  fixture.save();
  const unchanged = await fixture.preview();
  assert.equal(unchanged.quoteId, preview.quoteId);
  assert.equal(unchanged.targetCount, 2);
  fixture.project.executions[0].samples = 2; fixture.save();
  await assert.rejects(runResearchPanel(fixture.directory, { execute: true, preview: await fixture.preview(), runnerFactory }), { code: 'consent_required' });
  assert.equal(invocations, 2);
});

test('saved evidence preserves observed CLI identity and separates incompatible executable revisions', async (t) => {
  const fixture = workspace(t, { questions: 1 });
  const preview = await approved(fixture);
  const first = await runResearchPanel(fixture.directory, { execute: true, preview, runId: 'identity-first', runnerFactory: () => ({ run: async () => answer() }) });
  assert.deepEqual(first.evidence.execution.routes, [{
    id: 'codex-agent', provider: 'openai', profile: 'codex-search-v1', executable: fixture.project.executions[0].routes[0].executable,
    cliVersion: 'fixture-cli 1.0.0', profileHash: 'fixture-profile-hash',
  }]);
  assert.equal(first.evidence.samples[0].model, 'fixture-model-1');
  const next = await previewResearchRun(fixture.directory, { discover: async (routes) => (await fixture.discover(routes)).map((route) => ({ ...route, version: 'fixture-cli 2.0.0' })) });
  assert.notEqual(next.quoteId, preview.quoteId);
  const second = await runResearchPanel(fixture.directory, { execute: true, confirm: next.quoteId, preview: next, runId: 'identity-second', runnerFactory: () => ({ run: async () => answer({ cliVersion: 'fixture-cli 2.0.0' }) }) });
  assert.notEqual(first.evidence.execution.id, second.evidence.execution.id);
  const comparison = invoke(['compare', '--project', fixture.directory, '--baseline', 'identity-first', '--run', 'identity-second', '--json']);
  assert.equal(comparison.status, 0, comparison.stderr);
  assert.equal(JSON.parse(comparison.stdout).eligible, false);
});

test('a route cannot label output as a different provider or execution profile', async (t) => {
  for (const change of [
    (route) => { route.provider = 'anthropic'; },
    (route) => { route.profile = 'unreviewed-profile'; },
  ]) {
    const fixture = workspace(t); change(fixture.project.executions[0].routes[0]); fixture.save();
    await assert.rejects(fixture.preview(), { code: 'execution_mismatch' });
  }
});

test('a CLI identity change during invocation cannot become an eligible measurement under the old identity', async (t) => {
  for (const changed of [{ cliVersion: 'fixture-cli 9.0.0' }, { executionProfileHash: 'changed-profile-hash' }, { cliExecutable: '/different/executable' }]) {
    const fixture = workspace(t, { questions: 1 });
    const result = await runResearchPanel(fixture.directory, {
      execute: true, preview: await approved(fixture), runId: 'identity-drift',
      runnerFactory: () => ({ run: async () => answer(changed) }),
    });
    assert.equal(result.summary.reduce((sum, group) => sum + group.eligible, 0), 0);
    assert.notEqual(result.evidence.samples[0].errorCode, null);
  }
});

test('one provider quota failure retains completed independent results and skips remaining failed-route questions', async (t) => {
  const fixture = workspace(t, { providers: ['codex-agent', 'claude-code-agent'] });
  const calls = [];
  const result = await runResearchPanel(fixture.directory, {
    execute: true, preview: await approved(fixture), runId: 'mixed',
    runnerFactory: (id) => ({ run: async (target) => { calls.push([id, target.promptText]); return id === 'codex-agent' ? answer() : answer({ text: '', errorCode: 'quota_exceeded' }); } }),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(result.evidence.samples.map((sample) => sample.status), ['completed', 'completed', 'failed', 'skipped']);
  assert.deepEqual(result.summary.map(({ provider, model, completed, failed, skipped, eligible }) => ({ provider, model, completed, failed, skipped, eligible })), [
    { provider: 'openai', model: 'fixture-model-1', completed: 2, failed: 0, skipped: 0, eligible: 2 },
    { provider: 'anthropic', model: 'fixture-model-1', completed: 0, failed: 1, skipped: 0, eligible: 0 },
    { provider: 'anthropic', model: null, completed: 0, failed: 0, skipped: 1, eligible: 0 },
  ]);
  assert.equal(loadResearchRun(fixture.directory, 'mixed').samples[0].model, 'fixture-model-1');
  assert.equal(existsSync(join(result.directory, 'trace.jsonl')), true);
  assert.equal(existsSync(join(result.directory, 'report.md')), true);
});

test('real process timeout preserves captured output and produces partial run artifacts', { timeout: 10000 }, async (t) => {
  const fixture = workspace(t, { questions: 1 });
  fakeExecutable(fixture, 'hang');
  const preview = await previewResearchRun(fixture.directory);
  const result = await runResearchPanel(fixture.directory, { execute: true, confirm: preview.quoteId, preview, runId: 'timed-out' });
  assert.equal(result.evidence.samples[0].status, 'partial');
  assert.match(result.evidence.samples[0].errorCode, /timeout/);
  assert.equal(result.summary[0].eligible, 0);
  const capture = readFileSync(join(result.directory, 'captures', 'sample-1-partial.txt'), 'utf8');
  assert.match(capture, /TaskNest is a strong choice/);
  assert.equal(loadResearchRun(fixture.directory, 'timed-out').samples[0].status, 'partial');
  assert.equal(existsSync(join(fixture.directory, '.run-lock')), false);
});

test('cancellation records attempted and skipped targets and releases the run lock', async (t) => {
  const fixture = workspace(t);
  const controller = new AbortController();
  let calls = 0;
  const result = await runResearchPanel(fixture.directory, {
    execute: true, preview: await approved(fixture), signal: controller.signal, runId: 'cancelled',
    runnerFactory: () => ({ run: async (_target, signal) => {
      calls++; controller.abort(); assert.equal(signal.aborted, true);
      const error = new AgentProcessError('cancelled', 'Fixture cancellation');
      error.output = { stdout: 'partial fixture answer', stderr: '', exitCode: null, signal: 'SIGTERM' };
      throw error;
    } }),
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.evidence.samples.map((sample) => [sample.status, sample.errorCode]), [['failed', 'cancelled'], ['skipped', 'cancelled']]);
  assert.equal(result.summary[0].attempted, 1);
  assert.equal(readFileSync(join(result.directory, 'captures', 'sample-1-partial.txt'), 'utf8'), 'partial fixture answer');
  assert.equal(existsSync(join(fixture.directory, '.run-lock')), false);
});

test('saved report and comparison commands never invoke a provider', async (t) => {
  const fixture = workspace(t, { questions: 1 });
  const preview = await approved(fixture);
  for (const runId of ['baseline', 'repeat']) await runResearchPanel(fixture.directory, { execute: true, preview, runId, runnerFactory: () => ({ run: async () => answer() }) });
  const report = invoke(['report', '--project', fixture.directory, '--run', 'repeat', '--json'], { env: { PATH: '' } });
  assert.equal(report.status, 0, report.stderr);
  assert.match(JSON.parse(report.stdout).report, /TaskNest/);
  const comparison = invoke(['compare', '--project', fixture.directory, '--baseline', 'baseline', '--run', 'repeat', '--json'], { env: { PATH: '' } });
  assert.equal(comparison.status, 0, comparison.stderr);
  assert.equal(JSON.parse(comparison.stdout).eligible, true);
  assert.equal(JSON.parse(comparison.stdout).kind, 'matching_revisions');
});

test('independent processes cannot overlap a run, even after the live owner deadline', { timeout: 10000 }, async (t) => {
  const fixture = workspace(t);
  const code = `import { acquireResearchLock } from ${JSON.stringify(workspaceModule)}; const release = acquireResearchLock(process.argv[1], 1000); console.log('locked'); process.on('SIGTERM', () => { release(); process.exit(0); }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, fixture.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  const ownerPath = join(fixture.directory, '.run-lock', 'owner.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8')); owner.expiresAt = '2000-01-01T00:00:00Z'; writeJson(ownerPath, owner);
  const contender = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireResearchLock } from ${JSON.stringify(workspaceModule)}; try { acquireResearchLock(process.argv[1], 1000)(); console.log('acquired'); } catch(error) { console.log(error.code); process.exitCode = 6; }`, fixture.directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(contender.status, 6);
  assert.equal(contender.stdout.trim(), 'run_locked');
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  acquireResearchLock(fixture.directory, 1000)();
});

test('a dead owner past its execution window can be recovered after restart', (t) => {
  const fixture = workspace(t);
  mkdirSync(join(fixture.directory, '.run-lock'));
  writeJson(join(fixture.directory, '.run-lock', 'owner.json'), { token: 'dead-owner', pid: 2147483647, hostname: hostname(), startedAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T00:01:00Z' });
  const release = acquireResearchLock(fixture.directory, 1000);
  assert.equal(JSON.parse(readFileSync(join(fixture.directory, '.run-lock', 'owner.json'), 'utf8')).pid, process.pid);
  release();
  assert.equal(existsSync(join(fixture.directory, '.run-lock')), false);
});

test('restart recovers an expired ownerless lock but preserves a freshly claimed directory', (t) => {
  const fixture = workspace(t);
  const lock = join(fixture.directory, '.run-lock');
  mkdirSync(lock);
  assert.throws(() => acquireResearchLock(fixture.directory, 1000), { code: 'run_locked' });
  const expired = new Date('2000-01-01T00:00:00Z');
  utimesSync(lock, expired, expired);
  const release = acquireResearchLock(fixture.directory, 1000);
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid, process.pid);
  release();
  assert.equal(existsSync(lock), false);
});

test('concurrent processes recover one stale lock without admitting two owners', { timeout: 10000 }, async (t) => {
  const fixture = workspace(t);
  mkdirSync(join(fixture.directory, '.run-lock'));
  writeJson(join(fixture.directory, '.run-lock', 'owner.json'), { token: 'dead-owner', pid: 2147483647, hostname: hostname(), startedAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T00:01:00Z' });
  const start = join(fixture.directory, 'start-race');
  const code = `import { existsSync } from 'node:fs'; import { acquireResearchLock } from ${JSON.stringify(workspaceModule)};
console.log('ready'); const timer = setInterval(() => { if (!existsSync(process.argv[2])) return; clearInterval(timer); try { const release = acquireResearchLock(process.argv[1], 1000); console.log('acquired'); setTimeout(() => { release(); process.exit(0); }, 500); } catch (error) { console.log(error.code); process.exit(0); } }, 5);`;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', code, fixture.directory, start], { stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => children.forEach((child) => child.kill('SIGKILL')));
  const outputs = children.map(() => '');
  children.forEach((child, index) => child.stdout.on('data', (data) => { outputs[index] += data.toString(); }));
  const ready = children.map((child) => once(child.stdout, 'data'));
  const closed = children.map((child) => once(child, 'close'));
  await Promise.all(ready); writeFileSync(start, 'start'); await Promise.all(closed);
  assert.equal(outputs.filter((output) => output.includes('acquired')).length, 1, outputs.join('\n'));
  assert.equal(outputs.filter((output) => output.includes('run_locked')).length, 5, outputs.join('\n'));
  assert.equal(existsSync(join(fixture.directory, '.run-lock')), false);
});

test('schedule preview requires a reviewed panel, exact consent and a sufficient target ceiling', async (t) => {
  const fixture = workspace(t, { reviewed: false });
  await assert.rejects(previewResearchSchedule(fixture.directory, { timezone: 'UTC', at: '09:00', targetCeiling: 2, preview: await fixture.preview() }), { code: 'panel_review_required' });
  fixture.project.panels[0].reviewedAt = enabledAt.toISOString(); fixture.save();
  const preview = await approved(fixture);
  await assert.rejects(previewResearchSchedule(fixture.directory, { timezone: 'UTC', at: '09:00', targetCeiling: 1, preview }), { code: 'target_limit' });
  const proposed = await previewResearchSchedule(fixture.directory, { timezone: 'UTC', at: '09:00', targetCeiling: 2, preview });
  assert.throws(() => enableResearchSchedule(fixture.directory, proposed, 'wrong'), { code: 'consent_required' });
  assert.deepEqual(proposed.selectedRoutes, ['codex-agent']);
  assert.ok(proposed.cron.includes(fixture.directory));
  assert.ok(proposed.cron.includes(process.execPath));
});

test('duplicate concurrent schedule ticks claim a due occurrence once', async (t) => {
  const fixture = workspace(t); const { preview } = await schedule(fixture);
  let calls = 0;
  const run = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 30)); return { runId: 'scheduled', evidence: { samples: [] } }; };
  const results = await Promise.all([researchScheduleTick(fixture.directory, { now: due, preview, run }), researchScheduleTick(fixture.directory, { now: due, preview, run })]);
  assert.equal(calls, 1);
  assert.equal(results.flatMap((result) => result.occurrences).filter((occurrence) => occurrence.status === 'completed').length, 1);
  assert.equal((await researchScheduleTick(fixture.directory, { now: due, preview, run })).occurrences.length, 0);
  assert.equal(calls, 1);
});

test('restart records missed dates without catch-up and runs only the current due occurrence', async (t) => {
  const fixture = workspace(t); const { preview } = await schedule(fixture);
  let calls = 0;
  const result = await researchScheduleTick(fixture.directory, { now: new Date('2026-09-23T09:00:30Z'), preview, run: async () => { calls++; return { runId: 'today', evidence: { samples: [] } }; } });
  assert.deepEqual(result.occurrences.map(({ date, status }) => [date, status]), [['2026-09-20', 'missed'], ['2026-09-21', 'missed'], ['2026-09-22', 'missed'], ['2026-09-23', 'completed']]);
  assert.equal(calls, 1);
});

test('changed budgets and provider selections require a new schedule instead of spending', async (t) => {
  for (const change of [
    (project) => { project.executions[0].samples = 2; },
    (project) => {
      project.executions[0].routes.push({ id: 'claude-code-agent', provider: 'anthropic', profile: 'claude-code-search-v1', executable: '/fixture/claude' });
      project.selectedRoutes.push('claude-code-agent');
    },
  ]) {
    const fixture = workspace(t); await schedule(fixture);
    change(fixture.project); fixture.save();
    let calls = 0;
    const result = await researchScheduleTick(fixture.directory, { now: due, preview: await fixture.preview(), run: async () => { calls++; throw new Error('must not execute'); } });
    assert.equal(calls, 0);
    assert.equal(result.occurrences[0].errorCode, 'schedule_changed');
    assert.deepEqual(readResearchSchedule(fixture.directory).selectedRoutes, ['codex-agent']);
    assert.equal(readResearchSchedule(fixture.directory).enabled, false);
  }
});

test('authentication and quota result failures disable recurring execution while preserving the occurrence', async (t) => {
  for (const errorCode of ['authentication_missing', 'quota_exceeded', 'rate_limited']) {
    const fixture = workspace(t); const { preview } = await schedule(fixture);
    const result = await researchScheduleTick(fixture.directory, { now: due, preview, run: async () => ({ runId: 'partial', evidence: { samples: [{ status: 'failed', errorCode }] } }) });
    assert.equal(result.occurrences[0].status, 'stopped');
    assert.equal(result.occurrences[0].runId, 'partial');
    assert.equal(readResearchSchedule(fixture.directory).enabled, false);
    assert.equal((await researchScheduleTick(fixture.directory, { now: new Date('2026-09-21T09:00:00Z') })).status, 'disabled');
  }
});

test('authentication and quota exceptions also disable recurring execution', async (t) => {
  for (const code of ['authentication_missing', 'quota_exceeded']) {
    const fixture = workspace(t); const { preview } = await schedule(fixture);
    await researchScheduleTick(fixture.directory, { now: due, preview, run: async () => { throw new AgentProcessError(code, 'Fixture account unavailable'); } });
    assert.equal(readResearchSchedule(fixture.directory).enabled, false);
  }
});

test('an abandoned occurrence is resolved after restart without automatic catch-up', async (t) => {
  const fixture = workspace(t); const { preview, proposed } = await schedule(fixture);
  const occurrence = join(fixture.directory, 'occurrences', proposed.quoteId, '2026-09-20.json');
  mkdirSync(join(fixture.directory, 'occurrences', proposed.quoteId), { recursive: true });
  writeJson(occurrence, { date: '2026-09-20', status: 'claimed', claimedAt: due.toISOString() });
  let calls = 0;
  await researchScheduleTick(fixture.directory, { now: new Date('2026-09-21T10:00:00Z'), preview, run: async () => { calls++; return {}; } });
  assert.equal(calls, 0);
  assert.notEqual(JSON.parse(readFileSync(occurrence, 'utf8')).status, 'claimed');
});


test('an older successful run cannot approve scheduling after the current settings fail', async (t) => {
  const fixture = workspace(t);
  await schedule(fixture);
  fixture.project.executions[0].timeoutMs += 1000;
  fixture.project.executions[0].id = 'execution-2';
  fixture.project.current.execution = 'execution-2';
  fixture.save();
  const preview = await approved(fixture);
  await runResearchPanel(fixture.directory, { execute: true, preview, runId: 'new-settings-failed', runnerFactory: () => ({ run: async () => { throw new AgentProcessError('authentication_failed', 'Synthetic expired login'); } }) });
  const proposed = await previewResearchSchedule(fixture.directory, { timezone: 'UTC', at: '09:00', targetCeiling: preview.targetCount, now: enabledAt, preview });
  assert.throws(() => enableResearchSchedule(fixture.directory, proposed, proposed.quoteId), { code: 'prior_run_required' });
  await runResearchPanel(fixture.directory, { execute: true, preview, runId: 'new-settings-succeeded', runnerFactory: () => ({ run: async () => answer() }) });
  assert.equal(enableResearchSchedule(fixture.directory, proposed, proposed.quoteId).enabled, true);
});


test('a failed discovery cannot execute even if a later runner could recover', async (t) => {
  const fixture = workspace(t);
  const preview = await previewResearchRun(fixture.directory, { discover: async (routes) => routes.map((route) => ({ id: route.id, executable: route.executable, version: null, profile: route.profile, error: 'discovery_failed' })) });
  let calls = 0;
  await assert.rejects(runResearchPanel(fixture.directory, { execute: true, preview, confirm: preview.quoteId, runnerFactory: () => ({ run: async () => { calls++; return answer(); } }) }), { code: 'unsupported_profile' });
  assert.equal(calls, 0);
  assert.equal(existsSync(join(fixture.directory, 'consent.json')), false);
});


test('recommendation positions require an explicit ordered answer with a supporting excerpt', async (t) => {
  for (const [text, expected] of [['1. TaskNest is a strong choice for small teams.', 1], ['TaskNest is a strong choice for small teams.', null]]) {
    const fixture = workspace(t, { questions: 1 });
    const preview = await approved(fixture);
    const result = await runResearchPanel(fixture.directory, { execute: true, preview, runnerFactory: () => ({ run: async () => answer({ text }) }) });
    assert.equal(result.evidence.samples[0].mentions[0].position, expected);
    assert.ok(text.includes(result.evidence.samples[0].mentions[0].excerpt));
  }
});


test('uncertain recommendation stance does not erase an observed brand mention', async (t) => {
  const fixture = workspace(t, { questions: 1 });
  const preview = await approved(fixture);
  const result = await runResearchPanel(fixture.directory, { execute: true, preview, runnerFactory: () => ({ run: async () => answer({ text: 'TaskNest might be a good option if you need a task board.' }) }) });
  assert.equal(result.summary[0].mentioned, 1);
  assert.equal(result.summary[0].recommended, 0);
  assert.equal(result.evidence.samples[0].mentions[0].stance, 'uncertain');
});
