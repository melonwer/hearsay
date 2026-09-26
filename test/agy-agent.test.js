import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyCliRunner, parseAgyJsonl, prepareAgyInvocation } from '../core/agy-agent.js';
import { agentExecutionProfile } from '../core/agent-runners.js';
import { AgentProcessError, safeEnvironment, spawnBounded } from '../core/agent-process.js';
import { readArtifact } from '../core/artifacts.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/agy-synthetic-${name}.jsonl`, import.meta.url), 'utf8');
const events = (name = 'search') => fixture(name).trim().split('\n').map((line) => JSON.parse(line));
const jsonl = (items) => items.map((item) => JSON.stringify(item)).join('\n') + '\n';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'hearsay-agy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

function fakeExecutable(root, name, source) {
  const path = join(root, name);
  writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return path;
}

test('synthetic agy events keep final answers, searches, citations and unavailable sources distinct', () => {
  const parsed = parseAgyJsonl(fixture('search'));
  assert.match(parsed.rawEvents[0]._fixture, /Synthetic.*not a live provider capture/);
  assert.equal(parsed.text, 'TaskNest suits a small team. See https://example.com/tasknest.');
  assert.equal(parsed.model, 'synthetic-model');
  assert.equal(parsed.durationMs, 1250);
  assert.equal(parsed.usage.inputTokens, 120);
  assert.equal(parsed.usage.outputTokens, 40);
  assert.equal(parsed.errorCode, null);
  assert.equal(parsed.webStatus, 'verified');
  assert.equal(parsed.returnedSources, null);
  assert.deepEqual(parsed.citations, ['https://example.com/tasknest']);
  assert.deepEqual(parsed.searchEvents.map(({ status, query, actionId, url, title, rank }) => ({ status, query, actionId, url, title, rank })), [
    { status: 'completed', query: 'project trackers for small teams', actionId: 'synthetic-search:1', url: null, title: null, rank: null },
  ]);
  assert.deepEqual(parsed.rawEvents.at(-1).result.usage, { input_tokens: 120, output_tokens: 40, thinking_tokens: 10, cache_read_tokens: 20, total_tokens: 190 });
});

test('duplicate events remain in the capture without duplicating normalized search evidence', () => {
  const original = events();
  const duplicated = original.flatMap((event) => [event, event]);
  const parsed = parseAgyJsonl(jsonl(duplicated));
  assert.equal(parsed.rawEvents.length, 12);
  assert.equal(parsed.searchEvents.length, 1);
  assert.equal(parsed.errorCode, null);
  assert.equal(parsed.text, 'TaskNest suits a small team. See https://example.com/tasknest.');
});

test('unexposed or invalid model, usage and duration metadata stay unavailable', () => {
  const input = events();
  delete input[0].init.model;
  input.at(-1).result.usage = { input_tokens: '120', output_tokens: -1 };
  delete input.at(-1).result.duration_seconds;
  const parsed = parseAgyJsonl(jsonl(input));
  assert.equal(parsed.model, null);
  assert.equal(parsed.usage.inputTokens, null);
  assert.equal(parsed.usage.outputTokens, null);
  assert.equal(parsed.durationMs, null);
});

test('a partial answer with completed search is still incomplete without a terminal result', () => {
  const parsed = parseAgyJsonl(fixture('partial'));
  assert.equal(parsed.text, 'TaskNest may suit a small team.');
  assert.equal(parsed.searchEvents[0].status, 'completed');
  assert.equal(parsed.webStatus, 'failed');
  assert.equal(parsed.errorCode, 'incomplete_output');
  assert.equal(parsed.usage.inputTokens, null);
});

test('terminal failures retain search failures and classify quota and authentication separately', () => {
  const quota = parseAgyJsonl(fixture('quota'));
  assert.equal(quota.text, null);
  assert.equal(quota.searchEvents[0].status, 'failed');
  assert.equal(quota.errorCode, 'quota_exhausted');
  assert.equal(quota.webStatus, 'failed');
  for (const [status, error, expected] of [
    ['ERROR', 'Authentication required: login expired', 'authentication_failed'],
    ['ERROR', 'rate limit exceeded', 'quota_exhausted'],
    ['ERROR', 'remote service unavailable', 'agent_failed'],
    ['CANCELED', undefined, 'agent_failed'],
    ['INTERRUPTED', undefined, 'agent_failed'],
    ['WAITING', undefined, 'agent_failed'],
  ]) {
    const input = events();
    Object.assign(input.at(-1).result, { status, error });
    const parsed = parseAgyJsonl(jsonl(input));
    assert.equal(parsed.errorCode, expected, `${status}: ${error}`);
    assert.equal(parsed.webStatus, 'failed');
  }
});

test('missing or unfinished searches cannot verify answer citations', () => {
  for (const input of [events().filter((event) => event.step_update?.step_type !== 'tool'), events().filter((event) => event.step_update?.step_type !== 'tool' || event.step_update.state !== 'DONE')]) {
    const parsed = parseAgyJsonl(jsonl(input));
    assert.equal(parsed.webStatus, 'unverified');
    assert.deepEqual(parsed.citations, ['https://example.com/tasknest']);
    assert.equal(parsed.returnedSources, null);
  }
});

test('a completed search update retains parameters exposed by its earlier event', () => {
  const input = events();
  delete input[3].step_update.tool_info.parameters;
  const parsed = parseAgyJsonl(jsonl(input));
  assert.equal(parsed.searchEvents[0].status, 'completed');
  assert.equal(parsed.searchEvents[0].query, 'project trackers for small teams');
});

test('a failed search cannot become a successful measurement through a SUCCESS terminal', () => {
  const input = events('quota');
  Object.assign(input.at(-1).result, { status: 'SUCCESS', error: undefined, response: 'I could not search.' });
  const parsed = parseAgyJsonl(jsonl(input));
  assert.equal(parsed.searchEvents[0].status, 'failed');
  assert.equal(parsed.webStatus, 'failed');
  assert.ok(parsed.errorCode);
});

test('mixed tool inventories and unrelated activity do not alter web evidence', () => {
  const input = events();
  input[0].init.tools.push('run_command', 'read_url_content', 'invoke_subagent', 'mcp_search_web');
  for (const [step_index, tool_name] of ['run_command', 'read_url_content', 'invoke_subagent', 'mcp_search_web'].entries()) {
    input.splice(-1, 0, { event: 'step_update', step_update: { conversation_id: 'other', step_index, step_type: 'tool', tool_name, state: 'DONE', tool_info: { parameters: { query: 'not a web search', url: 'https://not-a-returned-source.example/' }, error: 'unrelated failure' }, subagent_info: { name: 'other-agent' } } });
  }
  const parsed = parseAgyJsonl(jsonl(input));
  assert.equal(parsed.errorCode, null);
  assert.equal(parsed.webStatus, 'verified');
  assert.deepEqual(parsed.searchEvents, parseAgyJsonl(fixture('search')).searchEvents);
  assert.deepEqual(parsed.citations, ['https://example.com/tasknest']);
  assert.deepEqual(parsed.rawEvents, input);
  const withoutSearch = input.filter((event) => event.step_update?.tool_name !== 'search_web');
  assert.equal(parseAgyJsonl(jsonl(withoutSearch)).webStatus, 'unverified');
  assert.deepEqual(parseAgyJsonl(jsonl(withoutSearch)).searchEvents, []);
  delete input[0].init.tools;
  assert.equal(parseAgyJsonl(jsonl(input)).webStatus, 'verified');
  input.splice(-1, 0, { event: 'step_update', step_update: { ...input[3].step_update, tool_name: 'run_command', tool_info: { parameters: { query: 'must not replace search parameters' } } } });
  assert.deepEqual(parseAgyJsonl(jsonl(input)).searchEvents, parsed.searchEvents);
});

test('conflicting terminals remain failures', () => {
  const conflict = events();
  conflict.push({ event: 'result', result: { status: 'SUCCESS', response: 'Different answer.' } });
  assert.equal(parseAgyJsonl(jsonl(conflict)).errorCode, 'conflicting_terminal_events');
});

test('agy parser rejects malformed, nonobject and bounded-out JSONL', () => {
  assert.throws(() => parseAgyJsonl('{"event":"init"\n'), /malformed event/i);
  assert.throws(() => parseAgyJsonl('null\n'), /JSON object/i);
  assert.throws(() => parseAgyJsonl(fixture('search'), { maxLineBytes: 10 }), /line limit/i);
  assert.throws(() => parseAgyJsonl(fixture('search'), { maxOutputBytes: 10 }), /output limit/i);
  assert.throws(() => parseAgyJsonl(fixture('search'), { maxEvents: 1 }), /event count limit/i);
});

test('prepared isolation masks the home, mounts only the executable, and writes private account-only settings', (t) => {
  const root = directory(t);
  const home = join(root, 'personal-home');
  const original = join(home, '.gemini', 'antigravity-cli');
  mkdirSync(original, { recursive: true });
  writeFileSync(join(original, 'settings.json'), '{"personal":"preserve"}');
  const executable = join(home, '.local', 'bin', 'fake-agy');
  const runRoot = join(root, 'isolated');
  const invocation = prepareAgyInvocation(executable, runRoot, home, 'Which project tracker suits a small team?', 1501);
  const { args, workspace, config } = invocation;
  assert.deepEqual(args.slice(0, 11), ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--die-with-parent', '--tmpfs', home]);
  assert.deepEqual(args.slice(11, 16), ['--dir', join(home, '.local', 'bin'), '--ro-bind', executable, executable]);
  assert.deepEqual(args.slice(16), ['--bind', config, join(home, '.gemini'), '--chdir', workspace, executable, '--agent', 'hearsay-neutral-web', '--disable-slash-commands', '--output-format', 'stream-json', '--print-timeout', '2s', '--print', 'Which project tracker suits a small team?']);
  const settingsPath = join(config, 'antigravity-cli', 'settings.json');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { useG1Credits: false, toolPermission: 'request-review', disableSlashCommands: true, permissions: { allow: ['read_url(*)'], deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'mcp(*)', 'execute_url(*)'] } });
  assert.deepEqual(JSON.parse(readFileSync(join(config, 'config', 'hooks.json'), 'utf8')), {});
  assert.deepEqual(JSON.parse(readFileSync(join(config, 'config', 'mcp_config.json'), 'utf8')), { mcpServers: {} });
  const definitionPath = join(workspace, '.agents', 'agents', 'hearsay-neutral-web.md');
  const definition = readFileSync(definitionPath, 'utf8');
  for (const text of ['inheritCustomizations: false', 'tools:\n  - search_web\n', 'commandExecutionPolicy: off', 'skills: []', 'plugins: []', 'mcpServers: []']) assert.ok(definition.includes(text), text);
  assert.equal(readFileSync(join(original, 'settings.json'), 'utf8'), '{"personal":"preserve"}');
  assert.deepEqual(readdirSync(config).sort(), ['antigravity-cli', 'config']);
  if (process.platform !== 'win32') {
    for (const path of [settingsPath, definitionPath, join(config, 'config', 'hooks.json'), join(config, 'config', 'mcp_config.json')]) assert.equal(statSync(path).mode & 0o777, 0o600);
    for (const path of [workspace, config]) assert.equal(statSync(path).mode & 0o777, 0o700);
  }
});

test('fake bubblewrap process receives bounded account-only environment and produces separately identified evidence', async (t) => {
  const root = directory(t);
  const capture = join(root, 'invocation.json');
  const fakeBwrap = fakeExecutable(root, 'bwrap', `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args: process.argv.slice(2), env: process.env, cwd: process.cwd()})); process.stdout.write(${JSON.stringify(fixture('search'))});`);
  environment(t, { PATH: root, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/bus', XDG_RUNTIME_DIR: '/synthetic/runtime', OPENAI_API_KEY: 'synthetic-openai-key', GEMINI_API_KEY: 'synthetic-gemini-key', GOOGLE_API_KEY: 'synthetic-google-key', ANTHROPIC_API_KEY: 'synthetic-anthropic-key', GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/paid-credentials.json' });
  const runner = new AgyCliRunner({ dataDir: join(root, 'data'), executable: '/synthetic/fake-agy', timeoutMs: 2000, idleTimeoutMs: 1000 });
  const result = await runner.runIsolated({ responseId: 1, promptText: 'Which project tracker suits a small team?' }, { executable: '/synthetic/fake-agy', version: '1.2.11' });
  assert.ok(existsSync(fakeBwrap));
  const invocation = JSON.parse(readFileSync(capture, 'utf8'));
  for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) assert.equal(invocation.env[key], undefined, key);
  assert.equal(invocation.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/synthetic/bus');
  assert.equal(invocation.env.XDG_RUNTIME_DIR, '/synthetic/runtime');
  assert.equal(invocation.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.ok(invocation.args.includes('--print-timeout'));
  assert.equal(existsSync(invocation.cwd), false);
  assert.equal(result.surface, 'agy-cli');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.cliVersion, '1.2.11');
  assert.equal(result.cliExecutable, '/synthetic/fake-agy');
  assert.equal(result.text, 'TaskNest suits a small team. See https://example.com/tasknest.');
  assert.equal(readArtifact(runner.artifactStore, result.artifactRef).length, 6);
});

test('public agy execution accepts the captured mixed tool inventory through the process runner', { skip: process.platform !== 'linux' }, async (t) => {
  const root = directory(t);
  const calls = join(root, 'calls.jsonl');
  const executable = fakeExecutable(root, 'fake-agy', `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n'); process.stdout.write(process.argv.includes('--version') ? '1.2.11\\n' : '--print --output-format --agent\\n');`);
  const captured = readFileSync(new URL('./fixtures/agy-1.2.11-captured-web.jsonl', import.meta.url), 'utf8');
  fakeExecutable(root, 'bwrap', `process.stdout.write(${JSON.stringify(captured)});`);
  environment(t, { PATH: root, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/bus', XDG_RUNTIME_DIR: '/synthetic/runtime' });
  const runner = new AgyCliRunner({ executable, dataDir: join(root, 'data') });
  const result = await runner.run({ responseId: 1, promptText: 'Neutral buyer question', promptOrigin: 'user_authored' });
  assert.equal(result.errorCode, null);
  assert.equal(result.webStatus, 'verified');
  assert.equal(result.searchEvents.length, 2);
  assert.equal(result.citations.length, 9);
  assert.equal(result.executionProfileHash, agentExecutionProfile('agy-cli').hash);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [['--version'], ['--help']]);
});

test('fake process timeout and cancellation preserve partial agy streams', async (t) => {
  const root = directory(t);
  const stream = fixture('partial');
  for (const kind of ['timeout', 'cancelled']) {
    const controller = new AbortController();
    await assert.rejects(spawnBounded({
      executable: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(stream)}); setInterval(() => {}, 1000);`], input: '', cwd: root, env: safeEnvironment(), timeoutMs: 3000, idleTimeoutMs: 300, maxOutputBytes: 8192, signal: controller.signal,
      spawnImpl: (executable, args, options) => {
        const child = spawn(executable, args, options);
        if (kind === 'cancelled') child.stdout.once('data', () => setImmediate(() => controller.abort()));
        return child;
      },
    }), (error) => {
      assert.ok(error instanceof AgentProcessError);
      assert.equal(error.code, kind);
      assert.equal(error.output.stdout, stream);
      const parsed = parseAgyJsonl(error.output.stdout);
      assert.equal(parsed.text, 'TaskNest may suit a small team.');
      assert.equal(parsed.errorCode, 'incomplete_output');
      assert.equal(parsed.webStatus, 'failed');
      return true;
    });
  }
});

test('fake process non-JSON authentication failure retains diagnostics without an answer', async (t) => {
  const root = directory(t);
  await assert.rejects(spawnBounded({ executable: process.execPath, args: ['-e', "process.stderr.write('AGY_ERROR: Authentication required\\n'); process.exit(3);"], input: '', cwd: root, env: safeEnvironment(), timeoutMs: 2000, idleTimeoutMs: 1000, maxOutputBytes: 4096 }), (error) => {
    assert.equal(error.code, 'nonzero_exit');
    assert.equal(error.output.stdout, '');
    assert.equal(error.output.stderr, 'AGY_ERROR: Authentication required\n');
    assert.equal(error.output.exitCode, 3);
    return true;
  });
});


test('captured agy 1.2.11 search extracts web evidence from its broad tool inventory', () => {
  const parsed = parseAgyJsonl(readFileSync(new URL('./fixtures/agy-1.2.11-captured-web.jsonl', import.meta.url), 'utf8'));
  assert.equal(parsed.errorCode, null);
  assert.equal(parsed.webStatus, 'verified');
  assert.equal(parsed.searchEvents.filter((event) => event.status === 'completed').length, 2);
  assert.deepEqual(parsed.searchEvents.map((event) => event.query), ['best self-hosted email newsletter open source', 'self-hosted newsletter platforms listmonk ghost keila mailcoach sendy']);
  assert.equal(parsed.citations.length, 9);
  assert.equal(parsed.returnedSources, null);
  assert.equal(parsed.model, null);
  assert.equal(parsed.usage.inputTokens, 10525);
  assert.equal(parsed.usage.outputTokens, 1952);
});
