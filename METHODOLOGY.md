# Methodology

Hearsay's promise is **receipts over scores**: every number on the dashboard can be traced back to stored AI answers you can read yourself. This page explains, in plain words, what is measured, how the error bars are computed, and — just as important — what these numbers cannot tell you.

## What Hearsay measures

Hearsay repeatedly asks AI models (ChatGPT, Claude, Gemini, Perplexity) the questions your buyers ask, stores every raw answer, and analyses each one deterministically: which brands were mentioned, in what order, which domains were cited, and whether the answer reads as a recommendation. Nothing is summarised away. Click any rate on the dashboard and you land on the exact answers behind it — the receipts.

There is no machine-learned scoring layer between the answer and the metric. Mention detection is word-boundary text matching against your entity names and aliases; recommendation detection is a small set of documented, deterministic rules. That trades a little nuance for something better: you can audit every classification by reading the answer it came from.

## Sampling and confidence intervals

A single AI answer is an anecdote, not a measurement. The same prompt, re-sent a minute later, routinely produces a different brand list. So Hearsay asks each prompt several times per provider per run and reports rates, not one-off observations.

Every rate ships with a Wilson 95% confidence interval — **the error bar others hide** — which says: given this many trials, the true rate plausibly lies in this range. Every rate also ships its sample size (the "n=" you see everywhere), and anything with n below 5 is explicitly flagged as low-sample rather than quietly displayed as if it were solid.

## Phrasing variance vs rerun variance (why intents exist)

Rerunning the *same* prompt is only half the variance story. Published measurement work found that **phrasing variance exceeds rerun variance: cross-paraphrase agreement (0.135–0.288) is far lower than same-prompt rerun agreement (0.50–0.61)** ([arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)). In plain words: rewording the question changes the answer far more than re-asking the same wording does. A tool that only reruns one phrasing shows you the *smaller* error bar and hides the bigger one.

That is why Hearsay groups prompts into **intents**: one buying question ("best AI meeting-notes tool") expressed as several paraphrases. For each intent it reports the pooled mention rate with its Wilson interval, *and* splits the spread into two components:

- **Rerun spread** — variation across repeated samples of the same wording.
- **Phrasing spread** — variation across the paraphrase means.

Both numbers are always shown. The phrasing number is never hidden, even though it is usually the larger and less flattering one.

## What the API can and cannot tell you

Hearsay measures models through their public APIs. That is a deliberate, documented trade-off, and it is a bias no amount of sampling removes:

- **No memory or personalisation.** Consumer apps adapt to each user's history; the API sees a fresh, anonymous caller every time.
- **No consumer-app system prompts or tools.** ChatGPT-the-app wraps the model in hidden instructions and tooling that the raw API does not replicate. Hearsay can explicitly enable the OpenAI Responses web-search tool, but that API route still does not reproduce the consumer app.
- **No geography or account effects.** Your customers' answers vary by locale and account state in ways an API panel cannot reproduce.

Treat Hearsay's numbers as **a logged-out discovery baseline, directional only** — a consistent, repeatable measurement of how the underlying models talk about your category, not a replay of any one customer's screen. A paired API-vs-UI comparison study is planned; it will be linked here when published.

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

## Deliberate choices

- **No system prompt.** Hearsay sends your prompt and nothing else, so the measurement is of the model's defaults, not of our framing.
- **Provider-default temperature.** No sampling parameters are overridden; you measure what a default caller gets.
- **Gaps are gaps.** Days without valid responses render as missing, never as zero. An interpolated line would be fabricated continuity.
- **Branded prompts are excluded from share-of-voice denominators.** Share of AI voice is: of all brand mentions across your non-branded panel, the fraction that are yours. A prompt that names your brand ("Is Notewell any good?") measures navigational recall, not discovery, and would inflate the number — so it is tracked but kept out of the denominator by default (a Settings toggle lets you include it, visibly).
- **Bring your own keys.** Measurement runs on your own provider accounts. Nothing is resold, nothing is metered, and the spend estimate you see before a run comes from a calculator over your actual panel size and current per-token prices — never a flat figure asserted in marketing copy.
- **Local subscription authentication stays local.** Hearsay invokes the installed CLI, never reads or copies its credential store, never sends subscription credentials through an API, and keeps Codex agent and Claude Code agent observations separate from provider-API measurements.

## How big this channel really is

Honesty cuts both ways: organic LLM traffic is still small for most sites — under 0.2% of visits per [organicllm.org](https://organicllm.org), with complex and considered-purchase categories running multiples higher. This channel is worth measuring and watching, not worth a three-figure-per-month subscription for most teams. Hearsay's bring-your-own-keys cost structure is built for a channel this size; you pay providers for your panel's API usage. The calculator previews list-price estimates and reports computed usage costs afterward, with a known subtotal and unknown components when billing data is incomplete.

## What Hearsay refuses to fake

These are product decisions, not gaps in the roadmap:

- **No single blended "AI visibility score".** Collapsing mention rates, citations and recommendations into one magic number destroys the information you need to act, and hides the uncertainty this page exists to expose.
- **No rank-position claims.** AI answers are not a ranked results page; pretending a stable "position 3" exists in a stochastic answer stream is false precision.
- **No prompt-volume estimates.** Nobody has real data on how often people prompt a given question; a made-up volume column would poison every number next to it.
- **No content generation.** Hearsay is a measurement instrument. The moment it also writes your content, its numbers become marketing for itself.
