import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { run } from '../core/db.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { startServer } from '../server.js';

const { chromium } = await import('playwright');
const directory = mkdtempSync(join(tmpdir(), 'hearsay-untrusted-browser-'));
const sentinel = createServer((_request, response) => {
  requests += 1;
  response.writeHead(204).end();
});
let requests = 0;
await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', () => resolve(undefined)));
const sentinelAddress = sentinel.address();
if (!sentinelAddress || typeof sentinelAddress === 'string') throw new Error('Missing sentinel port');
const sentinelPort = sentinelAddress.port;
const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'hearsay.db'), HEARSAY_DEMO: '0' });
const app = await startServer({ host: '127.0.0.1', port: 0, dbPath: config.dbPath, config });
const browser = await chromium.launch();

try {
  const at = new Date().toISOString();
  run(app.db, 'INSERT INTO entities(id,name,is_self,created_at) VALUES(1,?,?,?)', ['Acme', 1, at]);
  run(app.db, 'INSERT INTO intents(id,label,created_at) VALUES(1,?,?)', ['Compare tools', at]);
  run(app.db, 'INSERT INTO prompts(id,intent_id,text,category,active,created_at) VALUES(1,1,?,?,1,?)',
    ['Which tool fits?', 'discovery', at]);
  run(app.db, "INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')", [at]);
  const injected = `<script>window.__hearsayInjected=true</script><img src="http://127.0.0.1:${sentinelPort}/beacon">`;
  run(app.db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
    surface,lane,target_status,comparability_status,comparison_key,analysis_revision,
    search_policy,answer_status,web_status,query_metadata_status,prompt_text_snapshot)
    VALUES(1,1,1,'codex','fixture',0,?,?,'codex-agent','tracking','completed','comparable',
    'untrusted-browser','stance-en-v1','required','complete','verified','available','Which tool fits?')`,
  [injected, at]);
  run(app.db, `INSERT INTO search_events(id,response_id,event_type,status,observed_at)
    VALUES(1,1,'search','completed',?)`, [at]);
  run(app.db, `INSERT INTO search_queries(response_id,search_event_id,original_text,normalized_key,ordinal)
    VALUES(1,1,'<svg onload=alert(1)>','<svg onload=alert(1)>',0)`);
  run(app.db, `INSERT INTO source_observations(response_id,url,title,provenance)
    VALUES(1,'javascript:alert(1)',?,'search_result')`,
  [`<img src="http://127.0.0.1:${sentinelPort}/beacon">`]);
  run(app.db, `INSERT INTO answer_citations(response_id,url,provenance,ordinal)
    VALUES(1,'file:///etc/passwd','explicit_reference',0)`);

  const series = listMeasurementSeries(app.db, { days: 30, now: new Date() })[0];
  assert.ok(series);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${app.port}`;
  await page.goto(`${base}/evidence?days=30&series_id=${series.id}&intent_id=1`);
  await page.getByText('<svg onload=alert(1)>').first().waitFor();
  assert.equal(await page.locator('a[href^="javascript:"],a[href^="file:"]').count(), 0);
  assert.equal(await page.locator(`img[src="http://127.0.0.1:${sentinelPort}/beacon"]`).count(), 0);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__hearsayInjected === true), false);
  await page.goto(`${base}/answers?series_id=${series.id}`);
  await page.getByText('<script>window.__hearsayInjected=true</script>').first().waitFor();
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__hearsayInjected === true), false);
  assert.equal(requests, 0);
  await page.close();
  process.stdout.write('Untrusted evidence stayed text; unsafe links and local beacon were not requested.\n');
} finally {
  await browser.close();
  await app.close();
  await new Promise((resolve) => sentinel.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
