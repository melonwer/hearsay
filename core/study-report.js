/** Deterministic factual reports for saved website studies. */
import { createHash } from 'node:crypto';
import { sampleEligibility } from './research-contract.js';

/** @param {unknown} value */
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {};
/** @param {unknown} value @returns {any[]} */
const list = (value) => Array.isArray(value) ? value : [];
/** @param {unknown} value @param {string} fallback */
function id(value, fallback) { return typeof value === 'string' && value ? value : fallback; }
/** @param {string} value */
function md(value) { return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' '); }
/** @param {unknown} value */
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }

/** @param {any[]} records @param {string|null} appUrl */
function searchPresence(records, appUrl) {
  const completed = records.filter((record) => record.status === 'completed');
  const found = completed.filter((record) => list(record.results).some((source) => {
    try { return appUrl && new URL(source.url).hostname.replace(/^www\./, '') === new URL(appUrl).hostname.replace(/^www\./, ''); } catch { return false; }
  })).length;
  return { found, completed: completed.length, rate: completed.length ? found / completed.length : null };
}

/**
 * Match fetched/snippet content to a saved page revision. URL equality is intentionally
 * insufficient: only distinguishing revision text can establish a revision match.
 * @param {{url?:string,content?:string,method?:string,versions?:unknown[],pages?:unknown[],activeVersionId?:string|null}} input
 */
export function deriveStudyExposure(input) {
  const url = typeof input?.url === 'string' ? input.url : null;
  const content = typeof input?.content === 'string' ? input.content : null;
  const method = typeof input?.method === 'string' ? input.method : 'unknown';
  const versions = list(input?.versions).map(object);
  const pages = list(input?.pages).map(object);
  const activeVersionId = input?.activeVersionId ?? null;
  const active = versions.find((version) => version.id === activeVersionId) ?? versions.find((version) => version.status === 'published') ?? versions.at(-1) ?? null;
  const activePage = active ? pages.find((page) => page.id === active.pageId || page.id === active.captureId) : null;
  const activeText = String(activePage?.content ?? activePage?.text ?? activePage?.extractedContent ?? '');
  const sameUrl = Boolean(url && activePage && (url === activePage.url || url === activePage.finalUrl || url === activePage.requestedUrl));
  const matches = versions.map((version) => {
    const page = pages.find((candidate) => candidate.id === version.pageId || candidate.id === version.captureId);
    const distinguishing = String(page?.content ?? page?.text ?? page?.extractedContent ?? version.distinguishingText ?? '');
    const hasText = Boolean(content && distinguishing && (content.includes(distinguishing) || distinguishing.includes(content)));
    return { versionId: id(version.id, 'unknown'), sameUrl: Boolean(url && page && [page.url, page.finalUrl, page.requestedUrl].includes(url)), textMatch: hasText };
  });
  const textMatches = matches.filter((match) => match.textMatch && match.sameUrl);
  const textMatch = textMatches.length === 1 ? textMatches[0] : null;
  let status = 'unknown_content';
  if (textMatches.length > 1) status = 'ambiguous_content';
  else if (textMatch) status = textMatch.versionId === active?.id ? 'active_revision_observed' : 'older_revision_observed';
  else if (sameUrl && !content) status = 'url_only';
  else if (sameUrl) status = 'url_match_content_unconfirmed';
  return {
    version: 1, id: hash({ url, content, method, activeVersionId }).slice(0, 24), url, method,
    contentHash: content ? hash(content) : null, activeVersionId,
    status, confirmsRevision: status === 'active_revision_observed' || status === 'older_revision_observed',
    confirmsIndexing: false, matches,
  };
}

/** @param {Record<string, any>} snapshot */
/** @param {Record<string, any>} snapshot */
function angleFacts(snapshot) {
  const plan = object(snapshot?.plan); const angles = list(plan.angles); const planQuestions = list(plan.questions); const questionAngles = new Map(planQuestions.map((question) => [question.id, question.angleId]));
  const searches = list(snapshot?.searchRuns); const research = list(snapshot?.researchRuns);
  return angles.map((angle, index) => {
    const angleId = id(angle.id, `angle-${index + 1}`);
    const questions = list(plan.questions).filter((question) => question.angleId === angleId);
    const allRecords = searches.flatMap((run) => list(run.records).map((record) => ({ ...record, _lane: record.lane ?? run.lane ?? 'collection' }))).filter((record) => record.angleId === angleId && (!record.query || planQuestions.some((question) => question.id === record.questionId && question.text === record.query)));
    const diagnostics = allRecords.filter((record) => record._lane === 'diagnostic'); const records = allRecords.filter((record) => record._lane !== 'diagnostic');
    const requests = records.length; const attempted = records.filter((record) => ['completed', 'failed', 'partial'].includes(record.status)).length;
    const completed = records.filter((record) => record.status === 'completed').length;
    const evidence = [];
    for (const run of research) {
      const bundle = object(run.bundle ?? run.evidence ?? run);
      for (const sample of list(bundle.samples ?? run.samples)) {
        const bundleQuestion = list(bundle.panel?.questions).find((question) => question.id === sample.questionId); const currentQuestion = planQuestions.find((question) => question.id === sample.questionId);
        const frozenQuestion = !bundleQuestion || !currentQuestion || bundleQuestion.text === currentQuestion.text;
        const sampleAngle = sample.angleId ?? questionAngles.get(sample.questionId);
        if (sampleAngle !== angleId) continue;
        let eligibility = { eligible: false, reasons: ['missing_eligibility'] };
        try { eligibility = sampleEligibility(bundle, sample); } catch { /* malformed historical evidence is reported as unavailable */ }
        evidence.push({ sample, bundle, eligibility: frozenQuestion ? eligibility : { eligible: false, reasons: ['panel_revision_changed'] }, routeId: sample.routeId ?? sample.route ?? null, questionId: sample.questionId ?? null, occurrenceId: sample.occurrenceId ?? run.occurrenceId ?? null });
      }
    }
    const independent = evidence.filter((item) => item.eligibility.eligible);
    const recommendations = independent.filter(({ sample, bundle }) => sample.recommended === true || sample.recommendation === true || list(sample.mentions).some((mention) => mention.brandId === bundle.app?.id && mention.confidence === 'certain' && mention.positive === true));
    /** @param {string} key */
    const breakdown = (key) => { const groups = new Map(); for (const item of /** @type {any[]} */ (independent)) { const value = item[key] ?? 'unknown'; const row = groups.get(value) ?? { observations: 0, positive: 0 }; row.observations += 1; if (recommendations.includes(item)) row.positive += 1; groups.set(value, row); } return Object.fromEntries([...groups.entries()].map(([value, row]) => [value, { ...row, rate: row.observations ? row.positive / row.observations : null }])); };
    return { id: angleId, label: angle.label ?? angleId, buyerJob: angle.buyerJob ?? null, rationale: angle.rationale ?? null,
      questionCount: questions.length, questionIds: questions.map((question) => question.id), searchRequests: requests,
      searchPresence: searchPresence(records, plan.app?.url ?? plan.targetUrl ?? null),
      questions: questions.map((question) => ({ id: question.id, text: question.text,
        searchPresence: searchPresence(records.filter((record) => record.questionId === question.id && record.query === question.text), plan.app?.url ?? plan.targetUrl ?? null) })),
      searchAttempted: attempted, searchCompleted: completed, recommendationObservations: independent.length,
      recommendationPositive: recommendations.length, recommendationRate: independent.length ? recommendations.length / independent.length : null, recommendationRates: { route: breakdown('routeId'), question: breakdown('questionId'), occurrence: breakdown('occurrenceId') },
      diagnosticRequests: diagnostics.length, contextualObservations: evidence.length - independent.length, evidenceIds: list(angle.evidenceIds), status: independent.length || records.length ? 'observed' : 'planned' };
  });
}

/** @param {Record<string, any>} snapshot */
function businessFacts(snapshot) {
  const plan = object(snapshot?.plan); const comparison = object(plan.comparison); const contract = object(plan.outcome);
  const targetUrl = typeof plan.targetUrl === 'string' ? plan.targetUrl : null; const referenceUrl = typeof comparison.referenceUrl === 'string' ? comparison.referenceUrl : null;
  const design = comparison.design ?? 'before_after'; const outcomes = list(snapshot?.outcomes).map(object); const groups = new Map();
  for (const outcome of outcomes) {
    const key = `${outcome.changeId ?? 'unlinked'}:${outcome.metric ?? ''}:${outcome.unit ?? ''}:${outcome.currency ?? ''}`;
    const bucket = groups.get(key) ?? { changeId: outcome.changeId ?? null, metric: outcome.metric ?? null, unit: outcome.unit ?? null, currency: outcome.currency ?? null, rows: [] };
    bucket.rows.push(outcome); groups.set(key, bucket);
  }
  /** @param {any[]} rows */
  const aggregate = (rows) => ({ value: rows.reduce((sum, item) => sum + Number(item.value ?? 0), 0), denominator: rows.length && rows.every((item) => item.denominator != null) ? rows.reduce((sum, item) => sum + Number(item.denominator), 0) : null, observations: rows.length });
  /** @param {any[]} rows */
  const rate = (rows) => {
    const aggregateRow = aggregate(rows); if (!aggregateRow.denominator) return null;
    const unit = String(rows[0]?.unit ?? 'count').toLowerCase();
    if (unit === 'rate' || unit === 'ratio') return rows.reduce((sum, item) => sum + Number(item.value ?? 0) * Number(item.denominator ?? 0), 0) / aggregateRow.denominator;
    return aggregateRow.value / aggregateRow.denominator;
  };
  /** @param {any[]} rows */
  const windowKeys = (rows) => new Set(rows.map((/** @type {any} */ item) => `${item.periodStart}/${item.periodEnd}`));
  /** @param {any[]} rows */
  const periodDays = (rows) => rows.map((/** @type {any} */ item) => (Date.parse(item.periodEnd) - Date.parse(item.periodStart)) / 86400000);
  return [...groups.values()].map((bucket) => {
    const rows = bucket.rows; const targetRows = targetUrl ? rows.filter((/** @type {any} */ item) => item.pageUrl === targetUrl) : rows; const referenceRows = referenceUrl ? rows.filter((/** @type {any} */ item) => item.pageUrl === referenceUrl) : [];
    const unknownPageRows = targetUrl ? rows.filter((/** @type {any} */ item) => item.pageUrl !== targetUrl && item.pageUrl !== referenceUrl) : [];
    const targetBaseline = targetRows.filter((/** @type {any} */ item) => item.phase === 'baseline'); const targetAfter = targetRows.filter((/** @type {any} */ item) => item.phase === 'after');
    const referenceBaseline = referenceRows.filter((/** @type {any} */ item) => item.phase === 'baseline'); const referenceAfter = referenceRows.filter((/** @type {any} */ item) => item.phase === 'after');
    const allCompared = [...targetBaseline, ...targetAfter, ...(design === 'unchanged_reference' ? [...referenceBaseline, ...referenceAfter] : [])];
    const denominatorMissing = allCompared.some((/** @type {any} */ item) => item.denominator == null);
    const trafficMismatch = allCompared.some((/** @type {any} */ item) => /different|mismatch|unequal|unknown/i.test(String(item.trafficNotes ?? '')));
    const minimumDenominator = Number(contract.minimumDenominator ?? 1); const minimumObservations = Number(contract.minimumObservations ?? 1);
    const controlledTreatmentBaseline = targetBaseline.filter((/** @type {any} */ item) => String(item.cohort).toLowerCase() === 'treatment'); const controlledTreatmentAfter = targetAfter.filter((/** @type {any} */ item) => String(item.cohort).toLowerCase() === 'treatment');
    const controlledControlBaseline = targetBaseline.filter((/** @type {any} */ item) => String(item.cohort).toLowerCase() === 'control'); const controlledControlAfter = targetAfter.filter((/** @type {any} */ item) => String(item.cohort).toLowerCase() === 'control');
    /** @param {any[]} left @param {any[]} right */
    const armWindowsMatch = (left, right) => windowKeys(left).size === windowKeys(right).size && [...windowKeys(left)].every((window) => windowKeys(right).has(window));
    const windowsMatch = design === 'unchanged_reference' ? (armWindowsMatch(targetBaseline, referenceBaseline) && armWindowsMatch(targetAfter, referenceAfter)) : design === 'controlled_allocation' ? (armWindowsMatch(controlledTreatmentBaseline, controlledControlBaseline) && armWindowsMatch(controlledTreatmentAfter, controlledControlAfter)) : true;
    const lowSample = allCompared.some((/** @type {any} */ item) => item.denominator != null && Number(item.denominator) < minimumDenominator) || (design === 'controlled_allocation' ? [controlledTreatmentBaseline, controlledControlBaseline, controlledTreatmentAfter, controlledControlAfter].some((rows) => rows.length < minimumObservations) : targetBaseline.length < minimumObservations || targetAfter.length < minimumObservations || (design === 'unchanged_reference' && (referenceBaseline.length < minimumObservations || referenceAfter.length < minimumObservations)));
    const reviewPeriodDays = Number(contract.reviewPeriodDays ?? 1); const reviewPeriodSatisfied = periodDays(targetAfter).every((days) => Number.isFinite(days) && days >= reviewPeriodDays);
    const missingReference = design === 'unchanged_reference' && (!referenceUrl || referenceBaseline.length === 0 || referenceAfter.length === 0);
    const missingChangeLink = !bucket.changeId;
    const unmatchedPages = unknownPageRows.length > 0 || (design === 'unchanged_reference' && rows.some((/** @type {any} */ item) => item.pageUrl !== targetUrl && item.pageUrl !== referenceUrl));
    const assignmentSpec = comparison.assignment;
    const assignmentMethod = typeof assignmentSpec === 'string' ? assignmentSpec.trim().toLowerCase() : typeof assignmentSpec?.method === 'string' ? assignmentSpec.method.trim().toLowerCase() : '';
    const assignmentDocumented = design === 'controlled_allocation' && Boolean(assignmentMethod) && !/not\s+random|none|unknown/.test(assignmentMethod) && allCompared.length > 0 && allCompared.every((/** @type {any} */ item) => typeof item.assignment === 'string' && item.assignment.trim().toLowerCase() === assignmentMethod);
    const cohortRows = new Map(); for (const item of allCompared) { const key = `${item.phase}:${String(item.cohort ?? '').trim().toLowerCase()}`; cohortRows.set(key, (cohortRows.get(key) ?? 0) + 1); }
    const hasControlCohort = design === 'controlled_allocation' && ['baseline', 'after'].every((phase) => cohortRows.has(`${phase}:control`) && cohortRows.has(`${phase}:treatment`));
    const reasons = [];
    if (missingChangeLink) reasons.push('missing_change_link'); if (denominatorMissing) reasons.push('missing_denominator'); if (trafficMismatch) reasons.push('traffic_mismatch'); if (unmatchedPages) reasons.push('unmatched_page'); if (!windowsMatch) reasons.push('unmatched_windows'); if (missingReference) reasons.push('missing_reference'); if (!reviewPeriodSatisfied) reasons.push('review_period_incomplete'); if (lowSample) reasons.push('insufficient_sample'); if (design === 'controlled_allocation' && !assignmentDocumented) reasons.push('assignment_undocumented'); if (design === 'controlled_allocation' && !hasControlCohort) reasons.push('missing_control_cohort');
    const baselineRate = rate(targetBaseline); const afterRate = rate(targetAfter); const referenceBaselineRate = rate(referenceBaseline); const referenceAfterRate = rate(referenceAfter);
    const targetDelta = baselineRate != null && afterRate != null ? afterRate - baselineRate : null; const referenceDelta = referenceBaselineRate != null && referenceAfterRate != null ? referenceAfterRate - referenceBaselineRate : null;
    const controlledEffect = design === 'controlled_allocation' ? ((rate(controlledTreatmentAfter) ?? NaN) - (rate(controlledTreatmentBaseline) ?? NaN)) - ((rate(controlledControlAfter) ?? NaN) - (rate(controlledControlBaseline) ?? NaN)) : null;
    const absoluteEffect = design === 'unchanged_reference' ? (targetDelta != null && referenceDelta != null ? targetDelta - referenceDelta : null) : design === 'controlled_allocation' ? (Number.isFinite(controlledEffect) ? controlledEffect : null) : targetDelta;
    const comparable = reasons.length === 0; let conclusion = 'inconclusive';
    if (comparable && design === 'controlled_allocation') {
      const minimumEffect = Number(contract.minimumEffect ?? 0); const lossLimit = Number(contract.lossLimit ?? 0);
      conclusion = absoluteEffect != null && absoluteEffect <= -lossLimit && lossLimit > 0 ? 'loss_limit_reached' : Math.abs(absoluteEffect ?? 0) >= minimumEffect ? 'documented_controlled_comparison' : 'below_minimum_effect';
    } else if (comparable) conclusion = design === 'unchanged_reference' ? 'observed_difference_requires_caution' : 'observed_before_after_difference_requires_caution';
    return { changeId: bucket.changeId, metric: bucket.metric, unit: bucket.unit, currency: bucket.currency, design, targetUrl, referenceUrl,
      baseline: targetBaseline, after: targetAfter, referenceBaseline: referenceBaseline, referenceAfter, baselineRate, afterRate, referenceBaselineRate, referenceAfterRate,
      absoluteEffect, targetDelta, referenceDelta, denominatorMissing, trafficMismatch, unmatchedPages, windowsMatch, missingReference, missingChangeLink,
      reviewPeriodSatisfied, lowSample, assignmentDocumented, hasControlCohort, comparable, inconclusiveReasons: reasons, conclusion,
      windows: [...new Set(allCompared.map((/** @type {any} */ item) => `${item.periodStart}/${item.periodEnd}`))] };
  });
}

/** @param {Record<string, any>} snapshot */
function scheduling(snapshot) {
  const events = list(snapshot.events).map(object); const plan = object(snapshot.plan); const approvals = list(snapshot.approvals);
  const approved = approvals.some((item) => item.planId === plan.id || item.planRevision === plan.id || item.status === 'approved');
  const connectionEvent = events.filter((event) => ['schedule_connected', 'schedule_disconnected'].includes(event.type) && (!event.planId || event.planId === plan.id)
    && (!snapshot.manifest?.approvalId || !event.approvalId || event.approvalId === snapshot.manifest.approvalId)).at(-1);
  const connected = connectionEvent?.type === 'schedule_connected' ? connectionEvent : null;
  const stopped = object(snapshot.manifest).status === 'approved' ? null : events.filter((event) => event.type === 'collection_stopped' && (!event.planId || event.planId === plan.id)).at(-1);
  const occurrences = events.filter((event) => ['occurrence_claimed', 'occurrence_completed', 'occurrence_missed'].includes(event.type));
  const last = occurrences.at(-1);
  const latestSuccess = [...occurrences].reverse().find((/** @type {any} */ event) => event.type === 'occurrence_completed' && event.status === 'completed');
  const current = snapshot.schedulerStatus;
  const isConnected = current ? current.connected : Boolean(connected);
  return { configured: Boolean(plan.collection), approved, connected: isConnected, connectedKind: isConnected ? connected?.kind ?? null : null,
    lastSuccess: latestSuccess?.finishedAt ?? null,
    lastAttempt: last?.attemptedAt ?? null, missed: occurrences.filter((event) => event.type === 'occurrence_missed' || event.status === 'missed').length,
    stopped: Boolean(stopped), stoppedAt: stopped?.stoppedAt ?? null, status: stopped ? 'stopped' : !approved ? 'awaiting_approval' : current && !current.connected ? current.status : !connected ? 'configured_disconnected' : last?.type === 'occurrence_missed' ? 'missed' : 'connected' };
}

/** @param {Record<string, any>} snapshot */
export function deriveStudyReport(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('Study snapshot is required');
  const studyId = id(snapshot.studyId ?? object(snapshot.manifest).studyId, 'study');
  const appId = id(snapshot.appId ?? object(snapshot.plan).app?.id, 'app');
  const angles = angleFacts(snapshot); const versionFacts = list(snapshot.versions).map((version) => ({ id: version.id, status: version.status, pageId: version.pageId, capturedAt: version.capturedAt ?? null, publishedAt: version.publishedAt ?? null })); const exposure = [...list(snapshot.searchRuns), ...list(snapshot.researchRuns)].flatMap((run) => list(object(run).exposures ?? object(run.bundle).exposures ?? object(run.evidence).exposures));
  const business = businessFacts(snapshot); const schedule = scheduling(snapshot);
  const analyses = list(snapshot.analyses); const analyzedOccurrences = new Set(analyses.flatMap((analysis) => list(analysis.occurrenceIds ?? (analysis.occurrenceId ? [analysis.occurrenceId] : [])))); const dueByOccurrence = new Map(); for (const event of list(snapshot.events)) if (event.analysisDue === true && event.occurrenceId) dueByOccurrence.set(event.occurrenceId, event); const due = [...dueByOccurrence.values()].filter((event) => !analyzedOccurrences.has(event.occurrenceId));
  const summary = { angleCount: angles.length, searchRequests: angles.reduce((sum, angle) => sum + angle.searchRequests, 0), recommendationObservations: angles.reduce((sum, angle) => sum + angle.recommendationObservations, 0), diagnosticRequests: angles.reduce((sum, angle) => sum + angle.diagnosticRequests, 0), businessComparisons: business.length, analysisDue: due.length };
  const reportId = hash({ studyId, plan: snapshot.plan, angles, versionFacts, exposure, business, schedule, analyses }).slice(0, 24);
  const lines = [`# Website study report`, ``, `Study: ${md(studyId)} · App: ${md(appId)}`, ``, `Search requests are reported separately from independent recommendation observations. URL matches do not establish revision exposure or Google indexing.`, ``, `## Summary`, ``, `- Angles: ${summary.angleCount}`, `- Search requests attempted: ${summary.searchRequests}`, `- Diagnostic requests: ${summary.diagnosticRequests}`, `- Independent recommendation observations: ${summary.recommendationObservations}`, `- Business comparisons: ${summary.businessComparisons}`, `- Analyses due: ${summary.analysisDue}`, ``, `## Versions`, ``, ...(versionFacts.length ? versionFacts.map((version) => `- ${md(version.id)}: ${md(version.status)}${version.publishedAt ? ` · published ${md(version.publishedAt)}` : ''}.`) : ['- No page versions saved.']), ``, `## Angles`, ``];
  for (const angle of angles) {
    lines.push(`- ${md(angle.label)}: ${angle.searchPresence.found}/${angle.searchPresence.completed} completed searches found the website; ${angle.searchRequests} planned requests; ${angle.recommendationObservations} eligible recommendation observations.`);
    for (const [route, metric] of Object.entries(angle.recommendationRates.route)) lines.push(`  - ${md(route)}: ${metric.positive}/${metric.observations} eligible answers recommended the product.`);
    for (const question of angle.questions) lines.push(`  - ${md(question.text)}: ${question.searchPresence.found}/${question.searchPresence.completed} completed searches found the website.`);
  }
  lines.push('', '## Exposure', '');
  if (exposure.length) for (const item of exposure) lines.push(`- ${md(item.status ?? 'unknown')}: ${md(item.url ?? '')}`);
  else lines.push('- No revision exposure records are saved.');
  lines.push('', '## Business outcomes', '');
  if (!business.length) lines.push('- No linked business outcomes are saved; visibility cannot establish leads or sales.');
  else for (const item of business) lines.push(`- ${md(item.metric)} (${md(item.unit)}): ${item.comparable ? 'comparison recorded; causal claim still requires assignment evidence' : 'inconclusive (missing denominator, low sample, mismatched traffic, or missing phase)'}.`);
  lines.push('', '## Scheduling', '', `- Status: ${schedule.status}; connected: ${schedule.connected ? schedule.connectedKind : 'no'}; last success: ${schedule.lastSuccess ?? 'none'}; missed: ${schedule.missed}.`);
  lines.push('', '## Assistant review', '');
  const latestAnalysis = analyses.at(-1);
  if (latestAnalysis) lines.push(`Recommendation: ${md(latestAnalysis.recommendation)}`, '', `Reason: ${md(latestAnalysis.reason)}`, '', `Next action: ${md(latestAnalysis.nextAction)}`, '', `Evidence: ${list(latestAnalysis.evidenceIds).map(md).join(', ') || 'none supplied'}.`);
  else lines.push('Assistant analysis has not been saved. Review the collected receipts before choosing a page change.');
  if (summary.analysisDue) lines.push('', `${summary.analysisDue} collection occurrence${summary.analysisDue === 1 ? '' : 's'} still require assistant analysis.`);
  return { version: 1, id: reportId, studyId, appId, summary, versions: versionFacts, angles, exposure, business, scheduling: schedule, analysis: { records: analyses, due }, markdown: lines.join('\n') };
}
