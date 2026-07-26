/**
 * GET /settings — read-only environment viewer plus the two switches that belong to
 * the database rather than the environment (§11.6).
 *
 * Keys are shown masked and only masked (§19.6 #9). Every dollar figure on this page
 * comes out of `core/cost.js`; nothing here is a hardcoded amount, and no flat
 * monthly price is ever printed without the sampling design that produced it
 * (§4.3, §19.6 #13).
 */

import { statSync } from 'node:fs';

import { html, layout, raw, usd } from '../layout.js';
import { cost, metrics, soft } from '../data.js';
import { activePromptCount } from '../queries.js';
import { getSetting, SETTING_KEYS } from '../../core/db.js';

/** Window used for the "actual spend" figure (§4.3). */
export const SPEND_DAYS = 30;

/**
 * @param {string} path
 * @returns {number|null} bytes, or null when the file is not on disk yet
 */
function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * @param {number|null} bytes
 * @returns {string}
 */
function humanSize(bytes) {
  if (bytes === null) return 'not created yet';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One row of the provider table — the masked key only, never the key itself (§19.6 #9).
 *
 * @typedef {Object} ProviderRow
 * @property {string} id
 * @property {string} label
 * @property {string} model
 * @property {boolean} enabled
 * @property {string|null} maskedKey
 * @property {string} keyEnv
 */

/**
 * @typedef {Object} SettingsView
 * @property {ProviderRow[]} providers
 * @property {string} runAt local-time HH:MM of the daily run
 * @property {number} samples
 * @property {number} concurrency
 * @property {number} timeoutMs
 * @property {boolean} demo
 * @property {string} dbPath
 * @property {number|null} dbBytes null until the file exists
 * @property {number} activePrompts
 * @property {number} calls calls one run would make (§4.2)
 * @property {number|null} estUsd null when the price table has no entry — never a guess (§4.3)
 * @property {{provider: string, calls: number, estUsd: number|null}[]} perProvider
 * @property {{totalUsd: number|null, perProvider: {provider: string, usd: number|null, calls: number}[]}|null} spend
 * @property {number} spendDays window the actual-spend figure covers
 * @property {boolean} includeBranded branded prompts count towards SOV denominators (§6.7)
 */

/**
 * @param {import('./dashboard.js').PageDeps} deps
 * @returns {SettingsView}
 */
export function buildView({ db, config }) {
  const prompts = activePromptCount(db);
  const enabled = config.enabledProviders;
  const calls = prompts * enabled.length * config.samples;

  /** @type {{calls: number, estUsd: number|null, perProvider: {provider: string, calls: number, estUsd: number|null}[]}|null} */
  const estimate = soft(
    /** @type {*} */ (cost),
    'estimateRunCost',
    { promptCount: prompts, samples: config.samples, providers: enabled.map(({ id, model }) => ({ id, model })) },
    null,
  );
  /** @type {{totalUsd: number|null, perProvider: {provider: string, usd: number|null, calls: number}[]}|null} */
  const spend = soft(/** @type {*} */ (metrics), 'actualSpend', { db, now: new Date(), days: SPEND_DAYS }, null);

  return {
    providers: Object.values(config.providers).map((provider) => ({
      id: provider.id,
      label: provider.label,
      model: provider.model,
      enabled: provider.enabled,
      maskedKey: provider.maskedKey,
      keyEnv: provider.keyEnv,
    })),
    runAt: config.runAt,
    samples: config.samples,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    demo: config.demo,
    dbPath: config.dbPath,
    dbBytes: fileSize(config.dbPath),
    activePrompts: prompts,
    calls: estimate ? Number(estimate.calls ?? calls) : calls,
    estUsd: estimate ? estimate.estUsd : null,
    perProvider: estimate?.perProvider ?? [],
    spend,
    spendDays: SPEND_DAYS,
    includeBranded: Boolean(getSetting(db, SETTING_KEYS.INCLUDE_BRANDED_IN_SOV, false)),
  };
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function costPanel(view) {
  const perProvider = view.perProvider.map(
    (row) => html`<tr>
      <td>${row.provider}</td>
      <td class="num">${row.calls}</td>
      <td class="num">${usd(row.estUsd)}</td>
    </tr>`,
  );

  return html`<section class="card">
    <h2>Cost</h2>
    <dl class="kv">
      <dt>Calls per run</dt>
      <dd>
        ${view.calls}
        <span class="muted"
          >${view.activePrompts} active prompts × ${view.providers.filter((p) => p.enabled).length} engines ×
          ${view.samples} samples</span
        >
      </dd>
      <dt>Estimated cost per run</dt>
      <dd>
        ${view.estUsd === null
          ? html`<span class="muted">not available — the price table has no entry for one of your models, and Hearsay
              does not guess</span>`
          : usd(view.estUsd)}
      </dd>
      <dt>Actual spend, last ${view.spendDays} days</dt>
      <dd>${usd(view.spend ? view.spend.totalUsd : null)}</dd>
    </dl>
    ${perProvider.length === 0
      ? ''
      : html`<table class="table">
          <thead>
            <tr>
              <th>Engine</th>
              <th class="num">Calls</th>
              <th class="num">Estimated</th>
            </tr>
          </thead>
          <tbody>
            ${perProvider}
          </tbody>
        </table>`}
    <p class="muted small">
      Estimates use the token medians documented in the methodology, priced from the table in core/cost.js. Actual
      spend is the sum of the usage each provider reported, so it is zero until a live run happens.
    </p>
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const rows = view.providers.map(
    (provider) => html`<tr>
      <td>${provider.label}</td>
      <td>${provider.enabled ? 'Enabled' : 'No API key'}</td>
      <td><code>${provider.model}</code></td>
      <td class="num">${provider.maskedKey ?? html`<span class="muted">set ${provider.keyEnv}</span>`}</td>
    </tr>`,
  );

  const body = html`<section class="card">
      <h2>Providers</h2>
      <p class="muted">
        A provider is enabled when its API key environment variable is set. Keys are read from the environment only —
        Hearsay never stores them, never logs them and never displays them in full.
      </p>
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
      </dl>
    </section>
    ${costPanel(view)}
    <section class="card">
      <h2>Share of voice</h2>
      <label class="check">
        <input
          type="checkbox"
          data-setting="includeBrandedInSov"
          ${view.includeBranded ? raw('checked') : ''}
        />
        <span>Include branded prompts in share-of-voice denominators</span>
      </label>
      <p class="muted small">
        Off by default. A prompt that names your brand measures navigational recall, not discovery, so counting it
        inflates your share against competitors who were never asked about.
      </p>
      <p class="form-error" data-form-error hidden></p>
    </section>
    <section class="card">
      <h2>Data</h2>
      <dl class="kv">
        <dt>Database</dt>
        <dd><code>${view.dbPath}</code></dd>
        <dt>Size on disk</dt>
        <dd>${humanSize(view.dbBytes)}</dd>
      </dl>
      <p><a class="btn" href="/api/export" download="hearsay-export.json">Export everything as JSON</a></p>
      <p class="muted small">Every table, no secrets: API keys live in the environment and are never written here.</p>
    </section>`;

  return layout({ title: 'Settings', active: '/settings', ctx, body });
}
