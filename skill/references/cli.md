# Optional account CLI measurements

The portable skill needs no executable. Detect paths, versions and help without inference. Ask which installed routes to use and save that selection per project. Credential availability does not verify authentication. Never send slash commands as headless prompts to inspect configuration.

The optional Node runtime accepts these commands. Project means the directory containing project.json, normally `.hearsay/<app-id>`.

```sh
hearsay agents list --json
hearsay run --project .hearsay/my-app --json
hearsay run --project .hearsay/my-app --execute --confirm <preview-quote>
hearsay report --project .hearsay/my-app --run <id>
hearsay compare --project .hearsay/my-app --baseline <id> --run <id> --json
hearsay import .hearsay/my-app/runs/<id>/evidence.json --database /absolute/path/hearsay.db
```

`run` previews by default. The quote binds questions, routes, executable identities and limits. Matching saved consent permits `run --execute` without another prompt. Changes require a new quote. Diagnostics go to stderr. Exit codes are 0 success, 2 invalid input, 3 consent or selection, 4 authentication or profile, 5 execution or partial failure, 6 lock or conflict, and 7 unavailable scheduler.

Codex and Claude Code have separate account routes. Invocations use fresh-session profiles and strip API-key variables. Costs and remaining allowance are unknown unless exposed. Never substitute API prices, assume unlimited use, or fall back to another account or billing method. Authentication stays unverified until a selected invocation succeeds.

The Antigravity route is `agy-cli`, separate from `gemini-api`. The inspected version is 1.2.11 and the execution profile is `agy-search-v2`. It uses a fresh Linux home and workspace with bubblewrap, fresh settings and native keyring access, with credit overage disabled. The adapter extracts completed `search_web` events and preserves unrelated tool activity in the trace. Advertised tools do not determine whether web evidence is valid. New versions need compatibility validation. Gemini CLI measurement is not implemented; the Gemini extension installs the portable skill only.

Fresh-session isolation describes the context supplied to an invocation. It does not promise exclusive web tool availability or identical configuration across users. Record actual provider, version, profile and exposed model; keep results separate when these differ. Unknown context stays unknown.

Antigravity may expose search queries and completed outcomes without structured sources. Keep returned sources unavailable and preserve visible answer links as final citations. Traces contain observable events with credentials excluded; no complete internal reasoning capture is promised.

Prefer a host scheduler. Otherwise preview a daily schedule and enable the exact quote after reviewing timezone and target ceiling:

```sh
hearsay schedule preview --project .hearsay/my-app --at 09:00 --timezone Europe/Berlin --ceiling 6
hearsay schedule enable --project .hearsay/my-app --at 09:00 --timezone Europe/Berlin --ceiling 6 --confirm <schedule-quote>
hearsay schedule inspect --project .hearsay/my-app --json
hearsay schedule disable --project .hearsay/my-app
```

Enabling saves configuration. Arrange the printed absolute `schedule tick` command in the host scheduler. Add `--install-cron` only when the user requested Linux/macOS cron installation. It preserves unrelated entries and backs up the previous crontab. Scheduling requires a reviewed panel, saved selection, on-demand consent and a successful search trial for each route. Authentication or quota failures stop it. Missed occurrences stay missed, with no automatic catch-up. Other systems retain manual repeats.
