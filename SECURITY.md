# Security

## Threat model in one paragraph

Hearsay is a single-user, self-hosted tool that binds to localhost by default and
holds two kinds of secrets: your LLM provider API keys (environment only) and your
measurement data (one SQLite file). There are no accounts, no sessions and no
authentication in v1 — the security boundary is *who can reach the port*.

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

## Outbound traffic

The only outbound requests Hearsay ever makes are the measurement calls to the
provider APIs you configured (OpenAI, Anthropic, Gemini, Perplexity). No telemetry,
no update checks, no phone-home of any kind.

## Reporting a vulnerability

Please use a [GitHub private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository rather than a public issue. Include reproduction steps; you will get
a response within a week. Fixes for anything inside the model above are treated as
release-blocking.
