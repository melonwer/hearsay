import { createHash } from 'node:crypto';
import { all, get, isoNow, run, transaction } from './db.js';
import { intentEvidenceReport } from './evidence-report.js';
import { resolveMeasurementSeries } from './metrics.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./metrics.js').MeasurementSeries} Series */
/** @typedef {{responseId:number,mentionId:number,interpretationId:number,correctionId:number|null,stance:string}} StanceReviewRef */
/** @typedef {{responseIds:number[],queryIds:number[],sourceIds:number[],citationIds:number[],stanceReviews?:StanceReviewRef[]}} EvidenceIds */
/** @typedef {{candidateKey:string,candidateType:string,intentId:number,buyerRelevance:string,
 * seriesId:string,series:Series,windowStart:string,windowEnd:string,benchmarkRevisionId:string|null,
 * evidence:EvidenceIds,observedFinding:string,hypothesis:string,suggestedAction:string,
 * actionKind:string,targetUrl:string|null,productArea:string|null,controllability:string,
 * effortBand:string,priority:number,owner:string|null,reviewDate:string|null,status:string,
 * origin:string,author:string,missingEvidence:string[],claimClassification:string,
 * dismissalReason:string|null,combinedIntoId:number|null,resurfacedExplanation:string|null,
 * support:{responseCount:number,completedRunCount:number},existingOpportunityId:number|null,
 * newResponseIds:number[]}} Candidate */

const EFFORT = ['unknown', 'low', 'medium', 'high'];
const CONTROL = ['owned', 'third_party', 'product'];
const STATUSES = ['investigate', 'pending', 'planned', 'in_progress', 'shipped', 'reviewed', 'dismissed', 'no_action', 'combined'];
const DEFAULT_ACTION = 'Investigate the selected answer and its supporting evidence.';

export class OpportunityError extends RangeError {
  /** @param {string} message @param {number} [status] @param {string} [code] */
  constructor(message, status = 400, code = 'validation') {
    super(message);
    this.name = 'OpportunityError';
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} value @param {string} name @param {number} max */
function bounded(value, name, max) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new OpportunityError(`${name} exceeds ${max} characters`);
  return result;
}

/** @param {unknown} value @param {string} name @param {number} max */
function required(value, name, max) {
  const result = bounded(value, name, max);
  if (!result) throw new OpportunityError(`${name} is required`);
  return result;
}

/** @param {unknown} value @param {string} name */
function integer(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new OpportunityError(`${name} must be a positive integer`);
  return result;
}

/** @param {unknown} value @param {string} name */
function utc(value, name) {
  const result = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 19) + 'Z' !== result) {
    throw new OpportunityError(`${name} must be a UTC second-precision timestamp`);
  }
  return result;
}

/** @param {unknown} value @param {string} name */
function url(value, name) {
  const result = required(value, name, 2048);
  try {
    const parsed = new URL(result);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
    return parsed.href;
  } catch {
    throw new OpportunityError(`${name} must be an HTTP or HTTPS URL`);
  }
}

/** @param {unknown} value @param {string} name */
function ids(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100000) throw new OpportunityError(`${name} must be an array of at most 100000 IDs`);
  return [...new Set(value.map((item) => integer(item, name)))].sort((a, b) => a - b);
}

/** @param {unknown} value */
function normalizedEvidence(value) {
  const input = /** @type {Partial<EvidenceIds>} */ (value && typeof value === 'object' ? value : {});
  return {
    responseIds: ids(input.responseIds, 'responseIds'),
    queryIds: ids(input.queryIds, 'queryIds'),
    sourceIds: ids(input.sourceIds, 'sourceIds'),
    citationIds: ids(input.citationIds, 'citationIds'),
    stanceReviews: Array.isArray(input.stanceReviews) ? input.stanceReviews.map((review) => ({
      responseId: integer(review.responseId, 'stanceReview.responseId'),
      mentionId: integer(review.mentionId, 'stanceReview.mentionId'),
      interpretationId: integer(review.interpretationId, 'stanceReview.interpretationId'),
      correctionId: review.correctionId === null ? null : integer(review.correctionId, 'stanceReview.correctionId'),
      stance: required(review.stance, 'stanceReview.stance', 20),
    })) : [],
  };
}

/** @param {Db} db @param {Series} series */
function scopedSeries(db, series) {
  if (!series?.id) throw new OpportunityError('An exact measurement series is required');
  const start = utc(series.start, 'series.start');
  const end = utc(series.end, 'series.end');
  if (start >= end) throw new OpportunityError('Series window must be ordered');
  const selected = resolveMeasurementSeries(db, { seriesId: series.id, start, end });
  if (!selected || selected.surface !== series.surface
    || selected.executionProfileId !== series.executionProfileId
    || selected.benchmarkRevisionId !== series.benchmarkRevisionId
    || selected.analysisRevision !== series.analysisRevision
    || selected.comparisonKey !== series.comparisonKey
    || selected.searchPolicy !== series.searchPolicy) {
    throw new OpportunityError('Measurement series changed or does not match the selected window');
  }
  return selected;
}

/** @param {Db} db @param {Series} series @param {number} intentId */
function scopedReport(db, series, intentId) {
  const selected = scopedSeries(db, series);
  const report = intentEvidenceReport(db, { series: selected, intentId });
  if (!report?.answers.length) throw new OpportunityError('Intent has no comparable answers in the selected series');
  return report;
}

/** @param {ReturnType<typeof intentEvidenceReport>} report @param {EvidenceIds} evidence */
function validateEvidence(report, evidence) {
  if (!report) throw new OpportunityError('Selected evidence is unavailable');
  if (!evidence.responseIds.length) throw new OpportunityError('At least one comparable response is required');
  const responses = new Map(report.answers.map((answer) => [answer.id, answer]));
  for (const responseId of evidence.responseIds) {
    if (!responses.has(responseId)) throw new OpportunityError(`Response ${responseId} is outside the selected scope`);
  }
  const selected = report.answers.filter((answer) => evidence.responseIds.includes(answer.id));
  const queryIds = new Set(selected.flatMap((answer) => answer.searchQueries.map((record) => record.id)));
  const sourceIds = new Set(selected.flatMap((answer) => answer.sourceObservations.map((record) => record.id)));
  const citationIds = new Set(selected.flatMap((answer) => answer.answerCitations.map((record) => record.id)));
  for (const recordId of evidence.queryIds) if (!queryIds.has(recordId)) {
    throw new OpportunityError(`queryIds record ${recordId} is outside the selected responses`);
  }
  for (const recordId of evidence.sourceIds) if (!sourceIds.has(recordId)) {
    throw new OpportunityError(`sourceIds record ${recordId} is outside the selected responses`);
  }
  for (const recordId of evidence.citationIds) if (!citationIds.has(recordId)) {
    throw new OpportunityError(`citationIds record ${recordId} is outside the selected responses`);
  }
  for (const review of evidence.stanceReviews ?? []) {
    const answer = responses.get(review.responseId);
    const mention = answer?.mentions.find((item) => item.mentionId === review.mentionId);
    if (!evidence.responseIds.includes(review.responseId) || !mention
      || mention.interpretationId !== review.interpretationId
      || mention.correctionId !== review.correctionId
      || mention.effectiveStance !== review.stance) {
      throw new OpportunityError('A saved stance review no longer matches the selected answer');
    }
  }
}

/** @param {Db} db @param {number[]} responseIds */
function completedResponseIds(db, responseIds) {
  if (!responseIds.length) return [];
  const result = [];
  for (let offset = 0; offset < responseIds.length; offset += 500) {
    const chunk = responseIds.slice(offset, offset + 500);
    result.push(...all(db, `SELECT r.id FROM responses r JOIN runs x ON x.id = r.run_id
      WHERE x.status = 'done' AND r.id IN (${chunk.map(() => '?').join(',')})`, chunk)
      .map((row) => Number(row.id)));
  }
  return result;
}

/** @param {EvidenceIds} evidence */
function observedFinding(evidence) {
  const n = evidence.responseIds.length;
  const parts = [`${n} selected comparable ${n === 1 ? 'answer' : 'answers'}`];
  if (evidence.queryIds.length) parts.push(`${evidence.queryIds.length} observed search ${evidence.queryIds.length === 1 ? 'query' : 'queries'}`);
  if (evidence.sourceIds.length) parts.push(`${evidence.sourceIds.length} source ${evidence.sourceIds.length === 1 ? 'observation' : 'observations'}`);
  if (evidence.citationIds.length) parts.push(`${evidence.citationIds.length} answer ${evidence.citationIds.length === 1 ? 'citation' : 'citations'}`);
  return `Review ${parts.join(', ')}. The linked records are observations; the proposed cause remains a hypothesis.`;
}

/** @param {string[]} parts */
function key(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** @param {Db} db @param {number[]} responseIds */
function runSupport(db, responseIds) {
  if (!responseIds.length) return { responseCount: 0, completedRunCount: 0 };
  const runs = new Set();
  for (let offset = 0; offset < responseIds.length; offset += 500) {
    const chunk = responseIds.slice(offset, offset + 500);
    for (const row of all(db, `SELECT DISTINCT r.run_id FROM responses r JOIN runs x ON x.id = r.run_id
      WHERE x.status = 'done' AND r.id IN (${chunk.map(() => '?').join(',')})`, chunk)) {
      runs.add(Number(row.run_id));
    }
  }
  return { responseCount: completedResponseIds(db, responseIds).length, completedRunCount: runs.size };
}

/** @param {Db} db @param {Series} series */
function brandForSeries(db, series) {
  if (series.benchmarkRevisionId) {
    const row = get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [series.benchmarkRevisionId]);
    if (row) {
      const snapshot = JSON.parse(String(row.snapshot_json));
      if (Array.isArray(snapshot.entities)) {
        const brand = snapshot.entities.find((/** @type {{role?:string,id?:number}} */ entity) => entity.role === 'brand');
        return brand?.id ? Number(brand.id) : null;
      }
    }
  }
  const brand = get(db, 'SELECT id FROM entities WHERE is_self = 1 LIMIT 1');
  return brand ? Number(brand.id) : null;
}

/** @param {Series} series @param {number} intentId @param {string} type @param {string} target @param {number|null} brandId */
function candidateKey(series, intentId, type, target, brandId) {
  return key([type, String(intentId), series.id, series.benchmarkRevisionId ?? '', target,
    brandId === null ? '' : String(brandId)]);
}

/** @param {Db} db @param {{series:Series,intentId?:number}} input */
export function deriveOpportunityCandidates(db, input) {
  const series = scopedSeries(db, input.series);
  const report = intentEvidenceReport(db, { series, ...(input.intentId === undefined ? {} : { intentId: integer(input.intentId, 'intentId') }) });
  if (!report) return [];
  const brandId = brandForSeries(db, series);
  const completed = new Set(completedResponseIds(db, report.answers.map((answer) => answer.id)));
  /** @type {Map<number, NonNullable<ReturnType<typeof intentEvidenceReport>>['answers']>} */
  const byIntent = new Map();
  for (const answer of report.answers) {
    const intentId = answer.question.intentId;
    if (intentId === null) continue;
    let list = byIntent.get(intentId);
    if (!list) { list = []; byIntent.set(intentId, list); }
    if (completed.has(answer.id)) list.push(answer);
  }
  /** @type {Candidate[]} */
  const result = [];
  for (const [intentId, answers] of byIntent) {
    const subset = intentEvidenceReport(db, { series, intentId });
    if (!subset) continue;
    const intentLabel = subset.intent?.label ?? `Intent ${intentId}`;
    /** @param {string} type @param {string} target @param {EvidenceIds} evidence @param {string} finding @param {string|null} targetUrl */
    const push = (type, target, evidence, finding, targetUrl) => {
      const support = runSupport(db, evidence.responseIds);
      if (['source_without_brand', 'query_theme'].includes(type)
        && (support.responseCount < 2 || support.completedRunCount < 2)) return;
      const candidateKeyValue = candidateKey(series, intentId, type, target, brandId);
      const prior = get(db, 'SELECT id, status, updated_at FROM opportunities WHERE candidate_key = ?', [candidateKeyValue]);
      if (prior?.status === 'combined') return;
      const oldIds = prior ? all(db, 'SELECT response_id FROM opportunity_support WHERE opportunity_id = ?', [Number(prior.id)])
        .map((row) => Number(row.response_id)) : [];
      let newResponseIds = evidence.responseIds.filter((id) => !oldIds.includes(id));
      if (prior && ['dismissed', 'no_action'].includes(String(prior.status))) {
        const laterIds = new Set();
        for (let offset = 0; offset < newResponseIds.length; offset += 500) {
          const chunk = newResponseIds.slice(offset, offset + 500);
          for (const row of all(db, `SELECT id FROM responses WHERE created_at > ?
            AND id IN (${chunk.map(() => '?').join(',')})`, [String(prior.updated_at), ...chunk])) {
            laterIds.add(Number(row.id));
          }
        }
        newResponseIds = newResponseIds.filter((id) => laterIds.has(id));
        if (!newResponseIds.length) return;
      }
      result.push({ candidateKey: candidateKeyValue, candidateType: type, intentId,
        buyerRelevance: intentLabel, seriesId: series.id, series, windowStart: series.start,
        windowEnd: series.end, benchmarkRevisionId: series.benchmarkRevisionId,
        evidence, observedFinding: finding, hypothesis: 'The observed pattern may point to a buyer information gap; verify before acting.',
        suggestedAction: 'Investigate the linked answers and source context.', targetUrl,
        actionKind: 'investigate', productArea: targetUrl ? null : 'Buyer-facing product information',
        controllability: targetUrl ? 'third_party' : 'product', effortBand: 'unknown',
        priority: 0, owner: null, reviewDate: null, status: 'investigate', origin: 'deterministic',
        author: 'Hearsay', missingEvidence: targetUrl ? ['reviewed_page_evidence'] : [],
        claimClassification: 'observation', dismissalReason: null, combinedIntoId: null,
        resurfacedExplanation: prior && newResponseIds.length
          ? `New supporting answer ${newResponseIds.join(', ')} appeared in this selection.` : null,
        support, existingOpportunityId: prior ? Number(prior.id) : null, newResponseIds });
    };
    if (brandId !== null) {
      const answerById = new Map(answers.map((answer) => [answer.id, answer]));
      for (const source of subset.sources) {
        const responseIds = source.responseIds.filter((id) => {
          const answer = answerById.get(id);
          return answer && !answer.mentions.some((mention) => mention.entityId === brandId);
        }).sort((a, b) => a - b);
        const eligibleSourceIds = new Set(responseIds.flatMap((id) =>
          answerById.get(id)?.sourceObservations.map((item) => item.id) ?? []));
        const sourceIds = source.observationIds.filter((id) => eligibleSourceIds.has(id));
        if (!responseIds.length) continue;
        push('source_without_brand', JSON.stringify([source.normalizedUrl ?? source.url, source.provenance]),
          { responseIds, queryIds: [], sourceIds: sourceIds.sort((a, b) => a - b), citationIds: [] },
          `${responseIds.length} comparable answers observed ${source.url} as a source without an identified brand mention. This does not establish why the brand was omitted.`, source.url);
      }
    }
    for (const theme of subset.themeGroups) {
      const answerById = new Map(answers.map((answer) => [answer.id, answer]));
      const responseIds = theme.responseIds.filter((id) => answerById.has(id))
        .sort((a, b) => a - b);
      const eligibleQueryIds = new Set(responseIds.flatMap((id) =>
        answerById.get(id)?.searchQueries.map((query) => query.id) ?? []));
      const queryIds = theme.queryIds.filter((id) => eligibleQueryIds.has(id));
      push('query_theme', String(theme.themeId),
        { responseIds, queryIds: queryIds.sort((a, b) => a - b), sourceIds: [], citationIds: [] },
        `${responseIds.length} comparable answers include searches in the user-grouped “${theme.label}” theme. The group reflects a user assignment.`, null);
    }
    if (brandId !== null) {
      for (const stance of ['negative', 'uncertain']) {
        const matched = answers.filter((answer) => answer.mentions.some((mention) =>
          mention.entityId === brandId && mention.effectiveStance === stance));
        if (!matched.length) continue;
        const responseIds = matched.map((answer) => answer.id).sort((a, b) => a - b);
        push(`${stance}_brand_statement`, `${brandId}:${stance}`,
          { responseIds, queryIds: [], sourceIds: [], citationIds: [],
            stanceReviews: matched.flatMap((answer) => answer.mentions
              .filter((mention) => mention.entityId === brandId && mention.effectiveStance === stance)
              .map((mention) => ({ responseId: answer.id, mentionId: mention.mentionId,
                interpretationId: mention.interpretationId, correctionId: mention.correctionId,
                stance }))) },
          `${responseIds.length} comparable answers contain an explicitly ${stance} brand statement. Check the linked answer spans and current facts before acting.`, null);
      }
    }
  }
  return result.sort((a, b) => b.support.responseCount - a.support.responseCount
    || a.candidateType.localeCompare(b.candidateType) || a.candidateKey.localeCompare(b.candidateKey));
}

/** @param {Record<string, unknown>} row */
function shape(row) {
  return {
    id: Number(row.id), candidateKey: String(row.candidate_key), candidateType: String(row.candidate_type),
    intentId: Number(row.intent_id), buyerRelevance: String(row.buyer_relevance),
    seriesId: String(row.series_id), series: JSON.parse(String(row.series_json)),
    windowStart: String(row.window_start), windowEnd: String(row.window_end),
    benchmarkRevisionId: row.benchmark_revision_id === null ? null : String(row.benchmark_revision_id),
    evidence: normalizedEvidence(JSON.parse(String(row.evidence_json))),
    observedFinding: String(row.observed_finding), hypothesis: String(row.hypothesis),
    suggestedAction: String(row.suggested_action), actionKind: String(row.action_kind),
    targetUrl: row.target_url === null ? null : String(row.target_url),
    productArea: row.product_area === null ? null : String(row.product_area),
    controllability: String(row.controllability), effortBand: String(row.effort_band),
    priority: Number(row.priority), owner: row.owner === null ? null : String(row.owner),
    reviewDate: row.review_date === null ? null : String(row.review_date), status: String(row.status),
    origin: String(row.origin), author: String(row.author),
    missingEvidence: JSON.parse(String(row.missing_evidence_json)),
    claimClassification: String(row.claim_classification),
    dismissalReason: row.dismissal_reason === null ? null : String(row.dismissal_reason),
    combinedIntoId: row.combined_into_id === null ? null : Number(row.combined_into_id),
    resurfacedExplanation: row.resurfaced_explanation === null ? null : String(row.resurfaced_explanation),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

/** @param {Db} db @param {number} id */
export function getOpportunity(db, id) {
  const row = get(db, 'SELECT * FROM opportunities WHERE id = ?', [integer(id, 'opportunityId')]);
  if (!row) return null;
  const item = shape(row);
  const pages = all(db, 'SELECT * FROM opportunity_page_evidence WHERE opportunity_id = ? ORDER BY id', [id]);
  const events = all(db, 'SELECT * FROM opportunity_events WHERE opportunity_id = ? ORDER BY id', [id]);
  let staleEvidence = false;
  try {
    validateEvidence(intentEvidenceReport(db, { series: item.series, intentId: item.intentId }), item.evidence);
    if (completedResponseIds(db, item.evidence.responseIds).length !== item.evidence.responseIds.length) staleEvidence = true;
  }
  catch { staleEvidence = true; }
  return { ...item, staleEvidence,
    pageEvidence: pages.map((page) => ({ id: Number(page.id), url: String(page.url),
      observedAt: String(page.observed_at), excerpt: String(page.excerpt), provenance: String(page.provenance),
      sourceObservationId: page.source_observation_id === null ? null : Number(page.source_observation_id),
      isAuthoritative: Number(page.is_authoritative) === 1,
      author: String(page.author), reviewedAt: page.reviewed_at === null ? null : String(page.reviewed_at),
      reviewedBy: page.reviewed_by === null ? null : String(page.reviewed_by), createdAt: String(page.created_at) })),
    events: events.map((event) => ({ id: Number(event.id), eventType: String(event.event_type),
      details: JSON.parse(String(event.details_json)), author: String(event.author), createdAt: String(event.created_at) })) };
}

/** @param {Db} db @param {{series?:Series,includeDismissed?:boolean}} [input] */
export function listOpportunities(db, input = {}) {
  const rows = all(db, `SELECT id FROM opportunities
    WHERE (? IS NULL OR (series_id = ? AND window_start = ? AND window_end = ?))
      AND (? = 1 OR status NOT IN ('dismissed','no_action','combined'))
    ORDER BY priority DESC, CASE effort_band WHEN 'low' THEN 0 WHEN 'medium' THEN 1
      WHEN 'high' THEN 2 ELSE 3 END, updated_at DESC, id DESC`, [
    input.series?.id ?? null, input.series?.id ?? null, input.series?.start ?? null,
    input.series?.end ?? null, input.includeDismissed ? 1 : 0,
  ]);
  return rows.map((row) => getOpportunity(db, Number(row.id))).filter((item) => item !== null);
}

/** @param {Db} db @param {number} id @param {string} type @param {unknown} details @param {string} author @param {string} at */
function event(db, id, type, details, author, at) {
  run(db, `INSERT INTO opportunity_events(opportunity_id,event_type,details_json,author,created_at)
    VALUES(?,?,?,?,?)`, [id, type, JSON.stringify(details), author, at]);
}

/** @param {Db} db @param {ReturnType<typeof deriveOpportunityCandidates>[number]} candidate @param {string} at */
function saveCandidate(db, candidate, at) {
  const prior = get(db, 'SELECT * FROM opportunities WHERE candidate_key = ?', [candidate.candidateKey]);
  if (prior) {
    const old = shape(prior);
    const seen = new Set(all(db, 'SELECT response_id FROM opportunity_support WHERE opportunity_id = ?', [old.id])
      .map((row) => Number(row.response_id)));
    const newResponseIds = candidate.evidence.responseIds.filter((id) => !seen.has(id));
    if (['dismissed', 'no_action', 'combined'].includes(old.status) && !newResponseIds.length) return getOpportunity(db, old.id);
    if (newResponseIds.length) {
      const resurfaced = ['dismissed', 'no_action', 'combined'].includes(old.status);
      run(db, `UPDATE opportunities SET series_json = ?, window_start = ?, window_end = ?,
        evidence_json = ?, observed_finding = ?, status = ?, resurfaced_explanation = ?,
        dismissal_reason = ?, combined_into_id = ?, updated_at = ? WHERE id = ?`, [
        JSON.stringify(candidate.series), candidate.windowStart, candidate.windowEnd,
        JSON.stringify(candidate.evidence), candidate.observedFinding,
        resurfaced ? 'investigate' : old.status,
        resurfaced ? candidate.resurfacedExplanation : old.resurfacedExplanation,
        resurfaced ? null : old.dismissalReason, resurfaced ? null : old.combinedIntoId,
        at, old.id,
      ]);
      event(db, old.id, resurfaced ? 'resurfaced' : 'new_support',
        { previous: old, newResponseIds, selection: candidate.series }, 'Hearsay', at);
      for (const responseId of newResponseIds) run(db, `INSERT INTO opportunity_support
        (opportunity_id,response_id,first_seen_at) VALUES(?,?,?)`, [old.id, responseId, at]);
    }
    return getOpportunity(db, old.id);
  }
  const id = run(db, `INSERT INTO opportunities(candidate_key,candidate_type,intent_id,buyer_relevance,
    series_id,series_json,window_start,window_end,benchmark_revision_id,evidence_json,
    observed_finding,hypothesis,suggested_action,action_kind,target_url,product_area,controllability,
    effort_band,priority,owner,review_date,status,origin,author,missing_evidence_json,
    claim_classification,dismissal_reason,combined_into_id,resurfaced_explanation,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    candidate.candidateKey, candidate.candidateType, candidate.intentId, candidate.buyerRelevance,
    candidate.seriesId, JSON.stringify(candidate.series), candidate.windowStart, candidate.windowEnd,
    candidate.benchmarkRevisionId, JSON.stringify(candidate.evidence), candidate.observedFinding,
    candidate.hypothesis, candidate.suggestedAction, candidate.actionKind, candidate.targetUrl, candidate.productArea,
    candidate.controllability, candidate.effortBand, candidate.priority, candidate.owner,
    candidate.reviewDate, candidate.status, candidate.origin, candidate.author,
    JSON.stringify(candidate.missingEvidence), candidate.claimClassification,
    candidate.dismissalReason, candidate.combinedIntoId, candidate.resurfacedExplanation, at, at,
  ]).lastInsertRowid;
  event(db, id, 'generated', { evidence: candidate.evidence, selection: candidate.series }, 'Hearsay', at);
  for (const responseId of candidate.evidence.responseIds) run(db, `INSERT INTO opportunity_support
    (opportunity_id,response_id,first_seen_at) VALUES(?,?,?)`, [id, responseId, at]);
  return getOpportunity(db, id);
}

/** @param {Db} db @param {{series:Series,intentId?:number,candidateKey?:string,now?:Date|string}} input */
export function generateOpportunityCandidates(db, input) {
  const allCandidates = deriveOpportunityCandidates(db, input);
  const candidates = input.candidateKey
    ? allCandidates.filter((candidate) => candidate.candidateKey === input.candidateKey)
    : allCandidates;
  if (input.candidateKey && candidates.length === 0) {
    throw new OpportunityError('Candidate is unavailable in the selected scope', 404, 'not_found');
  }
  const at = isoNow(new Date(input.now ?? Date.now()));
  return transaction(db, () => candidates.map((candidate) => saveCandidate(db, candidate, at)));
}

/** @param {Db} db @param {{series:Series,intentId:number,evidence:EvidenceIds,origin:'manual'|'assistant',author:string,
 * buyerRelevance?:string,hypothesis?:string,suggestedAction?:string,actionKind?:string,targetUrl?:string,productArea?:string,
 * controllability?:string,effortBand?:string,claimedFalseOrOutdated?:boolean,now?:Date|string}} input */
export function createOpportunity(db, input) {
  const intentId = integer(input.intentId, 'intentId');
  const report = scopedReport(db, input.series, intentId);
  const evidence = normalizedEvidence(input.evidence);
  validateEvidence(report, evidence);
  if (completedResponseIds(db, evidence.responseIds).length !== evidence.responseIds.length) {
    throw new OpportunityError('Selected evidence must come from completed runs');
  }
  const origin = input.origin;
  if (!['manual', 'assistant'].includes(origin)) throw new OpportunityError('Origin must be manual or assistant');
  if (origin === 'assistant') required(input.hypothesis, 'hypothesis', 2000);
  const author = required(input.author, 'author', 120);
  const targetUrl = input.targetUrl ? url(input.targetUrl, 'targetUrl') : null;
  const productArea = bounded(input.productArea, 'productArea', 160)
    || (targetUrl ? null : 'Buyer-facing product information');
  const controllability = input.controllability ?? (targetUrl ? 'owned' : 'product');
  const effortBand = input.effortBand ?? 'unknown';
  if (!CONTROL.includes(controllability) || !EFFORT.includes(effortBand)) throw new OpportunityError('Invalid controllability or effort band');
  const hypothesis = bounded(input.hypothesis, 'hypothesis', 2000)
    || 'The selected answer may indicate a buyer information gap; verify before acting.';
  const suggestedAction = bounded(input.suggestedAction, 'suggestedAction', 2000)
    || DEFAULT_ACTION;
  const actionKind = input.actionKind ?? 'investigate';
  if (!['investigate', 'page_change', 'other'].includes(actionKind)) throw new OpportunityError('Invalid action kind');
  const at = isoNow(new Date(input.now ?? Date.now()));
  const candidateType = 'selected_answer';
  const candidateKeyValue = key(['selected_answer', String(intentId), report.series.id,
    report.series.benchmarkRevisionId ?? '', evidence.responseIds.join(',')]);
  const existing = get(db, 'SELECT id FROM opportunities WHERE candidate_key = ?', [candidateKeyValue]);
  if (existing) throw new OpportunityError('This selected answer already has an opportunity', 409, 'conflict');
  const status = origin === 'assistant' ? 'pending' : 'investigate';
  const missingEvidence = targetUrl ? ['reviewed_page_evidence'] : [];
  if (input.claimedFalseOrOutdated) missingEvidence.push('authoritative_claim_evidence');
  const id = transaction(db, () => {
    const created = run(db, `INSERT INTO opportunities(candidate_key,candidate_type,intent_id,buyer_relevance,
      series_id,series_json,window_start,window_end,benchmark_revision_id,evidence_json,
      observed_finding,hypothesis,suggested_action,action_kind,target_url,product_area,controllability,
      effort_band,priority,owner,review_date,status,origin,author,missing_evidence_json,
      claim_classification,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      candidateKeyValue, candidateType, intentId,
      bounded(input.buyerRelevance, 'buyerRelevance', 240) || report.intent?.label || `Intent ${intentId}`,
      report.series.id, JSON.stringify(report.series), report.series.start, report.series.end,
      report.series.benchmarkRevisionId, JSON.stringify(evidence), observedFinding(evidence),
      hypothesis, suggestedAction, actionKind, targetUrl, productArea, controllability, effortBand, 0,
      null, null, status, origin, author, JSON.stringify(missingEvidence),
      input.claimedFalseOrOutdated ? 'verify_claim' : 'observation', at, at,
    ]).lastInsertRowid;
    event(db, created, 'created', { evidence, selection: report.series, origin,
      claimClassification: input.claimedFalseOrOutdated ? 'verify_claim' : 'observation' }, author, at);
    return created;
  });
  return getOpportunity(db, id);
}

/** @param {Db} db @param {{id:number,status?:string,priority?:number,effortBand?:string,owner?:string,
 * reviewDate?:string,dismissalReason?:string,hypothesis?:string,suggestedAction?:string,
 * targetUrl?:string,productArea?:string,controllability?:string,actionKind?:string,author:string,now?:Date|string}} input */
export function reviewOpportunity(db, input) {
  const current = getOpportunity(db, input.id);
  if (!current) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  const author = required(input.author, 'author', 120);
  const status = input.status ?? current.status;
  if (!STATUSES.includes(status) || status === 'combined') throw new OpportunityError('Invalid opportunity status');
  if (current.origin === 'assistant' && current.status === 'pending'
    && !['investigate', 'planned', 'dismissed', 'no_action'].includes(status)) {
    throw new OpportunityError('Assistant proposal needs human acceptance or dismissal');
  }
  if (current.origin === 'assistant' && current.status === 'pending' && author === current.author
    && ['investigate', 'planned'].includes(status)) throw new OpportunityError('Assistant cannot accept its own proposal');
  const priority = input.priority === undefined ? current.priority : Number(input.priority);
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 3) throw new OpportunityError('Priority must be 0 to 3');
  const effortBand = input.effortBand ?? current.effortBand;
  if (!EFFORT.includes(effortBand)) throw new OpportunityError('Invalid effort band');
  const owner = input.owner === undefined ? current.owner : bounded(input.owner, 'owner', 120) || null;
  const reviewDate = input.reviewDate === undefined ? current.reviewDate : bounded(input.reviewDate, 'reviewDate', 10) || null;
  if (reviewDate && (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)
    || Number.isNaN(Date.parse(`${reviewDate}T00:00:00Z`)))) throw new OpportunityError('Review date must be YYYY-MM-DD');
  if (['planned', 'in_progress', 'shipped'].includes(status) && (!owner || !reviewDate)) {
    throw new OpportunityError('Planned actions need an owner and review date');
  }
  const hypothesis = input.hypothesis === undefined ? current.hypothesis : required(input.hypothesis, 'hypothesis', 2000);
  const suggestedAction = input.suggestedAction === undefined ? current.suggestedAction
    : required(input.suggestedAction, 'suggestedAction', 2000);
  const actionKind = input.actionKind ?? current.actionKind;
  if (!['investigate', 'page_change', 'other'].includes(actionKind)) throw new OpportunityError('Invalid action kind');
  const targetUrl = input.targetUrl === undefined ? current.targetUrl
    : input.targetUrl ? url(input.targetUrl, 'targetUrl') : null;
  const productArea = input.productArea === undefined ? current.productArea
    : bounded(input.productArea, 'productArea', 160) || null;
  if (!targetUrl && !productArea) throw new OpportunityError('A target URL or product area is required');
  const controllability = input.controllability ?? current.controllability;
  if (!CONTROL.includes(controllability)) throw new OpportunityError('Invalid controllability');
  const dismissalReason = ['dismissed', 'no_action'].includes(status)
    ? required(input.dismissalReason ?? current.dismissalReason, 'dismissalReason', 1000) : null;
  if (['planned', 'in_progress', 'shipped'].includes(status) && current.staleEvidence) {
    throw new OpportunityError('Selected evidence is no longer available in the saved scope');
  }
  if (['planned', 'in_progress', 'shipped'].includes(status) && actionKind === 'page_change' && (!targetUrl || !current.pageEvidence.some((page) => page.reviewedAt
    && page.url === targetUrl))) throw new OpportunityError('A page-specific action requires reviewed page evidence');
  if (['planned', 'in_progress', 'shipped'].includes(status) && actionKind === 'page_change'
    && suggestedAction === DEFAULT_ACTION) {
    throw new OpportunityError('Describe the specific page change before planning it');
  }
  if (['planned', 'in_progress', 'shipped'].includes(status) && current.claimClassification === 'verify_claim'
    && !current.pageEvidence.some((page) => page.provenance === 'manual_user' && page.isAuthoritative && page.reviewedAt)) {
    throw new OpportunityError('A false or outdated claim requires user-supplied authoritative evidence');
  }
  const at = isoNow(new Date(input.now ?? Date.now()));
  transaction(db, () => {
    run(db, `UPDATE opportunities SET status=?,priority=?,effort_band=?,owner=?,review_date=?,
      hypothesis=?,suggested_action=?,action_kind=?,target_url=?,product_area=?,controllability=?,
      dismissal_reason=?,missing_evidence_json=?,updated_at=? WHERE id=?`, [
      status, priority, effortBand, owner, reviewDate, hypothesis, suggestedAction, actionKind,
      targetUrl, productArea, controllability, dismissalReason,
      JSON.stringify([
        ...(targetUrl && !current.pageEvidence.some((page) => page.reviewedAt && page.url === targetUrl)
          ? ['reviewed_page_evidence'] : []),
        ...(current.claimClassification === 'verify_claim'
          && !current.pageEvidence.some((page) => page.provenance === 'manual_user' && page.isAuthoritative && page.reviewedAt)
          ? ['authoritative_claim_evidence'] : []),
      ]), at, current.id,
    ]);
    event(db, current.id, 'reviewed', { previous: current, status, priority, effortBand,
      owner, reviewDate, hypothesis, suggestedAction, targetUrl, productArea, controllability,
      dismissalReason, actionKind }, author, at);
  });
  return getOpportunity(db, current.id);
}

/** @param {Db} db @param {{id:number,url:string,observedAt:string,excerpt:string,
 * provenance:'manual_user'|'manual_assistant'|'observed_fetch',sourceObservationId?:number,
 * isAuthoritative?:boolean,author:string,now?:Date|string}} input */
export function attachOpportunityPageEvidence(db, input) {
  const current = getOpportunity(db, input.id);
  if (!current) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  const observedAt = utc(input.observedAt, 'observedAt');
  const pageUrl = url(input.url, 'url');
  const excerpt = required(input.excerpt, 'excerpt', 2000);
  const provenance = input.provenance;
  if (!['manual_user', 'manual_assistant', 'observed_fetch'].includes(provenance)) throw new OpportunityError('Invalid page evidence provenance');
  const author = required(input.author, 'author', 120);
  const sourceObservationId = input.sourceObservationId === undefined ? null
    : integer(input.sourceObservationId, 'sourceObservationId');
  const isAuthoritative = input.isAuthoritative === true;
  if (isAuthoritative && provenance !== 'manual_user') {
    throw new OpportunityError('Only a user-supplied excerpt can be marked authoritative');
  }
  if (provenance === 'observed_fetch') {
    if (!sourceObservationId || !current.evidence.sourceIds.includes(sourceObservationId)) {
      throw new OpportunityError('Observed fetch must reference a selected source observation');
    }
    const source = get(db, `SELECT s.url, s.excerpt, s.provenance,
      COALESCE(e.observed_at, r.created_at) AS observed_at
      FROM source_observations s JOIN responses r ON r.id = s.response_id
      LEFT JOIN search_events e ON e.id = s.search_event_id WHERE s.id = ?`, [sourceObservationId]);
    if (!source || source.provenance !== 'fetch' || url(source.url, 'source URL') !== pageUrl
      || !String(source.excerpt ?? '').includes(excerpt) || source.observed_at !== observedAt) {
      throw new OpportunityError('Observed fetch excerpt must match the selected source');
    }
  } else if (sourceObservationId !== null) {
    throw new OpportunityError('Manual page evidence cannot claim a provider observation');
  }
  const at = isoNow(new Date(input.now ?? Date.now()));
  const id = transaction(db, () => {
    const inserted = run(db, `INSERT INTO opportunity_page_evidence(opportunity_id,url,observed_at,
      excerpt,provenance,source_observation_id,is_authoritative,author,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, [
      current.id, pageUrl, observedAt, excerpt, provenance, sourceObservationId,
      isAuthoritative ? 1 : 0, author, at,
    ]).lastInsertRowid;
    event(db, current.id, 'page_evidence_attached', { pageEvidenceId: inserted,
      url: pageUrl, observedAt, provenance, sourceObservationId, isAuthoritative }, author, at);
    return inserted;
  });
  return getOpportunity(db, current.id)?.pageEvidence.find((page) => page.id === id) ?? null;
}

/** @param {Db} db @param {{id:number,pageEvidenceId:number,author:string,now?:Date|string}} input */
export function reviewOpportunityPageEvidence(db, input) {
  const current = getOpportunity(db, input.id);
  if (!current) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  const pageId = integer(input.pageEvidenceId, 'pageEvidenceId');
  const page = current.pageEvidence.find((item) => item.id === pageId);
  if (!page) throw new OpportunityError('Page evidence not found', 404, 'not_found');
  const author = required(input.author, 'author', 120);
  if (page.provenance === 'manual_assistant' && author === page.author) {
    throw new OpportunityError('Assistant cannot review its own page evidence');
  }
  if (page.reviewedAt) return page;
  const at = isoNow(new Date(input.now ?? Date.now()));
  transaction(db, () => {
    run(db, 'UPDATE opportunity_page_evidence SET reviewed_at = ?, reviewed_by = ? WHERE id = ?', [at, author, pageId]);
    const reviewedPages = current.pageEvidence.map((item) => item.id === pageId
      ? { ...item, reviewedAt: at } : item);
    const missingEvidence = [
      ...(current.targetUrl && !reviewedPages.some((item) => item.reviewedAt && item.url === current.targetUrl)
        ? ['reviewed_page_evidence'] : []),
      ...(current.claimClassification === 'verify_claim'
        && !reviewedPages.some((item) => item.reviewedAt && item.provenance === 'manual_user' && item.isAuthoritative)
        ? ['authoritative_claim_evidence'] : []),
    ];
    run(db, 'UPDATE opportunities SET missing_evidence_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(missingEvidence), at, current.id,
    ]);
    event(db, current.id, 'page_evidence_reviewed', { pageEvidenceId: pageId }, author, at);
  });
  return getOpportunity(db, current.id)?.pageEvidence.find((item) => item.id === pageId) ?? null;
}

/** @param {Db} db @param {{targetId:number,sourceId:number,author:string,now?:Date|string}} input */
export function combineOpportunities(db, input) {
  const target = getOpportunity(db, input.targetId);
  const source = getOpportunity(db, input.sourceId);
  if (!target || !source) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  if (target.id === source.id) throw new OpportunityError('Two distinct opportunities are required');
  if (target.seriesId !== source.seriesId || target.windowStart !== source.windowStart
    || target.windowEnd !== source.windowEnd || target.intentId !== source.intentId) {
    throw new OpportunityError('Combined opportunities must share the exact series, window, and intent');
  }
  if (source.status === 'combined') throw new OpportunityError('Opportunity is already combined');
  const author = required(input.author, 'author', 120);
  const at = isoNow(new Date(input.now ?? Date.now()));
  transaction(db, () => {
    run(db, `UPDATE opportunities SET status='combined', combined_into_id=?, updated_at=? WHERE id=?`, [target.id, at, source.id]);
    event(db, source.id, 'combined', { targetId: target.id, evidence: source.evidence }, author, at);
    event(db, target.id, 'combined_source', { sourceId: source.id, evidence: source.evidence }, author, at);
  });
  return getOpportunity(db, target.id);
}
