# Security

## Threat model in one paragraph

Hearsay is a single-user, self-hosted tool that binds to localhost by default and
holds two kinds of secrets: your LLM provider API keys (environment only) and your
measurement data (one SQLite file). A subscription-agent run also uses the local
operating-system credential stores of the installed Codex/Claude Code CLIs, but Hearsay
does not read or copy those credentials. There are no Hearsay accounts or sessions —
the security boundary is *who can reach the port and the local process account*.

## Deployment

- **Localhost by default.** `HOST` defaults to `127.0.0.1`. Nothing listens on the
  network unless you change that.
- **Exposing it is your reverse proxy's job.** To reach Hearsay from elsewhere, put it
  behind Tailscale, a VPN, or a reverse proxy that adds authentication (basic auth is
  fine). Do not point `HOST=0.0.0.0` at the open internet: v1 has no login, so anyone
  who can reach the port can read your data, reconfigure tracking and spend your API
  budget by triggering runs.
- **One trust boundary, deliberately.** Every mutating endpoint — including the
  agent-facing `POST /api/setup` and `POST /api/run` — sits inside the same
  localhost/reverse-proxy boundary as the human UI. Anyone who can reach the port could
  already reconfigure Hearsay through the UI; the agent surface adds convenience, not
  exposure. Mutating requests with a mismatched `Origin` header are refused, and HTML
  responses ship a restrictive Content-Security-Policy.

## Secrets

- **API keys come from the environment (or `.env`) only.** They are never written to
  the database, never logged, never included in `/api/export`, never placed in error
  messages, and only ever referenced masked in the UI. If you find a code path that
  violates this, that is a vulnerability — please report it.
- **The database contains no key material.** `data/hearsay.db` holds entities, prompts,
  stored answers and metrics. Back it up freely; it is safe to share with anyone you
  would show your dashboard to.
- **Subscription authentication is delegated to the CLI.** Hearsay launches an
  explicitly selected Codex or Claude Code executable with a restricted, read-only,
  web-search-only profile. It never reads OAuth tokens, keychain contents, account
  identifiers or credential files, and it never exposes them through an API, MCP
  response, artifact or error message.
- **Provider event artifacts are redacted first.** Output is size-bounded, identity and
  secret-like fields are removed before the event artifact is persisted, and the
  normalized answer/search/citation records remain usable if the artifact expires.

## Outbound traffic

The API lane makes measurement calls to the provider APIs you configured (OpenAI,
Anthropic, Gemini, Perplexity). The optional subscription lane delegates web requests
to the locally authenticated Codex/Claude Code CLI; Hearsay itself does not proxy or
export those credentials. There is no telemetry, update check or other phone-home.

## Reporting a vulnerability

Please use a [GitHub private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository rather than a public issue. Include reproduction steps; you will get
a response within a week. Fixes for anything inside the model above are treated as
release-blocking.
