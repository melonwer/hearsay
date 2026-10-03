import {existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {buildConfig} from '../../core/config.js';
import {startServer} from '../../server.js';
import {importResearch, proposeResearchAction} from '../../core/research-store.js';
import {storeMeasurementEvidence, storeTargetDefinition} from '../../core/measurement-storage.js';
import {stableIdentity} from '../../core/measurement-contract.js';
import {listMeasurementSeries} from '../../core/metrics.js';

const directory = mkdtempSync(join(tmpdir(), 'hearsay-video-capture-'));
const project = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(project, 'public/captures');
mkdirSync(output, {recursive: true});
const config = buildConfig({HEARSAY_DB_PATH: join(directory, 'demo.db'), HEARSAY_DATA_DIR: directory, HEARSAY_DEMO: '1'});
const app = await startServer({host: '127.0.0.1', port: 0, portFile: join(directory, 'port'), dbPath: config.dbPath, config, log: () => {}});
const fixture = JSON.parse(readFileSync(resolve(project, '../skill/templates/evidence.json'), 'utf8'));
const at = new Date().toISOString();
fixture.createdAt = at;
fixture.runId = 'launch-film-demo';
fixture.app = {id: 'notewell-film-demo', name: 'Notewell', url: 'https://notewell.example/', aliases: [], audience: 'Small teams', useCases: ['Search past meeting notes']};
fixture.provenance = {producer: 'Hearsay launch film fixture', limitations: ['Fictional demo. No research, provider call, or website experiment was performed.']};
fixture.panel.questions = [{id: 'q1', text: 'Which meeting-notes tool works for a small team?'}];
fixture.evidence = [{id: 'demo-page', type: 'fetched_page', timestamp: fixture.createdAt, origin: 'host_research', capture: 'host_reported', sampleId: null, data: {url: 'https://notewell.example/product', title: 'Fictional Notewell product page'}}];
fixture.recommendations = [{id: 'buyer-page', title: 'Explain the small-team use case', evidenceIds: ['demo-page'], hypothesis: 'A focused page may answer this buyer question more directly. This is a hypothesis to test.', proposedChange: 'Draft a page explaining how a small team can search past meeting notes.', effort: 'small', priority: 'high', repeatMeasurement: {questionIds: ['q1'], routeIds: [], supports: 'New evidence answers the buyer question.', rejects: 'The question remains unanswered.'}, draftPath: 'drafts/small-team/content.md'}];
writeFileSync(join(output, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
const research = importResearch(app.db, fixture);
proposeResearchAction(app.db, research.id, 'buyer-page');
const intent = Number(app.db.prepare('INSERT INTO intents(label,created_at) VALUES(?,?)').run('Choosing a tool for a small team', at).lastInsertRowid);
const question = 'Which meeting-notes tool works for a small team?';
const prompt = Number(app.db.prepare('INSERT INTO prompts(intent_id,text,category,active,created_at) VALUES(?,?,?,1,?)').run(intent, question, 'general', at).lastInsertRowid);
const run = Number(app.db.prepare("INSERT INTO runs(started_at,trigger,status) VALUES(?,'manual','done')").run(at).lastInsertRowid);
const response = Number(app.db.prepare(`INSERT INTO responses(run_id,prompt_id,provider,model,sample_idx,created_at,surface,lane,target_status,prompt_text_snapshot)
  VALUES(?,?,'codex','demo-model',0,?,'codex-agent','tracking','queued',?)`).run(run, prompt, at, question).lastInsertRowid);
const profile = {surface: 'codex-agent', model: 'demo-model', searchPolicy: 'required', demo: true};
const benchmark = {questions: [{id: prompt, intentId: intent, text: question, category: 'general'}]};
storeTargetDefinition(app.db, response, {profile: {id: stableIdentity(profile), snapshot: profile}, benchmark: {id: stableIdentity(benchmark), snapshot: benchmark}, analysisRevision: 'stance-en-v1', searchPolicy: 'required', at});
const measurement = {
  policy: 'required', answerStatus: 'complete', at,
  answer: "Notewell is one option for searching past meeting notes. Review its product documentation to check whether it fits your team's needs.",
  actions: [{id: 'demo-search', kind: 'search', status: 'completed', queries: ['meeting notes tool small team'], queryMetadata: 'available', providerType: 'fictional_demo', observedAt: at}],
  sources: [{id: 'demo-source', actionId: 'demo-search', url: 'https://notewell.example/product', title: 'Notewell product guide · fictional demo', excerpt: 'Search past meeting notes as a small team.', provenance: 'search_result', order: 0}],
  citations: [{sourceId: 'demo-source', url: 'https://notewell.example/product', provenance: 'explicit_reference', start: null, end: null}],
  usage: [],
};
storeMeasurementEvidence(app.db, response, measurement);
writeFileSync(join(output, 'measurement-fixture.json'), JSON.stringify({question, measurement, notice: 'Entirely scripted fictional demo; no agent, search, or provider was invoked.'}, null, 2) + '\n');
const series = listMeasurementSeries(app.db, {days: 30, now: new Date().toISOString()}).find(item => item.surface === 'codex-agent');
if (!series) throw new Error('Demo measurement series was not created.');
const browser = await chromium.launch({executablePath: process.env.CHROME_EXECUTABLE ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : chromium.executablePath()), headless: true});
const page = await browser.newPage({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 2, colorScheme: 'light'});
await page.addInitScript(() => localStorage.setItem('hearsay:theme', 'light'));
const selection = `series_id=${encodeURIComponent(series.id)}&intent_id=${intent}`;
const pages = [{id: 'answers', path: `/answers?${selection}`}, {id: 'evidence', path: `/evidence?${selection}&receipt_id=${response}&layer=answers`}, {id: 'opportunities', path: `/opportunities?${selection}`}, {id: 'research', path: `/research?id=${research.id}`}];
const layout = {};
try {
  for (const item of pages) {
    await page.goto(`http://127.0.0.1:${app.port}${item.path}`, {waitUntil: 'networkidle'});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({path: join(output, `${item.id}-full.png`)});
    const elements = await page.locator('.card').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return {x: rect.x, y: rect.y + window.scrollY, w: rect.width, h: rect.height, text: node.textContent};
    }));
    layout[item.id] = {pageH: 1080, fullDocumentH: await page.evaluate(() => document.documentElement.scrollHeight), elements};
    for (let index = 0; index < Math.min(elements.length, 6); index++) {
      if (elements[index].h <= 1800) await page.locator('.card').nth(index).screenshot({path: join(output, `${item.id}-${index}.png`)});
    }
    if (item.id === 'evidence') {
      const receipt = page.locator(`#receipt-${response}`);
      const sections = await receipt.locator('h4').count();
      for (let index = 0; index < sections; index++) {
        const heading = receipt.locator('h4').nth(index);
        await heading.scrollIntoViewIfNeeded();
        const clip = await heading.evaluate(node => {
          const top = node.getBoundingClientRect();
          let bottom = top.bottom;
          for (let sibling = node.nextElementSibling; sibling && sibling.tagName !== 'H4'; sibling = sibling.nextElementSibling) {
            bottom = Math.max(bottom, sibling.getBoundingClientRect().bottom);
          }
          return {x: top.x, y: top.y - 8, width: top.width, height: bottom - top.y + 16};
        });
        await page.screenshot({path: join(output, `evidence-section-${index}.png`), clip});
      }
    }
  }
  const receipt = app.db.prepare('SELECT * FROM responses ORDER BY id DESC LIMIT 1').get();
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt ?? {}, null, 2) + '\n');
  writeFileSync(join(output, 'layout.json'), JSON.stringify(layout, null, 2) + '\n');
  writeFileSync(join(output, 'provenance.json'), JSON.stringify({source: 'Actual Hearsay pages from temporary fictional demo workspace', database: directory, liveProviderCalls: 0, importedProposal: 'Synthetic fixture retained as fixture.json', viewport: {width: 1920, height: 1080}, deviceScaleFactor: 2}, null, 2) + '\n');
} finally {
  await browser.close();
  await app.close();
}
