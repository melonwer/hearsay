import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hosts = ['portable', 'codex', 'claude', 'gemini'];

function files(directory, prefix = '') {
  return readdirSync(join(directory, prefix)).sort().flatMap((name) => {
    const path = join(prefix, name);
    const stat = lstatSync(join(directory, path));
    assert.equal(stat.isSymbolicLink(), false, `symlink in bundle: ${path}`);
    return stat.isDirectory() ? files(directory, path) : [path];
  });
}

function command(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stderr}\n${result.error || ''}`);
  return result.stdout;
}

function checkResources(directory) {
  for (const path of files(directory).filter((file) => file.endsWith('.md'))) {
    const content = readFileSync(join(directory, path), 'utf8');
    for (const match of content.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const absolute = resolve(directory, dirname(path), decodeURIComponent(target));
      assert.ok(!relative(directory, absolute).startsWith(`..${sep}`), `resource escapes bundle: ${path} -> ${target}`);
      assert.ok(existsSync(absolute), `missing resource: ${path} -> ${target}`);
    }
  }
}

test('all four installable bundles contain the canonical skill and self-contained resources', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'hearsay-packaging-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const output = join(temporary, 'dist');
  command(process.execPath, ['scripts/build-bundles.js', '--out', output]);
  const canonical = join(root, 'skill');
  const canonicalFiles = files(canonical);
  assert.ok(canonicalFiles.includes('SKILL.md'));
  assert.ok(canonicalFiles.includes(join('schemas', 'evidence.schema.json')));
  const archives = readdirSync(output).filter((file) => file.endsWith('.tar.gz'));
  assert.equal(archives.length, 4);

  for (const host of hosts) {
    const bundle = join(output, host, 'hearsay');
    const skill = host === 'portable' ? bundle : join(bundle, 'skills', 'hearsay');
    assert.deepEqual(files(skill), canonicalFiles, `${host}: complete canonical file set`);
    for (const file of canonicalFiles) {
      assert.deepEqual(readFileSync(join(skill, file)), readFileSync(join(canonical, file)), `${host}: ${file} byte equality`);
    }
    checkResources(bundle);
    for (const file of files(bundle)) {
      assert.doesNotMatch(file, /(^|[/\\])(?:\.hearsay|\.git|node_modules|runs|drafts|credentials)(?:[/\\]|$)/i);
      assert.doesNotMatch(file, /(?:\.db(?:-[\w]+)?|\.sqlite(?:3)?|\.env(?:\.[\w]+)?|auth\.json|oauth_creds\.json|trace\.jsonl)$/i);
      assert.doesNotMatch(readFileSync(join(bundle, file), 'utf8'), /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    }
    const archiveName = archives.find((file) => file.includes(host));
    assert.ok(archiveName, `${host}: named archive exists`);
    const archive = join(output, archiveName);
    const entries = command('tar', ['-tzf', archive]).trim().split('\n');
    for (const entry of entries) {
      assert.ok(!entry.startsWith('/') && !entry.split('/').includes('..'), `unsafe archive entry: ${entry}`);
    }
    const archiveFiles = entries.filter((entry) => !entry.endsWith('/')).map((entry) => entry.replace(/^\.\//, '').replace(/^hearsay\//, '')).sort();
    assert.deepEqual(archiveFiles, files(bundle).map((file) => file.split(sep).join('/')).sort(), `${host}: archive has exactly the bundle files`);
    for (const file of files(bundle)) {
      const entry = entries.find((name) => name.replace(/^\.\//, '') === `hearsay/${file.split(sep).join('/')}`);
      assert.ok(entry, `${host}: archive contains ${file}`);
      const captured = spawnSync('tar', ['-xOzf', archive, entry], { maxBuffer: 5 * 1024 * 1024 });
      assert.equal(captured.status, 0);
      assert.deepEqual(captured.stdout, readFileSync(join(bundle, file)), `${host}: archived ${file} byte equality`);
    }
  }

  const manifestPaths = { codex: '.codex-plugin/plugin.json', claude: '.claude-plugin/plugin.json', gemini: 'gemini-extension.json' };
  for (const [host, path] of Object.entries(manifestPaths)) {
    const manifest = JSON.parse(readFileSync(join(output, host, 'hearsay', path), 'utf8'));
    assert.equal(manifest.name, 'hearsay');
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    for (const key of ['mcpServers', 'hooks', 'apps', 'settings', 'contextFileName']) assert.equal(manifest[key], undefined, `${host}: no mandatory service or startup configuration`);
    if (host === 'codex') assert.equal(manifest.skills, './skills/');
    if (host === 'claude' && manifest.skills) assert.equal(manifest.skills, './skills/');
  }
});
