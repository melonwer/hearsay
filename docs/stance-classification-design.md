# C08 stance and correction design

## Problem

The existing `mentions.recommended` bit comes from trigger proximity and answer position. It can mark an explicit rejection as a recommendation. Historical answers and that bit are receipts: changing the classifier must not rewrite them or recalculate old rates without a selected revision.

## Usage

Both runners stamp `stance-en-v1` on a target before a provider call. At completion, `analyzeResponse(text, entities, citations)` returns deterministic mentions with a conservative stance decision. The runner saves each mention and its automatic interpretation in the same transaction as the answer and evidence.

An answer review selects a response, an interpretation revision, and a correction cutoff. It returns the unchanged answer, mention and interpretation IDs, the automatic stance with rule and text span, the effective stance, correction history, the cutoff, and a method label. A correction posts an interpretation ID, the correction ID the reviewer saw, a replacement stance, a reason, and a request ID. The server appends one event and returns the same review representation.

A new recommendation rate selects an exact capture-time analysis revision and correction cutoff. It counts positive responses over all eligible answers and also returns negative, neutral, uncertain, and absent counts. Absence means no detected mention; it is never a neutral interpretation. Legacy rates retain their stored heuristic bit and carry `method: 'legacy_heuristic'`.

## Shape

```js
/** @typedef {'positive'|'negative'|'neutral'|'uncertain'} Stance */
/** @typedef {{start:number,end:number}} AnswerSpan */
/** @typedef {{stance:Stance,ruleId:string,span:AnswerSpan,reviewFlags:string[]}} StanceDecision */
/** @typedef {{mentionId:number,interpretationId:number,analysisRevision:string,
 *   method:'positive_stance'|'legacy_heuristic',original:StanceDecision|null,
 *   legacyRecommended:0|1|null,effective:Stance|null,correctionId:number|null,
 *   corrections:Correction[],recommended:0|1}} MentionReview */
/** @typedef {{id:number,originalValue:string,previousValue:string,replacement:Stance,
 *   reason:string,createdAt:string}} Correction */
```

Schema v7 adds `mention_interpretations`, unique on `(mention_id, analysis_revision)`. New rows contain the automatic stance, rule ID, UTF-16 answer offsets, and review flags. A migration derives legacy rows from the saved `recommended` bit without changing `responses` or `mentions`; a legacy row retains the boolean as a boolean and has no invented four-way stance or evidence span. Null historical response revisions are read as legacy without backfilling that receipt field.

`mention_corrections` is append-only and references one interpretation. Each event stores the original automatic value, the effective value immediately before the correction, replacement, reason, server timestamp, predecessor ID, and unique request ID. A transaction validates ownership and revision, rejects stale predecessor IDs, and makes an identical request retry return its existing event. Database triggers reject updates to interpretation and correction rows. Deletion is confined to existing explicit response or project teardown paths.

`core/analyze.js` owns alias matching and pure stance rules. A definite label requires a supported English claim attributed to the named entity. Explicit rejection beats positive proximity; mixed, conditional, quoted, unsupported-language, or ambiguous claims are uncertain. Position and nearby praise alone never make a brand positive. Every decision records a rule and span into the immutable answer. An explicit entity ambiguity flag can request review; the classifier does not infer identity from a hidden word list. The legacy `recommended` compatibility value for a new mention is `1` only for positive, while the stored value remains the original capture-time value after a later correction.

`core/interpretations.js` owns one effective projection for answer reads and metrics. It resolves `current` to the highest correction ID once inside a read transaction, then selects the last correction with `id <= cutoff` per interpretation. The same projection builds UI/API/MCP answer data and the SQL relation used by rates. A missing interpretation for a new-revision mention is an integrity error, never absence. Legacy uncorrected reviews show the heuristic boolean with a disclosure and no fabricated stance. A human correction can change a legacy review view but never changes its historical measurement rate.

Measurement rates filter `responses.analysis_revision` first, then select that revision's interpretation. A later explicit reanalysis can add another interpretation row for a stored mention, but cannot move the response into a new measurement series. Review tools may select the later revision; C14 review snapshots must save both selected interpretation revision and correction cutoff. C09 will add full profile and benchmark scope to this same selection.

`core/alerts.js` suppresses gained/lost recommendation alerts for new or mixed-revision series. Existing alert records stay readable. `web/queries.js` exports both new tables and carries stable mention/interpretation IDs and revision into answer reads. The JSON correction route keeps the router's Origin check; the answers page uses the existing JSON form handler. MCP forwards that route and consumes the same review representation, without a second classifier.

## Synthesis decision

The versioned interpretation design from arena candidate 2 is the base. Candidate 1 contributed mandatory `positive_stance` versus `legacy_heuristic` method labels, the immutable compatibility-bit rule, and the rule that legacy corrections do not recalculate legacy rates. The independent judge scored the candidates 24/25 and 19/25 respectively. The one-to-one interpretation table was rejected because it cannot retain a later automatic reanalysis for the same stored mention. Mutable stance columns and a single mixed machine/human event stream expose historical reconstruction rules to every reader.

## Tradeoffs and first implementation step

The design accepts extra joins for reproducible correction cutoffs and accepts lower definite-label coverage for fewer false positive recommendations. It leaves provider answers and original mention receipts immutable. First add the schema and a pure, human-labeled classifier fixture; then wire both runners before exposing correction routes or new rates.
