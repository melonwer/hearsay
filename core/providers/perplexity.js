/**
 * Perplexity adapter (§5.2). Phase 1 Lane A.
 *
 * Contract: `async runPrompt(text, {model, timeoutMs}) → ProviderResult`.
 * OpenAI-shaped request; the only provider with native citations, so map the response's
 * citations / search_results array to `{url}[]`. Endpoint path and response field names
 * are [VERIFY-AT-BUILD] against https://docs.perplexity.ai — as of 2026-07-26 their docs
 * carry a migration notice ("Sonar Chat Completions is now Agent API") and show both
 * `/chat/completions` and `/v1/sonar` paths, so confirm the current search-grounded path
 * before implementing. Default model `sonar` lives in core/config.js (env: PERPLEXITY_MODEL).
 * Unit-tested against test/fixtures/perplexity.json, never the live API.
 */
export {};
