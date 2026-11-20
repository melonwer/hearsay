import type React from 'react';
import {Easing, interpolate} from 'remotion';
import {FONT_FAMILIES} from './fonts';

// ============================================================================
// Canvas, Safe-Area & Apple-Minimal Whitespace Constants (1920x1080 @ 30fps)
// ============================================================================

export const CANVAS = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

/**
 * Generous editorial margins so every scene holds 60%+ open whitespace
 * and reads cleanly in under 1.5 seconds without crowding the edges.
 */
export const SAFE = {
  x: 128,
  y: 88,
  contentWidth: 1920 - 128 * 2, // 1664
  contentHeight: 1080 - 88 * 2, // 904
} as const;

export const LAYOUT = {
  /** Primary horizontal gap in balanced 2-column scenes */
  splitGap: 96,
  /** Comfortable headline column width for 2-column compositions */
  headlineCol: 680,
  /** Hero visual column width for 2-column compositions */
  visualCol: 888,
  /** Centered single-hero column max width */
  centeredMax: 1180,
  /** Clean floating card width (chat cards, HTML fix card) */
  cardWidth: 780,
  /** Signature thermal receipt width */
  receiptWidth: 680,
} as const;

// ============================================================================
// Website-Matched Color Tokens (docs/showcase.css)
// ============================================================================

export const PALETTE = {
  paper: '#ffffff',
  mist: '#f5f5f7',
  ink: '#1d1d1f',
  graphite: '#6e6e73',
  hair: 'rgba(0, 0, 0, 0.08)',
  hairStrong: 'rgba(0, 0, 0, 0.14)',

  night: '#000000',
  nightCard: '#141416',
  nightElevated: '#1d1d1f',
  nightInk: '#f5f5f7',
  nightMuted: '#86868b',
  nightHair: 'rgba(255, 255, 255, 0.10)',
  nightHairStrong: 'rgba(255, 255, 255, 0.18)',

  cobalt: '#0071e3',
  cobaltInk: '#0066cc',
  cobaltNight: '#2997ff',

  signal: '#d70015',
  signalNight: '#ff453a',

  emerald: '#1a8917',
  emeraldNight: '#30d158',

  thermal: '#fbfaf6',
  thermalInk: '#2b2a27',
  thermalMuted: '#77736a',
  thermalDash: 'rgba(43, 42, 39, 0.28)',
} as const;

export type ThemeName = 'light' | 'mist' | 'dark';
export type Tone = 'neutral' | 'cobalt' | 'signal' | 'emerald';

export interface ThemeTokens {
  name: ThemeName;
  isDark: boolean;
  bg: string;
  surface: string;
  surfaceElevated: string;
  ink: string;
  muted: string;
  hairline: string;
  hairlineStrong: string;
  cobalt: string;
  cobaltText: string;
  cobaltSoft: string;
  signal: string;
  signalSoft: string;
  emerald: string;
  emeraldSoft: string;
  ambientGlow: string;
}

export const THEMES: Record<ThemeName, ThemeTokens> = {
  light: {
    name: 'light',
    isDark: false,
    bg: PALETTE.paper,
    surface: PALETTE.mist,
    surfaceElevated: PALETTE.paper,
    ink: PALETTE.ink,
    muted: PALETTE.graphite,
    hairline: PALETTE.hair,
    hairlineStrong: PALETTE.hairStrong,
    cobalt: PALETTE.cobalt,
    cobaltText: PALETTE.cobaltInk,
    cobaltSoft: 'rgba(0, 113, 227, 0.10)',
    signal: PALETTE.signal,
    signalSoft: 'rgba(215, 0, 21, 0.08)',
    emerald: PALETTE.emerald,
    emeraldSoft: 'rgba(26, 137, 23, 0.10)',
    ambientGlow:
      'radial-gradient(ellipse 64% 52% at 50% 0%, rgba(0, 113, 227, 0.032), transparent 68%)',
  },
  mist: {
    name: 'mist',
    isDark: false,
    bg: PALETTE.mist,
    surface: PALETTE.paper,
    surfaceElevated: PALETTE.paper,
    ink: PALETTE.ink,
    muted: PALETTE.graphite,
    hairline: PALETTE.hair,
    hairlineStrong: PALETTE.hairStrong,
    cobalt: PALETTE.cobalt,
    cobaltText: PALETTE.cobaltInk,
    cobaltSoft: 'rgba(0, 113, 227, 0.10)',
    signal: PALETTE.signal,
    signalSoft: 'rgba(215, 0, 21, 0.08)',
    emerald: PALETTE.emerald,
    emeraldSoft: 'rgba(26, 137, 23, 0.10)',
    ambientGlow:
      'radial-gradient(ellipse 68% 54% at 50% 0%, rgba(255, 255, 255, 0.72), transparent 66%)',
  },
  dark: {
    name: 'dark',
    isDark: true,
    bg: PALETTE.night,
    surface: PALETTE.nightCard,
    surfaceElevated: PALETTE.nightElevated,
    ink: PALETTE.nightInk,
    muted: PALETTE.nightMuted,
    hairline: PALETTE.nightHair,
    hairlineStrong: PALETTE.nightHairStrong,
    cobalt: PALETTE.cobaltNight,
    cobaltText: PALETTE.cobaltNight,
    cobaltSoft: 'rgba(41, 151, 255, 0.14)',
    signal: PALETTE.signalNight,
    signalSoft: 'rgba(255, 69, 58, 0.15)',
    emerald: PALETTE.emeraldNight,
    emeraldSoft: 'rgba(48, 209, 88, 0.14)',
    ambientGlow:
      'radial-gradient(ellipse 60% 48% at 50% 18%, rgba(41, 151, 255, 0.075), transparent 68%)',
  },
};

export const THERMAL = {
  paper: PALETTE.thermal,
  ink: PALETTE.thermalInk,
  muted: PALETTE.thermalMuted,
  dash: PALETTE.thermalDash,
  highlight: 'rgba(0, 113, 227, 0.22)',
  slotGradient: 'linear-gradient(180deg, #2c2c2e 0%, #1c1c1e 100%)',
  topShade: 'linear-gradient(180deg, rgba(0, 0, 0, 0.06) 0%, transparent 24px)',
  stampSignal: PALETTE.signal,
  stampEmerald: PALETTE.emerald,
  stampCobalt: PALETTE.cobalt,
} as const;

export const getToneColors = (tone: Tone, theme: ThemeName = 'light') => {
  const t = THEMES[theme];
  switch (tone) {
    case 'cobalt':
      return {
        fg: t.cobaltText,
        accent: t.cobalt,
        bg: t.cobaltSoft,
        border: t.isDark ? 'rgba(41, 151, 255, 0.34)' : 'rgba(0, 113, 227, 0.22)',
      };
    case 'signal':
      return {
        fg: t.signal,
        accent: t.signal,
        bg: t.signalSoft,
        border: t.isDark ? 'rgba(255, 69, 58, 0.36)' : 'rgba(215, 0, 21, 0.22)',
      };
    case 'emerald':
      return {
        fg: t.emerald,
        accent: t.emerald,
        bg: t.emeraldSoft,
        border: t.isDark ? 'rgba(48, 209, 88, 0.34)' : 'rgba(26, 137, 23, 0.22)',
      };
    case 'neutral':
    default:
      return {
        fg: t.muted,
        accent: t.ink,
        bg: t.isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)',
        border: t.hairlineStrong,
      };
  }
};

// ============================================================================
// Effortless Apple-Minimal Typography Scales (1920x1080)
// Display: 76-104px · Body/Cards: 24-34px · Giant Hero Stats: 108-140px
// ============================================================================

export const FONTS = {
  sans: `"${FONT_FAMILIES.sans}", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif`,
  mono: `"${FONT_FAMILIES.mono}", "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`,
} as const;

export const TYPE = {
  /** Final Apple-keynote lockup wordmark */
  wordmark: {
    fontFamily: FONTS.sans,
    fontSize: 120,
    fontWeight: 700,
    lineHeight: 0.94,
    letterSpacing: '-0.055em',
  },
  /** Full-stage centered hero display headline (96-104px) */
  displayHero: {
    fontFamily: FONTS.sans,
    fontSize: 98,
    fontWeight: 700,
    lineHeight: 1.0,
    letterSpacing: '-0.048em',
  },
  /** Primary scene headline (84px) */
  displayLg: {
    fontFamily: FONTS.sans,
    fontSize: 84,
    fontWeight: 700,
    lineHeight: 1.04,
    letterSpacing: '-0.044em',
  },
  /** Secondary / balanced two-column headline (76px) */
  displayMd: {
    fontFamily: FONTS.sans,
    fontSize: 76,
    fontWeight: 700,
    lineHeight: 1.05,
    letterSpacing: '-0.042em',
  },
  /** Giant hero stat (1,167 words vs 0 words) */
  bigStat: {
    fontFamily: FONTS.sans,
    fontSize: 132,
    fontWeight: 700,
    lineHeight: 0.92,
    letterSpacing: '-0.055em',
    fontVariantNumeric: 'tabular-nums',
  },
  /** Emphasized punchline / card heading */
  subhead: {
    fontFamily: FONTS.sans,
    fontSize: 36,
    fontWeight: 600,
    lineHeight: 1.2,
    letterSpacing: '-0.026em',
  },
  /** Effortless readable body, chat bubbles, and ledes (30px) */
  bodyLg: {
    fontFamily: FONTS.sans,
    fontSize: 30,
    fontWeight: 400,
    lineHeight: 1.38,
    letterSpacing: '-0.016em',
  },
  /** Standard card copy (26px) */
  body: {
    fontFamily: FONTS.sans,
    fontSize: 26,
    fontWeight: 400,
    lineHeight: 1.42,
    letterSpacing: '-0.012em',
  },
  /** Emphasized card titles and labels (26px semibold) */
  bodyStrong: {
    fontFamily: FONTS.sans,
    fontSize: 26,
    fontWeight: 600,
    lineHeight: 1.35,
    letterSpacing: '-0.018em',
  },
  /** Quiet supporting line / grounded outcome caption (24px) */
  caption: {
    fontFamily: FONTS.sans,
    fontSize: 24,
    fontWeight: 500,
    lineHeight: 1.36,
    letterSpacing: '-0.012em',
  },
  /** Terminal command pill copy (28px mono) */
  monoLg: {
    fontFamily: FONTS.mono,
    fontSize: 28,
    fontWeight: 500,
    lineHeight: 1.4,
    letterSpacing: '-0.015em',
  },
  /** Standard receipt / code copy (24px mono) */
  mono: {
    fontFamily: FONTS.mono,
    fontSize: 24,
    fontWeight: 500,
    lineHeight: 1.45,
    letterSpacing: '-0.01em',
  },
  /** Quiet mono metadata (20px) */
  monoSm: {
    fontFamily: FONTS.mono,
    fontSize: 20,
    fontWeight: 400,
    lineHeight: 1.4,
    letterSpacing: '0em',
  },
} as const satisfies Record<string, React.CSSProperties>;

// ============================================================================
// Radii, Borders & Whisper-Soft Apple Shadows
// ============================================================================

export const RADII = {
  card: 28,
  panel: 20,
  row: 16,
  pill: 999,
} as const;

export const SHADOWS = {
  cardLight:
    '0 1px 2px rgba(0, 0, 0, 0.04), 0 18px 42px -14px rgba(0, 0, 0, 0.08), 0 48px 96px -32px rgba(0, 0, 0, 0.14)',
  cardDark:
    '0 2px 6px rgba(0, 0, 0, 0.55), 0 28px 68px -20px rgba(0, 0, 0, 0.78), 0 0 0 1px rgba(255, 255, 255, 0.08)',
  pillDark:
    '0 18px 44px -14px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.12)',
  pillLight:
    '0 12px 30px -12px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.08)',
  receiptDark: 'drop-shadow(0 30px 44px rgba(0, 0, 0, 0.70))',
  receiptLight: 'drop-shadow(0 24px 36px rgba(0, 0, 0, 0.18))',
} as const;

export const cardBorder = (theme: ThemeName) =>
  `1px solid ${THEMES[theme].hairline}`;

// ============================================================================
// Motion Curves & Deterministic Frame Helpers (interpolate + Easing.bezier)
// ============================================================================

export const EASE = {
  /** Primary Apple-editorial ease-out matching showcase.css --ease-out */
  out: Easing.bezier(0.16, 1, 0.3, 1),
  /** Silky deceleration for headlines, cards, and layout morphs */
  editorial: Easing.bezier(0.22, 1, 0.36, 1),
  /** Crisp UI entrance for pills and strikes */
  snappy: Easing.bezier(0.2, 0.9, 0.3, 1),
  /** Symmetric ease for smooth cross-morphs */
  inOut: Easing.bezier(0.45, 0, 0.55, 1),
  /** Subtle gravity exit */
  in: Easing.bezier(0.4, 0, 1, 1),
  /** Restrained pop for rubber stamps and citation pills */
  pop: Easing.bezier(0.34, 1.32, 0.64, 1),
} as const;

export const clampProgress = (
  frame: number,
  start: number,
  end: number,
  easing: (t: number) => number = EASE.out,
): number => {
  if (end <= start) {
    return frame >= end ? 1 : 0;
  }
  return interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
};

export const exitEnvelope = (
  frame: number,
  duration: number,
  exitFrames = 12,
): number => {
  if (exitFrames <= 0 || duration <= exitFrames) {
    return 1;
  }
  return interpolate(frame, [duration - exitFrames, duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE.in,
  });
};

export const stagger = (index: number, stepFrames = 8, baseDelay = 0): number =>
  baseDelay + index * stepFrames;
