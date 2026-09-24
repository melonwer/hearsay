# Implementation review notes

The implementation follows the Hearsay plan dated 2026-09-24. These notes describe local commits. No provider credit, external publication, deployment, or recurring spend was used.

## C00: `a66546f` — record provider contracts

- Reason and user result: documented what a search profile may claim before changing requests. Users see no new behavior yet.
- Contract: [search-provider-contracts.md](search-provider-contracts.md) records six surfaces, policy gates, verification and completion predicates, evidence layers, usage and price provenance, limits, fixture gaps, and unsupported states.
- Evidence: baseline `node --test` passed 304 tests; `npm run typecheck` passed. Both checks passed again at the commit boundary. Official provider pages were checked on 2026-09-24; no live account or model access was tested.
- Compatibility: no runtime or schema change.
- Remaining gate: C01 shared contract, then persistence and provider fixtures before a new search route can be enabled.

## C01: `d241a31` — define measurement and evidence contracts

- Reason and user result: one pure contract now defines route policy support, exact identities, evidence layers, and comparability. Existing routes keep their behavior until the storage and adapter work uses it.
- Contract: `core/measurement-contract.js` defines execution profiles, benchmark revisions, exact comparison selections, query and URL grouping, distinct source and citation counts, and answer eligibility. `core/providers/shared.js` accepts additive typed evidence fields. Credential fields are excluded from profile identities.
- Evidence: seven focused tests passed. The full `node --test` suite and `npm run typecheck` passed at the commit boundary; `git diff --check` was clean.
- Compatibility: no database migration or request change. Existing helper signatures remain available.
- Remaining gate: C02 persists these definitions and normalized evidence. Route capability flags remain closed for new API search profiles.

## C02 storage portion: append v5 migration and evidence writer

- Reason and user result: the database can retain exact profile and benchmark snapshots, multiple queries and sources, final citations, and usage components without relabeling old observations. New report pages do not yet read these records.
- Contract: schema v5 adds immutable definition tables, response revision and completion fields, action identity fields, query, source, citation, and usage child tables, and bounded indexes. The storage helper requires a queued target for definition attachment and writes normalized evidence in a savepoint. It rejects oversized excerpts, counts, answers, unsafe URLs, and invalid associations.
- Evidence: focused migration tests cover a populated v4 database, its readable v4 backup, old IDs and text, foreign keys, distinct source and citation records, duplicate new-target prevention, original query retention, and atomic rollback after invalid evidence. Full suite and typecheck evidence is recorded in the commit and handoff after the boundary check.
- Compatibility and rollback: legacy response IDs and annotations remain readable, with `search_policy = 'legacy'` and no invented profile or benchmark revision. `openDb` creates a SQLite-consistent timestamped backup before v5. Stop the application before restoring that backup and its matching artifacts. Restoring it loses writes made after the backup; an older executable must not open a v5 database.
- Remaining gate: wire both runners to save definitions before network work and finalize evidence with derived rows, add export schema fields, artifact-expiry behavior, and interruption tests. C02 is incomplete until that work passes.

## C02 export portion: version the local JSON export

- Reason and user result: a user can export normalized evidence and see that an expired raw artifact does not erase a query, source, or citation.
- Contract: export format version 2 includes the new measurement tables and the database schema version. The artifact helper reports `not_recorded`, `available`, or `expired` without reading provider files on report paths. [export-schema.md](export-schema.md) describes the fields and the limit that JSON export is not a full restore mechanism.
- Evidence: focused export and retention tests plus the full suite and typecheck are recorded after this commit's boundary check.
- Compatibility: existing table names and fields remain in the export. New top-level version fields and tables are additive.
- Remaining gate: queue and finalize both runner paths with saved definitions and evidence, then test interruption and artifact write failure recovery. C02 is incomplete until that work passes.

## C02 API runner portion: save definitions before a provider call

- Reason and user result: each API target has a durable profile and benchmark snapshot before network work, so a setup edit or interrupted call cannot rewrite what was measured.
- Contract: the API runner creates queued response rows in the run-claim transaction. It attaches one exact execution profile and benchmark revision per target, then finalizes the answer, normalized evidence, usage components, mentions, and legacy citation rows in one transaction. Existing API requests remain search-off. Sonar remains labeled legacy. The old response fields stay available for current UI and API clients.
- Evidence: a fake adapter pauses after receiving a question while the test checks queued definitions and edits setup. The saved question and benchmark remain unchanged. An unsafe citation leaves the answer for diagnosis and a failed target without partial child evidence. Existing runner tests, the full suite, and typecheck are recorded at this commit boundary.
- Compatibility: existing API request bodies, model defaults, cost estimates, and run consent stay the same. Old observations have no invented benchmark revision. New ones carry revision IDs and retain the old comparison key until exact-series readers are added.
- Remaining gate: subscription runner definition and evidence finalization, artifact write rollback, and interrupted target recovery tests. C02 is incomplete until both execution paths satisfy the contract.

## C02 subscription runner portion: persist CLI observations

- Reason and user result: subscription measurements now retain their exact queued question and execution settings, plus separate search actions, queries, fetched or reported sources, final answer links, and token usage.
- Contract: target definitions are saved with the run before CLI work. Provider action IDs reconcile start and completion records without counting one search twice. Final answer, legacy analysis rows, and normalized evidence commit together. The first query and source remain in the existing event columns for current answer pages. Failed finalization keeps a bounded answer and token counts while removing an uncommitted raw artifact.
- Evidence: focused tests cover a setup edit during execution, action reconciliation, an invalid final citation after artifact creation, and recovery of an interrupted target without invented queries. Full suite and typecheck results are recorded at the commit boundary.
- Compatibility: the current CLI consent, search prompt, result status, and answer-page event fields remain available. The execution profile includes the configured executable and safety profile version. CLI token usage has unknown monetary cost until C03 accounts for it.
- Remaining gate: C03 adds policy budgets and usage accounting; C04–C08 add and refine provider-specific evidence. C02 has no new live provider calls.

## C03 pricing portion: refresh checked token and Sonar rates

- Reason and user result: legacy API cost estimates use the rates published on 2026-09-24, including the lower current OpenAI, Anthropic, and time-limited Gemini token rates. This corrects displayed estimates without changing requests or schedules.
- Contract: `PRICE_TABLE_VERSION` identifies the checked standard-price table. Unknown models and missing token counts remain unpriced. Sonar's request fee remains separate from its token arithmetic. [search-provider-contracts.md](search-provider-contracts.md) retains official source links and the distinction between computed cost and an invoice.
- Evidence: focused cost and runner tests, full suite, typecheck, and diff check are recorded at this commit boundary.
- Compatibility: stored historical response costs remain unchanged. Existing price overrides still win. Gemini's current standard rate expires after 2026-12-31 and must be rechecked before a later date.
- Remaining gate: C03 still needs search-tool and continuation usage, exact preview budgets, stale-quote rejection, and consistent manual, API, MCP, and scheduled consent. No search route is enabled by this change.
