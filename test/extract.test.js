import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  CONSENT_OVERLAY_SELECTORS,
  MAX_EXTRACTION_BYTES,
  MAX_JSONLD_CHECK_VALUES,
  analyzeExtractionForensics,
  diffBotVsHuman,
  extractBotMarkdown,
  stripConsentOverlays,
} from '../core/extract.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RICH_ARTICLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hearsay Extraction Guide - Docs</title>
</head>
<body>
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/pricing">Pricing</a>
      <a href="/docs">Documentation</a>
    </nav>
  </header>
  <main>
    <h1>Hearsay Extraction Guide</h1>
    <p>Hearsay audits how AI search retrieval crawlers parse raw server-rendered HTML compared against what human visitors see in a browser.</p>
    <h2>Pricing Comparison</h2>
    <table>
      <thead>
        <tr><th>Plan</th><th>Crawls</th><th>Price</th></tr>
      </thead>
      <tbody>
        <tr><td>Starter</td><td>100</td><td>$0</td></tr>
        <tr><td>Pro</td><td>5000</td><td>$49</td></tr>
      </tbody>
    </table>
    <h2>CLI Example</h2>
    <pre><code class="language-bash">npx hearsay check https://example.com --render
# prints Bot-vs-Human diff
</code></pre>
  </main>
  <footer><a href="/privacy">Privacy Policy</a></footer>
</body>
</html>`;

test('extractBotMarkdown works with webforai (Reader + Agent mode) and built-in fallback', () => {
  const primary = extractBotMarkdown(RICH_ARTICLE_HTML, { url: 'https://example.com/docs/guide' });
  assert.equal(primary.engine, 'webforai');
  assert.equal(primary.truncatedAt2MiB, false);
  assert.ok(primary.wordCount > 20, `expected >20 words, got ${primary.wordCount}`);
  assert.equal(primary.charCount, primary.markdown.length);
  assert.equal(primary.estimatedTokens, Math.ceil(primary.charCount / 4));
  assert.ok(primary.headings.some((h) => h.level === 1 && h.text === 'Hearsay Extraction Guide'));
  assert.ok(primary.headings.some((h) => h.level === 2 && h.text === 'Pricing Comparison'));
  assert.ok(primary.headings.some((h) => h.level === 2 && h.text === 'CLI Example'));
  // Ensure `# prints Bot-vs-Human diff` inside fenced code block is NOT miscounted as a heading
  assert.ok(!primary.headings.some((h) => h.text.includes('prints Bot-vs-Human diff')));
  assert.equal(primary.tablesCount, 1);
  assert.equal(primary.codeBlocksCount, 1);
  assert.ok(primary.sectionsCount >= 3);
  assert.ok(primary.agentMarkdown.length >= primary.markdown.length);
  assert.match(primary.agentMarkdown, /https:\/\/example\.com\/pricing|## Links/);

  const fallback = extractBotMarkdown(RICH_ARTICLE_HTML, {
    url: 'https://example.com/docs/guide',
    forceFallback: true,
  });
  assert.equal(fallback.engine, 'fallback');
  assert.equal(fallback.truncatedAt2MiB, false);
  assert.ok(fallback.wordCount > 20);
  assert.ok(fallback.headings.some((h) => h.level === 1 && h.text === 'Hearsay Extraction Guide'));
  assert.ok(fallback.headings.some((h) => h.level === 2 && h.text === 'Pricing Comparison'));
  assert.ok(fallback.headings.some((h) => h.level === 2 && h.text === 'CLI Example'));
  assert.ok(!fallback.headings.some((h) => h.text.includes('prints Bot-vs-Human diff')));
  assert.equal(fallback.tablesCount, 1);
  assert.equal(fallback.codeBlocksCount, 1);
  assert.ok(fallback.sectionsCount >= 3);
  assert.match(fallback.agentMarkdown, /## Links/);
  assert.match(fallback.agentMarkdown, /https:\/\/example\.com\/pricing/);
});

test('core/extract.js runs cleanly with zero node_modules (extracted plugin archive guarantee)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-extract-no-deps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const standalone = join(dir, 'extract.mjs');
  copyFileSync(join(root, 'core', 'extract.js'), standalone);

  const script = `
    import assert from 'node:assert/strict';
    import { extractBotMarkdown, diffBotVsHuman, analyzeExtractionForensics } from ${JSON.stringify(pathToFileURL(standalone).href)};
    const botHtml = '<html><body><main><h1>Hello</h1><p>Initial shell text only.</p></main></body></html>';
    const humanHtml = '<html><body><main><h1>Hello</h1><h2>Loaded Section</h2><p>Initial shell text only.</p><p>Hydrated paragraph with detailed specifications for customers.</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></main></body></html>';
    const extracted = extractBotMarkdown(humanHtml, { url: 'https://example.com/' });
    assert.equal(extracted.engine, 'fallback');
    assert.equal(extracted.tablesCount, 1);
    const diff = diffBotVsHuman({ botHtml, humanHtml, url: 'https://example.com/' });
    assert.equal(diff.engine, 'fallback');
    assert.equal(diff.diffEngine, 'fallback');
    assert.equal(diff.lostTables, 1);
    assert.ok(diff.missingHeadings.some((h) => h.text === 'Loaded Section'));
    const forensics = analyzeExtractionForensics(humanHtml);
    assert.ok(forensics.rawHtmlBytes > 0);
    console.log('zero-node-modules-ok');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zero-node-modules-ok/);
});

test('extractBotMarkdown enforces strict 2 MiB UTF-8 input cap without hanging', () => {
  const paddingBlock = '<p>Repeated filler paragraph for testing the two megabyte truncation guard in Hearsay.</p>\n';
  const count = Math.ceil((MAX_EXTRACTION_BYTES + 256 * 1024) / Buffer.byteLength(paddingBlock, 'utf8'));
  const hugeHtml = `<!doctype html><html><body><main><h1>Giant Page</h1>${paddingBlock.repeat(count)}</main></body></html>`;
  assert.ok(Buffer.byteLength(hugeHtml, 'utf8') > MAX_EXTRACTION_BYTES);

  const start = Date.now();
  const res = extractBotMarkdown(hugeHtml, { includeAgentMode: false });
  const elapsedMs = Date.now() - start;

  assert.equal(res.truncatedAt2MiB, true);
  assert.ok(res.wordCount > 100);
  assert.ok(elapsedMs < 10_000, `2 MiB guard took too long: ${elapsedMs}ms`);
});

test('stripConsentOverlays removes all 20+ SiteOne cookie/dialog overlays and preserves main content', () => {
  assert.ok(CONSENT_OVERLAY_SELECTORS.length >= 20);

  const overlays = [
    '<div id="onetrust-consent-sdk"><div class="nested"><p>OneTrust Cookie Banner</p></div></div>',
    '<div id="onetrust-banner-sdk">OneTrust Secondary Banner</div>',
    '<div id="CybotCookiebotDialog"><div>Cookiebot Dialog</div></div>',
    '<div id="CybotCookiebotDialogBodyUnderlay">Cookiebot Underlay</div>',
    '<div id="didomi-host"><div class="didomi-inner">Didomi Host Notice</div></div>',
    '<div id="didomi-popup">Didomi Popup</div>',
    '<div id="qc-cmp2-container">Quantcast Choice CMP</div>',
    '<div id="truste-consent-track">TrustArc Consent</div>',
    '<div id="usercentrics-root">Usercentrics Root</div>',
    '<div id="sp_message_container_98765">Sourcepoint Message</div>',
    '<div id="cmplz-cookiebanner-container">Complianz Banner</div>',
    '<div id="cookie-law-info-bar">Cookie Law Info Bar</div>',
    '<div id="klaro">Klaro Consent Manager</div>',
    '<div id="tarteaucitronRoot">Tarteaucitron Panel</div>',
    '<div id="osano-cm-window">Osano Window</div>',
    '<div id="iubenda-cs-banner">Iubenda Banner</div>',
    '<div id="cky-consent-container">CookieYes v3 Container</div>',
    '<div class="cc-window cc-floating">CookieConsent Window</div>',
    '<section class="cookie-banner">Generic Cookie Banner</section>',
    '<aside class="cookie-consent">Generic Cookie Consent</aside>',
    '<div class="cookie-notice">Generic Cookie Notice</div>',
    '<div role="dialog" aria-modal="true"><div class="modal-body">Modal Overlay Prompt</div></div>',
    '<div role="alertdialog">Alert Dialog Consent</div>',
  ];

  const html = `<!doctype html>
  <html>
  <body class="cookie-banner-open">
    ${overlays.join('\n')}
    <main>
      <h1>Preserved Primary Heading</h1>
      <p>Actual article prose that must survive overlay stripping intact.</p>
    </main>
  </body>
  </html>`;

  const stripped = stripConsentOverlays(html);
  assert.match(stripped, /Preserved Primary Heading/);
  assert.match(stripped, /Actual article prose that must survive overlay stripping intact/);
  assert.match(stripped, /<body class="cookie-banner-open">/);

  for (const marker of [
    'OneTrust Cookie Banner',
    'OneTrust Secondary Banner',
    'Cookiebot Dialog',
    'Cookiebot Underlay',
    'Didomi Host Notice',
    'Didomi Popup',
    'Quantcast Choice CMP',
    'TrustArc Consent',
    'Usercentrics Root',
    'Sourcepoint Message',
    'Complianz Banner',
    'Cookie Law Info Bar',
    'Klaro Consent Manager',
    'Tarteaucitron Panel',
    'Osano Window',
    'Iubenda Banner',
    'CookieYes v3 Container',
    'CookieConsent Window',
    'Generic Cookie Banner',
    'Generic Cookie Consent',
    'Generic Cookie Notice',
    'Modal Overlay Prompt',
    'Alert Dialog Consent',
  ]) {
    assert.ok(!stripped.includes(marker), `overlay text was not stripped: ${marker}`);
  }
});

test('diffBotVsHuman detects missing headings, dropped paragraphs, lost tables, lost code blocks, and parity ratio', () => {
  const botHtml = `<!doctype html><html><body>
    <div id="onetrust-consent-sdk"><p>Accept all cookies</p></div>
    <main>
      <h1>Acme Analytics</h1>
      <p>Fast telemetry for modern engineering teams.</p>
    </main>
  </body></html>`;

  const humanHtml = `<!doctype html><html><body>
    <main>
      <h1>Acme Analytics</h1>
      <p>Fast telemetry for modern engineering teams.</p>
      <h2>Enterprise Pricing</h2>
      <p>Every plan includes unlimited seats, automated anomaly alerts, and single sign-on support.</p>
      <table>
        <thead><tr><th>Tier</th><th>Monthly</th></tr></thead>
        <tbody><tr><td>Team</td><td>$99</td></tr><tr><td>Enterprise</td><td>$499</td></tr></tbody>
      </table>
      <h2>SDK Quickstart</h2>
      <pre><code class="language-js">import { init } from 'acme-sdk';
init({ projectId: 'demo' });
</code></pre>
    </main>
  </body></html>`;

  for (const forceFallback of [false, true]) {
    const res = diffBotVsHuman({ botHtml, humanHtml, url: 'https://acme.example/', forceFallback });
    assert.equal(res.engine, forceFallback ? 'fallback' : 'webforai');
    assert.equal(res.diffEngine, forceFallback ? 'fallback' : 'diff');
    assert.ok(res.hunks.length >= 1, 'expected structured diff hunks');
    assert.ok(res.diffSummary.addedLines > 0);
    assert.ok(res.missingHeadings.some((h) => h.text === 'Enterprise Pricing'));
    assert.ok(res.missingHeadings.some((h) => h.text === 'SDK Quickstart'));
    assert.ok(res.droppedParagraphs.some((p) => p.includes('unlimited seats')));
    assert.equal(res.lostTables, 1);
    assert.equal(res.lostCodeBlocks, 1);
    assert.ok(res.proseParityRatio !== null && res.proseParityRatio > 0 && res.proseParityRatio < 0.5);
    assert.equal(res.edgeMarkdownCsrTrap, false);
    assert.equal(res.missingVaryAccept, false);
  }
});

test('diffBotVsHuman catches Edge Markdown CSR trap and missing Vary: Accept header', () => {
  const humanHtml = `<!doctype html><html><body><main>
    <h1>Cloud Documentation</h1>
    <p>Comprehensive API reference covering authentication, rate limits, webhooks, pagination, and SDK configuration across all regions.</p>
    <p>Detailed error handling guidelines explain retry backoff, idempotency keys, and structured diagnostic codes for production clients.</p>
  </main></body></html>`;

  const csrTrap = diffBotVsHuman({
    botHtml: '<html><body><div id="root"></div></body></html>',
    humanHtml,
    edgeMarkdown: '- [Home](/)\n- [Login](/login)\n',
    edgeHeaders: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: 'Accept-Encoding',
      'x-markdown-tokens': '14',
    },
  });
  assert.equal(csrTrap.edgeMarkdownCsrTrap, true);
  assert.ok(csrTrap.edgeParityRatio !== null && csrTrap.edgeParityRatio < 0.5);
  assert.equal(csrTrap.missingVaryAccept, true);
  assert.equal(csrTrap.edge?.xMarkdownTokens, 14);
  assert.ok(csrTrap.edgeHunks.length >= 1);

  const compliant = diffBotVsHuman({
    botHtml: humanHtml,
    humanHtml,
    edgeMarkdown: '# Cloud Documentation\n\nComprehensive API reference covering authentication, rate limits, webhooks, pagination, and SDK configuration across all regions.\n\nDetailed error handling guidelines explain retry backoff, idempotency keys, and structured diagnostic codes for production clients.\n',
    edgeHeaders: new Headers({
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: 'Accept-Encoding, Accept',
      'x-markdown-tokens': '58',
    }),
  });
  assert.equal(compliant.edgeMarkdownCsrTrap, false);
  assert.equal(compliant.missingVaryAccept, false);
  assert.equal(compliant.edge?.xMarkdownTokens, 58);
});

test('analyzeExtractionForensics measures 15x Next.js RSC Payload-to-Prose bloat, buckets, and DOM counts', () => {
  const flightChunk = `self.__next_f.push([1,"${'x'.repeat(30 * 1024)}"]);`;
  const nextDataPayload = JSON.stringify({ props: { pageProps: { pad: 'y'.repeat(10 * 1024) } } });
  const largeJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Next.js Hydration Analysis',
    description: 'z'.repeat(28 * 1024),
  });
  const base64Img = `data:image/png;base64,${'A'.repeat(4096)}`;
  const manySpans = '<span></span>'.repeat(1250);

  const html = `<!doctype html><html>
    <head>
      <title>Next.js Hydration Analysis</title>
      <style>.hero{color:#111;${'/*css*/'.repeat(1000)}}</style>
      <script type="application/ld+json">${largeJsonLd}</script>
    </head>
    <body>
      <header><nav>Docs Pricing Blog Sign In</nav></header>
      <main>
        <h1>Next.js Hydration Analysis</h1>
        <p>Concise human-visible prose paragraph explaining payload bloat.</p>
        <svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>
        <img src="${base64Img}" alt="inline">
        <div aria-hidden="true">${manySpans}</div>
      </main>
      <script>${flightChunk}</script>
      <script id="__NEXT_DATA__" type="application/json">${nextDataPayload}</script>
    </body>
  </html>`;

  const f = analyzeExtractionForensics(html);
  assert.ok(f.payloadToProseRatio >= 15, `expected >=15x ratio, got ${f.payloadToProseRatio}`);
  assert.ok(f.nextFlightBytes >= 30 * 1024);
  assert.ok(f.nextDataBytes >= 10 * 1024);
  assert.ok(f.jsonLdBytes >= 28 * 1024);
  assert.ok(f.inlineScriptBytes >= f.nextFlightBytes + f.nextDataBytes);
  assert.ok(f.inlineStyleBytes >= 7000);
  assert.equal(f.largeNonJsonLdBlobs.length, 1, 'JSON-LD >=25KB must be excluded from largeNonJsonLdBlobs');
  assert.equal(f.largeNonJsonLdBlobs[0].isNextFlight, true);
  assert.ok(f.inlineSvgBytes > 0);
  assert.ok(f.base64ImageBytes > 4096);
  assert.ok(f.domNodeEstimate > 1200);
  assert.equal(f.domNodeStatus, 'bloated');
  assert.equal(f.domNodesUnder600, false);
  assert.equal(f.domNodesOver1200, true);
  assert.ok(f.contentStartPosition !== null && f.contentStartPosition > 0);
  assert.ok(f.firstH1HtmlByteOffset !== null && f.firstH1HtmlByteOffset > 0);
});

test('analyzeExtractionForensics calculates collapsedShare and dataNosnippetShare accurately', () => {
  const collapsedBody = 'Hidden technical specification details that require user clicks to expand. '.repeat(6);
  const nosnippetBody = 'Legal disclaimer and pricing footnote suppressed from search snippets. '.repeat(4);
  const html = `<!doctype html><html><body><main>
    <h1>Product Overview</h1>
    <p>Short visible intro paragraph.</p>
    <details>
      <summary>Specifications</summary>
      <p>${collapsedBody}</p>
    </details>
    <div role="tabpanel" hidden><p>Secondary tab panel content hidden by default.</p></div>
    <div aria-hidden="true"><p>Aria hidden decorative accordion duplicate.</p></div>
    <details open><summary>Always Visible FAQ</summary><p>Open details stays visible.</p></details>
    <section data-nosnippet><p>${nosnippetBody}</p></section>
  </main></body></html>`;

  const f = analyzeExtractionForensics(html);
  assert.ok(f.collapsedShare >= 0.5, `expected collapsedShare >= 0.5, got ${f.collapsedShare}`);
  assert.equal(f.collapsedShareWarning, true);
  assert.ok(f.dataNosnippetShare >= 0.25);
  assert.ok(f.dataNosnippetChars > 100);

  // Also test dataNosnippetWarning >= 0.3 directly
  const heavyNosnippetHtml = `<html><body><main>
    <p>Visible summary.</p>
    <div data-nosnippet><p>${'Suppressed body copy excluded from snippets. '.repeat(10)}</p></div>
  </main></body></html>`;
  const f2 = analyzeExtractionForensics(heavyNosnippetHtml);
  assert.ok(f2.dataNosnippetShare >= 0.3);
  assert.equal(f2.dataNosnippetWarning, true);
});

test('analyzeExtractionForensics performs JSON-LD visible-text cross-check with 200-value cap', () => {
  const productLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Acme Widget Pro',
    sku: 'AWP-9000',
    offers: { '@type': 'Offer', price: '199.00', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: 'Jane Doe' },
    telephone: '+1-555-010-9999',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '123 Market St',
      addressLocality: 'San Francisco',
    },
  };
  const ghostLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Unrendered Phantom Headline',
  };

  const html = `<!doctype html><html>
    <head>
      <script type="application/ld+json">${JSON.stringify(productLd)}</script>
      <script type="application/ld+json">${JSON.stringify(ghostLd)}</script>
      <script type="application/ld+json">{ invalid json</script>
    </head>
    <body><main>
      <h1>Acme Widget Pro</h1>
      <p>SKU: AWP-9000 — $199 by Jane Doe. Call (555) 010-9999 or visit 123 Market St, San Francisco.</p>
    </main></body>
  </html>`;

  const f = analyzeExtractionForensics(html);
  assert.equal(f.jsonLdCrossCheck.blocksCount, 3);
  assert.equal(f.jsonLdCrossCheck.parseErrors, 1);
  assert.equal(f.jsonLdCrossCheck.truncatedAt200, false);
  assert.equal(f.jsonLdCrossCheck.missingCount, 1);
  assert.equal(f.jsonLdCrossCheck.missing[0].value, 'Unrendered Phantom Headline');
  assert.ok(f.jsonLdCrossCheck.matchedCount >= 6);
  assert.ok(f.jsonLdCrossCheck.matchRatio !== null && f.jsonLdCrossCheck.matchRatio > 0.8);

  // Verify 200-value cap
  const manyGraph = Array.from({ length: 240 }, (_, idx) => ({
    '@type': 'Thing',
    name: `Entity Item ${idx}`,
  }));
  const capHtml = `<html><head><script type="application/ld+json">${JSON.stringify({ '@graph': manyGraph })}</script></head><body><p>Entity Item 0</p></body></html>`;
  const capped = analyzeExtractionForensics(capHtml);
  assert.equal(capped.jsonLdCrossCheck.checkedCount, MAX_JSONLD_CHECK_VALUES);
  assert.equal(capped.jsonLdCrossCheck.truncatedAt200, true);
  assert.equal(capped.jsonLdCrossCheck.matchedCount, 1);
});

test('analyzeExtractionForensics excludes embedded <svg><title> and detects soft-404 cleanly', () => {
  const svgHtml = `<!doctype html><html>
    <head>
      <svg><title>Icon Logo Title</title></svg>
      <title>Actual Document Title</title>
    </head>
    <body>
      <svg aria-hidden="true"><title>Second SVG Title</title></svg>
      <main><h1>Actual Document Title</h1><p>Valid page content.</p></main>
    </body>
  </html>`;
  const svgRes = analyzeExtractionForensics(svgHtml);
  assert.equal(svgRes.documentTitle, 'Actual Document Title');
  assert.equal(svgRes.embeddedSvgTitlesIgnored, 2);
  assert.equal(svgRes.soft404.detected, false);

  const soft404Html = `<!doctype html><html><head><title>404 - Page Not Found</title></head>
    <body><main><h1>Page Not Found</h1><p>The page you requested could not be found.</p></main></body></html>`;
  const soft404Res = analyzeExtractionForensics(soft404Html);
  assert.equal(soft404Res.soft404.detected, true);
  assert.ok(soft404Res.soft404.mainTextChars < 1000);

  const long404Guide = `<!doctype html><html><head><title>Fixing HTTP 404 Not Found Errors</title></head>
    <body><main><h1>Fixing HTTP 404 Not Found Errors</h1><p>${'Detailed engineering guide explaining how to audit broken links and redirect maps. '.repeat(20)}</p></main></body></html>`;
  const guideRes = analyzeExtractionForensics(long404Guide);
  assert.equal(guideRes.soft404.detected, false);
  assert.ok(guideRes.soft404.mainTextChars >= 1000);
});

test('analyzeExtractionForensics implements Gatsby-safe <noscript> check', () => {
  // Empty CRA/Vite SPA shell (< 25 chars raw main text) -> MUST flag
  const craShell = `<!doctype html><html><head><title>App</title></head>
    <body>
      <noscript>You need to enable JavaScript to run this app.</noscript>
      <div id="root"></div>
      <script src="/bundle.js"></script>
    </body></html>`;
  const craRes = analyzeExtractionForensics(craShell);
  assert.equal(craRes.noscriptAppShell.hasNoscript, true);
  assert.equal(craRes.noscriptAppShell.hasJsWarning, true);
  assert.equal(craRes.noscriptAppShell.rawMainTextChars, 0);
  assert.equal(craRes.noscriptAppShell.flagged, true);

  // Gatsby SSR page with <noscript> warning alongside full pre-rendered prose -> MUST NOT flag
  const gatsbySsr = `<!doctype html><html><head><title>Gatsby Blog</title></head>
    <body>
      <noscript id="gatsby-noscript">This app works best with JavaScript enabled.</noscript>
      <div id="___gatsby">
        <main>
          <h1>Server-Rendered Gatsby Post</h1>
          <p>Gatsby statically generates the full HTML article at build time so search engines and AI bots read every sentence.</p>
        </main>
      </div>
    </body></html>`;
  const gatsbyRes = analyzeExtractionForensics(gatsbySsr);
  assert.equal(gatsbyRes.noscriptAppShell.hasNoscript, true);
  assert.equal(gatsbyRes.noscriptAppShell.hasJsWarning, true);
  assert.ok(gatsbyRes.noscriptAppShell.rawMainTextChars >= 25);
  assert.equal(gatsbyRes.noscriptAppShell.flagged, false);
});

test('analyzeExtractionForensics detects Multi-Section / SaaS Drop Warning and Markdown Truncation Cliffs', () => {
  const saasHtml = `<!doctype html><html><body>
    <section><h1>Acme Cloud</h1><p>Unified observability platform for distributed systems.</p></section>
    <section><h2>Core Features</h2><p>Real-time traces, logs, and metrics in a single dashboard.</p></section>
    <section><h2>Pricing Plans</h2>
      <table>
        <thead><tr><th>Tier</th><th>Price</th></tr></thead>
        <tbody><tr><td>Pro</td><td>$49</td></tr><tr><td>Scale</td><td>$199</td></tr></tbody>
      </table>
    </section>
    <section><h2>Frequently Asked Questions</h2><p>Cancel anytime with zero lock-in fees.</p></section>
  </body></html>`;

  // Simulate an extractor that kept only Hero and dropped Pricing table + FAQ section
  const simulatedTruncatedExtraction = {
    engine: /** @type {'webforai'} */ ('webforai'),
    markdown: '# Acme Cloud\n\nUnified observability platform for distributed systems.',
    agentMarkdown: '# Acme Cloud\n\nUnified observability platform for distributed systems.',
    wordCount: 9,
    charCount: 68,
    estimatedTokens: 17,
    headings: [{ level: 1, text: 'Acme Cloud' }],
    tablesCount: 0,
    codeBlocksCount: 0,
    sectionsCount: 1,
    truncatedAt2MiB: false,
  };

  const dropRes = analyzeExtractionForensics(saasHtml, undefined, { extracted: simulatedTruncatedExtraction });
  assert.equal(dropRes.multiSectionDrop.warning, true);
  assert.equal(dropRes.multiSectionDrop.bodySectionsCount, 4);
  assert.equal(dropRes.multiSectionDrop.bodyTablesCount, 1);
  assert.equal(dropRes.multiSectionDrop.droppedTablesCount, 1);
  assert.ok(dropRes.multiSectionDrop.droppedHeadings.includes('Pricing Plans'));
  assert.ok(dropRes.multiSectionDrop.droppedHeadings.includes('Frequently Asked Questions'));
  assert.ok(dropRes.multiSectionDrop.reason !== null);

  // Markdown truncation cliffs: <=50K pass, >50K warn, >100K fail
  const warnRes = analyzeExtractionForensics(saasHtml, undefined, {
    extracted: { ...simulatedTruncatedExtraction, charCount: 60_000 },
  });
  assert.equal(warnRes.markdownTruncation.status, 'warn');
  assert.equal(warnRes.markdownTruncation.exceeds50k, true);
  assert.equal(warnRes.markdownTruncation.exceeds100k, false);

  const failRes = analyzeExtractionForensics(saasHtml, undefined, {
    extracted: { ...simulatedTruncatedExtraction, charCount: 110_000 },
  });
  assert.equal(failRes.markdownTruncation.status, 'fail');
  assert.equal(failRes.markdownTruncation.exceeds50k, true);
  assert.equal(failRes.markdownTruncation.exceeds100k, true);
});
