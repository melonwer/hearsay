# Outcome records and weekly review design

## Caller's view

An operator selects one known measurement series and a seven-day UTC window. The same saved observations and reported records feed the page, JSON API, Markdown download, and read-only MCP report. A week with no observations still displays collection health for that selected series. CSV imports require a source and stable import ID; each row has a source record ID.

```js
const receipt = importOutcomeCsv(db, { source, importId, csvText, author, now });
const report = buildWeeklyReview(db, { seriesId, start, end, now });
const markdown = renderWeeklyMarkdown(report);
```

## Shape

The v13 schema keeps import batches, outcome rows, and time or expense entries separate. Import batches retain the raw CSV and a content digest. `(source, import_id)` identifies a batch; `(source, record_key)` identifies a row across batches. Replaying the same identity and content is a no-op. Changed content under the same identity conflicts. An explicit superseding row corrects an earlier row while preserving both. Current reports read the active row and the full export retains the history.

`core/outcomes.js` owns CSV parsing, validation, atomic imports, idempotency, overlap flags, and safe CSV export. It returns reported records without summing overlapping periods or currencies. `core/weekly-review.js` owns historical series identity lookup, exact-window coverage and costs, same-series opportunities across older windows, saved intervention reviews, and the single report object. UI/API/MCP adapters select scope and render that object; none call a provider.

The report keeps computed API spend, subscription allowance, user-reported expenses, time, and business outcomes in separate fields. Missing data stays unknown. It makes no ROI or causal claim.

## Synthesis decision

The record-first design is the base because it resolves a known series into an empty week and carries precise money and raw-input provenance. The competing design supplied cross-import row identity and one report object for every output format. A stored weekly-report snapshot was rejected because corrections and changed priorities would make it stale. A generic financial-event table was rejected because callers would have to enforce different outcome, time, and expense rules.

## Accepted tradeoffs and risks

- Imports require stable IDs so retries and overlapping exports can be checked.
- Reports list overlapping records without a combined total, preserving source meaning.
- Historical opportunity reads use a bounded summary query to avoid hydrating every saved evidence tree.
- A strict CSV template is simpler to audit than a field mapper; the page provides the required header.

The first implementation step is v13 storage and atomic import validation, followed by the exact-series report and adapters.
