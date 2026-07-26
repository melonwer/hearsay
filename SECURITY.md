# Security

Written in full in Phase 3 (§16). The standing commitments, true as of this scaffold:

- **Localhost by default.** `HOST` defaults to `127.0.0.1`. v1 has no accounts and no
  authentication: to reach it from elsewhere, put it behind Tailscale or a reverse proxy
  with authentication. Do not expose the port directly. `POST /api/setup` sits inside the
  same localhost/reverse-proxy trust boundary as the other CRUD endpoints — anyone who can
  reach the port could already reconfigure Hearsay; the agent surface adds convenience,
  not exposure.
- **Keys come from the environment only.** They are never written to the database, never
  logged, never included in exports, never placed in error messages, and only ever
  rendered masked.
- **Same-origin guard.** Mutating requests carrying a mismatched `Origin` header are
  refused, and HTML responses ship a restrictive Content-Security-Policy.
- **Reporting.** Please use a GitHub private security advisory rather than a public issue.
