/**
 * CLI tests (§15, SPEC §7). No live network: --estimate and suggest run with zero
 * provider keys; the live smoke path is verified to REFUSE without HEARSAY_LIVE_TEST=1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const NODE = process.execPath; // the same Node running the tests

function tmpDb() {
  return join(mkdtempSync(join(tmpdir(), 'hearsay-cli-')), 'test.db');
}

test('run-panel --estimate prints the quote JSON and never runs', async () => {
  const { stdout } = await exec(NODE, ['scripts/run-panel.js', '--estimate'], {
    env: { ...process.env, HEARSAY_DB_PATH: tmpDb(), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PERPLEXITY_API_KEY: '' },
  });
  const quote = JSON.parse(stdout);
  assert.equal(quote.calls, 0); // empty DB, zero providers
  assert.ok(Array.isArray(quote.perProvider));
});

test('run-panel --prompt without HEARSAY_LIVE_TEST refuses (no accidental spend)', async () => {
  await assert.rejects(
    exec(NODE, ['scripts/run-panel.js', '--once', '--prompt', 'test'], {
      env: { ...process.env, HEARSAY_DB_PATH: tmpDb(), HEARSAY_LIVE_TEST: '' },
    }),
    /HEARSAY_LIVE_TEST/,
  );
});
