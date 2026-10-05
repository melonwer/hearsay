# Methodology

Hearsay links its measurement rates to stored answer receipts. This page explains what
it measures, how answer-rate intervals work, and what the numbers cannot establish.

## What Hearsay measures

Hearsay asks reviewed buyer questions through separately labeled OpenAI, Anthropic,
Gemini, and Perplexity APIs or signed-in Codex and Claude Code agents. It retains the
final answer and available evidence for each attempt. Exact-series reports count
comparable answers and link to their receipts. Failed or incomplete attempts remain
visible as collection gaps.

There is no machine-learned scoring layer between an answer and its metric. Mention
detection matches entity names and aliases. The deterministic stance classifier labels
positive, negative, neutral, uncertain, or absent statements with a rule and answer
span. A person can append a correction without changing the original answer or label.
Older heuristic recommendation values remain labeled as legacy data.

## Sampling and confidence intervals

A single AI answer is an anecdote, not a measurement. The same prompt, re-sent a minute later, routinely produces a different brand list. So Hearsay asks each prompt several times per provider per run and reports rates, not one-off observations.

Answer rates show a Wilson 95% interval and their sample size. The interval describes
sampling uncertainty for this configured panel and route; it does not represent the
answers seen by every buyer. Rates with fewer than five comparable answers are flagged
as low sample. Missing attempts never enter the denominator as brand absences.

## Phrasing variance vs rerun variance (why intents exist)

Rerunning the *same* prompt is only half the variance story. Published measurement work found that **phrasing variance exceeds rerun variance: cross-paraphrase agreement (0.135–0.288) is far lower than same-prompt rerun agreement (0.50–0.61)** ([arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)). In plain words: rewording the question changes the answer far more than re-asking the same wording does. A tool that only reruns one phrasing shows you the *smaller* error bar and hides the bigger one.

That is why Hearsay groups prompts into **intents**: one buying question ("best AI meeting-notes tool") expressed as several paraphrases. For each intent it reports the pooled mention rate with its Wilson interval, *and* splits the spread into two components:

- **Rerun spread** — variation across repeated samples of the same wording.
- **Phrasing spread** — variation across the paraphrase means.

Both spreads are reported when the panel has enough repeated phrasings to calculate
them. A single wording cannot establish phrasing variance.

## What each route can tell you

API measurements use provider endpoints, while subscription measurements use the
selected signed-in agent CLI. Neither route reproduces a consumer app. For API runs:

- **No memory or personalisation.** Consumer apps adapt to each user's history; the API sees a fresh, anonymous caller every time.
- **No consumer-app system prompts or tools.** ChatGPT-the-app wraps the model in hidden instructions and tooling that the raw API does not replicate. Hearsay can explicitly enable the OpenAI Responses web-search tool, but that API route still does not reproduce the consumer app.
- **No geography or account effects.** Your customers' answers vary by locale and account state in ways an API panel cannot reproduce.

Treat each exact route, search policy, model, approved benchmark, and analysis revision
as its own directional series. Hearsay does not merge sibling routes into a consumer
app score. A changed prompt, alias, model, policy, or analysis revision starts a new
comparison context.

## Opt-in API web search

OpenAI Responses web search supports `auto` and `required` on the validated
`gpt-5.6-luna` route. Anthropic Messages basic web search supports `auto` on the
validated `claude-sonnet-5` route. These are distinct measurement series from
their search-off API routes and from each other. A complete `auto` answer where
the provider confirms no search remains a valid auto observation. A failed or
unfinished search makes the answer non-comparable. Search actions, exposed
queries, returned sources, and final citations are stored separately.

Anthropic search is bounded to three attempted searches and one continuation
within a target timeout. OpenAI's hosted search has no enforceable internal
call ceiling. Quotes forecast one billed search per target, then computed usage
costs use provider-reported token and tool-use records when available. A
missing billing quantity remains unknown, and no quote is an invoice.

## Subscription agent surfaces

Hearsay can also run an explicitly enabled panel through a locally installed,
already-authenticated Codex or Claude Code CLI. These results are labeled exactly as
**Codex agent** and **Claude Code agent**. They are not measurements of the ChatGPT web
app, Claude.ai, Google AI Mode, or a general consumer population; they are
developer-tool/technical-B2B buyer-angle observations from a particular signed-in
agent surface.

Subscription prompts require web search before answering. A target is marked
`web_status=verified` only when Hearsay observes a completed provider-confirmed search
event. A URL in the final answer, a page fetch without a search, or a started/failed
search is not enough. Search-result URLs, page-fetch evidence and final-answer
citations remain separate receipts.

Only completed, tracking-lane, comparable targets with verified web search enter
subscription trends, rates and alerts. Exploration answers remain discovery evidence
until a human explicitly promotes the question; API, Codex agent and Claude Code agent
series are never silently joined. Subscription runs consume the user's plan allowance
and may incur overage, so Hearsay reports usage metadata when exposed and does not
invent a dollar price.

Gemini grounded search remains disabled pending legal review. The existing Gemini API
route stays separate. Perplexity Sonar retains its historical built-in search profile;
its exact query wording and per-action search completion are unavailable.

## Deliberate choices

- **Versioned prompt routes.** API adapters omit a system message and send the reviewed
  question through their recorded API profile. Subscription agents receive a versioned
  instruction envelope that requires web search and limits their task. The envelope
  version and execution profile are stored with the answer. These runs do not measure
  an unframed consumer app response.
- **Provider-default temperature.** No sampling parameters are overridden; you measure what a default caller gets.
- **Gaps are gaps.** Days without valid responses render as missing, never as zero. An interpolated line would be fabricated continuity.
- **Branded prompts are excluded from share-of-voice denominators.** Share of AI voice is: of all brand mentions across your non-branded panel, the fraction that are yours. A prompt that names your brand ("Is Notewell any good?") measures navigational recall, not discovery, and would inflate the number — so it is tracked but kept out of the denominator by default (a Settings toggle lets you include it, visibly).
- **Checked prices and usage.** Optional API runs use your provider keys. The built-in
  price table was checked on 2026-09-24 and can be overridden. A preview is a forecast
  for the selected panel, not a spend cap or invoice. Computed cost uses reported usage
  from all known attempts, including excluded answers. Missing billing components stay
  unknown. Subscription allowance and possible overage are reported separately.
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

Weekly review combines those observations with outcomes, time, and expenses you entered.
Each outcome carries its source, unit, period, and attribution method. Hearsay does not
infer traffic, conversions, or return on investment from answer counts. Reading a report
does not run a provider or authorize publication.

## What Hearsay refuses to fake

These are product decisions, not gaps in the roadmap:

- **No single blended "AI visibility score".** Collapsing mention rates, citations and recommendations into one magic number destroys the information you need to act, and hides the uncertainty this page exists to expose.
- **No rank-position claims.** AI answers are not a ranked results page; pretending a stable "position 3" exists in a stochastic answer stream is false precision.
- **No prompt-volume estimates.** Nobody has real data on how often people prompt a given question; a made-up volume column would poison every number next to it.
- **No content generation.** Hearsay is a measurement instrument. The moment it also writes your content, its numbers become marketing for itself.
