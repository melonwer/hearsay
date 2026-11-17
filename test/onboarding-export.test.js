import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { escapeHtml, buildClientReport, renderClientReportHtml } from '../core/client-export.js';
import { get, isoNow, openDb, run } from '../core/db.js';
import { parseEnvFile, updateEnvFile } from '../core/env-file.js';
import { storeInterpretation } from '../core/interpretations.js';
import { recordOutcome } from '../core/outcomes.js';
import { saveSubscriptionSchedule, SCHEDULE_CONSENT_VERSION } from '../core/subscription-scheduler.js';
import { subscriptionExecutionBudget } from '../core/execution-budget.js';
import { stableIdentity } from '../core/measurement-contract.js';
import { startServer } from '../server.js';

/**
 * Boot a throwaway server with isolated DB and `.env` paths.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|undefined>} [env]
 */
async function bootIsolated(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-onboarding-'));
  const envFile = join(dir, '.env');
  const realDbPath = join(dir, 'data/hearsay.db');
  const demoDbPath = join(dir, 'data/demo/hearsay.db');
  mkdirSync(join(dir, 'data'), { recursive: true });

  const mergedEnv = {
    HEARSAY_DB_PATH: realDbPath,
    HEARSAY_DEMO_DB_PATH: demoDbPath,
    ...env,
  };
  const config = buildConfig(mergedEnv);
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    dbPath: config.dbPath,
    portFile: join(dir, 'hearsay.port'),
    envFile,
    env: mergedEnv,
    config,
    log: () => {},
  });

  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    app,
    dir,
    envFile,
    realDbPath,
    demoDbPath,
    base: `http://127.0.0.1:${app.port}`,
  };
}

test('updateEnvFile writes atomically with 0600 permissions, preserves comments, and rejects injection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-envfile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = join(dir, '.env');
  writeFileSync(file, '# Local Hearsay settings\nCUSTOM_KEEP=alpha\nOPENAI_API_KEY=old-key\n', {
    mode: 0o644,
  });
  chmodSync(file, 0o644);

  const parsed = updateEnvFile(file, {
    OPENAI_API_KEY: 'sk-live-secret-999999',
    TAVILY_API_KEY: 'tvly-live-secret-888888',
    HEARSAY_CODEX_ENABLED: '1',
  });

  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, '.env permissions must be tightened to 0600');
  const rawText = readFileSync(file, 'utf8');
  assert.match(rawText, /^# Local Hearsay settings/m);
  assert.equal(parsed.CUSTOM_KEEP, 'alpha');
  assert.equal(parsed.OPENAI_API_KEY, 'sk-live-secret-999999');
  assert.equal(parsed.TAVILY_API_KEY, 'tvly-live-secret-888888');
  assert.equal(parsed.HEARSAY_CODEX_ENABLED, '1');

  // Clearing a key removes it cleanly while keeping 0600 permissions.
  const afterClear = updateEnvFile(file, { OPENAI_API_KEY: null });
  assert.equal(afterClear.OPENAI_API_KEY, undefined);
  assert.equal(afterClear.TAVILY_API_KEY, 'tvly-live-secret-888888');
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // Values with spaces or # round-trip through parseEnvFile.
  updateEnvFile(file, { TAVILY_API_KEY: 'tvly-with#hash and space' });
  assert.equal(parseEnvFile(readFileSync(file, 'utf8')).TAVILY_API_KEY, 'tvly-with#hash and space');

  // Newline / null-byte injection is rejected.
  assert.throws(() => updateEnvFile(file, { OPENAI_API_KEY: 'sk-bad\nEVIL=1' }), RangeError);
  assert.throws(() => updateEnvFile(file, { 'BAD-KEY': 'val' }), RangeError);
});

test('browser onboarding saves 0600 .env keys & CLI toggles in-process with zero secret leakage', async (t) => {
  const binDir = mkdtempSync(join(tmpdir(), 'hearsay-fakebin-'));
  t.after(() => rmSync(binDir, { recursive: true, force: true }));
  const fakeCodex = join(binDir, 'codex');
  writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(fakeCodex, 0o755);

  const ctx = await bootIsolated(t, {
    PATH: `${binDir}${delimiter}/usr/bin`,
  });

  // Initial /setup renders the 1-click Notewell demo CTA and Browser Provider & Route Connection card.
  const initialSetupHtml = await fetch(`${ctx.base}/setup`).then((r) => r.text());
  assert.match(initialSetupHtml, /Explore Interactive Notewell Demo \(1 Click, \$0\)/);
  assert.match(initialSetupHtml, /Browser Provider &amp; Route Connection/);
  assert.match(initialSetupHtml, /type="password"\s+name="OPENAI_API_KEY"/);
  assert.match(initialSetupHtml, /type="password"\s+name="TAVILY_API_KEY"/);

  const stateBefore = await fetch(`${ctx.base}/api/onboarding/state`).then((r) => r.json());
  assert.equal(stateBefore.demo, false);
  assert.equal(stateBefore.cliRoutes.find((r) => r.key === 'codex')?.detected, true);
  assert.equal(stateBefore.cliRoutes.find((r) => r.key === 'codex')?.enabled, false);

  const secrets = {
    OPENAI_API_KEY: 'sk-proj-super-secret-openai-123456',
    ANTHROPIC_API_KEY: 'sk-ant-super-secret-claude-654321',
    GEMINI_API_KEY: 'AIzaSySuperSecretGeminiKey987654',
    PERPLEXITY_API_KEY: 'pplx-super-secret-perplexity-555555',
    TAVILY_API_KEY: 'tvly-super-secret-tavily-444444',
  };

  const postRes = await fetch(`${ctx.base}/api/onboarding/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({
      keys: secrets,
      cliRoutes: { codex: true, claudeCode: true },
    }),
  });
  assert.equal(postRes.status, 200);
  const postBody = await postRes.json();
  assert.equal(postBody.ok, true);

  // Verify .env on disk has 0600 permissions and exact values.
  assert.ok(existsSync(ctx.envFile));
  assert.equal(statSync(ctx.envFile).mode & 0o777, 0o600);
  const onDisk = parseEnvFile(readFileSync(ctx.envFile, 'utf8'));
  for (const [k, v] of Object.entries(secrets)) {
    assert.equal(onDisk[k], v);
  }
  assert.equal(onDisk.HEARSAY_CODEX_ENABLED, '1');
  assert.equal(onDisk.HEARSAY_CLAUDE_CODE_ENABLED, '1');

  // Verify ALL providers and CLI routes are configured in-process without restarting Node.
  for (const p of postBody.providers) {
    assert.equal(p.configured, true, `${p.id} should be configured`);
    assert.match(p.maskedHint ?? '', /\.\.\.\*\*\*\*$/);
  }
  assert.equal(postBody.cliRoutes.every((r) => r.enabled === true), true);

  // Verify ZERO raw secrets or secret suffixes leak across API and HTML surfaces.
  const stateRaw = await fetch(`${ctx.base}/api/onboarding/state`).then((r) => r.text());
  const statusRaw = await fetch(`${ctx.base}/api/status`).then((r) => r.text());
  const setupHtml = await fetch(`${ctx.base}/setup?step=3`).then((r) => r.text());
  const settingsHtml = await fetch(`${ctx.base}/settings`).then((r) => r.text());
  const postRaw = JSON.stringify(postBody);

  for (const secret of Object.values(secrets)) {
    const suffix = secret.slice(-6);
    for (const [surfaceName, payload] of [
      ['POST /api/onboarding/providers', postRaw],
      ['GET /api/onboarding/state', stateRaw],
      ['GET /api/status', statusRaw],
      ['GET /setup?step=3', setupHtml],
      ['GET /settings', settingsHtml],
    ]) {
      assert.equal(payload.includes(secret), false, `${surfaceName} leaked full secret`);
      assert.equal(payload.includes(suffix), false, `${surfaceName} leaked secret suffix`);
    }
  }

  // Blank password fields leave saved keys untouched; clearKeys removes only the targeted key.
  const partialUpdate = await fetch(`${ctx.base}/api/onboarding/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({
      keys: { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
      clearKeys: ['PERPLEXITY_API_KEY'],
    }),
  }).then((r) => r.json());

  assert.equal(partialUpdate.providers.find((p) => p.id === 'openai')?.configured, true);
  assert.equal(partialUpdate.providers.find((p) => p.id === 'perplexity')?.configured, false);
  assert.equal(
    parseEnvFile(readFileSync(ctx.envFile, 'utf8')).PERPLEXITY_API_KEY,
    undefined,
  );

  // Disallowed env var names are rejected with 422.
  const badField = await fetch(`${ctx.base}/api/onboarding/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ keys: { NODE_OPTIONS: '--inspect' } }),
  });
  await badField.text();
  assert.equal(badField.status, 422);
});

test('onboarding endpoints enforce strict local host, origin, and proxy-header safety', async (t) => {
  const ctx = await bootIsolated(t);

  // Cross-origin GET to /api/onboarding/state is blocked.
  const crossGet = await fetch(`${ctx.base}/api/onboarding/state`, {
    headers: { Origin: 'http://evil.example' },
  });
  await crossGet.text();
  assert.equal(crossGet.status, 403);

  // Cross-site Sec-Fetch-Site is blocked.
  const crossFetchSite = await fetch(`${ctx.base}/api/onboarding/state`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  await crossFetchSite.text();
  assert.equal(crossFetchSite.status, 403);

  // Reverse-proxy X-Forwarded-For is blocked.
  const proxied = await fetch(`${ctx.base}/api/onboarding/providers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.9',
    },
    body: JSON.stringify({ keys: { OPENAI_API_KEY: 'sk-blocked-key-123456' } }),
  });
  await proxied.text();
  assert.equal(proxied.status, 403);
  assert.equal(existsSync(ctx.envFile), false);
});

test('founder URL-to-competitor setup normalizes brand & competitor URLs in one step', async (t) => {
  const ctx = await bootIsolated(t);

  const setupStep1 = await fetch(`${ctx.base}/setup`).then((r) => r.text());
  assert.match(setupStep1, /data-onboarding-urls-form/);
  assert.match(setupStep1, /Save URLs &amp; draft buyer questions →/);

  const res = await fetch(`${ctx.base}/api/onboarding/brand-urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({
      brandUrl: 'https://www.notewell-hq.ai/pricing?utm=launch',
      competitors: 'https://app.gong.io/demo, https://fireflies.ai, Otter (otter.ai), PlainRival',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.redirectTo, '/setup?step=2');
  assert.equal(body.brand.name, 'Notewell Hq');
  assert.deepEqual(body.brand.domains, ['notewell-hq.ai']);
  assert.deepEqual(
    body.competitors.map((c) => ({ name: c.name, domains: c.domains })),
    [
      { name: 'Gong', domains: ['app.gong.io'] },
      { name: 'Fireflies', domains: ['fireflies.ai'] },
      { name: 'Otter', domains: ['otter.ai'] },
      { name: 'PlainRival', domains: [] },
    ],
  );
});

test('1-click Demo <-> Live workspace switcher swaps databases in-process without restart or data loss, and exports seeded client report', async (t) => {
  const ctx = await bootIsolated(t, {
    OPENAI_API_KEY: 'sk-never-leak-into-report-999999',
  });

  // 1. Add a real brand and question in the Live workspace.
  const entityRes = await fetch(`${ctx.base}/api/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Acme Analytics', domains: ['acmeanalytics.io'], is_self: true }),
  });
  await entityRes.text();
  assert.equal(entityRes.status, 201);

  const promptRes = await fetch(`${ctx.base}/api/prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Which B2B analytics platform handles multi-region warehousing best?',
      reviewed: true,
    }),
  });
  await promptRes.text();
  assert.equal(promptRes.status, 201);

  // 2. Switch into Demo workspace in 1 click (no server restart!).
  const toDemo = await fetch(`${ctx.base}/api/onboarding/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ demo: true }),
  });
  assert.equal(toDemo.status, 200);
  const toDemoBody = await toDemo.json();
  assert.equal(toDemoBody.demo, true);
  assert.equal(toDemoBody.redirectTo, '/');
  assert.equal(parseEnvFile(readFileSync(ctx.envFile, 'utf8')).HEARSAY_DEMO, '1');
  assert.equal(statSync(ctx.envFile).mode & 0o777, 0o600);

  // Dashboard now serves seeded Notewell demo universe + Exit Demo banner in layout.js!
  const demoDashboard = await fetch(`${ctx.base}/`).then((r) => r.text());
  assert.match(demoDashboard, /Notewell/);
  assert.match(demoDashboard, /Exit Demo → Set Up My Brand/);
  assert.match(demoDashboard, /Export Client Report/);

  // Export client HTML report from the live-switched Demo workspace over HTTP!
  const seriesList = await fetch(`${ctx.base}/api/series?days=30`).then((r) => r.json());
  const perplexitySeries = seriesList.series.find((s) => s.surface === 'perplexity-api');
  assert.ok(perplexitySeries);

  const downloadRes = await fetch(
    `${ctx.base}/api/export/report?series_id=${perplexitySeries.id}&days=30`,
  );
  assert.equal(downloadRes.status, 200);
  assert.match(downloadRes.headers.get('content-type') ?? '', /text\/html/);
  assert.match(
    downloadRes.headers.get('content-disposition') ?? '',
    /^attachment; filename="hearsay-client-report-notewell-/,
  );
  assert.match(downloadRes.headers.get('content-security-policy') ?? '', /^default-src 'none';/);

  const inlineRes = await fetch(
    `${ctx.base}/api/export/report?series_id=${perplexitySeries.id}&days=30&inline=1`,
  );
  assert.equal(inlineRes.status, 200);
  assert.match(inlineRes.headers.get('content-disposition') ?? '', /^inline; filename=/);
  await inlineRes.text();

  const reportHtml = await downloadRes.text();
  assert.match(reportHtml, /<html lang="en" data-theme="dark">/);
  assert.match(reportHtml, /id="theme-toggle"/);
  assert.match(reportHtml, /@media print/);
  assert.match(reportHtml, /\.ci-track\s*\{\s*display:\s*block;\s*width:\s*100%;/);
  assert.match(reportHtml, /95% Wilson CI/);
  assert.match(reportHtml, /Share of AI Voice/);
  assert.match(reportHtml, /Top Citation-Gap Domains/);
  assert.match(reportHtml, /Verbatim Answer Receipts/);
  assert.match(reportHtml, /data-receipt-filter="omitted"/);
  assert.match(reportHtml, /<details class="receipt-item"/);
  assert.equal(reportHtml.includes('sk-never-leak-into-report-999999'), false);
  assert.equal(reportHtml.includes(ctx.dir), false, 'local filesystem paths must never appear in report');

  const scriptMatch = reportHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'self-contained report should include inline theme/print script');
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]));

  const demoStatus = await fetch(`${ctx.base}/api/status`).then((r) => r.json());
  assert.equal(demoStatus.demo, true);
  assert.equal(demoStatus.counts.entities, 4);

  const demoSetup = await fetch(`${ctx.base}/setup`).then((r) => r.text());
  assert.match(demoSetup, /Set up your real brand/);
  assert.match(demoSetup, /Exit Demo → Set Up My Brand/);

  // 3. Switch back to Live workspace in 1 click — Acme Analytics & its prompt are intact,
  // and the demo database also stays intact on disk!
  const toLive = await fetch(`${ctx.base}/api/onboarding/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ demo: false }),
  });
  assert.equal(toLive.status, 200);
  const toLiveBody = await toLive.json();
  assert.equal(toLiveBody.demo, false);
  assert.equal(toLiveBody.redirectTo, '/');
  assert.equal(parseEnvFile(readFileSync(ctx.envFile, 'utf8')).HEARSAY_DEMO, '0');

  const liveEntities = await fetch(`${ctx.base}/api/entities`).then((r) => r.json());
  assert.equal(liveEntities.length, 1);
  assert.equal(liveEntities[0].name, 'Acme Analytics');
  const livePrompts = await fetch(`${ctx.base}/api/prompts`).then((r) => r.json());
  assert.equal(livePrompts.length, 1);
  assert.ok(existsSync(ctx.realDbPath));
  assert.ok(existsSync(ctx.demoDbPath));

  // Refuses mode switch with 409 if a run is currently running.
  run(
    ctx.app.db,
    "INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?, 'api', 'running', 3, 1)",
    [isoNow()],
  );
  const blockedSwitch = await fetch(`${ctx.base}/api/onboarding/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ demo: true }),
  });
  await blockedSwitch.text();
  assert.equal(blockedSwitch.status, 409);
});

test('schedule health badges explicitly distinguish stopped, connected, configured, collecting, and stale', async (t) => {
  const ctx = await bootIsolated(t);

  const eRes = await fetch(`${ctx.base}/api/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Acme', is_self: true }),
  });
  await eRes.text();

  // 1. Both lanes Stopped initially.
  let state = await fetch(`${ctx.base}/api/onboarding/state`).then((r) => r.json());
  assert.equal(state.scheduleBadges.api.state, 'stopped');
  assert.equal(state.scheduleBadges.api.status, 'Stopped');
  assert.equal(state.scheduleBadges.subscription.state, 'stopped');
  assert.equal(state.scheduleBadges.subscription.status, 'Stopped');

  // 2. Configure Perplexity API key (no API search consent gate) + Codex CLI route -> Connected!
  const pRes = await fetch(`${ctx.base}/api/onboarding/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({
      keys: { PERPLEXITY_API_KEY: 'pplx-schedule-badge-key-123456' },
      cliRoutes: { codex: true },
    }),
  });
  await pRes.text();

  const currentHash = stableIdentity([subscriptionExecutionBudget(ctx.app.config, 'codex-agent')]);
  saveSubscriptionSchedule(ctx.app.db, {
    runAt: '07:00',
    timeZone: 'UTC',
    surfaces: ['codex-agent'],
    targetCeiling: 5,
    consentVersion: SCHEDULE_CONSENT_VERSION,
    executionBudgetHash: currentHash,
  });

  state = await fetch(`${ctx.base}/api/onboarding/state`).then((r) => r.json());
  assert.equal(state.scheduleBadges.api.state, 'connected');
  assert.equal(state.scheduleBadges.api.status, 'Connected (Active in Running Server)');
  assert.equal(state.scheduleBadges.subscription.state, 'connected');
  assert.equal(state.scheduleBadges.subscription.status, 'Connected (Active in Running Server)');

  const activeDashboard = await fetch(`${ctx.base}/`).then((r) => r.text());
  assert.match(activeDashboard, /Connected \(Active in Running Server\)/);

  // 3. Disable Codex CLI route while schedule remains saved in DB -> Subscription lane shows Configured!
  const offRes = await fetch(`${ctx.base}/api/onboarding/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ cliRoutes: { codex: false } }),
  });
  await offRes.text();

  state = await fetch(`${ctx.base}/api/onboarding/state`).then((r) => r.json());
  assert.equal(state.scheduleBadges.subscription.state, 'configured');
  assert.equal(state.scheduleBadges.subscription.status, 'Configured (Consent Suspended / Needs Quote)');

  const settingsHtml = await fetch(`${ctx.base}/settings`).then((r) => r.text());
  assert.match(settingsHtml, /Configured \(Consent Suspended \/ Needs Quote\)/);
  assert.match(settingsHtml, /Connected \(Active in Running Server\)/);

  // 4. Active API run -> Collecting Now!
  const runId = run(
    ctx.app.db,
    "INSERT INTO runs(started_at, trigger, status, total_calls, done_calls, schedule_key) VALUES(?, 'api', 'running', 4, 2, 'api-panel')",
    [isoNow()],
  ).lastInsertRowid;
  state = await fetch(`${ctx.base}/api/onboarding/state`).then((r) => r.json());
  assert.equal(state.scheduleBadges.api.state, 'collecting');
  assert.equal(state.scheduleBadges.api.status, 'Collecting Now');

  // 5. Failed scheduled run -> Stale (Missed or Failed Run)!
  run(ctx.app.db, "UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?", [isoNow(), runId]);
  state = await fetch(`${ctx.base}/api/onboarding/state`).then((r) => r.json());
  assert.equal(state.scheduleBadges.api.state, 'stale');
  assert.equal(state.scheduleBadges.api.status, 'Stale (Missed or Failed Run)');
  const staleSettings = await fetch(`${ctx.base}/settings`).then((r) => r.text());
  assert.match(staleSettings, /Stale \(Missed or Failed Run\)/);
});

test('client HTML report strictly escapes hostile XSS payloads, blocks unsafe URLs, and omits local paths', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());

  assert.equal(
    escapeHtml(`<script>alert("x&'y'")</script>`),
    '&lt;script&gt;alert(&quot;x&amp;&#39;y&#39;&quot;)&lt;/script&gt;',
  );

  const now = '2026-10-15T12:00:00Z';
  run(db, `INSERT INTO entities(id, name, aliases, domains, is_self, created_at)
    VALUES(1, 'Brand <script>alert(1)</script>', '[]', '["brand.example"]', 1, ?)`, [now]);
  run(db, `INSERT INTO entities(id, name, aliases, domains, is_self, created_at)
    VALUES(2, 'Rival "R&D"', '[]', '["rival.example"]', 0, ?)`, [now]);
  run(db, `INSERT INTO intents(id, label, created_at) VALUES(1, 'Best <tool> for ops', ?)`, [now]);
  run(db, `INSERT INTO prompts(id, intent_id, text, category, active, tracking_state, created_at)
    VALUES(1, 1, 'Which <ops> tool should we buy?', 'general', 1, 'tracking', ?)`, [now]);
  run(db, `INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls)
    VALUES(1, '2026-10-14T08:00:00Z', '2026-10-14T08:05:00Z', 'api', 'done', 2, 2)`);

  // Answer 1: mentions Rival only + cites g2-gap.example and hostile javascript: URL -> competitor citation gap!
  run(db, `INSERT INTO responses(
    id, run_id, prompt_id, provider, surface, model, sample_idx, text, created_at,
    lane, target_status, comparability_status, answer_status, web_status,
    execution_profile_id, benchmark_revision_id, analysis_revision, comparison_key, search_policy,
    cli_executable, artifact_ref
  ) VALUES(
    10, 1, 1, 'openai', 'openai-api', 'gpt-5.6-luna', 0,
    'Use Rival "R&D" instead. </script><script>evil()</script>', '2026-10-14T08:01:00Z',
    'tracking', 'completed', 'comparable', 'complete', 'verified',
    NULL, NULL, 'stance-v1', 'cmp-1', 'auto',
    '/Users/secret-local-user/.bin/codex', '/Users/secret-local-user/artifacts/raw.json'
  )`);
  const m10 = run(db, `INSERT INTO mentions(response_id, entity_id, first_index, occurrences, recommended, snippet, rank)
    VALUES(10, 2, 4, 1, 1, 'Use Rival', 1)`).lastInsertRowid;
  storeInterpretation(
    db,
    Number(m10),
    'stance-v1',
    /** @type {*} */ ({
      stance: 'positive',
      rule_id: 'test',
      evidence_start: 0,
      evidence_end: 9,
      review_flags: [],
    }),
    '2026-10-14T08:01:00Z',
  );
  const evId = run(db, `INSERT INTO search_events(response_id, event_type, status, query, observed_at)
    VALUES(10, 'search', 'completed', 'best <ops> tools 2026', '2026-10-14T08:01:00Z')`).lastInsertRowid;
  run(db, `INSERT INTO search_queries(response_id, search_event_id, ordinal, original_text, normalized_key)
    VALUES(10, ?, 0, 'best <ops> tools 2026', 'best ops tools 2026')`, [evId]);
  run(db, `INSERT INTO citations(response_id, url, domain, rank, entity_id)
    VALUES(10, 'https://g2-gap.example/compare?x=1&y=2', 'g2-gap.example', 1, NULL)`);
  run(db, `INSERT INTO citations(response_id, url, domain, rank, entity_id)
    VALUES(10, 'javascript:alert(9)', 'evil.js', 2, NULL)`);

  // Record a business outcome in the same window with HTML-special characters in notes.
  recordOutcome(db, {
    source: 'CRM <Export>',
    recordKey: 'row-1',
    periodStart: '2026-10-10T00:00:00Z',
    periodEnd: '2026-10-15T00:00:00Z',
    landingPage: '/pricing',
    metricName: 'Qualified Demos',
    value: '18',
    unit: 'count',
    attributionMethod: 'First-touch <analytics>',
    notes: 'After shipping <pricing> comparison table',
    author: 'tester',
    now,
  });

  const model = buildClientReport(db, { days: 30, now });
  assert.equal(model.citationGaps.length, 2);
  assert.equal(model.citationGaps[0].domain, 'evil.js');
  assert.deepEqual(model.citationGaps[0].competitors, ['Rival "R&D"']);
  assert.equal(model.outcomes.length, 1);

  const hostileHtml = renderClientReportHtml(model);
  // Zero unescaped script tags from user/model payloads
  assert.equal(hostileHtml.includes('<script>alert(1)</script>'), false);
  assert.equal(hostileHtml.includes('<script>evil()</script>'), false);
  assert.equal(hostileHtml.includes('href="javascript:'), false);
  // Zero local filesystem paths from responses table
  assert.equal(hostileHtml.includes('/Users/secret-local-user'), false);
  // Escaped content is present and readable
  assert.ok(hostileHtml.includes('Brand &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(hostileHtml.includes('best &lt;ops&gt; tools 2026'));
  assert.ok(hostileHtml.includes('g2-gap.example'));
  assert.ok(hostileHtml.includes('Qualified Demos'));
  assert.ok(hostileHtml.includes('After shipping &lt;pricing&gt; comparison table'));
});
