import { listEvidenceIntents } from '../../core/evidence-report.js';
import { listMeasurementSeries, resolveMeasurementSeries } from '../../core/metrics.js';
import { deriveOpportunityCandidates, listOpportunities } from '../../core/opportunities.js';
import { compareIntervention } from '../../core/intervention-comparison.js';
import { emptyState, html, layout, raw, SURFACE_LABEL } from '../layout.js';
import { listResearchActions } from '../../core/research-store.js';
import { researchActionCards } from './research.js';

/** @param {string|null} value */
function positiveInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** @param {string|null} value */
function utcTime(value) {
  return value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

/** @param {ReturnType<typeof buildView>} view @param {Record<string, string|number|null>} [patch] */
function selectionUrl(view, patch = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    days: view.days, series_id: view.series?.id ?? null, start: view.series?.start ?? null,
    end: view.series?.end ?? null, intent_id: view.intentId, ...patch,
  })) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  return `/opportunities?${params}`;
}

/** @param {import('./index.js').PageDeps} deps @param {URLSearchParams} params */
export function buildView({ db }, params) {
  const now = new Date();
  const requestedDays = positiveInt(params.get('days'));
  const days = requestedDays !== null && requestedDays <= 3650 ? requestedDays : 30;
  const requestedStart = utcTime(params.get('start'));
  const requestedEnd = utcTime(params.get('end'));
  const exactRange = requestedStart && requestedEnd && requestedStart < requestedEnd
    ? { start: requestedStart, end: requestedEnd } : {};
  const seriesOptions = listMeasurementSeries(db, { now, days, ...exactRange });
  const requestedSeriesId = params.get('series_id');
  const series = requestedSeriesId
    ? seriesOptions.find((item) => item.id === requestedSeriesId) ?? null
    : resolveMeasurementSeries(db, { now, days, ...exactRange });
  const intents = series ? listEvidenceIntents(db, { series }) : [];
  const requestedIntentId = positiveInt(params.get('intent_id'));
  const intentId = requestedIntentId !== null && intents.some((intent) => intent.id === requestedIntentId)
    ? requestedIntentId : intents[0]?.id ?? null;
  const candidates = series && intentId !== null
    ? deriveOpportunityCandidates(db, { series, intentId }) : [];
  const opportunities = series ? listOpportunities(db, { series, includeDismissed: true }) : [];
  const selected = opportunities.filter((item) => intentId === null || item.intentId === intentId);
  const comparisonPlanId = positiveInt(params.get('comparison_plan_id'));
  const comparisonSnapshotId = positiveInt(params.get('comparison_snapshot_id'));
  const requestedMode = params.get('comparison_mode');
  /** @type {Map<number, ReturnType<typeof compareIntervention>>} */
  const comparisons = new Map();
  for (const item of selected) {
    for (const plan of item.followUpPlans ?? []) {
      for (const snapshot of plan.reviewSnapshots ?? []) {
        const mode = plan.id === comparisonPlanId && snapshot.id === comparisonSnapshotId
          && requestedMode === 'common_subset' ? 'common_subset' : 'full_benchmark';
        comparisons.set(snapshot.id, compareIntervention(db, { opportunityId: item.id,
          planId: plan.id, snapshotId: snapshot.id, mode }));
      }
    }
  }
  return {
    researchActions: listResearchActions(db),
    days, seriesOptions, series, intents, intentId, candidates, opportunities: selected,
    comparisons, comparisonPlanId, comparisonSnapshotId,
    prefill: {
      responseIds: params.get('response_ids') ?? '', queryIds: params.get('query_ids') ?? '',
      sourceIds: params.get('source_ids') ?? '', citationIds: params.get('citation_ids') ?? '',
    },
  };
}

/** @param {ReturnType<typeof buildView>} view */
function selector(view) {
  return html`<form class="card opportunity-filters" method="get" action="/opportunities">
    <label><span>Measurement series</span><select name="series_id" required>
      ${view.seriesOptions.map((item) => html`<option value="${item.id}"${item.id === view.series?.id ? raw(' selected') : ''}>
        ${SURFACE_LABEL[item.surface] ?? item.surface} · ${item.searchPolicy ?? 'legacy'} · ${item.comparableAnswers} comparable
      </option>`)}
    </select></label>
    <label><span>Buyer intent</span><select name="intent_id">
      ${view.intents.map((item) => html`<option value="${item.id}"${item.id === view.intentId ? raw(' selected') : ''}>${item.label ?? `Intent #${item.id}`}</option>`)}
    </select></label>
    <label><span>Window</span><select name="days">
      ${[7, 30, 90, 365].map((count) => html`<option value="${count}"${count === view.days ? raw(' selected') : ''}>${count} days</option>`)}
    </select></label>
    <button type="submit" class="btn">Show opportunities</button>
  </form>`;
}

/** @param {ReturnType<typeof buildView>} view */
function selectionFields(view) {
  return html`<input type="hidden" name="series_id" value="${view.series?.id}" />
    <input type="hidden" name="start" value="${view.series?.start}" />
    <input type="hidden" name="end" value="${view.series?.end}" />
    <input type="hidden" name="intent_id" value="${view.intentId}" />`;
}

/** @param {string} type */
function candidateLabel(type) {
  return ({ source_without_brand: 'Source without brand', query_theme: 'Buyer search theme',
    negative_brand_statement: 'Negative brand statement',
    uncertain_brand_statement: 'Uncertain brand statement' })[type] ?? type;
}

/** @param {ReturnType<typeof buildView>} view @param {{responseIds:number[],queryIds:number[],sourceIds:number[],citationIds:number[],stanceReviews?:{responseId:number,mentionId:number,interpretationId:number,correctionId:number|null,stance:string}[]}} evidence */
function support(view, evidence) {
  const receipts = evidence.responseIds ?? [];
  return html`<details class="opportunity-support"><summary>${receipts.length} answer receipt${receipts.length === 1 ? '' : 's'} and record IDs</summary>
    ${receipts.length ? html`<ul>${receipts.map((id) => html`<li><a href="/evidence?${new URLSearchParams({
      series_id: view.series?.id ?? '', start: view.series?.start ?? '', end: view.series?.end ?? '',
      intent_id: String(view.intentId ?? ''), layer: 'answers', receipt_id: String(id), days: String(view.days),
    })}#receipt-${id}">Answer receipt #${id}</a></li>`)}</ul>` : html`<p>No answer receipt is attached.</p>`}
    <p class="muted small">Query IDs: ${(evidence.queryIds ?? []).join(', ') || 'none'} · Source observation IDs: ${(evidence.sourceIds ?? []).join(', ') || 'none'} · Citation IDs: ${(evidence.citationIds ?? []).join(', ') || 'none'}</p>
    ${evidence.stanceReviews?.length ? html`<p class="muted small">Stance review receipts: ${evidence.stanceReviews.map((item) => `answer #${item.responseId}, mention #${item.mentionId}, interpretation #${item.interpretationId}, correction #${item.correctionId ?? 'none'}, ${item.stance}`).join(' · ')}</p>` : ''}
  </details>`;
}

/** @param {ReturnType<typeof buildView>} view */
function candidateSection(view) {
  const available = view.candidates.filter((item) => !item.existingOpportunityId || item.newResponseIds?.length);
  return html`<section class="card">
    <div class="opportunity-section-head"><div><h2>Observed patterns to review</h2>
      <p class="muted">Repeated source and query-theme patterns need two comparable answer receipts from two completed runs in this exact selection. Explicit negative or uncertain statements can appear from one completed answer. The threshold helps triage; it does not measure importance. Save only the investigations you want to review.</p></div>
    </div>
    ${available.length ? html`<div class="opportunity-list">${available.map((item) => html`<article class="opportunity-preview">
      <div class="opportunity-topline"><span class="tag">${candidateLabel(item.candidateType)}</span><span class="muted small">${item.support.responseCount} answers across ${item.support.completedRunCount} runs</span></div>
      <h3>${item.observedFinding}</h3>
      <p class="muted">Suggested next step: investigate. Check the source and page before planning a change.</p>
      ${support(view, item.evidence)}
      ${item.existingOpportunityId && item.newResponseIds?.length ? html`<p class="muted small">New since the previous review: response #${item.newResponseIds.join(', #')}. ${item.resurfacedExplanation ?? ''}</p>` : ''}
      <form data-api-form="/api/opportunities/generate" class="opportunity-save">
        ${selectionFields(view)}<input type="hidden" name="candidate_key" value="${item.candidateKey}" />
        <button type="submit" class="btn btn-sm">Save this investigation</button>
        <p class="form-error" data-form-error role="alert" hidden></p>
      </form>
    </article>`)}</div>` : html`<p class="muted">No new pattern qualifies for this selection. You can create an investigation from a single receipt below.</p>`}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view */
function manualForm(view) {
  return html`<section class="card"><h2>Create an investigation from selected evidence</h2>
    <p class="muted">Use the links on <a href="/evidence?${new URLSearchParams({
      series_id: view.series?.id ?? '', start: view.series?.start ?? '', end: view.series?.end ?? '',
      intent_id: String(view.intentId ?? ''), days: String(view.days),
    })}">the evidence report</a> to prefill IDs. Every record must belong to this exact series, intent, and window. A model leaving a capability out does not show that a page lacks it.</p>
    <form data-api-form="/api/opportunities" class="opportunity-form">
      ${selectionFields(view)}
      <div class="opportunity-form-grid">
        <label><span>Answer receipt IDs</span><input name="response_ids" data-list value="${view.prefill.responseIds}" placeholder="42, 51" required /></label>
        <label><span>Observed query IDs</span><input name="query_ids" data-list value="${view.prefill.queryIds}" placeholder="Optional" /></label>
        <label><span>Source observation IDs</span><input name="source_ids" data-list value="${view.prefill.sourceIds}" placeholder="Optional" /></label>
        <label><span>Final-answer citation IDs</span><input name="citation_ids" data-list value="${view.prefill.citationIds}" placeholder="Optional" /></label>
        <label><span>Buyer relevance</span><input name="buyer_relevance" maxlength="240" placeholder="Why this matters to the selected buyer intent" /></label>
        <label><span>Product area</span><input name="product_area" maxlength="160" placeholder="Optional" /></label>
        <label><span>Target URL</span><input name="target_url" type="url" placeholder="Optional" /></label>
        <label><span>Controllability</span><select name="controllability"><option value="product">Product</option><option value="owned">Owned page</option><option value="third_party">Third party</option></select></label>
        <label><span>Effort</span><select name="effort_band"><option value="unknown">Unknown</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      </div>
      <label><span>Interpretation or hypothesis</span><textarea name="hypothesis" rows="2" maxlength="2000" placeholder="Your interpretation, separate from the observed evidence"></textarea></label>
      <label><span>Possible action</span><textarea name="suggested_action" rows="2" maxlength="2000" placeholder="Investigate the answer or source; specific page changes need reviewed page evidence"></textarea></label>
      <label class="check"><input name="claimed_false_or_outdated" type="checkbox" /><span>The answer may contain a false or outdated claim that needs authoritative evidence</span></label>
      <button type="submit" class="btn">Save investigation</button>
      <p class="form-error" data-form-error role="alert" hidden></p>
    </form>
  </section>`;
}

/** @param {number|null} rate */
function percentage(rate) { return rate === null ? 'unavailable' : `${(rate * 100).toFixed(1)}%`; }

/** @param {number|null} value */
function pointChange(value) {
  return value === null ? 'unavailable' : `${value > 0 ? '+' : ''}${value.toFixed(1)} percentage points`;
}

/** @param {ReturnType<typeof compareIntervention>['metric']['before']} side @param {string} label */
function metricRows(side, label) {
  return html`<tr><th scope="row">${label}</th><td>${side.hits}/${side.n} answers</td>
    <td>${side.observedPromptCount}/${side.promptCount} prompts</td><td>${percentage(side.rate)}</td></tr>`;
}

/** @param {ReturnType<typeof compareIntervention>['coverage']['before']} side @param {string} label */
function coverageRows(side, label) {
  return html`<tr><th scope="row">${label}</th>
    <td>${side.targetCoverageKnown ? `${side.attemptedTargets} targets, ${side.failedTargets} failed, ${side.incompleteTargets} incomplete` : 'target attempts unavailable'}</td>
    <td>${side.comparableAnswers} answers</td>
    <td>${side.queryMetadataAvailable} available, ${side.queryMetadataUnavailable} unavailable, ${side.queryMetadataNotApplicable} other (${percentage(side.queryMetadataAvailableRate)})</td>
    <td>${side.answersWithSourceObservations}/${side.comparableAnswers} (${percentage(side.sourceObservationCoverageRate)})</td>
    <td>${side.answersWithAnswerCitations}/${side.comparableAnswers} (${percentage(side.citationCoverageRate)})</td></tr>`;
}

/** @param {string} key */
function layerLabel(key) {
  if (!key.startsWith('[')) return key;
  try {
    const [provenance, url] = JSON.parse(key);
    return `${url} (${provenance})`;
  } catch { return key; }
}

/** @param {ReturnType<typeof compareIntervention>} report @param {'queries'|'sources'|'citations'} layer @param {string} label */
function changedLayer(report, layer, label) {
  const rows = report.changes[layer];
  return html`<details class="opportunity-layer-changes"><summary>${label} (${rows.length} distinct)</summary>
    ${rows.length ? html`<div class="opportunity-table-scroll"><table><thead><tr><th scope="col">Observed ${label.toLowerCase()}</th><th scope="col">Baseline</th><th scope="col">Review</th><th scope="col">Receipt IDs</th></tr></thead>
      <tbody>${rows.map((row) => html`<tr><th scope="row">${layerLabel(row.key)}</th>
        <td>${row.beforeResponses} answers (${percentage(row.beforeIncidenceRate)})</td>
        <td>${row.afterResponses} answers (${percentage(row.afterIncidenceRate)})</td>
        <td>Before: ${row.beforeResponseIds.join(', ') || 'none'} · after: ${row.afterResponseIds.join(', ') || 'none'}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No ${label.toLowerCase()} in the selected answers.</p>`}
  </details>`;
}

/** @param {ReturnType<typeof compareIntervention>} report */
function comparisonReport(report) {
  const status = ({ incomparable: 'Incomparable', insufficient_data: 'Insufficient data',
    observed_increase: 'Observed increase', observed_decrease: 'Observed decrease',
    observed_no_difference: 'No observed difference' })[report.status] ?? report.status;
  return html`<div class="opportunity-comparison-report">
    <p><strong>${status}</strong> · ${report.metric.id.replaceAll('_', ' ')} · ${report.selectionMode === 'common_subset' ? 'explicit common subset' : 'full saved benchmark'} · ${pointChange(report.metric.deltaPercentagePoints)}</p>
    <p class="muted small">Baseline ${report.scope.baseline.start} to ${report.scope.baseline.end} UTC; review ${report.scope.review.start} to ${report.scope.review.end} UTC. Both end times are exclusive. Data cutoffs: ${report.scope.baseline.dataCutoff} and ${report.scope.review.dataCutoff}.</p>
    <p class="muted small">Series ${report.scope.seriesId} · benchmark ${report.scope.benchmarkRevisionId ?? 'legacy'} · profile ${report.scope.executionProfileId ?? 'legacy'} · selected prompts ${report.scope.selectedPromptIds.length}/${report.scope.expectedPromptIds.length}</p>
    ${report.reasons.length ? html`<div class="opportunity-report-notes"><strong>Comparability reasons</strong><ul>${report.reasons.map((reason) => html`<li>${reason}</li>`)}</ul></div>` : ''}
    ${report.warnings.length ? html`<div class="opportunity-report-notes"><strong>Review warnings</strong><ul>${report.warnings.map((warning) => html`<li>${warning}</li>`)}</ul></div>` : ''}
    ${report.scope.droppedCells.length ? html`<p class="opportunity-warning">Dropped prompt cells: ${report.scope.droppedCells.map((cell) => `#${cell.promptId} (baseline ${cell.baselineHasAnswer ? 'present' : 'missing'}, review ${cell.reviewHasAnswer ? 'present' : 'missing'})`).join('; ')}</p>` : ''}
    ${report.scope.missingCells.length ? html`<p class="opportunity-warning">Missing selected prompt cells: ${report.scope.missingCells.map((cell) => `#${cell.promptId}`).join(', ')}</p>` : ''}
    <div class="opportunity-table-scroll"><table><caption>Primary metric, equal prompt weighting</caption><thead><tr><th scope="col">Window</th><th scope="col">Answer hits</th><th scope="col">Prompts observed</th><th scope="col">Mean prompt rate</th></tr></thead><tbody>
      ${metricRows(report.metric.before, 'Baseline')}${metricRows(report.metric.after, 'Review')}
    </tbody></table></div>
    <details><summary>Per-prompt counts and Wilson intervals</summary>
      <p class="muted small">${report.metric.intervalMeaning}</p>
      <div class="opportunity-table-scroll"><table><thead><tr><th scope="col">Prompt ID</th><th scope="col">Baseline</th><th scope="col">Review</th></tr></thead><tbody>
        ${report.metric.before.perPrompt.map((before) => {
          const after = report.metric.after.perPrompt.find((cell) => cell.promptId === before.promptId);
          return html`<tr><th scope="row">#${before.promptId}</th>
            <td>${before.hits}/${before.n} · ${percentage(before.rate)} · Wilson ${percentage(before.interval.lo)} to ${percentage(before.interval.hi)}</td>
            <td>${after ? html`${after.hits}/${after.n} · ${percentage(after.rate)} · Wilson ${percentage(after.interval.lo)} to ${percentage(after.interval.hi)}` : 'unavailable'}</td></tr>`;
        })}</tbody></table></div>
    </details>
    ${report.comparison ? html`<details><summary>Optional comparison intents</summary>
      <p class="muted small">The user selected intent IDs ${report.scope.comparisonIntentIds.join(', ')} as an unchanged reference. Hearsay cannot verify that assumption.</p>
      <div class="opportunity-table-scroll"><table><thead><tr><th scope="col">Window</th><th scope="col">Answer hits</th><th scope="col">Prompts observed</th><th scope="col">Mean prompt rate</th></tr></thead><tbody>
        ${metricRows(report.comparison.before, 'Baseline')}${metricRows(report.comparison.after, 'Review')}
      </tbody></table></div>
    </details>` : ''}
    <details><summary>Capture and metadata coverage</summary><div class="opportunity-table-scroll"><table><thead><tr><th scope="col">Window</th><th scope="col">Targets</th><th scope="col">Comparable answers</th><th scope="col">Query metadata</th><th scope="col">Source observations</th><th scope="col">Answer citations</th></tr></thead><tbody>
      ${coverageRows(report.coverage.before, 'Baseline')}${coverageRows(report.coverage.after, 'Review')}
    </tbody></table></div></details>
    ${changedLayer(report, 'queries', 'Queries')}${changedLayer(report, 'sources', 'Sources')}${changedLayer(report, 'citations', 'Citations')}
    ${report.confounders.length ? html`<details><summary>Other shipped actions (${report.confounders.length})</summary><ul>${report.confounders.map((action) => html`<li>Opportunity #${action.opportunityId} · intent #${action.intentId} · shipped ${action.shippedAt} · ${action.target} · ${action.changeDescription}</li>`)}</ul></details>` : ''}
    <p class="muted">${report.interpretation}</p>
  </div>`;
}

/** @param {ReturnType<typeof buildView>} view @param {ReturnType<typeof listOpportunities>[number]} item */
function followUpSection(view, item) {
  const plans = item.followUpPlans ?? [];
  const latest = plans.at(-1);
  const canPlan = ['planned', 'in_progress', 'shipped', 'reviewed'].includes(item.status);
  const comparisonSelected = plans.some((plan) => plan.id === view.comparisonPlanId
    && plan.reviewSnapshots.some((snapshot) => snapshot.id === view.comparisonSnapshotId));
  return html`<details${comparisonSelected ? raw(' open') : ''}><summary>Follow-up plans (${plans.length})</summary>
    <p class="muted">Select the question and baseline before shipping when possible. Saving or capturing a plan only uses stored observations. It does not start a run, publish a change, or edit a schedule.</p>
    <p class="muted">If you need more observations, <a href="/settings">review the run estimate and preview an on-demand run in Settings</a>. Starting that run requires a separate confirmation.</p>
    ${latest ? html`<p class="muted">A revised plan creates a new version. Earlier baselines, dates, and review snapshots remain in the history above.</p>` : ''}
    ${plans.map((plan) => html`<article class="opportunity-follow-up">
      <h4>Plan v${plan.version} · ${plan.primaryMetric.replaceAll('_', ' ')} · ${plan.expectedDirection}</h4>
      <p class="muted small">Baseline ${plan.baseline.windowStart} to ${plan.baseline.windowEnd} UTC, end exclusive · ${plan.baseline.answers.length} saved answers · captured ${plan.baseline.capturedAt}</p>
      <p class="muted small">Series ${plan.baseline.series.id} · benchmark ${plan.baseline.series.benchmarkRevisionId ?? 'legacy'} · profile ${plan.baseline.series.executionProfileId ?? 'legacy'}</p>
      <p>Intent IDs: ${plan.intentIds.join(', ')}${plan.comparisonIntentIds.length ? html` · comparison intents: ${plan.comparisonIntentIds.join(', ')}` : ''}</p>
      <p>Review window: ${plan.reviewWindow.start} to ${plan.reviewWindow.end} UTC, end exclusive · observation delay ${plan.reviewWindow.observationDelayDays} day${plan.reviewWindow.observationDelayDays === 1 ? '' : 's'}</p>
      ${plan.retrospective ? html`<p class="opportunity-warning">Retrospective baseline and metric selection. Interpret changes with care.</p>` : ''}
      ${plan.baselineAfterPublication ? html`<p class="opportunity-warning">The baseline window includes time after the recorded ship time.</p>` : ''}
      ${plan.reviewSnapshots.length ? html`<details${comparisonSelected && plan.id === view.comparisonPlanId ? raw(' open') : ''}><summary>Saved review snapshots (${plan.reviewSnapshots.length})</summary>
        ${plan.reviewSnapshots.map((snapshot) => {
          const report = view.comparisons.get(snapshot.id);
          if (!report) return '';
          const reviews = (item.interventionReviews ?? []).filter((review) => review.snapshotId === snapshot.id);
          return html`<article class="opportunity-snapshot" id="opportunity-snapshot-${snapshot.id}">
            <h5>Captured ${snapshot.capturedAt}</h5>
            <p class="muted small">${snapshot.windowStart} to ${snapshot.windowEnd} UTC, end exclusive · ${snapshot.answers.length} saved answers${snapshot.partialWindow ? html` · <span class="opportunity-warning">review window was still open</span>` : ''}</p>
            ${snapshot.seriesChanges.length ? html`<details><summary>Series variants seen during the review window (${snapshot.seriesChanges.length})</summary><ul>${snapshot.seriesChanges.map((/** @type {{count:number,surface:string,model:string,benchmarkRevisionId:string|null,executionProfileId:string|null,analysisRevision:string|null,searchPolicy:string|null}} */ series) => html`<li>${series.count} target${series.count === 1 ? '' : 's'} · ${series.surface} · model ${series.model} · benchmark ${series.benchmarkRevisionId ?? 'legacy'} · profile ${series.executionProfileId ?? 'legacy'} · analysis ${series.analysisRevision ?? 'legacy'} · policy ${series.searchPolicy ?? 'legacy'}${series.executionProfileId !== plan.baseline.series.executionProfileId || series.benchmarkRevisionId !== plan.baseline.series.benchmarkRevisionId ? html` <strong class="opportunity-warning">Profile or benchmark differs from baseline</strong>` : ''}</li>`)}</ul></details>` : ''}
            <nav class="opportunity-comparison-modes" aria-label="Comparison selection for snapshot ${snapshot.id}">
              <a href="${selectionUrl(view, { comparison_plan_id: plan.id, comparison_snapshot_id: snapshot.id, comparison_mode: 'full_benchmark' })}#opportunity-snapshot-${snapshot.id}"${report.selectionMode === 'full_benchmark' ? raw(' aria-current="page"') : ''}>Full saved benchmark</a>
              <a href="${selectionUrl(view, { comparison_plan_id: plan.id, comparison_snapshot_id: snapshot.id, comparison_mode: 'common_subset' })}#opportunity-snapshot-${snapshot.id}"${report.selectionMode === 'common_subset' ? raw(' aria-current="page"') : ''}>Common prompt subset</a>
            </nav>
            ${comparisonReport(report)}
            ${reviews.length ? html`<details><summary>Human reviews (${reviews.length})</summary><ul>${reviews.map((review) => html`<li>${review.createdAt} · ${review.author} · ${review.judgment.replaceAll('_', ' ')} · ${review.selectionMode.replaceAll('_', ' ')} · ${review.report.status.replaceAll('_', ' ')}<blockquote>${review.rationale}</blockquote></li>`)}</ul></details>` : ''}
            ${['shipped', 'reviewed'].includes(item.status) && plan.id === latest?.id ? html`<form data-api-form="/api/opportunities/${item.id}/follow-up/${plan.id}/reviews/${snapshot.id}" class="opportunity-form">
              <input type="hidden" name="expected_version" value="${item.recordVersion}" />
              <input type="hidden" name="mode" value="${report.selectionMode}" />
              <label><span>Your judgment</span><select name="judgment" required><option value="">Choose a judgment</option><option value="promising">Promising</option><option value="not_useful">Not useful</option><option value="inconclusive">Inconclusive</option></select></label>
              <label><span>Rationale</span><textarea name="rationale" rows="3" maxlength="4000" required placeholder="Explain what the saved observations do and do not support"></textarea></label>
              <p class="muted small">Your review records a judgment about these observations. It does not prove that the shipped action caused a change.</p>
              <button type="submit" class="btn btn-sm">Save human review</button>
              <p class="form-error" data-form-error role="alert" hidden></p>
            </form>` : ''}
          </article>`;
        })}
      </details>` : html`<p class="muted small">No review snapshot captured yet.</p>`}
      ${['shipped', 'reviewed'].includes(item.status) && plan.id === plans.at(-1)?.id ? html`<form data-api-form="/api/opportunities/${item.id}/follow-up/${plan.id}/capture" class="opportunity-form">
        <input type="hidden" name="expected_version" value="${item.recordVersion}" />
        <button type="submit" class="btn btn-sm">Capture stored review observations</button>
        <p class="form-error" data-form-error role="alert" hidden></p>
      </form>` : ''}
    </article>`)}
    ${canPlan ? html`<form data-api-form="/api/opportunities/${item.id}/follow-up" class="opportunity-form">
      <input type="hidden" name="expected_version" value="${item.recordVersion}" />
      <div class="opportunity-form-grid">
        <label><span>Primary metric</span><select name="primary_metric" required>
          ${[['brand_mention_rate', 'Brand mention rate'], ['positive_stance_rate', 'Positive stance rate'], ['answer_citation_rate', 'Answer citation rate']].map(([value, label]) => html`<option value="${value}"${(latest?.primaryMetric ?? 'brand_mention_rate') === value ? raw(' selected') : ''}>${label}</option>`)}
        </select></label>
        <label><span>Expected direction</span><select name="expected_direction" required>
          ${[['increase', 'Increase'], ['decrease', 'Decrease'], ['hold', 'Hold steady']].map(([value, label]) => html`<option value="${value}"${(latest?.expectedDirection ?? 'increase') === value ? raw(' selected') : ''}>${label}</option>`)}
        </select></label>
        <label><span>Buyer intent IDs</span><input name="intent_ids" data-list value="${latest?.intentIds.join(', ') ?? item.intentId}" placeholder="1, 2" required /></label>
        <label><span>Comparison intent IDs, optional</span><input name="comparison_intent_ids" data-list value="${latest?.comparisonIntentIds.join(', ') ?? ''}" placeholder="3, 4" /></label>
        <label><span>Baseline start, UTC</span><input name="baseline_start" value="${latest?.baseline.windowStart ?? item.windowStart}" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" required /></label>
        <label><span>Baseline end, UTC, exclusive</span><input name="baseline_end" value="${latest?.baseline.windowEnd ?? item.windowEnd}" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" required /></label>
        <label><span>Review start, UTC</span><input name="review_start" value="${latest?.reviewWindow.start ?? ''}" placeholder="2026-10-01T00:00:00Z" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" required /></label>
        <label><span>Review end, UTC, exclusive</span><input name="review_end" value="${latest?.reviewWindow.end ?? ''}" placeholder="2026-10-15T00:00:00Z" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" required /></label>
        <label><span>Observation delay, days</span><input name="observation_delay_days" type="number" min="0" max="180" step="1" value="${latest?.reviewWindow.observationDelayDays ?? 0}" required /></label>
      </div>
      <button type="submit" class="btn">${latest ? 'Save revised plan' : 'Save follow-up plan'}</button>
      <p class="form-error" data-form-error role="alert" hidden></p>
    </form>` : html`<p class="muted">Accept and plan the action before setting a follow-up question.</p>`}
  </details>`;
}

/** @param {string} current */
function availableStatuses(current) {
  const transitions = {
    pending: ['investigate', 'planned', 'dismissed', 'no_action'],
    investigate: ['investigate', 'planned', 'dismissed', 'no_action'],
    planned: ['planned', 'in_progress', 'shipped', 'investigate', 'dismissed', 'no_action'],
    in_progress: ['in_progress', 'planned', 'shipped', 'dismissed', 'no_action'],
    shipped: ['shipped'], reviewed: ['reviewed'],
    dismissed: ['dismissed', 'investigate'], no_action: ['no_action', 'investigate'],
  };
  return /** @type {Record<string,string[]>} */ (transitions)[current] ?? [current];
}

/** @param {ReturnType<typeof buildView>} view @param {ReturnType<typeof listOpportunities>[number]} item */
function opportunityCard(view, item) {
  const evidence = item.evidence ?? { responseIds: [], queryIds: [], sourceIds: [], citationIds: [] };
  const pageEvidence = item.pageEvidence ?? [];
  const reviewedPage = pageEvidence.some((entry) => entry.reviewedAt);
  const otherItems = view.opportunities.filter((other) => other.id !== item.id && other.status !== 'dismissed');
  return html`<article class="card opportunity-card" id="opportunity-${item.id}">
    <div class="opportunity-topline"><span class="tag">${item.status}</span>
      <span class="muted small">#${item.id} · ${item.origin} · ${item.createdAt}</span></div>
    <h3>${item.observedFinding}</h3>
    <p class="muted small">${item.candidateType ?? 'manual selection'} · benchmark ${item.benchmarkRevisionId ?? 'legacy'} · ${item.windowStart} to ${item.windowEnd} UTC, end exclusive</p>
    ${item.buyerRelevance ? html`<p><strong>Buyer relevance:</strong> ${item.buyerRelevance}</p>` : ''}
    ${item.hypothesis ? html`<p><strong>${item.origin === 'assistant' ? 'Assistant hypothesis' : 'Hypothesis'}:</strong> ${item.hypothesis}</p>` : ''}
    ${item.suggestedAction ? html`<p><strong>Possible action (${item.actionKind ?? 'investigate'}):</strong> ${item.suggestedAction}</p>` : ''}
    ${item.targetUrl || item.productArea ? html`<p class="muted">Target: ${item.targetUrl ?? item.productArea}</p>` : ''}
    ${item.owner || item.reviewDate ? html`<p class="muted">Owner: ${item.owner ?? 'unassigned'} · review date: ${item.reviewDate ?? 'unset'}</p>` : ''}
    ${item.estimatedEffortHours !== null || item.actualEffortHours !== null ? html`<p class="muted">Effort: estimated ${item.estimatedEffortHours ?? 'unset'} hours · actual ${item.actualEffortHours ?? 'unset'} hours</p>` : ''}
    ${item.shippedAt ? html`<p><strong>Shipped ${item.shippedAt}:</strong> ${item.changeDescription}</p>` : ''}
    ${item.claimClassification ? html`<p class="muted">Claim handling: ${item.claimClassification}</p>` : ''}
    ${item.missingEvidence?.length ? html`<p class="muted">Still needed: ${item.missingEvidence.join('; ')}</p>` : ''}
    ${item.staleEvidence ? html`<p class="form-error">Some linked evidence is missing. Recheck the receipt before review.</p>` : ''}
    ${item.resurfacedExplanation ? html`<p class="muted">Resurfaced because ${item.resurfacedExplanation}</p>` : ''}
    ${support(view, evidence)}
    <div class="opportunity-review-grid">
      ${item.status === 'combined' ? '' : html`<details><summary>Review and prioritize</summary>
        <form data-api-form="/api/opportunities/${item.id}" data-method="PATCH" class="opportunity-form">
          <input type="hidden" name="expected_version" value="${item.recordVersion}" />
          <div class="opportunity-form-grid">
            <label><span>Outcome</span><select name="status">
              ${availableStatuses(item.status).map((status) => html`<option value="${status}"${item.status === status ? raw(' selected') : ''}>${status.replace('_', ' ')}</option>`)}
            </select></label>
            <label><span>User priority</span><select name="priority">
              ${[[0, 'Unset'], [3, 'High'], [2, 'Medium'], [1, 'Low']].map(([value, label]) => html`<option value="${value}"${item.priority === value ? raw(' selected') : ''}>${label}</option>`)}
            </select></label>
            <label><span>Effort</span><select name="effort_band">
              ${['unknown', 'low', 'medium', 'high'].map((effort) => html`<option value="${effort}"${item.effortBand === effort ? raw(' selected') : ''}>${effort}</option>`)}
            </select></label>
            <label><span>Owner</span><input name="owner" value="${item.owner ?? ''}" maxlength="120" data-include-empty /></label>
            <label><span>Review date</span><input name="review_date" type="date" value="${item.reviewDate ?? ''}" data-include-empty /></label>
            <label><span>Estimated effort, hours</span><input name="estimated_effort_hours" type="number" min="0" max="100000" step="0.25" value="${item.estimatedEffortHours ?? ''}" data-include-empty /></label>
            <label><span>Actual effort, hours</span><input name="actual_effort_hours" type="number" min="0" max="100000" step="0.25" value="${item.actualEffortHours ?? ''}" data-include-empty /></label>
            <label><span>Target URL</span><input name="target_url" type="url" value="${item.targetUrl ?? ''}" data-include-empty /></label>
            <label><span>Product area</span><input name="product_area" value="${item.productArea ?? ''}" maxlength="160" data-include-empty /></label>
            <label><span>Action type</span><select name="action_kind">
              ${[['investigate', 'Investigate'], ['page_change', 'Specific page change'], ['other', 'Other action']].map(([value, label]) => html`<option value="${value}"${(item.actionKind ?? 'investigate') === value ? raw(' selected') : ''}>${label}</option>`)}
            </select></label>
            <label><span>Controllability</span><select name="controllability">
              ${['product', 'owned', 'third_party'].map((value) => html`<option value="${value}"${item.controllability === value ? raw(' selected') : ''}>${value.replace('_', ' ')}</option>`)}
            </select></label>
          </div>
          <label><span>Hypothesis</span><textarea name="hypothesis" rows="2" maxlength="2000" data-include-empty>${item.hypothesis ?? ''}</textarea></label>
          <label><span>Possible action</span><textarea name="suggested_action" rows="2" maxlength="2000" data-include-empty>${item.suggestedAction ?? ''}</textarea></label>
          <label><span>Shipped change description</span><textarea name="change_description" rows="2" maxlength="2000" data-include-empty placeholder="What changed on the target page or feature">${item.changeDescription ?? ''}</textarea></label>
          <label><span>Shipped at, UTC</span><input name="shipped_at" value="${item.shippedAt ?? ''}" placeholder="2026-09-25T12:00:00Z" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" data-include-empty /></label>
          <label><span>Reason when dismissing or choosing no action</span><textarea name="dismissal_reason" rows="2" maxlength="1000" data-include-empty>${item.dismissalReason ?? ''}</textarea></label>
          ${item.origin === 'assistant' && item.status === 'pending' ? html`<p class="muted">Accepting this assistant proposal is a separate human review. It does not publish or start a run.</p>` : ''}
          ${!reviewedPage ? html`<p class="muted">For a specific page change, attach and review page evidence first. The next step remains an investigation until then.</p>` : ''}
          <p class="muted">Mark shipped only after the change exists. Record what changed, its UTC time, and its target. Saving this status does not publish a change, start a paid run, or change a schedule.</p>
          <button type="submit" class="btn">Save review</button>
          <p class="form-error" data-form-error role="alert" hidden></p>
        </form>
      </details>`}
      ${followUpSection(view, item)}
      <details><summary>Page evidence (${pageEvidence.length})</summary>
        <p class="muted">A manual excerpt records what you or an assistant supplied. It is separate from provider-observed retrieval.</p>
        ${pageEvidence.map((entry) => html`<div class="opportunity-page-evidence">
          <p>${entry.url} · ${entry.observedAt} · ${entry.provenance}${entry.isAuthoritative ? html` · user marked authoritative` : ''}${entry.reviewedAt ? html` · reviewed ${entry.reviewedAt}` : ''}</p>
          <blockquote>${entry.excerpt}</blockquote>
          ${entry.reviewedAt ? '' : html`<form data-api-form="/api/opportunities/${item.id}/page-evidence/${entry.id}/review">
            <input type="hidden" name="expected_version" value="${item.recordVersion}" />
            <input type="hidden" name="reviewed" value="true" data-bool />
            <button type="submit" class="btn btn-sm">I reviewed this excerpt</button>
            <p class="form-error" data-form-error role="alert" hidden></p>
          </form>`}
        </div>`)}
        <form data-api-form="/api/opportunities/${item.id}/page-evidence" class="opportunity-form">
          <input type="hidden" name="expected_version" value="${item.recordVersion}" />
          <label><span>Page URL</span><input name="url" type="url" required /></label>
          <label><span>Observation time, UTC</span><input name="observed_at" type="text" placeholder="2026-09-25T12:00:00Z" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" required /></label>
          <label><span>Source</span><select name="provenance"><option value="manual_user">I supplied the excerpt</option><option value="manual_assistant">Assistant supplied the excerpt</option><option value="observed_fetch">Already observed fetch</option></select></label>
          <label class="check"><input name="is_authoritative" type="checkbox" /><span>I assert this user-supplied excerpt is authoritative for the claim</span></label>
          <label><span>Observed fetch source ID, if selected</span><input name="source_observation_id" type="number" min="1" placeholder="For observed fetch only" /></label>
          <label><span>Bounded excerpt</span><textarea name="excerpt" rows="3" maxlength="2000" required></textarea></label>
          <button type="submit" class="btn btn-sm">Attach page evidence</button>
          <p class="form-error" data-form-error role="alert" hidden></p>
        </form>
      </details>
      ${otherItems.length ? html`<details><summary>Combine with another opportunity</summary>
        <p class="muted">The selected record is combined into this one. Its receipts and review history remain linked.</p>
        ${otherItems.map((other) => html`<form data-api-form="/api/opportunities/${item.id}/combine" class="opportunity-combine-form">
          <input type="hidden" name="expected_version" value="${item.recordVersion}" />
          <input type="hidden" name="source_expected_version" value="${other.recordVersion}" />
          <input type="hidden" name="source_id" value="${other.id}" />
          <span>#${other.id} · ${other.observedFinding}</span>
          <button type="submit" class="btn btn-sm">Combine</button>
          <p class="form-error" data-form-error role="alert" hidden></p>
        </form>`)}
      </details>` : ''}
    </div>
    ${item.events?.length ? html`<details class="opportunity-history"><summary>Review history (${item.events.length})</summary>
      <ul>${item.events.map((entry) => html`<li>${entry.createdAt} · ${entry.eventType} · ${entry.author}${entry.details.status ? html` · ${entry.details.status}` : ''}${entry.details.reviewDate ? html` · review date ${entry.details.reviewDate}` : ''}${entry.details.shippedAt ? html` · shipped ${entry.details.shippedAt}` : ''}${entry.details.changeDescription ? html` · ${entry.details.changeDescription}` : ''}${entry.eventType === 'combined_source' ? html` · source opportunity #${entry.details.sourceId}` : ''}${entry.eventType === 'combined' ? html` · combined into #${entry.details.targetId}` : ''}</li>`)}</ul>
    </details>` : ''}
  </article>`;
}

/** @param {import('../layout.js').ShellCtx} ctx @param {ReturnType<typeof buildView>} view */
export function render(ctx, view) {
  let body = html`<p class="muted">Review observed evidence, choose a next step, and record who owns it. These entries are hypotheses and decisions, not claims about how an engine ranks pages.</p>${researchActionCards(view.researchActions ?? [])}${selector(view)}`;
  if (!view.series || view.intentId === null) {
    body = html`${body}${emptyState({ title: 'No evidence for this selection',
      line: 'Choose a measurement series and buyer intent with completed comparable answers.',
      hint: 'Opportunities become available after a panel run stores answer receipts.' })}`;
  } else {
    const pending = view.opportunities.filter((item) => item.status === 'pending');
    const active = view.opportunities.filter((item) => !['pending', 'dismissed', 'no_action', 'combined'].includes(item.status));
    const closed = view.opportunities.filter((item) => ['dismissed', 'no_action', 'combined'].includes(item.status));
    body = html`${body}
      <p class="muted opportunity-scope">Exact series ${view.series.id} · ${SURFACE_LABEL[view.series.surface] ?? view.series.surface} · benchmark ${view.series.benchmarkRevisionId ?? 'legacy'} · ${view.series.start} to ${view.series.end} UTC, end exclusive</p>
      ${candidateSection(view)}
      ${pending.length ? html`<section aria-label="Pending assistant proposals"><h2>Pending assistant proposals</h2>
        <p class="muted">These are assistant-authored hypotheses. Review and accept one before it joins the shortlist.</p>
        ${pending.map((item) => opportunityCard(view, item))}
      </section>` : ''}
      <section aria-label="Opportunity shortlist"><h2>Shortlist</h2>
        <p class="muted">Order follows user priority, then effort and recent activity. No hidden score is used.</p>
        ${active.length ? active.map((item) => opportunityCard(view, item)) : html`<p class="card">No saved opportunities for this intent and window.</p>`}
      </section>
      ${manualForm(view)}
      ${closed.length ? html`<details class="card"><summary>Dismissed, combined, or no action (${closed.length})</summary>
        ${closed.map((item) => opportunityCard(view, item))}
      </details>` : ''}`;
  }
  return layout({ title: 'Opportunities', active: '/opportunities', ctx, body });
}
