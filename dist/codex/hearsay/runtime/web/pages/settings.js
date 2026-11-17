/**
 * GET /settings — workspace mode switcher, browser provider/CLI connection,
 * schedule health status badges, and sampling/cost controls (§11.6).
 *
 * Keys are shown masked and only masked (§19.6 #9). Every dollar figure on this page
 * comes out of `core/cost.js`; nothing here is a hardcoded amount, and no flat
 * monthly price is ever printed without the sampling design that produced it
 * (§4.3, §19.6 #13).
 */

import { AGENT_SURFACES_SQL } from '../../core/agent-routes.js';
import { statSync } from 'node:fs';

import {
  detectCliExecutable,
  html,
  layout,
  maskOnboardingHint,
  raw,
  runningScheduleLanes,
  scheduleStatusBadge,
  scheduleStatusInfo,
  SURFACE_LABEL,
  usd,
} from '../layout.js';
import { metrics, soft } from '../data.js';
import { estimateRunCost } from '../../core/cost.js';
import { apiExecutionBudget, subscriptionExecutionBudget } from '../../core/execution-budget.js';
import { apiSearchScheduleApproved, hasEnabledApiSearch } from '../../core/api-search-schedule.js';
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
 * One row of the provider table — the masked hint only, never the key itself (§19.6 #9).
 *
 * @typedef {Object} ProviderRow
 * @property {string} id
 * @property {string} label
 * @property {string|null} model
 * @property {boolean} enabled
 * @property {string|null} maskedKey
 * @property {string|null} maskedHint
 * @property {string} keyEnv
 */

/**
 * @typedef {Object} CliRouteRow
 * @property {string} key
 * @property {string} id
 * @property {string} label
 * @property {string} enabledEnv
 * @property {boolean} detected
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} SettingsView
 * @property {ProviderRow[]} providers
 * @property {ProviderRow} tavily
 * @property {CliRouteRow[]} cliRoutes
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
 * @property {boolean} enabledApiSearch
 * @property {boolean} recurringSearchApproved
 * @property {ReturnType<typeof apiExecutionBudget>[]} executionBudgets
 * @property {ReturnType<typeof subscriptionExecutionBudget>[]} subscriptionBudgets
 * @property {{totalUsd:number|null,knownSubtotalUsd:number|null,costStatus:'known'|'partial'|'unavailable',
 *   attemptedCalls:number,unknownCalls:number}|null} spend
 * @property {number} spendDays window the actual-spend figure covers
 * @property {boolean} includeBranded branded prompts count towards SOV denominators (§6.7)
 * @property {{id:string,label:string,enabled:boolean,optedIn:boolean}[]} subscriptionSurfaces
 * @property {{id:number,status:string,totalCalls:number,doneCalls:number}|null} subscriptionRun
 * @property {{api: boolean, subscription: boolean}} runningLanes
 * @property {import('../../core/subscription-scheduler.js').SubscriptionSchedule|null} subscriptionSchedule
 * @property {ReturnType<typeof trackingHealth>} trackingHealth
 */

/**
 * @param {import('./dashboard.js').PageDeps & {runtime?: import('../../server.js').OnboardingRuntime}} deps
 * @returns {SettingsView}
 */
export function buildView(deps) {
  const { db, config } = deps;
  const prompts = activePromptCount(db);
  const enabled = config.enabledProviders;
  const executionBudgets = enabled.map(({ id }) => apiExecutionBudget(config, id));

  const estimate = estimateRunCost(
    {
      promptCount: prompts,
      samples: config.samples,
      providers: enabled.map(({ id, model }, index) => ({
        id,
        model,
        searchPolicy: config.apiSearchPolicies[id],
        searchCallLimitEnforced: executionBudgets[index].searchCallLimitEnforced,
      })),
    },
    config.pricingEnv,
  );
  /** @type {SettingsView['spend']} */
  const spend = soft(/** @type {*} */ (metrics), 'actualSpend', { db, now: new Date(), days: SPEND_DAYS }, null);
  const activeSubscription = get(
    db,
    `
    SELECT id, status, total_calls, done_calls
      FROM runs
     WHERE status = 'running'
       AND trigger = 'manual'
       AND EXISTS (
         SELECT 1 FROM responses
          WHERE responses.run_id = runs.id
            AND responses.surface IN (${AGENT_SURFACES_SQL})
       )
     ORDER BY id DESC
     LIMIT 1
  `,
  );

  const tavilyKey = deps.runtime
    ? deps.runtime.getEnvValue('TAVILY_API_KEY')
    : String(process.env.TAVILY_API_KEY ?? '');
  const pathEnv = deps.runtime ? deps.runtime.getPathEnv() : process.env.PATH;

  return {
    providers: Object.values(config.providers).map((provider) => ({
      id: provider.id,
      label: provider.label,
      model: provider.model,
      enabled: provider.enabled,
      maskedKey: provider.maskedKey,
      maskedHint: maskOnboardingHint(provider.apiKey),
      keyEnv: provider.keyEnv,
    })),
    tavily: {
      id: 'tavily',
      label: 'Tavily Search',
      model: null,
      enabled: tavilyKey.trim() !== '',
      maskedKey: null,
      maskedHint: maskOnboardingHint(tavilyKey),
      keyEnv: 'TAVILY_API_KEY',
    },
    cliRoutes: [
      {
        key: 'codex',
        id: 'codex-agent',
        label: 'Codex CLI',
        enabledEnv: 'HEARSAY_CODEX_ENABLED',
        detected: detectCliExecutable(config.subscription.codex?.executable ?? 'codex', pathEnv),
        enabled: Boolean(config.subscription.codex?.enabled),
      },
      {
        key: 'claudeCode',
        id: 'claude-code-agent',
        label: 'Claude Code CLI',
        enabledEnv: 'HEARSAY_CLAUDE_CODE_ENABLED',
        detected: detectCliExecutable(config.subscription.claudeCode?.executable ?? 'claude', pathEnv),
        enabled: Boolean(config.subscription.claudeCode?.enabled),
      },
    ],
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
    enabledApiSearch: hasEnabledApiSearch(config),
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
    runningLanes: runningScheduleLanes(db),
    subscriptionSchedule: getSubscriptionSchedule(db),
    trackingHealth: trackingHealth({ db, config }),
  };
}

/** @param {ReturnType<typeof buildView>} view */
function workspaceModePanel(view) {
  return html`<section class="card onboarding-hero" aria-label="Workspace mode">
    <div class="onboarding-hero-main">
      <div>
        <p class="onboarding-eyebrow">Workspace mode</p>
        <h2>${view.demo ? 'Notewell Demo Workspace' : 'Live Brand Workspace'}</h2>
        <p class="muted small">
          ${view.demo
            ? html`Viewing isolated sample data (<code>data/demo/hearsay.db</code>). Switch to your live database (<code>data/hearsay.db</code>) anytime without restarting Hearsay.`
            : html`Connected to your live brand database (<code>${view.dbPath}</code>). Switch to the Notewell sample workspace anytime — both databases stay intact.`}
        </p>
      </div>
      <div class="onboarding-hero-cta">
        ${view.demo
          ? html`<button type="button" class="btn btn-primary" data-switch-demo="false">Exit Demo → Set Up My Brand</button>`
          : html`<button type="button" class="btn" data-switch-demo="true">Switch to Notewell Demo ($0)</button>`}
      </div>
    </div>
    <p class="form-error" data-form-error hidden></p>
  </section>`;
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
  const budgets = view.executionBudgets.map(
    (budget) => html`<tr>
      <td>${budget.surface}</td>
      <td>${budget.route}<br /><span class="muted">${budget.model} · ${budget.endpoint}</span></td>
      <td>${budget.searchPolicy}${budget.searchCallLimitEnforced ? ` · ${budget.maxSearchCalls} search calls` : ' · internal search count has no enforceable ceiling'}</td>
      <td>${budget.timeoutMs} ms</td>
      <td>${budget.answerTokenLimit === null ? 'not set' : `${budget.answerTokenLimit} tokens`}</td>
    </tr>`,
  );

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
      <dd>${view.spend?.costStatus === 'known'
        ? usd(view.spend.totalUsd)
        : view.spend?.costStatus === 'partial'
          ? html`${usd(view.spend.knownSubtotalUsd)} known subtotal plus unknown components`
          : view.spend?.attemptedCalls === 0
            ? 'No API calls recorded'
            : 'Unknown'}
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
          <tbody>${perProvider}</tbody>
        </table></div>`}
    ${budgets.length === 0
      ? ''
      : html`<div class="table-scroll"><table class="table">
          <thead><tr><th>Surface</th><th>Endpoint profile / model</th><th>Search policy</th><th>Time limit</th><th>Answer limit</th></tr></thead>
          <tbody>${budgets}</tbody>
        </table></div>`}
    ${view.hasSearch
      ? html`<p class="muted small">The estimate includes one web-search call per search-enabled target.${view.hasUnboundedSearch ? ' An enabled search route has no enforceable internal call ceiling, so this forecast is not a spending cap.' : ''} Daily API search: ${view.recurringSearchApproved ? 'approved for the current profile and target ceiling' : 'off until separately confirmed at /api/search-schedule'}.</p>`
      : ''}
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
  const cliToggleCards = html`<div class="cli-route-grid">
    ${view.cliRoutes.map(
      (route) => html`<div class="cli-route-tile">
        <div class="cli-route-info">
          <strong>${route.label}</strong>
          <div class="pill-group">
            <span class="status-pill ${route.detected ? 'status-pill-active' : 'status-pill-off'}">
              ${route.detected ? 'CLI detected' : 'Not on PATH'}
            </span>
            <span class="status-pill ${route.enabled ? 'status-pill-active' : 'status-pill-off'}">
              ${route.enabled ? 'Enabled' : 'Off'}
            </span>
          </div>
          <span class="muted small"><code>${route.enabledEnv}</code></span>
        </div>
        <label class="toggle-control">
          <input
            type="checkbox"
            data-cli-toggle="${route.enabledEnv}"
            ${route.enabled ? raw('checked') : ''}
          />
          <span>${route.enabled ? 'Enabled' : 'Enable'}</span>
        </label>
      </div>`,
    )}
  </div>`;

  const surfaces = view.subscriptionSurfaces.map(
    (surface) => html`<tr>
      <td>${surface.label}</td>
      <td>${surface.id === 'agy-cli' ? 'Profile unverified; execution disabled' : surface.enabled ? 'Configured; checked before execution' : 'Disabled'}</td>
      <td>${surface.optedIn ? 'Allowance consented for on-demand runs' : 'First run asks for allowance consent'}</td>
    </tr>`,
  );

  if (surfaces.length === 0) {
    return html`<section class="card">
      <h2>Subscription agent surfaces</h2>
      <p class="muted small">
        Separately labeled authenticated CLI measurements that use signed-in plan allowance and possible overage (not ChatGPT web or Claude.ai).
      </p>
      ${cliToggleCards}
      <p class="muted small">
        Authenticate the local Codex or Claude Code CLI, then toggle a route above (writes <code>HEARSAY_CODEX_ENABLED=1</code> or <code>HEARSAY_CLAUDE_CODE_ENABLED=1</code> to <code>.env</code>). Internal search count has no enforceable ceiling.
      </p>
      <p class="form-error" data-form-error hidden></p>
    </section>`;
  }

  const schedule = view.subscriptionSchedule;
  const targetCeiling = schedule?.targetCeiling ?? Math.max(1, view.activePrompts * view.subscriptionSamples);
  const budgets = view.subscriptionBudgets.map(
    (budget) => html`<tr>
      <td>${budget.surface}</td>
      <td>${budget.executable}</td>
      <td>${budget.timeoutMs} ms · ${budget.maxOutputBytes} bytes output</td>
      <td>required · internal search count has no enforceable ceiling</td>
    </tr>`,
  );
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
    <p class="muted small">
      Separately labeled authenticated CLI measurements. They are not measurements of the ChatGPT web app or Claude.ai,
      and they consume signed-in plan allowance or possible overage.
    </p>
    ${cliToggleCards}
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
            <p class="muted small">A completed verified on-demand run for each selected surface is required before persistent consent is saved.</p>
            <p class="form-error" data-form-error hidden></p>
          </form>`}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view */
function trackingHealthPanel(view) {
  const apiBadge = scheduleStatusInfo('api', {
    trackingHealth: view.trackingHealth,
    demo: view.demo,
    hasSearch: view.enabledApiSearch,
    recurringSearchApproved: view.recurringSearchApproved,
    collecting: view.runningLanes.api,
  });
  const subBadge = scheduleStatusInfo('subscription', {
    trackingHealth: view.trackingHealth,
    demo: view.demo,
    collecting: view.runningLanes.subscription,
  });

  const rows = [
    {
      label: 'API panel',
      lane: view.trackingHealth.api,
      badge: apiBadge,
    },
    {
      label: 'Subscription agents',
      lane: view.trackingHealth.subscription,
      badge: subBadge,
    },
  ].map(
    ({ label, lane, badge }) => html`<article class="health-lane">
      <div class="health-lane-head">
        <h3>${label}</h3>
        ${scheduleStatusBadge(badge)}
      </div>
      <dl class="kv">
        <dt>Schedule status</dt><dd>${badge.status}</dd>
        <dt>Runtime state</dt><dd>${badge.summary}</dd>
        <dt>Last successful observation</dt><dd>${lane.lastSuccessfulObservationAt ?? 'None yet'}</dd>
        <dt>Next occurrence</dt><dd>${badge.state === 'configured' && !lane.nextScheduledAt ? 'Suspended until consent' : badge.state === 'configured' && label === 'Subscription agents' ? 'Suspended until consent' : lane.nextScheduledAt ?? 'None'}</dd>
        <dt>Recent missed or failed runs</dt><dd>${lane.recentIssues.length
          ? lane.recentIssues.map((issue) => html`<span>${issue.status} on ${issue.occurredAt} (run ${issue.runId})<br /></span>`)
          : 'None'}</dd>
      </dl>
    </article>`,
  );

  return html`<section class="card" aria-label="Tracking health">
    <h2>Tracking health</h2>
    <p class="muted small">Times are UTC across all profiles. Schedules run only while the Hearsay server is running.</p>
    <div class="health-lanes">${rows}</div>
    ${view.trackingHealth.api.guidance ? html`<p class="muted small">${view.trackingHealth.api.guidance}</p>` : ''}
    ${view.trackingHealth.subscription.guidance ? html`<p class="muted small">${view.trackingHealth.subscription.guidance}</p>` : ''}
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const allKeyRows = [...view.providers, view.tavily];
  const rows = view.providers.map(
    (provider) => html`<tr>
      <td>${provider.label}</td>
      <td>
        <span class="status-pill ${provider.enabled ? 'status-pill-active' : 'status-pill-off'}">
          ${provider.enabled ? 'Enabled' : 'No API key'}
        </span>
      </td>
      <td><code>${provider.model}</code></td>
      <td class="num">${provider.maskedHint ?? html`<span class="muted">set ${provider.keyEnv}</span>`}</td>
    </tr>`,
  );

  const body = html`${workspaceModePanel(view)}${trackingHealthPanel(view)}${subscriptionPanel(view)}
    <section class="card">
      <h2>API providers</h2>
      <p class="muted small">
        Connect optional direct-API panel providers and Tavily web search. Keys are written atomically to local <code>.env</code> with <code>0600</code> permissions and are never stored in SQLite or returned unmasked.
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
        <tbody>${rows}</tbody>
      </table></div>

      <form class="provider-key-form" data-onboarding-providers-form autocomplete="off">
        <div class="provider-key-grid">
          ${allKeyRows.map(
            (row) => html`<div class="provider-key-item">
              <div class="provider-key-head">
                <strong>${row.label}</strong>
                <span class="status-pill ${row.enabled ? 'status-pill-active' : 'status-pill-off'}">
                  ${row.enabled ? `Configured · ${row.maskedHint ?? '****'}` : 'Not set'}
                </span>
              </div>
              <span class="muted small">
                <code>${row.keyEnv}</code>${row.model ? html` · <code>${row.model}</code>` : ' · Research web search'}
              </span>
              <div class="provider-key-input-row">
                <input
                  type="password"
                  name="${row.keyEnv}"
                  placeholder="${row.enabled ? 'Paste new key to replace…' : `Paste ${row.keyEnv}…`}"
                  autocomplete="new-password"
                  spellcheck="false"
                />
                ${row.enabled
                  ? html`<button type="button" class="btn btn-sm" data-clear-key="${row.keyEnv}">Clear</button>`
                  : ''}
              </div>
            </div>`,
          )}
        </div>
        <div class="provider-key-actions">
          <button type="submit" class="btn btn-primary">Save keys to local .env</button>
          <span class="muted small" data-onboarding-saved hidden>Saved</span>
        </div>
        <p class="form-error" data-form-error hidden></p>
      </form>
      <p class="muted small">Gemini API search is off by default. Set <code>HEARSAY_GEMINI_SEARCH_POLICY=auto</code> to use Google Search grounding with the validated Gemini model.</p>
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
      <h2>Data &amp; exports</h2>
      <dl class="kv">
        <dt>Database</dt>
        <dd><code>${view.dbPath}</code></dd>
        <dt>Size on disk</dt>
        <dd>${humanSize(view.dbBytes)}</dd>
      </dl>
      <div class="export-actions">
        <a class="btn btn-primary" href="/api/export/report">Export Client Report (.html)</a>
        <a class="btn" href="/api/export" download="hearsay-export.json">Export everything as JSON</a>
      </div>
      <p class="muted small">Zero secrets in exports: API keys live in <code>.env</code> and are never included.</p>
    </section>`;

  return layout({ title: 'Settings', active: '/settings', ctx, body });
}
