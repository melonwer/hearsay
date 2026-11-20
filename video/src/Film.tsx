import React from 'react';
import {Audio} from '@remotion/media';
import {AbsoluteFill, Sequence, interpolate, staticFile} from 'remotion';
import {PALETTE} from './design';
import {ensureFontsLoaded} from './fonts';
import {
  CommandScene,
  InvisibleScene,
  ReceiptScene,
} from './scenes/Act1Opening';
import {FixScene, OutroScene, PayoffScene} from './scenes/Act2Forensics';
import {
  MUSIC,
  PREMOUNT_FRAMES,
  SCENE_LIST,
  SFX,
  TOTAL,
  type SceneId,
} from './timeline';

// Ensure bundled Inter Display & Fira Mono fonts delay rendering until ready.
void ensureFontsLoaded();

type SceneComponent = React.FC<{duration: number}>;

const SCENE_COMPONENTS: Record<SceneId, SceneComponent> = {
  invisible: InvisibleScene,
  command: CommandScene,
  receipt: ReceiptScene,
  fix: FixScene,
  payoff: PayoffScene,
  outro: OutroScene,
};

export const SCENES = SCENE_LIST.map((scene) => ({
  ...scene,
  component: SCENE_COMPONENTS[scene.id],
}));

export const MusicBed: React.FC<{volume?: number}> = ({
  volume = MUSIC.volume,
}) => (
  <Audio
    src={staticFile(MUSIC.src)}
    trimBefore={MUSIC.trimBefore}
    volume={(frame) =>
      volume *
      interpolate(
        frame,
        [0, MUSIC.fadeInFrames, TOTAL - MUSIC.fadeOutFrames, TOTAL - 1],
        [0, 1, 1, 0],
        {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
      )
    }
  />
);

export const HearsayFilm: React.FC<{bgm?: boolean}> = ({bgm = true}) => (
  <AbsoluteFill style={{backgroundColor: PALETTE.night}}>
    {SCENES.map(({id, label, component: Scene, from, duration}) => (
      <Sequence
        key={id}
        name={label}
        from={from}
        durationInFrames={duration}
        premountFor={PREMOUNT_FRAMES}
      >
        <Scene duration={duration} />
      </Sequence>
    ))}

    {bgm && <MusicBed />}

    {SFX.map((cue, idx) => (
      <Sequence
        key={`${cue.from}-${idx}`}
        name={cue.action}
        from={cue.from}
        durationInFrames={cue.duration}
        premountFor={PREMOUNT_FRAMES}
      >
        <Audio src={staticFile(cue.src)} volume={cue.volume} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
