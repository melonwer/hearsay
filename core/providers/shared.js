/**
 * Shared provider plumbing — timeout, retry, error classification (§5.1).
 *
 * Phase 1 Lane A implements:
 *   ProviderError (kind: 'auth'|'quota'|'timeout'|'other', detail)
 *   fetchWithRetry(url, init, {timeoutMs, retries = 1})  — AbortController; retry once
 *     on 429/5xx/network with 2–8s jittered backoff; 401/403 → auth, 429 → quota,
 *     abort → timeout, else other
 *   _setFetch(fn) — test hook, so no test ever touches the live network (§15)
 *
 * Methodology-critical (§5.1): the prompt is sent as a single user message with no
 * system prompt and no temperature override. Errors must never include the API key.
 */
export {};
