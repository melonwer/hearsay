/**
 * Daily-time scheduler (§8.2).
 *
 * A one-minute interval, not a cron parser: once local wall-clock time has passed
 * `config.runAt` and `settings.last_scheduled_run_date` is not today's local date, fire
 * one panel run with trigger `cron` and record the date. A restart after the day's
 * scheduled time records a missed occurrence without starting a paid catch-up run.
 *
 * Dates: `runAt` and the run-date bookkeeping are **local** time, because "run at 07:00"
 * means the operator's 07:00. Everything written to the database stays UTC ISO-8601
 * (§19.6 #5); the local date lives only in that one settings key.
 *
 * Nothing here throws into the interval — a failed run is logged and retried tomorrow.
 */

import { config as processConfig } from './config.js';
import { SETTING_KEYS, get, getSetting, isoNow, run, setSetting } from './db.js';
import { runPanel as defaultRunPanel } from './runner.js';
import { runSubscriptionPanel as defaultRunSubscriptionPanel } from './subscription-runner.js';
import { getSubscriptionSchedule, subscriptionScheduleTick } from './subscription-scheduler.js';
import { apiSearchScheduleApproved, hasEnabledApiSearch } from './api-search-schedule.js';

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
 * @param {(opts: {db: Db, trigger: 'cron', config?:Config}) => Promise<unknown>} [options.runPanel]
 * @param {(opts: Record<string, unknown>) => Promise<unknown>} [options.runSubscription]
 * @param {() => Date} [options.now]
 * @param {number} [options.intervalMs]
 * @param {(message: string) => void} [options.log]
 * @returns {Scheduler}
 */
export function startScheduler(options) {
  const {
    db,
    config = processConfig,
    runPanel = (opts) => defaultRunPanel({ ...opts, config: opts.config ?? config }),
    runSubscription = (opts) => defaultRunSubscriptionPanel({ ...(/** @type {*} */ (opts)), config }),
    now = () => new Date(),
    intervalMs = TICK_MS,
    log = (message) => process.stderr.write(`${message}\n`),
  } = options;

  const apiEnabled = !config.demo && config.enabledProviders.length > 0;
  const subscriptionCapable = !config.demo && config.subscriptionSurfaces.length > 0;
  // Demo mode and installs without any available provider keep no scheduler timer.
  // A subscription-only install checks for consent each tick so saving a schedule
  // after startup does not require a restart.
  if (!apiEnabled && !subscriptionCapable) {
    return { enabled: false, tick: async () => false, stop: () => {} };
  }

  if (apiEnabled) {
    // A prior run date may be several days old after downtime. Claim today's missed
    // occurrence before any tick so restarting never spends API credit to catch up.
    const bootedAt = now();
    const today = localDate(bootedAt);
    const previousRunDate = getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, /** @type {string|null} */ (null));
    if (previousRunDate !== today && localHm(bootedAt) >= config.runAt) {
      const [hour, minute] = config.runAt.split(':').map(Number);
      const scheduledFor = new Date(bootedAt.getFullYear(), bootedAt.getMonth(), bootedAt.getDate(), hour, minute);
      if (previousRunDate !== null) {
        run(db, `INSERT OR IGNORE INTO runs(started_at,finished_at,trigger,status,total_calls,done_calls,error,
          schedule_key,scheduled_for,occurrence_local_date)
          VALUES(?,?,'cron','missed',0,0,'api:missed_occurrence','api-panel',?,?)`,
        [isoNow(bootedAt), isoNow(bootedAt), isoNow(scheduledFor), today]);
      }
      setSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, today);
    }
  }

  let busy = false;
  let subscriptionBusy = false;

  /** @returns {Promise<boolean>} */
  async function tick() {
    let started = false;
    if (apiEnabled && !busy) {
      const at = now();
      const lastRunDate = getSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, /** @type {string|null} */ (null));
      if (shouldRun({ now: at, runAt: config.runAt, lastRunDate })) {
        busy = true;
        // Claim the day before running, not after: a run that crashes half way should not be
        // retried in 60 seconds, and a run that takes an hour should not start twice.
        setSetting(db, SETTING_KEYS.LAST_SCHEDULED_RUN_DATE, localDate(at));
        const previousRunId = Number(get(db, 'SELECT COALESCE(MAX(id), 0) AS id FROM runs')?.id ?? 0);
        try {
          const cronConfig = !hasEnabledApiSearch(config) || apiSearchScheduleApproved(db, config) ? config : {
            ...config, apiSearchPolicies: { ...config.apiSearchPolicies,
              openai: /** @type {const} */ ('off'), anthropic: /** @type {const} */ ('off') },
          };
          await runPanel(cronConfig === config ? { db, trigger: 'cron' } : { db, trigger: 'cron', config: cronConfig });
          started = true;
        } catch (err) {
          if (!get(db, "SELECT id FROM runs WHERE id > ? AND trigger = 'cron' LIMIT 1", [previousRunId])) {
            const [hour, minute] = config.runAt.split(':').map(Number);
            const scheduledFor = new Date(at.getFullYear(), at.getMonth(), at.getDate(), hour, minute);
            run(db, `INSERT OR IGNORE INTO runs(started_at,finished_at,trigger,status,total_calls,done_calls,error,
              schedule_key,scheduled_for,occurrence_local_date)
              VALUES(?,?,'cron','failed',0,0,'api:scheduled_preflight_failed','api-panel',?,?)`,
            [isoNow(at), isoNow(at), isoNow(scheduledFor), localDate(at)]);
          }
          log(`hearsay: scheduled run failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          busy = false;
        }
      }
    }
    if (subscriptionCapable && getSubscriptionSchedule(db) !== null && !subscriptionBusy) {
      subscriptionBusy = true;
      try {
        const changed = await subscriptionScheduleTick({ db, config, now: now(), runSubscription, log });
        started ||= changed;
      } catch (err) {
        log(`hearsay: subscription scheduler failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        subscriptionBusy = false;
      }
    }
    return started;
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Never hold the process open on the scheduler's account; the HTTP server does that.
  timer.unref?.();
  // A subscription schedule must inspect the current and prior local dates at boot so
  // an offline machine records a missed occurrence instead of silently replaying it.
  if (subscriptionCapable && getSubscriptionSchedule(db) !== null) void tick();

  return {
    enabled: true,
    tick,
    stop: () => clearInterval(timer),
  };
}
