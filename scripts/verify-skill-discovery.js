import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: node scripts/verify-skill-discovery.js [--dist <directory>] [--host codex|claude|gemini]\nInstalls test bundles into temporary host configurations and checks skill discovery without inference.');
  process.exit(0);
}
for (let index = 0; index < argv.length; index += 2) {
  assert.ok(['--dist', '--host'].includes(argv[index]) && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Expected --dist <directory> or --host <host>. Use --help for usage.');
}
const distribution = resolve(argv.includes('--dist') ? argv[argv.indexOf('--dist') + 1] : join(repository, 'dist'));
const selected = argv.includes('--host') ? [argv[argv.indexOf('--host') + 1]] : ['codex', 'claude', 'gemini'];
assert.ok(selected.every((host) => ['codex', 'claude', 'gemini'].includes(host)), 'Supported hosts: codex, claude, gemini');
const temporary = mkdtempSync(join(tmpdir(), 'hearsay-skill-discovery-'));

/** @param {string} path @param {unknown} value */
function jsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} host */
function environment(host) {
  const directory = join(temporary, host);
  const config = join(directory, 'config');
  mkdirSync(config, { recursive: true });
  return {
    directory,
    config,
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      TERM: 'dumb',
      NO_COLOR: '1',
      CODEX_HOME: config,
      CLAUDE_CONFIG_DIR: config,
      GEMINI_CLI_HOME: config,
      GEMINI_CLI_NO_RELAUNCH: '1',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, 'system-settings.json'),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(directory, 'system-defaults.json'),
    },
  };
}

/** @param {string} executable @param {string[]} args @param {ReturnType<typeof environment>} context @param {string} [input] */
function run(executable, args, context, input) {
  const result = spawnSync(executable, args, {
    cwd: context.directory, env: context.env, encoding: 'utf8',
    timeout: 30_000, killSignal: 'SIGKILL', input,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${executable} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout;
}

/** @param {ReturnType<typeof environment>} context */
function codexSkills(context) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd: context.directory, env: context.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let errors = '';
    let completed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Codex metadata discovery timed out'));
    }, 30_000);
    child.stderr.on('data', (data) => { errors += data.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!completed) reject(new Error(`Codex app-server exited ${code}: ${errors}`));
    });
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) throw new Error(JSON.stringify(message.error));
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [context.directory], forceReload: true } })}\n`);
          }
          if (message.id === 2) {
            completed = true;
            clearTimeout(timer);
            child.kill('SIGTERM');
            resolveResult(message.result);
          }
        } catch (error) {
          completed = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          reject(error);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hearsay-discovery', version: '1.0.0' }, capabilities: { experimentalApi: true } } })}\n`);
  });
}

/** @param {ReturnType<typeof environment>} context @param {string} bundle */
async function codex(context, bundle) {
  const market = join(context.directory, 'marketplace');
  cpSync(bundle, join(market, 'plugins', 'hearsay'), { recursive: true });
  jsonFile(join(market, '.agents', 'plugins', 'marketplace.json'), {
    name: 'hearsay-discovery',
    plugins: [{ name: 'hearsay', source: { source: 'local', path: './plugins/hearsay' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }],
  });
  run('codex', ['plugin', 'marketplace', 'add', market, '--json'], context);
  const installed = JSON.parse(run('codex', ['plugin', 'add', 'hearsay@hearsay-discovery', '--json'], context));
  const list = JSON.parse(run('codex', ['plugin', 'list', '--marketplace', 'hearsay-discovery', '--json'], context));
  assert.equal(list.installed.length, 1);
  assert.equal(list.installed[0].enabled, true);
  const result = await codexSkills(context);
  const skill = result.data.flatMap((/** @type {{skills: {name: string, enabled: boolean, path: string, pluginId: string}[]}} */ item) => item.skills)
    .find((/** @type {{pluginId: string}} */ item) => item.pluginId === 'hearsay@hearsay-discovery');
  assert.ok(skill?.enabled, 'Codex did not discover an enabled Hearsay skill');
  assert.equal(skill.path, join(installed.installedPath, 'skills', 'hearsay', 'SKILL.md'));
  assert.deepEqual(readFileSync(skill.path), readFileSync(join(bundle, 'skills', 'hearsay', 'SKILL.md')));
  return { skill: skill.name, method: 'plugin install and app-server skills/list', inferenceCalls: 0 };
}

/** @param {ReturnType<typeof environment>} context @param {string} bundle */
async function claude(context, bundle) {
  const market = join(context.directory, 'marketplace');
  cpSync(bundle, join(market, 'plugins', 'hearsay'), { recursive: true });
  jsonFile(join(market, '.claude-plugin', 'marketplace.json'), {
    name: 'hearsay-discovery', owner: { name: 'Hearsay' }, plugins: [{ name: 'hearsay', source: './plugins/hearsay' }],
  });
  run('claude', ['plugin', 'validate', bundle], context);
  run('claude', ['plugin', 'marketplace', 'add', market], context);
  run('claude', ['plugin', 'install', 'hearsay@hearsay-discovery'], context);
  const details = run('claude', ['plugin', 'details', 'hearsay@hearsay-discovery'], context);
  assert.match(details, /Skills\s+\(1\)\s+hearsay/);
  assert.match(details, /MCP servers\s+\(0\)/);
  return { skill: 'hearsay', method: 'plugin validate, install and details', inferenceCalls: 0 };
}

/** @param {ReturnType<typeof environment>} context @param {string} bundle */
async function gemini(context, bundle) {
  const local = join(context.directory, 'hearsay');
  cpSync(bundle, local, { recursive: true });
  run('gemini', ['extensions', 'validate', local], context);
  run('gemini', ['extensions', 'install', local, '--consent'], context, 'y\n');
  const list = run('gemini', ['skills', 'list'], context);
  assert.match(list, /hearsay \[Enabled\]/);
  const installed = join(context.config, '.gemini', 'extensions', 'hearsay', 'skills', 'hearsay', 'SKILL.md');
  assert.ok(list.includes(installed), 'Gemini skill discovery did not use isolated configuration');
  assert.deepEqual(readFileSync(installed), readFileSync(join(bundle, 'skills', 'hearsay', 'SKILL.md')));
  return { skill: 'hearsay', method: 'extension validate, install and skills list', inferenceCalls: 0 };
}

const checks = { codex, claude, gemini };
const results = [];
try {
  for (const host of selected) {
    const context = environment(host);
    const version = spawnSync(host, ['--version'], { cwd: context.directory, env: context.env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    if (version.error && 'code' in version.error && version.error.code === 'ENOENT') {
      results.push({ host, status: 'unverified', reason: 'CLI not installed' });
      continue;
    }
    try {
      assert.equal(version.status, 0, `${host} --version failed`);
      process.stderr.write(`Checking ${host} skill discovery without inference.\n`);
      const detail = await checks[/** @type {keyof typeof checks} */ (host)](context, join(distribution, host, 'hearsay'));
      results.push({ host, version: version.stdout.trim(), status: 'passed', ...detail });
    } catch (error) {
      results.push({ host, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: results.every((result) => result.status === 'passed'), results }, null, 2));
if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
