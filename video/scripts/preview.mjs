import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {
  REPO_ROOT,
  VIDEO_ROOT,
  formatBytes,
  loadTimelineMetadata,
  probeMedia,
  resolveBinary,
} from './media-utils.mjs';

const DEFAULT_MAX_BYTES = 1_500_000; // Target safely under ~1.5 MB for GitHub README

const QUALITY_PRESETS = [
  {width: 800, fps: 14, maxColors: 128, bayerScale: 3},
  {width: 760, fps: 13, maxColors: 112, bayerScale: 4},
  {width: 720, fps: 12, maxColors: 96, bayerScale: 4},
  {width: 720, fps: 12, maxColors: 64, bayerScale: 5},
  {width: 720, fps: 12, maxColors: 48, bayerScale: 5},
];

function parseArgs(argv) {
  const options = {
    input: null,
    output: resolve(VIDEO_ROOT, 'out/hearsay-preview.gif'),
    docsOutput: resolve(REPO_ROOT, 'docs/hearsay-preview.gif'),
    outOnly: false,
    maxBytes: DEFAULT_MAX_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-only') {
      options.outOnly = true;
    } else if (arg === '--output' && argv[i + 1]) {
      options.output = resolve(argv[++i]);
      options.outOnly = true;
    } else if (arg === '--max-bytes' && argv[i + 1]) {
      options.maxBytes = Number(argv[++i]);
    } else if (!arg.startsWith('-') && !options.input) {
      options.input = resolve(arg);
    }
  }
  if (!options.input) {
    const rendered = resolve(VIDEO_ROOT, 'out/hearsay-launch.mp4');
    const published = resolve(REPO_ROOT, 'docs/hearsay-launch.mp4');
    options.input = existsSync(rendered) ? rendered : published;
  }
  return options;
}

function selectHighlightBeats(duration, fps, timeline) {
  const effectiveFps = timeline?.fps ?? fps ?? 30;
  const clampBeat = (start, len, label) => {
    const safeLen = Math.max(0.6, Math.min(len, duration * 0.25));
    const maxStart = Math.max(0, duration - safeLen - 0.05);
    const safeStart = Math.max(0.05, Math.min(start, maxStart));
    return {
      label,
      start: Number(safeStart.toFixed(3)),
      duration: Number(safeLen.toFixed(3)),
    };
  };

  // 1. Explicit PREVIEW_BEATS override from timeline.ts if provided
  if (timeline?.previewBeats?.length) {
    return timeline.previewBeats.map((b, idx) => {
      const start =
        typeof b.start === 'number'
          ? b.start
          : typeof b.from === 'number'
            ? b.from / effectiveFps
            : 0;
      const len =
        typeof b.durationSec === 'number'
          ? b.durationSec
          : typeof b.duration === 'number'
            ? b.duration > 15
              ? b.duration / effectiveFps
              : b.duration
            : 1.15;
      return clampBeat(start, len, b.label ?? `beat-${idx + 1}`);
    });
  }

  // 2. Sample 6-8 punchy highlight beats across all scenes from timeline.ts
  const scenes = timeline?.scenes ?? [];
  if (scenes.length >= 2) {
    let chosenScenes = scenes;
    if (scenes.length > 8) {
      // Pick 7 evenly distributed scenes including opening and outro
      chosenScenes = Array.from({length: 7}, (_, i) => {
        const idx = Math.round((i * (scenes.length - 1)) / 6);
        return scenes[idx];
      });
    }

    const totalTargetSec = 8.4;
    const perBeatSec = Math.min(1.25, Math.max(0.95, totalTargetSec / chosenScenes.length));
    const beats = chosenScenes.map((scene, idx) => {
      const sceneStart = scene.from / effectiveFps;
      const sceneDur = scene.duration / effectiveFps;
      const beatDur = Math.min(perBeatSec, Math.max(0.75, sceneDur * 0.45));
      // Land on the settled hero payoff (~70% in; ~62% on outro before closing fade)
      const anchor = idx === chosenScenes.length - 1 ? 0.62 : 0.70;
      const start = sceneStart + Math.max(0.2, sceneDur * anchor - beatDur * 0.5);
      return clampBeat(start, beatDur, scene.id);
    });

    // Ensure at least 6 beats by sampling a second highlight in the longest scenes if needed
    if (beats.length < 6) {
      const extraNeeded = 6 - beats.length;
      const longest = [...scenes]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, extraNeeded);
      for (const scene of longest) {
        const sceneStart = scene.from / effectiveFps;
        const sceneDur = scene.duration / effectiveFps;
        beats.push(clampBeat(sceneStart + sceneDur * 0.68, 1.0, `${scene.id}-2`));
      }
      beats.sort((a, b) => a.start - b.start);
    }

    return beats;
  }

  // 3. Fallback: 7 evenly spread highlight beats computed purely from ffprobe duration
  const beatCount = 7;
  const beatDur = 1.15;
  const usableStart = Math.min(0.6, duration * 0.04);
  const usableEnd = Math.max(usableStart + beatDur, duration - beatDur - 0.3);
  const span = Math.max(0.1, usableEnd - usableStart);
  return Array.from({length: beatCount}, (_, i) => {
    const t = usableStart + (span * i) / (beatCount - 1);
    return clampBeat(t, beatDur, `beat-${i + 1}`);
  });
}

function buildTrimConcatFilter(beats, {fps, width}) {
  const parts = [];
  const labels = [];
  beats.forEach((beat, idx) => {
    const end = (beat.start + beat.duration).toFixed(3);
    parts.push(`[0:v]trim=start=${beat.start.toFixed(3)}:end=${end},setpts=PTS-STARTPTS[s${idx}]`);
    labels.push(`[s${idx}]`);
  });
  parts.push(
    `${labels.join('')}concat=n=${beats.length}:v=1:a=0,fps=${fps},scale=${width}:-1:flags=lanczos[v]`,
  );
  return parts.join(';');
}

function renderTwoPassGif(ffmpeg, inputPath, outputPath, beats, preset, tempDir) {
  const palettePath = join(tempDir, `palette-${preset.width}-${preset.fps}-${preset.maxColors}.png`);
  const baseFilter = buildTrimConcatFilter(beats, preset);

  // Pass 1: generate optimal palette across all sampled highlight beats
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-filter_complex',
      `${baseFilter};[v]palettegen=max_colors=${preset.maxColors}:stats_mode=diff:reserve_transparent=0[p]`,
      '-map',
      '[p]',
      '-frames:v',
      '1',
      '-y',
      palettePath,
    ],
    {stdio: 'pipe'},
  );

  // Pass 2: apply palette with Bayer dithering and rectangle diff optimization
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-i',
      palettePath,
      '-filter_complex',
      `${baseFilter};[v][1:v]paletteuse=dither=bayer:bayer_scale=${preset.bayerScale}:diff_mode=rectangle`,
      '-an',
      '-loop',
      '0',
      '-y',
      outputPath,
    ],
    {stdio: 'pipe'},
  );

  return statSync(outputPath).size;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.input)) {
    throw new Error(`Input video not found: ${options.input}`);
  }

  const ffmpeg = resolveBinary('ffmpeg');
  const media = probeMedia(options.input);
  if (!media.video || media.duration <= 0) {
    throw new Error(`Could not read video metadata from ${options.input}`);
  }

  const timeline = await loadTimelineMetadata();
  const beats = selectHighlightBeats(media.duration, media.fps, timeline);
  mkdirSync(dirname(options.output), {recursive: true});

  const tempDir = mkdtempSync(join(tmpdir(), 'hearsay-gif-'));
  let chosenPreset = QUALITY_PRESETS[QUALITY_PRESETS.length - 1];
  let finalSize = 0;

  try {
    for (const preset of QUALITY_PRESETS) {
      const size = renderTwoPassGif(ffmpeg, options.input, options.output, beats, preset, tempDir);
      chosenPreset = preset;
      finalSize = size;
      if (size <= options.maxBytes) {
        break;
      }
    }
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }

  if (!options.outOnly) {
    mkdirSync(dirname(options.docsOutput), {recursive: true});
    copyFileSync(options.output, options.docsOutput);
  }

  const gifProbe = probeMedia(options.output);
  const totalGifSeconds = beats.reduce((sum, b) => sum + b.duration, 0);
  const summary = {
    input: options.input,
    output: options.output,
    docsOutput: options.outOnly ? null : options.docsOutput,
    dimensions: [gifProbe.video?.width ?? chosenPreset.width, gifProbe.video?.height ?? null],
    fps: chosenPreset.fps,
    maxColors: chosenPreset.maxColors,
    bayerScale: chosenPreset.bayerScale,
    beatCount: beats.length,
    totalDurationSeconds: Number(totalGifSeconds.toFixed(2)),
    sizeBytes: finalSize,
    sizeHuman: formatBytes(finalSize),
    withinBudget: finalSize <= options.maxBytes,
    beats,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(`[preview] ERROR: ${err.message}`);
  process.exit(1);
});
