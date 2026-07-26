/**
 * GET /alerts — the alert list, with acknowledge (§9, §11.3 item 5).
 *
 * Severity is carried by an icon *and* a word, never by colour alone, and every
 * `detail` line shows the numbers the rule fired on — that is the rule in §9, not a
 * house style.
 */

import { emptyState, html, layout, PROVIDER_LABEL, relTime, severityChip, truncate } from '../layout.js';
import { listAlerts } from '../queries.js';

/**
 * @typedef {Object} AlertsView
 * @property {boolean} open the list is filtered to unacknowledged alerts
 * @property {import('../queries.js').AlertRow[]} alerts newest first
 * @property {number} nowMs render clock, so `relTime` stays deterministic in tests
 */

/**
 * @param {import('./dashboard.js').PageDeps} deps
 * @param {URLSearchParams} [query]
 * @returns {AlertsView}
 */
export function buildView({ db }, query) {
  const open = (query?.get('open') ?? '1') !== '0';
  return {
    open,
    alerts: listAlerts(db, { open, limit: 200 }),
    nowMs: Date.now(),
  };
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const toggle = html`<p class="filter-links">
    <a class="${view.open ? 'is-active' : ''}" href="/alerts?open=1">Open</a>
    <a class="${view.open ? '' : 'is-active'}" href="/alerts?open=0">All</a>
  </p>`;

  if (view.alerts.length === 0) {
    const body = html`${toggle}${emptyState({
      title: view.open ? 'No open alerts' : 'No alerts',
      line: 'Alerts appear after two comparable runs, so a single noisy answer cannot trigger one.',
      hint: 'Lost or gained recommendations, being overtaken on share of AI voice, and mention-rate drops.',
    })}`;
    return layout({ title: 'Alerts', active: '/alerts', ctx, body });
  }

  const rows = view.alerts.map(
    (alert) => html`<li class="alert-row" data-alert-id="${alert.id}">
      ${severityChip(String(alert.severity))}
      <div class="alert-body">
        <p class="alert-title">${alert.title}</p>
        <p class="alert-detail muted">${alert.detail}</p>
        <p class="alert-meta muted small">
          ${alert.type}${alert.provider ? html` · ${PROVIDER_LABEL[String(alert.provider)] ?? alert.provider}` : ''}
          ${alert.promptText ? html` · ${truncate(String(alert.promptText), 60)}` : ''}
        </p>
      </div>
      <span class="alert-time muted">${relTime(String(alert.created_at), view.nowMs)}</span>
      ${alert.acknowledged === 1
        ? html`<span class="muted small">acknowledged</span>`
        : html`<button type="button" class="btn btn-sm" data-ack="${alert.id}">Ack</button>`}
    </li>`,
  );

  const body = html`${toggle}
    <section class="card">
      <h2>${view.open ? 'Open alerts' : 'All alerts'}</h2>
      <ul class="alert-list">
        ${rows}
      </ul>
    </section>`;
  return layout({ title: 'Alerts', active: '/alerts', ctx, body });
}
