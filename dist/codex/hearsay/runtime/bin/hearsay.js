#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { discoverAgents, previewResearchRun, runResearchPanel, renderSavedReport, compareSavedRuns, readJson } from '../core/research-workspace.js';
import { previewResearchSchedule, enableResearchSchedule, disableResearchSchedule, readResearchSchedule, researchScheduleTick } from '../core/research-schedule.js';
import { ResearchError } from '../core/research-contract.js';
import { studyCommand, STUDY_HELP } from '../core/study-cli.js';
import { inspectSetup, saveSetup } from '../core/plugin-setup.js';
import { checkSite, renderSiteCheckHtml, renderSiteCheckText, SiteCheckError } from '../core/site-check.js';

const HELP = `Hearsay: standalone research helpers and optional account measurements

hearsay check <url> [--json] [--html FILE] [--timeout MS] [--browser]
                                                 Zero-key technical AI crawlability & payload pre-flight audit
hearsay serve [--port PORT] [--host HOST]        Start the local Hearsay dashboard HTTP server
hearsay doctor [--project DIR] [--host HOST] [--host-capabilities FILE] [--check-tavily]
hearsay setup [inspect] [--project DIR]           Read-only local inspection, JSON
hearsay setup save --project DIR --input FILE    Save non-secret inferred profile
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
` + STUDY_HELP;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, project: { type: 'string' }, execute: { type: 'boolean' }, confirm: { type: 'string' },
    run: { type: 'string' }, baseline: { type: 'string' }, database: { type: 'string' }, at: { type: 'string' }, timezone: { type: 'string' }, ceiling: { type: 'string' }, 'install-cron': { type: 'boolean' },
    study: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, author: { type: 'string' }, url: { type: 'string' }, source: { type: 'string' }, change: { type: 'string' }, reason: { type: 'string' }, 'account-directory': { type: 'string' },
    host: { type: 'string' }, 'host-capabilities': { type: 'string' },
    'check-tavily': { type: 'boolean' },
    html: { type: 'string' }, timeout: { type: 'string' }, browser: { type: 'boolean' }, 'allow-private-hosts': { type: 'boolean' }, port: { type: 'string' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  const [command, action] = positionals;
  let result;
  if (command === 'check') {
    const targetUrl = action ?? values.url;
    if (!targetUrl) throw new ResearchError('invalid_arguments', 'check requires a URL: hearsay check <url>');
    /** @type {number|undefined} */
    let timeoutMs;
    if (values.timeout !== undefined) {
      timeoutMs = Number(values.timeout);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new ResearchError('invalid_arguments', '--timeout must be a positive number of milliseconds');
      }
    }
    const report = await checkSite(targetUrl, {
      timeoutMs,
      browser: Boolean(values.browser),
      allowPrivateHosts: Boolean(values['allow-private-hosts']),
    });
    if (values.html) {
      const htmlPath = resolve(values.html);
      mkdirSync(dirname(htmlPath), { recursive: true });
      writeFileSync(htmlPath, renderSiteCheckHtml(report), 'utf8');
    }
    if (values.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(renderSiteCheckText(report) + '\n');
      if (values.html) process.stdout.write(`\nHTML report written to ${resolve(values.html)}\n`);
    }
    return;
  } else if (command === 'serve') {
    if (action) throw new ResearchError('invalid_arguments', 'serve takes no positional action');
    /** @type {number|undefined} */
    let port;
    if (values.port !== undefined) {
      port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new ResearchError('invalid_arguments', '--port must be an integer between 0 and 65535');
      }
    }
    const { startServer, VERSION, startupGuidance } = await import('../server.js');
    const app = await startServer({
      ...(port !== undefined ? { port } : {}),
      ...(values.host ? { host: values.host } : {}),
    });
    process.stdout.write(`Hearsay v${VERSION} listening on http://${app.config.host}:${app.port}\n`);
    const guidance = startupGuidance(app.config);
    if (guidance) process.stdout.write(`${guidance}\n`);
    const shutdown = () => { void app.close().finally(() => process.exit(0)); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  } else if (command === 'doctor' || (command === 'setup' && (!action || action === 'inspect'))) {
    if (command === 'doctor' && action) throw new ResearchError('invalid_arguments', 'Doctor takes no action');
    result = await inspectSetup({ project: values.project, host: values.host, checkTavily: values['check-tavily'], hostCapabilities: values['host-capabilities'] ? readJson(values['host-capabilities']) : undefined });
  } else if (command === 'setup') {
    if (action !== 'save' || !values.project || !values.input) throw new ResearchError('invalid_arguments', 'Setup save requires --project DIR --input FILE');
    result = saveSetup(resolve(values.project), readJson(values.input));
  } else if (command === 'study') result = await studyCommand(action, values);
  else if (command === 'agents' && action === 'list') result = { agents: await discoverAgents() };
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
  const status = error instanceof SiteCheckError
    ? (code === 'invalid_url' || code === 'ssrf_blocked' || code === 'invalid_arguments' ? 2 : 5)
    : /consent|selection|review_required/.test(code) ? 3 : /auth|unsupported_profile/.test(code) ? 4 : /locked|conflict/.test(code) ? 6 : code === 'scheduler_unavailable' ? 7 : error instanceof ResearchError || code.startsWith('ERR_PARSE_ARGS') ? 2 : 5;
  const safeMessage = error instanceof ResearchError || error instanceof SiteCheckError
    ? error.message
    : 'Command failed; check paths, saved configuration and executable readiness';
  process.stderr.write(JSON.stringify({ error: { code, message: safeMessage } }) + '\n');
  process.exitCode = status;
});
