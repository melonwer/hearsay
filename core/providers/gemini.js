/**
 * Google Gemini adapter (§5.2).
 *
 * Verified at build time, 2026-07-26:
 * - Endpoint  `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
 *   — https://ai.google.dev/api/generate-content
 * - Auth  `x-goog-api-key` header. The reference page also shows `?key=…` as a query
 *   parameter; we use the header so the key can never land in a URL, a proxy log or an
 *   error string (§19.6 #9). Header form confirmed at
 *   https://ai.google.dev/gemini-api/docs/quickstart
 * - Response  `candidates[0].content.parts[].text` (concatenated), `modelVersion`,
 *   `usageMetadata.promptTokenCount` / `candidatesTokenCount` / `thoughtsTokenCount`.
 * - Default model `gemini-3.6-flash` (stable) — https://ai.google.dev/gemini-api/docs/models
 *   — override with `GEMINI_MODEL`.
 *
 * Gemini exposes no native citation array on `generateContent`, so `citations` is left
 * undefined and the analyzer picks up markdown/bare links in the answer text (§6.3).
 *
 * No system prompt (`systemInstruction` is never sent), no temperature override (§5.1).
 * Unit-tested against test/fixtures/gemini.json; never calls the live API.
 */

import { config } from '../config.js';
import { ProviderError, billableAttempts, fetchWithRetry, requireKey, tokensOrUndefined, usageNumber } from './shared.js';

/** @typedef {import('./shared.js').ProviderResult} ProviderResult */

export const id = 'gemini';
export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * @param {string} model
 * @returns {string}
 */
export function endpointFor(model) {
  return `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
}

/** @param {unknown} json */
function reportedUsage(json) {
  const usage = /** @type {{usageMetadata?:{promptTokenCount?:unknown,candidatesTokenCount?:unknown,
   * thoughtsTokenCount?:unknown}}|null} */ (json)?.usageMetadata;
  const candidates = usageNumber(usage?.candidatesTokenCount);
  const thoughts = usageNumber(usage?.thoughtsTokenCount) ?? 0;
  return { inputTokens: usageNumber(usage?.promptTokenCount),
    outputTokens: candidates === null ? null : candidates + thoughts };
}

/**
 * @param {string} text the prompt, sent verbatim as the single user turn
 * @param {{model?: string, timeoutMs?: number, apiKey?: string}} [opts]
 * @returns {Promise<ProviderResult>}
 */
export async function runPrompt(text, opts = {}) {
  const provider = config.providers.gemini;
  const model = opts.model ?? provider.model;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const apiKey = opts.apiKey ?? provider.apiKey;
  requireKey(apiKey, provider.keyEnv);

  const startedAt = Date.now();
  const res = await fetchWithRetry(
    endpointFor(model),
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
    },
    { timeoutMs, usageFromResponse: reportedUsage },
  );
  const latencyMs = Date.now() - startedAt;

  const data = /** @type {{modelVersion?: unknown, candidates?: {content?: {parts?: {text?: unknown}[]}}[], usageMetadata?: {promptTokenCount?: unknown, candidatesTokenCount?: unknown, thoughtsTokenCount?: unknown}}|null} */ (
    res.json
  );
  const { inputTokens: input, outputTokens: output } = reportedUsage(res.json);
  if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    throw new ProviderError('other', 'Response had no candidates', 'unexpected Gemini response shape',
      billableAttempts(res, input, output));
  }

  const parts = data.candidates[0]?.content?.parts;
  const answer = Array.isArray(parts)
    ? parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
    : '';

  return {
    text: answer,
    model: typeof data.modelVersion === 'string' ? data.modelVersion : model,
    latencyMs,
    tokens: tokensOrUndefined(input, output),
    billableAttempts: billableAttempts(res, input, output),
  };
}
