/**
 * CLI: node scripts/seed.js [--force]
 *
 * Loads the deterministic demo universe (§12) via core/seed.js. Refuses if the DB is
 * non-empty unless --force, which wipes first. Implemented in Phase 1 Lane D.
 */

import { config } from '../core/config.js';
import { openDb } from '../core/db.js';
import { isEmpty, seed, wipe } from '../core/seed.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const help = args.includes('--help') || args.includes('-h');
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag !== -1 && args[dbFlag + 1] ? args[dbFlag + 1] : config.dbPath;

if (help) {
  process.stdout.write(
    'Usage: node scripts/seed.js [--force] [--db <path>]\n\n' +
      '  Loads the Notewell demo universe: 4 entities, 12 prompts, 30 days of seeded runs.\n' +
      '  --force  wipe an existing database first (it refuses to touch a populated one otherwise)\n' +
      `  --db     database file, default ${config.dbPath}\n`,
  );
  process.exit(0);
}

const db = openDb(dbPath);

if (!isEmpty(db)) {
  if (!force) {
    process.stderr.write(
      `${dbPath} already has data — refusing to seed over it. Re-run with --force to wipe it first.\n`,
    );
    db.close();
    process.exit(1);
  }
  wipe(db);
}

const summary = seed(db);
const alerts = Object.entries(summary.alertTypes)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([type, n]) => `${type}×${n}`)
  .join(', ');

process.stdout.write(
  `Seeded ${dbPath}: ${summary.entities} entities, ${summary.intents} intents, ${summary.prompts} prompts, ` +
    `${summary.runs} runs, ${summary.responses} responses, ${summary.mentions} mentions, ` +
    `${summary.citations} citations, ${summary.alerts} alerts (${alerts}) — ${summary.from} to ${summary.to}.\n`,
);
db.close();
