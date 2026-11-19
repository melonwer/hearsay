import {
  answerEvidence,
  intentEvidenceReport,
  listEvidenceIntents,
  listQueryThemes,
  memoryVsRetrievalDelta,
  retrievalAttritionReport,
} from '../../core/evidence-report.js';
import { listMeasurementSeries, resolveMeasurementSeries } from '../../core/metrics.js';
import { emptyState, html, layout, pct, rateWithCI, raw, SURFACE_LABEL } from '../layout.js';
import { searchSuggestions, originalGrounding } from '../gemini-grounding.js';

const LAYERS = [
  ['all', 'All layers'], ['questions', 'Buyer questions'], ['queries', 'Observed search queries'],
  ['sources', 'Source observations'], ['citations', 'Answer citations'],
  ['attrition', 'Retrieval attrition & hijacks'], ['memory_vs_search', 'Memory vs. search delta'],
  ['answers', 'Answer receipts'],
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
    start: view.exactRange?.start ?? null, end: view.exactRange?.end ?? null,
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

/** @param {ReturnType<typeof buildView>} view @param {Record<string, string|number|null>} [patch] */
function opportunityUrl(view, patch = {}) {
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
export function buildView({ db, config }, params) {
  const now = new Date();
  const requestedDays = positiveInt(params.get('days'));
  const days = requestedDays !== null && requestedDays <= 3650 ? requestedDays : 30;
  const start = params.get('start');
  const end = params.get('end');
  const exactRange = start && end && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(start)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(end)
    && Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) && start < end
    ? { start, end } : null;
  const seriesOptions = listMeasurementSeries(db, { now, days, ...(exactRange ?? {}) });
  const requestedSeriesId = params.get('series_id');
  const series = requestedSeriesId
    ? seriesOptions.find((item) => item.id === requestedSeriesId) ?? null
    : resolveMeasurementSeries(db, { now, days, ...(exactRange ?? {}) });
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
  const includeSeeded = Boolean(config?.demo);
  const attritionFilters = {
    ...(series && series.searchPolicy !== 'off' ? { series } : {}),
    ...(exactRange ?? {}),
    includeSeeded,
    limit: 15,
  };
  const attrition = retrievalAttritionReport(db, attritionFilters);
  const memoryDelta = memoryVsRetrievalDelta(db, {
    ...(exactRange ?? {}),
    includeSeeded,
  });
  return { days, exactRange, seriesOptions, series, intents, intentId, report, layer,
    sourceLayer, receiptFilter, requestedReceiptId, themes: listQueryThemes(db),
    attrition, memoryDelta };
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
        <td class="num">${query.rawOccurrences}</td><td>${supportLinks(view, query.responseIds)}
          <a href="${opportunityUrl(view, { query_ids: query.queryIds.join(','), response_ids: query.responseIds.join(',') })}">Use as opportunity evidence</a></td></tr>`)}
    </tbody></table></div>` : html`<p>No query wording was exposed in comparable answers for this intent. Missing query metadata is unknown, not evidence of no search.</p>`}
    <h3>Manual themes</h3>
    <p class="muted">These labels are assigned by a person. They group only observed query rows; they are not search-volume or demand estimates.</p>
    ${report.themeGroups.length ? html`<div class="evidence-table-wrap"><table class="table"><thead><tr><th>Theme</th><th>Observed query groups</th><th class="num">Answer incidence</th><th class="num">Raw occurrences</th><th>Receipts</th></tr></thead><tbody>
      ${report.themeGroups.map((theme) => html`<tr><td>${theme.label}</td><td>${theme.normalizedKeys.join(' · ')}</td>
        <td class="num">${theme.responseIncidence} / ${coverage.answersWithObservedQueries}</td>
        <td class="num">${theme.rawOccurrences}</td><td>${supportLinks(view, theme.responseIds)}
          <a href="${opportunityUrl(view, { query_ids: theme.queryIds.join(','), response_ids: theme.responseIds.join(',') })}">Use as opportunity evidence</a></td></tr>`)}
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
      ${view.exactRange ? html`<input type="hidden" name="start" value="${view.exactRange.start}" /><input type="hidden" name="end" value="${view.exactRange.end}" />` : ''}
      <input type="hidden" name="intent_id" value="${view.intentId}" />
      <input type="hidden" name="layer" value="sources" />
      <label>Source evidence layer <select name="source_layer">${SOURCE_LAYERS.map(([id, label]) => html`<option value="${id}"${view.sourceLayer === id ? raw(' selected') : ''}>${label}</option>`)}</select></label>
      <button class="btn btn-sm" type="submit">Filter sources</button>
    </form>` : ''}
    ${rows.length ? html`<div class="evidence-table-wrap"><table class="table"><thead><tr><th>URL</th><th>Evidence layer</th><th>Publisher</th><th class="num">Answers</th><th class="num">Raw rows</th><th>Receipts</th></tr></thead><tbody>
      ${rows.map((row) => html`<tr><td>${safeLink(row.url, row.url)}</td>
        <td>${row.provenance}</td><td>${row.publisherDomain ?? 'Unknown'}${row.urlHost ? html` <small class="muted">(URL host: ${row.urlHost})</small>` : ''}</td>
        <td class="num">${row.responseIncidence}</td><td class="num">${row.rawOccurrences}</td>
        <td>${supportLinks(view, row.responseIds)}
          ${source ? html`<a href="${opportunityUrl(view, { source_ids: /** @type {EvidenceReport['sources'][number]} */ (row).observationIds.join(','), response_ids: row.responseIds.join(',') })}">Use as opportunity evidence</a>` : ''}</td></tr>`)}
    </tbody></table></div>` : html`<p>No ${title.toLowerCase()} are stored for comparable answers in this intent.</p>`}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view @param {NonNullable<ReturnType<typeof intentEvidenceReport>>['answers'][number]} answer */
function receiptCard(view, answer) {
  return html`<article class="card evidence-receipt" id="receipt-${answer.id}">
    <h3>Receipt #${answer.id}</h3>
    <p><a href="${opportunityUrl(view, { response_ids: answer.id })}">Use this answer for an opportunity</a></p>
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
      ${citation.answerStart !== null && citation.answerEnd !== null && citation.answerStart >= 0
        && citation.answerEnd <= answer.text.length && citation.answerEnd > citation.answerStart
        ? html`<span class="muted">· answer span ${citation.answerStart}–${citation.answerEnd}: "${answer.text.slice(citation.answerStart, citation.answerEnd)}"</span>` : ''}
    </li>`)}</ul>` : html`<p class="muted">No final-answer citation stored.</p>`}
    <h4>Answer and interpretation</h4><p class="evidence-answer-text">${answer.text ?? 'No final answer stored.'}</p>
    ${searchSuggestions(answer.groundingReceipt)}
    ${originalGrounding(answer.groundingReceipt)}
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

/** @param {number|null|undefined} delta */
function signedPts(delta) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return '—';
  const pts = Math.round(delta * 1000) / 10;
  if (pts === 0) return '0.0 pts';
  return `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts`;
}

/** @param {string} cls */
function deltaClassPill(cls) {
  const tone = cls === 'memory_anchored'
    ? 'status-pill-active'
    : cls === 'search_dependent'
      ? 'status-pill-collecting'
      : cls === 'memory_displaced'
        ? 'status-pill-warn'
        : 'status-pill-off';
  return html`<span class="status-pill ${tone}">${cls}</span>`;
}

/** @param {ReturnType<typeof buildView>} view */
function attritionPanel(view) {
  const report = view.attrition;
  if (!report) return '';
  /** @type {Array<[string, typeof report.byOwnership.brand_owned]>} */
  const ownershipRows = [
    ['Brand-owned', report.byOwnership.brand_owned],
    ['Competitor-owned', report.byOwnership.competitor_owned],
    ['Third-party', report.byOwnership.third_party],
  ];

  return html`<section class="card" id="retrieval-attrition">
    <h2>Retrieved-but-Dropped ("Attrition") &amp; Own-Site Hijacks</h2>
    <p class="muted">Compares sources retrieved during web search against URLs actually cited in the final answer. High attrition means search found a page that the answer synthesizer left out.</p>
    <dl class="kv">
      <dt>Search-grounded answers</dt>
      <dd>${report.n} eligible (${report.answersWithSourceObservations} with source observations · ${report.answersWithCitations} with citations)</dd>
      <dt>Overall attrition rate</dt>
      <dd>${rateWithCI(report.attritionRate)} <span class="muted">(${report.droppedObservations} dropped of ${report.retrievedObservations} retrieved observations)</span></dd>
      <dt>Unique URLs</dt>
      <dd>${report.totalUniqueRetrievedUrls} retrieved · ${report.totalUniqueCitedUrls} cited · ${report.totalUniqueDroppedUrls} dropped at least once</dd>
      <dt>Own-site hijacks</dt>
      <dd><strong>${report.hijacks.count}</strong> of ${report.hijacks.ownCitedAnswers} own-cited answer${report.hijacks.ownCitedAnswers === 1 ? '' : 's'} (${rateWithCI(report.hijacks.rate)})</dd>
    </dl>

    ${report.retrievedObservations > 0 || report.citedObservations > 0
      ? html`<h3>Attrition by domain ownership</h3>
        <div class="evidence-table-wrap"><table class="table">
          <thead><tr><th>Ownership</th><th class="num">Unique retrieved</th><th class="num">Unique cited</th><th class="num">Unique dropped</th><th class="num">Attrition rate (95% CI)</th></tr></thead>
          <tbody>${ownershipRows.map(([label, bucket]) => html`<tr>
            <td><strong>${label}</strong></td>
            <td class="num">${bucket.uniqueRetrievedUrls}</td>
            <td class="num">${bucket.uniqueCitedUrls}</td>
            <td class="num">${bucket.uniqueDroppedUrls}</td>
            <td class="num">${rateWithCI(bucket.attritionRate)}</td>
          </tr>`)}</tbody>
        </table></div>`
      : ''}

    <h3>Dropped brand URLs</h3>
    ${report.topDroppedBrandUrls.length
      ? html`<div class="evidence-table-wrap"><table class="table">
          <thead><tr><th>Brand URL</th><th class="num">Retrieved</th><th class="num">Cited</th><th class="num">Dropped</th><th class="num">Drop rate</th><th>Receipts</th></tr></thead>
          <tbody>${report.topDroppedBrandUrls.map((row) => html`<tr>
            <td>${safeLink(row.url, row.url)}</td>
            <td class="num">${row.retrievedCount}</td>
            <td class="num">${row.citedCount}</td>
            <td class="num">${row.droppedCount}</td>
            <td class="num">${pct(row.dropRate)}</td>
            <td>${row.droppedResponseIds.map((id) => `#${id}`).join(', ')}</td>
          </tr>`)}</tbody>
        </table></div>`
      : html`<p class="muted">No dropped brand-owned URLs observed in this scope.</p>`}

    <h3>Dropped third-party URLs</h3>
    ${report.topDroppedThirdPartyUrls.length
      ? html`<div class="evidence-table-wrap"><table class="table">
          <thead><tr><th>Third-party URL</th><th>Domain</th><th class="num">Retrieved</th><th class="num">Cited</th><th class="num">Dropped</th><th class="num">Drop rate</th></tr></thead>
          <tbody>${report.topDroppedThirdPartyUrls.map((row) => html`<tr>
            <td>${safeLink(row.url, row.url)}</td>
            <td><code>${row.domain ?? 'unknown'}</code></td>
            <td class="num">${row.retrievedCount}</td>
            <td class="num">${row.citedCount}</td>
            <td class="num">${row.droppedCount}</td>
            <td class="num">${pct(row.dropRate)}</td>
          </tr>`)}</tbody>
        </table></div>`
      : html`<p class="muted">No dropped third-party URLs observed in this scope.</p>`}

    <div id="own-site-hijacks">
      <h3>Own-Site Hijacks</h3>
      <p class="muted">Answers where your own page was cited while a competitor received a positive recommendation and your brand did not.</p>
      ${report.hijacks.receipts.length
        ? html`<div class="evidence-table-wrap"><table class="table">
            <thead><tr><th>Receipt</th><th>Question</th><th>Model</th><th>Your cited page(s)</th><th>Recommended competitor(s)</th><th>Brand stance</th></tr></thead>
            <tbody>${report.hijacks.receipts.map((item) => html`<tr>
              <td>#${item.responseId}</td>
              <td>${item.promptText}</td>
              <td><code>${item.provider}/${item.model}</code></td>
              <td>${item.ownCitedUrls.map((u) => html`<div>${safeLink(u, u)}</div>`)}</td>
              <td>${item.recommendedCompetitors.map((name) => html`<span class="status-pill status-pill-warn">${name}</span> `)}</td>
              <td>${item.brandStance ?? 'absent'}</td>
            </tr>`)}</tbody>
          </table></div>`
        : html`<p class="muted">No own-site hijacks detected in this scope.</p>`}
    </div>

    ${report.limitations.length
      ? html`<details><summary>Scope &amp; limitations (${report.limitations.length})</summary><ul>${report.limitations.map((note) => html`<li>${note}</li>`)}</ul></details>`
      : ''}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view */
function memoryVsSearchPanel(view) {
  const delta = view.memoryDelta;
  if (!delta) return '';

  return html`<section class="card" id="memory-vs-search">
    <h2>Parametric Memory vs. Grounded Retrieval Delta</h2>
    <p class="muted">Strict same-<code>(provider, model)</code> paired comparison on identical prompts: parametric memory (<code>search_policy='off'</code> / <code>not_used</code>) vs. verified live retrieval. Models are never blended across providers or unshared prompts.</p>
    <p class="muted small">${delta.summary.pairedModels} paired model${delta.summary.pairedModels === 1 ? '' : 's'} · ${delta.summary.unpairedModels} unpaired · ${delta.summary.totalPairedPrompts} paired prompt${delta.summary.totalPairedPrompts === 1 ? '' : 's'}</p>

    ${delta.pairs.length === 0
      ? html`<p class="muted">No parametric memory or verified live-retrieval responses available yet for paired comparison.</p>`
      : delta.pairs.map((pair) => {
          const isPaired = pair.status === 'paired';
          const statusLabel = pair.status === 'paired'
            ? 'Paired'
            : pair.status === 'memory_only'
              ? 'Unpaired · memory only'
              : pair.status === 'grounded_only'
                ? 'Unpaired · grounded only'
                : 'Unpaired · no prompt overlap';
          const statusTone = isPaired ? 'status-pill-active' : 'status-pill-warn';
          return html`<article class="card">
            <div class="health-lane-head">
              <h3><code>${pair.provider} / ${pair.model}</code></h3>
              <span class="status-pill ${statusTone}">${statusLabel}</span>
            </div>
            ${!isPaired
              ? html`<p class="muted">Unpaired notice: ${pair.provider}/${pair.model} has ${pair.unpaired.memoryOnlyPromptCount} memory-only prompt${pair.unpaired.memoryOnlyPromptCount === 1 ? '' : 's'} and ${pair.unpaired.groundedOnlyPromptCount} grounded-only prompt${pair.unpaired.groundedOnlyPromptCount === 1 ? '' : 's'} with 0 overlapping prompts. Run the same prompts in both memory (<code>search_policy='off'</code>) and verified search modes on this exact model to compute a valid delta.</p>`
              : html`
                <p class="muted small">${pair.pairedPromptCount} paired prompt${pair.pairedPromptCount === 1 ? '' : 's'} · ${pair.memoryResponseCount} memory responses vs. ${pair.groundedResponseCount} grounded responses${pair.unpaired.memoryOnlyPromptCount > 0 || pair.unpaired.groundedOnlyPromptCount > 0 ? html` · excluded unpaired prompts: ${pair.unpaired.memoryOnlyPromptCount} memory-only, ${pair.unpaired.groundedOnlyPromptCount} grounded-only` : ''}</p>
                ${pair.brand
                  ? html`<dl class="kv">
                      <dt>Brand mention rate</dt>
                      <dd>Memory ${rateWithCI(pair.brand.memoryMentionRate)} &rarr; Grounded ${rateWithCI(pair.brand.groundedMentionRate)} (<strong>${signedPts(pair.brand.deltaMentionRate)}</strong>)</dd>
                      <dt>Positive stance rate</dt>
                      <dd>Memory ${rateWithCI(pair.brand.memoryPositiveRate)} &rarr; Grounded ${rateWithCI(pair.brand.groundedPositiveRate)} (<strong>${signedPts(pair.brand.deltaPositiveRate)}</strong>)</dd>
                      <dt>Grounded citation rate</dt>
                      <dd>${rateWithCI(pair.brand.groundedCitationRate)}</dd>
                      <dt>Prompt shift tags</dt>
                      <dd class="pill-group">
                        ${deltaClassPill('memory_anchored')} <span>${pair.classificationSummary.memory_anchored}</span>
                        ${deltaClassPill('search_dependent')} <span>${pair.classificationSummary.search_dependent}</span>
                        ${deltaClassPill('memory_displaced')} <span>${pair.classificationSummary.memory_displaced}</span>
                        ${deltaClassPill('absent_in_both')} <span>${pair.classificationSummary.absent_in_both}</span>
                      </dd>
                    </dl>`
                  : html`<p class="muted">Configure an active brand entity to view brand-specific memory vs. search deltas.</p>`}
                ${pair.brandPromptClassifications.length
                  ? html`<div class="evidence-table-wrap"><table class="table">
                      <thead><tr><th>Prompt</th><th>Classification</th><th class="num">Memory mentions</th><th class="num">Grounded mentions</th><th class="num">Grounded citations</th></tr></thead>
                      <tbody>${pair.brandPromptClassifications.map((row) => html`<tr>
                        <td>${row.promptText}</td>
                        <td>${deltaClassPill(row.classification)}</td>
                        <td class="num">${row.memoryMentioned}/${row.memoryN}</td>
                        <td class="num">${row.groundedMentioned}/${row.groundedN}</td>
                        <td class="num">${row.groundedCited}/${row.groundedN}</td>
                      </tr>`)}</tbody>
                    </table></div>`
                  : ''}
              `}
          </article>`;
        })}

    ${delta.limitations.length
      ? html`<details><summary>Pairing scope &amp; limitations (${delta.limitations.length})</summary><ul>${delta.limitations.map((note) => html`<li>${note}</li>`)}</ul></details>`
      : ''}
  </section>`;
}

/** @param {import('../layout.js').ShellCtx} ctx @param {ReturnType<typeof buildView>} view */
export function render(ctx, view) {
  let body = selectors(view);
  const hasForensics = Boolean(view.attrition?.n > 0 || view.memoryDelta?.pairs?.length > 0);
  if (!view.series || !view.report) {
    body = html`${body}${emptyState({ title: 'No evidence for this selection',
      line: 'Choose a measurement series and buyer intent with stored answers.',
      hint: 'Captured evidence will appear after a panel run completes.' })}
      ${hasForensics ? html`${attritionPanel(view)}${memoryVsSearchPanel(view)}` : ''}`;
  } else {
    const { series, report } = view;
    body = html`${body}
      <p class="muted">Exact series ${series.id} · ${SURFACE_LABEL[series.surface] ?? series.surface} · ${series.start} to ${series.end} UTC, end exclusive · <a href="${evidenceUrl(view, { layer: 'answers', receipt_filter: 'all', receipt_id: null })}">${report.coverage.comparableAnswers} comparable answer receipts</a></p>
      <p><a href="${opportunityUrl(view)}">Review opportunities for this intent</a></p>
      ${layerNav(view)}
      ${view.layer === 'all' || view.layer === 'questions' ? questions(view, report) : ''}
      ${view.layer === 'all' || view.layer === 'queries' ? queries(view, report) : ''}
      ${view.layer === 'all' || view.layer === 'sources' ? groupedEvidence(view, report, 'sources') : ''}
      ${view.layer === 'all' || view.layer === 'citations' ? groupedEvidence(view, report, 'citations') : ''}
      ${view.layer === 'all' || view.layer === 'attrition' ? attritionPanel(view) : ''}
      ${view.layer === 'all' || view.layer === 'memory_vs_search' ? memoryVsSearchPanel(view) : ''}
      ${view.layer === 'all' || view.layer === 'answers' ? receipts(view, report) : ''}`;
  }
  return layout({ title: 'Evidence', active: '/evidence', ctx, body });
}
