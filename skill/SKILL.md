---
name: hearsay-ai-visibility
description: Operate and interpret a local Hearsay AI-visibility tracker via its
  MCP tools (hearsay_*) — set up brand tracking, generate prompt panels, run
  measurements, and report share of AI voice / brand mentions in ChatGPT, Claude,
  Gemini and Perplexity with honest statistics (confidence intervals, n, phrasing
  spread). Use for AI visibility, GEO, AI SEO, LLM brand monitoring questions.
---

# Operating Hearsay

## First move — always

Call `hearsay_status` before anything else, then branch:

- **Unreachable** → tell the human to start it: `node server.js` in the hearsay
  directory (needs Node ≥ 22.13), then retry.
- **`configured: false`** → run the onboarding playbook below.
- **Configured** → call `hearsay_series_list` and use its selected series ID with
  `hearsay_series_summary`. Pass the same ID to `hearsay_answers_search` for receipts.
  Use the older `hearsay_summary` only when the human asks for legacy API reporting.

## Onboarding playbook (unconfigured instance)

1. Ask the human at most two questions: their brand (+ domain), and their main
   competitors. Ask for a category description only if it isn't obvious.
2. `hearsay_suggest_prompts` with what you learned.
3. **Show the full draft** — every intent and paraphrase — and ask what to keep.
   **HARD RULE: never call `hearsay_setup_tracking` with prompts the human has
   not seen in this conversation.** The draft is a draft; the human decides.
4. `hearsay_setup_tracking` with the approved set (brand + competitors + intents).
5. `hearsay_run_panel` `{}`. If it returns `quote_required`, relay the calls and
   estimated cost and get an explicit yes before calling again with
   `confirm: true`. **Never confirm spend the human hasn't approved in this
   conversation.**
6. Poll `hearsay_run_status` until `done`. Call `hearsay_series_list`, then report
   `hearsay_series_summary` for the selected series using the rules below.

## Honesty rules (bind your narration, not just the UI)

- Every rate carries its n: "58% ± 7 (n=36)", never "58%".
- Name the selected surface, search policy, benchmark, analysis revision, and window.
  Report attempted targets and comparable answers separately.
- A source observation, a final-answer citation, and a brand mention have separate
  rates. An answer without exposed queries has missing metadata, not zero queries.
- When an intent has multiple paraphrases, state the phrasing spread: "phrasing
  spread ±19 pts — how you ask matters more than rerun noise."
- n < 5 → say "low sample, directional at best".
- Days without runs are gaps, not zeros. Never interpolate.
- Demo mode data is fictional — say so every time you quote it.
- **Never invent a blended "AI visibility score", a rank position, or a prompt
  volume estimate — even if asked.** Hearsay refuses these on purpose (they're
  not measurable honestly). Explain that and offer share of voice, mention rate
  with CI, and receipts instead.
- An API series measures that provider's API. A Codex or Claude Code agent series
  measures that signed-in CLI route. Neither measures the logged-in consumer app.

## Weekly report recipe

Start with `hearsay_series_list`. Use one series ID for `hearsay_series_summary`,
`hearsay_intent_results`, `hearsay_citation_gap`, and 2–3 receipts from
`hearsay_answers_search`. The citation gap uses legacy citation rows, so label
that evidence layer. The alerts tool lacks an exact series filter. If you include
an alert, label it as run-level context and check its receipt against the series.

```
## AI visibility — week of {date}
**Series:** {surface}, {search policy}, {benchmark}, {analysis revision}, {window}
**Coverage:** {comparable}/{attempted} targets; {query metadata count} expose queries
**Share of voice:** {sov}% of tracked-entity mentions
**Mention rate:** {p}% ± {ci} (n={comparable answers})
**Recommendation method:** {positive stance or legacy heuristic}; {p}% (n={comparable answers})
**Evidence:** {source incidence}, {answer citation incidence}
**Receipts:** {2 short answer quotes, surface + date, one positive and one negative or uncertain}
```

## Alert triage

- `LOST_RECOMMENDATION` (serious): find the receipt via `hearsay_answers_search`
  (filter to that prompt + provider), quote what the AI says now, suggest checking
  what changed on the cited pages.
- `OVERTAKEN` (warning): compare intent results for you vs that competitor;
  which intents flipped?
- `MENTION_DROP` (warning): check `hearsay_run_status`/provider errors first —
  a failed provider looks like a drop.
- `GAINED_RECOMMENDATION` (good): quote the receipt; note what page got cited.
- Ack with `hearsay_ack_alert` only after the human has seen it.

## GEO playbook (honest version)

- Pass the selected series ID to `hearsay_citation_gap`. Its counts use legacy
  citation rows. Check the selected series export for the source and final-answer
  citation records before proposing an action.
- For `comparison` intents you lose: a fair, factual comparison page is the
  highest-leverage asset.
- After shipping content, compare the same benchmark and execution profile in
  separate windows. If either changes, report the results as incomparable.
- Watch competitor prompt-space with `hearsay_prompt_results`: which prompts
  do they lead, and with what recommendation rate?

## Troubleshooting

- Provider `auth`/`quota` errors in status/summary → that provider's key in
  `.env` (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY /
  PERPLEXITY_API_KEY); a provider is enabled iff its key is set.
- `demo_mode` errors → the instance runs fictional demo data; set
  `HEARSAY_DEMO=0` and add a key to go live.
- Keys are only ever spent on measurement runs — reading results is free.

Install: copy this folder to `~/.claude/skills/hearsay-ai-visibility/`.
