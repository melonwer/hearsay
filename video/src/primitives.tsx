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
  LAYOUT,
  PALETTE,
  RADII,
  SAFE,
  SHADOWS,
  THEMES,
  THERMAL,
  clampProgress,
  exitEnvelope,
  getToneColors,
  type ThemeName,
  type Tone,
} from './design';

// ============================================================================
// BrandMark — Editorial favicon square + tight-tracked Hearsay wordmark
// ============================================================================

export const BrandMark: React.FC<{
  theme?: ThemeName;
  size?: 'sm' | 'md' | 'lg' | 'hero';
  style?: React.CSSProperties;
}> = ({theme = 'light', size = 'md', style}) => {
  const t = THEMES[theme];
  const dims =
    size === 'sm'
      ? {box: 28, boxFont: 19, label: 22, gap: 10, radius: 7}
      : size === 'hero'
        ? {box: 82, boxFont: 54, label: 112, gap: 28, radius: 22}
        : size === 'lg'
          ? {box: 48, boxFont: 32, label: 40, gap: 16, radius: 13}
          : {box: 36, boxFont: 24, label: 28, gap: 12, radius: 10};

  return (
    <Interactive.Div
      name="Hearsay brand mark"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
        fontFamily: FONTS.sans,
        fontSize: dims.label,
        fontWeight: 700,
        lineHeight: 0.96,
        letterSpacing: size === 'hero' ? '-0.055em' : '-0.036em',
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
          flexShrink: 0,
        }}
      >
        h
      </span>
      <span>Hearsay</span>
    </Interactive.Div>
  );
};

// ============================================================================
// SceneTransition — Clean frame-driven entrance & exit envelope
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
  enterShiftY = 16,
  exitScale = 0.994,
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
// SceneCanvas — Pure borderless Apple-keynote 1920x1080 editorial stage
// Zero top chrome, zero scene counters, zero gridlines, zero footers.
// ============================================================================

export const SceneCanvas: React.FC<
  React.PropsWithChildren<{
    theme?: ThemeName;
    duration?: number;
    showCornerMark?: boolean;
    showAmbient?: boolean;
    fadeInFrames?: number;
    fadeOutFrames?: number;
  }>
> = ({
  theme = 'light',
  duration,
  showCornerMark = false,
  showAmbient = true,
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
      {showAmbient && (
        <AbsoluteFill
          style={{background: t.ambientGlow, pointerEvents: 'none'}}
        />
      )}

      <AbsoluteFill style={{opacity: contentOpacity}}>{children}</AbsoluteFill>

      {showCornerMark && (
        <div
          style={{
            position: 'absolute',
            left: SAFE.x,
            top: 48,
            opacity: 0.42,
            pointerEvents: 'none',
          }}
        >
          <BrandMark theme={theme} size="sm" />
        </div>
      )}
    </AbsoluteFill>
  );
};

// ============================================================================
// KineticHeadline — Masked line-by-line upward display reveal (76-104px)
// Accepts strings or inline React nodes (e.g. StrikeInline inside a line).
// ============================================================================

export const KineticHeadline: React.FC<{
  lines: readonly React.ReactNode[];
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
  size = 84,
  align = 'left',
  delay = 4,
  stagger = 8,
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
            key={i}
            style={{
              overflow: 'hidden',
              paddingBottom: '0.12em',
              marginBottom: '-0.12em',
            }}
          >
            <div
              style={{
                color: isAccented ? (accentColor ?? t.cobalt) : t.ink,
                opacity: clampProgress(frame, start, start + 14, EASE.out),
                translate: `0px ${interpolate(p, [0, 1], [size * 0.9, 0])}px`,
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
// EditorialText — Effortless readable body, lede, or punchline copy (24-34px)
// ============================================================================

export const EditorialText: React.FC<
  React.PropsWithChildren<{
    theme?: ThemeName;
    size?: number;
    weight?: 400 | 500 | 600 | 700;
    muted?: boolean;
    color?: string;
    delay?: number;
    maxWidth?: number;
    align?: 'left' | 'center';
    style?: React.CSSProperties;
  }>
> = ({
  theme = 'light',
  size = 30,
  weight = 400,
  muted = true,
  color,
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
    <Interactive.Div
      name="Editorial text"
      style={{
        fontFamily: FONTS.sans,
        fontSize: size,
        fontWeight: weight,
        lineHeight: 1.38,
        letterSpacing: weight >= 600 ? '-0.022em' : '-0.015em',
        color: color ?? (muted ? t.muted : t.ink),
        maxWidth,
        textAlign: align,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [16, 0])}px`,
        ...style,
      }}
    >
      {children}
    </Interactive.Div>
  );
};

// ============================================================================
// Pill — Quiet Apple status / citation / milestone pill
// ============================================================================

export const Pill: React.FC<{
  label: string;
  tone?: Tone;
  theme?: ThemeName;
  dot?: boolean;
  mono?: boolean;
  delay?: number;
  size?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
}> = ({
  label,
  tone = 'cobalt',
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

  const dims =
    size === 'sm'
      ? {pad: '7px 16px', fontSize: 20, gap: 8, dotSize: 8}
      : size === 'lg'
        ? {pad: '12px 24px', fontSize: 24, gap: 11, dotSize: 10}
        : {pad: '9px 20px', fontSize: 22, gap: 9, dotSize: 9};

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
        padding: dims.pad,
        borderRadius: RADII.pill,
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.fg,
        fontFamily: mono ? FONTS.mono : FONTS.sans,
        fontSize: dims.fontSize,
        fontWeight: 600,
        lineHeight: 1.2,
        letterSpacing: mono ? '-0.01em' : '-0.014em',
        whiteSpace: 'nowrap',
        opacity:
          delay > 0 ? clampProgress(frame, delay, delay + 10, EASE.out) : 1,
        scale: delay > 0 ? interpolate(p, [0, 1], [0.92, 1]) : 1,
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: dims.dotSize,
            height: dims.dotSize,
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
// EditorialCard — Clean borderless-feel floating card (no macOS clutter)
// ============================================================================

export const EditorialCard: React.FC<
  React.PropsWithChildren<{
    theme?: ThemeName;
    delay?: number;
    width?: number | string;
    padding?: number | string;
    name?: string;
    style?: React.CSSProperties;
  }>
> = ({
  theme = 'light',
  delay = 0,
  width = LAYOUT.cardWidth,
  padding = '36px 40px',
  name = 'Editorial card',
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const t = THEMES[theme];
  const p =
    delay > 0 ? clampProgress(frame, delay, delay + 22, EASE.editorial) : 1;

  return (
    <Interactive.Div
      name={name}
      style={{
        width,
        padding,
        borderRadius: RADII.card,
        backgroundColor: t.isDark ? PALETTE.nightCard : PALETTE.paper,
        border: `1px solid ${t.isDark ? PALETTE.nightHairStrong : PALETTE.hair}`,
        boxShadow: t.isDark ? SHADOWS.cardDark : SHADOWS.cardLight,
        opacity:
          delay > 0 ? clampProgress(frame, delay, delay + 14, EASE.out) : 1,
        translate: `0px ${delay > 0 ? interpolate(p, [0, 1], [24, 0]) : 0}px`,
        scale: delay > 0 ? interpolate(p, [0, 1], [0.98, 1]) : 1,
        ...style,
      }}
    >
      {children}
    </Interactive.Div>
  );
};

// ============================================================================
// CommandPill — Sleek dark/light terminal pill with deterministic typing
// ============================================================================

export const CommandPill: React.FC<{
  command: string;
  prefix?: string;
  startFrame?: number;
  charsPerFrame?: number;
  typing?: boolean;
  fontSize?: number;
  theme?: 'dark' | 'light';
  showCursor?: boolean;
  enterDelay?: number;
  style?: React.CSSProperties;
}> = ({
  command,
  prefix = '$',
  startFrame = 0,
  charsPerFrame = 1.25,
  typing = true,
  fontSize = 28,
  theme = 'dark',
  showCursor = true,
  enterDelay = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const visibleChars = typing
    ? Math.min(command.length, Math.floor(elapsed * charsPerFrame))
    : command.length;
  const typed = command.slice(0, visibleChars);
  const doneTyping = visibleChars >= command.length;
  const cursorVisible =
    showCursor && (!doneTyping || Math.floor(elapsed / 14) % 2 === 0);

  const enterP =
    enterDelay > 0
      ? clampProgress(frame, enterDelay, enterDelay + 18, EASE.editorial)
      : 1;
  const isDark = theme === 'dark';

  return (
    <Interactive.Div
      name="Command pill"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 16,
        padding: '22px 34px',
        borderRadius: RADII.panel,
        backgroundColor: isDark ? '#141416' : PALETTE.mist,
        border: `1px solid ${isDark ? 'rgba(255, 255, 255, 0.14)' : PALETTE.hairStrong}`,
        boxShadow: isDark ? SHADOWS.pillDark : SHADOWS.pillLight,
        fontFamily: FONTS.mono,
        fontSize,
        fontWeight: 500,
        lineHeight: 1.35,
        letterSpacing: '-0.015em',
        color: isDark ? PALETTE.nightInk : PALETTE.ink,
        opacity:
          enterDelay > 0
            ? clampProgress(frame, enterDelay, enterDelay + 12, EASE.out)
            : 1,
        translate: `0px ${enterDelay > 0 ? interpolate(enterP, [0, 1], [16, 0]) : 0}px`,
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
              width: Math.max(10, Math.round(fontSize * 0.44)),
              height: Math.round(fontSize * 1.04),
              marginLeft: 5,
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
// ThermalReceipt, ReceiptRow & ReceiptStamp — Signature Hearsay thermal paper
// ============================================================================

const SerratedBottomEdge: React.FC<{width: number; fill: string}> = ({
  width,
  fill,
}) => {
  const toothW = 18;
  const toothH = 12;
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

export const ReceiptStamp: React.FC<{
  text: string;
  startFrame: number;
  tone?: 'signal' | 'emerald' | 'cobalt';
  rotateDeg?: number;
  style?: React.CSSProperties;
}> = ({text, startFrame, tone = 'signal', rotateDeg = -8, style}) => {
  const frame = useCurrentFrame();
  const pop = clampProgress(frame, startFrame, startFrame + 12, EASE.pop);
  const fade = clampProgress(frame, startFrame, startFrame + 5, EASE.out);
  const color =
    tone === 'emerald'
      ? THERMAL.stampEmerald
      : tone === 'cobalt'
        ? THERMAL.stampCobalt
        : THERMAL.stampSignal;

  return (
    <div
      style={{
        display: 'inline-block',
        rotate: `${rotateDeg}deg`,
        fontFamily: FONTS.sans,
        fontSize: 22,
        fontWeight: 700,
        letterSpacing: '0.13em',
        textTransform: 'uppercase',
        color,
        border: `3px solid ${color}`,
        borderRadius: 8,
        padding: '4px 14px',
        backgroundColor: 'rgba(251, 250, 246, 0.90)',
        opacity: fade * 0.94,
        scale: interpolate(pop, [0, 1], [1.42, 1]),
        pointerEvents: 'none',
        ...style,
      }}
    >
      {text}
    </div>
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
    stampTop?: number;
    theme?: ThemeName;
    style?: React.CSSProperties;
  }>
> = ({
  headerBrand = 'Hearsay',
  headerSub = 'Answer receipt',
  metaLeft,
  metaRight,
  width = LAYOUT.receiptWidth,
  startFrame = 0,
  printDuration = 28,
  showSlot = true,
  showBarcode = false,
  footerLeft = 'Result',
  footerRight,
  footerRightTone = 'signal',
  footerSub = 'Saved locally in SQLite',
  stampText,
  stampTone = 'signal',
  stampFrame,
  stampTop = 190,
  theme = 'dark',
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const feed = clampProgress(
    frame,
    startFrame,
    startFrame + printDuration,
    EASE.editorial,
  );
  const paperWidth = showSlot ? width - 28 : width;

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

      <div
        style={{
          position: 'relative',
          margin: showSlot ? '-8px 14px 0' : 0,
          overflow: 'hidden',
          paddingBottom: 16,
          filter: isDarkBg ? SHADOWS.receiptDark : SHADOWS.receiptLight,
        }}
      >
        <div
          style={{
            position: 'relative',
            translate: `0px ${interpolate(feed, [0, 1], [-110, 0])}px`,
            clipPath: `inset(0 0 ${interpolate(feed, [0, 1], [100, 0])}% 0)`,
            opacity: clampProgress(frame, startFrame, startFrame + 6, EASE.out),
          }}
        >
          <div
            style={{
              background: `${THERMAL.topShade}, ${THERMAL.paper}`,
              color: THERMAL.ink,
              fontFamily: FONTS.mono,
              fontSize: 22,
              lineHeight: 1.45,
              padding: '32px 36px 28px',
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
                paddingBottom: 18,
                borderBottom: `1.5px dashed ${THERMAL.dash}`,
              }}
            >
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 34,
                  fontWeight: 700,
                  letterSpacing: '-0.04em',
                  color: THERMAL.ink,
                }}
              >
                {headerBrand}
              </span>
              <span
                style={{
                  fontSize: 16,
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
                    fontSize: 18,
                    color: THERMAL.muted,
                  }}
                >
                  <span>{metaLeft}</span>
                  <span>{metaRight}</span>
                </div>
              )}
            </div>

            {/* 3 clean plain-English rows */}
            <div>{children}</div>

            {/* Footer */}
            {(footerRight || footerSub || showBarcode) && (
              <div
                style={{
                  paddingTop: 18,
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
                      fontSize: 18,
                      letterSpacing: '0.07em',
                      textTransform: 'uppercase',
                    }}
                  >
                    <span style={{color: THERMAL.muted}}>{footerLeft}</span>
                    <strong
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 22,
                        fontWeight: 700,
                        letterSpacing: '0em',
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
                      fontSize: 16,
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
                      height: 32,
                      margin: '4px 20px 0',
                      opacity: 0.8,
                      background: `repeating-linear-gradient(90deg, ${THERMAL.ink} 0 3px, transparent 3px 6px, ${THERMAL.ink} 6px 8px, transparent 8px 12px, ${THERMAL.ink} 12px 16px, transparent 16px 18px, ${THERMAL.ink} 18px 20px, transparent 20px 26px)`,
                    }}
                  />
                )}
              </div>
            )}

            {/* Optional receipt-level stamp overlay */}
            {stampText && (
              <ReceiptStamp
                text={stampText}
                tone={stampTone}
                startFrame={stampFrame ?? startFrame + printDuration + 10}
                style={{
                  position: 'absolute',
                  right: 32,
                  top: stampTop,
                }}
              />
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
        position: 'relative',
        padding: '20px 0',
        borderBottom: last ? 'none' : `1.5px dashed ${THERMAL.dash}`,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [10, 0])}px`,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 16,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: THERMAL.muted,
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {index && (
          <span style={{fontWeight: 700, color: THERMAL.ink}}>{index}.</span>
        )}
        <span>{label}</span>
      </div>
      <div style={{fontSize: 24, fontWeight: 500, color: THERMAL.ink}}>
        {children}
      </div>
    </div>
  );
};

// ============================================================================
// StrikeInline — Clean inline crimson strikethrough (e.g. "No fake 74/100 score")
// ============================================================================

export const StrikeInline: React.FC<
  React.PropsWithChildren<{
    startFrame: number;
    duration?: number;
    color?: string;
    thickness?: number;
    angleDeg?: number;
    dimAfterStrike?: boolean;
    style?: React.CSSProperties;
  }>
> = ({
  startFrame,
  duration = 14,
  color = PALETTE.signalNight,
  thickness = 6,
  angleDeg = -3,
  dimAfterStrike = true,
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const draw = clampProgress(
    frame,
    startFrame,
    startFrame + duration,
    EASE.snappy,
  );
  const textOpacity = dimAfterStrike ? interpolate(draw, [0, 1], [1, 0.56]) : 1;

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <span style={{opacity: textOpacity}}>{children}</span>
      <span
        style={{
          position: 'absolute',
          left: '-0.05em',
          right: '-0.05em',
          top: '54%',
          height: thickness,
          marginTop: -thickness / 2,
          borderRadius: RADII.pill,
          backgroundColor: color,
          rotate: `${angleDeg}deg`,
          scale: `${draw} 1`,
          transformOrigin: 'left center',
          pointerEvents: 'none',
        }}
      />
    </span>
  );
};

// ============================================================================
// AnimatedCounter — Deterministic tabular numeric stat counter
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
  const p = clampProgress(
    frame,
    startFrame,
    startFrame + duration,
    EASE.editorial,
  );
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
