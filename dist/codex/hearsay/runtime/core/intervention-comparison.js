import { all, get, isoNow, run, transaction } from './db.js';
import { wilson } from './metrics.js';
import { advanceOpportunityVersion, checkOpportunityVersion, getOpportunity,
  OpportunityError, recordOpportunityEvent } from './opportunities.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {ReturnType<typeof getOpportunity>} Opportunity */

const MODES = ['full_benchmark', 'common_subset'];
const JUDGMENTS = ['promising', 'not_useful', 'inconclusive'];
const INTERPRETATION = 'This is a descriptive before/after observation. Uncertainty, indexing delay, other actions, and outside changes remain; the change cannot be attributed to this intervention.';

/** @param {unknown} value */
function asArray(value) { return Array.isArray(value) ? value : []; }

/** @param {Record<string, unknown>} series */
function seriesIdentity(series) {
  return [series.id, series.surface, series.executionProfileId, series.benchmarkRevisionId,
    series.analysisRevision, series.comparisonKey, series.searchPolicy];
}

/** @param {Record<string, unknown>} answer @param {string} metric */
function success(answer, metric) {
  if (metric === 'brand_mention_rate') return answer.brandMentioned === true;
  if (metric === 'positive_stance_rate') return answer.positiveStance === true;
  return asArray(answer.citations).length > 0;
}

/** @param {Record<string, unknown>[]} answers @param {number[]} promptIds @param {string} metric */
function metricSide(answers, promptIds, metric) {
  const perPrompt = promptIds.map((promptId) => {
    const rows = answers.filter((answer) => Number(answer.promptId) === promptId);
    const hits = rows.filter((answer) => success(answer, metric)).length;
    return { promptId, n: rows.length, hits, rate: rows.length ? hits / rows.length : null,
      interval: wilson(hits, rows.length) };
  });
  const valid = perPrompt.filter((cell) => cell.n > 0);
  const n = perPrompt.reduce((sum, cell) => sum + cell.n, 0);
  const hits = perPrompt.reduce((sum, cell) => sum + cell.hits, 0);
  return { n, hits, promptCount: promptIds.length, observedPromptCount: valid.length,
    rate: valid.length === promptIds.length && promptIds.length
      ? valid.reduce((sum, cell) => sum + /** @type {number} */ (cell.rate), 0) / promptIds.length : null,
    weighting: 'equal_prompt', perPrompt };
}

/** @param {Record<string, unknown>[]} answers @param {Record<string, unknown>[]} targets @param {boolean} targetsKnown */
function coverage(answers, targets, targetsKnown) {
  const queryAvailable = answers.filter((answer) => answer.queryMetadataStatus === 'available').length;
  const queryUnavailable = answers.filter((answer) => answer.queryMetadataStatus === 'unavailable').length;
  const rate = (/** @type {number} */ n) => answers.length ? n / answers.length : null;
  const sourceCount = answers.filter((answer) => asArray(answer.sources).length > 0).length;
  const citationCount = answers.filter((answer) => asArray(answer.citations).length > 0).length;
  return { attemptedTargets: targets.length, targetCoverageKnown: targetsKnown,
    comparableAnswers: answers.length,
    failedTargets: targets.filter((target) => target.targetStatus === 'failed'
      || target.safeErrorCode != null || target.runStatus === 'failed').length,
    incompleteTargets: targets.filter((target) => target.targetStatus === 'incomplete'
      || target.answerStatus === 'incomplete' || target.answerStatus === 'truncated').length,
    queryMetadataAvailable: queryAvailable, queryMetadataUnavailable: queryUnavailable,
    queryMetadataNotApplicable: answers.length - queryAvailable - queryUnavailable,
    queryMetadataAvailableRate: rate(queryAvailable),
    answersWithObservedQueries: answers.filter((answer) => asArray(answer.queries).length > 0).length,
    answersWithSourceObservations: sourceCount, sourceObservationCoverageRate: rate(sourceCount),
    answersWithAnswerCitations: citationCount, citationCoverageRate: rate(citationCount) };
}

/** @param {Record<string, unknown>[]} answers @param {'queries'|'sources'|'citations'} layer */
function layerIncidence(answers, layer) {
  /** @type {Map<string, {key:string,responseIds:number[],recordIds:number[]}>} */
  const result = new Map();
  for (const answer of answers) {
    for (const record of asArray(answer[layer])) {
      const key = layer === 'queries' ? String(record.normalizedKey)
        : JSON.stringify([record.provenance, record.url]);
      let item = result.get(key);
      if (!item) { item = { key, responseIds: [], recordIds: [] }; result.set(key, item); }
      if (!item.responseIds.includes(Number(answer.responseId))) item.responseIds.push(Number(answer.responseId));
      item.recordIds.push(Number(record.id));
    }
  }
  return result;
}

/** @param {Record<string, unknown>[]} before @param {Record<string, unknown>[]} after @param {'queries'|'sources'|'citations'} layer */
function layerChanges(before, after, layer) {
  const prior = layerIncidence(before, layer);
  const later = layerIncidence(after, layer);
  return [...new Set([...prior.keys(), ...later.keys()])].sort().map((key) => ({
    key, beforeResponses: prior.get(key)?.responseIds.length ?? 0,
    afterResponses: later.get(key)?.responseIds.length ?? 0,
    deltaResponses: (later.get(key)?.responseIds.length ?? 0) - (prior.get(key)?.responseIds.length ?? 0),
    beforeIncidenceRate: before.length ? (prior.get(key)?.responseIds.length ?? 0) / before.length : null,
    afterIncidenceRate: after.length ? (later.get(key)?.responseIds.length ?? 0) / after.length : null,
    beforeResponseIds: prior.get(key)?.responseIds ?? [], afterResponseIds: later.get(key)?.responseIds ?? [],
    beforeRecordIds: prior.get(key)?.recordIds ?? [], afterRecordIds: later.get(key)?.recordIds ?? [],
  }));
}

/** @param {Db} db @param {number} opportunityId @param {number[]} intentIds @param {string} start @param {string} end */
function overlappingActions(db, opportunityId, intentIds, start, end) {
  if (!intentIds.length) return [];
  return all(db, `SELECT id, intent_id, shipped_at, change_description, target_url, product_area
    FROM opportunities WHERE id <> ? AND status IN ('shipped','reviewed')
      AND shipped_at >= ? AND shipped_at < ?
      AND intent_id IN (${intentIds.map(() => '?').join(',')}) ORDER BY shipped_at, id`, [
    opportunityId, start, end, ...intentIds,
  ]).map((row) => ({ opportunityId: Number(row.id), intentId: Number(row.intent_id),
    shippedAt: String(row.shipped_at), changeDescription: String(row.change_description ?? ''),
    target: String(row.target_url ?? row.product_area ?? '') }));
}

/** @param {Record<string, unknown>} snapshot @param {number[]} promptIds */
function scopedAnswers(snapshot, promptIds) {
  return asArray(snapshot.answers).filter((answer) => promptIds.includes(Number(answer.promptId)));
}

/** @param {Db} db @param {Record<string, unknown>} baseline @param {number[]} intentIds */
function savedPromptPanel(db, baseline, intentIds) {
  if (baseline.promptPanel) return baseline.promptPanel;
  const series = /** @type {Record<string, unknown>} */ (baseline.series ?? {});
  const revisionId = series.benchmarkRevisionId;
  if (!revisionId) return null;
  const row = get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [String(revisionId)]);
  if (!row) return null;
  const revision = JSON.parse(String(row.snapshot_json));
  return { source: 'benchmark_revision_compatibility', weighting: revision.weighting ?? 'equal',
    questions: asArray(revision.questions).filter((question) => intentIds.includes(Number(question.intentId)))
      .map((question) => ({ promptId: Number(question.id), intentId: Number(question.intentId),
        text: String(question.text), category: String(question.category ?? 'general') })) };
}

/**
 * Compare only frozen baseline and review data. The full saved prompt panel is the
 * default; a common subset is a separate explicit selection with dropped cells.
 * @param {Db} db
 * @param {{opportunityId:number,planId:number,snapshotId:number,mode?:string}} input
 */
export function compareIntervention(db, input) {
  const item = getOpportunity(db, input.opportunityId);
  if (!item) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  const plan = item.followUpPlans.find((candidate) => candidate.id === Number(input.planId));
  const review = plan?.reviewSnapshots.find((candidate) => candidate.id === Number(input.snapshotId));
  if (!plan || !review) throw new OpportunityError('Saved plan or review snapshot not found', 404, 'not_found');
  const mode = input.mode ?? 'full_benchmark';
  if (!MODES.includes(mode)) throw new OpportunityError('Invalid comparison selection mode');
  const baseline = plan.baseline;
  const mainIntents = plan.intentIds;
  const comparisonIntents = plan.comparisonIntentIds;
  const selectedIntents = [...mainIntents, ...comparisonIntents];
  const panel = /** @type {{weighting?:string,source?:string,questions?:Record<string,unknown>[]} | null} */ (
    savedPromptPanel(db, baseline, selectedIntents));
  const panelQuestions = asArray(panel?.questions).filter((question) => selectedIntents.includes(Number(question.intentId)));
  const expectedPromptIds = [...new Set(panelQuestions.map((question) => Number(question.promptId)))].sort((a, b) => a - b);
  const baselineAnswers = asArray(baseline.answers);
  const reviewAnswers = asArray(review.answers);
  const baselinePromptIds = new Set(baselineAnswers.map((answer) => Number(answer.promptId)));
  const reviewPromptIds = new Set(reviewAnswers.map((answer) => Number(answer.promptId)));
  const selectedPromptIds = mode === 'common_subset'
    ? expectedPromptIds.filter((id) => baselinePromptIds.has(id) && reviewPromptIds.has(id))
    : expectedPromptIds;
  const droppedCells = expectedPromptIds.filter((id) => !selectedPromptIds.includes(id))
    .map((promptId) => ({ promptId,
      baselineHasAnswer: baselinePromptIds.has(promptId), reviewHasAnswer: reviewPromptIds.has(promptId) }));
  const primaryPromptIds = selectedPromptIds.filter((id) => panelQuestions.some((question) =>
    Number(question.promptId) === id && mainIntents.includes(Number(question.intentId))));
  const comparisonPromptIds = selectedPromptIds.filter((id) => panelQuestions.some((question) =>
    Number(question.promptId) === id && comparisonIntents.includes(Number(question.intentId))));
  const beforeAnswers = scopedAnswers(baseline, selectedPromptIds);
  const afterAnswers = scopedAnswers(review, selectedPromptIds);
  const before = metricSide(beforeAnswers, primaryPromptIds, plan.primaryMetric);
  const after = metricSide(afterAnswers, primaryPromptIds, plan.primaryMetric);
  const comparison = comparisonIntents.length ? {
    before: metricSide(beforeAnswers, comparisonPromptIds, plan.primaryMetric),
    after: metricSide(afterAnswers, comparisonPromptIds, plan.primaryMetric),
  } : null;
  const reasons = [];
  const warnings = [];
  const baselineSeries = baseline.series;
  const reviewSeries = review.series;
  if (!panel || panel.weighting !== 'equal' || !expectedPromptIds.length) {
    reasons.push('The saved baseline lacks a complete equal-weight prompt panel');
  }
  if (baseline.promptPanel && review.promptPanel
    && JSON.stringify(baseline.promptPanel) !== JSON.stringify(review.promptPanel)) {
    reasons.push('The saved prompt panel changed between baseline and review');
  }
  if (!baseline.promptPanel || !review.promptPanel) {
    warnings.push('One older snapshot lacks a frozen prompt panel; prompt wording changes cannot be verified');
  }
  if (panel?.source === 'benchmark_revision_compatibility') {
    warnings.push('This older baseline uses its saved benchmark revision for the prompt panel; target coverage was not frozen');
  }
  if (JSON.stringify(seriesIdentity(baselineSeries)) !== JSON.stringify(seriesIdentity(reviewSeries))) {
    reasons.push('Execution profile, benchmark, analysis revision, search policy, or series scope changed');
  }
  if (baseline.executionProfileSnapshot && review.executionProfileSnapshot
    && JSON.stringify(baseline.executionProfileSnapshot) !== JSON.stringify(review.executionProfileSnapshot)) {
    reasons.push('Execution profile metadata changed, including a possible model alias change');
  }
  if (!baseline.executionProfileSnapshot || !review.executionProfileSnapshot) {
    warnings.push('Execution profile metadata is unavailable; upstream model alias resolution cannot be verified');
  }
  const beforeModels = [...new Set(beforeAnswers.map((answer) => String(answer.model)))].sort();
  const afterModels = [...new Set(afterAnswers.map((answer) => String(answer.model)))].sort();
  if (beforeModels.length && afterModels.length && JSON.stringify(beforeModels) !== JSON.stringify(afterModels)) {
    reasons.push('Observed model identities differ between the saved windows');
  }
  if (plan.primaryMetric !== 'answer_citation_rate'
    && [...beforeAnswers, ...afterAnswers].some((answer) => answer.brandEntityId === null)) {
    reasons.push('Saved brand identity is unavailable for a selected answer');
  }
  if (plan.primaryMetric === 'positive_stance_rate'
    && (!baselineSeries.analysisRevision || baselineSeries.analysisRevision === 'legacy-heuristic-v1'
      || [...beforeAnswers, ...afterAnswers].some((answer) => answer.brandMentioned
        && !asArray(answer.stanceReviews).some((stance) => stance.effectiveStance !== null)))) {
    reasons.push('Positive stance lacks a comparable reviewed analysis revision');
  }
  const missingCells = selectedPromptIds.filter((id) => !baselinePromptIds.has(id) || !reviewPromptIds.has(id))
    .map((promptId) => ({ promptId, baselineHasAnswer: baselinePromptIds.has(promptId),
      reviewHasAnswer: reviewPromptIds.has(promptId) }));
  if (missingCells.length) warnings.push(`${missingCells.length} selected prompt cells have no comparable answer on one side`);
  if (mode === 'common_subset' && droppedCells.length) {
    warnings.push(`${droppedCells.length} prompt cells were explicitly dropped from the common subset`);
  }
  if (review.partialWindow) warnings.push('The saved review window was still open at its data cutoff');
  if (baseline.correctionCutoff === undefined || review.correctionCutoff === undefined) {
    warnings.push('Global correction cutoff is unavailable in an older snapshot; frozen per-answer decisions remain saved');
  } else if (baseline.correctionCutoff !== review.correctionCutoff) {
    warnings.push('The correction cutoff changed between captures; each saved answer retains its decision IDs');
  }
  const variantTargets = asArray(review.seriesChanges).filter((variant) =>
    variant.executionProfileId !== baselineSeries.executionProfileId
      || variant.benchmarkRevisionId !== baselineSeries.benchmarkRevisionId
      || variant.analysisRevision !== baselineSeries.analysisRevision
      || variant.searchPolicy !== baselineSeries.searchPolicy);
  if (variantTargets.length) warnings.push('Other profile, benchmark, analysis, or search-policy variants occurred in the review window and were excluded');
  const confounders = overlappingActions(db, item.id, selectedIntents,
    baseline.windowStart, review.windowEnd);
  if (confounders.length) warnings.push('Other shipped actions affect a selected intent across these windows');
  if (comparisonIntents.length) warnings.push('Comparison intents are assumed unchanged by the user; Hearsay does not verify that assumption');
  const beforeCoverage = coverage(beforeAnswers, asArray(baseline.targets).filter((target) =>
    selectedPromptIds.includes(Number(target.promptId))), Array.isArray(baseline.targets));
  const afterCoverage = coverage(afterAnswers, asArray(review.targets).filter((target) =>
    selectedPromptIds.includes(Number(target.promptId))), Array.isArray(review.targets));
  if (beforeCoverage.queryMetadataAvailableRate !== afterCoverage.queryMetadataAvailableRate
    || beforeCoverage.sourceObservationCoverageRate !== afterCoverage.sourceObservationCoverageRate
    || beforeCoverage.citationCoverageRate !== afterCoverage.citationCoverageRate) {
    warnings.push('Query, source, or citation metadata coverage changed between captures');
  }
  if (!baseline.targets || !review.targets) warnings.push('Target attempt coverage is unavailable in an older snapshot');
  let status = 'incomparable';
  if (!reasons.length) {
    if (!primaryPromptIds.length || missingCells.length || before.rate === null || after.rate === null
      || comparison && (comparison.before.rate === null || comparison.after.rate === null)
      || review.partialWindow) status = 'insufficient_data';
    else status = after.rate > before.rate ? 'observed_increase'
      : after.rate < before.rate ? 'observed_decrease' : 'observed_no_difference';
  }
  const deltaPercentagePoints = before.rate === null || after.rate === null
    ? null : (after.rate - before.rate) * 100;
  return { opportunityId: item.id, planId: plan.id, snapshotId: review.id,
    selectionMode: mode, status, reasons, warnings, interpretation: INTERPRETATION,
    scope: { seriesId: String(baselineSeries.id), surface: String(baselineSeries.surface),
      executionProfileId: baselineSeries.executionProfileId,
      benchmarkRevisionId: baselineSeries.benchmarkRevisionId,
      analysisRevision: baselineSeries.analysisRevision,
      searchPolicy: baselineSeries.searchPolicy,
      baseline: { start: baseline.windowStart, end: baseline.windowEnd,
        dataCutoff: baseline.dataCutoff, correctionCutoff: baseline.correctionCutoff ?? null },
      review: { start: review.windowStart, end: review.windowEnd,
        dataCutoff: review.dataCutoff, correctionCutoff: review.correctionCutoff ?? null,
        partialWindow: review.partialWindow },
      intentIds: mainIntents, comparisonIntentIds: comparisonIntents,
      expectedPromptIds, selectedPromptIds, droppedCells, missingCells,
      profileVariants: variantTargets },
    metric: { id: plan.primaryMetric, expectedDirection: plan.expectedDirection,
      before, after, deltaPercentagePoints,
      intervalMeaning: 'Per-prompt Wilson intervals describe each cell separately; they are not an effect test' },
    comparison, coverage: { before: beforeCoverage, after: afterCoverage },
    changes: { queries: layerChanges(beforeAnswers, afterAnswers, 'queries'),
      sources: layerChanges(beforeAnswers, afterAnswers, 'sources'),
      citations: layerChanges(beforeAnswers, afterAnswers, 'citations') },
    confounders };
}

/** @param {Db} db @param {{opportunityId:number,planId:number,snapshotId:number,mode?:string,
 * expectedVersion:number,judgment:string,rationale:string,author:string,now?:Date|string}} input */
export function saveInterventionReview(db, input) {
  const item = getOpportunity(db, input.opportunityId);
  if (!item) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  checkOpportunityVersion(item, input.expectedVersion);
  if (!['shipped', 'reviewed'].includes(item.status)) {
    throw new OpportunityError('Only a shipped action can be reviewed');
  }
  if (item.followUpPlans.at(-1)?.id !== Number(input.planId)) {
    throw new OpportunityError('Review the latest follow-up plan');
  }
  if (!JUDGMENTS.includes(input.judgment)) throw new OpportunityError('Invalid user review judgment');
  const rationale = String(input.rationale ?? '').trim();
  const author = String(input.author ?? '').trim();
  if (!rationale || rationale.length > 4000) throw new OpportunityError('A review rationale is required');
  if (!author || author.length > 120) throw new OpportunityError('author is required');
  const report = compareIntervention(db, input);
  const at = isoNow(new Date(input.now ?? Date.now()));
  const reviewId = transaction(db, () => {
    advanceOpportunityVersion(db, item, at);
    const created = run(db, `INSERT INTO intervention_reviews(opportunity_id,plan_id,snapshot_id,
      selection_mode,report_json,judgment,rationale,author,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, [
      item.id, report.planId, report.snapshotId, report.selectionMode,
      JSON.stringify(report), input.judgment, rationale, author, at,
    ]).lastInsertRowid;
    run(db, "UPDATE opportunities SET status = 'reviewed' WHERE id = ?", [item.id]);
    recordOpportunityEvent(db, item.id, 'intervention_reviewed', { reviewId: created,
      planId: report.planId, snapshotId: report.snapshotId, selectionMode: report.selectionMode,
      result: report.status, judgment: input.judgment, rationale }, author, at);
    return created;
  });
  return getOpportunity(db, item.id)?.interventionReviews.find((review) => review.id === reviewId) ?? null;
}
