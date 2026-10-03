import React from 'react';
import {Audio} from '@remotion/media';
import {AbsoluteFill, Sequence, interpolate, staticFile} from 'remotion';
import {Agent, Built, Buyer, Change, Evidence, Outro, Question, Repeat} from './Scenes';
import {COLORS} from './visuals';
import {COPY, MUSIC, SFX, SHOTS, TOTAL} from './timeline';

export const SCENES = [
  {id: 'built', label: 'Something worth finding', component: Built, props: COPY.built, ...SHOTS.built},
  {id: 'buyer', label: 'The buying conversation', component: Buyer, props: COPY.buyer, ...SHOTS.buyer},
  {id: 'question', label: 'Would your name come up?', component: Question, props: COPY.question, ...SHOTS.question},
  {id: 'agent', label: 'Your existing agent', component: Agent, props: COPY.agent, ...SHOTS.agent},
  {id: 'evidence', label: 'Answers and evidence', component: Evidence, props: COPY.evidence, ...SHOTS.evidence},
  {id: 'change', label: 'A change to review', component: Change, props: COPY.change, ...SHOTS.change},
  {id: 'repeat', label: 'The next observation', component: Repeat, props: COPY.repeat, ...SHOTS.repeat},
  {id: 'outro', label: 'Hearsay', component: Outro, props: COPY.outro, ...SHOTS.outro},
];
export const MusicBed: React.FC<{volume?: number}> = ({volume = MUSIC.volume}) => <Audio src={staticFile(MUSIC.src)} trimBefore={MUSIC.trimBefore} volume={frame => volume * interpolate(frame, [0, 18, TOTAL - 45, TOTAL - 1], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} />;
export const HearsayFilm: React.FC<{bgm?: boolean}> = ({bgm = true}) => <AbsoluteFill style={{background: COLORS.page}}>
  {SCENES.map(({id, label, component: Scene, props, from, duration}) => <Sequence key={id} name={label} from={from} durationInFrames={duration}><Scene {...props} duration={duration} /></Sequence>)}
  {bgm && <MusicBed />}
  {SFX.map((s, i) => <Sequence key={i} name={s.action} from={s.from} durationInFrames={s.duration}><Audio src={staticFile(s.src)} volume={s.volume} /></Sequence>)}
</AbsoluteFill>;
