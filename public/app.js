/**
 * The only client-side script (§11.2, §11.7): theme toggle, chart tooltips, sortable
 * tables, the run button's poll loop, and the small fetch-and-reload actions behind
 * the CRUD pages.
 *
 * Plain vanilla ES module. No framework, no build step, no dependencies, no inline
 * handlers — the page's CSP allows `script-src 'self'` and nothing else (§10.1).
 * Everything here is progressive: with JS off the pages still render and the GET
 * filter forms still work.
 */

/* ------------------------------------------------------------------ *
 * Theme (§11.2) — auto / light / dark, remembered in localStorage.
 * ------------------------------------------------------------------ */

const THEME_KEY = 'hearsay:theme';
const MODES = ['auto', 'light', 'dark'];

/** @returns {string} */
function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value && MODES.includes(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** @param {string} mode */
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);

  for (const button of document.querySelectorAll('[data-theme-set]')) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-theme-set') === mode));
  }
}

/** @param {string} mode */
function setTheme(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* private mode — the choice just will not persist */
  }
  applyTheme(mode);
}

function initTheme() {
  applyTheme(storedTheme());
  for (const button of document.querySelectorAll('[data-theme-set]')) {
    button.addEventListener('click', () => {
      setTheme(button.getAttribute('data-theme-set') ?? 'auto');
    });
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * @param {string} url
 * @param {string} method
 * @param {unknown} [body]
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
async function api(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Show an API error near the control that caused it. Messages come from the server's
 * §10.3 envelope; nothing is invented client-side.
 * @param {Element|null} scope
 * @param {any} data
 */
function showError(scope, data) {
  const message = data && data.error && data.error.message ? data.error.message : 'That did not work.';
  const target = scope ? scope.closest('section')?.querySelector('[data-form-error]') : null;
  if (target instanceof HTMLElement) {
    target.textContent = message;
    target.hidden = false;
    return;
  }
  window.alert(message);
}

/* ------------------------------------------------------------------ *
 * Chart tooltips (§11.7) — one shared, absolutely positioned layer.
 * ------------------------------------------------------------------ */

/** @type {HTMLElement|null} */
let tip = null;

/** @returns {HTMLElement} */
function tooltip() {
  if (tip === null) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

/** @param {number} epochDay */
function dayLabel(epochDay) {
  return new Date(epochDay * 86400000).toISOString().slice(0, 10);
}

/**
 * @param {SVGSVGElement} svg
 */
function initLineChart(svg) {
  /** @type {any} */
  let chart;
  try {
    chart = JSON.parse(svg.getAttribute('data-chart') ?? '');
  } catch {
    return;
  }
  if (!chart || chart.kind !== 'line' || !Array.isArray(chart.series)) return;

  const crosshair = svg.querySelector('.chart-crosshair');
  const xs = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  if (xs.length === 0) return;

  /** @param {MouseEvent|Touch} point */
  const nearest = (point) => {
    const box = svg.getBoundingClientRect();
    // The SVG is drawn in viewBox units; scale the pointer into them.
    const scale = box.width === 0 ? 1 : svg.viewBox.baseVal.width / box.width;
    const x = (point.clientX - box.left) * scale;
    const t = (x - chart.plot.left) / chart.plot.width;
    const target = chart.xMin + t * (chart.xMax - chart.xMin);
    return xs.reduce((best, candidate) => (Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best), xs[0]);
  };

  /** @param {number} day @param {number} clientX @param {number} clientY */
  const show = (day, clientX, clientY) => {
    const rows = chart.series
      .map((s) => {
        const hit = s.points.find((p) => p[0] === day);
        return hit ? { name: s.name, color: s.color, value: hit[1] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.value - a.value);
    if (rows.length === 0) return;

    const node = tooltip();
    node.textContent = '';
    const head = document.createElement('p');
    head.className = 'tooltip-head';
    head.textContent = dayLabel(day);
    node.append(head);
    for (const row of rows) {
      const line = document.createElement('p');
      line.className = 'tooltip-row';
      const swatch = document.createElement('span');
      swatch.className = 'tooltip-chip';
      swatch.style.background = row.color;
      const label = document.createElement('span');
      label.textContent = row.name;
      const value = document.createElement('strong');
      value.textContent = `${Math.round(row.value * 100)}%`;
      line.append(swatch, label, value);
      node.append(line);
    }
    node.hidden = false;
    node.style.left = `${Math.round(clientX + window.scrollX + 12)}px`;
    node.style.top = `${Math.round(clientY + window.scrollY + 12)}px`;

    if (crosshair instanceof SVGElement) {
      const t = (day - chart.xMin) / Math.max(1, chart.xMax - chart.xMin);
      const px = chart.plot.left + t * chart.plot.width;
      crosshair.setAttribute('x1', String(px));
      crosshair.setAttribute('x2', String(px));
      crosshair.removeAttribute('hidden');
    }
  };

  const hide = () => {
    tooltip().hidden = true;
    if (crosshair instanceof SVGElement) crosshair.setAttribute('hidden', 'hidden');
  };

  svg.addEventListener('mousemove', (event) => {
    show(nearest(event), event.clientX, event.clientY);
  });
  svg.addEventListener('mouseleave', hide);
  // Touch: a tap toggles the tooltip rather than tracking a finger.
  svg.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    if (tooltip().hidden) show(nearest(touch), touch.clientX, touch.clientY);
    else hide();
  });
}

function initCharts() {
  for (const svg of document.querySelectorAll('svg[data-chart]')) {
    if (svg instanceof SVGSVGElement) initLineChart(svg);
  }
}

/* ------------------------------------------------------------------ *
 * Sortable tables (§11.3) — client-side only, on data already rendered.
 * ------------------------------------------------------------------ */

function initSortableTables() {
  for (const table of document.querySelectorAll('table.table-sortable')) {
    const headers = [...table.querySelectorAll('th[data-sortable]')];
    headers.forEach((th, index) => {
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      th.setAttribute('aria-sort', 'none');
      const sort = () => {
        const body = table.querySelector('tbody');
        if (!(body instanceof HTMLElement)) return;
        const descending = th.getAttribute('aria-sort') !== 'descending';
        const rows = [...body.querySelectorAll('tr')];
        rows.sort((a, b) => {
          const cellA = a.children[index];
          const cellB = b.children[index];
          const rawA = cellA?.getAttribute('data-sort');
          const rawB = cellB?.getAttribute('data-sort');
          if (rawA !== null && rawA !== undefined && rawB !== null && rawB !== undefined) {
            return descending ? Number(rawB) - Number(rawA) : Number(rawA) - Number(rawB);
          }
          const textA = cellA?.textContent?.trim() ?? '';
          const textB = cellB?.textContent?.trim() ?? '';
          return descending ? textB.localeCompare(textA) : textA.localeCompare(textB);
        });
        for (const row of rows) body.append(row);
        for (const other of headers) other.setAttribute('aria-sort', 'none');
        th.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      };
      th.addEventListener('click', sort);
      th.addEventListener('keydown', (event) => {
        if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          sort();
        }
      });
    });
  }
}

/* ------------------------------------------------------------------ *
 * Run panel + progress polling (§11.2)
 * ------------------------------------------------------------------ */

/** @type {number|undefined} */
let pollTimer;

async function pollRun() {
  const { ok, data } = await api('/api/runs/latest', 'GET');
  const bar = document.getElementById('run-progress-bar');
  const wrap = document.getElementById('run-progress');
  const line = document.getElementById('last-run');
  if (!ok || !data) return false;

  const done = Number(data.done_calls ?? 0);
  const total = Number(data.total_calls ?? 0);
  if (data.status === 'running') {
    if (wrap instanceof HTMLElement) wrap.hidden = false;
    if (bar instanceof HTMLElement) bar.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
    if (line instanceof HTMLElement) line.textContent = `Running · ${done}/${total} calls`;
    return true;
  }
  if (wrap instanceof HTMLElement) wrap.hidden = true;
  if (line instanceof HTMLElement) line.textContent = `Last run ${data.status} · ${done}/${total} calls`;
  return false;
}

function startPolling() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(async () => {
    const stillRunning = await pollRun();
    if (!stillRunning) {
      window.clearInterval(pollTimer);
      window.location.reload();
    }
  }, 2000);
}

/** @param {HTMLElement} button */
async function triggerRun(button) {
  button.setAttribute('disabled', 'disabled');
  const first = await api('/api/run', 'POST', {});
  if (!first.ok) {
    button.removeAttribute('disabled');
    showError(button, first.data);
    return;
  }
  // SPEC §3.3: the server is the single source of truth for the cost gate — this
  // handler only relays the quote and echoes the human's yes as {confirm:true}.
  if (first.data && first.data.status === 'quote_required') {
    const usd = first.data.estUsd === null
      ? first.data.knownSubtotalUsd === null
        ? 'unknown cost'
        : `at least $${Number(first.data.knownSubtotalUsd).toFixed(2)} plus unknown costs`
      : `≈ $${Number(first.data.estUsd).toFixed(2)}`;
    const searchNote = first.data.hasSearch
      ? `\nWeb search is enabled. The estimate assumes one search call per search-enabled target.${first.data.hasUnboundedSearch ? ' OpenAI has no enforceable internal search-call ceiling.' : ' Anthropic caps search calls as shown in the preview.'}` : '';
    if (!window.confirm(`This run makes ${first.data.calls} API calls (${usd}).${searchNote} Start it?`)) {
      button.removeAttribute('disabled');
      return;
    }
    const go = await api('/api/run', 'POST', { confirm: true, quote_id: first.data.quoteId });
    if (!go.ok) {
      button.removeAttribute('disabled');
      showError(button, go.data);
      return;
    }
  }
  await pollRun();
  startPolling();
}

function initRunButton() {
  for (const id of ['run-panel', 'run-panel-setup']) {
    const button = document.getElementById(id);
    if (button instanceof HTMLElement && !button.hasAttribute('disabled')) {
      button.addEventListener('click', () => {
        void triggerRun(button);
      });
    }
  }
  // A run started elsewhere (cron, CLI, an agent over MCP) should still show progress.
  void pollRun().then((running) => {
    if (running) startPolling();
  });
}

/* ------------------------------------------------------------------ *
 * CRUD: fetch against §10.3, then reload. No client-side state.
 * ------------------------------------------------------------------ */

/**
 * @param {HTMLFormElement} form
 * @returns {Record<string, unknown>}
 */
function formPayload(form) {
  /** @type {Record<string, unknown>} */
  const payload = {};
  for (const field of form.querySelectorAll('input, select, textarea')) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
    const name = field.name;
    if (!name) continue;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      payload[name] = field.checked;
      continue;
    }
    const value = field.hasAttribute('data-preserve-whitespace') ? field.value : field.value.trim();
    if (field.hasAttribute('data-list')) {
      payload[name] = value === '' ? [] : value.split(',').map((part) => part.trim()).filter((part) => part !== '');
    } else if (field.hasAttribute('data-bool')) {
      payload[name] = value === 'true' || value === '1';
    } else if (value !== '' || field.hasAttribute('data-include-empty')) {
      payload[name] = value;
    }
  }
  return payload;
}

function initApiForms() {
  for (const form of document.querySelectorAll('form[data-api-form]')) {
    if (!(form instanceof HTMLFormElement)) continue;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const url = form.getAttribute('data-api-form') ?? '';
      const method = form.getAttribute('data-method') ?? 'POST';
      const payload = formPayload(form);
      const first = await api(url, method, payload);
      if (!first.ok) {
        showError(form, first.data);
        return;
      }
      if (form.hasAttribute('data-subscription-schedule') && first.data?.status === 'schedule_confirmation_required') {
        const targets = Number(first.data.totalTargets ?? 0);
        const ceiling = Number(first.data.targetCeiling ?? targets);
        const surfaces = Array.isArray(first.data.surfaces) ? first.data.surfaces.join(', ') : 'selected surfaces';
        if (!window.confirm(`Enable ${surfaces} at ${first.data.runAt} for ${targets} current target(s), with a ceiling of ${ceiling} per occurrence? This uses subscription allowance. Internal web searches have no enforceable call ceiling.`)) return;
        const confirmed = await api(url, method, { ...payload, confirm: true, quote_id: first.data.quoteId });
        if (!confirmed.ok) {
          showError(form, confirmed.data);
          return;
        }
      }
      if (form.hasAttribute('data-subscription-run') && first.data?.status === 'quote_required') {
        const targets = Number(first.data.totalTargets ?? 0);
        const surfaces = Array.isArray(first.data.surfaces) ? first.data.surfaces.join(', ') : 'selected surfaces';
        if (!window.confirm(`Run ${surfaces} for ${targets} target(s)? This uses subscription allowance. Internal web searches have no enforceable call ceiling.`)) return;
        const confirmed = await api(url, method, { ...payload, confirm: true, quote_id: first.data.quoteId });
        if (!confirmed.ok) {
          showError(form, confirmed.data);
          return;
        }
      }
      window.location.reload();
    });
  }
}

function initRowActions() {
  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const subscriptionCancel = target.getAttribute('data-subscription-cancel');
    if (subscriptionCancel !== null) {
      target.setAttribute('disabled', 'disabled');
      const { ok, data } = await api(`/api/subscription/runs/${subscriptionCancel}/cancel`, 'POST', {});
      if (!ok) {
        target.removeAttribute('disabled');
        showError(target, data);
      } else {
        await pollRun();
        startPolling();
      }
      return;
    }

    const ack = target.getAttribute('data-ack');
    if (ack !== null) {
      const { ok, data } = await api(`/api/alerts/${ack}/ack`, 'POST', {});
      if (ok) window.location.reload();
      else showError(target, data);
      return;
    }

    const promptDelete = target.getAttribute('data-prompt-delete');
    if (promptDelete !== null) {
      const { ok, data } = await api(`/api/prompts/${promptDelete}`, 'DELETE');
      if (ok) window.location.reload();
      else showError(target, data);
      return;
    }

    const entityDelete = target.getAttribute('data-entity-delete');
    if (entityDelete !== null) {
      const { ok, data } = await api(`/api/entities/${entityDelete}`, 'DELETE');
      if (ok) window.location.reload();
      else showError(target, data);
    }
  });

  document.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const promptActive = target.getAttribute('data-prompt-active');
    if (promptActive !== null && target instanceof HTMLInputElement) {
      const row = target.closest('tr');
      const question = row?.querySelector('[data-prompt-question]')?.textContent ?? '';
      const category = row?.querySelector('select[name^="category-"]');
      if (target.checked && !window.confirm(`Approve this exact question for tracking?\n\n${question}\nCategory: ${category instanceof HTMLSelectElement ? category.value : 'general'}`)) {
        target.checked = false;
        return;
      }
      const { ok, data } = await api(`/api/prompts/${promptActive}`, 'PATCH',
        { active: target.checked, ...(target.checked ? { reviewed: true } : {}) });
      if (!ok) {
        target.checked = !target.checked;
        showError(target, data);
      } else window.location.reload();
      return;
    }

    const entitySelf = target.getAttribute('data-entity-self');
    if (entitySelf !== null && target instanceof HTMLInputElement && target.checked) {
      const { ok, data } = await api(`/api/entities/${entitySelf}`, 'PATCH', { is_self: true });
      if (ok) window.location.reload();
      else showError(target, data);
      return;
    }

    const entityAmbiguous = target.getAttribute('data-entity-ambiguous');
    if (entityAmbiguous !== null && target instanceof HTMLInputElement) {
      const { ok, data } = await api(`/api/entities/${entityAmbiguous}`, 'PATCH', { ambiguous_name: target.checked });
      if (!ok) {
        target.checked = !target.checked;
        showError(target, data);
      }
      return;
    }

    const setting = target.getAttribute('data-setting');
    if (setting !== null && target instanceof HTMLInputElement) {
      const { ok, data } = await api('/api/settings', 'PATCH', { [setting]: target.checked });
      if (!ok) {
        target.checked = !target.checked;
        showError(target, data);
      }
      return;
    }

    // Category selects are named `category-<id>` on the prompts page.
    const name = target.getAttribute('name') ?? '';
    if (name.startsWith('category-') && target instanceof HTMLSelectElement) {
      const id = name.slice('category-'.length);
      const row = target.closest('tr');
      const question = row?.querySelector('[data-prompt-question]')?.textContent ?? '';
      const old = row?.querySelector('[data-current-category]')?.getAttribute('data-current-category') ?? 'general';
      if (!window.confirm(`Approve this exact question for tracking?\n\n${question}\nNew category: ${target.value}`)) {
        target.value = old;
        return;
      }
      const { ok, data } = await api(`/api/prompts/${id}`, 'PATCH', { category: target.value, reviewed: true });
      if (!ok) {
        target.value = old;
        showError(target, data);
      } else window.location.reload();
    }
  });
}

function initPromptPanelReview() {
  const button = document.getElementById('prompt-panel-review');
  if (!(button instanceof HTMLElement)) return;
  button.addEventListener('click', async () => {
    button.setAttribute('disabled', 'disabled');
    const preview = await api('/api/prompts/review', 'GET');
    if (!preview.ok) {
      button.removeAttribute('disabled');
      return showError(button, preview.data);
    }
    const questions = (preview.data.questions ?? []).map((question) =>
      `${question.text} [${question.category === 'general' ? 'discovery' : question.category}]`);
    const entities = (preview.data.entities ?? []).map((entity) => {
      const aliases = JSON.parse(entity.aliases ?? '[]');
      const domains = JSON.parse(entity.domains ?? '[]');
      return `${entity.isSelf ? 'Brand' : 'Competitor'}: ${entity.name}, aliases: ${aliases.join(', ') || 'none'}, domains: ${domains.join(', ') || 'none'}`;
    });
    const message = [
      'Approve these exact questions and entities for tracking?',
      '',
      ...questions,
      '',
      ...entities,
      '',
      `First run: ${preview.data.apiCalls} API calls and ${preview.data.subscriptionCalls} subscription calls, ${preview.data.totalCalls} total.`,
      'Context and source notes stay local. Runs already queued keep their earlier snapshots.',
    ].join('\n');
    if (!window.confirm(message)) {
      button.removeAttribute('disabled');
      return;
    }
    const saved = await api('/api/prompts/review', 'POST',
      { review_hash: preview.data.reviewHash, reviewed: true });
    if (!saved.ok) {
      button.removeAttribute('disabled');
      return showError(button, saved.data);
    }
    window.location.reload();
  });
}

/* ------------------------------------------------------------------ *
 * Setup wizard step 2: one local draft, exact review, atomic approval.
 * ------------------------------------------------------------------ */

const SETUP_DRAFT_KEY = 'hearsay:setup-draft-id';

/** @param {string} text @param {HTMLElement} control */
function suggestLabel(text, control) {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = text;
  label.append(caption, control);
  return label;
}

/** @param {string} value @param {string} marker */
function suggestInput(value, marker) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.setAttribute(marker, '');
  return input;
}

/**
 * @param {{text:string,sourceNote?:string|null,selected?:boolean}} phrase
 * @returns {HTMLElement}
 */
function suggestPhrase(phrase) {
  const row = document.createElement('div');
  row.className = 'inline-form';
  row.setAttribute('data-suggest-phrasing', '');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = phrase.selected !== false;
  check.setAttribute('data-suggest-check', '');
  row.append(suggestLabel('Track this phrasing', check));
  const question = document.createElement('textarea');
  question.rows = 2;
  question.value = phrase.text;
  question.setAttribute('data-suggest-text', '');
  question.maxLength = 300;
  question.required = true;
  row.append(suggestLabel('Exact buyer question', question));
  const note = document.createElement('textarea');
  note.rows = 2;
  note.value = phrase.sourceNote ?? '';
  note.setAttribute('data-suggest-note', '');
  row.append(suggestLabel('Source note (local only)', note));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-sm';
  remove.textContent = 'Remove phrasing';
  remove.addEventListener('click', () => row.remove());
  row.append(remove);
  return row;
}

/**
 * @param {{label:string,category:string,paraphrases:(string|{text:string,sourceNote?:string|null,selected?:boolean})[]}} intent
 * @returns {HTMLElement}
 */
function suggestIntent(intent) {
  const block = document.createElement('fieldset');
  block.className = 'card';
  block.setAttribute('data-suggest-intent', '');
  const title = document.createElement('legend');
  title.textContent = 'Buyer intent';
  block.append(title);
  block.append(suggestLabel('Intent or decision', suggestInput(intent.label, 'data-suggest-label')));
  const category = document.createElement('select');
  category.setAttribute('data-suggest-category', '');
  for (const [value, label] of [['general', 'Discovery'], ['comparison', 'Comparison'], ['branded', 'Branded']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    category.append(option);
  }
  category.value = ['general', 'comparison', 'branded'].includes(intent.category) ? intent.category : 'general';
  block.append(suggestLabel('Question type', category));
  const phrases = document.createElement('div');
  phrases.setAttribute('data-suggest-phrasings', '');
  for (const phrase of intent.paraphrases) {
    phrases.append(suggestPhrase(typeof phrase === 'string' ? { text: phrase } : phrase));
  }
  block.append(phrases);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm';
  add.textContent = 'Add phrasing';
  add.addEventListener('click', () => phrases.append(suggestPhrase({ text: '' })));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-sm';
  remove.textContent = 'Remove intent';
  remove.addEventListener('click', () => block.remove());
  block.append(add, remove);
  return block;
}

/** @param {HTMLElement} scope @param {string} selector */
function suggestValue(scope, selector) {
  const field = scope.querySelector(selector);
  return field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement
    ? field.value.trim() : '';
}

function initSuggest() {
  const list = document.getElementById('suggest-list');
  const form = document.getElementById('suggest-form');
  const addIntent = document.getElementById('suggest-add-intent');
  const reviewButton = document.getElementById('suggest-review');
  const approveButton = document.getElementById('suggest-approve');
  const reviewPanel = document.getElementById('suggest-review-panel');
  const reviewDetails = document.getElementById('suggest-review-details');
  const status = document.getElementById('suggest-status');
  if (!(list instanceof HTMLElement && form instanceof HTMLFormElement && addIntent instanceof HTMLElement &&
        reviewButton instanceof HTMLElement && approveButton instanceof HTMLElement && reviewPanel instanceof HTMLElement &&
        reviewDetails instanceof HTMLElement && status instanceof HTMLElement)) return;

  /** @type {number|null} */
  let draftId = null;
  /** @type {number|null} */
  let revision = null;
  /** @type {string|null} */
  let reviewHash = null;
  const clearReview = () => {
    reviewHash = null;
    reviewPanel.hidden = true;
    status.hidden = true;
  };
  list.addEventListener('input', clearReview);
  list.addEventListener('change', clearReview);
  list.addEventListener('click', clearReview);
  form.addEventListener('input', clearReview);

  const context = () => ({
    audience: suggestValue(form, '[name="audience"]'),
    productJob: suggestValue(form, '[name="productJob"]'),
    desiredConversion: suggestValue(form, '[name="desiredConversion"]'),
    languagePreference: suggestValue(form, '[name="languagePreference"]'),
    marketContext: suggestValue(form, '[name="marketContext"]'),
    contextNotes: suggestValue(form, '[name="contextNotes"]'),
  });
  /** @type {{name:string,aliases:string[],domains:string[],isSelf:boolean}[]} */
  let entities = [];
  try { entities = JSON.parse(list.getAttribute('data-entities') ?? '[]'); } catch { /* no saved entities */ }
  const brand = entities.find((entity) => entity.isSelf);
  const competitors = entities.filter((entity) => !entity.isSelf);
  let draftBrand = null;
  let draftCompetitors = [];
  const payload = () => ({
    version: 1,
    context: context(),
    ...(brand ? { brand: { name: brand.name, aliases: brand.aliases, domains: brand.domains } }
      : draftBrand ? { brand: draftBrand } : {}),
    competitors: competitors.length > 0
      ? competitors.map(({ name, aliases, domains }) => ({ name, aliases, domains }))
      : draftCompetitors,
    intents: [...list.querySelectorAll('[data-suggest-intent]')].map((block) => ({
      label: suggestValue(block, '[data-suggest-label]'),
      category: suggestValue(block, '[data-suggest-category]'),
      paraphrases: [...block.querySelectorAll('[data-suggest-phrasing]')].map((row) => ({
        text: suggestValue(row, '[data-suggest-text]'),
        sourceNote: suggestValue(row, '[data-suggest-note]'),
        selected: row.querySelector('[data-suggest-check]') instanceof HTMLInputElement && row.querySelector('[data-suggest-check]').checked,
      })),
    })),
  });

  /** @param {any} saved */
  const showDraft = (saved) => {
    draftId = Number(saved.id);
    revision = Number(saved.revision);
    draftBrand = saved.payload?.brand ?? null;
    draftCompetitors = saved.payload?.competitors ?? [];
    list.replaceChildren(...(saved.payload?.intents ?? []).map(suggestIntent));
    for (const [name, value] of Object.entries(saved.payload?.context ?? {})) {
      const field = form.querySelector(`[name="${name}"]`);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = String(value ?? '');
    }
    try { localStorage.setItem(SETUP_DRAFT_KEY, String(draftId)); } catch { /* storage may be unavailable */ }
    clearReview();
  };

  try {
    const savedId = localStorage.getItem(SETUP_DRAFT_KEY);
    if (savedId && /^\d+$/.test(savedId)) {
      void api(`/api/setup/drafts/${savedId}`, 'GET').then(({ ok, data }) => {
        if (ok) showDraft(data);
        else localStorage.removeItem(SETUP_DRAFT_KEY);
      });
    }
  } catch { /* the editor still works without local storage */ }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (list.querySelector('[data-suggest-intent]') &&
        !window.confirm('Replace the current draft questions with a new five-intent starter?')) return;
    const { ok, data } = await api('/api/prompts/suggest', 'POST', {
      context: context(),
      ...(brand ? { brand: { name: brand.name, aliases: brand.aliases } } : {}),
      competitors: competitors.map(({ name }) => ({ name })),
    });
    if (!ok) return showError(form, data);
    list.replaceChildren(...(data.intents ?? []).map(suggestIntent));
    clearReview();
  });

  addIntent.addEventListener('click', () => {
    list.append(suggestIntent({ label: '', category: 'general', paraphrases: [{ text: '' }] }));
    clearReview();
  });

  reviewButton.addEventListener('click', async () => {
    reviewButton.setAttribute('disabled', 'disabled');
    const current = payload();
    const endpoint = draftId === null ? '/api/setup/drafts' : `/api/setup/drafts/${draftId}`;
    const saved = await api(endpoint, draftId === null ? 'POST' : 'PUT',
      draftId === null ? { payload: current } : { revision, payload: current });
    reviewButton.removeAttribute('disabled');
    if (!saved.ok) return showError(reviewButton, saved.data);
    draftId = Number(saved.data.id);
    revision = Number(saved.data.revision);
    try { localStorage.setItem(SETUP_DRAFT_KEY, String(draftId)); } catch { /* local draft remains available */ }
    const reviewed = await api(`/api/setup/drafts/${draftId}/review`, 'GET');
    if (!reviewed.ok) return showError(reviewButton, reviewed.data);
    reviewHash = reviewed.data.reviewHash;
    reviewDetails.replaceChildren();
    const summary = document.createElement('p');
    summary.textContent = `${reviewed.data.selectedQuestionCount} selected question(s); ${reviewed.data.projectedActiveQuestionCount} active after approval. First run: ${reviewed.data.apiCalls} API calls and ${reviewed.data.subscriptionCalls} subscription calls, ${reviewed.data.totalCalls} total.`;
    reviewDetails.append(summary);
    const route = document.createElement('p');
    route.textContent = reviewed.data.hasRunRoute
      ? 'A measurement route is configured.'
      : 'No measurement route is configured. You can approve now and configure a route before running.';
    reviewDetails.append(route);
    const notes = document.createElement('p');
    notes.textContent = 'Only the exact selected question text goes to providers. Source and context notes stay local.';
    reviewDetails.append(notes);
    const reviewEntities = document.createElement('p');
    reviewEntities.textContent = `Brand: ${current.brand?.name ?? 'none'}; competitors: ${current.competitors.map((entry) => entry.name).join(', ') || 'none'}.`;
    reviewDetails.append(reviewEntities);
    const questions = document.createElement('ol');
    for (const intent of reviewed.data.selectedIntents ?? []) {
      for (const phrase of intent.paraphrases) {
        const item = document.createElement('li');
        item.textContent = `${intent.label} (${phrase.category === 'general' ? 'discovery' : phrase.category}): ${phrase.text}${phrase.sourceNote ? ` — source note: ${phrase.sourceNote}` : ''}`;
        questions.append(item);
      }
    }
    reviewDetails.append(questions);
    const errors = reviewed.data.validationErrors ?? [];
    if (errors.length > 0) {
      const problem = document.createElement('p');
      problem.textContent = errors.map((error) => typeof error === 'string' ? error : error.message ?? String(error)).join(' ');
      reviewDetails.append(problem);
    }
    approveButton.toggleAttribute('disabled', errors.length > 0 || !reviewHash);
    reviewPanel.hidden = false;
  });

  approveButton.addEventListener('click', async () => {
    if (draftId === null || revision === null || reviewHash === null) return;
    approveButton.setAttribute('disabled', 'disabled');
    const result = await api(`/api/setup/drafts/${draftId}/approve`, 'POST',
      { revision, review_hash: reviewHash, approve: true });
    if (!result.ok) {
      approveButton.removeAttribute('disabled');
      return showError(approveButton, result.data);
    }
    try { localStorage.removeItem(SETUP_DRAFT_KEY); } catch { /* approval already succeeded */ }
    draftId = null;
    revision = null;
    reviewHash = null;
    reviewPanel.hidden = true;
    status.textContent = result.data.panelReady
      ? 'Questions approved for tracking. Edits to questions, competitors, or aliases create a new benchmark revision. Runs already queued keep their original question snapshots.'
      : 'Selected questions were approved. Other active questions still need review before a run can start.';
    const next = document.createElement('a');
    next.href = result.data.panelReady ? '/setup?step=3' : '/prompts';
    next.textContent = result.data.panelReady ? 'Review run options' : 'Review active panel';
    status.append(' ', next);
    status.hidden = false;
  });
}

initTheme();
initCharts();
initSortableTables();
initRunButton();
initApiForms();
initRowActions();
initPromptPanelReview();
initSuggest();

function initResearch() {
  for (const form of document.querySelectorAll('[data-research-import], [data-research-review]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('[role="status"]');
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        let result;
        if (form.hasAttribute('data-research-import')) {
          const file = form.querySelector('input[type="file"]').files[0];
          if (!file || file.size > 8 * 1024 * 1024) throw new Error('Select an evidence.json file up to 8 MiB.');
          const bundle = JSON.parse(await file.text());
          result = await api('/api/research/import', 'POST', bundle);
        } else {
          const fields = new FormData(form);
          result = await api(`/api/research/actions/${form.dataset.researchReview}/review`, 'POST', Object.fromEntries(fields));
        }
        if (!result.ok) throw new Error(result.data?.error?.message ?? 'Research request failed');
        location.reload();
      } catch (error) { status.textContent = error.message; button.disabled = false; }
    });
  }
  for (const button of document.querySelectorAll('[data-research-propose]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await api(`/api/research/${button.dataset.researchPropose}/propose`, 'POST', { action_id: button.dataset.actionId });
      const status = button.parentElement.querySelector('[role="status"]');
      status.textContent = result.ok ? 'Proposal saved. Review it in Opportunities before accepting.' : result.data?.error?.message ?? 'Proposal failed';
      if (!result.ok) button.disabled = false;
    });
  }
}
initResearch();
