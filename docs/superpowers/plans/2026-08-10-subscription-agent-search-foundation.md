# Subscription Agent Search Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the storage and query invariants needed for separately labeled, lane-aware Codex/Claude Code measurements while preserving every existing API-run result and metric.

**Architecture:** Append schema version 2 with recoverable migration backups, universal prompt provenance, response-target lifecycle columns, search-event evidence, and schedule metadata. Centralize eligibility predicates so metrics, queries, and alerts can require tracking/comparable/completed rows explicitly; keep legacy API rows comparable through a backfilled legacy comparison profile.

**Tech Stack:** Node.js 22.13+, built-in `node:sqlite`, built-in filesystem/path/crypto APIs, ESM, JSDoc, `node:test`; no runtime dependencies.

## Global Constraints

- Subscription results are sibling measurements to API results and are never silently blended into one visibility score.
- The exact surface labels are `Codex agent` and `Claude Code agent`; they are not aliases for ChatGPT or Claude consumer interfaces.
- Existing rows backfill as API, tracking, completed/failed, comparable, and `web_status=not_applicable`.
- Every trend, rate, share-of-voice, recommendation, citation, and alert query requires `lane=tracking`, `target_status=completed`, and `comparability_status=comparable`; subscription metrics additionally require `web_status=verified`.
- Exploration prompts are inactive until explicitly promoted; historical response snapshots and origins never change.
- Migration backups use SQLite-consistent `VACUUM INTO`/backup behavior and are opened and schema-verified before migration continues.
- Node.js remains `>=22.13`; production dependencies remain zero.

---

### Task 1: Establish migration and lifecycle test fixtures

**Files:**
- Create: `test/subscription-foundation.test.js`
- Create: `test/fixtures/schema-v1-subscription.sql`
- Modify: `core/db.js`

**Interfaces:**
- Consumes: existing `openDb`, `migrate`, `userVersion`, `run`, `all`, and `get` helpers.
- Produces: `SCHEMA_VERSION >= 2`, `MIGRATIONS` containing an append-only v2 migration, `createMigrationBackup(db, dbPath, now)`, and stable v2 columns/tables for later tasks.

- [ ] **Step 1: Write failing migration tests** for a real v1 database containing successful/error responses, mentions, citations, alerts, and a seed run. Assert that opening it upgrades the schema, preserves row counts and answer text, backfills API/tracking/comparable metadata, creates `search_events`, and creates a timestamped backup that opens with the pre-migration schema.
- [ ] **Step 2: Run `node --test test/subscription-foundation.test.js`** and verify the test fails because v2 columns, migration, and backup helper do not exist.
- [ ] **Step 3: Add the v2 schema migration**. Rebuild `prompts` and `runs` where their old `NOT NULL`/status checks prevent the new state model; add nullable response metadata columns; create `search_events`; add run schedule columns and indexes. Backfill legacy rows with `surface = provider || '-api'`, `lane = 'tracking'`, `target_status = completed|failed`, `comparability_status = comparable`, `web_status = not_applicable`, `prompt_text_snapshot` from the prompt, `prompt_origin = legacy`, `location_control = uncontrolled`, and a deterministic legacy `comparison_key`.
- [ ] **Step 4: Implement recoverable migration backup** using a generated filename under the database directory, `VACUUM INTO`, a verification open, and mode `0600` where supported. Skip backup for `:memory:` and brand-new schema creation; never overwrite an existing backup.
- [ ] **Step 5: Run the focused migration tests** and verify they pass, including backup schema verification and idempotent reopen.
- [ ] **Step 6: Commit `feat: add subscription measurement schema foundation`** with only the migration, fixture, and tests staged.

### Task 2: Add prompt provenance and target lifecycle helpers

**Files:**
- Create: `core/subscription-model.js`
- Modify: `core/db.js`
- Test: `test/subscription-foundation.test.js`

**Interfaces:**
- Consumes: v2 `prompts`, `responses`, `runs`, and `search_events` tables.
- Produces: `PROMPT_LANES`, `PROMPT_ORIGINS`, `TARGET_STATUSES`, `COMPARABILITY_STATUSES`, `WEB_STATUSES`, `SURFACES`, `createExplorationPrompt(db, input)`, `promotePrompt(db, promptId, intentId, now)`, `promptSnapshot(db, promptId)`, `comparisonKey(input)`, `eligibilitySql(alias)`, `eligibleResponseWhere(alias, opts)`, and `runStatusFromTargets(targets)`.

- [ ] **Step 1: Add failing tests** for inactive exploration creation, explicit promotion, rejection of invalid promotion/state combinations, immutable response snapshots, deterministic comparison keys, and logical status calculation (`done`, `partial`, `failed`, `cancelled`, `missed`).
- [ ] **Step 2: Run the focused tests** and verify the new helpers are missing.
- [ ] **Step 3: Implement the model helpers** with strict enum validation and transactional promotion. Promotion must select an intent, set `tracking_state=tracking`, set `active=1`, and record both approval and promotion timestamps; it must not update historical responses.
- [ ] **Step 4: Implement SQL eligibility fragments** returning SQL plus parameters, never interpolating user values. Legacy API rows must pass the common predicate; subscription rows must opt into `web_status=verified`.
- [ ] **Step 5: Run focused tests and typecheck**; refactor only after green.
- [ ] **Step 6: Commit `feat: model subscription prompt and target states`**.

### Task 3: Make metrics and alerts surface/lane safe

**Files:**
- Modify: `core/metrics.js`
- Modify: `core/alerts.js`
- Modify: `web/queries.js`
- Modify: `web/pages/api.js`
- Test: `test/metrics.test.js`, `test/alerts.test.js`, `test/api.test.js`, `test/subscription-foundation.test.js`

**Interfaces:**
- Consumes: `eligibleResponseWhere` and the v2 response metadata.
- Produces: backward-compatible provider filters plus optional `surface`, `lane`, and `comparison_key` filters; subscription metrics grouped by surface/profile and excluded when web search is not verified.

- [ ] **Step 1: Add failing metric tests** inserting API, tracking exploration, subscription verified, subscription unverified, and failed targets. Assert only eligible rows affect rates, SOV, trends, citation gap, spend, prompt tables, and intent tables; assert API-only behavior remains unchanged.
- [ ] **Step 2: Add failing alert tests** for complete comparable cohorts, partial cohorts, and separate surfaces. Assert no loss/drop alert is emitted for an incomplete surface and that a complete API cohort can alert while a subscription cohort remains partial.
- [ ] **Step 3: Add failing API/query tests** for `surface` filtering and exact labels in `/api/answers`, results, summary/provider breakdown, and exported rows without removing existing `provider` filters.
- [ ] **Step 4: Replace duplicated `r.error IS NULL` metric predicates** with the shared eligibility helper; group aggregate rows by `surface` and `comparison_key` while retaining the legacy provider output shape for API consumers.
- [ ] **Step 5: Update alert cohort counting** to compare only complete tracking/comparable cohorts for the selected surface and to leave exploration/non-comparable evidence visible only through receipts.
- [ ] **Step 6: Run the focused metrics, alerts, and API tests**, then the full existing suite.
- [ ] **Step 7: Commit `feat: isolate subscription lanes from metrics and alerts`**.

### Task 4: Add redacted artifact and evidence storage

**Files:**
- Create: `core/artifacts.js`
- Modify: `core/db.js`
- Modify: `web/queries.js`
- Modify: `web/pages/api.js`
- Test: `test/subscription-foundation.test.js`, `test/api.test.js`

**Interfaces:**
- Consumes: normalized event objects from future CLI adapters.
- Produces: `createArtifactStore(dataDir, options)`, `redactEvent(event)`, `writeArtifact(store, responseId, events)`, `readArtifact(store, ref)`, `cleanupArtifacts(store, now)`, and `recordSearchEvents(db, responseId, evidence)`.

- [ ] **Step 1: Add failing tests** for token/header/email/account redaction before persistence, `0700` directories/`0600` files on POSIX, generated non-traversable refs, retention cleanup that leaves normalized responses intact, and search-result/fetch rows staying distinct from final-answer citations.
- [ ] **Step 2: Run the focused tests** and verify the artifact module is missing.
- [ ] **Step 3: Implement bounded redaction and filesystem storage** using only built-ins. Ref generation must use random bytes or a content-independent internal id; user-provided path segments are never accepted.
- [ ] **Step 4: Implement normalized `search_events` inserts** with provider event status, query/result/fetch metadata, timestamps, and no raw unredacted stream.
- [ ] **Step 5: Expose redacted evidence through the answers API** behind surface-aware fields while preserving existing answer payload keys.
- [ ] **Step 6: Run focused tests, typecheck, and full suite; commit `feat: retain redacted agent evidence artifacts`**.

### Task 5: Foundation acceptance gate

**Files:**
- Modify: `docs/superpowers/plans/2026-08-10-subscription-agent-search-foundation.md`
- Modify: `docs/superpowers/specs/2026-08-09-subscription-agent-search-design.md` only if the user’s existing uncommitted change explicitly requires a correction; otherwise preserve it.

- [ ] **Step 1: Re-read Sections 5.6, 6.1–6.3, and 9 of the spec** and mark each requirement covered by Tasks 1–4.
- [ ] **Step 2: Run `node --test`, `npm run typecheck`, and `git diff --check`**; record counts and exit codes.
- [ ] **Step 3: Verify no production dependency was added and no API-only fixture lost rows or metrics.**
- [ ] **Step 4: Update the parent task plan** and start the adapter plan only after this gate is green.
