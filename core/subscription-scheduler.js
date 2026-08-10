/**
 * Durable local-time scheduler for subscription-agent runs.
 *
 * The existing API scheduler intentionally keeps its simple daily semantics. This
 * module owns the stricter subscription contract: an IANA timezone, a durable
 * local-date occurrence identity, an explicit allowance-consent version, a target
 * ceiling, and a grace window that distinguishes a late/missed occurrence from an
 * attempted but failed run.
 */
import { createHash } from 'node:crypto';

import { get, isoNow, run, SETTING_KEYS, setSetting } from './db.js';
import { AGENT_SURFACES } from './subscription-model.js';
import { subscriptionPreview } from './subscription-runner.js';
import { recoverStaleRuns } from './runner.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

export const SCHEDULE_CONSENT_VERSION = 'subscription-schedule-v1';
export const DEFAULT_SUBSCRIPTION_GRACE_MINUTES = 10;
export const SUBSCRIPTION_SCHEDULE_KEY = 'subscription-agent';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const STABLE_SCHEDULE_ERROR_CODES = new Set([
  'executable_missing',
  'unsupported_cli_version',
  'authentication_missing',
  'process_start_failed',
  'timeout',
  'output_limit',
  'event_parse_failed',
  'rate_limited',
  'quota_exhausted',
  'nonzero_exit',
  'abandoned',
  'schedule_budget_exceeded',
  'schedule_configuration_invalid',
]);

/** @param {unknown} error @returns {string} */
function stableScheduleErrorCode(error) {
  const candidate = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (STABLE_SCHEDULE_ERROR_CODES.has(candidate)) return candidate;
  if (error instanceof Error && /budget|ceiling/i.test(error.message)) return 'schedule_budget_exceeded';
  return 'execution_failed';
}

/** @typedef {'tracking'|'exploration'} ScheduleLane */
/**
 * @typedef {Object} SubscriptionSchedule
 * @property {string} scheduleKey
 * @property {boolean} enabled
 * @property {string} runAt local HH:MM
 * @property {string} timeZone IANA timezone
 * @property {string[]} surfaces
 * @property {ScheduleLane} lane
 * @property {number[]} promptIds empty means the current lane's prompt set
 * @property {number} samples
 * @property {number} targetCeiling
 * @property {number} graceMinutes
 * @property {string} consentVersion
 * @property {string} consentedAt UTC ISO
 * @property {string} createdAt UTC ISO
 * @property {string} revisionHash
 */

export class SubscriptionScheduleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SubscriptionScheduleError';
  }
}

/** @param {string} value */
function assertTimeZone(value) {
  const timeZone = String(value ?? '').trim();
  if (timeZone === '') throw new SubscriptionScheduleError('timeZone is required');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format();
  } catch {
    throw new SubscriptionScheduleError('timeZone must be a valid IANA timezone');
  }
  return timeZone;
}

/** @param {string} value */
function assertRunAt(value) {
  const runAt = String(value ?? '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(runAt)) {
    throw new SubscriptionScheduleError('runAt must be local HH:MM');
  }
  return runAt;
}

/** @param {string} date @param {string} runAt @param {string} timeZone */
function requestedLocalParts(date, runAt, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SubscriptionScheduleError('occurrence date must be YYYY-MM-DD');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = runAt.split(':').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new SubscriptionScheduleError('occurrence date is invalid');
  }
  assertTimeZone(timeZone);
  return { year, month, day, hour, minute };
}

/** @param {string} timeZone */
function formatter(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** @param {Date} date @param {string} timeZone */
function zonedParts(date, timeZone) {
  const values = Object.fromEntries(formatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

/** @param {Date} date @param {string} timeZone @returns {string} */
export function localDateInZone(date, timeZone) {
  const parts = zonedParts(date, assertTimeZone(timeZone));
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** @param {Date} date @param {string} timeZone @returns {string} */
function localHmInZone(date, timeZone) {
  const parts = zonedParts(date, assertTimeZone(timeZone));
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/**
 * Resolve a local wall-clock time without relying on the host machine timezone.
 * Repeated fall-back times choose the earliest instant, so a local-date occurrence
 * remains one run. A skipped spring-forward time chooses the first representable
 * minute after the requested time on that date.
 *
 * @param {string} date
 * @param {string} runAt
 * @param {string} timeZone
 * @returns {Date}
 */
export function scheduledInstantForLocalDate(date, runAt, timeZone) {
  const wanted = requestedLocalParts(date, assertRunAt(runAt), assertTimeZone(timeZone));
  const base = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const matches = [];
  for (let offset = -36 * 60; offset <= 36 * 60; offset += 1) {
    const candidate = new Date(base + offset * MINUTE_MS);
    const parts = zonedParts(candidate, timeZone);
    if (
      parts.year === wanted.year &&
      parts.month === wanted.month &&
      parts.day === wanted.day &&
      parts.hour === wanted.hour &&
      parts.minute === wanted.minute
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length > 0) return matches[0];

  // A nonexistent spring-forward wall time has no exact match. Resolve to the
  // first later representable minute on the same local date, which preserves one
  // scheduled occurrence instead of silently replaying it on another date.
  for (let offset = -36 * 60; offset <= 36 * 60; offset += 1) {
    const candidate = new Date(base + offset * MINUTE_MS);
    const parts = zonedParts(candidate, timeZone);
    if (
      parts.year === wanted.year &&
      parts.month === wanted.month &&
      parts.day === wanted.day &&
      (parts.hour > wanted.hour || (parts.hour === wanted.hour && parts.minute > wanted.minute))
    ) {
      return candidate;
    }
  }
  throw new SubscriptionScheduleError('runAt cannot be represented in timeZone');
}

/** @param {string} date @param {number} deltaDays @returns {string} */
function shiftLocalDate(date, deltaDays) {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** @param {string} a @param {string} b @returns {number} */
function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {SubscriptionSchedule} schedule */
function revisionInput(schedule) {
  return {
    runAt: schedule.runAt,
    timeZone: schedule.timeZone,
    surfaces: [...schedule.surfaces].sort(),
    lane: schedule.lane,
    promptIds: [...schedule.promptIds].sort((a, b) => a - b),
    samples: schedule.samples,
    targetCeiling: schedule.targetCeiling,
    graceMinutes: schedule.graceMinutes,
  };
}

/** @param {SubscriptionSchedule} schedule @returns {string} */
export function scheduleRevisionHash(schedule) {
  return createHash('sha256').update(JSON.stringify(revisionInput(schedule))).digest('hex');
}

/**
 * @param {Db} db
 * @param {{runAt:string,timeZone:string,surfaces:string[],lane?:ScheduleLane,promptIds?:number[],samples?:number,targetCeiling:number,graceMinutes?:number,consentVersion:string,now?:Date}} input
 * @returns {SubscriptionSchedule}
 */
export function saveSubscriptionSchedule(db, input) {
  const runAt = assertRunAt(input.runAt);
  const timeZone = assertTimeZone(input.timeZone);
  const surfaces = [...new Set((input.surfaces ?? []).map(String))];
  if (surfaces.length === 0 || surfaces.some((surface) => !(/** @type {readonly string[]} */ (AGENT_SURFACES)).includes(surface))) {
    throw new SubscriptionScheduleError(`surfaces must contain only: ${AGENT_SURFACES.join(', ')}`);
  }
  const lane = input.lane ?? 'tracking';
  if (lane !== 'tracking' && lane !== 'exploration') throw new SubscriptionScheduleError('lane must be tracking or exploration');
  const promptIds = [...new Set((input.promptIds ?? []).map(Number))];
  if (promptIds.some((id) => !Number.isInteger(id) || id <= 0)) throw new SubscriptionScheduleError('promptIds must contain positive integers');
  const samples = Number(input.samples ?? 1);
  if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new SubscriptionScheduleError('samples must be an integer between 1 and 10');
  const targetCeiling = Number(input.targetCeiling);
  if (!Number.isInteger(targetCeiling) || targetCeiling < 1) throw new SubscriptionScheduleError('targetCeiling must be a positive integer');
  const graceMinutes = Number(input.graceMinutes ?? DEFAULT_SUBSCRIPTION_GRACE_MINUTES);
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 1440) throw new SubscriptionScheduleError('graceMinutes must be an integer between 0 and 1440');
  if (input.consentVersion !== SCHEDULE_CONSENT_VERSION) throw new SubscriptionScheduleError('A current subscription schedule consent is required');
  const now = input.now ?? new Date();
  const existing = getSubscriptionSchedule(db);
  /** @type {SubscriptionSchedule} */
  const schedule = {
    scheduleKey: SUBSCRIPTION_SCHEDULE_KEY,
    enabled: true,
    runAt,
    timeZone,
    surfaces,
    lane,
    promptIds,
    samples,
    targetCeiling,
    graceMinutes,
    consentVersion: SCHEDULE_CONSENT_VERSION,
    consentedAt: isoNow(now),
    createdAt: existing?.createdAt ?? isoNow(now),
    revisionHash: '',
  };
  schedule.revisionHash = scheduleRevisionHash(schedule);
  setSetting(db, SETTING_KEYS.SUBSCRIPTION_SCHEDULE, schedule);
  return schedule;
}

/** @param {Db} db @returns {SubscriptionSchedule|null} */
export function getSubscriptionSchedule(db) {
  const row = get(db, 'SELECT value FROM settings WHERE key = ?', [SETTING_KEYS.SUBSCRIPTION_SCHEDULE]);
  if (!row || typeof row.value !== 'string') return null;
  try {
    const value = JSON.parse(row.value);
    if (!value || typeof value !== 'object' || value.enabled !== true) return null;
    const schedule = /** @type {SubscriptionSchedule} */ (value);
    if (schedule.scheduleKey !== SUBSCRIPTION_SCHEDULE_KEY) return null;
    assertRunAt(schedule.runAt);
    assertTimeZone(schedule.timeZone);
    return schedule;
  } catch {
    return null;
  }
}

/** @param {Db} db */
export function disableSubscriptionSchedule(db) {
  const existing = getSubscriptionSchedule(db);
  if (!existing) return false;
  setSetting(db, SETTING_KEYS.SUBSCRIPTION_SCHEDULE, { ...existing, enabled: false });
  return true;
}

/** @param {Db} db @param {string} scheduleKey @param {string} occurrenceDate */
function hasOccurrence(db, scheduleKey, occurrenceDate) {
  return Boolean(get(db, 'SELECT 1 AS hit FROM runs WHERE schedule_key = ? AND occurrence_local_date = ? LIMIT 1', [scheduleKey, occurrenceDate]));
}

/**
 * Insert a durable occurrence claim. The v3 partial unique index makes this safe
 * across two Hearsay processes racing on the same local date.
 *
 * @param {Db} db
 * @param {SubscriptionSchedule} schedule
 * @param {{occurrenceDate:string,status:'running'|'missed'|'failed',scheduledFor:string,startedAt:string,totalCalls:number,error?:string}} input
 * @returns {number|null}
 */
function claimOccurrence(db, schedule, input) {
  try {
    const sql = input.status === 'running'
      ? `INSERT INTO runs(
          started_at, finished_at, trigger, status, total_calls, done_calls, error,
          schedule_key, schedule_revision_hash, scheduled_for, occurrence_local_date, target_ceiling
        )
        SELECT ?, ?, 'cron', ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM runs WHERE status = 'running')`
      : `INSERT INTO runs(
          started_at, finished_at, trigger, status, total_calls, done_calls, error,
          schedule_key, schedule_revision_hash, scheduled_for, occurrence_local_date, target_ceiling
        ) VALUES(?, ?, 'cron', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const result = run(db, sql, [
      input.startedAt,
      input.status === 'running' ? null : input.startedAt,
      input.status,
      input.totalCalls,
      input.status === 'running' ? 0 : input.totalCalls,
      input.error ?? null,
      schedule.scheduleKey,
      schedule.revisionHash,
      input.scheduledFor,
      input.occurrenceDate,
      schedule.targetCeiling,
    ]);
    return result.changes === 0 ? null : result.lastInsertRowid;
  } catch (error) {
    if (error instanceof Error && /unique|constraint/i.test(error.message)) return null;
    throw error;
  }
}

/**
 * Process all not-yet-recorded local dates from schedule creation through today.
 * A missed date is recorded without replay; a due date is claimed before the
 * injected runner is called. The preview and runner are injectable for deterministic
 * tests and for future local-worker deployments.
 *
 * @param {{db:Db,config:Record<string,unknown>,now?:Date,preview?:Function,runSubscription?:Function,log?:(message:string)=>void}} options
 * @returns {Promise<boolean>}
 */
export async function subscriptionScheduleTick(options) {
  const schedule = getSubscriptionSchedule(options.db);
  if (!schedule || options.config.demo === true) return false;
  const now = options.now ?? new Date();
  recoverStaleRuns(options.db, { now });
  const today = localDateInZone(now, schedule.timeZone);
  const createdAt = new Date(schedule.createdAt);
  const createdDate = localDateInZone(createdAt, schedule.timeZone);
  const latest = get(options.db, 'SELECT MAX(occurrence_local_date) AS occurrence FROM runs WHERE schedule_key = ?', [schedule.scheduleKey]);
  let date = latest?.occurrence ? shiftLocalDate(String(latest.occurrence), 1) : createdDate;
  let changed = false;
  const previewFn = options.preview ?? subscriptionPreview;
  const runFn = options.runSubscription ?? (async () => {});
  let guard = 0;
  while (compareDates(date, today) <= 0 && guard < 370) {
    guard += 1;
    const scheduledAt = scheduledInstantForLocalDate(date, schedule.runAt, schedule.timeZone);
    date = shiftLocalDate(date, 1);
    // Do not invent an occurrence for the date on which the schedule was created
    // if its scheduled instant had already passed before explicit consent.
    if (scheduledAt.getTime() < createdAt.getTime()) continue;
    if (hasOccurrence(options.db, schedule.scheduleKey, localDateInZone(scheduledAt, schedule.timeZone))) continue;
    const occurrenceDate = localDateInZone(scheduledAt, schedule.timeZone);
    const scheduledFor = isoNow(scheduledAt);
    const graceEnds = scheduledAt.getTime() + schedule.graceMinutes * MINUTE_MS;
    if (now.getTime() > graceEnds) {
      const missed = claimOccurrence(options.db, schedule, {
        occurrenceDate,
        scheduledFor,
        startedAt: isoNow(now),
        status: 'missed',
        totalCalls: 0,
        error: 'subscription:missed_occurrence',
      });
      changed ||= missed !== null;
      continue;
    }
    if (now.getTime() < scheduledAt.getTime()) continue;

    // Do not even preview or claim an occurrence while the API lane or another
    // subscription lane owns a live run. The conditional INSERT below closes the
    // race between this read and a concurrent process starting a run.
    if (get(options.db, "SELECT 1 AS hit FROM runs WHERE status = 'running' LIMIT 1")) return changed;

    let preview;
    try {
      preview = previewFn({
        db: options.db,
        config: options.config,
        surfaces: schedule.surfaces,
        lane: schedule.lane,
        promptIds: schedule.promptIds,
        samples: schedule.samples,
      });
    } catch (error) {
      const failed = claimOccurrence(options.db, schedule, {
        occurrenceDate,
        scheduledFor,
        startedAt: isoNow(now),
        status: 'failed',
        totalCalls: 0,
        error: error instanceof Error && /budget|ceiling/i.test(error.message)
          ? 'schedule_budget_exceeded'
          : 'schedule_configuration_invalid',
      });
      changed ||= failed !== null;
      continue;
    }
    if (Number(preview.totalTargets ?? 0) > schedule.targetCeiling) {
      const failed = claimOccurrence(options.db, schedule, {
        occurrenceDate,
        scheduledFor,
        startedAt: isoNow(now),
        status: 'failed',
        totalCalls: 0,
        error: 'schedule_budget_exceeded',
      });
      changed ||= failed !== null;
      continue;
    }
    const runId = claimOccurrence(options.db, schedule, {
      occurrenceDate,
      scheduledFor,
      startedAt: isoNow(now),
      status: 'running',
      totalCalls: Number(preview.totalTargets ?? 0),
    });
    if (runId === null) continue;
    changed = true;
    try {
      await runFn({
        db: options.db,
        config: options.config,
        surfaces: schedule.surfaces,
        lane: schedule.lane,
        promptIds: schedule.promptIds,
        samples: schedule.samples,
        targetCeiling: schedule.targetCeiling,
        confirm: true,
        trigger: 'cron',
        existingRunId: runId,
        scheduleKey: schedule.scheduleKey,
        scheduleRevisionHash: schedule.revisionHash,
        scheduledFor,
        occurrenceLocalDate: occurrenceDate,
      });
    } catch (error) {
      const code = stableScheduleErrorCode(error);
      run(options.db, "UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'", [isoNow(now), `subscription:${code}`, runId]);
      options.log?.(`hearsay: subscription schedule ${schedule.scheduleKey} failed: ${code}`);
    }
  }
  return changed;
}

// Kept private but exercised indirectly by the tick; this export makes the exact
// local-time behavior available to the settings/API lane without duplicating it.
export { localHmInZone };
