/** GET /setup — the first-run wizard & zero-.env browser onboarding (§11.8). */

import {
  detectCliExecutable,
  html,
  layout,
  maskOnboardingHint,
  raw,
  SURFACE_LABEL,
  usd,
} from '../layout.js';
import { estimateRunCost } from '../../core/cost.js';
import { apiExecutionBudget } from '../../core/execution-budget.js';
import { activePromptCount, brandEntity, listEntities } from '../queries.js';

/**
 * @typedef {Object} SetupProviderRow
 * @property {string} id
 * @property {string} label
 * @property {string|null} model
 * @property {boolean} enabled
 * @property {string|null} maskedKey masked form only, never the key (§19.6 #9)
 * @property {string|null} maskedHint prefix-only hint, e.g. "sk-...****"
 * @property {string} keyEnv
 * @property {'panel_api'|'research_search'} kind
 */

/**
 * @typedef {Object} SetupCliRoute
 * @property {string} key
 * @property {string} id
 * @property {string} label
 * @property {string} enabledEnv
 * @property {boolean} detected
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} SetupView
 * @property {number} step 1|2|3
 * @property {boolean} demo
 * @property {import('../queries.js').Entity[]} entities everything named so far
 * @property {{id: number, name: string}|null} brand the `is_self` entity, once there is one
 * @property {string[]} competitors names of the non-brand entities
 * @property {number} promptCount active prompts
 * @property {boolean} hasKey at least one provider key is configured
 * @property {SetupProviderRow[]} providers
 * @property {SetupProviderRow} tavily
 * @property {SetupCliRoute[]} cliRoutes
 * @property {number} samples
 * @property {string[]} subscriptionSurfaces configured subscription measurement surfaces
 * @property {number} subscriptionSamples allowance-safe subscription samples per prompt
 * @property {number} calls calls the first run would make (§4.2)
 * @property {number} subscriptionCalls subscription targets in the first run
 * @property {number|null} estUsd null when the price table has no entry — never a guess (§4.3)
 * @property {number|null} knownSubtotalUsd priced components when the full estimate is unknown
 * @property {string[]} unpriced providers with an unknown price component
 * @property {boolean} hasUnboundedSearch
 * @property {boolean} hasSearch
 */

/**
 * @param {import('./dashboard.js').PageDeps & {runtime?: import('../../server.js').OnboardingRuntime}} deps
 * @param {URLSearchParams} [query]
 * @returns {SetupView}
 */
export function buildView(deps, query) {
  const { db, config } = deps;
  const requested = Number.parseInt(query?.get('step') ?? '1', 10);
  const step = Number.isFinite(requested) && requested >= 1 && requested <= 3 ? requested : 1;
  const entities = listEntities(db);
  const brand = brandEntity(db);
  const competitors = entities.filter((entity) => entity.is_self !== 1);
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

  const tavilyKey = deps.runtime
    ? deps.runtime.getEnvValue('TAVILY_API_KEY')
    : String(process.env.TAVILY_API_KEY ?? '');
  const pathEnv = deps.runtime ? deps.runtime.getPathEnv() : process.env.PATH;

  return {
    step,
    demo: config.demo,
    entities,
    brand: brand ? { id: brand.id, name: brand.name } : null,
    competitors: competitors.map((entity) => entity.name),
    promptCount: prompts,
    hasKey: enabled.length > 0,
    providers: Object.values(config.providers).map((provider) => ({
      id: provider.id,
      label: provider.label,
      model: provider.model,
      enabled: provider.enabled,
      maskedKey: provider.maskedKey,
      maskedHint: maskOnboardingHint(provider.apiKey),
      keyEnv: provider.keyEnv,
      kind: 'panel_api',
    })),
    tavily: {
      id: 'tavily',
      label: 'Tavily Search',
      model: null,
      enabled: tavilyKey.trim() !== '',
      maskedKey: null,
      maskedHint: maskOnboardingHint(tavilyKey),
      keyEnv: 'TAVILY_API_KEY',
      kind: 'research_search',
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
    samples: config.samples,
    subscriptionSurfaces: config.subscriptionSurfaces,
    subscriptionSamples: config.subscriptionSamples,
    calls: estimate.calls,
    subscriptionCalls: prompts * config.subscriptionSamples * config.subscriptionSurfaces.length,
    estUsd: estimate.estUsd,
    knownSubtotalUsd: estimate.knownSubtotalUsd,
    unpriced: estimate.unpriced,
    hasUnboundedSearch: estimate.hasUnboundedSearch,
    hasSearch: estimate.hasSearch,
  };
}

/**
 * Prominent top banner letting new users explore the full Notewell demo in 1 click.
 * @returns {import('../layout.js').RawHtml}
 */
function demoHeroBanner() {
  return html`<section class="card onboarding-hero" aria-label="Interactive demo and quickstart">
    <div class="onboarding-hero-main">
      <div>
        <p class="onboarding-eyebrow">Zero-setup preview</p>
        <h2>Preview Hearsay with 30 days of sample B2B data</h2>
        <p class="muted">
          Inspect multi-engine AI answers, Wilson 95% confidence intervals, and competitor citation gaps in an isolated demo workspace before connecting your own brand.
        </p>
      </div>
      <div class="onboarding-hero-cta">
        <button type="button" class="btn btn-primary" data-switch-demo="true">
          Explore Interactive Notewell Demo (1 Click, $0)
        </button>
        <p class="muted small">Already ran an agent study? <a href="/research">Import into Research →</a></p>
      </div>
    </div>
    <p class="form-error" data-form-error hidden></p>
  </section>`;
}

/**
 * Browser Provider & Route Connection card: save API keys to `.env` (`0600`) or toggle
 * local CLI routes in-process without opening a terminal editor.
 *
 * @param {SetupView} view
 * @returns {import('../layout.js').RawHtml}
 */
function providerConnectionCard(view) {
  const allKeyRows = [...view.providers, view.tavily];

  return html`<section class="card onboarding-connect" aria-label="Browser provider and route connection">
    <div class="onboarding-section-head">
      <div>
        <h2>Browser Provider &amp; Route Connection</h2>
        <p class="muted small">
          Saved locally to <code>.env</code> with strict <code>0600</code> file permissions. Keys stay on your machine and are never returned to the browser.
        </p>
      </div>
    </div>

    <div class="cli-route-grid">
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
            <span class="muted small"><code>${route.enabledEnv}</code> · uses signed-in plan allowance</span>
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
    </div>

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
  </section>`;
}

/**
 * @param {number} step
 * @returns {import('../layout.js').RawHtml}
 */
function steps(step) {
  const labels = ['Brand', 'Prompts', 'Connect & Go'];
  return html`<nav class="steps" aria-label="Setup steps">
    ${labels.map((label, i) =>
      i + 1 === step
        ? html`<strong aria-current="step">${i + 1} · ${label}</strong>`
        : html`<a href="/setup?step=${i + 1}">${i + 1} · ${label}</a>`,
    )}
  </nav>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function stepBrand(view) {
  const brandEntityRow = view.entities.find((entity) => entity.is_self === 1) ?? null;
  const competitorRows = view.entities.filter((entity) => entity.is_self !== 1);
  const existing =
    view.entities.length === 0
      ? html`<p class="muted small">Nothing named yet.</p>`
      : html`<ul class="plain entity-pill-list">
          ${view.entities.map(
            (entity) => html`<li>
              <strong>${entity.name}</strong>${entity.domains.length > 0 ? html` <span class="muted small">(${entity.domains.join(', ')})</span>` : ''}${entity.is_self === 1 ? html` <span class="tag">your brand</span>` : ''}
            </li>`,
          )}
        </ul>`;

  return html`<section class="card">
    <h2>1 · Your brand</h2>
    <p class="muted">Paste your website and competitor URLs to set up in one step, or customize aliases below.</p>

    <form class="url-quickstart" data-onboarding-urls-form autocomplete="off">
      <div class="form-grid">
        <label>
          <span>Your website URL</span>
          <input
            type="text"
            name="brandUrl"
            value="${brandEntityRow?.domains[0] ?? ''}"
            placeholder="https://yourcompany.com"
          />
        </label>
        <label>
          <span>Brand name <span class="muted small">(optional — inferred from URL)</span></span>
          <input
            type="text"
            name="brandName"
            value="${brandEntityRow?.name ?? ''}"
            placeholder="Your Company"
          />
        </label>
      </div>
      <label class="url-competitors-field">
        <span>Competitor URLs or names <span class="muted small">(comma-separated — up to 3 get chart colours)</span></span>
        <input
          type="text"
          name="competitors"
          value="${competitorRows.map((c) => c.domains[0] || c.name).join(', ')}"
          placeholder="https://competitor1.com, https://competitor2.com, Competitor 3"
        />
      </label>
      <div class="url-quickstart-foot">
        <button type="submit" class="btn btn-primary">Save URLs &amp; draft buyer questions →</button>
        <span class="muted small" data-url-preview></span>
      </div>
    </form>

    <div class="setup-subblock">
      <h3>Manual brand &amp; alias controls</h3>
      <form class="inline-form" data-api-form="/api/entities" data-method="POST" data-after="reload">
        <label class="grow">
          <span>Brand name</span>
          <input type="text" name="name" placeholder="Acme" required />
        </label>
        <label class="grow">
          <span>Aliases</span>
          <input type="text" name="aliases" data-list placeholder="Acme AI, AcmeHQ" />
        </label>
        <label class="grow">
          <span>Domain</span>
          <input type="text" name="domains" data-list placeholder="acme.com" />
        </label>
        <input type="hidden" name="is_self" value="true" data-bool />
        <button type="submit" class="btn">Save brand</button>
      </form>
      <h3>Competitors</h3>
      <form class="inline-form" data-api-form="/api/entities" data-method="POST" data-after="reload">
        <label class="grow">
          <span>Name</span>
          <input type="text" name="name" placeholder="Competitor" required />
        </label>
        <label class="grow">
          <span>Domain</span>
          <input type="text" name="domains" data-list placeholder="competitor.com" />
        </label>
        <button type="submit" class="btn">Add competitor</button>
      </form>
    </div>

    <p class="form-error" data-form-error hidden></p>
    <h3>Tracked entities</h3>
    ${existing}
    <p><a class="btn" href="/setup?step=2">Next: buyer prompts →</a></p>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function stepPrompts(view) {
  return html`<section class="card">
    <h2>2 · Your buyer questions</h2>
    <p class="muted">Describe the buying decision in plain English to draft five multi-phrasing buyer intents.</p>
    <form id="suggest-form">
      <div class="form-grid">
        <label><span>Who buys from you?</span><input name="audience" type="text" placeholder="Small sales teams" required /></label>
        <label><span>Product or job</span><input name="productJob" type="text" placeholder="Record and summarize sales calls" required /></label>
        <label><span>Desired conversion</span><input name="desiredConversion" type="text" placeholder="Start a trial" required /></label>
      </div>
      <details class="setup-optional-fields">
        <summary>Optional language, market &amp; local context notes</summary>
        <div class="form-grid">
          <label><span>Preferred language</span><input name="languagePreference" type="text" placeholder="English" /></label>
          <label><span>Market</span><input name="marketContext" type="text" placeholder="United States" /></label>
          <label><span>Context notes</span><textarea name="contextNotes" rows="2" placeholder="Sales or support context (local only)"></textarea></label>
        </div>
      </details>
      <button type="submit" class="btn">Draft five intents</button>
    </form>
    <div id="suggest-list" data-entities="${JSON.stringify(
      view.entities.map((entity) => ({
        name: entity.name,
        aliases: entity.aliases,
        domains: entity.domains,
        isSelf: entity.is_self === 1,
      })),
    )}"></div>
    <p><button type="button" class="btn" id="suggest-add-intent">Add my own intent</button></p>
    <p class="muted small">Branded questions measure recall and stay out of share-of-voice denominators by default.</p>
    <p><button type="button" class="btn btn-primary" id="suggest-review">Save and review questions</button></p>
    <section id="suggest-review-panel" class="card" aria-live="polite" hidden>
      <h3>Review tracking questions</h3>
      <div id="suggest-review-details"></div>
      <button type="button" class="btn btn-primary" id="suggest-approve">Approve these questions for tracking</button>
    </section>
    <p id="suggest-status" aria-live="polite" hidden></p>
    <p class="form-error" data-form-error role="alert" hidden></p>
    <p class="muted small">${view.promptCount} active questions so far. You can draft and edit without an API key or subscription route. A valid route is required before a run.</p>
    <p><a class="btn" href="/setup?step=3">Next: connect &amp; run →</a></p>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function stepGo(view) {
  const rows = view.providers.map(
    (provider) => html`<tr>
      <td>${provider.label}</td>
      <td>
        <span class="status-pill ${provider.enabled ? 'status-pill-active' : 'status-pill-off'}">
          ${provider.enabled ? 'Configured' : 'No API key'}
        </span>
      </td>
      <td><code>${provider.model}</code></td>
      <td class="num">${provider.maskedHint ?? html`<span class="muted">set ${provider.keyEnv}</span>`}</td>
    </tr>`,
  );

  const subscriptionRows = view.subscriptionSurfaces.map(
    (surface) => html`<tr>
      <td>${SURFACE_LABEL[surface] ?? surface}</td>
      <td><span class="status-pill status-pill-active">Enabled</span></td>
      <td>${view.subscriptionSamples} sample(s) per prompt</td>
    </tr>`,
  );

  const subscriptionSection =
    view.subscriptionSurfaces.length > 0
      ? html`<section class="setup-subblock">
          <h3>Configured subscription surfaces</h3>
          <p class="muted small">
            Uses signed-in CLI plan allowance (may incur overage; separate from ChatGPT web or Claude.ai).
          </p>
          <div class="table-scroll"><table class="table">
            <thead>
              <tr>
                <th>Surface</th>
                <th>Status</th>
                <th>Sampling</th>
              </tr>
            </thead>
            <tbody>${subscriptionRows}</tbody>
          </table></div>
          <p class="small">${view.subscriptionCalls} subscription calls in the first run (${view.promptCount} questions × ${view.subscriptionSamples} samples × ${view.subscriptionSurfaces.length} surfaces).</p>
          ${view.demo
            ? html`<p class="muted">Demo mode is on, so live subscription runs are disabled.</p>`
            : html`<form class="inline-form" data-api-form="/api/subscription/run" data-subscription-run>
                <label class="grow">
                  <span>Subscription surfaces</span>
                  <input name="surfaces" data-list value="${view.subscriptionSurfaces.join(',')}" required />
                </label>
                <input type="hidden" name="lane" value="tracking" />
                <input type="hidden" name="samples" value="${view.subscriptionSamples}" />
                <button type="submit" class="btn">Preview subscription run</button>
                <p class="form-error" data-form-error hidden></p>
              </form>`}
        </section>`
      : html`<section class="setup-subblock">
          <h3>Subscription surfaces</h3>
          <p class="muted small">
            Toggle Codex or Claude Code in the connection card above (sets <code>HEARSAY_CODEX_ENABLED=1</code> / <code>HEARSAY_CLAUDE_CODE_ENABLED=1</code> in <code>.env</code>) after authenticating the CLI.
          </p>
        </section>`;

  return html`<section class="card">
    <h2>3 · Go</h2>
    <p class="muted"><strong>First-run target count:</strong> ${view.calls + view.subscriptionCalls} total (${view.calls} API, ${view.subscriptionCalls} subscription) across ${view.promptCount} active questions.</p>
    ${subscriptionSection}
    <section class="setup-subblock">
      <h3>Optional API providers</h3>
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
      <dl class="kv">
        <dt>API calls in the first run</dt>
        <dd>${view.calls} <span class="muted">${view.promptCount} prompts × ${view.samples} samples per API provider</span></dd>
        <dt>Estimated API cost</dt>
        <dd>
          ${view.estUsd === null
            ? !view.hasKey
              ? html`<span class="muted">Add an API key above to preview cost.</span>`
              : view.knownSubtotalUsd === null
                ? html`<span class="muted">Unknown: ${view.unpriced.join(', ')} needs a checked price.</span>`
                : html`<span class="muted">${usd(view.knownSubtotalUsd)} known subtotal plus unknown ${view.unpriced.join(', ')} components.</span>`
            : usd(view.estUsd)}
        </dd>
      </dl>
      ${view.hasSearch
        ? html`<p class="muted small">Assumes one web-search call per search-enabled target.${view.hasUnboundedSearch ? ' An enabled search route has no enforceable internal call ceiling.' : ''}</p>`
        : ''}
      ${view.demo
        ? html`<p class="muted">Demo mode is on, so live API runs are disabled.</p>`
        : view.hasKey
          ? html`<p><button type="button" class="btn btn-primary" id="run-panel-setup">Run first API panel</button></p>`
          : html`<p class="muted small">No API provider key configured yet — paste one in the connection card above if you want direct API runs.</p>`}
    </section>
    <p><a class="btn" href="/">Open dashboard →</a></p>
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  if (view.demo) {
    const body = html`<section class="card onboarding-hero">
      <div class="onboarding-hero-main">
        <div>
          <p class="onboarding-eyebrow">Demo workspace active</p>
          <h2>Set up your real brand</h2>
          <p class="muted">
            You are viewing the fictional Notewell dataset (<code>data/demo/hearsay.db</code>). Switch to your live workspace (<code>data/hearsay.db</code>) in one click — both databases stay intact with no server restart.
          </p>
        </div>
        <div class="onboarding-hero-cta">
          <button type="button" class="btn btn-primary" data-switch-demo="false">
            Exit Demo → Set Up My Brand
          </button>
        </div>
      </div>
      <p class="form-error" data-form-error hidden></p>
    </section>`;
    return layout({ title: 'Setup', active: '/setup', ctx, body });
  }

  const panel = view.step === 1 ? stepBrand(view) : view.step === 2 ? stepPrompts(view) : stepGo(view);
  const body = html`${demoHeroBanner()}${steps(view.step)}${
    view.step === 3 ? html`${providerConnectionCard(view)}${panel}` : html`${panel}${providerConnectionCard(view)}`
  }<p class="muted small"><a href="/">Skip to dashboard →</a></p>`;
  return layout({ title: 'Setup', active: '/setup', ctx, body });
}
