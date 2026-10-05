import { all, get } from './db.js';
import { intentEvidenceReport } from './evidence-report.js';
import { actualSpend, listMeasurementSeries, mentionRate, recommendationRate,
  stanceRecommendationRate } from './metrics.js';
import { stableIdentity } from './measurement-contract.js';
import { listLedgerEntries, listOutcomeRecords } from './outcomes.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

const WEEK_MS = 7 * 86_400_000;
const MAX_SERIES = 5000;
const INTERPRETATION = 'Visibility changes describe saved observations. Reported outcomes and expenses are user-entered; neither proves that a Hearsay action caused a business result.';

export class WeeklyReviewError extends Error {
  /** @param {string} message @param {number} [status] @param {string} [code] */
  constructor(message, status = 422, code = 'unprocessable') {
    super(message);
    this.name = 'WeeklyReviewError';
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} value @param {string} label */
function utc(value, label) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)
    || !Number.isFinite(Date.parse(text))
    || new Date(text).toISOString().slice(0, 19) + 'Z' !== text) {
    throw new WeeklyReviewError(`${label} must be an exact UTC timestamp`);
  }
  return text;
}

/** @param {Db} db */
export function listKnownWeeklySeries(db) {
  const identities = all(db, `SELECT surface, execution_profile_id, benchmark_revision_id,
      analysis_revision, comparison_key, search_policy,
      MAX(created_at) AS last_at, COUNT(*) AS stored_targets
    FROM responses WHERE lane = 'tracking' AND surface IS NOT NULL
    GROUP BY surface, execution_profile_id, benchmark_revision_id,
      analysis_revision, comparison_key, search_policy
    ORDER BY last_at DESC LIMIT ?`, [MAX_SERIES + 1]);
  if (identities.length > MAX_SERIES) {
    throw new WeeklyReviewError('Too many stored series identities to resolve the review');
  }
  return identities.map((row) => ({ id: stableIdentity([
    row.surface, row.execution_profile_id, row.benchmark_revision_id,
    row.analysis_revision, row.comparison_key, row.search_policy,
  ]), surface: String(row.surface),
  executionProfileId: row.execution_profile_id === null ? null : String(row.execution_profile_id),
  benchmarkRevisionId: row.benchmark_revision_id === null ? null : String(row.benchmark_revision_id),
  analysisRevision: row.analysis_revision === null ? null : String(row.analysis_revision),
  comparisonKey: row.comparison_key === null ? null : String(row.comparison_key),
  searchPolicy: row.search_policy === null ? null : String(row.search_policy),
  lastAt: String(row.last_at), storedTargets: Number(row.stored_targets) }));
}

/** @param {Db} db @param {string} seriesId @param {string} start @param {string} end */
function selectedSeries(db, seriesId, start, end) {
  const identity = listKnownWeeklySeries(db).find((row) => row.id === seriesId);
  if (!identity) throw new WeeklyReviewError('Selected measurement series was not found', 404, 'series_not_found');
  const observed = listMeasurementSeries(db, { start, end, now: end }).find((series) => series.id === seriesId);
  if (observed) return observed;
  return { id: seriesId, surface: identity.surface,
    executionProfileId: identity.executionProfileId,
    benchmarkRevisionId: identity.benchmarkRevisionId,
    analysisRevision: identity.analysisRevision,
    comparisonKey: identity.comparisonKey,
    searchPolicy: identity.searchPolicy,
    start, end, attemptedTargets: 0, completeAnswers: 0, comparableAnswers: 0,
    verifiedSearchAnswers: 0, queryMetadataAnswers: 0, lastAt: '' };
}

/** @param {Db} db @param {string} seriesId @param {string} now */
function priorityOpportunities(db, seriesId, now) {
  return all(db, `SELECT id, intent_id, observed_finding, hypothesis, suggested_action,
      priority, effort_band, owner, review_date, status, evidence_json, updated_at,
      window_start, window_end
    FROM opportunities WHERE series_id = ? AND created_at <= ? AND priority > 0
      AND status IN ('investigate','planned','in_progress')
    ORDER BY priority DESC, CASE effort_band WHEN 'low' THEN 0 WHEN 'medium' THEN 1
      WHEN 'high' THEN 2 ELSE 3 END, updated_at DESC, id DESC LIMIT 3`, [seriesId, now])
    .map((row) => ({ id: Number(row.id), intentId: Number(row.intent_id),
      observedFinding: String(row.observed_finding), hypothesis: String(row.hypothesis),
      suggestedAction: String(row.suggested_action), priority: Number(row.priority),
      effortBand: String(row.effort_band), owner: row.owner === null ? null : String(row.owner),
      reviewDate: row.review_date === null ? null : String(row.review_date),
      status: String(row.status), evidence: JSON.parse(String(row.evidence_json)),
      windowStart: String(row.window_start), windowEnd: String(row.window_end),
      updatedAt: String(row.updated_at) }));
}

/** @param {Db} db @param {string} seriesId @param {string} now */
function dueReviews(db, seriesId, now) {
  return all(db, `SELECT o.id, o.intent_id, o.change_description, o.shipped_at,
      o.review_date, o.priority, o.window_start, o.window_end,
      p.id AS plan_id, p.review_end
    FROM opportunities o
    LEFT JOIN follow_up_plans p ON p.id = (
      SELECT id FROM follow_up_plans WHERE opportunity_id = o.id ORDER BY version DESC LIMIT 1)
    WHERE o.series_id = ? AND o.status = 'shipped' AND o.shipped_at <= ?
      AND COALESCE(p.review_end, o.review_date || 'T00:00:00Z') <= ?
      AND NOT EXISTS (SELECT 1 FROM intervention_reviews r
        WHERE r.opportunity_id = o.id AND r.plan_id IS p.id)
    ORDER BY o.priority DESC, COALESCE(p.review_end, o.review_date) ASC, o.id DESC LIMIT 20`, [seriesId, now, now])
    .map((row) => ({ id: Number(row.id), intentId: Number(row.intent_id),
      changeDescription: row.change_description === null ? null : String(row.change_description),
      shippedAt: row.shipped_at === null ? null : String(row.shipped_at),
      reviewDate: row.review_date === null ? null : String(row.review_date),
      reviewWindowEnd: row.review_end === null ? null : String(row.review_end),
      windowStart: String(row.window_start), windowEnd: String(row.window_end),
      planId: row.plan_id === null ? null : Number(row.plan_id), priority: Number(row.priority) }));
}

/** @param {Db} db @param {string} seriesId @param {string} start @param {string} end */
function savedChanges(db, seriesId, start, end) {
  return all(db, `SELECT r.id, r.opportunity_id, r.plan_id, r.snapshot_id,
      r.selection_mode, r.report_json, r.judgment, r.rationale, r.created_at
    FROM intervention_reviews r JOIN opportunities o ON o.id = r.opportunity_id
    WHERE o.series_id = ? AND r.created_at >= ? AND r.created_at < ?
    ORDER BY r.created_at DESC, r.id DESC LIMIT 20`, [seriesId, start, end])
    .map((row) => {
      const report = JSON.parse(String(row.report_json));
      return { id: Number(row.id), opportunityId: Number(row.opportunity_id),
        planId: Number(row.plan_id), snapshotId: Number(row.snapshot_id),
        selectionMode: String(row.selection_mode), status: String(report.status),
        metric: report.metric, scope: report.scope,
        judgment: String(row.judgment), rationale: String(row.rationale),
        createdAt: String(row.created_at) };
    });
}

/** @param {ReturnType<typeof intentEvidenceReport>} report @param {number|null} brandId */
function importantEvidence(report, brandId) {
  if (!report) return [];
  return report.answers.map((answer) => {
    const brandStances = brandId === null ? [] : answer.mentions
      .filter((mention) => mention.entityId === brandId).map((mention) => mention.effectiveStance);
    const negative = brandStances.includes('negative') || brandStances.includes('uncertain');
    const sourceGap = answer.sourceObservations.length > 0 && answer.answerCitations.length === 0;
    return { responseId: answer.id, intentId: answer.question.intentId,
      question: answer.question.text, observedAt: answer.createdAt,
      answerExcerpt: answer.text.slice(0, 300), brandStances,
      queryIds: answer.searchQueries.map((item) => item.id),
      sourceIds: answer.sourceObservations.map((item) => item.id),
      citationIds: answer.answerCitations.map((item) => item.id),
      reason: negative ? 'Negative or uncertain brand statement'
        : sourceGap ? 'Source observed without a final-answer citation' : 'Recent comparable answer',
      rank: negative ? 0 : sourceGap ? 1 : 2 };
  }).sort((a, b) => a.rank - b.rank || b.observedAt.localeCompare(a.observedAt)
    || b.responseId - a.responseId).slice(0, 3).map(({ rank, ...item }) => item);
}

/**
 * Assemble a read-only weekly review of one exact historical measurement identity.
 * The report never starts a provider run, changes a schedule, or attributes outcomes.
 * @param {Db} db
 * @param {{seriesId:string,start:string,end:string,now:string}} selection
 */
export function buildWeeklyReview(db, selection) {
  const start = utc(selection.start, 'start');
  const end = utc(selection.end, 'end');
  const now = utc(selection.now, 'now');
  if (Date.parse(end) - Date.parse(start) !== WEEK_MS) {
    throw new WeeklyReviewError('Weekly review needs exactly seven days');
  }
  if (end > now) throw new WeeklyReviewError('Review window cannot end in the future');
  const seriesId = String(selection.seriesId ?? '').trim();
  if (!seriesId) throw new WeeklyReviewError('An explicit measurement series is required');
  const series = selectedSeries(db, seriesId, start, end);
  const brand = get(db, 'SELECT id, name FROM entities WHERE is_self = 1 AND archived_at IS NULL ORDER BY id LIMIT 1');
  const brandId = brand ? Number(brand.id) : null;
  const evidence = intentEvidenceReport(db, { series });
  const options = { series, start, end, now };
  const health = [];
  if (series.attemptedTargets === 0) health.push('No tracking targets were attempted in this week');
  if (series.attemptedTargets > series.comparableAnswers) {
    health.push(`${series.comparableAnswers}/${series.attemptedTargets} targets produced comparable answers`);
  }
  if (series.comparableAnswers > series.queryMetadataAnswers) {
    health.push(`Query metadata was available for ${series.queryMetadataAnswers}/${series.comparableAnswers} comparable answers`);
  }
  let recommendation = null;
  if (brandId !== null) {
    try {
      recommendation = series.analysisRevision && series.analysisRevision !== 'legacy-heuristic-v1'
        ? stanceRecommendationRate(db, { ...options, entityId: brandId,
          analysisRevision: series.analysisRevision })
        : recommendationRate(db, { ...options, entityId: brandId });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      health.push(`Recommendation rate unavailable: ${error.message}`);
    }
  }
  const spend = actualSpend(db, options);
  if (spend.attemptedCalls > 0 && spend.costStatus === 'partial') {
    health.push('Computed API spend is a known subtotal with unknown components');
  }
  if (spend.attemptedCalls > 0 && spend.costStatus === 'unavailable') {
    health.push('Computed API spend is unavailable for attempted API calls');
  }
  const opportunities = priorityOpportunities(db, seriesId, now);
  const due = dueReviews(db, seriesId, now);
  const changes = savedChanges(db, seriesId, start, end);
  const outcomes = listOutcomeRecords(db, { start, end });
  const ledger = listLedgerEntries(db, { start, end });
  const evidenceHighlights = importantEvidence(evidence, brandId);
  const actionState = opportunities.length || due.length || health.length
    || evidenceHighlights.some((item) => item.reason !== 'Recent comparable answer')
    ? 'review_items' : 'nothing_requires_action';
  return { scope: { series, start, end, generatedAt: now, days: 7 },
    coverage: { attemptedTargets: series.attemptedTargets, completeAnswers: series.completeAnswers,
      comparableAnswers: series.comparableAnswers,
      verifiedSearchAnswers: series.verifiedSearchAnswers,
      queryMetadataAnswers: series.queryMetadataAnswers,
      mentionRate: brandId === null ? null : mentionRate(db, { ...options, entityId: brandId }),
      recommendationRate: recommendation,
      evidence: evidence?.coverage ?? null },
    health, importantEvidence: evidenceHighlights,
    opportunities, dueReviews: due, descriptiveChanges: changes,
    reportedOutcomes: outcomes, reportedLedger: ledger,
    measurementSpend: spend, subscriptionAllowance: 'Subscription usage is not assigned a dollar cost unless a billed amount is entered in the ledger',
    outcomesStatus: outcomes.length ? 'reported' : 'not_recorded',
    ledgerStatus: ledger.length ? 'reported' : 'not_recorded',
    reportedDataScope: 'Outcome and ledger records overlap this week across the local workspace; they are not automatically attributable to the selected measurement series or an intervention',
    actionState, interpretation: INTERPRETATION };
}

/** @param {unknown} value */
function markdownText(value) {
  return String(value ?? '').replaceAll(/\r\n|[\r\n]/g, ' ')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll(/([\\`*_{}\[\]()#+.!|])/g, '\\$1');
}

/** @param {ReturnType<typeof buildWeeklyReview>} report */
export function renderWeeklyMarkdown(report) {
  const lines = [
    '# Hearsay weekly review', '',
    `Series: ${report.scope.series.id} (${report.scope.series.surface})`,
    `Week: ${report.scope.start} to ${report.scope.end} UTC, end exclusive`,
    `Generated: ${report.scope.generatedAt}`, '',
    '## Collection health', '',
    `${report.coverage.comparableAnswers}/${report.coverage.attemptedTargets} attempted targets produced comparable answers.`,
    ...report.health.map((message) => `- ${message}`), '',
    '## Important evidence', '',
    ...(report.importantEvidence.length ? report.importantEvidence.map((item) =>
      `- Answer #${item.responseId}: ${markdownText(item.reason)}; query IDs ${item.queryIds.join(', ') || 'none'}, source IDs ${item.sourceIds.join(', ') || 'none'}, citation IDs ${item.citationIds.join(', ') || 'none'}.`)
      : ['No comparable answer evidence in this week.']), '',
    '## Priorities and follow-up', '',
    ...(report.opportunities.length ? report.opportunities.map((item) =>
      `- Opportunity #${item.id} (priority ${item.priority}): ${markdownText(item.suggestedAction)}`)
      : ['No prioritized opportunities.']),
    ...(report.dueReviews.length ? report.dueReviews.map((item) =>
      `- Opportunity #${item.id} is due for review.`) : []),
    ...(report.actionState === 'nothing_requires_action' ? ['Nothing requires action.'] : []), '',
    '## Saved descriptive changes', '',
    ...(report.descriptiveChanges.length ? report.descriptiveChanges.map((item) =>
      `- Opportunity #${item.opportunityId}: ${item.status}; user judgment ${item.judgment}.`)
      : ['No intervention review saved in this week.']), '',
    '## Reported outcomes and costs', '',
    `${report.reportedDataScope}.`,
    ...(report.reportedOutcomes.length ? report.reportedOutcomes.map((item) =>
      `- ${markdownText(item.metricName)}: ${item.value} ${markdownText(item.unit)}${item.currency ? ` ${item.currency}` : ''}; ${markdownText(item.source)}; ${item.periodStart} to ${item.periodEnd}; attribution ${markdownText(item.attributionMethod)}${item.overlapIds?.length ? `; overlaps record IDs ${item.overlapIds.join(', ')}` : ''}.`)
      : ['Business outcomes not recorded.']),
    report.measurementSpend.attemptedCalls
      ? `- Computed API spend: ${report.measurementSpend.costStatus}; known subtotal ${report.measurementSpend.knownSubtotalUsd ?? 'unknown'} USD; ${report.measurementSpend.unknownCalls} attempted calls have unknown cost.`
      : '- No API calls or dollar spend recorded for this selected series and week.',
    ...(report.reportedLedger.length ? report.reportedLedger.map((item) =>
      `- User-reported ${item.kind}: ${item.kind === 'time' ? `${item.minutes} minutes` : `${item.amount ?? 'unknown'} ${item.currency ?? ''}`}; ${markdownText(item.source)}.`)
      : ['User expenses and time not recorded.']),
    `- ${report.subscriptionAllowance}`, '', report.interpretation, '',
  ];
  return lines.join('\n');
}
