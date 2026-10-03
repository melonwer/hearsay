import React from 'react';
import './fonts';
import {AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame} from 'remotion';

export const COLORS = {page: '#f9f9f7', surface: '#fcfcfb', ink: '#0b0b0b', secondary: '#52514e', blue: '#2a78d6', line: '#e1e0d9', navy: '#12345c'};
export const FONT = 'Hearsay Inter, Inter, Arial, sans-serif';
export const OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const INOUT = Easing.bezier(0.65, 0, 0.35, 1);
export const FLY = Easing.bezier(0.34, 1.4, 0.44, 1);
export const progress = (frame: number, start: number, end: number, ease = OUT) => interpolate(frame, [start, end], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease});

export const Brand: React.FC<{light?: boolean}> = ({light = false}) => <Interactive.Div name="Hearsay corner brand" style={{position: 'absolute', left: 112, top: 64, display: 'flex', alignItems: 'center', gap: 16, fontSize: 36, fontWeight: 600, color: light ? 'white' : COLORS.ink}}>
  <span style={{width: 42, height: 42, borderRadius: 12, background: light ? 'white' : COLORS.blue, color: light ? COLORS.blue : 'white', textAlign: 'center', lineHeight: '42px', fontWeight: 600}}>h</span>Hearsay
</Interactive.Div>;

export const Set: React.FC<React.PropsWithChildren<{light?: boolean; illustration?: boolean; demo?: boolean}>> = ({light = false, illustration = false, demo = false, children}) => <AbsoluteFill style={{fontFamily: FONT, background: light ? COLORS.blue : COLORS.page, color: light ? 'white' : COLORS.ink, overflow: 'hidden'}}>
  <AbsoluteFill style={{background: light ? 'radial-gradient(ellipse at 80% 20%, rgba(255,255,255,.10), transparent 65%)' : 'radial-gradient(ellipse at 86% 28%, rgba(42,120,214,.09), transparent 55%)'}} />
  {children}
  <Brand light={light} />
  {(illustration || demo) && <Interactive.Div name="Example label" style={{position: 'absolute', left: 112, bottom: 46, fontSize: 32, color: light ? 'rgba(255,255,255,.85)' : COLORS.secondary}}>{demo ? 'Hearsay demo · fictional data' : 'Illustration · fictional example'}</Interactive.Div>}
</AbsoluteFill>;

export const Headline: React.FC<React.PropsWithChildren<{x?: number; y?: number; width?: number; size?: number; delay?: number; color?: string}>> = ({x = 112, y = 280, width = 820, size = 112, delay = 0, color, children}) => {
  const frame = useCurrentFrame();
  return <Interactive.Div name="Narrative headline" style={{position: 'absolute', left: x, top: y, width, fontSize: size, fontWeight: 600, lineHeight: 1.04, letterSpacing: '-.055em', color,
    opacity: progress(frame, delay, delay + 18), translate: `0 ${interpolate(frame, [delay, delay + 26], [38, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: OUT})}px`}}>{children}</Interactive.Div>;
};

export const Eyebrow: React.FC<React.PropsWithChildren<{x?: number; y?: number; light?: boolean}>> = ({x = 112, y = 225, light = false, children}) => <Interactive.Div name="Scene label" style={{position: 'absolute', left: x, top: y, fontSize: 32, letterSpacing: '.06em', color: light ? 'rgba(255,255,255,.82)' : COLORS.secondary}}>{children}</Interactive.Div>;

export const Website: React.FC<{width?: number; height?: number; title?: string}> = ({width = 690, height = 620, title = 'Notewell'}) => <Interactive.Div name="Illustrated website card" style={{width, height, background: COLORS.surface, border: '1px solid #d9dfe4', borderRadius: 28, overflow: 'hidden', boxShadow: '0 55px 95px rgba(15,38,64,.16), 0 8px 18px rgba(15,38,64,.07)', color: COLORS.ink}}>
  <div style={{height: 76, borderBottom: `1px solid ${COLORS.line}`, fontSize: 28, color: COLORS.secondary, padding: '24px 32px', display: 'flex', gap: 18, alignItems: 'center'}}><div style={{display: 'flex', gap: 8}}>{[0, 1, 2].map(i => <span key={i} style={{width: 10, height: 10, borderRadius: 10, background: '#b7bdc3'}} />)}</div>notewell.example</div>
  <div style={{margin: 44}}><div style={{background: COLORS.blue, color: 'white', borderRadius: 20, padding: 38, fontSize: 70, fontWeight: 600, letterSpacing: '-.045em', lineHeight: 1.04}}>{title}</div>
    <div style={{fontSize: 50, fontWeight: 600, lineHeight: 1.12, letterSpacing: '-.035em', marginTop: 38}}>Search your team's<br />meeting notes.</div>
    <div style={{height: 1, background: COLORS.line, marginTop: 34}} />
    <div style={{fontSize: 34, color: COLORS.secondary, marginTop: 26}}>A fictional product for our story</div>
  </div>
</Interactive.Div>;

export const Marker: React.FC<{width: number; start?: number; color?: string}> = ({width, start = 32, color = 'white'}) => {
  const frame = useCurrentFrame();
  const draw = progress(frame, start, start + 10, Easing.out(Easing.quad));
  return <svg width={width} height={40} viewBox={`0 0 ${width} 40`} style={{overflow: 'hidden'}}><g style={{clipPath: `inset(0 ${(1 - draw) * 100}% 0 0)`}}><path d={`M 4 26 Q ${width * .23} 12 ${width * .5} 18 T ${width - 5} 10`} fill="none" stroke={color} strokeWidth={12} strokeLinecap="round" /><path d={`M 18 30 Q ${width * .4} 24 ${width - 20} 17`} fill="none" stroke={color} opacity={.28} strokeWidth={4} strokeLinecap="round" /></g></svg>;
};

export const Caption: React.FC<React.PropsWithChildren<{delay?: number; light?: boolean}>> = ({delay = 36, light = false, children}) => {
  const frame = useCurrentFrame();
  return <Interactive.Div name="Supporting statement" style={{position: 'absolute', left: 112, bottom: 118, right: 112, fontSize: 60, lineHeight: 1.2, letterSpacing: '-.025em', color: light ? 'white' : COLORS.secondary, opacity: progress(frame, delay, delay + 20), translate: `0 ${(1 - progress(frame, delay, delay + 26)) * 16}px`}}>{children}</Interactive.Div>;
};
