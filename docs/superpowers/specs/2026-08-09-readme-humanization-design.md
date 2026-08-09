# README Humanization — Design Specification

Date: 2026-08-09  
Status: approved direction, pending written-spec review  
Scope: README copy and information flow only; no product behavior changes

## 1. Goal

Make the README sound like a person explaining Hearsay plainly and directly. The opening
should connect Hearsay to the familiar idea of SEO while making the product's actual job
clear: measuring what AI assistants say about a business and the web evidence behind
those answers.

## 2. Positioning

The README leads with this idea:

> **Hearsay is SEO for the age of AI.** It tries its best to hear what AI assistants say
> about your business, product, tool, or whatever you're building—and shows you what they
> found on the web.

“SEO for the age of AI” is a memorable shorthand, not a claim that Hearsay measures
traditional search rankings. The surrounding copy will clarify that Hearsay observes AI
answers, mentions, recommendations, and available citations; it does not crawl the whole
internet or measure every human conversation about a brand.

## 3. Copy direction

- Use short paragraphs and plain, active language.
- Keep the casual “hear what they say” idea as the product's human hook.
- Explain the value before implementation details, pricing, or methodology.
- Prefer concrete verbs such as “asks,” “shows,” “counts,” and “keeps.”
- Remove repeated qualification and sales-like phrasing where the facts already explain
  the benefit.
- Keep the README honest about API answers, web search, citations, uncertainty, costs,
  and local-first operation.

## 4. Planned changes

### Opening and first explanation

- Replace the current formal subtitle with the approved positioning.
- Rewrite the opening `What it does` copy so a reader quickly understands the questions
  Hearsay asks, the engines it measures, and what evidence it keeps.
- Preserve the distinction between Hearsay itself being free and model providers charging
  for API usage.

### Main body

- Lightly rewrite reader-facing prose in `Install it by asking`, `Or install it yourself`,
  `Why it exists`, `What you get`, `What it costs to run`, `Methodology`, `No cloud version,
  no lock-in`, `Roadmap`, and `Contributing and security`.
- Keep commands, URLs, links, screenshots, comparison values, methodology findings,
  security claims, and roadmap scope intact unless a wording change is needed for clarity.
- Preserve the existing practical installation paths and technical details; the rewrite is
  about voice and order, not a documentation redesign.

### Accuracy boundary

- Describe citations and web evidence as available/observed evidence where a provider does
  not guarantee citations or web search.
- Do not imply that Hearsay can identify every person discussing a brand online.
- Do not turn Hearsay's measured AI visibility into a traditional search-ranking claim or
  a single universal score.

## 5. Verification

- Review the final README from top to bottom for a consistent, direct voice.
- Run `git diff --check`.
- Confirm all existing code blocks, links, images, and factual comparison/methodology
  content remain present.
- Report any claims that remain intentionally qualified rather than silently simplifying
  them.

## 6. Non-goals

- No application, API, schema, test, or runtime changes.
- No new screenshots, video, branding assets, or external research.
- No removal of installation, security, methodology, cost, or comparison information.
