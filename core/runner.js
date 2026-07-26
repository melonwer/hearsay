/**
 * Panel execution engine (§8.1).
 *
 * One panel run = every active prompt × every enabled provider × `config.samples`
 * samples. Runs are serialised (one at a time, process-wide and database-wide), executed
 * through a small concurrency pool, and each response is written with its analysis in a
 * single transaction so the database never holds a response without its mentions.
 *
 * Failure philosophy: a provider erroring is data, not a crash. Every failed call becomes
 * a `responses` row with a classified `error`, which is what makes the provider status
 * line on the dashboard honest. Only a run where *every* call failed is marked `failed`.
 */

import { config as processConfig } from './config.js';
import { all, get, isoNow, run as dbRun, transaction } from './db.js';
import { costUsd } from './cost.js';
import { ProviderError } from './providers/shared.js';
import { adapters as defaultAdapters } from './providers/index.js';
// Namespace imports: these modules belong to another lane and may still be stubs while
// Lane A is in flight. A namespace import never fails to resolve, so the runner stays
// importable and testable with injected implementations.
import * as analyzeModule from './analyze.js';
import * as alertsModule from './alerts.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').ProviderId} ProviderId */
/** @typedef {import('./providers/shared.js').ProviderResult} ProviderResult */
/** @typedef {Record<string, {runPrompt: (text: string, opts?: {model?: string, timeoutMs?: number, apiKey?: string}) => Promise<ProviderResult>}>} AdapterMap */

/** Refused because demo mode is on: no live provider calls, ever (§4.1, §8.1). */
export class DemoModeError extends Error {
  constructor(message = 'Demo mode is on — live provider calls are disabled. Set HEARSAY_DEMO=0 to run a panel.') {
    super(message);
    this.name = 'DemoModeError';
  }
}

/** Refused because a run is already in flight (§8.1 step 1). */
export class RunInProgressError extends Error {
  /** @param {number|null} [runId] */
  constructor(runId = null) {
    super(runId === null ? 'A panel run is already in progress.' : `Panel run ${runId} is already in progress.`);
    this.name = 'RunInProgressError';
    /** @type {number|null} */
    this.runId = runId;
  }
}

/** A `running` row older than this was orphaned by a crash or a kill (§8.1 step 1). */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

/** Consecutive auth/quota errors from one provider before we stop calling it (§8.1 step 4). */
export const CIRCUIT_THRESHOLD = 3;

/** The `responses.error` value written for calls skipped by an open circuit (§8.1 step 4). */
export const SKIPPED_CIRCUIT = 'skipped:circuit';

/** In-process mutex. The DB check below covers other processes; this covers this one. */
/** @type {Promise<RunSummary>|null} */
let inFlight = null;

/** @returns {boolean} */
export function isRunning() {
  return inFlight !== null;
}

/**
 * Mark orphaned `running` rows as failed. Called at boot and again at the start of every
 * run, so a crashed process can never wedge the mutex permanently.
 *
 * @param {Db} db
 * @param {{now?: Date, maxAgeMs?: number}} [opts]
 * @returns {number} rows recovered
 */
export function recoverStaleRuns(db, opts = {}) {
  const now = opts.now ?? new Date();
  const maxAgeMs = opts.maxAgeMs ?? STALE_RUN_MS;
  const cutoff = isoNow(new Date(now.getTime() - maxAgeMs));
  const result = dbRun(
    db,
    "UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running' AND started_at < ?",
    [isoNow(now), 'abandoned: process exited before the run finished', cutoff],
  );
  return result.changes;
}

/**
 * @typedef {Object} Task
 * @property {number} promptId
 * @property {string} promptText
 * @property {ProviderId|string} provider
 * @property {string} model
 * @property {number} sampleIdx
 */

/**
 * @typedef {Object} ProviderTally
 * @property {number} ok
 * @property {number} errors
 * @property {number} skipped
 * @property {number|null} costUsd null when nothing priced was recorded
 * @property {boolean} circuitOpen
 */

/**
 * @typedef {Object} RunSummary
 * @property {number} runId
 * @property {string} trigger
 * @property {'done'|'failed'} status
 * @property {number} totalCalls
 * @property {number} doneCalls
 * @property {number} okCalls
 * @property {number} errorCalls
 * @property {number} skippedCalls
 * @property {number|null} costUsd total of the priced responses, null when none were priced
 * @property {string} startedAt UTC ISO-8601
 * @property {string} finishedAt UTC ISO-8601
 * @property {Record<string, ProviderTally>} byProvider
 */

/**
 * @param {Db} db
 * @returns {{id: number, name: string, aliases: string[], domains: string[]}[]}
 */
function loadEntities(db) {
  return all(db, 'SELECT id, name, aliases, domains FROM entities WHERE archived_at IS NULL ORDER BY id').map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    aliases: parseJsonArray(row.aliases),
    domains: parseJsonArray(row.domains),
  }));
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseJsonArray(value) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Analyzer results are Lane B's shape; accept either camelCase or the column names so a
 * naming difference between lanes cannot silently drop mentions.
 *
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 * @returns {unknown}
 */
function pick(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

/**
 * Execute a panel run.
 *
 * Everything the run touches is injectable so tests can drive it with a fake adapter and
 * a temp database, and so §8.1's "alerts.evaluate hook" stays a seam rather than a hard
 * dependency on another lane.
 *
 * @param {Object} options
 * @param {Db} options.db
 * @param {'cron'|'manual'|'api'|'seed'} [options.trigger]
 * @param {Config} [options.config]
 * @param {AdapterMap} [options.adapters]
 * @param {(text: string, entities: unknown[], nativeCitations?: {url:string}[]) => {mentions: Record<string, unknown>[], citations: Record<string, unknown>[]}} [options.analyzeResponse]
 * @param {(runId: number, db?: Db) => unknown} [options.evaluateAlerts]
 * @param {() => Date} [options.now]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {(message: string) => void} [options.log] non-fatal diagnostics; stderr by default
 * @returns {Promise<RunSummary>}
 */
export async function runPanel(options) {
  if (inFlight) throw new RunInProgressError();
  const promise = executeRun(options).finally(() => {
    inFlight = null;
  });
  inFlight = promise;
  return promise;
}

/**
 * @param {Parameters<typeof runPanel>[0]} options
 * @returns {Promise<RunSummary>}
 */
async function executeRun(options) {
  const {
    db,
    trigger = 'manual',
    config = processConfig,
    adapters = /** @type {AdapterMap} */ (defaultAdapters),
    analyzeResponse = analyzeModule.analyzeResponse,
    evaluateAlerts = alertsModule.evaluate,
    now = () => new Date(),
    env = process.env,
    log = (message) => process.stderr.write(`${message}\n`),
  } = options;

  if (config.demo) throw new DemoModeError();
  if (typeof analyzeResponse !== 'function') {
    throw new TypeError('runPanel needs an analyzeResponse implementation (core/analyze.js, §6.1).');
  }

  recoverStaleRuns(db, { now: now() });
  const existing = get(db, "SELECT id FROM runs WHERE status = 'running' ORDER BY id LIMIT 1");
  if (existing) throw new RunInProgressError(Number(existing.id));

  const providers = config.enabledProviders;
  const prompts = all(db, 'SELECT id, text FROM prompts WHERE active = 1 ORDER BY id');
  const entities = loadEntities(db);

  /** @type {Task[]} */
  const tasks = [];
  for (const prompt of prompts) {
    for (const provider of providers) {
      for (let sampleIdx = 0; sampleIdx < config.samples; sampleIdx += 1) {
        tasks.push({
          promptId: Number(prompt.id),
          promptText: String(prompt.text),
          provider: provider.id,
          model: provider.model,
          sampleIdx,
        });
      }
    }
  }

  const startedAt = isoNow(now());
  const runId = dbRun(db, 'INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?, ?, ?, ?, 0)', [
    startedAt,
    trigger,
    'running',
    tasks.length,
  ]).lastInsertRowid;

  /** @type {Record<string, ProviderTally>} */
  const byProvider = {};
  for (const provider of providers) {
    byProvider[provider.id] = { ok: 0, errors: 0, skipped: 0, costUsd: null, circuitOpen: false };
  }
  /** @type {Map<string, number>} */
  const consecutiveFatal = new Map();

  let okCalls = 0;
  let errorCalls = 0;
  let skippedCalls = 0;
  let totalCost = 0;
  let anyPriced = false;

  /**
   * @param {string} provider
   * @param {number|null} cost
   * @returns {void}
   */
  function addCost(provider, cost) {
    if (cost === null) return;
    anyPriced = true;
    totalCost += cost;
    const tally = byProvider[provider];
    tally.costUsd = (tally.costUsd ?? 0) + cost;
  }

  /**
   * One task: call the provider, write exactly one `responses` row, and — on success —
   * its mentions and citations in the same transaction.
   *
   * @param {Task} task
   * @returns {Promise<void>}
   */
  async function runTask(task) {
    const tally = byProvider[task.provider];
    if (tally.circuitOpen) {
      dbRun(
        db,
        'INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
        [runId, task.promptId, task.provider, task.model, task.sampleIdx, SKIPPED_CIRCUIT, isoNow(now())],
      );
      tally.skipped += 1;
      skippedCalls += 1;
      return;
    }

    const adapter = adapters[task.provider];
    /** @type {ProviderResult|null} */
    let result = null;
    /** @type {ProviderError|null} */
    let failure = null;

    try {
      if (!adapter || typeof adapter.runPrompt !== 'function') {
        throw new ProviderError('other', `No adapter registered for provider "${task.provider}"`);
      }
      result = await adapter.runPrompt(task.promptText, { model: task.model, timeoutMs: config.timeoutMs });
    } catch (err) {
      failure =
        err instanceof ProviderError
          ? err
          : new ProviderError('other', 'Adapter threw', err instanceof Error ? err.message : String(err));
    }

    if (failure) {
      dbRun(
        db,
        'INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
        [runId, task.promptId, task.provider, task.model, task.sampleIdx, failure.toStorage(), isoNow(now())],
      );
      tally.errors += 1;
      errorCalls += 1;

      // Circuit breaker: only auth and quota errors count, and only consecutively —
      // those are the two kinds that will not fix themselves inside one run. Anything
      // else (a timeout, a 500) resets the streak.
      if (failure.kind === 'auth' || failure.kind === 'quota') {
        const streak = (consecutiveFatal.get(task.provider) ?? 0) + 1;
        consecutiveFatal.set(task.provider, streak);
        if (streak >= CIRCUIT_THRESHOLD) {
          tally.circuitOpen = true;
          log(`hearsay: skipping remaining ${task.provider} calls after ${streak} consecutive ${failure.kind} errors`);
        }
      } else {
        consecutiveFatal.set(task.provider, 0);
      }
      return;
    }

    const answer = /** @type {ProviderResult} */ (result);
    consecutiveFatal.set(task.provider, 0);
    const tokensIn = answer.tokens?.input ?? null;
    const tokensOut = answer.tokens?.output ?? null;
    // Prefer the model the API echoed (that is what was billed); fall back to the model
    // we requested when the echo is a variant the price table does not carry.
    const cost =
      costUsd({ provider: task.provider, model: answer.model, tokensIn, tokensOut }, env) ??
      costUsd({ provider: task.provider, model: task.model, tokensIn, tokensOut }, env);

    const analysis = analyzeResponse(answer.text, entities, answer.citations ?? []);
    const createdAt = isoNow(now());

    // Synchronous on purpose — an `await` between BEGIN and COMMIT would let another
    // worker interleave into this transaction.
    transaction(db, () => {
      const responseId = dbRun(
        db,
        `INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, latency_ms, tokens_in, tokens_out, cost_usd, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          task.promptId,
          task.provider,
          answer.model || task.model,
          task.sampleIdx,
          answer.text,
          Number.isFinite(answer.latencyMs) ? Math.round(answer.latencyMs) : null,
          tokensIn,
          tokensOut,
          cost,
          createdAt,
        ],
      ).lastInsertRowid;

      for (const mention of analysis?.mentions ?? []) {
        dbRun(
          db,
          `INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
          [
            responseId,
            Number(pick(mention, ['entityId', 'entity_id']) ?? 0),
            Number(pick(mention, ['firstIndex', 'first_index']) ?? 0),
            Number(pick(mention, ['occurrences']) ?? 1),
            Number(pick(mention, ['rank']) ?? 1),
            pick(mention, ['recommended']) ? 1 : 0,
            String(pick(mention, ['snippet']) ?? ''),
          ],
        );
      }

      for (const citation of analysis?.citations ?? []) {
        const entityId = pick(citation, ['entityId', 'entity_id']);
        dbRun(db, 'INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES(?, ?, ?, ?, ?)', [
          responseId,
          String(pick(citation, ['url']) ?? ''),
          String(pick(citation, ['domain']) ?? ''),
          Number(pick(citation, ['rank']) ?? 1),
          entityId === undefined ? null : Number(entityId),
        ]);
      }
    });

    tally.ok += 1;
    okCalls += 1;
    addCost(task.provider, cost);
  }

  // Concurrency pool (§8.1 step 3): `config.concurrency` workers pulling from one queue.
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(config.concurrency, tasks.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try {
        await runTask(task);
      } catch (err) {
        // A throw here means storage failed, not the provider. Record it and keep going;
        // one bad row must not abandon the rest of the panel.
        errorCalls += 1;
        byProvider[task.provider].errors += 1;
        log(`hearsay: failed to record ${task.provider} response: ${err instanceof Error ? err.message : String(err)}`);
      }
      dbRun(db, 'UPDATE runs SET done_calls = done_calls + 1 WHERE id = ?', [runId]);
    }
  });
  await Promise.all(workers);

  // Finalise (§8.1 step 5). `failed` only when every call errored — a partial panel is
  // still usable data, and the provider cards show which engine was down.
  const status = tasks.length > 0 && okCalls === 0 ? 'failed' : 'done';
  const finishedAt = isoNow(now());
  dbRun(db, 'UPDATE runs SET status = ?, finished_at = ? WHERE id = ?', [status, finishedAt, runId]);

  if (typeof evaluateAlerts === 'function') {
    try {
      await evaluateAlerts(runId, db);
    } catch (err) {
      // Alerting is a read-side convenience; a bug there must not lose a completed run.
      log(`hearsay: alert evaluation failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const doneRow = get(db, 'SELECT done_calls FROM runs WHERE id = ?', [runId]);

  return {
    runId,
    trigger,
    status,
    totalCalls: tasks.length,
    doneCalls: Number(doneRow?.done_calls ?? 0),
    okCalls,
    errorCalls,
    skippedCalls,
    costUsd: anyPriced ? totalCost : null,
    startedAt,
    finishedAt,
    byProvider,
  };
}
