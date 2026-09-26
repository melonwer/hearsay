# Antigravity capture provenance

`agy-1.2.11-captured-web.jsonl` derives from the authorized 2026-09-26 neutral-question invocation of agy 1.2.11, lasting 22.2 seconds. It retains init, search tool updates and the terminal result. The full credential-redacted capture remains in `.audit/standalone-evidence/agy/stdout.jsonl`. The fixture omits incremental answer text and user-input events; it does not simulate a second invocation.

Two completed searches and final citations were exposed. Returned-source metadata and model identity were unavailable. The init inventory advertised unrelated tools despite the custom tool list. Under the user's corrected acceptance contract, that inventory does not invalidate web evidence. Parsing extracts the two completed `search_web` calls and preserves other events. The invocation used a fresh masked home/workspace; this describes session context, not enforced exclusive web tool access. The original capture is unchanged.
