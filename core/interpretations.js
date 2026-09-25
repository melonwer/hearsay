import { all, get, run, transaction } from './db.js';
import { extractMentions, STANCE_REVISION } from './analyze.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./analyze.js').MentionResult} MentionResult */

export const STANCES = Object.freeze(['positive', 'negative', 'neutral', 'uncertain']);

/**
 * Save an automatic interpretation beside its mention, inside the caller's answer
 * transaction. Reanalysis may add a new revision but never overwrites this row.
 * @param {Db} db
 * @param {number} mentionId
 * @param {string} revision
 * @param {MentionResult} mention
 * @param {string} at
 */
export function storeInterpretation(db, mentionId, revision, mention, at) {
  if (!STANCES.includes(mention.stance) || !mention.rule_id ||
      !Number.isInteger(mention.evidence_start) || !Number.isInteger(mention.evidence_end) ||
      mention.evidence_end <= mention.evidence_start) {
    throw new TypeError('A stance interpretation requires a label, rule, and nonempty answer span');
  }
  return run(db, `INSERT INTO mention_interpretations(mention_id, analysis_revision,
    method, stance, rule_id, evidence_start, evidence_end, review_flags, created_at)
    VALUES(?, ?, 'positive_stance', ?, ?, ?, ?, ?, ?)`, [
    mentionId, revision, mention.stance, mention.rule_id,
    mention.evidence_start, mention.evidence_end, JSON.stringify(mention.review_flags), at,
  ]).lastInsertRowid;
}

/**
 * Reinterpret an existing answer under a new revision. The mention receipt set must
 * still match; an alias detector change needs its own migration, not silent reanalysis.
 * @param {Db} db
 * @param {number} responseId
 * @param {string} revision
 * @param {string} at
 */
export function reanalyzeStoredResponse(db, responseId, revision, at) {
  if (!revision || revision === 'legacy-heuristic-v1') throw new TypeError('A new revision is required');
  return transaction(db, () => {
    const response = get(db, 'SELECT id, text FROM responses WHERE id = ?', [responseId]);
    if (!response || typeof response.text !== 'string' || response.text === '') throw new RangeError('A stored answer is required');
    const entities = all(db, `SELECT e.id, e.name, e.aliases, e.domains, e.ambiguous_name
      FROM entities e JOIN mentions m ON m.entity_id = e.id WHERE m.response_id = ?`, [responseId])
      .map((row) => ({ id: Number(row.id), name: String(row.name),
        aliases: JSON.parse(String(row.aliases)), domains: JSON.parse(String(row.domains)),
        ambiguousName: row.ambiguous_name === 1 }));
    const analyzed = extractMentions(response.text, entities);
    const stored = all(db, `SELECT id, entity_id, first_index, occurrences
      FROM mentions WHERE response_id = ? ORDER BY rank`, [responseId]);
    if (analyzed.length !== stored.length ||
        analyzed.some((mention) => !stored.some((row) => Number(row.entity_id) === mention.entity_id &&
          Number(row.first_index) === mention.first_index &&
          Number(row.occurrences) === mention.occurrences))) {
      throw new RangeError('Reanalysis changed mention detection; original receipts were preserved');
    }
    for (const row of stored) {
      const mention = analyzed.find((item) => item.entity_id === Number(row.entity_id));
      if (!mention) throw new RangeError('Stored mention is missing from reanalysis');
      storeInterpretation(db, Number(row.id), revision, mention, at);
    }
    return stored.length;
  });
}

/**
 * An answer and all of its decisions as of a stable correction ID. A null legacy
 * stance stays null; its stored recommendation bit is disclosed separately.
 * @param {Db} db
 * @param {number} responseId
 * @param {{revision?:string,cutoff?:number}} [options]
 */
export function answerReview(db, responseId, options = {}) {
  return transaction(db, () => reviewInTransaction(db, responseId, options));
}

/** @param {Db} db @param {number} responseId @param {{revision?:string,cutoff?:number}} options */
function reviewInTransaction(db, responseId, options) {
    const response = get(db, `SELECT id, text, analysis_revision, answer_status
      FROM responses WHERE id = ?`, [responseId]);
    if (!response) throw new RangeError('Answer not found');
    const revision = options.revision ?? String(response.analysis_revision ?? 'legacy-heuristic-v1');
    const maxId = Number(get(db, 'SELECT COALESCE(MAX(id), 0) AS id FROM mention_corrections')?.id ?? 0);
    const cutoff = options.cutoff ?? maxId;
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > maxId) throw new RangeError('Invalid correction cutoff');
    const rows = all(db, `SELECT m.id AS mention_id, m.entity_id, m.first_index, m.occurrences,
      m.rank, m.recommended AS captured_recommended, m.snippet,
      i.id AS interpretation_id, i.analysis_revision, i.method, i.stance,
      i.legacy_recommended, i.rule_id, i.evidence_start, i.evidence_end, i.review_flags
      FROM mentions m LEFT JOIN mention_interpretations i
        ON i.mention_id = m.id AND i.analysis_revision = ?
      WHERE m.response_id = ? ORDER BY m.rank`, [revision, responseId]);
    const mentions = rows.map((row) => {
      if (row.interpretation_id === null) throw new RangeError('Interpretation is unavailable for this revision');
      const corrections = all(db, `SELECT id, original_value, previous_value, replacement,
        reason, created_at, predecessor_id FROM mention_corrections
        WHERE interpretation_id = ? AND id <= ? ORDER BY id`, [Number(row.interpretation_id), cutoff]);
      const last = corrections.at(-1);
      const effectiveStance = last ? String(last.replacement) : row.stance === null ? null : String(row.stance);
      const legacyRecommended = row.legacy_recommended === null ? null : Number(row.legacy_recommended);
      return {
        mentionId: Number(row.mention_id), entityId: Number(row.entity_id),
        firstIndex: Number(row.first_index), occurrences: Number(row.occurrences),
        rank: Number(row.rank), snippet: String(row.snippet),
        capturedRecommended: Number(row.captured_recommended),
        interpretationId: Number(row.interpretation_id),
        analysisRevision: String(row.analysis_revision), method: String(row.method),
        originalStance: row.stance === null ? null : String(row.stance),
        legacyRecommended, ruleId: row.rule_id === null ? null : String(row.rule_id),
        evidenceStart: row.evidence_start === null ? null : Number(row.evidence_start),
        evidenceEnd: row.evidence_end === null ? null : Number(row.evidence_end),
        reviewFlags: JSON.parse(String(row.review_flags)),
        effectiveStance, recommended: last ? (effectiveStance === 'positive' ? 1 : 0)
          : row.method === 'legacy_heuristic' ? legacyRecommended : effectiveStance === 'positive' ? 1 : 0,
        correctionId: last ? Number(last.id) : null,
        corrections: corrections.map((correction) => ({
          id: Number(correction.id), originalValue: String(correction.original_value),
          previousValue: String(correction.previous_value), replacement: String(correction.replacement),
          reason: String(correction.reason), createdAt: String(correction.created_at),
          predecessorId: correction.predecessor_id === null ? null : Number(correction.predecessor_id),
        })),
      };
    });
    return { responseId, text: response.text, answerStatus: response.answer_status,
      captureRevision: response.analysis_revision ?? 'legacy-heuristic-v1', revision,
      correctionCutoff: cutoff, mentions };
}

/**
 * Append one correction with optimistic concurrency and an idempotency key.
 * @param {Db} db
 * @param {{responseId:number,interpretationId:number,previousCorrectionId:number|null,
 *   replacement:string,reason:string,requestId:string,at:string}} input
 */
export function appendCorrection(db, input) {
  if (!STANCES.includes(input.replacement) || !input.reason.trim() || input.reason.length > 1000 ||
      !input.requestId || input.requestId.length > 128) throw new TypeError('Invalid correction');
  return transaction(db, () => {
    const existing = get(db, `SELECT c.id, c.interpretation_id, c.predecessor_id,
      c.replacement, c.reason, m.response_id, i.analysis_revision FROM mention_corrections c
      JOIN mention_interpretations i ON i.id = c.interpretation_id
      JOIN mentions m ON m.id = i.mention_id WHERE c.request_id = ?`, [input.requestId]);
    if (existing) {
      if (Number(existing.response_id) !== input.responseId ||
          Number(existing.interpretation_id) !== input.interpretationId ||
          (existing.predecessor_id === null ? null : Number(existing.predecessor_id)) !== input.previousCorrectionId ||
          String(existing.replacement) !== input.replacement ||
          String(existing.reason) !== input.reason.trim()) throw new RangeError('Correction request ID was reused');
      return reviewInTransaction(db, input.responseId, {
        revision: String(existing.analysis_revision), cutoff: Number(existing.id),
      });
    }
    const row = get(db, `SELECT i.id, i.stance, i.legacy_recommended, i.analysis_revision, m.response_id
      FROM mention_interpretations i JOIN mentions m ON m.id = i.mention_id WHERE i.id = ?`, [input.interpretationId]);
    if (!row || Number(row.response_id) !== input.responseId) throw new RangeError('Interpretation does not belong to this answer');
    const last = get(db, `SELECT id, replacement FROM mention_corrections
      WHERE interpretation_id = ? ORDER BY id DESC LIMIT 1`, [input.interpretationId]);
    const lastId = last ? Number(last.id) : null;
    if (lastId !== input.previousCorrectionId) throw new RangeError('Stale correction; refresh the answer review');
    const original = row.stance === null ? `legacy:${Number(row.legacy_recommended)}` : String(row.stance);
    const correctionId = run(db, `INSERT INTO mention_corrections(interpretation_id, original_value, previous_value,
      replacement, reason, created_at, predecessor_id, request_id) VALUES(?,?,?,?,?,?,?,?)`, [
      input.interpretationId, original, last ? String(last.replacement) : original,
      input.replacement, input.reason.trim(), input.at, lastId, input.requestId,
    ]).lastInsertRowid;
    return reviewInTransaction(db, input.responseId, {
      revision: String(row.analysis_revision), cutoff: correctionId,
    });
  });
}

export { STANCE_REVISION };
