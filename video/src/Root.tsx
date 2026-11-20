import React from 'react';
import {Composition} from 'remotion';
import {HearsayFilm} from './Film';
import {FPS, HEIGHT, TOTAL, WIDTH} from './timeline';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="HearsayLaunch"
      component={HearsayFilm}
      defaultProps={{bgm: true}}
      durationInFrames={TOTAL}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
