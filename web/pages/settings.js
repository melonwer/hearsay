/**
 * GET /settings — read-only env viewer (§11.6).
 *
 * Keys are shown masked and only masked (§19.6 #9). Phase 0 renders the provider
 * table, schedule and sampling design from config; Lane C adds the §4.3 cost panel,
 * the branded-prompt SOV toggle, DB path/size and the export button.
 *
 * @typedef {Object} SettingsView
 * @property {{label: string, model: string, enabled: boolean, maskedKey: string|null, keyEnv: string}[]} providers
 * @property {string} runAt
 * @property {number} samples
 * @property {number} concurrency
 * @property {number} timeoutMs
 * @property {boolean} demo
 * @property {string} dbPath
 */

import { html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {SettingsView} view
 * @returns {string}
 */
export function render(ctx, view) {
  const rows = view.providers.map(
    (p) => html`<tr>
      <td>${p.label}</td>
      <td>${p.enabled ? 'Enabled' : 'No API key'}</td>
      <td><code>${p.model}</code></td>
      <td class="num">${p.maskedKey ?? html`<span class="muted">set ${p.keyEnv}</span>`}</td>
    </tr>`,
  );

  const body = html`<section class="card">
      <h2>Providers</h2>
      <p class="muted">A provider is enabled when its API key environment variable is set. Keys are read from the
        environment only — Hearsay never stores or displays them in full.</p>
      <table class="table">
        <thead>
          <tr>
            <th>Engine</th>
            <th>Status</th>
            <th>Model</th>
            <th class="num">Key</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>
    <section class="card">
      <h2>Sampling &amp; schedule</h2>
      <dl class="kv">
        <dt>Daily run at</dt>
        <dd>${view.runAt} <span class="muted">server local time</span></dd>
        <dt>Samples</dt>
        <dd>${view.samples} <span class="muted">per prompt per provider per run</span></dd>
        <dt>Concurrency</dt>
        <dd>${view.concurrency}</dd>
        <dt>Per-call timeout</dt>
        <dd>${view.timeoutMs} ms</dd>
        <dt>Demo mode</dt>
        <dd>${view.demo ? 'On — live calls and the scheduler are disabled' : 'Off'}</dd>
        <dt>Database</dt>
        <dd><code>${view.dbPath}</code></dd>
      </dl>
    </section>
    <section class="card">
      <h2>Estimated spend</h2>
      <p class="muted">The cost calculator lands with the provider adapters. Hearsay never prints a flat monthly
        figure — costs are computed from your own sampling design and token usage.</p>
    </section>`;

  return layout({ title: 'Settings', active: '/settings', ctx, body });
}
