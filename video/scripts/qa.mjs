import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import {FPS, SHOTS, TOTAL} from '../src/timeline.ts';

const file = resolve(process.argv[2] ?? 'out/hearsay-launch.mp4');
const output = resolve('out/qa');
mkdirSync(output, {recursive: true});
const binary = name => {
  const bundled = resolve(`node_modules/@remotion/compositor-linux-x64-gnu/${name}`);
  return process.env[name.toUpperCase()] ?? (name === 'ffmpeg' && ffmpegPath ? ffmpegPath : existsSync(bundled) ? bundled : name);
};
const ffmpeg = binary('ffmpeg');
const probe = JSON.parse(execFileSync(binary('ffprobe'), ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], {encoding: 'utf8'}));
const video = probe.streams.find(stream => stream.codec_type === 'video');
const audio = probe.streams.find(stream => stream.codec_type === 'audio');
if (video?.width !== 1920 || video?.height !== 1080 || video?.r_frame_rate !== `${FPS}/1` || Number(video?.nb_read_frames) !== TOTAL || !audio) {
  throw new Error('The exported film has unexpected dimensions, timing, frame count, or no audio.');
}
execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-c:v', 'rawvideo', '-c:a', 'pcm_s16le', '-f', 'null', '-'], {stdio: 'pipe'});
const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', '-'], {maxBuffer: 64 * 1024 * 1024});
let peak = 0;
let energy = 0;
for (let index = 0; index < pcm.length; index += 2) {
  const sample = pcm.readInt16LE(index) / 32768;
  peak = Math.max(peak, Math.abs(sample));
  energy += sample * sample;
}
const levels = {peakDb: 20 * Math.log10(peak), rmsDb: 10 * Math.log10(energy / (pcm.length / 2))};
if (levels.peakDb >= -.01) throw new Error('The exported audio reaches full scale. Check the mix for clipping.');
const frames = [...new Set([
  ...Object.values(SHOTS).flatMap(({from, duration}) => [from, from + 26, from + Math.round(duration * .65), from + duration - 1]),
  SHOTS.evidence.from + 65, SHOTS.evidence.from + 155,
])].sort((a, b) => a - b);
for (const frame of frames) {
  execFileSync(ffmpeg, ['-v', 'error', '-ss', (frame / FPS).toFixed(6), '-i', file, '-frames:v', '1', '-y', `${output}/f${String(frame).padStart(4, '0')}.png`], {stdio: 'pipe'});
}
execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ar', '48000', '-ac', '1', '-y', `${output}/mix.wav`], {stdio: 'pipe'});
const report = {
  file, totalFrames: TOTAL, durationSeconds: TOTAL / FPS, dimensions: [video.width, video.height],
  codec: video.codec_name, audioCodec: audio.codec_name, audioSampleRate: audio.sample_rate,
  decode: 'Entire video and audio decoded without errors',
  levels,
  frames, shots: SHOTS,
};
writeFileSync(`${output}/technical.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
