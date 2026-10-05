# Installation, upgrades and removal

Install Hearsay in your agent, then ask it to study your product. It guides setup using the context it already has. Complete bundles include the skill and local runtime. Host research needs no server or extra provider account; automated collection needs Node 22.13 or newer. Save project data in the workspace's `.hearsay/<app-id>/`, outside the installation directory.

## Portable skill

Extract `hearsay-portable.tar.gz`. Copy the complete `hearsay` folder into your host's skill directory. Keep `runtime`, `references`, `templates`, and `schemas` beside `SKILL.md`. Codex discovers workspace skills under `.agents/skills/hearsay`; Claude Code discovers `.claude/skills/hearsay`. Refresh the host's skill list. Copying only the source `skill/` directory still supports host research but does not include the packaged runtime.

Ask: "Use Hearsay to study my product. Use what you already know, ask for any missing details, and propose the questions, limits, and schedule."

The current agent begins research. Extra CLIs require selection. If fresh independent sessions are unavailable, the first report is a sourced research audit without independent recommendation rates.

## Host bundles built from source

Maintainers generate every distribution with `node scripts/build-bundles.js` from the repository. This build step needs Node; using the portable skill does not. It writes four archives and local marketplace directories under `dist/`. It does not publish anything.

For a GitHub branch that already contains a generated Codex marketplace directory, install without cloning or building:

```sh
codex plugin marketplace add https://github.com/OWNER/REPO --ref BRANCH --sparse dist/codex
codex plugin add hearsay@hearsay-local
```

If the branch does not contain `dist/codex`, clone the branch and run the build command above first. A source checkout alone is not an installed plugin. After installation, confirm the host reports Hearsay enabled before beginning conversational setup.

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

Review the host's installation and trust prompts. Each package adds the same skill and runtime without mandatory MCP. Installation does not authenticate a provider, spend credits, or enable a task. The agent detects available routes and helps with missing login or secret setup through [conversational setup](setup.md). The Gemini extension does not add a Gemini CLI measurement route.

If distributing only a plugin archive, extract its `hearsay/` package into a local marketplace directory and register it with the host's local marketplace manifest. Generated `dist/codex` and `dist/claude` directories provide complete examples. The Gemini archive contains its extension directory directly. Use [setup](setup.md) for installation-relative runtime paths.

## Upgrade and remove

For portable upgrades, back up the old installed folder and replace the whole skill folder. For plugins, rebuild or extract the new package and use the host's plugin update command. During development with an unchanged version, uninstall and reinstall from the generated local marketplace. For Gemini, uninstall and reinstall the extension from the new directory. Refresh the host and check that Hearsay appears.

Remove a portable installation by deleting only its installed `hearsay` folder. Remove plugins with `codex plugin remove hearsay@hearsay-local` or `claude plugin uninstall hearsay@hearsay-local`. Remove the extension with `gemini extensions uninstall hearsay`. Remove an unused local marketplace through the host's marketplace command if desired.

Workspace reports and drafts survive these operations. Inspect and reconnect tasks when an update changes their runtime paths or versions. Cron schedules use `study schedule-inspect` to detect changed references; preview and approve the replacement before reconnecting. Disable recurring schedules before removing the runtime. Removing a plugin does not disable an external scheduler.

## Included runtime

The agent invokes `node ABSOLUTE_PLUGIN_DIRECTORY/runtime/bin/hearsay.js` for setup, study collection, and reports. It calls core services directly without an HTTP server. Node comes from the host environment; packages do not download it or provider CLIs on installation. You can also use `node bin/hearsay.js --help` from a source checkout or `npm link` for a local executable. See [CLI execution](cli.md) and [dashboard connection](dashboard.md) for existing optional workflows.
