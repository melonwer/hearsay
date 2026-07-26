/**
 * GET /answers — the receipts explorer (§11.4).
 *
 * Filtering and pagination are server-side: query params in, one rendered page out.
 * There is no client router and no client-side copy of the dataset. Entity mentions
 * are marked in the answer text with the analyser's own spans (§6.2), so what is
 * highlighted and what was counted can never disagree.
 */

import { emptyState, html, layout, PROVIDER_LABEL, providerBadge, raw, relTime, truncate } from '../layout.js';
import { highlightAnswer } from '../highlight.js';
import { colorIndexFor, listEntities, listPrompts, PROVIDERS, queryAnswers } from '../queries.js';

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
 * @property {number|null} promptId
 * @property {number|null} entityId
 * @property {number} days
 * @property {number} page 1-based
 * @property {number} per
 */

/**
 * @typedef {Object} AnswersView
 * @property {AnswerFilterState} filters
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
  const filters = {
    provider: provider !== null && PROVIDERS.includes(provider) ? provider : null,
    promptId: intParam(query, 'prompt_id'),
    entityId: intParam(query, 'entity_id'),
    days: intParam(query, 'days') ?? 30,
    page: intParam(query, 'page') ?? 1,
    per: 20,
  };
  return {
    filters,
    entities,
    prompts,
    colorIndex: colorIndexFor(entities),
    result: queryAnswers(db, filters),
    nowMs: Date.now(),
  };
}

/**
 * Rebuild the query string with one value changed — how the range presets and the
 * pager keep every other filter intact.
 *
 * @param {{provider: string|null, promptId: number|null, entityId: number|null, days: number, page: number}} filters
 * @param {Record<string, string|number|null>} [patch]
 * @returns {string}
 */
export function queryString(filters, patch = {}) {
  /** @type {Record<string, string|number|null>} */
  const merged = {
    provider: filters.provider,
    prompt_id: filters.promptId,
    entity_id: filters.entityId,
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
  const providerOptions = PROVIDERS.map(
    (id) =>
      html`<option value="${id}"${filters.provider === id ? raw(' selected') : ''}>${PROVIDER_LABEL[id] ?? id}</option>`,
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
      <span>Entity</span>
      <select name="entity_id">
        <option value="">Any entity</option>
        ${entityOptions}
      </select>
    </label>
    <input type="hidden" name="days" value="${filters.days}" />
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
  const head = html`<header class="answer-head">
    ${providerBadge(item.provider)}
    <span class="muted answer-model">${item.model}</span>
    <span class="muted">${relTime(item.created_at, view.nowMs)}</span>
    <span class="muted">sample #${item.sample_idx + 1}</span>
  </header>`;

  if (item.error !== null) {
    // Errored responses collapse behind their error-kind chip (§11.4).
    const kind = item.error.split(':')[0];
    return html`<article class="card answer is-error">
      ${head}
      <p class="answer-prompt">${item.prompt}</p>
      <details>
        <summary><span class="pill pill-error">${kind}</span> No answer stored for this call</summary>
        <p class="muted">${item.error}</p>
      </details>
    </article>`;
  }

  const recommended = item.mentions.some((mention) => mention.recommended === 1);
  const citations = item.citations.map((citation) => {
    const slot = citation.entity_id === null ? undefined : view.colorIndex.get(citation.entity_id);
    return html`<a
      class="cite${slot === undefined ? '' : ` cite-s${slot + 1}`}"
      href="${citation.url}"
      rel="noreferrer noopener nofollow"
      target="_blank"
      >${citation.domain}</a
    >`;
  });

  return html`<article class="card answer">
    ${head}
    <p class="answer-prompt">${item.prompt}</p>
    <div class="answer-text">${raw(highlightAnswer(item.text ?? '', view.entities, view.colorIndex))}</div>
    ${recommended ? html`<p><span class="pill pill-good">recommended</span></p>` : ''}
    ${citations.length > 0 ? html`<p class="cite-row">${citations}</p>` : ''}
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
            ${result.total} answers · page ${result.page} of ${result.pages} · last ${view.filters.days} days
          </p>
          ${result.items.map((item) => answerCard(view, item))}${pager(view)}`;

  return layout({ title: 'Answers', active: '/answers', ctx, body });
}
