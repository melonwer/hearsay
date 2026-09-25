/**
 * Perplexity Sonar adapter (§5.2).
 *
 * Verified at build time, 2026-07-26:
 * - Endpoint  `POST https://api.perplexity.ai/v1/sonar` with `Authorization: Bearer …`
 *   — https://docs.perplexity.ai/api-reference/sonar-post
 *   The plan's `/chat/completions` path is stale: the Sonar completion endpoint now lives
 *   at `/v1/sonar`. Perplexity's migration page recommends the newer Agent API but states
 *   "While Sonar Chat Completions remains supported…" with no sunset date, so the
 *   OpenAI-shaped Sonar endpoint stays the right fit for a single-user-message panel run.
 *   — https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview
 * - Response  `choices[0].message.content`, `model`, `usage.prompt_tokens` /
 *   `usage.completion_tokens`, `search_results[]` (retrieved context sources), and
 *   `citations[]` (final reference URLs). These are distinct evidence layers.
 * - Default model `sonar` ("lightweight, cost-effective search model with grounding")
 *   — https://docs.perplexity.ai/getting-started/models — override with `PERPLEXITY_MODEL`.
 *
 * No system prompt, no temperature override (§5.1).
 * Unit-tested against test/fixtures/perplexity.json; never calls the live API.
 */

import { config } from '../config.js';
import {
  ProviderError,
  fetchWithRetry,
  billableAttempts,
  normalizeCitations,
  requireKey,
  textFromContent,
  tokensOrUndefined,
  usageNumber,
} from './shared.js';

/** @typedef {import('./shared.js').ProviderResult} ProviderResult */

export const id = 'perplexity';
export const endpoint = 'https://api.perplexity.ai/v1/sonar';

/** @param {unknown} value @returns {string|null} */
function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? value.trim() : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {string|null} */
function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** @param {unknown} json */
function reportedUsage(json) {
  const usage = /** @type {{usage?:{prompt_tokens?:unknown,completion_tokens?:unknown}}|null} */ (json)?.usage;
  return { inputTokens: usageNumber(usage?.prompt_tokens), outputTokens: usageNumber(usage?.completion_tokens) };
}

/**
 * @param {string} text the prompt, sent verbatim as the single user message
 * @param {{model?: string, timeoutMs?: number, apiKey?: string, maxResponseBytes?:number|null}} [opts]
 * @returns {Promise<ProviderResult>}
 */
export async function runPrompt(text, opts = {}) {
  const provider = config.providers.perplexity;
  const model = opts.model ?? provider.model;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const apiKey = opts.apiKey ?? provider.apiKey;
  requireKey(apiKey, provider.keyEnv);

  const startedAt = Date.now();
  const res = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
    },
    { timeoutMs, usageFromResponse: reportedUsage,
      maxResponseBytes: opts.maxResponseBytes ?? 2 * 1024 * 1024 },
  );
  const latencyMs = Date.now() - startedAt;

  const data = /** @type {{model?: unknown, choices?: {message?: {content?: unknown}, finish_reason?:unknown}[], citations?: unknown, search_results?: unknown, usage?: {prompt_tokens?: unknown, completion_tokens?: unknown, cost?:{total_cost?:unknown}}}|null} */ (
    res.json
  );
  const { inputTokens: input, outputTokens: output } = reportedUsage(res.json);
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new ProviderError('other', 'Response had no choices', 'unexpected Perplexity response shape',
      billableAttempts(res, input, output));
  }

  const answerText = textFromContent(data.choices[0]?.message?.content);
  const sources = Array.isArray(data.search_results)
    ? data.search_results.flatMap((entry, order) => {
      if (!entry || typeof entry !== 'object') return [];
      const source = /** @type {{url?:unknown,title?:unknown,snippet?:unknown}} */ (entry);
      const url = httpUrl(source.url);
      return url === null ? [] : [{
        id: `search-result:${order}`, url, title: optionalText(source.title),
        excerpt: typeof source.snippet === 'string' && Buffer.byteLength(source.snippet) <= 4096
          ? optionalText(source.snippet) : null,
        provenance: /** @type {const} */ ('search_result'),
        actionId: null, order,
      }];
    }) : [];
  const rawReferences = Array.isArray(data.citations) ? data.citations : [];
  const citations = normalizeCitations(rawReferences).filter((citation) => httpUrl(citation.url) !== null);
  const firstSourceByUrl = new Map();
  for (const source of sources) if (!firstSourceByUrl.has(source.url)) firstSourceByUrl.set(source.url, source.id);
  const firstSpanByReference = new Map();
  for (const match of answerText.matchAll(/\[(\d+)\]/g)) {
    const index = Number(match[1]) - 1;
    const url = index >= 0 && index < rawReferences.length ? httpUrl(rawReferences[index]) : null;
    if (url !== null && !firstSpanByReference.has(url)) {
      firstSpanByReference.set(url, [match.index, match.index + match[0].length]);
    }
  }
  const answerCitations = citations.map(({ url }) => {
    const span = firstSpanByReference.get(url);
    return {
      url, provenance: /** @type {const} */ ('explicit_reference'),
      sourceId: firstSourceByUrl.get(url) ?? null,
      start: span?.[0] ?? null, end: span?.[1] ?? null,
    };
  });
  const finishReason = data.choices[0]?.finish_reason;
  const answerStatus = finishReason === 'length' ? 'truncated' : answerText.trim() === '' ? 'empty' :
    finishReason === 'stop' ? 'complete' : 'incomplete';

  /** @type {ProviderResult} */
  const result = {
    text: answerText,
    model: typeof data.model === 'string' ? data.model : model,
    latencyMs,
    tokens: tokensOrUndefined(input, output),
    billableAttempts: billableAttempts(res, input, output),
    providerReportedChargeUsd: usageNumber(data.usage?.cost?.total_cost),
    answerStatus,
    sources,
    answerCitations,
    citations,
  };
  return result;
}
