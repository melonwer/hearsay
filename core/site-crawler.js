/**
 * Default multi-page key-page crawler, sitemap discovery (.xml & .xml.gz),
 * template-level issue clustering, AIMD politeness, per-hop SSRF guard,
 * conditional GET caching check, and Hard Infrastructure Gate.
 *
 * Pure Node 22 built-ins only — zero external runtime dependencies.
 * Never spoofs AI crawler User-Agents and never marks skipped/blocked pages as PASS.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { gunzipSync } from 'node:zlib';

import {
  AI_CRAWLERS,
  SiteCheckError,
  USER_AGENT,
  analyzeHtmlPayload,
  isPrivateIp,
  parseRobotsTxt,
  validateSiteUrl,
} from './site-check.js';

export const DEFAULT_MAX_PAGES = 15;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_MAX_REDIRECTS = 10;
export const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
export const MAX_SITEMAP_DEPTH = 2;
export const MAX_SITEMAP_URLS = 500;
export const MAX_CRAWL_DELAY_MS = 3_000;
export const DEFAULT_MAX_PER_TEMPLATE = 2;
export const MAX_CLUSTER_SAMPLE_URLS = 5;

const CHALLENGE_MAX_TEXT_CHARS = 1_000;
const SOFT_404_MAX_TEXT_CHARS = 1_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const HIGH_INTENT_SEGMENTS = Object.freeze([
  'pricing',
  'docs',
  'features',
  'compare',
  'about',
  'alternatives',
  'product',
  'faq',
]);

/** @type {Record<string, number>} */
const HIGH_INTENT_ALIAS_RANK = {
  pricing: 0,
  plans: 0,
  docs: 1,
  documentation: 1,
  features: 2,
  compare: 3,
  comparison: 3,
  about: 4,
  alternatives: 5,
  product: 6,
  products: 6,
  faq: 7,
  faqs: 7,
};

const STATIC_ASSET_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|css|m?js|cjs|map|woff2?|ttf|otf|eot|mp4|m4v|mov|webm|mp3|wav|ogg|flac|zip|tar|gz|tgz|bz2|xz|7z|rar|pdf|xml|json|txt|csv|rss|atom|wasm)$/i;

const ARCHIVE_EXT_RE = /\.(?:tar\.gz|tgz|tar\.bz2|tar\.xz|zip)$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH_RE = /^(?=.*\d)[0-9a-f]{16,}$/i;
const ID_TOKEN_RE = /^(?:\d+|(?:id|sku|prod|item|order|ref|uid)[-_]?\d+)$/i;
const YEAR_RE = /^(?:19|20)\d{2}$/;
const MONTH_OR_DAY_RE = /^(?:0?[1-9]|[12]\d|3[01])$/;
const LOCALE_SEGMENT_RE = /^(?:[a-z]{2}(?:-[a-z]{2})?)$/i;

const DOCS_PREFIXES = new Set(['docs', 'documentation', 'guide', 'guides', 'kb', 'help', 'learn', 'reference', 'api']);

const AUTH_OR_UTILITY_ROOT_SEGMENTS = new Set([
  'login',
  'log-in',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'register',
  'logout',
  'log-out',
  'signout',
  'sign-out',
  'auth',
  'oauth',
  'oauth2',
  'sso',
  'reset-password',
  'forgot-password',
  'account',
  'cart',
  'checkout',
  'wp-login.php',
  'wp-admin',
]);

const CHALLENGE_TITLE_MARKERS = Object.freeze([
  'just a moment',
  'attention required',
  'access denied',
  'captcha',
  'checking your browser',
  'vercel security checkpoint',
]);

// Explicitly excludes `cf-chl-` to avoid false positives on Cloudflare Turnstile widgets embedded in normal forms.
const CHALLENGE_HTML_MARKERS = Object.freeze([
  '_cf_chl_opt',
  'checking your browser',
  'anubis_challenge',
  '/_incapsula_resource',
  'captcha-delivery.com',
]);

const SOFT_404_RE = /(?:\b404\b|\bnot\s+found\b|\bpage\s+not\s+found\b)/i;

const SITE_WIDE_CATEGORIES = new Set(['robots', 'waf', 'dns', 'sitemap']);

const SEARCH_RETRIEVAL_BOTS = new Set(['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'PerplexityBot']);
const TRADITIONAL_SEARCH_BOTS = new Set(['Googlebot', 'Bingbot']);

/**
 * @typedef {(hostname: string, opts: {all: true}) => Promise<Array<{address: string, family: number}>>} DnsLookupFn
 */

/**
 * @typedef {Object} RedirectHop
 * @property {number} status
 * @property {string} url
 * @property {string} location
 * @property {string} resolvedUrl
 * @property {boolean} crossHost
 */

/**
 * @typedef {Object} SafeFetchResult
 * @property {Response} response
 * @property {string} finalUrl
 * @property {RedirectHop[]} hops
 * @property {boolean} loopDetected
 * @property {string|null} loopTarget
 * @property {boolean} maxHopsExceeded
 * @property {number} timingMs
 */

/**
 * @typedef {Object} SitemapEntry
 * @property {string} url
 * @property {string|null} lastmod
 * @property {string} sourceSitemap
 */

/**
 * @typedef {Object} SitemapCheckedInfo
 * @property {string} url
 * @property {number|null} status
 * @property {'urlset'|'sitemapindex'|'rejected'|'error'} kind
 * @property {boolean} compressed
 * @property {number} urlCount
 * @property {string|null} reason
 */

/**
 * @typedef {Object} SitemapRejection
 * @property {string} url
 * @property {string} reason
 * @property {string|null} contentType
 */

/**
 * @typedef {Object} SitemapDiscoveryResult
 * @property {string} origin
 * @property {string[]} urls
 * @property {SitemapEntry[]} entries
 * @property {SitemapCheckedInfo[]} sitemapsChecked
 * @property {SitemapRejection[]} rejected
 * @property {boolean} truncated
 */

/**
 * @typedef {Object} DiscoverSitemapOptions
 * @property {string|null} [robotsTxt]
 * @property {string[]} [robotsSitemaps]
 * @property {boolean} [allowPrivateHosts]
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {DnsLookupFn|null} [lookup]
 * @property {number} [timeoutMs]
 * @property {number} [maxDepth]
 * @property {number} [maxUrls]
 * @property {number} [maxSitemapBytes]
 * @property {number} [maxRedirects]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} SelectedPageEntry
 * @property {string} url
 * @property {string} template
 * @property {'homepage'|'high_intent'|'diverse_nav'|'diverse_sitemap'} priority
 * @property {'homepage'|'nav'|'sitemap'} source
 */

/**
 * @typedef {Object} CapSkippedPage
 * @property {string} url
 * @property {string} template
 * @property {'template_cap'|'max_pages_cap'} reason
 */

/**
 * @typedef {Object} SelectKeyPagesResult
 * @property {SelectedPageEntry[]} selected
 * @property {string[]} urls
 * @property {CapSkippedPage[]} skippedByCap
 * @property {Record<string, number>} templateCounts
 */

/**
 * @typedef {Object} PageFinding
 * @property {string} id
 * @property {string} [ruleId]
 * @property {'critical'|'attention'|'warning'|'info'} severity
 * @property {string} category
 * @property {string} title
 * @property {string} detail
 * @property {'site'|'template'|'page'} [scope]
 */

/**
 * @typedef {Object} CrawledPageResult
 * @property {string} url
 * @property {string} finalUrl
 * @property {string} template
 * @property {boolean} isHomepage
 * @property {number|null} status
 * @property {boolean} ok
 * @property {number} timingMs
 * @property {number} htmlBytes
 * @property {number} visibleWordCount
 * @property {number} visibleCharCount
 * @property {number|null} renderedWordCount
 * @property {number|null} proseParityPct
 * @property {number|null} payloadToProseRatio
 * @property {string|null} title
 * @property {string|null} canonical
 * @property {boolean} noindex
 * @property {boolean} soft404
 * @property {boolean} robotsDisallowed
 * @property {'none'|'edge_detected'|'bot_management_active'|'challenge_or_block_intercepted'} wafState
 * @property {string|null} contentType
 * @property {string|null} contentSignal
 * @property {boolean} markdownNegotiation
 * @property {string[]} stack
 * @property {ReturnType<typeof analyzeHtmlPayload>|null} payload
 * @property {{count: number, hops: RedirectHop[], loopDetected: boolean, maxHopsExceeded: boolean}} redirects
 * @property {PageFinding[]} findings
 */

/**
 * @typedef {Object} SkippedPageEntry
 * @property {string} url
 * @property {string} template
 * @property {'robots_disallowed'|'ssrf_blocked'|'max_pages_cap'|'template_cap'|'auth_or_utility_route'} reason
 * @property {string|null} [rule]
 * @property {string|null} [matchedGroup]
 * @property {string|null} [detail]
 */

/**
 * @typedef {Object} ErroredPageEntry
 * @property {string} url
 * @property {string} template
 * @property {string} reason
 * @property {string} error
 */

/**
 * @typedef {Object} HardGateResult
 * @property {boolean} triggered
 * @property {'transport_failure'|'http_403_blocked'|'waf_challenge_intercepted'|'empty_js_shell'|null} reason
 * @property {string|null} detail
 * @property {'blocked_hard_gate'|null} capStatus
 * @property {'not_observed'|'observed'} downstreamStatus
 */

/**
 * @typedef {Object} CachingCheckResult
 * @property {boolean} checked
 * @property {boolean|null} supported304
 * @property {number|null} status
 * @property {string|null} etag
 * @property {string|null} lastModified
 * @property {{ifNoneMatch: string|null, ifModifiedSince: string|null}} sentHeaders
 * @property {number} timingMs
 * @property {string} reason
 */

/**
 * @typedef {Object} TemplateClusterItem
 * @property {string} template
 * @property {number} affectedCount
 * @property {number} totalInTemplate
 * @property {string} ruleId
 * @property {'critical'|'attention'|'warning'|'info'} severity
 * @property {string} summary
 * @property {string[]} sampleUrls
 */

/**
 * @typedef {Object} SiteWideIssueItem
 * @property {string} ruleId
 * @property {'critical'|'attention'|'warning'|'info'} severity
 * @property {string} category
 * @property {number} affectedCount
 * @property {number} totalPages
 * @property {string} summary
 * @property {string[]} sampleUrls
 */

/**
 * @typedef {Object} PageOutlierItem
 * @property {string} url
 * @property {string} template
 * @property {string} ruleId
 * @property {'critical'|'attention'|'warning'|'info'} severity
 * @property {string} title
 * @property {string} detail
 */

/**
 * @typedef {Object} TemplateClusterReport
 * @property {SiteWideIssueItem[]} siteWide
 * @property {TemplateClusterItem[]} templateClusters
 * @property {PageOutlierItem[]} pageOutliers
 * @property {Record<string, number>} templateCounts
 */

/**
 * @typedef {Object} PageCheckerContext
 * @property {string} url
 * @property {string} finalUrl
 * @property {string} template
 * @property {boolean} isHomepage
 * @property {number} status
 * @property {Headers} headers
 * @property {string} html
 * @property {number} htmlBytes
 * @property {number} timingMs
 * @property {{count: number, hops: RedirectHop[], loopDetected: boolean, maxHopsExceeded: boolean}} redirects
 * @property {boolean} robotsDisallowed
 */

/**
 * @typedef {Object} CrawlSiteOptions
 * @property {boolean} [single]
 * @property {number} [maxPages]
 * @property {number} [maxPerTemplate]
 * @property {boolean} [allowPrivateHosts]
 * @property {boolean} [ignoreRobotsForOwnSite]
 * @property {boolean} [includeAuthRoutes]
 * @property {boolean} [checkCaching]
 * @property {(ctx: PageCheckerContext) => Promise<Partial<CrawledPageResult>>|Partial<CrawledPageResult>} [pageChecker]
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {DnsLookupFn|null} [lookup]
 * @property {number} [timeoutMs]
 * @property {number} [maxConcurrency]
 * @property {number} [maxRedirects]
 * @property {number} [maxHtmlBytes]
 * @property {(ms: number) => Promise<void>} [sleepFn]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} CrawlCounts
 * @property {number} discovered
 * @property {number} selected
 * @property {number} audited
 * @property {number} skipped
 * @property {number} errored
 * @property {number} redirectsResolved
 * @property {{robots_disallowed: number, ssrf_blocked: number, max_pages_cap: number, template_cap: number, auth_or_utility_route: number}} skippedByReason
 */

/**
 * @typedef {Object} CrawlSiteReport
 * @property {number} schemaVersion
 * @property {string} crawledAt
 * @property {string} requestedUrl
 * @property {string} finalUrl
 * @property {string} domain
 * @property {'single'|'multi'} mode
 * @property {'pass'|'attention'|'critical'|'blocked_hard_gate'} status
 * @property {'observed'|'not_observed'} downstreamStatus
 * @property {HardGateResult} hardGate
 * @property {boolean} coverageComplete
 * @property {string} scopeSummary
 * @property {CrawlCounts} counts
 * @property {CrawledPageResult[]} pages
 * @property {SkippedPageEntry[]} skipped
 * @property {ErroredPageEntry[]} errored
 * @property {Array<{from: string, to: string, status: number}>} redirectsResolved
 * @property {{
 *   url: string,
 *   status: number|null,
 *   fetched: boolean,
 *   soft404: boolean,
 *   error: string|null,
 *   crawlDelaySec: number|null,
 *   contentSignal: string|null,
 *   sitemaps: string[],
 *   crawlers: Array<{bot: string, allowed: boolean, status: string, rule: string|null, matchedGroup: string|null}>,
 *   blockedCount: number,
 *   allowedCount: number,
 * }} robotsTxt
 * @property {SitemapDiscoveryResult|null} sitemap
 * @property {CachingCheckResult} caching
 * @property {{initialDelayMs: number, finalDelayMs: number, crawlDelayFloorMs: number, slowdowns: number, totalWaitMs: number}} throttle
 * @property {PageFinding[]} siteFindings
 * @property {TemplateClusterReport} clusters
 * @property {number} timingMs
 */

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
 * Check whether a hostname literal refers to a local, internal, metadata, or private IP host.
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
 * Per-hop DNS-resolving SSRF guard. Throws `SiteCheckError('ssrf_blocked', ...)`
 * if the host literal or any resolved IP is private, loopback, or link-local,
 * unless `allowPrivateHosts === true`.
 *
 * @param {URL} parsedUrl
 * @param {{allowPrivateHosts: boolean, lookupFn?: DnsLookupFn|null}} opts
 * @returns {Promise<void>}
 */
export async function assertSafeUrl(parsedUrl, { allowPrivateHosts, lookupFn }) {
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
      return;
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
 * Build an AbortSignal combining per-request timeout and optional caller signal.
 * @param {number} timeoutMs
 * @param {AbortSignal} [callerSignal]
 * @returns {AbortSignal}
 */
function buildSignal(timeoutMs, callerSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
}

/**
 * Fetch a URL with manual redirect traversal, enforcing per-hop DNS-resolving
 * SSRF checks on the initial URL and every redirect target.
 *
 * @param {string} rawUrl
 * @param {{
 *   allowPrivateHosts: boolean,
 *   fetchFn: typeof globalThis.fetch,
 *   lookupFn: DnsLookupFn|null,
 *   timeoutMs: number,
 *   maxRedirects: number,
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<SafeFetchResult>}
 */
async function fetchWithSsrfGuard(rawUrl, opts) {
  const startedAt = Date.now();
  const initialParsed = validateSiteUrl(rawUrl);
  await assertSafeUrl(initialParsed, { allowPrivateHosts: opts.allowPrivateHosts, lookupFn: opts.lookupFn });

  let currentUrl = initialParsed.href;
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

  const baseHeaders = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    ...(opts.headers ?? {}),
  };

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const hopParsed = validateSiteUrl(currentUrl);
    await assertSafeUrl(hopParsed, { allowPrivateHosts: opts.allowPrivateHosts, lookupFn: opts.lookupFn });

    /** @type {Response} */
    let res;
    try {
      res = await opts.fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: baseHeaders,
        signal: buildSignal(opts.timeoutMs, opts.signal),
      });
    } catch (error) {
      if (error instanceof SiteCheckError) throw error;
      const errName = error instanceof Error ? error.name : '';
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new SiteCheckError('timeout', `Request to ${currentUrl} timed out after ${opts.timeoutMs}ms`);
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
        try {
          await assertSafeUrl(nextParsed, { allowPrivateHosts: opts.allowPrivateHosts, lookupFn: opts.lookupFn });
        } catch (err) {
          await res.body?.cancel().catch(() => {});
          throw err;
        }

        const crossHost = nextParsed.hostname.toLowerCase() !== hopParsed.hostname.toLowerCase();
        await res.body?.cancel().catch(() => {});

        if (visited.has(nextParsed.href)) {
          hops.push({
            status: res.status,
            url: currentUrl,
            location,
            resolvedUrl: nextParsed.href,
            crossHost,
          });
          loopDetected = true;
          loopTarget = nextParsed.href;
          finalResponse = res;
          break;
        }
        if (hops.length >= opts.maxRedirects) {
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
        });
        visited.add(nextParsed.href);
        currentUrl = nextParsed.href;
        continue;
      }
    }

    finalResponse = res;
    break;
  }

  if (!finalResponse) {
    throw new SiteCheckError('fetch_failed', `No HTTP response received for ${rawUrl}`);
  }

  return {
    response: finalResponse,
    finalUrl: currentUrl,
    hops,
    loopDetected,
    loopTarget,
    maxHopsExceeded,
    timingMs: Date.now() - startedAt,
  };
}

/**
 * Read a fetch Response body up to `maxBytes`.
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
 * Decode basic XML/HTML entities for `<loc>` and `<a href>` extraction.
 * @param {string} value
 * @returns {string}
 */
function decodeBasicEntities(value) {
  if (!value || !value.includes('&')) return value;
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, named) => {
    if (dec !== undefined) {
      const code = Number.parseInt(dec, 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return m;
    }
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return m;
    }
    if (named === 'amp') return '&';
    if (named === 'lt') return '<';
    if (named === 'gt') return '>';
    if (named === 'quot') return '"';
    if (named === 'apos') return "'";
    return m;
  });
}

/**
 * Normalize a same-site URL for deduplication (strips `#hash` and redundant trailing slash except root).
 * @param {string} rawUrl
 * @param {string} [baseUrl]
 * @returns {string|null}
 */
function normalizeCandidateUrl(rawUrl, baseUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = baseUrl ? new URL(rawUrl.trim(), baseUrl) : new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Test whether a buffer looks like a gzip stream (`0x1f 0x8b`).
 * @param {Buffer} buf
 * @returns {boolean}
 */
function hasGzipMagic(buf) {
  return buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Test whether a buffer looks like a POSIX tar archive (`ustar` at offset 257).
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksLikeTarArchive(buf) {
  if (buf.byteLength >= 263) {
    const magic = buf.subarray(257, 262).toString('ascii');
    if (magic === 'ustar') return true;
  }
  return false;
}

/**
 * Inspect the root XML element name of a document after stripping BOM, XML declarations,
 * processing instructions, DOCTYPE, and comments.
 *
 * @param {string} xmlText
 * @returns {'urlset'|'sitemapindex'|'html'|'other'}
 */
function detectSitemapXmlRoot(xmlText) {
  const clean = xmlText.replace(/^\uFEFF/, '');
  let pos = 0;
  const len = clean.length;
  while (pos < len) {
    while (pos < len && /\s/.test(clean[pos])) pos++;
    if (pos >= len) return 'other';
    if (clean.startsWith('<!--', pos)) {
      const end = clean.indexOf('-->', pos + 4);
      if (end === -1) return 'other';
      pos = end + 3;
      continue;
    }
    if (clean.startsWith('<?', pos)) {
      const end = clean.indexOf('?>', pos + 2);
      if (end === -1) return 'other';
      pos = end + 2;
      continue;
    }
    if (/^<!doctype\s+html/i.test(clean.slice(pos, pos + 20))) {
      return 'html';
    }
    if (clean.startsWith('<!', pos)) {
      const end = clean.indexOf('>', pos + 2);
      if (end === -1) return 'other';
      pos = end + 1;
      continue;
    }
    const match = /^<(?:[a-z0-9_-]+:)?([a-z0-9_-]+)(?=[\s>/]|$)/i.exec(clean.slice(pos, pos + 80));
    if (!match) return 'other';
    const root = match[1].toLowerCase();
    if (root === 'urlset') return 'urlset';
    if (root === 'sitemapindex') return 'sitemapindex';
    if (root === 'html') return 'html';
    return 'other';
  }
  return 'other';
}

/**
 * Detect whether a text body looks like an HTML document (e.g., SPA 200 catch-all soft-404).
 * @param {string} text
 * @param {string|null} contentType
 * @returns {boolean}
 */
function isHtmlSoft404Document(text, contentType) {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    return true;
  }
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 512).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head);
}

/**
 * Extract `<sitemap><loc>` URLs from a `<sitemapindex>` XML document.
 * @param {string} xmlText
 * @returns {string[]}
 */
function extractSitemapIndexLocs(xmlText) {
  /** @type {string[]} */
  const locs = [];
  const blockRe = /<(?:[a-z0-9_-]+:)?sitemap\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_-]+:)?sitemap>/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(xmlText)) !== null) {
    const locMatch = /<(?:[a-z0-9_-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_-]+:)?loc>/i.exec(blockMatch[1]);
    if (locMatch) {
      const raw = decodeBasicEntities(locMatch[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim());
      if (raw) locs.push(raw);
    }
  }
  if (locs.length === 0) {
    const fallbackRe = /<(?:[a-z0-9_-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_-]+:)?loc>/gi;
    let m;
    while ((m = fallbackRe.exec(xmlText)) !== null) {
      const raw = decodeBasicEntities(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim());
      if (raw) locs.push(raw);
    }
  }
  return locs;
}

/**
 * Extract `<url><loc>` + `<lastmod>` entries from a `<urlset>` XML document.
 * @param {string} xmlText
 * @returns {Array<{loc: string, lastmod: string|null}>}
 */
function extractUrlsetEntries(xmlText) {
  /** @type {Array<{loc: string, lastmod: string|null}>} */
  const results = [];
  const blockRe = /<(?:[a-z0-9_-]+:)?url\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_-]+:)?url>/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(xmlText)) !== null) {
    const inner = blockMatch[1];
    const locMatch = /<(?:[a-z0-9_-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_-]+:)?loc>/i.exec(inner);
    if (!locMatch) continue;
    const loc = decodeBasicEntities(locMatch[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim());
    if (!loc) continue;
    const modMatch = /<(?:[a-z0-9_-]+:)?lastmod\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_-]+:)?lastmod>/i.exec(inner);
    const lastmod = modMatch ? decodeBasicEntities(modMatch[1].trim()) || null : null;
    results.push({ loc, lastmod });
  }
  return results;
}

/**
 * Discover sitemap URLs for an origin from `robots.txt` `Sitemap:` directives
 * and `/sitemap.xml`. Recursively traverses `<sitemapindex>` up to bounded
 * depth (default 2) and max candidate URLs (default 500), safely decompresses
 * `.xml.gz` / `application/gzip` using `node:zlib` `gunzipSync` ONLY when the
 * root XML is `<urlset>` or `<sitemapindex>` (ignoring `.tar.gz`), and rejects
 * SPA `200 text/html` soft-404 sitemaps.
 *
 * @param {string} origin
 * @param {DiscoverSitemapOptions} [options]
 * @returns {Promise<SitemapDiscoveryResult>}
 */
export async function discoverSitemapUrls(origin, options = {}) {
  const parsedOrigin = validateSiteUrl(origin);
  const allowPrivateHosts = options.allowPrivateHosts === true;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const lookupFn = options.lookup === null ? null : (options.lookup ?? dnsLookup);
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxDepth =
    typeof options.maxDepth === 'number' && Number.isInteger(options.maxDepth) && options.maxDepth >= 0
      ? options.maxDepth
      : MAX_SITEMAP_DEPTH;
  const maxUrls =
    typeof options.maxUrls === 'number' && Number.isInteger(options.maxUrls) && options.maxUrls > 0
      ? options.maxUrls
      : MAX_SITEMAP_URLS;
  const maxSitemapBytes =
    typeof options.maxSitemapBytes === 'number' && Number.isFinite(options.maxSitemapBytes) && options.maxSitemapBytes > 0
      ? options.maxSitemapBytes
      : DEFAULT_MAX_SITEMAP_BYTES;
  const maxRedirects =
    typeof options.maxRedirects === 'number' && Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0
      ? options.maxRedirects
      : DEFAULT_MAX_REDIRECTS;

  await assertSafeUrl(parsedOrigin, { allowPrivateHosts, lookupFn });

  const targetOrigin = parsedOrigin.origin;
  /** @type {Set<string>} */
  const seedSitemaps = new Set();

  if (Array.isArray(options.robotsSitemaps)) {
    for (const sm of options.robotsSitemaps) {
      const normalized = normalizeCandidateUrl(sm, targetOrigin);
      if (normalized) seedSitemaps.add(normalized);
    }
  } else if (typeof options.robotsTxt === 'string') {
    for (const sm of parseRobotsTxt(options.robotsTxt).sitemaps) {
      const normalized = normalizeCandidateUrl(sm, targetOrigin);
      if (normalized) seedSitemaps.add(normalized);
    }
  } else {
    // Fetch /robots.txt to discover Sitemap: directives
    const robotsUrl = `${targetOrigin}/robots.txt`;
    try {
      const robotsFetch = await fetchWithSsrfGuard(robotsUrl, {
        allowPrivateHosts,
        fetchFn,
        lookupFn,
        timeoutMs,
        maxRedirects: Math.min(maxRedirects, 5),
        headers: { accept: 'text/plain, */*;q=0.5' },
        signal: options.signal,
      });
      if (robotsFetch.response.status >= 200 && robotsFetch.response.status < 300) {
        const { buffer } = await readBodyCapped(robotsFetch.response, 512 * 1024);
        const text = buffer.toString('utf8');
        const ct = robotsFetch.response.headers.get('content-type');
        if (!isHtmlSoft404Document(text, ct)) {
          for (const sm of parseRobotsTxt(text).sitemaps) {
            const normalized = normalizeCandidateUrl(sm, targetOrigin);
            if (normalized) seedSitemaps.add(normalized);
          }
        }
      } else {
        await robotsFetch.response.body?.cancel().catch(() => {});
      }
    } catch (err) {
      if (err instanceof SiteCheckError && (err.code === 'ssrf_blocked' || err.code === 'invalid_url')) {
        throw err;
      }
    }
  }

  // Always include default /sitemap.xml candidate
  seedSitemaps.add(`${targetOrigin}/sitemap.xml`);

  /** @type {Set<string>} */
  const visitedSitemaps = new Set();
  /** @type {Set<string>} */
  const seenUrls = new Set();
  /** @type {SitemapEntry[]} */
  const entries = [];
  /** @type {SitemapCheckedInfo[]} */
  const sitemapsChecked = [];
  /** @type {SitemapRejection[]} */
  const rejected = [];
  let truncated = false;

  /**
   * @param {string} sitemapUrl
   * @param {number} depth
   * @returns {Promise<void>}
   */
  async function processSitemap(sitemapUrl, depth) {
    if (seenUrls.size >= maxUrls) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;
    const normalizedSm = normalizeCandidateUrl(sitemapUrl, targetOrigin);
    if (!normalizedSm || visitedSitemaps.has(normalizedSm)) return;
    visitedSitemaps.add(normalizedSm);

    /** @type {URL} */
    let smParsed;
    try {
      smParsed = validateSiteUrl(normalizedSm);
    } catch {
      rejected.push({ url: normalizedSm, reason: 'invalid_url', contentType: null });
      return;
    }

    // Explicitly ignore .tar.gz / .tgz / archive files BEFORE fetching or decompressing
    if (ARCHIVE_EXT_RE.test(smParsed.pathname)) {
      rejected.push({ url: normalizedSm, reason: 'ignored_archive', contentType: null });
      sitemapsChecked.push({
        url: normalizedSm,
        status: null,
        kind: 'rejected',
        compressed: false,
        urlCount: 0,
        reason: 'ignored_archive',
      });
      return;
    }

    /** @type {SafeFetchResult} */
    let fetched;
    try {
      fetched = await fetchWithSsrfGuard(normalizedSm, {
        allowPrivateHosts,
        fetchFn,
        lookupFn,
        timeoutMs,
        maxRedirects: Math.min(maxRedirects, 5),
        headers: { accept: 'application/xml, text/xml, application/gzip, */*;q=0.5' },
        signal: options.signal,
      });
    } catch (err) {
      const reason = err instanceof SiteCheckError ? err.code : 'fetch_failed';
      if (err instanceof SiteCheckError && err.code === 'ssrf_blocked') {
        rejected.push({ url: normalizedSm, reason: 'ssrf_blocked', contentType: null });
        sitemapsChecked.push({
          url: normalizedSm,
          status: null,
          kind: 'rejected',
          compressed: false,
          urlCount: 0,
          reason: 'ssrf_blocked',
        });
        return;
      }
      sitemapsChecked.push({
        url: normalizedSm,
        status: null,
        kind: 'error',
        compressed: false,
        urlCount: 0,
        reason,
      });
      return;
    }

    const status = fetched.response.status;
    const contentType = fetched.response.headers.get('content-type');
    if (status < 200 || status >= 300 || fetched.loopDetected || fetched.maxHopsExceeded) {
      await fetched.response.body?.cancel().catch(() => {});
      sitemapsChecked.push({
        url: normalizedSm,
        status,
        kind: 'error',
        compressed: false,
        urlCount: 0,
        reason: `http_${status}`,
      });
      return;
    }

    // Check archive extension on finalUrl after redirects as well
    const finalParsed = new URL(fetched.finalUrl);
    const ctLower = (contentType ?? '').toLowerCase();
    if (ARCHIVE_EXT_RE.test(finalParsed.pathname) || ctLower.includes('application/x-tar')) {
      await fetched.response.body?.cancel().catch(() => {});
      rejected.push({ url: normalizedSm, reason: 'ignored_archive', contentType });
      sitemapsChecked.push({
        url: normalizedSm,
        status,
        kind: 'rejected',
        compressed: false,
        urlCount: 0,
        reason: 'ignored_archive',
      });
      return;
    }

    const { buffer } = await readBodyCapped(fetched.response, maxSitemapBytes);
    const pathnameLower = finalParsed.pathname.toLowerCase();
    const isGzipCandidate =
      pathnameLower.endsWith('.xml.gz') ||
      (pathnameLower.endsWith('.gz') && !ARCHIVE_EXT_RE.test(pathnameLower)) ||
      ctLower.includes('application/gzip') ||
      ctLower.includes('application/x-gzip') ||
      hasGzipMagic(buffer);

    let compressed = false;
    let xmlText = '';

    if (isGzipCandidate && hasGzipMagic(buffer)) {
      compressed = true;
      /** @type {Buffer} */
      let inflated;
      try {
        inflated = gunzipSync(buffer, { maxOutputLength: maxSitemapBytes });
      } catch {
        rejected.push({ url: normalizedSm, reason: 'invalid_gzip', contentType });
        sitemapsChecked.push({
          url: normalizedSm,
          status,
          kind: 'rejected',
          compressed: true,
          urlCount: 0,
          reason: 'invalid_gzip',
        });
        return;
      }

      if (looksLikeTarArchive(inflated)) {
        rejected.push({ url: normalizedSm, reason: 'ignored_archive', contentType });
        sitemapsChecked.push({
          url: normalizedSm,
          status,
          kind: 'rejected',
          compressed: true,
          urlCount: 0,
          reason: 'ignored_archive',
        });
        return;
      }
      xmlText = inflated.toString('utf8');
    } else {
      // Non-gzipped response: reject SPA 200 text/html soft-404 sitemaps immediately
      xmlText = buffer.toString('utf8');
      if (isHtmlSoft404Document(xmlText, contentType)) {
        rejected.push({ url: normalizedSm, reason: 'soft_404_html', contentType });
        sitemapsChecked.push({
          url: normalizedSm,
          status,
          kind: 'rejected',
          compressed: false,
          urlCount: 0,
          reason: 'soft_404_html',
        });
        return;
      }
    }

    const rootKind = detectSitemapXmlRoot(xmlText);
    if (rootKind === 'html') {
      rejected.push({ url: normalizedSm, reason: 'soft_404_html', contentType });
      sitemapsChecked.push({
        url: normalizedSm,
        status,
        kind: 'rejected',
        compressed,
        urlCount: 0,
        reason: 'soft_404_html',
      });
      return;
    }

    if (rootKind !== 'urlset' && rootKind !== 'sitemapindex') {
      rejected.push({ url: normalizedSm, reason: 'invalid_sitemap_root', contentType });
      sitemapsChecked.push({
        url: normalizedSm,
        status,
        kind: 'rejected',
        compressed,
        urlCount: 0,
        reason: 'invalid_sitemap_root',
      });
      return;
    }

    if (rootKind === 'sitemapindex') {
      const childLocs = extractSitemapIndexLocs(xmlText);
      sitemapsChecked.push({
        url: normalizedSm,
        status,
        kind: 'sitemapindex',
        compressed,
        urlCount: childLocs.length,
        reason: null,
      });
      if (depth < maxDepth) {
        for (const child of childLocs) {
          if (seenUrls.size >= maxUrls) {
            truncated = true;
            break;
          }
          await processSitemap(child, depth + 1);
        }
      }
      return;
    }

    // rootKind === 'urlset'
    const urlEntries = extractUrlsetEntries(xmlText);
    let addedHere = 0;
    for (const item of urlEntries) {
      if (seenUrls.size >= maxUrls) {
        truncated = true;
        break;
      }
      const norm = normalizeCandidateUrl(item.loc, targetOrigin);
      if (!norm) continue;
      const candidateParsed = new URL(norm);
      if (candidateParsed.origin !== targetOrigin) continue;
      if (seenUrls.has(norm)) continue;
      seenUrls.add(norm);
      entries.push({ url: norm, lastmod: item.lastmod, sourceSitemap: normalizedSm });
      addedHere += 1;
    }

    sitemapsChecked.push({
      url: normalizedSm,
      status,
      kind: 'urlset',
      compressed,
      urlCount: addedHere,
      reason: null,
    });
  }

  for (const seedUrl of seedSitemaps) {
    if (seenUrls.size >= maxUrls) {
      truncated = true;
      break;
    }
    await processSitemap(seedUrl, 0);
  }

  return {
    origin: targetOrigin,
    urls: [...seenUrls],
    entries,
    sitemapsChecked,
    rejected,
    truncated,
  };
}

/**
 * Determine whether a single path segment looks like a numeric/UUID/hex ID.
 * @param {string} segment
 * @returns {boolean}
 */
function isIdSegment(segment) {
  return UUID_RE.test(segment) || HEX_HASH_RE.test(segment) || ID_TOKEN_RE.test(segment);
}

/**
 * Normalize a URL or pathname into a structural template pattern such as
 * `/`, `/pricing`, `/blog/:slug`, `/docs/:section/:slug`, or `/products/:id`.
 *
 * @param {string} urlOrPath
 * @returns {string}
 */
export function normalizeUrlTemplate(urlOrPath) {
  let pathname = '/';
  if (typeof urlOrPath === 'string' && urlOrPath.trim() !== '') {
    try {
      const parsed = /^https?:\/\//i.test(urlOrPath.trim())
        ? new URL(urlOrPath.trim())
        : new URL(urlOrPath.trim().startsWith('/') ? urlOrPath.trim() : `/${urlOrPath.trim()}`, 'https://example.invalid');
      pathname = parsed.pathname || '/';
    } catch {
      pathname = urlOrPath.split(/[?#]/)[0] || '/';
    }
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/';

  const first = segments[0].toLowerCase();
  if (segments.length === 1) {
    if (isIdSegment(segments[0])) return '/:id';
    return `/${first}`;
  }

  // Handle locale prefix e.g. /en/blog/post-1 or /en-us/pricing
  if (LOCALE_SEGMENT_RE.test(first) && segments.length >= 2) {
    const restTemplate = normalizeUrlTemplate(`/${segments.slice(1).join('/')}`);
    return `/${first}${restTemplate === '/' ? '' : restTemplate}`;
  }

  if (segments.length === 2) {
    const second = segments[1];
    return `/${first}/${isIdSegment(second) ? ':id' : ':slug'}`;
  }

  if (segments.length === 3) {
    const second = segments[1];
    const third = segments[2];
    if (DOCS_PREFIXES.has(first)) {
      return `/${first}/:section/${isIdSegment(third) ? ':id' : ':slug'}`;
    }
    if (YEAR_RE.test(second) && MONTH_OR_DAY_RE.test(third)) {
      return `/${first}/:year/:month`;
    }
    return `/${first}/${isIdSegment(second) ? ':id' : ':section'}/${isIdSegment(third) ? ':id' : ':slug'}`;
  }

  // 4+ segments
  const parts = [first];
  for (let idx = 1; idx < segments.length; idx++) {
    const seg = segments[idx];
    const isLast = idx === segments.length - 1;
    if (idx === 1 && YEAR_RE.test(seg)) {
      parts.push(':year');
    } else if (idx === 2 && parts[1] === ':year' && MONTH_OR_DAY_RE.test(seg)) {
      parts.push(':month');
    } else if (idx === 3 && parts[2] === ':month' && MONTH_OR_DAY_RE.test(seg)) {
      parts.push(':day');
    } else if (isIdSegment(seg)) {
      parts.push(':id');
    } else {
      parts.push(isLast ? ':slug' : ':section');
    }
  }
  return `/${parts.join('/')}`;
}

/**
 * Determine whether a pathname (or URL) points to a non-content authentication,
 * account, cart/checkout, or CMS admin utility route (e.g. `/login`, `/signin`,
 * `/sign-in`, `/signup`, `/sign-up`, `/register`, `/logout`, `/signout`,
 * `/auth/*`, `/oauth/*`, `/sso/*`, `/reset-password`, `/forgot-password`,
 * `/account/*`, `/cart`, `/checkout`, `/wp-login.php`, `/wp-admin/*`).
 *
 * Also handles locale-prefixed paths such as `/en/login` or `/en-us/checkout`,
 * while avoiding false positives on content routes like `/docs/api/authentication`
 * or `/author/jane`.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isAuthOrUtilityPath(pathname) {
  if (typeof pathname !== 'string' || pathname.trim() === '') return false;
  let cleanPath = pathname.trim();
  if (/^https?:\/\//i.test(cleanPath)) {
    try {
      cleanPath = new URL(cleanPath).pathname;
    } catch {
      return false;
    }
  } else {
    cleanPath = cleanPath.split(/[?#]/)[0] || '/';
  }

  const segments = cleanPath.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 0) return false;
  if (AUTH_OR_UTILITY_ROOT_SEGMENTS.has(segments[0])) return true;
  if (segments.length >= 2 && LOCALE_SEGMENT_RE.test(segments[0]) && AUTH_OR_UTILITY_ROOT_SEGMENTS.has(segments[1])) {
    return true;
  }
  return false;
}

/**
 * Compute high-intent rank (0..7) for a top-level high-intent landing page
 * (`/pricing`, `/docs`, `/features`, `/compare`, `/about`, `/alternatives`, `/product`, `/faq`,
 * or locale-prefixed `/en/pricing`), or -1 otherwise.
 * Deep subpages like `/docs/guides/quickstart` or `/products/101` participate in
 * Priority 3 template-diversity round-robin so they don't starve other templates.
 *
 * @param {string} pathname
 * @returns {number}
 */
function getHighIntentRank(pathname) {
  const segments = pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 1 && Object.hasOwn(HIGH_INTENT_ALIAS_RANK, segments[0])) {
    return HIGH_INTENT_ALIAS_RANK[segments[0]];
  }
  if (segments.length === 2 && LOCALE_SEGMENT_RE.test(segments[0]) && Object.hasOwn(HIGH_INTENT_ALIAS_RANK, segments[1])) {
    return HIGH_INTENT_ALIAS_RANK[segments[1]];
  }
  return -1;
}

/**
 * Deterministically select up to `maxPages` key pages to audit:
 *  1. Homepage (always first)
 *  2. High-intent navigation pages (`/pricing`, `/docs`, `/features`, `/compare`, `/about`, `/alternatives`, `/product`, `/faq`)
 *  3. Remaining nav & sitemap URLs maximizing template diversity (capped at `maxPerTemplate` = 2 per URL pattern
 *     so e.g. 20 `/blog/:slug` posts cannot crowd out `/pricing` or `/docs`).
 *
 * @param {{
 *   homepageUrl: string,
 *   navLinks?: string[],
 *   sitemapUrls?: string[],
 *   maxPages?: number,
 *   maxPerTemplate?: number,
 * }} input
 * @returns {SelectKeyPagesResult}
 */
export function selectKeyPages({
  homepageUrl,
  navLinks = [],
  sitemapUrls = [],
  maxPages = DEFAULT_MAX_PAGES,
  maxPerTemplate = DEFAULT_MAX_PER_TEMPLATE,
}) {
  const parsedHome = validateSiteUrl(homepageUrl);
  const targetOrigin = parsedHome.origin;
  const normalizedHome = normalizeCandidateUrl(parsedHome.href) ?? parsedHome.href;
  const effectiveMaxPages = Math.max(1, Math.floor(Number.isFinite(maxPages) ? maxPages : DEFAULT_MAX_PAGES));
  const effectiveMaxPerTemplate = Math.max(
    1,
    Math.floor(Number.isFinite(maxPerTemplate) ? maxPerTemplate : DEFAULT_MAX_PER_TEMPLATE),
  );

  /** @type {SelectedPageEntry[]} */
  const selected = [];
  /** @type {Set<string>} */
  const selectedSet = new Set();
  /** @type {Map<string, number>} */
  const templateCounts = new Map();
  /** @type {CapSkippedPage[]} */
  const skippedByCap = [];
  /** @type {Set<string>} */
  const skippedSet = new Set();

  /**
   * @param {string} url
   * @param {'homepage'|'high_intent'|'diverse_nav'|'diverse_sitemap'} priority
   * @param {'homepage'|'nav'|'sitemap'} source
   * @returns {boolean}
   */
  const trySelect = (url, priority, source) => {
    if (selectedSet.has(url)) return false;
    const template = normalizeUrlTemplate(url);
    if (selected.length >= effectiveMaxPages) {
      if (!skippedSet.has(url)) {
        skippedSet.add(url);
        skippedByCap.push({ url, template, reason: 'max_pages_cap' });
      }
      return false;
    }
    const count = templateCounts.get(template) ?? 0;
    if (priority !== 'homepage' && count >= effectiveMaxPerTemplate) {
      if (!skippedSet.has(url)) {
        skippedSet.add(url);
        skippedByCap.push({ url, template, reason: 'template_cap' });
      }
      return false;
    }
    selectedSet.add(url);
    templateCounts.set(template, count + 1);
    selected.push({ url, template, priority, source });
    return true;
  };

  // (1) Homepage is always first
  trySelect(normalizedHome, 'homepage', 'homepage');

  /**
   * Normalize, filter to same-origin non-asset HTML candidates, and deduplicate.
   * @param {string[]} rawList
   * @param {'nav'|'sitemap'} source
   * @param {Set<string>} globalSeen
   * @returns {Array<{url: string, pathname: string, depth: number, template: string, intentRank: number, source: 'nav'|'sitemap'}>}
   */
  const preparePool = (rawList, source, globalSeen) => {
    /** @type {Array<{url: string, pathname: string, depth: number, template: string, intentRank: number, source: 'nav'|'sitemap'}>} */
    const items = [];
    for (const raw of rawList) {
      const norm = normalizeCandidateUrl(raw, targetOrigin);
      if (!norm || norm === normalizedHome || globalSeen.has(norm)) continue;
      const parsed = new URL(norm);
      if (parsed.origin !== targetOrigin) continue;
      if (STATIC_ASSET_EXT_RE.test(parsed.pathname)) continue;
      globalSeen.add(norm);
      const depth = parsed.pathname.split('/').filter(Boolean).length;
      items.push({
        url: norm,
        pathname: parsed.pathname,
        depth,
        template: normalizeUrlTemplate(parsed.pathname),
        intentRank: getHighIntentRank(parsed.pathname),
        source,
      });
    }
    return items;
  };

  /** @type {Set<string>} */
  const seenCandidates = new Set([normalizedHome]);
  const navPool = preparePool(Array.isArray(navLinks) ? navLinks : [], 'nav', seenCandidates);
  const sitemapPool = preparePool(Array.isArray(sitemapUrls) ? sitemapUrls : [], 'sitemap', seenCandidates);

  const deterministicCompare = (
    /** @type {{intentRank: number, depth: number, url: string, source: 'nav'|'sitemap'}} */ a,
    /** @type {{intentRank: number, depth: number, url: string, source: 'nav'|'sitemap'}} */ b,
  ) => {
    if (a.source !== b.source) return a.source === 'nav' ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.url.localeCompare(b.url);
  };

  // (2) High-intent pages: nav first, then sitemap high-intent pages, ordered by intent rank -> depth -> url
  const highIntentCandidates = [...navPool, ...sitemapPool]
    .filter((item) => item.intentRank >= 0)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'nav' ? -1 : 1;
      if (a.intentRank !== b.intentRank) return a.intentRank - b.intentRank;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.url.localeCompare(b.url);
    });

  for (const item of highIntentCandidates) {
    trySelect(item.url, 'high_intent', item.source);
  }

  // (3) Remaining nav + sitemap candidates maximizing template diversity via round-robin per template
  const remaining = [...navPool, ...sitemapPool]
    .filter((item) => !selectedSet.has(item.url))
    .sort(deterministicCompare);

  /** @type {Map<string, typeof remaining>} */
  const byTemplate = new Map();
  for (const item of remaining) {
    const bucket = byTemplate.get(item.template);
    if (bucket) bucket.push(item);
    else byTemplate.set(item.template, [item]);
  }

  // Sort template buckets deterministically: templates with nav sources first, then shallower depth, then name
  const orderedTemplates = [...byTemplate.keys()].sort((ta, tb) => {
    const aFirst = /** @type {typeof remaining} */ (byTemplate.get(ta))[0];
    const bFirst = /** @type {typeof remaining} */ (byTemplate.get(tb))[0];
    if (aFirst.source !== bFirst.source) return aFirst.source === 'nav' ? -1 : 1;
    if (aFirst.depth !== bFirst.depth) return aFirst.depth - bFirst.depth;
    return ta.localeCompare(tb);
  });

  // Round-robin across templates up to maxPerTemplate (round 0 gives 1 sample per template first, then round 1 gives 2nd)
  for (let round = 0; round < effectiveMaxPerTemplate; round++) {
    for (const tpl of orderedTemplates) {
      const bucket = /** @type {typeof remaining} */ (byTemplate.get(tpl));
      const candidate = bucket.find((item) => !selectedSet.has(item.url) && !skippedSet.has(item.url));
      if (!candidate) continue;
      const priority = candidate.source === 'nav' ? 'diverse_nav' : 'diverse_sitemap';
      trySelect(candidate.url, priority, candidate.source);
    }
  }

  // Record any leftover candidates that exceeded template cap or maxPages cap
  for (const item of remaining) {
    if (selectedSet.has(item.url) || skippedSet.has(item.url)) continue;
    skippedSet.add(item.url);
    const tplCount = templateCounts.get(item.template) ?? 0;
    skippedByCap.push({
      url: item.url,
      template: item.template,
      reason: tplCount >= effectiveMaxPerTemplate ? 'template_cap' : 'max_pages_cap',
    });
  }

  /** @type {Record<string, number>} */
  const countsObj = {};
  for (const [k, v] of templateCounts.entries()) {
    countsObj[k] = v;
  }

  return {
    selected,
    urls: selected.map((s) => s.url),
    skippedByCap,
    templateCounts: countsObj,
  };
}

/**
 * Parse `Crawl-delay` (in seconds) from `robots.txt` for a given user-agent (falling back to `*`).
 * @param {string} robotsText
 * @param {string} [userAgent]
 * @returns {number|null}
 */
export function parseCrawlDelay(robotsText, userAgent = 'HearsaySiteCheck') {
  if (typeof robotsText !== 'string' || !robotsText.trim()) return null;
  const targetToken = userAgent.trim().split('/')[0].trim().toLowerCase();
  /** @type {Array<{agents: string[], crawlDelay: number|null}>} */
  const groups = [];
  /** @type {{agents: string[], crawlDelay: number|null}|null} */
  let current = null;
  let sawDirective = false;

  for (const rawLine of robotsText.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!value) continue;
      if (!current || sawDirective) {
        current = { agents: [value], crawlDelay: null };
        groups.push(current);
        sawDirective = false;
      } else {
        current.agents.push(value);
      }
      continue;
    }

    if (!current) continue;
    sawDirective = true;
    if (field === 'crawl-delay') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        current.crawlDelay = parsed;
      }
    }
  }

  // Specific agent group takes precedence over *
  for (const group of groups) {
    if (group.agents.some((a) => a.trim().split('/')[0].trim().toLowerCase() === targetToken)) {
      if (group.crawlDelay !== null) return group.crawlDelay;
    }
  }
  for (const group of groups) {
    if (group.agents.some((a) => a.trim() === '*')) {
      if (group.crawlDelay !== null) return group.crawlDelay;
    }
  }
  return null;
}

/**
 * Parse `Content-Signal:` directive from `robots.txt` text.
 * @param {string} robotsText
 * @returns {string|null}
 */
function extractRobotsContentSignal(robotsText) {
  if (typeof robotsText !== 'string' || !robotsText) return null;
  for (const rawLine of robotsText.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    if (field === 'content-signal') {
      const val = line.slice(colon + 1).trim();
      if (val) return val;
    }
  }
  return null;
}

/**
 * Create an AIMD polite crawl throttle controller.
 * - Honors `robots.txt` `Crawl-delay` up to `MAX_CRAWL_DELAY_MS` (3,000 ms).
 * - Multiplicatively slows down on HTTP 429/503 or >2,000 ms latency.
 * - Additively eases off back toward the floor when responses are healthy.
 *
 * @param {{
 *   crawlDelaySec?: number|null,
 *   initialDelayMs?: number,
 *   maxDelayMs?: number,
 *   slowLatencyMs?: number,
 *   sleepFn?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export function createAimdController(opts = {}) {
  const crawlDelayFloorMs =
    typeof opts.crawlDelaySec === 'number' && Number.isFinite(opts.crawlDelaySec) && opts.crawlDelaySec > 0
      ? Math.min(MAX_CRAWL_DELAY_MS, Math.round(opts.crawlDelaySec * 1000))
      : 0;
  const maxDelayMs =
    typeof opts.maxDelayMs === 'number' && Number.isFinite(opts.maxDelayMs) && opts.maxDelayMs > 0
      ? opts.maxDelayMs
      : 5_000;
  const slowLatencyMs =
    typeof opts.slowLatencyMs === 'number' && Number.isFinite(opts.slowLatencyMs) && opts.slowLatencyMs > 0
      ? opts.slowLatencyMs
      : 2_000;
  const initialDelayMs = Math.max(
    crawlDelayFloorMs,
    typeof opts.initialDelayMs === 'number' && Number.isFinite(opts.initialDelayMs) && opts.initialDelayMs > 0
      ? opts.initialDelayMs
      : 0,
  );
  const sleepFn =
    opts.sleepFn ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let currentDelayMs = initialDelayMs;
  let slowdowns = 0;
  let totalWaitMs = 0;

  return {
    getCurrentDelayMs() {
      return currentDelayMs;
    },
    getCrawlDelayFloorMs() {
      return crawlDelayFloorMs;
    },
    async waitBeforeNext() {
      if (currentDelayMs > 0) {
        totalWaitMs += currentDelayMs;
        await sleepFn(currentDelayMs);
      }
    },
    /**
     * Record a completed response and adjust delay via AIMD.
     * @param {{status: number|null, timingMs: number}} sample
     */
    recordResponse(sample) {
      const isBackoffStatus = sample.status === 429 || sample.status === 503;
      const isSlow = typeof sample.timingMs === 'number' && sample.timingMs > slowLatencyMs;
      if (isBackoffStatus || isSlow) {
        slowdowns += 1;
        currentDelayMs = Math.min(maxDelayMs, Math.max(crawlDelayFloorMs, currentDelayMs * 2 + 500));
      } else if (sample.status !== null && sample.status >= 200 && sample.status < 400) {
        currentDelayMs = Math.max(crawlDelayFloorMs, currentDelayMs - 100);
      }
    },
    getStats() {
      return {
        initialDelayMs,
        finalDelayMs: currentDelayMs,
        crawlDelayFloorMs,
        slowdowns,
        totalWaitMs,
      };
    },
  };
}

/**
 * Extract same-origin `<a href>` links from raw HTML, prioritizing links inside
 * `<nav>` / `<header>` elements over general body links.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{navLinks: string[], bodyLinks: string[]}}
 */
function extractPageLinks(html, pageUrl) {
  if (!html) return { navLinks: [], bodyLinks: [] };
  const parsedPage = new URL(pageUrl);
  const origin = parsedPage.origin;

  // Strip comments, script, and style blocks so JS strings don't masquerade as links
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');

  // Respect <base href="..."> if present
  let baseUrl = pageUrl;
  const baseMatch = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(stripped);
  if (baseMatch) {
    const rawBase = decodeBasicEntities((baseMatch[1] ?? baseMatch[2] ?? baseMatch[3] ?? '').trim());
    if (rawBase) {
      try {
        baseUrl = new URL(rawBase, pageUrl).href;
      } catch {
        baseUrl = pageUrl;
      }
    }
  }

  /** @type {Set<string>} */
  const navSet = new Set();
  /** @type {Set<string>} */
  const bodySet = new Set();

  let navDepth = 0;
  const tagRe = /<(\/?)(nav|header|a)\b([^>]*)>/gi;
  let match;
  while ((match = tagRe.exec(stripped)) !== null) {
    const isClose = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (tag === 'nav' || tag === 'header') {
      navDepth = isClose ? Math.max(0, navDepth - 1) : navDepth + 1;
      continue;
    }
    if (tag === 'a' && !isClose) {
      const attrs = match[3] ?? '';
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      if (!hrefMatch) continue;
      const rawHref = decodeBasicEntities((hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '').trim());
      if (!rawHref || rawHref.startsWith('#') || /^(?:mailto:|tel:|javascript:|data:)/i.test(rawHref)) continue;
      const normalized = normalizeCandidateUrl(rawHref, baseUrl);
      if (!normalized) continue;
      const resolved = new URL(normalized);
      if (resolved.origin !== origin) continue;
      if (STATIC_ASSET_EXT_RE.test(resolved.pathname)) continue;
      if (navDepth > 0) {
        navSet.add(normalized);
      } else if (!navSet.has(normalized)) {
        bodySet.add(normalized);
      }
    }
  }

  return { navLinks: [...navSet], bodyLinks: [...bodySet] };
}

/**
 * Passively classify WAF / edge challenge state from HTTP response headers and HTML.
 * Explicitly excludes `cf-chl-` to prevent false positives on embedded Turnstile widgets.
 *
 * @param {Headers|Record<string, string|null|undefined>|null} headers
 * @param {string} html
 * @param {number|null} status
 * @param {number} visibleCharCount
 * @param {string|null} title
 * @returns {'none'|'edge_detected'|'bot_management_active'|'challenge_or_block_intercepted'}
 */
function detectPassiveWafState(headers, html, status, visibleCharCount, title) {
  /** @param {string} name */
  const getHeader = (name) => {
    if (!headers) return '';
    if (typeof (/** @type {Headers} */ (headers).get) === 'function') {
      return (/** @type {Headers} */ (headers).get(name) ?? '').toLowerCase();
    }
    const rec = /** @type {Record<string, string|null|undefined>} */ (headers);
    return String(rec[name] ?? rec[name.toLowerCase()] ?? '').toLowerCase();
  };

  const cfMitigated = getHeader('cf-mitigated');
  const vercelMitigated = getHeader('x-vercel-mitigated');
  const amznWaf = getHeader('x-amzn-waf-action');
  const datadome = getHeader('x-datadome');
  const isBlockOrChallengeStatus = status === 403 || status === 429 || status === 202 || status === 503;

  if (
    cfMitigated.includes('challenge') ||
    vercelMitigated.includes('challenge') ||
    amznWaf.includes('challenge') ||
    amznWaf.includes('captcha') ||
    (datadome.includes('protected') && isBlockOrChallengeStatus)
  ) {
    return 'challenge_or_block_intercepted';
  }

  // Hardened HTML challenge check: only when visible text < 1000 chars
  if (visibleCharCount < CHALLENGE_MAX_TEXT_CHARS && (status === 200 || isBlockOrChallengeStatus)) {
    const titleLower = (title ?? '').toLowerCase();
    if (CHALLENGE_TITLE_MARKERS.some((marker) => titleLower.includes(marker))) {
      return 'challenge_or_block_intercepted';
    }
    const htmlLower = html.toLowerCase();
    if (CHALLENGE_HTML_MARKERS.some((marker) => htmlLower.includes(marker))) {
      return 'challenge_or_block_intercepted';
    }
  }

  // DataDome sends `x-datadome: protected` on normal 200 OK responses as passive bot telemetry
  if (datadome.includes('protected')) {
    return 'bot_management_active';
  }

  // Check Set-Cookie names ONLY (never log or inspect values)
  /** @type {string[]} */
  let setCookies = [];
  if (headers && typeof (/** @type {Headers} */ (headers).getSetCookie) === 'function') {
    setCookies = /** @type {Headers} */ (headers).getSetCookie();
  }
  const cookieNames = setCookies.map((c) => c.split('=')[0].trim().toLowerCase());
  const botCookies = new Set(['__cf_bm', '_abck', 'ak_bmsc', 'reese84', 'datadome', 'aws-waf-token', '_px3']);
  if (cookieNames.some((name) => botCookies.has(name))) {
    return 'bot_management_active';
  }

  if (
    getHeader('cf-ray') ||
    getHeader('x-vercel-id') ||
    getHeader('x-fastly-request-id') ||
    getHeader('akamai-grn') ||
    getHeader('x-amz-cf-id')
  ) {
    return 'edge_detected';
  }

  return 'none';
}

/**
 * Check whether an X-Robots-Tag or `<meta name="robots">` value has a `noindex` directive.
 * @param {string|null} val
 * @returns {boolean}
 */
function hasNoindexDirective(val) {
  if (!val) return false;
  return val
    .toLowerCase()
    .split(/[\s,;]+/)
    .some((tok) => tok === 'noindex' || tok === 'none' || tok.endsWith(':noindex') || tok.endsWith(':none'));
}

/**
 * Evaluate the Hard Infrastructure Gate on the homepage result.
 * Triggers when the homepage returns:
 *  - Transport failure (no HTTP status or explicit transport error)
 *  - HTTP 403 Forbidden
 *  - Active WAF challenge (`challenge_or_block_intercepted`)
 *  - Empty JS shell (`0` visible words + high CSR risk)
 *
 * When triggered, caps crawl status to `'blocked_hard_gate'` and marks downstream
 * content checks as `'not_observed'` so challenge/error HTML is never scored as content.
 *
 * @param {Record<string, any>|null|undefined} homepageResult
 * @returns {HardGateResult}
 */
export function evaluateHardGate(homepageResult) {
  if (!homepageResult || typeof homepageResult !== 'object') {
    return {
      triggered: true,
      reason: 'transport_failure',
      detail: 'Homepage fetch failed with no response.',
      capStatus: 'blocked_hard_gate',
      downstreamStatus: 'not_observed',
    };
  }

  const status = typeof homepageResult.status === 'number' ? homepageResult.status : null;
  if (homepageResult.transportError === true || status === null || status <= 0) {
    return {
      triggered: true,
      reason: 'transport_failure',
      detail: typeof homepageResult.error === 'string' && homepageResult.error
        ? homepageResult.error
        : 'Homepage request failed before receiving an HTTP response.',
      capStatus: 'blocked_hard_gate',
      downstreamStatus: 'not_observed',
    };
  }

  // Active WAF challenge check (takes precedence on 403 challenge pages or 200/503 challenges)
  const wafState =
    homepageResult.wafState ??
    homepageResult.waf?.state ??
    homepageResult.tech?.wafState ??
    null;

  if (wafState === 'challenge_or_block_intercepted') {
    return {
      triggered: true,
      reason: 'waf_challenge_intercepted',
      detail: `Active WAF/bot challenge intercepted the homepage (HTTP ${status}); downstream content is not observed.`,
      capStatus: 'blocked_hard_gate',
      downstreamStatus: 'not_observed',
    };
  }

  if (status === 403) {
    return {
      triggered: true,
      reason: 'http_403_blocked',
      detail: 'Homepage returned HTTP 403 Forbidden; downstream content checks cannot be observed.',
      capStatus: 'blocked_hard_gate',
      downstreamStatus: 'not_observed',
    };
  }

  const visibleWords =
    typeof homepageResult.payload?.visibleWordCount === 'number'
      ? homepageResult.payload.visibleWordCount
      : typeof homepageResult.visibleWordCount === 'number'
        ? homepageResult.visibleWordCount
        : typeof homepageResult.rawWords === 'number'
          ? homepageResult.rawWords
          : null;

  const csrLevel =
    homepageResult.payload?.csrRisk?.level ??
    homepageResult.csrRisk?.level ??
    homepageResult.csrLevel ??
    null;

  if (homepageResult.emptyJsShell === true || (visibleWords === 0 && csrLevel === 'high')) {
    return {
      triggered: true,
      reason: 'empty_js_shell',
      detail: 'Homepage returned an empty JS shell (0 visible words with high CSR risk); non-rendering AI crawlers cannot read content.',
      capStatus: 'blocked_hard_gate',
      downstreamStatus: 'not_observed',
    };
  }

  return {
    triggered: false,
    reason: null,
    detail: null,
    capStatus: null,
    downstreamStatus: 'observed',
  };
}

/**
 * Default single-pass page analyzer (runs strictly in-memory on already-fetched HTML).
 *
 * @param {PageCheckerContext} ctx
 * @returns {CrawledPageResult}
 */
function defaultAnalyzePage(ctx) {
  const payload = analyzeHtmlPayload(ctx.html, ctx.htmlBytes);
  const contentType = ctx.headers.get('content-type');
  const contentSignal = ctx.headers.get('content-signal');
  const xRobotsTag = ctx.headers.get('x-robots-tag');
  const wafState = detectPassiveWafState(
    ctx.headers,
    ctx.html,
    ctx.status,
    payload.visibleCharCount,
    payload.meta.title,
  );

  const noindex =
    hasNoindexDirective(xRobotsTag) ||
    hasNoindexDirective(payload.meta.robots) ||
    hasNoindexDirective(payload.meta.googlebot);

  const firstH1 = payload.headings.find((h) => h.level === 1)?.text ?? '';
  const soft404 =
    ctx.status === 200 &&
    payload.visibleCharCount < SOFT_404_MAX_TEXT_CHARS &&
    (SOFT_404_RE.test(payload.meta.title ?? '') || SOFT_404_RE.test(firstH1));

  const payloadToProseRatio =
    payload.visibleTextBytes > 0
      ? Number((payload.htmlBytes / payload.visibleTextBytes).toFixed(2))
      : payload.htmlBytes > 0
        ? payload.htmlBytes
        : null;

  /** @type {PageFinding[]} */
  const findings = [];

  if (ctx.robotsDisallowed) {
    findings.push({
      id: 'robots_disallowed_page',
      severity: 'attention',
      category: 'robots',
      title: 'Page is disallowed in robots.txt (audited via --ignore-robots-for-own-site)',
      detail: `${ctx.url} is blocked by robots.txt rules.`,
      scope: 'page',
    });
  }

  if (ctx.redirects.loopDetected) {
    findings.push({
      id: 'redirect_loop',
      severity: 'critical',
      category: 'redirects',
      title: 'Redirect loop detected',
      detail: `Redirect chain looped while fetching ${ctx.url}.`,
      scope: 'page',
    });
  } else if (ctx.redirects.maxHopsExceeded) {
    findings.push({
      id: 'max_redirects_exceeded',
      severity: 'critical',
      category: 'redirects',
      title: 'Too many redirects',
      detail: `Exceeded maximum redirect hops while fetching ${ctx.url}.`,
      scope: 'page',
    });
  }

  if (ctx.status >= 400) {
    findings.push({
      id: 'http_error',
      severity: 'critical',
      category: 'headers',
      title: `Page returned HTTP ${ctx.status}`,
      detail: `${ctx.finalUrl} responded with HTTP ${ctx.status}.`,
      scope: 'page',
    });
  }

  if (wafState === 'challenge_or_block_intercepted') {
    findings.push({
      id: 'waf_challenge_intercepted',
      severity: 'critical',
      category: 'waf',
      title: 'WAF/bot challenge intercepted page',
      detail: `${ctx.finalUrl} returned a bot/WAF challenge response (HTTP ${ctx.status}).`,
      scope: 'page',
    });
  }

  if (soft404) {
    findings.push({
      id: 'soft_404_detected',
      severity: 'critical',
      category: 'indexing',
      title: 'Suspected soft-404 (HTTP 200 error page)',
      detail: `${ctx.finalUrl} returned HTTP 200 with 404/Not Found heading or title and <1,000 visible chars.`,
      scope: 'page',
    });
  }

  if (noindex) {
    findings.push({
      id: 'noindex_detected',
      severity: 'critical',
      category: 'indexing',
      title: 'Page is marked noindex',
      detail: `${ctx.finalUrl} includes a noindex directive.`,
      scope: 'page',
    });
  }

  if (payload.csrRisk.level === 'high') {
    findings.push({
      id: 'csr_empty_shell_high',
      severity: 'critical',
      category: 'csr',
      title: 'High client-side rendering (CSR) empty-shell risk',
      detail: payload.csrRisk.reasons.join('; ') || 'Minimal visible text in raw HTML with SPA markers.',
      scope: 'template',
    });
  } else if (payload.csrRisk.level === 'medium') {
    findings.push({
      id: 'csr_empty_shell_medium',
      severity: 'attention',
      category: 'csr',
      title: 'Medium client-side rendering (CSR) risk',
      detail: payload.csrRisk.reasons.join('; ') || 'Sparse raw HTML text relative to client scripts.',
      scope: 'template',
    });
  }

  if (payload.htmlBytes >= 2 * 1024 * 1024) {
    findings.push({
      id: 'html_over_2mb',
      severity: 'critical',
      category: 'payload',
      title: 'Raw uncompressed HTML exceeds Googlebot 2 MB cutoff',
      detail: `${ctx.finalUrl} is ${(payload.htmlBytes / (1024 * 1024)).toFixed(2)} MB uncompressed.`,
      scope: 'template',
    });
  } else if (payload.truncationRisks.coreContentPast100KB) {
    findings.push({
      id: 'truncation_core_past_100kb',
      severity: 'attention',
      category: 'payload',
      title: 'Core visible content extends past 100 KB',
      detail: `${ctx.finalUrl} places primary content past 100 KB of raw HTML.`,
      scope: 'template',
    });
  }

  if (ctx.status >= 200 && ctx.status < 300 && !soft404 && wafState !== 'challenge_or_block_intercepted') {
    if (!payload.meta.title) {
      findings.push({
        id: 'missing_title',
        severity: 'attention',
        category: 'indexing',
        title: 'Missing <title> element',
        detail: `${ctx.finalUrl} has no non-empty <title> tag.`,
        scope: 'template',
      });
    }
    if (payload.offsets.firstH1Bytes === null && payload.visibleWordCount > 0) {
      findings.push({
        id: 'missing_h1',
        severity: 'attention',
        category: 'payload',
        title: 'Missing <h1> heading in raw HTML',
        detail: `${ctx.finalUrl} has no <h1> heading in initial HTML.`,
        scope: 'template',
      });
    }
  }

  const ctLower = (contentType ?? '').toLowerCase();
  return {
    url: ctx.url,
    finalUrl: ctx.finalUrl,
    template: ctx.template,
    isHomepage: ctx.isHomepage,
    status: ctx.status,
    ok: ctx.status >= 200 && ctx.status < 400 && !ctx.redirects.loopDetected && !ctx.redirects.maxHopsExceeded,
    timingMs: ctx.timingMs,
    htmlBytes: payload.htmlBytes,
    visibleWordCount: payload.visibleWordCount,
    visibleCharCount: payload.visibleCharCount,
    renderedWordCount: null,
    proseParityPct: null,
    payloadToProseRatio,
    title: payload.meta.title,
    canonical: payload.meta.canonical,
    noindex,
    soft404,
    robotsDisallowed: ctx.robotsDisallowed,
    wafState,
    contentType,
    contentSignal,
    markdownNegotiation: ctLower.includes('text/markdown'),
    stack: [],
    payload,
    redirects: ctx.redirects,
    findings,
  };
}

/**
 * Severity rank helper (higher = more severe).
 * @param {string} severity
 * @returns {number}
 */
function severityRank(severity) {
  if (severity === 'critical') return 3;
  if (severity === 'attention' || severity === 'warning') return 2;
  return 1;
}

/**
 * Group multi-page audit findings by structural URL template so users see
 * `"Fix 1 template → fix N pages"` instead of flat walls of duplicate page issues.
 *
 * @param {Array<{
 *   url: string,
 *   finalUrl?: string,
 *   template?: string,
 *   findings?: Array<{id?: string, ruleId?: string, severity: 'critical'|'attention'|'warning'|'info', category?: string, title?: string, detail?: string, summary?: string, scope?: string}>,
 * }>} pageResults
 * @param {{siteFindings?: PageFinding[]}} [options]
 * @returns {TemplateClusterReport}
 */
export function clusterIssuesByTemplate(pageResults, options = {}) {
  const pages = Array.isArray(pageResults) ? pageResults : [];
  const totalPages = pages.length;

  /** @type {Map<string, number>} */
  const templateTotals = new Map();
  /** @type {Array<{url: string, template: string, findings: NonNullable<typeof pages[number]['findings']>}>} */
  const normalizedPages = pages.map((page) => {
    const url = page.finalUrl || page.url;
    const template = page.template || normalizeUrlTemplate(url);
    templateTotals.set(template, (templateTotals.get(template) ?? 0) + 1);
    return {
      url,
      template,
      findings: Array.isArray(page.findings) ? page.findings : [],
    };
  });

  /** @type {SiteWideIssueItem[]} */
  const siteWide = [];
  /** @type {Set<string>} */
  const explicitSiteRuleIds = new Set();

  if (Array.isArray(options.siteFindings)) {
    for (const sf of options.siteFindings) {
      const ruleId = sf.ruleId ?? sf.id;
      explicitSiteRuleIds.add(ruleId);
      siteWide.push({
        ruleId,
        severity: sf.severity,
        category: sf.category,
        affectedCount: totalPages,
        totalPages,
        summary: sf.title || sf.detail || ruleId,
        sampleUrls: normalizedPages.slice(0, MAX_CLUSTER_SAMPLE_URLS).map((p) => p.url),
      });
    }
  }

  /**
   * Collect all occurrences per ruleId across pages.
   * @type {Map<string, {
   *   ruleId: string,
   *   severity: 'critical'|'attention'|'warning'|'info',
   *   category: string,
   *   title: string,
   *   detail: string,
   *   explicitSiteScope: boolean,
   *   urls: Set<string>,
   *   templates: Map<string, {urls: Set<string>, title: string, detail: string, severity: 'critical'|'attention'|'warning'|'info'}>,
   * }>}
   */
  const byRule = new Map();

  for (const page of normalizedPages) {
    for (const f of page.findings) {
      const ruleId = f.ruleId ?? f.id ?? 'unknown_rule';
      if (explicitSiteRuleIds.has(ruleId)) continue;
      const category = f.category ?? 'general';
      const isSiteScope = f.scope === 'site' || (SITE_WIDE_CATEGORIES.has(category) && f.scope !== 'page');

      let entry = byRule.get(ruleId);
      if (!entry) {
        entry = {
          ruleId,
          severity: f.severity,
          category,
          title: f.title ?? f.summary ?? ruleId,
          detail: f.detail ?? f.title ?? ruleId,
          explicitSiteScope: isSiteScope,
          urls: new Set(),
          templates: new Map(),
        };
        byRule.set(ruleId, entry);
      } else {
        if (severityRank(f.severity) > severityRank(entry.severity)) {
          entry.severity = f.severity;
        }
        if (isSiteScope) entry.explicitSiteScope = true;
      }

      entry.urls.add(page.url);
      let tplEntry = entry.templates.get(page.template);
      if (!tplEntry) {
        tplEntry = {
          urls: new Set(),
          title: f.title ?? f.summary ?? ruleId,
          detail: f.detail ?? f.title ?? ruleId,
          severity: f.severity,
        };
        entry.templates.set(page.template, tplEntry);
      } else if (severityRank(f.severity) > severityRank(tplEntry.severity)) {
        tplEntry.severity = f.severity;
      }
      tplEntry.urls.add(page.url);
    }
  }

  /** @type {TemplateClusterItem[]} */
  const templateClusters = [];
  /** @type {PageOutlierItem[]} */
  const pageOutliers = [];

  for (const entry of byRule.values()) {
    const affectedPageCount = entry.urls.size;
    const distinctTemplateCount = entry.templates.size;
    const spansAllPagesAcrossTemplates =
      totalPages >= 2 && distinctTemplateCount >= 2 && affectedPageCount === totalPages;

    if (entry.explicitSiteScope || spansAllPagesAcrossTemplates) {
      siteWide.push({
        ruleId: entry.ruleId,
        severity: entry.severity,
        category: entry.category,
        affectedCount: affectedPageCount,
        totalPages,
        summary: `${entry.title} (site-wide: ${affectedPageCount}/${totalPages} audited pages)`,
        sampleUrls: [...entry.urls].slice(0, MAX_CLUSTER_SAMPLE_URLS),
      });
      continue;
    }

    for (const [template, tplData] of entry.templates.entries()) {
      const affectedCount = tplData.urls.size;
      const totalInTemplate = templateTotals.get(template) ?? affectedCount;
      const sampleUrls = [...tplData.urls].slice(0, MAX_CLUSTER_SAMPLE_URLS);

      if (affectedCount >= 2) {
        templateClusters.push({
          template,
          affectedCount,
          totalInTemplate,
          ruleId: entry.ruleId,
          severity: tplData.severity,
          summary: `Fix 1 template (${template}) → fix ${affectedCount}/${totalInTemplate} pages: ${tplData.title}`,
          sampleUrls,
        });
      } else {
        const onlyUrl = sampleUrls[0];
        pageOutliers.push({
          url: onlyUrl,
          template,
          ruleId: entry.ruleId,
          severity: tplData.severity,
          title: tplData.title,
          detail: tplData.detail,
        });
      }
    }
  }

  siteWide.sort((a, b) =>
    severityRank(b.severity) - severityRank(a.severity) ||
    b.affectedCount - a.affectedCount ||
    a.ruleId.localeCompare(b.ruleId),
  );

  templateClusters.sort((a, b) =>
    severityRank(b.severity) - severityRank(a.severity) ||
    b.affectedCount - a.affectedCount ||
    a.template.localeCompare(b.template) ||
    a.ruleId.localeCompare(b.ruleId),
  );

  pageOutliers.sort((a, b) =>
    severityRank(b.severity) - severityRank(a.severity) ||
    a.url.localeCompare(b.url) ||
    a.ruleId.localeCompare(b.ruleId),
  );

  /** @type {Record<string, number>} */
  const templateCounts = {};
  for (const [tpl, count] of templateTotals.entries()) {
    templateCounts[tpl] = count;
  }

  return {
    siteWide,
    templateClusters,
    pageOutliers,
    templateCounts,
  };
}

/**
 * Crawl a site's key pages (default up to 15 pages with `--single` override).
 *
 * Features:
 *  - Per-hop DNS-resolving SSRF guard (unless `allowPrivateHosts: true`)
 *  - Single-pass HTML analysis (never double-fetches pages)
 *  - AIMD polite throttle (backs off on 429/503 or >2s latency; respects `Crawl-delay` up to 3s cap)
 *  - Mandatory `audited / skipped / errored` accounting (disallowed `robots.txt` pages recorded in
 *    `skipped` with `reason: 'robots_disallowed'`, NEVER marked PASS!)
 *  - Optional `ignoreRobotsForOwnSite: true` to audit disallowed routes while still flagging them
 *  - Optional `checkCaching: true` performing 1 conditional GET on the homepage for `304 Not Modified`
 *  - Hard Infrastructure Gate capping blocked/challenge/empty-shell homepages to `not_observed`
 *  - Template-level issue clustering (`"fix 1 template → fix N pages"`)
 *
 * @param {string} startUrl
 * @param {CrawlSiteOptions} [options]
 * @returns {Promise<CrawlSiteReport>}
 */
export async function crawlSitePages(startUrl, options = {}) {
  const crawlStartedAt = Date.now();
  const single = options.single === true;
  const maxPages = single
    ? 1
    : typeof options.maxPages === 'number' && Number.isInteger(options.maxPages) && options.maxPages > 0
      ? options.maxPages
      : DEFAULT_MAX_PAGES;
  const maxPerTemplate =
    typeof options.maxPerTemplate === 'number' && Number.isInteger(options.maxPerTemplate) && options.maxPerTemplate > 0
      ? options.maxPerTemplate
      : DEFAULT_MAX_PER_TEMPLATE;
  const allowPrivateHosts = options.allowPrivateHosts === true;
  const ignoreRobotsForOwnSite = options.ignoreRobotsForOwnSite === true;
  const includeAuthRoutes = options.includeAuthRoutes === true;
  const checkCaching = options.checkCaching === true;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const lookupFn = options.lookup === null ? null : (options.lookup ?? dnsLookup);
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxConcurrency =
    typeof options.maxConcurrency === 'number' && Number.isInteger(options.maxConcurrency) && options.maxConcurrency > 0
      ? options.maxConcurrency
      : DEFAULT_MAX_CONCURRENCY;
  const maxRedirects =
    typeof options.maxRedirects === 'number' && Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0
      ? options.maxRedirects
      : DEFAULT_MAX_REDIRECTS;
  const maxHtmlBytes =
    typeof options.maxHtmlBytes === 'number' && Number.isFinite(options.maxHtmlBytes) && options.maxHtmlBytes > 0
      ? options.maxHtmlBytes
      : DEFAULT_MAX_HTML_BYTES;

  // Validate & enforce SSRF guard on startUrl (SSRF / invalid_url always throw)
  const initialParsed = validateSiteUrl(startUrl);
  await assertSafeUrl(initialParsed, { allowPrivateHosts, lookupFn });
  const requestedUrl = initialParsed.href;
  const startTemplate = normalizeUrlTemplate(initialParsed.pathname);

  /** @type {CrawledPageResult[]} */
  const pages = [];
  /** @type {SkippedPageEntry[]} */
  const skipped = [];
  /** @type {ErroredPageEntry[]} */
  const errored = [];
  /** @type {Array<{from: string, to: string, status: number}>} */
  const redirectsResolved = [];
  /** @type {PageFinding[]} */
  const siteFindings = [];

  /** @type {CachingCheckResult} */
  let caching = {
    checked: false,
    supported304: null,
    status: null,
    etag: null,
    lastModified: null,
    sentHeaders: { ifNoneMatch: null, ifModifiedSince: null },
    timingMs: 0,
    reason: 'not_requested',
  };

  /** @type {SafeFetchResult|null} */
  let homeFetch = null;
  try {
    homeFetch = await fetchWithSsrfGuard(requestedUrl, {
      allowPrivateHosts,
      fetchFn,
      lookupFn,
      timeoutMs,
      maxRedirects,
      signal: options.signal,
    });
  } catch (err) {
    // Always rethrow URL validation & SSRF blocks on the target itself
    if (err instanceof SiteCheckError && (err.code === 'invalid_url' || err.code === 'ssrf_blocked')) {
      throw err;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = err instanceof SiteCheckError ? err.code : 'fetch_failed';
    errored.push({
      url: requestedUrl,
      template: startTemplate,
      reason: errCode,
      error: errMsg,
    });
    const hardGate = evaluateHardGate({ status: null, transportError: true, error: errMsg });
    siteFindings.push({
      id: 'hard_infrastructure_gate',
      severity: 'critical',
      category: 'waf',
      title: `Hard Infrastructure Gate triggered (${hardGate.reason})`,
      detail: hardGate.detail ?? errMsg,
      scope: 'site',
    });
    return {
      schemaVersion: 2,
      crawledAt: new Date().toISOString(),
      requestedUrl,
      finalUrl: requestedUrl,
      domain: initialParsed.hostname.toLowerCase(),
      mode: single ? 'single' : 'multi',
      status: 'blocked_hard_gate',
      downstreamStatus: 'not_observed',
      hardGate,
      coverageComplete: false,
      scopeSummary: '0 audited | 0 skipped | 1 errored (homepage transport failure)',
      counts: {
        discovered: 1,
        selected: 1,
        audited: 0,
        skipped: 0,
        errored: 1,
        redirectsResolved: 0,
        skippedByReason: {
          robots_disallowed: 0,
          ssrf_blocked: 0,
          max_pages_cap: 0,
          template_cap: 0,
          auth_or_utility_route: 0,
        },
      },
      pages,
      skipped,
      errored,
      redirectsResolved,
      robotsTxt: {
        url: `${initialParsed.origin}/robots.txt`,
        status: null,
        fetched: false,
        soft404: false,
        error: 'Not fetched because homepage transport failed.',
        crawlDelaySec: null,
        contentSignal: null,
        sitemaps: [],
        crawlers: [],
        blockedCount: 0,
        allowedCount: 0,
      },
      sitemap: null,
      caching,
      throttle: { initialDelayMs: 0, finalDelayMs: 0, crawlDelayFloorMs: 0, slowdowns: 0, totalWaitMs: 0 },
      siteFindings,
      clusters: clusterIssuesByTemplate(pages, { siteFindings }),
      timingMs: Date.now() - crawlStartedAt,
    };
  }

  const finalHomeUrl = normalizeCandidateUrl(homeFetch.finalUrl) ?? homeFetch.finalUrl;
  const finalHomeParsed = new URL(finalHomeUrl);
  const finalOrigin = finalHomeParsed.origin;
  const domain = finalHomeParsed.hostname.toLowerCase();

  let homeHtml = '';
  let homeHtmlBytes = 0;
  if (!homeFetch.loopDetected && !homeFetch.maxHopsExceeded) {
    const { buffer } = await readBodyCapped(homeFetch.response, maxHtmlBytes);
    homeHtmlBytes = buffer.byteLength;
    homeHtml = buffer.toString('utf8');
  }

  const homeEtag = homeFetch.response.headers.get('etag');
  const homeLastModified = homeFetch.response.headers.get('last-modified');
  caching.etag = homeEtag;
  caching.lastModified = homeLastModified;

  // Fetch /robots.txt once for the final origin
  const robotsUrl = `${finalOrigin}/robots.txt`;
  let robotsRawText = '';
  /** @type {CrawlSiteReport['robotsTxt']} */
  let robotsInfo = {
    url: robotsUrl,
    status: null,
    fetched: false,
    soft404: false,
    error: null,
    crawlDelaySec: null,
    contentSignal: null,
    sitemaps: [],
    crawlers: [],
    blockedCount: 0,
    allowedCount: 0,
  };

  try {
    const robotsFetch = await fetchWithSsrfGuard(robotsUrl, {
      allowPrivateHosts,
      fetchFn,
      lookupFn,
      timeoutMs,
      maxRedirects: Math.min(maxRedirects, 5),
      headers: { accept: 'text/plain, */*;q=0.5' },
      signal: options.signal,
    });
    robotsInfo.status = robotsFetch.response.status;
    if (robotsFetch.response.status >= 200 && robotsFetch.response.status < 300) {
      const { buffer } = await readBodyCapped(robotsFetch.response, 512 * 1024);
      const rawText = buffer.toString('utf8');
      const rct = robotsFetch.response.headers.get('content-type');
      if (isHtmlSoft404Document(rawText, rct)) {
        robotsInfo.soft404 = true;
        robotsInfo.error = 'robots.txt returned HTML (SPA catch-all soft-404)';
        siteFindings.push({
          id: 'robots_txt_soft_404',
          severity: 'attention',
          category: 'robots',
          title: 'robots.txt returned HTTP 200 text/html (soft-404)',
          detail: `${robotsUrl} served HTML instead of plain text robots directives.`,
          scope: 'site',
        });
      } else {
        robotsRawText = rawText;
        robotsInfo.fetched = true;
        robotsInfo.crawlDelaySec = parseCrawlDelay(rawText, 'HearsaySiteCheck');
        robotsInfo.contentSignal = extractRobotsContentSignal(rawText);
        const homePath = `${finalHomeParsed.pathname || '/'}${finalHomeParsed.search}`;
        const crawlers = AI_CRAWLERS.map((bot) => {
          const parsed = parseRobotsTxt(rawText, homePath, bot);
          return {
            bot,
            allowed: parsed.allowed,
            status: parsed.status,
            rule: parsed.rule,
            matchedGroup: parsed.matchedGroup,
          };
        });
        robotsInfo.sitemaps = parseRobotsTxt(rawText, homePath, '*').sitemaps;
        robotsInfo.crawlers = crawlers;
        robotsInfo.blockedCount = crawlers.filter((c) => !c.allowed).length;
        robotsInfo.allowedCount = crawlers.filter((c) => c.allowed).length;

        const blockedSearch = crawlers.filter((c) => !c.allowed && SEARCH_RETRIEVAL_BOTS.has(c.bot));
        const blockedTrad = crawlers.filter((c) => !c.allowed && TRADITIONAL_SEARCH_BOTS.has(c.bot));
        if (blockedTrad.length > 0) {
          siteFindings.push({
            id: 'traditional_search_bots_blocked',
            severity: 'critical',
            category: 'robots',
            title: `Traditional search crawler(s) blocked: ${blockedTrad.map((c) => c.bot).join(', ')}`,
            detail: blockedTrad.map((c) => `${c.bot} (${c.rule ?? 'blocked'})`).join('; '),
            scope: 'site',
          });
        }
        if (blockedSearch.length > 0) {
          siteFindings.push({
            id: 'ai_search_bots_blocked',
            severity: 'critical',
            category: 'robots',
            title: `AI search/retrieval crawler(s) blocked: ${blockedSearch.map((c) => c.bot).join(', ')}`,
            detail: blockedSearch.map((c) => `${c.bot} (${c.rule ?? 'blocked'})`).join('; '),
            scope: 'site',
          });
        }
      }
    } else if (robotsFetch.response.status >= 400 && robotsFetch.response.status < 500) {
      await robotsFetch.response.body?.cancel().catch(() => {});
      robotsInfo.crawlers = AI_CRAWLERS.map((bot) => ({
        bot,
        allowed: true,
        status: 'default_allowed',
        rule: null,
        matchedGroup: null,
      }));
      robotsInfo.allowedCount = robotsInfo.crawlers.length;
    } else {
      await robotsFetch.response.body?.cancel().catch(() => {});
      robotsInfo.error = `robots.txt returned HTTP ${robotsFetch.response.status}`;
      robotsInfo.crawlers = AI_CRAWLERS.map((bot) => ({
        bot,
        allowed: false,
        status: 'unavailable',
        rule: null,
        matchedGroup: null,
      }));
      robotsInfo.blockedCount = robotsInfo.crawlers.length;
    }
  } catch (err) {
    robotsInfo.error = err instanceof Error ? err.message : String(err);
  }

  // Analyze homepage (single-pass)
  const homeCtx = {
    url: requestedUrl,
    finalUrl: finalHomeUrl,
    template: normalizeUrlTemplate(finalHomeParsed.pathname),
    isHomepage: true,
    status: homeFetch.response.status,
    headers: homeFetch.response.headers,
    html: homeHtml,
    htmlBytes: homeHtmlBytes,
    timingMs: homeFetch.timingMs,
    redirects: {
      count: homeFetch.hops.length,
      hops: homeFetch.hops,
      loopDetected: homeFetch.loopDetected,
      maxHopsExceeded: homeFetch.maxHopsExceeded,
    },
    robotsDisallowed: false,
  };

  let homepageResult = defaultAnalyzePage(homeCtx);
  if (typeof options.pageChecker === 'function') {
    const custom = await options.pageChecker(homeCtx);
    if (custom && typeof custom === 'object') {
      homepageResult = {
        ...homepageResult,
        ...custom,
        findings: Array.isArray(custom.findings) ? custom.findings : homepageResult.findings,
      };
    }
  }
  pages.push(homepageResult);

  // Optional conditional GET caching check (1 request on homepage)
  if (checkCaching && homeFetch.response.status >= 200 && homeFetch.response.status < 300) {
    if (homeEtag || homeLastModified) {
      /** @type {Record<string, string>} */
      const condHeaders = {};
      if (homeEtag) condHeaders['if-none-match'] = homeEtag;
      if (homeLastModified) condHeaders['if-modified-since'] = homeLastModified;
      try {
        const condRes = await fetchWithSsrfGuard(finalHomeUrl, {
          allowPrivateHosts,
          fetchFn,
          lookupFn,
          timeoutMs,
          maxRedirects: Math.min(maxRedirects, 5),
          headers: condHeaders,
          signal: options.signal,
        });
        await condRes.response.body?.cancel().catch(() => {});
        caching = {
          checked: true,
          supported304: condRes.response.status === 304,
          status: condRes.response.status,
          etag: homeEtag,
          lastModified: homeLastModified,
          sentHeaders: { ifNoneMatch: homeEtag, ifModifiedSince: homeLastModified },
          timingMs: condRes.timingMs,
          reason:
            condRes.response.status === 304
              ? 'supports_304_not_modified'
              : `returned_http_${condRes.response.status}`,
        };
      } catch (err) {
        caching = {
          checked: true,
          supported304: false,
          status: null,
          etag: homeEtag,
          lastModified: homeLastModified,
          sentHeaders: { ifNoneMatch: homeEtag, ifModifiedSince: homeLastModified },
          timingMs: 0,
          reason: err instanceof Error ? err.message : 'conditional_get_failed',
        };
      }
    } else {
      caching = {
        checked: true,
        supported304: false,
        status: null,
        etag: null,
        lastModified: null,
        sentHeaders: { ifNoneMatch: null, ifModifiedSince: null },
        timingMs: 0,
        reason: 'no_validators_present',
      };
    }
  }

  const aimd = createAimdController({
    crawlDelaySec: robotsInfo.crawlDelaySec,
    sleepFn: options.sleepFn,
  });
  aimd.recordResponse({ status: homeFetch.response.status, timingMs: homeFetch.timingMs });

  // Evaluate Hard Infrastructure Gate on homepage
  const hardGate = evaluateHardGate(homepageResult);
  if (hardGate.triggered) {
    siteFindings.push({
      id: 'hard_infrastructure_gate',
      severity: 'critical',
      category: 'waf',
      title: `Hard Infrastructure Gate triggered (${hardGate.reason})`,
      detail: hardGate.detail ?? 'Homepage failed hard infrastructure gate; downstream checks not observed.',
      scope: 'site',
    });

    const clusters = clusterIssuesByTemplate(pages, { siteFindings });
    return {
      schemaVersion: 2,
      crawledAt: new Date().toISOString(),
      requestedUrl,
      finalUrl: finalHomeUrl,
      domain,
      mode: single ? 'single' : 'multi',
      status: 'blocked_hard_gate',
      downstreamStatus: 'not_observed',
      hardGate,
      coverageComplete: false,
      scopeSummary: `1 audited (homepage blocked: ${hardGate.reason}) | downstream checks not_observed`,
      counts: {
        discovered: 1,
        selected: 1,
        audited: pages.filter((p) => typeof p.status === 'number' && p.status > 0).length,
        skipped: 0,
        errored: 0,
        redirectsResolved: 0,
        skippedByReason: {
          robots_disallowed: 0,
          ssrf_blocked: 0,
          max_pages_cap: 0,
          template_cap: 0,
          auth_or_utility_route: 0,
        },
      },
      pages,
      skipped,
      errored,
      redirectsResolved,
      robotsTxt: robotsInfo,
      sitemap: null,
      caching,
      throttle: aimd.getStats(),
      siteFindings,
      clusters,
      timingMs: Date.now() - crawlStartedAt,
    };
  }

  /** @type {SitemapDiscoveryResult|null} */
  let sitemapResult = null;
  let discoveredCount = 1;
  let selectedCount = 1;

  if (!single) {
    const { navLinks, bodyLinks } = extractPageLinks(homeHtml, finalHomeUrl);

    sitemapResult = await discoverSitemapUrls(finalOrigin, {
      robotsTxt: robotsInfo.fetched ? robotsRawText : null,
      robotsSitemaps: robotsInfo.sitemaps,
      allowPrivateHosts,
      fetchImpl: fetchFn,
      lookup: lookupFn,
      timeoutMs,
      maxRedirects,
      signal: options.signal,
    });

    const combinedNav = [...navLinks, ...bodyLinks];
    /** @type {Set<string>} */
    const seenAuthSkipped = new Set();

    /**
     * Filter out discovered auth/utility routes unless `includeAuthRoutes === true`,
     * recording each skipped route transparently in `skipped`.
     * @param {string[]} urls
     * @returns {string[]}
     */
    const filterAuthRoutes = (urls) => {
      if (includeAuthRoutes) return urls;
      /** @type {string[]} */
      const kept = [];
      for (const raw of urls) {
        const norm = normalizeCandidateUrl(raw, finalOrigin);
        if (!norm || norm === finalHomeUrl || norm === requestedUrl) {
          kept.push(raw);
          continue;
        }
        const parsed = new URL(norm);
        if (parsed.origin !== finalOrigin || STATIC_ASSET_EXT_RE.test(parsed.pathname)) {
          kept.push(raw);
          continue;
        }
        if (isAuthOrUtilityPath(parsed.pathname)) {
          if (!seenAuthSkipped.has(norm)) {
            seenAuthSkipped.add(norm);
            skipped.push({
              url: norm,
              template: normalizeUrlTemplate(parsed.pathname),
              reason: 'auth_or_utility_route',
              rule: null,
              matchedGroup: null,
              detail: 'Skipped non-content auth/utility route (pass includeAuthRoutes: true to audit)',
            });
          }
          continue;
        }
        kept.push(raw);
      }
      return kept;
    };

    const filteredNav = filterAuthRoutes(combinedNav);
    const filteredSitemap = filterAuthRoutes(sitemapResult.urls);

    const selection = selectKeyPages({
      homepageUrl: finalHomeUrl,
      navLinks: filteredNav,
      sitemapUrls: filteredSitemap,
      maxPages,
      maxPerTemplate,
    });

    const uniqueDiscovered = new Set([finalHomeUrl, ...combinedNav, ...sitemapResult.urls]);
    discoveredCount = uniqueDiscovered.size;
    selectedCount = selection.selected.length;

    for (const capSkip of selection.skippedByCap) {
      skipped.push({
        url: capSkip.url,
        template: capSkip.template,
        reason: capSkip.reason,
        rule: null,
        matchedGroup: null,
        detail: capSkip.reason === 'template_cap'
          ? `Template ${capSkip.template} reached sample cap (${maxPerTemplate})`
          : `Reached maxPages cap (${maxPages})`,
      });
    }

    // Filter remaining selected URLs (excluding homepage at index 0) through robots.txt
    /** @type {Array<{index: number, url: string, template: string, robotsDisallowed: boolean}>} */
    const crawlQueue = [];
    const seenFinalUrls = new Set([finalHomeUrl]);

    for (let idx = 1; idx < selection.selected.length; idx++) {
      const candidate = selection.selected[idx];
      const candParsed = new URL(candidate.url);
      const candPath = `${candParsed.pathname || '/'}${candParsed.search}`;

      let robotsDisallowed = false;
      if (robotsInfo.fetched && robotsRawText) {
        const evalResult = parseRobotsTxt(robotsRawText, candPath, 'HearsaySiteCheck');
        if (!evalResult.allowed) {
          if (!ignoreRobotsForOwnSite) {
            skipped.push({
              url: candidate.url,
              template: candidate.template,
              reason: 'robots_disallowed',
              rule: evalResult.rule,
              matchedGroup: evalResult.matchedGroup,
              detail: `Blocked by robots.txt (${evalResult.rule ?? 'Disallow'} in group ${evalResult.matchedGroup ?? '*'})`,
            });
            continue;
          }
          robotsDisallowed = true;
        }
      }

      crawlQueue.push({
        index: idx,
        url: candidate.url,
        template: candidate.template,
        robotsDisallowed,
      });
    }

    /** @type {Array<{index: number, page: CrawledPageResult}>} */
    const collectedPages = [];
    let cursor = 0;

    const workerCount = Math.min(maxConcurrency, Math.max(1, crawlQueue.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < crawlQueue.length) {
        if (options.signal?.aborted) break;
        const item = crawlQueue[cursor++];
        if (!item) break;

        await aimd.waitBeforeNext();

        /** @type {SafeFetchResult} */
        let res;
        try {
          res = await fetchWithSsrfGuard(item.url, {
            allowPrivateHosts,
            fetchFn,
            lookupFn,
            timeoutMs,
            maxRedirects,
            signal: options.signal,
          });
        } catch (err) {
          if (err instanceof SiteCheckError && err.code === 'ssrf_blocked') {
            skipped.push({
              url: item.url,
              template: item.template,
              reason: 'ssrf_blocked',
              rule: null,
              matchedGroup: null,
              detail: err.message,
            });
            continue;
          }
          errored.push({
            url: item.url,
            template: item.template,
            reason: err instanceof SiteCheckError ? err.code : 'fetch_failed',
            error: err instanceof Error ? err.message : String(err),
          });
          aimd.recordResponse({ status: 503, timingMs: timeoutMs });
          continue;
        }

        aimd.recordResponse({ status: res.response.status, timingMs: res.timingMs });

        const resolvedFinal = normalizeCandidateUrl(res.finalUrl) ?? res.finalUrl;
        // Resolve 301/308 redirects pointing to already-audited URLs without counting as duplicate pages
        if (res.hops.length > 0 && seenFinalUrls.has(resolvedFinal)) {
          await res.response.body?.cancel().catch(() => {});
          redirectsResolved.push({
            from: item.url,
            to: resolvedFinal,
            status: res.hops[0].status,
          });
          continue;
        }
        seenFinalUrls.add(resolvedFinal);

        let bodyHtml = '';
        let bodyBytes = 0;
        if (!res.loopDetected && !res.maxHopsExceeded) {
          const { buffer } = await readBodyCapped(res.response, maxHtmlBytes);
          bodyBytes = buffer.byteLength;
          bodyHtml = buffer.toString('utf8');
        }

        const pageCtx = {
          url: item.url,
          finalUrl: resolvedFinal,
          template: normalizeUrlTemplate(new URL(resolvedFinal).pathname),
          isHomepage: false,
          status: res.response.status,
          headers: res.response.headers,
          html: bodyHtml,
          htmlBytes: bodyBytes,
          timingMs: res.timingMs,
          redirects: {
            count: res.hops.length,
            hops: res.hops,
            loopDetected: res.loopDetected,
            maxHopsExceeded: res.maxHopsExceeded,
          },
          robotsDisallowed: item.robotsDisallowed,
        };

        let pageResult = defaultAnalyzePage(pageCtx);
        if (typeof options.pageChecker === 'function') {
          const custom = await options.pageChecker(pageCtx);
          if (custom && typeof custom === 'object') {
            pageResult = {
              ...pageResult,
              ...custom,
              findings: Array.isArray(custom.findings) ? custom.findings : pageResult.findings,
            };
          }
        }
        collectedPages.push({ index: item.index, page: pageResult });
      }
    });

    await Promise.all(workers);

    collectedPages.sort((a, b) => a.index - b.index);
    for (const item of collectedPages) {
      pages.push(item.page);
    }
  }

  // Honest audited / skipped / errored accounting
  const skippedByReason = {
    robots_disallowed: skipped.filter((s) => s.reason === 'robots_disallowed').length,
    ssrf_blocked: skipped.filter((s) => s.reason === 'ssrf_blocked').length,
    max_pages_cap: skipped.filter((s) => s.reason === 'max_pages_cap').length,
    template_cap: skipped.filter((s) => s.reason === 'template_cap').length,
    auth_or_utility_route: skipped.filter((s) => s.reason === 'auth_or_utility_route').length,
  };

  const auditedCount = pages.filter((p) => typeof p.status === 'number' && p.status > 0).length;
  const counts = {
    discovered: discoveredCount,
    selected: selectedCount,
    audited: auditedCount,
    skipped: skipped.length,
    errored: errored.length,
    redirectsResolved: redirectsResolved.length,
    skippedByReason,
  };

  const clusters = clusterIssuesByTemplate(pages, { siteFindings });

  const allFindings = [...siteFindings, ...pages.flatMap((p) => p.findings)];
  const hasCritical = allFindings.some((f) => f.severity === 'critical');
  const hasAttention = allFindings.some((f) => f.severity === 'attention' || f.severity === 'warning');
  const coverageComplete = skipped.length === 0 && errored.length === 0;

  /** @type {'pass'|'attention'|'critical'|'blocked_hard_gate'} */
  let overallStatus = 'pass';
  if (hasCritical) {
    overallStatus = 'critical';
  } else if (
    hasAttention ||
    skippedByReason.robots_disallowed > 0 ||
    skippedByReason.ssrf_blocked > 0 ||
    errored.length > 0
  ) {
    // Never return a clean 'pass' bill when pages were blocked by robots/SSRF or errored!
    overallStatus = 'attention';
  }

  /** @type {string[]} */
  const skipParts = [];
  if (skippedByReason.robots_disallowed > 0) skipParts.push(`robots.txt: ${skippedByReason.robots_disallowed}`);
  if (skippedByReason.ssrf_blocked > 0) skipParts.push(`ssrf: ${skippedByReason.ssrf_blocked}`);
  if (skippedByReason.max_pages_cap > 0) skipParts.push(`max_pages_cap: ${skippedByReason.max_pages_cap}`);
  if (skippedByReason.template_cap > 0) skipParts.push(`template_cap: ${skippedByReason.template_cap}`);
  if (skippedByReason.auth_or_utility_route > 0) skipParts.push(`auth_or_utility_route: ${skippedByReason.auth_or_utility_route}`);
  const skipDetail = skipParts.length > 0 ? ` (${skipParts.join(', ')})` : '';
  const scopeSummary =
    `Scope: ${counts.audited} audited | ${counts.skipped} skipped${skipDetail} | ${counts.errored} errored` +
    (counts.redirectsResolved > 0 ? ` | ${counts.redirectsResolved} redirects resolved` : '');

  return {
    schemaVersion: 2,
    crawledAt: new Date().toISOString(),
    requestedUrl,
    finalUrl: finalHomeUrl,
    domain,
    mode: single ? 'single' : 'multi',
    status: overallStatus,
    downstreamStatus: 'observed',
    hardGate,
    coverageComplete,
    scopeSummary,
    counts,
    pages,
    skipped,
    errored,
    redirectsResolved,
    robotsTxt: robotsInfo,
    sitemap: sitemapResult,
    caching,
    throttle: aimd.getStats(),
    siteFindings,
    clusters,
    timingMs: Date.now() - crawlStartedAt,
  };
}
