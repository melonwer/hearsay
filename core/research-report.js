import { canonicalJson, sampleEligibility, summarizeEvidence } from './research-contract.js';
/** @typedef {import('./research-contract.js').ResearchRecord} Record */
/** @param {unknown} value */
const md = (value) => String(value ?? 'unavailable').replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');

/** @param {string} value */
const link = (value) => encodeURI(value).replace(/[()\[\]<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** @param {unknown} rawUrl */
function domainOf(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Summarize external domains cited or retrieved in completed answers where the brand
 * was absent, plus a concise next-step handoff status when recommendations are empty.
 * @param {Record} bundle
 */
export function summarizeResearchCitationGaps(bundle) {
  const samples = Array.isArray(bundle?.samples) ? bundle.samples : [];
  const evidence = Array.isArray(bundle?.evidence) ? bundle.evidence : [];
  const competitors = Array.isArray(bundle?.panel?.competitors) ? bundle.panel.competitors : [];
  const competitorById = new Map(competitors.map((/** @type {Record} */ c) => [String(c.id), String(c.name ?? c.id)]));
  const byId = new Map(evidence.map((/** @type {Record} */ item) => [item.id, item]));
  const brandId = bundle?.app?.id ?? null;
  const appName = String(bundle?.app?.name ?? bundle?.app?.id ?? 'your site');
  const brandDomain = domainOf(bundle?.app?.url);
  const completed = samples.filter((/** @type {Record} */ sample) => sample?.status === 'completed' && sample?.errorCode === null);
  const absent = completed.filter((/** @type {Record} */ sample) => !Array.isArray(sample.mentions)
    || !sample.mentions.some((/** @type {Record} */ mention) => mention.brandId === brandId && mention.confidence === 'certain'));

  /** @type {Set<string>} */
  const competitorsSeen = new Set();
  /** @type {Map<string, {domain:string,sampleIds:Set<string>,finalSampleIds:Set<string>,urls:Set<string>}>} */
  const domains = new Map();
  for (const sample of absent) {
    for (const mention of Array.isArray(sample.mentions) ? sample.mentions : []) {
      if (mention?.brandId && mention.brandId !== brandId && mention.confidence === 'certain') {
        competitorsSeen.add(competitorById.get(String(mention.brandId)) ?? String(mention.brandId));
      }
    }
    const linkedIds = new Set(Array.isArray(sample.evidenceIds) ? sample.evidenceIds : []);
    const linked = [
      ...[...linkedIds].map((id) => byId.get(id)).filter(Boolean),
      ...evidence.filter((/** @type {Record} */ item) => item.sampleId === sample.id && !linkedIds.has(item.id)),
    ];
    for (const item of linked) {
      if (!['final_citation', 'returned_source', 'fetched_page'].includes(item.type)) continue;
      const domain = domainOf(item.data?.url);
      if (!domain || (brandDomain && (domain === brandDomain || domain.endsWith(`.${brandDomain}`)))) continue;
      let bucket = domains.get(domain);
      if (!bucket) {
        bucket = { domain, sampleIds: new Set(), finalSampleIds: new Set(), urls: new Set() };
        domains.set(domain, bucket);
      }
      bucket.sampleIds.add(String(sample.id));
      if (item.type === 'final_citation') bucket.finalSampleIds.add(String(sample.id));
      if (bucket.urls.size < 3 && typeof item.data?.url === 'string') bucket.urls.add(item.data.url);
    }
  }

  const ranked = [...domains.values()]
    .sort((a, b) => b.finalSampleIds.size - a.finalSampleIds.size
      || b.sampleIds.size - a.sampleIds.size
      || a.domain.localeCompare(b.domain))
    .slice(0, 5)
    .map((bucket) => ({
      domain: bucket.domain,
      sampleCount: bucket.sampleIds.size,
      finalCitationCount: bucket.finalSampleIds.size,
      sampleIds: [...bucket.sampleIds],
      urls: [...bucket.urls],
    }));

  const decision = /** @type {'investigate_citation_gap'|'hold_steady'|'awaiting_samples'} */ (
    ranked.length > 0 || absent.length > 0
      ? 'investigate_citation_gap'
      : completed.length > 0 ? 'hold_steady' : 'awaiting_samples'
  );
  const actionHeadline = ranked.length > 0
    ? `Competitors are cited via ${ranked.map((item) => item.domain).slice(0, 3).join(', ')}; ${appName} isn't.`
    : completed.length > 0 && absent.length === 0
      ? `Keep / hold: ${appName} appeared in all ${completed.length} completed sample${completed.length === 1 ? '' : 's'}.`
      : absent.length > 0
        ? `${appName} was omitted in ${absent.length}/${completed.length} completed sample${completed.length === 1 ? '' : 's'} without external source URLs.`
        : 'No completed answer receipts recorded yet.';

  return {
    completedSamples: completed.length,
    brandAbsentSamples: absent.length,
    competitorsCited: [...competitorsSeen],
    domains: ranked,
    decision,
    actionHeadline,
    nextStepStatus: decision === 'hold_steady'
      ? `No improvement proposals are saved in this run; ${appName} was present across completed answers, so assistant review can confirm holding current pages steady.`
      : 'No improvement proposals are saved in this run; assistant review is ready to evaluate these receipts and propose or skip the next action.',
  };
}

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
  if (bundle.recommendations.length) {
    for (const action of bundle.recommendations) lines.push(`### ${md(action.title)}`, '', `Priority: ${action.priority}. Effort: ${action.effort}. Evidence: ${action.evidenceIds.map(md).join(', ')}.`, '',
      `Hypothesis: ${md(action.hypothesis)}`, '', `Proposed change: ${md(action.proposedChange)}`, '',
      `Repeat questions: ${action.repeatMeasurement.questionIds.map(md).join(', ')}. Supports: ${md(action.repeatMeasurement.supports)}. Rejects: ${md(action.repeatMeasurement.rejects)}.`, '',
      `Draft: ${md(action.draftPath)}. Applying or publishing requires a user request.`, '');
  } else {
    const gaps = summarizeResearchCitationGaps(bundle);
    lines.push('### Observed Citation Gaps & Next-Step Status', '',
      `- Action summary: ${md(gaps.actionHeadline)}`,
      `- Next-step status: ${gaps.nextStepStatus}`);
    if (gaps.domains.length) {
      lines.push(`- Brand-absent completed answers: ${gaps.brandAbsentSamples}/${gaps.completedSamples} completed samples.`,
        `- Top external domains observed when ${md(bundle.app.name)} was absent:`);
      for (const item of gaps.domains) {
        const citationKind = item.finalCitationCount
          ? `${item.finalCitationCount} final citation${item.finalCitationCount === 1 ? '' : 's'}`
          : 'retrieved source';
        lines.push(`  - ${md(item.domain)}: ${item.sampleCount} sample${item.sampleCount === 1 ? '' : 's'} (${citationKind}) · sample IDs ${item.sampleIds.map(md).join(', ')}`);
      }
    } else if (gaps.completedSamples > 0 && gaps.brandAbsentSamples === 0) {
      lines.push(`- Citation gaps: ${md(bundle.app.name)} was mentioned in all ${gaps.completedSamples} completed sample${gaps.completedSamples === 1 ? '' : 's'}; no brand-absent external citation gap observed. Keep current pages steady until the next repeat run.`);
    } else if (gaps.brandAbsentSamples > 0) {
      lines.push(`- Brand-absent completed answers: ${gaps.brandAbsentSamples}/${gaps.completedSamples} completed samples (no external source URLs were captured on those samples).`);
    } else {
      lines.push('- Citation gaps: No completed answer samples were recorded in this run yet.');
    }
    lines.push('');
  }
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
