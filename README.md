# Hearsay

**AI visibility tracker for humans *and* agents.** See how ChatGPT, Claude, Gemini and
Perplexity talk about your brand versus your competitors — statistically honest numbers,
on your own box, with your own API keys, queryable by any agent over MCP.

[![CI](https://github.com/melonwer/hearsay/actions/workflows/ci.yml/badge.svg)](https://github.com/melonwer/hearsay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node ≥ 22.5](https://img.shields.io/badge/node-%E2%89%A5%2022.5-brightgreen.svg)](package.json)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-blue.svg)](package.json)
[![MCP built in](https://img.shields.io/badge/MCP-built%20in-8A2BE2.svg)](mcp/server.mjs)

## Why

68% of US Google searches end without a click (May 2026,
[SparkToro](https://sparktoro.com/blog/in-2026-less-than-one-third-of-google-searches-still-send-a-click/)),
and when an AI Overview appears (20%+ of searches),
[CTR falls nearly 60%](https://searchengineland.com/google-zero-click-searches-2026-study-479717).
Buying research is moving into AI answers — and the tools that measure it are metered:
Profound's $99/mo entry tier is ChatGPT-only with Claude, API and SSO Enterprise-gated
([pricing](https://www.tryprofound.com/pricing)); Otterly charges $29–$439/mo extra just
for the Claude engine ([pricing](https://otterly.ai/pricing/)); Semrush meters $99/mo
*per domain* for 25 prompts ([pricing](https://www.semrush.com/pricing/ai/)).
[Agencies are building in-house trackers to escape $99–$1,000/mo pricing](https://digiday.com/marketing/marketers-question-expensive-ai-visibility-tools-as-inconsistent-results-fuel-skepticism/).

Hearsay is not a cheaper meter. It is a measurement methodology you run anywhere:
repeated sampling with real error bars, receipts behind every number, and an agent
surface that makes the whole lifecycle — setup, cost quote, run, interpretation —
a conversation.

## Ask your agent

<!-- TODO: record docs/demo.gif, then restore this embed:
![Claude Code answering "how's our AI visibility this week?" from Hearsay's MCP server](docs/demo.gif)
-->

Ask it in plain language — *"how's our AI visibility this week?"* — and your agent
answers from your own measurements, with the error bars attached.

<p>
  <img src="docs/screenshot-light.png" alt="Hearsay dashboard, light theme — share of AI voice with confidence intervals, provider trends, alerts" width="49%">
  <img src="docs/screenshot-dark.png" alt="Hearsay dashboard, dark theme" width="49%">
</p>

The dashboard is the receipts your agent cites: every rate links to the stored answers
behind it.

## Quickstart

Demo with seeded data, two commands, nothing to install:

```sh
git clone https://github.com/melonwer/hearsay && cd hearsay
node scripts/seed.js && node server.js     # http://127.0.0.1:3000
```

Requires Node.js ≥ 22.5 (built-in `node:sqlite`). No npm install, no build step, no
Docker, no Postgres.

**Go live:** add one provider key to `.env` (any of `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`), set `HEARSAY_DEMO=0`,
restart, and visit `/setup` — or just tell your agent to set it up (below).

## Agent quickstart

Hearsay ships a zero-dependency MCP server with 13 tools covering the full lifecycle —
setup, prompt drafting, cost quotes, runs, results, alerts. Your agent brings its own
model, so **reading results costs no API keys**; keys are only spent on the measurement
panel itself. With [Claude Code](https://claude.com/claude-code):

```sh
claude mcp add hearsay -- node /absolute/path/to/hearsay/mcp/server.mjs
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "hearsay": { "command": "node", "args": ["/absolute/path/to/hearsay/mcp/server.mjs"] } } }
```

Then just ask: *"How's our AI visibility this week?"* — or, on a fresh install,
*"Set up tracking for Acme vs Jotta and EchoPad"* and the agent will draft your
prompt panel, quote the run cost before spending anything, and report honest numbers.
The optional operator skill in [`skill/`](skill/SKILL.md) teaches it the full playbook
(copy the folder to `~/.claude/skills/hearsay-ai-visibility/`).

The MCP server reads a running Hearsay at `HEARSAY_URL` (default
`http://127.0.0.1:3000`).

## Self-host checklist

> - **MIT, single license.** No FSL, no open-core split, no "enterprise edition".
> - **No gated features.** Everything in this repo is everything there is.
> - **No cloud tier planned.** Hearsay is software you run, not a service on a trajectory.
> - **No telemetry, no phone-home.** The only outbound requests are the LLM calls you configure.
> - **One-file SQLite.** Your data is `data/hearsay.db`; back it up with `cp`.
> - **Data freedom.** `GET /api/export` hands you everything as JSON, any time.

## Features

- **Repeated sampling with Wilson 95% confidence intervals** — every rate ships its
  sample size; low-sample numbers are flagged, not dressed up.
- **Intent-level phrasing variance** — prompts group into intents (one buying question,
  several paraphrases); Hearsay reports rerun spread *and* phrasing spread, because
  rewording a question changes AI answers more than re-asking it does.
- **Receipts explorer** — every raw answer is stored and browsable; every metric links
  to the answers it came from.
- **Citation gap** — who gets cited instead of you, domain by domain, for answers where
  your brand is absent.
- **Alerts** — mention drops, competitor overtakes, lost/gained recommendations, with
  receipts attached.
- **Cost calculator** — see estimated spend before every run and actual token spend
  after; your keys, your bill, no reselling.
- **Agent surface** — 13 MCP tools (read *and* write), an operator skill, and a JSON
  API; incumbents gate API access behind Enterprise tiers.
- **Demo mode** — a seeded fictional universe (Notewell vs Jotta, EchoPad, Quillo) so
  you can evaluate every screen before spending a cent on API calls.

### What Hearsay refuses to build

These are features, not gaps:

- **No single blended "AI visibility score".** One magic number hides the uncertainty
  the whole tool exists to expose.
- **No rank-position claims.** A stochastic answer stream has no stable "position 3";
  pretending otherwise is false precision.
- **No prompt-volume estimates.** Nobody has real data on how often people prompt a
  question; invented volume would poison every adjacent number.
- **No content generation.** A measurement instrument that writes your content is
  marketing for itself.

## What it costs to run

Hearsay never quotes you a flat number — your spend depends on your panel size,
providers and sampling depth, so the built-in calculator computes it from *your*
configuration before every run and records actual token spend after:

![Hearsay's cost calculator on the Settings page — estimated spend from your panel size, and actual 30-day token spend](docs/screenshot-cost.png)

## How it compares

Factual columns only, checked against the vendors' public pricing pages on 2026-07-26
(Peec figures as of 2026-07-26 via published pricing research):

| | Hearsay | [Profound](https://www.tryprofound.com/pricing) | [Peec AI](https://peec.ai/pricing) | [elmo](https://github.com/elmohq/elmo) |
|---|---|---|---|---|
| Price | Free; you pay your model providers directly | $99/mo entry (ChatGPT-only) → $399/mo → Enterprise | $95–$495/mo, Enterprise custom | Free |
| License | MIT | Proprietary SaaS | Proprietary SaaS | MIT |
| Engines | ChatGPT, Claude, Gemini, Perplexity — all included | Entry tier: ChatGPT only; Claude Enterprise-gated | 3 of 6 engines on self-serve tiers | ChatGPT, Claude, Perplexity, Gemini, AI Overviews |
| Sampling / CIs | Wilson 95% CIs + rerun-vs-phrasing variance split | None published | None published | None |
| Receipts (raw answers) | Every answer stored, browsable, linked from every metric | Answer-engine responses on paid tiers | Prompt-level views on paid tiers | Stores responses |
| Agent access (MCP/API) | MCP + JSON API built in, free, read + write | API Enterprise-only | API/MCP higher-tier line items | None |
| Install footprint | `git clone` + `node server.js`; zero dependencies; one SQLite file | Hosted SaaS | Hosted SaaS | Docker Compose + Postgres + pg-boss via npm CLI |

## Methodology, honestly

Three things most trackers won't tell you, from [METHODOLOGY.md](METHODOLOGY.md)
(also served at `/methodology`):

- **Phrasing variance exceeds rerun variance** (cross-paraphrase agreement 0.135–0.288
  vs rerun 0.50–0.61, [arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)) — so
  Hearsay samples paraphrases per intent and shows both spreads.
- **API answers are a logged-out discovery baseline, directional only** — no memory,
  no personalisation, no consumer-app system prompts; a bias no sampling removes,
  stated instead of hidden.
- **The channel is still small** — organic LLM traffic is under 0.2% of visits for most
  sites ([organicllm.org](https://organicllm.org)); complex, considered-purchase
  categories run multiples higher. Hearsay's cost structure is built for a channel this
  size.

## Roadmap

- **v1.1** — webhook alerts first (zero-dep POST); multi-client workspaces +
  white-label HTML/PDF report export; LLM-judged sentiment (opt-in, uses your existing
  keys); CSV export; Docker image as a convenience.
- **v1.2** — prompt-level Google AI Overviews via optional SERP API; more providers
  (Grok, DeepSeek, Copilot); community prompt-pack marketplace.
- **v2** — trend annotations ("we shipped the comparison page here").

## Contributing & security

- [CONTRIBUTING.md](CONTRIBUTING.md) — the zero-dependency rule, how to run tests,
  where the good first issues are.
- [SECURITY.md](SECURITY.md) — localhost by default, key handling, how to report a
  vulnerability.

Not affiliated with OpenAI, Anthropic, Google or Perplexity; trademarks belong to
their owners.

[MIT](LICENSE).
