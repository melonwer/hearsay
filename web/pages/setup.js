/**
 * GET /setup — the first-run wizard (§11.8).
 *
 * Three steps, each skippable, no SPA state: server-rendered forms that post to the
 * §10.3 API. "Skip setup" is on every step, and none of the normal CRUD pages are
 * blocked while the wizard is open.
 *
 * Step 2 asks `core/suggest.js` for a draft. With no provider key configured it falls
 * back to the static starter pack (§20.3) with the user's own entity names filled in —
 * the flow never dead-ends just because nothing is wired up yet.
 */

import { html, layout, SURFACE_LABEL, usd } from '../layout.js';
import { estimateRunCost } from '../../core/cost.js';
import { apiExecutionBudget } from '../../core/execution-budget.js';
import { activePromptCount, brandEntity, listEntities } from '../queries.js';

/**
 * Starter prompt pack (§20.3) — generic placeholders the user edits. The first eight
 * are fixed; the last four are the category-specific slots the wizard fills from the
 * entities that already exist.
 */
export const STARTER_TEMPLATES = /** @type {readonly string[]} */ ([
  "What's the best {category} for {audience}?",
  'Top 5 {category} in {year}',
  '{Brand} vs {Competitor} — which is better?',
  'Is {Brand} worth it?',
  'Cheapest way to {job-to-be-done}',
  'Best free alternative to {Competitor}',
  '{category} with the best {key feature}',
  'What do people say about {Brand}?',
  'Who are the main alternatives to {Brand}?',
  'Which {category} do {audience} actually recommend?',
  '{Competitor} vs {Competitor2} — what do people pick?',
  'What should {audience} know before buying a {category}?',
]);

/**
 * Fill the starter pack from whatever entities exist. Placeholders with no source are
 * left in place: the user edits them, and an unedited placeholder is obvious.
 *
 * @param {{brand: string|null, competitors: string[]}} names
 * @param {number} [year]
 * @returns {{text: string, category: string}[]}
 */
export function starterPack({ brand, competitors }, year = new Date().getUTCFullYear()) {
  /** @type {Record<string, string|undefined>} */
  const fills = {
    '{Brand}': brand ?? undefined,
    '{Competitor}': competitors[0],
    '{Competitor2}': competitors[1] ?? competitors[0],
    '{year}': String(year),
  };
  /** @type {{text: string, category: string}[]} */
  const out = [];
  for (const template of STARTER_TEMPLATES) {
    let text = template;
    for (const [token, value] of Object.entries(fills)) {
      if (value !== undefined) text = text.split(token).join(value);
    }
    if (text.includes('{Competitor')) continue; // no competitor named yet — drop, do not ship a placeholder pair
    // A prompt that names the brand measures recall, not discovery (§6.7).
    const branded = brand !== null && text.includes(brand);
    out.push({ text, category: branded ? 'branded' : 'general' });
  }
  return out;
}

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
 * @property {('codex-agent'|'claude-code-agent')[]} subscriptionSurfaces configured subscription measurement surfaces
 * @property {number} subscriptionSamples allowance-safe subscription samples per prompt
 * @property {number} calls calls the first run would make (§4.2)
 * @property {number|null} estUsd null when the price table has no entry — never a guess (§4.3)
 * @property {boolean} hasUnboundedSearch
 * @property {boolean} hasSearch
 * @property {{text: string, category: string}[]} starter starter pack, entity names filled in (§20.3)
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
    estUsd: estimate.estUsd,
    hasUnboundedSearch: estimate.hasUnboundedSearch,
    hasSearch: estimate.hasSearch,
    starter: starterPack({ brand: brand?.name ?? null, competitors: competitors.map((entity) => entity.name) }),
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
  const checklist = view.starter.map(
    (prompt, i) => html`<li>
      <label class="check">
        <input type="checkbox" data-suggest-check checked />
        <input type="text" data-suggest-text value="${prompt.text}" size="60" />
        <input type="hidden" data-suggest-category value="${prompt.category}" />
      </label>
      ${prompt.category === 'branded' ? html`<span class="tag">branded</span>` : ''}
      <span class="visually-hidden">suggestion ${i + 1}</span>
    </li>`,
  );

  return html`<section class="card">
    <h2>2 · Prompts</h2>
    <p>
      Describe what you sell and Hearsay drafts intents with three paraphrases each. Nothing saves until you review
      the list.
    </p>
    <p class="muted small">
      Prompts containing your brand name are tagged <code>branded</code>: they measure recall, not discovery, so they
      stay out of share-of-voice by default.
    </p>
    ${view.hasKey
      ? html`<form class="inline-form" id="suggest-form">
          <label class="grow">
            <span>What does your product do, and what would a buyer ask?</span>
            <input type="text" name="keywords" placeholder="AI meeting notes for small sales teams" />
          </label>
          <button type="submit" class="btn">Draft prompts</button>
        </form>`
      : html`<p class="muted">
          No provider key is configured, so this is the starter pack instead of a model-drafted list. Edit the
          placeholders and save the ones you want.
        </p>`}
    <ul class="plain suggest-list" id="suggest-list">
      ${checklist}
    </ul>
    <p>
      <button type="button" class="btn" id="suggest-save">Save selected prompts</button>
      <a href="/setup?step=3">Skip to run →</a>
    </p>
    <p class="form-error" data-form-error hidden></p>
    <p class="muted small">${view.promptCount} active prompts so far.</p>
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
    ${subscriptionSection}
    <section>
      <h3>Optional API providers</h3>
      <p class="muted">
        API keys are optional. These direct API providers add expanded coverage for OpenAI, Anthropic, Gemini and
        Perplexity. API dollar estimates and computed usage costs below apply only to API usage.
      </p>
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
            ? html`<span class="muted">not available until the price table covers your models — Hearsay does not guess</span>`
            : usd(view.estUsd)}
        </dd>
      </dl>
      ${view.hasSearch ? html`<p class="muted">This forecast assumes one web-search call per search-enabled target.${view.hasUnboundedSearch ? ' OpenAI does not enforce a search-call ceiling.' : ''}</p>` : ''}
      ${view.demo
        ? html`<p class="muted">Demo mode is on, so live API runs are disabled. Turn it off with <code>HEARSAY_DEMO=0</code>.</p>`
        : view.hasKey
          ? html`<p><button type="button" class="btn" id="run-panel-setup">Run first API panel</button></p>`
          : html`<p class="muted">No API provider is configured. Add an API key only if you want direct API measurements.</p>`}
    </section>
    <p class="muted small">
      Load the fictional demo universe instead: <code>node scripts/seed.js</code>.
    </p>
    <p><a href="/">Finish →</a></p>
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const panel = view.step === 1 ? stepBrand(view) : view.step === 2 ? stepPrompts(view) : stepGo(view);
  const body = html`${steps(view.step)}${panel}
    <p><a href="/">Skip setup</a></p>`;
  return layout({ title: 'Setup', active: '/setup', ctx, body });
}
