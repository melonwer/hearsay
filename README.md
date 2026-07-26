# Hearsay

**AI visibility tracker for humans and agents.** See how ChatGPT, Claude, Gemini and
Perplexity talk about your brand — self-hosted, zero dependencies, your own API keys,
MCP built in.

```sh
git clone <this repo> && cd hearsay
node server.js          # http://127.0.0.1:3000
```

Requires Node.js ≥ 22.5. There is nothing to install and nothing to build.

## Use it from your agent

Hearsay ships an MCP server — your agent brings its own model, so reading
results costs no API keys. With [Claude Code](https://claude.com/claude-code):

```sh
claude mcp add hearsay -- node /absolute/path/to/hearsay/mcp/server.mjs
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "hearsay": { "command": "node", "args": ["/absolute/path/to/hearsay/mcp/server.mjs"] } } }
```

Then just ask: *"How's our AI visibility this week?"* — or, on a fresh install,
*"Set up tracking for Acme vs Jotta and EchoPad"* and the agent will draft your
prompt panel, quote the run cost, and report honest numbers. The optional
operator skill in `skill/` teaches it the full playbook (copy to
`~/.claude/skills/hearsay-ai-visibility/`).

The server reads a running Hearsay at `HEARSAY_URL` (default
`http://127.0.0.1:3000`).

> **Status: pre-release.** Measurement, metrics, alerts, the demo seeder, the agent
> surface (13 MCP tools + operator skill) and the CLI are built and tested; v0.1 ships
> after the release pass. This README is written in full per §16 of the implementation
> plan at that point: pitch, agent demo, light/dark screenshots, self-host checklist,
> features (including what Hearsay refuses to build), cost calculator, comparison
> table, methodology summary, roadmap, contributing, disclaimer, licence.

MIT licensed. Not affiliated with OpenAI, Anthropic, Google or Perplexity; trademarks
belong to their owners.
