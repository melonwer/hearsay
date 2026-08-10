/**
 * Entry point — boots the HTTP server (and, from Phase 1, the scheduler).
 *
 * `node server.js` is the whole install story: no build step, no dependencies,
 * one SQLite file.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as processConfig } from './core/config.js';
import { getSetting, openDb, SETTING_KEYS } from './core/db.js';
import { removePortFile, writePortFile } from './core/port-discovery.js';
import { recoverStaleRuns } from './core/runner.js';
import { localDate, startScheduler } from './core/scheduler.js';
import { seedIfDemoAndEmpty } from './core/seed.js';
import { createRouter } from './web/router.js';
import { registerApiRoutes } from './web/pages/api.js';
import { registerPageRoutes } from './web/pages/index.js';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(APP_DIR, 'public');

/** @returns {string} */
function readVersion() {
  try {
    const pkg = /** @type {{version?: string}} */ (
      JSON.parse(readFileSync(resolve(APP_DIR, 'package.json'), 'utf8'))
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

/**
 * Build the router for a given database + config.
 *
 * The page and API route tables live in `web/` (§10.2, §10.3); this function only
 * wires them together, so the HTTP surface stays in one lane.
 *
 * @param {Object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {import('./core/config.js').Config} deps.config
 * @returns {ReturnType<typeof createRouter>}
 */
export function buildRouter({ db, config }) {
  const router = createRouter({ publicDir: PUBLIC_DIR });
  registerPageRoutes(router, { db, config, version: VERSION });
  registerApiRoutes(router, { db, config, version: VERSION });
  return router;
}

/**
 * Boot an HTTP server. Pass `port: 0` for an ephemeral port (tests).
 *
 * @param {Object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string} [opts.dbPath]
 * @param {string} [opts.portFile]
 * @param {import('./core/config.js').Config} [opts.config]
 * @param {(message: string) => void} [opts.log] boot diagnostics; stderr by default
 * @returns {Promise<{server: import('node:http').Server, port: number, db: import('node:sqlite').DatabaseSync, scheduler: import('./core/scheduler.js').Scheduler, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const config = opts.config ?? processConfig;
  const dbPath = opts.dbPath ?? config.dbPath;
  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;
  const portFile = opts.portFile ?? config.portFile;
  const log = opts.log ?? ((/** @type {string} */ message) => process.stderr.write(`${message}\n`));

  const db = openDb(dbPath);
  // Demo mode with nothing to show boots into the fictional universe rather than an empty
  // dashboard (§12). Never touches a database that already has rows, seeded or live.
  const seeded = seedIfDemoAndEmpty(db, config);
  if (seeded) {
    process.stderr.write(
      `Demo mode: seeded ${seeded.responses} answers over ${seeded.runs} days (${seeded.from} to ${seeded.to}).\n`,
    );
  }

  // §8.1 step 1: a 'running' row older than 2h is an orphan from a crashed process —
  // mark it failed now, or runPanel refuses with RunInProgressError for up to 2h.
  const recovered = recoverStaleRuns(db);
  if (recovered > 0) log(`Recovered ${recovered} stale running run(s) — marked failed.`);

  // §8.2: the daily scheduler. startScheduler itself declines demo mode and keyless
  // installs; the boot log states the next run time when it is live.
  const scheduler = startScheduler({ db, config });
  if (scheduler.enabled) {
    const ranToday = getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null) === localDate(new Date());
    log(`Scheduler: next panel run ${ranToday ? 'tomorrow' : 'today'} at ${config.runAt} (local time).`);
  }

  const router = buildRouter({ db, config });
  const server = createServer((req, res) => {
    void router.handle(req, res);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen(undefined);
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  try {
    writePortFile(portFile, boundPort);
  } catch (error) {
    scheduler.stop();
    await new Promise((done) => server.close(() => done(undefined)));
    db.close();
    throw error;
  }

  return {
    server,
    port: boundPort,
    db,
    scheduler,
    close: async () => {
      scheduler.stop();
      await new Promise((done) => server.close(() => done(undefined)));
      removePortFile(portFile, boundPort);
      db.close();
    },
  };
}

/** @returns {boolean} */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const { port } = await startServer();
  process.stdout.write(`Hearsay v${VERSION} listening on http://${processConfig.host}:${port}\n`);
  if (processConfig.demo) {
    process.stdout.write('Demo mode: live provider calls and the scheduler are disabled.\n');
  } else if (processConfig.enabledProviders.length === 0) {
    process.stdout.write('No provider API keys found — add one to .env to run a panel.\n');
  }
}
