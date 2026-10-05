import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ResearchError, researchHash } from './research-contract.js';
import { readJson, writeJson } from './research-workspace.js';
import { loadStudy, previewStudy, appendStudyRecord, withStudyLock } from './study-workspace.js';
import { connectStudySchedule, studyScheduleTick } from './study-schedule.js';

/** @typedef {import('./research-contract.js').ResearchRecord} Record */
/** @param {string} text */
function quote(text) { return `'${text.replace(/'/g, `'"'"'`)}'`; }
/** @param {string} directory */
function statePath(directory) { return join(resolve(directory), 'plugin-schedule.json'); }
/** @param {Record} [options] */
function runtimeIdentity(options = {}) {
  const entry = resolve(options.runtimePath ?? fileURLToPath(new URL('../bin/hearsay.js', import.meta.url)));
  const node = resolve(options.nodePath ?? process.execPath);
  if (!existsSync(entry) || !existsSync(node)) throw new ResearchError('runtime_missing', 'The scheduled runtime moved or was removed; preview and reconnect the task');
  return { entry, node, hash: researchHash(readFileSync(entry, 'utf8')) };
}
/** @param {string[]} args @param {string} [input] */
function crontab(args, input) {
  try { return execFileSync('crontab', args, { encoding: 'utf8', input, timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) {
    if (args[0] === '-l' && /no crontab/i.test(String(/** @type {Record} */ (error).stderr))) return '';
    throw new ResearchError('scheduler_unavailable', 'Cannot inspect or change crontab; use a host task or manual collection');
  }
}

/** @param {string} directory @param {Record} [options] */
export function previewPluginSchedule(directory, options = {}) {
  const snapshot = loadStudy(directory);
  const plan = snapshot.plan;
  const runtime = runtimeIdentity(options);
  const kind = options.kind ?? 'cron';
  if (!['cron', 'host'].includes(kind)) throw new ResearchError('invalid_schedule', 'Scheduler kind must be cron or host');
  const study = resolve(directory);
  const accountDirectory = options.accountDirectory ? resolve(options.accountDirectory) : null;
  if (/[\r\n%]/.test(study + runtime.entry + runtime.node + (accountDirectory ?? ''))) throw new ResearchError('invalid_path', 'Scheduled paths cannot contain newlines or percent characters');
  const command = [runtime.node, runtime.entry, 'study', 'schedule-tick', '--study', study, ...(accountDirectory ? ['--account-directory', accountDirectory] : []), '--json'].map(quote).join(' ');
  const marker = `# hearsay-study-${researchHash(study).slice(0, 16)}`;
  const scope = { version: 1, kind, study, planQuote: previewStudy(directory).quoteId, runtime, accountDirectory,
    timezone: plan.collection.timezone, at: plan.collection.at, occurrences: plan.collection.occurrences, maxDays: plan.collection.maxDays,
    questions: plan.questions, routes: plan.research?.runPreview?.snapshot?.execution?.routes ?? [],
    targetCeiling: plan.research?.targetCount ?? 0, tavily: plan.tavily, command, marker,
    cron: kind === 'cron' ? `* * * * * ${command} >> ${quote(join(study, 'schedule.log'))} 2>&1 ${marker}` : null,
    analysis: kind === 'cron' ? 'due_after_collection' : 'host_task_required',
    instruction: `Resume the Hearsay study at ${study}. Read the approved plan and pending decisions. Run the due occurrence with the bundled study tick command. Analyze new receipts, save the analysis and local report, and recommend the next action. Respect approved questions, routes, limits and duration. Do not publish or send external messages without their applicable approval.`,
    credentialRequirements: plan.tavily.enabled ? ['TAVILY_API_KEY must be available in the scheduled process; cron does not inherit the interactive agent environment.'] : [],
  };
  return { ...scope, quoteId: researchHash(scope) };
}

/** @param {string} directory */
export function inspectPluginSchedule(directory) {
  const path = statePath(directory);
  if (!existsSync(path)) return { status: 'disabled', connected: false };
  const saved = readJson(path);
  if (!saved.enabled) return { ...saved, status: 'disabled', connected: false };
  try {
    const current = previewPluginSchedule(directory, { kind: saved.kind, runtimePath: saved.runtime.entry, nodePath: saved.runtime.node, accountDirectory: saved.accountDirectory });
    if (current.quoteId !== saved.quoteId || loadStudy(directory).manifest.approvalId !== saved.approvalId) {
      return { ...saved, status: 'repair_required', connected: false, reason: 'Study scope, runtime identity or approval changed; preview and reconnect the task' };
    }
    return { ...saved, status: 'connected', connected: true };
  } catch { return { ...saved, status: 'repair_required', connected: false, reason: 'The scheduled runtime is unavailable; preview and reconnect the task' }; }
}

/** @param {string} directory @param {string} confirm @param {Record} [options] */
export async function installPluginSchedule(directory, confirm, options = {}) {
  return withStudyLock(directory, async () => {
    const snapshot = loadStudy(directory);
    const preview = previewPluginSchedule(directory, options);
    const approval = snapshot.approvals.find((/** @type {Record} */ row) => row.id === snapshot.manifest.approvalId);
    if (!approval || approval.quoteId !== preview.planQuote || snapshot.manifest.status !== 'approved') throw new ResearchError('study_approval_required', 'Approve the exact current study before installing a schedule');
    if (confirm !== preview.quoteId || !options.author?.trim()) throw new ResearchError('consent_required', 'Confirm the exact scheduler preview and founder identity');
    if (preview.kind !== 'cron') throw new ResearchError('host_task_required', 'Install and verify the agent task through the host, then use study connect with its actual job receipt');
    if (!['linux', 'darwin'].includes(process.platform)) throw new ResearchError('scheduler_unavailable', 'Cron installation is supported on Linux and macOS; use a native task or manual repeats');
    const run = options.runCron ?? crontab;
    const previous = run(['-l']);
    const existing = inspectPluginSchedule(directory);
    if (existing.status === 'connected' && existing.quoteId === confirm && previous.split('\n').includes(preview.cron)) return existing;
    const backup = join(resolve(directory), `crontab-backup-${randomUUID()}.txt`);
    writeFileSync(backup, previous, { mode: 0o600, flag: 'wx' });
    const lines = previous.split('\n').filter((/** @type {string} */ line) => line && !line.endsWith(preview.marker));
    lines.push(preview.cron);
    run(['-'], lines.join('\n') + '\n');
    if (!run(['-l']).split('\n').includes(preview.cron)) throw new ResearchError('schedule_verification_failed', 'Installed cron job could not be verified; inspect the backup before retrying');
    const verifiedAt = (options.now ?? new Date()).toISOString();
    const saved = { ...preview, enabled: true, approvalId: approval.id, author: options.author, verifiedAt, backup };
    writeJson(statePath(directory), saved);
    await connectStudySchedule(directory, { kind: 'runtime', command: preview.command, receipt: { jobId: preview.marker, verifiedAt, scheduler: 'cron', runtime: preview.runtime }, now: options.now });
    return { ...saved, status: 'connected', connected: true };
  });
}

/** @param {string} directory @param {Record} [options] */
export async function removePluginSchedule(directory, options = {}) {
  return withStudyLock(directory, async () => {
    const path = statePath(directory);
    if (!existsSync(path)) return { status: 'disabled', connected: false };
    const saved = readJson(path);
    if (!saved.enabled) return { ...saved, status: 'disabled', connected: false };
    const run = options.runCron ?? crontab;
    const previous = run(['-l']);
    const backup = join(resolve(directory), `crontab-backup-${randomUUID()}.txt`);
    writeFileSync(backup, previous, { mode: 0o600, flag: 'wx' });
    run(['-'], previous.split('\n').filter((/** @type {string} */ line) => line && !line.endsWith(saved.marker)).join('\n') + '\n');
    if (run(['-l']).split('\n').some((/** @type {string} */ line) => line.endsWith(saved.marker))) throw new ResearchError('schedule_verification_failed', 'Cron removal could not be verified');
    writeJson(path, { ...saved, enabled: false, backup });
    await appendStudyRecord(directory, 'event', { type: 'schedule_disconnected', planId: saved.planQuote ? loadStudy(directory).plan.id : undefined, approvalId: saved.approvalId, reason: 'Founder disabled the cron collector' });
    return { status: 'disabled', connected: false, backup };
  });
}

/** @param {string} directory @param {Record} [options] */
export async function pluginScheduleTick(directory, options = {}) {
  const saved = inspectPluginSchedule(directory);
  if (saved.status !== 'connected') return { status: saved.status, reason: saved.reason ?? null };
  return (options.tick ?? studyScheduleTick)(directory, { ...options, accountDirectory: saved.accountDirectory ?? undefined });
}
