/**
 * Tests for the zero-key technical pre-flight audit (`core/site-check.js` and
 * `bin/hearsay.js check` / `serve`). Uses only ephemeral local `node:http`
 * servers — zero external network calls, zero external dependencies.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  AI_CRAWLERS,
  USER_AGENT,
  SiteCheckError,
  analyzeHtmlPayload,
  checkSite,
  parseRobotsTxt,
  renderSiteCheckHtml,
  renderSiteCheckText,
} from '../core/site-check.js';

const execFileAsync = promisify(execFile);
const NODE = process.execPath;
const CLI = new URL('../bin/hearsay.js', import.meta.url).pathname;

/**
 * Boot an ephemeral `node:http` server on 127.0.0.1:0 with automatic cleanup.
 * @param {import('node:test').TestContext} t
 * @param {import('node:http').RequestListener} handler
 */
async function startFixtureServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(async () => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return { server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` };
}

test('URL validation & SSRF guard blocks non-HTTP schemes, loopback, private, link-local, DNS rebinding, and redirect SSRF', async (t) => {
  for (const bad of ['', 'not-a-url', 'file:///etc/passwd', 'ftp://example.com/a', 'javascript:alert(1)', 'https://user:pass@example.com/']) {
    await assert.rejects(
      checkSite(bad),
      (err) => err instanceof SiteCheckError && err.code === 'invalid_url',
      `expected invalid_url for ${bad}`,
    );
  }

  const privateTargets = [
    'http://127.0.0.1:8080/',
    'http://localhost:3000/',
    'http://api.localhost/',
    'http://[::1]:8080/',
    'http://[::ffff:127.0.0.1]/',
    'http://10.0.0.5/',
    'http://172.16.4.2/',
    'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://metadata.google.internal/',
    'http://printer.local/',
  ];
  for (const target of privateTargets) {
    await assert.rejects(
      checkSite(target),
      (err) => err instanceof SiteCheckError && err.code === 'ssrf_blocked',
      `expected ssrf_blocked for ${target}`,
    );
  }

  // DNS-resolved private IP blocking
  await assert.rejects(
    checkSite('https://public-alias.example/', {
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      fetch: async () => {
        throw new Error('fetch should not be called after DNS SSRF block');
      },
    }),
    (err) => err instanceof SiteCheckError && err.code === 'ssrf_blocked',
  );

  // Redirect hop SSRF blocking (public URL redirecting to cloud metadata endpoint)
  await assert.rejects(
    checkSite('https://public.example/start', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    }),
    (err) => err instanceof SiteCheckError && err.code === 'ssrf_blocked',
  );

  // Local server succeeds explicitly with allowPrivateHosts: true
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Local</title></head><body><h1>Local</h1><p>' + 'word '.repeat(90) + '</p></body></html>');
  });
  const report = await checkSite(`${baseUrl}/`, { allowPrivateHosts: true });
  assert.equal(report.status, 200);
  assert.equal(report.ok, true);
});

test('parseRobotsTxt implements RFC 9309 specificity, Allow/Disallow longest-match, ties, wildcards, and fallback', () => {
  const robots = [
    '\uFEFF# Global rules',
    'Sitemap: https://example.com/sitemap.xml',
    'User-agent: *',
    'Disallow: /private/',
    'Disallow: /*.pdf$',
    'Allow: /private/public-guide/',
    '',
    'User-agent: GPTBot',
    'User-agent: ClaudeBot',
    'Disallow: /',
    'Allow: /docs/',
    'Disallow: /docs/internal/',
    '',
    'User-agent: OAI-SearchBot',
    'Disallow: /tie',
    'Allow: /tie',
    '',
    'User-agent: PerplexityBot',
    'Disallow:',
  ].join('\n');

  // Specific group overrides * and uses longest-match precedence
  const gptDocs = parseRobotsTxt(robots, '/docs/getting-started', 'GPTBot');
  assert.equal(gptDocs.matchedGroup, 'GPTBot');
  assert.equal(gptDocs.allowed, true);
  assert.equal(gptDocs.status, 'allowed');
  assert.equal(gptDocs.rule, 'Allow: /docs/');

  const gptInternal = parseRobotsTxt(robots, '/docs/internal/roadmap', 'GPTBot');
  assert.equal(gptInternal.allowed, false);
  assert.equal(gptInternal.status, 'blocked');
  assert.equal(gptInternal.rule, 'Disallow: /docs/internal/');

  // Grouped user-agent (ClaudeBot shares block with GPTBot), does NOT leak to Claude-SearchBot
  const claudeRoot = parseRobotsTxt(robots, '/', 'ClaudeBot');
  assert.equal(claudeRoot.matchedGroup, 'ClaudeBot');
  assert.equal(claudeRoot.allowed, false);

  const claudeSearchRoot = parseRobotsTxt(robots, '/', 'Claude-SearchBot');
  assert.equal(claudeSearchRoot.matchedGroup, '*');
  assert.equal(claudeSearchRoot.allowed, true);
  assert.equal(claudeSearchRoot.status, 'default_allowed');

  // Fallback to * with longest-match Allow beating shorter Disallow
  const googlePublicGuide = parseRobotsTxt(robots, '/private/public-guide/intro', 'Googlebot');
  assert.equal(googlePublicGuide.matchedGroup, '*');
  assert.equal(googlePublicGuide.allowed, true);
  assert.equal(googlePublicGuide.rule, 'Allow: /private/public-guide/');

  // Wildcard + $ end anchor
  const bingPdf = parseRobotsTxt(robots, '/whitepaper.pdf', 'Bingbot');
  assert.equal(bingPdf.allowed, false);
  assert.equal(bingPdf.rule, 'Disallow: /*.pdf$');

  const bingPdfQuery = parseRobotsTxt(robots, '/whitepaper.pdf?download=1', 'Bingbot');
  assert.equal(bingPdfQuery.allowed, true);

  // Equal-length tie: Allow wins per RFC 9309 §2.2.2
  const oaiTie = parseRobotsTxt(robots, '/tie/page', 'OAI-SearchBot');
  assert.equal(oaiTie.allowed, true);
  assert.equal(oaiTie.rule, 'Allow: /tie');

  // Empty Disallow: allows everything
  const perp = parseRobotsTxt(robots, '/anything', 'PerplexityBot');
  assert.equal(perp.matchedGroup, 'PerplexityBot');
  assert.equal(perp.allowed, true);
  assert.equal(perp.status, 'default_allowed');
  assert.deepEqual(perp.sitemaps, ['https://example.com/sitemap.xml']);
});

test('checkSite evaluates all 9 crawlers, handles 404/500 robots.txt gracefully, and never spoofs AI User-Agents', async (t) => {
  /** @type {string[]} */
  const seenUserAgents = [];
  let robotsMode = '200';

  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    seenUserAgents.push(String(req.headers['user-agent'] ?? ''));
    if (req.url === '/robots.txt') {
      if (robotsMode === '404') {
        res.writeHead(404).end('Not Found');
        return;
      }
      if (robotsMode === '500') {
        res.writeHead(503).end('Service Unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end([
        'User-agent: GPTBot',
        'Disallow: /',
        'User-agent: OAI-SearchBot',
        'Allow: /',
        'User-agent: *',
        'Disallow: /admin/',
      ].join('\n'));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      server: 'cloudflare',
      'cf-ray': '8a1b2c3d4e5f-SJC',
      vary: 'Accept-Encoding',
    });
    res.end(
      '<!doctype html><html><head>' +
        '<title>Acme Product Guide</title>' +
        '<meta name="description" content="Complete technical guide for Acme.">' +
        `<link rel="canonical" href="${baseUrl}/docs">` +
        '<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Acme"}</script>' +
        '</head><body>' +
        '<h1>Acme Product Guide</h1>' +
        '<p>Acme helps engineering teams ship reliable software with zero-dependency local audits and reproducible telemetry across every release cycle.</p>' +
        '<table><tr><th>Plan</th><th>Price</th></tr><tr><td>OSS</td><td>$0</td></tr></table>' +
        '<p>' + 'reliable documentation content for crawlers '.repeat(25) + '</p>' +
        '</body></html>',
    );
  });

  // 200 robots.txt
  const report = await checkSite(`${baseUrl}/docs`, { allowPrivateHosts: true });
  assert.equal(report.status, 200);
  assert.equal(report.robotsTxt.fetched, true);
  assert.equal(report.robotsTxt.crawlers.length, AI_CRAWLERS.length);
  assert.deepEqual(report.robotsTxt.crawlers.map((c) => c.bot), [...AI_CRAWLERS]);

  const gpt = report.robotsTxt.crawlers.find((c) => c.bot === 'GPTBot');
  const oai = report.robotsTxt.crawlers.find((c) => c.bot === 'OAI-SearchBot');
  const google = report.robotsTxt.crawlers.find((c) => c.bot === 'Googlebot');
  assert.equal(gpt?.allowed, false);
  assert.equal(gpt?.status, 'blocked');
  assert.equal(gpt?.matchedGroup, 'GPTBot');
  assert.equal(oai?.allowed, true);
  assert.equal(oai?.status, 'allowed');
  assert.equal(google?.allowed, true);
  assert.equal(google?.matchedGroup, '*');

  // Response & HTML metadata signals
  assert.equal(report.headers.cfRay, '8a1b2c3d4e5f-SJC');
  assert.equal(report.headers.cdnDetected, 'cloudflare');
  assert.equal(report.headers.cacheControl, 'public, max-age=300');
  assert.equal(report.headers.vary, 'Accept-Encoding');
  assert.equal(report.meta.title, 'Acme Product Guide');
  assert.equal(report.meta.description, 'Complete technical guide for Acme.');
  assert.equal(report.meta.canonicalMatchesFinal, true);
  assert.equal(report.meta.noindex, false);
  assert.equal(report.payload.tableCount, 1);
  assert.equal(report.payload.jsonLdCount, 1);
  assert.deepEqual(report.payload.jsonLdTypes, ['SoftwareApplication']);

  // Epistemic honesty: honest UA sent, zero AI bot UA spoofing, mandatory disclaimers present
  assert.ok(seenUserAgents.length >= 2);
  for (const ua of seenUserAgents) {
    assert.equal(ua, USER_AGENT);
    for (const bot of AI_CRAWLERS) assert.ok(!ua.includes(bot));
  }
  assert.ok(report.disclaimers.length >= 3);
  assert.ok(report.disclaimers.some((d) => /Cloudflare|Akamai/i.test(d) && /IP|rDNS/i.test(d)));
  assert.ok(report.disclaimers.some((d) => /origin|CDN.*log/i.test(d)));

  // 404 robots.txt -> graceful default_allowed
  robotsMode = '404';
  const r404 = await checkSite(`${baseUrl}/docs`, { allowPrivateHosts: true });
  assert.equal(r404.robotsTxt.status, 404);
  assert.equal(r404.robotsTxt.fetched, false);
  assert.equal(r404.robotsTxt.allowedCount, 9);
  assert.ok(r404.robotsTxt.crawlers.every((c) => c.allowed && c.status === 'default_allowed'));

  // 503 robots.txt -> graceful unavailable without throwing
  robotsMode = '500';
  const r500 = await checkSite(`${baseUrl}/docs`, { allowPrivateHosts: true });
  assert.equal(r500.robotsTxt.status, 503);
  assert.equal(r500.robotsTxt.fetched, false);
  assert.ok(r500.robotsTxt.error?.includes('503'));
  assert.ok(r500.robotsTxt.crawlers.every((c) => c.status === 'unavailable' && c.allowed === false));
});

test('redirect chain tracking records hops, crossHost, geoLikely, loop detection, and max hops', async (t) => {
  const { baseUrl, port } = await startFixtureServer(t, (req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    if (url === '/start') {
      res.writeHead(301, { location: `http://localhost:${port}/regional` }).end();
      return;
    }
    if (url === '/regional') {
      res.writeHead(302, { location: '/en-us/landing', vary: 'Accept-Language' }).end();
      return;
    }
    if (url === '/en-us/landing') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>US Landing</title></head><body><h1>US Landing</h1><p>' + 'clear content '.repeat(60) + '</p></body></html>');
      return;
    }
    if (url === '/loop-a') {
      res.writeHead(302, { location: '/loop-b' }).end();
      return;
    }
    if (url === '/loop-b') {
      res.writeHead(302, { location: '/loop-a' }).end();
      return;
    }
    if (url.startsWith('/exact/')) {
      const n = Number(url.slice('/exact/'.length));
      if (n < 2) {
        res.writeHead(302, { location: `/exact/${n + 1}` }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Exact Hops</title></head><body><h1>Exact Hops</h1><p>' + 'ok '.repeat(50) + '</p></body></html>');
      return;
    }
    if (url.startsWith('/chain/')) {
      const n = Number(url.slice('/chain/'.length));
      res.writeHead(302, { location: `/chain/${n + 1}` }).end();
      return;
    }
    res.writeHead(404).end();
  });

  const chain = await checkSite(`${baseUrl}/start`, { allowPrivateHosts: true });
  assert.equal(chain.status, 200);
  assert.equal(chain.redirects.count, 2);
  assert.equal(chain.redirects.loopDetected, false);
  assert.equal(chain.redirects.hops[0].status, 301);
  assert.equal(chain.redirects.hops[0].crossHost, true);
  assert.equal(chain.redirects.hops[1].status, 302);
  assert.equal(chain.redirects.hops[1].crossHost, false);
  assert.equal(chain.redirects.hops[1].geoLikely, true);
  assert.equal(chain.finalUrl, `http://localhost:${port}/en-us/landing`);
  assert.equal(chain.redirects.crossHost, true);
  assert.equal(chain.redirects.geoLikely, true);

  // Exact maxRedirects hops ending in 200 succeeds; maxRedirects + 1 triggers maxHopsExceeded
  const exactOk = await checkSite(`${baseUrl}/exact/0`, { allowPrivateHosts: true, maxRedirects: 2 });
  assert.equal(exactOk.status, 200);
  assert.equal(exactOk.ok, true);
  assert.equal(exactOk.redirects.count, 2);
  assert.equal(exactOk.redirects.maxHopsExceeded, false);
  assert.equal(exactOk.finalUrl, `${baseUrl}/exact/2`);

  const oneTooMany = await checkSite(`${baseUrl}/exact/0`, { allowPrivateHosts: true, maxRedirects: 1 });
  assert.equal(oneTooMany.ok, false);
  assert.equal(oneTooMany.redirects.count, 1);
  assert.equal(oneTooMany.redirects.maxHopsExceeded, true);
  assert.ok(oneTooMany.findings.some((f) => f.id === 'max_redirects_exceeded'));

  // Loop detection
  const loop = await checkSite(`${baseUrl}/loop-a`, { allowPrivateHosts: true });
  assert.equal(loop.redirects.loopDetected, true);
  assert.equal(loop.redirects.loopTarget, `${baseUrl}/loop-a`);
  assert.equal(loop.ok, false);
  assert.equal(loop.summary.grade, 'fail');
  assert.ok(loop.findings.some((f) => f.id === 'redirect_loop' && f.severity === 'critical'));

  // Max hops exceeded (>10 hops)
  const tooMany = await checkSite(`${baseUrl}/chain/0`, { allowPrivateHosts: true });
  assert.equal(tooMany.redirects.maxHopsExceeded, true);
  assert.equal(tooMany.redirects.count, 10);
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.findings.some((f) => f.id === 'max_redirects_exceeded'));
});

test('analyzeHtmlPayload computes exact UTF-8 byte offsets, strips non-visible tags, and flags truncation cliffs', () => {
  // Multi-byte UTF-8 exact byte offset verification
  const prefix = '<!doctype html><html><head><title>テスト 🚀</title></head><body><!-- 日本語コメント -->';
  const h1 = '<h1>Exact UTF-8 Heading</h1>';
  const para = '<p>This is the first substantive paragraph with well over eighty visible characters so its exact UTF-8 byte offset is recorded accurately.</p>';
  const ignored = '<script>const fake = "script words should never count";</script><style>.x{content:"style words"}</style><noscript>noscript hidden</noscript><svg><text>svg hidden</text></svg>';
  const html = `${prefix}${h1}${ignored}${para}<h2>Subheading</h2></body></html>`;

  const result = analyzeHtmlPayload(html);
  const rawBuf = Buffer.from(html, 'utf8');
  assert.equal(result.htmlBytes, rawBuf.byteLength);
  assert.equal(result.offsets.firstH1Bytes, rawBuf.indexOf('<h1>'));
  assert.equal(result.offsets.firstSubstantiveParagraphBytes, rawBuf.indexOf('<p>'));
  assert.ok(result.offsets.firstH1Bytes > html.indexOf('<h1>'), 'UTF-8 byte offset exceeds UTF-16 index when multi-byte chars precede it');
  assert.equal(result.headingCount, 2);
  assert.equal(result.headings[0].text, 'Exact UTF-8 Heading');
  assert.equal(result.headings[1].text, 'Subheading');
  assert.ok(result.visibleWordCount > 20 && result.visibleWordCount < 40, `unexpected word count ${result.visibleWordCount}`);
  assert.ok(
    result.offsets.text25PctBytes !== null &&
      result.offsets.text50PctBytes !== null &&
      result.offsets.text75PctBytes !== null &&
      result.offsets.text90PctBytes !== null,
  );
  assert.ok(result.offsets.text25PctBytes <= result.offsets.text50PctBytes);
  assert.ok(result.offsets.text50PctBytes <= result.offsets.text75PctBytes);
  assert.ok(result.offsets.text75PctBytes <= result.offsets.text90PctBytes);
  assert.equal(result.truncationRisks.any, false);

  // Truncation cliff: >30KB head bloat -> contentStartsAfter30KB
  const bloat35k = `<style>${'a{color:red}'.repeat(3200)}</style>`;
  const html35k = `<html><head>${bloat35k}</head><body><h1>Delayed Hero</h1><p>${'Substantive product description for testing offset cliffs. '.repeat(4)}</p></body></html>`;
  const r35k = analyzeHtmlPayload(html35k);
  assert.equal(r35k.truncationRisks.contentStartsAfter30KB, true);
  assert.equal(r35k.truncationRisks.coreContentPast100KB, false);
  assert.equal(r35k.truncationRisks.pageExceeds300KB, false);
  assert.ok(r35k.styleBytes > 30 * 1024);

  // Truncation cliff: >110KB hydration blob + >310KB total HTML
  const bloat110k = `<script>window.__STATE__="${'z'.repeat(115_000)}";</script>`;
  const tailBloat200k = `<script>window.__EXTRA__="${'y'.repeat(205_000)}";</script>`;
  const html320k = `<html><head>${bloat110k}</head><body><h1>Late Content</h1><p>${'Core product documentation appearing after 100KB of hydration state. '.repeat(6)}</p>${tailBloat200k}</body></html>`;
  const r320k = analyzeHtmlPayload(html320k);
  assert.equal(r320k.truncationRisks.contentStartsAfter30KB, true);
  assert.equal(r320k.truncationRisks.coreContentPast100KB, true);
  assert.equal(r320k.truncationRisks.pageExceeds300KB, true);
  assert.ok(r320k.offsets.firstH1Bytes !== null && r320k.offsets.firstH1Bytes > 100 * 1024);
  assert.ok(r320k.offsets.text50PctBytes !== null && r320k.offsets.text50PctBytes > 100 * 1024);
});

test('CSR empty-shell risk distinguishes SPA empty shells from hydrated SSR pages', () => {
  // High-risk Vite/React CSR empty shell
  const spaShell =
    '<!doctype html><html><head><title>App</title></head><body>' +
    '<div id="root"></div>' +
    '<noscript>You need to enable JavaScript to run this app.</noscript>' +
    '<script type="module" src="/assets/main-abc123.js"></script>' +
    '</body></html>';
  const spaResult = analyzeHtmlPayload(spaShell);
  assert.equal(spaResult.csrRisk.level, 'high');
  assert.deepEqual(spaResult.csrRisk.spaRoots, ['#root']);
  assert.equal(spaResult.visibleWordCount, 0);
  assert.equal(spaResult.hasNoscriptJsWarning, true);

  // Low-risk Next.js SSR page with #__next AND real content
  const ssrPage =
    '<!doctype html><html><head><title>SSR Docs</title></head><body>' +
    '<div id="__next"><h1>Server Rendered Documentation</h1>' +
    `<p>${'Complete server rendered documentation that AI crawlers can read immediately without executing client bundles. '.repeat(12)}</p>` +
    '</div><script src="/_next/static/chunks/app.js"></script></body></html>';
  const ssrResult = analyzeHtmlPayload(ssrPage);
  assert.equal(ssrResult.csrRisk.level, 'low');
  assert.ok(ssrResult.visibleWordCount > 100);
});

test('noindex detection catches X-Robots-Tag, meta robots, and meta googlebot', async (t) => {
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    if (req.url === '/header-noindex') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'x-robots-tag': 'googlebot: noindex, nofollow',
      });
      res.end('<html><head><title>Header Noindex</title></head><body><h1>Hidden</h1><p>' + 'word '.repeat(90) + '</p></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<html><head><title>Meta Noindex</title>' +
        '<meta name="robots" content="noindex, noarchive">' +
        '<meta name="googlebot" content="noindex">' +
        '</head><body><h1>Hidden Meta</h1><p>' + 'word '.repeat(90) + '</p></body></html>',
    );
  });

  const h = await checkSite(`${baseUrl}/header-noindex`, { allowPrivateHosts: true });
  assert.equal(h.meta.noindex, true);
  assert.equal(h.meta.nofollow, true);
  assert.deepEqual(h.meta.noindexSources, ['x-robots-tag']);
  assert.equal(h.summary.grade, 'fail');
  assert.ok(h.findings.some((f) => f.id === 'noindex_detected' && f.severity === 'critical'));

  const m = await checkSite(`${baseUrl}/meta-noindex`, { allowPrivateHosts: true });
  assert.equal(m.meta.noindex, true);
  assert.deepEqual(m.meta.noindexSources, ['meta[name="robots"]', 'meta[name="googlebot"]']);
});

test('optional browser DOM diff returns unavailable cleanly when missing and computes hydration gap when available', async (t) => {
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>SPA</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });

  // Unavailable local browser path -> clean status without throwing
  const unavailable = await checkSite(`${baseUrl}/`, {
    allowPrivateHosts: true,
    browser: true,
    browserBinary: '/nonexistent/hearsay-test-chromium-binary',
  });
  assert.equal(unavailable.browserDiff.status, 'unavailable');
  assert.ok(typeof unavailable.browserDiff.reason === 'string' && unavailable.browserDiff.reason.length > 0);

  // Simulated hydrated DOM via injected browserRunner
  const hydrated = await checkSite(`${baseUrl}/`, {
    allowPrivateHosts: true,
    browser: true,
    browserRunner: async () => ({
      engine: 'mock-chromium',
      html: `<html><head><title>Hydrated App</title></head><body><div id="root"><h1>Hydrated Heading</h1><p>${'Rendered client side content word '.repeat(40)}</p></div></body></html>`,
    }),
  });
  assert.equal(hydrated.browserDiff.status, 'ok');
  assert.equal(hydrated.browserDiff.rawWordCount, 0);
  assert.ok((hydrated.browserDiff.renderedWordCount ?? 0) > 100);
  assert.equal(hydrated.browserDiff.hydrationGap, 'high');
  assert.ok(hydrated.findings.some((f) => f.id === 'browser_hydration_gap_high'));
});

test('renderSiteCheckHtml escapes all untrusted XSS payloads and renderSiteCheckText renders all sections', async (t) => {
  const xss = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nDisallow: /"'><script>alert(2)</script>\n`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      server: `evil-server ${xss}`,
      'x-robots-tag': `all, ${xss}`,
    });
    res.end(
      `<!doctype html><html><head>` +
        `<title>Title ${xss}</title>` +
        `<meta name="description" content='Desc "><img src=x onerror=alert(3)>'>` +
        `<link rel="canonical" href="javascript:alert(4)">` +
        `</head><body><h1>Heading &lt;b&gt; &amp; ${xss}</h1>` +
        `<p>${'Visible safe text content '.repeat(30)}</p></body></html>`,
    );
  });

  const report = await checkSite(`${baseUrl}/`, { allowPrivateHosts: true });
  const htmlOut = renderSiteCheckHtml(report);
  assert.ok(htmlOut.startsWith('<!doctype html>'));
  assert.ok(htmlOut.includes('@media print'));
  assert.ok(!htmlOut.includes('<script>alert('), 'unescaped <script> must never appear');
  assert.ok(!htmlOut.includes('<img src=x onerror='), 'unescaped <img onerror> must never appear');
  assert.ok(!htmlOut.includes('href="javascript:'), 'javascript: href must never appear');
  assert.ok(htmlOut.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  assert.ok(htmlOut.includes('Epistemic Disclaimers'));

  const textOut = renderSiteCheckText(report);
  assert.match(textOut, /Hearsay Site Pre-Flight Check/);
  assert.match(textOut, /OAI-SearchBot/);
  assert.match(textOut, /Truncation Cliffs/);
  assert.match(textOut, /Epistemic Disclaimers/);
});

test('CLI `hearsay check` enforces SSRF guard by default, outputs --json and --html, and `hearsay serve` boots cleanly', async (t) => {
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>CLI Fixture</title></head><body>' +
        '<h1>CLI Fixture Heading</h1>' +
        `<p>${'This fixture page verifies the zero-key hearsay check CLI command end to end. '.repeat(8)}</p>` +
        '</body></html>',
    );
  });

  // Help mentions check & serve alongside existing commands
  const helpRes = await execFileAsync(NODE, [CLI, '--help']);
  assert.match(helpRes.stdout, /hearsay check <url>/);
  assert.match(helpRes.stdout, /hearsay serve/);
  assert.match(helpRes.stdout, /setup save/);

  // Default CLI blocks loopback (safe public default) with exit code 2
  await assert.rejects(
    execFileAsync(NODE, [CLI, 'check', `${baseUrl}/`, '--json']),
    (err) => {
      assert.equal(err.code, 2);
      const jsonLine = String(err.stderr).split('\n').find((line) => line.trim().startsWith('{'));
      assert.ok(jsonLine, `expected JSON error on stderr, got: ${err.stderr}`);
      const parsed = JSON.parse(jsonLine);
      assert.equal(parsed.error.code, 'ssrf_blocked');
      return true;
    },
  );

  // Invalid --timeout exits with code 2
  await assert.rejects(
    execFileAsync(NODE, [CLI, 'check', `${baseUrl}/`, '--allow-private-hosts', '--timeout', '-10']),
    (err) => err.code === 2,
  );

  // --json output against local fixture with explicit opt-in
  const jsonRes = await execFileAsync(NODE, [CLI, 'check', `${baseUrl}/`, '--allow-private-hosts', '--timeout', '5000', '--json']);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.meta.title, 'CLI Fixture');
  assert.equal(parsed.robotsTxt.crawlers.length, 9);
  assert.equal(parsed.summary.grade, 'pass');

  // --html export + text stdout
  const tmpDir = mkdtempSync(join(tmpdir(), 'hearsay-site-check-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
  const htmlFile = join(tmpDir, 'audit.html');
  const textRes = await execFileAsync(NODE, [CLI, 'check', `${baseUrl}/`, '--allow-private-hosts', '--html', htmlFile]);
  assert.match(textRes.stdout, /Hearsay Site Pre-Flight Check/);
  assert.match(textRes.stdout, /HTML report written to/);
  assert.ok(existsSync(htmlFile));
  const writtenHtml = readFileSync(htmlFile, 'utf8');
  assert.ok(writtenHtml.startsWith('<!doctype html>'));
  assert.ok(writtenHtml.includes('CLI Fixture'));

  // `hearsay serve` convenience alias boots cleanly on ephemeral port and handles SIGTERM
  const serveDir = mkdtempSync(join(tmpdir(), 'hearsay-serve-'));
  t.after(() => rmSync(serveDir, { recursive: true, force: true }));
  const child = spawn(NODE, [CLI, 'serve', '--port', '0', '--host', '127.0.0.1'], {
    env: {
      ...process.env,
      HEARSAY_DEMO: '0',
      HEARSAY_DB_PATH: join(serveDir, 'real', 'hearsay.db'),
      HEARSAY_DEMO_DB_PATH: join(serveDir, 'demo', 'hearsay.db'),
      HEARSAY_PORT_FILE: join(serveDir, 'port'),
      HEARSAY_ENV_FILE: join(serveDir, '.env'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (!child.killed) child.kill('SIGKILL');
  });

  /** @type {string} */
  const listeningLine = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`hearsay serve startup timeout; stdout=${out} stderr=${err}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      const match = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`hearsay serve exited prematurely (${code}): ${err}`));
    });
  });

  const ping = await fetch(`${listeningLine}/`);
  assert.equal(ping.status, 200);
  await ping.body?.cancel();

  const exitCode = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
  assert.equal(exitCode, 0);
});
