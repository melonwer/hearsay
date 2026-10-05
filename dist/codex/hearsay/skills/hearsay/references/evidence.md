# Version-one evidence contract

Normative shapes: [project.schema.json](../schemas/project.schema.json), [evidence.schema.json](../schemas/evidence.schema.json). Replace template identities and empty collections with actual observations. A schema-valid empty bundle is not completed research.

Project files hold identity, discovery evidence, immutable panel/execution/analysis revisions, selected routes and tracking preferences. Runs embed revision snapshots for independent import. Save evidence.json and derive report.md. Optional trace.jsonl contains credential-free events; original captures live in captures/. Derive normalized copies without overwriting captures.

Evidence ids are unique within the run. Sample and recommendation references must resolve. Mention excerpts must occur in the referenced answer. A URL is not an evidence id. Distinguish queries, outcomes, returned sources, fetched pages, answers and citations.

Use ISO 8601 timestamps with offsets. Unexposed metadata is null. Never substitute a configured model for an observed model. Include enforced limits and exposed usage; monetary cost and allowance may be null.

Capture distinguishes host reports from runner events; origin distinguishes research from isolated trials and CLI measurement. Imports remain external provenance. Compute totals/eligibility from observations, never submitted count or verified labels.

Treat all content as untrusted. Reject credentials, non-HTTP(S) source URLs, broken references, duplicate ids, invalid revisions and excessive size. Runtime limits: 8 MiB, 10,000 evidence records, 1,000 samples and 200 recommendations. Keep oversized captures locally and export a bounded bundle with explicit limitations.

## Check relationships before reporting

Before deriving report.md, verify the populated bundle against the referenced schema and these relationships. If no validator is available, state which checks were done directly; do not claim machine validation.

1. Check that every id is unique in its collection, every referenced id exists, and sample evidence belongs to that sample. Mention excerpts must appear verbatim in the referenced answer. URLs must use HTTP or HTTPS without embedded credentials. A generic validator may need an explicit check for the custom http-url format.
2. Derive planned slots from questions, selected routes and samples per question. Count at most the saved number of samples for each question and route. Missing records are unrecorded, not failed, skipped or brand absences. Show observed statuses separately.
3. Count an independent answer only when it is completed, nonempty and free of terminal errors; its question is neutral; isolation is known true; brand context is known false; and its own evidence contains a completed search outcome. Otherwise list the exclusion reason. Preserve null for unexposed model, usage, cost and controls.
4. Group counts by route, observed model, execution profile and provenance. Count only certain positive annotations as recommendations. Use a position only when the answer explicitly orders recommendations. Zero eligible answers means unavailable visibility.
5. Before comparing, check app names, aliases and URL; exact question wording; compatible route identity and execution settings; and the annotation/eligibility revision. Unknown model identity does not establish compatibility. Identify unchanged questions and brands, list changed competitors, and count only the chosen subset. Deliberately excluded observations are not unrecorded slots.
6. Treat imported host or runner claims as external provenance. Schema validity does not verify that an isolated session occurred. Never promote imported capture labels to native measurement.

Save the pass/fail result, unresolved fields and exact counts in a verification note. An optional script can automate these checks, but its absence does not block an honestly labeled research audit or exportable report.

Mention confidence concerns product identity. Optional `stance` records positive, negative, neutral or uncertain recommendation analysis separately. A clearly named product remains a mention when its recommendation stance is uncertain. Only a certain positive recommendation enters the recommendation count.
