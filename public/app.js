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
    const searchNote = first.data.hasUnboundedSearch
      ? '\nWeb search is enabled. The estimate assumes one search call per target; the provider has no enforceable search-call ceiling.' : '';
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
    const value = field.value.trim();
    if (field.hasAttribute('data-list')) {
      payload[name] = value === '' ? [] : value.split(',').map((part) => part.trim()).filter((part) => part !== '');
    } else if (field.hasAttribute('data-bool')) {
      payload[name] = value === 'true' || value === '1';
    } else if (value !== '') {
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
      const { ok, data } = await api(`/api/prompts/${promptActive}`, 'PATCH', { active: target.checked });
      if (!ok) {
        target.checked = !target.checked;
        showError(target, data);
      }
      return;
    }

    const entitySelf = target.getAttribute('data-entity-self');
    if (entitySelf !== null && target instanceof HTMLInputElement && target.checked) {
      const { ok, data } = await api(`/api/entities/${entitySelf}`, 'PATCH', { is_self: true });
      if (ok) window.location.reload();
      else showError(target, data);
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
      const { ok, data } = await api(`/api/prompts/${id}`, 'PATCH', { category: target.value });
      if (!ok) showError(target, data);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Setup wizard step 2 (§11.8): draft, review, then save what is ticked.
 * ------------------------------------------------------------------ */

function initSuggest() {
  const list = document.getElementById('suggest-list');
  const save = document.getElementById('suggest-save');
  const form = document.getElementById('suggest-form');

  if (form instanceof HTMLFormElement && list instanceof HTMLElement) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const keywords = form.querySelector('input[name="keywords"]');
      const { ok, data } = await api('/api/prompts/suggest', 'POST', {
        keywords: keywords instanceof HTMLInputElement ? keywords.value : '',
      });
      if (!ok) {
        showError(form, data);
        return;
      }
      list.textContent = '';
      for (const intent of data.intents ?? []) {
        for (const text of intent.paraphrases ?? []) {
          const item = document.createElement('li');
          const label = document.createElement('label');
          label.className = 'check';
          const check = document.createElement('input');
          check.type = 'checkbox';
          check.checked = true;
          check.setAttribute('data-suggest-check', '');
          const input = document.createElement('input');
          input.type = 'text';
          input.size = 60;
          input.value = text;
          input.setAttribute('data-suggest-text', '');
          const category = document.createElement('input');
          category.type = 'hidden';
          category.value = intent.category ?? 'general';
          category.setAttribute('data-suggest-category', '');
          label.append(check, input, category);
          item.append(label);
          list.append(item);
        }
      }
    });
  }

  if (save instanceof HTMLElement && list instanceof HTMLElement) {
    save.addEventListener('click', async () => {
      save.setAttribute('disabled', 'disabled');
      // 409 (duplicate text) and 422 (too long after an edit) are routine here — a
      // failed save must surface, not silently vanish while the wizard advances.
      /** @type {string[]} */
      const failed = [];
      let attempted = 0;
      for (const item of list.querySelectorAll('li')) {
        const check = item.querySelector('[data-suggest-check]');
        const text = item.querySelector('[data-suggest-text]');
        const category = item.querySelector('[data-suggest-category]');
        if (!(check instanceof HTMLInputElement) || !check.checked) continue;
        if (!(text instanceof HTMLInputElement) || text.value.trim() === '') continue;
        attempted += 1;
        const { ok, data } = await api('/api/prompts', 'POST', {
          text: text.value.trim(),
          category: category instanceof HTMLInputElement ? category.value : 'general',
        });
        if (ok) {
          // Saved: untick it so a retry after a partial failure cannot re-post it
          // straight into a 409 duplicate.
          check.checked = false;
        } else {
          failed.push(data && data.error && data.error.message ? data.error.message : 'That did not work.');
        }
      }
      if (failed.length === 0) {
        window.location.href = '/setup?step=3';
        return;
      }
      save.removeAttribute('disabled');
      showError(save, {
        error: { message: `${failed.length} of ${attempted} prompts failed to save — ${failed[0]}` },
      });
    });
  }
}

initTheme();
initCharts();
initSortableTables();
initRunButton();
initApiForms();
initRowActions();
initSuggest();
