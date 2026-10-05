import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** @typedef {{name:string,bytes:Buffer,mode?:number}} Entry */
const runtimeTrees = [
  { path: 'bin', extensions: /\.js$/ },
  { path: 'core', extensions: /\.js$/ },
  { path: 'web', extensions: /\.js$/ },
  { path: 'public', extensions: /\.(js|css)$/ },
  { path: 'mcp', extensions: /\.mjs$/ },
  { path: 'skill/schemas', extensions: /\.json$/ },
  { path: 'skill/templates', extensions: /\.(json|md)$/ },
];
const runtimeFiles = ['server.js', 'METHODOLOGY.md', 'LICENSE'];

/** @param {string} path */
function lstatIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null; throw error; }
}

/** @param {string} path */
function refuseSymlinkAncestors(path) {
  let ancestor = resolve(path);
  while (true) {
    if (lstatIfPresent(ancestor)?.isSymbolicLink()) throw new Error(`Bundle refuses symlink: ${ancestor}`);
    const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
}
/** @param {string} path @param {string} parent */
function inside(path, parent) { const suffix = relative(parent, path); return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !suffix.startsWith(sep)); }

/** @param {string} directory @param {string} [destination] */
function inspectOutput(directory, destination = directory) {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`Bundle refuses symlink: ${directory}`);
  if (!stat.isDirectory()) throw new Error('Output must be a separate directory');
  for (const name of readdirSync(directory)) {
    const path = join(directory, name); const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error(`Bundle refuses symlink: ${path}`);
    if (['.hearsay', 'runs', 'studies', 'captures', 'histories', 'search-runs', 'data', 'node_modules'].includes(name)
      || /(?:\.db(?:-[\w]+)?|\.sqlite(?:3)?|\.env(?:\.[\w]+)?|auth\.json|oauth_creds\.json|\.jsonl)$/i.test(name)) throw new Error('Unsafe output contains workspace or machine data');
    if (entry.isDirectory()) inspectOutput(path, destination);
    else if (!entry.isFile()) throw new Error('Output contains unsupported filesystem entry');
    else if (['project.json', 'setup.json', 'study.json'].includes(name)
      && !/^(?:portable\/hearsay\/templates\/|(?:codex|claude|gemini)\/hearsay\/skills\/hearsay\/templates\/|(?:portable|codex|claude|gemini)\/hearsay\/runtime\/skill\/templates\/)(?:project|setup|study)\.json$/.test(relative(destination, path).split(sep).join('/'))) throw new Error('Output contains project workspace records');
  }
}

/** @param {string} directory @param {RegExp} extensions @param {string} [prefix] @returns {Entry[]} */
function files(directory, extensions, prefix = '') {
  refuseSymlinkAncestors(directory);
  return readdirSync(directory).sort().flatMap((name) => {
    const full = join(directory, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Bundle refuses symlink: ${full}`);
    if (stat.isDirectory()) return files(full, extensions, `${prefix}${name}/`);
    if (!stat.isFile() || !extensions.test(name)) throw new Error(`Unexpected bundle source file: ${full}`);
    return [{ name: `${prefix}${name}`, bytes: readFileSync(full), mode: prefix === '' && directory === join(root, 'bin') ? 0o755 : 0o644 }];
  });
}
/** @param {string} path @returns {Entry} */
function runtimeFile(path) {
  const full = join(root, path); refuseSymlinkAncestors(full);
  if (!lstatSync(full).isFile()) throw new Error(`Unexpected bundle source file: ${full}`);
  return { name: `runtime/${path}`, bytes: readFileSync(full), mode: 0o644 };
}
/** @param {Entry[]} entries */
function archive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    if (entry.name.startsWith('/') || entry.name.split('/').some((part) => part === '..' || part === '') || Buffer.byteLength(entry.name) > 100) throw new Error('Unsafe archive path or path too long');
    header.write(entry.name, 0, 100);
    for (const [offset, length, value] of [[100, 8, entry.mode ?? 0o644], [108, 8, 0], [116, 8, 0], [124, 12, entry.bytes.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
/** @param {string} output */
export function buildBundles(output) {
  const destination = resolve(output);
  if (inside(root, destination) || (inside(destination, root) && !inside(destination, join(root, 'dist')))
    || destination.split(sep).includes('.hearsay')) throw new Error('Unsafe output: use a separate directory outside source and project workspaces');
  refuseSymlinkAncestors(destination); inspectOutput(destination);
  const entries = files(join(root, 'skill'), /\.(md|json|yaml)$/);
  const metadataEntry = runtimeFile('package.json');
  const metadata = JSON.parse(metadataEntry.bytes.toString('utf8')); const version = metadata.version;
  const runtime = [
    ...runtimeTrees.flatMap((tree) => files(join(root, tree.path), tree.extensions).map((entry) => ({ ...entry, name: `runtime/${tree.path}/${entry.name}` }))),
    ...runtimeFiles.map(runtimeFile),
    { name: 'runtime/package.json', bytes: Buffer.from(JSON.stringify({ name: metadata.name, version, description: metadata.description, license: metadata.license,
      type: 'module', bin: { hearsay: './bin/hearsay.js' }, engines: metadata.engines, scripts: { start: 'node server.js' } }, null, 2) + '\n'), mode: 0o644 },
  ];
  const manifest = { name: 'hearsay', version, description: 'Research app visibility and produce sourced improvement reports with your current agent.', author: { name: 'Hearsay' } };
  const targets = ['portable', 'codex', 'claude', 'gemini'];
  for (const target of targets) {
    const base = join(destination, target, 'hearsay');
    rmSync(base, { recursive: true, force: true });
    const skillPrefix = target === 'portable' ? '' : 'skills/hearsay/';
    const content = [...entries.map((entry) => ({ ...entry, name: `${skillPrefix}${entry.name}` })), ...runtime];
    if (target === 'codex') content.push({ name: '.codex-plugin/plugin.json', bytes: Buffer.from(JSON.stringify({ ...manifest, skills: './skills/', interface: { displayName: 'Hearsay', shortDescription: 'App visibility research', longDescription: 'Discover competitors, research recommendations, and save evidence-linked reports with your current agent.', defaultPrompt: ['Track my app and investigate its visibility.'], developerName: 'Hearsay', category: 'Productivity', capabilities: ['Read', 'Write'] } }, null, 2) + '\n') });
    if (target === 'claude') content.push({ name: '.claude-plugin/plugin.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
    if (target === 'gemini') content.push({ name: 'gemini-extension.json', bytes: Buffer.from(JSON.stringify({ name: 'hearsay', version }, null, 2) + '\n') });
    for (const entry of content) { const path = join(base, entry.name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, entry.bytes, { mode: entry.mode ?? 0o644 }); }
    if (target === 'codex' || target === 'claude') {
      const directory = join(destination, target, target === 'codex' ? '.agents/plugins' : '.claude-plugin');
      mkdirSync(directory, { recursive: true });
      const source = target === 'codex' ? { source: 'local', path: './hearsay' } : './hearsay';
      writeFileSync(join(directory, 'marketplace.json'), JSON.stringify({ name: 'hearsay-local', owner: { name: 'Hearsay' }, plugins: [{ name: 'hearsay', source, ...(target === 'codex' ? { policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' } : {}) }] }, null, 2) + '\n');
    }
    writeFileSync(join(destination, `hearsay-${target}.tar.gz`), archive(content.map((entry) => ({ ...entry, name: `hearsay/${entry.name}` }))));
  }
  return targets.map((target) => ({ target, directory: join(destination, target, 'hearsay'), archive: join(destination, `hearsay-${target}.tar.gz`) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--out');
  const output = index < 0 ? join(root, 'dist') : process.argv[index + 1];
  if (!output) throw new Error('--out requires a directory');
  process.stdout.write(JSON.stringify(buildBundles(output), null, 2) + '\n');
}
