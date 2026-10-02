import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { studyFixture, STUDY_TIME } from '../test-support/study-fixture.js';
import { writeJson } from '../core/research-workspace.js';

const cli = new URL('../bin/hearsay.js', import.meta.url).pathname;
function command(args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('founder CLI resumes a captured baseline, approves exact scope and saves analysis and outcome reports', async (t) => {
  const f = await studyFixture(t);
  const html = join(f.projectDirectory, 'page.html');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(html, '<h1>Outfit feedback from photos</h1>');
  const capture = command(['study', 'capture', '--study', f.directory, '--input', html]);
  const version = join(f.projectDirectory, 'version.json');
  writeJson(version, { id: 'page-v1', pageId: capture.id, status: 'published', author: 'owner', publishedAt: STUDY_TIME });
  command(['study', 'version', '--study', f.directory, '--input', version]);
  const preview = command(['study', 'preview', '--study', f.directory]);
  command(['study', 'approve', '--study', f.directory, '--confirm', preview.quoteId, '--author', 'owner']);
  const occurrence = command(['study', 'collect', '--study', f.directory]);
  assert.equal(occurrence.status, 'failed');
  assert.match(occurrence.reason, /host_research_due/);
  const analysis = join(f.projectDirectory, 'analysis.json');
  writeJson(analysis, { id: 'analysis-1', occurrenceIds: [occurrence.occurrenceId], evidenceIds: [capture.id], author: 'host-agent', recommendation: 'Continue observing', reason: 'No independent routes selected; audit the current product sources.', nextAction: 'Collect owner-supplied outcomes.' });
  command(['study', 'analysis', '--study', f.directory, '--input', analysis]);
  const report = command(['study', 'report', '--study', f.directory]);
  assert.equal(report.summary.analysisDue, 0);
  assert.equal(report.summary.recommendationObservations, 0);
  assert.match(report.markdown, /No linked business outcomes/);
  const exported = command(['study', 'export', '--study', f.directory]);
  assert.equal(exported.manifest.appId, f.plan.app.id);
  assert.equal(exported.pages[0].content.trim(), 'Outfit feedback from photos');
  assert.ok(existsSync(join(f.directory, 'pages', capture.id, 'original.html')));
  assert.equal(readFileSync(join(f.directory, 'pages', capture.id, 'original.html'), 'utf8'), '<h1>Outfit feedback from photos</h1>');
  assert.equal(exported.reviews.length, 1);
});

test('owner CSV outcome imports preserve source, denominators and study change links across retries', async (t) => {
  const f = await studyFixture(t);
  const change = join(f.projectDirectory, 'change.json');
  writeJson(change, { id: 'change-1', hypothesis: 'Explain outfit photo feedback', evidenceIds: [], status: 'proposed' });
  command(['study', 'change', '--study', f.directory, '--input', change]);
  const csv = join(f.projectDirectory, 'outcomes.csv');
  const raw = 'recordKey,pageUrl,periodStart,periodEnd,metric,value,unit,currency,denominator,attributionMethod,trafficNotes,changeId,phase,cohort,assignment\n' +
    'lead-1,https://drip.example/,2026-10-02,2026-10-03,qualified_leads,5,count,,100,owner supplied,same audience,change-1,baseline,,\n';
  const { writeFileSync } = await import('node:fs'); writeFileSync(csv, raw);
  const args = ['study', 'outcomes', '--study', f.directory, '--input', csv, '--source', 'owner analytics'];
  const imported = command(args);
  assert.equal(imported.saved[0].denominator, 100);
  command(args);
  const exported = command(['study', 'export', '--study', f.directory]);
  assert.equal(exported.outcomes.length, 1);
  assert.equal(exported.events.find((event) => event.type === 'outcome_import').rawCsv, raw);
  const report = command(['study', 'report', '--study', f.directory]);
  assert.equal(report.business[0].conclusion, 'inconclusive');
});
