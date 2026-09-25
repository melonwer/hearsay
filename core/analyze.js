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
 * including subdomains. Stance classification uses conservative, entity-specific
 * English claims and records the evidence span and rule for review.
 *
 * Field names deliberately mirror the SQL columns in §3 and the JSON in §10.3
 * (`entity_id`, `first_index`, `occurrences`, `rank`, `recommended`, `snippet`).
 * `recommended` is 0|1 like the column.
 */

/**
 * @typedef {Object} AnalyzeEntity
 * @property {number} id
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string[]} [domains]
 * @property {boolean} [ambiguousName] request identity review for an ordinary-word name
 */

/**
 * @typedef {Object} MentionResult
 * @property {number} entity_id
 * @property {number} first_index char offset of the first match in the raw answer
 * @property {number} occurrences total consumed matches for this entity
 * @property {number} rank 1 = first entity mentioned in the answer
 * @property {number} recommended compatibility bit; 1 only for a positive stance
 * @property {'positive'|'negative'|'neutral'|'uncertain'} stance
 * @property {string} rule_id
 * @property {number} evidence_start UTF-16 offset into the immutable answer
 * @property {number} evidence_end exclusive UTF-16 offset into the immutable answer
 * @property {string[]} review_flags
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

export const STANCE_REVISION = 'stance-en-v1';

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

/** @typedef {'positive'|'negative'|'neutral'|'uncertain'} Stance */
/** @typedef {{stance:Stance,ruleId:string,start:number,end:number,flags:string[]}} StanceDecision */

/**
 * Find the clause containing a particular alias. Newlines and sentence punctuation
 * delimit evidence, while a numbered-list marker stays in its item's span.
 * @param {string} text
 * @param {AliasMatch} match
 * @returns {{start:number,end:number}}
 */
function clauseSpan(text, match) {
  const lineStart = text.lastIndexOf('\n', match.start - 1) + 1;
  const lineEndAt = text.indexOf('\n', match.end);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
  let start = lineStart;
  let end = lineEnd;
  const punctuation = /[.!?;](?=\s|$)/g;
  const line = text.slice(lineStart, lineEnd);
  const listMarker = /^\s*\d+[.)]\s+/.exec(line);
  for (const hit of line.matchAll(punctuation)) {
    const at = lineStart + (hit.index ?? 0);
    if (listMarker && at < lineStart + listMarker[0].length) continue;
    if (at < match.start) start = at + 1;
    else if (at >= match.end && end === lineEnd) end = at + 1;
  }
  return { start, end };
}

/**
 * Classify an entity's local claim. The patterns must bind to the alias itself;
 * a positive phrase elsewhere in the answer cannot endorse another entity.
 * @param {string} text
 * @param {AliasMatch} match
 * @param {boolean} ambiguousName
 * @returns {StanceDecision}
 */
function stanceForMatch(text, match, ambiguousName) {
  const span = clauseSpan(text, match);
  const before = text.slice(span.start, match.start).replace(/[\s*`_]+$/g, '');
  const after = text.slice(match.end, span.end).replace(/^[\s*`_]+/g, '');
  const clause = text.slice(span.start, span.end);
  /** @type {string[]} */
  const flags = [];
  if (ambiguousName) flags.push('ambiguous_entity_name');

  const decision = (/** @type {Stance} */ stance, /** @type {string} */ ruleId, start = span.start, end = span.end) =>
    ({ stance, ruleId, start, end, flags });
  if (ambiguousName) return decision('uncertain', 'identity_review');
  const withoutAlias = `${before} ${after}`;
  if (/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Mark}]/u.test(withoutAlias)) {
    flags.push('unsupported_language');
    return decision('uncertain', 'unsupported_language');
  }
  const quoteOpen = (text.slice(span.start, match.start).match(/["“]/g) ?? []).length;
  const quoteClose = (text.slice(match.end, span.end).match(/["”]/g) ?? []).length;
  if (quoteOpen % 2 === 1 && quoteClose % 2 === 1) {
    flags.push('quoted_claim');
    return decision('uncertain', 'quoted_claim');
  }
  if (/\b(?:if|unless|might|may|could|perhaps|maybe|depending|potentially)\b/i.test(clause)) {
    flags.push('conditional_claim');
    return decision('uncertain', 'conditional_claim');
  }
  if (/\b(?:but|however|yet|although)\s+(?:it|this|that|the\s+(?:tool|product|option))\b/i.test(after)) {
    flags.push('mixed_claims');
    return decision('uncertain', 'mixed_claims');
  }

  const currentLine = text.slice(text.lastIndexOf('\n', match.start - 1) + 1, text.indexOf('\n', match.end) < 0 ? text.length : text.indexOf('\n', match.end));
  if (/^\s*(?:[-*•]|\d+[.)])\s/.test(currentLine)) {
    let lineEnd = text.lastIndexOf('\n', match.start - 1);
    while (lineEnd >= 0) {
      const headingStart = text.lastIndexOf('\n', lineEnd - 1) + 1;
      const preceding = text.slice(headingStart, lineEnd).trim();
      if (/^\s*(?:[-*•]|\d+[.)])\s/.test(preceding)) {
        lineEnd = headingStart - 1;
        continue;
      }
      if (/\b(?:products?|tools?|options?)\s+to\s+avoid\s*:/i.test(preceding)) {
        return decision('negative', 'avoid_heading', headingStart, span.end);
      }
      break;
    }
  }

  if (/\b(?:do\s+not|don't|does\s+not|doesn't|would\s+not|wouldn't|won't|cannot|can't|never)\s+(?:(?:really|ever|usually)\s+)?(?:recommend|suggest|choose|pick|use)\s*$/i.test(before) ||
      /\b(?:don't|do\s+not)\s+think\s+(?:I|we)\s+(?:would|should)\s+(?:recommend|suggest|choose|pick|use)\s*$/i.test(before) ||
      /\b(?:avoid|skip|reject|discourage|do\s+not\s+use)\s*$/i.test(before) ||
      /^(?:is|are|would\s+be|seems?)\s+(?:not\s+(?:(?:a|the)\s+)?(?:good|strong|recommended|suitable|right|best)|unsuitable|(?:a|the)\s+(?:poor|bad)\s+(?:choice|option|fit)|inferior)\b/i.test(after) ||
      /^should\s+(?:be\s+)?avoided\b/i.test(after)) {
    return decision('negative', 'explicit_rejection');
  }
  if (/\b(?:recommend|suggest|choose|pick|use|go\s+with)\s*$/i.test(before) ||
      /\b(?:best|top|strongest|first)\s+(?:pick|choice|option|recommendation)(?:\s+\w+){0,2}\s+(?:is|:)\s*$/i.test(before) ||
      /#1\s*:\s*$/i.test(before) ||
      /^(?:is|would\s+be|remains)\s+(?:(?:the|a)\s+)?(?:best|top|great|good|strong|excellent|usual|recommended)\s+(?:pick|choice|option|fit|tool|product)\b/i.test(after)) {
    return decision('positive', 'explicit_endorsement');
  }
  if (/^(?:offers|supports|includes|provides|has|integrates|costs|stores|exports)\b/i.test(after) ||
      /^works\s+with\b/i.test(after)) {
    return decision('neutral', 'factual_claim');
  }
  return decision('uncertain', 'no_supported_claim');
}

/**
 * Trailing characters trimmed from a bare URL (§6.3), so "see https://x.io/a)." yields
 * "https://x.io/a".
 */
const URL_TRAILING = /[).,;:!?'"\]}>»…]+$/;

/**
 * Normalise one URL to `{url, domain}`, or null when it will not parse — or when it
 * is not a web URL. Only `http:`/`https:` pass: a citation is a web receipt, and a
 * stored `javascript:` URL would become a clickable XSS payload the moment the
 * answers page renders it as an href (§10.1). Native provider citations are the one
 * path with no upstream scheme filter, so the allowlist lives here.
 * @param {string} raw
 * @returns {{url:string, domain:string}|null}
 */
export function normaliseUrl(raw) {
  const url = String(raw ?? '')
    .trim()
    .replace(URL_TRAILING, '');
  if (url === '') return null;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
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
 * Mention detection plus a conservative stance interpretation for one answer.
 * @param {string} text
 * @param {AnalyzeEntity[]} entities
 * @returns {MentionResult[]} ordered by rank
 */
export function extractMentions(text, entities) {
  const body = typeof text === 'string' ? text : '';
  const matches = findAliasMatches(body, entities);
  if (matches.length === 0) return [];

  /** @type {Map<number, AliasMatch[]>} */
  const byEntity = new Map();
  for (const match of matches) {
    const bucket = byEntity.get(match.entityId);
    if (bucket) bucket.push(match);
    else byEntity.set(match.entityId, [match]);
  }

  /** @type {MentionResult[]} */
  const mentions = [];
  for (const [entityId, entityMatches] of byEntity) {
    const first = entityMatches[0];
    const ambiguousName = entities.some((entity) => entity.id === entityId && entity.ambiguousName === true);
    const decisions = entityMatches.map((match) => stanceForMatch(body, match, ambiguousName));
    const labels = new Set(decisions.map((decision) => decision.stance).filter((stance) => stance !== 'neutral'));
    const conflict = labels.size > 1 || decisions.some((decision) => decision.stance === 'uncertain') && decisions.length > 1;
    const selected = conflict
      ? /** @type {StanceDecision} */ ({ stance: 'uncertain', ruleId: 'mixed_claims', start: decisions[0].start, end: decisions.at(-1)?.end ?? decisions[0].end, flags: ['mixed_claims'] })
      : decisions.find((decision) => decision.stance !== 'neutral') ?? decisions[0];
    mentions.push({
      entity_id: entityId,
      first_index: first.start,
      occurrences: entityMatches.length,
      rank: 0, // assigned below, once every entity's first index is known
      recommended: selected.stance === 'positive' ? 1 : 0,
      stance: selected.stance,
      rule_id: selected.ruleId,
      evidence_start: selected.start,
      evidence_end: selected.end,
      review_flags: selected.flags,
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
