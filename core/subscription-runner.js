/**
 * Subscription measurement coordinator.
 *
 * This is the local on-demand lane. It plans and persists every target before a CLI
 * process starts, preflights each surface without a model turn, continues independent
 * surfaces after failure, and writes only verified-search targets into comparable state.
 */

import { all, get, isoNow, run as dbRun, SETTING_KEYS, setSetting, transaction } from './db.js';
import { DemoModeError } from './runner.js';
import { analyzeResponse as defaultAnalyzeResponse } from './analyze.js';
import { recordSearchEvents } from './artifacts.js';
import { CodexCliRunner, ClaudeCliRunner } from './agent-runners.js';
import { CLAUDE_SURFACE, CODEX_SURFACE } from './agent-profiles.js';
import { runStatusFromTargets } from './subscription-model.js';
import * as alertsModule from './alerts.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./config.js').Config} Config */

const SURFACES = [CODEX_SURFACE, CLAUDE_SURFACE];
const SURFACE_IDS = /** @type {string[]} */ (SURFACES);

export class SubscriptionConfirmationError extends Error {
  /** @param {string[]} surfaces */
  constructor(surfaces) {
    super(`Confirm subscription allowance use for: ${surfaces.join(', ')}`);
    this.name = 'SubscriptionConfirmationError';
    /** @type {string[]} */
    this.surfaces = surfaces;
  }
}

export class SubscriptionRunError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SubscriptionRunError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @typedef {Object} PromptTarget
 * @property {number} promptId
 * @property {string} promptText
 * @property {'tracking'|'exploration'} lane
 * @property {'user_authored'|'suggested'|'imported'|'legacy'} promptOrigin
 */

/**
 * @param {Db} db
 * @param {'tracking'|'exploration'} lane
 * @param {number[]|undefined} promptIds
 * @returns {PromptTarget[]}
 */
function selectPrompts(db, lane, promptIds) {
  const rows = promptIds && promptIds.length > 0
    ? all(db, `SELECT id, text, tracking_state, origin FROM prompts WHERE id IN (${promptIds.map(() => '?').join(', ')})
        AND (${lane === 'tracking' ? "active = 1 AND tracking_state = 'tracking'" : '1 = 1'}) ORDER BY id`, promptIds)
    : all(
        db,
        lane === 'tracking'
          ? `SELECT id, text, tracking_state, origin FROM prompts WHERE active = 1 AND tracking_state = 'tracking' ORDER BY id`
          : `SELECT id, text, tracking_state, origin FROM prompts WHERE tracking_state = 'exploration' ORDER BY id`,
      );
  if (rows.length === 0) throw new SubscriptionRunError('no_prompts', 'No prompts are available for this subscription run');
  return rows.map((row) => ({
    promptId: Number(row.id),
    promptText: String(row.text),
    lane,
    promptOrigin: /** @type {PromptTarget['promptOrigin']} */ (String(row.origin ?? 'legacy')),
  }));
}

/**
 * @param {Db} db
 * @param {Config} config
 * @param {string[]|undefined} requested
 * @returns {string[]}
 */
function selectSurfaces(db, config, requested) {
  const enabled = /** @type {string[]} */ (config.subscriptionSurfaces.filter((surface) => SURFACE_IDS.includes(surface)));
  const selected = requested === undefined ? enabled : requested.map(String);
  if (selected.length === 0) throw new SubscriptionRunError('no_subscription_surfaces', 'No subscription agent surface is explicitly enabled');
  for (const surface of selected) {
    if (!SURFACE_IDS.includes(surface)) throw new SubscriptionRunError('unsupported_surface', `Unsupported subscription surface: ${surface}`);
    if (!enabled.includes(surface)) throw new SubscriptionRunError('surface_not_enabled', `${surface} is not enabled in this Hearsay installation`);
  }
  void db;
  return [...new Set(selected)];
}

/**
 * @param {Db} db
 * @returns {string[]}
 */
function optedInSurfaces(db) {
  const stored = get(db, 'SELECT value FROM settings WHERE key = ?', [SETTING_KEYS.SUBSCRIPTION_SURFACE_OPT_IN]);
  if (!stored || typeof stored.value !== 'string') return [];
  try {
    const value = JSON.parse(stored.value);
    return Array.isArray(value) ? value.map(String).filter((surface) => SURFACE_IDS.includes(surface)) : [];
  } catch {
    return [];
  }
}

/**
 * @param {Db} db
 * @param {string[]} surfaces
 * @returns {string[]}
 */
function firstUseSurfaces(db, surfaces) {
  const opted = new Set(optedInSurfaces(db));
  return surfaces.filter((surface) => !opted.has(surface));
}

/**
 * @param {Db} db
 * @param {string[]} surfaces
 * @returns {void}
 */
function recordOptIn(db, surfaces) {
  const next = [...new Set([...optedInSurfaces(db), ...surfaces])];
  setSetting(db, SETTING_KEYS.SUBSCRIPTION_SURFACE_OPT_IN, next);
}

/**
 * @param {{db:Db, config:Config, surfaces?:string[], lane?:'tracking'|'exploration', promptIds?:number[], samples?:number}}
 *   options
 * @returns {{lane:'tracking'|'exploration', surfaces:string[], prompts:PromptTarget[], samples:number, totalTargets:number,
 *   perSurface:{surface:string, prompts:number, samples:number, invocations:number}[], firstUseSurfaces:string[],
 *   estimatedCost:null, usageModel:'included_plan_allowance_or_overage'}}
 */
export function subscriptionPreview(options) {
  const lane = options.lane ?? 'tracking';
  if (lane !== 'tracking' && lane !== 'exploration') throw new SubscriptionRunError('invalid_lane', 'lane must be tracking or exploration');
  const surfaces = selectSurfaces(options.db, options.config, options.surfaces);
  const samples = Math.max(1, Math.min(10, Math.floor(options.samples ?? options.config.subscriptionSamples)));
  const prompts = selectPrompts(options.db, lane, options.promptIds);
  const perSurface = surfaces.map((surface) => ({ surface, prompts: prompts.length, samples, invocations: prompts.length * samples }));
  return {
    lane,
    surfaces,
    prompts,
    samples,
    totalTargets: prompts.length * samples * surfaces.length,
    perSurface,
    firstUseSurfaces: firstUseSurfaces(options.db, surfaces),
    estimatedCost: null,
    usageModel: 'included_plan_allowance_or_overage',
  };
}

/**
 * @param {{db:Db, config:Config, preview:ReturnType<typeof subscriptionPreview>, trigger:'manual'|'cron', targetCeiling?:number, now?:Date,
 *   existingRunId?:number, scheduleKey?:string, scheduleRevisionHash?:string, scheduledFor?:string, occurrenceLocalDate?:string}}
 *   options
 * @returns {{runId:number, targets:(PromptTarget & {responseId:number, surface:string, sampleIdx:number, db:Db, runId:number})[]}}
 */
function queueRun(options) {
  const { db, preview } = options;
  const at = isoNow(options.now ?? new Date());
  /** @type {number} */
  let runId = 0;
  /** @type {(PromptTarget & {responseId:number, surface:string, sampleIdx:number, db:Db, runId:number})[]} */
  const targets = [];
  transaction(db, () => {
    if (options.existingRunId === undefined) {
      const inserted = dbRun(
        db,
        `INSERT INTO runs(
           started_at, trigger, status, total_calls, done_calls, target_ceiling,
           schedule_key, schedule_revision_hash, scheduled_for, occurrence_local_date
         )
         SELECT ?, ?, 'running', ?, 0, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM runs WHERE status = 'running')`,
        [
          at,
          options.trigger,
          preview.totalTargets,
          options.targetCeiling ?? null,
          options.scheduleKey ?? null,
          options.scheduleRevisionHash ?? null,
          options.scheduledFor ?? null,
          options.occurrenceLocalDate ?? null,
        ],
      );
      if (inserted.changes === 0) {
        const running = get(db, "SELECT id, done_calls, total_calls FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
        throw new SubscriptionRunError(
          'already_running',
          running ? `Run ${running.id} in progress: ${running.done_calls}/${running.total_calls} calls done` : 'A subscription run is already in progress.',
        );
      }
      runId = inserted.lastInsertRowid;
    } else {
      runId = Number(options.existingRunId);
      if (!get(db, 'SELECT id FROM runs WHERE id = ?', [runId])) {
        throw new SubscriptionRunError('run_not_found', `Scheduled run ${runId} no longer exists`);
      }
      dbRun(
        db,
        `UPDATE runs SET trigger = ?, status = 'running', total_calls = ?, done_calls = 0,
           target_ceiling = ?, schedule_key = ?, schedule_revision_hash = ?, scheduled_for = ?, occurrence_local_date = ?
         WHERE id = ?`,
        [
          options.trigger,
          preview.totalTargets,
          options.targetCeiling ?? null,
          options.scheduleKey ?? null,
          options.scheduleRevisionHash ?? null,
          options.scheduledFor ?? null,
          options.occurrenceLocalDate ?? null,
          runId,
        ],
      );
    }
    for (const surface of preview.surfaces) {
      const provider = surface === CODEX_SURFACE ? 'openai' : 'anthropic';
      for (const prompt of preview.prompts) {
        for (let sampleIdx = 0; sampleIdx < preview.samples; sampleIdx += 1) {
          const responseId = dbRun(
            db,
            `INSERT INTO responses(
               run_id, prompt_id, provider, surface, model, sample_idx, text, error, created_at,
               lane, target_status, comparability_status, comparability_reason, web_status,
               prompt_text_snapshot, prompt_origin, location_control
             ) VALUES(?, ?, ?, ?, 'default', ?, NULL, NULL, ?, ?, 'queued', 'non_comparable', NULL, 'unavailable', ?, ?, 'uncontrolled')`,
            [
              Number(runId),
              prompt.promptId,
              provider,
              surface,
              sampleIdx,
              at,
              preview.lane,
              prompt.promptText,
              prompt.promptOrigin,
            ],
          ).lastInsertRowid;
          targets.push({ ...prompt, responseId, surface, sampleIdx, db, runId: Number(runId) });
        }
      }
    }
  });
  return { runId: Number(runId), targets };
}

/** @param {Record<string, unknown>} row @returns {string} */
function errorCode(row) {
  const code = String(row.code ?? row.errorCode ?? 'process_start_failed');
  return code.replace(/[^a-z0-9_:-]/gi, '_').slice(0, 80);
}

/** @param {string} webStatus @returns {string|null} */
function comparabilityReason(webStatus, hasAnswer = true) {
  if (!hasAnswer) return 'answer_missing';
  if (webStatus === 'verified') return null;
  if (webStatus === 'unavailable') return 'web_search_unavailable';
  if (webStatus === 'failed') return 'web_search_failed';
  return 'web_search_unverified';
}

/** @param {unknown} value @returns {number|null} */
function usageCount(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

/**
 * @param {Db} db
 * @returns {Record<string, unknown>[]}
 */
function entitiesForAnalysis(db) {
  return all(db, 'SELECT id, name, aliases, domains FROM entities WHERE archived_at IS NULL ORDER BY id').map((row) => {
    /** @param {unknown} value @returns {string[]} */
    const json = (value) => {
      try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
      } catch {
        return [];
      }
    };
    return { id: Number(row.id), name: String(row.name), aliases: json(row.aliases), domains: json(row.domains) };
  });
}

/**
 * @param {Db} db
 * @param {number} responseId
 * @param {Record<string, unknown>} result
 * @param {(text:string,entities:unknown[],citations?:{url:string}[])=>{mentions:Record<string,unknown>[],citations:Record<string,unknown>[]}} analyzeResponse
 * @param {Record<string, unknown>[]} entities
 * @param {{failureCode?:string}} [options]
 * @returns {void}
 */
function storeResult(db, responseId, result, analyzeResponse, entities, options = {}) {
  const text = result.text === null || result.text === undefined ? null : String(result.text);
  const failureCode = options.failureCode ?? null;
  const targetStatus = failureCode === null ? 'completed' : 'failed';
  const webStatus = failureCode === null ? String(result.webStatus ?? 'unverified') : 'failed';
  const hasAnswer = text !== null && text.trim() !== '';
  const usage = result.usage && typeof result.usage === 'object' ? /** @type {Record<string, unknown>} */ (result.usage) : {};
  const analysis = text === null ? { mentions: [], citations: [] } : analyzeResponse(text, entities, /** @type {{url:string}[]} */ (result.citations ?? []));
  const comparabilityStatus = targetStatus === 'completed' && webStatus === 'verified' && hasAnswer ? 'comparable' : 'non_comparable';
  const resultReason = targetStatus === 'failed'
    ? (failureCode !== null && failureCode.startsWith('web_search_') ? failureCode : 'web_search_failed')
    : comparabilityReason(webStatus, hasAnswer);
  transaction(db, () => {
    dbRun(
      db,
      `UPDATE responses SET model = ?, text = ?, tokens_in = ?, tokens_out = ?, target_status = ?, comparability_status = ?,
          comparability_reason = ?, web_status = ?, cli_executable = ?, cli_version = ?, execution_profile_hash = ?,
          prompt_envelope_version = ?, comparison_key = ?, location_control = ?, artifact_ref = ?,
          safe_error_code = ?, error = ?
        WHERE id = ?`,
      [
        result.model === null || result.model === undefined ? 'default' : String(result.model),
        text,
        usageCount(usage.inputTokens ?? usage.input_tokens),
        usageCount(usage.outputTokens ?? usage.output_tokens),
        targetStatus,
        comparabilityStatus,
        resultReason,
        webStatus,
        result.cliExecutable === undefined ? null : String(result.cliExecutable),
        result.cliVersion === undefined ? null : String(result.cliVersion),
        result.executionProfileHash === undefined ? null : String(result.executionProfileHash),
        result.promptEnvelopeVersion === undefined ? null : String(result.promptEnvelopeVersion),
        result.comparisonKey === undefined ? null : String(result.comparisonKey),
        result.locationControl === undefined ? 'uncontrolled' : String(result.locationControl),
        result.artifactRef === undefined || result.artifactRef === null ? null : String(result.artifactRef),
        failureCode,
        failureCode === null ? null : `subscription:${failureCode}`,
        responseId,
      ],
    );
    for (const mention of analysis.mentions ?? []) {
      dbRun(db, 'INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet) VALUES(?,?,?,?,?,?,?)', [
        responseId,
        Number(mention.entityId ?? mention.entity_id),
        Number(mention.firstIndex ?? mention.first_index ?? 0),
        Number(mention.occurrences ?? 1),
        Number(mention.rank ?? 1),
        mention.recommended ? 1 : 0,
        String(mention.snippet ?? ''),
      ]);
    }
    for (const citation of analysis.citations ?? []) {
      dbRun(db, 'INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES(?,?,?,?,?)', [
        responseId,
        String(citation.url ?? ''),
        String(citation.domain ?? ''),
        Number(citation.rank ?? 1),
        citation.entityId === undefined || citation.entityId === null ? null : Number(citation.entityId),
      ]);
    }
    recordSearchEvents(db, responseId, /** @type {Record<string, unknown>[]} */ (result.searchEvents ?? []));
  });
}

/**
 * @param {Db} db
 * @param {number} responseId
 * @param {Record<string, unknown>} result
 * @param {(text:string,entities:unknown[],citations?:{url:string}[])=>{mentions:Record<string,unknown>[],citations:Record<string,unknown>[]}} analyzeResponse
 * @param {Record<string, unknown>[]} entities
 * @returns {void}
 */
function storeSuccess(db, responseId, result, analyzeResponse, entities) {
  storeResult(db, responseId, result, analyzeResponse, entities);
}

/**
 * @param {Db} db
 * @param {number} responseId
 * @param {string} code
 * @param {Record<string, unknown>} [result]
 * @param {(text:string,entities:unknown[],citations?:{url:string}[])=>{mentions:Record<string,unknown>[],citations:Record<string,unknown>[]}} [analyzeResponse]
 * @param {Record<string, unknown>[]} [entities]
 * @returns {void}
 */
function storeFailure(db, responseId, code, result, analyzeResponse, entities) {
  if (result && analyzeResponse && entities) {
    storeResult(db, responseId, result, analyzeResponse, entities, { failureCode: code });
    return;
  }
  dbRun(
    db,
    `UPDATE responses SET target_status = 'failed', comparability_status = 'non_comparable',
       comparability_reason = ?, web_status = 'failed', safe_error_code = ?, error = ? WHERE id = ?`,
    [code.startsWith('web_search_') ? code : null, code, `subscription:${code}`, responseId],
  );
}

/** @param {Db} db @param {number} responseId @returns {void} */
function storeCancelled(db, responseId) {
  dbRun(
    db,
    `UPDATE responses SET target_status = 'cancelled', comparability_status = 'non_comparable',
       comparability_reason = 'cancelled', web_status = 'unavailable', safe_error_code = 'cancelled',
       error = 'subscription:cancelled' WHERE id = ?`,
    [responseId],
  );
}

/**
 * @param {{db:Db, config:Config, surfaces?:string[], lane?:'tracking'|'exploration', promptIds?:number[], samples?:number,
 *   confirm?:boolean, trigger?:'manual'|'cron', targetCeiling?:number, now?:Date,
 *   runners?:Record<string,{preflight:()=>Promise<unknown>,run:(target:Record<string,unknown>,signal?:AbortSignal)=>Promise<Record<string,unknown>>,cancel?:()=>void}>,
 *   analyzeResponse?:typeof defaultAnalyzeResponse, evaluateAlerts?:(runId:number,db:Db,options?:{surface:string})=>unknown,
 *   signal?:AbortSignal, onRunCreated?:(runId:number,controller:AbortController)=>void}} options
 * @returns {Promise<{runId:number,status:string,totalCalls:number,doneCalls:number,bySurface:Record<string,unknown>}>}
 */
export async function runSubscriptionPanel(options) {
  if (options.config.demo) throw new DemoModeError('Demo mode is on — subscription agent calls disabled.');
  const preview = subscriptionPreview(options);
  if (options.targetCeiling !== undefined && preview.totalTargets > options.targetCeiling) {
    throw new SubscriptionRunError('schedule_budget_exceeded', `Subscription target count ${preview.totalTargets} exceeds ceiling ${options.targetCeiling}`);
  }
  if (preview.firstUseSurfaces.length > 0 && options.confirm !== true) throw new SubscriptionConfirmationError(preview.firstUseSurfaces);
  if (options.confirm === true) recordOptIn(options.db, preview.surfaces);
  const queued = queueRun({ ...options, preview, trigger: options.trigger ?? 'manual' });
  const runController = new AbortController();
  const forwardAbort = () => runController.abort();
  if (options.signal?.aborted) runController.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  options.onRunCreated?.(queued.runId, runController);
  const runners = options.runners ?? {};
  const entities = entitiesForAnalysis(options.db);
  const analyzeResponse = /** @type {*} */ (options.analyzeResponse ?? defaultAnalyzeResponse);
  const evaluateAlerts = /** @type {*} */ (options.evaluateAlerts ?? alertsModule.evaluate);
  /** @type {Record<string, {ok:number, errors:number, verified:number, nonComparable:number, cancelled:number}>} */
  const bySurface = {};
  let cancellationRequested = runController.signal.aborted;
  try {
    /** @param {string} surface @returns {Promise<void>} */
    const processSurface = async (surface) => {
      const surfaceTargets = queued.targets.filter((target) => target.surface === surface);
      bySurface[surface] = { ok: 0, errors: 0, verified: 0, nonComparable: 0, cancelled: 0 };
      const runner = runners[surface] ?? (surface === CODEX_SURFACE
        ? new CodexCliRunner({ executable: options.config.subscription.codex.executable, dataDir: options.config.subscriptionDataDir, timeoutMs: options.config.subscriptionTimeoutMs, idleTimeoutMs: options.config.subscriptionIdleTimeoutMs, maxOutputBytes: options.config.subscriptionMaxOutputBytes })
        : new ClaudeCliRunner({ executable: options.config.subscription.claudeCode.executable, dataDir: options.config.subscriptionDataDir, timeoutMs: options.config.subscriptionTimeoutMs, idleTimeoutMs: options.config.subscriptionIdleTimeoutMs, maxOutputBytes: options.config.subscriptionMaxOutputBytes }));
      const onAbort = () => {
        cancellationRequested = true;
        runner.cancel?.();
      };
      runController.signal.addEventListener('abort', onAbort);
      let preflightError = null;
      try {
        if (!cancellationRequested && !runController.signal.aborted) await runner.preflight();
      } catch (error) {
        preflightError = errorCode(/** @type {Record<string, unknown>} */ (error));
      }
      try {
        for (const target of surfaceTargets) {
          if (cancellationRequested || runController.signal.aborted) {
            cancellationRequested = true;
            storeCancelled(options.db, target.responseId);
            bySurface[surface].cancelled += 1;
            dbRun(options.db, 'UPDATE runs SET done_calls = done_calls + 1 WHERE id = ?', [queued.runId]);
            continue;
          }
          dbRun(options.db, "UPDATE responses SET target_status = 'running' WHERE id = ?", [target.responseId]);
          if (preflightError) {
            storeFailure(options.db, target.responseId, preflightError);
            bySurface[surface].errors += 1;
            dbRun(options.db, 'UPDATE runs SET done_calls = done_calls + 1 WHERE id = ?', [queued.runId]);
            continue;
          }
          try {
            const result = await runner.run({ ...target }, runController.signal);
            const terminalCode = result.errorCode === null || result.errorCode === undefined ? null : errorCode(result);
            if (terminalCode) {
              storeFailure(options.db, target.responseId, terminalCode, result, analyzeResponse, entities);
              bySurface[surface].errors += 1;
            } else {
              storeSuccess(options.db, target.responseId, result, analyzeResponse, entities);
              bySurface[surface].ok += 1;
              if (result.webStatus === 'verified') bySurface[surface].verified += 1;
              else bySurface[surface].nonComparable += 1;
            }
          } catch (error) {
            const code = errorCode(/** @type {Record<string, unknown>} */ (error));
            if (code === 'cancelled' || cancellationRequested || runController.signal.aborted) {
              cancellationRequested = true;
              storeCancelled(options.db, target.responseId);
              bySurface[surface].cancelled += 1;
            } else {
              storeFailure(options.db, target.responseId, code);
              bySurface[surface].errors += 1;
            }
          }
          dbRun(options.db, 'UPDATE runs SET done_calls = done_calls + 1 WHERE id = ?', [queued.runId]);
        }
      } finally {
        runController.signal.removeEventListener('abort', onAbort);
      }
    };
    let surfaceCursor = 0;
    const configuredConcurrency = Number(options.config.subscriptionConcurrency ?? 1);
    const surfaceConcurrency = Math.max(
      1,
      Math.min(Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 1, preview.surfaces.length),
    );
    const workers = Array.from({ length: surfaceConcurrency }, async () => {
      for (;;) {
        const index = surfaceCursor;
        surfaceCursor += 1;
        if (index >= preview.surfaces.length) return;
        await processSurface(preview.surfaces[index]);
      }
    });
    await Promise.all(workers);
    const targets = all(options.db, 'SELECT target_status, comparability_status, web_status, surface FROM responses WHERE run_id = ? ORDER BY id', [queued.runId]);
    const status = runStatusFromTargets(targets);
    const finishedAt = isoNow(options.now ?? new Date());
    dbRun(options.db, 'UPDATE runs SET status = ?, finished_at = ?, done_calls = total_calls WHERE id = ?', [status, finishedAt, queued.runId]);
    if (typeof evaluateAlerts === 'function') {
      for (const surface of preview.surfaces) {
        try {
          await evaluateAlerts(queued.runId, options.db, { surface });
        } catch {
          // Alert evaluation must not discard a completed subscription measurement.
        }
      }
    }
    return {
      runId: queued.runId,
      status,
      totalCalls: preview.totalTargets,
      doneCalls: preview.totalTargets,
      bySurface,
    };
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

export { DemoModeError };
