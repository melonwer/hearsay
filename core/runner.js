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
import { priceUsage, summarizeComputedCosts } from './cost.js';
import { ProviderError } from './providers/shared.js';
import { adapters as defaultAdapters } from './providers/index.js';
import { benchmarkRevision, executionProfile } from './measurement-contract.js';
import { apiExecutionBudget } from './execution-budget.js';
import { EVIDENCE_LIMITS, storeMeasurementEvidence, storeTargetDefinition } from './measurement-storage.js';
// Namespace imports: these modules belong to another lane and may still be stubs while
// Lane A is in flight. A namespace import never fails to resolve, so the runner stays
// importable and testable with injected implementations.
import * as analyzeModule from './analyze.js';
import { storeInterpretation } from './interpretations.js';
import * as alertsModule from './alerts.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').ProviderId} ProviderId */
/** @typedef {import('./providers/shared.js').ProviderResult} ProviderResult */
/** @typedef {Record<string, {runPrompt: (text: string, opts?: {model?: string, timeoutMs?: number, apiKey?: string, searchPolicy?: 'off'|'auto'|'required'|'legacy', maxOutputTokens?: number|null, maxResponseBytes?: number|null,maxSearchCalls?:number|null,maxContinuations?:number}) => Promise<ProviderResult>}>} AdapterMap */

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

/** Stable metadata for the existing provider-API measurement profile. */
const API_EXECUTION_PROFILE_HASH = 'legacy-api-v1';
const API_PROMPT_ENVELOPE_VERSION = 'api-v1';

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
  const staleRuns = all(db, "SELECT id FROM runs WHERE status = 'running' AND started_at < ?", [cutoff]);
  if (staleRuns.length === 0) return 0;
  transaction(db, () => {
    dbRun(
      db,
      "UPDATE runs SET status = 'failed', finished_at = ?, error = ?, done_calls = total_calls WHERE status = 'running' AND started_at < ?",
      [isoNow(now), 'abandoned: process exited before the run finished', cutoff],
    );
    for (const stale of staleRuns) {
      dbRun(
        db,
        `UPDATE responses
            SET target_status = 'failed',
                comparability_status = 'non_comparable',
                comparability_reason = 'abandoned',
                answer_status = 'failed',
                evidence_completeness = 'unavailable',
                query_metadata_status = 'unavailable',
                cost_status = 'unavailable',
                web_status = CASE
                  WHEN surface IN ('codex-agent', 'claude-code-agent') THEN 'failed'
                  ELSE COALESCE(web_status, 'not_applicable')
                END,
                safe_error_code = 'abandoned',
                error = CASE
                  WHEN surface IN ('codex-agent', 'claude-code-agent') THEN 'subscription:abandoned'
                  ELSE 'api:abandoned'
                END
          WHERE run_id = ? AND target_status IN ('queued', 'running')`,
        [Number(stale.id)],
      );
    }
  });
  return staleRuns.length;
}

/**
 * @typedef {Object} Task
 * @property {number} promptId
 * @property {string} promptText
 * @property {ProviderId|string} provider
 * @property {string} model
 * @property {number} sampleIdx
 * @property {string} promptOrigin
 * @property {number} responseId
 */

/**
 * @typedef {Object} ProviderTally
 * @property {number} ok
 * @property {number} errors
 * @property {number} skipped
 * @property {number|null} costUsd complete computed total, null when any attempted call is unpriced
 * @property {number|null} knownSubtotalUsd sum of known response components
 * @property {'known'|'partial'|'unavailable'} costStatus
 * @property {number} attemptedCalls
 * @property {number} unknownCalls
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
 * @property {number|null} costUsd complete computed total, null when any attempted call is unpriced
 * @property {number|null} knownSubtotalUsd sum of known response components
 * @property {'known'|'partial'|'unavailable'} costStatus
 * @property {number} attemptedCalls
 * @property {number} unknownCalls
 * @property {string} startedAt UTC ISO-8601
 * @property {string} finishedAt UTC ISO-8601
 * @property {Record<string, ProviderTally>} byProvider
 */

/**
 * @param {Db} db
 * @returns {{id: number, name: string, aliases: string[], domains: string[], ambiguousName:boolean}[]}
 */
function loadEntities(db) {
  return all(db, 'SELECT id, name, aliases, domains, ambiguous_name FROM entities WHERE archived_at IS NULL ORDER BY id').map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    aliases: parseJsonArray(row.aliases),
    domains: parseJsonArray(row.domains),
    ambiguousName: Number(row.ambiguous_name) === 1,
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
    env = config.pricingEnv,
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
  const prompts = all(db, 'SELECT id, intent_id, text, category, origin FROM prompts WHERE active = 1 ORDER BY id');
  const entities = loadEntities(db);
  const benchmark = prompts.length === 0 ? null : benchmarkRevision({
    questions: prompts.map((prompt) => ({
      id: Number(prompt.id), intentId: Number(prompt.intent_id),
      category: String(prompt.category), text: String(prompt.text),
    })),
    entities: all(db, 'SELECT id, name, aliases, domains, is_self FROM entities WHERE archived_at IS NULL ORDER BY id')
      .map((entity) => ({
        id: Number(entity.id), role: /** @type {'brand'|'competitor'} */ (Number(entity.is_self) === 1 ? 'brand' : 'competitor'),
        name: String(entity.name), aliases: parseJsonArray(entity.aliases), domains: parseJsonArray(entity.domains),
      })),
    weighting: 'equal', scope: 'tracking',
  });

  /** @type {Map<string, ReturnType<typeof executionProfile>>} */
  const profiles = new Map();
  /** @type {Map<string, ReturnType<typeof apiExecutionBudget>>} */
  const budgets = new Map();
  for (const provider of providers) {
    const budget = apiExecutionBudget(config, provider.id);
    budgets.set(provider.id, budget);
    profiles.set(provider.id, executionProfile({
      surface: budget.surface, route: budget.route, model: budget.model,
      searchPolicy: /** @type {import('./measurement-contract.js').SearchPolicy} */ (budget.searchPolicy),
      envelopeVersion: API_PROMPT_ENVELOPE_VERSION,
      requestSettings: { endpoint: budget.endpoint, enabledTools: budget.enabledTools },
      limits: { timeoutMs: budget.timeoutMs, answerTokenLimit: budget.answerTokenLimit,
        maxSearchCalls: budget.maxSearchCalls, maxContinuations: budget.maxContinuations,
        maxOutputBytes: budget.maxOutputBytes },
    }));
  }

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
          promptOrigin: String(prompt.origin ?? 'legacy'),
          responseId: 0,
        });
      }
    }
  }

  const startedAt = isoNow(now());
  const runId = transaction(db, () => {
    const inserted = dbRun(
      db,
      `INSERT INTO runs(started_at, trigger, status, total_calls, done_calls)
       SELECT ?, ?, 'running', ?, 0
        WHERE NOT EXISTS (SELECT 1 FROM runs WHERE status = 'running')`,
      [startedAt, trigger, tasks.length],
    );
    if (inserted.changes === 0) {
      const running = get(db, "SELECT id FROM runs WHERE status = 'running' ORDER BY id LIMIT 1");
      throw new RunInProgressError(running ? Number(running.id) : null);
    }
    for (const task of tasks) {
      task.responseId = dbRun(db, `INSERT INTO responses(
        run_id, prompt_id, provider, surface, model, sample_idx, created_at,
        lane, target_status, comparability_status, web_status, prompt_text_snapshot,
        prompt_origin, execution_profile_hash, prompt_envelope_version, comparison_key,
        location_control
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'tracking', 'queued', 'non_comparable',
        'not_applicable', ?, ?, ?, ?, ?, 'uncontrolled')`, [
        inserted.lastInsertRowid, task.promptId, task.provider, `${task.provider}-api`,
        task.model, task.sampleIdx, startedAt, task.promptText, task.promptOrigin,
        API_EXECUTION_PROFILE_HASH, API_PROMPT_ENVELOPE_VERSION,
        `legacy:${task.provider}:${task.model}`,
      ]).lastInsertRowid;
      const profile = profiles.get(task.provider);
      const budget = budgets.get(task.provider);
      if (!profile || !budget || !benchmark) throw new TypeError('Missing queued measurement definition');
      storeTargetDefinition(db, task.responseId, {
        profile, benchmark, analysisRevision: analyzeModule.STANCE_REVISION,
        searchPolicy: /** @type {import('./measurement-contract.js').SearchPolicy} */ (budget.searchPolicy), at: startedAt,
      });
    }
    return inserted.lastInsertRowid;
  });

  /** @type {Record<string, ProviderTally>} */
  const byProvider = {};
  for (const provider of providers) {
    byProvider[provider.id] = { ok: 0, errors: 0, skipped: 0, costUsd: null,
      knownSubtotalUsd: null, costStatus: 'unavailable', attemptedCalls: 0,
      unknownCalls: 0, circuitOpen: false };
  }
  /** @type {Map<string, number>} */
  const consecutiveFatal = new Map();

  let okCalls = 0;
  let errorCalls = 0;
  let skippedCalls = 0;
  /**
   * One queued task: call the provider, then finalize its answer and evidence together.
   *
   * @param {Task} task
   * @returns {Promise<void>}
   */
  async function runTask(task) {
    const tally = byProvider[task.provider];
    if (tally.circuitOpen) {
      dbRun(
        db,
        `UPDATE responses SET error = ?, created_at = ?, target_status = 'failed',
          comparability_status = 'non_comparable', comparability_reason = 'skipped_circuit',
          answer_status = 'failed', evidence_completeness = 'unavailable',
          cost_status = 'unavailable',
          query_metadata_status = ?, safe_error_code = ? WHERE id = ?`,
        [SKIPPED_CIRCUIT, isoNow(now()), task.provider === 'perplexity' ? 'unavailable' : 'not_applicable',
          'skipped_circuit', task.responseId],
      );
      tally.skipped += 1;
      skippedCalls += 1;
      return;
    }

    const budget = budgets.get(task.provider);
    if (!budget) throw new TypeError('Missing execution budget for queued target');
    const adapter = adapters[task.provider];
    /** @type {ProviderResult|null} */
    let result = null;
    /** @type {ProviderError|null} */
    let failure = null;

    try {
      if (!adapter || typeof adapter.runPrompt !== 'function') {
        throw new ProviderError('other', `No adapter registered for provider "${task.provider}"`);
      }
      result = await adapter.runPrompt(task.promptText, {
        model: budget.model, timeoutMs: budget.timeoutMs,
        apiKey: config.providers[/** @type {ProviderId} */ (task.provider)].apiKey,
        searchPolicy: /** @type {import('./measurement-contract.js').SearchPolicy} */ (budget.searchPolicy),
        maxOutputTokens: budget.answerTokenLimit,
        maxResponseBytes: budget.maxOutputBytes,
        maxSearchCalls: budget.maxSearchCalls, maxContinuations: budget.maxContinuations,
      });
    } catch (err) {
      failure =
        err instanceof ProviderError
          ? err
          : new ProviderError('other', 'Adapter threw', err instanceof Error ? err.message : String(err));
    }

    if (failure) {
      const partial = failure.partialResult;
      const attempts = failure.billableAttempts;
      const pricedUsage = attempts && attempts.length > 0 ? priceUsage({
        provider: task.provider, model: task.model, targetId: String(task.responseId),
        searchPolicy: /** @type {import('./measurement-contract.js').SearchPolicy} */ (budget.searchPolicy),
        attempts,
      }, env) : null;
      const priceVersions = [...new Set(pricedUsage?.components.map((component) => component.priceVersion).filter(Boolean) ?? [])];
      const costPriceVersion = priceVersions.length === 1 ? priceVersions[0] : priceVersions.length > 1 ? 'mixed' : null;
      const failedAt = isoNow(now());
      transaction(db, () => {
        if (pricedUsage || partial) {
          storeMeasurementEvidence(db, task.responseId, {
            policy: /** @type {import('./measurement-contract.js').SearchPolicy} */ (budget.searchPolicy),
            answerStatus: 'failed', answer: partial?.text ?? null,
            actions: partial?.searchActions ?? [], sources: partial?.sources ?? [],
            citations: partial?.answerCitations ?? [],
            usage: pricedUsage?.components ?? [], at: failedAt,
          });
        }
        dbRun(
          db,
          `UPDATE responses SET error = ?, created_at = ?, target_status = 'failed',
            comparability_status = 'non_comparable', comparability_reason = ?,
            answer_status = 'failed', evidence_completeness = ?,
            cost_usd = ?, cost_known_subtotal_usd = ?, cost_status = ?,
            cost_provenance = ?, cost_price_version = ?,
            query_metadata_status = ?, safe_error_code = ? WHERE id = ?`,
          [failure.toStorage(), failedAt, `provider_${failure.kind}`,
            partial ? 'partial' : 'unavailable',
            pricedUsage?.computedCostUsd ?? null, pricedUsage?.knownSubtotalUsd ?? null,
            pricedUsage?.costStatus ?? 'unavailable', pricedUsage?.knownSubtotalUsd != null ? 'computed' : null,
            costPriceVersion,
            partial ? (partial.searchActions?.some((action) => action.queryMetadata === 'available') ? 'available' : 'unavailable')
              : task.provider === 'perplexity' ? 'unavailable' : 'not_applicable',
            failure.kind, task.responseId],
        );
      });
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
    const effectiveModel = answer.model || task.model;
    const pricedUsage = priceUsage({
      provider: task.provider, model: effectiveModel, targetId: String(task.responseId),
      searchPolicy: /** @type {import('./measurement-contract.js').SearchPolicy} */ (budget.searchPolicy),
      attempts: answer.billableAttempts ?? [{
        attempt: 0, continuation: 0, inputTokens: tokensIn, outputTokens: tokensOut,
        requestCompleted: true,
      }],
    }, env);
    const cost = pricedUsage.computedCostUsd;
    const priceVersions = [...new Set(pricedUsage.components.map((component) => component.priceVersion).filter(Boolean))];
    const costPriceVersion = priceVersions.length === 1 ? priceVersions[0] : priceVersions.length > 1 ? 'mixed' : null;
    const analysis = analyzeResponse(answer.text, entities, answer.citations ?? []);
    const createdAt = isoNow(now());

    // Synchronous on purpose — an `await` between BEGIN and COMMIT would let another
    // worker interleave into this transaction.
    try {
      transaction(db, () => {
        dbRun(
          db,
          `UPDATE responses SET model = ?, latency_ms = ?, tokens_in = ?, tokens_out = ?,
            cost_usd = ?, cost_known_subtotal_usd = ?, cost_status = ?,
            cost_provenance = 'computed', cost_price_version = ?,
            created_at = ?, comparison_key = ? WHERE id = ?`,
          [
            effectiveModel,
            Number.isFinite(answer.latencyMs) ? Math.round(answer.latencyMs) : null,
            tokensIn,
            tokensOut,
            cost,
            pricedUsage.knownSubtotalUsd,
            pricedUsage.costStatus,
            costPriceVersion,
            createdAt,
            `legacy:${task.provider}:${effectiveModel}`,
            task.responseId,
          ],
        );

        const normalizedCitations = answer.answerCitations ?? (task.provider === 'perplexity' ? []
          : (analysis?.citations ?? []).map((citation) => ({
            url: String(pick(citation, ['url']) ?? ''),
            provenance: /** @type {const} */ ('text_link'),
            sourceId: null, start: null, end: null,
          })));
        storeMeasurementEvidence(db, task.responseId, {
          policy: /** @type {import('./measurement-contract.js').SearchPolicy} */ (budget.searchPolicy),
          answerStatus: answer.answerStatus ?? (answer.text.trim() === '' ? 'empty' : 'complete'),
          answer: answer.text,
          actions: answer.searchActions ?? [],
          sources: answer.sources ?? [],
          citations: normalizedCitations,
          usage: pricedUsage.components,
          noSearchConfirmed: answer.noSearchConfirmed,
          at: createdAt,
        });

        for (const mention of analysis?.mentions ?? []) {
          const mentionId = dbRun(
            db,
            `INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet)
             VALUES(?, ?, ?, ?, ?, ?, ?)`,
            [
              task.responseId,
              Number(pick(mention, ['entityId', 'entity_id']) ?? 0),
              Number(pick(mention, ['firstIndex', 'first_index']) ?? 0),
              Number(pick(mention, ['occurrences']) ?? 1),
              Number(pick(mention, ['rank']) ?? 1),
              pick(mention, ['recommended']) ? 1 : 0,
              String(pick(mention, ['snippet']) ?? ''),
            ],
          ).lastInsertRowid;
          storeInterpretation(db, mentionId, analyzeModule.STANCE_REVISION,
            /** @type {import('./analyze.js').MentionResult} */ (mention), createdAt);
        }

        for (const citation of analysis?.citations ?? []) {
          const entityId = pick(citation, ['entityId', 'entity_id']);
          dbRun(db, 'INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES(?, ?, ?, ?, ?)', [
            task.responseId,
            String(pick(citation, ['url']) ?? ''),
            String(pick(citation, ['domain']) ?? ''),
            Number(pick(citation, ['rank']) ?? 1),
            entityId === undefined ? null : Number(entityId),
          ]);
        }
      });
    } catch (error) {
      dbRun(db, `UPDATE responses SET text = ?, model = ?, tokens_in = ?, tokens_out = ?,
        cost_usd = ?, cost_known_subtotal_usd = ?, cost_status = ?,
        cost_provenance = 'computed', cost_price_version = ?,
        created_at = ?, target_status = 'failed', answer_status = ?,
        comparability_status = 'non_comparable', comparability_reason = 'evidence_invalid',
        evidence_completeness = 'partial', safe_error_code = 'evidence_invalid',
        error = 'evidence:invalid' WHERE id = ?`, [
        Buffer.byteLength(answer.text) <= EVIDENCE_LIMITS.answerBytes ? answer.text : null,
        effectiveModel, tokensIn, tokensOut, cost, pricedUsage.knownSubtotalUsd,
        pricedUsage.costStatus, costPriceVersion, createdAt,
        answer.answerStatus ?? (answer.text.trim() === '' ? 'empty' : 'complete'), task.responseId,
      ]);
      throw error;
    }

    tally.ok += 1;
    okCalls += 1;
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
        dbRun(db, `UPDATE responses SET target_status = 'failed',
          comparability_status = 'non_comparable', comparability_reason = 'storage_failed',
          answer_status = 'failed', evidence_completeness = 'unavailable',
          cost_status = 'unavailable',
          safe_error_code = 'storage_failed', error = 'storage:failed'
          WHERE id = ? AND target_status IN ('queued','running')`, [task.responseId]);
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
  const costRows = all(db, `SELECT provider, cost_usd, cost_known_subtotal_usd, target_status, safe_error_code
    FROM responses WHERE run_id = ?`, [runId]);
  for (const row of costRows) {
    if (!['completed', 'failed', 'cancelled'].includes(String(row.target_status)) ||
        row.safe_error_code === 'skipped_circuit') continue;
    const tally = byProvider[String(row.provider)];
    if (!tally) continue;
    tally.attemptedCalls += 1;
    const known = row.cost_known_subtotal_usd ?? row.cost_usd;
    if (known !== null) tally.knownSubtotalUsd = (tally.knownSubtotalUsd ?? 0) + Number(known);
    if (row.cost_usd === null) tally.unknownCalls += 1;
  }
  for (const tally of Object.values(byProvider)) {
    const summary = summarizeComputedCosts(tally);
    tally.costStatus = summary.costStatus;
    tally.costUsd = summary.totalUsd;
  }
  const knownTotals = Object.values(byProvider).filter((tally) => tally.knownSubtotalUsd !== null);
  const knownSubtotalUsd = knownTotals.length === 0 ? null
    : knownTotals.reduce((sum, tally) => sum + Number(tally.knownSubtotalUsd), 0);
  const attemptedCalls = Object.values(byProvider).reduce((sum, tally) => sum + tally.attemptedCalls, 0);
  const unknownCalls = Object.values(byProvider).reduce((sum, tally) => sum + tally.unknownCalls, 0);
  const costSummary = summarizeComputedCosts({ attemptedCalls, unknownCalls, knownSubtotalUsd });

  return {
    runId,
    trigger,
    status,
    totalCalls: tasks.length,
    doneCalls: Number(doneRow?.done_calls ?? 0),
    okCalls,
    errorCalls,
    skippedCalls,
    costUsd: costSummary.totalUsd,
    knownSubtotalUsd: costSummary.knownSubtotalUsd,
    costStatus: costSummary.costStatus,
    attemptedCalls: costSummary.attemptedCalls,
    unknownCalls: costSummary.unknownCalls,
    startedAt,
    finishedAt,
    byProvider,
  };
}
