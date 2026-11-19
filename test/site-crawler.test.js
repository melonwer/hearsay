/**
 * Comprehensive ephemeral-HTTP-server tests for Wave A Track 3:
 * - `core/site-crawler.js` (multi-page crawl, sitemap/.xml.gz/index discovery,
 *   template diversity selection, --single, robots.txt skip accounting,
 *   --ignore-robots-for-own-site, per-hop SSRF guard, AIMD politeness,
 *   conditional GET 304 caching, template clustering, Hard Infrastructure Gate)
 * - `core/site-diff.js` (--vs Competitor X-Ray, --baseline O(N) diff with 20%
 *   word-count noise floor, and --fail-on CI Gate exit code 10 + zero-page guard
 *   + ignoreCodes precedence)
 *
 * Pure Node 22 built-ins only — zero external network calls or dependencies.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { SiteCheckError } from '../core/site-check.js';
import {
  MAX_CRAWL_DELAY_MS,
  clusterIssuesByTemplate,
  crawlSitePages,
  createAimdController,
  discoverSitemapUrls,
  evaluateHardGate,
  normalizeUrlTemplate,
  parseCrawlDelay,
  selectKeyPages,
} from '../core/site-crawler.js';
import {
  CI_GATE_EXIT_CODE,
  compareCompetitors,
  diffAgainstBaseline,
  evaluateCiGate,
} from '../core/site-diff.js';

/**
 * Boot an ephemeral `node:http` server on 127.0.0.1:0 with automatic teardown.
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

/**
 * Build a clean SSR HTML page fixture with plenty of visible prose.
 * @param {string} title
 * @param {string} heading
 * @param {string} [extraBody]
 * @returns {string}
 */
function htmlPage(title, heading, extraBody = '') {
  const prose = 'Hearsay audits real raw HTML and server-side crawlability signals for AI search engines. '.repeat(8);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
  ${extraBody}
  <main><h1>${heading}</h1><p>${prose}</p></main>
</body>
</html>`;
}

test('selectKeyPages ranks homepage, high-intent nav pages, and caps dynamic templates at 2 samples', () => {
  const origin = 'https://acme.example';
  const blogUrls = Array.from({ length: 20 }, (_, idx) => `${origin}/blog/post-${String(idx + 1).padStart(2, '0')}`);
  const navLinks = [
    ...blogUrls.slice(0, 10),
    `${origin}/pricing`,
    `${origin}/docs`,
    `${origin}/features`,
    `${origin}/compare`,
    `${origin}/about`,
    `${origin}/alternatives`,
    `${origin}/product`,
    `${origin}/faq`,
    `${origin}/logo.png`, // asset ignored
    'https://external.example/pricing', // cross-origin ignored
  ];
  const sitemapUrls = [
    ...blogUrls,
    `${origin}/docs/guides/quickstart`,
    `${origin}/docs/api/authentication`,
    `${origin}/docs/api/webhooks`,
    `${origin}/products/101`,
    `${origin}/products/202`,
    `${origin}/products/303`,
    `${origin}/changelog`,
  ];

  const result = selectKeyPages({
    homepageUrl: `${origin}/`,
    navLinks,
    sitemapUrls,
    maxPages: 15,
  });

  assert.equal(result.urls[0], `${origin}/`, 'homepage must be first');
  assert.ok(result.urls.length <= 15, 'must respect maxPages cap');

  // All high-intent nav pages must be included ahead of 20 blog posts
  for (const hi of ['/pricing', '/docs', '/features', '/compare', '/about', '/alternatives', '/product', '/faq']) {
    assert.ok(result.urls.includes(`${origin}${hi}`), `expected high-intent page ${hi} to be selected`);
  }

  // Dynamic /blog/:slug template must be capped at 2 samples
  const selectedBlogs = result.urls.filter((u) => u.includes('/blog/'));
  assert.equal(selectedBlogs.length, 2, `expected max 2 /blog/:slug pages, got ${selectedBlogs.length}`);
  assert.equal(result.templateCounts['/blog/:slug'], 2);

  // Deterministic across repeated runs
  const secondRun = selectKeyPages({
    homepageUrl: `${origin}/`,
    navLinks: [...navLinks].reverse(),
    sitemapUrls: [...sitemapUrls].reverse(),
    maxPages: 15,
  });
  assert.deepEqual(secondRun.urls, result.urls, 'selection must be deterministic regardless of input order');
});

test('discoverSitemapUrls handles robots.txt Sitemap:, recursive <sitemapindex> depth<=2, .xml.gz, .tar.gz rejection, HTML soft-404 rejection, and 500-URL cap', async (t) => {
  let tarGzRequested = false;
  let depth3Requested = false;

  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    const reqUrl = req.url ?? '/';

    if (reqUrl === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end([
        'User-agent: *',
        'Allow: /',
        `Sitemap: http://127.0.0.1:${req.socket.localPort}/sitemap-index.xml`,
        `Sitemap: http://127.0.0.1:${req.socket.localPort}/backup.tar.gz`,
        `Sitemap: http://127.0.0.1:${req.socket.localPort}/spa-soft404-sitemap.xml`,
        `Sitemap: http://127.0.0.1:${req.socket.localPort}/fake-rss.xml.gz`,
      ].join('\n'));
      return;
    }

    const origin = `http://127.0.0.1:${req.socket.localPort}`;

    if (reqUrl === '/backup.tar.gz') {
      tarGzRequested = true;
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(gzipSync(Buffer.from('not-a-sitemap')));
      return;
    }

    if (reqUrl === '/spa-soft404-sitemap.xml' || reqUrl === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>');
      return;
    }

    if (reqUrl === '/fake-rss.xml.gz') {
      const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title></channel></rss>';
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(gzipSync(Buffer.from(rss, 'utf8')));
      return;
    }

    if (reqUrl === '/sitemap-index.xml') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-sub-index.xml</loc></sitemap>
  <sitemap><loc>${origin}/sitemap-gzipped.xml.gz</loc></sitemap>
</sitemapindex>`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
      return;
    }

    if (reqUrl === '/sitemap-sub-index.xml') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-depth2-leaf.xml</loc></sitemap>
  <sitemap><loc>${origin}/sitemap-depth2-index.xml</loc></sitemap>
</sitemapindex>`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
      return;
    }

    if (reqUrl === '/sitemap-depth2-leaf.xml') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/docs/guides/install</loc><lastmod>2026-11-01</lastmod></url>
  <url><loc>${origin}/pricing</loc></url>
</urlset>`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
      return;
    }

    if (reqUrl === '/sitemap-depth2-index.xml') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-depth3-should-not-load.xml</loc></sitemap>
</sitemapindex>`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
      return;
    }

    if (reqUrl === '/sitemap-depth3-should-not-load.xml') {
      depth3Requested = true;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<urlset><url><loc>${origin}/too-deep</loc></url></urlset>`);
      return;
    }

    if (reqUrl === '/sitemap-gzipped.xml.gz') {
      const items = Array.from({ length: 12 }, (_, idx) => `<url><loc>${origin}/blog/gz-post-${idx + 1}</loc></url>`).join('');
      const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>`;
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(gzipSync(Buffer.from(xml, 'utf8')));
      return;
    }

    res.writeHead(404).end();
  });

  const discovered = await discoverSitemapUrls(baseUrl, { allowPrivateHosts: true });

  assert.equal(tarGzRequested, false, '.tar.gz must be ignored without even fetching');
  assert.equal(depth3Requested, false, 'recursion depth must stop at depth 2');
  assert.ok(discovered.urls.includes(`${baseUrl}/pricing`), 'must discover URLs from depth-2 leaf sitemap');
  assert.ok(discovered.urls.includes(`${baseUrl}/docs/guides/install`));
  assert.ok(discovered.urls.includes(`${baseUrl}/blog/gz-post-1`), 'must decompress valid .xml.gz urlset');
  assert.ok(discovered.urls.includes(`${baseUrl}/blog/gz-post-12`));
  assert.ok(!discovered.urls.includes(`${baseUrl}/too-deep`), 'depth-3 URL must not be included');

  // Verify explicit rejections
  assert.ok(
    discovered.rejected.some((r) => r.url.endsWith('/backup.tar.gz') && r.reason === 'ignored_archive'),
    'expected .tar.gz rejection',
  );
  assert.ok(
    discovered.rejected.some((r) => r.url.endsWith('/spa-soft404-sitemap.xml') && r.reason === 'soft_404_html'),
    'expected SPA 200 text/html soft-404 rejection',
  );
  assert.ok(
    discovered.rejected.some((r) => r.url.endsWith('/fake-rss.xml.gz') && r.reason === 'invalid_sitemap_root'),
    'expected non-urlset/sitemapindex gzipped XML rejection',
  );

  // Verify 500-URL hard cap
  const { baseUrl: bigBase } = await startFixtureServer(t, (req, res) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    if (req.url === '/sitemap.xml') {
      const locs = Array.from({ length: 620 }, (_, i) => `<url><loc>${origin}/item/${i + 1}</loc></url>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<urlset>${locs}</urlset>`);
      return;
    }
    res.writeHead(404).end();
  });

  const capped = await discoverSitemapUrls(bigBase, { allowPrivateHosts: true });
  assert.equal(capped.urls.length, 500, 'must cap candidate URLs at 500');
  assert.equal(capped.truncated, true);
});

test('crawlSitePages performs default multi-page crawl vs --single mode and enforces template diversity', async (t) => {
  /** @type {string[]} */
  const requestedPaths = [];

  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    requestedPaths.push(path);
    const origin = `http://127.0.0.1:${req.socket.localPort}`;

    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
      return;
    }

    if (path === '/sitemap.xml') {
      const blogLocs = Array.from({ length: 15 }, (_, i) => `<url><loc>${origin}/blog/post-${i + 1}</loc></url>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<urlset><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/docs</loc></url><url><loc>${origin}/products/42</loc></url>${blogLocs}</urlset>`,
      );
      return;
    }

    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        htmlPage(
          'Acme Home',
          'Acme AI Search',
          '<header><nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/features">Features</a></nav></header>',
        ),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlPage(`Acme ${path}`, `Heading ${path}`));
  });

  // Default multi-page crawl
  const multi = await crawlSitePages(`${baseUrl}/`, { allowPrivateHosts: true });
  assert.equal(multi.mode, 'multi');
  assert.equal(multi.downstreamStatus, 'observed');
  assert.ok(multi.counts.audited >= 6, `expected multi-page audit >= 6 pages, got ${multi.counts.audited}`);
  const crawledPaths = multi.pages.map((p) => new URL(p.finalUrl).pathname);
  assert.ok(crawledPaths.includes('/'));
  assert.ok(crawledPaths.includes('/pricing'));
  assert.ok(crawledPaths.includes('/docs'));
  assert.ok(crawledPaths.includes('/features'));
  assert.equal(
    crawledPaths.filter((p) => p.startsWith('/blog/')).length,
    2,
    'template diversity must cap /blog/:slug at 2 samples during multi-page crawl',
  );

  // --single mode
  requestedPaths.length = 0;
  const single = await crawlSitePages(`${baseUrl}/`, { single: true, allowPrivateHosts: true });
  assert.equal(single.mode, 'single');
  assert.equal(single.counts.audited, 1);
  assert.equal(single.pages.length, 1);
  assert.equal(single.sitemap, null);
  assert.ok(!requestedPaths.includes('/pricing'), '--single must not crawl secondary pages');
  assert.ok(!requestedPaths.includes('/sitemap.xml'), '--single must not fetch sitemap');
});

test('robots.txt skip accounting NEVER marks disallowed pages as PASS, and --ignore-robots-for-own-site audits them while flagging the rule', async (t) => {
  /** @type {Set<string>} */
  const fetchedPaths = new Set();

  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    fetchedPaths.add(path);

    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /blog/\nAllow: /\n');
      return;
    }
    if (path === '/sitemap.xml') {
      res.writeHead(404).end();
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        htmlPage(
          'Shop Home',
          'Shop Home',
          '<nav><a href="/pricing">Pricing</a><a href="/blog/launch">Blog Launch</a><a href="/blog/guide">Blog Guide</a></nav>',
        ),
      );
      return;
    }
    if (path === '/pricing') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Pricing', 'Simple Pricing'));
      return;
    }
    if (path.startsWith('/blog/')) {
      // Planted bug behind Disallow: /blog/ — missing <h1> and noindex!
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>Hidden Bug</title><meta name="robots" content="noindex"></head><body><p>' +
          'Planted blog content hidden behind robots disallow rule. '.repeat(8) +
          '</p></body></html>',
      );
      return;
    }
    res.writeHead(404).end();
  });

  // Default: respects robots.txt -> skipped in skipped[], NEVER fetched, NEVER status === 'pass'
  const respectful = await crawlSitePages(`${baseUrl}/`, { allowPrivateHosts: true });
  assert.equal(respectful.counts.audited, 2, 'only / and /pricing should be audited');
  assert.equal(respectful.counts.skippedByReason.robots_disallowed, 2);
  assert.equal(respectful.skipped.filter((s) => s.reason === 'robots_disallowed').length, 2);
  assert.equal(respectful.coverageComplete, false);
  assert.notEqual(respectful.status, 'pass', 'must NEVER emit clean PASS when robots_disallowed pages were skipped');
  assert.equal(fetchedPaths.has('/blog/launch'), false, 'disallowed URL must not be fetched by default');
  assert.equal(fetchedPaths.has('/blog/guide'), false);

  // --ignore-robots-for-own-site: audits /blog/*, catches planted bugs, AND flags robots_disallowed_page
  fetchedPaths.clear();
  const override = await crawlSitePages(`${baseUrl}/`, {
    allowPrivateHosts: true,
    ignoreRobotsForOwnSite: true,
  });
  assert.equal(override.counts.audited, 4, 'all 4 pages audited when ignoreRobotsForOwnSite is true');
  assert.equal(override.counts.skippedByReason.robots_disallowed, 0);
  const blogPages = override.pages.filter((p) => p.finalUrl.includes('/blog/'));
  assert.equal(blogPages.length, 2);
  for (const bp of blogPages) {
    assert.equal(bp.robotsDisallowed, true);
    assert.ok(bp.findings.some((f) => f.id === 'robots_disallowed_page'));
    assert.ok(bp.findings.some((f) => f.id === 'noindex_detected'), 'planted noindex bug behind robots.txt must be caught');
    assert.ok(bp.findings.some((f) => f.id === 'missing_h1'), 'planted missing_h1 bug behind robots.txt must be caught');
  }
});

test('per-hop DNS-resolving SSRF guard blocks private targets, DNS rebinding, and redirect hops', async () => {
  // Literal private / metadata hosts blocked by default
  for (const bad of ['http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/', 'http://[::1]/']) {
    await assert.rejects(
      crawlSitePages(bad),
      (err) => err instanceof SiteCheckError && err.code === 'ssrf_blocked',
      `expected ssrf_blocked for ${bad}`,
    );
  }

  // DNS rebinding to private IP
  await assert.rejects(
    crawlSitePages('https://rebind.example/', {
      lookup: async () => [{ address: '10.0.0.42', family: 4 }],
      fetchImpl: async () => {
        throw new Error('fetchImpl must not be invoked after DNS SSRF block');
      },
    }),
    (err) => err instanceof SiteCheckError && err.code === 'ssrf_blocked',
  );

  // Per-hop redirect SSRF: public host redirects to cloud metadata IP
  let hopsCalled = 0;
  await assert.rejects(
    crawlSitePages('https://public.example/', {
      lookup: async (host) => {
        if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
        return [{ address: '169.254.169.254', family: 4 }];
      },
      fetchImpl: async () => {
        hopsCalled += 1;
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/iam/' },
        });
      },
    }),
    (err) => err instanceof SiteCheckError && err.code === 'ssrf_blocked',
  );
  assert.equal(hopsCalled, 1, 'redirect target must be blocked before fetching second hop');

  // Secondary link redirecting to private IP during multi-page crawl is recorded as ssrf_blocked skip
  const crawl = await crawlSitePages('https://public.example/', {
    lookup: async (host) => {
      if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
      return [{ address: '127.0.0.1', family: 4 }];
    },
    fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml')) {
        return new Response('', { status: 404 });
      }
      if (url === 'https://public.example/') {
        return new Response(htmlPage('Public', 'Public', '<nav><a href="/redirect-internal">Trap</a></nav>'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === 'https://public.example/redirect-internal') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://internal-service.example/secret' },
        });
      }
      return new Response('', { status: 404 });
    },
  });

  assert.equal(crawl.counts.skippedByReason.ssrf_blocked, 1);
  assert.ok(crawl.skipped.some((s) => s.reason === 'ssrf_blocked' && s.url.includes('/redirect-internal')));
});

test('AIMD polite throttle respects Crawl-delay up to 3s cap and slows down on 429/503 or >2s latency', async (t) => {
  assert.equal(parseCrawlDelay('User-agent: *\nCrawl-delay: 10\n'), 10);
  assert.equal(parseCrawlDelay('User-agent: *\nCrawl-delay: 1\n\nUser-agent: HearsaySiteCheck\nCrawl-delay: 2.5\n'), 2.5);

  /** @type {number[]} */
  const sleeps = [];
  const aimd = createAimdController({
    crawlDelaySec: 10, // exceeds 3s cap
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(aimd.getCrawlDelayFloorMs(), MAX_CRAWL_DELAY_MS, 'Crawl-delay floor must cap at 3000ms');
  assert.equal(aimd.getCurrentDelayMs(), 3_000);

  // 429 triggers multiplicative backoff (capped at 5000ms)
  aimd.recordResponse({ status: 429, timingMs: 120 });
  assert.equal(aimd.getCurrentDelayMs(), 5_000);
  await aimd.waitBeforeNext();
  assert.deepEqual(sleeps, [5_000]);

  // Healthy responses ease off additively down to floor (never below Crawl-delay floor)
  aimd.recordResponse({ status: 200, timingMs: 100 });
  assert.equal(aimd.getCurrentDelayMs(), 4_900);

  // Slow latency (>2000ms) triggers backoff even on 200
  const fastAimd = createAimdController({ sleepFn: async () => {} });
  fastAimd.recordResponse({ status: 200, timingMs: 2_500 });
  assert.equal(fastAimd.getCurrentDelayMs(), 500);
  fastAimd.recordResponse({ status: 503, timingMs: 100 });
  assert.equal(fastAimd.getCurrentDelayMs(), 1_500);
  assert.equal(fastAimd.getStats().slowdowns, 2);

  // End-to-end crawlSitePages with Crawl-delay + 503 backoff using instant sleepFn spy
  /** @type {number[]} */
  const crawlSleeps = [];
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nCrawl-delay: 8\nAllow: /\n');
      return;
    }
    if (path === '/sitemap.xml') {
      res.writeHead(404).end();
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(htmlPage('Home', 'Home', '<nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a></nav>'));
      return;
    }
    if (path === '/pricing') {
      res.writeHead(503, { 'content-type': 'text/html' }).end('Overloaded');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(htmlPage('Docs', 'Docs'));
  });

  const report = await crawlSitePages(`${baseUrl}/`, {
    allowPrivateHosts: true,
    maxConcurrency: 1,
    sleepFn: async (ms) => {
      crawlSleeps.push(ms);
    },
  });
  assert.equal(report.throttle.crawlDelayFloorMs, 3_000);
  assert.ok(report.throttle.slowdowns >= 1, '503 response should record an AIMD slowdown');
  assert.ok(crawlSleeps.some((ms) => ms === 3_000), 'first secondary request should wait Crawl-delay floor (3000ms)');
  assert.ok(crawlSleeps.some((ms) => ms > 3_000), 'post-503 request should wait increased AIMD delay');
});

test('checkCaching performs 1 conditional GET on homepage and verifies 304 Not Modified support', async (t) => {
  let conditionalRequests = 0;
  const etag = '"hearsay-v1-etag"';
  const lastModified = 'Wed, 18 Nov 2026 12:00:00 GMT';

  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
      conditionalRequests += 1;
      res.writeHead(304, { etag, 'last-modified': lastModified }).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      etag,
      'last-modified': lastModified,
    });
    res.end(htmlPage('Cached Home', 'Cached Home'));
  });

  const result = await crawlSitePages(`${baseUrl}/`, {
    single: true,
    allowPrivateHosts: true,
    checkCaching: true,
  });

  assert.equal(conditionalRequests, 1, 'must send exactly 1 conditional GET');
  assert.equal(result.caching.checked, true);
  assert.equal(result.caching.supported304, true);
  assert.equal(result.caching.status, 304);
  assert.equal(result.caching.sentHeaders.ifNoneMatch, etag);
  assert.equal(result.caching.sentHeaders.ifModifiedSince, lastModified);
  assert.equal(result.caching.reason, 'supports_304_not_modified');
});

test('clusterIssuesByTemplate normalizes URLs and groups siteWide, templateClusters ("fix 1 template -> fix N pages"), and pageOutliers', () => {
  assert.equal(normalizeUrlTemplate('https://acme.example/'), '/');
  assert.equal(normalizeUrlTemplate('https://acme.example/pricing'), '/pricing');
  assert.equal(normalizeUrlTemplate('https://acme.example/blog/ai-search-guide'), '/blog/:slug');
  assert.equal(normalizeUrlTemplate('https://acme.example/docs/getting-started/install'), '/docs/:section/:slug');
  assert.equal(normalizeUrlTemplate('https://acme.example/products/98412'), '/products/:id');
  assert.equal(normalizeUrlTemplate('https://acme.example/products/550e8400-e29b-41d4-a716-446655440000'), '/products/:id');

  /** @type {Array<{url: string, findings: Array<{id: string, severity: 'critical'|'attention'|'warning'|'info', category: string, title: string, detail: string}>}>} */
  const pageResults = [
    {
      url: 'https://acme.example/',
      findings: [
        { id: 'ai_search_bots_blocked', severity: 'critical', category: 'robots', title: 'OAI-SearchBot blocked', detail: 'Disallow: /' },
      ],
    },
    {
      url: 'https://acme.example/pricing',
      findings: [
        { id: 'canonical_mismatch', severity: 'attention', category: 'indexing', title: 'Canonical mismatch', detail: 'Points to staging' },
      ],
    },
    ...['post-1', 'post-2', 'post-3', 'post-4', 'post-5'].map((slug) => ({
      url: `https://acme.example/blog/${slug}`,
      findings: /** @type {Array<{id: string, severity: 'critical'|'attention'|'warning'|'info', category: string, title: string, detail: string}>} */ ([
        {
          id: 'truncation_core_past_100kb',
          severity: 'attention',
          category: 'payload',
          title: 'Core visible content extends past 100 KB',
          detail: 'RSC payload bloat',
        },
        ...(slug === 'post-3'
          ? [/** @type {const} */ ({ id: 'http_error', severity: 'critical', category: 'headers', title: 'HTTP 404', detail: 'Broken post' })]
          : []),
      ]),
    })),
  ];

  const clustered = clusterIssuesByTemplate(pageResults);

  // Site-wide robots issue
  assert.equal(clustered.siteWide.length, 1);
  assert.equal(clustered.siteWide[0].ruleId, 'ai_search_bots_blocked');

  // Template cluster for /blog/:slug affecting 5/5 pages
  assert.equal(clustered.templateClusters.length, 1);
  const blogCluster = clustered.templateClusters[0];
  assert.equal(blogCluster.template, '/blog/:slug');
  assert.equal(blogCluster.affectedCount, 5);
  assert.equal(blogCluster.totalInTemplate, 5);
  assert.equal(blogCluster.ruleId, 'truncation_core_past_100kb');
  assert.equal(blogCluster.sampleUrls.length, 5);
  assert.match(blogCluster.summary, /Fix 1 template \(\/blog\/:slug\) → fix 5\/5 pages/);

  // Single-page outliers: /pricing canonical_mismatch + /blog/post-3 http_error
  assert.equal(clustered.pageOutliers.length, 2);
  assert.ok(clustered.pageOutliers.some((o) => o.url.endsWith('/blog/post-3') && o.ruleId === 'http_error'));
  assert.ok(clustered.pageOutliers.some((o) => o.url.endsWith('/pricing') && o.ruleId === 'canonical_mismatch'));
});

test('Hard Infrastructure Gate triggers on transport failure, 403, WAF challenge, and empty JS shell, and never false-positives on Turnstile cf-chl-', async (t) => {
  // Unit assertions on evaluateHardGate
  const transportGate = evaluateHardGate({ status: null, transportError: true, error: 'ECONNREFUSED' });
  assert.equal(transportGate.triggered, true);
  assert.equal(transportGate.reason, 'transport_failure');
  assert.equal(transportGate.capStatus, 'blocked_hard_gate');
  assert.equal(transportGate.downstreamStatus, 'not_observed');

  const forbiddenGate = evaluateHardGate({ status: 403, payload: { visibleWordCount: 10, csrRisk: { level: 'low' } } });
  assert.equal(forbiddenGate.triggered, true);
  assert.equal(forbiddenGate.reason, 'http_403_blocked');
  assert.equal(forbiddenGate.downstreamStatus, 'not_observed');

  const wafGate = evaluateHardGate({ status: 200, wafState: 'challenge_or_block_intercepted' });
  assert.equal(wafGate.triggered, true);
  assert.equal(wafGate.reason, 'waf_challenge_intercepted');
  assert.equal(wafGate.downstreamStatus, 'not_observed');

  const emptyShellGate = evaluateHardGate({
    status: 200,
    payload: { visibleWordCount: 0, csrRisk: { level: 'high' } },
  });
  assert.equal(emptyShellGate.triggered, true);
  assert.equal(emptyShellGate.reason, 'empty_js_shell');
  assert.equal(emptyShellGate.downstreamStatus, 'not_observed');

  const healthyGate = evaluateHardGate({
    status: 200,
    wafState: 'edge_detected',
    payload: { visibleWordCount: 450, csrRisk: { level: 'low' } },
  });
  assert.equal(healthyGate.triggered, false);
  assert.equal(healthyGate.downstreamStatus, 'observed');

  // End-to-end: WAF challenge homepage stops downstream crawl and sets not_observed
  let pricingFetched = false;
  const { baseUrl: wafBase } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/pricing') {
      pricingFetched = true;
      res.writeHead(200).end(htmlPage('Pricing', 'Pricing'));
      return;
    }
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
    res.end('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script><a href="/pricing">Pricing</a></body></html>');
  });

  const wafCrawl = await crawlSitePages(`${wafBase}/`, { allowPrivateHosts: true });
  assert.equal(wafCrawl.hardGate.triggered, true);
  assert.equal(wafCrawl.hardGate.reason, 'waf_challenge_intercepted');
  assert.equal(wafCrawl.status, 'blocked_hard_gate');
  assert.equal(wafCrawl.downstreamStatus, 'not_observed');
  assert.equal(pricingFetched, false, 'downstream pages must not be scored when Hard Gate triggers');

  // End-to-end: Empty Vite SPA shell triggers Hard Gate
  const { baseUrl: spaBase } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script type="module" src="/assets/index-ab12.js"></script></body></html>');
  });
  const spaCrawl = await crawlSitePages(`${spaBase}/`, { allowPrivateHosts: true });
  assert.equal(spaCrawl.hardGate.triggered, true);
  assert.equal(spaCrawl.hardGate.reason, 'empty_js_shell');
  assert.equal(spaCrawl.downstreamStatus, 'not_observed');

  // End-to-end: Normal page with Turnstile `cf-chl-` widget does NOT false-positive
  const { baseUrl: turnstileBase } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cf-ray': '8a123456-SJC' });
    res.end(htmlPage('Contact Us', 'Contact Us', '<form><div class="cf-chl-widget" data-sitekey="abc"></div></form>'));
  });
  const turnstileCrawl = await crawlSitePages(`${turnstileBase}/`, { single: true, allowPrivateHosts: true });
  assert.equal(turnstileCrawl.hardGate.triggered, false, 'Turnstile cf-chl- must never false-positive as WAF challenge');
  assert.equal(turnstileCrawl.pages[0].wafState, 'edge_detected');

  // End-to-end: DataDome `x-datadome: protected` on healthy 200 OK -> bot_management_active (NOT Hard Gate),
  // whereas `x-datadome: protected` on 403 -> challenge_or_block_intercepted (trips Hard Gate)
  const { baseUrl: ddOkBase } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'x-datadome': 'protected' });
    res.end(htmlPage('DataDome Protected OK', 'DataDome Protected OK'));
  });
  const ddOkCrawl = await crawlSitePages(`${ddOkBase}/`, { single: true, allowPrivateHosts: true });
  assert.equal(ddOkCrawl.hardGate.triggered, false, 'x-datadome: protected on 200 OK must not trip Hard Gate');
  assert.equal(ddOkCrawl.pages[0].wafState, 'bot_management_active');

  const { baseUrl: ddBlockBase } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(403, { 'content-type': 'text/html', 'x-datadome': 'protected' });
    res.end('<html><head><title>Blocked</title></head><body><p>Please enable JS</p></body></html>');
  });
  const ddBlockCrawl = await crawlSitePages(`${ddBlockBase}/`, { single: true, allowPrivateHosts: true });
  assert.equal(ddBlockCrawl.hardGate.triggered, true);
  assert.equal(ddBlockCrawl.hardGate.reason, 'waf_challenge_intercepted');
  assert.equal(ddBlockCrawl.pages[0].wafState, 'challenge_or_block_intercepted');
});

test('compareCompetitors produces full --vs Competitor X-Ray matrix and explicit deltas', () => {
  const targetCrawl = {
    domain: 'yoursite.example',
    status: 'critical',
    counts: { audited: 12, skipped: 2, errored: 0 },
    robotsTxt: {
      contentSignal: 'search=yes, ai-input=no, ai-train=no',
      crawlers: [
        { bot: 'OAI-SearchBot', allowed: false },
        { bot: 'Claude-SearchBot', allowed: false },
        { bot: 'PerplexityBot', allowed: true },
        { bot: 'Googlebot', allowed: true },
      ],
    },
    pages: [
      {
        url: 'https://yoursite.example/',
        isHomepage: true,
        status: 200,
        visibleWordCount: 180,
        renderedWordCount: 600,
        proseParityPct: 30,
        payloadToProseRatio: 15.2,
        markdownNegotiation: false,
        stack: ['Next.js App Router'],
        wafState: 'bot_management_active',
        findings: [
          { id: 'ai_search_bots_blocked', severity: 'critical', title: 'AI bots blocked' },
          { id: 'csr_empty_shell_high', severity: 'critical', title: 'High CSR risk' },
        ],
      },
    ],
  };

  const competitorA = {
    domain: 'rival-fast.example',
    status: 'pass',
    counts: { audited: 15, skipped: 0, errored: 0 },
    robotsTxt: {
      contentSignal: 'search=yes, ai-input=yes, ai-train=no',
      crawlers: [
        { bot: 'OAI-SearchBot', allowed: true },
        { bot: 'Claude-SearchBot', allowed: true },
        { bot: 'PerplexityBot', allowed: true },
        { bot: 'Googlebot', allowed: true },
      ],
    },
    pages: [
      {
        url: 'https://rival-fast.example/',
        isHomepage: true,
        status: 200,
        visibleWordCount: 720,
        renderedWordCount: 740,
        proseParityPct: 97.3,
        payloadToProseRatio: 2.1,
        markdownNegotiation: true,
        stack: ['Astro'],
        wafState: 'edge_detected',
        findings: [],
      },
    ],
  };

  const competitorB = {
    domain: 'rival-blocked.example',
    status: 'blocked_hard_gate',
    counts: { audited: 1, skipped: 0, errored: 0 },
    robotsTxt: {
      crawlers: [
        { bot: 'OAI-SearchBot', allowed: false },
        { bot: 'Claude-SearchBot', allowed: false },
        { bot: 'PerplexityBot', allowed: false },
        { bot: 'Googlebot', allowed: true },
      ],
    },
    pages: [
      {
        url: 'https://rival-blocked.example/',
        isHomepage: true,
        status: 403,
        visibleWordCount: 12,
        renderedWordCount: 12,
        proseParityPct: 100,
        payloadToProseRatio: 8.0,
        markdownNegotiation: false,
        stack: ['Cloudflare'],
        wafState: 'challenge_or_block_intercepted',
        findings: [{ id: 'hard_infrastructure_gate', severity: 'critical', title: 'WAF Challenge' }],
      },
    ],
  };

  const xray = compareCompetitors(targetCrawl, [competitorA, competitorB]);

  assert.equal(xray.rows.length, 3);
  assert.equal(xray.target.domain, 'yoursite.example');
  assert.equal(xray.target.audited, 12);
  assert.equal(xray.target.skipped, 2);
  assert.equal(xray.target.aiBotsAllowed.allowed, 2);
  assert.equal(xray.target.proseParityPct, 30);
  assert.equal(xray.target.payloadToProseRatio, 15.2);
  assert.equal(xray.target.rawWordsHomepage, 180);
  assert.equal(xray.target.renderedWordsHomepage, 600);
  assert.equal(xray.target.markdownNegotiation, false);
  assert.equal(xray.target.contentSignal, 'search=yes, ai-input=no, ai-train=no');
  assert.deepEqual(xray.target.stack, ['Next.js App Router']);
  assert.equal(xray.target.wafState, 'bot_management_active');
  assert.equal(xray.target.criticalCount, 2);

  // Competitor A beats target on AI bots, prose parity, payload ratio, markdown negotiation, and critical count
  assert.ok(xray.competitorLeads.some((d) => d.competitorDomain === 'rival-fast.example' && d.metric === 'aiBotsAllowed'));
  assert.ok(xray.competitorLeads.some((d) => d.competitorDomain === 'rival-fast.example' && d.metric === 'proseParityPct'));
  assert.ok(xray.competitorLeads.some((d) => d.competitorDomain === 'rival-fast.example' && d.metric === 'payloadToProseRatio'));
  assert.ok(xray.competitorLeads.some((d) => d.competitorDomain === 'rival-fast.example' && d.metric === 'markdownNegotiation'));

  // Target beats Competitor B on AI bots and WAF accessibility
  assert.ok(xray.targetLeads.some((d) => d.competitorDomain === 'rival-blocked.example' && d.metric === 'aiBotsAllowed'));
  assert.ok(xray.targetLeads.some((d) => d.competitorDomain === 'rival-blocked.example' && d.metric === 'wafState'));
});

test('diffAgainstBaseline detects regressions in O(N) while enforcing LibreCrawl 20% word-count noise floor', () => {
  const baseline = {
    finalUrl: 'https://acme.example/',
    robotsTxt: {
      crawlers: [
        { bot: 'OAI-SearchBot', allowed: true, rule: null, matchedGroup: '*' },
        { bot: 'Claude-SearchBot', allowed: true, rule: null, matchedGroup: '*' },
      ],
    },
    pages: [
      {
        url: 'https://acme.example/',
        status: 200,
        visibleWordCount: 1000,
        proseParityPct: 95,
        soft404: false,
        findings: [{ id: 'missing_h1', severity: 'attention', title: 'Missing H1' }],
      },
      {
        url: 'https://acme.example/pricing',
        status: 200,
        visibleWordCount: 500,
        proseParityPct: 92,
        soft404: false,
        findings: [],
      },
      {
        url: 'https://acme.example/docs/api',
        status: 200,
        visibleWordCount: 800,
        proseParityPct: 90,
        soft404: false,
        findings: [],
      },
    ],
  };

  // Case 1: Minor <20% word count jitter (1000 -> 880 = -12%) + resolved finding -> NO regression
  const noisyButClean = {
    finalUrl: 'https://acme.example/',
    robotsTxt: baseline.robotsTxt,
    pages: [
      { url: 'https://acme.example/', status: 200, visibleWordCount: 880, proseParityPct: 94, soft404: false, findings: [] },
      { url: 'https://acme.example/pricing', status: 200, visibleWordCount: 570, proseParityPct: 91, soft404: false, findings: [] },
      { url: 'https://acme.example/docs/api', status: 200, visibleWordCount: 800, proseParityPct: 90, soft404: false, findings: [] },
    ],
  };

  const cleanDiff = diffAgainstBaseline(noisyButClean, baseline);
  assert.equal(cleanDiff.hasRegression, false);
  assert.equal(cleanDiff.wordCountChanges.length, 0, '<20% word-count noise must be suppressed');
  assert.equal(cleanDiff.ignoredWordCountNoise, 2);
  assert.equal(cleanDiff.resolvedFindings.length, 1);
  assert.equal(cleanDiff.resolvedFindings[0].ruleId, 'missing_h1');

  // Case 2: Multiple real regressions (>=20% word drop, status 200->500, prose parity drop, newly blocked bot, new soft-404, new critical)
  const regressed = {
    finalUrl: 'https://acme.example/',
    robotsTxt: {
      crawlers: [
        { bot: 'OAI-SearchBot', allowed: false, rule: 'Disallow: /', matchedGroup: 'OAI-SearchBot' },
        { bot: 'Claude-SearchBot', allowed: true, rule: null, matchedGroup: '*' },
      ],
    },
    pages: [
      {
        url: 'https://acme.example/',
        status: 200,
        visibleWordCount: 600, // -40% drop (>=20%)
        proseParityPct: 42, // dropped from 95 -> 42
        soft404: false,
        findings: [{ id: 'csr_empty_shell_high', severity: 'critical', title: 'High CSR risk' }],
      },
      {
        url: 'https://acme.example/pricing',
        status: 500, // 200 -> 500 regression
        visibleWordCount: 10,
        proseParityPct: 92,
        soft404: false,
        findings: [{ id: 'http_error', severity: 'critical', title: 'HTTP 500' }],
      },
      {
        url: 'https://acme.example/docs/api',
        status: 200,
        visibleWordCount: 40,
        proseParityPct: 90,
        soft404: true, // new soft-404
        title: '404 Not Found',
        findings: [],
      },
    ],
  };

  const badDiff = diffAgainstBaseline(regressed, baseline);
  assert.equal(badDiff.hasRegression, true);
  assert.equal(badDiff.newCriticalFindings.length, 2);
  assert.equal(badDiff.statusRegressions.length, 1);
  assert.equal(badDiff.statusRegressions[0].currentStatus, 500);
  assert.equal(badDiff.proseParityDrops.length, 1);
  assert.equal(badDiff.proseParityDrops[0].dropPct, 53);
  assert.equal(badDiff.newlyBlockedBots.length, 1);
  assert.equal(badDiff.newlyBlockedBots[0].bot, 'OAI-SearchBot');
  assert.equal(badDiff.newSoft404s.length, 1);
  assert.equal(badDiff.newSoft404s[0].url, 'https://acme.example/docs/api');
  assert.ok(badDiff.wordCountChanges.some((c) => c.url === 'https://acme.example/' && c.direction === 'drop'));
});

test('evaluateCiGate enforces exit code 10, mandatory zero-page guard, ignoreCodes precedence, and baseline regression gating', () => {
  // 1. Zero-page guard ALWAYS fails with exit code 10 even when failOn is null and ignoreCodes is set
  const zeroPageReport = {
    counts: { audited: 0, skipped: 0, errored: 1 },
    pages: [],
    findings: [],
  };
  const zeroGate = evaluateCiGate(zeroPageReport, {
    failOn: null,
    ignoreCodes: ['zero_pages_audited', 'hard_infrastructure_gate'],
  });
  assert.equal(zeroGate.passed, false);
  assert.equal(zeroGate.exitCode, CI_GATE_EXIT_CODE);
  assert.equal(zeroGate.exitCode, 10);
  assert.ok(zeroGate.reasons.includes('zero_pages_audited'));

  // 2. Severity gating: critical vs attention
  const reportWithAttentionOnly = {
    counts: { audited: 5, skipped: 0, errored: 0 },
    pages: [
      {
        url: 'https://acme.example/',
        status: 200,
        findings: [{ id: 'missing_h1', severity: 'attention', title: 'Missing H1' }],
      },
    ],
  };

  const critGate = evaluateCiGate(reportWithAttentionOnly, { failOn: 'critical' });
  assert.equal(critGate.passed, true);
  assert.equal(critGate.exitCode, 0);

  const attnGate = evaluateCiGate(reportWithAttentionOnly, { failOn: 'attention' });
  assert.equal(attnGate.passed, false);
  assert.equal(attnGate.exitCode, 10);
  assert.ok(attnGate.reasons.includes('fail_on_attention'));
  assert.equal(attnGate.matchedFindings.length, 1);

  // 3. ignoreCodes takes strict precedence over BOTH failOnCodes AND failOn
  const reportWithCrit = {
    counts: { audited: 3, skipped: 0, errored: 0 },
    pages: [
      {
        url: 'https://acme.example/',
        status: 200,
        findings: [{ id: 'noindex_detected', severity: 'critical', title: 'Page marked noindex' }],
      },
    ],
  };

  const failByCode = evaluateCiGate(reportWithCrit, { failOnCodes: ['noindex_detected'] });
  assert.equal(failByCode.passed, false);
  assert.equal(failByCode.exitCode, 10);
  assert.ok(failByCode.reasons.includes('fail_on_code:noindex_detected'));

  const ignoredWins = evaluateCiGate(reportWithCrit, {
    failOn: 'critical',
    failOnCodes: ['noindex_detected'],
    ignoreCodes: ['noindex_detected'],
  });
  assert.equal(ignoredWins.passed, true, 'ignoreCodes must override both failOn and failOnCodes');
  assert.equal(ignoredWins.exitCode, 0);
  assert.equal(ignoredWins.ignoredCount, 1);

  // 4. failOnRegression integrates with diffAgainstBaseline
  const baselineDiff = diffAgainstBaseline(
    {
      pages: [{ url: 'https://acme.example/', status: 500, visibleWordCount: 0, findings: [] }],
    },
    {
      pages: [{ url: 'https://acme.example/', status: 200, visibleWordCount: 400, findings: [] }],
    },
  );
  const regGate = evaluateCiGate(
    { counts: { audited: 1, skipped: 0, errored: 0 }, pages: [{ url: 'https://acme.example/', status: 500, findings: [] }] },
    { failOn: null, baselineDiff, failOnRegression: true },
  );
  assert.equal(regGate.passed, false);
  assert.equal(regGate.exitCode, 10);
  assert.ok(regGate.reasons.includes('baseline_regression'));
});

test('crawlSitePages resolves 301 redirects without duplicate counting, supports custom pageChecker, and integrates transport failure with CI zero-page guard', async (t) => {
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt' || path === '/sitemap.xml') {
      res.writeHead(404).end();
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(htmlPage('Home', 'Home', '<nav><a href="/pricing">Pricing</a><a href="/old-pricing">Old Pricing</a></nav>'));
      return;
    }
    if (path === '/old-pricing') {
      res.writeHead(301, { location: '/pricing' }).end();
      return;
    }
    if (path === '/pricing') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(htmlPage('Pricing', 'Pricing'));
      return;
    }
    res.writeHead(404).end();
  });

  const crawl = await crawlSitePages(`${baseUrl}/`, {
    allowPrivateHosts: true,
    maxConcurrency: 1,
    pageChecker: (ctx) => ({
      stack: ctx.isHomepage ? ['Astro'] : [],
      markdownNegotiation: true,
    }),
  });

  assert.equal(crawl.counts.audited, 2, '301 /old-pricing -> /pricing must NOT be double-counted as a duplicate page');
  assert.equal(crawl.counts.redirectsResolved, 1);
  assert.equal(crawl.redirectsResolved[0].status, 301);
  assert.deepEqual(crawl.pages[0].stack, ['Astro']);
  assert.equal(crawl.pages[0].markdownNegotiation, true);

  // Transport failure -> counts.audited === 0 + Hard Gate + CI Gate exit code 10
  const failedCrawl = await crawlSitePages('https://unreachable.example/', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(failedCrawl.counts.audited, 0);
  assert.equal(failedCrawl.counts.errored, 1);
  assert.equal(failedCrawl.hardGate.triggered, true);
  assert.equal(failedCrawl.hardGate.reason, 'transport_failure');
  assert.equal(failedCrawl.downstreamStatus, 'not_observed');

  const ciGate = evaluateCiGate(failedCrawl, { failOn: null });
  assert.equal(ciGate.passed, false);
  assert.equal(ciGate.exitCode, 10);
  assert.ok(ciGate.reasons.includes('zero_pages_audited'));
});

test('discoverSitemapUrls rejects gzipped POSIX tar archive masquerading as .xml.gz', async (t) => {
  // Build a minimal 512-byte POSIX tar header with "ustar" at offset 257
  const tarBuf = Buffer.alloc(512, 0);
  tarBuf.write('ustar', 257, 'ascii');
  const gzTar = gzipSync(tarBuf);

  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`Sitemap: http://127.0.0.1:${req.socket.localPort}/disguised.xml.gz\n`);
      return;
    }
    if (req.url === '/disguised.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(gzTar);
      return;
    }
    res.writeHead(404).end();
  });

  const discovered = await discoverSitemapUrls(baseUrl, { allowPrivateHosts: true });
  assert.equal(discovered.urls.length, 0);
  assert.ok(discovered.rejected.some((r) => r.url.endsWith('/disguised.xml.gz') && r.reason === 'ignored_archive'));
});

test('trailing-slash preservation: keeps true HTTP finalUrl, avoids unnecessary 301s, and still deduplicates slash/slashless URLs', async (t) => {
  const fetchedPaths = [];
  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    const reqPath = (req.url ?? '/').split('?')[0];
    fetchedPaths.push(reqPath);
    if (reqPath === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: http://127.0.0.1:${req.socket.localPort}/sitemap.xml\n`);
      return;
    }
    if (reqPath === '/sitemap.xml') {
      const origin = `http://127.0.0.1:${req.socket.localPort}`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/compare/</loc></url>
  <url><loc>${origin}/compare</loc></url>
  <url><loc>${origin}/docs</loc></url>
  <url><loc>${origin}/old-docs</loc></url>
</urlset>`);
      return;
    }
    if (reqPath === '/compare' || reqPath === '/docs' || reqPath === '/old-docs') {
      const target = reqPath === '/compare' ? '/compare/' : '/docs/';
      res.writeHead(301, { location: target });
      res.end();
      return;
    }
    if (reqPath === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Home</title></head><body>' +
          '<nav><a href="/compare/">Compare</a><a href="/compare">Compare Dup</a><a href="/docs">Docs</a><a href="/old-docs">Old Docs</a></nav>' +
          '<h1>Home</h1><p>Welcome to our trailing-slash static site with full SSR content for crawlers.</p></body></html>',
      );
      return;
    }
    if (reqPath === '/compare/' || reqPath === '/docs/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<html><head><title>${reqPath}</title></head><body><h1>${reqPath}</h1><p>Full server-rendered body content for ${reqPath}.</p></body></html>`,
      );
      return;
    }
    res.writeHead(404).end();
  });

  // 1. discoverSitemapUrls preserves /compare/ and deduplicates /compare
  const discovered = await discoverSitemapUrls(baseUrl, { allowPrivateHosts: true });
  assert.ok(discovered.urls.includes(`${baseUrl}/compare/`), 'sitemap must preserve trailing slash');
  assert.ok(!discovered.urls.includes(`${baseUrl}/compare`), 'duplicate slashless URL must be deduplicated');

  // 2. selectKeyPages preserves trailing slash while deduplicating slash/slashless
  const selected = selectKeyPages({
    homepageUrl: `${baseUrl}/`,
    navLinks: [`${baseUrl}/compare/`, `${baseUrl}/compare`],
    sitemapUrls: [`${baseUrl}/compare`],
    maxPages: 5,
  });
  assert.deepEqual(selected.urls, [`${baseUrl}/`, `${baseUrl}/compare/`]);

  // 3. Multi-page crawl fetches /compare/ directly (0 hops), preserves /docs/ finalUrl after 301, and deduplicates /old-docs -> /docs/
  fetchedPaths.length = 0;
  const multi = await crawlSitePages(`${baseUrl}/`, {
    allowPrivateHosts: true,
    maxPages: 10,
    maxConcurrency: 1,
    sleepFn: async () => {},
  });
  const comparePage = multi.pages.find((p) => p.finalUrl === `${baseUrl}/compare/`);
  assert.ok(comparePage, `expected page with finalUrl ${baseUrl}/compare/, got: ${multi.pages.map((p) => p.finalUrl)}`);
  assert.equal(comparePage.redirects.count, 0, 'trailing-slash nav/sitemap link should fetch directly with 0 redirect hops');
  assert.ok(!fetchedPaths.includes('/compare'), 'must not strip trailing slash and trigger unnecessary 301 on /compare');

  const docsPage = multi.pages.find((p) => p.finalUrl === `${baseUrl}/docs/`);
  assert.ok(docsPage, 'redirected /docs -> /docs/ must preserve trailing-slash finalUrl');
  assert.equal(docsPage.redirects.count, 1);
  assert.ok(
    multi.redirectsResolved.some((r) => r.from === `${baseUrl}/old-docs` && r.to === `${baseUrl}/docs/`),
    `expected /old-docs -> /docs/ deduplicated in redirectsResolved, got: ${JSON.stringify(multi.redirectsResolved)}`,
  );

  // 4. Single-page crawl starting on /compare/ preserves trailing slash on crawl.finalUrl and pages[0].finalUrl
  const single = await crawlSitePages(`${baseUrl}/compare/`, {
    allowPrivateHosts: true,
    single: true,
    sleepFn: async () => {},
  });
  assert.equal(single.finalUrl, `${baseUrl}/compare/`);
  assert.equal(single.pages[0].finalUrl, `${baseUrl}/compare/`);
});
