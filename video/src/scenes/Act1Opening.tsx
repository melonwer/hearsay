import React from 'react';
import {Interactive, interpolate, useCurrentFrame} from 'remotion';
import {
  EASE,
  FONTS,
  LAYOUT,
  PALETTE,
  RADII,
  SAFE,
  TYPE,
  clampProgress,
} from '../design';
import {
  AnimatedCounter,
  CommandPill,
  EditorialCard,
  EditorialText,
  KineticHeadline,
  Pill,
  ReceiptRow,
  ReceiptStamp,
  SceneCanvas,
  SceneTransition,
  StrikeInline,
  ThermalReceipt,
} from '../primitives';
import {SCENE_COPY, SCENE_CUES} from '../timeline';

export interface SceneProps {
  duration: number;
}

// ============================================================================
// Scene 1: InvisibleScene (Light #ffffff · TIMELINE.invisible: 207f / 6.90s)
// Cues: +28f whoosh (chat card enters), +124f click (omitted pill lands)
// ============================================================================

export const InvisibleScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const copy = SCENE_COPY.invisible;
  const cues = SCENE_CUES.invisible;

  // Buyer speech bubble glides in right after card settles, then types cleanly (38f -> 70f)
  const bubbleIn = clampProgress(frame, cues.chatEnter + 8, cues.chatEnter + 20, EASE.out);
  const typeStart = cues.chatEnter + 10; // 38f
  const promptElapsed = Math.max(0, frame - typeStart);
  const promptChars = Math.min(
    copy.prompt.length,
    Math.floor(promptElapsed * 1.65),
  );
  const promptDone = promptChars >= copy.prompt.length;
  const caretVisible =
    frame >= typeStart && !promptDone && Math.floor(promptElapsed / 8) % 2 === 0;

  // Two calm recommendation rows stagger in after prompt completes (76f, 92f)
  const rec0In = clampProgress(frame, 76, 94, EASE.editorial);
  const rec1In = clampProgress(frame, 92, 110, EASE.editorial);

  // Payoff crimson pill glides gently up on exact SFX click at 124f
  const omittedSlide = clampProgress(
    frame,
    cues.omittedLand,
    cues.omittedLand + 18,
    EASE.editorial,
  );

  return (
    <SceneCanvas theme="light">
      <SceneTransition
        duration={duration}
        enterFrames={14}
        exitFrames={12}
        enterShiftY={14}
        exitScale={0.994}
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
          {/* Headline */}
          <KineticHeadline
            lines={copy.lines}
            theme="light"
            size={80}
            align="center"
            delay={4}
            stagger={7}
          />

          {/* Minimalist ChatGPT buyer conversation card */}
          <EditorialCard
            theme="light"
            name="Buyer AI chat card"
            width={820}
            padding="30px 38px 32px"
            delay={cues.chatEnter}
            style={{marginTop: 44}}
          >
            {/* Whisper-quiet assistant dot header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 20,
              }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: RADII.pill,
                  backgroundColor: '#10a37f',
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 20,
                  fontWeight: 600,
                  letterSpacing: '-0.014em',
                  color: PALETTE.graphite,
                }}
              >
                {copy.assistant}
              </span>
            </div>

            {/* Buyer speech bubble (ghost span reserves exact layout height) */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginBottom: 22,
                opacity: bubbleIn,
                translate: `0px ${interpolate(bubbleIn, [0, 1], [12, 0])}px`,
              }}
            >
              <div
                style={{
                  position: 'relative',
                  backgroundColor: PALETTE.mist,
                  padding: '16px 24px',
                  borderRadius: '22px 22px 6px 22px',
                  fontFamily: FONTS.sans,
                  fontSize: 24,
                  fontWeight: 500,
                  lineHeight: 1.35,
                  letterSpacing: '-0.015em',
                  color: PALETTE.ink,
                }}
              >
                <span style={{visibility: 'hidden'}}>{copy.prompt}</span>
                <span
                  style={{
                    position: 'absolute',
                    inset: '16px 24px',
                  }}
                >
                  {copy.prompt.slice(0, promptChars)}
                  {caretVisible && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 2.5,
                        height: 23,
                        marginLeft: 3,
                        verticalAlign: '-0.14em',
                        backgroundColor: PALETTE.cobalt,
                      }}
                    />
                  )}
                </span>
              </div>
            </div>

            {/* Two crisp AI recommendation lines */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {copy.recommendations.map((rec, idx) => {
                const p = idx === 0 ? rec0In : rec1In;
                return (
                  <div
                    key={rec.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '18px 24px',
                      borderRadius: RADII.row,
                      backgroundColor: PALETTE.mist,
                      border: `1px solid ${PALETTE.hair}`,
                      opacity: p,
                      translate: `0px ${interpolate(p, [0, 1], [14, 0])}px`,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 14,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONTS.sans,
                          fontSize: 24,
                          fontWeight: 600,
                          color: PALETTE.graphite,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {idx + 1}.
                      </span>
                      <span
                        style={{
                          fontFamily: FONTS.sans,
                          fontSize: 27,
                          fontWeight: 700,
                          letterSpacing: '-0.022em',
                          color: PALETTE.ink,
                        }}
                      >
                        {rec.name}
                      </span>
                    </div>

                    <span
                      style={{
                        fontFamily: FONTS.sans,
                        fontSize: 21,
                        fontWeight: 400,
                        color: PALETTE.graphite,
                      }}
                    >
                      {rec.detail}
                    </span>
                  </div>
                );
              })}
            </div>
          </EditorialCard>

          {/* Quiet crimson omission payoff */}
          <Interactive.Div
            name="Notewell omitted payoff"
            style={{
              marginTop: 34,
              translate: `0px ${interpolate(omittedSlide, [0, 1], [14, 0])}px`,
            }}
          >
            <Pill
              label={copy.omittedLine}
              tone="signal"
              theme="light"
              size="lg"
              dot
              delay={cues.omittedLand}
            />
          </Interactive.Div>
        </div>
      </SceneTransition>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 2: CommandScene (Dark #000000 · TIMELINE.command: 206f / 6.87s)
// Cues: +4f whoosh (dark cut), +22f typeStart (finishes ~76f),
//       +86f click (1,167 words), +118f marker (0 words)
// ============================================================================

export const CommandScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const copy = SCENE_COPY.command;
  const cues = SCENE_CUES.command;

  // Left stat: "WHAT HUMANS SEE -> 1,167 words" at 86f (synced to click.mp3)
  const humanIn = clampProgress(
    frame,
    cues.humanReveal,
    cues.humanReveal + 18,
    EASE.editorial,
  );
  const dividerIn = clampProgress(
    frame,
    cues.humanReveal + 6,
    cues.humanReveal + 24,
    EASE.out,
  );

  // Right stat: "WHAT AI BOTS SEE -> 0 words" at 118f (synced to marker.mp3)
  const aiOpacity = clampProgress(
    frame,
    cues.aiZeroLand,
    cues.aiZeroLand + 10,
    EASE.out,
  );
  const aiPop = clampProgress(
    frame,
    cues.aiZeroLand,
    cues.aiZeroLand + 18,
    EASE.pop,
  );

  return (
    <SceneCanvas theme="dark">
      <SceneTransition
        duration={duration}
        enterFrames={12}
        exitFrames={12}
        enterShiftY={12}
        exitScale={0.994}
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
          {/* Headline */}
          <KineticHeadline
            lines={copy.lines}
            theme="dark"
            size={76}
            align="center"
            delay={cues.cutIn}
            stagger={7}
          />

          {/* Single crisp CLI command pill (enters at 16f, finishes typing by 76f) */}
          <div style={{marginTop: 42}}>
            <CommandPill
              command={copy.command}
              theme="dark"
              fontSize={28}
              enterDelay={16}
              startFrame={cues.typeStart}
              charsPerFrame={0.73}
              style={{
                minWidth: 808,
                justifyContent: 'flex-start',
              }}
            />
          </div>

          {/* Stark side-by-side human vs. AI bot word revelation */}
          <Interactive.Div
            name="Human vs AI words comparison"
            style={{
              marginTop: 58,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 96,
            }}
          >
            {/* Left: WHAT HUMANS SEE -> 1,167 words */}
            <Interactive.Div
              name="What humans see stat"
              style={{
                minWidth: 460,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 14,
                opacity: humanIn,
                translate: `0px ${interpolate(humanIn, [0, 1], [18, 0])}px`,
              }}
            >
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 19,
                  fontWeight: 600,
                  letterSpacing: '0.13em',
                  textTransform: 'uppercase',
                  color: PALETTE.nightMuted,
                }}
              >
                WHAT HUMANS SEE
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 16,
                }}
              >
                <AnimatedCounter
                  from={0}
                  to={copy.humanWords}
                  startFrame={cues.humanReveal}
                  duration={24}
                  style={{
                    ...TYPE.bigStat,
                    color: PALETTE.nightInk,
                  }}
                />
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 36,
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    color: PALETTE.nightMuted,
                  }}
                >
                  {copy.unit}
                </span>
              </div>
            </Interactive.Div>

            {/* Subtle vertical hairline divider */}
            <div
              style={{
                width: 1,
                height: 152,
                backgroundColor: PALETTE.nightHairStrong,
                opacity: dividerIn,
                scale: `1 ${dividerIn}`,
              }}
            />

            {/* Right: WHAT AI BOTS SEE -> 0 words */}
            <Interactive.Div
              name="What AI bots see stat"
              style={{
                minWidth: 460,
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 14,
                opacity: aiOpacity,
                scale: interpolate(aiPop, [0, 1], [1.08, 1]),
              }}
            >
              {/* Whisper-soft crimson focal glow behind 0 words */}
              <div
                style={{
                  position: 'absolute',
                  inset: '-28px -36px',
                  background:
                    'radial-gradient(ellipse 65% 60% at 50% 62%, rgba(255, 69, 58, 0.14), transparent 72%)',
                  pointerEvents: 'none',
                }}
              />
              <span
                style={{
                  position: 'relative',
                  fontFamily: FONTS.sans,
                  fontSize: 19,
                  fontWeight: 600,
                  letterSpacing: '0.13em',
                  textTransform: 'uppercase',
                  color: PALETTE.signalNight,
                }}
              >
                WHAT AI BOTS SEE
              </span>
              <div
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 16,
                }}
              >
                <span
                  style={{
                    ...TYPE.bigStat,
                    color: PALETTE.signalNight,
                  }}
                >
                  {copy.aiWords}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 36,
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    color: 'rgba(255, 69, 58, 0.78)',
                  }}
                >
                  {copy.unit}
                </span>
              </div>
            </Interactive.Div>
          </Interactive.Div>

          {/* Calm plain-English payoff line (~14f after 0 words lands) */}
          <EditorialText
            theme="dark"
            size={30}
            weight={500}
            color="#d2d2d7"
            align="center"
            delay={cues.aiZeroLand + 14}
            style={{marginTop: 48}}
          >
            {copy.punchline}
          </EditorialText>
        </div>
      </SceneTransition>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 3: ReceiptScene (Dark #000000 + Thermal · TIMELINE.receipt: 207f / 6.90s)
// POSTER_FRAME = 565 (local frame 152) — iconic settled hero frame!
// Cues: +34f marker (74/100 strike), +56f paper (receipt prints), +116f click (SKIPPED stamp)
// ============================================================================

export const ReceiptScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const copy = SCENE_COPY.receipt;
  const cues = SCENE_CUES.receipt;

  // Subtle printer slot fades in right as receipt begins printing at 56f
  const slotIn = clampProgress(
    frame,
    cues.receiptPrint - 10,
    cues.receiptPrint + 2,
    EASE.out,
  );

  return (
    <SceneCanvas theme="dark">
      <SceneTransition
        duration={duration}
        enterFrames={12}
        exitFrames={12}
        enterShiftY={12}
        exitScale={0.994}
      >
        <div
          style={{
            position: 'absolute',
            left: SAFE.x,
            right: SAFE.x,
            top: SAFE.y,
            bottom: SAFE.y,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: LAYOUT.splitGap,
          }}
        >
          {/* Left editorial column */}
          <Interactive.Div
            name="Receipt editorial column"
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
            }}
          >
            <KineticHeadline
              lines={[
                <span key="line1" style={{whiteSpace: 'nowrap'}}>
                  {copy.headlinePrefix}
                  <StrikeInline
                    startFrame={cues.strikeStart}
                    duration={14}
                    color={PALETTE.signalNight}
                    thickness={7}
                    angleDeg={-4}
                  >
                    {copy.fakeScore}
                  </StrikeInline>
                  {copy.headlineSuffix}
                </span>,
                copy.headlineSecond,
              ]}
              theme="dark"
              size={80}
              align="left"
              delay={4}
              stagger={8}
            />

            <EditorialText
              theme="dark"
              size={28}
              muted
              delay={44}
              maxWidth={760}
              style={{marginTop: 28}}
            >
              Every search, skipped page, and citation — saved locally.
            </EditorialText>
          </Interactive.Div>

          {/* Right signature warm-paper thermal receipt */}
          <div
            style={{
              width: LAYOUT.receiptWidth,
              flexShrink: 0,
              opacity: slotIn,
              translate: `0px ${interpolate(slotIn, [0, 1], [10, 0])}px`,
            }}
          >
            <ThermalReceipt
              theme="dark"
              width={LAYOUT.receiptWidth}
              headerBrand={copy.headerBrand}
              headerSub={copy.headerSub}
              metaLeft={copy.metaLeft}
              metaRight={copy.metaRight}
              startFrame={cues.receiptPrint}
              printDuration={32}
              showSlot
              showBarcode
              footerLeft="RESULT"
              footerRight="NOTEWELL LEFT OUT"
              footerRightTone="signal"
              footerSub={copy.footerSub}
            >
              {/* 1 · SEARCHED */}
              <ReceiptRow index="1" label="SEARCHED" delay={70}>
                <span>{copy.steps[0].value}</span>
              </ReceiptRow>

              {/* 2 · SKIPPED (clean inline stamp in dedicated right whitespace) */}
              <ReceiptRow index="2" label="SKIPPED" delay={86}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <span style={{fontWeight: 700}}>{copy.steps[1].value}</span>
                    <span
                      style={{
                        fontFamily: FONTS.sans,
                        fontSize: 20,
                        fontWeight: 500,
                        color: PALETTE.signal,
                      }}
                    >
                      {copy.steps[1].note}
                    </span>
                  </div>

                  <ReceiptStamp
                    text={copy.steps[1].stamp}
                    startFrame={cues.skippedStamp}
                    tone="signal"
                    rotateDeg={-6}
                    style={{
                      flexShrink: 0,
                      fontSize: 19,
                      padding: '4px 12px',
                    }}
                  />
                </div>
              </ReceiptRow>

              {/* 3 · CITED INSTEAD */}
              <ReceiptRow index="3" label="CITED INSTEAD" delay={102} last>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <span style={{fontWeight: 700}}>{copy.steps[2].value}</span>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 20,
                      fontWeight: 400,
                      color: PALETTE.thermalMuted,
                    }}
                  >
                    Recommended Fireflies &amp; Otter
                  </span>
                </div>
              </ReceiptRow>
            </ThermalReceipt>
          </div>
        </div>
      </SceneTransition>
    </SceneCanvas>
  );
};
