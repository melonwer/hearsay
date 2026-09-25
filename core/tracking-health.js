import { all, get } from './db.js';
import { subscriptionExecutionBudget } from './execution-budget.js';
import { stableIdentity } from './measurement-contract.js';
import { getSubscriptionSchedule, localDateInZone, scheduledInstantForLocalDate } from './subscription-scheduler.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./config.js').Config} Config */

const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} date @param {number} days */
function shiftDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** @param {Date} now @param {string} runAt */
function nextApiOccurrence(now, runAt) {
  const [hour, minute] = runAt.split(':').map(Number);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** @param {Date} now @param {NonNullable<ReturnType<typeof getSubscriptionSchedule>>} schedule */
function nextSubscriptionOccurrence(now, schedule) {
  const today = localDateInZone(now, schedule.timeZone);
  const candidate = scheduledInstantForLocalDate(today, schedule.runAt, schedule.timeZone);
  return (candidate.getTime() > now.getTime()
    ? candidate
    : scheduledInstantForLocalDate(shiftDate(today, 1), schedule.runAt, schedule.timeZone)).toISOString();
}

/** @param {Db} db @param {'api'|'subscription'} kind */
function lastObservation(db, kind) {
  const condition = kind === 'api' ? "r.surface LIKE '%-api'" : "r.surface IN ('codex-agent','claude-code-agent')";
  const row = get(db, `SELECT MAX(r.created_at) AS observed_at
    FROM responses r JOIN runs ru ON ru.id = r.run_id
    WHERE ${condition} AND r.lane = 'tracking' AND r.target_status = 'completed'
      AND r.comparability_status = 'comparable' AND r.error IS NULL
      AND r.text IS NOT NULL AND trim(r.text) <> ''
      AND (r.answer_status IS NULL OR r.answer_status = 'complete')
      AND (r.surface NOT IN ('codex-agent','claude-code-agent') OR r.web_status = 'verified')
      AND (r.search_policy IS NULL OR r.search_policy <> 'required' OR r.web_status = 'verified')
      AND ru.status IN ('done','partial')`);
  return row?.observed_at ? String(row.observed_at) : null;
}

/** @param {Db} db @param {'api'|'subscription'} kind */
function recentIssues(db, kind) {
  const condition = kind === 'api'
    ? "schedule_key = 'api-panel' OR (schedule_key IS NULL AND trigger = 'cron')"
    : "schedule_key = 'subscription-agent'";
  return all(db, `SELECT id,status,COALESCE(scheduled_for,started_at) AS occurred_at
    FROM runs WHERE (${condition}) AND status IN ('missed','failed')
    ORDER BY id DESC LIMIT 5`).map((row) => ({
    runId: Number(row.id), status: String(row.status), occurredAt: String(row.occurred_at),
  }));
}

/** @param {string|null} lastObservationAt @param {ReturnType<typeof recentIssues>} issues @param {Date} now */
function freshness(lastObservationAt, issues, now) {
  const observationMs = lastObservationAt === null ? NaN : Date.parse(lastObservationAt);
  const issueAfterObservation = issues.some((issue) =>
    !Number.isFinite(observationMs) || Date.parse(issue.occurredAt) > observationMs);
  const old = Number.isFinite(observationMs) && now.getTime() - observationMs > 2 * DAY_MS;
  return {
    stale: issueAfterObservation || old,
    guidance: issueAfterObservation
      ? 'A scheduled run was missed or failed. Data may be stale. Check the service and run history; missed runs are not replayed.'
      : old
        ? 'The last successful observation is over two days old. Check that the service and schedule are running.'
        : lastObservationAt === null
          ? 'No successful observation yet. Complete a reviewed on-demand run to establish a baseline.'
          : null,
  };
}

/**
 * Read-only health for the two independent tracking schedules. The clock is passed
 * in so the API and both pages report the same instant in tests.
 * @param {{db:Db,config:Config,now?:Date}} input
 */
export function trackingHealth({ db, config, now = new Date() }) {
  const apiEnabled = !config.demo && config.enabledProviders.length > 0;
  const schedule = getSubscriptionSchedule(db);
  const subscriptionEnabled = !config.demo && schedule !== null && config.subscriptionSurfaces.length > 0;
  const surfacesAvailable = schedule === null || schedule.surfaces.every((surface) => config.subscriptionSurfaces.includes(
      /** @type {'codex-agent'|'claude-code-agent'} */ (surface)));
  const subscriptionIssues = recentIssues(db, 'subscription');
  const apiIssues = recentIssues(db, 'api');
  const apiLast = lastObservation(db, 'api');
  const subscriptionLast = lastObservation(db, 'subscription');
  const profileCurrent = schedule === null || schedule.executionBudgetHash !== null &&
    stableIdentity(schedule.surfaces.map((surface) => subscriptionExecutionBudget(config,
      /** @type {'codex-agent'|'claude-code-agent'} */ (surface)))) === schedule.executionBudgetHash;
  const apiFreshness = freshness(apiLast, apiIssues, now);
  const subscriptionFreshness = freshness(subscriptionLast, subscriptionIssues, now);
  const demoGuidance = 'Demo measurements are examples. Live providers and schedules are disabled in demo mode.';
  return {
    api: {
      enabled: apiEnabled,
      runAt: config.runAt,
      timeZone: 'server local time',
      nextScheduledAt: apiEnabled ? nextApiOccurrence(now, config.runAt) : null,
      lastSuccessfulObservationAt: apiLast,
      recentIssues: apiIssues,
      ...apiFreshness,
      stale: config.demo ? false : apiFreshness.stale,
      guidance: config.demo ? demoGuidance : apiFreshness.guidance,
    },
    subscription: {
      enabled: subscriptionEnabled,
      ready: subscriptionEnabled && profileCurrent && surfacesAvailable,
      configured: schedule !== null,
      runAt: schedule?.runAt ?? null,
      timeZone: schedule?.timeZone ?? null,
      nextScheduledAt: subscriptionEnabled && schedule
        ? nextSubscriptionOccurrence(now, schedule) : null,
      lastSuccessfulObservationAt: subscriptionLast,
      recentIssues: subscriptionIssues,
      consentCurrent: profileCurrent,
      ...subscriptionFreshness,
      stale: config.demo ? false : subscriptionFreshness.stale,
      guidance: config.demo ? demoGuidance : !profileCurrent
        ? 'The subscription consent cannot be verified for the current execution profile. Review and confirm a new schedule before scheduled allowance use.'
        : !surfacesAvailable && schedule && !config.demo
          ? 'A scheduled subscription surface is disabled. Enable it or review the schedule.'
          : subscriptionFreshness.guidance,
    },
  };
}
