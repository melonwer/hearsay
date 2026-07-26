/**
 * GET /alerts — alert list with acknowledge (§9, §11.3 item 5).
 *
 * Phase 0 renders the shell; Lane C adds severity icon + word chips (never colour
 * alone), relative times and the Ack action.
 */

import { emptyState, html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @returns {string}
 */
export function render(ctx) {
  const body = html`${emptyState({
    title: 'No alerts',
    line: 'Alerts appear after two comparable runs, so a single noisy answer cannot trigger one.',
    hint: 'Lost or gained recommendations, being overtaken on share of AI voice, and mention-rate drops.',
  })}`;
  return layout({ title: 'Alerts', active: '/alerts', ctx, body });
}
