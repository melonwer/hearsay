# Hearsay

**AI visibility tracker for humans *and* agents.** See how ChatGPT, Claude, Gemini and
Perplexity talk about your brand versus your competitors, with honest statistics, on
your own box, with your own API keys, queryable by any agent over MCP.

[![CI](https://github.com/melonwer/hearsay/actions/workflows/ci.yml/badge.svg)](https://github.com/melonwer/hearsay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node ≥ 22.5](https://img.shields.io/badge/node-%E2%89%A5%2022.5-brightgreen.svg)](package.json)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-blue.svg)](package.json)
[![MCP built in](https://img.shields.io/badge/MCP-built%20in-8A2BE2.svg)](mcp/server.mjs)

[![Watch the tour](docs/video-poster.png)](docs/hearsay-launch.mp4)

**[Watch the 64-second tour.](docs/hearsay-launch.mp4)** What the tools get wrong, what
Hearsay measures instead, and what it looks like when your agent drives it.

## What this is, in five lines

People research purchases by asking AI now, and you cannot see what it says about you.
The tools that can see it charge $99 to $1,000 a month and hand you one blended score
with no error bars.

Hearsay asks your buying questions to ChatGPT, Claude, Gemini and Perplexity on a
schedule, several times each, and counts how often you get mentioned and recommended.
It reports every rate with a confidence interval and a sample size, keeps the raw
answers so you can read the source of any number, and runs on your machine with your
API keys. Your agent can drive all of it over MCP.

## Try it in two commands

Seeded demo data, nothing to install:

```sh
git clone https://github.com/melonwer/hearsay && cd hearsay
node scripts/seed.js && node server.js     # http://127.0.0.1:3000
```

You need Node.js 22.5 or newer, for its built-in `node:sqlite`. There is no npm
install, no build step, no Docker and no Postgres.

## Let an agent set it up

Register the MCP server once:

```sh
claude mcp add hearsay -- node /absolute/path/to/hearsay/mcp/server.mjs
```

For Claude Desktop, put this in `claude_desktop_config.json`:

```json
{ "mcpServers": { "hearsay": { "command": "node", "args": ["/absolute/path/to/hearsay/mcp/server.mjs"] } } }
```

Then paste this at your agent and stop reading:

> Set up Hearsay tracking for **my brand** against **competitor A** and
> **competitor B**. Draft the prompt panel, show it to me before you save anything,
> quote the cost before you spend, then run it and tell me where we stand.

It will draft the buying questions, wait for you to approve them, quote the run cost,
run the panel and report back with the error bars attached. Thirteen MCP tools cover
the whole lifecycle: setup, prompt drafting, cost quotes, runs, results, alerts. Your
agent brings its own model, so reading results costs you no API keys. Keys are only
spent on the measurement panel itself.

There is an optional operator skill in [`skill/`](skill/SKILL.md) that teaches an agent
the full playbook, including how to read the numbers honestly. Copy the folder to
`~/.claude/skills/hearsay-ai-visibility/`.

To go live without an agent, add one provider key to `.env` (any of `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`), set `HEARSAY_DEMO=0`,
restart, and visit `/setup`.

<!-- TODO: record docs/demo.gif (a real Claude Code session) and embed it here. -->

<p>
  <img src="docs/screenshot-light.png" alt="Hearsay dashboard, light theme, showing share of AI voice with confidence intervals, provider trends and alerts" width="49%">
  <img src="docs/screenshot-dark.png" alt="Hearsay dashboard, dark theme" width="49%">
</p>

Every rate in the dashboard links back to the stored answers it came from.

## Why it exists

68% of US Google searches end without a click (May 2026,
[SparkToro](https://sparktoro.com/blog/in-2026-less-than-one-third-of-google-searches-still-send-a-click/)),
and where an AI Overview appears, on more than 20% of searches,
[CTR falls by nearly 60%](https://searchengineland.com/google-zero-click-searches-2026-study-479717).
Buying research is moving into AI answers, and the tools that measure it are metered.
Profound's $99/mo entry tier is ChatGPT only, with Claude, API access and SSO gated
behind Enterprise ([pricing](https://www.tryprofound.com/pricing)). Otterly charges $29
to $439/mo extra just for the Claude engine ([pricing](https://otterly.ai/pricing/)).
Semrush meters $99/mo *per domain* for 25 prompts
([pricing](https://www.semrush.com/pricing/ai/)). Agencies have started
[building trackers in-house to escape $99 to $1,000/mo pricing](https://digiday.com/marketing/marketers-question-expensive-ai-visibility-tools-as-inconsistent-results-fuel-skepticism/).

Hearsay is not a cheaper meter. It is a measurement method you can run anywhere, with
repeated sampling, real error bars, the receipts behind every number, and an agent
surface that turns the whole lifecycle into a conversation.

## What you get

Rates come from repeated sampling with Wilson 95% confidence intervals, and every one
of them ships its sample size. Numbers built on too few samples are flagged rather than
dressed up.

Prompts group into intents, meaning one buying question with several paraphrases.
Hearsay reports the spread across reruns and the spread across phrasings separately,
because rewording a question moves AI answers more than asking it again does.

Every raw answer is stored and browsable, and every metric links to the answers behind
it. The citation gap report shows who gets cited instead of you, domain by domain, in
the answers where your brand never comes up. Alerts cover mention drops, competitors
overtaking you, and recommendations won or lost, each with its receipts attached.

The cost calculator estimates spend before a run and records actual token spend after.
Your keys, your bill, no reselling. Demo mode ships a seeded fictional universe
(Notewell against Jotta, EchoPad and Quillo) so you can look at every screen before
spending anything.

### What Hearsay refuses to build

Each of these is a deliberate omission, not a missing feature.

There is no single blended "AI visibility score", because one magic number hides the
uncertainty this tool exists to expose. There are no rank-position claims, because a
stochastic answer stream has no stable "position 3" and pretending otherwise is false
precision. There are no prompt-volume estimates, because nobody has real data on how
often people ask a given question, and invented volume would poison every number next
to it. And there is no content generation, because a measurement instrument that writes
your content is marketing for itself.

## What it costs to run

Hearsay never quotes a flat number. Your spend depends on panel size, providers and
sampling depth, so the built-in calculator computes it from your configuration before
every run and records the real token spend afterwards.

![Hearsay's cost calculator on the Settings page, showing estimated spend from your panel size and actual 30-day token spend](docs/screenshot-cost.png)

## How it compares

Factual columns only, checked against the vendors' public pricing pages on 2026-07-26
(Peec figures as of 2026-07-26 via published pricing research):

| | Hearsay | [Profound](https://www.tryprofound.com/pricing) | [Peec AI](https://peec.ai/pricing) | [elmo](https://github.com/elmohq/elmo) |
|---|---|---|---|---|
| Price | Free; you pay your model providers directly | $99/mo entry (ChatGPT only) → $399/mo → Enterprise | $95 to $495/mo, Enterprise custom | Free |
| License | MIT | Proprietary SaaS | Proprietary SaaS | MIT |
| Engines | ChatGPT, Claude, Gemini, Perplexity, all included | Entry tier: ChatGPT only; Claude Enterprise-gated | 3 of 6 engines on self-serve tiers | ChatGPT, Claude, Perplexity, Gemini, AI Overviews |
| Sampling / CIs | Wilson 95% CIs plus a rerun vs phrasing variance split | None published | None published | None |
| Receipts (raw answers) | Every answer stored, browsable, linked from every metric | Answer-engine responses on paid tiers | Prompt-level views on paid tiers | Stores responses |
| Agent access (MCP/API) | MCP and JSON API built in, free, read and write | API Enterprise-only | API/MCP higher-tier line items | None |
| Install footprint | `git clone` plus `node server.js`; zero dependencies; one SQLite file | Hosted SaaS | Hosted SaaS | Docker Compose, Postgres and pg-boss via npm CLI |

## Methodology, honestly

Three things most trackers will not tell you, from [METHODOLOGY.md](METHODOLOGY.md)
(also served at `/methodology`):

Phrasing variance beats rerun variance. Cross-paraphrase agreement runs 0.135 to 0.288
against 0.50 to 0.61 for reruns ([arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)),
so Hearsay samples paraphrases per intent and shows you both spreads.

API answers are a logged-out discovery baseline and are directional only. They carry no
memory, no personalisation and none of the consumer apps' hidden system prompts. That
is a bias no amount of sampling removes, so it is stated here instead of buried.

The channel is still small. Organic LLM traffic is under 0.2% of visits for most sites
([organicllm.org](https://organicllm.org)), though complex considered-purchase
categories run several times higher. Hearsay's cost structure is built for a channel
that size.

## Self-host checklist

> MIT, one license. No FSL, no open-core split, no "enterprise edition".
> Everything in this repo is everything there is; no features are gated.
> No cloud tier is planned. Hearsay is software you run, not a service on a trajectory.
> No telemetry and no phone-home. The only outbound requests are the LLM calls you
> configure. Your data is one SQLite file at `data/hearsay.db`, so you can back it up
> with `cp`, and `GET /api/export` hands you everything as JSON whenever you want it.

## Roadmap

v1.1 brings webhook alerts first (a zero-dependency POST), then multi-client workspaces
with white-label HTML and PDF report export, opt-in LLM-judged sentiment that uses your
existing keys, CSV export, and a Docker image for people who want one.

v1.2 adds prompt-level Google AI Overviews through an optional SERP API, more providers
(Grok, DeepSeek, Copilot), and a community prompt-pack marketplace. v2 adds trend
annotations, so you can mark the day you shipped the comparison page.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers the zero-dependency rule, how to run the
tests, and where the good first issues are. [SECURITY.md](SECURITY.md) covers the
localhost default, key handling, and how to report a vulnerability.

Not affiliated with OpenAI, Anthropic, Google or Perplexity; trademarks belong to their
owners.

[MIT](LICENSE).
