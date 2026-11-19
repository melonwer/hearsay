/**
 * Zero-key technical pre-flight audit (`hearsay check <url>`).
 *
 * Uses Node 22 built-ins plus the allowlisted 2-package pure-JS extraction
 * stack (`webforai` + `diff`, with built-in zero-dep fallback in `core/extract.js`).
 * Never spoofs AI crawler User-Agents; reports honest raw-HTML, robots.txt
 * (RFC 9309 + 18-bot registry + Cloudflare Managed Content / Content-Signal),
 * redirect-chain, header/meta, stack/CDN/WAF fingerprinting, extraction forensics,
 * byte-offset truncation, Edge Markdown negotiation, multi-page template clustering,
 * Competitor X-Ray (`--vs`), baseline regression diffing, CI gating, and CSR
 * empty-shell signals with explicit epistemic disclaimers about IP/rDNS-gated
 * WAF/CDN rules.
 */

import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import { isIP } from 'node:net';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import {
  analyzeCachingHeaders,
  analyzeRobotsPolicy,
  detectStackAndWaf,
  probeDnsHints,
} from './tech-detect.js';
import { buildRemediationPlan } from './remediation.js';
import {
  analyzeExtractionForensics,
  diffBotVsHuman,
  extractBotMarkdown,
} from './extract.js';
import {
  DEFAULT_MAX_PAGES,
  clusterIssuesByTemplate,
  crawlSitePages,
  evaluateHardGate,
} from './site-crawler.js';
import {
  compareCompetitors,
  diffAgainstBaseline,
  evaluateCiGate,
} from './site-diff.js';

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
 * @property {'robots'|'indexing'|'redirects'|'payload'|'csr'|'browser'|'headers'|'waf'|'caching'|'sitemap'|'dns'} category
 * @property {string} title
 * @property {string} detail
 * @property {'site'|'template'|'page'} [scope]
 */

/**
 * @typedef {Object} MarkdownNegotiationResult
 * @property {boolean} probed
 * @property {boolean} supported
 * @property {number|null} status
 * @property {string|null} contentType
 * @property {string|null} vary
 * @property {boolean} varyHasAccept
 * @property {boolean} missingVaryAccept
 * @property {number|null} tokenCount
 * @property {number|null} wordCount
 * @property {number|null} charCount
 * @property {boolean} csrEmptyShellTrap
 * @property {string|null} markdown
 * @property {string|null} error
 */

/**
 * @typedef {Object} LlmsTxtProbeResult
 * @property {boolean} probed
 * @property {string} url
 * @property {number|null} status
 * @property {boolean} present
 * @property {string|null} contentType
 * @property {boolean} isHtmlFallback
 * @property {boolean} soft404
 * @property {string|null} error
 */

/**
 * @typedef {Object} SiteExtractionReport
 * @property {import('./extract.js').ExtractedMarkdownResult} extracted
 * @property {import('./extract.js').ExtractionForensicsResult} forensics
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
 *   crawlStatus?: 'pass'|'attention'|'critical'|'blocked_hard_gate',
 * }} summary
 * @property {string[]} disclaimers
 * @property {import('./tech-detect.js').StackAndWafResult} [stack]
 * @property {import('./tech-detect.js').WafAssessment} [waf]
 * @property {import('./tech-detect.js').RobotsPolicyResult} [robotsPolicy]
 * @property {import('./tech-detect.js').CachingAnalysisResult} [caching]
 * @property {import('./tech-detect.js').DnsHintsResult} [dnsHints]
 * @property {SiteExtractionReport} [extraction]
 * @property {MarkdownNegotiationResult} [markdownNegotiation]
 * @property {import('./extract.js').DiffBotVsHumanResult|null} [botVsHumanDiff]
 * @property {number|null} [proseParityPct]
 * @property {import('./remediation.js').RemediationPlan} [remediation]
 */

/**
 * @typedef {SiteCheckReport & {
 *   mode: 'single'|'multi',
 *   domain: string,
 *   crawlStatus: 'pass'|'attention'|'critical'|'blocked_hard_gate',
 *   downstreamStatus: 'observed'|'not_observed',
 *   hardGate: import('./site-crawler.js').HardGateResult,
 *   coverageComplete: boolean,
 *   scopeSummary: string,
 *   counts: import('./site-crawler.js').CrawlCounts,
 *   pages: Array<import('./site-crawler.js').CrawledPageResult & {
 *     meta?: SiteCheckReport['meta'],
 *     extraction?: SiteExtractionReport,
 *     caching?: import('./tech-detect.js').CachingAnalysisResult,
 *     stackResult?: import('./tech-detect.js').StackAndWafResult,
 *   }>,
 *   skipped: import('./site-crawler.js').SkippedPageEntry[],
 *   errored: import('./site-crawler.js').ErroredPageEntry[],
 *   redirectsResolved: Array<{from: string, to: string, status: number}>,
 *   sitemap: import('./site-crawler.js').SitemapDiscoveryResult|null,
 *   siteFindings: import('./site-crawler.js').PageFinding[],
 *   clusters: import('./site-crawler.js').TemplateClusterReport,
 *   conditionalCaching: import('./site-crawler.js').CachingCheckResult,
 *   throttle: {initialDelayMs: number, finalDelayMs: number, crawlDelayFloorMs: number, slowdowns: number, totalWaitMs: number},
 *   llmsTxt: LlmsTxtProbeResult|null,
 *   aiBotsAllowed: import('./site-diff.js').BotAllowanceSummary,
 *   competitorXray: import('./site-diff.js').CompetitorComparisonResult|null,
 *   baselineDiff: import('./site-diff.js').BaselineDiffResult|null,
 *   ciGate: import('./site-diff.js').CiGateResult,
 *   stack: import('./tech-detect.js').StackAndWafResult,
 *   waf: import('./tech-detect.js').WafAssessment,
 *   robotsPolicy: import('./tech-detect.js').RobotsPolicyResult,
 *   caching: import('./tech-detect.js').CachingAnalysisResult,
 *   dnsHints: import('./tech-detect.js').DnsHintsResult,
 *   extraction: SiteExtractionReport,
 *   markdownNegotiation: MarkdownNegotiationResult,
 *   botVsHumanDiff: import('./extract.js').DiffBotVsHumanResult|null,
 *   proseParityPct: number|null,
 *   remediation: import('./remediation.js').RemediationPlan,
 * }} SiteCheckV2Report
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
 * @property {((hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>)|null} [lookup]
 * @property {import('./tech-detect.js').DnsResolverLike} [dnsResolver]
 * @property {boolean} [skipMarkdownProbe]
 * @property {boolean} [forceFallback]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} SiteCheckProgressEvent
 * @property {'started'|'page'|'competitor'|'done'|'error'} type
 * @property {string} [url]
 * @property {string} [finalUrl]
 * @property {string} [template]
 * @property {number|null} [status]
 * @property {number} [audited]
 * @property {number} [maxPages]
 * @property {number} [index]
 * @property {number} [total]
 * @property {string} [message]
 */

/**
 * @typedef {CheckSiteOptions & {
 *   single?: boolean,
 *   maxPages?: number,
 *   maxPerTemplate?: number,
 *   maxConcurrency?: number,
 *   vs?: string[],
 *   checkCaching?: boolean,
 *   ignoreRobotsForOwnSite?: boolean,
 *   includeAuthRoutes?: boolean,
 *   failOn?: null|'critical'|'attention'|'warning',
 *   failOnCodes?: string[],
 *   ignoreCodes?: string[],
 *   baseline?: Record<string, any>|null,
 *   failOnRegression?: boolean,
 *   skipLlmsProbe?: boolean,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   onProgress?: (event: SiteCheckProgressEvent) => void,
 * }} CheckSiteV2Options
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
export function isBlockedHostLiteral(hostname) {
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
 * @returns {Promise<{diff: BrowserDiffResult, renderedHtml: string|null}>}
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

    // Fallback: probe Playwright in a subprocess so core/site-check.js keeps zero browser imports
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
        diff: {
          status: 'unavailable',
          reason: `Local headless browser check unavailable (${runtimeError.split('\n')[0]}).`,
        },
        renderedHtml: null,
      };
    }
    return {
      diff: {
        status: 'unavailable',
        reason: 'No local Chromium/Google Chrome binary or Playwright installation found.',
      },
      renderedHtml: null,
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
    diff: {
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
    },
    renderedHtml: rendered.html,
  };
}

/**
 * Fetch and evaluate `<origin>/robots.txt` for all 9 AI and search crawlers,
 * returning both the legacy `robotsTxt` structure and the raw text for 18-bot
 * `analyzeRobotsPolicy` enrichment.
 *
 * @param {string} finalUrl
 * @param {{
 *   fetchFn: typeof globalThis.fetch,
 *   timeoutMs: number,
 *   allowPrivateHosts: boolean,
 *   lookupFn: ((hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>)|null,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{robotsTxt: SiteCheckReport['robotsTxt'], rawText: string}>}
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
      robotsTxt: {
        url: robotsUrl,
        status: null,
        fetched: false,
        error: fetchError ?? 'Failed to fetch robots.txt',
        sitemaps: /** @type {string[]} */ ([]),
        crawlers,
        blockedCount: crawlers.length,
        allowedCount: 0,
      },
      rawText: '',
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
      robotsTxt: {
        url: robotsUrl,
        status: response.status,
        fetched: true,
        error: null,
        sitemaps,
        crawlers,
        blockedCount,
        allowedCount: crawlers.length - blockedCount,
      },
      rawText: robotsText,
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
      robotsTxt: {
        url: robotsUrl,
        status: response.status,
        fetched: false,
        error: null,
        sitemaps: /** @type {string[]} */ ([]),
        crawlers,
        blockedCount: 0,
        allowedCount: crawlers.length,
      },
      rawText: '',
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
    robotsTxt: {
      url: robotsUrl,
      status: response.status,
      fetched: false,
      error: `robots.txt returned HTTP ${response.status} (RFC 9309 treats 5xx as temporary disallow)`,
      sitemaps: /** @type {string[]} */ ([]),
      crawlers,
      blockedCount: crawlers.length,
      allowedCount: 0,
    },
    rawText: '',
  };
}

/**
 * Run non-throwing DNS OSINT hints, bypassing live DNS queries for bare IPs and
 * localhost targets unless an explicit `dnsResolver` was injected.
 *
 * @param {string} hostname
 * @param {{
 *   dnsResolver?: import('./tech-detect.js').DnsResolverLike,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {Promise<import('./tech-detect.js').DnsHintsResult>}
 */
async function probeDnsHintsSafe(hostname, opts = {}) {
  const cleanHost = stripHostBrackets(hostname).replace(/\.+$/, '');
  if (
    !opts.dnsResolver &&
    (!cleanHost || isIP(cleanHost) !== 0 || cleanHost === 'localhost' || cleanHost.endsWith('.localhost'))
  ) {
    return {
      hostname: cleanHost,
      cname: [],
      ns: [],
      txt: [],
      verificationTokens: { google: false, bing: false, apple: false, openai: false, other: [] },
      inferredEdge: [],
      errors: [],
      timedOut: false,
    };
  }
  return probeDnsHints(hostname, {
    resolver: opts.dnsResolver,
    timeoutMs: Math.min(opts.timeoutMs ?? 3000, 3000),
  });
}

/**
 * Send 1 extra GET with `Accept: text/markdown, text/html;q=0.9` on `finalUrl`
 * to detect Edge Markdown negotiation (`Content-Type: text/markdown`),
 * `x-markdown-tokens`, missing `Vary: Accept` cache-poisoning bugs, and the
 * Edge Markdown CSR Empty-Shell Trap.
 *
 * @param {string} finalUrl
 * @param {{
 *   fetchFn: typeof globalThis.fetch,
 *   timeoutMs: number,
 *   allowPrivateHosts: boolean,
 *   lookupFn: ((hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>)|null,
 *   rawPayload: PayloadAnalysis,
 *   rawExtracted: import('./extract.js').ExtractedMarkdownResult,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{result: MarkdownNegotiationResult, rawHeaders: Headers|null}>}
 */
async function probeMarkdownNegotiation(finalUrl, opts) {
  /** @type {MarkdownNegotiationResult} */
  const emptyResult = {
    probed: true,
    supported: false,
    status: null,
    contentType: null,
    vary: null,
    varyHasAccept: false,
    missingVaryAccept: false,
    tokenCount: null,
    wordCount: null,
    charCount: null,
    csrEmptyShellTrap: false,
    markdown: null,
    error: null,
  };

  let currentUrl = finalUrl;
  /** @type {Set<string>} */
  const visited = new Set([currentUrl]);
  /** @type {Response|null} */
  let response = null;

  try {
    for (let hop = 0; hop <= 3; hop++) {
      const parsedHop = validateSiteUrl(currentUrl);
      await assertSafeUrl(parsedHop, { allowPrivateHosts: opts.allowPrivateHosts, lookupFn: opts.lookupFn });
      const res = await opts.fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/markdown, text/html;q=0.9',
          'accept-language': 'en-US,en;q=0.9',
        },
        signal: buildSignal(opts.timeoutMs, opts.signal),
      });
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location || hop === 3) {
          response = res;
          break;
        }
        const nextUrl = new URL(location, currentUrl).href;
        if (visited.has(nextUrl)) {
          return { result: { ...emptyResult, error: 'redirect_loop' }, rawHeaders: null };
        }
        visited.add(nextUrl);
        currentUrl = nextUrl;
        continue;
      }
      response = res;
      break;
    }
  } catch (err) {
    return {
      result: { ...emptyResult, error: err instanceof Error ? err.message : String(err) },
      rawHeaders: null,
    };
  }

  if (!response) return { result: emptyResult, rawHeaders: null };

  const status = response.status;
  const contentType = response.headers.get('content-type');
  const vary = response.headers.get('vary');
  const varyTokens = (vary ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const varyHasAccept = varyTokens.includes('accept') || varyTokens.includes('*');

  const isMarkdown = status >= 200 && status < 300 && /^text\/markdown\b/i.test((contentType ?? '').trim());
  if (!isMarkdown) {
    await response.body?.cancel().catch(() => {});
    return {
      result: {
        ...emptyResult,
        status,
        contentType,
        vary,
        varyHasAccept,
      },
      rawHeaders: response.headers,
    };
  }

  const { buffer } = await readBodyCapped(response, 2 * 1024 * 1024);
  const markdown = buffer.toString('utf8').trim();
  const rawTokens = response.headers.get('x-markdown-tokens');
  const tokenCount = rawTokens !== null && /^\d+$/.test(rawTokens.trim())
    ? Number.parseInt(rawTokens.trim(), 10)
    : null;
  const wordCount = markdown ? markdown.split(/\s+/).filter(Boolean).length : 0;
  const charCount = markdown.length;
  const missingVaryAccept = !varyHasAccept;

  const sparseMarkdown = wordCount < 15 || (tokenCount !== null && tokenCount < 30);
  const csrSignals =
    opts.rawPayload.csrRisk.level === 'high' ||
    opts.rawPayload.csrRisk.spaRoots.length > 0 ||
    (opts.rawExtracted.wordCount >= 40 && wordCount < opts.rawExtracted.wordCount * 0.25);
  const csrEmptyShellTrap = sparseMarkdown && csrSignals;

  return {
    result: {
      probed: true,
      supported: true,
      status,
      contentType,
      vary,
      varyHasAccept,
      missingVaryAccept,
      tokenCount,
      wordCount,
      charCount,
      csrEmptyShellTrap,
      markdown,
      error: null,
    },
    rawHeaders: response.headers,
  };
}

/**
 * Probe `<origin>/llms.txt` to detect SPA catch-all / soft-404 HTML returned
 * with HTTP 200 instead of plain text or a real 404. Missing `/llms.txt` (404)
 * is never penalized.
 *
 * @param {string} origin
 * @param {{
 *   fetchFn: typeof globalThis.fetch,
 *   timeoutMs: number,
 *   allowPrivateHosts: boolean,
 *   lookupFn: ((hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>)|null,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<LlmsTxtProbeResult>}
 */
async function probeLlmsTxt(origin, opts) {
  const url = `${origin}/llms.txt`;
  /** @type {LlmsTxtProbeResult} */
  const base = {
    probed: true,
    url,
    status: null,
    present: false,
    contentType: null,
    isHtmlFallback: false,
    soft404: false,
    error: null,
  };

  let currentUrl = url;
  /** @type {Set<string>} */
  const visited = new Set([currentUrl]);
  /** @type {Response|null} */
  let response = null;

  try {
    for (let hop = 0; hop <= 3; hop++) {
      const parsedHop = validateSiteUrl(currentUrl);
      await assertSafeUrl(parsedHop, { allowPrivateHosts: opts.allowPrivateHosts, lookupFn: opts.lookupFn });
      const res = await opts.fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/plain, text/markdown, */*;q=0.5',
        },
        signal: buildSignal(opts.timeoutMs, opts.signal),
      });
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location || hop === 3) {
          response = res;
          break;
        }
        const nextUrl = new URL(location, currentUrl).href;
        if (visited.has(nextUrl)) {
          return { ...base, error: 'redirect_loop' };
        }
        visited.add(nextUrl);
        currentUrl = nextUrl;
        continue;
      }
      response = res;
      break;
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response) return base;
  const status = response.status;
  const contentType = response.headers.get('content-type');
  if (status < 200 || status >= 300) {
    await response.body?.cancel().catch(() => {});
    return { ...base, status, contentType };
  }

  const { buffer } = await readBodyCapped(response, 256 * 1024);
  const body = buffer.toString('utf8');
  const ctLower = (contentType ?? '').toLowerCase();
  const trimmedHead = body.trimStart().slice(0, 256).toLowerCase();
  const isHtmlFallback =
    ctLower.includes('text/html') ||
    ctLower.includes('application/xhtml+xml') ||
    trimmedHead.startsWith('<!doctype html') ||
    trimmedHead.startsWith('<html');

  if (!isHtmlFallback) {
    return {
      probed: true,
      url,
      status,
      present: body.trim().length > 0,
      contentType,
      isHtmlFallback: false,
      soft404: false,
      error: null,
    };
  }

  const probePayload = analyzeHtmlPayload(body, buffer.byteLength);
  const probeForensics = analyzeExtractionForensics(body, buffer.byteLength, { forceFallback: true });
  const soft404 =
    probeForensics.soft404.detected ||
    probePayload.csrRisk.level === 'high' ||
    probePayload.visibleWordCount < 25;

  return {
    probed: true,
    url,
    status,
    present: false,
    contentType,
    isHtmlFallback: true,
    soft404,
    error: null,
  };
}

/**
 * Resolve page-level metadata (`canonical`, `noindex`, `nofollow`) against `finalUrl`.
 *
 * @param {PayloadAnalysis} payload
 * @param {{xRobotsTag: string|null}} headersObj
 * @param {string} finalUrl
 * @returns {SiteCheckReport['meta']}
 */
function resolvePageMeta(payload, headersObj, finalUrl) {
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

  return {
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
}

/**
 * Build a `BotAllowanceSummary` from the 18-crawler `RobotsPolicyResult`
 * (excluding non-crawler `policy_signal` tokens like `Google-Extended`).
 * Per RFC 9309 §2.3.1.4, when `robots.txt` fails or returns HTTP 5xx,
 * crawlers treat access as temporary disallow (`allowed: 0`).
 *
 * @param {import('./tech-detect.js').RobotsPolicyResult} robotsPolicy
 * @param {{treatAllBlocked?: boolean}} [opts]
 * @returns {import('./site-diff.js').BotAllowanceSummary}
 */
function summarizeAiBotsFromPolicy(robotsPolicy, opts = {}) {
  const realCrawlers = robotsPolicy.bots.filter((b) => b.category !== 'policy_signal');
  const searchCrawlers = realCrawlers.filter(
    (b) => b.category === 'search_retrieval' || b.category === 'user_fetch' || b.category === 'mixed_search_ai',
  );
  if (opts.treatAllBlocked) {
    return {
      allowed: 0,
      total: realCrawlers.length,
      searchAllowed: 0,
      searchTotal: searchCrawlers.length,
      blockedBots: realCrawlers.map((b) => b.token),
    };
  }
  return {
    allowed: realCrawlers.filter((b) => b.allowed).length,
    total: realCrawlers.length,
    searchAllowed: searchCrawlers.filter((b) => b.allowed).length,
    searchTotal: searchCrawlers.length,
    blockedBots: realCrawlers.filter((b) => !b.allowed).map((b) => b.token),
  };
}

/**
 * Append deduplicated v2 forensic findings (WAF, 18-bot robots policy,
 * Cloudflare Managed Content / Content-Signal, Markdown negotiation,
 * extraction forensics, caching hygiene, Bot-vs-Human diff, `/llms.txt`).
 *
 * @param {SiteFinding[]} existingFindings
 * @param {{
 *   url?: string,
 *   status: number|null,
 *   waf?: import('./tech-detect.js').WafAssessment|null,
 *   robotsPolicy?: import('./tech-detect.js').RobotsPolicyResult|null,
 *   caching?: import('./tech-detect.js').CachingAnalysisResult|null,
 *   extraction?: SiteExtractionReport|null,
 *   markdownNegotiation?: MarkdownNegotiationResult|null,
 *   botVsHumanDiff?: import('./extract.js').DiffBotVsHumanResult|null,
 *   llmsTxt?: LlmsTxtProbeResult|null,
 *   payload?: PayloadAnalysis|null,
 *   includeSiteSignals?: boolean,
 * }} data
 * @returns {SiteFinding[]}
 */
function appendV2Findings(existingFindings, data) {
  /** @type {SiteFinding[]} */
  const out = [...existingFindings];
  /** @type {Set<string>} */
  const seen = new Set(out.map((f) => f.id));

  /** @param {SiteFinding} f */
  const push = (f) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    out.push(f);
  };

  const includeSite = data.includeSiteSignals !== false;

  // 1. Passive 3-tier WAF findings
  if (data.waf) {
    if (data.waf.state === 'challenge_or_block_intercepted') {
      const id = data.waf.vendor === 'cloudflare' ? 'cf_mitigated_challenge' : 'waf_challenge_intercepted';
      push({
        id,
        severity: 'critical',
        category: 'waf',
        title: `WAF/bot challenge intercepted response (${data.waf.vendor ?? 'edge'})`,
        detail: data.waf.evidence.join('; ') || 'Active challenge or block detected in HTTP response.',
        scope: 'page',
      });
    } else if (data.waf.state === 'bot_management_active') {
      push({
        id: 'waf_bot_management_active',
        severity: 'info',
        category: 'waf',
        title: `Bot management telemetry active (${data.waf.vendor ?? 'edge'})`,
        detail: data.waf.evidence.join('; ') || 'Bot management cookies/headers observed; verify verified AI search bots in CDN logs.',
        scope: 'site',
      });
    }
    if (includeSite && data.waf.cloudflareSept2026Advisory) {
      push({
        id: 'cf_sept2026_defaults_advisory',
        severity: 'info',
        category: 'waf',
        title: 'Cloudflare Sept 2026 AI Crawl Control defaults advisory',
        detail: 'Cloudflare zone with bot telemetry/ad-tech detected; verify AI Crawl Control allows verified AI search crawlers.',
        scope: 'site',
      });
    }
  }

  // 2. Site-wide Robots Policy (18 bots + Cloudflare Managed + Content-Signal + AIPREF)
  if (includeSite && data.robotsPolicy) {
    const rp = data.robotsPolicy;
    if (rp.cloudflareManaged.contradictions.length > 0) {
      push({
        id: 'cf_managed_robots_override',
        severity: 'critical',
        category: 'robots',
        title: `Cloudflare Managed robots.txt overrides origin rules (${rp.cloudflareManaged.contradictions.length} contradiction${rp.cloudflareManaged.contradictions.length === 1 ? '' : 's'})`,
        detail: rp.cloudflareManaged.contradictions.map((c) => c.detail).join(' | '),
        scope: 'site',
      });
    }
    if (rp.contentSignals.conflicts.length > 0) {
      push({
        id: 'content_signal_conflict',
        severity: 'warning',
        category: 'robots',
        title: `Content-Signal conflict between robots.txt and HTTP headers (${rp.contentSignals.conflicts.map((c) => c.directive).join(', ')})`,
        detail: rp.contentSignals.conflicts.map((c) => c.detail).join(' | '),
        scope: 'site',
      });
    }
    if (rp.contentSignals.suppressesSearch) {
      push({
        id: 'content_signal_search_no',
        severity: 'critical',
        category: 'robots',
        title: 'Content-Signal sets search=no',
        detail: 'Explicit search=no signal instructs compliant search engines and AI search tools not to index or cite this site.',
        scope: 'site',
      });
    }
    if (rp.contentSignals.suppressesAiInput) {
      push({
        id: 'content_signal_ai_input_no',
        severity: 'warning',
        category: 'robots',
        title: 'Content-Signal sets ai-input=no',
        detail: 'Explicit ai-input=no signal opts out of live RAG / AI grounding input.',
        scope: 'site',
      });
    }
    if (rp.endsWithRulelessGroup) {
      push({
        id: 'robots_trailing_ruleless_group',
        severity: 'warning',
        category: 'robots',
        title: `Trailing ruleless User-agent group in robots.txt (${rp.trailingRulelessAgent ?? 'unknown'})`,
        detail: 'A User-agent block at the end of robots.txt has no Allow/Disallow rules (common copy-paste truncation bug).',
        scope: 'site',
      });
    }
    if (rp.summary.searchRetrievalBlocked.length > 0 && !seen.has('ai_search_bots_blocked')) {
      push({
        id: 'ai_search_bots_blocked',
        severity: 'critical',
        category: 'robots',
        title: `AI search/retrieval crawler(s) blocked: ${rp.summary.searchRetrievalBlocked.join(', ')}`,
        detail: `robots.txt blocks retrieval crawlers: ${rp.summary.searchRetrievalBlocked.join(', ')}.`,
        scope: 'site',
      });
    }
    if (rp.summary.mixedSearchAiBlocked.length > 0 && !seen.has('traditional_search_bots_blocked')) {
      push({
        id: 'traditional_search_bots_blocked',
        severity: 'critical',
        category: 'robots',
        title: `Mixed search/AI crawler(s) blocked: ${rp.summary.mixedSearchAiBlocked.join(', ')}`,
        detail: `robots.txt blocks mixed search/AI crawlers: ${rp.summary.mixedSearchAiBlocked.join(', ')}.`,
        scope: 'site',
      });
    }
    if (rp.aiprefTrainingOptOut.disallowed) {
      push({
        id: 'aipref_training_opt_out',
        severity: 'info',
        category: 'robots',
        title: 'Unified IETF AIPREF training opt-out detected (__usage_ai-training)',
        detail: 'Disallow on __usage_ai-training opts out of model training only; does not block AI search visibility.',
        scope: 'site',
      });
    }
  }

  // 3. Edge Markdown negotiation (Accept: text/markdown)
  if (includeSite && data.markdownNegotiation) {
    const md = data.markdownNegotiation;
    if (md.missingVaryAccept) {
      push({
        id: 'missing_vary_accept_markdown',
        severity: 'critical',
        category: 'headers',
        title: 'Accept: text/markdown response missing Vary: Accept (cache-poisoning risk)',
        detail: `Server returned ${md.contentType ?? 'text/markdown'} without Vary: Accept; shared CDNs risk caching Markdown and serving it to HTML browsers.`,
        scope: 'site',
      });
    }
    if (md.csrEmptyShellTrap) {
      push({
        id: 'edge_markdown_csr_trap',
        severity: 'critical',
        category: 'csr',
        title: 'Edge Markdown CSR Empty-Shell Trap detected',
        detail: `Accept: text/markdown returned only ${md.wordCount ?? 0} word(s)${md.tokenCount !== null ? ` (x-markdown-tokens: ${md.tokenCount})` : ''} from an unrendered CSR HTML shell.`,
        scope: 'site',
      });
    }
    if (md.supported && !md.missingVaryAccept && !md.csrEmptyShellTrap) {
      push({
        id: 'markdown_negotiation_supported',
        severity: 'info',
        category: 'headers',
        title: `Accept: text/markdown supported (${md.wordCount ?? 0} words${md.tokenCount !== null ? `, ${md.tokenCount} tokens` : ''})`,
        detail: 'Origin/CDN cleanly serves negotiated text/markdown with Vary: Accept.',
        scope: 'site',
      });
    }
  }

  // 4. Extraction Forensics (10 signals)
  if (data.extraction) {
    const f = data.extraction.forensics;
    if (f.rawHtmlCliffs.exceeds2MB) {
      push({
        id: 'html_over_2mb',
        severity: 'critical',
        category: 'payload',
        title: `Raw HTML exceeds Googlebot 2 MB cutoff (${(f.rawHtmlBytes / (1024 * 1024)).toFixed(2)} MB)`,
        detail: 'Uncompressed raw HTML exceeds 2 MiB; search and AI crawlers silently drop trailing content past 2 MiB.',
        scope: 'template',
      });
    }
    if (f.payloadToProseRatio >= 15 && f.rawHtmlBytes >= 20_000) {
      const isRsc = f.nextFlightBytes > 0 || f.nextDataBytes > 0;
      const breakdown = isRsc
        ? `Next.js flight/data payload: ${formatBytes(f.nextFlightBytes + f.nextDataBytes)}`
        : `inline JS/CSS: ${formatBytes(f.inlineJsCssBytes)}`;
      push({
        id: isRsc ? 'nextjs_rsc_bloat' : 'payload_to_prose_bloat',
        severity: 'warning',
        category: 'payload',
        title: isRsc
          ? `Severe Next.js RSC/hydration bloat (${f.payloadToProseRatio}x HTML-to-prose ratio)`
          : `Heavy HTML payload-to-prose bloat (${f.payloadToProseRatio}x ratio)`,
        detail: `Raw HTML (${formatBytes(f.rawHtmlBytes)}) is ${f.payloadToProseRatio}x larger than visible prose (${formatBytes(f.visibleProseBytes)}; ${breakdown}).`,
        scope: 'template',
      });
    }
    if (f.dataNosnippetWarning) {
      push({
        id: 'data_nosnippet_hiding_content',
        severity: 'warning',
        category: 'indexing',
        title: `data-nosnippet hides ${Math.round(f.dataNosnippetShare * 100)}% of body text`,
        detail: `${f.dataNosnippetChars} chars wrapped in data-nosnippet will be excluded from search snippets and AI Overviews grounding.`,
        scope: 'template',
      });
    }
    if (f.collapsedShareWarning) {
      push({
        id: 'collapsed_content_majority',
        severity: 'warning',
        category: 'payload',
        title: `Over half of body text (${Math.round(f.collapsedShare * 100)}%) is collapsed or hidden`,
        detail: `${f.collapsedChars} chars live inside closed <details>, [hidden], aria-hidden, or display:none containers.`,
        scope: 'template',
      });
    }
    if (
      f.jsonLdCrossCheck.checkedCount > 0 &&
      f.jsonLdCrossCheck.missingCount > 0 &&
      (f.jsonLdCrossCheck.matchRatio ?? 1) < 0.75
    ) {
      const sampleMissing = f.jsonLdCrossCheck.missing
        .slice(0, 4)
        .map((m) => `${m.field}="${m.value}"`)
        .join(', ');
      push({
        id: 'jsonld_visible_text_mismatch',
        severity: 'warning',
        category: 'indexing',
        title: `JSON-LD structured data mismatches visible page text (${f.jsonLdCrossCheck.missingCount}/${f.jsonLdCrossCheck.checkedCount} missing)`,
        detail: `Structured data values not found in visible body copy: ${sampleMissing}.`,
        scope: 'template',
      });
    }
    if (f.soft404.detected && data.status === 200) {
      push({
        id: 'soft_404_detected',
        severity: 'critical',
        category: 'indexing',
        title: 'Soft-404 detected (HTTP 200 error page)',
        detail: f.soft404.reason ?? 'HTTP 200 response looks like a 404/Not Found page with thin visible copy.',
        scope: 'page',
      });
    }
    if (f.multiSectionDrop.warning) {
      push({
        id: 'multi_section_extraction_drop',
        severity: 'warning',
        category: 'payload',
        title: 'Reader extractor dropped primary page sections or tables',
        detail: f.multiSectionDrop.reason ?? 'Multi-section layout caused reader-mode extraction loss.',
        scope: 'template',
      });
    }
    if (f.markdownTruncation.exceeds100k) {
      push({
        id: 'markdown_over_100k',
        severity: 'critical',
        category: 'payload',
        title: `Extracted Markdown exceeds 100,000 chars (${f.markdownTruncation.markdownChars.toLocaleString('en-US')} chars)`,
        detail: 'Exceeds common AI retrieval context window cutoffs; split long pages or prune boilerplate.',
        scope: 'template',
      });
    } else if (f.markdownTruncation.exceeds50k) {
      push({
        id: 'markdown_over_50k',
        severity: 'warning',
        category: 'payload',
        title: `Extracted Markdown exceeds 50,000 chars (${f.markdownTruncation.markdownChars.toLocaleString('en-US')} chars)`,
        detail: 'Large extracted Markdown increases truncation risk in RAG pipelines.',
        scope: 'template',
      });
    }
    if (f.noscriptAppShell.flagged && data.payload?.csrRisk?.level !== 'high') {
      push({
        id: 'noscript_app_shell',
        severity: 'warning',
        category: 'csr',
        title: 'App-shell <noscript> warning with minimal raw HTML copy',
        detail: `Raw HTML exposes only ${f.noscriptAppShell.rawMainTextChars} chars outside <noscript>.`,
        scope: 'template',
      });
    }
  }

  // 5. Passive Caching Hygiene
  if (data.caching && Array.isArray(data.caching.issues)) {
    for (const issue of data.caching.issues) {
      push({
        id: issue.id,
        severity: issue.severity,
        category: 'caching',
        title: issue.title,
        detail: issue.detail,
        scope: 'page',
      });
    }
  }

  // 6. Bot-vs-Human Diff Content Loss
  if (includeSite && data.botVsHumanDiff && data.botVsHumanDiff.human) {
    const diff = data.botVsHumanDiff;
    const parityPct = diff.proseParityRatio !== null ? Math.round(diff.proseParityRatio * 100) : null;
    if (
      diff.missingHeadings.length > 0 ||
      diff.lostTables > 0 ||
      diff.lostCodeBlocks > 0 ||
      (diff.proseParityRatio !== null && diff.proseParityRatio < 0.7)
    ) {
      /** @type {string[]} */
      const parts = [];
      if (parityPct !== null) parts.push(`Prose Parity ${parityPct}%`);
      if (diff.missingHeadings.length > 0) {
        parts.push(
          `${diff.missingHeadings.length} missing heading(s) (${diff.missingHeadings.slice(0, 3).map((h) => h.text).join(', ')})`,
        );
      }
      if (diff.lostTables > 0) parts.push(`${diff.lostTables} lost table(s)`);
      if (diff.lostCodeBlocks > 0) parts.push(`${diff.lostCodeBlocks} lost code block(s)`);
      push({
        id: 'bot_vs_human_content_loss',
        severity: (diff.proseParityRatio !== null && diff.proseParityRatio < 0.5) || diff.lostTables > 0 ? 'critical' : 'warning',
        category: 'browser',
        title: 'Bot-vs-Human DOM diff found content invisible to non-JS AI crawlers',
        detail: parts.join('; ') + '.',
        scope: 'page',
      });
    }
  }

  // 7. /llms.txt Soft-404 / SPA HTML fallback
  if (includeSite && data.llmsTxt && data.llmsTxt.isHtmlFallback) {
    if (data.llmsTxt.soft404) {
      push({
        id: 'soft_404_spa_fallback',
        severity: 'warning',
        category: 'indexing',
        title: '/llms.txt returned HTTP 200 HTML soft-404 / SPA fallback',
        detail: `${data.llmsTxt.url} returned HTTP ${data.llmsTxt.status} with ${data.llmsTxt.contentType ?? 'HTML'} instead of a real 404 or plain text.`,
        scope: 'site',
      });
    } else {
      push({
        id: 'llms_txt_html_fallback',
        severity: 'info',
        category: 'indexing',
        title: '/llms.txt returned HTTP 200 HTML',
        detail: `${data.llmsTxt.url} served ${data.llmsTxt.contentType ?? 'HTML'} instead of a 404 or text/plain; verify SPA catch-all rewrites.`,
        scope: 'site',
      });
    }
  }

  return out;
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
  const meta = resolvePageMeta(payload, headersObj, finalUrl);

  const parsedFinalUrl = new URL(finalUrl);
  const targetPath = `${parsedFinalUrl.pathname || '/'}${parsedFinalUrl.search}`;
  const fetchedOk = !loopDetected && !maxHopsExceeded && status !== null && status >= 200 && status < 400;

  // Passive zero-extra-request forensics
  const stack = detectStackAndWaf({
    url: finalUrl,
    status,
    headers: finalResponse?.headers ?? null,
    html: htmlString,
  });
  const waf = stack.waf;
  const extracted = extractBotMarkdown(htmlString, {
    url: finalUrl,
    forceFallback: options.forceFallback,
  });
  const forensics = analyzeExtractionForensics(htmlString, htmlByteLength, {
    extracted,
    url: finalUrl,
    forceFallback: options.forceFallback,
  });
  const extraction = { extracted, forensics };

  // Parallel: robots.txt + DNS hints + optional Accept: text/markdown probe + optional browser diff
  const [robotsOutcome, dnsHints, markdownOutcome, browserOutcome] = await Promise.all([
    fetchAndEvaluateRobots(finalUrl, {
      fetchFn,
      timeoutMs,
      allowPrivateHosts,
      lookupFn,
      signal: options.signal,
    }),
    probeDnsHintsSafe(parsedFinalUrl.hostname, {
      dnsResolver: options.dnsResolver,
      timeoutMs,
    }),
    fetchedOk && options.skipMarkdownProbe !== true
      ? probeMarkdownNegotiation(finalUrl, {
          fetchFn,
          timeoutMs,
          allowPrivateHosts,
          lookupFn,
          rawPayload: payload,
          rawExtracted: extracted,
          signal: options.signal,
        })
      : Promise.resolve({
          result: /** @type {MarkdownNegotiationResult} */ ({
            probed: false,
            supported: false,
            status: null,
            contentType: null,
            vary: null,
            varyHasAccept: false,
            missingVaryAccept: false,
            tokenCount: null,
            wordCount: null,
            charCount: null,
            csrEmptyShellTrap: false,
            markdown: null,
            error: null,
          }),
          rawHeaders: /** @type {Headers|null} */ (null),
        }),
    options.browser === true
      ? fetchedOk
        ? runBrowserDiff(finalUrl, payload, {
            timeoutMs: options.browserTimeoutMs ?? Math.max(timeoutMs, 15_000),
            browserBinary: options.browserBinary,
            browserRunner: options.browserRunner,
          })
        : Promise.resolve({
            diff: /** @type {BrowserDiffResult} */ ({
              status: 'skipped',
              reason: 'Skipped headless browser render because initial HTTP fetch did not succeed.',
            }),
            renderedHtml: /** @type {string|null} */ (null),
          })
      : Promise.resolve({
          diff: /** @type {BrowserDiffResult} */ ({
            status: 'skipped',
            reason: 'Pass --browser (or options.browser = true) to compare raw HTML against headless rendered DOM.',
          }),
          renderedHtml: /** @type {string|null} */ (null),
        }),
  ]);

  const robotsTxt = robotsOutcome.robotsTxt;
  const robotsPolicy = analyzeRobotsPolicy(robotsOutcome.rawText, targetPath, finalResponse?.headers ?? null);
  const browserDiff = browserOutcome.diff;
  const renderedHtml = browserOutcome.renderedHtml;
  const markdownNegotiation = markdownOutcome.result;

  const caching = analyzeCachingHeaders(finalResponse?.headers ?? null, new Date(), {
    isNextJsAppRouter: stack.primaryFramework === 'nextjs-app-router',
  });

  const botVsHumanDiff =
    renderedHtml !== null || markdownNegotiation.supported
      ? diffBotVsHuman({
          botHtml: htmlString,
          humanHtml: renderedHtml,
          edgeMarkdown: markdownNegotiation.supported ? markdownNegotiation.markdown : null,
          edgeHeaders: markdownOutcome.rawHeaders,
          url: finalUrl,
          forceFallback: options.forceFallback,
        })
      : null;

  if (botVsHumanDiff?.edgeMarkdownCsrTrap) {
    markdownNegotiation.csrEmptyShellTrap = true;
  }

  /** @type {number|null} */
  let proseParityPct = null;
  if (botVsHumanDiff && botVsHumanDiff.proseParityRatio !== null) {
    proseParityPct = Number((botVsHumanDiff.proseParityRatio * 100).toFixed(1));
  } else if (browserDiff.status === 'ok' && (browserDiff.renderedWordCount ?? 0) > 0) {
    proseParityPct = Number(
      Math.min(100, ((browserDiff.rawWordCount ?? 0) / /** @type {number} */ (browserDiff.renderedWordCount)) * 100).toFixed(1),
    );
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

  const baseFindings = buildFindings({
    status,
    redirects,
    headers: headersObj,
    meta,
    robotsTxt,
    payload,
    browserDiff,
  });

  const findings = appendV2Findings(baseFindings, {
    url: finalUrl,
    status,
    waf,
    robotsPolicy,
    caching,
    extraction,
    markdownNegotiation,
    botVsHumanDiff,
    payload,
    includeSiteSignals: true,
  });

  const remediation = buildRemediationPlan({
    stack,
    waf,
    findings,
    robotsPolicy,
    caching,
    markdownNegotiation,
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
    disclaimers: buildDisclaimers(headersObj.cdnDetected ?? stack.primaryCdn),
    stack,
    waf,
    robotsPolicy,
    caching,
    dnsHints,
    extraction,
    markdownNegotiation,
    botVsHumanDiff,
    proseParityPct,
    remediation,
  };
}

/**
 * Normalize a page finding into `SiteFinding` severity (`'attention'` -> `'warning'`).
 * @param {import('./site-crawler.js').PageFinding} f
 * @returns {SiteFinding}
 */
function normalizeToSiteFinding(f) {
  /** @type {'critical'|'warning'|'info'} */
  const severity = f.severity === 'critical' ? 'critical' : f.severity === 'info' ? 'info' : 'warning';
  /** @type {SiteFinding['category']} */
  const cat =
    f.category === 'robots' ||
    f.category === 'indexing' ||
    f.category === 'redirects' ||
    f.category === 'payload' ||
    f.category === 'csr' ||
    f.category === 'browser' ||
    f.category === 'headers' ||
    f.category === 'waf' ||
    f.category === 'caching' ||
    f.category === 'sitemap' ||
    f.category === 'dns'
      ? f.category
      : 'headers';
  return {
    id: f.ruleId ?? f.id,
    severity,
    category: cat,
    title: f.title,
    detail: f.detail,
    ...(f.scope ? { scope: f.scope } : {}),
  };
}

/**
 * Run the full `hearsay check` v2 audit:
 * - Multi-page key-page crawl ON BY DEFAULT (`maxPages = 15`, or `single: true` for 1 URL)
 * - Passive stack/CDN/WAF fingerprinting, 18-bot robots policy + Cloudflare Managed / Content-Signal,
 *   caching validator plausibility, DNS hints, `webforai`+`diff` extraction forensics,
 *   `Accept: text/markdown` negotiation, `/llms.txt` soft-404 check, optional `--browser` Bot-vs-Human diff
 * - Hard Infrastructure Gate, template-level issue clustering, stack-aware remediation recipes
 * - Optional `--vs` parallel Competitor X-Ray matrix, `--baseline` regression diff, and CI Quality Gate
 * - Explicit `counts: { audited, skipped, errored }` — NEVER marks robots-skipped pages as PASS.
 *
 * @param {string} rawUrl
 * @param {CheckSiteV2Options} [options]
 * @returns {Promise<SiteCheckV2Report>}
 */
export async function checkSiteV2(rawUrl, options = {}) {
  const startedAt = Date.now();
  const single = options.single === true;
  const maxPages = single
    ? 1
    : typeof options.maxPages === 'number' && Number.isInteger(options.maxPages) && options.maxPages > 0
      ? options.maxPages
      : DEFAULT_MAX_PAGES;
  const maxPerTemplate =
    typeof options.maxPerTemplate === 'number' && Number.isInteger(options.maxPerTemplate) && options.maxPerTemplate > 0
      ? options.maxPerTemplate
      : 3;
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
  const lookupFn = options.lookup === null ? null : (options.lookup ?? (options.fetch ? null : dnsLookup));

  /** @param {SiteCheckProgressEvent} event */
  const emitProgress = (event) => {
    if (typeof options.onProgress !== 'function') return;
    try {
      options.onProgress(event);
    } catch {
      /* ignore listener failure */
    }
  };

  emitProgress({
    type: 'started',
    url: rawUrl,
    audited: 0,
    maxPages,
    message: `Starting Site X-Ray for ${rawUrl}`,
  });

  let progressAudited = 0;

  // Capture raw /robots.txt text from crawlSitePages's own fetch with zero extra requests
  const robotsCapture = { text: '' };
  /** @type {typeof globalThis.fetch} */
  const robotsCaptureFetch = async (input, init) => {
    const res = await fetchFn(input, init);
    try {
      const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsedReq = new URL(reqUrl);
      if (
        parsedReq.pathname === '/robots.txt' &&
        res.status >= 200 &&
        res.status < 300 &&
        typeof res.clone === 'function'
      ) {
        const cloned = res.clone();
        const ct = (cloned.headers.get('content-type') ?? '').toLowerCase();
        if (!ct.includes('text/html')) {
          const text = await cloned.text();
          if (!text.trimStart().slice(0, 128).toLowerCase().startsWith('<!doctype html')) {
            robotsCapture.text = text.slice(0, DEFAULT_MAX_ROBOTS_BYTES);
          }
        }
      }
    } catch {
      /* ignore capture failure */
    }
    return res;
  };

  /**
   * Captured homepage snapshot from single-pass crawl (never double-fetched).
   * Stored in a ref object so strict TypeScript CFA does not narrow it to `null`.
   * @type {{
   *   current: {
   *     html: string,
   *     htmlBytes: number,
   *     headers: Headers,
   *     headersObj: SiteCheckReport['headers'],
   *     meta: SiteCheckReport['meta'],
   *     payload: PayloadAnalysis,
   *     redirects: SiteCheckReport['redirects'],
   *     stack: import('./tech-detect.js').StackAndWafResult,
   *     caching: import('./tech-detect.js').CachingAnalysisResult,
   *     extraction: SiteExtractionReport,
   *   }|null
   * }}
   */
  const homeSnapshotRef = { current: null };

  /**
   * Side-channel per-page v2 enrichments keyed by `finalUrl` so `pageChecker`
   * returns exact `Partial<CrawledPageResult>` without excess-property errors.
   * @type {Map<string, {
   *   meta: SiteCheckReport['meta'],
   *   extraction: SiteExtractionReport,
   *   caching: import('./tech-detect.js').CachingAnalysisResult,
   *   stackResult: import('./tech-detect.js').StackAndWafResult,
   * }>}
   */
  const pageExtrasByUrl = new Map();

  /** @type {SiteCheckReport['robotsTxt']} */
  const dummyRobotsForPage = {
    url: '',
    status: 200,
    fetched: true,
    error: null,
    sitemaps: [],
    crawlers: [],
    blockedCount: 0,
    allowedCount: 0,
  };

  /**
   * Single-pass page analyzer passed to `crawlSitePages`.
   * @param {import('./site-crawler.js').PageCheckerContext} ctx
   * @returns {Partial<import('./site-crawler.js').CrawledPageResult>}
   */
  const pageChecker = (ctx) => {
    const payload = analyzeHtmlPayload(ctx.html, ctx.htmlBytes);
    const headersObj = {
      xRobotsTag: ctx.headers.get('x-robots-tag') ?? null,
      contentType: ctx.headers.get('content-type') ?? null,
      cacheControl: ctx.headers.get('cache-control') ?? null,
      server: ctx.headers.get('server') ?? null,
      cfRay: ctx.headers.get('cf-ray') ?? null,
      vary: ctx.headers.get('vary') ?? null,
      cdnDetected: detectCdn(ctx.headers),
    };
    const meta = resolvePageMeta(payload, headersObj, ctx.finalUrl);
    const pageStack = detectStackAndWaf({
      url: ctx.finalUrl,
      status: ctx.status,
      headers: ctx.headers,
      html: ctx.html,
    });
    const pageCaching = analyzeCachingHeaders(ctx.headers, new Date(), {
      isNextJsAppRouter: pageStack.primaryFramework === 'nextjs-app-router',
    });
    const extracted = extractBotMarkdown(ctx.html, {
      url: ctx.finalUrl,
      forceFallback: options.forceFallback,
    });
    const forensics = analyzeExtractionForensics(ctx.html, ctx.htmlBytes, {
      extracted,
      url: ctx.finalUrl,
      forceFallback: options.forceFallback,
    });
    const extraction = { extracted, forensics };

    const redirects = {
      count: ctx.redirects.count,
      hops: ctx.redirects.hops.map((h) => ({ ...h, geoLikely: false })),
      finalUrl: ctx.finalUrl,
      loopDetected: ctx.redirects.loopDetected,
      loopTarget: ctx.redirects.loopDetected ? (ctx.redirects.hops.at(-1)?.resolvedUrl ?? ctx.finalUrl) : null,
      maxHopsExceeded: ctx.redirects.maxHopsExceeded,
      crossHost: ctx.redirects.hops.some((h) => h.crossHost),
      geoLikely: false,
    };

    const pageBaseFindings = buildFindings({
      status: ctx.status,
      redirects,
      headers: { ...headersObj, cdnDetected: null },
      meta,
      robotsTxt: dummyRobotsForPage,
      payload,
      browserDiff: { status: 'skipped' },
    });

    const pageFindings = appendV2Findings(pageBaseFindings, {
      url: ctx.finalUrl,
      status: ctx.status,
      waf: pageStack.waf,
      caching: pageCaching,
      extraction,
      payload,
      includeSiteSignals: false,
    });

    if (ctx.robotsDisallowed) {
      pageFindings.push({
        id: 'robots_disallowed_page',
        severity: 'warning',
        category: 'robots',
        title: 'Page is disallowed in robots.txt (audited via --ignore-robots-for-own-site)',
        detail: `${ctx.url} is blocked by robots.txt rules.`,
        scope: 'page',
      });
    }

    // Mark template-scoped findings consistently for clustering
    /** @type {import('./site-crawler.js').PageFinding[]} */
    const scopedFindings = pageFindings.map((f) => {
      /** @type {'site'|'template'|'page'} */
      const scope =
        f.scope ??
        (f.id === 'missing_h1' ||
        f.id === 'missing_title' ||
        f.id === 'canonical_mismatch' ||
        f.id === 'csr_empty_shell_high' ||
        f.id === 'csr_empty_shell_medium' ||
        f.id.startsWith('truncation_')
          ? 'template'
          : 'page');
      return {
        ...f,
        scope,
      };
    });

    pageExtrasByUrl.set(ctx.finalUrl, {
      meta,
      extraction,
      caching: pageCaching,
      stackResult: pageStack,
    });

    if (ctx.isHomepage) {
      homeSnapshotRef.current = {
        html: ctx.html,
        htmlBytes: ctx.htmlBytes,
        headers: ctx.headers,
        headersObj,
        meta,
        payload,
        redirects,
        stack: pageStack,
        caching: pageCaching,
        extraction,
      };
    }

    const stackLabels = [
      ...(pageStack.primaryFramework ? [pageStack.primaryFramework] : []),
      ...(pageStack.primaryCms ? [pageStack.primaryCms] : []),
      ...(pageStack.primaryCdn ? [pageStack.primaryCdn] : []),
      ...(pageStack.primaryHosting ? [pageStack.primaryHosting] : []),
    ];

    progressAudited += 1;
    emitProgress({
      type: 'page',
      url: ctx.url,
      finalUrl: ctx.finalUrl,
      template: ctx.template,
      status: ctx.status,
      audited: progressAudited,
      maxPages,
      message: `Audited ${ctx.finalUrl} (${progressAudited}/${maxPages})`,
    });

    return {
      title: meta.title,
      canonical: meta.canonical,
      noindex: meta.noindex,
      soft404: forensics.soft404.detected && ctx.status === 200,
      wafState: pageStack.waf.state,
      payloadToProseRatio: forensics.payloadToProseRatio,
      stack: stackLabels,
      payload,
      findings: scopedFindings,
    };
  };

  const crawl = await crawlSitePages(rawUrl, {
    single,
    maxPages,
    maxPerTemplate,
    allowPrivateHosts,
    ignoreRobotsForOwnSite: options.ignoreRobotsForOwnSite === true,
    includeAuthRoutes: options.includeAuthRoutes === true,
    checkCaching: options.checkCaching === true,
    pageChecker,
    fetchImpl: robotsCaptureFetch,
    lookup: lookupFn,
    timeoutMs,
    maxConcurrency: options.maxConcurrency,
    maxRedirects,
    maxHtmlBytes,
    sleepFn: options.sleepFn,
    signal: options.signal,
  });

  const enrichedPages = crawl.pages.map((pg) => {
    const extras = pageExtrasByUrl.get(pg.finalUrl);
    return extras ? { ...pg, ...extras } : { ...pg };
  });

  const finalUrl = crawl.finalUrl;
  const parsedFinal = new URL(finalUrl);
  const homePath = `${parsedFinal.pathname || '/'}${parsedFinal.search}`;
  const homepagePage = enrichedPages.find((p) => p.isHomepage) ?? enrichedPages[0] ?? null;
  const status = homepagePage?.status ?? null;

  // Build fallback homepage structures when transport failed before homepage fetch
  const fallbackPayload = analyzeHtmlPayload('', 0);
  const fallbackHeadersObj = {
    xRobotsTag: null,
    contentType: null,
    cacheControl: null,
    server: null,
    cfRay: null,
    vary: null,
    cdnDetected: null,
  };
  const fallbackMeta = resolvePageMeta(fallbackPayload, fallbackHeadersObj, finalUrl);
  const fallbackStack = detectStackAndWaf({ url: finalUrl, status, headers: null, html: '' });
  const fallbackCaching = analyzeCachingHeaders(null);
  const fallbackExtracted = extractBotMarkdown('', { url: finalUrl, forceFallback: options.forceFallback });
  const fallbackForensics = analyzeExtractionForensics('', 0, {
    extracted: fallbackExtracted,
    url: finalUrl,
    forceFallback: options.forceFallback,
  });

  const snap = homeSnapshotRef.current ?? {
    html: '',
    htmlBytes: 0,
    headers: new Headers(),
    headersObj: fallbackHeadersObj,
    meta: fallbackMeta,
    payload: fallbackPayload,
    redirects: {
      count: 0,
      hops: [],
      finalUrl,
      loopDetected: false,
      loopTarget: null,
      maxHopsExceeded: false,
      crossHost: false,
      geoLikely: false,
    },
    stack: fallbackStack,
    caching: fallbackCaching,
    extraction: { extracted: fallbackExtracted, forensics: fallbackForensics },
  };

  const homepageFetchedOk =
    homeSnapshotRef.current !== null &&
    !snap.redirects.loopDetected &&
    !snap.redirects.maxHopsExceeded &&
    status !== null &&
    status >= 200 &&
    status < 400;

  // Parallel post-crawl probes: DNS hints + Accept: text/markdown + /llms.txt soft-404 + optional --browser
  const [dnsHints, markdownOutcome, llmsTxt, browserOutcome] = await Promise.all([
    probeDnsHintsSafe(crawl.domain, {
      dnsResolver: options.dnsResolver,
      timeoutMs,
    }),
    homepageFetchedOk && options.skipMarkdownProbe !== true
      ? probeMarkdownNegotiation(finalUrl, {
          fetchFn,
          timeoutMs,
          allowPrivateHosts,
          lookupFn,
          rawPayload: snap.payload,
          rawExtracted: snap.extraction.extracted,
          signal: options.signal,
        })
      : Promise.resolve({
          result: /** @type {MarkdownNegotiationResult} */ ({
            probed: false,
            supported: false,
            status: null,
            contentType: null,
            vary: null,
            varyHasAccept: false,
            missingVaryAccept: false,
            tokenCount: null,
            wordCount: null,
            charCount: null,
            csrEmptyShellTrap: false,
            markdown: null,
            error: null,
          }),
          rawHeaders: /** @type {Headers|null} */ (null),
        }),
    homepageFetchedOk && options.skipLlmsProbe !== true
      ? probeLlmsTxt(parsedFinal.origin, {
          fetchFn,
          timeoutMs,
          allowPrivateHosts,
          lookupFn,
          signal: options.signal,
        })
      : Promise.resolve(/** @type {LlmsTxtProbeResult|null} */ (null)),
    options.browser === true
      ? homepageFetchedOk
        ? runBrowserDiff(finalUrl, snap.payload, {
            timeoutMs: options.browserTimeoutMs ?? Math.max(timeoutMs, 15_000),
            browserBinary: options.browserBinary,
            browserRunner: options.browserRunner,
          })
        : Promise.resolve({
            diff: /** @type {BrowserDiffResult} */ ({
              status: 'skipped',
              reason: 'Skipped headless browser render because homepage HTTP fetch did not succeed.',
            }),
            renderedHtml: /** @type {string|null} */ (null),
          })
      : Promise.resolve({
          diff: /** @type {BrowserDiffResult} */ ({
            status: 'skipped',
            reason: 'Pass --browser (or options.browser = true) to compare raw HTML against headless rendered DOM.',
          }),
          renderedHtml: /** @type {string|null} */ (null),
        }),
  ]);

  const robotsPolicy = analyzeRobotsPolicy(robotsCapture.text, homePath, snap.headers);
  const robotsFetch5xxOrFailed =
    !crawl.robotsTxt.soft404 &&
    (Boolean(crawl.robotsTxt.error) || (typeof crawl.robotsTxt.status === 'number' && crawl.robotsTxt.status >= 500));
  const aiBotsAllowed = summarizeAiBotsFromPolicy(robotsPolicy, {
    treatAllBlocked: robotsFetch5xxOrFailed,
  });
  const markdownNegotiation = markdownOutcome.result;
  const browserDiff = browserOutcome.diff;
  const renderedHtml = browserOutcome.renderedHtml;

  const botVsHumanDiff =
    renderedHtml !== null || markdownNegotiation.supported
      ? diffBotVsHuman({
          botHtml: snap.html,
          humanHtml: renderedHtml,
          edgeMarkdown: markdownNegotiation.supported ? markdownNegotiation.markdown : null,
          edgeHeaders: markdownOutcome.rawHeaders,
          url: finalUrl,
          forceFallback: options.forceFallback,
        })
      : null;

  if (botVsHumanDiff?.edgeMarkdownCsrTrap) {
    markdownNegotiation.csrEmptyShellTrap = true;
  }

  /** @type {number|null} */
  let proseParityPct = null;
  if (botVsHumanDiff && botVsHumanDiff.proseParityRatio !== null) {
    proseParityPct = Number((botVsHumanDiff.proseParityRatio * 100).toFixed(1));
  } else if (browserDiff.status === 'ok' && (browserDiff.renderedWordCount ?? 0) > 0) {
    proseParityPct = Number(
      Math.min(100, ((browserDiff.rawWordCount ?? 0) / /** @type {number} */ (browserDiff.renderedWordCount)) * 100).toFixed(1),
    );
  }

  if (homepagePage) {
    homepagePage.markdownNegotiation = markdownNegotiation.supported;
    if (browserDiff.status === 'ok' && typeof browserDiff.renderedWordCount === 'number') {
      homepagePage.renderedWordCount = browserDiff.renderedWordCount;
    }
    if (proseParityPct !== null) {
      homepagePage.proseParityPct = proseParityPct;
    }
  }

  // Re-evaluate Hard Gate cleanly on enriched homepage
  const hardGate =
    crawl.counts.audited === 0
      ? crawl.hardGate
      : evaluateHardGate({
          status,
          wafState: snap.stack.waf.state,
          payload: snap.payload,
          visibleWordCount: snap.payload.visibleWordCount,
        });

  // Legacy 9-bot `robotsTxt` structure for backwards compatibility
  /** @type {CrawlerRuleResult[]} */
  const legacyCrawlers =
    crawl.robotsTxt.crawlers.length === AI_CRAWLERS.length
      ? crawl.robotsTxt.crawlers.map((c) => {
          const parsed = crawl.robotsTxt.fetched ? parseRobotsTxt(robotsCapture.text, homePath, c.bot) : null;
          return {
            bot: c.bot,
            matchedGroup: c.matchedGroup,
            rule: c.rule,
            directive: parsed?.directive ?? null,
            pattern: parsed?.pattern ?? null,
            allowed: c.allowed,
            status: /** @type {CrawlerRuleResult['status']} */ (c.status),
          };
        })
      : AI_CRAWLERS.map((bot) => {
          const parsed = crawl.robotsTxt.fetched ? parseRobotsTxt(robotsCapture.text, homePath, bot) : null;
          return {
            bot,
            matchedGroup: parsed?.matchedGroup ?? null,
            rule: parsed?.rule ?? null,
            directive: parsed?.directive ?? null,
            pattern: parsed?.pattern ?? null,
            allowed: parsed ? parsed.allowed : !crawl.robotsTxt.error,
            status: parsed ? parsed.status : crawl.robotsTxt.error ? 'unavailable' : 'default_allowed',
          };
        });

  /** @type {SiteCheckReport['robotsTxt']} */
  const robotsTxt = {
    url: crawl.robotsTxt.url,
    status: crawl.robotsTxt.status,
    fetched: crawl.robotsTxt.fetched,
    error: crawl.robotsTxt.error,
    sitemaps: crawl.robotsTxt.sitemaps,
    crawlers: legacyCrawlers,
    blockedCount: legacyCrawlers.filter((c) => !c.allowed).length,
    allowedCount: legacyCrawlers.filter((c) => c.allowed).length,
  };

  // Merge site-level findings cleanly (deduplicated by rule id)
  /** @type {SiteFinding[]} */
  const initialSiteFindings = crawl.siteFindings.map(normalizeToSiteFinding);
  if (crawl.robotsTxt.soft404 && !initialSiteFindings.some((f) => f.id === 'robots_txt_html_fallback')) {
    initialSiteFindings.push({
      id: 'robots_txt_html_fallback',
      severity: 'warning',
      category: 'robots',
      title: 'robots.txt returned HTTP 200 text/html (SPA fallback)',
      detail: `${crawl.robotsTxt.url} served HTML instead of plain text robots directives.`,
      scope: 'site',
    });
  }
  if (browserDiff.status === 'ok' && browserDiff.hydrationGap === 'high') {
    initialSiteFindings.push({
      id: 'browser_hydration_gap_high',
      severity: 'critical',
      category: 'browser',
      title: 'Large raw-HTML vs rendered-DOM gap',
      detail: `Headless browser rendered ${browserDiff.renderedWordCount} words vs ${browserDiff.rawWordCount} in raw HTML (+${browserDiff.addedWordCount} words added by JS).`,
      scope: 'site',
    });
  } else if (browserDiff.status === 'unavailable') {
    initialSiteFindings.push({
      id: 'browser_diff_unavailable',
      severity: 'info',
      category: 'browser',
      title: 'Headless browser DOM diff unavailable',
      detail: browserDiff.reason ?? 'No local Chromium/Chrome or Playwright found.',
      scope: 'site',
    });
  }
  if (snap.headersObj.cdnDetected || snap.stack.primaryCdn) {
    const cdnName = snap.stack.primaryCdn ?? snap.headersObj.cdnDetected;
    initialSiteFindings.push({
      id: 'cdn_waf_detected',
      severity: 'info',
      category: 'headers',
      title: `CDN/WAF detected (${cdnName})`,
      detail: 'Verify IP/rDNS-authenticated AI crawler traffic directly in your CDN/origin logs.',
      scope: 'site',
    });
  }

  const enrichedSiteFindings = appendV2Findings(initialSiteFindings, {
    url: finalUrl,
    status,
    waf: snap.stack.waf,
    robotsPolicy,
    markdownNegotiation,
    botVsHumanDiff,
    llmsTxt,
    payload: snap.payload,
    includeSiteSignals: true,
  });

  /** @type {import('./site-crawler.js').PageFinding[]} */
  const siteFindings = enrichedSiteFindings.map((f) => ({
    id: f.id,
    severity: f.severity,
    category: f.category,
    title: f.title,
    detail: f.detail,
    scope: /** @type {'site'} */ ('site'),
  }));

  const clusters = clusterIssuesByTemplate(enrichedPages, { siteFindings });

  // Combined deduplicated findings list for summary & remediation
  /** @type {SiteFinding[]} */
  const combinedFindings = [];
  /** @type {Set<string>} */
  const seenFindingKey = new Set();
  for (const sf of enrichedSiteFindings) {
    const k = `${sf.id}::site`;
    if (!seenFindingKey.has(k)) {
      seenFindingKey.add(k);
      combinedFindings.push(sf);
    }
  }
  for (const page of enrichedPages) {
    for (const pf of page.findings) {
      const nf = normalizeToSiteFinding(pf);
      const k = `${nf.id}::${page.finalUrl}`;
      if (!seenFindingKey.has(k)) {
        seenFindingKey.add(k);
        combinedFindings.push(nf);
      }
    }
  }

  const remediation = buildRemediationPlan({
    stack: snap.stack,
    waf: snap.stack.waf,
    findings: combinedFindings,
    robotsPolicy,
    caching: snap.caching,
    markdownNegotiation,
  });

  const criticalCount = combinedFindings.filter((f) => f.severity === 'critical').length;
  const warningCount = combinedFindings.filter((f) => f.severity === 'warning').length;
  const infoCount = combinedFindings.filter((f) => f.severity === 'info').length;
  const hasRobotsOrSsrfSkips =
    crawl.counts.skippedByReason.robots_disallowed > 0 || crawl.counts.skippedByReason.ssrf_blocked > 0;

  /** @type {'pass'|'attention'|'critical'|'blocked_hard_gate'} */
  let crawlStatus = 'pass';
  if (hardGate.triggered) {
    crawlStatus = 'blocked_hard_gate';
  } else if (criticalCount > 0 || crawl.counts.audited === 0) {
    crawlStatus = 'critical';
  } else if (warningCount > 0 || hasRobotsOrSsrfSkips || crawl.counts.errored > 0) {
    crawlStatus = 'attention';
  }

  /** @type {'pass'|'warn'|'fail'} */
  const grade =
    hardGate.triggered || criticalCount > 0 || crawl.counts.audited === 0
      ? 'fail'
      : warningCount > 0 || hasRobotsOrSsrfSkips || crawl.counts.errored > 0
        ? 'warn'
        : 'pass';

  /** @type {SiteCheckV2Report} */
  const report = {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    userAgent: USER_AGENT,
    requestedUrl: crawl.requestedUrl,
    finalUrl,
    domain: crawl.domain,
    mode: crawl.mode,
    status,
    ok: status !== null && status >= 200 && status < 400 && !snap.redirects.loopDetected && !snap.redirects.maxHopsExceeded,
    crawlStatus,
    downstreamStatus: hardGate.triggered ? 'not_observed' : 'observed',
    hardGate,
    coverageComplete: crawl.coverageComplete,
    scopeSummary: crawl.scopeSummary,
    timingMs: Date.now() - startedAt,
    counts: crawl.counts,
    redirects: snap.redirects,
    headers: snap.headersObj,
    meta: snap.meta,
    robotsTxt,
    robotsPolicy,
    aiBotsAllowed,
    payload: snap.payload,
    browserDiff,
    stack: snap.stack,
    waf: snap.stack.waf,
    caching: snap.caching,
    conditionalCaching: crawl.caching,
    dnsHints,
    extraction: snap.extraction,
    markdownNegotiation,
    botVsHumanDiff,
    proseParityPct,
    llmsTxt,
    pages: enrichedPages,
    skipped: crawl.skipped,
    errored: crawl.errored,
    redirectsResolved: crawl.redirectsResolved,
    sitemap: crawl.sitemap,
    throttle: crawl.throttle,
    siteFindings,
    findings: combinedFindings,
    clusters,
    remediation,
    summary: {
      grade,
      criticalCount,
      warningCount,
      infoCount,
      crawlStatus,
    },
    competitorXray: null,
    baselineDiff: null,
    ciGate: {
      passed: true,
      exitCode: 0,
      reasons: [],
      matchedFindings: [],
      ignoredCount: 0,
      warnings: [],
    },
    disclaimers: buildDisclaimers(snap.headersObj.cdnDetected ?? snap.stack.primaryCdn),
  };

  // Optional parallel bounded Competitor X-Ray (--vs)
  if (Array.isArray(options.vs) && options.vs.length > 0) {
    const compUrls = options.vs.map((u) => String(u).trim()).filter(Boolean);
    if (compUrls.length > 0) {
      let compDone = 0;
      const compReports = await Promise.all(
        compUrls.map(async (compUrl, idx) => {
          emitProgress({
            type: 'competitor',
            url: compUrl,
            index: idx + 1,
            total: compUrls.length,
            message: `Auditing competitor ${idx + 1}/${compUrls.length}: ${compUrl}`,
          });
          const compReport = await checkSiteV2(compUrl, {
            single,
            maxPages,
            maxPerTemplate,
            timeoutMs,
            maxRedirects,
            maxHtmlBytes,
            maxConcurrency: options.maxConcurrency,
            allowPrivateHosts,
            ignoreRobotsForOwnSite: options.ignoreRobotsForOwnSite,
            includeAuthRoutes: options.includeAuthRoutes,
            checkCaching: options.checkCaching,
            browser: options.browser,
            browserBinary: options.browserBinary,
            browserTimeoutMs: options.browserTimeoutMs,
            browserRunner: options.browserRunner,
            fetch: options.fetch,
            lookup: options.lookup,
            dnsResolver: options.dnsResolver,
            sleepFn: options.sleepFn,
            forceFallback: options.forceFallback,
            skipMarkdownProbe: options.skipMarkdownProbe,
            skipLlmsProbe: options.skipLlmsProbe,
            signal: options.signal,
          });
          compDone += 1;
          emitProgress({
            type: 'competitor',
            url: compUrl,
            finalUrl: compReport.finalUrl,
            index: compDone,
            total: compUrls.length,
            message: `Completed competitor ${compDone}/${compUrls.length}: ${compReport.domain}`,
          });
          return compReport;
        }),
      );
      report.competitorXray = compareCompetitors(report, compReports);
    }
  }

  // Optional Baseline Regression Diff (--baseline)
  if (options.baseline && typeof options.baseline === 'object') {
    report.baselineDiff = diffAgainstBaseline(report, options.baseline);
  }

  // Always evaluate CI Quality Gate (enforces mandatory zero-page guard)
  report.ciGate = evaluateCiGate(report, {
    failOn: options.failOn ?? null,
    failOnCodes: options.failOnCodes ?? [],
    ignoreCodes: options.ignoreCodes ?? [],
    baselineDiff: report.baselineDiff,
    failOnRegression: options.failOnRegression === true,
  });

  report.timingMs = Date.now() - startedAt;
  return report;
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
 * Narrow whether a report is a full v2 multi-page report (`schemaVersion === 2`).
 * @param {SiteCheckReport | SiteCheckV2Report} report
 * @returns {report is SiteCheckV2Report}
 */
function isV2Report(report) {
  return report.schemaVersion >= 2 && 'counts' in report;
}

/**
 * Summarize detected stack/CDN/WAF labels into concise badge strings.
 * @param {SiteCheckReport | SiteCheckV2Report} report
 * @returns {string[]}
 */
function collectStackBadges(report) {
  /** @type {string[]} */
  const badges = [];
  const stack = report.stack;
  if (stack) {
    const byId = new Map(stack.technologies.map((t) => [t.id, t]));
    if (stack.primaryFramework) {
      const fw = byId.get(stack.primaryFramework);
      badges.push(`Framework: ${fw ? fw.name : stack.primaryFramework}`);
    }
    if (stack.primaryCms) {
      const cms = byId.get(stack.primaryCms);
      badges.push(`CMS: ${cms ? cms.name : stack.primaryCms}`);
    }
    if (stack.primaryCdn) {
      const cdn = byId.get(stack.primaryCdn);
      badges.push(`CDN: ${cdn ? cdn.name : stack.primaryCdn}`);
    }
    if (stack.primaryHosting && stack.primaryHosting !== stack.primaryCdn) {
      const host = byId.get(stack.primaryHosting);
      badges.push(`Host: ${host ? host.name : stack.primaryHosting}`);
    }
  } else if (report.headers.cdnDetected) {
    badges.push(`CDN: ${report.headers.cdnDetected}`);
  }
  const waf = report.waf ?? stack?.waf ?? null;
  if (waf && waf.state !== 'none') {
    badges.push(`WAF: ${waf.state}${waf.vendor ? ` (${waf.vendor})` : ''}`);
  }
  return badges;
}

/**
 * Truncate long text cleanly with an ellipsis for terminal or HTML previews.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncatePreview(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}

/**
 * Render a crisp, readable terminal text report for either a single-page
 * `SiteCheckReport` (v1) or a full multi-page `SiteCheckV2Report` (v2).
 *
 * @param {SiteCheckReport | SiteCheckV2Report} report
 * @returns {string}
 */
export function renderSiteCheckText(report) {
  /** @type {string[]} */
  const lines = [];
  const v2Report = isV2Report(report) ? report : null;
  const gradeLabel = report.summary.grade.toUpperCase();
  const stackBadges = collectStackBadges(report);

  lines.push('Hearsay Site Pre-Flight Check');
  lines.push('='.repeat(68));
  lines.push(
    `Grade:         ${gradeLabel}${v2Report ? ` [${v2Report.crawlStatus.toUpperCase()}]` : ''} ` +
    `(${report.summary.criticalCount} critical, ${report.summary.warningCount} warning, ${report.summary.infoCount} info)`,
  );
  if (v2Report) {
    lines.push(
      `Scope:         ${v2Report.counts.audited} audited | ${v2Report.counts.skipped} skipped | ${v2Report.counts.errored} errored` +
      (v2Report.counts.redirectsResolved > 0 ? ` | ${v2Report.counts.redirectsResolved} redirects resolved` : '') +
      `  (mode=${v2Report.mode})`,
    );
  }
  lines.push(`Requested URL: ${report.requestedUrl}`);
  lines.push(`Final URL:     ${report.finalUrl}`);
  lines.push(`HTTP Status:   ${report.status ?? '—'}  (${report.timingMs} ms)`);
  if (stackBadges.length > 0) {
    lines.push(`Stack/Edge:    ${stackBadges.join('  |  ')}`);
  }
  lines.push(`User-Agent:    ${report.userAgent}`);

  if (v2Report && v2Report.hardGate.triggered) {
    lines.push('');
    lines.push(`[HARD GATE — DOWNSTREAM NOT OBSERVED] ${v2Report.hardGate.reason}`);
    if (v2Report.hardGate.detail) lines.push(`  ${v2Report.hardGate.detail}`);
  }
  lines.push('');

  // Findings
  lines.push('Findings');
  lines.push('-'.repeat(68));
  if (report.findings.length === 0) {
    lines.push('  [PASS] No crawlability, indexing, truncation, or CSR issues detected.');
  } else {
    for (const f of report.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] (${f.id}) ${f.title}`);
      lines.push(`      ${f.detail}`);
    }
  }
  lines.push('');

  // Template Clusters (v2)
  if (v2Report && (v2Report.clusters.templateClusters.length > 0 || v2Report.clusters.siteWide.length > 0)) {
    lines.push('Template & Site-Wide Issue Clusters');
    lines.push('-'.repeat(68));
    for (const sw of v2Report.clusters.siteWide) {
      lines.push(`  [SITE-WIDE · ${sw.severity.toUpperCase()}] ${sw.summary}`);
    }
    for (const tc of v2Report.clusters.templateClusters) {
      lines.push(`  [TEMPLATE · ${tc.severity.toUpperCase()}] ${tc.summary}`);
      if (tc.sampleUrls.length > 0) {
        lines.push(`      samples: ${tc.sampleUrls.slice(0, 3).join(', ')}`);
      }
    }
    lines.push('');
  }

  // Skipped / Errored transparency (v2)
  if (v2Report && (v2Report.skipped.length > 0 || v2Report.errored.length > 0)) {
    lines.push(`Skipped (${v2Report.skipped.length}) & Errored (${v2Report.errored.length}) Pages — Never Marked PASS`);
    lines.push('-'.repeat(68));
    for (const sk of v2Report.skipped.slice(0, 12)) {
      lines.push(`  [SKIP:${sk.reason}] ${sk.url}${sk.detail ? ` — ${sk.detail}` : ''}`);
    }
    if (v2Report.skipped.length > 12) {
      lines.push(`  ... and ${v2Report.skipped.length - 12} more skipped URL(s)`);
    }
    for (const er of v2Report.errored.slice(0, 8)) {
      lines.push(`  [ERR:${er.reason}] ${er.url} — ${er.error}`);
    }
    lines.push('');
  }

  // Redirects
  lines.push(`Redirects (${report.redirects.count} hop${report.redirects.count === 1 ? '' : 's'})`);
  lines.push('-'.repeat(68));
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

  // Headers & Metadata
  lines.push('Headers, Caching & Metadata Signals');
  lines.push('-'.repeat(68));
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
  if (report.caching) {
    lines.push(
      `  Caching Hyg.:     ETag=${report.caching.etag.present ? `${report.caching.etag.raw}${report.caching.etag.weak ? ' (weak)' : ''}` : 'none'}, ` +
      `Last-Modified=${report.caching.lastModified.reason}, 304-ready=${report.caching.conditionalGetReady ? 'yes' : 'no'}`,
    );
  }
  if (v2Report && v2Report.conditionalCaching.checked) {
    lines.push(
      `  304 Live Probe:   supported304=${v2Report.conditionalCaching.supported304 ? 'YES' : 'no'} ` +
      `(HTTP ${v2Report.conditionalCaching.status ?? '—'}, ${v2Report.conditionalCaching.reason})`,
    );
  }
  if (report.markdownNegotiation && report.markdownNegotiation.probed) {
    const md = report.markdownNegotiation;
    lines.push(
      `  Accept:markdown:  ${md.supported ? `YES (${md.wordCount ?? 0} words${md.tokenCount !== null ? `, x-markdown-tokens=${md.tokenCount}` : ''})` : 'no'}` +
      `${md.missingVaryAccept ? ' [MISSING Vary: Accept!]' : ''}` +
      `${md.csrEmptyShellTrap ? ' [CSR EMPTY-SHELL TRAP!]' : ''}`,
    );
  }
  lines.push('');

  // Robots.txt (18-bot when robotsPolicy present, otherwise 9-bot fallback)
  lines.push(`robots.txt (${report.robotsTxt.url} — HTTP ${report.robotsTxt.status ?? 'ERR'})`);
  lines.push('-'.repeat(68));
  if (report.robotsTxt.error) {
    lines.push(`  Error: ${report.robotsTxt.error}`);
  }
  if (report.robotsPolicy) {
    const rp = report.robotsPolicy;
    const realBots = rp.bots.filter((b) => b.category !== 'policy_signal');
    const policySignals = rp.bots.filter((b) => b.category === 'policy_signal');
    const allowedNum = v2Report ? v2Report.aiBotsAllowed.allowed : realBots.filter((b) => b.allowed).length;
    const totalNum = v2Report ? v2Report.aiBotsAllowed.total : realBots.length;
    lines.push(
      `  18-Bot Summary:   ${allowedNum}/${totalNum} allowed` +
      (rp.summary.searchRetrievalBlocked.length ? ` | search blocked: ${rp.summary.searchRetrievalBlocked.join(', ')}` : '') +
      (rp.summary.mixedSearchAiBlocked.length ? ` | mixed blocked: ${rp.summary.mixedSearchAiBlocked.join(', ')}` : ''),
    );
    for (const b of realBots) {
      const botCol = b.token.padEnd(20);
      const catCol = b.category.padEnd(17);
      const stCol = b.status.padEnd(15);
      const srcCol = b.source ? ` [${b.source}]` : '';
      lines.push(`  ${botCol} ${catCol} ${stCol} rule=${b.rule ?? '—'}${srcCol}`);
    }
    if (policySignals.length > 0) {
      lines.push(
        `  Policy Signals:   ` +
        policySignals.map((s) => `${s.token}=${s.allowed ? 'allow' : 'disallow'}`).join(', '),
      );
    }
    if (rp.cloudflareManaged.detected) {
      lines.push(
        `  CF Managed Block: detected (${rp.cloudflareManaged.contradictions.length} contradiction(s))`,
      );
    }
    const effSigEntries = Object.entries(rp.contentSignals.effective);
    if (effSigEntries.length > 0 || rp.contentSignals.conflicts.length > 0) {
      lines.push(
        `  Content-Signal:   ${effSigEntries.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}` +
        (rp.contentSignals.conflicts.length > 0 ? ` [${rp.contentSignals.conflicts.length} CONFLICT(S)]` : ''),
      );
    }
  } else {
    for (const c of report.robotsTxt.crawlers) {
      const botCol = c.bot.padEnd(18);
      const statusCol = c.status.padEnd(16);
      const groupCol = (c.matchedGroup ?? 'none').padEnd(16);
      lines.push(`  ${botCol} ${statusCol} group=${groupCol} rule=${c.rule ?? '—'}`);
    }
  }
  lines.push('');

  // Payload, Truncation Budget & Extraction Forensics
  lines.push('Raw HTML Payload, Truncation Budget & Extraction Forensics');
  lines.push('-'.repeat(68));
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
  if (report.extraction) {
    const ext = report.extraction.extracted;
    const f = report.extraction.forensics;
    lines.push(
      `  Payload-to-Prose:     ${f.payloadToProseRatio}x (html-weight-tier=${f.rawHtmlCliffs.tier}, >2MB=${f.rawHtmlCliffs.exceeds2MB ? 'YES' : 'no'})` +
      (f.nextFlightBytes > 0 ? `, Next RSC=${formatBytes(f.nextFlightBytes)}` : '') +
      (f.nextDataBytes > 0 ? `, __NEXT_DATA__=${formatBytes(f.nextDataBytes)}` : ''),
    );
    lines.push(
      `  Extracted Markdown:   ${ext.wordCount} words / ${ext.charCount} chars (~${ext.estimatedTokens} tokens, engine=${ext.engine}, status=${f.markdownTruncation.status})`,
    );
    lines.push(
      `  Hidden/Nosnippet:     collapsed=${(f.collapsedShare * 100).toFixed(1)}%${f.collapsedShareWarning ? ' [WARN]' : ''}, ` +
      `data-nosnippet=${(f.dataNosnippetShare * 100).toFixed(1)}%${f.dataNosnippetWarning ? ' [WARN]' : ''}, ` +
      `DOM~${f.domNodeEstimate} (${f.domNodeStatus})`,
    );
    if (f.jsonLdCrossCheck.checkedCount > 0) {
      lines.push(
        `  JSON-LD Cross-Check:  ${f.jsonLdCrossCheck.matchedCount}/${f.jsonLdCrossCheck.checkedCount} values visible` +
        (f.jsonLdCrossCheck.missingCount > 0 ? ` (${f.jsonLdCrossCheck.missingCount} missing)` : ''),
      );
    }
  }
  lines.push(`  CSR Empty-Shell Risk: ${p.csrRisk.level.toUpperCase()}${p.csrRisk.spaRoots.length ? ` (roots: ${p.csrRisk.spaRoots.join(', ')})` : ''}`);
  for (const reason of p.csrRisk.reasons) {
    lines.push(`      - ${reason}`);
  }
  lines.push('');

  // Bot-vs-Human / Browser DOM Diff
  lines.push('Bot-vs-Human / Browser DOM Diff');
  lines.push('-'.repeat(68));
  if (report.browserDiff.status === 'ok') {
    lines.push(`  Engine:           ${report.browserDiff.engine ?? 'browser'}`);
    lines.push(
      `  Raw vs Rendered:  ${report.browserDiff.rawWordCount} -> ${report.browserDiff.renderedWordCount} words ` +
      `(+${report.browserDiff.addedWordCount}, gap=${report.browserDiff.hydrationGap}` +
      `${report.proseParityPct !== null && report.proseParityPct !== undefined ? `, Prose Parity=${report.proseParityPct}%` : ''})`,
    );
    if (report.botVsHumanDiff && report.botVsHumanDiff.human) {
      const bvh = report.botVsHumanDiff;
      lines.push(
        `  Structural Loss:  missing headings=${bvh.missingHeadings.length}, lost tables=${bvh.lostTables}, lost code blocks=${bvh.lostCodeBlocks}`,
      );
      if (bvh.missingHeadings.length > 0) {
        lines.push(`  Missing Headings: ${bvh.missingHeadings.slice(0, 5).map((h) => `h${h.level} "${h.text}"`).join(' | ')}`);
      }
      if (bvh.hunks.length > 0) {
        lines.push('  Diff Excerpt (bot vs rendered human DOM):');
        let shown = 0;
        for (const hunk of bvh.hunks.slice(0, 2)) {
          lines.push(`    @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
          for (const entry of hunk.lines) {
            if (shown >= 14) break;
            const prefix = entry.type === 'add' ? '+' : entry.type === 'remove' ? '-' : ' ';
            lines.push(`    ${prefix} ${truncatePreview(entry.line, 100)}`);
            shown += 1;
          }
        }
      }
    }
  } else {
    lines.push(`  Status: ${report.browserDiff.status} — ${report.browserDiff.reason ?? 'not run'}`);
  }
  lines.push('');

  // Stack Remediation
  if (report.remediation && report.remediation.recipes.length > 0) {
    lines.push(`Copy-Paste Stack Remediation (${report.remediation.recipes.length} recipe${report.remediation.recipes.length === 1 ? '' : 's'})`);
    lines.push('-'.repeat(68));
    for (const r of report.remediation.recipes) {
      lines.push(`  [${r.priority.toUpperCase()} · ${r.stackName}] ${r.title}`);
      lines.push(`      Trigger: ${r.trigger}`);
      for (const [idx, step] of r.steps.entries()) {
        lines.push(`      ${idx + 1}. ${step}`);
      }
      if (r.snippet) {
        lines.push('      --- snippet ---');
        for (const sl of r.snippet.split('\n')) {
          lines.push(`      ${sl}`);
        }
      }
    }
    lines.push('');
  }

  // Competitor X-Ray (--vs)
  if (v2Report && v2Report.competitorXray) {
    lines.push('Competitor X-Ray (--vs)');
    lines.push('-'.repeat(68));
    lines.push(
      `  ${'Domain'.padEnd(28)} ${'Status'.padEnd(14)} ${'AI Bots'.padEnd(9)} ${'Parity'.padEnd(8)} ${'Ratio'.padEnd(8)} ${'Words'.padEnd(7)} ${'MD'.padEnd(4)} Crit`,
    );
    for (const row of v2Report.competitorXray.rows) {
      const domLabel = `${row.isTarget ? '* ' : '  '}${truncatePreview(row.domain, 25)}`.padEnd(28);
      const stCol = truncatePreview(row.status, 13).padEnd(14);
      const botsCol = `${row.aiBotsAllowed.allowed}/${row.aiBotsAllowed.total}`.padEnd(9);
      const parityCol = (row.proseParityPct !== null ? `${row.proseParityPct}%` : '—').padEnd(8);
      const ratioCol = (row.payloadToProseRatio !== null ? `${row.payloadToProseRatio}x` : '—').padEnd(8);
      const wordsCol = String(row.rawWordsHomepage ?? '—').padEnd(7);
      const mdCol = (row.markdownNegotiation ? 'yes' : 'no').padEnd(4);
      lines.push(`  ${domLabel} ${stCol} ${botsCol} ${parityCol} ${ratioCol} ${wordsCol} ${mdCol} ${row.criticalCount}`);
    }
    if (v2Report.competitorXray.competitorLeads.length > 0) {
      lines.push('  Competitor Leads:');
      for (const d of v2Report.competitorXray.competitorLeads.slice(0, 6)) {
        lines.push(`    - ${d.summary}`);
      }
    }
    lines.push('');
  }

  // Baseline Regression Diff
  if (v2Report && v2Report.baselineDiff) {
    const bd = v2Report.baselineDiff;
    lines.push(`Baseline Regression Diff (${bd.hasRegression ? 'REGRESSION DETECTED' : 'NO REGRESSION'})`);
    lines.push('-'.repeat(68));
    lines.push(
      `  New Criticals: ${bd.newCriticalFindings.length} | Status Regressions: ${bd.statusRegressions.length} | ` +
      `Parity Drops: ${bd.proseParityDrops.length} | Newly Blocked Bots: ${bd.newlyBlockedBots.length} | ` +
      `New Soft-404s: ${bd.newSoft404s.length} | Ignored Word Noise (<${Math.round(bd.wordCountNoiseFloor * 100)}%): ${bd.ignoredWordCountNoise}`,
    );
    lines.push('');
  }

  // CI Gate Verdict
  if (v2Report && (!v2Report.ciGate.passed || v2Report.ciGate.reasons.length > 0 || v2Report.ciGate.ignoredCount > 0)) {
    lines.push('CI Quality Gate');
    lines.push('-'.repeat(68));
    lines.push(
      `  Verdict: ${v2Report.ciGate.passed ? 'PASS' : 'FAIL'} (exit code ${v2Report.ciGate.exitCode})` +
      (v2Report.ciGate.reasons.length > 0 ? ` — ${v2Report.ciGate.reasons.join(', ')}` : ''),
    );
    lines.push('');
  }

  lines.push('Epistemic Disclaimers');
  lines.push('-'.repeat(68));
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
 * Clamp a numeric percentage cleanly to [0, 100] with 1 decimal place.
 * @param {number} val
 * @returns {number}
 */
function clampPct(val) {
  if (!Number.isFinite(val)) return 0;
  return Number(Math.max(0, Math.min(100, val)).toFixed(1));
}

/**
 * Render a self-contained, printable HTML5 audit report with strict HTML escaping.
 * Handles both v1 `SiteCheckReport` and full v2 `SiteCheckV2Report`.
 * Zero external network assets, zero inline scripts.
 *
 * @param {SiteCheckReport | SiteCheckV2Report} report
 * @returns {string}
 */
export function renderSiteCheckHtml(report) {
  const v2Report = isV2Report(report) ? report : null;
  const grade = report.summary.grade;
  const gradeClass = grade === 'fail' ? 'badge-fail' : grade === 'warn' ? 'badge-warn' : 'badge-pass';
  const stackBadges = collectStackBadges(report);
  const p = report.payload;
  const ext = report.extraction ?? null;
  const f = ext?.forensics ?? null;

  // Header status pills (Audited / Skipped / Errored + Stack/CDN/WAF badges)
  const scopePillsHtml = v2Report
    ? `<div class="pill-row">` +
      `<span class="badge badge-pass">Audited: ${escapeHtml(v2Report.counts.audited)}</span>` +
      `<span class="badge ${v2Report.counts.skipped > 0 ? 'badge-warn' : 'badge-neutral'}">Skipped: ${escapeHtml(v2Report.counts.skipped)}</span>` +
      `<span class="badge ${v2Report.counts.errored > 0 ? 'badge-fail' : 'badge-neutral'}">Errored: ${escapeHtml(v2Report.counts.errored)}</span>` +
      `<span class="badge badge-info">Mode: ${escapeHtml(v2Report.mode)}</span>` +
      stackBadges.map((b) => `<span class="badge badge-stack">${escapeHtml(b)}</span>`).join('') +
      `</div>`
    : stackBadges.length > 0
      ? `<div class="pill-row">${stackBadges.map((b) => `<span class="badge badge-stack">${escapeHtml(b)}</span>`).join('')}</div>`
      : '';

  // Hard Gate Banner
  const hardGateBannerHtml =
    v2Report && v2Report.hardGate.triggered
      ? `<section class="hard-gate-banner">` +
        `<strong>HARD INFRASTRUCTURE GATE &mdash; DOWNSTREAM NOT OBSERVED</strong>` +
        `<div>Reason: <code>${escapeHtml(v2Report.hardGate.reason)}</code> &middot; ${escapeHtml(v2Report.hardGate.detail ?? '')}</div>` +
        `</section>`
      : '';

  // AI Crawlers KPI count (18-bot when robotsPolicy available, honoring RFC 9309 5xx disallow)
  const realBotList = report.robotsPolicy
    ? report.robotsPolicy.bots.filter((b) => b.category !== 'policy_signal')
    : null;
  const botsAllowedNum = v2Report
    ? v2Report.aiBotsAllowed.allowed
    : realBotList
      ? realBotList.filter((b) => b.allowed).length
      : report.robotsTxt.allowedCount;
  const botsTotalNum = v2Report
    ? v2Report.aiBotsAllowed.total
    : realBotList
      ? realBotList.length
      : report.robotsTxt.crawlers.length;

  // Visual Truncation Budget Bars (Raw HTML 30KB / 100KB / 300KB / 2MB + Markdown 50K / 100K)
  const rawHtmlScaleMax = 2 * 1024 * 1024;
  const rawHtmlPct = clampPct((p.htmlBytes / rawHtmlScaleMax) * 100);
  const firstH1Pct = p.offsets.firstH1Bytes !== null ? clampPct((p.offsets.firstH1Bytes / rawHtmlScaleMax) * 100) : null;
  const rawBarClass =
    p.htmlBytes > rawHtmlScaleMax
      ? 'bar-fail'
      : p.htmlBytes > KB_300 || p.truncationRisks.coreContentPast100KB
        ? 'bar-warn'
        : 'bar-pass';

  const mdChars = ext ? ext.extracted.charCount : null;
  const mdPct = mdChars !== null ? clampPct((mdChars / 100_000) * 100) : 0;
  const mdBarClass =
    mdChars !== null && mdChars > 100_000 ? 'bar-fail' : mdChars !== null && mdChars > 50_000 ? 'bar-warn' : 'bar-pass';

  // Payload-to-Prose stacked breakdown bar
  let payloadBreakdownHtml = '';
  if (f && f.rawHtmlBytes > 0) {
    const total = Math.max(1, f.rawHtmlBytes);
    const proseBytes = Math.min(total, f.visibleProseBytes);
    const rscBytes = Math.min(total - proseBytes, f.nextFlightBytes + f.nextDataBytes);
    const inlineJsCss = Math.min(
      Math.max(0, total - proseBytes - rscBytes),
      Math.max(0, f.inlineJsCssBytes - rscBytes),
    );
    const mediaBytes = Math.min(
      Math.max(0, total - proseBytes - rscBytes - inlineJsCss),
      f.inlineSvgBytes + f.base64ImageBytes,
    );
    const markupBytes = Math.max(0, total - proseBytes - rscBytes - inlineJsCss - mediaBytes);

    const prosePct = clampPct((proseBytes / total) * 100);
    const rscPct = clampPct((rscBytes / total) * 100);
    const jsCssPct = clampPct((inlineJsCss / total) * 100);
    const mediaPct = clampPct((mediaBytes / total) * 100);
    const markupPct = clampPct((markupBytes / total) * 100);

    payloadBreakdownHtml =
      `<div class="budget-card">` +
      `<div class="budget-header"><strong>Payload-to-Prose Breakdown</strong> <span>Ratio: <code>${escapeHtml(f.payloadToProseRatio)}x</code> &middot; Weight tier: <code>${escapeHtml(f.rawHtmlCliffs.tier)}</code> &middot; DOM nodes: <code>~${escapeHtml(f.domNodeEstimate)}</code> (${escapeHtml(f.domNodeStatus)})</span></div>` +
      `<div class="stacked-bar" aria-label="Payload breakdown">` +
      `<span class="seg-prose" style="width:${prosePct}%" title="Visible Prose"></span>` +
      `<span class="seg-rsc" style="width:${rscPct}%" title="Next.js RSC / __NEXT_DATA__"></span>` +
      `<span class="seg-jscss" style="width:${jsCssPct}%" title="Inline JS/CSS"></span>` +
      `<span class="seg-media" style="width:${mediaPct}%" title="Inline SVG / Base64"></span>` +
      `<span class="seg-markup" style="width:${markupPct}%" title="HTML Markup / Other"></span>` +
      `</div>` +
      `<div class="legend">` +
      `<span><i class="dot dot-prose"></i>Prose ${escapeHtml(formatBytes(proseBytes))} (${prosePct}%)</span>` +
      `<span><i class="dot dot-rsc"></i>Next RSC/Data ${escapeHtml(formatBytes(rscBytes))} (${rscPct}%)</span>` +
      `<span><i class="dot dot-jscss"></i>Inline JS/CSS ${escapeHtml(formatBytes(inlineJsCss))} (${jsCssPct}%)</span>` +
      `<span><i class="dot dot-media"></i>SVG/Base64 ${escapeHtml(formatBytes(mediaBytes))} (${mediaPct}%)</span>` +
      `<span><i class="dot dot-markup"></i>Markup ${escapeHtml(formatBytes(markupBytes))} (${markupPct}%)</span>` +
      `</div>` +
      `<div class="forensics-pills">` +
      `<span class="badge ${f.collapsedShareWarning ? 'badge-warn' : 'badge-neutral'}">Collapsed text: ${escapeHtml((f.collapsedShare * 100).toFixed(1))}%</span>` +
      `<span class="badge ${f.dataNosnippetWarning ? 'badge-warn' : 'badge-neutral'}">data-nosnippet: ${escapeHtml((f.dataNosnippetShare * 100).toFixed(1))}%</span>` +
      `<span class="badge ${f.jsonLdCrossCheck.missingCount > 0 ? 'badge-warn' : 'badge-neutral'}">JSON-LD visible: ${escapeHtml(f.jsonLdCrossCheck.matchedCount)}/${escapeHtml(f.jsonLdCrossCheck.checkedCount)}</span>` +
      (f.embeddedSvgTitlesIgnored > 0 ? `<span class="badge badge-info">SVG &lt;title&gt; ignored: ${escapeHtml(f.embeddedSvgTitlesIgnored)}</span>` : '') +
      `</div>` +
      `</div>`;
  }

  const truncationVisualHtml =
    `<div class="budget-card">` +
    `<div class="budget-header"><strong>Raw HTML Truncation Budget</strong> <span>${escapeHtml(formatBytes(p.htmlBytes))} / 2.0 MB Googlebot cap</span></div>` +
    `<div class="budget-track">` +
    `<div class="budget-fill ${rawBarClass}" style="width:${Math.max(rawHtmlPct, p.htmlBytes > 0 ? 1.5 : 0)}%"></div>` +
    (firstH1Pct !== null ? `<div class="budget-marker" style="left:${firstH1Pct}%" title="First H1 offset"></div>` : '') +
    `</div>` +
    `<div class="cliff-marks">` +
    `<span class="${p.truncationRisks.contentStartsAfter30KB ? 'cliff-hit' : ''}">30 KB start: ${p.truncationRisks.contentStartsAfter30KB ? 'EXCEEDED' : 'ok'}</span>` +
    `<span class="${p.truncationRisks.coreContentPast100KB ? 'cliff-hit' : ''}">100 KB core: ${p.truncationRisks.coreContentPast100KB ? 'EXCEEDED' : 'ok'}</span>` +
    `<span class="${p.truncationRisks.pageExceeds300KB ? 'cliff-hit' : ''}">300 KB page: ${p.truncationRisks.pageExceeds300KB ? 'EXCEEDED' : 'ok'}</span>` +
    `<span class="${f?.rawHtmlCliffs.exceeds2MB ? 'cliff-hit' : ''}">2 MB Googlebot: ${f?.rawHtmlCliffs.exceeds2MB ? 'EXCEEDED' : 'ok'}</span>` +
    `</div>` +
    (mdChars !== null
      ? `<div class="budget-header" style="margin-top:0.85rem"><strong>Extracted Markdown Budget (${escapeHtml(ext?.extracted.engine ?? 'fallback')})</strong> <span>${escapeHtml(mdChars.toLocaleString('en-US'))} chars (~${escapeHtml(ext?.extracted.estimatedTokens ?? 0)} tokens) &middot; 50K warn / 100K fail</span></div>` +
        `<div class="budget-track"><div class="budget-fill ${mdBarClass}" style="width:${Math.max(mdPct, mdChars > 0 ? 1.5 : 0)}%"></div></div>`
      : '') +
    `</div>` +
    payloadBreakdownHtml;

  // Side-by-Side Visual Bot vs Human Diff
  const bvh = report.botVsHumanDiff ?? null;
  let botVsHumanVisualHtml = '';
  if (bvh && bvh.human) {
    const parityDisplay = bvh.proseParityRatio !== null ? `${(bvh.proseParityRatio * 100).toFixed(1)}%` : '—';
    const missingHeadingsHtml =
      bvh.missingHeadings.length > 0
        ? `<div class="diff-callout diff-callout-warn"><strong>Missing Headings (invisible to non-JS bots):</strong> ` +
          bvh.missingHeadings
            .slice(0, 12)
            .map((h) => `<code>h${escapeHtml(h.level)} ${escapeHtml(h.text)}</code>`)
            .join(' ') +
          `</div>`
        : '';
    const hunksHtml =
      bvh.hunks.length > 0
        ? `<div class="diff-hunks">` +
          bvh.hunks
            .slice(0, 6)
            .map(
              (hunk) =>
                `<div class="hunk-hdr">@@ -${escapeHtml(hunk.oldStart)},${escapeHtml(hunk.oldLines)} +${escapeHtml(hunk.newStart)},${escapeHtml(hunk.newLines)} @@</div>` +
                hunk.lines
                  .slice(0, 40)
                  .map((entry) => {
                    const cls = entry.type === 'add' ? 'diff-add' : entry.type === 'remove' ? 'diff-rem' : 'diff-ctx';
                    const prefix = entry.type === 'add' ? '+ ' : entry.type === 'remove' ? '- ' : '  ';
                    return `<div class="diff-line ${cls}">${escapeHtml(prefix + entry.line)}</div>`;
                  })
                  .join(''),
            )
            .join('') +
          `</div>`
        : '<p class="muted">Zero line differences between bot-extracted Markdown and human-rendered DOM Markdown.</p>';

    botVsHumanVisualHtml =
      `<div class="pill-row" style="margin-bottom:0.65rem">` +
      `<span class="badge ${(bvh.proseParityRatio ?? 1) < 0.7 ? 'badge-fail' : 'badge-pass'}">Prose Parity: ${escapeHtml(parityDisplay)}</span>` +
      `<span class="badge ${bvh.missingHeadings.length > 0 ? 'badge-fail' : 'badge-pass'}">Missing Headings: ${escapeHtml(bvh.missingHeadings.length)}</span>` +
      `<span class="badge ${bvh.lostTables > 0 ? 'badge-fail' : 'badge-pass'}">Lost Tables: ${escapeHtml(bvh.lostTables)}</span>` +
      `<span class="badge ${bvh.lostCodeBlocks > 0 ? 'badge-warn' : 'badge-pass'}">Lost Code Blocks: ${escapeHtml(bvh.lostCodeBlocks)}</span>` +
      `<span class="badge badge-info">+${escapeHtml(bvh.diffSummary.addedLines)} human-only / -${escapeHtml(bvh.diffSummary.removedLines)} bot-only lines</span>` +
      `</div>` +
      missingHeadingsHtml +
      `<div class="side-by-side">` +
      `<div class="diff-pane">` +
      `<div class="pane-title">What Non-JS AI Bots See (Raw HTML &rarr; Markdown &middot; ${escapeHtml(bvh.bot.wordCount)} words, ${escapeHtml(bvh.bot.headings.length)} headings, ${escapeHtml(bvh.bot.tablesCount)} tables)</div>` +
      `<pre class="md-preview">${escapeHtml(truncatePreview(bvh.bot.markdown || '(empty — 0 visible words extracted)', 3500))}</pre>` +
      `</div>` +
      `<div class="diff-pane">` +
      `<div class="pane-title">What Humans See (Rendered DOM &rarr; Markdown &middot; ${escapeHtml(bvh.human.wordCount)} words, ${escapeHtml(bvh.human.headings.length)} headings, ${escapeHtml(bvh.human.tablesCount)} tables)</div>` +
      `<pre class="md-preview">${escapeHtml(truncatePreview(bvh.human.markdown || '(empty)', 3500))}</pre>` +
      `</div>` +
      `</div>` +
      `<h3>Line-Level Diff Hunks (<code>-</code> bot-only / <code>+</code> rendered human-only)</h3>` +
      hunksHtml;
  } else if (ext) {
    botVsHumanVisualHtml =
      `<p class="muted"><strong>Browser DOM diff:</strong> ${escapeHtml(report.browserDiff.status)} &mdash; ${escapeHtml(report.browserDiff.reason ?? 'Pass --browser to render human DOM side-by-side.')}</p>` +
      `<div class="diff-pane">` +
      `<div class="pane-title">What Non-JS AI Bots Actually See (Extracted Markdown &middot; ${escapeHtml(ext.extracted.wordCount)} words, ${escapeHtml(ext.extracted.headings.length)} headings, ${escapeHtml(ext.extracted.tablesCount)} tables, ${escapeHtml(ext.extracted.codeBlocksCount)} code blocks)</div>` +
      `<pre class="md-preview">${escapeHtml(truncatePreview(ext.extracted.markdown || '(empty — 0 visible words extracted)', 3000))}</pre>` +
      `</div>`;
  } else {
    botVsHumanVisualHtml =
      report.browserDiff.status === 'ok'
        ? `<dl class="kv">` +
          `<dt>Engine</dt><dd><code>${escapeHtml(report.browserDiff.engine ?? 'browser')}</code></dd>` +
          `<dt>Raw vs Rendered Words</dt><dd>${escapeHtml(report.browserDiff.rawWordCount)} &rarr; ${escapeHtml(report.browserDiff.renderedWordCount)} (+${escapeHtml(report.browserDiff.addedWordCount)})</dd>` +
          `<dt>Hydration Gap</dt><dd><strong>${escapeHtml(report.browserDiff.hydrationGap ?? 'none')}</strong></dd>` +
          `<dt>Rendered Title</dt><dd>${escapeHtml(report.browserDiff.renderedTitle ?? '—')}</dd>` +
          `</dl>`
        : `<p class="muted"><strong>${escapeHtml(report.browserDiff.status)}</strong>: ${escapeHtml(report.browserDiff.reason ?? 'not run')}</p>`;
  }

  // Findings & Template Clusters
  const findingsHtml =
    report.findings.length === 0
      ? '<p class="muted">No crawlability, indexing, truncation, or CSR issues detected.</p>'
      : `<ul class="findings">${report.findings
          .map(
            (item) =>
              `<li class="finding finding-${escapeHtml(item.severity)}">` +
              `<span class="badge badge-${escapeHtml(item.severity)}">${escapeHtml(item.severity.toUpperCase())}</span> ` +
              `<code>${escapeHtml(item.id)}</code> ` +
              `<strong>${escapeHtml(item.title)}</strong>` +
              `<div class="finding-detail">${escapeHtml(item.detail)}</div>` +
              `</li>`,
          )
          .join('')}</ul>`;

  const clustersHtml =
    v2Report && (v2Report.clusters.siteWide.length > 0 || v2Report.clusters.templateClusters.length > 0)
      ? `<h2>Template-Clustered Findings</h2>` +
        `<ul class="findings">` +
        v2Report.clusters.siteWide
          .map(
            (sw) =>
              `<li class="finding">` +
              `<span class="badge badge-${escapeHtml(sw.severity)}">SITE-WIDE &middot; ${escapeHtml(sw.severity.toUpperCase())}</span> ` +
              `<strong>${escapeHtml(sw.summary)}</strong>` +
              `</li>`,
          )
          .join('') +
        v2Report.clusters.templateClusters
          .map(
            (tc) =>
              `<li class="finding">` +
              `<span class="badge badge-${escapeHtml(tc.severity)}">${escapeHtml(tc.template)} &middot; ${escapeHtml(tc.affectedCount)}/${escapeHtml(tc.totalInTemplate)} pages</span> ` +
              `<strong>${escapeHtml(tc.summary)}</strong>` +
              `<div class="finding-detail">Samples: ${tc.sampleUrls.map((u) => renderSafeLink(u)).join(', ')}</div>` +
              `</li>`,
          )
          .join('') +
        `</ul>`
      : '';

  // Copy-Paste Remediation Cards
  const remediationHtml =
    report.remediation && report.remediation.recipes.length > 0
      ? `<h2>Copy-Paste Stack Remediation (${escapeHtml(report.remediation.recipes.length)})</h2>` +
        `<div class="remediation-list">` +
        report.remediation.recipes
          .map(
            (r) =>
              `<article class="remediation-card">` +
              `<div class="remediation-hdr">` +
              `<span class="badge badge-${r.priority === 'critical' ? 'fail' : r.priority === 'high' ? 'warn' : 'info'}">${escapeHtml(r.priority.toUpperCase())}</span>` +
              `<span class="badge badge-stack">${escapeHtml(r.stackName)} (${escapeHtml(r.layer)})</span>` +
              `<strong>${escapeHtml(r.title)}</strong>` +
              `</div>` +
              `<p class="muted" style="margin:0.35rem 0 0.5rem">${escapeHtml(r.trigger)}</p>` +
              `<ol class="remediation-steps">${r.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` +
              (r.snippet
                ? `<pre class="code-snippet"><code>${escapeHtml(r.snippet)}</code></pre>`
                : '') +
              `</article>`,
          )
          .join('') +
        `</div>`
      : '';

  // 18-Bot Matrix + Protocol Signals (Cloudflare Managed, Content-Signal, Accept: text/markdown, Vary: Accept)
  const protocolCardsHtml = (() => {
    /** @type {string[]} */
    const cards = [];
    if (report.robotsPolicy) {
      const rp = report.robotsPolicy;
      const cfBadge = rp.cloudflareManaged.contradictions.length > 0
        ? '<span class="badge badge-fail">OVERRIDE CONFLICT</span>'
        : rp.cloudflareManaged.detected
          ? '<span class="badge badge-info">DETECTED</span>'
          : '<span class="badge badge-neutral">NONE</span>';
      cards.push(
        `<div class="card"><div class="card-label">Cloudflare Managed robots.txt</div>` +
        `<div class="card-value" style="font-size:1rem">${cfBadge}</div>` +
        `<div class="muted" style="font-size:0.82rem;margin-top:0.25rem">${escapeHtml(
          rp.cloudflareManaged.contradictions.length > 0
            ? rp.cloudflareManaged.contradictions.map((c) => c.agent).join(', ')
            : rp.cloudflareManaged.detected
              ? `${rp.cloudflareManaged.managedAgents.length} managed agent(s), no contradictions`
              : 'No Cloudflare Managed block found',
        )}</div></div>`,
      );

      const csEntries = Object.entries(rp.contentSignals.effective).map(([k, v]) => `${k}=${v}`).join(', ');
      const csBadge = rp.contentSignals.conflicts.length > 0
        ? '<span class="badge badge-warn">CONFLICT</span>'
        : rp.contentSignals.suppressesSearch
          ? '<span class="badge badge-fail">SEARCH=NO</span>'
          : csEntries
            ? '<span class="badge badge-info">PRESENT</span>'
            : '<span class="badge badge-neutral">NONE</span>';
      cards.push(
        `<div class="card"><div class="card-label">Content-Signal / Content-Usage</div>` +
        `<div class="card-value" style="font-size:1rem">${csBadge}</div>` +
        `<div class="muted" style="font-size:0.82rem;margin-top:0.25rem">${escapeHtml(csEntries || rp.contentSignals.contentUsageRaw || 'No Content-Signal directives')}</div></div>`,
      );
    }
    if (report.markdownNegotiation && report.markdownNegotiation.probed) {
      const md = report.markdownNegotiation;
      const mdBadge = md.csrEmptyShellTrap
        ? '<span class="badge badge-fail">CSR TRAP</span>'
        : md.missingVaryAccept
          ? '<span class="badge badge-fail">MISSING VARY: ACCEPT</span>'
          : md.supported
            ? '<span class="badge badge-pass">SUPPORTED</span>'
            : '<span class="badge badge-neutral">HTML ONLY</span>';
      cards.push(
        `<div class="card"><div class="card-label">Accept: text/markdown</div>` +
        `<div class="card-value" style="font-size:1rem">${mdBadge}</div>` +
        `<div class="muted" style="font-size:0.82rem;margin-top:0.25rem">${escapeHtml(
          md.supported
            ? `${md.wordCount ?? 0} words${md.tokenCount !== null ? ` · ${md.tokenCount} tokens` : ''} · Vary: ${md.vary ?? 'missing'}`
            : `Returned ${md.contentType ?? 'non-markdown'}`,
        )}</div></div>`,
      );
    }
    if (report.caching) {
      const c = report.caching;
      const cacheBadge = c.issues.some((i) => i.severity === 'critical')
        ? '<span class="badge badge-fail">CRITICAL</span>'
        : c.issues.some((i) => i.severity === 'warning')
          ? '<span class="badge badge-warn">WARNING</span>'
          : c.conditionalGetReady
            ? '<span class="badge badge-pass">304 READY</span>'
            : '<span class="badge badge-neutral">NO VALIDATORS</span>';
      cards.push(
        `<div class="card"><div class="card-label">Caching &amp; Vary Hygiene</div>` +
        `<div class="card-value" style="font-size:1rem">${cacheBadge}</div>` +
        `<div class="muted" style="font-size:0.82rem;margin-top:0.25rem">${escapeHtml(
          `ETag: ${c.etag.present ? (c.etag.weak ? 'weak' : 'strong') : 'none'} · Last-Mod: ${c.lastModified.reason}`,
        )}</div></div>`,
      );
    }
    return cards.length > 0 ? `<section class="grid" style="margin-bottom:0.85rem">${cards.join('')}</section>` : '';
  })();

  const crawlersHtml = report.robotsPolicy
    ? `<table><thead><tr><th>Crawler / Signal</th><th>Vendor</th><th>Category</th><th>JS</th><th>Status</th><th>Matched Group</th><th>Winning Rule</th><th>Source</th></tr></thead><tbody>${report.robotsPolicy.bots
        .map((b) => {
          const cls = b.allowed ? 'badge-pass' : b.category === 'training' || b.category === 'policy_signal' ? 'badge-warn' : 'badge-fail';
          return (
            `<tr>` +
            `<td><code>${escapeHtml(b.token)}</code></td>` +
            `<td>${escapeHtml(b.vendor)}</td>` +
            `<td><code>${escapeHtml(b.category)}</code></td>` +
            `<td>${b.executesJs ? 'Yes' : 'No'}</td>` +
            `<td><span class="badge ${cls}">${escapeHtml(b.status)}</span></td>` +
            `<td><code>${escapeHtml(b.matchedGroup ?? '—')}</code></td>` +
            `<td><code>${escapeHtml(b.rule ?? '—')}</code></td>` +
            `<td><code>${escapeHtml(b.source ?? '—')}</code></td>` +
            `</tr>`
          );
        })
        .join('')}</tbody></table>`
    : `<table><thead><tr><th>Crawler</th><th>Status</th><th>Matched Group</th><th>Winning Rule</th></tr></thead><tbody>${report.robotsTxt.crawlers
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

  // Competitor X-Ray Matrix (--vs)
  const competitorHtml =
    v2Report && v2Report.competitorXray
      ? `<h2>Competitor X-Ray Matrix (--vs)</h2>` +
        `<table><thead><tr><th>Domain</th><th>Status</th><th>Audited / Skip / Err</th><th>AI Bots Allowed</th><th>Prose Parity</th><th>Payload / Prose</th><th>Raw Words</th><th>Markdown</th><th>WAF</th><th>Criticals</th></tr></thead><tbody>` +
        v2Report.competitorXray.rows
          .map(
            (row) =>
              `<tr class="${row.isTarget ? 'target-row' : ''}">` +
              `<td><strong>${escapeHtml(row.domain)}</strong>${row.isTarget ? ' <span class="badge badge-info">TARGET</span>' : ''}</td>` +
              `<td><code>${escapeHtml(row.status)}</code></td>` +
              `<td>${escapeHtml(row.audited)} / ${escapeHtml(row.skipped)} / ${escapeHtml(row.errored)}</td>` +
              `<td>${escapeHtml(row.aiBotsAllowed.allowed)} / ${escapeHtml(row.aiBotsAllowed.total)}</td>` +
              `<td>${row.proseParityPct !== null ? `${escapeHtml(row.proseParityPct)}%` : '<span class="muted">—</span>'}</td>` +
              `<td>${row.payloadToProseRatio !== null ? `${escapeHtml(row.payloadToProseRatio)}x` : '<span class="muted">—</span>'}</td>` +
              `<td>${row.rawWordsHomepage !== null ? escapeHtml(row.rawWordsHomepage) : '<span class="muted">—</span>'}</td>` +
              `<td>${row.markdownNegotiation ? '<span class="badge badge-pass">YES</span>' : '<span class="muted">no</span>'}</td>` +
              `<td><code>${escapeHtml(row.wafState)}</code></td>` +
              `<td><span class="badge ${row.criticalCount > 0 ? 'badge-fail' : 'badge-pass'}">${escapeHtml(row.criticalCount)}</span></td>` +
              `</tr>`,
          )
          .join('') +
        `</tbody></table>` +
        (v2Report.competitorXray.competitorLeads.length > 0
          ? `<ul class="findings" style="margin-top:0.75rem">${v2Report.competitorXray.competitorLeads
              .map(
                (d) =>
                  `<li class="finding"><span class="badge badge-warn">COMPETITOR LEAD</span> ${escapeHtml(d.summary)}</li>`,
              )
              .join('')}</ul>`
          : '')
      : '';

  // Skipped / Errored & Multi-Page Crawl Summary
  let crawlPagesHtml = '';
  if (v2Report) {
    const blockingSkips = v2Report.skipped.filter(
      (s) => s.reason === 'robots_disallowed' || s.reason === 'ssrf_blocked',
    );
    const capSkips = v2Report.skipped.filter(
      (s) => s.reason !== 'robots_disallowed' && s.reason !== 'ssrf_blocked',
    );
    /** @type {string[]} */
    const skipSections = [];
    if (blockingSkips.length > 0 || v2Report.errored.length > 0) {
      skipSections.push(
        `<h3>Blocked / Skipped (${escapeHtml(blockingSkips.length)}) &amp; Errored (${escapeHtml(v2Report.errored.length)}) URLs</h3>` +
          `<table><thead><tr><th>Kind</th><th>Reason</th><th>URL</th><th>Detail</th></tr></thead><tbody>` +
          blockingSkips
            .map(
              (s) =>
                `<tr><td><span class="badge badge-warn">SKIPPED</span></td><td><code>${escapeHtml(s.reason)}</code></td><td>${renderSafeLink(s.url)}</td><td>${escapeHtml(s.detail ?? s.rule ?? '—')}</td></tr>`,
            )
            .join('') +
          v2Report.errored
            .map(
              (e) =>
                `<tr><td><span class="badge badge-fail">ERRORED</span></td><td><code>${escapeHtml(e.reason)}</code></td><td>${renderSafeLink(e.url)}</td><td>${escapeHtml(e.error)}</td></tr>`,
            )
            .join('') +
          `</tbody></table>`,
      );
    }
    if (capSkips.length > 0) {
      const capLimit = 15;
      const visibleCapSkips = capSkips.slice(0, capLimit);
      const hiddenCapCount = capSkips.length - visibleCapSkips.length;
      skipSections.push(
        `<details style="margin-top:0.75rem"><summary><strong>Crawl-cap skipped URLs (${escapeHtml(capSkips.length)})</strong> &mdash; <code>max_pages_cap</code> / <code>template_cap</code> (showing ${escapeHtml(visibleCapSkips.length)} of ${escapeHtml(capSkips.length)})</summary>` +
          `<table><thead><tr><th>Kind</th><th>Reason</th><th>URL</th><th>Detail</th></tr></thead><tbody>` +
          visibleCapSkips
            .map(
              (s) =>
                `<tr><td><span class="badge badge-neutral">CAP SKIP</span></td><td><code>${escapeHtml(s.reason)}</code></td><td>${renderSafeLink(s.url)}</td><td>${escapeHtml(s.detail ?? s.rule ?? '—')}</td></tr>`,
            )
            .join('') +
          (hiddenCapCount > 0
            ? `<tr><td colspan="4" class="muted">&hellip; and ${escapeHtml(hiddenCapCount)} more URL(s) omitted by crawl cap (see JSON output for the full list).</td></tr>`
            : '') +
          `</tbody></table></details>`,
      );
    }
    crawlPagesHtml =
      `<h2>Crawled Pages (${escapeHtml(v2Report.pages.length)})</h2>` +
      `<table><thead><tr><th>URL</th><th>Template</th><th>HTTP</th><th>Raw Words</th><th>Payload/Prose</th><th>Findings</th></tr></thead><tbody>` +
      v2Report.pages
        .map(
          (pg) =>
            `<tr>` +
            `<td>${renderSafeLink(pg.finalUrl)}</td>` +
            `<td><code>${escapeHtml(pg.template)}</code></td>` +
            `<td><code>${escapeHtml(pg.status ?? '—')}</code></td>` +
            `<td>${escapeHtml(pg.visibleWordCount)}</td>` +
            `<td>${pg.payloadToProseRatio !== null ? `${escapeHtml(pg.payloadToProseRatio)}x` : '—'}</td>` +
            `<td>${escapeHtml(pg.findings.length)}</td>` +
            `</tr>`,
        )
        .join('') +
      `</tbody></table>` +
      skipSections.join('');
  }

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

  const headingsHtml =
    p.headings.length === 0
      ? '<p class="muted">No h1–h3 headings found in raw HTML.</p>'
      : `<table><thead><tr><th>Tag</th><th>Heading Text</th><th>Raw Byte Offset</th></tr></thead><tbody>${p.headings
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

  const disclaimersHtml = `<ul class="disclaimers">${report.disclaimers
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join('')}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hearsay Pre-Flight Check — ${escapeHtml(report.finalUrl)}</title>
<style>
  :root { color-scheme: light; --bg: #ffffff; --fg: #0f172a; --muted: #64748b; --border: #e2e8f0; --card: #f8fafc; --pass: #065f46; --pass-bg: #d1fae5; --warn: #92400e; --warn-bg: #fef3c7; --fail: #991b1b; --fail-bg: #fee2e2; --info: #1e40af; --info-bg: #dbeafe; --neutral: #475569; --neutral-bg: #f1f5f9; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; max-width: 1120px; margin-inline: auto; }
  h1 { margin: 0 0 0.25rem; font-size: 1.65rem; letter-spacing: -0.02em; }
  h2 { margin: 2rem 0 0.75rem; font-size: 1.15rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35rem; }
  h3 { margin: 1.25rem 0 0.5rem; font-size: 0.98rem; color: #334155; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 4px; word-break: break-word; }
  pre { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; line-height: 1.45; overflow-x: auto; }
  a { color: #1d4ed8; word-break: break-all; }
  .muted { color: var(--muted); }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; padding-bottom: 1rem; border-bottom: 2px solid var(--fg); }
  .pill-row { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.6rem; }
  .badge { display: inline-block; padding: 0.18rem 0.55rem; border-radius: 999px; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.03em; }
  .badge-pass { background: var(--pass-bg); color: var(--pass); }
  .badge-warn, .badge-warning, .badge-attention { background: var(--warn-bg); color: var(--warn); }
  .badge-fail, .badge-critical { background: var(--fail-bg); color: var(--fail); }
  .badge-info { background: var(--info-bg); color: var(--info); }
  .badge-neutral { background: var(--neutral-bg); color: var(--neutral); }
  .badge-stack { background: #ede9fe; color: #5b21b6; }
  .hard-gate-banner { margin-top: 1rem; padding: 0.9rem 1.1rem; border-radius: 8px; background: #fef2f2; border: 2px solid #dc2626; color: #7f1d1d; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(185px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem 1rem; }
  .card-label { font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.04em; }
  .card-value { font-size: 1.25rem; font-weight: 700; margin-top: 0.2rem; }
  .budget-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1rem; margin-top: 0.75rem; }
  .budget-header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; font-size: 0.9rem; margin-bottom: 0.45rem; }
  .budget-track { position: relative; height: 14px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
  .budget-fill { height: 100%; border-radius: 999px; }
  .bar-pass { background: #10b981; }
  .bar-warn { background: #f59e0b; }
  .bar-fail { background: #ef4444; }
  .budget-marker { position: absolute; top: 0; bottom: 0; width: 3px; background: #0f172a; }
  .cliff-marks { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; font-size: 0.78rem; color: var(--muted); margin-top: 0.4rem; }
  .cliff-hit { color: var(--fail); font-weight: 700; }
  .stacked-bar { display: flex; height: 16px; border-radius: 999px; overflow: hidden; background: #e2e8f0; }
  .seg-prose { background: #10b981; }
  .seg-rsc { background: #ef4444; }
  .seg-jscss { background: #f59e0b; }
  .seg-media { background: #8b5cf6; }
  .seg-markup { background: #94a3b8; }
  .legend { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.8rem; color: #334155; margin-top: 0.5rem; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 0.3rem; vertical-align: middle; }
  .dot-prose { background: #10b981; }
  .dot-rsc { background: #ef4444; }
  .dot-jscss { background: #f59e0b; }
  .dot-media { background: #8b5cf6; }
  .dot-markup { background: #94a3b8; }
  .forensics-pills { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.65rem; }
  .side-by-side { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0.85rem; margin-top: 0.5rem; }
  .diff-pane { border: 1px solid var(--border); border-radius: 8px; background: var(--card); overflow: hidden; }
  .pane-title { background: #e2e8f0; padding: 0.45rem 0.75rem; font-size: 0.82rem; font-weight: 700; color: #1e293b; }
  .md-preview { padding: 0.75rem; max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: #ffffff; }
  .diff-callout { padding: 0.6rem 0.85rem; border-radius: 6px; margin-bottom: 0.65rem; font-size: 0.88rem; }
  .diff-callout-warn { background: var(--warn-bg); color: var(--warn); border: 1px solid #fcd34d; }
  .diff-hunks { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; }
  .hunk-hdr { background: #e0f2fe; color: #0369a1; padding: 0.25rem 0.6rem; font-weight: 600; }
  .diff-line { padding: 0.12rem 0.6rem; white-space: pre-wrap; word-break: break-word; }
  .diff-add { background: #dcfce7; color: #14532d; }
  .diff-rem { background: #fee2e2; color: #7f1d1d; }
  .diff-ctx { background: #ffffff; color: #475569; }
  .kv { display: grid; grid-template-columns: minmax(160px, 220px) 1fr; gap: 0.35rem 1rem; margin: 0.5rem 0; }
  .kv dt { font-weight: 600; color: var(--muted); }
  .kv dd { margin: 0; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { background: var(--card); font-weight: 600; }
  .target-row td { background: #eff6ff; }
  .findings { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.55rem; }
  .finding { border: 1px solid var(--border); border-radius: 6px; padding: 0.65rem 0.85rem; background: var(--card); }
  .finding-detail { margin-top: 0.25rem; font-size: 0.88rem; color: #334155; }
  .remediation-list { display: grid; gap: 0.75rem; }
  .remediation-card { border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1rem; background: var(--card); }
  .remediation-hdr { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
  .remediation-steps { margin: 0.4rem 0 0.6rem 1.25rem; padding: 0; font-size: 0.88rem; }
  .remediation-steps li { margin-bottom: 0.25rem; }
  .code-snippet { background: #0f172a; color: #f8fafc; padding: 0.75rem 0.9rem; border-radius: 6px; margin-top: 0.5rem; }
  .code-snippet code { background: transparent; color: inherit; padding: 0; }
  .disclaimers { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 1rem 1.25rem 1rem 2rem; font-size: 0.88rem; }
  .disclaimers li { margin-bottom: 0.4rem; }
  @media print {
    body { padding: 0; max-width: none; font-size: 10.5pt; }
    .card, .finding, .budget-card, .remediation-card, .disclaimers { break-inside: avoid; }
    .md-preview { max-height: none; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <header class="header">
    <div>
      <h1>Hearsay Site Pre-Flight Audit</h1>
      <div class="muted">Checked ${escapeHtml(report.checkedAt)} &middot; ${escapeHtml(report.timingMs)} ms &middot; UA: <code>${escapeHtml(report.userAgent)}</code></div>
      ${scopePillsHtml}
    </div>
    <div><span class="badge ${gradeClass}">${escapeHtml(grade.toUpperCase())}${v2Report ? ` &middot; ${escapeHtml(v2Report.crawlStatus.toUpperCase())}` : ''}</span></div>
  </header>

  ${hardGateBannerHtml}

  <section class="grid">
    <div class="card"><div class="card-label">HTTP Status</div><div class="card-value">${escapeHtml(report.status ?? '—')}</div></div>
    <div class="card"><div class="card-label">Raw HTML Size</div><div class="card-value">${escapeHtml(formatBytes(p.htmlBytes))}</div></div>
    <div class="card"><div class="card-label">Visible Words (Raw)</div><div class="card-value">${escapeHtml(p.visibleWordCount)}</div></div>
    <div class="card"><div class="card-label">Payload / Prose</div><div class="card-value">${f ? `${escapeHtml(f.payloadToProseRatio)}x` : escapeHtml(formatPct(p.codeRatio))}</div></div>
    <div class="card"><div class="card-label">CSR Empty-Shell Risk</div><div class="card-value">${escapeHtml(p.csrRisk.level.toUpperCase())}</div></div>
    <div class="card"><div class="card-label">AI Crawlers Allowed</div><div class="card-value">${escapeHtml(botsAllowedNum)} / ${escapeHtml(botsTotalNum)}</div></div>
  </section>

  <h2>Findings</h2>
  ${findingsHtml}

  ${clustersHtml}

  ${remediationHtml}

  <h2>What AI Bots Actually See vs. What Humans See</h2>
  ${botVsHumanVisualHtml}

  <h2>Truncation Budget &amp; Payload Forensics</h2>
  ${truncationVisualHtml}
  <dl class="kv" style="margin-top:0.85rem">
    <dt>First &lt;h1&gt; Offset</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.firstH1Bytes))}</code></dd>
    <dt>First &ge;80c Paragraph</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.firstSubstantiveParagraphBytes))}</code></dd>
    <dt>Visible Text 25% / 50% / 75% / 90%</dt><dd><code>${escapeHtml(formatBytesOpt(p.offsets.text25PctBytes))}</code> / <code>${escapeHtml(formatBytesOpt(p.offsets.text50PctBytes))}</code> / <code>${escapeHtml(formatBytesOpt(p.offsets.text75PctBytes))}</code> / <code>${escapeHtml(formatBytesOpt(p.offsets.text90PctBytes))}</code></dd>
    <dt>Structure</dt><dd>${escapeHtml(p.headingCount)} headings (h1–h3), ${escapeHtml(p.tableCount)} table(s), ${escapeHtml(p.jsonLdCount)} JSON-LD block(s)${p.jsonLdTypes.length ? ` (${escapeHtml(p.jsonLdTypes.join(', '))})` : ''}</dd>
    <dt>CSR Empty-Shell Risk</dt><dd><strong>${escapeHtml(p.csrRisk.level.toUpperCase())}</strong>${p.csrRisk.spaRoots.length ? ` &middot; Roots: <code>${escapeHtml(p.csrRisk.spaRoots.join(', '))}</code>` : ''}</dd>
  </dl>
  ${headingsHtml}

  <h2>AI &amp; Search Crawler Access (18-Bot Matrix &amp; Protocols)</h2>
  <p class="muted">Source: ${renderSafeLink(report.robotsTxt.url)} &middot; HTTP ${escapeHtml(report.robotsTxt.status ?? 'ERR')}${report.robotsTxt.error ? ` &middot; ${escapeHtml(report.robotsTxt.error)}` : ''}</p>
  ${protocolCardsHtml}
  ${crawlersHtml}

  ${competitorHtml}

  ${crawlPagesHtml}

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
    <dt>Server / CF-Ray</dt><dd><code>${escapeHtml(report.headers.server ?? '—')}</code> / <code>${escapeHtml(report.headers.cfRay ?? '—')}</code></dd>
    <dt>Vary</dt><dd><code>${escapeHtml(report.headers.vary ?? '—')}</code></dd>
  </dl>

  <h2>Redirect Chain (${escapeHtml(report.redirects.count)} hop${report.redirects.count === 1 ? '' : 's'})</h2>
  ${redirectsHtml}

  <h2>Epistemic Disclaimers</h2>
  ${disclaimersHtml}
</body>
</html>
`;
}
