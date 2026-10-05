import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadStudy, previewStudy, proposeStudyPlan, appendStudyRecord, withStudyLock } from './study-workspace.js';
import { researchHash, ResearchError } from './research-contract.js';
import { studyIdentifier } from './study-contract.js';
import { loadProject, previewResearchRun, runResearchPanel, readJson, writeJson } from './research-workspace.js';
import { previewResearchSchedule, enableResearchSchedule, readResearchSchedule } from './research-schedule.js';
import { localDateInZone, scheduledInstantForLocalDate } from './subscription-scheduler.js';
import { collectTavily, inspectTavilyUsage } from './tavily-search.js';
import { createAgentRunner } from './agent-runners.js';
import { deriveStudyExposure } from './study-report.js';

/** @typedef {import('./research-contract.js').ResearchRecord} Record */

/** @param {Record} snapshot */
function approvalFor(snapshot) {
  const quote = previewStudy(snapshot.directory).quoteId;
  const approval = snapshot.approvals.find((/** @type {Record} */ item) => item.id === snapshot.manifest.approvalId);
  if (!approval || approval.quoteId !== quote || approval.planId !== snapshot.plan.id) throw new ResearchError('study_approval_required', 'Approve the current exact study plan before collection');
  return approval;
}
/** @param {string} studyDirectory */
function projectDirectory(studyDirectory) { return dirname(dirname(resolve(studyDirectory))); }

/** @param {string} date @param {string} approvalId */
function collectionOccurrenceId(date, approvalId) { return `collection-${date}-${researchHash(approvalId).slice(0, 12)}`; }

/** @param {string} studyDirectory @param {{preview?:any,now?:Date}} [options] */
export async function prepareStudyResearch(studyDirectory, options = {}) {
  const saved = loadStudy(studyDirectory);
  const directory = projectDirectory(studyDirectory);
  const preview = options.preview ?? await previewResearchRun(directory);
  if (preview.project.app.id !== saved.plan.app.id || preview.project.app.url !== saved.plan.app.url) throw new ResearchError('app_identity_conflict', 'Research project and study must describe the same app');
  if (researchHash(preview.snapshot.panel.questions) !== researchHash(saved.plan.questions.map((/** @type {Record} */ q) => ({ id: q.id, text: q.text })))) throw new ResearchError('study_panel_mismatch', 'Freeze the exact study questions in the research panel before binding routes');
  const schedule = await previewResearchSchedule(directory, { at: saved.plan.collection.at, timezone: saved.plan.collection.timezone, targetCeiling: preview.targetCount, now: options.now, preview });
  const plan = { ...saved.plan, id: `${saved.plan.id.slice(0, 65)}-routes-${preview.quoteId.slice(0, 12)}`, research: {
    projectHash: researchHash(preview.project), runQuote: preview.quoteId, scheduleQuote: schedule.quoteId, targetCount: preview.targetCount,
    runPreview: preview, schedulePreview: schedule,
  } };
  await proposeStudyPlan(studyDirectory, plan);
  return previewStudy(studyDirectory);
}

/** @param {string} directory @param {Record} plan @param {Record} approval @param {Record} options */
async function currentResearch(directory, plan, approval, options) {
  const binding = plan.research;
  if (researchHash(loadProject(directory)) !== binding.projectHash) throw new ResearchError('study_scope_changed', 'Research project changed; prepare and approve an updated study plan');
  const preview = options.researchPreview ?? await previewResearchRun(directory);
  if (preview.quoteId !== binding.runQuote || preview.targetCount !== binding.targetCount) throw new ResearchError('study_scope_changed', 'Selected executable, questions or usage changed; approve the new scope');
  const schedule = await previewResearchSchedule(directory, { timezone: plan.collection.timezone, at: plan.collection.at, targetCeiling: binding.targetCount, preview, now: options.now });
  if (schedule.quoteId !== binding.scheduleQuote) throw new ResearchError('study_scope_changed', 'Recurring settings changed; approve an updated study plan');
  const consentPath = join(directory, 'consent.json');
  const existing = existsSync(consentPath) ? readJson(consentPath) : null;
  if (existing?.quoteId !== binding.runQuote || existing.studyApprovalId !== approval.id) writeJson(consentPath, {
    quoteId: binding.runQuote, targetCeiling: binding.targetCount, approvedAt: approval.approvedAt,
    studyId: plan.studyId, studyApprovalId: approval.id,
  });
  const studyDirectory = join(directory, 'studies', plan.studyId);
  const saved = loadStudy(studyDirectory);
  const consentId = `account-run-consent-${researchHash({ approval: approval.id, quote: binding.runQuote }).slice(0, 24)}`;
  if (!saved.events.some((/** @type {Record} */ row) => row.id === consentId)) await appendStudyRecord(studyDirectory, 'event', {
    version: 1, id: consentId, studyId: plan.studyId, appId: plan.app.id, planId: plan.id, approvalId: approval.id,
    type: 'account_run_consent', quoteId: binding.runQuote, targetCeiling: binding.targetCount, createdAt: approval.approvedAt,
  });
  if (options.scheduled) {
    const prior = readResearchSchedule(directory);
    if (!prior || prior.quoteId !== binding.scheduleQuote || !prior.enabled || !prior.studyManaged || prior.studyApprovalId !== approval.id) {
      const enabled = enableResearchSchedule(directory, schedule, binding.scheduleQuote, { now: options.now });
      writeJson(join(directory, 'schedule.json'), { ...enabled, studyId: plan.studyId, studyApprovalId: approval.id, studyManaged: true, installedCron: prior?.installedCron ?? false });
    }
    const scheduleId = `account-schedule-consent-${researchHash({ approval: approval.id, quote: binding.scheduleQuote }).slice(0, 24)}`;
    if (!saved.events.some((/** @type {Record} */ row) => row.id === scheduleId)) await appendStudyRecord(studyDirectory, 'event', {
      version: 1, id: scheduleId, studyId: plan.studyId, appId: plan.app.id, planId: plan.id, approvalId: approval.id,
      type: 'account_schedule_consent', quoteId: binding.scheduleQuote, runQuote: binding.runQuote, targetCeiling: binding.targetCount,
      priorVerifiedTrial: true, createdAt: (options.now ?? new Date()).toISOString(),
    });
  }
  return preview;
}

/** @param {Record} snapshot @param {Record} input @returns {Record} */
function event(snapshot, input) {
  return { version: 1, studyId: snapshot.manifest.studyId, appId: snapshot.manifest.appId, planId: snapshot.plan.id, attemptedAt: input.createdAt ?? new Date().toISOString(), evidenceIds: [], ...input };
}

/** @param {string} directory @param {Record} plan @param {Record|null} preview @param {Record} options */
async function preflightScheduledProviders(directory, plan, preview, options) {
  if (preview) {
    const execution = preview.snapshot.execution;
    for (const route of execution.routes) {
      const identity = preview.snapshot.identities.find((/** @type {Record} */ row) => row.id === route.id);
      const runner = (options.runnerFactory ?? createAgentRunner)(route.id, { executable: identity?.executable ?? route.executable,
        dataDir: join(directory, '.provider-preflight'), timeoutMs: execution.timeoutMs, idleTimeoutMs: execution.idleTimeoutMs, maxOutputBytes: execution.maxOutputBytes });
      const auth = await runner.preflight();
      const version = auth.cliVersion ?? auth.version;
      const executable = auth.cliExecutable ?? auth.executable;
      if (version && version !== identity.version || executable && executable !== identity.executable) {
        throw new ResearchError('execution_mismatch', 'Account executable identity changed after the approved preview');
      }
      const ready = route.id === 'agy-cli' ? auth.configuredLogin === 'native_keyring_available' : auth.authenticated && auth.authKind === 'subscription';
      if (!ready) throw new ResearchError('authentication_missing', 'Selected account route needs its supported login or native keyring');
    }
  }
  if (plan.tavily.enabled) {
    const checked = await inspectTavilyUsage({ apiKey: options.apiKey, fetch: options.fetch, signal: options.signal, strictFreeMode: plan.tavily.strictFreeMode });
    if (checked.status !== 'available' || !checked.usage) throw new ResearchError(`tavily_${checked.status}`, 'Selected Tavily route is unavailable for scheduled collection');
    const needed = plan.questions.length * (plan.tavily.searchDepth === 'advanced' ? 2 : 1);
    const usage = checked.usage;
    if (usage.accountLimit !== null && usage.accountLimit - usage.accountUsage < needed || usage.keyLimit !== null && usage.keyLimit - usage.keyUsage < needed) {
      throw new ResearchError('tavily_quota', 'Tavily capacity cannot cover the approved occurrence');
    }
  }
}

/** @param {string} studyDirectory @param {Record} [options] */
export async function collectStudyOccurrence(studyDirectory, options = {}) {
  return withStudyLock(studyDirectory, async () => {
    /** @type {Record} */ const snapshot = { ...loadStudy(studyDirectory), directory: studyDirectory };
    if (snapshot.manifest.status === 'stopped') throw new ResearchError('study_stopped', 'Collection has stopped; approve a new plan before restarting');
    const approval = approvalFor(snapshot);
    if (!snapshot.plan.permissions.actions.includes('collect')) throw new ResearchError('study_permission_required', 'The approved plan does not permit collection');
    const now = options.now ?? new Date();
    const approvedAt = new Date(approval.approvedAt);
    const today = localDateInZone(now, snapshot.plan.collection.timezone);
    const first = localDateInZone(approvedAt, snapshot.plan.collection.timezone);
    const elapsed = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86400000);
    if (elapsed < 0 || elapsed >= snapshot.plan.collection.maxDays) throw new ResearchError('study_duration_exhausted', 'Collection is outside the approved study duration');
    if (!snapshot.manifest.activeVersionId) throw new ResearchError('study_baseline_required', 'Save and review the baseline page version before collection');
    const occurrenceId = collectionOccurrenceId(today, approval.id);
    if (options.occurrenceId && options.occurrenceId !== occurrenceId) throw new ResearchError('invalid_occurrence', 'A daily collection identity binds its local date and approved plan');
    const occurrences = snapshot.events.filter((/** @type {Record} */ item) => item.type.startsWith('occurrence_') && item.approvalId === approval.id);
    const terminal = occurrences.find((/** @type {Record} */ item) => item.occurrenceId === occurrenceId && item.status !== 'claimed');
    if (terminal) return terminal;
    if (occurrences.some((/** @type {Record} */ item) => item.occurrenceId === occurrenceId)) {
      const interrupted = event(snapshot, { id: `${occurrenceId}-${approval.id.slice(-12)}-interrupted`, type: 'occurrence_missed', occurrenceId,
        approvalId: approval.id, status: 'missed', reason: 'Interrupted collection retained; no automatic retry', createdAt: now.toISOString(), analysisDue: true });
      await appendStudyRecord(studyDirectory, 'event', interrupted);
      return interrupted;
    }
    const claimedIds = new Set(occurrences.filter((/** @type {Record} */ item) => item.status === 'claimed').map((/** @type {Record} */ item) => item.occurrenceId));
    if (claimedIds.size >= snapshot.plan.collection.occurrences) throw new ResearchError('study_occurrences_exhausted', 'The approved number of collection occurrences has been reached');
    let researchPreview = null;
    if (snapshot.plan.research) researchPreview = await currentResearch(projectDirectory(studyDirectory), snapshot.plan, approval, options);
    if (options.scheduled) {
      try { await preflightScheduledProviders(studyDirectory, snapshot.plan, researchPreview, options); }
      catch (error) {
        const code = /** @type {Record} */ (error).code ?? 'provider_unavailable';
        await stopStudyCollection(studyDirectory, `Selected provider readiness failed (${code}); restore access and approve a new study plan`, { now });
        return { status: 'stopped', reason: code };
      }
    }
    const identity = occurrenceId;
    await appendStudyRecord(studyDirectory, 'event', event(snapshot, { id: `${identity}-start`, type: 'occurrence_claimed', occurrenceId, approvalId: approval.id,
      status: 'claimed', createdAt: now.toISOString(), scheduled: options.scheduled === true, activeVersionId: snapshot.manifest.activeVersionId, analysisDue: true }));
    /** @type {string[]} */ const evidenceIds = [];
    /** @type {string[]} */ const failures = [];
    let successful = false;
    let providerStop = null;
    if (snapshot.plan.tavily.enabled) {
      try {
        const tavily = snapshot.plan.tavily;
        const receipt = await collectTavily({ ...tavily,
          accountDirectory: options.accountDirectory ?? join(homedir(), '.local', 'state', 'hearsay', 'tavily'),
          studyKey: `${snapshot.manifest.appId}/${snapshot.manifest.studyId}/${approval.id}`, occurrenceId, lane: 'collection',
          queries: snapshot.plan.questions.map((/** @type {Record} */ q) => ({ id: q.id, text: q.text, angleId: q.angleId })),
          apiKey: options.apiKey, fetch: options.fetch, signal: options.signal, now,
        });
        const searchRun = event(snapshot, { ...receipt, id: `search-${identity}`, occurrenceId, approvalId: approval.id, createdAt: now.toISOString(),
          activeVersionId: snapshot.manifest.activeVersionId,
          exposures: receipt.records.flatMap((/** @type {Record} */ r) => (r.results ?? []).map((/** @type {Record} */ source) => ({
            ...deriveStudyExposure({ url: source.url, content: source.content, method: 'search_snippet', versions: snapshot.versions, pages: snapshot.pages,
              activeVersionId: snapshot.manifest.activeVersionId }), questionId: r.questionId, evidenceId: r.id,
          }))),
        });
        await appendStudyRecord(studyDirectory, 'search-run', searchRun);
        evidenceIds.push(searchRun.id);
        successful ||= receipt.records.some((/** @type {Record} */ item) => item.status === 'completed');
        if (receipt.status !== 'completed') {
          failures.push(`tavily:${receipt.status}`);
          if (options.scheduled) providerStop = `tavily:${receipt.creditSummary.stopReason ?? receipt.status}`;
        }
      } catch (error) {
        const code = /** @type {Record} */ (error).code ?? 'collection_failed';
        failures.push(`tavily:${code}`);
        if (options.scheduled) providerStop = `tavily:${code}`;
      }
    }
    if (researchPreview && !providerStop) {
      try {
        const result = await runResearchPanel(projectDirectory(studyDirectory), { execute: true, preview: researchPreview, runId: `study-${researchHash(snapshot.manifest.studyId).slice(0, 10)}-${identity}`,
          runnerFactory: options.runnerFactory, signal: options.signal, studyApprovalId: approval.id, stopOnProviderFailure: options.scheduled === true });
        if (!('evidence' in result)) throw new ResearchError('collection_failed', 'Research execution returned no saved evidence');
        await appendStudyRecord(studyDirectory, 'research-run', event(snapshot, { id: `research-${identity}`, occurrenceId, approvalId: approval.id,
          createdAt: now.toISOString(), runId: result.runId, activeVersionId: snapshot.manifest.activeVersionId,
          exposures: result.evidence.evidence.filter((/** @type {Record} */ item) => ['returned_source', 'fetched_page', 'final_citation'].includes(item.type) && item.data.url)
            .map((/** @type {Record} */ item) => ({ ...deriveStudyExposure({ url: item.data.url, content: item.data.content ?? item.data.text,
              method: item.type === 'fetched_page' ? 'agent_fetch' : item.type === 'returned_source' ? 'search_snippet' : 'citation', versions: snapshot.versions,
              pages: snapshot.pages, activeVersionId: snapshot.manifest.activeVersionId }), evidenceId: item.id, excerpt: item.data.content ?? item.data.text ?? null })) }));
        evidenceIds.push(`research-${identity}`);
        successful ||= result.evidence.samples.some((/** @type {Record} */ item) => item.status === 'completed');
        if (result.evidence.samples.some((/** @type {Record} */ item) => item.status !== 'completed')) failures.push('research:partial_or_failed');
        const fatal = result.evidence.samples.find((/** @type {Record} */ item) => /auth|quota|rate_limit|unsupported|execution_mismatch/.test(item.errorCode ?? ''));
        if (options.scheduled && fatal) providerStop = `research:${fatal.errorCode}`;
      } catch (error) {
        const code = /** @type {Record} */ (error).code ?? 'collection_failed';
        failures.push(`research:${code}`);
        if (options.scheduled && /auth|quota|rate_limit|unsupported|execution_mismatch/.test(code)) providerStop = `research:${code}`;
      }
    }
    if (!snapshot.plan.tavily.enabled && !snapshot.plan.research) failures.push('host_research_due');
    const result = event(snapshot, { id: `${identity}-result`, type: 'occurrence_completed', occurrenceId, approvalId: approval.id,
      status: successful ? failures.length ? 'partial' : 'completed' : 'failed', reason: failures.join('; ') || 'Approved collection completed',
      createdAt: now.toISOString(), completedAt: now.toISOString(), finishedAt: now.toISOString(), lastSuccessAt: successful ? now.toISOString() : null,
      activeVersionId: snapshot.manifest.activeVersionId, evidenceIds, failures, analysisDue: true });
    await appendStudyRecord(studyDirectory, 'event', result);
    if (providerStop) await stopStudyCollection(studyDirectory, `Selected provider stopped (${providerStop}); restore access and approve a new study plan`, { now });
    return result;
  });
}

/** @param {string} studyDirectory @param {Record} options */
export async function collectStudyDiagnostic(studyDirectory, options) {
  return withStudyLock(studyDirectory, async () => {
    /** @type {Record} */ const saved = { ...loadStudy(studyDirectory), directory: studyDirectory };
    if (saved.manifest.status === 'stopped') throw new ResearchError('study_stopped', 'Collection has stopped');
    const approval = approvalFor(saved);
    if (!saved.plan.permissions.actions.includes('collect') || !saved.plan.tavily.enabled) throw new ResearchError('study_permission_required', 'The approved study must permit Tavily collection');
    const now = options.now ?? new Date();
    const elapsed = now.getTime() - Date.parse(approval.approvedAt);
    if (elapsed < 0 || elapsed >= saved.plan.collection.maxDays * 86400000) throw new ResearchError('study_duration_exhausted', 'Diagnostic is outside the approved study duration');
    studyIdentifier(options.diagnosticId, 'diagnosticId');
    const occurrenceId = `diagnostic-${options.diagnosticId}`;
    const receipt = await collectTavily({ ...saved.plan.tavily,
      accountDirectory: options.accountDirectory ?? join(homedir(), '.local', 'state', 'hearsay', 'tavily'),
      studyKey: `${saved.manifest.appId}/${saved.manifest.studyId}/${approval.id}`, occurrenceId, lane: 'diagnostic', queries: options.queries,
      apiKey: options.apiKey, fetch: options.fetch, signal: options.signal, now });
    const recordId = `diagnostic-${researchHash({ approval: approval.id, occurrenceId }).slice(0, 24)}`;
    const prior = saved.searchRuns.find((/** @type {Record} */ row) => row.id === recordId);
    if (prior) return prior;
    return appendStudyRecord(studyDirectory, 'search-run', event(saved, { ...receipt, id: recordId, occurrenceId, approvalId: approval.id,
      createdAt: now.toISOString(), activeVersionId: saved.manifest.activeVersionId,
      exposures: receipt.records.flatMap((/** @type {Record} */ row) => row.results.map((/** @type {Record} */ source) => ({
        ...deriveStudyExposure({ url: source.url, content: source.content, method: 'diagnostic_search', pages: saved.pages, versions: saved.versions,
          activeVersionId: saved.manifest.activeVersionId }), evidenceId: row.id, excerpt: source.content ?? null }))) }));
  });
}

/** @param {string} studyDirectory @param {Record} [options] */
export async function studyScheduleTick(studyDirectory, options = {}) {
  /** @type {Record} */ const snapshot = { ...loadStudy(studyDirectory), directory: studyDirectory };
  if (snapshot.manifest.status === 'stopped') return { status: 'stopped', reason: snapshot.manifest.schedule.stoppedReason };
  const approval = approvalFor(snapshot);
  const now = options.now ?? new Date();
  const today = localDateInZone(now, snapshot.plan.collection.timezone);
  const first = localDateInZone(new Date(approval.approvedAt), snapshot.plan.collection.timezone);
  const elapsed = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86400000);
  if (elapsed >= snapshot.plan.collection.maxDays) {
    await stopStudyCollection(studyDirectory, 'Approved study duration reached', { now });
    return { status: 'stopped', reason: 'Approved study duration reached' };
  }
  for (let day = 0; day < elapsed; day++) {
    const date = new Date(Date.parse(`${first}T12:00:00Z`) + day * 86400000).toISOString().slice(0, 10);
    const occurrenceId = collectionOccurrenceId(date, approval.id);
    if (snapshot.events.some((/** @type {Record} */ item) => item.type.startsWith('occurrence_') && item.approvalId === approval.id && item.occurrenceId === occurrenceId)) continue;
    await appendStudyRecord(studyDirectory, 'event', event(snapshot, { id: `${occurrenceId}-${researchHash(approval.id).slice(0, 8)}-missed`, type: 'occurrence_missed',
      approvalId: approval.id, occurrenceId, status: 'missed', reason: 'Missed occurrence; no spending catch-up', createdAt: now.toISOString(), analysisDue: false }));
  }
  const due = scheduledInstantForLocalDate(today, snapshot.plan.collection.at, snapshot.plan.collection.timezone);
  if (now < due) return { status: 'not_due', due: due.toISOString() };
  if (now.getTime() - due.getTime() > 5 * 60000) {
    return withStudyLock(studyDirectory, async () => {
      const current = loadStudy(studyDirectory);
      const occurrenceId = collectionOccurrenceId(today, approval.id);
      const prior = current.events.find((/** @type {Record} */ item) => item.type.startsWith('occurrence_') && item.approvalId === approval.id && item.occurrenceId === occurrenceId && item.status !== 'claimed');
      if (prior) return prior;
      return appendStudyRecord(studyDirectory, 'event', event(current, { id: `${occurrenceId}-${researchHash(approval.id).slice(0, 8)}-missed`, type: 'occurrence_missed', approvalId: approval.id,
        occurrenceId, status: 'missed', reason: 'Missed occurrence; no spending catch-up', createdAt: now.toISOString(), analysisDue: false }));
    });
  }
  try { return await collectStudyOccurrence(studyDirectory, { ...options, now, scheduled: true }); }
  catch (error) {
    const code = /** @type {Record} */ (error).code;
    if (code === 'run_locked') return { status: 'locked' };
    if (/duration_exhausted|occurrences_exhausted/.test(code ?? '')) {
      await stopStudyCollection(studyDirectory, 'Approved collection limit reached', { now });
      return { status: 'stopped', reason: 'Approved collection limit reached' };
    }
    throw error;
  }
}

/** @param {string} studyDirectory @param {Record} input */
export async function connectStudySchedule(studyDirectory, input) {
  /** @type {Record} */ const snapshot = { ...loadStudy(studyDirectory), directory: studyDirectory };
  const approval = approvalFor(snapshot);
  if (!['host', 'runtime'].includes(input.kind) || !input.receipt?.jobId || !input.receipt?.verifiedAt || !input.command) throw new ResearchError('invalid_connection', 'Save the installed scheduler job receipt, verification time and actual repeat command');
  const now = input.now ?? new Date();
  return appendStudyRecord(studyDirectory, 'event', event(snapshot, { id: `connection-${researchHash({ approval: approval.id, receipt: input.receipt }).slice(0, 16)}`,
    type: 'schedule_connected', approvalId: approval.id, kind: input.kind, receipt: input.receipt, command: input.command, provenance: 'host_supplied',
    connected: true, createdAt: now.toISOString() }));
}

/** @param {string} studyDirectory @param {string} reason @param {{now?:Date}} [options] */
export async function stopStudyCollection(studyDirectory, reason, options = {}) {
  if (!reason?.trim()) throw new ResearchError('invalid_stop', 'Record why collection stopped');
  const snapshot = loadStudy(studyDirectory);
  const now = options.now ?? new Date();
  return appendStudyRecord(studyDirectory, 'event', event(snapshot, { id: `stop-${researchHash({ reason, plan: snapshot.plan.id }).slice(0, 16)}`,
    type: 'collection_stopped', approvalId: snapshot.manifest.approvalId, reason, createdAt: now.toISOString() }));
}
