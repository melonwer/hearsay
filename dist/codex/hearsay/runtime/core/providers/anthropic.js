/**
 * Anthropic (Claude) adapter (§5.2).
 *
 * Verified at build time, 2026-07-26:
 * - Endpoint  `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`,
 *   `anthropic-version: 2023-06-01`, `content-type: application/json`; `max_tokens`
 *   is required — https://platform.claude.com/docs/en/api/messages
 * - Response  `content[]` blocks (we concatenate the `type: "text"` ones), `model`,
 *   `usage.input_tokens` / `usage.output_tokens` plus cache counters that the docs
 *   fold into total input tokens.
 * - Default model `claude-sonnet-5`
 *   — https://platform.claude.com/docs/en/about-claude/models/overview
 *   — override with `ANTHROPIC_MODEL`.
 *
 * No system prompt, no temperature override (§5.1).
 * Unit-tested against test/fixtures/anthropic.json; never calls the live API.
 */

import { config } from '../config.js';
import { ProviderError, billableAttempts, fetchWithRetry, normalizeCitations,
  requireKey, tokensOrUndefined, usageNumber } from './shared.js';

/** @typedef {import('./shared.js').ProviderResult} ProviderResult */

export const id = 'anthropic';
export const endpoint = 'https://api.anthropic.com/v1/messages';

/** Current API version string (verified 2026-07-26). */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * `max_tokens` is required by this API and has no "unlimited" value. 1024 is the plan's
 * figure (§5.2): long enough for a full recommendation answer, short enough to keep a
 * panel run cheap.
 */
export const MAX_TOKENS = 1024;
export const WEB_SEARCH_TOOL = 'web_search_20250305';
export const MAX_SEARCH_CALLS = 3;
export const MAX_CONTINUATIONS = 1;

/** @param {unknown} value @returns {Record<string,unknown>|null} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string,unknown>} */ (value) : null;
}

/** @param {unknown} value @returns {string|null} */
function webUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

/** @param {unknown} json */
function reportedUsage(json) {
  const usage = /** @type {{usage?:{input_tokens?:unknown,output_tokens?:unknown,
   * cache_creation_input_tokens?:unknown,cache_read_input_tokens?:unknown}}|null} */ (json)?.usage;
  const input = usageNumber(usage?.input_tokens);
  const cacheWrite = usageNumber(usage?.cache_creation_input_tokens) ?? 0;
  const cacheRead = usageNumber(usage?.cache_read_input_tokens) ?? 0;
  return { inputTokens: input === null ? null : input + cacheWrite + cacheRead,
    outputTokens: usageNumber(usage?.output_tokens) };
}

/** @param {unknown} json */
function searchReportedUsage(json) {
  const tokens = reportedUsage(json);
  const toolUse = object(object(object(json)?.usage)?.server_tool_use);
  const raw = usageNumber(toolUse?.web_search_requests);
  return { ...tokens, searchCalls: raw !== null && Number.isInteger(raw) ? raw : null };
}

/**
 * @param {import('../measurement-contract.js').AnswerCitation[]} citations
 * @param {import('../measurement-contract.js').SourceObservation[]} sources
 */
function associateCitations(citations, sources) {
  return citations.map((citation) => {
    const matches = sources.filter((source) => source.url === citation.url);
    return { ...citation, sourceId: matches.length === 1 ? matches[0].id : null };
  });
}

/**
 * @param {string} text
 * @param {{model:string,timeoutMs:number,apiKey:string,maxOutputTokens?:number|null,
 *   maxResponseBytes?:number|null,maxSearchCalls?:number|null,maxContinuations?:number,
 *   signal?:AbortSignal}} opts
 * @returns {Promise<ProviderResult>}
 */
async function runSearchPrompt(text, opts) {
  const maxSearchCalls = opts.maxSearchCalls ?? MAX_SEARCH_CALLS;
  const maxContinuations = opts.maxContinuations ?? MAX_CONTINUATIONS;
  const maxOutputTokens = opts.maxOutputTokens ?? MAX_TOKENS;
  const maxResponseBytes = opts.maxResponseBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(maxSearchCalls) || maxSearchCalls < 1 || maxSearchCalls > MAX_SEARCH_CALLS ||
      !Number.isInteger(maxContinuations) || maxContinuations < 0 || maxContinuations > MAX_CONTINUATIONS ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_TOKENS ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024) {
    throw new RangeError('Unsupported Anthropic web-search budget');
  }
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  /** @type {{role:string,content:string|unknown[]}[]} */
  const messages = [{ role: 'user', content: text }];
  /** @type {Map<string,import('../measurement-contract.js').SearchAction>} */
  const actions = new Map();
  /** @type {import('../measurement-contract.js').SourceObservation[]} */
  const sources = [];
  /** @type {import('../measurement-contract.js').AnswerCitation[]} */
  const answerCitations = [];
  /** @type {import('../cost.js').BillableAttempt[]} */
  const attempts = [];
  let answer = '';
  let returnedModel = opts.model;
  let usedSearchCalls = 0;
  /** @type {import('../measurement-contract.js').AnswerStatus} */
  let answerStatus = 'incomplete';
  for (let continuation = 0; continuation <= maxContinuations; continuation += 1) {
    const remainingTime = deadline - Date.now();
    const remainingSearchCalls = maxSearchCalls - usedSearchCalls;
    if (remainingTime <= 0 || remainingSearchCalls <= 0) break;
    const tools = [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: remainingSearchCalls }];
    let res;
    try {
      res = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'x-api-key': opts.apiKey, 'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, max_tokens: maxOutputTokens, tools, messages }),
      }, { timeoutMs: remainingTime, deadlineMs: deadline, signal: opts.signal, maxResponseBytes,
        usageFromResponse: searchReportedUsage });
    } catch (error) {
      if (error instanceof ProviderError) {
        error.billableAttempts = [...attempts,
          ...(error.billableAttempts ?? []).map((attempt) => ({ ...attempt, continuation }))];
        if (continuation > 0) error.partialResult = {
          text: answer, model: returnedModel, latencyMs: Date.now() - startedAt,
          searchActions: [...actions.values()], sources,
          answerCitations: associateCitations(answerCitations, sources),
        };
      }
      throw error;
    }
    const data = object(res.json);
    const content = data?.content;
    const usage = searchReportedUsage(res.json);
    const callCount = usage.searchCalls === null && Array.isArray(content) &&
      !content.some((rawBlock) => ['server_tool_use', 'web_search_tool_result'].includes(String(object(rawBlock)?.type)))
      ? 0 : usage.searchCalls;
    attempts.push(...billableAttempts(res, usage.inputTokens, usage.outputTokens, callCount)
      .map((attempt) => ({ ...attempt, continuation })));
    if (!data || !Array.isArray(content)) {
      throw new ProviderError('other', 'Response had no content blocks', 'unexpected Anthropic search response shape', attempts);
    }
    if (typeof data.model === 'string') returnedModel = data.model;
    for (const rawBlock of content) {
      const block = object(rawBlock);
      if (!block) continue;
      if (block.type === 'server_tool_use' && block.name === 'web_search') {
        const id = typeof block.id === 'string' ? block.id : `search:${continuation}:${actions.size}`;
        const query = object(block.input)?.query;
        const queries = typeof query === 'string' && query.trim() ? [query.trim()] : [];
        actions.set(id, { id, kind: 'search', status: 'started',
          queryMetadata: queries.length > 0 ? 'available' : 'unavailable', queries,
          observedAt: null, providerType: 'web_search' });
      } else if (block.type === 'web_search_tool_result') {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : `result:${continuation}:${actions.size}`;
        const previous = actions.get(id);
        const error = object(block.content)?.type === 'web_search_tool_result_error';
        actions.set(id, { id, kind: 'search', status: error ? 'failed' : Array.isArray(block.content) ? 'completed' : 'unavailable',
          queryMetadata: previous?.queryMetadata ?? 'unavailable', queries: previous?.queries ?? [],
          observedAt: null, providerType: 'web_search' });
        for (const [index, rawSource] of (Array.isArray(block.content) ? block.content : []).entries()) {
          const source = object(rawSource);
          if (source?.type !== 'web_search_result') continue;
          const url = webUrl(source.url);
          if (!url) continue;
          const sourceId = `${id}:source:${index}`;
          if (sources.some((item) => item.id === sourceId)) continue;
          sources.push({ id: sourceId, url, title: typeof source.title === 'string' ? source.title : null,
            provenance: 'search_result', actionId: id, order: index });
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        answer += block.text;
        for (const rawCitation of (Array.isArray(block.citations) ? block.citations : [])) {
          const citation = object(rawCitation);
          if (citation?.type !== 'web_search_result_location') continue;
          const url = webUrl(citation.url);
          if (url) answerCitations.push({ url, provenance: 'native_annotation', sourceId: null,
            start: null, end: null });
        }
      }
    }
    if (callCount === null) usedSearchCalls = maxSearchCalls;
    else usedSearchCalls = Math.max(actions.size, usedSearchCalls + callCount);
    if (usedSearchCalls > maxSearchCalls) {
      answerStatus = 'incomplete';
      break;
    }
    if (data.stop_reason === 'pause_turn') {
      if (continuation < maxContinuations && usedSearchCalls < maxSearchCalls) {
        messages.push({ role: 'assistant', content });
        continue;
      }
      answerStatus = 'incomplete';
    } else if (data.stop_reason === 'end_turn') answerStatus = answer.trim() ? 'complete' : 'empty';
    else if (data.stop_reason === 'refusal') answerStatus = 'refused';
    else if (data.stop_reason === 'max_tokens') answerStatus = 'truncated';
    else answerStatus = 'incomplete';
    break;
  }
  const allActions = [...actions.values()];
  const linkedCitations = associateCitations(answerCitations, sources);
  return { text: answer, model: returnedModel, latencyMs: Date.now() - startedAt,
    tokens: attempts.length > 0 && attempts.every((attempt) => attempt.inputTokens !== null && attempt.outputTokens !== null)
      ? { input: attempts.reduce((sum, attempt) => sum + Number(attempt.inputTokens), 0),
        output: attempts.reduce((sum, attempt) => sum + Number(attempt.outputTokens), 0) } : undefined,
    billableAttempts: attempts, searchActions: allActions, sources, answerCitations: linkedCitations,
    citations: normalizeCitations(linkedCitations), answerStatus,
    noSearchConfirmed: answerStatus === 'complete' && allActions.length === 0 };
}

/**
 * @param {string} text the prompt, sent verbatim as the single user message
 * @param {{model?: string, timeoutMs?: number, apiKey?: string,
 *   searchPolicy?:'off'|'auto'|'required'|'legacy',maxOutputTokens?:number|null,
 *   maxResponseBytes?:number|null,maxSearchCalls?:number|null,maxContinuations?:number,
 *   signal?:AbortSignal}} [opts]
 * @returns {Promise<ProviderResult>}
 */
export async function runPrompt(text, opts = {}) {
  const provider = config.providers.anthropic;
  const model = opts.model ?? provider.model;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const apiKey = opts.apiKey ?? provider.apiKey;
  requireKey(apiKey, provider.keyEnv);
  const searchPolicy = opts.searchPolicy ?? 'off';
  if (searchPolicy !== 'off' && searchPolicy !== 'auto') throw new RangeError(`Anthropic search policy ${searchPolicy} is unsupported`);
  if (searchPolicy === 'auto') {
    if (model !== 'claude-sonnet-5') throw new RangeError(`Anthropic web search is not validated for ${model}`);
    return runSearchPrompt(text, { ...opts, model, timeoutMs, apiKey });
  }

  const startedAt = Date.now();
  const res = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: text }] }),
    },
    { timeoutMs, usageFromResponse: reportedUsage },
  );
  const latencyMs = Date.now() - startedAt;

  const data = /** @type {{model?: unknown, content?: {type?: unknown, text?: unknown}[], usage?: {input_tokens?: unknown, output_tokens?: unknown, cache_creation_input_tokens?: unknown, cache_read_input_tokens?: unknown}}|null} */ (
    res.json
  );
  const { inputTokens: input, outputTokens: output } = reportedUsage(res.json);
  if (!data || !Array.isArray(data.content)) {
    throw new ProviderError('other', 'Response had no content blocks', 'unexpected Anthropic response shape',
      billableAttempts(res, input, output));
  }

  const answer = data.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('');

  return {
    text: answer,
    model: typeof data.model === 'string' ? data.model : model,
    latencyMs,
    tokens: tokensOrUndefined(input, output),
    billableAttempts: billableAttempts(res, input, output),
  };
}
