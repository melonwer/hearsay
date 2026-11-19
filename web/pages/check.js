/**
 * Dedicated `/check` Site X-Ray Workbench page (§10.2, Option 1 Web UI).
 *
 * Pure SSR view + shell for `public/check.js` (zero inline scripts, zero inline event
 * handlers, strict CSP `script-src 'self'`, strict HTML auto-escaping via `html`).
 * Pre-renders saved SQLite check history and the active/latest check summary server-side
 * so the workbench is immediately useful before client JS runs.
 */

import { getSiteCheck, listSiteChecks } from '../../core/site-check-store.js';
import { html, layout, raw, relTime, truncate } from '../layout.js';
import { listEntities } from '../queries.js';

/**
 * @typedef {import('../../core/site-check-store.js').SiteCheckSummary} SiteCheckSummary
 * @typedef {import('../../core/site-check-store.js').SavedSiteCheck} SavedSiteCheck
 */

/**
 * @typedef {Object} CheckPageView
 * @property {SiteCheckSummary[]} history
 * @property {SavedSiteCheck|null} selectedCheck
 * @property {string} prefillUrl
 * @property {string} placeholderUrl
 * @property {number} nowMs
 */

/**
 * Build the view model for `GET /check`.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @param {URLSearchParams} [searchParams]
 * @returns {CheckPageView}
 */
export function buildView({ db }, searchParams = new URLSearchParams()) {
  const history = listSiteChecks(db, { limit: 25 });

  const rawId = searchParams.get('id');
  /** @type {SavedSiteCheck|null} */
  let selectedCheck = null;
  if (rawId && /^\d+$/.test(rawId.trim())) {
    selectedCheck = getSiteCheck(db, Number(rawId.trim()));
  } else if (searchParams.get('new') !== '1' && history.length > 0) {
    selectedCheck = getSiteCheck(db, history[0].id);
  }

  const rawUrlParam = (searchParams.get('url') ?? '').trim();
  const prefillUrl = /^https?:\/\//i.test(rawUrlParam)
    ? rawUrlParam.slice(0, 2048)
    : selectedCheck?.url ?? '';

  let placeholderUrl = 'https://example.com';
  try {
    const selfEntity = listEntities(db).find((e) => e.is_self === 1);
    const domain = selfEntity?.domains?.[0];
    if (typeof domain === 'string' && domain.trim() !== '') {
      const clean = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (clean) placeholderUrl = `https://${clean}`;
    }
  } catch {
    /* ignore lookup failure on empty/custom DB */
  }

  return {
    history,
    selectedCheck,
    prefillUrl,
    placeholderUrl,
    nowMs: Date.now(),
  };
}

/**
 * Map a crawl/report status string to a CSS tone suffix.
 * @param {string} status
 * @returns {'good'|'warn'|'crit'|'neutral'}
 */
function statusTone(status) {
  const norm = String(status ?? '').toLowerCase();
  if (norm === 'pass' || norm === 'ok') return 'good';
  if (norm === 'attention' || norm === 'warn' || norm === 'warning') return 'warn';
  if (norm === 'critical' || norm === 'fail' || norm === 'blocked_hard_gate') return 'crit';
  return 'neutral';
}

/**
 * Human-readable status label.
 * @param {string} status
 * @returns {string}
 */
function statusLabel(status) {
  const norm = String(status ?? '').toLowerCase();
  if (norm === 'blocked_hard_gate') return 'Blocked (Hard Gate)';
  if (norm === 'critical' || norm === 'fail') return 'Critical';
  if (norm === 'attention' || norm === 'warn') return 'Needs attention';
  if (norm === 'pass') return 'Pass';
  return status || 'Unknown';
}

/**
 * Render a pill badge using Hearsay's semantic palette.
 * @param {string} text
 * @param {'good'|'warn'|'crit'|'info'|'neutral'|'stack'} [tone]
 */
function pill(text, tone = 'neutral') {
  return html`<span class="xray-pill xray-pill-${tone}">${text}</span>`;
}

/**
 * Find the most recent prior check ID for the same domain (or any earlier check if none).
 * @param {SiteCheckSummary[]} history
 * @param {number} index
 * @returns {number|null}
 */
function findPreviousCheckId(history, index) {
  const current = history[index];
  if (!current) return null;
  for (let i = index + 1; i < history.length; i += 1) {
    if (history[i].domain === current.domain) return history[i].id;
  }
  return index + 1 < history.length ? history[index + 1].id : null;
}

/**
 * Collect concise findings array from a saved report for initial SSR rendering.
 * @param {Record<string, any>} report
 * @returns {Array<{id: string, severity: string, title: string, detail: string, scope: string}>}
 */
function extractSsrFindings(report) {
  /** @type {Array<{id: string, severity: string, title: string, detail: string, scope: string}>} */
  const out = [];
  const rawList = Array.isArray(report?.findings)
    ? report.findings
    : Array.isArray(report?.siteFindings)
      ? report.siteFindings
      : [];
  for (const item of rawList.slice(0, 25)) {
    if (!item || typeof item !== 'object') continue;
    out.push({
      id: String(item.id ?? item.ruleId ?? 'finding'),
      severity: String(item.severity ?? 'info').toLowerCase(),
      title: String(item.title ?? item.summary ?? item.id ?? 'Finding'),
      detail: String(item.detail ?? ''),
      scope: String(item.scope ?? 'site'),
    });
  }
  return out;
}

/**
 * Render the initial SSR Honest Scope & Hard-Gate Banner when a saved check is selected.
 * @param {SavedSiteCheck|null} selected
 */
function renderInitialScopeBanner(selected) {
  if (!selected) {
    return html`<section id="xray-scope-banner" class="card xray-scope" hidden></section>`;
  }
  const report = selected.report ?? {};
  const hardGate = report.hardGate && typeof report.hardGate === 'object' ? report.hardGate : null;
  const pageTitle =
    typeof report.meta?.title === 'string' && report.meta.title.trim() !== ''
      ? report.meta.title.trim()
      : Array.isArray(report.pages) && typeof report.pages[0]?.title === 'string'
        ? report.pages[0].title.trim()
        : '';
  const scopeSummary = typeof report.scopeSummary === 'string' ? report.scopeSummary : '';

  return html`<section id="xray-scope-banner" class="card xray-scope">
    <div class="xray-scope-head">
      <div class="xray-scope-title-wrap">
        <div class="xray-scope-topline">
          ${pill(statusLabel(selected.status), statusTone(selected.status))}
          <h2 class="xray-scope-domain">${selected.domain}</h2>
          <span class="muted xray-scope-check-id">Check #${selected.id}</span>
        </div>
        <p class="xray-scope-url"><code>${selected.url}</code></p>
        ${pageTitle ? html`<p class="xray-scope-page-title muted">${pageTitle}</p>` : ''}
      </div>
      <div class="xray-scope-actions">
        <a
          id="xray-export-html"
          class="btn btn-sm"
          href="/api/check/${selected.id}?format=html"
          download
        >Export HTML Report</a>
        <a
          id="xray-view-html"
          class="btn btn-sm"
          href="/api/check/${selected.id}?format=html&amp;inline=1"
          target="_blank"
          rel="noopener noreferrer"
        >Printable View</a>
      </div>
    </div>

    <div class="xray-pill-row" aria-label="Crawl coverage and detected stack">
      ${pill(`Audited: ${selected.auditedCount}`, selected.auditedCount > 0 ? 'good' : 'crit')}
      ${pill(`Skipped: ${selected.skippedCount}`, selected.skippedCount > 0 ? 'warn' : 'neutral')}
      ${pill(`Errored: ${selected.erroredCount}`, selected.erroredCount > 0 ? 'crit' : 'neutral')}
      ${pill(`Mode: ${selected.mode}`, 'info')}
      ${selected.proseParityPct !== null ? pill(`Prose parity: ${selected.proseParityPct}%`, selected.proseParityPct < 70 ? 'crit' : 'good') : ''}
      ${selected.medianPayloadRatio !== null ? pill(`Payload/Prose: ${selected.medianPayloadRatio}x`, selected.medianPayloadRatio > 25 ? 'warn' : 'neutral') : ''}
      ${selected.stack.map((tech) => pill(tech, 'stack'))}
      ${selected.wafState && selected.wafState !== 'none' ? pill(`WAF: ${selected.wafState}`, selected.wafState === 'challenge_or_block_intercepted' ? 'crit' : 'warn') : ''}
    </div>

    ${hardGate?.triggered
      ? html`<div id="xray-hard-gate" class="xray-hard-gate" role="alert">
          <strong>Hard Infrastructure Gate — Downstream Not Observed</strong>
          <p>
            Reason: <code>${String(hardGate.reason ?? 'blocked')}</code>.
            ${String(hardGate.detail ?? 'Downstream page signals could not be reliably observed behind this hard block.')}
          </p>
        </div>`
      : ''}
    ${scopeSummary ? html`<p class="muted xray-scope-note">${scopeSummary}</p>` : ''}
  </section>`;
}

/**
 * Render initial SSR findings preview for the selected check (replaced with full interactive
 * cluster + remediation view once `public/check.js` hydrates `/api/check/:id`).
 * @param {SavedSiteCheck|null} selected
 */
function renderInitialInsightsPanel(selected) {
  if (!selected) {
    return html`<div class="empty-state xray-empty">
      <h2>Run a zero-key Site X-Ray</h2>
      <p>Enter any public URL above to inspect how non-JS AI crawlers actually see your site: 18-bot robots policy, Cloudflare Managed overrides, template-clustered crawl issues, payload truncation cliffs, and copy-paste framework fixes.</p>
      <p class="muted">No API keys required. Private/loopback hosts are blocked by default for SSRF safety.</p>
    </div>`;
  }

  const findings = extractSsrFindings(selected.report);
  const clusters = Array.isArray(selected.report?.clusters?.templateClusters)
    ? selected.report.clusters.templateClusters
    : [];

  return html`<div class="xray-ssr-insights">
    ${clusters.length > 0
      ? html`<div class="xray-section">
          <h3>Template-clustered issues</h3>
          <ul class="xray-finding-list">
            ${clusters.map(
              (/** @type {Record<string, any>} */ c) => html`<li class="xray-finding-item xray-sev-${statusTone(String(c.severity ?? 'info'))}">
                <div class="xray-finding-head">
                  ${pill(String(c.severity ?? 'info'), statusTone(String(c.severity ?? 'info')))}
                  <strong>Fix 1 template (<code>${String(c.template ?? 'unknown')}</code>) → fix ${Number(c.affectedCount ?? 0)} page(s)</strong>
                </div>
                <p>${String(c.summary ?? c.ruleId ?? '')}</p>
              </li>`,
            )}
          </ul>
        </div>`
      : ''}
    <div class="xray-section">
      <h3>Observed findings (${findings.length})</h3>
      ${findings.length === 0
        ? html`<p class="muted">No critical or warning findings recorded for this check.</p>`
        : html`<ul class="xray-finding-list">
            ${findings.map(
              (f) => html`<li class="xray-finding-item xray-sev-${statusTone(f.severity)}">
                <div class="xray-finding-head">
                  ${pill(f.severity, statusTone(f.severity))}
                  <strong>${f.title}</strong>
                  <code class="muted">${f.id}</code>
                </div>
                ${f.detail ? html`<p>${f.detail}</p>` : ''}
              </li>`,
            )}
          </ul>`}
    </div>
  </div>`;
}

/**
 * Render the SSR History & Drift table from SQLite `site_checks`.
 * @param {SiteCheckSummary[]} history
 * @param {number|null} selectedId
 * @param {number} nowMs
 */
function renderHistoryTable(history, selectedId, nowMs) {
  if (history.length === 0) {
    return html`<p class="muted" id="xray-history-empty">No saved Site X-Ray runs yet. Run an audit above to build a drift timeline in SQLite.</p>`;
  }

  return html`<div class="table-scroll">
    <table class="table xray-history-table">
      <thead>
        <tr>
          <th>Check</th>
          <th>Domain &amp; URL</th>
          <th>Status</th>
          <th class="num">Coverage</th>
          <th class="num">Findings</th>
          <th class="num">Parity / Ratio</th>
          <th>Stack</th>
          <th>When</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="xray-history-tbody">
        ${history.map((item, idx) => {
          const prevId = findPreviousCheckId(history, idx);
          const isSelected = selectedId === item.id;
          return html`<tr data-history-id="${item.id}"${isSelected ? raw(' class="is-selected"') : ''}>
            <td><code>#${item.id}</code></td>
            <td>
              <div class="xray-history-domain"><strong>${item.domain}</strong> <span class="muted">(${item.mode})</span></div>
              <div class="xray-history-url muted"><code>${truncate(item.url, 64)}</code></div>
            </td>
            <td>${pill(statusLabel(item.status), statusTone(item.status))}</td>
            <td class="num">${item.auditedCount} / ${item.skippedCount} / ${item.erroredCount}</td>
            <td class="num">${item.criticalCount} crit · ${item.warningCount} warn</td>
            <td class="num">
              ${item.proseParityPct !== null ? `${item.proseParityPct}%` : '—'}
              /
              ${item.medianPayloadRatio !== null ? `${item.medianPayloadRatio}x` : '—'}
            </td>
            <td>
              <div class="xray-stack-mini">
                ${item.stack.length > 0 ? item.stack.slice(0, 3).map((s) => pill(s, 'stack')) : html`<span class="muted">—</span>`}
              </div>
            </td>
            <td title="${item.createdAt}">${relTime(item.createdAt, nowMs)}</td>
            <td>
              <div class="xray-row-actions">
                <button type="button" class="btn btn-sm" data-load-check="${item.id}">Inspect</button>
                ${prevId !== null
                  ? html`<button
                      type="button"
                      class="btn btn-sm"
                      data-compare-current="${item.id}"
                      data-compare-baseline="${prevId}"
                    >Compare vs Previous</button>`
                  : ''}
                <a class="btn btn-sm" href="/api/check/${item.id}?format=html" download>HTML</a>
              </div>
            </td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}

/**
 * Render the `/check` Site X-Ray Workbench HTML document.
 *
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {CheckPageView} view
 * @returns {string}
 */
export function render(ctx, view) {
  const selected = view.selectedCheck;
  const insightsCount = selected ? selected.criticalCount + selected.warningCount : 0;
  const historyCount = view.history.length;

  const body = html`
    <section class="card xray-controls" aria-label="Site X-Ray controls">
      <form id="xray-form" class="xray-form" novalidate>
        <div class="xray-primary-row">
          <label class="xray-url-field">
            <span class="xray-field-label">Target URL</span>
            <input
              id="xray-url"
              name="url"
              type="url"
              value="${view.prefillUrl}"
              placeholder="${view.placeholderUrl}"
              required
              autocomplete="url"
              spellcheck="false"
            />
          </label>
          <button type="submit" id="xray-submit" class="btn btn-primary xray-run-btn">Run Site X-Ray</button>
        </div>

        <p id="xray-error" class="form-error" role="alert" hidden></p>

        <details class="xray-advanced" id="xray-advanced">
          <summary>Advanced options</summary>
          <div class="xray-advanced-body">
            <div class="xray-advanced-grid">
              <label class="xray-checkbox">
                <input type="checkbox" id="xray-single" name="single" />
                <span>Single URL only (<code>--single</code>)</span>
              </label>

              <label class="xray-number-field">
                <span>Max pages (1–25, default 15)</span>
                <input type="number" id="xray-max-pages" name="maxPages" min="1" max="25" value="15" />
              </label>

              <label class="xray-number-field">
                <span>Per-request timeout (ms)</span>
                <input type="number" id="xray-timeout" name="timeoutMs" min="500" max="60000" step="500" value="10000" />
              </label>
            </div>

            <label class="xray-vs-field">
              <span>Competitor URLs (<code>--vs</code>, comma or newline separated, up to 3)</span>
              <textarea
                id="xray-vs"
                name="vs"
                rows="2"
                placeholder="https://competitor-a.com&#10;https://competitor-b.com"
                spellcheck="false"
              ></textarea>
            </label>

            <div class="xray-toggle-grid">
              <label class="xray-checkbox">
                <input type="checkbox" id="xray-browser" name="browser" />
                <span>Headless Browser DOM Diff (<code>--browser</code>)</span>
              </label>
              <label class="xray-checkbox">
                <input type="checkbox" id="xray-caching" name="checkCaching" />
                <span>Check 304 Caching</span>
              </label>
              <label class="xray-checkbox">
                <input type="checkbox" id="xray-ignore-robots" name="ignoreRobotsForOwnSite" />
                <span>Ignore robots.txt for own site</span>
              </label>
              <label class="xray-checkbox">
                <input type="checkbox" id="xray-include-auth" name="includeAuthRoutes" />
                <span>Include auth &amp; utility routes</span>
              </label>
            </div>
          </div>
        </details>
      </form>
    </section>

    <section id="xray-progress-panel" class="card xray-progress" hidden aria-live="polite">
      <div class="xray-progress-head">
        <strong id="xray-progress-text">Starting Site X-Ray…</strong>
        <span id="xray-progress-count" class="muted">0 pages audited</span>
      </div>
      <div class="xray-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="xray-progress-track">
        <div class="xray-progress-fill" id="xray-progress-bar"></div>
      </div>
      <ul id="xray-progress-log" class="xray-progress-log"></ul>
    </section>

    ${renderInitialScopeBanner(selected)}

    <section
      id="xray-workbench"
      class="card xray-workbench"
      data-initial-check-id="${selected ? String(selected.id) : ''}"
    >
      <div class="xray-tabs" role="tablist" aria-label="Site X-Ray analysis sections">
        <button
          type="button"
          class="xray-tab is-active"
          role="tab"
          id="xray-tab-insights"
          aria-selected="true"
          aria-controls="xray-panel-insights"
          data-xray-tab="insights"
        >
          <span>Insights &amp; Fixes</span>
          <span
            id="xray-badge-insights"
            class="xray-tab-badge${selected && selected.criticalCount > 0 ? ' is-crit' : selected && selected.warningCount > 0 ? ' is-warn' : ''}"
            ${insightsCount > 0 ? '' : raw('hidden')}
          >${insightsCount}</span>
        </button>

        <button
          type="button"
          class="xray-tab"
          role="tab"
          id="xray-tab-diff"
          aria-selected="false"
          aria-controls="xray-panel-diff"
          data-xray-tab="diff"
        >
          <span>Bot vs. Human Diff</span>
          <span id="xray-badge-diff" class="xray-tab-badge" hidden></span>
        </button>

        <button
          type="button"
          class="xray-tab"
          role="tab"
          id="xray-tab-bots"
          aria-selected="false"
          aria-controls="xray-panel-bots"
          data-xray-tab="bots"
        >
          <span>18-Bot Access Matrix</span>
          <span id="xray-badge-bots" class="xray-tab-badge" hidden></span>
        </button>

        <button
          type="button"
          class="xray-tab"
          role="tab"
          id="xray-tab-competitors"
          aria-selected="false"
          aria-controls="xray-panel-competitors"
          data-xray-tab="competitors"
        >
          <span>Competitor X-Ray</span>
          <span id="xray-badge-competitors" class="xray-tab-badge" hidden></span>
        </button>

        <button
          type="button"
          class="xray-tab"
          role="tab"
          id="xray-tab-history"
          aria-selected="false"
          aria-controls="xray-panel-history"
          data-xray-tab="history"
        >
          <span>History &amp; Drift</span>
          <span id="xray-badge-history" class="xray-tab-badge"${historyCount > 0 ? '' : raw(' hidden')}>${historyCount}</span>
        </button>
      </div>

      <div
        id="xray-panel-insights"
        class="xray-panel"
        role="tabpanel"
        aria-labelledby="xray-tab-insights"
        data-xray-panel="insights"
      >
        ${renderInitialInsightsPanel(selected)}
      </div>

      <div
        id="xray-panel-diff"
        class="xray-panel"
        role="tabpanel"
        aria-labelledby="xray-tab-diff"
        data-xray-panel="diff"
        hidden
      >
        <p class="muted">Run a Site X-Ray or inspect a saved check to view the Bot vs. Human Markdown diff, truncation cliff budget, and payload-to-prose breakdown.</p>
      </div>

      <div
        id="xray-panel-bots"
        class="xray-panel"
        role="tabpanel"
        aria-labelledby="xray-tab-bots"
        data-xray-panel="bots"
        hidden
      >
        <p class="muted">Run a Site X-Ray or inspect a saved check to view the 18-bot AI crawler matrix, Cloudflare Managed overrides, Content-Signal directives, and Edge Markdown negotiation.</p>
      </div>

      <div
        id="xray-panel-competitors"
        class="xray-panel"
        role="tabpanel"
        aria-labelledby="xray-tab-competitors"
        data-xray-panel="competitors"
        hidden
      >
        <p class="muted">Add up to 3 competitor URLs under Advanced options to run a side-by-side Competitor X-Ray matrix with winner deltas.</p>
      </div>

      <div
        id="xray-panel-history"
        class="xray-panel"
        role="tabpanel"
        aria-labelledby="xray-tab-history"
        data-xray-panel="history"
        hidden
      >
        <div class="xray-history-head">
          <div>
            <h2>Saved checks &amp; drift timeline</h2>
            <p class="muted">Every <code>/check</code> run is saved locally in SQLite. Compare any check against a previous snapshot to isolate real regressions.</p>
          </div>
          <div class="xray-history-tools">
            <button type="button" class="btn btn-sm" id="xray-refresh-history">Refresh history</button>
          </div>
        </div>
        <div id="xray-drift-panel" class="xray-drift-panel" hidden></div>
        <div id="xray-history-container">
          ${renderHistoryTable(view.history, selected ? selected.id : null, view.nowMs)}
        </div>
      </div>
    </section>
  `;

  return layout({
    title: 'Site X-Ray',
    active: '/check',
    body,
    ctx,
    scripts: ['/public/check.js'],
  });
}
