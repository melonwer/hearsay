import {cancelRender, continueRender, delayRender, staticFile} from 'remotion';

const fonts = delayRender('Load bundled Hearsay fonts');
Promise.all([['Regular', '400'], ['SemiBold', '600'], ['Bold', '700']].map(async ([name, weight]) => {
  const face = new FontFace('Hearsay Inter', `url(${staticFile(`fonts/InterDisplay-${name}.otf`)})`, {weight});
  document.fonts.add(await face.load());
})).then(() => continueRender(fonts)).catch(cancelRender);
