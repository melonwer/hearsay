import React from 'react';
import {AbsoluteFill, Easing, Img, Interactive, staticFile, useCurrentFrame} from 'remotion';
import {Caption, COLORS, Eyebrow, FLY, FONT, Headline, INOUT, Marker, OUT, progress, Set, Website} from './visuals';
import {COPY} from './timeline';

export type SceneProps = {duration?: number; title?: string; subtitle?: string};

export const Built: React.FC<SceneProps> = ({title = COPY.built.title}) => {
  const f = useCurrentFrame();
  const arrive = progress(f, 12, 54, FLY);
  const turn = progress(f, 24, 82, INOUT);
  return <Set illustration>
    <Eyebrow>THE PRODUCT YOU BUILT</Eyebrow>
    <Headline y={298} size={104} width={850}><span style={{whiteSpace: 'pre-line'}}>{title}</span></Headline>
    <div style={{position: 'absolute', left: 1130, top: 250, width: 610, height: 570, borderRadius: '50%', background: 'rgba(42,120,214,.07)', filter: 'blur(45px)', translate: `0 ${20 * (1 - turn)}px`}} />
    <Interactive.Div name="Website enters the story" style={{position: 'absolute', left: 1080, top: 215, transform: `perspective(1500px) translateY(${130 * (1 - arrive)}px) rotateY(${-22 + 7 * turn}deg) rotateX(${12 - 4 * turn}deg) rotateZ(${7 - 4 * turn}deg)`, opacity: .18 + .82 * Math.min(1, arrive)}}><Website /></Interactive.Div>
    <div style={{position: 'absolute', left: 112, top: 696, width: 730, fontSize: 42, lineHeight: 1.25, color: COLORS.secondary, opacity: progress(f, 54, 76)}}>A website. A real use case.<br />Something a buyer might need.</div>
  </Set>;
};

export const Buyer: React.FC<SceneProps> = ({title = COPY.buyer.title}) => {
  const f = useCurrentFrame();
  const enter = progress(f, 24, 58, OUT);
  return <Set illustration>
    <Eyebrow y={190}>THE CONVERSATION YOU NEVER SEE</Eyebrow>
    <Headline y={256} size={106} width={1030}><span style={{whiteSpace: 'pre-line'}}>{title}</span></Headline>
    <div style={{position: 'absolute', left: 160, top: 535, scale: .44, transformOrigin: '0 0', rotate: '-6deg', opacity: .68}}><Website /></div>
    <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}><path d="M 520 708 C 640 705, 636 564, 744 565" fill="none" stroke="#bbcfe4" strokeWidth={2} strokeDasharray="7 12" opacity={progress(f, 55, 80)} /></svg>
    <Interactive.Div name="Buyer question" style={{position: 'absolute', left: 730, top: 483, width: 1050, height: 330, background: 'white', border: '1px solid #d9dfe4', borderRadius: 32, padding: '42px 52px', boxShadow: '0 34px 85px rgba(15,38,64,.13)', opacity: enter, translate: `${160 * (1 - enter)}px ${20 * (1 - enter)}px`, rotate: `${3 * (1 - enter)}deg`}}>
      <div style={{fontSize: 34, color: COLORS.blue, marginBottom: 24}}>A buyer's question</div>
      <div style={{fontSize: 60, lineHeight: 1.08, fontWeight: 600, letterSpacing: '-.04em'}}>Which meeting-notes tool<br />works for a small team?</div>
      <div style={{position: 'absolute', bottom: -22, left: 92, width: 44, height: 44, background: 'white', borderRight: '1px solid #d9dfe4', borderBottom: '1px solid #d9dfe4', rotate: '45deg'}} />
    </Interactive.Div>
    <Caption delay={70}>You don't see the answer they get.</Caption>
  </Set>;
};

export const Question: React.FC<SceneProps> = ({title = COPY.question.title}) => {
  const f = useCurrentFrame();
  const landing = progress(f, 8, 42, FLY);
  return <Set light>
    <Eyebrow y={233} light>THE QUESTION</Eyebrow>
    <Headline y={307} size={128} width={1100}><span style={{whiteSpace: 'pre-line'}}>{title}</span></Headline>
    <div style={{position: 'absolute', left: 108, top: 584}}><Marker width={940} start={32} /></div>
    <Interactive.Div name="Unanswered question" style={{position: 'absolute', left: 1220, top: 230, width: 500, height: 500, borderRadius: '50%', border: '2px solid rgba(255,255,255,.45)', background: 'radial-gradient(ellipse at 28% 24%,rgba(255,255,255,.17),transparent 68%)', boxShadow: '35px 60px 100px rgba(2,50,111,.25)', fontSize: 275, fontWeight: 400, textAlign: 'center', lineHeight: '480px', translate: `0 ${100 * (1 - landing)}px`, scale: .85 + .15 * landing, opacity: Math.min(1, landing)}}>?</Interactive.Div>
    <Caption delay={48} light>Find out with Hearsay.</Caption>
  </Set>;
};

export const Agent: React.FC<SceneProps> = ({title = COPY.agent.title, subtitle = COPY.agent.subtitle}) => {
  const f = useCurrentFrame();
  const rev = progress(f, 0, 12, Easing.out(Easing.cubic));
  const dem = progress(f, 32, 52, Easing.inOut(Easing.cubic));
  const content = progress(f, 44, 70);
  const rows = ['Which meeting-notes tool works for a small team?', 'How can a team search past meeting notes?'];
  return <Set illustration>
    <Interactive.Div name="Title becomes a section label" style={{position: 'absolute', left: 960 + (112 - 960) * dem, top: 400 + (192 - 400) * dem, transform: `translate(${-50 * (1 - dem)}%, -50%) scale(${1 - .62 * dem})`, transformOrigin: 'left center', fontSize: 130, fontWeight: 600, letterSpacing: '-.05em', whiteSpace: 'nowrap', opacity: rev, filter: `blur(${12 * (1 - rev)}px)`}}>{title}</Interactive.Div>
    <div style={{position: 'absolute', left: 112, top: 289, width: 610, opacity: content, translate: `0 ${28 * (1 - content)}px`}}>
      <div style={{fontSize: 78, fontWeight: 600, lineHeight: 1.05, letterSpacing: '-.05em', whiteSpace: 'pre-line'}}>{subtitle}</div>
      <div style={{marginTop: 35, fontSize: 42, lineHeight: 1.25, color: COLORS.secondary}}>Give Hearsay your website.<br />Review its research plan.</div>
      <div style={{marginTop: 44, scale: .42, transformOrigin: '0 0'}}><Website /></div>
    </div>
    <Interactive.Div name="Illustrated research request" style={{position: 'absolute', left: 770, top: 245, width: 1038, padding: 40, borderRadius: 26, background: COLORS.navy, color: 'white', boxShadow: '0 28px 60px rgba(15,38,64,.15)', opacity: content, translate: `${70 * (1 - content)}px 0`}}>
      <div style={{fontSize: 32, marginBottom: 16, color: '#b7d4f3'}}>Your request</div>
      <div style={{fontSize: 54, lineHeight: 1.12, letterSpacing: '-.035em'}}>Use Hearsay to<br />research my website.</div>
    </Interactive.Div>
    <div style={{position: 'absolute', left: 810, top: 530, width: 960, borderRadius: 24, border: '1px solid #d9dfe4', background: 'white', padding: 34, boxShadow: '0 22px 50px rgba(15,38,64,.10)', opacity: progress(f, 62, 82), translate: `0 ${70 * (1 - progress(f, 62, 82, FLY))}px`}}>
      <div style={{fontSize: 34, color: COLORS.blue, marginBottom: 20}}>Example questions for your review</div>
      {rows.map((text, i) => <div key={text} style={{fontSize: 39, lineHeight: 1.15, padding: '20px 0', borderTop: `1px solid ${COLORS.line}`, opacity: progress(f, 80 + i * 15, 95 + i * 15), translate: `0 ${22 * (1 - progress(f, 80 + i * 15, 95 + i * 15))}px`}}>{text}</div>)}
    </div>
    <Caption delay={118}>Review the questions. Run your own sample.</Caption>
  </Set>;
};

export const Evidence: React.FC<SceneProps> = ({title = COPY.evidence.title, subtitle = COPY.evidence.subtitle}) => {
  const f = useCurrentFrame();
  const macro = progress(f, 105, 134, INOUT);
  const rows = [{src: 'answers-1.png', y: 0}];
  return <Set demo>
    <div style={{position: 'absolute', left: 130, top: 410, width: 1660, padding: '34px 36px', background: COLORS.surface, border: '1px solid #d9dfe4', borderRadius: 22, boxShadow: '0 30px 70px rgba(15,38,64,.12)', opacity: macro, translate: `0 ${48 * (1 - macro)}px`}}>
      <Img src={staticFile('captures/evidence-section-2.png')} style={{display: 'block', width: 1588}} />
      <div style={{height: 1, background: COLORS.line, margin: '18px 0 26px'}} />
      <Img src={staticFile('captures/evidence-section-3.png')} style={{display: 'block', width: 1588}} />
    </div>
    <div style={{position: 'absolute', left: 112, top: 205, fontSize: 91, fontWeight: 600, letterSpacing: '-.05em', lineHeight: 1.07, opacity: 1 - macro}}>{title}<br /><span style={{color: COLORS.blue}}>{subtitle}</span></div>
    <div style={{position: 'absolute', left: 112, top: 205, fontSize: 88, fontWeight: 600, letterSpacing: '-.05em', opacity: macro}}>{subtitle}</div>
    <div style={{position: 'absolute', left: 210, top: 440, width: 1500, height: 410, opacity: 1 - macro, perspective: 1600}}>
      {rows.map((row, i) => {
        const cue = 12 + i * 9;
        const land = cue + 12;
        const p = progress(f, cue, land, Easing.bezier(.3, 0, .25, 1));
        const air = 1 - p;
        const scale = f < land ? 1.06 - .065 * p : 1 - .005 * (1 - progress(f, land, land + 4, Easing.out(Easing.quad)));
        return <div key={row.src} style={{position: 'absolute', left: 0, top: row.y, width: 1500, borderRadius: 18, overflow: 'hidden', boxShadow: `0 ${15 + 30 * air}px ${35 + 60 * air}px rgba(15,38,64,.12)`, opacity: progress(f, cue, cue + 3), transform: `translateY(${-120 * air}px) rotateX(${16 * air}deg) scale(${scale})`}}>
          <Img src={staticFile(`captures/${row.src}`)} style={{display: 'block', width: 1500}} />
          {f >= land && f < land + 8 && <div style={{position: 'absolute', bottom: 0, left: '50%', height: 2, width: `${progress(f, land, land + 5) * 100}%`, translate: '-50% 0', background: COLORS.blue, opacity: 1 - progress(f, land + 2, land + 8)}} />}
        </div>;
      })}
    </div>
    <Caption delay={135}>See the source and citation that were recorded.</Caption>
  </Set>;
};

export const Change: React.FC<SceneProps> = ({title = COPY.change.title}) => {
  const f = useCurrentFrame();
  const arrive = progress(f, 12, 54, FLY);
  const focus = progress(f, 100, 145, INOUT);
  return <Set demo>
    <Eyebrow y={202}>FROM EVIDENCE TO A DECISION</Eyebrow>
    <Headline y={265} size={91} width={1000}><span style={{whiteSpace: 'pre-line'}}>{title}</span></Headline>
    <div style={{position: 'absolute', left: 240 + 20 * focus, top: 470, width: 1400, opacity: Math.min(1, arrive), transform: `perspective(1700px) translateY(${150 * (1 - arrive)}px) rotateY(${-6 * (1 - focus)}deg) rotateX(${5 * (1 - focus)}deg) rotateZ(${-2 * (1 - focus)}deg)`, transformOrigin: '50% 50%', boxShadow: '0 35px 75px rgba(15,38,64,.13)', borderRadius: 20, overflow: 'hidden'}}>
      <Img src={staticFile('captures/opportunities-0.png')} style={{display: 'block', width: 1400}} />
    </div>
    <div style={{position: 'absolute', left: 1160, top: 271, width: 575, padding: '28px 34px', border: '1px solid #cadcef', borderRadius: 20, background: '#edf4fc', fontSize: 42, lineHeight: 1.2, color: COLORS.navy, opacity: progress(f, 120, 142), rotate: '3deg', boxShadow: '0 15px 40px rgba(15,38,64,.06)'}}>A hypothesis.<br />A draft for your review.<div style={{marginTop: 12}}><Marker width={440} start={136} color={COLORS.blue} /></div></div>
    <Caption delay={156}>You decide what to change and publish.</Caption>
  </Set>;
};

const Observation: React.FC<{label: string; later?: boolean}> = ({label, later = false}) => <div style={{width: 660, height: 380, background: 'white', border: '1px solid #d9dfe4', borderRadius: 24, boxShadow: '0 22px 60px rgba(15,38,64,.10)', padding: 38}}>
  <div style={{fontSize: 36, color: COLORS.blue, marginBottom: 25}}>{label}</div>
  <div style={{fontSize: 44, lineHeight: 1.13, fontWeight: 600, letterSpacing: '-.025em'}}>Which meeting-notes tool<br />works for a small team?</div>
  <div style={{height: 1, background: COLORS.line, margin: '26px 0'}} />
  <div style={{fontSize: 34, lineHeight: 1.5, color: COLORS.secondary}}>{later ? 'Later answer + recorded details' : 'Saved answer + recorded details'}<br />{later ? 'Review the observed difference' : 'Keep the original page version'}</div>
</div>;

export const Repeat: React.FC<SceneProps> = ({title = COPY.repeat.title, subtitle = COPY.repeat.subtitle}) => {
  const f = useCurrentFrame();
  const enter = progress(f, 36, 80, FLY);
  const archive = progress(f, 95, 135, INOUT);
  return <Set illustration>
    <Eyebrow y={196}>THE SAME QUESTION, ANOTHER OBSERVATION</Eyebrow>
    <Headline y={265} size={104} width={1500}>{title}<br /><span style={{color: COLORS.blue, fontSize: 84}}>{subtitle}</span></Headline>
    <div style={{position: 'absolute', left: 220, top: 500, transform: `perspective(1600px) rotateY(${6 * (1 - archive)}deg) rotateZ(${-3 * (1 - archive)}deg)`}}><Observation label="Baseline" /></div>
    <div style={{position: 'absolute', left: 1030, top: 500, transform: `perspective(1600px) translateX(${240 * (1 - enter)}px) rotateY(${-12 * (1 - archive)}deg) rotateZ(${6 * (1 - archive)}deg)`, opacity: Math.min(1, enter)}}><Observation label="Later collection" later /></div>
    <svg width={1920} height={1080} style={{position: 'absolute', inset: 0, opacity: progress(f, 82, 104)}}><path d="M 920 700 L 988 700 M 972 682 L 990 700 L 972 718" stroke={COLORS.blue} strokeWidth={4} fill="none" /></svg>
    <Caption delay={132}>Keep the history. Decide what to do next.</Caption>
  </Set>;
};

const ELEMENTS = [
  {src: 'answers-1.png', w: 856, h: 189, cx: 250, cy: 280, scale: .59, rot: -5, dx: -500, dy: -150, cue: 4},
  {src: 'opportunities-0.png', w: 856, h: 248, cx: 1620, cy: 310, scale: .52, rot: 4, dx: 500, dy: -150, cue: 7},
  {src: 'evidence-section-2.png', w: 822, h: 100, cx: 250, cy: 815, scale: .50, rot: 3, dx: -450, dy: 250, cue: 10},
  {src: 'evidence-section-3.png', w: 822, h: 100, cx: 1630, cy: 810, scale: .53, rot: -3, dx: 450, dy: 260, cue: 13},
];

export const Outro: React.FC<SceneProps> = ({title = COPY.outro.title, subtitle = COPY.outro.subtitle}) => {
  const f = useCurrentFrame();
  const crane = progress(f, 0, 40, Easing.bezier(.3, 0, .2, 1));
  const recede = progress(f, 42, 50);
  const rule = progress(f, 58, 70);
  const tag = progress(f, 68, 84);
  return <AbsoluteFill style={{background: COLORS.page, fontFamily: FONT, overflow: 'hidden'}}>
    <AbsoluteFill style={{background: 'radial-gradient(ellipse at 50% 43%,rgba(42,120,214,.12),transparent 70%)'}} />
    <AbsoluteFill style={{transform: `perspective(1400px) rotateX(${4 * (1 - crane)}deg) scale(${1.06 - .06 * crane})`, transformOrigin: '50% 45%'}}>
      {ELEMENTS.map(el => {
        const t = progress(f, el.cue, el.cue + 12, FLY);
        const air = Math.max(0, 1 - t);
        return <div key={el.src} style={{position: 'absolute', left: el.cx - el.w / 2, top: el.cy - el.h / 2, width: el.w, height: el.h, transform: `translate(${el.dx * (1 - t)}px,${el.dy * (1 - t)}px) rotate(${el.rot * (2 - t)}deg) scale(${el.scale * (1.12 - .12 * t)})`, opacity: progress(f, el.cue, el.cue + 3) * (1 - .65 * recede), filter: `blur(${recede * 1.4}px) saturate(${1 - .25 * recede})`, borderRadius: 18, overflow: 'hidden', boxShadow: `0 ${10 + 26 * air}px ${24 + 46 * air}px rgba(15,38,64,.13)`}}><Img src={staticFile(`captures/${el.src}`)} style={{width: el.w, display: 'block'}} /></div>;
      })}
      <div style={{position: 'absolute', left: 754, top: 105, opacity: progress(f, 16, 28) * (1 - .3 * recede), transform: `scale(.42) rotate(-3deg)`, transformOrigin: '50% 0'}}><Website width={690} height={540} /></div>
    </AbsoluteFill>
    <AbsoluteFill style={{background: 'radial-gradient(ellipse 850px 390px at 50% 48%,rgba(249,249,247,.99),rgba(249,249,247,.96) 60%,transparent 100%)', opacity: recede}} />
    <div style={{position: 'absolute', top: 370, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 0, fontSize: 184, color: COLORS.ink, fontWeight: 600, letterSpacing: '-.055em'}}>
      {title.split('').map((ch, i) => {const t = progress(f, Math.round(42 + i * 1.8), Math.round(50 + i * 1.8), Easing.bezier(.2, .75, .3, 1)); return <span key={i} style={{display: 'inline-block', opacity: t, translate: `0 ${28 * (1 - t)}px`, scale: 1.35 - .35 * t, filter: `blur(${8 * (1 - t)}px)`}}>{ch}</span>;})}
    </div>
    <div style={{position: 'absolute', left: 830, top: 600, height: 6, width: 260, background: COLORS.blue, borderRadius: 3, scale: `${rule} 1`}} />
    <Interactive.Div name="Closing message" style={{position: 'absolute', left: 380, right: 380, top: 650, fontSize: 60, lineHeight: 1.16, textAlign: 'center', color: COLORS.secondary, letterSpacing: '-.035em', opacity: tag, whiteSpace: 'pre-line'}}>{subtitle}</Interactive.Div>
    <Interactive.Div name="Repository URL" style={{position: 'absolute', left: 0, right: 0, top: 845, fontSize: 42, textAlign: 'center', color: COLORS.blue, opacity: progress(f, 86, 104)}}>github.com/melonwer/hearsay</Interactive.Div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 926, fontSize: 32, textAlign: 'center', color: COLORS.secondary, opacity: progress(f, 96, 114)}}>Open source · use your existing assistant</div>
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 30, fontSize: 32, textAlign: 'center', color: COLORS.secondary}}>Demo imagery · fictional data</div>
  </AbsoluteFill>;
};
