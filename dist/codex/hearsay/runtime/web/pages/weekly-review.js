import { buildWeeklyReview, listKnownWeeklySeries, WeeklyReviewError } from '../../core/weekly-review.js';
import { html, layout, raw, SURFACE_LABEL } from '../layout.js';
import { listActionOutcomeTargets, standaloneWeeklySummary } from '../queries.js';

const WEEK_MS = 7 * 86_400_000;

/** @param {ReturnType<typeof buildWeeklyReview>} report @param {{intentId:number,windowStart:string,windowEnd:string,researchId?:number,provenance?:string}} item */
function opportunityLink(report, item) {
  if (item.provenance === 'external' && item.researchId) {
    return `/research?id=${encodeURIComponent(String(item.researchId))}`;
  }
  const params = new URLSearchParams({ series_id: report.scope.series.id,
    start: item.windowStart, end: item.windowEnd, intent_id: String(item.intentId) });
  return `/opportunities?${params}`;
}

/** @param {ReturnType<typeof buildWeeklyReview>} report @param {{responseId:number,researchId?:number,provenance?:string}} item */
function evidenceLink(report, item) {
  if (item.provenance === 'external' && item.researchId) {
    return `/research?id=${encodeURIComponent(String(item.researchId))}`;
  }
  const params = new URLSearchParams({ series_id: report.scope.series.id,
    start: report.scope.start, end: report.scope.end, layer: 'answers',
    receipt_id: String(item.responseId) });
  return `/evidence?${params}`;
}

/** @param {ReturnType<typeof listKnownWeeklySeries>[number]} series */
function optionLabel(series) {
  if (series.sourceKind === 'standalone_research') {
    return `${series.sourceLabel} · ${series.appName} (${series.runId}) · ${series.lastAt}`;
  }
  if (series.sourceKind === 'standalone_study') {
    return `${series.sourceLabel} · ${series.appName} (study ${series.studyId}) · ${series.lastAt}`;
  }
  return `${SURFACE_LABEL[series.surface] ?? series.surface} · ${series.lastAt} · ${series.id.slice(0, 12)}`;
}

/** @param {import('./index.js').PageDeps} deps @param {URLSearchParams} params */
export function buildView({ db }, params) {
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const end = params.get('end') ?? now;
  const endMs = Date.parse(end);
  const start = params.get('start') ?? (Number.isFinite(endMs)
    ? new Date(endMs - WEEK_MS).toISOString().slice(0, 19) + 'Z' : '');
  const seriesOptions = listKnownWeeklySeries(db);
  const summary = standaloneWeeklySummary(db);
  const actionTargets = listActionOutcomeTargets(db);
  const explicitSeriesId = params.get('series_id');
  const seriesId = explicitSeriesId !== null
    ? explicitSeriesId
    : (!summary.hasNativeSeries && seriesOptions.length > 0 ? seriesOptions[0].id : '');
  let report = null;
  let error = null;
  if (seriesId) {
    try { report = buildWeeklyReview(db, { seriesId, start, end, now }); }
    catch (caught) {
      if (!(caught instanceof WeeklyReviewError)) throw caught;
      error = caught.message;
    }
  }
  return { seriesOptions, seriesId, start, end, report, error, actionTargets };
}

/** @param {ReturnType<typeof buildView>} view */
function selector(view) {
  return html`<form class="card weekly-selector" method="get" action="/weekly-review">
    <label><span>Measurement or research source</span><select name="series_id" required>
      ${view.seriesOptions.map((series) => html`<option value="${series.id}"${series.id === view.seriesId ? raw(' selected') : ''}>
        ${optionLabel(series)}
      </option>`)}
    </select></label>
    <label><span>Week starts (UTC)</span><input name="start" value="${view.start}" required /></label>
    <label><span>Week ends (UTC, exclusive)</span><input name="end" value="${view.end}" required /></label>
    <button class="btn" type="submit">Show this week</button>
  </form>`;
}

/** @param {{page:string|null,baseline:string|null,post:string|null,signedDelta:string|null}} arm */
function renderArmCell(arm) {
  const pageHint = arm.page ? html`<br /><span class="muted small">${arm.page}</span>` : '';
  if (arm.baseline !== null && arm.post !== null) {
    return html`<strong>${arm.baseline} → ${arm.post}</strong> (${arm.signedDelta})${pageHint}`;
  }
  if (arm.post !== null) {
    return html`<strong>${arm.post}</strong> in week (no baseline)${pageHint}`;
  }
  if (arm.baseline !== null) {
    return html`Baseline ${arm.baseline} (no post-change record)${pageHint}`;
  }
  return html`<span class="muted">Not recorded</span>${pageHint}`;
}

/** @param {ReturnType<typeof buildWeeklyReview>} report */
function controlledComparisonSection(report) {
  const groups = report.controlledPageComparisons ?? [];
  if (!groups.length) return '';
  return html`<section class="card weekly-controlled-comparison" style="min-width:0"><h2>Changed vs. control page comparison</h2>
    ${groups.map((group) => html`<div class="weekly-comparison-group">
      <h3>${group.label}${group.shippedAt ? html` <span class="muted small">· shipped ${group.shippedAt}</span>` : ''}</h3>
      <div class="opportunity-table-scroll"><table>
        <thead><tr>
          <th scope="col">Metric</th>
          <th scope="col">Changed page</th>
          <th scope="col">Unchanged control page</th>
          <th scope="col">Difference-in-change</th>
        </tr></thead>
        <tbody>${group.items.map((item) => html`<tr>
          <th scope="row">${item.metricName} <span class="muted small">(${item.currency ? `${item.unit} ${item.currency}` : item.unit})</span></th>
          <td>${renderArmCell(item.changed)}</td>
          <td>${renderArmCell(item.control)}</td>
          <td>${item.signedDifferenceInChange !== null
            ? html`<strong>${item.signedDifferenceInChange}</strong>`
            : item.signedWindowDifference !== null
              ? html`${item.signedWindowDifference} <span class="muted small">(review window only)</span>`
              : html`<span class="muted">Needs baseline + control</span>`}</td>
        </tr>`)}</tbody>
      </table></div>
      ${group.items.flatMap((item) => item.warnings).length
        ? html`<ul class="muted small">${[...new Set(group.items.flatMap((item) => item.warnings))].map((warning) => html`<li>${warning}</li>`)}</ul>`
        : ''}
    </div>`)}
    <p class="muted small">${report.controlPageNote}</p>
  </section>`;
}

/** @param {ReturnType<typeof buildWeeklyReview>} report */
function reviewBody(report) {
  const { scope, coverage, standaloneResearch: sr, standaloneStudy: ss } = report;
  const isExternal = scope.provenance === 'external';
  return html`<div class="weekly-report" style="grid-template-columns:minmax(0,1fr)">
    <section class="card weekly-scope"><h2>Selected scope</h2>
      ${isExternal
        ? html`<p><strong>${scope.visibilitySource}</strong> · ${sr ? `${sr.appName} (${sr.runId})` : ss ? `${ss.appName} (study ${ss.studyId})` : scope.series.id} · ${scope.start} to ${scope.end} UTC (end exclusive)</p>
          <p class="muted small">Source ${scope.series.id} · external provenance · panel ${scope.series.benchmarkRevisionId ?? 'n/a'} · execution ${scope.series.executionProfileId ?? 'n/a'} · analysis ${scope.series.analysisRevision ?? 'n/a'} · never blended into native tracking rates</p>`
        : html`<p><strong>${SURFACE_LABEL[scope.series.surface] ?? scope.series.surface}</strong> · ${scope.start} to ${scope.end} UTC (end exclusive)</p>
          <p class="muted small">Series ${scope.series.id} · profile ${scope.series.executionProfileId ?? 'legacy'} · benchmark ${scope.series.benchmarkRevisionId ?? 'legacy'} · analysis ${scope.series.analysisRevision ?? 'legacy'} · search ${scope.series.searchPolicy ?? 'legacy'}</p>`}
      <p class="muted small">Generated ${scope.generatedAt}. This is a saved-data report; viewing it starts no measurement run.</p>
    </section>
    <section class="card"><h2>${isExternal ? 'Standalone audit sample & eligibility' : 'Collection health'}</h2>
      ${sr
        ? html`<p><strong>${sr.totals.eligible}/${sr.totals.attempted}</strong> attempted standalone samples met independent eligibility (${sr.totals.planned} planned · ${sr.totals.completed} completed · ${sr.totals.mentioned}/${sr.totals.eligible} eligible mentioned · ${sr.totals.recommended}/${sr.totals.eligible} eligible recommended).</p>
          ${sr.citationGaps.domains.length ? html`<p class="muted small">Top external domains when ${sr.appName} was absent: ${sr.citationGaps.domains.map((d) => `${d.domain} (${d.sampleCount})`).join(', ')}.</p>` : ''}`
        : ss
          ? html`<p><strong>${ss.summary.recommendationObservations}</strong> independent recommendation observations and <strong>${ss.summary.searchRequests}</strong> search requests recorded in study <a href="/research?study_id=${ss.studyRowId}">${ss.studyId}</a>.</p>`
          : html`<p><strong>${coverage.comparableAnswers}/${coverage.attemptedTargets}</strong> attempted targets produced comparable answers. ${coverage.queryMetadataAnswers}/${coverage.comparableAnswers} comparable answers have query metadata.</p>`}
      ${report.health.length ? html`<ul>${report.health.map((message) => html`<li>${message}</li>`)}</ul>`
        : html`<p>No collection issue detected in this selected week.</p>`}
    </section>
    <section class="card"><h2>Important evidence</h2>
      ${report.importantEvidence.length ? html`<ol>${report.importantEvidence.map((item) => html`<li><strong><a href="${evidenceLink(report, item)}">${item.sampleId ? `Sample ${item.sampleId}` : `Answer #${item.responseId}`}</a></strong> · ${item.reason}<br />
        ${item.question}<br /><span class="muted small">${item.answerExcerpt}</span><br />
        <span class="muted small">Query IDs ${item.queryIds.join(', ') || 'none'} · source IDs ${item.sourceIds.join(', ') || 'none'} · citation IDs ${item.citationIds.join(', ') || 'none'}</span></li>`)}</ol>`
        : html`<p>No comparable answer evidence was saved in this week.</p>`}
    </section>
    <div class="weekly-columns">
      <section class="card"><h2>Priorities</h2>
        ${report.opportunities.length ? html`<ol>${report.opportunities.map((item) => html`<li><a href="${opportunityLink(report, item)}">${item.provenance === 'external' ? `Proposal ${item.actionId ?? `#${item.id}`}` : `Opportunity #${item.id}`}</a>: ${item.suggestedAction || item.observedFinding}<br />
          <span class="muted small">Priority ${item.priority} · ${item.status} · owner ${item.owner ?? 'unassigned'} · review ${item.reviewDate ?? 'not set'}</span></li>`)}</ol>`
          : report.citationGaps?.domains.length
            ? html`<div class="weekly-citation-gap">
                <p><strong>${report.citationGaps.actionHeadline}</strong></p>
                <p class="muted small">${report.citationGaps.brandAbsentSamples}/${report.citationGaps.completedSamples} completed answers omitted your site. Top cited external domains:</p>
                <ul>${report.citationGaps.domains.map((d) => html`<li><strong>${d.domain}</strong> · ${d.sampleCount} answer${d.sampleCount === 1 ? '' : 's'}${d.finalCitationCount ? ` (${d.finalCitationCount} final citation${d.finalCitationCount === 1 ? '' : 's'})` : ''}</li>`)}</ul>
                <p class="muted small">${report.citationGaps.nextStepStatus} ${sr ? html`<a href="/research?id=${sr.researchId}">Inspect standalone receipts</a>` : ss ? html`<a href="/research?study_id=${ss.studyRowId}">Inspect study report</a>` : html`<a href="/opportunities?series_id=${encodeURIComponent(scope.series.id)}&start=${encodeURIComponent(scope.start)}&end=${encodeURIComponent(scope.end)}">Review in Opportunities</a>`}.</p>
              </div>`
            : isExternal && report.citationGaps?.decision === 'hold_steady'
              ? html`<p><strong>${report.citationGaps.actionHeadline}</strong></p><p class="muted small">${report.citationGaps.nextStepStatus}</p>`
              : html`<p>No active priority was saved for this series.</p>`}
      </section>
      <section class="card"><h2>Due shipped actions</h2>
        ${report.dueReviews.length ? html`<ul>${report.dueReviews.map((item) => html`<li><a href="${opportunityLink(report, item)}">Opportunity #${item.id}</a> · review due ${item.reviewWindowEnd ?? item.reviewDate ?? 'now'}<br />${item.changeDescription ?? 'Saved shipped action'}</li>`)}</ul>`
          : html`<p>No shipped action is due for review.</p>`}
      </section>
    </div>
    ${report.actionState === 'nothing_requires_action' ? html`<section class="card weekly-no-action"><h2>Nothing requires action</h2><p>The selected week has no collection issue or due action. Continue the planned measurement cadence.</p></section>` : ''}
    <section class="card"><h2>Saved descriptive changes</h2>
      ${report.descriptiveChanges.length ? html`<ul>${report.descriptiveChanges.map((item) => html`<li>Opportunity #${item.opportunityId}: ${item.status.replaceAll('_', ' ')} · human judgment ${item.judgment}. ${item.rationale}</li>`)}</ul>`
        : html`<p>No intervention review was saved in this week.</p>`}
    </section>
    ${controlledComparisonSection(report)}
    <div class="weekly-columns">
      <section class="card"><h2>Reported business outcomes</h2>
        <p class="muted small">${report.reportedDataScope}.</p>
        ${report.reportedOutcomes.length ? html`<ul>${report.reportedOutcomes.map((item) => html`<li><strong>${item.metricName}: ${item.value} ${item.unit}${item.currency ? ` ${item.currency}` : ''}</strong> · ${item.source}<br />
          <span class="muted small">${item.periodStart} to ${item.periodEnd} · attribution ${item.attributionMethod}${item.landingPage ? ` · page ${item.landingPage}` : ''}${item.pageRole ? ` (${item.pageRole})` : ''}${item.interventionId ? ` · action ${item.interventionId}` : ''}${item.opportunityId ? ` · opportunity #${item.opportunityId}` : ''}${item.comparisonPage ? ` · control ${item.comparisonPage}` : ''}${item.hasOverlap ? ` · overlaps record IDs ${item.overlapIds.join(', ')}` : ''}</span></li>`)}</ul>`
          : html`<p>Business outcomes not recorded.</p>`}
      </section>
      <section class="card"><h2>Costs and time</h2>
        <p>${report.measurementSpend.attemptedCalls
    ? `Computed API spend: ${report.measurementSpend.costStatus}; known subtotal ${report.measurementSpend.knownSubtotalUsd === null ? 'unavailable' : `$${report.measurementSpend.knownSubtotalUsd}`}; ${report.measurementSpend.unknownCalls} attempted calls have unknown cost.`
    : 'No API calls or dollar spend recorded for this selected series and week.'}</p>
        ${report.reportedLedger.length ? html`<ul>${report.reportedLedger.map((item) => html`<li>${item.kind === 'time' ? `${item.minutes ?? 'unknown'} minutes` : `${item.amount ?? 'unknown'} ${item.currency ?? ''}`} · ${item.activity} · ${item.source}</li>`)}</ul>`
          : html`<p>User expenses and time not recorded.</p>`}
        <p class="muted small">${report.subscriptionAllowance}</p>
      </section>
    </div>
    <p class="muted weekly-interpretation">${report.interpretation}</p>
  </div>`;
}

/** @param {ReturnType<typeof buildWeeklyReview>} report */
export function renderWeeklyReviewExport(report) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hearsay weekly review</title><style>
    body{font:16px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#171717}
    .card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}
    .weekly-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}
    table{width:100%;border-collapse:collapse;margin:.5rem 0}
    th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid #ddd;vertical-align:top}
    .muted{color:#555}.small{font-size:.875rem}li{margin:.5rem 0}p{overflow-wrap:anywhere}
    </style></head><body><h1>Hearsay weekly review</h1>${reviewBody(report)}</body></html>`.value;
}

/** @param {ReturnType<typeof buildView>} view */
function entryForms(view) {
  const actionListId = 'weekly-intervention-ids';
  return html`<section class="card"><h2>Record a reported outcome</h2>
    <p class="muted">Enter a source record and attribution method. Link an action and mark changed vs. control pages to compare period drift without a causal claim.</p>
    <form class="weekly-entry-form" data-api-form="/api/outcomes">
      <div class="weekly-form-grid">
        <label>Source<input name="source" required placeholder="Analytics export" /></label>
        <label>Stable record ID<input name="record_key" required placeholder="Source row ID" /></label>
        <label>Period start UTC<input name="period_start" required value="${view.start}" /></label>
        <label>Period end UTC<input name="period_end" required value="${view.end}" /></label>
        <label>Metric<input name="metric_name" required placeholder="Qualified signups" /></label>
        <label>Value<input name="value" required inputmode="decimal" placeholder="12" /></label>
        <label>Unit<input name="unit" required placeholder="count" /></label>
        <label>Currency, if monetary<input name="currency" placeholder="USD" /></label>
        <label>Landing page<input name="landing_page" placeholder="https://example.com/pricing" /></label>
        <label>Page role<select name="page_role">
          <option value="">Unassigned</option>
          <option value="changed">Changed page</option>
          <option value="control">Unchanged control page</option>
        </select></label>
        <label>Action / intervention ID<input name="intervention_id" list="${actionListId}" placeholder="Optional, e.g. pricing-v2" /></label>
        <label>Linked opportunity<select name="opportunity_id">
          <option value="">None</option>
          ${view.actionTargets.opportunities.map((opp) => html`<option value="${opp.id}">#${opp.id} · ${opp.label.slice(0, 60)}</option>`)}
        </select></label>
        <label>Paired control page URL<input name="comparison_page" placeholder="Optional control URL" /></label>
        <label>Attribution method<input name="attribution_method" required placeholder="Directly reported by analytics" /></label>
        <label>Corrects outcome row ID<input name="supersedes_id" inputmode="numeric" placeholder="Optional" /></label>
        <label>Author<input name="author" required placeholder="Your name" /></label>
      </div>
      ${view.actionTargets.interventionIds.length ? html`<datalist id="${actionListId}">${view.actionTargets.interventionIds.map((id) => html`<option value="${id}"></option>`)}</datalist>` : ''}
      <label>Notes<textarea name="notes" rows="2"></textarea></label>
      <button class="btn" type="submit">Save outcome</button><p class="form-error" data-form-error role="alert" hidden></p>
    </form>
  </section>
  <section class="card"><h2>Import outcome CSV</h2>
    <p class="muted">Use an explicit source and import ID. Optional trailing columns <code>intervention_id</code>, <code>opportunity_id</code>, <code>page_role</code>, and <code>comparison_page</code> link rows to changed vs. control pages.</p>
    <form class="weekly-entry-form" data-api-form="/api/outcomes/import">
      <div class="weekly-form-grid"><label>Source<input name="source" required /></label>
      <label>Import ID<input name="import_id" required /></label><label>Author<input name="author" required /></label></div>
      <label>CSV text<textarea name="csv_text" rows="5" required data-preserve-whitespace placeholder="record_id, period_start, period_end, landing_page, metric_name, value, unit, currency, attribution_method, notes, supersedes_id"></textarea></label>
      <button class="btn" type="submit">Import CSV</button><p class="form-error" data-form-error role="alert" hidden></p>
    </form>
  </section>
  <section class="card"><h2>Record time or expense</h2>
    <form class="weekly-entry-form" data-api-form="/api/ledger">
      <div class="weekly-form-grid"><label>Source<input name="source" required /></label>
      <label>Stable entry ID<input name="entry_key" required /></label>
      <label>Kind<select name="kind"><option value="time">Time</option><option value="expense">Expense</option></select></label>
      <label>Activity<input name="activity" required placeholder="Content review" /></label>
      <label>Period start UTC<input name="period_start" required value="${view.start}" /></label>
      <label>Period end UTC<input name="period_end" required value="${view.end}" /></label>
      <label>Minutes, if time<input name="minutes" inputmode="numeric" /></label>
      <label>Amount, if expense<input name="amount" inputmode="decimal" /></label>
      <label>Currency, if expense<input name="currency" placeholder="USD" /></label>
      <label>Author<input name="author" required /></label></div>
      <label>Notes<textarea name="notes" rows="2"></textarea></label>
      <button class="btn" type="submit">Save entry</button><p class="form-error" data-form-error role="alert" hidden></p>
    </form>
  </section>`;
}

/** @param {import('../layout.js').ShellCtx} ctx @param {ReturnType<typeof buildView>} view */
export function render(ctx, view) {
  const selection = new URLSearchParams({ series_id: view.seriesId, start: view.start, end: view.end });
  /** @param {'markdown'|'json'|'html'} format */
  const download = (format) => `/api/weekly-review/export?${selection}&format=${format}`;
  return layout({ title: 'Weekly review', active: '/weekly-review', ctx,
    body: html`<p class="muted">Review one exact seven-day UTC window from saved measurements, standalone research audits, work records, and user-reported outcomes.</p>
      ${selector(view)}
      ${view.error ? html`<section class="card" role="alert"><h2>Review unavailable</h2><p>${view.error}</p></section>` : ''}
      ${view.report ? html`<div class="weekly-exports"><a class="btn btn-sm" href="${download('markdown')}">Download Markdown</a>
        <a class="btn btn-sm" href="${download('json')}">Download JSON</a>
        <a class="btn btn-sm" href="${download('html')}">Download HTML</a>
        <a class="btn btn-sm" href="/api/outcomes/export?start=${view.start}&end=${view.end}">Download outcome CSV</a></div>
        ${reviewBody(view.report)}` : !view.error ? html`<section class="card"><h2>${view.seriesOptions.length ? 'Choose a measurement series' : 'No measurement series yet'}</h2><p>${view.seriesOptions.length ? 'Select a saved series or standalone research audit above to generate a review.' : 'Run a tracking measurement or import a standalone research bundle before selecting a weekly review.'}</p></section>` : ''}
      ${entryForms(view)}` });
}
