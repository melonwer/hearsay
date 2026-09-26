import { readFileSync, readdirSync, mkdirSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** @param {string} directory @param {string} [prefix] @returns {{name:string,bytes:Buffer}[]} */
function files(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap((name) => {
    const full = join(directory, name);
    if (lstatSync(full).isSymbolicLink()) throw new Error(`Bundle refuses symlink: ${full}`);
    if (lstatSync(full).isDirectory()) return files(full, `${prefix}${name}/`);
    if (!/\.(md|json|yaml)$/.test(name)) throw new Error(`Unexpected skill file: ${name}`);
    return [{ name: `${prefix}${name}`, bytes: readFileSync(full) }];
  });
}
/** @param {{name:string,bytes:Buffer}[]} entries */
function archive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(entry.name) > 100) throw new Error('Archive path too long');
    header.write(entry.name, 0, 100);
    for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, entry.bytes.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
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
  if (destination === root || destination === join(root, 'skill')) throw new Error('Output must be a separate directory');
  const entries = files(join(root, 'skill'));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const manifest = { name: 'hearsay', version, description: 'Research app visibility and produce sourced improvement reports with your current agent.', author: { name: 'Hearsay' } };
  const targets = ['portable', 'codex', 'claude', 'gemini'];
  for (const target of targets) {
    const base = join(destination, target, 'hearsay');
    rmSync(base, { recursive: true, force: true });
    const skillPrefix = target === 'portable' ? '' : 'skills/hearsay/';
    const content = entries.map((entry) => ({ name: `${skillPrefix}${entry.name}`, bytes: entry.bytes }));
    if (target === 'codex') content.push({ name: '.codex-plugin/plugin.json', bytes: Buffer.from(JSON.stringify({ ...manifest, skills: './skills/', interface: { displayName: 'Hearsay', shortDescription: 'App visibility research', longDescription: 'Discover competitors, research recommendations, and save evidence-linked reports with your current agent.', defaultPrompt: ['Track my app and investigate its visibility.'], developerName: 'Hearsay', category: 'Productivity', capabilities: ['Read', 'Write'] } }, null, 2) + '\n') });
    if (target === 'claude') content.push({ name: '.claude-plugin/plugin.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
    if (target === 'gemini') content.push({ name: 'gemini-extension.json', bytes: Buffer.from(JSON.stringify({ name: 'hearsay', version }, null, 2) + '\n') });
    for (const entry of content) { const path = join(base, entry.name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, entry.bytes); }
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
