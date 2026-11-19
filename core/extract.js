/**
 * Bot-vs-Human / Edge Markdown extraction, line-level diffing, and 10 forensic
 * signals for `hearsay check` v2.
 *
 * Uses the strictly allowlisted 2-package pure-JS stack (`webforai` + `diff`)
 * when available, and gracefully falls back to a built-in pure-Node HTML-to-
 * Markdown converter + LCS line diff when `node_modules` is absent (such as
 * inside extracted plugin runtime archives).
 */

/** @type {typeof import('webforai') | null} */
let webforaiMod = null;
try {
  webforaiMod = await import('webforai');
} catch {
  webforaiMod = null;
}

/** @type {typeof import('diff') | null} */
let diffMod = null;
try {
  diffMod = await import('diff');
} catch {
  diffMod = null;
}

export const MAX_EXTRACTION_BYTES = 2 * 1024 * 1024;
export const MARKDOWN_WARN_CHARS = 50_000;
export const MARKDOWN_FAIL_CHARS = 100_000;
export const MAX_JSONLD_CHECK_VALUES = 200;

const KB_20 = 20 * 1024;
const KB_25 = 25 * 1024;
const KB_30 = 30 * 1024;
const KB_100 = 100 * 1024;
const KB_250 = 250 * 1024;
const KB_300 = 300 * 1024;
const KB_500 = 500 * 1024;
const KB_800 = 800 * 1024;
const MB_2 = 2 * 1024 * 1024;

/**
 * Curated 20+ cookie-consent and modal-dialog overlay selectors (SiteOne pattern)
 * stripped before Bot-vs-Human extraction so banners do not pollute diffs.
 */
export const CONSENT_OVERLAY_SELECTORS = Object.freeze([
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '#CybotCookiebotDialogBodyUnderlay',
  '#didomi-host',
  '#didomi-popup',
  '#qc-cmp2-container',
  '#truste-consent-track',
  '#usercentrics-root',
  '[id^="sp_message_container"]',
  '#cmplz-cookiebanner-container',
  '#cookie-law-info-bar',
  '#klaro',
  '#tarteaucitronRoot',
  '#osano-cm-window',
  '#iubenda-cs-banner',
  '#cky-consent-container',
  '.cc-window',
  '.cookie-banner',
  '.cookie-consent',
  '.cookie-notice',
  '[aria-modal="true"]',
  '[role="alertdialog"]',
]);

const CONSENT_EXACT_IDS = new Set([
  'onetrust-consent-sdk',
  'onetrust-banner-sdk',
  'onetrust-pc-sdk',
  'cybotcookiebotdialog',
  'cybotcookiebotdialogbodyunderlay',
  'didomi-host',
  'didomi-popup',
  'didomi-notice',
  'qc-cmp2-container',
  'truste-consent-track',
  'consent_blackbar',
  'teconsent',
  'usercentrics-root',
  'cmplz-cookiebanner-container',
  'cookie-law-info-bar',
  'cookie-law-info-again',
  'klaro',
  'tarteaucitronroot',
  'tarteaucitronalertbig',
  'osano-cm-window',
  'iubenda-cs-banner',
  'cky-consent-container',
  'cky-overlay',
  'cookie-banner',
  'cookie-consent',
  'cookie-notice',
  'cookie-popup',
  'cookie-modal',
  'cookiebanner',
  'cookieconsent',
  'gdpr-cookie-notice',
  'gdpr-banner',
  'consent-banner',
  'consent-modal',
  'termly-code-snippet-support',
  'axeptio_overlay',
  'borlabs-cookie',
]);

const CONSENT_ID_PREFIXES = [
  'sp_message_container',
  'onetrust-consent',
  'onetrust-banner',
  'cybotcookiebotdialog',
  'didomi-popup',
  'didomi-notice',
];

const CONSENT_CLASS_TOKENS = new Set([
  'cookie-banner',
  'cookie-consent',
  'cookie-notice',
  'cookie-modal',
  'cookie-popup',
  'cookie-bar',
  'cookie-overlay',
  'cookie-dialog',
  'cookiebanner',
  'cookieconsent',
  'cc-window',
  'cc-banner',
  'cky-consent-container',
  'cky-modal',
  'iubenda-cs-banner',
  'osano-cm-window',
  'osano-cm-dialog',
  'fc-consent-root',
  'cmp-container',
  'qc-cmp2-container',
  'didomi-popup-container',
  'didomi-notice-banner',
  'gdpr-banner',
  'gdpr-cookie-banner',
  'consent-banner',
  'consent-modal',
  'borlabs-cookie',
  'cmplz-cookiebanner',
  'tarteaucitron-root',
]);

const PROTECTED_OVERLAY_TAGS = new Set([
  'html', 'head', 'body', 'main', 'article', 'script', 'style', 'link', 'meta', 'title',
]);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style']);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const CHROME_LANDMARK_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
const EMBEDDED_TITLE_CONTAINERS = new Set(['svg', 'iframe', 'template', 'noscript']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const CONSENT_ARIA_LABEL_RE = /\bcookie(?:s)?\b[\s\S]{0,40}\b(?:consent|banner|notice|preferences|settings|policy|dialog)\b|\b(?:privacy|consent)\s+(?:preferences|settings|banner|center|notice|dialog)\b/i;
const CONSENT_TESTID_RE = /(?:cookie|consent|gdpr|cmp)[-_]?(?:banner|modal|dialog|notice|overlay|popup)/i;
const NOSCRIPT_JS_WARNING_RE = /(?:enable\s+javascript|javascript\s+(?:is\s+)?required|requires\s+javascript|turn\s+on\s+javascript|does\s+not\s+support\s+javascript|works?\s+best\s+with\s+javascript|without\s+javascript)/i;
const SOFT_404_RE = /\b404\b|\bnot\s+found\b|\bpage\s+(?:cannot|could\s+not|can't)\s+be\s+found\b/i;
const INLINE_HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const BASE64_IMAGE_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/** @type {Record<string, string>} */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
};

/**
 * @typedef {Object} ExtractedHeading
 * @property {number} level
 * @property {string} text
 */

/**
 * @typedef {Object} ExtractMarkdownOptions
 * @property {string} [url]
 * @property {boolean} [stripConsent]
 * @property {number} [maxBytes]
 * @property {boolean} [includeAgentMode]
 * @property {boolean} [includeTitle]
 * @property {boolean} [forceFallback]
 */

/**
 * @typedef {Object} ExtractedMarkdownResult
 * @property {'webforai'|'fallback'} engine
 * @property {string} markdown
 * @property {string} agentMarkdown
 * @property {number} wordCount
 * @property {number} charCount
 * @property {number} estimatedTokens
 * @property {ExtractedHeading[]} headings
 * @property {number} tablesCount
 * @property {number} codeBlocksCount
 * @property {number} sectionsCount
 * @property {boolean} truncatedAt2MiB
 */

/**
 * @typedef {Object} DiffLineEntry
 * @property {'context'|'add'|'remove'} type
 * @property {string} line
 */

/**
 * @typedef {Object} DiffHunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {DiffLineEntry[]} lines
 */

/**
 * @typedef {Object} DiffLinePart
 * @property {string} value
 * @property {boolean} [added]
 * @property {boolean} [removed]
 * @property {number} [count]
 */

/**
 * @typedef {Object} EdgeMarkdownSummary
 * @property {string} markdown
 * @property {number} wordCount
 * @property {number} charCount
 * @property {number} estimatedTokens
 * @property {ExtractedHeading[]} headings
 * @property {number} tablesCount
 * @property {number} codeBlocksCount
 * @property {number} sectionsCount
 * @property {number|null} xMarkdownTokens
 */

/**
 * @typedef {Object} DiffBotVsHumanInput
 * @property {string} botHtml
 * @property {string|null} [humanHtml]
 * @property {string|null} [edgeMarkdown]
 * @property {Headers|Record<string, string|string[]|undefined>|null} [edgeHeaders]
 * @property {string} [url]
 * @property {boolean} [forceFallback]
 */

/**
 * @typedef {Object} DiffBotVsHumanResult
 * @property {'webforai'|'fallback'} engine
 * @property {'diff'|'fallback'} diffEngine
 * @property {ExtractedMarkdownResult} bot
 * @property {ExtractedMarkdownResult|null} human
 * @property {EdgeMarkdownSummary|null} edge
 * @property {DiffHunk[]} hunks
 * @property {DiffHunk[]} edgeHunks
 * @property {{ addedLines: number, removedLines: number, unchangedLines: number }} diffSummary
 * @property {ExtractedHeading[]} missingHeadings
 * @property {string[]} droppedParagraphs
 * @property {number} lostTables
 * @property {number} lostCodeBlocks
 * @property {number|null} proseParityRatio
 * @property {number|null} edgeParityRatio
 * @property {boolean} edgeMarkdownCsrTrap
 * @property {boolean} missingVaryAccept
 */

/**
 * @typedef {Object} LargeInlineBlob
 * @property {'script'|'style'} kind
 * @property {string|null} id
 * @property {number} bytes
 * @property {boolean} isNextFlight
 * @property {boolean} isNextData
 */

/**
 * @typedef {Object} JsonLdCheckItem
 * @property {string} field
 * @property {string} value
 */

/**
 * @typedef {Object} JsonLdCrossCheckResult
 * @property {number} blocksCount
 * @property {number} parseErrors
 * @property {number} checkedCount
 * @property {number} matchedCount
 * @property {number} missingCount
 * @property {number|null} matchRatio
 * @property {boolean} truncatedAt200
 * @property {JsonLdCheckItem[]} matched
 * @property {JsonLdCheckItem[]} missing
 */

/**
 * @typedef {Object} MultiSectionDropResult
 * @property {boolean} warning
 * @property {number} bodySectionsCount
 * @property {number} bodyHeadingsCount
 * @property {number} extractedHeadingsCount
 * @property {string[]} droppedHeadings
 * @property {number} bodyTablesCount
 * @property {number} extractedTablesCount
 * @property {number} droppedTablesCount
 * @property {string|null} reason
 */

/**
 * @typedef {Object} ForensicsOptions
 * @property {ExtractedMarkdownResult} [extracted]
 * @property {string} [url]
 * @property {boolean} [forceFallback]
 */

/**
 * @typedef {Object} ExtractionForensicsResult
 * @property {number} rawHtmlBytes
 * @property {number} visibleProseBytes
 * @property {number} payloadToProseRatio
 * @property {number} nextFlightBytes
 * @property {number} nextDataBytes
 * @property {number} jsonLdBytes
 * @property {number} inlineScriptBytes
 * @property {number} inlineStyleBytes
 * @property {number} inlineJsCssBytes
 * @property {boolean} inlineJsCssHeavy
 * @property {LargeInlineBlob[]} largeNonJsonLdBlobs
 * @property {number} inlineSvgBytes
 * @property {number} base64ImageBytes
 * @property {number} domNodeEstimate
 * @property {'optimal'|'moderate'|'bloated'} domNodeStatus
 * @property {boolean} domNodesUnder600
 * @property {boolean} domNodesOver1200
 * @property {number} collapsedChars
 * @property {number} collapsedShare
 * @property {boolean} collapsedShareWarning
 * @property {number} dataNosnippetChars
 * @property {number} dataNosnippetShare
 * @property {boolean} dataNosnippetWarning
 * @property {JsonLdCrossCheckResult} jsonLdCrossCheck
 * @property {string|null} documentTitle
 * @property {number} embeddedSvgTitlesIgnored
 * @property {{ detected: boolean, reason: string|null, mainTextChars: number }} soft404
 * @property {MultiSectionDropResult} multiSectionDrop
 * @property {{ hasNoscript: boolean, hasJsWarning: boolean, rawMainTextChars: number, flagged: boolean }} noscriptAppShell
 * @property {{ markdownChars: number, warnThreshold: number, failThreshold: number, status: 'pass'|'warn'|'fail', exceeds50k: boolean, exceeds100k: boolean }} markdownTruncation
 * @property {number|null} contentStartPosition
 * @property {number|null} firstH1HtmlByteOffset
 * @property {{ bytes: number, exceeds30KB: boolean, exceeds100KB: boolean, exceeds300KB: boolean, exceeds2MB: boolean, tier: 'optimal'|'good'|'moderate'|'heavy'|'bloated'|'over_googlebot_2mb' }} rawHtmlCliffs
 */

/**
 * Decodes common named and numeric HTML entities.
 * @param {string} input
 * @returns {string}
 */
function decodeHtmlEntities(input) {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,12});/g, (full, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return full; }
      }
      return full;
    }
    const mapped = NAMED_ENTITIES[entity.toLowerCase()];
    return mapped !== undefined ? mapped : full;
  });
}

/**
 * Normalizes whitespace into single spaces and trims ends.
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without splitting
 * multi-byte UTF-8 sequences or leaving a torn trailing HTML tag fragment.
 * @param {string} html
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean, originalBytes: number }}
 */
function truncateUtf8Bytes(html, maxBytes) {
  const originalBytes = Buffer.byteLength(html, 'utf8');
  if (originalBytes <= maxBytes) {
    return { text: html, truncated: false, originalBytes };
  }
  const buf = Buffer.from(html, 'utf8');
  let end = maxBytes;
  // Back off from UTF-8 continuation bytes (0b10xxxxxx) so decoding never produces replacement chars.
  while (end > 0 && (buf[end] & 0b11000000) === 0b10000000) {
    end -= 1;
  }
  let sliced = buf.subarray(0, end).toString('utf8');
  // Trim an incomplete trailing tag if we cut inside `<...`
  const lastOpen = sliced.lastIndexOf('<');
  const lastClose = sliced.lastIndexOf('>');
  if (lastOpen > lastClose && sliced.length - lastOpen < 4096) {
    sliced = sliced.slice(0, lastOpen);
  }
  return { text: sliced, truncated: true, originalBytes };
}

/**
 * Finds the closing `>` of an HTML tag starting at `start` (`html[start] === '<'`),
 * respecting quoted attribute values.
 * @param {string} html
 * @param {number} start
 * @returns {number}
 */
function findTagEnd(html, start) {
  /** @type {string|null} */
  let quote = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Finds the closing tag `</tagName...>` for a raw-text element (`script` or `style`),
 * returning the start and end indices of the closing tag, or EOF if unclosed.
 * @param {string} html
 * @param {number} from
 * @param {string} tagName
 * @returns {{ closeStart: number, closeEnd: number }}
 */
function findRawTextClose(html, from, tagName) {
  const lower = html.toLowerCase();
  const needle = `</${tagName}`;
  let idx = from;
  while (idx < html.length) {
    const pos = lower.indexOf(needle, idx);
    if (pos === -1) return { closeStart: html.length, closeEnd: html.length };
    const after = pos + needle.length;
    const nextChar = lower[after];
    if (nextChar === '>' || nextChar === undefined || /\s|\//.test(nextChar)) {
      const end = html.indexOf('>', after);
      return { closeStart: pos, closeEnd: end === -1 ? html.length : end + 1 };
    }
    idx = after;
  }
  return { closeStart: html.length, closeEnd: html.length };
}

/**
 * Parses HTML tag attributes from the slice between `<tagName` and `>`.
 * @param {string} raw
 * @returns {Map<string, string>}
 */
function parseAttributes(raw) {
  /** @type {Map<string, string>} */
  const attrs = new Map();
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && /[\s/]/.test(raw[i])) i += 1;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(raw[i])) i += 1;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (!name) { i += 1; continue; }
    while (i < len && /\s/.test(raw[i])) i += 1;
    let value = '';
    if (raw[i] === '=') {
      i += 1;
      while (i < len && /\s/.test(raw[i])) i += 1;
      if (i < len && (raw[i] === '"' || raw[i] === "'")) {
        const q = raw[i];
        i += 1;
        const valStart = i;
        const valEnd = raw.indexOf(q, i);
        if (valEnd === -1) {
          value = raw.slice(valStart);
          i = len;
        } else {
          value = raw.slice(valStart, valEnd);
          i = valEnd + 1;
        }
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(raw[i])) i += 1;
        value = raw.slice(valStart, i);
      }
    }
    attrs.set(name, decodeHtmlEntities(value));
  }
  return attrs;
}

/**
 * Parses a tag token beginning at `pos` (`html[pos] === '<'`).
 * @param {string} html
 * @param {number} pos
 * @returns {{ kind: 'open'|'close'|'comment'|'decl', tagName: string, attrs: Map<string, string>, selfClosing: boolean, start: number, end: number } | null}
 */
function parseHtmlToken(html, pos) {
  if (html[pos] !== '<') return null;
  if (html.startsWith('<!--', pos)) {
    const close = html.indexOf('-->', pos + 4);
    const end = close === -1 ? html.length : close + 3;
    return { kind: 'comment', tagName: '', attrs: new Map(), selfClosing: true, start: pos, end };
  }
  if (html[pos + 1] === '!' || html[pos + 1] === '?') {
    const close = html.indexOf('>', pos + 2);
    const end = close === -1 ? html.length : close + 1;
    return { kind: 'decl', tagName: '', attrs: new Map(), selfClosing: true, start: pos, end };
  }
  const tagEnd = findTagEnd(html, pos);
  if (tagEnd === -1) return null;
  let inner = html.slice(pos + 1, tagEnd);
  if (inner.startsWith('/')) {
    const match = /^\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner);
    if (!match) return null;
    return {
      kind: 'close',
      tagName: match[1].toLowerCase(),
      attrs: new Map(),
      selfClosing: false,
      start: pos,
      end: tagEnd + 1,
    };
  }
  const match = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner);
  if (!match) return null;
  const tagName = match[1].toLowerCase();
  const selfClosing = inner.trimEnd().endsWith('/') || VOID_TAGS.has(tagName);
  const attrSlice = inner.slice(match[0].length).replace(/\/\s*$/, '');
  const attrs = attrSlice.trim() ? parseAttributes(attrSlice) : new Map();
  return {
    kind: 'open',
    tagName,
    attrs,
    selfClosing,
    start: pos,
    end: tagEnd + 1,
  };
}

/**
 * Determines whether an HTML opening tag matches one of the 20+ cookie-consent
 * or modal-dialog overlay selectors.
 * @param {string} tagName
 * @param {Map<string, string>} attrs
 * @returns {boolean}
 */
function isConsentOverlayTag(tagName, attrs) {
  if (PROTECTED_OVERLAY_TAGS.has(tagName)) return false;

  const id = (attrs.get('id') || '').trim().toLowerCase();
  if (id) {
    if (CONSENT_EXACT_IDS.has(id)) return true;
    for (const prefix of CONSENT_ID_PREFIXES) {
      if (id.startsWith(prefix)) return true;
    }
  }

  const classAttr = (attrs.get('class') || '').trim().toLowerCase();
  if (classAttr) {
    const tokens = classAttr.split(/\s+/);
    for (const token of tokens) {
      if (CONSENT_CLASS_TOKENS.has(token)) return true;
    }
  }

  const ariaModal = (attrs.get('aria-modal') || '').trim().toLowerCase();
  if (ariaModal === 'true') return true;

  const role = (attrs.get('role') || '').trim().toLowerCase();
  if (role === 'alertdialog') return true;

  const ariaLabel = attrs.get('aria-label') || '';
  if (ariaLabel && CONSENT_ARIA_LABEL_RE.test(ariaLabel)) return true;

  const testId = attrs.get('data-testid') || attrs.get('data-test-id') || '';
  if (testId && CONSENT_TESTID_RE.test(testId)) return true;

  if (role === 'dialog' && (
    /cookie|consent|gdpr|privacy/i.test(id)
    || /cookie|consent|gdpr|privacy/i.test(classAttr)
    || /cookie|consent|gdpr|privacy/i.test(ariaLabel)
  )) {
    return true;
  }

  return false;
}

/**
 * Strips SiteOne's 20+ cookie-consent and modal-dialog overlays from raw HTML
 * using a linear-time tag-depth scanner (zero ReDoS, handles nested elements).
 * @param {string} html
 * @returns {string}
 */
export function stripConsentOverlays(html) {
  if (!html || typeof html !== 'string') return '';
  /** @type {string[]} */
  const out = [];
  let cursor = 0;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const token = parseHtmlToken(html, lt);
    if (!token) {
      i = lt + 1;
      continue;
    }

    if (token.kind === 'comment' || token.kind === 'decl') {
      i = token.end;
      continue;
    }

    if (token.kind === 'open' && RAW_TEXT_TAGS.has(token.tagName)) {
      const { closeEnd } = findRawTextClose(html, token.end, token.tagName);
      i = closeEnd;
      continue;
    }

    if (token.kind === 'open' && isConsentOverlayTag(token.tagName, token.attrs)) {
      if (lt > cursor) out.push(html.slice(cursor, lt));
      if (token.selfClosing) {
        cursor = token.end;
        i = token.end;
        continue;
      }
      const skipTag = token.tagName;
      let depth = 1;
      let scan = token.end;
      while (scan < html.length && depth > 0) {
        const nextLt = html.indexOf('<', scan);
        if (nextLt === -1) {
          scan = html.length;
          break;
        }
        const inner = parseHtmlToken(html, nextLt);
        if (!inner) {
          scan = nextLt + 1;
          continue;
        }
        if (inner.kind === 'open' && RAW_TEXT_TAGS.has(inner.tagName)) {
          const { closeEnd } = findRawTextClose(html, inner.end, inner.tagName);
          scan = closeEnd;
          continue;
        }
        if (inner.kind === 'open' && inner.tagName === skipTag && !inner.selfClosing) {
          depth += 1;
        } else if (inner.kind === 'close' && inner.tagName === skipTag) {
          depth -= 1;
        }
        scan = inner.end;
      }
      cursor = scan;
      i = scan;
      continue;
    }

    i = token.end;
  }

  if (cursor < html.length) out.push(html.slice(cursor));
  return out.join('');
}

/**
 * Resolves a relative href against an optional base URL safely.
 * @param {string} href
 * @param {string|undefined} baseUrl
 * @returns {string}
 */
function resolveSafeHref(href, baseUrl) {
  const trimmed = href.trim();
  if (!trimmed || /^(?:javascript|data|vbscript):/i.test(trimmed)) return '';
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

/**
 * Strips specified tag subtrees linearly from HTML (for fallback extraction).
 * @param {string} html
 * @param {Set<string>} tagsToStrip
 * @returns {string}
 */
function stripSubtrees(html, tagsToStrip) {
  /** @type {string[]} */
  const out = [];
  let cursor = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const token = parseHtmlToken(html, lt);
    if (!token) { i = lt + 1; continue; }
    if (token.kind === 'comment') {
      if (lt > cursor) out.push(html.slice(cursor, lt));
      cursor = token.end;
      i = token.end;
      continue;
    }
    if (token.kind === 'open' && RAW_TEXT_TAGS.has(token.tagName)) {
      const { closeEnd } = findRawTextClose(html, token.end, token.tagName);
      if (tagsToStrip.has(token.tagName)) {
        if (lt > cursor) out.push(html.slice(cursor, lt));
        cursor = closeEnd;
      }
      i = closeEnd;
      continue;
    }
    if (token.kind === 'open' && tagsToStrip.has(token.tagName)) {
      if (lt > cursor) out.push(html.slice(cursor, lt));
      if (token.selfClosing) {
        cursor = token.end;
        i = token.end;
        continue;
      }
      const skipTag = token.tagName;
      let depth = 1;
      let scan = token.end;
      while (scan < html.length && depth > 0) {
        const nextLt = html.indexOf('<', scan);
        if (nextLt === -1) { scan = html.length; break; }
        const inner = parseHtmlToken(html, nextLt);
        if (!inner) { scan = nextLt + 1; continue; }
        if (inner.kind === 'open' && RAW_TEXT_TAGS.has(inner.tagName)) {
          scan = findRawTextClose(html, inner.end, inner.tagName).closeEnd;
          continue;
        }
        if (inner.kind === 'open' && inner.tagName === skipTag && !inner.selfClosing) depth += 1;
        else if (inner.kind === 'close' && inner.tagName === skipTag) depth -= 1;
        scan = inner.end;
      }
      cursor = scan;
      i = scan;
      continue;
    }
    i = token.end;
  }
  if (cursor < html.length) out.push(html.slice(cursor));
  return out.join('');
}

/**
 * Extracts the inner HTML of the first matching container tag (`main` or `article`),
 * or `body`, if present.
 * @param {string} html
 * @param {string} targetTag
 * @returns {string|null}
 */
function extractTagInnerHtml(html, targetTag) {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return null;
    const token = parseHtmlToken(html, lt);
    if (!token) { i = lt + 1; continue; }
    if (token.kind === 'open' && RAW_TEXT_TAGS.has(token.tagName)) {
      i = findRawTextClose(html, token.end, token.tagName).closeEnd;
      continue;
    }
    if (token.kind === 'open' && token.tagName === targetTag && !token.selfClosing) {
      let depth = 1;
      let scan = token.end;
      const contentStart = token.end;
      while (scan < html.length && depth > 0) {
        const nextLt = html.indexOf('<', scan);
        if (nextLt === -1) return html.slice(contentStart);
        const inner = parseHtmlToken(html, nextLt);
        if (!inner) { scan = nextLt + 1; continue; }
        if (inner.kind === 'open' && RAW_TEXT_TAGS.has(inner.tagName)) {
          scan = findRawTextClose(html, inner.end, inner.tagName).closeEnd;
          continue;
        }
        if (inner.kind === 'open' && inner.tagName === targetTag && !inner.selfClosing) depth += 1;
        else if (inner.kind === 'close' && inner.tagName === targetTag) {
          depth -= 1;
          if (depth === 0) return html.slice(contentStart, nextLt);
        }
        scan = inner.end;
      }
      return html.slice(contentStart);
    }
    i = token.end;
  }
  return null;
}

/**
 * Strips all HTML tags from a small inline snippet and decodes entities.
 * @param {string} snippet
 * @returns {string}
 */
function stripTagsInline(snippet) {
  return collapseWhitespace(decodeHtmlEntities(snippet.replace(/<[^>]+>/g, ' ')));
}

/**
 * Computes the minimal backtick fence length that safely wraps `code`.
 * @param {string} code
 * @returns {string}
 */
function backtickFenceFor(code) {
  let longest = 0;
  const matches = code.matchAll(/`+/g);
  for (const m of matches) {
    if (m[0].length > longest) longest = m[0].length;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Converts a single HTML `<table>...</table>` slice into a GFM Markdown table,
 * returning null if it looks like a presentation/layout table.
 * @param {string} tableHtml
 * @param {Map<string, string>} tableAttrs
 * @returns {string|null}
 */
function convertHtmlTableToMarkdown(tableHtml, tableAttrs) {
  const role = (tableAttrs.get('role') || '').trim().toLowerCase();
  if (role === 'presentation' || role === 'none') return null;
  // Nested tables indicate layout framing rather than a simple GFM data table.
  if (/<table\b/i.test(tableHtml)) return null;

  /** @type {string[][]} */
  const rows = [];
  const rowMatches = tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rowMatches) {
    /** @type {string[]} */
    const cells = [];
    const cellMatches = rowMatch[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi);
    for (const cellMatch of cellMatches) {
      const text = stripTagsInline(cellMatch[1]).replace(/\|/g, '\\|');
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount === 0) return null;

  const normalized = rows.map((r) => {
    const copy = r.slice();
    while (copy.length < colCount) copy.push('');
    return copy;
  });

  const header = `| ${normalized[0].join(' | ')} |`;
  const sep = `| ${normalized[0].map(() => '---').join(' | ')} |`;
  const body = normalized.slice(1).map((r) => `| ${r.join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

/**
 * Pure-Node fallback HTML-to-Markdown converter used when `webforai` is
 * unavailable (e.g. extracted archive without `node_modules`) or when
 * `forceFallback: true` is passed.
 * @param {string} html
 * @param {{ url?: string, includeAgentMode?: boolean }} options
 * @returns {{ markdown: string, agentMarkdown: string }}
 */
function fallbackHtmlToMarkdown(html, options) {
  const baseUrl = options.url;
  const cleanedFull = stripSubtrees(html, new Set(['script', 'style', 'template', 'svg', 'noscript', 'head']));

  // Collect navigation / page links for Agent mode before stripping landmarks.
  /** @type {Array<{ text: string, href: string }>} */
  const discoveredLinks = [];
  /** @type {Set<string>} */
  const seenHrefs = new Set();
  if (options.includeAgentMode !== false) {
    const linkMatches = cleanedFull.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
    for (const match of linkMatches) {
      const attrs = parseAttributes(match[1]);
      const href = resolveSafeHref(attrs.get('href') || '', baseUrl);
      const text = stripTagsInline(match[2]);
      if (!href || !text || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      discoveredLinks.push({ text, href });
      if (discoveredLinks.length >= 50) break;
    }
  }

  // Prefer <main>, then <article>, then <body> stripped of nav/header/footer/aside.
  const mainSlice = extractTagInnerHtml(cleanedFull, 'main');
  const articleSlice = mainSlice === null ? extractTagInnerHtml(cleanedFull, 'article') : null;
  const bodySlice = (mainSlice === null && articleSlice === null)
    ? (extractTagInnerHtml(cleanedFull, 'body') ?? cleanedFull)
    : null;
  const targetHtml = stripSubtrees(
    mainSlice ?? articleSlice ?? bodySlice ?? cleanedFull,
    CHROME_LANDMARK_TAGS,
  );

  // Convert HTML linearly into Markdown blocks.
  /** @type {string[]} */
  const out = [];
  /** @type {Array<{ tag: string, ordered?: boolean, index?: number, href?: string }>} */
  const stack = [];
  let i = 0;

  while (i < targetHtml.length) {
    const lt = targetHtml.indexOf('<', i);
    if (lt === -1) {
      const tail = decodeHtmlEntities(targetHtml.slice(i));
      if (tail.trim()) out.push(tail.replace(/\s+/g, ' '));
      break;
    }
    if (lt > i) {
      const text = decodeHtmlEntities(targetHtml.slice(i, lt));
      if (text.trim()) {
        out.push(text.replace(/\s+/g, ' '));
      } else if (text.includes(' ') && out.length > 0 && !/\s$/.test(out[out.length - 1])) {
        out.push(' ');
      }
    }

    const token = parseHtmlToken(targetHtml, lt);
    if (!token) { i = lt + 1; continue; }

    if (token.kind === 'comment' || token.kind === 'decl') {
      i = token.end;
      continue;
    }

    // Handle <pre> block directly to preserve whitespace and emit fenced code block.
    if (token.kind === 'open' && token.tagName === 'pre' && !token.selfClosing) {
      let depth = 1;
      let scan = token.end;
      let innerEnd = targetHtml.length;
      while (scan < targetHtml.length && depth > 0) {
        const nextLt = targetHtml.indexOf('<', scan);
        if (nextLt === -1) break;
        const inner = parseHtmlToken(targetHtml, nextLt);
        if (!inner) { scan = nextLt + 1; continue; }
        if (inner.kind === 'open' && inner.tagName === 'pre' && !inner.selfClosing) depth += 1;
        else if (inner.kind === 'close' && inner.tagName === 'pre') {
          depth -= 1;
          if (depth === 0) innerEnd = nextLt;
        }
        scan = inner.end;
      }
      const rawPre = targetHtml.slice(token.end, innerEnd);
      const langMatch = /<code\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:language|lang)-([a-z0-9_+-]+)/i.exec(rawPre);
      const lang = langMatch ? langMatch[1] : '';
      const codeText = decodeHtmlEntities(rawPre.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
      const fence = backtickFenceFor(codeText);
      out.push(`\n\n${fence}${lang}\n${codeText}\n${fence}\n\n`);
      i = scan;
      continue;
    }

    // Handle <table> block directly to emit GFM table when possible.
    if (token.kind === 'open' && token.tagName === 'table' && !token.selfClosing) {
      let depth = 1;
      let scan = token.end;
      let innerEnd = targetHtml.length;
      while (scan < targetHtml.length && depth > 0) {
        const nextLt = targetHtml.indexOf('<', scan);
        if (nextLt === -1) break;
        const inner = parseHtmlToken(targetHtml, nextLt);
        if (!inner) { scan = nextLt + 1; continue; }
        if (inner.kind === 'open' && inner.tagName === 'table' && !inner.selfClosing) depth += 1;
        else if (inner.kind === 'close' && inner.tagName === 'table') {
          depth -= 1;
          if (depth === 0) innerEnd = nextLt;
        }
        scan = inner.end;
      }
      const tableInner = targetHtml.slice(token.end, innerEnd);
      const mdTable = convertHtmlTableToMarkdown(tableInner, token.attrs);
      if (mdTable) {
        out.push(`\n\n${mdTable}\n\n`);
        i = scan;
        continue;
      }
      // Layout table: continue scanning inside so inner text is flattened.
      i = token.end;
      continue;
    }

    if (token.kind === 'open') {
      const t = token.tagName;
      if (HEADING_TAGS.has(t)) {
        const level = Number(t[1]);
        out.push(`\n\n${'#'.repeat(level)} `);
        stack.push({ tag: t });
      } else if (t === 'p' || t === 'div' || t === 'section' || t === 'article') {
        out.push('\n\n');
      } else if (t === 'br') {
        out.push('\n');
      } else if (t === 'hr') {
        out.push('\n\n---\n\n');
      } else if (t === 'ul') {
        out.push('\n\n');
        stack.push({ tag: 'ul', ordered: false, index: 0 });
      } else if (t === 'ol') {
        out.push('\n\n');
        stack.push({ tag: 'ol', ordered: true, index: 0 });
      } else if (t === 'li') {
        const listFrame = [...stack].reverse().find((f) => f.tag === 'ul' || f.tag === 'ol');
        if (listFrame && listFrame.ordered) {
          listFrame.index = (listFrame.index ?? 0) + 1;
          out.push(`\n${listFrame.index}. `);
        } else {
          out.push('\n- ');
        }
      } else if (t === 'blockquote') {
        out.push('\n\n> ');
      } else if (t === 'strong' || t === 'b') {
        out.push('**');
        stack.push({ tag: t });
      } else if (t === 'em' || t === 'i') {
        out.push('*');
        stack.push({ tag: t });
      } else if (t === 'code') {
        out.push('`');
        stack.push({ tag: 'code' });
      } else if (t === 'a' && !token.selfClosing) {
        const href = resolveSafeHref(token.attrs.get('href') || '', baseUrl);
        if (href) {
          out.push('[');
          stack.push({ tag: 'a', href });
        }
      }
    } else if (token.kind === 'close') {
      const t = token.tagName;
      if (HEADING_TAGS.has(t)) {
        out.push('\n\n');
        if (stack.length > 0 && stack[stack.length - 1].tag === t) stack.pop();
      } else if (t === 'p' || t === 'div' || t === 'section' || t === 'article' || t === 'blockquote') {
        out.push('\n\n');
      } else if (t === 'ul' || t === 'ol') {
        out.push('\n\n');
        if (stack.length > 0 && stack[stack.length - 1].tag === t) stack.pop();
      } else if (t === 'strong' || t === 'b') {
        out.push('**');
        if (stack.length > 0 && stack[stack.length - 1].tag === t) stack.pop();
      } else if (t === 'em' || t === 'i') {
        out.push('*');
        if (stack.length > 0 && stack[stack.length - 1].tag === t) stack.pop();
      } else if (t === 'code') {
        out.push('`');
        if (stack.length > 0 && stack[stack.length - 1].tag === 'code') stack.pop();
      } else if (t === 'a') {
        const idx = stack.map((f) => f.tag).lastIndexOf('a');
        if (idx !== -1) {
          const frame = stack.splice(idx, 1)[0];
          out.push(`](${frame.href})`);
        }
      }
    }

    i = token.end;
  }

  const markdown = out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let agentMarkdown = markdown;
  if (options.includeAgentMode !== false && discoveredLinks.length > 0) {
    const linksBlock = discoveredLinks.map((l) => `- [${l.text}](${l.href})`).join('\n');
    agentMarkdown = markdown ? `${markdown}\n\n## Links\n\n${linksBlock}` : `## Links\n\n${linksBlock}`;
  }

  return { markdown, agentMarkdown };
}

/**
 * Strips inline Markdown syntax from a heading or prose line for clean matching.
 * @param {string} line
 * @returns {string}
 */
function stripInlineMarkdown(line) {
  return collapseWhitespace(
    line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1'),
  );
}

/**
 * Parses structural metrics (headings, tables, fenced code blocks, paragraphs,
 * sections, words, tokens) from a Markdown string while respecting code fences.
 * @param {string} markdown
 * @returns {{
 *   headings: ExtractedHeading[],
 *   paragraphs: string[],
 *   tablesCount: number,
 *   codeBlocksCount: number,
 *   sectionsCount: number,
 *   wordCount: number,
 *   charCount: number,
 *   estimatedTokens: number
 * }}
 */
function parseMarkdownStructure(markdown) {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return {
      headings: [],
      paragraphs: [],
      tablesCount: 0,
      codeBlocksCount: 0,
      sectionsCount: 0,
      wordCount: 0,
      charCount: 0,
      estimatedTokens: 0,
    };
  }

  const lines = trimmed.split(/\r?\n/);
  /** @type {ExtractedHeading[]} */
  const headings = [];
  /** @type {string[]} */
  const paragraphs = [];
  /** @type {string[]} */
  let currentPara = [];
  let tablesCount = 0;
  let codeBlocksCount = 0;
  let hasPreHeadingProse = false;

  /** @type {string|null} */
  let fenceChar = null;
  let fenceLen = 0;

  const flushPara = () => {
    if (currentPara.length === 0) return;
    const text = stripInlineMarkdown(currentPara.join(' '));
    if (text) {
      paragraphs.push(text);
      if (headings.length === 0) hasPreHeadingProse = true;
    }
    currentPara = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Check fenced code block open/close
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceChar !== null) {
      if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen && fenceMatch[2].trim() === '') {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (fenceMatch) {
      flushPara();
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      codeBlocksCount += 1;
      continue;
    }

    // Blank line ends paragraph
    if (!line.trim()) {
      flushPara();
      continue;
    }

    // ATX heading (# .. ######)
    const atxMatch = /^\s*(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (atxMatch) {
      flushPara();
      const text = stripInlineMarkdown(atxMatch[2]);
      if (text) headings.push({ level: atxMatch[1].length, text });
      continue;
    }

    // Setext heading (underlined by === or ---)
    if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && !line.trim().startsWith('|') && !/^\s*[-*+]\s/.test(line)) {
      flushPara();
      const text = stripInlineMarkdown(line);
      if (text) {
        headings.push({ level: lines[i + 1].trim().startsWith('=') ? 1 : 2, text });
      }
      i += 1;
      continue;
    }

    // GFM table detection: header line with `|` followed by delimiter line
    if (
      line.includes('|')
      && i + 1 < lines.length
      && /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      flushPara();
      tablesCount += 1;
      i += 1; // skip delimiter
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim() !== '') {
        i += 1;
      }
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara();
      continue;
    }

    // List item or blockquote line (not merged as prose paragraph unless substantial)
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      continue;
    }

    currentPara.push(line.replace(/^\s*>\s?/, ''));
  }
  flushPara();

  // Compute word count cleanly from markdown text (excluding link URLs and fence markers)
  const wordSource = trimmed
    .replace(/^`{3,}[^\n]*$/gm, ' ')
    .replace(/^~{3,}[^\n]*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, ' $1 ')
    .replace(/[#*_~>`|]/g, ' ');
  const words = wordSource.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  const wordCount = words ? words.length : 0;
  const charCount = trimmed.length;
  const estimatedTokens = charCount === 0 ? 0 : Math.ceil(charCount / 4);
  const sectionsCount = headings.length > 0
    ? headings.length + (hasPreHeadingProse ? 1 : 0)
    : (wordCount > 0 ? 1 : 0);

  return {
    headings,
    paragraphs,
    tablesCount,
    codeBlocksCount,
    sectionsCount,
    wordCount,
    charCount,
    estimatedTokens,
  };
}

/**
 * Extracts Reader-mode and Agent-mode Markdown from HTML using `webforai`
 * (with graceful built-in pure-Node fallback when `node_modules` is absent).
 * Enforces a strict 2 MiB UTF-8 input cap to prevent parser stalls.
 *
 * @param {string} html
 * @param {ExtractMarkdownOptions} [options]
 * @returns {ExtractedMarkdownResult}
 */
export function extractBotMarkdown(html, options = {}) {
  const rawHtml = typeof html === 'string' ? html : '';
  const maxBytes = typeof options.maxBytes === 'number' && options.maxBytes > 0
    ? options.maxBytes
    : MAX_EXTRACTION_BYTES;
  const { text: cappedHtml, truncated: truncatedAt2MiB } = truncateUtf8Bytes(rawHtml, maxBytes);
  const preparedHtml = options.stripConsent === false
    ? cappedHtml
    : stripConsentOverlays(cappedHtml);

  const includeAgentMode = options.includeAgentMode !== false;
  const includeTitle = options.includeTitle === true;
  const useWebforai = !options.forceFallback && webforaiMod !== null;

  /** @type {'webforai'|'fallback'} */
  let engine = 'fallback';
  let markdown = '';
  let agentMarkdown = '';

  if (useWebforai && webforaiMod !== null) {
    try {
      const baseOpts = {
        url: options.url,
        baseUrl: options.url,
        title: includeTitle,
      };
      markdown = webforaiMod.htmlToMarkdown(preparedHtml, baseOpts).trim();
      if (includeAgentMode) {
        agentMarkdown = webforaiMod.htmlToMarkdown(preparedHtml, {
          ...baseOpts,
          extractors: webforaiMod.presetExtractors('agent'),
        }).trim();
      } else {
        agentMarkdown = markdown;
      }
      engine = 'webforai';
    } catch {
      const fallback = fallbackHtmlToMarkdown(preparedHtml, {
        url: options.url,
        includeAgentMode,
      });
      markdown = fallback.markdown;
      agentMarkdown = fallback.agentMarkdown;
      engine = 'fallback';
    }
  } else {
    const fallback = fallbackHtmlToMarkdown(preparedHtml, {
      url: options.url,
      includeAgentMode,
    });
    markdown = fallback.markdown;
    agentMarkdown = fallback.agentMarkdown;
    engine = 'fallback';
  }

  const structure = parseMarkdownStructure(markdown);

  return {
    engine,
    markdown,
    agentMarkdown,
    wordCount: structure.wordCount,
    charCount: structure.charCount,
    estimatedTokens: structure.estimatedTokens,
    headings: structure.headings,
    tablesCount: structure.tablesCount,
    codeBlocksCount: structure.codeBlocksCount,
    sectionsCount: structure.sectionsCount,
    truncatedAt2MiB,
  };
}

/**
 * Pure-Node LCS line-diff fallback returning `diffLines`-compatible parts.
 * Bounded in memory so very large inputs remain fast and safe.
 * @param {string} oldText
 * @param {string} newText
 * @returns {DiffLinePart[]}
 */
function fallbackDiffLines(oldText, newText) {
  if (oldText === newText) {
    return oldText ? [{ value: oldText, count: oldText.split('\n').length }] : [];
  }
  const splitKeepNewline = (/** @type {string} */ text) => {
    if (!text) return [];
    const raw = text.split('\n');
    /** @type {string[]} */
    const lines = [];
    for (let i = 0; i < raw.length; i += 1) {
      if (i < raw.length - 1) lines.push(`${raw[i]}\n`);
      else if (raw[i] !== '') lines.push(raw[i]);
    }
    return lines;
  };

  const a = splitKeepNewline(oldText);
  const b = splitKeepNewline(newText);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  /** @type {DiffLinePart[]} */
  const parts = [];
  if (prefix > 0) {
    parts.push({ value: a.slice(0, prefix).join(''), count: prefix });
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const m = midA.length;
  const n = midB.length;

  if (m === 0 && n > 0) {
    parts.push({ value: midB.join(''), added: true, count: n });
  } else if (n === 0 && m > 0) {
    parts.push({ value: midA.join(''), removed: true, count: m });
  } else if (m > 0 && n > 0) {
    if (m * n <= 1_000_000) {
      // Classic O(m*n) LCS DP table stored flat in Int32Array.
      const cols = n + 1;
      const dp = new Int32Array((m + 1) * cols);
      for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
          if (midA[i] === midB[j]) {
            dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
          } else {
            const down = dp[(i + 1) * cols + j];
            const right = dp[i * cols + (j + 1)];
            dp[i * cols + j] = down >= right ? down : right;
          }
        }
      }
      /** @type {Array<{ kind: 'eq'|'add'|'rem', line: string }>} */
      const ops = [];
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        if (midA[i] === midB[j]) {
          ops.push({ kind: 'eq', line: midA[i] });
          i += 1;
          j += 1;
        } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
          ops.push({ kind: 'rem', line: midA[i] });
          i += 1;
        } else {
          ops.push({ kind: 'add', line: midB[j] });
          j += 1;
        }
      }
      while (i < m) { ops.push({ kind: 'rem', line: midA[i] }); i += 1; }
      while (j < n) { ops.push({ kind: 'add', line: midB[j] }); j += 1; }

      for (const op of ops) {
        const prev = parts[parts.length - 1];
        const prevKind = prev ? (prev.added ? 'add' : prev.removed ? 'rem' : 'eq') : null;
        if (prev && prevKind === op.kind) {
          prev.value += op.line;
          prev.count = (prev.count ?? 0) + 1;
        } else {
          parts.push({
            value: op.line,
            ...(op.kind === 'add' ? { added: true } : op.kind === 'rem' ? { removed: true } : {}),
            count: 1,
          });
        }
      }
    } else {
      // Bounded fallback for massive diffs (>1M cell matrix)
      parts.push({ value: midA.join(''), removed: true, count: m });
      parts.push({ value: midB.join(''), added: true, count: n });
    }
  }

  if (suffix > 0) {
    parts.push({ value: a.slice(a.length - suffix).join(''), count: suffix });
  }

  return parts;
}

/**
 * Converts diff parts into unified structured hunks with surrounding context lines.
 * @param {DiffLinePart[]} parts
 * @param {number} [contextLines]
 * @returns {{ hunks: DiffHunk[], addedLines: number, removedLines: number, unchangedLines: number }}
 */
function buildStructuredHunks(parts, contextLines = 3) {
  /** @type {Array<{ type: 'context'|'add'|'remove', line: string, oldNo: number|null, newNo: number|null }>} */
  const flat = [];
  let oldLine = 1;
  let newLine = 1;
  let addedLines = 0;
  let removedLines = 0;
  let unchangedLines = 0;

  for (const part of parts) {
    const rawLines = part.value.split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    for (const line of rawLines) {
      if (part.added) {
        flat.push({ type: 'add', line, oldNo: null, newNo: newLine });
        newLine += 1;
        addedLines += 1;
      } else if (part.removed) {
        flat.push({ type: 'remove', line, oldNo: oldLine, newNo: null });
        oldLine += 1;
        removedLines += 1;
      } else {
        flat.push({ type: 'context', line, oldNo: oldLine, newNo: newLine });
        oldLine += 1;
        newLine += 1;
        unchangedLines += 1;
      }
    }
  }

  /** @type {number[]} */
  const changeIndices = [];
  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i].type !== 'context') changeIndices.push(i);
  }
  if (changeIndices.length === 0) {
    return { hunks: [], addedLines, removedLines, unchangedLines };
  }

  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(flat.length - 1, idx + contextLines);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  /** @type {DiffHunk[]} */
  const hunks = ranges.map(([start, end]) => {
    const slice = flat.slice(start, end + 1);
    const firstOld = slice.find((entry) => entry.oldNo !== null)?.oldNo ?? 1;
    const firstNew = slice.find((entry) => entry.newNo !== null)?.newNo ?? 1;
    const oldLinesCount = slice.filter((entry) => entry.type !== 'add').length;
    const newLinesCount = slice.filter((entry) => entry.type !== 'remove').length;
    return {
      oldStart: firstOld,
      oldLines: oldLinesCount,
      newStart: firstNew,
      newLines: newLinesCount,
      lines: slice.map((entry) => ({ type: entry.type, line: entry.line })),
    };
  });

  return { hunks, addedLines, removedLines, unchangedLines };
}

/**
 * Normalizes a case-insensitive header lookup across Fetch `Headers` or plain objects.
 * @param {Headers|Record<string, string|string[]|undefined>|null|undefined} headers
 * @param {string} name
 * @returns {string|null}
 */
function readHeaderValue(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(target);
  }
  if (typeof (/** @type {{ get?: unknown }} */ (headers)).get === 'function') {
    const val = /** @type {{ get: (k: string) => string|null }} */ (headers).get(target);
    return val ?? null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && v !== undefined) {
      return Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return null;
}

/**
 * Normalizes text for heading/paragraph set comparison.
 * @param {string} text
 * @returns {string}
 */
function normalizeCompareKey(text) {
  return collapseWhitespace(text).toLowerCase();
}

/**
 * Compares what non-JS AI bots see (`botHtml`), what humans see (`humanHtml`),
 * and optional edge-negotiated Markdown (`edgeMarkdown` from `Accept: text/markdown`).
 *
 * @param {DiffBotVsHumanInput} input
 * @returns {DiffBotVsHumanResult}
 */
export function diffBotVsHuman({
  botHtml,
  humanHtml = null,
  edgeMarkdown = null,
  edgeHeaders = null,
  url,
  forceFallback = false,
}) {
  const bot = extractBotMarkdown(botHtml, { url, forceFallback });
  const human = typeof humanHtml === 'string'
    ? extractBotMarkdown(humanHtml, { url, forceFallback })
    : null;

  const useDiffPkg = !forceFallback && diffMod !== null;
  /** @type {'diff'|'fallback'} */
  const diffEngine = useDiffPkg ? 'diff' : 'fallback';

  /** @param {string} a @param {string} b @returns {DiffLinePart[]} */
  const runLineDiff = (a, b) => (
    useDiffPkg && diffMod !== null
      ? diffMod.diffLines(a, b)
      : fallbackDiffLines(a, b)
  );

  // Edge Markdown analysis & header checks
  const contentType = readHeaderValue(edgeHeaders, 'content-type') || '';
  const varyHeader = readHeaderValue(edgeHeaders, 'vary') || '';
  const rawTokensHeader = readHeaderValue(edgeHeaders, 'x-markdown-tokens');
  const parsedXTokens = rawTokensHeader !== null && /^\d+$/.test(rawTokensHeader.trim())
    ? Number.parseInt(rawTokensHeader.trim(), 10)
    : null;

  const isEdgeMarkdownContentType = /^text\/markdown\b/i.test(contentType.trim());
  const varyTokens = varyHeader
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const missingVaryAccept = isEdgeMarkdownContentType
    && !varyTokens.includes('accept')
    && !varyTokens.includes('*');

  /** @type {EdgeMarkdownSummary|null} */
  let edge = null;
  if (typeof edgeMarkdown === 'string') {
    const edgeStruct = parseMarkdownStructure(edgeMarkdown);
    edge = {
      markdown: edgeMarkdown.trim(),
      wordCount: edgeStruct.wordCount,
      charCount: edgeStruct.charCount,
      estimatedTokens: edgeStruct.estimatedTokens,
      headings: edgeStruct.headings,
      tablesCount: edgeStruct.tablesCount,
      codeBlocksCount: edgeStruct.codeBlocksCount,
      sectionsCount: edgeStruct.sectionsCount,
      xMarkdownTokens: parsedXTokens,
    };
  }

  /** @type {DiffHunk[]} */
  let hunks = [];
  /** @type {DiffHunk[]} */
  let edgeHunks = [];
  let diffSummary = { addedLines: 0, removedLines: 0, unchangedLines: 0 };
  /** @type {ExtractedHeading[]} */
  let missingHeadings = [];
  /** @type {string[]} */
  let droppedParagraphs = [];
  let lostTables = 0;
  let lostCodeBlocks = 0;
  /** @type {number|null} */
  let proseParityRatio = null;
  /** @type {number|null} */
  let edgeParityRatio = null;
  let edgeMarkdownCsrTrap = false;

  if (human !== null) {
    const parts = runLineDiff(bot.markdown, human.markdown);
    const built = buildStructuredHunks(parts, 3);
    hunks = built.hunks;
    diffSummary = {
      addedLines: built.addedLines,
      removedLines: built.removedLines,
      unchangedLines: built.unchangedLines,
    };

    const botHeadingKeys = new Set(bot.headings.map((h) => normalizeCompareKey(h.text)));
    missingHeadings = human.headings.filter((h) => !botHeadingKeys.has(normalizeCompareKey(h.text)));

    const botStruct = parseMarkdownStructure(bot.markdown);
    const humanStruct = parseMarkdownStructure(human.markdown);
    const botNormalizedFull = normalizeCompareKey(bot.markdown);
    const botParaSet = new Set(botStruct.paragraphs.map((p) => normalizeCompareKey(p)));

    droppedParagraphs = humanStruct.paragraphs.filter((p) => {
      if (p.length < 20) return false;
      const key = normalizeCompareKey(p);
      if (botParaSet.has(key)) return false;
      // Avoid false positives when paragraph was merged slightly differently
      if (botNormalizedFull.includes(key)) return false;
      return true;
    });

    lostTables = Math.max(0, human.tablesCount - bot.tablesCount);
    lostCodeBlocks = Math.max(0, human.codeBlocksCount - bot.codeBlocksCount);

    if (human.charCount === 0) {
      proseParityRatio = 1;
    } else {
      proseParityRatio = Number((bot.charCount / human.charCount).toFixed(4));
    }

    if (edge !== null) {
      const edgeParts = runLineDiff(edge.markdown, human.markdown);
      edgeHunks = buildStructuredHunks(edgeParts, 3).hunks;
      if (human.charCount > 0) {
        edgeParityRatio = Number((edge.charCount / human.charCount).toFixed(4));
        edgeMarkdownCsrTrap = edge.charCount < human.charCount * 0.5;
      } else {
        edgeParityRatio = 1;
      }
    }
  } else if (edge !== null && bot.charCount > 0) {
    const edgeParts = runLineDiff(edge.markdown, bot.markdown);
    edgeHunks = buildStructuredHunks(edgeParts, 3).hunks;
    edgeParityRatio = Number((edge.charCount / bot.charCount).toFixed(4));
  }

  return {
    engine: bot.engine,
    diffEngine,
    bot,
    human,
    edge,
    hunks,
    edgeHunks,
    diffSummary,
    missingHeadings,
    droppedParagraphs,
    lostTables,
    lostCodeBlocks,
    proseParityRatio,
    edgeParityRatio,
    edgeMarkdownCsrTrap,
    missingVaryAccept,
  };
}

/**
 * Extracts target property values from parsed JSON-LD nodes (up to `maxValues`)
 * for visible-text cross-checking (siteone-crawler `jsonld.rs` pattern).
 * @param {unknown} node
 * @param {JsonLdCheckItem[]} items
 * @param {Set<string>} seen
 * @param {number} maxValues
 * @param {{ truncated: boolean }} state
 */
function collectJsonLdCheckValues(node, items, seen, maxValues, state) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectJsonLdCheckValues(entry, items, seen, maxValues, state);
    }
    return;
  }
  if (typeof node !== 'object') return;

  /** @param {string} field @param {string} rawVal */
  const pushVal = (field, rawVal) => {
    const cleaned = collapseWhitespace(rawVal);
    if (!cleaned) return;
    if (cleaned.length < 2 && field !== 'price') return;
    const key = `${field}:${cleaned.toLowerCase()}`;
    if (seen.has(key)) return;
    if (items.length >= maxValues) {
      state.truncated = true;
      return;
    }
    seen.add(key);
    items.push({ field, value: cleaned });
  };

  const record = /** @type {Record<string, unknown>} */ (node);
  for (const [key, val] of Object.entries(record)) {
    if (val === null || val === undefined) continue;
    if (key === 'name' || key === 'headline' || key === 'sku' || key === 'telephone') {
      if (typeof val === 'string' || typeof val === 'number') {
        pushVal(key, String(val));
      } else if (Array.isArray(val)) {
        for (const v of val) {
          if (typeof v === 'string' || typeof v === 'number') pushVal(key, String(v));
        }
      }
    } else if (key === 'price') {
      if (typeof val === 'string' || typeof val === 'number') {
        pushVal('price', String(val));
      }
    } else if (key === 'author') {
      if (typeof val === 'string') {
        pushVal('author', val);
      } else if (Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === 'string') pushVal('author', entry);
          else if (entry && typeof entry === 'object') {
            const name = /** @type {Record<string, unknown>} */ (entry).name;
            if (typeof name === 'string') pushVal('author', name);
          }
        }
      } else if (typeof val === 'object') {
        const name = /** @type {Record<string, unknown>} */ (val).name;
        if (typeof name === 'string') pushVal('author', name);
      }
    } else if (key === 'address') {
      if (typeof val === 'string') {
        pushVal('address', val);
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        const addr = /** @type {Record<string, unknown>} */ (val);
        for (const addrKey of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']) {
          const part = addr[addrKey];
          if (typeof part === 'string' || typeof part === 'number') {
            pushVal('address', String(part));
          }
        }
      }
    } else if (typeof val === 'object') {
      collectJsonLdCheckValues(val, items, seen, maxValues, state);
    }
  }
}

/**
 * Checks whether a JSON-LD value appears in visible page text, handling minor
 * numeric formatting differences for `price` and `telephone`.
 * @param {JsonLdCheckItem} item
 * @param {string} visibleLower
 * @param {string} visibleDigits
 * @returns {boolean}
 */
function jsonLdValueVisible(item, visibleLower, visibleDigits) {
  const target = item.value.toLowerCase();
  if (visibleLower.includes(target)) return true;

  if (item.field === 'price') {
    const strippedZero = target.replace(/\.00$/, '');
    if (strippedZero && visibleLower.includes(strippedZero)) return true;
    const num = Number(target.replace(/,/g, ''));
    if (Number.isFinite(num)) {
      const formatted = num.toLocaleString('en-US');
      if (visibleLower.includes(formatted.toLowerCase())) return true;
    }
  }

  if (item.field === 'telephone') {
    const digits = target.replace(/\D/g, '');
    if (digits.length >= 7) {
      if (visibleDigits.includes(digits)) return true;
      // Also match local 10-digit suffix when country code differs
      if (digits.length > 10 && visibleDigits.includes(digits.slice(-10))) return true;
    }
  }

  return false;
}

/**
 * Classifies uncompressed raw HTML weight into aeocontent.ai / Googlebot tiers.
 * @param {number} bytes
 * @returns {'optimal'|'good'|'moderate'|'heavy'|'bloated'|'over_googlebot_2mb'}
 */
function classifyHtmlWeightTier(bytes) {
  if (bytes > MB_2) return 'over_googlebot_2mb';
  if (bytes > KB_800) return 'bloated';
  if (bytes > KB_500) return 'heavy';
  if (bytes > KB_250) return 'moderate';
  if (bytes > KB_100) return 'good';
  return 'optimal';
}

/**
 * Runs all 10 extraction forensic signals on raw HTML in a single linear pass
 * plus extracted Markdown comparison.
 *
 * @param {string} html
 * @param {number} [byteLength]
 * @param {ForensicsOptions} [options]
 * @returns {ExtractionForensicsResult}
 */
export function analyzeExtractionForensics(html, byteLength, options = {}) {
  const rawHtml = typeof html === 'string' ? html : '';
  const rawHtmlBytes = typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength >= 0
    ? byteLength
    : Buffer.byteLength(rawHtml, 'utf8');

  let nextFlightBytes = 0;
  let nextDataBytes = 0;
  let jsonLdBytes = 0;
  let inlineScriptBytes = 0;
  let inlineStyleBytes = 0;
  let inlineSvgBytes = 0;
  let domNodeEstimate = 0;

  /** @type {LargeInlineBlob[]} */
  const largeNonJsonLdBlobs = [];
  /** @type {string[]} */
  const jsonLdBlocks = [];

  /** @type {string|null} */
  let documentTitle = null;
  let embeddedSvgTitlesIgnored = 0;

  let hasNoscript = false;
  /** @type {string[]} */
  const noscriptParts = [];

  /** @type {string[]} */
  const visibleProseParts = [];
  /** @type {string[]} */
  const collapsedParts = [];
  /** @type {string[]} */
  const dataNosnippetParts = [];

  /** @type {number|null} */
  let firstH1HtmlByteOffset = null;
  /** @type {number|null} */
  let contentStartPosition = null;
  let visibleCharsSoFar = 0;

  // Body structure counters for WCXB Multi-Section / SaaS Drop Warning
  let bodySectionsCount = 0;
  /** @type {string[]} */
  const bodyHeadings = [];
  let bodyTablesCount = 0;

  // Context stack tracking nested states linearly
  /** @type {Array<{
   *   tag: string,
   *   isSvg: boolean,
   *   isEmbeddedTitleContainer: boolean,
   *   isTemplate: boolean,
   *   isNoscript: boolean,
   *   isHead: boolean,
   *   isBody: boolean,
   *   isCollapsed: boolean,
   *   isDetailsClosed: boolean,
   *   isSummary: boolean,
   *   isNosnippet: boolean,
   *   isConsent: boolean,
   *   isChrome: boolean,
   *   isTitle: boolean,
   *   isBodyHeading: boolean,
   *   headingBuf?: string[],
   *   titleBuf?: string[],
   *   svgStart?: number
   * }>} */
  const stack = [];

  /** @type {Array<{
   *   isPresentation: boolean,
   *   hasNestedTable: boolean,
   *   rows: number,
   *   maxCols: number,
   *   currentRowCols: number
   * }>} */
  const tableStack = [];

  let svgDepth = 0;
  let embeddedTitleDepth = 0;
  let templateDepth = 0;
  let noscriptDepth = 0;
  let headDepth = 0;
  let bodyDepth = 0;
  let collapsedDepth = 0;
  let closedDetailsDepth = 0;
  let summaryDepth = 0;
  let nosnippetDepth = 0;
  let consentDepth = 0;
  let chromeDepth = 0;
  let seenBodyTag = false;

  /** @param {string} rawText */
  const processTextNode = (rawText) => {
    const decoded = decodeHtmlEntities(rawText);
    const trimmed = collapseWhitespace(decoded);

    // Collect <title> buffer if inside a title tag
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const frame = stack[k];
      if (frame.isTitle && frame.titleBuf) {
        frame.titleBuf.push(decoded);
        break;
      }
    }

    // Collect <noscript> text
    if (noscriptDepth > 0 && trimmed) {
      noscriptParts.push(trimmed);
    }

    // Collect body heading text
    if (trimmed) {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        const frame = stack[k];
        if (frame.isBodyHeading && frame.headingBuf) {
          frame.headingBuf.push(trimmed);
          break;
        }
      }
    }

    // Ignore non-body/non-rendered text for prose, collapsed, and nosnippet accounting
    if (!trimmed) return;
    if (headDepth > 0 || svgDepth > 0 || templateDepth > 0 || noscriptDepth > 0) return;

    const inCollapsed = collapsedDepth > 0 || (closedDetailsDepth > 0 && summaryDepth === 0);
    if (nosnippetDepth > 0) {
      dataNosnippetParts.push(trimmed);
    }
    if (inCollapsed) {
      collapsedParts.push(trimmed);
    } else if (consentDepth === 0) {
      visibleProseParts.push(trimmed);
      if (firstH1HtmlByteOffset === null) {
        visibleCharsSoFar += trimmed.length + (visibleCharsSoFar > 0 ? 1 : 0);
      }
    }
  };

  let i = 0;
  while (i < rawHtml.length) {
    const lt = rawHtml.indexOf('<', i);
    if (lt === -1) {
      if (i < rawHtml.length) processTextNode(rawHtml.slice(i));
      break;
    }
    if (lt > i) {
      processTextNode(rawHtml.slice(i, lt));
    }

    const token = parseHtmlToken(rawHtml, lt);
    if (!token) {
      i = lt + 1;
      continue;
    }

    if (token.kind === 'comment' || token.kind === 'decl') {
      i = token.end;
      continue;
    }

    if (token.kind === 'open') {
      const t = token.tagName;
      domNodeEstimate += 1;

      // Raw-text elements: <script> and <style>
      if (RAW_TEXT_TAGS.has(t)) {
        const { closeStart, closeEnd } = findRawTextClose(rawHtml, token.end, t);
        const innerContent = rawHtml.slice(token.end, closeStart);
        const contentBytes = Buffer.byteLength(innerContent, 'utf8');
        const fullElemBytes = Buffer.byteLength(rawHtml.slice(token.start, closeEnd), 'utf8');

        if (t === 'script') {
          const type = (token.attrs.get('type') || '').trim().toLowerCase();
          const id = (token.attrs.get('id') || '').trim() || null;
          const isJsonLd = type === 'application/ld+json';
          const isNextData = id === '__NEXT_DATA__';
          const isNextFlight = innerContent.includes('self.__next_f.push');

          if (isJsonLd) {
            jsonLdBytes += fullElemBytes;
            if (innerContent.trim()) jsonLdBlocks.push(innerContent.trim());
          } else if (contentBytes > 0) {
            inlineScriptBytes += contentBytes;
            if (isNextFlight) nextFlightBytes += contentBytes;
            if (isNextData) nextDataBytes += contentBytes;
            if (contentBytes >= KB_25) {
              largeNonJsonLdBlobs.push({
                kind: 'script',
                id,
                bytes: contentBytes,
                isNextFlight,
                isNextData,
              });
            }
          }
        } else if (t === 'style') {
          if (contentBytes > 0) {
            inlineStyleBytes += contentBytes;
            if (contentBytes >= KB_25) {
              largeNonJsonLdBlobs.push({
                kind: 'style',
                id: (token.attrs.get('id') || '').trim() || null,
                bytes: contentBytes,
                isNextFlight: false,
                isNextData: false,
              });
            }
          }
        }

        i = closeEnd;
        continue;
      }

      // Track first <h1> position outside head/svg/template/noscript/hidden/consent
      if (
        t === 'h1'
        && firstH1HtmlByteOffset === null
        && headDepth === 0
        && svgDepth === 0
        && templateDepth === 0
        && noscriptDepth === 0
        && collapsedDepth === 0
        && consentDepth === 0
      ) {
        firstH1HtmlByteOffset = Buffer.byteLength(rawHtml.slice(0, token.start), 'utf8');
        contentStartPosition = visibleCharsSoFar;
      }

      if (t === 'noscript') hasNoscript = true;
      if (t === 'body') seenBodyTag = true;

      const isSvg = t === 'svg';
      const isEmbeddedTitleContainer = EMBEDDED_TITLE_CONTAINERS.has(t);
      const isTemplate = t === 'template';
      const isNoscript = t === 'noscript';
      const isHead = t === 'head';
      const isBody = t === 'body';
      const isSummary = t === 'summary';
      const isDetailsClosed = t === 'details' && !token.attrs.has('open');
      const ariaHidden = (token.attrs.get('aria-hidden') || '').trim().toLowerCase() === 'true';
      const hasHiddenAttr = token.attrs.has('hidden');
      const inlineStyle = token.attrs.get('style') || '';
      const isCollapsed = hasHiddenAttr || ariaHidden || INLINE_HIDDEN_STYLE_RE.test(inlineStyle);
      const isNosnippet = token.attrs.has('data-nosnippet');
      const isConsent = isConsentOverlayTag(t, token.attrs);
      const isChrome = CHROME_LANDMARK_TAGS.has(t);
      const isTitle = t === 'title';

      const inMainCandidate = headDepth === 0
        && svgDepth === 0
        && templateDepth === 0
        && noscriptDepth === 0
        && collapsedDepth === 0
        && consentDepth === 0
        && chromeDepth === 0
        && !isCollapsed
        && !isConsent
        && !isChrome;

      if (t === 'section' && inMainCandidate) {
        bodySectionsCount += 1;
      }

      const isBodyHeading = (t === 'h1' || t === 'h2' || t === 'h3') && inMainCandidate;

      // Track data tables in main candidate body
      if (t === 'table' && !token.selfClosing && inMainCandidate) {
        if (tableStack.length > 0) {
          tableStack[tableStack.length - 1].hasNestedTable = true;
        }
        const role = (token.attrs.get('role') || '').trim().toLowerCase();
        tableStack.push({
          isPresentation: role === 'presentation' || role === 'none',
          hasNestedTable: false,
          rows: 0,
          maxCols: 0,
          currentRowCols: 0,
        });
      } else if (t === 'tr' && tableStack.length > 0) {
        const top = tableStack[tableStack.length - 1];
        top.rows += 1;
        top.currentRowCols = 0;
      } else if ((t === 'td' || t === 'th') && tableStack.length > 0) {
        const top = tableStack[tableStack.length - 1];
        top.currentRowCols += 1;
        if (top.currentRowCols > top.maxCols) top.maxCols = top.currentRowCols;
      }

      if (!token.selfClosing) {
        if (isSvg) svgDepth += 1;
        if (isEmbeddedTitleContainer) embeddedTitleDepth += 1;
        if (isTemplate) templateDepth += 1;
        if (isNoscript) noscriptDepth += 1;
        if (isHead) headDepth += 1;
        if (isBody) bodyDepth += 1;
        if (isCollapsed) collapsedDepth += 1;
        if (isDetailsClosed) closedDetailsDepth += 1;
        if (isSummary) summaryDepth += 1;
        if (isNosnippet) nosnippetDepth += 1;
        if (isConsent) consentDepth += 1;
        if (isChrome) chromeDepth += 1;

        stack.push({
          tag: t,
          isSvg,
          isEmbeddedTitleContainer,
          isTemplate,
          isNoscript,
          isHead,
          isBody,
          isCollapsed,
          isDetailsClosed,
          isSummary,
          isNosnippet,
          isConsent,
          isChrome,
          isTitle,
          isBodyHeading,
          headingBuf: isBodyHeading ? [] : undefined,
          titleBuf: isTitle ? [] : undefined,
          svgStart: isSvg && svgDepth === 1 ? token.start : undefined,
        });
      } else if (isSvg) {
        inlineSvgBytes += Buffer.byteLength(rawHtml.slice(token.start, token.end), 'utf8');
      }
    } else if (token.kind === 'close') {
      const t = token.tagName;
      if (t === 'table' && tableStack.length > 0) {
        const completed = tableStack.pop();
        if (completed && !completed.isPresentation && !completed.hasNestedTable && completed.rows >= 2 && completed.maxCols >= 2) {
          bodyTablesCount += 1;
        }
      }

      // Pop matching frame (tolerating malformed missing inner close tags within bounded search)
      let matchIdx = -1;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].tag === t) { matchIdx = k; break; }
      }
      if (matchIdx !== -1) {
        while (stack.length > matchIdx) {
          const popped = /** @type {typeof stack[number]} */ (stack.pop());
          if (popped.isSvg) {
            if (popped.svgStart !== undefined && svgDepth === 1) {
              inlineSvgBytes += Buffer.byteLength(rawHtml.slice(popped.svgStart, token.end), 'utf8');
            }
            svgDepth = Math.max(0, svgDepth - 1);
          }
          if (popped.isEmbeddedTitleContainer) embeddedTitleDepth = Math.max(0, embeddedTitleDepth - 1);
          if (popped.isTemplate) templateDepth = Math.max(0, templateDepth - 1);
          if (popped.isNoscript) noscriptDepth = Math.max(0, noscriptDepth - 1);
          if (popped.isHead) headDepth = Math.max(0, headDepth - 1);
          if (popped.isBody) bodyDepth = Math.max(0, bodyDepth - 1);
          if (popped.isCollapsed) collapsedDepth = Math.max(0, collapsedDepth - 1);
          if (popped.isDetailsClosed) closedDetailsDepth = Math.max(0, closedDetailsDepth - 1);
          if (popped.isSummary) summaryDepth = Math.max(0, summaryDepth - 1);
          if (popped.isNosnippet) nosnippetDepth = Math.max(0, nosnippetDepth - 1);
          if (popped.isConsent) consentDepth = Math.max(0, consentDepth - 1);
          if (popped.isChrome) chromeDepth = Math.max(0, chromeDepth - 1);

          if (popped.isTitle && popped.titleBuf) {
            const titleText = collapseWhitespace(popped.titleBuf.join(''));
            if (svgDepth > 0) {
              embeddedSvgTitlesIgnored += 1;
            } else if (embeddedTitleDepth === 0 && documentTitle === null && titleText) {
              documentTitle = titleText;
            }
          }
          if (popped.isBodyHeading && popped.headingBuf) {
            const headingText = collapseWhitespace(popped.headingBuf.join(' '));
            if (headingText) bodyHeadings.push(headingText);
          }
        }
      }
    }

    i = token.end;
  }

  // Silence unused variable warning when body tag isn't present in fragment inputs
  void seenBodyTag;

  // Base64 image bytes across HTML
  let base64ImageBytes = 0;
  for (const match of rawHtml.matchAll(BASE64_IMAGE_RE)) {
    base64ImageBytes += Buffer.byteLength(match[0], 'utf8');
  }

  const visibleProseText = collapseWhitespace(visibleProseParts.join(' '));
  const collapsedText = collapseWhitespace(collapsedParts.join(' '));
  const dataNosnippetText = collapseWhitespace(dataNosnippetParts.join(' '));
  const visibleProseBytes = Buffer.byteLength(visibleProseText, 'utf8');
  const payloadToProseRatio = Number((rawHtmlBytes / Math.max(1, visibleProseBytes)).toFixed(2));

  const inlineJsCssBytes = inlineScriptBytes + inlineStyleBytes;
  const inlineJsCssHeavy = inlineJsCssBytes >= KB_20;

  /** @type {'optimal'|'moderate'|'bloated'} */
  const domNodeStatus = domNodeEstimate < 600
    ? 'optimal'
    : domNodeEstimate <= 1200
      ? 'moderate'
      : 'bloated';

  const collapsedChars = collapsedText.length;
  const dataNosnippetChars = dataNosnippetText.length;
  const totalBodyTextChars = visibleProseText.length + collapsedChars;
  const collapsedShare = totalBodyTextChars > 0
    ? Number((collapsedChars / totalBodyTextChars).toFixed(4))
    : 0;
  const dataNosnippetShare = totalBodyTextChars > 0
    ? Number((dataNosnippetChars / totalBodyTextChars).toFixed(4))
    : 0;

  // JSON-LD visible-text cross-check (capped at 200 values)
  /** @type {JsonLdCheckItem[]} */
  const jsonLdItems = [];
  /** @type {Set<string>} */
  const jsonLdSeen = new Set();
  const jsonLdState = { truncated: false };
  let jsonLdParseErrors = 0;

  for (const block of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(block);
      collectJsonLdCheckValues(parsed, jsonLdItems, jsonLdSeen, MAX_JSONLD_CHECK_VALUES, jsonLdState);
    } catch {
      jsonLdParseErrors += 1;
    }
  }

  const visibleLower = visibleProseText.toLowerCase();
  const visibleDigits = visibleProseText.replace(/\D/g, '');
  /** @type {JsonLdCheckItem[]} */
  const matched = [];
  /** @type {JsonLdCheckItem[]} */
  const missing = [];
  for (const item of jsonLdItems) {
    if (jsonLdValueVisible(item, visibleLower, visibleDigits)) {
      matched.push(item);
    } else {
      missing.push(item);
    }
  }

  /** @type {JsonLdCrossCheckResult} */
  const jsonLdCrossCheck = {
    blocksCount: jsonLdBlocks.length,
    parseErrors: jsonLdParseErrors,
    checkedCount: jsonLdItems.length,
    matchedCount: matched.length,
    missingCount: missing.length,
    matchRatio: jsonLdItems.length > 0 ? Number((matched.length / jsonLdItems.length).toFixed(4)) : null,
    truncatedAt200: jsonLdState.truncated,
    matched,
    missing,
  };

  // Soft-404 detector: matches 404 / "not found" ONLY when main visible text < 1,000 chars
  const mainTextChars = visibleProseText.length;
  let soft404Detected = false;
  /** @type {string|null} */
  let soft404Reason = null;
  if (mainTextChars < 1000) {
    if (documentTitle && SOFT_404_RE.test(documentTitle)) {
      soft404Detected = true;
      soft404Reason = `Document title indicates 404/not-found with thin body (${mainTextChars} chars)`;
    } else if (SOFT_404_RE.test(visibleProseText)) {
      soft404Detected = true;
      soft404Reason = `Visible text matches 404/not-found with thin body (${mainTextChars} chars)`;
    }
  }

  // Gatsby-safe <noscript> app-shell check: only flags when raw main text < 25 chars
  const noscriptText = collapseWhitespace(noscriptParts.join(' '));
  const hasJsWarning = NOSCRIPT_JS_WARNING_RE.test(noscriptText);
  const noscriptFlagged = mainTextChars < 25 && (hasJsWarning || noscriptText.length >= 15);

  // Extract Markdown (or reuse pre-extracted result) for WCXB drop check & truncation cliffs
  const extracted = options.extracted ?? extractBotMarkdown(rawHtml, {
    url: options.url,
    includeAgentMode: false,
    forceFallback: options.forceFallback,
  });

  const extractedHeadingKeys = new Set(extracted.headings.map((h) => normalizeCompareKey(h.text)));
  const extractedMarkdownLower = normalizeCompareKey(extracted.markdown);
  const uniqueBodyHeadings = Array.from(new Set(bodyHeadings));
  const droppedHeadings = uniqueBodyHeadings.filter((h) => {
    const key = normalizeCompareKey(h);
    return !extractedHeadingKeys.has(key) && !extractedMarkdownLower.includes(key);
  });
  const droppedTablesCount = Math.max(0, bodyTablesCount - extracted.tablesCount);

  const headingDropRatio = uniqueBodyHeadings.length > 0
    ? droppedHeadings.length / uniqueBodyHeadings.length
    : 0;
  const multiSectionWarning = droppedTablesCount > 0
    || (bodySectionsCount >= 2 && droppedHeadings.length >= 1 && headingDropRatio >= 0.25)
    || (droppedHeadings.length >= 2 && headingDropRatio >= 0.3);

  /** @type {string|null} */
  let multiSectionReason = null;
  if (multiSectionWarning) {
    /** @type {string[]} */
    const reasons = [];
    if (droppedTablesCount > 0) {
      reasons.push(`extractor dropped ${droppedTablesCount} of ${bodyTablesCount} body data table(s)`);
    }
    if (droppedHeadings.length > 0) {
      reasons.push(`extractor dropped ${droppedHeadings.length} of ${uniqueBodyHeadings.length} body section heading(s)`);
    }
    multiSectionReason = `${reasons.join('; ')} — wrap primary sections in semantic <main>/<article> landmarks`;
  }

  const markdownChars = extracted.charCount;
  /** @type {'pass'|'warn'|'fail'} */
  const mdStatus = markdownChars > MARKDOWN_FAIL_CHARS
    ? 'fail'
    : markdownChars > MARKDOWN_WARN_CHARS
      ? 'warn'
      : 'pass';

  return {
    rawHtmlBytes,
    visibleProseBytes,
    payloadToProseRatio,
    nextFlightBytes,
    nextDataBytes,
    jsonLdBytes,
    inlineScriptBytes,
    inlineStyleBytes,
    inlineJsCssBytes,
    inlineJsCssHeavy,
    largeNonJsonLdBlobs,
    inlineSvgBytes,
    base64ImageBytes,
    domNodeEstimate,
    domNodeStatus,
    domNodesUnder600: domNodeEstimate < 600,
    domNodesOver1200: domNodeEstimate > 1200,
    collapsedChars,
    collapsedShare,
    collapsedShareWarning: collapsedShare >= 0.5,
    dataNosnippetChars,
    dataNosnippetShare,
    dataNosnippetWarning: dataNosnippetShare >= 0.3,
    jsonLdCrossCheck,
    documentTitle,
    embeddedSvgTitlesIgnored,
    soft404: {
      detected: soft404Detected,
      reason: soft404Reason,
      mainTextChars,
    },
    multiSectionDrop: {
      warning: multiSectionWarning,
      bodySectionsCount,
      bodyHeadingsCount: uniqueBodyHeadings.length,
      extractedHeadingsCount: extracted.headings.length,
      droppedHeadings,
      bodyTablesCount,
      extractedTablesCount: extracted.tablesCount,
      droppedTablesCount,
      reason: multiSectionReason,
    },
    noscriptAppShell: {
      hasNoscript,
      hasJsWarning,
      rawMainTextChars: mainTextChars,
      flagged: noscriptFlagged,
    },
    markdownTruncation: {
      markdownChars,
      warnThreshold: MARKDOWN_WARN_CHARS,
      failThreshold: MARKDOWN_FAIL_CHARS,
      status: mdStatus,
      exceeds50k: markdownChars > MARKDOWN_WARN_CHARS,
      exceeds100k: markdownChars > MARKDOWN_FAIL_CHARS,
    },
    contentStartPosition,
    firstH1HtmlByteOffset,
    rawHtmlCliffs: {
      bytes: rawHtmlBytes,
      exceeds30KB: rawHtmlBytes > KB_30,
      exceeds100KB: rawHtmlBytes > KB_100,
      exceeds300KB: rawHtmlBytes > KB_300,
      exceeds2MB: rawHtmlBytes > MB_2,
      tier: classifyHtmlWeightTier(rawHtmlBytes),
    },
  };
}
