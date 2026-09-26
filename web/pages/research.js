import { listResearch, getResearch, compareImportedResearch, listResearchActions } from '../../core/research-store.js';
import { html, layout } from '../layout.js';
/** @typedef {import('../../core/research-contract.js').ResearchRecord} Record */

/** @param {ReturnType<typeof getResearch>} selected */
function reportCards(selected) {
  const bundle = selected.bundle;
  return html`<h3>Report</h3><p>${bundle.app.name} visibility report · ${bundle.createdAt}</p>
    <p>Panel ${bundle.panel.id} · execution ${bundle.execution.id} · analysis ${bundle.analysis.id}</p>
    ${bundle.provenance.limitations.map((/** @type {string} */ note) => html`<p class="muted">${note}</p>`)}
    <h4>Competitors</h4>${bundle.panel.competitors.length ? bundle.panel.competitors.map((/** @type {Record} */ competitor) => html`<article class="card">
      <a href="${competitor.url}" rel="noreferrer">${competitor.name}</a> · ${competitor.relationship}
      <p>${competitor.reason}</p><p class="muted small">Evidence: ${competitor.evidenceIds.join(', ')}</p></article>`) : html`<p>No competitors recorded.</p>`}
    <h4>Sample counts</h4>${selected.summary.map((group) => html`<article class="card"><strong>${group.route}</strong><p>Model: ${group.model ?? 'unavailable'} · profile: ${group.profile}</p>
      <p>${group.planned} planned · ${group.attempted} attempted · ${group.completed} completed · ${group.failed} failed · ${group.partial} partial · ${group.skipped} skipped · ${group.unrecorded} unrecorded</p>
      <p>${group.eligible} eligible. Mentions: ${group.eligible ? `${group.mentioned}/${group.eligible}` : 'unavailable'}. Recommendations: ${group.eligible ? `${group.recommended}/${group.eligible}` : 'unavailable'}.</p>
      <p class="muted small">${group.origin} · ${group.capture}</p></article>`)}
    <p>Small samples are exploratory. Failed answers are not brand absences.</p>
    <details class="card"><summary>Report as Markdown</summary><pre class="research-pre">${selected.report}</pre></details>`;
}

/** @param {import('./index.js').PageDeps} deps @param {URLSearchParams} params */
export function buildView({ db }, params) {
  const id = Number(params.get('id'));
  const baseline = Number(params.get('baseline'));
  const runs = listResearch(db, params.get('app_id'));
  const selected = runs.some((row) => Number(row.id) === id) ? getResearch(db, id) : null;
  const comparison = selected && runs.some((row) => Number(row.id) === baseline) ? compareImportedResearch(db, baseline, id) : null;
  return { runs, selected, comparison, actions: listResearchActions(db) };
}
/** @param {ReturnType<typeof listResearchActions>} actions */
export function researchActionCards(actions) {
  if (!actions.length) return html``;
  return html`<section class="research-actions"><h2>Imported research proposals</h2><p>External evidence stays separate from native measurements. Review a proposal before accepting it. Acceptance does not apply or publish a change.</p>
    ${actions.map((action) => html`<article class="card"><h3>${action.recommendation.title}</h3><p>${action.app} · ${action.status} · external provenance</p>
      <p>Hypothesis: ${action.recommendation.hypothesis}</p><p>${action.recommendation.proposedChange}</p>
      <a href="/research?id=${action.research_id}">Review supporting report</a>
      ${action.status === 'proposed' ? html`<form data-research-review="${action.id}"><label>Review reason <input name="reason" required maxlength="2000"></label>
        <label>Decision <select name="status"><option value="accepted">Accept</option><option value="dismissed">Dismiss</option></select></label><button type="submit">Save review</button><p role="status"></p></form>` : html`<p>${action.review_reason}</p>`}
    </article>`)}</section>`;
}
/** @param {import('../layout.js').ShellCtx} ctx @param {ReturnType<typeof buildView>} view */
export function render(ctx, view) {
  const selected = view.selected;
  return layout({ title: 'Research', active: '/research', ctx, body: html`
    <p>Standalone reports retain their original evidence and external provenance. Importing them does not add native provider measurements.</p>
    <form data-research-import class="card"><label>Import evidence.json <input type="file" name="bundle" accept="application/json,.json" required></label><button type="submit">Import report</button><p role="status"></p></form>
    <div class="research-grid"><section><h2>Saved reports</h2>${view.runs.length ? view.runs.map((run) => html`<article class="card"><a href="/research?id=${run.id}">${run.name} · ${run.run_id}</a><p>${run.mode} · ${run.observed_at}</p></article>`) : html`<p>No imported reports. Use the standalone skill to research your app, then import its evidence.json.</p>`}</section>
    ${selected ? html`<section><h2>${selected.bundle.app.name}</h2><p>External provenance · ${selected.bundle.mode} · imported ${selected.importedAt}</p>
      <form method="get" action="/research"><input type="hidden" name="id" value="${selected.id}"><label>Compare baseline <select name="baseline">${view.runs.filter((run) => run.app_id === selected.bundle.app.id && Number(run.id) !== selected.id).map((run) => html`<option value="${run.id}">${run.run_id}</option>`)}</select></label><button>Compare</button></form>
      ${view.comparison ? html`<h3>Comparison</h3><p>${view.comparison.eligible ? 'Comparable observations are available.' : 'These runs do not support a visibility comparison.'}</p>
        ${view.comparison.reasons.map((reason) => html`<p>${reason}</p>`)}
        <details class="card"><summary>Comparison details</summary><pre class="research-pre">${JSON.stringify(view.comparison, null, 2)}</pre></details>` : ''}
      ${reportCards(selected)}
      <h3>Recommendations</h3>${selected.bundle.recommendations.map((/** @type {import('../../core/research-contract.js').ResearchRecord} */ action) => html`<article class="card"><h4>${action.title}</h4><p>Hypothesis: ${action.hypothesis}</p><p>${action.proposedChange}</p><p>Evidence: ${action.evidenceIds.join(', ')} · effort ${action.effort}</p>
        <button type="button" data-research-propose="${selected.id}" data-action-id="${action.id}">Propose in Opportunities</button><p role="status"></p></article>`)}
      <details class="card"><summary>Normalized observations</summary><pre class="research-pre">${JSON.stringify(selected.bundle.evidence, null, 2)}</pre></details>
      <details class="card"><summary>Available trace events</summary><p>Internal reasoning and uncaptured events are unavailable.</p><pre class="research-pre">${selected.bundle.traceEvents?.length ? JSON.stringify(selected.bundle.traceEvents, null, 2) : 'No trace events were included in this bundle.'}</pre></details>
      <details class="card"><summary>Original imported evidence bundle</summary><pre class="research-pre">${JSON.stringify(selected.bundle, null, 2)}</pre></details>
    </section>` : ''}</div>${researchActionCards(view.actions)}` });
}
