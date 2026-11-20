import type {ThemeName} from './design';

// ============================================================================
// Beat-Locked 122 BPM Master Clock (1920x1080 @ 30fps)
// ============================================================================

export const FPS = 30;
export const BPM = 122;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Frames to premount each Sequence ahead of its cut point (Remotion best practice). */
export const PREMOUNT_FRAMES = FPS; // 30 frames = 1.0s

/** Convert musical beat index (at 122 BPM) to exact 30fps frame index. */
export const beatFrame = (beat: number): number =>
  Math.round((beat * FPS * 60) / BPM);

export type SceneId =
  | 'hook'
  | 'xray'
  | 'noScore'
  | 'hijack'
  | 'delta'
  | 'workbench'
  | 'outro';

export interface SceneTiming {
  readonly id: SceneId;
  readonly index: number;
  readonly act: 1 | 2;
  readonly label: string;
  readonly theme: ThemeName;
  readonly beatStart: number;
  readonly beats: number;
  readonly from: number;
  readonly duration: number;
}

const defineScene = (
  id: SceneId,
  index: number,
  act: 1 | 2,
  label: string,
  theme: ThemeName,
  beatStart: number,
  beats: number,
): SceneTiming => {
  const from = beatFrame(beatStart);
  const to = beatFrame(beatStart + beats);
  return {
    id,
    index,
    act,
    label,
    theme,
    beatStart,
    beats,
    from,
    duration: to - from,
  };
};

// 100 beats @ 122 BPM = 1475 frames = 49.17 seconds (clean 2-bar / 4-bar phrasing)
export const TIMELINE: Record<SceneId, SceneTiming> = {
  // Act 1 — The Hidden Problem & 10-Second X-Ray (44 beats = 649f = 21.63s)
  hook: defineScene('hook', 1, 1, 'The conversation you never see', 'light', 0, 14),
  xray: defineScene('xray', 2, 1, '10-second crawlability X-ray', 'dark', 14, 16),
  noScore: defineScene('noScore', 3, 1, 'Receipts, not a fake score', 'mist', 30, 14),

  // Act 2 — Deterministic Forensics, Local Workbench & Lockup (56 beats = 826f = 27.53s)
  hijack: defineScene('hijack', 4, 2, 'Attrition & own-site hijacks', 'light', 44, 14),
  delta: defineScene('delta', 5, 2, 'Memory vs. search & persistence', 'dark', 58, 14),
  workbench: defineScene('workbench', 6, 2, 'Local SQLite workbench & MCP', 'mist', 72, 14),
  outro: defineScene('outro', 7, 2, 'Hearsay', 'dark', 86, 14),
};

export const SCENE_LIST: readonly SceneTiming[] = [
  TIMELINE.hook,
  TIMELINE.xray,
  TIMELINE.noScore,
  TIMELINE.hijack,
  TIMELINE.delta,
  TIMELINE.workbench,
  TIMELINE.outro,
];

export const TOTAL_BEATS = 100;
export const TOTAL = beatFrame(TOTAL_BEATS); // 1475 frames
export const DURATION_SECONDS = Number((TOTAL / FPS).toFixed(2)); // 49.17s

// ============================================================================
// Editorial Copy Contracts (Synchronized with README.md & docs/index.html)
// ============================================================================

export const SCENE_COPY = {
  hook: {
    eyebrow: '01 · THE CONVERSATION YOU NEVER SEE',
    lines: ['Every day, buyers ask AI', 'what to buy.'] as const,
    subline: 'Your product checks every box. Why did AI leave you out?',
    prompt: 'Which SOC 2 meeting recorder should our 40-person team buy?',
    competitors: [
      {
        name: 'Fireflies.ai',
        detail: 'Business ($19/seat) · SOC 2 Type II, CRM sync.',
      },
      {
        name: 'Otter.ai',
        detail: 'Business ($20/seat) · SOC 2 Type II, team spaces.',
      },
    ] as const,
    omittedChip: 'Notewell (your site) — left out',
    sourceChip: 'g2.com/categories/ai-meeting-assistants',
  },
  xray: {
    eyebrow: '02 · 10-SECOND CRAWLABILITY X-RAY · ZERO API KEYS',
    lines: ['See what zero-JS', 'AI crawlers actually see.'] as const,
    command: 'npx @melonwer/hearsay check https://yoursite.com --browser --vs competitor.com',
    stack: 'Vite SPA · CDN: Cloudflare · WAF: bot_management_active',
    crawlers: '18/18 allowed (OAI-SearchBot, Claude-SearchBot, PerplexityBot…)',
    rawWords: 0,
    renderedWords: 1167,
    proseParity: 0,
    missingHeadings: 16,
    competitorParity: 94,
    verdict: 'FAIL [BLOCKED_HARD_GATE] — Vite SSR recipe included',
  },
  noScore: {
    eyebrow: '03 · NO BLACK-BOX SCORES',
    lines: ['Stop trusting a fake', '0–100 AI score.'] as const,
    fakeScore: '74 / 100',
    fakeLabel: 'AI Visibility Score · $399/mo',
    receiptMetaLeft: 'n = 45 prompts · 3 models',
    receiptMetaRight: 'Wilson 95% CI',
    metrics: [
      {label: 'Mention rate', value: 18, ciLow: 9, ciHigh: 31, tone: 'cobalt' as const},
      {label: 'Citation rate', value: 6, ciLow: 2, ciHigh: 18, tone: 'amber' as const},
      {label: 'Positive recommendation', value: 4, ciLow: 1, ciHigh: 15, tone: 'signal' as const},
    ] as const,
    footerRight: 'Exact rates · n shown',
  },
  hijack: {
    eyebrow: '04 · RETRIEVAL FORENSICS',
    lines: ['Retrieved, dropped,', 'or hijacked.'] as const,
    subline: 'AI drops ~85% of retrieved pages—and often cites your docs to recommend a rival.',
    funnel: [
      {label: 'Retrieved URLs', pct: 100, count: '20 pages read'},
      {label: 'Dropped before answer', pct: 85, count: '17 discarded'},
      {label: 'Final citations', pct: 15, count: '3 kept'},
    ] as const,
    hijackUrl: 'notewell.io/docs/security',
    hijackRecommended: 'Fireflies.ai',
    hijackNote: 'Cited your SOC 2 spec page while naming Fireflies.ai as the #1 recommendation.',
    stamp: 'OWN-SITE HIJACK',
  },
  delta: {
    eyebrow: '05 · MEMORY VS. SEARCH & PERSISTENCE',
    lines: ['Separate model weights', 'from live web churn.'] as const,
    memoryTitle: 'Paired search=off vs. search=on',
    memoryModel: 'Same model · claude-sonnet',
    memoryOff: 42,
    memoryOn: 11,
    memoryDelta: '−31pp displaced by live search',
    persistenceTitle: 'Multi-wave citation persistence',
    persistenceSub: '4 weekly waves · single-wave claims refused',
    domains: [
      {domain: 'g2.com/categories/…', waves: '4 / 4 waves', status: 'DURABLE', tone: 'emerald' as const},
      {domain: 'reddit.com/r/saas', waves: '3 / 4 waves', status: 'RECURRING', tone: 'cobalt' as const},
      {domain: 'top10-ai-notes.io', waves: '1 / 4 waves', status: 'EPHEMERAL', tone: 'neutral' as const},
    ] as const,
  },
  workbench: {
    eyebrow: '06 · LOCAL WORKBENCH & MCP',
    lines: ['Runs locally.', 'Speaks MCP.'] as const,
    windowTitle: 'localhost:3847/check — Hearsay Workbench',
    routes: [
      'BYOK Direct APIs',
      'DataForSEO · Google AIO + ChatGPT Web',
      '$0 CLIs · Codex · Claude Code · Antigravity',
    ] as const,
    chips: [
      'Local SQLite (node:sqlite)',
      '46 MCP tools',
      'Hard cap: HEARSAY_MONTHLY_USD_CAP',
    ] as const,
  },
  outro: {
    wordmark: 'Hearsay',
    tagline: 'Receipts, not a fake 0–100 score.',
    command: 'npx @melonwer/hearsay check https://yoursite.com',
    footer: 'MIT · Local SQLite · 46 MCP tools · Zero telemetry',
  },
} as const;

// ============================================================================
// Music Bed & Beat-Locked SFX Cues
// ============================================================================

/**
 * audio/music.mp3 is 111.46s (3,343f @ 30fps).
 * trimBefore=252 (8.40s) leaves 103.06s (3,091f) — easily covers 100% of TOTAL (1,475f / 49.17s).
 */
export const MUSIC = {
  from: 0,
  duration: TOTAL,
  src: 'audio/music.mp3',
  trimBefore: 252,
  volume: 0.4,
  fadeInFrames: 18,
  fadeOutFrames: 48,
} as const;

export interface SfxCue {
  readonly from: number;
  readonly duration: number;
  readonly src: string;
  readonly volume: number;
  readonly action: string;
}

export const SFX: readonly SfxCue[] = [
  // Scene 1: hook
  {
    from: TIMELINE.hook.from + 24,
    duration: 45,
    src: 'audio/whoosh.mp3',
    volume: 0.38,
    action: 'Buyer chat card enters',
  },
  {
    from: TIMELINE.hook.from + 122,
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.46,
    action: 'Omitted badge lands',
  },

  // Scene 2: xray
  {
    from: TIMELINE.xray.from + 4,
    duration: 45,
    src: 'audio/whoosh.mp3',
    volume: 0.42,
    action: 'Cut to dark X-ray terminal',
  },
  {
    from: TIMELINE.xray.from + 96,
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.46,
    action: 'Bot-vs-Human diff reveals',
  },
  {
    from: TIMELINE.xray.from + 168,
    duration: 38,
    src: 'audio/marker.mp3',
    volume: 0.5,
    action: 'BLOCKED_HARD_GATE verdict',
  },

  // Scene 3: noScore
  {
    from: TIMELINE.noScore.from + 44,
    duration: 38,
    src: 'audio/marker.mp3',
    volume: 0.56,
    action: 'Crimson slash across 74/100',
  },
  {
    from: TIMELINE.noScore.from + 70,
    duration: 15,
    src: 'audio/paper.mp3',
    volume: 0.54,
    action: 'Thermal receipt prints',
  },

  // Scene 4: hijack
  {
    from: TIMELINE.hijack.from + 20,
    duration: 15,
    src: 'audio/paper.mp3',
    volume: 0.5,
    action: 'Hijack receipt enters',
  },
  {
    from: TIMELINE.hijack.from + 114,
    duration: 38,
    src: 'audio/marker.mp3',
    volume: 0.54,
    action: 'OWN-SITE HIJACK stamp',
  },

  // Scene 5: delta
  {
    from: TIMELINE.delta.from + 6,
    duration: 45,
    src: 'audio/whoosh.mp3',
    volume: 0.38,
    action: 'Dark diagnostics cut',
  },
  {
    from: TIMELINE.delta.from + 104,
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.46,
    action: 'Durable domain ranks in',
  },

  // Scene 6: workbench
  {
    from: TIMELINE.workbench.from + 14,
    duration: 15,
    src: 'audio/paper.mp3',
    volume: 0.46,
    action: 'macOS workbench frame settles',
  },
  {
    from: TIMELINE.workbench.from + 116,
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.42,
    action: 'Provider & USD cap strip locks',
  },

  // Scene 7: outro
  {
    from: TIMELINE.outro.from + 10,
    duration: 90,
    src: 'audio/impact.mp3',
    volume: 0.46,
    action: 'Hearsay wordmark lands',
  },
  {
    from: TIMELINE.outro.from + 58,
    duration: 75,
    src: 'audio/shimmer.mp3',
    volume: 0.28,
    action: 'Tagline & npx command pill resolve',
  },
];
