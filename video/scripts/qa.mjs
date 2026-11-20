import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {
  VIDEO_ROOT,
  formatBytes,
  loadTimelineMetadata,
  probeMedia,
  resolveBinary,
  slugify,
} from './media-utils.mjs';

function parseArgs(argv) {
  const options = {
    file: null,
    nobgm: null,
    outDir: resolve(VIDEO_ROOT, 'out/qa'),
    requireNobgm: false,
    ignoreTimelineTotal: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--nobgm' && argv[i + 1]) {
      options.nobgm = resolve(argv[++i]);
    } else if (arg === '--out-dir' && argv[i + 1]) {
      options.outDir = resolve(argv[++i]);
    } else if (arg === '--require-nobgm') {
      options.requireNobgm = true;
    } else if (arg === '--ignore-timeline-total') {
      options.ignoreTimelineTotal = true;
    } else if (!arg.startsWith('-') && !options.file) {
      options.file = resolve(arg);
    }
  }
  if (!options.file) {
    options.file = resolve(VIDEO_ROOT, 'out/hearsay-launch.mp4');
  }
  if (!options.nobgm) {
    const dir = dirname(options.file);
    const stem = basename(options.file, '.mp4');
    options.nobgm = resolve(dir, `${stem}-nobgm.mp4`);
  }
  return options;
}

function parseEbur128(text) {
  if (!text) return null;
  const integrated = text.match(/Integrated loudness:\s*[\r\n]+\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/i);
  const lra = text.match(/Loudness range:\s*[\r\n]+\s*LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/i);
  const truePeak = text.match(/True peak:\s*[\r\n]+\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/i);
  if (!integrated && !lra && !truePeak) return null;
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    loudnessRangeLu: lra ? Number(lra[1]) : null,
    truePeakDbtp: truePeak ? Number(truePeak[1]) : null,
  };
}

function captureEbur128(ffmpeg, filePath) {
  const res = spawnSync(
    ffmpeg,
    ['-hide_banner', '-i', filePath, '-vn', '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );
  return parseEbur128(res.stderr ?? '');
}

function analyzeAudio(ffmpeg, filePath) {
  // Full stream decode integrity verification
  execFileSync(
    ffmpeg,
    ['-v', 'error', '-i', filePath, '-c:v', 'rawvideo', '-c:a', 'pcm_s16le', '-f', 'null', '-'],
    {stdio: 'pipe'},
  );

  // Raw PCM peak, RMS, and digital clip counter
  const pcm = execFileSync(
    ffmpeg,
    ['-v', 'error', '-i', filePath, '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', '-'],
    {maxBuffer: 128 * 1024 * 1024},
  );
  let peak = 0;
  let energy = 0;
  let clippedSamples = 0;
  const totalSamples = Math.floor(pcm.length / 2);
  for (let i = 0; i < pcm.length; i += 2) {
    const raw = pcm.readInt16LE(i);
    if (raw >= 32767 || raw <= -32768) clippedSamples += 1;
    const sample = raw / 32768;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    energy += sample * sample;
  }
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const rms = totalSamples > 0 ? Math.sqrt(energy / totalSamples) : 0;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  return {
    peakDb: Number(peakDb.toFixed(2)),
    rmsDb: Number(rmsDb.toFixed(2)),
    clippedSamples,
    ebur128: captureEbur128(ffmpeg, filePath),
  };
}

function computeKeyframes(duration, fps, timeline) {
  const safeStart = Math.min(0.15, duration * 0.02);
  const safeEnd = Math.max(safeStart + 0.1, duration - 0.15);
  const clampTime = (t) => Number(Math.min(safeEnd, Math.max(safeStart, t)).toFixed(3));

  const keyframes = [];
  const effectiveFps = timeline?.fps ?? fps ?? 30;
  const scenes = timeline?.scenes ?? [];

  if (scenes.length > 0) {
    for (const scene of scenes) {
      const startSec = scene.from / effectiveFps;
      const durSec = scene.duration / effectiveFps;
      if (startSec >= duration) continue;
      const clampedDur = Math.min(durSec, duration - startSec);
      const fractions = clampedDur >= 3.2 ? [0.22, 0.54, 0.84] : [0.28, 0.74];
      fractions.forEach((fraction, idx) => {
        const timeSec = clampTime(startSec + clampedDur * fraction);
        const frame = Math.min(
          Math.max(0, Math.round(timeSec * effectiveFps)),
          Math.max(0, Math.round(duration * effectiveFps) - 1),
        );
        keyframes.push({
          scene: scene.id,
          beat: idx + 1,
          timeSec,
          frame,
        });
      });
    }
  }

  // Fallback or supplement if scenes were unavailable or yielded too few samples
  if (keyframes.length < 12) {
    keyframes.length = 0;
    const count = 16;
    for (let i = 0; i < count; i += 1) {
      const ratio = count === 1 ? 0.5 : i / (count - 1);
      const timeSec = clampTime(duration * (0.03 + ratio * 0.94));
      keyframes.push({
        scene: `sample`,
        beat: i + 1,
        timeSec,
        frame: Math.round(timeSec * effectiveFps),
      });
    }
  }

  // Deduplicate timestamps within 0.08s
  const deduped = [];
  for (const item of keyframes.sort((a, b) => a.timeSec - b.timeSec)) {
    if (deduped.length === 0 || item.timeSec - deduped[deduped.length - 1].timeSec >= 0.08) {
      deduped.push(item);
    }
  }
  return deduped;
}

function selectContactSheetFrames(extractedFrames) {
  const total = extractedFrames.length;
  if (total <= 16) {
    if (total === 15) return {cols: 5, rows: 3, items: extractedFrames};
    const cols = Math.min(4, Math.max(1, total));
    const rows = Math.ceil(total / cols);
    return {cols, rows, items: extractedFrames};
  }
  // Pick 16 evenly spaced frames across all extracted frames so every scene is represented
  const target = 16;
  const selected = [];
  for (let i = 0; i < target; i += 1) {
    const idx = Math.round((i * (total - 1)) / (target - 1));
    selected.push(extractedFrames[idx]);
  }
  return {cols: 4, rows: 4, items: selected};
}

function buildContactSheet(ffmpeg, selected, outputPath) {
  const {cols, rows, items} = selected;
  const inputs = [];
  const concatInputs = [];
  items.forEach((item, index) => {
    inputs.push('-i', item.path);
    concatInputs.push(`[${index}:v]`);
  });

  const filterComplex = [
    `${concatInputs.join('')}concat=n=${items.length}:v=1:a=0`,
    `scale=640:360:flags=lanczos`,
    `tile=${cols}x${rows}:padding=8:margin=12:color=0x0b0b0f`,
  ].join(',');

  execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filterComplex, '-frames:v', '1', '-y', outputPath],
    {stdio: 'pipe'},
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.file)) {
    throw new Error(`Input video not found: ${options.file}`);
  }

  mkdirSync(options.outDir, {recursive: true});
  const ffmpeg = resolveBinary('ffmpeg');
  const timeline = await loadTimelineMetadata();

  // 1. Probe & validate primary render
  const primary = probeMedia(options.file, {countFrames: true});
  if (!primary.video) throw new Error('Primary video has no video stream.');
  if (!primary.audio) throw new Error('Primary video has no audio stream.');
  if (primary.video.width !== 1920 || primary.video.height !== 1080) {
    throw new Error(`Expected 1920x1080 video, got ${primary.video.width}x${primary.video.height}.`);
  }
  if (timeline?.fps && primary.video.r_frame_rate !== `${timeline.fps}/1`) {
    throw new Error(`Expected ${timeline.fps}/1 fps (from timeline.ts), got ${primary.video.r_frame_rate}.`);
  }
  if (!options.ignoreTimelineTotal && timeline?.totalFrames && primary.frameCount !== timeline.totalFrames) {
    throw new Error(`Expected ${timeline.totalFrames} frames (from timeline.ts), got ${primary.frameCount}.`);
  }

  const audioLevels = analyzeAudio(ffmpeg, options.file);
  if (audioLevels.peakDb >= -0.01 || audioLevels.clippedSamples > 0) {
    throw new Error(
      `Primary audio clips (peak ${audioLevels.peakDb} dBFS, ${audioLevels.clippedSamples} full-scale samples).`,
    );
  }
  if (audioLevels.rmsDb <= -50) {
    throw new Error(`Primary audio is unexpectedly silent (RMS ${audioLevels.rmsDb} dBFS).`);
  }

  // Export mono WAV mix for quick audio inspection
  const mixWavPath = join(options.outDir, 'mix.wav');
  execFileSync(
    ffmpeg,
    ['-v', 'error', '-i', options.file, '-vn', '-ar', '48000', '-ac', '1', '-y', mixWavPath],
    {stdio: 'pipe'},
  );

  // 2. Verify no-BGM parity if hearsay-launch-nobgm.mp4 exists (or if --require-nobgm)
  let nobgmReport = {
    path: options.nobgm,
    status: 'missing',
  };
  if (existsSync(options.nobgm)) {
    const nobgm = probeMedia(options.nobgm, {countFrames: true});
    if (!nobgm.video || !nobgm.audio) {
      throw new Error('nobgm video is missing a video or audio stream.');
    }
    if (
      nobgm.video.width !== primary.video.width ||
      nobgm.video.height !== primary.video.height ||
      nobgm.video.r_frame_rate !== primary.video.r_frame_rate ||
      nobgm.frameCount !== primary.frameCount
    ) {
      throw new Error(
        `nobgm parity mismatch: expected ${primary.video.width}x${primary.video.height} @ ${primary.video.r_frame_rate} (${primary.frameCount}f), ` +
          `got ${nobgm.video.width}x${nobgm.video.height} @ ${nobgm.video.r_frame_rate} (${nobgm.frameCount}f).`,
      );
    }
    if (Math.abs(nobgm.duration - primary.duration) > 0.05) {
      throw new Error(
        `nobgm duration mismatch: primary=${primary.duration.toFixed(3)}s vs nobgm=${nobgm.duration.toFixed(3)}s.`,
      );
    }
    const nobgmAudio = analyzeAudio(ffmpeg, options.nobgm);
    if (nobgmAudio.peakDb >= -0.01 || nobgmAudio.clippedSamples > 0) {
      throw new Error(`nobgm audio clips (peak ${nobgmAudio.peakDb} dBFS).`);
    }
    if (nobgmAudio.peakDb <= -60) {
      throw new Error(`nobgm audio is completely silent (peak ${nobgmAudio.peakDb} dBFS); expected SFX.`);
    }
    if (nobgmAudio.rmsDb >= audioLevels.rmsDb) {
      throw new Error(
        `nobgm RMS (${nobgmAudio.rmsDb} dBFS) is not quieter than primary mix (${audioLevels.rmsDb} dBFS); verify BGM toggle.`,
      );
    }
    nobgmReport = {
      path: options.nobgm,
      status: 'verified',
      sizeBytes: nobgm.sizeBytes,
      sizeHuman: formatBytes(nobgm.sizeBytes),
      frameCount: nobgm.frameCount,
      durationSeconds: Number(nobgm.duration.toFixed(3)),
      levels: nobgmAudio,
    };
  } else if (options.requireNobgm) {
    throw new Error(`Required no-BGM file missing: ${options.nobgm}`);
  }

  // 3. Clean stale v2 QA frames and extract new individual PNGs + contact sheet
  for (const entry of readdirSync(options.outDir)) {
    if (/^v2-frame-.*\.png$/.test(entry) || entry === 'v2-contact-sheet.png') {
      rmSync(join(options.outDir, entry), {force: true});
    }
  }

  const keyframes = computeKeyframes(primary.duration, primary.fps, timeline);
  const extractedFrames = [];
  for (let i = 0; i < keyframes.length; i += 1) {
    const kf = keyframes[i];
    const indexStr = String(i + 1).padStart(2, '0');
    const filename = `v2-frame-${indexStr}-${slugify(kf.scene)}.png`;
    const framePath = join(options.outDir, filename);
    execFileSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        kf.timeSec.toFixed(3),
        '-i',
        options.file,
        '-frames:v',
        '1',
        '-y',
        framePath,
      ],
      {stdio: 'pipe'},
    );
    extractedFrames.push({
      index: i + 1,
      scene: kf.scene,
      beat: kf.beat,
      frame: kf.frame,
      timeSec: kf.timeSec,
      filename,
      path: framePath,
    });
  }

  const contactSelection = selectContactSheetFrames(extractedFrames);
  const contactSheetPath = join(options.outDir, 'v2-contact-sheet.png');
  buildContactSheet(ffmpeg, contactSelection, contactSheetPath);

  const report = {
    file: options.file,
    sizeBytes: primary.sizeBytes,
    sizeHuman: formatBytes(primary.sizeBytes),
    totalFrames: primary.frameCount,
    fps: primary.fps,
    durationSeconds: Number(primary.duration.toFixed(3)),
    dimensions: [primary.video.width, primary.video.height],
    codec: primary.video.codec_name,
    audioCodec: primary.audio.codec_name,
    audioSampleRate: Number(primary.audio.sample_rate),
    audioChannels: primary.audio.channels,
    decode: 'Entire video and audio decoded without errors',
    levels: audioLevels,
    nobgmParity: nobgmReport,
    contactSheet: {
      path: contactSheetPath,
      grid: `${contactSelection.cols}x${contactSelection.rows}`,
      tiles: contactSelection.items.map((item) => item.filename),
    },
    scenes: timeline?.scenes ?? [],
    frames: extractedFrames.map(({path: _p, ...rest}) => rest),
  };

  writeFileSync(join(options.outDir, 'technical.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(`[qa] ERROR: ${err.message}`);
  process.exit(1);
});
