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

  /**
   * Two-component variance split from core/metrics.js (§6.6):
   *  - phrasingSpread = sqrt( mean_i[ (p_i - mean)^2 ] )
   *  - rerunSpread    = sqrt( mean_i[ p_i * (1 - p_i) / n_i ] )
   */
  function computeIntentSpreads(hitsArr, denomArr) {
    var k = hitsArr.length;
    if (!k) return { phrasingSpreadPts: 0, rerunSpreadPts: 0 };
    var ps = [];
    var rerunSum = 0;
    var pSum = 0;
    for (var i = 0; i < k; i++) {
      var n = Number(denomArr[i]) || 0;
      var p = n > 0 ? (Number(hitsArr[i]) || 0) / n : 0;
      ps.push(p);
      pSum += p;
      if (n > 0) {
        rerunSum += (p * (1 - p)) / n;
      }
    }
    var mean = pSum / k;
    var phrasingVar = 0;
    for (var j = 0; j < k; j++) {
      var diff = ps[j] - mean;
      phrasingVar += diff * diff;
    }
    phrasingVar = phrasingVar / k;
    var rerunVar = rerunSum / k;
    return {
      phrasingSpreadPts: k >= 2 ? Math.round(Math.sqrt(phrasingVar) * 100) : 0,
      rerunSpreadPts: Math.round(Math.sqrt(rerunVar) * 100)
    };
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
      label: 'ChatGPT Search',
      attempted: 15,
      comparable: 15,
      perPhrasingN: [5, 5, 5],
      legendSuffix: 'across 15 live checks'
    },
    {
      id: 'anthropic',
      label: 'Claude Search',
      attempted: 15,
      comparable: 15,
      perPhrasingN: [5, 5, 5],
      legendSuffix: 'across 15 live checks'
    },
    {
      id: 'gemini',
      label: 'Gemini Search',
      attempted: 15,
      comparable: 15,
      perPhrasingN: [5, 5, 5],
      legendSuffix: 'across 15 live checks'
    },
    {
      id: 'codex',
      label: 'Codex Agent',
      attempted: 15,
      comparable: 14,
      perPhrasingN: [5, 5, 4],
      legendSuffix: 'across 14 live checks (1 timeout excluded)'
    }
  ];

  var INTENTS = [
    {
      id: 'revops',
      label: 'CRM Sales Notes',
      previews: [
        '\u201c\u2026MEDDIC fields to HubSpot\u201d',
        '\u201c\u2026automatic CRM updates\u201d',
        '\u201c\u202625-rep team, no bloat\u201d'
      ],
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
      label: 'No-Bot Zoom Notes',
      previews: [
        '\u201c\u2026no visible Zoom bot\u201d',
        '\u201c\u2026discreet Mac client calls\u201d',
        '\u201c\u2026capture locally, no bot\u201d'
      ],
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
      previews: [
        '\u201c\u2026SOC 2 for 40-person team\u201d',
        '\u201c\u2026zero-retention pricing\u201d',
        '\u201c\u2026SSO + retention under $30\u201d'
      ],
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

  var COUNTS = {
    openai: {
      revops: {
        hits: { 'Fireflies': [5, 4, 2], 'Otter.ai': [3, 4, 2], 'Notewell': [4, 2, 1], 'Granola': [2, 2, 3] }
      },
      botfree: {
        hits: { 'Granola': [5, 5, 4], 'Notewell': [4, 3, 2], 'Fireflies': [2, 2, 2], 'Otter.ai': [2, 1, 2] }
      },
      soc2: {
        hits: { 'Fireflies': [4, 4, 3], 'Otter.ai': [4, 3, 2], 'Notewell': [4, 1, 1], 'Granola': [2, 2, 1] }
      }
    },
    anthropic: {
      revops: {
        hits: { 'Fireflies': [4, 4, 3], 'Notewell': [4, 3, 1], 'Otter.ai': [3, 3, 2], 'Granola': [2, 2, 3] }
      },
      botfree: {
        hits: { 'Granola': [5, 4, 4], 'Notewell': [4, 3, 3], 'Otter.ai': [2, 1, 1], 'Fireflies': [1, 2, 1] }
      },
      soc2: {
        hits: { 'Fireflies': [4, 3, 3], 'Notewell': [4, 2, 1], 'Otter.ai': [3, 3, 2], 'Granola': [2, 2, 2] }
      }
    },
    gemini: {
      revops: {
        hits: { 'Otter.ai': [5, 4, 4], 'Fireflies': [4, 4, 3], 'Granola': [2, 2, 2], 'Notewell': [2, 1, 1] }
      },
      botfree: {
        hits: { 'Granola': [5, 4, 4], 'Otter.ai': [3, 3, 2], 'Fireflies': [3, 2, 2], 'Notewell': [3, 1, 1] }
      },
      soc2: {
        hits: { 'Otter.ai': [4, 4, 4], 'Fireflies': [4, 4, 3], 'Notewell': [2, 1, 0], 'Granola': [2, 1, 1] }
      }
    },
    codex: {
      revops: {
        hits: { 'Notewell': [4, 3, 2], 'Fireflies': [4, 3, 2], 'Granola': [2, 2, 2], 'Otter.ai': [2, 2, 1] }
      },
      botfree: {
        hits: { 'Granola': [5, 4, 3], 'Notewell': [4, 4, 2], 'Fireflies': [2, 1, 1], 'Otter.ai': [1, 1, 1] }
      },
      soc2: {
        hits: { 'Notewell': [4, 2, 1], 'Fireflies': [4, 3, 2], 'Otter.ai': [3, 2, 1], 'Granola': [2, 2, 1] }
      }
    }
  };

  /**
   * Build plain-English pages checked, verbatim AI answer, and brand-specific takeaway
   * so clicking ANY brand row, ANY wording pill, ANY topic, or ANY assistant is 100% coherent.
   */
  function getReceipt(surfaceObj, intentObj, phrasingIdx, selectedBrand) {
    var surfaceId = surfaceObj.id;
    var intentId = intentObj.id;
    var cell = COUNTS[surfaceId][intentId];
    var den = surfaceObj.perPhrasingN[phrasingIdx];
    var brandHits = cell.hits[selectedBrand][phrasingIdx];
    var brandPhrasingPct = Math.round((brandHits / den) * 100);

    var allHitsForBrand = cell.hits[selectedBrand][0] + cell.hits[selectedBrand][1] + cell.hits[selectedBrand][2];
    var overallPct = Math.round((allHitsForBrand / surfaceObj.comparable) * 100);

    var notewellHits = cell.hits['Notewell'][phrasingIdx];
    var notewellIncluded = (notewellHits / den) >= 0.5;

    var checkedPages = [];
    var answerText = '';

    if (intentId === 'revops') {
      if (phrasingIdx === 0) {
        checkedPages = notewellIncluded
          ? [
              { url: 'fireflies.ai/integrations/hubspot', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/docs/crm-webhooks', badge: 'Cited in answer', kind: 'cited' },
              { url: 'g2.com/categories/ai-meeting-assistants', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
              { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 no pricing table', kind: 'gap' }
            ]
          : [
              { url: 'g2.com/categories/ai-meeting-assistants', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
              { url: 'fireflies.ai/integrations/hubspot', badge: 'Cited in answer', kind: 'cited' },
              { url: 'otter.ai/sales', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 no CRM tier table', kind: 'gap' }
            ];

        answerText = notewellIncluded
          ? 'For structured MEDDIC writeback to HubSpot or Salesforce, Fireflies and Notewell are the strongest fits. Notewell maps custom qualification fields directly to deal properties with speaker-attributed quotes, while Fireflies covers the broadest set of native dialers. Otter.ai works well for standard recap logging, and Granola suits reps who want a lightweight notepad synced via Zapier.'
          : 'Based on G2 sales-assistant comparisons, Otter.ai and Fireflies are the top choices for syncing call notes to HubSpot and Salesforce. Fireflies maps call summaries and MEDDIC fields into deal stages automatically, Otter.ai Sales logs coaching recaps to account records, and Granola fits reps pushing lighter personal notes via Zapier.';
      } else if (phrasingIdx === 1) {
        checkedPages = notewellIncluded
          ? [
              { url: 'fireflies.ai/integrations/hubspot', badge: 'Cited in answer', kind: 'cited' },
              { url: 'otter.ai/sales', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/docs/crm-webhooks', badge: 'Cited in answer', kind: 'cited' },
              { url: 'g2.com/categories/ai-meeting-assistants', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' }
            ]
          : [
              { url: 'g2.com/categories/ai-meeting-assistants', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
              { url: 'fireflies.ai/integrations/hubspot', badge: 'Cited in answer', kind: 'cited' },
              { url: 'otter.ai/sales', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/docs/crm-webhooks', badge: 'Opened, skipped \u2014 developer docs only', kind: 'gap' }
            ];

        answerText = notewellIncluded
          ? 'B2B sales teams most often use Fireflies or Otter.ai for automatic post-call CRM updates, with Notewell as a strong option for custom HubSpot field mapping. Fireflies and Otter.ai lead turnkey sales adoption, while Granola is popular for reps sending lightweight summaries through Zapier.'
          : 'B2B sales teams most commonly pair Fireflies or Otter.ai with HubSpot and Salesforce for automatic post-call CRM updates. Fireflies logs call summaries, action items, and deal stages out of the box, while Otter.ai Sales syncs coaching recaps directly to CRM records; Granola comes up when reps sync personal notes via Zapier.';
      } else {
        checkedPages = notewellIncluded
          ? [
              { url: 'fireflies.ai/pricing', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/docs/crm-webhooks', badge: 'Cited in answer', kind: 'cited' },
              { url: 'granola.ai/pricing', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 no 25-seat tier table', kind: 'gap' }
            ]
          : [
              { url: 'g2.com/categories/ai-meeting-assistants', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
              { url: 'fireflies.ai/pricing', badge: 'Cited in answer', kind: 'cited' },
              { url: 'otter.ai/sales', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 no pricing table', kind: 'gap' }
            ];

        answerText = notewellIncluded
          ? 'For a 25-rep sales team avoiding enterprise contracts, Fireflies Business ($19/seat), Notewell, and Granola offer self-serve rollouts without multi-year seat minimums. Fireflies and Notewell handle direct HubSpot and Salesforce sync, Otter.ai Business ($20/seat) covers standard sales recaps, and Granola keeps per-rep pricing simple.'
          : 'For a 25-rep B2B sales team that wants CRM updates without enterprise seat minimums, Fireflies ($19/seat) and Otter.ai ($20/seat) are the two options most consistently cited in G2 comparisons. Fireflies maps call summaries into HubSpot and Salesforce automatically, Otter.ai offers a dedicated Sales workspace, and Granola stands out for simple no-contract team billing.';
      }
    } else if (intentId === 'botfree') {
      if (phrasingIdx === 0) {
        checkedPages = [
          { url: 'granola.ai', badge: 'Cited in answer', kind: 'cited' },
          { url: 'notewell.io/product/transcription', badge: 'Cited in answer', kind: 'cited' },
          { url: 'zapier.com/blog/best-ai-meeting-assistant', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
          { url: 'fireflies.ai/blog/record-zoom-without-bot', badge: 'Cited in answer', kind: 'cited' }
        ];
        answerText = 'To record Zoom and Google Meet conversations without a visible bot participant, look at Granola and Notewell first. Granola pairs a Mac menu-bar audio recorder with human bullet notes, whereas Notewell captures system audio locally while preserving multi-call search and action-item sync. Fireflies and Otter.ai remain bot-first unless configured through desktop extensions.';
      } else if (phrasingIdx === 1) {
        checkedPages = notewellIncluded
          ? [
              { url: 'granola.ai', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/product/transcription', badge: 'Cited in answer', kind: 'cited' },
              { url: 'zapier.com/blog/best-ai-meeting-assistant', badge: 'Citation gap \u2014 lists Granola, omits Notewell', kind: 'warn' },
              { url: 'otter.ai/pricing', badge: 'Opened, skipped \u2014 joins calls as bot', kind: 'gap' }
            ]
          : [
              { url: 'granola.ai', badge: 'Cited in answer', kind: 'cited' },
              { url: 'zapier.com/blog/best-ai-meeting-assistant', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
              { url: 'notewell.io/product/transcription', badge: 'Opened, skipped \u2014 Mac board workflow buried', kind: 'gap' },
              { url: 'fireflies.ai/blog/record-zoom-without-bot', badge: 'Cited in answer', kind: 'cited' }
            ];

        answerText = notewellIncluded
          ? 'For discreet client and board conversations on Mac, Granola and Notewell both record system audio directly without putting a bot in the participant list. Granola feels like an Apple Notes pad enhanced after the call, while Notewell adds shared folders and CRM follow-ups; Otter.ai and Fireflies typically join as visible meeting bots.'
          : 'If you cannot have a virtual attendee bot appear in board or client Zoom rosters on Mac, Granola is the standout choice: it captures system audio locally and enhances your rough notes after the call. Fireflies and Otter.ai rely on visible meeting bots by default, though browser-capture workarounds exist.';
      } else {
        checkedPages = notewellIncluded
          ? [
              { url: 'granola.ai', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/product/transcription', badge: 'Cited in answer', kind: 'cited' },
              { url: 'zapier.com/blog/best-ai-meeting-assistant', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
              { url: 'fireflies.ai/blog/record-zoom-without-bot', badge: 'Cited in answer', kind: 'cited' }
            ]
          : [
              { url: 'granola.ai', badge: 'Cited in answer', kind: 'cited' },
              { url: 'zapier.com/blog/best-ai-meeting-assistant', badge: 'Citation gap \u2014 lists Granola & Fireflies, omits Notewell', kind: 'warn' },
              { url: 'fireflies.ai/blog/record-zoom-without-bot', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/product/transcription', badge: 'Opened, skipped \u2014 Google Meet local capture unclear', kind: 'gap' }
            ];

        answerText = notewellIncluded
          ? 'Both Granola and Notewell capture Zoom and Google Meet audio locally from your computer rather than inviting a recording bot. Granola focuses on solo executive notes, Notewell supports searchable team workspaces, and bot-centric tools like Fireflies and Otter.ai require extension workarounds to stay invisible.'
          : 'To capture Zoom and Google Meet audio locally without an attendee bot, Granola leads current roundups thanks to native device-audio capture. Fireflies and Otter.ai offer Chrome extension capture for Google Meet, though their standard team workflows still center on an automated meeting bot.';
      }
    } else {
      if (phrasingIdx === 0) {
        checkedPages = notewellIncluded
          ? [
              { url: 'fireflies.ai/pricing', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/security', badge: 'Cited in answer', kind: 'cited' },
              { url: 'g2.com/categories/ai-meeting-assistants?tab=pricing', badge: 'Citation gap \u2014 pricing grid omits Notewell', kind: 'warn' },
              { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 SOC 2 missing from plan table', kind: 'gap' }
            ]
          : [
              { url: 'g2.com/categories/ai-meeting-assistants?tab=pricing', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
              { url: 'fireflies.ai/pricing', badge: 'Cited in answer', kind: 'cited' },
              { url: 'otter.ai/security', badge: 'Cited in answer', kind: 'cited' },
              { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 no SOC 2 pricing table', kind: 'gap' }
            ];

        answerText = notewellIncluded
          ? 'For a 40-person B2B startup needing SOC 2 Type II compliance without enterprise pricing, Fireflies Business ($19/seat), Otter.ai Business ($20/seat), and Notewell ($22/seat) are the clearest options. Notewell and Fireflies both document SOC 2 Type II attestation, while Granola suits smaller teams with lighter admin controls.'
          : 'Among SOC 2 Type II meeting assistants with published startup pricing on G2, Otter.ai Business ($20/seat) and Fireflies Business ($19/seat) are the easiest to verify upfront, while Granola documents SOC 2 compliance for teams needing lighter centralized admin governance.';
      } else if (phrasingIdx === 1) {
        checkedPages = [
          { url: 'fireflies.ai/pricing', badge: 'Cited in answer', kind: 'cited' },
          { url: 'otter.ai/security', badge: 'Cited in answer', kind: 'cited' },
          { url: 'g2.com/categories/ai-meeting-assistants?tab=pricing', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
          { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 no data-retention row', kind: 'gap' }
        ];
        answerText = 'When comparing AI meeting assistant pricing for strict zero-data-retention teams, Fireflies Business ($19/seat) and Otter.ai Business ($20/seat) publish explicit zero-training policies alongside team rates. Granola documents no-training defaults on paid plans, whereas custom auto-deletion windows usually require Enterprise quotes.';
      } else {
        checkedPages = [
          { url: 'fireflies.ai/pricing', badge: 'Cited in answer', kind: 'cited' },
          { url: 'otter.ai/security', badge: 'Cited in answer', kind: 'cited' },
          { url: 'g2.com/categories/ai-meeting-assistants?tab=pricing', badge: 'Citation gap \u2014 lists rivals, omits Notewell', kind: 'warn' },
          { url: 'notewell.io/pricing', badge: 'Opened, skipped \u2014 $22 SSO tier buried in prose', kind: 'gap' }
        ];
        answerText = 'Among AI meeting assistants under $30/seat, Fireflies Business ($19/seat) and Otter.ai Business ($20/seat) include admin retention rules, though SAML SSO typically requires stepping up to Enterprise quotes. Granola stays under $30/seat for teams but offers fewer centralized SSO and retention controls.';
      }
    }

    var mentionedInSnippet = answerText.indexOf(selectedBrand) !== -1;
    var isCaveatedInSnippet = mentionedInSnippet && (
      (intentId === 'botfree' && (selectedBrand === 'Fireflies' || selectedBrand === 'Otter.ai')) ||
      (intentId === 'soc2' && selectedBrand === 'Granola') ||
      (intentId === 'revops' && phrasingIdx < 2 && selectedBrand === 'Granola')
    );

    var statusBadgeClass = 'stance-neutral';
    var statusBadgeText = selectedBrand + ' \u00b7 Caveated mention';
    var takeawayTone = 'is-warn';

    if (!mentionedInSnippet) {
      statusBadgeClass = 'stance-absent';
      statusBadgeText = selectedBrand + ' \u00b7 Left out here';
      takeawayTone = 'is-gap';
    } else if (isCaveatedInSnippet) {
      statusBadgeClass = 'stance-neutral';
      statusBadgeText = selectedBrand + ' \u00b7 Caveated mention';
      takeawayTone = 'is-warn';
    } else if (brandPhrasingPct >= 60) {
      statusBadgeClass = 'stance-positive';
      statusBadgeText = selectedBrand + ' \u00b7 Recommended here';
      takeawayTone = 'is-pos';
    } else {
      statusBadgeClass = 'stance-neutral';
      statusBadgeText = selectedBrand +
        (brandPhrasingPct <= 25 ? ' \u00b7 Slipped here (' : ' \u00b7 Mixed here (') +
        brandHits + '/' + den + ' runs)';
      takeawayTone = 'is-warn';
    }

    var w3NotewellRatio = cell.hits['Notewell'][2] / surfaceObj.perPhrasingN[2];

    var takeawayHtml = buildTakeawayHtml(
      selectedBrand,
      intentId,
      phrasingIdx,
      surfaceObj.label,
      mentionedInSnippet,
      brandHits,
      den,
      brandPhrasingPct,
      overallPct,
      w3NotewellRatio
    );

    return {
      inspectorHeading: selectedBrand === 'Notewell'
        ? 'Exact AI Receipt & Why You Won or Lost'
        : 'Exact AI Receipt & Why ' + selectedBrand + ' Won or Lost',
      statusBadgeClass: statusBadgeClass,
      statusBadgeText: statusBadgeText,
      checkedPages: checkedPages,
      answerText: answerText,
      takeawayTone: takeawayTone,
      takeawayTitle: selectedBrand === 'Notewell'
        ? 'Plain-English Takeaway \u00b7 Your Product (Notewell)'
        : 'Plain-English Takeaway \u00b7 Competitor (' + selectedBrand + ')',
      takeawayHtml: takeawayHtml
    };
  }

  function buildTakeawayHtml(brand, intentId, phrasingIdx, surfaceLabel, mentioned, hits, den, pPct, overallPct, w3NotewellRatio) {
    var runStat = hits + '/' + den + ' runs, ' + pPct + '%';
    var overallAndHere = overallPct + '% overall \u00b7 ' + runStat + ' here';

    if (brand === 'Notewell') {
      if (!mentioned) {
        if (intentId === 'soc2' && phrasingIdx === 2) {
          return (
            '<strong>Why Notewell vanished here (' + esc(runStat) + '):</strong> Notewell actually includes SAML SSO + custom retention at $22/seat, ' +
            'but AI opened <code class="mono">notewell.io/pricing</code> and G2, found no parseable pricing table, and recommended Fireflies &amp; Otter.ai instead. ' +
            '<strong>Click the blue button below</strong> to see how fixing <code class="mono">/pricing</code> turned this into +86% demo leads.'
          );
        }
        if (intentId === 'soc2') {
          return (
            '<strong>Why Notewell vanished here (' + esc(runStat) + '):</strong> AI opened <code class="mono">notewell.io/pricing</code> and G2, ' +
            'found no parseable SOC 2 or data-retention row on your pricing page, and recommended Fireflies &amp; Otter.ai instead.'
          );
        }
        if (intentId === 'revops') {
          return (
            '<strong>Why Notewell vanished here (' + esc(runStat) + '):</strong> Without niche technical keywords like &ldquo;MEDDIC&rdquo;, ' +
            esc(surfaceLabel) + ' leaned on G2 and <code class="mono">notewell.io/pricing</code>&mdash;finding no 25-seat CRM comparison table on your site and omitting you.'
          );
        }
        return (
          '<strong>Why Notewell vanished here (' + esc(runStat) + '):</strong> Zapier&rsquo;s top roundup omits Notewell, and <code class="mono">notewell.io/product/transcription</code> ' +
          'buried Mac &amp; Google Meet local capture details below the fold, leaving Granola to win solo.'
        );
      }

      if (intentId === 'revops') {
        if (phrasingIdx === 0) {
          var w3Hint = w3NotewellRatio < 0.5
            ? 'try clicking <strong>Wording 3</strong> above to see Notewell vanish.'
            : 'try clicking <strong>Wording 3</strong> above to see Notewell drop to 50% when buyers ask about 25-seat pricing.';
          return (
            '<strong>Why Notewell won a spot here (' + esc(runStat) + '):</strong> Because the buyer explicitly asked for MEDDIC field sync, AI pulled your webhook docs (<code class="mono">notewell.io/docs/crm-webhooks</code>). ' +
            '<strong>Hidden risk:</strong> AI still skipped <code class="mono">notewell.io/pricing</code> and G2 omits you&mdash;' + w3Hint
          );
        }
        if (phrasingIdx === 1) {
          return (
            '<strong>Why Notewell held on as a runner-up (' + esc(runStat) + '):</strong> ' + esc(surfaceLabel) + ' still cited <code class="mono">notewell.io/docs/crm-webhooks</code> for HubSpot mapping, ' +
            'but G2&rsquo;s comparison grid pushed Fireflies &amp; Otter.ai ahead of you on broad CRM prompts.'
          );
        }
        return (
          '<strong>Why Notewell slipped to half of runs on Wording 3 (' + esc(runStat) + '):</strong> ' + esc(surfaceLabel) + ' found your webhook docs to confirm self-serve CRM setup, ' +
          'but skipped <code class="mono">notewell.io/pricing</code> in half the checks because your 25-seat tier lacked a parseable HTML table.'
        );
      }

      if (intentId === 'botfree') {
        if (pPct < 60) {
          return (
            '<strong>Why Notewell slipped to half of runs here (' + esc(runStat) + '):</strong> <code class="mono">notewell.io/product/transcription</code> covers local audio capture, ' +
            'but Zapier&rsquo;s top roundup omits Notewell&mdash;costing you half of runs when buyers ask broadly about Zoom &amp; Google Meet.'
          );
        }
        return (
          '<strong>Why Notewell co-led here (' + esc(runStat) + '):</strong> <code class="mono">notewell.io/product/transcription</code> clearly explains local system-audio recording without a visible Zoom bot. ' +
          '<strong>Next fix:</strong> Get added to Zapier&rsquo;s meeting-assistant roundup so you stop losing runs when buyers reword the question.'
        );
      }

      return (
        '<strong>Why Notewell made this shortlist (' + esc(runStat) + '):</strong> AI found SOC 2 Type II on <code class="mono">notewell.io/security</code>, ' +
        'but still skipped <code class="mono">notewell.io/pricing</code>&mdash;click <strong>Wording 2</strong> or <strong>Wording 3</strong> above to see how fast you disappear on retention &amp; SSO pricing questions.'
      );
    }

    if (brand === 'Fireflies') {
      if (intentId === 'botfree') {
        return (
          '<strong>Why Fireflies only got a caveated mention (' + esc(overallAndHere) + '):</strong> ' +
          'Its SEO blog post (<code class="mono">fireflies.ai/blog/record-zoom-without-bot</code>) ranked in web search, so AI mentioned it&mdash;but warned buyers that Fireflies joins calls as a visible bot by default.'
        );
      }
      if (intentId === 'soc2') {
        if (pPct < 60) {
          return (
            '<strong>Why Fireflies slipped on Wording 3 (' + esc(overallAndHere) + '):</strong> ' +
            '<code class="mono">fireflies.ai/pricing</code> is easy for AI to parse at $19/seat, but gating SAML SSO behind custom Enterprise quotes caused ' + esc(surfaceLabel) + ' to hedge or drop it in half of strict sub-$30 SSO runs.'
          );
        }
        return (
          '<strong>Why Fireflies won (' + esc(overallAndHere) + '):</strong> ' +
          '<code class="mono">fireflies.ai/pricing</code> publishes a clean $19/seat HTML comparison table with SOC 2 &amp; retention rows that AI can verify directly, backed by top G2 placement.'
        );
      }
      if (pPct < 60) {
        return (
          '<strong>Why Fireflies slipped on Wording 3 (' + esc(overallAndHere) + '):</strong> ' +
          'Fireflies leads overall via HubSpot docs and G2, but when buyers explicitly ask to avoid &ldquo;per-seat enterprise bloat&rdquo;, lightweight flat-billing rivals like Granola take share.'
        );
      }
      return (
        '<strong>Why Fireflies won (' + esc(overallAndHere) + '):</strong> ' +
        'Dedicated <code class="mono">fireflies.ai/integrations/hubspot</code> page + clear $19/seat Business pricing table + listed at the top of G2&rsquo;s category matrix.'
      );
    }

    if (brand === 'Otter.ai') {
      if (intentId === 'botfree') {
        return (
          '<strong>Why Otter.ai only got a caveated mention (' + esc(overallAndHere) + '):</strong> ' +
          'Buyers specifically asked to avoid a visible Zoom bot; AI only mentions Otter.ai to warn that its standard workflow relies on an automated participant bot.'
        );
      }
      if (intentId === 'soc2') {
        if (pPct < 60) {
          return (
            '<strong>Why Otter.ai slipped on this wording (' + esc(overallAndHere) + '):</strong> ' +
            'Otter.ai ranks well on general SOC 2 searches via G2, but SAML SSO and stricter retention require Enterprise quotes above its $20/seat tier&mdash;dropping it from most strict SSO/retention runs.'
          );
        }
        return (
          '<strong>Why Otter.ai ranked high (' + esc(overallAndHere) + '):</strong> ' +
          'Pairs transparent $20/seat Business pricing with a dedicated <code class="mono">otter.ai/security</code> SOC 2 page and top G2 pricing-grid visibility.'
        );
      }
      if (pPct < 60) {
        return (
          '<strong>Why Otter.ai slipped on this wording (' + esc(overallAndHere) + '):</strong> ' +
          'Strong G2 presence keeps Otter.ai visible on broad recaps, but thinner technical webhook docs and per-seat Sales pricing cost it runs on technical or anti-bloat prompts.'
        );
      }
      return (
        '<strong>Why Otter.ai stayed visible (' + esc(overallAndHere) + '):</strong> ' +
        'Strong G2 category authority plus a dedicated <code class="mono">otter.ai/sales</code> page kept Otter.ai in the top two whenever buyers asked broad CRM questions.'
      );
    }

    /* Granola */
    if (intentId === 'botfree') {
      return (
        '<strong>Why Granola dominated (' + esc(overallAndHere) + '):</strong> ' +
        'Owns the &ldquo;no meeting bot&rdquo; positioning clearly on <code class="mono">granola.ai</code> AND holds the #1 spot in third-party roundups like Zapier.'
      );
    }
    if (intentId === 'soc2') {
      return (
        '<strong>Why Granola got a caveated mention (' + esc(overallAndHere) + '):</strong> ' +
        'Publishes sub-$30 team pricing and SOC 2 compliance, so AI includes it&mdash;while noting lighter centralized SSO and retention controls for 40-seat teams.'
      );
    }
    if (phrasingIdx === 2) {
      if (pPct >= 60) {
        return (
          '<strong>Why Granola surged on Wording 3 (' + esc(overallAndHere) + '):</strong> ' +
          'Buyers asked specifically to avoid &ldquo;per-seat enterprise bloat&rdquo;, where Granola&rsquo;s simple no-contract team pricing shines&mdash;even without native CRM field sync.'
        );
      }
      return (
        '<strong>Why Granola gained partial traction on Wording 3 (' + esc(overallAndHere) + '):</strong> ' +
        'Simple no-contract team billing matched the &ldquo;no seat bloat&rdquo; wording in nearly half of runs, though lacking native HubSpot/Salesforce sync capped its upside.'
      );
    }
    return (
      '<strong>Why Granola got a caveated mention (' + esc(overallAndHere) + '):</strong> ' +
      'Positioned as a lightweight notepad synced via Zapier rather than native HubSpot/Salesforce field mapping&mdash;try clicking <strong>Wording 3</strong> to see where its simple pricing gains ground.'
    );
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
    viewMode: 'hearsay',     // 'hearsay' | 'tracker'
    subTab: 'benchmark',     // 'benchmark' | 'outcomes'
    surface: 'openai',
    intent: 'revops',
    phrasingIdx: 0,
    brand: 'Notewell',
    outcomeReceipt: 'after'  // 'before' | 'after'
  };

  /* 1. Theme Toggle */
  function initTheme() {
    var toggle = document.getElementById('theme-toggle');
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (!toggle) return;
    var labelSpan = toggle.querySelector('span');

    function syncThemeUi() {
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      toggle.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      toggle.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
      if (labelSpan) {
        labelSpan.textContent = isLight ? 'Dark' : 'Light';
      }
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
        /* localStorage may be unavailable in restricted contexts */
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
          btn.textContent = 'Copied!';
          if (liveRegion) liveRegion.textContent = 'Copied to clipboard.';
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

  /* 3. Sandbox & "$399/mo Fake Score" Comparison Rendering */
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

    var surfaceObj = SURFACES.find(function (s) { return s.id === state.surface; }) || SURFACES[0];
    var intentObj = INTENTS.find(function (i) { return i.id === state.intent; }) || INTENTS[0];
    var cell = COUNTS[surfaceObj.id][intentObj.id];

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

    /* Update AI assistant pills */
    var surfacePills = Array.prototype.slice.call(document.querySelectorAll('[data-surface]'));
    surfacePills.forEach(function (pill) {
      var active = pill.getAttribute('data-surface') === surfaceObj.id;
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    /* Update buyer topic pills */
    var intentPills = Array.prototype.slice.call(document.querySelectorAll('[data-intent]'));
    intentPills.forEach(function (pill) {
      var active = pill.getAttribute('data-intent') === intentObj.id;
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    /* Compute brand metrics with exact Wilson 95% intervals */
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
      coverageEl.innerHTML =
        '<span class="legend-dot" aria-hidden="true"></span>Dot = observed rate · ' +
        '<span class="legend-bar" aria-hidden="true"></span>Bar = 95% likely range ' +
        esc(surfaceObj.legendSuffix);
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
            '<span class="brand-row-top">' +
              '<span class="brand-ident">' +
                '<span class="brand-name">' + esc(row.brand.name) + '</span>' +
                (row.brand.isSelf ? '<span class="self-tag">Your Product</span>' : '') +
                '<span class="brand-domain">' + esc(row.brand.domain) + '</span>' +
              '</span>' +
              '<span class="brand-meta-right">' +
                '<span class="share-pill">' + pct(sov) + ' share</span>' +
                '<span class="inspect-cue' + (selected ? ' is-active' : '') + '">' + (selected ? 'Inspecting &rarr;' : 'Inspect &rarr;') + '</span>' +
              '</span>' +
            '</span>' +
            '<span class="ci-cell">' +
              '<span class="ci-track" aria-hidden="true">' +
                '<span class="ci-band" style="left:' + loPct + '%;width:' + bandWidth + '%"></span>' +
                '<span class="ci-point" style="left:' + pPct + '%"></span>' +
              '</span>' +
              '<span class="ci-stat-row">' +
                '<span class="ci-main"><strong>' + pPct + '%</strong> (' + row.mentioned + ' of ' + surfaceObj.comparable + ' answers)</span>' +
                '<span class="ci-range">Likely ' + loPct + '%–' + hiPct + '%</span>' +
              '</span>' +
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
            inspectorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
      });
    }

    /* Dynamic plain-English wording swing callout per selected brand */
    var varianceEl = document.getElementById('variance-callout-box');
    var selectedArr = cell.hits[state.brand];
    var phrasingPercents = selectedArr.map(function (hits, idx) {
      return Math.round((hits / surfaceObj.perPhrasingN[idx]) * 100);
    });
    var maxPhrasingPct = Math.max.apply(null, phrasingPercents);
    var minPhrasingPct = Math.min.apply(null, phrasingPercents);

    if (varianceEl) {
      var spreads = computeIntentSpreads(selectedArr, surfaceObj.perPhrasingN);
      if (maxPhrasingPct > minPhrasingPct) {
        varianceEl.innerHTML =
          '<strong>Wording matters:</strong> Rewording this same buyer question swings <strong>' + esc(state.brand) + '</strong> from ' +
          '<strong>' + maxPhrasingPct + '% down to ' + minPhrasingPct + '%</strong> ' +
          '(&plusmn;' + spreads.phrasingSpreadPts + ' pts from wording alone)&mdash;click the 3 wordings on the right to see why.';
      } else {
        varianceEl.innerHTML =
          '<strong>Steady across wordings:</strong> <strong>' + esc(state.brand) + '</strong> holds steady at ' +
          '<strong>' + maxPhrasingPct + '%</strong> across all 3 buyer wordings ' +
          '(&plusmn;0 pts wording swing)&mdash;click the 3 wordings on the right to compare.';
      }
    }

    /* Render Right Card: Exact AI Receipt & Why You Won or Lost */
    var receipt = getReceipt(surfaceObj, intentObj, state.phrasingIdx, state.brand);
    var headingEl = document.getElementById('inspector-heading');
    var statusBadgeEl = document.getElementById('inspector-status-badge');
    var phrasingTabsEl = document.getElementById('inspector-phrasing-tabs');
    var promptTextEl = document.getElementById('inspector-prompt-text');
    var queryTextEl = document.getElementById('inspector-query-text');
    var pagesListEl = document.getElementById('inspector-pages-list');
    var answerEl = document.getElementById('inspector-answer-text');
    var takeawayStepEl = document.getElementById('inspector-takeaway-step');
    var takeawayTitleEl = document.getElementById('inspector-takeaway-title');
    var takeawayTextEl = document.getElementById('inspector-takeaway-text');

    if (headingEl) {
      headingEl.textContent = receipt.inspectorHeading;
    }
    if (statusBadgeEl) {
      statusBadgeEl.className = 'stance-badge ' + receipt.statusBadgeClass;
      statusBadgeEl.textContent = receipt.statusBadgeText;
    }

    if (phrasingTabsEl) {
      phrasingTabsEl.innerHTML = intentObj.phrasings.map(function (_txt, idx) {
        var hits = selectedArr[idx];
        var den = surfaceObj.perPhrasingN[idx];
        var thisPct = Math.round((hits / den) * 100);
        var active = idx === state.phrasingIdx;
        var isDropped = (maxPhrasingPct - thisPct >= 30) && thisPct <= 25;
        var statLabel = hits + '/' + den + ' runs (' + thisPct + '%' + (isDropped ? ' \u2014 Dropped!' : '') + ')';

        return (
          '<button type="button" class="phrasing-btn tabular" data-phrasing-idx="' + idx + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
            '<span class="phrasing-kicker">Wording ' + (idx + 1) + '</span>' +
            '<span class="phrasing-preview">' + esc(intentObj.previews[idx]) + '</span>' +
            '<span class="phrasing-stat' + (isDropped ? ' is-dropped' : '') + '">' + esc(statLabel) + '</span>' +
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
      promptTextEl.textContent = '\u201c' + intentObj.phrasings[state.phrasingIdx] + '\u201d';
    }

    if (queryTextEl) {
      queryTextEl.textContent = intentObj.queries[surfaceObj.id][state.phrasingIdx];
    }

    if (pagesListEl) {
      pagesListEl.innerHTML = receipt.checkedPages.map(function (item) {
        var tagCls = item.kind === 'cited'
          ? 'tag-cited'
          : (item.kind === 'warn' ? 'tag-warn' : 'tag-gap');
        return (
          '<li class="checked-page-item">' +
            '<span class="checked-page-url">' + esc(item.url) + '</span>' +
            '<span class="url-tag ' + tagCls + '">' + esc(item.badge) + '</span>' +
          '</li>'
        );
      }).join('');
    }

    if (answerEl) {
      answerEl.innerHTML = highlightBrands(receipt.answerText, state.brand);
    }

    if (takeawayStepEl) {
      takeawayStepEl.className = 'flow-step takeaway-step ' + receipt.takeawayTone;
    }
    if (takeawayTitleEl) {
      takeawayTitleEl.textContent = receipt.takeawayTitle;
    }
    if (takeawayTextEl) {
      takeawayTextEl.innerHTML = receipt.takeawayHtml;
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
        '<div class="outcome-rcpt-head">' +
          '<span class="outcome-rcpt-date">Sep 28 · After fixing /pricing</span>' +
          '<span class="stance-badge stance-positive">Cited notewell.io/pricing directly</span>' +
        '</div>' +
        '<p class="answer-snippet">' +
          highlightBrands(
            'For a 40-person B2B team needing SOC 2 Type II, zero-data-retention controls, and SAML SSO under $30/seat, Notewell ($22/seat all-in per notewell.io/pricing) and Fireflies Business ($19/seat, SSO on Enterprise) are the clearest published options.',
            'Notewell'
          ) +
        '</p>';
    } else {
      box.innerHTML =
        '<div class="outcome-rcpt-head">' +
          '<span class="outcome-rcpt-date">Sep 10 · Before fixing /pricing</span>' +
          '<span class="stance-badge stance-absent">Opened notewell.io/pricing — skipped (no table)</span>' +
        '</div>' +
        '<p class="answer-snippet">' +
          highlightBrands(
            'Among SOC 2 Type II meeting assistants under $30/seat, Fireflies Business ($19/seat) and Otter.ai Business ($20/seat) publish explicit tier tables on their pricing and G2 pages; SAML SSO typically requires an Enterprise quote.',
            'Notewell'
          ) +
        '</p>';
    }
  }

  function scrollSandboxIntoViewIfNeeded() {
    var shell = document.getElementById('sandbox-shell');
    if (!shell || !shell.getBoundingClientRect) return;
    var rect = shell.getBoundingClientRect();
    if (rect.top < 70 || rect.top > window.innerHeight * 0.65) {
      shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        scrollSandboxIntoViewIfNeeded();
      });
    }

    var subBenchmarkBtn = document.getElementById('subtab-benchmark');
    var subOutcomesBtn = document.getElementById('subtab-outcomes');
    var bridgeOutcomesBtn = document.getElementById('bridge-to-outcomes');
    var backToStep1Btn = document.getElementById('back-to-step1');

    if (subBenchmarkBtn) {
      subBenchmarkBtn.addEventListener('click', function () {
        state.viewMode = 'hearsay';
        state.subTab = 'benchmark';
        renderSandbox();
      });
    }
    if (subOutcomesBtn) {
      subOutcomesBtn.addEventListener('click', function () {
        state.viewMode = 'hearsay';
        state.subTab = 'outcomes';
        renderSandbox();
      });
    }
    if (bridgeOutcomesBtn) {
      bridgeOutcomesBtn.addEventListener('click', function () {
        state.viewMode = 'hearsay';
        state.subTab = 'outcomes';
        renderSandbox();
        scrollSandboxIntoViewIfNeeded();
      });
    }
    if (backToStep1Btn) {
      backToStep1Btn.addEventListener('click', function () {
        state.viewMode = 'hearsay';
        state.subTab = 'benchmark';
        renderSandbox();
        scrollSandboxIntoViewIfNeeded();
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
