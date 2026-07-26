# Hearsay — Demand & Competitive Synthesis (2026-07-26)

## 1. Demand verdict

**Verdict: MODERATE demand** — strong demand for the *outcome* (auditable, affordable AI-visibility measurement), unproven demand for the *artifact* (a self-hosted OSS dashboard).

**Reasoning chain:**

1. The pain is real, current, and articulated in Hearsay's exact vocabulary. Practitioners are measuring 20–30% run-to-run variance themselves, asking vendors "do they report the variance or hide it inside one score," and setting budgets under $300/mo (https://www.reddit.com/r/content_marketing/comments/1v1uf10/how_are_you_measuring_ai_search_visibility/). The category is well funded (Profound: $96M Series C at $1B, 700+ enterprise customers — https://finance.yahoo.com/news/exclusive-ai-threatens-search-profound-130000513.html; Peec: $0→$4M+ ARR in 10 months — https://peec.ai/blog/we-raised-21m-series-a-to-help-brands-win-in-ai-search), and Digiday confirms agencies are building in-house trackers specifically to escape $99–$1,000/mo pricing (https://digiday.com/marketing/marketers-question-expensive-ai-visibility-tools-as-inconsistent-results-fuel-skepticism/).
2. But the adversarial refuter's verdict was **"mixed / weakened,"** and its core evidence is hard to dismiss: Hearsay's near-exact clone already exists. elmohq/elmo — MIT, self-hosted, BYOK, explicitly "a self-hosted alternative to tools like Profound, Peec, and Otterly" (https://www.elmohq.com) — has 203 stars, essentially one developer (755 of ~815 commits), and pivoted monetization to a $1,950–$9,950/mo service after 11 months. aperture (same pitch) has 22 stars after 4.5 active months; the entire `ai-visibility` GitHub topic (247 repos) tops out at 621 stars (https://github.com/topics/ai-visibility). Open-source GEO launches on HN score 2–4 points even when self-hostable (Sonde: 2 pts/0 comments — https://news.ycombinator.com/item?id=47166396; Geostorm, an almost identical SQLite/no-workers/BYOK stack: 4 pts — https://news.ycombinator.com/item?id=47206476).
3. The tiebreaker: the traction shapes that DO work in this niche are agent skills/CLIs (gtm-engineer-skills 1,264★, geo-optimizer-skill 621★) and broad OSS platforms (open-seo 8,095★ in five months), plus the operational-simplicity self-host pattern (Vince 283 pts, Umami 820 pts on HN). Hearsay has legitimate, verified, still-unclaimed wedges — zero-dependency `node server.js` + built-in SQLite (no competitor at ≥97★ has this; GitHub code search confirms no AI-visibility tracker uses `node:sqlite`) and integrated statistical rigor across four engines — but they must carry the launch, because "open-source BYOK alternative to Profound" is demonstrably a dead framing.

**Best evidence FOR:** "Budget is under $300 a month. Which tools give you repeatable data across the same prompt sets instead of wrapping random outputs into one visibility score?" — a prospect writing Hearsay's spec unprompted, six days ago (https://www.reddit.com/r/content_marketing/comments/1v1uf10/how_are_you_measuring_ai_search_visibility/).

**Best evidence AGAINST:** elmo — the same product, a year of head start, 203 stars, no community, monetization pivoted away from the tool (https://www.elmohq.com, https://github.com/elmohq/elmo).

**Explicit weighing of the adversarial agent:** its "mixed" verdict is accepted on the artifact question and rejected on the underlying-need question. Where it overreaches: it treats star counts as the demand metric (the oss-landscape agent showed stars in this niche are noise — 339★ with 8 commits, 199★ with 1 commit), and its cost rebuttal ($75–200/mo) assumes sampling volumes Hearsay's user controls. Where it lands cleanly: three of four planned differentiators (BYOK, MCP/skill, "honesty" rhetoric) are already claimed by someone; only the deployment story and *operationalized* statistics are unclaimed.

## 2. Competitive landscape snapshot

**Commercial:**

| Tool | Price | Segment | One-line weakness |
|---|---|---|---|
| Profound | $99 (ChatGPT-only, 1 seat) → $399 → Enterprise (https://www.tryprofound.com/pricing) | Enterprise | Entry plan deliberately crippled; API/SSO/Claude/multi-brand all Enterprise-gated; public data-provenance fight on Reddit |
| Peec AI | $95–$495/mo, Enterprise custom (https://trakkr.ai/reviews/peec-review/pricing) | Mid-market + agency | Self-serve tiers get only 3 of 6 models; API/MCP/SSO are paid line items |
| Otterly.ai | $29–$489/mo + engine add-ons (https://otterly.ai/pricing/) | SMB | Claude alone costs $29–$439/mo extra as an add-on |
| Rankscale | $20–$780/mo, credit-based (https://rankscale.ai/pricing) | SMB→agency | Credit metering; no free tier |
| Scrunch AI | $250–$500/mo (https://scrunch.com/pricing) | Enterprise/agency | $250 floor; acquired by Sitecore (~$225M) — integration drift risk |
| Knowatoa | $59–$199/mo (https://www.knowatoa.com/pricing) | SMB | Hides its question limits — opacity Hearsay can attack |
| Semrush AI Toolkit | $99/mo **per domain**, 25 prompts (https://www.semrush.com/pricing/ai/) | Suite | Grok/Claude Enterprise-only; per-domain metering kills agencies; now Adobe-owned |
| Ahrefs Brand Radar | Free checker → $398–$699/mo (https://ahrefs.com/ai-visibility-checker) | Suite | One-shot snapshot free tier; a user called the paid product "vibecoded slop" |
| HubSpot AEO | Free grader; $50/mo continuous (https://www.hubspot.com/ai-search-grader) | SMB | One-time snapshot from training data; compresses Hearsay's price delta to ~5–10x |
| Sitefire (YC W26) | $249–$499/mo (https://news.ycombinator.com/item?id=47457472) | SMB/brand | Left HN's affordability and personalization questions unanswered; content-gen angle triggers "slop" hostility |
| Google Search Console gen-AI reports | Free (https://www.cmswire.com/digital-experience/google-adds-ai-visibility-reports-to-search-console/) | Everyone | Google surfaces only; impressions, no answer text or share of voice |

**Open source:**

| Project | Stars (2026-07-26) | One-line weakness |
|---|---|---|
| every-app/open-seo | 8,095 (https://github.com/every-app/open-seo) | Broad SEO suite; AI-visibility module shallow; needs paid DataForSEO key |
| Auriti-Labs/geo-optimizer-skill | 621 | Audit/CLI toolkit, not continuous monitoring; $19/mo commercial arm |
| danishashko/geo-aeo-tracker | 209 (https://github.com/danishashko/geo-aeo-tracker) | Needs paid Bright Data; IndexedDB not a real DB; 28 commits, 1 contributor |
| elmohq/elmo | 203 (https://github.com/elmohq/elmo) | Docker+Postgres+pg-boss; zero sampling/CI code; open-core drift toward cloud billing |
| onism1767-creator/potato | 199 (https://github.com/onism1767-creator/potato) | Ships Wilson 95% CIs + "not distinguishable" rule — but Claude-only, 1 commit, one-shot |
| getcito | 146 | Near-verbatim elmo derivative |
| oneglanse | 135 | PG+ClickHouse+Redis; abandoned since 2026-05-10; but pre-frames the API-vs-UI attack |
| Canonry | 97 (https://github.com/Canonry/canonry) | FSL-1.1 (not OSI); already ships MCP + Claude Code plugin + variance reporting |
| ansvisor | 57 | 40 contributors; already claims the "no black box" narrative rhetorically |
| aperture | 22 | Unencrypted keys in SQLite, no auth — the naive version of Hearsay, half-finished |

**Most dangerous competitor: every-app/open-seo.** The research agents split here — the saas-landscape agent framed elmo as "the real competitive threat," while the oss-landscape and refuter agents pointed at open-seo — but open-seo wins the risk ranking: 8,095 stars and 885 forks in five months, MIT, already lists "AI Visibility" as a core workflow, already ships an MCP server for Claude Code, and monetizes via a $10/mo hosted tier. If it deepens the AI-visibility module even modestly, it becomes the default answer by distribution alone. elmo is the closest *clone* but also the strongest proof that the clone doesn't win; open-seo is the one that can absorb the category. Hearsay must be visibly narrower and deeper: measurement methodology, not another dashboard.

## 3. Pain points ranked by evidence

Three of the top eight pains are **PLAN GAPS**. That is the headline.

1. **Per-prompt / per-seat / per-engine metering rage** — 6+ independent sources (r/SEO, G2 via Scalenut, Digiday, HN, pricing pages). Best quote: "we have basically laughed some sales reps of these companies out the room. Prices feel insanely bloated for what they offer" (https://www.reddit.com/r/SEO/comments/1qdlxgr/are_ai_visibility_tools_becoming_another/). Otterly literally charges $29–$439/mo extra for Claude (https://otterly.ai/pricing/). **[v1 covers]** via BYOK — but see the contested cost claim in §5.

2. **Single blended scores hide variance; buyers now demand repeated sampling** — 6 sources (SparkToro, three independent r/content_marketing commenters, HN Hikoo thread, State of Brand). Best quote: "the variance between runs on the exact same prompt is like 20-30%. its basically useless for making content decisions right now" (https://www.reddit.com/r/content_marketing/comments/1v1uf10/how_are_you_measuring_ai_search_visibility/). **[v1 covers]** — Wilson CIs are the single most-demanded, least-delivered feature. Caveat: potato (199★) and RankCaster already claim CIs, contradicting the saas-landscape agent's "no competitor publishes CIs."

3. **Black-box methodology / data provenance distrust** — 6 sources (r/bigseo 82-upvote "scam" thread, Profound provenance fight, Semrush score thread, Conductor, The Verge, Plate Lunch). Best quote: "Wait, what do you mean you have the entire conversation? How is that even legal?" (https://www.reddit.com/r/SEO/comments/1o956k3/anyone_using_profound_and_done_due_diligence/). **[v1 covers]** — open source + local SQLite + no clickstream is the structural answer.

4. **Dashboards contradict manual checks; no receipts** — 4 sources. Best quote: "one tool straight up lied about tracking gemini prompts, another showed my site killing it but manual checks say bs" (https://www.reddit.com/r/SEO/comments/1sk8hda/dropped_2k_on_aeo_tools_this_quarter_and_got_zero/); a single comment finding hallucinated brand "SzkolnyTrip" ranked above Booking.com killed a launch (https://news.ycombinator.com/item?id=46145082). **[v1 covers]** — raw-answer explorer; demo it as "click any number to see the answer it came from."

5. **Prompt discovery — "I don't know which prompts to track"** — 4 sources (Peec's own blog verbatim, Amplitude PM's 100+ customer interviews finding Ahrefs' canned prompts "useless," Fishkin calling prompts "a giant hole," auto-geo shipping a `prompts discover` command). Best quote: "I hear this constantly from marketing managers: 'I don't know which prompts to track.'" (https://peec.ai/blog/how-to-choose-the-right-prompts-for-llm-tracking). **[PLAN GAP]** — nothing in v1 or roadmap. Without a first-run prompt generator the target marketer is stuck at the empty-textbox screen on day one.

6. **Prompt-phrasing variance dominates rerun variance** — 3 sources (arXiv paraphrase-brittleness paper, State of Brand margin-of-error fight, Fishkin's 0.081 cross-prompt similarity). Best quote: "Prompt-by-prompt mention tracking is therefore structurally unstable as a unit of measurement; meaningful improvement likely requires a different unit rather than a larger prompt set" (https://arxiv.org/pdf/2605.27440). **[PLAN GAP]** — Hearsay's CIs shrink the *rerun* error bar, which this shows is the smaller variance component. Needs paraphrase-set/intent-level sampling or the flagship differentiator is attackable by any sophisticated reviewer.

7. **API ≠ what users see (personalization, memory, routing, geo/IP)** — 5 sources (oneglanse's whole architecture, betterthangood's "precision laundering," Lily Ray via PPC Land, the unanswered Sitefire HN question, r/SEO_for_AI "completely different answers"). Best quote: "GPT 4.5, accessed via an API endpoint, is not ChatGPT" (https://betterthangood.xyz/blog/weighing-smoke/). **[PLAN GAP]** — the planned caveats page documents this but nothing in v1 measures or bounds it. This is a bias, not variance; CIs don't touch it.

8. **Actionability — "just a benchmarker" / "dopamine dashboards"** — 5+ sources (Barnard on SEL, ai-visibility.org.uk, Digiday, two r/SEO threads, Rankability's Peec review "Limited Actionability"). Best quote: "You're paying a monthly subscription to watch a number you can't control, can't reproduce, and can't act on" (https://www.ai-visibility.org.uk/blog/ai-visibility-trackers-waste-of-money/). **[PLAN GAP]** — no action layer (e.g., cited-domains gap report) anywhere in v1 or roadmap; honesty makes this objection *worse*, not better.

9. **Agency multi-client workspaces / pitch environments / white-label** — 4 sources (30-client agency shopping thread — https://www.reddit.com/r/DigitalMarketing/comments/1qzoxuv/is_there_an_ahrefs_style_ai_visibility_tracker/; Profound charging $399/mo for client workspaces — https://www.tryprofound.com/blog/best-ai-visibility-tools-for-marketing-agencies; Rankability; r/content_marketing demo-fatigue thread). **[roadmap covers]** multi-client mode; white-label reports appear nowhere in the plan — partial gap for the highest-value segment.

10. **Data freshness — 48h prompt refresh drives churn** — 2 sources, same thread. Quote: "it literally takes, like, I don't know, 48 hours" (https://www.reddit.com/r/SEO/comments/1rr0j7f/aeo_tools_that_are_good/). **[v1 covers]** — local on-demand batches are structurally faster; make "add a prompt, results in minutes" an explicit claim.

11. **Google AI Overviews is the biggest untracked surface** — 3 sources (Peec's 500k-prompt study: 86.7% of searches — https://peec.ai/blog/ai-overviews-is-the-most-undertracked-ai-search-500-000-prompts-show-why; Otterly selling it as add-on; but Google now gives free first-party reports — https://ppc.land/google-finally-gives-search-console-its-own-generative-ai-visibility-reports/). **[roadmap covers]** via SERP API. Correct call to keep out of v1 given GSC commoditization; keep prompt-level AIO (which GSC can't do) on roadmap.

12. **Alert delivery where teams live (Slack/email digests)** — 3 sources (Knowatoa weekly digests, Profound Slack thresholds — https://nicklafferty.com/blog/llm-tracking-tools/, Peec's changelog absence). **[roadmap covers]** webhooks v1.1; email/Slack are explicit v1 non-goals — acceptable, but webhooks should be the very first post-v1 ship.

## 4. Launch ammunition

**Pricing arbitrage:**
- "I built this because the hosted AI-search-visibility tools are super expensive. They charge $200–$1000/mo for what is, fundamentally, a loop over the OpenAI Responses API and Anthropic Messages API with web_search enabled, plus citation parsing. The CLI is MIT, runs on Bun, uses SQLite locally, and a typical weekly run costs ~$0.40 in API spend." — https://news.ycombinator.com/item?id=48196062
- "Literally just had a chat with a colleague about this and how we have basically laughed some sales reps of these companies out the room. Prices feel insanely bloated for what they offer" — https://www.reddit.com/r/SEO/comments/1qdlxgr/are_ai_visibility_tools_becoming_another/
- "My company is testing it out now. It's insanely pricey. Couple hundred for a couple seats... That said, you can get SOME useful insights out of it." — https://www.reddit.com/r/SEO/comments/1pd0856/has_anyone_use_profound/
- "Profound has a limited availability of prompts for the price... Profound's cost per prompt is higher than average, making it difficult to use Profound as my only tool." — G2 reviewer via https://www.scalenut.com/blogs/profound-ai-reviews
- "Claude, Google AI-Mode, Gemini as extra Add-ons" — Otterly's own pricing page, https://otterly.ai/pricing/

**Variance & methodology (the CI pitch):**
- "But, any tool that gives a 'ranking position in AI' is full of baloney." — Rand Fishkin, https://sparktoro.com/blog/new-research-ais-are-highly-inconsistent-when-recommending-brands-or-products-marketers-should-take-care-when-tracking-ai-visibility/
- "nobody has repeatable data yet... the variance between runs on the exact same prompt is like 20-30%. its basically useless for making content decisions right now" — https://www.reddit.com/r/content_marketing/comments/1v1uf10/how_are_you_measuring_ai_search_visibility/
- "Budget is under $300 a month. Which tools give you repeatable data across the same prompt sets instead of wrapping random outputs into one visibility score?" — same thread
- "take 5 buyer questions, ask each one in ChatGPT and Perplexity 10 times, and tally how often you show up. It's the same thing the paid tools automate, except you control the prompts. Only thing I'd watch for is any tool that crushes it into one magic score." — https://www.reddit.com/r/SEO/comments/1ug48kg/how_can_i_check_ai_visibility_for_free/

**Black box & provenance:**
- "Most of these tools are either glorified prompt engineering or completely delusional about what they actually accomplish, yet they're charging enterprise prices for basic automation that you could build yourself over a weekend." — https://www.reddit.com/r/bigseo/comments/1nkh6ux/geoaio_is_essentially_just_a_scam/
- "Wait, what do you mean you have the entire conversation? How is that even legal? Aren't the convos you have with LLMs private?" — https://www.reddit.com/r/SEO/comments/1o956k3/anyone_using_profound_and_done_due_diligence/
- "Nobody knows. SEMRush doesnt know what people actually prompt or what volume." — r/SEO moderator, https://www.reddit.com/r/SEO/comments/1t3p6n5/how_to_increase_semrush_ai_visibility_score/

**The blindness problem (hero-section material):**
- "Analytics tools show humans. SEO tools show Google. But AI traffic, fetches, and mentions are basically a black box. ... If AI is becoming a front door to the internet, most sites have no idea whether that door even opens for them." — https://news.ycombinator.com/item?id=46907123
- "Then clients started asking: 'Why don't we show up when people ask ChatGPT about our industry?' I had no answer." — https://www.reddit.com/r/SaaS/comments/1rcx2gu/spent_5k_on_content_that_gpt_never_cited_heres/
- "But if you're being honest, you know you're just charging extra for some monitoring." — agency owner, https://www.reddit.com/r/agency/comments/1poylds/how_are_you_handling_geo_for_clients_as_ai_search/

**Receipts:**
- "month 1 dashboards glow green, clients happy. month 2 reality hits, no citations, no traffic spike, just excuses from support. one tool straight up lied about tracking gemini prompts, another showed my site killing it but manual checks say bs." — https://www.reddit.com/r/SEO/comments/1sk8hda/dropped_2k_on_aeo_tools_this_quarter_and_got_zero/
- "I just checked travel industry on you website found non-existent brand 'SzkolnyTrip'. This brand more popular then Booking.com" — https://news.ycombinator.com/item?id=46145082

## 5. Fact-check results

| Plan stat | Status | What the README should cite now |
|---|---|---|
| "AI-visibility tools average $337/mo, median $99, range $20–$3,000" | **Confirmed but stale** (survey dated Aug 2025) | Cite as "as of Aug 2025" (https://rankability.com/blog/how-much-should-you-pay-for-ai-search-visibility-tracking-tools/) or replace with live 2026 anchors: Profound $99 ChatGPT-only / Otterly Claude add-on $29–$439 / Semrush $99 per domain |
| "68% of Google searches end without a click" | **Confirmed** — 68.01%, Jan–Apr 2026, US, Similarweb clickstream | Cite SparkToro June 2026 (https://sparktoro.com/blog/in-2026-less-than-one-third-of-google-searches-still-send-a-click/); note it excludes the Google mobile app, so true rate may be higher |
| "AI Overviews cut CTR ~60%" | **Confirmed, conditional** | Phrase precisely: "when an AI Overview appears (20%+ of searches), CTR falls nearly 60%" (https://searchengineland.com/google-zero-click-searches-2026-study-479717) |
| "Largest true OSS tracker has ~130 stars" | **REFUTED — most load-bearing error in the plan** | Delete entirely. geo-aeo-tracker is at 209★, geo-optimizer-skill 621★, open-seo (adjacent) 8,095★ (https://github.com/topics/ai-visibility-tracking undercounts; broader search refutes). Never compare on stars — compare on install friction, commits, and methodology |
| Sitefire Launch HN (id 47457472, YC W26, $249/mo) | **Confirmed** | Safe to cite; note Sitefire also does content generation, so it's not like-for-like (https://news.ycombinator.com/item?id=47457472) |
| Tim Soulo's 14-alternatives listicle exists, lists only paid/closed tools | **Confirmed, weak evidence** | Author is Ahrefs' CMO; his omitting OSS doesn't prove OSS absence (a 209★ tracker exists). Cite only as "the mainstream roundups list zero OSS options" (https://blog.timsoulo.com/14-peec-ai-alternatives-for-ai-search-visibility-tracking-2026/) |
| "$5–10/mo in API costs" (plan's own headline) | **Contested — agents contradict each other** | HN builder measured ~$0.40/week (https://news.ycombinator.com/item?id=48196062); Ritner Digital puts realistic sampling at $75–$200/mo for 30–50 prompts × 3–5 samples × 3 platforms weekly (https://www.ritnerdigital.com/blog/how-a-marketer-would-actually-build-their-own-ai-visibility-tracker-and-why-its-harder-than-it-sounds). Both are plausible at different volumes. Replace the flat claim with a live cost calculator (prompts × samples × engines × model price) |

## 6. Bear case and rebuttals

1. **"You're shrinking the wrong error bar."** The arXiv paraphrase study shows cross-paraphrase recommendation overlap (Jaccard 0.135–0.288) is far below same-prompt rerun overlap (0.50–0.61) — prompt choice, not rerun noise, dominates (https://arxiv.org/pdf/2605.27440); State of Brand adds that "A hundred clean repeats of an unrepresentative prompt is precise and still wrong" (https://www.thestateofbrand.com/news/ai-visibility-measurement-margin-of-error). **NOT defused by the current plan.** Fixable: sample paraphrase sets per intent and report CIs at the intent level. Without this, Hearsay's CIs are "precision laundering" bait.

2. **"API completions are not ChatGPT."** No memory, personalization, routing, or fan-out — "a mystery shopper filing reports... from a showroom that no customer ever visits" (https://betterthangood.xyz/blog/weighing-smoke/); Lily Ray et al. call the bias structural (https://ppc.land/llm-tracking-tools-face-accuracy-crisis-from-personalization-features/). **Partially defused.** Documented caveats + "logged-out discovery baseline, directional only" framing converts it from a gotcha into Hearsay's own claim — Fishkin himself flags API-vs-UI as open, not disqualifying. But it remains a validity ceiling no sampling removes; an empirical API-vs-UI comparison would defuse it far better than a disclaimer.

3. **"The channel is too small to justify any tracking spend."** Peer-reviewed: organic LLM traffic <0.2% of e-commerce visits, ~200x smaller than Google organic (https://organicllm.org/). **Mostly defused — by the price, not the honesty.** $5–50/mo of API spend is the only cost structure that survives a channel this small; $337/mo SaaS does not. The complex-category exception (4.6x traffic share) defines the real ICP. Hearsay's caveats page should state this stat itself.

4. **"Honest measurement of a noisy number nobody can act on is a thermometer nobody needs."** Barnard: "You can't fix inconsistency by measuring it more precisely" (https://searchengineland.com/ai-recommendations-inconsistent-fix-469250); Digiday's "It's just a benchmarker" (https://digiday.com/marketing/marketers-question-expensive-ai-visibility-tools-as-inconsistent-results-fuel-skepticism/). **NOT defused — honesty amplifies it.** Open risk until the roadmap commits to a minimal action layer (e.g., "domains cited instead of you, ranked by frequency").

5. **"The OSS version of this already exists and nobody came."** elmo 203★/1 dev, aperture 22★, sharozdawa 8★, category Show HNs at 2–4 points. **Partially defused.** The refuter is right that the *pitch* doesn't convert; but every prior attempt lacked at least one of: zero-dependency install (all require Docker/Postgres/ClickHouse or paid Bright Data/DataForSEO), operationalized statistics, and receipts. Those are exactly the proof points that earned Vince 283 points against Plausible (https://news.ycombinator.com/item?id=42270389). Still: set expectations that the base rate outcome in this topic is double-digit stars, and define success in users, not stars.

## 7. Recommended plan changes

**Positioning (do first):**
1. **Lead with "no Docker, no Postgres, no npm install — `node server.js`" plus operationalized CIs; demote "open-source BYOK alternative to Profound/Peec."** The alternative framing is verbatim taken by elmo/aperture/getcito and empirically converts at 2–22 stars; the zero-dependency claim is verified unique against every competitor ≥97★ (oss-landscape code search), and operational simplicity is what the successful self-host launches (Vince, Umami) were praised for.
2. **Replace the "$5–10/mo" claim with a transparent cost calculator and cost-estimate-before-run in the UI.** The claim is contested ($0.40/wk vs $75–200/mo); a false-precision cost claim from the "radical honesty" product is fatal — and cost estimation is literally an open feature request in elmo (#441).
3. **Never claim "largest/only OSS tracker" or cite star counts.** Refuted by the fact-checker; the field's stars are inflated garbage (339★/8 commits) and the claim invites a one-comment takedown.
4. **Explicitly refuse: rank positions, prompt-volume estimates, one blended score, and content generation — say so on the box.** Fishkin ("full of baloney"), Conductor ("fundamentally misleading"), the "one magic score" warning, and HN's moral revolt at Sitefire ("We help the brands, not the end user") each punish the opposite choice.

**v1 scope changes:**
5. **ADD: intent-level sampling — N paraphrases per intent, CIs reported per intent, with paraphrase variance shown separately from rerun variance.** Directly answers the strongest surviving critique (arXiv paraphrase brittleness); turns the flagship feature from attackable to state-of-the-art.
6. **ADD: first-run prompt generator (seed from URL/sitemap/pasted GSC keywords; quarantine brand-name prompts from the denominator).** "I don't know which prompts to track" is the #1 stated onboarding blocker (Peec's own words); without it the target marketer bounces on day one.
7. **ADD: day-one caveats page naming personalization, geo, IP class, API-vs-UI, model drift, and the <0.2%-channel-size stat.** The Sitefire founder's silence on exactly this question was the credibility hole in the comparable launch; Hearsay's positioning demands it be pre-written, not extracted.
8. **ADD: encrypted-at-rest API keys (or OS keychain) even in localhost-first mode.** aperture's known weakness is plaintext keys in SQLite; self-hosters check this within hours.
9. **KEEP: receipts explorer, deterministic recommendation heuristics, demo mode, JSON export — all validated.** The $2k-burned agency and the SzkolnyTrip kill-shot prove receipts + entity sanity checks are existential.
10. **KEEP AI Overviews out of v1 (GSC commoditized impressions), but add per-run "surface" labeling (web-search on/off per provider) to citation tracking now.** Ahrefs found only 13.7% citation overlap between Google's own two surfaces — collapsing surfaces into one number is exactly the dishonesty Hearsay indicts.

**Roadmap changes:**
11. **PROMOTE webhook alerts to first post-v1 ship; add white-label HTML/PDF client reports to the roadmap.** Agencies are the highest-value segment, Profound charges $399/mo for client workspaces, and white-label appears in zero incumbent changelogs.
12. **ADD a minimal action layer to the roadmap: "who gets cited instead of you" gap report.** Neutralizes the "just a benchmarker" objection without becoming a content-slop tool.
13. **ADD: run the paired API-vs-UI validation study (n≈100 prompts) and publish it as launch content.** Converts Hearsay's biggest methodological liability into its best distribution asset; Fishkin explicitly flagged it as open research.

**Launch mechanics:**
14. **Co-headline the MCP server + Claude skill ("for humans and agents").** Agent-native framing is the only measured ceiling-breaker in a dead HN category (Crawlie 20 pts vs 2–4 median; gtm-engineer-skills 1,264★ vs dashboards at ≤209★).
15. **Pre-answer the self-host checklist in the README (single license, no gated features, one-file SQLite export, no cloud tier coming) and submit to awesome-selfhosted.** The Plausible discussion shows silence on these questions loses users; the awesome-selfhosted AI-visibility slot is verified vacant (issue #2743 closed same-day).
16. **Before launch: load-test the demo, verify the install command from a clean machine, pre-write the Peec/Profound/elmo comparison table.** Broken demos and wrong install commands were the first comments on Umami (820 pts) and Crawlie.

## 8. Open questions

1. **What does Hearsay's default sampling design actually cost?** The $0.40/wk vs $75–200/mo contradiction is unresolved because it depends on prompts × paraphrases × samples × engines. Settle for ~$20: run the planned v1 default config against real APIs for a week and publish the token-level bill.
2. **How big is the API-vs-UI divergence really?** Nobody has published the paired measurement. Settle cheaply: 100 prompts, logged-out ChatGPT UI vs API, compare mention sets; publish. (Also the launch content — see rec #13.)
3. **Will in-house marketers self-host at all, or is the real audience GTM engineers?** Every traction signal (skill repos, HN) skews technical; every pain quote skews marketer. Settle with 10 customer-development calls from the quoted threads' demographics, or a "hosted demo waitlist" smoke test.
4. **Review-site sentiment is a blind spot.** G2, Capterra, TrustRadius, Trustpilot and SourceForge returned 403 to every research agent; all G2 evidence here is secondhand via a competitor's blog. Settle by reading G2 reviews of Profound/Peec/Otterly manually in a browser (an hour's work).
5. **r/selfhosted reception is untested.** The launch-comparables agent could not access r/selfhosted by any path (403 on reddit.com, old.reddit, .json, and Redlib mirrors); the self-host-community evidence substitutes Plausible/Cal.com proxies. Settle by posting a pre-launch "would you run this?" thread there.
6. **Does "Wilson 95% CI" language land with marketers, or does it need translation ("we show the error bar others hide")?** Settle with a 2-variant landing-page copy test before launch.
7. **Monetization shape, if any.** geo-optimizer-skill's $19/mo open-core and elmo's services pivot are the observed patterns; Hearsay's "no cloud tier to upsell you into" differentiation forecloses the obvious one. Decide before launch, because the Plausible-checklist crowd will ask on day one.
8. **What is success?** Given the niche's base rate (double-digit stars for dashboards), define the v1 success metric now — e.g., 50 weekly-active self-hosted instances or 10 agencies running it for clients — so a 150-star outcome isn't misread as failure or success.
