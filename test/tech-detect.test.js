import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_CRAWLER_REGISTRY, AI_CRAWLER_BY_TOKEN, TECH_SIGNATURES } from '../core/tech-signatures.js';
import {
  extractCookieNames,
  detectStackAndWaf,
  analyzeRobotsPolicy,
  analyzeCachingHeaders,
  probeDnsHints,
} from '../core/tech-detect.js';
import { buildRemediationPlan } from '../core/remediation.js';

// ============================================================================
// 1. REGISTRY & SIGNATURE INTEGRITY
// ============================================================================

test('AI_CRAWLER_REGISTRY contains all 18 canonical crawlers + 3 policy signals with complete metadata', () => {
  const byCategory = {
    search_retrieval: AI_CRAWLER_REGISTRY.filter((b) => b.category === 'search_retrieval').map((b) => b.token),
    user_fetch: AI_CRAWLER_REGISTRY.filter((b) => b.category === 'user_fetch').map((b) => b.token),
    mixed_search_ai: AI_CRAWLER_REGISTRY.filter((b) => b.category === 'mixed_search_ai').map((b) => b.token),
    training: AI_CRAWLER_REGISTRY.filter((b) => b.category === 'training').map((b) => b.token),
    policy_signal: AI_CRAWLER_REGISTRY.filter((b) => b.category === 'policy_signal').map((b) => b.token),
  };

  assert.deepEqual(byCategory.search_retrieval, [
    'OAI-SearchBot',
    'Claude-SearchBot',
    'PerplexityBot',
    'Amazonbot',
    'DuckAssistBot',
  ]);
  assert.deepEqual(byCategory.user_fetch, [
    'ChatGPT-User',
    'Claude-User',
    'Perplexity-User',
    'meta-externalfetcher',
    'MistralAI-User',
  ]);
  assert.deepEqual(byCategory.mixed_search_ai, ['Googlebot', 'Bingbot', 'Applebot']);
  assert.deepEqual(byCategory.training, ['GPTBot', 'ClaudeBot', 'meta-externalagent', 'Bytespider', 'CCBot']);
  assert.deepEqual(byCategory.policy_signal, ['Google-Extended', 'Applebot-Extended', '__usage_ai-training']);

  // 18 crawler bots + 3 policy signals = 21 total
  assert.equal(AI_CRAWLER_REGISTRY.length, 21);

  for (const entry of AI_CRAWLER_REGISTRY) {
    assert.equal(typeof entry.token, 'string');
    assert.equal(typeof entry.vendor, 'string');
    assert.equal(typeof entry.executesJs, 'boolean');
    assert.ok(typeof entry.respectsRobots === 'boolean' || entry.respectsRobots === 'unclear');
    assert.ok(entry.ipFeedUrl === null || entry.ipFeedUrl.startsWith('https://'));
    assert.equal(AI_CRAWLER_BY_TOKEN.get(entry.token.toLowerCase()), entry);
  }

  // Standalone AI search & user fetchers do NOT execute JS; mixed search bots DO
  assert.equal(AI_CRAWLER_BY_TOKEN.get('oai-searchbot')?.executesJs, false);
  assert.equal(AI_CRAWLER_BY_TOKEN.get('claude-searchbot')?.executesJs, false);
  assert.equal(AI_CRAWLER_BY_TOKEN.get('perplexitybot')?.executesJs, false);
  assert.equal(AI_CRAWLER_BY_TOKEN.get('googlebot')?.executesJs, true);
  assert.equal(AI_CRAWLER_BY_TOKEN.get('bingbot')?.executesJs, true);
  assert.equal(AI_CRAWLER_BY_TOKEN.get('applebot')?.executesJs, true);
});

test('TECH_SIGNATURES ships ~65+ unique curated rules with valid implies chains', () => {
  assert.ok(TECH_SIGNATURES.length >= 60, `Expected >= 60 signatures, got ${TECH_SIGNATURES.length}`);
  const ids = new Set(TECH_SIGNATURES.map((s) => s.id));
  assert.equal(ids.size, TECH_SIGNATURES.length, 'Signature IDs must be unique');

  for (const sig of TECH_SIGNATURES) {
    if (sig.implies) {
      for (const target of sig.implies) {
        assert.ok(ids.has(target), `Signature ${sig.id} implies unknown target ${target}`);
      }
    }
  }
});

// ============================================================================
// 2. NEXT.JS APP ROUTER VS PAGES ROUTER VS VITE SPA DISAMBIGUATION
// ============================================================================

test('detectStackAndWaf cleanly separates Next.js App Router, Pages Router, and Vite SPA', () => {
  // Next.js App Router
  const appRouter = detectStackAndWaf({
    url: 'https://app.example.com/',
    status: 200,
    headers: {
      'x-nextjs-prerender': '1',
      vary: 'RSC, Next-Router-State-Tree, Next-Router-Prefetch',
      'x-vercel-id': 'iad1::abcde-12345',
    },
    html: `<!doctype html><html><head><script src="/_next/static/chunks/app/layout-123.js"></script></head>
      <body><main><h1>Docs</h1><p>Server rendered App Router content.</p></main>
      <script>self.__next_f.push([1,"hello"])</script></body></html>`,
  });
  const appIds = new Set(appRouter.technologies.map((t) => t.id));
  assert.equal(appRouter.primaryFramework, 'nextjs-app-router');
  assert.ok(appIds.has('nextjs-app-router'));
  assert.ok(appIds.has('nextjs'));
  assert.ok(appIds.has('react'));
  assert.ok(appIds.has('vercel'));
  assert.ok(!appIds.has('nextjs-pages-router'));
  assert.ok(!appIds.has('vite-spa'));

  // Next.js Pages Router (even if x-nextjs-prerender is present, __NEXT_DATA__ disambiguates!)
  const pagesRouter = detectStackAndWaf({
    url: 'https://pages.example.com/',
    status: 200,
    headers: {
      'x-powered-by': 'Next.js 14.2.5',
      'x-nextjs-prerender': '1',
    },
    html: `<!doctype html><html><head><script src="/_next/static/chunks/pages/index-abc.js"></script></head>
      <body><div id="__next"><h1>Pages Router</h1></div>
      <script id="__NEXT_DATA__" type="application/json">{"page":"/"}</script></body></html>`,
  });
  const pagesIds = new Set(pagesRouter.technologies.map((t) => t.id));
  assert.equal(pagesRouter.primaryFramework, 'nextjs-pages-router');
  assert.ok(pagesIds.has('nextjs-pages-router'));
  assert.ok(pagesIds.has('nextjs'));
  assert.ok(pagesIds.has('react'));
  assert.ok(!pagesIds.has('nextjs-app-router'), 'App Router must be disqualified when #__NEXT_DATA__ is present');
  assert.ok(!pagesIds.has('vite-spa'));

  // Vite SPA
  const viteSpa = detectStackAndWaf({
    url: 'https://spa.example.com/',
    status: 200,
    headers: { server: 'cloudflare', 'cf-ray': '8f123abc-IAD' },
    html: `<!doctype html><html><head>
      <script type="module" crossorigin src="/assets/index-Dz9kLm2a.js"></script>
      <link rel="stylesheet" href="/assets/index-XyZ98765.css">
      </head><body><div id="root"></div></body></html>`,
  });
  const viteIds = new Set(viteSpa.technologies.map((t) => t.id));
  assert.equal(viteSpa.primaryFramework, 'vite-spa');
  assert.ok(viteIds.has('vite-spa'));
  assert.ok(viteIds.has('vite'));
  assert.ok(viteIds.has('cloudflare'));
  assert.ok(!viteIds.has('nextjs-app-router'));
  assert.ok(!viteIds.has('nextjs-pages-router'));

  // Vite-backed Astro SSR must NOT misclassify as vite-spa
  const astroSite = detectStackAndWaf({
    url: 'https://astro.example.com/',
    status: 200,
    headers: { server: 'Netlify', 'x-nf-request-id': '01ABC' },
    html: `<!doctype html><html><head><meta name="generator" content="Astro v4.15.0">
      <link rel="stylesheet" href="/_astro/index.a1b2c3d4.css">
      <script type="module" src="/assets/widget-AbCdEf12.js"></script></head>
      <body><div id="root"></div><astro-island uid="1"><main><h1>Astro SSR</h1></main></astro-island></body></html>`,
  });
  const astroIds = new Set(astroSite.technologies.map((t) => t.id));
  assert.equal(astroSite.primaryFramework, 'astro');
  assert.ok(astroIds.has('astro'));
  assert.ok(astroIds.has('netlify'));
  assert.ok(!astroIds.has('vite-spa'), 'Astro pages must not false-positive as Vite SPA');
});

test('detectStackAndWaf detects Shopify + Cloudflare, WordPress + nginx, Webflow, SvelteKit, Nuxt, Fastly', () => {
  const shopify = detectStackAndWaf({
    status: 200,
    headers: {
      'cf-ray': '9999-SJC',
      server: 'cloudflare',
      'x-shopid': '123456',
      'powered-by': 'Shopify',
    },
    setCookies: ['_shopify_y=secret-y-val; Path=/', '_shopify_s=secret-s-val; Path=/'],
    html: '<html><body><script src="https://cdn.shopify.com/s/files/theme.js"></script></body></html>',
  });
  const shopIds = new Set(shopify.technologies.map((t) => t.id));
  assert.ok(shopIds.has('shopify'));
  assert.ok(shopIds.has('cloudflare'));
  assert.equal(shopify.primaryCms, 'shopify');
  assert.equal(shopify.primaryCdn, 'cloudflare');

  const wp = detectStackAndWaf({
    status: 200,
    headers: {
      server: 'nginx/1.26.2',
      link: '<https://blog.example.com/wp-json/>; rel="https://api.w.org/"',
    },
    html: `<html><head><meta name="generator" content="WordPress 6.6.1"></head>
      <body><!-- Optimized with the Yoast SEO plugin --><script src="/wp-content/themes/flavor/app.js"></script></body></html>`,
  });
  const wpIds = new Set(wp.technologies.map((t) => t.id));
  assert.ok(wpIds.has('wordpress'));
  assert.ok(wpIds.has('yoast-seo'));
  assert.ok(wpIds.has('nginx'));
  assert.equal(wp.servers.find((s) => s.id === 'nginx')?.version, '1.26.2');
  assert.equal(wp.cms.find((c) => c.id === 'wordpress')?.version, '6.6.1');
});

// ============================================================================
// 3. THREE WAF STATES + ZERO FALSE POSITIVES ON TURNSTILE `cf-chl-`
// ============================================================================

test('detectStackAndWaf classifies all 3 WAF states accurately', () => {
  const richContent = '<p>' + 'Technical documentation paragraph with substantive information. '.repeat(30) + '</p>';

  // State 0: none
  const none = detectStackAndWaf({
    status: 200,
    headers: { server: 'nginx' },
    html: `<html><body><h1>Plain Origin</h1>${richContent}</body></html>`,
  });
  assert.equal(none.waf.state, 'none');
  assert.equal(none.waf.challengeDetected, false);

  // State 1: edge_detected (200 OK with CDN headers only, no bot cookies)
  const edge = detectStackAndWaf({
    status: 200,
    headers: { 'cf-ray': '8abc1234-LHR', server: 'cloudflare' },
    html: `<html><body><h1>Behind Cloudflare CDN</h1>${richContent}</body></html>`,
  });
  assert.equal(edge.waf.state, 'edge_detected');
  assert.equal(edge.waf.vendor, 'cloudflare');
  assert.equal(edge.waf.challengeDetected, false);

  // State 2: bot_management_active (200 OK with bot-telemetry cookie)
  const botMgmt = detectStackAndWaf({
    status: 200,
    headers: { 'cf-ray': '8abc1234-LHR', server: 'cloudflare' },
    setCookies: ['__cf_bm=tok_abc123; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly'],
    html: `<html><body><h1>Bot Management Telemetry</h1>${richContent}</body></html>`,
  });
  assert.equal(botMgmt.waf.state, 'bot_management_active');
  assert.equal(botMgmt.waf.vendor, 'cloudflare-bot-management');
  assert.equal(botMgmt.waf.challengeDetected, false);
  assert.equal(botMgmt.waf.cloudflareSept2026Advisory, true);

  // State 2b: Akamai Bot Manager cookie
  const akamaiBot = detectStackAndWaf({
    status: 200,
    headers: { 'akamai-grn': '0.abc.123', server: 'AkamaiGHost' },
    setCookies: ['_abck=secret_akamai_payload~0~1; Path=/; Secure'],
    html: `<html><body><h1>Akamai Site</h1>${richContent}</body></html>`,
  });
  assert.equal(akamaiBot.waf.state, 'bot_management_active');
  assert.equal(akamaiBot.waf.vendor, 'akamai-bot-manager');

  // State 3a: Cloudflare cf-mitigated: challenge
  const cfChallenge = detectStackAndWaf({
    status: 403,
    headers: { 'cf-ray': '8abc-IAD', 'cf-mitigated': 'challenge', server: 'cloudflare' },
    html: `<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>`,
  });
  assert.equal(cfChallenge.waf.state, 'challenge_or_block_intercepted');
  assert.equal(cfChallenge.waf.vendor, 'cloudflare');
  assert.equal(cfChallenge.waf.challengeDetected, true);

  // State 3b: Vercel Security Checkpoint
  const vercelCheckpoint = detectStackAndWaf({
    status: 429,
    headers: { 'x-vercel-id': 'iad1::123', 'x-vercel-mitigated': 'challenge' },
    html: '<html><head><title>Vercel Security Checkpoint</title></head><body>Verifying your browser...</body></html>',
  });
  assert.equal(vercelCheckpoint.waf.state, 'challenge_or_block_intercepted');
  assert.equal(vercelCheckpoint.waf.vendor, 'vercel');

  // State 3c: AWS WAF HTTP 202 challenge
  const awsWaf = detectStackAndWaf({
    status: 202,
    headers: { 'x-amzn-waf-action': 'challenge', 'x-amz-cf-id': 'abc' },
    html: '<html><body><script src="https://abc.captcha.awswaf.com/challenge.js"></script></body></html>',
  });
  assert.equal(awsWaf.waf.state, 'challenge_or_block_intercepted');
  assert.equal(awsWaf.waf.vendor, 'aws-waf');

  // State 3d: Anubis PoW gate returning HTTP 200
  const anubis = detectStackAndWaf({
    status: 200,
    headers: { server: 'nginx' },
    html: `<html><head><title>Making sure you're not a bot!</title></head>
      <body><script id="anubis_challenge" type="application/json">{"difficulty":4}</script>
      <p>Protected by Anubis from Techaro.</p></body></html>`,
  });
  assert.equal(anubis.waf.state, 'challenge_or_block_intercepted');
  assert.equal(anubis.waf.vendor, 'anubis-pow');

  // State 3e: DataDome 403
  const datadome = detectStackAndWaf({
    status: 403,
    headers: { 'x-datadome': 'protected' },
    html: '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe></body></html>',
  });
  assert.equal(datadome.waf.state, 'challenge_or_block_intercepted');
  assert.equal(datadome.waf.vendor, 'datadome');
});

test('Zero false positives on Cloudflare Turnstile cf-chl- widgets embedded in normal pages', () => {
  const longPageBody = '<article><h1>Contact & Pricing</h1>' +
    '<p>Our platform provides transparent API observability, latency metrics, and enterprise support plans for engineering teams worldwide. </p>'.repeat(15) +
    '</article>';

  const normalWithTurnstile = detectStackAndWaf({
    url: 'https://example.com/contact',
    status: 200,
    headers: { 'cf-ray': '8fff9999-SJC', server: 'cloudflare' },
    html: `<!doctype html><html><head>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      </head><body>
      ${longPageBody}
      <form action="/submit">
        <div class="cf-turnstile" id="cf-chl-widget-99" data-sitekey="0x4AAAAAA"></div>
        <input type="hidden" name="cf-chl-response" value="">
      </form>
      </body></html>`,
  });

  assert.ok(normalWithTurnstile.visibleTextChars >= 1000, `Expected >= 1000 visible chars, got ${normalWithTurnstile.visibleTextChars}`);
  assert.equal(normalWithTurnstile.waf.turnstileWidgetDetected, true);
  assert.equal(normalWithTurnstile.waf.challengeDetected, false);
  assert.equal(normalWithTurnstile.waf.state, 'edge_detected');
  assert.notEqual(normalWithTurnstile.waf.state, 'challenge_or_block_intercepted');

  // Even a short 200 OK form page containing only a Turnstile widget (not an interstitial) must NOT false-positive
  const shortFormWithTurnstile = detectStackAndWaf({
    status: 200,
    headers: { 'cf-ray': '8fff1111-SJC', server: 'cloudflare' },
    html: `<html><body><h1>Sign in</h1><form><div class="cf-turnstile" id="cf-chl-login"></div></form></body></html>`,
  });
  assert.equal(shortFormWithTurnstile.waf.turnstileWidgetDetected, true);
  assert.equal(shortFormWithTurnstile.waf.challengeDetected, false);
  assert.equal(shortFormWithTurnstile.waf.state, 'edge_detected');
});

// ============================================================================
// 4. COOKIE SAFETY: `getSetCookie()` & NEVER LOGGING COOKIE VALUES
// ============================================================================

test('extractCookieNames and detectStackAndWaf use Headers.getSetCookie() and NEVER leak cookie values', () => {
  const headers = new Headers();
  headers.set('cf-ray', '8abc-IAD');
  headers.set('server', 'cloudflare');
  headers.append(
    'set-cookie',
    '__cf_bm=SECRET_CF_BM_VALUE_DO_NOT_LOG_12345; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly; Secure',
  );
  headers.append(
    'set-cookie',
    'session_token=SUPER_SENSITIVE_JWT_987654321; Expires=Thu, 22 Oct 2026 07:28:00 GMT; Path=/; SameSite=Lax',
  );
  headers.append(
    'set-cookie',
    '_shopify_y=SHOPIFY_SECRET_VALUE_XYZ; Max-Age=31536000; Path=/',
  );

  const names = extractCookieNames(headers);
  assert.deepEqual(names, ['__cf_bm', 'session_token', '_shopify_y']);

  // Also test comma-joined plain header string containing Expires=Wed, ... commas
  const joinedPlain = extractCookieNames({
    'Set-Cookie':
      '__cf_bm=SECRET_PLAIN_VAL; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, reese84=SECRET_REESE_VAL; Expires=Thu, 22 Oct 2026 08:00:00 GMT; Path=/',
  });
  assert.deepEqual(joinedPlain, ['__cf_bm', 'reese84']);

  // Verify zero cookie values appear anywhere in detectStackAndWaf output
  const result = detectStackAndWaf({
    status: 200,
    headers,
    html: '<html><body><h1>Hello</h1></body></html>',
  });
  const serialized = JSON.stringify(result);
  assert.ok(result.cookieNames.includes('__cf_bm'));
  assert.ok(result.cookieNames.includes('session_token'));
  assert.ok(!serialized.includes('SECRET_CF_BM_VALUE_DO_NOT_LOG_12345'), 'Must never serialize __cf_bm value');
  assert.ok(!serialized.includes('SUPER_SENSITIVE_JWT_987654321'), 'Must never serialize session_token value');
  assert.ok(!serialized.includes('SHOPIFY_SECRET_VALUE_XYZ'), 'Must never serialize _shopify_y value');
});

// ============================================================================
// 5. ROBOTS.TXT: RFC 9309 + CLOUDFLARE MANAGED + CONTENT-SIGNAL + AIPREF
// ============================================================================

test('analyzeRobotsPolicy evaluates RFC 9309 longest-match, Cloudflare Managed contradictions, Content-Signal conflicts, __usage_ai-training, and ruleless trailing group', () => {
  const robotsTxt = [
    '# BEGIN Cloudflare Managed Content',
    'User-agent: *',
    'Content-Signal: search=yes, ai-input=no, ai-train=no',
    'Allow: /',
    'User-agent: GPTBot',
    'Disallow: /',
    'User-agent: ClaudeBot',
    'Disallow: /',
    '# END Cloudflare Managed Content',
    '',
    'User-agent: *',
    'Content-Signal: search=yes, ai-input=yes, ai-train=no',
    'Disallow: /private/',
    'Allow: /private/public-doc$',
    '',
    'User-agent: GPTBot',
    'Allow: /',
    '',
    'User-agent: __usage_ai-training',
    'Disallow: /',
    '',
    'Sitemap: https://example.com/sitemap.xml',
    '',
    'User-agent: DanglingBot',
  ].join('\n');

  const httpHeaders = new Headers({
    'content-signal': 'search=yes, ai-input=no, ai-train=no',
    'content-usage': 'train-ai=n',
  });

  const policy = analyzeRobotsPolicy(robotsTxt, '/pricing', httpHeaders);

  // Ruleless trailing group check
  assert.equal(policy.endsWithRulelessGroup, true);
  assert.equal(policy.trailingRulelessAgent, 'DanglingBot');
  assert.deepEqual(policy.sitemaps, ['https://example.com/sitemap.xml']);

  // Cloudflare Managed Content block & contradictions
  assert.equal(policy.cloudflareManaged.detected, true);
  assert.equal(policy.cloudflareManaged.startLine, 1);
  assert.equal(policy.cloudflareManaged.endLine, 9);
  assert.ok(policy.cloudflareManaged.managedAgents.includes('GPTBot'));
  assert.ok(policy.cloudflareManaged.managedAgents.includes('ClaudeBot'));

  const gptContradiction = policy.cloudflareManaged.contradictions.find(
    (c) => c.agent === 'GPTBot' && c.type === 'access_rule',
  );
  assert.ok(gptContradiction, 'Must detect Cloudflare Managed Disallow: / contradicting origin Allow: / for GPTBot');
  assert.equal(gptContradiction.managedDirective, 'Disallow: /');
  assert.equal(gptContradiction.originDirective, 'Allow: /');

  const signalManagedContradiction = policy.cloudflareManaged.contradictions.find(
    (c) => c.agent === '*' && c.type === 'content_signal',
  );
  assert.ok(signalManagedContradiction, 'Must detect Cloudflare Managed Content-Signal contradicting origin');

  // Content-Signal robots vs HTTP header conflict (origin robots.txt set ai-input=yes while HTTP header set ai-input=no)
  assert.equal(policy.contentSignals.robots['ai-input'], 'yes');
  assert.equal(policy.contentSignals.headers['ai-input'], 'no');
  assert.equal(policy.contentSignals.conflicts.length, 1);
  assert.equal(policy.contentSignals.conflicts[0].directive, 'ai-input');
  assert.equal(policy.contentSignals.conflicts[0].robotsValue, 'yes');
  assert.equal(policy.contentSignals.conflicts[0].headerValue, 'no');
  assert.equal(policy.contentSignals.suppressesAiInput, true);

  // __usage_ai-training cleanly recognized as training-only opt-out (does NOT penalize search!)
  assert.equal(policy.aiprefTrainingOptOut.detected, true);
  assert.equal(policy.aiprefTrainingOptOut.disallowed, true);
  assert.equal(policy.aiprefTrainingOptOut.trainingOnly, true);
  assert.equal(policy.aiprefTrainingOptOut.affectsSearchVisibility, false);
  assert.deepEqual(policy.summary.searchRetrievalBlocked, []);
  assert.deepEqual(policy.summary.mixedSearchAiBlocked, []);
  assert.ok(policy.summary.policySignalsDisallowed.includes('__usage_ai-training'));

  // RFC 9309 longest-match + `$` anchor test on /private/public-doc vs /private/secret
  const allowedDoc = analyzeRobotsPolicy(robotsTxt, '/private/public-doc');
  assert.equal(allowedDoc.byToken['OAI-SearchBot'].allowed, true);
  assert.equal(allowedDoc.byToken['OAI-SearchBot'].rule, 'Allow: /private/public-doc$');

  const blockedSecret = analyzeRobotsPolicy(robotsTxt, '/private/secret');
  assert.equal(blockedSecret.byToken['OAI-SearchBot'].allowed, false);
  assert.equal(blockedSecret.byToken['OAI-SearchBot'].rule, 'Disallow: /private/');
});

test('analyzeRobotsPolicy recognizes HTTP Content-Usage AIPREF header and clean non-ruleless endings', () => {
  const cleanRobots = `User-agent: *\nContent-Signal: search=yes, ai-input=no, ai-train=yes\nAllow: /\n`;
  const policy = analyzeRobotsPolicy(cleanRobots, '/', {
    'Content-Signal': 'search=yes, ai-input=yes',
    'Content-Usage': 'train-ai=n',
  });

  assert.equal(policy.endsWithRulelessGroup, false);
  assert.equal(policy.trailingRulelessAgent, null);
  assert.equal(policy.cloudflareManaged.detected, false);
  assert.equal(policy.contentSignals.headers['ai-train'], 'no');
  assert.equal(policy.contentSignals.headers['ai-input'], 'yes');
  // Both ai-input and ai-train conflict between robots.txt and HTTP headers
  const conflictDirectives = policy.contentSignals.conflicts.map((c) => c.directive).sort();
  assert.deepEqual(conflictDirectives, ['ai-input', 'ai-train']);
});

// ============================================================================
// 6. CACHING HEADERS & LAST-MODIFIED PLAUSIBILITY + VARY HYGIENE
// ============================================================================

test('analyzeCachingHeaders validates weak ETag, Last-Modified plausibility bounds, no-store, and Vary hygiene', () => {
  const now = new Date('2026-11-19T12:00:00Z');

  // 1. Healthy weak ETag + plausible Last-Modified
  const healthy = analyzeCachingHeaders(
    {
      ETag: 'W/"abc-123"',
      Date: 'Thu, 19 Nov 2026 12:00:00 GMT',
      'Last-Modified': 'Mon, 16 Nov 2026 09:30:00 GMT',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      Vary: 'Accept-Encoding',
    },
    now,
  );
  assert.equal(healthy.etag.present, true);
  assert.equal(healthy.etag.weak, true);
  assert.equal(healthy.etag.valid, true);
  assert.equal(healthy.lastModified.plausible, true);
  assert.equal(healthy.lastModified.reason, 'plausible');
  assert.equal(healthy.conditionalGetReady, true);
  assert.equal(healthy.issues.length, 0);

  // 2. Placeholder < 1995 (Unix epoch 1970)
  const pre1995 = analyzeCachingHeaders(
    {
      Date: 'Thu, 19 Nov 2026 12:00:00 GMT',
      'Last-Modified': 'Thu, 01 Jan 1970 00:00:00 GMT',
    },
    now,
  );
  assert.equal(pre1995.lastModified.plausible, false);
  assert.equal(pre1995.lastModified.reason, 'placeholder_pre_1995');
  assert.ok(pre1995.issues.some((i) => i.id === 'last_modified_placeholder'));

  // 3. "Stamping now" bug (within 60s of Date header)
  const stampsNow = analyzeCachingHeaders(
    {
      Date: 'Thu, 19 Nov 2026 12:00:00 GMT',
      'Last-Modified': 'Thu, 19 Nov 2026 11:59:25 GMT',
    },
    now,
  );
  assert.equal(stampsNow.lastModified.plausible, false);
  assert.equal(stampsNow.lastModified.reason, 'stamps_now');
  assert.ok(stampsNow.issues.some((i) => i.id === 'last_modified_stamps_now'));

  // 4. Future > 24h clock skew
  const future = analyzeCachingHeaders(
    {
      Date: 'Thu, 19 Nov 2026 12:00:00 GMT',
      'Last-Modified': 'Sat, 21 Nov 2026 13:00:00 GMT',
    },
    now,
  );
  assert.equal(future.lastModified.plausible, false);
  assert.equal(future.lastModified.reason, 'future_clock_skew');
  assert.ok(future.issues.some((i) => i.id === 'last_modified_future'));

  // 5. Cache-Control: no-store + Vary: User-Agent + Markdown missing Vary: Accept + Next.js missing Vary: Rsc
  const badVary = analyzeCachingHeaders(
    {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'x-nextjs-prerender': '1',
      Vary: 'User-Agent, CF-IPCountry',
    },
    now,
  );
  const issueIds = new Set(badVary.issues.map((i) => i.id));
  assert.equal(badVary.cacheControl.hasNoStore, true);
  assert.equal(badVary.vary.hasUserAgent, true);
  assert.equal(badVary.vary.hasAccept, false);
  assert.equal(badVary.vary.hasRsc, false);
  assert.equal(badVary.vary.hasGeoHeader, true);
  assert.ok(issueIds.has('cache_control_no_store'));
  assert.ok(issueIds.has('vary_user_agent'));
  assert.ok(issueIds.has('vary_geo_header'));
  assert.ok(issueIds.has('missing_vary_accept_markdown'));
  assert.ok(issueIds.has('missing_vary_rsc_nextjs'));
});

// ============================================================================
// 7. DNS OSINT HINTS (MOCKED RESOLVER + TIMEOUT GUARD)
// ============================================================================

test('probeDnsHints extracts CNAME/NS/TXT edge hints and verification footprints without throwing', async () => {
  const hints = await probeDnsHints('https://www.example.com/pricing', {
    resolver: {
      async resolveCname() {
        return ['cname.vercel-dns.com', 'shops.myshopify.com'];
      },
      async resolveNs() {
        return ['dana.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
      },
      async resolveTxt() {
        return [
          ['google-site-verification=', 'abc123'],
          ['openai-domain-verification=dv-xyz'],
          ['apple-domain-verification=app999'],
          ['msvalidate.01=bing111'],
        ];
      },
    },
  });

  assert.equal(hints.hostname, 'www.example.com');
  assert.deepEqual(hints.cname, ['cname.vercel-dns.com', 'shops.myshopify.com']);
  assert.ok(hints.inferredEdge.includes('vercel'));
  assert.ok(hints.inferredEdge.includes('shopify'));
  assert.ok(hints.inferredEdge.includes('cloudflare'));
  assert.equal(hints.verificationTokens.google, true);
  assert.equal(hints.verificationTokens.openai, true);
  assert.equal(hints.verificationTokens.apple, true);
  assert.equal(hints.verificationTokens.bing, true);
  assert.equal(hints.timedOut, false);
  assert.deepEqual(hints.errors, []);
});

test('probeDnsHints enforces timeout guard and handles ENODATA cleanly without throwing', async () => {
  const timed = await probeDnsHints('slow.example.com', {
    timeoutMs: 25,
    resolver: {
      async resolveCname() {
        const err = /** @type {NodeJS.ErrnoException} */ (new Error('ENODATA'));
        err.code = 'ENODATA';
        throw err;
      },
      async resolveNs() {
        return ['ns-102.awsdns-12.com'];
      },
      async resolveTxt() {
        return new Promise(() => {
          // Never resolves — timeout guard must recover cleanly
        });
      },
    },
  });

  assert.equal(timed.hostname, 'slow.example.com');
  assert.deepEqual(timed.cname, []);
  assert.deepEqual(timed.ns, ['ns-102.awsdns-12.com']);
  assert.ok(timed.inferredEdge.includes('aws-route53'));
  assert.equal(timed.timedOut, true);
  assert.ok(timed.errors.includes('txt:DNS_TIMEOUT'));
  assert.ok(!timed.errors.some((e) => e.includes('ENODATA')), 'ENODATA should be treated as benign');
});

// ============================================================================
// 8. STACK-SPECIFIC REMEDIATION RECIPES (ZERO FLUFF)
// ============================================================================

test('buildRemediationPlan returns empty recipes on a clean healthy site (no generic fluff)', () => {
  const cleanStack = detectStackAndWaf({
    status: 200,
    headers: { 'x-vercel-id': 'iad1::ok', vary: 'RSC, Next-Router-State-Tree' },
    html: '<html><body><main><h1>Healthy SSR</h1><p>Full content.</p></main><script>self.__next_f.push([1,"ok"])</script></body></html>',
  });
  const cleanCaching = analyzeCachingHeaders({
    ETag: 'W/"123"',
    Vary: 'RSC, Next-Router-State-Tree',
    'Cache-Control': 'public, s-maxage=3600',
  });
  const cleanRobots = analyzeRobotsPolicy('User-agent: *\nAllow: /\n', '/');

  const plan = buildRemediationPlan({
    stack: cleanStack,
    findings: [],
    robotsPolicy: cleanRobots,
    caching: cleanCaching,
  });

  assert.equal(plan.recipes.length, 0);
  assert.equal(plan.summary.total, 0);
});

test('buildRemediationPlan emits exact copy-pasteable recipes across Vite SPA, Next.js, Cloudflare, nginx, Shopify, and WAFs', () => {
  // 1. Vite SPA + Cloudflare Managed override + Edge Markdown CSR trap + missing Vary: Accept
  const viteCfStack = detectStackAndWaf({
    status: 200,
    headers: { 'cf-ray': '8abc-IAD', server: 'cloudflare' },
    setCookies: ['__cf_bm=tok; Path=/'],
    html: '<html><head><script type="module" src="/assets/index-AbC12345.js"></script></head><body><div id="root"></div></body></html>',
  });
  const cfRobots = analyzeRobotsPolicy(
    `# BEGIN Cloudflare Managed Content\nUser-agent: GPTBot\nDisallow: /\n# END Cloudflare Managed Content\nUser-agent: GPTBot\nAllow: /\n`,
    '/',
  );
  const vitePlan = buildRemediationPlan({
    stack: viteCfStack,
    findings: [
      { id: 'csr_empty_shell', severity: 'critical', category: 'csr' },
      { id: 'robots_txt_html_fallback', severity: 'warning', category: 'robots' },
    ],
    robotsPolicy: cfRobots,
    markdownNegotiation: { supported: true, varyHasAccept: false, csrEmptyShellTrap: true, tokenCount: 42 },
  });
  const viteRecipeIds = new Set(vitePlan.recipes.map((r) => r.id));
  assert.ok(viteRecipeIds.has('vite-spa-prerender-csr'));
  assert.ok(viteRecipeIds.has('vite-spa-exclude-crawler-files'));
  assert.ok(viteRecipeIds.has('cloudflare-managed-robots-override'));
  assert.ok(viteRecipeIds.has('cloudflare-markdown-for-agents-csr-trap'));
  assert.ok(viteRecipeIds.has('markdown-vary-accept-cache-poisoning'));
  // Priority ordering: critical comes first
  assert.equal(vitePlan.recipes[0].priority, 'critical');

  // 2. Next.js App Router RSC bloat + missing Vary: Rsc
  const nextAppPlan = buildRemediationPlan({
    stack: { primaryFramework: 'nextjs-app-router', technologies: [{ id: 'nextjs-app-router', name: 'Next.js (App Router)', category: 'framework', version: null, confidence: 100, evidence: [], implied: false }] },
    findings: [{ id: 'rsc_bloat_over_300kb', severity: 'warning', category: 'payload' }],
    caching: analyzeCachingHeaders({ 'x-nextjs-prerender': '1', ETag: '"1"' }),
  });
  assert.ok(nextAppPlan.recipes.some((r) => r.id === 'nextjs-app-router-rsc-and-payload'));
  assert.ok(nextAppPlan.recipes.some((r) => r.id === 'nextjs-app-router-vary-rsc'));

  // 3. WordPress + nginx + Last-Modified stamps now + Wordfence block
  const wpNginxPlan = buildRemediationPlan({
    stack: {
      primaryCms: 'wordpress',
      technologies: [
        { id: 'wordpress', name: 'WordPress', category: 'cms', version: null, confidence: 100, evidence: [], implied: false },
        { id: 'nginx', name: 'nginx', category: 'server', version: null, confidence: 100, evidence: [], implied: false },
        { id: 'wordfence', name: 'Wordfence', category: 'waf', version: null, confidence: 100, evidence: [], implied: false },
      ],
    },
    waf: {
      state: 'challenge_or_block_intercepted',
      vendor: 'wordfence',
      vendors: ['wordfence'],
      evidence: [],
      challengeDetected: true,
      turnstileWidgetDetected: false,
      hasAdTechScripts: false,
      cloudflareSept2026Advisory: false,
    },
    caching: analyzeCachingHeaders(
      { Date: 'Thu, 19 Nov 2026 12:00:00 GMT', 'Last-Modified': 'Thu, 19 Nov 2026 11:59:50 GMT' },
      new Date('2026-11-19T12:00:00Z'),
    ),
  });
  const wpIds = new Set(wpNginxPlan.recipes.map((r) => r.id));
  assert.ok(wpIds.has('wordpress-cache-and-payload'));
  assert.ok(wpIds.has('nginx-crawler-files-and-etag'));
  assert.ok(wpIds.has('wordfence-allowlist-ai-search'));

  // 4. Shopify blocking OAI-SearchBot -> emits templates/robots.txt.liquid snippet
  const shopifyPlan = buildRemediationPlan({
    stack: { primaryCms: 'shopify' },
    robotsPolicy: analyzeRobotsPolicy('User-agent: OAI-SearchBot\nDisallow: /\n', '/products/widget'),
  });
  const shopifyRecipe = shopifyPlan.recipes.find((r) => r.id === 'shopify-robots-liquid-and-ssr');
  assert.ok(shopifyRecipe);
  assert.ok(shopifyRecipe.snippet?.includes('templates/robots.txt.liquid'));

  // 5. Multi-stack WAF coverage (Vercel, Netlify, Akamai, Fastly, AWS WAF, DataDome, Imperva, HUMAN, Anubis)
  const wafCombos = [
    ['vercel', 'vercel-firewall-and-rewrites'],
    ['akamai-bot-manager', 'akamai-bot-manager-allowlist'],
    ['fastly', 'fastly-vcl-etag-and-ai-allowlist'],
    ['aws-waf', 'aws-waf-bot-control-allowlist'],
    ['datadome', 'datadome-verified-bots-allowlist'],
    ['imperva-incapsula', 'imperva-known-good-bots-allowlist'],
    ['human-perimeterx', 'human-perimeterx-known-bots'],
    ['anubis-pow', 'anubis-pow-scope-policy'],
  ];
  for (const [vendor, expectedRecipeId] of wafCombos) {
    const plan = buildRemediationPlan({
      waf: { state: 'challenge_or_block_intercepted', vendor, vendors: [vendor], challengeDetected: true },
    });
    assert.ok(
      plan.recipes.some((r) => r.id === expectedRecipeId),
      `Expected recipe ${expectedRecipeId} for WAF vendor ${vendor}`,
    );
  }

  // 6. Nuxt, Astro, SvelteKit, Next.js Pages Router, Webflow, Netlify
  const nuxtPlan = buildRemediationPlan({
    stack: { primaryFramework: 'nuxt' },
    findings: [{ id: 'csr_empty_shell', severity: 'critical', category: 'csr' }],
  });
  assert.ok(nuxtPlan.recipes.some((r) => r.id === 'nuxt-enable-ssr-route-rules'));

  const astroPlan = buildRemediationPlan({
    stack: { primaryFramework: 'astro' },
    findings: [{ id: 'csr_empty_shell', severity: 'critical', category: 'csr' }],
  });
  assert.ok(astroPlan.recipes.some((r) => r.id === 'astro-replace-client-only'));

  const sveltePlan = buildRemediationPlan({
    stack: { primaryFramework: 'sveltekit' },
    findings: [{ id: 'csr_empty_shell', severity: 'critical', category: 'csr' }],
  });
  assert.ok(sveltePlan.recipes.some((r) => r.id === 'sveltekit-enable-ssr-load'));

  const nextPagesPlan = buildRemediationPlan({
    stack: { primaryFramework: 'nextjs-pages-router' },
    findings: [{ id: 'next_data_bloat', severity: 'warning', category: 'payload' }],
  });
  assert.ok(nextPagesPlan.recipes.some((r) => r.id === 'nextjs-pages-router-gsp-and-props'));

  const webflowPlan = buildRemediationPlan({
    stack: { primaryCms: 'webflow' },
    findings: [{ id: 'canonical_mismatch', severity: 'warning', category: 'indexing' }],
  });
  assert.ok(webflowPlan.recipes.some((r) => r.id === 'webflow-seo-canonical-robots'));

  const netlifyPlan = buildRemediationPlan({
    stack: { primaryHosting: 'netlify' },
    findings: [{ id: 'robots_txt_html_fallback', severity: 'warning', category: 'robots' }],
  });
  assert.ok(netlifyPlan.recipes.some((r) => r.id === 'netlify-redirects-and-cache'));
});

test('detectStackAndWaf covers broad framework/CMS/CDN/server/WAF rules and stays fast on large payloads', () => {
  const cases = [
    {
      name: 'Nuxt',
      input: { html: '<div id="__nuxt"></div><script id="__NUXT_DATA__" type="application/json">[]</script>' },
      expected: 'nuxt',
    },
    {
      name: 'SvelteKit',
      input: { html: '<body data-sveltekit-preload-data="hover"><script src="/_app/immutable/entry/start.js"></script></body>' },
      expected: 'sveltekit',
    },
    {
      name: 'Remix',
      input: { html: '<script>window.__remixContext = {};</script>' },
      expected: 'remix',
    },
    {
      name: 'Gatsby',
      input: { html: '<meta name="generator" content="Gatsby 5.13.0"><div id="___gatsby"></div>' },
      expected: 'gatsby',
    },
    {
      name: 'Create React App',
      input: { html: '<div id="root"></div><script src="/static/js/main.a1b2c3d4.js"></script>' },
      expected: 'create-react-app',
    },
    {
      name: 'Docusaurus',
      input: { html: '<meta name="generator" content="Docusaurus v3.5.0"><div id="__docusaurus"></div>' },
      expected: 'docusaurus',
    },
    {
      name: 'Hugo',
      input: { html: '<meta name="generator" content="Hugo 0.134.2">' },
      expected: 'hugo',
    },
    {
      name: 'Ghost',
      input: { html: '<meta name="generator" content="Ghost 5.90">' },
      expected: 'ghost',
    },
    {
      name: 'Squarespace',
      input: { headers: { server: 'Squarespace' }, html: '<!-- This is Squarespace. -->' },
      expected: 'squarespace',
    },
    {
      name: 'Wix',
      input: { headers: { 'x-wix-request-id': 'abc' }, html: '<meta name="generator" content="Wix.com Website Builder">' },
      expected: 'wix',
    },
    {
      name: 'BunnyCDN',
      input: { headers: { server: 'BunnyCDN-DE1-123', 'cdn-pullzone': '42' }, html: '<html></html>' },
      expected: 'bunnycdn',
    },
    {
      name: 'GitHub Pages',
      input: { headers: { server: 'GitHub.com', 'x-github-request-id': 'abc' }, html: '<html></html>' },
      expected: 'github-pages',
    },
    {
      name: 'Fly.io',
      input: { headers: { 'fly-request-id': '01ABC', server: 'Fly/deadbeef' }, html: '<html></html>' },
      expected: 'fly-io',
    },
    {
      name: 'Render',
      input: { headers: { 'x-render-origin-server': 'Render', 'rndr-id': '123' }, html: '<html></html>' },
      expected: 'render',
    },
    {
      name: 'Caddy',
      input: { headers: { server: 'Caddy' }, html: '<html></html>' },
      expected: 'caddy',
    },
    {
      name: 'LiteSpeed',
      input: { headers: { server: 'LiteSpeed', 'x-litespeed-cache': 'hit' }, html: '<html></html>' },
      expected: 'litespeed',
    },
    {
      name: 'Apache',
      input: { headers: { server: 'Apache/2.4.62 (Ubuntu)' }, html: '<html></html>' },
      expected: 'apache',
    },
  ];

  for (const c of cases) {
    const res = detectStackAndWaf({ status: 200, ...c.input });
    assert.ok(
      res.technologies.some((t) => t.id === c.expected),
      `Expected ${c.name} (${c.expected}) to be detected`,
    );
  }

  // ReDoS / latency guard on ~500 KB HTML payload
  const largeHtml =
    '<!doctype html><html><head><script src="/_next/static/chunks/app/page.js"></script></head><body>' +
    '<div class="card"><p>Fast passive scanning without ReDoS backtracking on large HTML payloads.</p></div>'.repeat(5000) +
    '<script>self.__next_f.push([1,"done"])</script></body></html>';
  const perfRes = detectStackAndWaf({
    status: 200,
    headers: { 'cf-ray': '123-IAD', vary: 'RSC' },
    html: largeHtml,
  });
  assert.equal(perfRes.primaryFramework, 'nextjs-app-router');
  assert.ok(perfRes.durationMs < 150, `Expected fast passive scan (<150ms on 500KB), took ${perfRes.durationMs}ms`);
});

