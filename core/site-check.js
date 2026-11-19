/**
 * Zero-key technical pre-flight audit (`hearsay check <url>`).
 *
 * Pure Node 22 built-ins only — zero external runtime dependencies.
 * Never spoofs AI crawler User-Agents; reports honest raw-HTML, robots.txt
 * (RFC 9309), redirect-chain, header/meta, byte-offset truncation, and CSR
 * empty-shell signals with explicit epistemic disclaimers about IP/rDNS-gated
 * WAF/CDN rules.
 */

import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import { isIP } from 'node:net';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const USER_AGENT = 'HearsaySiteCheck/0.1 (+https://github.com/hearsay; honest pre-flight audit)';

export const AI_CRAWLERS = Object.freeze([
  'OAI-SearchBot',
  'ChatGPT-User',
  'GPTBot',
  'ClaudeBot',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
  'Googlebot',
  'Bingbot',
]);

const SEARCH_RETRIEVAL_BOTS = new Set(['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'PerplexityBot']);
const TRADITIONAL_SEARCH_BOTS = new Set(['Googlebot', 'Bingbot']);
const TRAINING_BOTS = new Set(['GPTBot', 'ClaudeBot', 'Google-Extended']);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_MAX_ROBOTS_REDIRECTS = 5;
const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROBOTS_BYTES = 512 * 1024;

const KB_30 = 30 * 1024;
const KB_100 = 100 * 1024;
const KB_300 = 300 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const SPA_ROOT_ID_RE = /^(?:root|app|__next|__nuxt|___gatsby|svelte|sveltekit|app-root|react-root|main-app|ember-application)$/i;
const NOSCRIPT_JS_WARNING_RE = /(?:enable\s+javascript|javascript\s+(?:is\s+)?required|requires\s+javascript|turn\s+on\s+javascript|does\s+not\s+support\s+javascript)/i;

const GEO_PATH_RE = /^\/(?:[a-z]{2}-[a-z]{2}|en|fr|de|es|it|pt|ja|ko|zh|nl|sv|da|no|fi|pl|ru|tr|ar|hi|uk|us|gb|ca|au|nz|eu|jp|cn|kr|br|mx|in|sg|hk|tw)(?:\/|$)/i;
const GEO_SUBDOMAIN_RE = /^(?:us|uk|gb|eu|de|fr|es|it|jp|cn|au|ca|br|in|sg|nl|se|no|dk|fi|pl|kr|tw|hk|en|zh|ja|ko)\./i;
const GEO_QUERY_KEYS = new Set(['locale', 'lang', 'language', 'country', 'region', 'hl', 'gl', 'geo', 'mkt', 'cc']);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const AUTO_CLOSE_P_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul',
]);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

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
};

/**
 * Typed error for site-check validation, SSRF blocks, and transport failures.
 */
export class SiteCheckError extends Error {
  /**
   * @param {'invalid_url'|'ssrf_blocked'|'fetch_failed'|'timeout'|'invalid_arguments'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SiteCheckError';
    this.code = code;
  }
}

/**
 * @typedef {Object} RedirectHop
 * @property {number} status
 * @property {string} url
 * @property {string} location
 * @property {string} resolvedUrl
 * @property {boolean} crossHost
 * @property {boolean} geoLikely
 */

/**
 * @typedef {Object} CrawlerRuleResult
 * @property {string} bot
 * @property {string|null} matchedGroup
 * @property {string|null} rule
 * @property {'allow'|'disallow'|null} directive
 * @property {string|null} pattern
 * @property {boolean} allowed
 * @property {'allowed'|'blocked'|'default_allowed'|'unavailable'} status
 */

/**
 * @typedef {Object} RobotsParseResult
 * @property {string} bot
 * @property {string|null} matchedGroup
 * @property {string|null} rule
 * @property {'allow'|'disallow'|null} directive
 * @property {string|null} pattern
 * @property {boolean} allowed
 * @property {'allowed'|'blocked'|'default_allowed'} status
 * @property {string[]} sitemaps
 */

/**
 * @typedef {Object} HtmlMetaSignals
 * @property {string|null} title
 * @property {string|null} description
 * @property {string|null} robots
 * @property {string|null} googlebot
 * @property {string|null} canonical
 */

/**
 * @typedef {Object} PayloadAnalysis
 * @property {number} htmlBytes
 * @property {number} scriptBytes
 * @property {number} styleBytes
 * @property {number} scriptRatio
 * @property {number} styleRatio
 * @property {number} codeRatio
 * @property {number} scriptTagCount
 * @property {number} externalScriptCount
 * @property {boolean} hasNoscriptJsWarning
 * @property {number} visibleTextBytes
 * @property {number} visibleWordCount
 * @property {number} visibleCharCount
 * @property {Array<{level: number, text: string, byteOffset: number}>} headings
 * @property {number} headingCount
 * @property {number} tableCount
 * @property {number} jsonLdCount
 * @property {string[]} jsonLdTypes
 * @property {{
 *   firstH1Bytes: number|null,
 *   firstSubstantiveParagraphBytes: number|null,
 *   text25PctBytes: number|null,
 *   text50PctBytes: number|null,
 *   text75PctBytes: number|null,
 *   text90PctBytes: number|null,
 * }} offsets
 * @property {{
 *   contentStartsAfter30KB: boolean,
 *   coreContentPast100KB: boolean,
 *   pageExceeds300KB: boolean,
 *   any: boolean,
 * }} truncationRisks
 * @property {{
 *   level: 'high'|'medium'|'low',
 *   spaRoots: string[],
 *   reasons: string[],
 * }} csrRisk
 * @property {HtmlMetaSignals} meta
 */

/**
 * @typedef {Object} BrowserDiffResult
 * @property {'skipped'|'ok'|'unavailable'|'error'} status
 * @property {string} [engine]
 * @property {string} [reason]
 * @property {number} [rawWordCount]
 * @property {number} [renderedWordCount]
 * @property {number} [addedWordCount]
 * @property {number} [addedWordRatio]
 * @property {number} [rawHeadingCount]
 * @property {number} [renderedHeadingCount]
 * @property {string|null} [renderedTitle]
 * @property {'high'|'medium'|'low'|'none'} [hydrationGap]
 */

/**
 * @typedef {Object} SiteFinding
 * @property {string} id
 * @property {'critical'|'warning'|'info'} severity
 * @property {'robots'|'indexing'|'redirects'|'payload'|'csr'|'browser'|'headers'} category
 * @property {string} title
 * @property {string} detail
 */

/**
 * @typedef {Object} SiteCheckReport
 * @property {number} schemaVersion
 * @property {string} checkedAt
 * @property {string} userAgent
 * @property {string} requestedUrl
 * @property {string} finalUrl
 * @property {number|null} status
 * @property {boolean} ok
 * @property {number} timingMs
 * @property {{
 *   count: number,
 *   hops: RedirectHop[],
 *   finalUrl: string,
 *   loopDetected: boolean,
 *   loopTarget: string|null,
 *   maxHopsExceeded: boolean,
 *   crossHost: boolean,
 *   geoLikely: boolean,
 * }} redirects
 * @property {{
 *   xRobotsTag: string|null,
 *   contentType: string|null,
 *   cacheControl: string|null,
 *   server: string|null,
 *   cfRay: string|null,
 *   vary: string|null,
 *   cdnDetected: string|null,
 * }} headers
 * @property {{
 *   title: string|null,
 *   description: string|null,
 *   robots: string|null,
 *   googlebot: string|null,
 *   canonical: string|null,
 *   canonicalResolved: string|null,
 *   canonicalMatchesFinal: boolean|null,
 *   noindex: boolean,
 *   nofollow: boolean,
 *   noindexSources: string[],
 * }} meta
 * @property {{
 *   url: string,
 *   status: number|null,
 *   fetched: boolean,
 *   error: string|null,
 *   sitemaps: string[],
 *   crawlers: CrawlerRuleResult[],
 *   blockedCount: number,
 *   allowedCount: number,
 * }} robotsTxt
 * @property {PayloadAnalysis} payload
 * @property {BrowserDiffResult} browserDiff
 * @property {SiteFinding[]} findings
 * @property {{
 *   grade: 'pass'|'warn'|'fail',
 *   criticalCount: number,
 *   warningCount: number,
 *   infoCount: number,
 * }} summary
 * @property {string[]} disclaimers
 */

/**
 * @typedef {Object} CheckSiteOptions
 * @property {number} [timeoutMs]
 * @property {number} [maxRedirects]
 * @property {number} [maxHtmlBytes]
 * @property {boolean} [allowPrivateHosts]
 * @property {boolean} [browser]
 * @property {string} [browserBinary]
 * @property {number} [browserTimeoutMs]
 * @property {(url: string, timeoutMs: number) => Promise<{engine: string, html: string}|null>} [browserRunner]
 * @property {typeof globalThis.fetch} [fetch]
 * @property {(hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>} [lookup]
 * @property {AbortSignal} [signal]
 */

/**
 * Strict HTML escaping for text nodes and quoted attributes.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Validate http:/https: URLs before rendering into an href attribute.
 * @param {unknown} rawUrl
 * @returns {string|null}
 */
function safeHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Decode common named and numeric HTML entities in a single pass.
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  if (!text || !text.includes('&')) return text;
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, named) => {
    if (dec !== undefined) {
      const code = Number.parseInt(dec, 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    if (named !== undefined) {
      const key = named.toLowerCase();
      if (Object.hasOwn(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    }
    return match;
  });
}

/**
 * Strip IPv6 brackets and zone index from a host string.
 * @param {string} host
 * @returns {string}
 */
function stripHostBrackets(host) {
  let clean = host.trim().toLowerCase();
  if (clean.startsWith('[') && clean.endsWith(']')) clean = clean.slice(1, -1);
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx >= 0) clean = clean.slice(0, zoneIdx);
  return clean;
}

/**
 * Parse a dotted-quad IPv4 address into 4 octets, or null if invalid.
 * @param {string} ip
 * @returns {[number, number, number, number]|null}
 */
function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  /** @type {number[]} */
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return /** @type {[number, number, number, number]} */ (octets);
}

/**
 * Check whether an IPv4 octet tuple falls inside private, loopback, link-local,
 * CGNAT, multicast, or reserved space.
 * @param {[number, number, number, number]} octets
 * @returns {boolean}
 */
function isPrivateIpv4Octets([a, b, c]) {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

/**
 * Expand an IPv6 string (including embedded IPv4 forms like ::ffff:127.0.0.1)
 * into 8 16-bit integer groups.
 * @param {string} ip
 * @returns {number[]|null}
 */
function expandIpv6(ip) {
  let addr = stripHostBrackets(ip);
  // Handle embedded IPv4 tail (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(':');
  if (lastColon >= 0 && addr.slice(lastColon + 1).includes('.')) {
    const ipv4 = parseIpv4(addr.slice(lastColon + 1));
    if (!ipv4) return null;
    const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  /** @param {string} part */
  const parsePart = (part) => {
    if (!part) return [];
    const tokens = part.split(':');
    /** @type {number[]} */
    const nums = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      nums.push(Number.parseInt(token, 16));
    }
    return nums;
  };

  const left = parsePart(halves[0]);
  if (!left) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parsePart(halves[1]);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

/**
 * Determine whether an IPv4 or IPv6 address is loopback, private, link-local,
 * or otherwise non-public.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  const clean = stripHostBrackets(ip);
  const kind = isIP(clean);
  if (kind === 4) {
    const octets = parseIpv4(clean);
    return octets ? isPrivateIpv4Octets(octets) : true;
  }
  if (kind === 6) {
    const g = expandIpv6(clean);
    if (!g) return true;
    const allZero = g.every((v) => v === 0);
    if (allZero) return true; // ::
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
      return true; // ::1
    }
    // IPv4-mapped ::ffff:0:0/96
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      return isPrivateIpv4Octets([(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff]);
    }
    // IPv4-translated ::ffff:0:0:0/96
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
      return isPrivateIpv4Octets([(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff]);
    }
    // Deprecated IPv4-compatible ::/96
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateIpv4Octets([(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff]);
    }
    // NAT64 well-known 64:ff9b::/96 or local-use 64:ff9b:1::/48
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateIpv4Octets([(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff]);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
    return false;
  }
  return false;
}

/**
 * Determine whether a hostname string directly refers to a loopback, local,
 * metadata, or private IP host.
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostLiteral(hostname) {
  const clean = stripHostBrackets(hostname).replace(/\.+$/, '');
  if (!clean) return true;
  if (isIP(clean)) return isPrivateIp(clean);
  if (
    clean === 'localhost' ||
    clean.endsWith('.localhost') ||
    clean === 'localhost.localdomain' ||
    clean.endsWith('.local') ||
    clean.endsWith('.internal') ||
    clean === 'metadata.goog' ||
    clean === 'metadata.google.internal' ||
    clean === 'ip6-localhost' ||
    clean === 'ip6-loopback'
  ) {
    return true;
  }
  return false;
}

/**
 * Validate that a raw URL is well-formed http: or https: with no credentials.
 * @param {string} rawUrl
 * @returns {URL}
 */
export function validateSiteUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new SiteCheckError('invalid_url', 'A non-empty http:// or https:// URL is required');
  }
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SiteCheckError('invalid_url', `Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SiteCheckError(
      'invalid_url',
      `Unsupported URL protocol "${parsed.protocol}"; only http: and https: are allowed`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new SiteCheckError('invalid_url', 'URLs with embedded credentials are not allowed');
  }
  if (!parsed.hostname) {
    throw new SiteCheckError('invalid_url', 'URL must include a hostname');
  }
  return parsed;
}

/**
 * Enforce SSRF guard against loopback, private, link-local, and DNS-resolved
 * internal addresses unless `allowPrivateHosts === true`.
 * @param {URL} parsedUrl
 * @param {{
 *   allowPrivateHosts: boolean,
 *   lookupFn?: ((hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>)|null,
 * }} opts
 */
async function assertSafeUrl(parsedUrl, { allowPrivateHosts, lookupFn }) {
  if (allowPrivateHosts) return;
  const host = stripHostBrackets(parsedUrl.hostname);
  if (isBlockedHostLiteral(host)) {
    throw new SiteCheckError(
      'ssrf_blocked',
      `Blocked private, loopback, or link-local host "${parsedUrl.hostname}" (pass allowPrivateHosts: true for local targets)`,
    );
  }
  if (!isIP(host) && lookupFn) {
    /** @type {Array<{address: string, family: number}>} */
    let records;
    try {
      records = await lookupFn(host, { all: true });
    } catch {
      return; // Let the HTTP client surface DNS resolution errors uniformly
    }
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        throw new SiteCheckError(
          'ssrf_blocked',
          `Host "${parsedUrl.hostname}" resolved to private/loopback address ${record.address}`,
        );
      }
    }
  }
}

/**
 * Normalize percent-encoding hex case in a robots path/pattern per RFC 9309 §2.2.2.
 * @param {string} value
 * @returns {string}
 */
function normalizeRobotsEscapes(value) {
  return value.replace(/%[0-9a-fA-F]{2}/g, (seq) => seq.toUpperCase());
}

/**
 * Test whether an RFC 9309 robots.txt path pattern matches a normalized target path.
 * Supports `*` wildcards and trailing `$` end anchor.
 * @param {string} pattern
 * @param {string} targetPath
 * @returns {boolean}
 */
function matchesRobotsPattern(pattern, targetPath) {
  if (!pattern) return false;
  const normPattern = normalizeRobotsEscapes(pattern);
  const normPath = normalizeRobotsEscapes(targetPath);
  const anchoredEnd = normPattern.endsWith('$');
  const body = anchoredEnd ? normPattern.slice(0, -1) : normPattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`);
  return regex.test(normPath);
}

/**
 * Normalize a robots.txt user-agent token (case-insensitive product token).
 * @param {string} agent
 * @returns {string}
 */
function normalizeRobotsAgent(agent) {
  return String(agent ?? '*').trim().split('/')[0].trim().toLowerCase();
}

/**
 * Normalize target path input for `parseRobotsTxt`.
 * @param {string} targetPath
 * @returns {string}
 */
function normalizeTargetPath(targetPath) {
  const raw = String(targetPath ?? '/').trim();
  if (!raw) return '/';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return `${parsed.pathname || '/'}${parsed.search}`;
    } catch {
      return '/';
    }
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Parse a `robots.txt` document per RFC 9309 and evaluate access for a specific
 * target path and user-agent using longest-match Allow/Disallow precedence.
 *
 * - Specific user-agent group(s) take strict precedence over `*`.
 * - Multiple groups for the same user-agent token are merged.
 * - Longest matching pattern (in UTF-8 octets) wins.
 * - Equal-length ties resolve in favor of `Allow` (least restrictive).
 *
 * @param {string} text
 * @param {string} [targetPath]
 * @param {string} [userAgent]
 * @returns {RobotsParseResult}
 */
export function parseRobotsTxt(text, targetPath = '/', userAgent = '*') {
  const raw = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
  const path = normalizeTargetPath(targetPath);
  const targetToken = normalizeRobotsAgent(userAgent);

  /** @type {Array<{agents: string[], rules: Array<{type: 'allow'|'disallow', pattern: string, raw: string}>}>} */
  const groups = [];
  /** @type {Set<string>} */
  const sitemapSet = new Set();

  /** @type {{agents: string[], rules: Array<{type: 'allow'|'disallow', pattern: string, raw: string}>}|null} */
  let currentGroup = null;
  let sawRuleInGroup = false;

  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemapSet.add(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!value) continue;
      if (!currentGroup || sawRuleInGroup) {
        currentGroup = { agents: [value], rules: [] };
        groups.push(currentGroup);
        sawRuleInGroup = false;
      } else {
        currentGroup.agents.push(value);
      }
      continue;
    }

    if (!currentGroup) continue;

    if (field === 'allow' || field === 'disallow') {
      sawRuleInGroup = true;
      if (value !== '') {
        currentGroup.rules.push({
          type: field,
          pattern: value,
          raw: `${field === 'allow' ? 'Allow' : 'Disallow'}: ${value}`,
        });
      }
    } else {
      sawRuleInGroup = true;
    }
  }

  /** @type {string|null} */
  let matchedGroup = null;
  /** @type {Array<{type: 'allow'|'disallow', pattern: string, raw: string}>} */
  const applicableRules = [];

  if (targetToken !== '*') {
    for (const group of groups) {
      const matchedAgent = group.agents.find((agent) => {
        const norm = normalizeRobotsAgent(agent);
        return norm !== '*' && norm === targetToken;
      });
      if (matchedAgent) {
        if (matchedGroup === null) matchedGroup = matchedAgent;
        applicableRules.push(...group.rules);
      }
    }
  }

  if (matchedGroup === null) {
    for (const group of groups) {
      if (group.agents.some((agent) => agent.trim() === '*')) {
        matchedGroup = '*';
        applicableRules.push(...group.rules);
      }
    }
  }

  /** @type {{type: 'allow'|'disallow', pattern: string, raw: string, length: number}|null} */
  let best = null;
  for (const rule of applicableRules) {
    if (!matchesRobotsPattern(rule.pattern, path)) continue;
    const length = Buffer.byteLength(rule.pattern, 'utf8');
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.type === 'allow' && best.type === 'disallow')
    ) {
      best = { ...rule, length };
    }
  }

  const sitemaps = [...sitemapSet];
  if (!best) {
    return {
      bot: userAgent,
      matchedGroup,
      rule: null,
      directive: null,
      pattern: null,
      allowed: true,
      status: 'default_allowed',
      sitemaps,
    };
  }

  const allowed = best.type === 'allow';
  return {
    bot: userAgent,
    matchedGroup,
    rule: best.raw,
    directive: best.type,
    pattern: best.pattern,
    allowed,
    status: allowed ? 'allowed' : 'blocked',
    sitemaps,
  };
}

/**
 * Find the closing `>` of an HTML tag starting at `start` (pointing at `<`),
 * respecting quoted attribute values.
 * @param {string} html
 * @param {number} start
 * @returns {number}
 */
function findTagEnd(html, start) {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Parse HTML tag attributes from the raw attribute substring inside a tag.
 * @param {string} attrSource
 * @returns {Record<string, string>}
 */
function parseTagAttributes(attrSource) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const len = attrSource.length;
  let i = 0;
  while (i < len) {
    while (i < len && /[\s/]/.test(attrSource[i])) i++;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(attrSource[i])) i++;
    const name = attrSource.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    while (i < len && /\s/.test(attrSource[i])) i++;
    if (i < len && attrSource[i] === '=') {
      i++;
      while (i < len && /\s/.test(attrSource[i])) i++;
      let value = '';
      if (i < len && (attrSource[i] === '"' || attrSource[i] === "'")) {
        const quote = attrSource[i++];
        const valStart = i;
        while (i < len && attrSource[i] !== quote) i++;
        value = attrSource.slice(valStart, i);
        if (i < len && attrSource[i] === quote) i++;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(attrSource[i])) i++;
        value = attrSource.slice(valStart, i);
      }
      attrs[name] = value;
    } else {
      attrs[name] = '';
    }
  }
  return attrs;
}

/**
 * Find the matching closing tag `</tagName...>` starting from `fromPos` (case-insensitive).
 * @param {string} lowerHtml
 * @param {string} tagName
 * @param {number} fromPos
 * @returns {{closeStart: number, closeEnd: number}}
 */
function findRawCloseTag(lowerHtml, tagName, fromPos) {
  const needle = `</${tagName}`;
  let search = fromPos;
  while (search < lowerHtml.length) {
    const idx = lowerHtml.indexOf(needle, search);
    if (idx === -1) return { closeStart: lowerHtml.length, closeEnd: lowerHtml.length };
    const after = lowerHtml[idx + needle.length];
    if (after === '>' || after === undefined || /[\s/]/.test(after)) {
      const gt = lowerHtml.indexOf('>', idx + needle.length);
      return { closeStart: idx, closeEnd: gt === -1 ? lowerHtml.length : gt + 1 };
    }
    search = idx + needle.length;
  }
  return { closeStart: lowerHtml.length, closeEnd: lowerHtml.length };
}

/**
 * Find the matching closing tag for a potentially nested container (`svg`, `template`).
 * @param {string} lowerHtml
 * @param {string} rawHtml
 * @param {string} tagName
 * @param {number} fromPos
 * @returns {number}
 */
function findNestedCloseTag(lowerHtml, rawHtml, tagName, fromPos) {
  let depth = 1;
  let pos = fromPos;
  const openNeedle = `<${tagName}`;
  const closeNeedle = `</${tagName}`;
  while (pos < lowerHtml.length && depth > 0) {
    const nextOpen = lowerHtml.indexOf(openNeedle, pos);
    const nextClose = lowerHtml.indexOf(closeNeedle, pos);
    if (nextClose === -1) return lowerHtml.length;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const after = lowerHtml[nextOpen + openNeedle.length];
      if (after === '>' || after === '/' || /\s/.test(after ?? '')) {
        const gt = findTagEnd(rawHtml, nextOpen);
        if (gt === -1) return lowerHtml.length;
        const selfClosing = rawHtml.slice(nextOpen, gt).trimEnd().endsWith('/');
        if (!selfClosing) depth++;
        pos = gt + 1;
        continue;
      }
      pos = nextOpen + openNeedle.length;
      continue;
    }
    const afterClose = lowerHtml[nextClose + closeNeedle.length];
    if (afterClose === '>' || afterClose === undefined || /[\s/]/.test(afterClose)) {
      const gt = lowerHtml.indexOf('>', nextClose + closeNeedle.length);
      depth--;
      pos = gt === -1 ? lowerHtml.length : gt + 1;
    } else {
      pos = nextClose + closeNeedle.length;
    }
  }
  return pos;
}

/**
 * Safely extract `@type` strings from a JSON-LD script body.
 * @param {string} rawJson
 * @param {Set<string>} target
 */
function collectJsonLdTypes(rawJson, target) {
  try {
    const parsed = JSON.parse(rawJson.trim());
    /** @param {unknown} node */
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const record = /** @type {Record<string, unknown>} */ (node);
      if (typeof record['@type'] === 'string' && record['@type'].trim()) {
        target.add(record['@type'].trim());
      } else if (Array.isArray(record['@type'])) {
        for (const entry of record['@type']) {
          if (typeof entry === 'string' && entry.trim()) target.add(entry.trim());
        }
      }
      if (Array.isArray(record['@graph'])) walk(record['@graph']);
    };
    walk(parsed);
  } catch {
    /* ignore malformed JSON-LD */
  }
}

/**
 * Analyze raw HTML payload size, script/style ratios, visible text, headings,
 * tables, JSON-LD blocks, exact UTF-8 byte offsets in raw HTML, truncation
 * cliff risks, CSR empty-shell risk, and document `<meta>`/`<link>`/`<title>` signals.
 *
 * @param {string|Buffer} html
 * @param {number} [byteLength]
 * @returns {PayloadAnalysis}
 */
export function analyzeHtmlPayload(html, byteLength) {
  const rawHtml = typeof html === 'string' ? html : Buffer.isBuffer(html) ? html.toString('utf8') : String(html ?? '');
  const lowerHtml = rawHtml.toLowerCase();
  const computedBytes = Buffer.byteLength(rawHtml, 'utf8');
  const htmlBytes = typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength >= 0
    ? byteLength
    : computedBytes;

  let curPos = 0;
  let curByte = 0;
  /** @param {number} nextPos */
  const advanceTo = (nextPos) => {
    if (nextPos > curPos) {
      curByte += Buffer.byteLength(rawHtml.slice(curPos, nextPos), 'utf8');
      curPos = nextPos;
    }
    return curByte;
  };

  let scriptBytes = 0;
  let styleBytes = 0;
  let scriptTagCount = 0;
  let externalScriptCount = 0;
  let hasNoscriptJsWarning = false;
  let tableCount = 0;
  let jsonLdCount = 0;
  /** @type {Set<string>} */
  const jsonLdTypes = new Set();
  /** @type {Set<string>} */
  const spaRoots = new Set();

  /** @type {HtmlMetaSignals} */
  const meta = {
    title: null,
    description: null,
    robots: null,
    googlebot: null,
    canonical: null,
  };
  /** @type {string[]} */
  const robotsMetaParts = [];
  /** @type {string[]} */
  const googlebotMetaParts = [];

  /** @type {Array<{level: number, text: string, byteOffset: number}>} */
  const headings = [];
  /** @type {number|null} */
  let firstH1Bytes = null;
  /** @type {number|null} */
  let firstSubstantivePBytes = null;
  /** @type {number|null} */
  let fallbackParagraphBytes = null;

  /** @type {{level: number, startByte: number, chunks: string[]}|null} */
  let activeHeading = null;
  /** @type {{startByte: number, chunks: string[]}|null} */
  let activeP = null;
  /** @type {{startByte: number|null, chunks: string[]}} */
  let fallbackSeg = { startByte: null, chunks: [] };

  let inHead = false;
  let visibleWordCount = 0;
  let totalVisibleChars = 0;
  /** @type {string[]} */
  const visibleTextChunks = [];
  /** @type {Array<{chars: number, byteOffset: number}>} */
  const visibleSpans = [];

  const flushParagraph = () => {
    if (!activeP) return;
    const text = activeP.chunks.join('').replace(/\s+/g, ' ').trim();
    if (text.length >= 80 && firstSubstantivePBytes === null) {
      firstSubstantivePBytes = activeP.startByte;
    }
    activeP = null;
  };

  const flushFallbackSegment = () => {
    if (fallbackSeg.chunks.length === 0) return;
    const text = fallbackSeg.chunks.join('').replace(/\s+/g, ' ').trim();
    if (text.length >= 80 && fallbackParagraphBytes === null && fallbackSeg.startByte !== null) {
      fallbackParagraphBytes = fallbackSeg.startByte;
    }
    fallbackSeg = { startByte: null, chunks: [] };
  };

  /**
   * Process a visible text slice from `startPos` to `endPos`.
   * @param {number} startPos
   * @param {number} endPos
   */
  const consumeText = (startPos, endPos) => {
    if (inHead || endPos <= startPos) return;
    const startByte = advanceTo(startPos);
    const slice = rawHtml.slice(startPos, endPos);

    const decodedWhole = decodeHtmlEntities(slice);
    if (activeHeading) activeHeading.chunks.push(decodedWhole);
    if (activeP) activeP.chunks.push(decodedWhole);

    let localPos = 0;
    let localByte = startByte;
    const tokenRe = /\S+/g;
    /** @type {RegExpExecArray|null} */
    let match;
    while ((match = tokenRe.exec(slice)) !== null) {
      if (match.index > localPos) {
        localByte += Buffer.byteLength(slice.slice(localPos, match.index), 'utf8');
        localPos = match.index;
      }
      const decodedToken = decodeHtmlEntities(match[0]).replace(/\s+/g, ' ').trim();
      if (!decodedToken) continue;

      if (!activeHeading) {
        if (fallbackSeg.startByte === null) fallbackSeg.startByte = localByte;
        fallbackSeg.chunks.push(decodedToken, ' ');
      }

      const words = decodedToken.split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      visibleWordCount += words.length;
      const nonSpaceChars = words.join('').length;
      totalVisibleChars += nonSpaceChars;
      visibleSpans.push({ chars: nonSpaceChars, byteOffset: localByte });
      visibleTextChunks.push(words.join(' '));
    }
  };

  const len = rawHtml.length;
  let i = 0;
  while (i < len) {
    const lt = rawHtml.indexOf('<', i);
    if (lt === -1) {
      consumeText(i, len);
      break;
    }
    if (lt > i) {
      consumeText(i, lt);
      i = lt;
    }

    const tagStartPos = i;
    const tagStartByte = advanceTo(tagStartPos);

    // HTML comment <!-- ... -->
    if (rawHtml.startsWith('<!--', i)) {
      const end = rawHtml.indexOf('-->', i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // Declaration / processing instruction <! ... > or <? ... >
    if (rawHtml[i + 1] === '!' || rawHtml[i + 1] === '?') {
      const end = rawHtml.indexOf('>', i + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // Check for valid tag name
    const tagMatch = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(rawHtml.slice(i, i + 64));
    if (!tagMatch) {
      consumeText(i, i + 1);
      i += 1;
      continue;
    }

    const isClosing = tagMatch[1] === '/';
    const tagName = tagMatch[2].toLowerCase();
    const gt = findTagEnd(rawHtml, i);
    if (gt === -1) {
      consumeText(i, len);
      break;
    }

    const attrSource = rawHtml.slice(i + tagMatch[0].length, gt);
    const isSelfClosing = attrSource.trimEnd().endsWith('/') || VOID_TAGS.has(tagName);
    const tagEndPos = gt + 1;

    // Raw-text & skipped container elements
    if (!isClosing && !isSelfClosing) {
      if (tagName === 'script') {
        const attrs = parseTagAttributes(attrSource);
        const { closeStart, closeEnd } = findRawCloseTag(lowerHtml, 'script', tagEndPos);
        const blockEndByte = advanceTo(closeEnd);
        scriptBytes += blockEndByte - tagStartByte;

        const scriptType = (attrs.type ?? '').trim().toLowerCase().split(';')[0].trim();
        if (scriptType === 'application/ld+json') {
          jsonLdCount += 1;
          collectJsonLdTypes(rawHtml.slice(tagEndPos, closeStart), jsonLdTypes);
        } else {
          scriptTagCount += 1;
          if (attrs.src && attrs.src.trim() !== '') externalScriptCount += 1;
        }
        i = closeEnd;
        continue;
      }

      if (tagName === 'style') {
        const { closeEnd } = findRawCloseTag(lowerHtml, 'style', tagEndPos);
        const blockEndByte = advanceTo(closeEnd);
        styleBytes += blockEndByte - tagStartByte;
        i = closeEnd;
        continue;
      }

      if (tagName === 'noscript') {
        const { closeStart, closeEnd } = findRawCloseTag(lowerHtml, 'noscript', tagEndPos);
        const inner = rawHtml.slice(tagEndPos, closeStart);
        if (NOSCRIPT_JS_WARNING_RE.test(inner)) hasNoscriptJsWarning = true;
        i = closeEnd;
        continue;
      }

      if (tagName === 'svg') {
        i = findNestedCloseTag(lowerHtml, rawHtml, 'svg', tagEndPos);
        continue;
      }

      if (tagName === 'template') {
        i = findNestedCloseTag(lowerHtml, rawHtml, 'template', tagEndPos);
        continue;
      }

      if (tagName === 'title') {
        const { closeStart, closeEnd } = findRawCloseTag(lowerHtml, 'title', tagEndPos);
        if (meta.title === null) {
          const titleText = decodeHtmlEntities(rawHtml.slice(tagEndPos, closeStart)).replace(/\s+/g, ' ').trim();
          if (titleText) meta.title = titleText;
        }
        i = closeEnd;
        continue;
      }
    }

    // Track <head> / <body> boundaries
    if (tagName === 'head') {
      inHead = !isClosing;
      i = tagEndPos;
      continue;
    }
    if (tagName === 'body' && !isClosing) {
      inHead = false;
      i = tagEndPos;
      continue;
    }

    // Metadata tags (<meta>, <link>)
    if (!isClosing && tagName === 'meta') {
      const attrs = parseTagAttributes(attrSource);
      const name = (attrs.name ?? '').trim().toLowerCase();
      const content = decodeHtmlEntities(attrs.content ?? '').replace(/\s+/g, ' ').trim();
      if (name === 'robots' && content) robotsMetaParts.push(content);
      if (name === 'googlebot' && content) googlebotMetaParts.push(content);
      if (name === 'description' && content && meta.description === null) meta.description = content;
      i = tagEndPos;
      continue;
    }

    if (!isClosing && tagName === 'link') {
      const attrs = parseTagAttributes(attrSource);
      const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const href = decodeHtmlEntities(attrs.href ?? '').trim();
      if (rels.includes('canonical') && href && meta.canonical === null) {
        meta.canonical = href;
      }
      i = tagEndPos;
      continue;
    }

    if (!inHead) {
      if (!isClosing && tagName === 'table') {
        tableCount += 1;
      }

      // SPA mount root detection
      if (!isClosing && (attrSource.length > 0 || tagName === 'app-root')) {
        if (tagName === 'app-root') spaRoots.add('<app-root>');
        if (attrSource.length > 0) {
          const attrs = parseTagAttributes(attrSource);
          if (attrs.id && SPA_ROOT_ID_RE.test(attrs.id.trim())) {
            spaRoots.add(`#${attrs.id.trim()}`);
          }
          if (Object.hasOwn(attrs, 'data-reactroot')) spaRoots.add('[data-reactroot]');
          if (Object.hasOwn(attrs, 'ng-version')) spaRoots.add('[ng-version]');
          if (Object.hasOwn(attrs, 'data-v-app')) spaRoots.add('[data-v-app]');
        }
      }

      // Block boundaries flush fallback text segments and auto-close <p>
      if (BLOCK_TAGS.has(tagName)) {
        flushFallbackSegment();
        if (!isClosing && AUTO_CLOSE_P_TAGS.has(tagName)) {
          flushParagraph();
        }
      }

      // Headings h1-h3
      if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3') {
        const level = Number(tagName[1]);
        if (!isClosing && !isSelfClosing) {
          activeHeading = { level, startByte: tagStartByte, chunks: [] };
        } else if (isClosing && activeHeading && activeHeading.level === level) {
          const text = activeHeading.chunks.join('').replace(/\s+/g, ' ').trim();
          if (text) {
            headings.push({ level, text, byteOffset: activeHeading.startByte });
            if (level === 1 && firstH1Bytes === null) {
              firstH1Bytes = activeHeading.startByte;
            }
          }
          activeHeading = null;
        }
      }

      // Paragraphs <p>
      if (tagName === 'p') {
        if (!isClosing && !isSelfClosing) {
          activeP = { startByte: tagStartByte, chunks: [] };
        } else if (isClosing) {
          flushParagraph();
        }
      }
    }

    i = tagEndPos;
  }

  // Flush any unclosed trailing structures
  if (activeHeading) {
    const text = activeHeading.chunks.join('').replace(/\s+/g, ' ').trim();
    if (text) {
      headings.push({ level: activeHeading.level, text, byteOffset: activeHeading.startByte });
      if (activeHeading.level === 1 && firstH1Bytes === null) {
        firstH1Bytes = activeHeading.startByte;
      }
    }
    activeHeading = null;
  }
  flushParagraph();
  flushFallbackSegment();

  meta.robots = robotsMetaParts.length > 0 ? robotsMetaParts.join(', ') : null;
  meta.googlebot = googlebotMetaParts.length > 0 ? googlebotMetaParts.join(', ') : null;

  const visibleText = visibleTextChunks.join(' ');
  const visibleTextBytes = Buffer.byteLength(visibleText, 'utf8');
  const firstSubstantiveParagraphBytes = firstSubstantivePBytes ?? fallbackParagraphBytes;

  /**
   * Compute the raw-HTML UTF-8 byte offset where cumulative visible text reaches `fraction`.
   * @param {number} fraction
   * @returns {number|null}
   */
  const percentileOffset = (fraction) => {
    if (totalVisibleChars === 0 || visibleSpans.length === 0) return null;
    const threshold = Math.max(1, Math.ceil(totalVisibleChars * fraction));
    let cumulative = 0;
    for (const span of visibleSpans) {
      cumulative += span.chars;
      if (cumulative >= threshold) return span.byteOffset;
    }
    return visibleSpans[visibleSpans.length - 1].byteOffset;
  };

  const text25PctBytes = percentileOffset(0.25);
  const text50PctBytes = percentileOffset(0.5);
  const text75PctBytes = percentileOffset(0.75);
  const text90PctBytes = percentileOffset(0.9);

  const scriptRatio = htmlBytes > 0 ? Number((scriptBytes / htmlBytes).toFixed(4)) : 0;
  const styleRatio = htmlBytes > 0 ? Number((styleBytes / htmlBytes).toFixed(4)) : 0;
  const codeRatio = htmlBytes > 0 ? Number(((scriptBytes + styleBytes) / htmlBytes).toFixed(4)) : 0;

  // Truncation cliff flags
  /** @type {number[]} */
  const primaryStarts = [];
  if (firstH1Bytes !== null) primaryStarts.push(firstH1Bytes);
  if (firstSubstantiveParagraphBytes !== null) primaryStarts.push(firstSubstantiveParagraphBytes);
  const firstContentStart = primaryStarts.length > 0 ? Math.min(...primaryStarts) : text25PctBytes;

  const contentStartsAfter30KB = firstContentStart !== null && firstContentStart > KB_30;
  const coreContentPast100KB =
    (text50PctBytes !== null && text50PctBytes > KB_100) ||
    (firstSubstantiveParagraphBytes !== null && firstSubstantiveParagraphBytes > KB_100) ||
    (firstH1Bytes !== null && firstH1Bytes > KB_100);
  const pageExceeds300KB = htmlBytes > KB_300;

  // CSR empty-shell risk evaluation
  const spaRootList = [...spaRoots];
  const hasSpaRoot = spaRootList.length > 0;
  const heavyJs =
    scriptRatio >= 0.3 ||
    scriptBytes >= 10 * 1024 ||
    externalScriptCount >= 1 ||
    scriptTagCount >= 2;

  /** @type {'high'|'medium'|'low'} */
  let csrLevel = 'low';
  /** @type {string[]} */
  const csrReasons = [];

  if (hasSpaRoot && visibleWordCount < 80 && (heavyJs || hasNoscriptJsWarning)) {
    csrLevel = 'high';
    csrReasons.push(
      `SPA mount root (${spaRootList.join(', ')}) found with only ${visibleWordCount} visible words in raw HTML and JS bundle signals`,
    );
  } else if (visibleWordCount < 30 && htmlBytes > 0 && (heavyJs || hasNoscriptJsWarning)) {
    csrLevel = 'high';
    csrReasons.push(
      `Raw HTML exposes only ${visibleWordCount} visible words alongside JavaScript bundle/noscript signals`,
    );
  } else if (
    (hasSpaRoot && visibleWordCount < 80) ||
    (hasSpaRoot && visibleWordCount < 160 && (scriptRatio >= 0.4 || scriptBytes >= KB_30)) ||
    (visibleWordCount < 80 && (heavyJs || hasNoscriptJsWarning))
  ) {
    csrLevel = 'medium';
    csrReasons.push(
      `Low raw-HTML word count (${visibleWordCount} words) relative to client-side script footprint`,
    );
  }

  if (hasNoscriptJsWarning) {
    csrReasons.push('<noscript> block warns that JavaScript is required to view this page');
  }
  if (externalScriptCount > 0 && visibleWordCount < 80) {
    csrReasons.push(`${externalScriptCount} external <script src> tag(s) loaded for sparse initial HTML`);
  }
  if (scriptRatio >= 0.5 && visibleWordCount < 80) {
    csrReasons.push(`Inline/embedded scripts account for ${Math.round(scriptRatio * 100)}% of raw HTML bytes`);
  }

  return {
    htmlBytes,
    scriptBytes,
    styleBytes,
    scriptRatio,
    styleRatio,
    codeRatio,
    scriptTagCount,
    externalScriptCount,
    hasNoscriptJsWarning,
    visibleTextBytes,
    visibleWordCount,
    visibleCharCount: totalVisibleChars,
    headings,
    headingCount: headings.length,
    tableCount,
    jsonLdCount,
    jsonLdTypes: [...jsonLdTypes],
    offsets: {
      firstH1Bytes,
      firstSubstantiveParagraphBytes,
      text25PctBytes,
      text50PctBytes,
      text75PctBytes,
      text90PctBytes,
    },
    truncationRisks: {
      contentStartsAfter30KB,
      coreContentPast100KB,
      pageExceeds300KB,
      any: contentStartsAfter30KB || coreContentPast100KB || pageExceeds300KB,
    },
    csrRisk: {
      level: csrLevel,
      spaRoots: spaRootList,
      reasons: csrReasons,
    },
    meta,
  };
}

/**
 * Heuristic check for geo/locale redirects across hops.
 * @param {URL} fromUrl
 * @param {URL} toUrl
 * @param {Headers} headers
 * @returns {boolean}
 */
function detectGeoLikely(fromUrl, toUrl, headers) {
  const fromPath = fromUrl.pathname;
  const toPath = toUrl.pathname;
  if (!GEO_PATH_RE.test(fromPath) && GEO_PATH_RE.test(toPath)) return true;

  const fromHost = fromUrl.hostname.toLowerCase();
  const toHost = toUrl.hostname.toLowerCase();
  if (fromHost !== toHost) {
    if (!GEO_SUBDOMAIN_RE.test(fromHost) && GEO_SUBDOMAIN_RE.test(toHost)) return true;
    const fromTld = fromHost.split('.').slice(-1)[0];
    const toTld = toHost.split('.').slice(-1)[0];
    if (fromTld !== toTld && toTld.length === 2) return true;
  }

  for (const key of toUrl.searchParams.keys()) {
    if (GEO_QUERY_KEYS.has(key.toLowerCase()) && !fromUrl.searchParams.has(key)) return true;
  }

  const vary = (headers.get('vary') ?? '').toLowerCase();
  if (
    vary.includes('accept-language') ||
    vary.includes('cf-ipcountry') ||
    vary.includes('cloudfront-viewer-country') ||
    vary.includes('x-country')
  ) {
    return true;
  }

  return false;
}

/**
 * Detect CDN/WAF vendor hints from response headers.
 * @param {Headers} headers
 * @returns {string|null}
 */
function detectCdn(headers) {
  const server = (headers.get('server') ?? '').toLowerCase();
  if (headers.get('cf-ray') || server.includes('cloudflare')) return 'cloudflare';
  if (headers.get('x-akamai-transformed') || headers.get('akamai-grn') || server.includes('akamai')) return 'akamai';
  if (headers.get('x-amz-cf-id') || headers.get('x-amz-cf-pop')) return 'cloudfront';
  if (headers.get('x-served-by')?.toLowerCase().includes('cache-') || headers.get('fastly-restarts')) return 'fastly';
  if (headers.get('x-vercel-id') || server.includes('vercel')) return 'vercel';
  return null;
}

/**
 * Read a fetch Response body up to `maxBytes`, returning `{ buffer, truncated }`.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{buffer: Buffer, truncated: boolean}>}
 */
async function readBodyCapped(response, maxBytes) {
  if (!response.body) {
    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.byteLength > maxBytes) {
      return { buffer: buf.subarray(0, maxBytes), truncated: true };
    }
    return { buffer: buf, truncated: false };
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks, total), truncated };
}

/**
 * Build an AbortSignal combining timeout and optional caller abort signal.
 * @param {number} timeoutMs
 * @param {AbortSignal} [callerSignal]
 * @returns {AbortSignal}
 */
function buildSignal(timeoutMs, callerSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
}

/**
 * Check whether an X-Robots-Tag or `<meta name="robots">` value contains a directive.
 * @param {string|null} headerOrMeta
 * @param {'noindex'|'nofollow'} target
 * @returns {boolean}
 */
function hasRobotsDirective(headerOrMeta, target) {
  if (!headerOrMeta) return false;
  const tokens = headerOrMeta
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (token === target || token === 'none') return true;
    const colon = token.indexOf(':');
    if (colon >= 0) {
      const directive = token.slice(colon + 1).trim();
      if (directive === target || directive === 'none') return true;
    }
  }
  return false;
}

/**
 * Locate a local Chromium / Google Chrome executable safely without shell invocation.
 * @param {string} [overrideBinary]
 * @returns {string|null}
 */
function findLocalChromium(overrideBinary) {
  /** @param {string} candidate */
  const isExecutable = (candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (overrideBinary) {
    return isExecutable(overrideBinary) ? overrideBinary : null;
  }

  const absoluteCandidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const candidate of absoluteCandidates) {
    if (isExecutable(candidate)) return candidate;
  }

  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Attempt to render `finalUrl` using local Chromium (`--headless --dump-dom`)
 * or Playwright via an isolated Node child process (zero runtime imports).
 *
 * @param {string} finalUrl
 * @param {PayloadAnalysis} rawPayload
 * @param {{
 *   timeoutMs: number,
 *   browserBinary?: string,
 *   browserRunner?: (url: string, timeoutMs: number) => Promise<{engine: string, html: string}|null>,
 * }} opts
 * @returns {Promise<BrowserDiffResult>}
 */
async function runBrowserDiff(finalUrl, rawPayload, { timeoutMs, browserBinary, browserRunner }) {
  /** @type {{engine: string, html: string}|null} */
  let rendered = null;
  /** @type {string|null} */
  let runtimeError = null;

  if (browserRunner) {
    try {
      rendered = await browserRunner(finalUrl, timeoutMs);
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
    }
  } else {
    const chromiumPath = findLocalChromium(browserBinary);
    if (chromiumPath) {
      const baseArgs = [
        '--dump-dom',
        '--disable-gpu',
        '--no-sandbox',
        `--user-agent=${USER_AGENT}`,
        '--virtual-time-budget=4000',
        finalUrl,
      ];
      try {
        const { stdout } = await execFileAsync(chromiumPath, ['--headless=new', ...baseArgs], {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (stdout && stdout.trim()) rendered = { engine: `chromium (${chromiumPath})`, html: stdout };
      } catch (firstErr) {
        try {
          const { stdout } = await execFileAsync(chromiumPath, ['--headless', ...baseArgs], {
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          });
          if (stdout && stdout.trim()) rendered = { engine: `chromium (${chromiumPath})`, html: stdout };
        } catch (secondErr) {
          const err = secondErr instanceof Error ? secondErr : firstErr instanceof Error ? firstErr : null;
          runtimeError = err ? err.message : 'Headless Chromium failed to dump DOM';
        }
      }
    }

    // Fallback: probe Playwright in a subprocess so core/site-check.js keeps zero external runtime imports
    if (!rendered && !browserBinary) {
      const pwScript = [
        'const url = process.argv[1];',
        'const timeout = Number(process.argv[2]) || 10000;',
        'const ua = process.argv[3];',
        'let pw;',
        'try { pw = await import("playwright"); } catch { try { pw = await import("playwright-core"); } catch { process.exit(42); } }',
        'const browser = await pw.chromium.launch({ headless: true });',
        'try {',
        '  const page = await browser.newPage({ userAgent: ua });',
        '  await page.goto(url, { waitUntil: "networkidle", timeout }).catch(() => page.goto(url, { waitUntil: "domcontentloaded", timeout }));',
        '  const html = await page.content();',
        '  process.stdout.write(html);',
        '} finally { await browser.close(); }',
      ].join('\n');

      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          ['--input-type=module', '-e', pwScript, finalUrl, String(timeoutMs), USER_AGENT],
          { timeout: timeoutMs + 5_000, maxBuffer: 10 * 1024 * 1024 },
        );
        if (stdout && stdout.trim()) rendered = { engine: 'playwright', html: stdout };
      } catch (pwErr) {
        const code = /** @type {any} */ (pwErr)?.code;
        if (code !== 42 && !runtimeError) {
          runtimeError = pwErr instanceof Error ? pwErr.message : 'Playwright render failed';
        }
      }
    }
  }

  if (!rendered) {
    if (runtimeError) {
      return {
        status: 'unavailable',
        reason: `Local headless browser check unavailable (${runtimeError.split('\n')[0]}).`,
      };
    }
    return {
      status: 'unavailable',
      reason: 'No local Chromium/Google Chrome binary or Playwright installation found.',
    };
  }

  const renderedPayload = analyzeHtmlPayload(rendered.html);
  const rawWordCount = rawPayload.visibleWordCount;
  const renderedWordCount = renderedPayload.visibleWordCount;
  const addedWordCount = Math.max(0, renderedWordCount - rawWordCount);
  const addedWordRatio = renderedWordCount > 0 ? Number((addedWordCount / renderedWordCount).toFixed(3)) : 0;

  /** @type {'high'|'medium'|'low'|'none'} */
  let hydrationGap = 'none';
  if (addedWordCount >= 80 && (rawWordCount < 80 || addedWordRatio >= 0.5)) {
    hydrationGap = 'high';
  } else if (addedWordCount >= 40 && addedWordRatio >= 0.25) {
    hydrationGap = 'medium';
  } else if (addedWordCount > 0) {
    hydrationGap = 'low';
  }

  return {
    status: 'ok',
    engine: rendered.engine,
    rawWordCount,
    renderedWordCount,
    addedWordCount,
    addedWordRatio,
    rawHeadingCount: rawPayload.headingCount,
    renderedHeadingCount: renderedPayload.headingCount,
    renderedTitle: renderedPayload.meta.title,
    hydrationGap,
  };
}

/**
 * Fetch and evaluate `<origin>/robots.txt` for all 9 AI and search crawlers.
 * @param {string} finalUrl
 * @param {{
 *   fetchFn: typeof globalThis.fetch,
 *   timeoutMs: number,
 *   allowPrivateHosts: boolean,
 *   lookupFn: ((hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>)|null,
 *   signal?: AbortSignal,
 * }} opts
 */
async function fetchAndEvaluateRobots(finalUrl, { fetchFn, timeoutMs, allowPrivateHosts, lookupFn, signal }) {
  const parsedFinal = new URL(finalUrl);
  const targetPath = `${parsedFinal.pathname || '/'}${parsedFinal.search}`;
  const robotsUrl = new URL('/robots.txt', parsedFinal.origin).href;

  /** @type {string} */
  let currentUrl = robotsUrl;
  /** @type {Set<string>} */
  const visited = new Set([currentUrl]);
  /** @type {Response|null} */
  let response = null;
  /** @type {string|null} */
  let fetchError = null;

  try {
    for (let hop = 0; hop <= DEFAULT_MAX_ROBOTS_REDIRECTS; hop++) {
      const parsedHop = validateSiteUrl(currentUrl);
      await assertSafeUrl(parsedHop, { allowPrivateHosts, lookupFn });
      const res = await fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/plain,*/*;q=0.5',
        },
        signal: buildSignal(timeoutMs, signal),
      });
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location || hop === DEFAULT_MAX_ROBOTS_REDIRECTS) {
          response = res;
          break;
        }
        const nextUrl = new URL(location, currentUrl).href;
        if (visited.has(nextUrl)) {
          fetchError = 'robots.txt redirect loop detected';
          break;
        }
        visited.add(nextUrl);
        currentUrl = nextUrl;
        continue;
      }
      response = res;
      break;
    }
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  if (fetchError || !response) {
    /** @type {CrawlerRuleResult[]} */
    const crawlers = AI_CRAWLERS.map((bot) => ({
      bot,
      matchedGroup: null,
      rule: null,
      directive: null,
      pattern: null,
      allowed: false,
      status: 'unavailable',
    }));
    return {
      url: robotsUrl,
      status: null,
      fetched: false,
      error: fetchError ?? 'Failed to fetch robots.txt',
      sitemaps: /** @type {string[]} */ ([]),
      crawlers,
      blockedCount: crawlers.length,
      allowedCount: 0,
    };
  }

  if (response.status >= 200 && response.status < 300) {
    const { buffer } = await readBodyCapped(response, DEFAULT_MAX_ROBOTS_BYTES);
    const robotsText = buffer.toString('utf8');
    /** @type {string[]} */
    let sitemaps = [];
    /** @type {CrawlerRuleResult[]} */
    const crawlers = AI_CRAWLERS.map((bot) => {
      const evaluated = parseRobotsTxt(robotsText, targetPath, bot);
      if (sitemaps.length === 0 && evaluated.sitemaps.length > 0) sitemaps = evaluated.sitemaps;
      return {
        bot: evaluated.bot,
        matchedGroup: evaluated.matchedGroup,
        rule: evaluated.rule,
        directive: evaluated.directive,
        pattern: evaluated.pattern,
        allowed: evaluated.allowed,
        status: evaluated.status,
      };
    });
    const blockedCount = crawlers.filter((c) => !c.allowed).length;
    return {
      url: robotsUrl,
      status: response.status,
      fetched: true,
      error: null,
      sitemaps,
      crawlers,
      blockedCount,
      allowedCount: crawlers.length - blockedCount,
    };
  }

  await response.body?.cancel().catch(() => {});

  // RFC 9309 §2.3.1.3: 4xx -> unavailable -> crawlers assume no restrictions
  if (response.status >= 400 && response.status < 500) {
    /** @type {CrawlerRuleResult[]} */
    const crawlers = AI_CRAWLERS.map((bot) => ({
      bot,
      matchedGroup: null,
      rule: null,
      directive: null,
      pattern: null,
      allowed: true,
      status: 'default_allowed',
    }));
    return {
      url: robotsUrl,
      status: response.status,
      fetched: false,
      error: null,
      sitemaps: /** @type {string[]} */ ([]),
      crawlers,
      blockedCount: 0,
      allowedCount: crawlers.length,
    };
  }

  // RFC 9309 §2.3.1.4: 5xx -> temporary complete disallow
  /** @type {CrawlerRuleResult[]} */
  const crawlers = AI_CRAWLERS.map((bot) => ({
    bot,
    matchedGroup: null,
    rule: null,
    directive: null,
    pattern: null,
    allowed: false,
    status: 'unavailable',
  }));
  return {
    url: robotsUrl,
    status: response.status,
    fetched: false,
    error: `robots.txt returned HTTP ${response.status} (RFC 9309 treats 5xx as temporary disallow)`,
    sitemaps: /** @type {string[]} */ ([]),
    crawlers,
    blockedCount: crawlers.length,
    allowedCount: 0,
  };
}

/**
 * Build mandatory epistemic honesty disclaimers.
 * @param {string|null} cdnDetected
 * @returns {string[]}
 */
function buildDisclaimers(cdnDetected) {
  const list = [
    `Honest User-Agent policy: Hearsay identified itself honestly as "${USER_AGENT}" and never spoofed AI crawler User-Agents.`,
    'IP/rDNS WAF limitation: Cloudflare, Akamai, Fastly, and similar WAF/CDN layers verify AI crawlers (OAI-SearchBot, GPTBot, ClaudeBot, PerplexityBot, etc.) by published IP ranges, reverse DNS (rDNS), or cryptographic signatures rather than User-Agent strings alone. A local check cannot detect IP-gated WAF blocks, managed challenges, or CDN-level bot rate limits.',
    'How to verify real AI bot reachability: inspect your origin or CDN access logs (e.g., Cloudflare Security Events / AI Crawl Control, Akamai Bot Manager, or raw origin logs) filtered by official published crawler IP ranges and HTTP 200 vs 403/429 responses.',
  ];
  if (cdnDetected) {
    list.push(
      `CDN/WAF header detected (${cdnDetected}): double-check ${cdnDetected} bot management and firewall rules in addition to robots.txt.`,
    );
  }
  return list;
}

/**
 * Synthesize structured audit findings from all collected signals.
 * @param {{
 *   status: number|null,
 *   redirects: SiteCheckReport['redirects'],
 *   headers: SiteCheckReport['headers'],
 *   meta: SiteCheckReport['meta'],
 *   robotsTxt: SiteCheckReport['robotsTxt'],
 *   payload: PayloadAnalysis,
 *   browserDiff: BrowserDiffResult,
 * }} data
 * @returns {SiteFinding[]}
 */
function buildFindings(data) {
  /** @type {SiteFinding[]} */
  const findings = [];

  if (data.redirects.loopDetected) {
    findings.push({
      id: 'redirect_loop',
      severity: 'critical',
      category: 'redirects',
      title: 'Redirect loop detected',
      detail: `Redirect chain looped back to ${data.redirects.loopTarget ?? data.redirects.finalUrl} after ${data.redirects.count} hop(s).`,
    });
  } else if (data.redirects.maxHopsExceeded) {
    findings.push({
      id: 'max_redirects_exceeded',
      severity: 'critical',
      category: 'redirects',
      title: 'Too many redirects',
      detail: `Redirect chain exceeded the maximum of ${data.redirects.count} hops before reaching a final page.`,
    });
  }

  if (data.status !== null && data.status >= 400) {
    findings.push({
      id: 'http_error',
      severity: 'critical',
      category: 'headers',
      title: `Final response returned HTTP ${data.status}`,
      detail: `Crawlers received HTTP ${data.status} at ${data.redirects.finalUrl}.`,
    });
  }

  if (data.redirects.count >= 3) {
    findings.push({
      id: 'redirect_chain_long',
      severity: 'warning',
      category: 'redirects',
      title: `Long redirect chain (${data.redirects.count} hops)`,
      detail: 'Multi-hop redirects add crawl latency and can cause AI fetchers to drop or truncate requests.',
    });
  }

  if (data.redirects.geoLikely) {
    findings.push({
      id: 'geo_redirect_detected',
      severity: 'warning',
      category: 'redirects',
      title: 'Likely geo/locale redirect detected',
      detail: 'Redirect chain shifts locale/country path, subdomain, query, or Vary headers; verify US/global crawlers land on canonical content.',
    });
  }

  if (data.meta.noindex) {
    findings.push({
      id: 'noindex_detected',
      severity: 'critical',
      category: 'indexing',
      title: 'Page is marked noindex',
      detail: `Blocking indexing directive detected via ${data.meta.noindexSources.join(', ')}.`,
    });
  }

  if (data.meta.canonical && data.meta.canonicalMatchesFinal === false) {
    findings.push({
      id: 'canonical_mismatch',
      severity: 'warning',
      category: 'indexing',
      title: 'Canonical URL differs from final URL',
      detail: `<link rel="canonical"> points to ${data.meta.canonicalResolved ?? data.meta.canonical} instead of ${data.redirects.finalUrl}.`,
    });
  }

  // Robots.txt findings
  if (data.robotsTxt.error) {
    findings.push({
      id: 'robots_txt_unavailable',
      severity: 'warning',
      category: 'robots',
      title: 'robots.txt could not be fetched cleanly',
      detail: data.robotsTxt.error,
    });
  } else if (!data.robotsTxt.fetched && data.robotsTxt.status && data.robotsTxt.status >= 400 && data.robotsTxt.status < 500) {
    findings.push({
      id: 'robots_txt_missing',
      severity: 'info',
      category: 'robots',
      title: `No robots.txt found (HTTP ${data.robotsTxt.status})`,
      detail: 'Per RFC 9309, crawlers treat a 4xx robots.txt as allowing all paths by default.',
    });
  } else {
    const blockedSearchAi = data.robotsTxt.crawlers.filter((c) => !c.allowed && SEARCH_RETRIEVAL_BOTS.has(c.bot));
    const blockedTraditional = data.robotsTxt.crawlers.filter((c) => !c.allowed && TRADITIONAL_SEARCH_BOTS.has(c.bot));
    const blockedTraining = data.robotsTxt.crawlers.filter((c) => !c.allowed && TRAINING_BOTS.has(c.bot));

    if (blockedTraditional.length > 0) {
      findings.push({
        id: 'traditional_search_bots_blocked',
        severity: 'critical',
        category: 'robots',
        title: `Traditional search crawler(s) blocked: ${blockedTraditional.map((c) => c.bot).join(', ')}`,
        detail: blockedTraditional.map((c) => `${c.bot} (${c.rule ?? 'blocked'} in group ${c.matchedGroup})`).join('; '),
      });
    }
    if (blockedSearchAi.length > 0) {
      findings.push({
        id: 'ai_search_bots_blocked',
        severity: 'critical',
        category: 'robots',
        title: `AI search/retrieval crawler(s) blocked: ${blockedSearchAi.map((c) => c.bot).join(', ')}`,
        detail: blockedSearchAi.map((c) => `${c.bot} (${c.rule ?? 'blocked'} in group ${c.matchedGroup})`).join('; '),
      });
    }
    if (blockedTraining.length > 0) {
      findings.push({
        id: 'ai_training_bots_blocked',
        severity: 'info',
        category: 'robots',
        title: `AI training crawler(s) blocked: ${blockedTraining.map((c) => c.bot).join(', ')}`,
        detail: blockedTraining.map((c) => `${c.bot} (${c.rule ?? 'blocked'} in group ${c.matchedGroup})`).join('; '),
      });
    }
  }

  // Payload & truncation cliff findings
  if (data.payload.truncationRisks.contentStartsAfter30KB) {
    findings.push({
      id: 'truncation_content_after_30kb',
      severity: 'warning',
      category: 'payload',
      title: 'Primary content starts after 30 KB in raw HTML',
      detail: `First H1 (${formatBytesOpt(data.payload.offsets.firstH1Bytes)}) / first substantive paragraph (${formatBytesOpt(data.payload.offsets.firstSubstantiveParagraphBytes)}) appears past 30 KB due to head bloat or inline scripts/styles.`,
    });
  }
  if (data.payload.truncationRisks.coreContentPast100KB) {
    findings.push({
      id: 'truncation_core_past_100kb',
      severity: 'warning',
      category: 'payload',
      title: 'Core visible content extends past 100 KB',
      detail: `50% visible text offset is ${formatBytesOpt(data.payload.offsets.text50PctBytes)}; fetchers with tight byte budgets may truncate before core product facts.`,
    });
  }
  if (data.payload.truncationRisks.pageExceeds300KB) {
    findings.push({
      id: 'truncation_page_over_300kb',
      severity: 'warning',
      category: 'payload',
      title: `Raw HTML exceeds 300 KB (${formatBytes(data.payload.htmlBytes)})`,
      detail: 'Large raw HTML documents increase truncation risk in lightweight AI retrieval pipelines.',
    });
  }

  // CSR empty-shell findings
  if (data.payload.csrRisk.level === 'high') {
    findings.push({
      id: 'csr_empty_shell_high',
      severity: 'critical',
      category: 'csr',
      title: 'High client-side rendering (CSR) empty-shell risk',
      detail: data.payload.csrRisk.reasons.join('; ') || 'Minimal visible text in raw HTML with SPA bundle signals.',
    });
  } else if (data.payload.csrRisk.level === 'medium') {
    findings.push({
      id: 'csr_empty_shell_medium',
      severity: 'warning',
      category: 'csr',
      title: 'Medium client-side rendering (CSR) risk',
      detail: data.payload.csrRisk.reasons.join('; ') || 'Raw HTML contains sparse text relative to script footprint.',
    });
  }

  if (data.status !== null && data.status >= 200 && data.status < 300) {
    if (!data.meta.title) {
      findings.push({
        id: 'missing_title',
        severity: 'warning',
        category: 'indexing',
        title: 'Missing <title> element',
        detail: 'No non-empty <title> tag was found in the raw HTML.',
      });
    }
    if (data.payload.offsets.firstH1Bytes === null && data.payload.visibleWordCount > 0) {
      findings.push({
        id: 'missing_h1',
        severity: 'warning',
        category: 'payload',
        title: 'Missing <h1> heading in raw HTML',
        detail: 'No <h1> element was found in the initial HTML payload.',
      });
    }
  }

  // Browser diff findings
  if (data.browserDiff.status === 'ok' && data.browserDiff.hydrationGap === 'high') {
    findings.push({
      id: 'browser_hydration_gap_high',
      severity: 'critical',
      category: 'browser',
      title: 'Large raw-HTML vs rendered-DOM gap',
      detail: `Headless browser rendered ${data.browserDiff.renderedWordCount} words vs ${data.browserDiff.rawWordCount} in raw HTML (+${data.browserDiff.addedWordCount} words added by JS).`,
    });
  } else if (data.browserDiff.status === 'unavailable') {
    findings.push({
      id: 'browser_diff_unavailable',
      severity: 'info',
      category: 'browser',
      title: 'Headless browser DOM diff unavailable',
      detail: data.browserDiff.reason ?? 'No local Chromium/Chrome or Playwright found.',
    });
  }

  if (data.headers.cdnDetected) {
    findings.push({
      id: 'cdn_waf_detected',
      severity: 'info',
      category: 'headers',
      title: `CDN/WAF detected (${data.headers.cdnDetected})`,
      detail: 'Verify IP/rDNS-authenticated AI crawler traffic directly in your CDN/origin logs.',
    });
  }

  return findings;
}

/**
 * Run a zero-key technical pre-flight audit on `rawUrl`.
 *
 * @param {string} rawUrl
 * @param {CheckSiteOptions} [options]
 * @returns {Promise<SiteCheckReport>}
 */
export async function checkSite(rawUrl, options = {}) {
  const startedAt = Date.now();
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxRedirects =
    typeof options.maxRedirects === 'number' && Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0
      ? options.maxRedirects
      : DEFAULT_MAX_REDIRECTS;
  const maxHtmlBytes =
    typeof options.maxHtmlBytes === 'number' && Number.isFinite(options.maxHtmlBytes) && options.maxHtmlBytes > 0
      ? options.maxHtmlBytes
      : DEFAULT_MAX_HTML_BYTES;
  const allowPrivateHosts = options.allowPrivateHosts === true;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const lookupFn = options.lookup ?? (options.fetch ? null : dnsLookup);

  const initialParsed = validateSiteUrl(rawUrl);
  await assertSafeUrl(initialParsed, { allowPrivateHosts, lookupFn });

  const requestedUrl = initialParsed.href;
  let currentUrl = requestedUrl;
  /** @type {Set<string>} */
  const visited = new Set([currentUrl]);
  /** @type {RedirectHop[]} */
  const hops = [];
  let loopDetected = false;
  /** @type {string|null} */
  let loopTarget = null;
  let maxHopsExceeded = false;

  /** @type {Response|null} */
  let finalResponse = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const hopParsed = validateSiteUrl(currentUrl);
    await assertSafeUrl(hopParsed, { allowPrivateHosts, lookupFn });

    /** @type {Response} */
    let res;
    try {
      res = await fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
        signal: buildSignal(timeoutMs, options.signal),
      });
    } catch (error) {
      if (error instanceof SiteCheckError) throw error;
      const errName = error instanceof Error ? error.name : '';
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new SiteCheckError('timeout', `Request to ${currentUrl} timed out after ${timeoutMs}ms`);
      }
      throw new SiteCheckError('fetch_failed', `Failed to fetch ${currentUrl}: ${errMsg}`);
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (location) {
        /** @type {URL} */
        let nextParsed;
        try {
          nextParsed = validateSiteUrl(new URL(location, currentUrl).href);
        } catch (err) {
          await res.body?.cancel().catch(() => {});
          throw err;
        }
        await assertSafeUrl(nextParsed, { allowPrivateHosts, lookupFn }).catch(async (err) => {
          await res.body?.cancel().catch(() => {});
          throw err;
        });

        const crossHost = nextParsed.hostname.toLowerCase() !== hopParsed.hostname.toLowerCase();
        const geoLikely = detectGeoLikely(hopParsed, nextParsed, res.headers);
        await res.body?.cancel().catch(() => {});

        if (visited.has(nextParsed.href)) {
          hops.push({
            status: res.status,
            url: currentUrl,
            location,
            resolvedUrl: nextParsed.href,
            crossHost,
            geoLikely,
          });
          loopDetected = true;
          loopTarget = nextParsed.href;
          finalResponse = res;
          break;
        }
        if (hops.length >= maxRedirects) {
          maxHopsExceeded = true;
          finalResponse = res;
          break;
        }
        hops.push({
          status: res.status,
          url: currentUrl,
          location,
          resolvedUrl: nextParsed.href,
          crossHost,
          geoLikely,
        });
        visited.add(nextParsed.href);
        currentUrl = nextParsed.href;
        continue;
      }
    }

    finalResponse = res;
    break;
  }

  const finalUrl = currentUrl;
  const status = finalResponse ? finalResponse.status : null;

  const headersObj = {
    xRobotsTag: finalResponse?.headers.get('x-robots-tag') ?? null,
    contentType: finalResponse?.headers.get('content-type') ?? null,
    cacheControl: finalResponse?.headers.get('cache-control') ?? null,
    server: finalResponse?.headers.get('server') ?? null,
    cfRay: finalResponse?.headers.get('cf-ray') ?? null,
    vary: finalResponse?.headers.get('vary') ?? null,
    cdnDetected: finalResponse ? detectCdn(finalResponse.headers) : null,
  };

  let htmlString = '';
  let htmlByteLength = 0;
  if (finalResponse && !loopDetected && !maxHopsExceeded) {
    const { buffer } = await readBodyCapped(finalResponse, maxHtmlBytes);
    htmlByteLength = buffer.byteLength;
    htmlString = buffer.toString('utf8');
  }

  const payload = analyzeHtmlPayload(htmlString, htmlByteLength);

  // Resolve canonical URL relative to finalUrl
  /** @type {string|null} */
  let canonicalResolved = null;
  /** @type {boolean|null} */
  let canonicalMatchesFinal = null;
  if (payload.meta.canonical) {
    try {
      const resolvedCanonical = new URL(payload.meta.canonical, finalUrl);
      canonicalResolved = resolvedCanonical.href;
      const normFinal = new URL(finalUrl);
      normFinal.hash = '';
      resolvedCanonical.hash = '';
      canonicalMatchesFinal = resolvedCanonical.href === normFinal.href;
    } catch {
      canonicalResolved = null;
      canonicalMatchesFinal = false;
    }
  }

  /** @type {string[]} */
  const noindexSources = [];
  if (hasRobotsDirective(headersObj.xRobotsTag, 'noindex')) noindexSources.push('x-robots-tag');
  if (hasRobotsDirective(payload.meta.robots, 'noindex')) noindexSources.push('meta[name="robots"]');
  if (hasRobotsDirective(payload.meta.googlebot, 'noindex')) noindexSources.push('meta[name="googlebot"]');

  const nofollow =
    hasRobotsDirective(headersObj.xRobotsTag, 'nofollow') ||
    hasRobotsDirective(payload.meta.robots, 'nofollow') ||
    hasRobotsDirective(payload.meta.googlebot, 'nofollow');

  const meta = {
    title: payload.meta.title,
    description: payload.meta.description,
    robots: payload.meta.robots,
    googlebot: payload.meta.googlebot,
    canonical: payload.meta.canonical,
    canonicalResolved,
    canonicalMatchesFinal,
    noindex: noindexSources.length > 0,
    nofollow,
    noindexSources,
  };

  const robotsTxt = await fetchAndEvaluateRobots(finalUrl, {
    fetchFn,
    timeoutMs,
    allowPrivateHosts,
    lookupFn,
    signal: options.signal,
  });

  /** @type {BrowserDiffResult} */
  let browserDiff;
  if (options.browser === true) {
    if (!loopDetected && !maxHopsExceeded && status !== null && status >= 200 && status < 400) {
      browserDiff = await runBrowserDiff(finalUrl, payload, {
        timeoutMs: options.browserTimeoutMs ?? Math.max(timeoutMs, 15_000),
        browserBinary: options.browserBinary,
        browserRunner: options.browserRunner,
      });
    } else {
      browserDiff = {
        status: 'skipped',
        reason: 'Skipped headless browser render because initial HTTP fetch did not succeed.',
      };
    }
  } else {
    browserDiff = {
      status: 'skipped',
      reason: 'Pass --browser (or options.browser = true) to compare raw HTML against headless rendered DOM.',
    };
  }

  const redirects = {
    count: hops.length,
    hops,
    finalUrl,
    loopDetected,
    loopTarget,
    maxHopsExceeded,
    crossHost: hops.some((h) => h.crossHost),
    geoLikely: hops.some((h) => h.geoLikely),
  };

  const findings = buildFindings({
    status,
    redirects,
    headers: headersObj,
    meta,
    robotsTxt,
    payload,
    browserDiff,
  });

  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;
  /** @type {'pass'|'warn'|'fail'} */
  const grade = criticalCount > 0 ? 'fail' : warningCount > 0 ? 'warn' : 'pass';

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    userAgent: USER_AGENT,
    requestedUrl,
    finalUrl,
    status,
    ok: status !== null && status >= 200 && status < 400 && !loopDetected && !maxHopsExceeded,
    timingMs: Date.now() - startedAt,
    redirects,
    headers: headersObj,
    meta,
    robotsTxt,
    payload,
    browserDiff,
    findings,
    summary: {
      grade,
      criticalCount,
      warningCount,
      infoCount,
    },
    disclaimers: buildDisclaimers(headersObj.cdnDetected),
  };
}

/**
 * Format a byte count into a human-readable KB/B string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB (${bytes} B)`;
}

/**
 * Format an optional byte offset.
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
function formatBytesOpt(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  return formatBytes(bytes);
}

/**
 * Format a 0..1 ratio as a percentage string.
 * @param {number} ratio
 * @returns {string}
 */
function formatPct(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Render a crisp, readable terminal text report for a `SiteCheckReport`.
 * @param {SiteCheckReport} report
 * @returns {string}
 */
export function renderSiteCheckText(report) {
  /** @type {string[]} */
  const lines = [];
  const gradeLabel = report.summary.grade.toUpperCase();

  lines.push('Hearsay Site Pre-Flight Check');
  lines.push('='.repeat(60));
  lines.push(`Grade:         ${gradeLabel} (${report.summary.criticalCount} critical, ${report.summary.warningCount} warning, ${report.summary.infoCount} info)`);
  lines.push(`Requested URL: ${report.requestedUrl}`);
  lines.push(`Final URL:     ${report.finalUrl}`);
  lines.push(`HTTP Status:   ${report.status ?? '—'}  (${report.timingMs} ms)`);
  lines.push(`User-Agent:    ${report.userAgent}`);
  lines.push('');

  lines.push('Findings');
  lines.push('-'.repeat(60));
  if (report.findings.length === 0) {
    lines.push('  [PASS] No crawlability, indexing, truncation, or CSR issues detected.');
  } else {
    for (const f of report.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.title}`);
      lines.push(`      ${f.detail}`);
    }
  }
  lines.push('');

  lines.push(`Redirects (${report.redirects.count} hop${report.redirects.count === 1 ? '' : 's'})`);
  lines.push('-'.repeat(60));
  if (report.redirects.hops.length === 0) {
    lines.push('  Direct response (no redirects).');
  } else {
    for (const [idx, hop] of report.redirects.hops.entries()) {
      /** @type {string[]} */
      const flags = [];
      if (hop.crossHost) flags.push('cross-host');
      if (hop.geoLikely) flags.push('geo-likely');
      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      lines.push(`  ${idx + 1}. ${hop.status} ${hop.url} -> ${hop.location}${flagStr}`);
    }
    if (report.redirects.loopDetected) {
      lines.push(`  ! Loop detected targeting ${report.redirects.loopTarget}`);
    }
    if (report.redirects.maxHopsExceeded) {
      lines.push('  ! Maximum redirect hop limit exceeded');
    }
  }
  lines.push('');

  lines.push('Headers & Metadata Signals');
  lines.push('-'.repeat(60));
  lines.push(`  Title:            ${report.meta.title ?? '—'}`);
  lines.push(`  Description:      ${report.meta.description ?? '—'}`);
  lines.push(`  Canonical:        ${report.meta.canonical ?? '—'}${report.meta.canonicalMatchesFinal === false ? ' (MISMATCH)' : ''}`);
  lines.push(`  Noindex:          ${report.meta.noindex ? `YES (${report.meta.noindexSources.join(', ')})` : 'no'}`);
  lines.push(`  X-Robots-Tag:     ${report.headers.xRobotsTag ?? '—'}`);
  lines.push(`  Meta Robots:      ${report.meta.robots ?? '—'}`);
  lines.push(`  Meta Googlebot:   ${report.meta.googlebot ?? '—'}`);
  lines.push(`  Content-Type:     ${report.headers.contentType ?? '—'}`);
  lines.push(`  Cache-Control:    ${report.headers.cacheControl ?? '—'}`);
  lines.push(`  Server / CF-Ray:  ${report.headers.server ?? '—'} / ${report.headers.cfRay ?? '—'}`);
  lines.push(`  Vary:             ${report.headers.vary ?? '—'}`);
  lines.push('');

  lines.push(`robots.txt (${report.robotsTxt.url} — HTTP ${report.robotsTxt.status ?? 'ERR'})`);
  lines.push('-'.repeat(60));
  if (report.robotsTxt.error) {
    lines.push(`  Error: ${report.robotsTxt.error}`);
  }
  for (const c of report.robotsTxt.crawlers) {
    const botCol = c.bot.padEnd(18);
    const statusCol = c.status.padEnd(16);
    const groupCol = (c.matchedGroup ?? 'none').padEnd(16);
    lines.push(`  ${botCol} ${statusCol} group=${groupCol} rule=${c.rule ?? '—'}`);
  }
  lines.push('');

  lines.push('Raw HTML Payload & Byte-Offset Truncation Analysis');
  lines.push('-'.repeat(60));
  const p = report.payload;
  lines.push(`  Raw HTML Size:        ${formatBytes(p.htmlBytes)}`);
  lines.push(`  Scripts / Styles:     ${formatBytes(p.scriptBytes)} (${formatPct(p.scriptRatio)}) / ${formatBytes(p.styleBytes)} (${formatPct(p.styleRatio)})`);
  lines.push(`  Visible Words:        ${p.visibleWordCount}  (${formatBytes(p.visibleTextBytes)} visible text)`);
  lines.push(`  Structure:            ${p.headingCount} headings (h1-h3), ${p.tableCount} tables, ${p.jsonLdCount} JSON-LD block(s)`);
  lines.push(`  First <h1> Offset:    ${formatBytesOpt(p.offsets.firstH1Bytes)}`);
  lines.push(`  First >=80c Para:     ${formatBytesOpt(p.offsets.firstSubstantiveParagraphBytes)}`);
  lines.push(`  Text 25%/50%/75%/90%: ${formatBytesOpt(p.offsets.text25PctBytes)} / ${formatBytesOpt(p.offsets.text50PctBytes)} / ${formatBytesOpt(p.offsets.text75PctBytes)} / ${formatBytesOpt(p.offsets.text90PctBytes)}`);
  lines.push(
    `  Truncation Cliffs:    >30KB start=${p.truncationRisks.contentStartsAfter30KB ? 'YES' : 'no'}, ` +
    `>100KB core=${p.truncationRisks.coreContentPast100KB ? 'YES' : 'no'}, ` +
    `>300KB page=${p.truncationRisks.pageExceeds300KB ? 'YES' : 'no'}`,
  );
  lines.push(`  CSR Empty-Shell Risk: ${p.csrRisk.level.toUpperCase()}${p.csrRisk.spaRoots.length ? ` (roots: ${p.csrRisk.spaRoots.join(', ')})` : ''}`);
  for (const reason of p.csrRisk.reasons) {
    lines.push(`      - ${reason}`);
  }
  lines.push('');

  lines.push('Browser DOM Diff');
  lines.push('-'.repeat(60));
  if (report.browserDiff.status === 'ok') {
    lines.push(`  Engine:           ${report.browserDiff.engine ?? 'browser'}`);
    lines.push(`  Raw vs Rendered:  ${report.browserDiff.rawWordCount} -> ${report.browserDiff.renderedWordCount} words (+${report.browserDiff.addedWordCount}, gap=${report.browserDiff.hydrationGap})`);
  } else {
    lines.push(`  Status: ${report.browserDiff.status} — ${report.browserDiff.reason ?? 'not run'}`);
  }
  lines.push('');

  lines.push('Epistemic Disclaimers');
  lines.push('-'.repeat(60));
  for (const note of report.disclaimers) {
    lines.push(`  * ${note}`);
  }

  return lines.join('\n');
}

/**
 * Render an external link safely (only http:/https:, fully HTML-escaped).
 * @param {string|null|undefined} rawUrl
 * @returns {string}
 */
function renderSafeLink(rawUrl) {
  if (!rawUrl) return '<span class="muted">—</span>';
  const safe = safeHttpUrl(rawUrl);
  if (!safe) return `<code>${escapeHtml(rawUrl)}</code>`;
  return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${escapeHtml(rawUrl)}</a>`;
}

/**
 * Render a self-contained, printable HTML5 audit report with strict HTML escaping.
 * Zero external network assets, zero inline scripts.
 *
 * @param {SiteCheckReport} report
 * @returns {string}
 */
export function renderSiteCheckHtml(report) {
  const grade = report.summary.grade;
  const gradeClass = grade === 'fail' ? 'badge-fail' : grade === 'warn' ? 'badge-warn' : 'badge-pass';

  const findingsHtml =
    report.findings.length === 0
      ? '<p class="muted">No crawlability, indexing, truncation, or CSR issues detected.</p>'
      : `<ul class="findings">${report.findings
          .map(
            (f) =>
              `<li class="finding finding-${escapeHtml(f.severity)}">` +
              `<span class="badge badge-${escapeHtml(f.severity)}">${escapeHtml(f.severity.toUpperCase())}</span> ` +
              `<strong>${escapeHtml(f.title)}</strong>` +
              `<div class="finding-detail">${escapeHtml(f.detail)}</div>` +
              `</li>`,
          )
          .join('')}</ul>`;

  const redirectsHtml =
    report.redirects.hops.length === 0
      ? '<p class="muted">Direct response (0 redirect hops).</p>'
      : `<table><thead><tr><th>#</th><th>Status</th><th>From</th><th>Location</th><th>Flags</th></tr></thead><tbody>${report.redirects.hops
          .map((hop, idx) => {
            /** @type {string[]} */
            const flags = [];
            if (hop.crossHost) flags.push('cross-host');
            if (hop.geoLikely) flags.push('geo-likely');
            return (
              `<tr>` +
              `<td>${idx + 1}</td>` +
              `<td><code>${escapeHtml(hop.status)}</code></td>` +
              `<td>${renderSafeLink(hop.url)}</td>` +
              `<td><code>${escapeHtml(hop.location)}</code></td>` +
              `<td>${flags.length ? escapeHtml(flags.join(', ')) : '<span class="muted">—</span>'}</td>` +
              `</tr>`
            );
          })
          .join('')}</tbody></table>`;

  const crawlersHtml = `<table><thead><tr><th>Crawler</th><th>Status</th><th>Matched Group</th><th>Winning Rule</th></tr></thead><tbody>${report.robotsTxt.crawlers
    .map((c) => {
      const cls = c.allowed ? 'badge-pass' : 'badge-fail';
      return (
        `<tr>` +
        `<td><code>${escapeHtml(c.bot)}</code></td>` +
        `<td><span class="badge ${cls}">${escapeHtml(c.status)}</span></td>` +
        `<td><code>${escapeHtml(c.matchedGroup ?? '—')}</code></td>` +
        `<td><code>${escapeHtml(c.rule ?? '—')}</code></td>` +
        `</tr>`
      );
    })
    .join('')}</tbody></table>`;

  const headingsHtml =
    report.payload.headings.length === 0
      ? '<p class="muted">No h1–h3 headings found in raw HTML.</p>'
      : `<table><thead><tr><th>Tag</th><th>Heading Text</th><th>Raw Byte Offset</th></tr></thead><tbody>${report.payload.headings
          .slice(0, 25)
          .map(
            (h) =>
              `<tr>` +
              `<td><code>h${escapeHtml(h.level)}</code></td>` +
              `<td>${escapeHtml(h.text)}</td>` +
              `<td><code>${escapeHtml(formatBytes(h.byteOffset))}</code></td>` +
              `</tr>`,
          )
          .join('')}</tbody></table>`;

  const browserHtml =
    report.browserDiff.status === 'ok'
      ? `<dl class="kv">` +
        `<dt>Engine</dt><dd><code>${escapeHtml(report.browserDiff.engine ?? 'browser')}</code></dd>` +
        `<dt>Raw vs Rendered Words</dt><dd>${escapeHtml(report.browserDiff.rawWordCount)} &rarr; ${escapeHtml(report.browserDiff.renderedWordCount)} (+${escapeHtml(report.browserDiff.addedWordCount)})</dd>` +
        `<dt>Hydration Gap</dt><dd><strong>${escapeHtml(report.browserDiff.hydrationGap ?? 'none')}</strong></dd>` +
        `<dt>Rendered Title</dt><dd>${escapeHtml(report.browserDiff.renderedTitle ?? '—')}</dd>` +
        `</dl>`
      : `<p class="muted"><strong>${escapeHtml(report.browserDiff.status)}</strong>: ${escapeHtml(report.browserDiff.reason ?? 'not run')}</p>`;

  const disclaimersHtml = `<ul class="disclaimers">${report.disclaimers
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join('')}</ul>`;

  const p = report.payload;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hearsay Pre-Flight Check — ${escapeHtml(report.finalUrl)}</title>
<style>
  :root { color-scheme: light; --bg: #ffffff; --fg: #111827; --muted: #6b7280; --border: #e5e7eb; --card: #f9fafb; --pass: #065f46; --pass-bg: #d1fae5; --warn: #92400e; --warn-bg: #fef3c7; --fail: #991b1b; --fail-bg: #fee2e2; --info: #1e40af; --info-bg: #dbeafe; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; max-width: 1024px; margin-inline: auto; }
  h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
  h2 { margin: 2rem 0 0.75rem; font-size: 1.15rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 4px; word-break: break-word; }
  a { color: #1d4ed8; word-break: break-all; }
  .muted { color: var(--muted); }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; padding-bottom: 1rem; border-bottom: 2px solid var(--fg); }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.03em; }
  .badge-pass { background: var(--pass-bg); color: var(--pass); }
  .badge-warn, .badge-warning { background: var(--warn-bg); color: var(--warn); }
  .badge-fail, .badge-critical { background: var(--fail-bg); color: var(--fail); }
  .badge-info { background: var(--info-bg); color: var(--info); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem 1rem; }
  .card-label { font-size: 0.75rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.04em; }
  .card-value { font-size: 1.25rem; font-weight: 700; margin-top: 0.2rem; }
  .kv { display: grid; grid-template-columns: minmax(160px, 220px) 1fr; gap: 0.35rem 1rem; margin: 0.5rem 0; }
  .kv dt { font-weight: 600; color: var(--muted); }
  .kv dd { margin: 0; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { background: var(--card); font-weight: 600; }
  .findings { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.6rem; }
  .finding { border: 1px solid var(--border); border-radius: 6px; padding: 0.65rem 0.85rem; background: var(--card); }
  .finding-detail { margin-top: 0.25rem; font-size: 0.9rem; color: #374151; }
  .disclaimers { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 1rem 1.25rem 1rem 2rem; font-size: 0.9rem; }
  .disclaimers li { margin-bottom: 0.4rem; }
  @media print {
    body { padding: 0; max-width: none; font-size: 11pt; }
    .card, .finding, .disclaimers { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <header class="header">
    <div>
      <h1>Hearsay Site Pre-Flight Audit</h1>
      <div class="muted">Checked ${escapeHtml(report.checkedAt)} &middot; ${escapeHtml(report.timingMs)} ms &middot; UA: <code>${escapeHtml(report.userAgent)}</code></div>
    </div>
    <div><span class="badge ${gradeClass}">${escapeHtml(grade.toUpperCase())}</span></div>
  </header>

  <section class="grid">
    <div class="card"><div class="card-label">HTTP Status</div><div class="card-value">${escapeHtml(report.status ?? '—')}</div></div>
    <div class="card"><div class="card-label">Raw HTML Size</div><div class="card-value">${escapeHtml(formatBytes(p.htmlBytes))}</div></div>
    <div class="card"><div class="card-label">Visible Words (Raw)</div><div class="card-value">${escapeHtml(p.visibleWordCount)}</div></div>
    <div class="card"><div class="card-label">CSR Empty-Shell Risk</div><div class="card-value">${escapeHtml(p.csrRisk.level.toUpperCase())}</div></div>
    <div class="card"><div class="card-label">AI Crawlers Allowed</div><div class="card-value">${escapeHtml(report.robotsTxt.allowedCount)} / ${escapeHtml(report.robotsTxt.crawlers.length)}</div></div>
  </section>

  <h2>Findings</h2>
  ${findingsHtml}

  <h2>Target &amp; Response Signals</h2>
  <dl class="kv">
    <dt>Requested URL</dt><dd>${renderSafeLink(report.requestedUrl)}</dd>
    <dt>Final URL</dt><dd>${renderSafeLink(report.finalUrl)}</dd>
    <dt>Title</dt><dd>${escapeHtml(report.meta.title ?? '—')}</dd>
    <dt>Description</dt><dd>${escapeHtml(report.meta.description ?? '—')}</dd>
    <dt>Canonical</dt><dd>${renderSafeLink(report.meta.canonical)}${report.meta.canonicalMatchesFinal === false ? ' <span class="badge badge-warn">MISMATCH</span>' : ''}</dd>
    <dt>Noindex</dt><dd>${report.meta.noindex ? `<span class="badge badge-fail">YES</span> (${escapeHtml(report.meta.noindexSources.join(', '))})` : 'No'}</dd>
    <dt>X-Robots-Tag</dt><dd><code>${escapeHtml(report.headers.xRobotsTag ?? '—')}</code></dd>
    <dt>Meta Robots</dt><dd><code>${escapeHtml(report.meta.robots ?? '—')}</code></dd>
    <dt>Meta Googlebot</dt><dd><code>${escapeHtml(report.meta.googlebot ?? '—')}</code></dd>
    <dt>Content-Type</dt><dd><code>${escapeHtml(report.headers.contentType ?? '—')}</code></dd>
    <dt>Cache-Control</dt><dd><code>${escapeHtml(report.headers.cacheControl ?? '—')}</code></dd>
    <dt>Server</dt><dd><code>${escapeHtml(report.headers.server ?? '—')}</code></dd>
    <dt>CF-Ray</dt><dd><code>${escapeHtml(report.headers.cfRay ?? '—')}</code></dd>
    <dt>Vary</dt><dd><code>${escapeHtml(report.headers.vary ?? '—')}</code></dd>
  </dl>

  <h2>Redirect Chain (${escapeHtml(report.redirects.count)} hop${report.redirects.count === 1 ? '' : 's'})</h2>
  ${redirectsHtml}

  <h2>AI &amp; Search Crawler Access (robots.txt RFC 9309)</h2>
  <p class="muted">Source: ${renderSafeLink(report.robotsTxt.url)} &middot; HTTP ${escapeHtml(report.robotsTxt.status ?? 'ERR')}${report.robotsTxt.error ? ` &middot; ${escapeHtml(report.robotsTxt.error)}` : ''}</p>
  ${crawlersHtml}

  <h2>Byte-Offset Truncation &amp; Payload Analysis</h2>
  <dl class="kv">
    <dt>Raw HTML Bytes</dt><dd><code>${escapeHtml(formatBytes(p.htmlBytes))}</code></dd>
    <dt>Script Bytes / Ratio</dt><dd><code>${escapeHtml(formatBytes(p.scriptBytes))}</code> (${escapeHtml(formatPct(p.scriptRatio))})</dd>
    <dt>Style Bytes / Ratio</dt><dd><code>${escapeHtml(formatBytes(p.styleBytes))}</code> (${escapeHtml(formatPct(p.styleRatio))})</dd>
    <dt>Structure</dt><dd>${escapeHtml(p.headingCount)} headings (h1–h3), ${escapeHtml(p.tableCount)} table(s), ${escapeHtml(p.jsonLdCount)} JSON-LD block(s)${p.jsonLdTypes.length ? ` (${escapeHtml(p.jsonLdTypes.join(', '))})` : ''}</dd>
    <dt>First &lt;h1&gt; Offset</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.firstH1Bytes))}</code></dd>
    <dt>First &ge;80c Paragraph</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.firstSubstantiveParagraphBytes))}</code></dd>
    <dt>Visible Text 25%</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.text25PctBytes))}</code></dd>
    <dt>Visible Text 50%</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.text50PctBytes))}</code></dd>
    <dt>Visible Text 75%</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.text75PctBytes))}</code></dd>
    <dt>Visible Text 90%</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.text90PctBytes))}</code></dd>
    <dt>Truncation Risks</dt><dd>Starts &gt;30KB: <strong>${p.truncationRisks.contentStartsAfter30KB ? 'YES' : 'no'}</strong> &middot; Core &gt;100KB: <strong>${p.truncationRisks.coreContentPast100KB ? 'YES' : 'no'}</strong> &middot; Page &gt;300KB: <strong>${p.truncationRisks.pageExceeds300KB ? 'YES' : 'no'}</strong></dd>
    <dt>CSR Empty-Shell Risk</dt><dd><strong>${escapeHtml(p.csrRisk.level.toUpperCase())}</strong>${p.csrRisk.spaRoots.length ? ` &middot; Roots: <code>${escapeHtml(p.csrRisk.spaRoots.join(', '))}</code>` : ''}</dd>
  </dl>
  ${headingsHtml}

  <h2>Headless Browser DOM Diff</h2>
  ${browserHtml}

  <h2>Epistemic Disclaimers</h2>
  ${disclaimersHtml}
</body>
</html>
`;
}
