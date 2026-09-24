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
