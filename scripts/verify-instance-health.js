import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { reviewTrackingPrompt } from '../core/benchmark-draft.js';
import { run } from '../core/db.js';
import { subscriptionExecutionBudget } from '../core/execution-budget.js';
import { stableIdentity } from '../core/measurement-contract.js';
import { saveSubscriptionSchedule, SCHEDULE_CONSENT_VERSION } from '../core/subscription-scheduler.js';
import { startServer } from '../server.js';

const { chromium } = await import('playwright');
const directory = mkdtempSync(join(tmpdir(), 'hearsay-instance-browser-'));
const realDbPath = join(directory, 'hearsay.db');
const browser = await chromium.launch();

try {
  const demoConfig = buildConfig({ HEARSAY_DB_PATH: realDbPath, HEARSAY_DEMO: '1',
    OPENAI_API_KEY: 'unused-fixture-key', HEARSAY_CODEX_ENABLED: '1' });
  const demo = await startServer({ config: demoConfig, port: 0,
    portFile: join(directory, 'demo.port'), log: () => {} });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${demo.port}/setup`);
    await page.getByRole('heading', { name: 'Set up your real brand' }).waitFor();
    await page.getByText('Demo workspace — fictional data in a separate database').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save brand' }).count(), 0);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: '/tmp/hearsay-c16-demo-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/hearsay-c16-demo-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/hearsay-c16-demo-narrow.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.close();
  } finally {
    await demo.close();
  }

  const realConfig = buildConfig({ HEARSAY_DB_PATH: realDbPath, HEARSAY_CODEX_ENABLED: '1' });
  const real = await startServer({ config: realConfig, port: 0,
    portFile: join(directory, 'real.port'), log: () => {} });
  try {
    const base = `http://127.0.0.1:${real.port}`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base);
    await page.getByRole('heading', { name: 'Your brand' }).waitFor();
    await page.locator('form[data-api-form="/api/entities"]').first()
      .locator('[name="name"]').fill('My Real Brand');
    const savedBrand = page.waitForResponse((response) => response.url().endsWith('/api/entities')
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save brand' }).click();
    assert.equal((await savedBrand).status(), 201);
    assert.equal(Number(real.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE name = 'My Real Brand'").get()?.n), 1);
    run(real.db, "INSERT INTO intents(label, created_at) VALUES('Buying question', '2026-09-25T00:00:00Z')");
    run(real.db, "INSERT INTO prompts(intent_id, text, tracking_state, created_at) VALUES(1, 'Which tool?', 'tracking', '2026-09-25T00:00:00Z')");
    reviewTrackingPrompt(real.db, 1);
    run(real.db, `INSERT INTO runs(id,started_at,finished_at,trigger,status)
      VALUES(1,'2026-09-25T12:00:00Z','2026-09-25T12:01:00Z','manual','done')`);
    run(real.db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
      surface,lane,target_status,comparability_status,comparison_key,analysis_revision,
      search_policy,answer_status,web_status,query_metadata_status)
      VALUES(1,1,1,'codex','fixture',0,'My Real Brand is an option','2026-09-25T12:00:00Z',
      'codex-agent','tracking','completed','comparable','c16-browser','legacy-heuristic-v1',
      'required','complete','verified','available')`);
    run(real.db, `INSERT INTO mentions(response_id,entity_id,first_index,rank,recommended,snippet)
      VALUES(1,1,0,1,1,'My Real Brand is an option')`);
    saveSubscriptionSchedule(real.db, { runAt: '23:59', timeZone: 'UTC',
      surfaces: ['codex-agent'], targetCeiling: 1, consentVersion: SCHEDULE_CONSENT_VERSION,
      executionBudgetHash: stableIdentity([subscriptionExecutionBudget(realConfig, 'codex-agent')]) });
    await page.goto(base);
    const status = await page.request.get(`${base}/api/status`).then((response) => response.json());
    assert.equal(status.trackingHealth.subscription.ready, true);
    assert.equal(status.trackingHealth.subscription.lastSuccessfulObservationAt, '2026-09-25T12:00:00Z');
    await page.getByRole('heading', { name: 'Tracking health' }).waitFor();
    await page.getByText('2026-09-25T12:00:00Z').first().waitFor();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: '/tmp/hearsay-c16-real-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/hearsay-c16-real-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/hearsay-c16-real-narrow.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.goto(`${base}/settings`);
    await page.getByText('Last successful observation').first().waitFor();
    await page.screenshot({ path: '/tmp/hearsay-c16-settings-narrow.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.close();
  } finally {
    await real.close();
  }
  process.stdout.write('Demo-to-real setup and tracking health browser flow passed at wide and narrow sizes.\n');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
