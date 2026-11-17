import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildConfig } from '../core/config.js';
import { get, MIGRATIONS, openDb, run, SCHEMA_VERSION, userVersion } from '../core/db.js';
import { captureFollowUpReview, saveFollowUpPlan } from '../core/follow-up.js';
import { compareIntervention } from '../core/intervention-comparison.js';
import { listMeasurementSeries } from '../core/metrics.js';
import { createOpportunity, getOpportunity, reviewOpportunity } from '../core/opportunities.js';
import {
  compareControlledPageOutcomes,
  CONTROL_PAGE_NOTE,
  exportOutcomeCsv,
  importOutcomeCsv,
  listOutcomeRecords,
  OUTCOME_CSV_HEADER,
  OUTCOME_EXTENDED_CSV_COLUMNS,
  OutcomeError,
  recordOutcome,
} from '../core/outcomes.js';
import { validateEvidence } from '../core/research-contract.js';
import { renderResearchReport, summarizeResearchCitationGaps } from '../core/research-report.js';
import { importResearch } from '../core/research-store.js';
import { normalizeStudyOutcome, parseStudyOutcomeCsv, studyOutcomeCsvColumns } from '../core/study-outcomes.js';
import { deriveStudyReport } from '../core/study-report.js';
import { buildWeeklyReview, listKnownWeeklySeries, renderWeeklyMarkdown } from '../core/weekly-review.js';
import { startServer } from '../server.js';
import * as opportunitiesPage from '../web/pages/opportunities.js';
import * as weeklyReviewPage from '../web/pages/weekly-review.js';

const BASELINE_START = '2026-09-01T00:00:00Z';
const BASELINE_END = '2026-09-08T00:00:00Z';
const REVIEW_START = '2026-09-08T00:00:00Z';
const REVIEW_END = '2026-09-15T00:00:00Z';
const NOW = '2026-09-20T00:00:00Z';

const SHELL_CTX = {
  demo: false,
  openAlerts: 0,
  lastRunLine: null,
  version: '0.1.0-test',
};

/** @param {Record<string, unknown>} [overrides] */
function makeResearchBundle(overrides = {}) {
  const createdAt = '2026-09-10T09:00:00Z';
  const finishedAt = '2026-09-10T09:00:15Z';
  const base = {
    schemaVersion: 1,
    runId: 'probe-run-1',
    createdAt,
    mode: 'research_audit',
    app: {
      id: 'notewell',
      name: 'Notewell',
      url: 'https://notewell.example/',
      aliases: ['NoteWell'],
      audience: 'B2B revenue teams',
      useCases: ['Meeting transcription and CRM handoff'],
    },
    panel: {
      id: 'panel-b2b-1',
      createdAt,
      reviewedAt: createdAt,
      questions: [
        { id: 'q1', text: 'Which meeting transcription tools sync call notes to HubSpot?' },
        { id: 'q2', text: 'What AI note takers have SOC 2 controls for sales teams?' },
      ],
      competitors: [
        {
          id: 'fireflies',
          name: 'Fireflies',
          url: 'https://fireflies.example/',
          aliases: [],
          relationship: 'direct',
          reason: 'Competes for B2B sales call transcription',
          evidenceIds: ['ev-discovery'],
        },
      ],
    },
    execution: {
      id: 'exec-codex-1',
      routes: [{ id: 'codex', provider: 'openai', profile: 'codex-isolated-v1', executable: '/usr/bin/codex' }],
      samples: 1,
      timeoutMs: 120000,
      idleTimeoutMs: 60000,
      maxOutputBytes: 1048576,
      envelope: 'subscription-search-v1',
      language: 'en',
      location: 'uncontrolled',
    },
    analysis: { id: 'analysis-1', method: 'hearsay-evidence-v1' },
    provenance: {
      producer: 'Codex standalone skill',
      limitations: ['Single-sample standalone audit; not a native scheduled panel'],
    },
    evidence: [
      {
        id: 'ev-discovery',
        type: 'fetched_page',
        timestamp: createdAt,
        origin: 'host_research',
        capture: 'host_reported',
        sampleId: null,
        data: { url: 'https://fireflies.example/', title: 'Fireflies AI' },
      },
      {
        id: 's1-search',
        type: 'tool_outcome',
        timestamp: createdAt,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        sampleId: 's1',
        data: { tool: 'search', status: 'completed' },
      },
      {
        id: 's1-answer',
        type: 'answer',
        timestamp: finishedAt,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        sampleId: 's1',
        data: { text: 'Notewell and Fireflies both sync structured call notes to HubSpot.' },
      },
      {
        id: 's2-search',
        type: 'tool_outcome',
        timestamp: createdAt,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        sampleId: 's2',
        data: { tool: 'search', status: 'completed' },
      },
      {
        id: 's2-answer',
        type: 'answer',
        timestamp: finishedAt,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        sampleId: 's2',
        data: { text: 'Fireflies lists SOC 2 Type II compliance in third-party buyer directories.' },
      },
      {
        id: 's2-cite-g2',
        type: 'final_citation',
        timestamp: finishedAt,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        sampleId: 's2',
        data: { url: 'https://www.g2.com/categories/ai-meeting-assistants' },
      },
      {
        id: 's2-src-trustradius',
        type: 'returned_source',
        timestamp: finishedAt,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        sampleId: 's2',
        data: { url: 'https://www.trustradius.com/meeting-software' },
      },
    ],
    samples: [
      {
        id: 's1',
        questionId: 'q1',
        routeId: 'codex',
        host: 'codex-cli',
        provider: 'openai',
        model: 'gpt-5-codex',
        profile: 'codex-isolated-v1',
        startedAt: createdAt,
        finishedAt,
        status: 'completed',
        sessionIsolation: true,
        brandContext: false,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        evidenceIds: ['s1-search', 's1-answer'],
        mentions: [
          {
            brandId: 'notewell',
            answerId: 's1-answer',
            excerpt: 'Notewell and Fireflies both sync',
            positive: true,
            stance: 'positive',
            position: 1,
            confidence: 'certain',
          },
        ],
        usage: { inputTokens: null, outputTokens: null, durationMs: 15000, cost: null, remainingAllowance: null },
        errorCode: null,
      },
      {
        id: 's2',
        questionId: 'q2',
        routeId: 'codex',
        host: 'codex-cli',
        provider: 'openai',
        model: 'gpt-5-codex',
        profile: 'codex-isolated-v1',
        startedAt: createdAt,
        finishedAt,
        status: 'completed',
        sessionIsolation: true,
        brandContext: false,
        origin: 'supported_cli_measurement',
        capture: 'runner_captured',
        evidenceIds: ['s2-search', 's2-answer', 's2-cite-g2', 's2-src-trustradius'],
        mentions: [],
        usage: { inputTokens: null, outputTokens: null, durationMs: 15000, cost: null, remainingAllowance: null },
        errorCode: null,
      },
    ],
    recommendations: [],
    ...overrides,
  };
  return validateEvidence(base);
}

test('Priority 2 (outcome-probe parity): standalone research + qualified-lead outcome succeeds in Weekly Review with zero native series and preserves external provenance', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  assert.equal(userVersion(db), SCHEMA_VERSION);

  const bundle = makeResearchBundle();
  const imported = importResearch(db, bundle);
  assert.equal(imported.imported, true);
  assert.equal(imported.provenance, 'external');

  const lead = recordOutcome(db, {
    source: 'hubspot-crm',
    recordKey: 'ql-week-37',
    periodStart: REVIEW_START,
    periodEnd: REVIEW_END,
    landingPage: 'https://notewell.example/pricing',
    metricName: 'qualified_leads',
    value: '6',
    unit: 'count',
    attributionMethod: 'First-touch landing page in CRM',
    author: 'founder',
    now: NOW,
  });
  assert.equal(lead.value, '6');
  assert.equal(Number(get(db, 'SELECT COUNT(*) AS n FROM responses')?.n), 0);

  // 1. Exact reproduction of outcome-probe.mjs: calling buildWeeklyReview with bare research runId
  const byRunId = buildWeeklyReview(db, {
    seriesId: bundle.runId,
    start: REVIEW_START,
    end: REVIEW_END,
    now: NOW,
  });
  assert.equal(byRunId.scope.visibilitySource, 'Standalone Research Audit');
  assert.equal(byRunId.scope.provenance, 'external');
  assert.equal(byRunId.scope.series.id, `research:${bundle.runId}`);
  assert.equal(byRunId.coverage.mentionRate, null);
  assert.equal(byRunId.coverage.recommendationRate, null);
  assert.equal(byRunId.coverage.nativeSeriesBlended, false);
  assert.deepEqual(byRunId.standaloneResearch?.totals, {
    planned: 2,
    attempted: 2,
    completed: 2,
    failed: 0,
    partial: 0,
    skipped: 0,
    unrecorded: 0,
    eligible: 2,
    mentioned: 1,
    recommended: 1,
  });
  assert.equal(byRunId.reportedOutcomes.length, 1);
  assert.equal(byRunId.reportedOutcomes[0].metricName, 'qualified_leads');
  assert.equal(byRunId.reportedOutcomes[0].value, '6');

  // 2. Explicit `research:<run_id>` selector AND automatic fallback when seriesId is omitted
  const byPrefixed = buildWeeklyReview(db, {
    seriesId: `research:${bundle.runId}`,
    start: REVIEW_START,
    end: REVIEW_END,
    now: NOW,
  });
  const byFallback = buildWeeklyReview(db, {
    seriesId: '',
    start: REVIEW_START,
    end: REVIEW_END,
    now: NOW,
  });
  assert.equal(byPrefixed.scope.series.id, `research:${bundle.runId}`);
  assert.equal(byFallback.scope.series.id, `research:${bundle.runId}`);

  const known = listKnownWeeklySeries(db);
  assert.equal(known.length, 1);
  assert.equal(known[0].id, `research:${bundle.runId}`);
  assert.equal(known[0].sourceLabel, 'Standalone Research Audit');

  const md = renderWeeklyMarkdown(byRunId);
  assert.match(md, /Visibility source: Standalone Research Audit/);
  assert.match(md, /never blended with native tracking rates/);
  assert.match(md, /qualified\\_leads: 6 count/);

  // 3. End-to-end HTTP server verification (/api/weekly-review & /weekly-review page)
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-b2b-parity-'));
  const dbPath = join(dir, 'hearsay.db');
  const config = buildConfig({
    HEARSAY_DB_PATH: dbPath,
    HEARSAY_DATA_DIR: dir,
    HEARSAY_PORT_FILE: join(dir, 'hearsay.port'),
    PORT: '0',
  });
  const srv = await startServer({ config });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  try {
    const resImport = await fetch(`${baseUrl}/api/research/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    });
    assert.equal(resImport.status, 200);

    const csv = `${OUTCOME_CSV_HEADER},${OUTCOME_EXTENDED_CSV_COLUMNS.join(',')}\n`
      + `ql-base-c,${BASELINE_START},${BASELINE_END},https://notewell.example/pricing,qualified_leads,4,count,,CRM,,` + `,pricing-v2,,changed,https://notewell.example/security\n`
      + `ql-base-u,${BASELINE_START},${BASELINE_END},https://notewell.example/security,qualified_leads,3,count,,CRM,,` + `,pricing-v2,,control,\n`
      + `ql-post-c,${REVIEW_START},${REVIEW_END},https://notewell.example/pricing,qualified_leads,11,count,,CRM,,` + `,pricing-v2,,changed,https://notewell.example/security\n`
      + `ql-post-u,${REVIEW_START},${REVIEW_END},https://notewell.example/security,qualified_leads,5,count,,CRM,,` + `,pricing-v2,,control,\n`;
    const resOutcomes = await fetch(`${baseUrl}/api/outcomes/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'hubspot', import_id: 'b2b-batch-1', csv_text: csv, author: 'founder' }),
    });
    assert.equal(resOutcomes.status, 201);

    const apiAuto = await fetch(`${baseUrl}/api/weekly-review?start=${encodeURIComponent(REVIEW_START)}&end=${encodeURIComponent(REVIEW_END)}`);
    assert.equal(apiAuto.status, 200);
    const apiBody = await apiAuto.json();
    assert.equal(apiBody.scope.visibilitySource, 'Standalone Research Audit');
    assert.equal(apiBody.controlledPageComparisons.length, 1);
    assert.equal(apiBody.controlledPageComparisons[0].items[0].signedDifferenceInChange, '+5');

    const pageHtml = await fetch(`${baseUrl}/weekly-review?start=${encodeURIComponent(REVIEW_START)}&end=${encodeURIComponent(REVIEW_END)}`).then((r) => r.text());
    assert.match(pageHtml, /Standalone Research Audit/);
    assert.match(pageHtml, /Changed vs\. control page comparison/);
    assert.match(pageHtml, /4 → 11/);
    assert.match(pageHtml, /3 → 5/);
    assert.match(pageHtml, /\+5/);
    assert.match(pageHtml, /bounds background period drift when traffic is comparable/);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Priorities 1 & 3: action-linked outcomes compute exact changed-vs-control difference-in-change across Weekly Review, Opportunities, and Study Report', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());

  // Set up native tracking series + shipped opportunity with follow-up plan & review snapshot
  run(db, "INSERT INTO entities(id,name,aliases,domains,is_self,created_at) VALUES(1,'Notewell','[]','[\"notewell.example\"]',1,?)", [BASELINE_START]);
  run(db, "INSERT INTO intents(id,label,created_at) VALUES(1,'CRM meeting sync',?)", [BASELINE_START]);
  run(db, "INSERT INTO prompts(id,intent_id,text,category,active,created_at) VALUES(1,1,'Which meeting notes app syncs to HubSpot?','general',1,?)", [BASELINE_START]);
  run(db, "INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','done')", [BASELINE_START]);
  run(db, "INSERT INTO runs(id,started_at,trigger,status) VALUES(2,?,'manual','done')", [REVIEW_START]);
  run(db, "INSERT INTO execution_profiles(id,surface,snapshot_json,created_at) VALUES('prof-1','openai-api','{\"model\":\"gpt-4.1\"}',?)", [BASELINE_START]);
  run(db, "INSERT INTO benchmark_revisions(id,snapshot_json,created_at) VALUES('bench-1',?,?)", [
    JSON.stringify({
      questions: [{ id: 1, intentId: 1, text: 'Which meeting notes app syncs to HubSpot?', category: 'general' }],
      entities: [{ id: 1, role: 'brand', name: 'Notewell' }],
      weighting: 'equal',
    }),
    BASELINE_START,
  ]);
  run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
    surface,lane,target_status,comparability_status,web_status,execution_profile_id,
    benchmark_revision_id,analysis_revision,comparison_key,search_policy,answer_status,
    query_metadata_status,prompt_text_snapshot)
    VALUES(1,1,1,'openai','gpt-4.1',0,'Consider general tools',?,'openai-api','tracking',
    'completed','comparable','verified','prof-1','bench-1','stance-en-v1','cmp-1','required','complete','available',
    'Which meeting notes app syncs to HubSpot?')`, ['2026-09-03T10:00:00Z']);
  run(db, `INSERT INTO responses(id,run_id,prompt_id,provider,model,sample_idx,text,created_at,
    surface,lane,target_status,comparability_status,web_status,execution_profile_id,
    benchmark_revision_id,analysis_revision,comparison_key,search_policy,answer_status,
    query_metadata_status,prompt_text_snapshot)
    VALUES(2,2,1,'openai','gpt-4.1',0,'Notewell syncs to HubSpot cleanly',?,'openai-api','tracking',
    'completed','comparable','verified','prof-1','bench-1','stance-en-v1','cmp-1','required','complete','available',
    'Which meeting notes app syncs to HubSpot?')`, ['2026-09-10T10:00:00Z']);
  const mentionId = run(db, "INSERT INTO mentions(response_id,entity_id,first_index,occurrences,rank,recommended,snippet) VALUES(2,1,0,1,1,1,'Notewell syncs')").lastInsertRowid;
  run(db, `INSERT INTO mention_interpretations(mention_id,analysis_revision,method,stance,rule_id,evidence_start,evidence_end,created_at)
    VALUES(?,'stance-en-v1','positive_stance','positive','rule-1',0,8,?)`, [mentionId, REVIEW_START]);

  const series = listMeasurementSeries(db, { start: BASELINE_START, end: BASELINE_END })[0];
  assert.ok(series);
  const opp = createOpportunity(db, {
    series,
    intentId: 1,
    evidence: { responseIds: [1], queryIds: [], sourceIds: [], citationIds: [] },
    origin: 'manual',
    author: 'founder',
    targetUrl: 'https://notewell.example/pricing',
    now: '2026-09-05T00:00:00Z',
  });
  const planned = reviewOpportunity(db, {
    id: opp.id,
    expectedVersion: opp.recordVersion,
    status: 'planned',
    owner: 'Growth',
    reviewDate: '2026-09-16',
    author: 'founder',
    now: '2026-09-06T00:00:00Z',
  });
  const plan = saveFollowUpPlan(db, {
    id: opp.id,
    expectedVersion: planned.recordVersion,
    baselineStart: BASELINE_START,
    baselineEnd: BASELINE_END,
    intentIds: [1],
    comparisonIntentIds: [],
    primaryMetric: 'brand_mention_rate',
    expectedDirection: 'increase',
    reviewStart: REVIEW_START,
    reviewEnd: REVIEW_END,
    observationDelayDays: 0,
    author: 'founder',
    now: '2026-09-07T00:00:00Z',
  });
  const shipped = reviewOpportunity(db, {
    id: opp.id,
    expectedVersion: getOpportunity(db, opp.id).recordVersion,
    status: 'shipped',
    changeDescription: 'Added HubSpot CRM comparison table to /pricing',
    shippedAt: '2026-09-08T00:00:00Z',
    author: 'founder',
    now: '2026-09-08T00:00:00Z',
  });
  const snapshot = captureFollowUpReview(db, {
    id: opp.id,
    planId: plan.id,
    expectedVersion: shipped.recordVersion,
    author: 'founder',
    now: NOW,
  });

  // Validation checks for new fields
  assert.throws(() => recordOutcome(db, {
    source: 'crm', recordKey: 'bad-role', periodStart: BASELINE_START, periodEnd: BASELINE_END,
    metricName: 'qualified_leads', value: '1', unit: 'count', attributionMethod: 'crm',
    pageRole: 'invalid_role', author: 'founder',
  }), OutcomeError);
  assert.throws(() => recordOutcome(db, {
    source: 'crm', recordKey: 'bad-opp', periodStart: BASELINE_START, periodEnd: BASELINE_END,
    metricName: 'qualified_leads', value: '1', unit: 'count', attributionMethod: 'crm',
    opportunityId: 9999, author: 'founder',
  }), (err) => err instanceof OutcomeError && err.status === 404);

  // Record exact count AND exact decimal money outcomes across baseline & review for changed vs control pages
  const rows = [
    ['ql-cb', BASELINE_START, BASELINE_END, 'https://notewell.example/pricing', 'qualified_leads', '4', 'count', null, 'changed', 'https://notewell.example/security'],
    ['ql-ub', BASELINE_START, BASELINE_END, 'https://notewell.example/security', 'qualified_leads', '3', 'count', null, 'control', null],
    ['ql-cp', REVIEW_START, REVIEW_END, 'https://notewell.example/pricing', 'qualified_leads', '11', 'count', null, 'changed', 'https://notewell.example/security'],
    ['ql-up', REVIEW_START, REVIEW_END, 'https://notewell.example/security', 'qualified_leads', '5', 'count', null, 'control', null],
    ['arr-cb', BASELINE_START, BASELINE_END, 'https://notewell.example/pricing', 'pipeline_value', '1200.50', 'money', 'USD', 'changed', 'https://notewell.example/security'],
    ['arr-ub', BASELINE_START, BASELINE_END, 'https://notewell.example/security', 'pipeline_value', '1000.00', 'money', 'USD', 'control', null],
    ['arr-cp', REVIEW_START, REVIEW_END, 'https://notewell.example/pricing', 'pipeline_value', '1850.75', 'money', 'USD', 'changed', 'https://notewell.example/security'],
    ['arr-up', REVIEW_START, REVIEW_END, 'https://notewell.example/security', 'pipeline_value', '1100.25', 'money', 'USD', 'control', null],
  ];
  for (const [recordKey, periodStart, periodEnd, landingPage, metricName, value, unit, currency, pageRole, comparisonPage] of rows) {
    recordOutcome(db, {
      source: 'hubspot',
      recordKey,
      periodStart,
      periodEnd,
      landingPage,
      metricName,
      value,
      unit,
      currency,
      attributionMethod: 'Landing page first-touch',
      interventionId: 'pricing-hubspot-table',
      opportunityId: opp.id,
      pageRole,
      comparisonPage,
      author: 'founder',
      now: NOW,
    });
  }

  // Verify CSV export includes extended action-link columns and preserves values
  const exportedCsv = exportOutcomeCsv(db);
  assert.match(exportedCsv, /intervention_id,opportunity_id,page_role,comparison_page/);
  assert.match(exportedCsv, /pricing-hubspot-table/);

  // Verify intervention comparison includes exact businessComparison
  const interventionReport = compareIntervention(db, {
    opportunityId: opp.id,
    planId: plan.id,
    snapshotId: snapshot.id,
  });
  assert.equal(interventionReport.status, 'observed_increase');
  assert.equal(interventionReport.businessComparison.status, 'controlled_before_after');
  const leadsComp = interventionReport.businessComparison.items.find((i) => i.metricName === 'qualified_leads');
  const pipelineComp = interventionReport.businessComparison.items.find((i) => i.metricName === 'pipeline_value');
  assert.ok(leadsComp && pipelineComp);
  assert.deepEqual(
    [leadsComp.changed.baseline, leadsComp.changed.post, leadsComp.changed.signedDelta],
    ['4', '11', '+7'],
  );
  assert.deepEqual(
    [leadsComp.control.baseline, leadsComp.control.post, leadsComp.control.signedDelta],
    ['3', '5', '+2'],
  );
  assert.equal(leadsComp.differenceInChange, '5');
  assert.equal(leadsComp.signedDifferenceInChange, '+5');
  assert.equal(pipelineComp.changed.delta, '650.25');
  assert.equal(pipelineComp.control.delta, '100.25');
  assert.equal(pipelineComp.differenceInChange, '550');
  assert.equal(pipelineComp.signedDifferenceInChange, '+550');
  assert.equal(leadsComp.note, CONTROL_PAGE_NOTE);

  // Verify Opportunities page renders business comparison cleanly
  const oppRangeSeries = listMeasurementSeries(db, { start: BASELINE_START, end: REVIEW_END })[0];
  const oppView = opportunitiesPage.buildView(
    { db },
    new URLSearchParams({
      series_id: oppRangeSeries.id,
      start: BASELINE_START,
      end: REVIEW_END,
      intent_id: '1',
      comparison_plan_id: String(plan.id),
      comparison_snapshot_id: String(snapshot.id),
    }),
  );
  // Note: opportunity was created on `series` (BASELINE_START..BASELINE_END), check with its exact window too
  const exactOppView = opportunitiesPage.buildView(
    { db },
    new URLSearchParams({
      series_id: series.id,
      start: BASELINE_START,
      end: BASELINE_END,
      intent_id: '1',
      comparison_plan_id: String(plan.id),
      comparison_snapshot_id: String(snapshot.id),
    }),
  );
  assert.ok(oppView);
  const oppHtml = opportunitiesPage.render(SHELL_CTX, exactOppView);
  assert.match(oppHtml, /Changed vs\. control page business outcomes/);
  assert.match(oppHtml, /4 → 11/);
  assert.match(oppHtml, /3 → 5/);
  assert.match(oppHtml, /\+550/);
  assert.match(oppHtml, /bounds background period drift when traffic is comparable/);

  // Verify Weekly Review report, page HTML, and export HTML
  const weekly = buildWeeklyReview(db, {
    seriesId: series.id,
    start: REVIEW_START,
    end: REVIEW_END,
    now: NOW,
  });
  assert.equal(weekly.controlledPageComparisons.length, 1);
  assert.match(weekly.controlledPageComparisons[0].label, /Added HubSpot CRM comparison table/);
  const weeklyView = weeklyReviewPage.buildView(
    { db },
    new URLSearchParams({ series_id: series.id, start: REVIEW_START, end: REVIEW_END }),
  );
  const weeklyHtml = weeklyReviewPage.render(SHELL_CTX, weeklyView);
  const exportHtml = weeklyReviewPage.renderWeeklyReviewExport(weekly);
  for (const doc of [weeklyHtml, exportHtml]) {
    assert.match(doc, /Changed vs\. control page comparison/);
    assert.match(doc, /qualified_leads/);
    assert.match(doc, /pipeline_value/);
    assert.match(doc, /\+5/);
    assert.match(doc, /\+550/);
    assert.match(doc, /bounds background period drift when traffic is comparable/);
  }

  // Verify Study Outcomes & Study Report parity with pageRole + comparisonPage + exact arithmetic
  const studyCsv = `${studyOutcomeCsvColumns.join(',')},interventionId,pageRole,comparisonPage\n`
    + `s-cb,https://notewell.example/pricing,2026-09-01,2026-09-08,qualified_leads,4,count,,100,CRM,,pricing-v2,baseline,,,pricing-v2,changed,https://notewell.example/security\n`
    + `s-ub,https://notewell.example/security,2026-09-01,2026-09-08,qualified_leads,3,count,,100,CRM,,pricing-v2,baseline,,,pricing-v2,control,\n`
    + `s-ca,https://notewell.example/pricing,2026-09-08,2026-09-15,qualified_leads,11,count,,100,CRM,,pricing-v2,after,,,pricing-v2,changed,https://notewell.example/security\n`
    + `s-ua,https://notewell.example/security,2026-09-08,2026-09-15,qualified_leads,5,count,,100,CRM,,pricing-v2,after,,,pricing-v2,control,\n`;
  const parsedStudyOutcomes = parseStudyOutcomeCsv(studyCsv, { source: 'crm' });
  assert.equal(parsedStudyOutcomes.length, 4);
  assert.equal(parsedStudyOutcomes[0].pageRole, 'changed');
  assert.equal(normalizeStudyOutcome({
    source: 'crm',
    recordKey: 'manual-1',
    pageUrl: 'https://notewell.example/pricing',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-08',
    metric: 'qualified_leads',
    value: 4,
    unit: 'count',
    attributionMethod: 'crm',
    interventionId: 'pricing-v2',
    pageRole: 'changed',
    comparisonPage: 'https://notewell.example/security',
    phase: 'baseline',
  }).changeId, 'pricing-v2');

  const studyReport = deriveStudyReport({
    version: 1,
    studyId: 'study-b2b',
    appId: 'notewell',
    plan: {
      id: 'plan-1',
      app: { id: 'notewell', name: 'Notewell', url: 'https://notewell.example/' },
      targetUrl: 'https://notewell.example/pricing',
      comparison: { design: 'unchanged_reference', referenceUrl: 'https://notewell.example/security' },
      outcome: { minimumDenominator: 10, minimumObservations: 1, reviewPeriodDays: 7 },
      angles: [],
      questions: [],
      collection: {},
    },
    outcomes: parsedStudyOutcomes,
    searchRuns: [],
    researchRuns: [],
    events: [],
    approvals: [],
    analyses: [],
  });
  assert.equal(studyReport.business.length, 1);
  assert.equal(studyReport.business[0].conclusion, 'observed_difference_requires_caution');
  assert.equal(studyReport.business[0].pageComparison.signedDifferenceInChange, '+5');
  assert.match(studyReport.markdown, /Changed page \(https:\/\/notewell\.example\/pricing\): baseline 4 -> after 11 \(delta \+7\)/);
  assert.match(studyReport.markdown, /Control page \(https:\/\/notewell\.example\/security\): baseline 3 -> after 5 \(delta \+2\)/);
  assert.match(studyReport.markdown, /Difference-in-change \(changed minus control\): \+5/);
  assert.match(studyReport.markdown, /bounds background period drift when traffic is comparable/);
});

test('Priority 4: repeat research and study reports with recommendations: [] render non-empty Observed Citation Gaps & Next-Step Status across Research, Opportunities, and Weekly Review', (t) => {
  const bundle = makeResearchBundle({ recommendations: [] });
  const gaps = summarizeResearchCitationGaps(bundle);
  assert.equal(gaps.completedSamples, 2);
  assert.equal(gaps.brandAbsentSamples, 1);
  assert.equal(gaps.decision, 'investigate_citation_gap');
  assert.match(gaps.actionHeadline, /Competitors are cited via g2\.com, trustradius\.com; Notewell isn't\./);
  // Final citation (g2.com) ranks ahead of retrieved source (trustradius.com), and brand domain is excluded
  assert.deepEqual(gaps.domains.map((d) => d.domain), ['g2.com', 'trustradius.com']);
  assert.equal(gaps.domains[0].finalCitationCount, 1);
  assert.equal(gaps.domains[1].finalCitationCount, 0);

  const researchMarkdown = renderResearchReport(bundle);
  assert.match(researchMarkdown, /## Prioritized improvements\n\n### Observed Citation Gaps & Next-Step Status/);
  assert.match(researchMarkdown, /Competitors are cited via g2\.com, trustradius\.com; Notewell isn't\./);
  assert.match(researchMarkdown, /assistant review is ready to evaluate these receipts/);
  assert.match(researchMarkdown, /g2\.com: 1 sample \(1 final citation\) · sample IDs s2/);
  assert.match(researchMarkdown, /trustradius\.com: 1 sample \(retrieved source\) · sample IDs s2/);
  assert.doesNotMatch(researchMarkdown, /## Prioritized improvements\s*$/);

  // Study report with empty recommendations and empty analyses after a repeat collection run
  const studyReport = deriveStudyReport({
    version: 1,
    studyId: 'study-repeat-1',
    appId: 'notewell',
    plan: {
      id: 'plan-repeat',
      app: { id: 'notewell', name: 'Notewell', url: 'https://notewell.example/' },
      targetUrl: 'https://notewell.example/pricing',
      comparison: { design: 'before_after', referenceUrl: null },
      angles: [{ id: 'a1', label: 'SOC 2 compliance' }],
      questions: [{ id: 'q2', angleId: 'a1', text: 'What AI note takers have SOC 2 controls for sales teams?' }],
      collection: {},
    },
    searchRuns: [
      {
        lane: 'collection',
        records: [
          {
            questionId: 'q2',
            angleId: 'a1',
            query: 'What AI note takers have SOC 2 controls for sales teams?',
            status: 'completed',
            results: [{ url: 'https://www.capterra.com/p/fireflies/', title: 'Fireflies on Capterra', content: 'SOC 2' }],
          },
        ],
      },
    ],
    researchRuns: [{ bundle }],
    events: [{ type: 'occurrence_completed', occurrenceId: 'occ-2', status: 'completed', analysisDue: true }],
    approvals: [{ id: 'app-1', planId: 'plan-repeat', status: 'approved' }],
    outcomes: [],
    analyses: [],
  });
  assert.equal(studyReport.citationGaps.recommendationCount, 0);
  assert.deepEqual(
    studyReport.citationGaps.domains.map((d) => d.domain),
    ['g2.com', 'capterra.com', 'trustradius.com'],
  );
  assert.match(studyReport.markdown, /## Observed Citation Gaps & Next-Step Status/);
  assert.match(studyReport.markdown, /Competitors are cited via g2\.com, capterra\.com, trustradius\.com; Notewell isn't\./);
  assert.match(studyReport.markdown, /assistant review is ready to evaluate these receipts/);
  assert.match(studyReport.markdown, /g2\.com: 1 observation \(1 final citation\)/);
  assert.match(studyReport.markdown, /capterra\.com: 1 observation/);

  // Verify Opportunities & Weekly Review pages surface Citation-Gap Action Cards AND Keep/Hold summary
  const db = openDb(':memory:');
  t.after(() => db.close());
  importResearch(db, bundle);

  const oppViewWithGap = opportunitiesPage.buildView({ db }, new URLSearchParams());
  const oppHtmlWithGap = opportunitiesPage.render(SHELL_CTX, oppViewWithGap);
  assert.match(oppHtmlWithGap, /Citation-gap &amp; repeat-run next steps/);
  assert.match(oppHtmlWithGap, /Competitors are cited via g2\.com, trustradius\.com; Notewell isn&#39;t\./);

  const weeklyGapView = weeklyReviewPage.buildView(
    { db },
    new URLSearchParams({ series_id: `research:${bundle.runId}`, start: REVIEW_START, end: REVIEW_END }),
  );
  const weeklyGapHtml = weeklyReviewPage.render(SHELL_CTX, weeklyGapView);
  assert.match(weeklyGapHtml, /Competitors are cited via g2\.com, trustradius\.com; Notewell isn&#39;t\./);

  // Also verify explicit Keep / hold summary when brand is present in all completed samples
  const allPresentBundle = makeResearchBundle({
    runId: 'probe-run-hold',
    evidence: bundle.evidence.filter((e) => e.sampleId !== 's2'),
    samples: [bundle.samples[0]],
    recommendations: [],
  });
  importResearch(db, allPresentBundle);
  const holdWeeklyView = weeklyReviewPage.buildView(
    { db },
    new URLSearchParams({ series_id: 'research:probe-run-hold', start: REVIEW_START, end: REVIEW_END }),
  );
  const holdWeeklyHtml = weeklyReviewPage.render(SHELL_CTX, holdWeeklyView);
  assert.match(holdWeeklyHtml, /Keep \/ hold: Notewell appeared in all 1 completed sample/);
  const oppHtmlWithHold = opportunitiesPage.render(SHELL_CTX, opportunitiesPage.buildView({ db }, new URLSearchParams()));
  assert.match(oppHtmlWithHold, /Keep \/ hold: Notewell appeared in all 1 completed sample/);
});

test('Migration v17 -> v18 preserves existing outcome hashes, creates backup, escapes HTML, and blocks overlapping arm double-counts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-v17-v18-'));
  const dbPath = join(dir, 'hearsay.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Build an authentic v17 database before running v18 migration
  const v17Db = new DatabaseSync(dbPath);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 17)) {
    if (migration.version === 2) v17Db.exec('PRAGMA foreign_keys = OFF');
    v17Db.exec('BEGIN');
    if (typeof migration.apply === 'function') migration.apply(v17Db);
    else v17Db.exec(String(migration.sql));
    v17Db.exec(`PRAGMA user_version = ${migration.version}`);
    v17Db.exec('COMMIT');
    if (migration.version === 2) v17Db.exec('PRAGMA foreign_keys = ON');
  }
  assert.equal(userVersion(v17Db), 17);
  v17Db.close();

  const db = openDb(dbPath);
  assert.equal(userVersion(db), 18);
  assert.equal(MIGRATIONS.at(-1)?.version, 18);
  const backups = readdirSync(dir).filter((name) => /\.v17\.db$/.test(name));
  assert.equal(backups.length, 1);

  const legacy = recordOutcome(db, {
    source: 'analytics',
    recordKey: 'legacy-row',
    periodStart: BASELINE_START,
    periodEnd: BASELINE_END,
    metricName: 'qualified_leads',
    value: '5',
    unit: 'count',
    attributionMethod: 'direct',
    author: 'owner',
    now: NOW,
  });
  // Idempotent replay without action-link fields succeeds
  assert.equal(recordOutcome(db, {
    source: 'analytics',
    recordKey: 'legacy-row',
    periodStart: BASELINE_START,
    periodEnd: BASELINE_END,
    metricName: 'qualified_leads',
    value: '5',
    unit: 'count',
    attributionMethod: 'direct',
    author: 'owner',
    now: NOW,
  }).id, legacy.id);

  // Overlapping records inside the same arm are withheld from summing rather than double-counted
  recordOutcome(db, {
    source: 'analytics',
    recordKey: 'ov-1',
    periodStart: '2026-09-08T00:00:00Z',
    periodEnd: '2026-09-12T00:00:00Z',
    metricName: 'qualified_leads',
    value: '4',
    unit: 'count',
    attributionMethod: 'direct',
    interventionId: '<script>alert(1)</script>',
    comparisonPage: 'https://example.test/<img src=x onerror=alert(1)>',
    pageRole: 'changed',
    author: 'owner',
    now: NOW,
  });
  recordOutcome(db, {
    source: 'analytics',
    recordKey: 'ov-2',
    periodStart: '2026-09-10T00:00:00Z',
    periodEnd: '2026-09-15T00:00:00Z',
    metricName: 'qualified_leads',
    value: '6',
    unit: 'count',
    attributionMethod: 'direct',
    interventionId: '<script>alert(1)</script>',
    pageRole: 'changed',
    author: 'owner',
    now: NOW,
  });
  const overlapResult = compareControlledPageOutcomes(
    listOutcomeRecords(db, { interventionId: '<script>alert(1)</script>' }),
    { interventionId: '<script>alert(1)</script>', postStart: REVIEW_START, postEnd: REVIEW_END },
  );
  assert.equal(overlapResult.items[0].status, 'overlap_blocked');
  assert.equal(overlapResult.items[0].changed.post, null);
  assert.equal(overlapResult.items[0].changed.hasOverlap, true);

  // Verify XSS escaping on new fields in Weekly Review HTML
  importResearch(db, makeResearchBundle());
  const view = weeklyReviewPage.buildView(
    { db },
    new URLSearchParams({ series_id: 'research:probe-run-1', start: REVIEW_START, end: REVIEW_END }),
  );
  const renderedHtml = weeklyReviewPage.render(SHELL_CTX, view);
  assert.doesNotMatch(renderedHtml, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(renderedHtml, /<img src=x onerror=alert\(1\)>/);
  assert.match(renderedHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  db.close();
});
