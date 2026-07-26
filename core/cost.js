/**
 * Price table and run-cost estimator (§4.3).
 *
 * Phase 1 Lane A implements estimateRunCost() and the per-provider price table. Two
 * binding rules: every price is [VERIFY-AT-BUILD] against the provider's live pricing
 * page at implementation time and overridable via HEARSAY_PRICE_<PROVIDER>_IN/_OUT, and
 * an unknown model yields a null cost — never a guessed one. Cost figures shown anywhere
 * in the product or docs come from this module's output only (§19.6 #13).
 */
export {};
