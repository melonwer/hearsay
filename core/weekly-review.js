import { all, get } from './db.js';
import { intentEvidenceReport } from './evidence-report.js';
import { actualSpend, listMeasurementSeries, mentionRate, recommendationRate,
  stanceRecommendationRate } from './metrics.js';
import { stableIdentity } from './measurement-contract.js';
import { CONTROL_PAGE_NOTE, listLedgerEntries, listOutcomeRecords,
  summarizeWeeklyControlledOutcomes } from './outcomes.js';
import { sampleEligibility, summarizeEvidence } from './research-contract.js';
import { summarizeResearchCitationGaps } from './research-report.js';
import { deriveStudyReport } from './study-report.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/**
 * @typedef {Object} WeeklyEvidenceItem
 * @property {number} responseId
 * @property {string} [sampleId]
 * @property {number} [researchId]
 * @property {number|null} intentId
 * @property {string} question
 * @property {string} observedAt
 * @property {string} answerExcerpt
 * @property {(string|null)[]} brandStances
 * @property {(number|string)[]} queryIds
 * @property {(number|string)[]} sourceIds
 * @property {(number|string)[]} citationIds
 * @property {'native'|'external'} [provenance]
 * @property {boolean} [eligible]
 * @property {string} reason
 */
/**
 * @typedef {Object} WeeklyOpportunityItem
 * @property {number} id
 * @property {string} [actionId]
 * @property {number} [researchId]
 * @property {'native'|'external'} [provenance]
 * @property {number} intentId
 * @property {string} observedFinding
 * @property {string} hypothesis
 * @property {string} suggestedAction
 * @property {number} priority
 * @property {string} effortBand
 * @property {string|null} owner
 * @property {string|null} reviewDate
 * @property {string} status
 * @property {Record<string, unknown>} evidence
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {string} updatedAt
 */
/**
 * @typedef {Object} WeeklyCitationGapDomain
 * @property {string} domain
 * @property {number} sampleCount
 * @property {number} finalCitationCount
 * @property {string[]} [sampleIds]
 * @property {string[]} [urls]
 */
/**
 * @typedef {Object} WeeklyCitationGaps
 * @property {number} completedSamples
 * @property {number} brandAbsentSamples
 * @property {WeeklyCitationGapDomain[]} domains
 * @property {'investigate_citation_gap'|'hold_steady'|'awaiting_samples'} decision
 * @property {string} actionHeadline
 * @property {string} nextStepStatus
 */

const WEEK_MS = 7 * 86_400_000;
const MAX_SERIES = 5000;
const INTERPRETATION = 'Visibility changes describe saved observations. Reported outcomes and expenses are user-entered; neither proves that a Hearsay action caused a business result.';
const STANDALONE_SOURCE_LABEL = 'Standalone Research Audit';

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
function listNativeWeeklySeries(db) {
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
  return identities.map((row) => ({
    id: stableIdentity([
      row.surface, row.execution_profile_id, row.benchmark_revision_id,
      row.analysis_revision, row.comparison_key, row.search_policy,
    ]),
    surface: String(row.surface),
    sourceKind: /** @type {const} */ ('native'),
    provenance: /** @type {const} */ ('native'),
    sourceLabel: 'Native Tracking Series',
    executionProfileId: row.execution_profile_id === null ? null : String(row.execution_profile_id),
    benchmarkRevisionId: row.benchmark_revision_id === null ? null : String(row.benchmark_revision_id),
    analysisRevision: row.analysis_revision === null ? null : String(row.analysis_revision),
    comparisonKey: row.comparison_key === null ? null : String(row.comparison_key),
    searchPolicy: row.search_policy === null ? null : String(row.search_policy),
    lastAt: String(row.last_at),
    storedTargets: Number(row.stored_targets),
  }));
}

/** @param {Db} db */
function listStandaloneWeeklySeries(db) {
  const researchRows = all(db, `SELECT id, app_id, run_id, bundle_json, imported_at
    FROM research_runs ORDER BY imported_at DESC, id DESC LIMIT 500`);
  const runIdCounts = new Map();
  for (const row of researchRows) {
    const key = String(row.run_id);
    runIdCounts.set(key, (runIdCounts.get(key) ?? 0) + 1);
  }
  const researchItems = researchRows.map((row) => {
    const bundle = JSON.parse(String(row.bundle_json));
    const runId = String(row.run_id);
    const appId = String(row.app_id);
    const selectorId = (runIdCounts.get(runId) ?? 0) > 1
      ? `research:${appId}:${runId}`
      : `research:${runId}`;
    return {
      id: selectorId,
      surface: 'standalone-research',
      sourceKind: /** @type {const} */ ('standalone_research'),
      provenance: /** @type {const} */ ('external'),
      sourceLabel: STANDALONE_SOURCE_LABEL,
      researchId: Number(row.id),
      appId,
      appName: String(bundle.app?.name ?? appId),
      runId,
      mode: String(bundle.mode ?? 'research_audit'),
      executionProfileId: bundle.execution?.id ? String(bundle.execution.id) : null,
      benchmarkRevisionId: bundle.panel?.id ? String(bundle.panel.id) : null,
      analysisRevision: bundle.analysis?.id ? String(bundle.analysis.id) : null,
      comparisonKey: `research:${appId}:${runId}`,
      searchPolicy: 'external_bundle',
      lastAt: String(bundle.createdAt ?? row.imported_at),
      storedTargets: Array.isArray(bundle.samples) ? bundle.samples.length : 0,
    };
  });

  const studyRows = all(db, `SELECT id, study_id, app_id, snapshot_json, imported_at
    FROM study_imports ORDER BY imported_at DESC, id DESC LIMIT 500`);
  const studyIdCounts = new Map();
  for (const row of studyRows) {
    const key = String(row.study_id);
    studyIdCounts.set(key, (studyIdCounts.get(key) ?? 0) + 1);
  }
  const studyItems = studyRows.map((row) => {
    const snapshot = JSON.parse(String(row.snapshot_json));
    const studyId = String(row.study_id);
    const appId = String(row.app_id);
    const selectorId = (studyIdCounts.get(studyId) ?? 0) > 1
      ? `study:${row.id}`
      : `study:${studyId}`;
    const samplesCount = Array.isArray(snapshot.researchRuns)
      ? snapshot.researchRuns.reduce((/** @type {number} */ sum, /** @type {any} */ item) => sum + ((item?.bundle ?? item?.evidence ?? item)?.samples?.length ?? 0), 0)
      : 0;
    return {
      id: selectorId,
      surface: 'standalone-study',
      sourceKind: /** @type {const} */ ('standalone_study'),
      provenance: /** @type {const} */ ('external'),
      sourceLabel: STANDALONE_SOURCE_LABEL,
      studyRowId: Number(row.id),
      studyId,
      appId,
      appName: String(snapshot.plan?.app?.name ?? appId),
      executionProfileId: snapshot.plan?.id ? String(snapshot.plan.id) : null,
      benchmarkRevisionId: snapshot.plan?.id ? String(snapshot.plan.id) : null,
      analysisRevision: 'study-v1',
      comparisonKey: `study:${studyId}`,
      searchPolicy: 'external_study',
      lastAt: String(row.imported_at),
      storedTargets: samplesCount,
    };
  });

  return [...researchItems, ...studyItems];
}

/** @param {Db} db */
export function listKnownWeeklySeries(db) {
  return [...listNativeWeeklySeries(db), ...listStandaloneWeeklySeries(db)];
}

/** @param {Db} db @param {ReturnType<typeof listNativeWeeklySeries>[number]} identity @param {string} start @param {string} end */
function selectedNativeSeries(db, identity, start, end) {
  const observed = listMeasurementSeries(db, { start, end, now: end }).find((series) => series.id === identity.id);
  if (observed) return { ...observed, sourceKind: /** @type {const} */ ('native'), provenance: /** @type {const} */ ('native'), sourceLabel: 'Native Tracking Series' };
  return { id: identity.id, surface: identity.surface,
    sourceKind: /** @type {const} */ ('native'), provenance: /** @type {const} */ ('native'), sourceLabel: 'Native Tracking Series',
    executionProfileId: identity.executionProfileId,
    benchmarkRevisionId: identity.benchmarkRevisionId,
    analysisRevision: identity.analysisRevision,
    comparisonKey: identity.comparisonKey,
    searchPolicy: identity.searchPolicy,
    start, end, attemptedTargets: 0, completeAnswers: 0, comparableAnswers: 0,
    verifiedSearchAnswers: 0, queryMetadataAnswers: 0, lastAt: '' };
}

/** @param {Db} db @param {string} requestedId @param {string} start @param {string} end */
function resolveStandaloneSource(db, requestedId, start, end) {
  const researchRows = all(db, 'SELECT * FROM research_runs ORDER BY imported_at DESC, id DESC LIMIT 500');
  const studyRows = all(db, 'SELECT * FROM study_imports ORDER BY imported_at DESC, id DESC LIMIT 500');

  if (!requestedId) {
    const inWeekResearch = researchRows.find((row) => {
      try {
        const createdAt = String(JSON.parse(String(row.bundle_json))?.createdAt ?? '');
        return createdAt >= start && createdAt < end;
      } catch { return false; }
    }) ?? researchRows[0];
    if (inWeekResearch) return { kind: /** @type {const} */ ('research'), row: inWeekResearch };
    if (studyRows[0]) return { kind: /** @type {const} */ ('study'), row: studyRows[0] };
    return null;
  }

  if (requestedId.startsWith('research:')) {
    const token = requestedId.slice('research:'.length);
    const byAppAndRun = researchRows.find((row) => `${row.app_id}:${row.run_id}` === token);
    if (byAppAndRun) return { kind: /** @type {const} */ ('research'), row: byAppAndRun };
    const byRunMatches = researchRows.filter((row) => String(row.run_id) === token);
    if (byRunMatches.length > 1) {
      throw new WeeklyReviewError('Multiple apps share that research run ID; select research:<app_id>:<run_id>', 409, 'ambiguous_series');
    }
    if (byRunMatches.length === 1) return { kind: /** @type {const} */ ('research'), row: byRunMatches[0] };
    if (/^\d+$/.test(token)) {
      const byId = researchRows.find((row) => Number(row.id) === Number(token));
      if (byId) return { kind: /** @type {const} */ ('research'), row: byId };
    }
    return null;
  }

  if (requestedId.startsWith('study:')) {
    const token = requestedId.slice('study:'.length);
    const byStudy = studyRows.find((row) => String(row.study_id) === token);
    if (byStudy) return { kind: /** @type {const} */ ('study'), row: byStudy };
    if (/^\d+$/.test(token)) {
      const byId = studyRows.find((row) => Number(row.id) === Number(token));
      if (byId) return { kind: /** @type {const} */ ('study'), row: byId };
    }
    return null;
  }

  const bareResearchMatches = researchRows.filter((row) => String(row.run_id) === requestedId);
  if (bareResearchMatches.length > 1) {
    throw new WeeklyReviewError('Multiple apps share that research run ID; select research:<app_id>:<run_id>', 409, 'ambiguous_series');
  }
  if (bareResearchMatches.length === 1) return { kind: /** @type {const} */ ('research'), row: bareResearchMatches[0] };

  const bareStudyMatches = studyRows.filter((row) => String(row.study_id) === requestedId);
  if (bareStudyMatches.length === 1) return { kind: /** @type {const} */ ('study'), row: bareStudyMatches[0] };

  return null;
}

/** @param {Db} db @param {string} seriesId @param {string} now @returns {WeeklyOpportunityItem[]} */
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

/** @param {ReturnType<typeof intentEvidenceReport>} report @param {number|null} brandId @returns {WeeklyEvidenceItem[]} */
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

/** @param {unknown} rawUrl */
function domainOf(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<typeof intentEvidenceReport>} evidence
 * @param {number|null} brandId
 * @param {string} brandName
 * @param {string[]} brandDomains
 * @returns {WeeklyCitationGaps}
 */
function summarizeNativeWeeklyCitationGaps(evidence, brandId, brandName, brandDomains) {
  const answers = evidence?.answers ?? [];
  const absent = brandId === null
    ? []
    : answers.filter((answer) => !answer.mentions.some((mention) => mention.entityId === brandId));
  const normalizedBrandDomains = brandDomains.map((d) => d.replace(/^www\./, '').toLowerCase()).filter(Boolean);
  const isBrandDomain = (/** @type {string} */ domain) =>
    normalizedBrandDomains.some((bd) => domain === bd || domain.endsWith(`.${bd}`));
  /** @type {Map<string, {domain:string,sampleIds:Set<string>,finalSampleIds:Set<string>,urls:Set<string>}>} */
  const domains = new Map();
  for (const answer of absent) {
    for (const cite of answer.answerCitations) {
      const domain = domainOf(cite.url);
      if (!domain || isBrandDomain(domain)) continue;
      let bucket = domains.get(domain);
      if (!bucket) { bucket = { domain, sampleIds: new Set(), finalSampleIds: new Set(), urls: new Set() }; domains.set(domain, bucket); }
      bucket.sampleIds.add(String(answer.id));
      bucket.finalSampleIds.add(String(answer.id));
      if (bucket.urls.size < 3) bucket.urls.add(cite.url);
    }
    for (const src of answer.sourceObservations) {
      const domain = domainOf(src.url);
      if (!domain || isBrandDomain(domain)) continue;
      let bucket = domains.get(domain);
      if (!bucket) { bucket = { domain, sampleIds: new Set(), finalSampleIds: new Set(), urls: new Set() }; domains.set(domain, bucket); }
      bucket.sampleIds.add(String(answer.id));
      if (bucket.urls.size < 3) bucket.urls.add(src.url);
    }
  }
  const ranked = [...domains.values()]
    .sort((a, b) => b.finalSampleIds.size - a.finalSampleIds.size || b.sampleIds.size - a.sampleIds.size || a.domain.localeCompare(b.domain))
    .slice(0, 5)
    .map((b) => ({
      domain: b.domain,
      sampleCount: b.sampleIds.size,
      finalCitationCount: b.finalSampleIds.size,
      sampleIds: [...b.sampleIds],
      urls: [...b.urls],
    }));
  const decision = /** @type {'investigate_citation_gap'|'hold_steady'|'awaiting_samples'} */ (
    ranked.length > 0 || absent.length > 0
      ? 'investigate_citation_gap'
      : answers.length > 0 ? 'hold_steady' : 'awaiting_samples'
  );
  const actionHeadline = ranked.length > 0
    ? `Competitors are cited via ${ranked.map((d) => d.domain).slice(0, 3).join(', ')}; ${brandName} isn't.`
    : answers.length > 0 && absent.length === 0
      ? `Keep / hold: ${brandName} appeared in all ${answers.length} comparable answer${answers.length === 1 ? '' : 's'} this week.`
      : absent.length > 0
        ? `${brandName} was omitted in ${absent.length}/${answers.length} comparable answer${answers.length === 1 ? '' : 's'} this week.`
        : 'No comparable answers recorded in this week.';
  return {
    completedSamples: answers.length,
    brandAbsentSamples: absent.length,
    domains: ranked,
    decision,
    actionHeadline,
    nextStepStatus: decision === 'hold_steady'
      ? `${brandName} appeared across comparable answers this week; hold current pages steady until the next scheduled run.`
      : 'Inspect cited external domains in Opportunities before choosing or skipping a page change.',
  };
}

/** @param {Db} db @param {import('./db.js').Row} row @param {string} start @param {string} end @param {string} now */
function buildStandaloneResearchReview(db, row, start, end, now) {
  const bundle = JSON.parse(String(row.bundle_json));
  const researchId = Number(row.id);
  const routes = summarizeEvidence(bundle);
  const totals = routes.reduce((acc, item) => ({
    planned: acc.planned + item.planned,
    attempted: acc.attempted + item.attempted,
    completed: acc.completed + item.completed,
    failed: acc.failed + item.failed,
    partial: acc.partial + item.partial,
    skipped: acc.skipped + item.skipped,
    unrecorded: acc.unrecorded + item.unrecorded,
    eligible: acc.eligible + item.eligible,
    mentioned: acc.mentioned + item.mentioned,
    recommended: acc.recommended + item.recommended,
  }), {
    planned: 0, attempted: 0, completed: 0, failed: 0, partial: 0,
    skipped: 0, unrecorded: 0, eligible: 0, mentioned: 0, recommended: 0,
  });

  const evidenceById = new Map((bundle.evidence ?? []).map((/** @type {any} */ item) => [item.id, item]));
  const questionsById = new Map((bundle.panel?.questions ?? []).map((/** @type {any} */ item) => [item.id, item]));
  const queryMetadataSamples = (bundle.samples ?? []).filter((/** @type {any} */ sample) =>
    sampleEligibility(bundle, sample).eligible
    && (sample.evidenceIds ?? []).some((/** @type {string} */ id) => {
      const ev = evidenceById.get(id);
      return ev?.type === 'search_query' && typeof ev.data?.query === 'string' && ev.data.query.trim() !== '';
    })).length;

  const duplicateCount = Number(get(db, 'SELECT COUNT(*) AS n FROM research_runs WHERE run_id = ?', [String(row.run_id)])?.n ?? 1);
  const selectorId = duplicateCount > 1 ? `research:${row.app_id}:${row.run_id}` : `research:${row.run_id}`;
  const inSelectedWeek = String(bundle.createdAt) >= start && String(bundle.createdAt) < end;

  const health = [];
  if (!inSelectedWeek) {
    health.push(`Standalone research run ${bundle.runId} was captured at ${bundle.createdAt} outside this seven-day window; retained as external visibility context`);
  }
  if (totals.attempted === 0) {
    health.push('No standalone answer samples were attempted in this research bundle');
  } else if (totals.eligible < totals.attempted) {
    health.push(`${totals.eligible}/${totals.attempted} attempted standalone samples met independent eligibility`);
  }
  for (const note of bundle.provenance?.limitations ?? []) {
    health.push(`External provenance note: ${note}`);
  }

  const sampleList = /** @type {Record<string, any>[]} */ (Array.isArray(bundle.samples) ? bundle.samples : []);
  /** @type {WeeklyEvidenceItem[]} */
  const evidenceHighlights = sampleList.map((sample, idx) => {
    const eligibility = sampleEligibility(bundle, sample);
    const answerEv = (/** @type {string[]} */ (sample.evidenceIds ?? [])).map((id) => evidenceById.get(id))
      .find((/** @type {any} */ item) => item?.type === 'answer');
    const brandMention = (/** @type {any[]} */ (sample.mentions ?? [])).find((m) => m.brandId === bundle.app.id && m.confidence === 'certain');
    const negative = brandMention && (brandMention.stance === 'negative' || brandMention.stance === 'uncertain');
    const brandAbsent = eligibility.eligible && !brandMention;
    const question = questionsById.get(sample.questionId)?.text ?? String(sample.questionId);
    return {
      responseId: idx + 1,
      sampleId: String(sample.id),
      researchId,
      intentId: 0,
      question: String(question),
      observedAt: String(sample.finishedAt ?? sample.startedAt ?? bundle.createdAt),
      answerExcerpt: String(answerEv?.data?.text ?? '').slice(0, 300),
      brandStances: brandMention?.stance ? [String(brandMention.stance)] : [],
      queryIds: (/** @type {string[]} */ (sample.evidenceIds ?? [])).filter((id) => evidenceById.get(id)?.type === 'search_query'),
      sourceIds: (/** @type {string[]} */ (sample.evidenceIds ?? [])).filter((id) => ['returned_source', 'fetched_page'].includes(evidenceById.get(id)?.type)),
      citationIds: (/** @type {string[]} */ (sample.evidenceIds ?? [])).filter((id) => evidenceById.get(id)?.type === 'final_citation'),
      provenance: /** @type {const} */ ('external'),
      eligible: eligibility.eligible,
      reason: negative ? 'Negative or uncertain brand statement (standalone research)'
        : brandAbsent ? 'Eligible standalone answer where brand was absent'
          : eligibility.eligible ? 'Eligible standalone research answer'
            : `Standalone sample (${eligibility.reasons.join(', ')})`,
      rank: negative ? 0 : brandAbsent ? 1 : eligibility.eligible ? 2 : 3,
    };
  }).sort((a, b) => a.rank - b.rank || b.observedAt.localeCompare(a.observedAt))
    .slice(0, 3)
    .map(({ rank, ...item }) => item);

  const actionRows = all(db, 'SELECT * FROM research_actions WHERE research_id = ? ORDER BY id ASC', [researchId]);
  const actionById = new Map(actionRows.map((action) => [String(action.action_id), action]));
  const priorityMap = { high: 3, medium: 2, low: 1 };
  const effortMap = { small: 'low', medium: 'medium', large: 'high' };
  const recommendationList = /** @type {Record<string, any>[]} */ (Array.isArray(bundle.recommendations) ? bundle.recommendations : []);
  /** @type {WeeklyOpportunityItem[]} */
  const opportunities = recommendationList
    .filter((rec) => actionById.get(rec.id)?.status !== 'dismissed')
    .slice(0, 3)
    .map((rec, idx) => {
      const savedAction = actionById.get(rec.id);
      return {
        id: savedAction ? Number(savedAction.id) : idx + 1,
        actionId: String(rec.id),
        researchId,
        provenance: /** @type {const} */ ('external'),
        intentId: 0,
        observedFinding: String(rec.title),
        hypothesis: String(rec.hypothesis),
        suggestedAction: String(rec.proposedChange),
        priority: priorityMap[/** @type {'high'|'medium'|'low'} */ (rec.priority)] ?? 2,
        effortBand: effortMap[/** @type {'small'|'medium'|'large'} */ (rec.effort)] ?? 'unknown',
        owner: null,
        reviewDate: null,
        status: savedAction ? String(savedAction.status) : 'unreviewed_proposal',
        evidence: { evidenceIds: rec.evidenceIds ?? [] },
        windowStart: start,
        windowEnd: end,
        updatedAt: String(savedAction?.reviewed_at ?? savedAction?.created_at ?? row.imported_at),
      };
    });

  const citationGaps = summarizeResearchCitationGaps(bundle);
  const outcomes = listOutcomeRecords(db, { start, end });
  const controlledPageComparisons = summarizeWeeklyControlledOutcomes(db, { start, end });
  const ledger = listLedgerEntries(db, { start, end });

  const series = {
    id: selectorId,
    surface: 'standalone-research',
    sourceKind: /** @type {const} */ ('standalone_research'),
    provenance: /** @type {const} */ ('external'),
    sourceLabel: STANDALONE_SOURCE_LABEL,
    researchId,
    appId: String(bundle.app.id),
    appName: String(bundle.app.name),
    runId: String(bundle.runId),
    mode: String(bundle.mode),
    executionProfileId: String(bundle.execution.id),
    benchmarkRevisionId: String(bundle.panel.id),
    analysisRevision: String(bundle.analysis.id),
    comparisonKey: `research:${bundle.app.id}:${bundle.runId}`,
    searchPolicy: 'external_bundle',
    start,
    end,
    attemptedTargets: totals.attempted,
    completeAnswers: totals.completed,
    comparableAnswers: totals.eligible,
    verifiedSearchAnswers: totals.eligible,
    queryMetadataAnswers: queryMetadataSamples,
    lastAt: String(bundle.createdAt),
  };

  const actionState = opportunities.length || citationGaps.brandAbsentSamples > 0 || controlledPageComparisons.length > 0
    ? 'review_items'
    : 'nothing_requires_action';

  return {
    scope: {
      series,
      visibilitySource: STANDALONE_SOURCE_LABEL,
      provenance: /** @type {const} */ ('external'),
      start,
      end,
      generatedAt: now,
      days: 7,
    },
    coverage: {
      attemptedTargets: totals.attempted,
      completeAnswers: totals.completed,
      comparableAnswers: totals.eligible,
      verifiedSearchAnswers: totals.eligible,
      queryMetadataAnswers: queryMetadataSamples,
      mentionRate: null,
      recommendationRate: null,
      nativeSeriesBlended: false,
      provenance: /** @type {const} */ ('external'),
      evidence: null,
    },
    standaloneResearch: {
      researchId,
      sourceLabel: STANDALONE_SOURCE_LABEL,
      provenance: /** @type {const} */ ('external'),
      appId: String(bundle.app.id),
      appName: String(bundle.app.name),
      appUrl: bundle.app.url ?? null,
      runId: String(bundle.runId),
      mode: String(bundle.mode),
      observedAt: String(bundle.createdAt),
      importedAt: String(row.imported_at),
      observedInSelectedWeek: inSelectedWeek,
      panelId: String(bundle.panel.id),
      executionId: String(bundle.execution.id),
      analysisId: String(bundle.analysis.id),
      producer: String(bundle.provenance.producer),
      limitations: Array.isArray(bundle.provenance.limitations) ? bundle.provenance.limitations : [],
      totals,
      routes,
      citationGaps,
    },
    standaloneStudy: null,
    citationGaps,
    health,
    importantEvidence: evidenceHighlights,
    opportunities,
    dueReviews: [],
    descriptiveChanges: [],
    reportedOutcomes: outcomes,
    controlledPageComparisons,
    controlPageNote: CONTROL_PAGE_NOTE,
    reportedLedger: ledger,
    measurementSpend: {
      attemptedCalls: 0,
      knownCalls: 0,
      partialCalls: 0,
      unknownCalls: 0,
      totalUsd: null,
      knownSubtotalUsd: null,
      costStatus: 'unavailable',
    },
    subscriptionAllowance: 'Standalone research captures retain external provenance and are never blended into native API spend or tracking rates',
    outcomesStatus: outcomes.length ? 'reported' : 'not_recorded',
    ledgerStatus: ledger.length ? 'reported' : 'not_recorded',
    reportedDataScope: 'Outcome and ledger records overlap this week across the local workspace; standalone research retains external provenance and is never blended into native measurement rates',
    actionState,
    interpretation: INTERPRETATION,
  };
}

/** @param {Db} db @param {import('./db.js').Row} row @param {string} start @param {string} end @param {string} now */
function buildStandaloneStudyReview(db, row, start, end, now) {
  const snapshot = JSON.parse(String(row.snapshot_json));
  const derived = deriveStudyReport(snapshot);
  const studyRowId = Number(row.id);
  const selectorId = `study:${row.study_id}`;
  const outcomes = listOutcomeRecords(db, { start, end });
  const controlledPageComparisons = summarizeWeeklyControlledOutcomes(db, { start, end });
  const ledger = listLedgerEntries(db, { start, end });

  const series = {
    id: selectorId,
    surface: 'standalone-study',
    sourceKind: /** @type {const} */ ('standalone_study'),
    provenance: /** @type {const} */ ('external'),
    sourceLabel: STANDALONE_SOURCE_LABEL,
    studyRowId,
    studyId: String(row.study_id),
    appId: String(row.app_id),
    appName: String(snapshot.plan?.app?.name ?? row.app_id),
    executionProfileId: snapshot.plan?.id ? String(snapshot.plan.id) : null,
    benchmarkRevisionId: snapshot.plan?.id ? String(snapshot.plan.id) : null,
    analysisRevision: 'study-v1',
    comparisonKey: selectorId,
    searchPolicy: 'external_study',
    start,
    end,
    attemptedTargets: derived.summary.searchRequests,
    completeAnswers: derived.summary.recommendationObservations,
    comparableAnswers: derived.summary.recommendationObservations,
    verifiedSearchAnswers: derived.summary.recommendationObservations,
    queryMetadataAnswers: derived.summary.searchRequests,
    lastAt: String(row.imported_at),
  };

  return {
    scope: {
      series,
      visibilitySource: STANDALONE_SOURCE_LABEL,
      provenance: /** @type {const} */ ('external'),
      start,
      end,
      generatedAt: now,
      days: 7,
    },
    coverage: {
      attemptedTargets: derived.summary.searchRequests,
      completeAnswers: derived.summary.recommendationObservations,
      comparableAnswers: derived.summary.recommendationObservations,
      verifiedSearchAnswers: derived.summary.recommendationObservations,
      queryMetadataAnswers: derived.summary.searchRequests,
      mentionRate: null,
      recommendationRate: null,
      nativeSeriesBlended: false,
      provenance: /** @type {const} */ ('external'),
      evidence: null,
    },
    standaloneResearch: null,
    standaloneStudy: {
      studyRowId,
      studyId: String(row.study_id),
      appId: String(row.app_id),
      appName: String(snapshot.plan?.app?.name ?? row.app_id),
      importedAt: String(row.imported_at),
      sourceLabel: STANDALONE_SOURCE_LABEL,
      provenance: /** @type {const} */ ('external'),
      summary: derived.summary,
      business: derived.business,
      citationGaps: derived.citationGaps,
    },
    citationGaps: {
      completedSamples: derived.citationGaps.completedAnswers + derived.citationGaps.completedSearches,
      brandAbsentSamples: derived.citationGaps.brandAbsentAnswers + derived.citationGaps.brandAbsentSearches,
      domains: derived.citationGaps.domains.map((d) => ({
        domain: d.domain,
        sampleCount: d.observations,
        finalCitationCount: d.finalCitations,
      })),
      decision: derived.citationGaps.decision,
      actionHeadline: derived.citationGaps.actionHeadline,
      nextStepStatus: derived.citationGaps.nextStepStatus,
    },
    health: [`Imported standalone study ${row.study_id} (${row.imported_at}) retains external provenance and is never blended into native tracking rates`],
    importantEvidence: /** @type {WeeklyEvidenceItem[]} */ ([]),
    opportunities: /** @type {WeeklyOpportunityItem[]} */ ([]),
    dueReviews: [],
    descriptiveChanges: [],
    reportedOutcomes: outcomes,
    controlledPageComparisons,
    controlPageNote: CONTROL_PAGE_NOTE,
    reportedLedger: ledger,
    measurementSpend: {
      attemptedCalls: 0,
      knownCalls: 0,
      partialCalls: 0,
      unknownCalls: 0,
      totalUsd: null,
      knownSubtotalUsd: null,
      costStatus: 'unavailable',
    },
    subscriptionAllowance: 'Standalone study snapshots retain external provenance and are never blended into native API spend or tracking rates',
    outcomesStatus: outcomes.length ? 'reported' : 'not_recorded',
    ledgerStatus: ledger.length ? 'reported' : 'not_recorded',
    reportedDataScope: 'Outcome and ledger records overlap this week across the local workspace; standalone study data retains external provenance and is never blended into native measurement rates',
    actionState: derived.summary.analysisDue > 0 || controlledPageComparisons.length > 0 ? 'review_items' : 'nothing_requires_action',
    interpretation: INTERPRETATION,
  };
}

/**
 * Assemble a read-only weekly review of one exact historical measurement identity
 * (or a standalone research audit / study snapshot when selected or when no native
 * tracking series exists in the workspace).
 * The report never starts a provider run, changes a schedule, blends external
 * research into native rates, or claims causal attribution.
 * @param {Db} db
 * @param {{seriesId?:string,start:string,end:string,now:string}} selection
 */
export function buildWeeklyReview(db, selection) {
  const start = utc(selection.start, 'start');
  const end = utc(selection.end, 'end');
  const now = utc(selection.now, 'now');
  if (Date.parse(end) - Date.parse(start) !== WEEK_MS) {
    throw new WeeklyReviewError('Weekly review needs exactly seven days');
  }
  if (end > now) throw new WeeklyReviewError('Review window cannot end in the future');
  const requestedId = String(selection.seriesId ?? '').trim();
  const nativeSeries = listNativeWeeklySeries(db);

  if (!requestedId) {
    if (nativeSeries.length > 0) {
      throw new WeeklyReviewError('An explicit measurement series is required');
    }
    const fallback = resolveStandaloneSource(db, '', start, end);
    if (!fallback) {
      throw new WeeklyReviewError('An explicit measurement series is required');
    }
    return fallback.kind === 'research'
      ? buildStandaloneResearchReview(db, fallback.row, start, end, now)
      : buildStandaloneStudyReview(db, fallback.row, start, end, now);
  }

  const nativeMatch = nativeSeries.find((row) => row.id === requestedId);
  if (!nativeMatch) {
    const standalone = resolveStandaloneSource(db, requestedId, start, end);
    if (!standalone) {
      throw new WeeklyReviewError('Selected measurement series was not found', 404, 'series_not_found');
    }
    return standalone.kind === 'research'
      ? buildStandaloneResearchReview(db, standalone.row, start, end, now)
      : buildStandaloneStudyReview(db, standalone.row, start, end, now);
  }

  const series = selectedNativeSeries(db, nativeMatch, start, end);
  const brand = get(db, 'SELECT id, name, domains FROM entities WHERE is_self = 1 AND archived_at IS NULL ORDER BY id LIMIT 1');
  const brandId = brand ? Number(brand.id) : null;
  const brandName = brand?.name ? String(brand.name) : 'your site';
  /** @type {string[]} */
  let brandDomains = [];
  if (brand && typeof brand.domains === 'string') {
    try {
      const parsedDomains = JSON.parse(brand.domains);
      if (Array.isArray(parsedDomains)) brandDomains = parsedDomains.filter((d) => typeof d === 'string');
    } catch { /* ignore malformed domain json */ }
  }
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
  const opportunities = priorityOpportunities(db, requestedId, now);
  const due = dueReviews(db, requestedId, now);
  const changes = savedChanges(db, requestedId, start, end);
  const outcomes = listOutcomeRecords(db, { start, end });
  const controlledPageComparisons = summarizeWeeklyControlledOutcomes(db, { start, end });
  const ledger = listLedgerEntries(db, { start, end });
  const evidenceHighlights = importantEvidence(evidence, brandId);
  const citationGaps = summarizeNativeWeeklyCitationGaps(evidence, brandId, brandName, brandDomains);
  const actionState = opportunities.length || due.length || health.length
    || evidenceHighlights.some((item) => item.reason !== 'Recent comparable answer')
    ? 'review_items' : 'nothing_requires_action';
  return {
    scope: {
      series,
      visibilitySource: 'Native Tracking Series',
      provenance: /** @type {const} */ ('native'),
      start,
      end,
      generatedAt: now,
      days: 7,
    },
    coverage: {
      attemptedTargets: series.attemptedTargets,
      completeAnswers: series.completeAnswers,
      comparableAnswers: series.comparableAnswers,
      verifiedSearchAnswers: series.verifiedSearchAnswers,
      queryMetadataAnswers: series.queryMetadataAnswers,
      mentionRate: brandId === null ? null : mentionRate(db, { ...options, entityId: brandId }),
      recommendationRate: recommendation,
      nativeSeriesBlended: false,
      provenance: /** @type {const} */ ('native'),
      evidence: evidence?.coverage ?? null,
    },
    standaloneResearch: null,
    standaloneStudy: null,
    citationGaps,
    health,
    importantEvidence: evidenceHighlights,
    opportunities,
    dueReviews: due,
    descriptiveChanges: changes,
    reportedOutcomes: outcomes,
    controlledPageComparisons,
    controlPageNote: CONTROL_PAGE_NOTE,
    reportedLedger: ledger,
    measurementSpend: spend,
    subscriptionAllowance: 'Subscription usage is not assigned a dollar cost unless a billed amount is entered in the ledger',
    outcomesStatus: outcomes.length ? 'reported' : 'not_recorded',
    ledgerStatus: ledger.length ? 'reported' : 'not_recorded',
    reportedDataScope: 'Outcome and ledger records overlap this week across the local workspace; they are not automatically attributable to the selected measurement series or an intervention',
    actionState,
    interpretation: INTERPRETATION,
  };
}

/** @param {unknown} value */
function markdownText(value) {
  return String(value ?? '').replaceAll(/\r\n|[\r\n]/g, ' ')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll(/([\\`*_{}\[\]()#+.!|])/g, '\\$1');
}

/** @param {ReturnType<typeof buildWeeklyReview>} report */
export function renderWeeklyMarkdown(report) {
  const isExternal = report.scope.provenance === 'external';
  const sr = report.standaloneResearch;
  const ss = report.standaloneStudy;
  const lines = [
    '# Hearsay weekly review', '',
    `Series: ${report.scope.series.id} (${isExternal ? STANDALONE_SOURCE_LABEL : report.scope.series.surface})`,
    ...(isExternal ? [`Visibility source: ${STANDALONE_SOURCE_LABEL} (external provenance; never blended with native tracking rates)`] : []),
    `Week: ${report.scope.start} to ${report.scope.end} UTC, end exclusive`,
    `Generated: ${report.scope.generatedAt}`, '',
    '## Collection health', '',
    ...(sr
      ? [
          `${STANDALONE_SOURCE_LABEL} (${markdownText(sr.appName)} · ${markdownText(sr.runId)} · ${markdownText(sr.mode)}): ${sr.totals.eligible}/${sr.totals.attempted} attempted samples eligible (${sr.totals.planned} planned, ${sr.totals.completed} completed, ${sr.totals.mentioned}/${sr.totals.eligible || 0} eligible mentioned, ${sr.totals.recommended}/${sr.totals.eligible || 0} eligible recommended).`,
        ]
      : ss
        ? [
            `${STANDALONE_SOURCE_LABEL} (${markdownText(ss.appName)} · study ${markdownText(ss.studyId)}): ${ss.summary.searchRequests} search requests, ${ss.summary.recommendationObservations} eligible recommendation observations.`,
          ]
        : [`${report.coverage.comparableAnswers}/${report.coverage.attemptedTargets} attempted targets produced comparable answers.`]),
    ...report.health.map((message) => `- ${message}`), '',
    '## Important evidence', '',
    ...(report.importantEvidence.length ? report.importantEvidence.map((item) =>
      `- ${item.sampleId ? `Sample ${markdownText(item.sampleId)}` : `Answer #${item.responseId}`}: ${markdownText(item.reason)}; query IDs ${item.queryIds.join(', ') || 'none'}, source IDs ${item.sourceIds.join(', ') || 'none'}, citation IDs ${item.citationIds.join(', ') || 'none'}.`)
      : ['No comparable answer evidence in this week.']), '',
    '## Priorities and follow-up', '',
    ...(report.opportunities.length ? report.opportunities.map((item) =>
      `- Opportunity #${item.id} (priority ${item.priority}): ${markdownText(item.suggestedAction)}`)
      : ['No prioritized opportunities.']),
    ...(!report.opportunities.length && report.citationGaps?.domains.length ? [
      `- Citation-gap next step: ${markdownText(report.citationGaps.actionHeadline)}`,
      ...report.citationGaps.domains.map((item) =>
        `  - ${markdownText(item.domain)}: ${item.sampleCount} brand-absent observation${item.sampleCount === 1 ? '' : 's'}${item.finalCitationCount ? ` (${item.finalCitationCount} final citation${item.finalCitationCount === 1 ? '' : 's'})` : ''}`),
    ] : !report.opportunities.length && isExternal && report.citationGaps?.decision === 'hold_steady' ? [
      `- Keep / hold next step: ${markdownText(report.citationGaps.actionHeadline)}`,
    ] : []),
    ...(report.dueReviews.length ? report.dueReviews.map((item) =>
      `- Opportunity #${item.id} is due for review.`) : []),
    ...(report.actionState === 'nothing_requires_action' ? ['Nothing requires action.'] : []), '',
    '## Saved descriptive changes', '',
    ...(report.descriptiveChanges.length ? report.descriptiveChanges.map((item) =>
      `- Opportunity #${item.opportunityId}: ${item.status}; user judgment ${item.judgment}.`)
      : ['No intervention review saved in this week.']), '',
    ...(report.controlledPageComparisons?.length ? [
      '## Changed vs. control page business comparison', '',
      ...report.controlledPageComparisons.flatMap((group) => [
        `### ${markdownText(group.label)}`,
        ...group.items.map((item) => {
          const unitLabel = item.currency ? `${item.unit} ${item.currency}` : item.unit;
          const changedText = item.changed.baseline !== null && item.changed.post !== null
            ? `changed ${item.changed.baseline} -> ${item.changed.post} (${item.changed.signedDelta})`
            : item.changed.post !== null ? `changed post ${item.changed.post}` : 'changed unavailable';
          const controlText = item.control.baseline !== null && item.control.post !== null
            ? `control ${item.control.baseline} -> ${item.control.post} (${item.control.signedDelta})`
            : item.control.post !== null ? `control post ${item.control.post}` : 'control unavailable';
          const diffText = item.differenceInChange !== null
            ? `; difference-in-change ${item.signedDifferenceInChange}`
            : item.windowDifference !== null ? `; window difference ${item.signedWindowDifference}` : '';
          return `- ${markdownText(item.metricName)} (${markdownText(unitLabel)}): ${changedText}; ${controlText}${diffText}.`;
        }),
      ]),
      `- ${report.controlPageNote}`, '',
    ] : []),
    '## Reported outcomes and costs', '',
    `${report.reportedDataScope}.`,
    ...(report.reportedOutcomes.length ? report.reportedOutcomes.map((item) => {
      const actionSuffix = [
        item.interventionId ? `action ${markdownText(item.interventionId)}` : '',
        item.opportunityId ? `opportunity #${item.opportunityId}` : '',
        item.pageRole ? `role ${item.pageRole}` : '',
      ].filter(Boolean).join(', ');
      return `- ${markdownText(item.metricName)}: ${item.value} ${markdownText(item.unit)}${item.currency ? ` ${item.currency}` : ''}; ${markdownText(item.source)}; ${item.periodStart} to ${item.periodEnd}; attribution ${markdownText(item.attributionMethod)}${actionSuffix ? `; ${actionSuffix}` : ''}${item.overlapIds?.length ? `; overlaps record IDs ${item.overlapIds.join(', ')}` : ''}.`;
    })
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
