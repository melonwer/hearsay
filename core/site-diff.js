/**
 * Competitor X-Ray matrix (`--vs`), linear-time baseline regression diff
 * (`--baseline`, with LibreCrawl's 20% word-count noise floor), and
 * CI quality gate (`--fail-on`, exit code `10`, mandatory zero-page guard).
 *
 * Pure Node 22 built-ins only — zero external runtime dependencies.
 */

export const CI_GATE_EXIT_CODE = 10;
export const DEFAULT_WORD_COUNT_NOISE_FLOOR = 0.2;
export const DEFAULT_PROSE_PARITY_DROP_THRESHOLD = 10;

const SEARCH_BOT_NAMES = new Set([
  'oai-searchbot',
  'chatgpt-user',
  'claude-searchbot',
  'claude-user',
  'perplexitybot',
  'perplexity-user',
  'googlebot',
  'bingbot',
  'applebot',
  'duckassistbot',
  'amazonbot',
]);

/**
 * @typedef {Object} BotAllowanceSummary
 * @property {number} allowed
 * @property {number} total
 * @property {number} searchAllowed
 * @property {number} searchTotal
 * @property {string[]} blockedBots
 */

/**
 * @typedef {Object} CompetitorRow
 * @property {string} domain
 * @property {boolean} isTarget
 * @property {string} status
 * @property {number} audited
 * @property {number} skipped
 * @property {number} errored
 * @property {BotAllowanceSummary} aiBotsAllowed
 * @property {number|null} proseParityPct
 * @property {number|null} payloadToProseRatio
 * @property {number|null} rawWordsHomepage
 * @property {number|null} renderedWordsHomepage
 * @property {boolean} markdownNegotiation
 * @property {string|null} contentSignal
 * @property {string[]} stack
 * @property {string} wafState
 * @property {number} criticalCount
 */

/**
 * @typedef {Object} CompetitorDelta
 * @property {string} competitorDomain
 * @property {string} metric
 * @property {unknown} targetValue
 * @property {unknown} competitorValue
 * @property {number|null} diff
 * @property {'target'|'competitor'|'tie'} winner
 * @property {string} summary
 */

/**
 * @typedef {Object} CompetitorComparisonResult
 * @property {CompetitorRow} target
 * @property {CompetitorRow[]} competitors
 * @property {CompetitorRow[]} rows
 * @property {CompetitorDelta[]} deltas
 * @property {CompetitorDelta[]} competitorLeads
 * @property {CompetitorDelta[]} targetLeads
 */

/**
 * @typedef {Object} NormalizedFinding
 * @property {string} ruleId
 * @property {'critical'|'attention'|'warning'|'info'} severity
 * @property {string} url
 * @property {string} title
 * @property {string} detail
 */

/**
 * @typedef {Object} BaselineDiffOptions
 * @property {number} [wordCountNoiseFloor]
 * @property {number} [proseParityDropThreshold]
 */

/**
 * @typedef {Object} BaselineDiffResult
 * @property {boolean} hasRegression
 * @property {number} wordCountNoiseFloor
 * @property {number} ignoredWordCountNoise
 * @property {NormalizedFinding[]} newCriticalFindings
 * @property {NormalizedFinding[]} newFindings
 * @property {NormalizedFinding[]} resolvedFindings
 * @property {Array<{url: string, baselineStatus: number|null, currentStatus: number|null}>} statusRegressions
 * @property {Array<{url: string, baselineProseParityPct: number, currentProseParityPct: number, dropPct: number}>} proseParityDrops
 * @property {Array<{bot: string, rule: string|null, matchedGroup: string|null}>} newlyBlockedBots
 * @property {Array<{url: string, status: number|null, title: string|null}>} newSoft404s
 * @property {Array<{url: string, baselineWords: number, currentWords: number, delta: number, changePct: number, direction: 'drop'|'increase'}>} wordCountChanges
 * @property {string[]} addedUrls
 * @property {string[]} removedUrls
 * @property {boolean} hardGateNewlyTriggered
 */

/**
 * @typedef {Object} CiGateOptions
 * @property {null|'critical'|'attention'|'warning'} [failOn]
 * @property {string[]} [failOnCodes]
 * @property {string[]} [ignoreCodes]
 * @property {BaselineDiffResult|null} [baselineDiff]
 * @property {boolean} [failOnRegression]
 */

/**
 * @typedef {Object} CiGateResult
 * @property {boolean} passed
 * @property {0|10} exitCode
 * @property {string[]} reasons
 * @property {NormalizedFinding[]} matchedFindings
 * @property {number} ignoredCount
 * @property {string[]} warnings
 */

/**
 * Normalize URL string for O(N) Map indexing across crawls.
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeUrlKey(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }
    return parsed.href;
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Compute median of a finite numeric array, or null when empty.
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  const val = nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return Number(val.toFixed(2));
}

/**
 * Extract normalized domain string from a crawl/report object.
 * @param {Record<string, any>} crawl
 * @returns {string}
 */
function extractDomain(crawl) {
  if (typeof crawl?.domain === 'string' && crawl.domain.trim()) {
    return crawl.domain.trim().toLowerCase();
  }
  const candidate =
    crawl?.finalUrl ??
    crawl?.requestedUrl ??
    crawl?.pages?.[0]?.finalUrl ??
    crawl?.pages?.[0]?.url ??
    '';
  if (typeof candidate === 'string' && candidate) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      return candidate.toLowerCase();
    }
  }
  return 'unknown';
}

/**
 * Extract all page-like entries from either a multi-page crawl or a single-page report.
 * @param {Record<string, any>|null|undefined} report
 * @returns {Array<Record<string, any>>}
 */
function extractPages(report) {
  if (!report || typeof report !== 'object') return [];
  if (Array.isArray(report.pages)) return report.pages;
  if (typeof report.finalUrl === 'string' || typeof report.requestedUrl === 'string') {
    return [
      {
        url: report.requestedUrl ?? report.finalUrl,
        finalUrl: report.finalUrl ?? report.requestedUrl,
        isHomepage: true,
        status: report.status ?? null,
        visibleWordCount: report.payload?.visibleWordCount ?? report.visibleWordCount ?? null,
        renderedWordCount: report.browserDiff?.renderedWordCount ?? report.renderedWordCount ?? null,
        proseParityPct: report.proseParityPct ?? null,
        payloadToProseRatio: report.payloadToProseRatio ?? null,
        htmlBytes: report.payload?.htmlBytes ?? report.htmlBytes ?? null,
        payload: report.payload ?? null,
        soft404: report.soft404 === true,
        wafState: report.wafState ?? 'none',
        markdownNegotiation: report.markdownNegotiation === true,
        contentSignal: report.contentSignal ?? null,
        stack: Array.isArray(report.stack) ? report.stack : [],
        findings: Array.isArray(report.findings) ? report.findings : [],
      },
    ];
  }
  return [];
}

/**
 * Collect deduplicated findings across site-level and per-page arrays.
 * @param {Record<string, any>|null|undefined} report
 * @returns {NormalizedFinding[]}
 */
function collectAllFindings(report) {
  if (!report || typeof report !== 'object') return [];
  /** @type {NormalizedFinding[]} */
  const list = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {Record<string, any>} raw
   * @param {string} url
   */
  const pushFinding = (raw, url) => {
    if (!raw || typeof raw !== 'object') return;
    const ruleId = String(raw.ruleId ?? raw.id ?? '').trim();
    if (!ruleId) return;
    const sevRaw = String(raw.severity ?? 'info').toLowerCase();
    /** @type {'critical'|'attention'|'warning'|'info'} */
    const severity =
      sevRaw === 'critical'
        ? 'critical'
        : sevRaw === 'attention'
          ? 'attention'
          : sevRaw === 'warning'
            ? 'warning'
            : 'info';
    const key = `${ruleId.toLowerCase()}::${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      ruleId,
      severity,
      url,
      title: String(raw.title ?? raw.summary ?? ruleId),
      detail: String(raw.detail ?? raw.title ?? ''),
    });
  };

  if (Array.isArray(report.siteFindings)) {
    for (const f of report.siteFindings) pushFinding(f, 'site');
  }
  if (Array.isArray(report.findings)) {
    const scopeUrl = typeof report.finalUrl === 'string' ? normalizeUrlKey(report.finalUrl) : 'site';
    for (const f of report.findings) pushFinding(f, scopeUrl || 'site');
  }
  if (Array.isArray(report.pages)) {
    for (const page of report.pages) {
      const pageUrl = normalizeUrlKey(page?.finalUrl ?? page?.url ?? '') || 'page';
      if (Array.isArray(page?.findings)) {
        for (const f of page.findings) pushFinding(f, pageUrl);
      }
    }
  }
  return list;
}

/**
 * Compute prose parity percentage for a page (0..100), or null if unavailable.
 * @param {Record<string, any>} page
 * @returns {number|null}
 */
function getPageProseParityPct(page) {
  if (typeof page?.proseParityPct === 'number' && Number.isFinite(page.proseParityPct)) {
    return Number(page.proseParityPct.toFixed(1));
  }
  const rawWords =
    typeof page?.visibleWordCount === 'number'
      ? page.visibleWordCount
      : typeof page?.rawWords === 'number'
        ? page.rawWords
        : typeof page?.payload?.visibleWordCount === 'number'
          ? page.payload.visibleWordCount
          : null;
  const renderedWords =
    typeof page?.renderedWordCount === 'number'
      ? page.renderedWordCount
      : typeof page?.browserDiff?.renderedWordCount === 'number'
        ? page.browserDiff.renderedWordCount
        : null;
  if (rawWords !== null && renderedWords !== null && renderedWords > 0) {
    return Number(Math.min(100, (rawWords / renderedWords) * 100).toFixed(1));
  }
  return null;
}

/**
 * Compute payload-to-prose ratio for a page, or null if unavailable.
 * @param {Record<string, any>} page
 * @returns {number|null}
 */
function getPagePayloadToProseRatio(page) {
  if (typeof page?.payloadToProseRatio === 'number' && Number.isFinite(page.payloadToProseRatio)) {
    return Number(page.payloadToProseRatio.toFixed(2));
  }
  const htmlBytes =
    typeof page?.htmlBytes === 'number'
      ? page.htmlBytes
      : typeof page?.payload?.htmlBytes === 'number'
        ? page.payload.htmlBytes
        : null;
  const proseBytes =
    typeof page?.payload?.visibleTextBytes === 'number'
      ? page.payload.visibleTextBytes
      : typeof page?.visibleTextBytes === 'number'
        ? page.visibleTextBytes
        : null;
  if (htmlBytes !== null && proseBytes !== null && proseBytes > 0) {
    return Number((htmlBytes / proseBytes).toFixed(2));
  }
  return null;
}

/**
 * Extract raw word count for a page.
 * @param {Record<string, any>} page
 * @returns {number|null}
 */
function getPageRawWords(page) {
  if (typeof page?.visibleWordCount === 'number' && Number.isFinite(page.visibleWordCount)) {
    return page.visibleWordCount;
  }
  if (typeof page?.rawWords === 'number' && Number.isFinite(page.rawWords)) {
    return page.rawWords;
  }
  if (typeof page?.payload?.visibleWordCount === 'number' && Number.isFinite(page.payload.visibleWordCount)) {
    return page.payload.visibleWordCount;
  }
  return null;
}

/**
 * Extract AI bot allowance summary from a crawl report.
 * @param {Record<string, any>} crawl
 * @returns {BotAllowanceSummary}
 */
function extractBotSummary(crawl) {
  if (
    crawl?.aiBotsAllowed &&
    typeof crawl.aiBotsAllowed === 'object' &&
    typeof crawl.aiBotsAllowed.allowed === 'number' &&
    typeof crawl.aiBotsAllowed.total === 'number'
  ) {
    return {
      allowed: crawl.aiBotsAllowed.allowed,
      total: crawl.aiBotsAllowed.total,
      searchAllowed:
        typeof crawl.aiBotsAllowed.searchAllowed === 'number'
          ? crawl.aiBotsAllowed.searchAllowed
          : crawl.aiBotsAllowed.allowed,
      searchTotal:
        typeof crawl.aiBotsAllowed.searchTotal === 'number'
          ? crawl.aiBotsAllowed.searchTotal
          : crawl.aiBotsAllowed.total,
      blockedBots: Array.isArray(crawl.aiBotsAllowed.blockedBots) ? [...crawl.aiBotsAllowed.blockedBots] : [],
    };
  }

  const crawlers = Array.isArray(crawl?.robotsTxt?.crawlers) ? crawl.robotsTxt.crawlers : [];
  let allowed = 0;
  let searchAllowed = 0;
  let searchTotal = 0;
  /** @type {string[]} */
  const blockedBots = [];

  for (const c of crawlers) {
    const botName = String(c?.bot ?? '');
    const isAllowed = Boolean(c?.allowed);
    if (isAllowed) allowed += 1;
    else if (botName) blockedBots.push(botName);

    if (SEARCH_BOT_NAMES.has(botName.toLowerCase())) {
      searchTotal += 1;
      if (isAllowed) searchAllowed += 1;
    }
  }

  return {
    allowed,
    total: crawlers.length,
    searchAllowed,
    searchTotal,
    blockedBots,
  };
}

/**
 * Build a structured row for one site in the `--vs` Competitor X-Ray matrix.
 * @param {Record<string, any>} crawl
 * @param {boolean} isTarget
 * @returns {CompetitorRow}
 */
function buildCompetitorRow(crawl, isTarget) {
  const pages = extractPages(crawl);
  const homepage = pages.find((p) => p?.isHomepage === true) ?? pages[0] ?? null;
  const findings = collectAllFindings(crawl);

  const audited =
    typeof crawl?.counts?.audited === 'number'
      ? crawl.counts.audited
      : pages.filter((p) => typeof p?.status === 'number' && p.status > 0).length;
  const skipped =
    typeof crawl?.counts?.skipped === 'number'
      ? crawl.counts.skipped
      : Array.isArray(crawl?.skipped)
        ? crawl.skipped.length
        : 0;
  const errored =
    typeof crawl?.counts?.errored === 'number'
      ? crawl.counts.errored
      : Array.isArray(crawl?.errored)
        ? crawl.errored.length
        : 0;

  const parityValues = pages
    .map((p) => getPageProseParityPct(p))
    .filter((v) => v !== null);
  const proseParityPct =
    typeof crawl?.proseParityPct === 'number' && Number.isFinite(crawl.proseParityPct)
      ? Number(crawl.proseParityPct.toFixed(1))
      : median(/** @type {number[]} */ (parityValues));

  const ratioValues = pages
    .map((p) => getPagePayloadToProseRatio(p))
    .filter((v) => v !== null);
  const payloadToProseRatio =
    typeof crawl?.payloadToProseRatio === 'number' && Number.isFinite(crawl.payloadToProseRatio)
      ? Number(crawl.payloadToProseRatio.toFixed(2))
      : median(/** @type {number[]} */ (ratioValues));

  const rawWordsHomepage =
    typeof crawl?.rawWordsHomepage === 'number'
      ? crawl.rawWordsHomepage
      : homepage
        ? getPageRawWords(homepage)
        : null;

  const renderedWordsHomepage =
    typeof crawl?.renderedWordsHomepage === 'number'
      ? crawl.renderedWordsHomepage
      : typeof homepage?.renderedWordCount === 'number'
        ? homepage.renderedWordCount
        : typeof crawl?.browserDiff?.renderedWordCount === 'number'
          ? crawl.browserDiff.renderedWordCount
          : null;

  const markdownNegotiation = Boolean(
    crawl?.markdownNegotiation ?? homepage?.markdownNegotiation ?? false,
  );

  const contentSignal =
    typeof crawl?.contentSignal === 'string'
      ? crawl.contentSignal
      : typeof homepage?.contentSignal === 'string'
        ? homepage.contentSignal
        : typeof crawl?.robotsTxt?.contentSignal === 'string'
          ? crawl.robotsTxt.contentSignal
          : null;

  /** @type {Set<string>} */
  const stackSet = new Set();
  for (const src of [crawl?.stack, crawl?.tech?.stack, homepage?.stack]) {
    if (Array.isArray(src)) {
      for (const item of src) {
        if (typeof item === 'string' && item.trim()) stackSet.add(item.trim());
      }
    }
  }

  const wafState = String(
    crawl?.wafState ?? homepage?.wafState ?? crawl?.tech?.wafState ?? 'none',
  );

  const criticalCount =
    findings.length > 0
      ? findings.filter((f) => f.severity === 'critical').length
      : typeof crawl?.summary?.criticalCount === 'number'
        ? crawl.summary.criticalCount
        : 0;

  const status = String(
    crawl?.status ??
      (crawl?.hardGate?.triggered ? 'blocked_hard_gate' : crawl?.summary?.grade ?? (criticalCount > 0 ? 'critical' : 'pass')),
  );

  return {
    domain: extractDomain(crawl),
    isTarget,
    status,
    audited,
    skipped,
    errored,
    aiBotsAllowed: extractBotSummary(crawl),
    proseParityPct,
    payloadToProseRatio,
    rawWordsHomepage,
    renderedWordsHomepage,
    markdownNegotiation,
    contentSignal,
    stack: [...stackSet],
    wafState,
    criticalCount,
  };
}

/**
 * Produce a structured `--vs` Competitor X-Ray matrix comparing a target site
 * crawl against one or more competitor site crawls, with explicit deltas
 * showing where competitors beat or trail the target site.
 *
 * @param {Record<string, any>} targetCrawl
 * @param {Record<string, any>|Array<Record<string, any>>} competitorCrawls
 * @returns {CompetitorComparisonResult}
 */
export function compareCompetitors(targetCrawl, competitorCrawls) {
  const target = buildCompetitorRow(targetCrawl, true);
  const compArray = Array.isArray(competitorCrawls)
    ? competitorCrawls
    : competitorCrawls
      ? [competitorCrawls]
      : [];
  const competitors = compArray.map((c) => buildCompetitorRow(c, false));

  /** @type {CompetitorDelta[]} */
  const deltas = [];

  for (const comp of competitors) {
    // 1. AI bots allowed (higher is better)
    if (target.aiBotsAllowed.total > 0 || comp.aiBotsAllowed.total > 0) {
      const diff = comp.aiBotsAllowed.allowed - target.aiBotsAllowed.allowed;
      /** @type {'target'|'competitor'|'tie'} */
      const winner = diff > 0 ? 'competitor' : diff < 0 ? 'target' : 'tie';
      deltas.push({
        competitorDomain: comp.domain,
        metric: 'aiBotsAllowed',
        targetValue: `${target.aiBotsAllowed.allowed}/${target.aiBotsAllowed.total}`,
        competitorValue: `${comp.aiBotsAllowed.allowed}/${comp.aiBotsAllowed.total}`,
        diff,
        winner,
        summary:
          winner === 'competitor'
            ? `${comp.domain} allows ${diff} more AI crawler(s) than ${target.domain}`
            : winner === 'target'
              ? `${target.domain} allows ${Math.abs(diff)} more AI crawler(s) than ${comp.domain}`
              : `${target.domain} and ${comp.domain} allow the same number of AI crawlers (${target.aiBotsAllowed.allowed})`,
      });
    }

    // 2. Prose parity % (higher is better)
    if (target.proseParityPct !== null && comp.proseParityPct !== null) {
      const diff = Number((comp.proseParityPct - target.proseParityPct).toFixed(1));
      /** @type {'target'|'competitor'|'tie'} */
      const winner = diff >= 2 ? 'competitor' : diff <= -2 ? 'target' : 'tie';
      deltas.push({
        competitorDomain: comp.domain,
        metric: 'proseParityPct',
        targetValue: target.proseParityPct,
        competitorValue: comp.proseParityPct,
        diff,
        winner,
        summary:
          winner === 'competitor'
            ? `${comp.domain} delivers +${diff}pp higher raw-HTML Prose Parity (${comp.proseParityPct}% vs ${target.proseParityPct}%)`
            : winner === 'target'
              ? `${target.domain} delivers +${Math.abs(diff)}pp higher raw-HTML Prose Parity (${target.proseParityPct}% vs ${comp.proseParityPct}%)`
              : `Prose Parity is tied (~${target.proseParityPct}%)`,
      });
    }

    // 3. Payload-to-prose ratio (lower is better)
    if (target.payloadToProseRatio !== null && comp.payloadToProseRatio !== null) {
      const diff = Number((comp.payloadToProseRatio - target.payloadToProseRatio).toFixed(2));
      /** @type {'target'|'competitor'|'tie'} */
      const winner = diff < -0.5 ? 'competitor' : diff > 0.5 ? 'target' : 'tie';
      deltas.push({
        competitorDomain: comp.domain,
        metric: 'payloadToProseRatio',
        targetValue: target.payloadToProseRatio,
        competitorValue: comp.payloadToProseRatio,
        diff,
        winner,
        summary:
          winner === 'competitor'
            ? `${comp.domain} has leaner HTML payload-to-prose (${comp.payloadToProseRatio}x vs ${target.payloadToProseRatio}x)`
            : winner === 'target'
              ? `${target.domain} has leaner HTML payload-to-prose (${target.payloadToProseRatio}x vs ${comp.payloadToProseRatio}x)`
              : `Payload-to-prose ratio is comparable (${target.payloadToProseRatio}x vs ${comp.payloadToProseRatio}x)`,
      });
    }

    // 4. Homepage raw visible words (higher is better, 20% noise floor)
    if (target.rawWordsHomepage !== null && comp.rawWordsHomepage !== null) {
      const diff = comp.rawWordsHomepage - target.rawWordsHomepage;
      const denom = Math.max(target.rawWordsHomepage, comp.rawWordsHomepage, 1);
      const relDiff = Math.abs(diff) / denom;
      /** @type {'target'|'competitor'|'tie'} */
      const winner = relDiff < DEFAULT_WORD_COUNT_NOISE_FLOOR ? 'tie' : diff > 0 ? 'competitor' : 'target';
      deltas.push({
        competitorDomain: comp.domain,
        metric: 'rawWordsHomepage',
        targetValue: target.rawWordsHomepage,
        competitorValue: comp.rawWordsHomepage,
        diff,
        winner,
        summary:
          winner === 'competitor'
            ? `${comp.domain} exposes ${comp.rawWordsHomepage} raw homepage words vs ${target.rawWordsHomepage}`
            : winner === 'target'
              ? `${target.domain} exposes ${target.rawWordsHomepage} raw homepage words vs ${comp.rawWordsHomepage}`
              : `Homepage raw word counts are within 20% (${target.rawWordsHomepage} vs ${comp.rawWordsHomepage})`,
      });
    }

    // 5. Markdown negotiation (Accept: text/markdown)
    if (target.markdownNegotiation !== comp.markdownNegotiation) {
      /** @type {'target'|'competitor'} */
      const winner = comp.markdownNegotiation ? 'competitor' : 'target';
      deltas.push({
        competitorDomain: comp.domain,
        metric: 'markdownNegotiation',
        targetValue: target.markdownNegotiation,
        competitorValue: comp.markdownNegotiation,
        diff: comp.markdownNegotiation ? 1 : -1,
        winner,
        summary:
          winner === 'competitor'
            ? `${comp.domain} supports Accept: text/markdown negotiation while ${target.domain} does not`
            : `${target.domain} supports Accept: text/markdown negotiation while ${comp.domain} does not`,
      });
    }

    // 6. WAF accessibility (unblocked beats challenge_or_block_intercepted)
    const targetBlocked = target.wafState === 'challenge_or_block_intercepted';
    const compBlocked = comp.wafState === 'challenge_or_block_intercepted';
    if (targetBlocked !== compBlocked) {
      /** @type {'target'|'competitor'} */
      const winner = targetBlocked ? 'competitor' : 'target';
      deltas.push({
        competitorDomain: comp.domain,
        metric: 'wafState',
        targetValue: target.wafState,
        competitorValue: comp.wafState,
        diff: targetBlocked ? 1 : -1,
        winner,
        summary:
          winner === 'competitor'
            ? `${comp.domain} is accessible (${comp.wafState}) while ${target.domain} triggers an active WAF challenge`
            : `${target.domain} is accessible (${target.wafState}) while ${comp.domain} triggers an active WAF challenge`,
      });
    }

    // 7. Critical findings count (lower is better)
    const critDiff = comp.criticalCount - target.criticalCount;
    /** @type {'target'|'competitor'|'tie'} */
    const critWinner = critDiff < 0 ? 'competitor' : critDiff > 0 ? 'target' : 'tie';
    deltas.push({
      competitorDomain: comp.domain,
      metric: 'criticalCount',
      targetValue: target.criticalCount,
      competitorValue: comp.criticalCount,
      diff: critDiff,
      winner: critWinner,
      summary:
        critWinner === 'competitor'
          ? `${comp.domain} has fewer critical issues (${comp.criticalCount} vs ${target.criticalCount})`
          : critWinner === 'target'
            ? `${target.domain} has fewer critical issues (${target.criticalCount} vs ${comp.criticalCount})`
            : `Both sites have ${target.criticalCount} critical issue(s)`,
    });
  }

  return {
    target,
    competitors,
    rows: [target, ...competitors],
    deltas,
    competitorLeads: deltas.filter((d) => d.winner === 'competitor'),
    targetLeads: deltas.filter((d) => d.winner === 'target'),
  };
}

/**
 * Classify HTTP status severity tier (0 = best 2xx, 4 = worst transport/null).
 * @param {number|null|undefined} status
 * @returns {number}
 */
function statusTier(status) {
  if (typeof status !== 'number' || !Number.isFinite(status) || status <= 0) return 4;
  if (status >= 200 && status < 300) return 0;
  if (status >= 300 && status < 400) return 1;
  if (status >= 400 && status < 500) return 2;
  return 3;
}

/**
 * Check whether a page entry indicates a soft-404.
 * @param {Record<string, any>} page
 * @returns {boolean}
 */
function isPageSoft404(page) {
  if (!page || typeof page !== 'object') return false;
  if (page.soft404 === true) return true;
  if (Array.isArray(page.findings)) {
    return page.findings.some((f) => {
      const id = String(f?.ruleId ?? f?.id ?? '').toLowerCase();
      return id.includes('soft_404') || id.includes('soft404');
    });
  }
  return false;
}

/**
 * Linear-time `O(N)` URL-indexed diff between a current crawl report and a
 * baseline report, applying LibreCrawl's 20% word-count noise floor to prevent
 * false alarms from minor copy/timestamp changes.
 *
 * @param {Record<string, any>} currentReport
 * @param {Record<string, any>} baselineReport
 * @param {BaselineDiffOptions} [options]
 * @returns {BaselineDiffResult}
 */
export function diffAgainstBaseline(currentReport, baselineReport, options = {}) {
  const wordCountNoiseFloor =
    typeof options.wordCountNoiseFloor === 'number' &&
    Number.isFinite(options.wordCountNoiseFloor) &&
    options.wordCountNoiseFloor >= 0
      ? options.wordCountNoiseFloor
      : DEFAULT_WORD_COUNT_NOISE_FLOOR;
  const proseParityDropThreshold =
    typeof options.proseParityDropThreshold === 'number' &&
    Number.isFinite(options.proseParityDropThreshold) &&
    options.proseParityDropThreshold > 0
      ? options.proseParityDropThreshold
      : DEFAULT_PROSE_PARITY_DROP_THRESHOLD;

  const currentPages = extractPages(currentReport);
  const baselinePages = extractPages(baselineReport);

  /** @type {Map<string, Record<string, any>>} */
  const currentByUrl = new Map();
  for (const page of currentPages) {
    const key = normalizeUrlKey(page?.finalUrl ?? page?.url ?? '');
    if (key && !currentByUrl.has(key)) currentByUrl.set(key, page);
  }

  /** @type {Map<string, Record<string, any>>} */
  const baselineByUrl = new Map();
  for (const page of baselinePages) {
    const key = normalizeUrlKey(page?.finalUrl ?? page?.url ?? '');
    if (key && !baselineByUrl.has(key)) baselineByUrl.set(key, page);
  }

  /** @type {string[]} */
  const addedUrls = [];
  /** @type {string[]} */
  const removedUrls = [];
  /** @type {Array<{url: string, baselineStatus: number|null, currentStatus: number|null}>} */
  const statusRegressions = [];
  /** @type {Array<{url: string, baselineProseParityPct: number, currentProseParityPct: number, dropPct: number}>} */
  const proseParityDrops = [];
  /** @type {Array<{url: string, status: number|null, title: string|null}>} */
  const newSoft404s = [];
  /** @type {Array<{url: string, baselineWords: number, currentWords: number, delta: number, changePct: number, direction: 'drop'|'increase'}>} */
  const wordCountChanges = [];
  let ignoredWordCountNoise = 0;

  // O(N) pass over current pages
  for (const [url, curPage] of currentByUrl.entries()) {
    const basePage = baselineByUrl.get(url);

    // Track new soft-404s on both matched and newly added pages
    if (isPageSoft404(curPage) && (!basePage || !isPageSoft404(basePage))) {
      newSoft404s.push({
        url,
        status: typeof curPage.status === 'number' ? curPage.status : null,
        title: typeof curPage.title === 'string' ? curPage.title : curPage.payload?.meta?.title ?? null,
      });
    }

    if (!basePage) {
      addedUrls.push(url);
      continue; // Anti-duplication rule: added URLs don't emit per-URL status/word diffs
    }

    // HTTP status regression check
    const baseStatus = typeof basePage.status === 'number' ? basePage.status : null;
    const curStatus = typeof curPage.status === 'number' ? curPage.status : null;
    if (statusTier(curStatus) > statusTier(baseStatus)) {
      statusRegressions.push({
        url,
        baselineStatus: baseStatus,
        currentStatus: curStatus,
      });
    }

    // Prose parity drop check
    const baseParity = getPageProseParityPct(basePage);
    const curParity = getPageProseParityPct(curPage);
    if (baseParity !== null && curParity !== null) {
      const drop = Number((baseParity - curParity).toFixed(1));
      if (drop >= proseParityDropThreshold || (baseParity >= 50 && curParity < 50)) {
        proseParityDrops.push({
          url,
          baselineProseParityPct: baseParity,
          currentProseParityPct: curParity,
          dropPct: drop,
        });
      }
    }

    // Word count change check with LibreCrawl's 20% noise floor
    const baseWords = getPageRawWords(basePage);
    const curWords = getPageRawWords(curPage);
    if (baseWords !== null && curWords !== null && baseWords !== curWords) {
      const delta = curWords - baseWords;
      const ratio = baseWords > 0 ? Math.abs(delta) / baseWords : 1;
      if (ratio < wordCountNoiseFloor) {
        ignoredWordCountNoise += 1;
      } else {
        const changePct = baseWords > 0 ? Number(((delta / baseWords) * 100).toFixed(1)) : 100;
        wordCountChanges.push({
          url,
          baselineWords: baseWords,
          currentWords: curWords,
          delta,
          changePct,
          direction: delta < 0 ? 'drop' : 'increase',
        });
      }
    }
  }

  // O(N) pass over baseline pages for removed URLs
  for (const url of baselineByUrl.keys()) {
    if (!currentByUrl.has(url)) {
      removedUrls.push(url);
    }
  }

  // Report-level proseParityPct fallback if page-level parity wasn't present
  if (
    proseParityDrops.length === 0 &&
    typeof baselineReport?.proseParityPct === 'number' &&
    typeof currentReport?.proseParityPct === 'number'
  ) {
    const drop = Number((baselineReport.proseParityPct - currentReport.proseParityPct).toFixed(1));
    if (drop >= proseParityDropThreshold || (baselineReport.proseParityPct >= 50 && currentReport.proseParityPct < 50)) {
      proseParityDrops.push({
        url: normalizeUrlKey(currentReport?.finalUrl ?? currentReport?.requestedUrl ?? 'site') || 'site',
        baselineProseParityPct: baselineReport.proseParityPct,
        currentProseParityPct: currentReport.proseParityPct,
        dropPct: drop,
      });
    }
  }

  // Newly blocked AI / search bots diff
  /** @type {Map<string, boolean>} */
  const baselineBots = new Map();
  if (Array.isArray(baselineReport?.robotsTxt?.crawlers)) {
    for (const c of baselineReport.robotsTxt.crawlers) {
      const name = String(c?.bot ?? '').trim();
      if (name) baselineBots.set(name.toLowerCase(), Boolean(c.allowed));
    }
  }

  /** @type {Array<{bot: string, rule: string|null, matchedGroup: string|null}>} */
  const newlyBlockedBots = [];
  if (Array.isArray(currentReport?.robotsTxt?.crawlers)) {
    for (const c of currentReport.robotsTxt.crawlers) {
      const name = String(c?.bot ?? '').trim();
      if (!name) continue;
      const wasAllowed = baselineBots.get(name.toLowerCase());
      if (wasAllowed === true && c.allowed === false) {
        newlyBlockedBots.push({
          bot: name,
          rule: typeof c.rule === 'string' ? c.rule : null,
          matchedGroup: typeof c.matchedGroup === 'string' ? c.matchedGroup : null,
        });
      }
    }
  }

  // Findings diff (O(N) keyed by ruleId::url; anti-duplication excludes added/removed URL churn for non-critical,
  // while always surfacing new critical findings!)
  const currentFindings = collectAllFindings(currentReport);
  const baselineFindings = collectAllFindings(baselineReport);

  /** @type {Map<string, NormalizedFinding>} */
  const baselineFindingMap = new Map();
  for (const f of baselineFindings) {
    baselineFindingMap.set(`${f.ruleId.toLowerCase()}::${f.url}`, f);
  }
  /** @type {Map<string, NormalizedFinding>} */
  const currentFindingMap = new Map();
  for (const f of currentFindings) {
    currentFindingMap.set(`${f.ruleId.toLowerCase()}::${f.url}`, f);
  }

  /** @type {NormalizedFinding[]} */
  const newFindings = [];
  /** @type {NormalizedFinding[]} */
  const newCriticalFindings = [];
  for (const [key, f] of currentFindingMap.entries()) {
    if (!baselineFindingMap.has(key)) {
      newFindings.push(f);
      if (f.severity === 'critical') {
        newCriticalFindings.push(f);
      }
    }
  }

  /** @type {NormalizedFinding[]} */
  const resolvedFindings = [];
  for (const [key, f] of baselineFindingMap.entries()) {
    if (!currentFindingMap.has(key)) {
      resolvedFindings.push(f);
    }
  }

  const hardGateNewlyTriggered = Boolean(
    currentReport?.hardGate?.triggered === true && baselineReport?.hardGate?.triggered !== true,
  );

  const hasRegression =
    newCriticalFindings.length > 0 ||
    statusRegressions.length > 0 ||
    proseParityDrops.length > 0 ||
    newlyBlockedBots.length > 0 ||
    newSoft404s.length > 0 ||
    hardGateNewlyTriggered;

  return {
    hasRegression,
    wordCountNoiseFloor,
    ignoredWordCountNoise,
    newCriticalFindings,
    newFindings,
    resolvedFindings,
    statusRegressions,
    proseParityDrops,
    newlyBlockedBots,
    newSoft404s,
    wordCountChanges,
    addedUrls,
    removedUrls,
    hardGateNewlyTriggered,
  };
}

/**
 * Evaluate the CI Quality Gate on a site crawl/check report.
 *
 * Rules:
 *  - **Zero-page guard**: If `report.counts.audited === 0` (0 pages returned HTTP status > 0),
 *    ALWAYS fail with exit code `10` (`reason: 'zero_pages_audited'`), even when `failOn` is null.
 *  - `ignoreCodes` takes strict precedence over BOTH `failOnCodes` and `failOn`.
 *  - Returns exit code `0` on pass, `10` on gate failure.
 *
 * @param {Record<string, any>} report
 * @param {CiGateOptions} [options]
 * @returns {CiGateResult}
 */
export function evaluateCiGate(report, options = {}) {
  const failOn = options.failOn ?? null;
  const failOnCodeSet = new Set(
    (Array.isArray(options.failOnCodes) ? options.failOnCodes : [])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean),
  );
  const ignoreCodeSet = new Set(
    (Array.isArray(options.ignoreCodes) ? options.ignoreCodes : [])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean),
  );
  const failOnRegression = options.failOnRegression === true;
  const baselineDiff = options.baselineDiff ?? null;

  /** @type {string[]} */
  const reasons = [];
  /** @type {NormalizedFinding[]} */
  const matchedFindings = [];
  /** @type {Set<string>} */
  const matchedKeys = new Set();
  /** @type {string[]} */
  const warnings = [];
  let ignoredCount = 0;

  // 1. Mandatory Zero-Page Guard (cannot be bypassed by ignoreCodes or failOn: null)
  const auditedCount =
    typeof report?.counts?.audited === 'number'
      ? report.counts.audited
      : Array.isArray(report?.pages)
        ? report.pages.filter((p) => typeof p?.status === 'number' && p.status > 0).length
        : typeof report?.status === 'number' && report.status > 0
          ? 1
          : 0;

  if (auditedCount === 0) {
    reasons.push('zero_pages_audited');
    return {
      passed: false,
      exitCode: CI_GATE_EXIT_CODE,
      reasons,
      matchedFindings,
      ignoredCount,
      warnings,
    };
  }

  // 2. Collect findings and apply ignoreCodes precedence
  const allFindings = collectAllFindings(report);
  /** @type {NormalizedFinding[]} */
  const activeFindings = [];
  for (const f of allFindings) {
    if (ignoreCodeSet.has(f.ruleId.toLowerCase())) {
      ignoredCount += 1;
      continue;
    }
    activeFindings.push(f);
  }

  /** @param {NormalizedFinding} f */
  const recordMatch = (f) => {
    const k = `${f.ruleId.toLowerCase()}::${f.url}`;
    if (!matchedKeys.has(k)) {
      matchedKeys.add(k);
      matchedFindings.push(f);
    }
  };

  // 3. Explicit failOnCodes (non-ignored only)
  if (failOnCodeSet.size > 0) {
    /** @type {Set<string>} */
    const triggeredCodes = new Set();
    for (const f of activeFindings) {
      const code = f.ruleId.toLowerCase();
      if (failOnCodeSet.has(code)) {
        recordMatch(f);
        triggeredCodes.add(code);
      }
    }
    for (const code of triggeredCodes) {
      reasons.push(`fail_on_code:${code}`);
    }
  }

  // 4. Severity threshold failOn ('critical' | 'attention' | 'warning')
  if (failOn === 'critical') {
    const crits = activeFindings.filter((f) => f.severity === 'critical');
    for (const f of crits) recordMatch(f);
    if (crits.length > 0) {
      reasons.push('fail_on_critical');
    }
  } else if (failOn === 'attention' || failOn === 'warning') {
    const severe = activeFindings.filter(
      (f) => f.severity === 'critical' || f.severity === 'attention' || f.severity === 'warning',
    );
    for (const f of severe) recordMatch(f);
    if (severe.length > 0) {
      reasons.push('fail_on_attention');
    }
  }

  // Hard Infrastructure Gate fallback if triggered without explicit finding entry
  if (
    report?.hardGate?.triggered === true &&
    (failOn === 'critical' || failOn === 'attention' || failOn === 'warning') &&
    !ignoreCodeSet.has('hard_infrastructure_gate') &&
    !reasons.includes('fail_on_critical') &&
    !reasons.includes('fail_on_attention')
  ) {
    reasons.push('hard_infrastructure_gate');
  }

  // 5. Baseline regression gate
  if (failOnRegression) {
    if (!baselineDiff) {
      warnings.push('failOnRegression enabled but no baselineDiff was provided.');
    } else if (baselineDiff.hasRegression) {
      const remainingCriticals = baselineDiff.newCriticalFindings.filter(
        (f) => !ignoreCodeSet.has(f.ruleId.toLowerCase()),
      );
      for (const f of remainingCriticals) recordMatch(f);

      const nonCodeRegressions =
        baselineDiff.statusRegressions.length > 0 ||
        baselineDiff.proseParityDrops.length > 0 ||
        baselineDiff.newlyBlockedBots.length > 0 ||
        baselineDiff.newSoft404s.length > 0 ||
        (baselineDiff.hardGateNewlyTriggered && !ignoreCodeSet.has('hard_infrastructure_gate'));

      if (remainingCriticals.length > 0 || nonCodeRegressions) {
        reasons.push('baseline_regression');
      }
    }
  }

  const passed = reasons.length === 0;
  return {
    passed,
    exitCode: passed ? 0 : CI_GATE_EXIT_CODE,
    reasons,
    matchedFindings,
    ignoredCount,
    warnings,
  };
}
