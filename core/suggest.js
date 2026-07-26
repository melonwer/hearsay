/**
 * Intent and paraphrase generator (§6.7).
 *
 * Phase 1 Lane B implements the pure post-processing (dedupe, ≤300 chars, strip
 * numbering, tag prompts containing the brand name or its aliases as `branded`) and
 * Lane A/B together wire the single LLM call through the first enabled provider with
 * one retry on parse failure. Nothing auto-saves: the caller reviews a checklist first.
 * With zero keys configured the flow falls back to the static starter pack (§20.3).
 */
export {};
