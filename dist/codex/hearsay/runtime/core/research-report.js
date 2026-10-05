import { canonicalJson, sampleEligibility, summarizeEvidence } from './research-contract.js';
/** @typedef {import('./research-contract.js').ResearchRecord} Record */
/** @param {unknown} value */
const md = (value) => String(value ?? 'unavailable').replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');

/** @param {string} value */
const link = (value) => encodeURI(value).replace(/[()\[\]<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** @param {Record} bundle */
export function renderResearchReport(bundle) {
  const lines = [`# ${md(bundle.app.name)}: visibility report`, '',
    `Run ${md(bundle.runId)}, ${md(bundle.createdAt)}. ${bundle.mode === 'research_audit' ? 'Research audit' : bundle.mode === 'exploratory' ? 'Exploratory baseline' : 'Tracking panel'}.`, '',
    `Panel ${md(bundle.panel.id)}; execution ${md(bundle.execution.id)}; analysis ${md(bundle.analysis.id)}. Producer: ${md(bundle.provenance.producer)}.`, '',
    'Host reports and external runner captures retain their provenance. Neither is a native dashboard measurement.', '',
    ...bundle.provenance.limitations.map((/** @type {string} */ text) => `- ${md(text)}`), '', '## Competitors', '',
    '| Product | Relationship | Reason | Evidence |', '| --- | --- | --- | --- |',
    ...bundle.panel.competitors.map((/** @type {Record} */ c) => `| [${md(c.name)}](${link(c.url)}) | ${c.relationship} | ${md(c.reason)} | ${c.evidenceIds.map(md).join(', ')} |`), '',
    '## Sample counts', '', '| Route / model / profile / capture | Planned | Attempted | Completed | Failed | Partial | Skipped | Unrecorded | Eligible | Mentioned / eligible | Recommended / eligible |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const g of summarizeEvidence(bundle)) lines.push(`| ${md(g.route)} / ${md(g.model)} / ${md(g.profile)} / ${md(g.capture)} | ${g.planned} | ${g.attempted} | ${g.completed} | ${g.failed} | ${g.partial} | ${g.skipped} | ${g.unrecorded} | ${g.eligible} | ${g.eligible ? `${g.mentioned}/${g.eligible}` : 'unavailable'} | ${g.eligible ? `${g.recommended}/${g.eligible}` : 'unavailable'} |`);
  lines.push('', 'Failed and partial answers are not brand absences. Small samples are exploratory. Account costs and remaining allowances are unknown unless reported.', '', '## Observations', '');
  for (const sample of bundle.samples) {
    const q = bundle.panel.questions.find((/** @type {Record} */ q) => q.id === sample.questionId);
    const eligibility = sampleEligibility(bundle, sample);
    lines.push(`### ${md(sample.id)}: ${md(sample.routeId)}`, '', `Question: ${md(q.text)}`, '',
      `Status: ${md(sample.status)}. Origin: ${md(sample.origin)}. Capture: ${md(sample.capture)}. Model: ${md(sample.model)}.`, '',
      `Independent eligibility: ${eligibility.eligible ? 'eligible' : eligibility.reasons.join(', ')}.`, '');
    for (const m of sample.mentions) lines.push(`- ${md(m.brandId)}: ${m.positive ? 'positive recommendation' : 'mention'}; position ${md(m.position)}; ${md(m.confidence)} mention; stance ${md(m.stance)}. Excerpt: ${md(m.excerpt)} [${md(m.answerId)}]`);
  }
  lines.push('', '## Evidence', '');
  for (const e of bundle.evidence) lines.push(`- ${md(e.id)} (${e.type}, ${e.origin}, ${e.capture}, ${md(e.timestamp)}): ${md(e.data.text ?? e.data.query ?? e.data.title ?? e.data.status ?? '')}${e.data.url ? ` [source](${link(e.data.url)})` : ''}`);
  lines.push('', '## Prioritized improvements', '');
  for (const action of bundle.recommendations) lines.push(`### ${md(action.title)}`, '', `Priority: ${action.priority}. Effort: ${action.effort}. Evidence: ${action.evidenceIds.map(md).join(', ')}.`, '',
    `Hypothesis: ${md(action.hypothesis)}`, '', `Proposed change: ${md(action.proposedChange)}`, '',
    `Repeat questions: ${action.repeatMeasurement.questionIds.map(md).join(', ')}. Supports: ${md(action.repeatMeasurement.supports)}. Rejects: ${md(action.repeatMeasurement.rejects)}.`, '',
    `Draft: ${md(action.draftPath)}. Applying or publishing requires a user request.`, '');
  return `${lines.join('\n')}\n`;
}

/** @param {Record} baseline @param {Record} run */
export function compareResearch(baseline, run) {
  if (canonicalJson(baseline.app) !== canonicalJson(run.app)) return { eligible: false, kind: 'incompatible', reasons: ['different_app_or_identity'], groups: [] };
  const changes = ['panel', 'execution', 'analysis'].filter((key) => canonicalJson(baseline[key]) !== canonicalJson(run[key]));
  const questions = run.panel.questions.filter((/** @type {Record} */ q) => baseline.panel.questions.some((/** @type {Record} */ p) => p.id === q.id && p.text === q.text)).map((/** @type {Record} */ q) => q.id);
  const analysisMatches = canonicalJson(baseline.analysis) === canonicalJson(run.analysis);
  const executionMatches = ['samples', 'timeoutMs', 'idleTimeoutMs', 'maxOutputBytes', 'envelope', 'language', 'location'].every((k) => canonicalJson(baseline.execution[k]) === canonicalJson(run.execution[k]));
  /** @param {Record} sample */
  const key = (sample) => canonicalJson([sample.questionId, sample.routeId, sample.provider, sample.model, sample.profile, sample.capture, sample.origin]);
  const compatibleRoutes = run.execution.routes.filter((/** @type {Record} */ route) => baseline.execution.routes.some((/** @type {Record} */ old) => canonicalJson(old) === canonicalJson(route))).map((/** @type {Record} */ r) => r.id);
  const oldKeys = new Set(baseline.samples.filter((/** @type {Record} */ s) => s.model !== null && compatibleRoutes.includes(s.routeId) && sampleEligibility(baseline, s).eligible).map(key));
  const newKeys = new Set(run.samples.filter((/** @type {Record} */ s) => s.model !== null && compatibleRoutes.includes(s.routeId) && sampleEligibility(run, s).eligible).map(key));
  /** @param {Record} b */
  const subset = (b) => ({ ...b, samples: b.samples.filter((/** @type {Record} */ s) => questions.includes(s.questionId) && oldKeys.has(key(s)) && newKeys.has(key(s))) });
  const usable = analysisMatches && executionMatches && subset(run).samples.length > 0;
  return { eligible: usable, kind: usable ? changes.length ? 'common_subset' : 'matching_revisions' : 'incompatible', changes,
    reasons: usable ? [] : ['No completed eligible common questions with known matching models, profiles and analysis'], questionIds: questions,
    excludedQuestionIds: run.panel.questions.filter((/** @type {Record} */ q) => !questions.includes(q.id)).map((/** @type {Record} */ q) => q.id),
    competitorsChanged: canonicalJson(baseline.panel.competitors) !== canonicalJson(run.panel.competitors),
    baseline: usable ? summarizeEvidence(subset(baseline), { completePanel: false }) : [], run: usable ? summarizeEvidence(subset(run), { completePanel: false }) : [] };
}
