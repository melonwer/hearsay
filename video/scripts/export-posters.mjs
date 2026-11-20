import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {
  REPO_ROOT,
  VIDEO_ROOT,
  formatBytes,
  loadTimelineMetadata,
  probeMedia,
  resolveBinary,
} from './media-utils.mjs';

function parseArgs(argv) {
  const options = {
    input: resolve(VIDEO_ROOT, 'out/hearsay-launch.mp4'),
    outPng: resolve(VIDEO_ROOT, 'out/video-poster.png'),
    outWebp: resolve(VIDEO_ROOT, 'out/film-poster.webp'),
    docsPng: resolve(REPO_ROOT, 'docs/video-poster.png'),
    docsWebp: resolve(REPO_ROOT, 'docs/film-poster.webp'),
    frame: null,
    time: null,
    quality: 86,
    remotionStill: false,
    outOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--frame' && argv[i + 1]) {
      options.frame = Number(argv[++i]);
    } else if (arg === '--time' && argv[i + 1]) {
      options.time = Number(argv[++i]);
    } else if (arg === '--quality' && argv[i + 1]) {
      options.quality = Number(argv[++i]);
    } else if (arg === '--remotion-still') {
      options.remotionStill = true;
    } else if (arg === '--out-only') {
      options.outOnly = true;
    } else if (arg === '--out-dir' && argv[i + 1]) {
      const dir = resolve(argv[++i]);
      options.outPng = resolve(dir, 'video-poster.png');
      options.outWebp = resolve(dir, 'film-poster.webp');
      options.outOnly = true;
    } else if (!arg.startsWith('-')) {
      options.input = resolve(arg);
    }
  }
  return options;
}

function chooseHeroTarget(options, media, timeline) {
  const fps = timeline?.fps ?? media?.fps ?? 30;
  const duration = media?.duration ?? (timeline?.totalFrames ? timeline.totalFrames / fps : 49);

  if (Number.isFinite(options.frame) && options.frame >= 0) {
    return {
      frame: Math.round(options.frame),
      timeSec: Number((options.frame / fps).toFixed(3)),
      source: 'cli-frame',
    };
  }
  if (Number.isFinite(options.time) && options.time >= 0) {
    const clamped = Math.min(Math.max(0, options.time), Math.max(0, duration - 0.1));
    return {
      frame: Math.round(clamped * fps),
      timeSec: Number(clamped.toFixed(3)),
      source: 'cli-time',
    };
  }
  if (Number.isFinite(timeline?.posterFrame)) {
    return {
      frame: timeline.posterFrame,
      timeSec: Number((timeline.posterFrame / fps).toFixed(3)),
      source: 'timeline-poster-frame',
    };
  }

  // Default hero frame: settled peak of the opening hook or X-Ray hero scene
  const scenes = timeline?.scenes ?? [];
  const preferred =
    scenes.find((s) => /xray|check|receipt|evidence/i.test(s.id)) ??
    scenes[0] ??
    null;
  if (preferred) {
    // 0.82 lands on the fully-settled payoff state (all bars, badges & verdicts complete, before exit fade)
    const frame = Math.round(preferred.from + preferred.duration * 0.82);
    return {
      frame,
      timeSec: Number((frame / fps).toFixed(3)),
      source: `scene:${preferred.id}`,
    };
  }

  const fallbackTime = Number(Math.min(3.0, duration * 0.15).toFixed(3));
  return {
    frame: Math.round(fallbackTime * fps),
    timeSec: fallbackTime,
    source: 'default-time',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ffmpeg = resolveBinary('ffmpeg');
  const timeline = await loadTimelineMetadata();
  const media = !options.remotionStill && existsSync(options.input) ? probeMedia(options.input) : null;

  if (!options.remotionStill && !media) {
    throw new Error(`Input MP4 not found: ${options.input} (or pass --remotion-still).`);
  }

  const target = chooseHeroTarget(options, media, timeline);
  mkdirSync(dirname(options.outPng), {recursive: true});
  mkdirSync(dirname(options.outWebp), {recursive: true});

  if (options.remotionStill) {
    execFileSync(
      'npx',
      [
        'remotion',
        'still',
        'src/index.ts',
        'HearsayLaunch',
        options.outPng,
        `--frame=${target.frame}`,
        '--log=error',
      ],
      {cwd: VIDEO_ROOT, stdio: 'inherit'},
    );
    execFileSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        options.outPng,
        '-frames:v',
        '1',
        '-c:v',
        'libwebp',
        '-quality',
        String(options.quality),
        '-compression_level',
        '6',
        '-y',
        options.outWebp,
      ],
      {stdio: 'pipe'},
    );
  } else {
    execFileSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        target.timeSec.toFixed(3),
        '-i',
        options.input,
        '-frames:v',
        '1',
        '-compression_level',
        '9',
        '-y',
        options.outPng,
      ],
      {stdio: 'pipe'},
    );
    execFileSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        target.timeSec.toFixed(3),
        '-i',
        options.input,
        '-frames:v',
        '1',
        '-c:v',
        'libwebp',
        '-quality',
        String(options.quality),
        '-compression_level',
        '6',
        '-y',
        options.outWebp,
      ],
      {stdio: 'pipe'},
    );
  }

  const pngSize = statSync(options.outPng).size;
  const webpSize = statSync(options.outWebp).size;
  if (pngSize === 0 || webpSize === 0) {
    throw new Error('Exported poster file is empty.');
  }

  if (!options.outOnly) {
    mkdirSync(dirname(options.docsPng), {recursive: true});
    copyFileSync(options.outPng, options.docsPng);
    copyFileSync(options.outWebp, options.docsWebp);
  }

  const pngProbe = probeMedia(options.outPng);
  const summary = {
    mode: options.remotionStill ? 'remotion-still' : 'mp4-extract',
    input: options.remotionStill ? 'src/index.ts#HearsayLaunch' : options.input,
    target,
    png: {
      out: options.outPng,
      docs: options.outOnly ? null : options.docsPng,
      dimensions: [pngProbe.video?.width ?? null, pngProbe.video?.height ?? null],
      sizeBytes: pngSize,
      sizeHuman: formatBytes(pngSize),
    },
    webp: {
      out: options.outWebp,
      docs: options.outOnly ? null : options.docsWebp,
      quality: options.quality,
      sizeBytes: webpSize,
      sizeHuman: formatBytes(webpSize),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(`[export-posters] ERROR: ${err.message}`);
  process.exit(1);
});
