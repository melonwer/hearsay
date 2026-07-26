/**
 * Metrics — read-only SQL, returns plain objects, PURE apart from those reads (§7, §19.6 #6).
 *
 * Phase 1 Lane B implements mentionRate, shareOfVoice, sovTrend, providerBreakdown,
 * recommendationRate, avgRank, citationShare, intentTable, promptTable, citationGap
 * and actualSpend.
 *
 * Binding rules: window defaults to 30 days and always excludes error rows; every rate
 * ships with n (rates with n < 5 are flagged low-sample); the Wilson 95% interval is
 * computed exactly as specified in §7 (anchor: mentioned=17, n=50 → p=0.34,
 * lo≈0.2244, hi≈0.4785); trend days with zero valid responses are OMITTED, never
 * zero-filled (§19.6 #10); prompts in category 'branded' are excluded from SOV
 * denominators unless {includeBranded:true}.
 */
export {};
