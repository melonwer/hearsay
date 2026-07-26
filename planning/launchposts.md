# Launch posts, Phase A validation (see §18 of the plan)

**How to use these (don't paste this header anywhere):**

## What we learned from the r/selfhosted attempt (2026-07-26)

- **r/selfhosted is out.** They answered the question the post asked: it's a hobby sub (media servers, home automation), they don't have marketing problems and don't want marketing tools. That's real Phase A data, not a failed post. Delete the thread if it's sitting at 0.
- One useful comment (u/PatochiDesu): target small/medium companies that contract an IT person, not self-hosters. That means setup simplicity is a nice-to-have for the buyer, not the hook, and business users expect maintenance/support, which a community can't fully cover. Feed this into §1.4 target-user thinking: distribution goes through marketing/SEO people, and "self-hosted" is a deployment detail to them, not an identity.
- The post also got read as AI-written before that. Retype these drafts in your own words, don't paste. Uneven paragraphs, lowercase, no tidy closers.

## Posting plan

- Order: r/bigseo, then r/content_marketing, then r/DigitalMarketing, days apart. Each post has a different angle (measurement, workflow, agency pricing), never the same text twice.
- r/SEO only via their pinned weekly thread if at all, they ban for tool-shaped posts.
- These are validation posts, nothing to sell yet. Disclose you're building it if asked. Reply to every comment on day one, the comments are the research.
- The bigseo post claims you trialed trackers and ran manual ChatGPT checks. Actually do that first.
- At real launch, reply in your own threads with the repo link (§18 Phase B).

---

## 1. r/bigseo

**Title:** every AI visibility tracker gives me a different number

clients started asking why they don't show up in ChatGPT answers, so I trialed two of the known tracking tools with the same prompt set. tool A gives one visibility score, tool B gives a different one. then I asked ChatGPT the same question 10 times myself and the brand came up in 6 of them. so that's three numbers, and each tool presents theirs like it's gospel.

pricing made it worse. one charges hundreds a month extra to include Claude, another prices per domain, which stops making sense past a couple of clients.

what I actually want is dumb: run my prompt set a few times a day across the engines, give me a mention rate with an honest error margin, and let me read the raw answers so I can check any number myself. I write code, so I'm about halfway to just building that on my own API keys.

before I do, am I missing a tool that already measures this properly? and be honest, do clients even care about an error margin, or is the single fake-precise score exactly what sells the report?

---

## 2. r/content_marketing

**Title:** how is everyone actually checking what ChatGPT says about their brand?

not asking about the paid trackers, I know they exist, the quotes start at $99/mo and go up fast. asking what people actually do day to day.

right now my version is embarrassing: I ask ChatGPT and Perplexity the same handful of questions by hand every so often and paste anything interesting into a doc. it's slow, and the answers change between runs, so I'm never sure if a change is real or just the model being random that day.

I write code so I've been sketching a free open source version that runs your question set daily on your own API keys and tracks the mention rate over time, with the raw answers saved so you can verify any number.

but I don't want to build for an audience of one. what's your current setup, even if it's "nothing"? and would running a small self hosted thing yourself (or handing it to whoever manages your site) be realistic, or is that dead on arrival for a marketing team?

---

## 3. r/DigitalMarketing

**Title:** agency people: what do you do when a client asks "what does ChatGPT say about us"

this comes up on most calls now. their competitor gets recommended, they don't, and there's no Search Console for it, so the answer is either vibes or a tool quote.

and the quotes are rough. everything prices per brand or per domain, so 10+ clients turns into four figures a month for what is honestly automated prompting. I trialed two of the tools and they gave me two different visibility numbers for the same brand. have fun explaining that in a client report.

I write code, so I started building my own thing: self-hosted, your own OpenAI/Anthropic/Google keys, runs the prompt panel daily, tracks mentions against competitors with a real error margin, and keeps every raw answer so there are receipts behind the numbers. works out to a cheap VPS plus a few dollars of API usage per client.

two things I can't tell from the inside though. would an agency actually run one small instance per client, even if setup is one command? and is the white-label report the actual product, with the dashboard just being for us?

if you're covering this with a spreadsheet or an intern with 40 ChatGPT tabs open, how is that going.
