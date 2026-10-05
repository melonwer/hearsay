import { buildWeeklyReview, listKnownWeeklySeries, WeeklyReviewError } from '../../core/weekly-review.js';
import { html, layout, raw, SURFACE_LABEL } from '../layout.js';

const WEEK_MS = 7 * 86_400_000;

/** @param {ReturnType<typeof buildWeeklyReview>} report @param {{intentId:number,windowStart:string,windowEnd:string}} item */
function opportunityLink(report, item) {
  const params = new URLSearchParams({ series_id: report.scope.series.id,
    start: item.windowStart, end: item.windowEnd, intent_id: String(item.intentId) });
  return `/opportunities?${params}`;
}

/** @param {ReturnType<typeof buildWeeklyReview>} report @param {{responseId:number}} item */
function evidenceLink(report, item) {
  const params = new URLSearchParams({ series_id: report.scope.series.id,
    start: report.scope.start, end: report.scope.end, layer: 'answers',
    receipt_id: String(item.responseId) });
  return `/evidence?${params}`;
}

/** @param {import('./index.js').PageDeps} deps @param {URLSearchParams} params */
export function buildView({ db }, params) {
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const end = params.get('end') ?? now;
  const endMs = Date.parse(end);
  const start = params.get('start') ?? (Number.isFinite(endMs)
    ? new Date(endMs - WEEK_MS).toISOString().slice(0, 19) + 'Z' : '');
  const seriesOptions = listKnownWeeklySeries(db);
  const seriesId = params.get('series_id') ?? '';
  let report = null;
  let error = null;
  if (seriesId) {
    try { report = buildWeeklyReview(db, { seriesId, start, end, now }); }
    catch (caught) {
      if (!(caught instanceof WeeklyReviewError)) throw caught;
      error = caught.message;
    }
  }
  return { seriesOptions, seriesId, start, end, report, error };
}

/** @param {ReturnType<typeof buildView>} view */
function selector(view) {
  return html`<form class="card weekly-selector" method="get" action="/weekly-review">
    <label><span>Measurement series</span><select name="series_id" required>
      ${view.seriesOptions.map((series) => html`<option value="${series.id}"${series.id === view.seriesId ? raw(' selected') : ''}>
        ${SURFACE_LABEL[series.surface] ?? series.surface} · ${series.lastAt} · ${series.id.slice(0, 12)}
      </option>`)}
    </select></label>
    <label><span>Week starts (UTC)</span><input name="start" value="${view.start}" required /></label>
    <label><span>Week ends (UTC, exclusive)</span><input name="end" value="${view.end}" required /></label>
    <button class="btn" type="submit">Show this week</button>
  </form>`;
}

/** @param {ReturnType<typeof buildWeeklyReview>} report */
function reviewBody(report) {
  const { scope, coverage } = report;
  return html`<div class="weekly-report">
    <section class="card weekly-scope"><h2>Selected scope</h2>
      <p><strong>${SURFACE_LABEL[scope.series.surface] ?? scope.series.surface}</strong> · ${scope.start} to ${scope.end} UTC (end exclusive)</p>
      <p class="muted small">Series ${scope.series.id} · profile ${scope.series.executionProfileId ?? 'legacy'} · benchmark ${scope.series.benchmarkRevisionId ?? 'legacy'} · analysis ${scope.series.analysisRevision ?? 'legacy'} · search ${scope.series.searchPolicy ?? 'legacy'}</p>
      <p class="muted small">Generated ${scope.generatedAt}. This is a saved-data report; viewing it starts no measurement run.</p>
    </section>
    <section class="card"><h2>Collection health</h2>
      <p><strong>${coverage.comparableAnswers}/${coverage.attemptedTargets}</strong> attempted targets produced comparable answers. ${coverage.queryMetadataAnswers}/${coverage.comparableAnswers} comparable answers have query metadata.</p>
      ${report.health.length ? html`<ul>${report.health.map((message) => html`<li>${message}</li>`)}</ul>`
        : html`<p>No collection issue detected in this selected week.</p>`}
    </section>
    <section class="card"><h2>Important evidence</h2>
      ${report.importantEvidence.length ? html`<ol>${report.importantEvidence.map((item) => html`<li><strong><a href="${evidenceLink(report, item)}">Answer #${item.responseId}</a></strong> · ${item.reason}<br />
        ${item.question}<br /><span class="muted small">${item.answerExcerpt}</span><br />
        <span class="muted small">Query IDs ${item.queryIds.join(', ') || 'none'} · source IDs ${item.sourceIds.join(', ') || 'none'} · citation IDs ${item.citationIds.join(', ') || 'none'}</span></li>`)}</ol>`
        : html`<p>No comparable answer evidence was saved in this week.</p>`}
    </section>
    <div class="weekly-columns">
      <section class="card"><h2>Priorities</h2>
        ${report.opportunities.length ? html`<ol>${report.opportunities.map((item) => html`<li><a href="${opportunityLink(report, item)}">Opportunity #${item.id}</a>: ${item.suggestedAction || item.observedFinding}<br />
          <span class="muted small">Priority ${item.priority} · ${item.status} · owner ${item.owner ?? 'unassigned'} · review ${item.reviewDate ?? 'not set'}</span></li>`)}</ol>`
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
    <div class="weekly-columns">
      <section class="card"><h2>Reported business outcomes</h2>
        <p class="muted small">${report.reportedDataScope}.</p>
        ${report.reportedOutcomes.length ? html`<ul>${report.reportedOutcomes.map((item) => html`<li><strong>${item.metricName}: ${item.value} ${item.unit}${item.currency ? ` ${item.currency}` : ''}</strong> · ${item.source}<br />
          <span class="muted small">${item.periodStart} to ${item.periodEnd} · attribution ${item.attributionMethod}${item.hasOverlap ? ` · overlaps record IDs ${item.overlapIds.join(', ')}` : ''}</span></li>`)}</ul>`
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
    .muted{color:#555}.small{font-size:.875rem}li{margin:.5rem 0}p{overflow-wrap:anywhere}
    </style></head><body><h1>Hearsay weekly review</h1>${reviewBody(report)}</body></html>`.value;
}

/** @param {ReturnType<typeof buildView>} view */
function entryForms(view) {
  return html`<section class="card"><h2>Record a reported outcome</h2>
    <p class="muted">Enter a source record and attribution method. Outcomes appear beside visibility observations without a causal claim.</p>
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
        <label>Landing page<input name="landing_page" placeholder="Optional" /></label>
        <label>Attribution method<input name="attribution_method" required placeholder="Directly reported by analytics" /></label>
        <label>Corrects outcome row ID<input name="supersedes_id" inputmode="numeric" placeholder="Optional" /></label>
        <label>Author<input name="author" required placeholder="Your name" /></label>
      </div>
      <label>Notes<textarea name="notes" rows="2"></textarea></label>
      <button class="btn" type="submit">Save outcome</button><p class="form-error" data-form-error role="alert" hidden></p>
    </form>
  </section>
  <section class="card"><h2>Import outcome CSV</h2>
    <p class="muted">Use an explicit source and import ID. Repeating the same import is safe; changed content under the same ID is rejected.</p>
    <form class="weekly-entry-form" data-api-form="/api/outcomes/import">
      <div class="weekly-form-grid"><label>Source<input name="source" required /></label>
      <label>Import ID<input name="import_id" required /></label><label>Author<input name="author" required /></label></div>
      <label>CSV text<textarea name="csv_text" rows="5" required data-preserve-whitespace placeholder="record_id,period_start,period_end,landing_page,metric_name,value,unit,currency,attribution_method,notes,supersedes_id"></textarea></label>
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
    body: html`<p class="muted">Review one exact seven-day UTC window from saved measurements, work records, and user-reported outcomes.</p>
      ${selector(view)}
      ${view.error ? html`<section class="card" role="alert"><h2>Review unavailable</h2><p>${view.error}</p></section>` : ''}
      ${view.report ? html`<div class="weekly-exports"><a class="btn btn-sm" href="${download('markdown')}">Download Markdown</a>
        <a class="btn btn-sm" href="${download('json')}">Download JSON</a>
        <a class="btn btn-sm" href="${download('html')}">Download HTML</a>
        <a class="btn btn-sm" href="/api/outcomes/export?start=${view.start}&end=${view.end}">Download outcome CSV</a></div>
        ${reviewBody(view.report)}` : !view.error ? html`<section class="card"><h2>${view.seriesOptions.length ? 'Choose a measurement series' : 'No measurement series yet'}</h2><p>${view.seriesOptions.length ? 'Select a saved series above to generate a review.' : 'Run and save a tracking measurement before selecting a weekly review.'}</p></section>` : ''}
      ${entryForms(view)}` });
}
