import React from 'react';
import './fonts';
import {
  AbsoluteFill,
  Interactive,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {
  EASE,
  FONTS,
  PALETTE,
  RADII,
  SAFE,
  SHADOWS,
  THEMES,
  THERMAL,
  TYPE,
  clampProgress,
  exitEnvelope,
  getToneColors,
  type ThemeName,
  type Tone,
} from './design';

// ============================================================================
// SubtleGrid — Architectural hairline coordinate field with radial fade
// ============================================================================

export const SubtleGrid: React.FC<{
  theme?: ThemeName;
  cellSize?: number;
  opacity?: number;
}> = ({theme = 'light', cellSize = 64, opacity}) => {
  const t = THEMES[theme];
  const lineColor = t.isDark
    ? 'rgba(255, 255, 255, 0.045)'
    : 'rgba(29, 29, 31, 0.042)';

  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        opacity: opacity ?? 1,
        backgroundImage: `linear-gradient(to right, ${lineColor} 1px, transparent 1px), linear-gradient(to bottom, ${lineColor} 1px, transparent 1px)`,
        backgroundSize: `${cellSize}px ${cellSize}px`,
        WebkitMaskImage:
          'radial-gradient(ellipse 78% 72% at 50% 48%, #000 35%, transparent 100%)',
        maskImage:
          'radial-gradient(ellipse 78% 72% at 50% 48%, #000 35%, transparent 100%)',
      }}
    />
  );
};

// ============================================================================
// BrandMark — Editorial favicon square + tight-tracked Hearsay wordmark
// ============================================================================

export const BrandMark: React.FC<{
  theme?: ThemeName;
  size?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
}> = ({theme = 'light', size = 'md', style}) => {
  const t = THEMES[theme];
  const dims =
    size === 'sm'
      ? {box: 30, boxFont: 20, label: 24, gap: 11, radius: 8}
      : size === 'lg'
        ? {box: 46, boxFont: 30, label: 36, gap: 15, radius: 12}
        : {box: 36, boxFont: 24, label: 28, gap: 13, radius: 10};

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
        fontFamily: FONTS.sans,
        fontSize: dims.label,
        fontWeight: 700,
        letterSpacing: '-0.035em',
        color: t.ink,
        ...style,
      }}
    >
      <span
        style={{
          width: dims.box,
          height: dims.box,
          borderRadius: dims.radius,
          background: t.isDark ? PALETTE.nightInk : PALETTE.ink,
          color: t.isDark ? PALETTE.night : PALETTE.paper,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: dims.boxFont,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: '-0.04em',
        }}
      >
        h
      </span>
      <span>Hearsay</span>
    </div>
  );
};

// ============================================================================
// SceneTransition — Clean frame-driven entrance & exit envelope (zero CSS anim)
// ============================================================================

export const SceneTransition: React.FC<
  React.PropsWithChildren<{
    duration: number;
    enterFrames?: number;
    exitFrames?: number;
    enterShiftY?: number;
    exitScale?: number;
    style?: React.CSSProperties;
  }>
> = ({
  duration,
  enterFrames = 14,
  exitFrames = 12,
  enterShiftY = 18,
  exitScale = 0.992,
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const enter = clampProgress(frame, 0, enterFrames, EASE.out);
  const exit = exitEnvelope(frame, duration, exitFrames);
  const opacity = enter * exit;
  const shiftY = interpolate(enter, [0, 1], [enterShiftY, 0]);
  const scale = interpolate(exit, [0, 1], [exitScale, 1]);

  return (
    <AbsoluteFill
      style={{
        opacity,
        translate: `0px ${shiftY}px`,
        scale,
        ...style,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

// ============================================================================
// SceneCanvas — Full-bleed 1920x1080 editorial stage
// ============================================================================

export const SceneCanvas: React.FC<
  React.PropsWithChildren<{
    theme?: ThemeName;
    duration?: number;
    showBrand?: boolean;
    showGrid?: boolean;
    sceneIndex?: number;
    totalScenes?: number;
    topRight?: React.ReactNode;
    footnote?: string;
    fadeInFrames?: number;
    fadeOutFrames?: number;
  }>
> = ({
  theme = 'light',
  duration,
  showBrand = true,
  showGrid = true,
  sceneIndex,
  totalScenes = 7,
  topRight,
  footnote,
  fadeInFrames = 12,
  fadeOutFrames = 10,
  children,
}) => {
  const t = THEMES[theme];
  const frame = useCurrentFrame();
  const contentOpacity =
    duration !== undefined
      ? clampProgress(frame, 0, fadeInFrames, EASE.out) *
        exitEnvelope(frame, duration, fadeOutFrames)
      : 1;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: t.bg,
        color: t.ink,
        fontFamily: FONTS.sans,
        overflow: 'hidden',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {/* Subtle monochrome/cobalt ambient wash */}
      <AbsoluteFill style={{background: t.ambientGlow, pointerEvents: 'none'}} />

      {showGrid && <SubtleGrid theme={theme} />}

      {/* Main scene stage */}
      <AbsoluteFill style={{opacity: contentOpacity}}>{children}</AbsoluteFill>

      {/* Top chrome: brand lockup + scene index */}
      {showBrand && (
        <Interactive.Div
          name="Scene top bar"
          style={{
            position: 'absolute',
            left: SAFE.x,
            right: SAFE.x,
            top: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            pointerEvents: 'none',
          }}
        >
          <BrandMark theme={theme} size="sm" />
          <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
            {topRight}
            {sceneIndex !== undefined && (
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 18,
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  color: t.muted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {String(sceneIndex).padStart(2, '0')} /{' '}
                {String(totalScenes).padStart(2, '0')}
              </span>
            )}
          </div>
        </Interactive.Div>
      )}

      {/* Subtle bottom-left footnote */}
      {footnote && (
        <div
          style={{
            position: 'absolute',
            left: SAFE.x,
            bottom: 38,
            fontFamily: FONTS.mono,
            fontSize: 18,
            color: t.muted,
            letterSpacing: '0.01em',
            opacity: 0.85,
          }}
        >
          {footnote}
        </div>
      )}
    </AbsoluteFill>
  );
};

// ============================================================================
// EyebrowBadge — Crisp uppercase scene eyebrow / section tag
// ============================================================================

export const EyebrowBadge: React.FC<
  React.PropsWithChildren<{
    theme?: ThemeName;
    tone?: Tone;
    delay?: number;
    dot?: boolean;
    pill?: boolean;
    style?: React.CSSProperties;
  }>
> = ({
  theme = 'light',
  tone = 'neutral',
  delay = 0,
  dot = true,
  pill = false,
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const p = clampProgress(frame, delay, delay + 16, EASE.out);
  const colors = getToneColors(tone, theme);
  const t = THEMES[theme];

  return (
    <Interactive.Div
      name="Eyebrow badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        ...(pill
          ? {
              padding: '7px 16px',
              borderRadius: RADII.pill,
              backgroundColor: colors.bg,
              border: `1px solid ${colors.border}`,
            }
          : {}),
        ...TYPE.eyebrow,
        color: tone === 'neutral' ? t.muted : colors.fg,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [12, 0])}px`,
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: RADII.pill,
            backgroundColor: tone === 'neutral' ? t.cobalt : colors.accent,
            flexShrink: 0,
          }}
        />
      )}
      <span>{children}</span>
    </Interactive.Div>
  );
};

// ============================================================================
// KineticHeadline — Masked line-by-line upward display reveal
// ============================================================================

export const KineticHeadline: React.FC<{
  lines: readonly string[];
  theme?: ThemeName;
  size?: number;
  align?: 'left' | 'center';
  delay?: number;
  stagger?: number;
  maxWidth?: number;
  accentLastLine?: boolean;
  accentColor?: string;
  style?: React.CSSProperties;
}> = ({
  lines,
  theme = 'light',
  size = 78,
  align = 'left',
  delay = 4,
  stagger = 7,
  maxWidth,
  accentLastLine = false,
  accentColor,
  style,
}) => {
  const frame = useCurrentFrame();
  const t = THEMES[theme];

  return (
    <Interactive.Div
      name="Kinetic headline"
      style={{
        maxWidth,
        textAlign: align,
        fontFamily: FONTS.sans,
        fontSize: size,
        fontWeight: 700,
        lineHeight: 1.04,
        letterSpacing: '-0.044em',
        color: t.ink,
        ...style,
      }}
    >
      {lines.map((line, i) => {
        const start = delay + i * stagger;
        const p = clampProgress(frame, start, start + 22, EASE.editorial);
        const isAccented = accentLastLine && i === lines.length - 1;

        return (
          <div
            key={`${line}-${i}`}
            style={{
              overflow: 'hidden',
              paddingBottom: '0.1em',
              marginBottom: '-0.1em',
            }}
          >
            <div
              style={{
                color: isAccented ? (accentColor ?? t.cobalt) : t.ink,
                opacity: clampProgress(frame, start, start + 14, EASE.out),
                translate: `0px ${interpolate(p, [0, 1], [size * 0.92, 0])}px`,
              }}
            >
              {line}
            </div>
          </div>
        );
      })}
    </Interactive.Div>
  );
};

// ============================================================================
// EditorialText — Readable >=22px lede/body copy with clean entrance
// ============================================================================

export const EditorialText: React.FC<
  React.PropsWithChildren<{
    theme?: ThemeName;
    size?: number;
    muted?: boolean;
    delay?: number;
    maxWidth?: number;
    align?: 'left' | 'center';
    style?: React.CSSProperties;
  }>
> = ({
  theme = 'light',
  size = 27,
  muted = true,
  delay = 16,
  maxWidth,
  align = 'left',
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const t = THEMES[theme];
  const p = clampProgress(frame, delay, delay + 20, EASE.out);

  return (
    <div
      style={{
        fontFamily: FONTS.sans,
        fontSize: size,
        fontWeight: 400,
        lineHeight: 1.42,
        letterSpacing: '-0.014em',
        color: muted ? t.muted : t.ink,
        maxWidth,
        textAlign: align,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [16, 0])}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

// ============================================================================
// StatusChip — Editorial pill tag (cited, omitted, durable, ephemeral, pass/fail)
// ============================================================================

export const StatusChip: React.FC<{
  label: string;
  tone?: Tone;
  theme?: ThemeName;
  dot?: boolean;
  mono?: boolean;
  delay?: number;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}> = ({
  label,
  tone = 'neutral',
  theme = 'light',
  dot = true,
  mono = false,
  delay = 0,
  size = 'md',
  style,
}) => {
  const frame = useCurrentFrame();
  const p = delay > 0 ? clampProgress(frame, delay, delay + 14, EASE.pop) : 1;
  const colors = getToneColors(tone, theme);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size === 'sm' ? 7 : 9,
        padding: size === 'sm' ? '6px 14px' : '9px 18px',
        borderRadius: RADII.pill,
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.fg,
        fontFamily: mono ? FONTS.mono : FONTS.sans,
        fontSize: size === 'sm' ? 19 : 21,
        fontWeight: 600,
        lineHeight: 1.2,
        letterSpacing: mono ? '-0.01em' : '-0.012em',
        whiteSpace: 'nowrap',
        opacity: clampProgress(frame, delay, delay + 10, EASE.out),
        scale: delay > 0 ? interpolate(p, [0, 1], [0.9, 1]) : 1,
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: RADII.pill,
            backgroundColor: colors.accent,
            flexShrink: 0,
          }}
        />
      )}
      {label}
    </span>
  );
};

// ============================================================================
// MacWindow — Sleek Apple-editorial app / browser / terminal window frame
// ============================================================================

export const MacWindow: React.FC<
  React.PropsWithChildren<{
    title?: string;
    subtitle?: string;
    theme?: 'light' | 'dark';
    trafficLights?: 'macos' | 'mono';
    headerRight?: React.ReactNode;
    delay?: number;
    width?: number | string;
    height?: number | string;
    style?: React.CSSProperties;
    bodyStyle?: React.CSSProperties;
  }>
> = ({
  title,
  subtitle,
  theme = 'dark',
  trafficLights = 'macos',
  headerRight,
  delay = 0,
  width = '100%',
  height,
  style,
  bodyStyle,
  children,
}) => {
  const frame = useCurrentFrame();
  const isDark = theme === 'dark';
  const p = delay > 0 ? clampProgress(frame, delay, delay + 22, EASE.editorial) : 1;

  const dotColors =
    trafficLights === 'macos'
      ? ['#ff5f57', '#febc2e', '#28c840']
      : isDark
        ? ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0.22)']
        : ['#d8d8de', '#d8d8de', '#d8d8de'];

  return (
    <Interactive.Div
      name={title ? `Window: ${title}` : 'macOS window'}
      style={{
        width,
        height,
        borderRadius: RADII.device,
        backgroundColor: isDark ? PALETTE.nightCard : PALETTE.paper,
        border: `1px solid ${isDark ? PALETTE.nightHairStrong : PALETTE.hair}`,
        boxShadow: isDark ? SHADOWS.deviceDark : SHADOWS.deviceLight,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        opacity: delay > 0 ? clampProgress(frame, delay, delay + 14, EASE.out) : 1,
        translate: `0px ${delay > 0 ? interpolate(p, [0, 1], [28, 0]) : 0}px`,
        scale: delay > 0 ? interpolate(p, [0, 1], [0.975, 1]) : 1,
        ...style,
      }}
    >
      {/* Window title bar */}
      <div
        style={{
          height: 54,
          padding: '0 22px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          backgroundColor: isDark ? '#1c1c1e' : '#fbfbfd',
          borderBottom: `1px solid ${isDark ? PALETTE.nightHair : PALETTE.hair}`,
          flexShrink: 0,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 9}}>
          {dotColors.map((c, idx) => (
            <span
              key={idx}
              style={{
                width: 12,
                height: 12,
                borderRadius: RADII.pill,
                backgroundColor: c,
              }}
            />
          ))}
        </div>

        {(title || subtitle) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '5px 16px',
              borderRadius: 10,
              backgroundColor: isDark
                ? 'rgba(255, 255, 255, 0.06)'
                : 'rgba(0, 0, 0, 0.045)',
              fontFamily: FONTS.mono,
              fontSize: 18,
              color: isDark ? PALETTE.nightMuted : PALETTE.graphite,
              letterSpacing: '-0.01em',
            }}
          >
            {title && (
              <span style={{color: isDark ? PALETTE.nightInk : PALETTE.ink, fontWeight: 500}}>
                {title}
              </span>
            )}
            {subtitle && <span>{subtitle}</span>}
          </div>
        )}

        <div style={{minWidth: 56, display: 'flex', justifyContent: 'flex-end'}}>
          {headerRight}
        </div>
      </div>

      {/* Window body */}
      <div style={{flex: 1, position: 'relative', ...bodyStyle}}>{children}</div>
    </Interactive.Div>
  );
};

// ============================================================================
// TerminalPrompt — Frame-driven live typing command with blinking cursor
// ============================================================================

export const TerminalPrompt: React.FC<{
  command: string;
  prefix?: string;
  startFrame?: number;
  charsPerFrame?: number;
  fontSize?: number;
  theme?: 'dark' | 'light';
  showPill?: boolean;
  showCursor?: boolean;
  style?: React.CSSProperties;
}> = ({
  command,
  prefix = '$',
  startFrame = 0,
  charsPerFrame = 1.6,
  fontSize = 24,
  theme = 'dark',
  showPill = true,
  showCursor = true,
  style,
}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const visibleChars = Math.min(command.length, Math.floor(elapsed * charsPerFrame));
  const typed = command.slice(0, visibleChars);
  const doneTyping = visibleChars >= command.length;
  // Deterministic frame-driven cursor blink (zero CSS animations)
  const cursorVisible =
    showCursor && (!doneTyping || Math.floor(elapsed / 14) % 2 === 0);

  const isDark = theme === 'dark';

  return (
    <Interactive.Div
      name="Terminal command"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 14,
        fontFamily: FONTS.mono,
        fontSize,
        fontWeight: 500,
        lineHeight: 1.4,
        letterSpacing: '-0.015em',
        color: isDark ? PALETTE.nightInk : PALETTE.ink,
        ...(showPill
          ? {
              padding: '18px 28px',
              borderRadius: RADII.panel,
              backgroundColor: isDark ? '#141416' : PALETTE.mist,
              border: `1px solid ${isDark ? 'rgba(255,255,255,0.14)' : PALETTE.hairStrong}`,
              boxShadow: isDark
                ? '0 16px 40px -12px rgba(0, 0, 0, 0.7)'
                : SHADOWS.cardLight,
            }
          : {}),
        ...style,
      }}
    >
      <span
        style={{
          color: isDark ? PALETTE.cobaltNight : PALETTE.cobalt,
          fontWeight: 700,
          userSelect: 'none',
        }}
      >
        {prefix}
      </span>
      <span style={{whiteSpace: 'pre'}}>
        {typed}
        {showCursor && (
          <span
            style={{
              display: 'inline-block',
              width: Math.max(10, Math.round(fontSize * 0.48)),
              height: Math.round(fontSize * 1.08),
              marginLeft: 4,
              verticalAlign: '-0.14em',
              borderRadius: 2,
              backgroundColor: isDark ? PALETTE.cobaltNight : PALETTE.cobalt,
              opacity: cursorVisible ? 1 : 0,
            }}
          />
        )}
      </span>
    </Interactive.Div>
  );
};

// ============================================================================
// ThermalReceipt & ReceiptRow — Signature Hearsay tactile thermal paper receipt
// ============================================================================

const SerratedBottomEdge: React.FC<{width: number; fill: string}> = ({
  width,
  fill,
}) => {
  const toothW = 16;
  const toothH = 11;
  const count = Math.ceil(width / toothW);
  const points: string[] = [`0,0`, `${width},0`, `${width},${toothH}`];
  for (let i = count; i >= 0; i--) {
    const xRight = i * toothW;
    const xMid = xRight - toothW / 2;
    const xLeft = xRight - toothW;
    if (xMid >= 0) {
      points.push(`${xMid},0`);
    }
    if (xLeft >= 0) {
      points.push(`${xLeft},${toothH}`);
    }
  }
  points.push(`0,0`);

  return (
    <svg
      width={width}
      height={toothH}
      viewBox={`0 0 ${width} ${toothH}`}
      style={{display: 'block', marginTop: -1}}
    >
      <polygon points={points.join(' ')} fill={fill} />
    </svg>
  );
};

export const ThermalReceipt: React.FC<
  React.PropsWithChildren<{
    headerBrand?: string;
    headerSub?: string;
    metaLeft?: string;
    metaRight?: string;
    width?: number;
    startFrame?: number;
    printDuration?: number;
    showSlot?: boolean;
    showBarcode?: boolean;
    footerLeft?: string;
    footerRight?: string;
    footerRightTone?: Tone;
    footerSub?: string;
    stampText?: string;
    stampTone?: 'signal' | 'emerald' | 'cobalt';
    stampFrame?: number;
    theme?: ThemeName;
    style?: React.CSSProperties;
  }>
> = ({
  headerBrand = 'Hearsay',
  headerSub = 'VERIFIED ANSWER RECEIPT',
  metaLeft,
  metaRight,
  width = 620,
  startFrame = 0,
  printDuration = 28,
  showSlot = true,
  showBarcode = true,
  footerLeft = 'VERDICT',
  footerRight,
  footerRightTone = 'signal',
  footerSub = 'Saved locally to SQLite · node:sqlite',
  stampText,
  stampTone = 'signal',
  stampFrame,
  theme = 'light',
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const feed = clampProgress(frame, startFrame, startFrame + printDuration, EASE.editorial);
  const paperWidth = showSlot ? width - 28 : width;

  const stampStart = stampFrame ?? startFrame + printDuration + 10;
  const stampP = stampText
    ? clampProgress(frame, stampStart, stampStart + 12, EASE.pop)
    : 0;
  const stampColor =
    stampTone === 'emerald'
      ? THERMAL.stampEmerald
      : stampTone === 'cobalt'
        ? THERMAL.stampCobalt
        : THERMAL.stampSignal;

  const footerToneColor =
    footerRightTone === 'emerald'
      ? THERMAL.stampEmerald
      : footerRightTone === 'cobalt'
        ? THERMAL.stampCobalt
        : footerRightTone === 'signal'
          ? THERMAL.stampSignal
          : THERMAL.ink;

  const isDarkBg = THEMES[theme].isDark;

  return (
    <Interactive.Div
      name="Thermal receipt"
      style={{
        width,
        position: 'relative',
        ...style,
      }}
    >
      {/* Printer feed slot */}
      {showSlot && (
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            width: '100%',
            height: 18,
            borderRadius: 10,
            background: THERMAL.slotGradient,
            boxShadow:
              'inset 0 4px 6px rgba(0, 0, 0, 0.85), 0 1px 0 rgba(255, 255, 255, 0.14)',
          }}
        />
      )}

      {/* Paper feed window */}
      <div
        style={{
          position: 'relative',
          margin: showSlot ? '-8px 14px 0' : 0,
          overflow: 'hidden',
          paddingBottom: 14,
          filter: isDarkBg ? SHADOWS.receiptDark : SHADOWS.receiptLight,
        }}
      >
        <div
          style={{
            position: 'relative',
            translate: `0px ${interpolate(feed, [0, 1], [-120, 0])}px`,
            clipPath: `inset(0 0 ${interpolate(feed, [0, 1], [100, 0])}% 0)`,
            opacity: clampProgress(frame, startFrame, startFrame + 6, EASE.out),
          }}
        >
          <div
            style={{
              background: `${THERMAL.topShade}, ${THERMAL.paper}`,
              color: THERMAL.ink,
              fontFamily: FONTS.mono,
              fontSize: 20,
              lineHeight: 1.45,
              padding: '28px 30px 26px',
              position: 'relative',
            }}
          >
            {/* Header */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                paddingBottom: 16,
                borderBottom: `1.5px dashed ${THERMAL.dash}`,
              }}
            >
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: '-0.04em',
                  color: THERMAL.ink,
                }}
              >
                {headerBrand}
              </span>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: THERMAL.muted,
                }}
              >
                {headerSub}
              </span>
              {(metaLeft || metaRight) && (
                <div
                  style={{
                    width: '100%',
                    marginTop: 10,
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 16,
                    color: THERMAL.muted,
                  }}
                >
                  <span>{metaLeft}</span>
                  <span>{metaRight}</span>
                </div>
              )}
            </div>

            {/* Receipt content rows */}
            <div>{children}</div>

            {/* Footer */}
            {(footerRight || showBarcode) && (
              <div
                style={{
                  paddingTop: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {footerRight && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      fontSize: 17,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                    }}
                  >
                    <span style={{color: THERMAL.muted}}>{footerLeft}</span>
                    <strong
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 20,
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                        color: footerToneColor,
                        textTransform: 'none',
                      }}
                    >
                      {footerRight}
                    </strong>
                  </div>
                )}

                {footerSub && (
                  <div
                    style={{
                      fontSize: 15,
                      textAlign: 'center',
                      color: THERMAL.muted,
                    }}
                  >
                    {footerSub}
                  </div>
                )}

                {showBarcode && (
                  <div
                    style={{
                      height: 34,
                      margin: '4px 18px 0',
                      opacity: 0.82,
                      background: `repeating-linear-gradient(90deg, ${THERMAL.ink} 0 3px, transparent 3px 6px, ${THERMAL.ink} 6px 8px, transparent 8px 12px, ${THERMAL.ink} 12px 16px, transparent 16px 18px, ${THERMAL.ink} 18px 20px, transparent 20px 26px)`,
                    }}
                  />
                )}
              </div>
            )}

            {/* Optional rubber stamp overlay */}
            {stampText && (
              <div
                style={{
                  position: 'absolute',
                  right: 26,
                  top: 112,
                  rotate: '-8deg',
                  fontFamily: FONTS.sans,
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: '0.13em',
                  textTransform: 'uppercase',
                  color: stampColor,
                  border: `3px solid ${stampColor}`,
                  borderRadius: 8,
                  padding: '5px 14px',
                  backgroundColor: 'rgba(251, 250, 246, 0.86)',
                  opacity: clampProgress(frame, stampStart, stampStart + 6, EASE.out) * 0.94,
                  scale: interpolate(stampP, [0, 1], [1.45, 1]),
                }}
              >
                {stampText}
              </div>
            )}
          </div>

          <SerratedBottomEdge width={paperWidth} fill={THERMAL.paper} />
        </div>
      </div>
    </Interactive.Div>
  );
};

export const ReceiptRow: React.FC<
  React.PropsWithChildren<{
    index?: string;
    label: string;
    delay?: number;
    last?: boolean;
    style?: React.CSSProperties;
  }>
> = ({index, label, delay = 0, last = false, style, children}) => {
  const frame = useCurrentFrame();
  const p = delay > 0 ? clampProgress(frame, delay, delay + 14, EASE.out) : 1;

  return (
    <div
      style={{
        padding: '15px 0',
        borderBottom: last ? 'none' : `1.5px dashed ${THERMAL.dash}`,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [8, 0])}px`,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 15,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: THERMAL.muted,
          marginBottom: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {index && (
          <span style={{fontWeight: 700, color: THERMAL.ink}}>{index}</span>
        )}
        <span>{label}</span>
      </div>
      <div>{children}</div>
    </div>
  );
};

// ============================================================================
// ConfidenceBar — Wilson 95% CI horizontal bar with animated readout & whiskers
// ============================================================================

export const ConfidenceBar: React.FC<{
  label: string;
  value: number;
  ciLow: number;
  ciHigh: number;
  sampleSize?: number;
  tone?: Tone;
  theme?: ThemeName;
  onThermal?: boolean;
  delay?: number;
  duration?: number;
  style?: React.CSSProperties;
}> = ({
  label,
  value,
  ciLow,
  ciHigh,
  sampleSize,
  tone = 'cobalt',
  theme = 'light',
  onThermal = false,
  delay = 0,
  duration = 26,
  style,
}) => {
  const frame = useCurrentFrame();
  const p = clampProgress(frame, delay, delay + duration, EASE.editorial);
  const valueReveal =
    delay > 0 ? clampProgress(frame, delay, delay + 8, EASE.out) : 1;
  const ciReveal =
    delay > 0
      ? clampProgress(
          frame,
          delay + Math.round(duration * 0.45),
          delay + duration,
          EASE.out,
        )
      : 1;
  const t = THEMES[theme];
  const colors = getToneColors(tone, onThermal ? 'light' : theme);

  const animatedValue = Math.round(interpolate(p, [0, 1], [0, value]));
  const clampedLow = Math.max(0, Math.min(100, ciLow));
  const clampedHigh = Math.max(clampedLow, Math.min(100, ciHigh));
  const clampedVal = Math.max(0, Math.min(100, value));

  const labelColor = onThermal ? THERMAL.ink : t.ink;
  const mutedColor = onThermal ? THERMAL.muted : t.muted;
  const trackColor = onThermal
    ? 'rgba(43, 42, 39, 0.12)'
    : t.isDark
      ? 'rgba(255, 255, 255, 0.12)'
      : 'rgba(0, 0, 0, 0.08)';

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 8, ...style}}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: onThermal ? FONTS.mono : FONTS.sans,
            fontSize: onThermal ? 19 : 22,
            fontWeight: 600,
            color: labelColor,
          }}
        >
          {label}
        </span>

        <div style={{display: 'flex', alignItems: 'baseline', gap: 10}}>
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: onThermal ? 16 : 18,
              color: mutedColor,
              fontVariantNumeric: 'tabular-nums',
              opacity: ciReveal,
            }}
          >
            95% CI {ciLow}%–{ciHigh}%
            {sampleSize !== undefined ? ` (n=${sampleSize})` : ''}
          </span>
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: onThermal ? 24 : 28,
              fontWeight: 700,
              color: colors.fg,
              fontVariantNumeric: 'tabular-nums',
              minWidth: 64,
              textAlign: 'right',
              opacity: valueReveal,
            }}
          >
            {animatedValue}%
          </span>
        </div>
      </div>

      {/* Track + CI range band + point estimate marker */}
      <div
        style={{
          position: 'relative',
          height: 14,
          borderRadius: RADII.pill,
          backgroundColor: trackColor,
          overflow: 'visible',
        }}
      >
        {/* Solid fill to point estimate */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${clampedVal * p}%`,
            borderRadius: RADII.pill,
            backgroundColor: colors.accent,
            opacity: 0.28,
          }}
        />

        {/* Wilson CI whisker interval */}
        <div
          style={{
            position: 'absolute',
            left: `${clampedLow * p}%`,
            width: `${Math.max(1.5, (clampedHigh - clampedLow) * p)}%`,
            top: 3,
            bottom: 3,
            borderRadius: RADII.pill,
            backgroundColor: colors.accent,
            opacity: 0.9,
          }}
        />

        {/* Point estimate dot */}
        <div
          style={{
            position: 'absolute',
            left: `${clampedVal * p}%`,
            top: '50%',
            width: 18,
            height: 18,
            marginLeft: -9,
            marginTop: -9,
            borderRadius: RADII.pill,
            backgroundColor: colors.accent,
            border: `3px solid ${onThermal ? THERMAL.paper : t.bg}`,
          }}
        />
      </div>
    </div>
  );
};

// ============================================================================
// StrikeMark — Animated crimson slash across fake scores or ephemeral items
// ============================================================================

export const StrikeMark: React.FC<{
  startFrame: number;
  duration?: number;
  color?: string;
  thickness?: number;
  angleDeg?: number;
  style?: React.CSSProperties;
}> = ({
  startFrame,
  duration = 14,
  color = PALETTE.signal,
  thickness = 7,
  angleDeg = -5,
  style,
}) => {
  const frame = useCurrentFrame();
  const draw = clampProgress(frame, startFrame, startFrame + duration, EASE.snappy);

  return (
    <div
      style={{
        position: 'absolute',
        left: '-4%',
        right: '-4%',
        top: '50%',
        height: thickness,
        marginTop: -thickness / 2,
        borderRadius: RADII.pill,
        backgroundColor: color,
        rotate: `${angleDeg}deg`,
        transform: `scaleX(${draw})`,
        transformOrigin: 'left center',
        pointerEvents: 'none',
        ...style,
      }}
    />
  );
};

// ============================================================================
// AnimatedCounter — Frame-driven tabular numeric stat counter
// ============================================================================

export const AnimatedCounter: React.FC<{
  from?: number;
  to: number;
  startFrame?: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  locale?: boolean;
  style?: React.CSSProperties;
}> = ({
  from = 0,
  to,
  startFrame = 0,
  duration = 28,
  prefix = '',
  suffix = '',
  decimals = 0,
  locale = true,
  style,
}) => {
  const frame = useCurrentFrame();
  const p = clampProgress(frame, startFrame, startFrame + duration, EASE.editorial);
  const raw = interpolate(p, [0, 1], [from, to]);
  const formatted =
    decimals > 0
      ? raw.toFixed(decimals)
      : locale
        ? Math.round(raw).toLocaleString('en-US')
        : String(Math.round(raw));

  return (
    <span
      style={{
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
};
