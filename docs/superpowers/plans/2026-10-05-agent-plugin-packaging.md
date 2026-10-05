# Agent plugin packaging implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make Hearsay installable as a complete local plugin whose agent can inspect setup, infer a product, propose a study, and connect approved collection without a repository checkout.

**Architecture:** Ship the canonical skill with a shared Node runtime. The agent invokes the runtime directly and supplies host capabilities and evidence-based product details; the runtime validates and persists setup state. Existing study commands remain the collection and consent authority. Codex is the first complete host; Claude Code and Gemini use the same archive and contract.

**Tech stack:** Node 22.13+, ES modules, built-in filesystem/crypto/process APIs, existing SQLite and JSON contracts, node:test.

**Spec:** `../specs/2026-10-05-agent-plugin-packaging-design.md`

## Global constraints

- No new runtime dependencies, provider calls, paid usage, real credentials, recurring jobs, or external publication during implementation verification.
- Keep `.hearsay/<app-id>/` outside the plugin installation and preserve raw inputs and existing history.
- No HTTP server, fixed port, or MCP registration is required for plugin commands.
- Keep credentials out of setup files, reports, logs, bundles, and isolated prompts.
- Reuse exact existing study approval and route prerequisites; provider and schedule changes require fresh applicable approval.
- Implement Codex first, then verify Claude and Gemini packaging with the same contract.

## Review focus

- Product identity conflicts with an existing workspace must fail without rewriting history.
- Installed CLIs and present secrets must not be reported as verified measurements.
- Missing Node and host capabilities must leave a usable research-only route.
- Plugin relocation or upgrade must not break saved schedules or move project state into installation directories.
- A saved schedule must not be reported as connected, and a collector must not be reported as completed agent analysis.

---

### Task 1: Shared setup contract and local inspection

**Files:** Create `core/plugin-setup.js`, `test/plugin-setup.test.js`; modify `bin/hearsay.js`.

**Interfaces:** `inspectSetup(options)` returns version, runtime, workspace, host capabilities, route discovery, Tavily presence, actionable missing steps, and scheduler capabilities. `saveSetup(directory, input)` validates an inferred profile and evidence references, persists non-secret setup state atomically, rejects conflicting app identity, and preserves existing project data. `readSetup(directory)` returns saved state or null. All command output is JSON; inspection has no inference or collection side effects.

- [ ] Write tests for profile persistence, ambiguous identity, existing workspace conflict, credential field/content rejection, missing keys, route status, and no setup side effects.
- [ ] Run focused tests and observe failure before implementation.
- [ ] Implement setup state and inspection using existing `discoverAgents`, atomic JSON helpers, and boundary validation. Host filesystem/web/task capability claims are supplied explicitly and labelled host-reported.
- [ ] Add `hearsay doctor`, `hearsay setup inspect`, and `hearsay setup save --project DIR --input FILE`; default setup action is inspection.
- [ ] Run focused setup and CLI tests and commit this verifiable unit.

### Task 2: Complete runtime bundles

**Files:** Modify `scripts/build-bundles.js`, `test/skill-package.test.js`; add runtime package metadata and license entries through the generator.

**Interfaces:** Every existing target returns `{target,directory,archive}` and contains a relocatable `runtime/bin/hearsay.js`, its dependency closure, required schemas, package version/engine metadata, and license. The canonical skill remains byte-equal in all host bundles.

- [ ] Add failing tests that extract each archive outside the repository and invoke `--help`, `doctor`, `setup save`, and `study preview` without a source checkout or `node_modules`.
- [ ] Implement a reviewed runtime allowlist from repository source, including `runtime/skill/schemas` for the existing contract resolver. Refuse symlinks and unsafe output directories; do not package `.env`, data, tests, video, or machine files.
- [ ] Verify archive contents, source byte equality, portability, secret exclusions, and unchanged workspace history after a bundle replacement.
- [ ] Commit the complete distribution unit.

### Task 3: Conversational onboarding and provider setup guidance

**Files:** Modify `skill/SKILL.md`, `skill/references/installation.md`, `skill/references/cli.md`, `skill/references/studies.md`, `README.md`; create `skill/references/setup.md` and `skill/templates/setup.json`.

**Interfaces:** The skill derives the plugin root from its own installed path, runs the packaged executable with absolute paths, passes an explicit workspace, and saves only an evidence-based inferred profile. It resumes existing studies and asks only material unknowns. Secrets and host capability limitations remain separate from product inference.

- [ ] Write assertions covering setup resource discovery and host-specific runtime path resolution in package tests.
- [ ] Document one first-run path with exact commands, an inferred profile template, known-product and unknown-product conversations, secure credential/login actions, and actionable missing-runtime fallback.
- [ ] Show a concise founder approval over the actual plan; do not ask founders to read hashes or manually edit files. Preserve route isolation, study limits, page approval scope, and existing record schemas.
- [ ] Document implemented measurement routes accurately; Gemini host installation does not create a Gemini CLI measurement route.
- [ ] Run resource and bundle verification and commit the onboarding unit.

### Task 4: Study scheduler connection and lifecycle

**Files:** Modify `core/study-cli.js`, `core/study-schedule.js`, `core/plugin-setup.js`, `bin/hearsay.js`, study references; add `test/plugin-schedule.test.js`.

**Interfaces:** Schedule preview exposes timezone, time, occurrence limit, exact command, route/credit limits, collector-only analysis status, and connection requirements. Cron installation is an explicit quoted action with backup and preservation of unrelated entries. Native agent tasks are installed by the host, verified by the host, and connected through existing study records.

- [ ] Add failing tests for unapproved installation, unchanged approval reuse, cron backup, duplicate installation, cancellation, changed plan, collector analysis due, and relocation-safe invocation.
- [ ] Extend existing study scheduling without bypassing its approved plan, verified baseline, due-occurrence locks, account ledger, or no-catch-up rules.
- [ ] Save absolute project and runtime identities; expose broken runtime references as repair-required. Reinstallation does not silently reconnect a stale task.
- [ ] Provide exact native task instructions and verification receipt; only verified installed jobs are labelled connected.
- [ ] Run focused schedule/CLI tests and commit the lifecycle unit.

### Task 5: Clean-host plugin verification and delivery receipts

**Files:** Modify `scripts/verify-skill-discovery.js`, `package.json`; create `scripts/verify-plugin-runtime.js`, `docs/plugin-verification.md`; modify plan/spec status as appropriate.

**Interfaces:** Verification runs install/discovery without inference and invokes the installed runtime from the installed plugin path in an isolated workspace. It uses fake route and provider fixtures for study preview, approval rejection/acceptance, capture, collection, analysis, report, and schedule behavior. No personal host configuration is changed.

- [ ] Verify Codex installation then use its actual installed path to run the complete non-inference setup/runtime path.
- [ ] Verify Claude and Gemini installation, canonical skill discovery, and installed runtime accessibility with the same contract.
- [ ] Verify absent credentials, identity ambiguity, no calls before exact consent, history-preserving upgrades, and collector-versus-analysis reporting.
- [ ] Run full `node --test`, typecheck, runtime dependency check, bundle build, isolated host discovery, clean runtime checks, and diff checks.
- [ ] Save concrete evidence and any supported-platform limits. Commit completed implementation and verification records.

## Execution

User approved the written spec and requested implementation. Execute the tasks continuously in an isolated workspace, preserving the original checkout and its unrelated review document. A final review covers the whole diff and concrete verification evidence. Publishing packages, pushing, or merging to the shared branch remain separate from local implementation.
