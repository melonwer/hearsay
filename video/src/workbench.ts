import {SCENES, HearsayFilm, MusicBed} from './Film';
import {COLORS} from './visuals';
import {MUSIC, SFX, TOTAL} from './timeline';

export const WORKBENCH = {
  name: 'Hearsay · The conversation you never see',
  fps: 30, width: 1920, height: 1080, total: TOTAL, background: COLORS.page,
  shots: SCENES.map(scene => ({...scene, schema: Object.entries(scene.props).map(([key, value]) => ({type: 'textarea', key, label: key === 'title' ? 'Headline' : 'Supporting copy', default: value}))})),
  transitions: [], captions: [],
  overlays: [{id: 'music', label: 'Music bed', from: 0, duration: TOTAL, component: MusicBed, props: {volume: MUSIC.volume}, schema: [{type: 'slider', key: 'volume', label: 'Music volume', default: MUSIC.volume, min: 0, max: 1, step: .01}]}],
  sfx: SFX.map(({from, duration, src, volume}) => ({from, duration, src, volume})),
  bgm: [],
  order: ['transitions', 'captions', 'overlays'],
  original: HearsayFilm,
};
