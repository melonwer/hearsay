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
  TYPE,
  clampProgress,
} from '../design';
import {
  AnimatedCounter,
  BrandMark,
  CommandPill,
  EditorialCard,
  EditorialText,
  KineticHeadline,
  Pill,
  SceneCanvas,
} from '../primitives';
import {SCENE_COPY, SCENE_CUES} from '../timeline';

export interface SceneProps {
  duration: number;
}

// ============================================================================
// Scene 4 — FixScene (Mist #f5f5f7, TIMELINE.fix: 206f / 6.87s)
// SFX cues:
//   +6f   SCENE_CUES.fix.cardEnter    (paper.mp3)  — Empty root card enters
//   +76f  SCENE_CUES.fix.morphStart   (whoosh.mp3) — Morph to plain HTML table
//   +124f SCENE_CUES.fix.shippedPill  (click.mp3)  — Shipped on Monday pill
// ============================================================================

const FIX_HTML_ROWS = [
  {label: 'Seat price', value: '$22 / mo', included: false},
  {label: 'SOC 2 Type II', value: 'Included', included: true},
  {label: 'SAML SSO', value: 'Included', included: true},
] as const;

export const FixScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const t = THEMES.mist;

  const cardEnterStart = SCENE_CUES.fix.cardEnter; // 6f
  const morphStart = SCENE_CUES.fix.morphStart; // 76f
  const shippedStart = SCENE_CUES.fix.shippedPill; // 124f

  // Browser card entrance synced to paper.mp3 (+6f)
  const cardIn = clampProgress(
    frame,
    cardEnterStart,
    cardEnterStart + 22,
    EASE.editorial,
  );
  const cardOpacity = clampProgress(
    frame,
    cardEnterStart,
    cardEnterStart + 14,
    EASE.out,
  );

  // Subtle red caption under empty <div id="root"></div>
  const beforeCaptionIn = clampProgress(
    frame,
    cardEnterStart + 14,
    cardEnterStart + 28,
    EASE.out,
  );

  // Crisp top-to-bottom morph wipe synced to whoosh.mp3 (+76f)
  const morphP = clampProgress(frame, morphStart, morphStart + 22, EASE.editorial);
  const beforeUnderOpacity = interpolate(morphP, [0, 1], [1, 0.35]);
  const wipeInsetBottom = interpolate(morphP, [0, 1], [100, 0]);
  const sweepLineOpacity =
    clampProgress(frame, morphStart, morphStart + 4, EASE.out) *
    (1 - clampProgress(frame, morphStart + 18, morphStart + 24, EASE.out));
  const sweepLineY = interpolate(morphP, [0, 1], [0, 344]);

  // Closing supporting caption gently follows Shipped on Monday pill (+124f)
  const closingCaptionIn = clampProgress(
    frame,
    shippedStart + 10,
    shippedStart + 24,
    EASE.out,
  );

  return (
    <SceneCanvas
      theme="mist"
      duration={duration}
      fadeInFrames={10}
      fadeOutFrames={10}
    >
      <div
        style={{
          position: 'absolute',
          left: SAFE.x,
          right: SAFE.x,
          top: SAFE.y,
          bottom: SAFE.y,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Display headline */}
        <KineticHeadline
          theme="mist"
          lines={SCENE_COPY.fix.lines}
          size={78}
          align="center"
          delay={2}
          stagger={7}
          maxWidth={1120}
        />

        {/* ONE minimalist centered browser card */}
        <Interactive.Div
          name="Pricing page browser card"
          style={{
            marginTop: 44,
            width: 840,
            borderRadius: RADII.card,
            backgroundColor: PALETTE.paper,
            border: `1px solid ${PALETTE.hair}`,
            boxShadow: SHADOWS.cardLight,
            overflow: 'hidden',
            opacity: cardOpacity,
            translate: `0px ${interpolate(cardIn, [0, 1], [24, 0])}px`,
            scale: interpolate(cardIn, [0, 1], [0.98, 1]),
          }}
        >
          {/* Ultra-clean thin browser top bar */}
          <div
            style={{
              height: 54,
              padding: '0 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#fafafa',
              borderBottom: `1px solid ${PALETTE.hair}`,
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 8, width: 64}}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: RADII.pill,
                  backgroundColor: 'rgba(0, 0, 0, 0.13)',
                }}
              />
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: RADII.pill,
                  backgroundColor: 'rgba(0, 0, 0, 0.13)',
                }}
              />
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: RADII.pill,
                  backgroundColor: 'rgba(0, 0, 0, 0.13)',
                }}
              />
            </div>

            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: FONTS.mono,
                fontSize: 18,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                color: t.muted,
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                style={{opacity: 0.65}}
              >
                <rect
                  x="3"
                  y="7"
                  width="10"
                  height="7"
                  rx="2"
                  stroke={t.muted}
                  strokeWidth="1.5"
                />
                <path
                  d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
                  stroke={t.muted}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <span>{SCENE_COPY.fix.url}</span>
            </div>

            <div style={{width: 64}} />
          </div>

          {/* Fixed-height body for seamless before -> after morph */}
          <div
            style={{
              position: 'relative',
              height: 344,
              backgroundColor: '#f2f2f5',
            }}
          >
            {/* BEFORE state: Empty JS shell */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '32px 44px',
                opacity: beforeUnderOpacity,
                scale: interpolate(morphP, [0, 1], [1, 0.97]),
              }}
            >
              <div
                style={{
                  padding: '22px 34px',
                  borderRadius: RADII.row,
                  backgroundColor: 'rgba(255, 255, 255, 0.68)',
                  border: '1.5px dashed rgba(0, 0, 0, 0.14)',
                  fontFamily: FONTS.mono,
                  fontSize: 30,
                  fontWeight: 500,
                  letterSpacing: '-0.015em',
                  color: PALETTE.graphite,
                }}
              >
                <span style={{color: '#86868b'}}>&lt;div </span>
                <span style={{color: PALETTE.ink}}>id</span>
                <span style={{color: '#86868b'}}>=&quot;</span>
                <span style={{color: PALETTE.cobaltInk}}>root</span>
                <span style={{color: '#86868b'}}>&quot;&gt;&lt;/div&gt;</span>
              </div>

              <div
                style={{
                  marginTop: 22,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 9,
                  fontFamily: FONTS.sans,
                  fontSize: 22,
                  fontWeight: 500,
                  letterSpacing: '-0.012em',
                  color: PALETTE.signal,
                  opacity: beforeCaptionIn,
                  translate: `0px ${interpolate(beforeCaptionIn, [0, 1], [10, 0])}px`,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: RADII.pill,
                    backgroundColor: PALETTE.signal,
                  }}
                />
                <span>Empty to AI crawlers</span>
              </div>
            </div>

            {/* AFTER state: Crisp plain-HTML pricing table */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                backgroundColor: PALETTE.paper,
                padding: '32px 48px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                clipPath: `inset(0 0 ${wipeInsetBottom}% 0)`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingBottom: 20,
                  borderBottom: `1px solid ${PALETTE.hairStrong}`,
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 32,
                    fontWeight: 700,
                    letterSpacing: '-0.028em',
                    color: PALETTE.ink,
                  }}
                >
                  {SCENE_COPY.fix.tableTitle}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 17,
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    color: PALETTE.cobaltInk,
                    padding: '6px 14px',
                    borderRadius: RADII.pill,
                    backgroundColor: t.cobaltSoft,
                  }}
                >
                  Plain HTML
                </span>
              </div>

              <div style={{display: 'flex', flexDirection: 'column'}}>
                {FIX_HTML_ROWS.map((row, idx) => {
                  const rowStart = morphStart + 10 + idx * 6;
                  const rowP = clampProgress(
                    frame,
                    rowStart,
                    rowStart + 14,
                    EASE.out,
                  );
                  const isLast = idx === FIX_HTML_ROWS.length - 1;

                  return (
                    <div
                      key={row.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '20px 0',
                        borderBottom: isLast
                          ? 'none'
                          : `1px solid ${PALETTE.hair}`,
                        opacity: rowP,
                        translate: `0px ${interpolate(rowP, [0, 1], [10, 0])}px`,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONTS.sans,
                          fontSize: 25,
                          fontWeight: 500,
                          letterSpacing: '-0.014em',
                          color: PALETTE.graphite,
                        }}
                      >
                        {row.label}
                      </span>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 9,
                          fontFamily: FONTS.sans,
                          fontSize: 25,
                          fontWeight: 700,
                          letterSpacing: '-0.018em',
                          fontVariantNumeric: 'tabular-nums',
                          color: row.included ? PALETTE.emerald : PALETTE.ink,
                        }}
                      >
                        {row.included && (
                          <svg
                            width="20"
                            height="20"
                            viewBox="0 0 20 20"
                            fill="none"
                          >
                            <path
                              d="M4.5 10.5L8.2 14.2L15.5 6.8"
                              stroke={PALETTE.emerald}
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                        <span>{row.value}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Subtle luminous leading edge during the morph wipe */}
            {sweepLineOpacity > 0.01 && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  height: 2,
                  background:
                    'linear-gradient(90deg, transparent 0%, rgba(0, 113, 227, 0.72) 50%, transparent 100%)',
                  opacity: sweepLineOpacity,
                  translate: `0px ${sweepLineY}px`,
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        </Interactive.Div>

        {/* Closing beat: Shipped on Monday pill + quiet plain-English note */}
        <Interactive.Div
          name="Shipped milestone"
          style={{
            marginTop: 36,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            minHeight: 94,
          }}
        >
          <Pill
            label={SCENE_COPY.fix.shippedPill}
            tone="emerald"
            theme="mist"
            size="lg"
            delay={shippedStart}
          />
          <div
            style={{
              fontFamily: FONTS.sans,
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: '-0.012em',
              color: t.muted,
              opacity: closingCaptionIn,
              translate: `0px ${interpolate(closingCaptionIn, [0, 1], [10, 0])}px`,
            }}
          >
            Plain HTML &middot; Readable by every AI crawler
          </div>
        </Interactive.Div>
      </div>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 5 — PayoffScene (Light #ffffff, TIMELINE.payoff: 207f / 6.90s)
// Direct visual callback to Scene 1 (InvisibleScene) — Before -> After payoff
// SFX cues:
//   +66f  SCENE_CUES.payoff.notewellSlideIn (whoosh.mp3) — Notewell slides to #1
//   +100f SCENE_CUES.payoff.citedLock       (click.mp3)  — Cited pill locks in
// ============================================================================

export const PayoffScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const t = THEMES.light;

  const slideStart = SCENE_CUES.payoff.notewellSlideIn; // 66f
  const citedStart = SCENE_CUES.payoff.citedLock; // 100f
  const metricStart = 112;

  // Initial list items enter cleanly inside the card
  const promptIn = clampProgress(frame, 18, 32, EASE.out);
  const firefliesIn = clampProgress(frame, 26, 40, EASE.editorial);
  const otterIn = clampProgress(frame, 34, 48, EASE.editorial);

  // Notewell slides smoothly into #1 while Fireflies & Otter glide down
  const slideP = clampProgress(frame, slideStart, slideStart + 24, EASE.editorial);
  const notewellOpacity = clampProgress(
    frame,
    slideStart,
    slideStart + 14,
    EASE.out,
  );

  // Rank numeral swap halfway through the glide with a soft crossfade
  const rankSwapped = slideP >= 0.5;
  const rankOpacity =
    slideP < 0.5
      ? interpolate(slideP, [0.35, 0.5], [1, 0.25], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : interpolate(slideP, [0.5, 0.65], [0.25, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });

  const firefliesY = interpolate(slideP, [0, 1], [0, 104]);
  const otterY = interpolate(slideP, [0, 1], [86, 190]);
  const firefliesDim = interpolate(slideP, [0, 1], [1, 0.56]);
  const otterDim = interpolate(slideP, [0, 1], [1, 0.48]);

  // Grounded outcome metric line below card (112f)
  const metricIn = clampProgress(frame, metricStart, metricStart + 18, EASE.out);

  const fireflies = SCENE_COPY.payoff.others[0];
  const otter = SCENE_COPY.payoff.others[1];

  return (
    <SceneCanvas
      theme="light"
      duration={duration}
      fadeInFrames={10}
      fadeOutFrames={10}
    >
      <div
        style={{
          position: 'absolute',
          left: SAFE.x,
          right: SAFE.x,
          top: SAFE.y,
          bottom: SAFE.y,
          paddingTop: 100,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
        }}
      >
        <KineticHeadline
          theme="light"
          lines={SCENE_COPY.payoff.lines}
          size={80}
          align="center"
          delay={2}
          stagger={7}
          maxWidth={1180}
        />

        {/* Center: Clean minimalist AI answer card (callback to Scene 1) */}
        <EditorialCard
          theme="light"
          delay={12}
          width={960}
          padding="32px 40px"
          name="Payoff AI answer card"
          style={{marginTop: 40}}
        >
          {/* Buyer prompt bubble */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 20,
              padding: '15px 22px',
              borderRadius: 18,
              backgroundColor: PALETTE.mist,
              opacity: promptIn,
              translate: `0px ${interpolate(promptIn, [0, 1], [10, 0])}px`,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 23,
                fontWeight: 500,
                letterSpacing: '-0.015em',
                color: PALETTE.ink,
              }}
            >
              &ldquo;{SCENE_COPY.payoff.prompt}&rdquo;
            </span>
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 17,
                fontWeight: 600,
                color: t.muted,
                flexShrink: 0,
              }}
            >
              {SCENE_COPY.payoff.assistant}
            </span>
          </div>

          {/* Animated recommendation stack — expands smoothly as Notewell inserts at #1 */}
          <div
            style={{
              position: 'relative',
              height: interpolate(slideP, [0, 1], [164, 266]),
              marginTop: 22,
            }}
          >
            {/* #1 WINNER: Notewell slides smoothly into slot 0 at +66f */}
            <Interactive.Div
              name="Notewell #1 recommendation"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: 92,
                padding: '0 22px',
                borderRadius: RADII.panel,
                backgroundColor: 'rgba(0, 113, 227, 0.065)',
                border: `2px solid ${PALETTE.cobalt}`,
                boxShadow: '0 12px 28px -12px rgba(0, 113, 227, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 20,
                opacity: notewellOpacity,
                translate: `0px ${interpolate(slideP, [0, 1], [-22, 0])}px`,
                scale: interpolate(slideP, [0, 1], [0.97, 1]),
                zIndex: 2,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: RADII.pill,
                    backgroundColor: PALETTE.cobalt,
                    color: PALETTE.paper,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: FONTS.sans,
                    fontSize: 19,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  1
                </span>

                <div style={{display: 'flex', flexDirection: 'column', gap: 3}}>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 27,
                      fontWeight: 700,
                      letterSpacing: '-0.024em',
                      lineHeight: 1.15,
                      color: PALETTE.ink,
                    }}
                  >
                    {SCENE_COPY.payoff.winner.name}
                  </span>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 20,
                      fontWeight: 500,
                      letterSpacing: '-0.012em',
                      color: PALETTE.cobaltInk,
                    }}
                  >
                    {SCENE_COPY.payoff.winner.detail}
                  </span>
                </div>
              </div>

              {/* Vivid cobalt cited pill pops cleanly at +100f */}
              <Pill
                label={SCENE_COPY.payoff.citedPill}
                tone="cobalt"
                theme="light"
                mono
                dot={false}
                size="sm"
                delay={citedStart}
                style={{
                  backgroundColor: PALETTE.cobalt,
                  border: `1px solid ${PALETTE.cobalt}`,
                  color: PALETTE.paper,
                  padding: '9px 18px',
                  fontSize: 19,
                  boxShadow: '0 8px 20px -6px rgba(0, 113, 227, 0.5)',
                  flexShrink: 0,
                }}
              />
            </Interactive.Div>

            {/* Former #1 -> #2: Fireflies.ai glides down smoothly */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: 74,
                padding: '0 22px',
                borderRadius: RADII.row,
                backgroundColor: PALETTE.paper,
                border: `1px solid ${PALETTE.hair}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                opacity: firefliesIn * firefliesDim,
                translate: `0px ${firefliesY + interpolate(firefliesIn, [0, 1], [14, 0])}px`,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: RADII.pill,
                    backgroundColor: PALETTE.mist,
                    color: PALETTE.graphite,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: FONTS.sans,
                    fontSize: 18,
                    fontWeight: 600,
                    opacity: rankOpacity,
                    flexShrink: 0,
                  }}
                >
                  {rankSwapped ? '2' : '1'}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 24,
                    fontWeight: 600,
                    letterSpacing: '-0.018em',
                    color: PALETTE.ink,
                  }}
                >
                  {fireflies.name}
                </span>
              </div>
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 20,
                  fontWeight: 400,
                  color: t.muted,
                }}
              >
                {fireflies.detail}
              </span>
            </div>

            {/* Former #2 -> #3: Otter.ai glides down smoothly */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: 74,
                padding: '0 22px',
                borderRadius: RADII.row,
                backgroundColor: PALETTE.paper,
                border: `1px solid ${PALETTE.hair}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                opacity: otterIn * otterDim,
                translate: `0px ${otterY + interpolate(otterIn, [0, 1], [14, 0])}px`,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: RADII.pill,
                    backgroundColor: PALETTE.mist,
                    color: PALETTE.graphite,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: FONTS.sans,
                    fontSize: 18,
                    fontWeight: 600,
                    opacity: rankOpacity,
                    flexShrink: 0,
                  }}
                >
                  {rankSwapped ? '3' : '2'}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 24,
                    fontWeight: 600,
                    letterSpacing: '-0.018em',
                    color: PALETTE.ink,
                  }}
                >
                  {otter.name}
                </span>
              </div>
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 20,
                  fontWeight: 400,
                  color: t.muted,
                }}
              >
                {otter.detail}
              </span>
            </div>
          </div>
        </EditorialCard>

        {/* Below card: ONE calm, grounded metric line */}
        <Interactive.Div
          name="Payoff outcome line"
          style={{
            marginTop: 38,
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 14,
            fontFamily: FONTS.sans,
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: '-0.018em',
            color: t.muted,
            opacity: metricIn,
            translate: `0px ${interpolate(metricIn, [0, 1], [14, 0])}px`,
          }}
        >
          <span>{SCENE_COPY.payoff.outcomePrefix}</span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 10,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span style={{color: PALETTE.ink, fontWeight: 600}}>
              {SCENE_COPY.payoff.citationsFrom}%
            </span>
            <span style={{color: t.muted}}>&rarr;</span>
            <AnimatedCounter
              from={SCENE_COPY.payoff.citationsFrom}
              to={SCENE_COPY.payoff.citationsTo}
              startFrame={metricStart}
              duration={26}
              suffix="%"
              style={{
                color: PALETTE.cobaltInk,
                fontWeight: 700,
              }}
            />
          </span>
          <span style={{color: 'rgba(0, 0, 0, 0.24)', margin: '0 8px'}}>
            &middot;
          </span>
          <span>{SCENE_COPY.payoff.outcomeSuffix}</span>
        </Interactive.Div>
      </div>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 6 — OutroScene (Dark #000000, TIMELINE.outro: 177f / 5.90s)
// Apple-keynote lockup with subtle radial glow and clean 22f fade-out
// SFX cues:
//   +8f  SCENE_CUES.outro.logoLand   (impact.mp3)  — Hearsay lockup lands
//   +46f SCENE_CUES.outro.ctaResolve (shimmer.mp3) — Tagline & CTA resolve
// ============================================================================

export const OutroScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();

  const logoStart = SCENE_CUES.outro.logoLand; // 8f
  const taglineStart = SCENE_CUES.outro.ctaResolve; // 46f
  const commandStart = 62;
  const metaStart = 86;

  // Keynote logo lockup entrance (+8f)
  const logoIn = clampProgress(frame, logoStart, logoStart + 24, EASE.editorial);
  const logoOpacity = clampProgress(frame, logoStart, logoStart + 14, EASE.out);

  // Subtle centered radial glow breathes in smoothly behind the lockup
  const glowOpacity = clampProgress(frame, logoStart, logoStart + 36, EASE.out);

  // Hairline expands cleanly from center at 86f
  const hairlineP = clampProgress(
    frame,
    metaStart,
    metaStart + 20,
    EASE.editorial,
  );
  const metaIn = clampProgress(frame, metaStart + 4, metaStart + 20, EASE.out);

  return (
    <SceneCanvas
      theme="dark"
      duration={duration}
      showAmbient={false}
      fadeInFrames={8}
      fadeOutFrames={22}
    >
      {/* Subtle Apple-keynote radial glow behind lockup */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse 46% 38% at 50% 42%, rgba(41, 151, 255, 0.14), rgba(41, 151, 255, 0.03) 48%, transparent 72%)',
          opacity: glowOpacity,
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: SAFE.x,
          right: SAFE.x,
          top: SAFE.y,
          bottom: SAFE.y,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Crisp BrandMark (size="hero") + bold Hearsay wordmark (120px) */}
        <Interactive.Div
          name="Hearsay keynote lockup"
          style={{
            opacity: logoOpacity,
            translate: `0px ${interpolate(logoIn, [0, 1], [20, 0])}px`,
            scale: interpolate(logoIn, [0, 1], [0.95, 1]),
          }}
        >
          <BrandMark
            theme="dark"
            size="hero"
            style={{
              fontSize: TYPE.wordmark.fontSize,
              lineHeight: TYPE.wordmark.lineHeight,
              letterSpacing: TYPE.wordmark.letterSpacing,
            }}
          />
        </Interactive.Div>

        {/* Clean keynote subtitle (+46f) */}
        <EditorialText
          theme="dark"
          size={36}
          weight={500}
          muted={false}
          color="rgba(245, 245, 247, 0.86)"
          align="center"
          delay={taglineStart}
          style={{
            marginTop: 30,
            letterSpacing: '-0.024em',
          }}
        >
          {SCENE_COPY.outro.tagline}
        </EditorialText>

        {/* Centered sleek dark glass CommandPill (+62f) */}
        <div style={{marginTop: 48}}>
          <CommandPill
            command={SCENE_COPY.outro.command}
            theme="dark"
            fontSize={28}
            typing={false}
            showCursor
            startFrame={commandStart}
            enterDelay={commandStart}
            style={{
              backgroundColor: 'rgba(20, 20, 24, 0.88)',
              border: '1px solid rgba(255, 255, 255, 0.16)',
              boxShadow:
                '0 24px 56px -16px rgba(0, 0, 0, 0.92), 0 0 0 1px rgba(41, 151, 255, 0.14)',
            }}
          />
        </div>

        {/* Subtle hairline + quiet metadata strip (+86f) */}
        <div
          style={{
            marginTop: 46,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 24,
          }}
        >
          <div
            style={{
              width: 580,
              height: 1,
              backgroundColor: PALETTE.nightHair,
              scale: `${hairlineP} 1`,
              opacity: hairlineP,
            }}
          />

          <Interactive.Div
            name="Outro metadata strip"
            style={{
              fontFamily: FONTS.sans,
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              color: PALETTE.nightMuted,
              textAlign: 'center',
              opacity: metaIn,
              translate: `0px ${interpolate(metaIn, [0, 1], [10, 0])}px`,
            }}
          >
            Open source &nbsp;&middot;&nbsp; MIT &nbsp;&middot;&nbsp; Local
            SQLite &nbsp;&middot;&nbsp; Zero API keys to start
          </Interactive.Div>
        </div>
      </div>
    </SceneCanvas>
  );
};
