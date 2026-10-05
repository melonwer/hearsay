import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectSetup, saveSetup, readSetup } from '../core/plugin-setup.js';
import { loadProject } from '../core/research-workspace.js';
import { discoverCli, probeAuthentication, safeEnvironment } from '../core/agent-process.js';
import { studyPlan, studyProject } from '../test-support/study-fixture.js';
import { createStudy, loadStudy } from '../core/study-workspace.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hearsay-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory: join(root, '.hearsay', 'tasknest') };
}
function input() {
  return { schemaVersion: 1, identity: { status: 'confirmed' },
    profile: { appId: 'tasknest', name: 'TaskNest', canonicalUrl: 'https://tasknest.example/', audience: 'Small teams', jobs: ['Manage client tasks'] },
    sources: [{ id: 'site', kind: 'url', url: 'https://tasknest.example/', observedAt: '2026-10-05T09:00:00Z' }],
    provenance: [{ field: 'name', sourceIds: ['site'] }, { field: 'canonicalUrl', sourceIds: ['site'] }, { field: 'audience', sourceIds: ['site'] }] };
}
const emptyDiscovery = async () => [];

test('setup persists versioned profile and provenance, keeps unknowns null, bootstraps a valid project', (t) => {
  const { directory } = fixture(t);
  assert.equal(readSetup(directory), null);
  const saved = saveSetup(directory, input());
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.profile.geography, null);
  assert.equal(saved.profile.outcome, null);
  assert.deepEqual(readSetup(directory), saved);
  assert.deepEqual(saved.provenance, input().provenance);
  const project = loadProject(directory);
  assert.equal(project.app.id, 'tasknest');
  assert.equal(project.app.audience, 'Small teams');
  assert.deepEqual(project.selectedRoutes, []);
  assert.deepEqual(project.panels[0].questions, []);
});

test('unknown audience/jobs remain unknown rather than template buyer claims', (t) => {
  const { directory } = fixture(t); const data = input();
  delete data.profile.audience; delete data.profile.jobs;
  const saved = saveSetup(directory, data);
  assert.equal(saved.profile.audience, null); assert.equal(saved.profile.jobs, null);
  assert.equal(loadProject(directory).app.audience, 'Unknown');
  assert.deepEqual(loadProject(directory).app.useCases, []);
});

test('ambiguous, missing or contradictory app identity cannot write any setup state', (t) => {
  const { directory } = fixture(t);
  for (const identity of [{ status: 'ambiguous' }, {}, { status: 'confirmed', candidates: ['tasknest', 'other-app'] }]) {
    assert.throws(() => saveSetup(directory, { ...input(), identity }), { code: 'identity_ambiguous' });
    assert.equal(existsSync(directory), false);
  }
});

test('existing project and raw history remain byte-for-byte intact; conflicts fail before writing', (t) => {
  const { directory } = fixture(t); saveSetup(directory, input());
  const file = join(directory, 'project.json'); const project = loadProject(directory);
  project.panels[0].questions = [{ id: 'q1', text: 'Which tools manage tasks?' }];
  writeFileSync(file, JSON.stringify(project)); mkdirSync(join(directory, 'runs'));
  writeFileSync(join(directory, 'runs', 'raw.jsonl'), 'raw fixture\n');
  const before = readFileSync(file, 'utf8'); const setupBefore = readFileSync(join(directory, 'setup.json'), 'utf8');
  const conflict = input(); conflict.profile.canonicalUrl = 'https://other.example/';
  assert.throws(() => saveSetup(directory, conflict), { code: 'identity_conflict' });
  assert.equal(readFileSync(join(directory, 'setup.json'), 'utf8'), setupBefore);
  saveSetup(directory, input());
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(readFileSync(join(directory, 'runs', 'raw.jsonl'), 'utf8'), 'raw fixture\n');
});

test('explicit valid project saves discovery evidence and buyer panel; invalid project is rejected', (t) => {
  const { directory } = fixture(t); const data = input();
  const project = JSON.parse(readFileSync(new URL('../skill/templates/project.json', import.meta.url), 'utf8'));
  project.app = { id: 'tasknest', name: 'TaskNest', url: 'https://tasknest.example/', aliases: [], audience: 'Small teams', useCases: ['Manage client tasks'] };
  project.discoveryEvidence = [{ id: 'site', type: 'fetched_page', timestamp: '2026-10-05T09:00:00Z', origin: 'host_research', capture: 'host_reported', sampleId: null, data: { url: 'https://tasknest.example/', title: 'TaskNest' } }];
  project.panels[0].questions = [{ id: 'q1', text: 'Which tools manage tasks?' }];
  assert.throws(() => saveSetup(directory, { ...data, project: { app: project.app } }));
  assert.equal(existsSync(directory), false);
  saveSetup(directory, { ...data, project });
  assert.deepEqual(loadProject(directory), project);
  project.panels[0].questions = [];
  assert.throws(() => saveSetup(directory, { ...data, project }), { code: 'project_conflict' });
});

test('a setup-saved discovery project can create the existing study preview without manual project edits', async (t) => {
  const { root } = fixture(t); const directory = join(root, '.hearsay', 'drip-score');
  const project = studyProject(); const plan = studyPlan();
  saveSetup(directory, { schemaVersion: 1, identity: { status: 'confirmed' },
    profile: { appId: project.app.id, name: project.app.name, canonicalUrl: project.app.url, audience: project.app.audience, jobs: project.app.useCases },
    sources: [{ id: 'product-evidence', kind: 'url', url: project.app.url }], provenance: [{ field: 'name', sourceIds: ['product-evidence'] }, { field: 'canonicalUrl', sourceIds: ['product-evidence'] }], project });
  const created = await createStudy(directory, plan);
  const saved = loadStudy(created.studyDirectory);
  assert.equal(saved.plan.app.id, 'drip-score');
  assert.equal(saved.plan.questions.length, 6);
  assert.deepEqual(saved.discoveryEvidence, project.discoveryEvidence);
  assert.equal(saved.manifest.approvalId, null);
});

test('missing stable app ID is rejected before persistence', (t) => {
  const { directory } = fixture(t); const data = input(); delete data.profile.appId;
  assert.throws(() => saveSetup(directory, data), { code: 'invalid_setup' });
  assert.equal(existsSync(directory), false);
});

test('unresolved source references and invalid source/provenance shapes are rejected', (t) => {
  const { directory } = fixture(t);
  for (const change of [{ provenance: [{ field: 'name', sourceIds: ['absent'] }] }, { sources: [{ id: 'site', kind: 'guess' }] }, { provenance: [{ field: 'madeUp', sourceIds: ['site'] }] }, { sources: [], provenance: [] }]) {
    assert.throws(() => saveSetup(directory, { ...input(), ...change }), { code: 'invalid_setup' });
    assert.equal(existsSync(directory), false);
  }
});

test('nested secret fields and credential content are rejected without echo or writes', (t) => {
  const { directory } = fixture(t);
  for (const secret of [{ nested: { apiKey: 'private-value' } }, { access_token: 'private-value' }, { tavily_key: 'private-value' }, { token: 'private-value' },
    { note: 'tvly-dev-' + 'a'.repeat(30) }, { note: 'Bearer ' + 'a'.repeat(25) }, { note: 'sk-' + 'a'.repeat(30) },
    { note: 'https://user:private-value@example.test/' }, { note: 'https://example.test/?api_key=private-value' }]) {
    assert.throws(() => saveSetup(directory, { ...input(), extra: secret }), (error) => error.code === 'secret_rejected' && !error.message.includes('private-value'));
    assert.equal(existsSync(directory), false);
  }
});

test('inspection is read-only and marks host capabilities and missing credentials honestly', async (t) => {
  const { root, directory } = fixture(t);
  const result = await inspectSetup({ cwd: root, project: directory, env: { PATH: '' }, discoverAgents: emptyDiscovery,
    host: 'codex', hostCapabilities: { filesystem: true, web: true, tasks: false } });
  assert.equal(result.host.capabilities.source, 'host_reported');
  assert.equal(result.host.capabilities.web, true);
  assert.equal(result.tavily.keyPresent, false); assert.equal(result.tavily.authentication, 'unverified');
  assert.equal(result.tavily.usage, null);
  assert.ok(result.missingSteps.some((step) => step.code === 'tavily_key_missing'));
  assert.deepEqual(readdirSync(root), []);
  const unknown = await inspectSetup({ cwd: root, env: { PATH: '' }, discoverAgents: emptyDiscovery });
  assert.equal(unknown.host.capabilities.web, null);
  assert.equal(unknown.scheduler.nativeTasks, null);
});

test('inspection lists existing records and returns route statuses without leaking environmental secrets', async (t) => {
  const { root, directory } = fixture(t); saveSetup(directory, input());
  const secret = 'private-environment-value';
  const result = await inspectSetup({ cwd: root, env: { PATH: '', TAVILY_API_KEY: secret }, discoverAgents: async () => [
    { id: 'codex-agent', installed: true, executable: '/fixture/codex', version: secret, profileReady: true, configuredLogin: 'unavailable', authentication: 'unverified' },
    { id: 'claude-code-agent', installed: true, executable: '/fixture/claude', version: 'fixture', profileReady: true, configuredLogin: 'available', authentication: 'unverified' },
  ] });
  assert.equal(result.workspace.records[0].appId, 'tasknest');
  assert.equal(result.tavily.keyPresent, true); assert.equal(result.tavily.authentication, 'unverified');
  assert.equal(result.routes[0].status, 'login_required');
  assert.equal(result.routes[1].status, 'available');
  assert.ok(result.missingSteps.some((step) => step.action === 'codex login'));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('inspection scrubs credential URL and bearer output without corrupting JSON', async (t) => {
  const { root } = fixture(t);
  const result = await inspectSetup({ cwd: root, env: { PATH: '' }, discoverGemini: async () => ({ executable: '/fixture/gemini', version: 'https://x/?key=private-query' }), discoverAgents: async () => [{
    id: 'codex-agent', installed: true, executable: '/fixture/codex', version: 'https://user:private-value@example.test/',
    reason: 'Bearer ' + 'a'.repeat(25), profileReady: false,
  }] });
  assert.ok(!JSON.stringify(result).includes('private-value'));
  assert.ok(!JSON.stringify(result).includes('a'.repeat(25)));
  assert.ok(!JSON.stringify(result).includes('private-query'));
});

test('doctor marks an unsupported runtime and rejects non-boolean or secret host claims', async (t) => {
  const { root } = fixture(t);
  const result = await inspectSetup({ cwd: root, env: { PATH: '' }, nodeVersion: '22.12.0', discoverAgents: emptyDiscovery });
  assert.equal(result.runtime.supported, false);
  assert.equal(result.scheduler.runtimeTick, false);
  assert.ok(result.missingSteps.some((step) => step.code === 'runtime_upgrade_required'));
  await assert.rejects(inspectSetup({ hostCapabilities: { web: 'yes' } }), { code: 'invalid_setup' });
  await assert.rejects(inspectSetup({ hostCapabilities: { token: 'private-value' } }), { code: 'secret_rejected' });
  assert.deepEqual(readdirSync(root), []);
});

test('only explicit Tavily inspection reads usage, without search requests or ledger writes', async (t) => {
  const { root } = fixture(t); const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ key: { usage: 2, limit: 100 }, account: { current_plan: 'free', plan_usage: 3, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }));
  };
  const options = { cwd: root, env: { PATH: '', TAVILY_API_KEY: 'private-value' }, discoverAgents: emptyDiscovery, fetch };
  await inspectSetup(options); assert.equal(calls.length, 0);
  const result = await inspectSetup({ ...options, checkTavily: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.tavily.com/usage');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(result.tavily.usageStatus, 'available');
  assert.equal(result.tavily.authentication, 'verified');
  assert.equal(result.tavily.usage.accountUsage, 3);
  assert.ok(!JSON.stringify(result).includes('private-value'));
  assert.deepEqual(readdirSync(root), []);
});

test('discovery and login probes honor host config locations while measurement safeEnvironment stays isolated', async (t) => {
  const { root } = fixture(t);
  const env = { PATH: '/fixture', CODEX_HOME: '/host/codex', CLAUDE_CONFIG_DIR: '/host/claude', GEMINI_CLI_HOME: '/host/gemini', TAVILY_API_KEY: 'private-value' };
  const calls = [];
  const run = async (_executable, _args, options) => { calls.push(options); return { stdout: 'Logged in using ChatGPT', stderr: '' }; };
  await discoverCli({ executable: 'fixture', env, cwd: root, execFileImpl: run, resolveExecutableImpl: () => '/fixture' });
  await probeAuthentication({ executable: '/fixture', args: ['login', 'status'], env, cwd: root, execFileImpl: run });
  for (const call of calls) {
    assert.equal(call.env.CODEX_HOME, env.CODEX_HOME);
    assert.equal(call.env.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
    assert.equal(call.env.GEMINI_CLI_HOME, env.GEMINI_CLI_HOME);
    assert.equal(call.env.TAVILY_API_KEY, undefined);
    assert.ok(call.timeout <= 10000); assert.ok(call.maxBuffer <= 256 * 1024);
  }
  assert.equal(safeEnvironment(env).CODEX_HOME, undefined);
});

test('doctor, setup default/inspect, and setup save expose JSON without provider inference', (t) => {
  const { root, directory } = fixture(t);
  const cli = resolve('bin/hearsay.js'); const env = { PATH: '', HOME: root };
  const run = (args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' }));
  for (const args of [['doctor'], ['setup'], ['setup', 'inspect']]) {
    const result = run(args); assert.equal(result.schemaVersion, 1); assert.equal(result.host.capabilities.web, null);
    assert.equal(result.routes.find((route) => route.id === 'gemini-cli').measurementSupported, false);
  }
  assert.equal(run(['doctor', '--check-tavily']).tavily.usageStatus, 'missing_key');
  assert.equal(run(['doctor', '--host', 'claude-code']).host.name, 'claude-code');
  assert.deepEqual(readdirSync(root), []);
  const file = join(root, 'input.json'); writeFileSync(file, JSON.stringify(input()));
  assert.equal(run(['setup', 'save', '--project', directory, '--input', file]).profile.appId, 'tasknest');
  const capabilities = join(root, 'capabilities.json'); writeFileSync(capabilities, JSON.stringify({ web: true, tasks: true }));
  assert.equal(run(['doctor', '--host-capabilities', capabilities]).scheduler.nativeTasks, true);
});
