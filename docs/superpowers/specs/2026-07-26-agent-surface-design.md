# Agent Surface v0.1 — design spec

**Amendment to `planning/hearsayimplementationplan.md` v1.1: supersedes the §13 tool table; amends §4.1, §10.3, §14, §15. Core contracts (§4–§9) are untouched — no Phase 1 lane is affected beyond the two small §10.3 deltas noted in Sequencing.**

Date: 2026-07-26 · Status: approved design, pending implementation plan

---

## 1. Goal

Make the agent a **full lifecycle operator** of Hearsay, not a read-only consumer. A user who never opens the web UI can say to any MCP-connected agent:

> "Set up tracking for Acme vs Jotta and EchoPad, then tell me how we're doing."

and get: entities created, an intent/paraphrase panel drafted and human-reviewed in conversation, cost quoted before spend, the panel run, and an honestly-narrated summary — **zero UI visits, ≤2 human answers plus 1 spend approval**. This is the README demo GIF and the competitive wedge: incumbent MCP/API access is read-only and Enterprise/paid-gated (Profound, Peec); Hearsay's is write-capable and free.

**Decisions locked during design:** (1) scope = agent surface + backing API only; (2) agents get full lifecycle powers; (3) agent-triggered spend is gated server-side by quote-then-confirm above a threshold.

## 2. MCP tool inventory (13 tools — replaces the §13 table)

All tools return `content:[{type:"text",text:JSON.stringify(data)}]`. Tool-level failures (HTTP error from Hearsay, unreachable server) return `isError:true` with the API error envelope as text — never JSON-RPC protocol errors. Reads carry `annotations:{readOnlyHint:true}`; no tool sets `destructiveHint` (nothing destructive is exposed). Annotation field names `[VERIFY-AT-BUILD]` against the current MCP spec.

| # | Tool | Input schema (JSON Schema, all fields optional unless noted) | Backing call |
|---|---|---|---|
| 1 | `hearsay_status` | `{}` | `GET /api/status` (new — §3.1) |
| 2 | `hearsay_summary` | `{days: integer 1–365}` | `GET /api/summary?days=` |
| 3 | `hearsay_intent_results` | `{days: integer 1–365}` | `GET /api/intents/results` (new — §3.5): intentTable, pooled CI + variance split (§6.6) |
| 4 | `hearsay_prompt_results` | `{days: integer 1–365}` | `GET /api/prompts/results` (new — §3.5): promptTable, per-paraphrase per-provider |
| 5 | `hearsay_answers_search` | `{provider: string, entity_id: integer, prompt_id: integer, days: integer, page: integer, limit: integer ≤50}` | `GET /api/answers` (`limit` maps to `per`) |
| 6 | `hearsay_citation_gap` | `{days: integer}` | `GET /api/gap` |
| 7 | `hearsay_alerts` | `{open_only: boolean = true}` | `GET /api/alerts` |
| 8 | `hearsay_cost_estimate` | `{}` | `GET /api/cost/estimate` (existing endpoint, newly exposed) |
| 9 | `hearsay_suggest_prompts` | `{category_hint: string, keywords: string}` | `POST /api/prompts/suggest` — **draft only, never persists** (§6.7 intact) |
| 10 | `hearsay_setup_tracking` | body of `POST /api/setup`, verbatim (§3.2) | `POST /api/setup` (new) |
| 11 | `hearsay_run_panel` | `{confirm: boolean}` | `POST /api/run` (amended — §3.3) |
| 12 | `hearsay_run_status` | `{}` | `GET /api/runs/latest` |
| 13 | `hearsay_ack_alert` | `{id: integer}` **required** | `POST /api/alerts/:id/ack` |

**Descriptions** are trigger-rich per §13 (mention "AI visibility", "share of voice", "GEO", "brand mentions in ChatGPT/Claude/Gemini/Perplexity") **plus operator verbs** for the write tools. Two binding examples; the rest follow the pattern:

- `hearsay_status`: "Check whether a local Hearsay AI-visibility tracker is running and configured: enabled providers (ChatGPT, Claude, Gemini, Perplexity), tracked brand/competitor counts, last measurement run, 30-day API spend. Call this first for any AI visibility / GEO / AI SEO / brand-monitoring question."
- `hearsay_setup_tracking`: "Set up or extend AI-visibility tracking in one call: create the brand, competitors, and intent/paraphrase prompt panel Hearsay measures across ChatGPT, Claude, Gemini and Perplexity. Use after the human has reviewed the prompt list (e.g. from hearsay_suggest_prompts)."

**Parked for v1.1 (do not build):** granular entity/prompt edit/rename/archive tools (destructive edits stay in the UI), `hearsay_export` (payloads too large for tool results), full-text answer search, `recommended=` filter on answers, `scripts/report.js`.

The MCP process itself still needs **no API keys** (§1.3 #1 holds): it only talks to the local Hearsay HTTP server at `HEARSAY_URL` (default `http://127.0.0.1:3000`).

## 3. API deltas (4 new endpoints, 2 amendments — §10.3)

### 3.1 New: `GET /api/status`

Works on an empty DB (unlike `/api/summary`, which presumes a configured brand). Cheap: counts + settings reads only.

```json
{
  "version": "0.1.0",
  "demo": false,
  "configured": true,
  "providers": [{"id":"openai","label":"ChatGPT","model":"gpt-5-mini","enabled":true}],
  "counts": {"entities": 4, "intents": 5, "activePrompts": 12},
  "schedule": {"runAt": "07:00", "schedulerEnabled": true},
  "lastRun": {"id":9,"status":"done","started_at":"…","finished_at":"…","trigger":"cron","total_calls":144,"done_calls":144},
  "spend30dUsd": 4.12
}
```

- `version` from package.json. `configured` := exactly one non-archived `is_self` entity **and** ≥1 active prompt. `counts.entities` excludes archived. `schedulerEnabled` := not demo mode and ≥1 enabled provider. `lastRun` = same object as `/api/runs/latest`, or `null`. `spend30dUsd` = `actualSpend({days:30}).totalUsd` (null-costs excluded per §4.3). **No key material, masked or otherwise, ever appears here** — masking is for the Settings page; the API omits keys entirely.

### 3.2 New: `POST /api/setup` — transactional bulk create/append

Request (every top-level key optional; empty object → 422 `nothing_to_do`):

```json
{
  "brand":       {"name":"Acme", "aliases":["Acme AI"], "domains":["acme.com"]},
  "competitors": [{"name":"Jotta", "aliases":[], "domains":["jotta.app"]}],
  "intents":     [{"label":"best widget tool", "category":"general",
                   "paraphrases":["What's the best widget tool?","Top widget tools in 2026"]}]
}
```

**Validate everything first, then write everything in one SQLite transaction.** Validation failures → single `422 {"error":{"code":"validation","message":"…"}, "errors":[{"path":"intents[2].paraphrases[0]","message":"…"}]}` with **zero writes**. Rules (all reuse §10.3): aliases ≥3 chars; domains unique across existing entities **and** within the payload; paraphrase text non-empty, ≤300 chars; each intent needs ≥1 paraphrase; `category` ∈ `general|comparison|use-case|local|pricing|branded`.

Semantics after validation:

- **brand**: no `is_self` entity exists → create with `is_self=1`. Same name exists as the brand (case-insensitive) → skip + report (no merge). A *different* `is_self` brand exists → **409** `{"error":{"code":"brand_exists","message":"Brand is \"Notewell\" — changing the brand is destructive; use the web UI."}}`. Brand name matches an existing *non-brand* entity → **409** `{"error":{"code":"entity_exists",…}}` — promoting a competitor to brand is a UI action. Both 409s are checked before validation of the rest.
- **competitors**: entity name already exists (case-insensitive, any entity) → skip + report; else create with `is_self=0`.
- **intents**: existing label → reuse that intent id and append new paraphrases to it; existing prompt text (unique column) → skip + report; else insert prompt (`active=1`, given category).
- **Branded auto-tag**: any paraphrase containing the brand name or an alias (case-insensitive, word-boundary — same matching §6.7's post-processing uses) is stored with `category='branded'` regardless of the requested category, and reported. Keeps the SOV-denominator invariant (§6.7) agent-proof.
- Demo mode → `400 {"error":{"code":"demo_mode",…}}` (same rule as `/api/run`).

Response `200`:

```json
{
  "created": {"entities":2, "intents":3, "prompts":8},
  "skipped": [{"type":"prompt","value":"Top widget tools in 2026","reason":"duplicate"}],
  "retagged_branded": ["Is Acme any good?"],
  "config": {"entities":4, "intents":5, "activePrompts":12}
}
```

### 3.3 Amended: `POST /api/run` — server-side cost gate

Body now optional JSON `{"confirm": boolean}`. Order of checks: demo → 400; already running → **409** with the numbers in the message (envelope stays `{"error":{code,message}}`): `"Run 42 in progress: 37/144 calls done"`. Then compute the §4.3 estimate:

- **Quote required** when `confirm` is not `true` AND (`estUsd > HEARSAY_CONFIRM_USD` OR `calls > 200` OR `estUsd` is null/unknown OR `HEARSAY_CONFIRM_USD` is `0`): respond `200 {"status":"quote_required","calls":144,"estUsd":0.87,"perProvider":[{"provider":"openai","calls":36,"estUsd":0.21}],"confirmHint":"POST /api/run with {\"confirm\":true} to start"}`. Unknown cost (model missing from the §4.3 price table) always quotes — unknown spend must be confirmed.
- Otherwise start: `202 {"runId":43,"estUsd":0.87}` (existing shape).

The gate lives in the API handler, so UI, curl, and MCP are protected identically. The dashboard run button (§11.2) keeps its own confirm dialog and then sends `confirm:true` — its §4.3 behavior ("confirm when > $1 or > 200 calls") is now *implemented by* this endpoint instead of duplicated client-side.

**Clarification (empty case):** `GET /api/runs/latest` with no runs ever → `404 {"error":{"code":"no_runs",…}}`.

### 3.5 New: `GET /api/intents/results?days=30` and `GET /api/prompts/results?days=30`

Thin read wrappers returning `intentTable({days})` and `promptTable({days})` (§7) verbatim as JSON arrays. Needed because the original §13 backed `hearsay_intent_results`/`hearsay_prompt_results` with "`/api/summary` + promptTable", but the §10.4 summary shape contains neither table — the two tools previously had no real backing endpoint. The §7 return shapes are the contract; these routes add no logic.

### 3.4 Amended: `POST /api/prompts/suggest` — starter-pack fallback replaces the 400

§10.3 ("400 if no provider key") contradicts §6.7 ("zero keys → static starter pack, never a dead end"). Resolved server-side, one behavior for wizard, curl, and MCP:

- Keys present: `200 {"source":"llm","intents":[…]}` (adds `source` to the existing shape — additive).
- No enabled provider: `200 {"source":"starter-pack","intents":[…]}` — the §20.3 pack, with `{Brand}`/`{Competitor}` filled from existing entities when configured and other placeholders (`{category}`, `{audience}`, `{year}`, …) left bracketed for the human/agent to edit. Still draft-only; nothing persists.

## 4. Configuration delta (§4.1)

| Var | Default | Meaning |
|---|---|---|
| `HEARSAY_CONFIRM_USD` | `1` | Run-cost confirm threshold in USD. Runs estimated above it (or >200 calls, or with unknown cost) return a quote until confirmed. `0` = every run quotes first. Parsed as float ≥ 0. |

## 5. `skill/SKILL.md` — the operator's brain (§14, rewritten)

≤150 lines. Frontmatter (binding):

```yaml
name: hearsay-ai-visibility
description: Operate and interpret a local Hearsay AI-visibility tracker via its
  MCP tools (hearsay_*) — set up brand tracking, generate prompt panels, run
  measurements, and report share of AI voice / brand mentions in ChatGPT, Claude,
  Gemini and Perplexity with honest statistics (confidence intervals, n, phrasing
  spread). Use for AI visibility, GEO, AI SEO, LLM brand monitoring questions.
```

Body sections, in order:

1. **First move.** Always `hearsay_status`, then branch: unreachable → tell the human to start it (`node server.js`); running but `configured:false` → onboarding playbook; configured → answer the question with the narrowest read tool, not a tool sweep.
2. **Onboarding playbook** (the flagship): ask the human at most two questions (brand + competitors; category only if unclear) → `hearsay_suggest_prompts` → **show the full draft intent/paraphrase list and wait for approval — HARD RULE: never call `hearsay_setup_tracking` with prompts the human hasn't seen in this conversation** (§6.7's review step, relocated) → `hearsay_setup_tracking` → `hearsay_run_panel`; if `quote_required`, relay calls + estUsd and get an explicit yes before `confirm:true` → poll `hearsay_run_status` → narrate the first `hearsay_summary`.
3. **Honest interpretation rules** — §1.5's refusals bind the agent's *narration*: every rate quoted with n ("58% ± 7, n=36"); phrasing spread stated whenever >1 paraphrase ("phrasing spread ±19 pts — phrasing matters more than reruns"); n<5 flagged as low-sample; missing days are gaps, not zeros; demo data always called fictional; **never synthesize a blended visibility score, a rank position, or a prompt-volume estimate even if asked** — explain why Hearsay refuses and offer SOV + mention rate + receipts instead.
4. **Weekly report recipe**: `summary` + `intent_results` + `alerts` + `citation_gap` + 2–3 receipts via `answers_search`; inline markdown template (KPIs with CI copy-pattern, movers, alert digest, "cited instead of you" shortlist, receipt quotes with provider + date).
5. **Alert triage**: what each of the four §9 types means, the suggested next action for each, ack via `hearsay_ack_alert` only after the human has seen it.
6. **GEO playbook (compact, honest)**: citation-gap domains → earn citations there; comparison pages for `comparison` intents; after shipping content, re-run and compare *intent-level* numbers (not single prompts); watch competitor prompt-space via `prompt_results`.
7. **Cost etiquette + troubleshooting**: never `confirm:true` without in-conversation human approval; `auth`/`quota` error → which `.env` key to check; demo-mode meaning; keys are only spent on measurement, never on consuming results.

## 6. `mcp/server.mjs` implementation notes (§13)

- Hand-rolled stdio JSON-RPC 2.0 per §13, unchanged framing/handshake rules; grows from ~200 to ~350 lines.
- **Single declarative tool table** `{name, description, inputSchema, annotations, call:{method, path(params), body(params)}}` drives both `tools/list` and `tools/call` — a v1.1 tool is one table row.
- Error mapping: HTTP non-2xx → `isError:true`, text = the API's error envelope verbatim; network failure → `isError:true`, text = `{"error":{"code":"unreachable","message":"Hearsay not reachable at <url> — is `node server.js` running?"}}`. Exit code stays 0; stdout stays protocol-pure (logs → stderr).
- `hearsay_run_panel`'s `quote_required` response passes through as *normal* (non-error) content — a quote is a successful outcome.

## 7. CLI delta

`scripts/run-panel.js` gains `--estimate`: print the §3.3 quote JSON and exit without running. No other CLI changes; `scripts/report.js` is parked (v1.1, alongside webhooks).

## 8. Testing (§15 additions)

New row — **`test/mcp.test.js`** (no live network; stub Hearsay with a throwaway `node:http` server on port 0):

- `initialize` → protocol version echo rule, `serverInfo`, capabilities.
- `tools/list` → exactly 13 tools, each with `inputSchema`; spot-check annotations.
- `tools/call hearsay_summary` happy path against a canned §10.4 body.
- `tools/call` mapping: backing 400/409/422 → `isError:true` with envelope text; unreachable URL → `isError`, process survives.
- Unknown method → `-32601`; notification ignored; **stdout purity** (every stdout line parses as JSON-RPC).

Amended rows:

- `router.test.js` / API tests: `/api/status` empty-DB shape + `configured` logic + no key material in body; `/api/intents/results` + `/api/prompts/results` return the §7 shapes (days default 30); `/api/setup` — 422 lists all validation errors with zero writes, dedupe-skip reporting, paraphrase-append to existing intent, branded auto-retag, demo-mode 400, `is_self` conflict 409, transactionality (constraint failure mid-batch leaves no partial rows); `/api/run` — below-threshold starts (202), above-threshold quotes (200), `confirm:true` starts, `HEARSAY_CONFIRM_USD=0` always quotes, unknown-cost quotes; `/api/prompts/suggest` zero-key → `source:"starter-pack"`.
- `e2e.test.js`: seeded-DB `hearsay_status` reflects demo mode; §19.5 gate #5 (MCP round-trip script) unchanged.

## 9. Sequencing & lane impact

- **Phase 1 (in flight): the frozen core-module contracts (§4–§9) are untouched.** The §10.3 deltas *are* API-surface amendments to Lane C's territory, but they're additive (four new routes) or small (`confirm` param, suggest fallback) and can land during Phase 2 integration without reworking Lane C internals. The dashboard run button switches to `confirm:true` at the same moment (one-line change in `public/app.js`).
- **Phase 3**: MCP server (this spec §2/§6), SKILL.md (§5), `--estimate` flag, `test/mcp.test.js`, README agent-quickstart + demo GIF script.
- §19.5 acceptance gate gains one item: *the onboarding conversation of §1 succeeds against a fresh instance with one real key — zero UI visits, ≤2 human answers + 1 spend approval.*

## 10. Security note (SECURITY.md, one sentence)

`POST /api/setup` sits inside the same localhost/reverse-proxy trust boundary as the existing CRUD endpoints — anyone who can reach the port could already reconfigure Hearsay; the agent surface adds convenience, not exposure. Keys never cross the MCP boundary in any direction.
