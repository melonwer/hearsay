import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildBundles } from '../scripts/build-bundles.js';
import { studyPlan, studyProject } from '../test-support/study-fixture.js';
import { saveSetup } from '../core/plugin-setup.js';

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

function sourceFixture(temporary) {
  const checkout = join(temporary, 'source'); mkdirSync(join(checkout, 'scripts'), { recursive: true });
  for (const source of ['skill', 'core', 'bin', 'web', 'public', 'server.js', 'METHODOLOGY.md', 'LICENSE', 'package.json']) cpSync(join(root, source), join(checkout, source), { recursive: true });
  cpSync(join(root, 'scripts', 'build-bundles.js'), join(checkout, 'scripts', 'build-bundles.js'));
  return checkout;
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 30_000, ...options });
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
  assert.ok(canonicalFiles.includes(join('references', 'studies.md')));
  assert.ok(canonicalFiles.includes(join('templates', 'study.json')));
  assert.ok(canonicalFiles.includes(join('templates', 'setup.json')));
  assert.ok(canonicalFiles.includes(join('references', 'setup.md')));
  assert.match(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), /\]\(references\/setup\.md\)/);
  const setupTemplate = JSON.parse(readFileSync(join(canonical, 'templates', 'setup.json'), 'utf8'));
  assert.equal(saveSetup(join(temporary, 'template-workspace', '.hearsay', setupTemplate.profile.appId), setupTemplate).profile.appId, setupTemplate.profile.appId);
  const archives = readdirSync(output).filter((file) => file.endsWith('.tar.gz'));
  assert.equal(archives.length, 4);

  for (const host of hosts) {
    const bundle = join(output, host, 'hearsay');
    const skill = host === 'portable' ? bundle : join(bundle, 'skills', 'hearsay');
    const relativeRuntime = host === 'portable' ? 'runtime/bin/hearsay.js' : '../../runtime/bin/hearsay.js';
    assert.equal(resolve(skill, relativeRuntime), join(bundle, 'runtime', 'bin', 'hearsay.js'));
    assert.ok(existsSync(resolve(skill, relativeRuntime)), `${host}: installation-relative resolver`);
    assert.ok(readFileSync(join(skill, 'references', 'setup.md'), 'utf8').includes(relativeRuntime), `${host}: documented installed runtime path`);
    assert.deepEqual(files(skill).filter((file) => !file.startsWith(`runtime${sep}`)), canonicalFiles, `${host}: complete canonical file set`);
    for (const file of canonicalFiles) {
      assert.deepEqual(readFileSync(join(skill, file)), readFileSync(join(canonical, file)), `${host}: ${file} byte equality`);
    }
    checkResources(bundle);
    for (const file of files(bundle)) {
      assert.doesNotMatch(file, /(^|[/\\])(?:\.hearsay|\.git|node_modules|runs|drafts|credentials|captures|histories|studies|search-runs|test|test-support|data|video)(?:[/\\]|$)/i);
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

test('archive-extracted runtimes perform setup and study preview outside the repository, then survive replacement', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'hearsay-runtime-package-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundles = buildBundles(join(temporary, 'dist'));
  const project = studyProject(); const plan = studyPlan();
  const input = { schemaVersion: 1, identity: { status: 'confirmed' },
    profile: { appId: project.app.id, name: project.app.name, canonicalUrl: project.app.url, audience: project.app.audience, jobs: project.app.useCases },
    sources: [{ id: 'product-evidence', kind: 'url', url: project.app.url }],
    provenance: [{ field: 'name', sourceIds: ['product-evidence'] }, { field: 'canonicalUrl', sourceIds: ['product-evidence'] }], project };
  for (const bundle of bundles) {
    const installation = join(temporary, bundle.target); mkdirSync(installation);
    command('tar', ['-xzf', bundle.archive, '-C', installation]);
    const plugin = join(installation, 'hearsay'); const runtime = join(plugin, 'runtime'); const cli = join(runtime, 'bin', 'hearsay.js');
    assert.ok(existsSync(cli), `${bundle.target}: packaged runtime entrypoint`);
    assert.ok(!existsSync(join(runtime, 'node_modules')));
    const metadata = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
    assert.equal(metadata.type, 'module'); assert.equal(metadata.engines.node, '>=22.13');
    assert.equal(metadata.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
    assert.deepEqual(metadata.dependencies ?? {}, {});
    for (const path of ['LICENSE', 'server.js', 'METHODOLOGY.md', 'web/pages/methodology.js', 'public/style.css', 'public/app.js', 'skill/schemas/project.schema.json', 'skill/templates/project.json']) {
      assert.deepEqual(readFileSync(join(runtime, path)), readFileSync(join(root, path)), `${bundle.target}: runtime source ${path}`);
    }
    for (const tree of ['bin', 'core', 'web', 'public', join('skill', 'schemas'), join('skill', 'templates')]) {
      assert.deepEqual(files(join(runtime, tree)), files(join(root, tree)), `${bundle.target}: complete runtime tree ${tree}`);
      for (const file of files(join(root, tree))) assert.deepEqual(readFileSync(join(runtime, tree, file)), readFileSync(join(root, tree, file)), `${bundle.target}: source equality ${tree}/${file}`);
    }
    const workspace = join(temporary, `${bundle.target}-workspace`); mkdirSync(workspace);
    const options = { cwd: workspace, env: { PATH: '', HOME: workspace } };
    assert.match(command(process.execPath, [cli, '--help'], options), /setup save/);
    assert.equal(JSON.parse(command(process.execPath, [cli, 'doctor'], options)).runtime.supported, true);
    assert.deepEqual(readdirSync(workspace), [], `${bundle.target}: inspection creates no records`);
    const setupFile = join(workspace, 'setup-input.json'); const planFile = join(workspace, 'plan.json');
    writeFileSync(setupFile, JSON.stringify(input)); writeFileSync(planFile, JSON.stringify(plan));
    const directory = join(workspace, '.hearsay', project.app.id);
    const saved = JSON.parse(command(process.execPath, [cli, 'setup', 'save', '--project', directory, '--input', setupFile], options));
    assert.equal(saved.profile.appId, project.app.id);
    const created = JSON.parse(command(process.execPath, [cli, 'study', 'create', '--project', directory, '--input', planFile], options));
    const preview = JSON.parse(command(process.execPath, [cli, 'study', 'preview', '--study', created.studyDirectory], options));
    assert.equal(preview.plan.app.id, project.app.id); assert.equal(preview.plan.questions.length, 6); assert.ok(preview.quoteId);
    const captureDirectory = join(created.studyDirectory, 'captures'); mkdirSync(captureDirectory);
    writeFileSync(join(captureDirectory, 'original.html'), '<h1>Preserved source</h1>\n');
    const before = files(directory).map((file) => ({ file, bytes: readFileSync(join(directory, file)) }));
    rmSync(plugin, { recursive: true }); command('tar', ['-xzf', bundle.archive, '-C', installation]);
    for (const row of before) assert.deepEqual(readFileSync(join(directory, row.file)), row.bytes, `${bundle.target}: upgrade preserves ${row.file}`);
    assert.equal(JSON.parse(command(process.execPath, [cli, 'study', 'preview', '--study', created.studyDirectory], options)).quoteId, preview.quoteId);
    assert.match(command(process.execPath, [cli, '--help'], options), /Website studies/);
    if (process.platform !== 'win32') assert.ok(lstatSync(cli).mode & 0o111, 'CLI archive mode is executable');
    const serverCheck = command(process.execPath, ['--input-type=module', '-e', `const {buildView}=await import(${JSON.stringify(pathToFileURL(join(runtime, 'web/pages/methodology.js')).href)}); if(buildView().missing) throw Error('methodology missing'); await import(${JSON.stringify(pathToFileURL(join(runtime, 'server.js')).href)}); console.log('loaded');`], options);
    assert.match(serverCheck, /loaded/);
  }
});

test('bundle writer rejects unsafe source/output overlap, symlink outputs and project records before mutation', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'hearsay-package-safety-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const checkout = sourceFixture(temporary);
  const rejectedBuild = (output, reason) => {
    const result = spawnSync(process.execPath, [join(checkout, 'scripts', 'build-bundles.js'), '--out', output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, output); assert.match(result.stderr, reason, output);
  };
  for (const output of [checkout, dirname(checkout), join(checkout, 'core'), join(checkout, 'skill', 'schemas'), join(checkout, '.hearsay', 'example'), join(temporary, '.hearsay', 'example')]) {
    rejectedBuild(output, /separate|unsafe|workspace|source/i);
  }
  const protectedOutput = join(temporary, 'protected'); const protectedDirectory = join(protectedOutput, 'codex', 'hearsay'); mkdirSync(protectedDirectory, { recursive: true });
  writeFileSync(join(protectedDirectory, 'project.json'), '{"raw":"preserve"}\n');
  rejectedBuild(protectedOutput, /workspace|project/i);
  assert.equal(readFileSync(join(protectedDirectory, 'project.json'), 'utf8'), '{"raw":"preserve"}\n');
  const destination = join(temporary, 'real'); mkdirSync(destination);
  const link = join(temporary, 'link'); symlinkSync(destination, link, 'dir');
  rejectedBuild(link, /symlink/i); assert.deepEqual(readdirSync(destination), []);
  const nested = join(temporary, 'nested'); mkdirSync(join(nested, 'codex'), { recursive: true });
  symlinkSync(destination, join(nested, 'codex', 'hearsay'), 'dir');
  rejectedBuild(nested, /symlink/i); assert.deepEqual(readdirSync(destination), []);
  const dangling = join(temporary, 'dangling'); symlinkSync(join(temporary, 'absent'), dangling, 'dir');
  rejectedBuild(dangling, /symlink/i);
});

test('reviewed source closure excludes machine/data files and rejects source symlinks', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'hearsay-package-source-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const checkout = sourceFixture(temporary);
  const secret = 'private-source-fixture-value';
  for (const file of ['.env', '.env.local', 'auth.json', 'oauth_creds.json', 'project.json', 'secret.db']) writeFileSync(join(checkout, file), secret);
  mkdirSync(join(checkout, 'data')); writeFileSync(join(checkout, 'data', 'capture.jsonl'), secret);
  const output = join(temporary, 'out'); command(process.execPath, [join(checkout, 'scripts', 'build-bundles.js'), '--out', output]);
  for (const bundle of hosts) for (const file of files(join(output, bundle, 'hearsay'))) assert.ok(!readFileSync(join(output, bundle, 'hearsay', file), 'utf8').includes(secret), file);
  const first = readFileSync(join(output, 'hearsay-codex.tar.gz'));
  symlinkSync(join(checkout, '.env'), join(checkout, 'core', 'unsafe.js'));
  const result = spawnSync(process.execPath, [join(checkout, 'scripts', 'build-bundles.js'), '--out', output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /symlink/i);
  assert.deepEqual(readFileSync(join(output, 'hearsay-codex.tar.gz')), first, 'unsafe source fails before replacing artifacts');
});
