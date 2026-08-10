# Hearsay

**AI visibility tracker for humans and agents.** See how ChatGPT, Claude, Gemini and
Perplexity talk about your brand versus your competitors, with honest statistics, on
your own machine, with your own API keys. Optionally measure the separately labeled
**Codex agent** and **Claude Code agent** surfaces through locally authenticated CLI
subscriptions.

[![CI](https://github.com/melonwer/hearsay/actions/workflows/ci.yml/badge.svg)](https://github.com/melonwer/hearsay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node ≥ 22.13](https://img.shields.io/badge/node-%E2%89%A5%2022.13-brightgreen.svg)](package.json)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-blue.svg)](package.json)
[![MCP built in](https://img.shields.io/badge/MCP-built%20in-8A2BE2.svg)](mcp/server.mjs)

[![Watch the tour](docs/video-poster.png)](docs/hearsay-launch.mp4)

**[Watch the 64-second tour.](docs/hearsay-launch.mp4)**

## What it does

Your customers now ask ChatGPT and Perplexity which product to buy, and you have no
idea what those answers say about you. The tools that can tell you charge $99 to $1,000
a month and give you back a single score with no margin of error.

Hearsay asks your buying questions to ChatGPT, Claude, Gemini and Perplexity on a
schedule, several times each, and counts how often you get mentioned and recommended.
Every rate comes with a margin of error and the number of answers behind it, and it
keeps every answer so you can read the exact text any figure came from. It runs on your
computer.

For developer-tool and technical B2B buyer questions, an explicitly enabled local
Codex agent or Claude Code agent can run the same panel through a signed-in CLI. Those
measurements retain final answers, provider-confirmed web-search events, citations and
redacted event artifacts. They are sibling evidence to API runs, never a blended score,
and they consume the signed-in plan allowance or possible overage.

Hearsay itself is free, but the AI engines are not. You bring your own API key for each
engine you want to measure. An API key is a long password-like string you get by making
a developer account at [OpenAI](https://platform.openai.com),
[Anthropic](https://console.anthropic.com), [Google](https://aistudio.google.com) or
[Perplexity](https://docs.perplexity.ai) and adding a payment method. They bill you per
question asked, usually cents rather than dollars, and one key is enough to start.

## Install it by asking

If you use [Claude Code](https://claude.com/claude-code), a free Anthropic assistant
that runs in a terminal on your own computer and is allowed to run commands, paste this
and it will do the whole setup:

> Install and set up https://github.com/melonwer/hearsay for my brand,
> **[your brand]**, and track it against **[competitor]** and **[competitor]**.
> Skip the demo data. Show me the questions before you save them.

It clones the repo, starts Hearsay, connects itself to it, drafts the buying questions
worth tracking, shows you that list before saving anything, tells you what a run will
cost before spending a cent, and then reports back.

This works because Hearsay speaks MCP (Model Context Protocol), the standard way an AI
assistant plugs into an outside tool. A chat window on a website cannot do this, since
it needs to run commands on your machine.

<details>
<summary>The exact steps, if your assistant gets stuck</summary>

```sh
git clone https://github.com/melonwer/hearsay && cd hearsay
node --version                        # must be 22.13 or newer

# Skip this line when tracking a real brand. It loads a fictional demo universe,
# and its demo brand then blocks setup for a real one.
node scripts/seed.js

cp .env.example .env                  # then put one API key in .env
node server.js > hearsay.log 2>&1 &   # redirect, or a backgrounded server hangs the shell
curl -s http://127.0.0.1:3000/api/status   # repeat until this returns JSON

# -s user registers Hearsay for every session, not just this folder
claude mcp add -s user hearsay -- node "$PWD/mcp/server.mjs"
```

Hearsay's tools appear only after the assistant reconnects. Quit Claude Code and start
it again, then say "carry on setting up Hearsay". If they still do not show up, work
over the JSON API instead, which needs no setup: `GET /api/status`,
`POST /api/setup`, `GET /api/cost/estimate`, `POST /api/run`, `GET /api/runs/latest`,
`GET /api/summary?days=30`, `GET /api/alerts`. There is no index page at `/api`.

Already loaded the demo data and now want to track your own brand? Stop Hearsay, delete
`data/hearsay.db`, and start it again. That clears the fictional brand that would
otherwise block setup.
</details>

## Or install it yourself

**First, install Node.js 22.13 or newer** from [nodejs.org](https://nodejs.org). Pick
the installer for Mac or Windows and click through it. Hearsay needs that version
because it includes the small built-in database it stores your data in, which is why
there is nothing else to install: no extra packages, no build step, no separate
database server.

The lines below go in a terminal, which is the Terminal app on Mac or PowerShell on
Windows. You also need Git ([git-scm.com](https://git-scm.com/downloads)); if you would
rather not install it, use the green **Code → Download ZIP** button at the top of this
page, unzip it, and skip the first line.

```sh
git clone https://github.com/melonwer/hearsay && cd hearsay
node scripts/seed.js && node server.js
```

The window will look like it has frozen. That is Hearsay running. Leave it open and
visit **http://127.0.0.1:3000** in your browser, which is an address on your own
computer, published nowhere. To stop it, click the terminal window and press Ctrl+C.

You are now looking at a fictional demo brand called Notewell, so you can click through
every screen before spending anything.

<details>
<summary>If something goes wrong</summary>

`command not found: node` means Node.js is not installed; get the LTS build from
[nodejs.org](https://nodejs.org). `command not found: git` means Git is missing; on Mac
run `xcode-select --install`, on Windows use [git-scm.com](https://git-scm.com/downloads).
`ERR_UNKNOWN_BUILTIN_MODULE` means your Node is older than 22.13. `EADDRINUSE` means
something else is already using port 3000; run `PORT=3100 node server.js` and use
http://127.0.0.1:3100 instead.
</details>

### Track your own brand

1. Stop Hearsay (Ctrl+C) and delete the file `data/hearsay.db`. That removes the demo
   brand, which would otherwise block your own.
2. In the `hearsay` folder, copy `.env.example` to a new file called `.env`
   (`cp .env.example .env` in the terminal).
3. Open `.env` in any text editor and paste your key after the matching name, for
   example `OPENAI_API_KEY=sk-...`. One key is enough.
4. Run `node server.js` again and open **http://127.0.0.1:3000/setup** in your browser.
   Type that address in; there is no link to it in the menu.

### Connect an AI assistant

Run this from inside the `hearsay` folder. The `$PWD` part fills in the full path for
you, so there is nothing to edit:

```sh
claude mcp add -s user hearsay -- node "$PWD/mcp/server.mjs"
```

For Claude Desktop, open Settings → Developer → **Edit Config**, which opens
`claude_desktop_config.json` for you. Run `pwd` inside the `hearsay` folder to print its
full path, then paste the block below, replacing `YOUR_PATH`. If the file already has an
`mcpServers` section, add the `"hearsay"` entry inside it rather than replacing
everything. Quit Claude Desktop completely and reopen it afterwards.

```json
{ "mcpServers": { "hearsay": { "command": "node", "args": ["YOUR_PATH/mcp/server.mjs"] } } }
```

Now ask it "how's our AI visibility this week?" and it answers from your own
measurements. Eighteen tools cover setup, exploration questions, exact-surface
subscription previews/runs, scheduling, cost quotes, results and alerts. Your
assistant uses its own model to talk to you, so
reading your results does not spend the API keys you gave Hearsay.

There is an optional skill that teaches an assistant the full playbook, including how to
read the numbers honestly. Install it with
`mkdir -p ~/.claude/skills && cp -r skill ~/.claude/skills/hearsay-ai-visibility`, where
`~` means your home folder, or just ask your assistant to install `skill/SKILL.md`.

<!-- TODO: record docs/demo.gif (a real Claude Code session) and embed it here. -->

<p>
  <img src="docs/screenshot-light.png" alt="Hearsay dashboard, light theme, showing share of AI voice with confidence intervals, provider trends and alerts" width="49%">
  <img src="docs/screenshot-dark.png" alt="Hearsay dashboard, dark theme" width="49%">
</p>

Light and dark themes. Clicking any figure opens the answers it was calculated from.

## Why it exists

68% of US Google searches end without a click (SparkToro, June 2026, on January to
April 2026 US clickstream data,
[study](https://sparktoro.com/blog/in-2026-less-than-one-third-of-google-searches-still-send-a-click/)),
and where an AI Overview appears, on more than 20% of searches,
[the share of those searches that produce a click falls by nearly 60%](https://searchengineland.com/google-zero-click-searches-2026-study-479717).
Buying research is moving into AI answers, and the tools that measure it charge by the
piece. Profound's $99/mo entry tier covers ChatGPT only, with Claude, API access and
single sign-on locked behind an Enterprise plan
([pricing](https://www.tryprofound.com/pricing)). Otterly charges $29 to $439/mo extra
just to add Claude ([pricing](https://otterly.ai/pricing/)). Semrush meters $99/mo *per
domain* for 25 prompts ([pricing](https://www.semrush.com/pricing/ai/)). Agencies have
started
[building their own trackers to escape $99 to $1,000/mo pricing](https://digiday.com/marketing/marketers-question-expensive-ai-visibility-tools-as-inconsistent-results-fuel-skepticism/).

Hearsay is a measurement method you can run anywhere. It asks each question repeatedly,
publishes the margin of error, keeps the answers behind every figure, and hands the
whole job to your AI assistant if you would rather not click through a dashboard.

## What you get

Every rate is measured by asking the same question many times and counting, and each one
is published with a margin of error (a Wilson 95% confidence interval) and the number of
answers it came from. A figure resting on fewer than five answers is labelled low
sample.

Questions are grouped into intents, meaning one buying question written several ways.
Hearsay shows you how much the answers move when you ask again, and separately how much
they move when you reword the question. Rewording moves them more, which is why
single-prompt tracking is unstable.

Every answer is stored and searchable, and every metric links to the answers behind it.
The citation gap report shows which websites get cited instead of you, domain by domain,
in the answers where your brand never comes up. Alerts fire when your mentions drop,
when a competitor passes you, and when you win or lose a recommendation, each one
carrying the answers that triggered it.

The cost calculator estimates what a run will cost before it starts and records what it
actually spent afterwards. You pay your model providers directly at their prices.

### What Hearsay refuses to build

It will not give you a single blended "AI visibility score", because one number hides
the uncertainty the tool exists to show you. It will not claim rank positions, because
AI answers change between identical runs, so there is no stable "position 3" to report.
It will not estimate how many people ask a given question, because nobody has that data,
and a made-up figure would corrupt every number sitting next to it. And it will not
write your content, because a measuring instrument that also produces the thing it
measures cannot be trusted about either.

## What it costs to run

Hearsay never quotes a flat price. What you spend depends on how many questions you
track, how many engines you ask, and how many times you ask them, so the built-in
calculator works it out from your own setup before each run and records the real spend
afterwards.

![Hearsay's cost calculator on the Settings page, showing estimated spend from your panel size and actual 30-day token spend](docs/screenshot-cost.png)

## How it compares

Checked against each vendor's public pricing page on 2026-07-26, except the Peec figures,
which come from a [third-party pricing review](https://trakkr.ai/reviews/peec-review/pricing)
of the same date rather than from peec.ai.

| | Hearsay | [Profound](https://www.tryprofound.com/pricing) | [Peec AI](https://trakkr.ai/reviews/peec-review/pricing) | [elmo](https://github.com/elmohq/elmo) |
|---|---|---|---|---|
| Price | Free; you pay your model providers directly | $99/mo entry (ChatGPT only) → $399/mo → Enterprise | $95 to $495/mo, Enterprise custom | Free |
| License | MIT | Proprietary SaaS | Proprietary SaaS | MIT |
| Engines | ChatGPT, Claude, Gemini, Perplexity, all included | Entry tier: ChatGPT only; Claude Enterprise-gated | 3 of 6 engines on self-serve tiers | ChatGPT, Claude, Perplexity, Gemini, AI Overviews |
| Margin of error | Wilson 95% intervals, plus rerun and rewording spread reported separately | None published | None published | None |
| Stored answers | Every answer kept, searchable, linked from every metric | Answer-engine responses on paid tiers | Prompt-level views on paid tiers | Stores responses |
| Assistant access | MCP and JSON API built in, free; can read and change your setup | API on Enterprise only | API and MCP as higher-tier add-ons | None |
| What you install | Two commands, nothing else, all data in one file (`git clone` plus `node server.js`) | Nothing, it is hosted | Nothing, it is hosted | Container and database software first (Docker Compose, Postgres, pg-boss) |

## Methodology

Three things worth knowing before you read any number, from
[METHODOLOGY.md](METHODOLOGY.md) (also served at `/methodology`):

Reword a question and the two answers overlap in only 14% to 29% of the brands they
recommend. Ask the identical question twice and the overlap is 50% to 61%
([arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)). So Hearsay asks each question
several ways and shows you both numbers.

Answers from the APIs are not the same as what a logged-in person sees in the ChatGPT
app. They have no memory of the user, no personalisation and none of the hidden
instructions the consumer apps add. Treat them as a directional baseline. No amount of
extra sampling fixes this.

The channel is still small. Under 0.2% of e-commerce visits come from AI tools
([organicllm.org](https://organicllm.org)), though complex, considered purchases run
several times higher. Hearsay's costs are built for a channel that size.

## No cloud version, no lock-in

> MIT licensed, one license, with no separate paid edition and no gated features.
> Everything in this repo is everything there is, and no hosted version is planned.
> Hearsay collects nothing about you and sends nothing anywhere: the only things it ever
> contacts are the AI engines you gave it keys for. Your data is a single file at
> `data/hearsay.db` that you can back up by copying it, and opening
> **http://127.0.0.1:3000/api/export** downloads all of it, questions, runs, answers and
> metrics, as one JSON file.

## Roadmap

v1.1 brings pushed alerts first, using webhooks, so a drop in mentions can fire straight
into Slack or email. Then multi-client workspaces with white-label HTML and PDF reports,
opt-in sentiment scoring that uses your existing keys, CSV export, and a Docker image
for people who want one.

v1.2 adds Google AI Overviews per question through an optional search API, more engines
(Grok, DeepSeek, Copilot), and shared prompt packs from the community. v2 adds trend
annotations, so you can mark the day you shipped the comparison page.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers the no-dependencies rule, how to run the
tests, and where the good first issues are. [SECURITY.md](SECURITY.md) covers the
localhost default, how API keys are handled, and how to report a vulnerability.

Not affiliated with OpenAI, Anthropic, Google or Perplexity; trademarks belong to their
owners.

[MIT](LICENSE).
