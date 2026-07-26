/**
 * GET /prompts — prompt CRUD grouped by intent (§11.5).
 *
 * Phase 0 renders the shell; Lane C adds the inline add-form, category select,
 * active toggle and per-prompt 30d mention-rate mini-meter.
 */

import { emptyState, html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @returns {string}
 */
export function render(ctx) {
  const body = html`${emptyState({
    title: 'No prompts yet',
    line: 'Prompts are the questions Hearsay asks each AI, grouped into intents.',
    hint: 'Three paraphrases per intent gives you a phrasing-robust number instead of one lucky wording.',
    action: { href: '/setup', label: 'Suggest prompts' },
  })}`;
  return layout({ title: 'Prompts', active: '/prompts', ctx, body });
}
