/**
 * GET / — dashboard (§11.3).
 *
 * Phase 0 renders the shell and honest empty states. Lane C fills in the KPI row,
 * SOV trend, provider row, competitor leaderboard, alerts panel, citation gap and
 * latest receipts — every rate carrying its n (§19.6 #4).
 */

import { emptyState, html, layout } from '../layout.js';

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @returns {string}
 */
export function render(ctx) {
  const body = html`${emptyState({
    title: 'No measurements yet',
    line: 'Nothing has been measured on this instance, so there is nothing to chart.',
    hint: ctx.demo
      ? 'Demo mode is on — run node scripts/seed.js to load the demo universe.'
      : 'Add your brand and a few prompts, then run a panel. Numbers appear with their sample sizes.',
    action: { href: '/setup', label: 'Start setup' },
  })}`;
  return layout({ title: 'Dashboard', active: '/', ctx, body });
}
