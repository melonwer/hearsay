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
