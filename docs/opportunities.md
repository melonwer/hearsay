# Review evidence-backed opportunities

Open **Opportunities** after Hearsay has stored comparable answer receipts. Choose a measurement series, a UTC window, and a buyer intent. The page reads those receipts and displays candidate investigations. Reading the page does not start a model call or save a candidate.

## Save a candidate

Review its answer, query, and source IDs. Click **Save this investigation** on each candidate you want in your shortlist. Repeated source appearances without the brand and user-assigned query themes need at least two distinct comparable answers from two completed runs in the selected window. An explicit negative or uncertain brand statement can appear from one completed answer. These rules select work for review; they do not measure importance or explain why a model answered as it did.

To start from one receipt, follow **Create an investigation** on the Evidence page. Check the selected IDs and add your hypothesis. Hearsay derives the observed finding from the receipt IDs and keeps your interpretation separate. A missing brand mention does not show that a website lacks a capability. If an answer appears false or outdated, select the claim checkbox. Hearsay labels it `verify_claim` until you supply and review authoritative evidence.

## Review the shortlist

Set a priority from 0 to 3, choose an effort band, assign an owner, and set a review date. A planned action needs an owner and review date. The list sorts by your priority, then effort, then recent activity. Choose **Dismissed** or **No action** with a reason when you do not want to pursue a candidate. You can combine two records in the same series, window, and intent. Both records and their review events remain available.

A dismissed pattern stays dismissed when generation sees the same receipts. If a new supporting answer is captured after dismissal, the candidate reappears with its new answer ID and an explanation. A combined record stays combined. Hearsay does not start a measurement run, publish a page, or send outreach from an opportunity.

## Attach page evidence before planning a page change

Add the page URL, UTC observation time, and an excerpt of at most 2,000 characters. Choose whether you supplied it, an assistant supplied it, or it came from an already recorded fetch. A recorded fetch must match the selected source ID, URL, observation time, and stored excerpt. Manual excerpts remain manual evidence; they are never labeled as provider retrieval. Review the excerpt, then choose **Specific page change** and **Planned**. For an alleged false or outdated claim, mark a user-supplied excerpt as authoritative before review. Without the required evidence, keep the action as an investigation or a request to verify the claim.

An MCP client can call `hearsay_opportunity_propose` with exact response and child record IDs. Hearsay validates the IDs and stores the assistant's hypothesis as **Pending**. A person accepts or dismisses the proposal in Opportunities. The client cannot turn its own proposal into a planned action.

## Record a shipped action and follow-up

Choose an owner, review date, target URL or product area, and estimated effort before moving an action to **Planned**. Add a follow-up plan with its primary metric, expected direction, selected buyer intents, optional comparison intents, baseline window, review window, and observation delay. The baseline must use comparable answers from the opportunity's saved series and benchmark. The delay is your observation choice; it does not establish when a search engine indexed a change.

After the change is live, choose **Shipped** and record what changed, the UTC publication time, and actual effort. This records your action only. It does not publish anything, start a paid run, or change a schedule. Hearsay flags a baseline chosen after publication as retrospective and warns when its window includes time after publication.

When the review window has started, capture existing observations. Hearsay saves the exact comparable answers, current stance decisions, data cutoff, model/profile/benchmark variants seen in the window, and whether the window is still in progress. An empty capture is valid evidence of insufficient observations; it is not a completed measurement result. You can preview a separate run through Hearsay's existing run quote controls, then decide whether to authorize it. Capturing a follow-up never authorizes that run.

Changing the plan or a date creates a new plan version or action event. Earlier baseline and review snapshots stay available. A stale form returns a conflict so you can refresh before editing. The `hearsay_opportunity` MCP tool reads these records; it does not change them.

## Compare a saved review with its baseline

Open a saved review snapshot under **Follow-up plans**. Hearsay starts with the full saved prompt benchmark. It shows the selected metric's answer counts, equal-weight prompt rate, each prompt's Wilson interval, target and metadata coverage, and query, source, and citation incidence for both windows. Missing prompt cells, changes to the execution profile or benchmark, incomplete coverage, and other shipped actions appear beside the numbers. An unavailable rate stays unavailable; Hearsay does not replace it with zero.

Choose **Common prompt subset** to inspect only prompts with answers in both windows. The report names each dropped prompt cell. This selection is a separate view of the same frozen snapshots and never changes the saved full benchmark. A partial review window or a changed analysis revision can leave the result insufficient or incomparable. Optional comparison intents assume that you left them unchanged; Hearsay cannot verify that assumption.

The report describes an observed increase, decrease, no difference, insufficient data, or an incomparable selection. It does not attribute a change to your action. After reading the report, choose **Promising**, **Not useful**, or **Inconclusive** and write a rationale. Only that explicit human review moves the shipped action to **Reviewed**. The saved judgment keeps the exact report and selection mode. Reading a report or saving a review does not start a provider run.

The JSON route `GET /api/opportunities/:id/follow-up/:plan_id/reviews/:snapshot_id/comparison` reads the full saved benchmark. Add `?mode=common_subset` for the explicit subset. The `hearsay_intervention_comparison` MCP tool exposes the same read-only report. `POST /api/opportunities/:id/follow-up/:plan_id/reviews/:snapshot_id` records a human judgment with `expected_version`, `judgment`, `rationale`, and optional `mode`.
