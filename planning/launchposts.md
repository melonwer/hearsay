# Launch posts, Phase A validation (see §18 of the plan)

**How to use these (don't paste this header anywhere):**

- Post from your own account, days apart, not the same day. r/selfhosted first (it settles the biggest open question), then r/SEO, then r/DigitalMarketing.
- These are *validation* posts, not ads. You have nothing to sell yet and the posts say so. That's what makes them work.
- Disclose that you're the one building it if anyone asks. It's already implied in the text. Check each subreddit's self-promo rules the week you post; r/SEO in particular removes anything that smells like a pitch.
- Reply to every comment for the first day. The comments are the actual research, so save the good ones. They feed the v1 priority order.
- Tweak the wording so it sounds like you. If a sentence doesn't feel like something you'd type, change it. Don't add emoji, don't add a TL;DR, don't make the formatting prettier. Reddit trusts ugly.
- The middle post mentions testing tools manually and trialing a couple of trackers. Actually do that before posting (a free trial and ten ChatGPT tabs is an afternoon), so every claim in your post is something that happened to you.
- When you later launch for real, go back to your own thread and reply "you asked, I built it" with the repo link (§18 Phase B).

---

## 1. r/selfhosted

**Title:** Would anyone here actually self-host a marketing tool?

Genuine question, I can't find a straight answer anywhere.

There's a newish category of SaaS that tracks what ChatGPT/Claude/Gemini/Perplexity say about your brand or product. Companies pay $99 to $500 a month for this. Under the hood most of it is a cron job that sends prompts to the same APIs you and I already have keys for and greps the answers. One of them charges hundreds per month extra just to add Claude as an engine. I went down this rabbit hole for work and came out kind of angry about the markup.

So I want to build an open source one. MIT license, bring your own API keys, and your monthly cost is whatever the API calls cost, which for a normal setup is a few dollars. The bit I care about most is install friction. Node 22 ships sqlite built in now, so this can literally be git clone and `node server.js`. No docker, no postgres, not even an npm install.

What I can't figure out is whether anyone would run it. Browsing this sub it's all media servers and *arr stacks and home automation. Is that because nobody makes decent self-hostable marketing tools, or because the people who need marketing tools don't self-host and never will? I have a suspicion it's the second one and I'd rather hear it now than after three months of building.

Also curious what your dealbreaker list looks like when you evaluate a new project. Mine is a real license (not FSL or some rug-pull-later thing), no features gated behind a cloud account, and easy data export. No telemetry goes without saying. What else do people check for these days?

Nothing to link yet, there's no repo. Just trying to work out if the audience for this is bigger than one person.

---

## 2. r/SEO

**Title:** Tested a few AI visibility trackers and got different numbers from each. What are you all actually using?

Been evaluating tools that track brand mentions in ChatGPT/Perplexity etc because clients started asking why they don't show up in AI answers, and "I'll look into it" stopped being an acceptable answer at some point this year.

The evaluation did not go great. I ran the same prompt set through trials of two of the known tools and got noticeably different visibility numbers from each. Then I sanity checked by hand, same question to ChatGPT ten times, and the brand came up in 6 of the 10 answers. So now I have three numbers. The tools give you one clean score and never mention that it would come out different if you reran it five minutes later.

Pricing didn't help either. Entry tiers look fine until you see what's metered. One tool wanted hundreds a month extra to include Claude. Another prices per domain, which gets absurd fast if you have more than a couple of clients.

The thing I actually want is boring. Run my prompt set N times a day across the major engines, give me a mention rate with an honest margin of error, and let me read the raw answers so I can check any number myself. I write code as well as doing SEO, so I've half decided to just build it as an open source thing where you plug in your own API keys and pay OpenAI/Anthropic directly instead of paying a markup.

Before I commit to that: what is everyone using in practice? Did I miss a tool that already does repeatable measurement? And be honest, would a margin of error even matter to you, or does the single-score thing work fine for client reporting and I'm overthinking this?

---

## 3. r/DigitalMarketing

**Title:** Agency folks: how are you handling "what does ChatGPT say about us" without paying per client?

A year ago this was a novelty question. Now it comes up in most client calls. Somebody's competitor gets recommended by ChatGPT and they don't, and there's no Search Console equivalent to point at, so the conversation is either vibes or a tool quote.

And the tool quotes are rough. Everything prices per brand or per domain, so tracking 10+ clients turns into a four figure monthly line item for what is basically automated prompting. When I trialed a couple of them, two tools gave me two different visibility numbers for the same brand. Try putting that in a client report.

I write code, so I've started building an open source alternative for my own use. Self-hosted, runs on your own OpenAI/Anthropic/Google keys, runs the prompt panel daily, tracks mentions against competitors with an actual margin of error rather than an invented score, and keeps every raw answer so there are receipts behind every number. Per client that works out to a cheap VPS plus a few dollars of API usage.

Two things I want to understand before I build too much. First, would an agency actually run one small instance per client? It's genuinely one command, no docker, but maybe self-hosting is a nonstarter for marketing teams no matter how simple it gets. Second, what does the client-facing side need to be? I keep suspecting the white-label PDF/HTML report is the real product and the dashboard is just for us.

If you're handling this some other way today, manual spot checks, a spreadsheet, an intern with 40 ChatGPT tabs open, I'd love to hear what the setup is and where it hurts.
