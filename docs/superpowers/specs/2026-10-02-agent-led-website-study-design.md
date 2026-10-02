# Agent-led website studies

Status: approved for implementation on 2026-10-02. Delivery and verification are tracked in `../plans/2026-10-02-agent-led-website-studies.md`.

Source reviewed: Hearsay `390a76f`. GitHub `main` was checked directly and points to the same product revision. The existing question, exploration, provider, and repeat workflows are pushed. This document describes their proposed extension.

## Intended experience

A founder gives their existing AI assistant a website and a goal. The assistant investigates the product, proposes useful buyer angles, chooses sensible study settings, and presents one plan to approve. The founder can accept that plan or change any setting. After approval, the assistant collects evidence, maintains the study history, proposes a focused page change, and reviews subsequent observations.

The founder directs the work and approves changes. The agent supplies the research, proposed defaults, analysis, drafts, and routine operation. Configuration is available when wanted; completing a configuration form is not the primary experience.

The confirmed business goal is evidence about leads or sales. The founder previously chose a changed page compared with an unchanged page as the preferred evidence approach. AI search and recommendation observations support investigation. Business-result comparisons need actual outcome observations and a defined comparison method.

## What exists and what changes

| Area | Current implementation | Proposed extension |
| --- | --- | --- |
| Buyer questions | Dashboard groups intents and paraphrases; exploration questions can be reviewed and promoted. | The lead agent derives product-specific angles and stores their relationship to the frozen tracking questions. |
| Standalone panel | Six neutral questions, stored as question IDs and wording. | An editable angle map groups those questions without discarding existing panel revisions. |
| Model trials | Selected API or account routes retain answers and search evidence. | The agent recommends available routes within the approved usage scope, with each route reported separately. |
| Repeats | Daily runs repeat approved settings. | A study connects collection with an explicit assistant analysis step and owner-facing report. |
| Page history | Reviewed page excerpts and shipped-change records exist in the optional dashboard. | Standalone studies retain complete page captures, page revisions, change proposals, and approval records. |
| Search provider | Current host web tools and selected model search routes. | Optional Tavily source checks with explicit monthly credit accounting. |
| Business review | Dashboard records manual or CSV outcomes beside a native measurement series. | A standalone study can link outcome observations to its pages, change, comparison, and review window. |

Production dashboard question suggestions currently use a generic five-intent starter. The host agent can already draft better questions, but product-specific angle selection is not an autonomous built-in daily loop. Existing schedules do not rotate questions, select models, or generate new improvement advice.

## Approach

Use a standalone study record operated by the current host agent, with optional runtime helpers for repeatable collection and validation. Reuse the existing immutable question panels and captured measurement runs. Keep the dashboard an optional reader and importer.

Two alternatives were considered. Extending only the dashboard would make the primary experience depend on a server. Putting all persistent state in the agent conversation would make restart, audit, comparison, and controlled spending unreliable. The saved study gives the agent durable context while preserving the existing portable entry point.

## The study workflow

### 1. Propose the plan

The lead agent inspects the website, identifies the audience and buyer jobs, and proposes:

- The target page and a suitable unchanged comparison page, if available.
- The business outcome to observe and where those observations come from.
- Buyer angles and exact neutral question phrasings.
- Available measurement routes, sample counts, and separate usage estimates.
- Collection cadence, first review, maximum study duration, and stop rules.
- Tavily settings and a monthly credit allowance when Tavily is selected.
- The scope of permitted actions and the report destination.

The owner sees a short recommendation with expandable detail, then approves or edits it. One approved study contract authorizes the specified recurring collection within its limits. Changes to providers, spending, published content, or the stable question panel need a new applicable approval. Exploration already covered by the approved research allowance can continue without interrupting the founder.

The approved snapshot binds the exact panel, execution settings, provider identities, and recurring schedule inputs. That owner decision authorizes creating the existing on-demand and recurring consent receipts for those scopes. Save each resulting quote ID with its study approval reference and verify that the current preview still matches the approved scope. Existing account scheduling remains disabled until a successful search-verified baseline trial has completed for every selected route under the current run quote. Failed trials retain evidence without enabling that route's schedule. Changed scope requires a new owner review; satisfying the existing scheduling prerequisite does not require another decision about unchanged scope.

Proposed starting defaults are three angles with two phrasings each, one daily basic Tavily query per phrasing, a first review after one day, weekly review thereafter, and a 30-day maximum. The agent can recommend different settings and explain why. These defaults become operational only when the owner approves the actual plan.

A one-day review can support a factual improvement proposal. Readiness to propose a change and readiness to judge its business effect are separate decisions. The latter depends on exposure, traffic, observed outcomes, and the approved evidence rule.

### 2. Capture version 1 and its baseline

Save the public page response or rendered capture available to the host, extracted content, capture method, requested and final URLs, timestamps, and hashes. Keep original captures alongside derived content. Dynamic content normalization has its own revision and never overwrites the source capture.

Collect the frozen neutral questions using the selected routes. Store planned, attempted, completed, failed, partial, and eligible observations separately. Preserve exact wording, answers, available model identity, queries, source results, citations, and source-version evidence.

Discovery and the lead agent have product context. Independent recommendation trials use fresh sessions that receive only a neutral question and the existing search envelope. The lead agent's product memory, page history, and earlier answers never enter that independent trial. If the host cannot provide isolation, deliver a research audit with no independent recommendation-rate claim.

### 3. Choose and approve a change

The agent reviews the baseline and proposes one focused change with supporting receipt IDs, a hypothesis, expected outcome, effort, draft, and repeat plan. It can explain why no change is currently justified.

The owner can approve, reject, or revise the proposal. An approval specifies whether the agent may draft, apply to a named repository, or publish to a named target. The agent can execute the approved scope immediately. Publishing requires that scope to include the actual target; a study-collection approval does not grant publication permission.

Record the original source revision or patch basis, the approved change, its execution result, and publication time. Capture version 2 after it is available. An unexpected external page change creates a pending revision for review instead of silently rewriting the baseline.

### 4. Collect and analyze automatically

Repeat the stable questions and selected routes under the approved schedule. Explore promising new angles separately. Promoting an exploratory question creates a new reviewed panel revision; it does not rewrite a comparison already underway.

The host's native automation should run the lead agent with the saved study and a fixed repeat instruction. Optional runtime scheduling collects receipts and marks analysis due. A collector alone cannot claim to have completed the assistant review. When no persistent agent automation is available, retain the collected evidence and expose the analysis task for the next agent session.

Every completed review saves a concise owner report, supporting evidence IDs, the agent's recommendation, and its reason. The report includes a next action or an explained decision to continue observing. Default delivery is a local report or the host's own task result. External messaging needs a separately selected destination and authorization.

### 5. Review the result and decide the next cycle

The review answers which angles find the website, which routes recommend it, what evidence changed, what business results were observed, and what remains uncertain. Search presence, model recommendations, and business conversions retain separate denominators.

The owner decides whether to keep, revise, or revert the change and whether another cycle is worthwhile. Earlier versions, captures, hypotheses, and decisions remain readable. A reversion is a new action and version, preserving the intervening history.

The agent may recommend extending an inconclusive study. It cannot extend usage past the approved duration or allowance without an updated contract.

## Buyer angles and comparable questions

For the user-supplied Drip Score example, provisional angles could include outfit scoring, feedback on an outfit photo, and advice on improving an outfit. The agent must inspect the actual product before treating these as confirmed buyer jobs.

Example neutral questions include "Which apps can rate an outfit from a photo?" and "Where can I get feedback on how good my clothes look?" A brand-specific search for Drip Score is useful as a diagnostic, but it does not measure whether a neutral buyer question discovers the product.

Each angle has a stable ID, label, buyer job, rationale, evidence references, and question references. Paraphrases stay associated with their angle. Report differences between angles separately from variation between phrasings and repeated answers. The agent must not select only successful angles retrospectively and present them as the original baseline.

Multiple existing routes can be recommended. The approved set remains explicit. Current account routes are Codex, Claude Code, and Antigravity; API routes use their configured models. This design does not add an arbitrary model tournament or silently enable additional accounts.

## Tavily search

Tavily is the intended service behind the user's "Tably" wording. Its official documentation was checked on 2026-10-02 and retained in the local audit source folder.

The documented free plan supplies 1,000 API credits each month without a credit card. Basic search costs one credit per request; advanced search costs two. This is a credit allowance shared with other usage on the account, not an unlimited free analytics service.

The initial adapter uses `POST https://api.tavily.com/search` with explicit `search_depth: "basic"`, `auto_parameters: false`, `include_answer: false`, `include_usage: true`, a bounded `max_results`, and the reviewed query. Store the provider request ID, exposed credit usage, raw response, and derived result records. Tavily's returned sources and relevance scores are search observations. They are not model endorsements or Google rankings.

Read account and key usage through `GET https://api.tavily.com/usage` before scheduled collection. Combine reported remaining capacity with the study allowance and reservations for other Hearsay studies. Unknown capacity pauses scheduled Tavily requests while preserving existing reports. Authentication, quota, and policy changes also stop further collection until resolved.

Propose a 200-credit study allowance for the six-query daily example: 180 requests across 30 collection occurrences and up to 20 separately recorded discovery or freshness diagnostics. The initial six-query baseline is the first of those 30 occurrences, followed by at most 29 daily repeats. It is not an additional collection outside that allowance. An extra baseline, retry, or repeat needs capacity in a newly calculated allowance. Account usage outside Hearsay still matters. Changes to depth, query count, sampling, or diagnostic allowance require a new estimate when they exceed the approved scope.

Reserve credits before sending requests. An ambiguous timeout remains conservatively charged to the local allowance until reconciled; do not retry in a way that can spend twice without another reservation. Separate study files and account-level credit coordination prevent different apps from independently assuming they each own the same free allowance.

The application cap bounds Hearsay's requests. The provider account or key limit must also prevent unwanted paid overage for a strict free mode. Do not promise a zero bill based solely on a stale usage response or local counter. No paid fallback is automatic.

Keep `TAVILY_API_KEY` in host-managed credentials or the runtime environment. Exclude it from saved studies, captures, reports, bundles, logs, and isolated model environments. A missing key leaves the current host's research path available. It does not authorize substituting a paid search provider.

Tavily is optional retrieval support. Selected model routes retain their existing independent search behavior and their own usage. Reusing Tavily sources in a contextual assistant report does not turn that report into a measurement of how a consumer AI app independently finds the site.

## Page exposure and indexing

Track publication and observed source exposure separately. For each answer or source result, record the page revision active at observation time and any revision actually supported by the captured content. A matching URL or final citation alone does not establish which page text was read.

The exposure record distinguishes a directly fetched current page, a returned source snippet matching version 1 or version 2, a URL-only result, and unknown content. Preserve the supporting capture or excerpt. A new timestamp, snippet, or citation does not automatically establish Google indexing.

Google states that recrawling can take a few days to a few weeks and that requesting a crawl does not guarantee immediate inclusion. Its URL Inspection tool or API can supply Google-specific information when the owner has access. Adding Search Console authentication is outside this initial delivery. Existing owner-supplied inspection evidence can be retained with its provenance.

Reports can say that version 2 is published, its exposure is unconfirmed, or new text was observed in a particular provider result. They must not declare the update ineffective just because search-backed agents still encounter old or unknown content. The first review remains useful even when exposure is pending.

## Business-result comparison

A study can review reported outcomes without a native AI measurement series. Link each observation to its source, page, time window, metric definition, and study. Link the planned comparison to a specific page change and unchanged reference page or cohort.

Retain numerator and denominator when supplied, such as qualified leads and eligible visits, alongside attribution method and known traffic differences. Missing denominators remain unavailable. Keep sales counts, revenue, currencies, time, and costs separate.

The report labels the evidence design as before-and-after, an observational comparison with an unchanged reference, or a documented controlled allocation. Different pages can receive different audiences. An unchanged page by itself does not establish causation. A randomized experiment requires an actual assignment mechanism; this delivery does not pretend that one exists.

The agent proposes the outcome definition, evidence threshold, loss limit, review period, and stop rules. The owner approves them as part of the study contract. A low-sample or poorly matched comparison can yield an inconclusive review. Better AI mentions are never converted into estimated leads or sales.

The initial data input supports owner-supplied records and CSV, reusing current outcome normalization where possible. Direct CRM and analytics OAuth integrations are outside the first delivery. Missing outcome data permits visibility research but prevents a claimed business-result conclusion.

## Saved structure and ownership

Keep the existing `project.json`, panel revisions, and `runs/<run-id>/` evidence intact. Add a separately versioned study contract and records rather than inserting unsupported fields into the version-one measurement schemas.

```text
.hearsay/<app-id>/
  project.json
  runs/<run-id>/evidence.json
  runs/<run-id>/captures/
  studies/<study-id>/study.json
  studies/<study-id>/plans/<revision>.json
  studies/<study-id>/angles/<revision>.json
  studies/<study-id>/pages/<capture-id>/receipt.json
  studies/<study-id>/pages/<capture-id>/original.html
  studies/<study-id>/pages/<capture-id>/content.txt
  studies/<study-id>/versions/<version-id>.json
  studies/<study-id>/search-runs/<run-id>/evidence.json
  studies/<study-id>/changes/<change-id>/proposal.json
  studies/<study-id>/changes/<change-id>/draft.patch
  studies/<study-id>/events/<event-id>.json
  studies/<study-id>/outcomes/<observation-id>.json
  studies/<study-id>/reviews/<review-id>/report.json
  studies/<study-id>/reviews/<review-id>/report.md
```

Capture formats reflect the actual method; a rendered capture can use its documented format instead of pretending to be an original HTTP response. All records carry a schema version and stable identity. IDs resolve within the same app and study. Snapshots and event records are immutable. The current study manifest contains pointers and derived state, not overwritten historical evidence.

One runtime service owns manifest updates for a study. Measurement workers write separate run records. Agent actions use that service when available; portable hosts can write the equivalent schema-valid records directly and retain verification notes. Locks and atomic writes prevent overlapping scheduled occurrences. The account-level Tavily credit ledger is separate from per-app study histories.

An agent resuming the study reads the current plan, latest review, pending owner decision, and linked evidence. It can open older versions and reviews when needed without loading every raw capture into the conversation.

## Module and interface sketch

The implementation should keep network operations, saved records, and report derivation distinct. Proposed modules are:

| Module | Responsibility |
| --- | --- |
| `core/study-contract.js` | Parse study plans, angle maps, version links, decisions, outcome links, and search records at boundaries. |
| `core/study-workspace.js` | Read and append study records, capture revisions, resolve links, and derive resumable state. Reuse existing atomic workspace helpers. |
| `core/tavily-search.js` | Fetch and validate Tavily usage and search responses, reserve credits, preserve redacted receipts, and enforce the selected request profile. |
| `core/study-report.js` | Derive angle-level summaries, exposure state, business comparisons, and report sections from saved observations. No inference or network calls. |
| `core/study-schedule.js` | Coordinate approved collection occurrences and persist analysis-due state, reusing existing scheduling invariants. |
| `bin/hearsay.js` | Expose study preview, approval, collection, inspection, outcome import, and report commands. |
| `skill/references/studies.md` | Tell the host agent how to propose defaults, operate an approved study, analyze evidence, propose changes, and resume. |

Key operations accept an explicit study directory or validated study snapshot: `previewStudy`, `approveStudy`, `captureStudyPage`, `recordStudyVersion`, `collectStudyOccurrence`, `recordStudyAnalysis`, `recordStudyDecision`, and `deriveStudyReport`. Each write returns saved receipt IDs. Collection never embeds a lead agent's brand context in independent trial prompts. Report derivation does not call providers.

Optional dashboard import reads these study records with their external provenance. It does not promote them into native measurement series. Existing version-one exports and reports remain readable.

## README and entry prompt

Proposed introduction to ship with the implemented workflow:

> A free AI visibility checker, run by the agent you already use.
>
> Give Hearsay your website. Your agent proposes buyer angles, saves a baseline, suggests a page change, and follows the results. Approve its plan or adjust the questions, schedule, and limits yourself.
>
> Optional Tavily search can use its 1,000 free monthly credits. Six basic searches a day use 180 credits over 30 days. Your AI assistant's usage follows its own plan. Hearsay reports selected search and AI-agent observations; lead or sales comparisons use the business records you supply.

The primary setup example becomes an assistant prompt that installs the skill, researches the supplied website, proposes a study and monthly usage allowance, and presents the actual plan before enabling collection. Keep detailed host installation instructions available below it. Do not advertise Tavily or automated study behavior as shipped until verification passes.

## Verification and delivery scope

Implement and verify in usable increments: saved study and page history; Tavily collection and budgeting; agent analysis and scheduled repeats; linked outcome comparison and optional dashboard reading. Update the primary skill, host bundles, and README with the behavior that is actually delivered.

Required behavior checks include:

1. A website input produces an editable proposed plan with product-specific angles and one owner decision before recurring collection.
2. Old page captures, runs, and decisions remain readable after a new page version, review, or reversion.
3. An independent trial receives only its neutral question and execution envelope. Diagnostic or contextual results cannot enter its recommendation denominator.
4. Tavily uses the approved depth, query count, and credit scope. The baseline plus repeats consumes at most the approved 30 six-query occurrences, with diagnostics accounted separately. Exhausted or unknown capacity cannot trigger unapproved requests. Duplicate ticks and ambiguous retries cannot spend without distinct approved reservations. Account scheduling preserves its distinct consent receipts and successful-trial prerequisite while requiring one owner decision for unchanged approved scope.
5. A page publication or URL-only citation cannot falsely mark version 2 as encountered or Google-indexed.
6. A repeated study either records an assistant analysis receipt or explicitly shows that analysis remains due. It does not silently present an empty shortlist as a completed review.
7. Standalone outcome records can be reviewed with their study without creating a native measurement series. Missing data, unmatched pages, or insufficient traffic cannot produce a claimed sales improvement.
8. The report distinguishes configured scheduling from connected scheduling, last successful collection, analysis status, missed occurrences, and stopped collection.
9. Built host packages discover the updated skill and exclude keys, page captures, histories, and user data.
10. The README's free allowance example matches the implemented request profile and current cited provider pricing.

Use offline provider fixtures and host-discovery checks for development. A live Tavily check needs the selected key and approved credit scope. No paid model calls, live page changes, or recurring jobs are authorized by writing this design.

## Sources

- [Tavily credits and pricing](https://docs.tavily.com/documentation/api-credits), checked 2026-10-02.
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search), checked 2026-10-02.
- [Tavily usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage), checked 2026-10-02.
- [Google's recrawl guidance](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl), checked 2026-10-02.
- Existing Hearsay source: `core/benchmark-draft.js`, `core/suggest.js`, `core/research-workspace.js`, `core/research-schedule.js`, `core/research-report.js`, `core/follow-up.js`, `core/outcomes.js`, and `core/weekly-review.js`.
- Local source captures and prior audit evidence: `.audit/user-review-2026-10-02/`.
