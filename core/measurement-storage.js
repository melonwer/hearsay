import { get, run } from './db.js';
import { assessObservation, normalizeObservedQuery, sourceGroupingUrl, stableIdentity } from './measurement-contract.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./measurement-contract.js').SearchAction} SearchAction */
/** @typedef {import('./measurement-contract.js').SourceObservation} SourceObservation */
/** @typedef {import('./measurement-contract.js').AnswerCitation} AnswerCitation */
/** @typedef {import('./measurement-contract.js').UsageComponent} UsageComponent */
/** @typedef {import('./measurement-contract.js').SearchPolicy} SearchPolicy */
/** @typedef {import('./measurement-contract.js').AnswerStatus} AnswerStatus */

export const EVIDENCE_LIMITS = Object.freeze({ actions: 100, queries: 200, sources: 400, citations: 200, usage: 100, excerptBytes: 4096, answerBytes: 256 * 1024 });

/** @param {Db} db @param {() => void} write */
function atomic(db, write) {
  db.exec('SAVEPOINT measurement_write');
  try {
    write();
    db.exec('RELEASE measurement_write');
  } catch (error) {
    db.exec('ROLLBACK TO measurement_write');
    db.exec('RELEASE measurement_write');
    throw error;
  }
}

/** @param {number} value @param {number} ceiling @param {string} label */
function within(value, ceiling, label) {
  if (value > ceiling) throw new RangeError(`${label} exceeds limit ${ceiling}`);
}

/** @param {string} value @param {string} label @returns {string} */
function safeUrl(value, label) {
  if (sourceGroupingUrl(value) === null) throw new TypeError(`${label} must be an HTTP(S) URL`);
  return value;
}

/**
 * Save the immutable definitions for a queued target before network work starts.
 * Reusing an ID is safe. Reassigning a target is refused.
 *
 * @param {Db} db
 * @param {number} responseId
 * @param {{profile:{id:string,snapshot:Record<string,unknown>},
 *   benchmark:{id:string,snapshot:Record<string,unknown>}, analysisRevision:string,
 *   searchPolicy:SearchPolicy, at:string}} input
 */
export function storeTargetDefinition(db, responseId, input) {
  if (!input.analysisRevision) throw new TypeError('analysisRevision is required');
  if (input.profile.snapshot.searchPolicy !== input.searchPolicy) {
    throw new RangeError('Saved profile and target search policies differ');
  }
  if (input.profile.id !== stableIdentity(input.profile.snapshot) ||
      input.benchmark.id !== stableIdentity(input.benchmark.snapshot)) {
    throw new RangeError('Definition ID does not match its snapshot');
  }
  atomic(db, () => {
    run(db, `INSERT OR IGNORE INTO execution_profiles(id, surface, snapshot_json, created_at)
      VALUES(?, ?, ?, ?)`, [input.profile.id, String(input.profile.snapshot.surface), JSON.stringify(input.profile.snapshot), input.at]);
    run(db, `INSERT OR IGNORE INTO benchmark_revisions(id, snapshot_json, created_at)
      VALUES(?, ?, ?)`, [input.benchmark.id, JSON.stringify(input.benchmark.snapshot), input.at]);
    const updated = run(db, `UPDATE responses
      SET execution_profile_id = ?, benchmark_revision_id = ?, analysis_revision = ?, search_policy = ?
      WHERE id = ? AND surface = ? AND target_status = 'queued'
        AND execution_profile_id IS NULL AND benchmark_revision_id IS NULL`, [
      input.profile.id, input.benchmark.id, input.analysisRevision, input.searchPolicy,
      responseId, String(input.profile.snapshot.surface),
    ]);
    if (updated.changes !== 1) throw new RangeError('Target must be queued and have no saved definition');
  });
}

/**
 * Store normalized evidence and its eligibility in one transaction. The caller retains
 * the original provider artifact under the separate retention policy.
 *
 * @param {Db} db
 * @param {number} responseId
 * @param {{policy:SearchPolicy, answerStatus:AnswerStatus, answer:string|null, actions:SearchAction[],
 *   sources:SourceObservation[], citations:AnswerCitation[], usage:UsageComponent[],
 *   noSearchConfirmed?:boolean, at:string}} evidence
 */
export function storeMeasurementEvidence(db, responseId, evidence) {
  if (evidence.answerStatus === 'complete' && (!evidence.answer || evidence.answer.trim() === '')) {
    throw new TypeError('A complete answer must have text');
  }
  if (evidence.answer !== null) within(Buffer.byteLength(evidence.answer), EVIDENCE_LIMITS.answerBytes, 'answer size');
  within(evidence.actions.length, EVIDENCE_LIMITS.actions, 'search action count');
  within(evidence.actions.reduce((count, action) => count + action.queries.length, 0), EVIDENCE_LIMITS.queries, 'search query count');
  within(evidence.sources.length, EVIDENCE_LIMITS.sources, 'source count');
  within(evidence.citations.length, EVIDENCE_LIMITS.citations, 'citation count');
  within(evidence.usage.length, EVIDENCE_LIMITS.usage, 'usage component count');
  const assessment = assessObservation(evidence);
  atomic(db, () => {
    const target = get(db, 'SELECT id, search_policy, answer_status FROM responses WHERE id = ?', [responseId]);
    if (!target || target.search_policy !== evidence.policy || target.answer_status !== null) {
      throw new RangeError('Evidence requires an unfinished target with the selected policy');
    }
    /** @type {Map<string, number>} */
    const actionIds = new Map();
    for (const [sequence, action] of evidence.actions.entries()) {
      if (!action.id || actionIds.has(action.id)) throw new RangeError('Search action IDs must be unique');
      const eventId = run(db, `INSERT INTO search_events(response_id, event_type, status,
        observed_at, provider_event_type, provider_action_id, sequence)
        VALUES(?, ?, ?, ?, ?, ?, ?)`, [
        responseId, action.kind, action.status, action.observedAt ?? evidence.at,
        action.providerType, action.id, sequence,
      ]).lastInsertRowid;
      actionIds.set(action.id, eventId);
      for (const [index, query] of action.queries.entries()) {
        if (Buffer.byteLength(query) > 2048) throw new RangeError('Search query exceeds 2048 bytes');
        run(db, `INSERT INTO search_queries(response_id, search_event_id, original_text,
          normalized_key, ordinal) VALUES(?, ?, ?, ?, ?)`, [
          responseId, eventId, query, normalizeObservedQuery(query), index,
        ]);
      }
    }
    /** @type {Map<string, number>} */
    const sourceIds = new Map();
    for (const source of evidence.sources) {
      if (!source.id || sourceIds.has(source.id)) throw new RangeError('Source IDs must be unique');
      const actionId = source.actionId === null ? null : actionIds.get(source.actionId);
      if (source.actionId !== null && actionId === undefined) throw new RangeError('Source action ID is unknown');
      const excerpt = source.excerpt ?? null;
      if (excerpt !== null && Buffer.byteLength(excerpt) > EVIDENCE_LIMITS.excerptBytes) {
        throw new RangeError(`Source excerpt exceeds ${EVIDENCE_LIMITS.excerptBytes} bytes`);
      }
      const sourceId = run(db, `INSERT INTO source_observations(response_id, search_event_id, url,
        normalized_url, title, excerpt, provenance, original_order) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, [
        responseId, actionId ?? null, safeUrl(source.url, 'Source URL'), sourceGroupingUrl(source.url),
        source.title, excerpt, source.provenance, source.order,
      ]).lastInsertRowid;
      sourceIds.set(source.id, sourceId);
    }
    for (const [ordinal, citation] of evidence.citations.entries()) {
      const sourceId = citation.sourceId === null ? null : sourceIds.get(citation.sourceId);
      if (citation.sourceId !== null && sourceId === undefined) throw new RangeError('Citation source ID is unknown');
      run(db, `INSERT INTO answer_citations(response_id, source_observation_id, url,
        provenance, answer_start, answer_end, ordinal) VALUES(?, ?, ?, ?, ?, ?, ?)`, [
        responseId, sourceId ?? null, safeUrl(citation.url, 'Citation URL'), citation.provenance,
        citation.start, citation.end, ordinal,
      ]);
    }
    for (const usage of evidence.usage) {
      if (usage.targetId !== String(responseId)) throw new RangeError('Usage target ID is wrong');
      if (usage.quantity !== null && (!Number.isFinite(usage.quantity) || usage.quantity < 0)) {
        throw new RangeError('Usage quantity must be nonnegative and finite');
      }
      if (usage.costUsd !== null && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
        throw new RangeError('Usage cost must be nonnegative and finite');
      }
      run(db, `INSERT INTO usage_components(response_id, attempt_index, continuation_index,
        component, quantity, unit, cost_usd, cost_status, price_version)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        responseId, usage.attempt, usage.continuation, usage.component, usage.quantity,
        usage.unit, usage.costUsd, usage.costStatus, usage.priceVersion,
      ]);
    }
    const queryMetadata = evidence.actions.some((action) => action.queryMetadata === 'available')
      ? 'available' : evidence.policy === 'off' || assessment.searchState === 'not_used' ? 'not_applicable' : 'unavailable';
    run(db, `UPDATE responses SET text = ?, target_status = ?, answer_status = ?, evidence_completeness = ?,
      query_metadata_status = ?, web_status = ?, comparability_status = ?, comparability_reason = ?
      WHERE id = ?`, [
      evidence.answer,
      evidence.answerStatus === 'failed' ? 'failed' : 'completed',
      evidence.answerStatus, assessment.evidenceCompleteness, queryMetadata,
      assessment.searchState, assessment.comparable ? 'comparable' : 'non_comparable',
      assessment.exclusion, responseId,
    ]);
  });
}
