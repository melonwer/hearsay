# Setup, Providers & API Reference

This guide covers environment configuration, direct API search policies, subscription CLI runners, MCP integration, background services, and HTTP endpoints for Hearsay. For conceptual design and statistical rules, see [Methodology](../METHODOLOGY.md).

## Runtime, Ports & Workspace Paths

- **Requirements:** [Node.js ≥ 22.13](https://nodejs.org) (uses built-in `node:sqlite` — zero `npm install` or external database needed).
- **Port selection:** `node server.js` binds to `127.0.0.1` on an available ephemeral port (`PORT=0` by default) and writes the active port to `data/hearsay.port`. Set `PORT=3100 node server.js` only when a local reverse proxy needs a fixed port.
- **Common startup errors:**
  - `command not found: node` — install Node.js LTS (≥ 22.13) from [nodejs.org](https://nodejs.org).
  - `ERR_UNKNOWN_BUILTIN_MODULE` — upgrade Node.js to 22.13 or newer.
  - `EADDRINUSE` — another process owns your fixed `PORT`; unset `PORT` or set `PORT=0`.
- **Live vs. Demo workspaces:**
  - **Live workspace:** `data/hearsay.db` and `data/artifacts/` (`HEARSAY_DEMO=0`, default).
  - **Interactive Notewell demo:** `data/demo/hearsay.db` and `data/demo/artifacts/` (`HEARSAY_DEMO=1`).
  - Switch between Demo and Live mode in 1 click from the browser UI (or via `.env`) without deleting either database. Demo mode disables live provider calls and recurring schedules.
  - If a legacy demo database lives at `data/hearsay.db`, set `HEARSAY_DEMO_DB_PATH=./data/hearsay.db` and `HEARSAY_DB_PATH=./data/real/hearsay.db` before restarting; Hearsay refuses to merge or overwrite mismatched databases.
- **Standalone study workspaces:** Agent-led website studies store project state, page captures, drafts, runs, and outcomes in `.hearsay/<app-id>/` inside your project workspace.

## Configuring Routes in Browser or `.env`

You can configure API keys and toggle detected local CLI runners directly in the browser under **`/setup`** or **`/settings`** — Hearsay writes `.env` atomically with `0600` permissions and masks keys in every response. You can also edit `.env` manually (`cp .env.example .env`).

### Subscription & Account CLI Runners

MCP access and measurement execution are separate: connecting an MCP client lets your assistant *operate* Hearsay, while measurement runs only use explicitly enabled CLI routes or direct API keys. Subscription runs strip API key environment variables, use your signed-in plan allowance (which is not unlimited and may incur overage), and are never estimated as USD API spend.

- **Codex CLI (`codex-agent`):**
  ```sh
  codex login && codex login status
  ```
  Enable in `/settings` or set `HEARSAY_CODEX_ENABLED=1` in `.env`. Measures developer/B2B buyer angles through the local Codex CLI (not the consumer ChatGPT web app).
- **Claude Code CLI (`claude-code-agent`):**
  Requires a paid Pro, Max, Team, Enterprise, or Console account.
  ```sh
  claude auth login && claude auth status
  ```
  Enable in `/settings` or set `HEARSAY_CLAUDE_CODE_ENABLED=1` in `.env`. Measures through the local Claude Code CLI (not `claude.ai`).
- **Antigravity CLI (`agy-cli`):**
  Supported in the standalone CLI runtime (`hearsay doctor` / `hearsay run`, profile `agy-search-v2`). Runs in an isolated bubblewrap home with credit overage disabled, extracting completed `search_web` events while preserving tool traces. Replaces Gemini CLI measurement (the Gemini CLI extension installs the Hearsay skill and local runtime only).

### Direct API Providers & Search Policies

Add one or more optional keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `TAVILY_API_KEY`) when you want direct API panels or standalone search collection. Full protocol details live in [Search Provider Contracts](search-provider-contracts.md).

| Route & Default Model | Search Policy Env Var | Behavior, Bounds & Caveats |
| --- | --- | --- |
| **OpenAI API** (`gpt-5.6-luna`) | `HEARSAY_OPENAI_SEARCH_POLICY=off\|auto\|required` | Default `off` uses Chat Completions. `auto` or `required` uses Responses API `web_search`. Hosted search has no enforceable internal per-request call ceiling. |
| **Anthropic API** (`claude-sonnet-5`) | `HEARSAY_ANTHROPIC_SEARCH_POLICY=off\|auto` | `auto` enables basic server-side `web_search_20250305`, bounded to 3 search calls and 1 continuation per target timeout. Confirmed no-search `auto` answers stay comparable. |
| **Gemini API** (`gemini-3.6-flash`) | `HEARSAY_GEMINI_SEARCH_POLICY=off\|auto` | `auto` enables `GenerateContent` Google Search grounding. Renders required Google Search Suggestions in an isolated sandboxed iframe; searched responses omitting Suggestions fail and are suppressed. Search call billing stays partial when unreported. |
| **Perplexity API** (`sonar`) | Built-in (`legacy`) | Preserves `search_results` and final `citations` separately. Exact search query wording is not exposed by Sonar and is marked `unavailable`. |
| **Tavily Search** (Website studies) | `TAVILY_API_KEY` | Optional search collector for standalone studies. Six basic searches/day use 180 credits over 30 days (+ 20-credit diagnostic allowance) within Tavily's 1,000 free monthly credits; strict free mode requires a provider-side cap preventing paid overage. |

### Cost Quotes & Schedule Consent

- **Pre-run quotes:** API runs preview estimated usage (`GET /api/cost/estimate`) from the checked price table in `core/cost.js` (verified 2026-09-24). Search quotes forecast 1 search call per target; quotes are forecasts, not invoices or hard hosted-tool caps. Missing billing quantities remain `unknown` alongside any known USD subtotal.
- **Recurring search consent:** Daily scheduled API runs keep web search `off` until you explicitly confirm `POST /api/search-schedule` with a `target_ceiling` and `quoteId`. Changing the execution profile or exceeding `target_ceiling` suspends scheduled search. Revoke consent anytime with `DELETE /api/search-schedule`.
- **Saved vs. active schedules:** Saving a schedule configuration does not start a background daemon. Check the schedule badge in `/dashboard` or `/settings` (or `hearsay schedule inspect`) to confirm whether collection is active, suspended pending quote consent, or awaiting a host cron job.

## CLI, Plugin Bundles & MCP Setup

### Standalone CLI & Bundles

With Node ≥ 22.13, `node bin/hearsay.js --help` (or `npm link` for `hearsay`) runs agent discovery, bounded panels, website studies, Tavily collection, outcome tracking, and report generation without an HTTP server. See the [CLI Guide](../skill/references/cli.md) and [Website Studies Guide](../skill/references/studies.md).

To build portable skill archives, Codex/Claude plugins, and the Gemini CLI extension locally into `dist/`:

```sh
node scripts/build-bundles.js
node scripts/verify-skill-discovery.js
```

See [Installation, Upgrades & Removal](../skill/references/installation.md) for host-specific install commands.

### Connecting MCP Clients

Register `mcp/server.mjs` from the repository directory (discovers `data/hearsay.port` automatically, or reads `HEARSAY_URL` for fixed/remote deployments):

```sh
codex mcp add hearsay -- node "$PWD/mcp/server.mjs"
claude mcp add -s user hearsay -- node "$PWD/mcp/server.mjs"
```

Restart your assistant session so the tools appear. For **Claude Desktop**, add this entry inside `mcpServers` in `claude_desktop_config.json` (Settings → Developer → Edit Config), replacing `YOUR_PATH` with `pwd`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "hearsay": {
      "command": "node",
      "args": ["YOUR_PATH/mcp/server.mjs"]
    }
  }
}
```

### Linux Background Service

Hearsay never installs background services automatically. To keep the local workbench running across terminal sessions on Linux, follow [Manual systemd User-Service Setup](background-service.md). On restart, Hearsay records missed occurrences as visible gaps rather than spending allowance on automatic catch-up runs.

## HTTP JSON API & Data Exports

All mutating endpoints enforce localhost/same-origin checks (`HOST` defaults to `127.0.0.1`; see [Security](../SECURITY.md)). There is no index document at `/api`.

- **Status & Browser Onboarding:** `GET /api/status`, `GET /api/onboarding/state`, `POST /api/onboarding/providers`, `POST /api/onboarding/mode`
- **Benchmark Setup:** `POST /api/prompts/suggest`, `POST /api/setup/drafts`, `GET /api/setup/drafts/:id/review`, `POST /api/setup/drafts/:id/approve` (see [Benchmark Setup](benchmark-setup.md))
- **Quotes, Runs & Search Schedules:** `GET /api/cost/estimate`, `POST /api/run`, `GET /api/runs/latest`, `POST /api/search-schedule`, `DELETE /api/search-schedule`
- **Series, Evidence & Alerts:** `GET /api/series`, `GET /api/series/summary`, `GET /api/series/evidence?series_id=...&intent_id=...`, `GET /api/answers?series_id=...`, `GET /api/alerts`, `GET /api/summary?days=30` (legacy)
- **Standalone Research Imports:** `POST /api/research/import`, `GET /api/research`, `GET /api/research/:id` (also via `hearsay import <evidence.json> --database /abs/path/hearsay.db`; retains external provenance and never enters native series)
- **Outcomes & Weekly Review:** `POST /api/outcomes`, `POST /api/outcomes/import`, `GET /api/outcomes/export`, `POST /api/ledger`, `GET /api/weekly-review?series_id=...&start=...&end=...`, `GET /api/weekly-review/export`
- **Client Report & Full Backup:**
  - `GET /api/export/report?series_id=...&days=...` — self-contained dark/light/printable HTML B2B client report (`Ctrl+P` → Save as PDF).
  - `GET /api/export` — full JSON backup of all database tables (prompts, runs, answers, evidence, opportunities, interventions, outcomes, ledger; see [Export Schema](export-schema.md)). Back up `data/artifacts/` separately.
