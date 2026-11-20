import React from 'react';
import {AbsoluteFill, Interactive, interpolate, useCurrentFrame} from 'remotion';
import {
  EASE,
  FONTS,
  PALETTE,
  RADII,
  SAFE,
  SHADOWS,
  THEMES,
  THERMAL,
  cardBorder,
  clampProgress,
  getToneColors,
  springProgress,
  type Tone,
} from '../design';
import {
  AnimatedCounter,
  BrandMark,
  EditorialText,
  EyebrowBadge,
  KineticHeadline,
  MacWindow,
  ReceiptRow,
  SceneCanvas,
  StatusChip,
  TerminalPrompt,
  ThermalReceipt,
} from '../primitives';
import {SCENE_COPY} from '../timeline';

export type Act2SceneProps = {
  duration: number;
};

// ============================================================================
// Scene 4 — HijackScene (Light --paper + Thermal Receipt, 207f / 6.90s)
// SFX cues: +20f paper.mp3 (receipt enters), +114f marker.mp3 (stamp lands)
// ============================================================================

const FUNNEL_STAGES = [
  {
    label: 'Retrieved by web search',
    barPct: 100,
    countTo: 20,
    countSuffix: ' pages retrieved',
    tone: 'cobalt' as const,
    highlighted: false,
    delay: 30,
  },
  {
    label: 'Kept in final answer',
    barPct: 15,
    countTo: 3,
    countSuffix: ' pages cited',
    tone: 'emerald' as const,
    highlighted: false,
    delay: 46,
  },
  {
    label: 'Dropped before answer',
    barPct: 85,
    countTo: 17,
    countSuffix: ' dropped · 85% attrition',
    tone: 'signal' as const,
    highlighted: true,
    delay: 62,
  },
] as const;

export const HijackScene: React.FC<Act2SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const t = THEMES.light;

  const funnelCardP = clampProgress(frame, 22, 42, EASE.editorial);
  const urlHighlightP = clampProgress(frame, 54, 74, EASE.editorial);
  const hijackBadgeP = clampProgress(frame, 74, 88, EASE.pop);

  return (
    <SceneCanvas
      theme="light"
      duration={duration}
      sceneIndex={4}
      fadeInFrames={10}
      fadeOutFrames={10}
      topRight={
        <StatusChip
          label="RETRIEVAL ATTRITION · 85%"
          tone="signal"
          theme="light"
          size="sm"
          mono
          delay={6}
        />
      }
      footnote="Retrieved-but-dropped attrition & own-site hijack forensics"
    >
      <div
        style={{
          position: 'absolute',
          left: SAFE.x,
          right: SAFE.x,
          top: SAFE.topHeader - 4,
          bottom: SAFE.bottom + 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 68,
        }}
      >
        {/* Left column: Headline + Animated Attrition Funnel */}
        <Interactive.Div
          name="Hijack editorial and funnel"
          style={{
            flex: 1,
            maxWidth: 970,
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
            <EyebrowBadge theme="light" tone="signal" delay={2}>
              {SCENE_COPY.hijack.eyebrow}
            </EyebrowBadge>

            <KineticHeadline
              theme="light"
              lines={['85% retrieved.', 'Never cited.']}
              size={84}
              delay={6}
              stagger={7}
              accentLastLine
              accentColor={PALETTE.signal}
            />

            <EditorialText
              theme="light"
              size={25}
              delay={18}
              maxWidth={780}
              style={{marginTop: 4}}
            >
              AI fetches dozens of pages per answer, discards most of them, and
              can cite your own docs while naming a rival.
            </EditorialText>
          </div>

          {/* Attrition Funnel Card */}
          <Interactive.Div
            name="Attrition funnel"
            style={{
              marginTop: 8,
              backgroundColor: PALETTE.mist,
              borderRadius: RADII.card,
              border: cardBorder('light'),
              boxShadow: SHADOWS.cardLight,
              padding: '26px 30px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
              opacity: clampProgress(frame, 22, 34, EASE.out),
              translate: `0px ${interpolate(funnelCardP, [0, 1], [24, 0])}px`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: 12,
                borderBottom: `1px solid ${t.hairline}`,
              }}
            >
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 16,
                  fontWeight: 600,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: t.muted,
                }}
              >
                RETRIEVAL ATTRITION FUNNEL
              </span>
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 16,
                  color: t.muted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                20 URLs fetched · single answer trace
              </span>
            </div>

            {FUNNEL_STAGES.map((stage) => {
              const rowEnter = clampProgress(
                frame,
                stage.delay,
                stage.delay + 14,
                EASE.out,
              );
              const barGrow = clampProgress(
                frame,
                stage.delay + 4,
                stage.delay + 30,
                EASE.editorial,
              );
              const colors = getToneColors(stage.tone, 'light');

              return (
                <div
                  key={stage.label}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    padding: stage.highlighted ? '14px 18px' : '4px 4px',
                    borderRadius: stage.highlighted ? RADII.row : 0,
                    backgroundColor: stage.highlighted
                      ? t.signalSoft
                      : 'transparent',
                    border: stage.highlighted
                      ? `1px solid ${colors.border}`
                      : 'none',
                    opacity: rowEnter,
                    translate: `0px ${interpolate(rowEnter, [0, 1], [12, 0])}px`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      gap: 16,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: FONTS.sans,
                        fontSize: 22,
                        fontWeight: stage.highlighted ? 700 : 600,
                        color: stage.highlighted ? colors.fg : t.ink,
                        letterSpacing: '-0.015em',
                      }}
                    >
                      {stage.label}
                    </span>
                    <AnimatedCounter
                      from={0}
                      to={stage.countTo}
                      startFrame={stage.delay + 4}
                      duration={24}
                      suffix={stage.countSuffix}
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 21,
                        fontWeight: 700,
                        color: colors.fg,
                      }}
                    />
                  </div>

                  {/* Crisp horizontal bar track */}
                  <div
                    style={{
                      position: 'relative',
                      height: stage.highlighted ? 16 : 13,
                      borderRadius: RADII.pill,
                      backgroundColor: 'rgba(0, 0, 0, 0.075)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${stage.barPct * barGrow}%`,
                        borderRadius: RADII.pill,
                        backgroundColor: colors.accent,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </Interactive.Div>
        </Interactive.Div>

        {/* Right column: Tactile Thermal Receipt stamped OWN-SITE HIJACK */}
        <Interactive.Div
          name="Own-site hijack receipt"
          style={{
            width: 656,
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <ThermalReceipt
            theme="light"
            width={656}
            startFrame={20}
            printDuration={28}
            headerBrand="Hearsay"
            headerSub="RETRIEVAL FORENSICS · LIVE SEARCH"
            metaLeft="notewell.io"
            footerLeft="CLASSIFICATION"
            footerRight={SCENE_COPY.hijack.stamp}
            footerRightTone="signal"
            footerSub="Saved locally to SQLite · node:sqlite"
            stampText={SCENE_COPY.hijack.stamp}
            stampTone="signal"
            stampFrame={114}
          >
            <ReceiptRow index="01" label="Source cited" delay={44}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    position: 'relative',
                    display: 'inline-block',
                    padding: '2px 8px',
                    marginLeft: -8,
                    borderRadius: 4,
                    fontWeight: 700,
                    fontSize: 22,
                    color: THERMAL.ink,
                    backgroundImage: `linear-gradient(${THERMAL.highlight}, ${THERMAL.highlight})`,
                    backgroundRepeat: 'no-repeat',
                    backgroundSize: `${Math.round(urlHighlightP * 100)}% 100%`,
                  }}
                >
                  {SCENE_COPY.hijack.hijackUrl}
                </span>
                <span
                  style={{
                    fontSize: 16,
                    color: THERMAL.muted,
                  }}
                >
                  (your site)
                </span>
              </div>
            </ReceiptRow>

            <ReceiptRow index="02" label="Brand recommended" delay={66}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 28,
                    fontWeight: 700,
                    letterSpacing: '-0.025em',
                    color: PALETTE.signal,
                  }}
                >
                  {SCENE_COPY.hijack.hijackRecommended}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 15,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    padding: '4px 10px',
                    borderRadius: 6,
                    color: PALETTE.signal,
                    backgroundColor: 'rgba(215, 0, 21, 0.10)',
                    border: '1px solid rgba(215, 0, 21, 0.28)',
                    opacity: clampProgress(frame, 74, 82, EASE.out),
                    scale: interpolate(hijackBadgeP, [0, 1], [0.88, 1]),
                  }}
                >
                  #1 RIVAL PICK
                </span>
              </div>
            </ReceiptRow>

            <ReceiptRow index="03" label="Forensic verdict" delay={88} last>
              <p
                style={{
                  margin: 0,
                  fontFamily: FONTS.sans,
                  fontSize: 21,
                  fontWeight: 500,
                  lineHeight: 1.4,
                  letterSpacing: '-0.014em',
                  color: THERMAL.ink,
                }}
              >
                &ldquo;Your own page convinced the model to pick a
                competitor.&rdquo;
              </p>
            </ReceiptRow>
          </ThermalReceipt>
        </Interactive.Div>
      </div>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 5 — DeltaScene (Dark --night, 206f / 6.87s)
// SFX cues: +6f whoosh.mp3 (dark cut), +104f click.mp3 (durable domain locks)
// ============================================================================

interface PersistenceRow {
  domain: string;
  badge: string;
  tone: Tone;
  waves: readonly boolean[];
  delay: number;
  badgeDelay: number;
  dimmed?: boolean;
}

const PERSISTENCE_ROWS: readonly PersistenceRow[] = [
  {
    domain: 'g2.com/categories/…',
    badge: 'DURABLE · 4/4 waves',
    tone: 'emerald',
    waves: [true, true, true, true],
    delay: 90,
    badgeDelay: 104,
  },
  {
    domain: 'techradar.com/best/…',
    badge: 'RECURRING · 3/4',
    tone: 'cobalt',
    waves: [true, true, false, true],
    delay: 108,
    badgeDelay: 118,
  },
  {
    domain: 'reddit.com/r/devops/…',
    badge: 'EPHEMERAL · 1/4',
    tone: 'neutral',
    waves: [false, true, false, false],
    delay: 124,
    badgeDelay: 134,
    dimmed: true,
  },
];

export const DeltaScene: React.FC<Act2SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const t = THEMES.dark;

  const leftCardP = clampProgress(frame, 14, 34, EASE.editorial);
  const rightCardP = clampProgress(frame, 22, 42, EASE.editorial);

  // Paired bars (scale 0..50% for honest proportional comparison with explicit axis ticks)
  const offBarP = clampProgress(frame, 30, 62, EASE.editorial);
  const onBarP = clampProgress(frame, 46, 76, EASE.editorial);
  const deltaBadgeP = clampProgress(frame, 76, 94, EASE.pop);
  const guardRailP = clampProgress(frame, 138, 156, EASE.out);

  const axisMax = 50;
  const offWidthPct = (SCENE_COPY.delta.memoryOff / axisMax) * 100 * offBarP;
  const onWidthPct = (SCENE_COPY.delta.memoryOn / axisMax) * 100 * onBarP;
  const lostLeftPct = (SCENE_COPY.delta.memoryOn / axisMax) * 100;
  const lostSpanPct =
    ((SCENE_COPY.delta.memoryOff - SCENE_COPY.delta.memoryOn) / axisMax) *
    100 *
    clampProgress(frame, 66, 86, EASE.editorial);

  return (
    <SceneCanvas
      theme="dark"
      duration={duration}
      sceneIndex={5}
      fadeInFrames={10}
      fadeOutFrames={10}
      topRight={
        <StatusChip
          label="PAIRED DELTA · 4 WAVES"
          tone="cobalt"
          theme="dark"
          size="sm"
          mono
          delay={6}
        />
      }
      footnote="Paired search=off vs. search=on deltas · 4-wave persistence filter"
    >
      <div
        style={{
          position: 'absolute',
          left: SAFE.x,
          right: SAFE.x,
          top: SAFE.topHeader - 8,
          bottom: SAFE.bottom + 8,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        {/* Top editorial headline row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 48,
          }}
        >
          <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <EyebrowBadge theme="dark" tone="cobalt" delay={2}>
              {SCENE_COPY.delta.eyebrow}
            </EyebrowBadge>
            <KineticHeadline
              theme="dark"
              lines={['Separate memory', 'from live search.']}
              size={74}
              delay={6}
              stagger={7}
              accentLastLine
              accentColor={PALETTE.cobaltNight}
            />
          </div>

          <EditorialText
            theme="dark"
            size={23}
            delay={16}
            maxWidth={510}
            style={{paddingBottom: 6}}
          >
            Isolate what model weights remember from what live retrieval
            overwrites—then trust only sources that persist across waves.
          </EditorialText>
        </div>

        {/* Two side-by-side dark forensic cards */}
        <div
          style={{
            display: 'flex',
            gap: 32,
            flex: 1,
            minHeight: 0,
            marginTop: 28,
          }}
        >
          {/* Left Card: Memory vs. Live Search Delta */}
          <Interactive.Div
            name="Memory vs Live Search card"
            style={{
              flex: 1,
              backgroundColor: PALETTE.nightCard,
              borderRadius: RADII.card,
              border: cardBorder('dark'),
              boxShadow: SHADOWS.cardDark,
              padding: '30px 34px',
              display: 'flex',
              flexDirection: 'column',
              opacity: clampProgress(frame, 14, 26, EASE.out),
              translate: `0px ${interpolate(leftCardP, [0, 1], [28, 0])}px`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 16,
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 30,
                    fontWeight: 700,
                    letterSpacing: '-0.028em',
                    color: t.ink,
                  }}
                >
                  Memory vs. Live Search Delta
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: FONTS.mono,
                    fontSize: 18,
                    color: t.muted,
                  }}
                >
                  Strictly paired · {SCENE_COPY.delta.memoryModel}
                </div>
              </div>
              <StatusChip
                label="PAIRED RUN"
                tone="cobalt"
                theme="dark"
                size="sm"
                mono
                dot={false}
                delay={22}
              />
            </div>

            {/* Paired comparison bars */}
            <div
              style={{
                marginTop: 36,
                display: 'flex',
                flexDirection: 'column',
                gap: 28,
              }}
            >
              {/* Row A: search=off (Memory) */}
              <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                  }}
                >
                  <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 19,
                        fontWeight: 600,
                        padding: '4px 12px',
                        borderRadius: 8,
                        backgroundColor: t.cobaltSoft,
                        border: '1px solid rgba(41, 151, 255, 0.34)',
                        color: PALETTE.cobaltNight,
                      }}
                    >
                      search=off
                    </span>
                    <span
                      style={{
                        fontFamily: FONTS.sans,
                        fontSize: 23,
                        fontWeight: 600,
                        color: t.ink,
                      }}
                    >
                      (Memory)
                    </span>
                  </div>
                  <AnimatedCounter
                    from={0}
                    to={SCENE_COPY.delta.memoryOff}
                    startFrame={30}
                    duration={32}
                    suffix="%"
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 44,
                      fontWeight: 700,
                      letterSpacing: '-0.03em',
                      color: PALETTE.cobaltNight,
                    }}
                  />
                </div>

                <div
                  style={{
                    position: 'relative',
                    height: 18,
                    borderRadius: RADII.pill,
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${offWidthPct}%`,
                      borderRadius: RADII.pill,
                      backgroundColor: PALETTE.cobaltNight,
                    }}
                  />
                </div>
              </div>

              {/* Row B: search=on (Grounded) */}
              <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                  }}
                >
                  <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 19,
                        fontWeight: 600,
                        padding: '4px 12px',
                        borderRadius: 8,
                        backgroundColor: t.signalSoft,
                        border: '1px solid rgba(255, 69, 58, 0.36)',
                        color: PALETTE.signalNight,
                      }}
                    >
                      search=on
                    </span>
                    <span
                      style={{
                        fontFamily: FONTS.sans,
                        fontSize: 23,
                        fontWeight: 600,
                        color: t.ink,
                      }}
                    >
                      (Grounded)
                    </span>
                  </div>
                  <AnimatedCounter
                    from={0}
                    to={SCENE_COPY.delta.memoryOn}
                    startFrame={46}
                    duration={30}
                    suffix="%"
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 44,
                      fontWeight: 700,
                      letterSpacing: '-0.03em',
                      color: PALETTE.signalNight,
                    }}
                  />
                </div>

                <div
                  style={{
                    position: 'relative',
                    height: 18,
                    borderRadius: RADII.pill,
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    overflow: 'hidden',
                  }}
                >
                  {/* Ghost displaced band showing −31pp drop */}
                  <div
                    style={{
                      position: 'absolute',
                      left: `${lostLeftPct}%`,
                      top: 2,
                      bottom: 2,
                      width: `${lostSpanPct}%`,
                      borderRadius: RADII.pill,
                      backgroundImage:
                        'repeating-linear-gradient(-45deg, rgba(255, 69, 58, 0.26) 0 6px, rgba(255, 69, 58, 0.08) 6px 12px)',
                      border: '1px dashed rgba(255, 69, 58, 0.45)',
                    }}
                  />
                  {/* Grounded solid bar */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${onWidthPct}%`,
                      borderRadius: RADII.pill,
                      backgroundColor: PALETTE.signalNight,
                    }}
                  />
                </div>

                {/* Honest axis scale ticks */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: FONTS.mono,
                    fontSize: 15,
                    color: t.muted,
                    fontVariantNumeric: 'tabular-nums',
                    marginTop: 2,
                  }}
                >
                  <span>0%</span>
                  <span>25%</span>
                  <span>50% mention rate</span>
                </div>
              </div>
            </div>

            {/* Vivid −31pp delta callout badge */}
            <div
              style={{
                marginTop: 'auto',
                padding: '18px 22px',
                borderRadius: RADII.panel,
                backgroundColor: t.signalSoft,
                border: '1px solid rgba(255, 69, 58, 0.36)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                opacity: clampProgress(frame, 76, 86, EASE.out),
                scale: interpolate(deltaBadgeP, [0, 1], [0.94, 1]),
              }}
            >
              <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 23,
                    fontWeight: 700,
                    color: PALETTE.signalNight,
                    letterSpacing: '-0.015em',
                  }}
                >
                  −31pp displaced by search
                </span>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 18,
                    color: t.ink,
                    opacity: 0.85,
                  }}
                >
                  Weights know your brand; live search results crowd you out.
                </span>
              </div>
            </div>
          </Interactive.Div>

          {/* Right Card: Multi-Wave Citation Persistence (4 waves) */}
          <Interactive.Div
            name="Multi-wave citation persistence card"
            style={{
              flex: 1,
              backgroundColor: PALETTE.nightCard,
              borderRadius: RADII.card,
              border: cardBorder('dark'),
              boxShadow: SHADOWS.cardDark,
              padding: '30px 34px',
              display: 'flex',
              flexDirection: 'column',
              opacity: clampProgress(frame, 22, 34, EASE.out),
              translate: `0px ${interpolate(rightCardP, [0, 1], [28, 0])}px`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 16,
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 30,
                    fontWeight: 700,
                    letterSpacing: '-0.028em',
                    color: t.ink,
                  }}
                >
                  Multi-Wave Citation Persistence
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: FONTS.mono,
                    fontSize: 18,
                    color: t.muted,
                  }}
                >
                  4 weekly waves · refusing single-wave noise
                </div>
              </div>
              <StatusChip
                label="4 WAVES"
                tone="emerald"
                theme="dark"
                size="sm"
                mono
                dot={false}
                delay={28}
              />
            </div>

            {/* Structured source persistence rows */}
            <div
              style={{
                marginTop: 24,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              {PERSISTENCE_ROWS.map((row) => {
                const rowP = clampProgress(
                  frame,
                  row.delay,
                  row.delay + 16,
                  EASE.editorial,
                );
                const colors = getToneColors(row.tone, 'dark');
                const isDurable = row.tone === 'emerald';

                return (
                  <div
                    key={row.domain}
                    style={{
                      padding: '16px 20px',
                      borderRadius: RADII.panel,
                      backgroundColor: isDurable
                        ? 'rgba(48, 209, 88, 0.06)'
                        : PALETTE.nightElevated,
                      border: `1px solid ${
                        isDurable ? 'rgba(48, 209, 88, 0.30)' : PALETTE.nightHair
                      }`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      opacity: rowP * (row.dimmed ? 0.72 : 1),
                      translate: `0px ${interpolate(rowP, [0, 1], [16, 0])}px`,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 21,
                          fontWeight: isDurable ? 600 : 500,
                          color: row.dimmed ? t.muted : t.ink,
                          letterSpacing: '-0.015em',
                        }}
                      >
                        {row.domain}
                      </span>
                      <StatusChip
                        label={row.badge}
                        tone={row.tone}
                        theme="dark"
                        size="sm"
                        mono
                        delay={row.badgeDelay}
                      />
                    </div>

                    {/* 4-wave presence matrix */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                        {row.waves.map((present, wIdx) => {
                          const pipDelay = row.delay + 6 + wIdx * 4;
                          const pipP = clampProgress(
                            frame,
                            pipDelay,
                            pipDelay + 10,
                            EASE.snappy,
                          );
                          return (
                            <div
                              key={wIdx}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '4px 10px',
                                borderRadius: 8,
                                backgroundColor: present
                                  ? colors.bg
                                  : 'rgba(255, 255, 255, 0.04)',
                                border: `1px solid ${
                                  present ? colors.border : PALETTE.nightHair
                                }`,
                                opacity: pipP,
                                scale: interpolate(pipP, [0, 1], [0.85, 1]),
                              }}
                            >
                              <span
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: RADII.pill,
                                  backgroundColor: present
                                    ? colors.accent
                                    : 'rgba(255, 255, 255, 0.18)',
                                }}
                              />
                              <span
                                style={{
                                  fontFamily: FONTS.mono,
                                  fontSize: 14,
                                  fontWeight: 500,
                                  color: present ? colors.fg : t.muted,
                                }}
                              >
                                W{wIdx + 1}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 15,
                          color: t.muted,
                        }}
                      >
                        {row.dimmed ? 'Churned noise' : 'Observed in citations'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Bottom methodology guardrail */}
            <div
              style={{
                marginTop: 'auto',
                paddingTop: 18,
                borderTop: `1px solid ${PALETTE.nightHair}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                opacity: guardRailP,
                translate: `0px ${interpolate(guardRailP, [0, 1], [10, 0])}px`,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: RADII.pill,
                    backgroundColor: PALETTE.emeraldNight,
                  }}
                />
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 19,
                    fontWeight: 600,
                    color: t.ink,
                  }}
                >
                  Single-wave noise automatically refused
                </span>
              </div>
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 16,
                  color: t.muted,
                }}
              >
                Action threshold ≥ 3/4
              </span>
            </div>
          </Interactive.Div>
        </div>
      </div>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 6 — WorkbenchScene (Mist --mist + Dark MacWindow, 207f / 6.90s)
// SFX cues: +14f paper.mp3 (window settles), +116f click.mp3 (chips lock)
// ============================================================================

const SIDEBAR_NAV = [
  {label: 'Overview', route: '/', active: false},
  {label: 'Site X-Ray', route: '/check', active: true},
  {label: 'Answers', route: '/answers', active: false},
  {label: 'Evidence', route: '/evidence', active: false},
  {label: 'Opportunities', route: '/opps', active: false},
] as const;

const XRAY_CHECK_ROWS = [
  {
    name: 'AI Crawler Access (18/18)',
    detail: 'OAI-SearchBot · Claude-SearchBot · PerplexityBot',
    status: 'PASS',
    delay: 54,
  },
  {
    name: 'Bot vs. Human Prose Parity',
    detail: '1,097 / 1,167 words · 0 missing headings',
    status: 'PASS',
    delay: 66,
  },
  {
    name: 'Structured Spec & Pricing Tables',
    detail: 'Plain HTML tables + JSON-LD verified',
    status: 'PASS',
    delay: 78,
  },
] as const;

const CAPABILITY_CHIPS = [
  {
    title: '46 MCP Tools',
    subtitle: 'Codex · Claude Code · Antigravity',
    tone: 'cobalt' as const,
    monoSub: false,
    delay: 116,
  },
  {
    title: 'BYOK + $0 CLIs',
    subtitle: 'APIs · DataForSEO · Local SQLite',
    tone: 'emerald' as const,
    monoSub: false,
    delay: 124,
  },
  {
    title: 'Hard USD Cap',
    subtitle: 'HEARSAY_MONTHLY_USD_CAP',
    tone: 'amber' as const,
    monoSub: true,
    delay: 132,
  },
] as const;

// Deterministic SQLite drift sparkline coordinates (820 x 114)
const SPARKLINE_POINTS = [
  {x: 18, y: 98, label: 'W1'},
  {x: 174, y: 96, label: 'W2'},
  {x: 330, y: 58, label: 'W3'},
  {x: 486, y: 34, label: 'W4'},
  {x: 642, y: 22, label: 'W5'},
  {x: 798, y: 16, label: 'W6'},
] as const;

const SPARKLINE_PATH = SPARKLINE_POINTS.map(
  (pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`,
).join(' ');

const SPARKLINE_AREA = `${SPARKLINE_PATH} L ${
  SPARKLINE_POINTS[SPARKLINE_POINTS.length - 1].x
} 110 L ${SPARKLINE_POINTS[0].x} 110 Z`;

export const WorkbenchScene: React.FC<Act2SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const t = THEMES.mist;

  const sparkDrawP = clampProgress(frame, 40, 92, EASE.editorial);
  const localBadgeP = clampProgress(frame, 30, 46, EASE.out);
  const pathLength = 860;

  return (
    <SceneCanvas
      theme="mist"
      duration={duration}
      sceneIndex={6}
      fadeInFrames={10}
      fadeOutFrames={10}
      topRight={
        <StatusChip
          label="LOCALHOST · 46 MCP TOOLS"
          tone="cobalt"
          theme="mist"
          size="sm"
          mono
          delay={6}
        />
      }
      footnote="Local SQLite workbench · 46 MCP tools · zero telemetry"
    >
      <div
        style={{
          position: 'absolute',
          left: SAFE.x,
          right: SAFE.x,
          top: SAFE.topHeader - 14,
          bottom: SAFE.bottom + 30,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 22,
        }}
      >
        {/* Top Stage: Left Editorial Column + Right Dark MacWindow */}
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            gap: 44,
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* Left Editorial Rail */}
          <Interactive.Div
            name="Workbench editorial header"
            style={{
              width: 448,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 16,
            }}
          >
            <EyebrowBadge
              theme="mist"
              tone="cobalt"
              delay={2}
              style={{whiteSpace: 'nowrap'}}
            >
              06 · LOCAL WORKBENCH &amp; MCP
            </EyebrowBadge>

            <KineticHeadline
              theme="mist"
              lines={['Local workbench.', 'Zero telemetry.']}
              size={62}
              delay={6}
              stagger={7}
              accentLastLine
              accentColor={PALETTE.cobalt}
            />

            <EditorialText theme="mist" size={23} delay={18}>
              Inspect crawlability live at localhost, track weekly SQLite drift,
              and hand 46 MCP tools directly to your coding agent.
            </EditorialText>

            {/* Local SQLite daemon indicator card */}
            <div
              style={{
                marginTop: 14,
                padding: '18px 20px',
                borderRadius: RADII.panel,
                backgroundColor: PALETTE.paper,
                border: cardBorder('mist'),
                boxShadow: SHADOWS.cardLight,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                opacity: localBadgeP,
                translate: `0px ${interpolate(localBadgeP, [0, 1], [14, 0])}px`,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: RADII.pill,
                    backgroundColor: PALETTE.emerald,
                  }}
                />
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 20,
                    fontWeight: 600,
                    color: t.ink,
                  }}
                >
                  localhost:3847/check
                </span>
              </div>
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 18,
                  color: t.muted,
                }}
              >
                Node native SQLite · runs 100% on your machine
              </span>
            </div>
          </Interactive.Div>

          {/* Right Hero Dark MacWindow */}
          <MacWindow
            theme="dark"
            title="localhost:3847/check"
            subtitle="Site X-Ray Workbench"
            delay={14}
            headerRight={
              <StatusChip
                label="LOCAL SQLITE"
                tone="emerald"
                theme="dark"
                size="sm"
                mono
              />
            }
            style={{flex: 1}}
            bodyStyle={{
              display: 'flex',
              backgroundColor: '#121214',
            }}
          >
            {/* Sidebar Navigation */}
            <div
              style={{
                width: 248,
                flexShrink: 0,
                backgroundColor: '#161618',
                borderRight: `1px solid ${PALETTE.nightHair}`,
                padding: '22px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
              }}
            >
              <BrandMark theme="dark" size="sm" style={{paddingLeft: 8}} />

              <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
                {SIDEBAR_NAV.map((item) => (
                  <div
                    key={item.label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '11px 14px',
                      borderRadius: 11,
                      backgroundColor: item.active
                        ? 'rgba(41, 151, 255, 0.16)'
                        : 'transparent',
                      border: item.active
                        ? '1px solid rgba(41, 151, 255, 0.36)'
                        : '1px solid transparent',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: FONTS.sans,
                        fontSize: 19,
                        fontWeight: item.active ? 600 : 500,
                        color: item.active
                          ? PALETTE.nightInk
                          : PALETTE.nightMuted,
                      }}
                    >
                      {item.label}
                    </span>
                    {item.active && (
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 14,
                          fontWeight: 600,
                          color: PALETTE.cobaltNight,
                        }}
                      >
                        {item.route}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Local SQLite footer inside sidebar */}
              <div
                style={{
                  marginTop: 'auto',
                  padding: '12px 14px',
                  borderRadius: 12,
                  backgroundColor: 'rgba(255, 255, 255, 0.04)',
                  border: `1px solid ${PALETTE.nightHair}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 16,
                    fontWeight: 600,
                    color: PALETTE.nightInk,
                  }}
                >
                  hearsay.db
                </span>
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 14,
                    color: PALETTE.nightMuted,
                    whiteSpace: 'nowrap',
                  }}
                >
                  node:sqlite · local
                </span>
              </div>
            </div>

            {/* Main Workbench Panel */}
            <div
              style={{
                flex: 1,
                padding: '24px 28px',
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
              }}
            >
              {/* Run Header + PASS status */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 16,
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 26,
                      fontWeight: 700,
                      letterSpacing: '-0.025em',
                      color: PALETTE.nightInk,
                    }}
                  >
                    Site X-Ray · notewell.io
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      fontFamily: FONTS.mono,
                      fontSize: 16,
                      color: PALETTE.nightMuted,
                    }}
                  >
                    SQLite Drift History · 6 weekly snapshots
                  </div>
                </div>

                <StatusChip
                  label="0 critical · 0 warning · PASS"
                  tone="emerald"
                  theme="dark"
                  size="sm"
                  mono
                  delay={32}
                />
              </div>

              {/* SQLite Drift History Sparkline Panel */}
              <div
                style={{
                  backgroundColor: '#1a1a1d',
                  borderRadius: 14,
                  border: `1px solid ${PALETTE.nightHair}`,
                  padding: '16px 20px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 15,
                      fontWeight: 600,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: PALETTE.nightMuted,
                    }}
                  >
                    SQLITE DRIFT HISTORY · PROSE PARITY
                  </span>
                  <AnimatedCounter
                    from={0}
                    to={94}
                    startFrame={42}
                    duration={46}
                    suffix="% parity"
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 22,
                      fontWeight: 700,
                      color: PALETTE.emeraldNight,
                    }}
                  />
                </div>

                <svg
                  width="100%"
                  height={128}
                  viewBox="0 0 820 140"
                  style={{display: 'block', overflow: 'visible'}}
                >
                  <defs>
                    <linearGradient
                      id="driftLineGrad"
                      x1="0%"
                      y1="0%"
                      x2="100%"
                      y2="0%"
                    >
                      <stop offset="0%" stopColor={PALETTE.cobaltNight} />
                      <stop offset="100%" stopColor={PALETTE.emeraldNight} />
                    </linearGradient>
                    <linearGradient
                      id="driftFillGrad"
                      x1="0%"
                      y1="0%"
                      x2="0%"
                      y2="100%"
                    >
                      <stop
                        offset="0%"
                        stopColor={PALETTE.emeraldNight}
                        stopOpacity="0.26"
                      />
                      <stop
                        offset="100%"
                        stopColor={PALETTE.emeraldNight}
                        stopOpacity="0.0"
                      />
                    </linearGradient>
                    <clipPath id="driftRevealClip">
                      <rect
                        x={0}
                        y={0}
                        width={820 * sparkDrawP}
                        height={140}
                      />
                    </clipPath>
                  </defs>

                  {/* Horizontal guide lines */}
                  {[18, 58, 98].map((yPos) => (
                    <line
                      key={yPos}
                      x1={12}
                      y1={yPos}
                      x2={808}
                      y2={yPos}
                      stroke="rgba(255, 255, 255, 0.08)"
                      strokeDasharray="4 6"
                      strokeWidth={1}
                    />
                  ))}

                  {/* Shaded area under curve */}
                  <path
                    d={SPARKLINE_AREA}
                    fill="url(#driftFillGrad)"
                    clipPath="url(#driftRevealClip)"
                  />

                  {/* Animated stroke path */}
                  <path
                    d={SPARKLINE_PATH}
                    fill="none"
                    stroke="url(#driftLineGrad)"
                    strokeWidth={3.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={pathLength}
                    strokeDashoffset={pathLength * (1 - sparkDrawP)}
                  />

                  {/* Wave nodes & axis labels */}
                  {SPARKLINE_POINTS.map((pt, idx) => {
                    const threshold = idx / (SPARKLINE_POINTS.length - 1);
                    const nodeVisible = clampProgress(
                      sparkDrawP,
                      Math.max(0, threshold - 0.06),
                      Math.min(1, threshold + 0.08),
                      EASE.out,
                    );
                    const isLast = idx === SPARKLINE_POINTS.length - 1;
                    return (
                      <g key={pt.label}>
                        <text
                          x={pt.x}
                          y={134}
                          textAnchor="middle"
                          fill={PALETTE.nightMuted}
                          fontFamily={FONTS.mono}
                          fontSize={13}
                        >
                          {pt.label}
                        </text>
                        <g opacity={nodeVisible}>
                          {isLast && (
                            <circle
                              cx={pt.x}
                              cy={pt.y}
                              r={11}
                              fill="rgba(48, 209, 88, 0.24)"
                            />
                          )}
                          <circle
                            cx={pt.x}
                            cy={pt.y}
                            r={isLast ? 5.5 : 4}
                            fill={
                              idx >= 3
                                ? PALETTE.emeraldNight
                                : PALETTE.cobaltNight
                            }
                            stroke="#1a1a1d"
                            strokeWidth={2}
                          />
                        </g>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Site X-Ray Check Rows */}
              <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                {XRAY_CHECK_ROWS.map((row) => {
                  const rowP = clampProgress(
                    frame,
                    row.delay,
                    row.delay + 14,
                    EASE.editorial,
                  );
                  return (
                    <div
                      key={row.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 16,
                        padding: '13px 18px',
                        borderRadius: RADII.row,
                        backgroundColor: 'rgba(255, 255, 255, 0.04)',
                        border: `1px solid ${PALETTE.nightHair}`,
                        opacity: rowP,
                        translate: `0px ${interpolate(rowP, [0, 1], [12, 0])}px`,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: FONTS.sans,
                            fontSize: 19,
                            fontWeight: 600,
                            color: PALETTE.nightInk,
                          }}
                        >
                          {row.name}
                        </span>
                        <span
                          style={{
                            fontFamily: FONTS.mono,
                            fontSize: 15,
                            color: PALETTE.nightMuted,
                          }}
                        >
                          {row.detail}
                        </span>
                      </div>

                      <StatusChip
                        label={row.status}
                        tone="emerald"
                        theme="dark"
                        size="sm"
                        mono
                        dot={false}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </MacWindow>
        </div>

        {/* Bottom 3 Capability Chips Strip (locks in at f=116 synced to click.mp3) */}
        <Interactive.Div
          name="Workbench capability chips"
          style={{
            display: 'flex',
            gap: 24,
            flexShrink: 0,
          }}
        >
          {CAPABILITY_CHIPS.map((chip) => {
            const chipP = clampProgress(
              frame,
              chip.delay,
              chip.delay + 16,
              EASE.pop,
            );
            const colors = getToneColors(chip.tone, 'mist');

            return (
              <div
                key={chip.title}
                style={{
                  flex: 1,
                  padding: '16px 24px',
                  borderRadius: RADII.panel,
                  backgroundColor: PALETTE.paper,
                  border: cardBorder('mist'),
                  boxShadow: SHADOWS.cardLight,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  opacity: clampProgress(
                    frame,
                    chip.delay,
                    chip.delay + 10,
                    EASE.out,
                  ),
                  translate: `0px ${interpolate(chipP, [0, 1], [18, 0])}px`,
                  scale: interpolate(chipP, [0, 1], [0.96, 1]),
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: RADII.pill,
                      backgroundColor: colors.accent,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 25,
                      fontWeight: 700,
                      letterSpacing: '-0.025em',
                      color: t.ink,
                    }}
                  >
                    {chip.title}
                  </span>
                </div>
                <span
                  style={{
                    fontFamily: chip.monoSub ? FONTS.mono : FONTS.sans,
                    fontSize: chip.monoSub ? 18 : 20,
                    fontWeight: chip.monoSub ? 600 : 400,
                    color: chip.monoSub ? colors.fg : t.muted,
                    paddingLeft: 20,
                  }}
                >
                  {chip.subtitle}
                </span>
              </div>
            );
          })}
        </Interactive.Div>
      </div>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 7 — OutroScene (Pure --night, 206f / 6.87s)
// SFX cues: +10f impact.mp3 (wordmark lands), +58f shimmer.mp3 (pill & shimmer)
// ============================================================================

const OUTRO_META_ITEMS = [
  'MIT Open Source',
  'Local SQLite',
  '46 MCP Tools',
  'Zero API Keys to Start',
] as const;

export const OutroScene: React.FC<Act2SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();

  // Impact landing at frame 10 (synced to TIMELINE.outro.from + 10 impact.mp3)
  const impactSpring = springProgress(frame, 10, 'editorial');
  const wordmarkOpacity = clampProgress(frame, 10, 22, EASE.out);
  const glowBloom = clampProgress(frame, 10, 44, EASE.editorial);

  // Subtitle & terminal pill resolve on frame 58 (synced to shimmer.mp3)
  const subtitleP = clampProgress(frame, 36, 54, EASE.editorial);
  const pillP = clampProgress(frame, 58, 76, EASE.editorial);
  const hairlineExpand = clampProgress(frame, 58, 90, EASE.editorial);
  const shimmerSweep = clampProgress(frame, 58, 126, EASE.inOut);
  const metaP = clampProgress(frame, 88, 108, EASE.out);

  return (
    <SceneCanvas
      theme="dark"
      duration={duration}
      showBrand={false}
      showGrid={true}
      fadeInFrames={8}
      fadeOutFrames={20}
    >
      {/* Keynote radial spotlight blooming on impact.mp3 beat */}
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          opacity: glowBloom,
          background:
            'radial-gradient(ellipse 56% 48% at 50% 42%, rgba(41, 151, 255, 0.14) 0%, rgba(255, 255, 255, 0.03) 44%, transparent 72%)',
        }}
      />

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: `0 ${SAFE.x}px`,
        }}
      >
        {/* Hero BrandMark emblem + Razor-sharp Hearsay wordmark */}
        <Interactive.Div
          name="Hearsay closing lockup"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 28,
            opacity: wordmarkOpacity,
            scale: interpolate(impactSpring, [0, 1], [1.07, 1]),
            translate: `0px ${interpolate(impactSpring, [0, 1], [20, 0])}px`,
          }}
        >
          <span
            style={{
              width: 92,
              height: 92,
              borderRadius: 22,
              backgroundColor: PALETTE.nightInk,
              color: PALETTE.night,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: FONTS.sans,
              fontSize: 62,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: '-0.045em',
              boxShadow:
                '0 18px 54px rgba(41, 151, 255, 0.24), 0 2px 12px rgba(255, 255, 255, 0.18)',
            }}
          >
            h
          </span>

          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 120,
              fontWeight: 700,
              lineHeight: 0.94,
              letterSpacing: '-0.056em',
              backgroundImage:
                'linear-gradient(180deg, #ffffff 30%, #b8b8c0 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              paddingRight: 4,
            }}
          >
            {SCENE_COPY.outro.wordmark}
          </span>
        </Interactive.Div>

        {/* Subtitle */}
        <Interactive.Div
          name="Closing tagline"
          style={{
            marginTop: 30,
            fontFamily: FONTS.sans,
            fontSize: 38,
            fontWeight: 600,
            lineHeight: 1.2,
            letterSpacing: '-0.028em',
            color: PALETTE.nightInk,
            textAlign: 'center',
            opacity: subtitleP,
            translate: `0px ${interpolate(subtitleP, [0, 1], [18, 0])}px`,
          }}
        >
          {SCENE_COPY.outro.tagline}
        </Interactive.Div>

        {/* Tactile dark glass terminal pill with cobalt prompt chevron */}
        <Interactive.Div
          name="Install command pill"
          style={{
            marginTop: 52,
            padding: '22px 38px',
            borderRadius: RADII.panel + 2,
            backgroundImage:
              'linear-gradient(180deg, rgba(34, 34, 38, 0.92) 0%, rgba(18, 18, 21, 0.96) 100%)',
            border: '1px solid rgba(255, 255, 255, 0.16)',
            boxShadow:
              '0 28px 68px rgba(0, 0, 0, 0.78), 0 0 0 1px rgba(41, 151, 255, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
            opacity: clampProgress(frame, 58, 70, EASE.out),
            translate: `0px ${interpolate(pillP, [0, 1], [22, 0])}px`,
            scale: interpolate(pillP, [0, 1], [0.97, 1]),
          }}
        >
          <TerminalPrompt
            command={SCENE_COPY.outro.command}
            prefix="❯"
            startFrame={60}
            charsPerFrame={1.7}
            fontSize={27}
            theme="dark"
            showPill={false}
          />
        </Interactive.Div>

        {/* Subtle animated shimmer hairline */}
        <div
          style={{
            position: 'relative',
            marginTop: 54,
            width: 820,
            height: 1,
            overflow: 'hidden',
            opacity: hairlineExpand,
            scale: `${interpolate(hairlineExpand, [0, 1], [0.55, 1])} 1`,
            backgroundImage:
              'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.16) 22%, rgba(255, 255, 255, 0.16) 78%, transparent 100%)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: 240,
              left: `${interpolate(shimmerSweep, [0, 1], [-240, 820])}px`,
              backgroundImage:
                'linear-gradient(90deg, transparent 0%, rgba(41, 151, 255, 0.85) 50%, transparent 100%)',
            }}
          />
        </div>

        {/* Metadata strip */}
        <Interactive.Div
          name="Closing metadata strip"
          style={{
            marginTop: 28,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            fontFamily: FONTS.mono,
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: '0.01em',
            color: PALETTE.nightMuted,
            opacity: metaP,
            translate: `0px ${interpolate(metaP, [0, 1], [12, 0])}px`,
          }}
        >
          {OUTRO_META_ITEMS.map((item, idx) => (
            <React.Fragment key={item}>
              {idx > 0 && (
                <span
                  style={{
                    color: PALETTE.cobaltNight,
                    opacity: 0.7,
                  }}
                >
                  ·
                </span>
              )}
              <span>{item}</span>
            </React.Fragment>
          ))}
        </Interactive.Div>
      </AbsoluteFill>
    </SceneCanvas>
  );
};
