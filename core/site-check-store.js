/**
 * SQLite persistence and drift comparison helpers for `hearsay check` v2 reports.
 *
 * Pure Node 22 built-ins only (`node:crypto`, `node:sqlite` via `core/db.js`).
 * Never stores secrets, cookies, or authorization headers, caps huge reports safely,
 * and omits heavy `report_json` blobs from list queries.
 */

import { createHash } from 'node:crypto';
import { all, ensureSiteChecksTable, get, isoNow, run } from './db.js';
import { diffAgainstBaseline } from './site-diff.js';

/** Maximum serialized UTF-8 byte length stored in `site_checks.report_json` (2 MiB). */
export const MAX_REPORT_JSON_BYTES = 2 * 1024 * 1024;

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 25;
const TRUNCATED_TEXT_PREVIEW_CHARS = 8_000;

/**
 * Keys whose values must never be persisted into `site_checks.report_json`.
 * Deliberately does NOT match safe metadata keys such as `cookieNames` or `tokenCount`.
 */
const SENSITIVE_KEY_RE =
  /^(?:authorization|proxy[-_]?authorization|cookie|cookies|set[-_]?cookie|set[-_]?cookies|x[-_]?api[-_]?key|api[-_]?key|api[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|secret|secrets|password|passwd|private[-_]?key|session[-_]?id|csrf[-_]?token)$/i;

/**
 * @typedef {import('./db.js').Db} Db
 * @typedef {import('./site-diff.js').BaselineDiffResult} BaselineDiffResult
 */

/**
 * @typedef {Object} SiteCheckSummary
 * @property {number} id
 * @property {string} url
 * @property {string} domain
 * @property {string} mode
 * @property {string} status
 * @property {number} criticalCount
 * @property {number} warningCount
 * @property {number} auditedCount
 * @property {number} skippedCount
 * @property {number} erroredCount
 * @property {number|null} proseParityPct
 * @property {number|null} medianPayloadRatio
 * @property {string} contentHash
 * @property {string[]} stack
 * @property {string|null} wafState
 * @property {string} createdAt
 */

/**
 * @typedef {SiteCheckSummary & { report: Record<string, any> }} SavedSiteCheck
 */

/**
 * @typedef {Object} ListSiteChecksOptions
 * @property {string} [domain]
 * @property {number} [limit]
 */

/**
 * @typedef {Object} SavedSiteCheckDiff
 * @property {SiteCheckSummary} current
 * @property {SiteCheckSummary} baseline
 * @property {BaselineDiffResult} diff
 */

/**
 * Check whether the `site_checks` table exists on this database handle.
 * Allows read-only handles opened against pre-upgrade databases to degrade cleanly.
 *
 * @param {Db} db
 * @returns {boolean}
 */
function hasSiteChecksTable(db) {
  const row = get(db, "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'site_checks'");
  return Boolean(row);
}

/**
 * Compute median of finite numbers, or null when empty.
 * @param {number[]} values
 * @param {number} decimals
 * @returns {number|null}
 */
function medianNumber(values, decimals) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  const val = nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return Number(val.toFixed(decimals));
}

/**
 * Normalize a domain or URL string into a lowercase hostname.
 * @param {string} raw
 * @returns {string}
 */
function normalizeDomainInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  }
  return trimmed.replace(/\/.*$/, '').toLowerCase();
}

/**
 * Extract canonical URL from a site-check report.
 * @param {Record<string, any>} report
 * @returns {string}
 */
function extractUrl(report) {
  const candidates = [
    report.finalUrl,
    report.requestedUrl,
    report.url,
    Array.isArray(report.pages) ? report.pages[0]?.finalUrl : null,
    Array.isArray(report.pages) ? report.pages[0]?.url : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return '';
}

/**
 * Extract normalized lowercase domain from a report or its URL.
 * @param {Record<string, any>} report
 * @param {string} url
 * @returns {string}
 */
function extractDomain(report, url) {
  if (typeof report.domain === 'string' && report.domain.trim() !== '') {
    return normalizeDomainInput(report.domain);
  }
  if (url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return normalizeDomainInput(url) || 'unknown';
    }
  }
  return 'unknown';
}

/**
 * Extract check mode (`crawl`, `single`, `multi`, `vs`, etc.).
 * @param {Record<string, any>} report
 * @returns {string}
 */
function extractMode(report) {
  const raw =
    report.mode ??
    (report.competitorXray
      ? 'vs'
      : Array.isArray(report.pages)
        ? report.single
          ? 'single'
          : 'crawl'
        : 'single');
  const clean = typeof raw === 'string' ? raw.trim() : '';
  return clean || 'crawl';
}

/**
 * Collect deduplicated canonical finding tuples across site & page findings.
 * @param {Record<string, any>} report
 * @returns {Array<{id: string, severity: string, url: string}>}
 */
function collectCanonicalFindings(report) {
  /** @type {Array<{id: string, severity: string, url: string}>} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {unknown} raw
   * @param {string} scopeUrl
   */
  const push = (raw, scopeUrl) => {
    if (!raw || typeof raw !== 'object') return;
    const obj = /** @type {Record<string, unknown>} */ (raw);
    const id = String(obj.ruleId ?? obj.id ?? '').trim().toLowerCase();
    if (!id) return;
    const severity = String(obj.severity ?? 'info').trim().toLowerCase();
    const key = `${id}::${severity}::${scopeUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, severity, url: scopeUrl });
  };

  if (Array.isArray(report.pages)) {
    if (Array.isArray(report.siteFindings)) {
      for (const f of report.siteFindings) push(f, 'site');
    }
    for (const page of report.pages) {
      const pageUrl = String(page?.finalUrl ?? page?.url ?? 'page').trim() || 'page';
      if (Array.isArray(page?.findings)) {
        for (const f of page.findings) push(f, pageUrl);
      }
    }
  } else {
    if (Array.isArray(report.siteFindings)) {
      for (const f of report.siteFindings) push(f, 'site');
    }
    if (Array.isArray(report.findings)) {
      const scopeUrl = String(report.finalUrl ?? report.requestedUrl ?? 'site').trim() || 'site';
      for (const f of report.findings) push(f, scopeUrl);
    }
  }

  out.sort((a, b) => {
    if (a.url !== b.url) return a.url.localeCompare(b.url);
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    return a.severity.localeCompare(b.severity);
  });
  return out;
}

/**
 * Extract prose parity percentage (0..100), or null if not observed.
 * @param {Record<string, any>} report
 * @returns {number|null}
 */
function extractProseParityPct(report) {
  if (typeof report.proseParityPct === 'number' && Number.isFinite(report.proseParityPct)) {
    return Number(report.proseParityPct.toFixed(1));
  }
  if (typeof report.botVsHumanDiff?.proseParityRatio === 'number' && Number.isFinite(report.botVsHumanDiff.proseParityRatio)) {
    return Number((report.botVsHumanDiff.proseParityRatio * 100).toFixed(1));
  }
  if (
    report.browserDiff?.status === 'ok' &&
    typeof report.browserDiff.rawWordCount === 'number' &&
    typeof report.browserDiff.renderedWordCount === 'number' &&
    report.browserDiff.renderedWordCount > 0
  ) {
    return Number(Math.min(100, (report.browserDiff.rawWordCount / report.browserDiff.renderedWordCount) * 100).toFixed(1));
  }
  if (Array.isArray(report.pages)) {
    /** @type {number[]} */
    const vals = [];
    for (const page of report.pages) {
      if (typeof page?.proseParityPct === 'number' && Number.isFinite(page.proseParityPct)) {
        vals.push(page.proseParityPct);
      } else if (
        typeof page?.visibleWordCount === 'number' &&
        typeof page?.renderedWordCount === 'number' &&
        page.renderedWordCount > 0
      ) {
        vals.push(Math.min(100, (page.visibleWordCount / page.renderedWordCount) * 100));
      }
    }
    return medianNumber(vals, 1);
  }
  return null;
}

/**
 * Compute payload-to-prose ratio for one page or report object.
 * @param {Record<string, any>|null|undefined} obj
 * @returns {number|null}
 */
function extractSinglePayloadRatio(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.payloadToProseRatio === 'number' && Number.isFinite(obj.payloadToProseRatio)) {
    return Number(obj.payloadToProseRatio.toFixed(2));
  }
  const forensicsRatio = obj.extraction?.forensics?.payloadToProseRatio;
  if (typeof forensicsRatio === 'number' && Number.isFinite(forensicsRatio)) {
    return Number(forensicsRatio.toFixed(2));
  }
  const htmlBytes =
    typeof obj.htmlBytes === 'number'
      ? obj.htmlBytes
      : typeof obj.payload?.htmlBytes === 'number'
        ? obj.payload.htmlBytes
        : null;
  const visibleTextBytes =
    typeof obj.payload?.visibleTextBytes === 'number'
      ? obj.payload.visibleTextBytes
      : typeof obj.visibleTextBytes === 'number'
        ? obj.visibleTextBytes
        : null;
  if (htmlBytes !== null && visibleTextBytes !== null && visibleTextBytes > 0) {
    return Number((htmlBytes / visibleTextBytes).toFixed(2));
  }
  return null;
}

/**
 * Extract median payload-to-prose ratio across pages (or single-page report), or null.
 * @param {Record<string, any>} report
 * @returns {number|null}
 */
function extractMedianPayloadRatio(report) {
  if (typeof report.medianPayloadRatio === 'number' && Number.isFinite(report.medianPayloadRatio)) {
    return Number(report.medianPayloadRatio.toFixed(2));
  }
  if (Array.isArray(report.pages) && report.pages.length > 0) {
    /** @type {number[]} */
    const ratios = [];
    for (const page of report.pages) {
      const r = extractSinglePayloadRatio(page);
      if (r !== null) ratios.push(r);
    }
    const med = medianNumber(ratios, 2);
    if (med !== null) return med;
  }
  return extractSinglePayloadRatio(report);
}

/**
 * Extract deduplicated detected technology/stack names from a report.
 * @param {Record<string, any>} report
 * @returns {string[]}
 */
function extractStackNames(report) {
  /** @type {string[]} */
  const names = [];
  /** @type {Set<string>} */
  const seenLower = new Set();

  /** @param {unknown} label */
  const addLabel = (label) => {
    if (typeof label !== 'string') return;
    const clean = label.trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seenLower.has(key)) return;
    seenLower.add(key);
    names.push(clean);
  };

  /** @param {unknown} src */
  const collectFrom = (src) => {
    if (Array.isArray(src)) {
      for (const item of src) {
        if (typeof item === 'string') addLabel(item);
        else if (item && typeof item === 'object') {
          const rec = /** @type {Record<string, unknown>} */ (item);
          addLabel(rec.name ?? rec.id);
        }
      }
      return;
    }
    if (src && typeof src === 'object') {
      const obj = /** @type {Record<string, unknown>} */ (src);
      /** @type {Map<string, string>} */
      const idToName = new Map();
      if (Array.isArray(obj.technologies)) {
        for (const tech of obj.technologies) {
          if (tech && typeof tech === 'object') {
            const rec = /** @type {Record<string, unknown>} */ (tech);
            const id = typeof rec.id === 'string' ? rec.id.trim() : '';
            const name = typeof rec.name === 'string' ? rec.name.trim() : '';
            if (id && name) idToName.set(id, name);
            addLabel(name || id);
          }
        }
      }
      for (const key of ['primaryFramework', 'primaryCms', 'primaryCdn', 'primaryHosting']) {
        const val = obj[key];
        if (typeof val === 'string' && val.trim()) {
          const trimmed = val.trim();
          addLabel(idToName.get(trimmed) ?? trimmed);
        }
      }
    }
  };

  collectFrom(report.stack);
  if (names.length === 0 && Array.isArray(report.pages)) {
    for (const page of report.pages) {
      collectFrom(page?.stackResult ?? page?.stack);
    }
  }
  return names;
}

/**
 * Extract WAF state string or null.
 * @param {Record<string, any>} report
 * @returns {string|null}
 */
function extractWafState(report) {
  const candidates = [
    report.waf?.state,
    report.stack?.waf?.state,
    report.wafState,
    Array.isArray(report.pages) ? report.pages[0]?.wafState : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return null;
}

/**
 * Compute SHA-256 hex digest of a string.
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Compute deterministic SHA-256 `contentHash` over canonical URL, status, findings,
 * and extracted markdown hashes.
 *
 * @param {Record<string, any>} report
 * @param {string} url
 * @param {string} status
 * @param {Array<{id: string, severity: string, url: string}>} findings
 * @returns {string}
 */
function computeContentHash(report, url, status, findings) {
  /** @type {Array<{url: string, status: number|null, markdownHash: string|null}>} */
  const markdownEntries = [];

  if (typeof report.extraction?.extracted?.markdown === 'string') {
    markdownEntries.push({
      url,
      status: typeof report.status === 'number' ? report.status : null,
      markdownHash: sha256Hex(report.extraction.extracted.markdown),
    });
  }

  if (Array.isArray(report.pages)) {
    for (const page of report.pages) {
      const pageUrl = String(page?.finalUrl ?? page?.url ?? '').trim();
      if (!pageUrl) continue;
      const md =
        typeof page?.extraction?.extracted?.markdown === 'string'
          ? page.extraction.extracted.markdown
          : typeof page?.markdown === 'string'
            ? page.markdown
            : null;
      const wordSig =
        md !== null
          ? sha256Hex(md)
          : typeof page?.visibleWordCount === 'number'
            ? `words:${page.visibleWordCount}`
            : null;
      markdownEntries.push({
        url: pageUrl,
        status: typeof page?.status === 'number' ? page.status : null,
        markdownHash: wordSig,
      });
    }
  }

  markdownEntries.sort((a, b) => a.url.localeCompare(b.url));

  const canonical = {
    url,
    status,
    httpStatus: typeof report.status === 'number' ? report.status : null,
    findings,
    markdownHashes: markdownEntries,
  };
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * Normalize a timestamp string into UTC ISO-8601 second precision (`YYYY-MM-DDTHH:MM:SSZ`).
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeCreatedAt(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = new Date(raw.trim());
    if (!Number.isNaN(parsed.getTime())) {
      return isoNow(parsed);
    }
  }
  return isoNow();
}

/**
 * Recursively sanitize an arbitrary report payload so secrets, cookies, and auth tokens
 * are never written to SQLite, while never mutating the caller's object.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function sanitizeValue(value, seen) {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
  if (kind === 'bigint') return Number(value);
  if (kind !== 'object') return undefined;

  const obj = /** @type {object} */ (value);
  if (seen.has(obj)) return '[Circular]';
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof URL) return obj.href;
  if (typeof Headers !== 'undefined' && obj instanceof Headers) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of obj.entries()) {
      if (SENSITIVE_KEY_RE.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((/** @type {unknown} */ item) => sanitizeValue(item, seen));
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      const clean = sanitizeValue(val, seen);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Truncate a string field on an object in place when longer than `maxChars`.
 * @param {Record<string, any>|null|undefined} target
 * @param {string} field
 * @param {number} maxChars
 */
function truncateField(target, field, maxChars) {
  if (!target || typeof target !== 'object') return;
  if (typeof target[field] === 'string' && target[field].length > maxChars) {
    target[field] = `${target[field].slice(0, maxChars)}\n...[truncated]`;
    target._truncated = true;
  }
}

/**
 * Serialize a sanitized report to JSON, progressively trimming heavy raw text/markdown
 * blobs if needed so `report_json` stays safely bounded within `MAX_REPORT_JSON_BYTES`
 * while preserving every field required by `diffAgainstBaseline`.
 *
 * @param {Record<string, any>} report
 * @returns {string}
 */
function serializeReportCapped(report) {
  const sanitized = /** @type {Record<string, any>} */ (sanitizeValue(report, new WeakSet()));
  let json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, 'utf8') <= MAX_REPORT_JSON_BYTES) return json;

  // Stage 1: cap raw HTML and large markdown/diff bodies
  truncateField(sanitized, 'html', TRUNCATED_TEXT_PREVIEW_CHARS);
  truncateField(sanitized.extraction?.extracted, 'markdown', TRUNCATED_TEXT_PREVIEW_CHARS);
  truncateField(sanitized.markdownNegotiation, 'markdown', TRUNCATED_TEXT_PREVIEW_CHARS);
  truncateField(sanitized.botVsHumanDiff, 'botMarkdown', TRUNCATED_TEXT_PREVIEW_CHARS);
  truncateField(sanitized.botVsHumanDiff, 'humanMarkdown', TRUNCATED_TEXT_PREVIEW_CHARS);
  if (Array.isArray(sanitized.botVsHumanDiff?.diffHunks) && sanitized.botVsHumanDiff.diffHunks.length > 50) {
    sanitized.botVsHumanDiff.diffHunks = sanitized.botVsHumanDiff.diffHunks.slice(0, 50);
    sanitized.botVsHumanDiff._truncated = true;
  }
  if (Array.isArray(sanitized.pages)) {
    for (const page of sanitized.pages) {
      truncateField(page, 'html', 2_000);
      truncateField(page, 'markdown', 2_000);
      truncateField(page?.extraction?.extracted, 'markdown', 2_000);
    }
  }
  sanitized._storageTruncated = true;

  json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, 'utf8') <= MAX_REPORT_JSON_BYTES) return json;

  // Stage 2: retain compact diff-essential structure
  const compact = {
    schemaVersion: sanitized.schemaVersion ?? 2,
    checkedAt: sanitized.checkedAt ?? sanitized.crawledAt ?? null,
    requestedUrl: sanitized.requestedUrl ?? sanitized.url ?? null,
    finalUrl: sanitized.finalUrl ?? sanitized.requestedUrl ?? null,
    domain: sanitized.domain ?? null,
    mode: sanitized.mode ?? null,
    status: sanitized.status ?? null,
    crawlStatus: sanitized.crawlStatus ?? null,
    hardGate: sanitized.hardGate ?? null,
    counts: sanitized.counts ?? null,
    proseParityPct: sanitized.proseParityPct ?? null,
    robotsPolicy: sanitized.robotsPolicy
      ? {
          bots: Array.isArray(sanitized.robotsPolicy.bots) ? sanitized.robotsPolicy.bots : [],
          contentSignals: sanitized.robotsPolicy.contentSignals ?? null,
        }
      : null,
    robotsTxt: sanitized.robotsTxt ?? null,
    stack: sanitized.stack ?? null,
    waf: sanitized.waf ?? null,
    summary: sanitized.summary ?? null,
    siteFindings: Array.isArray(sanitized.siteFindings) ? sanitized.siteFindings : [],
    findings: Array.isArray(sanitized.findings) ? sanitized.findings : [],
    pages: Array.isArray(sanitized.pages)
      ? sanitized.pages.map((/** @type {Record<string, any>} */ p) => ({
          url: p?.url ?? null,
          finalUrl: p?.finalUrl ?? null,
          template: p?.template ?? null,
          isHomepage: Boolean(p?.isHomepage),
          status: p?.status ?? null,
          visibleWordCount: p?.visibleWordCount ?? p?.payload?.visibleWordCount ?? null,
          renderedWordCount: p?.renderedWordCount ?? null,
          proseParityPct: p?.proseParityPct ?? null,
          payloadToProseRatio: p?.payloadToProseRatio ?? null,
          title: p?.title ?? null,
          soft404: Boolean(p?.soft404),
          wafState: p?.wafState ?? null,
          stack: Array.isArray(p?.stack) ? p.stack : [],
          findings: Array.isArray(p?.findings) ? p.findings : [],
        }))
      : undefined,
    skipped: Array.isArray(sanitized.skipped) ? sanitized.skipped.slice(0, 100) : [],
    errored: Array.isArray(sanitized.errored) ? sanitized.errored.slice(0, 100) : [],
    _storageTruncated: true,
  };

  json = JSON.stringify(compact);
  if (Buffer.byteLength(json, 'utf8') <= MAX_REPORT_JSON_BYTES) return json;

  // Stage 3: absolute safety cap if findings/pages themselves exceed 2 MiB
  return JSON.stringify({
    ...compact,
    pages: Array.isArray(compact.pages) ? compact.pages.slice(0, 100) : undefined,
    findings: compact.findings.slice(0, 200),
    siteFindings: compact.siteFindings.slice(0, 100),
    _storageTruncated: true,
  });
}

/**
 * Map a raw SQLite row (without `report_json`) into a `SiteCheckSummary`.
 * @param {Record<string, unknown>} row
 * @returns {SiteCheckSummary}
 */
function mapSummaryRow(row) {
  /** @type {string[]} */
  let stack = [];
  if (typeof row.stack_json === 'string' && row.stack_json.trim() !== '') {
    try {
      const parsed = JSON.parse(row.stack_json);
      if (Array.isArray(parsed)) {
        stack = parsed.filter((/** @type {unknown} */ item) => typeof item === 'string');
      }
    } catch {
      stack = [];
    }
  }
  return {
    id: Number(row.id),
    url: String(row.url ?? ''),
    domain: String(row.domain ?? ''),
    mode: String(row.mode ?? 'crawl'),
    status: String(row.status ?? ''),
    criticalCount: Number(row.critical_count ?? 0),
    warningCount: Number(row.warning_count ?? 0),
    auditedCount: Number(row.audited_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    erroredCount: Number(row.errored_count ?? 0),
    proseParityPct: typeof row.prose_parity_pct === 'number' ? row.prose_parity_pct : null,
    medianPayloadRatio: typeof row.median_payload_ratio === 'number' ? row.median_payload_ratio : null,
    contentHash: String(row.content_hash ?? ''),
    stack,
    wafState: typeof row.waf_state === 'string' ? row.waf_state : null,
    createdAt: String(row.created_at ?? ''),
  };
}

/**
 * Persist a site-check report into `site_checks` and return its lightweight summary.
 *
 * @param {Db} db
 * @param {Record<string, any>} report
 * @returns {SiteCheckSummary}
 */
export function saveSiteCheck(db, report) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('report must be a non-null object');
  }
  ensureSiteChecksTable(db);

  const url = extractUrl(report);
  if (!url) {
    throw new RangeError('Site check report must include a non-empty url, requestedUrl, or finalUrl');
  }

  const domain = extractDomain(report, url);
  const mode = extractMode(report);
  const canonicalFindings = collectCanonicalFindings(report);

  const criticalCount =
    typeof report.summary?.criticalCount === 'number' && Number.isFinite(report.summary.criticalCount)
      ? Math.max(0, Math.floor(report.summary.criticalCount))
      : canonicalFindings.filter((f) => f.severity === 'critical').length;

  const warningCount =
    typeof report.summary?.warningCount === 'number' && Number.isFinite(report.summary.warningCount)
      ? Math.max(0, Math.floor(report.summary.warningCount))
      : canonicalFindings.filter((f) => f.severity === 'warning' || f.severity === 'attention').length;

  const auditedCount =
    typeof report.counts?.audited === 'number' && Number.isFinite(report.counts.audited)
      ? Math.max(0, Math.floor(report.counts.audited))
      : Array.isArray(report.pages)
        ? report.pages.filter((/** @type {Record<string, any>} */ p) => typeof p?.status === 'number' && p.status > 0).length
        : typeof report.status === 'number' && report.status > 0
          ? 1
          : 0;

  const skippedCount =
    typeof report.counts?.skipped === 'number' && Number.isFinite(report.counts.skipped)
      ? Math.max(0, Math.floor(report.counts.skipped))
      : Array.isArray(report.skipped)
        ? report.skipped.length
        : 0;

  const erroredCount =
    typeof report.counts?.errored === 'number' && Number.isFinite(report.counts.errored)
      ? Math.max(0, Math.floor(report.counts.errored))
      : Array.isArray(report.errored)
        ? report.errored.length
        : 0;

  const status = String(
    (typeof report.crawlStatus === 'string' && report.crawlStatus.trim() ? report.crawlStatus.trim() : null) ??
      (typeof report.status === 'string' && report.status.trim() ? report.status.trim() : null) ??
      (report.hardGate?.triggered ? 'blocked_hard_gate' : null) ??
      (typeof report.summary?.crawlStatus === 'string' && report.summary.crawlStatus.trim()
        ? report.summary.crawlStatus.trim()
        : null) ??
      (typeof report.summary?.grade === 'string' && report.summary.grade.trim() ? report.summary.grade.trim() : null) ??
      (criticalCount > 0 ? 'critical' : warningCount > 0 ? 'attention' : 'pass'),
  );

  const proseParityPct = extractProseParityPct(report);
  const medianPayloadRatio = extractMedianPayloadRatio(report);
  const stack = extractStackNames(report);
  const wafState = extractWafState(report);
  const contentHash = computeContentHash(report, url, status, canonicalFindings);
  const reportJson = serializeReportCapped(report);
  const createdAt = normalizeCreatedAt(report.checkedAt ?? report.crawledAt);

  const result = run(
    db,
    `INSERT INTO site_checks(
       url, domain, mode, status,
       critical_count, warning_count, audited_count, skipped_count, errored_count,
       prose_parity_pct, median_payload_ratio, content_hash,
       stack_json, waf_state, report_json, created_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      url,
      domain,
      mode,
      status,
      criticalCount,
      warningCount,
      auditedCount,
      skippedCount,
      erroredCount,
      proseParityPct,
      medianPayloadRatio,
      contentHash,
      JSON.stringify(stack),
      wafState,
      reportJson,
      createdAt,
    ],
  );

  return {
    id: result.lastInsertRowid,
    url,
    domain,
    mode,
    status,
    criticalCount,
    warningCount,
    auditedCount,
    skippedCount,
    erroredCount,
    proseParityPct,
    medianPayloadRatio,
    contentHash,
    stack,
    wafState,
    createdAt,
  };
}

/**
 * List recent saved site-check summaries WITHOUT loading `report_json` blobs.
 * Ordered newest first (`created_at DESC, id DESC`).
 *
 * @param {Db} db
 * @param {ListSiteChecksOptions} [options]
 * @returns {SiteCheckSummary[]}
 */
export function listSiteChecks(db, options = {}) {
  if (!hasSiteChecksTable(db)) return [];

  const rawLimit = options.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : DEFAULT_LIST_LIMIT;

  const domain = typeof options.domain === 'string' ? normalizeDomainInput(options.domain) : '';

  const rows = domain
    ? all(
        db,
        `SELECT id, url, domain, mode, status,
                critical_count, warning_count, audited_count, skipped_count, errored_count,
                prose_parity_pct, median_payload_ratio, content_hash,
                stack_json, waf_state, created_at
           FROM site_checks
          WHERE domain = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [domain, limit],
      )
    : all(
        db,
        `SELECT id, url, domain, mode, status,
                critical_count, warning_count, audited_count, skipped_count, errored_count,
                prose_parity_pct, median_payload_ratio, content_hash,
                stack_json, waf_state, created_at
           FROM site_checks
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [limit],
      );

  return rows.map((row) => mapSummaryRow(row));
}

/**
 * Load one saved site check by ID, including its parsed `report` object.
 * Returns `null` if not found or if `id` is invalid.
 *
 * @param {Db} db
 * @param {number} id
 * @returns {SavedSiteCheck|null}
 */
export function getSiteCheck(db, id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) return null;
  if (!hasSiteChecksTable(db)) return null;

  const row = get(
    db,
    `SELECT id, url, domain, mode, status,
            critical_count, warning_count, audited_count, skipped_count, errored_count,
            prose_parity_pct, median_payload_ratio, content_hash,
            stack_json, waf_state, report_json, created_at
       FROM site_checks
      WHERE id = ?`,
    [numId],
  );
  if (!row) return null;

  /** @type {Record<string, any>} */
  let report = {};
  if (typeof row.report_json === 'string' && row.report_json.trim() !== '') {
    try {
      const parsed = JSON.parse(row.report_json);
      if (parsed && typeof parsed === 'object') {
        report = /** @type {Record<string, any>} */ (parsed);
      }
    } catch {
      report = {};
    }
  }

  return {
    ...mapSummaryRow(row),
    report,
  };
}

/**
 * Load two saved site checks and diff `currentId` against `baselineId` via
 * `diffAgainstBaseline(current.report, baseline.report)`.
 * Returns `null` if either saved check is missing.
 *
 * @param {Db} db
 * @param {number} currentId
 * @param {number} baselineId
 * @returns {SavedSiteCheckDiff|null}
 */
export function diffSavedSiteChecks(db, currentId, baselineId) {
  const current = getSiteCheck(db, currentId);
  const baseline = getSiteCheck(db, baselineId);
  if (!current || !baseline) return null;

  const { report: currentReport, ...currentSummary } = current;
  const { report: baselineReport, ...baselineSummary } = baseline;
  const diff = diffAgainstBaseline(currentReport, baselineReport);

  return {
    current: currentSummary,
    baseline: baselineSummary,
    diff,
  };
}
