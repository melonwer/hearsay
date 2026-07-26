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
import { ProviderError, fetchWithRetry, requireKey, tokensOrUndefined, usageNumber } from './shared.js';

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
const MAX_TOKENS = 1024;

/**
 * @param {string} text the prompt, sent verbatim as the single user message
 * @param {{model?: string, timeoutMs?: number, apiKey?: string}} [opts]
 * @returns {Promise<ProviderResult>}
 */
export async function runPrompt(text, opts = {}) {
  const provider = config.providers.anthropic;
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
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: text }] }),
    },
    { timeoutMs },
  );
  const latencyMs = Date.now() - startedAt;

  const data = /** @type {{model?: unknown, content?: {type?: unknown, text?: unknown}[], usage?: {input_tokens?: unknown, output_tokens?: unknown, cache_creation_input_tokens?: unknown, cache_read_input_tokens?: unknown}}|null} */ (
    res.json
  );
  if (!data || !Array.isArray(data.content)) {
    throw new ProviderError('other', 'Response had no content blocks', 'unexpected Anthropic response shape');
  }

  const answer = data.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('');

  // Docs: total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
  // We never enable prompt caching, so the cache counters are 0 in practice; summing them
  // keeps the billed figure right if that ever changes.
  const input = usageNumber(data.usage?.input_tokens);
  const cacheWrite = usageNumber(data.usage?.cache_creation_input_tokens) ?? 0;
  const cacheRead = usageNumber(data.usage?.cache_read_input_tokens) ?? 0;
  const output = usageNumber(data.usage?.output_tokens);

  return {
    text: answer,
    model: typeof data.model === 'string' ? data.model : model,
    latencyMs,
    tokens: tokensOrUndefined(input === null ? null : input + cacheWrite + cacheRead, output),
  };
}
