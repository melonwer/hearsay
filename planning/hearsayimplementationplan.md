# Hearsay — Implementation Plan v1.1

**Open-source, self-hosted AI visibility tracker — for humans and agents.**
*Know what the AIs are saying about you.*

This document is a complete, self-contained build specification. It is written to be executed by a swarm of coding agents with an orchestrator. Every contract an agent needs — schemas, function signatures, API shapes, design tokens, copy, thresholds — is in this file.

---

## 0. How to use this document (orchestrator instructions)

- **Phases are in §19.** Phase 0 is serial (one agent). Phase 1 has four parallel lanes with interface contracts defined here — lanes may not change a contract without orchestrator sign-off. Phases 2–3 are serial integration/polish.
- **Conflict resolution order:** this document → the Guardrails (§19.6) → ask the human. Agents must not invent features, pages, dependencies, or colors not specified here.
- **Items marked `[VERIFY-AT-BUILD]`** are facts that drift over time (model names, MCP protocol version). The implementing agent must check current official docs at build time and use the current value, keeping the env-override mechanism intact.
- **Definition of done** for every phase is a checklist in §19. The final acceptance gate is §19.5.

---

## 1. Product brief

### 1.1 One-liner

> **Hearsay** — the AI visibility tracker built for humans *and* agents. See how ChatGPT, Claude, Gemini and Perplexity talk about your brand vs. competitors — statistically honest numbers, on your own box (`node server.js`, zero dependencies, your own API keys), queryable from any agent via MCP.

**Positioning rule (binding for all copy):** Hearsay is never pitched as "an open-source alternative to Profound/Peec/Otterly." That framing is demonstrably dead — every OSS project that led with it converted at 2–22 stars and 2–4 HN points (§20.2). The pitch is: *a measurement methodology you can run anywhere, that your agent can use.*

### 1.2 Why this exists (the evidence — verified 2026-07-26, see `hearsaydemandresearch.md` for full citations)

- 68% of Google searches end without a click (68.01%, US, [SparkToro, 2026](https://sparktoro.com/blog/in-2026-less-than-one-third-of-google-searches-still-send-a-click/)); where an AI Overview appears (20%+ of searches), [CTR falls nearly 60%](https://searchengineland.com/google-zero-click-searches-2026-study-479717). Buying research is moving into AI answers.
- Commercial trackers are expensive **and metered**: Profound's $99/mo entry is ChatGPT-only with Claude/API/SSO Enterprise-gated ([pricing](https://www.tryprofound.com/pricing)); Otterly charges $29–$439/mo extra just for Claude as an engine add-on ([pricing](https://otterly.ai/pricing/)); Semrush meters $99/mo *per domain* for 25 prompts. [Digiday](https://digiday.com/marketing/marketers-question-expensive-ai-visibility-tools-as-inconsistent-results-fuel-skepticism/) reports agencies building in-house trackers specifically to escape $99–$1,000/mo pricing.
- Buyers now ask for exactly what incumbents hide: "Which tools give you repeatable data across the same prompt sets instead of wrapping random outputs into one visibility score?" ([r/content_marketing, July 2026](https://www.reddit.com/r/content_marketing/comments/1v1uf10/how_are_you_measuring_ai_search_visibility/)). Practitioners measure 20–30% run-to-run variance themselves; [SparkToro's 2,961-prompt study](https://sparktoro.com/blog/new-research-ais-are-highly-inconsistent-when-recommending-brands-or-products-marketers-should-take-care-when-tracking-ai-visibility/) confirms the inconsistency.
- Existing OSS attempts validate the need but not the old pitch: the closest clone (elmo — Docker+Postgres, no statistics) stalled as a solo project despite a year of work, while the traction that DOES exist in this niche is agent-shaped — skills and CLIs outperform dashboards several-fold (§20.2). **Never cite star counts as market evidence** — they are noise in this niche (§19.6).
- 2026 meta-patterns this project rides, in priority order: agent-native surfaces (MCP servers + skills), zero-dependency operational simplicity (the Plausible/Umami self-host launch pattern), BYO-API-key economics.

### 1.3 Positioning & differentiation (priority order — this is also the README order)

1. **Agent-native, first-class.** The MCP server, agent skill and headless CLI are co-headline features, not appendices: "how's our AI visibility this week?" answered inside Claude Code/Desktop or any MCP client. **Consuming Hearsay costs no extra API keys** — your agent brings its own model; keys are only spent on the measurement panel itself. Agent-shaped tools are the only proven ceiling-breaker in this category's launches (§20.2).
2. **Zero dependencies, zero setup.** `node server.js` — no npm install, no build step, no Postgres, no Docker required (Docker offered as convenience only). Node ≥ 22.5 with built-in `node:sqlite`. Verified unclaimed as of 2026-07-26: no existing AI-visibility tracker ships without Docker/Postgres/ClickHouse or a paid data vendor.
3. **Statistical honesty as engineering, not rhetoric.** Repeated sampling with Wilson CIs, **intent-level paraphrase sampling** (§6.6) that separates rerun variance from prompt-phrasing variance, receipts for every number, and documented caveats (METHODOLOGY.md) including what we *refuse* to fake (§1.5). Competitors claim "no black box" rhetorically; Hearsay operationalizes it.
4. **BYOK (bring your own keys).** SaaS tools charge $99+/mo largely to resell LLM calls; Hearsay users pay providers directly. **No flat cost claim anywhere** — the built-in cost calculator (§4.3) shows *your* estimated spend before every run and actual token spend after. All major providers supported for measurement: OpenAI (ChatGPT), Anthropic (Claude), Gemini, Perplexity; more on the roadmap (§20.4).

### 1.4 Target users (dual-track by design)

- **Technical marketers, GTM engineers and AI engineers** — the audience that demonstrably adopts tools in this niche: they come for the MCP server, skill, CLI, JSON API and inspectable methodology.
- **In-house marketers and founders** — they come for the dashboard, plain-language stats, and AI-answer monitoring without a new SaaS line item.
- Agencies tracking many client brands (one instance per client in v1; multi-client + white-label reports promoted to v1.1 — §20.4).
- SEO/GEO practitioners who want receipts (raw answers), not black-box scores.

### 1.5 Non-goals for v1 (explicitly out of scope — do not build)

- No user accounts / auth / multi-tenant (localhost + reverse-proxy guidance instead; SECURITY.md documents this).
- No Google AI Overviews scraping (requires SERP scraping; roadmap via optional SERP API).
- No ML sentiment analysis (v1 ships deterministic "recommendation detection"; LLM-judged sentiment is v1.1, opt-in).
- No email/Slack digests (v1.1: webhook alerts).
- No hosted/cloud offering, no billing, no telemetry of any kind (zero phone-home is a selling point — state it in README).
- **Explicit refusals — features we will not build at any version, stated proudly in the README (each one punished a competitor):** no single blended "AI visibility score" (SparkToro's "one magic score" warning; Semrush score distrust threads); no rank-position claims and no prompt-volume estimates ("Nobody knows. SEMRush doesnt know what people actually prompt or the volume" — r/SEO moderator); no content generation (the HN "slop" revolt that hit Sitefire's launch).

### 1.6 Success criteria for v1.0

- From `git clone` to a live dashboard with demo data in **under 2 minutes**, with zero installs beyond Node.
- With one API key set, a real panel run completes and the dashboard reflects it.
- Agent quickstart works: `claude mcp add hearsay …` then one natural-language question ("how's our AI visibility?") returns real numbers.
- `node --test` fully green; CI green on Node 22 and 24.
- README that makes a stranger star it: screenshots (light+dark), the metered-pricing comparison (§20.1), the 2-command quickstart, and an agent demo GIF.
- **Success metric (defined now, per §20.2 base rates — stars are not the KPI):** 50 weekly-active self-hosted instances, or 10 agencies running it for clients. A 150-star outcome is not failure in a niche whose dashboards top out around 200.

---

## 2. Architecture

### 2.1 Stack decision

- **Runtime:** Node.js ≥ 22.5, single process, ESM (`"type": "module"`). No TypeScript compilation step — **plain modern JavaScript with JSDoc type annotations**, typechecked in CI via `tsc --noEmit` (`checkJs`). Users never build anything.
- **Storage:** built-in `node:sqlite` (`DatabaseSync`). WAL mode. One file: `data/hearsay.db`.
- **HTTP:** built-in `node:http`, hand-rolled router (§10.1). Server-rendered HTML via tagged template literals. A single small vanilla-JS file (`public/app.js`) adds chart tooltips, theme toggle, and fetch-powered actions. No frontend framework.
- **LLM calls:** built-in global `fetch` with `AbortController` timeouts.
- **Tests:** built-in `node:test` + `node:assert`.
- **Zero runtime npm dependencies is a hard constraint** (§19.6). CI may use dev tooling (typescript) fetched on the runner.

Rationale: differentiation ("no node_modules" is rare and memorable), supply-chain safety, and the lowest possible barrier for the marketing audience. Trade-off acknowledged: contributors don't get React ergonomics; mitigated by small, well-named pure modules. If the swarm hits a wall that seems to demand a dependency, the answer is a smaller feature, not a dependency.

### 2.2 File tree (exact)

```
hearsay/
├── server.js                 # entry: boots http server + scheduler
├── package.json              # name, type:module, scripts only — NO dependencies
├── jsconfig.json             # checkJs + strict for CI typecheck
├── .env.example
├── LICENSE                   # MIT
├── README.md
├── METHODOLOGY.md
├── CONTRIBUTING.md
├── SECURITY.md
├── core/
│   ├── config.js             # env parsing, defaults, provider registry
│   ├── db.js                 # open db, migrations, prepared-statement helpers
│   ├── analyze.js            # PURE: mention/recommendation/citation extraction
│   ├── metrics.js            # SOV, rates, Wilson intervals, trends (SQL reads)
│   ├── runner.js             # panel execution engine (concurrency pool)
│   ├── scheduler.js          # daily-time interval scheduler
│   ├── alerts.js             # alert rules engine
│   ├── suggest.js            # intent/paraphrase generator (§6.7) — LLM call + pure post-processing
│   ├── cost.js               # price table [VERIFY-AT-BUILD] + run cost estimator (§4.3)
│   ├── seed.js               # demo universe generator (deterministic)
│   └── providers/
│       ├── index.js          # registry: enabled providers from env
│       ├── shared.js         # timeout, retry, error classification
│       ├── openai.js
│       ├── anthropic.js
│       ├── gemini.js
│       └── perplexity.js
├── web/
│   ├── router.js             # method+path routing, body parsing, guards
│   ├── layout.js             # page shell, nav, theme, esc()/html helpers
│   ├── svg.js                # PURE chart builders: lineChart, barChartH, sparkline, meter
│   ├── pages/
│   │   ├── dashboard.js      # GET /
│   │   ├── answers.js        # GET /answers (explorer)
│   │   ├── prompts.js        # GET /prompts
│   │   ├── entities.js       # GET /entities
│   │   ├── alerts.js         # GET /alerts
│   │   ├── settings.js       # GET /settings
│   │   ├── setup.js          # GET /setup — first-run wizard (§11.8)
│   │   └── methodology.js    # GET /methodology (renders METHODOLOGY.md content)
│   └── api.js                # /api/* JSON handlers
├── public/
│   ├── app.js                # tooltips, theme toggle, sortable tables, run button
│   └── style.css             # design tokens + components (§11)
├── mcp/
│   └── server.mjs            # zero-dep stdio MCP server (§13)
├── skill/
│   └── SKILL.md              # Claude agent skill (§14)
├── scripts/
│   ├── seed.js               # CLI: node scripts/seed.js
│   ├── run-panel.js          # CLI: node scripts/run-panel.js
│   ├── suggest-prompts.js    # CLI: node scripts/suggest-prompts.js "Brand" brand.com (§6.7)
│   └── screenshot.js         # Playwright screenshots for README (dev-only, not shipped as dep)
├── test/
│   ├── analyze.test.js
│   ├── metrics.test.js
│   ├── alerts.test.js
│   ├── providers.test.js
│   ├── router.test.js
│   ├── seed.test.js
│   ├── suggest.test.js
│   ├── cost.test.js
│   ├── e2e.test.js
│   └── fixtures/             # canned provider responses + answer texts
├── docs/
│   ├── screenshot-light.png
│   ├── screenshot-dark.png
│   └── social-preview.png
└── .github/
    └── workflows/ci.yml
```

### 2.3 Data flow

```
scheduler (daily) ─┐
manual button ─────┼─→ runner.runPanel()
API/MCP trigger ───┘        │
                            ├─ for each (active prompt × enabled provider × N samples):
                            │     providers/<p>.runPrompt() ──→ responses row
                            │     analyze.analyzeResponse() ──→ mentions + citations rows
                            ├─ alerts.evaluate(run) ──→ alerts rows
                            └─ run row finalized
dashboard / API / MCP ──→ metrics.js (read-only SQL) ──→ JSON / SSR pages
```

Key invariant: **the seeder writes through the same `analyze()` pipeline as live runs** — demo data exercises the real code path.

---

## 3. Data model

SQLite, WAL mode, `PRAGMA foreign_keys = ON`. All timestamps are UTC ISO-8601 strings (`YYYY-MM-DDTHH:MM:SSZ`). Migrations tracked via `PRAGMA user_version`, applied in order from an array in `db.js`.

```sql
-- migration 1
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON-encoded
);

CREATE TABLE entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  aliases     TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  domains     TEXT NOT NULL DEFAULT '[]',   -- JSON array, e.g. ["notewell.io"]
  is_self     INTEGER NOT NULL DEFAULT 0,   -- exactly one row with is_self=1 (enforced in code)
  created_at  TEXT NOT NULL,
  archived_at TEXT                          -- soft delete; archived entities excluded from metrics
);

CREATE TABLE intents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL UNIQUE,   -- the underlying question, e.g. "best AI meeting notes tool"
  created_at  TEXT NOT NULL
);

CREATE TABLE prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id   INTEGER NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  text        TEXT NOT NULL UNIQUE,   -- one paraphrase of its intent (§6.6)
  category    TEXT NOT NULL DEFAULT 'general',  -- 'branded' prompts excluded from SOV denominators by default (§6.7)
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_prompts_intent ON prompts(intent_id);
-- Creating a prompt without an intent auto-creates a single-paraphrase intent with label = text (enforced in code).

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  trigger      TEXT NOT NULL CHECK (trigger IN ('cron','manual','api','seed')),
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  total_calls  INTEGER NOT NULL DEFAULT 0,
  done_calls   INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE TABLE responses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  prompt_id   INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,               -- 'openai'|'anthropic'|'gemini'|'perplexity'
  model       TEXT NOT NULL,
  sample_idx  INTEGER NOT NULL,            -- 0..N-1
  text        TEXT,                        -- null when error
  latency_ms  INTEGER,
  tokens_in   INTEGER,                     -- from provider usage fields; null when unavailable (§4.3)
  tokens_out  INTEGER,
  cost_usd    REAL,                        -- computed at insert via core/cost.js price table; null if unknown
  error       TEXT,                        -- null on success; else 'auth'|'quota'|'timeout'|'other:<detail>'
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_responses_run ON responses(run_id);
CREATE INDEX idx_responses_time ON responses(created_at);
CREATE INDEX idx_responses_prompt ON responses(prompt_id, provider);

CREATE TABLE mentions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id  INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  entity_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  first_index  INTEGER NOT NULL,           -- char offset of first occurrence in responses.text
  occurrences  INTEGER NOT NULL DEFAULT 1,
  rank         INTEGER NOT NULL,           -- 1 = first entity mentioned in this answer
  recommended  INTEGER NOT NULL DEFAULT 0, -- §6.4 heuristics
  snippet      TEXT NOT NULL               -- ±120 chars context, original casing
);
CREATE INDEX idx_mentions_response ON mentions(response_id);
CREATE INDEX idx_mentions_entity ON mentions(entity_id);

CREATE TABLE citations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id  INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  domain       TEXT NOT NULL,              -- hostname, www-stripped, lowercase
  rank         INTEGER NOT NULL,           -- order of appearance, 1-based
  entity_id    INTEGER                     -- matched via entities.domains, else NULL
);
CREATE INDEX idx_citations_response ON citations(response_id);

CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  run_id      INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('good','warning','serious')),
  type        TEXT NOT NULL,               -- 'LOST_RECOMMENDATION'|'GAINED_RECOMMENDATION'|'OVERTAKEN'|'MENTION_DROP'
  entity_id   INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  prompt_id   INTEGER REFERENCES prompts(id) ON DELETE CASCADE,
  provider    TEXT,
  title       TEXT NOT NULL,               -- human sentence, ≤90 chars
  detail      TEXT NOT NULL,               -- 1-3 sentences with numbers
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_alerts_open ON alerts(acknowledged, created_at);
```

`settings` keys used by v1: `last_scheduled_run_date` (`"2026-07-26"`), `install_id` (random hex, used only to salt nothing — reserved), `theme_default` (unused v1).

---

## 4. Configuration

### 4.1 Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. **Localhost by default, deliberately.** Set `0.0.0.0` to expose (SECURITY.md warns: put a reverse proxy with auth in front) |
| `HEARSAY_DB_PATH` | `./data/hearsay.db` | SQLite location (dir auto-created) |
| `HEARSAY_RUN_AT` | `07:00` | Daily panel run, local server time, `HH:MM` |
| `HEARSAY_SAMPLES` | `3` | Samples per prompt per provider per run (1–10) |
| `HEARSAY_CONCURRENCY` | `2` | Parallel in-flight LLM calls |
| `HEARSAY_TIMEOUT_MS` | `45000` | Per-call timeout |
| `HEARSAY_DEMO` | `0` | `1` = demo mode: auto-seed if DB empty, disable live calls + scheduler, show demo banner |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — / `[VERIFY-AT-BUILD]` (e.g. `gpt-5-mini`) | ChatGPT provider |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `[VERIFY-AT-BUILD]` (e.g. `claude-sonnet-4-5`) | Claude provider |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `[VERIFY-AT-BUILD]` (e.g. `gemini-2.5-flash`) | Gemini provider |
| `PERPLEXITY_API_KEY` / `PERPLEXITY_MODEL` | — / `sonar` `[VERIFY-AT-BUILD]` | Perplexity (native citations) |

Rules: a provider is **enabled iff its key is non-empty**. Zero enabled providers + demo off → dashboard shows the "add a key" empty state; the app still runs. `.env` is loaded by a tiny built-in parser in `config.js` (read `.env` if present, `KEY=VALUE` lines, no quotes processing beyond trimming — document limitation) since dotenv is a dependency we don't take.

### 4.2 config.js exports

```js
export const config = { port, host, dbPath, runAt, samples, concurrency, timeoutMs, demo }
export const providers = [ { id:'openai', label:'ChatGPT', model, enabled }, … ]  // stable order: openai, anthropic, gemini, perplexity
export function estimateRunCalls(promptCount) // prompts × enabledProviders × samples
```

### 4.3 Cost calculator (`core/cost.js`) — replaces every flat cost claim

Real-world DIY cost estimates in the research span $0.40/week to $75–200/mo depending on sampling design; a hardcoded "$X/mo" claim from the honesty-positioned product would be fatal (and a live cost estimator is an open feature request in the closest OSS competitor). So Hearsay computes, never asserts:

- **Price table:** `core/cost.js` ships per-Mtoken prices for the default models `[VERIFY-AT-BUILD]`, env-overridable (`HEARSAY_PRICE_<PROVIDER>_IN/_OUT`).
- **Pre-run estimate:** `estimateRunCost()` = active prompts × enabled providers × samples × (assumed ~200 tokens in / ~500 out `[VERIFY-AT-BUILD]` vs seed medians) × price. Shown on the Settings page, in the /setup wizard, and in the run button's confirm step when estimate > $1 or > 200 calls.
- **Actual spend:** adapters record provider `usage` token counts into `responses.tokens_in/tokens_out/cost_usd`; dashboard KPI subtitle and Settings show 30d actual spend.
- **Copy rule (binding):** README and UI never print a flat dollar figure without the sampling design attached; the README cost section is a screenshot of the calculator plus one sentence.

---

## 5. Provider adapters

### 5.1 Common contract (`core/providers/shared.js`)

```js
/**
 * @typedef {Object} ProviderResult
 * @property {string} text
 * @property {{input:number,output:number}} [tokens]  // from the provider's usage field when present (§4.3)
 * @property {string} model            // actual model echoed by API when available
 * @property {number} latencyMs
 * @property {{url:string}[]} [citations]  // only providers with native citations
 */
/** @typedef {'auth'|'quota'|'timeout'|'other'} ProviderErrorKind */
export class ProviderError extends Error { kind; detail; }
export async function fetchWithRetry(url, init, { timeoutMs, retries = 1 }) // AbortController; retry once on 429/5xx/network with 2–8s jittered backoff; classify: 401/403→auth, 429→quota, abort→timeout, else other
```

Each adapter exports `async runPrompt(text, { model, timeoutMs }) → ProviderResult`.

**Methodology-critical:** send the prompt as a single user message. **No system prompt, no temperature override** — provider defaults, to stay closest to "what a user with default settings gets." (Caveat documented in METHODOLOGY.md: API answers approximate, not equal, consumer-app answers — consumer apps add hidden system prompts, tools, and web search.)

### 5.2 Endpoints (all `[VERIFY-AT-BUILD]` for exact model names & versions)

| Provider | Request | Response text | Citations |
|---|---|---|---|
| openai | `POST https://api.openai.com/v1/chat/completions` — `{model, messages:[{role:'user',content:text}]}`, `Authorization: Bearer` | `choices[0].message.content` | from markdown links only |
| anthropic | `POST https://api.anthropic.com/v1/messages` — headers `x-api-key`, `anthropic-version: 2023-06-01`; body `{model, max_tokens:1024, messages:[{role:'user',content:text}]}` | concat of `content[].text` | markdown links only |
| gemini | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` — header `x-goog-api-key`; body `{contents:[{parts:[{text}]}]}` | concat `candidates[0].content.parts[].text` | markdown links only |
| perplexity | `POST https://api.perplexity.ai/chat/completions` — OpenAI-shaped | `choices[0].message.content` | native: `citations` / `search_results` array → `{url}` `[VERIFY-AT-BUILD]` |

Adapter unit tests run against **fixtures** (`test/fixtures/openai.json`, …), never live APIs. A separate opt-in smoke script (`HEARSAY_LIVE_TEST=1 node scripts/run-panel.js --once --prompt "test"`) exists for humans.

---

## 6. Analyzer (`core/analyze.js`) — pure functions, no I/O

### 6.1 Main entry

```js
/**
 * @param {string} text                       raw answer
 * @param {{id:number,name:string,aliases:string[],domains:string[]}[]} entities
 * @param {{url:string}[]} [nativeCitations]
 * @returns {{ mentions: MentionResult[], citations: CitationResult[] }}
 */
export function analyzeResponse(text, entities, nativeCitations = [])
```

### 6.2 Mention detection

1. Build the alias list per entity: `[name, ...aliases]`. Defensively drop aliases < 3 chars (the API layer already rejects them with 422 — §10.3).
2. Sort **all aliases across all entities by length descending**. Match longest-first; a matched span is *consumed* (no overlapping double-counts — "Notewell Pro" beats "Notewell").
3. A match requires word boundaries on both sides: preceding and following char is none of `[A-Za-z0-9]` (string start/end qualify). Case-insensitive. Allow trailing possessive `'s` / `’s`.
4. Escape regex metacharacters in aliases. Run matching on the raw text (not lowercased copy) with the `iu` flags; record `first_index` from the original string.
5. Per entity: `first_index` (min across its aliases), `occurrences` (total consumed matches), `snippet` = 120 chars either side of first match, word-trimmed, `…` ellipses.
6. `rank`: sort mentioned entities by `first_index`; 1-based.

### 6.3 Citation extraction

Sources, merged in order: native citations → markdown links `[label](url)` → bare URLs (`https?://…` regex, trailing punctuation trimmed). Dedupe by URL (first occurrence wins, keeps earliest rank). `domain` = hostname lowercased, `www.` stripped. `entity_id` = the entity whose `domains` array contains the domain or a parent of it (`docs.notewell.io` matches `notewell.io`); ties impossible if API layer rejects duplicate domains across entities.

### 6.4 Recommendation detection (`recommended = 1` if ANY):

- R1 — proximity: an entity match starts within **80 chars after** the end of any trigger phrase: `recommend`, `recommended`, `best`, `top pick`, `top choice`, `i'd suggest`, `i would suggest`, `great choice`, `go with`, `#1`. Case-insensitive.
- R2 — list leadership: the entity's first mention is inside the **first item** of the **first** list in the answer (list item = line matching `/^\s*(?:[-*•]|\d+[.)])\s+/`).
- R3 — short-answer lead: answer < 400 chars AND entity first mentioned in the first sentence.

Deterministic, unit-tested against fixture answers (§15). This is v1's honest substitute for sentiment.

### 6.5 Required unit-test cases (minimum)

Word-boundary negatives ("Notewellness" ≠ "Notewell"); possessives ("Notewell's"); markdown bold ("**Notewell**"); overlap consumption ("Notewell Pro" vs "Notewell"); multi-alias same entity; rank ordering; R1/R2/R3 each positive+negative; citation dedupe; subdomain matching; bare-URL trailing `).,` trim; empty text; entity absent.

### 6.6 Intent-level sampling & variance decomposition (flagship statistical feature)

Rationale: published measurements show cross-paraphrase agreement (0.135–0.288) is far lower than same-prompt rerun agreement (0.50–0.61) ([arXiv:2605.27440](https://arxiv.org/pdf/2605.27440)) — rerun CIs alone shrink the *smaller* error bar, and a sophisticated reviewer will call that out. Hearsay therefore samples at the **intent** level:

- An intent groups N paraphrase prompts (default 3; a lone prompt is an intent with one paraphrase and the UI nudges "add 2 paraphrases for a phrasing-robust number"). The panel runs every active paraphrase × provider × samples — no new runner mechanics, just grouping.
- `metrics.js` reports per-intent **pooled** mention rate with Wilson CI, plus a two-component **variance split**: rerun spread (across samples within a paraphrase) vs phrasing spread (across paraphrase means). UI copy pattern: "58% ± 7 (n=36) · phrasing spread ±19 pts" — the phrasing number is never hidden.
- METHODOLOGY.md explains both components in plain words and states which one dominates (phrasing, per the literature).

### 6.7 Intent & paraphrase generator (`core/suggest.js`)

Solves the #1 stated onboarding blocker ("I don't know which prompts to track" — named by Peec's own PM as the top objection). Input: the brand entity (+ competitors, domains) plus an optional category description or pasted keywords. Uses the **first enabled provider key** to draft 8–12 intents × 3 paraphrases as JSON (strict schema, one retry on parse failure). Pure post-processing (unit-testable, no I/O): dedupe, ≤300 chars, strip numbering, and **tag prompts containing the brand name or its aliases as category `branded`** — branded prompts measure navigational recall, not discovery, and are excluded from SOV denominators by default (toggle in Settings). Nothing auto-saves: the user reviews/edits a checklist before insert. Surfaces: POST /api/prompts/suggest, the /setup wizard (§11.8), and `node scripts/suggest-prompts.js`. With zero keys configured, the flow falls back to a static starter pack (§20.3) — never a dead end.

---

## 7. Metrics (`core/metrics.js`) — read-only SQL, returns plain objects

Window convention: `days` param (default 30) filters `responses.created_at >= now-days` and `error IS NULL`. "Valid responses" always means non-error rows. All functions accept optional `{provider}` filter.

```js
export function mentionRate({entityId, provider?, days}) → {n, mentioned, p, lo, hi}   // Wilson 95%
export function shareOfVoice({days, provider?}) → [{entityId, name, isSelf, mentions, sov}]  // sov = m_e / Σ m; Σ=0 → sov 0
export function sovTrend({days, provider?}) → [{date:'2026-07-01', series:[{entityId, sov, n}]}]  // per UTC day; days with 0 valid responses are OMITTED (gap, not zero)
export function providerBreakdown({days}) → [{provider, n, brandMentionRate:{p,lo,hi}, avgRank, citationShare, lastError}]
export function recommendationRate({entityId, days, provider?}) → {n, recommended, p}
export function avgRank({entityId, days, provider?}) → number|null
export function citationShare({entityId, days}) → {answersWithCitations, brandCited, share}  // perplexity-only in practice
export function promptTable({days}) → [{promptId, text, category, perProvider:[{provider, brandMentionRate, brandRecommended, topEntityName}]}]
export function intentTable({days, provider?}) → [{intentId, label, n, pooled:{p,lo,hi}, rerunSpread, phrasingSpread, paraphraseCount}]  // §6.6; pooled across paraphrases
export function citationGap({days, limit=20}) → [{domain, count, sampleUrl, topPromptId}]  // domains cited in valid answers where the brand is NOT mentioned — "who gets cited instead of you"
export function actualSpend({days}) → {totalUsd, perProvider:[{provider, usd, calls}]}  // Σ responses.cost_usd; null-safe (§4.3)
export function summary({days}) → composite of the above for /api/summary (§10.4 shape)
```

SOV convention update (§6.7): `shareOfVoice`, `sovTrend` and `mentionRate` **exclude prompts with category `branded` by default**; pass `{includeBranded:true}` to override. Branded prompts still appear in promptTable/intentTable, badged.

**Wilson 95% interval** (embed exactly):
```
z = 1.96, p̂ = mentioned/n
center = (p̂ + z²/2n) / (1 + z²/n)
half   = z·√(p̂(1−p̂)/n + z²/4n²) / (1 + z²/n)
lo = max(0, center−half), hi = min(1, center+half); n=0 → {p:null}
```
Test anchor: `mentioned=17, n=50` → `p=0.34, lo≈0.2244, hi≈0.4785` (±0.0002).

Display rule: every rate shown in UI carries `n`; rates with `n < 5` render with a "low sample" badge.

---

## 8. Runner & scheduler

### 8.1 `runner.runPanel({ trigger }) → Promise<RunSummary>`

1. Refuse if a run with `status='running'` exists (in-process mutex + DB check; stale `running` > 2h is marked `failed` at boot).
2. Tasks = active prompts × enabled providers × `samples`. Insert run row with `total_calls`.
3. Concurrency pool of `config.concurrency`; each task: adapter call → insert response (success or error columns) → on success `analyzeResponse()` → insert mentions/citations in one transaction per response → increment `done_calls` every task.
4. Provider-level circuit breaker: after **3 consecutive** `auth` or `quota` errors from a provider within a run, skip its remaining tasks (record error `'skipped:circuit'`).
5. Finalize: `alerts.evaluate(runId)`, set `status='done'` (`'failed'` only if *every* task errored), `finished_at`.
6. In demo mode: `runPanel` throws `DemoModeError` (UI explains).

### 8.2 Scheduler (`core/scheduler.js`)

`setInterval` every 30s: if local `HH:MM === config.runAt` AND `settings.last_scheduled_run_date !== today` → set the setting, then `runPanel({trigger:'cron'})` (catch/log). Disabled when demo mode or zero providers. Boot log line states next run time.

---

## 9. Alert rules (`core/alerts.js`)

Evaluated once per finished run. "Prior runs" = previous non-seed `done` runs. Dedup: skip creating an alert if an identical `(type, entity_id, prompt_id, provider)` alert exists in the last **7 days**.

| Type | Trigger | Severity | Title template |
|---|---|---|---|
| `LOST_RECOMMENDATION` | brand had `recommended≥1` for (prompt, provider) in **each of the 2 previous runs**, and 0 across this run's samples | serious | `Lost recommendation on {provider} for “{prompt…40}”` |
| `GAINED_RECOMMENDATION` | inverse (0 in previous 2 runs, ≥1 now) | good | `Now recommended on {provider} for “{prompt…40}”` |
| `OVERTAKEN` | competitor 7-day SOV > brand 7-day SOV, and was ≤ at the previous run's evaluation | warning | `{competitor} passed you in share of AI voice` |
| `MENTION_DROP` | brand per-provider mention rate this run ≤ previous run − **25 pts**, both runs `n ≥ 3` | warning | `Mentions down {Δ} pts on {provider}` |

`detail` must include the numbers ("3/9 → 0/9 samples", "41% → 46% vs your 38%"). Positive alerts (`good`) render with the success token, not celebration-spam: max 1 `GAINED_*` per (prompt,provider) per 7d via the dedup rule.

---

## 10. HTTP server

### 10.1 Router (`web/router.js`)

- Table of `{method, pattern, handler}`; pattern = exact path or one `:param` segment (`/api/prompts/:id`). Parse with `URL`. 404 JSON/HTML by `Accept`. 405 with `Allow`.
- Body: JSON only, 1 MB cap, reject other content-types on POST/PATCH (415).
- **Same-origin guard on all mutating methods:** if `Origin` header present and its host ≠ request `Host` → 403. (CSRF mitigation without tokens; documented.)
- Static: `/public/*` from disk with correct MIME, `Cache-Control: max-age=3600`, path-traversal guard (resolve + prefix check).
- Security headers on HTML: `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Every HTML interpolation goes through `esc()` (`& < > " '`). `layout.js` exposes `html` tagged template that auto-escapes interpolations unless wrapped in `raw()`.

### 10.2 Pages

`GET /` `/answers` `/prompts` `/entities` `/alerts` `/settings` `/methodology` — SSR per §11. Query params for filters (server-side filtering; no client router).

### 10.3 JSON API (consumed by UI actions + MCP)

Envelope: success → the object itself; error → `{"error":{"code":"string","message":"human"}}` with proper status.

```
GET    /api/summary?days=30        → §10.4
GET    /api/entities               → [{id,name,aliases,domains,is_self,archived_at}]
POST   /api/entities               {name, aliases?, domains?, is_self?}  // enforce single is_self; alias<3 chars rejected 422; domain dupes across entities rejected 409
PATCH  /api/entities/:id           partial
DELETE /api/entities/:id           → soft (archived_at) if it has mentions, else hard delete
GET    /api/prompts                → [{id,intent_id,text,category,active}]
POST   /api/prompts                {text, category?, intent_id?}   // ≤300 chars, unique; no intent_id → auto-create single-paraphrase intent (§3)
PATCH  /api/prompts/:id            {text?, category?, active?, intent_id?}
DELETE /api/prompts/:id            → hard delete if no responses else set active=0 and return {deactivated:true}
GET    /api/intents                → [{id,label,paraphrases:[{id,text,active}]}]
PATCH  /api/intents/:id            {label?}              // delete cascades via prompts; no separate DELETE in v1
POST   /api/prompts/suggest        {category_hint?, keywords?} → {intents:[{label,category,paraphrases:[text]}]}  // §6.7 — DRAFT ONLY, never persists; 400 if no provider key
GET    /api/cost/estimate          → {calls, estUsd, perProvider:[{provider,calls,estUsd}]}   // §4.3
GET    /api/gap?days=30            → citationGap (§7)
POST   /api/run                    → 202 {runId, estUsd} | 409 already running | 400 demo mode
GET    /api/runs/latest            → {id,status,total_calls,done_calls,started_at,finished_at,trigger}
GET    /api/answers?provider&prompt_id&entity_id&days&page&per=20
                                   → {total, page, items:[{id,provider,model,created_at,prompt,text,error,mentions:[{name,first_index,recommended}],citations:[{url,domain,entity_id}]}]}
GET    /api/alerts?open=1          → [{…alert, entityName, promptText}]
POST   /api/alerts/:id/ack         → {ok:true}
GET    /api/export                 → full JSON dump of all tables (data freedom)
```

### 10.4 `/api/summary` exact shape (MCP + dashboard contract)

```json
{
  "brand": {"id":1,"name":"Notewell"},
  "windowDays": 30,
  "generatedAt": "2026-07-26T14:00:00Z",
  "demo": true,
  "sov": {"current":[{"entityId":1,"name":"Notewell","isSelf":true,"sov":0.34,"mentions":210}],
          "delta7d": 0.03},
  "mentionRate": {"p":0.61,"lo":0.55,"hi":0.67,"n":248},
  "recommendationRate": {"p":0.22,"n":248},
  "providers": [{"provider":"perplexity","n":62,"brandMentionRate":{"p":0.71,"lo":0.58,"hi":0.81},
                 "avgRank":1.6,"citationShare":0.23,"lastError":null}],
  "openAlerts": 2,
  "lastRun": {"finishedAt":"2026-07-26T07:04:11Z","status":"done"}
}
```

---

## 11. UI & design system

Follows a validated dataviz method; the tokens below are pre-validated — **agents must not invent or "improve" colors.** If any hex changes, the whole categorical order must be re-validated for color-blind safety, so: don't.

### 11.1 Design tokens (`public/style.css` `:root`)

```css
/* Light (default) */
--page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
--grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,0.10);
--s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100;   /* categorical slots, FIXED order */
--good:#0ca30c; --warn:#fab219; --serious:#ec835a; --critical:#d03b3b;
--good-text:#006300;
/* Dark (prefers-color-scheme + [data-theme=dark], same pattern both scopes) */
--page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
--grid:#2c2c2a; --baseline:#383835; --border:rgba(255,255,255,0.10);
--s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
--good-text:#0ca30c;
```

Typeface: `system-ui, -apple-system, "Segoe UI", sans-serif` everywhere; `font-variant-numeric: tabular-nums` **only** on table columns and axis ticks. Radius 8px cards, 1px `var(--border)` hairlines, page max-width 1140px, sidebar 220px.

**Series-color law:** the brand is ALWAYS `--s1`; competitors get `--s2…--s4` by entity id order, stable across every chart and the leaderboard (color follows entity, never rank). Max 4 series on any chart; extra competitors fold into an "Other" gray (`--muted`) line only if aggregate, otherwise appear in tables only. Text never wears series colors — labels/values use ink tokens with a 10px color chip beside them.

### 11.2 Layout

Left sidebar: wordmark ("Hearsay" text + a 16px ear/soundwave mark, inline SVG), nav (Dashboard, Answers, Prompts, Entities, Alerts *(open-count badge)*, Settings, Methodology), footer block: last-run status line + **Run panel now** button (POST /api/run, then poll `/api/runs/latest`, progress bar `done/total`). Theme toggle (auto/light/dark) top-right; persists in `localStorage`, sets `data-theme` on `<html>`.

Demo mode: persistent top strip, `--warn`-tinted background at 15% + icon + "Demo data — fictional brands. Add an API key and set HEARSAY_DEMO=0 to go live." with link to /settings.

### 11.3 Dashboard (GET /) — composition top to bottom

1. **KPI row** — 4 stat tiles (value 32px; delta line with ▲/▼ in `--good-text`/`--critical` + words, e.g. "▲ 3.2 pts vs prior 7d"; 90×28 sparkline in `--s1`, no axes):
   - Share of AI voice (30d)
   - Brand mention rate ± CI ("61% ± 6, n=248")
   - Recommendation rate
   - Answers analyzed (n; subtitle: last run relative time + 30d actual API spend from `actualSpend()`, e.g. "$4.12 this month")
   KPI rate tiles carry the §6.6 phrasing-spread line when >1 paraphrase exists ("phrasing spread ±19 pts", `--muted`).
2. **SOV trend** — line chart, 30d, brand + ≤3 competitors. 2px lines, circle markers 8px on hover only, y-axis 0–100% with 4 gridlines (1px `--grid`), **days without runs are gaps** (broken line), direct labels at line ends + legend row (chip + name, `--ink-2`). Crosshair + shared tooltip on hover (values sorted desc, brand bolded). Under the chart, a "view as table" `<details>` renders the same data as a table (accessibility + the honesty aesthetic).
3. **Provider row** — 4 cards (ChatGPT, Claude, Gemini, Perplexity): mention-rate **meter** (6px track `--grid`, fill `--s1`; value + CI right-aligned), avgRank, citation share (Perplexity card only), status line: `● Operational` in `--good-text` / last error with icon + label (never color alone). Disabled provider → card at 45% opacity with "No API key" and a settings link.
4. **Competitor leaderboard** — table: chip+Entity, SOV (inline 6px bar, entity's fixed color, right-anchored % in ink), Mention rate ± CI, Avg rank, Rec. rate, Δ7d (▲/▼ + pts). Sortable client-side (app.js), tabular-nums, brand row emphasized (600 weight, `--surface` elevated card row).
5. **Alerts panel** — up to 5 open alerts: severity icon + label chip (`good ✓ / warning ⚠ / serious ✖` — icon AND word), title, relative time, Ack button. Link "all alerts →".
6. **"Cited instead of you"** — the action layer (defuses the "just a benchmarker" objection): `barChartH` of `citationGap()` top domains cited in answers where the brand is absent, count per domain, each row linking to /answers filtered to those responses. Subtitle: "The shortlist of places to earn citations." Empty (no citation data yet) → hidden, not an empty box.
7. **Latest receipts** — 2 cards of the most recent answers where the brand gained/lost `recommended`: provider badge, prompt, snippet with `<mark>` highlights, link to /answers filtered.

Empty states (every page): friendly 2-line explanation + primary action. Dashboard with zero data: redirect to /setup (§11.8); if wizard skipped, 3-step "Get started" card (add key → add entities/prompts → run) + `HEARSAY_DEMO=1` hint.

### 11.4 Answers explorer (GET /answers)

Filter row (one line, left-aligned): provider select, prompt select, entity select, date-range presets (Today / 7d / 30d / 90d), Clear. Server-side filtering via query params. Cards: header (provider badge with provider's letter-mark, model `--muted`, timestamp, sample #), prompt in `--ink-2` italic, answer text with entity highlights — `<mark>` styled per entity: `background: color-mix(in srgb, var(--sN) 18%, transparent); border-bottom: 2px solid var(--sN); color: var(--ink)` — citation chips row (domain, favicon-less, linked, matched-entity chip colored border), `recommended` pill when set. Pagination "‹ 1 2 3 ›" server-rendered. Errored responses render collapsed with the error kind chip.

### 11.5 Prompts & Entities pages

CRUD tables + inline add-form at top. Prompts: text, category select (`general/comparison/use-case/local/pricing`), active toggle, per-prompt brand mention-rate mini-meter (30d). Entities: name, aliases (comma input → chips), domains, is_self radio (exactly one), color chip preview. Client JS = plain `fetch` to §10.3 + reload; no SPA state.

### 11.6 Settings & Methodology pages

Settings (read-only env viewer): providers table (enabled/model/masked key "sk-…4f2"), schedule, samples, the §4.3 cost panel (calls/run + estimated $/run + 30d actual spend), branded-prompt SOV toggle (§6.7), DB path + size, export button → /api/export download. Methodology: SSR of METHODOLOGY.md content (tiny built-in markdown subset renderer: h2/h3, p, ul, ol, code, strong/em — or hand-written HTML mirroring the file; either acceptable, no dependency).

### 11.7 Charts (`web/svg.js`) — server-rendered SVG, pure functions

```js
lineChart({series:[{name,color,points:[{x:epochDay,y:0..1}]}], w=720, h=220, yFmt}) → svg string
  // gaps: consecutive points >1 day apart are NOT connected
barChartH({rows:[{label,value,color?}], w, h, xMax}) — 4px rounded data-end, 2px gap, baseline-anchored
sparkline({points, w=90, h=28, color}) — no axes, 2px line
meter({value, lo?, hi?, w=160}) — 6px track; optional CI whisker overlay
```

Marks: lines 2px; bar ends 4px radius (baseline side square); 2px `--surface` gap between adjacent fills; gridlines 1px `--grid` behind marks; axis text 11px `--muted`; NO dual axes anywhere, ever. Each `<svg>` gets `role="img"` + `<title>`. Hover layer: `app.js` reads `data-chart` JSON attribute, positions a shared absolutely-positioned tooltip (`--surface`, hairline border, 12px shadow at 8%); crosshair 1px `--baseline` vertical line on line charts; per-mark on bars. Touch: tap = toggle tooltip.

### 11.8 First-run setup wizard (GET /setup)

Auto-redirect target when the DB has no entities and demo mode is off. Three steps, each skippable, no SPA state (server-rendered forms + the §10.3 API):

1. **Brand** — brand name, aliases, domain; up to 3 competitors (name + domain).
2. **Prompts** — one text field ("what does your product do / what would a buyer ask?") → POST /api/prompts/suggest → editable checklist of intents × paraphrases with `branded` badges explained in one line; user unchecks/edits, saves. No provider key → static starter pack (§20.3) pre-filled instead.
3. **Go** — providers detected from env (masked keys), §4.3 cost estimate for the resulting panel, and a "Run first panel" button (or "Seed demo data instead").

Wizard never blocks the normal CRUD pages; "Skip setup" is visible on every step.

---

## 12. Demo mode & seeder (`core/seed.js`)

Fictional universe (all names invented; no real brands):

- Brand: **Notewell** — AI meeting-notes tool. `domains: ["notewell.io"]`, aliases `["Notewell AI"]`.
- Competitors: **Jotta** (`jotta.app`), **EchoPad** (`echopad.ai`), **Quillo** (`quillo.co`).
- 12 prompts organized as 5 intents × 2–3 paraphrases (exercises §6.6 grouping), e.g. intent "best AI meeting notes tool" → "What's the best AI meeting notes tool?" / "Which AI tool should I use for meeting notes?" / "top meeting-notes AI for small teams"; plus intents for "Notewell vs Jotta — which should my sales team use?" (category `comparison`), "affordable meeting transcription for startups", "best free meeting summarizer", and one `branded` intent ("Is Notewell any good?") to demo the SOV-exclusion badge. Seeded responses leave `tokens_in/tokens_out/cost_usd` null (demo banner notes cost tracking starts with live runs).

Generation: deterministic PRNG (mulberry32, seed `1337`). 30 days × 4 providers × 12 prompts × 3 samples. Per (provider, entity) a base mention probability + linear drift + prompt-affinity jitter; scripted storylines: brand rises on Perplexity (0.35→0.60), **drops sharply on Gemini in the last 7 days** (0.55→0.25) and Jotta crosses above — so the seeded DB contains a `MENTION_DROP`, an `OVERTAKEN`, and one `LOST_RECOMMENDATION` + one `GAINED_RECOMMENDATION` alert, and the dashboard screenshots show a story.
Answer texts are template-assembled (intro sentence + ranked list of 2–4 entities + caveat sentence; several template families so the explorer looks organic) — then run through **the real `analyzeResponse()`** and inserted via the same DB writes as live runs (`runs.trigger='seed'`). Perplexity samples get 1–3 citations drawn from entity domains + neutral domains (`g2.example.com`-style is forbidden — use invented-but-plausible `reviewradar.io`, `worktools.dev`).
Timestamps: spread runs at 07:00Z per day ending **yesterday** relative to seed time.
CLI: `node scripts/seed.js` (refuses if DB non-empty unless `--force`, which wipes). Auto-seed at boot when `HEARSAY_DEMO=1` and DB empty. Determinism test: same seed → identical mention counts (§15).

---

## 13. MCP server (`mcp/server.mjs`) — zero-dep stdio

Hand-rolled implementation of MCP's stdio transport: newline-delimited JSON-RPC 2.0 over stdin/stdout. No SDK. ~200 lines. Protocol version string `[VERIFY-AT-BUILD]` (e.g. `2025-06-18`); echo the client's requested version if it's one we know.

Handle: `initialize` → `{protocolVersion, capabilities:{tools:{}}, serverInfo:{name:"hearsay", version}}`; `notifications/initialized` → ignore; `ping` → `{}`; `tools/list`; `tools/call`; unknown → `-32601`. Never write logs to stdout (stderr only) — stdout is protocol-pure.

Data source: HTTP API of a running Hearsay at `HEARSAY_URL` (default `http://127.0.0.1:3000`). Fetch failures → tool error content, exit code stays 0.

Tools (each returns `content:[{type:"text",text:JSON.stringify(data)}]`):

| Tool | Input schema | Backing call |
|---|---|---|
| `hearsay_summary` | `{days?: integer 1–365}` | GET /api/summary |
| `hearsay_alerts` | `{open_only?: boolean=true}` | GET /api/alerts |
| `hearsay_answers_search` | `{provider?, entity?, days?, limit?≤50}` | GET /api/answers |
| `hearsay_prompt_results` | `{days?}` | GET /api/summary + promptTable |
| `hearsay_run_panel` | `{}` | POST /api/run (returns runId + estUsd or 'already running') |
| `hearsay_citation_gap` | `{days?: integer}` | GET /api/gap — "who gets cited instead of you" |
| `hearsay_intent_results` | `{days?: integer}` | intentTable incl. variance split (§6.6) |

README documents registration: `claude mcp add hearsay -- node /path/to/hearsay/mcp/server.mjs` + JSON snippet for Claude Desktop config `[VERIFY-AT-BUILD]` for current config file shapes. **The MCP server + skill are co-headline features (§1.3 #1): the README leads with the agent demo GIF, and every launch post carries the "for humans and agents" line.** Tool descriptions must be trigger-rich (agents find tools by description): mention "AI visibility", "share of voice", "GEO", "brand mentions in ChatGPT/Claude/Gemini/Perplexity".

---

## 14. Agent skill (`skill/SKILL.md`)

Frontmatter: `name: hearsay-ai-visibility`; `description:` trigger-rich one-liner ("Check and interpret brand visibility in AI answers (ChatGPT/Claude/Gemini/Perplexity) via a local Hearsay instance; use for AI visibility, GEO, share of AI voice, brand mentions in LLMs, AI SEO questions").
Body (≤150 lines): how to query the MCP tools or HTTP API; how to interpret SOV/CI honestly (never present a point estimate without n; call out low-sample); a compact GEO playbook (win citations on sources LLMs actually cite; build comparison pages; monitor after content changes; track competitor prompt-space); when to suggest running a panel; alert triage guidance. Install instructions: copy folder to `~/.claude/skills/hearsay-ai-visibility/`.

---

## 15. Testing

Framework: `node:test`, run `node --test test/`. **No live network in tests** — providers tested via fixtures; `fetch` injected/stubbed via a `_setFetch()` test hook in `shared.js`.

| File | Must cover |
|---|---|
| `analyze.test.js` | every case in §6.5 (≥14 tests) |
| `metrics.test.js` | Wilson anchor (§7); SOV zero-sum; SOV with multi-entity answers; trend gap omission; provider filter; low-n flag; branded-prompt exclusion + includeBranded override; intentTable pooling + variance split on a hand-built 2-paraphrase fixture; citationGap excludes brand-mentioned answers; actualSpend null-safety |
| `suggest.test.js` | §6.7 post-processing (pure): branded tagging via name+aliases, dedupe, ≤300-char cap, numbering strip, malformed-JSON fallback; no-key → starter-pack path |
| `cost.test.js` | estimateRunCost arithmetic; env price override; unknown-model → null cost (never guess) |
| `alerts.test.js` | each rule fires; each rule's negative; 7-day dedup; needs-2-prior-runs logic |
| `providers.test.js` | per provider: fixture parse → ProviderResult; 401→auth, 429→quota, abort→timeout; retry-once behavior; perplexity citations mapping |
| `router.test.js` | 404/405/415; 1MB cap; Origin mismatch 403; path traversal blocked; esc() correctness |
| `seed.test.js` | determinism (two seeds into two temp DBs → identical counts); alert storylines present; all writes pass FK checks |
| `e2e.test.js` | boot server on port 0 with temp seeded DB → GET / contains "Share of AI voice"; /api/summary matches §10.4 keys; POST /api/run in demo → 400; GET /answers?provider=perplexity renders citations |

Coverage: `node --test --experimental-test-coverage`; target ≥85% lines on `core/` (report in CI, don't hard-fail below).

---

## 16. Documentation set

- **README.md** — order: logo/wordmark; badges (CI, license MIT, node ≥22.5, "zero dependencies", MCP); 1-paragraph pitch leading with "for humans and agents" + the corrected stats (68.01% zero-click; ~60% CTR drop *when an AI Overview appears*; metered incumbent pricing per §20.1 — **never** "$337/mo avg" undated, **never** star-count comparisons); **agent demo GIF** (Claude answering "how's our AI visibility this week?") above the fold next to light+dark screenshots; **Quickstart** (`git clone … && cd hearsay && node scripts/seed.js && node server.js` for demo; then "go live" = add key to `.env`, set `HEARSAY_DEMO=0`); **agent quickstart** (`claude mcp add hearsay …`) given equal weight; **self-host checklist box** (answers the Plausible-crowd questions before they're asked: MIT single license — no FSL/open-core split; no gated features; no cloud tier planned; no telemetry; one-file SQLite, `/api/export` data freedom); features list incl. what we *refuse* to build (§1.5); cost calculator screenshot (§4.3) instead of a cost table; **comparison table** (Hearsay vs Peec / Profound / elmo — factual columns: price, license, engines, sampling/CIs, receipts, MCP, install footprint); methodology summary + link; roadmap; contributing; disclaimer ("not affiliated with OpenAI/Anthropic/Google/Perplexity; trademarks belong to their owners"); license.
- **METHODOLOGY.md** — sampling & Wilson CIs in plain words; **variance decomposition: rerun vs phrasing spread, which dominates and why (§6.6, cite arXiv:2605.27440)**; API-vs-consumer-app caveat (personalization, memory, hidden system prompts, geo/IP — stated as a bias no sampling removes, with the planned paired API-vs-UI study linked when published, §18); no-system-prompt/default-temperature choice; SOV formula + branded-prompt exclusion rationale; gaps-not-zeros; why BYOK; **channel-size honesty: organic LLM traffic is still small for most sites (<0.2% of visits per organicllm.org; complex/considered categories run multiples higher) — Hearsay's cost structure is built for a channel this size; three-figure-per-month subscriptions are not**; "receipts over scores" principle.
- **SECURITY.md** — localhost default; no auth in v1 (put behind Tailscale/reverse-proxy basic auth to expose); keys live in env, never DB/logs/UI (masked); report vulnerabilities via GitHub private advisory.
- **CONTRIBUTING.md** — zero-dependency rule (PRs adding deps are declined); run/test instructions; code style (ESM, JSDoc, pure core); good-first-issue pointers.
- **LICENSE** — MIT, copyright the repo owner.

---

## 17. CI (`.github/workflows/ci.yml`)

On push/PR: matrix Node `[22.x, 24.x]` → checkout, setup-node, `node --test test/`, then typecheck job: `npm i -D typescript@^5 && npx tsc -p jsconfig.json --noEmit`. (CI runners may install dev tooling; the shipped app still has zero deps.) Badge in README. Optional third job: `node scripts/seed.js && timeout 10 node server.js & curl smoke` — nice-to-have.

`jsconfig.json`: `{"compilerOptions":{"checkJs":true,"strict":true,"module":"nodenext","target":"es2022","noEmit":true},"include":["core","web","server.js","mcp","scripts"]}` — adjust until clean, do not litter `// @ts-ignore` (≤5 in whole repo).

---

## 18. Launch playbook

**Phase A — before/while building (validation + audience):**

1. Post the pre-written validation posts (`launchposts.md` in the planning repo) to r/selfhosted, r/SEO, and r/DigitalMarketing, spaced days apart, engaging in comments. Goals: settle the open question "will marketers self-host?", collect feature-priority signal, and seed an audience for launch day. Disclose maker status; ask, don't pitch.
2. Run the **paired API-vs-UI study** (n≈100 prompts, logged-out ChatGPT UI vs API, compare mention sets) once adapters exist. Publish as a standalone write-up — it converts Hearsay's biggest methodological liability into its best distribution asset (nobody has published this measurement; Fishkin flagged it as open).
3. Run the planned default panel (5 intents × 3 paraphrases × 4 providers × 3 samples) on real APIs for one week and publish the token-level bill — settles the contested cost question with receipts, on-brand.

**Phase B — ship (after v1.0 is green):**

4. Screenshots: `node scripts/screenshot.js` (Playwright, 1440×900, both themes, dashboard + answers page) + record the agent demo GIF → `docs/`. Set repo social-preview image.
5. Repo metadata — description: "AI visibility tracker for humans and agents. See how ChatGPT, Claude, Gemini & Perplexity talk about your brand — self-hosted, zero dependencies, your own API keys, MCP built in."; topics: `ai-visibility`, `generative-engine-optimization`, `geo`, `llm-seo`, `ai-search`, `brand-monitoring`, `self-hosted`, `selfhosted`, `mcp`, `mcp-server`, `agent-skills`, `marketing`, `seo-tools`, `nodejs`.
6. Pre-flight (every broken launch in the comparables had one of these): fresh-machine install of the README quickstart verbatim; load-test the demo; MCP round-trip from a real Claude client; comparison table fact-checked against competitors' live pricing pages that week.
7. Tag `v0.1.0` with honest release notes. Pin repo on profile.
8. Submissions: awesome-selfhosted (Analytics or Marketing — the AI-visibility slot was verified vacant July 2026; follow their PR rules), openalternative.co, selfh.st, r/selfhosted follow-up ("you asked, I built it" — back-reference the Phase A thread), r/SEO + r/bigseo (lead with the API-vs-UI study + methodology, not promo), Hacker News **Show HN** — title leads agent-native + zero-dep, never "alternative to X": "Show HN: Hearsay – AI visibility tracker your agents can query (zero deps, BYOK)" / "Show HN: I measured what ChatGPT says about brands, with error bars (self-hosted)".
9. First-2-weeks: respond to every issue < 24h; label `good first issue` ×5 (prompt-pack additions, provider adapters, translations of starter prompts); publish the cost-bill and API-vs-UI write-ups as repo `docs/` pages and link them in comment threads when relevant.

---

## 19. Swarm execution plan

### Phase 0 — Foundation (ONE agent, serial)

Scaffold per §2.2: package.json (no deps), jsconfig, config.js, db.js + full schema (§3), router skeleton + layout + empty pages rendering nav, style.css tokens (§11.1), test harness with 1 passing smoke test, CI file.
**Done when:** `node server.js` boots and serves shell pages; `node --test` green; typecheck green.

### Phase 1 — Parallel lanes (contracts frozen; mock the other lanes via fixtures)

- **Lane A: Providers + Runner + Scheduler + Cost** (§5, §8, §4.3) — fixtures for all four providers incl. usage fields; runner works against a fake adapter injected in tests; cost.js estimator.
- **Lane B: Analyzer + Metrics + Alerts + Suggest post-processing** (§6, §7, §9, §6.7 pure parts) — pure logic against fixture texts + a hand-built mini DB; intent pooling + variance split + citationGap.
- **Lane C: Web UI** (§10, §11 incl. /setup wizard) — pages + svg.js + app.js against a DB pre-populated by a checked-in SQL fixture (until Lane D lands).
- **Lane D: Seeder + Demo mode** (§12) — depends on Lane B's `analyzeResponse` signature only; seeds the intent/paraphrase structure.

**Done when:** each lane's test file is green; no lane changed a §-contract.

### Phase 2 — Integration (serial)

Wire runner→analyze→alerts; seed → dashboard end-to-end; e2e.test.js green; demo banner + empty states verified; dark mode visual pass on every page; keyboard/a11y pass (tab order, aria on toggles, `<title>` on SVGs); circuit breaker + mutex verified; optional human live-API smoke.

### Phase 3 — Polish & ship (serial)

MCP server + skill (§13, §14) tested with a real client; README/METHODOLOGY/SECURITY/CONTRIBUTING final; screenshots; CI badge; version 0.1.0; run the §19.5 gate.

### 19.5 Final acceptance gate (orchestrator runs literally)

1. Fresh clone on clean machine with only Node 24: `node scripts/seed.js && node server.js` → dashboard with demo story, alerts visible, both themes correct.
2. Zero-dep proof: `rg -n "from ['\"]|require\(" --glob '!node_modules'` — every import specifier must start with `node:`, `./`, or `../`; `package.json` has no `dependencies` key. Anything else fails the gate.
3. `node --test` all green; CI green on 22 + 24.
4. `/api/summary` validates against §10.4 by key-shape.
5. MCP: `initialize` + `tools/list` + `hearsay_summary` round-trip via a script piping JSON-RPC lines.
6. Grep for every UI rate display → carries `n` or CI. Charts: no dual axis, ≤4 series, gaps render as gaps.
7. README quickstart followed verbatim by an agent that has never seen the repo → success in <2 min.
8. No real brand names in seed data; no API key ever printed/rendered unmasked; no outbound request except to the four provider APIs (grep fetch targets).

### 19.6 Guardrails (pin in every agent's context)

1. **No npm runtime dependencies.** None. CI dev-tooling only.
2. **No new colors, fonts, or chart types** beyond §11; the categorical order is colorblind-validated — changing any hex or the order is forbidden.
3. **Never fabricate data outside `trigger='seed'` rows**; demo mode must be visually labeled.
4. **All rates ship with n (and CI where specified).** No naked percentages.
5. **UTC ISO-8601 in storage; local time only at render.**
6. **`analyze.js`, `metrics.js`, `svg.js` stay pure** (no I/O, no Date.now inside — timestamps passed in).
7. **`[VERIFY-AT-BUILD]` items must be checked against current official docs**, not guessed from training data.
8. **Scope discipline:** if it's not in this document, it's not in v1. Park ideas in a `ROADMAP-notes.md` PR comment instead.
9. **Secrets hygiene:** keys only from env; masked everywhere; never in git, logs, exports, or error messages, and **never persisted to the DB** (the closest OSS competitor's plaintext-keys-in-SQLite mistake is a known credibility killer; self-hosters check within hours).
10. **Honesty over polish:** an empty chart with a good empty state beats interpolated fake continuity. Gaps are gaps.
11. **Never cite star counts or claim "only/largest OSS" anywhere** (README, docs, launch copy). Refuted by fact-check; stars are inflated noise in this niche and the claim invites a one-comment takedown. Compare on install friction, methodology, license.
12. **No blended single score, no rank positions, no prompt-volume estimates, no content generation** — the §1.5 refusals are product features; don't "helpfully" add them.
13. **Cost figures only ever come from `core/cost.js` output** — no hardcoded dollar amounts in UI, README, or docs.

---

## 20. Appendix

### 20.1 Market evidence (for README/launch citations — fact-checked 2026-07-26, full audit in `hearsaydemandresearch.md`)

| Claim (phrase exactly like this) | Source |
|---|---|
| 68% of US Google searches end without a click (May 2026) | sparktoro.com/blog/in-2026-less-than-one-third-of-google-searches-still-send-a-click/ |
| When an AI Overview appears (20%+ of searches), CTR falls nearly 60% | searchengineland.com/google-zero-click-searches-2026-study-479717 |
| Incumbents are metered: Profound $99 entry is ChatGPT-only, Claude/API Enterprise-gated; Otterly charges up to $439/mo extra for Claude; Semrush $99/mo per domain for 25 prompts | tryprofound.com/pricing · otterly.ai/pricing · semrush.com/pricing/ai/ |
| Agencies build in-house trackers to escape $99–$1,000/mo pricing | digiday.com/marketing/marketers-question-expensive-ai-visibility-tools-as-inconsistent-results-fuel-skepticism/ |
| AI answers are highly inconsistent when recommending brands (2,961-prompt study) | sparktoro.com/blog/new-research-ais-are-highly-inconsistent-when-recommending-brands-or-products-marketers-should-take-care-when-tracking-ai-visibility/ |
| Phrasing variance exceeds rerun variance (cross-paraphrase agreement 0.135–0.288 vs rerun 0.50–0.61) | arxiv.org/pdf/2605.27440 |
| Demand quote: "repeatable data across the same prompt sets instead of wrapping random outputs into one visibility score" | reddit.com/r/content_marketing/comments/1v1uf10/ |
| Commercial entrants incl. YC-backed at $249/mo | news.ycombinator.com/item?id=47457472 (Sitefire Launch HN; note it also does content generation — not like-for-like) |
| Channel-size honesty: organic LLM traffic <0.2% of visits for most sites; multiples higher in complex/considered categories | organicllm.org |

**Retired claims — do not use:** "avg $337/mo" undated (survey is Aug 2025 — if cited, date it); "zero OSS alternatives" / "biggest OSS tracker ~130★" (refuted — see §20.2); any star-count comparison (§19.6 #11).

### 20.2 Nearest existing OSS (differentiate, don't disparage — verified 2026-07-26)

- `every-app/open-seo` (8,095★) — broad OSS SEO suite with a shallow AI-visibility module; needs paid DataForSEO; **biggest absorption risk** — Hearsay stays visibly narrower and deeper (measurement methodology, not another suite).
- `elmohq/elmo` (203★) — closest clone ("self-hosted alternative to Profound/Peec/Otterly"); Docker+Postgres+pg-boss, no sampling/CI statistics, solo project, monetization pivoted to services. Proof the "OSS alternative to X" pitch doesn't convert.
- `onism1767-creator/potato` (199★) — ships Wilson CIs but Claude-only, one-shot, 1 commit.
- `danishashko/geo-aeo-tracker` (209★) — requires paid Bright Data; IndexedDB storage.
- `Canonry/canonry` (97★) — FSL-1.1 (not OSI); already ships MCP + variance reporting — watch it.
- `aryamantodkar/oneglanse` (135★, dormant) — PG+ClickHouse+Redis; usefully pre-frames the API-vs-UI critique.

Hearsay's verified-unclaimed angles vs all of the above: zero-dependency install (none ship without Docker/Postgres/ClickHouse or a paid data vendor), intent-level sampling + variance split across four engines, receipts explorer, true-MIT single license, agent surfaces as co-headline.

### 20.3 Starter prompt pack (ship as suggested prompts on the Prompts page — generic placeholders the user edits)

"What's the best {category} for {audience}?" · "Top 5 {category} in {year}" · "{Brand} vs {Competitor} — which is better?" · "Is {Brand} worth it?" · "Cheapest way to {job-to-be-done}" · "Best free alternative to {Competitor}" · "{category} with the best {key feature}" · "What do people say about {Brand}?" · plus 4 category-specific slots the setup flow fills from the user's entities.

### 20.4 Post-v1 roadmap (README section)

v1.1 (priority order per demand evidence): **webhook alerts first** (zero-dep POST — the single most-requested delivery mechanism), **multi-client workspaces + white-label HTML/PDF report export** (promoted from v2 — highest-value agency gap; agencies are the segment that pays), LLM-judged sentiment (opt-in, uses existing keys), CSV export, Docker image + compose. v1.2: prompt-level Google AI Overviews via optional SERP API (site-level AIO is now free in Google Search Console — position ours as prompt-level, which GSC can't do), more providers (Grok, DeepSeek, Copilot `[VERIFY]`), prompt-pack marketplace (community JSON packs). v2: trend annotations ("we shipped the comparison page here").

---

*Plan version 1.1 — written 2026-07-26; revised same day against the 10-agent demand/competitive research (`hearsaydemandresearch.md`).*

**v1.1 changelog:** repositioned agent-native-first with a binding "never 'alternative to X'" copy rule (§1.1, §1.3, §13, §18); dual-track audience (§1.4); explicit product refusals (§1.5); success metric redefined off stars (§1.6); added intents/paraphrase sampling + variance decomposition (§3, §6.6, §7), intent & paraphrase generator with branded-prompt quarantine (§6.7, §11.8), cost calculator replacing all flat cost claims (§4.3, §3, §5.1), citation-gap "who gets cited instead of you" action layer (§7, §10.3, §11.3, §13); retired refuted/stale market claims and rebuilt the evidence table (§1.2, §16, §20.1); refreshed OSS competitive map (§20.2); launch playbook split into validation phase + ship phase with API-vs-UI study and cost-bill write-ups (§18); guardrails 11–13 added (§19.6); roadmap re-prioritized, white-label promoted (§20.4).
