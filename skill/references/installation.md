# Installation, upgrades and removal

Install the skill in a host with web access. It needs no Node, SQLite, MCP server, daemon, registration or Hearsay dashboard. Save project data in the workspace's `.hearsay/<app-id>/`, outside the installation directory.

## Portable skill

Extract `hearsay-portable.tar.gz`. Copy the complete `hearsay` folder into your host's skill directory. Keep `references`, `templates` and `schemas` beside `SKILL.md`. Codex discovers workspace skills under `.agents/skills/hearsay`; Claude Code discovers `.claude/skills/hearsay`. Refresh the host's skill list.

Ask: "Use Hearsay to track https://my-app.example, discover its competitors, investigate its visibility, and recommend improvements."

The current agent begins research. Extra CLIs require selection. If fresh independent sessions are unavailable, the first report is a sourced research audit without independent recommendation rates.

## Host bundles built from source

Maintainers generate every distribution with `node scripts/build-bundles.js` from the repository. This build step needs Node; using the portable skill does not. It writes four archives and local marketplace directories under `dist/`. It does not publish anything.

Codex plugin, from the repository directory:

```sh
codex plugin marketplace add "$PWD/dist/codex"
codex plugin add hearsay@hearsay-local
```

Claude Code plugin:

```sh
claude plugin marketplace add "$PWD/dist/claude"
claude plugin install hearsay@hearsay-local
```

Gemini CLI extension:

```sh
gemini extensions install "$PWD/dist/gemini/hearsay"
gemini skills list
```

Review the local extension trust prompt. The extension adds the same skill without MCP. Host installation does not authenticate a provider or enable measurements. If a host cannot use your account, use the portable skill in your existing agent.

If distributing only a plugin archive, extract it as `hearsay/` in a local marketplace directory. Register that directory using the host's local marketplace manifest. Generated `dist/codex` and `dist/claude` directories provide complete examples. Archives contain the plugin manifests and actual skill resources.

## Upgrade and remove

For portable upgrades, back up the old installed folder and replace the whole skill folder. For plugins, rebuild or extract the new package and use the host's plugin update command. During development with an unchanged version, uninstall and reinstall from the generated local marketplace. For Gemini, uninstall and reinstall the extension from the new directory. Refresh the host and check that Hearsay appears.

Remove a portable installation by deleting only its installed `hearsay` folder. Remove plugins with `codex plugin remove hearsay@hearsay-local` or `claude plugin uninstall hearsay@hearsay-local`. Remove the extension with `gemini extensions uninstall hearsay`. Remove an unused local marketplace through the host's marketplace command if desired.

Workspace reports and drafts survive these operations. Disable recurring schedules before removing the optional runtime. Removing a skill does not disable an external scheduler.

## Optional runtime

From a source checkout with Node 22.13 or newer, run `node bin/hearsay.js --help`, or install the local executable with `npm link` and use `hearsay --help`. It calls core services directly without the HTTP server. `npm unlink --global hearsay` removes the executable link and preserves project history. See [CLI execution](cli.md) for consent, limits and scheduling, or [dashboard connection](dashboard.md) for optional imports.
