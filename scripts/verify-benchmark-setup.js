/**
 * Drive the fresh, subscription-only setup journey in a real browser. Playwright is optional
 * development tooling; install it locally before running this script.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { startServer } from '../server.js';

const specifier = 'playwright';
const { chromium } = await import(specifier);
const directory = mkdtempSync(join(tmpdir(), 'hearsay-benchmark-browser-'));
const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'hearsay.db'), HEARSAY_DEMO: '0',
  HEARSAY_CODEX_ENABLED: '1',
  HEARSAY_CODEX_PATH: join(process.cwd(), 'test-support', 'fake-codex-search-cli.mjs') });
const app = await startServer({ host: '127.0.0.1', port: 0, dbPath: config.dbPath, config });
const browser = await chromium.launch();

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  await page.goto(`${base}/setup?step=1`);
  await page.locator('form[data-api-form="/api/entities"]').first().locator('[name="name"]').fill('Acme');
  const saveBrand = page.waitForResponse((/** @type {any} */ response) =>
    response.url().endsWith('/api/entities') && response.request().method() === 'POST');
  const brandReload = page.waitForNavigation();
  await page.getByRole('button', { name: 'Save brand' }).click();
  assert.equal((await saveBrand).status(), 201);
  await brandReload;
  await page.goto(`${base}/setup?step=2`);
  await page.locator('[name="audience"]').fill('Small sales teams');
  await page.locator('[name="productJob"]').fill('record and summarize sales calls');
  await page.locator('[name="desiredConversion"]').fill('start a trial');
  await page.getByRole('button', { name: 'Draft five intents' }).click();
  await page.locator('[data-suggest-intent]').first().waitFor();
  assert.equal(await page.locator('[data-suggest-intent]').count(), 5);
  assert.equal(await page.locator('[data-suggest-phrasing]').count(), 15);
  if (process.env.HEARSAY_CAPTURE_SETUP === '1') {
    await page.screenshot({ path: '/tmp/hearsay-c11-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/hearsay-c11-dark.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  }
  for (let i = 0; i < 4; i += 1) {
    await page.getByRole('button', { name: 'Remove intent' }).last().click();
  }
  await page.getByRole('button', { name: 'Save and review questions' }).click();
  await page.getByText('3 selected question(s)', { exact: false }).waitFor();
  assert.match(await page.locator('#suggest-review-details').innerText(), /3 total/);
  assert.equal(await page.locator('#suggest-approve').isEnabled(), true);
  await page.getByRole('button', { name: 'Approve these questions for tracking' }).click();
  await page.getByText('Questions approved for tracking', { exact: false }).waitFor();
  const status = await (await page.request.get(`${base}/api/status`)).json();
  assert.equal(status.configured, true);
  assert.equal(status.reviewNeeded, false);
  await page.goto(`${base}/setup?step=3`);
  assert.match(await page.locator('body').innerText(), /First-run target count: 3 total/);
  const previewResponse = await page.request.post(`${base}/api/subscription/preview`, {
    data: { surfaces: ['codex-agent'], samples: 1 },
  });
  assert.equal(previewResponse.status(), 200);
  const preview = await previewResponse.json();
  assert.equal(preview.totalTargets, 3);
  const startResponse = await page.request.post(`${base}/api/subscription/run`, {
    data: { surfaces: ['codex-agent'], samples: 1, confirm: true, quote_id: preview.quoteId },
  });
  assert.equal(startResponse.status(), 202);
  let latest;
  for (let i = 0; i < 100; i += 1) {
    latest = await (await page.request.get(`${base}/api/runs/latest`)).json();
    if (latest.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(latest.status, 'done');
  const list = await (await page.request.get(`${base}/api/series?days=30`)).json();
  const selected = list.series.find((/** @type {any} */ item) => item.surface === 'codex-agent');
  assert.ok(selected);
  assert.equal(selected.comparableAnswers, 3);
  await page.goto(`${base}/?series_id=${selected.id}`);
  await page.locator('section[aria-label="Measurement series"]').waitFor();
  assert.match(await page.locator('body').innerText(), /Codex agent/);
  const intentId = Number(app.db.prepare('SELECT id FROM intents ORDER BY id LIMIT 1').get()?.id);
  await page.goto(`${base}/evidence?series_id=${selected.id}&intent_id=${intentId}&layer=sources`);
  await page.getByRole('link', { name: 'Use as opportunity evidence' }).first().click();
  await page.locator('[name="hypothesis"]').first()
    .fill('A clearer buyer guide may address the recorded comparison question.');
  const opportunitySaved = page.waitForResponse((/** @type {any} */ response) =>
    response.url().endsWith('/api/opportunities') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save investigation' }).click();
  assert.equal((await opportunitySaved).status(), 201);
  await page.locator('.opportunity-card').first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/setup?step=2`);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(horizontalOverflow, false, 'narrow setup should not scroll horizontally');
  if (process.env.HEARSAY_CAPTURE_SETUP === '1') {
    await page.screenshot({ path: '/tmp/hearsay-c11-narrow.png', fullPage: true });
  }
  process.stdout.write('Fresh subscription-only setup, consented fake CLI run, exact dashboard, evidence and opportunity passed.\n');
  await context.close();
} finally {
  await browser.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
