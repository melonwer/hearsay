/**
 * GET /answers — the receipts explorer (§11.4).
 *
 * Phase 0 renders the shell; Lane C adds the filter bar, server-side pagination,
 * per-entity `<mark>` highlighting and citation chips.
 */

import { emptyState, html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @returns {string}
 */
export function render(ctx) {
  const body = html`${emptyState({
    title: 'No answers stored yet',
    line: 'Raw provider answers show up here as soon as a panel run completes.',
    hint: 'Every number in Hearsay links back to the answers it came from.',
    action: { href: '/prompts', label: 'Add prompts' },
  })}`;
  return layout({ title: 'Answers', active: '/answers', ctx, body });
}
