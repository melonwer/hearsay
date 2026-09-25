# Hearsay: search evidence to useful improvements

Implementation handoff • 24 September 2026 • Plan version 1.0

Repository: https://github.com/melonwer/hearsay

Reviewed baseline: `d7c9573a8ed045cd5727be4a6cc2e900898a6856` (also the current `main` when this plan was prepared). Database schema at this baseline: version 4.

## Implementation progress (25 September 2026)

The checkboxes track completed commit gates. A partial C03 implementation is committed, but C03 remains open until its full acceptance and validation criteria pass. See [implementation-review.md](implementation-review.md) for evidence and remaining gates.

- [x] C00 — provider contracts and baseline (`a66546f`)
- [x] C01 — versioned measurement and evidence contracts (`d241a31`)
- [x] C02 — evidence storage, exports, and runner snapshots (`4905bb5` through `097f0f5`)
- [ ] C03 — search budgets and usage accounting (in progress through `7ae20df`)
- [x] C04 — OpenAI search evidence adapter (`b647107`)
- [x] C05 — Anthropic search evidence and bounded continuation (`7ae20df`)
- [ ] C06 — Gemini grounding evidence adapter (held for legal review; grounding disabled)
- [x] C07 — Perplexity and subscription evidence provenance
- [ ] C08 — conservative recommendation classification
- [ ] C09 — exact series metrics and dashboard scope
- [ ] C10 — question, search, source, and answer report; Release A gate
- [ ] C11 — buyer-focused benchmark setup
- [ ] C12 — reviewable evidence-linked opportunities
- [ ] C13 — interventions and follow-up plans
- [ ] C14 — descriptive intervention comparisons
- [ ] C15 — outcome records and weekly review
- [ ] C16 — demo separation and tracking health
- [ ] C17 — workflow documentation and Release B gate
- [ ] E01–E16 — end-to-end acceptance scenarios

## 1. Objective and authority

Build a complete workflow that helps a person answer:

1. Which valuable buyer questions lead AI systems toward competitors or inaccurate information about us?
2. What did the system actually search, retrieve, cite, and say?
3. What worthwhile improvement can we make to our product information, website, listings, or product?
4. After making it, what changed in comparable observations and in our observable business outcomes?
5. Is further effort justified?

The desired first-session outcome is one understandable finding with supporting evidence and a reasonable next action. The desired recurring outcome is a short review of useful opportunities and completed experiments. More prompts, more charts, and more provider calls are not success by themselves.

This document specifies implementation work; it is not authorization to spend provider credit, publish content, contact third parties, enable recurring spend, or modify external websites. Implement local functionality and tests; preserve Hearsay's existing explicit run/schedule consent. The user expects separately reviewable commits and a later diff review. Do not merge or deploy automatically.

No plan can guarantee error-free implementation or future provider behavior. This plan therefore distinguishes verified baseline facts, product decisions, and mandatory compatibility gates. Where a gate fails, return a precise unsupported state and record the blocker; do not invent a capability or silently substitute a different measurement.

## 2. What users want, and the corresponding product choices

| User need | Product behavior | Expected outcome |
|---|---|---|
| Understand why a buyer would or would not find them | Connect buyer intent to observed searches, sources, and answers | Findings are relevant to a real purchasing decision |
| Know which work is worth doing | Small opportunity queue with evidence, effort, controllability, and an explicit hypothesis | Less time interpreting dashboards; fewer speculative tasks |
| Trust the numbers | Exact measurement labels, honest missingness, stable comparisons, auditable classifications | Avoid reacting to provider failures, parser errors, or changing benchmarks |
| Start without extensive setup | Guided real-brand setup, small reviewed benchmark, one working route, safe demo separation | Reach the first useful observation with limited effort |
| Learn from changes | Record interventions and compare equivalent observations after a chosen review window | Distinguish useful work from inconclusive experiments |
| Understand value | Keep observed traffic/conversions and costs separate from synthetic visibility | Decide whether the channel deserves more investment |
| Retain control | Local storage, transparent costs, no automatic publishing or hidden paid analysis | Confidence in continued use |

Initial design audience: technical founders and small teams selling developer tools or technical B2B products. This is a product hypothesis, not validated market research. Do not hard-code their terminology into the data model; other app and brand owners should still be able to use it.

## 3. Verified baseline and implementation entry points

Paths below are relative to the reviewed repository. Inspect the actual target branch before editing; preserve unrelated work and follow applicable repository instructions.

| Area | Baseline fact | Relevant files |
|---|---|---|
| Runtime | Plain ESM JavaScript with JSDoc, Node >=22.13, built-in SQLite, zero runtime dependencies | `package.json`, `CONTRIBUTING.md` |
| API adapters | OpenAI/Anthropic/Gemini requests do not enable search tools; they return text/model/tokens and optional citations through a small shared contract | `core/providers/{openai,anthropic,gemini,shared}.js` |
| Perplexity | Uses Sonar; currently prefers `search_results` over `citations` and passes the chosen list as citations | `core/providers/perplexity.js` |
| Subscription evidence | Existing search/fetch event parsers, redacted artifacts, search verification, and separate surfaces | `core/agent-parsers.js`, `core/artifacts.js`, `core/agent-profiles.js`, `core/subscription-runner.js` |
| Storage | Responses already have surface, lane, comparison key, prompt snapshot, web status, and artifact reference; `search_events` already exists | `core/db.js`, `core/subscription-model.js` |
| Comparison identity | Existing key covers surface/model/envelope/profile/location/language; benchmark and classifier revisions are not a complete part of the current comparison contract | `core/subscription-model.js`, `core/metrics.js` |
| Dashboard | Main dashboard calls metrics without an exact surface; their default scope excludes subscription-agent series | `web/pages/dashboard.js`, `core/metrics.js` |
| Existing access | API and MCP already support surface selection for several result methods; answers page has a surface selector | `web/pages/api.js`, `mcp/server.mjs`, `web/pages/answers.js` |
| Recommendation detection | Trigger proximity, first-list-item, and short-answer-first-sentence rules can mark negative statements as recommendations | `core/analyze.js` |
| Alerts | Mention-drop minimum is three samples per side; gained/lost recommendation can hinge on one positive response | `core/alerts.js` |
| Prompt workflow | Intents/paraphrases, exploration/promotion, and origin metadata already exist | `core/suggest.js`, `core/subscription-model.js`, `web/pages/setup.js` |
| Setup | Browser suggestion generation is gated by API-key availability; README demo-to-real instructions delete the database | `web/pages/setup.js`, `README.md` |
| Costs | Existing cost model uses tokens plus a per-request fee; new search/continuation usage needs explicit accounting | `core/cost.js`, `core/runner.js` |

Observed synthetic regression cases: `I do not recommend Acme.`, `Acme is unsuitable for this use case.`, and `Products to avoid:\n1. Acme` each produced `recommended: 1` using the baseline analyzer. These examples establish a bug; they do not estimate its frequency in real responses.

Baseline code permalinks: https://github.com/melonwer/hearsay/tree/d7c9573a8ed045cd5727be4a6cc2e900898a6856

## 4. Scope and release boundaries

### Release A: trustworthy search evidence

Deliver the shared evidence contract, supported search-enabled API routes, subscription evidence improvements, correct citations, exact-surface dashboard, conservative recommendation classification, and an inspectable query/source report. This release must answer: “What did the configured system search and cite, and what did it say about me?”

### Release B: an improvement workflow

Add buyer-focused onboarding and benchmark versioning, evidence-linked opportunities, intervention tracking, descriptive follow-up comparisons, business-outcome records, and a weekly review. This release must answer: “What should I do next, and what did I learn after doing it?”

Do not call Release A a complete ROI product. Complete Release B for the full handoff scope. A provider blocked by a documented compatibility gate must be explicitly marked unavailable, with that limitation included in the review; do not claim all-provider completion.

### Explicit exclusions

- No new provider beyond the existing four APIs and two subscription-agent surfaces.
- No consumer-app browser automation or claim to reproduce personalized ChatGPT/Claude/Gemini screens.
- No SEO keyword-volume estimates, market-wide share claims, rank claims, or blended visibility score.
- No automatic content generation, publication, outreach, link purchasing, or product changes.
- No autonomous crawler, full SEO audit suite, or general-purpose task-management platform.
- No analytics connector marketplace, multi-client billing, hosted edition, or white-label reports.
- No LLM classification/semantic clustering in the required first implementation. Human-reviewed suggestions can be imported through MCP. Optional paid analysis requires a separate future design.
- No claims that exact query wording is a ranking factor, that citations cause sales, or that before/after differences prove causation.

## 5. Binding measurement contract

### 5.1 Surface, search policy, and series identity

Keep existing surface IDs (`openai-api`, `anthropic-api`, `gemini-api`, `perplexity-api`, `codex-agent`, `claude-code-agent`). Search configuration is a separate dimension, not a new name that implies a consumer product.

For newly configured API routes, support these policies only where the provider capability matrix validates them:

| Policy | Meaning | Valid-answer denominator |
|---|---|---|
| `off` | No search requested through a supported non-search route | Complete comparable answers for this policy |
| `auto` | Search tool is available; the model may choose whether to use it | All complete comparable answers, including explicit no-search answers |
| `required` | A documented mechanism or versioned instruction requests search; evidence must confirm execution | Complete comparable answers with verified search; publish exclusions and coverage |
| `legacy` | Historical configuration cannot be fully reconstructed | Historical series only, clearly labeled; no new benchmark claims |

Do not add an unsupported policy just to make all providers look identical. Existing subscription measurements remain search-required with their existing envelope until deliberately versioned. Existing API configurations must not start incurring new search charges after an upgrade. Preserve their behavior; offer an explicit migration/configuration flow. Legacy Sonar history must not be relabeled as search-off or newly verified.

For new users, recommend one validated search-enabled route suited to their question. Preview exactly what it measures and costs. `auto` is appropriate to observe whether the configured API chooses search; `required` is appropriate to inspect web discovery under a controlled search condition. Forced search is not a measurement of how frequently ordinary users trigger search.

Separate these concepts in storage and code:

- **Execution profile identity:** surface, endpoint family, configured and returned model identity/availability, tool version/configuration, search policy, any prompt envelope, location/language controls, relevant CLI/profile settings, and answer-affecting limits. Do not imply control over locale when it is not provided.
- **Benchmark revision:** exact approved prompts and intent mapping, prompt category, competitor/brand definitions and aliases/domains, weighting policy, and scope.
- **Analysis revision:** mention/recommendation classifier and citation-parser versions, plus the correction-view policy.
- **Comparison selection:** execution identity + benchmark revision + analysis revision + explicit time range. Store these identifiers on observations or their immutable parent snapshots as appropriate.

A change to any answer-affecting request setting starts a new execution series. A benchmark edit creates a new benchmark revision. Neither deletes old observations. A model alias can change upstream without a visible version change: show returned model metadata where available, and document that undetectable upstream changes remain possible.

Keep measurement context isolated from analysis context. For an unbranded question, never append the tracked brand, competitor list, desired answer, opportunity hypothesis, or proposed search keywords to the measurement request. Only the approved buyer question and documented neutral execution envelope belong there. Product facts and page excerpts may inform opportunity review, but must not leak into a benchmark response. Each repeated target starts a fresh conversation; only bounded continuations of that same target share context.

Existing no-argument API/MCP summaries may retain a labeled legacy default for backward compatibility. New UI, weekly reviews, opportunities, and experiments must select an exact series; an unselected query must never silently blend APIs with subscription agents or recall with search.

### 5.2 Preserve five distinct evidence layers

1. **Buyer question:** the immutable prompt actually submitted, including a separately recorded envelope.
2. **Search actions/queries:** exact provider-exposed search wording, action identity and status.
3. **Sources:** provider-returned search results, reported consulted sources, or observed page fetches, with their provenance kept distinct.
4. **Answer citations:** explicit references attached to final answer text, including provider-native annotations where available.
5. **Answer/brand interpretation:** immutable final answer, mention spans, recommendation stance, and human corrections.

A search result is not automatically a citation. A citation is not automatically an endorsement. A URL written in an answer is not proof that a search occurred. A fetched page is not proof of a search. An observed result order is not a brand ranking. Final answer language is not a hidden search query.

Do not ask a model to reconstruct its searches and store the result as observation. Missing queries are `unavailable`, not an empty set that implies no search. A provider may verify search while withholding its query text. Query-to-result mappings must be nullable when only response-level associations are exposed.

Use existing `search_events` and artifact facilities where they fit. Add child relations for multiple queries and multiple sources rather than duplicating a logical search action or retaining only its first result. Concrete SQL names are implementation choices; the following semantics are mandatory:

| Record | Required semantics |
|---|---|
| Search action | Response ID, provider action ID or stable local ordinal, kind, status, observation timestamp, provider provenance/type, safe error, sequence |
| Search query | Action association when known, exact text, normalized comparison key, ordinal; unavailable status separately represented |
| Source observation | URL/title and optional bounded excerpt, provenance (`search_result`, `reported_source`, `fetch`), action association when known, original order if exposed |
| Answer citation | URL, provenance (`native_annotation`, `explicit_reference`, `text_link`), optional answer span/index, association to a source only when supported |
| Usage component | Provider-reported quantity/unit or unknown, attempt/continuation linkage, price-version provenance, known/partial/unavailable cost status |
| Interpretation | Entity ID, stance, supporting spans, rule/version, uncertainty; immutable correction history |

Store originals separately from normalized keys. Preserve all original URLs; use conservative URL normalization (scheme/host case, documented fragment handling) for grouping, not a blanket removal of query parameters. Preserve unresolved provider redirect URLs. A provider redirect host must not be counted as the publisher domain. Do not resolve URLs by making unrequested network calls during metric calculation.

For exact-query grouping, use Unicode NFC normalization, trim outer whitespace, and collapse internal whitespace while preserving case and punctuation. Preserve original text for display. Do not stem, translate, merge synonyms, or lowercase case-sensitive product identifiers automatically. Optional user theme grouping is a separate many-to-many label layer; theme incidence counts each response once even when several of its queries share a theme.

### 5.3 Search verification and completion

Retain the existing distinction between verified, unavailable, unverified, failed, and not applicable. Add an explicit `not_used` state or an equivalent unambiguous structured field for a completed `auto` answer where the documented response confirms no search action. Absence of metadata in a format that does not expose tool use is `unverified`, not `not_used`.

Provider parsers must define verification from documented structured evidence, with fixtures. Incomplete starts and HTTP 200 tool-error blocks are not successful searches. A response with one successful search and a later failed search retains both; mark search verified but evidence partial, and conservatively exclude that partial execution from required-policy benchmark metrics. Keep the answer available for diagnosis. An empty successful search result can still be a verified search if execution is confirmed.

Separate final-answer completion from search completion. Refusals, empty answers, truncations, unfinished continuations, and transport errors remain inspectable and count toward attempted-target coverage. Exclude them from comparable recommendation/mention metrics and disclose exclusions; never present them as “brand absent.”

Each scheduled logical target yields at most one comparable final observation. Retries and continuations have separate usage/evidence records, not additional independent samples. Store the executed benchmark/profile snapshots before network work, and finalize answer, evidence, and derived rows transactionally. Artifact writes require a documented recovery path if the database transaction fails.

### 5.4 Counts and uncertainty

- Every displayed rate includes its numerator, denominator, scope, and time window; show the existing Wilson interval where applicable.
- Report attempted targets, complete answers, comparable answers, verified-search answers, and answers with query metadata separately.
- Query frequencies are sampled frequencies in Hearsay, never real-world search demand. Count responses containing a query, as well as raw query occurrences; repeated queries within one answer must not inflate response incidence.
- For query incidence, show `k / answers with exposed queries`; also show query-metadata coverage against all eligible answers. Missing metadata is not query absence.
- For source incidence, count unique responses per URL/domain within a named evidence layer. Keep raw counts available for inspection; do not let repeated citations dominate an answer-level rate.
- Keep unbranded discovery, competitor comparisons, and branded evaluation separate. Competitor-named prompts are not unbiased general-discovery prompts.
- Share of voice means share among the selected tracked entities. Changing that set changes the benchmark; do not imply market-wide share.
- Pooling repeats does not make selected prompts representative of all buyers. Describe intervals as sampling uncertainty for this configured panel; do not claim they cover all phrasing, personalization, locale, or model drift.
- Comparison reports use fixed prompt weights and explicit coverage, not whichever prompts happened to succeed more often. First version uses equal weights within a saved selection. No invented demand weights.

## 6. Provider implementation gates

Before enabling a route, record in `docs/search-provider-contracts.md`: checked date, official documentation links, endpoint/model/tool combination, allowed policies, request fields, verification predicate, query/source/citation mapping, completion rules, search and token usage, continuation limits, and unsupported cases. This is a reproducible contract, not a claim that all accounts support every model.

Use built-in `fetch`; do not add provider SDK runtime dependencies. Confirm account/model compatibility at configuration or execution with actionable errors. A model fallback, endpoint migration, or proxy through another provider changes the measurement identity and requires explicit configuration, not a silent recovery.

### OpenAI

Implement search through the documented Responses API web-search path for validated models. Preserve the existing non-search path as a separate execution profile. Parse the full output-item structure, final answer text, search actions, exposed queries, reported sources, and answer annotations. Queries are not guaranteed to be present. Record complete/incomplete/failed states and tool usage; do not parse only an assumed first text item. Use the documented required-tool mechanism only for compatible configurations. Native citations and reported sources remain separate.

Official reference: https://developers.openai.com/api/docs/guides/tools-web-search (checked 2026-09-24).

### Anthropic

Use a validated Messages API web-search tool version and parse tool-use/result blocks alongside final text and citations. A 200 response can contain a search error. Handle `pause_turn` using a bounded continuation flow that retains usage and prior blocks; do not treat the paused response as final or replay it as a new sample. Validate model/tool compatibility, including direct versus dynamic-filtering behavior. Do not enable code execution simply because a newer tool version defaults to it. Prefer the smallest documented search-only configuration satisfying the contract.

Official reference: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool (checked 2026-09-24).

### Gemini

Use a documented supported Google Search grounding route and record the selected endpoint family. The current code uses `generateContent`; an endpoint-family migration is a deliberate versioned change. Preserve `webSearchQueries`, grounding chunks, and grounding supports. Supports associate answer segments with sources; chunks alone do not prove a specific inline citation. Validate offsets against the provider's indexing convention and non-ASCII text. Missing metadata must remain explicit. Preserve required Search Suggestions presentation and follow current provider requirements; isolate any provider HTML rather than injecting it into the application document. If a safe compatible presentation is unavailable, block that route's release and document the limitation.

Official references: https://ai.google.dev/gemini-api/docs/generate-content/google-search and https://ai.google.dev/gemini-api/docs/google-search (checked 2026-09-24).

### Perplexity

Fix the existing collapse of `search_results` into citations. Preserve separate lists and any supported query metadata. If queries are not exposed, show unavailable. Keep current Sonar behavior unless current official support requires a migration; changing to Agent API must be an explicit new execution profile, because endpoint, model selection, tools, and response shape differ. Recheck official support at implementation time; do not adopt third-party sunset claims without verification.

Official references: https://docs.perplexity.ai/api-reference/sonar-post and https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview (checked 2026-09-24).

### Codex and Claude Code

Retain their separate exact-surface labels, local authentication, restrictions, scheduling consent, verified-search eligibility, redaction, and bounded parsers. Extend extraction to all exposed queries/results and stable event associations. Do not assume API response schemas match CLI event schemas. No new agent capabilities or relaxed execution permissions are needed. Historical artifacts may lack fields; do not fabricate backfilled evidence.

## 7. Opportunities and the action loop

An opportunity is a proposed useful action backed by identifiable observations. It is not an authoritative diagnosis of an AI ranking algorithm.

Required fields: intent and buyer relevance; exact series/benchmark; evidence response/query/source IDs; observed finding; hypothesis; suggested action; target URL or product area; controllability (`owned`, `third_party`, `product`); effort band; owner; review date; status; author/origin; missing evidence; dismissal reason. Allow `investigate` and `no_action` outcomes. Default sorting is transparent user priority, then effort and recency—not an opaque numerical score.

Initial candidate generation is deterministic and conservative: repeated source appearances without the brand, repeated query themes explicitly grouped by a user, explicit negative or uncertain brand statements, or a user-selected answer. Candidates say “Investigate”; they do not automatically assert that a page lacks a feature or that a cited site caused the outcome.

For automatic repetition candidates, the initial rule is at least two distinct comparable responses from at least two completed runs within the selected series/window. Count a response at most once per candidate. This is a triage threshold, not statistical evidence of importance; display its exact support and allow manual creation from a single receipt. A candidate identity includes type, intent, series/benchmark, and target source/theme/entity so regeneration can retain review/dismissal history. Only show an unreviewed resurfaced candidate when new supporting observations exist, and identify those observations.

A specific page-change recommendation needs reviewed page evidence. First version accepts a URL, timestamp, and bounded user/assistant-supplied excerpt or an already observed fetch excerpt, with provenance. Manual imports are not provider-observed retrieval evidence. Without such evidence, the action remains an investigation. Do not build an autonomous page crawler for this milestone.

An MCP client may propose a structured opportunity from observed evidence. Mark it as an assistant-authored hypothesis, validate every referenced ID, and require user acceptance before putting it in the committed action queue. This does not authorize the assistant to publish, send outreach, or invent missing sources. No paid suggestion call runs during ordinary page views or report reads.

When accepted, an action can be `planned`, `in_progress`, `shipped`, `reviewed`, or `dismissed`. Marking shipped requires a change description, timestamp, and affected URL/feature. Edits to shipped actions retain history. The follow-up plan links the saved baseline selection, selected intents, expected direction/primary metric, intended review window, and optional unchanged comparison intents. Actions do not automatically start runs or alter schedules.

Example (illustrative only): repeated searches for meeting-tool retention/local processing lead to pages explaining those capabilities; a reviewed product page does not explain the user's existing capability. Propose improving that explanation, record its publication, and compare future equivalent observations. Never conclude that copying an exact phrase guarantees inclusion.

## 8. Follow-up interpretation and business outcomes

The required first version produces descriptive comparisons, not automated causal or significance claims. It reports before/after counts, rates, intervals, absolute percentage-point differences, query/source/citation changes, scope, exclusions, and coverage. Use half-open UTC windows `[start, end)` so a boundary observation belongs to only one period. Publication time is not proof of indexing; allow a user-chosen observation delay and label it as a choice, not a guaranteed crawl interval.

Comparison outcomes:

- `insufficient_data`: one side lacks the required comparable cells or usable observations.
- `incomparable`: execution, benchmark, analysis, or scope differs without an explicitly selected valid common revision.
- `observed_increase`, `observed_decrease`, `observed_no_difference`: arithmetic descriptions only, accompanied by an interpretation stating that uncertainty and outside changes remain.
- User review: `promising`, `not_useful`, `inconclusive`, with rationale. This is a user judgment, not an inferred causal result.

Do not label overlapping intervals as proof of no effect or non-overlap as the implemented test for a change. Do not claim “statistically significant,” “proven win,” or “caused by your change” in this release. Formal effect testing, clustered uncertainty, multiple-comparison control, and predeclared minimum meaningful effects require a separately reviewed statistical design before adding automated win/loss claims.

Suppress the existing tiny-sample urgent recommendation/drop alerts in new-series workflows. Present changes as observations with counts; never send a “serious” business-loss alert from a single positive-to-zero flip. Operational failures can still generate operational alerts. Any confirmation measurement uses an already authorized schedule or a newly approved run, never hidden spend.

Business outcomes initially use manual records or validated CSV input: time window, source, landing page where known, metric name, count/value, currency where applicable, attribution method, and notes. Include observed AI referrals, qualified signups/leads/purchases, and optional self-reported discovery as separate series. No receipt implies a real visit. Do not sum overlapping source records or assign all conversion changes to Hearsay. Unknown business value is unknown, not zero.

Show measurement costs, implementation/review time, and user-entered expenses alongside outcomes. Currency amounts must not be added across currencies without an explicit user-supplied conversion basis. Subscription allowance remains non-dollar usage unless a real billed amount is supplied. Do not compute a synthetic ROI number from visibility; a basic ledger is sufficient. A useful final recommendation can be to pause tracking or spend less effort.

## 9. Commit-by-commit implementation sequence

Implement in the order below. Each entry is a logical commit boundary with its own tests. Commit messages are proposed subjects. If one entry is too large to review, split it into a storage/core commit and an API/UI commit with explicit dependencies; do not combine unrelated entries. Keep incomplete features behind a configuration gate until their acceptance criteria hold. A schema migration must not leave existing routes unable to read their old data.

For every commit, record: reason, user-visible result, touched contracts, focused validation, compatibility impact, and remaining gate. Do not implement all code first and divide it into artificial commits afterward.

At every review/PR boundary, run the full `node --test` suite and `npm run typecheck` as required by `CONTRIBUTING.md`; focused per-commit checks below supplement that gate. Keep user-facing documentation accurate whenever a feature is exposed. C17 consolidates the final workflow documentation; it is not permission to release earlier functionality with stale measurement claims.

### C00 — `docs: record search measurement contracts and baseline`

**Reason:** External APIs change, and an incorrect model/tool assumption would invalidate both measurements and the user promise.

**Work:** Inspect target-branch changes from the reviewed SHA and applicable `AGENTS.md`/contributor rules. Record baseline test/typecheck status and the provider capability matrix in section 6. Capture a sanitized fixture matrix and official-source check dates. Define explicit policy capability flags rather than assuming every provider supports off/auto/required. Record any unavailable credentials as “live verification not performed.”

**Files:** `docs/search-provider-contracts.md` (new), existing contributor/test configuration, applicable provider modules for inspection only.

**Expected result:** The agent and reviewer agree on what each route claims to measure before changing execution.

**Acceptance:** The matrix specifies verification and completion predicates, absence semantics, account/model compatibility, limits, and pricing provenance. Unverified combinations cannot be enabled as production-ready. No live calls are part of the ordinary test command.

**Validation:** Baseline `node --test` and `npm run typecheck` using repository-approved development tooling; record unrelated existing failures separately. Do not change product behavior in this commit.

### C01 — `feat: define versioned measurement and evidence contracts`

**Reason:** Shared meaning must precede provider-specific implementations; otherwise each adapter will count different things under the same labels.

**Work:** Introduce JSDoc contracts and pure normalization/eligibility helpers for sections 5.1–5.4. Add search-policy capability validation, completion and evidence-completeness states, exact series selectors, benchmark/analysis revision identity, and separate query/source/citation collections. Define logical target versus attempt versus continuation. Extend or carefully refactor existing shared helpers; do not create an unrelated second subscription framework.

**Files:** `core/providers/shared.js`, `core/subscription-model.js`, new focused core modules where appropriate; accompanying contract tests.

**Expected result:** One response has the same interpretation across provider, runner, metrics, API, UI, and MCP.

**Acceptance:** Tests demonstrate auto-with-no-search versus unavailable metadata; successful search with missing queries; search-result-only versus citation; changed policy/profile versus stable series; benchmark/analysis revisions; unsupported capabilities; language/location uncontrolled states. The same profile snapshot hashes identically regardless of object-key ordering. Secrets are excluded from identity inputs.

**Validation:** Pure fixture/unit tests with no network or clock dependence. Keep legacy helper signatures working or update every caller atomically.

### C02 — `feat: persist search evidence and immutable measurement revisions`

**Reason:** Findings and before/after comparisons must remain auditable after prompts, models, or parsers change.

**Work:** Append migrations after the actual current schema version. Extend existing search events with suitable query/source child tables and final-citation provenance. Persist execution and benchmark snapshots, analysis version, attempt/continuation usage, and completion/evidence states. Add query-metadata availability separately from query rows. Provide additive export fields and a documented export schema version. Reuse existing redaction and artifact retention infrastructure.

**Files:** `core/db.js`, `core/artifacts.js`, `core/runner.js`, `core/subscription-runner.js`, relevant export handler in `web/pages/api.js`.

**Expected result:** Every report can link back to the exact observations and definitions used to create it.

**Acceptance:** Migrate populated version-4 and older supported databases without losing IDs, text, timestamps, existing annotations, or artifacts. Never edit shipped migrations. Legacy source provenance is explicitly uncertain; do not relabel historical Perplexity result lists as proven final citations. Preserve original derived rows during any optional reanalysis; new analysis produces a new version. Legacy observations cannot acquire invented search queries or exact historical benchmark snapshots.

For new runs before the C11 onboarding UI exists, create immutable snapshots from the already configured panel at run creation; this records the configuration and does not add or approve new questions. In-flight runs continue using their captured snapshot even if the user edits setup afterward.

**Validation:** Migration/backup/reopen tests; foreign-key checks; unique logical-target and event deduplication checks; crash between artifact write and DB commit; retention cleanup that leaves an “artifact expired” state while keeping normalized evidence; export round-trip checks for supported import paths, otherwise validate export content completeness without inventing a new full-database import feature.

**Rollback:** Use existing verified pre-migration backup plus matching artifact backup where needed; stop the app before restoration. Do not run an older executable against a newer schema or attempt destructive down-migrations. State that restoring a backup loses subsequent local writes.

### C03 — `feat: add explicit search execution budgets and usage accounting`

**Reason:** Search and continuation can cost more than one text-generation call; users need control before usage occurs.

**Work:** Configure search policy and supported limits per provider/profile. Extend previews to include target count, repetition count, enabled tools, endpoint/model, maximum continuations, time/answer limits, search usage assumptions, and known/unknown estimated cost components. Bind confirmation to the previewed selection/profile; changed settings invalidate a stale quote. Apply the same validated execution options to manual, CLI, API, MCP, and scheduled runs.

Track provider-reported usage per attempt/continuation and distinguish known subtotal from complete total. Use a versioned checked price table and existing override conventions. Account for failures/retries when usage is returned; when billing after a timeout is unknowable, retain partial/unknown cost rather than zero. Do not confuse number of URLs or exposed query strings with a provider's billable search unit.

Label cost calculated from reported usage and a price table as a computed usage cost, not an invoice-verified charge. Preserve a separate provenance field for a provider-reported monetary charge or user-entered bill. A complete computed cost means all supported billing components are known for those attempts; it does not guarantee agreement with discounts, taxes, credits, or a later invoice.

**Files:** `core/config.js`, `core/cost.js`, shared/provider runner code, `core/scheduler.js`, `core/subscription-scheduler.js`, `web/pages/api.js`, settings/preview UI, `mcp/server.mjs`, `.env.example`.

**Expected result:** A person can choose a small useful run and understand its limits without accidentally changing recurring spend.

**Acceptance:** Upgrades preserve existing no-search API behavior and existing subscription consent. Search options never silently add calls to old schedules. Explicitly changing a recurring search profile requires an updated preview/consent consistent with existing product rules. Default recommendation is a small bounded panel, not every provider. A route with no enforceable internal search-call ceiling says so; a forecast must not be called a hard dollar cap. Missing prices show an unknown component and require acknowledgment of uncertainty under the existing run-consent flow.

**Validation:** Stale quote, unsupported option, changed schedule, partial usage, unknown price, continuation cap, cancellation, circuit breaker, and duplicate request tests. Assert that GET/report reads perform zero provider calls. Avoid broad retries that duplicate completed logical targets; ambiguous transport failures remain explicit.

### C04 — `feat: add OpenAI search evidence adapter`

**Reason:** Users need to observe live web discovery through a clearly configured OpenAI API route.

**Work:** Implement the OpenAI contract from section 6; wire request options and normalized evidence/usage to the API runner. Keep the existing non-search profile distinct. Expose only validated policy/model combinations.

**Files:** `core/providers/openai.js`, shared types/runner integration, `test/providers.test.js`, new sanitized fixtures.

**Expected result:** Users can see the searches exposed by the provider, reported sources, actual answer citations, and final brand answer from one auditable run.

**Acceptance:** Completed search with hidden queries remains verified with query metadata unavailable. No-search auto answers remain valid auto observations. Required runs without completed search are excluded with an explanation. Multiple search actions and multiple final-text parts are retained. No source becomes a citation merely by appearing in source metadata. Request/body tests show explicit search configuration.

**Validation:** Success, multiple actions, no search, missing queries, no results, native citation spans, partial answer, refusal, tool error, 401/429/timeout, and cancellation fixtures. An opt-in live smoke check uses authorized credentials and a bounded run; absence of such a check is documented.

### C05 — `feat: add Anthropic search evidence and bounded continuation`

**Reason:** Claude search evidence must survive its block-based response and continuation lifecycle without creating duplicate samples.

**Work:** Implement section 6's Anthropic contract; retain tool IDs, query/result association, citations, terminal status, and aggregate usage for one logical target. Bound continuation count and total elapsed time. A pause does not start a new buyer conversation.

**Files:** `core/providers/anthropic.js`, focused continuation/shared runner helpers, provider fixtures/tests.

**Expected result:** A search-assisted Claude answer has usable evidence and an honest cost/completion state.

**Acceptance:** HTTP 200 search errors are represented; paused text is not marked final; continuation uses the documented unchanged prior blocks; no hidden client tools or code-execution capability is enabled. Mixed success/failure retains evidence and the defined partial-execution eligibility behavior.

**Validation:** Tool success/error, multiple searches, no search, pause then finish, repeated pause hitting cap, truncation, citation association, accumulated usage, retry deduplication, and no-credentials conditions.

### C06 — `feat: add Gemini grounding evidence adapter`

**Reason:** Gemini's structured grounding data can reveal search wording and source-backed answer segments; text-only parsing loses that value.

**Work:** Implement section 6's Gemini contract using the selected supported endpoint. Retain original grounding queries/chunks/supports and transform them into shared evidence records without implying source relationships the response does not expose. Include safe provider-required attribution/presentation support.

**Files:** `core/providers/gemini.js`, citation/offset normalizers, isolated attribution rendering, provider fixtures/tests.

**Expected result:** A user can inspect grounded answer segments and query/source evidence, including explicit missing fields.

**Acceptance:** Chunk-only source evidence is separate from cited support. Invalid support indices or spans do not crash rendering or attach a wrong source. Unicode offsets follow a verified mapping. Absent grounding is not treated as successful required search. Endpoint or request-profile changes create a separate series. Capability errors are actionable.

**Validation:** Queries with/without supports, source-only metadata, no grounding, malformed indices, non-ASCII text, redirects, empty result, safety/refusal response, tool errors, and presentation isolation. Validate current attribution requirements before enabling this route; do not ship raw provider HTML through the general `raw()` rendering helper.

### C07 — `fix: preserve Perplexity and subscription evidence provenance`

**Reason:** Existing search-capable paths should be first-class inputs to the same workflow, without conflating retrieved results and citations or losing multiple queries.

**Work:** Parse Perplexity results and final references separately. Retain query metadata only if actually exposed. Extend Codex/Claude Code parsers to all supported query/result shapes with action IDs/ordinals and bounded event handling. Reconcile start/completion events into one action rather than counting both as independent searches. Continue to store redacted raw event artifacts.

**Files:** `core/providers/perplexity.js`, `core/agent-parsers.js`, `core/artifacts.js`, `core/subscription-runner.js`, relevant fixture tests.

**Expected result:** Existing subscription users and Perplexity users can use the new evidence views without changing their execution surface.

**Acceptance:** A Perplexity response containing two search results and one citation has two source observations and one explicit citation. No query field yields unavailable, not invented queries. CLI events with multiple queries/results retain all exposed data. Unknown event formats remain inspectable/unverified instead of fabricated success. Existing authentication and execution restrictions remain intact.

**Validation:** Different result/citation arrays, numeric citation-reference mapping, query arrays, repeated events, missing action IDs, failed terminal statuses, artifact bounds/redaction, and unchanged legacy-runner authorization tests.

### C08 — `fix: make recommendation classification conservative and auditable`

**Reason:** A negative answer labeled a recommendation can lead to precisely the wrong business decision.

**Work:** Replace the unsafe positive-by-position/proximity shortcut with conservative stance classification (`positive`, `negative`, `neutral`, `uncertain`) and recorded rule/span/version. Keep deterministic mention detection separate. Add append-only human correction with original value, replacement, reason, and timestamp. New “positive recommendation” rate is positives/all eligible answers; uncertain or negative mentions are not positives. Show uncertain counts separately. No mention is a distinct absence, not a neutral brand statement.

Maintain a compatibility mapping for legacy `recommended` consumers and disclose legacy heuristic data. New analysis uses a new revision; old metrics are not silently recalculated. For new series, suppress business-severity alerts that depend on the old heuristic; C14 supplies descriptive replacements.

**Files:** `core/analyze.js`, interpretation/correction storage, `core/metrics.js`, `core/alerts.js`, answer review API/UI, `mcp/server.mjs` where corrections are exposed.

**Expected result:** Users can inspect why a label exists, correct it, and avoid interpreting an “avoid this product” answer as a win.

**Acceptance:** All three baseline regression examples are non-positive. A positive clause about one brand does not leak into a nearby competitor. Conditional/mixed claims may remain uncertain. Unsupported languages default conservatively rather than pretending an English ruleset works universally. Ambiguous ordinary-word brand names can be flagged for review; do not solve entity disambiguation with undocumented heuristics. The correction view is consistent in UI/API/MCP and its revision is visible.

**Validation:** Small human-labeled fixture set spanning positive/negative/neutral/uncertain, negation, headings, comparisons, list items, conditional praise, quotations, multiple brands, and unsupported-language examples. Report precision/coverage on that set without claiming population accuracy. Correction and reanalysis tests preserve original receipts and old review snapshots.

### C09 — `fix: scope metrics and dashboard to exact measurement series`

**Reason:** Subscription-first onboarding must lead to visible results, and a number must describe a coherent measurement.

**Work:** Add surface/profile/benchmark selection to dashboard and result queries; preserve it through cards, drilldowns, alerts, answers, and exports. Implement shared denominators and coverage from section 5.4. Default new UI to a configured series with actual data and disclose the selection. Show a meaningful empty state if no series has data. Never default to an empty API-only dashboard for a subscription-only account.

**Files:** `core/metrics.js`, `web/pages/dashboard.js`, `web/queries.js`, `web/pages/api.js`, `web/pages/answers.js`, `web/layout.js`, `mcp/server.mjs`, `public/app.js`.

**Expected result:** A user can trust that a headline and its receipts refer to the same surface, definitions, and time period.

**Acceptance:** API and agent observations never merge in a trend. Off/auto/required and analysis/benchmark revisions remain separate. New exact-scope API/MCP requests return selected IDs and coverage. Historical explicit ranges do not resolve their series using a future observation outside that range. Auto without search is not excluded from its overall mention denominator. Sources, citations, and mentions have separate rates and labels. Old no-argument interfaces remain clearly documented compatibility behavior.

**Validation:** Subscription-only, API-only, mixed surfaces, model/profile change, query metadata missing, incomplete target, historical range, all-empty/all-error, corrected stance, and receipt-count reconciliation tests. Assert that every displayed total equals its drilldown query.

### C10 — `feat: show buyer questions, searches, sources, and answers together`

**Reason:** Users need the path from a buyer's words to the evidence behind an answer, not just a final percentage.

**Work:** Build an intent-level evidence view and answer detail expansion for the five layers. Add exact-query grouping with transparent normalization and optional manual theme labels. Query reporting shows response incidence, raw occurrences, and metadata coverage. Source reporting groups by URL and publisher where known, with explicit evidence-layer filters. Preserve original wording, source links, dates, model/profile, and receipt IDs. Add read-only API/MCP access to the same data.

**Files:** Focused metrics/query helpers, existing answer/prompt pages or a new small evidence page, `web/pages/api.js`, `mcp/server.mjs`, styles and UI tests.

**Expected result:** A person can identify recurring evaluation criteria and investigate which sources provide useful information.

**Acceptance:** UI says “observed search queries,” never “keywords customers search X times.” No fabricated query-to-source edges. A repeated query within one answer counts once for response incidence. User theme labels remain separate from raw evidence and are not inferred search-volume data. Missing evidence is visible. Every aggregate opens its exact supporting records. Query text, source titles, and answer HTML are safely escaped.

**Validation:** Grouping and denominator fixtures, unknown associations, multiple queries, redirect publisher unknown, malicious text/link protocols, keyboard navigation, and empty states. Release A gate: C00–C10 complete, no enabled provider has an unmet contract/presentation gate, and exact-scope metrics reconcile.

### C11 — `feat: guide users to a small buyer-focused benchmark`

**Reason:** An accurate measurement of irrelevant questions still wastes the user's money and time.

**Work:** Extend setup with audience, product/job, desired conversion, language/market context, and user-supplied buyer questions with source notes. Separate discovery/comparison/branded categories. Offer an editable starting suggestion of five intents with three phrasings each, not a minimum sample guarantee; allow fewer and expose the actual call count. Keep exploration separate and explicitly review/promote tracking questions. Persist revisions through C02's contract.

Make subscription-only setup useful without an API key: manual questions, a fully populated deterministic starter pack, or drafts supplied by the connected assistant through existing setup interfaces. Do not silently use a measurement CLI to generate prompts or incur analysis usage. Reject unresolved template placeholders before tracking.

**Files:** `web/pages/setup.js`, `core/suggest.js`, prompt/intents API and UI, `public/app.js`, MCP setup tool schemas, `skill/SKILL.md`.

**Expected result:** The first panel represents the user's buying decision and starts at a deliberately small cost.

**Acceptance:** No configured measurement route is required just to draft/edit a benchmark. At least one valid route is required to run. All tracking questions have been reviewed. Competitor/alias/prompt changes create revisions and explain continuity effects. Editing a prompt does not rewrite historical snapshots. User-supplied sales/support content is not automatically sent to a provider until incorporated into the approved prompt. A locale preference is not presented as an enforced provider control unless supported.

**Validation:** Fresh real-brand setup, subscription-only, API-only, no provider, no competitor, placeholder rejection, intentional competitor-named prompt, duplicate paraphrases, promotion, edit during an in-flight run, and cost-preview counts.

### C12 — `feat: turn evidence into reviewable opportunities`

**Reason:** The user wants to know where to spend effort; a domain list leaves too much interpretation work to them.

**Work:** Implement the opportunity contract from section 7, evidence selection from the query/source report, conservative candidate generation, review/dismissal, manual priority/effort, and structured MCP proposals. Add page-evidence attachment with source and observation time. Do not fetch arbitrary URLs automatically. Missing page evidence leaves a candidate at “investigate.”

**Files:** New focused `core` opportunity module and tables/migration, opportunity page, API/MCP routes, linked evidence UI.

**Expected result:** A user can leave a session with a small, concrete, evidence-backed shortlist.

**Acceptance:** Every observed claim references valid records in the selected scope; assistant-authored interpretation is labeled. No auto-claim that the website lacks a capability merely because a model omitted it. Known false/outdated answer claims need user-supplied authoritative evidence; otherwise classify as “verify this claim.” Candidates can be dismissed, combined with retained provenance, or marked not worth acting on. Regeneration does not recreate a dismissed duplicate without new evidence and an explanation.

**Validation:** Missing/wrong-scope evidence IDs, stale/deleted artifact references, manual excerpt provenance, duplicate candidate handling, unsupported factual claims, user acceptance, and read-only zero-spend tests. No background LLM suggestion dependency.

### C13 — `feat: record interventions and follow-up plans`

**Reason:** A visibility trend becomes useful when linked to a real change and a preselected question about its effect.

**Work:** Implement action states, ownership, target URL/feature, estimated and actual effort, shipped timestamp, changelog, baseline selection, primary metric/intents, review window, and optional comparison intents. Choose the baseline and metric before shipping when possible; flag retrospective selections. Record model/profile changes during the window. A follow-up can use existing observations or an explicit run preview.

**Files:** Opportunity/action storage and service, action detail UI, API/MCP routes, links from evidence/dashboard.

**Expected result:** Users remember what they changed, why, and what evidence would inform their next decision.

**Acceptance:** Marking shipped does not trigger paid work, publication, or a schedule edit. Baseline and review snapshots remain reproducible. An unshipped/dismissed item does not appear as a completed experiment. A date change preserves its history. A new benchmark is not silently substituted into an existing experiment.

**Validation:** State transition, timestamp/window ordering, baseline after publication warning, edit/audit history, multiple actions affecting one intent, and model/benchmark change fixtures. Concurrent updates use existing concurrency controls or an explicit record-version check.

### C14 — `feat: compare interventions with transparent descriptive results`

**Reason:** Users need an honest follow-up that neither celebrates noise nor hides an unresolved experiment.

**Work:** Implement section 8's descriptive comparison and user review. Use saved snapshots, half-open time windows, equal fixed prompt weights, and an explicit common-cell intersection where requested. Default to the full saved benchmark; if it cannot be compared completely, report insufficient/incomparable data. A common-subset comparison is a separate explicit selection with dropped cells and its own scope, not a silent fallback.

Replace unsupported business-severity alerts for new-series changes with scoped observations and operational health alerts. Historical alerts remain visible as legacy records. Saved review records reference the exact data cutoff and analysis/correction revision. Do not mark an intervention as effective automatically.

**Files:** `core/metrics.js`, new focused comparison module, `core/alerts.js`, review UI, API/MCP summary/report routes.

**Expected result:** A user sees what moved, what remains uncertain, and whether the evidence supports continuing the work.

**Acceptance:** Unequal numbers of successful repeats do not silently change prompt weights. Missing data, source metadata coverage changes, and different models/profiles are surfaced. Boundary observations are counted once. Zero brand mentions with valid samples differs from zero valid samples. Changes in query themes are descriptive and never evidence of a causal SEO mechanism. No statistically significant/proven-win language; no within-CI heuristic as an effect test.

**Validation:** Known count/delta fixtures, different coverage, no data, all zero mentions, explicit common subset, different revisions, model alias metadata change, overlapping action windows, corrections after a saved review, and small-sample alert suppression. Verify that operational alerts do not masquerade as visibility losses.

### C15 — `feat: add outcome records and a useful weekly review`

**Reason:** Users care about qualified customers and saved time; visibility alone cannot answer whether effort is worthwhile.

**Work:** Add manual/CSV outcome records and cost/time ledger from section 8. Build an on-demand weekly review composed of selected-series coverage/health, important evidence, up to three user-prioritized opportunities, shipped actions due for review, descriptive changes, and reported outcomes/costs. Include “nothing requires action” when appropriate. Support local HTML/Markdown/JSON export as appropriate and a read-only MCP report. These exports require no third-party messaging integration.

**Files:** Outcome storage/validation module, outcome/review pages, API/MCP, export helpers.

**Expected result:** A user can decide to continue, change direction, or pause without opening every dashboard page.

**Acceptance:** Imported metrics retain units, currency, period, source, and attribution method. Overlapping imports are flagged/deduplicated using explicit import identity; do not silently sum. The weekly review does not attribute organic growth or unattributed conversions to Hearsay. Missing usage/outcomes remain unknown. No hidden provider calls occur while generating a report. Sharing/exporting is deliberate; no email/webhook sending is implemented in this milestone.

**Validation:** Duplicate imports, malformed dates/counts/currency, overlapping periods, CSV quoting, spreadsheet formula injection on any CSV export, empty outcomes, partial costs, existing report data, and consistent UI/API/MCP scopes. Treat user-entered outcome values as reported data, not verified analytics.

### C16 — `fix: separate demo setup and make tracking health obvious`

**Reason:** Users should not delete a database to try their own brand or mistake a stopped local process for continuous monitoring.

**Work:** Provide a separately stored, clearly labeled demo instance/mode and a direct real-brand setup path. Existing data must never be silently moved/deleted. Show last successful observation, next scheduled occurrence, schedule enabled/disabled state, and missed/failed runs. Document one supported background-service setup for the intended platform(s), with explicit start/stop instructions and no automatic installation. Keep existing scheduler consent and missed-occurrence behavior; do not add catch-up spending.

**Files:** Demo/seed entry points, `server.js` startup/setup navigation as needed, settings/dashboard, scheduler health queries, README/service documentation.

**Expected result:** People can get started and understand whether measurements are actually being collected.

**Acceptance:** Demo and real data have distinct database/artifact paths and cannot contaminate each other's summaries. Switching views cannot enable live providers in demo. Existing real data survives the setup flow. A stopped service produces stale-data guidance after restart, not fabricated continuity. A configured subscription-only service shows useful results and health.

**Validation:** Fresh demo-to-real path without deletion, existing real database, existing demo database, path collision, restart, missed run, disabled schedule, and changed profile requiring updated consent. Prefer documented manual service setup over a new privileged cross-platform installer.

### C17 — `docs: ship the evidence-to-action workflow and review checklist`

**Reason:** UI, agent instructions, and methodology must teach the same behavior; stale assistant instructions can recreate every ambiguity this plan removes.

**Work:** Update README, METHODOLOGY, optional skill, setup examples, screenshots/fixtures, and API/MCP documentation. Explain search policies, exact surfaces, evidence coverage, discovery versus branded questions, opportunity acceptance, interventions, descriptive comparisons, and reported outcomes. Update “no system prompt” wording to accurately describe each versioned route/envelope. Document prices as checked data, not permanent facts. Add the concrete review checklist in section 12 to the PR handoff.

**Files:** `README.md`, `METHODOLOGY.md`, `skill/SKILL.md`, relevant docs/screenshots, API/MCP schemas/descriptions, tests for exposed behavior.

**Expected result:** Humans and assistants can complete the same workflow without assuming unavailable capabilities or overstating findings.

**Acceptance:** The skill chooses an explicit surface/profile, handles subscription-only setup, never reconstructs hidden queries, and presents rates with scope/n. It distinguishes a source from a citation and a hypothesis from observation. The weekly recipe covers actions and review outcomes. No instruction still advises deleting the real database to leave demo. New provider capability limitations and unperformed live checks are visible in the handoff.

**Validation:** Full repository test suite and typecheck, completed end-to-end scenarios below, and visual checks of changed pages on narrow/wide layouts and both existing themes. Release B gate: C11–C17 complete, no required behavior is replaced with an undocumented placeholder, and all remaining provider limitations are explicitly listed.

## 10. Required end-to-end acceptance scenarios

Use fixtures and fake adapters/CLIs for deterministic automated tests. Live smoke checks are separate, opt-in, bounded, and never run from CI.

| ID | Scenario | Required observable result |
|---|---|---|
| E01 | New user with only Codex or Claude Code configured | Review a small benchmark, preview/run through existing consent, see exact-surface dashboard and evidence, create an opportunity |
| E02 | New API user with a supported search profile | Search configured explicitly; evidence, final citations, usage, and profile recorded; run visible in dashboard |
| E03 | Existing API user upgrades without changing settings | No new search execution or recurring charges; legacy observations preserved |
| E04 | Search succeeds but query text is not exposed | Search verified, query wording unavailable, coverage disclosed; no reconstructed text |
| E05 | Auto answer completes without searching | Included in auto-answer metrics, counted as not used only when supported by response semantics |
| E06 | Required search is absent, fails, or remains incomplete | Answer retained for diagnosis; excluded from required comparable metrics; coverage and usage still counted |
| E07 | Results contain competitor pages but final answer cites a different source | Source and citation reports remain different; receipt links reconcile |
| E08 | Provider continuation/retry | One logical sample, all known usage retained, no duplicate query/action counting |
| E09 | Brand explicitly discouraged | No positive recommendation; user can inspect and correct the stance |
| E10 | Prompt, competitor alias, model, search policy, or analysis version changes | New relevant revision/series; no silent before/after splice |
| E11 | User investigates a gap and records a shipped change | Evidence and hypothesis retained; baseline/review dates and target recorded; no automatic publication or spend |
| E12 | Follow-up has unequal coverage or incompatible profile | Insufficient/incomparable result or explicit reviewed common subset, not an automatic win |
| E13 | User enters outcomes and requests weekly review | Actionable short report with reported outcomes and partial costs; no invented ROI or hidden calls |
| E14 | Malicious provider text, unsafe URL, or provider HTML | Safely rendered/isolated or rejected; no script execution, local-file access, or unintended server request |
| E15 | Migration followed by interrupted run/restart | Old data readable, new evidence consistent, interrupted target explicit, no duplicate scheduled occurrence |
| E16 | Demo-to-real setup | Real data remains intact, demo never spends, no database deletion required |

## 11. Engineering constraints and failure behavior

- Preserve zero runtime dependencies, plain ESM/JSDoc, built-in SQLite, and the no-build installation. Do not introduce an ORM, frontend framework, external database, or queue service for this scope.
- `core/analyze.js` and metric computations remain deterministic with timestamps supplied. Network/provider I/O belongs outside analyzers/metrics. Keep changed interfaces typed consistently.
- Append migrations; use existing migration backup machinery. Test prior supported versions and a populated current database, not only a fresh schema.
- Respect existing single-run/concurrency and schedule idempotency rules. Revalidate target ceilings before execution. Add cancellation/recovery support where a new continuation path requires it.
- Limits must be finite and documented: targets, samples, provider response bytes/events, action/query/source counts, continuation count, elapsed time, and stored excerpt size. Hitting a parser/evidence limit produces an explicit partial/failed state; do not silently truncate evidence while claiming full coverage.
- Retain raw/redacted evidence only under the existing artifact retention model; keep normalized receipts useful after artifact expiry. Do not store API keys, auth headers, CLI credentials, hidden reasoning streams, or arbitrary local file contents. Avoid broad raw-response dumps when only allowlisted evidence blocks are needed.
- Treat queries, provider text, imported snippets, titles, and URLs as untrusted data. Existing safe URL/HTML rules apply. Do not add automatic fetching of source URLs in metrics/UI render paths; this avoids both latency surprises and a new server-side request surface.
- Provider-required presentation has to be both compatible and isolated. Do not silently remove attribution to fit Hearsay's design, and do not embed executable external markup into the main document.
- Distinguish attempted/failed/skipped/complete/comparable counts. Cost reporting uses all attempts with known usage, independently of whether they qualify for metrics. Unknown spend is not zero; a known subtotal is not a full bill.
- Empty states must explain next steps: no setup, no enabled route, unsupported model/policy, awaiting first run, no verified search, metadata unavailable, insufficient comparable data, or nothing worth action. Do not show a misleading zero score.
- Retain API/MCP compatibility where practical through additive fields and clear legacy defaults. For a necessary breaking change, add a versioned route/contract and migration documentation rather than silently reinterpreting an existing field.
- Use indexed, bounded, paginated evidence queries. Aggregation joins must not multiply denominators by queries or citations; use distinct response IDs or separately aggregated child sets. Test a response with multiple queries and citations specifically for this failure.
- Do not add central telemetry. Pilot measurement can be local or collected through explicitly volunteered exports/interviews. No unrequested outbound messaging.

## 12. Diff-review handoff

For each implementation batch, provide the commit range and a review note with:

1. **User outcome:** What can a user now do, and why does it matter?
2. **Contract change:** Request, evidence, denominator, storage, API/MCP, and cost changes.
3. **Evidence:** Relevant automated tests, UI screenshots where helpful, and sanitized live-smoke evidence only if actually performed.
4. **Compatibility:** Migration behavior, old defaults, changed series identities, and backup/rollback instructions.
5. **Limits:** Unsupported provider/model/policy combinations, unavailable query metadata, and unperformed verification.
6. **Remaining work:** Next commit dependency and any explicit blocker.

Reviewer checklist:

- [ ] Search is explicitly configured and verified according to each provider contract.
- [ ] A query shown as observed actually exists in provider evidence.
- [ ] Queries, returned sources, fetches, final citations, and recommendations remain distinct.
- [ ] Missing/failed/partial evidence is visible and cannot masquerade as brand absence.
- [ ] Subscription-only users see their actual results throughout the workflow.
- [ ] Every headline/aggregate drilldown reconciles to the same scope and denominator.
- [ ] Search policies, profiles, benchmarks, and analysis revisions are not silently blended.
- [ ] Negative/uncertain statements do not become positive recommendations by position alone.
- [ ] No new search or analysis spending occurs merely from upgrade, page view, or report read.
- [ ] Known usage includes attempts/continuations; unknown spend remains explicit.
- [ ] Opportunities distinguish observed facts, reviewed page evidence, and hypotheses.
- [ ] An accepted/shipped action does not authorize external publication or automatic runs.
- [ ] Follow-up is descriptive, reproducible, and honest about coverage and causality.
- [ ] Outcomes have sources/units/time windows and are not inferred from mention counts.
- [ ] Demo setup does not delete or contaminate real data.
- [ ] Existing tests plus meaningful new failure-case tests and typecheck pass, or unrelated baseline failures are specifically documented.

## 13. Pilot and success criteria

Recruit a small voluntary pilot, initially five to ten users matching the audience hypothesis. This is a proposed validation exercise, not a product feature requiring implementation or an instruction to contact anyone now.

Record the full funnel and reasons for stopping:

| Question | Measurement |
|---|---|
| Can people start? | Setup completion, first valid observation, time to first evidence-backed finding |
| Is the evidence useful? | User explanation of the finding; opportunity accepted/dismissed and reason |
| Does it cause worthwhile work? | Action shipped, effort spent, whether the user says the action was worth doing |
| Do people return? | First scheduled/on-demand review completed; repeat use after that review |
| Can people assess value? | Reported business evidence and tracking/work costs; continue/pause decision |
| Does the tool save attention? | Time spent interpreting each review and number of unhelpful alerts |

Do not make a retention or revenue improvement claim without observing it. A pilot revealing no useful opportunity is valuable information; retain dismissal and pause outcomes. Prioritize fixing breakdowns in this funnel before adding more providers, sentiment dashboards, or large automated prompt packs.

## 14. Implementation completion definition

The work is complete when a real-brand user, through the UI or documented MCP flow, can choose a reviewed buyer benchmark, run a supported search-enabled profile with clear consent, inspect actual query/source/citation evidence, accept a justified opportunity, record a change, and return to a reproducible review with separately reported business outcomes and costs.

The user must also be able to learn that a result is uncertain, a route is unsupported, a change cannot be fairly compared, or further work is not justified. Those are successful honest states—not reasons to manufacture a score or recommendation.

The handoff should contain reviewable commits and accurate verification notes. It should not contain unreviewed production deployment, claims of guaranteed ranking gains, or a declaration of perfection unsupported by tests and provider evidence.
