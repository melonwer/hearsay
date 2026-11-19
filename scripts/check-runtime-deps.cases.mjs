import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-runtime-deps.js', import.meta.url));
/** @param {import('node:test').TestContext} t @param {Record<string,string>} files */
function check(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'hearsay-dependency-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['core', 'web', 'mcp', 'bin', 'public']) mkdirSync(join(root, directory));
  for (const [name, content] of Object.entries({ 'server.js': '', 'scripts/run-panel.js': '', 'scripts/seed.js': '',
    'scripts/suggest-prompts.js': '', 'scripts/build-bundles.js': '', ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
}

test('routes, comments, template text, allowlisted packages and optional browser tooling pass', (t) => {
  const result = check(t, { 'server.js': `import { readFileSync } from 'node:fs';
import './core/helper.js';
const route = '/api/research/import';
const text = "import 'not-an-import'";
const template = \`<form action="/api/outcomes/import">\`;
// import 'not-an-import';
`, 'core/helper.js': `export const value = 'hearsay_research_import';
export async function loadExtractors() {
  const webforai = await import('webforai');
  const diff = await import('diff');
  return { webforai, diff };
}
`, 'core/static-allowed.js': `import { htmlToMarkdown } from 'webforai';
import { diffLines } from 'diff';
export { htmlToMarkdown, diffLines };
`, 'scripts/verify-browser.js': "await import('playwright');" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime imports use only node: builtins, allowlisted packages \(webforai, diff\), and repository files/);
});

test('non-allowlisted static, dynamic, subpath, re-export and CommonJS package imports are rejected', (t) => {
  for (const [source, expected] of [
    ["import value from 'external-package';", '"external-package"'],
    ["await import('external-package');", '"external-package"'],
    ["export { value } from 'external-package';", '"external-package"'],
    ["const value = require('external-package');", '"external-package"'],
    ["const value = module.require('external-package');", '"external-package"'],
    ['await import(`external-package`);', '"external-package"'],
    ["import 'webforai/loaders/playwright';", '"webforai/loaders/playwright"'],
    ["await import('turndown');", '"turndown"'],
  ]) {
    const result = check(t, { 'bin/hearsay.js': source });
    assert.equal(result.status, 1, source);
    assert.ok(result.stderr.includes(`bin/hearsay.js:1: external runtime import ${expected}`), result.stderr);
  }
});

test('runtime imports cannot hide packages in a helper outside the runtime directories', (t) => {
  const result = check(t, { 'server.js': "import './scripts/verify-browser.js';", 'scripts/verify-browser.js': "await import('playwright');" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/verify-browser.js:1: external runtime import "playwright"/);
});

test('computed runtime import targets require an explicit dependency decision', (t) => {
  const result = check(t, { 'core/plugin.js': 'await import(process.env.PLUGIN);' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /module specifier must be a literal/);
});
