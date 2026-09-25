# Implementation acceptance and review handoff

This is the local review record for the implementation-plan batch from
`d7c9573a8ed045cd5727be4a6cc2e900898a6856` through the current local
`main`. It describes deterministic fixtures and browser checks. It does not record
a live provider smoke check, deployment, or provider bill.

## User outcome

A person can review a buyer-question benchmark, select one API or signed-in agent
route, inspect the answer and search evidence for an exact series, save a reviewed
investigation, record a shipped change, compare saved windows, and add reported
business outcomes to a weekly review. The demo has a separate database and can be
left without deleting real data.

## Contract and compatibility

Search is explicit on validated OpenAI and Anthropic API profiles. The old API
schedule stays search off until separate consent. Subscription runs retain their
own required-search profiles and first-use consent. Attempts, completed answers,
comparable answers, search actions, queries, returned sources, final citations,
stance, and usage have separate records and denominators. Legacy records remain
readable after migration; they do not gain invented evidence or new series metadata.
Changed benchmark, model, profile, search policy, or analysis revision starts a
different series. The export contains the saved evidence, opportunity, follow-up,
outcome, and ledger records. A migration creates a recoverable database backup.

The built-in price table is checked data, versioned `2026-09-24-standard`.
Computed API usage cost is separate from a provider bill and subscription allowance.
Known subtotals remain partial when any supported billing component is unknown.
OpenAI hosted web search has no enforceable internal call ceiling.

## End-to-end evidence

The scripts use local temporary databases and fake provider data. They do not call a
live model. `node --test` exercises the narrower provider and storage cases.

| ID | Observable result | Evidence |
|---|---|---|
| E01 | Fresh subscription-only setup approves three questions, previews and consents to a fake Codex run, then opens its dashboard, evidence, and a saved opportunity. | `scripts/verify-benchmark-setup.js` |
| E02 | A quoted OpenAI required-search run saves source and citation records, usage, and a selectable dashboard series. | `test/api.test.js`, OpenAI search run |
| E03 | An upgraded database keeps old answers; startup makes no catch-up provider call and the old schedule selects search off. | `test/measurement-storage.test.js`, upgrade/restart case |
| E04 | Completed search can have unavailable query wording. The evidence report does not reconstruct it. | `test/openai-search.test.js`, `test/evidence-report.test.js` |
| E05 | Provider-confirmed no-search auto answers remain in the auto series. | `test/openai-search.test.js`, `test/series-metrics.test.js` |
| E06 | Failed, absent, or incomplete required search remains inspectable and outside the comparable denominator. | `test/openai-search.test.js`, `test/series-metrics.test.js` |
| E07 | Returned source and different final citation retain separate URLs and receipt IDs. | `test/providers.test.js`, `test/evidence-report.test.js` |
| E08 | Continuation and retry preserve one target, known usage from each attempt, and one recorded search action/query per observed action. | `test/anthropic-search.test.js`, `test/providers.test.js` |
| E09 | A discouraged brand has no positive stance and a human can append a correction. | `test/analyze.test.js`, `test/interpretations.test.js` |
| E10 | Prompt, alias, profile, policy, and analysis changes split the relevant revision or series. | `test/measurement-contract.test.js`, `test/series-metrics.test.js` |
| E11 | A receipt-backed investigation, reviewed page evidence, shipped action, and follow-up plan survive the browser journey. | `scripts/verify-opportunities.js` |
| E12 | The saved comparison names missing cells or incompatible profiles and offers an explicit common subset. | `test/opportunities.test.js`, `scripts/verify-opportunities.js` |
| E13 | Weekly review shows user-reported outcomes and partial costs without inferring ROI or running a provider. | `test/weekly-review.test.js`, `scripts/verify-weekly-review.js` |
| E14 | Provider markup remains text, unsafe links have no clickable target, and the browser/server never request a local beacon. | `test/api.test.js`, `scripts/verify-untrusted-evidence.js` |
| E15 | Migration then interrupted-run recovery preserves old answers, marks the target failed, and records one missed scheduled occurrence. | `test/measurement-storage.test.js`, upgrade/restart case |
| E16 | Demo-to-real browser flow submits the real setup form, preserves the separate demo database, and uses no live provider. | `scripts/verify-instance-health.js`, `test/instance.test.js` |

## Review checklist

- [x] Enabled search routes require explicit configuration and provider-confirmed evidence.
- [x] Displayed query wording comes from provider evidence; missing wording stays unavailable.
- [x] Queries, results, fetches, final citations, and stance are separate records.
- [x] Failed and partial targets remain visible and do not become brand absences.
- [x] Subscription-only results can be followed through setup, dashboard, evidence, and opportunities.
- [x] Exact-series rates and receipts use the same scope and answer denominator.
- [x] Search policy, execution profile, benchmark, and analysis revision changes split series.
- [x] Negative and uncertain statements do not become positive stance through list position.
- [x] Upgrade, report reads, and follow-up capture do not authorize new provider spend.
- [x] Known attempt and continuation usage is retained; unknown cost remains explicit.
- [x] Opportunity records separate observed facts, reviewed page evidence, and hypotheses.
- [x] Accepted and shipped actions do not publish or trigger an automatic run.
- [x] Follow-up comparisons expose coverage and avoid causal claims.
- [x] Reported outcomes carry source, unit, and time window.
- [x] Demo setup does not delete or contaminate real data.
- [x] Full tests, typecheck, browser flows, and diff check pass at the C17 review boundary.

## Limits and next work

Gemini grounded search is disabled while C06 awaits legal review. Perplexity Sonar
remains a legacy built-in retrieval route with no exposed exact query wording or
per-action search completion. Anthropic `required` search is unsupported. C03 still
needs its remaining usage-accounting and budget acceptance work before the Release A
and overall release gates can be checked. No live provider capability or billing smoke
check has been performed. Local browser screenshots show wide light/dark and 390 px
layouts; these are synthetic demo or fake-adapter observations.
