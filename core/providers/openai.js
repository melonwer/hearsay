/**
 * OpenAI (ChatGPT) adapter (§5.2). Phase 1 Lane A.
 *
 * Contract: `async runPrompt(text, {model, timeoutMs}) → ProviderResult`.
 * Endpoint, request shape and the exact model id are [VERIFY-AT-BUILD] against
 * https://developers.openai.com/api/docs — the default model lives in core/config.js
 * and is env-overridable via OPENAI_MODEL. Unit-tested against test/fixtures/openai.json,
 * never the live API.
 */
export {};
