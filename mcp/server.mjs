#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server (§13, SPEC §2/§6). Newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; logs go to stderr. Data comes from a running
 * Hearsay over HTTP at HEARSAY_URL — this process holds no API keys and opens no DB.
 */
import { readFileSync } from 'node:fs';

import { resolveHearsayUrl } from '../core/port-discovery.js';
// [VERIFY-AT-BUILD]: verified 2026-07-26 against modelcontextprotocol.io/specification/versioning
// — current revision is 2025-11-25; earlier revisions remain valid to echo.
const KNOWN_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Whole-request bound for one tools/call: headers AND body. Env override for tests. */
const TIMEOUT_MS = (() => {
  const n = Number(process.env.HEARSAY_MCP_TIMEOUT_MS ?? '');
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const DAYS = { type: 'integer', minimum: 1, maximum: 365, description: 'Reporting window in days (default 30)' };
const UTC_BOUNDARY = { type: 'string', description: 'UTC timestamp YYYY-MM-DDTHH:mm:ssZ; pass start and end together, with end exclusive' };
const SURFACE = {
  type: 'string',
  enum: ['openai-api', 'anthropic-api', 'gemini-api', 'perplexity-api', 'codex-agent', 'claude-code-agent'],
  description: 'Exact measurement surface; API and subscription-agent surfaces are never blended',
};
const SUBSCRIPTION_SURFACES = {
  type: 'array',
  items: { type: 'string', enum: ['codex-agent', 'claude-code-agent'] },
  minItems: 1,
};
const SUBSCRIPTION_LANE = { type: 'string', enum: ['tracking', 'exploration'], default: 'tracking' };
const ENTITY_FIELDS = {
  name: { type: 'string', description: 'Entity name, e.g. "Acme"' },
  aliases: { type: 'array', items: { type: 'string' }, description: 'Other names it goes by (≥3 chars each)' },
  domains: { type: 'array', items: { type: 'string' }, description: 'Domains it owns, e.g. "acme.com"' },
  ambiguous_name: { type: 'boolean', description: 'Flag an ordinary-word brand name for identity review' },
};
/** @param {Record<string, unknown>} properties @param {string[]} [required] */
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
/** @param {Record<string, any>} args @param {string[]} keys @param {Record<string,string>} [rename] */
function query(args, keys, rename = {}) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args?.[key];
    if (value !== undefined && value !== null) params.set(rename[key] ?? key, String(value));
  }
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {boolean} [readOnly]
 * @property {string} description
 * @property {object} inputSchema
 * @property {(args: Record<string, any>) => {method: string, path: string, body?: unknown}} call
 */

/** @type {Tool[]} */
const TOOLS = [
  {
    name: 'hearsay_status',
    readOnly: true,
    description:
      'Check whether the local Hearsay AI-visibility tracker is running and configured: enabled providers (ChatGPT, Claude, Gemini, Perplexity), tracked brand/competitor/prompt counts, last measurement run, schedule, and 30-day computed API usage cost or known subtotal. Call this FIRST for any AI visibility / GEO / AI SEO / brand-monitoring question.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/status' }),
  },
  {
    name: 'hearsay_summary',
    readOnly: true,
    description:
      'Legacy headline AI-visibility numbers for the tracked brand: share of AI voice vs competitors, brand mention rate with 95% confidence interval and n, historical heuristic recommendation rate, per-provider breakdown, open alert count, last run. Use hearsay_stance_rate for a new exact-revision positive-stance rate.',
    inputSchema: obj({ days: DAYS, surface: SURFACE }),
    call: (a) => ({ method: 'GET', path: `/api/summary${query(a, ['days', 'surface'])}` }),
  },
  {
    name: 'hearsay_series_list',
    readOnly: true,
    description: 'List exact measurement series observed in a window, including surface, execution profile, benchmark, analysis revision, search policy, and attempted/comparable/query coverage. Returns the selected default series ID.',
    inputSchema: obj({ days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/series${query(a, ['days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_series_summary',
    readOnly: true,
    description: 'Read headline rates for one exact measurement series. Returns the selected series ID, coverage, positive stance or disclosed legacy method, mention, source, and citation incidence with their denominators.',
    inputSchema: obj({ days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY, series_id: { type: 'string' } }),
    call: (a) => ({ method: 'GET', path: `/api/series/summary${query(a, ['days', 'start', 'end', 'series_id'])}` }),
  },
  {
    name: 'hearsay_series_export',
    readOnly: true,
    description: 'Export answer receipts, stance reviews, and evidence for one exact series and window. Comparable-only mode matches headline answer denominators.',
    inputSchema: obj({ days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY,
      series_id: { type: 'string' }, comparable_only: { type: 'boolean' } }),
    call: (a) => ({ method: 'GET', path: `/api/series/export${query({ ...a,
      eligible: a.comparable_only ? 1 : undefined }, ['days', 'start', 'end', 'series_id', 'eligible'])}` }),
  },
  {
    name: 'hearsay_intent_evidence',
    readOnly: true,
    description: 'Inspect the buyer questions, observed search queries, source observations, final-answer citations, and answer receipts for one intent in an exact measurement series. Query incidence counts distinct answers, and unknown query-to-source associations remain unknown.',
    inputSchema: obj({ series_id: { type: 'string' }, intent_id: { type: 'integer', minimum: 1 },
      days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }, ['intent_id']),
    call: (a) => ({ method: 'GET', path: `/api/series/evidence${query(a,
      ['series_id', 'intent_id', 'days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_answer_evidence',
    readOnly: true,
    description: 'Read the five stored evidence layers for one answer receipt in an exact measurement series, including original wording, search event associations, nullable source links, citations, and capture metadata.',
    inputSchema: obj({ answer_id: { type: 'integer', minimum: 1 }, series_id: { type: 'string' },
      days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }, ['answer_id']),
    call: (a) => ({ method: 'GET', path: `/api/answers/${a.answer_id}/evidence${query(a,
      ['series_id', 'days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_opportunities',
    readOnly: true,
    description: 'Read deterministic opportunity candidates and the reviewed shortlist for one exact measurement series, intent, and UTC window. Findings retain receipt IDs and never trigger a provider call.',
    inputSchema: obj({ series_id: { type: 'string' }, intent_id: { type: 'integer', minimum: 1 },
      days: DAYS, start: UTC_BOUNDARY, end: UTC_BOUNDARY }, ['series_id', 'intent_id', 'start', 'end']),
    call: (a) => ({ method: 'GET', path: `/api/opportunities${query(a,
      ['series_id', 'intent_id', 'days', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_opportunity',
    readOnly: true,
    description: 'Read one saved opportunity with its exact evidence, action history, follow-up plans, baseline snapshots, and review captures. This only reads stored records and never starts a provider run.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1 } }, ['id']),
    call: (a) => ({ method: 'GET', path: `/api/opportunities/${a.id}` }),
  },
  {
    name: 'hearsay_intervention_comparison',
    readOnly: true,
    description: 'Read a descriptive comparison of one saved baseline and review snapshot. Full benchmark is the default; common subset explicitly drops missing prompt cells. Returns counts, coverage, uncertainty intervals, query/source/citation changes, and comparability reasons. It cannot review an action or start a run.',
    inputSchema: obj({ opportunity_id: { type: 'integer', minimum: 1 },
      plan_id: { type: 'integer', minimum: 1 }, snapshot_id: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['full_benchmark', 'common_subset'] } },
    ['opportunity_id', 'plan_id', 'snapshot_id']),
    call: (a) => ({ method: 'GET', path: `/api/opportunities/${a.opportunity_id}/follow-up/${a.plan_id}/reviews/${a.snapshot_id}/comparison${query(a, ['mode'])}` }),
  },
  {
    name: 'hearsay_weekly_review',
    readOnly: true,
    description: 'Read a local seven-day review for one exact historical measurement series and explicit UTC window. Includes collection health, saved evidence and interventions, prioritized work, reported outcomes and costs. Viewing this report does not run providers or claim causation.',
    inputSchema: obj({ series_id: { type: 'string', minLength: 1 }, start: UTC_BOUNDARY,
      end: UTC_BOUNDARY }, ['series_id', 'start', 'end']),
    call: (a) => ({ method: 'GET', path: `/api/weekly-review${query(a, ['series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_opportunity_propose',
    description: 'Save an assistant-authored opportunity proposal from exact scoped answer, query, source, or citation IDs. The server validates every ID and derives observed facts; your hypothesis stays labeled and a human must accept it before it enters the action queue. This never publishes or starts a measurement run.',
    inputSchema: obj({
      series_id: { type: 'string' }, intent_id: { type: 'integer', minimum: 1 },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY,
      evidence: { type: 'array', minItems: 1, items: obj({
        response_id: { type: 'integer', minimum: 1 }, query_id: { type: 'integer', minimum: 1 },
        source_id: { type: 'integer', minimum: 1 }, citation_id: { type: 'integer', minimum: 1 },
      }, ['response_id']) },
      hypothesis: { type: 'string', minLength: 1, maxLength: 2000 },
      suggested_action: { type: 'string', maxLength: 2000 },
      target_url: { type: 'string', maxLength: 2048 },
      product_area: { type: 'string', maxLength: 200 },
      controllability: { type: 'string', enum: ['owned', 'third_party', 'product'] },
      missing_evidence: { type: 'string', maxLength: 1000 },
      claimed_false_or_outdated: { type: 'boolean', description: 'Classify an alleged false or outdated answer claim as verify_claim until the user attaches and reviews authoritative evidence' },
    }, ['series_id', 'intent_id', 'start', 'end', 'evidence', 'hypothesis']),
    call: (a) => ({ method: 'POST', path: '/api/opportunities/propose', body: a }),
  },
  {
    name: 'hearsay_intent_results',
    readOnly: true,
    description:
      'Per-intent mention rates and phrasing spread. Pass series_id for an exact measurement scope; the no-argument response is the older API compatibility view.',
    inputSchema: obj({ days: DAYS, surface: SURFACE, series_id: { type: 'string' },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/intents/results${query(a, ['days', 'surface', 'series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_prompt_results',
    readOnly: true,
    description:
      'Per-prompt mention rates and captured recommendation values. Pass series_id for exact scope. For current corrected stance, use hearsay_series_summary and answer reviews.',
    inputSchema: obj({ days: DAYS, surface: SURFACE, series_id: { type: 'string' },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/prompts/results${query(a, ['days', 'surface', 'series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_answers_search',
    readOnly: true,
    description:
      'Fetch stored AI answer receipts with mention IDs, current effective stance, captured recommendation bit, analysis revision, rule and span, and cited URLs. Pass series_id from hearsay_series_list for an exact measurement scope; comparable_only reconciles with headline answer counts. Paged; limit ≤ 50.',
    inputSchema: obj({
      provider: { type: 'string', enum: ['openai', 'anthropic', 'gemini', 'perplexity'] },
      surface: SURFACE,
      series_id: { type: 'string' },
      comparable_only: { type: 'boolean' },
      entity_id: { type: 'integer', minimum: 1 },
      prompt_id: { type: 'integer', minimum: 1 },
      days: DAYS,
      start: UTC_BOUNDARY,
      end: UTC_BOUNDARY,
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
    call: (a) => ({ method: 'GET', path: `/api/answers${query({ ...a,
      eligible: a.comparable_only ? 1 : undefined },
    ['provider', 'surface', 'series_id', 'eligible', 'entity_id', 'prompt_id', 'days', 'start', 'end', 'page', 'limit'], { limit: 'per' })}` }),
  },
  {
    name: 'hearsay_answer_review',
    readOnly: true,
    description: 'Inspect a stored answer and its immutable stance rule, answer span, analysis revision, correction history, and effective label at an optional correction cutoff. Legacy heuristic values are disclosed separately.',
    inputSchema: obj({ answer_id: { type: 'integer', minimum: 1 }, revision: { type: 'string' }, cutoff: { type: 'integer', minimum: 0 } }, ['answer_id']),
    call: (a) => ({ method: 'GET', path: `/api/answers/${a.answer_id}/review${query(a, ['revision', 'cutoff'])}` }),
  },
  {
    name: 'hearsay_correct_stance',
    description: 'Append a human stance correction with a reason and the last correction ID seen in hearsay_answer_review. The original answer and automatic label remain intact.',
    inputSchema: obj({
      answer_id: { type: 'integer', minimum: 1 }, interpretation_id: { type: 'integer', minimum: 1 },
      previous_correction_id: { type: ['integer', 'null'], minimum: 1 },
      replacement: { type: 'string', enum: ['positive', 'negative', 'neutral', 'uncertain'] },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      request_id: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['answer_id', 'interpretation_id', 'replacement', 'reason', 'request_id']),
    call: (a) => ({ method: 'POST', path: `/api/answers/${a.answer_id}/corrections`, body: {
      interpretation_id: a.interpretation_id, previous_correction_id: a.previous_correction_id ?? null,
      replacement: a.replacement, reason: a.reason, request_id: a.request_id,
    } }),
  },
  {
    name: 'hearsay_stance_rate',
    readOnly: true,
    description: 'Positive-stance rate and negative, neutral, uncertain, and absent counts for an exact surface and capture-time analysis revision at a correction cutoff.',
    inputSchema: obj({ surface: SURFACE, entity_id: { type: 'integer', minimum: 1 }, revision: { type: 'string' },
      comparison_key: { type: 'string' }, cutoff: { type: 'integer', minimum: 0 }, days: DAYS },
      ['surface', 'entity_id', 'revision']),
    call: (a) => ({ method: 'GET', path: `/api/stance-rate${query(a, ['surface', 'entity_id', 'revision', 'comparison_key', 'cutoff', 'days'])}` }),
  },
  {
    name: 'hearsay_citation_gap',
    readOnly: true,
    description:
      'Domains in legacy citation rows for comparable answers without the tracked brand. Pass series_id to limit results to an exact measurement series; source observations and final-answer citations are separate layers in hearsay_series_summary.',
    inputSchema: obj({ days: DAYS, surface: SURFACE, series_id: { type: 'string' },
      start: UTC_BOUNDARY, end: UTC_BOUNDARY }),
    call: (a) => ({ method: 'GET', path: `/api/gap${query(a, ['days', 'surface', 'series_id', 'start', 'end'])}` }),
  },
  {
    name: 'hearsay_alerts',
    readOnly: true,
    description:
      'List AI-visibility alerts: lost/gained recommendations, competitors overtaking share of AI voice, mention-rate drops — each with severity and the underlying numbers. open_only=true (default) shows unacknowledged alerts.',
    inputSchema: obj({ open_only: { type: 'boolean', description: 'Default true' } }),
    call: (a) => ({ method: 'GET', path: `/api/alerts?open=${a?.open_only === false ? '0' : '1'}` }),
  },
  {
    name: 'hearsay_cost_estimate',
    readOnly: true,
    description:
      'Preview exact API targets, route budgets, priced components, and unknown costs before spending anything. The computed estimate uses a checked price table and is not an invoice or a hard dollar cap.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/cost/estimate' }),
  },
  {
    name: 'hearsay_suggest_prompts',
    description:
      'Return five editable buyer intent groups with three complete phrasings each. This is a local, zero-usage draft; no provider key or measurement route is needed. Show the exact wording to the human before tracking.',
    inputSchema: obj({
      audience: { type: 'string', description: 'Who is making the buying decision' },
      product_job: { type: 'string', description: 'Product or job the buyer needs done' },
      desired_conversion: { type: 'string', description: 'Action the buyer should take' },
    }),
    call: (a) => ({ method: 'POST', path: '/api/prompts/suggest', body: {
      context: { audience: a?.audience, productJob: a?.product_job, desiredConversion: a?.desired_conversion },
    } }),
  },
  {
    name: 'hearsay_setup_tracking',
    description:
      'Set up brand, competitors, and buyer questions in one transaction. Only use for exact questions the human reviewed in this conversation; set reviewed=true explicitly. A new draft/review/approval workflow is available through hearsay_create_benchmark_draft, hearsay_review_benchmark_draft, and hearsay_approve_benchmark_draft. No measurement route is needed to draft.',
    inputSchema: obj({
      brand: obj(ENTITY_FIELDS),
      competitors: { type: 'array', items: obj(ENTITY_FIELDS) },
      intents: {
        type: 'array',
        items: obj(
          {
            label: { type: 'string', description: 'The underlying question, e.g. "best AI meeting notes tool"' },
            category: { type: 'string', enum: ['general', 'comparison', 'use-case', 'local', 'pricing', 'branded'] },
            paraphrases: { type: 'array', items: { type: 'string' }, description: 'Phrasings of this question (≥1, ≤300 chars each)' },
          },
          ['label', 'paraphrases'],
        ),
      },
      reviewed: { type: 'boolean', description: 'True only after the human reviewed every exact tracking question' },
    }),
    call: (a) => ({ method: 'POST', path: '/api/setup', body: a ?? {} }),
  },
  {
    name: 'hearsay_create_benchmark_draft',
    description: 'Save a buyer-focused benchmark draft without running or approving it. Include buyer context, optional brand/competitors, intent groups, and per-question source notes. Source notes stay local.',
    inputSchema: obj({ payload: { type: 'object', description: 'Draft payload: version 1, context, optional brand and competitors, intents with label/category/paraphrases containing text, sourceNote, selected' } }, ['payload']),
    call: (a) => ({ method: 'POST', path: '/api/setup/drafts', body: { payload: a?.payload } }),
  },
  {
    name: 'hearsay_review_benchmark_draft',
    readOnly: true,
    description: 'Review the exact selected questions, validation problems, category counts, and zero-spend run target count. Relay this review to the human before approval.',
    inputSchema: obj({ draft_id: { type: 'integer', minimum: 1 } }, ['draft_id']),
    call: (a) => ({ method: 'GET', path: `/api/setup/drafts/${a?.draft_id}/review` }),
  },
  {
    name: 'hearsay_approve_benchmark_draft',
    description: 'Approve the exact draft revision and review hash after the human has reviewed its questions. This atomically activates tracking questions but does not start a measurement run.',
    inputSchema: obj({ draft_id: { type: 'integer', minimum: 1 }, revision: { type: 'integer', minimum: 1 }, review_hash: { type: 'string' }, approve: { type: 'boolean' } },
      ['draft_id', 'revision', 'review_hash', 'approve']),
    call: (a) => ({ method: 'POST', path: `/api/setup/drafts/${a?.draft_id}/approve`, body: {
      revision: a?.revision, review_hash: a?.review_hash, approve: a?.approve,
    } }),
  },
  {
    name: 'hearsay_run_panel',
    description:
      'Start a measurement panel run (every active prompt × enabled provider × samples) using the user’s own API keys. If a quote is required, relay it to the human and retry with confirm:true and its quoteId as quote_id after approval. A changed selection invalidates the quote.',
    inputSchema: obj({ confirm: { type: 'boolean', description: 'true = the human approved the quoted cost in this conversation' }, quote_id: { type: 'string', description: 'quoteId returned by the approved preview' } }),
    call: (a) => ({ method: 'POST', path: '/api/run', body: { confirm: a?.confirm === true, quote_id: a?.quote_id } }),
  },
  {
    name: 'hearsay_api_search_schedule',
    description:
      'Preview, enable, or disable web search on the existing daily API panel. Enabling needs a separate approved quote and a target ceiling. Without this consent, daily API runs keep their search-off route even if on-demand search is configured.',
    inputSchema: obj({
      action: { type: 'string', enum: ['preview', 'enable', 'disable'] },
      target_ceiling: { type: 'integer', minimum: 1 },
      confirm: { type: 'boolean' },
      quote_id: { type: 'string', description: 'quoteId returned by the approved schedule preview' },
    }, ['action']),
    call: (a) => a?.action === 'disable'
      ? ({ method: 'DELETE', path: '/api/search-schedule' })
      : ({ method: 'POST', path: '/api/search-schedule', body: {
          target_ceiling: a?.target_ceiling,
          confirm: a?.action === 'enable' && a?.confirm === true,
          quote_id: a?.quote_id,
        } }),
  },
  {
    name: 'hearsay_subscription_preview',
    readOnly: true,
    description:
      'Preview an explicitly selected Codex agent or Claude Code agent measurement: prompts, samples, exact target count, process limits, first-use consent, and included-plan/overage usage. Internal CLI web-search calls have no enforceable ceiling. This never starts a CLI or model request.',
    inputSchema: obj({ surfaces: SUBSCRIPTION_SURFACES, lane: SUBSCRIPTION_LANE, prompt_ids: { type: 'array', items: { type: 'integer', minimum: 1 } }, samples: { type: 'integer', minimum: 1, maximum: 10 } }),
    call: (a) => ({ method: 'POST', path: '/api/subscription/preview', body: { surfaces: a?.surfaces, lane: a?.lane, prompt_ids: a?.prompt_ids, samples: a?.samples } }),
  },
  {
    name: 'hearsay_subscription_run',
    description:
      'Run explicitly selected Codex agent or Claude Code agent buyer-angle prompts through the user’s authenticated subscription CLI. For first-use consent, pass the approved quoteId as quote_id with confirm:true. Results retain final answer, verified web-search events, citations, redacted artifact metadata, and comparability status separately from API runs.',
    inputSchema: obj({ surfaces: SUBSCRIPTION_SURFACES, lane: SUBSCRIPTION_LANE, prompt_ids: { type: 'array', items: { type: 'integer', minimum: 1 } }, samples: { type: 'integer', minimum: 1, maximum: 10 }, confirm: { type: 'boolean' }, quote_id: { type: 'string' } }),
    call: (a) => ({ method: 'POST', path: '/api/subscription/run', body: { surfaces: a?.surfaces, lane: a?.lane, prompt_ids: a?.prompt_ids, samples: a?.samples, confirm: a?.confirm === true, quote_id: a?.quote_id } }),
  },
  {
    name: 'hearsay_subscription_schedule',
    description:
      'Preview, enable, or disable the persistent local-time subscription-agent schedule. Enabling is a separate consent from an on-demand run, requires a target ceiling and a completed verified on-demand run for each selected surface, and records missed occurrences instead of silently replaying them after downtime.',
    inputSchema: obj({
      action: { type: 'string', enum: ['preview', 'enable', 'disable'] },
      run_at: { type: 'string', description: 'Local HH:MM' },
      timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/Berlin' },
      surfaces: SUBSCRIPTION_SURFACES,
      lane: SUBSCRIPTION_LANE,
      prompt_ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
      samples: { type: 'integer', minimum: 1, maximum: 10 },
      target_ceiling: { type: 'integer', minimum: 1 },
      grace_minutes: { type: 'integer', minimum: 0, maximum: 1440 },
      confirm: { type: 'boolean' },
      quote_id: { type: 'string', description: 'quoteId returned by the approved schedule preview' },
    }, ['action']),
    call: (a) => a?.action === 'disable'
      ? ({ method: 'DELETE', path: '/api/subscription/schedule' })
      : ({ method: 'POST', path: '/api/subscription/schedule', body: {
          run_at: a?.run_at,
          timezone: a?.timezone,
          surfaces: a?.surfaces,
          lane: a?.lane,
          prompt_ids: a?.prompt_ids,
          samples: a?.samples,
          target_ceiling: a?.target_ceiling,
          grace_minutes: a?.grace_minutes,
          confirm: a?.action === 'enable' && a?.confirm === true,
          quote_id: a?.quote_id,
        } }),
  },
  {
    name: 'hearsay_exploration_create',
    description:
      'Persist one buyer-angle exploration question as inactive discovery evidence. The question is not added to the approved tracking panel until a human explicitly promotes it.',
    inputSchema: obj({ text: { type: 'string', minLength: 1, maxLength: 300 }, category: { type: 'string' }, origin: { type: 'string', enum: ['user_authored', 'suggested', 'imported'] } }, ['text']),
    call: (a) => ({ method: 'POST', path: '/api/prompts/exploration', body: { text: a?.text, category: a?.category, origin: a?.origin ?? 'user_authored' } }),
  },
  {
    name: 'hearsay_exploration_promote',
    description:
      'Promote an inactive exploration question only after the human reviews its exact wording and target intent. Historical responses keep their original exploration lane and prompt snapshot.',
    inputSchema: obj({ prompt_id: { type: 'integer', minimum: 1 }, intent_id: { type: 'integer', minimum: 1 }, reviewed: { type: 'boolean' } }, ['prompt_id', 'intent_id', 'reviewed']),
    call: (a) => ({ method: 'POST', path: `/api/prompts/${Number(a?.prompt_id)}/promote`, body: { intent_id: Number(a?.intent_id), reviewed: a?.reviewed } }),
  },
  {
    name: 'hearsay_run_status',
    readOnly: true,
    description:
      'Progress of the latest measurement run: status (running/done/failed), done_calls/total_calls, timestamps. Poll this after hearsay_run_panel starts a run. Returns no_runs if the instance has never run a panel.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/runs/latest' }),
  },
  {
    name: 'hearsay_ack_alert',
    description:
      'Acknowledge one alert by id so it leaves the open list. Use after the human has seen the alert and decided what to do about it.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1, description: 'Alert id from hearsay_alerts' } }, ['id']),
    call: (a) => ({ method: 'POST', path: `/api/alerts/${Number(a.id)}/ack`, body: {} }),
  },
];

/** @param {unknown} id @param {object} result */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
/** @param {unknown} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

/** @param {{id?: unknown, method?: string, params?: any}} msg */
async function dispatch(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'initialize': {
        const asked = String(params?.protocolVersion ?? '');
        reply(id, {
          protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : KNOWN_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'hearsay', version: VERSION },
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'notifications/initialized':
        return; // acknowledged silently
      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.readOnly ? { annotations: { readOnlyHint: true, idempotentHint: true } } : {}),
          })),
        });
        return;
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          replyError(id, -32602, `Unknown tool: ${params?.name}`);
          return;
        }
        const req = tool.call(params?.arguments ?? {});
        /** @param {boolean} isError @param {string} text */
        const content = (isError, text) =>
          reply(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
        const backend = resolveHearsayUrl();
        if (backend.url === null) {
          content(true, JSON.stringify({ error: { code: 'unreachable', message: backend.message } }));
          return;
        }
        const controller = new AbortController();
        // Armed until the BODY is read, not just the headers — a backend that stalls
        // mid-stream must abort res.text(), not hang the reply (and the drain-on-end
        // exit) forever. Cleared in finally so a rejected fetch cannot leak the timer.
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(backend.url + req.path, {
            method: req.method,
            headers: req.body === undefined ? {} : { 'content-type': 'application/json' },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
            signal: controller.signal,
          });
          const text = await res.text();
          content(!res.ok, text);
        } catch (err) {
          const timedOut = controller.signal.aborted;
          content(
            true,
            JSON.stringify({
              error: timedOut
                ? { code: 'timeout', message: `Hearsay at ${backend.url} did not answer within ${TIMEOUT_MS}ms` }
                : { code: 'unreachable', message: `Hearsay not reachable at ${backend.url} — is \`node server.js\` running?` },
            }),
          );
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    process.stderr.write(`[hearsay-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    if (!isNotification) replyError(id, -32603, 'Internal error');
  }
}

let buffer = '';
/** In-flight dispatches — piped stdin closes before async tools/call replies land. @type {Set<Promise<void>>} */
const inflight = new Set();
process.stdin.setEncoding('utf8');
/**
 * Parse and dispatch one newline-delimited JSON-RPC line. Never throws, never leaves an
 * unhandled rejection: a malformed line gets a protocol error reply, not a dead session.
 * @param {string} line
 * @returns {void}
 */
function handleLine(line) {
  /** @type {unknown} */
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  if (msg === null || typeof msg !== 'object') {
    // Valid JSON, invalid Request — e.g. the line `null`, which destructuring would
    // otherwise turn into an unhandled rejection that kills the whole session.
    replyError(null, -32600, 'Invalid Request');
    return;
  }
  // JSON-RPC batches: the 2025-03-26 MCP revision (which we offer in initialize)
  // required servers to accept them. Unroll and dispatch individually — replies go out
  // as separate ndjson lines, which stdio clients correlate by id.
  const msgs = Array.isArray(msg) ? msg : [msg];
  if (msgs.length === 0) {
    replyError(null, -32600, 'Invalid Request');
    return;
  }
  for (const one of msgs) {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) {
      replyError(null, -32600, 'Invalid Request');
      continue;
    }
    const p = dispatch(/** @type {{id?: unknown, method?: string, params?: any}} */ (one));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line !== '') handleLine(line);
  }
});
process.stdin.on('end', () => {
  // A final record without a trailing newline is still a request — flush it first.
  const residue = buffer.trim();
  buffer = '';
  if (residue !== '') handleLine(residue);
  // Drain before exiting: every request read from stdin gets its reply written.
  void Promise.allSettled([...inflight]).then(() => process.exit(0));
});
