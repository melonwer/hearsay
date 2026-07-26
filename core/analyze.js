/**
 * Analyzer — PURE functions, no I/O (§6, §19.6 #6).
 *
 * `analyzeResponse(text, entities, nativeCitations)` turns one raw answer into the rows
 * the runner inserts: `mentions` (§3) and `citations` (§3). No clock, no database, no
 * randomness — the same answer always produces the same rows.
 *
 * Mention detection (§6.2): alias list per entity, longest-alias-first matching with
 * span consumption, word boundaries on both sides, optional trailing possessive,
 * regex-escaped aliases matched against the raw text with `iu`, offsets recorded
 * against that raw text, ±120-char word-trimmed snippets, 1-based rank by first index.
 * Citations (§6.3): native → markdown → bare URLs, deduped by URL keeping the earliest
 * rank, domain lowercased and `www.`-stripped, entity matched via `entities.domains`
 * including subdomains. Recommendation detection (§6.4): R1 trigger proximity,
 * R2 list leadership, R3 short-answer lead — deterministic, no ML sentiment (§1.5).
 *
 * Field names deliberately mirror the SQL columns in §3 and the JSON in §10.3
 * (`entity_id`, `first_index`, `occurrences`, `rank`, `recommended`, `snippet`), so a
 * result row can be bound straight into an INSERT. `recommended` is 0|1 like the column.
 */

/**
 * @typedef {Object} AnalyzeEntity
 * @property {number} id
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string[]} [domains]
 */

/**
 * @typedef {Object} MentionResult
 * @property {number} entity_id
 * @property {number} first_index char offset of the first match in the raw answer
 * @property {number} occurrences total consumed matches for this entity
 * @property {number} rank 1 = first entity mentioned in the answer
 * @property {number} recommended 0|1 per §6.4
 * @property {string} snippet ±120 chars of context, original casing
 */

/**
 * @typedef {Object} CitationResult
 * @property {string} url
 * @property {string} domain hostname, lowercased, `www.` stripped
 * @property {number} rank order of appearance, 1-based
 * @property {number|null} entity_id entity owning the domain, else null
 */

/** Aliases shorter than this are ignored; the API layer rejects them with 422 (§6.2, §10.3). */
export const MIN_ALIAS_LENGTH = 3;

/** Context kept either side of the first match when building a snippet (§6.2). */
export const SNIPPET_RADIUS = 120;

/** Trigger phrases for R1 proximity (§6.4), matched case-insensitively. */
export const TRIGGER_PHRASES = /** @type {readonly string[]} */ ([
  'recommend',
  'recommended',
  'best',
  'top pick',
  'top choice',
  "i'd suggest",
  'i would suggest',
  'great choice',
  'go with',
  '#1',
]);

/** R1 window: a match must start no more than this many chars after a trigger ends (§6.4). */
export const TRIGGER_WINDOW = 80;

/** R3 applies only to answers shorter than this (§6.4). */
export const SHORT_ANSWER_CHARS = 400;

/** A list item line (§6.4 R2). */
const LIST_ITEM_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Escape regex metacharacters (§6.2 #4). Only ECMAScript SyntaxCharacters are escaped,
 * which keeps the pattern legal under the `u` flag (`\-` would not be).
 * @param {string} literal
 * @returns {string}
 */
export function escapeRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when a character cannot be part of a word for boundary purposes (§6.2 #3).
 * Out-of-range indices (string start/end) qualify as boundaries.
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isBoundaryAt(text, index) {
  if (index < 0 || index >= text.length) return true;
  return !/[A-Za-z0-9]/.test(text.charAt(index));
}

/**
 * Build the deduplicated alias list for one entity: `[name, ...aliases]` minus anything
 * shorter than {@link MIN_ALIAS_LENGTH} (§6.2 #1).
 * @param {AnalyzeEntity} entity
 * @returns {string[]}
 */
export function aliasesFor(entity) {
  const raw = [entity.name, ...(entity.aliases ?? [])];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const candidate of raw) {
    const alias = String(candidate ?? '').trim();
    if (alias.length < MIN_ALIAS_LENGTH) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/**
 * @typedef {Object} AliasMatch
 * @property {number} entityId
 * @property {string} alias the alias that matched
 * @property {number} start index in the raw text
 * @property {number} end exclusive index, possessive suffix included when consumed
 */

/**
 * Longest-alias-first matching with span consumption (§6.2 #2–#4).
 *
 * All aliases across all entities are sorted by length descending, so "Notewell Pro"
 * claims its span before "Notewell" can, and an already-consumed span can never be
 * matched again — no overlapping double-counts.
 *
 * @param {string} text raw answer
 * @param {AnalyzeEntity[]} entities
 * @returns {AliasMatch[]} matches in text order
 */
export function findAliasMatches(text, entities) {
  if (typeof text !== 'string' || text === '') return [];

  /** @type {{entityId:number, alias:string}[]} */
  const candidates = [];
  for (const entity of entities ?? []) {
    for (const alias of aliasesFor(entity)) candidates.push({ entityId: entity.id, alias });
  }
  // Longest first; ties broken deterministically so results never depend on input order.
  candidates.sort(
    (a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias) || a.entityId - b.entityId,
  );

  /** @type {AliasMatch[]} */
  const matches = [];
  /** @type {{start:number, end:number}[]} */
  const consumed = [];
  /**
   * @param {number} start
   * @param {number} end
   * @returns {boolean}
   */
  const overlaps = (start, end) => consumed.some((span) => start < span.end && end > span.start);

  for (const { entityId, alias } of candidates) {
    const re = new RegExp(escapeRegex(alias), 'giu');
    /** @type {RegExpExecArray|null} */
    let hit;
    while ((hit = re.exec(text)) !== null) {
      const start = hit.index;
      let end = start + hit[0].length;
      // Advance past this occurrence even if we reject it, and never loop on an empty match.
      re.lastIndex = end > start ? end : start + 1;

      if (!isBoundaryAt(text, start - 1)) continue;

      // Allow a trailing possessive — but only when it actually ends the word (§6.2 #3).
      const possessive = /^['’]s/.test(text.slice(end, end + 2));
      if (possessive && isBoundaryAt(text, end + 2)) end += 2;
      else if (!isBoundaryAt(text, end)) continue;

      if (overlaps(start, end)) continue;
      consumed.push({ start, end });
      matches.push({ entityId, alias, start, end });
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

/**
 * True when any of `aliases` occurs in `text` under §6.2 boundary rules. Shared with
 * `core/suggest.js` so branded-prompt tagging (§6.7) uses exactly the analyzer's notion
 * of "mentions the brand".
 * @param {string} text
 * @param {string[]} aliases
 * @returns {boolean}
 */
export function containsAlias(text, aliases) {
  return findAliasMatches(text, [{ id: 1, name: '', aliases }]).length > 0;
}

/**
 * ±{@link SNIPPET_RADIUS} chars around a match, trimmed to word edges, with `…` where
 * the answer continues (§6.2 #5). Characters are kept verbatim — original casing,
 * original punctuation — so a receipt stays quotable.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function snippetAround(text, start, end) {
  let from = Math.max(0, start - SNIPPET_RADIUS);
  let to = Math.min(text.length, end + SNIPPET_RADIUS);

  if (from > 0) {
    const space = text.slice(from, start).search(/\s/);
    if (space !== -1) from += space + 1;
  }
  if (to < text.length) {
    const cut = text.slice(end, to).search(/\s\S*$/);
    if (cut !== -1) to = end + cut;
  }

  const body = text.slice(from, to).trim();
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}

/**
 * Character span of the first list item of the first list in the answer (§6.4 R2),
 * or null when the answer contains no list.
 * @param {string} text
 * @returns {{start:number, end:number}|null}
 */
export function firstListItemSpan(text) {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (LIST_ITEM_RE.test(line)) return { start: offset, end: offset + line.length };
    offset += line.length + 1;
  }
  return null;
}

/**
 * Character span of the first sentence (§6.4 R3): everything up to and including the
 * first `.`, `!` or `?` that is followed by whitespace or the end of the answer.
 * @param {string} text
 * @returns {{start:number, end:number}}
 */
export function firstSentenceSpan(text) {
  const stop = /[.!?](?=\s|$)/.exec(text);
  return { start: 0, end: stop ? stop.index + 1 : text.length };
}

/**
 * End offsets of every trigger-phrase occurrence (§6.4 R1). Curly apostrophes are
 * normalised to straight ones so "I’d suggest" counts.
 * @param {string} text
 * @returns {number[]}
 */
function triggerEnds(text) {
  const normalised = text.replace(/’/g, "'").toLowerCase();
  /** @type {number[]} */
  const ends = [];
  for (const phrase of TRIGGER_PHRASES) {
    let from = 0;
    for (;;) {
      const at = normalised.indexOf(phrase, from);
      if (at === -1) break;
      from = at + 1;
      // Word boundaries on both sides, exactly like alias matching (§6.2 #3): '#1'
      // must not fire inside '#10', 'best' inside 'asbestos', 'go with' inside
      // 'cargo with'.
      if (!isBoundaryAt(normalised, at - 1) || !isBoundaryAt(normalised, at + phrase.length)) continue;
      ends.push(at + phrase.length);
    }
  }
  return ends;
}

/**
 * @typedef {Object} AnswerContext
 * @property {number[]} triggerEnds
 * @property {{start:number,end:number}|null} listItem
 * @property {{start:number,end:number}} firstSentence
 * @property {boolean} short
 */

/**
 * Recommendation heuristics (§6.4) for one entity in one answer.
 * @param {number[]} starts every match start for this entity, ascending
 * @param {AnswerContext} ctx precomputed answer facts, shared across entities
 * @returns {boolean}
 */
function isRecommended(starts, ctx) {
  if (starts.length === 0) return false;
  const first = starts[0];

  // R1 — proximity to a trigger phrase.
  for (const end of ctx.triggerEnds) {
    for (const start of starts) {
      if (start >= end && start - end <= TRIGGER_WINDOW) return true;
    }
  }

  // R2 — first mention inside the first item of the first list.
  if (ctx.listItem && first >= ctx.listItem.start && first < ctx.listItem.end) return true;

  // R3 — short answer, first mention in the first sentence.
  if (ctx.short && first < ctx.firstSentence.end) return true;

  return false;
}

/**
 * Trailing characters trimmed from a bare URL (§6.3), so "see https://x.io/a)." yields
 * "https://x.io/a".
 */
const URL_TRAILING = /[).,;:!?'"\]}>»…]+$/;

/**
 * Normalise one URL to `{url, domain}`, or null when it will not parse.
 * @param {string} raw
 * @returns {{url:string, domain:string}|null}
 */
export function normaliseUrl(raw) {
  const url = String(raw ?? '')
    .trim()
    .replace(URL_TRAILING, '');
  if (url === '') return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const domain = host.toLowerCase().replace(/^www\./, '');
  if (domain === '') return null;
  return { url, domain };
}

/**
 * Normalise an entity domain for comparison: lowercased hostname, `www.` stripped, any
 * scheme or path discarded.
 * @param {string} raw
 * @returns {string}
 */
export function normaliseDomain(raw) {
  let value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (value === '') return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split('/')[0].split('?')[0].split('#')[0];
  return value.replace(/^www\./, '');
}

/**
 * The entity owning a cited domain: exact match, or a parent domain
 * (`docs.notewell.io` → `notewell.io`). Ties are impossible while the API layer rejects
 * duplicate domains across entities (§6.3, §10.3).
 * @param {string} domain
 * @param {AnalyzeEntity[]} entities
 * @returns {number|null}
 */
export function entityForDomain(domain, entities) {
  /** @type {{id:number, length:number}|null} */
  let best = null;
  for (const entity of entities ?? []) {
    for (const raw of entity.domains ?? []) {
      const owned = normaliseDomain(raw);
      if (owned === '') continue;
      if (domain === owned || domain.endsWith(`.${owned}`)) {
        // The longest owned domain wins, so a more specific claim beats a broader one.
        if (!best || owned.length > best.length) best = { id: entity.id, length: owned.length };
      }
    }
  }
  return best ? best.id : null;
}

/**
 * Citation extraction (§6.3): native citations first, then markdown links, then bare
 * URLs; deduped by URL with the first occurrence keeping the earliest rank.
 * @param {string} text
 * @param {AnalyzeEntity[]} entities
 * @param {{url:string}[]} [nativeCitations]
 * @returns {CitationResult[]}
 */
export function extractCitations(text, entities, nativeCitations = []) {
  /** @type {string[]} */
  const ordered = [];
  for (const native of nativeCitations ?? []) {
    if (native && typeof native.url === 'string') ordered.push(native.url);
  }

  const body = typeof text === 'string' ? text : '';
  const markdown = /\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/giu;
  /** @type {RegExpExecArray|null} */
  let hit;
  while ((hit = markdown.exec(body)) !== null) ordered.push(hit[1]);

  const bare = /https?:\/\/[^\s<>"'`)\]]+/giu;
  while ((hit = bare.exec(body)) !== null) ordered.push(hit[0]);

  /** @type {CitationResult[]} */
  const out = [];
  const seen = new Set();
  for (const raw of ordered) {
    const parsed = normaliseUrl(raw);
    if (!parsed) continue;
    if (seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    out.push({
      url: parsed.url,
      domain: parsed.domain,
      rank: out.length + 1,
      entity_id: entityForDomain(parsed.domain, entities),
    });
  }
  return out;
}

/**
 * Mention detection (§6.2) plus recommendation heuristics (§6.4) for one answer.
 * @param {string} text
 * @param {AnalyzeEntity[]} entities
 * @returns {MentionResult[]} ordered by rank
 */
export function extractMentions(text, entities) {
  const body = typeof text === 'string' ? text : '';
  const matches = findAliasMatches(body, entities);
  if (matches.length === 0) return [];

  /** @type {Map<number, {starts:number[], first:AliasMatch}>} */
  const byEntity = new Map();
  for (const match of matches) {
    const bucket = byEntity.get(match.entityId);
    if (bucket) bucket.starts.push(match.start);
    else byEntity.set(match.entityId, { starts: [match.start], first: match });
  }

  /** @type {AnswerContext} */
  const ctx = {
    triggerEnds: triggerEnds(body),
    listItem: firstListItemSpan(body),
    firstSentence: firstSentenceSpan(body),
    short: body.length < SHORT_ANSWER_CHARS,
  };

  /** @type {MentionResult[]} */
  const mentions = [];
  for (const [entityId, { starts, first }] of byEntity) {
    mentions.push({
      entity_id: entityId,
      first_index: first.start,
      occurrences: starts.length,
      rank: 0, // assigned below, once every entity's first index is known
      recommended: isRecommended(starts, ctx) ? 1 : 0,
      snippet: snippetAround(body, first.start, first.end),
    });
  }

  mentions.sort((a, b) => a.first_index - b.first_index || a.entity_id - b.entity_id);
  mentions.forEach((mention, i) => {
    mention.rank = i + 1;
  });
  return mentions;
}

/**
 * Analyse one answer (§6.1).
 *
 * @param {string} text raw answer
 * @param {AnalyzeEntity[]} entities non-archived entities with their aliases and domains
 * @param {{url:string}[]} [nativeCitations] provider-supplied citations, in order
 * @returns {{mentions: MentionResult[], citations: CitationResult[]}}
 */
export function analyzeResponse(text, entities, nativeCitations = []) {
  const list = Array.isArray(entities) ? entities : [];
  return {
    mentions: extractMentions(text, list),
    citations: extractCitations(text, list, nativeCitations),
  };
}
