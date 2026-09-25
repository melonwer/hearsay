# Inspect search evidence

Open **Evidence** and select a measurement series, window, and buyer intent. The series
fixes the surface, execution profile, benchmark revision, analysis revision, comparison
key, and search policy. Its window uses UTC timestamps with an exclusive end. The
Prompts and Answers pages link to the same selected series and its receipts.

The report keeps five layers separate: the captured buyer question; search actions and
provider-exposed queries; source observations; explicit final-answer citations; and the
answer with brand interpretations and human corrections. A source row does not establish
that the answer cited it. A query or source belongs to an action only when the saved
action ID supports that link. A null link means the association is unknown. Source
observations can be filtered by `search_result`, `reported_source`, or `fetch`.

**Observed search queries** are samples from Hearsay's configured system. They do not
measure customer search volume. Query groups use Unicode NFC, trim outer whitespace,
and collapse internal whitespace. Case and punctuation remain distinct. Each group
shows its original wording, raw row count, and response incidence: distinct comparable
answers containing that query divided by comparable answers with exposed query rows.
The report also shows query-metadata coverage over all comparable answers. Missing
metadata does not mean a query was absent. A query repeated in one answer contributes
one to response incidence and each stored occurrence to the raw count.

Source observations and final-answer citations have separate URL groups and
provenance. URL grouping preserves query parameters and removes fragments. The original
URL and title remain in each receipt. The URL host is displayed when parseable; no
verified publisher field is stored, so publisher stays unknown, including for provider
redirect URLs. Hearsay does not resolve redirects while calculating this report.

Create a manual theme and assign it to observed query groups to organize evaluation
criteria. Theme counts deduplicate answers even when several assigned queries occur in
one answer. Themes never change the provider's query text or imply search demand.
Every group lists the exact answer receipt IDs behind its counts. Receipt details show
capture time, model and profile, the original question, stored evidence IDs, answer
text, original stance, effective stance, and correction history.

Read the same report through `GET /api/series/evidence?series_id=...&intent_id=...` or
the read-only `hearsay_intent_evidence` MCP tool. Omit `intent_id` to list intents in
the selected series. `GET /api/answers/:id/evidence?series_id=...` and the read-only
`hearsay_answer_evidence` tool return one scoped receipt. Both API routes accept `days`
or an explicit `start` and `end` UTC window, as do the corresponding MCP tools. Manual
themes are managed through `GET/POST /api/query-themes` and
`POST /api/query-theme-assignments`.
