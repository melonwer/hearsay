import { listEvidenceIntents } from '../../core/evidence-report.js';
import { listMeasurementSeries, resolveMeasurementSeries } from '../../core/metrics.js';
import { deriveOpportunityCandidates, listOpportunities } from '../../core/opportunities.js';
import { emptyState, html, layout, raw, SURFACE_LABEL } from '../layout.js';

/** @param {string|null} value */
function positiveInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** @param {string|null} value */
function utcTime(value) {
  return value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

/** @param {ReturnType<typeof buildView>} view @param {Record<string, string|number|null>} [patch] */
function selectionUrl(view, patch = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    days: view.days, series_id: view.series?.id ?? null, start: view.series?.start ?? null,
    end: view.series?.end ?? null, intent_id: view.intentId, ...patch,
  })) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  return `/opportunities?${params}`;
}

/** @param {import('./index.js').PageDeps} deps @param {URLSearchParams} params */
export function buildView({ db }, params) {
  const now = new Date();
  const requestedDays = positiveInt(params.get('days'));
  const days = requestedDays !== null && requestedDays <= 3650 ? requestedDays : 30;
  const requestedStart = utcTime(params.get('start'));
  const requestedEnd = utcTime(params.get('end'));
  const exactRange = requestedStart && requestedEnd && requestedStart < requestedEnd
    ? { start: requestedStart, end: requestedEnd } : {};
  const seriesOptions = listMeasurementSeries(db, { now, days, ...exactRange });
  const requestedSeriesId = params.get('series_id');
  const series = requestedSeriesId
    ? seriesOptions.find((item) => item.id === requestedSeriesId) ?? null
    : resolveMeasurementSeries(db, { now, days, ...exactRange });
  const intents = series ? listEvidenceIntents(db, { series }) : [];
  const requestedIntentId = positiveInt(params.get('intent_id'));
  const intentId = requestedIntentId !== null && intents.some((intent) => intent.id === requestedIntentId)
    ? requestedIntentId : intents[0]?.id ?? null;
  const candidates = series && intentId !== null
    ? deriveOpportunityCandidates(db, { series, intentId }) : [];
  const opportunities = series ? listOpportunities(db, { series, includeDismissed: true }) : [];
  const selected = opportunities.filter((item) => intentId === null || item.intentId === intentId);
  return {
    days, seriesOptions, series, intents, intentId, candidates, opportunities: selected,
    prefill: {
      responseIds: params.get('response_ids') ?? '', queryIds: params.get('query_ids') ?? '',
      sourceIds: params.get('source_ids') ?? '', citationIds: params.get('citation_ids') ?? '',
    },
  };
}

/** @param {ReturnType<typeof buildView>} view */
function selector(view) {
  return html`<form class="card opportunity-filters" method="get" action="/opportunities">
    <label><span>Measurement series</span><select name="series_id" required>
      ${view.seriesOptions.map((item) => html`<option value="${item.id}"${item.id === view.series?.id ? raw(' selected') : ''}>
        ${SURFACE_LABEL[item.surface] ?? item.surface} · ${item.searchPolicy ?? 'legacy'} · ${item.comparableAnswers} comparable
      </option>`)}
    </select></label>
    <label><span>Buyer intent</span><select name="intent_id">
      ${view.intents.map((item) => html`<option value="${item.id}"${item.id === view.intentId ? raw(' selected') : ''}>${item.label ?? `Intent #${item.id}`}</option>`)}
    </select></label>
    <label><span>Window</span><select name="days">
      ${[7, 30, 90, 365].map((count) => html`<option value="${count}"${count === view.days ? raw(' selected') : ''}>${count} days</option>`)}
    </select></label>
    <button type="submit" class="btn">Show opportunities</button>
  </form>`;
}

/** @param {ReturnType<typeof buildView>} view */
function selectionFields(view) {
  return html`<input type="hidden" name="series_id" value="${view.series?.id}" />
    <input type="hidden" name="start" value="${view.series?.start}" />
    <input type="hidden" name="end" value="${view.series?.end}" />
    <input type="hidden" name="intent_id" value="${view.intentId}" />`;
}

/** @param {string} type */
function candidateLabel(type) {
  return ({ source_without_brand: 'Source without brand', query_theme: 'Buyer search theme',
    negative_brand_statement: 'Negative brand statement',
    uncertain_brand_statement: 'Uncertain brand statement' })[type] ?? type;
}

/** @param {ReturnType<typeof buildView>} view @param {{responseIds:number[],queryIds:number[],sourceIds:number[],citationIds:number[],stanceReviews?:{responseId:number,mentionId:number,interpretationId:number,correctionId:number|null,stance:string}[]}} evidence */
function support(view, evidence) {
  const receipts = evidence.responseIds ?? [];
  return html`<details class="opportunity-support"><summary>${receipts.length} answer receipt${receipts.length === 1 ? '' : 's'} and record IDs</summary>
    ${receipts.length ? html`<ul>${receipts.map((id) => html`<li><a href="/evidence?${new URLSearchParams({
      series_id: view.series?.id ?? '', start: view.series?.start ?? '', end: view.series?.end ?? '',
      intent_id: String(view.intentId ?? ''), layer: 'answers', receipt_id: String(id), days: String(view.days),
    })}#receipt-${id}">Answer receipt #${id}</a></li>`)}</ul>` : html`<p>No answer receipt is attached.</p>`}
    <p class="muted small">Query IDs: ${(evidence.queryIds ?? []).join(', ') || 'none'} · Source observation IDs: ${(evidence.sourceIds ?? []).join(', ') || 'none'} · Citation IDs: ${(evidence.citationIds ?? []).join(', ') || 'none'}</p>
    ${evidence.stanceReviews?.length ? html`<p class="muted small">Stance review receipts: ${evidence.stanceReviews.map((item) => `answer #${item.responseId}, mention #${item.mentionId}, interpretation #${item.interpretationId}, correction #${item.correctionId ?? 'none'}, ${item.stance}`).join(' · ')}</p>` : ''}
  </details>`;
}

/** @param {ReturnType<typeof buildView>} view */
function candidateSection(view) {
  const available = view.candidates.filter((item) => !item.existingOpportunityId || item.newResponseIds?.length);
  return html`<section class="card">
    <div class="opportunity-section-head"><div><h2>Observed patterns to review</h2>
      <p class="muted">Repeated source and query-theme patterns need two comparable answer receipts from two completed runs in this exact selection. Explicit negative or uncertain statements can appear from one completed answer. The threshold helps triage; it does not measure importance. Save only the investigations you want to review.</p></div>
    </div>
    ${available.length ? html`<div class="opportunity-list">${available.map((item) => html`<article class="opportunity-preview">
      <div class="opportunity-topline"><span class="tag">${candidateLabel(item.candidateType)}</span><span class="muted small">${item.support.responseCount} answers across ${item.support.completedRunCount} runs</span></div>
      <h3>${item.observedFinding}</h3>
      <p class="muted">Suggested next step: investigate. Check the source and page before planning a change.</p>
      ${support(view, item.evidence)}
      ${item.existingOpportunityId && item.newResponseIds?.length ? html`<p class="muted small">New since the previous review: response #${item.newResponseIds.join(', #')}. ${item.resurfacedExplanation ?? ''}</p>` : ''}
      <form data-api-form="/api/opportunities/generate" class="opportunity-save">
        ${selectionFields(view)}<input type="hidden" name="candidate_key" value="${item.candidateKey}" />
        <button type="submit" class="btn btn-sm">Save this investigation</button>
        <p class="form-error" data-form-error role="alert" hidden></p>
      </form>
    </article>`)}</div>` : html`<p class="muted">No new pattern qualifies for this selection. You can create an investigation from a single receipt below.</p>`}
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view */
function manualForm(view) {
  return html`<section class="card"><h2>Create an investigation from selected evidence</h2>
    <p class="muted">Use the links on <a href="/evidence?${new URLSearchParams({
      series_id: view.series?.id ?? '', start: view.series?.start ?? '', end: view.series?.end ?? '',
      intent_id: String(view.intentId ?? ''), days: String(view.days),
    })}">the evidence report</a> to prefill IDs. Every record must belong to this exact series, intent, and window. A model leaving a capability out does not show that a page lacks it.</p>
    <form data-api-form="/api/opportunities" class="opportunity-form">
      ${selectionFields(view)}
      <div class="opportunity-form-grid">
        <label><span>Answer receipt IDs</span><input name="response_ids" data-list value="${view.prefill.responseIds}" placeholder="42, 51" required /></label>
        <label><span>Observed query IDs</span><input name="query_ids" data-list value="${view.prefill.queryIds}" placeholder="Optional" /></label>
        <label><span>Source observation IDs</span><input name="source_ids" data-list value="${view.prefill.sourceIds}" placeholder="Optional" /></label>
        <label><span>Final-answer citation IDs</span><input name="citation_ids" data-list value="${view.prefill.citationIds}" placeholder="Optional" /></label>
        <label><span>Buyer relevance</span><input name="buyer_relevance" maxlength="240" placeholder="Why this matters to the selected buyer intent" /></label>
        <label><span>Product area</span><input name="product_area" maxlength="160" placeholder="Optional" /></label>
        <label><span>Target URL</span><input name="target_url" type="url" placeholder="Optional" /></label>
        <label><span>Controllability</span><select name="controllability"><option value="product">Product</option><option value="owned">Owned page</option><option value="third_party">Third party</option></select></label>
        <label><span>Effort</span><select name="effort_band"><option value="unknown">Unknown</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      </div>
      <label><span>Interpretation or hypothesis</span><textarea name="hypothesis" rows="2" maxlength="2000" placeholder="Your interpretation, separate from the observed evidence"></textarea></label>
      <label><span>Possible action</span><textarea name="suggested_action" rows="2" maxlength="2000" placeholder="Investigate the answer or source; specific page changes need reviewed page evidence"></textarea></label>
      <label class="check"><input name="claimed_false_or_outdated" type="checkbox" /><span>The answer may contain a false or outdated claim that needs authoritative evidence</span></label>
      <button type="submit" class="btn">Save investigation</button>
      <p class="form-error" data-form-error role="alert" hidden></p>
    </form>
  </section>`;
}

/** @param {ReturnType<typeof buildView>} view @param {ReturnType<typeof listOpportunities>[number]} item */
function opportunityCard(view, item) {
  const evidence = item.evidence ?? { responseIds: [], queryIds: [], sourceIds: [], citationIds: [] };
  const pageEvidence = item.pageEvidence ?? [];
  const reviewedPage = pageEvidence.some((entry) => entry.reviewedAt);
  const otherItems = view.opportunities.filter((other) => other.id !== item.id && other.status !== 'dismissed');
  return html`<article class="card opportunity-card" id="opportunity-${item.id}">
    <div class="opportunity-topline"><span class="tag">${item.status}</span>
      <span class="muted small">#${item.id} · ${item.origin} · ${item.createdAt}</span></div>
    <h3>${item.observedFinding}</h3>
    <p class="muted small">${item.candidateType ?? 'manual selection'} · benchmark ${item.benchmarkRevisionId ?? 'legacy'} · ${item.windowStart} to ${item.windowEnd} UTC, end exclusive</p>
    ${item.buyerRelevance ? html`<p><strong>Buyer relevance:</strong> ${item.buyerRelevance}</p>` : ''}
    ${item.hypothesis ? html`<p><strong>${item.origin === 'assistant' ? 'Assistant hypothesis' : 'Hypothesis'}:</strong> ${item.hypothesis}</p>` : ''}
    ${item.suggestedAction ? html`<p><strong>Possible action (${item.actionKind ?? 'investigate'}):</strong> ${item.suggestedAction}</p>` : ''}
    ${item.targetUrl || item.productArea ? html`<p class="muted">Target: ${item.targetUrl ?? item.productArea}</p>` : ''}
    ${item.claimClassification ? html`<p class="muted">Claim handling: ${item.claimClassification}</p>` : ''}
    ${item.missingEvidence?.length ? html`<p class="muted">Still needed: ${item.missingEvidence.join('; ')}</p>` : ''}
    ${item.staleEvidence ? html`<p class="form-error">Some linked evidence is missing. Recheck the receipt before review.</p>` : ''}
    ${item.resurfacedExplanation ? html`<p class="muted">Resurfaced because ${item.resurfacedExplanation}</p>` : ''}
    ${support(view, evidence)}
    <div class="opportunity-review-grid">
      <details><summary>Review and prioritize</summary>
        <form data-api-form="/api/opportunities/${item.id}" data-method="PATCH" class="opportunity-form">
          <div class="opportunity-form-grid">
            <label><span>Outcome</span><select name="status">
              ${['investigate', 'planned', 'dismissed', 'no_action'].map((status) => html`<option value="${status}"${item.status === status ? raw(' selected') : ''}>${status.replace('_', ' ')}</option>`)}
            </select></label>
            <label><span>User priority</span><select name="priority">
              ${[[0, 'Unset'], [3, 'High'], [2, 'Medium'], [1, 'Low']].map(([value, label]) => html`<option value="${value}"${item.priority === value ? raw(' selected') : ''}>${label}</option>`)}
            </select></label>
            <label><span>Effort</span><select name="effort_band">
              ${['unknown', 'low', 'medium', 'high'].map((effort) => html`<option value="${effort}"${item.effortBand === effort ? raw(' selected') : ''}>${effort}</option>`)}
            </select></label>
            <label><span>Owner</span><input name="owner" value="${item.owner ?? ''}" maxlength="120" data-include-empty /></label>
            <label><span>Review date</span><input name="review_date" type="date" value="${item.reviewDate ?? ''}" data-include-empty /></label>
            <label><span>Target URL</span><input name="target_url" type="url" value="${item.targetUrl ?? ''}" data-include-empty /></label>
            <label><span>Product area</span><input name="product_area" value="${item.productArea ?? ''}" maxlength="160" data-include-empty /></label>
            <label><span>Action type</span><select name="action_kind">
              ${[['investigate', 'Investigate'], ['page_change', 'Specific page change'], ['other', 'Other action']].map(([value, label]) => html`<option value="${value}"${(item.actionKind ?? 'investigate') === value ? raw(' selected') : ''}>${label}</option>`)}
            </select></label>
            <label><span>Controllability</span><select name="controllability">
              ${['product', 'owned', 'third_party'].map((value) => html`<option value="${value}"${item.controllability === value ? raw(' selected') : ''}>${value.replace('_', ' ')}</option>`)}
            </select></label>
          </div>
          <label><span>Hypothesis</span><textarea name="hypothesis" rows="2" maxlength="2000" data-include-empty>${item.hypothesis ?? ''}</textarea></label>
          <label><span>Possible action</span><textarea name="suggested_action" rows="2" maxlength="2000" data-include-empty>${item.suggestedAction ?? ''}</textarea></label>
          <label><span>Reason when dismissing or choosing no action</span><textarea name="dismissal_reason" rows="2" maxlength="1000" data-include-empty>${item.dismissalReason ?? ''}</textarea></label>
          ${item.origin === 'assistant' && item.status === 'pending' ? html`<p class="muted">Accepting this assistant proposal is a separate human review. It does not publish or start a run.</p>` : ''}
          ${!reviewedPage ? html`<p class="muted">For a specific page change, attach and review page evidence first. The next step remains an investigation until then.</p>` : ''}
          <button type="submit" class="btn">Save review</button>
          <p class="form-error" data-form-error role="alert" hidden></p>
        </form>
      </details>
      <details><summary>Page evidence (${pageEvidence.length})</summary>
        <p class="muted">A manual excerpt records what you or an assistant supplied. It is separate from provider-observed retrieval.</p>
        ${pageEvidence.map((entry) => html`<div class="opportunity-page-evidence">
          <p>${entry.url} · ${entry.observedAt} · ${entry.provenance}${entry.isAuthoritative ? html` · user marked authoritative` : ''}${entry.reviewedAt ? html` · reviewed ${entry.reviewedAt}` : ''}</p>
          <blockquote>${entry.excerpt}</blockquote>
          ${entry.reviewedAt ? '' : html`<form data-api-form="/api/opportunities/${item.id}/page-evidence/${entry.id}/review">
            <input type="hidden" name="reviewed" value="true" data-bool />
            <button type="submit" class="btn btn-sm">I reviewed this excerpt</button>
            <p class="form-error" data-form-error role="alert" hidden></p>
          </form>`}
        </div>`)}
        <form data-api-form="/api/opportunities/${item.id}/page-evidence" class="opportunity-form">
          <label><span>Page URL</span><input name="url" type="url" required /></label>
          <label><span>Observation time, UTC</span><input name="observed_at" type="text" placeholder="2026-09-25T12:00:00Z" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" required /></label>
          <label><span>Source</span><select name="provenance"><option value="manual_user">I supplied the excerpt</option><option value="manual_assistant">Assistant supplied the excerpt</option><option value="observed_fetch">Already observed fetch</option></select></label>
          <label class="check"><input name="is_authoritative" type="checkbox" /><span>I assert this user-supplied excerpt is authoritative for the claim</span></label>
          <label><span>Observed fetch source ID, if selected</span><input name="source_observation_id" type="number" min="1" placeholder="For observed fetch only" /></label>
          <label><span>Bounded excerpt</span><textarea name="excerpt" rows="3" maxlength="2000" required></textarea></label>
          <button type="submit" class="btn btn-sm">Attach page evidence</button>
          <p class="form-error" data-form-error role="alert" hidden></p>
        </form>
      </details>
      ${otherItems.length ? html`<details><summary>Combine with another opportunity</summary>
        <p class="muted">The selected record is combined into this one. Its receipts and review history remain linked.</p>
        <form data-api-form="/api/opportunities/${item.id}/combine" class="opportunity-form">
          <label><span>Combine record</span><select name="source_id">${otherItems.map((other) => html`<option value="${other.id}">#${other.id} · ${other.observedFinding}</option>`)}</select></label>
          <button type="submit" class="btn btn-sm">Combine</button>
          <p class="form-error" data-form-error role="alert" hidden></p>
        </form>
      </details>` : ''}
    </div>
    ${item.events?.length ? html`<details class="opportunity-history"><summary>Review history (${item.events.length})</summary>
      <ul>${item.events.map((entry) => html`<li>${entry.createdAt} · ${entry.eventType} · ${entry.author}${entry.eventType === 'combined_source' ? html` · source opportunity #${entry.details.sourceId}` : ''}${entry.eventType === 'combined' ? html` · combined into #${entry.details.targetId}` : ''}</li>`)}</ul>
    </details>` : ''}
  </article>`;
}

/** @param {import('../layout.js').ShellCtx} ctx @param {ReturnType<typeof buildView>} view */
export function render(ctx, view) {
  let body = html`<p class="muted">Review observed evidence, choose a next step, and record who owns it. These entries are hypotheses and decisions, not claims about how an engine ranks pages.</p>${selector(view)}`;
  if (!view.series || view.intentId === null) {
    body = html`${body}${emptyState({ title: 'No evidence for this selection',
      line: 'Choose a measurement series and buyer intent with completed comparable answers.',
      hint: 'Opportunities become available after a panel run stores answer receipts.' })}`;
  } else {
    const pending = view.opportunities.filter((item) => item.status === 'pending');
    const active = view.opportunities.filter((item) => !['pending', 'dismissed', 'no_action', 'combined'].includes(item.status));
    const closed = view.opportunities.filter((item) => ['dismissed', 'no_action', 'combined'].includes(item.status));
    body = html`${body}
      <p class="muted opportunity-scope">Exact series ${view.series.id} · ${SURFACE_LABEL[view.series.surface] ?? view.series.surface} · benchmark ${view.series.benchmarkRevisionId ?? 'legacy'} · ${view.series.start} to ${view.series.end} UTC, end exclusive</p>
      ${candidateSection(view)}
      ${pending.length ? html`<section aria-label="Pending assistant proposals"><h2>Pending assistant proposals</h2>
        <p class="muted">These are assistant-authored hypotheses. Review and accept one before it joins the shortlist.</p>
        ${pending.map((item) => opportunityCard(view, item))}
      </section>` : ''}
      <section aria-label="Opportunity shortlist"><h2>Shortlist</h2>
        <p class="muted">Order follows user priority, then effort and recent activity. No hidden score is used.</p>
        ${active.length ? active.map((item) => opportunityCard(view, item)) : html`<p class="card">No saved opportunities for this intent and window.</p>`}
      </section>
      ${manualForm(view)}
      ${closed.length ? html`<details class="card"><summary>Dismissed, combined, or no action (${closed.length})</summary>
        ${closed.map((item) => opportunityCard(view, item))}
      </details>` : ''}`;
  }
  return layout({ title: 'Opportunities', active: '/opportunities', ctx, body });
}
