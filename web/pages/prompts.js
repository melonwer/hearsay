/**
 * GET /prompts — prompt CRUD, grouped by intent (§11.5, §6.6).
 *
 * Prompts are paraphrases of an intent, so the table is grouped that way and an
 * intent with a single paraphrase carries the nudge: one wording measures one
 * wording. `branded` prompts are badged, because they stay out of the share-of-voice
 * denominator by default (§6.7).
 *
 * Client JS is plain `fetch` against §10.3 followed by a reload — no SPA state.
 */

import { emptyState, html, layout, raw, rateWithCI } from '../layout.js';
import { meter } from '../svg.js';
import { metrics, soft } from '../data.js';
import { CATEGORIES, listIntents } from '../queries.js';
import { listMeasurementSeries, resolveMeasurementSeries } from '../../core/metrics.js';
import { surfaceLabel } from '../../core/subscription-model.js';

/** Window used for the per-prompt mini-meter (§11.5). */
export const WINDOW_DAYS = 30;

/**
 * Pool a prompt's per-provider brand mention rate into the one number the mini-meter
 * shows. Pooling needs counts: without an `n` on each row there is no honest way to
 * combine them, so the meter renders empty instead of averaging percentages.
 *
 * @param {{brandMentionRate?: {p?: number|null, n?: number}|null}[]} perProvider
 * @returns {{p: number|null, n: number}}
 */
export function poolRate(perProvider) {
  let n = 0;
  let weighted = 0;
  let usable = true;
  for (const row of perProvider ?? []) {
    const rate = row?.brandMentionRate;
    if (!rate || typeof rate.p !== 'number' || !Number.isFinite(rate.p)) continue;
    if (typeof rate.n !== 'number' || !Number.isFinite(rate.n)) {
      usable = false;
      continue;
    }
    n += rate.n;
    weighted += rate.p * rate.n;
  }
  if (!usable || n <= 0) return { p: null, n };
  return { p: weighted / n, n };
}

/**
 * @typedef {Object} PromptsView
 * @property {number} days window the per-prompt meter reports on
 * @property {import('../queries.js').Intent[]} intents each with its paraphrases (§6.6)
 * @property {Map<number, {p: number|null, n: number}>} rates prompt id → pooled brand mention rate
 * @property {number} promptCount paraphrases across every intent
 * @property {readonly string[]} categories categories offered in the selects (§11.5)
 * @property {ReturnType<typeof resolveMeasurementSeries>} series
 * @property {ReturnType<typeof listMeasurementSeries>} seriesOptions
 */

/**
 * @param {import('./dashboard.js').PageDeps} deps
 * @param {{days?: number, now?: Date, seriesId?:string}} [opts]
 * @returns {PromptsView}
 */
export function buildView({ db }, opts = {}) {
  const days = opts.days ?? WINDOW_DAYS;
  // §7 takes the clock from its caller and refuses to default it (§19.6 #6).
  const now = opts.now ?? new Date();
  const intents = listIntents(db);
  const seriesOptions = listMeasurementSeries(db, { now, days });
  const series = opts.seriesId
    ? seriesOptions.find((item) => item.id === opts.seriesId) ?? null
    : resolveMeasurementSeries(db, { now, days });
  /** @type {{promptId:number, text:string, category:string, perProvider:{provider:string, brandMentionRate?:{p?:number|null,n?:number}|null}[]}[]} */
  const table = series ? soft(/** @type {*} */ (metrics), 'promptTable', { db, now, days, series }, []) : [];
  /** @type {Map<number, {p: number|null, n: number}>} */
  const rates = new Map(table.map((row) => [row.promptId, poolRate(row.perProvider)]));

  return {
    days,
    intents,
    rates,
    promptCount: intents.reduce((sum, intent) => sum + intent.paraphrases.length, 0),
    categories: CATEGORIES,
    series,
    seriesOptions,
  };
}

/**
 * @param {readonly string[]} categories
 * @param {string} [selected]
 * @param {string} [name]
 * @returns {import('../layout.js').RawHtml}
 */
function categorySelect(categories, selected = 'general', name = 'category') {
  return html`<select name="${name}" aria-label="Category">
    ${categories.map(
      (category) =>
        html`<option value="${category}"${category === selected ? raw(' selected') : ''}>${category}</option>`,
    )}
  </select>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function addForm(view) {
  const intentOptions = view.intents.map((intent) => html`<option value="${intent.id}">${intent.label}</option>`);
  return html`<section class="card">
    <h2>Add a prompt</h2>
    <form class="inline-form" data-api-form="/api/prompts" data-method="POST">
      <label class="grow">
        <span>Prompt text</span>
        <input type="text" name="text" maxlength="300" required placeholder="What's the best … for …?" />
      </label>
      <label>
        <span>Category</span>
        ${categorySelect(view.categories)}
      </label>
      <label>
        <span>Intent</span>
        <select name="intent_id">
          <option value="">New intent</option>
          ${intentOptions}
        </select>
      </label>
      <button type="submit" class="btn">Add prompt</button>
    </form>
    <p class="muted small">
      Up to 300 characters, and each prompt text has to be unique. Adding one without an intent creates a
      single-paraphrase intent for it.
    </p>
    <p class="form-error" data-form-error hidden></p>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @param {import('../queries.js').Intent} intent
 * @returns {import('../layout.js').RawHtml}
 */
function intentBlock(view, intent) {
  const rows = intent.paraphrases.map((prompt) => {
    const rate = view.rates.get(prompt.id) ?? { p: null, n: 0 };
    return html`<tr data-prompt-id="${prompt.id}">
      <td>
        ${prompt.text}
        ${prompt.category === 'branded'
          ? html`<span class="tag" title="Branded prompts measure recall, not discovery — excluded from share of voice"
              >branded</span
            >`
          : ''}
      </td>
      <td>${categorySelect(view.categories, prompt.category, `category-${prompt.id}`)}</td>
      <td>
        <label class="switch">
          <input type="checkbox" data-prompt-active="${prompt.id}"${prompt.active === 1 ? raw(' checked') : ''} />
          <span>active</span>
        </label>
      </td>
      <td class="num">
        ${raw(meter({ value: rate.p, w: 90, title: `Brand mention rate, ${view.days} days` }))}
        ${rateWithCI({ p: rate.p, n: rate.n })}
      </td>
      <td class="num"><button type="button" class="btn btn-sm" data-prompt-delete="${prompt.id}">Delete</button></td>
    </tr>`;
  });

  return html`<section class="card">
    <h2>${intent.label}</h2>
    <p class="muted small">
      ${intent.paraphrases.length === 1
        ? 'One paraphrase measures one wording. Add two more for a phrasing-robust number.'
        : `${intent.paraphrases.length} paraphrases — the intent's number is pooled across all of them.`}
    </p>
    <table class="table">
      <thead>
        <tr>
          <th>Paraphrase</th>
          <th>Category</th>
          <th>Active</th>
          <th class="num">Brand mention rate (${view.days}d)</th>
          <th class="num"></th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const seriesPicker = view.seriesOptions.length ? html`<form method="get" action="/prompts" class="card filter-row">
    <label>Measurement series <select name="series_id">${view.seriesOptions.map((item) => html`<option
      value="${item.id}"${item.id === view.series?.id ? raw(' selected') : ''}>${surfaceLabel(item.surface)} ·
      ${item.searchPolicy ?? 'legacy'} · ${item.analysisRevision ?? 'legacy'} ·
      ${item.comparableAnswers}/${item.attemptedTargets} comparable</option>`)}</select></label>
    <input type="hidden" name="days" value="${view.days}" />
    <button type="submit" class="btn">Show series</button>
  </form>` : '';
  const body =
    view.promptCount === 0
      ? html`${seriesPicker}${addForm(view)}${emptyState({
          title: 'No prompts yet',
          line: 'Prompts are the questions Hearsay asks each engine, grouped into intents.',
          hint: 'Three paraphrases per intent gives you a phrasing-robust number instead of one lucky wording.',
          action: { href: '/setup', label: 'Suggest prompts' },
        })}`
      : html`${seriesPicker}${addForm(view)}${view.intents
          .filter((intent) => intent.paraphrases.length > 0)
          .map((intent) => intentBlock(view, intent))}`;

  return layout({ title: 'Prompts', active: '/prompts', ctx, body });
}
