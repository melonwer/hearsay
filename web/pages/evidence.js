import { answerEvidence, intentEvidenceReport, listEvidenceIntents,
  listQueryThemes } from '../../core/evidence-report.js';
import { listMeasurementSeries, resolveMeasurementSeries } from '../../core/metrics.js';
import { emptyState, html, layout, raw, SURFACE_LABEL } from '../layout.js';

const LAYERS = [
  ['all', 'All layers'], ['questions', 'Buyer questions'], ['queries', 'Observed search queries'],
  ['sources', 'Source observations'], ['citations', 'Answer citations'], ['answers', 'Answer receipts'],
];
const SOURCE_LAYERS = [
  ['all', 'All source observations'], ['search_result', 'Search results'],
  ['reported_source', 'Reported consulted sources'], ['fetch', 'Observed fetches'],
];
const RECEIPT_FILTERS = ['all', 'query_exposed', 'query_available', 'query_unavailable', 'query_not_applicable'];
/** @typedef {NonNullable<ReturnType<typeof intentEvidenceReport>>} EvidenceReport */

/** @param {string|null} value @returns {number|null} */
function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** @param {ReturnType<typeof buildView>} view @param {Record<string, string|number|null>} [patch] */
export function evidenceUrl(view, patch = {}) {
  const values = { days: view.days, series_id: view.series?.id ?? null,
    intent_id: view.intentId, layer: view.layer, source_layer: view.sourceLayer,
    receipt_filter: view.receiptFilter, ...patch };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== '' &&
      !((key === 'layer' || key === 'source_layer' || key === 'receipt_filter') && value === 'all')) {
      params.set(key, String(value));
    }
  }
  return `/evidence?${params}`;
}

/** @param {import('./index.js').PageDeps} deps @param {URLSearchParams} params */
export function buildView({ db }, params) {
  const now = new Date();
  const requestedDays = positiveInt(params.get('days'));
  const days = requestedDays !== null && requestedDays <= 3650 ? requestedDays : 30;
  const seriesOptions = listMeasurementSeries(db, { now, days });
  const requestedSeriesId = params.get('series_id');
  const series = requestedSeriesId
    ? seriesOptions.find((item) => item.id === requestedSeriesId) ?? null
    : resolveMeasurementSeries(db, { now, days });
  const intents = series ? listEvidenceIntents(db, { series }) : [];
  const requestedIntentId = positiveInt(params.get('intent_id'));
  const requestedReceiptId = positiveInt(params.get('receipt_id'));
  const requestedReceipt = series && requestedReceiptId !== null && requestedIntentId === null
    ? answerEvidence(db, { series, responseId: requestedReceiptId }) : null;
  const intentId = requestedIntentId !== null && intents.some((intent) => intent.id === requestedIntentId)
    ? requestedIntentId : requestedReceipt?.question.intentId ?? intents[0]?.id ?? null;
  const report = series && intentId !== null ? intentEvidenceReport(db, { series, intentId }) : null;
  const requestedLayer = params.get('layer') ?? 'all';
  const layer = LAYERS.some(([id]) => id === requestedLayer) ? requestedLayer : 'all';
  const requestedSourceLayer = params.get('source_layer') ?? 'all';
  const sourceLayer = SOURCE_LAYERS.some(([id]) => id === requestedSourceLayer)
    ? requestedSourceLayer : 'all';
  const requestedReceiptFilter = params.get('receipt_filter') ?? 'all';
  const receiptFilter = RECEIPT_FILTERS.includes(requestedReceiptFilter)
    ? requestedReceiptFilter : 'all';
  return { days, seriesOptions, series, intents, intentId, report, layer,
    sourceLayer, receiptFilter, requestedReceiptId, themes: listQueryThemes(db) };
}

/** @param {string} url @param {string} label */
function safeLink(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return html`<a href="${url}" target="_blank" rel="noreferrer noopener nofollow">${label}</a>`;
    }
  } catch { /* Stored evidence may predate URL validation. */ }
  return html`${label}`;
}

/** @param {ReturnType<typeof buildView>} view @param {number[]} responseIds */
function supportLinks(view, responseIds) {
  if (!responseIds?.length) return html`<span class="muted">No supporting answer receipts</span>`;
  return html`<details class="evidence-support"><summary>Open ${responseIds.length} supporting answer receipt${responseIds.length === 1 ? '' : 's'}</summary>
    <ul>${responseIds.map((id) => html`<li><a href="${evidenceUrl(view, { layer: 'answers', receipt_id: id, receipt_filter: null })}#receipt-${id}">Receipt #${id}</a></li>`)}</ul>
  </details>`;
}

/** @param {ReturnType<typeof buildView>} view */
function selectors(view) {
  return html`<form class="card filter-row" method="get" action="/evidence">
    <label><span>Measurement series</span><select name="series_id" required>
      ${view.seriesOptions.map((series) => html`<option value="${series.id}"${series.id === view.series?.id ? raw(' selected') : ''}>
        ${SURFACE_LABEL[series.surface] ?? series.surface} · ${series.searchPolicy ?? 'legacy'} · ${series.comparableAnswers} comparable
      </option>`)}
    </select></label>
    <label><span>Buyer intent</span><select name="intent_id">
      ${view.intents.map((intent) => html`<option value="${intent.id}"${intent.id === view.intentId ? raw(' selected') : ''}>${intent.label}</option>`)}
    </select></label>
    <label><span>Window</span><select name="days">
      ${[7, 30, 90, 365].map((days) => html`<option value="${days}"${view.days === days ? raw(' selected') : ''}>${days} days</option>`)}
    </select></label>
    <button type="submit" class="btn">Show evidence</button>
  </form>`;
}

/** @param {ReturnType<typeof buildView>} view */
function layerNav(view) {
  return html`<nav class="evidence-layer-nav" aria-label="Evidence layers">
    ${LAYERS.map(([id, label]) => html`<a href="${evidenceUrl(view, { layer: id, receipt_id: null })}"${view.layer === id ? raw(' aria-current="page"') : ''}>${label}</a>`)}
  </nav>`;
}

/** @param {ReturnType<typeof buildView>} view @param {EvidenceReport} report */
function questions(view, report) {
  const rows = report.questions;
  return html`<section class="card" id="buyer-questions"><h2>Buyer questions</h2>
    <p class="muted">These are the captured questions in this benchmark revision. Each receipt keeps the wording submitted for that run.</p>
    ${rows.length ? html`<ul class="evidence-list">${rows.map((question) => html`<li>
      <span class="tag">${question.category}</span> ${question.text} <span class="muted">prompt #${question.promptId} · ${question.source}</span>
      ${supportLinks(view, question.responseIds)}
    </li>`)}</ul>` : html`<p>No captured buyer questions for this intent.</p>`}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view @param {NonNullable<ReturnType<typeof intentEvidenceReport>>['queries'][number]} query */
function themeControls(view, query) {
  const existing = view.themes.filter((theme) => !query.themeLabels.includes(theme.label));
  const assigned = view.themes.filter((theme) => query.themeLabels.includes(theme.label));
  return html`<div class="evidence-themes">
    ${assigned.map((theme) => html`<form class="inline-form" data-api-form="/api/query-theme-assignments">
      <input type="hidden" name="theme_id" value="${theme.id}" />
      <input type="hidden" name="normalized_key" value="${query.normalizedKey}" />
      <input type="hidden" name="assigned" value="false" data-bool />
      <span class="tag">${theme.label}</span><button class="btn btn-sm" type="submit" aria-label="Remove ${theme.label} from ${query.normalizedKey}">Remove</button>
    </form>`)}
    ${existing.length ? html`<form class="inline-form" data-api-form="/api/query-theme-assignments">
      <input type="hidden" name="normalized_key" value="${query.normalizedKey}" />
      <input type="hidden" name="assigned" value="true" data-bool />
      <label>Manual theme <select name="theme_id">${existing.map((theme) => html`<option value="${theme.id}">${theme.label}</option>`)}</select></label>
      <button class="btn btn-sm" type="submit">Add label</button>
    </form>` : ''}
  </div>`;
}

/** @param {ReturnType<typeof buildView>} view @param {EvidenceReport} report */
function queries(view, report) {
  const { coverage, queries: rows } = report;
  return html`<section class="card" id="observed-queries"><h2>Observed search queries</h2>
    <p class="muted">Query wording exposed by this configured system, not customer search demand. Exact groups use Unicode NFC, trimmed outer space, and collapsed inner space; case and punctuation stay distinct.</p>
    <p><a href="${evidenceUrl(view, { layer: 'answers', receipt_filter: 'query_exposed', receipt_id: null })}">${coverage.answersWithObservedQueries} answer receipts exposed queries</a>
      · <a href="${evidenceUrl(view, { layer: 'answers', receipt_filter: 'query_available', receipt_id: null })}">${coverage.answersWithQueryMetadata} with query metadata</a>
      / <a href="${evidenceUrl(view, { layer: 'answers', receipt_filter: 'all', receipt_id: null })}">${coverage.comparableAnswers} comparable answers</a>
      · <a href="${evidenceUrl(view, { layer: 'answers', receipt_filter: 'query_unavailable', receipt_id: null })}">${coverage.queryMetadataUnavailable} unavailable</a>
      · <a href="${evidenceUrl(view, { layer: 'answers', receipt_filter: 'query_not_applicable', receipt_id: null })}">${coverage.queryMetadataNotApplicable} not applicable</a>.</p>
    ${rows.length ? html`<div class="evidence-table-wrap"><table class="table"><thead><tr><th>Observed wording</th><th>Manual theme</th><th class="num">Answer incidence</th><th class="num">Raw occurrences</th><th>Receipts</th></tr></thead><tbody>
      ${rows.map((query) => html`<tr><td><strong>${query.normalizedKey}</strong>
        ${query.originalTexts.length > 1 ? html`<small class="muted">Original forms: ${query.originalTexts.join(' · ')}</small>` : ''}</td>
        <td>${themeControls(view, query)}</td>
        <td class="num">${query.responseIncidence} / ${coverage.answersWithObservedQueries}</td>
        <td class="num">${query.rawOccurrences}</td><td>${supportLinks(view, query.responseIds)}</td></tr>`)}
    </tbody></table></div>` : html`<p>No query wording was exposed in comparable answers for this intent. Missing query metadata is unknown, not evidence of no search.</p>`}
    <h3>Manual themes</h3>
    <p class="muted">These labels are assigned by a person. They group only observed query rows; they are not search-volume or demand estimates.</p>
    ${report.themeGroups.length ? html`<div class="evidence-table-wrap"><table class="table"><thead><tr><th>Theme</th><th>Observed query groups</th><th class="num">Answer incidence</th><th class="num">Raw occurrences</th><th>Receipts</th></tr></thead><tbody>
      ${report.themeGroups.map((theme) => html`<tr><td>${theme.label}</td><td>${theme.normalizedKeys.join(' · ')}</td>
        <td class="num">${theme.responseIncidence} / ${coverage.answersWithObservedQueries}</td>
        <td class="num">${theme.rawOccurrences}</td><td>${supportLinks(view, theme.responseIds)}</td></tr>`)}
    </tbody></table></div>` : html`<p>No manual query themes are assigned to this intent's observed queries.</p>`}
    <form class="inline-form" data-api-form="/api/query-themes">
      <label>New manual theme <input name="label" maxlength="80" required /></label><button type="submit" class="btn btn-sm">Create theme</button>
    </form><p class="form-error" data-form-error hidden></p>
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view @param {EvidenceReport} report @param {'sources'|'citations'} kind */
function groupedEvidence(view, report, kind) {
  const source = kind === 'sources';
  const rows = source ? report.sources.filter((row) => view.sourceLayer === 'all'
    || row.provenance === view.sourceLayer) : report.citations;
  const title = source ? 'Source observations' : 'Final-answer citations';
  return html`<section class="card" id="${kind}"><h2>${title}</h2>
    <p class="muted">${source
      ? 'Provider-reported results, consulted sources, and fetches are grouped by URL within their recorded evidence layer. A source is not automatically cited.'
      : 'Explicit references in final answers. A citation is not automatically a searched result or an endorsement.'}</p>
    ${source ? html`<form class="inline-form" method="get" action="/evidence">
      <input type="hidden" name="days" value="${view.days}" />
      <input type="hidden" name="series_id" value="${view.series?.id}" />
      <input type="hidden" name="intent_id" value="${view.intentId}" />
      <input type="hidden" name="layer" value="sources" />
      <label>Source evidence layer <select name="source_layer">${SOURCE_LAYERS.map(([id, label]) => html`<option value="${id}"${view.sourceLayer === id ? raw(' selected') : ''}>${label}</option>`)}</select></label>
      <button class="btn btn-sm" type="submit">Filter sources</button>
    </form>` : ''}
    ${rows.length ? html`<div class="evidence-table-wrap"><table class="table"><thead><tr><th>URL</th><th>Evidence layer</th><th>Publisher</th><th class="num">Answers</th><th class="num">Raw rows</th><th>Receipts</th></tr></thead><tbody>
      ${rows.map((row) => html`<tr><td>${safeLink(row.url, row.url)}</td>
        <td>${row.provenance}</td><td>${row.publisherDomain ?? 'Unknown'}${row.urlHost ? html` <small class="muted">(URL host: ${row.urlHost})</small>` : ''}</td>
        <td class="num">${row.responseIncidence}</td><td class="num">${row.rawOccurrences}</td>
        <td>${supportLinks(view, row.responseIds)}</td></tr>`)}
    </tbody></table></div>` : html`<p>No ${title.toLowerCase()} are stored for comparable answers in this intent.</p>`}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view @param {NonNullable<ReturnType<typeof intentEvidenceReport>>['answers'][number]} answer */
function receiptCard(view, answer) {
  return html`<article class="card evidence-receipt" id="receipt-${answer.id}">
    <h3>Receipt #${answer.id}</h3>
    <p class="muted">${answer.createdAt} · ${answer.surface} · ${answer.model} · profile ${answer.executionProfileId ?? 'legacy'} · benchmark ${answer.benchmarkRevisionId ?? 'legacy'}</p>
    <h4>Buyer question</h4><p>${answer.question.text} <small class="muted">(${answer.question.source})</small></p>
    <h4>Search actions and queries</h4>
    ${answer.searchActions.length ? html`<ul>${answer.searchActions.map((event) => html`<li>
      Action #${event.id} · ${event.eventType} · ${event.status} · ${event.observedAt ?? 'time unavailable'}
      ${answer.searchQueries.filter((query) => query.searchEventId === event.id).length
        ? html`<ul>${answer.searchQueries.filter((query) => query.searchEventId === event.id).map((query) => html`<li>Query #${query.id}: ${query.originalText}</li>`)}</ul>`
        : html`<p class="muted">Query wording unavailable for this action.</p>`}
    </li>`)}</ul>` : html`<p class="muted">No search action stored; search status: ${answer.webStatus ?? 'unknown'}, query metadata: ${answer.queryMetadataStatus ?? 'unknown'}.</p>`}
    ${answer.searchQueries.filter((query) => query.searchEventId === null).length ? html`<p>Queries with unknown action association:</p><ul>${answer.searchQueries.filter((query) => query.searchEventId === null).map((query) => html`<li>Query #${query.id}: ${query.originalText}</li>`)}</ul>` : ''}
    <h4>Source observations</h4>
    ${answer.sourceObservations.length ? html`<ul>${answer.sourceObservations.map((source) => html`<li>
      Source #${source.id} · ${source.provenance} · ${safeLink(source.url, source.title ?? source.url)}
      <span class="muted">· action ${source.searchEventId === null ? 'association unknown' : `#${source.searchEventId}`}</span>
    </li>`)}</ul>` : html`<p class="muted">No source observations stored.</p>`}
    <h4>Final-answer citations</h4>
    ${answer.answerCitations.length ? html`<ul>${answer.answerCitations.map((citation) => html`<li>
      Citation #${citation.id} · ${citation.provenance} · ${safeLink(citation.url, citation.url)}
      <span class="muted">· source ${citation.sourceObservationId === null ? 'association unknown' : `#${citation.sourceObservationId}`}</span>
    </li>`)}</ul>` : html`<p class="muted">No final-answer citation stored.</p>`}
    <h4>Answer and interpretation</h4><p class="evidence-answer-text">${answer.text ?? 'No final answer stored.'}</p>
    ${answer.mentions.length ? html`<ul>${answer.mentions.map((mention) => html`<li>
      ${mention.entityName ?? `Entity #${mention.entityId}`} · ${mention.method} · ${mention.analysisRevision}
      · original stance ${mention.originalStance ?? 'unclassified'}
      · effective stance ${mention.effectiveStance ?? 'unclassified'}
      · answer span ${mention.evidenceStart ?? 'unknown'}–${mention.evidenceEnd ?? 'unknown'}
      ${mention.correctionId === null ? '' : html`· latest correction #${mention.correctionId}`}
      ${mention.corrections.length ? html`<ol>${mention.corrections.map((correction) => html`<li>
        Correction #${correction.id} · ${correction.previousValue} → ${correction.replacement}
        · ${correction.reason} · ${correction.createdAt}
      </li>`)}</ol>` : ''}
    </li>`)}</ul>` : html`<p class="muted">No tracked entity mention stored.</p>`}
  </article>`;
}

/** @param {ReturnType<typeof buildView>} view @param {EvidenceReport} report */
function receipts(view, report) {
  const answers = report.answers.filter((answer) => {
    if (view.requestedReceiptId !== null) return answer.id === view.requestedReceiptId;
    switch (view.receiptFilter) {
      case 'query_exposed': return answer.searchQueries.length > 0;
      case 'query_available': return answer.queryMetadataStatus === 'available';
      case 'query_unavailable': return answer.queryMetadataStatus === 'unavailable';
      case 'query_not_applicable': return answer.queryMetadataStatus === 'not_applicable';
      default: return true;
    }
  });
  return html`<section id="answer-receipts"><h2>Answer receipts</h2>
    ${answers.length ? answers.map((answer) => receiptCard(view, answer))
      : html`<p class="card">No comparable answer receipt matches this selection.</p>`}
  </section>`;
}

/** @param {import('../layout.js').ShellCtx} ctx @param {ReturnType<typeof buildView>} view */
export function render(ctx, view) {
  let body = selectors(view);
  if (!view.series || !view.report) {
    body = html`${body}${emptyState({ title: 'No evidence for this selection',
      line: 'Choose a measurement series and buyer intent with stored answers.',
      hint: 'Captured evidence will appear after a panel run completes.' })}`;
  } else {
    const { series, report } = view;
    body = html`${body}
      <p class="muted">Exact series ${series.id} · ${SURFACE_LABEL[series.surface] ?? series.surface} · ${series.start} to ${series.end} UTC, end exclusive · <a href="${evidenceUrl(view, { layer: 'answers', receipt_filter: 'all', receipt_id: null })}">${report.coverage.comparableAnswers} comparable answer receipts</a></p>
      ${layerNav(view)}
      ${view.layer === 'all' || view.layer === 'questions' ? questions(view, report) : ''}
      ${view.layer === 'all' || view.layer === 'queries' ? queries(view, report) : ''}
      ${view.layer === 'all' || view.layer === 'sources' ? groupedEvidence(view, report, 'sources') : ''}
      ${view.layer === 'all' || view.layer === 'citations' ? groupedEvidence(view, report, 'citations') : ''}
      ${view.layer === 'all' || view.layer === 'answers' ? receipts(view, report) : ''}`;
  }
  return layout({ title: 'Evidence', active: '/evidence', ctx, body });
}
