/**
 * Daily-time scheduler (§8.2).
 *
 * A one-minute interval, not a cron parser: once local wall-clock time has passed
 * `config.runAt` and `settings.last_scheduled_run_date` is not today's local date, fire
 * one panel run with trigger `cron` and record the date. Deliberately naive and readable
 * — recovery after downtime falls out of it (miss 07:00 because the box was off, run at
 * boot instead), and it costs nothing on a machine that is asleep at the scheduled time.
 *
 * Dates: `runAt` and the run-date bookkeeping are **local** time, because "run at 07:00"
 * means the operator's 07:00. Everything written to the database stays UTC ISO-8601
 * (§19.6 #5); the local date lives only in that one settings key.
 *
 * Nothing here throws into the interval — a failed run is logged and retried tomorrow.
 */

import { config as processConfig } from './config.js';
import { SETTING_KEYS, getSetting, setSetting } from './db.js';
import { runPanel as defaultRunPanel } from './runner.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./config.js').Config} Config */

/** How often we check the clock. One minute is finer than the HH:MM resolution we need. */
export const TICK_MS = 60_000;

/**
 * Local calendar date as `YYYY-MM-DD`. Not `toISOString()` — that would be UTC and would
 * roll the "have we run today" flag over at the wrong moment for most of the world.
 *
 * @param {Date} date
 * @returns {string}
 */
export function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Local wall-clock time as `HH:MM`, comparable lexicographically against `config.runAt`.
 *
 * @param {Date} date
 * @returns {string}
 */
export function localHm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Should this tick start a run?
 *
 * @param {Object} input
 * @param {Date} input.now
 * @param {string} input.runAt local `HH:MM`
 * @param {string|null} input.lastRunDate local `YYYY-MM-DD` of the last scheduled run
 * @returns {boolean}
 */
export function shouldRun({ now, runAt, lastRunDate }) {
  return localHm(now) >= runAt && lastRunDate !== localDate(now);
}

/**
 * @typedef {Object} Scheduler
 * @property {() => Promise<boolean>} tick run one check now; resolves true if a run started
 * @property {() => void} stop
 * @property {boolean} enabled false in demo mode
 */

/**
 * Start the daily scheduler.
 *
 * Demo mode disables it outright (§4.1): demo instances must never spend money.
 *
 * @param {Object} options
 * @param {Db} options.db
 * @param {Config} [options.config]
 * @param {(opts: {db: Db, trigger: 'cron'}) => Promise<unknown>} [options.runPanel]
 * @param {() => Date} [options.now]
 * @param {number} [options.intervalMs]
 * @param {(message: string) => void} [options.log]
 * @returns {Scheduler}
 */
export function startScheduler(options) {
  const {
    db,
    config = processConfig,
    runPanel = (opts) => defaultRunPanel({ ...opts, config }),
    now = () => new Date(),
    intervalMs = TICK_MS,
    log = (message) => process.stderr.write(`${message}\n`),
  } = options;

  if (config.demo) {
    return { enabled: false, tick: async () => false, stop: () => {} };
  }

  // Startup guard: if today's scheduled time has already passed when we boot and we have
  // no record for today, claim the day rather than firing immediately. Restarting the
  // server at 23:00 should not spend a panel run's worth of API credit on the spot; the
  // next run happens at tomorrow's `runAt`. Booting *before* runAt still runs today.
  const bootedAt = now();
  if (getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, null) === null && localHm(bootedAt) >= config.runAt) {
    setSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, localDate(bootedAt));
  }

  let busy = false;

  /** @returns {Promise<boolean>} */
  async function tick() {
    if (busy) return false;
    const at = now();
    const lastRunDate = getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, /** @type {string|null} */ (null));
    if (!shouldRun({ now: at, runAt: config.runAt, lastRunDate })) return false;

    busy = true;
    // Claim the day before running, not after: a run that crashes half way should not be
    // retried in 60 seconds, and a run that takes an hour should not start twice.
    setSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, localDate(at));
    try {
      await runPanel({ db, trigger: 'cron' });
      return true;
    } catch (err) {
      log(`hearsay: scheduled run failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Never hold the process open on the scheduler's account; the HTTP server does that.
  timer.unref?.();

  return {
    enabled: true,
    tick,
    stop: () => clearInterval(timer),
  };
}
