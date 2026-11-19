/**
 * Canonical AI crawler registry and zero-dependency passive stack/CDN/WAF
 * signature database for `hearsay check`.
 *
 * Pure Node 22 ESM — zero external runtime dependencies.
 * All signatures are strictly passive (no active probes, no UA spoofing) and
 * use literal pre-filters plus bounded regex quantifiers to prevent ReDoS.
 */

/**
 * @typedef {'search_retrieval'|'user_fetch'|'mixed_search_ai'|'training'|'policy_signal'} AiCrawlerCategory
 */

/**
 * @typedef {Object} AiCrawlerEntry
 * @property {string} token - Exact robots.txt User-Agent token.
 * @property {string} vendor - Operator / organization name.
 * @property {AiCrawlerCategory} category - Functional crawler classification.
 * @property {boolean} executesJs - Whether this crawler renders client-side JavaScript.
 * @property {boolean|'unclear'} respectsRobots - Whether the operator documents respecting robots.txt.
 * @property {string|null} ipFeedUrl - Official IP CIDR JSON feed or verification specification URL.
 * @property {string} [verificationNote] - Optional rDNS/ASN/policy note.
 */

/**
 * @typedef {'framework'|'cms'|'cdn'|'hosting'|'server'|'waf'} TechCategory
 */

/**
 * @typedef {Object} PatternRule
 * @property {string} [literal] - Lowercase substring pre-filter checked before regex execution.
 * @property {RegExp} [regex] - Bounded RegExp (capture group 1 extracts optional version).
 * @property {number} [confidence] - Match confidence weight (1-100, default 100).
 */

/**
 * @typedef {Object} CookieNameRule
 * @property {string} name - Human-readable cookie pattern label.
 * @property {string} [exact] - Exact lowercase cookie name match.
 * @property {string} [prefix] - Lowercase cookie name prefix match.
 * @property {RegExp} [regex] - Bounded regex tested strictly against the cookie NAME (never value).
 * @property {number} [confidence] - Match confidence weight (1-100, default 100).
 */

/**
 * @typedef {Object} ComboRule
 * @property {PatternRule[]} [scripts] - All script/link patterns that must match.
 * @property {PatternRule[]} [html] - All HTML patterns that must match.
 * @property {number} [confidence] - Match confidence weight (1-100, default 100).
 */

/**
 * @typedef {Object} TechSignature
 * @property {string} id - Stable kebab-case identifier.
 * @property {string} name - Human-readable technology name.
 * @property {TechCategory} category - Primary stack layer.
 * @property {string[]} [implies] - Transitive technology IDs implied by this match.
 * @property {Record<string, PatternRule|null>} [headers] - Lowercase header names mapped to pattern (null = presence match).
 * @property {CookieNameRule[]} [cookies] - Cookie NAME matchers (cookie values are never inspected).
 * @property {Record<string, PatternRule>} [meta] - Lowercase `<meta name="...">` mapped to content pattern.
 * @property {PatternRule[]} [scripts] - Patterns matched against `<script src>` and `<link href>` URLs.
 * @property {PatternRule[]} [html] - Patterns matched against raw HTML (literal pre-filtered).
 * @property {ComboRule[]} [combos] - Multi-signal conjunctions (all sub-patterns must match).
 * @property {string[]} [absentHtml] - Lowercase substrings that disqualify this signature if present in HTML.
 */

/**
 * Canonical AI crawler & policy-signal registry:
 * 18 crawlers across `search_retrieval` (5), `user_fetch` (5),
 * `mixed_search_ai` (3), and `training` (5), plus 3 `policy_signal` tokens
 * (`Google-Extended`, `Applebot-Extended`, `__usage_ai-training`).
 *
 * @type {readonly AiCrawlerEntry[]}
 */
export const AI_CRAWLER_REGISTRY = Object.freeze([
  // --- Search Retrieval (5) ---
  Object.freeze({
    token: 'OAI-SearchBot',
    vendor: 'OpenAI',
    category: 'search_retrieval',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://openai.com/searchbot.json',
    verificationNote: 'CIDR JSON feed (no rDNS)',
  }),
  Object.freeze({
    token: 'Claude-SearchBot',
    vendor: 'Anthropic',
    category: 'search_retrieval',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://claude.com/crawling/bots.json',
    verificationNote: 'Shared Anthropic crawler IP JSON feed',
  }),
  Object.freeze({
    token: 'PerplexityBot',
    vendor: 'Perplexity',
    category: 'search_retrieval',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://www.perplexity.ai/perplexitybot.json',
  }),
  Object.freeze({
    token: 'Amazonbot',
    vendor: 'Amazon',
    category: 'search_retrieval',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: null,
    verificationNote: 'Verify via rDNS *.crawl.amazonbot.amazon',
  }),
  Object.freeze({
    token: 'DuckAssistBot',
    vendor: 'DuckDuckGo',
    category: 'search_retrieval',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: null,
    verificationNote: 'DuckDuckGo crawler documentation',
  }),

  // --- User-Triggered Live Fetchers (5) ---
  Object.freeze({
    token: 'ChatGPT-User',
    vendor: 'OpenAI',
    category: 'user_fetch',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://openai.com/chatgpt-user.json',
  }),
  Object.freeze({
    token: 'Claude-User',
    vendor: 'Anthropic',
    category: 'user_fetch',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://claude.com/crawling/bots.json',
  }),
  Object.freeze({
    token: 'Perplexity-User',
    vendor: 'Perplexity',
    category: 'user_fetch',
    executesJs: false,
    respectsRobots: false,
    ipFeedUrl: 'https://www.perplexity.ai/perplexity-user.json',
    verificationNote: 'User-initiated fetch proxy; does not always obey robots.txt',
  }),
  Object.freeze({
    token: 'meta-externalfetcher',
    vendor: 'Meta',
    category: 'user_fetch',
    executesJs: false,
    respectsRobots: false,
    ipFeedUrl: null,
    verificationNote: 'Verify via ASN AS32934',
  }),
  Object.freeze({
    token: 'MistralAI-User',
    vendor: 'Mistral',
    category: 'user_fetch',
    executesJs: false,
    respectsRobots: 'unclear',
    ipFeedUrl: null,
    verificationNote: 'Mistral crawler documentation',
  }),

  // --- Mixed Search + AI Overviews / Assistants (3) ---
  Object.freeze({
    token: 'Googlebot',
    vendor: 'Google',
    category: 'mixed_search_ai',
    executesJs: true,
    respectsRobots: true,
    ipFeedUrl: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
    verificationNote: 'WRS Chromium rendering; verify via rDNS *.googlebot.com',
  }),
  Object.freeze({
    token: 'Bingbot',
    vendor: 'Microsoft',
    category: 'mixed_search_ai',
    executesJs: true,
    respectsRobots: true,
    ipFeedUrl: 'https://www.bing.com/toolbox/bingbot.json',
    verificationNote: 'Edge-based rendering; verify via rDNS *.search.msn.com',
  }),
  Object.freeze({
    token: 'Applebot',
    vendor: 'Apple',
    category: 'mixed_search_ai',
    executesJs: true,
    respectsRobots: true,
    ipFeedUrl: 'https://search.developer.apple.com/applebot.json',
    verificationNote: 'WebKit rendering; verify via rDNS *.applebot.apple.com',
  }),

  // --- Model Training Crawlers (5) ---
  Object.freeze({
    token: 'GPTBot',
    vendor: 'OpenAI',
    category: 'training',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://openai.com/gptbot.json',
  }),
  Object.freeze({
    token: 'ClaudeBot',
    vendor: 'Anthropic',
    category: 'training',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://claude.com/crawling/bots.json',
  }),
  Object.freeze({
    token: 'meta-externalagent',
    vendor: 'Meta',
    category: 'training',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: null,
    verificationNote: 'Verify via ASN AS32934',
  }),
  Object.freeze({
    token: 'Bytespider',
    vendor: 'ByteDance',
    category: 'training',
    executesJs: false,
    respectsRobots: false,
    ipFeedUrl: null,
    verificationNote: 'Frequently ignores robots.txt',
  }),
  Object.freeze({
    token: 'CCBot',
    vendor: 'Common Crawl',
    category: 'training',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://commoncrawl.org/ccbot',
  }),

  // --- Policy Signals (3) ---
  Object.freeze({
    token: 'Google-Extended',
    vendor: 'Google',
    category: 'policy_signal',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
    verificationNote: 'Training opt-out token for Gemini/Vertex; does not block Google Search',
  }),
  Object.freeze({
    token: 'Applebot-Extended',
    vendor: 'Apple',
    category: 'policy_signal',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://search.developer.apple.com/applebot.json',
    verificationNote: 'Training opt-out token for Apple AI; does not block Siri/Spotlight search',
  }),
  Object.freeze({
    token: '__usage_ai-training',
    vendor: 'IETF AIPREF',
    category: 'policy_signal',
    executesJs: false,
    respectsRobots: true,
    ipFeedUrl: 'https://datatracker.ietf.org/doc/draft-kelley-aipref-training-preference-signal/',
    verificationNote: 'Unified IETF AIPREF training-only opt-out token (Anthropic, OpenAI, Google, Bing)',
  }),
]);

/** @type {Map<string, AiCrawlerEntry>} */
const crawlerByTokenMap = new Map();
for (const entry of AI_CRAWLER_REGISTRY) {
  crawlerByTokenMap.set(entry.token.toLowerCase(), entry);
}

/**
 * Lookup map of canonical AI crawler entries keyed by lowercase token.
 * @type {ReadonlyMap<string, AiCrawlerEntry>}
 */
export const AI_CRAWLER_BY_TOKEN = crawlerByTokenMap;

/**
 * Curated MIT-inspired passive technology, CDN/hosting, web server, and WAF
 * signature database (68 rules).
 *
 * Every HTML pattern uses a lowercase `literal` pre-filter and strictly bounded
 * quantifiers to avoid ReDoS even on multi-megabyte HTML payloads.
 *
 * @type {readonly TechSignature[]}
 */
export const TECH_SIGNATURES = Object.freeze([
  // =========================================================================
  // FRAMEWORKS & BUILD TOOLS (22)
  // =========================================================================
  {
    id: 'nextjs-app-router',
    name: 'Next.js (App Router)',
    category: 'framework',
    implies: ['nextjs', 'react'],
    headers: {
      'x-nextjs-prerender': null,
      vary: { literal: 'rsc', regex: /\brsc\b|\bnext-router-state-tree\b/i, confidence: 95 },
    },
    scripts: [
      { literal: '/_next/static/chunks/app/', regex: /\/_next\/static\/chunks\/app\//i, confidence: 100 },
    ],
    html: [
      { literal: 'self.__next_f.push(', regex: /self\.__next_f\.push\(/, confidence: 100 },
      { literal: '__next_f', regex: /\(self\.__next_f\s*=\s*self\.__next_f\|\|\[\]\)/, confidence: 100 },
    ],
    absentHtml: ['id="__next_data__"', "id='__next_data__'"],
  },
  {
    id: 'nextjs-pages-router',
    name: 'Next.js (Pages Router)',
    category: 'framework',
    implies: ['nextjs', 'react'],
    scripts: [
      { literal: '/_next/static/chunks/pages/', regex: /\/_next\/static\/chunks\/pages\//i, confidence: 100 },
    ],
    html: [
      {
        literal: '__next_data__',
        regex: /<script\b[^>]{0,160}\bid=["']__NEXT_DATA__["']/i,
        confidence: 100,
      },
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    category: 'framework',
    implies: ['react'],
    headers: {
      'x-powered-by': { literal: 'next.js', regex: /^next\.js(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
      'x-nextjs-cache': null,
      'x-nextjs-matched-path': null,
      'x-nextjs-stale-time': null,
    },
    scripts: [
      { literal: '/_next/static/', regex: /\/_next\/static\//i, confidence: 90 },
    ],
    html: [
      { literal: '__next', regex: /<div\b[^>]{0,120}\bid=["']__next["']/i, confidence: 85 },
    ],
  },
  {
    id: 'vite-spa',
    name: 'Vite SPA',
    category: 'framework',
    implies: ['vite'],
    html: [
      { literal: 'vite-legacy-polyfill', regex: /\bid=["']vite-legacy-polyfill["']/i, confidence: 95 },
      { literal: 'vite-legacy-entry', regex: /\bid=["']vite-legacy-entry["']/i, confidence: 95 },
    ],
    combos: [
      {
        scripts: [
          {
            literal: '/assets/',
            regex: /\/assets\/[a-z0-9._-]{1,80}-[a-z0-9_-]{6,20}\.js(?:\?[^"'\s]{0,80})?$/i,
            confidence: 95,
          },
        ],
        html: [
          {
            literal: 'module',
            regex: /<script\b[^>]{0,180}(?:\btype=["']module["'][^>]{0,180}\bsrc=["'][^"']{0,160}\/assets\/|\bsrc=["'][^"']{0,160}\/assets\/[^"']{1,120}\.js["'][^>]{0,180}\btype=["']module["'])/i,
          },
          {
            literal: 'id=',
            regex: /<div\b[^>]{0,120}\bid=["'](?:root|app|react-root|main-app)["'][^>]{0,80}>\s*<\/div>/i,
          },
        ],
        confidence: 95,
      },
      {
        scripts: [
          {
            literal: '/assets/',
            regex: /\/assets\/[a-z0-9._-]{1,80}-[a-z0-9_-]{6,20}\.js(?:\?[^"'\s]{0,80})?$/i,
            confidence: 90,
          },
        ],
        html: [
          {
            literal: 'modulepreload',
            regex: /<link\b[^>]{0,180}(?:\brel=["']modulepreload["'][^>]{0,180}\bhref=["'][^"']{0,160}\/assets\/|\bhref=["'][^"']{0,160}\/assets\/[^"']{1,120}["'][^>]{0,180}\brel=["']modulepreload["'])/i,
          },
          {
            literal: 'id=',
            regex: /<div\b[^>]{0,120}\bid=["'](?:root|app|react-root|main-app)["'][^>]{0,80}>\s*<\/div>/i,
          },
        ],
        confidence: 90,
      },
    ],
    absentHtml: [
      '__next_data__',
      '__next_f',
      '__nuxt',
      '__nuxt_data__',
      'astro-island',
      '/_astro/',
      'data-sveltekit-',
      '__sveltekit_',
      '/_app/immutable/',
      '__remixcontext',
      '___gatsby',
    ],
  },
  {
    id: 'vite',
    name: 'Vite',
    category: 'framework',
    html: [
      { literal: '/@vite/client', regex: /\/@vite\/client/i, confidence: 100 },
      { literal: 'vite-legacy-polyfill', regex: /\bid=["']vite-legacy-polyfill["']/i, confidence: 95 },
    ],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    category: 'framework',
    implies: ['vue'],
    headers: {
      'x-powered-by': { literal: 'nuxt', regex: /^nuxt(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
    scripts: [
      { literal: '/_nuxt/', regex: /\/_nuxt\//i, confidence: 95 },
    ],
    html: [
      { literal: '__nuxt_data__', regex: /\bid=["']__NUXT_DATA__["']/i, confidence: 100 },
      { literal: 'window.__nuxt__', regex: /window\.__NUXT__\b/, confidence: 95 },
      { literal: '__nuxt', regex: /<div\b[^>]{0,120}\bid=["']__nuxt["']/i, confidence: 90 },
    ],
  },
  {
    id: 'astro',
    name: 'Astro',
    category: 'framework',
    meta: {
      generator: { literal: 'astro', regex: /^astro\s+v?([0-9.]{1,20})/i, confidence: 100 },
    },
    scripts: [
      { literal: '/_astro/', regex: /\/_astro\/[a-z0-9._-]{1,120}\.(?:js|css)/i, confidence: 95 },
    ],
    html: [
      { literal: '<astro-island', regex: /<astro-island\b/i, confidence: 100 },
      { literal: 'astro-', regex: /\bclass=["'][^"']{0,160}\bastro-[a-z0-9]{6,16}\b/i, confidence: 85 },
    ],
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    category: 'framework',
    implies: ['svelte', 'vite'],
    meta: {
      generator: { literal: 'sveltekit', regex: /sveltekit/i, confidence: 100 },
    },
    scripts: [
      { literal: '/_app/immutable/', regex: /\/_app\/immutable\//i, confidence: 95 },
    ],
    html: [
      { literal: 'data-sveltekit-', regex: /\sdata-sveltekit-[a-z-]{1,40}\b/i, confidence: 100 },
      { literal: '__sveltekit_', regex: /\b__sveltekit_[a-z0-9]{1,24}\b/i, confidence: 100 },
      { literal: 'svelte-announcer', regex: /\bid=["']svelte-announcer["']/i, confidence: 95 },
    ],
  },
  {
    id: 'remix',
    name: 'Remix / React Router v7',
    category: 'framework',
    implies: ['react'],
    html: [
      { literal: 'window.__remixcontext', regex: /window\.__remixContext\b/, confidence: 100 },
      { literal: 'window.__remixmanifest', regex: /window\.__remixManifest\b/, confidence: 100 },
      { literal: 'window.__reactroutercontext', regex: /window\.__reactRouterContext\b/, confidence: 95 },
    ],
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    category: 'framework',
    implies: ['react'],
    meta: {
      generator: { literal: 'gatsby', regex: /^gatsby(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
    html: [
      { literal: '___gatsby', regex: /\bid=["']___gatsby["']/i, confidence: 100 },
      { literal: 'gatsby-focus-wrapper', regex: /\bid=["']gatsby-focus-wrapper["']/i, confidence: 95 },
    ],
  },
  {
    id: 'create-react-app',
    name: 'Create React App',
    category: 'framework',
    implies: ['react'],
    combos: [
      {
        scripts: [
          {
            literal: '/static/js/main.',
            regex: /\/static\/js\/(?:main|bundle)\.[a-f0-9]{6,16}\.(?:chunk\.)?js/i,
            confidence: 95,
          },
        ],
        html: [
          { literal: 'root', regex: /<div\b[^>]{0,100}\bid=["']root["'][^>]{0,60}>/i },
        ],
        confidence: 95,
      },
    ],
    absentHtml: ['__next_data__', '__next_f', '__remixcontext', '___gatsby'],
  },
  {
    id: 'docusaurus',
    name: 'Docusaurus',
    category: 'framework',
    implies: ['react'],
    meta: {
      generator: { literal: 'docusaurus', regex: /^docusaurus\s+v?([0-9.]{1,20})/i, confidence: 100 },
    },
    html: [
      { literal: '__docusaurus', regex: /\bid=["']__docusaurus["']/i, confidence: 100 },
    ],
  },
  {
    id: 'hugo',
    name: 'Hugo',
    category: 'framework',
    meta: {
      generator: { literal: 'hugo', regex: /^hugo(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
  },
  {
    id: 'react',
    name: 'React',
    category: 'framework',
    html: [
      { literal: 'data-reactroot', regex: /\bdata-reactroot\b/i, confidence: 95 },
      { literal: 'data-reactid', regex: /\bdata-reactid=/i, confidence: 90 },
    ],
    scripts: [
      { literal: 'react-dom', regex: /\/react-dom(?:\.production)?(?:\.min)?\.js/i, confidence: 85 },
    ],
  },
  {
    id: 'vue',
    name: 'Vue.js',
    category: 'framework',
    html: [
      { literal: 'data-v-', regex: /\sdata-v-[a-f0-9]{6,12}\b/i, confidence: 90 },
      { literal: 'data-server-rendered', regex: /\bdata-server-rendered=["']true["']/i, confidence: 85 },
    ],
    scripts: [
      { literal: 'vue', regex: /\/vue(?:\.runtime)?(?:\.global)?(?:\.prod)?(?:\.min)?\.js/i, confidence: 85 },
    ],
  },
  {
    id: 'svelte',
    name: 'Svelte',
    category: 'framework',
    html: [
      { literal: 'svelte-', regex: /\bclass=["'][^"']{0,160}\bsvelte-[a-z0-9]{5,12}\b/i, confidence: 85 },
    ],
  },
  {
    id: 'angular',
    name: 'Angular',
    category: 'framework',
    html: [
      { literal: 'ng-version=', regex: /\bng-version=["']([0-9.]{1,20})["']/i, confidence: 100 },
      { literal: '_nghost-', regex: /\b_nghost-[a-z0-9-]{1,24}\b/i, confidence: 90 },
      { literal: '<app-root', regex: /<app-root\b/i, confidence: 80 },
    ],
  },
  {
    id: 'qwik',
    name: 'Qwik',
    category: 'framework',
    html: [
      { literal: 'q:container=', regex: /\bq:container=["'](?:paused|resumed)["']/i, confidence: 100 },
      { literal: 'q:version=', regex: /\bq:version=["']([0-9.]{1,20})["']/i, confidence: 100 },
    ],
  },
  {
    id: 'solidstart',
    name: 'SolidStart',
    category: 'framework',
    html: [
      { literal: '_$hy', regex: /window\._\$HY\b/, confidence: 95 },
      { literal: 'data-hk=', regex: /\bdata-hk=["'][0-9-]{1,24}["']/i, confidence: 90 },
    ],
  },
  {
    id: 'ember',
    name: 'Ember.js',
    category: 'framework',
    html: [
      { literal: 'ember-application', regex: /\bclass=["'][^"']{0,120}\bember-application\b/i, confidence: 95 },
      { literal: 'ember-view', regex: /\bclass=["'][^"']{0,120}\bember-view\b/i, confidence: 85 },
    ],
  },
  {
    id: 'htmx',
    name: 'htmx',
    category: 'framework',
    scripts: [
      { literal: 'htmx', regex: /\/htmx(?:\.min)?\.js/i, confidence: 95 },
    ],
    html: [
      { literal: 'hx-get=', regex: /\bhx-(?:get|post|swap|target)=["']/i, confidence: 90 },
    ],
  },
  {
    id: 'alpinejs',
    name: 'Alpine.js',
    category: 'framework',
    scripts: [
      { literal: 'alpinejs', regex: /alpinejs(?:@([0-9.]{1,20}))?/i, confidence: 95 },
    ],
    html: [
      { literal: 'x-data=', regex: /\bx-data=["'][^"']{0,120}["']/i, confidence: 85 },
    ],
  },

  // =========================================================================
  // CMS, SITE BUILDERS & E-COMMERCE (16)
  // =========================================================================
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'cms',
    headers: {
      link: { literal: 'api.w.org', regex: /rel=["']https:\/\/api\.w\.org\/["']/i, confidence: 100 },
      'x-pingback': { literal: 'xmlrpc.php', regex: /\/xmlrpc\.php$/i, confidence: 95 },
    },
    cookies: [
      { name: 'wordpress_*', prefix: 'wordpress_', confidence: 95 },
      { name: 'wp-settings-*', prefix: 'wp-settings-', confidence: 95 },
    ],
    meta: {
      generator: { literal: 'wordpress', regex: /^wordpress(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
    scripts: [
      { literal: '/wp-content/', regex: /\/wp-content\/(?:themes|plugins)\//i, confidence: 95 },
      { literal: '/wp-includes/', regex: /\/wp-includes\/js\//i, confidence: 95 },
      { literal: 'wp-embed', regex: /wp-embed(?:\.min)?\.js/i, confidence: 95 },
    ],
    html: [
      { literal: '/wp-content/', regex: /\/wp-content\/(?:themes|plugins)\//i, confidence: 90 },
    ],
  },
  {
    id: 'webflow',
    name: 'Webflow',
    category: 'cms',
    meta: {
      generator: { literal: 'webflow', regex: /^webflow\b/i, confidence: 100 },
    },
    scripts: [
      { literal: 'website-files.com', regex: /assets(?:-global)?\.website-files\.com\//i, confidence: 95 },
    ],
    html: [
      { literal: 'data-wf-site=', regex: /<html\b[^>]{0,200}\bdata-wf-site=["'][a-f0-9]{12,32}["']/i, confidence: 100 },
      { literal: 'data-wf-page=', regex: /\bdata-wf-page=["'][a-f0-9]{12,32}["']/i, confidence: 95 },
    ],
  },
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'cms',
    headers: {
      'x-shopid': null,
      'x-shopify-stage': null,
      'x-sorting-hat-shopid': null,
      'powered-by': { literal: 'shopify', regex: /\bshopify\b/i, confidence: 100 },
    },
    cookies: [
      { name: '_shopify_y', exact: '_shopify_y', confidence: 100 },
      { name: '_shopify_s', exact: '_shopify_s', confidence: 100 },
    ],
    meta: {
      'shopify-checkout-api-token': { regex: /.{1,120}/, confidence: 100 },
    },
    scripts: [
      { literal: 'cdn.shopify.com', regex: /cdn\.shopify\.com\//i, confidence: 95 },
    ],
    html: [
      { literal: 'shopify.theme', regex: /\bShopify\.theme\b/, confidence: 95 },
    ],
  },
  {
    id: 'ghost',
    name: 'Ghost',
    category: 'cms',
    headers: {
      'x-powered-by': { literal: 'ghost', regex: /^ghost(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
    meta: {
      generator: { literal: 'ghost', regex: /^ghost\s+([0-9.]{1,20})/i, confidence: 100 },
    },
    html: [
      { literal: 'ghost-portal', regex: /data-ghost=["'][^"']{0,120}["']/i, confidence: 90 },
    ],
  },
  {
    id: 'squarespace',
    name: 'Squarespace',
    category: 'cms',
    headers: {
      server: { literal: 'squarespace', regex: /^squarespace\b/i, confidence: 100 },
    },
    cookies: [
      { name: 'crumb', exact: 'crumb', confidence: 60 },
      { name: 'ss_cvr', exact: 'ss_cvr', confidence: 95 },
    ],
    scripts: [
      { literal: 'static1.squarespace.com', regex: /static[0-9]?\.squarespace\.com\//i, confidence: 100 },
    ],
    html: [
      { literal: 'this is squarespace', regex: /<!--\s*this is squarespace\./i, confidence: 100 },
      { literal: 'squarespace-cdn.com', regex: /images\.squarespace-cdn\.com\//i, confidence: 95 },
    ],
  },
  {
    id: 'wix',
    name: 'Wix',
    category: 'cms',
    headers: {
      'x-wix-request-id': null,
      'x-wix-route-id': null,
    },
    meta: {
      generator: { literal: 'wix.com', regex: /^wix\.com\b/i, confidence: 100 },
    },
    scripts: [
      { literal: 'static.parastorage.com', regex: /static\.parastorage\.com\//i, confidence: 95 },
      { literal: 'static.wixstatic.com', regex: /static\.wixstatic\.com\//i, confidence: 95 },
    ],
  },
  {
    id: 'drupal',
    name: 'Drupal',
    category: 'cms',
    headers: {
      'x-generator': { literal: 'drupal', regex: /^drupal\s+([0-9.]{1,20})/i, confidence: 100 },
      'x-drupal-cache': null,
      'x-drupal-dynamic-cache': null,
    },
    meta: {
      generator: { literal: 'drupal', regex: /^drupal\s+([0-9.]{1,20})/i, confidence: 100 },
    },
    html: [
      { literal: 'drupal-settings-json', regex: /data-drupal-selector=["']/i, confidence: 95 },
    ],
  },
  {
    id: 'joomla',
    name: 'Joomla',
    category: 'cms',
    meta: {
      generator: { literal: 'joomla', regex: /^joomla!(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
    scripts: [
      { literal: '/media/jui/', regex: /\/media\/(?:jui|system)\/js\//i, confidence: 85 },
    ],
  },
  {
    id: 'framer',
    name: 'Framer',
    category: 'cms',
    meta: {
      generator: { literal: 'framer', regex: /^framer(?:\s+([0-9a-z.]{1,20}))?/i, confidence: 100 },
    },
    scripts: [
      { literal: 'framerusercontent.com', regex: /framerusercontent\.com\//i, confidence: 95 },
    ],
    html: [
      { literal: 'data-framer-hydrate-v2', regex: /\bdata-framer-hydrate-v2\b/i, confidence: 100 },
    ],
  },
  {
    id: 'gitbook',
    name: 'GitBook',
    category: 'cms',
    headers: {
      'x-gitbook-route': null,
    },
    meta: {
      generator: { literal: 'gitbook', regex: /^gitbook(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
    html: [
      { literal: 'gitbook.io', regex: /app\.gitbook\.com|cdn\.gitbook\.io/i, confidence: 85 },
    ],
  },
  {
    id: 'mintlify',
    name: 'Mintlify',
    category: 'cms',
    implies: ['nextjs'],
    meta: {
      generator: { literal: 'mintlify', regex: /^mintlify/i, confidence: 100 },
    },
    scripts: [
      { literal: 'mintlify.s3', regex: /mintlify\.(?:s3|b-cdn|com)/i, confidence: 95 },
    ],
  },
  {
    id: 'readme',
    name: 'ReadMe',
    category: 'cms',
    headers: {
      'x-readme-version': null,
    },
    html: [
      { literal: 'readme-io', regex: /cdn\.readme\.io\//i, confidence: 95 },
    ],
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'cms',
    implies: ['wordpress'],
    meta: {
      generator: { literal: 'woocommerce', regex: /woocommerce(?:\s+([0-9.]{1,20}))?/i, confidence: 100 },
    },
    scripts: [
      { literal: '/plugins/woocommerce/', regex: /\/wp-content\/plugins\/woocommerce\//i, confidence: 95 },
    ],
  },
  {
    id: 'yoast-seo',
    name: 'Yoast SEO',
    category: 'cms',
    implies: ['wordpress'],
    html: [
      {
        literal: 'yoast seo plugin',
        regex: /<!--\s*this site is optimized with the yoast seo plugin(?:\s+v([0-9.]{1,20}))?/i,
        confidence: 100,
      },
      {
        literal: 'optimized with the yoast seo',
        regex: /<!--\s*optimized with the yoast seo/i,
        confidence: 95,
      },
    ],
  },
  {
    id: 'rankmath-seo',
    name: 'Rank Math SEO',
    category: 'cms',
    implies: ['wordpress'],
    html: [
      {
        literal: 'rank math seo',
        regex: /<!--\s*search engine optimization by rank math/i,
        confidence: 100,
      },
    ],
  },
  {
    id: 'elementor',
    name: 'Elementor',
    category: 'cms',
    implies: ['wordpress'],
    meta: {
      generator: { literal: 'elementor', regex: /elementor\s+([0-9.]{1,20})/i, confidence: 100 },
    },
    scripts: [
      { literal: '/plugins/elementor/', regex: /\/wp-content\/plugins\/elementor\//i, confidence: 95 },
    ],
  },

  // =========================================================================
  // CDNS, HOSTING & EDGE PLATFORMS (15)
  // =========================================================================
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'cdn',
    headers: {
      'cf-ray': null,
      'cf-cache-status': null,
      'cf-mitigated': null,
      server: { literal: 'cloudflare', regex: /^cloudflare\b/i, confidence: 100 },
    },
    cookies: [
      { name: '__cf_bm', exact: '__cf_bm', confidence: 95 },
      { name: 'cf_clearance', exact: 'cf_clearance', confidence: 95 },
      { name: '__cfduid', exact: '__cfduid', confidence: 90 },
    ],
  },
  {
    id: 'cloudflare-pages',
    name: 'Cloudflare Pages',
    category: 'hosting',
    implies: ['cloudflare'],
    headers: {
      'cf-pages': null,
      'x-cf-pages-project': null,
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'hosting',
    headers: {
      'x-vercel-id': null,
      'x-vercel-cache': null,
      'x-vercel-mitigated': null,
      server: { literal: 'vercel', regex: /^(?:vercel|now)\b/i, confidence: 100 },
    },
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'hosting',
    headers: {
      'x-nf-request-id': null,
      'netlify-vary': null,
      server: { literal: 'netlify', regex: /^netlify\b/i, confidence: 100 },
      'cache-status': { literal: 'netlify edge', regex: /"Netlify Edge"/i, confidence: 95 },
    },
  },
  {
    id: 'fastly',
    name: 'Fastly',
    category: 'cdn',
    headers: {
      'x-fastly-request-id': null,
      'fastly-restarts': null,
      'fastly-debug-digest': null,
      'x-served-by': { literal: 'cache-', regex: /^cache-[a-z]{3}\d+/i, confidence: 90 },
      vary: { literal: 'fastly-ssl', regex: /\bfastly-ssl\b/i, confidence: 90 },
      'x-timer': { literal: 's', regex: /^S\d{9,12}\.\d+,VS\d+,VE\d+/i, confidence: 85 },
    },
  },
  {
    id: 'akamai',
    name: 'Akamai',
    category: 'cdn',
    headers: {
      'akamai-grn': null,
      'x-akamai-transformed': null,
      'akamai-cache-status': null,
      'x-akamai-session-info': null,
      'x-edgeconnect-midmile-rtt': null,
      server: { literal: 'akamaighost', regex: /^akamaighost\b/i, confidence: 100 },
    },
  },
  {
    id: 'aws-cloudfront',
    name: 'AWS CloudFront',
    category: 'cdn',
    headers: {
      'x-amz-cf-id': null,
      'x-amz-cf-pop': null,
      via: { literal: 'cloudfront', regex: /\(cloudfront\)/i, confidence: 100 },
      server: { literal: 'cloudfront', regex: /^cloudfront\b/i, confidence: 100 },
    },
  },
  {
    id: 'bunnycdn',
    name: 'BunnyCDN',
    category: 'cdn',
    headers: {
      'cdn-pullzone': null,
      'cdn-uid': null,
      'cdn-requestid': null,
      server: { literal: 'bunnycdn', regex: /^bunnycdn\b/i, confidence: 100 },
    },
  },
  {
    id: 'github-pages',
    name: 'GitHub Pages',
    category: 'hosting',
    headers: {
      'x-github-request-id': null,
      server: { literal: 'github.com', regex: /^github\.com$/i, confidence: 100 },
    },
  },
  {
    id: 'fly-io',
    name: 'Fly.io',
    category: 'hosting',
    headers: {
      'fly-request-id': null,
      server: { literal: 'fly/', regex: /^fly\/([a-f0-9]{4,16})/i, confidence: 100 },
    },
  },
  {
    id: 'render',
    name: 'Render',
    category: 'hosting',
    headers: {
      'x-render-origin-server': null,
      'rndr-id': null,
    },
  },
  {
    id: 'wp-engine',
    name: 'WP Engine',
    category: 'hosting',
    implies: ['wordpress'],
    headers: {
      'wpe-backend': null,
      'x-powered-by': { literal: 'wp engine', regex: /^wp engine\b/i, confidence: 100 },
    },
  },
  {
    id: 'kinsta',
    name: 'Kinsta',
    category: 'hosting',
    implies: ['wordpress'],
    headers: {
      'x-kinsta-cache': null,
      'ki-edge': null,
    },
  },
  {
    id: 'azure-front-door',
    name: 'Azure Front Door',
    category: 'cdn',
    headers: {
      'x-azure-ref': null,
      'x-fd-healthprobe': null,
    },
  },
  {
    id: 'google-cloud-cdn',
    name: 'Google Cloud / Firebase Hosting',
    category: 'hosting',
    headers: {
      'x-cloud-trace-context': null,
      'x-firebase-hosting': null,
      server: { literal: 'google frontend', regex: /^google frontend$/i, confidence: 95 },
    },
  },

  // =========================================================================
  // WEB SERVERS (5)
  // =========================================================================
  {
    id: 'nginx',
    name: 'nginx',
    category: 'server',
    headers: {
      server: { literal: 'nginx', regex: /^nginx(?:\/([0-9.]{1,20}))?/i, confidence: 100 },
      'x-fastcgi-cache': null,
    },
  },
  {
    id: 'openresty',
    name: 'OpenResty',
    category: 'server',
    implies: ['nginx'],
    headers: {
      server: { literal: 'openresty', regex: /^openresty(?:\/([0-9.]{1,20}))?/i, confidence: 100 },
    },
  },
  {
    id: 'apache',
    name: 'Apache HTTP Server',
    category: 'server',
    headers: {
      server: { literal: 'apache', regex: /^apache(?:\/([0-9.]{1,20}))?/i, confidence: 100 },
    },
  },
  {
    id: 'caddy',
    name: 'Caddy',
    category: 'server',
    headers: {
      server: { literal: 'caddy', regex: /^caddy(?:\/([0-9.]{1,20}))?/i, confidence: 100 },
    },
  },
  {
    id: 'litespeed',
    name: 'LiteSpeed',
    category: 'server',
    headers: {
      server: { literal: 'litespeed', regex: /^litespeed\b/i, confidence: 100 },
      'x-litespeed-cache': null,
      'x-lsadc-cache': null,
    },
  },

  // =========================================================================
  // WAF & BOT PROTECTION (10)
  // =========================================================================
  {
    id: 'cloudflare-bot-management',
    name: 'Cloudflare Bot Management',
    category: 'waf',
    implies: ['cloudflare'],
    headers: {
      'cf-mitigated': { literal: 'challenge', regex: /challenge/i, confidence: 100 },
    },
    cookies: [
      { name: '__cf_bm', exact: '__cf_bm', confidence: 100 },
      { name: 'cf_clearance', exact: 'cf_clearance', confidence: 100 },
    ],
    html: [
      { literal: '/cdn-cgi/challenge-platform/', regex: /\/cdn-cgi\/challenge-platform\//i, confidence: 100 },
      { literal: '_cf_chl_opt', regex: /window\._cf_chl_opt\b/, confidence: 100 },
      { literal: 'attention required! | cloudflare', regex: /attention required!\s*\|\s*cloudflare/i, confidence: 100 },
    ],
  },
  {
    id: 'vercel-security-checkpoint',
    name: 'Vercel Security Checkpoint',
    category: 'waf',
    implies: ['vercel'],
    headers: {
      'x-vercel-mitigated': { literal: 'challenge', regex: /challenge/i, confidence: 100 },
    },
    html: [
      { literal: 'vercel security checkpoint', regex: /<title>\s*vercel security checkpoint\s*<\/title>/i, confidence: 100 },
      { literal: '/.well-known/vercel/security/', regex: /\/\.well-known\/vercel\/security\/request-challenge/i, confidence: 100 },
    ],
  },
  {
    id: 'akamai-bot-manager',
    name: 'Akamai Bot Manager',
    category: 'waf',
    implies: ['akamai'],
    cookies: [
      { name: '_abck', exact: '_abck', confidence: 100 },
      { name: 'ak_bmsc', exact: 'ak_bmsc', confidence: 100 },
      { name: 'bm_sv', exact: 'bm_sv', confidence: 95 },
      { name: 'bm_sz', exact: 'bm_sz', confidence: 95 },
    ],
    html: [
      { literal: 'errors.edgesuite.net', regex: /errors\.edgesuite\.net/i, confidence: 95 },
    ],
  },
  {
    id: 'aws-waf',
    name: 'AWS WAF',
    category: 'waf',
    headers: {
      'x-amzn-waf-action': { regex: /^(?:captcha|challenge)$/i, confidence: 100 },
      'x-blocked-by-waf': null,
    },
    cookies: [
      { name: 'aws-waf-token', exact: 'aws-waf-token', confidence: 100 },
    ],
    html: [
      { literal: 'captcha.awswaf.com', regex: /captcha\.awswaf\.com\//i, confidence: 100 },
      { literal: 'awswafcookiedomainlist', regex: /\bawsWafCookieDomainList\b/, confidence: 100 },
    ],
  },
  {
    id: 'datadome',
    name: 'DataDome',
    category: 'waf',
    headers: {
      'x-datadome': null,
      'x-datadome-cid': null,
      'x-dd-b': null,
      'x-dd-type': null,
      server: { literal: 'datadome', regex: /^datadome$/i, confidence: 100 },
    },
    cookies: [
      { name: 'datadome', exact: 'datadome', confidence: 100 },
      { name: 'datadome-_zld*', regex: /^datadome-_zld[pt]$/i, confidence: 100 },
    ],
    html: [
      { literal: 'captcha-delivery.com', regex: /(?:geo\.)?captcha-delivery\.com/i, confidence: 100 },
      { literal: 'ct.datadome.co/', regex: /ct\.datadome\.co\/[a-z]\.js/i, confidence: 95 },
    ],
  },
  {
    id: 'imperva-incapsula',
    name: 'Imperva / Incapsula',
    category: 'waf',
    headers: {
      'x-iinfo': null,
      'x-cdn': { regex: /\b(?:imperva|incapsula)\b/i, confidence: 100 },
    },
    cookies: [
      { name: 'incap_ses_*', prefix: 'incap_ses_', confidence: 100 },
      { name: 'visid_incap_*', prefix: 'visid_incap_', confidence: 100 },
      { name: 'reese84', exact: 'reese84', confidence: 100 },
    ],
    html: [
      { literal: '/_incapsula_resource', regex: /\/_Incapsula_Resource/i, confidence: 100 },
      { literal: 'incapsula incident id', regex: /incapsula incident id/i, confidence: 100 },
    ],
  },
  {
    id: 'human-perimeterx',
    name: 'HUMAN / PerimeterX',
    category: 'waf',
    cookies: [
      { name: '_px3', exact: '_px3', confidence: 100 },
      { name: '_pxhd', exact: '_pxhd', confidence: 100 },
      { name: '_pxvid', exact: '_pxvid', confidence: 95 },
      { name: '_px2', exact: '_px2', confidence: 95 },
    ],
    html: [
      { literal: 'whywasiblocked', regex: /perimeterx\.(?:com|net)\/whywasiblocked/i, confidence: 100 },
      { literal: 'client.perimeterx.', regex: /client\.perimeterx\.(?:net|com)/i, confidence: 95 },
    ],
  },
  {
    id: 'anubis-pow',
    name: 'Anubis PoW',
    category: 'waf',
    cookies: [
      { name: '*-anubis-auth', regex: /-anubis-auth$/i, confidence: 100 },
    ],
    html: [
      { literal: 'anubis_challenge', regex: /<script\b[^>]{0,120}\bid=["']anubis_challenge["']/i, confidence: 100 },
      { literal: 'anubis_version', regex: /<script\b[^>]{0,120}\bid=["']anubis_version["']/i, confidence: 100 },
      { literal: '/.within.website/x/cmd/anubis/', regex: /\/\.within\.website\/x\/cmd\/anubis\//i, confidence: 100 },
    ],
  },
  {
    id: 'wordfence',
    name: 'Wordfence',
    category: 'waf',
    implies: ['wordpress'],
    cookies: [
      { name: 'wfvt_*', prefix: 'wfvt_', confidence: 95 },
      { name: 'wordfence_verifiedhuman', prefix: 'wordfence_verifiedhuman', confidence: 100 },
    ],
    html: [
      { literal: 'generated by wordfence', regex: /generated by wordfence/i, confidence: 100 },
      { literal: 'wordfence', regex: /your access to this site has been limited by the site owner/i, confidence: 95 },
    ],
  },
  {
    id: 'fastly-next-gen-waf',
    name: 'Fastly Next-Gen WAF',
    category: 'waf',
    implies: ['fastly'],
    headers: {
      'x-sigsci-tags': null,
      'x-sigsci-requestid': null,
    },
  },
]);
