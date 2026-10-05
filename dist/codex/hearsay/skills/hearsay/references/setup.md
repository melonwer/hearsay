# Set up Hearsay through conversation

Start from the product context you already have. A founder should not need to read installation documentation or edit JSON. You inspect capabilities, infer the product, write the records, and explain the actual proposed study before enabling collection.

## Find the installed runtime

Use the directory containing this skill's `SKILL.md`, never the caller's current directory, to resolve the installation. In Codex, Claude Code, and Gemini packages, the runtime is at `../../runtime/bin/hearsay.js` relative to that directory. In the portable package it is at `runtime/bin/hearsay.js`. In a source checkout it is at `../bin/hearsay.js`. Resolve an absolute path and verify that it exists.

Keep project files in the founder's workspace at `.hearsay/<app-id>/`. Never put them inside the installed skill or runtime. Always pass an absolute project or study path to the bundled executable.

Check Node availability before invoking the executable. The runtime needs Node 22.13 or newer. If it is missing, continue research using host tools and save or return portable evidence. Explain that automated collectors need Node. When the founder requests runtime setup and local installation is allowed, use the host's normal verified installation method. Do not silently change system settings or promise that a Node command ran.

## Inspect before asking

Run `node ABSOLUTE_RUNTIME_PATH doctor --project ABSOLUTE_PROJECT_DIR --json`. Supply actual host capabilities through `--host-capabilities ABSOLUTE_JSON_FILE` when useful. Those are host reports, not runtime observations. The runtime cannot infer which web tools, schedulers, or permissions the current AI session has.

Inspection discovers supported account routes without running inference. Installed, compatible, login available, and measurement verified are different facts. A present Tavily key is not a completed authentication or search trial. The Gemini extension is a skill host; Gemini CLI measurement is not implemented. Codex, Claude Code, and the supported Antigravity profile have their own measurement routes.

Use existing session context, the public site, repository, and saved Hearsay records to infer name, canonical URL, audience, buyer jobs, geography, and the intended outcome. Save source references and identify which profile fields they support. Session statements are session sources; do not turn them into fetched-page receipts.

If the product is clear, say what you found and proceed with a setup draft. If the URL is missing and cannot be established from context, ask for the product or its website. If multiple products or conflicting saved identities exist, ask which to study before writing. Geography, business outcomes, or buyer jobs that cannot be established stay unknown. Ask about them when the answer changes the plan.

For example, an agent that already knows the product can say: "I'll study Drip Score's outfit-photo feedback for people choosing what to wear. I found the product site and will propose buyer questions from its current features." An agent without context can ask: "Which product or website should Hearsay study?" Do not repeat product questions answered by reliable current evidence.

## Save setup and prepare the project

Copy [setup.json](../templates/setup.json) into the project workspace as input, replace the example values with actual evidence, and run:

```sh
node ABSOLUTE_RUNTIME_PATH setup save --project ABSOLUTE_PROJECT_DIR --input ABSOLUTE_SETUP_JSON --json
node ABSOLUTE_RUNTIME_PATH setup inspect --project ABSOLUTE_PROJECT_DIR --json
```

The runtime saves a versioned non-secret setup profile and creates a valid empty `project.json` for a new workspace. It preserves an existing project's panels, execution revisions, runs, and studies. An explicitly supplied complete project must satisfy the existing [evidence contract](evidence.md). Setup does not approve a provider, a question panel, or a schedule.

Next write the sourced discovery evidence and exact proposed buyer questions into the project contract, using [project.json](../templates/project.json). Evidence IDs used by study angles must resolve in `project.discoveryEvidence`. Create the plan with [website studies](studies.md). Do not use the example template's dates, URLs, or text as observations.

## Connect available providers

Reuse already configured credentials and compatible authenticated CLIs when the founder selects them. Save executable identities and bounded limits in the proposed execution revision. Configure non-secret paths and settings yourself; do not ask the founder to edit files you can safely write.

For a missing Tavily key, use a host-provided secret input or credential manager when one is available. Otherwise give the founder the exact environment or credential-store action and resume after they finish. The runtime reads `TAVILY_API_KEY`. Never ask for a key as normal chat content, print it, include it in a command transcript, or write it into a study. You cannot create an account or recover a missing key from evidence.

For unauthenticated account routes, open or describe the supported interactive login when authorized, let the founder complete the login, then rerun the status probe. Do not substitute an API key or another account. A version or help probe never spends a measurement allowance.

Continue host research when optional providers are absent. Offer an audit with its actual sources instead of blocking all useful work on a credential.

## Present one actual collection proposal

Explain the product profile, buyer angles, questions, selected providers, expected usage, ceilings, duration, review date, and stop rules in ordinary language. Propose daily collection only when useful. Ask whether the founder wants manual collection, a connected agent task, or a cron collector. Infer the local timezone and propose a time, then let the founder adjust them.

Prepare exact account routes through `study prepare-routes` when selected, then obtain the founder's decision on the final study preview. The founder approves the scope in conversation; you pass the saved preview hash to `study approve`. Never require the founder to copy a hash or run a command. Once the approved scope matches, routine work proceeds without repeated approval requests.

The collection approval binds exact questions, provider identities, limits, and recurring study inputs. An on-demand request alone does not authorize installing a recurring task. Page application, publication, and external delivery keep their applicable separate scopes.

## Connect and verify recurring work

Prefer a host agent task capable of collecting and analyzing in one session. Run `study schedule-preview --study ABSOLUTE_STUDY_DIR --input OPTIONS_JSON` with `{"kind":"host"}` to get its exact scope and repeat instruction. Install through the host only after the founder approves the task. Verify its job ID, time, timezone, and repeat instruction, then save the receipt with `study connect`. Task availability and plugin installation are not proof a task exists.

The host owns a native task's installed path and runtime identity. Save the host preview's runtime identity and quote in the task receipt. Before each native repeat, compare a fresh host schedule preview with that approved quote. A moved or changed runtime requires a fresh scheduler decision and reconnection. The runtime verifies cron identity itself.

For an approved Linux or macOS cron fallback, preview with `{"kind":"cron"}`. Explain that it collects evidence and leaves agent analysis due. Cron does not inherit the agent's current shell environment; its provider credentials must be available through the runner's existing secure environment. If that environment is unavailable, use manual runs or a host task and report the required credential step. Never place a key in a cron command.

```sh
node ABSOLUTE_RUNTIME_PATH study schedule-preview --study ABSOLUTE_STUDY_DIR --json
node ABSOLUTE_RUNTIME_PATH study schedule-install --study ABSOLUTE_STUDY_DIR --confirm PREVIEW_HASH --author FOUNDER --json
node ABSOLUTE_RUNTIME_PATH study schedule-inspect --study ABSOLUTE_STUDY_DIR --json
node ABSOLUTE_RUNTIME_PATH study schedule-remove --study ABSOLUTE_STUDY_DIR --json
```

The runtime verifies cron installation and removal, backs up the previous crontab, and preserves other jobs. It checks due occurrences every minute while the approved local time controls collection. Missed occurrences remain missed. The machine must be online. A changed plan or missing/replaced runtime needs repair and reconnection before collection.

On upgrades, inspect any existing tasks, preserve all workspace records, and reconnect changed runtime paths under a new scheduler preview. Plugin removal does not remove external jobs; disable them first. A resumed agent analyzes pending occurrences even if no collector is currently connected.
