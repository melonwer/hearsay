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
import { get, openDb } from './core/db.js';
import { createRouter, sendHtml } from './web/router.js';
import { registerApiRoutes } from './web/pages/api.js';
import * as dashboardPage from './web/pages/dashboard.js';
import * as answersPage from './web/pages/answers.js';
import * as promptsPage from './web/pages/prompts.js';
import * as entitiesPage from './web/pages/entities.js';
import * as alertsPage from './web/pages/alerts.js';
import * as settingsPage from './web/pages/settings.js';
import * as setupPage from './web/pages/setup.js';
import * as methodologyPage from './web/pages/methodology.js';

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
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./core/config.js').Config} config
 * @returns {import('./web/layout.js').ShellCtx}
 */
function shellCtx(db, config) {
  const alertRow = get(db, 'SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0');
  const runRow = get(db, 'SELECT status, started_at, finished_at, done_calls, total_calls FROM runs ORDER BY id DESC LIMIT 1');

  /** @type {string|null} */
  let lastRunLine = null;
  if (runRow) {
    const status = String(runRow.status ?? '');
    const stamp = String(runRow.finished_at ?? runRow.started_at ?? '');
    const when = stamp === '' ? 'unknown time' : new Date(stamp).toLocaleString();
    const calls = `${Number(runRow.done_calls ?? 0)}/${Number(runRow.total_calls ?? 0)} calls`;
    lastRunLine = `Last run ${when} · ${status} · ${calls}`;
  }

  return {
    demo: config.demo,
    openAlerts: Number(alertRow?.n ?? 0),
    lastRunLine,
    version: VERSION,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
function entityCount(db) {
  const row = get(db, 'SELECT COUNT(*) AS n FROM entities WHERE archived_at IS NULL');
  return Number(row?.n ?? 0);
}

/**
 * Build the router for a given database + config.
 *
 * @param {Object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {import('./core/config.js').Config} deps.config
 * @returns {ReturnType<typeof createRouter>}
 */
export function buildRouter({ db, config }) {
  const router = createRouter({ publicDir: PUBLIC_DIR });

  router.add('GET', '/', (ctx) => {
    // First-run redirect (§11.8): no entities and demo mode off → the wizard.
    if (!config.demo && entityCount(db) === 0) {
      ctx.res.writeHead(302, { Location: '/setup' });
      ctx.res.end();
      return;
    }
    sendHtml(ctx.res, 200, dashboardPage.render(shellCtx(db, config)));
  });

  router.add('GET', '/answers', (ctx) => {
    sendHtml(ctx.res, 200, answersPage.render(shellCtx(db, config)));
  });

  router.add('GET', '/prompts', (ctx) => {
    sendHtml(ctx.res, 200, promptsPage.render(shellCtx(db, config)));
  });

  router.add('GET', '/entities', (ctx) => {
    sendHtml(ctx.res, 200, entitiesPage.render(shellCtx(db, config)));
  });

  router.add('GET', '/alerts', (ctx) => {
    sendHtml(ctx.res, 200, alertsPage.render(shellCtx(db, config)));
  });

  router.add('GET', '/settings', (ctx) => {
    const view = {
      providers: Object.values(config.providers).map((p) => ({
        label: p.label,
        model: p.model,
        enabled: p.enabled,
        maskedKey: p.maskedKey,
        keyEnv: p.keyEnv,
      })),
      runAt: config.runAt,
      samples: config.samples,
      concurrency: config.concurrency,
      timeoutMs: config.timeoutMs,
      demo: config.demo,
      dbPath: config.dbPath,
    };
    sendHtml(ctx.res, 200, settingsPage.render(shellCtx(db, config), view));
  });

  router.add('GET', '/setup', (ctx) => {
    const view = { enabledProviders: config.enabledProviders.map((p) => p.label) };
    sendHtml(ctx.res, 200, setupPage.render(shellCtx(db, config), view));
  });

  router.add('GET', '/methodology', (ctx) => {
    sendHtml(ctx.res, 200, methodologyPage.render(shellCtx(db, config)));
  });

  registerApiRoutes(router, { db, config });

  return router;
}

/**
 * Boot an HTTP server. Pass `port: 0` for an ephemeral port (tests).
 *
 * @param {Object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string} [opts.dbPath]
 * @param {import('./core/config.js').Config} [opts.config]
 * @returns {Promise<{server: import('node:http').Server, port: number, db: import('node:sqlite').DatabaseSync, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const config = opts.config ?? processConfig;
  const dbPath = opts.dbPath ?? config.dbPath;
  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;

  const db = openDb(dbPath);
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

  return {
    server,
    port: boundPort,
    db,
    close: async () => {
      await new Promise((done) => server.close(() => done(undefined)));
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
  // Phase 1 Lane A: mark stale 'running' runs failed, then start the daily scheduler
  // (core/scheduler.js) here when demo mode is off.
}
