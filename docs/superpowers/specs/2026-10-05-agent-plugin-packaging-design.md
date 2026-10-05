# Hearsay agent plugin packaging and onboarding

Status: design approved for implementation on 2026-10-05. Codex is the first complete host implementation. Claude Code and Gemini CLI use the same shared design and follow after the Codex flow is verified.

## Problem

Hearsay currently distributes a portable skill, Codex and Claude Code plugin manifests, and a Gemini CLI extension. Those packages contain the skill resources, schemas, and templates, but not the Hearsay runtime that performs repeatable collection, scheduling, and report generation. A user who installs a package still needs to understand the repository, configure providers, and connect a runtime before the full workflow is available.

The primary experience should begin with an agent conversation. A founder installs Hearsay, says what they want to study, and receives a guided setup. The agent should use context it can verify, ask only questions that affect the study, and stop for decisions that involve credentials, spending, recurring work, page changes, or publication.

## Goals

- Ship one complete Hearsay distribution with small host-specific wrappers for Codex, Claude Code, and Gemini CLI.
- Make the first useful action possible without reading the README or editing configuration files by hand.
- Let the host agent infer a product profile from a supplied URL, repository, current session, or existing Hearsay workspace, then show the evidence and request correction when needed.
- Detect provider CLIs, runtime capabilities, and credential availability without exposing secrets or treating presence as successful authentication.
- Keep the current founder-controlled study workflow: proposed questions and defaults, one exact approval, bounded collection, evidence-linked reports, and explicit approval for content changes and publication.
- Preserve study history in `.hearsay/<app-id>/` outside the plugin installation so upgrades do not remove records.
- Support on-demand collection and recurring collection. Keep collection and agent analysis as separate states.
- Keep the dashboard optional. Normal plugin operation must not require an HTTP server or a fixed port.

## Non-goals

- Creating provider accounts, obtaining missing API keys, or bypassing browser-based CLI authentication.
- Silently enabling paid providers, raising credit limits, installing recurring jobs, publishing content, or sending external messages.
- Replacing the existing evidence contracts, measurement routes, or dashboard APIs with a second incompatible data model.
- Claiming that a plugin installation provides a hosted Hearsay service.
- Adding a model tournament or enabling unapproved provider routes.

## User flow

### Install and inspect

The host installs the package from its plugin or extension mechanism. Installation copies the skill, runtime, schemas, templates, and host manifest. It does not create a database, write credentials, start a daemon, or enable a schedule.

On the first Hearsay request, the skill invokes a setup inspection command. The inspection reports:

- host and plugin version;
- Node availability and whether it meets the runtime requirement of Node 22.13 or newer;
- filesystem and web access available to the host;
- the current workspace and existing `.hearsay/<app-id>/` records;
- installed Codex, Claude Code, Gemini CLI, or other supported routes, including executable path and reported version;
- authentication status returned by each selected CLI, without claiming that an untested credential works;
- Tavily key presence and usage availability, without printing or copying the key;
- available scheduler mechanisms.

If Node is missing, the skill remains usable for host research and exportable reports. It describes the runtime-dependent features that cannot run and does not pretend that collection or scheduling is available.

### Infer the product profile

The agent reads the supplied public site or repository and saves its sources as discovery evidence. It may use product details already present in the current session or an existing project record, but it shows the inferred identity before reusing it. The confirmation includes the product name, canonical URL, audience, jobs, geography, and any stated outcome.

The agent asks a question only when the answer can change the buyer panel, comparison, provider choice, budget, or outcome interpretation. It must resolve an ambiguous app identity before saving research under a stable app ID. Unknown values remain unknown instead of becoming guessed facts.

### Configure providers and routes

The agent presents detected routes as explicit options. It can select host research by default. It can recommend Tavily, Codex, Claude Code, Gemini CLI, or configured API routes only when the route is available and supported by the current implementation. Each selected route shows its own execution profile and usage estimate.

For Tavily, the agent checks a host-managed key or credential reference and account usage through the runtime. If the key is missing, the agent gives the founder the provider setup action and resumes inspection after the founder completes it. The key never enters a plan, report, capture, export, log, or isolated model environment. A local counter does not guarantee that a provider account will not bill; strict free use requires a provider-side limit as well.

For a CLI that is not authenticated, the agent reports the exact interactive login action and waits for the founder to complete it. It then runs the safe status probe again. It may not send credentials as prompts or infer authentication from an executable path.

### Propose and approve the study

The agent proposes:

- three initial buyer angles with two neutral phrasings each, or a documented alternative based on the product evidence;
- a stable question panel and selected routes;
- the page or repository version to observe and any unchanged comparison page or cohort;
- Tavily depth, query count, diagnostic allowance, and account usage estimate;
- sample count, execution limits, study duration, first review, recurring cadence, and stop rules;
- the business outcome definition and evidence design, if the founder has outcome data;
- whether the first action is a research audit, an approved baseline, or a later repeat.

The runtime creates an immutable preview containing the exact questions, routes, executable identities, limits, price or usage-table revision, schedule inputs, and consent version. The agent presents the preview and its confirmation hash. No provider request, recurring task, or cron edit occurs until the founder approves that exact scope.

Changing providers, questions, limits, schedule inputs, or publication scope requires a new preview and approval. An existing approval never grants a new provider or a higher ceiling.

### Run, review, and resume

After approval, the runtime captures version 1, runs the approved baseline, preserves raw receipts, and writes the report. The agent analyzes the completed occurrence and saves a review with evidence IDs, a recommendation, and a next action. It may recommend continued observation when a change is not justified.

The agent can propose a focused page change with a hypothesis, evidence, draft, effort, and repeat plan. The founder separately approves drafting, applying to a named repository, and publishing to a named destination. A publication creates a new page version; it never overwrites the baseline.

When Hearsay resumes, the agent reads the approved plan, latest review, pending decisions, and linked evidence first. Older captures are loaded only when needed to inspect a claim.

## Runtime and package architecture

The repository remains the source of truth for the skill and runtime. `scripts/build-bundles.js` generates four distributions from that source:

```text
dist/
  portable/hearsay/
  codex/hearsay/
  claude/hearsay/
  gemini/hearsay/
```

Each distribution contains the canonical skill resources and a `runtime/` tree with the executable entry point, core modules, schemas, and host-neutral setup helpers. Codex and Claude packages also contain their plugin manifests. The Gemini package contains its extension manifest. No distribution contains project data, database files, API keys, CLI credentials, or machine-specific logs.

The runtime exposes a local command surface for inspection, setup, collection, reports, comparison, and scheduling. The implementation should extend the existing `bin/hearsay.js` and study commands instead of creating a second executable. JSON output is the machine interface; Markdown remains the owner-facing report format.

The first host integration uses a direct local transport from the host agent to the runtime. It does not require an HTTP server, MCP registration, or a fixed port. The existing MCP server remains an optional dashboard integration. If a richer tool transport is needed later, it must call the same core modules rather than duplicate business logic.

The runtime keeps boundary validation in the setup and command adapters. Study contracts, report derivation, credit accounting, and schedule decisions remain in pure or storage-focused core modules. Host wrappers only translate the host invocation into those interfaces.

## Scheduling

The agent asks whether the founder wants manual collection, a recurring task, or no collection yet. It proposes a local time and timezone from the host, but the founder approves the exact schedule and target ceiling.

The preferred recurring path is a native agent task with the saved repeat instruction. That task runs the collector, reads the new receipts, saves the analysis, and returns an owner report. The runtime records the task ID, scheduler kind, command, verification time, and study contract.

The runtime scheduler can invoke a bounded collector tick when a native agent task is unavailable. A collector tick gathers due evidence and marks analysis as due. It cannot claim that an AI agent reviewed the occurrence. The next agent session sees the pending analysis task.

Cron is an explicit fallback on systems that support it. Hearsay previews the exact cron command, preserves unrelated entries, backs up the existing crontab before editing, and requires a separate founder approval. Missed occurrences remain missed and never trigger spending catch-up. Authentication, quota, route drift, executable changes, or contract drift stop the schedule before provider work.

The local machine or authorized runner must be online for local subscription measurements. A later control-plane and local-runner split is outside this delivery.

## Data ownership and security

`.hearsay/<app-id>/` is the durable project boundary. Existing project and evidence records remain readable. Study contracts, page captures, occurrence records, analyses, decisions, outcomes, and reports append history and carry schema versions. Atomic writes and per-study locks prevent overlapping occurrences. The account-level Tavily ledger remains separate so multiple projects cannot each spend the same allowance.

Secrets stay in host-managed environment variables or credential stores. Setup output, logs, report files, archives, isolated prompts, and exported evidence redact them. The agent can detect a secret reference and can write non-secret configuration, but it cannot retrieve a missing secret or copy one from chat into a durable file.

Fetched content and provider answers are evidence, not instructions. The runtime strips credentials from captured events and keeps product context out of independent recommendation sessions. External delivery destinations are separate configuration and require separate authorization.

## Host rollout

Codex is the first complete implementation because the repository already verifies the Codex plugin shape and the local runtime can be exercised through a clean isolated host. Claude Code and Gemini CLI then consume the same setup contract, runtime archive, and verification scenarios through their host-specific manifests.

The host adapters must not change study semantics. They provide installation metadata, invoke the shared setup and runtime commands, and report host-specific capability or authentication failures in the common status shape.

## Verification requirements

The implementation is ready for release only when a clean-host test proves all of the following:

1. A user can install the Codex package and reach a saved inferred profile and study preview without opening the README or editing a file.
2. Existing URL, repository, and `.hearsay` context reduces questions while ambiguous identity still requires confirmation.
3. Missing Tavily keys and unauthenticated CLIs stop at a specific founder action and resume after the action succeeds.
4. No provider call occurs before approval of the exact preview hash.
5. No secret appears in a study file, log, report, export, archive, or isolated prompt.
6. A schedule preview shows questions, routes, limits, timezone, command, and collector-versus-analysis behavior before installation.
7. Cron edits preserve unrelated entries and create a recoverable backup. A schedule never replays missed paid occurrences.
8. A runtime-only collector marks analysis due, while a connected agent task saves the analysis and owner report.
9. Claude Code and Gemini CLI install and discovery tests use the same skill resources and report host-specific limitations without changing the core contract.
10. Reinstalling or upgrading the plugin leaves `.hearsay/<app-id>/` and its raw captures intact.

The implementation plan should turn these requirements into focused tasks, beginning with the setup contract and Codex clean-host path.
