import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ffmpegPath from 'ffmpeg-static';

export const VIDEO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Resolve ffmpeg or ffprobe cleanly across local dev & CI.
 * Prefers ffmpeg-static for ffmpeg (includes libwebp + full filter set)
 * and Remotion's bundled compositor binary for ffprobe.
 */
export function resolveBinary(name) {
  const envKey = name.toUpperCase();
  if (process.env[envKey]) {
    return process.env[envKey];
  }
  const bundled = resolve(
    VIDEO_ROOT,
    `node_modules/@remotion/compositor-linux-x64-gnu/${name}`,
  );
  if (name === 'ffmpeg') {
    if (ffmpegPath && existsSync(ffmpegPath)) return ffmpegPath;
    if (existsSync(bundled)) return bundled;
    return 'ffmpeg';
  }
  if (existsSync(bundled)) return bundled;
  return name;
}

export function parseFrameRate(rate) {
  if (!rate || typeof rate !== 'string') return null;
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return num / den;
    }
  }
  const parsed = Number(rate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function probeMedia(filePath, {countFrames = false} = {}) {
  const ffprobe = resolveBinary('ffprobe');
  const args = ['-v', 'error'];
  if (countFrames) args.push('-count_frames');
  args.push('-show_streams', '-show_format', '-of', 'json', filePath);

  const raw = execFileSync(ffprobe, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const data = JSON.parse(raw);
  const video = data.streams?.find((s) => s.codec_type === 'video') ?? null;
  const audio = data.streams?.find((s) => s.codec_type === 'audio') ?? null;
  const duration = Number(data.format?.duration ?? video?.duration ?? 0);
  const fps = parseFrameRate(video?.r_frame_rate ?? video?.avg_frame_rate);
  const frameCount =
    Number(video?.nb_read_frames) ||
    Number(video?.nb_frames) ||
    (fps && duration > 0 ? Math.round(duration * fps) : 0);

  return {
    raw: data,
    video,
    audio,
    duration,
    fps,
    frameCount,
    sizeBytes: Number(data.format?.size ?? 0),
  };
}

function normalizeSceneEntry(id, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const from = Number(entry.from ?? entry.start ?? entry.startFrame);
  const duration = Number(entry.duration ?? entry.durationInFrames);
  if (!Number.isFinite(from) || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  return {
    id: String(entry.id ?? entry.name ?? id),
    from,
    duration,
  };
}

/**
 * Dynamically inspects video/src/timeline.ts without hardcoding scene keys.
 * Safely returns null if timeline.ts is mid-edit or uses an unexpected format.
 */
export async function loadTimelineMetadata() {
  const timelinePath = resolve(VIDEO_ROOT, 'src/timeline.ts');
  if (!existsSync(timelinePath)) return null;
  try {
    const mod = await import(pathToFileURL(timelinePath).href);
    const fps = Number(mod.FPS);
    const totalFrames = Number(mod.TOTAL ?? mod.TOTAL_FRAMES ?? mod.DURATION_IN_FRAMES);
    const posterFrame = Number(mod.POSTER_FRAME);
    const rawScenes =
      mod.SCENE_LIST ?? mod.TIMELINE ?? mod.SCENES ?? mod.SHOTS ?? mod.SEGMENTS ?? null;

    const scenes = [];
    const seenSpan = new Set();
    const pushUnique = (normalized) => {
      if (!normalized) return;
      const key = `${normalized.from}:${normalized.duration}`;
      if (seenSpan.has(key)) return;
      seenSpan.add(key);
      scenes.push(normalized);
    };

    if (Array.isArray(rawScenes)) {
      rawScenes.forEach((entry, index) => {
        pushUnique(normalizeSceneEntry(`scene-${index + 1}`, entry));
      });
    } else if (rawScenes && typeof rawScenes === 'object') {
      for (const [key, value] of Object.entries(rawScenes)) {
        pushUnique(normalizeSceneEntry(key, value));
      }
    }
    scenes.sort((a, b) => a.from - b.from);

    const previewBeats = Array.isArray(mod.PREVIEW_BEATS) ? mod.PREVIEW_BEATS : null;

    return {
      fps: Number.isFinite(fps) && fps > 0 ? fps : null,
      totalFrames: Number.isFinite(totalFrames) && totalFrames > 0 ? totalFrames : null,
      posterFrame: Number.isFinite(posterFrame) && posterFrame >= 0 ? posterFrame : null,
      previewBeats,
      scenes,
    };
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'scene';
}
