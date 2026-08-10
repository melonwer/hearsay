# Subscription Agent Search Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute explicitly enabled Codex agent and Claude Code agent measurements through their authenticated local CLIs with mandatory web-search verification and safe, fixture-tested process boundaries.

**Architecture:** Provider-specific immutable profiles build exact argument arrays and versioned prompt envelopes. A shared bounded child-process runner owns allowlisted environments, isolated working directories, timeouts, cancellation, and redacted artifacts; Codex JSONL and Claude stream-JSON parsers normalize into the same evidence/result shape without mixing search-result URLs with final citations.

**Tech Stack:** Node.js 22.13+ built-ins only (`node:child_process`, `node:fs`, `node:crypto`, `node:os`, `node:stream`), ESM/JSDoc, `node:test`; no SDK or queue dependency.

## Global Constraints

- Codex profile uses `--search` before `exec`; Claude profile uses both `--tools WebSearch,WebFetch` and `--allowedTools WebSearch,WebFetch`.
- Prompts arrive over stdin, never as process arguments; shell execution is disabled.
- Preflight checks executable/version/capabilities/auth without a model request and fails closed as `unsupported_cli_version` when a safety flag is missing.
- Web search is verified only by a provider-confirmed completed search event; a URL in final text or a WebFetch event is insufficient.
- Subscription surfaces are disabled by default and require explicit per-surface opt-in; API-only behavior remains unchanged.
- All child output is byte/line/depth bounded and redacted before persistence.

---

### Task 1: Prompt envelopes and immutable profiles

**Files:**
- Create: `core/agent-profiles.js`
- Modify: `core/config.js`
- Test: `test/subscription-agent.test.js`

- [ ] Write failing tests for the exact Codex/Claude argument arrays, mandatory-search prompt text, stdin-only question placement, deterministic envelope/profile hashes, and disabled-by-default config.
- [ ] Run the focused test and observe missing exports.
- [ ] Implement `buildMeasurementPrompt`, `codexArgs`, `claudeArgs`, `profileHash`, surface labels, capability requirements, and safe subscription config parsing.
- [ ] Run focused tests and `npm run typecheck`; commit `feat: define restricted subscription agent profiles`.

### Task 2: Fixture-driven event parsers

**Files:**
- Create: `core/agent-parsers.js`
- Create: `test/fixtures/codex-search.jsonl`
- Create: `test/fixtures/claude-search.jsonl`
- Create: `test/fixtures/claude-unverified.jsonl`
- Test: `test/subscription-agent.test.js`

- [ ] Write failing parser tests for final text, completed Codex search, Claude WebSearch/WebFetch pairing, usage, malformed lines, failed/denied searches, line-size/depth limits, and distinct search/fetch evidence.
- [ ] Run the focused test and observe missing parser exports.
- [ ] Implement bounded JSONL parsing and normalized `{text, searchEvents, citations, usage, webStatus, rawEvents}` output. Only a completed provider search event produces `verified`.
- [ ] Run parser tests, typecheck, and commit `feat: parse subscription agent evidence streams`.

### Task 3: Safe process and capability/auth probes

**Files:**
- Create: `core/agent-process.js`
- Modify: `core/agent-profiles.js`
- Test: `test/subscription-agent.test.js`

- [ ] Write failing tests with fake executables for direct spawn (`shell:false`), exact args, stdin prompt, environment allowlist, isolated mode-0700 cwd, output/idle/wall limits, malformed output, timeout, cancellation, nonzero exit, and process-start failure.
- [ ] Write failing capability tests where missing required help flags return `unsupported_cli_version` and auth probe output containing identity is not returned or persisted.
- [ ] Implement `spawnBounded`, process-group/tree termination, `discoverCli`, `preflightCli`, and stable safe error classes.
- [ ] Run focused tests on POSIX and keep Windows cancellation code path tested through injected `taskkill` invocation; typecheck and commit `feat: bound and preflight subscription cli processes`.

### Task 4: Codex and Claude runners

**Files:**
- Create: `core/agent-runners.js`
- Modify: `core/artifacts.js`
- Test: `test/subscription-agent.test.js`

- [ ] Write failing runner tests using the fake process harness and parser fixtures. Assert `discover`, `preflight`, `run`, `cancel`, profile metadata, comparison key, prompt snapshot/origin, artifact ref, normalized search events, and `web_status`.
- [ ] Implement `CodexCliRunner` and `ClaudeCliRunner` over the shared process boundary. Persist only redacted event artifacts and normalized evidence; discard auth probe output.
- [ ] Run focused runner tests and commit `feat: add Codex and Claude Code subscription runners`.

### Task 5: Surface registry and on-demand target integration

**Files:**
- Modify: `core/config.js`
- Modify: `core/runner.js`
- Modify: `web/pages/api.js`
- Modify: `web/data.js`
- Test: `test/subscription-agent.test.js`, `test/api.test.js`, `test/providers.test.js`

- [ ] Write failing tests for a subscription-only config, explicit opt-in, allowance preview, queued target insertion before process start, partial target completion, verified-search comparability, and demo-mode refusal.
- [ ] Extend the runner coordinator with a common target contract while preserving the existing API adapter path and output summary. API responses get the legacy API metadata; agent targets get snapshots/lane/profile/web/artifact metadata.
- [ ] Add a surface-aware preview/start endpoint contract without exposing credentials and keep subscription cost as unknown/included-plan/quota metadata rather than a dollar estimate.
- [ ] Run focused plus existing provider/API suites, typecheck, and commit `feat: run opted-in subscription agent targets`.

### Task 6: Adapter acceptance gate

- [ ] Run `node --test`, `npm run typecheck`, and `git diff --check`.
- [ ] Confirm no default config enables a CLI, no test launches a real provider executable, and every parser fixture demonstrates search verification semantics.
- [ ] Start the scheduling plan only after each adapter passes the one-target fake compatibility gate.
