import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {Record<string, any>} VerifyRecord */
/** @type {{studyPlan:(overrides?:VerifyRecord)=>VerifyRecord,studyProject:()=>VerifyRecord}} */
const { studyPlan, studyProject } = await import(new URL('../test-support/study-fixture.js', import.meta.url).href);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureKey = 'tvly-verification-fixture-do-not-save';
const fixtureTime = '2026-10-05T08:00:00.000Z';

/** @param {string} path @param {unknown} value */
function jsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** @param {string} directory @returns {[string,string][]} */
function checksums(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? checksums(path).map(([name, hash]) => /** @type {[string,string]} */ ([join(entry.name, name), hash]))
      : [/** @type {[string,string]} */ ([entry.name, createHash('sha256').update(readFileSync(path)).digest('hex')])];
  });
}

/** @param {string} directory @param {VerifyRecord} project */
function setupInput(directory, project) {
  return { schemaVersion: 1, identity: { status: 'confirmed' },
    profile: { appId: project.app.id, name: project.app.name, canonicalUrl: project.app.url, aliases: project.app.aliases,
      audience: project.app.audience, jobs: project.app.useCases },
    sources: [{ id: 'product-evidence', kind: 'repository', path: directory, summary: 'Owner supplied fixture repository describes outfit feedback.', observedAt: fixtureTime },
      { id: 'product-site', kind: 'url', url: project.app.url, summary: 'Owner supplied fixture URL identifies the same product.', observedAt: fixtureTime }],
    provenance: [{ field: 'name', sourceIds: ['product-evidence'] }, { field: 'canonicalUrl', sourceIds: ['product-site'] },
      { field: 'audience', sourceIds: ['product-evidence'] }, { field: 'jobs', sourceIds: ['product-evidence'] }], project };
}

/** @param {string} plugin @param {{directory:string,env:Record<string,string|undefined>,host:string,preload?:string}} context */
function client(plugin, context) {
  const entry = join(plugin, 'runtime', 'bin', 'hearsay.js');
  assert.ok(existsSync(entry), 'Installed package is missing its runtime executable');
  /** @type {string[]} */ const output = [];
  /** @param {string[]} args @param {{env?:Record<string,string|undefined>,error?:string}} [options] @returns {VerifyRecord} */
  function command(args, options = {}) {
    const result = spawnSync(process.execPath, [...(context.preload ? ['--import', context.preload] : []), entry, ...args, '--json'], {
      cwd: context.directory, env: { ...context.env, ...options.env }, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
    output.push(result.stdout ?? '', result.stderr ?? '');
    if (options.error) {
      assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
      const diagnostic = result.stderr.split('\n').find((line) => line.startsWith('{'));
      assert.ok(diagnostic, `${args.join(' ')} failed without a JSON diagnostic`);
      const error = JSON.parse(diagnostic).error;
      assert.equal(error.code, options.error, `${args.join(' ')}: ${result.stderr}`);
      return error;
    }
    assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
    return JSON.parse(result.stdout);
  }
  return { command, entry, output };
}

/** @param {string} plugin @param {{directory:string,env:Record<string,string|undefined>,host:string}} context */
export function verifyInstalledRuntime(plugin, context) {
  const c = client(plugin, { ...context, env: { ...context.env, PATH: '' } });
  const project = studyProject();
  const directory = join(context.directory, 'runtime-workspace', '.hearsay', project.app.id);
  const input = join(context.directory, 'runtime-setup.json');
  jsonFile(input, setupInput(context.directory, project));
  const doctor = c.command(['doctor', '--project', directory, '--host', context.host]);
  assert.equal(doctor.runtime.supported, true);
  assert.equal(doctor.tavily.keyPresent, false);
  assert.equal(doctor.workspace.records.length, 0);
  assert.equal(existsSync(directory), false, 'Inspection created project state');
  const saved = c.command(['setup', 'save', '--project', directory, '--input', input]);
  assert.equal(saved.profile.name, 'Drip Score');
  const plan = join(context.directory, 'runtime-plan.json');
  jsonFile(plan, studyPlan());
  const created = c.command(['study', 'create', '--project', directory, '--input', plan]);
  const preview = c.command(['study', 'preview', '--study', created.studyDirectory]);
  assert.equal(preview.plan.questions.length, 6);
  assert.equal(preview.plan.app.url, 'https://drip.example/');
  assert.match(preview.quoteId, /^[a-f0-9]{64}$/);
  const inspected = c.command(['setup', 'inspect', '--project', directory]);
  assert.equal(inspected.workspace.records[0].setupSaved, true);
  return { doctor: 'passed', setup: 'saved', studyPreview: 'passed', questionCount: 6, inferenceCalls: 0 };
}

/** @param {string} directory */
function fixtures(directory) {
  const bin = join(directory, 'fake-bin'); mkdirSync(bin, { recursive: true });
  const login = join(directory, 'fixture-login');
  const requests = join(directory, 'provider-requests.jsonl');
  const invocations = join(directory, 'cli-invocations.jsonl');
  const cronTable = join(directory, 'fixture-crontab');
  writeFileSync(cronTable, '15 3 * * * /usr/bin/unrelated-fixture-job\n');
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-codex 1.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--search --json --ephemeral --ignore-user-config --ignore-rules --sandbox --skip-git-repo-check'); process.exit(0); }
if (args[0] === 'login') {
  if (!fs.existsSync(${JSON.stringify(login)})) { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
if (!args.includes('exec') || !args.includes('--json')) throw new Error('Unexpected fixture invocation');
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => prompt += value);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ args, prompt, secretPresent: Boolean(process.env.TAVILY_API_KEY) }) + '\\n');
  console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'web_search_call',action:{type:'search',query:'outfit feedback apps'},results:[{url:'https://drip.example/',title:'Drip Score'}]}}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Drip Score provides outfit feedback. https://drip.example/'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));
});
`);
  chmodSync(codex, 0o700);
  const crontab = join(bin, 'crontab');
  writeFileSync(crontab, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '-l') { process.stdout.write(fs.readFileSync(${JSON.stringify(cronTable)}, 'utf8')); process.exit(0); }
if (args.length !== 1 || args[0] !== '-') throw new Error('Unexpected cron fixture invocation');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value);
process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(cronTable)}, input));
`);
  chmodSync(crontab, 0o700);
  const preload = join(directory, 'provider-fixture.mjs');
  writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [process.env.HEARSAY_FIXTURE_TIME])); }
  static now() { return new RealDate(process.env.HEARSAY_FIXTURE_TIME).getTime(); }
};
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  if (!['https://api.tavily.com/usage', 'https://api.tavily.com/search'].includes(String(url))) throw new Error('External network is disabled in verification');
  appendFileSync(${JSON.stringify(requests)}, JSON.stringify({url:String(url),body}) + '\\n');
  if (String(url).endsWith('/usage')) return Response.json({key:{usage:0,limit:1000},account:{current_plan:'free',plan_usage:0,plan_limit:1000,paygo_usage:0,paygo_limit:0}});
  return Response.json({request_id:'fixture-search',usage:{credits:1},results:[{url:'https://drip.example/',title:'Drip Score',content:'Outfit photo feedback. '+process.env.TAVILY_API_KEY,score:0.75}]});
};
`);
  return { bin, codex, login, requests, invocations, cronTable, preload };
}

/** @param {string} file @returns {VerifyRecord[]} */
function rows(file) { return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; }

/** @param {string} plugin @param {string} archive @param {string} directory @param {string} host */
function verifyWorkflow(plugin, archive, directory, host) {
  const f = fixtures(directory);
  const home = join(directory, 'home'); mkdirSync(home);
  /** @type {Record<string,string|undefined>} */ const env = { HOME: home, PATH: f.bin, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    GEMINI_CLI_HOME: home, HEARSAY_FIXTURE_TIME: fixtureTime, HEARSAY_CODEX_PATH: f.codex };
  const c = client(plugin, { directory, env, host, preload: f.preload });
  const projectDirectory = join(directory, '.hearsay', 'drip-score');
  const initial = c.command(['doctor', '--project', projectDirectory, '--host', host, '--check-tavily']);
  assert.equal(initial.tavily.usageStatus, 'missing_key');
  assert.equal(initial.routes.find((/** @type {VerifyRecord} */ route) => route.id === 'codex-agent').status, 'login_required');
  assert.ok(initial.missingSteps.some((/** @type {VerifyRecord} */ step) => step.action === 'codex login'));
  assert.equal(rows(f.requests).length, 0);
  const project = studyProject();
  project.selectedRoutes = ['codex-agent'];
  Object.assign(project.executions[0], { routes: [{ id: 'codex-agent', provider: 'openai', profile: 'codex-search-v1', executable: f.codex }],
    timeoutMs: 10000, idleTimeoutMs: 10000, maxOutputBytes: 100000 });
  const input = join(directory, 'setup-input.json'); const data = setupInput(directory, project);
  jsonFile(input, { ...data, identity: { status: 'ambiguous', candidates: ['drip-score', 'other-app'] } });
  c.command(['setup', 'save', '--project', projectDirectory, '--input', input], { error: 'identity_ambiguous' });
  assert.equal(existsSync(projectDirectory), false);
  jsonFile(input, data); c.command(['setup', 'save', '--project', projectDirectory, '--input', input]);
  jsonFile(input, { ...data, profile: { ...data.profile, name: 'Different product' } });
  c.command(['setup', 'save', '--project', projectDirectory, '--input', input], { error: 'identity_conflict' });
  const planFile = join(directory, 'plan.json');
  const plan = studyPlan(); plan.tavily = { ...plan.tavily, enabled: true, accountId: 'fixture-account' };
  jsonFile(planFile, plan);
  const created = c.command(['study', 'create', '--project', projectDirectory, '--input', planFile]);
  const study = created.studyDirectory;
  c.command(['study', 'collect', '--study', study], { error: 'study_approval_required' });
  c.command(['study', 'approve', '--study', study, '--confirm', 'wrong', '--author', 'owner'], { error: 'approval_required' });
  assert.equal(rows(f.requests).length, 0); assert.equal(rows(f.invocations).length, 0);
  writeFileSync(f.login, 'fixture subscription authenticated');
  const ready = c.command(['doctor', '--project', projectDirectory, '--check-tavily'], { env: { TAVILY_API_KEY: fixtureKey } });
  assert.equal(ready.tavily.usageStatus, 'available');
  assert.equal(ready.routes.find((/** @type {VerifyRecord} */ route) => route.id === 'codex-agent').status, 'available');
  const preview = c.command(['study', 'prepare-routes', '--study', study]);
  assert.equal(preview.plan.research.targetCount, 6);
  assert.equal(rows(f.invocations).length, 0);
  c.command(['study', 'approve', '--study', study, '--confirm', preview.quoteId, '--author', 'owner']);
  const html = '<h1>Drip Score outfit feedback</h1><p>Outfit photo feedback from owner supplied source.</p>';
  const page = join(directory, 'page.html'); writeFileSync(page, html);
  const capture = c.command(['study', 'capture', '--study', study, '--input', page]);
  const version = join(directory, 'version.json'); jsonFile(version, { id: 'baseline-v1', pageId: capture.id, status: 'published', author: 'owner', publishedAt: fixtureTime });
  c.command(['study', 'version', '--study', study, '--input', version]);
  const account = join(directory, 'account-ledger');
  const result = c.command(['study', 'collect', '--study', study, '--account-directory', account], { env: { TAVILY_API_KEY: fixtureKey } });
  assert.equal(result.status, 'completed'); assert.equal(result.analysisDue, true);
  assert.equal(rows(f.requests).filter((row) => row.url.endsWith('/search')).length, 6);
  assert.equal(rows(f.invocations).length, 6);
  for (const invocation of rows(f.invocations)) {
    assert.equal(invocation.secretPresent, false);
    assert.doesNotMatch(invocation.prompt, /Drip Score|drip\.example|tvly-/);
  }
  const beforeAnalysis = c.command(['study', 'report', '--study', study]);
  assert.equal(beforeAnalysis.summary.analysisDue, 1);
  const analysis = join(directory, 'analysis.json');
  jsonFile(analysis, { id: 'fixture-analysis', occurrenceIds: [result.occurrenceId], evidenceIds: [capture.id, ...result.evidenceIds], author: 'fixture-host-agent',
    recommendation: 'Continue observing', reason: 'The bounded fixture collection completed; no business outcome evidence is available.', nextAction: 'Review owner supplied outcomes before proposing a page change.' });
  c.command(['study', 'analysis', '--study', study, '--input', analysis]);
  const report = c.command(['study', 'report', '--study', study]);
  assert.equal(report.summary.analysisDue, 0);
  assert.match(report.markdown, /Continue observing/);
  assert.equal(readFileSync(join(study, 'pages', capture.id, 'original.html'), 'utf8'), html);
  const options = join(directory, 'schedule-options.json'); jsonFile(options, { accountDirectory: account });
  const schedule = c.command(['study', 'schedule-preview', '--study', study, '--input', options]);
  assert.equal(schedule.analysis, 'due_after_collection'); assert.equal(schedule.targetCeiling, 6);
  assert.equal(schedule.timezone, 'UTC'); assert.equal(schedule.questions.length, 6);
  assert.equal(readFileSync(f.cronTable, 'utf8'), '15 3 * * * /usr/bin/unrelated-fixture-job\n');
  c.command(['study', 'schedule-install', '--study', study, '--input', options, '--confirm', 'wrong', '--author', 'owner'], { error: 'consent_required' });
  const installed = c.command(['study', 'schedule-install', '--study', study, '--input', options, '--confirm', schedule.quoteId, '--author', 'owner']);
  assert.equal(installed.connected, true);
  assert.equal(readFileSync(installed.backup, 'utf8'), '15 3 * * * /usr/bin/unrelated-fixture-job\n');
  assert.ok(readFileSync(f.cronTable, 'utf8').startsWith('15 3 * * * /usr/bin/unrelated-fixture-job\n'));
  const sent = rows(f.requests).length;
  const missed = c.command(['study', 'schedule-tick', '--study', study], { env: { TAVILY_API_KEY: fixtureKey, HEARSAY_FIXTURE_TIME: '2026-10-07T09:10:00Z' } });
  assert.equal(missed.status, 'missed'); assert.equal(rows(f.requests).length, sent);
  assert.equal(rows(f.invocations).length, 6);
  const snapshot = c.command(['study', 'export', '--study', study]);
  assert.equal(snapshot.events.filter((/** @type {VerifyRecord} */ event) => event.type === 'occurrence_missed').length, 2);
  c.command(['study', 'schedule-remove', '--study', study]);
  assert.equal(readFileSync(f.cronTable, 'utf8'), '15 3 * * * /usr/bin/unrelated-fixture-job\n');
  const before = checksums(projectDirectory);
  rmSync(plugin, { recursive: true });
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', dirname(plugin)], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.deepEqual(checksums(projectDirectory), before, 'Plugin replacement changed external project history');
  const resumed = c.command(['study', 'inspect', '--study', study]);
  assert.equal(resumed.resume.latestReviewId, snapshot.reviews.at(-1).id);
  assert.equal(resumed.plan.app.id, 'drip-score');
  assert.equal(readFileSync(join(study, 'pages', capture.id, 'original.html'), 'utf8'), html);
  for (const [path] of checksums(projectDirectory)) assert.equal(readFileSync(join(projectDirectory, path)).includes(Buffer.from(fixtureKey)), false, `Secret in ${path}`);
  assert.equal(c.output.join('\n').includes(fixtureKey), false, 'Credential leaked into command output');
  return { host, status: 'passed', runtime: 'extracted archive', identity: 'ambiguity and conflict rejected', consent: 'no collection before exact approval',
    missingCredentials: 'actionable and resumable', collection: { providerSearches: 6, cliMeasurements: 6, analysisDueBeforeReview: 1, analysisDueAfterReview: 0 },
    scheduler: 'fake cron verified, backed up, removed; missed occurrences made no calls', upgrade: 'external history and raw capture preserved', liveCalls: 0 };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('Usage: node scripts/verify-plugin-runtime.js [--dist DIR] [--host portable|codex|claude|gemini]\nExtracts archives and verifies the runtime with isolated fake providers, CLIs and cron. No live requests.'); return;
  }
  for (let index = 0; index < argv.length; index += 2) assert.ok(['--dist', '--host'].includes(argv[index]) && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Expected --dist DIR or --host HOST');
  const dist = resolve(argv.includes('--dist') ? argv[argv.indexOf('--dist') + 1] : join(repository, 'dist'));
  const hosts = argv.includes('--host') ? [argv[argv.indexOf('--host') + 1]] : ['portable', 'codex', 'claude', 'gemini'];
  assert.ok(hosts.every((host) => ['portable', 'codex', 'claude', 'gemini'].includes(host)), 'Unsupported host');
  const temporary = mkdtempSync(join(tmpdir(), 'hearsay-plugin-runtime-'));
  const results = [];
  try {
    for (const host of hosts) {
      process.stderr.write(`Checking ${host} archive runtime with local fixtures.\n`);
      const directory = join(temporary, host); const installation = join(directory, 'installation'); mkdirSync(installation, { recursive: true });
      const archive = join(dist, `hearsay-${host}.tar.gz`);
      const extracted = spawnSync('tar', ['-xzf', archive, '-C', installation], { encoding: 'utf8' });
      assert.equal(extracted.status, 0, extracted.stderr);
      results.push(verifyWorkflow(join(installation, 'hearsay'), archive, directory, host));
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1;
});
