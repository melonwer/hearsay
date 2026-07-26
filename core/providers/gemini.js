/**
 * Google Gemini adapter (§5.2). Phase 1 Lane A.
 *
 * Contract: `async runPrompt(text, {model, timeoutMs}) → ProviderResult`.
 * Endpoint (`:generateContent`), the `x-goog-api-key` header and the exact model id are
 * [VERIFY-AT-BUILD] against https://ai.google.dev/gemini-api/docs — the default model
 * lives in core/config.js and is env-overridable via GEMINI_MODEL. Gemini exposes no
 * native citations, so only markdown links in the answer text are extracted.
 * Unit-tested against test/fixtures/gemini.json, never the live API.
 */
export {};
