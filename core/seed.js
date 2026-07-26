/**
 * Deterministic demo universe generator (§12).
 *
 * Phase 1 Lane D implements it: mulberry32 seeded with 1337, the invented Notewell /
 * Jotta / EchoPad / Quillo universe, 5 intents × 2–3 paraphrases, 30 days × 4 providers
 * × 12 prompts × 3 samples, scripted storylines that produce one MENTION_DROP, one
 * OVERTAKEN and one lost/gained recommendation. Template answers go through the real
 * analyzeResponse() and the same DB writes as a live run, with runs.trigger='seed'.
 * No real brand names, ever (§19.5 #8).
 */
export {};
