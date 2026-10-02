import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from '../core/research-workspace.js';
import { createStudy } from '../core/study-workspace.js';

export const STUDY_TIME = '2026-10-02T08:00:00.000Z';

export function studyPlan(overrides = {}) {
  const app = { id: 'drip-score', name: 'Drip Score', url: 'https://drip.example/', aliases: [], audience: 'People choosing outfits', useCases: ['Get outfit feedback'] };
  return {
    version: 1, id: 'plan-1', studyId: 'outfit-study', app,
    targetUrl: app.url,
    comparison: { design: 'unchanged_reference', referenceUrl: 'https://drip.example/reference', assignment: null, trafficNotes: 'Record eligible visits to both pages.' },
    outcome: { metric: 'qualified_leads', unit: 'count', minimumDenominator: 100, minimumObservations: 10, minimumEffect: 0.1, lossLimit: 0.1, reviewPeriodDays: 7, stopRules: ['Stop if the approved loss limit is reached.'] },
    angles: [
      { id: 'outfit-scoring', label: 'Outfit scoring', buyerJob: 'Rate an outfit', rationale: 'The product rates outfit photos.', evidenceIds: ['product-evidence'], questionIds: ['q1', 'q2'] },
      { id: 'outfit-feedback', label: 'Outfit feedback', buyerJob: 'Get useful outfit feedback', rationale: 'The product gives photo feedback.', evidenceIds: ['product-evidence'], questionIds: ['q3', 'q4'] },
      { id: 'outfit-advice', label: 'Outfit advice', buyerJob: 'Improve an outfit', rationale: 'The product suggests improvements.', evidenceIds: ['product-evidence'], questionIds: ['q5', 'q6'] },
    ],
    questions: [
      { id: 'q1', angleId: 'outfit-scoring', text: 'Which apps can rate an outfit from a photo?' },
      { id: 'q2', angleId: 'outfit-scoring', text: 'Where can I get a score for an outfit photo?' },
      { id: 'q3', angleId: 'outfit-feedback', text: 'Which apps provide feedback on an outfit?' },
      { id: 'q4', angleId: 'outfit-feedback', text: 'Where can I find useful feedback on how my clothes look?' },
      { id: 'q5', angleId: 'outfit-advice', text: 'Which apps suggest how to improve an outfit?' },
      { id: 'q6', angleId: 'outfit-advice', text: 'Where can I get clothing advice from an outfit photo?' },
    ],
    collection: { at: '09:00', timezone: 'UTC', occurrences: 30, maxDays: 30, firstReviewDays: 1, reviewEveryDays: 7 },
    tavily: { enabled: false, accountId: null, searchDepth: 'basic', maxResults: 5, collectionCredits: 180, diagnosticCredits: 20, allowance: 200, strictFreeMode: true },
    permissions: { actions: ['capture', 'collect', 'draft'], repository: null, publishTarget: null },
    reportDestination: { kind: 'local', path: 'reviews' }, research: null,
    ...overrides,
  };
}

export function studyProject() {
  const project = JSON.parse(readFileSync(new URL('../skill/templates/project.json', import.meta.url), 'utf8'));
  const plan = studyPlan();
  project.app = plan.app;
  project.discoveryEvidence = [{ id: 'product-evidence', type: 'fetched_page', timestamp: STUDY_TIME, origin: 'host_research', capture: 'host_reported', sampleId: null, data: { url: plan.targetUrl, text: 'Rates outfits, offers feedback and advice.' } }];
  project.panels[0].questions = plan.questions.map(({ id, text }) => ({ id, text }));
  project.panels[0].reviewedAt = STUDY_TIME;
  return project;
}

export async function studyFixture(t, overrides = {}) {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'hearsay-study-'));
  t.after(() => rmSync(projectDirectory, { recursive: true, force: true }));
  const project = studyProject();
  const plan = studyPlan(overrides);
  writeJson(join(projectDirectory, 'project.json'), project);
  const created = await createStudy(projectDirectory, plan);
  return { projectDirectory, directory: created.studyDirectory, studyDirectory: created.studyDirectory, project, plan, manifest: created.manifest };
}
