(function () {
  'use strict';

  var Z_95 = 1.96;

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Exact Wilson 95% score interval from core/metrics.js (§7).
   */
  function wilson(mentioned, n) {
    var total = Number(n) || 0;
    var hits = Number(mentioned) || 0;
    if (total <= 0) {
      return { n: 0, mentioned: 0, p: 0, lo: 0, hi: 0 };
    }
    var p = hits / total;
    var z2 = Z_95 * Z_95;
    var denom = 1 + z2 / total;
    var center = (p + z2 / (2 * total)) / denom;
    var half = (Z_95 * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
    return {
      n: total,
      mentioned: hits,
      p: p,
      lo: Math.max(0, center - half),
      hi: Math.min(1, center + half)
    };
  }

  function pct(x) {
    return Math.round(x * 100) + '%';
  }

  var BRANDS = [
    { id: 'Notewell', name: 'Notewell', domain: 'notewell.io', isSelf: true },
    { id: 'Otter.ai', name: 'Otter.ai', domain: 'otter.ai', isSelf: false },
    { id: 'Fireflies', name: 'Fireflies', domain: 'fireflies.ai', isSelf: false },
    { id: 'Granola', name: 'Granola', domain: 'granola.ai', isSelf: false }
  ];

  var SURFACES = [
    {
      id: 'openai',
      label: 'OpenAI Web Search',
      series: 'series: openai-api · gpt-5.6-luna · responses-search=required',
      attempted: 15,
      comparable: 15,
      perPhrasingN: [5, 5, 5],
      coverageNote: '15/15 comparable · verified search'
    },
    {
      id: 'anthropic',
      label: 'Claude Search',
      series: 'series: anthropic-api · claude-sonnet-5 · web_search=auto',
      attempted: 15,
      comparable: 15,
      perPhrasingN: [5, 5, 5],
      coverageNote: '15/15 comparable · bounded ≤3 searches'
    },
    {
      id: 'gemini',
      label: 'Gemini Grounding',
      series: 'series: gemini-api · gemini-3.6-flash · google-search-grounding',
      attempted: 15,
      comparable: 15,
      perPhrasingN: [5, 5, 5],
      coverageNote: '15/15 comparable · grounded chunks'
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      series: 'series: codex-agent · authenticated CLI · web_status=verified',
      attempted: 15,
      comparable: 14,
      perPhrasingN: [5, 5, 4],
      coverageNote: '14/15 comparable · 1 search timeout excluded'
    }
  ];

  var INTENTS = [
    {
      id: 'revops',
      label: 'CRM-Synced Sales Notes',
      phrasings: [
        'Best AI meeting notetaker that syncs call notes and MEDDIC fields to HubSpot or Salesforce?',
        'Which meeting transcription tool do B2B sales teams use for automatic CRM updates?',
        'AI call recorder alternatives for a 25-rep sales org without per-seat enterprise bloat'
      ],
      queries: {
        openai: [
          'best ai meeting notetaker hubspot salesforce meddic sync 2026',
          'b2b sales meeting transcription automatic crm updates hubspot',
          'ai call recorder alternatives 25 person sales team pricing'
        ],
        anthropic: [
          'AI meeting assistant HubSpot Salesforce structured field sync',
          'meeting transcription B2B sales CRM integration comparison',
          'lightweight Gong alternatives AI meeting notes sales team'
        ],
        gemini: [
          'best ai meeting notes crm sync hubspot salesforce g2',
          'top ai transcription tools for sales teams crm',
          'affordable ai call recording tools small sales org'
        ],
        codex: [
          'meeting notes webhook hubspot salesforce api meddic Notewell Fireflies Otter',
          'b2b call transcription crm sync docs pricing',
          'sales team meeting recorder per-seat pricing comparison'
        ]
      }
    },
    {
      id: 'botfree',
      label: 'Bot-Free Executive Capture',
      phrasings: [
        'AI meeting notes app that records system audio without a visible bot joining Zoom calls?',
        'Best discreet meeting summarizer for client and board conversations on Mac',
        'Tools that capture Zoom and Google Meet notes locally without an attendee bot'
      ],
      queries: {
        openai: [
          'ai meeting notes without bot joining zoom system audio 2026',
          'discreet mac meeting notepad executive board calls ai',
          'bot-free zoom google meet local audio transcription tools'
        ],
        anthropic: [
          'botless AI meeting recorder Mac system audio Zoom',
          'discreet AI meeting notes client calls comparison',
          'record Zoom without participant bot AI summary tools'
        ],
        gemini: [
          'no bot ai meeting assistant mac zoom google meet',
          'best bot free meeting note taker 2026 reviews',
          'capture meeting audio locally without bot joining call'
        ],
        codex: [
          'macos coreaudio bot-free meeting transcription Granola Notewell',
          'local audio capture meeting summarizer security architecture',
          'zoom meet transcription no attendee bot docs'
        ]
      }
    },
    {
      id: 'soc2',
      label: 'SOC 2 Startup Pricing',
      phrasings: [
        'Affordable SOC 2 Type II meeting transcription for a 40-person B2B startup?',
        'AI meeting assistant pricing comparison for teams with strict zero-data-retention rules',
        'Which AI meeting notes tool includes SSO and custom retention under $30/seat?'
      ],
      queries: {
        openai: [
          'affordable soc 2 type ii ai meeting transcription startup pricing',
          'ai meeting assistant zero data retention pricing comparison',
          'meeting notes tool sso custom retention under 30 per seat'
        ],
        anthropic: [
          'SOC 2 Type II AI meeting notes pricing startup team',
          'zero training retention policy AI transcription pricing',
          'AI meeting recorder SAML SSO cost per seat comparison'
        ],
        gemini: [
          'soc 2 compliant ai meeting assistant pricing g2 comparison',
          'ai transcription zero data retention enterprise vs pro plan',
          'cheapest ai meeting notes with sso under $30'
        ],
        codex: [
          'SOC2 Type II zero retention SSO pricing table notewell fireflies otter granola',
          'meeting transcription DPA retention controls API pricing',
          'saml sso seat cost ai meeting notes startup tier'
        ]
      }
    }
  ];

  /**
   * Per-(surface, intent) per-phrasing mention counts [p1, p2, p3] for each brand.
   * Totals match real multi-phrasing spread (e.g. [4, 2, 1] => 7/15 => 47% [25%-70%]).
   */
  var COUNTS = {
    openai: {
      revops: {
        phrasingSpreadPts: 28,
        rerunSpreadPts: 9,
        hits: { 'Fireflies': [5, 4, 2], 'Otter.ai': [3, 4, 2], 'Notewell': [4, 2, 1], 'Granola': [2, 2, 3] }
      },
      botfree: {
        phrasingSpreadPts: 26,
        rerunSpreadPts: 8,
        hits: { 'Granola': [5, 5, 4], 'Notewell': [4, 3, 2], 'Fireflies': [2, 2, 2], 'Otter.ai': [2, 1, 2] }
      },
      soc2: {
        phrasingSpreadPts: 31,
        rerunSpreadPts: 10,
        hits: { 'Fireflies': [4, 4, 3], 'Otter.ai': [4, 3, 2], 'Notewell': [4, 1, 1], 'Granola': [2, 2, 1] }
      }
    },
    anthropic: {
      revops: {
        phrasingSpreadPts: 25,
        rerunSpreadPts: 9,
        hits: { 'Fireflies': [4, 4, 3], 'Notewell': [4, 3, 1], 'Otter.ai': [3, 3, 2], 'Granola': [2, 2, 3] }
      },
      botfree: {
        phrasingSpreadPts: 22,
        rerunSpreadPts: 7,
        hits: { 'Granola': [5, 4, 4], 'Notewell': [4, 3, 3], 'Otter.ai': [2, 1, 1], 'Fireflies': [1, 2, 1] }
      },
      soc2: {
        phrasingSpreadPts: 29,
        rerunSpreadPts: 9,
        hits: { 'Fireflies': [4, 3, 3], 'Notewell': [4, 2, 1], 'Otter.ai': [3, 3, 2], 'Granola': [2, 2, 2] }
      }
    },
    gemini: {
      revops: {
        phrasingSpreadPts: 30,
        rerunSpreadPts: 11,
        hits: { 'Otter.ai': [5, 4, 4], 'Fireflies': [4, 4, 3], 'Granola': [2, 2, 2], 'Notewell': [2, 1, 1] }
      },
      botfree: {
        phrasingSpreadPts: 27,
        rerunSpreadPts: 10,
        hits: { 'Granola': [5, 4, 4], 'Otter.ai': [3, 3, 2], 'Fireflies': [3, 2, 2], 'Notewell': [3, 1, 1] }
      },
      soc2: {
        phrasingSpreadPts: 32,
        rerunSpreadPts: 10,
        hits: { 'Otter.ai': [4, 4, 4], 'Fireflies': [4, 4, 3], 'Notewell': [2, 1, 0], 'Granola': [2, 1, 1] }
      }
    },
    codex: {
      revops: {
        phrasingSpreadPts: 24,
        rerunSpreadPts: 8,
        hits: { 'Notewell': [4, 3, 2], 'Fireflies': [4, 3, 2], 'Granola': [2, 2, 2], 'Otter.ai': [2, 2, 1] }
      },
      botfree: {
        phrasingSpreadPts: 21,
        rerunSpreadPts: 7,
        hits: { 'Granola': [5, 4, 3], 'Notewell': [4, 4, 2], 'Fireflies': [2, 1, 1], 'Otter.ai': [1, 1, 1] }
      },
      soc2: {
        phrasingSpreadPts: 27,
        rerunSpreadPts: 8,
        hits: { 'Notewell': [4, 2, 1], 'Fireflies': [4, 3, 2], 'Otter.ai': [3, 2, 1], 'Granola': [2, 2, 1] }
      }
    }
  };

  /**
   * Build realistic search-URL vs final-citation evidence and verbatim answer receipt
   * for the currently selected (surface, intent, phrasingIdx, brand).
   */
  function getReceipt(surfaceId, intentId, phrasingIdx, selectedBrand) {
    var cell = COUNTS[surfaceId][intentId];
    var brandHitsInPhrasing = cell.hits[selectedBrand][phrasingIdx];
    var denomInPhrasing = SURFACES.find(function (s) { return s.id === surfaceId; }).perPhrasingN[phrasingIdx];
    var notewellHits = cell.hits['Notewell'][phrasingIdx];
    var notewellOmitted = notewellHits <= 1 && phrasingIdx >= 1;

    var rcptNum = 4100 + (SURFACES.findIndex(function (s) { return s.id === surfaceId; }) * 30) +
      (INTENTS.findIndex(function (i) { return i.id === intentId; }) * 7) + phrasingIdx;

    var returnedUrls = [];
    var citedUrls = [];
    var answerText = '';

    if (intentId === 'revops') {
      returnedUrls = [
        { url: 'https://www.g2.com/categories/ai-meeting-assistants', status: 'cited', gap: true },
        { url: 'https://fireflies.ai/integrations/hubspot', status: 'cited', gap: false },
        { url: 'https://otter.ai/sales', status: 'cited', gap: false },
        { url: 'https://notewell.io/docs/crm-webhooks', status: notewellOmitted ? 'uncited' : 'cited', gap: notewellOmitted },
        { url: 'https://notewell.io/pricing', status: 'uncited', gap: true }
      ];
      citedUrls = notewellOmitted
        ? [
            { url: 'https://www.g2.com/categories/ai-meeting-assistants', note: 'Citation gap · G2 matrix cites Otter.ai & Fireflies, omits Notewell', isGap: true },
            { url: 'https://fireflies.ai/integrations/hubspot', note: 'Competitor CRM integration page cited', isGap: false },
            { url: 'https://otter.ai/sales', note: 'Competitor sales tier page cited', isGap: false }
          ]
        : [
            { url: 'https://www.g2.com/categories/ai-meeting-assistants', note: 'Citation gap · G2 matrix cites Otter.ai & Fireflies, omits Notewell', isGap: true },
            { url: 'https://fireflies.ai/integrations/hubspot', note: 'Competitor HubSpot field matrix cited', isGap: false },
            { url: 'https://notewell.io/docs/crm-webhooks', note: 'Docs webhook page cited (while /pricing lacked tier table)', isGap: false }
          ];

      answerText = notewellOmitted
        ? 'For a 25-rep B2B sales team that wants CRM updates without enterprise seat minimums, Fireflies and Otter.ai are the two options most consistently cited in G2 comparisons. Fireflies maps call summaries into HubSpot and Salesforce deal stages automatically, while Otter.ai offers a dedicated Sales workspace with live coaching cues; Granola comes up when reps prefer lightweight local notes synced via Zapier.'
        : 'For structured MEDDIC writeback to HubSpot or Salesforce, Fireflies and Notewell are the strongest fits. Notewell maps custom qualification fields directly to deal properties with speaker-attributed quotes, while Fireflies covers the broadest set of native dialers. Otter.ai works well for standard recap logging, and Granola suits reps who want a lightweight notepad first.';
    } else if (intentId === 'botfree') {
      returnedUrls = [
        { url: 'https://www.granola.ai/', status: 'cited', gap: false },
        { url: 'https://zapier.com/blog/best-ai-meeting-assistant', status: 'cited', gap: true },
        { url: 'https://notewell.io/product/transcription', status: notewellOmitted ? 'uncited' : 'cited', gap: notewellOmitted },
        { url: 'https://fireflies.ai/blog/record-zoom-without-bot', status: 'cited', gap: false },
        { url: 'https://otter.ai/pricing', status: 'uncited', gap: false }
      ];
      citedUrls = notewellOmitted
        ? [
            { url: 'https://www.granola.ai/', note: 'Cited as primary Mac bot-free notepad', isGap: false },
            { url: 'https://zapier.com/blog/best-ai-meeting-assistant', note: 'Citation gap · roundup lists Granola & Fireflies, omits Notewell', isGap: true },
            { url: 'https://fireflies.ai/blog/record-zoom-without-bot', note: 'Competitor comparison post cited', isGap: false }
          ]
        : [
            { url: 'https://www.granola.ai/', note: 'Mac system-audio capture overview', isGap: false },
            { url: 'https://zapier.com/blog/best-ai-meeting-assistant', note: 'Citation gap · roundup lists Granola & Otter.ai, omits Notewell', isGap: true },
            { url: 'https://notewell.io/product/transcription', note: 'Cited for bot-free desktop recorder & searchable archive', isGap: false }
          ];

      answerText = notewellOmitted
        ? 'If you cannot have a virtual attendee bot appear in board or client Zoom rosters, Granola is the clearest choice on macOS: it captures system audio locally and enhances your typed rough notes after the call. Fireflies and Otter.ai primarily rely on meeting bots by default, though browser-extension workarounds exist with thinner speaker separation.'
        : 'To record Zoom and Google Meet conversations without a visible bot participant, look at Granola and Notewell first. Granola pairs a Mac menu-bar audio recorder with human bullet notes, whereas Notewell captures system audio locally while preserving multi-call search and action-item sync. Otter.ai and Fireflies remain bot-first unless configured through desktop extensions.';
    } else {
      returnedUrls = [
        { url: 'https://www.g2.com/categories/ai-meeting-assistants?tab=pricing', status: 'cited', gap: true },
        { url: 'https://fireflies.ai/pricing', status: 'cited', gap: false },
        { url: 'https://otter.ai/security', status: 'cited', gap: false },
        { url: 'https://notewell.io/pricing', status: notewellOmitted ? 'uncited' : 'cited', gap: true },
        { url: 'https://www.granola.ai/security', status: 'uncited', gap: false }
      ];
      citedUrls = notewellOmitted
        ? [
            { url: 'https://fireflies.ai/pricing', note: 'Public Business tier table ($19-$29/seat)', isGap: false },
            { url: 'https://www.g2.com/categories/ai-meeting-assistants?tab=pricing', note: 'Citation gap · G2 & /pricing lacked parseable Notewell SOC 2 table', isGap: true },
            { url: 'https://otter.ai/security', note: 'Competitor SOC 2 Type II page cited', isGap: false }
          ]
        : [
            { url: 'https://www.g2.com/categories/ai-meeting-assistants?tab=pricing', note: 'Citation gap · G2 pricing matrix omits Notewell SSO tier', isGap: true },
            { url: 'https://fireflies.ai/pricing', note: 'Business tier comparison cited', isGap: false },
            { url: 'https://notewell.io/pricing', note: 'Cited for SOC 2 Type II + zero-retention tier ($22/seat)', isGap: false }
          ];

      answerText = notewellOmitted
        ? 'Among SOC 2 Type II meeting assistants with published pricing under $30/seat, Fireflies Business ($19/user/month billed annually) and Otter.ai Business ($20/user/month) publish explicit retention controls, while SAML SSO typically requires stepping up to Enterprise quotes. Granola documents SOC 2 compliance for teams but keeps admin retention controls lighter.'
        : 'For a 40-person startup needing SOC 2 Type II, zero-training retention, and SSO under $30/seat, Notewell ($22/seat all-in with SAML SSO) and Fireflies Business ($19/seat, SSO on Enterprise) are the main contenders. Otter.ai documents SOC 2 Type II on Business plans, while Granola suits smaller teams with fewer centralized retention rules.';
    }

    var mentionedInSnippet = answerText.indexOf(selectedBrand) !== -1;
    var stanceClass = 'stance-neutral';
    var stanceLabel = 'Stance: Neutral · Hedged shortlist (rule H2)';

    if (!mentionedInSnippet) {
      stanceClass = 'stance-absent';
      stanceLabel = 'Stance: Absent · Citation gap (' + brandHitsInPhrasing + '/' + denomInPhrasing + ' in phrasing)';
    } else if (brandHitsInPhrasing >= 4) {
      stanceClass = 'stance-positive';
      stanceLabel = 'Stance: Positive · Recommended pick (rule R1)';
    } else if (brandHitsInPhrasing >= 3) {
      stanceClass = 'stance-positive';
      stanceLabel = 'Stance: Positive · Ranked shortlist (rule R2)';
    }

    return {
      receiptId: '#rcpt-' + rcptNum,
      stanceClass: stanceClass,
      stanceLabel: stanceLabel,
      returnedUrls: returnedUrls,
      citedUrls: citedUrls,
      answerText: answerText
    };
  }

  function highlightBrands(rawText, primaryBrand) {
    var safe = esc(rawText);
    var names = ['Notewell', 'Otter.ai', 'Fireflies', 'Granola'];
    names.forEach(function (brandName) {
      var escapedBrand = esc(brandName).replace('.', '\\.');
      var re = new RegExp('\\b(' + escapedBrand + ')', 'g');
      var cls = brandName === primaryBrand ? 'hl-primary' : 'hl-peer';
      safe = safe.replace(re, '<mark class="' + cls + '">$1</mark>');
    });
    return safe;
  }

  var state = {
    viewMode: 'hearsay',   // 'hearsay' | 'tracker'
    subTab: 'benchmark',   // 'benchmark' | 'outcomes'
    surface: 'openai',
    intent: 'revops',
    phrasingIdx: 0,
    brand: 'Notewell',
    outcomeReceipt: 'after' // 'before' | 'after'
  };

  /* 1. Theme Toggle */
  function initTheme() {
    var toggle = document.getElementById('theme-toggle');
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (!toggle) return;

    function syncThemeUi() {
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      toggle.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      if (metaTheme) {
        metaTheme.setAttribute('content', isLight ? '#f8fafc' : '#0a0c10');
      }
    }

    syncThemeUi();

    toggle.addEventListener('click', function () {
      var currentlyLight = document.documentElement.getAttribute('data-theme') === 'light';
      var nextTheme = currentlyLight ? 'dark' : 'light';
      if (nextTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      try {
        localStorage.setItem('hearsay-theme', nextTheme);
      } catch (_err) {
        /* localStorage may be disabled in restricted browsing modes */
      }
      syncThemeUi();
    });
  }

  /* 2. Two-Door Quickstart Tabs & Copy Buttons */
  function initQuickstart() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-door-tab]'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('[data-door-panel]'));

    function activateDoor(doorId, moveFocus) {
      tabs.forEach(function (tab) {
        var active = tab.getAttribute('data-door-tab') === doorId;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('tabindex', active ? '0' : '-1');
        if (active && moveFocus) tab.focus();
      });
      panels.forEach(function (panel) {
        var active = panel.getAttribute('data-door-panel') === doorId;
        if (active) {
          panel.removeAttribute('hidden');
        } else {
          panel.setAttribute('hidden', '');
        }
      });
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () {
        activateDoor(tab.getAttribute('data-door-tab'), false);
      });
      tab.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          var nextIdx = (index + 1) % tabs.length;
          activateDoor(tabs[nextIdx].getAttribute('data-door-tab'), true);
        }
      });
    });

    var copyBtns = Array.prototype.slice.call(document.querySelectorAll('[data-copy-target]'));
    var liveRegion = document.getElementById('copy-status');

    copyBtns.forEach(function (btn) {
      var originalLabel = btn.textContent;
      btn.addEventListener('click', function () {
        var targetId = btn.getAttribute('data-copy-target');
        var sourceEl = document.getElementById(targetId);
        if (!sourceEl) return;
        var text = sourceEl.textContent.trim();

        function markCopied() {
          btn.setAttribute('data-copied', 'true');
          btn.textContent = 'Copied';
          if (liveRegion) liveRegion.textContent = 'Copied snippet to clipboard.';
          setTimeout(function () {
            btn.removeAttribute('data-copied');
            btn.textContent = originalLabel;
          }, 1800);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(markCopied).catch(function () {
            fallbackCopy(text, markCopied);
          });
        } else {
          fallbackCopy(text, markCopied);
        }
      });
    });
  }

  function fallbackCopy(text, onDone) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      onDone();
    } catch (_err) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  /* 3. Sandbox & "$399/mo Tracker Lie" Mode Rendering */
  function renderSandbox() {
    var hearsayBtn = document.getElementById('mode-hearsay-btn');
    var trackerBtn = document.getElementById('mode-tracker-btn');
    var hearsayContainer = document.getElementById('hearsay-mode-container');
    var trackerContainer = document.getElementById('tracker-lie-container');

    if (!hearsayBtn || !trackerBtn || !hearsayContainer || !trackerContainer) return;

    var isHearsay = state.viewMode === 'hearsay';
    hearsayBtn.setAttribute('aria-pressed', isHearsay ? 'true' : 'false');
    trackerBtn.setAttribute('aria-pressed', isHearsay ? 'false' : 'true');

    if (isHearsay) {
      hearsayContainer.removeAttribute('hidden');
      trackerContainer.setAttribute('hidden', '');
    } else {
      hearsayContainer.setAttribute('hidden', '');
      trackerContainer.removeAttribute('hidden');
      return;
    }

    var subBenchmarkBtn = document.getElementById('subtab-benchmark');
    var subOutcomesBtn = document.getElementById('subtab-outcomes');
    var benchmarkPane = document.getElementById('sandbox-benchmark-pane');
    var outcomesPane = document.getElementById('sandbox-outcomes-pane');
    var seriesMeta = document.getElementById('series-meta-display');

    var surfaceObj = SURFACES.find(function (s) { return s.id === state.surface; }) || SURFACES[0];
    var intentObj = INTENTS.find(function (i) { return i.id === state.intent; }) || INTENTS[0];
    var cell = COUNTS[surfaceObj.id][intentObj.id];

    if (seriesMeta) {
      seriesMeta.textContent = state.subTab === 'benchmark'
        ? surfaceObj.series
        : 'intervention: intv-09 · notewell.io/pricing vs /product/transcription (14d UTC windows)';
    }

    if (state.subTab === 'benchmark') {
      subBenchmarkBtn.setAttribute('aria-selected', 'true');
      subOutcomesBtn.setAttribute('aria-selected', 'false');
      benchmarkPane.removeAttribute('hidden');
      outcomesPane.setAttribute('hidden', '');
    } else {
      subBenchmarkBtn.setAttribute('aria-selected', 'false');
      subOutcomesBtn.setAttribute('aria-selected', 'true');
      benchmarkPane.setAttribute('hidden', '');
      outcomesPane.removeAttribute('hidden');
      renderOutcomeReceiptToggle();
      return;
    }

    /* Update surface pills */
    var surfacePills = Array.prototype.slice.call(document.querySelectorAll('[data-surface]'));
    surfacePills.forEach(function (pill) {
      var active = pill.getAttribute('data-surface') === surfaceObj.id;
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    /* Update intent pills */
    var intentPills = Array.prototype.slice.call(document.querySelectorAll('[data-intent]'));
    intentPills.forEach(function (pill) {
      var active = pill.getAttribute('data-intent') === intentObj.id;
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    /* Compute brand metrics with real Wilson 95% intervals */
    var totalPanelMentions = 0;
    var computedRows = BRANDS.map(function (b) {
      var arr = cell.hits[b.id];
      var m = arr[0] + arr[1] + arr[2];
      totalPanelMentions += m;
      var w = wilson(m, surfaceObj.comparable);
      return {
        brand: b,
        perPhrasing: arr,
        mentioned: m,
        wilson: w
      };
    });

    computedRows.sort(function (a, b) {
      if (b.mentioned !== a.mentioned) return b.mentioned - a.mentioned;
      return a.brand.isSelf ? -1 : 1;
    });

    var coverageEl = document.getElementById('rates-coverage-note');
    if (coverageEl) {
      coverageEl.textContent = surfaceObj.coverageNote;
    }

    var rowsContainer = document.getElementById('brand-rows-container');
    if (rowsContainer) {
      rowsContainer.innerHTML = computedRows.map(function (row) {
        var sov = totalPanelMentions > 0 ? row.mentioned / totalPanelMentions : 0;
        var loPct = Math.round(row.wilson.lo * 100);
        var hiPct = Math.round(row.wilson.hi * 100);
        var pPct = Math.round(row.wilson.p * 100);
        var selected = row.brand.id === state.brand;
        var bandWidth = Math.max(2, hiPct - loPct);

        return (
          '<button type="button" class="brand-row tabular" role="option" data-brand-row="' + esc(row.brand.id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
            '<span class="brand-ident">' +
              '<span class="brand-name-line">' +
                esc(row.brand.name) +
                (row.brand.isSelf ? ' <span class="self-tag">Tracked</span>' : '') +
              '</span>' +
              '<span class="brand-domain">' + esc(row.brand.domain) + '</span>' +
            '</span>' +
            '<span class="ci-cell">' +
              '<span class="ci-track" aria-hidden="true">' +
                '<span class="ci-band" style="left:' + loPct + '%;width:' + bandWidth + '%"></span>' +
                '<span class="ci-point" style="left:' + pPct + '%"></span>' +
              '</span>' +
              '<span class="ci-stat"><strong>' + pPct + '%</strong> [' + loPct + '%–' + hiPct + '%] · ' + surfaceObj.comparable + '/' + surfaceObj.attempted + ' comparable</span>' +
            '</span>' +
            '<span class="sov-cell">' +
              '<strong>' + pct(sov) + '</strong>' +
              '<span>SOV (' + row.mentioned + '/' + totalPanelMentions + ')</span>' +
            '</span>' +
          '</button>'
        );
      }).join('');

      Array.prototype.slice.call(rowsContainer.querySelectorAll('[data-brand-row]')).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.brand = btn.getAttribute('data-brand-row');
          renderSandbox();
          var inspectorEl = document.getElementById('receipt-inspector-pane');
          if (inspectorEl && window.innerWidth <= 1024 && inspectorEl.scrollIntoView) {
            inspectorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
      });
    }

    var varianceEl = document.getElementById('variance-callout-box');
    if (varianceEl) {
      var selectedArr = cell.hits[state.brand];
      var pRates = selectedArr.map(function (hits, idx) {
        return Math.round((hits / surfaceObj.perPhrasingN[idx]) * 100) + '%';
      });
      varianceEl.innerHTML =
        '<strong>Phrasing sensitivity (' + esc(state.brand) + '):</strong> ' +
        pRates.join(' / ') + ' across 3 wordings of this intent · ' +
        '<strong>' + cell.phrasingSpreadPts + ' pt phrasing spread</strong> vs. ' +
        '<strong>' + cell.rerunSpreadPts + ' pt same-prompt rerun spread</strong>.';
    }

    /* Render Receipt Inspector */
    var receipt = getReceipt(surfaceObj.id, intentObj.id, state.phrasingIdx, state.brand);
    var rcptIdEl = document.getElementById('inspector-receipt-id');
    var stanceEl = document.getElementById('inspector-stance-badge');
    var phrasingTabsEl = document.getElementById('inspector-phrasing-tabs');
    var promptTextEl = document.getElementById('inspector-prompt-text');
    var queryTextEl = document.getElementById('inspector-query-text');
    var returnedListEl = document.getElementById('inspector-returned-urls');
    var citedListEl = document.getElementById('inspector-cited-urls');
    var answerEl = document.getElementById('inspector-answer-text');

    if (rcptIdEl) {
      rcptIdEl.textContent = receipt.receiptId + ' · ' + surfaceObj.label + ' · target=' + state.brand;
    }
    if (stanceEl) {
      stanceEl.className = 'stance-badge ' + receipt.stanceClass;
      stanceEl.textContent = receipt.stanceLabel;
    }

    if (phrasingTabsEl) {
      var brandArr = cell.hits[state.brand];
      phrasingTabsEl.innerHTML = intentObj.phrasings.map(function (_txt, idx) {
        var hits = brandArr[idx];
        var den = surfaceObj.perPhrasingN[idx];
        var active = idx === state.phrasingIdx;
        return (
          '<button type="button" class="phrasing-btn tabular" data-phrasing-idx="' + idx + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
            'Phrasing ' + (idx + 1) + ' · ' + hits + '/' + den + ' (' + Math.round((hits / den) * 100) + '%)' +
          '</button>'
        );
      }).join('');

      Array.prototype.slice.call(phrasingTabsEl.querySelectorAll('[data-phrasing-idx]')).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.phrasingIdx = Number(btn.getAttribute('data-phrasing-idx')) || 0;
          renderSandbox();
        });
      });
    }

    if (promptTextEl) {
      promptTextEl.textContent = '"' + intentObj.phrasings[state.phrasingIdx] + '"';
    }

    if (queryTextEl) {
      var q = intentObj.queries[surfaceObj.id][state.phrasingIdx];
      queryTextEl.textContent = q;
    }

    if (returnedListEl) {
      returnedListEl.innerHTML = receipt.returnedUrls.map(function (u) {
        var tagHtml = u.status === 'cited'
          ? '<span class="url-tag tag-cited">Cited</span>'
          : (u.gap
              ? '<span class="url-tag tag-gap">Retrieved · Not cited</span>'
              : '<span class="url-tag tag-uncited">Not cited</span>');
        return '<li class="url-item">' + esc(u.url.replace(/^https?:\/\//, '')) + tagHtml + '</li>';
      }).join('');
    }

    if (citedListEl) {
      citedListEl.innerHTML = receipt.citedUrls.map(function (c) {
        var gapBadge = c.isGap
          ? '<span class="url-tag tag-gap">Citation Gap</span>'
          : '<span class="url-tag tag-cited">Final citation</span>';
        return (
          '<li class="url-item">' +
            '<div>' + esc(c.url.replace(/^https?:\/\//, '')) + gapBadge + '</div>' +
            '<div style="color:var(--muted);font-size:10.5px;margin-top:2px;">' + esc(c.note) + '</div>' +
          '</li>'
        );
      }).join('');
    }

    if (answerEl) {
      answerEl.innerHTML = highlightBrands(receipt.answerText, state.brand);
    }
  }

  function renderOutcomeReceiptToggle() {
    var beforeBtn = document.getElementById('outcome-rcpt-before');
    var afterBtn = document.getElementById('outcome-rcpt-after');
    var box = document.getElementById('outcome-rcpt-body');
    if (!beforeBtn || !afterBtn || !box) return;

    var isAfter = state.outcomeReceipt === 'after';
    beforeBtn.setAttribute('aria-pressed', isAfter ? 'false' : 'true');
    afterBtn.setAttribute('aria-pressed', isAfter ? 'true' : 'false');

    if (isAfter) {
      box.innerHTML =
        '<div class="receipt-meta-bar" style="margin-bottom:8px;">' +
          '<span class="receipt-id">#rcpt-4891 · 2026-09-28T07:02Z · Post-change review snapshot</span>' +
          '<span class="stance-badge stance-positive">Cited: notewell.io/pricing#soc2-comparison</span>' +
        '</div>' +
        '<p class="answer-snippet">' +
          highlightBrands(
            'For a 40-person B2B team needing SOC 2 Type II, zero-data-retention controls, and SAML SSO under $30/seat, Notewell ($22/seat all-in per notewell.io/pricing) and Fireflies Business ($19/seat, SSO on Enterprise) are the clearest published options.',
            'Notewell'
          ) +
        '</p>';
    } else {
      box.innerHTML =
        '<div class="receipt-meta-bar" style="margin-bottom:8px;">' +
          '<span class="receipt-id">#rcpt-3912 · 2026-09-10T07:04Z · Frozen baseline snapshot</span>' +
          '<span class="stance-badge stance-absent">Citation gap · notewell.io/pricing retrieved (#4), not cited</span>' +
        '</div>' +
        '<p class="answer-snippet">' +
          highlightBrands(
            'Among SOC 2 Type II meeting assistants under $30/seat, Fireflies Business ($19/seat) and Otter.ai Business ($20/seat) publish explicit tier tables on their pricing and G2 pages; SAML SSO typically requires an Enterprise quote.',
            'Notewell'
          ) +
        '</p>';
    }
  }

  function initSandboxControls() {
    var hearsayBtn = document.getElementById('mode-hearsay-btn');
    var trackerBtn = document.getElementById('mode-tracker-btn');
    var backToHearsayBtn = document.getElementById('switch-back-hearsay');

    if (hearsayBtn) {
      hearsayBtn.addEventListener('click', function () {
        state.viewMode = 'hearsay';
        renderSandbox();
      });
    }
    if (trackerBtn) {
      trackerBtn.addEventListener('click', function () {
        state.viewMode = 'tracker';
        renderSandbox();
      });
    }
    if (backToHearsayBtn) {
      backToHearsayBtn.addEventListener('click', function () {
        state.viewMode = 'hearsay';
        renderSandbox();
      });
    }

    var subBenchmarkBtn = document.getElementById('subtab-benchmark');
    var subOutcomesBtn = document.getElementById('subtab-outcomes');
    var bridgeOutcomesBtn = document.getElementById('bridge-to-outcomes');

    if (subBenchmarkBtn) {
      subBenchmarkBtn.addEventListener('click', function () {
        state.subTab = 'benchmark';
        renderSandbox();
      });
    }
    if (subOutcomesBtn) {
      subOutcomesBtn.addEventListener('click', function () {
        state.subTab = 'outcomes';
        renderSandbox();
      });
    }
    if (bridgeOutcomesBtn) {
      bridgeOutcomesBtn.addEventListener('click', function () {
        state.subTab = 'outcomes';
        renderSandbox();
      });
    }

    Array.prototype.slice.call(document.querySelectorAll('[data-surface]')).forEach(function (pill) {
      pill.addEventListener('click', function () {
        state.surface = pill.getAttribute('data-surface');
        renderSandbox();
      });
    });

    Array.prototype.slice.call(document.querySelectorAll('[data-intent]')).forEach(function (pill) {
      pill.addEventListener('click', function () {
        state.intent = pill.getAttribute('data-intent');
        state.phrasingIdx = 0;
        renderSandbox();
      });
    });

    var beforeBtn = document.getElementById('outcome-rcpt-before');
    var afterBtn = document.getElementById('outcome-rcpt-after');
    if (beforeBtn) {
      beforeBtn.addEventListener('click', function () {
        state.outcomeReceipt = 'before';
        renderOutcomeReceiptToggle();
      });
    }
    if (afterBtn) {
      afterBtn.addEventListener('click', function () {
        state.outcomeReceipt = 'after';
        renderOutcomeReceiptToggle();
      });
    }

    renderSandbox();
  }

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initQuickstart();
    initSandboxControls();
  });
})();
