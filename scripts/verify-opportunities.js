import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { run } from '../core/db.js';
import { createQueryTheme, setQueryThemeAssignment } from '../core/evidence-report.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { startServer } from '../server.js';

const { chromium } = await import('playwright');
const directory = mkdtempSync(join(tmpdir(), 'hearsay-opportunities-browser-'));
const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'hearsay.db'), HEARSAY_DEMO: '0' });
const app = await startServer({ host: '127.0.0.1', port: 0, dbPath: config.dbPath, config });
const browser = await chromium.launch();
const start = '2026-09-01T00:00:00Z';
const end = '2026-09-10T00:00:00Z';

try {
  const db = app.db;
  run(db, `INSERT INTO entities(id,name,aliases,domains,is_self,created_at)
    VALUES(1,'Acme','[]','[]',1,?)`, [start]);
  run(db, `INSERT INTO intents(id,label,created_at) VALUES(1,'Choosing meeting software',?)`, [start]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Which meeting tool fits my team?','general',1,?)`, [start]);
  for (const id of [1, 2, 3]) {
    const at = id === 3 ? '2026-09-17T10:00:00Z' : `2026-09-0${id + 1}T10:00:00Z`;
    run(db, `INSERT INTO runs(id,started_at,trigger,status) VALUES(?,?,'manual','done')`, [id, at]);
    run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
      surface,lane,target_status,comparability_status,comparison_key,analysis_revision,
      search_policy,answer_status,web_status,query_metadata_status,prompt_text_snapshot)
      VALUES(?,?,1,'codex','fixture',0,'A meeting software comparison.',?,'codex-agent',
      'tracking','completed','comparable','opportunity-browser','stance-en-v1','required',
      'complete','verified','available','Which meeting tool fits my team?')`, [id, id, at]);
    run(db, `INSERT INTO search_queries(id,response_id,original_text,normalized_key,ordinal)
      VALUES(?,?,'meeting tool privacy','meeting tool privacy',0)`, [id, id]);
    run(db, `INSERT INTO source_observations(id,response_id,url,normalized_url,excerpt,provenance)
      VALUES(?,?,'https://example.org/guide','https://example.org/guide','Guide excerpt','search_result')`, [id, id]);
  }
  const theme = createQueryTheme(db, { label: 'Privacy', now: start });
  setQueryThemeAssignment(db, { themeId: theme.id, normalizedKey: 'meeting tool privacy', assigned: true });
  const series = listMeasurementSeries(db, { start, end })[0];
  assert.ok(series);
  const selection = new URLSearchParams({ series_id: series.id, intent_id: '1', start, end });
  const base = `http://127.0.0.1:${app.port}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/evidence?${selection}&layer=sources`);
  await page.getByRole('link', { name: 'Use as opportunity evidence' }).first().click();
  assert.equal(await page.locator('[name="response_ids"]').inputValue(), '2,1');
  await page.locator('[name="target_url"]').first().fill('https://acme.example/guide');
  await page.locator('[name="hypothesis"]').first().fill('Buyers may need a clearer privacy explanation.');
  const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/opportunities')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save investigation' }).click();
  assert.equal((await createResponse).status(), 201);
  await page.locator('.opportunity-card').first().waitFor();
  const card = page.locator('.opportunity-card').first();
  await card.getByText('Review and prioritize').click();
  await card.locator('[name="status"]').selectOption('planned');
  await card.locator('[name="action_kind"]').selectOption('page_change');
  await card.locator('[name="owner"]').fill('Product team');
  await card.locator('[name="review_date"]').fill('2026-10-01');
  const rejected = page.waitForResponse((response) => response.url().includes('/api/opportunities/')
    && response.request().method() === 'PATCH');
  await card.getByRole('button', { name: 'Save review' }).click();
  assert.equal((await rejected).status(), 400);
  await card.getByText('Page evidence (0)').click();
  await card.locator('[name="url"]').fill('https://acme.example/guide');
  await card.locator('[name="observed_at"]').fill('2026-09-04T10:00:00Z');
  await card.locator('[name="excerpt"]').fill('The page says how meeting data is handled.');
  const attached = page.waitForResponse((response) => response.url().includes('/page-evidence')
    && response.request().method() === 'POST');
  await card.getByRole('button', { name: 'Attach page evidence' }).click();
  assert.equal((await attached).status(), 201);
  await page.locator('.opportunity-card').first().getByText('Page evidence (1)').click();
  const reviewed = page.waitForResponse((response) => response.url().endsWith('/review')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'I reviewed this excerpt' }).click();
  assert.equal((await reviewed).status(), 200);
  await page.locator('.opportunity-card').first().getByText('Review and prioritize').click();
  await page.locator('.opportunity-card').first().locator('[name="status"]').selectOption('planned');
  await page.locator('.opportunity-card').first().locator('[name="action_kind"]').selectOption('page_change');
  await page.locator('.opportunity-card').first().locator('[name="owner"]').fill('Product team');
  await page.locator('.opportunity-card').first().locator('[name="review_date"]').fill('2026-10-01');
  await page.locator('.opportunity-card').first().locator('[name="suggested_action"]')
    .fill('Explain how the product handles meeting data on this guide.');
  const accepted = page.waitForResponse((response) => response.url().includes('/api/opportunities/')
    && response.request().method() === 'PATCH');
  await page.locator('.opportunity-card').first().getByRole('button', { name: 'Save review' }).click();
  assert.equal((await accepted).status(), 200);
  await page.getByText('planned', { exact: true }).first().waitFor();
  await page.locator('.opportunity-card').first().getByText('Follow-up plans (0)').click();
  const planCard = page.locator('.opportunity-card').first();
  await planCard.locator('[name="review_start"]').fill('2026-09-15T00:00:00Z');
  await planCard.locator('[name="review_end"]').fill('2026-09-20T00:00:00Z');
  await planCard.locator('[name="observation_delay_days"]').fill('2');
  const planned = page.waitForResponse((response) => response.url().endsWith('/follow-up')
    && response.request().method() === 'POST');
  await planCard.getByRole('button', { name: 'Save follow-up plan' }).click();
  const savedPlan = await planned;
  assert.equal(savedPlan.status(), 201);
  const plannedRecord = await page.request.get(`${base}/api/opportunities/1`);
  assert.deepEqual((await plannedRecord.json()).followUpPlans[0].baseline.answers
    .map((/** @type {{responseId:number}} */ answer) => answer.responseId)
    .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b), [1, 2]);
  await page.locator('.opportunity-card').first().getByText('Review and prioritize').click();
  await page.locator('.opportunity-card').first().locator('[name="status"]').selectOption('shipped');
  await page.locator('.opportunity-card').first().locator('[name="change_description"]')
    .fill('Published a clearer explanation of meeting data handling.');
  await page.locator('.opportunity-card').first().locator('[name="shipped_at"]')
    .fill('2026-09-11T12:00:00Z');
  await page.locator('.opportunity-card').first().locator('[name="estimated_effort_hours"]').fill('4');
  await page.locator('.opportunity-card').first().locator('[name="actual_effort_hours"]').fill('3.5');
  const shipped = page.waitForResponse((response) => response.url().includes('/api/opportunities/')
    && response.request().method() === 'PATCH');
  await page.locator('.opportunity-card').first().getByRole('button', { name: 'Save review' }).click();
  assert.equal((await shipped).status(), 200);
  await page.locator('.opportunity-card').first().getByText('Follow-up plans (1)').click();
  const captured = page.waitForResponse((response) => response.url().endsWith('/capture')
    && response.request().method() === 'POST');
  await page.locator('.opportunity-card').first()
    .getByRole('button', { name: 'Capture stored review observations' }).click();
  const savedSnapshot = await captured;
  assert.equal(savedSnapshot.status(), 201);
  const capturedRecord = await page.request.get(`${base}/api/opportunities/1`);
  assert.deepEqual((await capturedRecord.json()).followUpPlans[0].reviewSnapshots[0].answers
    .map((/** @type {{responseId:number}} */ answer) => answer.responseId), [3]);
  await page.locator('.opportunity-card').first().getByText('Follow-up plans (1)').click();
  await page.locator('.opportunity-card').first().getByText('Saved review snapshots (1)').waitFor();
  await page.locator('.opportunity-card').first().getByText('Review and prioritize').click();
  await page.locator('.opportunity-card').first().locator('[name="status"]').selectOption('reviewed');
  const completed = page.waitForResponse((response) => response.url().includes('/api/opportunities/')
    && response.request().method() === 'PATCH');
  await page.locator('.opportunity-card').first().getByRole('button', { name: 'Save review' }).click();
  assert.equal((await completed).status(), 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, 3);
  await page.locator('.opportunity-card').first().getByText('Follow-up plans (1)').click();
  await page.locator('.opportunity-card').first().getByText('Saved review snapshots (1)').click();
  if (process.env.HEARSAY_CAPTURE_OPPORTUNITIES === '1') {
    await page.screenshot({ path: '/tmp/hearsay-c13-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/hearsay-c13-dark.png', fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('.opportunity-card').first().getByText('Follow-up plans (1)').click();
  await page.locator('.opportunity-card').first().getByText('Saved review snapshots (1)').click();
  if (process.env.HEARSAY_CAPTURE_OPPORTUNITIES === '1') {
    await page.screenshot({ path: '/tmp/hearsay-c13-narrow.png', fullPage: true });
  }
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    elements: [...document.querySelectorAll('body *')]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
      .slice(0, 8).map((element) => `${element.tagName}.${element.className}`),
  }));
  assert.equal(overflow.width > overflow.viewport, false, JSON.stringify(overflow));
  process.stdout.write('Evidence link, review gate, follow-up plan, shipped action, saved snapshot, reviewed state, and narrow layout passed.\n');
} finally {
  await browser.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
