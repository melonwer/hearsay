import { all, get, isoNow, run, transaction } from './db.js';
import { intentEvidenceReport } from './evidence-report.js';
import { advanceOpportunityVersion, checkOpportunityVersion, getOpportunity,
  OpportunityError, recordOpportunityEvent } from './opportunities.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

const METRICS = ['brand_mention_rate', 'positive_stance_rate', 'answer_citation_rate'];
const DIRECTIONS = ['increase', 'decrease', 'hold'];

/** @param {unknown} value @param {string} name */
function utc(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)
    || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 19) + 'Z' !== text) {
    throw new OpportunityError(`${name} must be a UTC second-precision timestamp`);
  }
  return text;
}

/** @param {unknown} value @param {string} name */
function ids(value, name) {
  if (!Array.isArray(value) || value.length > 100) throw new OpportunityError(`${name} must be an array of at most 100 IDs`);
  const result = [...new Set(value.map((id) => Number(id)))].sort((a, b) => a - b);
  if (result.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new OpportunityError(`${name} must contain positive integer IDs`);
  }
  return result;
}

/** @param {Db} db @param {string|null} revisionId */
function brandId(db, revisionId) {
  if (revisionId) {
    const row = get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [revisionId]);
    if (row) {
      const snapshot = JSON.parse(String(row.snapshot_json));
      const brand = snapshot.entities?.find((/** @type {{role?:string,id?:number}} */ entity) => entity.role === 'brand');
      if (brand?.id) return Number(brand.id);
    }
  }
  const row = get(db, 'SELECT id FROM entities WHERE is_self = 1 LIMIT 1');
  return row ? Number(row.id) : null;
}

/** @param {Db} db @param {string|null} revisionId @param {number[]} intentIds */
function promptPanel(db, revisionId, intentIds) {
  if (revisionId) {
    const row = get(db, 'SELECT snapshot_json FROM benchmark_revisions WHERE id = ?', [revisionId]);
    if (!row) throw new OpportunityError('Saved benchmark revision is unavailable');
    const snapshot = JSON.parse(String(row.snapshot_json));
    if (!Array.isArray(snapshot.questions)) throw new OpportunityError('Saved benchmark has no question panel');
    return { source: 'benchmark_revision', weighting: snapshot.weighting ?? 'equal',
      questions: snapshot.questions.filter((/** @type {{intentId?:number}} */ question) => intentIds.includes(Number(question.intentId)))
        .map((/** @type {{id:number,intentId:number,text:string,category?:string}} */ question) => ({
          promptId: Number(question.id), intentId: Number(question.intentId),
          text: String(question.text), category: String(question.category ?? 'general'),
        })).sort((/** @type {{promptId:number}} */ a, /** @type {{promptId:number}} */ b) => a.promptId - b.promptId) };
  }
  return { source: 'legacy_current_panel', weighting: 'equal',
    questions: all(db, `SELECT id AS prompt_id, intent_id, text, category FROM prompts
      WHERE intent_id IN (${intentIds.map(() => '?').join(',')}) ORDER BY id`, intentIds)
      .map((row) => ({ promptId: Number(row.prompt_id), intentId: Number(row.intent_id),
        text: String(row.text), category: String(row.category) })) };
}

/** @param {Db} db @param {string|null} profileId */
function profileSnapshot(db, profileId) {
  if (!profileId) return null;
  const row = get(db, 'SELECT snapshot_json FROM execution_profiles WHERE id = ?', [profileId]);
  return row ? JSON.parse(String(row.snapshot_json)) : null;
}

/** @param {Db} db @param {import('./metrics.js').MeasurementSeries} series @param {number[]} promptIds @param {string} capturedAt */
function targetsSnapshot(db, series, promptIds, capturedAt) {
  if (!promptIds.length) return [];
  const result = [];
  for (let offset = 0; offset < promptIds.length; offset += 500) {
    const chunk = promptIds.slice(offset, offset + 500);
    result.push(...all(db, `SELECT r.id, r.prompt_id, r.provider, r.model, r.target_status,
        r.comparability_status, r.answer_status, r.web_status, r.query_metadata_status,
        r.safe_error_code, x.status AS run_status
      FROM responses r JOIN runs x ON x.id = r.run_id
      WHERE r.lane = 'tracking' AND r.created_at >= ? AND r.created_at < ?
        AND r.created_at <= ? AND r.surface IS ? AND r.execution_profile_id IS ?
        AND r.benchmark_revision_id IS ? AND r.analysis_revision IS ?
        AND r.comparison_key IS ? AND r.search_policy IS ?
        AND r.prompt_id IN (${chunk.map(() => '?').join(',')}) ORDER BY r.id`, [
      series.start, series.end, capturedAt, series.surface, series.executionProfileId,
      series.benchmarkRevisionId, series.analysisRevision, series.comparisonKey,
      series.searchPolicy, ...chunk,
    ]).map((row) => ({ responseId: Number(row.id), promptId: Number(row.prompt_id),
      provider: String(row.provider), model: String(row.model),
      targetStatus: row.target_status === null ? null : String(row.target_status),
      comparabilityStatus: row.comparability_status === null ? null : String(row.comparability_status),
      answerStatus: row.answer_status === null ? null : String(row.answer_status),
      webStatus: row.web_status === null ? null : String(row.web_status),
      queryMetadataStatus: row.query_metadata_status === null ? null : String(row.query_metadata_status),
      safeErrorCode: row.safe_error_code === null ? null : String(row.safe_error_code),
      runStatus: String(row.run_status) })));
  }
  if (result.length > 20000) throw new OpportunityError('Snapshot exceeds 20000 targets; narrow the window');
  return result.sort((a, b) => a.responseId - b.responseId);
}

/** @param {Db} db @param {import('./metrics.js').MeasurementSeries} series @param {number[]} intentIds @param {string} capturedAt */
function measurementSnapshot(db, series, intentIds, capturedAt) {
  const panel = promptPanel(db, series.benchmarkRevisionId, intentIds);
  if (panel.weighting !== 'equal' || panel.questions.length === 0) {
    throw new OpportunityError('Saved benchmark needs an equal-weight prompt panel');
  }
  return { series, windowStart: series.start, windowEnd: series.end,
    capturedAt, dataCutoff: capturedAt,
    correctionCutoff: Number(get(db, 'SELECT COALESCE(MAX(id),0) AS id FROM mention_corrections')?.id ?? 0),
    promptPanel: panel, executionProfileSnapshot: profileSnapshot(db, series.executionProfileId),
    targets: targetsSnapshot(db, series, panel.questions.map((/** @type {{promptId:number}} */ question) => question.promptId), capturedAt),
    answers: answersSnapshot(db, series, intentIds, capturedAt) };
}

/** @param {Db} db @param {import('./metrics.js').MeasurementSeries} series @param {number[]} intentIds @param {string} capturedAt */
function answersSnapshot(db, series, intentIds, capturedAt) {
  const report = intentEvidenceReport(db, { series });
  const completed = new Set(all(db, `SELECT r.id FROM responses r JOIN runs x ON x.id = r.run_id
    WHERE x.status = 'done' AND r.created_at >= ? AND r.created_at < ? AND r.created_at <= ?`, [
    series.start, series.end, capturedAt,
  ]).map((row) => Number(row.id)));
  const selected = (report?.answers ?? []).filter((answer) => completed.has(answer.id)
    && answer.question.intentId !== null && intentIds.includes(answer.question.intentId));
  if (selected.length > 10000) throw new OpportunityError('Snapshot exceeds 10000 comparable answers; narrow the window');
  const entityId = brandId(db, series.benchmarkRevisionId);
  return selected.map((answer) => ({
    responseId: answer.id, promptId: answer.question.promptId, intentId: answer.question.intentId,
    questionText: answer.question.text, createdAt: answer.createdAt,
    provider: answer.provider, model: answer.model, executionProfileId: answer.executionProfileId,
    benchmarkRevisionId: answer.benchmarkRevisionId, analysisRevision: answer.analysisRevision,
    brandEntityId: entityId,
    brandMentioned: entityId !== null && answer.mentions.some((mention) => mention.entityId === entityId),
    positiveStance: entityId !== null && answer.mentions.some((mention) => mention.entityId === entityId
      && mention.effectiveStance === 'positive'),
    stanceReviews: answer.mentions.filter((mention) => mention.entityId === entityId).map((mention) => ({
      mentionId: mention.mentionId, interpretationId: mention.interpretationId,
      correctionId: mention.correctionId, effectiveStance: mention.effectiveStance,
    })),
    queryMetadataStatus: answer.queryMetadataStatus,
    queries: answer.searchQueries.map((query) => ({ id: query.id, normalizedKey: query.normalizedKey })),
    sources: answer.sourceObservations.map((source) => ({ id: source.id, url: source.url,
      provenance: source.provenance })),
    citations: answer.answerCitations.map((citation) => ({ id: citation.id, url: citation.url,
      provenance: citation.provenance })),
  }));
}

/** @param {Db} db @param {string} surface @param {string} start @param {string} end @param {string} cutoff */
function observedSeriesChanges(db, surface, start, end, cutoff) {
  return all(db, `SELECT surface, execution_profile_id, benchmark_revision_id, analysis_revision,
      comparison_key, search_policy, model, COUNT(*) AS count
    FROM responses WHERE lane = 'tracking' AND surface = ?
      AND created_at >= ? AND created_at < ? AND created_at <= ?
    GROUP BY surface, execution_profile_id, benchmark_revision_id, analysis_revision,
      comparison_key, search_policy, model
    ORDER BY surface, execution_profile_id, benchmark_revision_id, model`, [
    surface, start, end, cutoff,
  ]).map((row) => ({
    surface: String(row.surface), executionProfileId: row.execution_profile_id === null ? null : String(row.execution_profile_id),
    benchmarkRevisionId: row.benchmark_revision_id === null ? null : String(row.benchmark_revision_id),
    analysisRevision: row.analysis_revision === null ? null : String(row.analysis_revision),
    comparisonKey: row.comparison_key === null ? null : String(row.comparison_key),
    searchPolicy: row.search_policy === null ? null : String(row.search_policy),
    model: String(row.model), count: Number(row.count),
  }));
}

/** @param {Db} db @param {{id:number,expectedVersion:number,baselineStart:string,baselineEnd:string,
 * intentIds:number[],comparisonIntentIds:number[],primaryMetric:string,expectedDirection:string,
 * reviewStart:string,reviewEnd:string,observationDelayDays:number,author:string,now?:Date|string}} input */
export function saveFollowUpPlan(db, input) {
  const current = getOpportunity(db, input.id);
  if (!current) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  checkOpportunityVersion(current, input.expectedVersion);
  if (['pending', 'dismissed', 'no_action', 'combined'].includes(current.status)) {
    throw new OpportunityError('Accept the opportunity before planning a follow-up');
  }
  const author = String(input.author ?? '').trim();
  if (!author || author.length > 120) throw new OpportunityError('author is required');
  const at = isoNow(new Date(input.now ?? Date.now()));
  const baselineStart = utc(input.baselineStart, 'baselineStart');
  const baselineEnd = utc(input.baselineEnd, 'baselineEnd');
  const reviewStart = utc(input.reviewStart, 'reviewStart');
  const reviewEnd = utc(input.reviewEnd, 'reviewEnd');
  if (baselineStart >= baselineEnd || reviewStart >= reviewEnd || baselineEnd > reviewStart) {
    throw new OpportunityError('Baseline and review windows must be ordered, half-open, and nonoverlapping');
  }
  if (baselineStart < current.windowStart || baselineEnd > current.windowEnd) {
    throw new OpportunityError('Baseline must stay inside the saved opportunity selection');
  }
  const intentIds = ids(input.intentIds, 'intentIds');
  const comparisonIntentIds = ids(input.comparisonIntentIds, 'comparisonIntentIds');
  if (!intentIds.includes(current.intentId) || comparisonIntentIds.some((id) => intentIds.includes(id))) {
    throw new OpportunityError('Primary intents must include the opportunity intent; comparison intents must be separate');
  }
  const allIntents = [...intentIds, ...comparisonIntentIds];
  if (allIntents.length > 100) throw new OpportunityError('Too many selected intents');
  const primaryMetric = String(input.primaryMetric ?? '');
  const expectedDirection = String(input.expectedDirection ?? '');
  if (!METRICS.includes(primaryMetric) || !DIRECTIONS.includes(expectedDirection)) {
    throw new OpportunityError('Invalid primary metric or expected direction');
  }
  const observationDelayDays = Number(input.observationDelayDays);
  if (!Number.isSafeInteger(observationDelayDays) || observationDelayDays < 0 || observationDelayDays > 180) {
    throw new OpportunityError('Observation delay must be 0 to 180 days');
  }
  if (current.shippedAt) {
    const delayed = new Date(Date.parse(current.shippedAt) + observationDelayDays * 86400000)
      .toISOString().slice(0, 19) + 'Z';
    if (reviewStart < delayed) throw new OpportunityError('Review window starts before shipment and observation delay');
  }
  const series = { ...current.series, start: baselineStart, end: baselineEnd };
  const availableIntents = new Set((intentEvidenceReport(db, { series })?.questions ?? [])
    .flatMap((question) => question.intentId === null ? [] : [question.intentId]));
  if (allIntents.some((id) => !availableIntents.has(id))) {
    throw new OpportunityError('Selected intent is outside the saved benchmark');
  }
  const baseline = measurementSnapshot(db, series, allIntents, at);
  const answers = baseline.answers;
  if (!answers.some((answer) => answer.intentId !== null && intentIds.includes(answer.intentId))) {
    throw new OpportunityError('Baseline needs a comparable completed answer for the primary intent');
  }
  const previous = current.followUpPlans.at(-1);
  const retrospective = !!current.shippedAt && at >= current.shippedAt;
  const baselineAfterPublication = !!current.shippedAt && baselineEnd > current.shippedAt;
  const planId = transaction(db, () => {
    advanceOpportunityVersion(db, current, at);
    const created = run(db, `INSERT INTO follow_up_plans(opportunity_id,version,supersedes_id,
      baseline_json,intent_ids_json,comparison_intent_ids_json,primary_metric,expected_direction,
      review_start,review_end,observation_delay_days,retrospective,baseline_after_publication,
      author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      current.id, (previous?.version ?? 0) + 1, previous?.id ?? null,
      JSON.stringify(baseline), JSON.stringify(intentIds), JSON.stringify(comparisonIntentIds),
      primaryMetric, expectedDirection, reviewStart, reviewEnd, observationDelayDays,
      retrospective ? 1 : 0, baselineAfterPublication ? 1 : 0, author, at,
    ]).lastInsertRowid;
    recordOpportunityEvent(db, current.id, 'follow_up_planned', { planId: created,
      supersedesId: previous?.id ?? null, baselineWindow: [baselineStart, baselineEnd],
      reviewWindow: [reviewStart, reviewEnd], answerIds: answers.map((answer) => answer.responseId),
      retrospective, baselineAfterPublication }, author, at);
    return created;
  });
  return getOpportunity(db, current.id)?.followUpPlans.find((plan) => plan.id === planId) ?? null;
}

/** @param {Db} db @param {{id:number,planId:number,expectedVersion:number,author:string,now?:Date|string}} input */
export function captureFollowUpReview(db, input) {
  const current = getOpportunity(db, input.id);
  if (!current) throw new OpportunityError('Opportunity not found', 404, 'not_found');
  checkOpportunityVersion(current, input.expectedVersion);
  if (!['shipped', 'reviewed'].includes(current.status)) {
    throw new OpportunityError('Only a shipped action can capture a follow-up review');
  }
  const plan = current.followUpPlans.at(-1);
  if (!plan || plan.id !== Number(input.planId)) throw new OpportunityError('Select the latest saved follow-up plan');
  const author = String(input.author ?? '').trim();
  if (!author || author.length > 120) throw new OpportunityError('author is required');
  const at = isoNow(new Date(input.now ?? Date.now()));
  if (at < plan.reviewWindow.start) throw new OpportunityError('Review window has not started');
  const series = { ...plan.baseline.series, start: plan.reviewWindow.start,
    end: plan.reviewWindow.end };
  const measurement = measurementSnapshot(db, series, [...plan.intentIds, ...plan.comparisonIntentIds], at);
  const answers = measurement.answers;
  const snapshot = { ...measurement,
    seriesChanges: observedSeriesChanges(db, series.surface, series.start, series.end, at),
    partialWindow: at < series.end };
  const snapshotId = transaction(db, () => {
    advanceOpportunityVersion(db, current, at);
    const created = run(db, `INSERT INTO follow_up_review_snapshots(plan_id,snapshot_json,author,captured_at)
      VALUES(?,?,?,?)`, [plan.id, JSON.stringify(snapshot), author, at]).lastInsertRowid;
    recordOpportunityEvent(db, current.id, 'follow_up_captured', { planId: plan.id,
      snapshotId: created, answerIds: answers.map((answer) => answer.responseId),
      seriesChanges: snapshot.seriesChanges, partialWindow: snapshot.partialWindow }, author, at);
    return created;
  });
  return getOpportunity(db, current.id)?.followUpPlans.at(-1)?.reviewSnapshots.find((item) => item.id === snapshotId) ?? null;
}
