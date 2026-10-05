/** GET /setup — the first-run wizard (§11.8). */

import { html, layout, SURFACE_LABEL, usd } from '../layout.js';
import { estimateRunCost } from '../../core/cost.js';
import { apiExecutionBudget } from '../../core/execution-budget.js';
import { activePromptCount, brandEntity, listEntities } from '../queries.js';

/**
 * @typedef {Object} SetupProviderRow
 * @property {string} label
 * @property {string} model
 * @property {boolean} enabled
 * @property {string|null} maskedKey masked form only, never the key (§19.6 #9)
 * @property {string} keyEnv
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
 * @param {import('./dashboard.js').PageDeps} deps
 * @param {URLSearchParams} [query]
 * @returns {SetupView}
 */
export function buildView({ db, config }, query) {
  const requested = Number.parseInt(query?.get('step') ?? '1', 10);
  const step = Number.isFinite(requested) && requested >= 1 && requested <= 3 ? requested : 1;
  const entities = listEntities(db);
  const brand = brandEntity(db);
  const competitors = entities.filter((entity) => entity.is_self !== 1);
  const prompts = activePromptCount(db);
  const enabled = config.enabledProviders;
  const executionBudgets = enabled.map(({ id }) => apiExecutionBudget(config, id));

  const estimate = estimateRunCost(
    { promptCount: prompts, samples: config.samples, providers: enabled.map(({ id, model }, index) =>
      ({ id, model, searchPolicy: config.apiSearchPolicies[id],
        searchCallLimitEnforced: executionBudgets[index].searchCallLimitEnforced })) },
    config.pricingEnv,
  );

  return {
    step,
    demo: config.demo,
    entities,
    brand: brand ? { id: brand.id, name: brand.name } : null,
    competitors: competitors.map((entity) => entity.name),
    promptCount: prompts,
    hasKey: enabled.length > 0,
    providers: Object.values(config.providers).map((provider) => ({
      label: provider.label,
      model: provider.model,
      enabled: provider.enabled,
      maskedKey: provider.maskedKey,
      keyEnv: provider.keyEnv,
    })),
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
 * @param {number} step
 * @returns {import('../layout.js').RawHtml}
 */
function steps(step) {
  const labels = ['Brand', 'Prompts', 'Go'];
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
  const existing =
    view.entities.length === 0
      ? html`<p class="muted">Nothing named yet.</p>`
      : html`<ul class="plain">
          ${view.entities.map(
            (entity) => html`<li>${entity.name}${entity.is_self === 1 ? html` <span class="tag">your brand</span>` : ''}</li>`,
          )}
        </ul>`;

  return html`<section class="card">
    <h2>1 · Your brand</h2>
    <p>Name your brand, its aliases and its domain. Mentions are counted for these names only, so spelling variants matter.</p>
    <form class="inline-form" data-api-form="/api/entities" data-method="POST" data-after="reload">
      <label class="grow">
        <span>Brand name</span>
        <input type="text" name="name" required />
      </label>
      <label class="grow">
        <span>Aliases</span>
        <input type="text" name="aliases" data-list placeholder="comma, separated" />
      </label>
      <label class="grow">
        <span>Domain</span>
        <input type="text" name="domains" data-list placeholder="example.com" />
      </label>
      <input type="hidden" name="is_self" value="true" data-bool />
      <button type="submit" class="btn">Save brand</button>
    </form>
    <h3>Competitors</h3>
    <p class="muted small">Up to three get their own chart colour; any more show in tables only.</p>
    <form class="inline-form" data-api-form="/api/entities" data-method="POST" data-after="reload">
      <label class="grow">
        <span>Name</span>
        <input type="text" name="name" required />
      </label>
      <label class="grow">
        <span>Domain</span>
        <input type="text" name="domains" data-list placeholder="competitor.com" />
      </label>
      <button type="submit" class="btn">Add competitor</button>
    </form>
    <p class="form-error" data-form-error hidden></p>
    <h3>So far</h3>
    ${existing}
    <p><a class="btn" href="/setup?step=2">Next: prompts →</a></p>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function stepPrompts(view) {
  return html`<section class="card">
    <h2>2 · Your buyer questions</h2>
    <p>Describe the buying decision, then edit a five-intent starter or add your own questions. Three phrasings per intent are a starting suggestion. You can approve fewer.</p>
    <form id="suggest-form">
      <div class="form-grid">
        <label><span>Audience</span><input name="audience" type="text" placeholder="Small sales teams" required /></label>
        <label><span>Product or job</span><input name="productJob" type="text" placeholder="Record and summarize sales calls" required /></label>
        <label><span>Desired conversion</span><input name="desiredConversion" type="text" placeholder="Start a trial" required /></label>
        <label><span>Preferred language</span><input name="languagePreference" type="text" placeholder="English" /></label>
        <label><span>Market</span><input name="marketContext" type="text" placeholder="United States" /></label>
        <label><span>Context notes</span><textarea name="contextNotes" rows="2" placeholder="What sales or support conversations informed these questions?"></textarea></label>
      </div>
      <p class="muted small">Language and market are planning preferences. They do not enforce a provider locale. Context and source notes stay local and are never added to the provider question.</p>
      <button type="submit" class="btn">Draft five intents</button>
    </form>
    <div id="suggest-list" data-entities="${JSON.stringify(view.entities.map((entity) => ({
      name: entity.name, aliases: entity.aliases, domains: entity.domains, isSelf: entity.is_self === 1,
    })))}"></div>
    <p><button type="button" class="btn" id="suggest-add-intent">Add my own intent</button></p>
    <p class="muted small">Discovery asks about the buyer's need, comparison asks about alternatives, and branded asks about your brand. Questions that name your brand measure recall and stay out of share of voice by default.</p>
    <p><button type="button" class="btn" id="suggest-review">Save and review questions</button></p>
    <section id="suggest-review-panel" class="card" aria-live="polite" hidden>
      <h3>Review tracking questions</h3>
      <div id="suggest-review-details"></div>
      <button type="button" class="btn" id="suggest-approve">Approve these questions for tracking</button>
    </section>
    <p id="suggest-status" aria-live="polite" hidden></p>
    <p class="form-error" data-form-error role="alert" hidden></p>
    <p class="muted small">${view.promptCount} active questions so far. You can draft and edit without an API key or subscription route. A valid route is required before a run.</p>
    <p><a href="/setup?step=3">Next: run options →</a></p>
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
      <td>${provider.enabled ? 'Detected' : 'No API key'}</td>
      <td><code>${provider.model}</code></td>
      <td class="num">${provider.maskedKey ?? html`<span class="muted">set ${provider.keyEnv}</span>`}</td>
    </tr>`,
  );

  const subscriptionRows = view.subscriptionSurfaces.map(
    (surface) => html`<tr>
      <td>${SURFACE_LABEL[surface] ?? surface}</td>
      <td>Enabled</td>
      <td>${view.subscriptionSamples} sample(s) per prompt</td>
    </tr>`,
  );
  const subscriptionSection =
    view.subscriptionSurfaces.length > 0
      ? html`<section>
          <h3>Configured subscription surfaces</h3>
          <p class="muted">
            These separately labeled measurements use your signed-in plan allowance and may incur overage; they are not
            free or unlimited. They are not measurements of the ChatGPT web app or Claude.ai.
          </p>
          <table class="table">
            <thead>
              <tr>
                <th>Surface</th>
                <th>Status</th>
                <th>Sampling</th>
              </tr>
            </thead>
            <tbody>${subscriptionRows}</tbody>
          </table>
          <p>${view.subscriptionCalls} subscription calls in the first run (${view.promptCount} questions × ${view.subscriptionSamples} samples × ${view.subscriptionSurfaces.length} surfaces).</p>
          ${view.demo
            ? html`<p class="muted">Demo mode is on, so live subscription runs are disabled. Turn it off with <code>HEARSAY_DEMO=0</code>.</p>`
            : html`<form class="inline-form" data-api-form="/api/subscription/run" data-subscription-run>
                <label class="grow">
                  <span>Subscription surfaces</span>
                  <input name="surfaces" data-list value="${view.subscriptionSurfaces.join(',')}" required />
                </label>
                <input type="hidden" name="lane" value="tracking" />
                <input type="hidden" name="samples" value="${view.subscriptionSamples}" />
                <button type="submit" class="btn">Preview subscription run</button>
                <p class="muted small">A confirmation prompt appears before this uses signed-in plan allowance.</p>
                <p class="form-error" data-form-error hidden></p>
              </form>`}
        </section>`
      : html`<section>
          <h3>Subscription surfaces</h3>
          <p class="muted">
            To use signed-in subscription measurements, authenticate the local CLI and add one or both enablement
            variables to <code>.env</code>:
          </p>
          <p><code>HEARSAY_CODEX_ENABLED=1</code><br /><code>HEARSAY_CLAUDE_CODE_ENABLED=1</code></p>
          <p class="muted small">Subscription runs use plan allowance and may incur overage; they are not free or unlimited.</p>
        </section>`;

  return html`<section class="card">
    <h2>3 · Go</h2>
    <p>Reviewing a draft makes no provider calls. Running needs at least one configured API or subscription route.</p>
    <p><strong>First-run target count:</strong> ${view.calls + view.subscriptionCalls} total (${view.calls} API, ${view.subscriptionCalls} subscription) for ${view.promptCount} active questions.</p>
    ${subscriptionSection}
    <section>
      <h3>Optional API providers</h3>
      <p class="muted">
        API keys are optional. These direct API providers add expanded coverage for OpenAI, Anthropic, Gemini and
        Perplexity. API dollar estimates and computed usage costs below apply only to API usage.
      </p>
      <p class="muted small">Gemini API search is off by default. Set <code>HEARSAY_GEMINI_SEARCH_POLICY=auto</code> to use Google Search grounding with the validated Gemini model. Grounded runs use a separate profile and require a run quote.</p>
      <table class="table">
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
      </table>
      <dl class="kv">
        <dt>API calls in the first run</dt>
        <dd>${view.calls} <span class="muted">${view.promptCount} prompts × ${view.samples} samples per API provider</span></dd>
        <dt>Estimated API cost</dt>
        <dd>
          ${view.estUsd === null
            ? !view.hasKey
              ? html`<span class="muted">Add an API provider key to preview cost.</span>`
              : view.knownSubtotalUsd === null
                ? html`<span class="muted">Unknown: ${view.unpriced.join(', ')} needs a checked price.</span>`
              : html`<span class="muted">${usd(view.knownSubtotalUsd)} known subtotal plus unknown ${view.unpriced.join(', ')} components.</span>`
            : usd(view.estUsd)}
        </dd>
      </dl>
      <p class="muted small">For a first paid measurement, start with three reviewed buyer questions and one API provider. This preview uses ${view.samples} sample(s) per question.</p>
      ${view.hasSearch ? html`<p class="muted">This forecast assumes one web-search call per search-enabled target.${view.hasUnboundedSearch ? ' An enabled search route has no enforceable internal call ceiling.' : ''}</p>` : ''}
      ${view.demo
        ? html`<p class="muted">Demo mode is on, so live API runs are disabled. Turn it off with <code>HEARSAY_DEMO=0</code>.</p>`
        : view.hasKey
          ? html`<p><button type="button" class="btn" id="run-panel-setup">Run first API panel</button></p>`
          : html`<p class="muted">No API provider is configured. Add an API key only if you want direct API measurements.</p>`}
    </section>
    <p class="muted small">To explore the fictional demo separately, restart with <code>HEARSAY_DEMO=1</code>. The demo database is seeded automatically.</p>
    <p><a href="/">Finish →</a></p>
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  if (view.demo) {
    const body = html`<section class="card">
      <h2>Set up your real brand</h2>
      <p>This is the fictional demo workspace. Your real tracking data is stored separately.</p>
      <ol>
        <li>Stop this server with Ctrl+C (or stop its service).</li>
        <li>Set <code>HEARSAY_DEMO=0</code> in <code>.env</code>, then start <code>node server.js</code> again.</li>
        <li>Open <code>/setup</code> at the new local URL to review your brand and questions.</li>
      </ol>
      <p>No database deletion is needed. The default real database is <code>data/hearsay.db</code>; the demo is <code>data/demo/hearsay.db</code>. A signed-in subscription CLI or API key is only needed when you run measurements.</p>
    </section>`;
    return layout({ title: 'Setup', active: '/setup', ctx, body });
  }
  const panel = view.step === 1 ? stepBrand(view) : view.step === 2 ? stepPrompts(view) : stepGo(view);
  const body = html`<section class="card">
    <h2>Start with your agent</h2>
    <p>The standalone Hearsay skill can research an app and save a sourced report with your current agent's web access. It needs no server, API key or extra account.</p>
    <p>Already have a saved report? <a href="/research">Import it into Research</a>. This wizard configures optional dashboard measurements.</p>
  </section>${steps(view.step)}${panel}
    <p><a href="/">Skip setup</a></p>`;
  return layout({ title: 'Setup', active: '/setup', ctx, body });
}
