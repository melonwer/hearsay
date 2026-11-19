import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig } from '../core/config.js';
import { SiteCheckError } from '../core/site-check.js';
import { saveSiteCheck } from '../core/site-check-store.js';
import { startServer } from '../server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_JS_PATH = resolve(HERE, '../public/check.js');

/**
 * Boot an isolated Hearsay HTTP server with temp DB and optional DI overrides.
 *
 * @param {import('node:test').TestContext} t
 * @param {Object} [opts]
 * @param {Parameters<typeof startServer>[0]['siteCheck']} [opts.siteCheck]
 * @param {Parameters<typeof startServer>[0]['checkSiteV2Impl']} [opts.checkSiteV2Impl]
 */
async function bootIsolated(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-check-ui-'));
  const envFile = join(dir, '.env');
  const realDbPath = join(dir, 'data/hearsay.db');
  const demoDbPath = join(dir, 'data/demo/hearsay.db');
  mkdirSync(join(dir, 'data'), { recursive: true });

  const mergedEnv = {
    HEARSAY_DB_PATH: realDbPath,
    HEARSAY_DEMO_DB_PATH: demoDbPath,
  };
  const config = buildConfig(mergedEnv);
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    dbPath: config.dbPath,
    portFile: join(dir, 'hearsay.port'),
    envFile,
    env: mergedEnv,
    config,
    siteCheck: opts.siteCheck,
    checkSiteV2Impl: opts.checkSiteV2Impl,
    log: () => {},
  });

  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    app,
    base: `http://127.0.0.1:${app.port}`,
  };
}

/**
 * Parse a complete Server-Sent Events stream body into `{ event, data }[]`.
 * @param {string} raw
 * @returns {Array<{event: string, data: any}>}
 */
function parseSseStream(raw) {
  /** @type {Array<{event: string, data: any}>} */
  const events = [];
  for (const chunk of raw.split(/\n\n+/)) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    let eventName = 'message';
    /** @type {string[]} */
    const dataLines = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) {
      const joined = dataLines.join('\n');
      try {
        events.push({ event: eventName, data: JSON.parse(joined) });
      } catch {
        events.push({ event: eventName, data: joined });
      }
    }
  }
  return events;
}

/**
 * Assert that an HTML document contains zero inline `<script>` bodies and zero inline `on*=` attributes.
 * @param {string} htmlDoc
 */
function assertStrictCspMarkup(htmlDoc) {
  const scriptMatches = [...htmlDoc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scriptMatches.length > 0, 'Expected external module script tags');
  for (const match of scriptMatches) {
    const attrs = match[1] ?? '';
    const inner = (match[2] ?? '').trim();
    assert.match(attrs, /\bsrc="\/public\/[^"]+"/, `Script tag must load from /public/: <script${attrs}>`);
    assert.equal(inner, '', `Inline script body forbidden: ${inner.slice(0, 80)}`);
  }
  for (const tagMatch of htmlDoc.matchAll(/<[a-z][a-z0-9-]*(?:\s+[^>]*)?>/gi)) {
    const withoutQuotedValues = tagMatch[0].replace(/"[^"]*"|'[^']*'/g, '""');
    assert.doesNotMatch(
      withoutQuotedValues,
      /\son[a-z]+\s*=/i,
      `Inline event handler attribute forbidden on tag: ${tagMatch[0].slice(0, 120)}`,
    );
  }
}

test('GET /check renders workbench with strict CSP, zero inline scripts, nav link, and /public/check.js asset', async (t) => {
  const ctx = await bootIsolated(t);

  const res = await fetch(`${ctx.base}/check`);
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  assertStrictCspMarkup(body);
  assert.ok(body.includes('<h1>Site X-Ray</h1>'), 'Heading should render');
  assert.ok(body.includes('href="/check"'), 'Site X-Ray nav link should render');
  assert.ok(body.includes('Site X-Ray'), 'Nav label should render');
  assert.ok(body.includes('src="/public/check.js"'), 'Workbench script should load from /public/check.js');

  // Dual-tier control bar + all 5 tabs
  assert.ok(body.includes('id="xray-form"'));
  assert.ok(body.includes('id="xray-advanced"'));
  assert.ok(body.includes('id="xray-vs"'));
  assert.ok(body.includes('id="xray-browser"'));
  assert.ok(body.includes('id="xray-caching"'));
  assert.ok(body.includes('id="xray-ignore-robots"'));
  assert.ok(body.includes('id="xray-include-auth"'));
  assert.ok(body.includes('data-xray-tab="insights"'));
  assert.ok(body.includes('data-xray-tab="diff"'));
  assert.ok(body.includes('data-xray-tab="bots"'));
  assert.ok(body.includes('data-xray-tab="competitors"'));
  assert.ok(body.includes('data-xray-tab="history"'));

  // Nav link also appears on other pages
  const settingsHtml = await fetch(`${ctx.base}/settings`).then((r) => r.text());
  assert.ok(settingsHtml.includes('href="/check"'), 'Nav link should appear across pages');

  // Static client JS loads cleanly and has zero innerHTML sinks
  const jsRes = await fetch(`${ctx.base}/public/check.js`);
  const jsBody = await jsRes.text();
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type') ?? '', /text\/javascript/);
  const diskJs = readFileSync(CHECK_JS_PATH, 'utf8');
  assert.equal(jsBody, diskJs);
  const codeOnlyJs = diskJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnlyJs, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
});

test('POST /api/check enforces SSRF private-host guard, bounds validation, and CSRF/loopback guards', async (t) => {
  const ctx = await bootIsolated(t);

  // Private/loopback/metadata hosts must be blocked even when request body passes allowPrivateHosts: true
  for (const blockedUrl of [
    'http://127.0.0.1:8080/admin',
    'http://localhost:3000/',
    'http://[::1]:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
  ]) {
    const res = await fetch(`${ctx.base}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify({ url: blockedUrl, allowPrivateHosts: true }),
    });
    const payload = await res.json();
    assert.equal(res.status, 403, `${blockedUrl} must be blocked with 403`);
    assert.equal(payload.error.code, 'ssrf_blocked');
  }

  // Competitor URLs (--vs) also enforce SSRF guard
  const vsPrivate = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ url: 'https://example.com', vs: ['http://127.0.0.1:9000/'] }),
  });
  assert.equal(vsPrivate.status, 403);
  assert.equal((await vsPrivate.json()).error.code, 'ssrf_blocked');

  // Bounds validation: invalid protocol, maxPages > 25, >3 competitors, bad timeout
  const badProto = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ url: 'file:///etc/passwd' }),
  });
  assert.equal(badProto.status, 422);
  assert.equal((await badProto.json()).error.code, 'invalid_url');

  const badPages = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ url: 'https://example.com', maxPages: 26 }),
  });
  assert.equal(badPages.status, 422);

  const tooManyVs = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({
      url: 'https://example.com',
      vs: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'],
    }),
  });
  assert.equal(tooManyVs.status, 422);

  // Cross-origin & proxy-forwarded rejected with 403
  const crossOrigin = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(crossOrigin.status, 403);

  const proxied = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(proxied.status, 403);
});

test('POST /api/check streams SSE progress & completion, persists to SQLite, exports HTML, and diffs saved checks', async (t) => {
  // Ephemeral target site whose robots.txt toggles between run 1 and run 2 to exercise real drift diffing
  let blockPerplexity = false;
  const targetServer = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        blockPerplexity
          ? 'User-agent: GPTBot\nDisallow: /\nUser-agent: PerplexityBot\nDisallow: /\nUser-agent: *\nAllow: /\n'
          : 'User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /\n',
      );
      return;
    }
    if (req.url === '/pricing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>Pricing Plans</title></head>' +
          '<body><h1>Pricing Plans</h1><p>Transparent self-hosted and cloud pricing for engineering and technical SEO teams running continuous AI crawl audits.</p></body></html>',
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Server: 'cloudflare' });
    res.end(
      '<!doctype html><html><head><title>Acme Docs Home</title></head>' +
        '<body><nav><a href="/pricing">Pricing</a><a href="/login">Login</a></nav>' +
        '<h1>Acme Technical Documentation</h1>' +
        '<p>Acme provides deterministic, server-rendered technical documentation built for fast search indexing and clean AI crawler extraction.</p>' +
        '</body></html>',
    );
  });
  await new Promise((resolveListen) => targetServer.listen(0, '127.0.0.1', () => resolveListen(undefined)));
  t.after(() => new Promise((resolveClose) => targetServer.close(() => resolveClose(undefined))));
  const targetPort = /** @type {import('node:net').AddressInfo} */ (targetServer.address()).port;
  const targetUrl = `http://127.0.0.1:${targetPort}/`;

  const ctx = await bootIsolated(t, {
    siteCheck: {
      allowPrivateHosts: true,
      dnsResolver: {
        resolveCname: async () => [],
        resolveNs: async () => [],
        resolveTxt: async () => [],
      },
      sleepFn: async () => {},
    },
  });

  // 1. Async POST /api/check -> 202 { jobId, status: 'running' }
  const startRes = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ url: targetUrl, maxPages: 5, timeoutMs: 5000 }),
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  assert.equal(started.status, 'running');
  assert.equal(typeof started.jobId, 'string');

  // 2. Stream SSE events on GET /api/check/:jobId/stream
  const streamRes = await fetch(`${ctx.base}/api/check/${encodeURIComponent(started.jobId)}/stream`);
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);
  const streamBody = await streamRes.text();
  const events = parseSseStream(streamBody);

  const progressEvents = events.filter((e) => e.event === 'progress');
  const completeEvent = events.find((e) => e.event === 'complete');
  assert.ok(progressEvents.some((e) => e.data?.type === 'started'), 'Should emit started progress event');
  assert.ok(progressEvents.some((e) => e.data?.type === 'page'), 'Should emit page progress event');
  assert.ok(completeEvent, 'Should emit complete event');
  const firstId = completeEvent.data.id;
  assert.equal(typeof firstId, 'number');
  assert.equal(completeEvent.data.summary.auditedCount, 2, 'Homepage + /pricing audited while /login skipped');
  assert.ok(
    completeEvent.data.report.skipped.some((/** @type {any} */ s) => s.reason === 'auth_or_utility_route'),
    '/login should be skipped as auth_or_utility_route',
  );

  // Late subscriber replays buffered complete event cleanly
  const replayRes = await fetch(`${ctx.base}/api/check/${encodeURIComponent(started.jobId)}/stream`);
  assert.equal(replayRes.status, 200);
  const replayEvents = parseSseStream(await replayRes.text());
  assert.ok(replayEvents.some((e) => e.event === 'complete'));

  // Unknown jobId returns 404
  const missingJob = await fetch(`${ctx.base}/api/check/does-not-exist/stream`);
  assert.equal(missingJob.status, 404);

  // 3. Second check via ?sync=1 with PerplexityBot newly blocked -> creates drift!
  blockPerplexity = true;
  const syncRes = await fetch(`${ctx.base}/api/check?sync=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ url: targetUrl, maxPages: 5, timeoutMs: 5000 }),
  });
  assert.equal(syncRes.status, 200);
  const syncData = await syncRes.json();
  const secondId = syncData.id;
  assert.ok(secondId > firstId);

  // 4. GET /api/check/history lists both checks newest first
  const histRes = await fetch(`${ctx.base}/api/check/history?domain=127.0.0.1&limit=10`);
  assert.equal(histRes.status, 200);
  const histData = await histRes.json();
  assert.equal(histData.count, 2);
  assert.equal(histData.items[0].id, secondId);
  assert.equal(histData.items[1].id, firstId);
  assert.equal('report' in histData.items[0], false, 'History summaries must omit heavy report blob');

  // 5. GET /api/check/:id returns full saved report; ?format=html returns printable HTML
  const detailRes = await fetch(`${ctx.base}/api/check/${firstId}`);
  assert.equal(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.equal(detailData.id, firstId);
  assert.equal(detailData.report.schemaVersion, 2);

  const htmlRes = await fetch(`${ctx.base}/api/check/${firstId}?format=html`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get('content-type') ?? '', /text\/html/);
  assert.match(htmlRes.headers.get('content-disposition') ?? '', /attachment; filename="hearsay-site-xray-/);
  assert.match(htmlRes.headers.get('content-security-policy') ?? '', /^default-src 'none';/);
  const exportedHtml = await htmlRes.text();
  assert.ok(exportedHtml.includes('<!doctype html>') || exportedHtml.includes('<!DOCTYPE html>'));
  assert.doesNotMatch(exportedHtml, /<script\b/i, 'Exported HTML report must have zero scripts');

  const missingCheck = await fetch(`${ctx.base}/api/check/99999`);
  assert.equal(missingCheck.status, 404);

  // 6. GET /api/check/diff compares secondId against firstId and catches newly blocked PerplexityBot
  const diffRes = await fetch(`${ctx.base}/api/check/diff?current=${secondId}&baseline=${firstId}`);
  assert.equal(diffRes.status, 200);
  const diffData = await diffRes.json();
  assert.equal(diffData.current.id, secondId);
  assert.equal(diffData.baseline.id, firstId);
  assert.equal(diffData.diff.hasRegression, true);
  assert.ok(
    diffData.diff.newlyBlockedBots.some((/** @type {any} */ b) => b.bot.toLowerCase() === 'perplexitybot'),
    'Diff should detect PerplexityBot newly blocked',
  );

  // Invalid / missing diff query params return 400 / 404 cleanly
  const badDiff = await fetch(`${ctx.base}/api/check/diff?current=abc&baseline=1`);
  assert.equal(badDiff.status, 400);
  const missingDiff = await fetch(`${ctx.base}/api/check/diff?current=9999&baseline=${firstId}`);
  assert.equal(missingDiff.status, 404);
});

test('POST /api/check works with injected checkSiteV2Impl and streams error events cleanly on failure', async (t) => {
  let shouldFail = false;
  /** @type {import('../core/site-check.js').checkSiteV2} */
  const fakeCheckSiteV2 = async (url, options = {}) => {
    options.onProgress?.({ type: 'page', url, finalUrl: url, audited: 1, maxPages: 1, message: `Audited ${url}` });
    options.onProgress?.({ type: 'competitor', url: 'https://rival.example', index: 1, total: 1, message: 'Checked rival.example' });
    if (shouldFail) {
      throw new SiteCheckError('fetch_failed', 'Simulated upstream failure');
    }
    return /** @type {any} */ ({
      schemaVersion: 2,
      checkedAt: '2026-11-19T12:00:00Z',
      requestedUrl: url,
      finalUrl: url,
      domain: new URL(url).hostname,
      mode: 'single',
      status: 200,
      ok: true,
      crawlStatus: 'pass',
      downstreamStatus: 'observed',
      hardGate: { triggered: false, reason: null, detail: null, capStatus: null, downstreamStatus: 'observed' },
      counts: { audited: 1, skipped: 0, errored: 0, skippedByReason: {} },
      payload: {
        htmlBytes: 4200,
        visibleWordCount: 120,
        offsets: { firstH1Bytes: 300 },
        truncationRisks: { contentStartsAfter30KB: false, coreContentPast100KB: false, pageExceeds300KB: false, any: false },
      },
      headers: { cdnDetected: null },
      meta: { title: 'Clean Example' },
      robotsTxt: { crawlers: [], allowedCount: 9, blockedCount: 0 },
      browserDiff: { status: 'skipped' },
      summary: { grade: 'pass', criticalCount: 0, warningCount: 0, infoCount: 0, crawlStatus: 'pass' },
      siteFindings: [],
      findings: [],
      pages: [{ url, finalUrl: url, status: 200, visibleWordCount: 120, findings: [] }],
      skipped: [],
      errored: [],
      disclaimers: [],
    });
  };

  const ctx = await bootIsolated(t, { checkSiteV2Impl: fakeCheckSiteV2 });

  const okStart = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ url: 'https://clean.example', single: true }),
  });
  assert.equal(okStart.status, 202);
  const { jobId } = await okStart.json();
  const okStream = parseSseStream(await fetch(`${ctx.base}/api/check/${jobId}/stream`).then((r) => r.text()));
  assert.ok(okStream.some((e) => e.event === 'progress' && e.data?.type === 'competitor'));
  assert.ok(okStream.some((e) => e.event === 'complete' && e.data?.summary?.domain === 'clean.example'));

  // Failure path emits SSE `event: error` cleanly
  shouldFail = true;
  const errStart = await fetch(`${ctx.base}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ url: 'https://fail.example', single: true }),
  });
  assert.equal(errStart.status, 202);
  const errJob = await errStart.json();
  const errStream = parseSseStream(await fetch(`${ctx.base}/api/check/${errJob.jobId}/stream`).then((r) => r.text()));
  const errEvent = errStream.find((e) => e.event === 'error');
  assert.ok(errEvent, 'Expected SSE error event on failure');
  assert.equal(errEvent.data.code, 'fetch_failed');
  assert.match(errEvent.data.message, /Simulated upstream failure/);
});

test('XSS payloads inside site titles, URLs, and findings are strictly escaped in SSR /check and ?format=html', async (t) => {
  const ctx = await bootIsolated(t);

  const xssTitle = 'Evil Title <script>alert("xss-title")</script>';
  const xssUrl = 'https://xss.example/page?q=<img src=x onerror="alert(2)">';
  const xssFinding = 'Injected <script>alert("xss-finding")</script> & "onclick=alert(3)"';

  const saved = saveSiteCheck(ctx.app.db, {
    schemaVersion: 2,
    checkedAt: '2026-11-19T13:00:00Z',
    requestedUrl: xssUrl,
    finalUrl: xssUrl,
    domain: 'xss.example',
    mode: 'single',
    status: 200,
    ok: true,
    crawlStatus: 'critical',
    downstreamStatus: 'observed',
    hardGate: { triggered: false, reason: null, detail: null, capStatus: null, downstreamStatus: 'observed' },
    scopeSummary: `Scoped <script>alert("xss-scope")</script>`,
    counts: { audited: 1, skipped: 0, errored: 0, skippedByReason: {} },
    redirects: { count: 0, hops: [], finalUrl: xssUrl, loopDetected: false, loopTarget: null, maxHopsExceeded: false, crossHost: false, geoLikely: false },
    headers: { xRobotsTag: null, contentType: 'text/html', cacheControl: null, server: null, cfRay: null, vary: null, cdnDetected: null },
    meta: { title: xssTitle, description: null, robots: null, googlebot: null, canonical: null, canonicalResolved: null, canonicalMatchesFinal: null, noindex: false, nofollow: false, noindexSources: [] },
    robotsTxt: { url: 'https://xss.example/robots.txt', status: 200, fetched: true, error: null, sitemaps: [], crawlers: [], blockedCount: 0, allowedCount: 0 },
    aiBotsAllowed: { allowed: 18, total: 18, searchAllowed: 11, searchTotal: 11, blockedBots: [] },
    payload: {
      htmlBytes: 2048,
      scriptBytes: 0,
      styleBytes: 0,
      scriptRatio: 0,
      styleRatio: 0,
      codeRatio: 0,
      scriptTagCount: 0,
      externalScriptCount: 0,
      hasNoscriptJsWarning: false,
      visibleTextBytes: 512,
      visibleWordCount: 80,
      visibleCharCount: 512,
      headings: [],
      headingCount: 0,
      tableCount: 0,
      jsonLdCount: 0,
      jsonLdTypes: [],
      offsets: { firstH1Bytes: null, firstSubstantiveParagraphBytes: null, text25PctBytes: null, text50PctBytes: null, text75PctBytes: null, text90PctBytes: null },
      truncationRisks: { contentStartsAfter30KB: false, coreContentPast100KB: false, pageExceeds300KB: false, any: false },
      csrRisk: { level: 'low', spaRoots: [], reasons: [] },
      meta: { title: xssTitle, description: null, robots: null, googlebot: null, canonical: null },
    },
    browserDiff: { status: 'skipped' },
    siteFindings: [{ id: 'xss_test', severity: 'critical', category: 'headers', title: xssFinding, detail: xssFinding, scope: 'site' }],
    findings: [{ id: 'xss_test', severity: 'critical', category: 'headers', title: xssFinding, detail: xssFinding, scope: 'site' }],
    clusters: { siteWide: [], templateClusters: [], pageOutliers: [], templateCounts: {} },
    pages: [{ url: xssUrl, finalUrl: xssUrl, template: '/', isHomepage: true, status: 200, title: xssTitle, visibleWordCount: 80, findings: [] }],
    skipped: [],
    errored: [],
    summary: { grade: 'fail', criticalCount: 1, warningCount: 0, infoCount: 0, crawlStatus: 'critical' },
    disclaimers: [],
  });

  // 1. SSR GET /check?id=<id> escapes every XSS payload and keeps strict CSP
  const ssrHtml = await fetch(`${ctx.base}/check?id=${saved.id}`).then((r) => r.text());
  assertStrictCspMarkup(ssrHtml);
  assert.ok(!ssrHtml.includes('<script>alert("xss-title")</script>'), 'SSR must escape site title');
  assert.ok(!ssrHtml.includes('<script>alert("xss-finding")</script>'), 'SSR must escape finding');
  assert.ok(!ssrHtml.includes('<script>alert("xss-scope")</script>'), 'SSR must escape scope summary');
  assert.ok(!ssrHtml.includes('<img src=x onerror='), 'SSR must escape URL payload');
  assert.ok(ssrHtml.includes('&lt;script&gt;alert(&quot;xss-title&quot;)&lt;/script&gt;'));
  assert.ok(ssrHtml.includes('&lt;script&gt;alert(&quot;xss-finding&quot;)&lt;/script&gt;'));

  // 2. Printable export GET /api/check/:id?format=html escapes every XSS payload
  const exportHtml = await fetch(`${ctx.base}/api/check/${saved.id}?format=html`).then((r) => r.text());
  assert.doesNotMatch(exportHtml, /<script\b/i, 'Export HTML must have zero script tags');
  assert.ok(!exportHtml.includes('<img src=x onerror='), 'Export HTML must escape URL payload');
  assert.ok(exportHtml.includes('&lt;script&gt;alert(&quot;xss-finding&quot;)&lt;/script&gt;'));
});
