# Optional dashboard connection

## Start with status and scope

Call `hearsay_status` first. If the server is unreachable, ask the user to start
`node server.js` in the Hearsay directory, then retry. If no benchmark is configured,
use the setup steps below. Otherwise call `hearsay_series_list` and choose an explicit
series with the user. Record its surface, model and execution profile, search policy,
benchmark revision, analysis revision, and UTC window. Use the same `series_id` and
window for every summary, evidence receipt, opportunity, and weekly report. An API
series, Codex agent series, and Claude Code agent series are separate observations.

For a new workspace with no results, explain that a benchmark can be reviewed before
any measurement route is enabled. Do not present empty rates as zero.

## Set up a reviewed benchmark

1. Ask for the brand, buyer, product job, desired conversion, and optional competitors.
   Language and market guide question writing; they do not set provider locale.
2. Ask where the buyer questions came from. Keep sales and support material in local
   source notes. Use `hearsay_suggest_prompts` for an editable starter if useful.
3. Save a draft with `hearsay_create_benchmark_draft`. Call
   `hearsay_review_benchmark_draft` and show every selected question, category,
   validation issue, and API and subscription target count. Call
   `hearsay_approve_benchmark_draft` only after the person reviews that exact revision.
   Exploration questions remain discovery evidence until separately promoted.
4. Choose one enabled route and a small panel. For an API route, configure only a
   supported model and search policy. Call the read-only `hearsay_cost_estimate`
   before `hearsay_run_panel`; a small search-off run can start immediately when
   the run tool is called. Show target count, search assumptions, known and unknown
   cost, and the selected profile. Call the run tool only after the person approves
   this run. If it returns `quote_required`, show that binding quote and pass its
   `quote_id` with `confirm: true` after approval.
5. For a subscription-only workspace, select `codex-agent`, `claude-code-agent`, or a validated `agy-cli` with `hearsay_subscription_preview`. Show the exact targets,
   process limits, plan allowance and possible overage. The internal CLI search count
   has no hard ceiling. Use `hearsay_subscription_run` only after the person approves
   that preview and any first-use consent. This route needs no API key.
6. Poll `hearsay_run_status`, then call `hearsay_series_list` again and select the
   new exact series. Scheduled API search and scheduled subscription runs require
   separate consent through their schedule tools; a manual run does not grant it.

## Read evidence without inventing it

- Give each rate its scope, numerator, denominator, and interval when available. Say
  "low sample" when fewer than five comparable answers support a rate. Report attempted,
  completed, and comparable targets separately. A failed or incomplete answer is not
  a brand absence; days without runs are gaps.
- Use `hearsay_series_summary` for current rates and
  `hearsay_answers_search` or `hearsay_answer_evidence` for receipts. The older
  `hearsay_summary`, citation-gap report, and heuristic recommendation values are
  legacy views. Name their different evidence layer if the user requests them.
- A confirmed `auto` answer without search can enter its own auto series. A required
  search needs a completed provider-confirmed event. If a provider hides query text,
  report "query wording unavailable." Never reconstruct a query from the answer,
  search results, or citation URLs. Missing query metadata is not zero queries.
- A returned source, a fetched page, and a final-answer citation are different
  records. A positive recommendation requires positive stance, not merely a brand
  mention or position in a list. Inspect the rule and answer span; use
  `hearsay_correct_stance` only with a person's reason after review.
- Branded questions measure recall. Non-branded questions support discovery rates.
  Query incidence describes this configured panel, not buyer search volume.
  Demonstration data is fictional. Neither agent CLI route measures a consumer app.

## Weekly evidence-to-action review

1. Select one historical series and an exact seven-day UTC window. Call
   `hearsay_weekly_review` and `hearsay_series_summary` for that same scope.
   Report comparable coverage, mention and positive-stance rates with their
   denominators, query-metadata coverage, source incidence, and final citation
   incidence. Check two or three receipts, including an absence or uncertain answer.
2. Use `hearsay_intent_evidence` and `hearsay_opportunities` for a specific intent.
   Describe the observed answer or repeated gap and its receipt IDs. Label a possible
   explanation as a hypothesis. An assistant may call `hearsay_opportunity_propose`,
   but a person must accept it in Opportunities. A page-change plan requires reviewed
   page evidence. Proposing an action does not publish a page or run a provider.
3. For a shipped action, read its saved baseline and review through
   `hearsay_opportunity` and `hearsay_intervention_comparison`. Start with the full
   benchmark. If coverage differs, a person may choose the common-prompt subset;
   name every excluded prompt. State insufficient or incomparable results as such.
   An observed increase does not prove that the action caused it.
4. Include only outcomes the user entered, with source, unit, period, and attribution
   method. Report time and expenses separately from API computed cost and subscription
   allowance. A known subtotal with unknown charges is partial. Do not calculate ROI
   or infer leads from mentions. Reading a weekly report makes no provider call.

Use this report shape:

```text
Week: [UTC start, end); exact series: [surface, profile, policy, benchmark, analysis]
Collection: [comparable / attempted targets], [query-metadata coverage], [gaps]
Rates: [mention n/denominator and interval], [positive stance n/denominator and interval]
Evidence: [source incidence], [final citation incidence], [receipt IDs]
Actions: [accepted or shipped records], [baseline/review status], [descriptive result]
Reported outcomes: [source, value, unit, period, attribution method]
Costs: [computed API subtotal and unknown parts], [subscription usage], [user expenses/time]
Next review: [owner and date, or no action]
```

## Troubleshooting

Check `hearsay_status` for disabled routes, unsupported profiles, failed runs,
missing consent, or stale collection. API keys live in the local `.env`; the
subscription CLIs use their own signed-in sessions. Registering the MCP server lets
an assistant operate Hearsay but does not enable that assistant as a measurement
runner. Antigravity account measurements and Gemini API grounding are separate routes. The fictional
demo has its own database; set `HEARSAY_DEMO=0` and restart for real setup. Leave
both databases intact.

Import a standalone bundle with `hearsay import <evidence.json> --database <explicit-path>`, `POST /api/research/import`, or `hearsay_research_import`. Imported records retain external provenance and remain separate from native measurements. Read them with `hearsay_research_list` and `hearsay_research_get`.

Antigravity measurements extract observed `search_web` calls and completed outcomes from mixed event streams. Other tool activity stays in the trace. Installation and login availability do not prove a completed search; eligibility uses the captured answer, search outcome and session context.
