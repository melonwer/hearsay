import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { localDateInZone, scheduledInstantForLocalDate } from './subscription-scheduler.js';
import { researchHash, ResearchError, validateEvidence, sampleEligibility } from './research-contract.js';
import { previewResearchRun, runResearchPanel, readJson, writeJson } from './research-workspace.js';
/** @typedef {import('./research-contract.js').ResearchRecord} Record */

/** @param {string} directory @param {{timezone:string,at:string,targetCeiling:number,now?:Date,preview?:Awaited<ReturnType<typeof previewResearchRun>>}} options */
export async function previewResearchSchedule(directory, options) {
  if (!/^\d\d:\d\d$/.test(options.at)) throw new ResearchError('invalid_schedule', 'Use a daily HH:MM time');
  const now = options.now ?? new Date();
  const date = localDateInZone(now, options.timezone);
  scheduledInstantForLocalDate(date, options.at, options.timezone);
  const preview = options.preview ?? await previewResearchRun(directory);
  if (!preview.snapshot.panel.reviewedAt) throw new ResearchError('panel_review_required', 'Review and freeze the saved panel before scheduling');
  if (!Number.isSafeInteger(options.targetCeiling) || options.targetCeiling < preview.targetCount || options.targetCeiling > 1000) throw new ResearchError('target_limit', 'Target ceiling must cover this panel and remain at most 1,000');
  const schedule = { version: 1, timezone: options.timezone, at: options.at, targetCeiling: options.targetCeiling,
    runQuote: preview.quoteId, selectedRoutes: preview.project.selectedRoutes, project: resolve(directory), maxDurationMs: preview.maxDurationMs };
  return { ...schedule, quoteId: researchHash(schedule), targetCount: preview.targetCount, accountCost: null,
    cron: cronLine(directory), nativeScheduler: `Run ${repeatCommand(directory)} every minute. The saved schedule determines due occurrences.` };
}
/** @param {string} value */
function shellQuote(value) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
/** @param {string} directory */
export function repeatCommand(directory) {
  return [process.execPath, fileURLToPath(new URL('../bin/hearsay.js', import.meta.url)), 'schedule', 'tick', '--project', resolve(directory), '--json'].map(shellQuote).join(' ');
}
/** @param {string} directory */
export function cronLine(directory) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return null;
  if (/[\n\r%]/.test(directory + process.execPath)) throw new ResearchError('invalid_path', 'Cron paths cannot contain newline or percent characters');
  return `* * * * * ${repeatCommand(directory)} >> ${shellQuote(join(resolve(directory), 'schedule.log'))} 2>&1 # hearsay-${researchHash(resolve(directory)).slice(0, 16)}`;
}
/** @param {string} directory */
export function readResearchSchedule(directory) {
  const path = join(resolve(directory), 'schedule.json');
  return existsSync(path) ? readJson(path) : null;
}
/** @param {string} directory @param {Record} preview @param {string} confirm @param {{installCron?:boolean,now?:Date}} [options] */
export function enableResearchSchedule(directory, preview, confirm, options = {}) {
  if (confirm !== preview.quoteId) throw new ResearchError('consent_required', 'Confirm the exact schedule quote');
  const consentPath = join(resolve(directory), 'consent.json');
  const consent = existsSync(consentPath) ? readJson(consentPath) : null;
  if (consent?.quoteId !== preview.runQuote) throw new ResearchError('consent_required', 'Confirm and execute the selected on-demand panel first');
  const runs = join(resolve(directory), 'runs');
  const successfulRoutes = new Set();
  for (const id of existsSync(runs) ? readdirSync(runs) : []) {
    try {
      const bundle = validateEvidence(readJson(join(runs, id, 'evidence.json')));
      const receipt = readJson(join(runs, id, 'execution-receipt.json'));
      if (receipt.quoteId !== preview.runQuote || receipt.evidenceHash !== researchHash(bundle)) continue;
      if (bundle.samples.some((/** @type {Record} */ sample) => /auth|quota|rate_limit/.test(sample.errorCode ?? ''))) continue;
      for (const sample of bundle.samples) if (sampleEligibility(bundle, sample).eligible) successfulRoutes.add(sample.routeId);
    } catch {}
  }
  if (preview.selectedRoutes.some((/** @type {string} */ id) => !successfulRoutes.has(id))) throw new ResearchError('prior_run_required', 'Complete a search-verified on-demand trial under the current quote for every selected route before scheduling');
  const schedule = { ...preview, enabled: true, enabledAt: (options.now ?? new Date()).toISOString(), installedCron: options.installCron === true };
  if (options.installCron) updateCron(directory, true);
  writeJson(join(resolve(directory), 'schedule.json'), schedule);
  return schedule;
}
/** @param {string} directory */
export function disableResearchSchedule(directory) {
  const schedule = readResearchSchedule(directory);
  if (!schedule) return { enabled: false };
  writeJson(join(resolve(directory), 'schedule.json'), { ...schedule, enabled: false });
  if (schedule.installedCron) updateCron(directory, false);
  return { enabled: false };
}
/** @param {string} directory @param {boolean} enable */
function updateCron(directory, enable) {
  const line = cronLine(directory);
  if (!line) throw new ResearchError('scheduler_unavailable', 'Use a native scheduler or manual repeats on this platform');
  let existing = '';
  try { existing = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (!/no crontab/i.test(String(/** @type {Record} */ (error).stderr))) throw new ResearchError('scheduler_unavailable', 'Cannot inspect current crontab'); }
  const marker = line.slice(line.indexOf('# hearsay-'));
  const next = existing.split('\n').filter((entry) => !entry.endsWith(marker));
  if (enable) next.push(line);
  writeFileSync(join(resolve(directory), `crontab-backup-${Date.now()}.txt`), existing, { mode: 0o600 });
  execFileSync('crontab', ['-'], { input: next.filter(Boolean).join('\n') + '\n' });
}

/** @param {string} date */
function nextDate(date) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }
/** @param {string} directory @param {{now?:Date,preview?:Awaited<ReturnType<typeof previewResearchRun>>,run?:(dir:string,options:any)=>Promise<any>}} [options] */
export async function researchScheduleTick(directory, options = {}) {
  const root = resolve(directory);
  const schedule = readResearchSchedule(root);
  if (!schedule?.enabled) return { status: 'disabled' };
  const now = options.now ?? new Date();
  const today = localDateInZone(now, schedule.timezone);
  const first = localDateInZone(new Date(schedule.enabledAt), schedule.timezone);
  const occurrenceRoot = join(root, 'occurrences', schedule.quoteId);
  mkdirSync(occurrenceRoot, { recursive: true, mode: 0o700 });
  /** @type {Record[]} */ const results = [];
  for (let date = first, count = 0; date <= today && count < 3660; date = nextDate(date), count++) {
    const due = scheduledInstantForLocalDate(date, schedule.at, schedule.timezone);
    if (due > now || due < new Date(schedule.enabledAt)) continue;
    const occurrence = join(occurrenceRoot, `${date}.json`);
    try { writeFileSync(occurrence, JSON.stringify({ date, status: 'claimed', claimedAt: now.toISOString(), pid: process.pid, hostname: hostname(), expiresAt: new Date(now.getTime() + schedule.maxDurationMs + 30_000).toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      const prior = readJson(occurrence);
      if (prior.status === 'claimed' && now.getTime() > Date.parse(prior.expiresAt ?? prior.claimedAt) + (prior.expiresAt ? 0 : schedule.maxDurationMs + 30_000)) {
        let alive = Boolean(prior.hostname && prior.hostname !== hostname());
        if (!alive && prior.pid) { try { process.kill(prior.pid, 0); alive = true; } catch {} }
        if (!alive) { const missed = { ...prior, status: 'missed', reason: 'interrupted_occurrence_no_catch_up' }; writeJson(occurrence, missed); results.push(missed); }
      }
      continue;
    }
    /** @type {Record} */ let result = { date, due: due.toISOString(), status: 'missed' };
    if (now.getTime() - due.getTime() <= 5 * 60_000) {
      try {
        const preview = options.preview ?? await previewResearchRun(root);
        if (preview.quoteId !== schedule.runQuote || preview.targetCount > schedule.targetCeiling || JSON.stringify(preview.project.selectedRoutes) !== JSON.stringify(schedule.selectedRoutes)) {
          throw new ResearchError('schedule_changed', 'Panel, route selection, executable version or budget changed; review a new schedule quote');
        }
        const outcome = await (options.run ?? runResearchPanel)(root, { execute: true, preview });
        result = { ...result, status: outcome.evidence?.samples.some((/** @type {Record} */ s) => s.status !== 'completed') ? 'partial' : 'completed', runId: outcome.runId };
        if (outcome.evidence?.samples.some((/** @type {Record} */ s) => /auth|quota|rate_limit/.test(s.errorCode ?? ''))) {
          writeJson(join(root, 'schedule.json'), { ...schedule, enabled: false, stoppedReason: 'authentication_or_quota_failure' });
          result.status = 'stopped';
        }
      } catch (error) {
        result = { ...result, status: 'failed', errorCode: /** @type {Record} */ (error).code ?? 'schedule_failed' };
        if (/auth|quota|rate_limit|schedule_changed/.test(result.errorCode)) writeJson(join(root, 'schedule.json'), { ...schedule, enabled: false, stoppedReason: result.errorCode });
      }
    }
    writeJson(occurrence, result); results.push(result);
  }
  return { status: 'checked', occurrences: results };
}
