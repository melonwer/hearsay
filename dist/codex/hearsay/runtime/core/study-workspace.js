import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireResearchLock, loadProject, loadResearchRun, readJson, writeJson } from './research-workspace.js';
import { researchHash } from './research-contract.js';
import { STUDY_COLLECTIONS, STUDY_MAX_BYTES, StudyError, checkStudy, studyHash, studyIdentifier, studyTextHash, studyUrl, validateStudyPlan, validateStudyRecord, validateStudySnapshot } from './study-contract.js';

/** @typedef {import('./study-contract.js').StudyRecord} Record */
const recordPaths = {
  approval: ['approvals', '.json'], page: ['pages', 'receipt.json'], version: ['versions', '.json'],
  'search-run': ['search-runs', 'evidence.json'], 'research-run': ['research-runs', '.json'],
  change: ['changes', 'proposal.json'], event: ['events', '.json'], outcome: ['outcomes', '.json'],
  review: ['reviews', 'report.json'], analysis: ['analyses', '.json'],
};
/** @type {Map<string, Promise<void>>} */ const queues = new Map();
/** @type {AsyncLocalStorage<Set<string>>} */ const heldLocks = new AsyncLocalStorage();

/** @param {string} root @param {string} path */
function safePath(root, path) {
  const base = resolve(root); const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new StudyError('unsafe_path', 'Path leaves the study workspace');
  const parts = relative(base, target).split(sep).filter(Boolean); let current = base;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new StudyError('unsafe_path', 'Symbolic links are not study storage');
  }
  return target;
}
/** @param {string} root @param {string} path */
function ensureDirectory(root, path) { const target = safePath(root, path); mkdirSync(target, { recursive: true, mode: 0o700 }); return target; }
/** @param {string} prefix */
function newId(prefix) { return `${prefix}-${randomUUID()}`; }
/** @param {Record} plan */
function angleMap(plan) { return { version: 1, id: plan.id, studyId: plan.studyId, appId: plan.app.id, angles: plan.angles, questions: plan.questions }; }
/** @param {string} root @param {Record} plan */
function saveAngleMap(root, plan) {
  ensureDirectory(root, 'angles'); const file = safePath(root, `angles/${plan.id}.json`); const map = angleMap(plan);
  if (existsSync(file)) { if (studyHash(readJson(file)) !== studyHash(map)) throw new StudyError('immutable_record', 'Angle revision already has different content'); return; }
  writeFileSync(file, JSON.stringify(map, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
/** @param {Date|string|undefined} value */
function nowIso(value) { const time = value instanceof Date ? value : value === undefined ? new Date() : new Date(value); checkStudy(Number.isFinite(time.getTime()), 'Invalid timestamp'); return time.toISOString(); }
/** @param {string} studyDirectory @param {()=>any|Promise<any>} callback */
export async function withStudyLock(studyDirectory, callback) {
  const root = resolve(studyDirectory); safePath(root, '.');
  if (heldLocks.getStore()?.has(root)) return callback();
  const prior = queues.get(root) ?? Promise.resolve();
  /** @type {()=>void} */ let finish = () => {};
  /** @type {Promise<void>} */ const ready = new Promise((resolveQueue) => { finish = () => resolveQueue(); });
  const queued = prior.then(() => ready); queues.set(root, queued);
  await prior;
  let release;
  try {
    release = acquireResearchLock(root, 3_600_000);
    const held = new Set(heldLocks.getStore() ?? []); held.add(root);
    return await heldLocks.run(held, callback);
  } finally { release?.(); finish(); if (queues.get(root) === queued) queues.delete(root); }
}
/** @param {string} root @param {string} kind @param {string} id */
function recordFile(root, kind, id) {
  const [directory, name] = /** @type {string[]} */ (/** @type {Record} */ (recordPaths)[kind]);
  return safePath(root, name === '.json' ? `${directory}/${id}.json` : `${directory}/${id}/${name}`);
}
/** @param {string} root @param {string} kind @param {Record} row */
function persistRecord(root, kind, row) {
  const file = recordFile(root, kind, row.id);
  if (existsSync(file)) {
    if (studyHash(readJson(file)) !== studyHash(row)) throw new StudyError('immutable_record', `Record ${row.id} already has different content`);
    return row;
  }
  const [directory, name] = /** @type {string[]} */ (/** @type {Record} */ (recordPaths)[kind]);
  ensureDirectory(root, directory);
  if (name === '.json') writeFileSync(file, JSON.stringify(row, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  else {
    const temporary = safePath(root, `${directory}/.pending-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      writeFileSync(join(temporary, name), JSON.stringify(row, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (kind === 'review') writeFileSync(join(temporary, 'report.md'), row.markdown, { flag: 'wx', mode: 0o600 });
      if (kind === 'change' && typeof row.draftPatch === 'string') writeFileSync(join(temporary, 'draft.patch'), row.draftPatch, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, dirname(file));
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
  }
  return row;
}
/** @param {string} root @param {string} kind @param {string[]} known */
function readRecords(root, kind, known) {
  const [directory, name] = /** @type {string[]} */ (/** @type {Record} */ (recordPaths)[kind]);
  const parent = safePath(root, directory);
  if (!existsSync(parent)) return [];
  const ids = readdirSync(parent).filter((name) => !name.startsWith('.')).map((entry) => name === '.json' ? entry.replace(/\.json$/, '') : entry);
  for (const id of ids) studyIdentifier(id);
  const ordered = [...known.filter((id) => ids.includes(id)), ...ids.filter((id) => !known.includes(id)).sort((a, b) => lstatSync(recordFile(root, kind, a)).mtimeMs - lstatSync(recordFile(root, kind, b)).mtimeMs || a.localeCompare(b))];
  return ordered.map((id) => {
    const row = validateStudyRecord(kind, readJson(recordFile(root, kind, id)));
    checkStudy(row.id === id, 'Record filename identity mismatch');
    if (kind === 'page') {
      const source = safePath(root, row.originalPath); const content = safePath(root, row.contentPath);
      if (lstatSync(source).size > STUDY_MAX_BYTES || lstatSync(content).size > STUDY_MAX_BYTES) throw new StudyError('invalid_study', 'Page capture exceeds 8 MiB');
      row.content = readFileSync(content, 'utf8');
      if (studyTextHash(readFileSync(source)) !== row.originalSha256 || studyTextHash(row.content) !== row.contentSha256) throw new StudyError('capture_changed', `Page capture ${id} differs from its saved hashes`);
    }
    if (kind === 'research-run') {
      row.evidence = loadResearchRun(dirname(dirname(root)), row.runId);
      if (row.evidenceHash && row.evidenceHash !== researchHash(row.evidence)) throw new StudyError('capture_changed', 'Linked research evidence changed');
      if (row.bundle && researchHash(row.bundle) !== researchHash(row.evidence)) throw new StudyError('capture_changed', 'Linked research bundle differs from its project evidence');
      row.bundle = row.evidence;
    }
    if (kind === 'review') checkStudy(readFileSync(safePath(root, `reviews/${id}/report.md`), 'utf8') === row.markdown, 'Saved review markdown changed');
    return row;
  });
}
/** @param {Record} snapshot */
function derivedManifest(snapshot) {
  const { plan, plans, pages, versions, approvals, events, analyses, changes } = snapshot;
  const manifest = { ...snapshot.manifest, currentPlanId: plan.id };
  const approval = approvals.filter((/** @type {Record} */ row) => row.planId === plan.id && row.planHash === studyHash(plan)).at(-1);
  const active = [...versions].reverse().find((/** @type {Record} */ version) => version.status !== 'captured') ?? versions[0] ?? null;
  manifest.approvalId = approval?.id ?? null; manifest.activeVersionId = active?.id ?? null;
  const activePage = pages.find((/** @type {Record} */ page) => page.id === active?.pageId);
  const acknowledged = new Set(versions.filter((/** @type {Record} */ version, /** @type {number} */ index) => index === 0 || version.status !== 'captured').map((/** @type {Record} */ version) => version.pageId));
  for (const event of events) if (event.type === 'owner_decision' && event.pageId && ['accept', 'reject', 'approve', 'keep', 'ignore'].includes(event.action)) acknowledged.add(event.pageId);
  manifest.pendingPageIds = activePage ? pages.filter((/** @type {Record} */ page) => !acknowledged.has(page.id) && page.requestedUrl === activePage.requestedUrl && page.contentSha256 !== activePage.contentSha256).map((/** @type {Record} */ page) => page.id) : [];
  manifest.pendingDecisionIds = changes.filter((/** @type {Record} */ change) => !events.some((/** @type {Record} */ event) => event.type === 'owner_decision' && event.changeId === change.id)).map((/** @type {Record} */ change) => change.id);
  const completed = events.filter((/** @type {Record} */ event) => event.type.startsWith('occurrence_') && event.analysisDue === true);
  const reviewed = new Set(analyses.flatMap((/** @type {Record} */ analysis) => analysis.occurrenceIds));
  manifest.analysisDue = [...new Set(completed.map((/** @type {Record} */ event) => event.occurrenceId).filter((/** @type {string} */ id) => !reviewed.has(id)))];
  const stop = events.filter((/** @type {Record} */ event) => event.type === 'collection_stopped' && event.planId === plan.id).at(-1);
  const connectionEvent = events.filter((/** @type {Record} */ event) => ['schedule_connected', 'schedule_disconnected'].includes(event.type) && event.planId === plan.id && event.approvalId === approval?.id).at(-1);
  const connection = connectionEvent?.type === 'schedule_connected' ? connectionEvent : null;
  manifest.status = stop ? 'stopped' : approval ? 'approved' : 'proposed';
  manifest.schedule = { configured: Boolean(plan.collection), connected: Boolean(connection), connectionId: connection?.id ?? null,
    lastSuccessAt: completed.filter((/** @type {Record} */ event) => ['completed', 'success', 'partial'].includes(event.status)).at(-1)?.lastSuccessAt ?? completed.filter((/** @type {Record} */ event) => ['completed', 'success'].includes(event.status)).at(-1)?.finishedAt ?? completed.filter((/** @type {Record} */ event) => ['completed', 'success'].includes(event.status)).at(-1)?.completedAt ?? null,
    missedOccurrenceIds: [...new Set(events.filter((/** @type {Record} */ event) => event.type === 'occurrence_missed').map((/** @type {Record} */ event) => event.occurrenceId))], stoppedReason: stop?.reason ?? null };
  manifest.recordIds = { plans: plans.map((/** @type {Record} */ row) => row.id) };
  for (const collection of Object.values(STUDY_COLLECTIONS)) manifest.recordIds[collection] = snapshot[collection].map((/** @type {Record} */ row) => row.id);
  return manifest;
}
/** @param {string} studyDirectory @returns {Record} */
export function loadStudy(studyDirectory) {
  const root = resolve(studyDirectory); const manifest = readJson(safePath(root, 'study.json'));
  checkStudy(manifest.version === 1, 'Unsupported study manifest version');
  const planDirectory = safePath(root, 'plans'); const available = readdirSync(planDirectory).filter((name) => !name.startsWith('.') && name.endsWith('.json')).map((name) => name.slice(0, -5));
  available.forEach((id) => studyIdentifier(id));
  const known = manifest.recordIds?.plans ?? [];
  const ids = [...known.filter((/** @type {string} */ id) => available.includes(id)), ...available.filter((id) => !known.includes(id)).sort((a, b) => lstatSync(safePath(root, `plans/${a}.json`)).mtimeMs - lstatSync(safePath(root, `plans/${b}.json`)).mtimeMs || a.localeCompare(b))];
  const plans = ids.map((id) => { const plan = validateStudyPlan(readJson(safePath(root, `plans/${id}.json`))); checkStudy(plan.id === id, 'Plan filename identity mismatch'); checkStudy(studyHash(readJson(safePath(root, `angles/${id}.json`))) === studyHash(angleMap(plan)), 'Angle revision differs from its saved plan'); return plan; });
  checkStudy(plans.length > 0, 'Study has no plan');
  /** @type {Record} */ const snapshot = { manifest, plan: plans.at(-1), plans, discoveryEvidence: existsSync(safePath(root, 'discovery-evidence.json')) ? readJson(safePath(root, 'discovery-evidence.json')) : [] };
  for (const [kind, collection] of Object.entries(STUDY_COLLECTIONS)) snapshot[collection] = readRecords(root, kind, manifest.recordIds?.[collection] ?? []);
  snapshot.manifest = derivedManifest(snapshot);
  return validateStudySnapshot(snapshot);
}
/** @param {string} root @param {Record} snapshot */
function updateManifest(root, snapshot) { snapshot.manifest = derivedManifest(snapshot); snapshot.manifest.updatedAt = nowIso(undefined); writeJson(safePath(root, 'study.json'), snapshot.manifest); return snapshot.manifest; }

/** @param {string} projectDirectory @param {unknown} input */
export async function createStudy(projectDirectory, input) {
  const root = resolve(projectDirectory); const project = loadProject(root); const plan = validateStudyPlan(input);
  if (studyHash(project.app) !== studyHash(plan.app)) throw new StudyError('study_mismatch', 'Plan belongs to a different project app');
  const evidenceIds = new Set(project.discoveryEvidence.map((/** @type {Record} */ evidence) => evidence.id));
  checkStudy(plan.angles.every((/** @type {Record} */ angle) => angle.evidenceIds.every((/** @type {string} */ id) => evidenceIds.has(id))), 'Angle has unresolved discovery evidence');
  ensureDirectory(root, 'studies'); const studyDirectory = safePath(root, `studies/${plan.studyId}`);
  if (existsSync(studyDirectory)) { const saved = loadStudy(studyDirectory); if (saved.plans.some((/** @type {Record} */ prior) => prior.id === plan.id && studyHash(prior) === studyHash(plan))) return { studyDirectory, manifest: saved.manifest }; throw new StudyError('immutable_record', 'Study identity is already in use'); }
  const temporary = safePath(root, `studies/.pending-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 });
  const time = nowIso(undefined);
  /** @type {Record} */ const snapshot = { manifest: { version: 1, id: plan.studyId, studyId: plan.studyId, appId: plan.app.id, createdAt: time, updatedAt: time }, plan, plans: [plan], discoveryEvidence: structuredClone(project.discoveryEvidence) };
  for (const collection of Object.values(STUDY_COLLECTIONS)) snapshot[collection] = [];
  const manifest = derivedManifest(snapshot);
  try { ensureDirectory(temporary, 'plans'); saveAngleMap(temporary, plan); writeFileSync(join(temporary, 'plans', `${plan.id}.json`), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); writeFileSync(join(temporary, 'discovery-evidence.json'), JSON.stringify(snapshot.discoveryEvidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); writeJson(join(temporary, 'study.json'), manifest); renameSync(temporary, studyDirectory); }
  finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
  return { studyDirectory, manifest };
}
/** @param {string} studyDirectory @param {unknown} input */
export async function proposeStudyPlan(studyDirectory, input) {
  return withStudyLock(studyDirectory, () => {
    const root = resolve(studyDirectory); const snapshot = loadStudy(root); const plan = validateStudyPlan(input);
    if (plan.studyId !== snapshot.manifest.studyId || studyHash(plan.app) !== studyHash(snapshot.plan.app)) throw new StudyError('study_mismatch', 'Plan belongs to a different study');
    const prior = snapshot.plans.find((/** @type {Record} */ row) => row.id === plan.id);
    if (prior) { if (studyHash(prior) !== studyHash(plan)) throw new StudyError('immutable_record', 'Plan revision already has different content'); return previewStudy(root); }
    const project = loadProject(dirname(dirname(root))); const discovery = new Set(project.discoveryEvidence.map((/** @type {Record} */ row) => row.id));
    const evidence = new Set([...discovery, ...Object.values(STUDY_COLLECTIONS).flatMap((collection) => snapshot[collection].map((/** @type {Record} */ row) => row.id))]);
    checkStudy(plan.angles.every((/** @type {Record} */ angle) => angle.evidenceIds.every((/** @type {string} */ id) => evidence.has(id))), 'Angle has unresolved discovery evidence');
    saveAngleMap(root, plan); writeFileSync(safePath(root, `plans/${plan.id}.json`), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    snapshot.plans.push(plan); snapshot.plan = plan; updateManifest(root, snapshot); return previewStudy(root);
  });
}
/** @param {string} studyDirectory */
export function previewStudy(studyDirectory) {
  const { plan } = loadStudy(studyDirectory); const depthCost = plan.tavily.searchDepth === 'advanced' ? 2 : 1;
  return { plan, quoteId: studyHash({ version: 1, plan }), estimate: { occurrences: plan.collection.occurrences, questionsPerOccurrence: plan.questions.length,
    tavily: { enabled: plan.tavily.enabled, searchDepth: plan.tavily.searchDepth, collectionCredits: plan.questions.length * plan.collection.occurrences * depthCost, diagnosticCredits: plan.tavily.diagnosticCredits, allowance: plan.tavily.allowance }, research: plan.research ? { targetCount: plan.research.targetCount, occurrences: plan.collection.occurrences, accountCost: null, remainingAllowance: null } : null } };
}
/** @param {string} studyDirectory @param {string} quoteId @param {{author:string,now?:Date|string}} options */
export async function approveStudy(studyDirectory, quoteId, options) {
  return withStudyLock(studyDirectory, async () => {
    const preview = previewStudy(studyDirectory); const snapshot = loadStudy(studyDirectory);
    if (quoteId !== preview.quoteId) throw new StudyError('approval_required', 'Review and approve the current study quote');
    const prior = snapshot.approvals.find((/** @type {Record} */ approval) => approval.quoteId === quoteId);
    if (prior) return prior;
    return appendStudyRecord(studyDirectory, 'approval', { id: newId('approval'), planId: preview.plan.id, planHash: studyHash(preview.plan), quoteId, author: options.author, approvedAt: nowIso(options.now), scope: preview.plan });
  });
}
/** @param {string} studyDirectory @param {string} kind @param {Record} input */
export async function appendStudyRecord(studyDirectory, kind, input) {
  return withStudyLock(studyDirectory, () => {
    const root = resolve(studyDirectory); const snapshot = loadStudy(root); const collection = /** @type {Record} */ (STUDY_COLLECTIONS)[kind]; checkStudy(Boolean(collection), 'Unknown study record kind');
    const prior = snapshot[collection].find((/** @type {Record} */ row) => row.id === input.id);
    const row = validateStudyRecord(kind, { ...input, version: input.version ?? 1, id: input.id ?? newId(kind), studyId: input.studyId ?? snapshot.manifest.studyId, appId: input.appId ?? snapshot.manifest.appId,
      ...(kind === 'event' && input.type === 'owner_decision' || kind === 'event' && ['collection_stopped', 'schedule_connected'].includes(input.type) ? { planId: input.planId ?? prior?.planId ?? snapshot.plan.id } : {}),
      createdAt: input.createdAt ?? prior?.createdAt ?? nowIso(undefined) });
    if (row.studyId !== snapshot.manifest.studyId || row.appId !== snapshot.manifest.appId) throw new StudyError('study_mismatch', 'Record belongs to a different study');
    if (prior) {
      const saved = readJson(recordFile(root, kind, row.id));
      if (kind === 'research-run' && row.evidenceHash === undefined) row.evidenceHash = saved.evidenceHash;
      if (studyHash(saved) !== studyHash(row)) throw new StudyError('immutable_record', `Record ${row.id} already has different content`);
      return prior;
    }
    if (kind === 'outcome') checkStudy(!snapshot.outcomes.some((/** @type {Record} */ outcome) => outcome.source === row.source && outcome.recordKey === row.recordKey), 'Duplicate outcome source key');
    if (kind === 'version' && snapshot.versions.length > 0) {
      if (row.status !== 'captured') {
        const decision = row.decisionId ? snapshot.events.find((/** @type {Record} */ event) => event.id === row.decisionId) : null;
        if (!decision || decision.type !== 'owner_decision' || !['approve', 'accept', 'keep', 'revert'].includes(decision.action)) throw new StudyError('approval_required', 'Record the owner decision before changing the active published version');
        if (!decision.pageId || decision.pageId !== row.pageId) throw new StudyError('approval_required', 'The owner decision must name this exact captured page');
        if (row.status === 'published' && !decision.scope?.actions?.includes('publish')) throw new StudyError('approval_required', 'Publishing requires an owner decision that includes publish');
        if (row.status === 'reverted' && !decision.scope?.actions?.includes('revert')) throw new StudyError('approval_required', 'Reverting requires an owner decision that includes revert');
      }
    }
    if (kind === 'research-run') {
      const evidence = loadResearchRun(dirname(dirname(root)), row.runId);
      checkStudy(evidence.app.id === row.appId, 'Research run belongs to another app'); row.evidenceHash = researchHash(evidence);
      if (row.bundle) checkStudy(researchHash(row.bundle) === researchHash(evidence), 'Research bundle differs from saved project evidence');
      const extended = { ...row, evidence }; snapshot[collection].push(extended);
    } else snapshot[collection].push(row);
    snapshot.manifest = derivedManifest(snapshot); validateStudySnapshot(snapshot);
    if (kind === 'version' && snapshot.versions.length > 1 && row.status !== 'captured' && !row.decisionId) throw new StudyError('approval_required', 'Record the owner decision before changing or reverting the active published version');
    if (kind === 'version' && row.decisionId) {
      const decision = snapshot.events.find((/** @type {Record} */ event) => event.id === row.decisionId);
      checkStudy(decision.type === 'owner_decision' && ['approve', 'accept', 'keep', 'revert'].includes(decision.action), 'Version decision does not approve this action');
      checkStudy(!row.changeId || decision.changeId === row.changeId, 'Version decision refers to a different change');
    }
    persistRecord(root, kind, row); updateManifest(root, snapshot); return row;
  });
}

/** @param {string} html */
function extractedText(html) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
/** @param {Response} response */
async function boundedResponse(response) {
  const announced = response.headers?.get('content-length'); checkStudy(!announced || Number(announced) <= STUDY_MAX_BYTES, 'Page exceeds 8 MiB');
  if (!response.body?.getReader) { const source = Buffer.from(await response.arrayBuffer()); checkStudy(source.byteLength <= STUDY_MAX_BYTES, 'Page exceeds 8 MiB'); return source; }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > STUDY_MAX_BYTES) throw new StudyError('invalid_study', 'Page exceeds 8 MiB'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
/** @param {string} studyDirectory @param {{url?:string,html?:string,content?:string,method?:string,finalUrl?:string,fetch?:typeof fetch,now?:Date|string}} [options] */
export async function captureStudyPage(studyDirectory, options = {}) {
  const root = resolve(studyDirectory); const snapshot = loadStudy(root); const url = studyUrl(options.url ?? snapshot.plan.targetUrl);
  /** @type {string|Buffer|undefined} */ let original = options.html ?? options.content;
  let finalUrl = options.finalUrl ?? url; let method = options.method ?? (options.html !== undefined ? 'host_capture' : options.content !== undefined ? 'host_content' : 'direct_fetch');
  /** @type {string|null} */ let contentType = null;
  if (original === undefined) {
    const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
    if (!response.ok) throw new StudyError('capture_failed', `Page returned HTTP ${response.status}`);
    finalUrl = response.url || finalUrl; contentType = response.headers?.get('content-type') ?? null; original = await boundedResponse(response);
  }
  studyUrl(finalUrl); checkStudy((typeof original === 'string' || Buffer.isBuffer(original)) && Buffer.byteLength(original) <= STUDY_MAX_BYTES, 'Invalid page source');
  const source = typeof original === 'string' ? original : original.toString('utf8');
  const content = options.content ?? extractedText(source); checkStudy(typeof content === 'string' && Buffer.byteLength(content) <= STUDY_MAX_BYTES, 'Invalid extracted page content');
  return withStudyLock(root, () => {
    const current = loadStudy(root); const id = newId('capture'); const extension = options.html !== undefined || method === 'direct_fetch' ? 'html' : 'txt';
    const row = validateStudyRecord('page', { version: 1, id, studyId: current.manifest.studyId, appId: current.manifest.appId,
      requestedUrl: url, finalUrl, method, extractionRevision: options.content === undefined ? 'html-text-v1' : 'host-content-v1', capturedAt: nowIso(options.now), sourceEncoding: Buffer.isBuffer(original) ? 'bytes' : 'utf-8', contentEncoding: 'utf-8', contentType,
      originalSha256: studyTextHash(original), contentSha256: studyTextHash(content), originalPath: `pages/${id}/original.${extension}`, contentPath: `pages/${id}/content.txt` });
    validateStudyRecord('page', { ...row, content, source });
    ensureDirectory(root, 'pages'); const temporary = safePath(root, `pages/.pending-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 });
    try {
      writeFileSync(join(temporary, `original.${extension}`), original, { mode: 0o600, flag: 'wx' }); writeFileSync(join(temporary, 'content.txt'), content, { mode: 0o600, flag: 'wx' }); writeFileSync(join(temporary, 'receipt.json'), JSON.stringify(row, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, safePath(root, `pages/${id}`));
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
    current.pages.push({ ...row, content }); updateManifest(root, current); return row;
  });
}
/** @param {string} studyDirectory @param {Record} input */
export async function recordStudyVersion(studyDirectory, input) { return appendStudyRecord(studyDirectory, 'version', { ...input, status: input.status ?? 'captured' }); }
/** @param {string} studyDirectory @param {Record} input */
export async function recordStudyDecision(studyDirectory, input) {
  checkStudy(['approve', 'accept', 'reject', 'suggest_change', 'keep', 'revise', 'revert', 'ignore'].includes(input.action), 'Invalid owner decision');
  checkStudy(typeof input.author === 'string' && input.author.trim() && typeof input.reason === 'string' && input.reason.trim(), 'Decision needs author and reason');
  if (['approve', 'accept', 'revert'].includes(input.action)) {
    const { plan } = loadStudy(studyDirectory); checkStudy(input.scope && Array.isArray(input.scope.actions), 'Decision needs exact action scope');
    checkStudy(input.scope.actions.every((/** @type {string} */ action) => plan.permissions.actions.includes(action)), 'Decision exceeds plan action permissions');
    checkStudy(input.scope.repository === plan.permissions.repository && input.scope.publishTarget === plan.permissions.publishTarget, 'Decision target differs from plan permissions');
  }
  return appendStudyRecord(studyDirectory, 'event', { ...input, type: 'owner_decision' });
}
/** @param {string} studyDirectory @param {Record} input */
export async function recordStudyAnalysis(studyDirectory, input) { return appendStudyRecord(studyDirectory, 'analysis', input); }
/** @param {string} studyDirectory @returns {Record} */
export function inspectStudy(studyDirectory) {
  const snapshot = loadStudy(studyDirectory);
  return { ...snapshot, resume: { currentPlanId: snapshot.plan.id, latestReviewId: snapshot.reviews.at(-1)?.id ?? null, pendingDecisionIds: snapshot.manifest.pendingDecisionIds, pendingPageIds: snapshot.manifest.pendingPageIds, analysisDue: snapshot.manifest.analysisDue, nextAction: snapshot.manifest.analysisDue.length ? 'analyze_collected_evidence' : snapshot.manifest.pendingPageIds.length ? 'review_external_page_change' : snapshot.manifest.pendingDecisionIds.length ? 'request_owner_decision' : snapshot.manifest.approvalId ? 'continue_approved_study' : 'review_proposed_plan' } };
}
