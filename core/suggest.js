/**
 * Intent and paraphrase generator (§6.7).
 *
 * Solves the stated onboarding blocker — "I don't know which prompts to track" — by
 * drafting intents (§6.6) with three paraphrases each. Two halves:
 *
 *  - **pure post-processing**, which is where the rules live: strip numbering, cap at
 *    300 characters (§10.3), dedupe, allow-list the category, and tag anything naming
 *    the brand or one of its aliases as `branded` so navigational recall never props up
 *    a discovery number (§6.7);
 *  - **one LLM call**, injected as `runPrompt` so this module needs no provider adapter,
 *    no key handling and no network of its own. One retry on a parse failure, then the
 *    static starter pack (§20.3) — the flow is never a dead end.
 *
 * Nothing here writes to the database. The caller reviews and edits a checklist before
 * anything is inserted (§6.7, §11.8).
 */

import { containsAlias } from './analyze.js';

/** @typedef {{name:string, aliases?:string[], domains?:string[]}} BrandInput */

/**
 * @typedef {Object} SuggestedIntent
 * @property {string} label the underlying question (`intents.label`, §3)
 * @property {string} category one of {@link PROMPT_CATEGORIES}
 * @property {string[]} paraphrases prompt texts, ≤ {@link MAX_PROMPT_CHARS} chars each
 */

/**
 * @typedef {Object} SuggestResult
 * @property {'llm'|'starter'} source
 * @property {SuggestedIntent[]} intents
 * @property {string|null} reason why the starter pack was used, when it was
 */

/** Prompt text limit shared with `POST /api/prompts` (§10.3). */
export const MAX_PROMPT_CHARS = 300;

/** Intents requested from the model, and the ceiling applied to whatever comes back (§6.7). */
export const MIN_INTENTS = 5;
export const MAX_INTENTS = 12;

/** Paraphrases per intent (§6.6 default). */
export const PARAPHRASES_PER_INTENT = 3;

/** Categories the UI offers (§11.5) plus the quarantine category (§6.7). */
export const PROMPT_CATEGORIES = /** @type {readonly string[]} */ ([
  'general',
  'comparison',
  'use-case',
  'local',
  'pricing',
  'branded',
]);

/** Leading list numbering or bullets to strip from a drafted prompt (§6.7). */
const NUMBERING = /^\s*(?:\d+\s*[.)\]]|[-*•–—])\s*/;

/** A matched pair of wrapping quotes, straight or curly. */
const WRAPPING_QUOTES = /^(?:"([\s\S]*)"|'([\s\S]*)'|“([\s\S]*)”|‘([\s\S]*)’)$/;

/**
 * Normalise one drafted line into a storable prompt: numbering stripped, quotes
 * unwrapped, whitespace collapsed, capped at {@link MAX_PROMPT_CHARS} on a word
 * boundary (a cut prompt still has to read as a question someone would type).
 *
 * @param {unknown} value
 * @returns {string} '' when there is nothing usable left
 */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\s+/gu, ' ').trim();

  // Numbering can survive a quote ("1. best crm"), so strip in both orders.
  for (let i = 0; i < 3; i += 1) {
    const before = text;
    text = text.replace(NUMBERING, '').trim();
    const quoted = WRAPPING_QUOTES.exec(text);
    if (quoted) text = (quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4] ?? '').trim();
    if (text === before) break;
  }

  if (text.length > MAX_PROMPT_CHARS) {
    const cut = text.slice(0, MAX_PROMPT_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > MAX_PROMPT_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return text;
}

/**
 * Every string that identifies the brand: its name plus its aliases (§6.7).
 * @param {BrandInput} brand
 * @returns {string[]}
 */
function brandAliases(brand) {
  return [brand?.name ?? '', ...(brand?.aliases ?? [])].map((alias) => String(alias ?? '').trim()).filter(Boolean);
}

/**
 * Category for a drafted intent: the model's suggestion when it is one we offer,
 * overridden by `branded` whenever the label or any paraphrase names the brand.
 *
 * @param {{label:string, paraphrases:string[]}} intent
 * @param {BrandInput} brand
 * @param {unknown} suggested
 * @returns {string}
 */
function categoryFor(intent, brand, suggested) {
  const aliases = brandAliases(brand);
  const namesBrand = [intent.label, ...intent.paraphrases].some((text) => containsAlias(text, aliases));
  if (namesBrand) return 'branded';
  const proposed = String(suggested ?? '').trim().toLowerCase();
  return PROMPT_CATEGORIES.includes(proposed) && proposed !== 'branded' ? proposed : 'general';
}

/**
 * Coerce whatever the model returned into `{intents:[…]}`, tolerating a code fence or a
 * sentence of preamble around the JSON. Returns null when nothing parses (§6.7 retry).
 *
 * @param {unknown} raw the model's text, or an already-parsed object
 * @returns {{intents: unknown[]}|null}
 */
export function parseDraft(raw) {
  /** @type {unknown} */
  let value = raw;

  if (typeof value === 'string') {
    const text = value.replace(/```(?:json)?/gi, '').trim();
    /** @type {unknown} */
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const start = text.search(/[[{]/);
      const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
      if (start === -1 || end <= start) return null;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    value = parsed;
  }

  if (Array.isArray(value)) return { intents: value };
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (Array.isArray(record.intents)) return { intents: record.intents };
  }
  return null;
}

/**
 * Post-processing (§6.7) — the pure, unit-tested half.
 *
 * Deduplicates labels and paraphrases case-insensitively across the whole draft, strips
 * numbering, enforces the 300-character cap, allow-lists categories and tags branded
 * intents. Intents left with no usable paraphrase are dropped rather than padded.
 *
 * @param {unknown} draft parsed draft, or the model's raw text
 * @param {{brand: BrandInput}} ctx
 * @returns {SuggestedIntent[]}
 */
export function postProcess(draft, ctx) {
  const parsed = parseDraft(draft);
  if (!parsed) return [];
  const brand = ctx?.brand ?? { name: '' };

  /** @type {SuggestedIntent[]} */
  const intents = [];
  const seenText = new Set();

  for (const entry of parsed.intents) {
    if (intents.length >= MAX_INTENTS) break;
    if (!entry || typeof entry !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (entry);

    const rawParaphrases = Array.isArray(record.paraphrases)
      ? record.paraphrases
      : Array.isArray(record.prompts)
        ? record.prompts
        : [];

    /** @type {string[]} */
    const paraphrases = [];
    for (const candidate of rawParaphrases) {
      if (paraphrases.length >= PARAPHRASES_PER_INTENT) break;
      const text = cleanText(candidate);
      if (text === '') continue;
      const key = text.toLowerCase();
      if (seenText.has(key)) continue;
      seenText.add(key);
      paraphrases.push(text);
    }

    const label = cleanText(record.label ?? record.intent ?? paraphrases[0] ?? '');
    if (label === '' || paraphrases.length === 0) continue;
    const labelKey = `label:${label.toLowerCase()}`;
    if (seenText.has(labelKey)) continue;
    seenText.add(labelKey);

    intents.push({ label, category: categoryFor({ label, paraphrases }, brand, record.category), paraphrases });
  }

  return intents;
}

/**
 * A five-intent, three-phrasing starter pack for review. It uses concrete wording even
 * when the user has not named a competitor. Each phrase is editable before approval.
 *
 * @param {{brand?: BrandInput, competitors?: {name:string}[], categoryHint?: string,
 *   productJob?: string, audience?: string, desiredConversion?: string, year?: number}} input
 * @returns {SuggestedIntent[]}
 */
export function starterPack(input) {
  const brandName = String(input?.brand?.name ?? '').trim();
  const audience = String(input?.audience ?? '').trim() || 'a small team';
  const job = String(input?.productJob ?? '').trim() || 'this work';
  const category = String(input?.categoryHint ?? '').trim() || 'tools for this work';
  const rival = (input?.competitors ?? []).map((c) => String(c?.name ?? '').trim()).find(Boolean);
  const brandSubject = brandName || 'this product';
  /** @type {SuggestedIntent[]} */
  const intents = [
    {
      label: 'Find options', category: 'general', paraphrases: [
        `What are the best ${category} for ${audience}?`,
        `Which ${category} should ${audience} consider?`,
        `What options can help ${audience} with ${job}?`,
      ],
    },
    {
      label: 'Match the job', category: 'use-case', paraphrases: [
        `Which ${category} work well for ${audience} doing ${job}?`,
        `How can ${audience} choose a tool for ${job}?`,
        `What features matter most to ${audience} for ${job}?`,
      ],
    },
    {
      label: 'Compare options', category: 'comparison', paraphrases: rival ? [
        `How does ${rival} compare with other ${category} for ${audience}?`,
        `What are the main alternatives to ${rival} for ${job}?`,
        `When should ${audience} choose ${rival} over another option?`,
      ] : [
        `How should ${audience} compare ${category}?`,
        `What tradeoffs should ${audience} consider among ${category}?`,
        `Which differences matter most when choosing ${category} for ${job}?`,
      ],
    },
    {
      label: 'Understand cost', category: 'pricing', paraphrases: [
        `How much should ${audience} budget for ${category}?`,
        `What does it usually cost to get help with ${job}?`,
        `How can ${audience} compare the price of ${category}?`,
      ],
    },
    {
      label: brandName ? `Consider ${brandName}` : 'Consider a provider',
      category: brandName ? 'branded' : 'general', paraphrases: [
        `Is ${brandSubject} a good fit for ${audience}?`,
        `How does ${brandSubject} help with ${job}?`,
        `What should ${audience} know before choosing ${brandSubject}?`,
      ],
    },
  ];
  return intents.map((intent) => ({
    ...intent,
    paraphrases: intent.paraphrases.map((text) => cleanText(text)),
  }));
}

/**
 * The instruction sent to the drafting model. Kept here (not in a provider adapter) so
 * the wording is reviewable next to the rules that clean up its output.
 *
 * @param {{brand: BrandInput, competitors?: {name:string}[], categoryHint?: string, keywords?: string, strict?: boolean}} input
 * @returns {string}
 */
export function buildDraftPrompt(input) {
  const brand = input?.brand ?? { name: '' };
  const competitors = (input?.competitors ?? []).map((c) => String(c?.name ?? '').trim()).filter(Boolean);
  const lines = [
    `Brand: ${String(brand.name ?? '').trim()}`,
    brand.domains?.length ? `Domains: ${brand.domains.join(', ')}` : '',
    competitors.length ? `Competitors: ${competitors.join(', ')}` : '',
    input?.categoryHint ? `Category: ${String(input.categoryHint).trim()}` : '',
    input?.keywords ? `Keywords: ${String(input.keywords).trim()}` : '',
  ].filter(Boolean);

  const schema =
    '{"intents":[{"label":"the underlying question","category":"general|comparison|use-case|local|pricing",' +
    '"paraphrases":["phrasing 1","phrasing 2","phrasing 3"]}]}';

  return [
    `List the questions a buyer would ask an AI assistant when they are shopping in this market, before they know which product to pick.`,
    '',
    lines.join('\n'),
    '',
    `Return ${MIN_INTENTS}-${MAX_INTENTS} intents. Give each intent exactly ${PARAPHRASES_PER_INTENT} paraphrases — the same question asked in different words, because phrasing changes the answer.`,
    `Most intents should not name any brand: they measure discovery, not recall.`,
    `Keep every paraphrase under ${MAX_PROMPT_CHARS} characters, with no numbering and no quotes.`,
    '',
    input?.strict
      ? 'Reply with JSON only. No prose, no code fence. Exactly this shape:'
      : 'Reply with JSON in exactly this shape:',
    schema,
  ].join('\n');
}

/**
 * Draft intents for a brand (§6.7).
 *
 * `runPrompt` is injected — it takes the drafting prompt and resolves to the model's
 * text (or a `{text}` result, as the provider adapters return, §5.1). Without it, or
 * when the model's reply will not parse twice running, the caller still gets the starter
 * pack. Nothing is persisted either way.
 *
 * @param {Object} input
 * @param {BrandInput} input.brand
 * @param {{name:string}[]} [input.competitors]
 * @param {string} [input.categoryHint]
 * @param {string} [input.keywords]
 * @param {((prompt:string) => Promise<string|{text:string}>)|null} [input.runPrompt]
 * @param {number} [input.year] used by the starter pack; defaults to the current UTC year
 * @returns {Promise<SuggestResult>}
 */
export async function suggestIntents(input) {
  const fallback = () => starterPack(input);

  if (typeof input?.runPrompt !== 'function') {
    return { source: 'starter', intents: fallback(), reason: 'no-provider-key' };
  }

  /** @type {string|null} */
  let reason = null;
  for (const strict of [false, true]) {
    let replyText = '';
    try {
      const reply = await input.runPrompt(buildDraftPrompt({ ...input, strict }));
      replyText = typeof reply === 'string' ? reply : String(reply?.text ?? '');
    } catch {
      // Provider failures are not the caller's problem here — fall back, never throw a
      // key or an endpoint into a user-facing error (§19.6 #9).
      reason = 'provider-error';
      break;
    }
    const intents = postProcess(replyText, { brand: input.brand });
    if (intents.length > 0) return { source: 'llm', intents, reason: null };
    reason = 'unparseable-draft';
  }

  return { source: 'starter', intents: fallback(), reason };
}
