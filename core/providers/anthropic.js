/**
 * Anthropic (Claude) adapter (§5.2). Phase 1 Lane A.
 *
 * Contract: `async runPrompt(text, {model, timeoutMs}) → ProviderResult`.
 * Endpoint, headers (`x-api-key`, `anthropic-version`) and the exact model id are
 * [VERIFY-AT-BUILD] against https://platform.claude.com/docs — the default model lives
 * in core/config.js and is env-overridable via ANTHROPIC_MODEL. Unit-tested against
 * test/fixtures/anthropic.json, never the live API.
 */
export {};
