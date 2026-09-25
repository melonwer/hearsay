# Reported outcomes and weekly review

Open **Weekly review**, choose one exact measurement series, and select a seven-day UTC window. The report reads saved observations and local records on demand. Opening or exporting it does not run a provider or change a schedule. A known series can be reviewed even when that week has no observations; the report says collection was absent.

The report shows comparable target coverage, linked answer receipts, up to three user-prioritized opportunities, shipped actions due for review, and saved descriptive intervention judgments. It keeps business outcomes, API computed spend, subscription allowance, user expenses, and time in separate sections. A known subtotal is not a full bill when some calls have unknown costs. Subscription allowance has no dollar value unless you enter a billed amount. The report does not calculate ROI or attribute conversions to an intervention.

## Enter outcomes

Add a manual record with a source, stable record ID, half-open UTC period, metric name, value, unit, optional currency and landing page, attribution method, and notes. `count` values must be whole nonnegative numbers. Monetary values use unit `money` with an uppercase supported currency code. Analytics referrals, qualified leads, purchases, and self-reported discovery should be separate metrics and should state how each was attributed. These are user-reported values, not verified traffic or sales.

For a CSV import, provide a source and stable import ID, then paste a UTF-8 CSV with this exact header:

```csv
record_id,period_start,period_end,landing_page,metric_name,value,unit,currency,attribution_method,notes,supersedes_id
```

Use a stable `record_id` from the source export. Reusing the same source/import ID and CSV is a no-op. A repeated source/record ID with identical content is also a no-op across batches; changed content under the same ID is a conflict. The full CSV is retained in the local database. A malformed row rejects the entire import. Quotes, commas, and embedded line breaks follow standard CSV quoting.

To correct a record, create a new record ID and set `supersedes_id` to the earlier Hearsay outcome row ID. The old row stays in the full export; current weekly reviews use the active successor. Overlapping active periods with the same source, metric, unit, currency, landing page, and attribution method are flagged. The report lists them separately and never silently sums them.

## Record effort and costs

Enter time in minutes under an activity such as implementation or review. Enter an expense with its own currency; an unknown billed amount can remain blank. A ledger entry may link to an opportunity, but an unlinked workspace expense is not assigned to a measurement series by date alone. Different currencies are not converted or added without a supplied basis.

JSON, Markdown, and HTML weekly-review exports use the same selected report object. Outcome CSV export includes active and superseded rows and neutralizes spreadsheet formula prefixes in text cells. Exports are local downloads; Hearsay does not send email or webhooks from this workflow.

## API and assistant access

Call `GET /api/series` first, then pass one returned `series_id` with explicit
`start` and `end` UTC timestamps to
`GET /api/weekly-review?series_id=...&start=...&end=...`. The window must span seven
days and the end is exclusive. `GET /api/weekly-review/export` takes the same
selection and a `format` of `json`, `markdown`, or `html`. The read-only
`hearsay_weekly_review` MCP tool uses the same three selection fields.

The Weekly review form sends manual records to `POST /api/outcomes`, CSV batches to
`POST /api/outcomes/import`, and time or expense entries to `POST /api/ledger`.
`GET /api/outcomes/export` downloads the saved outcome CSV. These write routes
record what the user supplied; they do not call an inference provider, verify a
conversion, or approve a new measurement run.
