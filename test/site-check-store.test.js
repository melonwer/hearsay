/**
 * Tests for Option 1 Backend:
 * - SQLite `site_checks` table creation & idempotent migration (`core/db.js`)
 * - Persistence, sanitization, size capping, and drift diffing (`core/site-check-store.js`)
 * - Smart auth/utility route filtering (`core/site-crawler.js`)
 * - MCP v2 `hearsay_site_check` (options + SSRF guard) & `hearsay_site_check_history` (`mcp/server.mjs`)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, SCHEMA_VERSION, migrate, openDb, userVersion } from '../core/db.js';
import {
  MAX_REPORT_JSON_BYTES,
  diffSavedSiteChecks,
  getSiteCheck,
  listSiteChecks,
  saveSiteCheck,
} from '../core/site-check-store.js';
import { crawlSitePages, isAuthOrUtilityPath } from '../core/site-crawler.js';

/** Stub Hearsay HTTP server for MCP proxy tests. */
async function stubBackend(routes) {
  /** @type {{method: string, url: string, body: string}[]} */
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? '', url: req.url ?? '', body });
    const hit = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
    res.writeHead(hit?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit?.body ?? { error: { code: 'not_found', message: 'stub: no route' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Spawn `mcp/server.mjs` and enforce strict JSON-RPC stdout purity. */
function startMcp(hearsayUrlOrEnv) {
  const env = { ...process.env };
  if (typeof hearsayUrlOrEnv === 'string') {
    env.HEARSAY_URL = hearsayUrlOrEnv;
  } else {
    Object.assign(env, hearsayUrlOrEnv);
    if (!Object.prototype.hasOwnProperty.call(hearsayUrlOrEnv, 'HEARSAY_URL')) delete env.HEARSAY_URL;
  }
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  /** @type {unknown[]} */
  const lines = [];
  /** @type {((msg: unknown) => void)[]} */
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      const msg = JSON.parse(line);
      lines.push(msg);
      waiters.shift()?.(msg);
    }
  });
  return {
    lines,
    send: (/** @type {object} */ obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    next: () => new Promise((resolve) => waiters.push(resolve)),
    kill: () => child.kill(),
  };
}

/** @param {ReturnType<typeof startMcp>} mcp @param {string} method @param {object} params @param {number} id */
async function rpc(mcp, method, params, id) {
  mcp.send({ jsonrpc: '2.0', id, method, params });
  return /** @type {Promise<any>} */ (mcp.next());
}

/**
 * Boot an ephemeral `node:http` server on 127.0.0.1:0 with automatic teardown.
 * @param {import('node:test').TestContext} t
 * @param {import('node:http').RequestListener} handler
 */
async function startFixtureServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/**
 * Build a minimal SSR HTML page fixture with visible prose.
 * @param {string} title
 * @param {string} heading
 * @param {string} [extraBody]
 */
function htmlPage(title, heading, extraBody = '') {
  const prose = 'Hearsay verifies server-rendered HTML visibility and AI search crawlability signals cleanly. '.repeat(6);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
  ${extraBody}
  <main><h1>${heading}</h1><p>${prose}</p></main>
</body>
</html>`;
}

/**
 * Create a realistic v2 site-check report fixture for store/diff tests.
 * @param {Record<string, any>} [overrides]
 */
function makeV2ReportFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    checkedAt: '2026-11-18T10:00:00Z',
    requestedUrl: 'https://acme.example/',
    finalUrl: 'https://acme.example/',
    domain: 'acme.example',
    mode: 'crawl',
    status: 200,
    crawlStatus: 'pass',
    hardGate: { triggered: false, reason: null, detail: null, capStatus: null, downstreamStatus: 'observed' },
    counts: {
      discovered: 5,
      selected: 3,
      audited: 3,
      skipped: 1,
      errored: 0,
      redirectsResolved: 0,
      skippedByReason: {
        robots_disallowed: 0,
        ssrf_blocked: 0,
        max_pages_cap: 0,
        template_cap: 0,
        auth_or_utility_route: 1,
      },
    },
    proseParityPct: 96.5,
    stack: {
      technologies: [
        { id: 'nextjs-app-router', name: 'Next.js (App Router)', category: 'framework', version: null, confidence: 95, evidence: [], implied: false },
        { id: 'cloudflare', name: 'Cloudflare', category: 'cdn', version: null, confidence: 90, evidence: [], implied: false },
      ],
      primaryFramework: 'nextjs-app-router',
      primaryCdn: 'cloudflare',
      primaryCms: null,
      primaryHosting: null,
      cookieNames: ['__cf_bm'],
      waf: { state: 'edge_detected', vendor: 'Cloudflare' },
    },
    waf: { state: 'edge_detected', vendor: 'Cloudflare' },
    robotsPolicy: {
      bots: [
        { token: 'OAI-SearchBot', category: 'search_retrieval', allowed: true, rule: 'Allow: /', matchedGroup: '*' },
        { token: 'GPTBot', category: 'training', allowed: true, rule: 'Allow: /', matchedGroup: '*' },
      ],
    },
    extraction: {
      extracted: { markdown: '# Acme\n\nFast B2B workflow automation.', tokenCount: 12 },
      forensics: { payloadToProseRatio: 4.2 },
    },
    pages: [
      {
        url: 'https://acme.example/',
        finalUrl: 'https://acme.example/',
        isHomepage: true,
        status: 200,
        visibleWordCount: 400,
        renderedWordCount: 410,
        proseParityPct: 97.6,
        payloadToProseRatio: 4.2,
        soft404: false,
        title: 'Acme Home',
        findings: [],
        extraction: { extracted: { markdown: '# Acme\n\nFast B2B workflow automation.' } },
      },
      {
        url: 'https://acme.example/pricing',
        finalUrl: 'https://acme.example/pricing',
        isHomepage: false,
        status: 200,
        visibleWordCount: 350,
        renderedWordCount: 360,
        proseParityPct: 97.2,
        payloadToProseRatio: 6.4,
        soft404: false,
        title: 'Acme Pricing',
        findings: [],
        extraction: { extracted: { markdown: '# Pricing\n\nSimple transparent tiers.' } },
      },
      {
        url: 'https://acme.example/docs',
        finalUrl: 'https://acme.example/docs',
        isHomepage: false,
        status: 200,
        visibleWordCount: 520,
        renderedWordCount: 530,
        proseParityPct: 98.1,
        payloadToProseRatio: 3.1,
        soft404: false,
        title: 'Acme Docs',
        findings: [],
        extraction: { extracted: { markdown: '# Docs\n\nAPI reference and guides.' } },
      },
    ],
    siteFindings: [],
    findings: [],
    summary: { grade: 'pass', criticalCount: 0, warningCount: 0, infoCount: 1, crawlStatus: 'pass' },
    ...overrides,
  };
}

test('core/db.js creates site_checks table & index on fresh DBs and upgrades existing v18 DBs idempotently', (t) => {
  const mem = openDb(':memory:');
  t.after(() => mem.close());

  assert.equal(userVersion(mem), SCHEMA_VERSION);
  const cols = /** @type {Array<{name: string}>} */ (mem.prepare('PRAGMA table_info(site_checks)').all()).map((c) => c.name);
  assert.deepEqual(cols, [
    'id',
    'url',
    'domain',
    'mode',
    'status',
    'critical_count',
    'warning_count',
    'audited_count',
    'skipped_count',
    'errored_count',
    'prose_parity_pct',
    'median_payload_ratio',
    'content_hash',
    'stack_json',
    'waf_state',
    'report_json',
    'created_at',
  ]);
  const idx = mem
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_site_checks_domain_created'")
    .get();
  assert.ok(idx, 'idx_site_checks_domain_created must exist');

  // Re-running migrate() must be a clean no-op
  assert.equal(migrate(mem), SCHEMA_VERSION);

  // Existing v18 database created BEFORE site_checks existed upgrades seamlessly via openDb()
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-v18-site-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'existing-v18.db');
  const legacyV18 = new DatabaseSync(dbPath);
  for (const m of MIGRATIONS) {
    if (m.version === 2) legacyV18.exec('PRAGMA foreign_keys = OFF');
    legacyV18.exec('BEGIN');
    if (typeof m.apply === 'function') m.apply(legacyV18);
    else legacyV18.exec(String(m.sql));
    legacyV18.exec(`PRAGMA user_version = ${m.version}`);
    legacyV18.exec('COMMIT');
    if (m.version === 2) legacyV18.exec('PRAGMA foreign_keys = ON');
  }
  assert.equal(
    legacyV18.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_checks'").get(),
    undefined,
    'pre-upgrade v18 DB should not have site_checks yet',
  );
  legacyV18.close();

  const upgraded = openDb(dbPath);
  t.after(() => upgraded.close());
  assert.equal(userVersion(upgraded), 18);
  assert.ok(
    upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_checks'").get(),
    'openDb must create site_checks on existing v18 DBs',
  );
});

test('site-check-store saves, lists without report_json blob, retrieves, sanitizes secrets, caps huge payloads, and diffs drift', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());

  const baselineReport = makeV2ReportFixture({
    checkedAt: '2026-11-18T10:00:00Z',
    // Plant sensitive fields to verify they are stripped without mutating caller object
    headers: {
      server: 'cloudflare',
      authorization: 'Bearer super-secret-token',
      'set-cookie': 'session=secret-cookie-val; HttpOnly',
      cookie: 'auth=secret',
    },
    apiKey: 'sk-live-do-not-store',
  });

  const saved1 = saveSiteCheck(db, baselineReport);
  assert.equal(saved1.id, 1);
  assert.equal(saved1.url, 'https://acme.example/');
  assert.equal(saved1.domain, 'acme.example');
  assert.equal(saved1.mode, 'crawl');
  assert.equal(saved1.status, 'pass');
  assert.equal(saved1.criticalCount, 0);
  assert.equal(saved1.warningCount, 0);
  assert.equal(saved1.auditedCount, 3);
  assert.equal(saved1.skippedCount, 1);
  assert.equal(saved1.erroredCount, 0);
  assert.equal(saved1.proseParityPct, 96.5);
  assert.equal(saved1.medianPayloadRatio, 4.2);
  assert.match(saved1.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(saved1.stack, ['Next.js (App Router)', 'Cloudflare']);
  assert.equal(saved1.wafState, 'edge_detected');
  assert.equal(saved1.createdAt, '2026-11-18T10:00:00Z');
  assert.equal(baselineReport.apiKey, 'sk-live-do-not-store', 'caller report must not be mutated');

  // Identical report yields identical contentHash
  const savedDuplicate = saveSiteCheck(db, makeV2ReportFixture({ checkedAt: '2026-11-18T10:05:00Z' }));
  assert.equal(savedDuplicate.contentHash, saved1.contentHash);

  // Verify secrets/cookies were NOT stored in report_json, while safe cookieNames & tokenCount remain
  const fetched1 = getSiteCheck(db, saved1.id);
  assert.ok(fetched1);
  assert.equal(fetched1.id, saved1.id);
  const rawStored = JSON.stringify(fetched1.report);
  assert.ok(!rawStored.includes('super-secret-token'), 'authorization must be stripped');
  assert.ok(!rawStored.includes('secret-cookie-val'), 'set-cookie must be stripped');
  assert.ok(!rawStored.includes('sk-live-do-not-store'), 'apiKey must be stripped');
  assert.deepEqual(fetched1.report.stack.cookieNames, ['__cf_bm'], 'safe cookieNames metadata must be preserved');
  assert.equal(fetched1.report.extraction.extracted.tokenCount, 12, 'safe tokenCount metadata must be preserved');

  // Save a regressed check for acme.example (blocked OAI-SearchBot, pricing 500, critical finding, parity drop)
  const regressedReport = makeV2ReportFixture({
    checkedAt: '2026-11-19T12:00:00Z',
    crawlStatus: 'critical',
    proseParityPct: 22.0,
    robotsPolicy: {
      bots: [
        { token: 'OAI-SearchBot', category: 'search_retrieval', allowed: false, rule: 'Disallow: /', matchedGroup: 'OAI-SearchBot' },
        { token: 'GPTBot', category: 'training', allowed: true, rule: 'Allow: /', matchedGroup: '*' },
      ],
    },
    siteFindings: [
      {
        id: 'ai_search_bots_blocked',
        severity: 'critical',
        category: 'robots',
        title: 'AI search crawler blocked: OAI-SearchBot',
        detail: 'OAI-SearchBot disallowed by robots.txt',
      },
    ],
    pages: [
      {
        url: 'https://acme.example/',
        finalUrl: 'https://acme.example/',
        isHomepage: true,
        status: 200,
        visibleWordCount: 80,
        renderedWordCount: 410,
        proseParityPct: 19.5,
        payloadToProseRatio: 18.5,
        soft404: false,
        title: 'Acme Home',
        findings: [
          {
            id: 'csr_empty_shell_high',
            severity: 'critical',
            category: 'payload',
            title: 'High CSR shell risk',
            detail: 'Raw HTML lost most prose',
          },
        ],
        extraction: { extracted: { markdown: '# Acme\n\nLoading...' } },
      },
      {
        url: 'https://acme.example/pricing',
        finalUrl: 'https://acme.example/pricing',
        isHomepage: false,
        status: 500,
        visibleWordCount: 10,
        renderedWordCount: 10,
        proseParityPct: 100,
        payloadToProseRatio: 12.0,
        soft404: false,
        title: 'Server Error',
        findings: [],
        extraction: { extracted: { markdown: 'Internal Server Error' } },
      },
    ],
    summary: { grade: 'fail', criticalCount: 2, warningCount: 1, infoCount: 0, crawlStatus: 'critical' },
  });

  const saved2 = saveSiteCheck(db, regressedReport);
  assert.notEqual(saved2.contentHash, saved1.contentHash, 'changed findings/markdown must change contentHash');
  assert.equal(saved2.status, 'critical');
  assert.equal(saved2.criticalCount, 2);

  // Save a check on a second domain with --vs mode inferred (when report.mode omitted)
  const vsReport = {
    checkedAt: '2026-11-19T08:00:00Z',
    finalUrl: 'https://rival.example/',
    status: 200,
    competitorXray: { rows: [], deltas: [] },
    summary: { grade: 'pass', criticalCount: 0, warningCount: 0, infoCount: 0 },
  };
  const savedOther = saveSiteCheck(db, vsReport);
  assert.equal(savedOther.domain, 'rival.example');
  assert.equal(savedOther.mode, 'vs');

  // listSiteChecks: newest first, domain filter, limit, and NO report/report_json blob
  const allChecks = listSiteChecks(db);
  assert.equal(allChecks.length, 4);
  assert.deepEqual(
    allChecks.map((c) => c.id),
    [saved2.id, savedOther.id, savedDuplicate.id, saved1.id],
    'must order by created_at DESC, id DESC',
  );
  for (const row of allChecks) {
    assert.equal('report' in row, false, 'listSiteChecks must omit report blob');
    assert.equal('report_json' in row, false, 'listSiteChecks must omit report_json');
  }

  const acmeOnly = listSiteChecks(db, { domain: 'ACME.EXAMPLE', limit: 2 });
  assert.equal(acmeOnly.length, 2);
  assert.deepEqual(acmeOnly.map((c) => c.id), [saved2.id, savedDuplicate.id]);

  // getSiteCheck returns null for unknown / invalid IDs
  assert.equal(getSiteCheck(db, 99999), null);
  assert.equal(getSiteCheck(db, -1), null);

  // diffSavedSiteChecks detects regressions cleanly
  const diffResult = diffSavedSiteChecks(db, saved2.id, saved1.id);
  assert.ok(diffResult);
  assert.equal(diffResult.current.id, saved2.id);
  assert.equal(diffResult.baseline.id, saved1.id);
  assert.equal('report' in diffResult.current, false, 'diff current summary must stay lightweight');
  assert.equal('report' in diffResult.baseline, false, 'diff baseline summary must stay lightweight');
  assert.equal(diffResult.diff.hasRegression, true);
  assert.ok(diffResult.diff.newCriticalFindings.some((f) => f.ruleId === 'ai_search_bots_blocked'));
  assert.ok(diffResult.diff.newlyBlockedBots.some((b) => b.bot === 'OAI-SearchBot'));
  assert.ok(
    diffResult.diff.statusRegressions.some(
      (r) => r.url === 'https://acme.example/pricing' && r.baselineStatus === 200 && r.currentStatus === 500,
    ),
  );
  assert.ok(diffResult.diff.proseParityDrops.some((p) => p.url === 'https://acme.example/'));
  assert.equal(diffSavedSiteChecks(db, saved2.id, 99999), null);

  // Oversized (>2 MiB) report is safely capped without losing diffability
  const hugeReport = makeV2ReportFixture({
    checkedAt: '2026-11-19T13:00:00Z',
    extraction: {
      extracted: { markdown: 'x'.repeat(2_500_000) },
      forensics: { payloadToProseRatio: 5.0 },
    },
  });
  const savedHuge = saveSiteCheck(db, hugeReport);
  const rawRow = /** @type {{report_json: string}} */ (
    db.prepare('SELECT report_json FROM site_checks WHERE id = ?').get(savedHuge.id)
  );
  assert.ok(
    Buffer.byteLength(rawRow.report_json, 'utf8') <= MAX_REPORT_JSON_BYTES,
    'stored report_json must be capped at MAX_REPORT_JSON_BYTES',
  );
  const loadedHuge = getSiteCheck(db, savedHuge.id);
  assert.ok(loadedHuge);
  assert.equal(loadedHuge.report._storageTruncated, true);
  assert.ok(diffSavedSiteChecks(db, savedHuge.id, saved1.id));
});

test('isAuthOrUtilityPath matches auth/account/cart/admin paths and avoids false positives on content routes', () => {
  const shouldMatch = [
    '/login',
    '/LOGIN/',
    '/signin',
    '/sign-in',
    '/signup',
    '/sign-up',
    '/register',
    '/logout',
    '/signout',
    '/auth/callback',
    '/auth/google',
    '/oauth/authorize',
    '/sso/saml',
    '/reset-password',
    '/reset-password/abc',
    '/forgot-password',
    '/account',
    '/account/billing',
    '/cart',
    '/checkout',
    '/checkout/shipping',
    '/wp-login.php',
    '/wp-admin',
    '/wp-admin/edit.php',
    '/en/login',
    '/en-us/checkout',
    'https://acme.example/auth/login?next=/dashboard',
  ];
  for (const p of shouldMatch) {
    assert.equal(isAuthOrUtilityPath(p), true, `expected isAuthOrUtilityPath("${p}") === true`);
  }

  const shouldNotMatch = [
    '/',
    '/pricing',
    '/features',
    '/docs/api/authentication',
    '/blog/oauth-security-guide',
    '/author/jane-doe',
    '/accounts-payable-software',
    '/cartography',
    '',
  ];
  for (const p of shouldNotMatch) {
    assert.equal(isAuthOrUtilityPath(p), false, `expected isAuthOrUtilityPath("${p}") === false`);
  }
});

test('crawlSitePages skips discovered auth/utility routes by default, allows includeAuthRoutes override, and audits explicit auth startUrl', async (t) => {
  /** @type {Set<string>} */
  const fetchedPaths = new Set();

  const { baseUrl } = await startFixtureServer(t, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    fetchedPaths.add(path);
    const origin = `http://127.0.0.1:${req.socket.localPort}`;

    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
      return;
    }
    if (path === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<urlset>
          <url><loc>${origin}/pricing</loc></url>
          <url><loc>${origin}/login</loc></url>
          <url><loc>${origin}/account/settings</loc></url>
          <url><loc>${origin}/checkout</loc></url>
          <url><loc>${origin}/wp-login.php</loc></url>
        </urlset>`,
      );
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        htmlPage(
          'Acme Home',
          'Acme Home',
          '<header><nav><a href="/pricing">Pricing</a><a href="/login">Login</a><a href="/sign-up">Sign Up</a><a href="/cart">Cart</a><a href="/auth/callback">Auth</a></nav></header>',
        ),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlPage(`Page ${path}`, `Heading ${path}`));
  });

  // 1. Default crawl: auth/utility routes are skipped transparently without fetching
  const defaultCrawl = await crawlSitePages(`${baseUrl}/`, { allowPrivateHosts: true });
  const crawledPaths = defaultCrawl.pages.map((p) => new URL(p.finalUrl).pathname);
  assert.deepEqual(crawledPaths.sort(), ['/', '/pricing']);
  assert.equal(defaultCrawl.status, 'pass', 'skipping auth/utility routes should not downgrade a clean site');

  const authSkipped = defaultCrawl.skipped.filter((s) => s.reason === 'auth_or_utility_route');
  const skippedPaths = authSkipped.map((s) => new URL(s.url).pathname).sort();
  assert.deepEqual(skippedPaths, [
    '/account/settings',
    '/auth/callback',
    '/cart',
    '/checkout',
    '/login',
    '/sign-up',
    '/wp-login.php',
  ]);
  assert.equal(defaultCrawl.counts.skippedByReason.auth_or_utility_route, 7);
  assert.equal(fetchedPaths.has('/login'), false, '/login must not be fetched when skipped');
  assert.equal(fetchedPaths.has('/checkout'), false, '/checkout must not be fetched when skipped');

  // 2. Override via includeAuthRoutes: true audits discovered auth routes
  fetchedPaths.clear();
  const includedCrawl = await crawlSitePages(`${baseUrl}/`, {
    allowPrivateHosts: true,
    includeAuthRoutes: true,
  });
  const includedPaths = includedCrawl.pages.map((p) => new URL(p.finalUrl).pathname);
  assert.ok(includedPaths.includes('/login'), 'includeAuthRoutes: true must audit /login');
  assert.ok(includedPaths.includes('/sign-up'), 'includeAuthRoutes: true must audit /sign-up');
  assert.ok(includedPaths.includes('/checkout'), 'includeAuthRoutes: true must audit /checkout');
  assert.equal(includedCrawl.counts.skippedByReason.auth_or_utility_route, 0);

  // 3. Explicit auth URL passed as startUrl is ALWAYS audited even without includeAuthRoutes
  fetchedPaths.clear();
  const directLogin = await crawlSitePages(`${baseUrl}/login`, { allowPrivateHosts: true });
  assert.equal(directLogin.pages[0]?.status, 200);
  assert.equal(new URL(directLogin.pages[0].finalUrl).pathname, '/login');
  assert.equal(fetchedPaths.has('/login'), true, 'explicit auth startUrl must be fetched and audited');
  assert.equal(
    directLogin.skipped.some((s) => new URL(s.url).pathname === '/login'),
    false,
    'explicit auth startUrl must not be listed as skipped',
  );
});

test('MCP hearsay_site_check supports v2 options (single, maxPages, vs, checkCaching, ignoreRobotsForOwnSite) and strictly enforces SSRF guard', async (t) => {
  const targetA = await startFixtureServer(t, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /secret-guide\nAllow: /\n');
      return;
    }
    if (path === '/sitemap.xml' || path === '/llms.txt') {
      res.writeHead(404).end();
      return;
    }
    if (path === '/' && req.headers['if-none-match'] === '"v1-etag"') {
      res.writeHead(304, { etag: '"v1-etag"' }).end();
      return;
    }
    if (path === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        etag: '"v1-etag"',
        'cache-control': 'public, max-age=300',
      });
      res.end(
        htmlPage(
          'Target Alpha',
          'Target Alpha Platform',
          '<nav><a href="/pricing">Pricing</a><a href="/secret-guide">Secret Guide</a></nav>',
        ),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlPage(`Alpha ${path}`, `Alpha ${path}`));
  });

  const targetB = await startFixtureServer(t, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: OAI-SearchBot\nDisallow: /\nUser-agent: *\nAllow: /\n');
      return;
    }
    if (path === '/sitemap.xml' || path === '/llms.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Competitor Beta', 'Competitor Beta'));
  });

  const dir = mkdtempSync(join(tmpdir(), 'hearsay-mcp-v2-'));
  const missingPortFile = join(dir, 'missing.port');
  const guardedMcp = startMcp({
    HEARSAY_PORT_FILE: missingPortFile,
    HEARSAY_SITE_CHECK_ALLOW_PRIVATE_HOSTS: '0',
  });
  const localMcp = startMcp({
    HEARSAY_PORT_FILE: missingPortFile,
    HEARSAY_SITE_CHECK_ALLOW_PRIVATE_HOSTS: '1',
  });
  t.after(() => {
    guardedMcp.kill();
    localMcp.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  await rpc(guardedMcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const toolsList = await rpc(guardedMcp, 'tools/list', {}, 2);
  const siteCheckTool = toolsList.result.tools.find((/** @type {any} */ x) => x.name === 'hearsay_site_check');
  assert.ok(siteCheckTool);
  assert.equal(siteCheckTool.inputSchema.properties.allowPrivateHosts, undefined);
  assert.equal(siteCheckTool.inputSchema.properties.single.type, 'boolean');
  assert.equal(siteCheckTool.inputSchema.properties.maxPages.type, 'integer');
  assert.equal(siteCheckTool.inputSchema.properties.vs.type, 'array');
  assert.equal(siteCheckTool.inputSchema.properties.checkCaching.type, 'boolean');
  assert.equal(siteCheckTool.inputSchema.properties.ignoreRobotsForOwnSite.type, 'boolean');

  // Attempt to pass allowPrivateHosts: true in MCP args MUST STILL be SSRF-blocked!
  const ssrfAttempt = await rpc(
    guardedMcp,
    'tools/call',
    {
      name: 'hearsay_site_check',
      arguments: { url: `${targetA.baseUrl}/`, allowPrivateHosts: true, single: true },
    },
    3,
  );
  assert.equal(ssrfAttempt.result.isError, true);
  assert.equal(JSON.parse(ssrfAttempt.result.content[0].text).error.code, 'ssrf_blocked');

  // Local test-harness MCP with v2 options: multi-page + ignoreRobotsForOwnSite + checkCaching + vs
  await rpc(localMcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const v2Call = await rpc(
    localMcp,
    'tools/call',
    {
      name: 'hearsay_site_check',
      arguments: {
        url: `${targetA.baseUrl}/`,
        single: false,
        maxPages: 5,
        vs: [`${targetB.baseUrl}/`],
        checkCaching: true,
        ignoreRobotsForOwnSite: true,
        timeoutMs: 5000,
      },
    },
    2,
  );
  assert.notEqual(v2Call.result.isError, true);
  assert.equal(v2Call.result.content.length, 2);
  const report = JSON.parse(v2Call.result.content[0].text);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.mode, 'multi');
  assert.equal(report.conditionalCaching.checked, true);
  assert.equal(report.conditionalCaching.supported304, true);
  assert.ok(
    report.pages.some((/** @type {any} */ p) => new URL(p.finalUrl).pathname === '/secret-guide'),
    'ignoreRobotsForOwnSite must audit /secret-guide',
  );
  assert.ok(report.competitorXray, 'vs must populate competitorXray');
  assert.equal(report.competitorXray.competitors.length, 1);
  assert.match(v2Call.result.content[1].text, /Competitor X-Ray:/);

  // Backwards-compatible call with only { url } + single: true
  const singleCall = await rpc(
    localMcp,
    'tools/call',
    { name: 'hearsay_site_check', arguments: { url: `${targetA.baseUrl}/`, single: true } },
    3,
  );
  assert.notEqual(singleCall.result.isError, true);
  const singleReport = JSON.parse(singleCall.result.content[0].text);
  assert.equal(singleReport.mode, 'single');
  assert.equal(singleReport.counts.audited, 1);
});

test('MCP hearsay_site_check_history proxies local HTTP routes and falls back to read-only SQLite', async (t) => {
  // Part A: HTTP proxy mode when local server is running
  const backend = await stubBackend({
    'GET /api/check/history': { status: 200, body: { items: [{ id: 10, domain: 'acme.example' }], source: 'http_stub' } },
    'GET /api/check/10': { status: 200, body: { id: 10, domain: 'acme.example', report: { ok: true }, source: 'http_stub' } },
    'GET /api/check/diff': { status: 200, body: { current: { id: 11 }, baseline: { id: 10 }, diff: { hasRegression: false }, source: 'http_stub' } },
  });
  const mcpHttp = startMcp(backend.url);

  // Part B: Direct read-only SQLite fallback (server not running)
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-mcp-history-'));
  const dbPath = join(dir, 'hearsay.db');
  const db = openDb(dbPath);
  const check1 = saveSiteCheck(db, makeV2ReportFixture({ checkedAt: '2026-11-18T10:00:00Z' }));
  const check2 = saveSiteCheck(
    db,
    makeV2ReportFixture({
      checkedAt: '2026-11-19T10:00:00Z',
      crawlStatus: 'critical',
      siteFindings: [
        {
          id: 'ai_search_bots_blocked',
          severity: 'critical',
          category: 'robots',
          title: 'OAI-SearchBot blocked',
          detail: 'Blocked in robots.txt',
        },
      ],
      summary: { grade: 'fail', criticalCount: 1, warningCount: 0, infoCount: 0, crawlStatus: 'critical' },
    }),
  );
  const otherCheck = saveSiteCheck(
    db,
    makeV2ReportFixture({
      checkedAt: '2026-11-19T09:00:00Z',
      requestedUrl: 'https://other.example/',
      finalUrl: 'https://other.example/',
      domain: 'other.example',
    }),
  );
  db.close();

  const mcpFallback = startMcp({
    HEARSAY_PORT_FILE: join(dir, 'missing.port'),
    HEARSAY_DB_PATH: dbPath,
  });

  const mcpNoDb = startMcp({
    HEARSAY_PORT_FILE: join(dir, 'missing.port'),
    HEARSAY_DB_PATH: join(dir, 'does-not-exist.db'),
  });

  t.after(async () => {
    mcpHttp.kill();
    mcpFallback.kill();
    mcpNoDb.kill();
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Verify HTTP proxy paths
  await rpc(mcpHttp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const httpList = await rpc(
    mcpHttp,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { domain: 'acme.example', limit: 5 } },
    2,
  );
  assert.notEqual(httpList.result.isError, true);
  assert.equal(JSON.parse(httpList.result.content[0].text).source, 'http_stub');
  assert.equal(backend.seen.at(-1).url, '/api/check/history?domain=acme.example&limit=5');

  const httpGet = await rpc(
    mcpHttp,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { id: 10 } },
    3,
  );
  assert.notEqual(httpGet.result.isError, true);
  assert.equal(JSON.parse(httpGet.result.content[0].text).source, 'http_stub');
  assert.equal(backend.seen.at(-1).url, '/api/check/10');

  const httpDiff = await rpc(
    mcpHttp,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { id: 11, compareWithId: 10 } },
    4,
  );
  assert.notEqual(httpDiff.result.isError, true);
  assert.equal(JSON.parse(httpDiff.result.content[0].text).source, 'http_stub');
  assert.equal(backend.seen.at(-1).url, '/api/check/diff?current=11&baseline=10');

  // Verify read-only SQLite fallback: list, filter, get, diff, errors
  await rpc(mcpFallback, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);

  const fbList = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { domain: 'acme.example', limit: 10 } },
    2,
  );
  assert.notEqual(fbList.result.isError, true);
  const listJson = JSON.parse(fbList.result.content[0].text);
  assert.equal(listJson.dataSource, 'sqlite_readonly');
  assert.equal(listJson.count, 2);
  assert.deepEqual(
    listJson.items.map((/** @type {any} */ i) => i.id),
    [check2.id, check1.id],
  );
  assert.equal('report' in listJson.items[0], false);

  const fbGet = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { id: otherCheck.id } },
    3,
  );
  assert.notEqual(fbGet.result.isError, true);
  const getJson = JSON.parse(fbGet.result.content[0].text);
  assert.equal(getJson.dataSource, 'sqlite_readonly');
  assert.equal(getJson.domain, 'other.example');
  assert.ok(getJson.report && getJson.report.schemaVersion === 2);

  const fbDiff = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { id: check2.id, compareWithId: check1.id } },
    4,
  );
  assert.notEqual(fbDiff.result.isError, true);
  const diffJson = JSON.parse(fbDiff.result.content[0].text);
  assert.equal(diffJson.dataSource, 'sqlite_readonly');
  assert.equal(diffJson.current.id, check2.id);
  assert.equal(diffJson.baseline.id, check1.id);
  assert.equal(diffJson.diff.hasRegression, true);
  assert.ok(diffJson.diff.newCriticalFindings.some((/** @type {any} */ f) => f.ruleId === 'ai_search_bots_blocked'));

  const fbNotFound = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { id: 9999 } },
    5,
  );
  assert.equal(fbNotFound.result.isError, true);
  assert.equal(JSON.parse(fbNotFound.result.content[0].text).error.code, 'not_found');

  const fbBadArgs = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: { compareWithId: check1.id } },
    6,
  );
  assert.equal(fbBadArgs.result.isError, true);
  assert.equal(JSON.parse(fbBadArgs.result.content[0].text).error.code, 'invalid_arguments');

  // Missing DB returns clean db_unavailable without creating file
  await rpc(mcpNoDb, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const noDbRes = await rpc(
    mcpNoDb,
    'tools/call',
    { name: 'hearsay_site_check_history', arguments: {} },
    2,
  );
  assert.equal(noDbRes.result.isError, true);
  assert.equal(JSON.parse(noDbRes.result.content[0].text).error.code, 'db_unavailable');
});
