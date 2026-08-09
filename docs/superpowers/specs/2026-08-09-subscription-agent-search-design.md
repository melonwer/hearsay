# Subscription Agent Search — Design Specification

Date: 2026-08-09  
Status: approved design, pending written-spec review  
Scope: local Codex and Claude Code subscription runs alongside existing provider API runs

## 1. Goal

Allow a Hearsay user to measure AI visibility through the locally installed, already-authenticated Codex and Claude Code CLIs, in addition to the existing provider API measurements.

The feature supports both on-demand and scheduled runs. Hearsay remains local-first: the computer running Hearsay must be online for a scheduled subscription run. A VPS is an optional deployment target and works when its CLI installations are separately authenticated.

Subscription results are sibling measurements to API results. They are never silently blended into one visibility score because the surfaces, agent context, web tooling, and authentication/usage model differ.

## 2. Scope and non-goals

### In scope

- Codex CLI execution through `codex exec`.
- Claude Code execution through `claude -p`.
- Explicit web-search-required prompt profiles.
- Tracking runs using approved intents and paraphrases.
- Exploration runs using one-off or suggested buyer-angle questions.
- On-demand and local-time scheduled execution.
- Raw final answers, search evidence, citations, and normalized analysis.
- Clear surface-specific status, usage, and failure reporting.

### Out of scope for this feature

- Using subscription credentials through an API.
- Copying, exporting, or managing CLI authentication tokens.
- A remote runner service or hosted subscription proxy.
- A single blended score across API, Codex, and Claude results.
- Claims about why a company appeared beyond observable answer and citation evidence.

## 3. User-facing model

Hearsay exposes two prompt lanes:

1. **Tracking** — a stable, approved intent/paraphrase panel used for scheduled runs, trend comparisons, and alerts.
2. **Exploration** — a one-off or automatically suggested question whose result is discovery evidence. An exploration question becomes part of tracking only after the user promotes it into the approved panel.

A run can target one or more configured surfaces. Each target produces its own result and status. If one target fails, other targets continue and the logical run is marked partial rather than losing successful observations.

## 4. Architecture and data flow

```text
manual request or scheduler
        ↓
Hearsay run coordinator
        ↓
preflight: executable, login, web profile, limits
        ↓
API / Codex CLI / Claude CLI adapter
        ↓
final answer + event stream + search/citation evidence
        ↓
normalized response record
        ↓
existing mention, citation, alert, and reporting pipeline
```

### 4.1 Runner boundary

The coordinator uses a common runner contract with capability discovery, preflight, execution, cancellation, and normalized results. Existing API adapters continue to use the contract. New adapters are:

- `CodexCliRunner`, invoking `codex exec` in a non-interactive web-enabled profile.
- `ClaudeCliRunner`, invoking `claude -p` in a non-interactive web-enabled profile.

The contract returns the final text, structured evidence, usage information when exposed, provider/model metadata, process status, and safe error details. A future local worker daemon can implement the same contract without changing tracking or analysis.

### 4.2 Safe process invocation

The adapters spawn the executable directly with an argument array and shell execution disabled. Each invocation uses an isolated, empty working directory under Hearsay's configured data area. The working directory contains no project source, credentials, or user files.

The adapter selects the provider-supported read-only/non-interactive profile and allows only the web/search capabilities needed for the measurement. Coding, shell, file-write, and unrelated MCP tools are disabled where the CLI supports tool controls. If a safe profile cannot be expressed, preflight fails instead of falling back to an unrestricted agent.

Each process has a timeout, output limit, cancellation path, and bounded concurrency. The process tree is terminated on cancellation or timeout. Hearsay records the CLI version and execution profile but never reads or stores the CLI's authentication tokens.

### 4.3 Mandatory web-search prompt contract

Every subscription measurement uses a web-enabled runner profile and a prompt envelope that explicitly requires web search before answering. The tracking version is deterministic apart from the approved question text.

The semantic contract is:

> You must use web search before answering this question. Do not answer from model memory alone. Search the open web for information relevant to the question, use those results in your answer, and include source links or citations when available. Treat the question as an ordinary prospective buyer question. Do not use local project files, coding tools, shell commands, or prior agent context beyond the supplied question, and do not mention this measurement instruction.

The adapter also requests the provider's structured event output when available. A subscription tracking result is considered web-verified only when the adapter observes a web-search event or an equivalent provider-confirmed search record. A final answer containing an unverified URL is not treated as proof that web search occurred.

If the CLI cannot expose or perform web search, the run receives a clear `web_search_unavailable` or `web_search_unverified` status and is excluded from comparable tracking metrics. The raw answer remains available as non-comparable evidence when it was produced.

### 4.4 Capture and normalization

The adapter captures separately:

- Final answer text.
- Structured JSONL/tool events where available.
- Search queries, result URLs, titles, and timestamps where exposed.
- Citations and source domains.
- Standard error output.
- Exit code, timeout, cancellation, and usage fields.

Small normalized evidence is stored with the response. The raw event stream and process diagnostics are stored as a run artifact under Hearsay's data directory. Obvious secrets are redacted before persistence; authentication material is never intentionally captured.

The normalized response includes at least:

```text
surface: provider-api | codex-subscription | claude-subscription
lane: tracking | exploration
prompt_id / prompt_text
model / cli_version / execution_profile
web_required: true | false
web_status: verified | unavailable | unverified | not_applicable
final_text
searches[]
citations[]
usage: known | quota_only | unknown
status: completed | failed | cancelled | non_comparable
```

## 5. Storage and analysis

The existing `runs.trigger` field continues to describe how a logical run started (`cron`, `manual`, `api`, or `seed`). The schema migration adds runner/lane/web metadata to response-level records so one panel run can contain API, Codex, and Claude observations without overloading the existing provider field. Raw event artifacts are referenced by response/run metadata rather than placed in the normal answer text.

The migration also expands logical run status to support `running`, `done`, `partial`, `failed`, `cancelled`, and `missed`. Individual response targets retain their own completion, failure, cancellation, and web-verification state so a partial run remains inspectable.

The existing response analysis remains reusable:

- Entity mentions and recommendation order are extracted from final answers.
- Citation domains are matched against tracked entities.
- Search and citation frequency are reported as observed evidence.
- Features and decision criteria mentioned in answers can be summarized as associated signals.
- Alerts and trends are grouped by surface, model/profile, and prompt lane.

API, Codex, and Claude results receive separate aggregates and dashboard filters. Exploration results do not contribute to scheduled trends or alerts until promoted to tracking. No analysis may phrase an observed correlation as a proven causal explanation.

Subscription cost is reported as `unknown` or quota/usage-based unless the CLI explicitly provides usable usage information. Hearsay does not estimate a dollar cost for a subscription run.

## 6. Run lifecycle

### On-demand

1. The user chooses a lane, prompt set, and one or more configured surfaces.
2. Hearsay creates a run and performs preflight checks.
3. Each target is queued with bounded concurrency.
4. Results and raw evidence are persisted as they complete.
5. The run becomes `done`, `partial`, `failed`, or `cancelled` and can be polled by its run ID.

### Scheduled

The local scheduler creates the same run type at the configured local time. The machine must be online and the CLI must still be installed and authenticated. A missing executable, unavailable login, unavailable web profile, timeout, or process failure becomes an explicit run/target failure with an actionable reason.

Subscription schedules do not silently replay stale prompts after downtime. A missed occurrence is recorded as missed, and the next configured occurrence proceeds normally; manual retry remains available. Existing API scheduling behavior is preserved unless the scheduler is generalized as part of implementation.

### Retry and partial failure

There is no unbounded automatic retry because subscription runs consume user quota and repeated searches can change the measurement. A bounded retry may be used for a process-start failure when explicitly configured, with every attempt recorded. A failure on one surface does not suppress successful results from other surfaces.

## 7. Deployment and security

The normal local Hearsay installation is the primary deployment. Users who deploy the complete application to a VPS must install and authenticate Codex and/or Claude Code on that VPS separately. Hearsay does not transfer a local login to the VPS.

The CLI runner inherits the operating-system account's permissions but is constrained to an empty working directory and the provider's safe tool profile. Logs, errors, and MCP responses must not expose tokens, environment secrets, or full authentication configuration.

## 8. Testing and acceptance criteria

The implementation is accepted when focused tests demonstrate:

- A fake executable can be invoked through each adapter without shell interpolation.
- Missing executable, missing login, unsupported web profile, timeout, cancellation, and non-zero exit produce stable error statuses.
- The generated prompt always contains the mandatory web-search instruction and remains stable for the same tracking prompt.
- A fake structured event stream yields normalized searches and citations.
- A run with no observed web search is excluded from comparable tracking metrics.
- API, Codex, and Claude results remain separable in storage, analysis, and reporting.
- Exploration results do not create trends or alerts before promotion.
- Scheduled local-time runs record missed/offline conditions without silently replaying stale work.
- Raw evidence is retained without exposing authentication material.
- Existing API-run tests and seeded/demo behavior remain passing.

## 9. Implementation boundary

The first implementation plan should focus on runner contracts/adapters, prompt construction, response persistence, scheduler integration, and focused tests. UI presentation, MCP exposure, and VPS documentation should consume the same normalized run model rather than introduce separate execution paths.
