import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const [surface, variable] of [['codex-agent', 'CODEX_HOME'], ['claude-code-agent', 'CLAUDE_CONFIG_DIR']]) {
  test(`${surface} measurement uses the credential location verified by its login probe`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'hearsay-account-config-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const executable = join(root, 'fixture-cli');
    const account = join(root, 'selected-account');
    writeFileSync(executable, `#!${process.execPath}\n` + `
const args = process.argv.slice(2);
const account = process.env[${JSON.stringify(variable)}] || 'different-default-account';
if (args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--search --json --ephemeral --ignore-user-config --ignore-rules --sandbox --skip-git-repo-check --safe-mode --no-session-persistence --no-chrome --output-format --permission-mode --tools --allowedTools --strict-mcp-config'); process.exit(0); }
if (args.includes('status')) { console.log(account === ${JSON.stringify(account)} ? 'Logged in using ${surface === 'codex-agent' ? 'ChatGPT' : 'claude.ai OAuth'}' : 'Not logged in'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  const text = JSON.stringify({ account, secretPresent: Boolean(process.env.TAVILY_API_KEY || process.env.OPENAI_API_KEY) });
  console.log(JSON.stringify(${surface === 'codex-agent' ? "{ type: 'item.completed', item: { type: 'agent_message', text } }" : "{ type: 'result', subtype: 'success', result: text }"}));
});
`);
    chmodSync(executable, 0o700);
    const source = `
import { createAgentRunner } from ${JSON.stringify(new URL('../core/agent-runners.js', import.meta.url).href)};
const runner = createAgentRunner(${JSON.stringify(surface)}, { executable: ${JSON.stringify(executable)}, dataDir: ${JSON.stringify(join(root, 'data'))} });
const preflight = await runner.preflight();
const result = await runner.run({ responseId: 1, promptText: 'Which tools help choose an outfit?', promptOrigin: 'user_authored' });
console.log(JSON.stringify({ authenticated: preflight.authenticated, ...JSON.parse(result.text) }));
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root, env: { PATH: '', HOME: root, [variable]: account, TAVILY_API_KEY: 'private-fixture', OPENAI_API_KEY: 'private-fixture' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { authenticated: true, account, secretPresent: false });
  });
}
