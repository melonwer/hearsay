# Review a buyer-focused benchmark

Open `/setup` on your local Hearsay server. Name your brand, then describe the buyer audience, the product or job, and the conversion you want. Language and market fields record planning preferences; Hearsay does not claim they set a provider's location or language.

Add questions you hear from buyers, with an optional source note for each phrasing. Source notes can identify a sales call, support ticket, or research conversation. They remain local and are not included in provider prompts. The **Draft starter questions** button uses a deterministic local pack: five intent groups, three editable phrasings each, and no provider call. You may track fewer. A competitor is optional. Discovery, comparison, and branded questions remain distinct; questions naming your brand are tagged branded.

Choose **Review selected questions** to save a draft and see the exact selected wording, categories, source notes, validation errors, and first-run target count. Drafting and review need no API key or subscription runner. Replace every unresolved placeholder, remove duplicate phrasings, and check the question wording before **Approve for tracking**. Approval writes the reviewed selection in one transaction. It does not start a run.

The first-run count is selected questions × samples × enabled routes, shown separately for API providers and subscription surfaces. API dollar estimates cover priced API usage only. Subscription calls use signed-in plan allowance and may incur overage. Configure at least one route before running. A locale preference in the draft is not an execution control.

## API and connected-assistant flow

`POST /api/prompts/suggest` returns the local starter. `POST /api/setup/drafts` accepts `{ "payload": { "version": 1, "context": { "audience": "...", "productJob": "...", "desiredConversion": "..." }, "brand": { "name": "..." }, "competitors": [], "intents": [{ "label": "...", "category": "general", "paraphrases": [{ "text": "...", "sourceNote": "...", "selected": true }] }] } }`. The draft can be updated with `PUT /api/setup/drafts/:id` and its current `revision`.

`GET /api/setup/drafts/:id/review` returns the current `revision`, `reviewHash`, selected question details, errors, and route target counts. Present that exact review to the human. `POST /api/setup/drafts/:id/approve` requires `{ "revision": 1, "review_hash": "...", "approve": true }`. A stale revision or hash rejects the approval with no partial writes. Repeating an already approved request returns its saved receipt.

The older `POST /api/setup` and direct `POST /api/prompts` endpoints require `reviewed: true` when activating tracking questions. That flag means the caller has shown the exact text to the human; it is not a substitute for actually doing so. Exploration questions remain separate until an explicit reviewed promotion.

## Revisions and earlier answers

Changing a question, intent, competitor, brand, alias, or domain changes the benchmark definition. The active panel must be reviewed again before a tracking run. The Prompts page has **Review active panel** for this. Runs already queued retain their selected question text and benchmark snapshot. A later run records a new benchmark revision. Changing buyer context or a local source note does not change the measurement identity.

Older installations can contain tracking questions with an `approved_at` timestamp but no proof of an exact review. Hearsay marks these as **review needed** and pauses new tracking runs until the active panel is reviewed. Historical answers remain available. `GET /api/export` includes drafts and private notes; handle that local export accordingly.
