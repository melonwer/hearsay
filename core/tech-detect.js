/**
 * Zero-dependency passive stack/CDN/WAF fingerprinting, Cloudflare Sept 2026 /
 * Content-Signal / AIPREF robots.txt analysis, caching validator plausibility
 * auditing, and non-throwing DNS OSINT hints.
 *
 * Pure Node 22 built-ins only (`node:dns/promises`).
 * Zero extra HTTP requests; strictly passive (never inspects or logs cookie
 * values, never sends active WAF attack probes, never spoofs User-Agents).
 */

import { resolveCname, resolveNs, resolveTxt } from 'node:dns/promises';
import { AI_CRAWLER_REGISTRY, TECH_SIGNATURES } from './tech-signatures.js';

/**
 * @typedef {import('./tech-signatures.js').AiCrawlerEntry} AiCrawlerEntry
 * @typedef {import('./tech-signatures.js').AiCrawlerCategory} AiCrawlerCategory
 * @typedef {import('./tech-signatures.js').PatternRule} PatternRule
 * @typedef {import('./tech-signatures.js').TechCategory} TechCategory
 * @typedef {import('./tech-signatures.js').TechSignature} TechSignature
 */

/**
 * @typedef {Headers | Record<string, string | string[] | undefined> | null | undefined} HeaderInput
 */

/**
 * @typedef {'none'|'edge_detected'|'bot_management_active'|'challenge_or_block_intercepted'} WafState
 */

/**
 * @typedef {Object} TechDetection
 * @property {string} id
 * @property {string} name
 * @property {TechCategory} category
 * @property {string|null} version
 * @property {number} confidence
 * @property {string[]} evidence
 * @property {boolean} implied
 */

/**
 * @typedef {Object} WafAssessment
 * @property {WafState} state
 * @property {string|null} vendor
 * @property {string[]} vendors
 * @property {string[]} evidence
 * @property {boolean} challengeDetected
 * @property {boolean} turnstileWidgetDetected
 * @property {boolean} hasAdTechScripts
 * @property {boolean} cloudflareSept2026Advisory
 */

/**
 * @typedef {Object} StackAndWafResult
 * @property {TechDetection[]} technologies
 * @property {TechDetection[]} frameworks
 * @property {TechDetection[]} cms
 * @property {TechDetection[]} cdns
 * @property {TechDetection[]} hosting
 * @property {TechDetection[]} servers
 * @property {TechDetection[]} wafProducts
 * @property {string|null} primaryFramework
 * @property {string|null} primaryCdn
 * @property {string|null} primaryHosting
 * @property {string|null} primaryCms
 * @property {string[]} cookieNames
 * @property {WafAssessment} waf
 * @property {number} visibleTextChars
 * @property {number} durationMs
 */

/**
 * @typedef {Object} DetectStackInput
 * @property {string} [url]
 * @property {number|null} [status]
 * @property {HeaderInput} [headers]
 * @property {string} [html]
 * @property {string|string[]|null} [setCookies]
 */

/**
 * @typedef {Object} RobotsBotEvaluation
 * @property {string} token
 * @property {string} vendor
 * @property {AiCrawlerCategory} category
 * @property {boolean} executesJs
 * @property {boolean|'unclear'} respectsRobots
 * @property {string|null} ipFeedUrl
 * @property {string|null} matchedGroup
 * @property {string|null} rule
 * @property {'allow'|'disallow'|null} directive
 * @property {string|null} pattern
 * @property {boolean} allowed
 * @property {'allowed'|'blocked'|'default_allowed'} status
 * @property {'cloudflare_managed'|'origin'|null} source
 */

/**
 * @typedef {Object} ManagedContradiction
 * @property {string} agent
 * @property {'access_rule'|'content_signal'} type
 * @property {string} managedDirective
 * @property {string} originDirective
 * @property {string} detail
 */

/**
 * @typedef {Object} ContentSignalConflict
 * @property {'search'|'ai-input'|'ai-train'} directive
 * @property {'yes'|'no'} robotsValue
 * @property {'yes'|'no'} headerValue
 * @property {string} detail
 */

/**
 * @typedef {Object} RobotsPolicyResult
 * @property {string} targetPath
 * @property {RobotsBotEvaluation[]} bots
 * @property {Record<string, RobotsBotEvaluation>} byToken
 * @property {string[]} sitemaps
 * @property {Record<string, number>} crawlDelays
 * @property {boolean} endsWithRulelessGroup
 * @property {string|null} trailingRulelessAgent
 * @property {{
 *   detected: boolean,
 *   startLine: number|null,
 *   endLine: number|null,
 *   managedAgents: string[],
 *   contentSignals: Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>,
 *   contradictions: ManagedContradiction[],
 * }} cloudflareManaged
 * @property {{
 *   robots: Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>,
 *   headers: Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>,
 *   contentUsageRaw: string|null,
 *   effective: Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>,
 *   conflicts: ContentSignalConflict[],
 *   suppressesAiInput: boolean,
 *   suppressesSearch: boolean,
 * }} contentSignals
 * @property {{
 *   detected: boolean,
 *   disallowed: boolean,
 *   matchedRule: string|null,
 *   trainingOnly: true,
 *   affectsSearchVisibility: false,
 * }} aiprefTrainingOptOut
 * @property {{
 *   totalChecked: number,
 *   allowedCount: number,
 *   blockedCount: number,
 *   searchRetrievalBlocked: string[],
 *   userFetchBlocked: string[],
 *   mixedSearchAiBlocked: string[],
 *   trainingBlocked: string[],
 *   policySignalsDisallowed: string[],
 * }} summary
 */

/**
 * @typedef {Object} CachingIssue
 * @property {string} id
 * @property {'critical'|'warning'|'info'} severity
 * @property {string} title
 * @property {string} detail
 */

/**
 * @typedef {Object} CachingAnalysisOptions
 * @property {boolean} [isMarkdownResponse]
 * @property {boolean} [isNextJsAppRouter]
 */

/**
 * @typedef {Object} CachingAnalysisResult
 * @property {{ present: boolean, raw: string|null, weak: boolean, valid: boolean }} etag
 * @property {{
 *   present: boolean,
 *   raw: string|null,
 *   iso: string|null,
 *   timestampMs: number|null,
 *   plausible: boolean,
 *   reason: 'missing'|'invalid'|'placeholder_pre_1995'|'stamps_now'|'future_clock_skew'|'plausible',
 * }} lastModified
 * @property {{ present: boolean, raw: string|null, iso: string|null, timestampMs: number|null }} dateHeader
 * @property {{
 *   present: boolean,
 *   raw: string|null,
 *   directives: string[],
 *   hasNoStore: boolean,
 *   hasPrivate: boolean,
 *   hasNoCache: boolean,
 *   maxAge: number|null,
 *   sMaxAge: number|null,
 * }} cacheControl
 * @property {{
 *   present: boolean,
 *   raw: string|null,
 *   tokens: string[],
 *   hasUserAgent: boolean,
 *   hasAccept: boolean,
 *   hasRsc: boolean,
 *   hasGeoHeader: boolean,
 * }} vary
 * @property {boolean} conditionalGetReady
 * @property {CachingIssue[]} issues
 */

/**
 * @typedef {Object} DnsResolverLike
 * @property {(hostname: string) => Promise<string[]>} [resolveCname]
 * @property {(hostname: string) => Promise<string[]>} [resolveNs]
 * @property {(hostname: string) => Promise<string[][]>} [resolveTxt]
 */

/**
 * @typedef {Object} DnsProbeOptions
 * @property {DnsResolverLike} [resolver]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {Object} DnsHintsResult
 * @property {string} hostname
 * @property {string[]} cname
 * @property {string[]} ns
 * @property {string[]} txt
 * @property {{
 *   google: boolean,
 *   bing: boolean,
 *   apple: boolean,
 *   openai: boolean,
 *   other: string[],
 * }} verificationTokens
 * @property {string[]} inferredEdge
 * @property {string[]} errors
 * @property {boolean} timedOut
 */

const MAX_SCAN_HTML_CHARS = 2 * 1024 * 1024;
const EVIDENCE_MAX_LEN = 80;
const CHALLENGE_VISIBLE_TEXT_THRESHOLD = 1000;
const LASTMOD_MIN_MS = Date.UTC(1995, 0, 1); // 788_918_400_000
const LASTMOD_NOW_TOLERANCE_MS = 60 * 1000;
const LASTMOD_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DNS_TIMEOUT_MS = 3000;

const VALID_COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SET_COOKIE_SPLIT_RE = /,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/;

const AD_TECH_SCRIPT_NEEDLES = Object.freeze([
  'googlesyndication.com',
  'doubleclick.net',
  'adservice.google.com',
  'amazon-adsystem.com',
  'mediavine.com',
  'adthrive.com',
  'ezoic.net',
]);

const GEO_VARY_HEADERS = new Set([
  'cf-ipcountry',
  'cloudfront-viewer-country',
  'cloudfront-viewer-country-region',
  'x-country-code',
  'fastly-geo',
  'x-geo-country',
  'x-vercel-ip-country',
]);

const FRAMEWORK_PRIORITY = Object.freeze([
  'nextjs-app-router',
  'nextjs-pages-router',
  'vite-spa',
  'nuxt',
  'astro',
  'sveltekit',
  'remix',
  'gatsby',
  'docusaurus',
  'hugo',
  'create-react-app',
  'qwik',
  'solidstart',
  'angular',
  'ember',
  'nextjs',
  'htmx',
  'alpinejs',
  'react',
  'vue',
  'svelte',
  'vite',
]);

const CHALLENGE_STATUSES = new Set([200, 202, 403, 406, 429, 503]);

/**
 * Truncate evidence strings to at most 80 chars.
 * @param {string} text
 * @returns {string}
 */
function truncateEvidence(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= EVIDENCE_MAX_LEN) return clean;
  return `${clean.slice(0, EVIDENCE_MAX_LEN - 3)}...`;
}

/**
 * Normalize headers (Headers instance or plain object) into a lowercase Map.
 * Intentionally excludes `set-cookie` values so cookie values are never stored
 * in the normalized header map.
 *
 * @param {HeaderInput} headers
 * @returns {Map<string, string>}
 */
function normalizeHeaders(headers) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!headers || typeof headers !== 'object') return map;

  const maybeHeaders = /** @type {{ forEach?: unknown, get?: unknown }} */ (headers);
  if (typeof maybeHeaders.forEach === 'function' && typeof maybeHeaders.get === 'function') {
    /** @type {Headers} */ (headers).forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'set-cookie') return;
      map.set(lower, value);
    });
    return map;
  }

  for (const [key, value] of Object.entries(/** @type {Record<string, string | string[] | undefined>} */ (headers))) {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie' || value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      map.set(lower, value.join(', '));
    } else {
      map.set(lower, String(value));
    }
  }
  return map;
}

/**
 * Parse cookie NAME only from a single raw Set-Cookie header string.
 * Cookie values and attributes are immediately discarded and never returned.
 *
 * @param {string} rawSetCookie
 * @returns {string|null}
 */
function parseSingleCookieName(rawSetCookie) {
  const trimmed = rawSetCookie.trim();
  if (!trimmed) return null;
  const semiIdx = trimmed.indexOf(';');
  const firstSegment = semiIdx >= 0 ? trimmed.slice(0, semiIdx) : trimmed;
  const eqIdx = firstSegment.indexOf('=');
  if (eqIdx <= 0) return null;
  const name = firstSegment.slice(0, eqIdx).trim();
  if (!name || !VALID_COOKIE_NAME_RE.test(name)) return null;
  return name;
}

/**
 * Safely extract unique Set-Cookie **names only** (never values).
 *
 * Uses `headers.getSetCookie()` on Node 22 Fetch `Headers` instances so
 * `Expires=Wed, 21 Oct ...` commas never corrupt parsing, and also safely
 * handles plain header objects or explicit `setCookies` strings/arrays.
 *
 * @param {HeaderInput} headers
 * @param {string|string[]|null} [setCookies]
 * @returns {string[]}
 */
export function extractCookieNames(headers, setCookies = null) {
  /** @type {string[]} */
  const rawEntries = [];

  if (headers && typeof headers === 'object') {
    const maybeHeaders = /** @type {{ getSetCookie?: unknown, get?: unknown }} */ (headers);
    if (typeof maybeHeaders.getSetCookie === 'function') {
      const list = /** @type {() => string[]} */ (maybeHeaders.getSetCookie).call(headers);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string') rawEntries.push(item);
        }
      }
    } else if (typeof maybeHeaders.get === 'function') {
      const joined = /** @type {(name: string) => string | null} */ (maybeHeaders.get).call(headers, 'set-cookie');
      if (typeof joined === 'string' && joined.trim()) {
        for (const part of joined.split(SET_COOKIE_SPLIT_RE)) {
          rawEntries.push(part);
        }
      }
    } else {
      for (const [key, value] of Object.entries(/** @type {Record<string, string | string[] | undefined>} */ (headers))) {
        if (key.toLowerCase() !== 'set-cookie' || value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') rawEntries.push(item);
          }
        } else if (typeof value === 'string') {
          for (const part of value.split(SET_COOKIE_SPLIT_RE)) {
            rawEntries.push(part);
          }
        }
      }
    }
  }

  if (typeof setCookies === 'string' && setCookies.trim()) {
    for (const part of setCookies.split(SET_COOKIE_SPLIT_RE)) {
      rawEntries.push(part);
    }
  } else if (Array.isArray(setCookies)) {
    for (const item of setCookies) {
      if (typeof item === 'string') rawEntries.push(item);
    }
  }

  /** @type {Set<string>} */
  const uniqueNames = new Set();
  for (const raw of rawEntries) {
    const name = parseSingleCookieName(raw);
    if (name) uniqueNames.add(name);
  }
  return [...uniqueNames];
}

/**
 * Find the closing `>` of a tag starting at `start` (respecting quotes).
 * @param {string} html
 * @param {number} start
 * @returns {number}
 */
function findTagEnd(html, start) {
  let quote = '';
  const limit = html.length;
  for (let i = start + 1; i < limit; i++) {
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
 * Extract an attribute value from a single tag slice (case-insensitive attr name).
 * @param {string} tag
 * @param {string} attrName
 * @returns {string|null}
 */
function readTagAttr(tag, attrName) {
  const lower = tag.toLowerCase();
  const len = lower.length;
  let i = 1;
  // Skip tag name
  while (i < len && !/[\s/>]/.test(lower[i])) i++;

  while (i < len) {
    while (i < len && /[\s/]/.test(lower[i])) i++;
    if (i >= len || lower[i] === '>') break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(lower[i])) i++;
    const name = lower.slice(nameStart, i);
    while (i < len && /\s/.test(lower[i])) i++;
    let value = '';
    if (i < len && lower[i] === '=') {
      i++;
      while (i < len && /\s/.test(lower[i])) i++;
      if (i < len && (tag[i] === '"' || tag[i] === "'")) {
        const q = tag[i++];
        const valStart = i;
        while (i < len && tag[i] !== q) i++;
        value = tag.slice(valStart, i);
        if (i < len && tag[i] === q) i++;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(tag[i])) i++;
        value = tag.slice(valStart, i);
      }
    }
    if (name === attrName) return value;
  }
  return null;
}

/**
 * Find the end index (past `>`) of a raw container's closing tag (`script`, `style`, `noscript`, `svg`, `template`, `head`).
 * @param {string} lowerHtml
 * @param {string} tagName
 * @param {number} fromPos
 * @returns {number}
 */
function skipRawElement(lowerHtml, tagName, fromPos) {
  const needle = `</${tagName}`;
  let search = fromPos;
  while (search < lowerHtml.length) {
    const idx = lowerHtml.indexOf(needle, search);
    if (idx === -1) return lowerHtml.length;
    const after = lowerHtml[idx + needle.length];
    if (after === '>' || after === undefined || /[\s/]/.test(after)) {
      const gt = lowerHtml.indexOf('>', idx + needle.length);
      return gt === -1 ? lowerHtml.length : gt + 1;
    }
    search = idx + needle.length;
  }
  return lowerHtml.length;
}

/**
 * Single-pass linear HTML scan that extracts `<meta>` entries, `<script src>` /
 * `<link href>` URLs, ad-tech script presence, and visible body text character count.
 *
 * @param {string} html
 * @param {string} htmlLower
 * @returns {{
 *   meta: Map<string, string[]>,
 *   scriptUrls: string[],
 *   scriptUrlsLower: string[],
 *   visibleTextChars: number,
 *   hasAdTechScripts: boolean,
 * }}
 */
function scanHtmlPassive(html, htmlLower) {
  /** @type {Map<string, string[]>} */
  const meta = new Map();
  /** @type {string[]} */
  const scriptUrls = [];
  /** @type {string[]} */
  const scriptUrlsLower = [];
  let visibleTextChars = 0;
  let hasAdTechScripts = false;

  const limit = Math.min(html.length, MAX_SCAN_HTML_CHARS);
  let inHead = false;
  let i = 0;

  while (i < limit) {
    const lt = html.indexOf('<', i);
    const textEnd = lt === -1 || lt > limit ? limit : lt;

    if (!inHead && textEnd > i) {
      let prevSpace = true;
      for (let p = i; p < textEnd; p++) {
        const code = html.charCodeAt(p);
        const isWs = code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
        if (isWs) {
          if (!prevSpace) {
            visibleTextChars++;
            prevSpace = true;
          }
        } else {
          visibleTextChars++;
          prevSpace = false;
        }
      }
    }

    if (lt === -1 || lt >= limit) break;

    if (htmlLower.startsWith('<!--', lt)) {
      const closeComment = html.indexOf('-->', lt + 4);
      i = closeComment === -1 ? limit : closeComment + 3;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt === -1 || gt >= limit) break;

    const rawTag = html.slice(lt, gt + 1);
    const lowerTag = htmlLower.slice(lt, gt + 1);
    const isClosing = lowerTag[1] === '/';

    let nameStart = isClosing ? 2 : 1;
    while (nameStart < lowerTag.length && /\s/.test(lowerTag[nameStart])) nameStart++;
    let nameEnd = nameStart;
    while (nameEnd < lowerTag.length && /[a-z0-9:-]/.test(lowerTag[nameEnd])) nameEnd++;
    const tagName = lowerTag.slice(nameStart, nameEnd);

    if (tagName === 'head') {
      inHead = !isClosing;
      i = gt + 1;
      continue;
    }

    if (!isClosing && tagName === 'meta') {
      const mName = readTagAttr(rawTag, 'name') ?? readTagAttr(rawTag, 'property');
      const mContent = readTagAttr(rawTag, 'content');
      if (mName && mContent !== null) {
        const key = mName.trim().toLowerCase();
        const existing = meta.get(key);
        if (existing) existing.push(mContent.trim());
        else meta.set(key, [mContent.trim()]);
      }
      i = gt + 1;
      continue;
    }

    if (!isClosing && tagName === 'link') {
      const href = readTagAttr(rawTag, 'href');
      if (href && href.trim()) {
        const clean = href.trim();
        scriptUrls.push(clean);
        scriptUrlsLower.push(clean.toLowerCase());
      }
      i = gt + 1;
      continue;
    }

    if (!isClosing && tagName === 'script') {
      const src = readTagAttr(rawTag, 'src');
      if (src && src.trim()) {
        const clean = src.trim();
        const cleanLower = clean.toLowerCase();
        scriptUrls.push(clean);
        scriptUrlsLower.push(cleanLower);
        if (!hasAdTechScripts && AD_TECH_SCRIPT_NEEDLES.some((needle) => cleanLower.includes(needle))) {
          hasAdTechScripts = true;
        }
      }
      const selfClosing = rawTag.endsWith('/>');
      i = selfClosing ? gt + 1 : skipRawElement(htmlLower, 'script', gt + 1);
      continue;
    }

    if (!isClosing && (tagName === 'style' || tagName === 'noscript' || tagName === 'svg' || tagName === 'template')) {
      const selfClosing = rawTag.endsWith('/>');
      i = selfClosing ? gt + 1 : skipRawElement(htmlLower, tagName, gt + 1);
      continue;
    }

    i = gt + 1;
  }

  return { meta, scriptUrls, scriptUrlsLower, visibleTextChars, hasAdTechScripts };
}

/**
 * Evaluate a single literal-prefiltered PatternRule against a target string.
 * @param {PatternRule} rule
 * @param {string} target
 * @param {string} targetLower
 * @returns {{ matched: boolean, version: string|null, snippet: string|null }}
 */
function testPattern(rule, target, targetLower) {
  if (rule.literal && !targetLower.includes(rule.literal)) {
    return { matched: false, version: null, snippet: null };
  }
  if (!rule.regex) {
    return { matched: true, version: null, snippet: rule.literal ?? null };
  }
  const match = rule.regex.exec(target);
  if (!match) return { matched: false, version: null, snippet: null };
  const version = typeof match[1] === 'string' && match[1].trim() ? match[1].trim() : null;
  return { matched: true, version, snippet: match[0] };
}

/**
 * Evaluate a signature's cookie rules strictly against extracted cookie NAMES.
 * @param {import('./tech-signatures.js').CookieNameRule} rule
 * @param {string[]} cookieNames
 * @returns {string|null}
 */
function matchCookieRule(rule, cookieNames) {
  for (const name of cookieNames) {
    const lower = name.toLowerCase();
    if (rule.exact && lower === rule.exact) return name;
    if (rule.prefix && lower.startsWith(rule.prefix)) return name;
    if (rule.regex && rule.regex.test(name)) return name;
  }
  return null;
}

/**
 * Classify WAF/edge state into one of the 3 active tiers (`edge_detected`,
 * `bot_management_active`, `challenge_or_block_intercepted`) or `'none'`.
 *
 * Explicitly excludes embedded Cloudflare Turnstile (`cf-chl-` /
 * `challenges.cloudflare.com/turnstile`) widgets on normal pages
 * (`visibleTextChars >= 1000`) from triggering false challenge alerts.
 *
 * @param {{
 *   status: number|null,
 *   headerMap: Map<string, string>,
 *   cookieNames: string[],
 *   html: string,
 *   htmlLower: string,
 *   visibleTextChars: number,
 *   hasAdTechScripts: boolean,
 *   matchedIds: Set<string>,
 * }} ctx
 * @returns {WafAssessment}
 */
function classifyWafState(ctx) {
  const { status, headerMap, cookieNames, html, htmlLower, visibleTextChars, hasAdTechScripts, matchedIds } = ctx;
  const cookieNamesLower = cookieNames.map((n) => n.toLowerCase());

  const turnstileWidgetDetected =
    htmlLower.includes('challenges.cloudflare.com/turnstile') ||
    htmlLower.includes('cf-turnstile') ||
    /\bcf-chl-/i.test(html);

  /** @type {Set<string>} */
  const challengeVendors = new Set();
  /** @type {string[]} */
  const challengeEvidence = [];

  // 1. Definitive HTTP mitigation headers (always authoritative regardless of body length)
  const cfMitigated = headerMap.get('cf-mitigated') ?? '';
  if (cfMitigated.toLowerCase().includes('challenge')) {
    challengeVendors.add('cloudflare');
    challengeEvidence.push(truncateEvidence(`header: cf-mitigated: ${cfMitigated}`));
  }

  const vercelMitigated = headerMap.get('x-vercel-mitigated') ?? '';
  if (vercelMitigated.toLowerCase().includes('challenge')) {
    challengeVendors.add('vercel');
    challengeEvidence.push(truncateEvidence(`header: x-vercel-mitigated: ${vercelMitigated}`));
  }

  const awsWafAction = headerMap.get('x-amzn-waf-action') ?? '';
  if (/^(?:captcha|challenge)$/i.test(awsWafAction.trim())) {
    challengeVendors.add('aws-waf');
    challengeEvidence.push(truncateEvidence(`header: x-amzn-waf-action: ${awsWafAction}`));
  }

  const blockedByWaf = headerMap.get('x-blocked-by-waf');
  if (blockedByWaf !== undefined && (status === 403 || status === 429 || status === 503)) {
    challengeVendors.add('aws-waf');
    challengeEvidence.push('header: x-blocked-by-waf');
  }

  const xDatadome = headerMap.get('x-datadome') ?? '';
  if (
    xDatadome.toLowerCase().includes('protected') &&
    (status === 403 || status === 429 || status === 202 || status === 503)
  ) {
    challengeVendors.add('datadome');
    challengeEvidence.push(truncateEvidence(`header: x-datadome: ${xDatadome}`));
  }

  // 2. Passive HTML interstitial detection (ONLY when visibleTextChars < 1000
  //    and HTTP status is a plausible block/challenge status — protects normal
  //    pages with embedded Turnstile `cf-chl-` widgets from false positives!)
  const eligibleInterstitialStatus = status === null || CHALLENGE_STATUSES.has(status);
  if (eligibleInterstitialStatus && visibleTextChars < CHALLENGE_VISIBLE_TEXT_THRESHOLD) {
    // Cloudflare challenge / block interstitial (intentionally excludes bare cf-chl- / Turnstile)
    if (
      htmlLower.includes('/cdn-cgi/challenge-platform/') ||
      htmlLower.includes('window._cf_chl_opt') ||
      /<title>\s*just a moment\.\.\.\s*<\/title>/i.test(html) ||
      /attention required!\s*\|\s*cloudflare/i.test(html) ||
      htmlLower.includes('id="cf-error-details"') ||
      htmlLower.includes("id='cf-error-details'")
    ) {
      challengeVendors.add('cloudflare');
      challengeEvidence.push('html: cloudflare challenge/block interstitial');
    }

    // Vercel Security Checkpoint
    if (
      /<title>\s*vercel security checkpoint\s*<\/title>/i.test(html) ||
      htmlLower.includes('/.well-known/vercel/security/request-challenge')
    ) {
      challengeVendors.add('vercel');
      challengeEvidence.push('html: Vercel Security Checkpoint');
    }

    // Akamai Access Denied
    if (
      status === 403 &&
      htmlLower.includes('access denied') &&
      (htmlLower.includes('errors.edgesuite.net') || /reference(?:&#32;|\s)#[\da-f.]{4,40}/i.test(html))
    ) {
      challengeVendors.add('akamai');
      challengeEvidence.push('html: Akamai Access Denied (Reference #)');
    }

    // AWS WAF / CloudFront block
    if (
      htmlLower.includes('captcha.awswaf.com/') ||
      htmlLower.includes('awswafcookiedomainlist') ||
      (status === 403 && htmlLower.includes('generated by cloudfront') && htmlLower.includes('request blocked'))
    ) {
      challengeVendors.add('aws-waf');
      challengeEvidence.push('html: AWS WAF / CloudFront challenge or block');
    }

    // DataDome interstitial
    if (
      htmlLower.includes('captcha-delivery.com') ||
      (htmlLower.includes('ct.datadome.co/') && (status === 403 || status === 429 || status === 202))
    ) {
      challengeVendors.add('datadome');
      challengeEvidence.push('html: DataDome captcha-delivery interstitial');
    }

    // Imperva / Incapsula interstitial
    if (
      htmlLower.includes('/_incapsula_resource') ||
      htmlLower.includes('incapsula incident id') ||
      htmlLower.includes('request unsuccessful. incapsula')
    ) {
      challengeVendors.add('imperva-incapsula');
      challengeEvidence.push('html: Imperva/Incapsula interstitial');
    }

    // HUMAN / PerimeterX block
    if (
      /perimeterx\.(?:com|net)\/whywasiblocked/i.test(html) ||
      htmlLower.includes('denied because we believe you are using automation tools')
    ) {
      challengeVendors.add('human-perimeterx');
      challengeEvidence.push('html: HUMAN/PerimeterX challenge or block');
    }

    // Anubis PoW gate (often returns HTTP 200 or 202)
    if (
      htmlLower.includes('anubis_challenge') ||
      htmlLower.includes('/.within.website/x/cmd/anubis/') ||
      (htmlLower.includes('anubis') && htmlLower.includes('techaro'))
    ) {
      challengeVendors.add('anubis-pow');
      challengeEvidence.push('html: Anubis Proof-of-Work challenge');
    }

    // Wordfence block
    if (
      htmlLower.includes('generated by wordfence') ||
      (htmlLower.includes('wordfence') && htmlLower.includes('access to this site has been limited'))
    ) {
      challengeVendors.add('wordfence');
      challengeEvidence.push('html: Wordfence block page');
    }

    // Fastly block
    if (
      (status === 403 || status === 406 || status === 429) &&
      (headerMap.has('x-fastly-request-id') || htmlLower.includes('fastly error:'))
    ) {
      challengeVendors.add('fastly');
      challengeEvidence.push(`status ${status} with Fastly edge header/body`);
    }
  }

  const hasCloudflare = matchedIds.has('cloudflare') || headerMap.has('cf-ray');
  const hasCfBmCookie = cookieNamesLower.includes('__cf_bm') || cookieNamesLower.includes('cf_clearance');
  const cloudflareSept2026Advisory = hasCloudflare && (hasCfBmCookie || hasAdTechScripts || challengeVendors.has('cloudflare'));

  if (challengeVendors.size > 0) {
    const vendors = [...challengeVendors];
    return {
      state: 'challenge_or_block_intercepted',
      vendor: vendors[0] ?? null,
      vendors,
      evidence: challengeEvidence,
      challengeDetected: true,
      turnstileWidgetDetected,
      hasAdTechScripts,
      cloudflareSept2026Advisory,
    };
  }

  // 3. Tier 2: Bot Management Active (telemetry cookies or passive bot-management headers on non-blocked response)
  /** @type {Set<string>} */
  const botMgmtVendors = new Set();
  /** @type {string[]} */
  const botMgmtEvidence = [];

  /**
   * @param {string} vendor
   * @param {string} cookieName
   */
  const recordBotCookie = (vendor, cookieName) => {
    botMgmtVendors.add(vendor);
    botMgmtEvidence.push(`cookie: ${cookieName}`);
  };

  for (const name of cookieNames) {
    const lower = name.toLowerCase();
    if (lower === '__cf_bm' || lower === 'cf_clearance') recordBotCookie('cloudflare-bot-management', name);
    else if (lower === '_abck' || lower === 'ak_bmsc' || lower === 'bm_sv' || lower === 'bm_sz') {
      recordBotCookie('akamai-bot-manager', name);
    } else if (lower === 'reese84' || lower.startsWith('incap_ses_') || lower.startsWith('visid_incap_')) {
      recordBotCookie('imperva-incapsula', name);
    } else if (lower === 'datadome' || /^datadome-_zld[pt]$/.test(lower)) {
      recordBotCookie('datadome', name);
    } else if (lower === 'aws-waf-token') {
      recordBotCookie('aws-waf', name);
    } else if (lower === '_px3' || lower === '_pxhd' || lower === '_pxvid' || lower === '_px2') {
      recordBotCookie('human-perimeterx', name);
    } else if (lower.endsWith('-anubis-auth')) {
      recordBotCookie('anubis-pow', name);
    } else if (lower.startsWith('wfvt_') || lower.startsWith('wordfence_verifiedhuman')) {
      recordBotCookie('wordfence', name);
    }
  }

  if (headerMap.has('x-datadome') || headerMap.has('x-datadome-cid')) {
    botMgmtVendors.add('datadome');
    botMgmtEvidence.push('header: x-datadome');
  }
  if (headerMap.has('x-iinfo')) {
    botMgmtVendors.add('imperva-incapsula');
    botMgmtEvidence.push('header: x-iinfo');
  }
  if (headerMap.has('x-sigsci-tags') || headerMap.has('x-sigsci-requestid')) {
    botMgmtVendors.add('fastly-next-gen-waf');
    botMgmtEvidence.push('header: x-sigsci-*');
  }

  if (botMgmtVendors.size > 0) {
    const vendors = [...botMgmtVendors];
    return {
      state: 'bot_management_active',
      vendor: vendors[0] ?? null,
      vendors,
      evidence: botMgmtEvidence,
      challengeDetected: false,
      turnstileWidgetDetected,
      hasAdTechScripts,
      cloudflareSept2026Advisory,
    };
  }

  // 4. Tier 1: Edge / CDN Detected (benign 200 OK with CDN/edge headers only)
  /** @type {Set<string>} */
  const edgeVendors = new Set();
  /** @type {string[]} */
  const edgeEvidence = [];
  const edgeIds = ['cloudflare', 'vercel', 'netlify', 'fastly', 'akamai', 'aws-cloudfront', 'bunnycdn', 'azure-front-door', 'fly-io', 'render'];
  for (const id of edgeIds) {
    if (matchedIds.has(id)) {
      edgeVendors.add(id);
      edgeEvidence.push(`edge: ${id}`);
    }
  }

  if (edgeVendors.size > 0) {
    const vendors = [...edgeVendors];
    return {
      state: 'edge_detected',
      vendor: vendors[0] ?? null,
      vendors,
      evidence: edgeEvidence,
      challengeDetected: false,
      turnstileWidgetDetected,
      hasAdTechScripts,
      cloudflareSept2026Advisory,
    };
  }

  return {
    state: 'none',
    vendor: null,
    vendors: [],
    evidence: [],
    challengeDetected: false,
    turnstileWidgetDetected,
    hasAdTechScripts,
    cloudflareSept2026Advisory: false,
  };
}

/**
 * Passively detect frameworks, CMS, CDNs/hosting, web servers, and 3-tier WAF
 * states from an already-fetched HTTP response.
 *
 * Runs with 0 extra HTTP requests in <2ms CPU and NEVER inspects or logs
 * Set-Cookie values.
 *
 * @param {DetectStackInput} input
 * @returns {StackAndWafResult}
 */
export function detectStackAndWaf(input = {}) {
  const startedAt = performance.now();
  const status = typeof input.status === 'number' && Number.isFinite(input.status) ? input.status : null;
  const html = typeof input.html === 'string' ? input.html : '';
  const htmlSlice = html.length > MAX_SCAN_HTML_CHARS ? html.slice(0, MAX_SCAN_HTML_CHARS) : html;
  const htmlLower = htmlSlice.toLowerCase();

  const headerMap = normalizeHeaders(input.headers);
  const cookieNames = extractCookieNames(input.headers, input.setCookies ?? null);
  const scanned = scanHtmlPassive(htmlSlice, htmlLower);

  /** @type {Map<string, TechSignature>} */
  const signatureById = new Map();
  for (const sig of TECH_SIGNATURES) {
    signatureById.set(sig.id, sig);
  }

  /** @type {Map<string, TechDetection>} */
  const matches = new Map();

  for (const sig of TECH_SIGNATURES) {
    // Disambiguation: skip if any absentHtml marker is present
    if (sig.absentHtml && sig.absentHtml.some((needle) => htmlLower.includes(needle))) {
      continue;
    }

    /** @type {string[]} */
    const evidence = [];
    let maxConfidence = 0;
    /** @type {string|null} */
    let version = null;

    // 1. Headers
    if (sig.headers) {
      for (const [hdrKey, pattern] of Object.entries(sig.headers)) {
        const hdrVal = headerMap.get(hdrKey);
        if (hdrVal === undefined) continue;
        if (pattern === null) {
          evidence.push(truncateEvidence(`header: ${hdrKey}`));
          maxConfidence = Math.max(maxConfidence, 100);
        } else {
          const res = testPattern(pattern, hdrVal, hdrVal.toLowerCase());
          if (res.matched) {
            evidence.push(truncateEvidence(`header: ${hdrKey}: ${hdrVal}`));
            maxConfidence = Math.max(maxConfidence, pattern.confidence ?? 100);
            if (!version && res.version) version = res.version;
          }
        }
      }
    }

    // 2. Cookies (NAMES ONLY — values are never read or logged)
    if (sig.cookies && cookieNames.length > 0) {
      for (const cookieRule of sig.cookies) {
        const matchedName = matchCookieRule(cookieRule, cookieNames);
        if (matchedName) {
          evidence.push(truncateEvidence(`cookie: ${matchedName}`));
          maxConfidence = Math.max(maxConfidence, cookieRule.confidence ?? 100);
        }
      }
    }

    // 3. Meta tags
    if (sig.meta && scanned.meta.size > 0) {
      for (const [metaKey, pattern] of Object.entries(sig.meta)) {
        const values = scanned.meta.get(metaKey);
        if (!values) continue;
        for (const val of values) {
          const res = testPattern(pattern, val, val.toLowerCase());
          if (res.matched) {
            evidence.push(truncateEvidence(`meta[${metaKey}]: ${val}`));
            maxConfidence = Math.max(maxConfidence, pattern.confidence ?? 100);
            if (!version && res.version) version = res.version;
            break;
          }
        }
      }
    }

    // 4. Script & link URLs
    if (sig.scripts && scanned.scriptUrls.length > 0) {
      for (const pattern of sig.scripts) {
        for (let idx = 0; idx < scanned.scriptUrls.length; idx++) {
          const res = testPattern(pattern, scanned.scriptUrls[idx], scanned.scriptUrlsLower[idx]);
          if (res.matched) {
            evidence.push(truncateEvidence(`asset: ${scanned.scriptUrls[idx]}`));
            maxConfidence = Math.max(maxConfidence, pattern.confidence ?? 90);
            if (!version && res.version) version = res.version;
            break;
          }
        }
      }
    }

    // 5. Raw HTML (literal pre-filtered)
    if (sig.html && htmlSlice.length > 0) {
      for (const pattern of sig.html) {
        const res = testPattern(pattern, htmlSlice, htmlLower);
        if (res.matched) {
          evidence.push(truncateEvidence(`html: ${res.snippet ?? pattern.literal ?? sig.id}`));
          maxConfidence = Math.max(maxConfidence, pattern.confidence ?? 90);
          if (!version && res.version) version = res.version;
        }
      }
    }

    // 6. Multi-signal Combos (all sub-patterns must match)
    if (sig.combos && htmlSlice.length > 0) {
      for (const combo of sig.combos) {
        let allMatched = true;
        /** @type {string[]} */
        const comboEvidence = [];

        if (combo.scripts) {
          for (const sPat of combo.scripts) {
            let found = false;
            for (let idx = 0; idx < scanned.scriptUrls.length; idx++) {
              const res = testPattern(sPat, scanned.scriptUrls[idx], scanned.scriptUrlsLower[idx]);
              if (res.matched) {
                found = true;
                comboEvidence.push(truncateEvidence(`asset: ${scanned.scriptUrls[idx]}`));
                break;
              }
            }
            if (!found) {
              allMatched = false;
              break;
            }
          }
        }

        if (allMatched && combo.html) {
          for (const hPat of combo.html) {
            const res = testPattern(hPat, htmlSlice, htmlLower);
            if (!res.matched) {
              allMatched = false;
              break;
            }
            comboEvidence.push(truncateEvidence(`html: ${res.snippet ?? hPat.literal ?? sig.id}`));
          }
        }

        if (allMatched && comboEvidence.length > 0) {
          evidence.push(...comboEvidence);
          maxConfidence = Math.max(maxConfidence, combo.confidence ?? 95);
        }
      }
    }

    if (evidence.length > 0) {
      matches.set(sig.id, {
        id: sig.id,
        name: sig.name,
        category: sig.category,
        version,
        confidence: maxConfidence,
        evidence: [...new Set(evidence)].slice(0, 6),
        implied: false,
      });
    }
  }

  // Transitive `implies` resolution with cycle guard
  /** @type {string[]} */
  const queue = [...matches.keys()];
  /** @type {Set<string>} */
  const expanded = new Set();

  while (queue.length > 0) {
    const currentId = /** @type {string} */ (queue.shift());
    if (expanded.has(currentId)) continue;
    expanded.add(currentId);

    const currentSig = signatureById.get(currentId);
    if (!currentSig?.implies) continue;

    for (const impliedId of currentSig.implies) {
      if (matches.has(impliedId)) continue;
      const impliedSig = signatureById.get(impliedId);
      if (!impliedSig) continue;
      matches.set(impliedId, {
        id: impliedSig.id,
        name: impliedSig.name,
        category: impliedSig.category,
        version: null,
        confidence: 80,
        evidence: [`implied by: ${currentId}`],
        implied: true,
      });
      queue.push(impliedId);
    }
  }

  const technologies = [...matches.values()].sort(
    (a, b) => Number(a.implied) - Number(b.implied) || b.confidence - a.confidence || a.id.localeCompare(b.id),
  );

  const frameworks = technologies.filter((t) => t.category === 'framework');
  const cms = technologies.filter((t) => t.category === 'cms');
  const cdns = technologies.filter((t) => t.category === 'cdn');
  const hosting = technologies.filter((t) => t.category === 'hosting');
  const servers = technologies.filter((t) => t.category === 'server');
  const wafProducts = technologies.filter((t) => t.category === 'waf');

  const matchedIds = new Set(matches.keys());

  let primaryFramework = /** @type {string|null} */ (null);
  for (const id of FRAMEWORK_PRIORITY) {
    if (matchedIds.has(id)) {
      primaryFramework = id;
      break;
    }
  }
  if (!primaryFramework && frameworks.length > 0) {
    primaryFramework = frameworks[0].id;
  }

  const primaryCdn = cdns[0]?.id ?? null;
  const primaryHosting = hosting[0]?.id ?? null;
  const primaryCms = cms[0]?.id ?? null;

  const waf = classifyWafState({
    status,
    headerMap,
    cookieNames,
    html: htmlSlice,
    htmlLower,
    visibleTextChars: scanned.visibleTextChars,
    hasAdTechScripts: scanned.hasAdTechScripts,
    matchedIds,
  });

  const durationMs = Number((performance.now() - startedAt).toFixed(3));

  return {
    technologies,
    frameworks,
    cms,
    cdns,
    hosting,
    servers,
    wafProducts,
    primaryFramework,
    primaryCdn,
    primaryHosting,
    primaryCms,
    cookieNames,
    waf,
    visibleTextChars: scanned.visibleTextChars,
    durationMs,
  };
}

// ===========================================================================
// RFC 9309 ROBOTS.TXT + CLOUDFLARE MANAGED CONTENT + CONTENT-SIGNAL / AIPREF
// ===========================================================================

/**
 * Normalize percent-encoding hex case per RFC 9309 §2.2.2.
 * @param {string} value
 * @returns {string}
 */
function normalizeRobotsEscapes(value) {
  return value.replace(/%[0-9a-fA-F]{2}/g, (seq) => seq.toUpperCase());
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
 * Normalize target path input for RFC 9309 matching.
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
 * Test whether an RFC 9309 path pattern matches a normalized target path.
 * Supports `*` wildcards and trailing `$` anchor.
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
 * Parse a `Content-Signal` directive value (`search=yes, ai-input=no, ai-train=no`)
 * or IETF AIPREF `Content-Usage` header (`train-ai=n, search=y`).
 *
 * @param {string} raw
 * @returns {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>}
 */
function parseContentSignalValue(raw) {
  /** @type {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} */
  const parsed = {};
  if (!raw || typeof raw !== 'string') return parsed;

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Strip optional structured-field parameters after `;`
    const semiIdx = trimmed.indexOf(';');
    const pair = (semiIdx >= 0 ? trimmed.slice(0, semiIdx) : trimmed).trim();
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;

    const rawKey = pair.slice(0, eqIdx).trim().toLowerCase();
    const rawVal = pair.slice(eqIdx + 1).trim().toLowerCase();

    /** @type {'yes'|'no'|null} */
    let normalizedVal = null;
    if (rawVal === 'yes' || rawVal === 'y' || rawVal === 'true' || rawVal === '1') {
      normalizedVal = 'yes';
    } else if (rawVal === 'no' || rawVal === 'n' || rawVal === 'false' || rawVal === '0') {
      normalizedVal = 'no';
    }
    if (!normalizedVal) continue;

    if (rawKey === 'search') parsed.search = normalizedVal;
    else if (rawKey === 'ai-input' || rawKey === 'ai_input') parsed['ai-input'] = normalizedVal;
    else if (rawKey === 'ai-train' || rawKey === 'ai_train' || rawKey === 'train-ai' || rawKey === 'train_ai') {
      parsed['ai-train'] = normalizedVal;
    }
  }
  return parsed;
}

/**
 * @typedef {Object} ParsedRobotsRule
 * @property {'allow'|'disallow'} type
 * @property {string} pattern
 * @property {string} raw
 * @property {'cloudflare_managed'|'origin'} source
 */

/**
 * @typedef {Object} ParsedRobotsGroup
 * @property {string[]} agents
 * @property {ParsedRobotsRule[]} rules
 * @property {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} contentSignals
 * @property {number|null} crawlDelay
 * @property {'cloudflare_managed'|'origin'} source
 * @property {boolean} hasAnyDirective
 */

/**
 * Evaluate RFC 9309 longest-match decision for a token over a list of parsed groups.
 * @param {ParsedRobotsGroup[]} groups
 * @param {string} token
 * @param {string} path
 * @returns {{
 *   matchedGroup: string|null,
 *   rule: string|null,
 *   directive: 'allow'|'disallow'|null,
 *   pattern: string|null,
 *   allowed: boolean,
 *   status: 'allowed'|'blocked'|'default_allowed',
 *   source: 'cloudflare_managed'|'origin'|null,
 * }}
 */
function evaluateGroupsForToken(groups, token, path) {
  const targetToken = normalizeRobotsAgent(token);
  /** @type {string|null} */
  let matchedGroup = null;
  /** @type {ParsedRobotsRule[]} */
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

  /** @type {(ParsedRobotsRule & { length: number })|null} */
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

  if (!best) {
    return {
      matchedGroup,
      rule: null,
      directive: null,
      pattern: null,
      allowed: true,
      status: 'default_allowed',
      source: null,
    };
  }

  const allowed = best.type === 'allow';
  return {
    matchedGroup,
    rule: best.raw,
    directive: best.type,
    pattern: best.pattern,
    allowed,
    status: allowed ? 'allowed' : 'blocked',
    source: best.source,
  };
}

/**
 * Evaluate exact-token rules (without `*` fallback) inside a subset of groups.
 * Used to detect Cloudflare Managed vs Origin contradictions.
 * @param {ParsedRobotsGroup[]} groups
 * @param {string} normAgent
 * @param {string} path
 * @returns {{ rule: ParsedRobotsRule|null, contentSignals: Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>> }}
 */
function evaluateExactSectionAgent(groups, normAgent, path) {
  /** @type {ParsedRobotsRule[]} */
  const rules = [];
  /** @type {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} */
  const signals = {};

  for (const group of groups) {
    const hasAgent = group.agents.some((a) => normalizeRobotsAgent(a) === normAgent);
    if (!hasAgent) continue;
    rules.push(...group.rules);
    Object.assign(signals, group.contentSignals);
  }

  /** @type {(ParsedRobotsRule & { length: number })|null} */
  let best = null;
  for (const rule of rules) {
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

  return { rule: best, contentSignals: signals };
}

/**
 * Parse and analyze `robots.txt` + HTTP `Content-Signal` / `Content-Usage`
 * headers across all canonical AI crawlers & policy tokens.
 *
 * - RFC 9309 longest-match Allow/Disallow precedence + `endsWithRulelessGroup` guard
 * - `# BEGIN Cloudflare Managed Content` / `# END Cloudflare Managed Content`
 *   parsing + managed-vs-origin contradiction detection
 * - `Content-Signal` (`search`, `ai-input`, `ai-train`) & `Content-Usage`
 *   header-vs-robots conflict detection
 * - Clean recognition of IETF AIPREF `User-agent: __usage_ai-training` as a
 *   training-only opt-out that does not harm search visibility
 *
 * @param {string} robotsText
 * @param {string} [targetPath]
 * @param {HeaderInput} [httpHeaders]
 * @returns {RobotsPolicyResult}
 */
export function analyzeRobotsPolicy(robotsText, targetPath = '/', httpHeaders = {}) {
  const raw = typeof robotsText === 'string' ? robotsText.replace(/^\uFEFF/, '') : '';
  const path = normalizeTargetPath(targetPath);
  const headerMap = normalizeHeaders(httpHeaders);

  /** @type {ParsedRobotsGroup[]} */
  const groups = [];
  /** @type {Set<string>} */
  const sitemapSet = new Set();
  /** @type {Record<string, number>} */
  const crawlDelays = {};
  /** @type {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} */
  const globalRobotsSignals = {};

  let inCloudflareManaged = false;
  let cfManagedDetected = false;
  /** @type {number|null} */
  let cfStartLine = null;
  /** @type {number|null} */
  let cfEndLine = null;

  /** @type {ParsedRobotsGroup|null} */
  let currentGroup = null;
  let sawRuleInGroup = false;

  const lines = raw.split(/\r\n|\r|\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const trimmedLine = rawLine.trim();

    // Detect Cloudflare Managed Content fence markers before stripping comments
    if (/^#\s*BEGIN\s+Cloudflare\s+Managed\s+Content\b/i.test(trimmedLine)) {
      inCloudflareManaged = true;
      cfManagedDetected = true;
      if (cfStartLine === null) cfStartLine = lineIdx + 1;
      // Force a new group boundary so origin groups don't bleed into managed block
      currentGroup = null;
      sawRuleInGroup = false;
      continue;
    }
    if (/^#\s*END\s+Cloudflare\s+Managed\s+Content\b/i.test(trimmedLine)) {
      inCloudflareManaged = false;
      cfEndLine = lineIdx + 1;
      // Force a new group boundary so managed groups don't bleed into origin rules
      currentGroup = null;
      sawRuleInGroup = false;
      continue;
    }

    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    /** @type {'cloudflare_managed'|'origin'} */
    const source = inCloudflareManaged ? 'cloudflare_managed' : 'origin';

    if (field === 'sitemap') {
      if (value) sitemapSet.add(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!value) continue;
      if (!currentGroup || sawRuleInGroup || currentGroup.source !== source) {
        currentGroup = {
          agents: [value],
          rules: [],
          contentSignals: {},
          crawlDelay: null,
          source,
          hasAnyDirective: false,
        };
        groups.push(currentGroup);
        sawRuleInGroup = false;
      } else {
        currentGroup.agents.push(value);
      }
      continue;
    }

    if (field === 'content-signal' || field === 'content-usage') {
      const parsedSignals = parseContentSignalValue(value);
      if (currentGroup) {
        sawRuleInGroup = true;
        currentGroup.hasAnyDirective = true;
        Object.assign(currentGroup.contentSignals, parsedSignals);
      } else {
        Object.assign(globalRobotsSignals, parsedSignals);
      }
      continue;
    }

    if (!currentGroup) continue;

    if (field === 'allow' || field === 'disallow') {
      sawRuleInGroup = true;
      currentGroup.hasAnyDirective = true;
      if (value !== '') {
        currentGroup.rules.push({
          type: field,
          pattern: value,
          raw: `${field === 'allow' ? 'Allow' : 'Disallow'}: ${value}`,
          source,
        });
      }
    } else if (field === 'crawl-delay') {
      sawRuleInGroup = true;
      currentGroup.hasAnyDirective = true;
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay) && delay >= 0) {
        currentGroup.crawlDelay = delay;
        for (const agent of currentGroup.agents) {
          crawlDelays[agent] = delay;
        }
      }
    } else {
      sawRuleInGroup = true;
      currentGroup.hasAnyDirective = true;
    }
  }

  // `endsWithRulelessGroup`: final User-agent group has NO Allow/Disallow/directive rules
  const lastGroup = groups.length > 0 ? groups[groups.length - 1] : null;
  const endsWithRulelessGroup = Boolean(lastGroup && !lastGroup.hasAnyDirective);
  const trailingRulelessAgent = endsWithRulelessGroup && lastGroup ? (lastGroup.agents[lastGroup.agents.length - 1] ?? null) : null;

  // Evaluate all canonical bots in AI_CRAWLER_REGISTRY
  /** @type {RobotsBotEvaluation[]} */
  const bots = [];
  /** @type {Record<string, RobotsBotEvaluation>} */
  const byToken = {};

  for (const entry of AI_CRAWLER_REGISTRY) {
    const decision = evaluateGroupsForToken(groups, entry.token, path);
    /** @type {RobotsBotEvaluation} */
    const evaluation = {
      token: entry.token,
      vendor: entry.vendor,
      category: entry.category,
      executesJs: entry.executesJs,
      respectsRobots: entry.respectsRobots,
      ipFeedUrl: entry.ipFeedUrl,
      ...decision,
    };
    bots.push(evaluation);
    byToken[entry.token] = evaluation;
  }

  // Cloudflare Managed Content analysis & managed-vs-origin contradiction detection
  const managedGroups = groups.filter((g) => g.source === 'cloudflare_managed');
  const originGroups = groups.filter((g) => g.source === 'origin');

  /** @type {Set<string>} */
  const managedAgentNames = new Set();
  /** @type {Map<string, string>} */
  const managedAgentDisplay = new Map();
  /** @type {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} */
  const managedContentSignals = {};

  for (const g of managedGroups) {
    for (const a of g.agents) {
      managedAgentNames.add(a);
      const norm = normalizeRobotsAgent(a);
      if (!managedAgentDisplay.has(norm)) managedAgentDisplay.set(norm, a);
    }
    if (g.agents.some((a) => a.trim() === '*')) {
      Object.assign(managedContentSignals, g.contentSignals);
    }
  }

  /** @type {ManagedContradiction[]} */
  const contradictions = [];
  if (cfManagedDetected && originGroups.length > 0) {
    for (const [normAgent, displayAgent] of managedAgentDisplay.entries()) {
      const mEval = evaluateExactSectionAgent(managedGroups, normAgent, path);
      const oEval = evaluateExactSectionAgent(originGroups, normAgent, path);

      if (mEval.rule && oEval.rule && mEval.rule.type !== oEval.rule.type) {
        contradictions.push({
          agent: displayAgent,
          type: 'access_rule',
          managedDirective: mEval.rule.raw,
          originDirective: oEval.rule.raw,
          detail: `Cloudflare Managed Content sets "${mEval.rule.raw}" for ${displayAgent}, contradicting origin "${oEval.rule.raw}".`,
        });
      }

      /** @type {Array<'search'|'ai-input'|'ai-train'>} */
      const keys = ['search', 'ai-input', 'ai-train'];
      for (const key of keys) {
        const mVal = mEval.contentSignals[key];
        const oVal = oEval.contentSignals[key];
        if (mVal && oVal && mVal !== oVal) {
          contradictions.push({
            agent: displayAgent,
            type: 'content_signal',
            managedDirective: `Content-Signal: ${key}=${mVal}`,
            originDirective: `Content-Signal: ${key}=${oVal}`,
            detail: `Cloudflare Managed Content sets ${key}=${mVal} for ${displayAgent}, contradicting origin ${key}=${oVal}.`,
          });
        }
      }
    }
  }

  // Aggregate Content-Signal from robots.txt (global + wildcard `*` groups; last wins, origin after managed)
  /** @type {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} */
  const robotsSignals = { ...globalRobotsSignals };
  for (const g of groups) {
    if (g.agents.some((a) => a.trim() === '*') || Object.keys(g.contentSignals).length > 0) {
      // Prefer wildcard `*` group signals for site-wide Content-Signal policy
      if (g.agents.some((a) => a.trim() === '*')) {
        Object.assign(robotsSignals, g.contentSignals);
      }
    }
  }
  // If no wildcard group carried Content-Signal, fall back to any group carrying Content-Signal
  if (Object.keys(robotsSignals).length === 0) {
    for (const g of groups) {
      Object.assign(robotsSignals, g.contentSignals);
    }
  }

  // Parse HTTP headers `Content-Signal` and `Content-Usage`
  const headerContentSignalRaw = headerMap.get('content-signal') ?? null;
  const headerContentUsageRaw = headerMap.get('content-usage') ?? null;
  /** @type {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} */
  const headerSignals = {
    ...(headerContentUsageRaw ? parseContentSignalValue(headerContentUsageRaw) : {}),
    ...(headerContentSignalRaw ? parseContentSignalValue(headerContentSignalRaw) : {}),
  };

  /** @type {ContentSignalConflict[]} */
  const signalConflicts = [];
  /** @type {Array<'search'|'ai-input'|'ai-train'>} */
  const signalKeys = ['search', 'ai-input', 'ai-train'];
  for (const key of signalKeys) {
    const rVal = robotsSignals[key];
    const hVal = headerSignals[key];
    if (rVal && hVal && rVal !== hVal) {
      signalConflicts.push({
        directive: key,
        robotsValue: rVal,
        headerValue: hVal,
        detail: `robots.txt declares Content-Signal ${key}=${rVal}, conflicting with HTTP header ${key}=${hVal}.`,
      });
    }
  }

  /** @type {Partial<Record<'search'|'ai-input'|'ai-train', 'yes'|'no'>>} */
  const effectiveSignals = { ...robotsSignals, ...headerSignals };

  // IETF AIPREF `__usage_ai-training` clean recognition
  const aiprefEval = byToken['__usage_ai-training'];
  const aiprefExplicitlyMatched = Boolean(
    aiprefEval && aiprefEval.matchedGroup && normalizeRobotsAgent(aiprefEval.matchedGroup) === '__usage_ai-training',
  );
  const aiprefDisallowed = Boolean(aiprefExplicitlyMatched && !aiprefEval.allowed);

  // Summary counts (policy_signal tokens are tracked separately so training opt-outs never pollute search counts!)
  /** @type {string[]} */
  const searchRetrievalBlocked = [];
  /** @type {string[]} */
  const userFetchBlocked = [];
  /** @type {string[]} */
  const mixedSearchAiBlocked = [];
  /** @type {string[]} */
  const trainingBlocked = [];
  /** @type {string[]} */
  const policySignalsDisallowed = [];
  let allowedCount = 0;
  let blockedCount = 0;

  for (const b of bots) {
    if (b.category === 'policy_signal') {
      if (!b.allowed) policySignalsDisallowed.push(b.token);
      continue;
    }
    if (b.allowed) {
      allowedCount++;
    } else {
      blockedCount++;
      if (b.category === 'search_retrieval') searchRetrievalBlocked.push(b.token);
      else if (b.category === 'user_fetch') userFetchBlocked.push(b.token);
      else if (b.category === 'mixed_search_ai') mixedSearchAiBlocked.push(b.token);
      else if (b.category === 'training') trainingBlocked.push(b.token);
    }
  }

  return {
    targetPath: path,
    bots,
    byToken,
    sitemaps: [...sitemapSet],
    crawlDelays,
    endsWithRulelessGroup,
    trailingRulelessAgent,
    cloudflareManaged: {
      detected: cfManagedDetected,
      startLine: cfStartLine,
      endLine: cfEndLine,
      managedAgents: [...managedAgentNames],
      contentSignals: managedContentSignals,
      contradictions,
    },
    contentSignals: {
      robots: robotsSignals,
      headers: headerSignals,
      contentUsageRaw: headerContentUsageRaw,
      effective: effectiveSignals,
      conflicts: signalConflicts,
      suppressesAiInput: robotsSignals['ai-input'] === 'no' || headerSignals['ai-input'] === 'no',
      suppressesSearch: robotsSignals.search === 'no' || headerSignals.search === 'no',
    },
    aiprefTrainingOptOut: {
      detected: aiprefExplicitlyMatched,
      disallowed: aiprefDisallowed,
      matchedRule: aiprefExplicitlyMatched ? aiprefEval.rule : null,
      trainingOnly: true,
      affectsSearchVisibility: false,
    },
    summary: {
      totalChecked: bots.length,
      allowedCount,
      blockedCount,
      searchRetrievalBlocked,
      userFetchBlocked,
      mixedSearchAiBlocked,
      trainingBlocked,
      policySignalsDisallowed,
    },
  };
}

// ===========================================================================
// CACHING / CONDITIONAL GET VALIDATORS & VARY HYGIENE
// ===========================================================================

/**
 * Audit HTTP caching validators (`ETag`, `Last-Modified` plausibility),
 * `Cache-Control`, and `Vary` hygiene with 0 extra HTTP requests.
 *
 * @param {HeaderInput} headers
 * @param {Date|string|number} [now]
 * @param {CachingAnalysisOptions} [options]
 * @returns {CachingAnalysisResult}
 */
export function analyzeCachingHeaders(headers, now = new Date(), options = {}) {
  const headerMap = normalizeHeaders(headers);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();

  /** @type {CachingIssue[]} */
  const issues = [];

  // 1. ETag (accepting weak W/ ETags as valid for conditional GET 304)
  const rawEtag = headerMap.get('etag')?.trim() ?? null;
  const etagPresent = Boolean(rawEtag);
  const etagWeak = Boolean(rawEtag && /^W\//i.test(rawEtag));
  const etagValid = Boolean(rawEtag && /^(?:W\/)?"[^"]*"$/i.test(rawEtag));

  // 2. Date header
  const rawDate = headerMap.get('date')?.trim() ?? null;
  const dateMs = rawDate ? Date.parse(rawDate) : Number.NaN;
  const dateValid = Number.isFinite(dateMs);

  // 3. Last-Modified plausibility filter
  const rawLastMod = headerMap.get('last-modified')?.trim() ?? null;
  const lastModMs = rawLastMod ? Date.parse(rawLastMod) : Number.NaN;
  /** @type {'missing'|'invalid'|'placeholder_pre_1995'|'stamps_now'|'future_clock_skew'|'plausible'} */
  let lastModReason = 'missing';
  let lastModPlausible = false;

  if (rawLastMod) {
    if (!Number.isFinite(lastModMs)) {
      lastModReason = 'invalid';
      issues.push({
        id: 'last_modified_invalid',
        severity: 'warning',
        title: 'Unparseable Last-Modified header',
        detail: `Last-Modified "${rawLastMod}" is not a valid RFC 9110 HTTP-date.`,
      });
    } else if (lastModMs < LASTMOD_MIN_MS) {
      lastModReason = 'placeholder_pre_1995';
      issues.push({
        id: 'last_modified_placeholder',
        severity: 'warning',
        title: 'Placeholder Last-Modified timestamp (<1995)',
        detail: `Last-Modified "${rawLastMod}" predates 1995-01-01 (likely a cache-busting epoch placeholder).`,
      });
    } else if (lastModMs - nowMs > LASTMOD_FUTURE_TOLERANCE_MS) {
      lastModReason = 'future_clock_skew';
      issues.push({
        id: 'last_modified_future',
        severity: 'warning',
        title: 'Future Last-Modified timestamp (>24h clock skew)',
        detail: `Last-Modified "${rawLastMod}" is more than 24 hours ahead of current time.`,
      });
    } else if (dateValid && Math.abs(dateMs - lastModMs) <= LASTMOD_NOW_TOLERANCE_MS) {
      lastModReason = 'stamps_now';
      issues.push({
        id: 'last_modified_stamps_now',
        severity: 'warning',
        title: 'Last-Modified stamps current request time (within 60s of Date)',
        detail: `Last-Modified "${rawLastMod}" is within 60s of response Date "${rawDate}", defeating conditional GET (304 Not Modified) and recrawl freshness signals.`,
      });
    } else {
      lastModReason = 'plausible';
      lastModPlausible = true;
    }
  }

  // 4. Cache-Control
  const rawCacheControl = headerMap.get('cache-control')?.trim() ?? null;
  const directives = rawCacheControl
    ? rawCacheControl
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const hasNoStore = directives.includes('no-store');
  const hasPrivate = directives.includes('private');
  const hasNoCache = directives.includes('no-cache');

  /** @param {string} prefix */
  const parseDirectiveSeconds = (prefix) => {
    const found = directives.find((d) => d.startsWith(`${prefix}=`));
    if (!found) return null;
    const n = Number.parseInt(found.slice(prefix.length + 1), 10);
    return Number.isFinite(n) ? n : null;
  };
  const maxAge = parseDirectiveSeconds('max-age');
  const sMaxAge = parseDirectiveSeconds('s-maxage');

  if (hasNoStore) {
    issues.push({
      id: 'cache_control_no_store',
      severity: 'warning',
      title: 'Cache-Control: no-store disables CDN and crawler caching',
      detail: 'Public HTML responses carrying Cache-Control: no-store force origin hits on every crawl and prevent conditional 304 revalidation.',
    });
  }

  // 5. Vary hygiene
  const rawVary = headerMap.get('vary')?.trim() ?? null;
  const varyTokens = rawVary
    ? rawVary
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const varyTokenSet = new Set(varyTokens);

  const hasUserAgent = varyTokenSet.has('user-agent');
  const hasAccept = varyTokenSet.has('accept') || varyTokenSet.has('*');
  const hasRsc = varyTokenSet.has('rsc') || varyTokenSet.has('next-router-state-tree');
  const hasGeoHeader = varyTokens.some((t) => GEO_VARY_HEADERS.has(t));

  if (hasUserAgent) {
    issues.push({
      id: 'vary_user_agent',
      severity: 'warning',
      title: 'Vary: User-Agent signals dynamic serving / cloaking risk',
      detail: 'Varying responses by User-Agent fragments CDN caches and increases risk of serving different HTML to AI crawlers vs browsers.',
    });
  }

  if (hasGeoHeader) {
    issues.push({
      id: 'vary_geo_header',
      severity: 'info',
      title: 'Geo-based Vary header detected',
      detail: `Response varies by geographic header (${varyTokens.filter((t) => GEO_VARY_HEADERS.has(t)).join(', ')}), which may alter content seen by non-local crawlers.`,
    });
  }

  const contentType = (headerMap.get('content-type') ?? '').toLowerCase();
  const isMarkdownResponse = options.isMarkdownResponse ?? contentType.includes('text/markdown');
  if (isMarkdownResponse && !hasAccept) {
    issues.push({
      id: 'missing_vary_accept_markdown',
      severity: 'critical',
      title: 'Markdown response missing Vary: Accept (cache-poisoning risk)',
      detail: 'Content-Type: text/markdown without Vary: Accept can cause shared CDNs to cache Markdown and serve it to HTML browsers (or vice versa).',
    });
  }

  const isNextJsAppRouter = options.isNextJsAppRouter ?? headerMap.has('x-nextjs-prerender');
  if (isNextJsAppRouter && !hasRsc) {
    issues.push({
      id: 'missing_vary_rsc_nextjs',
      severity: 'warning',
      title: 'Next.js App Router response missing Vary: Rsc',
      detail: 'Custom CDNs stripping Vary: Rsc / Next-Router-State-Tree risk caching raw React Flight payloads as HTML for crawlers.',
    });
  }

  const conditionalGetReady = etagValid || lastModPlausible;
  if (!conditionalGetReady) {
    issues.push({
      id: 'missing_conditional_validators',
      severity: 'info',
      title: 'Missing valid ETag or plausible Last-Modified validator',
      detail: 'Without an ETag or plausible Last-Modified header, returning crawlers cannot revalidate unchanged pages with HTTP 304 Not Modified.',
    });
  }

  return {
    etag: {
      present: etagPresent,
      raw: rawEtag,
      weak: etagWeak,
      valid: etagValid,
    },
    lastModified: {
      present: Boolean(rawLastMod),
      raw: rawLastMod,
      iso: Number.isFinite(lastModMs) ? new Date(lastModMs).toISOString() : null,
      timestampMs: Number.isFinite(lastModMs) ? lastModMs : null,
      plausible: lastModPlausible,
      reason: lastModReason,
    },
    dateHeader: {
      present: Boolean(rawDate),
      raw: rawDate,
      iso: dateValid ? new Date(dateMs).toISOString() : null,
      timestampMs: dateValid ? dateMs : null,
    },
    cacheControl: {
      present: Boolean(rawCacheControl),
      raw: rawCacheControl,
      directives,
      hasNoStore,
      hasPrivate,
      hasNoCache,
      maxAge,
      sMaxAge,
    },
    vary: {
      present: Boolean(rawVary),
      raw: rawVary,
      tokens: varyTokens,
      hasUserAgent,
      hasAccept,
      hasRsc,
      hasGeoHeader,
    },
    conditionalGetReady,
    issues,
  };
}

// ===========================================================================
// ZERO-KEY DNS OSINT HINTS (`node:dns/promises`)
// ===========================================================================

/**
 * Normalize a hostname or URL input to a bare lowercase DNS hostname.
 * @param {string} input
 * @returns {string}
 */
function normalizeHostname(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return '';
    }
  }
  return raw
    .split('/')[0]
    .split(':')[0]
    .toLowerCase()
    .replace(/\.$/, '');
}

/**
 * Infer edge / CDN / SaaS providers from CNAME and NS records.
 * @param {string[]} cnames
 * @param {string[]} nsRecords
 * @returns {string[]}
 */
function inferEdgeFromDns(cnames, nsRecords) {
  /** @type {Set<string>} */
  const inferred = new Set();

  /**
   * @param {string} host
   * @param {boolean} isNs
   */
  const checkHost = (host, isNs) => {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (h.endsWith('.cloudflare.net') || h.endsWith('.cloudflare.com') || h.endsWith('.cfargotunnel.com')) {
      inferred.add('cloudflare');
    } else if (h.endsWith('.vercel-dns.com') || h === 'cname.vercel-dns.com' || h.endsWith('.vercel.app')) {
      inferred.add('vercel');
    } else if (h.endsWith('.netlify.app') || h.endsWith('.netlify.com') || h.endsWith('.netlifyglobalcdn.com')) {
      inferred.add('netlify');
    } else if (
      h.endsWith('.akamaiedge.net') ||
      h.endsWith('.edgesuite.net') ||
      h.endsWith('.edgekey.net') ||
      h.endsWith('.akamai.net') ||
      h.endsWith('.akamaized.net') ||
      (isNs && h.endsWith('.akam.net'))
    ) {
      inferred.add('akamai');
    } else if (h.endsWith('.fastly.net') || h.endsWith('.fastlylb.net')) {
      inferred.add('fastly');
    } else if (h.endsWith('.cloudfront.net')) {
      inferred.add('aws-cloudfront');
    } else if (isNs && /\.awsdns-\d+\.(?:com|net|org|co\.uk)$/.test(h)) {
      inferred.add('aws-route53');
    } else if (h.endsWith('.b-cdn.net')) {
      inferred.add('bunnycdn');
    } else if (h === 'shops.myshopify.com' || h.endsWith('.myshopify.com')) {
      inferred.add('shopify');
    } else if (h === 'proxy-ssl.webflow.com' || h === 'proxy.webflow.com' || h.endsWith('.webflow.io')) {
      inferred.add('webflow');
    } else if (h.endsWith('.github.io')) {
      inferred.add('github-pages');
    } else if (h.endsWith('.fly.dev') || h.endsWith('.fly.io')) {
      inferred.add('fly-io');
    } else if (h.endsWith('.onrender.com')) {
      inferred.add('render');
    } else if (h.endsWith('.azurefd.net') || h.endsWith('.azureedge.net')) {
      inferred.add('azure-front-door');
    }
  };

  for (const c of cnames) checkHost(c, false);
  for (const n of nsRecords) checkHost(n, true);

  return [...inferred];
}

/**
 * Run a single DNS lookup promise with a clean timeout guard (never leaks timers).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: true, value: T } | { ok: false, timedOut: boolean, error: string }>}
 */
async function runWithTimeout(fn, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  try {
    /** @type {Promise<never>} */
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), timeoutMs);
    });
    const value = await Promise.race([fn(), timeoutPromise]);
    return { ok: true, value };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      timedOut: code === 'DNS_TIMEOUT' || code === 'ETIMEOUT',
      error: code,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Perform non-throwing DNS OSINT (`CNAME`, `NS`, `TXT`) using Node 22
 * `node:dns/promises` (or an injected resolver for deterministic testing)
 * with a strict timeout guard.
 *
 * @param {string} hostname
 * @param {DnsProbeOptions} [options]
 * @returns {Promise<DnsHintsResult>}
 */
export async function probeDnsHints(hostname, options = {}) {
  const cleanHost = normalizeHostname(hostname);
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_DNS_TIMEOUT_MS;

  if (!cleanHost) {
    return {
      hostname: '',
      cname: [],
      ns: [],
      txt: [],
      verificationTokens: { google: false, bing: false, apple: false, openai: false, other: [] },
      inferredEdge: [],
      errors: ['invalid_hostname'],
      timedOut: false,
    };
  }

  const cnameFn = options.resolver?.resolveCname ?? resolveCname;
  const nsFn = options.resolver?.resolveNs ?? resolveNs;
  const txtFn = options.resolver?.resolveTxt ?? resolveTxt;

  const [cnameRes, nsRes, txtRes] = await Promise.all([
    runWithTimeout(() => cnameFn(cleanHost), timeoutMs),
    runWithTimeout(() => nsFn(cleanHost), timeoutMs),
    runWithTimeout(() => txtFn(cleanHost), timeoutMs),
  ]);

  const cname = cnameRes.ok && Array.isArray(cnameRes.value) ? cnameRes.value.map(String) : [];
  const ns = nsRes.ok && Array.isArray(nsRes.value) ? nsRes.value.map(String) : [];
  const txt =
    txtRes.ok && Array.isArray(txtRes.value)
      ? txtRes.value.map((entry) => (Array.isArray(entry) ? entry.join('') : String(entry)))
      : [];

  /** @type {string[]} */
  const errors = [];
  const benignCodes = new Set(['ENODATA', 'ENOTFOUND']);
  /** @type {Array<[string, { ok: boolean, error?: string }]>} */
  const probePairs = [
    ['cname', cnameRes],
    ['ns', nsRes],
    ['txt', txtRes],
  ];
  for (const [label, res] of probePairs) {
    if (!res.ok && res.error && !benignCodes.has(res.error)) {
      errors.push(`${label}:${res.error}`);
    }
  }

  const timedOut = Boolean(
    (!cnameRes.ok && cnameRes.timedOut) || (!nsRes.ok && nsRes.timedOut) || (!txtRes.ok && txtRes.timedOut),
  );

  let google = false;
  let bing = false;
  let apple = false;
  let openai = false;
  /** @type {string[]} */
  const other = [];

  for (const record of txt) {
    const lower = record.toLowerCase();
    if (lower.startsWith('google-site-verification=')) google = true;
    else if (lower.startsWith('msvalidate.01=')) bing = true;
    else if (lower.startsWith('apple-domain-verification=')) apple = true;
    else if (lower.startsWith('openai-domain-verification=')) openai = true;
    else if (lower.includes('-verification=') || lower.includes('-domain-verification=')) {
      const key = record.split('=')[0].trim();
      if (key) other.push(key);
    }
  }

  return {
    hostname: cleanHost,
    cname,
    ns,
    txt,
    verificationTokens: { google, bing, apple, openai, other },
    inferredEdge: inferEdgeFromDns(cname, ns),
    errors,
    timedOut,
  };
}
