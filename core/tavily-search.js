import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** @typedef {{[key:string]:any}} Record */
/** @typedef {{id:string,text:string,angleId:string}} TavilyQuery */
/** @typedef {{accountDirectory:string,accountId:string,studyKey:string,allowance:number,collectionCredits:number,diagnosticCredits:number,occurrenceId:string,lane:'collection'|'diagnostic',queries:TavilyQuery[],searchDepth:'basic'|'advanced',maxResults:number,strictFreeMode:boolean,now?:string|Date|(()=>string),apiKey?:string,fetch?:typeof globalThis.fetch,signal?:AbortSignal}} TavilyOptions */
/** @typedef {{accountDirectory:string,accountId:string,reason:string,newBillingPeriod?:string,apiKey?:string,fetch?:typeof globalThis.fetch,now?:TavilyOptions['now']}} ReconciliationOptions */

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
/** @param {unknown} value */
function safeId(value) { return typeof value === 'string' && ID.test(value); }
/** @type {Map<string,Promise<Record>>} */
const active = new Map();

export class TavilyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'TavilyError'; this.code = code; }
}

/** @param {unknown} input */
function hash(input) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
/** @param {unknown} value */
function count(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** @param {TavilyOptions['now']} now */
function timestamp(now) {
  const date = new Date(typeof now === 'function' ? now() : now ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TavilyError('invalid_scope', 'A valid collection timestamp is required');
  return date.toISOString();
}

/** @param {TavilyOptions} options */
function validate(options) {
  const invalid = () => { throw new TavilyError('invalid_scope', 'Tavily requires valid reviewed queries, identity, limits and search settings'); };
  if (!options || typeof options.accountDirectory !== 'string' || !options.accountDirectory.trim() || !safeId(options.accountId) || !safeId(options.occurrenceId)
    || typeof options.studyKey !== 'string' || !options.studyKey.trim() || options.studyKey.length > 512
    || !['collection', 'diagnostic'].includes(options.lane) || !['basic', 'advanced'].includes(options.searchDepth)
    || typeof options.strictFreeMode !== 'boolean' || !Number.isSafeInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 20) invalid();
  for (const amount of [options.allowance, options.collectionCredits, options.diagnosticCredits]) if (!count(amount) || amount > 1_000_000) invalid();
  if (options.allowance < options.collectionCredits + options.diagnosticCredits || !Array.isArray(options.queries) || !options.queries.length || options.queries.length > 1000) invalid();
  const ids = new Set();
  const key = options.apiKey ?? process.env.TAVILY_API_KEY ?? '';
  if (typeof key !== 'string') invalid();
  for (const query of options.queries) {
    if (!query || Object.keys(query).some((field) => !['id', 'text', 'angleId'].includes(field)) || !safeId(query.id) || !safeId(query.angleId)
      || ids.has(query.id) || typeof query.text !== 'string' || !query.text.trim() || query.text.length > 4000 || /tvly-[a-z0-9_-]{12,}/i.test(query.text)
      || (key && query.text.includes(key))) invalid();
    ids.add(query.id);
  }
  if (key && [options.accountId, options.studyKey, options.occurrenceId, ...options.queries.flatMap((q) => [q.id, q.angleId])].some((field) => field.includes(key))) invalid();
  timestamp(options.now);
  return key;
}

/** @param {string} accountDirectory @param {string} accountId */
function accountPath(accountDirectory, accountId) {
  if (typeof accountDirectory !== 'string' || !accountDirectory.trim() || !safeId(accountId)) throw new TavilyError('invalid_scope', 'A shared account directory and safe account ID are required');
  return join(resolve(accountDirectory), 'tavily', accountId, 'ledger.sqlite');
}
/** @param {string} accountId @returns {Record} */
function emptyLedger(accountId) {
  return { version: 1, accountId, studies: {}, occurrences: {}, reservations: {}, usage: null, policy: null, keyPolicies: {}, accountFloor: 0, keyFloors: {}, halted: null, reconciliations: {} };
}

/** @template T @param {string} accountDirectory @param {string} accountId @param {(state:Record)=>T} mutate @returns {T} */
function transaction(accountDirectory, accountId, mutate) {
  const file = accountPath(accountDirectory, accountId);
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL); BEGIN IMMEDIATE');
    const row = /** @type {{state:string}|undefined} */ (db.prepare('SELECT state FROM ledger WHERE id=1').get());
    const state = row ? JSON.parse(row.state) : emptyLedger(accountId);
    if (state.version !== 1 || state.accountId !== accountId) throw new TavilyError('invalid_ledger', 'Account ledger identity is invalid');
    const result = mutate(state);
    db.prepare('INSERT INTO ledger(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(JSON.stringify(state));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}

/** @param {unknown} input @param {string} key @param {number} [depth] @returns {any} */
function redact(input, key, depth = 0) {
  if (depth > 32) return '[TRUNCATED]';
  if (typeof input === 'string') {
    let safe = input.replace(/tvly-[a-z0-9_-]{12,}/gi, '[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    if (key) for (const secret of new Set([key, encodeURIComponent(key)])) safe = safe.split(secret).join('[REDACTED]');
    return safe;
  }
  if (Array.isArray(input)) return input.map((value) => redact(value, key, depth + 1));
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([field, value]) => [redact(field, key), /^(?:api.?key|authorization|password|secret|access.?token|refresh.?token|cookie)$/i.test(field) ? '[REDACTED]' : redact(value, key, depth + 1)]));
  return input;
}

/** @param {typeof globalThis.fetch} fetch @param {string} path @param {string} key @param {AbortSignal|undefined} signal @param {Record|undefined} [body] */
async function request(fetch, path, key, signal, body) {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetch(`https://api.tavily.com/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: bounded });
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new TavilyError('invalid_response', 'Provider response exceeds 2 MiB'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, raw: redact(json ?? { body: text }, key) };
}

/** @param {number} status */
function httpCode(status) {
  if (status === 401 || status === 403) return 'authentication';
  if ([402, 429, 432, 433].includes(status)) return 'quota';
  return status >= 200 && status < 300 ? null : 'http_error';
}

/** @param {unknown} input @param {boolean} strict @returns {{usage:Record|null,error:string|null}} */
function parseUsage(input, strict) {
  const raw = /** @type {Record|null} */ (input);
  const key = raw?.key;
  const account = raw?.account;
  if (!key || !account || !count(key.usage) || !(key.limit === null || count(key.limit)) || typeof account.current_plan !== 'string' || !account.current_plan
    || !count(account.plan_usage) || !count(account.plan_limit) || !count(account.paygo_usage) || !(account.paygo_limit === null || count(account.paygo_limit))) return { usage: null, error: 'unknown_capacity' };
  const error = strict && (!['researcher', 'free'].includes(account.current_plan.toLowerCase()) || account.plan_limit > 1000 || account.paygo_usage !== 0 || account.paygo_limit !== 0) ? 'free_mode_unprotected' : null;
  if (!strict && account.paygo_limit === null && key.limit === null) return { usage: null, error: 'unknown_capacity' };
  return { usage: { accountUsage: account.plan_usage + account.paygo_usage, accountLimit: strict ? account.plan_limit : account.paygo_limit === null ? null : account.plan_limit + account.paygo_limit,
    keyUsage: key.usage, keyLimit: key.limit, accountPolicy: { currentPlan: account.current_plan, planLimit: account.plan_limit, paygoLimit: account.paygo_limit }, keyPolicy: { limit: key.limit } }, error };
}

/** @param {Record} state @param {string} keyId */
function remaining(state, keyId) {
  if (!state.usage?.[keyId]) return { account: null, key: null };
  const usage = state.usage[keyId];
  const pending = Object.values(state.reservations).filter((/** @type {Record} */ r) => r.state !== 'confirmed');
  const accountReserved = pending.reduce((sum, r) => sum + r.credits, 0);
  const keyReserved = pending.filter((r) => r.keyId === keyId).reduce((sum, r) => sum + r.credits, 0);
  return { account: usage.accountLimit === null ? null : Math.max(0, usage.accountLimit - Math.max(usage.accountUsage, state.accountFloor) - accountReserved),
    key: usage.keyLimit === null ? null : Math.max(0, usage.keyLimit - Math.max(usage.keyUsage, state.keyFloors[keyId] ?? 0) - keyReserved) };
}

/** @param {Record} state @param {Record} receipt @param {string|null} stopReason */
function summarize(state, receipt, stopReason) {
  const study = state.studies[receipt.studyKey];
  const occurrence = state.occurrences[receipt.id];
  const capacity = remaining(state, occurrence.keyId);
  return { spent: receipt.records.reduce((/** @type {number} */ sum, /** @type {Record} */ r) => sum + r.credits, 0), collectionSpent: study.spent.collection, diagnosticSpent: study.spent.diagnostic,
    remainingCollection: Math.max(0, study.scope.collectionCredits - study.spent.collection), remainingDiagnostic: Math.max(0, study.scope.diagnosticCredits - study.spent.diagnostic),
    remainingAllowance: Math.max(0, study.scope.allowance - study.spent.collection - study.spent.diagnostic), ambiguous: receipt.records.filter((/** @type {Record} */ r) => state.reservations[r.id]?.state === 'ambiguous').reduce((/** @type {number} */ sum, /** @type {Record} */ r) => sum + r.credits, 0),
    accountRemaining: capacity.account, keyRemaining: capacity.key, stopReason };
}

/** @param {Record} state @param {Record} occurrence @param {string} status @param {string|null} reason @param {string} at */
function finish(state, occurrence, status, reason, at) {
  occurrence.receipt.status = status;
  occurrence.receipt.completedAt = at;
  for (const record of occurrence.receipt.records) {
    if (record.status === 'reserved') { record.status = 'ambiguous'; record.errorCode = 'interrupted'; state.reservations[record.id].state = 'ambiguous'; }
    if (record.status === 'planned') { record.status = 'skipped'; record.errorCode = reason; }
  }
  occurrence.receipt.creditSummary = summarize(state, occurrence.receipt, reason);
  occurrence.done = true;
  return occurrence.receipt;
}

/** @param {Record} owner */
function ownerAlive(owner) {
  if (owner.hostname !== hostname()) return true;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH'; }
}

/** @param {string} accountDirectory @param {string} accountId */
export function inspectTavilyLedger(accountDirectory, accountId) {
  if (!existsSync(accountPath(accountDirectory, accountId))) return emptyLedger(accountId);
  return transaction(accountDirectory, accountId, (state) => {
    for (const occurrence of Object.values(state.occurrences)) if (!occurrence.done && !ownerAlive(occurrence.owner)) finish(state, occurrence, 'interrupted', 'interrupted', new Date().toISOString());
    return state;
  });
}

/** @param {ReconciliationOptions} options */
function validateRecovery(options) {
  accountPath(options?.accountDirectory, options?.accountId);
  const key = options.apiKey ?? process.env.TAVILY_API_KEY ?? '';
  if (typeof key !== 'string' || !key.trim()) throw new TavilyError('missing_key', 'TAVILY_API_KEY is required to inspect current account capacity');
  if (typeof options.reason !== 'string' || !options.reason.trim() || options.reason.length > 2000 || (options.newBillingPeriod !== undefined && !safeId(options.newBillingPeriod))) throw new TavilyError('invalid_scope', 'Recovery requires a reason and an optional explicit safe billing-period label');
  if ([options.reason, options.accountId, options.newBillingPeriod ?? ''].some((field) => field.includes(key) || /tvly-[a-z0-9_-]{12,}/i.test(field))) throw new TavilyError('invalid_scope', 'Recovery cannot retain credentials');
  timestamp(options.now);
  return key;
}

/** @param {Record} state @param {ReconciliationOptions} options @param {string} keyId @param {unknown} raw */
function reconciliationPreview(state, options, keyId, raw) {
  if (Object.values(state.occurrences).some((/** @type {Record} */ occurrence) => !occurrence.done && ownerAlive(occurrence.owner))) throw new TavilyError('reconciliation_active', 'Wait for active Tavily occurrences to stop before reconciling their account');
  if (options.newBillingPeriod && Object.values(state.reconciliations ?? {}).some((/** @type {Record} */ receipt) => receipt.newBillingPeriod === options.newBillingPeriod)) throw new TavilyError('billing_period_reused', 'This account already reconciled the declared billing period');
  const strictFreeMode = !Object.values(state.studies).length || Object.values(state.studies).some((/** @type {Record} */ study) => study.scope.strictFreeMode);
  const parsed = parseUsage(raw, strictFreeMode);
  if (!parsed.usage || parsed.error) throw new TavilyError(parsed.error ?? 'unknown_capacity', 'Fresh provider usage must establish safe capacity before account reconciliation');
  const snapshot = { version: 1, accountId: options.accountId, reason: options.reason.trim(), newBillingPeriod: options.newBillingPeriod ?? null, keyId, strictFreeMode, ledgerHash: hash(state) };
  return { quoteId: hash({ snapshot, usage: parsed.usage }), snapshot, usage: parsed.usage };
}

/** @param {ReconciliationOptions} options @param {string} key */
async function recoveryUsage(options, key) {
  let response;
  try { response = await request(options.fetch ?? globalThis.fetch, 'usage', key, undefined); }
  catch { throw new TavilyError('unknown_capacity', 'Fresh account usage could not be read'); }
  const code = httpCode(response.status);
  if (code) throw new TavilyError(code, 'Fresh account usage was rejected by the provider');
  return response;
}

/** @param {ReconciliationOptions} options */
export async function previewTavilyReconciliation(options) {
  options = { ...options };
  const key = validateRecovery(options);
  const response = await recoveryUsage(options, key);
  return transaction(options.accountDirectory, options.accountId, (state) => reconciliationPreview(state, options, hash(key), response.json));
}

/** @param {ReconciliationOptions & {confirm:string,author:string}} options @returns {Promise<Record>} */
export async function reconcileTavilyLedger(options) {
  options = { ...options };
  const key = validateRecovery(options);
  if (typeof options.confirm !== 'string' || !/^[a-f0-9]{64}$/.test(options.confirm) || typeof options.author !== 'string' || !options.author.trim() || options.author.length > 200 || options.author.includes(key) || /tvly-[a-z0-9_-]{12,}/i.test(options.author)) throw new TavilyError('reconciliation_quote_changed', 'An exact owner-reviewed quote and author are required');
  const keyId = hash(key);
  const receiptId = `reconciliation-${options.confirm.slice(0, 24)}`;
  /** @param {Record} receipt */
  const verifiedReceipt = (receipt) => {
    if (receipt.author !== options.author.trim() || receipt.reason !== options.reason.trim() || receipt.newBillingPeriod !== (options.newBillingPeriod ?? null) || receipt.keyId !== keyId) throw new TavilyError('reconciliation_quote_changed', 'A completed reconciliation cannot change its approved scope');
    return receipt;
  };
  const cached = transaction(options.accountDirectory, options.accountId, (state) => state.reconciliations?.[receiptId] ?? null);
  if (cached) return verifiedReceipt(cached);
  const response = await recoveryUsage(options, key);
  return transaction(options.accountDirectory, options.accountId, (state) => {
    if (state.reconciliations?.[receiptId]) return verifiedReceipt(state.reconciliations[receiptId]);
    const preview = reconciliationPreview(state, options, keyId, response.json);
    if (preview.quoteId !== options.confirm) throw new TavilyError('reconciliation_quote_changed', 'Provider usage or the account ledger changed after the recovery preview');
    const receipt = { version: 1, id: receiptId, accountId: options.accountId, keyId, quoteId: options.confirm, author: options.author.trim(), reason: options.reason.trim(), newBillingPeriod: options.newBillingPeriod ?? null,
      at: timestamp(options.now), priorLedgerHash: preview.snapshot.ledgerHash, previousHalt: state.halted, previousPolicy: state.policy, previousAccountFloor: state.accountFloor, previousKeyFloors: { ...state.keyFloors }, usage: preview.usage, raw: response.raw };
    for (const occurrence of Object.values(state.occurrences)) if (!occurrence.done) finish(state, occurrence, 'interrupted', 'interrupted', timestamp(options.now));
    if (options.newBillingPeriod) {
      state.accountFloor = preview.usage.accountUsage;
      state.keyFloors = { [keyId]: preview.usage.keyUsage };
      state.usage = {};
    } else {
      state.accountFloor = Math.max(state.accountFloor, preview.usage.accountUsage);
      state.keyFloors[keyId] = Math.max(state.keyFloors[keyId] ?? 0, preview.usage.keyUsage);
    }
    state.policy = preview.usage.accountPolicy;
    state.keyPolicies[keyId] = preview.usage.keyPolicy;
    state.usage ??= {};
    state.usage[keyId] = { ...preview.usage, at: timestamp(options.now), raw: response.raw };
    state.halted = null;
    state.reconciliations ??= {};
    state.reconciliations[receiptId] = receipt;
    return receipt;
  });
}

/** @param {TavilyOptions} options @returns {Promise<Record>} */
export async function collectTavily(options) {
  const key = validate(options);
  options = { ...options, queries: options.queries.map((query) => ({ ...query })) };
  const keyId = hash(key);
  const scope = { allowance: options.allowance, collectionCredits: options.collectionCredits, diagnosticCredits: options.diagnosticCredits, searchDepth: options.searchDepth, maxResults: options.maxResults, strictFreeMode: options.strictFreeMode };
  const scopeHash = hash(scope);
  const queryHash = hash(options.queries);
  const requestHash = hash({ scopeHash, queryHash, lane: options.lane });
  const id = `tavily-${hash({ studyKey: options.studyKey, occurrenceId: options.occurrenceId, lane: options.lane }).slice(0, 24)}`;
  const activeId = `${accountPath(options.accountDirectory, options.accountId)}:${id}`;
  const claim = transaction(options.accountDirectory, options.accountId, (state) => {
    let study = state.studies[options.studyKey];
    if (study && (study.scopeHash !== scopeHash || (options.lane === 'collection' && study.queryHash && study.queryHash !== queryHash))) throw new TavilyError('scope_changed', 'Use a new reviewed study plan identity for changed Tavily scope');
    if (!study) study = state.studies[options.studyKey] = { scopeHash, scope, queryHash: null, spent: { collection: 0, diagnostic: 0 } };
    if (options.lane === 'collection') study.queryHash = queryHash;
    const existing = state.occurrences[id];
    if (existing) {
      if (existing.requestHash !== requestHash) throw new TavilyError('scope_changed', 'An occurrence cannot change its frozen request scope');
      if (!existing.done && !ownerAlive(existing.owner)) finish(state, existing, 'interrupted', 'interrupted', timestamp(options.now));
      return { created: false, receipt: existing.receipt };
    }
    const receipt = { version: 1, id, studyKey: options.studyKey, occurrenceId: options.occurrenceId, lane: options.lane, status: 'in_progress', startedAt: timestamp(options.now), completedAt: null, searchDepth: options.searchDepth,
      records: options.queries.map((query, index) => ({ id: `${id}-q${index + 1}`, questionId: query.id, angleId: query.angleId, query: query.text, status: 'planned', requestId: null, credits: 0, raw: null, results: [], errorCode: null })), creditSummary: {} };
    state.occurrences[id] = { requestHash, keyId, owner: { token: randomUUID(), pid: process.pid, hostname: hostname() }, done: false, receipt };
    receipt.creditSummary = summarize(state, receipt, null);
    return { created: true, receipt };
  });
  if (!claim.created) return active.get(activeId) ?? claim.receipt;
  const promise = Promise.resolve().then(() => run(options, key, keyId, id)).finally(() => active.delete(activeId));
  active.set(activeId, promise);
  return promise;
}

/** @param {TavilyOptions} options @param {string} key @param {string} keyId @param {string} id @returns {Promise<Record>} */
async function run(options, key, keyId, id) {
  const mutate = /** @template T @param {(state:Record)=>T} fn */ (fn) => transaction(options.accountDirectory, options.accountId, fn);
  const end = /** @param {string} status @param {string|null} reason */ (status, reason) => mutate((state) => finish(state, state.occurrences[id], status, reason, timestamp(options.now)));
  if (options.signal?.aborted) return end('interrupted', 'interrupted');
  if (!key.trim()) return end('paused', 'missing_key');
  if (mutate((state) => state.halted)) return end('paused', mutate((state) => state.halted.code));
  const fetch = options.fetch ?? globalThis.fetch;
  let usageResponse;
  try { usageResponse = await request(fetch, 'usage', key, options.signal); }
  catch { return end(options.signal?.aborted ? 'interrupted' : 'paused', options.signal?.aborted ? 'interrupted' : 'unknown_capacity'); }
  const code = httpCode(usageResponse.status);
  if (code) {
    if (code === 'authentication' || code === 'quota') mutate((state) => { state.halted = { code, at: timestamp(options.now) }; });
    return end('paused', code);
  }
  const parsed = parseUsage(usageResponse.json, options.strictFreeMode);
  if (!parsed.usage) return end('paused', parsed.error);
  const usage = parsed.usage;
  const policyError = mutate((state) => {
    if ((state.policy && hash(state.policy) !== hash(usage.accountPolicy)) || (state.keyPolicies[keyId] && hash(state.keyPolicies[keyId]) !== hash(usage.keyPolicy))) {
      state.halted = { code: 'policy_changed', at: timestamp(options.now) };
      return 'policy_changed';
    }
    if (parsed.error) return parsed.error;
    state.policy = usage.accountPolicy;
    state.keyPolicies[keyId] = usage.keyPolicy;
    state.usage ??= {};
    state.usage[keyId] = { ...usage, at: timestamp(options.now), raw: usageResponse.raw };
    state.accountFloor = Math.max(state.accountFloor, usage.accountUsage);
    state.keyFloors[keyId] = Math.max(state.keyFloors[keyId] ?? 0, usage.keyUsage);
    return null;
  });
  if (policyError) return end('paused', policyError);
  const credits = options.searchDepth === 'advanced' ? 2 : 1;
  let completed = 0;
  for (let index = 0; index < options.queries.length; index++) {
    if (options.signal?.aborted) return end('interrupted', 'interrupted');
    const reservation = mutate((state) => {
      if (state.halted) return { error: state.halted.code };
      const study = state.studies[options.studyKey];
      if (study.spent[options.lane] + credits > study.scope[options.lane === 'collection' ? 'collectionCredits' : 'diagnosticCredits']) return { error: `${options.lane}_allowance` };
      if (study.spent.collection + study.spent.diagnostic + credits > study.scope.allowance) return { error: 'study_allowance' };
      const capacity = remaining(state, keyId);
      if ((capacity.account !== null && capacity.account < credits) || (capacity.key !== null && capacity.key < credits)) return { error: 'account_capacity' };
      if (capacity.account === null && capacity.key === null) return { error: 'unknown_capacity' };
      const record = state.occurrences[id].receipt.records[index];
      const pending = Object.values(state.reservations).filter((/** @type {Record} */ r) => r.state !== 'confirmed');
      state.reservations[record.id] = { id: record.id, occurrenceId: id, studyKey: options.studyKey, lane: options.lane, keyId, credits, state: 'reserved', at: timestamp(options.now),
        accountBefore: Math.max(usage.accountUsage, state.accountFloor) + pending.reduce((sum, r) => sum + r.credits, 0),
        keyBefore: Math.max(usage.keyUsage, state.keyFloors[keyId] ?? 0) + pending.filter((r) => r.keyId === keyId).reduce((sum, r) => sum + r.credits, 0) };
      record.status = 'reserved'; record.credits = credits;
      study.spent[options.lane] += credits;
      return { error: null };
    });
    if (reservation.error) return end(completed ? 'partial' : 'paused', reservation.error);
    /** @type {Awaited<ReturnType<typeof request>>|undefined} */
    let response;
    let networkError = null;
    try { response = await request(fetch, 'search', key, options.signal, { query: options.queries[index].text, search_depth: options.searchDepth, auto_parameters: false, include_answer: false, include_usage: true, max_results: options.maxResults }); }
    catch (error) { networkError = error instanceof TavilyError ? error.code : options.signal?.aborted ? 'interrupted' : 'ambiguous_network'; }
    const result = response ? parseSearch(response.json, credits, options.maxResults) : { results: [], error: networkError, reportedCredits: null };
    const failure = response ? httpCode(response.status) ?? result.error : networkError;
    mutate((state) => {
      const record = state.occurrences[id].receipt.records[index];
      const entry = state.reservations[record.id];
      const charged = Math.max(credits, result.reportedCredits ?? credits);
      state.studies[options.studyKey].spent[options.lane] += charged - credits;
      record.credits = charged;
      entry.credits = charged;
      entry.state = result.reportedCredits === null ? 'ambiguous' : 'confirmed';
      if (entry.state === 'confirmed') {
        state.accountFloor = Math.max(state.accountFloor, entry.accountBefore + charged);
        state.keyFloors[keyId] = Math.max(state.keyFloors[keyId] ?? 0, entry.keyBefore + charged);
      }
      record.status = failure ? entry.state === 'ambiguous' ? 'ambiguous' : 'failed' : 'completed';
      record.requestId = response && typeof response.json?.request_id === 'string' ? redact(response.json.request_id, key) : null;
      record.raw = response?.raw ?? null;
      record.results = redact(result.results, key);
      record.errorCode = failure;
      if (['authentication', 'quota', 'pricing_changed'].includes(failure ?? '')) state.halted = { code: failure, at: timestamp(options.now) };
    });
    if (failure) return end(options.signal?.aborted ? 'interrupted' : completed ? 'partial' : 'failed', failure);
    completed++;
  }
  return end('completed', null);
}

/** @param {unknown} input @param {number} expectedCredits @param {number} maxResults @returns {{results:Record[],error:string|null,reportedCredits:number|null}} */
function parseSearch(input, expectedCredits, maxResults) {
  const raw = /** @type {Record|null} */ (input);
  const reportedCredits = count(raw?.usage?.credits) ? raw?.usage?.credits : null;
  if (reportedCredits !== null && reportedCredits !== expectedCredits) return { results: [], error: 'pricing_changed', reportedCredits };
  if (!raw || typeof raw.request_id !== 'string' || !raw.request_id || raw.request_id.length > 512 || !Array.isArray(raw.results) || raw.results.length > maxResults) return { results: [], error: 'invalid_response', reportedCredits };
  /** @type {Record[]} */
  const results = [];
  for (const value of raw.results) {
    if (!value || typeof value.url !== 'string' || value.url.length > 8192 || typeof value.title !== 'string' || typeof value.content !== 'string' || typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) return { results: [], error: 'invalid_response', reportedCredits };
    try { if (!['http:', 'https:'].includes(new URL(value.url).protocol)) throw new Error(); } catch { return { results: [], error: 'invalid_response', reportedCredits }; }
    results.push({ url: value.url, title: value.title, content: value.content, score: value.score });
  }
  return { results, error: null, reportedCredits };
}
