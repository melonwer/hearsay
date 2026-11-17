/**
 * Entry point — boots the HTTP server (and, from Phase 1, the scheduler).
 *
 * `node server.js` is the whole install story: no build step, no dependencies,
 * one SQLite file.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_ROUTES } from './core/agent-routes.js';
import { buildConfig, config as processConfig } from './core/config.js';
import { get, getSetting, openDb, SETTING_KEYS } from './core/db.js';
import { updateEnvFile, withEnvFile } from './core/env-file.js';
import { assertInstancePaths, ensureInstanceKind } from './core/instance.js';
import { removePortFile, writePortFile } from './core/port-discovery.js';
import { recoverStaleRuns } from './core/runner.js';
import { localDate, startScheduler } from './core/scheduler.js';
import { seedIfDemoAndEmpty } from './core/seed.js';
import { getSubscriptionSchedule } from './core/subscription-scheduler.js';
import { SURFACE_LABEL } from './web/layout.js';
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
 * Describe the configured inference routes for the production-entrypoint message.
 * This is pure so startup copy can be exercised without opening a database or port.
 *
 * @param {import('./core/config.js').Config} config
 * @returns {string|null} startup guidance, or null when an API route is already configured
 */
export function startupGuidance(config) {
  if (config.demo) return 'Demo mode: live provider calls and the scheduler are disabled.';

  const labels = (config.subscriptionSurfaces ?? []).map((surface) => SURFACE_LABEL[surface] ?? surface);
  if ((config.enabledProviders ?? []).length > 0) return null;
  if (labels.length > 0) {
    return `No API keys are configured. Subscription measurements are enabled for ${labels.join(
      ' and ',
    )}; Hearsay can run through signed-in plan allowance, which may incur overage.`;
  }
  return 'No inference route is configured. Authenticate Codex or Claude Code and set HEARSAY_CODEX_ENABLED=1 or HEARSAY_CLAUDE_CODE_ENABLED=1, or configure an optional API key for direct API measurements.';
}

/**
 * Reconstruct an env map matching an injected `Config` object so in-process onboarding
 * mutations preserve custom test/embedder configuration fields.
 *
 * @param {import('./core/config.js').Config} cfg
 * @param {{dbPath?: string, portFile?: string}} [overrides]
 * @returns {Record<string, string|undefined>}
 */
function envFromConfig(cfg, overrides = {}) {
  const defaultDemoDerived = resolve(dirname(resolve(cfg.realDbPath)), 'demo/hearsay.db');
  const realDbPath =
    overrides.dbPath && !cfg.demo
      ? overrides.dbPath
      : overrides.dbPath && cfg.demo && cfg.realDbPath === './data/hearsay.db'
        ? join(dirname(resolve(overrides.dbPath)), 'real-hearsay.db')
        : cfg.realDbPath;
  /** @type {Record<string, string|undefined>} */
  const env = {
    PORT: String(cfg.port),
    HOST: cfg.host,
    HEARSAY_DB_PATH: realDbPath,
    HEARSAY_PORT_FILE: overrides.portFile ?? cfg.portFile,
    HEARSAY_RUN_AT: cfg.runAt,
    HEARSAY_SAMPLES: String(cfg.samples),
    HEARSAY_CONCURRENCY: String(cfg.concurrency),
    HEARSAY_TIMEOUT_MS: String(cfg.timeoutMs),
    HEARSAY_DEMO: cfg.demo ? '1' : '0',
    HEARSAY_CONFIRM_USD: String(cfg.confirmUsd),
    HEARSAY_OPENAI_SEARCH_POLICY: cfg.apiSearchPolicies.openai,
    HEARSAY_ANTHROPIC_SEARCH_POLICY: cfg.apiSearchPolicies.anthropic,
    HEARSAY_GEMINI_SEARCH_POLICY: cfg.apiSearchPolicies.gemini,
    HEARSAY_SUBSCRIPTION_SAMPLES: String(cfg.subscriptionSamples),
    HEARSAY_SUBSCRIPTION_CONCURRENCY: String(cfg.subscriptionConcurrency),
    HEARSAY_SUBSCRIPTION_TIMEOUT_MS: String(cfg.subscriptionTimeoutMs),
    HEARSAY_SUBSCRIPTION_IDLE_TIMEOUT_MS: String(cfg.subscriptionIdleTimeoutMs),
    HEARSAY_SUBSCRIPTION_MAX_OUTPUT_BYTES: String(cfg.subscriptionMaxOutputBytes),
    ...cfg.pricingEnv,
  };

  if (overrides.dbPath && cfg.demo && cfg.demoDbPath === defaultDemoDerived) {
    env.HEARSAY_DEMO_DB_PATH = overrides.dbPath;
  } else if (cfg.demoDbPath !== defaultDemoDerived) {
    env.HEARSAY_DEMO_DB_PATH = cfg.demoDbPath;
  }
  if (cfg.realDataDir !== dirname(resolve(cfg.realDbPath))) {
    env.HEARSAY_DATA_DIR = cfg.realDataDir;
  }
  if (cfg.demoDataDir !== dirname(resolve(cfg.demoDbPath))) {
    env.HEARSAY_DEMO_DATA_DIR = cfg.demoDataDir;
  }

  for (const provider of Object.values(cfg.providers)) {
    if (provider.apiKey !== '') env[provider.keyEnv] = provider.apiKey;
    env[provider.modelEnv] = provider.model;
  }
  for (const route of AGENT_ROUTES) {
    const sub = cfg.subscription[route.key];
    if (!sub) continue;
    env[route.enabledEnv] = sub.enabled ? '1' : '0';
    if (sub.executable && sub.executable !== route.executable) {
      env[route.pathEnv] = sub.executable;
    }
  }
  return env;
}

/**
 * @typedef {Object} OnboardingRuntime
 * @property {() => string} getEnvFile
 * @property {(key: string) => string} getEnvValue
 * @property {() => string|undefined} getPathEnv
 * @property {() => import('node:sqlite').DatabaseSync} getDb
 * @property {() => import('./core/config.js').Config} getConfig
 * @property {(updates: Record<string, string|null>) => Promise<import('./core/config.js').Config>} updateProviders
 * @property {(demo: boolean) => Promise<{switched: boolean, demo: boolean}>} switchMode
 */

/**
 * Build the router for a given database + config.
 *
 * The page and API route tables live in `web/` (§10.2, §10.3); this function only
 * wires them together, so the HTTP surface stays in one lane.
 *
 * @param {Object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {import('./core/config.js').Config} deps.config
 * @param {OnboardingRuntime} [deps.runtime]
 * @returns {ReturnType<typeof createRouter>}
 */
export function buildRouter({ db, config, runtime }) {
  const router = createRouter({ publicDir: PUBLIC_DIR });
  const routeDeps = { db, config, version: VERSION, ...(runtime ? { runtime } : {}) };
  registerPageRoutes(router, routeDeps);
  registerApiRoutes(router, routeDeps);
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
 * @param {string} [opts.envFile]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {boolean} [opts.syncProcessEnv]
 * @param {import('./core/config.js').Config} [opts.config]
 * @param {(message: string) => void} [opts.log] boot diagnostics; stderr by default
 * @returns {Promise<{server: import('node:http').Server, port: number, db: import('node:sqlite').DatabaseSync, config: import('./core/config.js').Config, scheduler: import('./core/scheduler.js').Scheduler, envFile: string, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const envFile = opts.envFile
    ? resolve(opts.envFile)
    : opts.config
      ? join(
          dirname(
            resolve(
              opts.config.realDbPath !== './data/hearsay.db'
                ? opts.config.realDbPath
                : (opts.dbPath ?? opts.config.realDbPath),
            ),
          ),
          '.env',
        )
      : resolve(process.env.HEARSAY_ENV_FILE ?? resolve(process.cwd(), '.env'));
  const syncProcessEnv = opts.syncProcessEnv ?? !opts.config;

  const baseEnv = opts.config
    ? withEnvFile({ ...envFromConfig(opts.config, { dbPath: opts.dbPath, portFile: opts.portFile }), ...opts.env }, envFile)
    : withEnvFile({ ...process.env, ...opts.env }, envFile);

  const initialConfig = opts.config ?? buildConfig(baseEnv);
  const initialDbPath = opts.dbPath ?? initialConfig.dbPath;
  const port = opts.port ?? initialConfig.port;
  const host = opts.host ?? initialConfig.host;
  const portFile = opts.portFile ?? initialConfig.portFile;
  const log = opts.log ?? ((/** @type {string} */ message) => process.stderr.write(`${message}\n`));

  assertInstancePaths(initialConfig, initialDbPath);
  const initialDb = openDb(initialDbPath);
  try {
    ensureInstanceKind(initialDb, initialConfig.demo);
  } catch (error) {
    initialDb.close();
    throw error;
  }
  // Demo mode with nothing to show boots into the fictional universe rather than an empty
  // dashboard (§12). Never touches a database that already has rows, seeded or live.
  const seeded = seedIfDemoAndEmpty(initialDb, initialConfig);
  if (seeded) {
    process.stderr.write(
      `Demo mode: seeded ${seeded.responses} answers over ${seeded.runs} days (${seeded.from} to ${seeded.to}).\n`,
    );
  }

  // §8.1 step 1: a 'running' row older than 2h is an orphan from a crashed process —
  // mark it failed now, or runPanel refuses with RunInProgressError for up to 2h.
  const recovered = recoverStaleRuns(initialDb);
  if (recovered > 0) log(`Recovered ${recovered} stale running run(s) — marked failed.`);

  // §8.2: the daily scheduler. startScheduler itself declines demo mode and keyless
  // installs; the boot log states the next run time when it is live.
  const initialScheduler = startScheduler({ db: initialDb, config: initialConfig, log });
  if (initialScheduler.enabled && initialConfig.enabledProviders.length > 0) {
    const ranToday = getSetting(initialDb, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null) === localDate(new Date());
    log(`Scheduler: next panel run ${ranToday ? 'tomorrow' : 'today'} at ${initialConfig.runAt} (local time).`);
  }
  if (!initialConfig.demo && initialConfig.subscriptionSurfaces.length > 0) {
    const schedule = getSubscriptionSchedule(initialDb);
    log(schedule
      ? `Subscription schedule: ${schedule.runAt} (${schedule.timeZone}); see tracking health for the next occurrence and consent state.`
      : 'Subscription runner available; no active recurring schedule.');
  }

  const state = {
    env: { ...baseEnv },
    config: initialConfig,
    dbPath: initialDbPath,
    db: initialDb,
    scheduler: initialScheduler,
    /** @type {ReturnType<typeof createRouter>} */
    router: /** @type {*} */ (null),
  };

  let mutationQueue = Promise.resolve();
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  const serialize = (fn) => {
    const runNext = mutationQueue.then(fn, fn);
    mutationQueue = runNext.then(() => undefined, () => undefined);
    return runNext;
  };

  /** @type {OnboardingRuntime} */
  const runtime = {
    getEnvFile: () => envFile,
    getEnvValue: (key) => String(state.env[key] ?? ''),
    getPathEnv: () => state.env.PATH ?? process.env.PATH,
    getDb: () => state.db,
    getConfig: () => state.config,
    updateProviders: (updates) =>
      serialize(() => {
        /** @type {Record<string, string|undefined>} */
        const nextEnv = { ...state.env };
        for (const [key, value] of Object.entries(updates)) {
          if (value === null || value === '') {
            delete nextEnv[key];
          } else {
            nextEnv[key] = value;
          }
        }
        const nextConfig = buildConfig(nextEnv);
        assertInstancePaths(nextConfig, state.dbPath);
        updateEnvFile(envFile, updates);
        if (syncProcessEnv) {
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === '') {
              delete process.env[key];
            } else {
              process.env[key] = value;
            }
          }
        }
        state.scheduler.stop();
        const nextScheduler = startScheduler({ db: state.db, config: nextConfig, log });
        const nextRouter = buildRouter({ db: state.db, config: nextConfig, runtime });
        state.env = nextEnv;
        state.config = nextConfig;
        state.scheduler = nextScheduler;
        state.router = nextRouter;
        return nextConfig;
      }),
    switchMode: (targetDemo) =>
      serialize(() => {
        const running = get(state.db, "SELECT id FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
        if (running) {
          const err = new Error(`Cannot switch workspace mode while run #${running.id} is in progress.`);
          err.name = 'RunInProgressError';
          throw err;
        }

        /** @type {Record<string, string|undefined>} */
        const nextEnv = { ...state.env, HEARSAY_DEMO: targetDemo ? '1' : '0' };
        const nextConfig = buildConfig(nextEnv);
        const nextDbPath = nextConfig.dbPath;
        assertInstancePaths(nextConfig, nextDbPath);

        if (nextConfig.demo === state.config.demo && resolve(nextDbPath) === resolve(state.dbPath)) {
          updateEnvFile(envFile, { HEARSAY_DEMO: targetDemo ? '1' : '0' });
          if (syncProcessEnv) process.env.HEARSAY_DEMO = targetDemo ? '1' : '0';
          state.env = nextEnv;
          return { switched: false, demo: state.config.demo };
        }

        const nextDb = openDb(nextDbPath);
        try {
          ensureInstanceKind(nextDb, nextConfig.demo);
          const demoSeeded = seedIfDemoAndEmpty(nextDb, nextConfig);
          if (demoSeeded) {
            log(`Demo mode: seeded ${demoSeeded.responses} answers over ${demoSeeded.runs} days (${demoSeeded.from} to ${demoSeeded.to}).`);
          }
          recoverStaleRuns(nextDb);
          updateEnvFile(envFile, { HEARSAY_DEMO: targetDemo ? '1' : '0' });
        } catch (err) {
          try {
            nextDb.close();
          } catch {
            /* ignore close error */
          }
          throw err;
        }

        if (syncProcessEnv) process.env.HEARSAY_DEMO = targetDemo ? '1' : '0';
        state.scheduler.stop();
        const nextScheduler = startScheduler({ db: nextDb, config: nextConfig, log });
        const nextRouter = buildRouter({ db: nextDb, config: nextConfig, runtime });

        const prevDb = state.db;
        state.env = nextEnv;
        state.config = nextConfig;
        state.dbPath = nextDbPath;
        state.db = nextDb;
        state.scheduler = nextScheduler;
        state.router = nextRouter;
        prevDb.close();

        return { switched: true, demo: state.config.demo };
      }),
  };

  state.router = buildRouter({ db: state.db, config: state.config, runtime });

  const server = createServer((req, res) => {
    void state.router.handle(req, res);
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
    state.scheduler.stop();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(() => done(undefined)));
    state.db.close();
    throw error;
  }

  return {
    server,
    port: boundPort,
    envFile,
    get db() {
      return state.db;
    },
    get config() {
      return state.config;
    },
    get scheduler() {
      return state.scheduler;
    },
    close: async () => {
      await mutationQueue;
      state.scheduler.stop();
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((done) => server.close(() => done(undefined)));
      removePortFile(portFile, boundPort);
      state.db.close();
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
  const app = await startServer();
  process.stdout.write(`Hearsay v${VERSION} listening on http://${app.config.host}:${app.port}\n`);
  const guidance = startupGuidance(app.config);
  if (guidance) process.stdout.write(`${guidance}\n`);
}
