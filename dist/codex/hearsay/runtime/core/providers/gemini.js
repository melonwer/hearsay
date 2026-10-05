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
 * Search-off answers have no native citation array. Grounded responses expose
 * chunk and support metadata, which is parsed separately from answer text.
 *
 * No system prompt (`systemInstruction` is never sent), no temperature override (§5.1).
 * Unit-tested against test/fixtures/gemini.json; never calls the live API.
 */

import { config } from '../config.js';
import { ProviderError, billableAttempts, fetchWithRetry, normalizeCitations, requireKey,
  tokensOrUndefined, usageNumber } from './shared.js';
import { parseGeminiGrounding } from './gemini-grounding.js';
import { EVIDENCE_LIMITS } from '../measurement-storage.js';

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
 * @param {{model?: string, timeoutMs?: number, apiKey?: string,
 *   searchPolicy?:'off'|'auto'|'required'|'legacy', maxResponseBytes?:number|null}} [opts]
 * @returns {Promise<ProviderResult>}
 */
export async function runPrompt(text, opts = {}) {
  const provider = config.providers.gemini;
  const model = opts.model ?? provider.model;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const apiKey = opts.apiKey ?? provider.apiKey;
  const searchPolicy = opts.searchPolicy ?? 'off';
  if (searchPolicy !== 'off' && searchPolicy !== 'auto') {
    throw new RangeError(`Gemini search policy ${searchPolicy} is unsupported`);
  }
  if (searchPolicy === 'auto' && model !== 'gemini-3.6-flash') {
    throw new RangeError(`Gemini Google Search grounding is not validated for ${model}`);
  }
  requireKey(apiKey, provider.keyEnv);

  const startedAt = Date.now();
  /** @type {Awaited<ReturnType<typeof fetchWithRetry>>} */
  let res;
  try {
    res = await fetchWithRetry(
      endpointFor(model),
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }],
          ...(searchPolicy === 'auto' ? { tools: [{ google_search: {} }] } : {}) }),
      },
      { timeoutMs, usageFromResponse: reportedUsage,
        ...(opts.maxResponseBytes ? { maxResponseBytes: opts.maxResponseBytes } : {}) },
    );
  } catch (error) {
    if (searchPolicy === 'auto' && error instanceof ProviderError &&
        /HTTP (400|403)/.test(error.message)) {
      throw new ProviderError(error.kind, 'Gemini Google Search request was rejected',
        `Check grounding access for gemini-3.6-flash, or set HEARSAY_GEMINI_SEARCH_POLICY=off. ${error.detail}`.trim(),
        error.billableAttempts);
    }
    throw error;
  }
  const latencyMs = Date.now() - startedAt;

  const data = /** @type {{modelVersion?: unknown, candidates?: {content?: {parts?: {text?: unknown}[]},
    finishReason?:unknown, groundingMetadata?:unknown}[], promptFeedback?:{blockReason?:unknown},
    usageMetadata?: {promptTokenCount?: unknown, candidatesTokenCount?: unknown, thoughtsTokenCount?: unknown}}|null} */ (
    res.json
  );
  const { inputTokens: input, outputTokens: output } = reportedUsage(res.json);
  const attempts = billableAttempts(res, input, output, searchPolicy === 'auto' ? null : undefined);
  if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    if (typeof data?.promptFeedback?.blockReason === 'string') {
      return { text: '', model: typeof data.modelVersion === 'string' ? data.modelVersion : model,
        latencyMs, tokens: tokensOrUndefined(input, output), billableAttempts: attempts,
        answerStatus: 'refused',
        ...(searchPolicy === 'auto' ? { groundingReceipt: parseGeminiGrounding(null, []).receipt } : {}) };
    }
    throw new ProviderError('other', 'Response had no candidates', 'unexpected Gemini response shape',
      attempts);
  }

  const candidate = data.candidates[0];
  const parts = candidate?.content?.parts;
  const partTexts = Array.isArray(parts)
    ? parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')) : [];
  const answer = partTexts.join('');
  if (Buffer.byteLength(answer) > EVIDENCE_LIMITS.answerBytes) {
    throw new ProviderError('other', 'Gemini answer exceeds evidence storage limit', '', attempts);
  }
  const finishReason = candidate?.finishReason;
  const answerStatus = finishReason === 'MAX_TOKENS' ? 'truncated'
    : ['SAFETY', 'PROHIBITED_CONTENT', 'SPII', 'BLOCKLIST', 'RECITATION'].includes(String(finishReason)) ? 'refused'
      : finishReason !== 'STOP' && (searchPolicy === 'auto' || Boolean(finishReason)) ? 'incomplete'
        : answer.trim() ? 'complete' : 'empty';
  let grounding;
  if (searchPolicy === 'auto') {
    try {
      grounding = parseGeminiGrounding(candidate?.groundingMetadata, partTexts);
    } catch (error) {
      throw new ProviderError('other', 'Invalid Gemini grounding metadata',
        error instanceof Error ? error.message : String(error), attempts);
    }
  }

  const result = /** @type {ProviderResult} */ ({
    text: answer,
    model: typeof data.modelVersion === 'string' ? data.modelVersion : model,
    latencyMs,
    tokens: tokensOrUndefined(input, output),
    answerStatus,
    billableAttempts: attempts,
    ...(grounding ? { searchActions: grounding.searchActions, sources: grounding.sources,
      answerCitations: grounding.answerCitations, citations: normalizeCitations(grounding.answerCitations),
      groundingReceipt: grounding.receipt } : {}),
  });
  if (grounding?.observedSearch && !grounding.suggestions?.trim()) {
    throw new ProviderError('other', 'Grounded Gemini answer lacks Search Suggestions',
      'The response cannot be presented under the grounding contract', attempts);
  }
  return result;
}
