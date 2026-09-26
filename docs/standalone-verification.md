# Standalone workflow verification

Verified locally on 2026-09-26. The canonical skill, four bundle generators, optional command runtime, scheduling, and research dashboard import are implemented. This receipt covers local verification; no package publication or deployment was performed.

## Reproduce the checks

```sh
npm test
npm run typecheck
npm run build:bundles
npm run verify:bundles
```

The repository suite passed all 576 tests and type checking. Tests cover evidence eligibility, mixed tool streams, partial failures, execution consent, scheduling, import conflicts, and archive contents. Host bundle discovery passed in isolated Codex 0.157.1, Claude Code 2.1.220, and Gemini CLI 0.61.0 configurations without inference.

An independent agent used the packaged skill to produce two sourced Listmonk research audits and three unapplied drafts. These were research audits with no independent measurement claim. Dashboard import, comparison, and opportunity review passed at 390px and 1280px without adding imported observations to native measurement tables.

## Account CLI evidence

The authorized Codex trial completed in 24.8 seconds and exposed one completed search, four queries, 36 returned sources, and five final citations. The current event shape is covered by [parser tests](../test/agent-live-profile.test.js).

The authorized Antigravity 1.2.11 trial completed in 22.2 seconds and exposed two completed searches and nine final citations. The [captured fixture](../test/fixtures/agy-1.2.11-captured-web.jsonl) and [adapter tests](../test/agy-agent.test.js) verify extraction without another provider call. Unrelated advertised or executed tools remain trace data and do not invalidate web evidence. `agy-search-v2` retains fresh-session context separately from tool availability.

Neither captured stream exposed a model identity, so these trials cannot establish same-model comparisons. Antigravity did not expose structured returned sources; its answer links remain final citations. Native credential refresh was not exercised. Claude live inference was not selected. Scheduled execution was tested without installing a recurring job on the local machine.

Original captures, generated reports, screenshots, and machine-specific audit files remain local. Installable archives are generated into `dist/`; [installation guidance](../skill/references/installation.md) covers each host.
