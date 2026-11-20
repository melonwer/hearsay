import React from 'react';
import {Interactive, interpolate, useCurrentFrame} from 'remotion';
import {
  EASE,
  FONTS,
  PALETTE,
  RADII,
  SAFE,
  SHADOWS,
  THEMES,
  clampProgress,
} from '../design';
import {
  AnimatedCounter,
  ConfidenceBar,
  EditorialText,
  EyebrowBadge,
  KineticHeadline,
  MacWindow,
  ReceiptRow,
  SceneCanvas,
  SceneTransition,
  StatusChip,
  StrikeMark,
  TerminalPrompt,
  ThermalReceipt,
} from '../primitives';
import {SCENE_COPY} from '../timeline';

export interface SceneProps {
  duration: number;
}

// ============================================================================
// Scene 1: HookScene (Light --paper, TIMELINE.hook: 207f / 6.90s)
// SFX sync: +24f whoosh (chat card enters), +122f click (omitted callout lands)
// ============================================================================

const HOOK_PROMPT =
  "What's the best meeting notes app for a 40-person engineering team?";

const HOOK_RECS = [
  {
    rank: '#1',
    name: 'Fireflies.ai',
    price: '$19/seat',
    detail:
      'Business tier includes SOC 2 Type II, API webhooks, and automatic CRM sync.',
    tone: 'cobalt' as const,
  },
  {
    rank: '#2',
    name: 'Otter.ai',
    price: '$20/seat',
    detail:
      'Business plan includes SOC 2 compliance, shared team spaces, and SAML SSO.',
    tone: 'neutral' as const,
  },
] as const;

const HOOK_MODELS = ['ChatGPT', 'Claude', 'Gemini'] as const;

export const HookScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();
  const theme = THEMES.light;

  // Chat card entrance synced to whoosh.mp3 at +24f
  const cardIn = clampProgress(frame, 24, 46, EASE.editorial);
  const cardOpacity = clampProgress(frame, 24, 38, EASE.out);

  // User prompt typing (34f -> 66f)
  const promptElapsed = Math.max(0, frame - 34);
  const promptChars = Math.min(
    HOOK_PROMPT.length,
    Math.floor(promptElapsed * 2.2),
  );
  const promptDone = promptChars >= HOOK_PROMPT.length;
  const promptCaretVisible =
    frame >= 34 && !promptDone && Math.floor(promptElapsed / 8) % 2 === 0;
  const bubbleIn = clampProgress(frame, 32, 46, EASE.out);

  // Assistant header + searching -> cited transition (64f -> 78f)
  const assistantIn = clampProgress(frame, 64, 78, EASE.out);
  const searchedDone = clampProgress(frame, 76, 84, EASE.out);

  // Intro & recommendations staggered entrances
  const introIn = clampProgress(frame, 78, 92, EASE.out);
  const rec0In = clampProgress(frame, 86, 102, EASE.editorial);
  const rec1In = clampProgress(frame, 98, 114, EASE.editorial);

  // Omitted callout synced to click.mp3 at +122f
  const omittedPop = clampProgress(frame, 122, 136, EASE.pop);
  const omittedOpacity = clampProgress(frame, 122, 131, EASE.out);

  // Left-column reality note enters right after omitted callout lands
  const factCardIn = clampProgress(frame, 132, 150, EASE.editorial);

  return (
    <SceneCanvas
      theme="light"
      sceneIndex={1}
      totalScenes={7}
      topRight={
        <StatusChip
          label="LIVE AI BUYER QUERY"
          tone="cobalt"
          theme="light"
          size="sm"
          mono
          delay={6}
        />
      }
      footnote="Example brand: notewell.io · SOC 2 Type II · SAML SSO · $22/seat"
    >
      <SceneTransition
        duration={duration}
        enterFrames={14}
        exitFrames={12}
        enterShiftY={16}
        exitScale={0.992}
      >
        <div
          style={{
            position: 'absolute',
            left: SAFE.x,
            right: SAFE.x,
            top: SAFE.topHeader,
            bottom: SAFE.bottom,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 68,
          }}
        >
          {/* Left editorial narrative column */}
          <Interactive.Div
            name="Hook editorial column"
            style={{
              width: 672,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
            }}
          >
            <EyebrowBadge theme="light" tone="cobalt" delay={4}>
              {SCENE_COPY.hook.eyebrow}
            </EyebrowBadge>

            <KineticHeadline
              lines={['The conversation', 'you never see.']}
              theme="light"
              size={82}
              delay={8}
              stagger={7}
              style={{marginTop: 18}}
            />

            <EditorialText
              theme="light"
              size={27}
              delay={20}
              maxWidth={560}
              style={{marginTop: 24}}
            >
              {SCENE_COPY.hook.subline}
            </EditorialText>

            {/* Subtle editorial contrast card highlighting Notewell's invisible features */}
            <Interactive.Div
              name="Notewell reality summary"
              style={{
                marginTop: 34,
                width: '100%',
                maxWidth: 580,
                padding: '20px 24px',
                borderRadius: RADII.panel,
                backgroundColor: PALETTE.mist,
                border: `1px solid ${PALETTE.hair}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                opacity: factCardIn,
                translate: `0px ${interpolate(factCardIn, [0, 1], [16, 0])}px`,
              }}
            >
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
                    fontFamily: FONTS.mono,
                    fontSize: 16,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: PALETTE.graphite,
                  }}
                >
                  NOTEWELL.IO · PRODUCT FIT
                </span>
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 16,
                    fontWeight: 600,
                    color: PALETTE.signal,
                  }}
                >
                  0 / 3 SHORTLISTS
                </span>
              </div>

              <div
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 21,
                  lineHeight: 1.4,
                  color: PALETTE.ink,
                }}
              >
                Has <strong>SOC 2 Type II</strong>, <strong>SAML SSO</strong>, and{' '}
                <strong>$22/seat</strong> pricing — yet buyers never see its name.
              </div>
            </Interactive.Div>
          </Interactive.Div>

          {/* Right sleek minimalist AI chat window */}
          <Interactive.Div
            name="AI buyer chat card"
            style={{
              flex: 1,
              maxWidth: 960,
              borderRadius: RADII.device,
              backgroundColor: PALETTE.paper,
              border: `1px solid ${PALETTE.hair}`,
              boxShadow: SHADOWS.deviceLight,
              overflow: 'hidden',
              opacity: cardOpacity,
              translate: `0px ${interpolate(cardIn, [0, 1], [34, 0])}px`,
              scale: interpolate(cardIn, [0, 1], [0.97, 1]),
            }}
          >
            {/* Chat topbar matching docs/showcase.css */}
            <div
              style={{
                height: 62,
                padding: '0 24px',
                backgroundColor: '#fbfbfd',
                borderBottom: `1px solid ${PALETTE.hair}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
              }}
            >
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: 3,
                  borderRadius: 11,
                  backgroundColor: 'rgba(118, 118, 128, 0.12)',
                  gap: 2,
                }}
              >
                {HOOK_MODELS.map((model, idx) => {
                  const active = idx === 0;
                  return (
                    <span
                      key={model}
                      style={{
                        padding: '6px 16px',
                        borderRadius: 8,
                        fontFamily: FONTS.sans,
                        fontSize: 17,
                        fontWeight: active ? 600 : 500,
                        color: active ? PALETTE.ink : PALETTE.graphite,
                        backgroundColor: active ? PALETTE.paper : 'transparent',
                        boxShadow: active
                          ? '0 2px 6px rgba(0, 0, 0, 0.10)'
                          : 'none',
                      }}
                    >
                      {model}
                    </span>
                  );
                })}
              </div>

              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 18,
                  color: PALETTE.graphite,
                }}
              >
                Target brand:{' '}
                <strong style={{color: PALETTE.ink, fontWeight: 600}}>
                  Notewell
                </strong>
              </span>
            </div>

            {/* Chat conversation body */}
            <div
              style={{
                padding: '26px 30px 24px',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* Buyer prompt bubble */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  marginBottom: 20,
                  opacity: bubbleIn,
                  translate: `0px ${interpolate(bubbleIn, [0, 1], [12, 0])}px`,
                }}
              >
                <div
                  style={{
                    maxWidth: '86%',
                    backgroundColor: '#f0f0f2',
                    padding: '14px 20px',
                    borderRadius: '22px 22px 6px 22px',
                    fontFamily: FONTS.sans,
                    fontSize: 22,
                    lineHeight: 1.38,
                    color: PALETTE.ink,
                    minHeight: 62,
                  }}
                >
                  {HOOK_PROMPT.slice(0, promptChars)}
                  {promptCaretVisible && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 2.5,
                        height: 22,
                        marginLeft: 3,
                        verticalAlign: '-0.14em',
                        backgroundColor: PALETTE.cobalt,
                      }}
                    />
                  )}
                </div>
              </div>

              {/* Assistant meta header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  marginBottom: 12,
                  opacity: assistantIn,
                  translate: `0px ${interpolate(assistantIn, [0, 1], [8, 0])}px`,
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: RADII.pill,
                    backgroundColor: '#10a37f',
                    boxShadow: 'inset 0 0 0 5px rgba(255, 255, 255, 0.36)',
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 21,
                    fontWeight: 600,
                    color: PALETTE.ink,
                  }}
                >
                  ChatGPT
                </span>
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 17,
                    color: PALETTE.graphite,
                  }}
                >
                  {searchedDone < 0.5
                    ? 'Searching the web…'
                    : 'Searched 6 pages · 2 sources cited'}
                </span>
              </div>

              {/* Assistant intro line */}
              <div
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 21,
                  lineHeight: 1.44,
                  color: PALETTE.ink,
                  opacity: introIn,
                  translate: `0px ${interpolate(introIn, [0, 1], [10, 0])}px`,
                }}
              >
                For a 40-person engineering team needing SOC 2 and reliable team
                transcripts, two options stand out:
              </div>

              {/* Recommendation cards */}
              <div
                style={{
                  marginTop: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {HOOK_RECS.map((rec, idx) => {
                  const p = idx === 0 ? rec0In : rec1In;
                  return (
                    <div
                      key={rec.name}
                      style={{
                        backgroundColor: PALETTE.mist,
                        borderRadius: 14,
                        padding: '14px 18px',
                        border: `1px solid ${PALETTE.hair}`,
                        opacity: p,
                        translate: `0px ${interpolate(p, [0, 1], [14, 0])}px`,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: 4,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: FONTS.mono,
                              fontSize: 15,
                              fontWeight: 700,
                              color:
                                rec.tone === 'cobalt'
                                  ? PALETTE.cobaltInk
                                  : PALETTE.graphite,
                              backgroundColor:
                                rec.tone === 'cobalt'
                                  ? theme.cobaltSoft
                                  : 'rgba(0, 0, 0, 0.06)',
                              padding: '2px 9px',
                              borderRadius: RADII.pill,
                            }}
                          >
                            {rec.rank}
                          </span>
                          <span
                            style={{
                              fontFamily: FONTS.sans,
                              fontSize: 22,
                              fontWeight: 700,
                              color: PALETTE.ink,
                              letterSpacing: '-0.02em',
                            }}
                          >
                            {rec.name}
                          </span>
                        </div>
                        <span
                          style={{
                            fontFamily: FONTS.mono,
                            fontSize: 17,
                            color: PALETTE.graphite,
                          }}
                        >
                          {rec.price}
                        </span>
                      </div>

                      <div
                        style={{
                          fontFamily: FONTS.sans,
                          fontSize: 19,
                          lineHeight: 1.4,
                          color: '#3a3a3c',
                        }}
                      >
                        {rec.detail}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Citation badges */}
              <div
                style={{
                  marginTop: 16,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <StatusChip
                  label={`Cited · ${SCENE_COPY.hook.sourceChip}`}
                  tone="cobalt"
                  theme="light"
                  mono
                  size="sm"
                  delay={108}
                />
                <StatusChip
                  label="fireflies.ai/pricing"
                  tone="neutral"
                  theme="light"
                  mono
                  size="sm"
                  delay={114}
                />
              </div>

              {/* Omitted callout banner synced to click.mp3 at +122f */}
              <Interactive.Div
                name="Notewell absent callout"
                style={{
                  marginTop: 16,
                  padding: '14px 18px',
                  borderRadius: 14,
                  backgroundColor: 'rgba(215, 0, 21, 0.065)',
                  border: '1px solid rgba(215, 0, 21, 0.26)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 14,
                  opacity: omittedOpacity,
                  scale: interpolate(omittedPop, [0, 1], [0.94, 1]),
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 11}}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: RADII.pill,
                      backgroundColor: PALETTE.signal,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 21,
                      fontWeight: 600,
                      color: PALETTE.signal,
                      letterSpacing: '-0.015em',
                    }}
                  >
                    Notewell — absent from the answer
                  </span>
                </div>

                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 17,
                    fontWeight: 600,
                    color: PALETTE.cobaltInk,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Inspect why →
                </span>
              </Interactive.Div>
            </div>
          </Interactive.Div>
        </div>
      </SceneTransition>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 2: XRayScene (Dark --night, TIMELINE.xray: 236f / 7.87s)
// SFX sync: +4f whoosh (dark terminal enters), +96f click (Bot-vs-Human diff),
//           +168f marker (FAIL [BLOCKED_HARD_GATE] verdict lands)
// ============================================================================

const XRAY_COMMAND =
  'npx @melonwer/hearsay check https://notewell.io --browser --vs fireflies.ai';

const XRAY_CRAWLERS = [
  'OAI-SearchBot',
  'Claude-SearchBot',
  'PerplexityBot',
  '+15 AI bots',
] as const;

export const XRayScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();

  // Telemetry card enters once CLI command finishes typing (~56f)
  const telemetryIn = clampProgress(frame, 60, 76, EASE.editorial);
  const doneBadgeIn = clampProgress(frame, 58, 70, EASE.out);

  // Bot-vs-Human diff reveals on click.mp3 at +96f
  const diffIn = clampProgress(frame, 96, 114, EASE.editorial);

  // Competitor comparison card enters at 116f, bar fills 122f -> 156f
  const vsIn = clampProgress(frame, 116, 134, EASE.editorial);
  const firefliesBar = clampProgress(frame, 124, 158, EASE.editorial);

  // BLOCKED_HARD_GATE verdict lands on marker.mp3 at +168f
  const verdictPop = clampProgress(frame, 168, 182, EASE.pop);
  const verdictOpacity = clampProgress(frame, 168, 176, EASE.out);

  // Copy-paste Vite SSR remediation chip appears right after verdict (178f)
  const fixChipIn = clampProgress(frame, 178, 196, EASE.editorial);

  return (
    <SceneCanvas
      theme="dark"
      sceneIndex={2}
      totalScenes={7}
      topRight={
        <StatusChip
          label="ZERO API KEYS · 10s CLI"
          tone="emerald"
          theme="dark"
          size="sm"
          mono
          delay={8}
        />
      }
      footnote="hearsay check --browser · Raw HTTP vs. Chromium DOM parity & --vs competitor X-ray"
    >
      <SceneTransition
        duration={duration}
        enterFrames={12}
        exitFrames={12}
        enterShiftY={14}
        exitScale={0.992}
      >
        <div
          style={{
            position: 'absolute',
            left: SAFE.x,
            right: SAFE.x,
            top: 112,
            bottom: SAFE.bottom,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          {/* Compact editorial header above the terminal */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 24,
              marginBottom: 22,
            }}
          >
            <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
              <EyebrowBadge theme="dark" tone="cobalt" delay={2}>
                {SCENE_COPY.xray.eyebrow}
              </EyebrowBadge>
              <KineticHeadline
                lines={['See what zero-JS AI crawlers actually see.']}
                theme="dark"
                size={54}
                delay={6}
              />
            </div>

            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 18,
                color: PALETTE.nightMuted,
                paddingBottom: 6,
                opacity: doneBadgeIn,
                translate: `0px ${interpolate(doneBadgeIn, [0, 1], [8, 0])}px`,
              }}
            >
              HTTP + Playwright · 4.2s
            </div>
          </div>

          {/* Primary dark-mode macOS X-Ray Window */}
          <MacWindow
            theme="dark"
            title="hearsay — site x-ray"
            subtitle="notewell.io --vs fireflies.ai"
            delay={4}
            headerRight={
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 15,
                  color: PALETTE.nightMuted,
                }}
              >
                v0.1
              </span>
            }
            bodyStyle={{
              padding: '22px 26px 26px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {/* Live CLI Command Prompt */}
            <TerminalPrompt
              command={XRAY_COMMAND}
              startFrame={10}
              charsPerFrame={1.65}
              fontSize={22}
              theme="dark"
              showPill
              style={{
                width: '100%',
                padding: '15px 22px',
                backgroundColor: '#101012',
              }}
            />

            {/* Two-Column Forensic Panel */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.14fr 0.86fr',
                gap: 22,
                alignItems: 'stretch',
              }}
            >
              {/* LEFT: Crawl Telemetry + Bot-vs-Human Diff */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                }}
              >
                {/* Live Crawl Telemetry Card */}
                <Interactive.Div
                  name="Crawl telemetry panel"
                  style={{
                    backgroundColor: PALETTE.nightElevated,
                    borderRadius: RADII.panel,
                    border: `1px solid ${PALETTE.nightHair}`,
                    padding: '18px 22px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    opacity: telemetryIn,
                    translate: `0px ${interpolate(telemetryIn, [0, 1], [16, 0])}px`,
                  }}
                >
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
                        fontFamily: FONTS.mono,
                        fontSize: 15,
                        fontWeight: 600,
                        letterSpacing: '0.09em',
                        textTransform: 'uppercase',
                        color: PALETTE.nightMuted,
                      }}
                    >
                      LIVE CRAWL TELEMETRY
                    </span>
                    <StatusChip
                      label="18/18 AI crawlers allowed"
                      tone="emerald"
                      theme="dark"
                      mono
                      size="sm"
                      delay={66}
                    />
                  </div>

                  {/* Crawler badges */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    {XRAY_CRAWLERS.map((bot, idx) => (
                      <span
                        key={bot}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '5px 12px',
                          borderRadius: 8,
                          backgroundColor: 'rgba(255, 255, 255, 0.06)',
                          border: `1px solid ${PALETTE.nightHair}`,
                          fontFamily: FONTS.mono,
                          fontSize: 16,
                          color:
                            idx < 3 ? PALETTE.nightInk : PALETTE.nightMuted,
                        }}
                      >
                        {idx < 3 && (
                          <span style={{color: PALETTE.emeraldNight}}>✓</span>
                        )}
                        {bot}
                      </span>
                    ))}
                  </div>

                  {/* Detected stack line */}
                  <div
                    style={{
                      paddingTop: 10,
                      borderTop: `1px solid ${PALETTE.nightHair}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontFamily: FONTS.mono,
                      fontSize: 17,
                      color: PALETTE.nightMuted,
                    }}
                  >
                    <span>
                      Stack:{' '}
                      <strong
                        style={{color: PALETTE.nightInk, fontWeight: 600}}
                      >
                        Vite SPA · Cloudflare
                      </strong>
                    </span>
                    <span style={{color: PALETTE.amberNight}}>
                      robots.txt OK · JS-gated body
                    </span>
                  </div>
                </Interactive.Div>

                {/* Bot-vs-Human Diff Card (syncs to click.mp3 at +96f) */}
                <Interactive.Div
                  name="Bot vs human diff panel"
                  style={{
                    position: 'relative',
                    backgroundColor: '#111113',
                    borderRadius: RADII.panel,
                    border: `1px solid ${PALETTE.nightHairStrong}`,
                    padding: '20px 22px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    flex: 1,
                    opacity: diffIn,
                    translate: `0px ${interpolate(diffIn, [0, 1], [18, 0])}px`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 15,
                        fontWeight: 600,
                        letterSpacing: '0.09em',
                        textTransform: 'uppercase',
                        color: PALETTE.nightMuted,
                      }}
                    >
                      BOT-VS-HUMAN DIFF · NOTEWELL.IO
                    </span>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 16,
                        color: PALETTE.nightMuted,
                      }}
                    >
                      Raw HTTP vs. Rendered DOM
                    </span>
                  </div>

                  {/* Two big numeric comparison boxes */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto 1fr',
                      alignItems: 'center',
                      gap: 16,
                    }}
                  >
                    {/* Raw HTML box */}
                    <div
                      style={{
                        padding: '16px 18px',
                        borderRadius: 12,
                        backgroundColor: 'rgba(255, 69, 58, 0.08)',
                        border: '1px solid rgba(255, 69, 58, 0.28)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 14,
                          fontWeight: 600,
                          letterSpacing: '0.08em',
                          color: PALETTE.signalNight,
                        }}
                      >
                        RAW HTML (AI BOT)
                      </span>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 10,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: FONTS.sans,
                            fontSize: 60,
                            fontWeight: 700,
                            lineHeight: 0.95,
                            letterSpacing: '-0.05em',
                            fontVariantNumeric: 'tabular-nums',
                            color: PALETTE.signalNight,
                          }}
                        >
                          0
                        </span>
                        <span
                          style={{
                            fontFamily: FONTS.sans,
                            fontSize: 22,
                            color: PALETTE.nightMuted,
                          }}
                        >
                          words
                        </span>
                      </div>
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 16,
                          color: PALETTE.nightMuted,
                        }}
                      >
                        &lt;div id=&quot;root&quot;&gt; shell
                      </span>
                    </div>

                    {/* Center VS badge */}
                    <span
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: RADII.pill,
                        backgroundColor: 'rgba(255, 255, 255, 0.07)',
                        border: `1px solid ${PALETTE.nightHairStrong}`,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: FONTS.mono,
                        fontSize: 14,
                        fontWeight: 600,
                        color: PALETTE.nightMuted,
                      }}
                    >
                      vs
                    </span>

                    {/* Rendered DOM box */}
                    <div
                      style={{
                        padding: '16px 18px',
                        borderRadius: 12,
                        backgroundColor: 'rgba(48, 209, 88, 0.07)',
                        border: '1px solid rgba(48, 209, 88, 0.25)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 14,
                          fontWeight: 600,
                          letterSpacing: '0.08em',
                          color: PALETTE.emeraldNight,
                        }}
                      >
                        RENDERED DOM (HUMAN)
                      </span>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 10,
                        }}
                      >
                        <AnimatedCounter
                          from={0}
                          to={1167}
                          startFrame={98}
                          duration={28}
                          style={{
                            fontFamily: FONTS.sans,
                            fontSize: 60,
                            fontWeight: 700,
                            lineHeight: 0.95,
                            letterSpacing: '-0.05em',
                            color: PALETTE.nightInk,
                          }}
                        />
                        <span
                          style={{
                            fontFamily: FONTS.sans,
                            fontSize: 22,
                            color: PALETTE.nightMuted,
                          }}
                        >
                          words
                        </span>
                      </div>
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 16,
                          color: PALETTE.nightMuted,
                        }}
                      >
                        16 headings · full pricing
                      </span>
                    </div>
                  </div>

                  {/* FAIL [BLOCKED_HARD_GATE] Verdict Bar (syncs to marker.mp3 at +168f) */}
                  <Interactive.Div
                    name="Blocked hard gate verdict"
                    style={{
                      padding: '14px 18px',
                      borderRadius: 12,
                      backgroundColor: 'rgba(255, 69, 58, 0.16)',
                      border: '1.5px solid rgba(255, 69, 58, 0.52)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      opacity: verdictOpacity,
                      scale: interpolate(verdictPop, [0, 1], [1.06, 1]),
                    }}
                  >
                    <div
                      style={{display: 'flex', alignItems: 'center', gap: 10}}
                    >
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 22,
                          fontWeight: 700,
                          color: PALETTE.nightInk,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        0% Prose Parity
                      </span>
                      <span
                        style={{
                          fontFamily: FONTS.mono,
                          fontSize: 16,
                          color: PALETTE.nightMuted,
                        }}
                      >
                        →
                      </span>
                    </div>

                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 19,
                        fontWeight: 700,
                        letterSpacing: '0.02em',
                        color: PALETTE.signalNight,
                      }}
                    >
                      FAIL [BLOCKED_HARD_GATE]
                    </span>
                  </Interactive.Div>
                </Interactive.Div>
              </div>

              {/* RIGHT: --vs Competitor Parity Comparison + Vite SSR Fix Chip */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                }}
              >
                {/* Competitor X-Ray Comparison Card */}
                <Interactive.Div
                  name="Competitor X-Ray comparison"
                  style={{
                    backgroundColor: PALETTE.nightElevated,
                    borderRadius: RADII.panel,
                    border: `1px solid ${PALETTE.nightHair}`,
                    padding: '22px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 20,
                    flex: 1,
                    opacity: vsIn,
                    translate: `0px ${interpolate(vsIn, [0, 1], [18, 0])}px`,
                  }}
                >
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
                        fontFamily: FONTS.mono,
                        fontSize: 15,
                        fontWeight: 600,
                        letterSpacing: '0.09em',
                        textTransform: 'uppercase',
                        color: PALETTE.cobaltNight,
                      }}
                    >
                      --VS COMPETITOR X-RAY
                    </span>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 15,
                        color: PALETTE.nightMuted,
                      }}
                    >
                      PROSE PARITY
                    </span>
                  </div>

                  {/* Bar 1: notewell.io 0% */}
                  <div
                    style={{display: 'flex', flexDirection: 'column', gap: 8}}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div
                        style={{display: 'flex', alignItems: 'center', gap: 10}}
                      >
                        <span
                          style={{
                            fontFamily: FONTS.mono,
                            fontSize: 22,
                            fontWeight: 600,
                            color: PALETTE.nightInk,
                          }}
                        >
                          notewell.io
                        </span>
                        <span
                          style={{
                            fontFamily: FONTS.mono,
                            fontSize: 13,
                            padding: '2px 8px',
                            borderRadius: 6,
                            backgroundColor: 'rgba(255, 69, 58, 0.16)',
                            color: PALETTE.signalNight,
                          }}
                        >
                          YOUR SITE
                        </span>
                      </div>

                      <span
                        style={{
                          fontFamily: FONTS.sans,
                          fontSize: 44,
                          fontWeight: 700,
                          lineHeight: 0.95,
                          letterSpacing: '-0.045em',
                          fontVariantNumeric: 'tabular-nums',
                          color: PALETTE.signalNight,
                        }}
                      >
                        0%
                      </span>
                    </div>

                    <div
                      style={{
                        position: 'relative',
                        height: 16,
                        borderRadius: RADII.pill,
                        backgroundColor: 'rgba(255, 255, 255, 0.09)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: 10,
                          borderRadius: RADII.pill,
                          backgroundColor: PALETTE.signalNight,
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 16,
                        color: PALETTE.nightMuted,
                      }}
                    >
                      0 / 1,167 words visible without JavaScript
                    </span>
                  </div>

                  {/* Bar 2: fireflies.ai 94% */}
                  <div
                    style={{display: 'flex', flexDirection: 'column', gap: 8}}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div
                        style={{display: 'flex', alignItems: 'center', gap: 10}}
                      >
                        <span
                          style={{
                            fontFamily: FONTS.mono,
                            fontSize: 22,
                            fontWeight: 600,
                            color: PALETTE.nightInk,
                          }}
                        >
                          fireflies.ai
                        </span>
                        <span
                          style={{
                            fontFamily: FONTS.mono,
                            fontSize: 13,
                            padding: '2px 8px',
                            borderRadius: 6,
                            backgroundColor: 'rgba(41, 151, 255, 0.16)',
                            color: PALETTE.cobaltNight,
                          }}
                        >
                          RIVAL
                        </span>
                      </div>

                      <AnimatedCounter
                        from={0}
                        to={94}
                        suffix="%"
                        startFrame={124}
                        duration={34}
                        style={{
                          fontFamily: FONTS.sans,
                          fontSize: 44,
                          fontWeight: 700,
                          lineHeight: 0.95,
                          letterSpacing: '-0.045em',
                          color: PALETTE.cobaltNight,
                        }}
                      />
                    </div>

                    <div
                      style={{
                        position: 'relative',
                        height: 16,
                        borderRadius: RADII.pill,
                        backgroundColor: 'rgba(255, 255, 255, 0.09)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${94 * firefliesBar}%`,
                          borderRadius: RADII.pill,
                          backgroundColor: PALETTE.cobaltNight,
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 16,
                        color: PALETTE.nightMuted,
                      }}
                    >
                      Server-rendered HTML · pricing &amp; SOC 2 indexed
                    </span>
                  </div>

                  {/* Gap summary strip — counter ramps in exact lockstep with fireflies.ai bar */}
                  <div
                    style={{
                      marginTop: 'auto',
                      padding: '12px 16px',
                      borderRadius: 11,
                      backgroundColor: 'rgba(41, 151, 255, 0.11)',
                      border: '1px solid rgba(41, 151, 255, 0.28)',
                      fontFamily: FONTS.mono,
                      fontSize: 16,
                      color: PALETTE.nightInk,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span>Crawlability delta</span>
                    <strong style={{color: PALETTE.cobaltNight}}>
                      <AnimatedCounter
                        from={0}
                        to={94}
                        prefix="−"
                        suffix="pp behind fireflies.ai"
                        startFrame={124}
                        duration={34}
                      />
                    </strong>
                  </div>
                </Interactive.Div>

                {/* Copy-paste Vite SSR / Prerender Remediation Chip */}
                <Interactive.Div
                  name="Vite SSR remediation chip"
                  style={{
                    backgroundColor: '#111113',
                    borderRadius: RADII.panel,
                    border: '1px solid rgba(48, 209, 88, 0.32)',
                    padding: '16px 22px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    opacity: fixChipIn,
                    translate: `0px ${interpolate(fixChipIn, [0, 1], [14, 0])}px`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 14,
                        fontWeight: 600,
                        letterSpacing: '0.09em',
                        textTransform: 'uppercase',
                        color: PALETTE.emeraldNight,
                      }}
                    >
                      REMEDIATION · VITE SSR / PRERENDER
                    </span>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 13,
                        fontWeight: 600,
                        padding: '3px 9px',
                        borderRadius: RADII.pill,
                        backgroundColor: 'rgba(48, 209, 88, 0.14)',
                        color: PALETTE.emeraldNight,
                      }}
                    >
                      COPY-PASTE FIX
                    </span>
                  </div>

                  <div
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 17,
                      lineHeight: 1.48,
                      color: PALETTE.nightInk,
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                      borderRadius: 10,
                      padding: '10px 14px',
                      border: `1px solid ${PALETTE.nightHair}`,
                    }}
                  >
                    <div>
                      <span style={{color: PALETTE.cobaltNight}}>plugins</span>:
                      [vike({'{'} prerender: true {'}'})]
                    </div>
                    <div style={{fontSize: 15, color: PALETTE.nightMuted}}>
                      {`// Prerenders /pricing & /security for zero-JS crawlers`}
                    </div>
                  </div>
                </Interactive.Div>
              </div>
            </div>
          </MacWindow>
        </div>
      </SceneTransition>
    </SceneCanvas>
  );
};

// ============================================================================
// Scene 3: NoScoreScene (Mist --mist -> ThermalReceipt, TIMELINE.noScore: 206f)
// SFX sync: +44f marker (crimson slash across 74/100), +70f paper (receipt feeds)
// ============================================================================

const RECEIPT_METRICS = [
  {
    index: '01',
    section: 'UNPROMPTED BRAND APPEARANCE',
    label: 'Mention Rate',
    value: 18,
    ciLow: 9,
    ciHigh: 32,
    tone: 'cobalt' as const,
    rowDelay: 86,
    barDelay: 82,
    barDuration: 24,
  },
  {
    index: '02',
    section: 'DIRECT DOMAIN LINKED',
    label: 'Citation Rate',
    value: 6,
    ciLow: 2,
    ciHigh: 17,
    tone: 'amber' as const,
    rowDelay: 100,
    barDelay: 96,
    barDuration: 22,
  },
  {
    index: '03',
    section: 'TOP-3 RECOMMENDATION',
    label: 'Positive Rec',
    value: 4,
    ciLow: 1,
    ciHigh: 15,
    tone: 'signal' as const,
    rowDelay: 114,
    barDelay: 110,
    barDuration: 20,
  },
] as const;

export const NoScoreScene: React.FC<SceneProps> = ({duration}) => {
  const frame = useCurrentFrame();

  // Generic SaaS score card enters early (14f), slashed at +44f, then dims back (58f -> 76f)
  const fakeCardIn = clampProgress(frame, 14, 30, EASE.editorial);
  const fakeCardDim = clampProgress(frame, 58, 76, EASE.editorial);

  // Subtle radial ring fill for the fake 74/100 gauge
  const ringRadius = 42;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringProgress = clampProgress(frame, 16, 40, EASE.editorial) * 0.74;

  // Supporting explanation appears cleanly right after slash
  const noteIn = clampProgress(frame, 62, 80, EASE.out);

  return (
    <SceneCanvas
      theme="mist"
      sceneIndex={3}
      totalScenes={7}
      topRight={
        <StatusChip
          label="WILSON 95% CI · n = 45"
          tone="cobalt"
          theme="mist"
          size="sm"
          mono
          delay={6}
        />
      }
      footnote="Separated rates · exact sample size · zero proprietary composite indices"
    >
      <SceneTransition
        duration={duration}
        enterFrames={14}
        exitFrames={12}
        enterShiftY={16}
        exitScale={0.992}
      >
        <div
          style={{
            position: 'absolute',
            left: SAFE.x,
            right: SAFE.x,
            top: SAFE.topHeader,
            bottom: SAFE.bottom,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 72,
          }}
        >
          {/* Left column: Headline + Slashed 74/100 Fake SaaS Widget */}
          <Interactive.Div
            name="Fake score contrast column"
            style={{
              width: 780,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
            }}
          >
            <EyebrowBadge theme="mist" tone="signal" delay={2}>
              {SCENE_COPY.noScore.eyebrow}
            </EyebrowBadge>

            <KineticHeadline
              lines={['Receipts, not a', 'fake 0–100 score.']}
              theme="mist"
              size={76}
              delay={6}
              stagger={7}
              style={{marginTop: 16}}
            />

            {/* Mocked-up generic SaaS "74 / 100 — AI Visibility Score" card */}
            <Interactive.Div
              name="Generic SaaS score widget"
              style={{
                position: 'relative',
                marginTop: 36,
                width: '100%',
                maxWidth: 680,
                backgroundColor: PALETTE.paper,
                borderRadius: RADII.card,
                border: `1px solid ${PALETTE.hairStrong}`,
                boxShadow: SHADOWS.cardLight,
                padding: '26px 30px',
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                opacity: fakeCardIn,
                translate: `0px ${interpolate(fakeCardIn, [0, 1], [20, 0])}px`,
                scale: interpolate(fakeCardDim, [0, 1], [1, 0.965]),
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  opacity: interpolate(fakeCardDim, [0, 1], [1, 0.5]),
                  filter: `grayscale(${interpolate(fakeCardDim, [0, 1], [0, 0.7])})`,
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 15,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: PALETTE.graphite,
                  }}
                >
                  GENERIC SAAS DASHBOARD · $399/MO
                </span>
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 15,
                    fontWeight: 600,
                    padding: '4px 11px',
                    borderRadius: RADII.pill,
                    backgroundColor: 'rgba(26, 137, 23, 0.10)',
                    color: PALETTE.emerald,
                  }}
                >
                  ↑ +3 pts this week
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 26,
                }}
              >
                {/* Fake SaaS radial gauge */}
                <svg
                  width={104}
                  height={104}
                  viewBox="0 0 104 104"
                  style={{
                    flexShrink: 0,
                    opacity: interpolate(fakeCardDim, [0, 1], [1, 0.5]),
                    filter: `grayscale(${interpolate(fakeCardDim, [0, 1], [0, 0.7])})`,
                  }}
                >
                  <circle
                    cx={52}
                    cy={52}
                    r={ringRadius}
                    fill="none"
                    stroke="rgba(0, 0, 0, 0.08)"
                    strokeWidth={10}
                  />
                  <circle
                    cx={52}
                    cy={52}
                    r={ringRadius}
                    fill="none"
                    stroke={PALETTE.cobalt}
                    strokeWidth={10}
                    strokeLinecap="round"
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={ringCircumference * (1 - ringProgress)}
                    transform="rotate(-90 52 52)"
                  />
                  <text
                    x={52}
                    y={59}
                    textAnchor="middle"
                    fill={PALETTE.ink}
                    fontFamily={FONTS.sans}
                    fontSize={28}
                    fontWeight={700}
                  >
                    74
                  </text>
                </svg>

                <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
                  {/* Score numeral with vivid crimson StrikeMark cleanly bounded to 74 / 100 */}
                  <div
                    style={{
                      position: 'relative',
                      display: 'inline-flex',
                      alignItems: 'baseline',
                      alignSelf: 'flex-start',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: FONTS.sans,
                        fontSize: 54,
                        fontWeight: 700,
                        lineHeight: 0.96,
                        letterSpacing: '-0.045em',
                        fontVariantNumeric: 'tabular-nums',
                        color: PALETTE.ink,
                        opacity: interpolate(fakeCardDim, [0, 1], [1, 0.45]),
                      }}
                    >
                      74 / 100
                    </span>
                    <StrikeMark
                      startFrame={44}
                      duration={14}
                      color={PALETTE.signal}
                      thickness={7}
                      angleDeg={-6}
                      style={{left: '-6%', right: '-6%', top: '52%'}}
                    />
                  </div>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 23,
                      fontWeight: 600,
                      color: PALETTE.graphite,
                      opacity: interpolate(fakeCardDim, [0, 1], [1, 0.5]),
                    }}
                  >
                    AI Visibility Score
                  </span>
                  <span
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 16,
                      color: '#86868b',
                      opacity: interpolate(fakeCardDim, [0, 1], [1, 0.5]),
                    }}
                  >
                    Opaque blended index · sample size hidden
                  </span>
                </div>
              </div>
            </Interactive.Div>

            {/* Editorial contrast note */}
            <div
              style={{
                marginTop: 26,
                maxWidth: 660,
                opacity: noteIn,
                translate: `0px ${interpolate(noteIn, [0, 1], [14, 0])}px`,
              }}
            >
              <EditorialText theme="mist" size={24} delay={0} maxWidth={660}>
                A blended index hides which prompt failed and which page AI
                skipped. Hearsay prints every separated rate with exact sample
                size and Wilson 95% confidence intervals.
              </EditorialText>
            </div>
          </Interactive.Div>

          {/* Right column: Tactile ThermalReceipt synced to paper.mp3 at +70f */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <ThermalReceipt
              headerBrand="Hearsay"
              headerSub="DETERMINISTIC METRIC RECEIPT"
              metaLeft="n = 45 prompts · 3 models"
              metaRight="Wilson 95% CI"
              width={700}
              startFrame={70}
              printDuration={28}
              showSlot
              showBarcode
              footerLeft="STATUS"
              footerRight="ZERO BLENDED SCORES"
              footerRightTone="emerald"
              footerSub="VERIFIED · ZERO BLENDED SCORES · LOCAL SQLITE"
              theme="mist"
            >
              {RECEIPT_METRICS.map((metric, idx) => (
                <ReceiptRow
                  key={metric.label}
                  index={metric.index}
                  label={metric.section}
                  delay={metric.rowDelay}
                  last={idx === RECEIPT_METRICS.length - 1}
                >
                  <ConfidenceBar
                    label={metric.label}
                    value={metric.value}
                    ciLow={metric.ciLow}
                    ciHigh={metric.ciHigh}
                    sampleSize={45}
                    tone={metric.tone}
                    onThermal
                    delay={metric.barDelay}
                    duration={metric.barDuration}
                  />
                </ReceiptRow>
              ))}
            </ThermalReceipt>
          </div>
        </div>
      </SceneTransition>
    </SceneCanvas>
  );
};
