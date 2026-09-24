# Local JSON export

`GET /api/export` returns a JSON object with `exportFormatVersion`, `databaseSchemaVersion`, `exportedAt`, and `tables`. Format version 2 includes every table used by the versioned measurement contract. The export is a local data dump, not an import or a backup of raw artifact files. Use the SQLite migration backup and matching artifact directory to restore an installation.

`tables` contains arrays of database rows. Version 2 adds `execution_profiles`, `benchmark_revisions`, `search_queries`, `source_observations`, `answer_citations`, and `usage_components`. It retains the version 1 table names and fields. `responses` carries the execution profile, benchmark, analysis, search policy, answer state, evidence completeness, and query metadata state for new observations. Historical rows have `search_policy = "legacy"` and null revision IDs where the exact old configuration is unknown.

The export preserves original query text and URLs next to normalized grouping keys. `search_events` records actions; `search_queries` records exposed wording; `source_observations` records returned or fetched sources; `answer_citations` records explicit final references. A null action or source association means the provider did not establish that edge. The old `citations` table remains for compatibility and can contain legacy provenance that is not known precisely.

The export includes known usage components and unknown cost states. It does not contain API keys, CLI credentials, or raw provider event files. Artifact references can outlive the retained file; `artifactAvailability` reports `expired` when a referenced file is gone. Normalized database evidence remains after retention cleanup.
