import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { run } from '../core/db.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { startServer } from '../server.js';

const { chromium } = await import('playwright');
const directory = mkdtempSync(join(tmpdir(), 'hearsay-gemini-browser-'));
const destination = createServer((_request, response) => response.writeHead(200).end('suggestion target'));
await new Promise((resolve) => destination.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = destination.address();
if (!address || typeof address === 'string') throw new Error('Missing local destination port');
const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'hearsay.db'), HEARSAY_DEMO: '0' });
const app = await startServer({ host: '127.0.0.1', port: 0, dbPath: config.dbPath, config });
const browser = await chromium.launch();

try {
  const at = new Date().toISOString();
  run(app.db, 'INSERT INTO intents(id,label,created_at) VALUES(1,?,?)', ['Awards', at]);
  run(app.db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Who won?','discovery',1,?)`, [at]);
  run(app.db, "INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')", [at]);
  run(app.db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
    surface,lane,target_status,comparability_status,comparison_key,analysis_revision,
    search_policy,answer_status,web_status,query_metadata_status,prompt_text_snapshot)
    VALUES(1,1,1,'gemini','gemini-3.6-flash',0,'Café wins.',?,'gemini-api','tracking',
    'completed','comparable','gemini-browser','stance-en-v1','auto','complete','verified',
    'available','Who won?')`, [at]);
  run(app.db, `INSERT INTO search_events(response_id,event_type,status,observed_at)
    VALUES(1,'search','completed',?)`, [at]);
  const markup = `<style>a{color:blue}</style><script>window.parent.__geminiEscaped=true</script>
    <a href="http://127.0.0.1:${address.port}/suggestion" target="_blank">Search suggestion</a>`;
  const receipt = { version: 1, status: 'present', webSearchQueries: ['Café winner'],
    groundingChunks: [], groundingSupports: [], searchEntryPoint: { renderedContent: markup } };
  run(app.db, `INSERT INTO gemini_grounding_receipts(response_id,metadata_json,created_at)
    VALUES(1,?,?)`, [JSON.stringify(receipt), at]);

  const series = listMeasurementSeries(app.db, { days: 30, now: new Date() })[0];
  assert.ok(series);
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  await page.goto(`${base}/answers?series_id=${series.id}`);
  const frame = page.frameLocator('iframe[title="Google Search Suggestions"]');
  await frame.getByRole('link', { name: 'Search suggestion' }).waitFor();
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__geminiEscaped === true), false);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.locator(`[data-theme-set="${theme}"]`).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await frame.getByRole('link', { name: 'Search suggestion' }).isVisible(), true);
      const screenshotDir = process.env.HEARSAY_GEMINI_SCREENSHOT_DIR;
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
        await page.locator('iframe').scrollIntoViewIfNeeded();
        await page.locator('iframe').screenshot({ path: join(screenshotDir, `gemini-frame-${width}-${theme}.png`) });
        await page.screenshot({ path: join(screenshotDir, `gemini-answers-${width}-${theme}.png`) });
      }
    }
  }
  const popupPromise = page.waitForEvent('popup');
  await frame.getByRole('link', { name: 'Search suggestion' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(new URL(popup.url()).pathname, '/suggestion');
  await popup.close();

  await page.goto(`${base}/evidence?days=30&series_id=${series.id}&intent_id=1&layer=answers`);
  await page.frameLocator('iframe[title="Google Search Suggestions"]')
    .getByRole('link', { name: 'Search suggestion' }).waitFor();
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__geminiEscaped === true), false);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.locator(`[data-theme-set="${theme}"]`).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.frameLocator('iframe[title="Google Search Suggestions"]')
        .getByRole('link', { name: 'Search suggestion' }).isVisible(), true);
      const screenshotDir = process.env.HEARSAY_GEMINI_SCREENSHOT_DIR;
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
        await page.locator('iframe').scrollIntoViewIfNeeded();
        await page.locator('iframe').screenshot({ path: join(screenshotDir, `gemini-evidence-frame-${width}-${theme}.png`) });
        await page.screenshot({ path: join(screenshotDir, `gemini-evidence-${width}-${theme}.png`) });
      }
    }
  }
  await page.close();
  process.stdout.write('Gemini Suggestions rendered in a scriptless frame; its link opened directly.\n');
} finally {
  await browser.close();
  await app.close();
  await new Promise((resolve) => destination.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
