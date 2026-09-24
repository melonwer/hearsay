/**
 * OpenAI (ChatGPT) adapter (§5.2).
 *
 * Verified at build time, 2026-07-26:
 * - Endpoint  `POST https://api.openai.com/v1/chat/completions` with
 *   `Authorization: Bearer …` — https://developers.openai.com/api/docs/api-reference/introduction
 * - Response  `choices[0].message.content`, `model`,
 *   `usage.prompt_tokens` / `usage.completion_tokens`
 *   — https://developers.openai.com/api/docs/api-reference/chat/create
 * - Default model `gpt-5.6-luna`, the cost tier of the current GPT-5.6 family
 *   — https://developers.openai.com/api/docs/models — override with `OPENAI_MODEL`.
 *
 * No system prompt, no temperature override (§5.1).
 * Unit-tested against test/fixtures/openai.json; never calls the live API.
 */

import { config } from '../config.js';
import {
  ProviderError,
  fetchWithRetry,
  billableAttempts,
  requireKey,
  textFromContent,
  tokensOrUndefined,
  usageNumber,
  normalizeCitations,
} from './shared.js';

/** @typedef {import('./shared.js').ProviderResult} ProviderResult */

export const id = 'openai';
export const endpoint = 'https://api.openai.com/v1/chat/completions';
export const responsesEndpoint = 'https://api.openai.com/v1/responses';

/** @param {unknown} json */
function reportedUsage(json) {
  const usage = /** @type {{usage?:{prompt_tokens?:unknown,completion_tokens?:unknown}}|null} */ (json)?.usage;
  return { inputTokens: usageNumber(usage?.prompt_tokens), outputTokens: usageNumber(usage?.completion_tokens) };
}

/** @param {unknown} value @returns {Record<string, unknown>|null} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} value @returns {string|null} */
function webUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

/** @param {unknown} json */
function responsesUsage(json) {
  const usage = object(object(json)?.usage);
  return { inputTokens: usageNumber(usage?.input_tokens), outputTokens: usageNumber(usage?.output_tokens),
    searchCalls: null };
}

/**
 * @param {unknown} json
 * @param {string} model
 * @param {number} latencyMs
 * @param {import('./shared.js').FetchResult} res
 * @returns {ProviderResult}
 */
function parseResponses(json, model, latencyMs, res) {
  const data = object(json);
  const output = data?.output;
  const { inputTokens, outputTokens } = responsesUsage(json);
  if (!data || !Array.isArray(output)) {
    throw new ProviderError('other', 'Response had no output', 'unexpected OpenAI Responses shape',
      billableAttempts(res, inputTokens, outputTokens, null));
  }
  /** @type {import('../measurement-contract.js').SearchAction[]} */
  const searchActions = [];
  /** @type {import('../measurement-contract.js').SourceObservation[]} */
  const sources = [];
  /** @type {import('../measurement-contract.js').AnswerCitation[]} */
  const answerCitations = [];
  let answer = '';
  let refused = false;
  let incompleteMessage = false;
  let uncertainSearchBill = false;
  for (const [itemIndex, rawItem] of output.entries()) {
    const item = object(rawItem);
    if (!item) continue;
    if (item.type === 'web_search_call') {
      const action = object(item.action);
      const providerType = typeof action?.type === 'string' ? action.type : null;
      const id = `${typeof item.id === 'string' ? item.id : 'web_search_call'}:${itemIndex}`;
      const queries = [
        ...(typeof action?.query === 'string' ? [action.query] : []),
        ...(Array.isArray(action?.queries) ? action.queries.filter((q) => typeof q === 'string') : []),
      ].map((q) => q.trim()).filter(Boolean);
      const status = item.status === 'completed' ? 'completed'
        : item.status === 'failed' ? 'failed'
          : item.status === 'in_progress' || item.status === 'searching' ? 'started' : 'unavailable';
      const kind = providerType === 'search' ? 'search' : 'fetch';
      if (kind !== 'search' || status !== 'completed') uncertainSearchBill = true;
      searchActions.push({ id, kind, status, queryMetadata: queries.length > 0 ? 'available' : 'unavailable',
        queries, observedAt: null, providerType });
      for (const [sourceIndex, rawSource] of (Array.isArray(action?.sources) ? action.sources : []).entries()) {
        const source = object(rawSource);
        const url = webUrl(source?.url);
        if (!url) continue;
        sources.push({ id: `${id}:source:${sourceIndex}`, url,
          title: typeof source?.title === 'string' ? source.title : null,
          provenance: 'reported_source', actionId: id, order: sourceIndex });
      }
      continue;
    }
    if (item.type !== 'message') continue;
    if (item.status && item.status !== 'completed') incompleteMessage = true;
    for (const rawPart of (Array.isArray(item.content) ? item.content : [])) {
      const part = object(rawPart);
      if (!part) continue;
      if (part.type === 'refusal') refused = true;
      if (part.type !== 'output_text' || typeof part.text !== 'string') continue;
      const offset = answer.length;
      answer += part.text;
      for (const rawAnnotation of (Array.isArray(part.annotations) ? part.annotations : [])) {
        const annotation = object(rawAnnotation);
        if (annotation?.type !== 'url_citation') continue;
        const url = webUrl(annotation.url);
        if (!url) continue;
        const start = annotation.start_index;
        const end = annotation.end_index;
        const validSpan = !/[\uD800-\uDBFF]/u.test(answer) &&
          Number.isInteger(start) && Number.isInteger(end) &&
          Number(start) >= 0 && Number(end) > Number(start) && Number(end) <= part.text.length;
        answerCitations.push({ url, provenance: 'native_annotation', sourceId: null,
          start: validSpan ? offset + Number(start) : null,
          end: validSpan ? offset + Number(end) : null });
      }
    }
  }
  const complete = data.status === 'completed' && !incompleteMessage;
  const incompleteReason = object(data.incomplete_details)?.reason;
  const answerStatus = refused ? 'refused' : !complete
    ? incompleteReason === 'max_output_tokens' ? 'truncated' : 'incomplete'
      : answer.trim() === '' ? 'empty' : 'complete';
  const searchCalls = complete && !uncertainSearchBill
    ? searchActions.filter((action) => action.kind === 'search').length : null;
  return { text: answer, model: typeof data.model === 'string' ? data.model : model, latencyMs,
    tokens: tokensOrUndefined(inputTokens, outputTokens),
    citations: normalizeCitations(answerCitations), answerStatus,
    searchActions, sources, answerCitations,
    noSearchConfirmed: complete && searchActions.length === 0,
    billableAttempts: billableAttempts(res, inputTokens, outputTokens, searchCalls) };
}

/**
 * @param {string} text the prompt, sent verbatim as the single user message
 * @param {{model?: string, timeoutMs?: number, apiKey?: string,
 *   searchPolicy?: 'off'|'auto'|'required'|'legacy', maxOutputTokens?: number|null,
 *   maxResponseBytes?:number|null, signal?:AbortSignal}} [opts]
 * @returns {Promise<ProviderResult>}
 */
export async function runPrompt(text, opts = {}) {
  const provider = config.providers.openai;
  const model = opts.model ?? provider.model;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const apiKey = opts.apiKey ?? provider.apiKey;
  requireKey(apiKey, provider.keyEnv);
  const searchPolicy = opts.searchPolicy ?? 'off';
  if (!['off', 'auto', 'required'].includes(searchPolicy)) {
    throw new RangeError(`OpenAI search policy ${searchPolicy} is unsupported`);
  }
  if (searchPolicy !== 'off' && model !== 'gpt-5.6-luna') {
    throw new RangeError(`OpenAI web search is not validated for ${model}`);
  }
  const maxOutputTokens = opts.maxOutputTokens ?? 2048;
  const maxResponseBytes = opts.maxResponseBytes ?? 2 * 1024 * 1024;
  if (searchPolicy !== 'off' && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 2048)) {
    throw new RangeError('OpenAI search max_output_tokens must be between 1 and 2048');
  }
  if (searchPolicy !== 'off' && (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024)) {
    throw new RangeError('OpenAI search response size limit must be between 1 and 2097152 bytes');
  }

  const startedAt = Date.now();
  const res = await fetchWithRetry(
    searchPolicy === 'off' ? endpoint : responsesEndpoint,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(searchPolicy === 'off'
        ? { model, messages: [{ role: 'user', content: text }] }
        : { model, input: [{ role: 'user', content: text }],
          tools: [{ type: 'web_search' }], tool_choice: searchPolicy,
          include: ['web_search_call.action.sources'], max_output_tokens: maxOutputTokens }),
    },
    { timeoutMs, usageFromResponse: searchPolicy === 'off' ? reportedUsage : responsesUsage,
      ...(searchPolicy !== 'off' ? { signal: opts.signal, maxResponseBytes } : {}) },
  );
  const latencyMs = Date.now() - startedAt;
  if (searchPolicy !== 'off') return parseResponses(res.json, model, latencyMs, res);

  const data = /** @type {{model?: unknown, choices?: {message?: {content?: unknown}}[], usage?: {prompt_tokens?: unknown, completion_tokens?: unknown}}|null} */ (
    res.json
  );
  const { inputTokens: input, outputTokens: output } = reportedUsage(res.json);
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new ProviderError('other', 'Response had no choices', 'unexpected OpenAI response shape',
      billableAttempts(res, input, output));
  }

  return {
    text: textFromContent(data.choices[0]?.message?.content),
    model: typeof data.model === 'string' ? data.model : model,
    latencyMs,
    tokens: tokensOrUndefined(input, output),
    billableAttempts: billableAttempts(res, input, output),
  };
}
