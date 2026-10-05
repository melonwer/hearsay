import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { get, getSetting, setSetting, SETTING_KEYS } from './db.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

/** @param {string} path @returns {string} */
function canonicalPath(path) {
  if (path === ':memory:') return path;
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalPath(parent), basename(absolute));
}

/** @param {string} path @param {string} directory @returns {boolean} */
function within(path, directory) {
  const part = relative(directory, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** @param {import('./config.js').Config} config @param {string} [selectedDbPath] */
export function assertInstancePaths(config, selectedDbPath = config.dbPath) {
  const realDb = canonicalPath(config.realDbPath);
  const demoDb = canonicalPath(config.demoDbPath);
  const realArtifacts = canonicalPath(join(config.realDataDir, 'artifacts'));
  const demoArtifacts = canonicalPath(join(config.demoDataDir, 'artifacts'));
  if (realDb === demoDb || realArtifacts === demoArtifacts ||
      within(realDb, demoArtifacts) || within(demoDb, realArtifacts)) {
    throw new Error('Demo and real database/artifact paths overlap. Set HEARSAY_DEMO_DB_PATH and HEARSAY_DEMO_DATA_DIR to separate locations.');
  }
  const selected = canonicalPath(selectedDbPath);
  if (config.demo && selected === realDb) throw new Error('Demo mode cannot open the real database path.');
  if (!config.demo && selected === demoDb) throw new Error('Real mode cannot open the demo database path.');
}

/** @param {Db} db @param {boolean} demo */
export function ensureInstanceKind(db, demo) {
  const expected = demo ? 'demo' : 'real';
  const stored = getSetting(db, SETTING_KEYS.INSTANCE_KIND, null);
  const seedRows = Number(get(db, "SELECT COUNT(*) AS n FROM runs WHERE trigger = 'seed'")?.n ?? 0);
  const liveRows = Number(get(db, "SELECT COUNT(*) AS n FROM runs WHERE trigger <> 'seed'")?.n ?? 0);
  const seededAt = getSetting(db, SETTING_KEYS.SEEDED_AT, null);
  if (seedRows > 0 && liveRows > 0) {
    throw new Error('This database contains both demo and real runs. Preserve it and separate the data manually before starting Hearsay.');
  }
  const legacyKind = seedRows > 0 || seededAt ? 'demo' : liveRows > 0 ? 'real' : null;
  if (stored && stored !== expected || legacyKind && legacyKind !== expected) {
    throw new Error(`This database contains ${stored ?? legacyKind} data, but ${expected} mode is selected. No data was changed. For a legacy demo at the real path, set HEARSAY_DEMO_DB_PATH to that path and HEARSAY_DB_PATH to a new real path.`);
  }
  if (demo && !stored && !legacyKind) {
    const content = Number(get(db, `SELECT (SELECT COUNT(*) FROM entities) + (SELECT COUNT(*) FROM intents) +
      (SELECT COUNT(*) FROM prompts) + (SELECT COUNT(*) FROM responses) +
      (SELECT COUNT(*) FROM settings) + (SELECT COUNT(*) FROM outcome_records) +
      (SELECT COUNT(*) FROM ledger_entries) AS n`)?.n ?? 0);
    if (content > 0) throw new Error('Demo mode needs an empty or previously seeded demo database. No data was changed.');
  }
  if (!stored) setSetting(db, SETTING_KEYS.INSTANCE_KIND, expected);
}
