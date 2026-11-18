# Hearsay

Find out why AI recommends your competitors instead of you.

Hearsay asks ChatGPT, Claude, Gemini, and Perplexity the questions your buyers ask, keeps a verbatim
receipt of every search and citation, and tracks whether your page changes actually move leads.
Open source, local-first, and run from your browser or the AI assistant you already use.

[![Hearsay animated preview: The conversation you never see](docs/hearsay-preview.gif)](https://melonwer.github.io/hearsay/)

**[See the interactive demo and the 51-second film](https://melonwer.github.io/hearsay/)**

[![CI](https://github.com/melonwer/hearsay/actions/workflows/ci.yml/badge.svg)](https://github.com/melonwer/hearsay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node ≥ 22.13](https://img.shields.io/badge/node-%E2%89%A5%2022.13-brightgreen.svg)](package.json)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-blue.svg)](package.json)
[![MCP built in](https://img.shields.io/badge/MCP-built%20in-8A2BE2.svg)](mcp/server.mjs)

## Why Hearsay

Most $99–$399/mo trackers turn noisy AI answers into one blended score. A score can't tell you
which question failed, which page the assistant skipped, or what to fix. Hearsay gives you the
receipt instead.

| | Typical paid tracker | Hearsay |
| --- | --- | --- |
| Headline metric | One blended "AI score" | Answer and share-of-voice rates with Wilson 95% intervals (`n` shown) |
| Prompt wording | One fixed prompt per keyword | Several paraphrases per buyer intent, separating wording spread from rerun spread |
| Engines | Mixed together, often per-engine tiers | One unblended series per route: OpenAI, Claude, Gemini, Perplexity, Codex, Claude Code, Antigravity |
| Evidence | Summary charts | Verbatim prompt, search query, returned URLs, cited URLs, and citation gaps |
| Outcomes | Stops at mentions | Shipped page changes compared with leads on an unchanged control page |
| Data | Hosted, per-seat | Local SQLite, JSON/CSV export, shareable HTML/PDF client reports |

## Quickstart

### In your browser

Requires [Node.js 22.13+](https://nodejs.org) (uses the built-in `node:sqlite`). No `npm install`,
`.env` file, or API keys needed to explore.

```sh
git clone https://github.com/melonwer/hearsay && cd hearsay
node server.js
```

Open the local URL printed in your terminal, then:

1. Click **Explore Interactive Notewell Demo**, or start in your own workspace.
2. Add provider API keys, or turn on signed-in CLI routes (`Codex`, `Claude Code`). Keys are saved
   locally to `.env` with `0600` permissions.
3. Approve your buyer questions, review the cost quote, run the audit, and click
   **Export Client Report**.

No Git? Use **Code → Download ZIP**, unzip, and run `node server.js`.

### In your AI assistant (Claude Code, Codex, Antigravity)

Paste this into your coding assistant. Studies are stored in `.hearsay/<app-id>/`, with no server
to set up:

> Install Hearsay from https://github.com/melonwer/hearsay and study my product. Use what you
> already know, ask for missing details, check available providers, and propose buyer questions,
> usage limits, and a schedule. Show me the actual plan before enabling collection.

Or set things up yourself:

```sh
node bin/hearsay.js doctor                                   # inspect runtime and agent routes
node scripts/build-bundles.js                                # build portable, Codex, Claude, Gemini bundles
codex plugin marketplace add "$PWD/dist/codex" && codex plugin add hearsay@hearsay-local
claude plugin marketplace add "$PWD/dist/claude" && claude plugin install hearsay@hearsay-local
codex mcp add hearsay -- node "$PWD/mcp/server.mjs"          # optional: MCP for Codex
claude mcp add -s user hearsay -- node "$PWD/mcp/server.mjs" # optional: MCP for Claude Code
```

More in [Skill and plugin installation](skill/references/installation.md) and the
[Setup and provider reference](docs/setup-reference.md).

## Dashboard

<p>
  <img src="docs/screenshot-dark.png" alt="Hearsay dashboard in dark theme showing exact measurement series, confidence intervals, and answer receipts" width="49%">
  <img src="docs/screenshot-light.png" alt="Hearsay dashboard in light theme showing tracking health, exact series, and share of AI voice" width="49%">
</p>

## How it works

1. **Write buyer questions.** Each buying job gets several paraphrases, because rewording alone drops
   brand overlap to 14–29% versus 50–61% on identical reruns
   ([arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)). You approve the exact prompts before
   anything runs.
2. **Measure repeatedly.** Sample direct APIs (with opt-in web search) or signed-in `Codex`,
   `Claude Code`, and `Antigravity` CLIs. Every route, model, and search policy stays its own series.
3. **Read the receipts.** Search queries, returned URLs, and final citations are kept separate, so you
   can see where a third-party page was cited instead of yours.
4. **Ship a fix and compare.** Log page changes in **Opportunities** and results in **Weekly Review**
   to compare the changed page against an unchanged control page, without claiming causation.

## Local-first

- **Your data stays on your machine.** Live data is in `data/hearsay.db`; the fictional demo is in
  `data/demo/hearsay.db`; website studies are in `.hearsay/<app-id>/`.
- **No hosted fee.** Direct API calls are billed by your providers and quoted before every run.
  Signed-in CLI runs use your existing plan.
- **Export anytime.** HTML/PDF reports (`GET /api/export/report`), outcome CSVs, or the whole
  database as JSON (`GET /api/export`). No telemetry.

## Documentation

- [Methodology](METHODOLOGY.md): confidence intervals, wording vs. rerun variance, and what Hearsay refuses to fake
- [Setup and provider reference](docs/setup-reference.md): search policies, CLI runners, scheduling, MCP, `systemd`, HTTP API
- [Agent skill and website studies](skill/SKILL.md): conversational audits and `.hearsay/<app-id>/` workspaces
- [Evidence report guide](docs/evidence-report.md): search actions, sources, citations, and denominators
- [Opportunities](docs/opportunities.md) and [page comparisons](docs/intervention-comparison.md): from citation gap to shipped change
- [Business outcomes](docs/outcomes.md): lead tracking, control pages, and weekly review exports
- [Security](SECURITY.md) and [Contributing](CONTRIBUTING.md)

---

[MIT License](LICENSE). Not affiliated with OpenAI, Anthropic, Google, or Perplexity. Trademarks belong to their owners.
