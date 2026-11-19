# Setup, Providers & API Reference

This guide covers environment configuration, the zero-key `hearsay check` CLI, direct API search policies, BYOK DataForSEO setup, geolocation, hard monthly USD spend caps, subscription CLI runners, white-label HTML Evidence Dossier exports, unattended GitHub Actions weekly waves, MCP integration, background services, and HTTP endpoints for Hearsay. For conceptual design and statistical rules, see [Methodology](../METHODOLOGY.md).

## Runtime, Ports & Workspace Paths

- **Requirements:** [Node.js ≥ 22.13](https://nodejs.org) (uses built-in `node:sqlite`, plus the strict 2-package pure-JS extraction allowlist `webforai` + `diff` with built-in zero-dependency fallbacks — no external database needed).
- **Starting the dashboard:** Run `npx @melonwer/hearsay serve` (or `node server.js` from a checkout). Supports `--port PORT` and `--host HOST`.
- **Port selection:** `node server.js` binds to `127.0.0.1` on an available ephemeral port (`PORT=0` by default) and writes the active port to `data/hearsay.port`. Set `PORT=3100 node server.js` (or `hearsay serve --port 3100`) only when a local reverse proxy needs a fixed port.
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

## Zero-Key Site Pre-Flight Audit (`hearsay check <url>`)

Run a zero-key technical AI crawlability, Bot-vs-Human diff, and multi-page site audit without starting the server or configuring API keys:

```sh
npx @melonwer/hearsay check https://example.com
# Compare against competitors + render side-by-side Bot-vs-Human HTML report:
node bin/hearsay.js check https://example.com --vs https://competitor1.com https://competitor2.com --browser --html preflight.html
# CI quality gate + baseline regression diff (exits 10 on failure):
node bin/hearsay.js check https://example.com --fail-on critical --baseline baseline.json --fail-on-regression --json
```

| Flag | Default | Purpose |
| --- | --- | --- |
| `--single` / `--no-crawl` | off (multi-page crawl) | Isolate the audit to just the single requested URL instead of discovering key pages from sitemaps and nav. |
| `--max-pages N` | `15` | Maximum number of template-diverse pages to audit in multi-page mode (positive integer). |
| `--vs URL [URL...]` | unset | Run parallel bounded audits on one or more competitor URLs and produce the Competitor X-Ray matrix (repeatable `--vs A --vs B` or space-separated `--vs A B`). |
| `--browser` / `--render` | off | Optionally render the final URL in local headless Chromium, Google Chrome, or Playwright to produce a side-by-side Bot-vs-Human Markdown diff (missing headings, dropped paragraphs, lost tables/code blocks, Prose Parity %). Gracefully reports `status: "unavailable"` if no local browser binary is present. |
| `--check-caching` | off | Perform 1 conditional GET (`If-None-Match` / `If-Modified-Since`) on the homepage to verify live HTTP `304 Not Modified` support. |
| `--ignore-robots-for-own-site` | off | Audit `robots.txt`-disallowed pages on your own site while still explicitly flagging them (by default disallowed pages are listed in `skipped` and never marked PASS). |
| `--fail-on critical\|attention` | unset | CI quality gate severity threshold; exits with code `10` when matching non-ignored findings occur (or if `0` pages were audited). |
| `--fail-on-code RULE` | unset | Repeatable CI gate rule ID to fail on (exits `10`). |
| `--ignore-code RULE` | unset | Repeatable rule ID to ignore in CI gate evaluation (takes strict precedence over `--fail-on` and `--fail-on-code`). |
| `--baseline FILE` | unset | Compare the current audit against a prior `--json` baseline report (`O(N)` URL-indexed diff with a 20% word-count noise floor). Prints a loud `WARNING` on stderr if `FILE` does not exist. |
| `--fail-on-regression` | off | Exit with code `10` when `--baseline` comparison detects new critical findings, HTTP status regressions, Prose Parity drops, newly blocked bots, new soft-404s, or a newly triggered Hard Gate. |
| `--json` | off (text report) | Output the structured `SiteCheckV2Report` JSON object to stdout (for CI pipelines, `--baseline` snapshots, or agent parsing). |
| `--html FILE` | unset | Write a self-contained printable HTML pre-flight report (with side-by-side Bot-vs-Human diff, visual truncation budget bars, 18-bot matrix, template clusters, remediation cards, and Competitor X-Ray) to `FILE`. |
| `--timeout MS` | `10000` | Positive per-request HTTP timeout in milliseconds. |
| `--allow-private` / `--allow-private-hosts` | off | Opt-in override for auditing `localhost` or private-network staging servers. By default, Hearsay's per-hop SSRF guard blocks loopback, RFC 1918, link-local/metadata, and DNS-resolved private IPs on the initial URL and every redirect hop. |

**Honest User-Agent & WAF notice:** `hearsay check` sends `HearsaySiteCheck/0.1` and never spoofs AI crawler User-Agents. It evaluates `<origin>/robots.txt` per RFC 9309 across 18 canonical AI & search crawlers plus 3 policy signals (`Google-Extended`, `Applebot-Extended`, `__usage_ai-training`), detects Cloudflare Managed Content overrides and `Content-Signal` / `Content-Usage` conflicts, fingerprints stacks/CDNs/WAFs passively (cookie names only — never values), probes `Accept: text/markdown` and `Vary: Accept` hygiene, measures UTF-8 byte offsets and Payload-to-Prose / Next.js RSC bloat, groups issues by URL template, emits stack-specific copy-paste remediation recipes, and explicitly discloses that IP/rDNS-authenticated CDN/WAF rules (Cloudflare, Akamai, Fastly) must be verified in CDN or origin access logs.

## Configuring Routes in Browser or `.env`

You can configure API keys, BYOK DataForSEO credentials, geolocation, spend caps, and local CLI runners directly in the browser under **`/setup`** or **`/settings`** — Hearsay writes `.env` atomically with `0600` permissions and masks secrets in every response. You can also edit `.env` manually (`cp .env.example .env`). Real environment variables take precedence over `.env`.

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
| **OpenAI API** (`gpt-5.6-luna`) | `HEARSAY_OPENAI_SEARCH_POLICY=off\|auto\|required` | Default `off` uses Chat Completions. `auto` or `required` uses Responses API `web_search` (and forwards `user_location` when `HEARSAY_LOCATION_COUNTRY` or `HEARSAY_LOCATION_CITY` is set). Hosted search has no enforceable internal per-request call ceiling. |
| **Anthropic API** (`claude-sonnet-5`) | `HEARSAY_ANTHROPIC_SEARCH_POLICY=off\|auto` | `auto` enables basic server-side `web_search_20250305`, bounded to 3 search calls and 1 continuation per target timeout. Confirmed no-search `auto` answers stay comparable. |
| **Gemini API** (`gemini-3.6-flash`) | `HEARSAY_GEMINI_SEARCH_POLICY=off\|auto` | `auto` enables `GenerateContent` Google Search grounding. Renders required Google Search Suggestions in an isolated sandboxed iframe; searched responses omitting Suggestions fail and are suppressed. Search call billing stays partial when unreported. |
| **Perplexity API** (`sonar`) | Built-in (`legacy`) | Preserves `search_results` and final `citations` separately. Exact search query wording is not exposed by Sonar and is marked `unavailable`. |
| **Tavily Search** (Website studies) | `TAVILY_API_KEY` | Optional search collector for standalone studies. Six basic searches/day use 180 credits over 30 days (+ 20-credit diagnostic allowance) within Tavily's 1,000 free monthly credits; strict free mode requires a provider-side cap preventing paid overage. |

### Unverified Model Opt-In (`HEARSAY_ALLOW_UNVERIFIED_MODELS`)

By default (`HEARSAY_ALLOW_UNVERIFIED_MODELS=0`), web-search API routes enforce Hearsay's validated models (`gpt-5.6-luna`, `claude-sonnet-5`, `gemini-3.6-flash`) and reject custom `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `GEMINI_MODEL` overrides with a `RangeError`.

Set `HEARSAY_ALLOW_UNVERIFIED_MODELS=1` (in `.env` or `/settings`) to explicitly opt into running newer or unvalidated models on web-search API routes. Hearsay flags those budgets with `unverifiedModelWarning: true`. If you switch to a model outside `core/cost.js`'s checked price table, also set `HEARSAY_PRICE_<PROVIDER>_IN` and `HEARSAY_PRICE_<PROVIDER>_OUT` (USD per 1M tokens) so pre-run quotes and spend tracking stay priced rather than `unpriced`.

### BYOK DataForSEO (`google-aio` & `chatgpt-web`)

Hearsay supports Bring-Your-Own-Key **DataForSEO v3** integration (`core/providers/dataforseo.js`, registered under `OPTIONAL_PROVIDERS` separately from the core 4-provider API series):

```ini
DATAFORSEO_LOGIN=you@example.com
DATAFORSEO_PASSWORD=your-api-password
```

- **Secrets hygiene:** Credentials travel strictly in the HTTP `Authorization: Basic ...` header, are saved to `.env` with `0600` permissions when configured via `/settings`, are scrubbed from all error messages and logs, and are never persisted to SQLite or returned unmasked in any API/UI response.
- **Two explicit surfaces:**
  - `google-aio` (`POST https://api.dataforseo.com/v3/serp/google/organic/live/advanced` with `load_async_ai_overview: true`, `expand_ai_overview: true`): captures Google AI Overview text and native citations alongside organic SERP `source_observations`. When Google returns no AI Overview (including task status `40102`), Hearsay cleanly returns `noAioPresent: true` and `answerStatus: 'empty'`.
  - `chatgpt-web` (`POST https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced` with `web_search: true` default): captures ChatGPT web answer text, fan-out search queries, returned sources, and native citations.
- **Pre-wave health canary:** Before committing a full wave, run the 1-request zero-retry health check (`POST /api/dataforseo/health` with `{ "mode": "google-aio" | "chatgpt-web" }`, or click **Test DataForSEO Health** in `/settings`, or call `checkDataForSeoHealth()` directly). It sends a minimal probe (`"weather"` by default) and returns `{ ok, mode, statusCode, latencyMs, costUsd, error }` with credentials scrubbed.

### Geolocation & Language Control

Leave all geo variables unset to keep `location_control=uncontrolled` and `language_control=uncontrolled` (default). When set, Hearsay records deterministic `location_control` metadata in execution profiles so geo-targeted runs never silently blend with uncontrolled series:

| Env Var | Example | Effect |
| --- | --- | --- |
| `HEARSAY_LOCATION_CODE` | `2840` | Numeric DataForSEO `location_code` (e.g. `2840` = United States; defaults to `2840` on direct DataForSEO calls if unset). Recorded as `location_code:2840`. |
| `HEARSAY_LOCATION_COUNTRY` | `US`, `GB` | ISO country code (normalized to uppercase). Forwarded to OpenAI Responses `web_search.user_location.country` when search is enabled, and recorded in `location_control`. |
| `HEARSAY_LOCATION_CITY` | `London` | Optional city name. Forwarded to OpenAI Responses `web_search.user_location.city` when search is enabled, and recorded in `location_control`. |
| `HEARSAY_LANGUAGE_CODE` | `en` | Optional language code (defaults to `en` on direct DataForSEO calls). Forwarded to DataForSEO `language_code` and recorded as `lang:<code>`. |

### Cost Quotes, Hard Monthly USD Spend Cap & Schedule Consent

- **Pre-run quotes:** API runs preview estimated usage (`GET /api/cost/estimate`) from the checked price table in `core/cost.js` (verified 2026-09-24). Search quotes forecast 1 search call per target; quotes are forecasts, not invoices. Missing billing quantities remain `unknown` alongside any known USD subtotal.
- **Hard monthly USD spend cap (`HEARSAY_MONTHLY_USD_CAP`):** Unset by default (no cap). Set to a positive number (e.g. `HEARSAY_MONTHLY_USD_CAP=25`) in `.env`, CI, or `/settings` to enforce a hard UTC calendar-month USD kill-switch across all live (non-seeded) API runs:
  - Sums live `responses` spend in the current UTC month (`cost_usd`, falling back to `cost_known_subtotal_usd` and `reported_charge_usd`; seeded demo runs are always excluded).
  - **Pre-run gate:** refuses to start with `spend_cap_exceeded` (`SpendCapExceededError`) if current UTC month spend plus the run estimate exceeds `HEARSAY_MONTHLY_USD_CAP`.
  - **Mid-run gate:** stops remaining calls mid-wave and marks skipped calls with `error = 'spend_cap_exceeded'` if accumulated spend reaches the cap.
  - Inspect live month-to-date spend and remaining budget anytime via `GET /api/spend-cap` or `/settings`.
- **Recurring search consent:** Daily scheduled API runs keep web search `off` until you explicitly confirm `POST /api/search-schedule` with a `target_ceiling` and `quoteId`. Changing the execution profile or exceeding `target_ceiling` suspends scheduled search. Revoke consent anytime with `DELETE /api/search-schedule`.
- **Saved vs. active schedules:** Saving a schedule configuration does not start a background daemon. Check the schedule badge in `/dashboard` or `/settings` (or `hearsay schedule inspect`) to confirm whether collection is active, suspended pending quote consent, or awaiting a host cron job.

## Unattended Weekly Waves in GitHub Actions

Hearsay ships an opt-in GitHub Actions workflow at [`.github/workflows/hearsay-wave.yml`](../.github/workflows/hearsay-wave.yml) for unattended weekly forensics waves without running a persistent server:

- **Safe by default for forks:** Triggered via `workflow_dispatch` with inputs for `search_policy` (`auto` | `required` | `off`), `max_monthly_usd` (enforced via `HEARSAY_MONTHLY_USD_CAP`, default `15`), optional `site_url`, `samples`, and optional `brand_label`. The weekly `schedule` cron (`0 7 * * 1`) is commented out by default so forks never unexpectedly incur API charges; uncomment it only after configuring secrets and verifying a manual dispatch.
- **Required secrets (configure at least one provider key):** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, plus optional BYOK `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`.
- **Optional repository variables:** `HEARSAY_SITE_URL`, `HEARSAY_LOCATION_CODE`, `HEARSAY_LOCATION_COUNTRY`, `HEARSAY_LOCATION_CITY`, `HEARSAY_LANGUAGE_CODE`.
- **Artifacts uploaded via `actions/upload-artifact@v4`:** `artifacts/evidence-dossier.html` (self-contained HTML Evidence Dossier), `artifacts/site-check.html` & `artifacts/site-check.json` (when `site_url` / `HEARSAY_SITE_URL` is provided), `artifacts/export.json` (full database JSON export), `artifacts/hearsay.db` (WAL-checkpointed SQLite snapshot), plus `wave-quote.json` and `wave-summary.json`.

## CLI, Plugin Bundles & MCP Setup

### Standalone CLI & Bundles

With Node ≥ 22.13, `npx @melonwer/hearsay --help` or `node bin/hearsay.js --help` (or `npm link` for global `hearsay`) runs zero-key pre-flight audits (`hearsay check`), the local dashboard (`hearsay serve`), agent discovery, bounded panels, website studies, Tavily collection, outcome tracking, and report generation. See the [CLI Guide](../skill/references/cli.md) and [Website Studies Guide](../skill/references/studies.md).

To build portable skill archives, Codex/Claude plugins, and the Gemini CLI extension locally into `dist/`:

```sh
node scripts/build-bundles.js
node scripts/verify-skill-discovery.js
```

See [Installation, Upgrades & Removal](../skill/references/installation.md) for host-specific install commands.

### Connecting MCP Clients

Register `mcp/server.mjs` from the repository directory (discovers `data/hearsay.port` automatically, or reads `HEARSAY_URL` for fixed/remote deployments; `hearsay_site_check` runs directly with zero server running, and `hearsay_retrieval_attrition`, `hearsay_memory_vs_search`, and `hearsay_citation_persistence` fall back to reading the local SQLite database directly when `server.js` is not running):

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

- **Status, Settings & Browser Onboarding:** `GET /api/status`, `GET /api/settings`, `POST /api/settings`, `GET /api/spend-cap`, `POST /api/dataforseo/health`, `GET /api/onboarding/state`, `POST /api/onboarding/providers`, `POST /api/onboarding/mode`
- **Site Pre-Flight & Forensics:**
  - `POST /api/site-check` — zero-key technical pre-flight audit (`{ url, browser?, timeoutMs? }`, SSRF-guarded by default).
  - `GET /api/forensics/attrition` — Retrieved-but-Dropped attrition & Own-Site Hijack report (`surface`, `provider`, `model`, `search_policy`, `run_id`, `include_seeded`).
  - `GET /api/forensics/memory-vs-search` — Paired Parametric Memory vs. Grounded Retrieval delta (`surface`, `provider`, `model`, `run_id`, `include_seeded`).
  - `GET /api/forensics/persistence` — Multi-Wave Citation Persistence & Off-Site Targets (`surface`, `provider`, `model`, `search_policy`, `run_id`, `include_seeded`).
- **Benchmark Setup:** `POST /api/prompts/suggest`, `POST /api/setup/drafts`, `GET /api/setup/drafts/:id/review`, `POST /api/setup/drafts/:id/approve` (see [Benchmark Setup](benchmark-setup.md))
- **Quotes, Runs & Search Schedules:** `GET /api/cost/estimate`, `POST /api/run`, `GET /api/runs/latest`, `POST /api/search-schedule`, `DELETE /api/search-schedule`
- **Series, Evidence & Alerts:** `GET /api/series`, `GET /api/series/summary`, `GET /api/series/evidence?series_id=...&intent_id=...`, `GET /api/answers?series_id=...`, `GET /api/alerts`, `GET /api/summary?days=30` (legacy)
- **Standalone Research Imports:** `POST /api/research/import`, `GET /api/research`, `GET /api/research/:id` (also via `hearsay import <evidence.json> --database /abs/path/hearsay.db`; retains external provenance and never enters native series)
- **Outcomes & Weekly Review:** `POST /api/outcomes`, `POST /api/outcomes/import`, `GET /api/outcomes/export`, `POST /api/ledger`, `GET /api/weekly-review?series_id=...&start=...&end=...`, `GET /api/weekly-review/export`
- **White-Label Evidence Dossier & Full Backup:**
  - `GET /api/export/report?series_id=...&days=...` — self-contained dark/light/printable HTML Evidence Dossier (`Ctrl+P` → Save as PDF) with Wilson 95% CIs, Mention vs. Citation vs. Recommendation separation, retrieval attrition, own-site hijacks, memory-vs-search delta, and multi-wave off-site targets. Supports optional white-label query parameters:
    - `brand_label` — custom agency or client title shown in the report header (strictly HTML-escaped; defaults to Hearsay branding when omitted).
    - `accent_color` — custom hex accent color strictly validated against `/^#[0-9a-fA-F]{3,8}$/` (invalid values are rejected/ignored to prevent CSS injection).
    - `footer_note` — custom report footer line (strictly HTML-escaped).
  - `GET /api/export` — full JSON backup of all database tables (prompts, runs, answers, evidence, opportunities, interventions, outcomes, ledger; see [Export Schema](export-schema.md)). Back up `data/artifacts/` separately.
