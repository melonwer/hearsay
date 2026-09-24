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
} from './shared.js';

/** @typedef {import('./shared.js').ProviderResult} ProviderResult */

export const id = 'openai';
export const endpoint = 'https://api.openai.com/v1/chat/completions';

/**
 * @param {string} text the prompt, sent verbatim as the single user message
 * @param {{model?: string, timeoutMs?: number, apiKey?: string}} [opts]
 * @returns {Promise<ProviderResult>}
 */
export async function runPrompt(text, opts = {}) {
  const provider = config.providers.openai;
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
    { timeoutMs },
  );
  const latencyMs = Date.now() - startedAt;

  const data = /** @type {{model?: unknown, choices?: {message?: {content?: unknown}}[], usage?: {prompt_tokens?: unknown, completion_tokens?: unknown}}|null} */ (
    res.json
  );
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new ProviderError('other', 'Response had no choices', 'unexpected OpenAI response shape');
  }

  const input = usageNumber(data.usage?.prompt_tokens);
  const output = usageNumber(data.usage?.completion_tokens);
  return {
    text: textFromContent(data.choices[0]?.message?.content),
    model: typeof data.model === 'string' ? data.model : model,
    latencyMs,
    tokens: tokensOrUndefined(input, output),
    billableAttempts: billableAttempts(res, input, output),
  };
}
