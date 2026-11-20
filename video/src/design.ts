import type React from 'react';
import {Easing, interpolate, spring} from 'remotion';
import {FONT_FAMILIES} from './fonts';

// ============================================================================
// Canvas & Safe-Area Constants (1920x1080 @ 30fps)
// ============================================================================

export const CANVAS = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

export const SAFE = {
  x: 108,
  y: 72,
  topHeader: 128,
  bottom: 72,
  contentWidth: 1920 - 108 * 2, // 1704
  contentHeight: 1080 - 72 * 2, // 936
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
  nightCard: '#161617',
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

  amber: '#b25e09',
  amberNight: '#ff9f0a',

  thermal: '#fbfaf6',
  thermalInk: '#2b2a27',
  thermalMuted: '#77736a',
  thermalDash: 'rgba(43, 42, 39, 0.28)',
} as const;

export type ThemeName = 'light' | 'mist' | 'dark';
export type Tone = 'neutral' | 'cobalt' | 'signal' | 'emerald' | 'amber';

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
  amber: string;
  amberSoft: string;
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
    amber: PALETTE.amber,
    amberSoft: 'rgba(178, 94, 9, 0.10)',
    ambientGlow: 'radial-gradient(ellipse 68% 58% at 84% 18%, rgba(0, 113, 227, 0.055), transparent 68%)',
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
    amber: PALETTE.amber,
    amberSoft: 'rgba(178, 94, 9, 0.10)',
    ambientGlow: 'radial-gradient(ellipse 62% 52% at 22% 16%, rgba(255, 255, 255, 0.85), transparent 66%)',
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
    amber: PALETTE.amberNight,
    amberSoft: 'rgba(255, 159, 10, 0.15)',
    ambientGlow: 'radial-gradient(ellipse 65% 55% at 78% 18%, rgba(41, 151, 255, 0.09), transparent 68%)',
  },
};

export const THERMAL = {
  paper: PALETTE.thermal,
  ink: PALETTE.thermalInk,
  muted: PALETTE.thermalMuted,
  dash: PALETTE.thermalDash,
  highlight: 'rgba(0, 113, 227, 0.22)',
  slotGradient: 'linear-gradient(180deg, #2c2c2e 0%, #1c1c1e 100%)',
  topShade: 'linear-gradient(180deg, rgba(0, 0, 0, 0.06) 0%, transparent 22px)',
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
        border: t.isDark ? 'rgba(41, 151, 255, 0.35)' : 'rgba(0, 113, 227, 0.24)',
      };
    case 'signal':
      return {
        fg: t.signal,
        accent: t.signal,
        bg: t.signalSoft,
        border: t.isDark ? 'rgba(255, 69, 58, 0.38)' : 'rgba(215, 0, 21, 0.24)',
      };
    case 'emerald':
      return {
        fg: t.emerald,
        accent: t.emerald,
        bg: t.emeraldSoft,
        border: t.isDark ? 'rgba(48, 209, 88, 0.35)' : 'rgba(26, 137, 23, 0.24)',
      };
    case 'amber':
      return {
        fg: t.amber,
        accent: t.amber,
        bg: t.amberSoft,
        border: t.isDark ? 'rgba(255, 159, 10, 0.35)' : 'rgba(178, 94, 9, 0.24)',
      };
    case 'neutral':
    default:
      return {
        fg: t.muted,
        accent: t.ink,
        bg: t.isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.055)',
        border: t.hairlineStrong,
      };
  }
};

// ============================================================================
// Typography (Readable at 1920x1080: >=22px body, 64-116px display)
// ============================================================================

export const FONTS = {
  sans: `"${FONT_FAMILIES.sans}", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif`,
  mono: `"${FONT_FAMILIES.mono}", "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`,
} as const;

export const TYPE: Record<string, React.CSSProperties> = {
  wordmark: {
    fontFamily: FONTS.sans,
    fontSize: 116,
    fontWeight: 700,
    lineHeight: 0.94,
    letterSpacing: '-0.055em',
  },
  hero: {
    fontFamily: FONTS.sans,
    fontSize: 96,
    fontWeight: 700,
    lineHeight: 1.0,
    letterSpacing: '-0.048em',
  },
  display: {
    fontFamily: FONTS.sans,
    fontSize: 78,
    fontWeight: 700,
    lineHeight: 1.04,
    letterSpacing: '-0.042em',
  },
  headline: {
    fontFamily: FONTS.sans,
    fontSize: 64,
    fontWeight: 700,
    lineHeight: 1.07,
    letterSpacing: '-0.038em',
  },
  subhead: {
    fontFamily: FONTS.sans,
    fontSize: 38,
    fontWeight: 600,
    lineHeight: 1.18,
    letterSpacing: '-0.028em',
  },
  lede: {
    fontFamily: FONTS.sans,
    fontSize: 28,
    fontWeight: 400,
    lineHeight: 1.4,
    letterSpacing: '-0.014em',
  },
  body: {
    fontFamily: FONTS.sans,
    fontSize: 24,
    fontWeight: 400,
    lineHeight: 1.45,
    letterSpacing: '-0.011em',
  },
  bodyStrong: {
    fontFamily: FONTS.sans,
    fontSize: 24,
    fontWeight: 600,
    lineHeight: 1.38,
    letterSpacing: '-0.016em',
  },
  caption: {
    fontFamily: FONTS.sans,
    fontSize: 22,
    fontWeight: 400,
    lineHeight: 1.4,
    letterSpacing: '-0.01em',
  },
  eyebrow: {
    fontFamily: FONTS.sans,
    fontSize: 20,
    fontWeight: 600,
    lineHeight: 1.2,
    letterSpacing: '0.11em',
    textTransform: 'uppercase',
  },
  mono: {
    fontFamily: FONTS.mono,
    fontSize: 22,
    fontWeight: 500,
    lineHeight: 1.5,
    letterSpacing: '-0.01em',
  },
  monoCompact: {
    fontFamily: FONTS.mono,
    fontSize: 20,
    fontWeight: 400,
    lineHeight: 1.45,
    letterSpacing: '0em',
  },
  stat: {
    fontFamily: FONTS.sans,
    fontSize: 88,
    fontWeight: 700,
    lineHeight: 0.94,
    letterSpacing: '-0.052em',
    fontVariantNumeric: 'tabular-nums',
  },
};

// ============================================================================
// Radii, Borders & Shadows
// ============================================================================

export const RADII = {
  device: 24,
  card: 20,
  panel: 16,
  row: 12,
  pill: 999,
} as const;

export const SHADOWS = {
  deviceLight:
    '0 1px 2px rgba(0, 0, 0, 0.04), 0 18px 40px -12px rgba(0, 0, 0, 0.09), 0 48px 96px -28px rgba(0, 0, 0, 0.18)',
  deviceDark:
    '0 2px 4px rgba(0, 0, 0, 0.50), 0 28px 68px -18px rgba(0, 0, 0, 0.78), 0 0 0 1px rgba(255, 255, 255, 0.08)',
  cardLight:
    '0 1px 2px rgba(0, 0, 0, 0.04), 0 14px 32px -12px rgba(0, 0, 0, 0.09)',
  cardDark:
    '0 18px 44px -14px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.07)',
  receiptLight: 'drop-shadow(0 24px 34px rgba(0, 0, 0, 0.22))',
  receiptDark: 'drop-shadow(0 28px 42px rgba(0, 0, 0, 0.68))',
} as const;

export const cardBorder = (theme: ThemeName) =>
  `1px solid ${THEMES[theme].hairline}`;

// ============================================================================
// Motion Curves, Springs & Frame Interpolation Helpers
// ============================================================================

export const EASE = {
  /** Primary Apple-editorial ease-out matching showcase.css --ease-out */
  out: Easing.bezier(0.16, 1, 0.3, 1),
  /** Silky deceleration for large editorial layouts and panels */
  editorial: Easing.bezier(0.22, 1, 0.36, 1),
  /** Crisp UI entrance for badges, chips, and terminal rows */
  snappy: Easing.bezier(0.2, 0.9, 0.3, 1),
  /** Symmetric ease for smooth pans and hold-friendly shifts */
  inOut: Easing.bezier(0.45, 0, 0.55, 1),
  /** Subtle gravity exit */
  in: Easing.bezier(0.4, 0, 1, 1),
  /** Restrained pop for rubber stamps and status badges */
  pop: Easing.bezier(0.34, 1.32, 0.64, 1),
} as const;

export const SPRINGS = {
  smooth: {damping: 200, stiffness: 120, mass: 1},
  snappy: {damping: 26, stiffness: 260, mass: 0.9},
  editorial: {damping: 32, stiffness: 170, mass: 1.1},
} as const;

export type SpringPreset = keyof typeof SPRINGS;

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

export const springProgress = (
  frame: number,
  delay = 0,
  preset: SpringPreset = 'editorial',
  fps = CANVAS.fps,
): number => {
  return spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: SPRINGS[preset],
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

export const stagger = (index: number, stepFrames = 6, baseDelay = 0): number =>
  baseDelay + index * stepFrames;
