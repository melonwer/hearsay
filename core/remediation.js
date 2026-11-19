/**
 * Stack-, CDN-, and WAF-aware concrete remediation recipe engine.
 *
 * Maps passively detected technology layers (`core/tech-detect.js`) against
 * concrete observed audit findings (CSR empty shells, payload/RSC bloat,
 * WAF/bot challenges, Cloudflare Sept 2026 / Managed Content / Content-Signal
 * conflicts, caching/Vary issues, SPA soft-404 fallbacks, and Edge Markdown
 * negotiation bugs) to prioritized, copy-pasteable remediation recipes.
 *
 * Zero external runtime dependencies; never emits generic fluff when no
 * concrete failure mode is present.
 */

/**
 * @typedef {import('./tech-detect.js').StackAndWafResult} StackAndWafResult
 * @typedef {import('./tech-detect.js').WafAssessment} WafAssessment
 * @typedef {import('./tech-detect.js').RobotsPolicyResult} RobotsPolicyResult
 * @typedef {import('./tech-detect.js').CachingAnalysisResult} CachingAnalysisResult
 */

/**
 * @typedef {'critical'|'high'|'medium'|'low'} RemediationPriority
 */

/**
 * @typedef {'framework'|'cms'|'cdn'|'hosting'|'server'|'waf'|'policy'} RemediationLayer
 */

/**
 * @typedef {Object} AuditFindingLike
 * @property {string} id
 * @property {'critical'|'warning'|'info'|string} [severity]
 * @property {string} [category]
 * @property {string} [title]
 * @property {string} [detail]
 */

/**
 * @typedef {Object} MarkdownNegotiationLike
 * @property {boolean} [supported]
 * @property {string|null} [contentType]
 * @property {boolean} [varyHasAccept]
 * @property {boolean} [csrEmptyShellTrap]
 * @property {number|null} [tokenCount]
 */

/**
 * @typedef {Object} RemediationInput
 * @property {Partial<StackAndWafResult>|null} [stack]
 * @property {Partial<WafAssessment>|null} [waf]
 * @property {AuditFindingLike[]} [findings]
 * @property {Partial<RobotsPolicyResult>|null} [robotsPolicy]
 * @property {Partial<CachingAnalysisResult>|null} [caching]
 * @property {MarkdownNegotiationLike|null} [markdownNegotiation]
 */

/**
 * @typedef {Object} RemediationRecipe
 * @property {string} id
 * @property {RemediationPriority} priority
 * @property {number} priorityRank
 * @property {string} stackId
 * @property {string} stackName
 * @property {RemediationLayer} layer
 * @property {string} title
 * @property {string} trigger
 * @property {string[]} steps
 * @property {string|null} snippet
 * @property {string|null} snippetLanguage
 * @property {string[]} relatedFindingIds
 */

/**
 * @typedef {Object} RemediationPlan
 * @property {RemediationRecipe[]} recipes
 * @property {{
 *   total: number,
 *   critical: number,
 *   high: number,
 *   medium: number,
 *   low: number,
 *   detectedStackIds: string[],
 * }} summary
 */

/** @type {Record<RemediationPriority, number>} */
const PRIORITY_RANK = Object.freeze({
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
});

/**
 * Collect all detected stack/WAF technology IDs from stack + waf inputs.
 * @param {Partial<StackAndWafResult>|null|undefined} stack
 * @param {Partial<WafAssessment>|null|undefined} waf
 * @returns {Set<string>}
 */
function collectStackIds(stack, waf) {
  /** @type {Set<string>} */
  const ids = new Set();
  if (stack) {
    if (Array.isArray(stack.technologies)) {
      for (const tech of stack.technologies) {
        if (tech && typeof tech.id === 'string') ids.add(tech.id.toLowerCase());
      }
    }
    if (typeof stack.primaryFramework === 'string' && stack.primaryFramework) {
      ids.add(stack.primaryFramework.toLowerCase());
    }
    if (typeof stack.primaryCdn === 'string' && stack.primaryCdn) {
      ids.add(stack.primaryCdn.toLowerCase());
    }
    if (typeof stack.primaryHosting === 'string' && stack.primaryHosting) {
      ids.add(stack.primaryHosting.toLowerCase());
    }
    if (typeof stack.primaryCms === 'string' && stack.primaryCms) {
      ids.add(stack.primaryCms.toLowerCase());
    }
  }
  const effectiveWaf = waf ?? stack?.waf ?? null;
  if (effectiveWaf) {
    if (typeof effectiveWaf.vendor === 'string' && effectiveWaf.vendor) {
      ids.add(effectiveWaf.vendor.toLowerCase());
    }
    if (Array.isArray(effectiveWaf.vendors)) {
      for (const v of effectiveWaf.vendors) {
        if (typeof v === 'string' && v) ids.add(v.toLowerCase());
      }
    }
  }
  return ids;
}

/**
 * Check whether any finding matches a set of ID substrings or categories.
 * @param {AuditFindingLike[]} findings
 * @param {string[]} patterns
 * @returns {string[]}
 */
function matchFindingIds(findings, patterns) {
  /** @type {string[]} */
  const matched = [];
  for (const f of findings) {
    const idLower = String(f.id ?? '').toLowerCase();
    const catLower = String(f.category ?? '').toLowerCase();
    const titleLower = String(f.title ?? '').toLowerCase();
    if (patterns.some((p) => idLower.includes(p) || catLower === p || titleLower.includes(p))) {
      matched.push(f.id);
    }
  }
  return matched;
}

/**
 * Build a prioritized, stack-specific remediation plan from observed audit signals.
 *
 * Returns `recipes: []` when no concrete issues are observed.
 *
 * @param {RemediationInput} input
 * @returns {RemediationPlan}
 */
export function buildRemediationPlan(input = {}) {
  const stack = input.stack ?? null;
  const waf = input.waf ?? stack?.waf ?? null;
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const robotsPolicy = input.robotsPolicy ?? null;
  const caching = input.caching ?? null;
  const markdownNegotiation = input.markdownNegotiation ?? null;

  const stackIds = collectStackIds(stack, waf);
  /** @type {Map<string, RemediationRecipe>} */
  const recipeMap = new Map();

  /**
   * @param {Omit<RemediationRecipe, 'priorityRank'>} recipe
   */
  const addRecipe = (recipe) => {
    if (recipeMap.has(recipe.id)) return;
    recipeMap.set(recipe.id, {
      ...recipe,
      priorityRank: PRIORITY_RANK[recipe.priority],
    });
  };

  // --- Derive normalized signal flags from concrete inputs ---
  const csrFindings = matchFindingIds(findings, [
    'csr',
    'empty_shell',
    'empty-shell',
    'hydration',
    'prose_parity',
    'js_only',
    'noscript',
  ]);
  const hasCsrProblem = csrFindings.length > 0;

  const payloadFindings = matchFindingIds(findings, [
    'payload',
    'truncation',
    'rsc_bloat',
    'next_data',
    'bloat',
    'content_start',
    '30kb',
    '100kb',
    '300kb',
    '2mb',
    'inline_blob',
  ]);
  const hasPayloadBloat = payloadFindings.length > 0;

  const spaFallbackFindings = matchFindingIds(findings, [
    'robots_txt_html_fallback',
    'soft_404_spa_fallback',
    'spa_fallback',
    'sitemap_html_fallback',
  ]);
  const hasSpaFallback = spaFallbackFindings.length > 0;

  const canonicalFindings = matchFindingIds(findings, [
    'canonical',
    'staging',
    'webflow.io',
    'noindex',
  ]);
  const hasCanonicalOrIndexIssue = canonicalFindings.length > 0;

  const cachingIssues = Array.isArray(caching?.issues) ? caching.issues : [];
  const cachingIssueIds = new Set(cachingIssues.map((i) => i.id));
  const hasLastModStampsNow = cachingIssueIds.has('last_modified_stamps_now');
  const hasNoStore = Boolean(caching?.cacheControl?.hasNoStore || cachingIssueIds.has('cache_control_no_store'));
  const hasMissingValidators =
    cachingIssueIds.has('missing_conditional_validators') ||
    (caching !== null && caching.conditionalGetReady === false);
  const hasMissingVaryRsc = cachingIssueIds.has('missing_vary_rsc_nextjs');
  const hasMissingVaryAccept =
    cachingIssueIds.has('missing_vary_accept_markdown') ||
    Boolean(markdownNegotiation?.supported && markdownNegotiation.varyHasAccept === false);
  const hasEdgeMarkdownCsrTrap = Boolean(markdownNegotiation?.csrEmptyShellTrap);

  const searchBotsBlocked = robotsPolicy?.summary?.searchRetrievalBlocked ?? [];
  const mixedBotsBlocked = robotsPolicy?.summary?.mixedSearchAiBlocked ?? [];
  const cfManaged = robotsPolicy?.cloudflareManaged ?? null;
  const cfManagedContradictions = cfManaged?.contradictions ?? [];
  const contentSignals = robotsPolicy?.contentSignals ?? null;
  const contentSignalConflicts = contentSignals?.conflicts ?? [];
  const suppressesAiInput = Boolean(contentSignals?.suppressesAiInput);
  const suppressesSearch = Boolean(contentSignals?.suppressesSearch);
  const endsWithRulelessGroup = Boolean(robotsPolicy?.endsWithRulelessGroup);

  const wafState = waf?.state ?? 'none';
  const wafVendors = new Set(
    [waf?.vendor, ...(Array.isArray(waf?.vendors) ? waf.vendors : [])]
      .filter((v) => typeof v === 'string' && v.length > 0)
      .map((v) => /** @type {string} */ (v).toLowerCase()),
  );
  const wafBlocked = wafState === 'challenge_or_block_intercepted';
  const wafBotMgmt = wafState === 'bot_management_active';

  // =========================================================================
  // 1. FRAMEWORKS
  // =========================================================================

  // --- Vite SPA ---
  if (stackIds.has('vite-spa')) {
    if (hasCsrProblem) {
      addRecipe({
        id: 'vite-spa-prerender-csr',
        priority: 'critical',
        stackId: 'vite-spa',
        stackName: 'Vite SPA',
        layer: 'framework',
        title: 'Pre-render public routes so non-JS AI search bots see real HTML',
        trigger: 'Vite SPA detected with empty/low-text raw HTML shell (OAI-SearchBot, Claude-SearchBot, and PerplexityBot do not execute JS).',
        steps: [
          'Pre-render public marketing, pricing, and docs routes at build time using Vike, vite-ssg, or vite-plugin-prerender — or move public content routes to Astro / Next.js / React Router v7 SSR.',
          'Ensure the pre-rendered HTML contains the exact same H1, core prose, tables, and JSON-LD that humans see after hydration (never cloak bot-only copy).',
          'Verify raw `curl -s https://your-domain/` returns full visible copy before deploying.',
        ],
        snippet: `// vite.config.ts (example with vite-plugin-prerender / Vike SSG)\nimport { defineConfig } from 'vite';\nimport vike from 'vike/plugin';\n\nexport default defineConfig({\n  plugins: [vike({ prerender: true })],\n});`,
        snippetLanguage: 'ts',
        relatedFindingIds: csrFindings,
      });
    }
    if (hasSpaFallback) {
      addRecipe({
        id: 'vite-spa-exclude-crawler-files',
        priority: 'high',
        stackId: 'vite-spa',
        stackName: 'Vite SPA',
        layer: 'framework',
        title: 'Exclude /robots.txt, /sitemap.xml, and /llms.txt from SPA index.html fallback',
        trigger: 'SPA catch-all rewrite is serving HTTP 200 HTML for crawler control files.',
        steps: [
          'Place real static `robots.txt` and `sitemap.xml` inside `public/` so Vite copies them to `dist/`.',
          'Exclude `/robots.txt`, `/sitemap.xml`, and `/llms.txt` from host catch-all rewrites so missing files return real `404` instead of `200 text/html`.',
        ],
        snippet: `# public/_redirects (Cloudflare Pages / Netlify — do NOT add '!' force flag)\n/robots.txt   /robots.txt   200\n/sitemap.xml  /sitemap.xml  200\n/*            /index.html   200`,
        snippetLanguage: 'text',
        relatedFindingIds: spaFallbackFindings,
      });
    }
  }

  // --- Next.js App Router ---
  if (stackIds.has('nextjs-app-router')) {
    if (hasCsrProblem || hasPayloadBloat) {
      addRecipe({
        id: 'nextjs-app-router-rsc-and-payload',
        priority: hasCsrProblem ? 'critical' : 'high',
        stackId: 'nextjs-app-router',
        stackName: 'Next.js (App Router)',
        layer: 'framework',
        title: 'Keep primary content in Server Components and trim RSC flight payload',
        trigger: hasCsrProblem
          ? 'Next.js App Router page exhibits CSR bailout / missing raw HTML copy.'
          : 'Next.js App Router RSC payload (`self.__next_f.push`) bloat risks silent truncation.',
        steps: [
          'Remove top-level `"use client"` from `page.tsx`; fetch primary prose, pricing tables, and JSON-LD in React Server Components so H1 and paragraph 1 land before 30 KB.',
          'Wrap client hooks like `useSearchParams()` inside a localized `<Suspense>` boundary instead of opting the whole route into CSR.',
          'Trim oversized objects passed as props from Server Components to Client Components (only pass fields rendered interactively) to cut `self.__next_f` flight bytes.',
          'Export `export const revalidate = 3600;` (or `generateStaticParams`) so static/ISR routes emit `x-nextjs-prerender` and stable `ETag` headers.',
        ],
        snippet: `// app/pricing/page.tsx (Server Component — NO top-level 'use client')\nexport const revalidate = 3600;\n\nexport default async function PricingPage() {\n  const plans = await fetchPlansOnServer();\n  // Pass only minimal scalar fields into interactive client islands\n  const clientPlans = plans.map(({ id, name, monthlyPrice }) => ({ id, name, monthlyPrice }));\n  return (\n    <main>\n      <h1>Pricing</h1>\n      <PricingTableStatic plans={plans} />\n      <PlanSelectorClient plans={clientPlans} />\n    </main>\n  );\n}`,
        snippetLanguage: 'ts',
        relatedFindingIds: [...csrFindings, ...payloadFindings],
      });
    }
    if (hasMissingVaryRsc) {
      addRecipe({
        id: 'nextjs-app-router-vary-rsc',
        priority: 'high',
        stackId: 'nextjs-app-router',
        stackName: 'Next.js (App Router)',
        layer: 'framework',
        title: 'Preserve Vary: Rsc, Next-Router-State-Tree on upstream CDN',
        trigger: 'Next.js App Router response is missing `Vary: Rsc` / `Next-Router-State-Tree`, risking CDN cache poisoning with raw Flight payloads.',
        steps: [
          'Configure your CDN (Cloudflare Cache Rules, Fastly VCL, CloudFront Cache Policy, or Akamai) to include `Rsc`, `Next-Router-State-Tree`, and `Next-Router-Prefetch` in the cache key and preserve the `Vary` header.',
          'Verify with `curl -I` that HTML responses retain `Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch`.',
        ],
        snippet: `// next.config.mjs (ensure custom headers do not overwrite Next.js Vary header)\nexport default {\n  async headers() {\n    return [\n      {\n        source: '/:path*',\n        headers: [\n          { key: 'Cache-Control', value: 'public, s-maxage=3600, stale-while-revalidate=86400' },\n        ],\n      },\n    ];\n  },\n};`,
        snippetLanguage: 'js',
        relatedFindingIds: ['missing_vary_rsc_nextjs'],
      });
    }
  }

  // --- Next.js Pages Router ---
  if (stackIds.has('nextjs-pages-router')) {
    if (hasCsrProblem || hasPayloadBloat || hasNoStore || hasMissingValidators) {
      addRecipe({
        id: 'nextjs-pages-router-gsp-and-props',
        priority: hasCsrProblem ? 'critical' : 'high',
        stackId: 'nextjs-pages-router',
        stackName: 'Next.js (Pages Router)',
        layer: 'framework',
        title: 'Render core copy in getStaticProps/getServerSideProps and prune __NEXT_DATA__',
        trigger: hasCsrProblem
          ? 'Next.js Pages Router page fetches primary content client-side.'
          : hasPayloadBloat
            ? 'Bloated `#__NEXT_DATA__` JSON payload pushes visible HTML copy toward truncation cliffs.'
            : 'Next.js Pages Router response lacks CDN-friendly caching headers.',
        steps: [
          'Move primary content fetching out of `useEffect`/`useSWR` into `getStaticProps` (with `revalidate`) or `getServerSideProps` so text renders in raw HTML.',
          'Strip unused CMS fields from `props` before returning so `#__NEXT_DATA__` stays compact.',
          'Set `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400` on public SSR routes.',
        ],
        snippet: `// pages/docs/[slug].tsx\nexport async function getServerSideProps({ params, res }) {\n  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');\n  const doc = await fetchDoc(params.slug);\n  // Prune unused CMS metadata to keep __NEXT_DATA__ lean\n  return { props: { title: doc.title, bodyHtml: doc.bodyHtml, updatedAt: doc.updatedAt } };\n}`,
        snippetLanguage: 'ts',
        relatedFindingIds: [...csrFindings, ...payloadFindings],
      });
    }
  }

  // --- Nuxt ---
  if (stackIds.has('nuxt') && (hasCsrProblem || hasNoStore)) {
    addRecipe({
      id: 'nuxt-enable-ssr-route-rules',
      priority: hasCsrProblem ? 'critical' : 'medium',
      stackId: 'nuxt',
      stackName: 'Nuxt',
      layer: 'framework',
      title: 'Enable SSR/prerendering and server-side useAsyncData in Nuxt',
      trigger: hasCsrProblem
        ? 'Nuxt page renders an empty `<div id="__nuxt"></div>` CSR shell (`ssr: false` or lazy client fetch).'
        : 'Nuxt public route sends `Cache-Control: no-store`.',
      steps: [
        'Ensure `ssr: true` in `nuxt.config.ts` and configure `routeRules` with `prerender: true` or `isr: 3600` for public marketing/docs/blog paths.',
        'Fetch primary copy with `useAsyncData()` / `useFetch()` using `{ server: true, lazy: false }` so copy lands in initial HTML.',
        'Emit `<title>`, canonical, and JSON-LD on the server via `useSeoMeta()` / `useHead()`.',
      ],
      snippet: `// nuxt.config.ts\nexport default defineNuxtConfig({\n  ssr: true,\n  routeRules: {\n    '/docs/**': { prerender: true },\n    '/blog/**': { isr: 3600 },\n  },\n});`,
      snippetLanguage: 'ts',
      relatedFindingIds: csrFindings,
    });
  }

  // --- Astro ---
  if (stackIds.has('astro') && (hasCsrProblem || hasCanonicalOrIndexIssue)) {
    addRecipe({
      id: 'astro-replace-client-only',
      priority: hasCsrProblem ? 'critical' : 'medium',
      stackId: 'astro',
      stackName: 'Astro',
      layer: 'framework',
      title: 'Replace client:only directives with SSR islands and lock canonical site config',
      trigger: hasCsrProblem
        ? 'Astro page omits primary copy from raw HTML (typically caused by `client:only` components).'
        : 'Astro canonical / trailingSlash configuration mismatch detected.',
      steps: [
        'Replace `<Component client:only="react" />` with `<Component client:load />`, `<Component client:visible />`, or a server-rendered `.astro` component so HTML is emitted at build/SSR time.',
        'Set `site` and `trailingSlash` consistently in `astro.config.mjs` to match `<link rel="canonical">` and `@astrojs/sitemap`.',
      ],
      snippet: `// astro.config.mjs\nimport { defineConfig } from 'astro/config';\nimport sitemap from '@astrojs/sitemap';\n\nexport default defineConfig({\n  site: 'https://example.com',\n  trailingSlash: 'never',\n  integrations: [sitemap()],\n});`,
      snippetLanguage: 'js',
      relatedFindingIds: [...csrFindings, ...canonicalFindings],
    });
  }

  // --- SvelteKit ---
  if (stackIds.has('sveltekit') && hasCsrProblem) {
    addRecipe({
      id: 'sveltekit-enable-ssr-load',
      priority: 'critical',
      stackId: 'sveltekit',
      stackName: 'SvelteKit',
      layer: 'framework',
      title: 'Enable ssr = true and move primary data loading into +page.server.ts',
      trigger: 'SvelteKit route delivers an empty or CSR-only HTML shell (`ssr = false` or `onMount()` data fetching).',
      steps: [
        'Remove `export const ssr = false` on all public routes (keep default `export const ssr = true`, and add `export const prerender = true` on static marketing/docs pages).',
        'Move primary content fetching out of `onMount()` into `+page.server.ts` `load()` so raw HTML contains full copy and headings.',
      ],
      snippet: `// src/routes/docs/[slug]/+page.server.ts\nexport const ssr = true;\nexport const prerender = true;\n\nexport async function load({ params }) {\n  const article = await getArticle(params.slug);\n  return { article };\n}`,
      snippetLanguage: 'ts',
      relatedFindingIds: csrFindings,
    });
  }

  // --- Remix / React Router v7 ---
  if (stackIds.has('remix') && (hasCsrProblem || hasNoStore)) {
    addRecipe({
      id: 'remix-server-loader-and-cache',
      priority: hasCsrProblem ? 'critical' : 'medium',
      stackId: 'remix',
      stackName: 'Remix / React Router v7',
      layer: 'framework',
      title: 'Fetch primary page data in server loader() and export Cache-Control headers',
      trigger: hasCsrProblem
        ? 'Remix / React Router v7 route relies on client-side data fetching (`clientLoader`/`useEffect`).'
        : 'Remix route emits `Cache-Control: no-store`.',
      steps: [
        'Move core page content fetching into the route server `loader()` export so SSR HTML includes all prose and structured data.',
        'Export a `headers` function setting `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` on public content routes.',
      ],
      snippet: `// app/routes/pricing.tsx\nexport function headers() {\n  return { 'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' };\n}\n\nexport async function loader() {\n  return { plans: await getPlans() };\n}`,
      snippetLanguage: 'ts',
      relatedFindingIds: csrFindings,
    });
  }

  // --- Gatsby ---
  if (stackIds.has('gatsby') && (hasCsrProblem || hasMissingValidators)) {
    addRecipe({
      id: 'gatsby-static-graphql-and-cache',
      priority: hasCsrProblem ? 'high' : 'low',
      stackId: 'gatsby',
      stackName: 'Gatsby',
      layer: 'framework',
      title: 'Render primary content via Gatsby build-time GraphQL queries instead of client fetch',
      trigger: hasCsrProblem
        ? 'Gatsby page fetches core text on the client after hydration.'
        : 'Gatsby HTML response lacks conditional caching validators.',
      steps: [
        'Move primary copy and structured data into Gatsby page `graphql` queries / `getStaticData` so static HTML builds include full text.',
        'Configure host headers to emit `ETag` and `Cache-Control: public, max-age=0, must-revalidate` for HTML files.',
      ],
      snippet: null,
      snippetLanguage: null,
      relatedFindingIds: csrFindings,
    });
  }

  // --- Create React App ---
  if (stackIds.has('create-react-app') && hasCsrProblem) {
    addRecipe({
      id: 'cra-migrate-or-prerender',
      priority: 'critical',
      stackId: 'create-react-app',
      stackName: 'Create React App',
      layer: 'framework',
      title: 'Eliminate Create React App empty #root shell via SSR migration or build prerendering',
      trigger: 'Create React App delivers a client-only `<div id="root"></div>` shell invisible to non-JS AI crawlers.',
      steps: [
        'Migrate public marketing/docs routes from deprecated Create React App to Next.js App Router, Astro, or React Router v7 SSR.',
        'If an immediate stopgap is needed, pre-render public routes at build time so `index.html` per route contains full semantic HTML.',
      ],
      snippet: null,
      snippetLanguage: null,
      relatedFindingIds: csrFindings,
    });
  }

  // =========================================================================
  // 2. CMS & E-COMMERCE
  // =========================================================================

  // --- WordPress ---
  if (stackIds.has('wordpress')) {
    if (hasPayloadBloat || hasLastModStampsNow || hasMissingValidators || hasNoStore || hasCanonicalOrIndexIssue) {
      addRecipe({
        id: 'wordpress-cache-and-payload',
        priority: hasPayloadBloat ? 'high' : 'medium',
        stackId: 'wordpress',
        stackName: 'WordPress',
        layer: 'cms',
        title: 'Enable full-page caching for stable ETag/Last-Modified and trim inline builder bloat',
        trigger: hasLastModStampsNow
          ? 'Dynamic WordPress PHP response stamps `Last-Modified` to current request time, breaking `304 Not Modified`.'
          : hasPayloadBloat
            ? 'Inline WordPress/page-builder CSS & JS pushes H1/body past truncation cliffs.'
            : 'WordPress HTML response has caching or indexing hygiene issues.',
        steps: [
          'Enable full-page caching (Nginx FastCGI cache, LiteSpeed Cache, WP Engine, or Kinsta edge cache) so public pages serve stable `ETag` and `Last-Modified` timestamps instead of stamping `now` on every PHP execution.',
          'Defer/externalize non-critical Elementor/page-builder inline CSS & JS (WP Rocket / Autoptimize / LiteSpeed) so `<h1>` and the first paragraph land before 30 KB.',
          'Verify Settings → Reading → "Discourage search engines" is unchecked and audit Yoast SEO / Rank Math canonical & virtual `/robots.txt` rules.',
        ],
        snippet: `# nginx FastCGI cache excerpt for WordPress public HTML\nfastcgi_cache_valid 200 60m;\netag on;\nadd_header Cache-Control "public, max-age=300, s-maxage=3600";`,
        snippetLanguage: 'nginx',
        relatedFindingIds: [...payloadFindings, ...canonicalFindings, ...cachingIssues.map((i) => i.id)],
      });
    }
  }

  // --- Webflow ---
  if (stackIds.has('webflow') && (hasCanonicalOrIndexIssue || searchBotsBlocked.length > 0 || hasCsrProblem)) {
    addRecipe({
      id: 'webflow-seo-canonical-robots',
      priority: searchBotsBlocked.length > 0 || hasCsrProblem ? 'high' : 'medium',
      stackId: 'webflow',
      stackName: 'Webflow',
      layer: 'cms',
      title: 'Lock Webflow Global Canonical, disable webflow.io indexing, and verify AI crawler access',
      trigger: searchBotsBlocked.length > 0
        ? `Webflow robots.txt blocks AI search crawlers (${searchBotsBlocked.join(', ')}).`
        : hasCsrProblem
          ? 'Webflow page hides primary CMS content behind client-side JS tabs/filters.'
          : 'Webflow canonical or staging subdomain indexing issue detected.',
      steps: [
        'In Webflow Site Settings → SEO: set Global Canonical Tag URL to your exact production host (`https://www.example.com` or apex) and enable "Disable Webflow Subdomain Indexing" (`*.webflow.io`).',
        'In Site Settings → SEO → Indexing: review custom `robots.txt` so `OAI-SearchBot`, `Claude-SearchBot`, and `PerplexityBot` are allowed, and enable Auto-generated Sitemap.',
        'Avoid JS-only CMS filtering/pagination for primary copy; ensure static HTML includes core product facts.',
      ],
      snippet: `# Webflow Site Settings -> SEO -> Indexing -> robots.txt\nUser-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: Claude-SearchBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /`,
      snippetLanguage: 'text',
      relatedFindingIds: [...canonicalFindings, ...csrFindings],
    });
  }

  // --- Shopify ---
  if (stackIds.has('shopify') && (searchBotsBlocked.length > 0 || hasCsrProblem || hasCanonicalOrIndexIssue)) {
    addRecipe({
      id: 'shopify-robots-liquid-and-ssr',
      priority: searchBotsBlocked.length > 0 || hasCsrProblem ? 'high' : 'medium',
      stackId: 'shopify',
      stackName: 'Shopify',
      layer: 'cms',
      title: 'Customize templates/robots.txt.liquid and render product specs in Liquid SSR',
      trigger: searchBotsBlocked.length > 0
        ? `Shopify robots.txt blocks AI search bots (${searchBotsBlocked.join(', ')}).`
        : hasCsrProblem
          ? 'Shopify theme JS apps inject primary product specs/reviews only client-side.'
          : 'Shopify canonical duplication (collection-scoped product URLs) detected.',
      steps: [
        'Create/edit `templates/robots.txt.liquid` in your theme to explicitly keep `OAI-SearchBot`, `Claude-SearchBot`, and `PerplexityBot` allowed on `/products/` and `/pages/`.',
        'Render core product specs, pricing, and FAQs in Liquid SSR (not client-only JS review/tab widgets) alongside `Product` JSON-LD.',
        'Ensure `<link rel="canonical" href="{{ canonical_url }}">` resolves to `/products/<handle>` rather than `/collections/<col>/products/<handle>`.',
      ],
      snippet: `{%- comment -%} templates/robots.txt.liquid {%- endcomment -%}\n{% for group in robots.default_groups %}\n  {{- group.user_agent -}}\n  {% for rule in group.rules %}\n    {{- rule -}}\n  {% endfor %}\n{% endfor %}\n\nUser-agent: OAI-SearchBot\nAllow: /products/\nAllow: /pages/\n\nUser-agent: Claude-SearchBot\nAllow: /products/\nAllow: /pages/\n\nUser-agent: PerplexityBot\nAllow: /products/\nAllow: /pages/`,
      snippetLanguage: 'liquid',
      relatedFindingIds: [...csrFindings, ...canonicalFindings],
    });
  }

  // =========================================================================
  // 3. CLOUDFLARE (SEPT 2026 DEFAULTS, MANAGED ROBOTS, CONTENT-SIGNAL, MARKDOWN, WAF)
  // =========================================================================

  const hasCloudflare =
    stackIds.has('cloudflare') ||
    stackIds.has('cloudflare-bot-management') ||
    stackIds.has('cloudflare-pages') ||
    wafVendors.has('cloudflare') ||
    wafVendors.has('cloudflare-bot-management') ||
    Boolean(cfManaged?.detected);

  if (hasCloudflare) {
    if (wafBlocked && (wafVendors.has('cloudflare') || wafVendors.has('cloudflare-bot-management'))) {
      addRecipe({
        id: 'cloudflare-waf-challenge-bypass',
        priority: 'critical',
        stackId: 'cloudflare-bot-management',
        stackName: 'Cloudflare WAF / Bot Management',
        layer: 'waf',
        title: 'Exempt verified AI search crawlers from Cloudflare Managed Challenges',
        trigger: 'Cloudflare edge intercepted the request with a challenge or block (`cf-mitigated: challenge` or challenge interstitial).',
        steps: [
          'Open Cloudflare Dashboard → Security → Bots / AI Crawl Control: set Search = Allow and verify verified AI Search bots (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) are not challenged.',
          'Add a WAF Custom Rule (Action: Skip → Managed Challenge / Bot Fight Mode) scoped to Cloudflare Verified AI Search Bots on public marketing/docs paths.',
          'Inspect Security → Events filtered against official OpenAI (`openai.com/searchbot.json`), Anthropic (`claude.com/crawling/bots.json`), and Perplexity (`perplexity.ai/perplexitybot.json`) CIDRs for 403/challenge spikes.',
        ],
        snippet: `# Cloudflare WAF Custom Rule Expression (Action: Skip Managed Challenge)\n(cf.client.bot and http.request.uri.path in {"/" "/pricing" "/docs"})`,
        snippetLanguage: 'text',
        relatedFindingIds: ['cf_mitigated_challenge'],
      });
    }

    if (cfManagedContradictions.length > 0) {
      addRecipe({
        id: 'cloudflare-managed-robots-override',
        priority: 'critical',
        stackId: 'cloudflare',
        stackName: 'Cloudflare',
        layer: 'cdn',
        title: 'Resolve Cloudflare Bot Preference Sync override contradicting origin robots.txt',
        trigger: `Cloudflare "# BEGIN Cloudflare Managed Content" block contradicts origin robots.txt rules (${cfManagedContradictions.map((c) => c.agent).join(', ')}).`,
        steps: [
          'Open Cloudflare Dashboard → Security → Bots / AI Crawl Control → Bot Preference Sync (formerly Managed Robots.txt).',
          'Either disable Bot Preference Sync so your origin `/robots.txt` is the single source of truth, OR align Cloudflare preferences with your origin rules.',
          'If you want AI search citations while blocking model training, configure `Content-Signal: search=yes, ai-input=yes, ai-train=no` and choose "Disallow AI Training" (Accountable crawlers) rather than hard "Block Training" (which also blocks mixed-use Googlebot/Bingbot/Applebot).',
        ],
        snippet: `# Unified robots.txt policy (allow search & AI grounding, opt out of training)\nUser-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\n\nUser-agent: __usage_ai-training\nDisallow: /`,
        snippetLanguage: 'text',
        relatedFindingIds: ['cf_managed_robots_override'],
      });
    }

    if (hasEdgeMarkdownCsrTrap) {
      addRecipe({
        id: 'cloudflare-markdown-for-agents-csr-trap',
        priority: 'critical',
        stackId: 'cloudflare',
        stackName: 'Cloudflare',
        layer: 'cdn',
        title: 'Fix Cloudflare Markdown-for-Agents returning empty CSR shell HTML',
        trigger: `Accept: text/markdown returned 200 text/markdown with an empty/nav-only CSR shell${markdownNegotiation?.tokenCount != null ? ` (x-markdown-tokens: ${markdownNegotiation.tokenCount})` : ''}.`,
        steps: [
          'Cloudflare edge Markdown conversion converts raw origin HTML without executing JavaScript — on CSR pages it serves an empty Markdown shell to agents.',
          'Pre-render or SSR public pages at the origin so raw HTML carries full content, OR disable Markdown for Agents on unrendered SPA routes until SSR/SSG is in place.',
          'Ensure Markdown responses include `Vary: Accept` so HTML browsers never receive cached Markdown.',
        ],
        snippet: null,
        snippetLanguage: null,
        relatedFindingIds: ['edge_markdown_csr_trap'],
      });
    }

    if (
      waf?.cloudflareSept2026Advisory ||
      mixedBotsBlocked.length > 0 ||
      suppressesAiInput ||
      suppressesSearch ||
      contentSignalConflicts.length > 0
    ) {
      addRecipe({
        id: 'cloudflare-sept2026-ai-crawl-control',
        priority: suppressesSearch || mixedBotsBlocked.length > 0 || contentSignalConflicts.length > 0 ? 'high' : 'medium',
        stackId: 'cloudflare',
        stackName: 'Cloudflare',
        layer: 'cdn',
        title: 'Audit Cloudflare Sept 2026 AI Crawl Control defaults and Content-Signal headers',
        trigger: contentSignalConflicts.length > 0
          ? `Content-Signal mismatch between robots.txt and HTTP headers (${contentSignalConflicts.map((c) => c.directive).join(', ')}).`
          : suppressesAiInput || suppressesSearch
            ? `Content-Signal restricts AI visibility (${suppressesSearch ? 'search=no' : 'ai-input=no'}).`
            : 'Cloudflare zone with bot telemetry/ad-tech detected — Sept 2026 defaults block Training + Agents on ad-monetized zones.',
        steps: [
          'Open Cloudflare Dashboard → Security → Bots / AI Crawl Control and verify Search = Allow.',
          'If blocking model training, pick "Disallow AI Training" (Accountable crawlers: Google, Microsoft, Apple) instead of hard "Block Training" so mixed-use Googlebot/Bingbot/Applebot are not inadvertently blocked.',
          'Align `Content-Signal` in both `/robots.txt` and HTTP response headers (`Content-Signal: search=yes, ai-input=yes, ai-train=no`) to remove header-vs-robots contradictions.',
        ],
        snippet: `Content-Signal: search=yes, ai-input=yes, ai-train=no`,
        snippetLanguage: 'text',
        relatedFindingIds: ['cf_sept2026_defaults_advisory'],
      });
    }
  }

  // =========================================================================
  // 4. HOSTING & EDGE PLATFORMS (VERCEL, NETLIFY, NGINX, AKAMAI, FASTLY)
  // =========================================================================

  // --- Vercel (+ Security Checkpoint) ---
  if (stackIds.has('vercel') || stackIds.has('vercel-security-checkpoint') || wafVendors.has('vercel')) {
    if (wafBlocked || wafBotMgmt || hasSpaFallback) {
      addRecipe({
        id: 'vercel-firewall-and-rewrites',
        priority: wafBlocked ? 'critical' : 'high',
        stackId: wafBlocked ? 'vercel-security-checkpoint' : 'vercel',
        stackName: wafBlocked ? 'Vercel Security Checkpoint' : 'Vercel',
        layer: wafBlocked ? 'waf' : 'hosting',
        title: wafBlocked
          ? 'Add Vercel Firewall Bypass rule for verified AI search crawlers'
          : 'Fix Vercel catch-all rewrites and verify production Deployment Protection',
        trigger: wafBlocked
          ? 'Vercel Security Checkpoint (`x-vercel-mitigated: challenge`) challenged the audit fetch; non-JS AI bots cannot solve JS checkpoints.'
          : 'Vercel SPA catch-all rewrite intercepts `/robots.txt` or `/sitemap.xml`.',
        steps: [
          'Open Vercel Dashboard → Project → Firewall: inspect blocked requests and add a Bypass rule for verified AI search crawler IP ranges (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) instead of global Attack Challenge Mode on public docs/marketing pages.',
          'Keep Deployment Protection disabled on production domains (preview-only).',
          'In `vercel.json`, exclude `/robots.txt`, `/sitemap.xml`, and `/llms.txt` from SPA catch-all rewrites.',
        ],
        snippet: `// vercel.json — exclude crawler files from SPA rewrite\n{\n  "rewrites": [\n    { "source": "/((?!robots\\\\.txt|sitemap\\\\.xml|llms\\\\.txt|assets/).*)", "destination": "/index.html" }\n  ]\n}`,
        snippetLanguage: 'json',
        relatedFindingIds: [...spaFallbackFindings],
      });
    }
  }

  // --- Netlify ---
  if (stackIds.has('netlify') && (hasSpaFallback || hasNoStore || hasMissingValidators)) {
    addRecipe({
      id: 'netlify-redirects-and-cache',
      priority: hasSpaFallback ? 'high' : 'medium',
      stackId: 'netlify',
      stackName: 'Netlify',
      layer: 'hosting',
      title: 'Remove force = true on Netlify SPA catch-all and set CDN cache headers',
      trigger: hasSpaFallback
        ? 'Netlify `_redirects` / `netlify.toml` catch-all serves `index.html` (200) for `/robots.txt` or `/sitemap.xml`.'
        : 'Netlify HTML response emits `Cache-Control: no-store` or lacks caching headers.',
      steps: [
        'Place real `robots.txt` and `sitemap.xml` in `public/` and remove `force = true` (or `200!`) from any `/* -> /index.html` SPA rewrite rule.',
        'Avoid `Cache-Control: no-store` on public HTML; configure `Netlify-CDN-Cache-Control` cleanly in `netlify.toml`.',
      ],
      snippet: `# netlify.toml\n[[redirects]]\n  from = "/*"\n  to = "/index.html"\n  status = 200\n  force = false\n\n[[headers]]\n  for = "/*"\n  [headers.values]\n    Cache-Control = "public, max-age=0, must-revalidate"\n    Netlify-CDN-Cache-Control = "public, s-maxage=3600, stale-while-revalidate=86400"`,
      snippetLanguage: 'toml',
      relatedFindingIds: [...spaFallbackFindings, ...cachingIssues.map((i) => i.id)],
    });
  }

  // --- nginx / OpenResty ---
  if (stackIds.has('nginx') || stackIds.has('openresty')) {
    if (hasSpaFallback || hasMissingValidators || hasNoStore || hasLastModStampsNow || wafBlocked) {
      addRecipe({
        id: 'nginx-crawler-files-and-etag',
        priority: hasSpaFallback || wafBlocked ? 'high' : 'medium',
        stackId: 'nginx',
        stackName: 'nginx',
        layer: 'server',
        title: 'Isolate crawler control files from try_files SPA fallback and enable ETag/304',
        trigger: hasSpaFallback
          ? 'nginx `try_files ... /index.html` returns HTML 200 for missing `/robots.txt`/`/sitemap.xml`/`/llms.txt`.'
          : 'nginx response lacks `ETag` / conditional `304 Not Modified` support or sets `no-store`.',
        steps: [
          'Add exact-match `location = /robots.txt`, `/sitemap.xml`, and `/llms.txt` blocks with `try_files $uri =404;` above any SPA `try_files` directive.',
          'Enable `etag on;` (weak `W/` ETags under gzip are valid for `304`), remove `Cache-Control: no-store` on public pages, and pass `If-None-Match` to upstreams.',
          'Exempt verified AI search IP CIDRs in `geo` / `limit_req_zone` instead of matching User-Agent strings alone.',
        ],
        snippet: `location = /robots.txt  { try_files $uri =404; }\nlocation = /sitemap.xml { try_files $uri =404; }\nlocation = /llms.txt    { try_files $uri =404; }\n\nlocation / {\n  etag on;\n  add_header Cache-Control "public, max-age=300, stale-while-revalidate=86400";\n  try_files $uri $uri/ /index.html;\n}`,
        snippetLanguage: 'nginx',
        relatedFindingIds: [...spaFallbackFindings, ...cachingIssues.map((i) => i.id)],
      });
    }
  }

  // --- Akamai (+ Bot Manager) ---
  if (
    stackIds.has('akamai') ||
    stackIds.has('akamai-bot-manager') ||
    wafVendors.has('akamai') ||
    wafVendors.has('akamai-bot-manager')
  ) {
    if (wafBlocked || wafBotMgmt || hasMissingVaryRsc) {
      addRecipe({
        id: 'akamai-bot-manager-allowlist',
        priority: wafBlocked ? 'critical' : 'high',
        stackId: 'akamai-bot-manager',
        stackName: 'Akamai Bot Manager',
        layer: 'waf',
        title: 'Allow verified AI Search bots in Akamai Bot Directory and audit Reference # blocks',
        trigger: wafBlocked
          ? 'Akamai returned 403 Access Denied (`Reference #...`) on a benign request.'
          : wafBotMgmt
            ? 'Akamai Bot Manager telemetry cookies (`_abck`/`ak_bmsc`/`bm_sv`) active — HTTP-only AI bots risk silent 403 blocks.'
            : 'Akamai edge cache is missing `Vary: Rsc` on Next.js App Router responses.',
        steps: [
          'Open Akamai Control Center → Bot Manager → Bot Directory and explicitly set Allow (or Monitor) for verified AI Search crawlers (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`).',
          'Audit `Reference #` 403 events in DataStream 2 / SIEM filtered by OpenAI, Anthropic, and Perplexity official JSON IP CIDRs.',
          'In Property Manager caching behaviors, preserve `ETag` and include `Rsc` / `Next-Router-State-Tree` in cache key if running Next.js App Router.',
        ],
        snippet: null,
        snippetLanguage: null,
        relatedFindingIds: [],
      });
    }
  }

  // --- Fastly (+ Next-Gen WAF) ---
  if (
    stackIds.has('fastly') ||
    stackIds.has('fastly-next-gen-waf') ||
    wafVendors.has('fastly') ||
    wafVendors.has('fastly-next-gen-waf')
  ) {
    if (wafBlocked || wafBotMgmt || hasMissingValidators || hasNoStore || hasMissingVaryRsc) {
      addRecipe({
        id: 'fastly-vcl-etag-and-ai-allowlist',
        priority: wafBlocked ? 'critical' : 'medium',
        stackId: 'fastly',
        stackName: 'Fastly',
        layer: wafBlocked ? 'waf' : 'cdn',
        title: 'Exempt verified AI search CIDRs in Fastly WAF and preserve ETag/Vary in VCL',
        trigger: wafBlocked
          ? 'Fastly / Next-Gen WAF blocked or rate-limited the benign request.'
          : 'Fastly response has missing `ETag`, `no-store`, or `Vary` hygiene issues.',
        steps: [
          'In Fastly Next-Gen WAF (Signal Sciences) or VCL rate limiting, exempt official OpenAI/Anthropic/Perplexity IP CIDRs and verify 200/304 rates in Real-Time Log Streaming.',
          'Ensure `vcl_fetch` does not unset `beresp.http.ETag` or `beresp.http.Last-Modified` and configure `beresp.stale_while_revalidate`.',
        ],
        snippet: `sub vcl_fetch {\n  # Preserve conditional GET validators and allow SWR\n  set beresp.stale_while_revalidate = 86400s;\n  if (beresp.http.Content-Type ~ "text/markdown") {\n    set beresp.http.Vary = if(beresp.http.Vary, beresp.http.Vary ", Accept", "Accept");\n  }\n}`,
        snippetLanguage: 'vcl',
        relatedFindingIds: [...cachingIssues.map((i) => i.id)],
      });
    }
  }

  // =========================================================================
  // 5. DEDICATED WAF / BOT PROTECTION VENDORS
  // =========================================================================

  // --- AWS WAF / CloudFront ---
  if (stackIds.has('aws-waf') || wafVendors.has('aws-waf')) {
    if (wafBlocked || wafBotMgmt) {
      addRecipe({
        id: 'aws-waf-bot-control-allowlist',
        priority: wafBlocked ? 'critical' : 'high',
        stackId: 'aws-waf',
        stackName: 'AWS WAF',
        layer: 'waf',
        title: 'Scope down AWSManagedRulesBotControlRuleSet for verified AI search IP sets',
        trigger: wafBlocked
          ? 'AWS WAF intercepted the request with `x-amzn-waf-action: challenge|captcha` or CloudFront 403 block.'
          : 'AWS WAF bot telemetry (`aws-waf-token`) is active; verify non-JS AI crawlers are not challenged.',
        steps: [
          'Create an AWS WAF IPSet synced from official OpenAI (`searchbot.json`), Anthropic (`bots.json`), and Perplexity (`perplexitybot.json`) CIDR feeds.',
          'Add a higher-priority `Allow` rule (or scope-down statement on `AWSManagedRulesBotControlRuleSet`) for those verified IP sets on public GET paths.',
        ],
        snippet: `{\n  "Name": "AllowVerifiedAiSearchCrawlers",\n  "Priority": 1,\n  "Action": { "Allow": {} },\n  "Statement": {\n    "IPSetReferenceStatement": { "ARN": "arn:aws:wafv2:us-east-1:ACCOUNT:global/ipset/verified-ai-search-bots/ID" }\n  }\n}`,
        snippetLanguage: 'json',
        relatedFindingIds: [],
      });
    }
  }

  // --- DataDome ---
  if (stackIds.has('datadome') || wafVendors.has('datadome')) {
    if (wafBlocked || wafBotMgmt) {
      addRecipe({
        id: 'datadome-verified-bots-allowlist',
        priority: wafBlocked ? 'critical' : 'high',
        stackId: 'datadome',
        stackName: 'DataDome',
        layer: 'waf',
        title: 'Allow verified AI Search bots in DataDome Bot Management',
        trigger: wafBlocked
          ? 'DataDome intercepted the request (`x-datadome: protected` / `captcha-delivery.com`).'
          : 'DataDome telemetry cookie (`datadome`) active; DataDome aggressively challenges unverified non-browser fetchers.',
        steps: [
          'Open DataDome Dashboard → Bot Management → Verified Bots.',
          'Set verified AI Search crawlers (OpenAI `OAI-SearchBot`, Anthropic `Claude-SearchBot`, Perplexity `PerplexityBot`) to Allow while keeping unverified training scrapers blocked.',
          'Confirm 200 OK status for verified AI search traffic in DataDome Explore logs.',
        ],
        snippet: null,
        snippetLanguage: null,
        relatedFindingIds: [],
      });
    }
  }

  // --- Imperva / Incapsula ---
  if (stackIds.has('imperva-incapsula') || wafVendors.has('imperva-incapsula')) {
    if (wafBlocked || wafBotMgmt) {
      addRecipe({
        id: 'imperva-known-good-bots-allowlist',
        priority: wafBlocked ? 'critical' : 'high',
        stackId: 'imperva-incapsula',
        stackName: 'Imperva / Incapsula',
        layer: 'waf',
        title: 'Exempt verified AI Search bots from Imperva reese84 JS challenges',
        trigger: wafBlocked
          ? 'Imperva/Incapsula returned `/_Incapsula_Resource` challenge interstitial or 403 block.'
          : 'Imperva Bot Protection cookies (`reese84` / `incap_ses_`) detected on 200 OK.',
        steps: [
          'Open Imperva Cloud Security Console → Bot Protection → Known Good Bots.',
          'Ensure verified AI Search crawlers (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) bypass `reese84` JavaScript challenges on public pages.',
        ],
        snippet: null,
        snippetLanguage: null,
        relatedFindingIds: [],
      });
    }
  }

  // --- HUMAN / PerimeterX ---
  if (stackIds.has('human-perimeterx') || wafVendors.has('human-perimeterx')) {
    if (wafBlocked || wafBotMgmt) {
      addRecipe({
        id: 'human-perimeterx-known-bots',
        priority: wafBlocked ? 'critical' : 'high',
        stackId: 'human-perimeterx',
        stackName: 'HUMAN / PerimeterX',
        layer: 'waf',
        title: 'Allowlist verified AI Search crawlers in HUMAN Bot Defender',
        trigger: wafBlocked
          ? 'HUMAN/PerimeterX served a block/Press & Hold challenge (`whywasiblocked`).'
          : 'HUMAN/PerimeterX telemetry cookies (`_px3`/`_pxhd`) detected.',
        steps: [
          'Open HUMAN Security Console → Bot Defender → Known Bots & Crawlers.',
          'Allow verified AI Search bots (verified via official IP CIDRs) on public content routes while retaining enforcement on login/checkout endpoints.',
        ],
        snippet: null,
        snippetLanguage: null,
        relatedFindingIds: [],
      });
    }
  }

  // --- Anubis PoW ---
  if (stackIds.has('anubis-pow') || wafVendors.has('anubis-pow')) {
    if (wafBlocked || wafBotMgmt) {
      addRecipe({
        id: 'anubis-pow-scope-policy',
        priority: wafBlocked ? 'critical' : 'high',
        stackId: 'anubis-pow',
        stackName: 'Anubis PoW',
        layer: 'waf',
        title: 'Scope Anubis Proof-of-Work off public docs/landing pages and allow verified search bots',
        trigger: 'Anubis JavaScript Proof-of-Work challenge (`anubis_challenge` / `-anubis-auth`) completely blocks non-JS AI search crawlers.',
        steps: [
          'Update `botPolicy.yaml` to ALLOW public static marketing/docs routes and restrict Anubis PoW challenges strictly to expensive dynamic routes (e.g., git blame/search/archive endpoints).',
          'Add CIDR allow rules for verified AI search crawlers if you want citations from ChatGPT Search, Claude Search, and Perplexity.',
        ],
        snippet: `# botPolicy.yaml (Anubis)\nbots:\n  - name: allow-public-docs\n    path_regex: "^/(docs|blog|pricing)(/.*)?$"\n    action: ALLOW\n  - name: challenge-expensive-git\n    path_regex: "^/.*/(blame|archive|search)"\n    action: CHALLENGE`,
        snippetLanguage: 'yaml',
        relatedFindingIds: [],
      });
    }
  }

  // --- Wordfence ---
  if (stackIds.has('wordfence') || wafVendors.has('wordfence')) {
    if (wafBlocked || wafBotMgmt) {
      addRecipe({
        id: 'wordfence-allowlist-ai-search',
        priority: wafBlocked ? 'critical' : 'medium',
        stackId: 'wordfence',
        stackName: 'Wordfence',
        layer: 'waf',
        title: 'Allowlist verified AI Search crawler IP ranges in Wordfence Firewall',
        trigger: wafBlocked
          ? 'Wordfence blocked the benign audit request.'
          : 'Wordfence WAF cookies detected on WordPress origin.',
        steps: [
          'In WordPress Admin → Wordfence → Firewall → All Options → Allowlisted IP addresses, review Rate Limiting and Live Traffic for blocked `OAI-SearchBot`, `Claude-SearchBot`, and `PerplexityBot` requests.',
          'Relax strict crawler rate-limiting on public cached pages and rely on official IP feeds rather than blocking all non-browser User-Agents.',
        ],
        snippet: null,
        snippetLanguage: null,
        relatedFindingIds: [],
      });
    }
  }

  // =========================================================================
  // 6. CROSS-CUTTING PROTOCOL / POLICY FIXES (ONLY WHEN TRIGGERED)
  // =========================================================================

  if (hasMissingVaryAccept) {
    addRecipe({
      id: 'markdown-vary-accept-cache-poisoning',
      priority: 'critical',
      stackId: stack?.primaryCdn ?? stack?.primaryHosting ?? 'http-edge',
      stackName: stack?.primaryCdn ?? stack?.primaryHosting ?? 'HTTP Edge / Origin',
      layer: 'policy',
      title: 'Add Vary: Accept to text/markdown responses to prevent CDN cache poisoning',
      trigger: 'Response served `Content-Type: text/markdown` without `Vary: Accept`.',
      steps: [
        'Append `Accept` to the `Vary` response header on every route performing `Accept: text/markdown` content negotiation.',
        'Purge existing CDN cache entries after deploying so HTML browsers never receive cached Markdown.',
      ],
      snippet: `Vary: Accept, Accept-Encoding`,
      snippetLanguage: 'text',
      relatedFindingIds: ['missing_vary_accept_markdown'],
    });
  }

  if (endsWithRulelessGroup) {
    addRecipe({
      id: 'robots-trailing-ruleless-group',
      priority: 'medium',
      stackId: 'robots-txt',
      stackName: 'robots.txt',
      layer: 'policy',
      title: 'Remove or complete dangling User-agent group at end of robots.txt',
      trigger: `robots.txt ends with a ruleless \`User-agent: ${robotsPolicy?.trailingRulelessAgent ?? '*'}\` group with no Allow/Disallow directives.`,
      steps: [
        'Either add explicit `Allow:` / `Disallow:` directives under the trailing `User-agent:` group or remove the dangling declaration.',
        'Prevent automated edge prepends/appends from accidentally binding future rules to the dangling agent.',
      ],
      snippet: `User-agent: ${robotsPolicy?.trailingRulelessAgent ?? '*'}\nAllow: /`,
      snippetLanguage: 'text',
      relatedFindingIds: ['robots_ends_with_ruleless_group'],
    });
  }

  if (!hasCloudflare && contentSignalConflicts.length > 0) {
    addRecipe({
      id: 'content-signal-header-robots-conflict',
      priority: 'high',
      stackId: 'content-signal',
      stackName: 'Content-Signal / AIPREF',
      layer: 'policy',
      title: 'Reconcile conflicting Content-Signal directives between robots.txt and HTTP headers',
      trigger: `robots.txt and HTTP headers disagree on: ${contentSignalConflicts.map((c) => `${c.directive} (robots=${c.robotsValue} vs header=${c.headerValue})`).join(', ')}.`,
      steps: [
        'Align `Content-Signal` directives across `/robots.txt` and HTTP response headers (`Content-Signal` / `Content-Usage`) so crawlers receive an unambiguous policy.',
        'Use `search=yes, ai-input=yes, ai-train=no` (plus `User-agent: __usage_ai-training` / `Disallow: /`) to allow AI search citations while opting out of training.',
      ],
      snippet: `# robots.txt\nUser-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\n\nUser-agent: __usage_ai-training\nDisallow: /`,
      snippetLanguage: 'text',
      relatedFindingIds: ['content_signal_conflict'],
    });
  }

  if (searchBotsBlocked.length > 0 && !stackIds.has('shopify') && !stackIds.has('webflow')) {
    addRecipe({
      id: 'robots-unblock-ai-search-retrieval',
      priority: 'critical',
      stackId: 'robots-txt',
      stackName: 'robots.txt',
      layer: 'policy',
      title: 'Allow AI search retrieval crawlers while keeping training opt-out separate',
      trigger: `robots.txt blocks AI search retrieval crawlers: ${searchBotsBlocked.join(', ')}.`,
      steps: [
        'Explicitly allow search retrieval bots (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) on public content paths so your site remains eligible for live AI citations.',
        'Keep model training opt-outs isolated to training tokens (`GPTBot`, `ClaudeBot`, `Google-Extended`, `__usage_ai-training`) rather than blocking search retrieval.',
      ],
      snippet: `User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: Claude-SearchBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\n# Training-only opt-out (does not harm AI search visibility)\nUser-agent: __usage_ai-training\nDisallow: /`,
      snippetLanguage: 'text',
      relatedFindingIds: ['robots_blocks_ai_search'],
    });
  }

  const recipes = [...recipeMap.values()].sort(
    (a, b) => a.priorityRank - b.priorityRank || a.layer.localeCompare(b.layer) || a.id.localeCompare(b.id),
  );

  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const r of recipes) {
    if (r.priority === 'critical') critical++;
    else if (r.priority === 'high') high++;
    else if (r.priority === 'medium') medium++;
    else low++;
  }

  return {
    recipes,
    summary: {
      total: recipes.length,
      critical,
      high,
      medium,
      low,
      detectedStackIds: [...stackIds].sort(),
    },
  };
}
