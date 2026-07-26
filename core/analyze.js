/**
 * Analyzer — PURE functions, no I/O (§6, §19.6 #6).
 *
 * Phase 1 Lane B implements:
 *   analyzeResponse(text, entities, nativeCitations = []) → {mentions, citations}
 *
 * Mention detection (§6.2): alias list per entity, longest-alias-first matching with
 * span consumption, word boundaries on both sides, optional possessive, regex-escaped
 * aliases, offsets recorded against the raw text, ±120-char snippets, 1-based rank.
 * Citations (§6.3): markdown + bare URLs plus native citations, deduped, domain
 * www-stripped and lowercased, entity matched via entities.domains including subdomains.
 * Recommendation detection (§6.4): R1 trigger proximity, R2 list leadership,
 * R3 short-answer lead — deterministic, unit-tested, no ML sentiment.
 */
export {};
