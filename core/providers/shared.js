/**
 * Shared provider plumbing — timeout, retry, error classification (§5.1).
 *
 * Methodology-critical (§5.1): every adapter sends the prompt as a single user
 * message with **no system prompt and no temperature override**, so the answer stays
 * as close as an API can get to "what a user on default settings gets". The
 * API-vs-consumer-app caveat is documented in METHODOLOGY.md.
 *
 * Secrets hygiene (§19.6 #9): API keys travel in headers only. Nothing here ever
 * puts a header, an `init` object, or an unscrubbed provider body into an error
 * message, and `scrubSecrets()` is a second line of defence over anything that does
 * make it into `detail`.
 */

/**
 * @typedef {Object} ProviderResult
 * @property {string} text the answer text
 * @property {{input:number,output:number}} [tokens] from the provider's usage field (§4.3)
 * @property {string} model actual model echoed by the API when available
 * @property {number} latencyMs
 * @property {{url:string}[]} [citations] only providers with native citations
 * @property {import('../measurement-contract.js').AnswerStatus} [answerStatus]
 * @property {import('../measurement-contract.js').SearchAction[]} [searchActions]
 * @property {import('../measurement-contract.js').SourceObservation[]} [sources]
 * @property {import('../measurement-contract.js').AnswerCitation[]} [answerCitations]
 * @property {ReturnType<typeof import('./gemini-grounding.js').parseGeminiGrounding>['receipt']} [groundingReceipt]
 * @property {boolean} [noSearchConfirmed] complete auto response with no search call
 * @property {import('../cost.js').BillableAttempt[]} [billableAttempts] provider-reported attempt and continuation usage
 * @property {number|null} [providerReportedChargeUsd] provider-supplied monetary total, separate from computed usage cost
 */

/** @typedef {'auth'|'quota'|'timeout'|'cancelled'|'other'} ProviderErrorKind */

/**
 * A provider failure, classified so the runner can drive its circuit breaker (§8.1)
 * and so `responses.error` stores something a human can act on.
 */
export class ProviderError extends Error {
  /**
 * @param {ProviderErrorKind} kind
 * @param {string} message short, safe, human-readable
 * @param {string} [detail] extra context — already scrubbed of anything key-shaped
 * @param {import('../cost.js').BillableAttempt[]|null} [billableAttempts] normalized usage, never a raw response
 */
  constructor(kind, message, detail = '', billableAttempts = null) {
    super(message);
    this.name = 'ProviderError';
    /** @type {ProviderErrorKind} */
    this.kind = kind;
    /** @type {string} */
    this.detail = detail;
    this.billableAttempts = billableAttempts;
    /** @type {ProviderResult|null} */
    this.partialResult = null;
  }

  /**
   * The form stored in `responses.error` — kind first so the UI can chip it.
   * @returns {string}
   */
  toStorage() {
    return this.detail ? `${this.kind}: ${this.message} — ${this.detail}` : `${this.kind}: ${this.message}`;
  }
}

/** How much of a provider error body we keep. Enough to diagnose, not enough to dump. */
const DETAIL_MAX = 200;

/**
 * Remove anything key-shaped from text before it can reach a log, an error or the DB.
 * Deliberately pattern-based rather than value-based: this runs in `shared.js`, which
 * never sees the config, so it cannot compare against the real key.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pplx|rk)-[A-Za-z0-9_\-]{6,}/g, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_\-]{10,}/g, '[redacted]');
}

/**
 * @param {string} body
 * @returns {string}
 */
function safeDetail(body) {
  const scrubbed = scrubSecrets(body).replace(/\s+/g, ' ').trim();
  return scrubbed.length > DETAIL_MAX ? `${scrubbed.slice(0, DETAIL_MAX)}…` : scrubbed;
}

/** @type {typeof globalThis.fetch} */
let currentFetch = globalThis.fetch;

/** @type {(ms: number) => Promise<void>} */
let currentSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Test hook (§15) — no test ever touches the live network. Pass nothing to restore.
 * @param {typeof globalThis.fetch} [fn]
 * @returns {void}
 */
export function _setFetch(fn) {
  currentFetch = fn ?? globalThis.fetch;
}

/**
 * Test hook — swaps the retry backoff sleep so retry tests run instantly.
 * Pass nothing to restore the real timer.
 * @param {(ms: number) => Promise<void>} [fn]
 * @returns {void}
 */
export function _setSleep(fn) {
  currentSleep = fn ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
}

/**
 * Jittered backoff, 2–8s (§5.1). Attempt 1 lands in 2–5s, attempt 2+ in 5–8s.
 * @param {number} attempt 1-based retry number
 * @param {() => number} [rand]
 * @returns {number} milliseconds
 */
export function backoffMs(attempt, rand = Math.random) {
  const lo = attempt <= 1 ? 2000 : 5000;
  const hi = attempt <= 1 ? 5000 : 8000;
  return Math.round(lo + rand() * (hi - lo));
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbort(err) {
  if (!err || typeof err !== 'object') return false;
  const name = /** @type {{name?: unknown}} */ (err).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * @typedef {Object} FetchResult
 * @property {number} status
 * @property {string} text raw response body
 * @property {unknown} json parsed body, or null when the body was not JSON
 * @property {number} retryCount prior HTTP 429 responses before this success
 * @property {import('../cost.js').BillableAttempt[]} priorAttempts prior rate-limited responses
 */

/**
 * Fetch with a hard timeout, one retry on an explicit rate limit, and error classification.
 *
 * Classification (§5.1): 401/403 → `auth`, 429 → `quota`, abort → `timeout`, else `other`.
 * Retried: 429. Network and 5xx failures may have happened after a provider accepted
 * the work, so replaying them could duplicate a logical target and unknown charges.
 *
 * The body is read inside the timeout window on purpose, so a stalled response stream
 * cannot outlive the abort signal. Hence the `FetchResult` return rather than a raw
 * `Response`.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {{timeoutMs: number, retries?: number,
 *   usageFromResponse?:(json:unknown)=>{inputTokens:number|null,outputTokens:number|null,searchCalls?:number|null},
 *   signal?:AbortSignal, maxResponseBytes?:number, deadlineMs?:number}} opts
 * @returns {Promise<FetchResult>}
 */
export async function fetchWithRetry(url, init, { timeoutMs, retries = 1, usageFromResponse, signal, maxResponseBytes, deadlineMs }) {
  let attempt = 0;
  /** @type {import('../cost.js').BillableAttempt[]} */
  const priorAttempts = [];
  for (;;) {
    if (signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled', '', priorAttempts);
    const attemptTimeoutMs = deadlineMs === undefined ? timeoutMs : Math.min(timeoutMs, deadlineMs - Date.now());
    if (attemptTimeoutMs <= 0) throw new ProviderError('timeout', 'Target time limit reached', '', priorAttempts);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    /** @type {FetchResult|null} */
    let result = null;
    /** @type {unknown} */
    let networkError = null;
    try {
      const res = await currentFetch(url, { ...init, signal: controller.signal });
      let text;
      if (maxResponseBytes === undefined || res.body === null) {
        text = await res.text();
      } else {
        const reader = res.body.getReader();
        /** @type {Uint8Array[]} */
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxResponseBytes) {
            await reader.cancel();
            throw new ProviderError('other', `Response exceeded ${maxResponseBytes} bytes`, '', [
              ...priorAttempts, { attempt, continuation: 0, inputTokens: null, outputTokens: null },
            ]);
          }
          chunks.push(value);
        }
        text = new TextDecoder().decode(Buffer.concat(chunks));
      }
      if (signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled', '', [
        ...priorAttempts, { attempt, continuation: 0, inputTokens: null, outputTokens: null },
      ]);
      /** @type {unknown} */
      let json = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      result = { status: res.status, text, json, retryCount: attempt, priorAttempts: [...priorAttempts] };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (isAbort(err)) {
        clearTimeout(timer);
        throw new ProviderError(signal?.aborted ? 'cancelled' : 'timeout',
          signal?.aborted ? 'Request cancelled' : `No response within ${attemptTimeoutMs} ms`, '', [
          ...priorAttempts, { attempt, continuation: 0, inputTokens: null, outputTokens: null },
        ]);
      }
      networkError = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }

    if (networkError !== null) {
      const message = networkError instanceof Error ? networkError.message : String(networkError);
      throw new ProviderError('other', 'Network request failed', safeDetail(message), [
        ...priorAttempts, { attempt, continuation: 0, inputTokens: null, outputTokens: null },
      ]);
    }

    const res = /** @type {FetchResult} */ (result);
    if (res.status >= 200 && res.status < 300) return res;

    const reported = usageFromResponse?.(res.json);
    const failedAttempt = {
      attempt, continuation: 0,
      inputTokens: reported?.inputTokens ?? null,
      outputTokens: reported?.outputTokens ?? null,
      ...(reported?.searchCalls !== undefined ? { searchCalls: reported.searchCalls } : {}),
      requestCompleted: false,
    };
    const failedAttempts = [...priorAttempts, failedAttempt];

    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('auth', `Rejected the API key (HTTP ${res.status})`, safeDetail(res.text), failedAttempts);
    }

    if (res.status === 429 && attempt < retries) {
      priorAttempts.push(failedAttempt);
      attempt += 1;
      const waitMs = deadlineMs === undefined ? backoffMs(attempt)
        : Math.min(backoffMs(attempt), Math.max(0, deadlineMs - Date.now()));
      await currentSleep(waitMs);
      continue;
    }

    if (res.status === 429) {
      throw new ProviderError('quota', 'Rate limited or out of quota (HTTP 429)', safeDetail(res.text), failedAttempts);
    }
    throw new ProviderError('other', `Unexpected HTTP ${res.status}`, safeDetail(res.text), failedAttempts);
  }
}

/**
 * Preserve previous rate-limited attempts when pricing a successful response.
 * Their token usage may be unknown even though the final attempt returned counts.
 * @param {FetchResult} response
 * @param {number|null} inputTokens
 * @param {number|null} outputTokens
 * @param {number|null|undefined} [searchCalls]
 * @returns {import('../cost.js').BillableAttempt[]}
 */
export function billableAttempts(response, inputTokens, outputTokens, searchCalls) {
  return [
    ...response.priorAttempts,
    { attempt: response.retryCount, continuation: 0, inputTokens, outputTokens, requestCompleted: true,
      ...(searchCalls !== undefined ? { searchCalls } : {}) },
  ];
}

/**
 * Normalise a chat-completions style `message.content`, which is a plain string on
 * every provider we call but is typed as string | content-parts | null.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const value = /** @type {{text?: unknown}} */ (part).text;
      return typeof value === 'string' ? value : '';
    })
    .join('');
}

/**
 * Coerce a usage number, returning null rather than a guess when the provider omitted it.
 * @param {unknown} value
 * @returns {number|null}
 */
export function usageNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Build the `tokens` field of a ProviderResult, or undefined when usage was absent (§4.3).
 * Never invents a count — an unknown token count must stay unknown so `cost_usd` stays null.
 *
 * @param {number|null} input
 * @param {number|null} output
 * @returns {{input:number,output:number}|undefined}
 */
export function tokensOrUndefined(input, output) {
  if (input === null || output === null) return undefined;
  return { input, output };
}

/**
 * Guard for a missing key. Adapters call this before building a request so the failure
 * is an `auth` error the circuit breaker understands, not a wasted 401 round-trip.
 *
 * @param {string} apiKey
 * @param {string} keyEnv env var name, e.g. 'OPENAI_API_KEY' — a name, never a value
 * @returns {void}
 */
export function requireKey(apiKey, keyEnv) {
  if (String(apiKey ?? '').trim() === '') {
    throw new ProviderError('auth', `${keyEnv} is not set`);
  }
}

/**
 * De-duplicate citation URLs, preserving first-seen order (§5.2, §6.3).
 * @param {unknown[]} raw entries may be URL strings or objects carrying a `url`
 * @returns {{url:string}[]}
 */
export function normalizeCitations(raw) {
  /** @type {{url:string}[]} */
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    /** @type {unknown} */
    let url = null;
    if (typeof entry === 'string') url = entry;
    else if (entry && typeof entry === 'object') url = /** @type {{url?: unknown}} */ (entry).url;
    if (typeof url !== 'string') continue;
    const trimmed = url.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({ url: trimmed });
  }
  return out;
}
