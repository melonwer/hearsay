# Plugin verification receipt

Date: 2026-10-05

The four generated archives were extracted into temporary directories outside the source checkout. Each installed runtime ran `doctor`, `setup save`, `study create`, and `study preview` with an empty `PATH` and no source `node_modules`. The package tests also checked source closure, archive paths, executable mode, secret and workspace exclusions, optional dashboard imports, and replacement of the package while an external study history remained intact.

The isolated workflow verifier used fake CLIs, a fake Tavily response, and a fake crontab. It ran each archive as portable, Codex, Claude Code, and Gemini. It rejected ambiguous product identity and changed identity before writing, made no searches or CLI measurements before the exact approved study preview, and resumed after the fixture login and key became available. The approved fixture collected six Tavily searches and six account CLI measurements. The CLI environment never received the Tavily fixture value, and the value did not appear in saved records or command output.

The collector left one analysis due. A host analysis record cleared it and produced the local report. The schedule preview exposed the six questions, UTC time, route ceiling, command, and collector-only analysis state. Fake cron installation backed up and preserved an unrelated entry, rejected stale consent, and removed the job. A run two days late recorded two missed occurrences and made no provider calls. Replacing the installed archive left the project, raw page capture, reports, and decisions byte-for-byte unchanged.

Final review regressions also proved that a native task uses the approved study tick without requiring cron state; current inspection and reports detect a missing cron job; removal of an old collector preserves a newer native task; custom Codex and Claude credential locations match between login probes and measurements; and selected provider authentication, quota, or executable drift stops recurring collection before later providers spend. Antigravity retains its native keyring readiness check and requires the existing successful search-verified baseline. Native task installation and runtime identity checks remain the host's responsibility, with the comparison instruction saved in the task preview.

Host discovery ran against isolated temporary Codex, Claude Code, and Gemini configurations:

| Host | Version | Result |
| --- | --- | --- |
| Codex | 0.160.0 | Skill discovered and installed runtime passed |
| Claude Code | 2.1.220 | Skill discovered and installed runtime passed |
| Gemini CLI | 0.61.0 | Extension discovered and installed runtime passed |

The Gemini package is a skill host. It does not claim a Gemini CLI measurement route. The implemented account routes remain Codex, Claude Code, and Antigravity.

Checks run in the implementation worktree:

- `node --test`: 702 passed, 0 failed.
- `tsc -p jsconfig.json --noEmit`: passed.
- `node scripts/check-runtime-deps.cases.mjs`: 4 passed.
- `node scripts/build-bundles.js`: generated portable, Codex, Claude, and Gemini archives.
- `node scripts/verify-plugin-runtime.js`: four isolated archive workflows passed, with zero live calls.
- `node scripts/verify-skill-discovery.js`: Codex, Claude Code, and Gemini discovery and installed-runtime checks passed.
- `git diff --check`: passed.

No real provider search, credential retrieval, personal host configuration change, real cron edit, server startup, publication, push, or merge was performed.
