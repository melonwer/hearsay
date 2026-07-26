/**
 * GET /methodology — renders METHODOLOGY.md (§11.6).
 *
 * Phase 0 renders the shell plus the standing caveats. Phase 3 writes METHODOLOGY.md
 * and this page renders it (tiny built-in markdown subset — no dependency).
 */

import { html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @returns {string}
 */
export function render(ctx) {
  const body = html`<section class="card">
    <h2>How Hearsay measures</h2>
    <p>
      Every prompt is asked several times per engine and grouped with its paraphrases, so each published rate carries
      a sample size and a 95% Wilson interval. Days with no valid responses render as gaps, never as zeros.
    </p>
    <p class="muted">
      API answers approximate, but do not equal, what a person sees in a consumer app: consumer products add their own
      system prompts, tools, web search, memory and personalisation. That is a bias no amount of sampling removes, and
      it is stated here rather than hidden.
    </p>
    <p class="muted">The full write-up lands in METHODOLOGY.md and renders on this page.</p>
  </section>`;
  return layout({ title: 'Methodology', active: '/methodology', ctx, body });
}
