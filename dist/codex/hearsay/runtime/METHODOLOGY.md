# Methodology

Hearsay is an open-source AI-search forensics and measurement workbench that links every rate to
stored answer receipts. This page explains what Hearsay measures, how its statistical intervals
and forensic analyzers work, and what the numbers cannot establish.

## What Hearsay measures

Hearsay asks reviewed buyer questions through separately labeled OpenAI, Anthropic,
Gemini, and Perplexity APIs, optional BYOK DataForSEO surfaces (`google-aio` and
`chatgpt-web`), or signed-in Codex, Claude Code, and Antigravity agents. It retains
the final answer and available evidence for each attempt. Exact-series reports count
comparable answers and link to their receipts. Failed or incomplete attempts remain
visible as collection gaps.

There is no machine-learned scoring layer between an answer and its metric. Mention
detection matches entity names and aliases. The deterministic stance classifier labels
positive, negative, neutral, uncertain, or absent statements with a rule and answer
span. A person can append a correction without changing the original answer or label.
Older heuristic recommendation values remain labeled as legacy data.

## Sampling and confidence intervals

A single AI answer is an anecdote, not a measurement. The same prompt, re-sent a minute later,
routinely produces a different brand list. So Hearsay asks each prompt several times per provider
per run and reports rates, not one-off observations.

Answer rates show a Wilson 95% interval and their sample size. The interval describes
sampling uncertainty for this configured panel and route; it does not represent the
answers seen by every buyer. Rates with fewer than five comparable answers are flagged
as low sample. Missing attempts never enter the denominator as brand absences.

## Phrasing variance vs rerun variance (why intents exist)

Rerunning the *same* prompt is only half the variance story. Published measurement work found that
**phrasing variance exceeds rerun variance: cross-paraphrase agreement (0.135–0.288) is far lower
than same-prompt rerun agreement (0.50–0.61)**
([arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)). In plain words: rewording the question
changes the answer far more than re-asking the same wording does. A tool that only reruns one
phrasing shows you the *smaller* error bar and hides the bigger one.

That is why Hearsay groups prompts into **intents**: one buying question ("best AI meeting-notes
tool") expressed as several paraphrases. For each intent it reports the pooled mention rate with
its Wilson interval, *and* splits the spread into two components:

- **Rerun spread** — variation across repeated samples of the same wording.
- **Phrasing spread** — variation across the paraphrase means.

Both spreads are reported when the panel has enough repeated phrasings to calculate
them. A single wording cannot establish phrasing variance.

## What each route can tell you

API measurements use provider endpoints, BYOK DataForSEO routes query live SERP and ChatGPT web
scrapers over explicit geolocation settings, and subscription measurements use the selected
signed-in agent CLI. Neither API nor subscription CLI routes reproduce a consumer app. For API runs:

- **No memory or personalisation.** Consumer apps adapt to each user's history; the API sees a fresh, anonymous caller every time.
- **No consumer-app system prompts or tools.** ChatGPT-the-app wraps the model in hidden instructions and tooling that the raw API does not replicate. Hearsay can explicitly enable the OpenAI Responses web-search tool, but that API route still does not reproduce the consumer app.
- **Explicit geography and language provenance.** By default, `location_control` is `uncontrolled`. When `HEARSAY_LOCATION_CODE`, `HEARSAY_LOCATION_COUNTRY`, `HEARSAY_LOCATION_CITY`, or `HEARSAY_LANGUAGE_CODE` are configured, Hearsay records deterministic `location_control` and `language_control` metadata in the execution profile so geo-controlled runs never silently mix with uncontrolled series.

Treat each exact route, search policy, model, geolocation profile, approved benchmark, and
analysis revision as its own directional series. Hearsay does not merge sibling routes into a
consumer app score. A changed prompt, alias, model, policy, or analysis revision starts a new
comparison context.

## Opt-in API web search and BYOK DataForSEO

OpenAI Responses web search supports `auto` and `required` on the validated
`gpt-5.6-luna` route (and optionally passes approximate `user_location` when
`HEARSAY_LOCATION_COUNTRY` or `HEARSAY_LOCATION_CITY` is set). Anthropic Messages basic
web search supports `auto` on the validated `claude-sonnet-5` route. Gemini
GenerateContent Google Search grounding supports `auto` on the validated
`gemini-3.6-flash` route, rendering required Search Suggestions in an isolated frame
and failing searched responses that omit them. Overriding these validated models on
web-search routes is rejected by default unless `HEARSAY_ALLOW_UNVERIFIED_MODELS=1` is
explicitly enabled (which flags `unverifiedModelWarning`). These are distinct
measurement series from their search-off API routes and from each other. A complete
`auto` answer where the provider confirms no search (`noSearchConfirmed`, persisted as
`web_status='not_used'`) remains a valid observation. A failed or unfinished search
makes the answer non-comparable. Search actions, exposed queries, returned sources, and
final citations are stored separately.

Anthropic search is bounded to three attempted searches and one continuation
within a target timeout. OpenAI and Gemini hosted search tools have no enforceable
internal call ceiling. Quotes forecast one billed search per target, then computed usage
costs use provider-reported token and tool-use records when available. A missing billing
quantity remains unknown, and no quote is an invoice. Setting `HEARSAY_MONTHLY_USD_CAP`
enforces a hard UTC calendar-month USD spend kill-switch across live (non-seeded) API
runs, refusing runs pre-flight or stopping mid-run with `spend_cap_exceeded`. Perplexity
Sonar retains its historical built-in search profile without exposed query wording or
per-action completion records.

Optional BYOK DataForSEO routes (`google-aio` and `chatgpt-web`) stay registered outside
the core four-provider API series (`OPTIONAL_PROVIDERS`). `google-aio` records Google AI
Overview text and native reference citations separately from organic SERP
`source_observations`, and cleanly records `noAioPresent` (`answerStatus='empty'`) when
Google does not render an AI Overview. `chatgpt-web` records ChatGPT web text, fan-out
queries, returned sources, and native citations. Both honor `location_code` and
`language_code` and support a minimal 1-request pre-wave health canary
(`checkDataForSeoHealth`).

## Subscription agent surfaces

Hearsay can also run an explicitly enabled panel through a locally installed,
already-authenticated Codex, Claude Code, or Antigravity CLI. Connected dashboard runs
are labeled as **Codex agent** and **Claude Code agent**; standalone CLI runs also
support **Antigravity (`agy-cli`)**. They are not measurements of the ChatGPT web app,
Claude.ai, Google AI Mode, or a general consumer population; they are
developer-tool/technical-B2B buyer-angle observations from a particular signed-in
agent surface.

Subscription prompts require web search before answering. A target is marked
`web_status=verified` only when Hearsay observes a completed provider-confirmed search
event. A URL in the final answer, a page fetch without a search, or a started/failed
search is not enough. Search-result URLs, page-fetch evidence and final-answer
citations remain separate receipts.

Only completed, tracking-lane, comparable targets with verified web search enter
subscription trends, rates and alerts. Exploration answers remain discovery evidence
until a human explicitly promotes the question; API, Codex agent, Claude Code agent,
and Antigravity series are never silently joined. Subscription runs consume the user's
plan allowance and may incur overage, so Hearsay reports usage metadata when exposed
and does not invent a dollar price.

## Forensics analyzers

### Retrieved-but-Dropped attrition and Own-Site Hijacks

Being crawled or retrieved into a search step does not mean your page survived into the
final answer, and being cited does not mean your brand was recommended.
`retrievalAttritionReport` (`core/evidence-report.js`) separates those layers
deterministically over eligible, completed, comparable, search-grounded tracking
responses (excluding seeded demo runs by default and excluding memory-only responses
with `search_policy='off'` or `web_status` in `not_used`/`not_applicable`, which are
disclosed in `limitations`).

- **Domain ownership classification.** Every canonicalized URL (`sourceGroupingUrl` + `normaliseUrl`) is matched against active (non-archived) entities as `brand_owned` (`is_self = 1`), `competitor_owned`, or `third_party`.
- **Attrition math.** Within each eligible response, `source_observations` and `answer_citations` are deduplicated by canonical URL. A retrieved URL counts as cited if its canonical URL appears in `answer_citations` or any of its `source_observation_id` rows is referenced by a citation; otherwise it is counted as dropped. Overall, per-ownership, and per-series attrition rates (`droppedObservations / retrievedObservations`) are reported with Wilson 95% confidence intervals. Surfaces that do not expose `source_observations` are explicitly flagged in `limitations` rather than shown as 0% attrition.
- **Own-Site Hijack detection.** Whenever a search-grounded answer cites at least one `brand_owned` URL in `answer_citations`, Hearsay resolves effective mention stances strictly at that response's `analysis_revision` while honoring the latest human `mention_corrections` row. An answer is flagged as an **Own-Site Hijack** if at least one competitor has `effectiveStance='positive'` while the brand does not. Uncorrected `legacy-heuristic-v1` responses without stance labels are excluded from hijack evaluation and counted in `limitations`. Hearsay reports hijack rates with Wilson 95% intervals both over own-cited answers (`hijacks / ownCitedAnswers`) and over all eligible answers (`hijacks / eligible`), together with verbatim receipts.

### Paired Parametric Memory vs. Grounded Retrieval Delta

To separate brand awareness baked into model weights from visibility earned via live web
search, `memoryVsRetrievalDelta` (`core/evidence-report.js`) runs a strictly paired
comparison:

- **Mode partition.** Eligible responses are partitioned into parametric `memory` (`(search_policy='off' AND web_status != 'verified') OR web_status='not_used'`, where `not_used` represents provider-confirmed `noSearchConfirmed`) versus verified `grounded` (`search_policy IN ('auto', 'required') AND web_status='verified'`). Legacy or unverified search states are excluded and disclosed in `limitations`.
- **Strict `(provider, model)` and `prompt_id` pairing.** Hearsay never blends memory answers from one model against grounded answers from another. Within each exact `(provider, model)` group, only prompts observed in *both* `memory` and `grounded` modes enter the paired delta (`pairedPromptIds`). Unpaired models or disjoint prompt sets are reported transparently as `memory_only`, `grounded_only`, or `no_overlap` with zero fabricated deltas.
- **Four-state prompt classification.** For every active entity, Hearsay computes paired Wilson 95% mention rates, positive-stance rates (honoring human stance corrections), grounded citation rates, and raw rate deltas (`grounded - memory`), and assigns every paired prompt to one deterministic bucket:
  - `memory_anchored` — mentioned in both parametric memory and grounded retrieval.
  - `search_dependent` — absent in parametric memory, surfaces only when live retrieval runs.
  - `memory_displaced` — present in parametric memory, displaced when live retrieval runs.
  - `absent_in_both` — absent in both modes.

### Multi-Wave Citation Persistence and off-site targets

A third-party article cited once in a single stochastic run is often noise; a page cited
across repeated weekly waves is durable earned media. `citationPersistenceReport`
(`core/opportunities.js`) measures persistence across completed runs (`runs.status='done'`,
excluding seeded runs by default) ordered chronologically as measurement waves.

- **Persistence rate.** For every cited canonical URL and domain in `answer_citations`, Hearsay computes `wavesSeen / totalWaves`.
- **Single-wave honesty.** When `totalWaves < 2`, every URL and domain is labeled `single_wave_unverified` and `ephemeralChurnRate` stays `null`. Hearsay refuses to infer durability or churn from one wave.
- **Multi-wave durability tiers.** When `totalWaves >= 2`:
  - `durable` — cited in at least 60% of waves (`wavesSeen * 5 >= totalWaves * 3`).
  - `recurring` — cited in at least 2 waves (`wavesSeen >= 2`) below the 60% threshold.
  - `ephemeral` — cited in only 1 wave (`wavesSeen === 1`).
- **Off-site outreach ranking.** `offSiteTargets` filters cited URLs to `third_party` ownership where competitors are mentioned and the brand is absent (`brandAbsentCount > 0`), ordered by durability tier, `persistenceRate`, positive `competitorRecommendations` (respecting human stance corrections), and `citationCount`. Overall `offSiteShare` and `ephemeralChurnRate` carry Wilson 95% confidence intervals.

### Zero-Key Site Pre-Flight Audit (`hearsay check <url>`)

Before attributing low visibility to prompts or copy, technical SEOs need to verify that
raw HTML is crawlable and un-truncated without JavaScript execution. `checkSite`
(`core/site-check.js`) performs a zero-key, zero-dependency pre-flight audit with strict
SSRF protection (blocking loopback, RFC 1918, link-local, metadata, and DNS-resolved
private IPs on the initial URL and every redirect hop unless `--allow-private-hosts` is
explicitly passed):

- **RFC 9309 `robots.txt` evaluation.** Fetches `<origin>/robots.txt` (up to 5 redirects, 512 KB cap; 4xx treated as default-allowed per RFC 9309 §2.3.1.3; 5xx treated as temporary disallow per §2.3.1.4) and evaluates 9 crawlers split into traditional search (`Googlebot`, `Bingbot`), AI search/retrieval (`OAI-SearchBot`, `ChatGPT-User`, `Claude-SearchBot`, `PerplexityBot`), and AI training (`GPTBot`, `ClaudeBot`, `Google-Extended`). Specific user-agent groups strictly supersede `*`, duplicate groups merge, `*` wildcards and `$` end anchors are honored, and longest UTF-8 byte-length pattern wins with `Allow` winning equal-length ties.
- **Raw-HTML UTF-8 byte-offset truncation cliffs.** Parses the raw HTTP HTML payload (5 MB cap, no JS execution) to compute exact UTF-8 byte offsets of the first `<h1>`, first substantive paragraph, and cumulative 25%, 50%, 75%, and 90% visible text milestones. Flags three deterministic truncation cliffs: primary content starting after `30 KB`, core visible content (50% text offset, first `<h1>`, or first substantive paragraph) extending past `100 KB`, and raw HTML exceeding `300 KB`.
- **CSR empty-shell risk and optional `--browser` diff.** Flags SPA mount roots (`#root`, `#app`, `#__next`, `#__nuxt`, etc.), `<noscript>` JavaScript warnings, and sparse raw visible text relative to script footprint (`high`, `medium`, or `low` risk). Passing `--browser` optionally renders the page in local headless Chromium/Chrome or Playwright to quantify the exact raw-HTML vs. rendered-DOM word and heading hydration gap.
- **Honest User-Agent and IP/rDNS WAF non-spoofing disclaimer.** Hearsay always identifies itself honestly as `HearsaySiteCheck/0.1` and never spoofs `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, or `PerplexityBot`. Because Cloudflare, Akamai, Fastly, and similar WAF/CDN layers authenticate AI crawlers by published IP ranges, reverse DNS (rDNS), or cryptographic signatures rather than User-Agent headers alone, a local client cannot detect IP-gated blocks, managed challenges, or CDN rate limits. Every report states this boundary explicitly and directs operators to inspect CDN or origin access logs filtered by official published crawler IP ranges.

## Deliberate choices

- **Versioned prompt routes.** API adapters omit a system message and send the reviewed
  question through their recorded API profile. Subscription agents receive a versioned
  instruction envelope that requires web search and limits their task. The envelope
  version and execution profile are stored with the answer. These runs do not measure
  an unframed consumer app response.
- **Provider-default temperature.** No sampling parameters are overridden; you measure what a default caller gets.
- **Gaps are gaps.** Days without valid responses render as missing, never as zero. An interpolated line would be fabricated continuity.
- **Branded prompts are excluded from share-of-voice denominators.** Share of AI voice is: of all brand mentions across your non-branded panel, the fraction that are yours. A prompt that names your brand ("Is Notewell any good?") measures navigational recall, not discovery, and would inflate the number — so it is tracked but kept out of the denominator by default (a Settings toggle lets you include it, visibly).
- **Checked prices, usage, and hard spend caps.** Optional API runs use your provider keys. The built-in price table was checked on 2026-09-24 and can be overridden. A preview is a forecast for the selected panel, not an invoice; `HEARSAY_MONTHLY_USD_CAP` adds an optional hard UTC monthly USD kill-switch across live API runs. Computed cost uses reported usage from all known attempts, including excluded answers. Missing billing components stay unknown. Subscription allowance and possible overage are reported separately.
- **Local subscription authentication stays local.** Hearsay invokes the installed CLI, never reads or copies its credential store, never sends subscription credentials through an API, and keeps Codex agent and Claude Code agent observations separate from provider-API measurements.

## From evidence to outcomes

Evidence records the buyer question, provider-confirmed search actions and exposed
queries, returned sources or fetches, final-answer citations, and answer stance as
separate layers. A source is not a citation. Missing query text remains unavailable.
Branded questions test recall; non-branded questions support discovery rates. A repeated
gap can support an investigation, but it does not establish a cause or a page defect.

An opportunity saves exact answer and evidence IDs with a separate hypothesis. Human
review is required before an assistant proposal enters the action queue. A page-change
plan needs reviewed page evidence. When you record a shipped change, Hearsay freezes a
baseline and later review snapshot against the selected series. It reports coverage,
uncertainty, and any incompatible profile or prompt cells. A common-prompt subset must
be chosen explicitly. These comparisons are descriptive and do not establish that the
change caused a difference.

Weekly review combines those observations with outcomes, time, and expenses you entered
for either a native tracking series or a separately labeled `Standalone Research Audit`
import (without blending external imports into native series). Each outcome carries its
source, unit, period, attribution method, and optional intervention link and page role
(`changed` vs. `control`). Comparing outcomes on a changed page against an unchanged
comparison page helps bound background period drift when traffic is comparable, not
prove causation on its own. Hearsay does not infer traffic, conversions, or return on
investment from answer counts.

## What Hearsay refuses to fake

These are product decisions, not gaps in the roadmap:

- **No single blended "AI visibility score".** Collapsing mention rates, citations and recommendations into one magic number destroys the information you need to act, and hides the uncertainty this page exists to expose.
- **No fake UA-spoofing WAF pass/fail claims.** Spoofing `GPTBot` or `OAI-SearchBot` from a laptop IP does not test Cloudflare, Akamai, or Fastly IP/rDNS verification rules and produces false confidence.
- **No `llms.txt` or schema-markup scorecards.** Hearsay reports observable raw-HTML structure (headings, tables, JSON-LD types, byte offsets) rather than selling arbitrary checklist scores.
- **No single-wave durability claims.** One measurement wave cannot distinguish durable citations from stochastic churn; every domain and URL stays labeled `single_wave_unverified` until at least two completed waves exist.
- **No rank-position claims.** AI answers are not a ranked results page; pretending a stable "position 3" exists in a stochastic answer stream is false precision.
- **No prompt-volume estimates.** Nobody has real data on how often people prompt a given question; a made-up volume column would poison every number next to it.
- **No silent content publishing.** Hearsay is a measurement instrument; assistant research drafts stay separate from measurements and never publish without your explicit action.
