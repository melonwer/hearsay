import {Composition} from 'remotion';
import {HearsayFilm} from './Film';
import {TOTAL} from './timeline';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition id="HearsayLaunch" component={HearsayFilm} defaultProps={{bgm: true}}
      durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
  );
};
