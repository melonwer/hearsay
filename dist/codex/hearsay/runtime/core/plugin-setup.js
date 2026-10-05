import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverAgents, loadProject, readJson, writeJson } from './research-workspace.js';
import { canonicalJson, ResearchError, validateProject, RESEARCH_MAX_BYTES } from './research-contract.js';
import { discoverCli, resolveExecutable } from './agent-process.js';
import { inspectTavilyUsage } from './tavily-search.js';

/** @typedef {Record<string, any>} SetupRecord */
const profileFields = ['appId', 'name', 'canonicalUrl', 'aliases', 'audience', 'jobs', 'geography', 'outcome'];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const secretField = /(?:api.?key|access.?token|refresh.?token|auth.?token|password|passwd|authorization|credentials?|secret|private.?key|tavily.?key|client.?key|session.?token|^token$|^key$|^cookie$|^auth$|bearer|oauth)/i;
const secretContent = /(?:Bearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAIza[A-Za-z0-9_-]{30,}|\bsk-[A-Za-z0-9_-]{20,}|\btvly-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|https?:\/\/[^\s/]+:[^\s/]+@|[?&](?:api[_-]?key|token|access_token|secret|password|key)=[^&\s]+)/i;

/** @param {boolean} valid @param {string} message @param {string} [code] */
function check(valid, message, code = 'invalid_setup') { if (!valid) throw new ResearchError(code, message); }
/** @param {unknown} value */
function rejectSecrets(value) {
  if (typeof value === 'string') check(!secretContent.test(value), 'Credential content is not allowed in setup', 'secret_rejected');
  else if (Array.isArray(value)) value.forEach(rejectSecrets);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    check(!secretField.test(key), 'Credential fields are not allowed in setup', 'secret_rejected'); rejectSecrets(entry);
  }
}
/** @param {unknown} value @returns {value is SetupRecord} */
function object(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
/** @param {SetupRecord} value @param {string[]} keys */
function only(value, keys) { check(Object.keys(value).every((key) => keys.includes(key)), 'Unsupported setup field'); }
/** @param {unknown} value */
function text(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 100000; }
/** @param {unknown} value */
function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}

/** @param {unknown} input @returns {SetupRecord} */
function validateInput(input) {
  check(object(input), 'Setup input must be an object');
  rejectSecrets(input);
  check(Buffer.byteLength(JSON.stringify(input)) <= RESEARCH_MAX_BYTES, 'Setup exceeds 8 MiB');
  const data = /** @type {SetupRecord} */ (input);
  only(data, ['schemaVersion', 'identity', 'profile', 'sources', 'provenance', 'project']);
  check(data.schemaVersion === 1, 'Unsupported setup version');
  check(object(data.identity) && data.identity.status === 'confirmed' && (!data.identity.candidates || (Array.isArray(data.identity.candidates) && data.identity.candidates.length <= 1)), 'Resolve app identity before saving setup', 'identity_ambiguous');
  only(data.identity, ['status', 'candidates']);
  check(object(data.profile), 'A product profile is required'); only(data.profile, profileFields);
  check(typeof data.profile.appId === 'string' && identifier.test(data.profile.appId) && text(data.profile.name), 'A stable app ID and product name are required');
  if (data.identity.candidates?.length) check(data.identity.candidates[0] === data.profile.appId, 'Conflicting app identity candidates', 'identity_ambiguous');
  const profile = Object.fromEntries(profileFields.map((field) => [field, data.profile[field] ?? null]));
  profile.aliases ??= [];
  check(profile.canonicalUrl === null || httpUrl(profile.canonicalUrl), 'Canonical URL must be a public HTTP URL');
  for (const field of ['audience', 'geography', 'outcome']) check(profile[field] === null || text(profile[field]), 'Invalid product profile value');
  for (const field of ['aliases', 'jobs']) check(profile[field] === null || (Array.isArray(profile[field]) && profile[field].length <= 50 && profile[field].every(text)), 'Invalid product profile list');
  check(Array.isArray(data.sources) && data.sources.length <= 10000, 'Sources must be an array');
  const sourceIds = new Set();
  for (const source of data.sources) {
    check(object(source), 'Invalid discovery source'); only(source, ['id', 'kind', 'url', 'path', 'summary', 'observedAt']);
    check(typeof source.id === 'string' && identifier.test(source.id) && !sourceIds.has(source.id), 'Invalid or duplicate discovery source ID'); sourceIds.add(source.id);
    check(['url', 'repository', 'session', 'workspace'].includes(source.kind), 'Unsupported discovery source kind');
    check(source.kind !== 'url' || httpUrl(source.url), 'URL sources need a public HTTP URL');
    check(source.url === undefined || httpUrl(source.url), 'Invalid source URL');
    check(source.path === undefined || text(source.path), 'Invalid source path');
    check(!['repository', 'workspace'].includes(source.kind) || text(source.path), 'Local sources need a path');
    check(source.summary === undefined || text(source.summary), 'Invalid source summary');
    check(source.observedAt === undefined || (typeof source.observedAt === 'string' && Number.isFinite(Date.parse(source.observedAt))), 'Invalid source timestamp');
  }
  check(Array.isArray(data.provenance) && data.provenance.length <= profileFields.length, 'Provenance must be an array');
  const fields = new Set();
  for (const entry of data.provenance) {
    check(object(entry), 'Invalid profile provenance'); only(entry, ['field', 'sourceIds']);
    check(profileFields.includes(entry.field) && !fields.has(entry.field), 'Invalid or duplicate provenance field'); fields.add(entry.field);
    check(Array.isArray(entry.sourceIds) && entry.sourceIds.length > 0 && new Set(entry.sourceIds).size === entry.sourceIds.length && entry.sourceIds.every((/** @type {string} */ id) => sourceIds.has(id)), 'Provenance has unresolved source IDs');
  }
  check(fields.has('name') && (profile.canonicalUrl === null || fields.has('canonicalUrl')), 'Known product identity needs discovery provenance');
  return { profile, sources: structuredClone(data.sources), provenance: structuredClone(data.provenance), project: data.project === undefined ? null : validateProject(data.project) };
}

/** @param {string} directory @returns {SetupRecord|null} */
export function readSetup(directory) {
  const file = join(resolve(directory), 'setup.json');
  if (!existsSync(file)) return null;
  const state = readJson(file);
  check(object(state), 'Invalid saved setup'); only(state, ['schemaVersion', 'profileVersion', 'identity', 'profile', 'sources', 'provenance', 'createdAt', 'updatedAt']);
  check(state.profileVersion === 1 && typeof state.createdAt === 'string' && typeof state.updatedAt === 'string' && Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)), 'Invalid saved setup version or timestamp');
  validateInput({ schemaVersion: state.schemaVersion, identity: state.identity, profile: state.profile, sources: state.sources, provenance: state.provenance });
  return state;
}

/** @param {SetupRecord} profile @param {SetupRecord} app */
function checkIdentity(profile, app) {
  check(profile.appId === app.id && profile.name.trim().toLowerCase() === app.name.trim().toLowerCase() && (!profile.canonicalUrl || !app.url || new URL(profile.canonicalUrl).href === new URL(app.url).href), 'Workspace belongs to a different product; choose its existing identity or a separate workspace', 'identity_conflict');
}

/** @param {string} directory @param {unknown} input @returns {SetupRecord} */
export function saveSetup(directory, input) {
  const data = validateInput(input); const root = resolve(directory);
  const prior = readSetup(root); const existing = existsSync(join(root, 'project.json')) ? loadProject(root) : null;
  if (prior) checkIdentity(data.profile, { id: prior.profile.appId, name: prior.profile.name, url: prior.profile.canonicalUrl });
  if (existing) checkIdentity(data.profile, existing.app);
  if (data.project) checkIdentity(data.profile, data.project.app);
  if (existing && data.project) check(canonicalJson(existing) === canonicalJson(data.project), 'Setup cannot overwrite existing project revisions', 'project_conflict');
  const now = new Date().toISOString();
  const state = { schemaVersion: 1, profileVersion: 1, identity: { status: 'confirmed' }, profile: data.profile,
    sources: data.sources, provenance: data.provenance, createdAt: prior?.createdAt ?? now, updatedAt: now };
  let project = existing ?? data.project;
  if (!project) {
    project = JSON.parse(readFileSync(new URL('../skill/templates/project.json', import.meta.url), 'utf8'));
    project.app = { id: data.profile.appId, name: data.profile.name, url: data.profile.canonicalUrl, aliases: data.profile.aliases,
      audience: data.profile.audience ?? 'Unknown', useCases: data.profile.jobs ?? [] };
    project.panels[0].createdAt = now;
    validateProject(project);
  }
  if (!existsSync(root)) {
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    const pending = join(dirname(root), `.setup-${randomUUID()}`); mkdirSync(pending, { mode: 0o700 });
    try { writeJson(join(pending, 'project.json'), project); writeJson(join(pending, 'setup.json'), state); renameSync(pending, root); }
    finally { rmSync(pending, { recursive: true, force: true }); }
  } else {
    if (!existing) writeJson(join(root, 'project.json'), project);
    writeJson(join(root, 'setup.json'), state);
  }
  return state;
}

/** @param {unknown} input @returns {SetupRecord} */
function hostCapabilities(input) {
  const capabilities = input ?? {};
  check(object(capabilities), 'Host capabilities must be an object'); rejectSecrets(capabilities);
  const data = /** @type {SetupRecord} */ (capabilities); only(data, ['filesystem', 'web', 'tasks']);
  for (const value of Object.values(data)) check(value === null || typeof value === 'boolean', 'Host capability values must be boolean or null');
  return { source: input ? 'host_reported' : 'unknown', filesystem: data.filesystem ?? null, web: data.web ?? null, tasks: data.tasks ?? null };
}

/** @param {unknown} value @param {Record<string,string|undefined>} env @returns {any} */
function scrubOutput(value, env) {
  if (typeof value === 'string') {
    let output = value;
    for (const [key, secret] of Object.entries(env)) if (secret && secretField.test(key)) output = output.split(secret).join('[REDACTED]');
    return output.replace(new RegExp(secretContent.source, 'gi'), '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((entry) => scrubOutput(entry, env));
  if (object(value)) return Object.fromEntries(Object.entries(/** @type {SetupRecord} */ (value)).map(([key, entry]) => [key, scrubOutput(entry, env)]));
  return value;
}

/** @param {{cwd?:string,project?:string,env?:Record<string,string|undefined>,host?:string,hostCapabilities?:unknown,
 * discoverAgents?:(env:Record<string,string|undefined>)=>Promise<SetupRecord[]>,
 * discoverGemini?:()=>Promise<{executable:string,version:string}>,nodeVersion?:string,platform?:string,
 * checkTavily?:boolean,fetch?:typeof globalThis.fetch,signal?:AbortSignal}} [options] */
export async function inspectSetup(options = {}) {
  const env = options.env ?? process.env; const cwd = resolve(options.cwd ?? process.cwd());
  const capabilities = hostCapabilities(options.hostCapabilities);
  const nodeVersion = options.nodeVersion ?? process.versions.node; const [major, minor] = nodeVersion.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 13);
  const records = [];
  const directories = options.project ? [resolve(options.project)] : existsSync(join(cwd, '.hearsay')) ? readdirSync(join(cwd, '.hearsay'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => join(cwd, '.hearsay', entry.name)) : [];
  for (const directory of directories) {
    if (!existsSync(join(directory, 'project.json'))) continue;
    try { const project = loadProject(directory); records.push({ directory, appId: project.app.id, name: project.app.name, url: project.app.url, setupSaved: existsSync(join(directory, 'setup.json')), status: 'available' }); }
    catch { records.push({ directory, appId: null, name: null, url: null, setupSaved: false, status: 'invalid_project' }); }
  }
  const routes = (await (options.discoverAgents ?? discoverAgents)(env)).map((route) => ({ id: route.id, provider: route.provider ?? null,
    label: route.label ?? null, executable: route.executable ?? null, version: route.version ?? null, installed: route.installed === true,
    profile: route.profile ?? null, profileReady: route.profileReady === true, configuredLogin: route.configuredLogin ?? 'unverified',
    authentication: 'unverified', measurementSupported: true, cost: null, remainingAllowance: null,
    status: !route.installed ? 'missing' : !route.profileReady ? 'unsupported_profile' : route.configuredLogin === 'available' ? 'available' : route.configuredLogin === 'unavailable' ? 'login_required' : 'authentication_unverified', reason: route.reason ?? null }));
  try {
    const gemini = await (options.discoverGemini ?? (() => discoverCli({ executable: env.HEARSAY_GEMINI_PATH || 'gemini', env, timeoutMs: 5000, maxOutputBytes: 64 * 1024 })))();
    routes.push({ id: 'gemini-cli', provider: 'gemini', label: 'Gemini CLI skill host', executable: gemini.executable, version: gemini.version, installed: true, profile: null, profileReady: false,
      configuredLogin: 'unverified', authentication: 'unverified', measurementSupported: false, cost: null, remainingAllowance: null, status: 'host_only', reason: 'Gemini CLI is a skill host; this runtime has no Gemini CLI measurement route' });
  } catch {
    routes.push({ id: 'gemini-cli', provider: 'gemini', label: 'Gemini CLI skill host', executable: null, version: null, installed: false, profile: null, profileReady: false,
      configuredLogin: 'unverified', authentication: 'unverified', measurementSupported: false, cost: null, remainingAllowance: null, status: 'missing', reason: 'executable_missing_or_probe_failed' });
  }
  let cronExecutable = null;
  if (['linux', 'darwin'].includes(options.platform ?? process.platform)) try { cronExecutable = resolveExecutable('crontab', env); } catch {}
  const keyPresent = Boolean(env.TAVILY_API_KEY?.trim());
  const usageProbe = options.checkTavily ? await inspectTavilyUsage({ apiKey: env.TAVILY_API_KEY ?? '', fetch: options.fetch, signal: options.signal }) : null;
  const tavily = { keyPresent, authentication: usageProbe?.status === 'available' ? 'verified' : usageProbe?.status === 'authentication_required' ? 'unavailable' : 'unverified',
    usage: usageProbe?.usage ?? null, usageStatus: usageProbe?.status ?? (keyPresent ? 'unverified' : 'unavailable') };
  const missingSteps = [];
  if (!supported) missingSteps.push({ code: 'runtime_upgrade_required', action: 'Install Node 22.13 or newer to enable collection and scheduling' });
  if (!records.some((record) => record.setupSaved)) missingSteps.push({ code: 'profile_required', action: 'Infer the product profile with discovery sources, resolve app identity, then run hearsay setup save' });
  if (!keyPresent) missingSteps.push({ code: 'tavily_key_missing', action: 'For optional Tavily research, configure TAVILY_API_KEY in the host environment and inspect again' });
  else if (usageProbe && usageProbe.status !== 'available') missingSteps.push({ code: `tavily_${usageProbe.status}`, action: 'Review Tavily account authentication, usage and provider limits before selecting paid research' });
  for (const route of routes) {
    if (route.status === 'login_required' && ['codex-agent', 'claude-code-agent'].includes(route.id)) missingSteps.push({ code: 'route_login_required', routeId: route.id, action: route.id === 'codex-agent' ? 'codex login' : 'claude auth login' });
    else if (route.installed && route.status === 'unsupported_profile') missingSteps.push({ code: 'route_profile_unsupported', routeId: route.id, action: 'Review the CLI restricted invocation flags before selecting this route' });
  }
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return scrubOutput({ schemaVersion: 1, pluginVersion: metadata.version,
    runtime: { nodeVersion, requiredNode: '>=22.13', supported, executable: process.execPath },
    host: { name: options.host ?? env.HEARSAY_HOST ?? null, capabilities }, workspace: { cwd, project: options.project ? resolve(options.project) : null, records }, routes,
    tavily,
    scheduler: { nativeTasks: capabilities.tasks, source: capabilities.source, runtimeTick: supported, cron: cronExecutable !== null, cronExecutable, installed: false }, missingSteps }, env);
}
