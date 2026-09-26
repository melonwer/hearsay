import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildConfig } from '../core/config.js';
import { startServer } from '../server.js';

const { chromium } = await import('playwright');
const directory = mkdtempSync(join(tmpdir(), 'hearsay-research-browser-'));
const captures = resolve(process.env.HEARSAY_RESEARCH_CAPTURE_DIR || '/tmp/hearsay-research-ui');
mkdirSync(captures, { recursive: true });
const input = process.env.HEARSAY_RESEARCH_FIXTURE
  ? JSON.parse(readFileSync(process.env.HEARSAY_RESEARCH_FIXTURE, 'utf8'))
  : JSON.parse(readFileSync(new URL('../skill/templates/evidence.json', import.meta.url), 'utf8'));
if (!process.env.HEARSAY_RESEARCH_FIXTURE) {
  input.runId = 'browser-fixture';
  input.app = { id: 'acme', name: 'Acme', url: 'https://acme.example/', aliases: [], audience: 'Small teams', useCases: ['Send newsletters'] };
  input.provenance = { producer: 'browser-fixture', limitations: ['Synthetic browser fixture; no provider call.'] };
  input.panel.questions = [{ id: 'q1', text: 'Which tools can send a newsletter?' }];
  input.evidence = [{ id: 'page-1', type: 'fetched_page', timestamp: input.createdAt, origin: 'host_research', capture: 'host_reported', sampleId: null, data: { url: 'https://acme.example/docs', title: 'Newsletter documentation' } }];
  input.recommendations = [{ id: 'guide', title: 'Explain newsletter setup', evidenceIds: ['page-1'], hypothesis: 'A setup guide may answer buyer questions.', proposedChange: 'Draft a guide for a first newsletter.', effort: 'small', priority: 'high', repeatMeasurement: { questionIds: ['q1'], routeIds: [], supports: 'Readers complete the setup.', rejects: 'The guide leaves their questions unanswered.' }, draftPath: 'drafts/guide/content.md' }];
}
assert.ok(input.recommendations.length, 'The UI fixture needs a proposal to review.');
const config = buildConfig({ HEARSAY_DB_PATH: join(directory, 'research.db'), HEARSAY_DATA_DIR: directory, HEARSAY_DEMO: '0' });
const app = await startServer({ host: '127.0.0.1', port: 0, portFile: join(directory, 'port'), dbPath: config.dbPath, config, log: () => {} });
const browser = await chromium.launch();
const base = `http://127.0.0.1:${app.port}`;
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
/** @type {string[]} */
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
/** @type {{fixture:string,screenshots:string[],checks:Record<string,unknown>[],status?:string,error?:string,pageErrors?:string[]}} */
const result = { fixture: process.env.HEARSAY_RESEARCH_FIXTURE || 'synthetic built-in fixture', screenshots: [], checks: [] };
/** @param {string} name */
async function screenshot(name) {
  await page.screenshot({ path: join(captures, name), fullPage: true });
  result.screenshots.push(join(captures, name));
}
/** @param {string} label */
async function noOverflow(label) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((element) => `${element.tagName}.${element.className}`) }));
  assert.equal(dimensions.document <= dimensions.viewport, true, `${label}: ${JSON.stringify(dimensions)}`);
  result.checks.push({ check: label, ...dimensions });
}
/** @param {import('../core/research-contract.js').ResearchRecord} bundle */
async function upload(bundle) {
  await page.locator('[data-research-import] input[type=file]').setInputFiles({ name: 'evidence.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  const response = page.waitForResponse((response) => response.url().endsWith('/api/research/import') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Import report', exact: true }).click();
  const saved = await response;
  assert.equal(saved.status(), 200);
  await page.getByRole('link', { name: `${bundle.app.name} · ${bundle.runId}`, exact: true }).waitFor();
  return Number(row('SELECT id FROM research_runs WHERE app_id = ? AND run_id = ?', bundle.app.id, bundle.runId).id);
}
/** @param {string} sql @param {...import('node:sqlite').SQLInputValue} params */
function row(sql, ...params) { const value = app.db.prepare(sql).get(...params); assert.ok(value); return value; }
try {
  await page.goto(base + '/research');
  await page.getByText('No imported reports.', { exact: false }).waitFor();
  const first = await upload(input);
  assert.equal(row('SELECT COUNT(*) AS n FROM research_actions').n, 0);
  const repeat = structuredClone(input);
  repeat.runId = `${input.runId.slice(0, 70)}-ui-comparison`;
  repeat.provenance.limitations.push('Cloned fixture for UI comparison verification; no second measurement occurred.');
  repeat.traceEvents = [{ type: 'verification_marker', text: 'Synthetic browser trace marker; not provider activity.' }];
  const second = await upload(repeat);
  await page.getByRole('link', { name: `${repeat.app.name} · ${repeat.runId}`, exact: true }).click();
  await page.getByRole('heading', { name: repeat.app.name, exact: true }).waitFor();
  assert.match(await page.locator('.research-grid').innerText(), /External provenance/);
  await page.getByText('Report as Markdown', { exact: true }).click();
  assert.match(await page.locator('.research-pre').first().innerText(), /visibility report/);
  await page.getByText('Report as Markdown', { exact: true }).click();
  await page.getByText('Available trace events', { exact: true }).click();
  await page.getByText('Synthetic browser trace marker; not provider activity.', { exact: false }).first().waitFor();
  await page.locator('[name=baseline]').selectOption(String(first));
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('heading', { name: 'Comparison', exact: true }).waitFor();
  await page.getByText('Comparison details', { exact: true }).click();
  assert.match(await page.locator('.research-pre').first().innerText(), /incompatible/);
  await page.getByText('Comparison details', { exact: true }).click();
  result.checks.push({ check: 'host audit comparison stays ineligible', first, second });
  await noOverflow('research wide');
  await screenshot('research-wide.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('heading', { name: 'Comparison', exact: true }).waitFor();
  await noOverflow('research narrow');
  await screenshot('research-narrow.png');
  const propose = page.waitForResponse((response) => response.url().endsWith('/propose') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Propose in Opportunities', exact: true }).first().click();
  assert.equal((await propose).status(), 200);
  await page.getByText('Proposal saved. Review it in Opportunities before accepting.', { exact: true }).waitFor();
  const action = row('SELECT * FROM research_actions');
  assert.equal(action.status, 'proposed');
  assert.equal(action.reviewed_at, null);
  await page.goto(base + '/opportunities');
  await page.getByRole('heading', { name: 'Imported research proposals', exact: true }).waitFor();
  await noOverflow('opportunities narrow');
  await screenshot('opportunities-proposed-narrow.png');
  await page.setViewportSize({ width: 1280, height: 900 });
  await noOverflow('opportunities wide');
  await screenshot('opportunities-proposed-wide.png');
  const form = page.locator(`[data-research-review="${action.id}"]`);
  await form.locator('[name=reason]').fill('Reviewed the linked source evidence; this fixture proposal is dismissed for the browser test.');
  await form.locator('[name=status]').selectOption('dismissed');
  const review = page.waitForResponse((response) => response.url().endsWith('/review') && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Save review', exact: true }).click();
  assert.equal((await review).status(), 200);
  await page.locator('.research-actions').getByText(`${input.app.name} · dismissed · external provenance`, { exact: true }).waitFor();
  assert.equal(row('SELECT status FROM research_actions WHERE id = ?', Number(action.id)).status, 'dismissed');
  assert.equal(await page.locator(`[data-research-review="${action.id}"]`).count(), 0);
  result.checks.push({ check: 'proposal required a separate reasoned review', before: 'proposed', after: 'dismissed' });
  for (const table of ['runs', 'responses', 'mentions']) assert.equal(row(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
  assert.deepEqual(errors, []);
  result.status = 'passed';
  writeFileSync(join(captures, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  result.status = 'failed'; result.error = String(error); result.pageErrors = errors;
  await screenshot('failure.png');
  writeFileSync(join(captures, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
