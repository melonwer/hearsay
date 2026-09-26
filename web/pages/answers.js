import { isAgentSurface, AGENT_SURFACES } from '../../core/agent-routes.js';
/**
 * GET /answers — the receipts explorer (§11.4).
 *
 * Filtering and pagination are server-side: query params in, one rendered page out.
 * There is no client router and no client-side copy of the dataset. Entity mentions
 * are marked in the answer text with the analyser's own spans (§6.2), so what is
 * highlighted and what was counted can never disagree.
 */

import { emptyState, html, layout, PROVIDER_LABEL, providerBadge, raw, relTime, SURFACE_LABEL, truncate } from '../layout.js';
import { searchSuggestions, originalGrounding } from '../gemini-grounding.js';
import { randomUUID } from 'node:crypto';
import { formatUsd } from '../../core/cost.js';
import { highlightAnswer } from '../highlight.js';
import { colorIndexFor, listEntities, listPrompts, PROVIDERS, queryAnswers } from '../queries.js';
import { SURFACES } from '../../core/subscription-model.js';
import { listMeasurementSeries, resolveMeasurementSeries } from '../../core/metrics.js';

const ALL_SURFACES = /** @type {readonly string[]} */ ([...SURFACES]);

/** Date-range presets in the filter row (§11.4). */
export const RANGES = /** @type {readonly {days: number, label: string}[]} */ ([
  { days: 1, label: 'Today' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
]);

/**
 * @param {URLSearchParams} query
 * @param {string} key
 * @returns {number|null}
 */
function intParam(query, key) {
  const value = query.get(key);
  if (value === null || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The filter state the page was rendered with — read back out of the query string, so
 * a shared URL reproduces the view exactly (§11.4).
 *
 * @typedef {Object} AnswerFilterState
 * @property {string|null} provider
 * @property {string|null} surface
 * @property {number|null} promptId
 * @property {number|null} entityId
 * @property {number} days
 * @property {number} page 1-based
 * @property {number} per
 * @property {string|null} seriesId
 * @property {boolean} eligibleOnly
 */

/**
 * @typedef {Object} AnswersView
 * @property {AnswerFilterState} filters
 * @property {ReturnType<typeof resolveMeasurementSeries>} series
 * @property {ReturnType<typeof listMeasurementSeries>} seriesOptions
 * @property {import('../queries.js').Entity[]} entities
 * @property {import('../queries.js').Prompt[]} prompts
 * @property {Map<number, number>} colorIndex entity id → series slot index (§11.1)
 * @property {ReturnType<typeof queryAnswers>} result page of answers plus the pager counts
 * @property {number} nowMs render clock, so `relTime` stays deterministic in tests
 */

/**
 * @param {import('./dashboard.js').PageDeps} deps
 * @param {URLSearchParams} query
 * @returns {AnswersView}
 */
export function buildView({ db }, query) {
  const entities = listEntities(db);
  const prompts = listPrompts(db);
  const provider = query.get('provider');
  const surface = query.get('surface');
  const now = new Date();
  const days = intParam(query, 'days') ?? 30;
  const seriesOptions = listMeasurementSeries(db, { now, days });
  const requestedSeriesId = query.get('series_id');
  const series = requestedSeriesId
    ? seriesOptions.find((item) => item.id === requestedSeriesId) ?? null
    : resolveMeasurementSeries(db, { now, days });
  const filters = {
    provider: provider !== null && PROVIDERS.includes(provider) ? provider : null,
    surface: surface !== null && ALL_SURFACES.includes(surface) ? surface : null,
    promptId: intParam(query, 'prompt_id'),
    entityId: intParam(query, 'entity_id'),
    days,
    page: intParam(query, 'page') ?? 1,
    per: 20,
    seriesId: requestedSeriesId ?? series?.id ?? null,
    eligibleOnly: query.get('eligible') === '1',
  };
  return {
    filters,
    series,
    seriesOptions,
    entities,
    prompts,
    colorIndex: colorIndexFor(entities),
    result: series === null ? { total: 0, page: 1, per: 20, pages: 1, items: [] }
      : queryAnswers(db, { ...filters, series, start: series.start, end: series.end, now,
        eligibleOnly: filters.eligibleOnly }),
    nowMs: now.getTime(),
  };
}

/**
 * Rebuild the query string with one value changed — how the range presets and the
 * pager keep every other filter intact.
 *
 * @param {{provider: string|null, surface: string|null, promptId: number|null, entityId: number|null,
 *   days: number, page: number, seriesId:string|null, eligibleOnly:boolean}} filters
 * @param {Record<string, string|number|null>} [patch]
 * @returns {string}
 */
export function queryString(filters, patch = {}) {
  /** @type {Record<string, string|number|null>} */
  const merged = {
    provider: filters.provider,
    surface: filters.surface,
    prompt_id: filters.promptId,
    entity_id: filters.entityId,
    series_id: filters.seriesId,
    eligible: filters.eligibleOnly ? '1' : null,
    days: filters.days,
    page: filters.page,
    ...patch,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'page' && Number(value) === 1) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '/answers' : `/answers?${text}`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function filterRow(view) {
  const { filters } = view;
  const seriesOptions = view.seriesOptions.map((series) => html`<option value="${series.id}"${series.id === filters.seriesId ? raw(' selected') : ''}>
    ${SURFACE_LABEL[series.surface] ?? series.surface} · ${series.searchPolicy ?? 'legacy'} ·
    ${series.analysisRevision ?? 'legacy'} · ${series.comparableAnswers}/${series.attemptedTargets} comparable
  </option>`);
  const providerOptions = PROVIDERS.map(
    (id) =>
      html`<option value="${id}"${filters.provider === id ? raw(' selected') : ''}>${PROVIDER_LABEL[id] ?? id}</option>`,
  );
  const surfaceOptions = ALL_SURFACES.map(
    (surface) => html`<option value="${surface}"${filters.surface === surface ? raw(' selected') : ''}>${SURFACE_LABEL[surface] ?? surface}</option>`,
  );
  const promptOptions = view.prompts.map(
    (prompt) =>
      html`<option value="${prompt.id}"${filters.promptId === prompt.id ? raw(' selected') : ''}>
        ${truncate(prompt.text, 60)}
      </option>`,
  );
  const entityOptions = view.entities.map(
    (entity) =>
      html`<option value="${entity.id}"${filters.entityId === entity.id ? raw(' selected') : ''}>${entity.name}</option>`,
  );
  const ranges = RANGES.map(
    (range) =>
      html`<a
        class="range${filters.days === range.days ? ' is-active' : ''}"
        href="${queryString(filters, { days: range.days, page: 1 })}"
        >${range.label}</a
      >`,
  );

  return html`<form class="card filter-row" method="get" action="/answers">
    <label>
      <span>Measurement series</span>
      <select name="series_id">${seriesOptions}</select>
    </label>
    <label>
      <span>Engine</span>
      <select name="provider">
        <option value="">All engines</option>
        ${providerOptions}
      </select>
    </label>
    <label>
      <span>Prompt</span>
      <select name="prompt_id">
        <option value="">All prompts</option>
        ${promptOptions}
      </select>
    </label>
    <label>
      <span>Surface</span>
      <select name="surface">
        <option value="">All surfaces</option>
        ${surfaceOptions}
      </select>
    </label>
    <label>
      <span>Entity</span>
      <select name="entity_id">
        <option value="">Any entity</option>
        ${entityOptions}
      </select>
    </label>
    <input type="hidden" name="days" value="${filters.days}" />
    <label><input type="checkbox" name="eligible" value="1"${filters.eligibleOnly ? raw(' checked') : ''} /> Comparable answers only</label>
    <button type="submit" class="btn">Apply</button>
    <span class="range-group" role="group" aria-label="Date range">${ranges}</span>
    <a class="btn btn-quiet" href="/answers">Clear</a>
  </form>`;
}

/**
 * Server-rendered pager, "‹ 1 2 3 ›" (§11.4).
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml|string}
 */
function pager(view) {
  const { pages, page } = view.result;
  if (pages <= 1) return '';
  /** @type {number[]} */
  const window = [];
  for (let p = Math.max(1, page - 3); p <= Math.min(pages, page + 3); p += 1) window.push(p);
  return html`<nav class="pager" aria-label="Pages">
    ${page > 1
      ? html`<a href="${queryString(view.filters, { page: page - 1 })}" rel="prev">‹</a>`
      : html`<span class="muted">‹</span>`}
    ${window.map((p) =>
      p === page
        ? html`<strong aria-current="page">${p}</strong>`
        : html`<a href="${queryString(view.filters, { page: p })}">${p}</a>`,
    )}
    ${page < pages
      ? html`<a href="${queryString(view.filters, { page: page + 1 })}" rel="next">›</a>`
      : html`<span class="muted">›</span>`}
  </nav>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @param {import('../queries.js').AnswerItem} item
 * @returns {import('../layout.js').RawHtml}
 */
function answerCard(view, item) {
  const surface = item.surface ?? `${item.provider}-api`;
  const head = html`<header class="answer-head">
    ${providerBadge(item.provider, item.surface)}
    <span class="muted answer-surface">${SURFACE_LABEL[surface] ?? surface}</span>
    <span class="muted answer-model">${item.model}</span>
    <span class="muted">${relTime(item.created_at, view.nowMs)}</span>
    <span class="muted">sample #${item.sample_idx + 1}</span>
  </header>`;
  const charge = item.reported_charge_usd === null ? '' : html`<p class="muted small">
    Provider-reported charge: ${formatUsd(item.reported_charge_usd)}.
    Computed usage cost: ${item.cost_usd === null
      ? item.cost_known_subtotal_usd === null ? 'unknown' : `${formatUsd(item.cost_known_subtotal_usd)} known subtotal, partial`
      : formatUsd(item.cost_usd)}. These amounts have different provenance.
  </p>`;

  if (item.error !== null) {
    // Errored responses collapse behind their error-kind chip (§11.4).
    const kind = item.error.split(':')[0];
    return html`<article class="card answer is-error">
      ${head}
      ${charge}
      <p class="answer-prompt">${item.prompt}</p>
      <details>
        <summary><span class="pill pill-error">${kind}</span> No answer stored for this call</summary>
        <p class="muted">${item.error}</p>
      </details>
    </article>`;
  }

  const review = item.review;
  const recommended = review.mentions.some((mention) => mention.recommended === 1);
  const labels = review.mentions.map((mention) => {
    const entity = view.entities.find((item_) => item_.id === mention.entityId);
    const label = mention.effectiveStance ?? (mention.legacyRecommended === 1 ? 'legacy recommended' : 'legacy not recommended');
    return html`<li>
      <strong>${entity?.name ?? `Entity ${mention.entityId}`}</strong>: ${label}
      <span class="muted">· ${mention.method} · ${mention.analysisRevision}
        ${mention.ruleId ? `· ${mention.ruleId}` : ''}
        ${mention.evidenceStart !== null ? `· answer span ${mention.evidenceStart}–${mention.evidenceEnd}` : ''}
      </span>
      ${mention.reviewFlags.length ? html`<span class="pill pill-error">Review: ${mention.reviewFlags.join(', ')}</span>` : ''}
      ${mention.corrections.length ? html`<ol>${mention.corrections.map((correction) => html`<li>${correction.replacement} · ${correction.reason} · ${correction.createdAt}</li>`)}</ol>` : ''}
      <form data-api-form="/api/answers/${item.id}/corrections" class="inline-form">
        <input type="hidden" name="interpretation_id" value="${mention.interpretationId}" />
        <input type="hidden" name="previous_correction_id" value="${mention.correctionId ?? ''}" />
        <input type="hidden" name="request_id" value="${randomUUID()}" />
        <label>Correct stance
          <select name="replacement">
            <option value="positive">Positive</option><option value="negative">Negative</option>
            <option value="neutral">Neutral</option><option value="uncertain">Uncertain</option>
          </select>
        </label>
        <label>Reason <input type="text" name="reason" maxlength="1000" required /></label>
        <button type="submit" class="btn">Save correction</button>
      </form>
    </li>`;
  });
  const citations = item.citations.map((citation) => {
    const slot = citation.entity_id === null ? undefined : view.colorIndex.get(citation.entity_id);
    const cls = `cite${slot === undefined ? '' : ` cite-s${slot + 1}`}`;
    // Defence in depth: the analyzer only stores http(s) URLs, but a row written
    // before that allowlist existed must still never render as a clickable
    // javascript:/data: href (§10.1).
    if (!/^https?:\/\//i.test(citation.url)) {
      return html`<span class="${cls}">${citation.domain}</span>`;
    }
    return html`<a
      class="${cls}"
      href="${citation.url}"
      rel="noreferrer noopener nofollow"
      target="_blank"
      >${citation.domain}</a
    >`;
  });

  const evidence = isAgentSurface(item.surface) ||
      item.search_events.length > 0 || item.source_observations.length > 0 || item.answer_citations.length > 0
    ? html`<details class="answer-evidence">
        <summary>Measurement evidence</summary>
        <dl class="kv">
          <dt>Web search</dt>
          <dd>${item.web_status ?? 'unknown'}</dd>
          <dt>Comparable</dt>
          <dd>${item.comparability_status ?? 'unknown'}</dd>
          <dt>Search/fetch events</dt>
          <dd>${item.search_events.length}</dd>
          <dt>Reported sources</dt>
          <dd>${item.source_observations.length}</dd>
          <dt>Final-answer citations</dt>
          <dd>${item.answer_citations.length || item.citations.length}</dd>
          <dt>Redacted event artifact</dt>
          <dd>${item.artifact_ref ?? 'not retained'}</dd>
        </dl>
        ${item.search_events.length > 0
          ? html`<ul class="evidence-list">${item.search_events.map((event) => html`<li>${event.event_type} · ${event.status}${event.queries.length > 0 ? html` · ${event.queries.join(' · ')}` : event.query ? html` · ${event.query}` : ' · query not exposed'}${event.url ? html` · ${event.url}` : ''}</li>`)}</ul>`
          : ''}
        ${item.source_observations.length > 0 ? html`<p>Reported sources</p><ul class="evidence-list">${item.source_observations.map((source) => html`<li>${/^https?:\/\//i.test(source.url) ? html`<a href="${source.url}" rel="noreferrer noopener nofollow" target="_blank">${source.title ?? source.url}</a>` : source.title ?? source.url}</li>`)}</ul>` : ''}
        ${item.answer_citations.length > 0 ? html`<p>Final-answer citations</p><ul class="evidence-list">${item.answer_citations.map((citation) => html`<li>${/^https?:\/\//i.test(citation.url) ? html`<a href="${citation.url}" rel="noreferrer noopener nofollow" target="_blank">${citation.url}</a>` : citation.url}</li>`)}</ul>` : ''}
      </details>`
    : '';

  return html`<article class="card answer">
    ${head}
    ${charge}
    <p class="answer-prompt">${item.prompt}</p>
    ${view.series ? html`<p><a href="/evidence?days=${view.filters.days}&amp;series_id=${encodeURIComponent(view.series.id)}&amp;receipt_id=${item.id}&amp;layer=answers">View the five evidence layers for receipt #${item.id}</a></p>` : ''}
    <div class="answer-text">${raw(highlightAnswer(item.text ?? '', view.entities, view.colorIndex))}</div>
    ${searchSuggestions(item.grounding_receipt)}
    ${recommended ? html`<p><span class="pill pill-good">recommended</span></p>` : ''}
    ${labels.length ? html`<details class="answer-evidence"><summary>Review brand stance (${review.revision}, corrections through #${review.correctionCutoff})</summary><ul>${labels}</ul></details>` : ''}
    ${citations.length > 0 ? html`<p class="cite-row">${citations}</p>` : ''}
    ${evidence}
    ${originalGrounding(item.grounding_receipt)}
  </article>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const { result } = view;
  const body =
    result.total === 0
      ? html`${filterRow(view)}${emptyState({
          title: 'No answers match',
          line: 'Nothing is stored for these filters in the selected window.',
          hint: 'Raw provider answers appear here as soon as a panel run completes — every number links back to them.',
          action: { href: '/answers', label: 'Clear filters' },
        })}`
      : html`${filterRow(view)}
          <p class="result-count muted">
            ${result.total} answers · page ${result.page} of ${result.pages} · ${view.series?.surface ?? 'no series'}
            · ${view.series?.start ?? ''} to ${view.series?.end ?? ''} UTC · ${view.filters.eligibleOnly ? 'comparable only' : 'all target states'}
          </p>
          ${result.items.map((item) => answerCard(view, item))}${pager(view)}`;

  return layout({ title: 'Answers', active: '/answers', ctx, body });
}
