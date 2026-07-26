/**
 * Deterministic demo universe generator (§12).
 *
 * Phase 1 Lane D implements it: mulberry32 seeded with 1337, the invented Notewell /
 * Jotta / EchoPad / Quillo universe, 5 intents × 2–3 paraphrases, 30 days × 4 providers
 * × 12 prompts × 3 samples, scripted storylines that produce one MENTION_DROP, one
 * OVERTAKEN and one lost/gained recommendation. Template answers go through the real
 * analyzeResponse() and the same DB writes as a live run, with runs.trigger='seed'.
 * No real brand names, ever (§19.5 #8).
 *
 * Nothing here is random at runtime: one PRNG stream, consumed in a fixed order
 * (day → prompt → provider → sample), so two seeds into two empty databases produce
 * identical rows. The only clock input is the window anchor (`opts.now`), and the
 * alert engine is handed each run's own timestamp rather than the wall clock, so the
 * storylines are reproducible down to the alert set.
 *
 * Storylines are *scripted probabilities*, not scripted rows: mention probabilities per
 * (provider, entity) drift over the window, answers are template-assembled from those
 * draws, and the alerts fall out of the real `core/alerts.js` rules evaluated after each
 * seeded run — the same code path a live panel takes (§9, §12).
 */

import { analyzeResponse as defaultAnalyze, containsAlias } from './analyze.js';
import { evaluate as defaultEvaluateAlerts } from './alerts.js';
import { SETTING_KEYS, get, isoNow, run as exec, setSetting, transaction } from './db.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./analyze.js').AnalyzeEntity} AnalyzeEntity */

/** PRNG seed (§12). Changing it changes the whole demo universe. */
export const SEED = 1337;

/** Days of history the demo covers, ending on the last full UTC day (§12). */
export const DEMO_DAYS = 30;

/** Samples per prompt per provider per run — the `HEARSAY_SAMPLES` default (§4.1). */
export const DEMO_SAMPLES = 3;

/** The storyline break: the last N days are where Gemini turns against the brand (§12). */
export const CLIFF_DAYS = 7;

/** Seeded runs land at 07:00Z, matching the `HEARSAY_RUN_AT` default (§4.1). */
const RUN_HOUR_MS = 7 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;

/**
 * The four engines, with the §4.2 default models. Hardcoded rather than read from
 * `config`, so the demo universe does not change shape when someone sets `OPENAI_MODEL`.
 * @type {{id: string, model: string}[]}
 */
export const DEMO_PROVIDERS = [
  { id: 'openai', model: 'gpt-5.6-luna' },
  { id: 'anthropic', model: 'claude-sonnet-5' },
  { id: 'gemini', model: 'gemini-3.6-flash' },
  { id: 'perplexity', model: 'sonar' },
];

/**
 * The fictional universe (§12). Every name, domain and quote below is invented; none of
 * it refers to a real product (§19.5 #8).
 * @type {{name: string, aliases: string[], domains: string[], isSelf: boolean}[]}
 */
export const DEMO_ENTITIES = [
  { name: 'Notewell', aliases: ['Notewell AI'], domains: ['notewell.io'], isSelf: true },
  { name: 'Jotta', aliases: [], domains: ['jotta.app'], isSelf: false },
  { name: 'EchoPad', aliases: [], domains: ['echopad.ai'], isSelf: false },
  { name: 'Quillo', aliases: [], domains: ['quillo.co'], isSelf: false },
];

/**
 * 5 intents × 2–3 paraphrases = 12 prompts (§12), which is what exercises the intent
 * pooling and phrasing-spread split in §6.6. `topic` / `want` / `axis` are the copy slots
 * the answer templates fill.
 * @type {{label: string, category: string, topic: string, want: string, axis: string, paraphrases: string[]}[]}
 */
export const DEMO_INTENTS = [
  {
    label: 'best AI meeting notes tool',
    category: 'general',
    topic: 'AI meeting notes',
    want: 'meeting notes that write themselves',
    axis: 'how much editing you are willing to do after the call',
    paraphrases: [
      "What's the best AI meeting notes tool?",
      'Which AI tool should I use for meeting notes?',
      'top meeting-notes AI for small teams',
    ],
  },
  {
    label: 'Notewell vs Jotta — which should my sales team use?',
    category: 'comparison',
    topic: 'meeting notes for a sales team',
    want: 'call notes that land in your CRM',
    axis: 'how tightly the notes have to sit inside your pipeline tooling',
    paraphrases: [
      'Notewell vs Jotta — which should my sales team use?',
      'How does Notewell compare with Jotta for a sales team?',
      'Jotta or Notewell for a 20-person sales team?',
    ],
  },
  {
    label: 'affordable meeting transcription for startups',
    category: 'pricing',
    topic: 'affordable meeting transcription',
    want: 'transcription on a startup budget',
    axis: 'how many hours a month you actually record',
    paraphrases: [
      'What is the most affordable meeting transcription tool for a startup?',
      'cheap meeting transcription for a small startup team',
    ],
  },
  {
    label: 'best free meeting summarizer',
    category: 'pricing',
    topic: 'free meeting summarizers',
    want: 'a summarizer that costs nothing',
    axis: 'how strict the free-tier limits are',
    paraphrases: ['What is the best free meeting summarizer?', 'Is there a free AI tool that summarizes meetings?'],
  },
  {
    label: 'Is Notewell any good?',
    category: 'branded',
    topic: 'Notewell',
    want: 'a verdict on Notewell',
    axis: 'what you are comparing it against',
    paraphrases: ['Is Notewell any good?', 'What do people think of Notewell AI?'],
  },
];

/**
 * Per (provider, entity) mention probability: `from` → `to` across the window, and for
 * the scripted breaks a separate `late` segment covering the final {@link CLIFF_DAYS}.
 *
 * The two pinned storylines (§12): the brand climbs on Perplexity 0.35 → 0.60 across the
 * window, and falls off a cliff on Gemini in the last week, 0.55 → 0.25, while Jotta
 * steps up on the same engine (and picks up momentum on ChatGPT) so it crosses the brand
 * in share of voice. Everything else drifts gently, which is what keeps the explorer from
 * looking generated.
 * @type {Record<string, Record<string, {from: number, to: number, late?: {from: number, to: number}}>>}
 */
const STORYLINES = {
  openai: {
    Notewell: { from: 0.5, to: 0.54 },
    Jotta: { from: 0.36, to: 0.4, late: { from: 0.52, to: 0.56 } },
    EchoPad: { from: 0.34, to: 0.32 },
    Quillo: { from: 0.24, to: 0.26 },
  },
  anthropic: {
    Notewell: { from: 0.46, to: 0.5 },
    Jotta: { from: 0.34, to: 0.36 },
    EchoPad: { from: 0.38, to: 0.36 },
    Quillo: { from: 0.22, to: 0.24 },
  },
  gemini: {
    Notewell: { from: 0.55, to: 0.55, late: { from: 0.25, to: 0.25 } },
    Jotta: { from: 0.34, to: 0.36, late: { from: 0.7, to: 0.74 } },
    EchoPad: { from: 0.36, to: 0.34 },
    Quillo: { from: 0.26, to: 0.28 },
  },
  perplexity: {
    Notewell: { from: 0.35, to: 0.6 },
    Jotta: { from: 0.36, to: 0.36 },
    EchoPad: { from: 0.3, to: 0.3 },
    Quillo: { from: 0.26, to: 0.24 },
  },
};

/**
 * Spread of the per-(prompt, entity) affinity offset (§12 "prompt-affinity jitter"): an
 * entity that fits a question stays fitting it. Kept narrower than the storyline gaps, so
 * per-prompt taste colours the picture without burying the scripted trends.
 */
const AFFINITY_SPREAD = 0.15;

/** Bonus for an entity the prompt names outright — a comparison prompt drags both in. */
const NAMED_IN_PROMPT_BONUS = 0.25;

/** Extra bonus for the brand on its own branded prompt: navigational recall, not discovery. */
const BRANDED_PROMPT_BONUS = 0.45;

/** Probabilities are clamped here, so no entity is ever certain or impossible. */
const P_MIN = 0.03;
const P_MAX = 0.95;

/** How much ordering noise separates two entities with similar standing in one answer. */
const RANK_JITTER = 0.05;

/** Seeded latency range, in ms — plausible, and clearly fabricated demo data (§19.6 #3). */
const LATENCY_MIN = 700;
const LATENCY_MAX = 4200;

/**
 * Neutral citation domains. Invented, plausible, and deliberately not `example.com`
 * placeholders (§12) — the citation gap table needs something that reads like a source.
 */
export const NEUTRAL_DOMAINS = ['reviewradar.io', 'worktools.dev', 'opsdigest.io', 'teamtoolbox.dev'];

/** Slugs appended to a cited domain, so the answers table shows real-looking URLs. */
const CITATION_SLUGS = [
  'guides/ai-meeting-notes',
  'reviews/meeting-transcription',
  'compare/meeting-assistants',
  'blog/what-changed-this-quarter',
  'notes/buyers-guide',
];

/**
 * Invented, entity-neutral descriptors. Deliberately free of §6.4 trigger phrases, so a
 * template decides what counts as a recommendation rather than the filler copy.
 * @type {Record<string, string[]>}
 */
const DESCRIPTORS = {
  Notewell: [
    'live transcription with speaker labels and a searchable archive',
    'action items that sync straight into a task tracker',
    'a clean search across every past meeting',
  ],
  Jotta: [
    'a fast editor and recaps you can share in one click',
    'CRM sync that sales teams tend to like',
    'templates for recurring standups',
  ],
  EchoPad: [
    'multi-language transcription that holds up on accented audio',
    'an offline recorder for on-site meetings',
    'granular retention controls for regulated teams',
  ],
  Quillo: [
    'lightweight summaries that live in a browser tab',
    'a free tier that covers a few hours a month',
    'one-click export to Markdown',
  ],
};

/**
 * Non-branded fallbacks, used to pad an answer to two options when the draws left one or
 * zero tracked entities in it. They are descriptions, not invented products, so the
 * analyzer has nothing to match and the mention rates stay honest.
 * @type {{name: string, detail: string}[]}
 */
const FILLERS = [
  { name: 'the recap built into your video-conferencing tool', detail: 'no extra vendor, though search across past calls is thin' },
  { name: 'a plain transcription service plus a shared doc', detail: 'the cheapest path, and it stays manual' },
  { name: 'your task tracker with a meeting-note template', detail: 'zero new tools, and no summaries either' },
];

/** Closing sentences. None contains a §6.4 trigger phrase. */
const CAVEATS = [
  'Pricing and feature sets move quickly, so check the current plans before you commit.',
  'Whichever you trial, run it on a real call with three or more speakers — that is where they separate.',
  'Most of these have a free tier, so a side-by-side week costs you nothing but calendar space.',
  'Check the data-retention settings before you record anything sensitive.',
  'Ask for a trial on your own audio; demo recordings are always cleaner than real calls.',
];

/** Things a branded answer says people grumble about. Invented, and mild on purpose. */
const GRIPES = [
  'the mobile app lags behind the web version',
  'the summary template is not very configurable yet',
  'exports keep the formatting but drop timestamps',
];

/**
 * mulberry32 (§12). 32-bit state, uniform output in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {number} from
 * @param {number} to
 * @param {number} t 0..1
 * @returns {number}
 */
function lerp(from, to, t) {
  return from + (to - from) * t;
}

/**
 * @template T
 * @param {number} roll 0..1
 * @param {T[]} options
 * @returns {T}
 */
function choose(roll, options) {
  return options[Math.min(options.length - 1, Math.floor(roll * options.length))];
}

/**
 * Mention probability for one (provider, entity) on one day of the window (§12).
 * @param {string} provider
 * @param {string} entity
 * @param {number} dayIndex 0 = oldest day
 * @param {number} days window length
 * @returns {number}
 */
export function baseProbability(provider, entity, dayIndex, days) {
  const story = STORYLINES[provider]?.[entity];
  if (!story) return 0.3;
  const cliffAt = Math.max(1, days - CLIFF_DAYS);
  if (story.late && dayIndex >= cliffAt) {
    const span = days - cliffAt;
    return lerp(story.late.from, story.late.to, span <= 1 ? 1 : (dayIndex - cliffAt) / (span - 1));
  }
  const span = story.late ? cliffAt : days;
  return lerp(story.from, story.to, span <= 1 ? 0 : Math.min(dayIndex, span - 1) / (span - 1));
}

/**
 * @typedef {Object} SeedPrompt
 * @property {number} id
 * @property {string} text
 * @property {string} category
 * @property {string} topic
 * @property {string} want
 * @property {string} axis
 */

/**
 * @typedef {Object} SeedEntity
 * @property {number} id
 * @property {string} name
 * @property {string[]} aliases
 * @property {string[]} domains
 * @property {boolean} isSelf
 */

/**
 * @typedef {Object} Item
 * @property {string} name what the answer calls it
 * @property {string} detail the half-sentence after the dash
 * @property {SeedEntity|null} entity null for a non-branded filler option
 */

/**
 * One template family. Every family renders *all* items it is given — an entity drawn
 * into an answer must appear in it, or the seeded mention rates would not match the
 * probabilities that produced them.
 * @typedef {(ctx: {prompt: SeedPrompt, items: Item[], caveat: string, roll: number}) => string} Template
 */

/**
 * Capitalise a name that opens a sentence or a list item. Entity names are already
 * capitalised, so this only tidies the lower-case fallback options.
 * @param {string} name
 * @returns {string}
 */
function opening(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** @type {Template} */
const numberedList = ({ prompt, items, caveat }) =>
  `For ${prompt.topic}, this is the shortlist that keeps coming up:\n\n` +
  `${items.map((item, i) => `${i + 1}. ${opening(item.name)} — ${item.detail}.`).join('\n')}\n\n${caveat}`;

/** @type {Template} */
const bulletedList = ({ prompt, items, caveat }) =>
  `Here is how the main options for ${prompt.topic} compare:\n\n` +
  `${items.map((item) => `- ${opening(item.name)} — ${item.detail}`).join('\n')}\n\n${caveat}`;

/** @type {Template} */
const leadPick = ({ prompt, items, caveat }) => {
  const [first, ...rest] = items;
  const followUps = ['is the other name that comes up a lot;', 'is worth a look too —', 'rounds out the shortlist:'];
  const tail = rest.map((item, i) =>
    item.entity
      ? `${opening(item.name)} ${followUps[Math.min(i, followUps.length - 1)]} ${item.detail}.`
      : `The low-tech fallback is ${item.name} — ${item.detail}.`,
  );
  return `For ${prompt.want}, the one I would go with is ${first.name} — ${first.detail}. ${tail.join(' ')} ${caveat}`.trim();
};

/**
 * §6.4 R3 marks the lead entity of any answer under 400 chars as recommended, so the
 * hedging families have to clear that bar or they would quietly become recommendations.
 */
const R3_FLOOR = 420;
const HEDGE_TAIL =
  ' Whatever you land on, run it against one recording you already know well before you roll it out.';

/**
 * @param {string} text
 * @returns {string}
 */
function hedged(text) {
  return text.length >= R3_FLOOR ? text : text + HEDGE_TAIL;
}

/** @type {Template} Two options, hedged, and long enough that §6.4 R3 does not apply. */
const itDepends = ({ prompt, items, caveat }) => {
  const [a, b] = items;
  return hedged(
    `${opening(a.name)} and ${b.name} both come up for ${prompt.topic}. ${opening(a.name)} gives you ${a.detail}; ` +
      `${b.name} gives you ${b.detail}. Which one fits depends on ${prompt.axis} far more than on the ` +
      `feature lists, and the gap between them is small enough that a trial week will tell you more than ` +
      `another comparison table. Neither pulls ahead on accuracy alone — both handle clean audio well ` +
      `and both lose the thread when three people talk over each other. ${caveat}`,
  );
};

/** @type {Template} Same hedge, any number of options, and no list for §6.4 R2 to catch. */
const hedgedProse = ({ prompt, items, caveat }) => {
  const names = items.map((item) => item.name);
  const last = names.pop();
  return hedged(
    `A few names come up for ${prompt.topic}: ${names.join(', ')} and ${last}. ` +
      `${items.map((item) => `${item.name} gives you ${item.detail}`).join('; ')}. ` +
      `Ranking them in the abstract is not much use — ${prompt.axis} decides it, and the answer changes ` +
      `for a team of five and a team of fifty. ${caveat}`,
  );
};

/** @type {Template} Criteria first, names second — hedged, and again list-free. */
const criteriaFirst = ({ prompt, items, caveat }) =>
  hedged(
    `Before the names: for ${prompt.topic}, what usually decides it is ${prompt.axis}. ` +
      `With that in mind — ${items.map((item) => `${item.name} brings ${item.detail}`).join(', ')}. ` +
      `None of them wins on paper; the one that survives a week of your own calls wins. ${caveat}`,
  );

/** @type {Template} Nothing tracked made it into this answer; it stays honest and vague. */
const noWinner = ({ prompt, items, caveat }) =>
  hedged(
    `There is no single answer for ${prompt.topic} — it comes down to ${prompt.axis}. ` +
      `Two options people fall back on: ${items[0].name} (${items[0].detail}), or ${items[1].name} ` +
      `(${items[1].detail}). Before you pick, check how the transcript handles crosstalk and whether the ` +
      `summary can be edited before it is shared. ${caveat}`,
  );

/** @type {Template} A branded prompt gets a verdict, not a shortlist. */
const verdict = ({ prompt, items, caveat, roll }) => {
  const [first, ...rest] = items;
  const gripe = choose(roll, GRIPES);
  const alt = rest[0]?.entity
    ? ` If ${prompt.axis} matters more to you, ${rest[0].name} covers similar ground with ${rest[0].detail}.`
    : '';
  return (
    `${opening(first.name)} holds up well for what it is: ${first.detail}. Teams that switch to it usually mention ` +
    `the setup taking minutes rather than an afternoon, and the common complaint is that ${gripe}.${alt} ${caveat}`
  );
};

/** @type {Template} The other branded shape: same verdict, said as a recommendation. */
const brandedRecommend = ({ prompt, items, caveat, roll }) => {
  const [first, ...rest] = items;
  const gripe = choose(roll, GRIPES);
  const alt = rest[0]?.entity ? ` ${rest[0].name} is the usual alternative — ${rest[0].detail}.` : '';
  return (
    `For ${prompt.want}: people who use it daily do recommend ${first.name}, mostly for ${first.detail}. ` +
    `The complaint that comes up is that ${gripe}.${alt} ${caveat}`
  );
};

/** How many answer styles an engine can settle into for a given prompt. */
export const STYLE_COUNT = 5;

/**
 * Assemble one answer (§12): intro + ranked options + caveat, from several template
 * families so the answers explorer looks organic rather than stamped out.
 *
 * The family is chosen by `style`, which is fixed per (prompt, provider) rather than
 * redrawn per sample — engines settle into a house format for a given question. That also
 * keeps §9's recommendation rules measuring the ranking rather than the phrasing lottery.
 *
 * @param {Object} ctx
 * @param {SeedPrompt} ctx.prompt
 * @param {Item[]} ctx.items ranked, 2–4 long
 * @param {number} ctx.entityCount how many of the items are tracked entities
 * @param {number} ctx.style 0..{@link STYLE_COUNT}-1, fixed per (prompt, provider)
 * @param {number} ctx.caveatRoll
 * @param {number} ctx.copyRoll
 * @returns {string}
 */
export function composeAnswer({ prompt, items, entityCount, style, caveatRoll, copyRoll }) {
  const caveat = choose(caveatRoll, CAVEATS);
  const ctx = { prompt, items, caveat, roll: copyRoll };
  if (entityCount === 0) return noWinner(ctx);
  if (prompt.category === 'branded') return (style % 2 === 0 ? brandedRecommend : verdict)(ctx);
  /** @type {Template[]} */
  const families = [
    numberedList,
    bulletedList,
    leadPick,
    items.length === 2 ? itDepends : hedgedProse,
    criteriaFirst,
  ];
  return families[style % families.length](ctx);
}

/**
 * 1–3 citations for a Perplexity sample (§12): the entities the answer ranked, plus
 * invented neutral sources. Returned in the provider's native shape, so they reach
 * `analyzeResponse` exactly the way a live Perplexity call's citations do (§5.2, §6.3).
 *
 * @param {Item[]} items
 * @param {() => number} rand
 * @returns {{url: string}[]}
 */
function buildCitations(items, rand) {
  const wanted = 1 + Math.floor(rand() * 3);
  /** @type {string[]} */
  const domains = [];
  for (const item of items) {
    const domain = item.entity?.domains[0];
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  // Neutral sources are interleaved, not appended, so the brand does not always own rank 1.
  const offset = Math.floor(rand() * NEUTRAL_DOMAINS.length);
  /** @type {string[]} */
  const pool = [];
  for (let i = 0; i < NEUTRAL_DOMAINS.length; i += 1) pool.push(NEUTRAL_DOMAINS[(offset + i) % NEUTRAL_DOMAINS.length]);
  const ordered = rand() < 0.5 ? [...domains, ...pool] : [pool[0], ...domains, ...pool.slice(1)];

  /** @type {{url: string}[]} */
  const out = [];
  for (const domain of ordered) {
    if (out.length >= wanted) break;
    const slug = CITATION_SLUGS[Math.floor(rand() * CITATION_SLUGS.length)];
    out.push({ url: `https://${domain}/${slug}` });
  }
  return out;
}

/**
 * True when the database holds none of the demo-relevant rows. Settings are ignored: a
 * database whose only content is a toggle is still empty for seeding purposes (§12).
 * @param {Db} db
 * @returns {boolean}
 */
export function isEmpty(db) {
  const row = get(
    db,
    `SELECT (SELECT COUNT(*) FROM entities) + (SELECT COUNT(*) FROM intents) + (SELECT COUNT(*) FROM prompts)
          + (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM responses) + (SELECT COUNT(*) FROM alerts) AS n`,
  );
  return Number(row?.n ?? 0) === 0;
}

/**
 * Delete every row, including the AUTOINCREMENT counters, so a re-seed reproduces the
 * same ids as a fresh database. Backs `node scripts/seed.js --force` (§12).
 * @param {Db} db
 * @returns {void}
 */
export function wipe(db) {
  transaction(db, () => {
    for (const table of ['alerts', 'citations', 'mentions', 'responses', 'runs', 'prompts', 'intents', 'entities', 'settings']) {
      exec(db, `DELETE FROM ${table}`);
    }
    // Present because every table above uses AUTOINCREMENT; guard anyway.
    const seq = get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'");
    if (seq) exec(db, 'DELETE FROM sqlite_sequence');
  });
}

/**
 * @typedef {Object} SeedSummary
 * @property {number} entities
 * @property {number} intents
 * @property {number} prompts
 * @property {number} runs
 * @property {number} responses
 * @property {number} mentions
 * @property {number} citations
 * @property {number} alerts
 * @property {Record<string, number>} alertTypes count per alert type
 * @property {string} from first seeded UTC day, `YYYY-MM-DD`
 * @property {string} to last seeded UTC day, `YYYY-MM-DD`
 */

/**
 * Load the deterministic demo universe into an open database (§12).
 *
 * The caller owns emptiness policy: `scripts/seed.js` refuses a populated database unless
 * `--force`, and demo-mode boot only calls this when {@link isEmpty} is true.
 *
 * @param {Db} db open, migrated database
 * @param {Object} [opts]
 * @param {Date} [opts.now] window anchor; the last seeded day is the last full UTC day before it
 * @param {number} [opts.days] window length, default {@link DEMO_DAYS}
 * @param {number} [opts.samples] samples per prompt per provider per run, default {@link DEMO_SAMPLES}
 * @param {number} [opts.seed] PRNG seed, default {@link SEED}
 * @param {typeof defaultAnalyze} [opts.analyzeResponse] injectable for tests only
 * @param {(db: Db, runId: number, opts?: {now?: string|Date}) => unknown} [opts.evaluateAlerts] injectable for tests only
 * @returns {SeedSummary}
 */
export function seed(db, opts = {}) {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.floor(opts.days ?? DEMO_DAYS));
  const samples = Math.max(1, Math.floor(opts.samples ?? DEMO_SAMPLES));
  const rand = mulberry32(opts.seed ?? SEED);
  const analyze = opts.analyzeResponse ?? defaultAnalyze;
  const evaluateAlerts = opts.evaluateAlerts ?? defaultEvaluateAlerts;

  // The window ends on the last full UTC day — "yesterday" relative to the seed (§12).
  const lastDay = Math.floor((now.getTime() - DAY_MS) / DAY_MS) * DAY_MS;
  const firstDay = lastDay - (days - 1) * DAY_MS;
  // The universe was configured the evening before the first run.
  const createdAt = isoNow(new Date(firstDay - DAY_MS + 17 * 60 * 60 * 1000));

  /** @type {SeedEntity[]} */
  const entities = [];
  for (const entity of DEMO_ENTITIES) {
    const id = exec(db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, ?, ?)', [
      entity.name,
      JSON.stringify(entity.aliases),
      JSON.stringify(entity.domains),
      entity.isSelf ? 1 : 0,
      createdAt,
    ]).lastInsertRowid;
    entities.push({ id, name: entity.name, aliases: entity.aliases, domains: entity.domains, isSelf: entity.isSelf });
  }
  /** @type {AnalyzeEntity[]} */
  const analyzeEntities = entities.map((e) => ({ id: e.id, name: e.name, aliases: e.aliases, domains: e.domains }));

  /** @type {SeedPrompt[]} */
  const prompts = [];
  for (const intent of DEMO_INTENTS) {
    const intentId = exec(db, 'INSERT INTO intents(label, created_at) VALUES(?, ?)', [intent.label, createdAt])
      .lastInsertRowid;
    for (const text of intent.paraphrases) {
      const id = exec(db, 'INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(?, ?, ?, 1, ?)', [
        intentId,
        text,
        intent.category,
        createdAt,
      ]).lastInsertRowid;
      prompts.push({ id, text, category: intent.category, topic: intent.topic, want: intent.want, axis: intent.axis });
    }
  }

  // Prompt affinity (§12): a fixed per-(prompt, entity) offset, plus a structural bonus
  // for entities the prompt names outright — "Notewell vs Jotta" drags both into the
  // answer whatever the engine thinks of them this week.
  /** @type {Map<string, number>} */
  const affinity = new Map();
  for (const prompt of prompts) {
    for (const entity of entities) {
      const jitter = (rand() * 2 - 1) * AFFINITY_SPREAD;
      const named = containsAlias(prompt.text, [entity.name, ...entity.aliases]) ? NAMED_IN_PROMPT_BONUS : 0;
      const branded = prompt.category === 'branded' && entity.isSelf ? BRANDED_PROMPT_BONUS : 0;
      affinity.set(`${prompt.id}|${entity.id}`, jitter + named + branded);
    }
  }

  // House style per (prompt, provider): one engine answers a given question as a ranked
  // list every time, another hedges every time (§12 template families).
  /** @type {Map<string, number>} */
  const styles = new Map();
  for (const prompt of prompts) {
    for (const provider of DEMO_PROVIDERS) {
      styles.set(`${prompt.id}|${provider.id}`, Math.floor(rand() * STYLE_COUNT));
    }
  }

  const totalCalls = prompts.length * DEMO_PROVIDERS.length * samples;
  let alertCount = 0;
  /** @type {Record<string, number>} */
  const alertTypes = {};

  for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
    const dayStart = firstDay + dayIndex * DAY_MS;
    const runStart = dayStart + RUN_HOUR_MS;
    const startedAt = isoNow(new Date(runStart));
    const runId = exec(db, 'INSERT INTO runs(started_at, trigger, status, total_calls, done_calls) VALUES(?, ?, ?, ?, 0)', [
      startedAt,
      'seed',
      'running',
      totalCalls,
    ]).lastInsertRowid;

    let call = 0;
    // One transaction per seeded run rather than per response: the writes are identical
    // to a live run's (§8.1), but a 4,000-call backfill does not need 4,000 fsyncs.
    transaction(db, () => {
      for (const prompt of prompts) {
        for (const provider of DEMO_PROVIDERS) {
          for (let sampleIdx = 0; sampleIdx < samples; sampleIdx += 1) {
            const createdAtCall = isoNow(new Date(runStart + call * 1000));
            call += 1;

            /** @type {{entity: SeedEntity, score: number}[]} */
            const drawn = [];
            for (const entity of entities) {
              const p = clamp(
                baseProbability(provider.id, entity.name, dayIndex, days) +
                  (affinity.get(`${prompt.id}|${entity.id}`) ?? 0),
                P_MIN,
                P_MAX,
              );
              // Both draws happen whatever the outcome, so the stream position depends on
              // the shape of the universe, never on the coin flips inside it.
              const roll = rand();
              const order = rand();
              if (roll < p) drawn.push({ entity, score: p + (order - 0.5) * RANK_JITTER });
            }
            drawn.sort((a, b) => b.score - a.score || a.entity.id - b.entity.id);

            /** @type {Item[]} */
            const items = drawn.map(({ entity }) => ({
              name: entity.name,
              detail: choose(rand(), DESCRIPTORS[entity.name] ?? ['a solid option']),
              entity,
            }));
            const entityCount = items.length;
            // An answer lists 2–4 options (§12); when the draws left fewer than two tracked
            // entities, non-branded fallbacks fill the list instead of inventing a product.
            let fillerAt = Math.floor(rand() * FILLERS.length);
            while (items.length < 2) {
              items.push({ ...FILLERS[fillerAt % FILLERS.length], entity: null });
              fillerAt += 1;
            }

            const text = composeAnswer({
              prompt,
              items,
              entityCount,
              style: styles.get(`${prompt.id}|${provider.id}`) ?? 0,
              caveatRoll: rand(),
              copyRoll: rand(),
            });
            const citations = provider.id === 'perplexity' ? buildCitations(items, rand) : [];
            const latencyMs = Math.round(LATENCY_MIN + rand() * (LATENCY_MAX - LATENCY_MIN));
            const analysis = analyze(text, analyzeEntities, citations);

            // Same columns, same order as the live path (§8.1); tokens and cost stay null
            // because nothing was billed (§12).
            const responseId = exec(
              db,
              `INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, latency_ms, tokens_in, tokens_out, cost_usd, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
              [runId, prompt.id, provider.id, provider.model, sampleIdx, text, latencyMs, createdAtCall],
            ).lastInsertRowid;

            for (const mention of analysis.mentions) {
              exec(
                db,
                `INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet)
                 VALUES(?, ?, ?, ?, ?, ?, ?)`,
                [
                  responseId,
                  mention.entity_id,
                  mention.first_index,
                  mention.occurrences,
                  mention.rank,
                  mention.recommended ? 1 : 0,
                  mention.snippet,
                ],
              );
            }
            for (const citation of analysis.citations) {
              exec(db, 'INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES(?, ?, ?, ?, ?)', [
                responseId,
                citation.url,
                citation.domain,
                citation.rank,
                citation.entity_id ?? null,
              ]);
            }
          }
        }
      }
    });

    const finishedAt = isoNow(new Date(runStart + (call + 60) * 1000));
    exec(db, 'UPDATE runs SET status = ?, finished_at = ?, done_calls = ? WHERE id = ?', ['done', finishedAt, call, runId]);

    // The real rules engine, per run, exactly as the runner calls it (§8.1 step 5) — with
    // the run's own timestamp so the 7-day SOV windows follow the seeded calendar rather
    // than the wall clock. The storylines above are what make it fire (§9).
    const created = evaluateAlerts(db, runId, { now: finishedAt });
    if (Array.isArray(created)) {
      alertCount += created.length;
      for (const alert of created) {
        const type = String(/** @type {{type?: unknown}} */ (alert).type ?? 'UNKNOWN');
        alertTypes[type] = (alertTypes[type] ?? 0) + 1;
      }
    }
  }

  setSetting(db, SETTING_KEYS.SEEDED_AT, isoNow(now));

  const counts = get(
    db,
    `SELECT (SELECT COUNT(*) FROM entities) AS entities, (SELECT COUNT(*) FROM intents) AS intents,
            (SELECT COUNT(*) FROM prompts) AS prompts, (SELECT COUNT(*) FROM runs) AS runs,
            (SELECT COUNT(*) FROM responses) AS responses, (SELECT COUNT(*) FROM mentions) AS mentions,
            (SELECT COUNT(*) FROM citations) AS citations, (SELECT COUNT(*) FROM alerts) AS alerts`,
  );

  return {
    entities: Number(counts?.entities ?? 0),
    intents: Number(counts?.intents ?? 0),
    prompts: Number(counts?.prompts ?? 0),
    runs: Number(counts?.runs ?? 0),
    responses: Number(counts?.responses ?? 0),
    mentions: Number(counts?.mentions ?? 0),
    citations: Number(counts?.citations ?? 0),
    alerts: Number(counts?.alerts ?? alertCount),
    alertTypes,
    from: new Date(firstDay).toISOString().slice(0, 10),
    to: new Date(lastDay).toISOString().slice(0, 10),
  };
}

/**
 * Seed only when demo mode is on and the database is untouched — the boot hook behind
 * `HEARSAY_DEMO=1` (§12). Returns null when it declined, so the caller can stay quiet.
 *
 * @param {Db} db
 * @param {{demo: boolean}} config
 * @param {Parameters<typeof seed>[1]} [opts]
 * @returns {SeedSummary|null}
 */
export function seedIfDemoAndEmpty(db, config, opts = {}) {
  if (!config?.demo) return null;
  if (!isEmpty(db)) return null;
  return seed(db, opts);
}
