#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { discoverAgents, previewResearchRun, runResearchPanel, renderSavedReport, compareSavedRuns, readJson } from '../core/research-workspace.js';
import { previewResearchSchedule, enableResearchSchedule, disableResearchSchedule, readResearchSchedule, researchScheduleTick } from '../core/research-schedule.js';
import { ResearchError } from '../core/research-contract.js';

const HELP = `Hearsay: standalone research helpers and optional account measurements

hearsay agents list [--json]                       Discovery only, no inference
hearsay run --project DIR [--json]                 Preview saved selected panel
hearsay run --project DIR --execute --confirm HASH Confirm exact preview and execute
hearsay run --project DIR --execute               Repeat with matching saved consent
hearsay report --project DIR --run ID [--json]     Render saved evidence only
hearsay compare --project DIR --baseline ID --run ID [--json]
hearsay schedule preview --project DIR --at HH:MM --timezone ZONE --ceiling N
hearsay schedule enable --project DIR --at HH:MM --timezone ZONE --ceiling N --confirm HASH [--install-cron]
hearsay schedule inspect|disable|tick --project DIR [--json]
hearsay import EVIDENCE_JSON --database ABSOLUTE_PATH [--json]

Project DIR contains project.json, normally .hearsay/<app-id>.
Scheduling needs reviewed panel, saved routes and prior on-demand consent.
Use the host's native scheduler when available. --install-cron explicitly installs
the reviewed fallback on Linux/macOS. No new providers are added automatically.
Exit codes: 0 success; 2 invalid input; 3 consent/selection; 4 auth/profile;
5 execution or partial failure; 6 lock/conflict; 7 unavailable scheduler.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, project: { type: 'string' }, execute: { type: 'boolean' }, confirm: { type: 'string' },
    run: { type: 'string' }, baseline: { type: 'string' }, database: { type: 'string' }, at: { type: 'string' }, timezone: { type: 'string' }, ceiling: { type: 'string' }, 'install-cron': { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  const [command, action] = positionals;
  let result;
  if (command === 'agents' && action === 'list') result = { agents: await discoverAgents() };
  else if (command === 'import') {
    if (!action || !values.database || resolve(values.database) !== values.database) throw new ResearchError('invalid_arguments', 'Import requires an evidence file and explicit absolute --database path');
    const { openDb } = await import('../core/db.js');
    const { importResearch } = await import('../core/research-store.js');
    const { validateEvidence } = await import('../core/research-contract.js');
    const bundle = validateEvidence(readJson(action));
    const db = openDb(values.database);
    try { result = importResearch(db, bundle); } finally { db.close(); }
  } else {
    if (!values.project) throw new ResearchError('invalid_arguments', '--project is required');
    const project = resolve(values.project);
    if (command === 'run') {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try { result = await runResearchPanel(project, { execute: values.execute, confirm: values.confirm, signal: controller.signal }); }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
      if ('evidence' in result && result.evidence.samples.some((/** @type {any} */ sample) => sample.status !== 'completed')) process.exitCode = 5;
    } else if (command === 'report' && values.run) result = { runId: values.run, report: renderSavedReport(project, values.run) };
    else if (command === 'compare' && values.run && values.baseline) result = compareSavedRuns(project, values.baseline, values.run);
    else if (command === 'schedule') {
      if (action === 'inspect') result = readResearchSchedule(project) ?? { enabled: false };
      else if (action === 'disable') result = disableResearchSchedule(project);
      else if (action === 'tick') result = await researchScheduleTick(project);
      else if (action === 'preview' || action === 'enable') {
        if (!values.at || !values.timezone || !values.ceiling) throw new ResearchError('invalid_arguments', '--at, --timezone and --ceiling are required');
        const preview = await previewResearchSchedule(project, { at: values.at, timezone: values.timezone, targetCeiling: Number(values.ceiling) });
        result = action === 'preview' ? preview : enableResearchSchedule(project, preview, values.confirm ?? '', { installCron: values['install-cron'] });
      } else throw new ResearchError('invalid_arguments', 'Unknown schedule command');
    } else throw new ResearchError('invalid_arguments', 'Unknown command or missing options; use --help');
  }
  process.stdout.write(!values.json && result && 'report' in result ? String(result.report) : JSON.stringify(result, null, 2) + '\n');
}
main().catch((error) => {
  const code = error.code ?? 'execution_failed';
  const status = /consent|selection|review_required/.test(code) ? 3 : /auth|unsupported_profile/.test(code) ? 4 : /locked|conflict/.test(code) ? 6 : code === 'scheduler_unavailable' ? 7 : error instanceof ResearchError || code.startsWith('ERR_PARSE_ARGS') ? 2 : 5;
  process.stderr.write(JSON.stringify({ error: { code, message: error instanceof ResearchError ? error.message : 'Command failed; check paths, saved configuration and executable readiness' } }) + '\n');
  process.exitCode = status;
});
