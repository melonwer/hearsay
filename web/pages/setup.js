/**
 * GET /setup — first-run wizard (§11.8). Three skippable steps, server-rendered forms.
 *
 * Phase 0 renders the step outline; Lane C wires the forms to the §10.3 API, the
 * prompt-suggestion checklist and the cost estimate.
 */

import { html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {{enabledProviders: string[]}} view
 * @returns {string}
 */
export function render(ctx, view) {
  const providers =
    view.enabledProviders.length > 0
      ? view.enabledProviders.join(', ')
      : 'none detected — add a key to .env, or seed the demo universe instead';

  const body = html`<section class="card">
      <h2>1 · Your brand</h2>
      <p>Name your brand, its aliases and its domain, plus up to three competitors.</p>
      <p class="muted">Mentions are counted for these names only, so spelling variants matter.</p>
      <p><a class="btn" href="/entities">Open entities</a></p>
    </section>
    <section class="card">
      <h2>2 · Prompts</h2>
      <p>Describe what you sell and Hearsay drafts intents with three paraphrases each. Nothing saves until you
        review the list.</p>
      <p class="muted">Prompts containing your brand name are tagged <code>branded</code>: they measure recall, not
        discovery, so they stay out of share-of-voice by default.</p>
      <p><a class="btn" href="/prompts">Open prompts</a></p>
    </section>
    <section class="card">
      <h2>3 · Go</h2>
      <p>Engines detected from the environment: ${providers}.</p>
      <p class="muted">The cost estimate for your panel and the first run button arrive with the provider
        adapters.</p>
      <p><a href="/">Skip setup</a></p>
    </section>`;

  return layout({ title: 'Setup', active: '/setup', ctx, body });
}
