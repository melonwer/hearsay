import {cancelRender, continueRender, delayRender, staticFile} from 'remotion';

export const FONT_FAMILIES = {
  sans: 'Hearsay Inter',
  mono: 'Hearsay Mono',
} as const;

type FontSpec = {
  family: string;
  file: string;
  weight: string;
  style?: string;
};

const BUNDLED_FONTS: readonly FontSpec[] = [
  {family: FONT_FAMILIES.sans, file: 'fonts/InterDisplay-Regular.otf', weight: '400'},
  {family: FONT_FAMILIES.sans, file: 'fonts/InterDisplay-SemiBold.otf', weight: '600'},
  {family: FONT_FAMILIES.sans, file: 'fonts/InterDisplay-Bold.otf', weight: '700'},
  {family: FONT_FAMILIES.mono, file: 'fonts/FiraMono-Regular.otf', weight: '400'},
  {family: FONT_FAMILIES.mono, file: 'fonts/FiraMono-Medium.otf', weight: '500'},
  {family: FONT_FAMILIES.mono, file: 'fonts/FiraMono-Bold.otf', weight: '700'},
];

let loadPromise: Promise<void> | null = null;

export const ensureFontsLoaded = (): Promise<void> => {
  if (loadPromise) {
    return loadPromise;
  }

  const handle = delayRender('Load bundled Hearsay Inter & Fira Mono fonts');
  loadPromise = Promise.all(
    BUNDLED_FONTS.map(async ({family, file, weight, style = 'normal'}) => {
      const face = new FontFace(family, `url(${staticFile(file)})`, {
        weight,
        style,
      });
      const loaded = await face.load();
      document.fonts.add(loaded);
    }),
  )
    .then(() => {
      continueRender(handle);
    })
    .catch((err) => {
      cancelRender(err);
    });

  return loadPromise;
};

// Trigger font loading eagerly on module import so Remotion delays rendering until fonts are ready.
void ensureFontsLoaded();
