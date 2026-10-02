# Agent-led website studies implementation plan

> For agentic workers: use Superpowers execution guidance task by task. Steps below track implementation and verification. The user has authorized implementation of the referenced spec.

**Goal:** Let a founder's existing assistant operate a durable, editable website study, with optional bounded Tavily collection and separate business-result comparisons.

**Architecture:** Add version-one study records beside existing research panels and runs. One workspace service appends immutable evidence and updates a small manifest. Collection coordinates approved scope and isolated research runs; reports derive facts from saved records, while the host agent supplies analysis and recommendations.

**Tech stack:** Node 22.13+, JavaScript with checked JSDoc, built-in filesystem, SQLite locking, fetch, node:test. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-agent-led-website-study-design.md`

## Global constraints

- Preserve existing version-one project and evidence schemas, original captures, panel revisions, and runs.
- An approved contract authorizes its exact recurring scope. Account run and schedule receipts remain distinct and carry the study approval reference. Every selected account route needs a successful search-verified trial before recurring execution.
- Independent trials receive only neutral questions and the execution envelope. Contextual research and diagnostics have no recommendation denominator.
- Default six-query baseline is occurrence 1 of 30, with at most 29 repeats. Basic Tavily search consumes 180 collection credits plus up to 20 separately recorded diagnostics.
- Unknown capacity, changed scope, exhausted limits, and ambiguous retries cannot cause unapproved requests. Coordinate credits at account level across apps.
- Publication, direct fetch, snippet evidence, URL-only results, and Google indexing remain separate facts.
- Reports keep search visibility, AI recommendations, and actual business outcomes separate. Missing or poorly matched outcomes produce an inconclusive comparison.
- No live provider calls, changes to public pages, recurring job installation, deployment, or push during development.
- All writes return stable receipt identities. Store no credentials in histories, reports, bundles, or isolated model environments.

## Review focus

- Restart after a reservation or occurrence claim must preserve spent capacity and leave analysis visibly due.
- Changed content, query wording, route profile, or budgets must not inherit old authorization.
- An unchanged reference page with different traffic cannot establish causation.
- A URL match without old-versus-new distinguishing text cannot establish version exposure.
- Portable hosts without runtime or isolated trials still produce resumable research audits.

## Shared interfaces and records

All study records use `version: 1`, stable `id`, `studyId`, and `appId` where applicable. Safe identifiers match existing research IDs. `StudyRecord` uses the repository's validated JSON-record convention.

A plan has `id` (revision), `studyId`, `app` (existing app identity), `targetUrl`, `comparison` (`design`: `before_after`, `unchanged_reference`, or `controlled_allocation`; `referenceUrl`, `assignment`, `trafficNotes`), `outcome` (`metric`, `unit`, `minimumDenominator`, `minimumObservations`, `minimumEffect`, `lossLimit`, `reviewPeriodDays`, `stopRules`), `angles` (id, label, buyerJob, rationale, evidenceIds, questionIds), `questions` (id, angleId, text), `collection` (at, timezone, occurrences, maxDays, firstReviewDays, reviewEveryDays), `tavily` (enabled, accountId, searchDepth, maxResults, collectionCredits, diagnosticCredits, allowance, strictFreeMode), `permissions` (actions, repository, publishTarget), `reportDestination`, and nullable `research` binding.

The research binding stores `projectHash`, `runQuote`, `scheduleQuote`, `targetCount`, and the exact run and schedule previews. The runtime checks the current project and quote before any execution. Plans can omit research routes and use host research or Tavily alone.

The workspace snapshot is `{manifest, plan, plans, approvals, pages, versions, searchRuns, researchRuns, changes, events, outcomes, reviews, analyses}`. `researchRuns` contains linked validated evidence bundles. Search runs contain Tavily receipts and exposures. Page receipts retain requested/final URL, method, hashes, extractionRevision, timestamp, and file paths. Versions link page receipts and optional changes/publication/reversion. Analyses link occurrence IDs and evidence IDs, recommendation, reason, nextAction, and author. Reports never infer assistant analysis from collection alone.

### Task 1: Study contracts and immutable workspace

**Files:** `core/study-contract.js`, `core/study-workspace.js`, `skill/templates/study.json`, `test/study-workspace.test.js`, `test-support/study-fixture.js`.

**Interfaces:** `validateStudyPlan(input)`, `validateStudyRecord(kind,input)`, `studyHash(input)`; `createStudy(projectDirectory,plan) -> {studyDirectory,manifest}`, `proposeStudyPlan(studyDirectory,plan)`, `loadStudy(studyDirectory) -> snapshot`, `previewStudy(studyDirectory) -> {plan,quoteId,estimate}`, `approveStudy(studyDirectory,quoteId,{author,now?}) -> approval`, `appendStudyRecord(studyDirectory,kind,record) -> record`, `captureStudyPage(studyDirectory,{url?,html?,content?,method?,finalUrl?,fetch?,now?}) -> receipt`, `recordStudyVersion(studyDirectory,input)`, `recordStudyDecision(studyDirectory,input)`, `recordStudyAnalysis(studyDirectory,input)`, `inspectStudy(studyDirectory) -> resumable snapshot`, `withStudyLock(studyDirectory,callback)`.

- [ ] Add behavior tests for plan validation, neutral angle questions, editable revisions, exact approval, immutable captures, page version/reversion history, cross-study references, source hashes, concurrent writes, and external page changes becoming pending.
- [ ] Implement bounded boundary validation, safe paths, immutable append records and atomic manifest writes. Reuse workspace helpers and lock invariants. Explicitly retain historical approvals and plans.
- [ ] Save the real original page and derived content separately. Direct fetch creates page evidence, not search or Google-index evidence.
- [ ] Run `node --test test/study-workspace.test.js` and typecheck; record results.

### Task 2: Tavily search and account credit coordination

**Files:** `core/tavily-search.js`, `test/tavily-search.test.js`.

**Interfaces:** `collectTavily({accountDirectory,accountId,studyKey,allowance,collectionCredits,diagnosticCredits,occurrenceId,lane,queries,searchDepth,maxResults,strictFreeMode,now?,apiKey?,fetch?,signal?}) -> receipt`; `inspectTavilyLedger(accountDirectory,accountId)`.

Queries are `{id,text,angleId}`. Receipt includes `version,id,studyKey,occurrenceId,lane,status,startedAt,completedAt,searchDepth,records,creditSummary`. Each record has `id,questionId,angleId,query,status,requestId,credits,raw,results,errorCode`; sources have URL, title, content and score. Requests use fixed `auto_parameters:false`, `include_answer:false`, `include_usage:true`. Default basic depth costs 1, advanced costs 2 if explicitly approved. Capacity uses the documented account and key usage response. Strict free mode requires usable provider hard limits and no paid fallback.

- [ ] Pin 30 six-query occurrences to exactly 180 credits, plus a distinct diagnostic allowance. Test unknown/exhausted usage, external usage, concurrent apps, duplicate ticks, interrupted reservations, ambiguous timeouts, HTTP errors, bad responses, key redaction, and basic request settings.
- [ ] Implement account-level serialized ledger, reserve before fetch, conservative ambiguous charging, immutable cached receipts, usage reconciliation, and halted collection on authentication/quota/policy failures.
- [ ] Run `node --test test/tavily-search.test.js` and typecheck; record results.

### Task 3: Outcomes, factual reports, optional dashboard reader

**Files:** `core/study-outcomes.js`, `core/study-report.js`, `core/study-store.js`, `test/study-report.test.js`, `test/study-store.test.js`; bounded integration in existing database/router/dashboard files after coordinating ownership.

**Interfaces:** `normalizeStudyOutcome(input) -> record`, `parseStudyOutcomeCsv(csv,{studyId,appId,source,changeId}) -> records`; `deriveStudyReport(snapshot) -> {version,id,studyId,appId,summary,angles,exposure,business,scheduling,analysis,markdown}`, `deriveStudyExposure({url,content,method,versions,pages,activeVersionId}) -> record`; dashboard imports a validated exported study snapshot as immutable external provenance.

Outcome records have `source,recordKey,pageUrl,periodStart,periodEnd,metric,value,unit,currency,denominator,attributionMethod,trafficNotes,changeId,phase` (`baseline` or `after`) and optional cohort/assignment metadata. Keep counts/revenue/costs separate. Preserve raw CSV and reject duplicate/conflicting keys and invalid references. Never synthesize missing denominators.

- [ ] Exercise saved angle/question search counts separately from isolated recommendation denominators; mark old/unknown content and pending analyses correctly.
- [ ] Exercise missing denominators, small samples, unmatched pages/windows, reference traffic mismatch, controlled assignment documentation, business data with no native series, and historical reports.
- [ ] Implement deterministic report derivation and outcome CSV normalization. Show scheduling configured/connected/last success/missed/stopped distinctly.
- [ ] Add optional immutable dashboard import/list/detail with external provenance, keeping native series untouched. Verify the reader through real API and rendered page checks.
- [ ] Run focused report/store tests and typecheck; record results.

### Task 4: Approved occurrences, resumable analysis, and CLI

**Files:** `core/study-schedule.js`, `bin/hearsay.js`, `test/study-schedule.test.js`, `test/study-cli.test.js`.

**Interfaces:** `prepareStudyResearch(studyDirectory,{preview?,now?}) -> revised plan preview`, `collectStudyOccurrence(studyDirectory,{occurrenceId?,scheduled?,now?,accountDirectory?,fetch?,apiKey?,researchPreview?,runnerFactory?}) -> occurrence`, `studyScheduleTick(studyDirectory,options)`, `connectStudySchedule(studyDirectory,{kind,receipt,command,now?})`, `stopStudyCollection(studyDirectory,reason)`.

- [ ] Test approval before requests, exact quote binding, route baseline prerequisite, approval-referenced run/schedule receipts without a second owner decision, neutral independent sessions, baseline within 30 occurrences, unchanged caps, missed ticks, duplicates, lock interruption, changed scope and analysis-due recovery.
- [ ] Coordinate study lock, immutable occurrence events, bounded Tavily calls, saved research links, exposure records, and assistant analyses. Failed or partial collection retains evidence and analysis due. A runtime collector never invents an analysis.
- [ ] Expose `study create|preview|approve|inspect|capture|version|propose|decision|collect|tick|analysis|outcomes|report|export|import|connect|stop` with explicit input files and IDs. Report and export only read saved data. Collection commands use the approved current scope.
- [ ] Run focused schedule/CLI tests and existing research runtime tests.

### Task 5: Agent workflow, README, bundles, and completion audit

**Files:** `skill/SKILL.md`, `skill/references/studies.md`, `skill/templates/study.json`, `README.md`, `scripts/verify-skill-discovery.js`, tests where needed.

- [ ] Teach the host to inspect the actual product, generate and rank sourced angles, propose editable defaults and limits, obtain one owner decision, preserve independent sessions, draft approved changes, report every analysis, resume saved work, and distinguish exposure from Google indexing and sales.
- [ ] Make the assistant prompt the primary entry and accurately present optional Tavily's 1,000 monthly credits. Cite checked pricing. Explain runtime collection versus connected agent automation.
- [ ] Build all host bundles and verify the new reference is discoverable and archives exclude credentials, page captures, histories, and user data.
- [ ] Run the complete suite, typecheck, dependency check, bundle verification and a fixture-backed founder journey. Audit all ten spec behavior checks against authoritative evidence before completion.

## Execution ledger

- 2026-10-02: Resumed at `202c8f1`; implementation absent. Existing design authorization supersedes its stale draft status. Prior review document is preserved untracked.
- 2026-10-02: Work continues on local branch `agent-led-website-studies` in the shared checkout. No remote mutation is authorized. Bounded independent modules can be delegated after fixing the shared interfaces above.
- 2026-10-02: Baseline suite passed 576 checks. Tasks 1–3 delegated with disjoint file ownership; integration and workflow documentation remain with the primary agent. Ruling: independent modules run concurrently because their files and shared interfaces are fixed, then receive a combined fresh review. Cost if wrong is integration rework, not remote mutation.
- 2026-10-02: Study collection integration proves baseline plus 29 daily repeats sends exactly 180 basic Tavily searches. A single owner decision binds account run and schedule quotes; recurring account trials reject an unverified baseline and changed project scope. Source CSV retries preserve original data without duplicate outcomes.
- 2026-10-02: Bundles built and actual Codex, Claude Code, and Gemini discovery passed without inference. Blank study templates leave Tavily disabled with zero credits; the host proposes the 200-credit six-question plan after inspecting the product.
- 2026-10-02: Full-suite MCP test exposed a stale exact tool-count assertion and leaked its child on failure. Updated expectations for three study tools and added cleanup on assertion failure. Focused MCP verification passes.
