/**
 * GET /entities — brand and competitor CRUD (§11.5).
 *
 * Phase 0 renders the shell; Lane C adds the alias chip input, domain list,
 * is_self radio (exactly one) and the fixed series-colour preview.
 */

import { emptyState, html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @returns {string}
 */
export function render(ctx) {
  const body = html`${emptyState({
    title: 'No entities yet',
    line: 'Hearsay counts mentions of the brands you name here — yours and your competitors.',
    hint: 'Exactly one entity is marked as your brand; it always keeps the same chart colour.',
    action: { href: '/setup', label: 'Add your brand' },
  })}`;
  return layout({ title: 'Entities', active: '/entities', ctx, body });
}
