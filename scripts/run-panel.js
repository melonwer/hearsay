/**
 * CLI: node scripts/run-panel.js [--estimate] [--once --prompt "..."]
 *
 * Default: run one full panel through core/runner.js with trigger='manual'.
 * --estimate: print the §4.3 cost quote as JSON and exit — nothing runs, nothing is
 *   written. Same numbers the API's quote_required response uses (SPEC §3.3).
 * --once --prompt "...": live smoke for humans — one prompt through each enabled
 *   provider, no DB writes. Guarded by HEARSAY_LIVE_TEST=1 because it spends money.
 */

import { parseArgs } from 'node:util';
import { config } from '../core/config.js';
import { openDb } from '../core/db.js';
import { runPanel } from '../core/runner.js';
import { costEstimate } from '../web/pages/api.js';
import { getAdapter } from '../core/providers/index.js';
import { apiExecutionBudget } from '../core/execution-budget.js';

const { values } = parseArgs({
  options: {
    estimate: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    prompt: { type: 'string' },
  },
});

if (values.estimate) {
  const db = openDb(config.dbPath);
  process.stdout.write(`${JSON.stringify(costEstimate({ db, config }), null, 2)}\n`);
  process.exit(0);
}

if (values.prompt !== undefined) {
  if (process.env.HEARSAY_LIVE_TEST !== '1') {
    process.stderr.write('--prompt makes real provider calls. Set HEARSAY_LIVE_TEST=1 to confirm.\n');
    process.exit(1);
  }
  for (const provider of config.enabledProviders) {
    const adapter = getAdapter(provider.id);
    if (adapter === null) continue; // registry and enabledProviders share ids; belt-and-braces for tsc
    const budget = apiExecutionBudget(config, provider.id);
    const t0 = Date.now();
    try {
      // Same call shape core/runner.js uses — adapters resolve their own key.
      const result = await adapter.runPrompt(/** @type {string} */ (values.prompt), {
        model: budget.model,
        timeoutMs: budget.timeoutMs,
      });
      process.stdout.write(`${provider.id} ${Date.now() - t0}ms: ${result.text.slice(0, 120).replace(/\n/g, ' ')}\n`);
    } catch (err) {
      process.stdout.write(`${provider.id} ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.exit(0);
}

const db = openDb(config.dbPath);
const summary = await runPanel({ db, config, trigger: 'manual' });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
