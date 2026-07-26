/**
 * Provider registry — the adapters for the providers enabled by env (§5).
 *
 * Phase 1 Lane A wires each adapter's `runPrompt(text, {model, timeoutMs})` to the
 * config.providers registry (core/config.js already resolves labels, models, and
 * enabled-ness from the environment).
 */
export {};
