/**
 * Alert rules engine (§9).
 *
 * Phase 1 Lane B implements evaluate(runId): LOST_RECOMMENDATION, GAINED_RECOMMENDATION,
 * OVERTAKEN and MENTION_DROP, each requiring two comparable prior runs, with a 7-day
 * dedup rule and a detail line that always carries the numbers behind the claim.
 */
export {};
