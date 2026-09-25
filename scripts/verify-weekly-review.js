import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { run } from '../core/db.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { startServer } from '../server.js';

const { chromium } = await import('playwright');
const directory = mkdtempSync(join(tmpdir(), 'hearsay-weekly-browser-'));
const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'hearsay.db'), HEARSAY_DEMO: '0' });
const app = await startServer({ host: '127.0.0.1', port: 0, dbPath: config.dbPath, config });
const browser = await chromium.launch();
const start = '2026-09-01T00:00:00Z';
const end = '2026-09-08T00:00:00Z';

try {
  const db = app.db;
  run(db, "INSERT INTO entities(id,name,aliases,domains,is_self,created_at) VALUES(1,'Acme','[]','[]',1,?)", [start]);
  run(db, "INSERT INTO intents(id,label,created_at) VALUES(1,'Choose software',?)", [start]);
  run(db, "INSERT INTO prompts(id,intent_id,text,category,active,created_at) VALUES(1,1,'Which tool?','general',1,?)", [start]);
  run(db, "INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')", [start]);
  run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
    surface,lane,target_status,comparability_status,comparison_key,analysis_revision,
    search_policy,answer_status,web_status,query_metadata_status)
    VALUES(1,1,1,'codex','fixture',0,'Acme is an option',?,'codex-agent',
    'tracking','completed','comparable','weekly-browser','legacy-heuristic-v1',
    'required','complete','verified','available')`, ['2026-09-03T00:00:00Z']);
  const series = listMeasurementSeries(db, { start, end })[0];
  assert.ok(series);
  const base = `http://127.0.0.1:${app.port}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/weekly-review`);
  await page.getByRole('heading', { name: 'Choose a measurement series' }).waitFor();
  assert.equal(await page.getByText('Selected scope').count(), 0);
  await page.locator('select[name="series_id"]').selectOption(series.id);
  await page.locator('input[name="start"]').first().fill(start);
  await page.locator('input[name="end"]').first().fill(end);
  await page.getByRole('button', { name: 'Show this week' }).click();
  await page.getByRole('heading', { name: 'Selected scope' }).waitFor();
  await page.getByRole('heading', { name: 'Nothing requires action' }).waitFor();
  await page.getByText('Business outcomes not recorded.').waitFor();
  const form = page.locator('form[data-api-form="/api/outcomes"]');
  await form.locator('[name="source"]').fill('Analytics');
  await form.locator('[name="record_key"]').fill('weekly-leads-1');
  await form.locator('[name="metric_name"]').fill('Qualified leads');
  await form.locator('[name="value"]').fill('2');
  await form.locator('[name="unit"]').fill('count');
  await form.locator('[name="attribution_method"]').fill('Unattributed');
  await form.locator('[name="author"]').fill('Reviewer');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/outcomes')
    && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Save outcome' }).click();
  assert.equal((await saved).status(), 201);
  await page.getByText('Qualified leads: 2 count').waitFor();
  const csv = 'record_id,period_start,period_end,landing_page,metric_name,value,unit,currency,attribution_method,notes,supersedes_id\n' +
    `browser-import,${start},${end},,AI referrals,3,count,,Observed referral,,\n`;
  const importForm = page.locator('form[data-api-form="/api/outcomes/import"]');
  await importForm.locator('[name="source"]').fill('Analytics');
  await importForm.locator('[name="import_id"]').fill('browser-week-1');
  await importForm.locator('[name="author"]').fill('Reviewer');
  await importForm.locator('[name="csv_text"]').fill(csv);
  const imported = page.waitForResponse((response) => response.url().endsWith('/api/outcomes/import')
    && response.request().method() === 'POST');
  await importForm.getByRole('button', { name: 'Import CSV' }).click();
  assert.equal((await imported).status(), 201);
  await page.getByText('AI referrals: 3 count').waitFor();
  assert.equal(db.prepare('SELECT raw_csv FROM outcome_imports WHERE import_id = ?')
    .get('browser-week-1')?.raw_csv, csv);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: '/tmp/hearsay-c15-light.png', fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: '/tmp/hearsay-c15-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/hearsay-c15-narrow.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const download = await page.getByRole('link', { name: 'Download Markdown' }).getAttribute('href');
  assert.ok(download);
  const response = await page.request.get(`${base}${download}`);
  assert.equal(response.status(), 200);
  assert.match(await response.text(), /Qualified leads/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n), 1);
  process.stdout.write('Weekly review browser flow passed at wide and narrow sizes.\n');
} finally {
  await browser.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
