import type {ThemeName} from './design';

// ============================================================================
// Beat-Locked 122 BPM Master Clock — Launch Film v3 (1920x1080 @ 30fps)
// Effortless 6-scene "Before → Fix → After" story (82 beats = 1,210f = 40.33s)
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
  | 'invisible'
  | 'command'
  | 'receipt'
  | 'fix'
  | 'payoff'
  | 'outro';

export type StoryPhase = 'before' | 'fix' | 'after' | 'outro';

export interface SceneTiming {
  readonly id: SceneId;
  readonly index: number;
  readonly act: 1 | 2;
  readonly phase: StoryPhase;
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
  phase: StoryPhase,
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
    phase,
    label,
    theme,
    beatStart,
    beats,
    from,
    duration: to - from,
  };
};

// 82 beats @ 122 BPM = 1,210 frames = 40.33 seconds (every cut on an even beat)
export const TIMELINE: Record<SceneId, SceneTiming> = {
  // Act 1 — Before: Invisible → One Command → The Receipt (42 beats = 620f = 20.67s)
  invisible: defineScene(
    'invisible',
    1,
    1,
    'before',
    'Someone just asked AI what to buy',
    'light',
    0,
    14,
  ),
  command: defineScene(
    'command',
    2,
    1,
    'before',
    'Run one command. No API keys.',
    'dark',
    14,
    14,
  ),
  receipt: defineScene(
    'receipt',
    3,
    1,
    'before',
    'No fake 74/100 score. Just the receipt.',
    'dark',
    28,
    14,
  ),

  // Act 2 — Fix & After: Plain HTML Fix → Payoff → Keynote Lockup (40 beats = 590f = 19.67s)
  fix: defineScene(
    'fix',
    4,
    2,
    'fix',
    "Fix the one thing AI couldn't read",
    'mist',
    42,
    14,
  ),
  payoff: defineScene(
    'payoff',
    5,
    2,
    'after',
    'Ask AI again. Watch the answer change.',
    'light',
    56,
    14,
  ),
  outro: defineScene(
    'outro',
    6,
    2,
    'outro',
    'Hearsay',
    'dark',
    70,
    12,
  ),
};

export const SCENE_LIST: readonly SceneTiming[] = [
  TIMELINE.invisible,
  TIMELINE.command,
  TIMELINE.receipt,
  TIMELINE.fix,
  TIMELINE.payoff,
  TIMELINE.outro,
];

export const TOTAL_BEATS = 82;
export const TOTAL = beatFrame(TOTAL_BEATS); // 1,210 frames
export const DURATION_SECONDS = Number((TOTAL / FPS).toFixed(2)); // 40.33s

/** Iconic settled poster frame: Scene 3 thermal receipt with SKIPPED stamp & struck 74/100. */
export const POSTER_FRAME = TIMELINE.receipt.from + 152; // frame 565

// ============================================================================
// Plain-English Editorial Copy Contracts (Zero Jargon · 1 Idea Per Screen)
// ============================================================================

export const SCENE_COPY = {
  invisible: {
    lines: ['Someone just asked AI', 'what to buy.'] as const,
    assistant: 'ChatGPT',
    prompt: 'Which SOC 2 meeting recorder should our team buy?',
    recommendations: [
      {
        name: 'Fireflies.ai',
        detail: 'SOC 2 Type II · $19/seat',
      },
      {
        name: 'Otter.ai',
        detail: 'SOC 2 Type II · $20/seat',
      },
    ] as const,
    omittedLine: "Notewell isn't even mentioned.",
  },
  command: {
    lines: ['Run one command.', 'No API keys.'] as const,
    command: 'npx @melonwer/hearsay check notewell.io',
    humanLabel: 'What humans see',
    humanWords: 1167,
    aiLabel: 'What AI sees',
    aiWords: 0,
    unit: 'words',
    punchline: 'Your page was invisible to AI.',
  },
  receipt: {
    headlinePrefix: 'No fake ',
    fakeScore: '74/100',
    headlineSuffix: ' score.',
    headlineSecond: 'Just the receipt.',
    headerBrand: 'Hearsay',
    headerSub: 'Answer receipt',
    metaLeft: 'ChatGPT',
    metaRight: 'notewell.io',
    steps: [
      {
        index: '1',
        label: 'Searched',
        value: '"soc 2 meeting recorder pricing"',
      },
      {
        index: '2',
        label: 'Skipped',
        value: 'notewell.io/pricing',
        note: 'No readable HTML',
        stamp: 'SKIPPED',
      },
      {
        index: '3',
        label: 'Cited instead',
        value: 'g2.com',
      },
    ] as const,
    footerLeft: 'Result',
    footerRight: 'Notewell left out',
    footerSub: 'Saved locally in SQLite',
  },
  fix: {
    lines: ['Fix the one thing', "AI couldn't read."] as const,
    url: 'notewell.io/pricing',
    beforeCode: '<div id="root"></div>',
    beforeLabel: 'Before · Empty JavaScript shell',
    afterLabel: 'After · Plain HTML pricing table',
    tableTitle: 'Team Plan',
    rows: [
      {label: 'Seat price', value: '$22/seat'},
      {label: 'Compliance', value: 'SOC 2 Type II'},
      {label: 'Enterprise auth', value: 'SAML SSO'},
    ] as const,
    shippedPill: 'Shipped on Monday',
  },
  payoff: {
    lines: ['Ask AI again.', 'Watch the answer change.'] as const,
    assistant: 'ChatGPT',
    prompt: 'Which SOC 2 meeting recorder should our team buy?',
    winner: {
      name: 'Notewell',
      detail: '$22/seat · SOC 2 Type II · SAML SSO',
    },
    others: [
      {
        name: 'Fireflies.ai',
        detail: 'SOC 2 Type II · $19/seat',
      },
      {
        name: 'Otter.ai',
        detail: 'SOC 2 Type II · $20/seat',
      },
    ] as const,
    citedPill: 'Cited: notewell.io/pricing',
    citationsFrom: 6,
    citationsTo: 33,
    outcomePrefix: 'Citations:',
    outcomeSuffix: 'Saved locally in SQLite',
  },
  outro: {
    wordmark: 'Hearsay',
    tagline: 'Know why AI skipped you. Fix it.',
    command: 'npx @melonwer/hearsay check yoursite.com',
    footer: 'Open source · MIT · Local SQLite · Zero API keys to start',
  },
} as const;

// ============================================================================
// Scene-Relative Cue Offsets (Synced 1:1 with Visual Animation & SFX Hits)
// ============================================================================

export const SCENE_CUES = {
  invisible: {
    chatEnter: 28,
    omittedLand: 124,
  },
  command: {
    cutIn: 4,
    typeStart: 22,
    humanReveal: 86,
    aiZeroLand: 118,
  },
  receipt: {
    strikeStart: 34,
    receiptPrint: 56,
    skippedStamp: 116,
  },
  fix: {
    cardEnter: 6,
    morphStart: 76,
    shippedPill: 124,
  },
  payoff: {
    notewellSlideIn: 66,
    citedLock: 100,
  },
  outro: {
    logoLand: 8,
    ctaResolve: 46,
  },
} as const;

// ============================================================================
// Music Bed & Beat-Aligned SFX Cues
// Loudness target: I ≈ -18.5 LUFS, True Peak ≈ -3.5 dBTP, 0 clipped samples
// ============================================================================

/**
 * audio/music.mp3 is 111.46s (3,343f @ 30fps).
 * trimBefore=252 (8.40s) leaves 103.06s (3,091f) — easily covers 100% of TOTAL (1,210f / 40.33s).
 */
export const MUSIC = {
  from: 0,
  duration: TOTAL,
  src: 'audio/music.mp3',
  trimBefore: 252,
  volume: 0.4,
  fadeInFrames: 18,
  fadeOutFrames: 42,
} as const;

export interface SfxCue {
  readonly from: number;
  readonly duration: number;
  readonly src: string;
  readonly volume: number;
  readonly action: string;
}

export const SFX: readonly SfxCue[] = [
  // Scene 1: invisible (0..207)
  {
    from: TIMELINE.invisible.from + SCENE_CUES.invisible.chatEnter, // 28
    duration: 45,
    src: 'audio/whoosh.mp3',
    volume: 0.36,
    action: 'Buyer chat card enters',
  },
  {
    from: TIMELINE.invisible.from + SCENE_CUES.invisible.omittedLand, // 124
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.44,
    action: "Notewell isn't mentioned line lands",
  },

  // Scene 2: command (207..413)
  {
    from: TIMELINE.command.from + SCENE_CUES.command.cutIn, // 211
    duration: 45,
    src: 'audio/whoosh.mp3',
    volume: 0.38,
    action: 'Cut to obsidian dark command scene',
  },
  {
    from: TIMELINE.command.from + SCENE_CUES.command.humanReveal, // 293
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.44,
    action: 'What humans see: 1,167 words reveals',
  },
  {
    from: TIMELINE.command.from + SCENE_CUES.command.aiZeroLand, // 325
    duration: 38,
    src: 'audio/marker.mp3',
    volume: 0.48,
    action: 'What AI sees: 0 words lands',
  },

  // Scene 3: receipt (413..620)
  {
    from: TIMELINE.receipt.from + SCENE_CUES.receipt.strikeStart, // 447
    duration: 38,
    src: 'audio/marker.mp3',
    volume: 0.5,
    action: 'Crimson slash across 74/100',
  },
  {
    from: TIMELINE.receipt.from + SCENE_CUES.receipt.receiptPrint, // 469
    duration: 15,
    src: 'audio/paper.mp3',
    volume: 0.5,
    action: 'Thermal receipt rolls down',
  },
  {
    from: TIMELINE.receipt.from + SCENE_CUES.receipt.skippedStamp, // 529
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.46,
    action: 'SKIPPED crimson stamp lands',
  },

  // Scene 4: fix (620..826)
  {
    from: TIMELINE.fix.from + SCENE_CUES.fix.cardEnter, // 626
    duration: 15,
    src: 'audio/paper.mp3',
    volume: 0.42,
    action: 'Mist canvas and empty root card enter',
  },
  {
    from: TIMELINE.fix.from + SCENE_CUES.fix.morphStart, // 696
    duration: 45,
    src: 'audio/whoosh.mp3',
    volume: 0.38,
    action: 'Morph into plain HTML pricing table',
  },
  {
    from: TIMELINE.fix.from + SCENE_CUES.fix.shippedPill, // 744
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.44,
    action: 'Shipped on Monday pill locks in',
  },

  // Scene 5: payoff (826..1033)
  {
    from: TIMELINE.payoff.from + SCENE_CUES.payoff.notewellSlideIn, // 892
    duration: 45,
    src: 'audio/whoosh.mp3',
    volume: 0.36,
    action: 'Notewell slides smoothly into #1',
  },
  {
    from: TIMELINE.payoff.from + SCENE_CUES.payoff.citedLock, // 926
    duration: 15,
    src: 'audio/click.mp3',
    volume: 0.46,
    action: 'Cited pill and 6% to 33% outcome land',
  },

  // Scene 6: outro (1033..1210)
  {
    from: TIMELINE.outro.from + SCENE_CUES.outro.logoLand, // 1041
    duration: 90,
    src: 'audio/impact.mp3',
    volume: 0.44,
    action: 'Hearsay keynote lockup lands',
  },
  {
    from: TIMELINE.outro.from + SCENE_CUES.outro.ctaResolve, // 1079
    duration: 75,
    src: 'audio/shimmer.mp3',
    volume: 0.28,
    action: 'Tagline and npx command pill resolve',
  },
];
