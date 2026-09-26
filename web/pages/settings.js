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

import { html, layout, raw, SURFACE_LABEL, usd } from '../layout.js';
import { metrics, soft } from '../data.js';
import { estimateRunCost } from '../../core/cost.js';
import { apiExecutionBudget, subscriptionExecutionBudget } from '../../core/execution-budget.js';
import { apiSearchScheduleApproved } from '../../core/api-search-schedule.js';
import { activePromptCount } from '../queries.js';
import { get, getSetting, SETTING_KEYS } from '../../core/db.js';
import { getSubscriptionSchedule } from '../../core/subscription-scheduler.js';
import { trackingHealth } from '../../core/tracking-health.js';

/** Window used for computed API usage cost (§4.3). */
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
 * @property {number} subscriptionSamples
 * @property {number|null} estUsd null when the price table has no entry — never a guess (§4.3)
 * @property {number|null} knownSubtotalUsd
 * @property {'known'|'partial'|'unavailable'} costStatus
 * @property {import('../../core/cost.js').ProviderEstimate[]} perProvider
 * @property {boolean} hasUnboundedSearch
 * @property {boolean} hasSearch
 * @property {boolean} recurringSearchApproved
 * @property {ReturnType<typeof apiExecutionBudget>[]} executionBudgets
 * @property {ReturnType<typeof subscriptionExecutionBudget>[]} subscriptionBudgets
 * @property {{totalUsd:number|null,knownSubtotalUsd:number|null,costStatus:'known'|'partial'|'unavailable',
 *   attemptedCalls:number,unknownCalls:number}|null} spend
 * @property {number} spendDays window the actual-spend figure covers
 * @property {boolean} includeBranded branded prompts count towards SOV denominators (§6.7)
 * @property {{id:string,label:string,enabled:boolean,optedIn:boolean}[]} subscriptionSurfaces
 * @property {{id:number,status:string,totalCalls:number,doneCalls:number}|null} subscriptionRun
 * @property {import('../../core/subscription-scheduler.js').SubscriptionSchedule|null} subscriptionSchedule
 * @property {ReturnType<typeof trackingHealth>} trackingHealth
 */

/**
 * @param {import('./dashboard.js').PageDeps} deps
 * @returns {SettingsView}
 */
export function buildView({ db, config }) {
  const prompts = activePromptCount(db);
  const enabled = config.enabledProviders;
  const executionBudgets = enabled.map(({ id }) => apiExecutionBudget(config, id));

  const estimate = estimateRunCost(
    { promptCount: prompts, samples: config.samples, providers: enabled.map(({ id, model }, index) =>
      ({ id, model, searchPolicy: config.apiSearchPolicies[id],
        searchCallLimitEnforced: executionBudgets[index].searchCallLimitEnforced })) },
    config.pricingEnv,
  );
  /** @type {SettingsView['spend']} */
  const spend = soft(/** @type {*} */ (metrics), 'actualSpend', { db, now: new Date(), days: SPEND_DAYS }, null);
  const activeSubscription = get(db, `
    SELECT id, status, total_calls, done_calls
      FROM runs
     WHERE status = 'running'
       AND trigger = 'manual'
       AND EXISTS (
         SELECT 1 FROM responses
          WHERE responses.run_id = runs.id
            AND responses.surface IN ('codex-agent', 'claude-code-agent')
       )
     ORDER BY id DESC
     LIMIT 1
  `);

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
    subscriptionSamples: config.subscriptionSamples,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    demo: config.demo,
    dbPath: config.dbPath,
    dbBytes: fileSize(config.dbPath),
    activePrompts: prompts,
    calls: estimate.calls,
    estUsd: estimate.estUsd,
    knownSubtotalUsd: estimate.knownSubtotalUsd,
    costStatus: estimate.costStatus,
    perProvider: estimate.perProvider,
    hasUnboundedSearch: estimate.hasUnboundedSearch,
    hasSearch: estimate.hasSearch,
    recurringSearchApproved: apiSearchScheduleApproved(db, config),
    executionBudgets,
    subscriptionBudgets: config.subscriptionSurfaces.map((surface) => subscriptionExecutionBudget(config, surface)),
    spend,
    spendDays: SPEND_DAYS,
    includeBranded: Boolean(getSetting(db, SETTING_KEYS.INCLUDE_BRANDED_IN_SOV, false)),
    subscriptionSurfaces: config.subscriptionSurfaces.map((id) => ({
      id,
      label: SURFACE_LABEL[id] ?? id,
      enabled: true,
      optedIn: getSetting(db, SETTING_KEYS.SUBSCRIPTION_SURFACE_OPT_IN, /** @type {string[]} */ ([])).includes(id),
    })),
    subscriptionRun: activeSubscription
      ? {
          id: Number(activeSubscription.id),
          status: String(activeSubscription.status),
          totalCalls: Number(activeSubscription.total_calls ?? 0),
          doneCalls: Number(activeSubscription.done_calls ?? 0),
        }
      : null,
    subscriptionSchedule: getSubscriptionSchedule(db),
    trackingHealth: trackingHealth({ db, config }),
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
      <td class="num">${usd(row.tokenUsd)}</td>
      <td class="num">${usd(row.requestUsd)}</td>
      <td class="num">${usd(row.searchToolUsd)}</td>
      <td class="num">${row.estUsd === null
        ? row.knownSubtotalUsd === null
          ? html`Unknown ${row.unpricedComponents.join(', ')}`
          : html`${usd(row.knownSubtotalUsd)} known + unknown ${row.unpricedComponents.join(', ')}`
        : usd(row.estUsd)}</td>
    </tr>`,
  );
  const budgets = view.executionBudgets.map((budget) => html`<tr>
    <td>${budget.surface}</td>
    <td>${budget.route}<br /><span class="muted">${budget.model} · ${budget.endpoint}</span></td>
    <td>${budget.searchPolicy}${budget.searchCallLimitEnforced ? ` · ${budget.maxSearchCalls} search calls` : ' · internal search count has no ceiling'}</td>
    <td>${budget.timeoutMs} ms</td>
    <td>${budget.answerTokenLimit === null ? 'not set' : `${budget.answerTokenLimit} tokens`}</td>
  </tr>`);

  return html`<section class="card">
    <h2>API usage &amp; cost</h2>
    <dl class="kv">
      <dt>API calls per run</dt>
      <dd>
        ${view.calls}
        <span class="muted">${view.activePrompts} active prompts × ${view.providers.filter((p) => p.enabled).length} API providers × ${view.samples} samples</span>
      </dd>
      <dt>Estimated API cost per run</dt>
      <dd>
        ${view.estUsd === null
          ? view.knownSubtotalUsd === null
            ? html`<span class="muted">unknown — Hearsay has no complete price for this selection</span>`
            : html`<span class="muted">${usd(view.knownSubtotalUsd)} known subtotal plus unknown components</span>`
          : usd(view.estUsd)}
      </dd>
      <dt>Computed API usage cost, last ${view.spendDays} days</dt>
      <dd>${view.spend?.costStatus === 'known' ? usd(view.spend.totalUsd)
        : view.spend?.costStatus === 'partial'
          ? html`${usd(view.spend.knownSubtotalUsd)} known subtotal plus unknown components`
          : view.spend?.attemptedCalls === 0 ? 'No API calls recorded' : 'Unknown'}
        ${view.spend?.unknownCalls ? html`<span class="muted">(${view.spend.unknownCalls} call(s) with unknown cost)</span>` : ''}</dd>
    </dl>
    ${perProvider.length === 0
      ? ''
      : html`<div class="table-scroll"><table class="table">
          <thead>
            <tr>
              <th>API provider</th>
              <th class="num">API calls</th>
              <th class="num">Tokens</th>
              <th class="num">Requests</th>
              <th class="num">Search tools</th>
              <th class="num">Estimated API cost</th>
            </tr>
          </thead>
          <tbody>
            ${perProvider}
          </tbody>
        </table></div>`}
    ${budgets.length === 0 ? '' : html`<div class="table-scroll"><table class="table">
      <thead><tr><th>Surface</th><th>Endpoint profile / model</th><th>Search policy</th><th>Time limit</th><th>Answer limit</th></tr></thead>
      <tbody>${budgets}</tbody>
    </table></div>`}
    ${view.hasSearch ? html`<p class="muted small">The estimate includes one web-search call per search-enabled target.${view.hasUnboundedSearch ? ' OpenAI hosted search has no enforceable internal call ceiling, so this forecast is not a spending cap.' : ''} Daily API search: ${view.recurringSearchApproved ? 'approved for the current profile and target ceiling' : 'off until separately confirmed at /api/search-schedule'}.</p>` : ''}
    <p class="muted small">
      Estimates and computed usage costs cover direct API usage only. Estimates use the token medians documented in the
      methodology, priced from the table in core/cost.js. Computed usage cost is not an invoice and can omit
      attempts with unknown billing. Subscription allowance and possible overage are shown
      above and are not converted into this dollar figure.
    </p>
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view @returns {import('../layout.js').RawHtml} */
function subscriptionPanel(view) {
  const surfaces = view.subscriptionSurfaces.map((surface) => html`<tr>
    <td>${surface.label}</td>
    <td>${surface.enabled ? 'Available' : 'Disabled'}</td>
    <td>${surface.optedIn ? 'Allowance consented for on-demand runs' : 'First run asks for allowance consent'}</td>
  </tr>`);
  if (surfaces.length === 0) {
    return html`<section class="card">
      <h2>Subscription agent surfaces</h2>
      <p class="muted">
        No subscription CLI surface is enabled. Authenticate the local Codex or Claude Code CLI, then set
        <code>HEARSAY_CODEX_ENABLED=1</code> and/or <code>HEARSAY_CLAUDE_CODE_ENABLED=1</code> in <code>.env</code>
        and restart Hearsay.
      </p>
    </section>`;
  }
  const schedule = view.subscriptionSchedule;
  const targetCeiling = schedule?.targetCeiling ?? Math.max(1, view.activePrompts * view.subscriptionSamples);
  const budgets = view.subscriptionBudgets.map((budget) => html`<tr>
    <td>${budget.surface}</td>
    <td>${budget.executable}</td>
    <td>${budget.timeoutMs} ms · ${budget.maxOutputBytes} bytes output</td>
    <td>required · internal search count has no enforceable ceiling</td>
  </tr>`);
  const onDemand = view.subscriptionRun
    ? html`<div class="subscription-run" data-subscription-run>
        <p>On-demand run ${view.subscriptionRun.id} is running · ${view.subscriptionRun.doneCalls}/${view.subscriptionRun.totalCalls} calls.</p>
        <button type="button" class="btn btn-quiet" data-subscription-cancel="${view.subscriptionRun.id}">Cancel subscription run</button>
        <p class="form-error" data-form-error hidden></p>
      </div>`
    : html`<form class="inline-form" data-api-form="/api/subscription/run" data-subscription-run>
        <label><span>On-demand surfaces</span><input name="surfaces" data-list value="${view.subscriptionSurfaces.map((surface) => surface.id).join(',')}" required /></label>
        <input type="hidden" name="lane" value="tracking" />
        <input type="hidden" name="samples" value="${view.subscriptionSamples}" />
        <button type="submit" class="btn">Preview on-demand subscription run</button>
        <p class="muted small">A confirmation prompt appears before this uses signed-in plan allowance.</p>
        <p class="form-error" data-form-error hidden></p>
      </form>`;
  return html`<section class="card">
    <h2>Subscription agent surfaces</h2>
    <p class="muted">
      These are separately labeled authenticated CLI measurements. They are not measurements of the ChatGPT web app or Claude.ai,
      and they consume the signed-in plan allowance or possible overage.
    </p>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>Surface</th><th>Status</th><th>Allowance</th></tr></thead>
      <tbody>${surfaces}</tbody>
    </table></div>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>Surface</th><th>CLI</th><th>Process limits</th><th>Search policy</th></tr></thead>
      <tbody>${budgets}</tbody>
    </table></div>
    ${view.demo ? html`<p class="muted">Demo mode disables subscription calls and scheduling.</p>` : onDemand}
    ${view.demo
      ? ''
      : schedule
        ? html`<dl class="kv">
            <dt>Scheduled surface run</dt><dd>Enabled · ${schedule.runAt} (${schedule.timeZone})</dd>
            <dt>Lane and samples</dt><dd>${schedule.lane} · ${schedule.samples} sample(s)</dd>
            <dt>Target ceiling</dt><dd>${schedule.targetCeiling}</dd>
          </dl>
          <form class="inline-form" data-api-form="/api/subscription/schedule" data-method="DELETE">
            <button type="submit" class="btn btn-quiet">Disable scheduled subscription run</button>
          </form>`
        : html`<form class="inline-form" data-api-form="/api/subscription/schedule" data-method="POST" data-subscription-schedule>
            <label><span>Run at</span><input name="run_at" value="07:00" maxlength="5" required /></label>
            <label><span>IANA timezone</span><input name="timezone" value="UTC" maxlength="80" required /></label>
            <label><span>Surfaces</span><input name="surfaces" data-list value="${view.subscriptionSurfaces.map((surface) => surface.id).join(',')}" required /></label>
            <input type="hidden" name="lane" value="tracking" />
            <input type="hidden" name="samples" value="${view.subscriptionSamples}" />
            <label><span>Maximum targets per occurrence</span><input name="target_ceiling" type="number" min="1" value="${targetCeiling}" required /></label>
            <button type="submit" class="btn">Preview and enable schedule</button>
            <p class="muted small">A completed verified on-demand run for each selected surface is required before this persistent consent is saved.</p>
            <p class="form-error" data-form-error hidden></p>
          </form>`}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view */
function trackingHealthPanel(view) {
  const rows = [
    { label: 'API panel', lane: view.trackingHealth.api,
      state: view.trackingHealth.api.enabled ? 'Enabled' : 'Disabled' },
    { label: 'Subscription agents', lane: view.trackingHealth.subscription,
      state: !view.trackingHealth.subscription.enabled ? 'Disabled'
        : view.trackingHealth.subscription.ready ? 'Enabled' : 'Needs renewed consent' },
  ].map(({ label, lane, state }) => html`<article class="health-lane">
    <h3>${label}</h3>
    <dl class="kv">
      <dt>Schedule</dt><dd>${state}</dd>
      <dt>Last successful observation</dt><dd>${lane.lastSuccessfulObservationAt ?? 'None yet'}</dd>
      <dt>Next occurrence</dt><dd>${state === 'Needs renewed consent' ? 'Suspended until consent' : lane.nextScheduledAt ?? 'None'}</dd>
      <dt>Recent missed or failed runs</dt><dd>${lane.recentIssues.length
        ? lane.recentIssues.map((issue) => html`<span>${issue.status} on ${issue.occurredAt} (run ${issue.runId})<br /></span>`)
        : 'None'}</dd>
    </dl>
  </article>`);
  return html`<section class="card" aria-label="Tracking health">
    <h2>Tracking health</h2>
    <p class="muted small">Times are UTC across all profiles. Hearsay only runs schedules while the server is running.</p>
    <div class="health-lanes">${rows}</div>
    ${view.trackingHealth.api.guidance ? html`<p>${view.trackingHealth.api.guidance}</p>` : ''}
    ${view.trackingHealth.subscription.guidance ? html`<p>${view.trackingHealth.subscription.guidance}</p>` : ''}
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

  const body = html`${trackingHealthPanel(view)}${subscriptionPanel(view)}
    <section class="card">
      <h2>API providers</h2>
      <p class="muted">
        API providers are optional direct-API measurement routes. A provider is enabled when its API key environment
        variable is set. Keys are read from the environment only — Hearsay never stores them, never logs them and
        never displays them in full.
      </p>
      <div class="table-scroll"><table class="table">
        <thead>
          <tr>
            <th>API provider</th>
            <th>Status</th>
            <th>Model</th>
            <th class="num">Key</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table></div>
      <p class="muted small">Gemini API answers use the search-off profile. Grounded search is unavailable while its data terms are under review.</p>
    </section>
    <section class="card">
      <h2>API sampling &amp; schedule</h2>
      <dl class="kv">
        <dt>Daily run at</dt>
        <dd>${view.runAt} <span class="muted">server local time</span></dd>
        <dt>API samples</dt>
        <dd>${view.samples} <span class="muted">per prompt per API provider per run</span></dd>
        <dt>API concurrency</dt>
        <dd>${view.concurrency}</dd>
        <dt>API per-call timeout</dt>
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
