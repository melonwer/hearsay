import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { validateProject, validateEvidence, researchHash, ResearchError, questionIsNeutral, summarizeEvidence } from './research-contract.js';
import { renderResearchReport, compareResearch } from './research-report.js';
import { AGENT_ROUTES, agentRoute } from './agent-routes.js';
import { createAgentRunner, agentExecutionProfile } from './agent-runners.js';
import { discoverCli, probeAuthentication, AgentProcessError } from './agent-process.js';
import { redactEvent, redactCapturedOutput } from './artifacts.js';
import { analyzeResponse, STANCE_REVISION } from './analyze.js';
/** @typedef {import('./research-contract.js').ResearchRecord} Record */

/** @param {string} file @param {unknown} value */
export function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}
/** @param {string} file */
export function readJson(file) {
  if (statSync(file).size > 8 * 1024 * 1024) throw new ResearchError('invalid_bundle', 'File exceeds 8 MiB');
  return JSON.parse(readFileSync(file, 'utf8'));
}
/** @param {string} directory */
export function loadProject(directory) { return validateProject(readJson(join(resolve(directory), 'project.json'))); }
/** @param {string} directory @param {string} id */
export function loadResearchRun(directory, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) throw new ResearchError('invalid_run', 'Invalid run identifier');
  const bundle = validateEvidence(readJson(join(resolve(directory), 'runs', id, 'evidence.json')));
  const project = loadProject(directory);
  if (bundle.app.id !== project.app.id || bundle.app.url !== project.app.url) throw new ResearchError('invalid_run', 'Run belongs to a different app');
  return bundle;
}
/** @param {string} directory @param {string} id */
export function renderSavedReport(directory, id) {
  const report = renderResearchReport(loadResearchRun(directory, id));
  writeFileSync(join(resolve(directory), 'runs', id, 'report.md'), report, { mode: 0o600 });
  return report;
}
/** @param {string} directory @param {string} baseline @param {string} id */
export function compareSavedRuns(directory, baseline, id) { return compareResearch(loadResearchRun(directory, baseline), loadResearchRun(directory, id)); }

/** @param {{[key:string]:string|undefined}} [env] */
export async function discoverAgents(env = process.env) {
  return Promise.all(AGENT_ROUTES.map(async (route) => {
    try {
      const discovered = await discoverCli({ executable: env[route.pathEnv] || route.executable, helpArgsList: route.helpArgs, env });
      const missing = route.requiredFlags.filter((flag) => !discovered.help.includes(flag));
      const login = route.authArgs.length ? await probeAuthentication({ executable: discovered.executable, args: route.authArgs, env }) : null;
      return { id: route.id, provider: route.provider, label: route.label, executable: discovered.executable, installed: true, version: discovered.version,
        profile: route.profile, profileReady: missing.length === 0, configuredLogin: login?.authenticated ? 'available' : route.authArgs.length ? 'unavailable' : 'unverified', authentication: 'unverified',
        reason: missing.length ? 'Required invocation flags missing' : null,
        cost: null, remainingAllowance: null };
    } catch (error) {
      return { id: route.id, provider: route.provider, label: route.label, executable: null, installed: false, version: null,
        profile: route.profile, profileReady: false, configuredLogin: 'unavailable', authentication: 'unverified', reason: error instanceof AgentProcessError ? error.code : 'discovery_failed', cost: null, remainingAllowance: null };
    }
  }));
}

/** @param {string} directory @param {{discover?:(routes:Record[])=>Promise<Record[]>}} [options] */
export async function previewResearchRun(directory, options = {}) {
  const project = loadProject(directory);
  const panel = project.panels.find((/** @type {Record} */ p) => p.id === project.current.panel);
  const execution = project.executions.find((/** @type {Record} */ p) => p.id === project.current.execution);
  const analysis = project.analyses.find((/** @type {Record} */ p) => p.id === project.current.analysis);
  const routes = execution.routes.filter((/** @type {Record} */ route) => project.selectedRoutes.includes(route.id));
  if (!routes.length || !panel.questions.length) throw new ResearchError('selection_required', 'Save selected routes and neutral questions in project.json');
  if (routes.some((/** @type {Record} */ r) => !AGENT_ROUTES.some((a) => a.id === r.id))) throw new ResearchError('unsupported_route', 'Runtime execution requires supported selected account routes');
  for (const selected of routes) {
    const definition = agentRoute(selected.id);
    if (selected.profile !== definition.profile || selected.provider !== definition.provider) throw new ResearchError('execution_mismatch', 'Selected provider and profile must match the supported route');
  }
  if (panel.questions.some((/** @type {Record} */ q) => !questionIsNeutral(project.app, panel, q.text))) throw new ResearchError('branded_panel', 'Independent measurement questions must be neutral');
  for (const key of ['timeoutMs', 'idleTimeoutMs', 'maxOutputBytes']) if (!Number.isSafeInteger(execution[key])) throw new ResearchError('execution_limits_required', 'Runtime execution requires explicit process limits');
  const count = panel.questions.length * execution.samples * routes.length;
  if (count > 1000) throw new ResearchError('target_limit', 'Panel exceeds 1,000 targets');
  const identities = options.discover ? await options.discover(routes) : await Promise.all(routes.map(async (/** @type {Record} */ selected) => {
    const route = agentRoute(selected.id);
    try {
      const discovered = await discoverCli({ executable: selected.executable || route.executable, helpArgsList: route.helpArgs });
      if (route.requiredFlags.some((flag) => !discovered.help.includes(flag))) throw new AgentProcessError('unsupported_profile', 'Required restricted flags missing');
      return { id: route.id, executable: discovered.executable, version: discovered.version, profile: route.profile,
        profileHash: agentExecutionProfile(route.id).hash };
    } catch (error) { return { id: route.id, executable: selected.executable || route.executable, version: null, profile: route.profile, error: error instanceof AgentProcessError ? error.code : 'discovery_failed' }; }
  }));
  const snapshot = { app: project.app, panel, execution: { ...execution, routes }, analysis, identities, stanceRevision: STANCE_REVISION, annotationRevision: 'research-annotations-v1' };
  const quoteId = researchHash(snapshot);
  return { project, snapshot, quoteId, targetCount: count, maxDurationMs: Math.min(3_600_000, count * execution.timeoutMs + routes.length * 30_000),
    accountCost: null, remainingAllowance: null, searchCallCeiling: null,
    warning: 'Account allowance use; internal search count and possible charges are unknown. No API keys or billing fallback.' };
}

/** @param {string} directory @param {number} durationMs */
export function acquireResearchLock(directory, durationMs) {
  const lock = join(resolve(directory), '.run-lock');
  /** @param {()=>void} mutation */
  const serialized = (mutation) => {
    const db = new DatabaseSync(join(resolve(directory), '.runtime-lock.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS lock_guard(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE');
      mutation(); db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if (String(/** @type {Record} */ (error).message).includes('locked')) throw new ResearchError('run_locked', 'Another process is updating the project run lock');
      throw error;
    } finally { db.close(); }
  };
  const owner = { token: randomUUID(), pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + durationMs + 30_000).toISOString() };
  serialized(() => {
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch {
    let prior;
    try { prior = readJson(join(lock, 'owner.json')); }
    catch {
      if (Date.now() - statSync(lock).mtimeMs <= 3_630_000) throw new ResearchError('run_locked', 'Another process is claiming the project run lock');
      prior = { token: 'abandoned-claim', pid: 2147483647, hostname: hostname(), expiresAt: '1970-01-01T00:00:00Z' };
    }
    let alive = true;
    if (prior.hostname === hostname()) {
      try { process.kill(prior.pid, 0); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') alive = false; }
    }
    if (alive || Date.now() < Date.parse(prior.expiresAt)) throw new ResearchError('run_locked', 'A run owns this project or its execution window has not expired');
    const retired = `${lock}.expired-${prior.token}`;
    try { renameSync(lock, retired); mkdirSync(lock, { mode: 0o700 }); } catch { throw new ResearchError('run_locked', 'Another process recovered the project lock'); }
    rmSync(retired, { recursive: true, force: true });
  }
  writeJson(join(lock, 'owner.json'), owner);
  });
  return () => {
    serialized(() => { try { if (readJson(join(lock, 'owner.json')).token === owner.token) rmSync(lock, { recursive: true }); } catch {} });
  };
}

/** @param {Record} bundle @param {Record} sample @param {Record} result */
function captureResult(bundle, sample, result) {
  /** @param {string} type @param {Record} data */
  const add = (type, data) => {
    const item = { id: `${sample.id}-e${sample.evidenceIds.length + 1}`, type, timestamp: new Date().toISOString(), origin: sample.origin, capture: sample.capture, sampleId: sample.id, data };
    bundle.evidence.push(item); sample.evidenceIds.push(item.id); return item.id;
  };
  if (result.text) {
    const text = String(redactEvent(result.text));
    const answerId = add('answer', { text });
    const brands = [bundle.app, ...bundle.panel.competitors];
    const entities = brands.map((/** @type {Record} */ b, /** @type {number} */ index) => ({ id: index + 1, name: b.name, aliases: b.aliases, domains: b.url ? [new URL(b.url).hostname] : [] }));
    const ordered = [...text.matchAll(/^\s*(\d{1,3})[.)]\s+(.+)$/gm)].filter((line) => Number(line[1]) > 0);
    for (const mention of analyzeResponse(text, entities).mentions) {
      const explicit = mention.stance === 'positive' ? ordered.find((line) => analyzeResponse(line[2], entities).mentions.some((item) => item.entity_id === mention.entity_id && item.stance === 'positive')) : undefined;
      sample.mentions.push({ brandId: brands[mention.entity_id - 1].id, answerId,
        excerpt: explicit ? explicit[0].trim() : text.slice(mention.evidence_start, mention.evidence_end), positive: mention.stance === 'positive', position: explicit ? Number(explicit[1]) : null,
        confidence: mention.review_flags.includes('ambiguous_entity_name') ? 'uncertain' : 'certain', stance: mention.stance });
    }
  }
  for (const event of result.searchEvents ?? []) {
    if (event.eventType === 'search') for (const query of event.queries?.length ? event.queries : [event.query ?? null]) add('search_query', { query, actionId: event.actionId ?? null });
    add('tool_outcome', { tool: event.eventType, status: event.status, actionId: event.actionId ?? null });
    for (const source of event.results ?? []) add('returned_source', { url: source.url, title: source.title ?? null, rank: source.rank ?? null });
    if (event.eventType === 'fetch' && event.url && event.status === 'completed') add('fetched_page', { url: event.url, title: event.title ?? null });
  }
  for (const url of result.citations ?? []) add('final_citation', { url });
  sample.model = result.model ?? null;
  sample.usage.inputTokens = result.usage?.inputTokens ?? null;
  sample.usage.outputTokens = result.usage?.outputTokens ?? null;
}

/** @param {string} directory @param {{execute?:boolean,confirm?:string,signal?:AbortSignal,preview?:Awaited<ReturnType<typeof previewResearchRun>>,runnerFactory?:(id:string,options:any)=>any,runId?:string}} [options] */
export async function runResearchPanel(directory, options = {}) {
  const root = resolve(directory);
  const preview = options.preview ?? await previewResearchRun(root);
  if (!options.execute) return preview;
  const { project, snapshot, quoteId } = preview;
  if (snapshot.execution.routes.some((/** @type {Record} */ route) => {
    const identity = snapshot.identities.find((/** @type {Record} */ item) => item.id === route.id);
    return !identity?.version || !identity?.profileHash || identity.error;
  })) throw new ResearchError('unsupported_profile', 'A selected executable or isolated profile could not be verified; review a new preview after fixing readiness');
  if (researchHash(loadProject(root)) !== researchHash(project)) throw new ResearchError('execution_mismatch', 'Project changed after preview; review a new quote');
  const consentPath = join(root, 'consent.json');
  if (options.confirm === quoteId) writeJson(consentPath, { quoteId, targetCeiling: preview.targetCount, approvedAt: new Date().toISOString() });
  const consent = existsSync(consentPath) ? readJson(consentPath) : null;
  if (consent?.quoteId !== quoteId || consent?.targetCeiling < preview.targetCount) throw new ResearchError('consent_required', `Review the preview and confirm quote ${quoteId}`);
  const release = acquireResearchLock(root, preview.maxDurationMs);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, preview.maxDurationMs);
  const id = options.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) { release(); clearTimeout(timer); throw new ResearchError('invalid_run', 'Invalid run identifier'); }
  const runDirectory = join(root, 'runs', id);
  /** @type {Record} */
  const bundle = { schemaVersion: 1, runId: id, createdAt: new Date().toISOString(), mode: snapshot.panel.reviewedAt ? 'tracking' : 'exploratory',
    app: project.app, panel: snapshot.panel, execution: { ...snapshot.execution, id: `${snapshot.execution.id.slice(0, 60)}-${researchHash(snapshot.identities).slice(0, 16)}`,
      routes: snapshot.execution.routes.map((/** @type {Record} */ route) => {
        const identity = snapshot.identities.find((/** @type {Record} */ i) => i.id === route.id);
        return { ...route, executable: identity?.executable ?? null, cliVersion: identity?.version ?? null, profileHash: identity?.profileHash ?? null };
      }) },
    analysis: { id: `runtime-${STANCE_REVISION}-annotations-v1`, method: `hearsay-stance-${STANCE_REVISION}; research-annotations-v1` }, provenance: { producer: 'hearsay-runtime', limitations: ['Models, sources, costs and remaining allowance are unavailable unless exposed.', 'Automatic mention analysis is descriptive; recommendation positions require an explicit ordered answer.', 'Session isolation records fresh context, not exclusive web tool availability or identical user configurations. Other observed tool activity remains in the trace.'] },
    evidence: structuredClone(project.discoveryEvidence), samples: [], recommendations: [], traceEvents: [] };
  const persist = () => {
    validateEvidence(bundle);
    writeJson(join(runDirectory, 'evidence.json'), bundle);
    writeJson(join(runDirectory, 'execution-receipt.json'), { quoteId, evidenceHash: researchHash(bundle) });
    writeFileSync(join(runDirectory, 'report.md'), renderResearchReport(bundle), { mode: 0o600 });
  };
  try {
    mkdirSync(join(root, 'runs'), { recursive: true, mode: 0o700 });
    mkdirSync(runDirectory, { mode: 0o700 });
    mkdirSync(join(runDirectory, 'captures'), { mode: 0o700 });
    for (const route of snapshot.execution.routes) for (const question of snapshot.panel.questions) for (let index = 0; index < snapshot.execution.samples; index++) bundle.samples.push({
      id: `sample-${bundle.samples.length + 1}`, questionId: question.id, routeId: route.id, host: 'hearsay-runtime', provider: route.provider, model: null, profile: route.profile,
      startedAt: null, finishedAt: null, status: 'skipped', sessionIsolation: null, brandContext: null, origin: 'supported_cli_measurement', capture: 'runner_captured', evidenceIds: [], mentions: [],
      usage: { inputTokens: null, outputTokens: null, durationMs: null, cost: null, remainingAllowance: null }, errorCode: 'not_attempted' });
    persist();
    for (const route of snapshot.execution.routes) {
      let stopped = false;
      for (const sample of bundle.samples.filter((/** @type {Record} */ s) => s.routeId === route.id)) {
        if (controller.signal.aborted || stopped) { sample.errorCode = controller.signal.aborted ? 'cancelled' : 'route_stopped'; persist(); continue; }
        const question = snapshot.panel.questions.find((/** @type {Record} */ q) => q.id === sample.questionId);
        sample.startedAt = new Date().toISOString(); sample.errorCode = null;
        try {
          const identity = snapshot.identities.find((/** @type {Record} */ i) => i.id === route.id);
          const runner = (options.runnerFactory ?? createAgentRunner)(route.id, { executable: identity?.executable || route.executable || agentRoute(route.id).executable,
            dataDir: join(runDirectory, 'captures'), timeoutMs: snapshot.execution.timeoutMs, idleTimeoutMs: snapshot.execution.idleTimeoutMs, maxOutputBytes: snapshot.execution.maxOutputBytes });
          const result = await runner.run({ responseId: bundle.samples.indexOf(sample) + 1, promptText: question.text, promptOrigin: 'user_authored', languageControl: snapshot.execution.language, locationControl: snapshot.execution.location }, controller.signal);
          if (identity?.version && result.cliVersion && identity.version !== result.cliVersion || identity?.executable && result.cliExecutable && identity.executable !== result.cliExecutable || identity?.profileHash && result.executionProfileHash && identity.profileHash !== result.executionProfileHash) throw new ResearchError('execution_mismatch', 'Executable version or execution profile changed after preview');
          captureResult(bundle, sample, result);
          sample.sessionIsolation = result.sessionIsolation ?? null;
          sample.brandContext = result.brandContext ?? null;
          sample.status = result.errorCode ? result.text ? 'partial' : 'failed' : result.text ? 'completed' : 'failed';
          sample.errorCode = result.errorCode ?? (result.text ? null : 'answer_unavailable');
          if (result.capturedEvents) {
            const events = result.capturedEvents.map((/** @type {unknown} */ e) => redactEvent(e));
            writeFileSync(join(runDirectory, 'captures', `${sample.id}.jsonl`), events.map((/** @type {unknown} */ e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
            if (bundle.traceEvents.length + events.length <= 10000 && Buffer.byteLength(JSON.stringify(bundle)) + Buffer.byteLength(JSON.stringify(events)) < 7 * 1024 * 1024) bundle.traceEvents.push(...events);
            else if (!bundle.provenance.limitations.includes('Full trace retained in local captures only.')) bundle.provenance.limitations.push('Full trace retained in local captures only.');
          }
          stopped = /auth|quota|rate_limit|unsupported/.test(sample.errorCode ?? '');
        } catch (error) {
          sample.status = 'failed'; sample.errorCode = /** @type {Record} */ (error).code ?? 'execution_failed';
          if (error instanceof AgentProcessError && error.output) {
            if (/unauthenticated|authentication required|login required|not logged in|invalid.*credential/i.test(error.output.stderr)) sample.errorCode = 'authentication_failed';
            else if (/quota|rate.limit|resource.exhausted|usage.limit/i.test(error.output.stderr)) sample.errorCode = 'quota_exhausted';
            if (error.output.stdout) {
              writeFileSync(join(runDirectory, 'captures', `${sample.id}-partial.txt`), redactCapturedOutput(error.output.stdout), { mode: 0o600 });
              try {
                const partial = agentExecutionProfile(route.id).parser(error.output.stdout); captureResult(bundle, sample, partial); if (partial.text) sample.status = 'partial';
              } catch {}
            }
          }
          stopped = /auth|quota|rate_limit|unsupported/.test(sample.errorCode);
        }
        sample.finishedAt = new Date().toISOString(); sample.usage.durationMs = Date.parse(sample.finishedAt) - Date.parse(sample.startedAt);
        persist();
      }
    }
    const traces = readdirSync(join(runDirectory, 'captures')).filter((name) => name.endsWith('.jsonl')).map((name) => readFileSync(join(runDirectory, 'captures', name), 'utf8')).join('');
    if (traces) writeFileSync(join(runDirectory, 'trace.jsonl'), traces, { mode: 0o600 });
    return { runId: id, directory: runDirectory, summary: summarizeEvidence(bundle), evidence: bundle };
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); release(); }
}
