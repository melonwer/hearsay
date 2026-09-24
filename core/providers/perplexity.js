/**
 * Perplexity adapter (§5.2) — the only provider with native citations.
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
 *   `usage.completion_tokens`, plus citations in two shapes: `search_results[]`
 *   (objects with `url`, `title`, …) and `citations[]` (plain URL strings). We prefer
 *   `search_results` and fall back to `citations`.
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

/** @param {unknown} json */
function reportedUsage(json) {
  const usage = /** @type {{usage?:{prompt_tokens?:unknown,completion_tokens?:unknown}}|null} */ (json)?.usage;
  return { inputTokens: usageNumber(usage?.prompt_tokens), outputTokens: usageNumber(usage?.completion_tokens) };
}

/**
 * @param {string} text the prompt, sent verbatim as the single user message
 * @param {{model?: string, timeoutMs?: number, apiKey?: string}} [opts]
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
    { timeoutMs, usageFromResponse: reportedUsage },
  );
  const latencyMs = Date.now() - startedAt;

  const data = /** @type {{model?: unknown, choices?: {message?: {content?: unknown}}[], citations?: unknown, search_results?: unknown, usage?: {prompt_tokens?: unknown, completion_tokens?: unknown}}|null} */ (
    res.json
  );
  const { inputTokens: input, outputTokens: output } = reportedUsage(res.json);
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new ProviderError('other', 'Response had no choices', 'unexpected Perplexity response shape',
      billableAttempts(res, input, output));
  }

  const rawCitations = Array.isArray(data.search_results)
    ? data.search_results
    : Array.isArray(data.citations)
      ? data.citations
      : [];
  const citations = normalizeCitations(rawCitations);

  /** @type {ProviderResult} */
  const result = {
    text: textFromContent(data.choices[0]?.message?.content),
    model: typeof data.model === 'string' ? data.model : model,
    latencyMs,
    tokens: tokensOrUndefined(input, output),
    billableAttempts: billableAttempts(res, input, output),
  };
  if (citations.length > 0) result.citations = citations;
  return result;
}
